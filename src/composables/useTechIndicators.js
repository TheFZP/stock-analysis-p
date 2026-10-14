/**
 * useTechIndicators — 技术指标计算 composable
 *
 * 包含 EMA / MACD / KDJ / WR / RSI / 均线趋势 / 交叉信号
 * 所有函数为纯函数，可在组件外独立使用。
 */
// ---- 纯函数（可独立导出使用） ----

/** EMA 计算 */
function ema(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let prev = data[0];
  result.push(prev);
  for (let i = 1; i < data.length; i++) {
    const val = data[i] * k + prev * (1 - k);
    result.push(val);
    prev = val;
  }
  return result;
}

/** MACD: 返回 [{ dif, dea, macd }, ...] */
export function calcMACD(closePrices) {
  if (closePrices.length < 26) return [];
  const ema12 = ema(closePrices, 12);
  const ema26 = ema(closePrices, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = ema(dif, 9);
  const macd = dif.map((v, i) => 2 * (v - dea[i]));
  return dif.map((v, i) => ({ dif: v, dea: dea[i], macd: macd[i] }));
}

/** KDJ: 返回 [{ k, d, j }, ...]，data 需包含 { high, low, close } */
export function calcKDJ(data, n = 9) {
  if (data.length < n) return [];
  const rsv = [];
  for (let i = 0; i < data.length; i++) {
    if (i < n - 1) {
      rsv.push(50);
      continue;
    }
    const slice = data.slice(i - n + 1, i + 1);
    const high = Math.max(...slice.map((s) => s.high));
    const low = Math.min(...slice.map((s) => s.low));
    const close = data[i].close;
    rsv.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }
  let k = 50, d = 50;
  return rsv.map((v) => {
    k = (2 / 3) * k + (1 / 3) * v;
    d = (2 / 3) * d + (1 / 3) * k;
    const j = 3 * k - 2 * d;
    return { k, d, j };
  });
}

/** 均线趋势: 计算 5/10/20/30 日均线最新值 */
export function calcMATrend(closePrices) {
  if (closePrices.length < 5) return {};
  const mas = {};
  [5, 10, 20, 30].forEach((p) => {
    if (closePrices.length < p) return;
    let sum = 0;
    for (let i = closePrices.length - p; i < closePrices.length; i++) {
      sum += closePrices[i];
    }
    mas[p] = sum / p;
  });
  return mas;
}

/** WR (Williams %R): 返回最近值序列，data 需包含 { high, low, close } */
export function calcWR(data, n = 14) {
  if (data.length < n) return [];
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < n - 1) {
      result.push(null);
      continue;
    }
    const slice = data.slice(i - n + 1, i + 1);
    const high = Math.max(...slice.map((s) => s.high));
    const low = Math.min(...slice.map((s) => s.low));
    const close = data[i].close;
    const wr = high === low ? -50 : ((high - close) / (high - low)) * -100;
    result.push(wr);
  }
  return result;
}

/** RSI: 返回 [值, ...]，使用 Wilder 平滑法 */
export function calcRSI(closePrices, period = 14) {
  if (closePrices.length < period + 1) return [];
  const gains = [];
  const losses = [];
  for (let i = 1; i < closePrices.length; i++) {
    const diff = closePrices[i] - closePrices[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const rsiOf = (gain, loss) =>
    loss === 0 ? (gain === 0 ? 50 : 100) : 100 - (100 / (1 + gain / loss));
  const rsi = [rsiOf(avgGain, avgLoss)];
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rsi.push(rsiOf(avgGain, avgLoss));
  }
  return rsi;
}

/**
 * 判断交叉信号：在 arr 末尾 lookback 根内，查找 key1 上穿 / 下穿 key2 的最近一次交叉
 * @returns {string|null} 如「金叉 ↑」（最后一根发生）、「金叉 ↑（2 根前）」，无交叉返回 null
 */
export function getCrossSignal(arr, key1, key2, lookback = 3) {
  if (arr.length < lookback + 1) return null;
  for (let back = 1; back <= lookback; back++) {
    const prev = arr[arr.length - back - 1];
    const curr = arr[arr.length - back];
    if (!prev || !curr) continue;
    const prevDiff = prev[key1] - prev[key2];
    const currDiff = curr[key1] - curr[key2];
    // 带偏移量，避免把数根之前发生的交叉当成当前信号（AI 会照抄「信号：金叉」）
    const suffix = back === 1 ? "" : `（${back} 根前）`;
    if (prevDiff <= 0 && currDiff > 0) return `金叉 ↑${suffix}`;
    if (prevDiff >= 0 && currDiff < 0) return `死叉 ↓${suffix}`;
  }
  return null;
}
