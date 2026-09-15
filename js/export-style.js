/* ============================================================
 * export-style.js — ExportStyle 导出样式规格
 * 职责：带样式 Excel 导出（ExcelJS）的纯规格层——antd 企业蓝色板、
 *       列分组（按 buildSalaryFormulaGrid 的列 key 映射，兼容 34/37 列）、
 *       数字格式、语义文字色、行类型样式、按人年度汇总 sheet 的
 *       SUMIFS 公式构造与配对收集。
 * 对外接口：window.ExportStyle。依赖：无（纯数据+纯函数，Node 回归门可直接加载）。
 * 色值约定：ARGB（ExcelJS 惯例），对齐 css/tokens.css 亮色主题；
 *          文字色取 antd 加深梯度（税 #CF1322 / 成功 #389E0D / 橙 #D48806），保 AA 对比。
 * ============================================================ */
(function () {
'use strict';

  /* 列下标 → Excel 列字母（0→A, 26→AA），与 exporter.js 保持一致（本模块保持零依赖故自带） */
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

  /** 色板：对齐 tokens.css（#RRGGBB → FFRRGGBB） */
  const HEX = {
    primary: '#1677FF', titleText: '#262626', metaText: '#8C8C8C',
    headerFill: '#1677FF', headerText: '#FFFFFF',
    border: '#D9D9D9', zebra: '#FAFAFA', bonusRow: '#F1F7FF', bonusText: '#0958D9',
    taxText: '#CF1322', postTaxText: '#389E0D', costText: '#D48806',
    derivedText: '#595959', inputText: '#262626', chainTop: '#BFBFBF',
    success: '#52C41A'
  };
  const argb = (hex) => ('FF' + hex.replace('#', '')).toUpperCase();
  const PAL = {};
  Object.keys(HEX).forEach(k => { PAL[k] = argb(HEX[k]); });
  PAL.fontName = '微软雅黑';

  /** 列分组：keys 必须与 buildSalaryFormulaGrid 的列顺序连续一致（新增列须同步维护，
   *  resolveGroups 会做无缝无叠全覆盖校验，漏列直接抛错由导出层回退基础版）。 */
  const GROUPS = [
    { id: 'base',   label: '基本信息',        keys: ['name', 'idCard', 'phone', 'bankCard', 'month', 'city', 'project'], fill: '#FAFAFA', color: '#595959' },
    { id: 'input',  label: '收入与基数输入',  keys: ['amount', 'socialBase', 'fundBase', 'fundRate'],                    fill: '#E6F4FF', color: '#0958D9' },
    { id: 'siMe',   label: '社保公积金（个人）', keys: ['pension', 'medical', 'unemployment', 'fund', 'siTotal'],           fill: '#E6FFFB', color: '#08979C' },
    { id: 'siEr',   label: '社保公积金（单位）', keys: ['erPension', 'erMedical', 'erUnemployment', 'erInjury', 'erFund', 'erTotal'], fill: '#F9F0FF', color: '#722ED1' },
    { id: 'deduct', label: '扣除与累计',      keys: ['extra', 'deduct', 'cumAmount', 'cumSI', 'cumExtra', 'cumDeduct', 'cumTaxable'], fill: '#FFF7E6', color: '#D48806' },
    { id: 'tax',    label: '税额计算',        keys: ['rate', 'quick', 'cumDue', 'cumPaid', 'curTax'],                    fill: '#FFF1F0', color: '#CF1322' },
    { id: 'result', label: '结果与成本',      keys: ['postTax', 'cost', 'note'],                                          fill: '#F6FFED', color: '#389E0D' }
  ].map(g => Object.assign(g, { fill: argb(g.fill), color: argb(g.color) }));

  /** 列 key → 下标映射（grid.cols，如 {name:0, month:1, ...}） → 按列序的 key 数组 */
  function keyArray(cols) {
    if (!cols) return [];
    const arr = [];
    Object.keys(cols).forEach(k => { arr[cols[k]] = k; });
    return arr;
  }

  /** 解析分组为连续区段 [{id,label,from,to,fill,color}]（0 基闭区间，按 from 升序）。
   *  校验：段内连续、段间无缝无叠、并恰好覆盖 0..colCount-1，违反即抛错。 */
  function resolveGroups(cols, colCount) {
    const idx = cols || {};
    const segs = [];
    GROUPS.forEach(g => {
      const ids = g.keys.map(k => idx[k]).filter(v => v != null);
      if (!ids.length) return;
      const from = Math.min.apply(null, ids);
      const to = Math.max.apply(null, ids);
      if (to - from + 1 !== ids.length) throw new Error('ExportStyle: 分组「' + g.label + '」列不连续');
      segs.push({ id: g.id, label: g.label, from, to, fill: g.fill, color: g.color });
    });
    segs.sort((a, b) => a.from - b.from);
    let expect = 0;
    segs.forEach(s => {
      if (s.from !== expect) throw new Error('ExportStyle: 列分组存在缝隙或重叠（断点 ' + expect + ' → ' + s.from + '）');
      expect = s.to + 1;
    });
    if (expect !== colCount) throw new Error('ExportStyle: 列分组未覆盖全部 ' + colCount + ' 列（止于 ' + expect + '）');
    return segs;
  }

  /** 数字格式：金额千分位两位小数（writer 对数值格默认落），比率百分比，文本列锁 '@' 防科学计数法 */
  const NUMFMT = {
    fundRate: '0%', rate: '0%',
    month: '@', idCard: '@', phone: '@', bankCard: '@', name: '@', city: '@', project: '@', note: '@'
  };
  const AMOUNT_FMT = '#,##0.00';

  /** 语义强调列：税额红（本期预扣加粗）、实发绿加粗、用工成本橙（对齐 UI .tax-col/.highlight/汇总卡片） */
  const ACCENT = {
    curTax: { color: PAL.taxText, bold: true },
    cumDue: { color: PAL.taxText },
    postTax: { color: PAL.postTaxText, bold: true },
    cost: { color: PAL.costText }
  };

  /** 单列样式规格：{numFmt, color, bold}；color 为空时由 writer 依「是否公式列」落派生/输入色 */
  function colSpec(key) {
    const a = ACCENT[key];
    return { numFmt: NUMFMT[key] || null, color: a ? a.color : null, bold: !!(a && a.bold) };
  }

  /** 列宽：表头启发式 + 数值列保底 12 防 ####，备注固定 24 */
  function colWidth(key, header) {
    let w = Math.min(24, Math.max(9, String(header).length * 1.9));
    const nf = NUMFMT[key];
    if (!nf || nf === AMOUNT_FMT) w = Math.max(w, 12);
    if (key === 'note') w = 24;
    if (key === 'name' || key === 'month') w = Math.max(w, 10);
    return Math.round(w * 10) / 10;
  }

  /** 数据行底色：年终奖单独计税行淡蓝（对齐 UI .bonus-row）优先，否则偶数行斑马纹 */
  function rowFill(ri, rm) {
    if (rm && rm.bonus) return PAL.bonusRow;
    return ri % 2 === 1 ? PAL.zebra : null;
  }

  // ==================== 按人年度汇总 sheet ====================

  const SUMMARY = {
    sheetName: '按人年度汇总',
    headers: ['姓名', '年度', '累计应发', '个人社保公积金', '全年缴税', '全年实发', '企业用工成本'],
    /* 数据列 key：与明细网格 cols 对应（name/year 为分组成员列） */
    keys: ['name', 'year', 'amount', 'siTotal', 'curTax', 'postTax', 'cost'],
    numFmt: AMOUNT_FMT,
    widths: [12, 9, 15, 15, 13, 15, 15],
    accents: { curTax: { color: PAL.taxText, bold: true }, postTax: { color: PAL.postTaxText, bold: true }, cost: { color: PAL.costText } }
  };

  /** 收集汇总配对 [{name, year}]：按数据出现顺序去重（name 取与明细表一致的 nameOf 口径） */
  function collectSummaryPairs(rows, nameOf) {
    const seen = {};
    const out = [];
    (rows || []).forEach(r => {
      const name = nameOf ? nameOf(r) : (r.person || '本人');
      const m = String(r.month || '');
      const year = m.split('-')[0] || m;
      const k = name + '|' + year;
      if (!seen[k]) { seen[k] = 1; out.push({ name: name, year: year }); }
    });
    return out;
  }

  /** 汇总行 SUMIFS 构造（活公式：改明细输入自动重算）。
   *  src = { sheet: 明细 sheet 名, cols: 明细列 key→下标, firstRow/lastRow: 明细数据行区间 }
   *  月份 criteria 用「年 + *」通配，同时兼容年终奖单独/并入两种策略行（不按项目列过滤）。 */
  function summaryFormulas(src, pair) {
    const q = "'" + src.sheet + "'!";
    const rng = (key) => q + '$' + colLetter(src.cols[key]) + '$' + src.firstRow + ':$' + colLetter(src.cols[key]) + '$' + src.lastRow;
    const nameCrit = '"' + String(pair.name).replace(/"/g, '""') + '"';
    const monthCrit = '"' + (pair.year ? pair.year + '*' : '*') + '"';
    const crit = `${rng('name')},${nameCrit},${rng('month')},${monthCrit}`;
    return {
      amount: `SUMIFS(${rng('amount')},${crit})`,
      siTotal: `SUMIFS(${rng('siTotal')},${crit})`,
      curTax: `SUMIFS(${rng('curTax')},${crit})`,
      postTax: `SUMIFS(${rng('postTax')},${crit})`,
      cost: `SUMIFS(${rng('cost')},${crit})`
    };
  }

  window.ExportStyle = { PAL, GROUPS, SUMMARY, keyArray, resolveGroups, colSpec, colWidth, rowFill, collectSummaryPairs, summaryFormulas };
})();
