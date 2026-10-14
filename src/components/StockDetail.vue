<script setup>
import KlineChart from "./KlineChart.vue";
import IntradayChart from "./IntradayChart.vue";
import MoneyFlowModal from "./MoneyFlowModal.vue";
import AlertsModal from "./AlertsModal.vue";
import DetailActionBar from "./DetailActionBar.vue";
import DataFreshness from "./DataFreshness.vue";
import { signChar } from "../utils/format";
import { isDayPeriod } from "../utils/klinePeriod.js";
import { recordSignalEvents } from "../utils/history.js";
import { useT0Signals } from "../composables/useT0Signals.js";
import { useMaAlerts } from "../composables/useMaAlerts.js";
import { usePriceAlerts } from "../composables/usePriceAlerts.js";
import { ref, computed, watch } from "vue";

const props = defineProps({
  selectedStock: { type: Object, default: null },
  watchlist: { type: Array, default: () => [] },
  klineData: { type: Array, default: null },
  klineLoading: { type: Boolean, default: false },
  klinePeriod: { type: String, default: "day" },
  intradayData: { type: Object, default: null },
  intradayLoading: { type: Boolean, default: false },
  moneyFlow: { type: Object, default: null },
  moneyFlowLoading: { type: Boolean, default: false },
  moneyFlowHistory: { type: Array, default: null },
  moneyFlowHistoryLoading: { type: Boolean, default: false },
  watchlistMarkers: { type: Array, default: () => [] },
  // 数据新鲜度：最近一次成功时间（ms，0=未获取）与最近一次刷新是否失败（展示旧数据）
  quoteFetchedAt: { type: Number, default: 0 },
  quoteStale: { type: Boolean, default: false },
  klineFetchedAt: { type: Number, default: 0 },
  klineStale: { type: Boolean, default: false },
  intradayFetchedAt: { type: Number, default: 0 },
  intradayStale: { type: Boolean, default: false },
});

const emit = defineEmits([
  "toggle-watchlist",
  "change-kline-period",
  "open-industry-modal",
  "open-tech-modal",
  "open-ai-modal",
  "open-chip-modal",
  "open-backtest-modal",
  "load-intraday",
  "retry-quote",
  "retry-kline",
  "retry-intraday",
]);

const chartMode = ref("intraday"); // "kline" | "intraday"
const showSR = ref(false);
const klineChartRef = ref(null);

/** 均线提醒配置（合并弹窗「均线提醒」Tab 用） */
const { getConfig: getMaConfig } = useMaAlerts();

/** 价格提醒数量（合并弹窗「价格提醒」Tab 用） */
const { countEnabledForCode: countPriceAlerts } = usePriceAlerts();

/** 合并提醒弹窗 / 资金流向弹窗 */
const showAlertsModal = ref(false);
const showMoneyFlowModal = ref(false);

/** 当前股票是否已配置均线提醒（合并按钮徽标用） */
const maAlertActive = computed(() =>
  props.selectedStock ? getMaConfig(props.selectedStock.code) : null
);

/** 当前股票启用中的价格提醒数量（合并按钮徽标用） */
const priceAlertCount = computed(() =>
  props.selectedStock ? countPriceAlerts(props.selectedStock.code) : 0
);

/** 提醒按钮徽标：均线周期数 + 价格提醒数 */
const alertCount = computed(
  () => (maAlertActive.value?.periods?.length || 0) + priceAlertCount.value
);

/** 港股识别与货币符号 */
const isHK = computed(() => {
  const stock = props.selectedStock;
  if (!stock) return false;
  return stock.market === "HK" || (stock.code && stock.code.length === 5);
});
const currencySymbol = computed(() => isHK.value ? "HK$" : "¥");

/** T+0 信号系统 */
const { signalMarkers, summary: t0Summary, compute: computeT0Signals } = useT0Signals();

// 当分时数据、K线数据或图表周期变化时重新计算信号
// 注意：compute 是异步的（非日K周期需取日K缓存做趋势/背离），必须 await 后再落库，
// 否则 t0Summary 还是 null，信号事件会被静默丢掉
watch(
  [() => props.klineData, () => props.intradayData, () => props.selectedStock, () => props.klinePeriod],
  async ([kline, intraday, stock, period]) => {
    if (intraday && intraday.items && intraday.items.length > 0) {
      // 信号分析为尽力而为的辅助功能：内部异常不得打断组件更新队列
      // （历史教训：一次未捕获异常会级联打崩整个渲染周期）
      try {
        await computeT0Signals(kline, intraday, stock, period);
        // 只落"事件型"信号（日内量价陷阱 / 放量异动）：带时间锚点，后端按
        // (code, 日期, 类型, 名称, 时间) 去重，重复计算不会产生重复行
        if (stock?.code) {
          recordSignalEvents(stock.code, "trap", t0Summary.value?.signals);
          recordSignalEvents(stock.code, "volume", t0Summary.value?.raw?.volumeSignals);
        }
      } catch (e) {
        console.error("计算 T+0/量价陷阱信号失败:", e);
      }
    }
  },
  { immediate: true, deep: false }
);

