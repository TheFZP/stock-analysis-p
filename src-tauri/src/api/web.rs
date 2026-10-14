/// Web 搜索与网页抓取 API
/// 搜索使用东方财富搜索 API（search-api-web.eastmoney.com，免费无需 API Key）：
///   - 财经垂直内容库（新闻/公告/研报），不会出现通用搜索引擎的意图跑偏
///     （如 Bing 搜"宁德时代"返回"宁德市"城市信息）
///   - sort=default 按**相关性**排序（实测 sort=time 会返回含任意关键词的无关
///     新闻，如搜"贵州茅台"返回 ETF/黄金新闻；default 下第一条即高度相关）
///   - 每条带发布时间和来源媒体；本地再剥离查询中的泛词（"最新消息"等）
///     并去重，进一步提升相关性
/// 抓取使用直接 HTTP 请求 + 智能正文提取。
///
/// 已知反爬站点（解析时过滤）：知乎、百度百科、豆瓣等
/// 这些站点对无 JS/无登录的请求返回 403 或登录墙，抓取必然失败

use serde::Serialize;
use regex::Regex;
use futures_util::StreamExt;

/// 网页搜索结果项
#[derive(Debug, Clone, Serialize)]
pub struct WebSearchResult {
    pub title: String,
    pub snippet: String,
    pub url: String,
    /// 发布时间（如 "2026-08-03 13:14:56"），东财按时间倒序返回
    pub date: String,
}

/// 完整浏览器 UA（带 Chrome 版本号），降低被反爬拦截的概率
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 反爬/登录墙重灾区，抓取必失败，搜索结果中直接过滤掉
const BLOCKED_HOSTS: &[&str] = &[
    "zhihu.com",
    "baike.baidu.com",
    "zhidao.baidu.com",
    "douban.com",
    "wenku.baidu.com",
    "bilibili.com",
    "weibo.com",
    "mp.weixin.qq.com",
];

/// 判断 IP 是否为内网/回环/链路本地/组播/保留地址（SSRF 防护用）
fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            match o[0] {
                0 => true,                                   // 0.0.0.0/8
                10 => true,                                  // 10.0.0.0/8
                127 => true,                                 // 127.0.0.0/8 回环
                169 => o[1] == 254,                          // 169.254.0.0/16 链路本地（云元数据）
                172 => o[1] >= 16 && o[1] <= 31,             // 172.16.0.0/12
                192 => o[1] == 168,                          // 192.168.0.0/16
                100 => o[1] >= 64 && o[1] <= 127,            // 100.64.0.0/10 CGNAT
                224..=255 => true,                           // 组播/保留
                _ => false,
            }
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local() // fc00::/7
                || v6.is_unicast_link_local() // fe80::/10
                || v6.is_multicast()
        }
    }
}

/// SSRF 防护：校验主机名（可带端口）。
/// IP 直接判断私网段；域名则 DNS 解析全部地址，任一命中私网即拒绝。
/// 返回 Ok 表示允许访问。
async fn host_is_allowed(host: &str) -> Result<(), String> {
    // 剥 IPv6 方括号与端口
    let host = host.trim_start_matches('[').split(']').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host).trim();
    if host.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return if is_private_ip(ip) {
            Err(format!("禁止访问内网/本机地址: {}", ip))
        } else {
            Ok(())
        };
    }
    // 域名：解析全部 A/AAAA 地址，任一为私网即拒绝（防 DNS 重绑定/内网域名）
    let addrs = tokio::net::lookup_host((host, 80))
        .await
        .map_err(|e| format!("域名解析失败 {}: {}", host, e))?;
    for addr in addrs {
        if is_private_ip(addr.ip()) {
            return Err(format!("域名 {} 解析到内网地址，已拒绝访问", host));
        }
    }
    Ok(())
}

