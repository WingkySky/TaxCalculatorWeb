/* ============================================================
 * page-share.js — PageShare 结果分享链接
 * 职责：把多月累计/年度汇算的计算参数编码进 URL hash（#/share?d=<base64url>），
 *       收件人打开后还原输入并用其本地政策数据自动重算；
 *       目标页顶部显示「来自分享的数据」横幅，可清除并回多月页。
 * 对外接口：window.PageShare.{encodeShare, decodeShare, shareMulti, shareAnnual, applyShare, clearShare}。
 * 依赖：TaxState/ParamsState 全局别名、PageMulti.calcMulti、PageAnnual.calc、PageParams。
 * ============================================================ */
(function () {
'use strict';

// ==================== 编解码（纯函数，Node 可测） ====================

const SHARE_VERSION = 1;
const EXTRA_KEYS = ['childEducation', 'infantCare', 'education', 'houseLoan', 'houseRent', 'support', 'medical'];

/** 对象 → base64url（Unicode 安全；短键由调用方保证） */
function encodeShare(payload) {
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → 对象；损坏/版本不符/类型未知返回 null（防呆，不抛错） */
function decodeShare(str) {
  try {
    let b64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const obj = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (!obj || obj.v !== SHARE_VERSION || (obj.t !== 'multi' && obj.t !== 'annual')) return null;
    if (obj.t === 'multi' && (!Array.isArray(obj.m) || obj.m.length !== 12)) return null;
    if (obj.t === 'annual' && (!Array.isArray(obj.sal) || obj.sal.length !== 12 || !Array.isArray(obj.lab) || obj.lab.length !== 12)) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

/** 当前页面 URL + 分享 hash */
function buildUrl(payload) {
  return location.origin + location.pathname + '#/share?d=' + encodeShare(payload);
}

/** 复制到剪贴板；clipboard 不可用时回退 prompt 手动复制 */
function copyUrl(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(url).then(() => true, () => fallbackCopy(url));
  }
  return Promise.resolve(fallbackCopy(url));
}

function fallbackCopy(url) {
  prompt('自动复制不可用，请手动复制以下链接：', url);
  return true;
}

// ==================== 生成（读页面状态） ====================

const MONTH_IDS = Array.from({ length: 12 }, (_, i) => i + 1);

/** 多月分享 payload：类型/年度/方向/断月/12 月金额/工资参数/年终奖 */
function buildMultiShare() {
  const amounts = MONTH_IDS.map(m => Math.max(0, Number((document.getElementById('m-amount-' + m) || {}).value) || 0));
  const p = {
    v: SHARE_VERSION, t: 'multi',
    it: incomeType, y: Number((document.getElementById('multi-year') || {}).value) || new Date().getFullYear(),
    dir: multiDirection, gap: document.getElementById('multi-gap-toggle') && document.getElementById('multi-gap-toggle').checked ? 1 : 0,
    m: amounts
  };
  if (incomeType === 'salary') {
    p.bp = { c: salaryParams.cityId, b: salaryParams.socialBase || 0, fb: salaryParams.fundBase || '',
      fr: salaryParams.fundRate, ed: salaryParams.extraDeduction || 0, xd: salaryParams.extraDetail || null };
    const bonusAmt = Math.max(0, Number((document.getElementById('multi-bonus-amount') || {}).value) || 0);
    if (bonusAmt > 0) p.bn = { a: bonusAmt, m: Number((document.getElementById('multi-bonus-month') || {}).value) || 12 };
  }
  return p;
}

/** 汇算分享 payload：年度/收入 12 月×2/稿酬/特许权/社保公积金年额/专项附加 7 项/预扣手填值 */
function buildAnnualShare() {
  const read = id => (document.getElementById(id) || {}).value;
  const amounts = prefix => MONTH_IDS.map((_, i) => Math.max(0, Number(read(`ann-${prefix}-${i}`)) || 0));
  const p = {
    v: SHARE_VERSION, t: 'annual',
    y: Number((document.getElementById('ann-year') || {}).value) || new Date().getFullYear(),
    sal: amounts('sal'), lab: amounts('lab'),
    au: Math.max(0, Number(read('ann-author')) || 0), ro: Math.max(0, Number(read('ann-royalty')) || 0),
    sia: Math.max(0, Number(read('ann-si-annual')) || 0),
    ex: EXTRA_KEYS.map(k => Math.max(0, Number(read('ann-ex-' + k)) || 0))
  };
  const w = {};
  ['salary', 'labor', 'author', 'royalty'].forEach(k => {
    const raw = String(read('ann-w-' + k)).trim();
    if (raw !== '') w[k] = Math.max(0, Number(raw) || 0);   // 只编码手填值；留空由收件端估算
  });
  if (Object.keys(w).length) p.w = w;
  return p;
}

function copyShare(payload, label) {
  const url = buildUrl(payload);
  copyUrl(url).then(() =>
    alert(`${label}分享链接已复制：\n${url.length > 80 ? url.slice(0, 80) + '…' : url}\n\n⚠ 链接包含收入数据，请仅发送给可信对象；收件人打开时将用其本地政策数据重算。`));
}

/** 生成多月分享链接（结果卡按钮入口） */
function shareMulti() {
  copyShare(buildMultiShare(), '多月累计');
}

/** 生成年份汇算分享链接（结果卡按钮入口） */
function shareAnnual() {
  copyShare(buildAnnualShare(), '年度汇算');
}

// ==================== 应用（打开分享链接） ====================

/** 目标页顶部横幅（info-box 风格）；清除按钮走 clearShare */
function showBanner(pageId, label) {
  const page = document.getElementById(pageId);
  if (!page || document.getElementById('share-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'share-banner';
  banner.className = 'info-box';
  banner.style.margin = '0 0 14px';
  banner.innerHTML = ` <strong>来自分享的数据</strong>——已按分享内容还原并计算（结果按收件人本地政策数据得出）。
    <button class="btn btn-secondary" style="padding:2px 10px;font-size:12px;margin-left:10px;" onclick="PageShare.clearShare()">清除并返回</button>`;
  page.insertBefore(banner, page.firstChild);
}

/** 清除：移除横幅、清空分享还原的输入、回多月页 */
function clearShare() {
  const banner = document.getElementById('share-banner');
  if (banner) banner.remove();
  MONTH_IDS.forEach(m => {
    const el = document.getElementById('m-amount-' + m);
    if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    const a = document.getElementById('ann-sal-' + (m - 1));
    if (a) a.value = '';
    const l = document.getElementById('ann-lab-' + (m - 1));
    if (l) l.value = '';
  });
  ['ann-author', 'ann-royalty', 'ann-w-salary', 'ann-w-labor', 'ann-w-author', 'ann-w-royalty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  App.navigate('multi');
}

/** 打开分享链接：解析 → 还原输入 → 自动计算 → 横幅 */
function applyShare() {
  const m = (location.hash || '').match(/[?&]d=([^&]+)/);
  const payload = m ? decodeShare(decodeURIComponent(m[1])) : null;
  if (!payload) {
    alert('分享链接无效或已损坏，无法还原数据。');
    App.navigate('multi');
    return;
  }
  if (payload.t === 'multi') {
    App.setIncomeType(payload.it === 'salary' ? 'salary' : 'labor');
    multiDirection = payload.dir === 'reverse' ? 'reverse' : 'forward';
    document.querySelectorAll('.direction-btn[data-target="multi"]').forEach(b => {
      b.classList.toggle('active', b.dataset.dir === multiDirection);
    });
    PageMulti.updateMultiInputHints();
    const yearEl = document.getElementById('multi-year');
    if (yearEl) yearEl.value = payload.y;
    MONTH_IDS.forEach(mo => {
      const el = document.getElementById('m-amount-' + mo);
      if (el) { el.value = payload.m[mo - 1] || ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    const gapEl = document.getElementById('multi-gap-toggle');
    if (gapEl) gapEl.checked = !!payload.gap;
    if (payload.it === 'salary' && payload.bp) {
      salaryParams.cityId = payload.bp.c || 'custom';
      salaryParams.socialBase = Number(payload.bp.b) || 0;
      salaryParams.fundBase = payload.bp.fb || '';
      salaryParams.fundRate = Number(payload.bp.fr) || 0.05;
      salaryParams.extraDeduction = Number(payload.bp.ed) || 0;
      if (payload.bp.xd && typeof payload.bp.xd === 'object') salaryParams.extraDetail = payload.bp.xd;
      const spCitySel = document.getElementById('sp-city');
      if (spCitySel) spCitySel.innerHTML = PageParams.buildCityOptions(salaryParams.cityId);
      PageParams.onCityParamChange();
    }
    if (payload.bn) {
      const amt = document.getElementById('multi-bonus-amount');
      const sel = document.getElementById('multi-bonus-month');
      if (amt) amt.value = payload.bn.a;
      if (sel) sel.value = payload.bn.m;
    }
    App.navigate('multi');
    showBanner('page-multi', '多月累计');
    PageMulti.calcMulti();
  } else {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('ann-year', payload.y);
    payload.sal.forEach((v, i) => set('ann-sal-' + i, v || ''));
    payload.lab.forEach((v, i) => set('ann-lab-' + i, v || ''));
    set('ann-author', payload.au || '');
    set('ann-royalty', payload.ro || '');
    set('ann-si-annual', payload.sia || 0);
    (payload.ex || []).forEach((v, i) => set('ann-ex-' + EXTRA_KEYS[i], v || ''));
    ['salary', 'labor', 'author', 'royalty'].forEach(k => set('ann-w-' + k, payload.w && payload.w[k] != null ? payload.w[k] : ''));
    App.navigate('annual');
    showBanner('page-annual', '年度汇算');
    PageAnnual.calc();
  }
}

  window.PageShare = { applyShare, buildAnnualShare, buildMultiShare, clearShare, decodeShare, encodeShare,
    shareAnnual, shareMulti };
})();
