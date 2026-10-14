//! 本地历史库（SQLite / rusqlite）
//!
//! 落库内容：行情快照 / 日K（按周期）/ 资金流向 / 信号事件 / 提醒事件 / 自选变更
//!
//! 设计约束（见 PROJECT.md 约定 18）：
//!   - 库未初始化或 SQL 失败时只打印 stderr，**绝不影响**原命令返回（落库是尽力而为的旁路）
//!   - 行情快照按 code 节流（>= 60s 才写），避免 30s 级批量刷新产生海量行
//!   - 事件类表以本地日期去重/归档，日期统一用 SQLite 内建 `date('now','+8 hours')`（UTC+8）计算，
//!     不引入 chrono，也不依赖前端传入日期
//!   - 启动时按保留天数清理（行情快照 30 天、事件类 180 天），避免库无限增长

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection};

use crate::types::{
    AlertEventInput, DbStats, KlineItem, MoneyFlow, MoneyFlowHistoryItem, SignalEventInput,
    StockQuote,
};

const DB_FILENAME: &str = "stock-analysis.db";
const SCHEMA_VERSION: i64 = 1;
/// 同一只股票的行情快照最小写入间隔（秒）
const QUOTE_MIN_INTERVAL_SECS: i64 = 60;
/// 行情快照保留天数
const QUOTE_RETENTION_DAYS: i64 = 30;
/// 事件类表（信号/提醒/自选变更）保留天数
const EVENT_RETENTION_DAYS: i64 = 180;

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();
static DB_PATH: OnceLock<PathBuf> = OnceLock::new();
static QUOTE_LAST_TS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

/// 当前 Unix 秒
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn lock_db() -> Option<MutexGuard<'static, Connection>> {
    match DB.get() {
        Some(mutex) => match mutex.lock() {
            Ok(guard) => Some(guard),
            Err(e) => {
                eprintln!("[db] 连接锁中毒: {e}");
                None
            }
        },
        None => None,
    }
}

/// 静默落库：库未初始化或 SQL 失败时只记录日志，不向外抛错
fn silent<F, T>(what: &str, f: F) -> Option<T>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let conn = lock_db()?;
    match f(&conn) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("[db] 落库失败（{what}）: {e}");
            None
        }
    }
}

/// 需要向调用方报告错误的落库/查询入口（新命令用）
fn fallible<F, T>(what: &str, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let conn = lock_db().ok_or_else(|| "本地历史库未初始化".to_string())?;
    f(&conn).map_err(|e| format!("{what}: {e}"))
}

// ---------------------------------------------------------------- 初始化