/// 网页搜索：使用东方财富搜索 API（免费，无需 API Key，国内可访问）
/// 财经垂直内容库 + sort=default **相关性**排序（实测 sort=time 相关性差：
/// 搜"贵州茅台"会返回 ETF/黄金等仅含泛词的无关新闻，default 下第一条即相关）
/// 返回最多 15 条
///
/// 兼容 site: 域名 限定（如 "site:cninfo.com.cn"）：东财不识别该操作符，
/// 这里在本地按 URL 域名过滤兜底。
pub async fn web_search(query: &str, max_results: usize) -> Result<Vec<WebSearchResult>, String> {
    // 剥离查询泛词（"最新消息"/"怎么样"等）——泛词会按 OR 匹配污染相关性排序
    let clean_query = strip_noise_words(query);
    if clean_query.trim().is_empty() {
        return Err("搜索关键词不能为空".to_string());
    }
    let mut results = search_eastmoney_news(&clean_query, max_results).await?;
    results = dedup_results(results);

    // 多词查询兜底：东财按 OR 匹配，热门词（"中报/业绩"等）会把无关新闻顶上来。
    // 提取核心实体（首个实词），过滤标题/摘要都不含实体的结果；
    // 过滤后太少（<3 条）则用核心实体单独重搜，保证返回与实体真正相关的结果
    let core_entity = extract_core_entity(&clean_query);
    if !core_entity.is_empty() {
        let kept: Vec<WebSearchResult> = results
            .drain(..)
            .filter(|r| {
                (r.title.to_lowercase().contains(&core_entity))
                    || (r.snippet.to_lowercase().contains(&core_entity))
            })
            .collect();
        if kept.len() >= 3 {
            results = kept;
        } else {
            // 实体相关结果太少 → 用纯实体词重搜（如「寒武纪 中报 业绩」→「寒武纪」）
            results = search_eastmoney_news(&core_entity, max_results).await?;
            results = dedup_results(results);
        }
    }

    // site: 来源限定：本地按域名过滤兜底；
    // 过滤后为空说明该来源无收录，返回空结果让 AI 换来源（而不是返回不相关结果）
    let site_filters = extract_site_filters(query);
    if !site_filters.is_empty() {
        let filtered: Vec<WebSearchResult> = results
            .drain(..)
            .filter(|r| site_filters.iter().any(|d| r.url.to_lowercase().contains(d)))
            .collect();
        if !filtered.is_empty() {
            results = filtered;
        } else {
            return Ok(Vec::new());
        }
    }

    Ok(results)
}

/// 提取查询的核心实体（如「寒武纪 中报 业绩」→「寒武纪」；「宁德时代中报业绩」→「宁德时代」）。
/// 东财 OR 匹配下，用核心实体过滤可剔除"只命中热门维度词"的无关新闻。
/// 中文查询通常无空格，按维度词位置截断；截断失败时取前 4 字启发式兜底。
fn extract_core_entity(clean_query: &str) -> String {
    let q = clean_query.trim();
    if q.is_empty() {
        return String::new();
    }
    // 带空格查询：首个 token 即实体
    if let Some(first) = q.split_whitespace().next() {
        if first != q {
            return first.to_lowercase();
        }
    }
    // 无空格中文串：在维度词处截断（「宁德时代中报业绩」→「宁德时代」）
    const DIMENSION_WORDS: &[&str] = &[
        "中报", "年报", "一季报", "半年报", "业绩", "公告", "批价", "股价", "市值", "政策",
        "分红", "回购", "涨停", "跌停", "行情", "走势", "最新", "消息", "新闻", "分析", "如何",
    ];
    let lower = q.to_lowercase();
    let mut cut = lower.len();
    for w in DIMENSION_WORDS {
        if let Some(pos) = lower.find(w) {
            if pos > 0 {
                cut = cut.min(pos);
            }
        }
    }
    let entity = &lower[..cut];
    let len = entity.chars().count();
    if (2..=8).contains(&len) {
        entity.to_string()
    } else {
        // 截断失败（实体过短/过长）：取前 4 字启发式
        lower.chars().take(4).collect()
    }
}

