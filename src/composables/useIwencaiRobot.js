/**
 * useIwencaiRobot — 问财自然语言选股（get-robot-data）
 *
 * 凭证与查询核心已下沉到 iwencaiClient.js（ensureV / resetV / isRateLimited / isVCredentialError / queryIwencai），
 * 本文件只保留窗口侧的响应式状态（data/loading/error）、竞态保护与结果规范化工具。
 * 共享模块同样服务于 AI 工具 stock_screener（skills/IwencaiSelect.js）。
 */

import { ref } from "vue";
import { queryIwencai, resetV, ensureV, isVCredentialError } from "./iwencaiClient.js";

/**
 * 问财自然语言选股
 * @returns {{ data, loading, error, search }}
 */
export function useIwencaiRobot() {
  const data = ref(null); // { columns, datas, condition, token, rowCount, question }
  const loading = ref(false);
  const error = ref("");
  const vError = ref(false); // v 获取失败标记（用于 UI 提示）

  let requestSeq = 0; // 竞态保护：只接受最后一次请求结果

  async function search(question, page = 1, perpage = 50) {
    if (!question || !question.trim()) return;
    const seq = ++requestSeq;
    loading.value = true;
    error.value = "";
    vError.value = false;
    try {
      // 403 风控换 v 重试、会话级查询缓存在 iwencaiClient 内部处理
      const result = await queryIwencai(question, page, perpage);
      if (seq !== requestSeq) return;
      data.value = result;
    } catch (e) {
      if (seq !== requestSeq) return;
      const msg = String(e);
      // 仅凭证/风控类错误才提示「凭证失效」并重置缓存：
      // 不可匹配裸 "v"（invoke 错误文案几乎总含字母 v，会误判并让 chameleon.js 反复重新注入）
      if (isVCredentialError(msg)) {
        vError.value = true;
        // v 可能已过期：重置缓存，下次搜索重新注入 chameleon.js 生成新凭证
        resetV();
      }
      error.value = msg;
      data.value = null;
    } finally {
      if (seq === requestSeq) loading.value = false;
    }
  }

  return { data, loading, error, vError, search, warmV: ensureV };
}

/**
 * 从问财结果中提取关键信息
 * 真实结构：columns 为列定义，datas 为对象数组（每行是 中文列名 → 值 的 map）
 * @param {object} result — { columns, datas }
 * @returns {{ columns: Array<{label, key, name, unit, type}>, rows: Array<Record<string, any>> }}
 */
export function normalizeIwencaiResult(result) {
  if (!result?.columns || !result?.datas) return { columns: [], rows: [] };
  // 按列标识去重：问财偶发返回重复列（如同名条件出现两次），按 key 保首个
  const seen = new Set();
  const columns = result.columns.filter((col) => {
    const id = col.key ?? col.label ?? col.name;
    if (id == null || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { columns, rows: result.datas };
}

/**
 * 从行数据中解析股票代码
 * 问财格式："股票代码": "301565.SZ"（带后缀），"code": "301565"（6 位纯数字）
 * @returns {{ code: string, market: string } | null}
 */
export function parseIwencaiCode(row) {
  // 优先取带后缀的 股票代码 字段，回退 6 位纯数字 code
  const raw = String(row["股票代码"] ?? row.code ?? "");
  if (!raw) return null;
  const clean = raw.trim();
  const m = clean.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/i);
  if (!m) return null;
  const code = m[1];
  const suffix = m[2] ? m[2].toUpperCase() : null;
  let market = suffix ? (suffix === "SH" ? "SH" : "SZ") : code.startsWith("6") ? "SH" : "SZ";
  if (suffix === "BJ") market = "BJ";
  return { code, market };
}
