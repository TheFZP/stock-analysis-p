import { isDayPeriod } from "../utils/klinePeriod.js";

/**
 * useChipDistribution — 筹码峰计算 composable
 *
 * 从 K 线数据（OHLCV + volume）计算筹码分布。
 * 算法：将每根 K 线的成交量按三角形分布分配至价格区间，
 * 逐根累积（可叠加换手率衰减）后归一化得出每个价格层级的筹码集中度。
 *
 * 换手率衰减：真实筹码会被后续成交不断置换，老筹码的留存率按
 * 留存系数 = 1 - 衰减系数 × 该根换手率 逐根递减（换手率衰减法）。
 *
 * 返回数据结构：
 * {
 *   distribution: [{ price, ratio }, ...],  // 每个价格层级的筹码比例
 *   peakPrice: number,                        // 筹码峰价格（集中度最高）
 *   peakRatio: number,                        // 峰值集中度
 *   currentPrice: number,                     // 当前价
 *   costLevels: { COST5, COST15, COST50, COST85, COST95 },  // 分位成本
 *   avgCost: number,                          // 平均持仓成本
 *   decayed: boolean,                         // 是否应用了换手率衰减（UI/AI 据此标注口径）
 *   decayTurnoverRate: number|null,           // 衰减所用的最新换手率 %（未衰减时为 null）
 * }
 */

/**
 * 筹码分布统计窗口（K 线根数上限）：日K 约 2 年，周/月/分钟K 下窗口含义不同，
 * 弹窗按当前周期显示实际根数（见 ChipDistribution.vue）
 */
export const CHIP_MAX_BARS = 480;

/**
 * 由行情最新换手率构造筹码分布选项（仅日K口径可用）
 *
 * 换手率是「当日成交量 / 流通股本」的口径，只有日K的最后一根与之一致：
 * 分钟/周/月K 最后一根的量不同口径，直接用来反推流通股本会算错衰减。
 * @param {Object|null} stock - 行情对象（含 turnoverRate，单位 %）
 * @param {string} klinePeriod - 当前 K 线周期
 * @returns {Object} calcChipDistribution 的 options
 */
export function chipOptionsFromQuote(stock, klinePeriod) {
  if (!isDayPeriod(klinePeriod)) return {};
  const turnoverRate = Number(stock?.turnoverRate);
  if (!Number.isFinite(turnoverRate) || turnoverRate <= 0) return {};
  return { turnoverRate };
}

/**
 * 纯函数：从 K 线数据计算筹码分布
 * @param {Array} klineData - K 线数据 [{ date, open, high, low, close, volume }]
 * @param {Object} options
 * @param {number} options.steps - 价格分段数（默认 60）
 * @param {number} options.smoothWindow - 平滑窗口（默认 3）
 * @param {number} options.turnoverRate - 最新一根 K 线（日K）的换手率 %，提供则启用换手率衰减
 * @param {number} options.decayCoefficient - 衰减系数（默认 1，即完全按换手率置换）
 * @returns {Object|null}
 */
