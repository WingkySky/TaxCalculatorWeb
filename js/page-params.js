/* ============================================================
 * page-params.js — PageParams 工资参数卡组件（内嵌于多月累计页，仅工资薪金模式显示）
 * 职责：城市/年度/公积金比例联动、参数读取、卡片折叠与摘要、政策明细预览表、
 *       专项附加分项面板、批量页「整批参保城市」下拉联动。
 * 对外接口：window.PageParams。依赖：PolicyLib/SocialIns/UI/TaxState/TaxUtils。
 * ============================================================ */
(function () {
'use strict';
  const { round2, formatRate, formatNum } = TaxUtils;
  const { CITY_POLICY_LIBRARY, FUND_RATES_STD, SI_ITEMS, isPolicyDataFileMissing, resolvePolicy } = PolicyLib;
  const { EXTRA_ITEM_STANDARDS, computeSocialInsuranceDetail, computeExtraDetailFor, suggestHouseRentTier } = SocialIns;

function onExtraDetailToggle() {
  const cb = document.getElementById('sp-extra-detail-on');
  salaryParams.extraDetail.on = !!(cb && cb.checked);
  const wrap = document.getElementById('sp-extra-detail-wrap');
  if (wrap) wrap.style.display = salaryParams.extraDetail.on ? '' : 'none';
  const single = document.getElementById('sp-extra-deduction');
  if (single) single.disabled = salaryParams.extraDetail.on;
  renderExtraDetailPanel();
  renderParamsSummary();
}

function onExtraItemToggle(key, checked) {
  salaryParams.extraDetail[key].on = !!checked;
  // 互斥：住房贷款利息与住房租金不得同时扣除，勾选其一自动取消另一个
  if (checked && key === 'houseLoan' && salaryParams.extraDetail.houseRent.on) {
    salaryParams.extraDetail.houseRent.on = false;
  }
  if (checked && key === 'houseRent' && salaryParams.extraDetail.houseLoan.on) {
    salaryParams.extraDetail.houseLoan.on = false;
  }
  renderExtraDetailPanel();
}

function onExtraItemInput(key, field, value) {
  const d = salaryParams.extraDetail[key];
  if (!d) return;
  if (field === 'count') d.count = Math.max(0, Math.floor(Number(value) || 0));
  else if (field === 'tier') { d.tier = Number(value) || 1500; d.tierUntouched = true; }
  else if (field === 'share') d.share = Math.max(0, Number(value) || 0);
  else if (field === 'annual') d.annual = Math.max(0, Number(value) || 0);
  else if (field === 'kind') d.kind = value === 'cert' ? 'cert' : 'degree';
  else if (field === 'certMonth') d.certMonth = /^\d{4}-\d{2}$/.test(String(value).trim()) ? String(value).trim() : '';
  renderExtraDetailPanel();
}

/** 渲染分项明细行 + 政策校验提示 + 月度合计 */
function renderExtraDetailPanel() {
  const wrap = document.getElementById('sp-extra-detail-wrap');
  if (!wrap) return;
  const d = salaryParams.extraDetail;
  const CTRL_STYLE = 'background:var(--t-bg-header);border:1px solid var(--t-border);border-radius:6px;padding:4px 8px;color:var(--t-text);font-size:12px;outline:none;';
  const inp = (key, field, value, min, step, width) =>
    `<input type="number" min="${min}" step="${step}" value="${value == null ? '' : value}"
      oninput="PageParams.onExtraItemInput('${key}','${field}',this.value)"
      style="width:${width || 80}px;${CTRL_STYLE}">`;
  const sel = (key, field, options, value) =>
    `<select onchange="PageParams.onExtraItemInput('${key}','${field}',this.value)"
      style="${CTRL_STYLE}">
      ${options.map(o => `<option value="${o[0]}" ${String(o[0]) === String(value) ? 'selected' : ''}>${o[1]}</option>`).join('')}
    </select>`;
  const row = (key, label, controls, note) => `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0;border-top:1px solid var(--t-border);">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t-text);min-width:150px;cursor:pointer;">
        <input type="checkbox" ${d[key].on ? 'checked' : ''} onchange="PageParams.onExtraItemToggle('${key}',this.checked)"> ${label}
      </label>
      <span style="font-size:11px;color:var(--t-text-2);min-width:170px;">${EXTRA_ITEM_STANDARDS[key]}</span>
      <span style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t-text-2);flex:1;min-width:220px;">${controls || ''}
        ${note ? `<span style="font-size:11px;color:var(--t-text-2);">${note}</span>` : ''}</span>
    </div>`;
  const monthInp = (key, field, value) =>
    `<input type="month" value="${value || ''}" onchange="PageParams.onExtraItemInput('${key}','${field}',this.value)"
      style="${CTRL_STYLE}">`;

  wrap.innerHTML = `
    ${row('childEducation', ' 子女教育', `每孩 ${inp('childEducation', 'count', d.childEducation.count, 0, 1)}`)}
    ${row('infantCare', ' 3岁以下婴幼儿照护', `每孩 ${inp('infantCare', 'count', d.infantCare.count, 0, 1)}`)}
    ${row('education', ' 继续教育',
      sel('education', 'kind', [['degree', '学历（学位）继续教育'], ['cert', '职业资格继续教育']], d.education.kind) +
      (d.education.kind === 'cert' ? ` 取得月份 ${monthInp('education', 'certMonth', d.education.certMonth)}` : ''))}
    ${row('houseLoan', ' 住房贷款利息', '首套房贷，与住房租金互斥（勾选自动取消房租）')}
    ${row('houseRent', '住房租金',
      sel('houseRent', 'tier', [[1500, '1500（直辖市/省会/计划单列市）'], [1100, '1100（市辖区户籍人口＞100万）'], [800, '800（≤100万）']], d.houseRent.tier),
      '切换参保城市会自动推荐档位')}
    ${row('support', ' 赡养老人',
      sel('support', 'mode', [['solo', '独生子女'], ['share', '非独生分摊']], d.support.mode) +
      (d.support.mode === 'share' ? ` 本人均摊 ${inp('support', 'share', d.support.share, 0, 0.01)} 元/月` : ''))}
    ${row('medical', ' 大病医疗', `年度自付 ${inp('medical', 'annual', d.medical.annual, 0, 0.01, 110)} 元`, '不参与每月预扣，年度汇算清缴时申报')}
    <div id="sp-extra-messages" style="padding-top:6px;"></div>
  `;
  updateExtraDetailHint();
}

/** 月度合计徽标 + 校验消息 */
function updateExtraDetailHint() {
  const hint = document.getElementById('sp-extra-total-hint');
  const msgEl = document.getElementById('sp-extra-messages');
  const r = computeExtraDetailFor(salaryParams.extraDetail, '');
  if (hint) {
    hint.textContent = salaryParams.extraDetail.on
      ? `月度合计（除职业资格取证月）¥${formatNum(r.total)}`
      : '';
  }
  if (msgEl) {
    msgEl.innerHTML = r.messages.map(m =>
      `<div style="font-size:11px;color:var(--t-warning);padding:2px 0;"> ${m}</div>`).join('');
  }
}


/** 城市下拉选项 HTML（含自定义；skipCustom 用于批量行内城市场景）。
 *  337 城起按 region 分 optgroup（省份分组），无 region 的城市（自定义/用户新增）平铺在前。 */
function buildCityOptions(selectedValue, skipCustom) {
  const plain = [];
  const groups = {};
  Object.entries(CITY_POLICY_LIBRARY)
    .filter(([key]) => !(skipCustom && key === 'custom'))
    .forEach(([key, city]) => {
      const opt = `<option value="${key}" ${key === selectedValue ? 'selected' : ''}>${city.name}</option>`;
      if (city.region) (groups[city.region] = groups[city.region] || []).push(opt);
      else plain.push(opt);
    });
  return plain.join('') + Object.entries(groups)
    .map(([region, opts]) => `<optgroup label="${region}">${opts.join('')}</optgroup>`).join('');
}

/** 城市切换：重建年度/公积金比例选项后再读取参数 */
function onCityParamChange() {
  const cityId = document.getElementById('sp-city')?.value || 'custom';  const city = CITY_POLICY_LIBRARY[cityId] || CITY_POLICY_LIBRARY.custom;
  const yearSel = document.getElementById('sp-year');
  if (yearSel) {
    yearSel.innerHTML = `<option value="auto" ${salaryParams.policyYear === 'auto' ? 'selected' : ''}>自动匹配</option>` +
      Object.keys(city.years).map(yk =>
        `<option value="${yk}" ${yk === salaryParams.policyYear ? 'selected' : ''}>${city.years[yk].label || yk}</option>`).join('');
  }
  const frSel = document.getElementById('sp-fund-rate');
  const frCustomWrap = document.getElementById('sp-fund-rate-custom-wrap');
  const rates = (city.years[Object.keys(city.years)[0]]?.items?.fund?.rates) || FUND_RATES_STD;
  if (frSel && frCustomWrap) {
    if (cityId === 'custom') {
      frSel.style.display = 'none';
      frCustomWrap.style.display = '';
    } else {
      frSel.style.display = '';
      frCustomWrap.style.display = 'none';
      frSel.innerHTML = rates.map(r =>
        `<option value="${r}" ${Number(r) === Number(salaryParams.fundRate) ? 'selected' : ''}>${formatRate(r)}</option>`).join('');
      // 当前比例不在该城市可选档内时重置为最低档
      if (!rates.some(r => Number(r) === Number(salaryParams.fundRate))) {
        frSel.value = String(rates[0]);
      }
    }
  }
  // 住房租金档位按城市自动推荐（用户手动改过档位后不再覆盖）
  if (!salaryParams.extraDetail.houseRent.tierUntouched) {
    salaryParams.extraDetail.houseRent.tier = suggestHouseRentTier(cityId);
  }
  refreshBatchCitySelect();
  readSalaryParams();
}

/* ---------- 内嵌参数卡：折叠 / 摘要 / 批量城市下拉联动 ---------- */

const PARAMS_CARD_KEY = 'tc-params-card-collapsed';

/** 卡片头摘要：城市 · 社保基数 · 公积金比例 · 附加月合计（随输入实时刷新） */
function renderParamsSummary() {
  const el = document.getElementById('params-card-summary');
  if (!el) return;
  const city = CITY_POLICY_LIBRARY[salaryParams.cityId];
  const base = salaryParams.socialBase > 0 ? `基数 ¥${formatNum(salaryParams.socialBase)}` : '基数未设';
  const extraTotal = salaryParams.extraDetail.on
    ? computeExtraDetailFor(salaryParams.extraDetail, '').total
    : salaryParams.extraDeduction;
  el.textContent = `${city ? city.name : '自定义'} · ${base} · 公积金 ${formatRate(salaryParams.fundRate)} · 附加 ¥${formatNum(extraTotal)}/月`;
}

function applyCardCollapsed(collapsed) {
  const body = document.getElementById('params-card-body');
  const arrow = document.getElementById('params-card-arrow');
  if (body) body.style.display = collapsed ? 'none' : '';
  if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
}

/** 点击卡片头切换折叠；状态记忆到 localStorage */
function toggleCard() {
  const body = document.getElementById('params-card-body');
  if (!body) return;
  const collapsed = body.style.display === 'none';
  applyCardCollapsed(!collapsed);
  localStorage.setItem(PARAMS_CARD_KEY, collapsed ? '0' : '1');
}

/** 初始化折叠态：无存储时按社保基数是否已设置决定（未设置→展开引导，已设→收起） */
function initCard() {
  const saved = localStorage.getItem(PARAMS_CARD_KEY);
  const collapsed = saved == null ? salaryParams.socialBase > 0 : saved === '1';
  applyCardCollapsed(collapsed);
}

/** 批量页「整批参保城市」下拉重建（保留当前选择）；政策库增删城市后经 onCityParamChange 联动 */
function refreshBatchCitySelect() {
  const sel = document.getElementById('batch-city');
  if (!sel) return;
  sel.innerHTML = `<option value="">跟随「工资参数」中的城市</option>` + buildCityOptions('', true);
  sel.value = batchCityId || '';
}

/** 预览月份：参数卡的月份输入值，缺省当前月 */
function getPreviewYM() {
  const now = new Date();
  const nowYM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const prevInput = document.getElementById('sp-preview-month');
  if (prevInput && !prevInput.value) prevInput.value = nowYM;
  return (prevInput && /^\d{4}-\d{2}$/.test(prevInput.value)) ? prevInput.value : nowYM;
}

function pmEscHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 前台轻徽标 HTML（纯函数，供自检）：custom 城市不出徽标；prov 缺失不渲染，永不报错 */
function provenanceBadgeHtml(cityKey, yearKey, prov) {
  if (!cityKey || cityKey === 'custom' || !prov) return '';
  const status = prov.status || 'unverified';
  const text = (yearKey || '') + '年度 · ' + PolicyLib.statusLabel(status) + (status === 'confirmed' ? ' ✓' : '');
  return `<button type="button" class="pol-status-badge is-clickable pol-status-${status}"
    onclick="PageParams.showProvenanceModal()" title="点击查看政策来源与核查信息">${pmEscHtml(text)}</button>`;
}

/** 点击徽标弹出来源浮层：年度、状态、最近核查、口径备注、来源列表（文号/发布方/日期/确认内容/原文链接） */
function showProvenanceModal() {
  const pol = resolvePolicy(salaryParams.cityId, getPreviewYM());
  if (!pol || !pol.provenance || pol.cityKey === 'custom') return;
  const p = pol.provenance;
  const parts = [];
  parts.push(`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
    <div style="font-size:14px;font-weight:600;">政策来源与核查</div>
    <button type="button" class="btn btn-secondary btn-sm" data-close="1">关闭</button>
  </div>`);
  parts.push(`<div style="font-size:12px;color:var(--t-text-2);margin-top:8px;">适用政策：${pmEscHtml(pol.label)}</div>`);
  parts.push(`<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    <span class="pol-status-badge pol-status-${p.status}">${pmEscHtml(PolicyLib.statusLabel(p.status))}</span>
    ${p.checkedAt ? `<span style="font-size:12px;color:var(--t-text-2);">最近核查 ${pmEscHtml(p.checkedAt)}</span>` : ''}
  </div>`);
  if (p.note) parts.push(`<div style="font-size:12px;margin-top:8px;">口径备注：${pmEscHtml(p.note)}</div>`);
  if (p.sources.length) {
    parts.push(`<div style="font-size:12px;font-weight:600;margin-top:12px;">政策来源（${p.sources.length}）</div>`);
    p.sources.forEach(s => {
      const head = s.title + (s.ref ? `（${s.ref}）` : '');
      const meta = [s.publisher, s.date].filter(Boolean).join(' · ');
      const safeUrl = /^https?:\/\//i.test(s.url || '') ? s.url : '';
      parts.push(`<div class="pol-prov-source">
        <div style="font-weight:600;">${pmEscHtml(head)}</div>
        ${meta ? `<div style="color:var(--t-text-2);margin-top:2px;">${pmEscHtml(meta)}</div>` : ''}
        ${s.confirms ? `<div style="margin-top:2px;">${pmEscHtml(s.confirms)}</div>` : ''}
        ${safeUrl ? `<div style="margin-top:2px;"><a href="${pmEscHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--t-primary);word-break:break-all;">查看原文</a></div>` : ''}
      </div>`);
    });
  } else {
    parts.push(`<div style="font-size:12px;color:var(--t-text-2);margin-top:12px;">暂无来源记录。</div>`);
  }
  parts.push(`<div style="font-size:11px;color:var(--t-text-2);margin-top:12px;border-top:1px solid var(--t-border);padding-top:8px;">政策数据仅供参考，以当地社保部门公布的官方文件为准。</div>`);
  const ov = document.createElement('div');
  ov.className = 'pol-prov-overlay';
  ov.innerHTML = `<div class="pol-prov-modal" role="dialog" aria-label="政策来源与核查">${parts.join('')}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  const closeBtn = ov.querySelector('[data-close]');
  if (closeBtn) closeBtn.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}

/** 渲染参数卡中的险种政策明细表（只读；预览月份默认当前月，可切换） */
function renderSalaryItemsTable() {
  const el = document.getElementById('sp-items-table');
  if (!el) return;
  const missingEl = document.getElementById('sp-data-missing');
  if (missingEl) missingEl.style.display = isPolicyDataFileMissing() ? '' : 'none';
  const previewYM = getPreviewYM();
  const pol = resolvePolicy(salaryParams.cityId, previewYM);
  const det = computeSocialInsuranceDetail(salaryParams.socialBase, salaryParams.fundBase, pol.items, salaryParams.fundRate);
  const fmtBound = (v) => (v == null ? '不限' : formatNum(v));
  const fmtRate = (r) => (r == null ? '同个人档' : formatRate(r));
  el.innerHTML = `
    <thead>
      <tr>
        <th colspan="7" style="text-align:left;color:var(--t-text-2);font-weight:500;">适用政策（按预览月份 ${previewYM} 匹配）：${pol.label}${pol.matched ? '' : '（未精确匹配月份，已用最新年度）'}<span style="float:right;">${provenanceBadgeHtml(pol.cityKey, pol.yearKey, pol.provenance)}</span></th>
      </tr>
      <tr><th>险种</th><th>个人比例</th><th>单位比例</th><th>基数下限</th><th>基数上限</th><th>个人实缴</th><th>单位实缴</th></tr>
    </thead>
    <tbody>
      ${SI_ITEMS.map(it => {
        const item = pol.items[it.key];
        if (!item) return '';
        const rate = it.key === 'fund' ? (salaryParams.fundRate ?? item.personal) : item.personal;
        const erRate = it.key === 'fund' ? (item.employer != null ? item.employer : null) : item.employer;
        return `<tr>
          <td>${it.label}</td>
          <td>${formatRate(rate)}</td>
          <td>${fmtRate(erRate)}</td>
          <td>${fmtBound(item.lower)}</td>
          <td>${fmtBound(item.upper)}</td>
          <td style="color:var(--t-primary);">¥${formatNum(det[it.key] || 0)}</td>
          <td style="color:var(--t-text-2);">¥${formatNum(det.employer[it.key] || 0)}</td>
        </tr>`;
      }).join('')}
      <tr class="total-row"><td colspan="5">社保公积金合计（个人/月）</td><td style="color:var(--t-primary);">¥${formatNum(det.total)}</td><td></td></tr>
      <tr class="total-row"><td colspan="5">单位缴纳合计（企业/月）</td><td></td><td style="color:var(--t-text-2);">¥${formatNum(det.employer.total)}</td></tr>
      ${salaryParams.socialBase > 0 ? `<tr class="total-row"><td colspan="5">企业用工总成本（月薪 ${formatNum(salaryParams.socialBase)} 口径）</td><td colspan="2" style="color:var(--t-warning);">¥${formatNum(round2(salaryParams.socialBase + det.employer.total))}</td></tr>` : ''}
    </tbody>`;
}

/**
 * 从「工资参数」读取输入到 salaryParams；非法输入标红并保留上一次合法值
 * @returns {boolean} 是否全部合法
 */
function readSalaryParams() {
  let ok = true;
  const readNum = (id, min, max) => {
    const el = document.getElementById(id);
    if (!el) return '';
    const raw = String(el.value).trim();
    if (raw === '') { el.classList.remove('input-error'); return ''; }
    const v = parseFloat(raw);
    if (!isFinite(v) || v < min || v > max) { el.classList.add('input-error'); ok = false; return ''; }
    el.classList.remove('input-error');
    return v;
  };
  const citySel = document.getElementById('sp-city');
  if (citySel && CITY_POLICY_LIBRARY[citySel.value]) salaryParams.cityId = citySel.value;
  const yearSel = document.getElementById('sp-year');
  if (yearSel) salaryParams.policyYear = yearSel.value || 'auto';
  const frSel = document.getElementById('sp-fund-rate');
  const frCustom = document.getElementById('sp-fund-rate-custom');
  if (salaryParams.cityId === 'custom') {
    const v = frCustom ? readNum('sp-fund-rate-custom', 0, 100) : '';
    if (v !== '') salaryParams.fundRate = v / 100;
  } else if (frSel && frSel.value !== '') {
    salaryParams.fundRate = Number(frSel.value);
  }
  const base = readNum('sp-social-base', 0, Infinity);
  if (base !== '') salaryParams.socialBase = base;
  salaryParams.fundBase = readNum('sp-fund-base', 0, Infinity);
  const extra = readNum('sp-extra-deduction', 0, Infinity);
  if (extra !== '') salaryParams.extraDeduction = extra;
  renderSalaryItemsTable();
  renderParamsSummary();
  return ok;
}


  window.PageParams = { buildCityOptions,initCard,onCityParamChange,onExtraDetailToggle,onExtraItemInput,onExtraItemToggle,provenanceBadgeHtml,readSalaryParams,refreshBatchCitySelect,renderExtraDetailPanel,renderParamsSummary,renderSalaryItemsTable,showProvenanceModal,toggleCard,updateExtraDetailHint };
})();
