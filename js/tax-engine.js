/* ============================================================
 * tax-engine.js — TaxEngine 纯计税引擎
 * 职责：综合所得税率表、税前↔税后正反算、年终奖单独计税与方案对比、
 *       旧政策（2025-09 及之前）按次预扣、断月检测。（全部纯函数，逻辑零改动）
 * 对外接口：window.TaxEngine。依赖：TaxUtils。
 * ============================================================ */
(function () {
'use strict';
  const { round2 } = TaxUtils;

// ==================== Tax Engine ====================

const BRACKETS = [
  { upTo: 36000,   rate: 0.03, quick: 0 },
  { upTo: 144000,  rate: 0.10, quick: 2520 },
  { upTo: 300000,  rate: 0.20, quick: 16920 },
  { upTo: 420000,  rate: 0.25, quick: 31920 },
  { upTo: 660000,  rate: 0.30, quick: 52920 },
  { upTo: 960000,  rate: 0.35, quick: 85920 },
  { upTo: Infinity, rate: 0.45, quick: 181920 },
];

function getBracket(taxableIncome) {
  for (const b of BRACKETS) {
    if (taxableIncome <= b.upTo) return b;
  }
  return BRACKETS[BRACKETS.length - 1];
}

// ==================== 年终奖（全年一次性奖金） ====================

/* 全年一次性奖金单独计税用的月度税率表（按奖金 ÷12 找档，财税〔2018〕164号） */
const MONTHLY_BRACKETS = [
  { upTo: 3000,     rate: 0.03, quick: 0 },
  { upTo: 12000,    rate: 0.10, quick: 210 },
  { upTo: 25000,    rate: 0.20, quick: 1410 },
  { upTo: 35000,    rate: 0.25, quick: 2660 },
  { upTo: 55000,    rate: 0.30, quick: 4410 },
  { upTo: 80000,    rate: 0.35, quick: 7160 },
  { upTo: Infinity, rate: 0.45, quick: 15160 },
];

function getMonthlyBracket(bonus) {
  const monthly = (Number(bonus) || 0) / 12;
  for (const b of MONTHLY_BRACKETS) {
    if (monthly <= b.upTo) return b;
  }
  return MONTHLY_BRACKETS[MONTHLY_BRACKETS.length - 1];
}

/** 年终奖单独计税：应纳税额 = 奖金 × 按奖金÷12 确定的税率 − 速算扣除数（每年限用一次） */
function calcBonusTaxSeparate(bonus) {
  const b = getMonthlyBracket(Number(bonus) || 0);
  return Math.max(0, round2((Number(bonus) || 0) * b.rate - b.quick));
}

/* 年终奖「无效区间」：奖金落在区间内时，多发反而到手更少——
   区间下沿为月度税率表临界点 ×12，上沿为税后所得恰好等于下沿税后所得的奖金额 */
const BONUS_TRAP_ZONES = (() => {
  const zones = [];
  for (let i = 0; i < MONTHLY_BRACKETS.length - 1; i++) {
    const low = MONTHLY_BRACKETS[i], high = MONTHLY_BRACKETS[i + 1];
    const edge = low.upTo * 12;
    const taxAtEdge = edge * low.rate - low.quick;
    const netAtEdge = edge - taxAtEdge;
    const upper = round2((netAtEdge - high.quick) / (1 - high.rate));
    zones.push({ from: edge, to: upper, suggest: edge });
  }
  return zones;
})();

/** 命中无效区间返回 { from, to, suggest }，否则 null */
function findBonusTrapZone(bonus) {
  const v = Number(bonus) || 0;
  return BONUS_TRAP_ZONES.find(z => v > z.from && v <= z.to) || null;
}

/**
 * 计税策略：
 * labor  — 连续劳务报酬：收入×80% 计入累计，税后=税前−税；2025-10 前走旧政策（不扣税）
 * salary — 工资薪金：收入100% 计入累计，每月减除含社保公积金与专项附加，税后实发=应发−社保公积金−税
 */
const TAX_STRATEGIES = {
  labor: {
    key: 'labor',
    includedIncome: (income) => income * 0.8,
    postTaxOf: (preTax, currentTax) => round2(preTax - currentTax),
    supportsOldPolicy: true,
    gapReset: true,
  },
  salary: {
    key: 'salary',
    includedIncome: (income) => income,
    postTaxOf: (preTax, currentTax, ctx) => round2(preTax - ((ctx && ctx.socialInsurance) || 0) - currentTax),
    supportsOldPolicy: false,
    gapReset: false,
  },
};
const DEFAULT_STRATEGY = TAX_STRATEGIES.labor;

/**
 * 计算单笔预扣税额
 * @param {number} income 本次收入
 * @param {number} cumIncome 本次之前的累计收入
 * @param {number} cumDeduction 累计减除费用
 * @param {number} cumTax 已预扣税额
 * @param {object} strategy 计税策略（默认劳务报酬）
 * @param {object} ctx 策略上下文（salary: { socialInsurance, extraDeduction }）
 */
function calcTaxForward(income, cumIncome = 0, cumDeduction = 5000, cumTax = 0, strategy = DEFAULT_STRATEGY, ctx = {}) {
  const withholdingIncome = strategy.includedIncome(income);
  const newCumIncome = cumIncome + withholdingIncome;
  const taxableIncome = Math.max(0, newCumIncome - cumDeduction);
  const bracket = getBracket(taxableIncome);
  const cumTaxDueRaw = taxableIncome * bracket.rate - bracket.quick;
  const cumTaxDue = Math.max(0, round2(cumTaxDueRaw));
  const currentTax = Math.max(0, round2(cumTaxDue - round2(cumTax)));
  const postTax = strategy.postTaxOf(income, currentTax, ctx);
  return {
    preTax: income,
    withholdingIncome,
    cumIncome: newCumIncome,
    cumDeduction,
    taxableIncome,
    rate: bracket.rate,
    quick: bracket.quick,
    cumTaxDue,
    currentTax,
    postTax,
    effectiveRate: income > 0 ? currentTax / income : 0,
    socialInsurance: (ctx && ctx.socialInsurance) || 0,
    extraDeduction: (ctx && ctx.extraDeduction) || 0,
  };
}

/**
 * 反算：已知税后金额，求税前
 */
function calcTaxReverse(postTaxTarget, cumIncome = 0, cumDeduction = 5000, cumTax = 0, strategy = DEFAULT_STRATEGY, ctx = {}) {
  // Binary search for preTax
  // Upper bound: at 45% tax rate, preTax ≈ postTax / 0.55, add generous margin
  // （salary 的社保公积金不随税前变化，一并计入上界）
  const si = (ctx && ctx.socialInsurance) || 0;
  let lo = 0;
  let hi = (postTaxTarget + si) * 3 + 500000;

  // Quick check: if postTaxTarget is 0 or negative
  if (postTaxTarget <= 0) {
    return calcTaxForward(0, cumIncome, cumDeduction, cumTax, strategy, ctx);
  }

  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const r = calcTaxForward(mid, cumIncome, cumDeduction, cumTax, strategy, ctx);
    if (r.postTax > postTaxTarget) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  // 二分收敛点是"税后首次超过目标"的跳变边界，直接四舍五入会落在边界上方，
  // 导致税后比目标多 0.01。在收敛点附近按 0.01 步长精扫，
  // 优先取税后恰好等于目标的税前金额；若无精确解则取偏差最小的（偏差相同时优先不低于目标）。
  const center = Math.round((lo + hi) / 2 * 100) / 100;
  let best = null;
  for (let k = -5; k <= 5; k++) {
    const candidate = Math.round((center + k * 0.01) * 100) / 100;
    if (candidate <= 0) continue;
    const r = calcTaxForward(candidate, cumIncome, cumDeduction, cumTax, strategy, ctx);
    const diff = Math.abs(r.postTax - postTaxTarget);
    if (
      !best ||
      diff < best.diff - 1e-9 ||
      (Math.abs(diff - best.diff) < 1e-9 && r.postTax > best.r.postTax)
    ) {
      best = { r, diff };
    }
  }
  return best ? best.r : calcTaxForward(center, cumIncome, cumDeduction, cumTax, strategy, ctx);
}

// ==================== 旧政策（按次预扣） ====================
// 政策切换时间：2025年10月1日
const POLICY_SWITCH_YEAR = 2025;
const POLICY_SWITCH_MONTH = 10;

/**
 * 判断该月份是否适用新政策
 * @param {string} monthStr 月份字符串，格式为 "YYYY-MM"；缺省时按当前日期判断
 * @returns {boolean} true表示适用新政策，false表示适用旧政策
 */
function isNewPolicy(monthStr) {
  let year, month;
  if (!monthStr || monthStr === '-') {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  } else {
    const parts = monthStr.split('-');
    if (parts.length < 2) return false;
    year = parseInt(parts[0]);
    month = parseInt(parts[1]);
  }
  return year > POLICY_SWITCH_YEAR ||
         (year === POLICY_SWITCH_YEAR && month >= POLICY_SWITCH_MONTH);
}

/**
 * 旧政策：2025年10月1日之前按生产经营所得处理，不扣税、不累计
 */
function calcTaxOldPolicy(income) {
  return {
    preTax: income,
    withholdingIncome: 0,
    cumIncome: 0,
    cumDeduction: 0,
    taxableIncome: 0,
    rate: 0,
    quick: 0,
    cumTaxDue: 0,
    currentTax: 0,
    postTax: income,
    isOldPolicy: true
  };
}

/**
 * 旧政策：已知税后金额，反算税前（旧政策不扣税，所以税前=税后）
 */
function calcTaxReverseOldPolicy(postTaxTarget) {
  // 旧政策不扣税，所以税前等于税后
  return calcTaxOldPolicy(postTaxTarget);
}

// ==================== Gap Detection ====================

/**
 * 解析 YYYY-MM 格式为 { year, month } 数字
 */
function parseYearMonth(ym) {
  if (!ym || ym === '-') return null;
  const parts = ym.split('-');
  if (parts.length < 2) return null;
  return { year: parseInt(parts[0]), month: parseInt(parts[1]) };
}

/**
 * 判断两个月份之间是否断月（间隔 > 1 个月）
 * @param {string} prevMonth YYYY-MM
 * @param {string} curMonth  YYYY-MM
 * @returns {boolean}
 */
function isGapMonth(prevMonth, curMonth) {
  const prev = parseYearMonth(prevMonth);
  const cur = parseYearMonth(curMonth);
  if (!prev || !cur) return false;
  const diff = (cur.year - prev.year) * 12 + (cur.month - prev.month);
  return diff > 1;
}


/* ==================== 年终奖方案对比 ==================== */

/**
 * 工资薪金年度累计税额（纯计算，供年终奖方案对比复用）
 * @param {Array<{month:'YYYY-MM', amount:number, si?:number, extra?:number}>} entries 按月升序（同月多笔按序）
 */
function calcSalaryCumulativeTax(entries) {
  let cumIncome = 0, cumTax = 0, cumDeduction = 0, lastMonth = '';
  let totalTax = 0;
  (entries || []).forEach(e => {
    if (e.month !== lastMonth) {
      lastMonth = e.month;
      cumDeduction += 5000 + (e.si || 0) + (e.extra || 0);
    }
    const r = calcTaxForward(e.amount, cumIncome, cumDeduction, cumTax, TAX_STRATEGIES.salary,
      { socialInsurance: e.si || 0, extraDeduction: e.extra || 0 });
    cumIncome = r.cumIncome;
    cumTax = r.cumTaxDue;
    totalTax += r.currentTax;
  });
  return round2(totalTax);
}

/** 将年终奖作为一笔收入插入发放月（排在当月工资之后；当月无工资时插到月序合适处） */
function mergeBonusIntoEntries(entries, bonus) {
  const list = (entries || []).slice();
  const bEntry = { month: bonus.month, amount: Number(bonus.amount) || 0, si: 0, extra: 0, isBonus: true };
  let inserted = false;
  for (let i = 0; i < list.length; i++) {
    const next = list[i + 1];
    if (list[i].month === bonus.month && (!next || next.month !== bonus.month)) {
      list.splice(i + 1, 0, bEntry);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    let idx = 0;
    for (let i = 0; i < list.length; i++) {
      if ((list[i].month || '') <= bonus.month) idx = i + 1;
    }
    list.splice(idx, 0, bEntry);
  }
  return list;
}

/**
 * 年终奖计税方案对比：单独计税 vs 并入综合所得
 * @param {Array} salaryEntries 不含年终奖的工资月度序列 [{month, amount, si, extra}]
 * @param {{amount:number, month:'YYYY-MM'}} bonus
 * @returns {object} 两方案税额、推荐方式、节税额与无效区间提示
 */
function compareBonusStrategies(salaryEntries, bonus) {
  const salaryOnlyTax = calcSalaryCumulativeTax(salaryEntries);
  const separateTax = calcBonusTaxSeparate(bonus.amount);
  const combinedEntries = mergeBonusIntoEntries(salaryEntries, bonus);
  const combinedTotalTax = calcSalaryCumulativeTax(combinedEntries);
  const combinedBonusTax = round2(combinedTotalTax - salaryOnlyTax);
  return {
    bonus: Number(bonus.amount) || 0,
    bonusMonth: bonus.month,
    salaryOnlyTax: salaryOnlyTax,
    separateTax: separateTax,
    combinedBonusTax: combinedBonusTax,
    combinedTotalTax: combinedTotalTax,
    separateTotalTax: round2(salaryOnlyTax + separateTax),
    recommendation: separateTax <= combinedBonusTax ? 'separate' : 'combined',
    saving: round2(Math.abs(separateTax - combinedBonusTax)),
    trap: findBonusTrapZone(bonus.amount)
  };
}

/* 批量城市相关状态见 TaxState（batchCityId / batchGrossAsBase） */

  window.TaxEngine = { BONUS_TRAP_ZONES,BRACKETS,DEFAULT_STRATEGY,MONTHLY_BRACKETS,POLICY_SWITCH_MONTH,POLICY_SWITCH_YEAR,TAX_STRATEGIES,calcBonusTaxSeparate,calcSalaryCumulativeTax,calcTaxForward,calcTaxOldPolicy,calcTaxReverse,calcTaxReverseOldPolicy,compareBonusStrategies,findBonusTrapZone,getBracket,getMonthlyBracket,isGapMonth,isNewPolicy,mergeBonusIntoEntries,parseYearMonth };
})();
