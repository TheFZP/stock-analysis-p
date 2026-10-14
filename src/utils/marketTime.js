/**
 * 市场时间工具 — 交易日历/时段判断（自选通知、均线提醒、价格提醒、状态胶囊共用）
 */
import { isHKHoliday, getHKHolidayName } from "./hkHolidays.js";

/**
 * A 股交易日历（由 composables/useTradingCalendar.js 拉取后注入）
 * - null 表示未加载
 * - Set 内元素为 "yyyy-MM-dd"
 * - 日历仅覆盖 A 股，且只对 aShareCalendarThrough（拉取当日）及之前有效
 *   （接口窗口为 [今日-1年, 今日]，超出右端即为未知）
 */
let aShareTradingDays = null;
let aShareCalendarThrough = "";

/** 注入 A 股交易日历（dates: "yyyy-MM-dd" 数组；through: 该日历的覆盖截止日） */
export function setAShareTradingDays(dates, through) {
  aShareTradingDays = new Set(dates || []);
  aShareCalendarThrough = through || "";
}

/**
 * 判断指定日期是否为 A 股交易日（仅本文件内使用）
 * @param {string} dateStr "yyyy-MM-dd"
 * @returns {boolean|null} null = 未知（日历未加载 / 超出日历覆盖范围）
 */
function isAShareTradingDay(dateStr) {
  if (!aShareTradingDays) return null;
  if (dateStr > aShareCalendarThrough) return null;
  return aShareTradingDays.has(dateStr);
}

/** 各市场交易时段（分钟数，含两端边界）：[上午开, 上午收] / [下午开, 下午收] */
const SESSIONS = {
  A: { morning: [570, 690], afternoon: [780, 900] }, // 09:30-11:30 / 13:00-15:00
  HK: { morning: [570, 720], afternoon: [780, 960] }, // 09:30-12:00 / 13:00-16:00
};

/**
 * 日期 → YYYY-MM-DD（本地时区）
 * 统一走本地时区：toISOString() 走 UTC，在东八区会导致 08:00 之前算出的日期比实际早一天。
 */
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 今日日期字符串 YYYY-MM-DD（本地时区，避免 UTC 导致跨日重复通知） */
export function getToday() {
  return toDateStr(new Date());
}

/** 分钟数 → "HH:mm" */
function formatMinute(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * 市场状态（交易时段判断 + 「今日市场状态」胶囊共用，单一真源）
 * 交易日判定：
 *   A 股 — 优先用已注入的交易日历（识别法定节假日/调休）；日历未加载或超出覆盖范围时
 *          退回「周一至周五」（dayUnknown = true）
 *   港股 — 静态公众假期表（utils/hkHolidays.js）；未收录年份退回「周一至周五」（dayUnknown = true）
 *   周末一律休市（不查表）
 * 注：港股收市竞价时段不单独处理，仍算作「已收盘」。
 *
 * @param {string} [code] 股票代码（5 位数字 = 港股），不传按 A 股
 * @param {Date} [at] 基准时刻，默认当前（便于测试/回放）
 * @returns {{ market: "A"|"HK", dateStr: string, isTradingDay: boolean, dayUnknown: boolean,
 *             holidayName: string, state: "pre"|"open"|"break"|"post"|"holiday",
 *             minutesToClose: number|null, openAt: string, morningEndAt: string,
 *             resumeAt: string, closeAt: string }}
 */
export function getMarketStatus(code, at = new Date()) {
  const market = /^\d{5}$/.test(code || "") ? "HK" : "A";
  const [morningOpen, morningClose] = SESSIONS[market].morning;
  const [afternoonOpen, afternoonClose] = SESSIONS[market].afternoon;

  const dateStr = toDateStr(at);
  const day = at.getDay(); // 0=周日, 6=周六
  const t = at.getHours() * 60 + at.getMinutes();

  let isTradingDay;
  let dayUnknown = false;
  let holidayName = "";

  if (day === 0 || day === 6) {
    isTradingDay = false;
    holidayName = "周末";
  } else if (market === "HK") {
    const holiday = isHKHoliday(dateStr); // null = 该年份未收录
    if (holiday === null) {
      isTradingDay = true;
      dayUnknown = true;
    } else {
      isTradingDay = !holiday;
      if (holiday) holidayName = getHKHolidayName(dateStr) || "公众假期";
    }
  } else {
    const calendarDay = isAShareTradingDay(dateStr); // null = 日历未加载/超出覆盖
    if (calendarDay === null) {
      isTradingDay = true;
      dayUnknown = true;
    } else {
      isTradingDay = calendarDay;
      if (!calendarDay) holidayName = "非交易日";
    }
  }

  let state;
  if (!isTradingDay) state = "holiday";
  else if (t < morningOpen) state = "pre";
  else if (t <= morningClose) state = "open";
  else if (t < afternoonOpen) state = "break";
  else if (t <= afternoonClose) state = "open";
  else state = "post";

  return {
    market,
    dateStr,
    isTradingDay,
    dayUnknown,
    holidayName,
    state,
    // 午休同样显示距收盘倒计时（午休结束即进入下午盘）
    minutesToClose: state === "open" || state === "break" ? afternoonClose - t : null,
    openAt: formatMinute(morningOpen),
    morningEndAt: formatMinute(morningClose),
    resumeAt: formatMinute(afternoonOpen),
    closeAt: formatMinute(afternoonClose),
  };
}

/**
 * 判断当前是否在交易时段内（含午休，与「盘外零请求」的轮询口径一致）
 * @param {string} [code] 股票代码（5 位数字 = 港股），不传按 A 股
 * @param {Date} [at] 基准时刻，默认当前
 * @returns {boolean}
 */
export function isTradingHours(code, at = new Date()) {
  const { state } = getMarketStatus(code, at);
  return state === "open" || state === "break";
}

/**
 * 距今 N 天前的日期字符串 YYYY-MM-DD（用于裁剪历史记录）
 * 必须与 getToday() 一致使用本地时区：toISOString() 走 UTC，
 * 在东八区会导致 08:00 之前算出的日期比 getToday() 早一天，历史记录被提前裁掉。
 */
function daysAgoISO(days) {
  return toDateStr(new Date(Date.now() - days * 86400000));
}

/**
 * 裁剪过期历史记录，仅保留最近 N 天，返回新对象（不修改入参）。
 * 结构约定：{ "YYYY-MM-DD": {...} }，key 为日期字符串，按字典序比较裁剪。
 */
export function pruneHistory(history, days = 7) {
  const cutoff = daysAgoISO(days);
  const cleaned = {};
  for (const [date, val] of Object.entries(history || {})) {
    if (date >= cutoff) cleaned[date] = val;
  }
  return cleaned;
}
