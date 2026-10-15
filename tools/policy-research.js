#!/usr/bin/env node
/* ============================================================
 * tools/policy-research.js — 政策数据联网核查工具（零依赖，维护者侧用，不进页面）
 * 职责：为 tax-policy-data.json 的年度核查固化「已验证可用」的取数链路，
 *       替代每次临时手搓。只做**取数与摘录**，数值是否采纳由四关复核决定
 *       （见 docs/policy-verification-playbook.md——政策原文常有「暂按」「待发布」
 *       「调整前」等限定语，机器识别不了）。
 * 运行：node tools/policy-research.js search "查询词"   # 搜索+抓第一个政府页+抽候选
 *       node tools/policy-research.js gov    "查询词"   # 只列政府域名结果
 *       node tools/policy-research.js fetch  <url>      # 抓正文
 *       node tools/policy-research.js facts  <url>      # 抓正文并抽取上下限/文号/费率候选
 * 出处：改编自 weante/city-salary（MIT License, Copyright (c) 2026 weante）
 *       的 tools/research.js。其链路经 337 城逐城核查实战验证；本仓库按实际
 *       网络环境做了两处本地化（教训原文保留，改动前先读注释）：
 *       ① 搜索降级链改为 必应中国 → Brave → DDG Lite（实测大陆网络直连
 *          Brave/DDG 全部超时，必应中国可用；原版为 Brave → DDG 补充）；
 *       ② 抓页降级链改为 直连 → Jina Reader → 本机 Edge 无头（国内政府站
 *          直连可达且最快；Jina 主要救直连被挑战页拦住的站；Edge 救 SPA/反爬）。
 * 限流纪律：并发核查任务 ≤2~3 个、请求间隔 ≥10 秒（详见 playbook 第五节）。
 * ============================================================ */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');

/* 同步睡眠：Atomics.wait 是 Node 里不引依赖的标准做法（本工具多处是同步流程） */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* ---------- 无头浏览器兜底：本机 Edge（与 Chrome 同为 Chromium，参数兼容） ---------- */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p)) || EDGE_CANDIDATES[0];

