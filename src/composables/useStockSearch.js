import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

/**
 * 股票搜索逻辑（含防抖），与 StockList 解耦
 */
export function useStockSearch(getWatchlist) {
  const searchQuery = ref("");
  const searchResults = ref([]);
  const showResults = ref(false);
  const searching = ref(false);
  let debounceTimer = null;
  let blurTimer = null;
  // 请求序号：只接受最后一次请求的结果，防止旧关键词的慢响应覆盖新结果
  let searchSeq = 0;

  function onSearchInput(e) {
    const val = e.target.value;
    searchQuery.value = val;

    if (debounceTimer) clearTimeout(debounceTimer);

    if (val.trim().length === 0) {
      // 清空时使在途请求失效，避免已清空的输入框下方重新弹出旧结果
      searchSeq++;
      searchResults.value = [];
      showResults.value = false;
      return;
    }

    debounceTimer = setTimeout(() => doSearch(val.trim()), 300);
  }

  async function doSearch(keyword) {
    const seq = ++searchSeq;
    searching.value = true;
    showResults.value = true;
    try {
      const results = await invoke("search_stocks", { keyword });
      if (seq !== searchSeq) return; // 已被更新的请求取代，丢弃旧结果
      // 已存在的自选股排在后面
      results.sort((a, b) => {
        const aIn = getWatchlist().some((s) => s.code === a.code) ? 1 : 0;
        const bIn = getWatchlist().some((s) => s.code === b.code) ? 1 : 0;
        return aIn - bIn;
      });
      searchResults.value = results;
    } catch (e) {
      if (seq !== searchSeq) return;
      console.error("搜索失败:", e);
      searchResults.value = [];
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }

  function clearSearch() {
    // 取消挂起的防抖请求并失效在途请求
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    searchSeq++;
    searchQuery.value = "";
    searchResults.value = [];
    showResults.value = false;
  }

  function onSearchBlur() {
    if (blurTimer) { clearTimeout(blurTimer); }
    blurTimer = setTimeout(() => { showResults.value = false; }, 200);
  }

  function onSearchFocus() {
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    if (searchResults.value.length > 0) {
      showResults.value = true;
    }
  }

  return {
    searchQuery,
    searchResults,
    showResults,
    searching,
    onSearchInput,
    clearSearch,
    onSearchBlur,
    onSearchFocus,
  };
}
