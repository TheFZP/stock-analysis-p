<script setup>
import { computed } from "vue";
import {
  calcMACD, calcKDJ, calcWR, calcRSI,
  calcMATrend, getCrossSignal,
} from "../composables/useTechIndicators";
import IndicatorCard from "./IndicatorCard.vue";
import { periodNotice } from "../utils/klinePeriod.js";

const props = defineProps({
  show: { type: Boolean, default: false },
  klineData: { type: Array, default: null },
  klinePeriod: { type: String, default: "day" },
  stockName: { type: String, default: "" },
});

const emit = defineEmits(["close"]);

// 口径提示：klineData 随图表周期切换，周/月/分钟K 下 MA5 不是 5 日均线
const periodHint = computed(() => periodNotice(props.klinePeriod));

function closeModal() {
  emit("close");
}

// ---- 计算结果 ----
const indicators = computed(() => {
  if (!props.klineData || props.klineData.length < 26) return null;

  const closePrices = props.klineData.map((d) => d.close);

  // MACD
  const macdData = calcMACD(closePrices);
  const latestMACD = macdData.length > 0 ? macdData[macdData.length - 1] : null;
  const prevMACD = macdData.length > 1 ? macdData[macdData.length - 2] : null;
  const macdCross = getCrossSignal(macdData, "dif", "dea", 2);

  // WR
  const wrData = calcWR(props.klineData);
  const latestWR = wrData.filter((v) => v !== null).slice(-1)[0] ?? null;

  // RSI
  const rsiData = calcRSI(closePrices);
  const latestRSI = rsiData.length > 0 ? rsiData[rsiData.length - 1] : null;

  // KDJ
  const kdjData = calcKDJ(props.klineData);
  const latestKDJ = kdjData.length > 0 ? kdjData[kdjData.length - 1] : null;
  const kdjCross = getCrossSignal(kdjData, "k", "d", 2);
  // KDJ 超买超卖
  const kdjStatus = latestKDJ
    ? (latestKDJ.k > 80 || latestKDJ.d > 80 || latestKDJ.j > 100
        ? "超买"
        : latestKDJ.k < 20 || latestKDJ.d < 20 || latestKDJ.j < 0
          ? "超卖"
          : "正常")
    : null;

  // MA 趋势
  const maValues = calcMATrend(closePrices);
  const sortedMas = Object.entries(maValues).sort((a, b) => Number(a[0]) - Number(b[0]));
  const maTrend = sortedMas.length >= 2
    ? (sortedMas[0][1] > sortedMas[sortedMas.length - 1][1] ? "多头" : "空头")
    : null;
  const maTrendDetail = sortedMas.map(([p, v]) => `MA${p}: ${v.toFixed(2)}`).join("  ");

  // 均线排列: 检查每条短期均线是否都大于/小于长期均线
  const maAlignment = (() => {
    if (sortedMas.length < 3) return null;
    let allBullish = true;
    let allBearish = true;
    for (let i = 0; i < sortedMas.length - 1; i++) {
      if (sortedMas[i][1] <= sortedMas[i + 1][1]) allBullish = false;
      if (sortedMas[i][1] >= sortedMas[i + 1][1]) allBearish = false;
    }
    if (allBullish) return "多头排列";
    if (allBearish) return "空头排列";
    return "交叉缠绕";
  })();

  return {
    macd: latestMACD,
    macdPrev: prevMACD,
    macdCross,
    kdj: latestKDJ,
    kdjCross,
    kdjStatus,
    wr: latestWR,
    maTrend,
    maTrendDetail,
    maValues,
    maAlignment,
    rsi: latestRSI,
  };
});

// ---- 格式化 ----
function fmt(v, d = 2) {
  if (v == null) return "--";
  return v.toFixed(d);
}

function fmtSignal(signal) {
  if (!signal) return { text: "--", cls: "signal-none" };
  if (signal.includes("金叉")) return { text: signal, cls: "signal-up" };
  return { text: signal, cls: "signal-down" };
}

// ── 各指标卡片数据 ──
const maRows = computed(() => {
  const maValues = indicators.value?.maValues;
  if (!maValues) return [];
  return Object.entries(maValues)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([p, v]) => ({ label: `MA${p}`, value: v.toFixed(2) }));
});

const maAlignmentObj = computed(() => {
  const a = indicators.value?.maAlignment;
  if (!a) return null;
  return {
    text: a,
    cls: a.includes("多头排列") ? "signal-up" : a.includes("空头排列") ? "signal-down" : "signal-none",
  };
});

const macdRows = computed(() => {
  const m = indicators.value?.macd;
  if (!m) return [];
  return [
    { label: "DIF", value: fmt(m.dif) },
    { label: "DEA", value: fmt(m.dea) },
    { label: "MACD", value: fmt(m.macd), cls: (m.macd ?? 0) >= 0 ? "up" : "down" },
  ];
});

