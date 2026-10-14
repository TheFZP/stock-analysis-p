<script setup>
import { ref, computed, onMounted, onUpdated, onUnmounted, watch, nextTick } from "vue";
import { createChart, ColorType, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers } from "lightweight-charts";
import { calcSupportResistance } from "../composables/useSupportResistance.js";
import { useSettings } from "../composables/useSettings.js";
import { usePositions } from "../composables/usePositions.js";
import { getPeriodMeta } from "../utils/klinePeriod.js";
import DataFreshness from "./DataFreshness.vue";

const { positions } = usePositions();

const { state: settings } = useSettings();

const props = defineProps({
  data: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  period: { type: String, default: "day" },
  markers: { type: Array, default: () => [] },
  showSR: { type: Boolean, default: false },
  signalMarkers: { type: Array, default: () => [] },
  code: { type: String, default: "" },
  /** 最近一次成功获取 K 线的时间戳（ms）；0 = 未获取过 */
  fetchedAt: { type: Number, default: 0 },
  /** 最近一次刷新失败：当前展示的是旧数据 */
  stale: { type: Boolean, default: false },
});

const emit = defineEmits(["change-period", "retry"]);

const periodMeta = computed(() => getPeriodMeta(props.period));
const periodLabel = computed(() => `${periodMeta.value.label}线`);
/** 30 根 K 线高低线的单位：周/月/分钟K 时不能再叫「30日」 */
const hlUnitLabel = computed(() => periodMeta.value.hl);

const chartContainer = ref(null);
let chart = null;
let candleSeries = null;
let volumeSeries = null;
let markersPlugin = null;
/** T+0 信号标记插件 */
let signalMarkersPlugin = null;
/** 30日高低价线引用 */
let highPriceLine = null;
let lowPriceLine = null;

/** 支撑/阻力线 */
let srPriceLines = [];
const srLevels = ref({ support: [], resistance: [] });

/** 当前股票持仓成本价（未持仓时为 null） */
const costPrice = computed(() => {
  if (!props.code) return null;
  const pos = positions.value.find((p) => p.code === props.code);
  return pos && pos.buyPrice > 0 ? pos.buyPrice : null;
});
/** 持仓成本线引用 */
let costPriceLine = null;

/** 已 fitContent 的数据身份（首根K线日期+数量）：仅切换股票/周期时重置视图，
 *  定时刷新数据时保留用户的缩放/平移 */
let fittedDataKey = "";

/** 分钟级周期（腾讯 mkline 返回 yyyyMMddHHmm，需转时间戳；日/周/月返回 yyyy-mm-dd 直接用） */
const MINUTE_PERIODS = new Set(["m5", "m15", "m30", "m60"]);

/**
 * 把后端 K 线 date 字段转为 lightweight-charts 可用的 time：
 * - "yyyyMMddHHmm"（分钟级）→ Unix 秒级时间戳（东八区时间按 UTC 处理，
 *   与 IntradayChart 保持一致，保证 crosshair 时间显示正确）
 * - "yyyy-mm-dd"（日/周/月）→ 原样返回（business day 字符串）
 */
function toChartTime(dateStr) {
  if (typeof dateStr === "string" && /^\d{12}$/.test(dateStr)) {
    const year = parseInt(dateStr.slice(0, 4), 10);
    const month = parseInt(dateStr.slice(4, 6), 10) - 1; // 0-based
    const day = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const m = parseInt(dateStr.slice(10, 12), 10);
    return Math.floor(Date.UTC(year, month, day, h, m) / 1000);
  }
  return dateStr;
}

/** 渲染/更新持仓成本线：持仓时显示，否则移除 */
function updateCostLine() {
  if (!candleSeries) return;
  const cost = costPrice.value;
  if (cost != null) {
    if (costPriceLine) {
      costPriceLine.applyOptions({ price: cost });
    } else {
      costPriceLine = candleSeries.createPriceLine({
        price: cost,
        color: "#f0b429",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "成本",
      });
    }
  } else if (costPriceLine) {
    try { candleSeries.removePriceLine(costPriceLine); } catch {}
    costPriceLine = null;
  }
}

// 持仓变化时刷新成本线
watch(costPrice, () => { if (candleSeries) updateCostLine(); });

/** 内部状态：是否显示支撑/阻力线（由父组件通过暴露的方法控制） */
let _srVisible = false;

