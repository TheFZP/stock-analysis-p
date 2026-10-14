import { ref, watch } from "vue";
import { getToday, isTradingHours, pruneHistory } from "../utils/marketTime.js";
import { sendAlertNotification } from "../utils/notify.js";
import { fetchDayKlineCached, clearKlineCache } from "../utils/klineCache.js";

/**
 * 个股均线提醒系统
 *
 * 功能：
 * - 每只股票独立配置监控周期（5/10/20/30/60 日）与触发方向（上穿/下穿/双向）
 * - 股价穿越均线时发送 Windows 原生通知（仅交易时段）
 * - 每股票每周期每日只通知一次（按本地日期去重）
 * - 日 K 线走共享 5 分钟缓存（utils/klineCache），避免 30s 行情刷新触发高频 K 线请求
 *
 * 配置存储：localStorage "stock-analysis-ma-alerts"
 *   { "300750": { periods: [5, 10], direction: "both" } }
 *
 * 注意：本 composable 为**单例**。行情检查器（App.vue）与配置弹窗/详情页必须共享同一份
 * 状态，否则弹窗里新增/修改的配置无法被检查器看到（重启前不生效），且启动快照回写
 * 还会覆盖掉本会话的新增内容。
 */

const STORAGE_KEY = "stock-analysis-ma-alerts";
const HISTORY_KEY = "stock-analysis-ma-notif-history";

/** 可监控的均线周期 */
export const MA_PERIODS = [5, 10, 20, 30, 60];

/** 加载均线提醒配置 { code: { periods, direction } } */
function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** 加载通知历史 { date: { code: ["ma5_up"] } }，只保留最近 7 天 */
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? pruneHistory(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** 单例实例（与配置弹窗共享，见文件头注释） */
let _instance = null;

export function useMaAlerts() {
  if (_instance) return _instance;

  /** 配置 { code: { periods: [5,10], direction: "both"|"cross_up"|"cross_down" } } */
  const configs = ref(loadConfig());
  /** 通知历史 */
  const history = ref(loadHistory());
  /** 上一轮价格快照（穿越检测基准，首轮仅记录） */
  const lastPrices = ref({});

  // 上次检查日期：跨日时清空价格基准，防止隔夜跳空被误判为均线穿越
  let lastCheckDate = getToday();

  // 配置自动持久化
  watch(configs, (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
    } catch { /* ignore */ }
  }, { deep: true });

  /** 获取某股票的提醒配置（未配置返回 null） */
  function getConfig(code) {
    return configs.value[code] || null;
  }

  /** 切换某股票某均线周期的启用状态；取消最后一个周期时自动删除配置 */
  function togglePeriod(code, period) {
    const cfg = configs.value[code] || { periods: [], direction: "both" };
    const has = cfg.periods.includes(period);
    const periods = has
      ? cfg.periods.filter((p) => p !== period)
      : [...cfg.periods, period].sort((a, b) => a - b);
    applyConfig(code, { ...cfg, periods });
  }

  /** 设置触发方向（上穿 / 下穿 / 双向） */
  function setDirection(code, direction) {
    const cfg = configs.value[code];
    if (!cfg) return;
    applyConfig(code, { ...cfg, direction });
  }

  /** 删除某股票的全部均线提醒（连带清理价格基准与 K 线缓存，防止无界增长） */
  function removeConfig(code) {
    const { [code]: _removed, ...rest } = configs.value;
    configs.value = rest;
    delete lastPrices.value[code];
    clearKlineCache(code);
  }

  /** 写入配置（无周期时视为删除） */
  function applyConfig(code, cfg) {
    if (!cfg.periods || cfg.periods.length === 0) {
      removeConfig(code);
    } else {
      configs.value = { ...configs.value, [code]: cfg };
    }
  }

  /** 指定股票+周期+方向今日是否已通知过 */
  function hasTriggeredToday(code, type) {
    return history.value[getToday()]?.[code]?.includes(type) ?? false;
  }

  /** 标记已通知（写入时顺带裁剪 7 天前的记录，避免运行期间 localStorage 持续增长） */
  function markTriggeredToday(code, type) {
    const t = getToday();
    const todayData = history.value[t] || {};
    const triggers = todayData[code] || [];
    if (!triggers.includes(type)) {
      history.value = pruneHistory({
        ...history.value,
        [t]: { ...todayData, [code]: [...triggers, type] },
      });
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value));
      } catch { /* ignore */ }
    }
  }

  /**
   * 检查单只股票的均线穿越，触发时发送 Windows 通知。
   * 应在每次行情刷新后调用（内部使用日 K 缓存，不会高频请求 K 线）。
   *
   * @param {Object} quote - StockQuote 数据 { code, name, price }
   * @param {Object} s - 设置对象 (useSettings().state)，全局通知关闭时不检测
   */
  async function checkMaAlerts(quote, s) {
    if (!quote?.code) return;
    if (!s?.notifyEnabled) return;
    const cfg = configs.value[quote.code];
    if (!cfg?.periods?.length) return;

    // 跨日重置价格基准：次日开盘首次检测用当日价格重新建立基准，
    // 否则昨日收盘价 vs 今日开盘价的隔夜跳空会被误判为均线穿越
    const today = getToday();
    if (lastCheckDate !== today) {
      lastCheckDate = today;
      lastPrices.value = {};
    }

    // 非交易时段不通知
    if (!isTradingHours(quote.code)) return;

    const kline = await fetchDayKlineCached(quote.code);
    if (!kline || kline.length < 5) return;
    const closes = kline.map((k) => k.close);

    const { code, name, price } = quote;
    // 首轮只记录价格基准，从第二轮起检测穿越
    const prev = lastPrices.value[code];
    lastPrices.value = { ...lastPrices.value, [code]: price };
    if (prev == null || prev <= 0) return;

    // ── 穿越检测：上穿（prev ≤ MA < price）/ 下穿（prev ≥ MA > price）──
    const triggered = [];
    for (const p of cfg.periods) {
      if (closes.length < p) continue;
      const ma = closes.slice(-p).reduce((a, b) => a + b, 0) / p;
      if (ma <= 0) continue;
      if (cfg.direction !== "cross_down" && prev <= ma && price > ma) {
        triggered.push({ period: p, dir: "up", ma });
      } else if (cfg.direction !== "cross_up" && prev >= ma && price < ma) {
        triggered.push({ period: p, dir: "down", ma });
      }
    }
    if (triggered.length === 0) return;

    // ── 过滤今日已通知项 ──
    const fresh = triggered.filter(
      (t) => !hasTriggeredToday(code, `ma${t.period}_${t.dir}`)
    );
    if (fresh.length === 0) return;

    // ── 发送通知（await 每条，防止 Windows Toast 排队延迟）──
    for (const t of fresh) {
      const dirLabel = t.dir === "up" ? "上穿" : "下穿";
      const emoji = t.dir === "up" ? "📈" : "📉";
      const sent = await sendAlertNotification(
        `${emoji} ${dirLabel} MA${t.period}: ${name} (${code})`,
        `现价 ${price.toFixed(2)} 已${dirLabel} MA${t.period}(${t.ma.toFixed(2)})`,
        { code, kind: `ma${t.period}_${t.dir}`, price, target: t.ma }
      );
      // 权限被拒时中止后续发送
      if (!sent) return;
      markTriggeredToday(code, `ma${t.period}_${t.dir}`);
      // 多条通知之间间隔 300ms，避免 Windows 通知系统节流合并
      if (fresh.length > 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  _instance = {
    configs,
    getConfig,
    togglePeriod,
    setDirection,
    removeConfig,
    checkMaAlerts,
  };
  return _instance;
}
