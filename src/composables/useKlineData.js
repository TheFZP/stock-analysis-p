import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

/**
 * K 线数据加载 + 周期切换
 */
export function useKlineData() {
  const klineData = ref(null);
  const klineLoading = ref(false);
  const klinePeriod = ref("day");
  // 数据新鲜度：最近一次成功时间 + 最近一次刷新是否失败（失败时保留旧数据）
  const klineFetchedAt = ref(0);
  const klineStale = ref(false);
  // 请求序号：切换股票/周期时丢弃旧请求结果（竞态保护）
  let requestSeq = 0;
  // 当前 klineData 所属的「代码|周期」：刷新失败时只有同标的的旧数据可以保留，
  // 否则会把上一只股票的 K 线画在新股票上。
  let dataKey = null;

  async function loadKlineData(stock) {
    if (!stock) return;
    const key = `${stock.code}|${klinePeriod.value}`;
    const seq = ++requestSeq;
    klineLoading.value = true;
    try {
      const data = await invoke("get_stock_kline", {
        code: stock.code,
        period: klinePeriod.value,
      });
      if (seq !== requestSeq) return; // 已被更新的请求取代，丢弃
      klineData.value = data;
      dataKey = key;
      klineFetchedAt.value = Date.now();
      klineStale.value = false;
    } catch (e) {
      if (seq !== requestSeq) return;
      console.error("获取 K 线数据失败:", e);
      // 同标的的刷新失败：保留旧数据（前端标注「更新失败」+ 重试），避免图表闪空
      if (dataKey !== key) {
        klineData.value = null;
        dataKey = key; // 已不再持有任何数据，角标不该再显示上一只股票的时间
        klineFetchedAt.value = 0;
      }
      klineStale.value = true;
    } finally {
      if (seq === requestSeq) klineLoading.value = false;
    }
  }

  function changeKlinePeriod(period) {
    klinePeriod.value = period;
  }

  return {
    klineData,
    klineLoading,
    klinePeriod,
    klineFetchedAt,
    klineStale,
    loadKlineData,
    changeKlinePeriod,
  };
}
