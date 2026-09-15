/* ============================================================
 * exporter.js — Exporter 导出器
 * 职责：SheetJS 按需加载（ensureXLSX）、批量模板下载、
 *       工资薪金 Excel 公式明细网格构建（buildSalaryFormulaGrid）、多月/批量公式版导出；
 *       带样式导出（ensureExcelJS + gridToStyledWorkbook）：标题横幅、两级分组表头、
 *       语义色、斑马纹、冻结筛选、按人年度汇总 sheet；失败回退 SheetJS 纯净版。
 * 对外接口：window.Exporter。依赖：TaxEngine、PolicyLib、SocialIns、TaxState、TaxUtils、ExportStyle。
 * ============================================================ */
(function () {
'use strict';
  const { round2, downloadFile } = TaxUtils;
  const { resolvePolicyMemo } = PolicyLib;
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** SheetJS 加载链：内存已有 → 本地同目录 xlsx.full.min.js（file:// 离线可用）→ CDN 回退 → 提示失败。
 *  本地与 CDN 钉死同一版本（0.20.1），避免两源行为差异。 */
function ensureXLSX(cb) {
  if (typeof XLSX !== 'undefined') return cb();
  const load = (src, onfail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => cb();
    s.onerror = () => onfail();
    document.head.appendChild(s);
  };
  load('xlsx.full.min.js', () => load('https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js',
    () => alert('SheetJS 库加载失败：未找到本地 xlsx.full.min.js 且网络不可达。请将该文件与页面放在同一目录，或联网后重试')));
}

/** 工作簿 → 二进制 → 统一走 downloadFile：安全上下文弹「另存为」选位置，file:// 直接下载（与 CSV 行为一致） */
function saveWorkbook(wb, filename) {
  const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return downloadFile(data, filename, XLSX_MIME);
}

/** ExcelJS 加载链（带样式导出用）：内存已有 → 本地同目录 exceljs.min.js（file:// 离线可用）→
 *  jsdelivr 钉版 CDN（4.4.0）回退。与 ensureXLSX 同模式；加载失败走 onfail（导出层回退基础版）。 */
function ensureExcelJS(cb, onfail) {
  if (typeof ExcelJS !== 'undefined') return cb();
  const fail = onfail || (() => alert('ExcelJS 库加载失败：未找到本地 exceljs.min.js 且网络不可达。请将该文件与页面放在同一目录，或联网后重试'));
  const load = (src, onerr) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = cb;
    s.onerror = onerr;
    document.head.appendChild(s);
  };
  load('exceljs.min.js', () => load('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', fail));
}

/** 批量模板下载：按所得类型给出对应的 CSV 样例 */
function downloadTemplate() {
  if (incomeType === 'salary') {
    const csv = '姓名,身份证号,月份,应发工资,城市,社保基数,公积金基数,公积金比例,专项附加扣除,年终奖\n张三,110101199001011234,2026-01,10000,广州,10000,10000,5,1000,\n张三,110101199001011234,2026-02,10000,广州,10000,10000,5,1000,36000\n李四,110101199202022345,2026-01,8000,深圳,8000,,12,,\n王五,110101199303033456,2026-01,9000,,,,,800,';
    downloadFile(csv, '工资薪金个税计算模板.csv', 'text/csv');
  } else {
    const csv = '月份,金额,姓名,身份证号,电话,银行卡号\n2024年11月,15000,张三,110101199001011234,13800138000,6225880112345678\n2024/12,20000,张三,110101199001011234,13800138000,6225880112345678\n2025-01,18000,张三,110101199001011234,13800138000,6225880112345678\n2025-02,22000,张三,110101199001011234,13800138000,6225880112345678\n2024.11,8000,李四,,,6225880198765432\n2024.12,12000,李四,,,6225880198765432\n2025-01,9500,李四,,,6225880198765432';
    downloadFile(csv, '个税计算模板.csv', 'text/csv');
  }
}

// ==================== Excel 公式明细导出（工资薪金） ====================

/* 列下标 → Excel 列字母（0→A, 26→AA） */
function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/* 年度累计税率/速算扣除嵌套 IF（ref=累计应纳税所得额单元格），与 BRACKETS 一致 */
function fxAnnualRate(ref) {
  return `IF(${ref}<=36000,0.03,IF(${ref}<=144000,0.1,IF(${ref}<=300000,0.2,IF(${ref}<=420000,0.25,IF(${ref}<=660000,0.3,IF(${ref}<=960000,0.35,0.45))))))`;
}
function fxAnnualQuick(ref) {
  return `IF(${ref}<=36000,0,IF(${ref}<=144000,2520,IF(${ref}<=300000,16920,IF(${ref}<=420000,31920,IF(${ref}<=660000,52920,IF(${ref}<=960000,85920,181920))))))`;
}
/* 年终奖 ÷12 月度税率/速算扣除嵌套 IF（ref=奖金单元格），与 MONTHLY_BRACKETS 一致 */
function fxBonusRate(ref) {
  return `IF(${ref}/12<=3000,0.03,IF(${ref}/12<=12000,0.1,IF(${ref}/12<=25000,0.2,IF(${ref}/12<=35000,0.25,IF(${ref}/12<=55000,0.3,IF(${ref}/12<=80000,0.35,0.45))))))`;
}
function fxBonusQuick(ref) {
  return `IF(${ref}/12<=3000,0,IF(${ref}/12<=12000,210,IF(${ref}/12<=25000,1410,IF(${ref}/12<=35000,2660,IF(${ref}/12<=55000,4410,IF(${ref}/12<=80000,7160,15160))))))`;
}
/* 险种金额公式：ROUND(clamp(基数,上下限)×比例, digits)，上下限内联可溯源 */
function fxSiAmount(baseRef, item, rateExpr, digits) {
  let clamped = baseRef;
  if (item && item.upper != null) clamped = `MIN(${clamped},${item.upper})`;
  if (item && item.lower != null) clamped = `MAX(${clamped},${item.lower})`;
  return `ROUND(${clamped}*${rateExpr},${digits})`;
}

/**
 * 工资薪金「公式明细」网格构建（多月累计与批量共用）。
 * 常量列只有原始输入（应发、基数、比例、专项附加），派生值全部是 Excel 公式；
 * 每格同时写公式 f 与缓存值 v（页面已算出的结果）：打开即显示数值、点开可见公式来源、改输入自动重算。
 * @param {Array} rows 计算结果行（须含 _siDetail/_cumSI/_cumExtra/_isBonus 等）
 * @param {object} opts { idCard, phone, bankCard, nameOf, chainKey, cityOf, cityLabel, noteExtra,
 *                        dataStartRow } dataStartRow：数据区起始 Excel 行，默认 2（首行表头）；
 *                        带样式版传 5（标题/元信息/分组/列名共 4 行表头区），公式行号随动。
 * @returns {{headers:string[], rows:Array<Array>, maxRow:number, cols:Object, rowsMeta:Array}}
 *          cols：列 key → 下标映射（样式规格与汇总公式引用用）；rowsMeta：[{bonus, chainStart}] 行类型
 */
function buildSalaryFormulaGrid(rows, opts) {
  opts = opts || {};
  const dataStartRow = Math.max(2, opts.dataStartRow || 2);
  const showId = !!opts.idCard, showPhone = !!opts.phone, showBank = !!opts.bankCard;
  const headers = ['姓名'];
  if (showId) headers.push('身份证号');
  if (showPhone) headers.push('电话');
  if (showBank) headers.push('银行卡号');
  headers.push(
    '月份', '城市', '项目', '应发工资(税前)', '社保基数', '公积金基数', '公积金比例',
    '养老(个人)', '医疗(个人)', '失业(个人)', '公积金(个人)', '个人合计',
    '养老(单位)', '医疗(单位)', '失业(单位)', '工伤(单位)', '公积金(单位)', '单位合计',
    '专项附加扣除', '当月减除费用', '累计应发', '累计社保公积金', '累计专项附加', '累计减除费用',
    '累计应纳税所得额', '适用税率', '速算扣除数', '累计应纳税额', '累计已预扣', '本期预扣税额',
    '实发工资', '企业用工总成本', '政策/备注'
  );
  let c = 0;
  const C = { name: c++ };
  if (showId) C.idCard = c++;
  if (showPhone) C.phone = c++;
  if (showBank) C.bankCard = c++;
  C.month = c++; C.city = c++; C.project = c++; C.amount = c++; C.socialBase = c++; C.fundBase = c++; C.fundRate = c++;
  C.pension = c++; C.medical = c++; C.unemployment = c++; C.fund = c++; C.siTotal = c++;
  C.erPension = c++; C.erMedical = c++; C.erUnemployment = c++; C.erInjury = c++; C.erFund = c++; C.erTotal = c++;
  C.extra = c++; C.deduct = c++; C.cumAmount = c++; C.cumSI = c++; C.cumExtra = c++; C.cumDeduct = c++;
  C.cumTaxable = c++; C.rate = c++; C.quick = c++; C.cumDue = c++; C.cumPaid = c++; C.curTax = c++;
  C.postTax = c++; C.cost = c++; C.note = c++;
  const col = (idx) => colLetter(idx);

  const out = [];
  const rowsMeta = [];
  let prevRow = null;
  let prevChain = null;
  rows.forEach(r => {
    const er = out.length + dataStartRow; // 当前行 Excel 行号（表头区占 dataStartRow-1 行）
    const cityKey = opts.cityOf ? opts.cityOf(r) : salaryParams.cityId;
    const items = resolvePolicyMemo(cityKey, r.month).items || {};
    const si = r._siDetail || null;
    const isBonusSep = !!r._isBonus && r._bonusSeparate;
    const chainKey = opts.chainKey ? opts.chainKey(r) : '';
    const chainStart = !prevRow || chainKey !== prevChain;
    rowsMeta.push({ bonus: isBonusSep, chainStart: chainStart });
    const sameMonth = !chainStart && prevRow && r.month === prevRow.month;
    const cell = (v, f) => (f ? { v: v, f: f } : { v: v });
    const num0 = (v) => (typeof v === 'number' && isFinite(v) ? round2(v) : 0);
    const cells = new Array(headers.length).fill(null);

    cells[C.name] = { v: opts.nameOf ? opts.nameOf(r) : (r.person || '本人') };
    if (showId) cells[C.idCard] = { v: r.idCard || '' };
    if (showPhone) cells[C.phone] = { v: r.phone || '' };
    if (showBank) cells[C.bankCard] = { v: r.bankCard || '' };
    cells[C.month] = { v: r.month || '' };
    cells[C.city] = { v: (opts.cityLabel ? opts.cityLabel(r) : (r.cityName || '')) };
    cells[C.project] = { v: r._isBonus ? '年终奖' : '工资' };
    cells[C.amount] = { v: num0(r.preTax) };

    /* 基数与比例（原始输入常量；公积金基数跟随社保时用公式引用以体现口径） */
    if (si && !isBonusSep) {
      cells[C.socialBase] = { v: num0(si.socialBaseRaw) };
      if (num0(si.fundBaseRaw) === num0(si.socialBaseRaw)) {
        cells[C.fundBase] = cell(num0(si.fundBaseRaw), `${col(C.socialBase)}${er}`);
      } else {
        cells[C.fundBase] = { v: num0(si.fundBaseRaw) };
      }
      cells[C.fundRate] = { v: num0(si.fundRateUsed) };
    } else {
      cells[C.socialBase] = { v: 0 };
      cells[C.fundBase] = { v: 0 };
      cells[C.fundRate] = { v: 0 };
    }

    /* 社保公积金：个人部分（公积金按 ÷1 取整到元）与单位部分（含工伤） */
    if (si && !isBonusSep) {
      const baseRef = `${col(C.socialBase)}${er}`;
      const fundBaseRef = `${col(C.fundBase)}${er}`;
      const fundRateRef = `${col(C.fundRate)}${er}`;
      const pensionItem = items.pension || { personal: 0, lower: null, upper: null };
      const medicalItem = items.medical || pensionItem;
      const unemploymentItem = items.unemployment || pensionItem;
      const fundItem = items.fund || pensionItem;
      const injuryItem = items.injury || { personal: 0, lower: null, upper: null };
      const erRate = (k) => (items[k] && items[k].employer != null) ? items[k].employer : 0;
      cells[C.pension] = cell(si.pension, fxSiAmount(baseRef, pensionItem, pensionItem.personal || 0, 2));
      cells[C.medical] = cell(si.medical, fxSiAmount(baseRef, medicalItem, medicalItem.personal || 0, 2));
      cells[C.unemployment] = cell(si.unemployment, fxSiAmount(baseRef, unemploymentItem, unemploymentItem.personal || 0, 2));
      cells[C.fund] = cell(si.fund, fxSiAmount(fundBaseRef, fundItem, fundRateRef, 0));
      cells[C.siTotal] = cell(si.total, `SUM(${col(C.pension)}${er}:${col(C.fund)}${er})`);
      cells[C.erPension] = cell(si.employer.pension, fxSiAmount(baseRef, pensionItem, erRate('pension'), 2));
      cells[C.erMedical] = cell(si.employer.medical, fxSiAmount(baseRef, medicalItem, erRate('medical'), 2));
      cells[C.erUnemployment] = cell(si.employer.unemployment, fxSiAmount(baseRef, unemploymentItem, erRate('unemployment'), 2));
      cells[C.erInjury] = cell(si.employer.injury, fxSiAmount(baseRef, injuryItem, erRate('injury'), 2));
      const erFundRate = (items.fund && items.fund.employer != null) ? items.fund.employer : fundRateRef;
      cells[C.erFund] = cell(si.employer.fund, fxSiAmount(fundBaseRef, fundItem, erFundRate, 0));
      cells[C.erTotal] = cell(si.employer.total, `SUM(${col(C.erPension)}${er}:${col(C.erFund)}${er})`);
    } else {
      [C.pension, C.medical, C.unemployment, C.fund, C.siTotal,
        C.erPension, C.erMedical, C.erUnemployment, C.erInjury, C.erFund, C.erTotal].forEach(k => { cells[k] = { v: 0 }; });
    }

    /* 专项附加（原始输入）与减除费用 */
    cells[C.extra] = { v: num0(r.extraDeduction) };
    const deductFormula = `IF(${col(C.month)}${er}=${col(C.month)}${er - 1},0,5000)`;
    if (isBonusSep) {
      /* 年终奖单独计税行：不进入累计链 */
      cells[C.deduct] = null;
      cells[C.cumAmount] = null;
      cells[C.cumSI] = null;
      cells[C.cumExtra] = null;
      cells[C.cumDeduct] = null;
      cells[C.cumTaxable] = null;
      cells[C.rate] = cell(r.rate, fxBonusRate(`${col(C.amount)}${er}`));
      cells[C.quick] = cell(r.quick, fxBonusQuick(`${col(C.amount)}${er}`));
      cells[C.cumDue] = null;
      cells[C.cumPaid] = null;
      cells[C.curTax] = cell(r.currentTax, `ROUND(MAX(0,${col(C.amount)}${er}*${col(C.rate)}${er}-${col(C.quick)}${er}),2)`);
      cells[C.postTax] = cell(r.postTax, `${col(C.amount)}${er}-${col(C.curTax)}${er}`);
    } else {
      cells[C.deduct] = chainStart
        ? cell(5000)
        : cell(sameMonth ? 0 : 5000, deductFormula);
      cells[C.cumAmount] = chainStart
        ? cell(r.cumIncome, `${col(C.amount)}${er}`)
        : cell(r.cumIncome, `${col(C.cumAmount)}${er - 1}+${col(C.amount)}${er}`);
      cells[C.cumSI] = chainStart
        ? cell(r._cumSI || 0, `${col(C.siTotal)}${er}`)
        : cell(r._cumSI || 0, sameMonth
          ? `${col(C.cumSI)}${er - 1}`
          : `${col(C.cumSI)}${er - 1}+${col(C.siTotal)}${er}`);
      cells[C.cumExtra] = chainStart
        ? cell(r._cumExtra || 0, `${col(C.extra)}${er}`)
        : cell(r._cumExtra || 0, sameMonth
          ? `${col(C.cumExtra)}${er - 1}`
          : `${col(C.cumExtra)}${er - 1}+${col(C.extra)}${er}`);
      cells[C.cumDeduct] = chainStart
        ? cell(r.cumDeduction || 0, `${col(C.deduct)}${er}`)
        : cell(r.cumDeduction || 0, sameMonth
          ? `${col(C.cumDeduct)}${er - 1}`
          : `${col(C.cumDeduct)}${er - 1}+${col(C.deduct)}${er}`);
      cells[C.cumTaxable] = cell(r.taxableIncome || 0,
        `MAX(0,${col(C.cumAmount)}${er}-${col(C.cumSI)}${er}-${col(C.cumExtra)}${er}-${col(C.cumDeduct)}${er})`);
      cells[C.rate] = cell(r.rate, fxAnnualRate(`${col(C.cumTaxable)}${er}`));
      cells[C.quick] = cell(r.quick, fxAnnualQuick(`${col(C.cumTaxable)}${er}`));
      cells[C.cumDue] = cell(r.cumTaxDue || 0,
        `ROUND(MAX(0,ROUND(${col(C.cumTaxable)}${er}*${col(C.rate)}${er}-${col(C.quick)}${er},2)),2)`);
      cells[C.cumPaid] = chainStart
        ? { v: 0 }
        : cell(num0((prevRow.cumTaxDue || 0) - (prevRow.currentTax || 0)),
          `${col(C.cumPaid)}${er - 1}+${col(C.curTax)}${er - 1}`);
      cells[C.curTax] = cell(r.currentTax || 0, `MAX(0,${col(C.cumDue)}${er}-${col(C.cumPaid)}${er})`);
      cells[C.postTax] = cell(r.postTax, `${col(C.amount)}${er}-${col(C.siTotal)}${er}-${col(C.curTax)}${er}`);
    }
    cells[C.cost] = cell(num0(r.preTax) + (si && si.employer ? si.employer.total : 0),
      `${col(C.amount)}${er}+${col(C.erTotal)}${er}`);
    cells[C.note] = { v: opts.noteExtra ? (opts.noteExtra(r) || '') : '' };

    out.push(cells);
    prevRow = r;
    prevChain = chainKey;
  });

  return { headers: headers, rows: out, maxRow: out.length + dataStartRow - 1, cols: C, rowsMeta: rowsMeta };
}

/** 网格 → SheetJS 工作表（f 公式 + v 缓存值） */
function gridToWorksheet(grid) {
  const ws = {};
  const put = (excelRow, cIdx, cell) => {
    if (!cell) return;
    const addr = colLetter(cIdx) + excelRow;
    const isNum = typeof cell.v === 'number';
    const c = { t: isNum ? 'n' : 's', v: isNum ? round2(cell.v) : cell.v };
    if (cell.f) c.f = cell.f;
    ws[addr] = c;
  };
  grid.headers.forEach((h, ci) => put(1, ci, { v: h }));
  grid.rows.forEach((row, ri) => {
    row.forEach((cell, ci) => put(ri + 2, ci, cell));
  });
  let maxC = grid.headers.length - 1;
  grid.rows.forEach(row => {
    for (let i = row.length - 1; i >= 0; i--) { if (row[i]) { maxC = Math.max(maxC, i); break; } }
  });
  ws['!ref'] = 'A1:' + colLetter(maxC) + Math.max(1, grid.maxRow);
  ws['!cols'] = grid.headers.map(h => ({ wch: Math.min(24, Math.max(9, String(h).length * 1.9)) }));
  return ws;
}

// ==================== 带样式导出（ExcelJS） ====================

/** 元信息行：生成时间 + 政策数据版本 + 场景摘要 + 用法提示 */
function buildMetaLine(results, extra) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const ver = window.CITY_POLICY_LIBRARY_VERSION ? '政策数据 ' + window.CITY_POLICY_LIBRARY_VERSION + ' · ' : '';
  return '生成时间 ' + ts + ' · ' + ver + (extra || '') + '共 ' + results.length + ' 行 · 修改「收入与基数输入」列后全表自动重算';
}

