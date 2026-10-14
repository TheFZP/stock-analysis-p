use serde::{Deserialize, Serialize};

/// 个股行情数据 (from Tencent API)
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockQuote {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub prev_close: f64,
    pub open: f64,
    pub volume: f64,       // 成交量（手）
    pub turnover: f64,     // 成交额（万）
    pub change: f64,
    pub change_pct: f64,
    pub high: f64,
    pub low: f64,
    pub turnover_rate: f64, // 换手率
    pub pe: f64,           // 市盈率
    pub amplitude: f64,    // 振幅
}

/// 股票搜索结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub code: String,
    pub name: String,
    pub market: String, // "SH" / "SZ" / "HK"
}

/// 营收排名数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RevenueRanking {
    pub stock_code: String,
    pub stock_name: String,
    pub total_operate_income: f64,      // 营业收入（元）
    pub total_operate_income_rank: i64, // 营收排名
}

/// 市场表现
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MarketPerformance {
    pub changerate: f64,         // 涨跌幅
    pub hs300_changerate: f64,    // 沪深300涨跌幅
    pub time_type: i64,          // 1:今日, 2:本周, 3:本月, 4:今年以来
}

/// 大盘指数数据
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarketIndex {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub change: f64,
    pub change_pct: f64,
}

/// 版本更新信息
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,   // 当前版本
    pub latest: String,    // 最新版本
    pub url: String,       // Release 页面 URL
    pub has_update: bool,  // 是否有新版本
}

/// 完整的行业分析数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndustryData {
    pub industry_name: String,
    pub market_performance: Vec<MarketPerformance>,     // 市场表现
    pub revenue_ranking: Vec<RevenueRanking>,           // 营收排名
}

/// 分时数据条目
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntradayItem {
    pub time: String,    // HH:mm
    pub price: f64,
    pub avg_price: f64,  // 简单均价
    pub volume: f64,     // 成交量（手）
    pub turnover: f64,   // 成交额（元）
    pub vwap: f64,       // VWAP 累计加权均价
}

/// 分时完整数据
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntradayData {
    pub items: Vec<IntradayItem>,
    pub pre_close: f64,
    pub date: String,
}

/// K 线数据条目
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KlineItem {
    pub date: String,
    pub open: f64,
    pub close: f64,
    pub high: f64,
    pub low: f64,
    pub volume: f64,
    pub turnover: f64,
}

/// 个股资金流向数据（全部分档净流入 + 占比）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoneyFlow {
    pub main_net_inflow: f64,     // 主力净流入（万元）
    pub main_net_pct: f64,        // 主力净占比 (%)
    pub super_large_net: f64,     // 超大单净流入（万元）
    pub super_large_pct: f64,     // 超大单净占比 (%)
    pub large_net: f64,           // 大单净流入（万元）
    pub large_pct: f64,           // 大单净占比 (%)
    pub medium_net: f64,          // 中单净流入（万元）
    pub medium_pct: f64,          // 中单净占比 (%)
    pub small_net: f64,           // 小单净流入（万元）
    pub small_pct: f64,           // 小单净占比 (%)
}

/// 单日资金流向历史条目（东方财富 daykline，单位：万元）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoneyFlowHistoryItem {
    pub date: String,             // 交易日 YYYY-MM-DD
    pub main_net_inflow: f64,     // 主力净流入（万元）
    pub super_large_net: f64,     // 超大单净流入（万元）
    pub large_net: f64,           // 大单净流入（万元）
    pub medium_net: f64,          // 中单净流入（万元）
    pub small_net: f64,           // 小单净流入（万元）
    pub close: f64,               // 收盘价
}

/// 热榜股票条目
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HotStockItem {
    pub code: String,
    pub name: String,
    pub rate: String,            // 热度值
    pub rise_and_fall: f64,      // 涨跌幅
    pub hot_rank_chg: i64,       // 排名变化
    pub order: i64,              // 排名序号
    pub market: i64,             // 市场标识 17=SH, 33=SZ
    pub tags: Vec<String>,       // 概念标签
    pub popularity_tag: String,  // 人气标签
}

/// 热榜数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HotListData {
    pub stock_list: Vec<HotStockItem>,
}

/// 写入本地历史库的信号事件（前端 signals 计算完成后回传）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SignalEventInput {
    pub code: String,
    #[serde(default)]
    pub kind: String,   // trap / volume / ma / t0 等来源分类
    #[serde(default)]
    pub name: String,   // 信号名称（含 emoji 前缀，原样保留）
    #[serde(default)]
    pub time: String,   // 时间锚点，日 K 类信号可为空
    #[serde(default)]
    pub dir: String,    // bull / bear
    #[serde(default)]
    pub detail: String, // 说明文本
    #[serde(default)]
    pub price: f64,
}

/// 写入本地历史库的提醒事件（通知成功发送后回传）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlertEventInput {
    pub code: String,
    #[serde(default)]
    pub kind: String, // watchlist / ma / price
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub price: f64,
    #[serde(default)]
    pub target: f64, // 触发目标价（无则 0）
}

/// 本地历史库概况
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
    pub path: String,
    pub size_bytes: u64,
    pub quote_rows: i64,
    pub quote_codes: i64,
    pub quote_first_date: String,
    pub quote_last_date: String,
    pub kline_rows: i64,
    pub kline_codes: i64,
    pub kline_first_date: String,
    pub kline_last_date: String,
    pub money_rows: i64,
    pub signal_rows: i64,
    pub alert_rows: i64,
    pub watchlist_rows: i64,
}

