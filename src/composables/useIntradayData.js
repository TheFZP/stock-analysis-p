import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

/**
 * 分时数据加载
 */
export function useIntradayData() {
  const intradayData = ref(null);
  const intradayLoading = ref(false);
  // 数据新鲜度：最近一次成功时间 + 最近一次刷新是否失败（失败时保留旧数据）
  const intradayFetchedAt = ref(0);
  const intradayStale = ref(false);
  // 请求序号：切换股票时丢弃旧请求结果（竞态保护）
  let requestSeq = 0;
  // 当前 intradayData 所属的股票代码：刷新失败时只保留同一只股票的旧数据
  let dataKey = null;

  async function loadIntradayData(stock) {
    if (!stock) return;
    const key = stock.code;
    const seq = ++requestSeq;
    intradayLoading.value = true;
    try {
      const data = await invoke("get_stock_intraday", {
        code: stock.code,
      });
      if (seq !== requestSeq) return; // 已被更新的请求取代，丢弃
      intradayData.value = data;
      dataKey = key;
      intradayFetchedAt.value = Date.now();
      intradayStale.value = false;
    } catch (e) {
      if (seq !== requestSeq) return;
      console.error("获取分时数据失败:", e);
      // 同一只股票的刷新失败：保留旧数据（前端标注「更新失败」+ 重试），避免图表闪空
      if (dataKey !== key) {
        intradayData.value = null;
        dataKey = key; // 已不再持有任何数据，角标不该再显示上一只股票的时间
        intradayFetchedAt.value = 0;
      }
      intradayStale.value = true;
    } finally {
      if (seq === requestSeq) intradayLoading.value = false;
    }
  }

  return {
    intradayData,
    intradayLoading,
    intradayFetchedAt,
    intradayStale,
    loadIntradayData,
  };
}
