/* ============================================================
 * page-annual.js — PageAnnual 年度汇算页
 * 职责：年度选择、工资/劳务 12 月网格、稿酬/特许权与预扣输入、
 *       专项附加年度 7 项（预填国家标准）、带入多月累计结果、
 *       调 TaxAnnual.settle 计算并渲染结果卡（应退/应补 + 免汇算提示）。
 * 对外接口：window.PageAnnual。依赖：TaxAnnual/TaxEngine/SocialIns/TaxState/UI。
 * ============================================================ */
(function () {
'use strict';
  const { formatNum, formatRate } = TaxUtils;
  const { computeSocialInsurance, computeExtraDetailFor } = SocialIns;
  const { EXTRA_ANNUAL_DEFAULTS } = TaxAnnual;

  const MONTH_LABELS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const EXTRA_ITEMS = [
    ['childEducation', '子女教育'], ['infantCare', '婴幼儿照护'], ['education', '继续教育'],
    ['houseLoan', '住房贷款利息'], ['houseRent', '住房租金'], ['support', '赡养老人'], ['medical', '大病医疗（自付超1.5万部分）']
  ];

/** 工资模式下的月度参数（与「工资参数」卡同源） */
function salaryMonthlyParams() {
  const si = salaryParams.socialBase > 0
    ? computeSocialInsurance(salaryParams.socialBase, salaryParams.fundBase)
    : 0;
  const extra = salaryParams.extraDetail && salaryParams.extraDetail.on
    ? computeExtraDetailFor(salaryParams.extraDetail, '').total
    : (salaryParams.extraDeduction || 0);
  return { si, extra };
}

function monthGridHTML(prefix, hint) {
  const cells = MONTH_LABELS.map((m, i) => `
    <div class="month-cell"><label>${m}</label><input type="number" id="ann-${prefix}-${i}" min="0" placeholder="0"></div>`).join('');
  return `<div class="month-grid">${cells}</div>${hint ? `<div style="font-size:12px;color:var(--t-text-2);margin-top:6px;">${hint}</div>` : ''}`;
}

/** 渲染整页（App.init 时一次；年份切换只影响计算用月份，不需重建 DOM） */
function render() {
  const page = document.getElementById('page-annual');
  if (!page) return;
  const now = new Date();
  const year = now.getFullYear();
  const yearOpts = [year + 1, year, year - 1, year - 2, year - 3].map(y =>
    `<option value="${y}" ${y === year ? 'selected' : ''}>${y} 年度</option>`).join('');
  const extraInputs = EXTRA_ITEMS.map(([key, label]) => `
    <div class="summary-item" style="min-width:150px;">
      <div class="label">${label}</div>
      <input type="number" class="mock-input" id="ann-ex-${key}" value="0" min="0" placeholder="国家标准 ${EXTRA_ANNUAL_DEFAULTS[key]}" style="width:100%;margin-top:4px;">
    </div>`).join('');
  const { si, extra } = salaryMonthlyParams();

  page.innerHTML = `
    <div class="card">
      <div class="card-title"><span>🧾 年度汇算清缴（综合所得）</span></div>
      <div class="row-flex" style="align-items:center;">
        <label style="display:flex;align-items:center;gap:8px;">汇算年度
          <select id="ann-year" style="padding:6px 10px;">${yearOpts}</select>
        </label>
        <button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageAnnual.bringIn()"> 带入多月累计结果</button>
        <span style="font-size:12px;color:var(--t-text-2);">全年口径合并计税，与已预扣税额比较得出应退/应补</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span>收入</span></div>
      <div class="boxed-block" style="margin-bottom:14px;">
        <div style="font-weight:600;margin-bottom:8px;">工资薪金（按月）</div>
        ${monthGridHTML('sal')}
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--t-text-2);align-items:center;">
          <span>社保公积金年扣除额（据实，估算 = 月额×有薪月数，可改）</span>
          <input type="number" id="ann-si-annual" min="0" value="${Math.round(si * 12)}" style="width:120px;">
          <span>月社保公积金 ¥${formatNum(si)} · 月专项附加 ¥${formatNum(extra)}（取自「工资参数」卡）</span>
        </div>
      </div>
      <div class="boxed-block" style="margin-bottom:14px;">
        <div style="font-weight:600;margin-bottom:8px;">劳务报酬（按月，平台连续劳务累计预扣口径）</div>
        ${monthGridHTML('lab')}
      </div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">稿酬（全年总额）
          <input type="number" id="ann-author" min="0" placeholder="0" style="width:180px;">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">特许权使用费（全年总额）
          <input type="number" id="ann-royalty" min="0" placeholder="0" style="width:180px;">
        </label>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span>已预扣税额（留空 = 工具估算；填入实际值则按「手填」计）</span></div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">工资已预扣
          <input type="number" id="ann-w-salary" min="0" placeholder="估算" style="width:140px;">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">劳务已预扣
          <input type="number" id="ann-w-labor" min="0" placeholder="估算" style="width:140px;">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">稿酬已预扣
          <input type="number" id="ann-w-author" min="0" placeholder="估算" style="width:140px;">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">特许权已预扣
          <input type="number" id="ann-w-royalty" min="0" placeholder="估算" style="width:140px;">
        </label>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span>专项附加扣除（年度口径，预填国家标准，按实际可改）</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">${extraInputs}</div>
      <div style="font-size:12px;color:var(--t-text-2);margin-top:8px;">住房贷款利息与住房租金不可同时享受；大病医疗填医保目录内自付累计超 15,000 元的部分（年度限额 80,000）。</div>
    </div>

    <div style="display:flex;gap:12px;margin:16px 0;">
      <button class="btn btn-primary" style="flex:1;padding:12px;font-size:15px;" onclick="PageAnnual.calc()"> 开始汇算</button>
    </div>
    <div id="ann-result"></div>
  `;
}

/** 带入多月累计页当次结果（单向：汇算页编辑不回写多月页） */
function bringIn() {
  const rows = window._multiResults;
  if (!rows || !rows.length) return alert('请先在「多月累计」页完成一次计算，再带入');
  const isSalary = incomeType === 'salary';
  const prefix = isSalary ? 'sal' : 'lab';
  rows.forEach(r => {
    const m = String(r.month || '');
    const idx = MONTH_LABELS.findIndex(lb => m.endsWith('-' + String(lb.replace('月', '')).padStart(2, '0')));
    const i = idx >= 0 ? idx : (parseInt(m.split('-')[1], 10) - 1);
    if (i >= 0 && i < 12) {
      const el = document.getElementById(`ann-${prefix}-${i}`);
      if (el) el.value = Math.round((Number(r.preTax) || 0) * 100) / 100;
    }
  });
  if (isSalary) {
    const { si } = salaryMonthlyParams();
    const paidMonths = rows.filter(r => (Number(r.preTax) || 0) > 0).length;
    const siAnnualEl = document.getElementById('ann-si-annual');
    if (siAnnualEl && paidMonths > 0) siAnnualEl.value = Math.round(si * paidMonths);
  }
  alert(`已带入多月累计页的${isSalary ? '工资' : '劳务'}数据（${rows.length} 条记录）`);
}

/** 计算并渲染结果卡 */
function calc() {
  const year = document.getElementById('ann-year').value;
  const entriesOf = prefix => MONTH_LABELS.map((_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, '0')}`,
    amount: Number((document.getElementById(`ann-${prefix}-${i}`) || {}).value) || 0
  }));
  const salEntries = entriesOf('sal');
  const labEntries = entriesOf('lab');
  const salaryIncome = salEntries.reduce((s, e) => s + e.amount, 0);
  const laborIncome = labEntries.reduce((s, e) => s + e.amount, 0);
  const authorIncome = Number((document.getElementById('ann-author') || {}).value) || 0;
  const royaltyIncome = Number((document.getElementById('ann-royalty') || {}).value) || 0;
  const extraAnnual = EXTRA_ITEMS.reduce((s, [key]) =>
    s + (Number((document.getElementById(`ann-ex-${key}`) || {}).value) || 0), 0);

  /* 预扣：留空用估算，填了按手填 */
  const siAnnualInput = Number((document.getElementById('ann-si-annual') || {}).value) || 0;
  const siMonthly = salaryIncome > 0 ? siAnnualInput / Math.max(1, salEntries.filter(e => e.amount > 0).length) : 0;
  const extraMonthly = salaryParams.extraDetail && salaryParams.extraDetail.on
    ? computeExtraDetailFor(salaryParams.extraDetail, '').total
    : (salaryParams.extraDeduction || 0);
  const est = {
    salary: TaxAnnual.estimateSalaryWithholding(salEntries, siMonthly, extraMonthly),
    labor: TaxAnnual.estimateLaborWithholding(labEntries),
    author: TaxAnnual.estimateAuthorWithholding(authorIncome),
    royalty: TaxAnnual.estimateRoyaltyWithholding(royaltyIncome)
  };
  const withheld = {};
  const manualFlags = {};
  [['salary', 'w-salary'], ['labor', 'w-labor'], ['author', 'w-author'], ['royalty', 'w-royalty']].forEach(([k, id]) => {
    const raw = (document.getElementById(`ann-${id}`) || {}).value;
    const manual = String(raw).trim() !== '';
    withheld[k] = manual ? (Number(raw) || 0) : est[k];
    manualFlags[k] = manual;
  });

  const r = TaxAnnual.settle({
    salaryIncome, laborIncome, authorIncome, royaltyIncome,
    salaryDeductionsAnnual: salaryIncome > 0 ? siAnnualInput : 0,
    extraAnnual, withheld
  });

  const wLine = d => {
    const flag = manualFlags[d.kind] ? '<span class="badge" style="margin-left:6px;">手填</span>' : '<span style="font-size:11px;color:var(--t-text-2);margin-left:6px;">估算</span>';
    return `<tr><td>${d.label}${flag}</td><td>¥${formatNum(d.value)}</td></tr>`;
  };
  const incomeLines = r.lines.map(l =>
    `<tr><td>${l.label}</td><td>¥${formatNum(l.income)}</td><td>¥${formatNum(l.amount)}</td></tr>`).join('');

  document.getElementById('ann-result').innerHTML = `
    <div class="card" style="border-color:var(--t-primary);">
      <div class="card-title"><span>汇算结果（${year} 年度）</span>
        <button class="btn btn-secondary" style="padding:4px 12px;font-size:12px;" onclick="PageShare.shareAnnual()"> 分享链接</button></div>
      <div class="summary-grid">
        <div class="summary-item"><div class="label">应纳税额</div><div class="value blue">¥${formatNum(r.annualTax)}</div></div>
        <div class="summary-item"><div class="label">已预扣税额</div><div class="value">¥${formatNum(r.withheldTotal)}</div></div>
        <div class="summary-item"><div class="label">${r.refund > 0 ? '应退税' : '应补税'}</div>
          <div class="value ${r.refund > 0 ? 'green' : 'red'}">¥${formatNum(r.refund > 0 ? r.refund : r.payable)}</div></div>
        <div class="summary-item"><div class="label">实际税负率</div><div class="value orange">${r.totalIncome > 0 ? (r.annualTax / r.totalIncome * 100).toFixed(2) + '%' : '—'}</div></div>
      </div>
      <table class="result-table" style="margin-top:12px;">
        <thead><tr><th>项目</th><th>收入</th><th>收入额（汇算口径）</th></tr></thead>
        <tbody>${incomeLines}
          <tr class="total-row"><td>合计</td><td>¥${formatNum(r.totalIncome)}</td><td>¥${formatNum(r.totalIncomeAmount)}</td></tr>
        </tbody>
      </table>
      <div style="font-size:13px;margin-top:10px;color:var(--t-text);">
        应纳税所得额 = 收入额 ¥${formatNum(r.totalIncomeAmount)} − 基本减除 60,000 − 社保公积金 ¥${formatNum(r.salaryDeductionsAnnual)} − 专项附加 ¥${formatNum(r.extraAnnual)} = <strong>¥${formatNum(r.taxable)}</strong>
        （适用税率 ${formatRate(r.rate)}，速算扣除数 ¥${formatNum(r.quick)}）
      </div>
      <table class="result-table" style="margin-top:10px;">
        <thead><tr><th>已预扣明细</th><th>金额</th></tr></thead>
        <tbody>${r.withheldDetail.map(wLine).join('')}
          <tr class="total-row"><td>合计</td><td>¥${formatNum(r.withheldTotal)}</td></tr>
        </tbody>
      </table>
      ${r.exempt ? `<div class="info-box" style="margin-top:10px;"> 符合免于办理条件（需补税 ≤400 元或综合所得年收入 ≤12 万，且已依法预扣预缴）——可不办理年度汇算。</div>` : ''}
      ${r.refund > 0 ? `<div class="info-box success" style="margin-top:10px;"> 应退税 ¥${formatNum(r.refund)}——需办理年度汇算申报后方可退税。</div>` : ''}
      ${r.payable > 0 && !r.exempt ? `<div class="info-box warning" style="margin-top:10px;"> 应补税 ¥${formatNum(r.payable)}——请于汇算期内办理并补缴。</div>` : ''}
      <div style="font-size:11px;color:var(--t-text-2);margin-top:10px;">本结果由个税计算器估算，预扣值为估算口径时与实际可能存在偏差；以个人所得税 APP 及税务机关汇算核定为准。</div>
    </div>`;
}

  window.PageAnnual = { bringIn, calc, render };
})();