/// 打开（必要时创建）本地库并完成迁移与清理。
/// 在 Tauri `.setup()` 中调用；失败不阻断应用启动。
pub fn init(app_data_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let path = app_data_dir.join(DB_FILENAME);
    let conn = Connection::open(&path).map_err(|e| format!("打开本地库失败: {e}"))?;

    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(|e| format!("初始化 WAL 失败: {e}"))?;
    migrate(&conn).map_err(|e| format!("迁移 schema 失败: {e}"))?;
    if let Err(e) = prune(&conn) {
        eprintln!("[db] 历史清理失败: {e}");
    }

    let _ = DB_PATH.set(path.clone());
    DB.set(Mutex::new(conn))
        .map_err(|_| "本地库重复初始化".to_string())?;
    Ok(path)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS quote_snapshot (
            ts INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
            price REAL NOT NULL DEFAULT 0, prev_close REAL NOT NULL DEFAULT 0,
            open REAL NOT NULL DEFAULT 0, high REAL NOT NULL DEFAULT 0, low REAL NOT NULL DEFAULT 0,
            change_pct REAL NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 0,
            turnover REAL NOT NULL DEFAULT 0, turnover_rate REAL NOT NULL DEFAULT 0,
            pe REAL NOT NULL DEFAULT 0, amplitude REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (code, ts)
        );

        CREATE TABLE IF NOT EXISTS kline (
            code TEXT NOT NULL, period TEXT NOT NULL, date TEXT NOT NULL,
            open REAL NOT NULL DEFAULT 0, high REAL NOT NULL DEFAULT 0,
            low REAL NOT NULL DEFAULT 0, close REAL NOT NULL DEFAULT 0,
            volume REAL NOT NULL DEFAULT 0, turnover REAL NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (code, period, date)
        );

        CREATE TABLE IF NOT EXISTS money_flow (
            code TEXT NOT NULL, date TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0,
            main_net REAL NOT NULL DEFAULT 0, main_pct REAL NOT NULL DEFAULT 0,
            super_large_net REAL NOT NULL DEFAULT 0, large_net REAL NOT NULL DEFAULT 0,
            medium_net REAL NOT NULL DEFAULT 0, small_net REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (code, date)
        );

        CREATE TABLE IF NOT EXISTS signal_event (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL, date TEXT NOT NULL, code TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
            time TEXT NOT NULL DEFAULT '', dir TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0,
            UNIQUE (code, date, kind, name, time)
        );
        CREATE INDEX IF NOT EXISTS idx_signal_event_code ON signal_event(code, date);

        CREATE TABLE IF NOT EXISTS alert_event (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL, date TEXT NOT NULL, code TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
            price REAL NOT NULL DEFAULT 0, target REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_alert_event_code ON alert_event(code, date);

        CREATE TABLE IF NOT EXISTS watchlist_change (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL, date TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT '', code TEXT NOT NULL, name TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_watchlist_change_code ON watchlist_change(code, ts);
        "#,
    )?;

    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(())
}

fn prune(conn: &Connection) -> rusqlite::Result<()> {
    let quote_cutoff = now_secs() - QUOTE_RETENTION_DAYS * 86400;
    let event_cutoff = now_secs() - EVENT_RETENTION_DAYS * 86400;
    conn.execute("DELETE FROM quote_snapshot WHERE ts < ?1", params![quote_cutoff])?;
    for table in ["signal_event", "alert_event", "watchlist_change"] {
        conn.execute(&format!("DELETE FROM {table} WHERE ts < ?1"), params![event_cutoff])?;
    }
    Ok(())
}

// ---------------------------------------------------------------- 写入

/// 落行情快照（按 code 60s 节流）。批量接口每轮调用一次。
pub fn record_quotes(quotes: &[StockQuote]) {
    if quotes.is_empty() || DB.get().is_none() {
        return;
    }
    let now = now_secs();
    let pending: Vec<&StockQuote> = {
        let mut last = match QUOTE_LAST_TS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        {
            Ok(guard) => guard,
            Err(_) => return,
        };
        quotes
            .iter()
            .filter(|q| {
                if q.code.is_empty() {
                    return false;
                }
                let prev = last.get(&q.code).copied().unwrap_or(0);
                if now - prev < QUOTE_MIN_INTERVAL_SECS {
                    return false;
                }
                last.insert(q.code.clone(), now);
                true
            })
            .collect()
    };
    if pending.is_empty() {
        return;
    }

    let written = pending.len();
    let ok = silent("行情快照", |conn| {
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR REPLACE INTO quote_snapshot
                 (ts, code, name, price, prev_close, open, high, low, change_pct, volume, turnover, turnover_rate, pe, amplitude)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )?;
            for q in &pending {
                stmt.execute(params![
                    now,
                    q.code,
                    q.name,
                    q.price,
                    q.prev_close,
                    q.open,
                    q.high,
                    q.low,
                    q.change_pct,
                    q.volume,
                    q.turnover,
                    q.turnover_rate,
                    q.pe,
                    q.amplitude,
                ])?;
            }
        }
        tx.commit()
    });

    // 写入失败时回退节流时间戳，下一轮可重试
    if ok.is_none() {
        if let Some(mutex) = QUOTE_LAST_TS.get() {
            if let Ok(mut last) = mutex.lock() {
                for q in &pending {
                    last.insert(q.code.clone(), 0);
                }
            }
        }
        eprintln!("[db] 本轮 {written} 条行情快照未落库");
    }
}

