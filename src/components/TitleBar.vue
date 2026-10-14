<script setup>
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();
function windowMinimize() { appWindow.minimize(); }
function windowToggleMax() { appWindow.toggleMaximize(); }
function windowClose() { appWindow.close(); }

const emit = defineEmits(["open-mini"]);
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div class="titlebar-left">
      <div class="titlebar-title">stock-analysis</div>
      <slot name="status" />
    </div>
    <div class="titlebar-controls">
      <button class="win-btn win-mini" @click="emit('open-mini')" title="迷你盯盘小窗 (置顶)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1"/>
          <rect x="3.8" y="6.2" width="4.4" height="4.4" fill="currentColor" opacity="0.55"/>
        </svg>
      </button>
      <button class="win-btn win-min" @click="windowMinimize" title="最小化">
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4" width="8" height="1" fill="currentColor"/></svg>
      </button>
      <button class="win-btn win-max" @click="windowToggleMax" title="最大化">
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1" fill="none"/></svg>
      </button>
      <button class="win-btn win-close" @click="windowClose" title="关闭">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 32px;
  background: var(--card-bg);
  flex-shrink: 0;
  user-select: none;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
}

.titlebar-title {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.titlebar-controls {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
  -webkit-app-region: no-drag;
}
.win-btn:hover {
  background: var(--fog);
  color: var(--text-primary);
}
.win-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
