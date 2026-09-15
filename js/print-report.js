/* ============================================================
 * print-report.js — PageReport 打印/PDF 报告
 * 职责：把多月累计（劳务/工资）与批量计算结果组装为「分节正式式」打印报告
 *       （抬头 + 一、计算参数 / 二、计算结果 / 三、备注 + 页脚声明），
 *       批量按人分节（工资条块）并脱敏身份证/电话/银行卡；
 *       数据直接读 window._multiResults / window._batchResults，计算引擎零改动。
 * 对外接口：window.PageReport.{maskIdCard, maskPhone, maskBankCard,
 *           buildMultiReportData, buildBatchReportData, printReport}。
 * 依赖：TaxUtils/PolicyLib/SocialIns/PageShared 与 TaxState 全局别名；DOM：#print-report、#multi-gap-toggle。
 * ============================================================ */
(function () {
'use strict';
  const { formatNum, formatRate } = TaxUtils;
  const { CITY_POLICY_LIBRARY, resolvePolicyMemo } = PolicyLib;
  const { computeExtraDetailFor } = SocialIns;
  const { incomeIOLabels } = PageShared;

// ==================== 脱敏（仅批量打印报告；界面显示不受影响） ====================

function maskIdCard(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4) : '****';
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : '****';
}

function maskBankCard(b) {
  const s = String(b || '');
  return s.length >= 4 ? '****' + s.slice(-4) : '****';
}

// ==================== 数据组装（纯函数，env 为环境快照） ====================

const sum = (rows, key) => Math.round(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0) * 100) / 100;

/** 逐月展示行：输入额/输出额随方向互换（与 CSV 导出同口径） */
function reportRowOf(r, isSalary, direction) {
  const inAmt = direction === 'forward' ? r.preTax : r.postTax;
  const outAmt = direction === 'forward' ? r.postTax : r.preTax;
  const notes = [];
  if (r._isBonus) notes.push(`年终奖（${r._bonusStrategy === 'combined' ? '并入综合所得' : '单独计税'}）`);
  if (r._isGap) notes.push('断月重置');
  if (r._isOldPolicy) notes.push('旧政策');
  if (r._siMissing) notes.push('社保公积金未设置');
  return {
    month: r.month,
    inAmt: Math.round((Number(inAmt) || 0) * 100) / 100,
    si: isSalary ? Math.round((Number(r.socialInsurance) || 0) * 100) / 100 : Math.round((Number(r.withholdingIncome) || 0) * 100) / 100,
    extra: isSalary ? Math.round((Number(r.extraDeduction) || 0) * 100) / 100 : null,
    tax: Math.round((Number(r.currentTax) || 0) * 100) / 100,
    outAmt: Math.round((Number(outAmt) || 0) * 100) / 100,
    note: notes.join(' · ')
  };
}

/** 多月报告数据（rows = window._multiResults；env 见 collectMultiEnv） */
function buildMultiReportData(rows, env) {
  if (!rows || !rows.length) return null;
  const isSalary = env.incomeType === 'salary';
  const list = rows.map(r => reportRowOf(r, isSalary, env.direction));
  const months = list.map(x => x.month).sort();
  return {
    source: 'multi',
    title: isSalary ? '工资薪金计算报告' : '劳务报酬计算报告',
    monthRange: months[0] === months[months.length - 1] ? months[0] : `${months[0]} ~ ${months[months.length - 1]}`,
    params: env.params,
    isSalary,
    inLabel: env.inLabel,
    outLabel: env.outLabel,
    siLabel: isSalary ? '社保公积金(个人)' : '本次预扣收入额',
    rows: list,
    totals: {
      in: sum(list, 'inAmt'), si: sum(list, 'si'),
      extra: isSalary ? sum(list, 'extra') : null,
      tax: sum(list, 'tax'), out: sum(list, 'out')
    },
    policyLine: env.policyLine
  };
}