/// 剥离查询中的泛词（模型常生成的"最新消息/怎么样/如何"等无效实词），
/// 防止它们按 OR 匹配污染相关性排序。
/// 带空格查询按 token 过滤；中文无空格查询按子串剥离（split_whitespace 对无空格串无效）。
fn strip_noise_words(query: &str) -> String {
    const NOISE_WORDS: &[&str] = &[
        "最新消息", "最新新闻", "最新动态", "最新情况", "最新进展", "最新公告", "最新资讯",
        "怎么样", "如何", "怎样", "怎么", "啥情况", "什么情况", "相关内容", "相关信息",
        "新闻报道", "新闻", "消息", "情况", "动态",
    ];
    if query.split_whitespace().count() > 1 {
        query
            .split_whitespace()
            .filter(|w| !NOISE_WORDS.iter().any(|n| w.contains(n)))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        // 中文无空格查询：按子串剥离
        let mut s = query.to_string();
        for n in NOISE_WORDS {
            s = s.replace(n, "");
        }
        s.trim().to_string()
    }
}

/// 结果去重：相同 URL 直接去重；相同标题只保留最新一条
fn dedup_results(results: Vec<WebSearchResult>) -> Vec<WebSearchResult> {
    let mut seen_url = std::collections::HashSet::new();
    let mut seen_title = std::collections::HashSet::new();
    results
        .into_iter()
        .filter(|r| {
            if !seen_url.insert(r.url.clone()) {
                return false;
            }
            let title_key: String = r.title.chars().filter(|c| !c.is_whitespace()).collect();
            if !title_key.is_empty() && !seen_title.insert(title_key) {
                return false;
            }
            true
        })
        .collect()
}

/// 从查询中提取 site: 限定的域名列表（如 "site:cninfo.com.cn OR site:sse.com.cn"）
fn extract_site_filters(query: &str) -> Vec<String> {
    let re = Regex::new(r"(?i)site:([a-z0-9.-]+\.[a-z]{2,})").unwrap();
    re.captures_iter(query)
        .filter_map(|c| c.get(1))
        .map(|m| m.as_str().to_lowercase())
        .collect()
}

/// 调用东方财富搜索 API（JSONP），按相关性（sort=default）获取财经新闻
/// 实测 sort=time 会返回大量仅含泛词的无关新闻（如"贵州茅台"→ETF/黄金新闻），
/// sort=default 首条即高度相关，故相关性优先
async fn search_eastmoney_news(query: &str, max_results: usize) -> Result<Vec<WebSearchResult>, String> {
    let client = super::build_http_client()?;

    // 东财搜索接口参数（cmsArticleWebOld = 新闻文章库，sort=default 相关性排序）
    let param = serde_json::json!({
        "uid": "",
        "keyword": query,
        "type": ["cmsArticleWebOld"],
        "client": "web",
        "clientType": "web",
        "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default",
                "sort": "default",
                "pageIndex": 1,
                "pageSize": max_results.min(15),
                "preTag": "<em>",
                "postTag": "</em>"
            }
        }
    });

    let resp = client
        .get("https://search-api-web.eastmoney.com/search/jsonp")
        .query(&[("cb", "jQuery"), ("param", param.to_string().as_str())])
        .header("Referer", "https://so.eastmoney.com/")
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("搜索返回 HTTP {}", status));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取搜索响应失败: {}", e))?;

    parse_eastmoney_jsonp(&body)
}

