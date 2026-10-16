/* ============================================================
 * policy-library.js — PolicyLib 城市社保公积金政策库
 * 职责：政策库结构定义、持久化（官方层 + 本机存档两层）、三方合并、
 *       远端数据通道（fetch tax-policy-data.json）、normalize 规范化（含溯源
 *       字段 status/checkedAt/note/sources）、按城市+月份解析政策（resolvePolicy）、
 *       基数 clamp、Excel 行转换。
 * 对外接口：window.PolicyLib。依赖：TaxUtils、tax-policy-data.js 兜底种子。
 * ============================================================ */
(function () {
'use strict';
  const { round2 } = TaxUtils;

/* ==================== 城市社保公积金政策库 ====================
 * 三层结构：城市 → 年度（含生效月区间）→ 险种（养老/医疗(含生育)/失业/工伤/公积金）
 * 每个险种：personal 个人比例(小数)、employer 单位比例(小数)、lower/upper 基数上下限（null = 不限）
 * 公积金额外：rates 可选比例数组（公司择档 5%~12%）；fund.employer 缺省表示单位与个人同档
 * 年度记录溯源字段（均可选）：status 核查状态（confirmed/partial/unverified，缺省 unverified）、
 *   checkedAt 最近人工核查年月（YYYY-MM）、note 口径备注、sources[] 来源（title 必填，
 *   ref/url/publisher/date/confirms 可选，covers 声明证实哪些险种、缺省全项）。
 *   旧字段 pending 读取时一次性映射（true→unverified、false→partial），不再写出。
 * 内置数值为参考值，请以当地社保部门公布为准，可在政策库页修改/导入。
 */
function siItem(personal, lower, upper, employer) { return { personal: personal, lower: lower, upper: upper, employer: employer || 0 }; }
function fundItem(rates, personal, lower, upper, employer) {
  const it = { personal: personal, rates: rates, lower: lower, upper: upper };
  if (employer != null) it.employer = employer;
  return it;
}

const SI_ITEMS = [
  { key: 'pension', label: '养老' },
  { key: 'medical', label: '医疗(含生育)' },
  { key: 'unemployment', label: '失业' },
  { key: 'injury', label: '工伤' },
  { key: 'fund', label: '公积金' },
];
const SI_ITEM_LABELS = { pension: '养老', medical: '医疗(含生育)', unemployment: '失业', injury: '工伤', fund: '公积金' };

const FUND_RATES_STD = [0.05, 0.06, 0.08, 0.10, 0.12];

/* ==================== 溯源与核查状态（status/checkedAt/note/sources） ====================
 * 状态词汇表与加载宽容校验：坏数据降级显示，绝不崩计算。
 * 险种级「有据」由 sources[].covers 派生，但不覆盖人工声明的 status（贴链接≠已核实）。 */
const POLICY_STATUS = { confirmed: '已核实', partial: '部分核实', unverified: '待核实' };

function statusLabel(status) { return POLICY_STATUS[status] || POLICY_STATUS.unverified; }

/** 状态规范化：合法值原样；旧 pending 映射（false→partial、true→unverified）；其余缺省 unverified */
function normalizeStatus(status, legacyPending) {
  if (status === 'confirmed' || status === 'partial' || status === 'unverified') return status;
  if (status == null && legacyPending === false) return 'partial';
  return 'unverified';
}

/** 来源条目规范化：title 必填（缺失整条丢弃）、其余字段 trim 后非空才保留；
 *  covers 过滤为合法险种键，空/缺失视为全项（不落盘，派生时展开） */
function normalizeSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach(s => {
    if (!s || typeof s !== 'object') return;
    const title = String(s.title == null ? '' : s.title).trim();
    if (!title) return;
    const n = { title: title };
    ['ref', 'url', 'publisher', 'date', 'confirms'].forEach(f => {
      const v = String(s[f] == null ? '' : s[f]).trim();
      if (v) n[f] = v;
    });
    if (Array.isArray(s.covers)) {
      const covers = s.covers.map(k => String(k == null ? '' : k).trim()).filter(k => SI_ITEM_LABELS[k]);
      n.covers = covers; // 可为空数组：明确表示不证实任何险种；缺省（无 covers 字段）= 全项
    }
    out.push(n);
  });
  return out;
}

/** 险种是否有来源支撑：covers 缺省=全项、空数组=无；空标题条目（编辑中的半成品）不算 */
function itemCoveredBySources(itemKey, sources) {
  return (Array.isArray(sources) ? sources : []).some(s =>
    s && String(s.title == null ? '' : s.title).trim() !== '' &&
    (!Array.isArray(s.covers) || s.covers.indexOf(itemKey) >= 0));
}

/** 来源条目身份键：ref → url → title（trim 归一化） */
function sourceKey(s) {
  const ref = String((s && s.ref) || '').trim();
  if (ref) return 'ref:' + ref;
  const url = String((s && s.url) || '').trim();
  if (url) return 'url:' + url;
  return 'title:' + String((s && s.title) || '').trim();
}

/** sources 三方合并：远端新增收、本地新增留、同键官方改动优先（与数值字段防回退原则一致） */
function mergeSources(sb, su, sr) {
  const arr = v => (Array.isArray(v) ? v : []);
  const uMap = {}, bMap = {};
  arr(su).forEach(s => { const k = sourceKey(s); if (!(k in uMap)) uMap[k] = s; });
  arr(sb).forEach(s => { const k = sourceKey(s); if (!(k in bMap)) bMap[k] = s; });
  const out = [];
  const seen = {};
  arr(sr).forEach(s => {
    const k = sourceKey(s);
    if (seen[k]) return;
    seen[k] = 1;
    const u = uMap[k];
    // 本地没有该条 → 收官方；官方没动 → 保留本地版本（未改则同值）；官方动了 → 官方赢
    out.push(deepClone(u == null || !valueEqual(s, bMap[k]) ? s : u));
  });
  arr(su).forEach(s => {
    const k = sourceKey(s);
    if (seen[k]) return;
    seen[k] = 1;
    out.push(deepClone(s)); // 本地新增（或官方已删但本地改过）→ 保留
  });
  return out;
}

/* ==================== 官方层 + 本机存档（两层持久化） ====================
 * 数据分两层，所有权分离：
 *   官方层（远端/种子负责，随版本推送）：tax-policy-data.json（线上唯一数据源，
 *     版本号 YYYY.MM）→ file:// 兜底由同目录 tax-policy-data.js 提供。
 *   本机存档（localStorage，用户负责）：弹层编辑/导入后自动写入，含
 *     __baseData（保存时的官方层快照）用于三方合并。
 * 远端更新到达时按字段三方合并：用户未改的字段自动更新到官方新值；
 * 用户改过的字段保留用户值并在政策库页标注（可一键恢复官方值）；
 * 「自定义」城市及用户新增的城市/年度永远不被触碰。
 * 版本低于官方层已知版本时合并自动跳过（不会回退）。
 */
const POLICY_LIB_STORAGE_KEY = 'taxPolicyLibrary_v1';

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

function policyStorageAvailable() {
  try {
    const k = POLICY_LIB_STORAGE_KEY + '__probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
}

function nowStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 从 localStorage 读取本机存档；无数据或不可用时返回 null。
 *  兼容 v1 旧存档（整库快照）与 v2（data + __baseData 官方基线）。 */
function loadPolicyLibrary() {
  try {
    const raw = localStorage.getItem(POLICY_LIB_STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.__v === 2 && payload.data && typeof payload.data === 'object' && Object.keys(payload.data).length) {
      return {
        data: payload.data,
        savedAt: payload.__savedAt || '',
        baseVersion: payload.__baseVersion || null,
        baseData: (payload.__baseData && typeof payload.__baseData === 'object') ? payload.__baseData : null
      };
    }
    // v1 旧存档：除 __savedAt 外都是城市表
    const data = JSON.parse(JSON.stringify(payload));
    delete data.__savedAt;
    if (!Object.keys(data).length) return null;
    return { data: data, savedAt: payload.__savedAt || '', baseVersion: null, baseData: null };
  } catch (e) {
    return null;
  }
}

/** 政策库变更后写本机存档（含官方基线快照）；不可用时静默降级（政策库页会提示仅本次会话有效） */
function savePolicyLibrary() {
  try {
    const payload = {
      __v: 2,
      __savedAt: nowStamp(),
      __baseVersion: OFFICIAL_VERSION,
      __baseData: deepClone(OFFICIAL_CITIES),
      data: deepClone(CITY_POLICY_LIBRARY)
    };
    localStorage.setItem(POLICY_LIB_STORAGE_KEY, JSON.stringify(payload));
    window._policySavedAt = payload.__savedAt;
    window._policyFromStorage = true;
    window._policyStorageAvailable = true;
    return true;
  } catch (e) {
    window._policyStorageAvailable = false;
    console.warn('政策库本地存档失败（当前环境可能禁用了 localStorage）：', e.message);
    return false;
  }
}

function clearPolicyLibraryStorage() {
  try { localStorage.removeItem(POLICY_LIB_STORAGE_KEY); } catch (e) { /* 忽略 */ }
}

/* 兜底「自定义」城市（tax-policy-data.js 缺失时仅剩它） */
function defaultCustomCity() {
  return {
    custom: {
      name: '自定义',
      years: {
        custom: {
          label: '自定义政策',
          effective: ['2000-01', '2999-12'],
          status: 'unverified',
          items: {
            pension:      siItem(0.08, null, null, 0.16),
            medical:      siItem(0.02, null, null, 0.08),
            unemployment: siItem(0.005, null, null, 0.005),
            injury:       siItem(0, null, null, 0.002),
            fund:         fundItem(FUND_RATES_STD.slice(), 0.05, null, null)
          }
        }
      }
    }
  };
}

/* ---- 官方层初始化：本机存档基线 > 兜底种子 ---- */
const scriptSeed = (window.CITY_POLICY_LIBRARY_DATA && typeof window.CITY_POLICY_LIBRARY_DATA === 'object')
  ? window.CITY_POLICY_LIBRARY_DATA : null;
const _archive = loadPolicyLibrary();

let OFFICIAL_VERSION = (_archive && _archive.baseVersion) || window.CITY_POLICY_LIBRARY_VERSION || null;
let OFFICIAL_CITIES = (_archive && _archive.baseData) ||
  (scriptSeed ? deepClone(scriptSeed) : null) ||
  deepClone(defaultCustomCity());
if (!OFFICIAL_VERSION) OFFICIAL_VERSION = '0.0';
/* 官方层同样规范化（含溯源字段/旧 pending 映射），保证 officialDiffFor 对比两侧同构 */
normalizePolicyLibrary(OFFICIAL_CITIES);

/* 工作库：存档数据（尚未与官方层合并时保持原样，远端通道/启动种子更新时再合并）
 * 或官方层副本。custom 城市在任何官方数据缺失时兜底补入。 */
const CITY_POLICY_LIBRARY = _archive
  ? _archive.data
  : (scriptSeed ? deepClone(scriptSeed) : deepClone(defaultCustomCity()));
if (!CITY_POLICY_LIBRARY.custom) {
  const dc = defaultCustomCity().custom;
  // 追加到末尾，保持「自定义」永远排在城市表最后
  CITY_POLICY_LIBRARY.custom = dc;
}
window._policySavedAt = (_archive && _archive.savedAt) || '';
window._policyFromStorage = !!_archive;
window._policyStorageAvailable = policyStorageAvailable();

/**
 * 政策库规范化：险种按 SI_ITEMS 顺序重排、字段按规范顺序重建；
 * 旧版本存档（无单位比例 employer / 无工伤 injury）从兜底种子按字段级回退补齐，
 * 只补缺失字段，不覆盖用户已改过的任何数值。
 * 溯源字段：status 缺省/非法回落 unverified、旧 pending 一次性映射、
 * checkedAt/note/sources 宽容校验（坏条目丢弃不报错）。
 */
function normalizePolicyLibrary(lib) {
  const seed = (window.CITY_POLICY_LIBRARY_DATA && typeof window.CITY_POLICY_LIBRARY_DATA === 'object')
    ? window.CITY_POLICY_LIBRARY_DATA : null;
  Object.keys(lib).forEach(ck => {
    const city = lib[ck];
    if (!city || typeof city !== 'object' || !city.years || typeof city.years !== 'object') return;
    const years = {};
    Object.keys(city.years).forEach(yk => {
      const rec = city.years[yk];
      if (!rec || typeof rec !== 'object' || !rec.items || typeof rec.items !== 'object') { years[yk] = rec; return; }
      const seedRec = seed && seed[ck] && seed[ck].years && seed[ck].years[yk];
      const items = {};
      SI_ITEMS.forEach(it => {
        let item = rec.items[it.key];
        const seedItem = seedRec && seedRec.items ? seedRec.items[it.key] : null;
        // 旧存档缺整个险种（如工伤）：从种子整项补入
        if (!item && seedItem) item = JSON.parse(JSON.stringify(seedItem));
        if (!item) return;
        // 旧存档缺单位比例字段：从种子按字段回退
        if (item.employer == null && seedItem && seedItem.employer != null) item.employer = seedItem.employer;
        // 按规范字段顺序重建（保证 JSON roundtrip / 导出导入的键序一致）
        const n = (it.key === 'fund')
          ? { personal: item.personal, rates: item.rates, lower: item.lower, upper: item.upper }
          : { personal: item.personal, lower: item.lower, upper: item.upper };
        if (item.employer != null) n.employer = item.employer;
        Object.keys(item).forEach(k => { if (!(k in n)) n[k] = item[k]; });
        items[it.key] = n;
      });
      // 溯源字段规范化：status/checkedAt/note/sources 宽容校验后按规范键序重建；
      // 旧 pending 映射为 status 后不再写出；年度级未知字段透传（向前兼容）
      const n = {
        label: rec.label,
        effective: rec.effective,
        status: normalizeStatus(rec.status, rec.pending),
        items: items
      };
      const checkedAt = String(rec.checkedAt == null ? '' : rec.checkedAt).trim();
      if (/^\d{4}-\d{2}$/.test(checkedAt)) n.checkedAt = checkedAt;
      const note = String(rec.note == null ? '' : rec.note).trim();
      if (note) n.note = note;
      const sources = normalizeSources(rec.sources);
      if (sources.length) n.sources = sources;
      // 年度级未知字段透传（向前兼容）；已知字段一律以上面校验后的为准，防非法值借透传复活
      const KNOWN_YEAR_FIELDS = { label: 1, effective: 1, status: 1, checkedAt: 1, note: 1, sources: 1, items: 1, pending: 1 };
      Object.keys(rec).forEach(k => { if (!KNOWN_YEAR_FIELDS[k]) n[k] = rec[k]; });
      years[yk] = n;
    });
    /* 城市级元数据 region（省份分组）/rent（住房租金档）随规范化保留 */
    const nc = { name: city.name, years: years };
    if (city.region != null) nc.region = city.region;
    if (city.rent != null) nc.rent = city.rent;
    lib[ck] = nc;
  });
}
normalizePolicyLibrary(CITY_POLICY_LIBRARY);

/* ==================== 版本比较与三方合并 ==================== */

/** 版本号比较（"YYYY.MM"）：返回 -1 / 0 / 1；非法段按 0 处理 */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/* 顺序无关的值相等（对象键序不敏感；数组序敏感） */
function valueEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => valueEqual(v, b[i]));
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  return ka.length === kb.length && ka.every(k => k in b && valueEqual(a[k], b[k]));
}