/** 汇总配对收集 + JS 侧同步算好缓存值（与明细网格同口径），实现与明细一致的「打开即显示、点开见公式」 */
function buildSummaryMeta(results, nameOf) {
  const pairs = ExportStyle.collectSummaryPairs(results, nameOf);
  pairs.forEach(p => {
    const vals = { amount: 0, siTotal: 0, curTax: 0, postTax: 0, cost: 0 };
    results.forEach(r => {
      if ((nameOf ? nameOf(r) : (r.person || '本人')) !== p.name) return;
      if (String(r.month || '').indexOf(p.year) !== 0) return;
      vals.amount += r.preTax || 0;
      vals.siTotal += (r._siDetail ? (r._siDetail.total || 0) : 0);
      vals.curTax += r.currentTax || 0;
      vals.postTax += r.postTax || 0;
      vals.cost += (r.preTax || 0) + (r._siDetail && r._siDetail.employer ? (r._siDetail.employer.total || 0) : 0);
    });
    Object.keys(vals).forEach(k => { vals[k] = round2(vals[k]); });
    p.vals = vals;
  });
  return pairs;
}

/** 网格 → 带样式 ExcelJS 工作簿：标题横幅（合并）+ 元信息行 + 两级分组表头（分组行淡彩、
 *  列名行主色白字）+ 语义色（税红/实发绿/成本橙、派生列灰）+ 年终奖单独行淡蓝 + 斑马纹
 *  + 冻结（表头 4 行、左 2 列）+ 自动筛选 + 千分位/百分比格式 + 「按人年度汇总」sheet。
 *  公式沿用网格 {v 缓存, f 公式}，以 ExcelJS {formula, result} 等价双写。
 *  @returns {Promise<ArrayBuffer>} */
