#!/usr/bin/env node
/* ============================================================
 * tools/policy-expiry.js — 政策时效与过期门禁（零依赖，CI/本地均可跑）
 * 职责：把 docs/policy-verification-playbook.md 的三检查点从纸面纪律变成会变红的门禁。
 * 检查四道门：
 *   ① 现行期覆盖：每个真实城市必须有一条年度记录的 effective 覆盖当前月份，
 *     否则该城对当前月份算的是过期政策——除非在 ACKNOWLEDGED 登记处置。
 *   ② 限期费率清单：LIMITED_RATES 里已到期而未登记处置的条目直接红
 *     （到期日 60 天内出提醒）。清单当前为空——首次核实阶段性费率
 *     （如上海医保 9% 线索）后按示例登记。
 *   ③ 诚实性：status 为 confirmed 的年度记录，必须有一条 sources 覆盖全部
 *     五个险种（specs/2026-10-15 §4.3 验收条款）——防止「贴一条链接就标全绿」。
 *   ④ 迁移卫生：JSON 中不得残留旧 pending 字段。
 * 运行：node tools/policy-expiry.js     退出码 1 = 有未处置过期（CI 变红）
 * 设计要点（借自 city-salary）：已到期不会自动放行——必须在 ACKNOWLEDGED 写一条
 * { date, reason } 才降级为提示，**逼你做一个有记录的判断，而不是默默沿用**。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'tax-policy-data.json');
const SI_KEYS = ['pension', 'medical', 'unemployment', 'injury', 'fund'];

/** 当前月份 "YYYY-MM"（可用环境变量 POLICY_TODAY=YYYY-MM 覆盖，供演练/测试） */
function currentMonth() {
  if (process.env.POLICY_TODAY && /^\d{4}-\d{2}$/.test(process.env.POLICY_TODAY)) return process.env.POLICY_TODAY;
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/* ---------- 限期费率清单（人可读版本见手册；核实一条登记一条） ----------
 * 示例（勿直接启用，数值须先过四关）：
 * {
 *   name: '上海职工医保（含生育）单位费率',
 *   current: 0.09,                       // 现行费率（小数）
 *   until: '2027-02-28',                 // 文件有效期至（YYYY-MM-DD）
 *   ref: '沪医保规〔2026〕X号',
 *   note: '到期可能恢复原费率，到期次日必须联网核查',
 *   // acknowledged: { date: '2026-10-16', reason: '续期文件尚未发布，暂按现行执行' },
 * }
 */
const LIMITED_RATES = [];

/** 已登记处置的过期项：键 = 'city:<城市key>' 或 'rate:<限期费率name>'。
 *  登记后该项从「红灯」降级为「已登记的提示」，必须给出日期与理由。 */
const ACKNOWLEDGED = {
  // 'city:guangzhou': { date: '2026-10-16', reason: '广东 2026 社保年度惯例 10 月公布，现行记录为公布前的过渡值（README 已注明）' },
};

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

function loadLibrary() {
  let data;
  try { data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch (e) { fail('读取 tax-policy-data.json 失败：' + e.message); }
  if (!data || typeof data !== 'object' || !data.cities) fail('JSON 根结构不符（缺少 cities）');
  return data;
}

/** ① 现行期覆盖 */
function checkCoverage(data, now) {
  const problems = [];
  const stats = { cities: 0, unverified: 0, partial: 0, confirmed: 0 };
  Object.keys(data.cities).sort().forEach(ck => {
    if (ck === 'custom') return;
    const city = data.cities[ck];
    const years = city.years || {};
    const covered = Object.keys(years).some(yk => {
      const eff = years[yk].effective || [];
      return eff.length === 2 && eff[0] <= now && now <= eff[1];
    });
    if (!covered) {
      if (ACKNOWLEDGED['city:' + ck]) problems.push(`◌ ${city.name}(${ck})：无覆盖 ${now} 的年度记录——已登记处置（${ACKNOWLEDGED['city:' + ck].reason}）`);
      else problems.push(`✖ ${city.name}(${ck})：无任何年度记录覆盖当前月份 ${now}——该城当前月份在用过期政策。联网核查新年度文件，或在 ACKNOWLEDGED['city:${ck}'] 登记处置`);
    }
    stats.cities++;
    Object.keys(years).forEach(yk => {
      const st = years[yk].status || 'unverified';
      if (st === 'unverified') stats.unverified++;
      else if (st === 'partial') stats.partial++;
      else if (st === 'confirmed') stats.confirmed++;
    });
  });
  return { problems, stats };
}

/** ② 限期费率清单：到期未处置即红；60 天内到期提醒 */
function checkLimitedRates(now) {
  const problems = [], notices = [];
  const DAY = 24 * 3600 * 1000;
  const nowMs = new Date(now + '-01').getTime();
  LIMITED_RATES.forEach((r, i) => {
    const key = 'rate:' + r.name;
    if (!r.name || !/^\d{4}-\d{2}-\d{2}$/.test(r.until || '')) problems.push(`✖ 限期费率第 ${i + 1} 条：name/until 缺失或 until 非 YYYY-MM-DD`);
    if (r.current != null && (typeof r.current !== 'number' || r.current <= 0 || r.current >= 1)) problems.push(`✖ 限期费率「${r.name}」：current 应为 0~1 之间的小数`);
    const untilMs = new Date(r.until + 'T00:00:00Z').getTime();
    if (untilMs < nowMs) {
      if (r.acknowledged) notices.push(`◌ 限期费率「${r.name}」已于 ${r.until} 到期——已登记处置（${r.acknowledged.reason}）`);
      else if (ACKNOWLEDGED[key]) notices.push(`◌ 限期费率「${r.name}」已于 ${r.until} 到期——已登记处置（${ACKNOWLEDGED[key].reason}）`);
      else problems.push(`✖ 限期费率「${r.name}」已到期（${r.until}）未登记处置：联网核查是延续、调整还是恢复原值，更新 until 或在 ACKNOWLEDGED['${key}'] 登记`);
    } else if (untilMs - nowMs <= 60 * DAY) {
      notices.push(`⚠ 限期费率「${r.name}」将于 ${r.until} 到期（60 天内）——提前安排核查，别等到期`);
    }
  });
  return { problems, notices };
}

/** ③ 诚实性：confirmed 必须有覆盖全险种的来源 */
function checkConfirmedSources(data) {
  const problems = [];
  Object.keys(data.cities).sort().forEach(ck => {
    const city = data.cities[ck];
    Object.keys(city.years || {}).forEach(yk => {
      const rec = city.years[yk];
      if ((rec.status || 'unverified') !== 'confirmed') return;
      const sources = Array.isArray(rec.sources) ? rec.sources : [];
      const fullCovered = SI_KEYS.every(k => sources.some(s =>
        s && String(s.title || '').trim() !== '' &&
        (!Array.isArray(s.covers) || s.covers.indexOf(k) >= 0)));
      if (!fullCovered) problems.push(`✖ ${city.name}(${ck}) ${yk}：status=confirmed 但没有覆盖全部五个险种的来源——降级为 partial/unverified，或补齐 sources`);
    });
  });
  return problems;
}

/** ④ 迁移卫生：旧 pending 字段不得残留 */
function checkLegacyPending(data) {
  const problems = [];
  Object.keys(data.cities).forEach(ck => {
    Object.keys(data.cities[ck].years || {}).forEach(yk => {
      if ('pending' in data.cities[ck].years[yk]) problems.push(`✖ ${ck}/${yk}：残留旧 pending 字段（2026.10 起由 status 取代，运行时已映射）——删掉该字段并重跑 build-policy-seed`);
    });
  });
  return problems;
}

function main() {
  const now = currentMonth();
  const data = loadLibrary();
  const cov = checkCoverage(data, now);
  const rates = checkLimitedRates(now);
  const confirmed = checkConfirmedSources(data);
  const legacy = checkLegacyPending(data);

  const errors = cov.problems.concat(rates.problems, confirmed, legacy);
  const notices = rates.notices;

  console.log(`政策时效门禁（当前月份 ${now}）：城市 ${cov.stats.cities}，status 分布 confirmed ${cov.stats.confirmed} / partial ${cov.stats.partial} / unverified ${cov.stats.unverified}`);
  notices.forEach(n => console.log(n));
  if (errors.length) {
    console.error('\n未处置过期项 ' + errors.length + ' 条：');
    errors.forEach(e => console.error(e));
    console.error('\n处置方式：联网核查并更新数据（见 docs/policy-verification-playbook.md），或在 tools/policy-expiry.js 的 ACKNOWLEDGED 登记处置理由。');
    process.exit(1);
  }
  console.log('✔ 时效门禁通过：全部城市现行期有覆盖，限期费率无未处置到期项');
}

if (require.main === module) main();

module.exports = { currentMonth, checkCoverage, checkLimitedRates, checkConfirmedSources, checkLegacyPending, LIMITED_RATES, ACKNOWLEDGED };
