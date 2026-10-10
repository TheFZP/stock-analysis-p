//! 托盘图标 tooltip 的动态更新
//!
//! 持仓数据只存在前端 localStorage，Rust 侧无法访问，因此由前端把渲染好的
//! 单行摘要推给本模块，这里只负责写入托盘 tooltip。
//!
//! Windows 的托盘 tooltip 是 NOTIFYICONDATA.szTip（WCHAR[128]，含终止符，
//! 实际可用 127 个 UTF-16 code unit），且有 Win11 24H2 实测 64 就截断的报告，
//! 所以前端按 60 的预算拼装，这里再做一次硬防线截断。
//!
//! 只有主窗口有权写入：`?mini=1` / `?iwencai=1` 加载的是同一份前端 bundle，
//! 而它们的持仓来自 localStorage 快照、永不刷新（会推出恒为 0 的盈亏），
//! 必须挡在门外，否则 tooltip 会在「正确值 / 子窗打开那一刻的旧值」之间跳变。

use std::sync::Mutex;

use tauri::{tray::TrayIcon, AppHandle, Manager, State, WebviewWindow, Wry};

/// 托盘初始 tooltip，需与 lib.rs 里 `TrayIconBuilder::tooltip(...)` 保持一致
const DEFAULT_TOOLTIP: &str = "stock-analysis";

/// tooltip 的硬上限（UTF-16 code unit）
///
/// 文档上限是 127，这里取更保守的值兜底：前端已按 60 拼装，本常量只用于
/// 防住不经前端的（或前端被改坏的）输入。
const TOOLTIP_MAX_UNITS: usize = 120;

/// 托盘 tooltip 状态：持有托盘句柄 + 上次写入的文本
///
/// `TrayIcon<R>` 是 `Send + Sync`（tauri 的 `unsafe impl`，见 src/tray/mod.rs:417），
/// 因此可以直接放进 managed state。
pub struct TrayTooltipState {
    tray: TrayIcon<Wry>,
    last: Mutex<String>,
}

/// 在 `setup()` 里、托盘创建之后调用，注册 managed state
pub fn init(app: &AppHandle, tray: TrayIcon<Wry>) {
    app.manage(TrayTooltipState {
        tray,
        last: Mutex::new(DEFAULT_TOOLTIP.to_string()),
    });
}

/// 前端推送持仓摘要文本（行情轮询后调用）
///
/// 与上次相同则直接返回，避免每一轮轮询都向 shell 发一次无谓的托盘通知。
#[tauri::command]
pub fn update_tray_tooltip(
    window: WebviewWindow,
    state: State<'_, TrayTooltipState>,
    text: String,
) -> Result<(), String> {
    // 多窗口防护：只有主窗口能写托盘（前端已有同样的守卫，这里是第二道）
    if window.label() != "main" {
        return Ok(());
    }

    let text = truncate_utf16(text.trim(), TOOLTIP_MAX_UNITS);

    let mut last = state
        .last
        .lock()
        .map_err(|_| "托盘 tooltip 状态不可用".to_string())?;

    if *last == text {
        return Ok(());
    }

    state
        .tray
        .set_tooltip(Some(&text))
        .map_err(|e| format!("设置托盘 tooltip 失败: {}", e))?;

    *last = text;
    Ok(())
}

/// 按 UTF-16 code unit 截断，保证不切在字符（代理对）中间；被截断时补省略号
fn truncate_utf16(s: &str, max_units: usize) -> String {
    if s.encode_utf16().count() <= max_units {
        return s.to_string();
    }

    // 省略号自身占 1 个 unit，先预留出来
    let budget = max_units.saturating_sub(1);
    let mut used = 0usize;
    let mut out = String::new();
    for ch in s.chars() {
        let w = ch.len_utf16();
        if used + w > budget {
            break;
        }
        used += w;
        out.push(ch);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_short_text_untouched() {
        assert_eq!(truncate_utf16("持仓3只 +2.15%", 60), "持仓3只 +2.15%");
    }

    #[test]
    fn truncates_on_char_boundary_and_appends_ellipsis() {
        // 10 个汉字 + 上限 5 → 4 个汉字 + 省略号
        assert_eq!(truncate_utf16("一二三四五六七八九十", 5), "一二三四…");
        assert_eq!(truncate_utf16("一二三四五六七八九十", 5).encode_utf16().count(), 5);
    }

    #[test]
    fn never_splits_a_surrogate_pair() {
        // 每个 emoji 占 2 个 UTF-16 unit、1 个 char
        let s = "😀😀😀";
        assert_eq!(s.encode_utf16().count(), 6);
        // 上限 3 → budget 2 → 只能放下 1 个 emoji
        let out = truncate_utf16(s, 3);
        assert_eq!(out, "😀…");
        assert_eq!(out.encode_utf16().count(), 3);
    }

    #[test]
    fn handles_exact_limit() {
        assert_eq!(truncate_utf16("一二三四五", 5), "一二三四五");
    }
}
