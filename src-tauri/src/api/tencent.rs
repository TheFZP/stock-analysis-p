/// 腾讯财经数据源
use crate::helpers::{is_hk_stock, to_tencent_code};
use crate::types::{IntradayData, IntradayItem, KlineItem, MarketIndex, MoneyFlow, SearchResult, StockQuote};
use regex::Regex;

/// 获取个股实时行情（来自腾讯财经）
/// 港股: qt.gtimg.cn 返回延迟约 15 分钟的行情（缓存节点轮询、价格来回跳），
///       改用分时接口 web.ifzq.gtimg.cn 获取实时数据，与分时图完全同源
pub async fn fetch_stock_quote(code: &str) -> Result<StockQuote, String> {
    let client = super::build_http_client()?;
    let t_code = to_tencent_code(code);

    let fields: Vec<String> = if is_hk_stock(code) {
        // 港股：分时接口（实时行情，qt 字段布局与 qt.gtimg.cn 一致）
        let url = format!(
            "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={}",
            t_code
        );
        let resp = client
            .get(&url)
            .header("Referer", "https://web.ifzq.gtimg.cn/")
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("请求港股实时行情失败: {}", e))?;

        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析 JSON 失败: {}", e))?;

        data.get("data")
            .and_then(|d| d.get(&t_code))
            .and_then(|s| s.get("qt"))
            .and_then(|q| q.get(&t_code))
            .and_then(|a| a.as_array())
            .ok_or_else(|| "未找到港股行情字段".to_string())?
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_string())
            .collect()
    } else {
        // A股：qt.gtimg.cn（实时行情）
        let url = format!("https://qt.gtimg.cn/q={}", t_code);

        let resp = client
            .get(&url)
            .header("Referer", "https://qt.gtimg.cn/")
            .send()
            .await
            .map_err(|e| format!("请求腾讯行情失败: {}", e))?;

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        let (text, _, _) = encoding_rs::GBK.decode(&bytes);
        let text = text.to_string();
        text.split('~').map(|s| s.to_string()).collect()
    };

    if fields.len() < 40 {
        return Err(format!("腾讯API返回格式异常: {} 个字段", fields.len()));
    }

    // A 股直接解析（振幅在 [43]）
    if !is_hk_stock(code) {
        return Ok(parse_a_quote_fields(code, &fields));
    }

    // 港股字段差异：换手率在 [59]（A 股在 [38]）、量额单位需归一化（振幅同为 [43]）
    let name = fields.get(1).cloned().unwrap_or_default();
    let price = fields.get(3).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let prev_close = fields.get(4).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let open = fields.get(5).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let volume = fields.get(6).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let change = fields.get(31).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let change_pct = fields.get(32).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let high = fields.get(33).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let low = fields.get(34).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let turnover = fields.get(37).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let pe = fields.get(39).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    let amplitude = fields.get(43).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);

    // 港股单位归一化（腾讯港股接口与 A 股语义不同）：
    //   volume: 股 → 手（/100）；turnover: 元 → 万元（/10000）
    //   换手率在 [59]（[38] 恒为 0，不是换手率字段）
    let (volume, turnover, turnover_rate) = (
        volume / 100.0,
        turnover / 10000.0,
        fields.get(59).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0),
    );

    Ok(StockQuote {
        code: code.to_string(),
        name, price, prev_close, open, volume, turnover, change, change_pct, high, low,
        turnover_rate, pe, amplitude,
    })
}

/// 解析 A 股行情字段（腾讯 qt.gtimg.cn 布局，~ 分隔）
/// 字段: [1]名称 [3]价格 [4]昨收 [5]今开 [6]成交量(手) [31]涨跌额 [32]涨跌幅
///       [33]最高 [34]最低 [37]成交额(万元) [38]换手率 [39]市盈率 [43]振幅 [46]市净率
fn parse_a_quote_fields(code: &str, fields: &[String]) -> StockQuote {
    let get = |i: usize| fields.get(i).unwrap_or(&"0".to_string()).parse::<f64>().unwrap_or(0.0);
    StockQuote {
        code: code.to_string(),
        name: fields.get(1).cloned().unwrap_or_default(),
        price: get(3),
        prev_close: get(4),
        open: get(5),
        volume: get(6),
        turnover: get(37),
        change: get(31),
        change_pct: get(32),
        high: get(33),
        low: get(34),
        turnover_rate: get(38),
        pe: get(39),
        amplitude: get(43),
    }
}

