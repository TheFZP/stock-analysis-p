import { ref } from "vue";
import { getToday, isTradingHours, pruneHistory } from "../utils/marketTime.js";
import { sendAlertNotification } from "../utils/notify.js";

const STORAGE_KEY = "stock-analysis-notif-history";

/** 从 localStorage 加载通知历史（只保留最近 7 天） */
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return pruneHistory(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** 保存通知历史到 localStorage */
function saveHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* ignore quota errors */
  }
}

import { getLimitThreshold } from "../utils/limit";

/** 触发类型 → 通知文案 */
const TRIGGER_LABELS = {
  limit_up: "🚀 涨停",
  limit_down: "📉 跌停",
  "+7%": "📈 涨超 7%",
  "+5%": "📈 涨超 5%",
  "-7%": "📉 跌超 7%",
  "-5%": "📉 跌超 5%",
  fast_rise: "⚡ 快速拉升",
  fast_fall: "💥 快速下跌",
};

/**
 * 自选列表通知系统
 *
 * 功能：
 * - 涨停/跌停、±7%、±5% 阈值触发通知
 * - 快速拉升/快速下跌（30s 内价格变动 ≥2%）触发通知
 * - 每个触发类型每天每只股票只通知一次
 * - 使用 Windows 原生通知 (tauri-plugin-notification)
 */
export function useWatchlistNotifications() {
  // 上一轮价格记录，用于检测快速拉升/下跌
  const prevPrices = ref({});

  // 上次检查的日期：跨日时清空价格快照。
  // 否则隔夜跳空会被当作"30s 内快速变动"在次日开盘瞬间误报快速拉升/下跌
  let lastCheckDate = getToday();

  // 通知历史 { "2026-07-22": { "000001": ["limit_up", "+5%"] } }
  const history = ref(loadHistory());

  // 确保今日记录存在
  if (!history.value[getToday()]) {
    history.value = { ...history.value, [getToday()]: {} };
  }

  // defaults for when settings aren't provided yet
  const defaultSettings = {
    notifyEnabled: true,
    notifyUp5: true, notifyUp7: true, notifyLimitUp: true,
    notifyDown5: true, notifyDown7: true, notifyLimitDown: true,
    notifyFastRise: true, notifyFastFall: true,
    notifyFastThreshold: 2,
  };

  /** 指定股票+触发类型今天是否已通知过 */
  function hasTriggeredToday(code, type) {
    return history.value[getToday()]?.[code]?.includes(type) ?? false;
  }

  /** 标记为已触发（写入时顺带裁剪 7 天前的记录） */
  function markTriggeredToday(code, type) {
    const t = getToday();
    const todayData = history.value[t] || {};
    const triggers = todayData[code] || [];
    if (!triggers.includes(type)) {
      history.value = pruneHistory({
        ...history.value,
        [t]: { ...todayData, [code]: [...triggers, type] },
      });
      saveHistory(history.value);
    }
  }

  /**
   * 检查单只股票的行情数据，按阈值触发通知。
   * 应在每次行情刷新后调用（当前每 30s 刷新一次）。
   *
   * @param {Object} quote - StockQuote 数据 { code, name, price, changePct, prevClose }
   * @param {Object} s - 设置对象 (useSettings().state)
   */
  async function checkAndNotify(quote, s) {
    if (!quote || !quote.code) return;

    // 跨日重置价格快照：隔夜跳空不能算"快速拉升/下跌"
    const today = getToday();
    if (lastCheckDate !== today) {
      lastCheckDate = today;
      prevPrices.value = {};
    }

    // 非交易时段不通知（港股与 A 股时段不同，按代码区分）
    if (!isTradingHours(quote.code)) return;

    const settings = s || defaultSettings;
    if (!settings.notifyEnabled) return;

    const { code, name, price, changePct, prevClose } = quote;
    const limit = getLimitThreshold(code);
    const triggeredTypes = [];

    // ── 静态阈值检测 ──
    // 涨跌停仅限有涨跌停限制的市场（A 股/北交所；港股 limit=0 无涨跌停）
    if (limit > 0) {
      if (settings.notifyLimitUp && changePct >= limit) {
        triggeredTypes.push("limit_up");
      }
      if (settings.notifyLimitDown && changePct <= -limit) {
        triggeredTypes.push("limit_down");
      }
    }
    // ±5%/±7% 对港股同样适用（港股虽无涨跌停，但日常波动监控仍需这些阈值；
    // 原实现把 ±5%/±7% 也包在 limit>0 内，港股被整体跳过）
    if (settings.notifyUp7 && changePct >= 7) {
      triggeredTypes.push("+7%");
    } else if (settings.notifyUp5 && changePct >= 5) {
      triggeredTypes.push("+5%");
    }
    if (settings.notifyDown7 && changePct <= -7) {
      triggeredTypes.push("-7%");
    } else if (settings.notifyDown5 && changePct <= -5) {
      triggeredTypes.push("-5%");
    }

    // ── 快速拉升 / 快速下跌检测 ──
    const prevPrice = prevPrices.value[code];
    if (prevPrice && prevPrice > 0 && prevClose > 0) {
      const threshold = settings.notifyFastThreshold ?? 2;
      const rapidPct = ((price - prevPrice) / prevClose) * 100;
      if (settings.notifyFastRise && rapidPct >= threshold) {
        triggeredTypes.push("fast_rise");
      } else if (settings.notifyFastFall && rapidPct <= -threshold) {
        triggeredTypes.push("fast_fall");
      }
    }
    // 更新价格快照
    prevPrices.value = { ...prevPrices.value, [code]: price };

    // ── 过滤已触发项 ──
    const newTriggers = triggeredTypes.filter(
      (t) => !hasTriggeredToday(code, t)
    );
    if (newTriggers.length === 0) return;

    // ── 发送通知（await 每条，防止 Windows Toast 排队延迟）──
    for (const trigger of newTriggers) {
      const label = TRIGGER_LABELS[trigger] || trigger;
      const sign = changePct > 0 ? "+" : "";

      const sent = await sendAlertNotification(
        `${label}: ${name} (${code})`,
        `当前价 ${price.toFixed(2)}  涨跌幅 ${sign}${changePct.toFixed(2)}%`,
        { code, kind: `watchlist_${trigger}`, price }
      );
      // 权限被拒时中止后续发送（避免每条都请求权限）
      if (!sent) return;

      markTriggeredToday(code, trigger);

      // 多条通知之间间隔 300ms，避免 Windows 通知系统节流合并
      if (newTriggers.length > 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  return { checkAndNotify, prevPrices };
}
