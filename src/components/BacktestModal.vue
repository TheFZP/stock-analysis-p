<script setup>
/**
 * BacktestModal.vue — 信号回测与胜率面板
 *
 * 数据源：本地历史库（Rust db.rs）沉淀的日 K；本地不足时自动补拉远端一次（落库为旁路）。
 * 口径：日线级规则 + 固定持有期 + 非重叠交易；日内信号（T+0/量价陷阱）需分时数据，暂不参与回测。
 */
import { ref, computed, watch } from "vue";
import { useSignalBacktest, HOLD_PERIODS, MIN_SAMPLE } from "../composables/useSignalBacktest.js";

const props = defineProps({
  show: { type: Boolean, default: false },
  stock: { type: Object, default: null },
});

const emit = defineEmits(["close"]);

const { loading, syncing, error, data, stats, load, loadStats } = useSignalBacktest();

/** 当前选中的持有期（交易日） */
const hold = ref(HOLD_PERIODS[1]);

/** 按当前持有期展开的规则统计（数据不足时为空数组） */
const rows = computed(() => {
  const res = data.value;
  if (!res?.rules?.length) return [];
  return res.rules.map((rule) => ({ ...rule, stat: rule.byPeriod[hold.value] || null }));
});

/** 按胜率降序的排序视图（样本不足的排后面，避免误导） */
const sortedRows = computed(() => {
  return [...rows.value].sort((a, b) => {
    const av = a.stat?.trades >= MIN_SAMPLE ? (a.stat.winRate ?? -1) : -1;
    const bv = b.stat?.trades >= MIN_SAMPLE ? (b.stat.winRate ?? -1) : -1;
    if (bv !== av) return bv - av;
    return (b.stat?.trades || 0) - (a.stat?.trades || 0);
  });
});

/** 本地库概况文本 */
const dbSummary = computed(() => {
  const s = stats.value;
  if (!s) return "";
  const size = s.sizeBytes > 0 ? ` (${(s.sizeBytes / 1024).toFixed(0)} KB)` : "";
  return `本地 K 线 ${s.klineRows} 行 / ${s.klineCodes} 只，行情快照 ${s.quoteRows} 行，信号 ${s.signalRows} 条，提醒 ${s.alertRows} 条${size}`;
});

