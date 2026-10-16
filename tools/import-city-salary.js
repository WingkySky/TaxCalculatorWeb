#!/usr/bin/env node
/* ============================================================
 * tools/import-city-salary.js — 从 city-salary 上游导入 337 城政策数据（一次性/可重跑）
 * 职责：把 weante/city-salary（MIT）calculator.html 内嵌的 CITIES 数据常量映射进本仓库
 *       tax-policy-data.json 的 schema，并把其逐城来源记录（docs/sources/*.json）
 *       转成我们的 sources[]——337 城从第一天起带溯源，不是裸数据。
 * 运行：node tools/import-city-salary.js               # 拉取上游数据到缓存并试运行（只打印报告）
 *       node tools/import-city-salary.js --apply       # 写入 JSON（之后必须重跑 build-policy-seed）
 *       node tools/import-city-salary.js --use-cache   # 跳过网络，用上次拉取的缓存
 * 自含性设计（零动态执行、零命令行路径）：
 *   · 数据获取：默认用 Node 内置 fetch 从上游 main 拉取 calculator.html 与
 *     docs/sources/*.json 到 <仓库>/.cache/city-salary/（gitignore）。
 *     命令行不接收任何路径——所有文件系统路径要么是常量，要么是经过
 *     ^[A-Z]\d+[a-z]?\.json$ 白名单校验的远端文件名，污点无从注入。
 *   · CITIES 是 calculator.html <script> 里的 `var CITIES={...}` 数据字面量——
 *     本工具先用字符串感知的括号扫描切出字面量范围，再用**自有的字面量解析器**
 *     静态解析（仅支持对象/数组/字符串/数字/布尔/null 与工厂调用），解析到
 *     CIU(...)/CI(...) 时以本工具自实现的工厂函数求值。全程不用 eval/vm/Function
 *     ——动态执行外部内容既违背仓库原则，也过不了安全门禁。
 *   · 来源记录读缓存中的纯 JSON 文件；「已核查判定 + 择优」规则（正向 isFilled：
 *     有 url 或 confirms 实质内容才算；scoreOf：状态权重*1000 + url 数*10 +
 *     confirms 长度）学习自对方 source-records.js 的公共语义，由本工具独立实现
 *     ——仓库原则：外部项目学原理自己写，不 require/执行外部代码。
 * 映射规则（详见 docs/policy-verification-playbook.md 与 specs/2026-10-15）：
 *   · 与本库同名城市（北京/上海/广州/深圳/杭州/南京/苏州/成都/重庆/武汉/西安/天津）
 *     不导入数值——本地数据更全（多年度、单位比例、文号来源），只补 region/rent；
 *   · 字段方向：他们 comp=单位、emp=个人，与我们 employer/personal 相反，映射时翻转；
 *   · 年度：dataYear '2025-2026'→社保年度 ['YYYY1-07','YYYY2-06']（福建特例：险种分属
 *     两年度，单记录跨 ['2025-01','2026-12']）；'2026'→七险种按省 cycle 表（7 月年度省
 *     名单见 CYCLE_SOCIAL_YEAR，默认自然年）；'2025'→自然年 2025；
 *   · 沿用记录：最新记录不覆盖当前月时，按本库既有惯例补「沿用」年度记录
 *     （label 注明沿用、status unverified），否则时效门禁会整片红；
 *   · 状态诚实降级：他们的 official-confirmed 也只映射为我们的 partial——
 *     数值没经过本仓库四关独立复核，不自称 confirmed；
 *   · 大额医疗固定额（medFixEmp）本库 schema 暂不支持，写入 note 供后续核查
 *     （约 110 城，多为河南/湖南/江西/宁夏等 5~20 元/月）。
 * 署名：数据源自 https://github.com/weante/city-salary（MIT License，Copyright (c) 2026 weante）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'tax-policy-data.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'city-salary');
const CACHE_CALC = path.join(CACHE_DIR, 'skills', 'city-salary', 'assets', 'calculator.html');
const CACHE_SOURCES = path.join(CACHE_DIR, 'docs', 'sources');
const CACHE_MANIFEST = path.join(CACHE_DIR, 'manifest.json');
const CALC_CACHE_REL = path.join('skills', 'city-salary', 'assets', 'calculator.html');
const UPSTREAM = 'https://github.com/weante/city-salary';
const RAW_BASE = 'https://raw.githubusercontent.com/weante/city-salary/main/';
const TREE_API = 'https://api.github.com/repos/weante/city-salary/git/trees/main?recursive=1';
/** 远端来源记录文件名白名单：G1.json / G1b.json / P2.json / Q5.json / R1.json（排除 _ 辅助文件） */
const SOURCE_NAME_RE = /^[A-Z]\d+[a-z]?\.json$/;
const OUR_NAMES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '重庆', '武汉', '西安', '天津'];
const SI_KEYS = ['pension', 'medical', 'unemployment', 'injury', 'fund'];
/* 7 月社保年度省份（dataYear='2026' 时生效区间为 ['2026-07','2027-06']；其余默认自然年）。
   依据：province-year.js 注释与 baseline-year-map.md（京人社发〔2026〕7号 7 月起、
   豫人社办〔2026〕62号 自 2026-07-01、鲁人社字〔2026〕75号 2026.7-2027.6、
   辽人社〔2026〕19号、川人社办发〔2026〕50号 2026.7 起、新疆 2026-07-27 件）。 */