/** 由父组件调用：切换支撑/阻力线显示 */
function toggleSR() {
  _srVisible = !_srVisible;
  // 清理旧线
  srPriceLines.forEach((line) => { try { candleSeries?.removePriceLine(line); } catch (e) {} });
  srPriceLines = [];
  if (_srVisible) {
    if (!candleSeries) {
      nextTick(() => {
        if (candleSeries) renderSupportResistance();
      });
      return;
    }
    renderSupportResistance();
  }
}

/** 在更新数据后，如果 SR 已开启则重新渲染 */
function refreshSRIfVisible() {
  if (_srVisible && candleSeries) {
    srPriceLines.forEach((line) => { try { candleSeries?.removePriceLine(line); } catch (e) {} });
    srPriceLines = [];
    renderSupportResistance();
  }
}

defineExpose({ toggleSR });

/** 响应 showSR 变化（备用方案） */
watch(() => props.showSR, (val) => {
  if (val !== _srVisible) {
    toggleSR();
  }
}, { immediate: false, flush: 'sync' });

/** 渲染支撑/阻力线到图表 */
function renderSupportResistance() {
  try {
    if (!candleSeries) return;

    // 移除旧的支撑/阻力线
    srPriceLines.forEach((line) => { try { candleSeries?.removePriceLine(line); } catch (e) {} });
    srPriceLines = [];

    const { support, resistance } = srLevels.value;

    // 创建阻力线 (红色系)
    resistance.forEach((r, i) => {
      // 线条数 ≥6 时 1-i*0.2 会变成负数（非法 rgba），下限 0.15 保证可见
      const opacity = Math.max(0.15, 1 - i * 0.2);
      const label = r.fib ? `阻力(${(r.fib * 100).toFixed(0)}%)` : `阻力${i + 1}`;
      srPriceLines.push(
        candleSeries.createPriceLine({
          price: r.price,
          color: `rgba(231, 76, 60, ${opacity})`,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: label,
        })
      );
    });

    // 创建支撑线 (绿色系)
    support.forEach((s, i) => {
      // 线条数 ≥6 时 1-i*0.2 会变成负数（非法 rgba），下限 0.15 保证可见
      const opacity = Math.max(0.15, 1 - i * 0.2);
      const label = s.fib ? `支撑(${(s.fib * 100).toFixed(0)}%)` : `支撑${i + 1}`;
      srPriceLines.push(
        candleSeries.createPriceLine({
          price: s.price,
          color: `rgba(39, 174, 96, ${opacity})`,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: label,
        })
      );
    });
  } catch (_err) {
    // 忽略渲染错误
  }
}

/** 均线系列 — 由设置控制周期 */
const ALL_MA_COLORS = {
  5: "#ff4500", 10: "#1a73e8", 20: "#9c27b0",
  30: "#00acc1", 60: "#e67e22", 120: "#2ecc71",
  250: "#e74c3c",
};
const maSeries = {};
const maLatestValues = ref({});

/** 当前启用的均线周期（响应式，随设置变化） */
const activeMaPeriods = computed(() => settings.klineMaPeriods || [5, 10, 20, 30]);
const show30DayHL = computed(() => settings.klineShow30DayHL !== false);

function computeMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j].close;
    }
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