/** 键集合并：先远端后本地（官方排序优先，本地独有键追加在后） */
function unionKeys(remoteKeys, userKeys) {
  const seen = {};
  const out = [];
  remoteKeys.concat(userKeys).forEach(k => { if (!seen[k]) { seen[k] = 1; out.push(k); } });
  return out;
}

/**
 * 三方合并：base=用户数据当时的官方层，user=用户工作库，remote=官方新层。
 * 规则（自顶向下逐级套用）：
 *   · 仅远端有 → 采纳官方（新增城市/年度/险种）；
 *   · 仅本地有 → 保留本地（自定义城市、用户新增城市/年度/险种，官方删改不波及）；
 *   · 两边都有 → 逐字段三方判定：用户值 == 基线值（未改过）→ 采纳远端新值；
 *     用户值 != 基线值（改过）→ 保留用户值。base 缺失时保守保留本地。
 */
function mergeLibrary(base, user, remote) {
  function mergeYearRec(yb, yu, yr) {
    const rec = {};
    rec.label = valueEqual(yu.label, yb.label) ? yr.label : yu.label;
    rec.effective = valueEqual(yu.effective, yb.effective) ? yr.effective : yu.effective;
    rec.status = valueEqual(yu.status, yb.status) ? yr.status : yu.status;
    rec.checkedAt = valueEqual(yu.checkedAt, yb.checkedAt) ? yr.checkedAt : yu.checkedAt;
    rec.note = valueEqual(yu.note, yb.note) ? yr.note : yu.note;
    rec.sources = mergeSources(yb && yb.sources, yu.sources, yr.sources);
    const items = {};
    const iks = unionKeys(Object.keys(yr.items || {}), Object.keys(yu.items || {}));
    iks.forEach(ik => {
      const iu = yu.items && yu.items[ik], ir = yr.items && yr.items[ik], ib = yb.items && yb.items[ik];
      if (iu == null && ir != null) { items[ik] = deepClone(ir); return; }
      if (iu != null && ir == null) { items[ik] = deepClone(iu); return; }
      if (iu != null && ir != null && ib == null) { items[ik] = deepClone(iu); return; }
      const item = {};
      Object.keys(ir).forEach(f => { item[f] = valueEqual(iu[f], ib[f]) ? ir[f] : iu[f]; });
      Object.keys(iu).forEach(f => { if (!(f in item)) item[f] = iu[f]; }); // 用户扩展字段保留
      items[ik] = item;
    });
    rec.items = items;
    // 用户年度级扩展字段保留（normalize 会再做溯源字段校验）
    Object.keys(yu).forEach(k => { if (!(k in rec)) rec[k] = yu[k]; });
    return rec;
  }
  function mergeCity(cb, cu, cr) {
    const city = { name: valueEqual(cu.name, cb.name) ? cr.name : cu.name, years: {} };
    /* 省份分组/租金档三方合并（标量，同 name 规则） */
    ['region', 'rent'].forEach(f => { city[f] = valueEqual(cu[f], cb[f]) ? cr[f] : cu[f]; });
    unionKeys(Object.keys(cr.years), Object.keys(cu.years)).forEach(yk => {
      const yu = cu.years[yk], yr = cr.years[yk], yb = cb.years && cb.years[yk];
      if (yu == null && yr != null) { city.years[yk] = deepClone(yr); return; }
      if (yu != null && yr == null) { city.years[yk] = deepClone(yu); return; }
      if (yu != null && yr != null && yb == null) { city.years[yk] = deepClone(yu); return; }
      city.years[yk] = mergeYearRec(yb, yu, yr);
    });
    return city;
  }
  const merged = {};
  unionKeys(Object.keys(remote), Object.keys(user)).forEach(ck => {
    const cu = user[ck], cr = remote[ck], cb = base && base[ck];
    if (cu == null && cr != null) { merged[ck] = deepClone(cr); return; }
    if (cu != null && cr == null) { merged[ck] = deepClone(cu); return; }
    if (cu != null && cr != null && (ck === 'custom' || cb == null)) { merged[ck] = deepClone(cu); return; }
    merged[ck] = mergeCity(cb, cu, cr);
  });
  return merged;
}

