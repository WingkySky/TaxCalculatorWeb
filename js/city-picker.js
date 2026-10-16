/* ============================================================
 * city-picker.js — CityPicker 城市选择器（搜索+省市筛选一体，可复用模块）
 * 职责：337 城规模下的城市选择交互——触发框 + 面板（搜索框 / 省份 chips / 结果列表），
 *       城市项带数据可信度状态点；替代散落三处（工资参数卡/批量整批/政策库页）的
 *       337 项原生下拉。规格：docs/superpowers/specs/2026-10-16-city-picker-design.md
 * 对外接口：window.CityPicker.{mount,buildIndex,matchCity,filterCities,
 *           renderTriggerHTML,renderChipsHTML,renderListHTML}
 * 依赖：PolicyLib（CITY_POLICY_LIBRARY / statusLabel）。
 * 实现约定：渲染为模板字符串纯函数（Node 回归门直测）；实例事件用 addEventListener
 *   闭包绑定（有状态组件不适合 inline handler，此为对仓库惯例的有意偏离）；
 *   拼音检索只支持「城市键子串」级别（键即拼音缩写），不做全拼映射——不引拼音库、不造数据。
 * ============================================================ */
(function () {
'use strict';
  const { CITY_POLICY_LIBRARY, statusLabel } = PolicyLib;

/* ==================== 纯函数（Node 回归门直测） ==================== */

function escHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 城市索引：{list:[{key,name,region,status}], regions:[按首次出现序]}
 *  status 取该城 effective 末值最大的年度记录（不依赖 resolvePolicy——它耦合 salaryParams） */
function buildIndex() {
  const list = [];
  const regions = [];
  Object.entries(CITY_POLICY_LIBRARY).forEach(([key, city]) => {
    let status = 'unverified';
    let bestEnd = '';
    Object.entries(city.years || {}).forEach(([, rec]) => {
      const end = (rec && rec.effective && rec.effective[1]) || '';
      if (String(end) >= bestEnd) { bestEnd = String(end); status = (rec && rec.status) || 'unverified'; }
    });
    list.push({ key: key, name: city.name, region: city.region || '', status: status });
    if (city.region && regions.indexOf(city.region) < 0) regions.push(city.region);
  });
  return { list: list, regions: regions };
}

/** 命中规则：省份圈定（AND）+ 关键词（城市名或键含 q；q 空 = 全量） */
function matchCity(item, q, region) {
  if (region && item.region !== region) return false;
  if (!q) return true;
  return item.name.indexOf(q) >= 0 || item.key.indexOf(q) >= 0;
}

function filterCities(index, q, region) {
  return index.list.filter(it => matchCity(it, String(q || '').trim(), region || ''));
}

function dotClass(status) { return 'cp-dot cp-dot-' + (status || 'unverified'); }

function optDomId(iid, key) { return iid + '-opt-' + (String(key).replace(/[^a-z0-9]/gi, '') || 'blank'); }

/** 触发框：状态点 + 城市名；blank（batch 空值）显示灰字 emptyLabel */
function renderTriggerHTML(item, opts) {
  const o = opts || {};
  if (o.blank) {
    return '<button type="button" class="cp-trigger is-blank" aria-haspopup="listbox" aria-expanded="false">' +
      '<span class="cp-trigger-text">' + escHtml(o.emptyLabel || '未选择') + '</span><span class="cp-arrow">▾</span></button>';
  }
  return '<button type="button" class="cp-trigger" aria-haspopup="listbox" aria-expanded="false">' +
    '<span class="' + dotClass(item && item.status) + '" title="数据核查状态：' + escHtml(statusLabel(item && item.status)) + '"></span>' +
    '<span class="cp-trigger-text">' + escHtml(item ? item.name : (o.value || '')) + '</span><span class="cp-arrow">▾</span></button>';
}

/** 省份 chips：全部 + regions（首次出现序）；activeRegion='' 表示全部 */
function renderChipsHTML(regions, activeRegion) {
  const chip = (val, label) => '<button type="button" class="cp-chip' + (String(activeRegion || '') === String(val) ? ' is-on' : '') +
    '" data-region="' + escHtml(val) + '">' + escHtml(label) + '</button>';
  return chip('', '全部') + (regions || []).map(r => chip(r, r)).join('');
}

/** 结果列表：items 为过滤后的城市（或含 {key:'',blank:true} 空值项置顶）；activeKey 高亮项 */
function renderListHTML(items, opts) {
  const o = opts || {};
  const lis = (items || []).map(it => {
    if (it.blank) {
      return '<li role="option" class="cp-item is-blank' + (o.activeKey === it.key ? ' is-active' : '') +
        '" data-key="" id="' + optDomId(o.id, '') + '" aria-selected="' + (o.value === '' ? 'true' : 'false') + '">' +
        escHtml(o.emptyLabel || '') + '</li>';
    }
    return '<li role="option" class="cp-item' + (o.value === it.key ? ' is-selected' : '') + (o.activeKey === it.key ? ' is-active' : '') +
      '" data-key="' + escHtml(it.key) + '" id="' + optDomId(o.id, it.key) + '" aria-selected="' + (o.value === it.key ? 'true' : 'false') + '">' +
      '<span class="' + dotClass(it.status) + '" title="数据核查状态：' + escHtml(statusLabel(it.status)) + '"></span>' +
      '<span class="cp-item-name">' + escHtml(it.name) + '</span>' +
      (it.region ? '<span class="cp-item-region">' + escHtml(it.region) + '</span>' : '') +
      '</li>';
  });
  return '<ul class="cp-list" role="listbox" id="' + o.id + '-list">' + lis.join('') + '</ul>';
}

/* ==================== 实例 ==================== */

const _seq = [0];
const _instances = {}; // id → api（调试/测试可用）

function mount(container, opts) {
  if (!container) throw new Error('CityPicker.mount: container 缺失');
  opts = opts || {};
  const id = 'cp' + (++_seq[0]);
  const st = {
    id: id, container: container,
    value: opts.value != null ? String(opts.value) : '',
    q: '', region: '', open: false, activeKey: null,
    index: buildIndex(),
    onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
    allowEmpty: !!opts.allowEmpty,
    emptyLabel: opts.emptyLabel || '',
    placeholder: opts.placeholder || '输入城市名，如 郑州',
  };

  /* 骨架：触发框 + 面板（搜索框/chips/list/empty 容器），内容部分随交互重渲染 */
  container.classList.add('city-picker');
  container.innerHTML =
    renderTriggerHTML(findItem(st, st.value), { value: st.value, blank: isBlankValue(st), emptyLabel: st.emptyLabel }) +
    '<div class="cp-panel" hidden>' +
    '<div class="cp-search-wrap">' +
    '<input class="cp-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false"' +
    ' aria-controls="' + id + '-list" placeholder="' + escHtml(st.placeholder) + '">' +
    '</div>' +
    '<div class="cp-chips" role="group" aria-label="按省份筛选"></div>' +
    '<div class="cp-list-wrap"></div>' +
    '<div class="cp-empty" hidden>无匹配城市，可换个关键词或清空省份筛选 ' +
    '<button type="button" class="cp-clear">清空筛选</button></div>' +
    '</div>';

  const el = {
    trigger: container.querySelector('.cp-trigger'),
    panel: container.querySelector('.cp-panel'),
    search: container.querySelector('.cp-search'),
    chips: container.querySelector('.cp-chips'),
    listWrap: container.querySelector('.cp-list-wrap'),
    empty: container.querySelector('.cp-empty'),
  };

  function findItem(s, key) {
    for (const it of s.index.list) { if (it.key === key) return it; }
    return null;
  }
  function isBlankValue(s) { return s.allowEmpty && s.value === ''; }
  function currentItems() {
    const items = filterCities(st.index, st.q, st.region);
    if (st.allowEmpty && !st.q && !st.region) {
      items.unshift({ key: '', name: st.emptyLabel, region: '', status: null, blank: true });
    }
    return items;
  }
  function renderTrigger() {
    const item = findItem(st, st.value);
    el.trigger.outerHTML = renderTriggerHTML(item, { value: st.value, blank: isBlankValue(st), emptyLabel: st.emptyLabel })
      .replace('aria-expanded="false"', 'aria-expanded="' + (st.open ? 'true' : 'false') + '"');
    // outerHTML 替换后按钮节点失效，重新抓取并重绑 toggle
    const newTrigger = container.querySelector('.cp-trigger');
    newTrigger.addEventListener('click', onTriggerClick);
    el.trigger = newTrigger;
  }
  function renderBody() {
    el.chips.innerHTML = renderChipsHTML(st.index.regions, st.region);
    const items = currentItems();
    if (st.activeKey == null && items.length) st.activeKey = items[0].key;
    el.listWrap.innerHTML = renderListHTML(items, { id: id, value: st.value, activeKey: st.activeKey, emptyLabel: st.emptyLabel });
    el.empty.hidden = items.length > 0;
    if (st.activeKey != null) {
      const active = el.listWrap.querySelector('.is-active');
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }
  }
  function onTriggerClick() { st.open ? close() : open(); }
  function open() {
    st.open = true;
    st.q = '';
    st.region = '';
    st.activeKey = null;
    el.search.value = '';
    el.panel.hidden = false;
    el.trigger.setAttribute('aria-expanded', 'true');
    el.search.setAttribute('aria-expanded', 'true');
    renderBody();
    el.search.focus();
  }
  function close(refocus) {
    st.open = false;
    el.panel.hidden = true;
    el.trigger.setAttribute('aria-expanded', 'false');
    el.search.setAttribute('aria-expanded', 'false');
    if (refocus) el.trigger.focus();
  }
  function select(key) {
    st.value = String(key == null ? '' : key);
    st.open = false;
    el.panel.hidden = true;
    el.trigger.setAttribute('aria-expanded', 'false');
    el.search.setAttribute('aria-expanded', 'false');
    renderTrigger();
    if (st.onChange) st.onChange(st.value);
  }

  /* ---- 事件（闭包绑定；组件有每实例状态，不适合 inline handler） ---- */
  el.trigger.addEventListener('click', onTriggerClick);
  el.search.addEventListener('input', () => {
    st.q = el.search.value.trim();
    st.activeKey = null;
    renderBody();
  });
  el.search.addEventListener('keydown', (e) => {
    const items = currentItems();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      if (st.activeKey == null) { st.activeKey = items[0].key; }
      else {
        let i = items.findIndex(it => it.key === st.activeKey);
        i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
        st.activeKey = items[i < 0 ? 0 : i].key;
      }
      renderBody();
      el.search.setAttribute('aria-activedescendant', optDomId(id, st.activeKey));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const key = st.activeKey != null && items.some(it => it.key === st.activeKey) ? st.activeKey : (items[0] && items[0].key);
      if (key != null) select(key);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  });
  el.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.cp-chip');
    if (!chip) return;
    st.region = chip.getAttribute('data-region') || '';
    st.activeKey = null;
    renderBody();
  });
  el.listWrap.addEventListener('click', (e) => {
    const li = e.target.closest('.cp-item');
    if (!li) return;
    select(li.getAttribute('data-key'));
  });
  el.empty.querySelector('.cp-clear').addEventListener('click', () => {
    st.q = ''; st.region = '';
    el.search.value = '';
    st.activeKey = null;
    renderBody();
    el.search.focus();
  });
  const onDocClick = (e) => {
    // 守卫：chip/列表点击会同步 innerHTML 重建，原 target 冒泡到 document 时已脱离 DOM——
    // contains(脱离节点)=false 会被误判为「点到面板外」而关面板（实测缺陷），脱离节点一律忽略
    if (!e.target || !e.target.isConnected) return;
    if (st.open && !container.contains(e.target)) close(false);
  };
  document.addEventListener('click', onDocClick);

  const api = {
    id: id,
    getValue: () => st.value,
    setValue(v) {
      st.value = String(v == null ? '' : v);
      renderTrigger();
      if (st.open) renderBody();
    },
    refresh() {
      st.index = buildIndex();
      renderTrigger();
      if (st.open) renderBody();
    },
    destroy() {
      document.removeEventListener('click', onDocClick);
      container.innerHTML = '';
      delete _instances[id];
    },
    _st: st,
  };
  _instances[id] = api;
  return api;
}

  window.CityPicker = { mount, buildIndex, matchCity, filterCities, renderTriggerHTML, renderChipsHTML, renderListHTML, _instances };
})();