/// 落 K 线（整体 upsert，覆盖最新一根的变化）
pub fn record_kline(code: &str, period: &str, items: &[KlineItem]) {
    if code.is_empty() || items.is_empty() {
        return;
    }
    let now = now_secs();
    silent("K 线", |conn| {
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR REPLACE INTO kline
                 (code, period, date, open, high, low, close, volume, turnover, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for item in items {
                if item.date.is_empty() {
                    continue;
                }
                stmt.execute(params![
                    code,
                    period,
                    item.date,
                    item.open,
                    item.high,
                    item.low,
                    item.close,
                    item.volume,
                    item.turnover,
                    now,
                ])?;
            }
        }
        tx.commit()
    });
}

/// 落当日资金流向（同一交易日覆盖写入）
pub fn record_money_flow(code: &str, flow: &MoneyFlow) {
    if code.is_empty() {
        return;
    }
    let now = now_secs();
    silent("资金流向", |conn| {
        conn.execute(
            "INSERT INTO money_flow
             (code, date, ts, main_net, main_pct, super_large_net, large_net, medium_net, small_net)
             VALUES (?1, date('now', '+8 hours'), ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(code, date) DO UPDATE SET
                ts = excluded.ts, main_net = excluded.main_net, main_pct = excluded.main_pct,
                super_large_net = excluded.super_large_net, large_net = excluded.large_net,
                medium_net = excluded.medium_net, small_net = excluded.small_net",
            params![
                code,
                now,
                flow.main_net_inflow,
                flow.main_net_pct,
                flow.super_large_net,
                flow.large_net,
                flow.medium_net,
                flow.small_net,
            ],
        )?;
        Ok(())
    });
}

/// 落资金流向历史（按 item.date 写入）
pub fn record_money_flow_history(code: &str, items: &[MoneyFlowHistoryItem]) {
    if code.is_empty() || items.is_empty() {
        return;
    }
    let now = now_secs();
    silent("资金流向历史", |conn| {
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR REPLACE INTO money_flow
                 (code, date, ts, main_net, main_pct, super_large_net, large_net, medium_net, small_net)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8)",
            )?;
            for item in items {
                if item.date.is_empty() {
                    continue;
                }
                stmt.execute(params![
                    code,
                    item.date,
                    now,
                    item.main_net_inflow,
                    item.super_large_net,
                    item.large_net,
                    item.medium_net,
                    item.small_net,
                ])?;
            }
        }
        tx.commit()
    });
}

/// 落信号事件：同 (code, 日期, 类型, 名称, 时间锚点) 只记一条（INSERT OR IGNORE）
pub fn record_signal_events(events: &[SignalEventInput]) -> Result<usize, String> {
    if events.is_empty() {
        return Ok(0);
    }
    let now = now_secs();
    fallible("信号事件", |conn| {
        let tx = conn.unchecked_transaction()?;
        let mut inserted = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO signal_event
                 (ts, date, code, kind, name, time, dir, detail, price)
                 VALUES (?1, date('now', '+8 hours'), ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for event in events {
                if event.code.is_empty() || event.name.is_empty() {
                    continue;
                }
                inserted += stmt.execute(params![
                    now,
                    event.code,
                    event.kind,
                    event.name,
                    event.time,
                    event.dir,
                    event.detail,
                    event.price,
                ])?;
            }
        }
        tx.commit()?;
        Ok(inserted)
    })
}

/// 落提醒事件（每次通知成功记一条，不去重：同一提醒多次触发本身是有效信息）
pub fn record_alert_events(events: &[AlertEventInput]) -> Result<usize, String> {
    if events.is_empty() {
        return Ok(0);
    }
    let now = now_secs();
    fallible("提醒事件", |conn| {
        let tx = conn.unchecked_transaction()?;
        let mut inserted = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO alert_event (ts, date, code, kind, message, price, target)
                 VALUES (?1, date('now', '+8 hours'), ?2, ?3, ?4, ?5, ?6)",
            )?;
            for event in events {
                if event.code.is_empty() {
                    continue;
                }
                inserted += stmt.execute(params![
                    now,
                    event.code,
                    event.kind,
                    event.message,
                    event.price,
                    event.target,
                ])?;
            }
        }
        tx.commit()?;
        Ok(inserted)
    })
}