const CYCLE_SOCIAL_YEAR = new Set(['北京', '上海', '天津', '重庆', '河南', '山东', '辽宁', '四川', '新疆']);
const FUND_STAIRS = [0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12];

function fail(msg) { console.error('✖ ' + msg); process.exit(1); }

function loadOurs() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  if (!data || !data.cities) fail('本库 JSON 结构不符：' + JSON_PATH);
  return data;
}

/* ---------- 数据拉取与缓存（Node 18+ 内置 fetch；常量路径 + 白名单文件名） ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 下载 URL → 校验通过才落盘；网络抖动重试 4 次 */
async function fetchTo(url, dest, validate) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      validate(text);
      fs.writeFileSync(dest, text);
      return text;
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

/** 拉取上游数据文件到缓存目录；返回 { calcPath, sourcesDir }（均为常量路径） */
async function fetchUpstreamToCache() {
  fs.mkdirSync(CACHE_SOURCES, { recursive: true });
  fs.mkdirSync(path.dirname(CACHE_CALC), { recursive: true });
  console.log('⇣ 拉取上游数据 → ' + CACHE_DIR);
  await fetchTo(RAW_BASE + 'skills/city-salary/assets/calculator.html', CACHE_CALC, t => {
    if (t.length < 100000 || !t.includes('var CITIES=')) throw new Error('calculator.html 内容异常（过短或无 CITIES）');
  });
  const treeText = await fetchTo(TREE_API, CACHE_MANIFEST + '.tree', t => {
    const j = JSON.parse(t);
    if (!j.tree) throw new Error('GitHub API 返回异常');
  });
  const names = JSON.parse(treeText).tree
    .map(e => e.path)
    .filter(p => /^docs\/sources\//.test(p))
    .map(p => p.slice('docs/sources/'.length))
    .filter(n => SOURCE_NAME_RE.test(n)); /* 文件名白名单：远端名单先过筛再进路径拼接 */
  let done = 0;
  for (const name of names) {
    /* name 已过白名单，拼接安全 */
    await fetchTo(RAW_BASE + 'docs/sources/' + name, path.join(CACHE_SOURCES, name), t => { JSON.parse(t); });
    if (++done % 20 === 0) console.log('  … ' + done + '/' + names.length);
  }
  fs.writeFileSync(CACHE_MANIFEST, JSON.stringify({ ref: 'main', fetchedAt: new Date().toISOString(), files: names.length }, null, 2) + '\n');
  console.log('⇣ 完成：calculator.html + ' + names.length + ' 个来源记录文件');
}

/** 缓存就绪检查：主数据文件与来源目录必须存在 */
function assertCache() {
  if (!fs.existsSync(CACHE_CALC)) fail('缓存缺少 calculator.html——先不带 --use-cache 跑一次以拉取数据');
  if (!fs.existsSync(CACHE_SOURCES)) fail('缓存缺少 docs/sources/——先不带 --use-cache 跑一次以拉取数据');
}

/* ---------- CITIES 数据常量提取（自含，零动态执行） ---------- */

/* 对方 calculator.html 里的两家城市条目工厂——语义学习自其源码后由本工具自实现
 * （仓库原则：外部项目学原理自己写）。字面量本身是数据，解析时以本工具的工厂作为
 * 求值函数。注意：这两组默认值（基数区间/费率/rent 等）跟随上游文件演进，
 * 重导前应先 diff 上游 CI/CIU 定义；若字面量出现第三家工厂，解析器会明确报错。 */

/** 直辖市型：五险共用一个基数区间，费率由 r 传入（对应对方 CIU） */
function cityUnified(name, u, r, hf, opt) {
  return Object.assign({
    name: name, region: '直辖市', dataYear: '2026', dataNext: null,
    pension: { min: u.min, max: u.max, comp: .16, emp: .08 },
    med: { min: u.min, max: u.max, comp: r.medComp, emp: r.medEmp },
    unemp: { min: u.min, max: u.max, comp: r.unempComp, emp: r.unempEmp },
    mat: { min: u.min, max: u.max, comp: 0 },
    inj: { min: u.min, max: u.max, comp: r.injComp === undefined ? .002 : r.injComp },
    hf: hf, rent: 1500, hfRateMax: r.hfRateMax || 12, medFixEmp: r.medFixEmp || 0,
  }, opt || {});
}

/** 广东型：医保/公积金单独传参，养老/失业/工伤用省级默认（对应对方 CI） */
function cityGuangdong(name, med, mat, hf, pPensionMin, opt) {
  return Object.assign({
    name: name, region: '广东', dataYear: '2025-2026', dataNext: null,
    pension: { min: pPensionMin || 4775, max: 27549, comp: .16, emp: .08 },
    med: med, unemp: { min: 2520, max: 44265, comp: .008, emp: .002 },
    mat: mat || { min: med.min, max: med.max, comp: 0 },
    inj: { min: 2520, max: 44265, comp: .002 }, hf: hf, rent: 1100,
    hfRateMax: 12, medFixEmp: 0,
  }, opt || {});
}

/** 从 <script> 源码里切出 `var CITIES=` 后的完整对象字面量（字符串/注释感知的括号扫描） */
function sliceObjectLiteral(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  let j = i + marker.length; /* 停在 '{' */
  let depth = 0, inStr = null;
  while (j < src.length) {
    const ch = src[j];
    if (inStr) {
      if (ch === '\\') { j += 2; continue; }
      if (ch === inStr) inStr = null;
      j++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; j++; continue; }
    if (ch === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2); if (j < 0) return null; j += 2; continue; }
    if (ch === '/' && src[j + 1] === '/') { const nl = src.indexOf('\n', j); j = nl < 0 ? src.length : nl + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { j++; return src.slice(i + marker.length, j); } }
    j++;
  }
  return null;
}

