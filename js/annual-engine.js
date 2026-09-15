/* ============================================================
 * annual-engine.js — TaxAnnual 年度汇算清缴引擎（纯函数）
 * 职责：综合所得年度汇算——收入额折算（工资全额 / 劳务×80% / 稿酬×80%×70% /
 *       特许权×80%）、工资与劳务预扣估算（复用 TaxEngine 累计预扣，与本工具
 *       「平台连续劳务」口径一致，不引入按次双口径）、年度计税与退补判定。
 * 对外接口：window.TaxAnnual。依赖：TaxEngine（BRACKETS/累计预扣/新旧政策/TaxUtils）。
 * ============================================================ */
(function () {
'use strict';
  const { round2 } = TaxUtils;
  const { BRACKETS, calcTaxForward, calcTaxOldPolicy, isNewPolicy, TAX_STRATEGIES } = TaxEngine;

/** 专项附加年度国家标准（预填值，可改） */
const EXTRA_ANNUAL_DEFAULTS = {
  childEducation: 24000,   // 子女教育 2,000/月/孩
  infantCare: 24000,       // 3 岁以下婴幼儿照护 2,000/月/孩
  education: 4800,         // 继续教育：学历 4,800/年；职业资格取证年度为 3,600，按实际填写
  houseLoan: 12000,        // 住房贷款利息 1,000/月（与房租不可同时享受，年度口径提示用户自择）
  houseRent: 0,            // 住房租金 18,000/13,200/9,600 按城市档（默认 0 由用户选择填写）
  support: 36000,          // 赡养老人：独生 36,000/年；非独生分摊每人 ≤18,000/年
  medical: 0               // 大病医疗：医保内自付超 15,000 部分据实填（≤80,000）
};

/** 年度税率档（与累计预扣同表）：应纳税所得额 → { rate, quick } */
function bracketOf(taxable) {
  const t = Math.max(0, Number(taxable) || 0);
  const b = BRACKETS.find(b => t <= b.upTo) || BRACKETS[BRACKETS.length - 1];
  return { rate: b.rate, quick: b.quick };
}

/** 汇算口径收入额折算：kind = 'salary' | 'labor' | 'author' | 'royalty' */
function incomeOf(kind, amount) {
  const v = Math.max(0, Number(amount) || 0);
  if (kind === 'salary') return round2(v);
  if (kind === 'labor' || kind === 'royalty') return round2(v * 0.8);
  if (kind === 'author') return round2(v * 0.8 * 0.7);
  return 0;
}

/** 工资预扣估算：按月累计预扣（只计有薪月，减除 5,000+社保公积金+专项附加），与多月累计页一致 */
function estimateSalaryWithholding(entries, siMonthly, extraMonthly) {
  let cumIncome = 0, cumTax = 0, cumDed = 0, total = 0;
  (entries || []).forEach(e => {
    const amt = Number(e.amount) || 0;
    if (amt <= 0) return;
    cumDed += 5000 + (siMonthly || 0) + (extraMonthly || 0);
    const r = calcTaxForward(amt, cumIncome, cumDed, cumTax, TAX_STRATEGIES.salary,
      { socialInsurance: siMonthly || 0, extraDeduction: extraMonthly || 0 });
    cumIncome = r.cumIncome; cumTax = r.cumTaxDue;
    total = round2(total + r.currentTax);
  });
  return total;
}

/** 劳务预扣估算：按月累计预扣（平台连续劳务口径，含 2025-10 新旧政策切换；旧政策不扣税） */
function estimateLaborWithholding(entries) {
  let cumIncome = 0, cumTax = 0, cumDed = 0, total = 0, lastMonth = '';
  (entries || []).forEach(e => {
    const amt = Number(e.amount) || 0;
    if (amt <= 0) return;
    const month = e.month || '';
    if (!isNewPolicy(month)) {
      total = round2(total + (calcTaxOldPolicy(amt).currentTax || 0));
      lastMonth = month;
      return;
    }
    if (month !== lastMonth) { lastMonth = month; cumDed += 5000; }
    const r = calcTaxForward(amt, cumIncome, cumDed, cumTax);
    cumIncome = r.cumIncome; cumTax = r.cumTaxDue;
    total = round2(total + r.currentTax);
  });
  return total;
}

/** 稿酬预扣估算：收入额（×80%×70%）× 20% */
function estimateAuthorWithholding(amount) {
  return round2(incomeOf('author', amount) * 0.2);
}

/** 特许权使用费预扣估算：收入额（×80%）× 20% */
function estimateRoyaltyWithholding(amount) {
  return round2(incomeOf('royalty', amount) * 0.2);
}

/**
 * 年度汇算：应纳税额与退补判定
 * @param {object} input { salaryIncome, salaryDeductionsAnnual（工资社保公积金年额，仅工资据实扣除）,
 *   laborIncome, authorIncome, royaltyIncome, extraAnnual,
 *   withheld: { salary, labor, author, royalty }（页面已解析的最终值：估算或手填） }
 */
function settle(input) {
  input = input || {};
  const w = input.withheld || {};
  const num = v => Math.max(0, Number(v) || 0);

  const lines = [
    { kind: 'salary', label: '工资薪金', income: num(input.salaryIncome), amount: incomeOf('salary', input.salaryIncome) },
    { kind: 'labor', label: '劳务报酬', income: num(input.laborIncome), amount: incomeOf('labor', input.laborIncome) },
    { kind: 'author', label: '稿酬', income: num(input.authorIncome), amount: incomeOf('author', input.authorIncome) },
    { kind: 'royalty', label: '特许权使用费', income: num(input.royaltyIncome), amount: incomeOf('royalty', input.royaltyIncome) }
  ];
  const totalIncomeAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
  const basicDeduction = 60000;
  const salaryDeductionsAnnual = num(input.salaryDeductionsAnnual);
  const extraAnnual = num(input.extraAnnual);
  const taxable = Math.max(0, round2(totalIncomeAmount - basicDeduction - salaryDeductionsAnnual - extraAnnual));
  const bkt = bracketOf(taxable);
  const annualTax = round2(Math.max(0, taxable * bkt.rate - bkt.quick));

  const withheldDetail = [
    { kind: 'salary', label: '工资薪金', value: round2(num(w.salary)) },
    { kind: 'labor', label: '劳务报酬', value: round2(num(w.labor)) },
    { kind: 'author', label: '稿酬', value: round2(num(w.author)) },
    { kind: 'royalty', label: '特许权使用费', value: round2(num(w.royalty)) }
  ];
  const withheldTotal = round2(withheldDetail.reduce((s, x) => s + x.value, 0));
  const balance = round2(annualTax - withheldTotal);
  const refund = balance < 0 ? round2(-balance) : 0;
  const payable = balance > 0 ? balance : 0;
  /* 免汇算：需补税但综合所得年收入 ≤12 万，或补税 ≤400 元（依法预扣预缴前提下） */
  const totalIncome = round2(lines.reduce((s, l) => s + l.income, 0));
  const exempt = payable > 0 && (totalIncome <= 120000 || payable <= 400);

  return { lines, totalIncome, totalIncomeAmount, basicDeduction, salaryDeductionsAnnual, extraAnnual,
    taxable, rate: bkt.rate, quick: bkt.quick, annualTax, withheldDetail, withheldTotal,
    balance, refund, payable, exempt };
}

  window.TaxAnnual = { EXTRA_ANNUAL_DEFAULTS, bracketOf, incomeOf, estimateAuthorWithholding,
    estimateLaborWithholding, estimateRoyaltyWithholding, estimateSalaryWithholding, settle };
})();