async function gridToStyledWorkbook(grid, meta) {
  const S = ExportStyle;
  if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS 未加载');
  const nCols = grid.headers.length;
  const F = S.PAL.fontName;
  const fillSolid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb } });
  const thin = { style: 'thin', color: { argb: S.PAL.border } };
  const keys = S.keyArray(grid.cols);

  const wb = new ExcelJS.Workbook();
  wb.creator = '个税计算器';

  /* —— 明细 sheet —— */
  const ws = wb.addWorksheet(meta.sheetName, {
    properties: { tabColor: { argb: S.PAL.primary }, defaultRowHeight: 18 },
    views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }]
  });

  /* 标题横幅与元信息行（合并整行） */
  ws.mergeCells(1, 1, 1, nCols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = meta.title;
  titleCell.font = { name: F, size: 16, bold: true, color: { argb: S.PAL.titleText } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, nCols);
  const metaCell = ws.getCell(2, 1);
  metaCell.value = meta.metaLine || '';
  metaCell.font = { name: F, size: 9, color: { argb: S.PAL.metaText } };
  metaCell.alignment = { vertical: 'middle' };
  ws.getRow(2).height = 16;

  /* 分组行（第 3 行）：合并单元格淡彩底 + 系色标题 */
  S.resolveGroups(grid.cols, nCols).forEach(g => {
    if (g.from < g.to) ws.mergeCells(3, g.from + 1, 3, g.to + 1);
    for (let i = g.from; i <= g.to; i++) {
      const c = ws.getCell(3, i + 1);
      c.fill = fillSolid(g.fill);
      c.border = { bottom: thin };
    }
    const head = ws.getCell(3, g.from + 1);
    head.value = g.label;
    head.font = { name: F, size: 10.5, bold: true, color: { argb: g.color } };
    head.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws.getRow(3).height = 20;

  /* 列名行（第 4 行）：主色底白字加粗 */
  grid.headers.forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value = h;
    c.font = { name: F, size: 11, bold: true, color: { argb: S.PAL.headerText } };
    c.fill = fillSolid(S.PAL.headerFill);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'medium', color: { argb: S.PAL.headerFill } } };
  });
  ws.getRow(4).height = 30;

  /* 数据区：语义色 + 斑马纹 + 年终奖单独行淡蓝 + 链首行上边框 + 数字格式 */
  grid.rows.forEach((row, ri) => {
    const rm = (meta.rowsMeta || [])[ri] || {};
    const rowFillArgb = S.rowFill(ri, rm);
    row.forEach((cell, ci) => {
      const c = ws.getCell(ri + 5, ci + 1);
      const key = keys[ci];
      const spec = key ? S.colSpec(key) : {};
      if (cell) {
        if (cell.f) c.value = { formula: cell.f, result: cell.v };
        else c.value = cell.v;
      }
      if (spec.numFmt) c.numFmt = spec.numFmt;
      else if (cell && typeof cell.v === 'number') c.numFmt = '#,##0.00';
      const font = {
        name: F, size: 10.5, bold: !!spec.bold,
        color: { argb: spec.color || (cell && cell.f ? S.PAL.derivedText : S.PAL.inputText) }
      };
      if (rm.bonus && key === 'project') { font.bold = true; font.color = { argb: S.PAL.bonusText }; }
      c.font = font;
      if (rowFillArgb) c.fill = fillSolid(rowFillArgb);
      c.border = { top: thin, left: thin, bottom: thin, right: thin };
      if (rm.chainStart && ri > 0) c.border.top = { style: 'medium', color: { argb: S.PAL.chainTop } };
    });
  });

  grid.headers.forEach((h, i) => { ws.getColumn(i + 1).width = S.colWidth(keys[i], h); });
  if (grid.rows.length) {
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + grid.rows.length, column: nCols } };
  }

  /* —— 按人年度汇总 sheet（SUMIFS 活公式 + 缓存值，改明细输入自动重算） —— */
  const pairs = meta.summary && meta.summary.pairs;
  if (pairs && pairs.length && grid.cols) {
    const SM = S.SUMMARY;
    const s2 = wb.addWorksheet(SM.sheetName, {
      properties: { tabColor: { argb: S.PAL.success } },
      views: [{ state: 'frozen', ySplit: 3 }]
    });
    s2.mergeCells(1, 1, 1, SM.headers.length);
    const t2 = s2.getCell(1, 1);
    t2.value = SM.sheetName;
    t2.font = { name: F, size: 14, bold: true, color: { argb: S.PAL.titleText } };
    t2.alignment = { vertical: 'middle' };
    s2.getRow(1).height = 26;

    s2.mergeCells(2, 1, 2, SM.headers.length);
    const m2 = s2.getCell(2, 1);
    m2.value = meta.metaLine || '';
    m2.font = { name: F, size: 9, color: { argb: S.PAL.metaText } };

    SM.headers.forEach((h, i) => {
      const c = s2.getCell(3, i + 1);
      c.value = h;
      c.font = { name: F, size: 11, bold: true, color: { argb: S.PAL.headerText } };
      c.fill = fillSolid(S.PAL.headerFill);
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    s2.getRow(3).height = 24;

    const src = { sheet: meta.sheetName, cols: grid.cols, firstRow: 5, lastRow: 4 + grid.rows.length };
    const totals = { amount: 0, siTotal: 0, curTax: 0, postTax: 0, cost: 0 };
    pairs.forEach((p, pi) => {
      const f = S.summaryFormulas(src, p);
      const vals = [
        { v: p.name },
        { v: p.year, center: true },
        { v: { formula: f.amount, result: p.vals.amount } },
        { v: { formula: f.siTotal, result: p.vals.siTotal } },
        { v: { formula: f.curTax, result: p.vals.curTax }, accent: SM.accents.curTax },
        { v: { formula: f.postTax, result: p.vals.postTax }, accent: SM.accents.postTax },
        { v: { formula: f.cost, result: p.vals.cost }, accent: SM.accents.cost }
      ];
      const zebra = pi % 2 === 1 ? fillSolid(S.PAL.zebra) : null;
      vals.forEach((cdef, ci) => {
        const c = s2.getCell(pi + 4, ci + 1);
        c.value = cdef.v;
        c.font = {
          name: F, size: 10.5, bold: !!(cdef.accent && cdef.accent.bold),
          color: { argb: (cdef.accent && cdef.accent.color) || S.PAL.inputText }
        };
        if (ci >= 2) c.numFmt = SM.numFmt;
        if (cdef.center) c.alignment = { horizontal: 'center' };
        if (zebra) c.fill = zebra;
        c.border = { top: thin, left: thin, bottom: thin, right: thin };
      });
      Object.keys(totals).forEach(k => { totals[k] = round2(totals[k] + p.vals[k]); });
    });

    /* 合计行：SUM 活公式 + 缓存总计，主色顶边线 */
    const tr = pairs.length + 4;
    const sumVals = [
      { v: '合计' }, { v: '' },
      { v: { formula: 'SUM(C4:C' + (tr - 1) + ')', result: totals.amount } },
      { v: { formula: 'SUM(D4:D' + (tr - 1) + ')', result: totals.siTotal } },
      { v: { formula: 'SUM(E4:E' + (tr - 1) + ')', result: totals.curTax }, accent: SM.accents.curTax },
      { v: { formula: 'SUM(F4:F' + (tr - 1) + ')', result: totals.postTax }, accent: SM.accents.postTax },
      { v: { formula: 'SUM(G4:G' + (tr - 1) + ')', result: totals.cost }, accent: SM.accents.cost }
    ];
    sumVals.forEach((cdef, ci) => {
      const c = s2.getCell(tr, ci + 1);
      c.value = cdef.v;
      c.font = {
        name: F, size: 10.5, bold: true,
        color: { argb: (cdef.accent && cdef.accent.color) || S.PAL.titleText }
      };
      if (ci >= 2) c.numFmt = SM.numFmt;
      c.fill = fillSolid(S.PAL.zebra);
      c.border = { top: { style: 'medium', color: { argb: S.PAL.primary } }, left: thin, bottom: thin, right: thin };
    });

    SM.widths.forEach((w, i) => { s2.getColumn(i + 1).width = w; });
    s2.autoFilter = { from: { row: 3, column: 1 }, to: { row: tr - 1, column: SM.headers.length } };
  }

  return wb.xlsx.writeBuffer();
}

/** 样式导出统一驱动：ExcelJS 就绪 → 组装带样式工作簿并下载；库缺失或组装失败 → 回退 SheetJS 纯净版 */
function exportStyledSalary(results, baseOpts, out) {
  const exportPlain = () => ensureXLSX(() => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, gridToWorksheet(buildSalaryFormulaGrid(results, baseOpts)), out.sheetName);
    return saveWorkbook(wb, out.fileName);
  });
  ensureExcelJS(() => {
    try {
      const grid = buildSalaryFormulaGrid(results, Object.assign({}, baseOpts, { dataStartRow: 5 }));
      const meta = {
        title: out.title,
        sheetName: out.sheetName,
        metaLine: buildMetaLine(results, out.metaExtra),
        rowsMeta: grid.rowsMeta,
        summary: { pairs: buildSummaryMeta(results, baseOpts.nameOf) }
      };
      gridToStyledWorkbook(grid, meta)
        .then(buf => downloadFile(buf, out.fileName, XLSX_MIME))
        .catch((e) => { console.error('带样式导出失败，回退基础版：', e); exportPlain(); });
    } catch (e) {
      console.error('带样式导出失败，回退基础版：', e);
      exportPlain();
    }
  }, () => {
    alert('带样式导出组件（ExcelJS）加载失败，已回退为基础版导出');
    exportPlain();
  });
}