const kdjRows = computed(() => {
  const k = indicators.value?.kdj;
  if (!k) return [];
  return [
    { label: "K", value: fmt(k.k) },
    { label: "D", value: fmt(k.d) },
    { label: "J", value: fmt(k.j) },
  ];
});

const kdjStatusCls = computed(() => {
  const s = indicators.value?.kdjStatus;
  if (!s) return "signal-none";
  return s.includes("超买") ? "signal-down" : s.includes("超卖") ? "signal-up" : "signal-none";
});

const wrRows = computed(() => {
  const w = indicators.value?.wr;
  const cls = (w ?? 0) <= -80 ? "signal-up" : (w ?? 0) >= -20 ? "signal-down" : "";
  return [{ label: "WR(14)", value: w != null ? fmt(w) + "%" : "--", cls }];
});

const rsiRows = computed(() => {
  const r = indicators.value?.rsi;
  const cls = (r ?? 50) > 70 ? "signal-down" : (r ?? 50) < 30 ? "signal-up" : "";
  return [{ label: "RSI(14)", value: r != null ? fmt(r) : "--", cls }];
});

const rsiDetail = computed(() => {
  const r = indicators.value?.rsi;
  if (r == null) return "超买: &ge; 70 | 超卖: &le; 30";
  const cls = r > 70 ? "signal-down" : r < 30 ? "signal-up" : "";
  return `超买: &ge; 70 &nbsp;|&nbsp; 超卖: &le; 30 &nbsp;|&nbsp; 当前: <span class="${cls}">${fmt(r)}</span>`;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="closeModal">
      <div class="modal-container">
        <div class="modal-header">
          <div class="modal-header-left">
            <span class="tech-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--ink)" stroke-width="1.5">
              <path d="M3 17L17 3M3 17l4-1M3 17l1-4" stroke-linejoin="round"/>
              <circle cx="15" cy="5" r="1.5" fill="var(--ink)"/>
            </svg>
          </span>
            <span class="modal-title">技术分析</span>
            <span class="industry-badge">{{ stockName || '技术分析' }}</span>
          </div>
          <button class="modal-close" @click="closeModal">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <p v-if="periodHint" class="period-hint">{{ periodHint }}</p>
          <div v-if="!indicators" class="modal-loading">
            <span class="kline-icon">—</span>
            <span>K 线数据不足，无法分析（至少需要 26 根 K 线）</span>
          </div>

          <template v-else>
            <!-- 均线趋势（Hero，全宽） -->
            <IndicatorCard
              title="均线趋势"
              accent="var(--rust)"
              layout="chips"
              :rows="maRows"
              :detail="indicators.maTrendDetail"
              :alignment="maAlignmentObj"
            />

            <!-- 2 列网格：MACD + KDJ -->
            <div class="indicator-grid">
              <IndicatorCard
                title="MACD"
                accent="var(--ink)"
                :rows="macdRows"
                :signal="indicators.macdCross ? fmtSignal(indicators.macdCross) : null"
              />
              <IndicatorCard
                title="KDJ"
                accent="#8b5cf6"
                :rows="kdjRows"
                :signal="indicators.kdjCross ? fmtSignal(indicators.kdjCross) : null"
                :status="{ label:'超买/超卖', text:indicators.kdjStatus||'--', cls: kdjStatusCls }"
              />
            </div>

            <!-- 2 列网格：WR + RSI -->
            <div class="indicator-grid">
              <IndicatorCard
                title="WR"
                accent="#f59e0b"
                layout="single"
                :rows="wrRows"
                detail="超买 ≥ -20 | 超卖 ≤ -80"
              />
              <IndicatorCard
                title="RSI"
                accent="#06b6d4"
                layout="single"
                :rows="rsiRows"
                :detail="rsiDetail"
              />
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
@import "../assets/modal.css";
</style>

<style scoped>

/* TechAnalysisModal 特有覆盖 */
.modal-overlay {
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: none;
}

.modal-container {
  width: 600px;
  max-width: 94vw;
  max-height: 85vh;
}

.modal-header {
  padding: 20px 28px;
  border-bottom-color: var(--border-light);
}

.tech-icon {
  font-size: 22px;
}

.modal-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.009em;
}

.industry-badge {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--fog);
  color: var(--text-secondary);
  font-weight: 500;
}

.modal-close {
  border-radius: 50%;
}

.modal-body {
  padding: 20px 28px;
  overflow-y: auto;
}

/* ── 2 列指标网格 ── */
.indicator-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}

.modal-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 60px 0;
  color: var(--text-muted);
  font-size: 14px;
}
.kline-icon {
  font-size: 36px;
  opacity: 0.6;
}
</style>
