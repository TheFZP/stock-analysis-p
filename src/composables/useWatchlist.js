import { ref, computed, watch } from "vue";
import { recordWatchlistChange } from "../utils/history";

const STORAGE_KEY = "stock-analysis-watchlist";

/** 默认股票池（仅作首次启动的种子数据，绝不可被运行时改动污染） */
const DEFAULT_STOCKS = [
  { code: "300750", name: "宁德时代", market: "SZ", price: 256.80, change: -3.12, changePct: -1.20 },
];

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 注意：空数组是用户的真实意图（已清空自选），不能当作"无数据"重新塞回默认股票
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* ignore */ }
  // 返回默认股票池的深拷贝：避免行情刷新写回时污染模块级常量
  return DEFAULT_STOCKS.map((s) => ({ ...s }));
}

/**
 * 自选股状态管理（含 localStorage 持久化）
 */
export function useWatchlist() {
  const watchlist = ref(loadWatchlist());
  const searchQuery = ref("");
  const selectedStock = ref(watchlist.value[0] || null);

  // 持久化（隐私模式/quota 满时静默忽略，与项目其他存储一致）
  watch(watchlist, (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
    } catch { /* ignore quota/security errors */ }
  }, { deep: true });

  const filteredWatchlist = computed(() => {
    if (!searchQuery.value.trim()) return watchlist.value;
    const q = searchQuery.value.trim().toUpperCase();
    return watchlist.value.filter(
      (s) => s.code.includes(q) || s.name.includes(q)
    );
  });

  function selectStock(stock) {
    selectedStock.value = stock;
    searchQuery.value = "";
  }

  function isInWatchlist(code) {
    return watchlist.value.some((s) => s.code === code);
  }

  function addToWatchlist(stock) {
    if (!stock || isInWatchlist(stock.code)) return;
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    watchlist.value = [
      ...watchlist.value,
      {
        ...stock,
        addedAt: `${y}-${m}-${d}`,
        // 记录加入自选时的当前价格（搜索/问财添加时可能为 0，稍后由首次行情回填）
        addedPrice: stock.price > 0 ? stock.price : undefined,
      },
    ];
    recordWatchlistChange("add", stock.code, stock.name);
  }

  function removeFromWatchlist(code) {
    const removed = watchlist.value.find((s) => s.code === code);
    watchlist.value = watchlist.value.filter((s) => s.code !== code);
    if (removed) recordWatchlistChange("remove", code, removed.name);
    if (selectedStock.value?.code === code) {
      selectedStock.value = watchlist.value[0] || null;
    }
  }

  function toggleWatchlist(stock) {
    if (isInWatchlist(stock.code)) {
      removeFromWatchlist(stock.code);
    } else {
      addToWatchlist(stock);
    }
  }

  /** 更新列表中某只股票的实时数据 */
  function updateWatchlistQuote(code, quoteData) {
    // 加入时未记录到价格（如从搜索/问财添加），用首次拿到的实时行情回填
    const fetchedPrice = quoteData.price > 0 ? quoteData.price : undefined;
    const idx = watchlist.value.findIndex((s) => s.code === code);
    if (idx !== -1) {
      const cur = watchlist.value[idx];
      watchlist.value[idx] = {
        ...cur,
        ...quoteData,
        addedPrice: cur.addedPrice != null ? cur.addedPrice : fetchedPrice,
      };
      watchlist.value = [...watchlist.value];
    }
    if (selectedStock.value?.code === code) {
      selectedStock.value = {
        ...selectedStock.value,
        ...quoteData,
        addedPrice:
          selectedStock.value.addedPrice != null ? selectedStock.value.addedPrice : fetchedPrice,
      };
    }
  }

  return {
    watchlist,
    searchQuery,
    selectedStock,
    filteredWatchlist,
    selectStock,
    isInWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    toggleWatchlist,
    updateWatchlistQuote,
  };
}