function handleToggleSR() {
  showSR.value = !showSR.value;
  klineChartRef.value?.toggleSR();
}

function switchChartMode(mode) {
  if (mode === chartMode.value) return;
  chartMode.value = mode;




  if (mode === "intraday") {
    emit("load-intraday");
  }
}

function isInWatchlist(code) {
  return props.watchlist.some((s) => s.code === code);
}

/** 自选以来涨跌幅 */
const sinceAddedPct = computed(() => {
  const stock = props.selectedStock;
  const klines = props.klineData;
  if (!stock?.addedAt) return null;
  const currentPrice = stock.price;
  if (!currentPrice || currentPrice === 0) return null;
  // 优先使用加入自选时记录的价格
  if (stock.addedPrice && stock.addedPrice > 0) {
    return ((currentPrice - stock.addedPrice) / stock.addedPrice) * 100;
  }
  // 回退：从 K 线中找加入自选当日的收盘价
  // 只有日K的 date 才等于「某交易日」，周/月/分钟K 的 date 撞上 addedAt 会取到错误收盘价
  if (!isDayPeriod(props.klinePeriod)) return null;
  if (!klines || !Array.isArray(klines) || klines.length === 0) return null;
  const addedKline = klines.find((k) => k.date === stock.addedAt);
  if (!addedKline?.close || addedKline.close === 0) return null;
  return ((currentPrice - addedKline.close) / addedKline.close) * 100;
});
</script>