/** 多月累计 → Excel 公式明细（带样式 + 按人年度汇总，失败回退纯净版） */
function exportMultiExcelFormula() {
  if (incomeType !== 'salary') return alert('公式明细导出目前支持「工资薪金」模式');
  const results = window._multiResults;
  if (!results || !results.length) return alert('请先计算');
  return exportStyledSalary(results, {
    nameOf: () => '本人',
    chainKey: (r) => String(r.month || '').split('-')[0],
    cityOf: () => salaryParams.cityId,
    cityLabel: (r) => {
      const pol = resolvePolicyMemo(salaryParams.cityId, r.month);
      return pol.label + (r._yearFallback ? '（年度未匹配）' : '');
    },
    noteExtra: (r) => {
      const parts = [];
      if (multiDirection === 'reverse') parts.push('应发为税后反算值');
      if (r._isBonus) parts.push(r._bonusSeparate ? '年终奖单独计税（÷12 定档）' : '年终奖并入综合所得');
      return parts.join('；');
    }
  }, { title: '多月工资个税明细（公式版）', sheetName: '工资计算明细', fileName: '多月工资个税明细(公式版).xlsx', metaExtra: '' });
}

/** 批量 → Excel 公式明细（换人/跨年自动重置累计公式基准；带样式 + 按人年度汇总，失败回退纯净版） */
function exportBatchExcelFormula() {
  if (incomeType !== 'salary') return alert('公式明细导出目前支持「工资薪金」模式');
  const results = window._batchResults;
  if (!results || !results.length) return alert('请先计算');
  const people = new Set(results.map(r => r.person || '')).size;
  return exportStyledSalary(results, {
    idCard: results.some(r => r.idCard),
    phone: results.some(r => r.phone),
    bankCard: results.some(r => r.bankCard),
    nameOf: (r) => r.person || '',
    chainKey: (r) => (r.person || '') + '|' + String(r.month || '').split('-')[0],
    cityOf: (r) => r._cityKey || salaryParams.cityId,
    cityLabel: (r) => r.cityName || '',
    noteExtra: (r) => {
      const parts = [];
      if (r.policyYearLabel) parts.push(r.policyYearLabel);
      if (batchDirection === 'reverse') parts.push('应发为税后反算值');
      if (r._isBonus) parts.push(r._bonusStrategy === 'combined' ? '年终奖并入综合所得' : '年终奖单独计税（÷12 定档）');
      if (r._siMissing) parts.push('社保公积金未设置基数，按 0 计');
      return parts.join('；');
    }
  }, { title: '批量工资个税明细（公式版）', sheetName: '批量工资明细', fileName: '批量工资个税明细(公式版).xlsx', metaExtra: people + ' 人 · ' });
}


  window.Exporter = { buildSalaryFormulaGrid,buildSummaryMeta,colLetter,downloadTemplate,ensureExcelJS,ensureXLSX,exportBatchExcelFormula,exportMultiExcelFormula,fxAnnualQuick,fxAnnualRate,fxBonusQuick,fxBonusRate,fxSiAmount,gridToStyledWorkbook,gridToWorksheet,saveWorkbook };
})();
