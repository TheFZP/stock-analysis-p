/**
 * AI 上下文构建模块
 * 负责将预加载数据序列化为系统提示词上下文
 */
import systemPromptTemplate from "../prompts/system-prompt.md?raw";
import { getMergedSystemPrompt } from "../skills/index.js";
import { DEFAULT_KLINE_PERIOD, getPeriodMeta, periodLabel } from "../utils/klinePeriod.js";

/**
 * 公共提示词片段（个股 AI 与全局 AI 共用，避免两处重复维护）
 */

/** 市场交易规则（按市场选择） */
export const MARKET_RULES = {
  HK: `## 港股市场须知
- **交易制度**：港股实行 T+0 交易，当日买入可当日卖出
- **无涨跌停限制**：港股不设涨跌停板，价格可大幅波动
- **交易时段**：早市 9:30-12:00，午市 13:00-16:00（全日交易）
- **交收制度**：T+2 交收（交易日后的第二个工作日完成资金与股票交割）
- **货币单位**：以港元 (HKD) 计价
- **费用结构**：涉及印花税、交易征费、交易费等多个项目，成本高于 A 股`,
  A: `## A 股市场须知
- **交易制度**：A 股实行 T+1 交易，当日买入次日才能卖出
- **涨跌停限制**：主板 ±10%，创业板 ±20%，科创板 ±20%，北交所 ±30%；退市整理期跟随所属板块（主板 ±10%、创业板/科创板 ±20%）
- **交易时段**：集合竞价 9:15-9:25，连续竞价 9:30-11:30、13:00-15:00
- **特殊标识**：N 为新股首日，C 为上市次日至第 5 日，U 为科创板未盈利
- **ST/*ST 涨跌幅**：风险警示股涨跌幅限制**与所属板块一致**（沪深主板 ±10%——2026-07-06 起新规取代原 ±5%；创业板/科创板 ±20%；北交所 ±30%）。**不要再按 ±5% 判断主板 ST 股**
- **关键资金指标**：北向资金（沪深港通）是 A 股重要的外资风向标（当前无北向实时数据源，勿给出具体数值）`,
};

/** 联网搜索策略（完整四步流程见 WebSearch skill 的《联网搜索能力》，此处只留指引指针） */
function buildSearchPolicy(webSearchEnabled) {
  return webSearchEnabled
    ? `
## 联网搜索
联网搜索已开启。遵循下方《联网搜索能力》规则执行：先拆实词关键词搜索、再叠加本地工具数据、最后综合回答（标注来源）；关键词只用实词，禁用「最新消息/怎么样」等泛词。`
    : `
## 联网搜索
联网搜索已关闭，不要尝试调用搜索工具，直接使用本地工具与已有知识回答。`;
}

/**
 * 计算移动平均线
 * @param {Array} data - K 线数据 [{ close }]
 * @param {number} period - 周期
 * @returns {Array} [{ time, value }]
 */
function computeMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j].close;
    }
    result.push({ time: data[i].date || data[i].time, value: Math.round((sum / period) * 100) / 100 });
  }
  return result;
}

/**
 * 将预加载数据序列化为上下文字符串
 *
 * contextData.klinePeriod 必须由调用方带上当前图表周期（见 utils/klinePeriod.js）：
 * klineData 是共享且可切换周期的序列，缺省按日K解读会把周线/月线均线说成「5 日均线」。
 */
