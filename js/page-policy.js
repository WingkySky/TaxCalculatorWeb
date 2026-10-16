/* ============================================================
 * page-policy.js — PagePolicy 政策库页
 * 职责：政策库编辑器渲染、城市/年度增删、溯源编辑（状态/最近核查/备注/来源列表）、
 *       Excel/JSON 导入导出、存储状态展示。
 * 对外接口：window.PagePolicy。依赖：PolicyLib/UI/Exporter/TaxUtils。
 * ============================================================ */
(function () {
'use strict';
  const { round2, downloadFile } = TaxUtils;
  const { CITY_POLICY_LIBRARY, FUND_RATES_STD, SI_ITEMS, SI_ITEM_LABELS, _policyCache,
    fundItem, libraryToRows, normalizePolicyLibrary, officialDiffFor, restoreOfficialAll, restoreOfficialValue, rowsToLibrary, savePolicyLibrary, siItem } = PolicyLib;
  const { ensureXLSX, saveWorkbook } = Exporter;
  const { buildCityOptions, onCityParamChange, renderSalaryItemsTable } = PageParams;

// ==================== 政策数据管理弹层 ====================

/** 城市集合变化后同步各处下拉：重建参数卡城市选项，再触发年度/公积金/批量兜底盒联动刷新 */
function syncCitySelects() {
  const spCitySel = document.getElementById('sp-city');
  if (spCitySel) spCitySel.innerHTML = buildCityOptions(salaryParams.cityId);
  onCityParamChange();
}

window._pmCity = 'custom';
window._pmYear = '';

/** 当前编辑中的（城市, 年度）记录；无有效记录返回 null */
function pmCurrentYearRec() {
  const city = CITY_POLICY_LIBRARY[window._pmCity];
  return (city && city.years[window._pmYear]) || null;
}

/** 「自定义」兜底险种：默认比例、无上下限（新增城市 / 导入兜底共用） */
function defaultCustomItems() {
  return {
    pension:      siItem(0.08, null, null, 0.16),
    medical:      siItem(0.02, null, null, 0.08),
    unemployment: siItem(0.005, null, null, 0.005),
    injury:       siItem(0, null, null, 0.002),
    fund:         fundItem(FUND_RATES_STD.slice(), 0.05, null, null)
  };
}

/** 兜底「自定义」城市（默认比例，无上下限） */
function defaultCustomCity() {
  return {
    name: '自定义',
    years: {
      custom: {
        label: '自定义政策',
        effective: ['2000-01', '2999-12'],
        status: 'unverified',
        items: defaultCustomItems()
      }
    }
  };
}

function openPolicyModal() {
  // 政策库已从弹层升级为独立页面：保留「首次跟随工资参数城市」的语义，改为导航
  if (!window._pmModalInitialized && CITY_POLICY_LIBRARY[salaryParams.cityId]) {
    window._pmCity = salaryParams.cityId;
  }
  window._pmModalInitialized = true;
  if (window.App) App.navigate('policy');
  onPmCityChange();
}

function closePolicyModal() {
  if (window.App) App.navigate('params');
}

function pmCityOptionsHTML() {
  return PageParams.buildCityOptions(window._pmCity);
}

function onPmCityChange() {
  const sel = document.getElementById('pm-city');
  // 每次按政策库重建城市选项（首次打开/新增城市/导入后保持同步）；
  // 用户切换时优先采用下拉当前值，失效时回退到上次城市或自定义。
  const wanted = sel.value || window._pmCity;
  sel.innerHTML = pmCityOptionsHTML();
  window._pmCity = CITY_POLICY_LIBRARY[wanted] ? wanted
    : (CITY_POLICY_LIBRARY[window._pmCity] ? window._pmCity : 'custom');
  sel.value = window._pmCity;
  const city = CITY_POLICY_LIBRARY[window._pmCity];
  const yearKeys = Object.keys(city.years);
  if (!yearKeys.includes(window._pmYear)) window._pmYear = yearKeys[0];
  const yearSel = document.getElementById('pm-year');
  yearSel.innerHTML = yearKeys.map(yk =>
    `<option value="${yk}" ${yk === window._pmYear ? 'selected' : ''}>${city.years[yk].label || yk}</option>`).join('');
  onPmYearChange();
}

function onPmYearChange() {
  const sel = document.getElementById('pm-year');
  window._pmYear = sel.value;
  renderPolicyEditor();
}

/** 弹层顶部存储状态提示 */
function updatePmStorageStatus() {
  const el = document.getElementById('pm-storage-status');
  if (!el) return;
  if (window._policyStorageAvailable === false) {
    el.innerHTML = ' 当前浏览器环境不支持本地存储（如隐私模式），修改仅本次会话有效——请务必导出 Excel / JSON 备份。';
    return;
  }
  const remote = window._policyRemoteInfo;
  const remoteNote = remote
    ? `官方数据已自动更新 ${remote.from} → ${remote.to}，<strong>${remote.modified ? remote.modified + ' 处本地修改已保留' : '你的数据已同步到最新'}</strong>（标 ⟲ 字段可恢复官方值）。`
    : '';
  if (window._policyFromStorage) {
    el.innerHTML = ` ${remoteNote}政策数据已自动保存到本机浏览器（localStorage${window._policySavedAt ? '，更新于 ' + window._policySavedAt : ''}），刷新/重启后自动加载。<strong>不跨浏览器、不跨电脑，清除浏览器数据会丢失</strong>——跨机或长期备份请导出 Excel / JSON。`;
  } else {
    el.innerHTML = ` ${remoteNote}当前使用官方默认数据（线上访问自动更新，本地双击打开时由 tax-policy-data.js 提供）；在下方修改后会自动保存到本机浏览器，之后每次打开自动加载。`;
  }
}

function renderPolicyEditor() {
  updatePmStorageStatus();
  const rec = pmCurrentYearRec();
  const effStart = document.getElementById('pm-eff-start');
  const effEnd = document.getElementById('pm-eff-end');
  const label = document.getElementById('pm-label');
  if (!rec) {
    effStart.value = ''; effEnd.value = ''; label.value = '';
    document.getElementById('pm-items-wrap').innerHTML = '<div style="color:var(--t-text-2);font-size:13px;">请选择或新增年度</div>';
    renderPmStatusBadge(null);
    renderProvenanceEditor(null, null);
    return;
  }
  effStart.value = rec.effective ? rec.effective[0] : '';
  effEnd.value = rec.effective ? rec.effective[1] : '';
  label.value = rec.label || '';
  const diff = officialDiffFor(window._pmCity, window._pmYear);
  /** 官方值展示（恢复按钮 title 用） */
  const fmtOfficial = (field, v) => {
    if (v == null) return '不限';
    if (field === 'personal' || field === 'employer') return round2(v * 100) + '%';
    if (field === 'rates') return v.map(r => round2(r * 100)).join(',');
    return String(v);
  };
  /** 本地已改字段的「恢复官方值」角标 */
  const badge = (itemKey, field) => {
    // 官方值可能合法为 null（不限），必须按「存在 diff 条目」判断而非仅判值
    if (!diff || !diff[itemKey] || !(field in diff[itemKey])) return '';
    const off = diff[itemKey][field];
    const ck = window._pmCity, yk = window._pmYear;
    return ` <button type="button" class="pm-restore-btn" title="本地已修改（官方值：${fmtOfficial(field, off)}）。点击恢复官方值"
      onclick="PagePolicy.onPmRestoreField('${ck}','${yk}','${itemKey}','${field}')">⟲</button>`;
  };
  const numInput = (cityKey, yk, itemKey, field, value, step, placeholder) =>
    `<input class="pm-item-input" type="number" step="${step}" placeholder="${placeholder || ''}" value="${value == null ? '' : value}"
      onchange="PagePolicy.onPmItemInput('${cityKey}','${yk}','${itemKey}','${field}',this.value)">`;
  /* 移动形态：险种字段卡（偏方案B）——卡头=险种名（+待核对），卡体=数字输入竖排 */
  const pmMobileCard = (it, item) => {
    if (!item) {
      return `<div class="pm-card">
        <div class="pm-card-head">${SI_ITEM_LABELS[it.key]}</div>
        <div style="color:var(--t-text-2);font-size:13px;">—</div>
      </div>`;
    }
    const isFund = it.key === 'fund';
    return `<div class="pm-card">
      <div class="pm-card-head"><span>${it.label}${item.pending ? ' <span class="pending">待核对</span>' : ''}</span></div>
      <div class="pm-card-fields">
        <div class="f"><label>个人比例（%）</label>${numInput(window._pmCity, window._pmYear, it.key, 'personal', round2((item.personal || 0) * 100), 0.1, '8')}${badge(it.key, 'personal')}</div>
        <div class="f"><label>单位比例（%）</label>${numInput(window._pmCity, window._pmYear, it.key, 'employer', item.employer == null ? '' : round2(item.employer * 100), 0.1, isFund ? '同个人档' : '0')}${badge(it.key, 'employer')}</div>
        <div class="f"><label>基数下限</label>${numInput(window._pmCity, window._pmYear, it.key, 'lower', item.lower, 0.01, '不限')}${badge(it.key, 'lower')}</div>
        <div class="f"><label>基数上限</label>${numInput(window._pmCity, window._pmYear, it.key, 'upper', item.upper, 0.01, '不限')}${badge(it.key, 'upper')}</div>
        ${isFund ? `<div class="f wide"><label>公积金比例档（%，逗号分隔）</label><input class="pm-item-input" value="${(item.rates || []).map(r => round2(r * 100)).join(',')}"
          onchange="PagePolicy.onPmFundRatesInput(this.value)">${badge(it.key, 'rates')}</div>` : ''}
      </div>
    </div>`;
  };
  document.getElementById('pm-items-wrap').innerHTML = `
    <div class="only-desktop">
      <div style="overflow-x:auto;border:1px solid var(--t-border);border-radius:8px;">
        <table class="result-table" style="font-size:12px;">
          <thead><tr><th>险种</th><th>个人比例（%）</th><th>单位比例（%）</th><th>基数下限</th><th>基数上限</th><th>公积金比例档（%，逗号分隔）</th></tr></thead>
          <tbody>
            ${SI_ITEMS.map(it => {
              const item = rec.items[it.key];
              if (!item) return `<tr><td>${SI_ITEM_LABELS[it.key]}</td><td colspan="5" style="color:var(--t-text-2);">—</td></tr>`;
              const isFund = it.key === 'fund';
              return `<tr>
                <td>${it.label}${item.pending ? ' <span style="color:var(--t-warning);font-size:10px;">待核对</span>' : ''}</td>
                <td>${numInput(window._pmCity, window._pmYear, it.key, 'personal', round2((item.personal || 0) * 100), 0.1, '8')}${badge(it.key, 'personal')}</td>
                <td>${numInput(window._pmCity, window._pmYear, it.key, 'employer', item.employer == null ? '' : round2(item.employer * 100), 0.1, isFund ? '同个人档' : '0')}${badge(it.key, 'employer')}</td>
                <td>${numInput(window._pmCity, window._pmYear, it.key, 'lower', item.lower, 0.01, '不限')}${badge(it.key, 'lower')}</td>
                <td>${numInput(window._pmCity, window._pmYear, it.key, 'upper', item.upper, 0.01, '不限')}${badge(it.key, 'upper')}</td>
                <td>${isFund ? `<input class="pm-item-input" value="${(item.rates || []).map(r => round2(r * 100)).join(',')}"
                  onchange="PagePolicy.onPmFundRatesInput(this.value)">${badge(it.key, 'rates')}` : '<span style="color:var(--t-text-2);">—</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="only-mobile">
      ${SI_ITEMS.map(it => pmMobileCard(it, rec.items[it.key])).join('')}
    </div>
    <div style="font-size:11px;color:var(--t-text-2);margin-top:6px;">比例与上下限留空表示不限制；公积金单位比例留空表示与个人同档；修改后立即生效（编辑过的险种会移除「待核对」标记）${diff ? '；与官方默认不同的字段标 <span class="pm-restore-btn" style="cursor:default;">⟲</span>，点击可恢复官方值' : ''}。</div>`;
  renderPmStatusBadge(rec);
  renderProvenanceEditor(rec, diff);
}

/* ==================== 来源与核查（溯源编辑区） ==================== */

const PM_STATUS_OPTIONS = [['confirmed', '已核实（全部险种有官方依据）'], ['partial', '部分核实（部分险种有依据）'], ['unverified', '待核实（无从核对）']];

/** 年度选择旁的状态徽标 */
function renderPmStatusBadge(rec) {
  const el = document.getElementById('pm-status-badge');
  if (!el) return;
  if (!rec) { el.className = ''; el.textContent = '—'; return; }
  el.className = 'pol-status-badge pol-status-' + (rec.status || 'unverified');
  el.textContent = PolicyLib.statusLabel(rec.status);
}

function pmEscAttr(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 「来源与核查」编辑区：状态下拉、最近核查、口径备注、来源列表、险种有据派生提示 */
function renderProvenanceEditor(rec, diff) {
  const wrap = document.getElementById('pm-prov-wrap');
  if (!wrap) return;
  if (!rec) { wrap.innerHTML = ''; return; }
  const status = rec.status || 'unverified';
  const recDiff = diff && diff.__rec ? diff.__rec : null;
  const restoreBtn = (field, officialText) => (recDiff && (field in recDiff))
    ? ` <button type="button" class="pm-restore-btn" title="本地已修改（官方值：${pmEscAttr(officialText)}）。点击恢复官方值"
        onclick="PagePolicy.onPmRestoreField('${window._pmCity}','${window._pmYear}','__rec','${field}')">⟲</button>`
    : '';
  const sources = Array.isArray(rec.sources) ? rec.sources : [];
  const srcRows = sources.map((s, i) => `
    <div style="border:1px solid var(--t-border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--t-bg-header);">
      <div class="row-flex" style="margin-bottom:6px;">
        <div class="sp-field" style="flex:1;min-width:240px;"><label>标题（必填，留空不保留）</label>
          <input class="pm-item-input" style="text-align:left;" value="${pmEscAttr(s.title)}" onchange="PagePolicy.onPmSourceFieldChange(${i},'title',this.value)"></div>
        <div class="sp-field" style="width:190px;"><label>文号</label>
          <input class="pm-item-input" style="text-align:left;" placeholder="如 粤府函〔2026〕188号" value="${pmEscAttr(s.ref)}" onchange="PagePolicy.onPmSourceFieldChange(${i},'ref',this.value)"></div>
        <div class="sp-field" style="width:150px;"><label>发布日期</label>
          <input class="pm-item-input" style="text-align:left;" placeholder="YYYY-MM-DD" value="${pmEscAttr(s.date)}" onchange="PagePolicy.onPmSourceFieldChange(${i},'date',this.value)"></div>
      </div>
      <div class="row-flex" style="margin-bottom:6px;">
        <div class="sp-field" style="flex:1;min-width:240px;"><label>链接 URL</label>
          <input class="pm-item-input" style="text-align:left;" placeholder="https://…" value="${pmEscAttr(s.url)}" onchange="PagePolicy.onPmSourceFieldChange(${i},'url',this.value)"></div>
        <div class="sp-field" style="width:220px;"><label>发布方</label>
          <input class="pm-item-input" style="text-align:left;" placeholder="如 广州市人社局" value="${pmEscAttr(s.publisher)}" onchange="PagePolicy.onPmSourceFieldChange(${i},'publisher',this.value)"></div>
      </div>
      <div class="row-flex" style="margin-bottom:6px;">
        <div class="sp-field" style="flex:1;min-width:240px;"><label>确认了什么（写具体数值与算式，如「上限 36348=12183×3」）</label>
          <input class="pm-item-input" style="text-align:left;" value="${pmEscAttr(s.confirms)}" onchange="PagePolicy.onPmSourceFieldChange(${i},'confirms',this.value)"></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--t-text-2);">
        <span>证实险种（不勾=不证实任何险种）：</span>
        ${SI_ITEMS.map(it => `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:var(--t-text);">
          <input type="checkbox" ${!Array.isArray(s.covers) || s.covers.indexOf(it.key) >= 0 ? 'checked' : ''}
            onchange="PagePolicy.onPmSourceCoversToggle(${i},'${it.key}',this.checked)"> ${it.label}</label>`).join('')}
        <button type="button" class="btn btn-secondary btn-sm" style="margin-left:auto;" onclick="PagePolicy.onPmSourceDelete(${i})">删除此来源</button>
      </div>
    </div>`).join('');
  const cov = SI_ITEMS.map(it => PolicyLib.itemCoveredBySources(it.key, sources)
    ? `<span style="color:var(--t-success);">${it.label} 有据</span>`
    : `<span style="color:var(--t-warning);">${it.label} 无据</span>`).join('<span style="color:var(--t-text-2);"> · </span>');
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin:16px 0 8px;font-size:13px;font-weight:600;">
      来源与核查${restoreBtn('sources', sources.length + ' 条来源')}
    </div>
    <div class="row-flex" style="margin-bottom:10px;">
      <div class="sp-field" style="width:280px;"><label>核查状态</label>
        <select onchange="PagePolicy.onPmStatusChange(this.value)">
          ${PM_STATUS_OPTIONS.map(o => `<option value="${o[0]}" ${o[0] === status ? 'selected' : ''}>${o[1]}</option>`).join('')}
        </select>${restoreBtn('status', PolicyLib.statusLabel(recDiff && recDiff.status))}
      </div>
      <div class="sp-field" style="width:190px;"><label>最近核查（YYYY-MM）</label>
        <input class="pm-item-input" style="text-align:left;" placeholder="未核查留空" value="${pmEscAttr(rec.checkedAt)}"
          onchange="PagePolicy.onPmCheckedAtChange(this.value)">${restoreBtn('checkedAt', (recDiff && recDiff.checkedAt) || '空')}
      </div>
      <div class="sp-field" style="flex:1;min-width:220px;"><label>口径备注（如「工伤按 0.2% 基准简化」）</label>
        <input class="pm-item-input" style="text-align:left;" value="${pmEscAttr(rec.note)}"
          onchange="PagePolicy.onPmNoteChange(this.value)">${restoreBtn('note', (recDiff && recDiff.note) || '空')}
      </div>
    </div>
    ${srcRows || '<div style="color:var(--t-text-2);font-size:12px;margin-bottom:8px;">暂无来源记录——没有来源的数值无法溯源核对，建议逐条补录官方文件。</div>'}
    <div style="margin-bottom:6px;"><button type="button" class="btn btn-secondary btn-sm" onclick="PagePolicy.onPmSourceAdd()">+ 新增来源</button></div>
    <div style="font-size:12px;margin-bottom:4px;">险种依据（按来源 covers 派生）：${cov}</div>
    <div style="font-size:11px;color:var(--t-text-2);">「有据」只表示该险种至少被一条来源覆盖；核查状态由你人工声明，不随来源自动变化。来源先在本机存档，推送官方数据需维护者更新 tax-policy-data.json。</div>`;
}

function onPmStatusChange(v) {
  const rec = pmCurrentYearRec();
  if (!rec) return;
  rec.status = PM_STATUS_OPTIONS.some(o => o[0] === v) ? v : 'unverified';
  _policyCache.clear();
  savePolicyLibrary();
  renderPolicyEditor();
  renderSalaryItemsTable();
}

function onPmCheckedAtChange(v) {
  const rec = pmCurrentYearRec();
  if (!rec) return;
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) rec.checkedAt = s; else delete rec.checkedAt;
  _policyCache.clear();
  savePolicyLibrary();
  renderPolicyEditor();
}

function onPmNoteChange(v) {
  const rec = pmCurrentYearRec();
  if (!rec) return;
  const s = String(v == null ? '' : v).trim();
  if (s) rec.note = s; else delete rec.note;
  _policyCache.clear();
  savePolicyLibrary();
}

function onPmSourceAdd() {
  const rec = pmCurrentYearRec();
  if (!rec) return;
  if (!Array.isArray(rec.sources)) rec.sources = [];
  rec.sources.push({ title: '' });
  savePolicyLibrary();
  renderPolicyEditor();
}

function onPmSourceDelete(idx) {
  const rec = pmCurrentYearRec();
  if (!rec || !Array.isArray(rec.sources) || !rec.sources[idx]) return;
  rec.sources.splice(idx, 1);
  if (!rec.sources.length) delete rec.sources;
  _policyCache.clear();
  savePolicyLibrary();
  renderPolicyEditor();
}

function onPmSourceFieldChange(idx, field, value) {
  const rec = pmCurrentYearRec();
  if (!rec || !Array.isArray(rec.sources) || !rec.sources[idx]) return;
  const s = rec.sources[idx];
  const v = String(value == null ? '' : value).trim();
  if (v) s[field] = v; else delete s[field];
  _policyCache.clear();
  savePolicyLibrary();
  renderPolicyEditor();
}

function onPmSourceCoversToggle(idx, key, checked) {
  const rec = pmCurrentYearRec();
  if (!rec || !Array.isArray(rec.sources) || !rec.sources[idx]) return;
  const s = rec.sources[idx];
  const allKeys = SI_ITEMS.map(it => it.key);
  // 显式存储勾选结果：未动过=缺省全项；全勾回缺省（不落盘）；空=明确不证实任何险种
  const set = (Array.isArray(s.covers) ? s.covers.slice() : allKeys.slice()).filter(k => allKeys.indexOf(k) >= 0);
  const i = set.indexOf(key);
  if (checked && i < 0) set.push(key);
  if (!checked && i >= 0) set.splice(i, 1);
  if (set.length === allKeys.length) delete s.covers;
  else s.covers = set;
  _policyCache.clear();
  savePolicyLibrary();
  renderPolicyEditor();
}

function onPmItemInput(cityKey, yk, itemKey, field, value) {
  const lib = CITY_POLICY_LIBRARY[cityKey];
  const rec = lib && lib.years[yk];
  const it = rec && rec.items[itemKey];
  if (!it) return;
  const raw = String(value).trim();
  if (raw === '' || field === 'lower' || field === 'upper') {
    const n = parseFloat(raw);
    it[field] = (raw === '' || isNaN(n)) ? null : n;
  } else {
    const n = parseFloat(raw);
    if (!isNaN(n)) it[field] = n / 100;
  }
  delete it.pending;
  _policyCache.clear();
  savePolicyLibrary();
  renderPolicyEditor();
  renderSalaryItemsTable();
}

function onPmFundRatesInput(value) {
  const rec = pmCurrentYearRec();
  const it = rec && rec.items.fund;
  if (!it) return;
  const rates = String(value).split(/[,，]/).map(s => parseFloat(s) / 100).filter(n => !isNaN(n) && n > 0);
  if (rates.length) { it.rates = rates; delete it.pending; }
  _policyCache.clear();
  savePolicyLibrary();
  renderSalaryItemsTable();
}

function onPmEffectiveChange() {
  const rec = pmCurrentYearRec();
  if (!rec) return;
  const s = document.getElementById('pm-eff-start').value.trim();
  const e = document.getElementById('pm-eff-end').value.trim();
  const ymRe = /^\d{4}-\d{2}$/;
  rec.effective = [ymRe.test(s) ? s : '2000-01', ymRe.test(e) ? e : '2999-12'];
  _policyCache.clear();
  savePolicyLibrary();
  renderSalaryItemsTable();
}

function onPmLabelChange() {
  const rec = pmCurrentYearRec();
  if (rec) rec.label = document.getElementById('pm-label').value.trim() || window._pmYear;
  _policyCache.clear();
  savePolicyLibrary();
  renderSalaryItemsTable();
}

function pmAddCity() {
  const name = prompt('新增城市名称（如：长沙）：');
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (Object.values(CITY_POLICY_LIBRARY).some(c => c.name === clean)) return alert('该城市已存在');
  const key = 'c' + Date.now().toString(36);
  CITY_POLICY_LIBRARY[key] = {
    name: clean,
    years: {
      custom: {
        label: clean + '政策',
        effective: ['2000-01', '2999-12'],
        status: 'unverified',
        items: defaultCustomItems()
      }
    }
  };
  _policyCache.clear();
  savePolicyLibrary();
  window._pmCity = key;
  onPmCityChange();
  syncCitySelects();
}

function pmAddYear() {
  const yk = prompt('新增年度键（如 2025）：');
  if (!yk || !/^\d{4}$/.test(yk.trim())) return alert('年度键需为 4 位年份');
  const key = yk.trim();
  const lib = CITY_POLICY_LIBRARY[window._pmCity];
  if (lib.years[key]) return alert('该年度已存在');
  lib.years[key] = {
    label: key + '年度',
    effective: [key + '-01', key + '-12'],
    status: 'unverified',
    items: JSON.parse(JSON.stringify(Object.values(lib.years)[0].items))
  };
  _policyCache.clear();
  savePolicyLibrary();
  window._pmYear = key;
  onPmCityChange();
}

function pmDeleteYear() {
  const lib = CITY_POLICY_LIBRARY[window._pmCity];
  const yearKeys = Object.keys(lib.years);
  if (yearKeys.length <= 1) return alert('至少保留一个年度');
  if (!confirm(`确认删除「${lib.name} ${lib.years[window._pmYear].label || window._pmYear}」？`)) return;
  delete lib.years[window._pmYear];
  window._pmYear = Object.keys(lib.years)[0];
  _policyCache.clear();
  savePolicyLibrary();
  onPmCityChange();
}

/** 单字段恢复官方值（⟲ 角标点击） */
function onPmRestoreField(cityKey, yk, itemKey, field) {
  if (!restoreOfficialValue(cityKey, yk, itemKey, field)) return;
  renderPolicyEditor();
  renderSalaryItemsTable();
}

/** 清除本机存档，恢复为官方默认数据（保留「自定义」城市） */
function pmResetToSeed() {
  if (!confirm('将清除本机浏览器中保存的政策数据，恢复为官方默认数据（新增城市与自定义政策会保留），确认？')) return;
  restoreOfficialAll();
  if (!CITY_POLICY_LIBRARY[salaryParams.cityId]) salaryParams.cityId = 'custom';
  window._pmCity = CITY_POLICY_LIBRARY[salaryParams.cityId] ? salaryParams.cityId : Object.keys(CITY_POLICY_LIBRARY)[0];
  onPmCityChange();
  syncCitySelects();
}

function pmExportJSON() {
  downloadFile(JSON.stringify(CITY_POLICY_LIBRARY, null, 2), '城市社保公积金政策库.json', 'application/json');
}


function applyImportedLibrary(lib, errors) {
  Object.keys(CITY_POLICY_LIBRARY).forEach(k => delete CITY_POLICY_LIBRARY[k]);
  Object.assign(CITY_POLICY_LIBRARY, lib);
  if (!CITY_POLICY_LIBRARY.custom) {
    CITY_POLICY_LIBRARY.custom = defaultCustomCity();
  }
  normalizePolicyLibrary(CITY_POLICY_LIBRARY);
  if (!CITY_POLICY_LIBRARY[salaryParams.cityId]) salaryParams.cityId = 'custom';
  window._pmCity = Object.keys(CITY_POLICY_LIBRARY)[0];
  _policyCache.clear();
  savePolicyLibrary();
  onPmCityChange();
  syncCitySelects();
  alert(`导入成功：${Object.keys(CITY_POLICY_LIBRARY).length} 个城市${errors && errors.length ? `（${errors.length} 条问题行已跳过，详见控制台）` : ''}`);
  if (errors && errors.length) console.warn('政策库导入问题行：', errors);
}

function pmExportExcel() {
  return ensureXLSX(() => {
    const rows = libraryToRows(CITY_POLICY_LIBRARY);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 11 }, { wch: 11 }, { wch: 30 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 22 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '政策库');
    return saveWorkbook(wb, '城市社保公积金政策库.xlsx');
  });
}

