#!/usr/bin/env node
/* ============================================================
 * tools/build-policy-seed.js — 政策种子生成脚本（零依赖）
 * 职责：读取数据源 tax-policy-data.json（唯一维护入口），
 *       校验结构后生成 file:// 场景兜底的 tax-policy-data.js。
 * 运行：node tools/build-policy-seed.js          生成/更新种子 JS
 *       node tools/build-policy-seed.js --check  仅校验，不写文件（CI/自检用）
 * 维护约定：政策数据一律改 JSON 后跑本脚本；不要直接编辑生成的 JS。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'tax-policy-data.json');
const JS_PATH = path.join(ROOT, 'tax-policy-data.js');

const ITEM_FIELDS = ['personal', 'lower', 'upper', 'employer', 'rates'];

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

/** 结构校验：version + 城市表；每个年度 5 险种字段齐全、比例在合理区间 */
function validate(data) {
  if (!data || typeof data !== 'object') fail('JSON 根必须是对象');
  if (typeof data.version !== 'string' || !/^\d{4}\.\d{2}$/.test(data.version)) {
    fail('version 缺失或格式不符（应为 "YYYY.MM"，如 "2026.09"）');
  }
  const cities = data.cities;
  if (!cities || typeof cities !== 'object' || !Object.keys(cities).length) fail('cities 缺失或为空');
  Object.entries(cities).forEach(([ck, city]) => {
    if (!city || typeof city.name !== 'string' || !city.years || typeof city.years !== 'object') {
      fail(`城市 ${ck} 缺少 name / years`);
    }
    Object.entries(city.years).forEach(([yk, rec]) => {
      if (!rec || !rec.items || typeof rec.items !== 'object') fail(`城市 ${ck} 年度 ${yk} 缺少 items`);
      if (!Array.isArray(rec.effective) || rec.effective.length !== 2) {
        fail(`城市 ${ck} 年度 ${yk} 缺少生效月区间 effective: [起, 止]`);
      }
      Object.entries(rec.items).forEach(([ik, it]) => {
        if (!it || typeof it.personal !== 'number') fail(`城市 ${ck} 年度 ${yk} 险种 ${ik} 缺少 personal 比例`);
        ITEM_FIELDS.forEach(f => {
          const v = it[f];
          if (v === undefined) return; // employer/rates 可选
          if (f === 'rates') {
            if (!Array.isArray(v) || !v.every(n => n > 0 && n <= 1)) fail(`城市 ${ck} 年度 ${yk} ${ik}.rates 应为 0~1 小数数组`);
          } else if (v !== null && typeof v !== 'number') {
            fail(`城市 ${ck} 年度 ${yk} ${ik}.${f} 应为数字或 null`);
          }
        });
      });
    });
  });
  return data;
}

/* 生成 JS：键序与 JSON 一致；紧凑序列化——种子是同步加载的机器生成文件，
 * 337 城全量后 pretty 打印会翻倍体积（实测 1.26MB→0.6MB），可读性以 JSON 为准 */
function buildSeedJs(data) {
  const citiesJs = JSON.stringify(data.cities);
  return `/* ============================================================
 * tax-policy-data.js — 城市社保公积金政策库 · 出厂种子（自动生成，勿直接编辑）
 * ------------------------------------------------------------
 * 本文件由 tax-policy-data.json 生成（node tools/build-policy-seed.js）。
 * 修改政策数据请编辑 JSON 后重新生成；网上访问（GitHub Pages 等）以
 * JSON 为准自动更新，本 JS 仅供 file:// 双击离线打开时兜底加载。
 *
 * 结构：version 版本号（YYYY.MM）+ 城市 → 年度（生效月区间）→
 *   险种（养老/医疗(含生育)/失业/工伤/公积金）：personal 个人比例、
 *   employer 单位比例、lower/upper 基数上下限（null 不限）、
 *   公积金额外 rates 可选比例档。pending: true 表示数值待核对。
 *
 * 数据说明与更新流程见 README「政策数据维护」；所有数值均为参考值，
 * 请以当地社保部门公布为准。版本：${data.version}
 * ============================================================ */

window.CITY_POLICY_LIBRARY_VERSION = '${data.version}';
window.CITY_POLICY_LIBRARY_DATA = ${citiesJs};
`;
}

const data = validate(JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8')));

if (process.argv.includes('--check')) {
  // 校验模式：额外确认生成的 JS 与 JSON 数据语义一致（防止手改 JS 跑偏）
  globalThis.window = globalThis;
  require('../tax-policy-data.js');
  const seed = window.CITY_POLICY_LIBRARY_DATA;
  const same = JSON.stringify(seed) === JSON.stringify(data.cities);
  if (!same) fail('tax-policy-data.js 与 tax-policy-data.json 不一致——请运行 node tools/build-policy-seed.js 重新生成');
  const jsVersion = window.CITY_POLICY_LIBRARY_VERSION;
  if (jsVersion !== data.version) fail(`种子 JS 版本 ${jsVersion} 与 JSON 版本 ${data.version} 不一致`);
  console.log(`✔ 校验通过：${Object.keys(data.cities).length} 个城市，版本 ${data.version}，种子 JS 与 JSON 一致`);
  return;
}

fs.writeFileSync(JS_PATH, buildSeedJs(data), 'utf-8');
console.log(`✔ 已生成 tax-policy-data.js（${Object.keys(data.cities).length} 个城市，版本 ${data.version}，${fs.statSync(JS_PATH).size} bytes）`);
