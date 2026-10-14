# AGENTS.md — stock-analysis 项目指令（AI 代理必读）

**项目**：Tauri 2 + Vue 3 + Rust 的 A 股/港股桌面分析工具（行情：腾讯/东财/同花顺 · AI：DeepSeek · 图表：lightweight-charts）。

本文件是每次会话自动注入的**短索引**：只放开工顺序、铁律与导航；细节一律以 `PROJECT.md`（唯一真源）为准。

## 开工顺序

1. 先完整读 `PROJECT.md`——架构、数据流、命令表、本地历史库、回测口径、Skills 与设计约束。
2. 改动 Rust 命令 / composable / skill / 文件增删后，同步更新 `PROJECT.md`（§7.9）。
3. 改 AI 提示词时三处都要动：`src/prompts/system-prompt.md`（模板）、`src/composables/aiContext.js`（填充 + `MARKET_RULES`/`buildSearchPolicy`）、`src/skills/*.js`（各段），改完同步 `PROJECT.md` §3.4。

## 硬性约定（违反即出 bug，细则见 `PROJECT.md` §7）

- **GBK**：腾讯接口返回 GBK，Rust 端必须 `encoding_rs::GBK.decode()`（`tencent.rs`）
- **竞态**：切换股票的异步请求必须带请求序号（`requestSeq`）或代际守卫（`streamGeneration`），旧响应一律丢弃；项目内没有通用 fetcher 封装
- **XSS / 传输安全**：`marked.parse` 输出必须经 `DOMPurify.sanitize` 才能 `v-html`，外部数据先转义；reqwest 禁止 `danger_accept_invalid_certs`
- **股票代码**：A 股 6 位 / 港股 5 位 / 北交所 43|82|83|87|88|92 开头；外部来源（问财）代码必须剥离 `.SH/.SZ/.BJ` 后缀
- **AI 数据真实性**：行情/资金/财务数值必须来自工具返回，禁止模型编造
- **市场判定唯一入口**：盘中/交易日只走 `src/utils/marketTime.js`，不要在组件里重写时段常量
- **刷新失败保留旧数据**：不清空已有数据（仅换标的/换周期时清空），置 `stale=true` 交 `src/components/DataFreshness.vue` 标注
- **窗口不可见必降频**：隐藏信号 = `document.visibilitychange` + Rust `main-window-hidden`/`main-window-shown`；新增轮询必须走 `App.vue` 的 `effectiveInterval()`
- **本地历史库是旁路**：`db.rs` 的 `record_*` 只 eprintln，绝不向命令层返错；新埋点写 `db.rs` + 命令转发，前端走 `src/utils/history.js`
- **回测口径**：`useSignalBacktest` 只回测日线级规则（T+0/量价陷阱等日内信号依赖分时，无法用日 K 回测）；UI/文档必须标注「非重叠交易 + 固定持有期 + 样本 <10 笔仅供参考」
- **K 线周期口径**：`klineData` 为全应用共享且可切周期（m5/m15/m30/m60/day/week/month），消费它的计算与提示词必须带上周期、标签口径取自 `src/utils/klinePeriod.js`，禁止硬编码「日K / 5 日均线」；只吃日K的逻辑（T+0 趋势、MACD 背离）走 `src/utils/klineCache.js` 取日K，取不到就跳过并披露
- **筹码口径**：筹码分布是成交量按价格分布的估算，换手率衰减**仅日K + 取到换手率**时启用（`chipOptionsFromQuote`，衰减系数默认 1）；未启用时 UI（`ChipDistribution.vue`）与 AI 注入（`aiContext.js`）必须按 `chipData.decayed` 标「未做换手率衰减」，禁止无标注展示筹码峰/获利比例

## 构建与验证

- 前端：`pnpm build`（PowerShell 下 stderr 误报 exit 1 属正常，以 `✓ built` 为准）
- 后端：`cd src-tauri && cargo check`（需 **Rust ≥ 1.85**）
- 依赖已全量缓存，可离线构建；`src-tauri/.cargo/config.toml` 的 USTC 镜像勿删。网络/代理与 `vite.config.js` 调优说明见 `PROJECT.md` §6

## 导航（文件全景见 `PROJECT.md` §1）

| 区域 | 入口 |
|------|------|
| 前端入口 | `src/App.vue`（窗口/定时器/跨窗口联动）+ `src/components/` |
| 数据加载 | `src/composables/useXxx.js` → 命令层 `src-tauri/src/commands.rs` → `src-tauri/src/api/*.rs` |
| Rust 命令 | `src-tauri/src/commands.rs`（26 个命令）+ `tray_tooltip.rs`（托盘 tooltip） |
| 本地历史库 | `src-tauri/src/db.rs`（旁路埋点）+ 前端 `src/utils/history.js` |
| 窗口权限 | `src-tauri/capabilities/default.json`（main/mini/iwencai 三个窗口） |
| AI 提示词 | `src/prompts/system-prompt.md` + `src/composables/aiContext.js` + `src/skills/` |