/** calculator.html → CITIES 对象：自有字面量解析器静态解析，工厂调用用本工具自实现版本 */
function extractCities(calcPath) {
  const html = fs.readFileSync(calcPath, 'utf8');
  const lit = sliceObjectLiteral(html, 'var CITIES=');
  if (!lit) fail('calculator.html 中找不到完整的 var CITIES={...} 数据字面量');
  let cities;
  try {
    cities = parseDataLiteral(lit, { CIU: cityUnified, CI: cityGuangdong });
  } catch (e) {
    if (/未实现的工厂/.test(e.message)) {
      fail(e.message + '\n  上游可能新增了城市工厂，请学习其语义后在 extractCities 的工厂表注入自实现版本');
    }
    fail('CITIES ' + e.message);
  }
  if (!cities || typeof cities !== 'object') fail('CITIES 提取结果不是对象');
  return cities;
}

/* ---------- 数据字面量解析器（自含，纯静态，零动态执行） ---------- */

/** 解析 JS 对象字面量的数据子集：对象/数组/字符串(含模板无插值)/数字/true/false/null/工厂调用。
 *  factories: 标识符名 → 求值函数；遇到 IDENT(args) 即调用之（如 CIU/CI）。 */
function parseDataLiteral(src, factories) {
  let pos = 0;
  const ctx = () => JSON.stringify(src.slice(Math.max(0, pos - 30), pos + 30));
  function ws() {
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
      if (src[pos] === '/' && src[pos + 1] === '/') { const nl = src.indexOf('\n', pos); pos = nl < 0 ? src.length : nl + 1; continue; }
      if (src[pos] === '/' && src[pos + 1] === '*') { const e = src.indexOf('*/', pos + 2); if (e < 0) throw new Error('块注释未闭合 @' + pos); pos = e + 2; continue; }
      return;
    }
  }
  function parseString(quote) {
    pos++; /* 越过开引号 */
    let out = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\') {
        const n = src[pos + 1];
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'u') { out += String.fromCharCode(parseInt(src.substr(pos + 2, 4), 16)); pos += 4; }
        else out += n;
        pos += 2; continue;
      }
      if (quote === '`' && ch === '$' && src[pos + 1] === '{') throw new Error('不支持模板字符串插值 @' + pos);
      if (ch === quote) { pos++; return out; }
      out += ch; pos++;
    }
    throw new Error('字符串未闭合 @' + pos);
  }
  const NUM_RE = /^(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;
  function parseValue() {
    ws();
    const ch = src[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'" || ch === '`') return parseString(ch);
    if (ch === '-' || (ch >= '0' && ch <= '9') || ch === '.') {
      const m = src.slice(pos).match(NUM_RE);
      if (!m) throw new Error('非法数字 @' + pos + ' 上下文 ' + ctx());
      pos += m[0].length;
      return Number(m[0]);
    }
    const idm = src.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (idm) {
      const id = idm[0];
      pos += id.length;
      ws();
      const isCall = src[pos] === '(';
      if (isCall) {
        const fn = factories[id];
        if (!fn) throw new Error('未实现的工厂「' + id + '」@' + pos + ' 上下文 ' + ctx());
        pos++; /* 越过 ( */
        const args = [];
        ws();
        if (src[pos] !== ')') {
          for (;;) {
            args.push(parseValue());
            ws();
            if (src[pos] === ',') { pos++; continue; }
            break;
          }
        }
        if (src[pos] !== ')') throw new Error('工厂调用未闭合 @' + pos + ' 上下文 ' + ctx());
        pos++;
        return fn.apply(null, args);
      }
      if (id === 'true') return true;
      if (id === 'false') return false;
      if (id === 'null' || id === 'undefined') return null;
      throw new Error('未支持的字面量标识符「' + id + '」@' + pos + ' 上下文 ' + ctx());
    }
    throw new Error('无法识别的记号 @' + pos + ' 上下文 ' + ctx());
  }
  function parseObject() {
    pos++; /* { */
    const out = {};
    ws();
    if (src[pos] === '}') { pos++; return out; }
    for (;;) {
      ws();
      let key;
      const ch = src[pos];
      if (ch === '"' || ch === "'" || ch === '`') key = parseString(ch);
      else {
        const m = src.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
        if (!m) throw new Error('非法对象键 @' + pos + ' 上下文 ' + ctx());
        key = m[0]; pos += m[0].length;
      }
      ws();
      if (src[pos] !== ':') throw new Error('对象键后缺冒号 @' + pos + ' 上下文 ' + ctx());
      pos++;
      out[key] = parseValue();
      ws();
      if (src[pos] === ',') { pos++; continue; }
      if (src[pos] === '}') { pos++; return out; }
      throw new Error('对象项后缺逗号或右括号 @' + pos + ' 上下文 ' + ctx());
    }
  }
  function parseArray() {
    pos++; /* [ */
    const out = [];
    ws();
    if (src[pos] === ']') { pos++; return out; }
    for (;;) {
      out.push(parseValue());
      ws();
      if (src[pos] === ',') { pos++; continue; }
      if (src[pos] === ']') { pos++; return out; }
      throw new Error('数组项后缺逗号或右括号 @' + pos + ' 上下文 ' + ctx());
    }
  }
  const value = parseValue();
  ws();
  if (pos !== src.length) throw new Error('字面量尾部有未消费内容 @' + pos + ' 上下文 ' + ctx());
  return value;
}