/// 网页抓取：获取指定 URL 的正文纯文本
/// - 完整浏览器头模拟真实访问，降低 403 概率
/// - 自动按 Content-Type 的 charset 解码（GBK/GB2312 等；无 charset 头时按字节探测）
/// - 智能提取正文（JSON-LD → 正文容器 → meta 描述 → 整页兜底）
/// - 安全截断，避免在 UTF-8 字符中间切片
/// - SSRF 防护：拒绝内网/回环/链路本地地址；限制重定向（禁止跨主机跳转）
/// - 响应体上限 50MB，防止 OOM
pub async fn web_fetch(url: &str) -> Result<String, String> {
    // 只抓 http/https，且主机必须非内网
    let parsed = url::Url::parse(url).map_err(|e| format!("URL 解析失败: {}", e))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("不支持的 URL 协议: {}", parsed.scheme()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少主机名".to_string())?
        .to_string();
    host_is_allowed(&host).await?;

    // reqwest 的重定向策略是 client 级配置（RequestBuilder 无 redirect 方法），
    // 且策略闭包需捕获本次请求的主机 → 为 web_fetch 单独构建 client。
    // web_fetch 是低频路径（AI 工具按需调用），不共享连接池影响可忽略
    let original_host = host.to_lowercase();
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        let target = attempt.url();
        if target.scheme() != "http" && target.scheme() != "https" {
            return attempt.error("仅允许 http/https 重定向");
        }
        let target_host = target.host_str().unwrap_or("").to_lowercase();
        if target_host != original_host {
            return attempt.error("禁止跨主机重定向");
        }
        if let Ok(ip) = target_host.parse::<std::net::IpAddr>() {
            if is_private_ip(ip) {
                return attempt.error("禁止重定向到内网地址");
            }
        }
        attempt.follow()
    });

    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(redirect_policy)
        .no_proxy()
        .build()
        .map_err(|e| format!("创建抓取客户端失败: {}", e))?;

    let resp = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("User-Agent", BROWSER_UA)
        .header("Referer", "https://cn.bing.com/")
        .send()
        .await
        .map_err(|e| format!("网页请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}: 无法获取该网页（可能被反爬拦截或链接已失效）", status));
    }

    // 响应头 charset（用于 GBK 页面解码）
    let charset = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|ct| {
            ct.split(';').find_map(|p| {
                let p = p.trim();
                p.strip_prefix("charset=")
                    .map(|c| c.trim_matches('"').to_lowercase())
            })
        });

    // 流式读取并限制响应体大小（防 LLM 被诱导抓取超大文件导致 OOM）
    let mut stream = resp.bytes_stream();
    let mut body_bytes: Vec<u8> = Vec::new();
    const MAX_BODY: usize = 50 * 1024 * 1024;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取网页内容失败: {}", e))?;
        if body_bytes.len() + chunk.len() > MAX_BODY {
            return Err("网页内容超过 50MB 上限，已中止抓取".to_string());
        }
        body_bytes.extend_from_slice(&chunk);
    }

    // 解码：优先按响应头 charset；无 charset 头时按字节探测（非 UTF-8 则尝试 GBK）
    let body = match charset.as_deref() {
        Some("gbk") | Some("gb2312") | Some("gb18030") => {
            encoding_rs::GBK.decode(&body_bytes).0.into_owned()
        }
        _ => match std::str::from_utf8(&body_bytes) {
            Ok(s) => s.to_string(),
            Err(_) => encoding_rs::GBK.decode(&body_bytes).0.into_owned(),
        },
    };

    if body.trim().is_empty() {
        return Err("网页内容为空".to_string());
    }

    let text = extract_article(&body);

    // 内容太少说明是 JS 渲染页或登录墙，直接报错让 AI 换链接
    if text.chars().count() < 150 {
        return Err(
            "该网页是动态加载或需要登录，静态抓取拿不到正文。请换一个链接（优先选择新闻门户如腾讯新闻、新浪财经、东方财富等静态页面）"
                .to_string(),
        );
    }

    Ok(text)
}

// ─── 内部工具函数 ───

