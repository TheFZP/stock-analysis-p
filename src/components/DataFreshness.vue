<script setup>
/**
 * 数据新鲜度角标
 *
 * 展示「数据 HH:mm」；刷新失败时提示「更新失败」并给出「重试」按钮。
 * 失败时数据不会被清空（行情/K 线/分时都保留上一份），因此必须靠角标让用户
 * 分清看到的是刚才的数据还是十几分钟前的数据。
 */
import { computed } from "vue";

const props = defineProps({
  /** 最近一次成功获取数据的时间戳（ms）；0 = 尚未成功获取过 */
  at: { type: Number, default: 0 },
  /** 最近一次刷新失败：当前展示的是旧数据（或没有数据） */
  stale: { type: Boolean, default: false },
  /** 数据类型名（角标与悬浮提示用），如「行情」「K 线」「分时」 */
  label: { type: String, default: "数据" },
});

const emit = defineEmits(["retry"]);

/** 本地时区 "HH:mm" */
const timeText = computed(() => {
  if (!props.at) return "";
  const d = new Date(props.at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
});

const tooltip = computed(() => {
  if (props.stale) {
    return `${props.label}更新失败${
      timeText.value ? `，当前显示 ${timeText.value} 的数据` : ""
    }，点击「重试」重新获取`;
  }
  return timeText.value ? `${props.label}更新时间 ${timeText.value}` : `${props.label}尚未获取`;
});
</script>

<template>
  <span class="fresh" :class="{ 'is-stale': stale }" :title="tooltip">
    <span class="fresh-time">{{ timeText ? `${label} ${timeText}` : `${label} --` }}</span>
    <template v-if="stale">
      <span class="fresh-fail">更新失败</span>
      <button class="fresh-retry" type="button" @click="emit('retry')">重试</button>
    </template>
  </span>
</template>

<style scoped>
/* ===== Steep: 数据新鲜度角标 ===== */
.fresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  background: var(--fog);
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 失败转灰：数据仍是旧的一份，弱化整个角标 */
.fresh.is-stale {
  color: var(--slate);
  border-color: var(--border-light);
}

.fresh.is-stale .fresh-time {
  opacity: 0.75;
}

.fresh-fail {
  color: var(--graphite);
}

.fresh-retry {
  font: inherit;
  color: var(--rust);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}

.fresh-retry:hover {
  opacity: 0.7;
}
</style>