/* ---------- 来源记录读取（自含实现，判定规则学习自对方 source-records.js 公共语义） ---------- */

/** 占位特征词——confirms 命中其一即视为未填（正向判定，不排除特定写法） */
const STUB_RE = /尚未核查|占位|待核查|待查|待补充|^$|^无$|^-$/;
/** 无 url 时，confirms 至少要有这么长才算「有实质内容」 */
const MIN_SUBSTANTIVE_LEN = 25;

function isFilled(c) {
  const s = String((c && c.confirms) || '').trim();
  if (STUB_RE.test(s)) return false;
  if (((c && c.urls) || []).length > 0) return true;
  return s.length >= MIN_SUBSTANTIVE_LEN;
}

/** 可信度排序分：状态权重 > 链接数 > confirms 长度 */
function scoreOf(c) {
  const st = c.status === 'official-confirmed' ? 2 : c.status === 'official-partial' ? 1 : 0;
  return st * 1000 + ((c.urls || []).length) * 10 + Math.min(String(c.confirms || '').length, 500) / 100;
}

/** docs/sources/*.json → { best, stats, fileDate, badFiles }；best 按城市名取最高分一条 */
function readSourceRecords(sourcesDir) {
  const files = fs.readdirSync(sourcesDir).filter(n => SOURCE_NAME_RE.test(n) && n[0] !== '_').sort();
  const best = {};
  const badFiles = [];
  const fileDate = {};
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(sourcesDir, f), 'utf8')); } catch (e) { badFiles.push(f); continue; }
    if (j.generatedAt) fileDate[f] = String(j.generatedAt).slice(0, 7); /* 批次文件的 generatedAt → checkedAt 用 */
    for (const p of (j.provinces || [])) {
      for (const c of (p.cities || [])) {
        if (!isFilled(c)) continue;
        const s = scoreOf(c);
        if (!best[c.city] || s > best[c.city].score) {
          best[c.city] = {
            city: c.city, file: f, score: s,
            status: c.status, urls: c.urls || [],
            docNumber: c.docNumber || '', confirms: String(c.confirms || ''),
          };
        }
      }
    }
  }
  const stats = { checked: 0, confirmed: 0, partial: 0, notFound: 0, urls: 0 };
  for (const n of Object.keys(best)) {
    const b = best[n];
    stats.checked++;
    if (b.status === 'official-confirmed') stats.confirmed++;
    else if (b.status === 'official-partial') stats.partial++;
    else stats.notFound++;
    stats.urls += b.urls.length;
  }
  return { best, stats, fileDate, badFiles };
}

