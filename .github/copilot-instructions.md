# stock-analysis — AI 项目上下文

本文件只是**入口索引**，不重复维护细节；完整内容以仓库内文档为准：

- `PROJECT.md` — 唯一真源：架构、数据流、26 个 Tauri 命令、本地历史库（SQLite）、回测口径、Skills、设计约定
- `AGENTS.md` — 铁律清单 + 构建验证命令

## 开工顺序

1. **先完整阅读 `PROJECT.md`**，再动手改代码或排查问题。
2. 涉及 Rust 命令 / composable / skill / 文件增删时，同步更新 `PROJECT.md` 对应章节（§3.1 / §3.2 / §4.1）。
3. AI 提示词分三处维护：`src/prompts/system-prompt.md`、`src/composables/aiContext.js`、`src/skills/*.js`；改完同步 `PROJECT.md` §3.4。

## 验证

- 前端：`pnpm build`（PowerShell 下 stderr 误报 exit 1 属正常现象）
- Rust：`cd src-tauri; cargo check`（勿改 `src-tauri/.cargo/config.toml` 的 USTC 镜像，勿换源；依赖已全量缓存，可离线编译）
- 每新增/修改文件后逐项自检：逻辑 bug（边界 / 空值 / 类型 / 竞态）、死代码与调试残留、风格与既有模式一致

## 硬性约定

完整清单见 `PROJECT.md` §7（22 条）与 `AGENTS.md`「硬性约定」；改动时最易踩的几条：腾讯 API 是 **GBK**（须 `encoding_rs::GBK.decode()`）；切换股票的异步请求必须带请求序号 / 代际守卫；`marked.parse` 输出必须经 `DOMPurify.sanitize` 才能 `v-html`；刷新失败**保留旧数据**并置 `stale=true`；市场判定只走 `src/utils/marketTime.js`；本地历史库落库失败必须静默旁路；筹码分布是估算值——换手率衰减仅在日K且取到换手率时启用，UI 与 AI 注入都必须标注实际口径。