export function serializeContext(contextData) {
  if (!contextData) return "";
  const period = contextData.klinePeriod || DEFAULT_KLINE_PERIOD;
  const pLabel = periodLabel(period);
  const pMeta = getPeriodMeta(period);
  const parts = [];

  if (contextData.klineData && Array.isArray(contextData.klineData) && contextData.klineData.length > 0) {
    const recent = contextData.klineData.slice(-30);
    // 只注入 MA 最新值（注入整条 MA 序列会浪费数千 token，模型只需最新值判断位置关系）
    const maPeriods = [5, 10, 20, 30, 60];
    const maData = {};
    for (const p of maPeriods) {
      if (contextData.klineData.length >= p) {
        const maValues = computeMA(contextData.klineData, p);
        const latest = maValues[maValues.length - 1];
        maData[`MA${p}`] = latest ? latest.value : null;
      }
    }
    parts.push(`## 预加载 K 线数据（${pLabel}，最近 ${recent.length} 根，已包含在上下文中无需重新调用工具）\n${JSON.stringify(recent, null, 2)}`);
    parts.push(`## 预计算移动平均线（${pLabel}口径 MA 最新值，系统计算，直接引用）\n${JSON.stringify(maData, null, 2)}\n（说明：以上为系统预计算的 MA5/MA10/MA20/MA30/MA60 最新值，基于${pLabel}计算，${pMeta.maDesc}——不是 5 日均线，禁止改写成日线口径。你可以直接使用，无需自己计算。）`);
  }

  // 预计算技术指标（MACD/KDJ/RSI/WR 最新值与信号，系统计算避免模型手算出错）
  if (contextData.indicators) {
    parts.push(
      `## 预计算技术指标（${pLabel}口径，系统计算，直接引用，无需自行计算；禁止把 ${pLabel} 指标描述成日线指标）\n${JSON.stringify(contextData.indicators, null, 2)}\n（WR 为国际 %R 负值口径，−100 ~ 0：越接近 0 越超买，越接近 −100 越超卖。）`
    );
  }

  if (contextData.moneyFlow) {
    parts.push(`## 预加载主力资金数据\n${JSON.stringify(contextData.moneyFlow, null, 2)}`);
  }

  if (contextData.industryData) {
    parts.push(`## 预加载行业分析数据\n${JSON.stringify(contextData.industryData, null, 2)}`);
  }

  if (contextData.indices && Array.isArray(contextData.indices) && contextData.indices.length > 0) {
    parts.push(`## 预加载大盘指数\n${JSON.stringify(contextData.indices, null, 2)}`);
  }

  // 预加载热榜股票数据（热榜选股功能：排名 + 行情要点 + 主力资金 + K线摘要）
  if (contextData.hotStocks && Array.isArray(contextData.hotStocks) && contextData.hotStocks.length > 0) {
    const hotSummary = contextData.hotStocks.map((s) => {
      const row = {
        排名: s.rank,
        代码: s.code,
        名称: s.name,
        热度: s.hot,
        涨跌幅: s.changePct != null ? `${s.changePct.toFixed(2)}%` : "--",
        排名变化: s.rankChg,
        概念: (s.tags || []).join("、"),
        现价: s.price,
        换手率: s.turnoverRate != null ? `${s.turnoverRate.toFixed(2)}%` : "--",
        成交额万: s.turnover,
        振幅: s.amplitude != null ? `${s.amplitude.toFixed(2)}%` : "--",
        主力净流入万: s.mainNetInflow,
        主力净占比: s.mainNetPct != null ? `${s.mainNetPct.toFixed(2)}%` : "--",
        超大单净流入万: s.superLargeNet,
        大单净流入万: s.largeNet,
      };
      // K 线摘要（紧凑格式）：最近 10 根日K + 均线
      if (s.kline && s.kline.recent && s.kline.recent.length) {
        row.K线 = `最近${s.kline.recent.length}日:[${s.kline.recent.map((k) => `${k.date}:${k.close}`).join(" ")}] MA5=${s.kline.ma5} MA10=${s.kline.ma10} MA20=${s.kline.ma20}`;
      }
      return row;
    });
    parts.push(`## 预加载热榜股票数据（${hotSummary.length} 只，含实时行情 + 主力资金流向 + 日K线摘要，已包含在上下文中无需重新调用工具）\n${JSON.stringify(hotSummary, null, 2)}`);
  }

  if (contextData.positions && Array.isArray(contextData.positions) && contextData.positions.length > 0) {
    const posSummary = contextData.positions.map((p) => {
      // price 缺失（数据未加载）时显示 "--" 而非回退到成本价（避免误导）
      const hasPrice = p.price > 0 && p.buyPrice > 0;
      return {
        代码: p.code,
        名称: p.name,
        成本: p.buyPrice,
        数量: p.quantity,
        现价: p.price > 0 ? p.price : "--",
        买入日期: p.buyDate || "未知",
        盈亏: hasPrice ? `${((p.price - p.buyPrice) * (p.quantity || 0)).toFixed(2)} (${(((p.price - p.buyPrice) / p.buyPrice) * 100).toFixed(2)}%)` : "无实时价格",
      };
    });
    parts.push(`## 用户持仓数据\n${JSON.stringify(posSummary, null, 2)}\n（说明：以上是用户的当前持仓，用户可能会询问持仓分析、盈亏评估等问题，请结合这些数据回答。）`);
  }

  if (contextData.chipData) {
    const chip = contextData.chipData;
    const costStr = chip.costLevels
      ? `COST5=${chip.costLevels.COST5}, COST15=${chip.costLevels.COST15}, COST50=${chip.costLevels.COST50}, COST85=${chip.costLevels.COST85}, COST95=${chip.costLevels.COST95}`
      : "无";
    // currentPrice 缺失时获利比例无意义，显示 "--" 而非恒为 0%（误导 AI）
    const hasPrice = chip.currentPrice > 0 && Array.isArray(chip.distribution);
    // 口径与 UI（ChipDistribution.vue 的 profit/total）保持一致：按 ratio 总和归一化，
    // 避免平滑窗口导致 Σratio ≠ 1 时获利+套牢 ≠ 100%
    const totalRatio = hasPrice ? chip.distribution.reduce((s, d) => s + (d.ratio || 0), 0) : 0;
    const profitPct = totalRatio > 0
      ? (chip.distribution.filter((d) => d.price < chip.currentPrice).reduce((s, d) => s + d.ratio, 0) / totalRatio) * 100
      : null;
    // 衰减口径必须与实际计算一致：未衰减时明确说明，避免 AI 把估算值当成精确筹码
    const trPct = chip.decayTurnoverRate;
    const chipBasis = chip.decayed
      ? `按${pLabel}的价格成交量分布 + 换手率衰减（衰减系数 1${trPct != null ? `，最新换手率 ${trPct}%` : ""}）估算`
      : `按${pLabel}的价格成交量分布估算（未做换手率衰减，老筹码占比偏高）`;
    parts.push(`## 预加载筹码分布数据（${chipBasis}）
筹码峰价格：${chip.peakPrice}
平均持仓成本：${chip.avgCost}
当前价：${chip.currentPrice}
获利比例：${profitPct != null ? `${profitPct.toFixed(1)}%` : "--"}
套牢比例：${profitPct != null ? `${(100 - profitPct).toFixed(1)}%` : "--"}
分位成本：${costStr}
（说明：筹码分布由 K 线成交量按价格分布**估算**，不是真实持仓成本；可给区间与倾向，不可当成精确主力成本。）`);
  }

  return parts.join("\n\n");
}