/* ---------- 年度解析 ---------- */
function resolveYears(dataYear, region, nowYM) {
  const nowY = Number(nowYM.slice(0, 4));
  const out = [];
  if (dataYear === '2025-2026') {
    if (region === '福建') {
      /* 险种分年度：养老/失业 2025 自然年 + 医保/工伤 2026 自然年 → 单记录跨两年 */
      out.push({ key: '2025', effective: ['2025-01', '2026-12'], carry: false, label: '2025-2026（养老·失业 2025 年度；医保·工伤 2026 年度）' });
      return out;
    }
    out.push({ key: '2025', effective: ['2025-07', '2026-06'], carry: false, label: '2025年度（社保年度 2025-07 ~ 2026-06）' });
    if (nowYM > '2026-06') out.push({ key: '2026', effective: ['2026-07', '2027-06'], carry: '2025', label: '2026年度（沿用2025年度参考值，新年度未公布）' });
    return out;
  }
  if (dataYear === '2025') {
    out.push({ key: '2025', effective: ['2025-01', '2025-12'], carry: false, label: '2025年度（2025-01 ~ 2025-12）' });
    if (nowY >= 2026) out.push({ key: '2026', effective: ['2026-01', '2026-12'], carry: '2025', label: '2026年度（沿用2025年度参考值，新年度未公布）' });
    return out;
  }
  if (dataYear === String(nowY) || /^[2]\d{3}$/.test(dataYear)) {
    const y = String(dataYear);
    const social = CYCLE_SOCIAL_YEAR.has(region);
    out.push(social
      ? { key: y, effective: [y + '-07', Number(y) + 1 + '-06'], carry: false, label: y + '年度（' + y + '-07 ~ ' + (Number(y) + 1) + '-06）' }
      : { key: y, effective: [y + '-01', y + '-12'], carry: false, label: y + '年度（' + y + '-01 ~ ' + y + '-12）' });
    return out;
  }
  fail('未知 dataYear 形态「' + dataYear + '」（' + region + '）');
  return [];
}

