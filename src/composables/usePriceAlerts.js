import { ref, watch } from "vue";
import { getToday, isTradingHours, pruneHistory } from "../utils/marketTime.js";
import { sendAlertNotification } from "../utils/notify.js";
import { fetchDayKlineCached } from "../utils/klineCache.js";

/**
 * 自定义价格/条件提醒系统
 *
 * 功能：
 * - 为任意股票（不限于自选）配置目标价位提醒：突破（现价上穿目标价）或跌破（现价下穿目标价）
 * - 可选"放量"条件：价格条件满足时，当日成交量 ≥ N 倍 5 日均量才触发
 * - 触发模式：一次性（触发后自动暂停）/ 每日（每个交易日最多一次）
 * - 穿越检测基于上一轮价格快照（首轮仅记录基准），跨日自动重置，防隔夜跳空误报
 * - 仅交易时段检测，发送 Windows 原生通知；日 K 走共享缓存（utils/klineCache）
 *
 * 配置存储：localStorage "stock-analysis-price-alerts"
 *   [{ id, code, name, direction: "above"|"below", price,
 *      volumeCondition: bool, volumeMultiple, mode: "once"|"daily",
 *      enabled, createdAt, triggeredAt }]
 * 通知历史：localStorage "stock-analysis-price-alert-history"
 *   { "2026-07-22": { [alertId]: true } }（只保留 7 天）
 *
 * 注意：本 composable 为**单例**。行情检查器（App.vue）与配置弹窗/详情页必须共享同一份
 * 状态，否则弹窗里新增/修改的提醒无法被检查器看到（重启前不生效），且配置弹窗的
 * 快照回写还会覆盖掉本会话的新增内容。
 */

const STORAGE_KEY = "stock-analysis-price-alerts";
const HISTORY_KEY = "stock-analysis-price-alert-history";

/** 生成提醒 ID */
function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 加载提醒列表 */
function loadAlerts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** 加载通知历史 { date: { [alertId]: true } }，只保留最近 7 天 */
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

