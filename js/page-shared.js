/* ============================================================
 * page-shared.js — PageShared 多月累计页与批量页共用件
 * 职责：两个计算页重复使用的逻辑收口到一处——
 *       方向正反算、方向/类型输入输出标签、年终奖独立行排序插入、
 *       结果表跨列提示行（年度重算/断月重置/旧政策）、
 *       社保公积金（单位）悬浮明细、身份列有无检测。
 * 对外接口：window.PageShared。依赖：TaxEngine/TaxUtils/TaxState（别名）。
 * ============================================================ */
(function () {
'use strict';
  const { formatNum } = TaxUtils;
  const { calcTaxForward, calcTaxReverse } = TaxEngine;

/** 按计算方向正算/反算（strategy/ctx 缺省时为劳务报酬默认策略） */
function calcTaxByDirection(direction, amount, cumIncome, cumDeduction, cumTax, strategy, ctx) {
  return direction === 'forward'
    ? calcTaxForward(amount, cumIncome, cumDeduction, cumTax, strategy, ctx)
    : calcTaxReverse(amount, cumIncome, cumDeduction, cumTax, strategy, ctx);
}

/** 方向/类型相关的输入输出标签（结果表头、模式徽标与 CSV 导出共用）；
 *  多月页工资反算的输入列文案为「期望实发（已知）」，与批量页不同，经 salaryReversePreLabel 覆盖 */
function incomeIOLabels(direction, salaryReversePreLabel) {
  const salary = incomeType === 'salary';
  const forward = direction === 'forward';
  let dirLabel, preLabel, postLabel;
  if (salary) {
    dirLabel = forward ? '应发工资 → 实发工资' : '实发工资 → 应发工资';
    preLabel = forward ? '应发工资' : (salaryReversePreLabel || '实发工资（已知）');
    postLabel = forward ? '实发工资' : '应发工资（反算）';
  } else {
    dirLabel = forward ? '税前收入 → 税后收入' : '税后收入 → 税前收入';
    preLabel = forward ? '税前收入' : '税后收入（已知）';
    postLabel = forward ? '税后收入' : '税前收入（反算）';
  }
  return { dirLabel, preLabel, postLabel };
}

/** 把年终奖独立行按月份序插入（排在发放月最后一行之后） */
function insertBonusRowSorted(rows, row) {
  let idx = 0;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i].month || '') <= row.month) idx = i + 1;
  }
  rows.splice(idx, 0, row);
}

/* 结果表跨列提示行（多月页与批量页共用文案，避免两处漂移） */
function spanRowHTML(colspan, bg, style, html) {
  return `<tr style="background:${bg};"><td colspan="${colspan}" class="span-row" style="text-align:center;${style}">${html}</td></tr>`;
}

/** 跨年：年度累计重新起算 */
function yearResetRowHTML(colspan, year) {
  return spanRowHTML(colspan, 'var(--t-primary-bg)',
    'padding:10px;font-weight:700;color:var(--t-primary);letter-spacing:1px;', `── ${year} 年度累计重新起算 ──`);
}

/** 断月重置：与上月间隔超过 1 个月 */
function gapResetRowHTML(colspan, month) {
  return spanRowHTML(colspan, 'var(--t-error-bg)',
    'padding:8px;font-weight:600;color:var(--t-error);font-size:12px;', ` 断月重置：${month} 与上月间隔超过1个月，累计归零重新起算`);
}

/** 旧政策（2025年10月1日前）按次预扣提示 */
function oldPolicyRowHTML(colspan, month) {
  return spanRowHTML(colspan, 'var(--t-warning-bg)',
    'padding:8px;font-weight:600;color:var(--t-warning);font-size:12px;', `旧政策：${month} 按生产经营所得计算，不扣税（2025年10月1日前）`);
}

/** 「社保公积金（单位）」列悬浮明细（无单位部分返回空串） */
function siEmployerTooltip(si) {
  return si && si.employer
    ? ` title="单位养老 ¥${formatNum(si.employer.pension)} / 医疗 ¥${formatNum(si.employer.medical)} / 失业 ¥${formatNum(si.employer.unemployment)} / 工伤 ¥${formatNum(si.employer.injury)} / 公积金 ¥${formatNum(si.employer.fund)}"`
    : '';
}

/** 社保公积金（单位）合计（无单位部分返回 0；结果列与汇总共用） */
function siEmployerTotal(si) {
  return si && si.employer ? si.employer.total : 0;
}

/** 检测结果集里哪些身份列有数据（预览表 / 结果表 / CSV 导出共用） */
function identityFlagsOf(rows) {
  return {
    hasIdCard: (rows || []).some(d => d.idCard),
    hasPhone: (rows || []).some(d => d.phone),
    hasBankCard: (rows || []).some(d => d.bankCard)
  };
}

  window.PageShared = { calcTaxByDirection, gapResetRowHTML, identityFlagsOf, incomeIOLabels,
    insertBonusRowSorted, oldPolicyRowHTML, siEmployerTooltip, siEmployerTotal, yearResetRowHTML };
})();
