<script setup>
/**
 * ChipDistribution.vue — 筹码峰弹窗组件
 *
 * 以水平条形图展示不同价格层级的筹码集中度。
 * A 股特色：红色 = 获利盘（价格低于现价），绿色 = 套牢盘（价格高于现价）。
 * 筹码峰（最高集中度）使用强调色高亮。
 */
import { computed, ref, watch, nextTick } from "vue";
import {
  calcChipDistribution,
  chipOptionsFromQuote,
  CHIP_MAX_BARS,
} from "../composables/useChipDistribution";
import { getPeriodMeta } from "../utils/klinePeriod.js";

const props = defineProps({
  show: { type: Boolean, default: false },
  klineData: { type: Array, default: null },
  klinePeriod: { type: String, default: "day" },
  stock: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(["close"]);

function closeModal() {
  emit("close");
}

/** 内部缓存的计算结果 */
const chipResult = ref(null);

/** 衰减选项：仅日K + 有换手率时启用（见 useChipDistribution.chipOptionsFromQuote） */
const chipOptions = computed(() => chipOptionsFromQuote(props.stock, props.klinePeriod));

/** 统计口径提示：窗口根数按实际周期标注（480 根日K ≈ 2 年，周K/分钟K 含义不同） */
const periodHint = computed(() => {
  const label = getPeriodMeta(props.klinePeriod).label;
  const bars = Math.min(CHIP_MAX_BARS, props.klineData?.length || 0);
  const base = `统计口径：最近 ${bars} 根 K 线（${label}）的价格成交分布`;
  const tr = chipResult.value?.decayTurnoverRate;
  return chipResult.value?.decayed
    ? `${base} + 换手率衰减（衰减系数 1${tr != null ? `，按最新换手率 ${tr}% 折算历史筹码留存` : ""}）`
    : `${base}（未做换手率衰减：仅日K且取到换手率时启用）`;
});

/** 自动计算筹码分布 */
function compute() {
  if (!props.klineData || props.klineData.length < 5) {
    chipResult.value = null;
    return;
  }
  chipResult.value = calcChipDistribution(props.klineData, chipOptions.value);
}

watch(
  () => [props.klineData, chipOptions.value],
  () => {
    if (props.show) {
      nextTick(compute);
    }
  },
  { deep: true }
);

watch(() => props.show, (val) => {
  if (val) {
    nextTick(compute);
  }
});

/** 分布数据（已反转：高价在上） */
const displayData = computed(() => {
  const r = chipResult.value;
  if (!r) return [];
  return [...r.distribution].reverse();
});

/** 最大比例（用于条形图宽度比例） */
const maxRatio = computed(() => {
  const r = chipResult.value;
  if (!r) return 1;
  return r.peakRatio * 1.15; // 留 15% 余量
});

/** 当前价 */
const currentPrice = computed(() => chipResult.value?.currentPrice ?? 0);

/** 平均成本 */
const avgCost = computed(() => {
  const r = chipResult.value;
  if (!r) return null;
  return r.avgCost;
});

/** 获利比例 */
const profitRatio = computed(() => {
  const r = chipResult.value;
  if (!r || !r.distribution.length) return 0;
  const cur = r.currentPrice;
  let profit = 0;
  let total = 0;
  for (const d of r.distribution) {
    if (d.price < cur) profit += d.ratio;
    total += d.ratio;
  }
  return total > 0 ? (profit / total) * 100 : 0;
});

/** 套牢比例 */
const lossRatio = computed(() => {
  return Math.max(0, 100 - profitRatio.value);
});

/** COST 分位数展示 */
const costEntries = computed(() => {
  const r = chipResult.value;
  if (!r) return [];
  return [
    { label: "90% 筹码", low: r.costLevels?.COST5, high: r.costLevels?.COST95 },
    { label: "70% 筹码", low: r.costLevels?.COST15, high: r.costLevels?.COST85 },
  ].filter((c) => c.low != null && c.high != null);
});

/** 活跃筹码集中度（70% 集中度） */
const concentration70 = computed(() => {
  const c = costEntries.value[1];
  if (!c || !c.high || !c.low || !currentPrice.value) return null;
  return (((c.high - c.low) / (c.high + c.low)) * 100).toFixed(1);
});

function formatPrice(v) {
  if (v == null) return "--";
  return v.toFixed(2);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="closeModal">
      <div class="modal-container">
        <!-- 头部 -->
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="chip-icon">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="3" height="12" rx="0.5" fill="currentColor" opacity="0.5"/>
                <rect x="6.5" y="4" width="3" height="10" rx="0.5" fill="currentColor" opacity="0.75"/>
                <rect x="11" y="6" width="3" height="8" rx="0.5" fill="currentColor"/>
              </svg>
            </span>
            <span class="modal-title">筹码分布</span>
            <span class="modal-badge" v-if="chipResult">{{ formatPrice(chipResult.currentPrice) }}</span>
          </div>
          <button class="btn-close" @click="closeModal">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- 摘要信息 -->
        <div class="chip-summary" v-if="chipResult">
          <div class="chip-stat">
            <span class="chip-stat-label">平均成本</span>
            <span class="chip-stat-value">{{ formatPrice(avgCost) }}</span>
          </div>
          <div class="chip-stat">
            <span class="chip-stat-label">筹码峰</span>
            <span class="chip-stat-value peak">{{ formatPrice(chipResult.peakPrice) }}</span>
          </div>
          <div class="chip-stat">
            <span class="chip-stat-label" style="color: var(--red)">获利</span>
            <span class="chip-stat-value" style="color: var(--red)">{{ profitRatio.toFixed(1) }}%</span>
          </div>
          <div class="chip-stat">
            <span class="chip-stat-label" style="color: var(--green)">套牢</span>
            <span class="chip-stat-value" style="color: var(--green)">{{ lossRatio.toFixed(1) }}%</span>
          </div>
          <!-- 集中度 -->
          <div class="chip-stat" v-if="concentration70">
            <span class="chip-stat-label">70% 集中度</span>
            <span
              class="chip-stat-value"
              :style="{ color: parseFloat(concentration70) > 20 ? 'var(--red)' : 'var(--green)' }"
            >{{ concentration70 }}%</span>
          </div>
        </div>

        <!-- 内容区 -->
        <div class="modal-body">
          <p v-if="chipResult" class="period-hint">{{ periodHint }}</p>
          <!-- 加载状态 -->
          <div v-if="loading" class="state-msg">
            <span>计算中...</span>
          </div>

          <!-- 空状态 -->
          <div v-else-if="!chipResult" class="state-msg">
            <p class="state-title">数据不足</p>
            <p class="state-hint">当前周期 K 线不足 5 根，无法计算筹码分布</p>
          </div>

          <!-- 条形图 -->
          <template v-else>
            <div class="chart-bars">
              <div
                v-for="(item, i) in displayData"
                :key="i"
                class="bar-row"
                :class="{ 'is-peak': item.price === chipResult?.peakPrice }"
              >
                <span class="bar-price">{{ formatPrice(item.price) }}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    :class="item.price >= currentPrice ? 'bar-trapped' : 'bar-profit'"
                    :style="{ width: (item.ratio / maxRatio) * 100 + '%' }"
                  ></div>
                  <span
                    v-if="item.price === chipResult?.peakPrice"
                    class="bar-peak-marker"
                  >峰</span>
                </div>
                <span class="bar-ratio">{{ (item.ratio * 100).toFixed(1) }}%</span>
              </div>
            </div>

            <!-- COST 分位 -->
            <div class="cost-section">
              <span class="cost-section-title">筹码成本分位</span>
              <div class="cost-grid">
                <div class="cost-item" v-for="entry in costEntries" :key="entry.label">
                  <span class="cost-label">{{ entry.label }}</span>
                  <span class="cost-range">{{ formatPrice(entry.low) }} ~ {{ formatPrice(entry.high) }}</span>
                </div>
              </div>
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

/* ChipDistribution 特有覆盖 */
.modal-container {
  width: 540px;
  max-height: 640px;
}

.modal-header {
  padding: 20px 24px 0;
  border-bottom: none;
}

.modal-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chip-icon {
  color: var(--text-primary);
  display: flex;
  align-items: center;
}

.modal-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.modal-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 6px;
  background: var(--fog);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}



/* ===== 摘要统计 ===== */
.chip-summary {
  display: flex;
  gap: 20px;
  padding: 14px 24px 12px;
  border-bottom: 1px solid var(--border-light);
  flex-wrap: wrap;
}

.chip-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chip-stat-label {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.chip-stat-value {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.chip-stat-value.peak {
  color: #7c3aed;
}

/* ===== 内容区 ===== */
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0 16px;
}

.state-msg {
  padding: 48px 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
}

.state-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}

.state-hint {
  font-size: 12px;
  color: var(--dove);
}

/* ===== 条形图 ===== */
.chart-bars {
  padding: 4px 24px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 20px;
  margin-bottom: 1px;
  position: relative;
}

.bar-price {
  width: 56px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.bar-track {
  flex: 1;
  height: 14px;
  background: var(--fog);
  border-radius: 3px;
  overflow: visible;
  position: relative;
  min-width: 60px;
}

.bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
  min-width: 2px;
}

.bar-profit {
  background: linear-gradient(90deg, rgba(231, 76, 60, 0.35), rgba(231, 76, 60, 0.85));
}

.bar-trapped {
  background: linear-gradient(90deg, rgba(39, 174, 96, 0.35), rgba(39, 174, 96, 0.85));
}

.bar-row.is-peak .bar-fill {
  background: linear-gradient(90deg, rgba(124, 58, 237, 0.4), rgba(124, 58, 237, 0.9));
}

.bar-row.is-peak .bar-price {
  color: #7c3aed;
  font-weight: 700;
}

.bar-peak-marker {
  position: absolute;
  right: -6px;
  top: -12px;
  font-size: 9px;
  font-weight: 700;
  color: #7c3aed;
  background: rgba(124, 58, 237, 0.1);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
}

.bar-ratio {
  width: 42px;
  font-size: 10px;
  color: var(--text-muted);
  text-align: left;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ===== COST 分位 ===== */
.cost-section {
  padding: 12px 24px 4px;
  border-top: 1px solid var(--border-light);
  margin-top: 8px;
}

.cost-section-title {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.3px;
  margin-bottom: 8px;
}

.cost-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.cost-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cost-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
}

.cost-range {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