/// 解析东财 JSONP 响应：剥掉 jQuery(...) 壳 → 取 result.cmsArticleWebOld 新闻列表
fn parse_eastmoney_jsonp(body: &str) -> Result<Vec<WebSearchResult>, String> {
    // 剥 JSONP 壳（兼容有/无 callback 前缀）
    // 注意：异常页面（风控 HTML 等）中 '}' 可能出现在 '{' 之前，必须校验 start <= end，
    // 否则切片会 panic（slice index starts at X but ends at Y）
    let json_str = body.trim();
    let json_str = if let Some(start) = json_str.find('{') {
        if let Some(end) = json_str.rfind('}') {
            if start <= end {
                &json_str[start..=end]
            } else {
                json_str
            }
        } else {
            json_str
        }
    } else {
        json_str
    };

    let json: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("解析搜索响应 JSON 失败: {}", e))?;

    let items = json
        .get("result")
        .and_then(|r| r.get("cmsArticleWebOld"))
        .and_then(|a| a.as_array())
        .ok_or_else(|| "未找到搜索结果，请尝试更换关键词".to_string())?;

    let mut results = Vec::new();
    for item in items {
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() || url.is_empty() {
            continue;
        }
        // 过滤反爬/登录墙站点
        if is_blocked_host(url) {
            continue;
        }
        let snippet = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let date = item.get("date").and_then(|v| v.as_str()).unwrap_or("");
        results.push(WebSearchResult {
            title: strip_em_tags(title),
            snippet: strip_em_tags(snippet),
            url: url.to_string(),
            date: date.to_string(),
        });
    }

    if results.is_empty() {
        return Err("未找到搜索结果，请尝试更换关键词".to_string());
    }

    Ok(results)
}

/// 去掉东财搜索结果中的 <em> 高亮标签
fn strip_em_tags(s: &str) -> String {
    s.replace("<em>", "").replace("</em>", "")
}

/// 判断 URL 是否属于反爬/登录墙站点
fn is_blocked_host(url: &str) -> bool {
    let lower = url.to_lowercase();
    BLOCKED_HOSTS.iter().any(|h| lower.contains(h))
}

