/**
 * K 线周期口径的单一真源。
 *
 * klinePeriod 的全部取值来自 KlineChart 的周期按钮：m5 / m15 / m30 / m60 / day / week / month。
 * klineData 是全应用共享且可切换周期的序列，任何「按日K解读」的下游（K线图标题、
 * 技术分析弹窗、筹码分布、AI 提示词、T+0 信号）都必须从这里取口径文案，
 * 禁止硬编码「日K / 5 日均线」。
 */

const PERIOD_META = {
  m5: { label: "5分钟K", bar: "5 分钟", maDesc: "MA5 为 5 根 5 分钟 K 线的均值", hl: "根" },
  m15: { label: "15分钟K", bar: "15 分钟", maDesc: "MA5 为 5 根 15 分钟 K 线的均值", hl: "根" },
  m30: { label: "30分钟K", bar: "30 分钟", maDesc: "MA5 为 5 根 30 分钟 K 线的均值", hl: "根" },
  m60: { label: "60分钟K", bar: "60 分钟", maDesc: "MA5 为 5 根 60 分钟 K 线的均值", hl: "根" },
  day: { label: "日K", bar: "1 个交易日", maDesc: "MA5 为 5 个交易日均线", hl: "日" },
  week: { label: "周K", bar: "1 周", maDesc: "MA5 为 5 周均线", hl: "周" },
  month: { label: "月K", bar: "1 个月", maDesc: "MA5 为 5 个月均线", hl: "月" },
};

export const DEFAULT_KLINE_PERIOD = "day";

/**
 * 周期元信息
 * @param {string} period - m5/m15/m30/m60/day/week/month（未知值回退日K）
 */
export function getPeriodMeta(period) {
  return PERIOD_META[period] || PERIOD_META[DEFAULT_KLINE_PERIOD];
}

/** 是否为日K口径（只有日K才能冠以「日线」结论） */
export function isDayPeriod(period) {
  return (period || DEFAULT_KLINE_PERIOD) === DEFAULT_KLINE_PERIOD;
}

/** 周期名，如「周K」 */
export function periodLabel(period) {
  return getPeriodMeta(period).label;
}

/** 周期提示行：明确 MA 与指标不是日线口径（日K 无需提示，返回 null） */
export function periodNotice(period) {
  if (isDayPeriod(period)) return null;
  const meta = getPeriodMeta(period);
  return `当前为${meta.label}（每根 K 线 = ${meta.bar}）：${meta.maDesc}，均线与技术指标均按${meta.label}口径计算，不是 5 日均线`;
}