function initChart() {
  if (!chartContainer.value || chart) return;

  chart = createChart(chartContainer.value, {
    width: chartContainer.value.clientWidth,
    height: chartContainer.value.clientHeight,
    layout: {
      background: { type: ColorType.Solid, color: "#ffffff" },
      textColor: "#777b86",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "rgba(163, 166, 175, 0.12)" },
      horzLines: { color: "rgba(163, 166, 175, 0.12)" },
    },
    crosshair: {
      mode: 0,
      vertLine: { color: "#8b8c8d", width: 1, style: 2, labelBackgroundColor: "#4c4c4c" },
      horzLine: { color: "#8b8c8d", width: 1, style: 2, labelBackgroundColor: "#4c4c4c" },
    },
    rightPriceScale: {
      borderColor: "rgba(163, 166, 175, 0.2)",
      scaleMargins: { top: 0.05, bottom: 0.25 },
    },
    timeScale: {
      borderColor: "rgba(163, 166, 175, 0.2)",
      timeVisible: false,
      ticksVisible: true,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    handleScroll: { vertTouchDrag: false },
  });

  candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: "#e74c3c",
    downColor: "#27ae60",
    borderUpColor: "#e74c3c",
    borderDownColor: "#27ae60",
    wickUpColor: "#e74c3c",
    wickDownColor: "#27ae60",
    priceFormat: {
      type: "price",
      precision: 2,
      minMove: 0.01,
    },
  });

  volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
    priceLineVisible: false,
  });

  chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.80, bottom: 0 },
  });

  // 添加均线
  activeMaPeriods.value.forEach((p) => {
    const series = chart.addSeries(LineSeries, {
      color: ALL_MA_COLORS[p] || "#888",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    maSeries[p] = series;
  });

  // 创建标记插件（自选标记）
  markersPlugin = createSeriesMarkers(candleSeries);

  // 创建 T+0 信号标记插件
  signalMarkersPlugin = createSeriesMarkers(candleSeries);

  // 响应式 resize
  const observer = new ResizeObserver(() => {
    if (chartContainer.value && chart) {
      const { clientWidth, clientHeight } = chartContainer.value;
      chart.applyOptions({ width: clientWidth, height: clientHeight });
    }
  });
  observer.observe(chartContainer.value);
  chart._observer = observer;
}

function updateChartData(newData) {
  if (!candleSeries || !volumeSeries || !newData || newData.length === 0) {
    return;
  }

  const candleData = [];
  const volumeData = [];

  // 分钟级周期显示时分刻度，日/周/月只显示日期
  const isMinute = MINUTE_PERIODS.has(props.period);
  chart.applyOptions({
    timeScale: { timeVisible: isMinute, secondsVisible: false },
  });

  for (const item of newData) {
    const time = toChartTime(item.date);
    candleData.push({
      time,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
    });

    // 根据涨跌决定成交量颜色 (A股: 红涨绿跌)
    const isUp = item.close >= item.open;
    volumeData.push({
      time,
      value: item.volume,
      color: isUp ? "rgba(231, 76, 60, 0.4)" : "rgba(39, 174, 96, 0.4)",
    });
  }

  candleSeries.setData(candleData);
  volumeSeries.setData(volumeData);

  // 计算近 30 根 K 线高低并更新/创建价格线
  if (show30DayHL.value) {
    const lookback = Math.min(30, candleData.length);
    const recentCandles = candleData.slice(-lookback);
    const high30 = Math.max(...recentCandles.map((c) => c.high));
    const low30 = Math.min(...recentCandles.map((c) => c.low));
    const highTitle = `30${hlUnitLabel.value}高`;
    const lowTitle = `30${hlUnitLabel.value}低`;

    if (highPriceLine) {
      highPriceLine.applyOptions({ price: high30, title: highTitle });
    } else {
      highPriceLine = candleSeries.createPriceLine({
        price: high30,
        color: "#e74c3c",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: highTitle,
      });
    }
    if (lowPriceLine) {
      lowPriceLine.applyOptions({ price: low30, title: lowTitle });
    } else {
      lowPriceLine = candleSeries.createPriceLine({
        price: low30,
        color: "#27ae60",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: lowTitle,
      });
    }
  } else {
    if (highPriceLine) { try { candleSeries?.removePriceLine(highPriceLine); } catch {} highPriceLine = null; }
    if (lowPriceLine) { try { candleSeries?.removePriceLine(lowPriceLine); } catch {} lowPriceLine = null; }
  }

  // 支撑与阻力 — 保存数据，数据更新后重新渲染
  const { support, resistance } = calcSupportResistance(candleData);
  srLevels.value = { support, resistance };
  refreshSRIfVisible();

  // 更新均线数据（按需动态创建/移除 series）
  const latestValues = {};
  const currentPeriods = new Set(activeMaPeriods.value);

  // 移除不再需要的 series
  Object.keys(maSeries).forEach((p) => {
    const period = Number(p);
    if (!currentPeriods.has(period) && maSeries[period]) {
      try { chart?.removeSeries(maSeries[period]); } catch {}
      delete maSeries[period];
    }
  });

  // 按需创建新 series
  currentPeriods.forEach((p) => {
    if (!maSeries[p] && chart) {
      const series = chart.addSeries(LineSeries, {
        color: ALL_MA_COLORS[p] || "#888",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      maSeries[p] = series;
    }
  });

  currentPeriods.forEach((p) => {
    const series = maSeries[p];
    if (series) {
      const maData = computeMA(candleData, p);
      series.setData(maData);
      if (maData.length > 0) {
        latestValues[p] = maData[maData.length - 1].value;
      }
    }
  });
  maLatestValues.value = latestValues;

  // 渲染加入自选标记
  if (markersPlugin) {
    if (props.markers && props.markers.length > 0) {
      markersPlugin.setMarkers(
        props.markers.map((m) => ({
          time: toChartTime(m.time),
          position: m.position || "belowBar",
          color: m.color || "#f0b429",
          shape: m.shape || "arrowUp",
          text: m.text || "",
          size: m.size ?? 1,
        }))
      );
    } else {
      markersPlugin.setMarkers([]);
    }
  }

  // 渲染 T+0 信号标记
  if (signalMarkersPlugin) {
    if (props.signalMarkers && props.signalMarkers.length > 0) {
      signalMarkersPlugin.setMarkers(
        props.signalMarkers.map((m) => ({ ...m, time: toChartTime(m.time) }))
      );
    } else {
      signalMarkersPlugin.setMarkers([]);
    }
  }

  // 渲染持仓成本线
  updateCostLine();

  // 仅当数据身份变化（切换股票/周期）时 fitContent，
  // 定时刷新（默认 120s）不重置用户缩放/平移
  const firstItem = newData[0];
  const dataKey = firstItem ? `${firstItem.date}:${newData.length}` : "";
  if (dataKey !== fittedDataKey) {
    fittedDataKey = dataKey;
    chart.timeScale().fitContent();
  }
}

function ensureChart() {
  if (!chart) {
    initChart();
  }
}

watch(
  () => props.data,
  (newData) => {
    if (newData && newData.length > 0) {
      // 等待 DOM 更新后初始化图表并渲染数据
      nextTick(() => {
        ensureChart();
        updateChartData(newData);
      });
    } else if (candleSeries) {
      // 切换到无数据股票：清空旧图表，避免残留上一只股票的内容
      candleSeries.setData([]);
      if (volumeSeries) volumeSeries.setData([]);
      [highPriceLine, lowPriceLine, costPriceLine].forEach((l) => {
        if (l) { try { candleSeries.removePriceLine(l); } catch (e) {} }
      });
      highPriceLine = null;
      lowPriceLine = null;
      costPriceLine = null;
      srPriceLines.forEach((line) => { try { candleSeries.removePriceLine(line); } catch (e) {} });
      srPriceLines = [];
      Object.keys(maSeries).forEach((k) => {
        try { chart?.removeSeries(maSeries[k]); } catch (e) {}
        delete maSeries[k];
      });
      markersPlugin?.setMarkers([]);
      signalMarkersPlugin?.setMarkers([]);
    }
  },
  { deep: true, immediate: true }
);

// 标记独立更新（当只修改了加入自选日而不刷新 K 线数据时）
watch(
  () => props.markers,
  (markers) => {
    if (markersPlugin) {
      if (markers && markers.length > 0) {
        markersPlugin.setMarkers(
          markers.map((m) => ({
            time: toChartTime(m.time),
            position: m.position || "belowBar",
            color: m.color || "#f0b429",
            shape: m.shape || "arrowUp",
            text: m.text || "",
            size: m.size ?? 1,
          }))
        );
      } else {
        markersPlugin.setMarkers([]);
      }
    }
  },
  { deep: true }
);

// T+0 信号标记独立更新
watch(
  () => props.signalMarkers,
  (markers) => {
    if (signalMarkersPlugin) {
      if (markers && markers.length > 0) {
        signalMarkersPlugin.setMarkers(
          markers.map((m) => ({ ...m, time: toChartTime(m.time) }))
        );
      } else {
        signalMarkersPlugin.setMarkers([]);
      }
    }
  },
  { deep: true }
);

// 均线周期 / 30日高低线设置变更时自动重绘
watch([activeMaPeriods, show30DayHL], () => {
  if (props.data && props.data.length > 0 && candleSeries) {
    updateChartData(props.data);
  }
});

onMounted(() => {
  // 挂载后等待 DOM 就绪，如果已有数据则初始化
  nextTick(() => {
    if (props.data && props.data.length > 0) {
      initChart();
      updateChartData(props.data);
    }
  });
});

/** 备份：每次组件更新后检查是否需要渲染 SR 线 */
onUpdated(() => {
  if (!candleSeries) return;
  if (_srVisible && srPriceLines.length === 0) {
    renderSupportResistance();
  } else if (!_srVisible && srPriceLines.length > 0) {
    srPriceLines.forEach((line) => { try { candleSeries?.removePriceLine(line); } catch (e) {} });
    srPriceLines = [];
  }
});

onUnmounted(() => {
  if (chart) {
    if (chart._observer) chart._observer.disconnect();
    chart.remove();
    chart = null;
    candleSeries = null;
    volumeSeries = null;
    markersPlugin = null;
    signalMarkersPlugin = null;
    highPriceLine = null;
    lowPriceLine = null;
    srPriceLines = [];
    costPriceLine = null;
    Object.keys(maSeries).forEach((k) => delete maSeries[k]);
  }
});
</script>

<template>
  <div class="kline-wrapper">
    <div class="kline-header">
      <div class="kline-header-left">
        <span class="kline-title">{{ periodLabel }}</span>
        <DataFreshness :at="fetchedAt" :stale="stale" label="K 线" @retry="emit('retry')" />
      </div>
      <div class="kline-header-right">
        <div class="kline-periods">
          <button
            class="period-btn"
            :class="{ active: props.period === 'm5' }"
            @click="emit('change-period', 'm5')"
          >5分</button>
          <button
            class="period-btn"
            :class="{ active: props.period === 'm15' }"
            @click="emit('change-period', 'm15')"
          >15分</button>
          <button
            class="period-btn"
            :class="{ active: props.period === 'm30' }"
            @click="emit('change-period', 'm30')"
          >30分</button>
          <button
            class="period-btn"
            :class="{ active: props.period === 'm60' }"
            @click="emit('change-period', 'm60')"
          >60分</button>
          <span class="period-sep"></span>
          <button
            class="period-btn"
            :class="{ active: props.period === 'day' }"
            @click="emit('change-period', 'day')"
          >日 K</button>
          <button
            class="period-btn"
            :class="{ active: props.period === 'week' }"
            @click="emit('change-period', 'week')"
          >周 K</button>
          <button
            class="period-btn"
            :class="{ active: props.period === 'month' }"
            @click="emit('change-period', 'month')"
          >月 K</button>
        </div>
        <div class="kline-legend">
          <span v-for="p in activeMaPeriods" :key="p" class="legend-item ma-legend">
            <span class="legend-dot" :style="{ background: ALL_MA_COLORS[p] || '#888' }"></span>
            MA{{ p }} <span class="ma-value">{{ maLatestValues[p]?.toFixed(2) ?? "--" }}</span>
          </span>
        </div>
      </div>
    </div>
    <div class="kline-chart-wrap" :class="{ 'is-stale': stale }">
      <div ref="chartContainer" class="kline-chart"></div>
      <div v-if="loading" class="kline-loading">
        <span class="kline-loading-icon">⟳</span>
        <span>加载 K 线数据中...</span>
      </div>
      <div v-else-if="!data || data.length === 0" class="kline-empty">
        <span class="kline-empty-icon">—</span>
        <p class="kline-empty-text">暂无 K 线数据</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== Steep: Kline 图表区 ===== */
.kline-wrapper {
  margin-bottom: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.kline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.kline-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.kline-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.009em;
}

.kline-header-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 窗口较窄时压缩图例间距 */
@media (max-width: 900px) {
  .kline-header-right {
    gap: 8px;
  }
}

/* Steep: period pill group */
.kline-periods {
  display: flex;
  background: var(--fog);
  border-radius: var(--radius-full);
  padding: 3px;
  gap: 2px;
}

.period-btn {
  padding: 5px 14px;
  border: none;
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  background: transparent;
  color: var(--text-muted);
  transition: all 0.15s;
  letter-spacing: -0.009em;
}

.period-btn:hover {
  color: var(--text-secondary);
}

.period-btn.active {
  background: var(--card-bg);
  color: var(--ink);
  box-shadow: 0 0 0 1px rgba(23, 25, 28, 0.04), 0 1px 3px rgba(23, 25, 28, 0.06);
}

/* 分钟周期与日/周/月之间的分隔线 */
.period-sep {
  width: 1px;
  align-self: stretch;
  margin: 3px 4px;
  background: var(--border);
}

.kline-legend {
  display: flex;
  align-items: center;
  gap: 12px;
}

.legend-item {
  font-size: 11px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.ma-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text-primary);
}

.kline-chart-wrap {
  position: relative;
  width: 100%;
  min-height: 200px;
  flex: 1;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-light);
  overflow: hidden;
}

/* 刷新失败：当前画的是旧数据，整块图表转灰提示 */
.kline-chart-wrap.is-stale {
  filter: grayscale(0.85);
  opacity: 0.7;
}

.kline-chart {
  width: 100%;
  height: 100%;
}

.kline-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 14px;
}

.kline-loading-icon {
  font-size: 22px;
  opacity: 0.5;
  animation: kline-spin 1s linear infinite;
}

@keyframes kline-spin {
  to { transform: rotate(360deg); }
}

.kline-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--card-bg);
  color: var(--text-muted);
}

.kline-empty-icon {
  font-size: 32px;
  margin-bottom: 8px;
  opacity: 0.5;
}

.kline-empty-text {
  font-size: 13px;
}
</style>
