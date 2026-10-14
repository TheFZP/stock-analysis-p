import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getToday, setAShareTradingDays } from "../utils/marketTime.js";

/**
 * A 股交易日历（同花顺 Fuyao API）
 *
 * 目的：把 marketTime.js 里"周一至周五"的硬编码时段判断，升级为真实交易日历，
 *       识别法定节假日 / 调休，避免休市日的无效轮询与错误的时段判定。
 *
 * 接口：GET /api/a-share/calendar/trading-days（无参数，固定返回 [今日-1年, 今日]）
 *   → 返回值只对"拉取当日及之前"有效，因此必须跨日刷新（应用常驻托盘可能连续运行数天）。
 *
 * 降级策略：未配置 Key / 请求失败 → 保留旧日历 or 不注入，marketTime 自动退回周末判断，
 *           通知与轮询功能不中断（仅等价于改造前的行为）。
 *
 * 存储：
 * - localStorage "stock-analysis-fuyao-api-key"  API Key（与 AI Key 同为本地明文存储）
 * - localStorage "stock-analysis-trading-calendar" { fetchedOn, days } 日历缓存
 */

const API_KEY_KEY = "stock-analysis-fuyao-api-key";
const CACHE_KEY = "stock-analysis-trading-calendar";

/** 跨日检查间隔：仅比较日期字符串，日期未变不发请求；日期变化才重新拉取 */
const ROLLOVER_CHECK_MS = 10 * 60 * 1000;

/** 单例实例 */
let _instance = null;

/** 读取 API Key */
function loadKey() {
  try {
    return localStorage.getItem(API_KEY_KEY) || "";
  } catch {
    return "";
  }
}

/** 读取日历缓存 { fetchedOn, days }（离线可用：历史日期仍权威，今日超范围则视为未知） */
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { fetchedOn, days } = JSON.parse(raw);
    if (typeof fetchedOn === "string" && Array.isArray(days) && days.length > 0) {
      return { fetchedOn, days };
    }
  } catch { /* 缓存损坏忽略 */ }
  return null;
}

/**
 * 交易日历单例 composable
 * @returns {{ apiKey, loaded, loading, error, setApiKey, refresh, init }}
 */
export function useTradingCalendar() {
  if (_instance) return _instance;

  const apiKey = ref(loadKey());
  const loaded = ref(false);     // 是否已成功注入日历（含缓存）
  const loading = ref(false);
  const error = ref("");
  /** 当前生效日历的覆盖截止日（"yyyy-MM-dd"），空串 = 无有效日历 */
  let loadedThrough = "";
  let timer = null;

  /** 注入日历到 marketTime */
  function apply(days, through) {
    if (!Array.isArray(days) || days.length === 0) return false;
    setAShareTradingDays(days, through);
    loadedThrough = through;
    loaded.value = true;
    return true;
  }

  /** 拉取并缓存日历；失败时保留旧日历（不清空，避免降级为周末判断） */
  async function refresh() {
    if (!apiKey.value) {
      error.value = "未配置同花顺 API Key";
      return false;
    }
    loading.value = true;
    error.value = "";
    try {
      const days = await invoke("get_trading_calendar", { apiKey: apiKey.value });
      const through = getToday();
      if (!apply(days, through)) throw new Error("交易日历返回空数据");
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedOn: through, days }));
      } catch { /* 存储不可用时不影响本次会话 */ }
      return true;
    } catch (e) {
      error.value = String(e);
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 保存 API Key（空值 = 清除） */
  function setApiKey(key) {
    apiKey.value = (key || "").trim();
    try {
      if (apiKey.value) localStorage.setItem(API_KEY_KEY, apiKey.value);
      else localStorage.removeItem(API_KEY_KEY);
    } catch { /* 存储不可用时仅本次会话生效 */ }
  }

  /**
   * 跨日自动刷新（轻量：每 10 分钟比较一次日期字符串）
   * 定时器不做清理：本 composable 是应用级单例（常驻托盘），定时器随应用生命周期存在；
   * `if (timer)` 保证重复调用不会创建多个。
   */
  function startRolloverWatch() {
    if (timer) return;
    timer = setInterval(() => {
      if (!apiKey.value) return;
      if (getToday() !== loadedThrough) refresh();
    }, ROLLOVER_CHECK_MS);
  }

  /** 主窗口启动时调用：先用缓存判定，同日重启不重复请求，随后启动跨日监听 */
  function init() {
    const cache = loadCache();
    if (cache) apply(cache.days, cache.fetchedOn);
    if (apiKey.value && cache?.fetchedOn !== getToday()) refresh();
    startRolloverWatch();
  }

  _instance = { apiKey, loaded, loading, error, setApiKey, refresh, init };
  return _instance;
}
