/**
 * useVolumeSignals — 分时量价信号标注（整线扫描）
 *
 * 纯函数模块：逐分钟扫描分时数据，在价格×量能的关键事件点打标记。
 * 只保留有明确方向与决策含义的信号（区别于 useTrapSignals 的诱多/诱空陷阱识别）。
 *
 * 信号类型（含方向语义）：
 *   前瞻预警：放量急拉⚠ / 放量急跌⚠（5 分钟动能 ≥0.6% + 量 ≥2.5×）、无量拉升⚠（动能 ≥0.8% + 量 ≤0.4×）
 *   关键位：突破↑ / 破位↓（放量越过 30 分钟前高/前低）
 *   动能衰竭：顶背离（新高无量）/ 底背离（新低无量）
 *   （已移除：普通放量↑↓——信息量低且与突破/破位重叠；天量——无方向的事件标注、
 *     开盘/收盘竞价必触发，实盘无操作含义；缩量回踩/反抽——弱二次确认，阴跌盘里频繁出现）
 *
 * 防标记爆炸：同一分钟只保留一个标记（按优先级：前瞻预警 > 突破/破位 > 背离），
 * 同类型信号 10 分钟内只标首个；开盘前仅剔除 09:30 集合竞价分钟。
 *
 * 输入：intradayData = { items: [{ time, price, avgPrice, volume, turnover, vwap }], preClose, date }
 * 输出：{ signals: [{ time, name, type, desc, level }], markers: [...] }
 */

