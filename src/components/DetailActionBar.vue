<script setup>
/**
 * DetailActionBar.vue — 详情页操作按钮栏
 * 行业分析 / 技术分析 / 支撑阻力 / 筹码峰 / 均线提醒 / 价格提醒 / AI 分析 / 加自选
 * 所有操作通过 emit 上抛，弹窗与数据逻辑留在父组件
 */
defineProps({
  isHK: { type: Boolean, default: false },
  showSR: { type: Boolean, default: false },
  /** 启用的提醒总数（均线周期数 + 价格提醒数），按钮徽标用 */
  alertCount: { type: Number, default: 0 },
  selectedStock: { type: Object, default: null },
  /** 当前股票是否在自选 */
  inWatchlist: { type: Boolean, default: false },
});

const emit = defineEmits([
  "open-industry-modal",
  "open-tech-modal",
  "toggle-sr",
  "open-chip-modal",
  "open-money-flow",
  "open-alerts",
  "open-backtest-modal",
  "open-ai-modal",
  "toggle-watchlist",
]);
</script>

<template>
  <div class="action-bar">
    <button v-if="!isHK" class="btn btn-industry" @click="emit('open-industry-modal')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="8" width="3" height="6" rx="0.5"/>
        <rect x="6.5" y="5.5" width="3" height="8.5" rx="0.5"/>
        <rect x="11" y="3" width="3" height="11" rx="0.5"/>
      </svg>
      <span>行业分析</span>
    </button>
    <button class="btn btn-tech" @click="emit('open-tech-modal')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 14L14 2M2 14l4-1M2 14l1-4" stroke-linejoin="round"/>
        <circle cx="12" cy="4" r="1" fill="currentColor"/>
      </svg>
      <span>技术分析</span>
    </button>
    <button class="btn btn-sr" :class="{ active: showSR }" @click="emit('toggle-sr')">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="4" cy="4" r="1.5" fill="#27ae60"/>
        <circle cx="12" cy="8" r="1.5" fill="#e74c3c"/>
        <circle cx="7" cy="12" r="1.5" fill="#7c3aed"/>
      </svg>
      <span>支撑/阻力</span>
    </button>
    <button class="btn btn-chip" @click="emit('open-chip-modal')">
      <svg width="18" height="18" viewBox="0 0 20 18" fill="none">
        <path d="M1 16 6 9l3.5 3L14 3l5 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="14" cy="3" r="2.8" fill="currentColor" opacity="0.85"/>
        <path d="M1 16h18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <span>筹码峰</span>
    </button>
    <button class="btn btn-money" @click="emit('open-money-flow')">
      <svg width="16" height="16" viewBox="0 0 20 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 16 6 9l3.5 3L14 3l5 13"/>
      </svg>
      <span>资金流向</span>
    </button>
    <button class="btn btn-alerts" :class="{ active: alertCount > 0 }" @click="emit('open-alerts')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10 20a2 2 0 0 0 4 0" stroke-linecap="round"/>
      </svg>
      <span>提醒</span>
      <span v-if="alertCount > 0" class="ma-badge">{{ alertCount }}</span>
    </button>
    <button class="btn btn-backtest" @click="emit('open-backtest-modal')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M2 13V3M2 13h12"/>
        <path d="M4.5 10.5 7 7.5l2 1.5L13 4"/>
      </svg>
      <span>信号回测</span>
    </button>
    <button class="btn btn-ai" @click="emit('open-ai-modal')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L14.09 8.26L20 9.27L15.5 13.97L16.82 20L12 16.77L7.18 20L8.5 13.97L4 9.27L9.91 8.26L12 2Z" fill="currentColor" stroke="currentColor" stroke-width="0.5"/>
      </svg>
      <span>AI 分析</span>
    </button>
    <button
      class="btn btn-ghost"
      :class="{ 'in-watchlist': inWatchlist }"
      @click="selectedStock && emit('toggle-watchlist', selectedStock)"
    >
      {{ inWatchlist ? "✓ 已自选" : "+ 加自选" }}
    </button>
  </div>
</template>

<style scoped>
/* ===== Steep: 操作按钮 ===== */
.action-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.btn {
  padding: 10px 24px;
  border: none;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  letter-spacing: -0.009em;
}

/* Steep: Primary CTA — Rust fill, full round */
.btn-industry {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--rust);
  color: #fff;
  box-shadow: var(--shadow-card);
}
.btn-industry:hover {
  background: #4a2215;
  box-shadow: var(--shadow-elevated);
}

/* Steep: Secondary filled CTA — Ink fill */
.btn-tech {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--ink);
  color: #fff;
  box-shadow: var(--shadow-card);
}
.btn-tech:hover {
  background: #2a2d30;
  box-shadow: var(--shadow-elevated);
}

/* Steep: Ghost button — 1px ink border */
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
.btn-ghost:hover {
  border-color: var(--ink);
  color: var(--ink);
}
.btn-ghost.in-watchlist {
  color: var(--green);
  border-color: var(--green);
}
.btn-ghost.in-watchlist:hover {
  color: var(--red);
  border-color: var(--red);
}

/* Steep: SR toggle — ghost style */
.btn-sr {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.btn-sr:hover {
  border-color: var(--ink);
  color: var(--ink);
}
.btn-sr.active {
  background: var(--apricot-wash);
  border-color: var(--rust);
  color: var(--rust);
}

/* Steep: 筹码峰按钮 — 山峰图标 + Purple 色调 */
.btn-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(124, 58, 237, 0.08);
  color: #7c3aed;
  border: 1px solid rgba(124, 58, 237, 0.35);
  box-shadow: var(--shadow-card);
}
.btn-chip:hover {
  background: #7c3aed;
  color: #fff;
  border-color: #7c3aed;
  box-shadow: var(--shadow-elevated);
}

/* Steep: AI 分析按钮 — 星形图标 + Rust 色 */
.btn-ai {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--apricot-wash);
  color: var(--rust);
  border: 1px solid var(--rust);
  box-shadow: var(--shadow-card);
}
.btn-ai:hover {
  background: var(--rust);
  color: #fff;
  box-shadow: var(--shadow-elevated);
}

/* Steep: 资金流向按钮 — 折线图标 + Ghost 风格 */
.btn-money {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  transition: all 0.15s;
  position: relative;
}
.btn-money:hover {
  border-color: var(--ink);
  color: var(--ink);
}

/* Steep: 信号回测按钮 — 折线统计图标 + Ghost 风格，悬停转 sky 色调 */
.btn-backtest {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
.btn-backtest:hover {
  background: var(--sky-wash);
  border-color: var(--ink);
  color: var(--ink);
}

/* Steep: 提醒按钮（均线+价格合并）— 铃铛图标 + Ghost 风格，启用时橙色高亮 */
.btn-alerts {  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  transition: all 0.15s;
  position: relative;
}
.btn-alerts:hover {
  border-color: var(--ink);
  color: var(--ink);
}
.btn-alerts.active {
  background: var(--apricot-wash);
  border-color: var(--rust);
  color: var(--rust);
}

/* 已配置时显示周期数徽标 */
.ma-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: var(--rust);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

/* 宽窗口（>1200px）：按钮放大、间距更舒展（窄窗口保持紧凑） */
@media (min-width: 1201px) {
  .action-bar {
    gap: 14px;
  }
  .btn {
    padding: 12px 30px;
    font-size: 14px;
  }
}
</style>