function pctText(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 涨跌配色（红涨绿跌，仅用于数据展示） */
function pctColor(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return "var(--text-secondary)";
  return v > 0 ? "var(--red)" : "var(--green)";
}

/** 盈亏比 = 平均盈利 / |平均亏损| */
function payoffText(stat) {
  if (!stat?.trades || stat.avgWin == null || stat.avgLoss == null || stat.avgLoss === 0) return "—";
  const ratio = stat.avgWin / Math.abs(stat.avgLoss);
  return Number.isFinite(ratio) ? ratio.toFixed(2) : "—";
}

function winRateColor(v) {
  if (v == null) return "var(--text-muted)";
  if (v >= 55) return "var(--red)";
  if (v >= 45) return "var(--text-primary)";
  if (v >= 35) return "var(--text-secondary)";
  return "var(--green)";
}

async function reload(forceNetwork) {
  if (!props.stock?.code) return;
  await load(props.stock.code, { forceNetwork });
  loadStats();
}

// 打开时（或切换股票）加载；关闭不清理，便于快速来回切换
watch(
  () => [props.show, props.stock?.code],
  ([show]) => {
    if (show) {
      hold.value = HOLD_PERIODS[1];
      reload(false);
    }
  }
);

function switchHold(h) {
  hold.value = h;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-container">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="bt-icon">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <path d="M2 13V3M2 13h12"/>
                <path d="M4.5 10.5 7 7.5l2 1.5L13 4"/>
              </svg>
            </span>
            <span class="modal-title">信号回测</span>
            <span class="modal-badge" v-if="stock">{{ stock.name }} ({{ stock.code }})</span>
          </div>
          <button class="btn-close" @click="emit('close')">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="modal-body bt-body">
          <!-- 数据区间 + 本地库概况 -->
          <div class="bt-meta">
            <div class="bt-meta-line">
              <span v-if="data?.enough">
                回测区间 <b>{{ data.from }}</b> ~ <b>{{ data.to }}</b>，共 <b>{{ data.bars }}</b> 根日 K
                <span class="bt-warmup">（前 {{ Math.min(60, data.bars) }} 根用于指标预热）</span>
              </span>
              <span v-else-if="!loading && !error">历史样本不足，无法回测</span>
              <span v-else-if="loading">正在读取历史数据…</span>
            </div>
            <div class="bt-meta-line bt-muted" v-if="dbSummary">{{ dbSummary }}</div>
          </div>

          <!-- 持有期切换 + 同步 -->
          <div class="bt-toolbar">
            <div class="bt-holds">
              <span class="bt-toolbar-label">持有期</span>
              <button
                v-for="h in HOLD_PERIODS"
                :key="h"
                class="bt-hold"
                :class="{ active: hold === h }"
                @click="switchHold(h)"
              >{{ h }} 日</button>
            </div>
            <button class="bt-sync" :disabled="syncing || loading" @click="reload(true)">
              {{ syncing ? "同步中…" : "同步更多历史" }}
            </button>
          </div>

          <div v-if="error" class="bt-error">{{ error }}</div>

          <!-- 统计表 -->
          <table class="bt-table" v-if="sortedRows.length">
            <thead>
              <tr>
                <th class="col-name">规则</th>
                <th>信号</th>
                <th>样本</th>
                <th>胜率</th>
                <th>平均收益</th>
                <th>盈亏比</th>
                <th>最大回撤</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in sortedRows" :key="row.id">
                <td class="col-name">
                  <div class="bt-rule-name">{{ row.name }}</div>
                  <div class="bt-rule-hint">{{ row.hint }}</div>
                </td>
                <td class="num">{{ row.signalCount }}</td>
                <td class="num">{{ row.stat?.trades ?? 0 }}</td>
                <td class="num">
                  <template v-if="row.stat?.trades">
                    <div class="bt-winrate">
                      <span :style="{ color: winRateColor(row.stat.winRate) }">
                        {{ row.stat.winRate.toFixed(1) }}%
                      </span>
                      <span class="bt-bar">
                        <span class="bt-bar-fill" :style="{ width: `${Math.min(100, row.stat.winRate)}%` }"></span>
                      </span>
                    </div>
                    <div class="bt-low" v-if="row.stat.trades < MIN_SAMPLE">样本不足</div>
                  </template>
                  <span v-else class="bt-muted">—</span>
                </td>
                <td class="num" :style="{ color: pctColor(row.stat?.avgRet) }">
                  {{ pctText(row.stat?.avgRet) }}
                </td>
                <td class="num bt-strong">
                  {{ payoffText(row.stat) }}
                </td>
                <td class="num bt-muted">
                  {{ row.stat?.maxDrawdown == null ? "—" : `${row.stat.maxDrawdown.toFixed(2)}%` }}
                </td>
              </tr>
            </tbody>
          </table>

          <div v-else-if="!loading && !error && !data" class="bt-empty">
            本地与远端均未取到历史日 K 数据
          </div>

          <p class="bt-note">
            口径：信号日收盘买入、持有 N 个交易日后收盘卖出，<b>持有期内不重复开仓</b>（非重叠交易）；
            胜率 = 盈利笔数 / 总笔数，平均收益 = 单笔平均涨跌幅，盈亏比 = 平均盈利 / 平均亏损（等权、未计手续费与滑点）。
            样本少于 {{ MIN_SAMPLE }} 笔的结果仅供参考。
            当前版本仅回测<b>日线级</b>规则——T+0 / 量价陷阱等日内信号依赖分时数据，不在本表范围内。
            历史表现不代表未来收益，本面板不构成投资建议。
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
@import "../assets/modal.css";
</style>

<style scoped>
.modal-container {
  width: 860px;
}

.modal-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bt-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--sky-wash);
  color: var(--ink);
}

.modal-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--fog);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}

.bt-body {
  padding: 20px 24px 24px;
  overflow-y: auto;
}

/* ---- 元信息 ---- */
.bt-meta {
  margin-bottom: 14px;
}

.bt-meta-line {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.bt-meta-line b {
  color: var(--text-primary);
  font-weight: 600;
}

.bt-warmup {
  color: var(--text-muted);
  font-size: 12px;
}

.bt-muted {
  color: var(--text-muted);
}

/* ---- 工具条 ---- */
.bt-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.bt-holds {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bt-toolbar-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-right: 2px;
}

.bt-hold {
  padding: 5px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.bt-hold:hover {
  border-color: var(--ink);
  color: var(--ink);
}

.bt-hold.active {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}

.bt-sync {
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.bt-sync:hover:not(:disabled) {
  background: var(--apricot-wash);
  border-color: var(--rust);
  color: var(--rust);
}

.bt-sync:disabled {
  opacity: 0.55;
  cursor: default;
}

.bt-error {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--fog);
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 14px;
}

/* ---- 统计表 ---- */
.bt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.bt-table th {
  text-align: right;
  font-weight: 600;
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.bt-table th.col-name {
  text-align: left;
}

.bt-table td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.bt-table tr:last-child td {
  border-bottom: none;
}

.bt-table td.num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.col-name {
  min-width: 210px;
}

.bt-strong {
  font-weight: 600;
  color: var(--text-primary);
}

.bt-rule-name {
  font-weight: 600;
  color: var(--text-primary);
}

.bt-rule-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.5;
}

/* ---- 胜率条 ---- */
.bt-winrate {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.bt-bar {
  width: 56px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--fog);
  overflow: hidden;
  flex: none;
}

.bt-bar-fill {
  display: block;
  height: 100%;
  background: var(--ink);
}

.bt-low {
  font-size: 11px;
  color: var(--rust);
  margin-top: 2px;
}

.bt-empty {
  padding: 32px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.bt-note {
  margin: 18px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-muted);
}

.bt-note b {
  color: var(--text-secondary);
  font-weight: 600;
}
</style>