/**
 * 构建完整的 AI 系统提示词
 * @param {Object|null} currentStock - 当前选中的股票
 * @param {Object|null} contextData - 预加载的上下文数据
 * @param {string} userProfile - 用户画像 markdown 原文（可选）
 * @param {boolean} webSearchEnabled - 联网搜索是否开启（关闭时剔除搜索 skill 的提示词）
 * @returns {string}
 */
export function buildSystemPrompt(currentStock, contextData, userProfile, webSearchEnabled = true) {
  const exclude = webSearchEnabled ? [] : ["web-search"];
  const skillsPrompt = getMergedSystemPrompt({ excludeSkills: exclude });

  // 联网搜索策略（完整流程在 WebSearch skill 内，此处为指引指针，避免重复）
  const searchPolicy = buildSearchPolicy(webSearchEnabled);

  // 北京时间（始终计算，每次请求都附带最新时间）
  const beijingTime = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

  // 判断是否为港股
  const isHK = currentStock?.market === "HK" || currentStock?.code?.length === 5;
  const currency = isHK ? "HK$" : "¥";

  // 构建当前股票上下文
  let context = "";
  if (currentStock) {
    context = `
## 当前上下文
用户正在查看的股票：${currentStock.name}（${currentStock.code}）${isHK ? " [港股]" : ""}
当前价格：${currency}${currentStock.price?.toFixed(2) ?? "--"}
涨跌幅：${currentStock.changePct != null
        ? (currentStock.changePct >= 0 ? "+" : "") +
        currentStock.changePct.toFixed(2) +
        "%"
        : "--"
      }
今开：${currentStock.open?.toFixed(2) ?? "--"}　最高：${currentStock.high?.toFixed(2) ?? "--"}　最低：${currentStock.low?.toFixed(2) ?? "--"}
昨收：${currentStock.prevClose?.toFixed(2) ?? "--"}　成交量：${currentStock.volume != null ? (currentStock.volume / 10000).toFixed(2) + '万手' : "--"}　成交额：${currentStock.turnover != null ? (currentStock.turnover / 10000).toFixed(2) + '亿' : "--"}
换手率：${currentStock.turnoverRate != null ? currentStock.turnoverRate.toFixed(2) + '%' : "--"}　市盈率：${currentStock.pe?.toFixed(2) ?? "--"}
货币单位：${isHK ? "港元 (HKD)" : "人民币 (CNY)"}
`;
  }

  // 市场交易规则（公共常量）
  const marketRules = MARKET_RULES[isHK ? "HK" : "A"];

  // 预加载数据
  const preloadedData = serializeContext(contextData);
  const preloadSection = preloadedData
    ? `
## 系统已预加载的数据（你已拥有这些数据，不需要重复调用工具获取）

${preloadedData}

**注意**：以上数据已随当前选中股票一起加载。如果用户问的是当前股票，你已掌握这些数据，直接分析即可，无需再调用工具。
如果用户问的是其他股票，请调用对应工具查询。
`
    : "";

  // 用户画像
  const profileSection = userProfile
    ? `\n## 用户画像\n${userProfile}\n\n> 画像仅作参考，回答时点到为止，不要复述画像内容。\n`
    : "";

  const prompt = systemPromptTemplate
    .replace("{{BEIJING_TIME}}", beijingTime)
    .replace("{{PRELOAD_SECTION}}", preloadSection)
    .replace("{{SKILL_PROMPTS}}", skillsPrompt)
    .replace("{{SEARCH_POLICY}}", searchPolicy)
    .replace("{{USER_PROFILE}}", profileSection)
    .replace("{{MARKET_RULES}}", marketRules)
    .replace("{{STOCK_CONTEXT}}", context);

  // 占位符残留检查：拼写错误会原样漏进提示词且无提示，这里兜底告警
  if (prompt.includes("{{")) {
    const leftovers = prompt.match(/\{\{[A-Z_]+\}\}/g);
    console.warn("system prompt 存在未替换占位符:", leftovers);
  }
  return prompt;
}