/// 批量获取 A 股实时行情（腾讯批量接口，一次请求多只，大幅减少 HTTP 请求数）
/// 港股逐只走 fetch_stock_quote（分时接口，实时性要求高）
pub async fn fetch_stock_quotes_batch(codes: &[String]) -> Result<Vec<StockQuote>, String> {
    if codes.is_empty() {
        return Ok(vec![]);
    }
    let client = super::build_http_client()?;
    let mut results = Vec::with_capacity(codes.len());

    // 港股逐只（延迟接口无法批量，走分时实时接口）
    for code in codes.iter().filter(|c| is_hk_stock(c)) {
        match fetch_stock_quote(code).await {
            Ok(q) => results.push(q),
            Err(e) => eprintln!("批量行情: 港股 {} 失败: {}", code, e),
        }
    }

    // A 股批量（每批最多 50 只，避免 URL 过长）
    let a_codes: Vec<&String> = codes.iter().filter(|c| !is_hk_stock(c)).collect();
    let line_re = Regex::new(r#"v_[a-z0-9]+="([^"]*)""#).expect("正则编译失败");
    for chunk in a_codes.chunks(50) {
        let t_codes: Vec<String> = chunk.iter().map(|c| to_tencent_code(c)).collect();
        let url = format!("https://qt.gtimg.cn/q={}", t_codes.join(","));
        let resp = client
            .get(&url)
            .header("Referer", "https://qt.gtimg.cn/")
            .send()
            .await
            .map_err(|e| format!("批量请求腾讯行情失败: {}", e))?;
        let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
        let (text, _, _) = encoding_rs::GBK.decode(&bytes);
        let text = text.to_string();

        // 每行格式: v_sh600519="1~贵州茅台~600519~...";
        for caps in line_re.captures_iter(&text) {
            let fields: Vec<String> = caps[1].split('~').map(|s| s.to_string()).collect();
            // 失败行（v_pv_none_match）字段过少，跳过
            if fields.len() < 47 {
                continue;
            }
            // 字段 [2] 为纯数字股票代码，与前端请求格式一致
            let code = fields.get(2).cloned().unwrap_or_default();
            if code.is_empty() {
                continue;
            }
            results.push(parse_a_quote_fields(&code, &fields));
        }
    }
    Ok(results)
}

/// 获取大盘指数实时行情
pub async fn fetch_index_quote(code: &str) -> Result<MarketIndex, String> {
    let client = super::build_http_client()?;
    let t_code = if code.starts_with("000") || code.starts_with("6") {
        format!("sh{}", code)
    } else {
        format!("sz{}", code)
    };

    let url = format!("https://qt.gtimg.cn/q={}", t_code);

    let resp = client
        .get(&url)
        .header("Referer", "https://qt.gtimg.cn/")
        .send()
        .await
        .map_err(|e| format!("请求腾讯行情失败: {}", e))?;

    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let (text, _, _) = encoding_rs::GBK.decode(&bytes);
    let text = text.to_string();

    let fields: Vec<&str> = text.split('~').collect();
    if fields.len() < 40 {
        return Err(format!("腾讯API返回格式异常: {} 个字段", fields.len()));
    }

    let name = fields.get(1).unwrap_or(&"").to_string();
    let price = fields.get(3).unwrap_or(&"0").parse::<f64>().unwrap_or(0.0);
    let change = fields.get(31).unwrap_or(&"0").parse::<f64>().unwrap_or(0.0);
    let change_pct = fields.get(32).unwrap_or(&"0").parse::<f64>().unwrap_or(0.0);

    Ok(MarketIndex { code: code.to_string(), name, price, change, change_pct })
}

/// 获取个股资金流向（来自腾讯财经，ff_ 接口为「标签~值」交替格式）
/// 索引布局：0=代码 2=主力流入 4=主力流出 6=主力净流入 8=主力净占比(%)
///          14=超大单净流入 16=超大单占比 22=大单净流入 24=大单占比
///          30=中单净流入 32=中单占比 38=小单净流入 40=小单占比
pub async fn fetch_money_flow(code: &str) -> Result<MoneyFlow, String> {
    let client = super::build_http_client()?;
    let t_code = to_tencent_code(code);
    let url = format!("https://qt.gtimg.cn/q=ff_{}", t_code);

    let resp = client
        .get(&url)
        .header("Referer", "https://qt.gtimg.cn/")
        .send()
        .await
        .map_err(|e| format!("请求资金流向失败: {}", e))?;

    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let (text, _, _) = encoding_rs::GBK.decode(&bytes);
    let text = text.to_string();

    let fields: Vec<&str> = text.split('~').collect();
    // 有效响应需覆盖到索引 40（小单占比）；字段不足说明接口改版/失效
    // （如现在返回的 v_pv_none_match="1"），返回 NO_DATA 交由上层换数据源，
    // 避免把缺失字段静默当成 0 展示
    if fields.len() < 41 {
        return Err("NO_DATA".to_string());
    }

    // 金额可能带「亿/万」后缀（如 1.23亿），统一转为万元；占比为纯数字
    let parse_money = |idx: usize| -> f64 {
        let raw = fields.get(idx).unwrap_or(&"0").trim();
        if raw.is_empty() { return 0.0; }
        if raw.ends_with('亿') {
            raw.trim_end_matches('亿').parse::<f64>().unwrap_or(0.0) * 10000.0
        } else if raw.ends_with('万') {
            raw.trim_end_matches('万').parse::<f64>().unwrap_or(0.0)
        } else {
            raw.parse::<f64>().unwrap_or(0.0)
        }
    };
    let pct = |idx: usize| -> f64 {
        fields.get(idx).unwrap_or(&"0").trim().parse::<f64>().unwrap_or(0.0)
    };

    Ok(MoneyFlow {
        main_net_inflow: parse_money(6),
        main_net_pct: pct(8),
        super_large_net: parse_money(14),
        super_large_pct: pct(16),
        large_net: parse_money(22),
        large_pct: pct(24),
        medium_net: parse_money(30),
        medium_pct: pct(32),
        small_net: parse_money(38),
        small_pct: pct(40),
    })
}

/// 将 `\uXXXX` 转义序列还原为 Unicode 字符
fn unescape_unicode(s: &str) -> String {
    let re = Regex::new(r"\\u([0-9a-fA-F]{4})").unwrap();
    re.replace_all(s, |caps: &regex::Captures| {
        let hex = caps.get(1).unwrap().as_str();
        let code = u32::from_str_radix(hex, 16).unwrap_or(0xFFFD);
        char::from_u32(code).map(|c| c.to_string()).unwrap_or_else(|| format!("\\u{}", hex))
    })
    .to_string()
}

/// 搜索股票（来自腾讯智能搜索）
pub async fn fetch_search_results(keyword: &str) -> Result<Vec<SearchResult>, String> {
    let client = super::build_http_client()?;
    let url = format!("https://smartbox.gtimg.cn/s3/?q={}&t=all", keyword);

    let resp = client
        .get(&url)
        .header("Referer", "https://smartbox.gtimg.cn/")
        .send()
        .await
        .map_err(|e| format!("请求搜索失败: {}", e))?;

    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let (text, _, _) = encoding_rs::GBK.decode(&bytes);
    let text = text.to_string();

    let mut results = Vec::new();
    if let Some(eq_pos) = text.find('=') {
        let value_part = &text[eq_pos + 1..];
        let value = value_part.trim().trim_matches('"').trim_end_matches(';').trim();
        for item in value.split('^') {
            let fields: Vec<&str> = item.split('~').collect();
            if fields.len() < 3 { continue; }
            let market_raw = fields[0].trim();
            let raw_code = fields[1].trim();
            let name = unescape_unicode(fields[2].trim());
            let (market, code) = match market_raw {
                "sh" => ("SH".to_string(), raw_code.to_string()),
                "sz" => ("SZ".to_string(), raw_code.to_string()),
                // 港股代码归一化为 5 位（如 700 → 00700），确保下游 is_hk_stock / to_tencent_code 正确识别
                "hk" => ("HK".to_string(), format!("{:0>5}", raw_code)),
                _ => continue,
            };
            results.push(SearchResult { code, name, market });
        }
    }
    Ok(results)
}

/// 获取个股 K 线数据（来自腾讯财经）
/// period: "day" | "week" | "month" | "m5" | "m15" | "m30" | "m60"
///
/// 分钟级周期（m5/m15/m30/m60）走 mkline 接口（无复权概念，数据键 = period 本身）；
/// 日/周/月走 fqkline 接口（前复权，数据键 qfqday/qfqweek/qfqmonth）。
pub async fn fetch_kline_data(code: &str, period: &str) -> Result<Vec<KlineItem>, String> {
    use crate::helpers::parse_json_f64;

    let client = super::build_http_client()?;
    let t_code = to_tencent_code(code);
    let is_minute = matches!(period, "m5" | "m15" | "m30" | "m60");

    // 腾讯 mkline 接口不支持港股分钟 K 线（实测 param error），降级提示
    if is_minute && crate::helpers::is_hk_stock(code) {
        return Err("港股暂不支持分钟 K 线".to_string());
    }

    let url = if is_minute {
        // 分钟 K：mkline 接口，单次最多约 320 根（5分≈6.7 交易日，60分≈2.5 个月）
        format!(
            "https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={},{},,320",
            t_code, period
        )
    } else {
        format!(
            "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={},{},,,120,qfq",
            t_code, period
        )
    };

    let resp = client
        .get(&url)
        .header("Referer", "https://web.ifzq.gtimg.cn/")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求 K 线数据失败: {}", e))?;

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 JSON 失败: {}", e))?;

    let klines = if is_minute {
        // mkline 响应：data.{t_code}.{period} 直接是数组（另有 qt/prec 等字段）
        data.get("data")
            .and_then(|d| d.get(&t_code))
            .and_then(|s| s.get(period))
            .and_then(|d| d.as_array())
            .ok_or_else(|| "未找到分钟 K 线数据".to_string())?
    } else {
        let data_key = match period {
            "week" => "qfqweek",
            "month" => "qfqmonth",
            _ => "qfqday",
        };
        data.get("data")
            .and_then(|d| d.get(&t_code))
            .and_then(|s| s.get(data_key).or_else(|| {
                let fallback = match period { "week" => "week", "month" => "month", _ => "day" };
                s.get(fallback)
            }))
            .and_then(|d| d.as_array())
            .ok_or_else(|| "未找到 K 线数据".to_string())?
    };

    let items: Vec<KlineItem> = klines.iter().filter_map(|k| {
        let arr = k.as_array()?;
        if arr.len() < 6 { return None; }
        Some(KlineItem {
            date: arr[0].as_str().unwrap_or("").to_string(),
            open: parse_json_f64(&arr[1]),
            close: parse_json_f64(&arr[2]),
            high: parse_json_f64(&arr[3]),
            low: parse_json_f64(&arr[4]),
            volume: parse_json_f64(&arr[5]),
            turnover: arr.get(6).map(|v| parse_json_f64(v)).unwrap_or(0.0),
        })
    }).collect();

    if items.is_empty() {
        return Err("K 线数据为空".to_string());
    }
    Ok(items)
}

/// 获取个股分时数据（来自腾讯 AppStock）
/// 返回当日每分钟的 [时间, 价格, 成交量, 成交额]
/// API 返回格式：data.{t_code}.data.data 是字符串数组，每项 "HHmm price volume turnover"
/// 昨收从 data.{t_code}.qt.{t_code}[4] 获取
pub async fn fetch_intraday_data(code: &str) -> Result<IntradayData, String> {
    let client = super::build_http_client()?;
    let t_code = to_tencent_code(code);
    let url = format!(
        "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={}",
        t_code
    );

    let resp = client
        .get(&url)
        .header("Referer", "https://web.ifzq.gtimg.cn/")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求分时数据失败: {}", e))?;

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 JSON 失败: {}", e))?;

    // 结构: data.{t_code}
    let stock_data = data
        .get("data")
        .and_then(|d| d.get(&t_code))
        .ok_or_else(|| "未找到分时数据".to_string())?;

    // 昨收: data.{t_code}.qt.{t_code}[4]
    let pre_close = stock_data
        .get("qt")
        .and_then(|q| q.get(&t_code))
        .and_then(|arr| arr.as_array())
        .and_then(|arr| arr.get(4))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    // 日期: data.{t_code}.data.date
    let date = stock_data
        .get("data")
        .and_then(|d| d.get("date"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 分时数据点: data.{t_code}.data.data — 字符串数组 ["HHmm price volume turnover", ...]
    let raw_data = stock_data
        .get("data")
        .and_then(|d| d.get("data"))
        .and_then(|v| v.as_array());

    let points = match raw_data {
        Some(arr) => arr,
        None => return Err("未找到分时数据点".to_string()),
    };

    let mut items = Vec::new();
    let mut cum_pv = 0.0; // ∑(price × volume per-minute) for VWAP
    let mut cum_vol = 0.0; // ∑(volume per-minute) for VWAP
    let mut prev_vol = 0.0; // 上一分钟的累计量，用于差分
    let mut prev_turnover = 0.0; // 上一分钟的累计额，用于差分

    // 累计成交量单位：A 股/北交所为「手」（1 手 = 100 股），港股为「股」
    // （实测 hk00700/hk01810/hk09988：累计成交额 / 累计量 ≈ 现价，即港股已是股数）
    let is_hk = is_hk_stock(code);
    let shares_per_unit: f64 = if is_hk { 1.0 } else { 100.0 };

    // 交易时段判断（按市场）：接口会在收盘后附带零星的盘后成交分钟
    // （如 15:06-15:30 量 0-20 的僵尸数据），必须剔除——
    // 否则"尾盘 15 分钟"检测窗口会被盘后数据占据，尾盘信号/指标全部失效
    let is_session_minute = |time: &str| -> bool {
        let hhmm: Vec<&str> = time.split(':').collect();
        if hhmm.len() != 2 {
            return false;
        }
        let h: i32 = hhmm[0].parse().unwrap_or(-1);
        let m: i32 = hhmm[1].parse().unwrap_or(-1);
        if h < 0 || m < 0 {
            return false;
        }
        let t = h * 60 + m;
        if crate::helpers::is_hk_stock(code) {
            // 港股：9:30-12:00 / 13:00-16:00
            (570..=720).contains(&t) || (780..=960).contains(&t)
        } else {
            // A 股：9:30-11:30 / 13:00-15:00
            (570..=690).contains(&t) || (780..=900).contains(&t)
        }
    };

    for point in points {
        let s = point.as_str().unwrap_or("");
        if s.is_empty() {
            continue;
        }
        let parts: Vec<&str> = s.split(' ').collect();
        if parts.len() >= 3 {
            // time: "0930" → "09:30"（is_ascii 保证字节切片不会切在字符中间）
            let raw_time = parts[0];
            let time = if raw_time.len() == 4 && raw_time.is_ascii() {
                format!("{}:{}", &raw_time[..2], &raw_time[2..])
            } else {
                raw_time.to_string()
            };
            // 剔除交易时段外的分钟（含盘后零星成交）
            if !is_session_minute(&time) {
                // 注意：被剔除分钟同样要推进累计量/额基准，否则差分会算错
                if let Ok(cv) = parts[2].parse::<f64>() {
                    prev_vol = cv;
                    prev_turnover = parts.get(3).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                }
                continue;
            }
            let price: f64 = parts[1].parse().unwrap_or(0.0);
            let cum_volume: f64 = parts[2].parse().unwrap_or(0.0); // 累计量：A 股为手、港股为股（见 shares_per_unit）
            let cum_turnover: f64 = parts.get(3).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0); // 累计成交额（元）

            // 差分：本分钟实际成交量 = 累计量 - 上分钟累计量
            let mut volume = if cum_volume >= prev_vol {
                cum_volume - prev_vol
            } else {
                cum_volume // 防御：跨天重置的情况
            };
            // 港股累计量为「股」，对外统一换算为「手」，与实时行情及其他接口口径一致
            if is_hk {
                volume /= 100.0;
            }
            let turnover = if cum_turnover >= prev_turnover {
                cum_turnover - prev_turnover
            } else {
                cum_turnover
            };
            prev_vol = cum_volume;
            prev_turnover = cum_turnover;

            // 累计 VWAP：∑(price × minute_volume) / ∑(minute_volume)
            cum_pv += price * volume;
            cum_vol += volume;
            let vwap = if cum_vol > 0.0 {
                (cum_pv / cum_vol * 100.0).round() / 100.0
            } else {
                0.0
            };

            // 均价 = 累计成交额（元）/ 累计成交量（换算为股）
            // 直接用 API 返回的累计值，避免差分→再累加的精度损失和条件遗漏
            let avg_price = if cum_volume > 0.0 && cum_turnover > 0.0 {
                (cum_turnover / (cum_volume * shares_per_unit) * 100.0).round() / 100.0
            } else if cum_volume > 0.0 && cum_vol > 0.0 {
                // 成交额缺失时（API 只返回3个字段），用 VWAP 近似均价
                (cum_pv / cum_vol * 100.0).round() / 100.0
            } else {
                0.0
            };

            items.push(IntradayItem { time, price, avg_price, volume, turnover, vwap });
        }
    }

    if items.is_empty() {
        return Err("分时数据为空".to_string());
    }

    Ok(IntradayData { items, pre_close, date })
}

/// 获取港元兑人民币汇率（来自 Frankfurter API，免费无需 Key）
/// GET https://api.frankfurter.app/latest?from=HKD&to=CNY
/// 返回 1 港元 = x 人民币
pub async fn fetch_fx_rate() -> Result<f64, String> {
    let client = super::build_http_client()?;
    let url = "https://api.frankfurter.app/latest?from=HKD&to=CNY";

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求汇率失败: {}", e))?;

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析汇率 JSON 失败: {}", e))?;

    let rate = data
        .get("rates")
        .and_then(|r| r.get("CNY"))
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "汇率数据中未找到 CNY".to_string())?;

    if rate <= 0.0 {
        return Err("汇率解析为零".to_string());
    }
    Ok(rate)
}
