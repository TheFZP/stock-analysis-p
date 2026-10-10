# AGENTS.md — stock-analysis 项目指令（AI 代理必读）

你正在 **stock-analysis** 项目工作：Tauri 2 + Vue 3 + Rust 的 A 股/港股桌面分析工具（数据源：腾讯财经/东方财富/同花顺，AI：DeepSeek，图表：lightweight-charts）。

## 动手前的必读顺序（每次会话开工先执行）

1. 用 read 工具**完整阅读 `PROJECT.md`**（项目架构、数据流、命令表、关键约定的唯一真源），再开始任何修改或问题排查。
2. 改动涉及 Rust 命令 / composable / skill / 文件增删时，**必须同步更新 PROJECT.md**（项目约定第 10 条）。
3. 修改 AI 提示词时注意三处位置：`src/prompts/system-prompt.md`（模板）、`src/composables/aiContext.js`（填充 + 公共常量 MARKET_RULES/buildSearchPolicy）、`src/skills/*.js`（各 skill 自带提示词段），改完同步 PROJECT.md §3.4。

## 硬性约定（违反会出 bug）

- **GBK 编码**：腾讯 API 返回 GBK，必须 `encoding_rs::GBK.decode()`（`tencent.rs`）
- **竞态保护**：切换股票的异步请求必须带请求序号（`requestSeq`）或代际守卫（`streamGeneration`），旧响应一律丢弃
- **XSS**：所有 `marked.parse` 输出必须经 `DOMPurify.sanitize` 后才能 `v-html`；外部数据插入 HTML 前先转义
- **股票代码**：A 股 6 位 / 港股 5 位 / 北交所 43|82|83|87|88|92 开头；外部来源（问财）代码必须剥离 `.SH/.SZ/.BJ` 后缀
- **AI 数据真实性**：提示词禁止模型编造数值——所有行情/资金/财务数字必须来自工具返回
- **TLS 不降级**：reqwest 禁止 `danger_accept_invalid_certs`

## 构建与验证

- 前端：`pnpm build`（vite 8，通过即视为 OK；PowerShell 下 stderr 误报 exit 1 属正常现象）
- 后端：`cd src-tauri && cargo check`（需 **Rust ≥ 1.85**；项目内 `src-tauri/.cargo/config.toml` 已内置 USTC sparse 镜像，不要删除）
- 沙箱提示：cargo/rustup 在沙箱外，运行需 `danger-full-access` 权限

## 高频文件地图

| 区域 | 入口 |
|------|------|
| 前端入口 | `src/App.vue`（窗口/定时器/联动）+ `src/components/` |
| 数据加载 | `src/composables/useXxx.js` → Rust 命令 |
| Rust 命令 | `src-tauri/src/commands.rs`（21 个命令）+ `tray_tooltip.rs`（托盘 tooltip）→ `src-tauri/src/api/*.rs` |
| 窗口权限 | `src-tauri/capabilities/default.json`（main/mini/iwencai 三个窗口） |
| AI 提示词 | `src/prompts/system-prompt.md` + `src/composables/aiContext.js` + `src/skills/` |