/** 批量报告数据（rows = window._batchResults）：按人分组工资条块 + 总计；身份脱敏 */
function buildBatchReportData(rows, env) {
  if (!rows || !rows.length) return null;
  const isSalary = env.incomeType === 'salary';
  const direction = env.direction;

  const groupsMap = {};
  rows.forEach(r => {
    const key = r.personKey || (r.idCard ? 'ID:' + r.idCard : r.person);
    if (!groupsMap[key]) {
      groupsMap[key] = {
        person: r.person,
        idLine: [r.idCard ? '身份证 ' + maskIdCard(r.idCard) : '', r.phone ? '电话 ' + maskPhone(r.phone) : '', r.bankCard ? '银行卡 ' + maskBankCard(r.bankCard) : ''].filter(Boolean).join(' · '),
        rows: []
      };
    }
    groupsMap[key].rows.push(reportRowOf(r, isSalary, direction));
  });

  const groups = Object.values(groupsMap).map(g => {
    g.rows.sort((a, b) => (a.month || '').localeCompare(b.month || ''));
    return {
      person: g.person,
      idLine: g.idLine,
      rows: g.rows,
      subtotal: { in: sum(g.rows, 'inAmt'), si: sum(g.rows, 'si'), tax: sum(g.rows, 'tax'), out: sum(g.rows, 'out') }
    };
  }).sort((a, b) => a.person.localeCompare(b.person, 'zh'));

  const all = groups.flatMap(g => g.rows);
  const months = all.map(x => x.month).sort();
  return {
    source: 'batch',
    title: '批量计税报告',
    monthRange: months.length ? (months[0] === months[months.length - 1] ? months[0] : `${months[0]} ~ ${months[months.length - 1]}`) : '',
    params: env.params,
    isSalary,
    inLabel: env.inLabel,
    outLabel: env.outLabel,
    siLabel: isSalary ? '社保公积金(个人)' : '本次预扣收入额',
    personCount: groups.length,
    groups,
    totals: { in: sum(all, 'inAmt'), si: sum(all, 'si'), tax: sum(all, 'tax'), out: sum(all, 'out') },
    policyLine: env.policyLine
  };
}

// ==================== 环境快照与触发（DOM 层） ====================

/** 多月参数分节：工资读工资参数卡同源数据，劳务读方向/断月开关 */
function collectMultiEnv() {
  const isSalary = incomeType === 'salary';
  const { dirLabel } = incomeIOLabels(multiDirection, '期望实发（已知）');
  const params = [['计税方向', dirLabel]];
  let policyLine;
  if (isSalary) {
    const city = CITY_POLICY_LIBRARY[salaryParams.cityId];
    const firstMonth = (window._multiResults || []).map(r => r.month).sort()[0] || '';
    const pol = firstMonth ? resolvePolicyMemo(salaryParams.cityId, firstMonth) : null;
    params.push(['参保城市', (city ? city.name : '自定义') + (pol ? ` · ${pol.label}` : '')]);
    params.push(['社保基数', salaryParams.socialBase > 0 ? `¥${formatNum(salaryParams.socialBase)}/月` : '未设置']);
    params.push(['公积金基数 / 比例', (salaryParams.fundBase ? `¥${formatNum(salaryParams.fundBase)}` : '跟随社保基数') + ` · ${formatRate(salaryParams.fundRate)}`]);
    const extraTotal = salaryParams.extraDetail && salaryParams.extraDetail.on
      ? computeExtraDetailFor(salaryParams.extraDetail, '').total
      : salaryParams.extraDeduction;
    params.push(['专项附加扣除', `¥${formatNum(extraTotal)}/月（${salaryParams.extraDetail && salaryParams.extraDetail.on ? '分项合计' : '单一总额'}）`]);
    policyLine = '社保公积金按参保城市适用年度政策计算（逐险种按基数上下限 clamp，公积金月缴存额取整到元）。';
  } else {
    const gapEl = document.getElementById('multi-gap-toggle');
    params.push(['断月重置', gapEl && gapEl.checked ? '开启（间隔超 1 个月累计归零）' : '关闭']);
    policyLine = '2025 年 10 月 1 日起适用新政策（累计预扣法），此前月份按旧政策（生产经营所得，不扣税）。';
  }
  const { preLabel, postLabel } = incomeIOLabels(multiDirection, '期望实发（已知）');
  return { incomeType, direction: multiDirection, params, policyLine, inLabel: preLabel, outLabel: postLabel };
}

/** 批量参数分节：整批城市 / 按应发作基数 / 断月重置 */
function collectBatchEnv() {
  const isSalary = incomeType === 'salary';
  const { dirLabel } = incomeIOLabels(batchDirection);
  const params = [
    ['所得类型', isSalary ? '工资薪金（累计预扣）' : '劳务报酬（平台连续劳务）'],
    ['计税方向', dirLabel]
  ];
  let policyLine;
  if (isSalary) {
    const city = batchCityId ? CITY_POLICY_LIBRARY[batchCityId] : null;
    params.push(['整批参保城市', city ? city.name : '跟随「工资参数」中的城市']);
    params.push(['无基数时按应发工资作基数', batchGrossAsBase ? '开启' : '关闭']);
    policyLine = '取值顺序：行内「城市/社保基数/公积金比例」列 > 整批设置 > 「工资参数」；社保公积金按城市政策计算（个人+单位），均无基数记 0 并标注。';
  } else {
    params.push(['断月重置', batchGapReset ? '开启（间隔超 1 个月累计归零）' : '关闭']);
    policyLine = '2025 年 10 月 1 日起适用新政策（累计预扣法），此前月份按旧政策（不扣税）。';
  }
  const { preLabel, postLabel } = incomeIOLabels(batchDirection);
  return { incomeType, direction: batchDirection, params, policyLine, inLabel: preLabel, outLabel: postLabel };
}

