// Stock Analysis - Tauri backend
//
// Modules:
//   types     - data structures (StockQuote, KlineItem, IndustryData, etc.)
//   helpers   - utility functions (code conversion, JSON parsing)
//   api       - API client functions (Tencent, East Money)
//   db        - local history store (SQLite via rusqlite)
//   commands  - Tauri command handlers

mod api;
pub mod commands;
pub mod db;
pub mod helpers;
mod tray_tooltip;
pub mod types;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

/// 前端 App.vue 约定：主窗口隐藏/恢复时通知前端（隐藏期间降频、恢复可见立即补刷）
const EVENT_WINDOW_HIDDEN: &str = "main-window-hidden";
const EVENT_WINDOW_SHOWN: &str = "main-window-shown";

/// 恢复/聚焦主窗口（托盘双击、左键单击、菜单项共用）
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit(EVENT_WINDOW_SHOWN, ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单例：重复启动时聚焦已有窗口（主窗口优先，迷你窗口次之），并退出新实例
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if app.get_webview_window("main").is_some() {
                show_main_window(app);
            } else if let Some(window) = app.get_webview_window("mini") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 本地历史库：初始化失败只记录日志，不阻断应用启动（落库为旁路）
            match app.path().app_data_dir() {
                Ok(dir) => match db::init(&dir) {
                    Ok(path) => println!("[db] 本地历史库就绪: {}", path.display()),
                    Err(e) => eprintln!("[db] 初始化失败，本次运行不落库: {e}"),
                },
                Err(e) => eprintln!("[db] 无法定位应用数据目录，本次运行不落库: {e}"),
            }

            // 系统托盘：右键菜单含「显示主窗口 / 退出」，左键单击恢复主窗口
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("bundle icon missing").clone())
                .tooltip("stock-analysis")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 托盘 tooltip 动态更新（持仓摘要）：state 持有托盘句柄，供前端推送命令使用
            tray_tooltip::init(app.handle(), tray);
            Ok(())
        })
        // 关闭主窗口 → 隐藏到托盘（不退出）；迷你窗口关闭仍为正常关闭
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    // 通知前端降频：WebView2 的 document.visibilityState 不保证随窗口隐藏同步
                    let _ = window.emit(EVENT_WINDOW_HIDDEN, ());
                }
            }
        })

        .invoke_handler(tauri::generate_handler![
            commands::get_stock_industry,
            commands::get_stock_intraday,
            commands::get_stock_kline,
            commands::get_stock_quote,
            commands::get_stock_quotes_batch,
            commands::get_market_indices,
            commands::search_stocks,
            commands::get_stock_money_flow,
            commands::get_stock_money_flow_history,
            commands::get_hot_list,
            commands::get_trading_calendar,
            commands::call_llm,
            commands::call_llm_stream,
            commands::read_user_profile,
            commands::save_user_profile,
            commands::web_search,
            commands::web_fetch,
            commands::get_fx_rate,
            commands::get_iwencai_robot,
            commands::get_app_version,
            commands::check_for_update,
            tray_tooltip::update_tray_tooltip,
            commands::record_signal_events,
            commands::record_alert_events,
            commands::record_watchlist_change,
            commands::get_kline_history,
            commands::get_db_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
