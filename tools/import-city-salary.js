#!/usr/bin/env node
/* ============================================================
 * tools/import-city-salary.js — 从 city-salary 克隆导入 337 城政策数据（一次性/可重跑）
 * 职责：把 weante/city-salary（MIT）calculator.html 的 CITIES 常量映射进本仓库
 *       tax-policy-data.json 的 schema，并把其逐城来源记录（docs/sources/*.json）
 *       转成我们的 sources[]——337 城从第一天起带溯源，不是裸数据。
 * 运行：node tools/import-city-salary.js <city-salary克隆路径>           # 试运行，只打印报告
 *       node tools/import-city-salary.js <克隆路径> --apply              # 写入 JSON（之后必须重跑 build-policy-seed）
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
  if (!data || !data.cities) fail('本库 JSON 结构不符');
  return data;
}

/* ---------- 来源记录：直接复用对方的读取/判定模块（其 ROOT 随克隆路径解析） ---------- */
function loadSources(clone) {
  const sr = require(path.join(clone, 'tools', 'source-records.js'));
  const { best, stats } = sr.readRecords();
  /* 批次文件的 generatedAt → checkedAt 用 */
  const fileDate = {};
  for (const f of fs.readdirSync(sr.DIR).filter(n => /^[A-Z]\d+[a-z]?\.json$/.test(n))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(sr.DIR, f), 'utf8'));
      if (j.generatedAt) fileDate[f] = String(j.generatedAt).slice(0, 7);
    } catch (e) { /* 忽略坏文件 */ }
  }
  return { best, stats, fileDate };
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
function run(clone, apply) {
  const nowYM = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); })();
  const ours = loadOurs();
  const { loadCalculator } = require(path.join(clone, 'tools', 'calc-harness.js'));
  const theirCities = loadCalculator().CITIES;
  const { best, stats, fileDate } = loadSources(clone);

  const report = { imported: 0, skipped: [], carryRecords: 0, statusCount: { partial: 0, unverified: 0 }, withSources: 0, errors: [] };
  const imported = {};
  for (const [key, c] of Object.entries(theirCities)) {
    if (OUR_NAMES.includes(c.name)) { report.skipped.push(c.name + '=' + key); continue; }
    if (c.name === '自定义') continue;
    try {
      validateImported.pending = null;
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
const clone = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
if (!clone || !fs.existsSync(path.join(clone, 'tools', 'calc-harness.js'))) {
  fail('用法: node tools/import-city-salary.js <city-salary克隆路径> [--apply]\n（克隆: git clone --depth 1 https://github.com/weante/city-salary）');
}
run(path.resolve(clone), apply);
