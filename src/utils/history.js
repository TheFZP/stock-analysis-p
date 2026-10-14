/**
 * 本地历史库写入 — Rust 端 db.rs 的落库旁路
 *
 * 全部为 fire-and-forget：非 Tauri 环境、库未初始化或写盘失败都只静默忽略，
 * 绝不影响调用方主流程（与后端 db::silent 的设计一致）。
 */
import { invoke } from "@tauri-apps/api/core";

/** 静默发送，忽略一切失败 */
function fire(cmd, args) {
  invoke(cmd, args).catch(() => {});
}

/**
 * 落信号事件。后端按 (code, 日期, 类型, 名称, 时间锚点) 去重，重复调用是安全的。
 * @param {string} code 股票代码
 * @param {string} kind 来源分类，如 trap / volume / ma / t0
 * @param {Array<object>} signals 计算得到的信号数组（取 name/time/desc/action 等字段，缺失即留空）
 */
export function recordSignalEvents(code, kind, signals) {
  if (!code || !Array.isArray(signals) || signals.length === 0) return;
  const events = [];
  for (const s of signals) {
    const name = typeof s?.name === "string" ? s.name.trim() : "";
    if (!name) continue;
    events.push({
      code,
      kind: kind || "",
      name,
      time: typeof s?.time === "string" ? s.time : "",
      dir: typeof s?.dir === "string" ? s.dir : (typeof s?.action === "string" ? s.action : ""),
      detail: typeof s?.detail === "string" ? s.detail : (typeof s?.desc === "string" ? s.desc : ""),
      price: Number(s?.price) || 0,
    });
  }
  if (events.length === 0) return;
  fire("record_signal_events", { events });
}

/**
 * 落提醒事件（通知成功发送后调用；后端不去重，同一提醒多次触发都会记录）
 * @param {{code:string,kind:string,title?:string,body?:string,price?:number,target?:number}} meta
 */
export function recordAlertEvent(meta) {
  const code = meta?.code;
  if (!code) return;
  const message = [meta.title, meta.body].filter(Boolean).join(" ");
  fire("record_alert_events", {
    events: [
      {
        code,
        kind: meta.kind || "",
        message,
        price: Number(meta.price) || 0,
        target: Number(meta.target) || 0,
      },
    ],
  });
}

/**
 * 落自选变更
 * @param {"add"|"remove"} action
 * @param {string} code
 * @param {string} [name]
 */
export function recordWatchlistChange(action, code, name = "") {
  if (!action || !code) return;
  fire("record_watchlist_change", { action, code, name: name || "" });
}