/// 从 HTML 中智能提取正文纯文本
/// 优先级: JSON-LD articleBody → JSON 转义 HTML（腾讯新闻等）→ 常见正文容器 → meta 描述 → 整页兜底
fn extract_article(html: &str) -> String {
    // 1. 尝试 JSON-LD 中的 articleBody（很多新闻站把正文放结构化数据里）
    let jsonld_re = Regex::new(r#""articleBody"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap();
    if let Some(cap) = jsonld_re.captures(html) {
        let body = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        // JSON 中的 \n 转义还原
        let body = body.replace("\\n", "\n").replace("\\u003c", "<").replace("\\u003e", ">");
        let text = strip_html(&body);
        if text.chars().count() > 200 {
            return normalize_text(&text);
        }
    }

    // 2. JSON 内嵌转义 HTML（腾讯新闻 originContent.text 等）
    //    \u003c 是 < 的转义，出现多次说明正文以转义 HTML 形式藏在 JSON 里
    //    注意：还原后的正文仍在 <script> 里，不能移除 script
    if html.matches("\\u003c").count() >= 3 {
        let unescaped = unescape_json(html);
        let text = extract_containers(&unescaped);
        if text.chars().count() > 150 {
            return normalize_text(&text);
        }
        // 兜底：整个还原后的内容剥标签
        let text = strip_html(&unescaped);
        if text.chars().count() > 150 {
            return normalize_text(&text);
        }
    }

    extract_from_html(html)
}

/// 在纯 HTML 中提取正文（容器 → meta 描述 → 整页兜底）
fn extract_from_html(html: &str) -> String {
    // 1. 移除 script/style（包括 JSON-LD，避免影响后续解析）
    let script_re = Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
    let style_re = Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
    let text = script_re.replace_all(html, "");
    let text = style_re.replace_all(&text, "");
    let html = &text;

    // 2. 常见正文容器（按优先级）
    let text = extract_containers(html);
    if text.chars().count() > 150 {
        return normalize_text(&text);
    }

    // 3. meta description / og:description 兜底（属性顺序不固定，先抓标签再取 content）
    let meta_tag_re = Regex::new(r#"(?is)<meta[^>]*>"#).unwrap();
    let content_re = Regex::new(r#"(?i)content\s*=\s*["']([^"']*)["']"#).unwrap();
    for tag in meta_tag_re.find_iter(html) {
        let tag = tag.as_str();
        let is_desc = tag.to_lowercase().contains("description");
        if !is_desc {
            continue;
        }
        if let Some(cap) = content_re.captures(tag) {
            let text = cap.get(1).map(|m| strip_html(m.as_str())).unwrap_or_default();
            if text.chars().count() > 80 {
                return normalize_text(&text);
            }
        }
    }

    // 4. 整页兜底
    let text = strip_html(html);
    normalize_text(&text)
}

/// 尝试从常见正文容器中提取（article/main 标签或 class/id 匹配），不足 150 字符返回空串
fn extract_containers(html: &str) -> String {
    let container_re = Regex::new(
        r#"(?is)<(?:article|main)[^>]*>(.*?)</(?:article|main)>"#,
    ).unwrap();
    let class_re = Regex::new(
        r#"(?is)<(?:div|section|article)[^>]*(?:class|id)=["'][^"']*(?:article[-_]?(?:content|body|detail)|news[-_]?content|post[-_]?content|content[-_]?main|main[-_]?content|detail[-_]?content|rich_media_content|txtinfos|ContentBody|contentbox)[^"']*["'][^>]*>(.*?)</(?:div|section|article)>"#,
    ).unwrap();

    for re in [&container_re, &class_re] {
        if let Some(cap) = re.captures(html) {
            let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let text = strip_html(inner);
            if text.chars().count() > 150 {
                return normalize_text(&text);
            }
        }
    }
    String::new()
}

/// 读取 `\u` 后的 4 位十六进制；成功返回码点，失败返回已消耗的原文（用于原样回填）
fn read_hex4(chars: &mut std::str::Chars) -> Result<u32, String> {
    let hex: String = chars.by_ref().take(4).collect();
    // 不足 4 位说明转义被截断，按原文保留（否则 "12" 也会被当成合法码点）
    if hex.len() != 4 {
        return Err(hex);
    }
    u32::from_str_radix(&hex, 16).map_err(|_| hex)
}

/// 还原 JSON 字符串转义（\uXXXX、\"、\\、\n 等），用于解析内嵌转义 HTML
fn unescape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => match read_hex4(&mut chars) {
                // 高代理项：与紧跟其后的低代理项组合成增补平面字符（emoji 等多字节字符）
                Ok(hi) if (0xD800..=0xDBFF).contains(&hi) => {
                    let mut lookahead = chars.clone();
                    let combined = if lookahead.next() == Some('\\') && lookahead.next() == Some('u') {
                        match read_hex4(&mut lookahead) {
                            Ok(lo) if (0xDC00..=0xDFFF).contains(&lo) => {
                                Some(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                    match combined.and_then(char::from_u32) {
                        Some(ch) => {
                            out.push(ch);
                            chars = lookahead;
                        }
                        // 孤立代理项无法用 UTF-8 表示：用替换字符兜底，不可静默丢字
                        None => out.push('\u{FFFD}'),
                    }
                }
                Ok(lo) if (0xDC00..=0xDFFF).contains(&lo) => out.push('\u{FFFD}'),
                Ok(cp) => {
                    if let Some(ch) = char::from_u32(cp) {
                        out.push(ch);
                    }
                }
                // 非法转义原样保留（含已消耗的数字）
                Err(raw) => {
                    out.push('\\');
                    out.push('u');
                    out.push_str(&raw);
                }
            },
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// 归一化文本：压缩空白、按 char 边界安全截断
fn normalize_text(text: &str) -> String {
    let text = text.trim().to_string();

    // 压缩连续空白（多个换行→最多两个换行）
    let re = Regex::new(r"\n[ \t]*\n[ \t]*\n+").unwrap();
    let text = re.replace_all(&text, "\n\n").to_string();
    let text = text.trim().to_string();

    // 安全截断到 50000 字符（按 char 边界，避免 panic）
    const MAX_CHARS: usize = 50000;
    if text.chars().count() > MAX_CHARS {
        text.chars().take(MAX_CHARS).collect::<String>() + "\n\n...（内容过长，已截断）"
    } else {
        text
    }
}

/// 去除 HTML 标签，返回纯文本
fn strip_html(s: &str) -> String {
    // 简单去除所有 HTML 标签
    let re = Regex::new(r"<[^>]*>").unwrap();
    let text = re.replace_all(s, "");
    // 处理 HTML 实体
    let text = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    text.trim().to_string()
}