function pmImportExcel(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  ensureXLSX(() => {
    const reader = new FileReader();
    reader.onload = e => {
      let wb;
      try {
        wb = XLSX.read(e.target.result, { type: 'array' });
      } catch (err) {
        return alert('Excel 解析失败：' + err.message);
      }
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
      const { library, errors } = rowsToLibrary(rows);
      if (Object.keys(library).length === 0) return alert('导入失败：' + (errors[0] || '未解析到有效数据'));
      if (!confirm(`导入将覆盖当前政策库（解析到 ${Object.keys(library).length} 个城市${errors.length ? `，${errors.length} 条问题行已跳过` : ''}），确认继续？`)) return;
      applyImportedLibrary(library, errors);
    };
    reader.readAsArrayBuffer(file);
  });
}

function pmImportJSON(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      return alert('JSON 解析失败：' + err.message);
    }
    const valid = data && typeof data === 'object' && Object.values(data).every(city =>
      city && typeof city.name === 'string' && city.years && typeof city.years === 'object');
    if (!valid) return alert('格式不符：需要 { 城市key: { name, years: { 年度: { effective, items } } } } 结构');
    if (!confirm('导入将覆盖当前整个政策库，确认继续？')) return;
    applyImportedLibrary(data);
  };
  reader.readAsText(file, 'utf-8');
}


  window.PagePolicy = { applyImportedLibrary,closePolicyModal,onPmCheckedAtChange,onPmCityChange,onPmEffectiveChange,onPmFundRatesInput,onPmItemInput,onPmLabelChange,onPmNoteChange,onPmRestoreField,onPmSourceAdd,onPmSourceCoversToggle,onPmSourceDelete,onPmSourceFieldChange,onPmStatusChange,onPmYearChange,openPolicyModal,pmAddCity,pmAddYear,pmCityOptionsHTML,pmDeleteYear,pmExportExcel,pmExportJSON,pmImportExcel,pmImportJSON,pmResetToSeed,renderPolicyEditor,updatePmStorageStatus };
})();
