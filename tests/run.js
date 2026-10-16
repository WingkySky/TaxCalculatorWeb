/* ============================================================
 * tests/run.js — 零依赖 Node 回归门
 * 职责：无浏览器环境按 index.html 顺序加载源文件（子集，不含
 *       page-policy/page-rules/app），执行 TaxTest.runAll() 全部自检
 *       （计税与政策库 + 批量计税流水线 + 导出器组装 + 导出样式规格），任一失败退出码 1。
 * 运行：node tests/run.js（Git Bash / PowerShell 通用）。
 * 维护约定：js/ 源码加载期用到新 DOM API 时在此补桩吸收，不改源码。
 * ============================================================ */
'use strict';

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

/* 按序字面量加载（顺序敏感：数据 → 引擎 → 页面 → 自检；路径相对 tests/） */
require('../tax-policy-data.js');
require('../js/state.js');
require('../js/utils.js');
require('../js/tax-engine.js');
require('../js/policy-library.js');
require('../js/city-picker.js');
require('../js/social-insurance.js');
require('../js/export-style.js');
require('../js/exporter.js');
require('../js/ui.js');
require('../js/page-shared.js');
require('../js/annual-engine.js');
require('../js/page-multi.js');
require('../js/batch-parse.js');
require('../js/batch-calc.js');
require('../js/batch-source.js');
require('../js/batch-view.js');
require('../js/batch-export.js');
require('../js/page-batch.js');
require('../js/page-params.js');
require('../js/page-rules.js');
require('../js/page-annual.js');
require('../js/page-share.js');
require('../js/print-report.js');
require('../js/self-tests.js');

const r = window.TaxTest.runAll();
if (r.failed.length) {
  console.error(`🧪 回归门失败：${r.passed}/${r.total}（明细见上方各套件输出）`);
  process.exit(1);
}
console.log(`🧪 回归门全绿：${r.passed}/${r.total}`);