export function usePriceAlerts() {
  if (_instance) return _instance;

  /** 提醒列表 [{ id, code, name, direction, price, ... }] */
  const alerts = ref(loadAlerts());
  /** 通知历史 { date: { [alertId]: true } } */
  const history = ref(loadHistory());
  /** 价格快照（穿越检测基准，首轮仅记录） */
  const baselines = ref({});

  // 上次检查日期：跨日时清空价格基准，防止隔夜跳空被误判为穿越
  let lastCheckDate = getToday();

  // 配置自动持久化
  watch(alerts, (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
    } catch { /* ignore */ }
  }, { deep: true });

  /** 某股票的全部提醒（新→旧排序） */
  function alertsForCode(code) {
    return alerts.value
      .filter((a) => a.code === code)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 某股票启用中的提醒数量（详情页按钮徽标用） */
  function countEnabledForCode(code) {
    return alerts.value.filter((a) => a.code === code && a.enabled).length;
  }

  /**
   * 新增提醒
   * @param {Object} input { code, name, direction, price, volumeCondition, volumeMultiple, mode }
   * @returns {Object|null} 创建的提醒；参数非法返回 null
   */
  function addAlert(input) {
    const price = Number(input.price);
    if (!input?.code || !price || price <= 0 || Number.isNaN(price)) return null;
    const alert = {
      id: genId(),
      code: String(input.code),
      name: input.name || String(input.code),
      direction: input.direction === "below" ? "below" : "above",
      price,
      volumeCondition: !!input.volumeCondition,
      volumeMultiple: Math.max(1, Number(input.volumeMultiple) || 2),
      mode: input.mode === "daily" ? "daily" : "once",
      enabled: true,
      createdAt: Date.now(),
      triggeredAt: null,
    };
    alerts.value = [...alerts.value, alert];
    return alert;
  }

  /** 局部更新某提醒（替换整个对象，保证响应式） */
  function updateAlert(id, patch) {
    alerts.value = alerts.value.map((a) => (a.id === id ? { ...a, ...patch } : a));
  }

  /** 删除提醒（连带清理价格基准与今日历史） */
  function removeAlert(id) {
    alerts.value = alerts.value.filter((a) => a.id !== id);
    delete baselines.value[id];
    const t = getToday();
    if (history.value[t]?.[id]) {
      const { [id]: _drop, ...rest } = history.value[t];
      history.value = { ...history.value, [t]: rest };
      saveHistory();
    }
  }

  /** 重新启用（一次性提醒触发后恢复监控）：重置触发状态、价格基准与今日历史 */
  function rearmAlert(id) {
    updateAlert(id, { enabled: true, triggeredAt: null });
    delete baselines.value[id];
    const t = getToday();
    if (history.value[t]?.[id]) {
      const { [id]: _drop, ...rest } = history.value[t];
      history.value = { ...history.value, [t]: rest };
      saveHistory();
    }
  }

  /** 暂停提醒 */
  function pauseAlert(id) {
    updateAlert(id, { enabled: false });
  }

  function saveHistory() {
    // 裁剪过期记录（与 loadHistory 的 7 天规则一致）
    history.value = pruneHistory(history.value);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value));
    } catch { /* ignore */ }
  }

  /** 某提醒今日是否已触发过 */
  function hasTriggeredToday(id) {
    return history.value[getToday()]?.[id] === true;
  }

  /** 标记今日已触发 */
  function markTriggeredToday(id) {
    const t = getToday();
    history.value = pruneHistory({
      ...history.value,
      [t]: { ...(history.value[t] || {}), [id]: true },
    });
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value));
    } catch { /* ignore */ }
  }

  /**
   * 当日成交量相对前 5 日均量的倍数。
   * 要求日 K 最后一根是今天的柱子（盘中包含当日数据），否则返回 null（无法计算）。
   * 注意：早盘时段累计成交量天然偏低，倍数可能难以达标。
   */
  async function volumeRatio(code) {
    const kline = await fetchDayKlineCached(code);
    if (!kline || kline.length < 7) return null;
    const vols = kline.map((k) => k.volume);
    const last = kline[kline.length - 1];
    if (last.date !== getToday()) return null;
    const todayVol = vols[vols.length - 1];
    const avg = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
    if (avg <= 0 || todayVol <= 0) return null;
    return todayVol / avg;
  }

  /**
   * 检查单只股票的价格/条件提醒，触发时发送 Windows 通知。
   * 应在每次行情刷新后调用（内部使用日 K 缓存，不会高频请求 K 线）。
   *
   * @param {Object} quote - StockQuote 数据 { code, name, price }
   * @param {Object} s - 设置对象 (useSettings().state)，全局通知关闭时不检测
   */
  async function checkPriceAlerts(quote, s) {
    if (!quote?.code) return;
    if (!s?.notifyEnabled) return;
    if (s.priceAlertsEnabled === false) return;

    const list = alerts.value.filter((a) => a.code === quote.code && a.enabled);
    if (list.length === 0) return;

    // 跨日重置价格基准：次日开盘首次检测用当日价格重新建立基准，
    // 否则昨日收盘 vs 今日开盘的隔夜跳空会被误判为"突破/跌破"
    const today = getToday();
    if (lastCheckDate !== today) {
      lastCheckDate = today;
      baselines.value = {};
    }

    // 非交易时段不通知
    if (!isTradingHours(quote.code)) return;

    const { code, name, price } = quote;

    // ── 穿越检测：突破 = 上轮 ≤ 目标 < 现价；跌破 = 上轮 ≥ 目标 > 现价 ──
    const triggered = [];
    const volRatios = new Map();
    for (const alert of list) {
      const prev = baselines.value[alert.id];
      baselines.value = { ...baselines.value, [alert.id]: price };
      if (prev == null || prev <= 0) continue; // 首轮只记录基准，不判定

      let crossed = false;
      if (alert.direction === "above") {
        crossed = prev < alert.price && price >= alert.price;
      } else {
        crossed = prev > alert.price && price <= alert.price;
      }
      if (!crossed) continue;

      // 放量条件：当日量 ≥ N 倍 5 日均量（无法计算时视为不满足）
      if (alert.volumeCondition) {
        const ratio = await volumeRatio(code);
        if (ratio == null || ratio < alert.volumeMultiple) continue;
        volRatios.set(alert.id, ratio);
      }

      // 每日模式去重（一次性模式触发后即暂停，天然不重复）
      if (hasTriggeredToday(alert.id)) continue;

      triggered.push(alert);
    }
    if (triggered.length === 0) return;

    // ── 发送通知 ──
    for (const alert of triggered) {
      const dirLabel = alert.direction === "above" ? "突破" : "跌破";
      const emoji = alert.direction === "above" ? "🔔" : "📉";
      let body = `现价 ${price.toFixed(2)} 已${dirLabel}目标价 ${alert.price.toFixed(2)}`;
      const ratio = volRatios.get(alert.id);
      if (alert.volumeCondition && ratio != null) {
        body += `（放量 ${ratio.toFixed(1)}× 5日均量）`;
      }
      const sent = await sendAlertNotification(
        `${emoji} ${dirLabel}提醒: ${alert.name} (${code})`,
        body,
        { code, kind: "price", price, target: alert.price }
      );
      // 权限被拒时中止后续发送
      if (!sent) return;

      markTriggeredToday(alert.id);
      if (alert.mode === "once") {
        // 一次性：触发后自动暂停，等待用户重新启用
        updateAlert(alert.id, { enabled: false, triggeredAt: Date.now() });
      } else {
        updateAlert(alert.id, { triggeredAt: Date.now() });
      }

      // 多条通知之间间隔 300ms，避免 Windows 通知系统节流合并
      if (triggered.length > 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  _instance = {
    alerts,
    alertsForCode,
    countEnabledForCode,
    addAlert,
    updateAlert,
    removeAlert,
    rearmAlert,
    pauseAlert,
    checkPriceAlerts,
  };
  return _instance;
}
