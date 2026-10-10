/**
 * 系统托盘 tooltip 摘要（持仓快照）
 *
 * 预算：Windows 托盘 tooltip 是 NOTIFYICONDATA.szTip（WCHAR[128]，安全上限 127 个
 * UTF-16 code unit；tray-icon 在内容 ≥127 unit 时会挤掉结尾 NUL），且 Win11 24H2
 * 实测约 64 字符即截断 → 取 60 保守值。预算与 `src-tauri/src/tray_tooltip.rs` 对应。
 *
 * 取数：复用 usePositions 已算好的汇总 computed，在持仓/行情变化时推送；
 * 鼠标悬浮（Enter）不做任何实时拉取——文本在推送时就已写进 szTip，悬浮瞬时显示。
 *
 * 仅主窗口参与：`?mini=1` / `?iwencai=1` 加载同一份 App.vue，其持仓是 localStorage
 * 快照且永不刷新（盈亏恒为 0），必须由调用方用 enabled 挡掉；后端还有第二道守卫。
 */
import { computed, onScopeDispose, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { usePositions } from "./usePositions";
import { fmtPct, signChar } from "../utils/format";

/** 无持仓时沿用托盘原始文案 */
const DEFAULT_TOOLTIP = "stock-analysis";
/** 文本预算（UTF-16 code unit），详见文件头 */
const MAX_UNITS = 60;
const HEAD_SEP = " | ";
const ITEM_SEP = " ";
/** 合并「新增持仓 → loadQuote → merge」这一簇变更，避免连续推送 */
const PUSH_DEBOUNCE_MS = 300;

/**
 * 金额格式化（入参单位：元）
 *
 * 不要复用 `utils/format.js` 的 `fmtMoney` —— 那个函数的入参单位是「万」
 * （`v / 10000 + "亿"`），传以元计的市值会得到 "12.84亿" 这种错误结果。
 */
function fmtWan(v) {
  if (!Number.isFinite(v)) return "--";
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return Math.round(v) + "元";
}

/**
 * 按 UTF-16 code unit 截断
 *
 * `for...of` 按码点迭代，所以不会把非 BMP 字符（如生僻扩展 B 汉字）劈成孤立代理项。
 */
function truncateUnits(text, max = MAX_UNITS) {
  if (text.length <= max) return text;
  const budget = max - 1; // 给省略号预留 1 个 unit
  let out = "";
  let used = 0;
  for (const ch of text) {
    if (used + ch.length > budget) break;
    used += ch.length;
    out += ch;
  }
  return out + "…";
}

/** 头部恒完整、只截尾部个股明细；两遍填充保证结果不超预算 */
function assemble(head, items) {
  const build = (budget) => {
    let out = head;
    for (const item of items) {
      const next = out === head ? head + HEAD_SEP + item : out + ITEM_SEP + item;
      if (next.length > budget) return { out, complete: false };
      out = next;
    }
    return { out, complete: true };
  };

  const full = build(MAX_UNITS);
  if (full.complete) return full.out; // 全塞得下 → 不加省略号

  const partial = build(MAX_UNITS - 1); // 预留 1 unit 给 "…"
  if (partial.out === head) return truncateUnits(head + HEAD_SEP + items[0]);
  return partial.out + "…";
}

/** 拼装单行摘要；无持仓返回默认文案 */
function buildTooltipText(list, totalMarketValue, totalProfitPct) {
  if (!list.length) return DEFAULT_TOOLTIP;

  const head = `持仓${list.length}只 市值${fmtWan(totalMarketValue)} ${fmtPct(totalProfitPct)}`;

  // 只列有实时价的持仓：无行情/停牌时 positionStats 会退回成本价、profitPct 恒为 0，
  // 直接列出来会显示成误导性的 "某某+0.0"。数量仍按全量。
  const items = list
    .filter((p) => Number(p.price) > 0)
    .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0)) // 市值降序：大仓优先露出
    .map((p) => `${p.name || p.code}${signChar(p.profitPct)}${p.profitPct.toFixed(1)}`);

  if (!items.length) return truncateUnits(head);
  return assemble(head, items);
}

/** 单例标记：重复调用不重复注册 watcher */
let _started = false;

/**
 * 启动托盘 tooltip 推送
 *
 * @param {{ enabled?: boolean }} options `enabled: false` 时不注册（给 mini/iwencai 窗口用）
 */
export function useTrayTooltip({ enabled = true } = {}) {
  if (!enabled || _started) return;
  _started = true;

  const { positionStats, totalMarketValueCNY, totalProfitPctCNY } = usePositions();

  const tooltipText = computed(() =>
    buildTooltipText(positionStats.value, totalMarketValueCNY.value, totalProfitPctCNY.value)
  );

  let timer = null;
  let sent = null; // 最近一次成功推送的文本

  async function push() {
    timer = null;
    const text = tooltipText.value;
    if (text === sent) return;
    try {
      await invoke("update_tray_tooltip", { text });
      sent = text; // 只在成功后记录：失败时留给下一次文本变化重试
    } catch { /* 托盘不可用等静默忽略，不能影响主流程 */ }
  }

  // 监听 computed 字符串：值不变则 Object.is 相同、不会触发回调（天然去重），无需 deep
  watch(
    tooltipText,
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, PUSH_DEBOUNCE_MS);
    },
    { immediate: true }
  );

  onScopeDispose(() => {
    if (timer) clearTimeout(timer);
  });
}