/// 落自选变更
pub fn record_watchlist_change(action: &str, code: &str, name: &str) -> Result<(), String> {
    if code.is_empty() {
        return Ok(());
    }
    let now = now_secs();
    fallible("自选变更", |conn| {
        conn.execute(
            "INSERT INTO watchlist_change (ts, date, action, code, name)
             VALUES (?1, date('now', '+8 hours'), ?2, ?3, ?4)",
            params![now, action, code, name],
        )?;
        Ok(())
    })
}

// ---------------------------------------------------------------- 查询

/// 读取本地 K 线（按日期升序，最多 limit 根，取最近 limit 根）
pub fn query_kline(code: &str, period: &str, limit: u32) -> Result<Vec<KlineItem>, String> {
    let limit = limit.clamp(1, 2000) as i64;
    fallible("读取 K 线", |conn| {
        let mut stmt = conn.prepare(
            "SELECT date, open, close, high, low, volume, turnover FROM kline
             WHERE code = ?1 AND period = ?2 ORDER BY date DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![code, period, limit], |row| {
            Ok(KlineItem {
                date: row.get(0)?,
                open: row.get(1)?,
                close: row.get(2)?,
                high: row.get(3)?,
                low: row.get(4)?,
                volume: row.get(5)?,
                turnover: row.get(6)?,
            })
        })?;
        let mut items: Vec<KlineItem> = rows.collect::<rusqlite::Result<_>>()?;
        items.reverse();
        Ok(items)
    })
}

fn scalar_i64(conn: &Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get(0))
}

fn scalar_str(conn: &Connection, sql: &str) -> rusqlite::Result<String> {
    conn.query_row(sql, [], |row| row.get::<_, Option<String>>(0))
        .map(|v| v.unwrap_or_default())
}

/// 本地库概况（行数 / 日期范围 / 文件大小），供回测面板展示
pub fn stats() -> Result<DbStats, String> {
    let mut out = fallible("读取库统计", |conn| {
        Ok(DbStats {
            path: String::new(),
            size_bytes: 0,
            quote_rows: scalar_i64(conn, "SELECT COUNT(*) FROM quote_snapshot")?,
            quote_codes: scalar_i64(conn, "SELECT COUNT(DISTINCT code) FROM quote_snapshot")?,
            quote_first_date: scalar_str(
                conn,
                "SELECT date(MIN(ts), 'unixepoch', '+8 hours') FROM quote_snapshot",
            )?,
            quote_last_date: scalar_str(
                conn,
                "SELECT date(MAX(ts), 'unixepoch', '+8 hours') FROM quote_snapshot",
            )?,
            kline_rows: scalar_i64(conn, "SELECT COUNT(*) FROM kline")?,
            kline_codes: scalar_i64(conn, "SELECT COUNT(DISTINCT code) FROM kline")?,
            kline_first_date: scalar_str(conn, "SELECT MIN(date) FROM kline")?,
            kline_last_date: scalar_str(conn, "SELECT MAX(date) FROM kline")?,
            money_rows: scalar_i64(conn, "SELECT COUNT(*) FROM money_flow")?,
            signal_rows: scalar_i64(conn, "SELECT COUNT(*) FROM signal_event")?,
            alert_rows: scalar_i64(conn, "SELECT COUNT(*) FROM alert_event")?,
            watchlist_rows: scalar_i64(conn, "SELECT COUNT(*) FROM watchlist_change")?,
        })
    })?;

    if let Some(path) = DB_PATH.get() {
        out.path = path.to_string_lossy().to_string();
        out.size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    Ok(out)
}