/** 应用远端官方数据（{version, cities}）。版本不高于已知官方层时跳过；
 *  返回 { from, to } 或 null。合并后自动写本机存档并派发 policy:remote-applied 事件。 */
function applyRemoteOfficial(json) {
  if (!json || typeof json !== 'object') return null;
  const cities = json.cities;
  if (!cities || typeof cities !== 'object' || !Object.keys(cities).length) return null;
  if (typeof json.version !== 'string' || !json.version) return null;
  if (compareVersions(json.version, OFFICIAL_VERSION) <= 0) return null;
  const from = OFFICIAL_VERSION;
  // 远端先规范化（溯源字段校验/旧 pending 映射）再参与合并，保证三方同构
  const remoteNorm = deepClone(cities);
  normalizePolicyLibrary(remoteNorm);
  const merged = mergeLibrary(OFFICIAL_CITIES, CITY_POLICY_LIBRARY, remoteNorm);
  Object.keys(CITY_POLICY_LIBRARY).forEach(k => delete CITY_POLICY_LIBRARY[k]);
  Object.assign(CITY_POLICY_LIBRARY, merged);
  if (!CITY_POLICY_LIBRARY.custom) CITY_POLICY_LIBRARY.custom = defaultCustomCity().custom;
  normalizePolicyLibrary(CITY_POLICY_LIBRARY);
  OFFICIAL_CITIES = remoteNorm;
  OFFICIAL_VERSION = json.version;
  _policyCache.clear();
  savePolicyLibrary();
  const info = { from: from, to: json.version, modified: modifiedFieldCount() };
  try { window.dispatchEvent(new CustomEvent('policy:remote-applied', { detail: info })); } catch (e) { /* 环境不支持事件则忽略 */ }
  return info;
}