/** 组装报告 HTML 填充隐藏容器 */
function renderReport(data) {
  const container = document.getElementById('print-report');
  if (!container) return;
  const now = new Date();
  const genAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const headerName = localStorage.getItem('tc-report-header') || '';

  const theadOf = () => `<tr><th>月份</th><th>${data.inLabel}</th><th>${data.siLabel}</th>${data.isSalary ? '<th>专项附加</th>' : ''}<th>本期预扣税额</th><th>${data.outLabel}</th><th>备注</th></tr>`;
  const rowOf = r => `<tr><td>${r.month}</td><td>¥${formatNum(r.inAmt)}</td><td>¥${formatNum(r.si)}</td>${data.isSalary ? `<td>¥${formatNum(r.extra)}</td>` : ''}<td>¥${formatNum(r.tax)}</td><td>¥${formatNum(r.outAmt)}</td><td>${r.note || ''}</td></tr>`;

  let resultHTML;
  if (data.source === 'batch') {
    resultHTML = data.groups.map(g => `
      <div class="pr-person">
        <div class="pr-person-head"><span>${g.person}</span><span>${g.idLine || '&nbsp;'}</span></div>
        <table><thead>${theadOf()}</thead><tbody>
          ${g.rows.map(rowOf).join('')}
          <tr class="pr-total"><td colspan="2">小计</td><td>¥${formatNum(g.subtotal.in)}</td><td>¥${formatNum(g.subtotal.si)}</td>${data.isSalary ? '<td></td>' : ''}<td>¥${formatNum(g.subtotal.tax)}</td><td>¥${formatNum(g.subtotal.out)}</td><td></td></tr>
        </tbody></table>
      </div>`).join('') + `
      <table style="margin-top:10px;"><tbody>
        <tr class="pr-total"><td style="width:20%;">总计（${data.personCount} 人）</td><td>${data.inLabel} ¥${formatNum(data.totals.in)}</td><td>${data.siLabel} ¥${formatNum(data.totals.si)}</td><td>个税 ¥${formatNum(data.totals.tax)}</td><td>${data.outLabel} ¥${formatNum(data.totals.out)}</td></tr>
      </tbody></table>`;
  } else {
    resultHTML = `<table><thead>${theadOf()}</thead><tbody>
      ${data.rows.map(rowOf).join('')}
      <tr class="pr-total"><td colspan="2">合计</td><td>¥${formatNum(data.totals.in)}</td><td>¥${formatNum(data.totals.si)}</td>${data.isSalary ? `<td>¥${formatNum(data.totals.extra)}</td>` : ''}<td>¥${formatNum(data.totals.tax)}</td><td>¥${formatNum(data.totals.out)}</td><td></td></tr>
    </tbody></table>`;
  }

  container.innerHTML = `
    <div class="pr-head">
      ${headerName ? `<div class="pr-sub" style="font-size:13px;color:#1a3a6b;font-weight:600;">${headerName}</div>` : ''}
      <div class="pr-title">${data.title}</div>
      <div class="pr-sub">计算范围 ${data.monthRange} · ${genAt} 生成</div>
    </div>
    <div class="pr-section">一、计算参数</div>
    <table><tbody>${data.params.map(([k, v]) => `<tr class="pr-params"><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>
    <div class="pr-section">二、计算结果</div>
    ${resultHTML}
    <div class="pr-section">三、备注</div>
    <div style="font-size:11px;color:#555;line-height:1.6;">${data.policyLine}</div>
    <div class="pr-foot">本报告由个税计算器生成，数值仅供参考，以税务机关核定为准。</div>
  `;
}

/**
 * 打印入口：source='multi'|'batch'；抬头经 prompt 定制并记忆，取消则不打印
 */
function printReport(source) {
  const rows = source === 'batch' ? window._batchResults : window._multiResults;
  if (!rows || !rows.length) return alert(source === 'batch' ? '请先计算批量结果' : '请先完成计算');

  const saved = localStorage.getItem('tc-report-header') || '';
  const header = prompt('报告抬头（公司/部门名，留空显示默认标题）：', saved);
  if (header === null) return;
  if (header.trim()) localStorage.setItem('tc-report-header', header.trim());
  else if (saved) localStorage.removeItem('tc-report-header');

  const data = source === 'batch'
    ? buildBatchReportData(rows, collectBatchEnv())
    : buildMultiReportData(rows, collectMultiEnv());
  if (!data) return alert('请先完成计算');
  renderReport(data);
  // 等浏览器完成布局再唤起打印，避免打印预览捕获未重排的文档
  setTimeout(() => window.print(), 60);
}

  window.PageReport = { buildBatchReportData, buildMultiReportData, maskBankCard, maskIdCard, maskPhone, printReport };
})();
