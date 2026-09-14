/* ============================================================
 * batch-export.js — BatchExport 批量结果导出
 * 批量计算结果 CSV 导出与 Excel 公式明细导出入口（后者由 Exporter 提供实现，此处收口对外出口）。
 * 对外接口：window.BatchExport。依赖：Exporter/PageShared/TaxUtils。
 * ============================================================ */
(function () {
'use strict';
  const { formatRate, round2, downloadFile } = TaxUtils;
  const { ensureXLSX, exportBatchExcelFormula } = Exporter;
  const { identityFlagsOf, incomeIOLabels, siEmployerTotal } = PageShared;
function exportBatchCSV() {
  if (!window._batchResults) return;
  const results = window._batchResults;
  const isSalary = incomeType === 'salary';
  const { preLabel, postLabel } = incomeIOLabels(batchDirection);

  // 检测哪些身份列有数据
  const { hasIdCard, hasPhone, hasBankCard } = identityFlagsOf(results);

  // 按人 → 月排序后导出
  const sorted = [...results].sort((a, b) => {
    const ka = (a.idCard || a.person) + '|' + a.month;
    const kb = (b.idCard || b.person) + '|' + b.month;
    return ka.localeCompare(kb);
  });

  // 构建表头
  let headerCols = '姓名';
  if (hasIdCard) headerCols += ',身份证号';
  if (hasPhone) headerCols += ',电话';
  if (hasBankCard) headerCols += ',银行卡号';
  if (isSalary) {
    headerCols += `,月份,城市,政策年度,${preLabel},三险一金(个人),单位社保公积金,公积金比例,专项附加扣除,累计应发金额,累计减除费用,累计应纳税所得额,适用税率,速算扣除数,本期预扣税额,${postLabel},企业用工总成本,计税方式`;
  } else {
    headerCols += `,月份,${preLabel},本次预扣收入额,累计发放金额,累计减除费用,累计应纳税所得额,适用税率,速算扣除数,本期预扣税额,${postLabel},政策类型`;
  }

  const rows = sorted.map(r => {
    let cols = `"${r.person}"`;
    if (hasIdCard) cols += `,"${r.idCard || ''}"`;
    if (hasPhone) cols += `,"${r.phone || ''}"`;
    if (hasBankCard) cols += `,"${r.bankCard || ''}"`;
    const inAmt = round2(batchDirection === 'forward' ? r.preTax : r.postTax);
    const outAmt = round2(batchDirection === 'forward' ? r.postTax : r.preTax);
    const bonusSep = r._isBonus && r._bonusSeparate;
    const erTotal = siEmployerTotal(r._siDetail);
    if (isSalary) {
      const method = r._isBonus
        ? `年终奖(${r._bonusStrategy === 'combined' ? '并入综合所得' : '单独计税'})`
        : `累计预扣${r._siMissing ? '(三险一金未设置)' : ''}${r._cityUnknown ? '(城市未识别)' : ''}${r._yearFallback ? '(年度未匹配)' : ''}`;
      cols += `,"${r.month}","${r.cityName || ''}","${r.policyYearLabel || ''}",${inAmt},${round2(r.socialInsurance || 0)},${round2(erTotal)},${r._siDetail ? formatRate(r._siDetail.fundRateUsed) : ''},${round2(r.extraDeduction || 0)},${bonusSep ? '' : round2(r.cumIncome)},${bonusSep ? '' : round2(r.cumDeduction || 0)},${bonusSep ? '' : round2(r.taxableIncome)},${formatRate(r.rate)},${round2(r.quick || 0)},${round2(r.currentTax)},${outAmt},${round2(inAmt + erTotal)},${method}`;
    } else {
      cols += `,"${r.month}",${inAmt},${round2(r.withholdingIncome)},${round2(r.cumIncome)},${round2(r.cumDeduction || 0)},${round2(r.taxableIncome)},${formatRate(r.rate)},${round2(r.quick || 0)},${round2(r.currentTax)},${outAmt},${r._withholdFlat ? `新政策·核定代征${formatRate(r._withholdRate)}` : (r._isOldPolicy ? '旧政策' : '新政策')}`;
    }
    return cols;
  }).join('\n');

  downloadFile(headerCols + '\n' + rows, '批量个税计算结果.csv', 'text/csv');
}
  window.BatchExport = { exportBatchCSV, exportBatchExcelFormula };
})();