<template>
  <main class="main-content">
    <section class="detail-card" v-if="selectedStock">
      <div class="stock-header">
        <div class="stock-tag" :class="selectedStock.change >= 0 ? 'up' : 'down'">
          <span class="tag-arrow">{{ selectedStock.change >= 0 ? "▲" : "▼" }}</span>
          <span class="tag-text">{{ selectedStock.change >= 0 ? "上涨" : "下跌" }}</span>
        </div>
        <div class="stock-identity">
          <h2 class="stock-name">{{ selectedStock.name }}</h2>
          <span class="stock-code">{{ selectedStock.code }}</span>
          <span v-if="isHK" class="market-badge market-hk">港股</span>
          <span
            v-if="sinceAddedPct != null"
            class="since-added"
            :class="sinceAddedPct >= 0 ? 'up' : 'down'"
          >
            {{ signChar(sinceAddedPct) }}{{ sinceAddedPct.toFixed(2) }}%
            <span class="since-added-label">自选以来</span>
          </span>
        </div>
      </div>

      <div class="price-area">
        <div class="price-main" :class="{ 'is-stale': quoteStale }">
          <span class="price" :class="selectedStock.change >= 0 ? 'up' : 'down'">
            {{ currencySymbol }}{{ selectedStock.price.toFixed(2) }}
          </span>
          <span class="price-change" :class="selectedStock.change >= 0 ? 'up' : 'down'">
            {{ signChar(selectedStock.change) }}{{ selectedStock.change.toFixed(2) }}
          </span>
          <span class="price-pct" :class="selectedStock.change >= 0 ? 'up' : 'down'">
            {{ signChar(selectedStock.changePct) }}{{ selectedStock.changePct.toFixed(2) }}%
          </span>
          <DataFreshness
            class="price-fresh"
            :at="quoteFetchedAt"
            :stale="quoteStale"
            label="行情"
            @retry="emit('retry-quote')"
          />
        </div>
      </div>

      <!-- 图表切换标签 -->
      <div class="chart-tabs">
        <button
          class="chart-tab"
          :class="{ active: chartMode === 'kline' }"
          @click="switchChartMode('kline')"
        >K 线</button>
        <button
          class="chart-tab"
          :class="{ active: chartMode === 'intraday' }"
          @click="switchChartMode('intraday')"
        >分时</button>
      </div>

      <!-- K 线图 -->
      <div v-show="chartMode === 'kline'" class="kline-flex-wrap">
        <KlineChart
          ref="klineChartRef"
          :data="klineData"
          :loading="klineLoading"
          :period="klinePeriod"
          :markers="watchlistMarkers"
          :show-sr="showSR"
          :code="selectedStock?.code ?? ''"
          :fetched-at="klineFetchedAt"
          :stale="klineStale"
          @change-period="emit('change-kline-period', $event)"
          @retry="emit('retry-kline')"
        />
      </div>

      <!-- 分时图 -->
      <div v-show="chartMode === 'intraday'" class="kline-flex-wrap">
        <IntradayChart
          :data="intradayData"
          :loading="intradayLoading"
          :signal-markers="signalMarkers"
          :code="selectedStock?.code ?? ''"
          :fetched-at="intradayFetchedAt"
          :stale="intradayStale"
          @retry="emit('retry-intraday')"
        />
      </div>

      <!-- 今开/最高/昨收/最低 已作为参考线叠加在分时图中（IntradayChart），此处只保留量额类指标 -->
            
            
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">成交量</span>
          <span class="meta-value">{{ selectedStock.volume != null ? (selectedStock.volume / 10000).toFixed(2) + ' 万手' : '--' }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">成交额</span>
          <span class="meta-value">{{ selectedStock.turnover != null ? (selectedStock.turnover / 10000).toFixed(2) + ' 亿' : '--' }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">换手率</span>
          <span class="meta-value">{{ selectedStock.turnoverRate != null ? selectedStock.turnoverRate.toFixed(2) + '%' : '--' }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">市盈率</span>
          <span class="meta-value">{{ selectedStock.pe?.toFixed(2) ?? '--' }}</span>
        </div>
      </div>

      <!-- 操作按钮栏 -->
      <DetailActionBar
        :is-hk="isHK"
        :show-sr="showSR"
        :alert-count="alertCount"
        :selected-stock="selectedStock"
        :in-watchlist="selectedStock && isInWatchlist(selectedStock.code)"
        @open-industry-modal="emit('open-industry-modal')"
        @open-tech-modal="emit('open-tech-modal')"
        @toggle-sr="handleToggleSR"
        @open-chip-modal="emit('open-chip-modal')"
        @open-money-flow="showMoneyFlowModal = true"
        @open-alerts="showAlertsModal = true"
        @open-backtest-modal="emit('open-backtest-modal')"
        @open-ai-modal="emit('open-ai-modal')"
        @toggle-watchlist="emit('toggle-watchlist', $event)"
      />
    </section>

    <!-- 空状态：未选中股票 -->
    <div v-else class="detail-empty">
      <svg width="56" height="56" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 42 20 28l8 7 12-16 8 9" />
        <path d="M8 42h40" opacity="0.4" />
        <circle cx="40" cy="12" r="5" opacity="0.5" />
      </svg>
      <p class="detail-empty-title">从左侧选择一只股票</p>
      <p class="detail-empty-sub">或按 Ctrl+K 搜索 · 问财选股窗口双击结果也可联动</p>
    </div>

    <!-- 资金流向弹窗（主力资金 + 分档 + T+0 信号 + 历史柱状图） -->
    <MoneyFlowModal
      :show="showMoneyFlowModal"
      :stock="selectedStock"
      :money-flow="moneyFlow"
      :money-flow-loading="moneyFlowLoading"
      :money-flow-history="moneyFlowHistory"
      :money-flow-history-loading="moneyFlowHistoryLoading"
      :t0-summary="t0Summary"
      :chart-mode="chartMode"
      @close="showMoneyFlowModal = false"
    />

    <!-- 合并提醒弹窗（均线提醒 / 价格提醒） -->
    <AlertsModal
      :show="showAlertsModal"
      :stock="selectedStock"
      :kline-data="klineData"
      :kline-period="klinePeriod"
      @close="showAlertsModal = false"
    />
  </main>

</template>

<style scoped>
/* ===== Steep: 详情区 ===== */
.main-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* ===== Steep: 详情卡片 — 24px 圆角 ===== */
.detail-card {
  background: var(--card-bg);
  border-radius: var(--radius-lg);
  padding: 28px 32px;
  box-shadow: var(--shadow-card);
  min-height: 100%;
  display: flex;
  flex-direction: column;
  /* 窗口变矮时不压缩卡片，内容超出时由 .main-content 滚动 */
  flex-shrink: 0;
}

/* 窗口缩小时压缩详情卡内边距 */
@media (max-width: 1280px) {
  .detail-card {
    padding: 20px 24px;
  }
}

@media (max-width: 1024px) {
  .detail-card {
    padding: 14px 16px;
  }
}

.stock-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.stock-tag {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 14px;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 600;
}

/* 中国 A 股标准：红涨绿跌 */
.stock-tag.up {
  color: var(--red);
  background: var(--red-bg);
}

.stock-tag.down {
  color: var(--green);
  background: var(--green-bg);
}

.tag-arrow {
  font-size: 12px;
}

.stock-identity {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stock-name {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

.stock-code {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
}

/* 市场标签 */
.market-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: var(--radius-full);
}
.market-badge.market-hk {
  color: #b45309;
  background: #fef3c7;
}

/* 自选以来涨跌幅徽标 */
.since-added {
  font-size: 12px;
  font-weight: 700;
  padding: 3px 12px;
  border-radius: var(--radius-full);
  white-space: nowrap;
}
.since-added.up {
  color: var(--red);
  background: var(--red-bg);
}
.since-added.down {
  color: var(--green);
  background: var(--green-bg);
}
.since-added-label {
  font-weight: 500;
  opacity: 0.75;
  margin-left: 2px;
}

/* ===== 价格区域 ===== */
.price-area {
  margin-bottom: 24px;
}

.price-main {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}

/* 刷新失败：展示的是旧价格，整行转灰（角标处给出「更新失败 + 重试」） */
.price-main.is-stale {
  opacity: 0.55;
}

/* 角标按基线对齐会偏低，改为垂直居中 */
.price-fresh {
  align-self: center;
}

.price {
  font-size: 40px;
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.price.up { color: var(--red); }
.price.down { color: var(--green); }

.price-change {
  font-size: 18px;
  font-weight: 700;
}

.price-change.up { color: var(--red); }
.price-change.down { color: var(--green); }

.price-pct {
  font-size: 16px;
  font-weight: 600;
  padding: 3px 14px;
  border-radius: var(--radius-full);
}

.price-pct.up {
  color: var(--red);
  background: var(--red-bg);
}

.price-pct.down {
  color: var(--green);
  background: var(--green-bg);
}

/* ===== 四维数据网格 — 柔和卡片式 ===== */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 24px;
}

/* 窗口较窄时数据网格降为 2 列 */
@media (max-width: 1024px) {
  .meta-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .meta-grid {
    grid-template-columns: 1fr;
  }
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--fog);
}

.meta-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.meta-value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.meta-value.up { color: var(--red); }
.meta-value.down { color: var(--green); }

/* ===== 图表切换标签 — 胶囊分段控件 ===== */
.chart-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 12px;
  background: var(--bg);
  border-radius: var(--radius-full);
  padding: 3px;
  width: fit-content;
}

.chart-tab {
  padding: 6px 18px;
  border: none;
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
  letter-spacing: -0.01em;
}

.chart-tab.active {
  background: var(--card-bg);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.chart-tab:hover:not(.active) {
  color: var(--text-secondary);
}

/* ===== K 线弹性填充 ===== */
.kline-flex-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.kline-flex-wrap :deep(.kline-wrapper) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
}

.kline-flex-wrap :deep(.kline-chart-wrap) {
  flex: 1;
  min-height: 0;
  height: auto;
  max-height: 420px;
}

.kline-flex-wrap :deep(.kline-chart) {
  height: 100%;
  min-height: 200px;
}

/* ===== 宽窗口（>1200px）：右侧详情更舒展 =====
   内容够高时一屏展示、无滚动条；内容超高时自动出现滚动条 */
@media (min-width: 1201px) {
  .main-content {
    overflow-y: auto;
  }
  .detail-card {
    padding: 20px 28px;
  }
  .stock-header {
    margin-bottom: 14px;
  }
  .price-area {
    margin-bottom: 16px;
  }
  .price {
    font-size: 36px;
  }
  .chart-tabs {
    margin-bottom: 10px;
  }
  /* 宽窗口：图表区域固定高度，不再弹性拉伸占满剩余空间。
     图表高度受控（360px），底部信息栏紧贴图表完整显示，
     既不产生图表与信息栏之间的空白，也不会因图表过大挤压信息栏 */
  .kline-flex-wrap {
    flex: none;
  }
  .kline-flex-wrap :deep(.kline-wrapper) {
    flex: none;
  }
  .kline-flex-wrap :deep(.kline-chart-wrap) {
    flex: none;
    height: 480px;
    max-height: none;
  }
  .kline-flex-wrap :deep(.kline-chart) {
    min-height: 0;
  }
  .kline-flex-wrap :deep(.intraday-wrapper) {
    flex: none;
  }
  .kline-flex-wrap :deep(.intraday-chart-wrap) {
    flex: none;
    height: 480px;
    max-height: none;
  }
  .kline-flex-wrap :deep(.intraday-chart) {
    min-height: 0;
  }
  .meta-grid {
    margin-bottom: 18px;
  }
  .meta-item {
    padding: 12px 14px;
  }
}

/* ===== 空状态 ===== */
.detail-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  background: var(--card-bg);
}
.detail-empty svg {
  opacity: 0.4;
  margin-bottom: 10px;
}
.detail-empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
}
.detail-empty-sub {
  margin: 0;
  font-size: 12px;
  opacity: 0.8;
}
</style>
