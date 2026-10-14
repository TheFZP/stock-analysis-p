/**
 * iwencaiClient — 问财凭证与查询的共享模块
 *
 * 供两处复用：
 * 1. useIwencaiRobot（问财独立窗口）
 * 2. skills/IwencaiSelect（AI 工具 stock_screener）
 *
 * 关键机制：问财接口需要 Cookie `v`（chameleon.js 本地生成）。
 * Tauri WebView 是真实浏览器环境，动态注入本地打包的 chameleon.js 即可生成有效 v。
 * - ensureV()：注入 chameleon.js → 轮询 document.cookie 读取 v（TTL 10 分钟）
 * - queryIwencai()：携带 v 调用 Rust get_iwencai_robot，403 风控自动换 v 重试一次
 * - 会话级查询缓存：相同问题（归一化）在缓存期内复用结果，避免 AI 重复调用触发限流
 */

import { invoke } from "@tauri-apps/api/core";

/** v cookie 缓存（值 + 时间戳），TTL 10 分钟 */
let vCache = { value: "", ts: 0 };
const V_TTL = 10 * 60 * 1000;

/** chameleon.js 注入幂等标记 */
let chameleonInjected = false;

/** 会话级查询缓存：归一化 question → { data, ts }（TTL 10 分钟，上限 50 条） */
const QUERY_CACHE_TTL = 10 * 60 * 1000;
const QUERY_CACHE_MAX = 50;
const queryCache = new Map();

/** 从 document.cookie 提取 v 值 */
function readVCookie() {
  const m = document.cookie.match(/(?:^|;\s*)v=([^;]+)/);
  return m ? m[1] : "";
}

/**
 * 确保 chameleon.js 已执行并返回有效 v
 * chameleon.js 加载后即开始轮询写入 v（~300ms 刷新一次）
 */
export async function ensureV() {
  // 命中缓存直接用
  if (vCache.value && Date.now() - vCache.ts < V_TTL) return vCache.value;

  // 注入 chameleon.js（本地静态资源，CSP script-src 'self' 允许）
  if (!chameleonInjected) {
    const s = document.createElement("script");
    s.src = "/chameleon.js";
    s.async = true;
    document.head.appendChild(s);
    chameleonInjected = true;
  }

  // 轮询等待 v 出现（最多 8 秒）
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const v = readVCookie();
    if (v) {
      vCache = { value: v, ts: Date.now() };
      return v;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("无法获取问财验证凭证（v），请检查网络后重试");
}

/**
 * 重置 v 缓存与注入标记。
 * 下次 ensureV 会重新注入 chameleon.js 并读取最新 cookie（v 失效后调用）。
 */
export function resetV() {
  vCache = { value: "", ts: 0 };
  chameleonInjected = false;
}

/** 判断错误是否为风控/限流（Nginx 403 或 -9138 业务码），此类错误换新 v 重试可恢复。
 *  Rust 端已对风控场景附加结构化标记 [RATE_LIMITED]，优先匹配标记；
 *  不再匹配裸 "v"（invoke 错误文案几乎总含字母 v，会导致误判并重置凭证缓存） */
function isRateLimited(msg) {
  return (
    msg.includes("RATE_LIMITED") ||
    msg.includes("403") ||
    msg.includes("forbidden") ||
    msg.includes("限流") ||
    msg.includes("-9138")
  );
}

/** 判断错误是否与凭证 v 有关（凭证获取失败 / 风控限流，需重置 v 后重试）。
 *  供窗口侧判断是否提示「凭证失效」并清空凭证缓存，绝不可匹配裸 "v"。 */
export function isVCredentialError(msg) {
  return isRateLimited(msg) || msg.includes("验证凭证");
}

/** 归一化查询语句（去空白、小写），用于缓存键 */
function normalizeQuestion(q) {
  return String(q || "").replace(/\s+/g, "").toLowerCase();
}

/**
 * 问财自然语言选股查询（带会话缓存 + 403 自动换 v 重试）
 * @param {string} question 问财查询语句
 * @param {number} page 页码（服务端 page 实际被忽略，perpage ≤ 100）
 * @param {number} perpage 每页行数
 * @returns {Promise<Object>} 问财原始结果 { columns, datas, condition, token, rowCount, question }
 * @throws 非限流错误原样抛出；两次尝试均限流时抛出最后一次错误
 */
export async function queryIwencai(question, page = 1, perpage = 50) {
  // 缓存键必须包含 perpage：问财服务端忽略 page（翻页在本地进行），但 perpage 会改变
  // 返回行数（窗口 50 行 / AI 工具 100 行）。若只按 question 做键，先发起的 perpage=50
  // 会把结果写入缓存，导致 AI 只拿到 50 行却以为已获得完整列表。
  const key = `${normalizeQuestion(question)}|${perpage}`;

  // 会话缓存命中（含 AI 重复调用场景，避免触发限流）
  const cached = queryCache.get(key);
  if (cached && Date.now() - cached.ts < QUERY_CACHE_TTL) {
    return cached.data;
  }

  let result;
  try {
    const v = await ensureV();
    result = await invoke("get_iwencai_robot", { question, page, perpage, v });
  } catch (e) {
    const msg = String(e);
    // 风控 403：同一 v 连续请求多次会触发 Nginx 限流（实测约 4-6 次后 403），
    // 换新 v 立即恢复。重置凭证 + 短暂延迟后重试一次。
    if (isRateLimited(msg)) {
      resetV();
      await new Promise((r) => setTimeout(r, 1500));
      const v2 = await ensureV();
      result = await invoke("get_iwencai_robot", { question, page, perpage, v: v2 });
    } else {
      throw e;
    }
  }

  // 仅缓存成功结果；LRU 上限防无界增长
  if (queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest != null) queryCache.delete(oldest);
  }
  queryCache.set(key, { data: result, ts: Date.now() });
  return result;
}
