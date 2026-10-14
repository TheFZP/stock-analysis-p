<script setup>
/**
 * 今日市场状态胶囊（标题栏）
 *
 * 显示单个市场（A 股 / 港股）的当前状态与倒计时。
 * 状态判定复用 utils/marketTime.js 的 getMarketStatus，与轮询口径同源 ——
 * 因此「胶囊显示开盘中」与「App 正在轮询」始终一致，不会出现口径分叉。
 *
 * 计时策略：盘中/午休 1 秒刷新（跑倒计时），盘外对齐到下一个整分钟唤醒
 *           （状态只会在分钟边界变化，最多 60 秒一次）。
 *           纯本地时间计算，不产生任何网络请求，符合「盘外零请求」的设计。
 * 交互：点击（或回车/空格）→ emit("refresh") 让上层刷新全部行情，刷新中显示「刷新中…」。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { getMarketStatus } from "../utils/marketTime.js";

const props = defineProps({
  /** "A" = A 股；"HK" = 港股（港股用 5 位代码触发港股时段/假期判定） */
  market: { type: String, default: "A" },
  /** 手动刷新进行中（点击胶囊触发，给出「刷新中…」反馈） */
  refreshing: { type: Boolean, default: false },
});

/** 点击胶囊 → 请求上层刷新全部行情（盘外也允许，语义同标题栏手动刷新） */
const emit = defineEmits(["refresh"]);

const now = ref(new Date());
let timer = null;

const isHk = computed(() => props.market === "HK");
const label = computed(() => (isHk.value ? "港股" : "A股"));
const status = computed(() => getMarketStatus(isHk.value ? "00700" : "", now.value));
const isLive = computed(() => status.value.state === "open" || status.value.state === "break");

const STATE_TEXT = {
  pre: "未开盘",
  open: "开盘中",
  break: "午间休市",
  post: "已收盘",
  holiday: "休市",
};

const stateText = computed(() => STATE_TEXT[status.value.state] || "");

/** 距收盘倒计时 "HH:mm:ss"（分钟粒度按分钟数、秒数取本地秒，避免额外计时器） */
const countdown = computed(() => {
  const left = status.value.minutesToClose;
  if (left === null) return "";
  const total = Math.max(0, left * 60 - now.value.getSeconds());
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
});

/** 胶囊右侧细节文案 */
const detail = computed(() => {
  const s = status.value;
  if (s.state === "open" || s.state === "break") return `距收盘 ${countdown.value}`;
  if (s.state === "pre") return `${s.openAt} 开盘`;
  if (s.state === "post") return `${s.closeAt} 收盘`;
  return s.holidayName;
});

/** 悬浮提示：完整时段 + 降级说明（日历未就绪时状态按工作日兜底） */
const tooltip = computed(() => {
  const s = status.value;
  const unknownHint = isHk.value
    ? "（港股假期表未收录该年份，暂按工作日判定）"
    : "（A 股交易日历未加载或未覆盖，暂按工作日判定）";
  const stateLine = s.state === "holiday" ? `${s.dateStr} 休市 · ${s.holidayName}` : `${s.dateStr} ${stateText.value}`;
  return `${label.value} ${stateLine}\n交易时段 ${s.openAt}-${s.morningEndAt} / ${s.resumeAt}-${s.closeAt}${
    s.dayUnknown ? `\n${unknownHint}` : ""
  }\n点击刷新全部行情`;
});

/** 刷新到当前时刻并按新状态重新排程 */
function tick() {
  now.value = new Date();
  schedule();
}

/**
 * 刷新节奏：盘中/午休 1 秒（跑倒计时）；盘外状态只会在分钟边界变化，
 * 因此直接对齐到下一个整分钟唤醒（最多 60 秒一次，且纯本地计算、不发请求）。
 */
function schedule() {
  stop();
  if (isLive.value) timer = setInterval(tick, 1000);
  else timer = setTimeout(tick, 60000 - (Date.now() % 60000));
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  clearTimeout(timer);
  timer = null;
}

onMounted(schedule);
onUnmounted(stop);
watch(isLive, schedule);
</script>

<template>
  <span
    class="ms-pill"
    :class="{ 'is-live': isLive, 'is-refreshing': refreshing }"
    :title="tooltip"
    role="button"
    tabindex="0"
    @click="emit('refresh')"
    @keydown.enter.prevent="emit('refresh')"
    @keydown.space.prevent="emit('refresh')"
  >
    <i class="ms-dot"></i>
    <span class="ms-market">{{ label }}</span>
    <span class="ms-text">{{ stateText }}</span>
    <span class="ms-detail">{{ refreshing ? "刷新中…" : detail }}</span>
  </span>
</template>

<style scoped>
.ms-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  background: var(--fog);
  white-space: nowrap;
  -webkit-app-region: no-drag;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.ms-pill:hover {
  background: var(--apricot-wash);
}

.ms-pill:focus-visible {
  outline: 1px solid var(--rust);
  outline-offset: 1px;
}

.ms-pill.is-refreshing {
  opacity: 0.7;
}

.ms-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dove);
  flex-shrink: 0;
}

.ms-market {
  font-size: 10px;
  color: var(--text-muted);
}

.ms-text {
  font-size: 10px;
  color: var(--text-secondary);
}

.ms-detail {
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.ms-pill.is-live .ms-dot {
  background: var(--rust);
  animation: ms-pulse 2s ease-in-out infinite;
}

.ms-pill.is-live .ms-text {
  color: var(--rust);
}

@keyframes ms-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