/* ---------- 单城映射 ---------- */
function mapItems(c) {
  const si = (o, defEmp) => {
    if (!o) return null;
    const it = { personal: o.emp == null ? (defEmp || 0) : o.emp, lower: o.min, upper: o.max };
    if (o.comp != null) it.employer = o.comp;
    return it;
  };
  const items = {};
  items.pension = si(c.pension);
  items.medical = si(c.med);
  items.unemployment = si(c.unemp);
  const inj = si(c.inj, 0);
  if (inj) { inj.personal = 0; items.injury = inj; }
  if (c.hf) {
    items.fund = {
      personal: 0.05,
      rates: FUND_STAIRS.filter(r => r <= (c.hfRateMax || 12)),
      lower: c.hf.min,
      upper: c.hf.max,
    };
  }
  return items;
}

function mapSources(src, status) {
  if (!src || status !== 'official-confirmed') return undefined; // partial/not-found 不主张有据
  const urls = (src.urls || []).slice(0, 3);
  if (!urls.length && !src.docNumber) return undefined;
  const entry = {
    title: src.docNumber ? '官方文件：' + src.docNumber : '官方来源页（city-salary 复核）',
    covers: SI_KEYS.slice(), // 全项
  };
  if (src.docNumber) entry.ref = src.docNumber;
  if (urls.length) entry.url = urls[0];
  if (src.confirms) entry.confirms = String(src.confirms).slice(0, 800);
  const out = [entry];
  urls.slice(1).forEach(u => out.push({ title: '官方佐证页', url: u, covers: SI_KEYS.slice() }));
  return out;
}

function convertCity(key, c, src, fileDate, nowYM) {
  const years = {};
  for (const y of resolveYears(c.dataYear, c.region, nowYM)) {
    const rec = {
      label: y.label,
      effective: y.effective,
      status: (src && src.status === 'official-confirmed') ? 'partial' : 'unverified',
      items: mapItems(c),
    };
    if (src && fileDate[src.file]) rec.checkedAt = fileDate[src.file];
    const sources = mapSources(src, src ? src.status : null);
    if (sources) rec.sources = sources;
    const notes = [];
    if (y.carry) notes.push('沿用 ' + y.carry + ' 年度参考值：新年度基数未公布（city-salary dataNext 提示），公布后须核查替换');
    if (c.medFixEmp) notes.push('医保个人另有大额/固定额 ' + c.medFixEmp + ' 元/月，本库暂未计入计算');
    if (c.note) notes.push(String(c.note).trim());
    else if (c.warn) notes.push('city-salary 标记 warn：数值待确认');
    if (notes.length) rec.note = notes.join('；');
    years[y.key] = rec;
  }
  const city = { name: c.name, years: years };
  if (c.region) city.region = c.region;
  if (c.rent) city.rent = c.rent;
  return city;
}

/* ---------- 校验 ---------- */
function validateImported(key, city) {
  for (const [yk, rec] of Object.entries(city.years)) {
    for (const ik of SI_KEYS) {
      const it = rec.items[ik];
      if (!it) continue;
      if (it.lower != null && it.upper != null && it.lower > it.upper) throw new Error(key + '/' + yk + '/' + ik + ' 下限>上限');
      if (!(it.personal >= 0 && it.personal <= 0.25)) throw new Error(key + '/' + yk + '/' + ik + ' personal 越界 ' + it.personal);
      if (it.employer != null && !(it.employer >= 0 && it.employer <= 0.35)) throw new Error(key + '/' + yk + '/' + ik + ' employer 越界 ' + it.employer);
      if (ik === 'fund' && (!Array.isArray(it.rates) || !it.rates.length)) throw new Error(key + '/' + yk + ' 公积金比例档为空');
    }
    if (!(rec.effective && rec.effective.length === 2 && rec.effective[0] <= rec.effective[1])) throw new Error(key + '/' + yk + ' effective 非法');
  }
}

