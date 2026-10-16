/* ============================================================
 * tests/run.js — 零依赖 Node 回归门
 * 职责：无浏览器环境按 index.html 顺序加载源文件（子集，不含
 *       page-policy/page-rules/app），执行 TaxTest.runAll() 全部自检
 *       （计税与政策库 + 批量计税流水线 + 导出器组装 + 导出样式规格），任一失败退出码 1。
 * 运行：node tests/run.js（Git Bash / PowerShell 通用）。
 * 维护约定：js/ 源码加载期用到新 DOM API 时在此补桩吸收，不改源码。
 * ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

globalThis.window = globalThis;

/** 宽松 element 桩：吸收 page-batch 等模块顶层的事件绑定与 DOM 属性写入 */
function stubEl() {
  return {
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {}, value: '', checked: false, files: [],
    innerHTML: '', textContent: '', appendChild() {},
    querySelector: () => null, querySelectorAll: () => [],
    add() {}, remove() {}, click() {}
  };
}
globalThis.document = {
  getElementById: () => stubEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => stubEl(),
  addEventListener() {},
  body: stubEl()
};
globalThis.location = { hash: '', href: '' };
/* ui.js 顶层绑定 resize/scroll 监听（window 上），Node 无此 API，补桩吸收 */
globalThis.addEventListener = globalThis.addEventListener || function () {};

[
  'tax-policy-data.js',
  'js/state.js', 'js/utils.js', 'js/tax-engine.js', 'js/policy-library.js', 'js/city-picker.js',
  'js/social-insurance.js', 'js/export-style.js', 'js/exporter.js', 'js/ui.js', 'js/page-shared.js',
  'js/annual-engine.js',
  'js/page-multi.js',
  'js/batch-parse.js', 'js/batch-calc.js', 'js/batch-source.js', 'js/batch-view.js', 'js/batch-export.js',
  'js/page-batch.js', 'js/page-params.js', 'js/page-rules.js', 'js/page-annual.js', 'js/page-share.js',
  'js/print-report.js', 'js/self-tests.js'
].forEach(f => require(path.join(ROOT, f)));

const r = window.TaxTest.runAll();
if (r.failed.length) {
  console.error(`🧪 回归门失败：${r.passed}/${r.total}（明细见上方各套件输出）`);
  process.exit(1);
}
console.log(`🧪 回归门全绿：${r.passed}/${r.total}`);
