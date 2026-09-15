/* ============================================================
 * page-multi.js — PageMulti 多月累计页
 * 职责：12 月网格、方向/断月/年终奖交互、累计预扣计算与结果渲染、CSV 导出。
 * 对外接口：window.PageMulti。依赖：TaxEngine/PolicyLib/SocialIns/UI/Exporter/TaxState/TaxUtils。
 * ============================================================ */
(function () {
'use strict';
  const { round2, formatNum, formatRate, downloadFile } = TaxUtils;
  const { calcBonusTaxSeparate, compareBonusStrategies, calcTaxForward, calcTaxReverse, calcTaxOldPolicy,
    calcTaxReverseOldPolicy, findBonusTrapZone, getMonthlyBracket, isGapMonth, isNewPolicy,
    mergeBonusIntoEntries, TAX_STRATEGIES } = TaxEngine;
  const { computeSocialInsuranceFor, getExtraDeductionFor } = SocialIns;
  const { resolvePolicyMemo } = PolicyLib;
  const { escAttr } = UI;
  const { exportMultiExcelFormula } = Exporter;
  const { calcTaxByDirection, gapResetRowHTML, incomeIOLabels, insertBonusRowSorted, oldPolicyRowHTML,
    siEmployerTooltip, siEmployerTotal, yearResetRowHTML } = PageShared;

// ==================== Multi-month: 12-Month Grid ====================

const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

function buildMonthGrid() {
  // Set year default
  const yearInput = document.getElementById('multi-year');
  if (yearInput && !yearInput.value) yearInput.value = new Date().getFullYear();

  // 年终奖发放月份下拉（默认 12 月）
  const bonusSel = document.getElementById('multi-bonus-month');
  if (bonusSel && !bonusSel.options.length) {
    bonusSel.innerHTML = MONTH_NAMES.map((label, i) =>
      `<option value="${i + 1}" ${i === 11 ? 'selected' : ''}>${label}</option>`).join('');
  }

  const grid = document.getElementById('month-grid');
  grid.innerHTML = '';
  for (let m = 1; m <= 12; m++) {
    const cell = document.createElement('div');
    cell.className = 'month-cell';
    cell.innerHTML = `
      <div class="m-month-label">${MONTH_NAMES[m-1]}</div>
      <input type="number" id="m-amount-${m}" placeholder="0.00" step="0.01" min="0"
             oninput="PageMulti.onMonthAmountInput(this)">
    `;
    grid.appendChild(cell);
  }
}

function onMonthAmountInput(input) {
  const val = parseFloat(input.value);
  input.parentElement.classList.toggle('has-data', !isNaN(val) && val > 0);
}

/* 根据计算方向与所得类型更新输入提示 */
function updateMultiInputHints() {
  const reverse = multiDirection === 'reverse';
  const salary = incomeType === 'salary';
  let placeholder, hint;
  if (salary) {
    placeholder = reverse ? '期望实发' : '应发工资';
    hint = reverse
      ? '输入每月期望实发工资，系统反算所需应发工资。留空的月份自动跳过。'
      : '输入每月应发工资（税前），按上方「工资参数」卡设置的城市与基数计算社保公积金与个税。留空的月份自动跳过。';
  } else {
    placeholder = reverse ? '税后金额' : '税前金额';
    hint = reverse
      ? '输入每月期望税后收入，系统反算所需税前收入。留空的月份自动跳过。'
      : '输入每月税前收入，留空的月份自动跳过。断月重置会检测跳过的月份间隔。';
  }
  for (let m = 1; m <= 12; m++) {
    const input = document.getElementById('m-amount-' + m);
    if (input) input.placeholder = placeholder;
  }
  const hintEl = document.getElementById('multi-input-hint');
  if (hintEl) hintEl.textContent = hint;
}

/* 年终奖计税方案选择：'auto' 跟随推荐 | 'separate' 单独计税 | 'combined' 并入综合所得 */

function setMultiBonusStrategy(s) {
  multiBonusStrategy = s;
  calcMulti();
}

/** 读取多月累计页签的年终奖输入（金额 ≤0 或未填返回 null） */
function readMultiBonus() {
  const amount = round2(Math.max(0, parseFloat(document.getElementById('multi-bonus-amount')?.value) || 0));
  if (!(amount > 0)) return null;
  const sel = document.getElementById('multi-bonus-month');
  const m = sel ? (parseInt(sel.value) || 12) : 12;
  const year = parseInt(document.getElementById('multi-year')?.value) || new Date().getFullYear();
  return { amount: amount, month: year + '-' + String(m).padStart(2, '0') };
}

/** 构造「年终奖单独计税」行：不进入累计链，独立按 ÷12 档计税 */
function buildBonusSeparateRow(bonus, results) {
  const bkt = getMonthlyBracket(bonus.amount);
  const tax = calcBonusTaxSeparate(bonus.amount);
  let cumIncome = 0, cumDeduction = 0, cumTaxDue = 0;
  results.forEach(r => {
    if ((r.month || '') <= bonus.month && !r._isBonus) {
      cumIncome = r.cumIncome; cumDeduction = r.cumDeduction; cumTaxDue = r.cumTaxDue;
    }
  });
  return {
    month: bonus.month, note: '年终奖', amount: bonus.amount,
    preTax: bonus.amount, withholdingIncome: 0,
    cumIncome: cumIncome, cumDeduction: cumDeduction, taxableIncome: 0,
    rate: bkt.rate, quick: bkt.quick,
    cumTaxDue: round2(cumTaxDue + tax), currentTax: tax,
    postTax: round2(bonus.amount - tax),
    effectiveRate: bonus.amount > 0 ? tax / bonus.amount : 0,
    socialInsurance: 0, extraDeduction: 0,
    _isBonus: true, _bonusSeparate: true, _siDetail: null
  };
}

function buildNoteCellHTML(r, isSalary) {
  let html = `<div class="note-name">${escAttr(r.note)}</div>`;
  if (isSalary && r._policyLabel) {
    const label = String(r._policyLabel);
    const m = label.match(/^([^（(]+)[（(]([\s\S]+)[）)]\s*$/);
    const main = m ? m[1] : label;
    const detail = m ? m[2] : '';
    const fallback = r._yearFallback ? '（年度未精确匹配）' : '';
    html += `<div class="note-policy"${(detail || fallback) ? ` title="${escAttr(label + fallback)}"` : ''}>` +
      `<span class="note-policy-main">${escAttr(main)}${fallback}</span>` +
      (detail ? `<span class="note-policy-detail" title="点击展开/收起" onclick="UI.toggleNoteDetail(this)">${escAttr(detail)}</span>` : '') +
      `</div>`;
  }
  if (r._isBonus) {
    html += `<div style="font-size:11px;color:var(--t-primary);margin-top:2px;">${r._bonusSeparate ? '单独计税（÷12 定档）' : '并入综合所得'}</div>`;
  }
  return html;
}


function calcMulti() {
  const yearInput = document.getElementById('multi-year');
  const year = parseInt(yearInput.value) || new Date().getFullYear();

  // Collect filled months
  const data = [];
  for (let m = 1; m <= 12; m++) {
    const input = document.getElementById('m-amount-' + m);
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      data.push({
        month: year + '-' + String(m).padStart(2, '0'),
        amount: val,
        note: MONTH_NAMES[m-1],
      });
    }
  }

  if (data.length === 0) return alert('请至少输入一个月的收入数据');

  const gapReset = document.getElementById('multi-gap-toggle').checked;

  let cumIncome = 0;
  let cumTax = 0;
  let cumDeduction = 0;
  let cumSI = 0;      // 累计社保公积金（展示与公式导出用）
  let cumExtra = 0;   // 累计专项附加（展示与公式导出用）
  const results = [];
  let lastMonth = '';

  const isSalary = incomeType === 'salary';
  const bonus = isSalary ? readMultiBonus() : null;
  let plan = null;

  /* 工资薪金：先备好逐月 si/extra，供年终奖两方案对比与逐行计算复用 */
  let entries = data;
  if (isSalary) {
    entries = data.map(d => {
      const siD = computeSocialInsuranceFor(salaryParams.cityId, d.month, salaryParams.socialBase, salaryParams.fundBase);
      const ex = getExtraDeductionFor(d.month);
      return { month: d.month, amount: d.amount, note: d.note, si: siD.total, extra: ex.total, _siDetail: siD, _extraMsgs: ex.messages, _medicalAnnual: ex.medicalAnnual };
    });
    if (bonus && multiDirection === 'forward') {
      plan = compareBonusStrategies(entries, bonus);
      plan.chosen = multiBonusStrategy === 'auto' ? plan.recommendation : multiBonusStrategy;
    } else if (bonus) {
      /* 反算方向：并入对比不适用，年终奖按单独计税独立成行 */
      plan = {
        bonus: bonus.amount, bonusMonth: bonus.month,
        separateTax: calcBonusTaxSeparate(bonus.amount),
        trap: findBonusTrapZone(bonus.amount),
        reverseOnly: true, chosen: 'separate'
      };
    }
    if (plan && plan.chosen === 'combined') {
      entries = mergeBonusIntoEntries(entries, bonus);
      entries.forEach(e => { if (e.isBonus) e.note = '年终奖'; });
    }
  }
  window._multiBonusPlan = plan;

  entries.forEach(d => {
    if (isSalary) {
      /* 工资薪金：始终累计预扣；逐月匹配城市政策；每月减除 = 5000 + 社保公积金 + 专项附加（同月只计一次） */
      const isBonusRow = !!d.isBonus;
      const salarySI = isBonusRow ? 0 : d.si;
      const salaryExtra = isBonusRow ? 0 : d.extra;
      const pol = resolvePolicyMemo(salaryParams.cityId, d.month);
      if (d.month !== lastMonth) {
        lastMonth = d.month;
        cumDeduction += 5000 + salarySI + salaryExtra;
      }

      const salaryCtx = { socialInsurance: salarySI, extraDeduction: salaryExtra };
      const r = calcTaxByDirection(multiDirection, d.amount, cumIncome, cumDeduction, cumTax, TAX_STRATEGIES.salary, salaryCtx);

      cumIncome = r.cumIncome;
      cumTax = r.cumTaxDue;
      if (!isBonusRow) {
        cumSI = round2(cumSI + salarySI);
        cumExtra = round2(cumExtra + salaryExtra);
      }

      results.push({
        ...d,
        ...r,
        _isGap: false,
        _isOldPolicy: false,
        _policyLabel: pol.label,
        _yearFallback: !pol.matched,
        _siDetail: isBonusRow ? null : d._siDetail,
        _isBonus: isBonusRow,
        _bonusSeparate: false,
        _cumSI: cumSI,
        _cumExtra: cumExtra,
        _extraMsgs: isBonusRow ? [] : (d._extraMsgs || []),
        _medicalAnnual: isBonusRow ? 0 : (d._medicalAnnual || 0)
      });
    } else if (isNewPolicy(d.month)) {
      // 新政策：累计预扣
      // 断月重置：与上一有数据的月份间隔 >1 个月则重新起算
      let isGap = false;
      if (gapReset && lastMonth && isGapMonth(lastMonth, d.month)) {
        cumIncome = 0;
        cumTax = 0;
        cumDeduction = 0;
        lastMonth = '';
        isGap = true;
      }

      if (d.month !== lastMonth) {
        lastMonth = d.month;
        cumDeduction += 5000;
      }

      const r = calcTaxByDirection(multiDirection, d.amount, cumIncome, cumDeduction, cumTax);

      cumIncome = r.cumIncome;
      cumTax = r.cumTaxDue;

      results.push({
        ...d,
        ...r,
        _isGap: isGap,
        _isOldPolicy: false
      });
    } else {
      // 旧政策：按次预扣，不累计
      const r = multiDirection === 'forward' ? calcTaxOldPolicy(d.amount) : calcTaxReverseOldPolicy(d.amount);
      
      // 旧政策切换到新政策时需要重置累计
      if (lastMonth && isNewPolicy(lastMonth)) {
        cumIncome = 0;
        cumTax = 0;
        cumDeduction = 0;
      }
      lastMonth = d.month;

      results.push({
        ...d,
        ...r,
        _isGap: false,
        _isOldPolicy: true
      });
    }
  });

  /* 年终奖单独计税（含反算方向）：独立成行插入发放月 */
  if (bonus && plan && plan.chosen === 'separate') {
    insertBonusRowSorted(results, buildBonusSeparateRow(bonus, results));
  }

  renderMultiResults(results, plan);
}

function resetMulti() {
  for (let m = 1; m <= 12; m++) {
    const input = document.getElementById('m-amount-' + m);
    if (input) {
      input.value = '';
      input.parentElement.classList.remove('has-data');
    }
  }
  const bonusInput = document.getElementById('multi-bonus-amount');
  if (bonusInput) bonusInput.value = '';
  multiBonusStrategy = 'auto';
  document.getElementById('multi-result').style.display = 'none';
}

function renderMultiResults(results, plan) {
  const container = document.getElementById('multi-result');
  container.style.display = '';

  const isSalary = incomeType === 'salary';
  const totalPre = results.reduce((s, r) => s + r.preTax, 0);
  const totalTax = results.reduce((s, r) => s + r.currentTax, 0);
  const totalPost = results.reduce((s, r) => s + r.postTax, 0);
  const totalSI = results.reduce((s, r) => s + (r.socialInsurance || 0), 0);
  const totalExtra = results.reduce((s, r) => s + (r.extraDeduction || 0), 0);
  const totalEmployer = results.reduce((s, r) => s + siEmployerTotal(r._siDetail), 0);
  const avgRate = totalPre > 0 ? totalTax / totalPre : 0;
  const { dirLabel: multiDirLabel, preLabel: inLabel, postLabel: outLabel } =
    incomeIOLabels(multiDirection, '期望实发（已知）');
  const colCount = isSalary ? 13 : 11;

  /* 专项附加政策提示（分项模式），全年只提示一次 */
  const extraMsgs = [];
  results.forEach(r => (r._extraMsgs || []).forEach(m => { if (!extraMsgs.includes(m)) extraMsgs.push(m); }));
  const medicalAnnual = results.reduce((s, r) => Math.max(s, r._medicalAnnual || 0), 0);

  /* 年终奖方案对比卡 */
  let bonusCard = '';
  if (isSalary && plan) {
    const recLabel = { separate: '单独计税', combined: '并入综合所得' };
    if (plan.reverseOnly) {
      bonusCard = `
      <div class="result-card" style="margin-bottom:16px;">
        <div class="result-header"><span> 年终奖计税（${plan.bonusMonth} · 奖金 ¥${formatNum(plan.bonus)}）</span></div>
        <div style="padding:10px 4px;font-size:13px;">
          反算方向下并入对比不适用，年终奖按<strong>单独计税</strong>处理：应纳个税 <strong style="color:var(--t-error);">¥${formatNum(plan.separateTax)}</strong>（÷12 定档，每年限一次）。
          如需对比「并入综合所得」，请切换到「税前 → 税后」方向重新计算。
        </div>
      </div>`;
    } else {
      const recBadge = `<span style="background:var(--t-success);color:#fff;font-size:11px;padding:2px 10px;border-radius:12px;font-weight:700;"> 推荐：${recLabel[plan.recommendation]}${plan.saving > 0 ? ` · 节税 ¥${formatNum(plan.saving)}` : ''}</span>`;
      const btn = (s, label) => `<button class="btn ${plan.chosen === s ? 'btn-green' : 'btn-secondary'}" style="padding:4px 12px;font-size:12px;" onclick="PageMulti.setMultiBonusStrategy('${s}')">${label}</button>`;
      /* 移动形态：行转卡片（方案B）——卡头=方案名，正文=两关键数，说明整段下沉为注脚 */
      const mBonusCard = (s, label, taxHtml, totalTax, note) => `
            <div class="m-bonus-card${plan.chosen === s ? ' active' : ''}">
              <div class="m-bonus-head"><span>${label}</span>${plan.chosen === s ? '<span class="cur">当前</span>' : ''}</div>
              <div class="m-bonus-body">
                <div class="m-bonus-item"><span class="k">年终奖应纳个税</span><span class="v tax">¥${taxHtml}</span></div>
                <div class="m-bonus-item"><span class="k">全年个税合计</span><span class="v">¥${formatNum(totalTax)}</span></div>
              </div>
              <div class="m-bonus-note">${note}</div>
            </div>`;
      bonusCard = `
      <div class="result-card" style="margin-bottom:16px;">
        <div class="result-header"><span> 年终奖方案对比（${plan.bonusMonth} · 奖金 ¥${formatNum(plan.bonus)}）</span><span>${recBadge}</span></div>
        <div class="only-desktop">
          <div style="overflow-x:auto;">
            <table class="result-table" style="font-size:13px;">
              <thead><tr><th>方案</th><th>年终奖应纳个税</th><th>全年个税合计</th><th>说明</th></tr></thead>
              <tbody>
                <tr style="${plan.chosen === 'separate' ? 'background:var(--t-success-bg);' : ''}">
                  <td>单独计税</td><td class="tax-col">¥${formatNum(plan.separateTax)}</td><td>¥${formatNum(plan.separateTotalTax)}</td>
                  <td style="color:var(--t-text-2);">奖金 ÷12 定档，不并入累计，不享受减除费用；每年限一次</td>
                </tr>
                <tr style="${plan.chosen === 'combined' ? 'background:var(--t-success-bg);' : ''}">
                  <td>并入综合所得</td><td class="tax-col">¥${formatNum(plan.combinedBonusTax)}（税负增量）</td><td>¥${formatNum(plan.combinedTotalTax)}</td>
                  <td style="color:var(--t-text-2);">奖金计入发放月累计收入，正常享受减除</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="only-mobile" style="padding:12px 12px 2px;">
          ${mBonusCard('separate', '单独计税', formatNum(plan.separateTax), plan.separateTotalTax, '奖金 ÷12 定档，不并入累计，不享受减除费用；每年限一次')}
          ${mBonusCard('combined', '并入综合所得', formatNum(plan.combinedBonusTax) + '（税负增量）', plan.combinedTotalTax, '奖金计入发放月累计收入，正常享受减除')}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 4px 2px;font-size:12px;color:var(--t-text-2);">
          <span>应用方案：</span>${btn('auto', '跟随推荐')}${btn('separate', '单独计税')}${btn('combined', '并入综合所得')}
        </div>
        ${plan.trap ? `<div style="padding:6px 4px 2px;font-size:12px;color:var(--t-warning);"> 无效区间避坑：奖金 ¥${formatNum(plan.trap.from)} ~ ¥${formatNum(plan.trap.to)} 区间内多发反而到手更少，建议调整为 ¥${formatNum(plan.trap.suggest)}。</div>` : ''}
      </div>`;
    }
  }

  // 按年分组
  const yearGroups = {};
  results.forEach(r => {
    const yr = r.month.split('-')[0] || '-';
    if (!yearGroups[yr]) yearGroups[yr] = [];
    yearGroups[yr].push(r);
  });
  const years = Object.keys(yearGroups).sort();

  // 逐行明细（按年分组 + 断月/跨年标记 + 年度小计 + 政策标记）
  // 桌面宽表与移动紧凑表（方案C 分层展开）共用一次遍历，双 DOM 输出
  let tbodyHTML = '';
  let mobileTbodyHTML = '';
  let seq = 0;
  years.forEach((yr, yi) => {
    const yRows = yearGroups[yr];
    // 跨年分隔
    if (yi > 0) {
      tbodyHTML += yearResetRowHTML(colCount, yr);
      mobileTbodyHTML += yearResetRowHTML(5, yr);
    }
    // 年度小计变量
    let yPre = 0, yTax = 0, yPost = 0;
    yRows.forEach(r => {
      seq++;
      // 断月标记
      if (r._isGap) {
        tbodyHTML += gapResetRowHTML(colCount, r.month);
        mobileTbodyHTML += gapResetRowHTML(5, r.month);
      }
      // 旧政策标记
      if (r._isOldPolicy) {
        tbodyHTML += oldPolicyRowHTML(colCount, r.month);
        mobileTbodyHTML += oldPolicyRowHTML(5, r.month);
      }
      const isBonusRow = !!r._isBonus;
      const bonusSep = isSalary && isBonusRow && r._bonusSeparate;
      const cumCell = (v) => (bonusSep ? '—' : `¥${formatNum(v)}`);
      const erTitle = siEmployerTooltip(r._siDetail);
      tbodyHTML += `
        <tr${isBonusRow ? ' class="bonus-row"' : ''}>
          <td>${r.month}</td>
          <td class="label-col">${buildNoteCellHTML(r, isSalary)}</td>
          <td>¥${formatNum(multiDirection === 'forward' ? r.preTax : r.postTax)}</td>
          ${isSalary
            ? `<td${r._siDetail ? ` title="养老 ¥${formatNum(r._siDetail.pension)} / 医疗 ¥${formatNum(r._siDetail.medical)} / 失业 ¥${formatNum(r._siDetail.unemployment)} / 公积金 ¥${formatNum(r._siDetail.fund)}"` : ''}>¥${formatNum(r.socialInsurance)}</td>
               <td${erTitle}>¥${formatNum(siEmployerTotal(r._siDetail))}</td>
               <td>¥${formatNum(r.extraDeduction)}</td>`
            : `<td>¥${formatNum(r.withholdingIncome)}</td>`}
          <td>${cumCell(r.cumIncome)}</td>
          <td>${cumCell(r.cumDeduction)}</td>
          <td>${cumCell(r.taxableIncome)}</td>
          <td>${formatRate(r.rate)}<div style="font-size:10px;color:var(--t-text-2);white-space:nowrap;">速算 ${formatNum(r.quick)}${isSalary && isBonusRow ? '（÷12）' : ''}</div></td>
          <td class="tax-col">¥${formatNum(r.currentTax)}</td>
          <td class="highlight">¥${formatNum(multiDirection === 'forward' ? r.postTax : r.preTax)}</td>
          <td>${isSalary ? (isBonusRow ? '年终奖' : '累计预扣') : (r._isOldPolicy ? '旧政策' : '新政策')}</td>
        </tr>`;
      /* 移动紧凑行（5 列）+ 展开明细网格；列集按 isSalary 分支，与桌面表头同源 */
      const mIn = `¥${formatNum(multiDirection === 'forward' ? r.preTax : r.postTax)}`;
      const mOut = `¥${formatNum(multiDirection === 'forward' ? r.postTax : r.preTax)}`;
      const mi = (k, vHtml, wide) => `<div class="mi${wide ? ' wide' : ''}"><span class="k">${k}</span><span class="v">${vHtml}</span></div>`;
      const mDetail = [
        mi('备注', buildNoteCellHTML(r, isSalary), true),
        isSalary
          ? mi('社保公积金(个人)', `¥${formatNum(r.socialInsurance)}`)
          : mi('本次预扣收入额', `¥${formatNum(r.withholdingIncome)}`),
        ...(isSalary ? [
          mi('社保公积金(单位)', `¥${formatNum(siEmployerTotal(r._siDetail))}`),
          mi('专项附加', `¥${formatNum(r.extraDeduction)}`),
        ] : []),
        mi('累计发放金额', cumCell(r.cumIncome)),
        mi('累计减除费用', cumCell(r.cumDeduction)),
        mi('累计应纳税所得额', cumCell(r.taxableIncome)),
        mi('政策类型', isSalary ? (isBonusRow ? '年终奖' : '累计预扣') : (r._isOldPolicy ? '旧政策' : '新政策')),
      ].join('');
      mobileTbodyHTML += `
        <tr${isBonusRow ? ' class="bonus-row"' : ''}>
          <td>${r.month}<button type="button" class="m-expand-btn" aria-label="展开或收起该月明细" onclick="UI.toggleMobileDetailRow(this)">▾</button></td>
          <td>${mIn}</td>
          <td>${formatRate(r.rate)}</td>
          <td class="tax-col">¥${formatNum(r.currentTax)}</td>
          <td class="highlight">${mOut}</td>
        </tr>
        <tr class="m-detail-row"><td colspan="5"><div class="m-detail-grid">${mDetail}</div></td></tr>`;
      yPre += r.preTax; yTax += r.currentTax; yPost += r.postTax;
    });
    // 年度小计
    if (years.length > 1) {
      tbodyHTML += `<tr class="subtotal-row">
        <td colspan="2" style="text-align:right;color:var(--t-text-2);">${yr} 年小计</td>
        <td>¥${formatNum(multiDirection === 'forward' ? yPre : yPost)}</td>
        ${isSalary ? '<td></td><td></td><td></td>' : '<td></td>'}
        <td></td><td></td><td></td><td></td>
        <td class="tax-col">¥${formatNum(yTax)}</td>
        <td class="highlight">¥${formatNum(multiDirection === 'forward' ? yPost : yPre)}</td>
        <td></td>
      </tr>`;
      mobileTbodyHTML += `<tr class="subtotal-row">
        <td>${yr} 年小计</td>
        <td>¥${formatNum(multiDirection === 'forward' ? yPre : yPost)}</td>
        <td></td>
        <td class="tax-col">¥${formatNum(yTax)}</td>
        <td class="highlight">¥${formatNum(multiDirection === 'forward' ? yPost : yPre)}</td>
      </tr>`;
    }
  });

  container.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item">
        <div class="label">${isSalary ? '累计应发' : '累计税前'}</div>
        <div class="value blue">¥${formatNum(totalPre)}</div>
      </div>
      <div class="summary-item">
        <div class="label">累计税额</div>
        <div class="value red">¥${formatNum(totalTax)}</div>
      </div>
      <div class="summary-item">
        <div class="label">${isSalary ? '累计实发' : '累计税后'}</div>
        <div class="value green">¥${formatNum(totalPost)}</div>
      </div>
      <div class="summary-item">
        <div class="label">平均税负率</div>
        <div class="value orange">${(avgRate * 100).toFixed(2)}%</div>
      </div>
      ${isSalary ? `
      <div class="summary-item">
        <div class="label">社保公积金(单位)</div>
        <div class="value" style="color:var(--t-text-2);">¥${formatNum(totalEmployer)}</div>
      </div>
      <div class="summary-item">
        <div class="label">企业用工总成本</div>
        <div class="value orange">¥${formatNum(round2(totalPre + totalEmployer))}</div>
      </div>` : ''}
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <span style="background:var(--t-primary);color:#fff;font-size:12px;padding:5px 14px;border-radius:20px;font-weight:700;"> ${multiDirLabel}</span>
      <span style="color:var(--t-text-2);font-size:13px;">计算模式</span>
    </div>
    ${bonusCard}
    ${(extraMsgs.length || medicalAnnual > 0) ? `<div class="info-box" style="margin-bottom:16px;">${extraMsgs.map(m => `<div style="font-size:12px;color:var(--t-warning);padding:2px 0;"> ${m}</div>`).join('')}${medicalAnnual > 0 ? `<div style="font-size:12px;color:var(--t-text-2);padding:2px 0;"> 年度汇算提示：大病医疗可扣除金额约 ¥${formatNum(Math.max(0, Math.min(medicalAnnual - 15000, 80000)))}（自付超 15,000 元部分，限额 80,000 元），请在次年 3~6 月汇算清缴时申报。</div>` : ''}</div>` : ''}
    <div class="result-card card-wide">
      <div class="result-header">
        <span>逐月明细</span>
        <span style="display:flex;gap:8px;">
          ${isSalary ? `<button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageMulti.exportMultiExcelFormula()"> 导出 Excel（公式明细）</button>` : ''}
          <button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageMulti.exportMultiCSV()"> 导出 CSV</button>
          <button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageReport.printReport('multi')"> 打印报告</button>
          <button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageShare.shareMulti()"> 分享链接</button>
        </span>
      </div>
      <div class="only-desktop">
        <div style="overflow-x:auto;">
          <table class="result-table detail-table${isSalary ? ' salary' : ''}">
            <thead>
              <tr>
                <th>月份</th>
                <th>备注</th>
                <th>${inLabel}</th>
                ${isSalary ? '<th>社保公积金(个人)</th><th>社保公积金(单位)</th><th>专项附加</th>' : '<th>本次预扣收入额</th>'}
                <th>累计发放金额</th>
                <th>累计减除费用</th>
                <th>累计应纳税所得额</th>
                <th>适用税率</th>
                <th>本期预扣税额</th>
                <th>${outLabel}</th>
                <th>政策类型</th>
              </tr>
            </thead>
            <tbody>
              ${tbodyHTML}
              <tr class="total-row">
                <td colspan="2">合计</td>
                <td>¥${formatNum(multiDirection === 'forward' ? totalPre : totalPost)}</td>
                ${isSalary
                  ? `<td>¥${formatNum(totalSI)}</td><td>¥${formatNum(totalEmployer)}</td><td>¥${formatNum(totalExtra)}</td>`
                  : `<td>¥${formatNum(results.reduce((s,r) => s + r.withholdingIncome, 0))}</td>`}
                <td></td>
                <td>¥${formatNum(results.reduce((s,r) => s + (r.cumDeduction || 0), 0))}</td>
                <td></td>
                <td></td>
                <td class="tax-col">¥${formatNum(totalTax)}</td>
                <td class="highlight">¥${formatNum(multiDirection === 'forward' ? totalPost : totalPre)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="only-mobile" style="padding:4px 12px 12px;">
        <table class="result-table m-compact">
          <thead>
            <tr>
              <th>月份</th>
              <th>${inLabel}</th>
              <th>税率</th>
              <th>本期预扣</th>
              <th>${outLabel}</th>
            </tr>
          </thead>
          <tbody>
            ${mobileTbodyHTML}
            <tr class="total-row">
              <td>合计</td>
              <td>¥${formatNum(multiDirection === 'forward' ? totalPre : totalPost)}</td>
              <td></td>
              <td class="tax-col">¥${formatNum(totalTax)}</td>
              <td class="highlight">¥${formatNum(multiDirection === 'forward' ? totalPost : totalPre)}</td>
            </tr>
          </tbody>
        </table>
        <div style="font-size:11px;color:var(--t-text-3);padding:6px 2px 0;">点击月份右侧按钮展开该月完整明细</div>
      </div>
    </div>
  `;

  // Store for export
  window._multiResults = results;
}

function exportMultiCSV() {
  if (!window._multiResults) return;
  const results = window._multiResults;
  const isSalary = incomeType === 'salary';
  const { preLabel, postLabel } = incomeIOLabels(multiDirection, '期望实发（已知）');
  let header, rows;
  if (isSalary) {
    header = `月份,备注,${preLabel},社保公积金(个人),社保公积金(单位),专项附加扣除,累计发放金额,累计减除费用,累计应纳税所得额,适用税率,速算扣除数,本期预扣税额,${postLabel},计税方式\n`;
    rows = results.map(r =>
      `${r.month},${r.note}${r._isBonus ? (r._bonusSeparate ? '(单独计税)' : '(并入综合所得)') : ''},${round2(multiDirection === 'forward' ? r.preTax : r.postTax)},${round2(r.socialInsurance || 0)},${round2(siEmployerTotal(r._siDetail))},${round2(r.extraDeduction || 0)},${r._isBonus && r._bonusSeparate ? '' : round2(r.cumIncome)},${r._isBonus && r._bonusSeparate ? '' : round2(r.cumDeduction || 0)},${r._isBonus && r._bonusSeparate ? '' : round2(r.taxableIncome)},${formatRate(r.rate)},${round2(r.quick || 0)},${round2(r.currentTax)},${round2(multiDirection === 'forward' ? r.postTax : r.preTax)},${r._isBonus ? '年终奖' : '累计预扣'}`
    ).join('\n');
  } else {
    header = `月份,备注,${preLabel},本次预扣收入额,累计发放金额,累计减除费用,累计应纳税所得额,适用税率,速算扣除数,本期预扣税额,${postLabel},政策类型\n`;
    rows = results.map(r =>
      `${r.month},${r.note},${round2(multiDirection === 'forward' ? r.preTax : r.postTax)},${round2(r.withholdingIncome)},${round2(r.cumIncome)},${round2(r.cumDeduction || 0)},${round2(r.taxableIncome)},${formatRate(r.rate)},${round2(r.quick || 0)},${round2(r.currentTax)},${round2(multiDirection === 'forward' ? r.postTax : r.preTax)},${r._isOldPolicy ? '旧政策' : '新政策'}`
    ).join('\n');
  }
  downloadFile(header + rows, '多月个税计算结果.csv', 'text/csv');
}


  window.PageMulti = { MONTH_NAMES,buildBonusSeparateRow,buildMonthGrid,buildNoteCellHTML,calcMulti,exportMultiCSV,exportMultiExcelFormula,insertBonusRowSorted,onMonthAmountInput,readMultiBonus,renderMultiResults,resetMulti,setMultiBonusStrategy,updateMultiInputHints };
})();