/* ---------- 主流程 ---------- */
function run(apply) {
  const nowYM = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); })();
  const ours = loadOurs();
  const theirCities = extractCities(CACHE_CALC);
  const { best, stats, fileDate, badFiles } = readSourceRecords(CACHE_SOURCES);
  if (badFiles.length) console.error('⚠ 来源记录坏文件（跳过）：' + badFiles.join(' '));

  const report = { imported: 0, skipped: [], carryRecords: 0, statusCount: { partial: 0, unverified: 0 }, withSources: 0, errors: [] };
  const imported = {};
  for (const [key, c] of Object.entries(theirCities)) {
    if (OUR_NAMES.includes(c.name)) { report.skipped.push(c.name + '=' + key); continue; }
    if (c.name === '自定义') continue;
    try {
      const city = convertCity(key, c, best[c.name], fileDate, nowYM);
      validateImported(key, city);
      if (imported[c.name]) throw new Error('城市名重复：' + c.name);
      if (ours.cities[key]) throw new Error('与现有键冲突：' + key);
      imported[key] = city;
      report.imported++;
      report.statusCount[Object.values(city.years)[0].status === 'partial' ? 'partial' : 'unverified']++;
      if (Object.values(city.years).some(r => r.sources)) report.withSources++;
      report.carryRecords += Math.max(0, Object.keys(city.years).length - 1);
    } catch (e) {
      report.errors.push(key + ' ' + c.name + '：' + e.message);
    }
  }
  if (report.errors.length) {
    console.error('✖ 校验失败 ' + report.errors.length + ' 条，未写入：');
    report.errors.slice(0, 20).forEach(e => console.error('  ' + e));
    process.exit(1);
  }

  /* 现有 13 城：补 region/rent（按名字匹配对方数据），其余不动 */
  const patched = [];
  for (const [ck, city] of Object.entries(ours.cities)) {
    const theirs = Object.values(theirCities).find(t => t.name === city.name);
    if (theirs) {
      if (!city.region && theirs.region) { city.region = theirs.region; patched.push(city.name + '(region)'); }
      if (!city.rent && theirs.rent) { city.rent = theirs.rent; patched.push(city.name + '(rent)'); }
    }
  }

  /* 组装：现有 13 城 → 导入城市（对方文件序）→ custom 殿后 */
  const cities = {};
  for (const [ck, city] of Object.entries(ours.cities)) { if (ck !== 'custom') cities[ck] = city; }
  for (const [key, city] of Object.entries(imported)) cities[key] = city;
  cities.custom = ours.cities.custom;

  /* 抽样（人工核对锚点） */
  const sampleNames = ['郑州', '哈尔滨', '拉萨', '温州'];
  const samples = {};
  for (const [key, city] of Object.entries(imported)) {
    if (sampleNames.includes(city.name)) samples[city.name] = { key, year: Object.keys(city.years)[0], pension: city.years[Object.keys(city.years)[0]].items.pension, status: Object.values(city.years)[0].status };
  }

  console.log('=== 导入报告 ===');
  console.log('对方来源统计:', JSON.stringify(stats));
  console.log('导入城市:', report.imported, '（跳过同名:', report.skipped.join(' ') + '）');
  console.log('沿用年度记录:', report.carryRecords, ' status 分布:', JSON.stringify(report.statusCount), ' 带来源:', report.withSources);
  console.log('现有城市补齐:', patched.join(' ') || '（无）');
  console.log('抽样:', JSON.stringify(samples, null, 1));
  console.log('JSON 预计体积:', (JSON.stringify({ version: ours.version, cities }).length / 1024).toFixed(0) + ' KB');

  if (apply) {
    ours.version = bump(ours.version);
    ours.cities = cities;
    fs.writeFileSync(JSON_PATH, JSON.stringify(ours, null, 2) + '\n');
    console.log('✔ 已写入 ' + JSON_PATH + '，version=' + ours.version + '。请重跑 node tools/build-policy-seed.js 并跑回归门。');
  } else {
    console.log('（试运行，未写入。加 --apply 落盘）');
  }
}

function bump(v) {
  const p = String(v).split('.').map(n => parseInt(n, 10) || 0);
  p[1] = (p[1] || 0) + 1;
  return p[0] + '.' + String(p[1]).padStart(2, '0');
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const useCache = args.includes('--use-cache');
const unknown = args.filter(a => a !== '--apply' && a !== '--use-cache');
if (unknown.length) {
  fail('用法: node tools/import-city-salary.js [--apply] [--use-cache]\n' +
    '默认从上游拉取数据到 .cache/city-salary/ 后试运行；--apply 写入本库 JSON；--use-cache 离线复跑\n' +
    '（上游: ' + UPSTREAM + '）');
}

(async () => {
  if (useCache) assertCache();
  else await fetchUpstreamToCache();
  run(apply);
})().catch(e => fail('拉取上游数据失败：' + (e && e.message || e)));
