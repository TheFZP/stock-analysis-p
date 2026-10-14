<script setup>
import { ref, watch } from "vue";
import { useAiAnalysis } from "../composables/useAiAnalysis";
import AiApiKeySetup from "./ai/AiApiKeySetup.vue";
import AiChatMessages from "./ai/AiChatMessages.vue";
import AiChatFooter from "./ai/AiChatFooter.vue";
import AiModelControls from "./ai/AiModelControls.vue";
import { calcChipDistribution, chipOptionsFromQuote } from "../composables/useChipDistribution";
import { calcMACD, calcKDJ, calcRSI, calcWR, calcMATrend, getCrossSignal } from "../composables/useTechIndicators";

const props = defineProps({
  show: { type: Boolean, default: false },
  selectedStock: { type: Object, default: null },
  klineData: { type: Array, default: null },
  klinePeriod: { type: String, default: "day" },
  moneyFlow: { type: Object, default: null },
  industryData: { type: Object, default: null },
  indices: { type: Array, default: null },
  positions: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "add-watchlist", "view-stock"]);

const {
  messages,
  loading,
  error,
  apiKey,
  setApiKey,
  sendMessage,
  clearHistory,
  switchStock,
} = useAiAnalysis();

// 弹窗打开或切换股票时加载对应对话
watch(() => props.show, (val) => {
  if (val && props.selectedStock) {
    switchStock(props.selectedStock.code);
  }
});

watch(() => props.selectedStock?.code, (newCode) => {
  // 流式生成中不切换对话（useAiAnalysis 内部有代际守卫保证不崩溃，
  // 但主动跳过可避免在途回答被静默丢弃）
  if (props.show && newCode && !loading.value) {
    switchStock(newCode);
  }
});

const inputText = ref("");
const showApiKeyInput = ref(!apiKey.value);
const apiKeyInput = ref(apiKey.value);

watch(
  () => props.show,
  (val) => {
    if (val) {
      showApiKeyInput.value = !apiKey.value;
      apiKeyInput.value = apiKey.value;
    }
  }
);

function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  setApiKey(key);
  showApiKeyInput.value = false;
}

function closeModal() {
  emit("close");
}

async function handleSend() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;
  inputText.value = "";

  try {
    const chipData = calcChipDistribution(
      props.klineData || [],
      chipOptionsFromQuote(props.selectedStock, props.klinePeriod)
    );
    const contextData = {
      klineData: props.klineData,
      // 周期口径随数据一起传：klineData 是共享且可切换周期的序列（见 utils/klinePeriod.js）
      klinePeriod: props.klinePeriod,
      moneyFlow: props.moneyFlow,
      industryData: props.industryData,
      indices: props.indices,
      chipData,
      positions: props.positions,
      // 预计算技术指标：系统算好最新值/信号注入上下文，避免模型手算 EMA 递归出错
      indicators: calcIndicators(props.klineData),
    };
    await sendMessage(text, props.selectedStock, contextData);
  } catch (e) {
    if (e.message === "NO_API_KEY") {
      showApiKeyInput.value = true;
    }
  }
}

/**
 * 预计算技术指标（最新值 + 交叉信号）
 * 返回 null 表示 K 线数据不足，不注入
 */
function calcIndicators(klineData) {
  if (!klineData || klineData.length < 26) return null;
  const closes = klineData.map((k) => k.close);
  const macdArr = calcMACD(closes);
  const kdjArr = calcKDJ(klineData);
  const rsiArr = calcRSI(closes);
  const wrArr = calcWR(klineData);
  const ma = calcMATrend(closes);
  const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    均线: Object.fromEntries(Object.entries(ma).map(([k, v]) => [`MA${k}`, round2(v)])),
    MACD: macdArr.length
      ? { DIF: round2(macdArr[macdArr.length - 1].dif), DEA: round2(macdArr[macdArr.length - 1].dea), 柱: round2(macdArr[macdArr.length - 1].macd), 信号: getCrossSignal(macdArr, "dif", "dea") || "无" }
      : null,
    KDJ: kdjArr.length
      ? (() => { const v = kdjArr[kdjArr.length - 1]; return { K: round2(v.k), D: round2(v.d), J: round2(v.j) }; })()
      : null,
    RSI14: rsiArr.length ? round2(rsiArr[rsiArr.length - 1]) : null,
    WR14: wrArr.length ? round2(wrArr[wrArr.length - 1]) : null,
  };
}

function handleClear() {
  clearHistory();
}

function doSuggestion(text) {
  if (loading.value) return;
  inputText.value = text;
  handleSend();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="closeModal">
      <div class="modal-container">
        <!-- 头部 -->
        <div class="modal-header">
          <div class="modal-header-left">
            <span class="modal-title">AI</span>
            <span class="ai-badge">Agent</span>

            <span class="ctrl-divider"></span>

            <AiModelControls />
          </div>
          <div class="modal-header-actions">
            <button v-if="messages.length > 0" class="btn-close" @click="handleClear" title="清空对话">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 4h12M5 4V2.5A.5.5 0 015.5 2h5a.5.5 0 01.5.5V4M3 4l1 9.5a1 1 0 001 1h6a1 1 0 001-1L13 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button class="btn-close" @click="closeModal">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 主体 -->
        <div class="modal-body">
          <!-- 错误提示 -->
          <div v-if="error && !showApiKeyInput" class="error-banner">
            <span class="error-icon">⚠️</span>
            <span class="error-text">{{ error }}</span>
          </div>

          <!-- API Key 设置 -->
          <AiApiKeySetup
            v-if="showApiKeyInput"
            :api-key-input="apiKeyInput"
            @save="saveApiKey"
            @update:api-key-input="apiKeyInput = $event"
          />

          <!-- 对话区域 -->
          <AiChatMessages
            v-else
            :messages="messages"
            :loading="loading"
            :selected-stock="selectedStock"
            @suggestion="doSuggestion"
            @add-watchlist="emit('add-watchlist', $event)"
            @view-stock="emit('view-stock', $event)"
          />
        </div>

        <!-- 底部输入 -->
        <AiChatFooter
          v-if="!showApiKeyInput"
          :input-text="inputText"
          :disabled="loading || !selectedStock"
          :selected-stock="selectedStock"
          :loading="loading"
          @send="handleSend"
          @update:input-text="inputText = $event"
        />
      </div>
    </div>
  </Teleport>
</template>

<style>
@import "../assets/modal.css";
</style>

<style scoped>

/* AiAnalysisModal 特有样式：覆盖宽高（与 GlobalAiModal 保持一致） */
.modal-container {
  width: 900px;
  height: 680px;
}

</style>