function curl(args, timeoutSec) {
  try {
    return execFileSync('curl.exe', ['-s', '--max-time', String(timeoutSec || 45)].concat(args),
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) { return (e.stdout || '') + ''; }
}

/* UA 纪律（实测教训，勿合并两套 UA）：搜索引擎与直连抓页要带浏览器 UA；
   **Jina 恰恰相反**——带浏览器 UA 会被判为爬虫并返回 Cloudflare 挑战页
   （实测 5856 字符垃圾 vs 不带 UA 的 2044 字符正文）。 */
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
function curlSearch(args, timeoutSec) { return curl(['-A', UA_BROWSER].concat(args), timeoutSec); }

/* ---------- 限流识别 ----------
   这是本工具最重要的一段：**「被限流/连不通」与「确实没有」必须分开**。
   搜索引擎与 Jina 都会在请求过密或网络受限时空响应；若把空响应当成「查不到」，
   就会产出**假的「未找到」结论**——比不跑更糟，因为它看起来像已核查。
   所以：搜索走多引擎降级链，全部失败时返回带标记的结果，
   让调用方知道「这次没查到 ≠ 没有」。 */
const RATE_LIMITED = '[RATE-LIMITED]';
const FETCH_FAILED = '[FETCH-FAILED]';
const BLOCK_PAGE = /Just a moment|Attention Required|Enable JavaScript and cookies|cf-browser-verification|安全验证|访问验证|请稍候|正在验证|人机验证/i;

function isUsablePage(text) {
  if (!text || text.length < 400) return false;
  return !BLOCK_PAGE.test(text.slice(0, 4000));
}

/* ---------- 搜索（多引擎降级链） ---------- */

/* 必应中国：大陆网络实测可用（Brave/DDG 直连超时）。解析 b_algo 自然结果；
   Bing 跳转链形如 /ck/a?...&u=a1<base64url>，能解则解出真实 URL。
   注意：查询词必须在这里 encodeURIComponent 后拼进完整 URL——
   经 --data-urlencode 传非 ASCII 参数会在 Windows 控制台代码页被搞乱
   （实测搜索词变成无关结果），URL 整体传递不受影响。 */
function bingCN(query) {
  const html = curlSearch(['https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&mkt=zh-CN']);
  const out = [];
  const seen = {};
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let u = m[1];
    const ck = u.match(/bing\.com\/ck\/a\?[\s\S]*?[&?]u=a1([A-Za-z0-9_-]+)/);
    if (ck) {
      try { u = Buffer.from(ck[1], 'base64url').toString('utf8'); } catch (e) { /* 解不出就用跳转链 */ }
    }
    if (!/^https?:\/\//.test(u) || seen[u]) continue;
    seen[u] = 1;
    out.push({ url: u, title: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/* Brave（需国际网络；被限流时返回 429 或过短页面，识别后交降级链处理） */
function brave(query) {
  const url = 'https://search.brave.com/search?q=' + encodeURIComponent(query);
  const waits = [0, 15000, 45000];
  let html = '';
  for (let i = 0; i < waits.length; i++) {
    sleepSync(waits[i]);
    html = curlSearch([url]);
    const limited = !html || html.length < 2000 || /Too Many Requests|429/.test(html.slice(0, 1500));
    if (!limited) break;
    if (i < waits.length - 1) process.stderr.write(`  [brave] 第 ${i + 1} 次被限流或空响应，退避 ${waits[i + 1] / 1000}s\n`);
  }
  if (!html || html.length < 2000) {
    const e = new Error('brave 搜索未取到结果（可能被限流或网络不可达）');
    e.rateLimited = true;
    throw e;
  }
  const out = [];
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const u = m[1];
    if (/brave\.com|w3\.org|schema\.org|gstatic|google\.|search\.brave/.test(u)) continue;
    if (out.some(o => o.url === u)) continue;
    out.push({ url: u, title: '' });
  }
  return out;
}

/* DDG Lite（轻量；同样需国际网络） */
function ddgLite(query) {
  const html = curlSearch(['-G', '--data-urlencode', 'q=' + query, 'https://lite.duckduckgo.com/lite/']);
  const out = [];
  for (const m of html.matchAll(/uddg=([^&"]+)/g)) {
    try {
      const u = decodeURIComponent(m[1]);
      if (!out.some(o => o.url === u)) out.push({ url: u, title: '' });
    } catch (e) { /* 忽略 */ }
  }
  return out;
}

/** 搜索降级链：必应中国 → Brave → DDG Lite。
 *  返回 { results, engines }；全部失败返回 { results: [], engines, failed: true }。
 *  **调用方必须区分「全失败」与「真的没有结果」**——前者不得写「未找到」。 */
function searchWeb(query) {
  const chain = [['bing-cn', bingCN], ['brave', brave], ['ddg-lite', ddgLite]];
  const tried = [];
  for (const [name, fn] of chain) {
    let res = [];
    try { res = fn(query) || []; } catch (e) { /* 引擎级失败进下一个 */ }
    if (res.length) return { results: res, engines: tried.concat([name + '✓']), failed: false };
    tried.push(name + '✗');
  }
  return { results: [], engines: tried, failed: true };
}

/* ---------- 抓页（直连 → Jina → Edge 三段降级） ---------- */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
/* 带退避的重试（限流退避 0→12→30 秒） */
function withBackoff(label, fn) {
  const waits = [0, 12000, 30000];
  for (let i = 0; i < waits.length; i++) {
    sleepSync(waits[i]);
    const r = fn();
    if (r && r.length > 400 && !BLOCK_PAGE.test(r.slice(0, 4000))) return r;
    if (i < waits.length - 1) process.stderr.write(`  [${label}] 第 ${i + 1} 次未取到内容，退避 ${waits[i + 1] / 1000}s 后重试\n`);
  }
  return '';
}
/* 本机 Edge 无头：直连与 Jina 都抓不到时用（SPA/强反爬站），返回渲染后正文 */
function edgeDom(url, budgetMs) {
  try {
    return execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--lang=zh-CN', '--virtual-time-budget=' + (budgetMs || 10000), '--dump-dom', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { return (e.stdout || '') + ''; }
}
function fetchPage(url, timeoutSec) {
  /* ① 直连（国内政府站实测 200 且最快；返回的原始 HTML 转文本后必须过
     可用性检查——只按长度判断会把挑战页当正文）；Jina 被限流时会出现
     Cloudflare「Just a moment...」，同样靠该检查拦截。 */
  const direct = withBackoff('direct', () => curlSearch([url], timeoutSec || 45));
  if (direct) {
    const text = htmlToText(direct);
    if (isUsablePage(text) && text.length > 800) return '[via direct]\n' + text;
  }
  /* ② Jina Reader（政府页面正文完整；注意它不吃浏览器 UA，见 UA 纪律） */
  const viaJina = withBackoff('jina', () => curl(['https://r.jina.ai/' + url], timeoutSec || 60));
  if (viaJina) return viaJina;
  /* ③ Edge 无头渲染 */
  for (const budget of [15000, 25000]) {
    const dom = edgeDom(url, budget);
    if (dom && dom.length > 1000) {
      const text = htmlToText(dom);
      if (isUsablePage(text)) return '[via edge-headless]\n' + text;
    }
  }
  return FETCH_FAILED + ' ' + url + '\n（直连、Jina 与本机 Edge 均未取到可用内容：可能是限流、站点反爬或页面不存在。'
    + '**这不等于「该数据不存在」**，请稍后重试或换来源。）';
}

/* ---------- 事实抽取（只做候选提示，不做判断） ----------
   数值候选：取 ≥1000 的数字，排除「2025年」这类年份——
   政策原文常写「不超过市统计局公布的2025年在岗职工月人均工资的3倍（42400元）」，
   按位置硬匹配会把年份当上限。改为「在同一句里取最大/最小」更稳。 */
function numbersIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(/([\d][\d,]{3,})(?!\s*年)/g)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(v) && v >= 1000 && v <= 200000) out.push(v);
  }
  return out;
}
function extractFacts(text) {
  const sentences = text.split(/[。；;\n]/);
  /* 优先选「同时含数字」的句子：政策文件里常有定义性表述
     （如「缴费工资高于上限的，以上限为缴费工资基数」）先出现且不含数值，
     只按关键词取第一句会拿到定义而不是标准。 */
  const pick = (kw) => sentences.find(s => kw.test(s) && numbersIn(s).length)
    || sentences.find(s => kw.test(s)) || '';
  const upper = pick(/上限|最高/), lower = pick(/下限|最低/);
  const uNums = numbersIn(upper), lNums = numbersIn(lower);
  return {
    下限: lNums.length ? String(Math.min.apply(null, lNums)) : null,
    上限: uNums.length ? String(Math.max.apply(null, uNums)) : null,
    上下限句: (upper || lower || '').trim().slice(0, 200),
    区间: (text.match(/[\d,]{4,}(?:\.\d+)?\s*[~～至\-—]\s*[\d,]{4,}(?:\.\d+)?/g) || []).slice(0, 6),
    文号: (text.match(/[\u4e00-\u9fa5]{0,8}[〔\[]\s*20\d{2}\s*[〕\]]\s*\d+\s*号/g) || []).slice(0, 6),
    费率: (text.match(/(?:单位|个人)[^\d%]{0,8}(\d+(?:\.\d+)?)\s*%/g) || []).slice(0, 8),
    关键词: {
      缴费基数: /缴费基数/.test(text), 上下限: /上下限/.test(text),
      /* 限定语标记：命中时候选数值必须人工确认现行性（四关第②关） */
      暂按: /暂按|暂执行|暂不调整/.test(text), 待发布: /待.{0,10}(发布|确定|公布)/.test(text),
      调整前: /调整前|原标准/.test(text),
      公积金: /公积金/.test(text), 医保: /医保|医疗保险/.test(text),
    },
  };
}

/* ---------- CLI（仅直接运行时执行，require 本模块只取函数不打印用法） ---------- */
const [, , cmd, ...rest] = process.argv;
const arg = rest.join(' ');

(async () => {
  if (require.main !== module) return;
  if (cmd === 'search' || cmd === 'gov') {
    if (!arg) { console.log('用法: node tools/policy-research.js search "查询词"'); process.exit(1); }
    const { results, engines, failed } = searchWeb(arg);
    if (failed) {
      console.log('⚠ ' + RATE_LIMITED + ' 全部搜索引擎未取到结果（' + engines.join(' ') + '），可能被限流或网络不可达');
      console.log('  —— 这不是「没有结果」。请稍后重试、减少并发，或直接从已知政府站点检索。');
      process.exit(2);
    }
    console.log(`搜索（${engines.join('，')}）结果 ${results.length} 条：`);
    results.slice(0, 12).forEach((r, i) => console.log(`  ${i + 1}. ${r.url}${r.title ? '  ' + r.title.slice(0, 40) : ''}`));
    let gov = results.filter(r => /\.gov\.cn/.test(r.url));
    console.log(`\n政府域名 ${gov.length} 条：`);
    gov.slice(0, 10).forEach(r => console.log('  ' + r.url));
    if (cmd === 'gov') return;
    if (gov.length) {
      console.log('\n抓取第一个政府页面：');
      const body = fetchPage(gov[0].url);
      console.log(JSON.stringify(extractFacts(body), null, 2));
    }
  } else if (cmd === 'fetch' || cmd === 'facts') {
    if (!arg) { console.log('用法: node tools/policy-research.js fetch <url>'); process.exit(1); }
    const body = fetchPage(arg);
    if (cmd === 'fetch') { console.log(body); return; }
    console.log(JSON.stringify(extractFacts(body), null, 2));
    const i = body.search(/缴费基数|公积金基数|单位费率/);
    if (i >= 0) console.log('\n上下文：\n' + body.slice(Math.max(0, i - 200), i + 600).replace(/\s+/g, ' '));
  } else {
    console.log('用法:');
    console.log('  node tools/policy-research.js search "查询词"   # 搜索并抓第一个政府页面');
    console.log('  node tools/policy-research.js gov    "查询词"   # 只列政府域名结果');
    console.log('  node tools/policy-research.js fetch  <url>      # 抓正文');
    console.log('  node tools/policy-research.js facts  <url>      # 抓正文并抽取基数/文号/费率候选');
    console.log('\n数值采纳前必须过四关复核，见 docs/policy-verification-playbook.md');
  }
})();

module.exports = { searchWeb, brave, bingCN, ddgLite, fetchPage, extractFacts, edgeDom, htmlToText, curl, isUsablePage, numbersIn };