/** 远端数据通道：http(s) 环境拉取同目录 tax-policy-data.json（no-cache 保证及时性）；
 *  file:// 双击场景静默跳过（由 tax-policy-data.js 兜底种子承担官方层）。 */
function initRemotePolicy() {
  if ((location.protocol || '') === 'file:') return Promise.resolve(null);
  if (typeof fetch !== 'function') return Promise.resolve(null);
  return fetch('tax-policy-data.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(json => applyRemoteOfficial(json))
    .catch(err => {
      console.info('政策库远端更新检查未执行：' + (err && err.message ? err.message : err));
      return null;
    });
}

/** 启动期官方层更新检查（file:// 换新种子文件 / 存档基线落后于兜底种子时） */
function applySeedUpdateIfNewer() {
  if (!scriptSeed || !window.CITY_POLICY_LIBRARY_VERSION) return null;
  if (compareVersions(window.CITY_POLICY_LIBRARY_VERSION, OFFICIAL_VERSION) <= 0) return null;
  return applyRemoteOfficial({ version: window.CITY_POLICY_LIBRARY_VERSION, cities: scriptSeed });
}

/* ==================== 本地改动标记 ==================== */

/** 指定（城市, 年度）相对官方层的本地改动：
 *  { __rec: { label/effective/status/checkedAt/note/sources: 官方值 }, [险种key]: { 字段: 官方值 } }；无改动返回 null */
function officialDiffFor(cityKey, yearKey) {
  const rec = CITY_POLICY_LIBRARY[cityKey] && CITY_POLICY_LIBRARY[cityKey].years[yearKey];
  const off = OFFICIAL_CITIES && OFFICIAL_CITIES[cityKey] && OFFICIAL_CITIES[cityKey].years[yearKey];
  if (!rec || !off) return null;
  const diff = {};
  const recDiff = {};
  ['label', 'effective', 'status', 'checkedAt', 'note', 'sources'].forEach(f => { if (!valueEqual(rec[f], off[f])) recDiff[f] = off[f]; });
  if (Object.keys(recDiff).length) diff.__rec = recDiff;
  Object.keys(rec.items || {}).forEach(ik => {
    const iu = rec.items[ik], io = off.items && off.items[ik];
    if (!io) { diff[ik] = { __localOnly: true }; return; }
    const fd = {};
    Object.keys(iu).forEach(f => { if (!valueEqual(iu[f], io[f])) fd[f] = io[f]; });
    if (Object.keys(fd).length) diff[ik] = fd;
  });
  return Object.keys(diff).length ? diff : null;
}

/** 全库本地改动字段数（用于横幅/状态栏提示） */
function modifiedFieldCount() {
  let n = 0;
  Object.keys(CITY_POLICY_LIBRARY).forEach(ck => {
    const city = CITY_POLICY_LIBRARY[ck];
    Object.keys(city.years || {}).forEach(yk => {
      const d = officialDiffFor(ck, yk);
      if (!d) return;
      Object.keys(d).forEach(k => { if (k !== '__rec') n += Object.keys(d[k]).length; else n += Object.keys(d.__rec).length; });
    });
  });
  return n;
}

/** 单字段恢复官方值；成功返回 true */
function restoreOfficialValue(cityKey, yearKey, itemKey, field) {
  const rec = CITY_POLICY_LIBRARY[cityKey] && CITY_POLICY_LIBRARY[cityKey].years[yearKey];
  const off = OFFICIAL_CITIES && OFFICIAL_CITIES[cityKey] && OFFICIAL_CITIES[cityKey].years[yearKey];
  if (!rec || !off) return false;
  if (itemKey === '__rec') {
    if (off[field] === undefined) return false;
    rec[field] = deepClone(off[field]);
  } else {
    const it = rec.items && rec.items[itemKey];
    const io = off.items && off.items[itemKey];
    if (!it || !io || io[field] === undefined) return false;
    it[field] = deepClone(io[field]);
    if (field !== 'rates') delete it.pending;
  }
  _policyCache.clear();
  savePolicyLibrary();
  return true;
}

/** 清除本机存档，整个工作库恢复为当前官方层（官方层之外的本地城市——自定义/新增——全部保留） */
function restoreOfficialAll() {
  clearPolicyLibraryStorage();
  const localOnly = {};
  Object.keys(CITY_POLICY_LIBRARY).forEach(k => {
    if (!OFFICIAL_CITIES || !OFFICIAL_CITIES[k]) localOnly[k] = deepClone(CITY_POLICY_LIBRARY[k]);
  });
  Object.keys(CITY_POLICY_LIBRARY).forEach(k => delete CITY_POLICY_LIBRARY[k]);
  Object.assign(CITY_POLICY_LIBRARY, deepClone(OFFICIAL_CITIES || {}), localOnly);
  if (!CITY_POLICY_LIBRARY.custom) CITY_POLICY_LIBRARY.custom = defaultCustomCity().custom;
  normalizePolicyLibrary(CITY_POLICY_LIBRARY);
  window._policyFromStorage = false;
  window._policySavedAt = '';
  _policyCache.clear();
}

/* 数据文件是否缺失（仅剩自定义城市） */
function isPolicyDataFileMissing() {
  return Object.keys(CITY_POLICY_LIBRARY).length <= 1 && !!CITY_POLICY_LIBRARY.custom;
}

function findCityKey(name) {
  const s = String(name || '').trim().replace(/市$/, '');
  if (!s) return null;
  for (const [key, city] of Object.entries(CITY_POLICY_LIBRARY)) {
    if (key === 'custom') continue;
    if (s === city.name || s === key || s === city.name.replace(/市$/, '')) return key;
  }
  return null;
}

/**
 * 解析某城市某月份适用的政策年度与险种数据
 * @returns {{cityKey, city, yearKey, items, matched, label, provenance}}
 *   provenance：所匹配年度记录的溯源快照（status/checkedAt/note/sources，浅拷贝防篡改库数据）
 */
function resolvePolicy(cityId, month) {
  const cityKey = CITY_POLICY_LIBRARY[cityId] ? cityId : 'custom';
  const city = CITY_POLICY_LIBRARY[cityKey];
  const yearKeys = Object.keys(city.years);
  let yearKey = null;

  // 固定年度（该城市存在该年度时生效）
  if (salaryParams.policyYear !== 'auto' && city.years[salaryParams.policyYear]) {
    yearKey = salaryParams.policyYear;
  } else if (month && month !== '-') {
    for (const yk of yearKeys) {
      const eff = city.years[yk].effective || ['2000-01', '2999-12'];
      if (eff[0] <= month && month <= eff[1]) { yearKey = yk; break; }
    }
  }

  let matched = true;
  if (!yearKey) {
    // 回退：生效区间终点最新的年度，并标注未精确匹配
    const sorted = yearKeys.slice().sort((a, b) =>
      String((city.years[b].effective || [''])[1]).localeCompare(String((city.years[a].effective || [''])[1])));
    yearKey = sorted[0] || yearKeys[0];
    matched = false;
  }
  const rec = city.years[yearKey];
  return {
    cityKey: cityKey,
    city: city,
    yearKey: yearKey,
    items: rec.items,
    matched: matched,
    label: city.name + ' · ' + (rec.label || yearKey),
    provenance: {
      status: rec.status || 'unverified',
      checkedAt: rec.checkedAt || '',
      note: rec.note || '',
      // 展示层过滤：编辑中标题为空的半成品来源不外露
      sources: Array.isArray(rec.sources)
        ? rec.sources.filter(s => s && String(s.title == null ? '' : s.title).trim() !== '').map(s => Object.assign({}, s))
        : []
    }
  };
}

/* (城市, 月份) 政策解析记忆化；政策库修改时 clear() */
const _policyCache = new Map();
function resolvePolicyMemo(cityId, month) {
  const k = cityId + '|' + month;
  if (_policyCache.has(k)) return _policyCache.get(k);
  const v = resolvePolicy(cityId, month);
  _policyCache.set(k, v);
  return v;
}

/** 险种基数 clamp；基数为 0/缺失时返回 0（由调用方决定兜底） */
function clampItemBase(base, item) {
  let v = Number(base) || 0;
  if (v <= 0) return 0;
  if (item.lower != null) v = Math.max(v, item.lower);
  if (item.upper != null) v = Math.min(v, item.upper);
  return v;
}

function libraryToRows(lib) {
  const rows = [['城市key', '城市名称', '年度', '生效起', '生效止', '年度说明', '险种', '个人比例(%)', '单位比例(%)', '基数下限', '基数上限', '公积金比例档(%)逗号分隔', '核查状态', '最近核查']];
  Object.entries(lib).forEach(([cityKey, city]) => {
    Object.entries(city.years || {}).forEach(([yk, rec]) => {
      SI_ITEMS.forEach(it => {
        const item = rec.items ? rec.items[it.key] : null;
        if (!item) return;
        const isFund = it.key === 'fund';
        rows.push([
          cityKey,
          city.name,
          yk,
          rec.effective ? rec.effective[0] : '',
          rec.effective ? rec.effective[1] : '',
          rec.label || '',
          it.label,
          round2((item.personal || 0) * 100),
          item.employer == null ? '' : round2(item.employer * 100),
          item.lower == null ? '' : item.lower,
          item.upper == null ? '' : item.upper,
          isFund ? (item.rates || []).map(r => round2(r * 100)).join(',') : '',
          statusLabel(rec.status),
          rec.checkedAt || ''
        ]);
      });
    });
  });
  return rows;
}

/** 扁平行 → 政策库。返回 { library, errors }；解析失败的行为收集到 errors。
 *  兼容新旧两种列布局：新布局含「单位比例(%)」列；旧布局（无该列）导入后单位比例由种子回退补齐。
 *  旧布局尾列「待核对」与新布局尾两列「核查状态/最近核查」均不参与解析——Excel 无来源列，
 *  导入一律 status:'unverified'、sources:[]（没来源不冒充有）。 */
function rowsToLibrary(rows) {
  const errors = [];
  const lib = {};
  const labelToKey = {};
  SI_ITEMS.forEach(it => {
    labelToKey[it.label] = it.key;
    labelToKey[it.label.replace('(含生育)', '')] = it.key;
  });
  const hasEmployerCol = !!(rows && rows[0] && rows[0].some(c => String(c == null ? '' : c).indexOf('单位比例') >= 0));
  const COL = hasEmployerCol
    ? { personal: 7, employer: 8, lower: 9, upper: 10, rates: 11 }
    : { personal: 7, employer: -1, lower: 8, upper: 9, rates: 10 };
  const body = (rows || []).slice(1).filter(r => r && r.some(c => String(c == null ? '' : c).trim() !== ''));
  const num = v => {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    const n = parseFloat(s.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  };
  /* 百分数 → 小数比例：整数换算避免 5.2/100 = 0.052000000000000005 这类浮点漂移 */
  const pctToRate = n => Math.round(n * 1e6) / 1e8;
  body.forEach((r, idx) => {
    const lineNo = idx + 2;
    const cityKey = String(r[0] == null ? '' : r[0]).trim();
    const cityName = String(r[1] == null ? '' : r[1]).trim();
    const yk = String(r[2] == null ? '' : r[2]).trim();
    const effStart = String(r[3] == null ? '' : r[3]).trim();
    const effEnd = String(r[4] == null ? '' : r[4]).trim();
    const label = String(r[5] == null ? '' : r[5]).trim();
    const itemKey = labelToKey[String(r[6] == null ? '' : r[6]).trim()];
    if (!cityKey || !yk || !itemKey) {
      errors.push(`第${lineNo}行：城市key/年度缺失或险种无法识别（${r[6]}）`);
      return;
    }
    const personalPct = num(r[COL.personal]);
    const personal = personalPct == null ? null : pctToRate(personalPct);
    const employerPct = COL.employer >= 0 ? num(r[COL.employer]) : null;
    const employer = employerPct == null ? null : pctToRate(employerPct);
    const lower = num(r[COL.lower]);
    const upper = num(r[COL.upper]);
    const city = lib[cityKey] || (lib[cityKey] = { name: cityName || cityKey, years: {} });
    const rec = city.years[yk] || (city.years[yk] = {
      label: label || yk,
      effective: [effStart || '2000-01', effEnd || '2999-12'],
      status: 'unverified',
      sources: [],
      items: {}
    });
    if (label) rec.label = label;
    if (/^\d{4}-\d{2}$/.test(effStart)) rec.effective[0] = effStart;
    if (/^\d{4}-\d{2}$/.test(effEnd)) rec.effective[1] = effEnd;
    if (itemKey === 'fund') {
      const rates = String(r[COL.rates] == null ? '' : r[COL.rates]).split(/[,，]/).map(s => pctToRate(parseFloat(s))).filter(n => !isNaN(n) && n > 0);
      const f = { personal: personal == null ? 0.05 : personal, rates: rates.length ? rates : FUND_RATES_STD.slice(), lower: lower, upper: upper };
      if (employer != null) f.employer = employer;
      rec.items.fund = f;
    } else {
      const it = { personal: personal == null ? 0 : personal, lower: lower, upper: upper };
      if (employer != null) it.employer = employer;
      rec.items[itemKey] = it;
    }
  });
  if (Object.keys(lib).length === 0) errors.push('未解析到任何有效数据行');
  return { library: lib, errors: errors };
}

  window.PolicyLib = { CITY_POLICY_LIBRARY,FUND_RATES_STD,POLICY_LIB_STORAGE_KEY,POLICY_STATUS,SI_ITEMS,SI_ITEM_LABELS,_policyCache,applyRemoteOfficial,applySeedUpdateIfNewer,clampItemBase,clearPolicyLibraryStorage,compareVersions,findCityKey,fundItem,getOfficialVersion,initRemotePolicy,isPolicyDataFileMissing, itemCoveredBySources,libraryToRows,loadPolicyLibrary,mergeLibrary,mergeSources,modifiedFieldCount,normalizePolicyLibrary,normalizeSources,officialDiffFor,policyStorageAvailable,resolvePolicy,resolvePolicyMemo,restoreOfficialAll,restoreOfficialValue,rowsToLibrary,savePolicyLibrary,siItem,statusLabel,valueEqual };

  function getOfficialVersion() { return OFFICIAL_VERSION; }
})();