function median(arr) {
  const s = arr.filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function pct(a, b) {
  return a > 0 ? ((b - a) / a) * 100 : 0;
}

/**
 * 标记外观（形状分层 + 色系语义化）：
 *   橙 circle = 前瞻预警（警示色；不用紫色，避免与图上紫色均价线混淆）
 *   深红/深绿 arrow = 方向事件（突破/破位；深色与亮色的陷阱方块区分）
 *   墨蓝/深青 square = 动能衰竭（背离；冷色系，与暖色警报区分）
 */
const MARKER_STYLE = {
  "放量急拉⚠": { color: "#f39c12", shape: "circle", position: "aboveBar" },
  "放量急跌⚠": { color: "#f39c12", shape: "circle", position: "belowBar" },
  "无量拉升⚠": { color: "#f39c12", shape: "circle", position: "aboveBar" },
  "突破↑": { color: "#c0392b", shape: "arrowUp", position: "aboveBar" },
  "破位↓": { color: "#1e8449", shape: "arrowDown", position: "belowBar" },
  "顶背离": { color: "#2c3e50", shape: "square", position: "aboveBar" },
  "底背离": { color: "#16a085", shape: "square", position: "belowBar" },
};

export function calcVolumeSignals(intradayData) {
  const signals = [];
  // 数据门槛：≥10 根即可启动。前瞻预警只需 5 分钟窗口 + 滚动量能基准（当下可判），
  // 开盘放量急拉是全天最重要的信号，不能等满 30 分钟才出；
  // 突破/破位（内部 i>=30）、顶底背离（内部 i>=15）由各自预热门槛自然控制
  if (!intradayData?.items || intradayData.items.length < 10) {
    return { signals, markers: [] };
  }
  const items = intradayData.items;
  const N = items.length;
  const prices = items.map((i) => i.price);
  const volumes = items.map((i) => i.volume);

  // 无量能数据时无法做量价判断
  if (mean(volumes) <= 0) return { signals, markers: [] };

  // 量能基准：滚动基准（前 30 分钟中位数）+ 全局兜底。
  // A 股上午量能显著大于下午（开盘时段可达全天 3-5×），用全天中位数做基准会
  // 导致上午"放量"误报、下午"缩量"误报——滚动基准让"放量/缩量"相对近期常态判断
  const globalBase = median(volumes) || mean(volumes);
  /** 第 i 分钟的滚动基准：i-30..i-11 中位数（滞后 10 分钟）。
   *  滞后设计：当前与最近 10 分钟的放量不影响基准，放量事件起点必然被捕捉；
   *  放量持续超过 10 分钟后基准自然含入放量段，量比回归 1（持续的放量已是常态，不再误报）。
   *  样本不足时用全局兜底 */
  const baseAt = (i) => {
    const from = Math.max(0, i - 30);
    const to = Math.max(0, i - 10);
    if (to - from < 5) return globalBase;
    const m = median(volumes.slice(from, to));
    return m > 0 ? m : globalBase;
  };
  /** 第 i 分钟量比（相对滚动基准） */
  const vr = (i) => (baseAt(i) > 0 ? volumes[i] / baseAt(i) : 0);
  /** [from, to] 区间平均量（相对滚动基准） */
  const meanVol = (from, to) => mean(volumes.slice(Math.max(0, from), Math.min(N, to + 1)));

  // 去重状态
  const seenAt = new Set(); // 同一分钟已打标记
  const lastAt = {}; // 同类型最近标记时间（10 分钟间隔去重）

  /**
   * 打标记（调用顺序即优先级：先调用的先占分钟）
   * @param {number} i 分钟索引
   * @param {string} name 信号名（须在 MARKER_STYLE 中）
   * @param {string} type bull | bear | neutral
   * @param {string} desc 描述
   */
  const add = (i, name, type, desc, level) => {
    if (i < 1 || i >= N) return false; // 只跳过 09:30 集合竞价分钟（开盘放量急拉是重要信号，不得整体跳过）
    if (seenAt.has(i)) return false; // 同分钟只留一个
    if (lastAt[name] != null && i - lastAt[name] < 10) return false; // 同类型间隔去重
    const style = MARKER_STYLE[name];
    if (!style) return false;
    seenAt.add(i);
    lastAt[name] = i;
    signals.push({ time: items[i].time, name, type, desc, level });
    return true;
  };

  for (let i = 1; i < N; i++) {
    const chg5 = pct(prices[Math.max(0, i - 5)], prices[i]);
    const v = vr(i);
    const hi5 = Math.max(...prices.slice(Math.max(0, i - 5), i + 1));
    const lo5 = Math.min(...prices.slice(Math.max(0, i - 5), i + 1));

    // 1. 前瞻预警（当下可判、不依赖后续数据——实盘反应点，先于"疑似诱多?"的跌破确认）：
    //    放量急拉/急跌：5 分钟动能 ≥0.6% + 量 ≥2.5× → 追高/杀跌风险提示
    //    无量拉升：5 分钟动能 ≥0.8% + 量 ≤0.4× → 无承接的虚涨
    if (v >= 2.5 && chg5 >= 0.6) {
      if (add(i, "放量急拉⚠", "bull", `${items[i].time} 起 5 分钟急拉 ${chg5.toFixed(1)}%（量 ${v.toFixed(1)}× 基准），追高风险——警惕冲高回落`, "warn")) continue;
    } else if (v >= 2.5 && chg5 <= -0.6) {
      if (add(i, "放量急跌⚠", "bear", `${items[i].time} 起 5 分钟急跌 ${(-chg5).toFixed(1)}%（量 ${v.toFixed(1)}× 基准），恐慌盘涌出——勿低位割肉`, "warn")) continue;
    } else if (v <= 0.4 && chg5 >= 0.8) {
      if (add(i, "无量拉升⚠", "bull", `${items[i].time} 起 5 分钟拉升 ${chg5.toFixed(1)}% 但量仅 ${v.toFixed(1)}× 基准，无承接的虚涨`, "warn")) continue;
    }

    // 2. 放量突破 / 破位（30 分钟前高/前低）
    // 要求"明显越过"（>0.2%）而非刚好穿越——随机游走中价格必然反复穿过前高，
    // 仅穿越即报会大量误报；同时提高量能门槛到 2×、要求 5 分钟动能 ≥0.5%
    if (i >= 30 && v >= 2) {
      const prevHigh = Math.max(...prices.slice(i - 30, i - 4));
      const prevLow = Math.min(...prices.slice(i - 30, i - 4));
      if (prices[i] > prevHigh * 1.002 && chg5 >= 0.5) {
        if (add(i, "突破↑", "bull", `${items[i].time} 放量突破 30 分钟前高 ${prevHigh.toFixed(2)}（+${(((prices[i] - prevHigh) / prevHigh) * 100).toFixed(1)}%，量 ${v.toFixed(1)}×）`)) continue;
      }
      if (prices[i] < prevLow * 0.998 && chg5 <= -0.5) {
        if (add(i, "破位↓", "bear", `${items[i].time} 放量跌破 30 分钟前低 ${prevLow.toFixed(2)}（${(((prices[i] - prevLow) / prevLow) * 100).toFixed(1)}%，量 ${v.toFixed(1)}×）`)) continue;
      }
    }

    // 3. 量价背离：显著新高/新低（≥0.3%）+ 量能明显萎缩（<前段 0.6×）+ 当前非放量
    if (i >= 15) {
      const prevHigh30 = Math.max(...prices.slice(Math.max(0, i - 30), i - 5));
      const isLocalHigh = prices[i] >= hi5 && prices[i] > prevHigh30 * 1.003;
      if (isLocalHigh && meanVol(i - 4, i) < meanVol(i - 14, i - 5) * 0.6 && v <= 1.5) {
        if (add(i, "顶背离", "bear", `${items[i].time} 创 30 分钟新高（+${(((prices[i] - prevHigh30) / prevHigh30) * 100).toFixed(1)}%）但量能萎缩（前 5 分钟 ${(meanVol(i - 4, i) / baseAt(i)).toFixed(1)}× vs 前段 ${(meanVol(i - 14, i - 5) / baseAt(i)).toFixed(1)}×），上涨动能不足`)) continue;
      }
      const prevLow30 = Math.min(...prices.slice(Math.max(0, i - 30), i - 5));
      const isLocalLow = prices[i] <= lo5 && prices[i] < prevLow30 * 0.997;
      if (isLocalLow && meanVol(i - 4, i) < meanVol(i - 14, i - 5) * 0.6 && v <= 1.5) {
        if (add(i, "底背离", "bull", `${items[i].time} 创 30 分钟新低（${(((prices[i] - prevLow30) / prevLow30) * 100).toFixed(1)}%）但量能萎缩（前 5 分钟 ${(meanVol(i - 4, i) / baseAt(i)).toFixed(1)}× vs 前段 ${(meanVol(i - 14, i - 5) / baseAt(i)).toFixed(1)}×），抛压衰竭`)) continue;
      }
    }
  }

  // 生成标记（signals 已按优先级/去重排序）
  const markers = signals.map((s) => {
    const style = MARKER_STYLE[s.name];
    return {
      time: s.time,
      position: style.position,
      color: style.color,
      shape: style.shape,
      text: s.name,
      size: 1,
    };
  });

  return { signals, markers };
}