export function calcChipDistribution(klineData, options = {}) {
  // steps 防除零/防 NaN：调用方可能传 0/负数/非数字，导致 priceStep=Infinity 传播 NaN
  const stepsRaw = Math.max(1, Math.min(500, Math.floor(Number(options.steps) || 60)));
  const { smoothWindow = 3 } = options;

  if (!klineData || klineData.length < 5) return null;

  // 取最近 N 根 K 线
  const maxBars = Math.min(CHIP_MAX_BARS, klineData.length);
  const data = klineData.slice(-maxBars);

  // ---- 换手率衰减参数 ----
  // 换手率只对「最新一根」已知（行情快照）。用最新一根的量与换手率反推流通股本：
  //   换手率 = 成交量 / 流通股本 → 逐根换手率 TR_i = TR_最新 × (量_i / 量_最新)
  // 该比值在任意量纲下成立（分子分母同量纲自动约去），且当日为未收市的半根 K 线时
  // 同样成立（成交量与换手率同口径）。量_最新 取 0 或换手率无效时退化为不做衰减。
  const turnoverPct = Number(options.turnoverRate);
  // 衰减系数：默认 1（完全按换手率置换）；显式传 0 或非数字时退化为不做衰减
  const coeffRaw = options.decayCoefficient;
  const decayCoefficient = coeffRaw == null ? 1 : Number(coeffRaw);
  const latestVolume = Number(data[data.length - 1]?.volume) || 0;
  const decay =
    Number.isFinite(turnoverPct) &&
    turnoverPct > 0 &&
    latestVolume > 0 &&
    Number.isFinite(decayCoefficient) &&
    decayCoefficient > 0;

  // 找到价格范围
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const k of data) {
    if (k.low < minPrice) minPrice = k.low;
    if (k.high > maxPrice) maxPrice = k.high;
  }

  if (maxPrice - minPrice < 0.001) return null;

  // 添加边距（上下各 5%）
  const padding = (maxPrice - minPrice) * 0.05;
  minPrice -= padding;
  maxPrice += padding;

  // 窄幅区间（低价股 / 分钟K）下固定分段数会得到 priceStep < 0.01：相邻档位四舍五入后
  // 出现重复价格标签，「峰」标记也会同时命中多行。按区间收紧档位数，保证每档 ≥ 0.01 元。
  const steps = Math.max(1, Math.min(stepsRaw, Math.floor((maxPrice - minPrice) / 0.01)));

  const priceStep = (maxPrice - minPrice) / steps;
  const distribution = new Float64Array(steps);

  // ---- 对每根 K 线分配成交量 ----
  for (const k of data) {
    const { high, low, close, volume } = k;

    // 换手率衰减：先把已沉淀的历史筹码按本根的换手率折损，再叠加本根新增筹码，
    // 使每根筹码的最终留存率 = ∏(后续各根 1 - 衰减系数×换手率)，越早的筹码留存越少
    if (decay) {
      const barVolume = Number(volume) || 0;
      const tr = Math.min(1, Math.max(0, (turnoverPct / 100) * (barVolume / latestVolume)));
      const keep = Math.max(0, 1 - decayCoefficient * tr);
      for (let i = 0; i < steps; i++) distribution[i] *= keep;
    }

    if (!volume || volume <= 0) continue;

    const lowIdx = Math.max(0, Math.min(steps - 1, Math.floor((low - minPrice) / priceStep)));
    const highIdx = Math.max(0, Math.min(steps - 1, Math.floor((high - minPrice) / priceStep)));
    const closeIdx = Math.max(0, Math.min(steps - 1, Math.floor((close - minPrice) / priceStep)));

    // 金额比手数更能反映资金沉淀；口径须对所有 K 线一致（腾讯日 K 无成交额字段，恒回退到 volume * close）
    const turnover = k.turnover || volume * close;
    const allocValue = turnover > 0 ? turnover : volume;

    const range = highIdx - lowIdx;
    // 一字板（high === low）或整段价格落在同一档位：全部计入该档，不可丢弃
    if (range === 0) {
      distribution[closeIdx] += allocValue;
      continue;
    }

    // 三角形分布：权重在收盘价附近最高，向两端递减
    const halfRange = Math.max(1, range / 2);
    let totalWeight = 0;
    const weights = [];

    for (let i = lowIdx; i <= highIdx; i++) {
      const dist = Math.abs(i - closeIdx) / halfRange;
      const weight = Math.max(0.1, 1 - dist * 0.45);
      weights.push(weight);
      totalWeight += weight;
    }

    for (let i = 0; i < weights.length; i++) {
      distribution[lowIdx + i] += (weights[i] / totalWeight) * allocValue;
    }
  }

  // ---- 归一化 ----
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const raw = Array.from(distribution, (v, i) => ({
    price: +(minPrice + i * priceStep).toFixed(2),
    ratio: v / total,
  }));

  // ---- 平滑处理 ----
  const smoothed = raw.map((item, i) => {
    let sum = 0;
    let count = 0;
    const half = Math.floor(smoothWindow / 2);
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < raw.length) {
        sum += raw[j].ratio;
        count++;
      }
    }
    return { price: item.price, ratio: sum / count };
  });

  // ---- 查找峰值 ----
  let maxRatio = 0;
  let peakIdx = 0;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i].ratio > maxRatio) {
      maxRatio = smoothed[i].ratio;
      peakIdx = i;
    }
  }

  // ---- 计算 COST 分位价格 ----
  const sorted = [...smoothed].sort((a, b) => a.price - b.price);
  let cumulative = 0;
  const costLevels = {};
  const costTargets = [5, 15, 50, 85, 95];
  let targetIdx = 0;

  for (const item of sorted) {
    cumulative += item.ratio;
    while (targetIdx < costTargets.length && cumulative >= costTargets[targetIdx] / 100) {
      costLevels[`COST${costTargets[targetIdx]}`] = item.price;
      targetIdx++;
    }
  }

  // ---- 计算平均成本（加权平均） ----
  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of smoothed) {
    weightedSum += item.price * item.ratio;
    weightTotal += item.ratio;
  }
  const avgCost = weightTotal > 0 ? weightedSum / weightTotal : 0;

  return {
    distribution: smoothed,
    peakPrice: smoothed[peakIdx].price,
    peakRatio: maxRatio,
    currentPrice: data[data.length - 1].close,
    costLevels,
    avgCost: +avgCost.toFixed(2),
    decayed: decay,
    decayTurnoverRate: decay ? +turnoverPct.toFixed(2) : null,
  };
}
