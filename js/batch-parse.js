/* ============================================================
 * batch-parse.js — BatchParse 批量导入解析与智能识别（纯逻辑）
 * CSV/Excel 行解析、月份归一与提示提取、身份清洗、汇总行/金额判定、列评分与工作表分析、智能表检测与列类型映射识别。
 * 对外接口：window.BatchParse。依赖：无（纯逻辑零 DOM，Node 回归门可直接加载）。
 * ============================================================ */
(function () {
'use strict';

function parseCSV(text) {
  return text.split(/\r?\n/).map(line => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }).filter(row => row.some(cell => cell !== ''));
}

/**
 * 检测 UTF-8 解码是否产生乱码（GBK 文件误用 UTF-8 读取）
 */
function isGarbled(text) {
  // GBK 编码的中文用 UTF-8 读取会出现大量替换字符或无意义字节
  const garbledPattern = /[\uFFFD]{2,}|[Ã¯Â¿Â½]{3,}|[éèêë]{3,}[àáâãäå]{2,}/;
  if (garbledPattern.test(text)) return true;
  // 检测：如果文本包含大量非 CJK 也非 ASCII 的字符，大概率是乱码
  let suspicious = 0;
  for (let i = 0; i < Math.min(text.length, 500); i++) {
    const code = text.charCodeAt(i);
    if (code > 255 && !(code >= 0x4E00 && code <= 0x9FFF) && !(code >= 0x3000 && code <= 0x303F)) {
      suspicious++;
    }
  }
  return suspicious > 10;
}

/** Excel 日期序列号 → Date（1900 日期系统，按 1899-12-30 纪元折算） */
function excelSerialToDate(serial) {
  const epoch = new Date(1899, 11, 30);
  return new Date(epoch.getTime() + serial * 86400000);
}

/**
 * 标准化月份格式为 YYYY-MM
 * 支持：2024-01, 2024/01, 2024年1月, 2024.01, 202401, 1月, Excel序列号 等
 */
function normalizeMonth(raw) {
  if (!raw || raw === '-') return '-';
  let s = String(raw).trim();

  // Excel 序列号（纯数字，大于 40000 约为 2009 年之后）
  if (/^\d{5,}$/.test(s)) {
    const serial = parseInt(s);
    if (serial > 30000 && serial < 60000) {
      const d = excelSerialToDate(serial);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  }

  // 2024年1月 / 2024年01月
  let m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月?/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

  // 1月 / 01月（当年）
  m = s.match(/^(\d{1,2})\s*月$/);
  if (m) {
    const year = new Date().getFullYear();
    return `${year}-${m[1].padStart(2, '0')}`;
  }

  // Dec-24 / Jan-25 / Feb-25 等 Excel 英文月份缩写
  const MONTH_EN = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                     jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  m = s.match(/^([A-Za-z]{3})[-\/.\s]?(\d{2,4})$/);
  if (m) {
    const monKey = m[1].toLowerCase();
    const monNum = MONTH_EN[monKey];
    if (monNum) {
      let yr = parseInt(m[2]);
      if (yr < 100) yr += 2000;
      return `${yr}-${monNum}`;
    }
  }

  // 2024-01, 2024/01, 2024.01, 202401，也支持后面带时间的
  m = s.match(/^(\d{4})[-\/.\s]?(\d{1,2})(?:[-\/.\s]?\d{1,2})?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?$/);
  if (m && parseInt(m[2]) >= 1 && parseInt(m[2]) <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;

  // 2024-01-15 / 2024/01/15（取年月），也支持后面带时间的
  m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

  // 兜底：原样返回
  return s;
}

/**
 * 比较两个 YYYY-MM 格式的月份字符串，用于排序
 */
function compareMonth(a, b) {
  if (a === '-') return 1;
  if (b === '-') return -1;
  return a.localeCompare(b);
}

function extractMonthHint(text) {
  if (!text) return '';
  const raw = String(text).trim();
  // 纯小数数值（如金额 2018.6）会被 "YYYY.M" 点分年月模式误判，直接排除
  if (/^\d+\.\d+$/.test(raw)) return '';
  const patterns = [
    /(?:^|[^\d])(20\d{2}\s*年\s*\d{1,2}\s*月)(?:[^\d]|$)/,
    /(?:^|[^\d])(20\d{2}[-\/.]\d{1,2})(?:[-\/.]\d{1,2})?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?(?:[^\d]|$)/,
    /(?:^|[^\d])((?:20\d{2})(?:0[1-9]|1[0-2]))(?:[^\d]|$)/
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    const normalized = normalizeMonth(m[1]);
    if (/^\d{4}-\d{2}$/.test(normalized)) return normalized;
  }
  return '';
}

function extractYearHint(text) {
  if (!text) return '';
  const raw = String(text).trim();
  // 长纯数字串（身份证号/银行卡号/金额）中的 "20xx" 子串不是年份提示
  if (/^\d+(\.\d+)?$/.test(raw) && (raw.includes('.') || raw.length > 6)) return '';
  const m = raw.match(/(20\d{2})/);
  return m ? m[1] : '';
}

function buildMonthFromParts(yearHint, monthValue) {
  const monthNum = parseInt(monthValue, 10);
  if (!yearHint || !(monthNum >= 1 && monthNum <= 12)) return '';
  return `${yearHint}-${String(monthNum).padStart(2, '0')}`;
}

function normalizeMonthWithHint(raw, monthHint = '') {
  const normalized = normalizeMonth(raw);
  if (/^\d{4}-\d{2}$/.test(normalized)) return normalized;
  const rawText = String(raw || '').trim();
  if (/^\d{1,2}$/.test(rawText)) {
    const yearHint = extractYearHint(monthHint);
    const built = buildMonthFromParts(yearHint, rawText);
    if (built) return built;
  }
  return normalized;
}

function extractSortDateTime(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  if (!text) return '';

  // Excel serial date/time
  if (/^\d{5,}(\.\d+)?$/.test(text)) {
    const serial = parseFloat(text);
    if (serial > 30000 && serial < 60000) {
      const d = excelSerialToDate(serial);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    }
  }

  let m = text.match(/(20\d{2})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:[日\sT]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const yyyy = m[1];
    const mm = m[2].padStart(2, '0');
    const dd = m[3].padStart(2, '0');
    const hh = String(m[4] || '00').padStart(2, '0');
    const mi = String(m[5] || '00').padStart(2, '0');
    const ss = String(m[6] || '00').padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  return '';
}

function extractMonthHintFromRows(rows, fallbackYear = '') {
  const scanRows = (rows || []).slice(0, 20);
  let yearHint = fallbackYear || '';

  for (const row of scanRows) {
    for (const cell of row || []) {
      const text = String(cell || '').trim();
      if (!text) continue;
      if (!yearHint) yearHint = extractYearHint(text);
      const hint = extractMonthHint(text);
      if (hint) return hint;
    }
  }

  for (let ri = 0; ri < scanRows.length - 1; ri++) {
    const row = scanRows[ri] || [];
    const nextRow = scanRows[ri + 1] || [];
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      const text = String(cell || '').trim();
      if (!/月份|month|期间|发放月/i.test(text)) continue;
      const current = row[ci + 1];
      const next = nextRow[ci];
      const nextRight = nextRow[ci + 1];
      for (const candidate of [current, next, nextRight]) {
        const raw = String(candidate || '').trim();
        if (!raw) continue;
        const direct = extractMonthHint(raw);
        if (direct) {
          yearHint = extractYearHint(direct) || yearHint;
          return direct;
        }
      }
      // 「月份」邻格可能是纯月份数字（9）或带月字（9月），配合文件名/表头年份提示拼出完整年月
      const numOf = candidate => {
        const m = String(candidate || '').trim().match(/^(\d{1,2})\s*月?$/);
        return m ? m[1] : '';
      };
      const numericCandidate = [current, next, nextRight].find(candidate => numOf(candidate) !== '');
      if (numericCandidate && yearHint) {
        const built = buildMonthFromParts(yearHint, numOf(numericCandidate));
        if (built) return built;
      }
    }
  }

  return '';
}

function sanitizeIdCard(value) {
  const v = String(value || '').trim().toUpperCase();
  return /^\d{17}[\dX]$/.test(v) ? v : '';
}

function sanitizePhone(value) {
  const v = String(value || '').replace(/\D/g, '');
  return /^1[3-9]\d{9}$/.test(v) ? v : '';
}

function sanitizeBankCard(value) {
  const v = String(value || '').replace(/\s+/g, '');
  return /^\d{16,19}$/.test(v) ? v : '';
}

function sanitizeName(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/合计|总计|汇总|平台服务费|服务费率|开票|税源地|业务类型/i.test(v)) return '';
  if (/^\d+(\.\d+)?$/.test(v)) return '';
  return v;
}

function rowHasUsableIdentity({ name, idCard, phone, bankCard }) {
  const cleanName = sanitizeName(name);
  return !!((cleanName && cleanName !== '默认') || sanitizeIdCard(idCard) || sanitizePhone(phone) || sanitizeBankCard(bankCard));
}

function isSummaryLikeText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /合计|总计|汇总|小计|平台服务费|服务费率|服务费|开票金额|客户支付合计|收费通知/i.test(text);
}

function isSummaryLikeRow(row) {
  if (!Array.isArray(row)) return false;
  const cells = row.map(cell => String(cell || '').trim()).filter(Boolean);
  if (!cells.length) return false;
  const summaryHits = cells.filter(isSummaryLikeText).length;
  if (!summaryHits) return false;

  const hasIdentity = cells.some(cell =>
    sanitizeIdCard(cell) || sanitizePhone(cell) || sanitizeBankCard(cell) || (!!sanitizeName(cell) && !isSummaryLikeText(cell))
  );

  return !hasIdentity;
}

function isAmountLikeNumber(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;
  const compact = raw.replace(/,/g, '');
  if (/^\d{11}$/.test(compact)) return false;
  if (/^\d{16,19}$/.test(compact)) return false;
  if (/^\d{17}[\dXx]$/.test(compact)) return false;
  const num = parseFloat(compact);
  return !isNaN(num) && isFinite(num) && num > 0 && num < 1e8;
}

function isAmountHeaderExcluded(header) {
  return /方式|类型|选择|状态|税源地|开户|账号|账户|手机号|电话|身份证|证件|银行|备注|说明|业务|三险一金|五险一金|社保|公积金|专项附加|基数/.test(header);
}

function getAmountColumnScore(header, dataRows, ci) {
  const headerText = String(header || '').trim();
  if (!headerText || isAmountHeaderExcluded(headerText)) return -Infinity;

  let score = 0;
  if (/应发金额|实发金额|应发工资|实发工资|客户支付合计|税前收入|税后收入|发放金额|报酬|工资|月薪/i.test(headerText)) score += 9;
  else if (/金额|amount|收入额|合计金额|应付金额/i.test(headerText)) score += 6;
  else if (/累计收入/i.test(headerText)) score += 3;
  if (/含税|应付|收入|pay|income/i.test(headerText)) score += 2;
  if (/发放方式|服务费率|税源地/i.test(headerText)) score -= 10;
  if (/三险一金|五险一金|社保|公积金|专项附加|基数/i.test(headerText)) score -= 10;

  const sampleRows = dataRows.slice(0, 12);
  if (!sampleRows.length) return score;

  let amountHits = 0;
  sampleRows.forEach(row => {
    if (isAmountLikeNumber(row?.[ci])) amountHits++;
  });
  const ratio = amountHits / sampleRows.length;
  score += ratio * 8;
  if (ratio < 0.35) score -= 8;
  return score;
}

function getSheetNameScore(sheetName) {
  const name = String(sheetName || '');
  let score = 0;
  if (/(工资|薪资|报酬|劳务|个税|结算|收入|明细|台账|收费|发放|salary|pay|income|detail)/i.test(name)) score += 8;
  if (/(汇总|总表|合计|说明|模板|示例|图表|透视|pivot|summary|chart|cover|封面|备份|backup)/i.test(name)) score -= 12;
  if (extractMonthHint(name)) score += 6;
  return score;
}

function scoreDataCoverage(headerRow, dataRows, autoMap) {
  const sampleRows = dataRows.slice(0, 50);
  if (!sampleRows.length) return { score: 0, amountRate: 0, monthRate: 0, identityRate: 0 };

  let amountHits = 0;
  let monthHits = 0;
  let identityHits = 0;

  sampleRows.forEach(row => {
    const valOf = (colKey) => {
      const idx = autoMap[colKey];
      return (idx != null && autoMap.cols && autoMap.cols[idx]) ? row[idx] : '';
    };

    if (isAmountLikeNumber(valOf('amountCol'))) amountHits++;

    const normalizedMonth = normalizeMonth(valOf('monthCol') || '');
    if (/^\d{4}-\d{2}$/.test(normalizedMonth)) monthHits++;

    if (
      /^\d{17}[\dXx]$/.test(String(valOf('idCardCol') || '').trim()) ||
      /^1[3-9]\d{9}$/.test(String(valOf('phoneCol') || '').trim()) ||
      /^\d{16,19}$/.test(String(valOf('bankCardCol') || '').trim()) ||
      String(valOf('nameCol') || '').trim()
    ) {
      identityHits++;
    }
  });

  const amountRate = amountHits / sampleRows.length;
  const monthRate = monthHits / sampleRows.length;
  const identityRate = identityHits / sampleRows.length;
  let score = 0;
  if (sampleRows.length >= 3) score += 8;
  if (sampleRows.length >= 10) score += 4;
  score += Math.round(amountRate * 18);
  score += Math.round(monthRate * 14);
  score += Math.round(identityRate * 12);

  return { score, amountRate, monthRate, identityRate };
}

/** 从文本提取「N月」裸月份（不带年份），如「费用明细 (绵花棠8月)」→ '8'；无则 '' */
function extractBareMonth(text) {
  const m = String(text || '').match(/(\d{1,2})\s*月/);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 12) ? String(n) : '';
}

function analyzeSheet(sheetName, rows, workbookMonthHint = '', workbookYearHint = '') {
  const nonEmptyRows = (rows || []).filter(row => row.some(cell => String(cell || '').trim() !== ''));
  if (!nonEmptyRows.length) {
    return {
      sheetName,
      rows: [],
      score: -999,
      monthHint: extractMonthHint(sheetName) || workbookMonthHint,
      dataRowsCount: 0,
      headerRowIndex: 0,
      autoMap: { cols: {}, amountType: 'preTax' }
    };
  }

  const { headerRow, headerRowIndex, dataRows } = smartDetectTable(nonEmptyRows);
  const autoMap = detectColumnMapping(headerRow, dataRows);

  let headerScore = 0;
  const typedCols = Object.entries(autoMap.cols || {}).filter(([, col]) => col.type);
  typedCols.forEach(([, col]) => {
    if (col.type === 'amount') headerScore += 25;
    else if (col.type === 'month') headerScore += 18;
    else headerScore += 10;
  });

  const reverseMap = {};
  Object.entries(autoMap.cols || {}).forEach(([ci, col]) => {
    if (col.type && reverseMap[col.type] == null) reverseMap[col.type] = Number(ci);
  });
  autoMap.amountCol = reverseMap.amount;
  autoMap.monthCol = reverseMap.month;
  autoMap.nameCol = reverseMap.name;
  autoMap.idCardCol = reverseMap.idCard;
  autoMap.phoneCol = reverseMap.phone;
  autoMap.bankCardCol = reverseMap.bankCard;

  const coverage = scoreDataCoverage(headerRow, dataRows, autoMap);
  const nameScore = getSheetNameScore(sheetName);
  /* 月份优先级：Sheet 名整年月 > Sheet 名「N月」+年份 > 表内行扫描（汇总区「月份」邻格）> 文件名整年月。
     平台发放表的汇总区月份常是模板残留（如 8 月表写「12月」），而 Sheet 名自带真实所属期
     （如「费用明细 (绵花棠8月)」），故 Sheet 名可信度最高；文件名月份仅兜底。 */
  const rowMonthHint = extractMonthHintFromRows(nonEmptyRows, workbookYearHint);
  const sheetBareMonth = buildMonthFromParts(extractYearHint(sheetName) || workbookYearHint, extractBareMonth(sheetName));
  const monthHint = extractMonthHint(sheetName) || sheetBareMonth || rowMonthHint || workbookMonthHint;
  const score = headerScore + coverage.score + nameScore + (monthHint ? 4 : 0);

  return {
    sheetName,
    rows: nonEmptyRows,
    score,
    headerScore,
    dataScore: coverage.score,
    nameScore,
    monthHint,
    dataRowsCount: dataRows.length,
    headerRowIndex,
    autoMap,
    amountRate: coverage.amountRate,
    monthRate: coverage.monthRate,
    identityRate: coverage.identityRate
  };
}

/** 数据源条目工厂：CSV 与 Excel 工作表两条入队路径共用（须留在纯逻辑层，batch-source 亦经 BatchParse 调用） */
function buildSourceItem({ type, fileName, sheetName = '', rows = [], selected = true, analysis = null }) {
  return {
    id: `${type}:${fileName}:${sheetName || 'default'}:${Math.random().toString(36).slice(2, 8)}`,
    type,
    fileName,
    sheetName,
    rows,
    selected,
    analysis
  };
}

function analyzeWorkbookSheets(wb, fileName) {
  let workbookMonthHint = extractMonthHint(fileName);
  let workbookYearHint = extractYearHint(fileName);
  if (!workbookMonthHint || !workbookYearHint) {
    outer:
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }).slice(0, 20);
      for (const row of rows) {
        for (const cell of row || []) {
          const text = String(cell || '').trim();
          if (!text) continue;
          if (!workbookYearHint) workbookYearHint = extractYearHint(text) || workbookYearHint;
          if (!workbookMonthHint) workbookMonthHint = extractMonthHint(text) || workbookMonthHint;
          if (workbookMonthHint && workbookYearHint) break outer;
        }
      }
    }
  }

  const analyzed = wb.SheetNames.map(sheetName => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    return analyzeSheet(sheetName, rows, workbookMonthHint, workbookYearHint);
  }).filter(item => item.rows.length > 0);

  if (!analyzed.length) return [];

  analyzed.sort((a, b) => b.score - a.score);
  const topScore = analyzed[0].score;
  let selected = analyzed.filter(item =>
    item.score >= 45 &&
    item.dataRowsCount >= 2 &&
    item.score >= topScore - 10 &&
    !/(汇总|总表|说明|模板|图表|透视|summary|chart|cover|封面)/i.test(item.sheetName)
  );

  if (!selected.length) selected = [analyzed[0]];
  const selectedNames = new Set(selected.map(item => item.sheetName));

  return analyzed.map(item => buildSourceItem({
    type: 'excel-sheet',
    fileName,
    sheetName: item.sheetName,
    rows: item.rows,
    selected: selectedNames.has(item.sheetName),
    analysis: item
  }));
}

// ==================== Smart Table Detection ====================

/**
 * 列识别关键词配置，按优先级从高到低排序
 */
const COL_KEYWORDS = [
  {
    type: 'name',
    patterns: [
      /^(姓名|户名|人员|收款人|员工|name|person)$/i,           // 高优先级：精确匹配
      /(^|\s|_|-)姓名(^|\s|_|-$)/i, /(^|\s|_|-)员工(^|\s|_|-$)/i, /(^|\s|_|-)人员(^|\s|_|-$)/i,  // 独立出现的关键词
      /姓名|员工|人员|收款人|person/i                           // 中优先级：包含关键词
    ],
    exclude: /公司|单位|企业|机构|部门|集体|组织|集团/i       // 排除公司类名称
  },
  {
    type: 'month',
    patterns: [
      /^(月份|month|期间|时间|日期|date|发放月|所属月)$/i,
      /月份|month|期间|时间|日期|date|发放月|所属月/i
    ],
    exclude: null
  },
  {
    type: 'amount',
    patterns: [
      /^(金额|amount|收入|income|报酬|pay|实发金额?|税前收入?|税后收入?|应发金额?|应付金额?|应发工资|实发工资|工资|月薪|基本工资|客户支付合计|累计收入|收入额|发放金额|合计金额|服务预算|付款金额|计划发放收入)$/i,
      /金额|amount|收入|income|报酬|pay|实发|税前|税后|应发|应付|工资|月薪|发放|合计|预算|付款/i
    ],
    exclude: null
  },
  {
    type: 'socialBase',
    patterns: [
      /^(社保基数|社保缴费基数|社保缴费工资基数|社会保险基数|缴费工资基数)$/i,
      /社保.{0,6}基数|社会保险.{0,6}基数|缴费(工资)?基数/i
    ],
    exclude: /公积金/i
  },
  {
    type: 'fundBase',
    patterns: [
      /^(公积金基数|公积金缴费基数|住房公积金基数|公积金缴费工资基数)$/i,
      /公积金.{0,6}基数|住房公积金.{0,6}基数/i
    ],
    exclude: null
  },
  {
    type: 'fundRate',
    patterns: [
      /^(公积金比例|公积金缴存比例|公积金个人比例|住房公积金比例|公积金缴存档|缴存比例|公积金档位|个人缴存比例)$/i,
      /公积金.{0,8}(比例|档)/i
    ],
    exclude: /基数/i
  },
  {
    type: 'bonus',
    patterns: [
      /^(年终奖|年终奖金|全年一次性奖金|年度奖金|年终奖励|年终花红|bonus|annual\s*bonus)$/i,
      /年终奖|年度奖金|一次性奖金|年终花红/i
    ],
    exclude: /工资|月薪|基数|比例|月度|季度|绩效/i
  },
  {
    type: 'extraDeduction',
    patterns: [
      /^(专项附加扣除|专项附加|附加扣除)$/i,
      /专项附加|附加扣除/i
    ],
    exclude: /社保|公积金|三险|五险/i
  },
  {
    type: 'city',
    patterns: [
      /^(城市|参保地|缴纳地|工作城市|参保城市|社保城市)$/i,
      /城市|参保地|缴纳地/i
    ],
    exclude: null
  },
  {
    type: 'idCard',
    patterns: [
      /^(身份证|身份证号|身份证号码|id\s*card|idcard|证件号)$/i,
      /身份证|身份证号|id\s*card|idcard|证件号/i
    ],
    exclude: null
  },
  {
    type: 'phone',
    patterns: [
      /^(电话|phone|手机|mobile|联系电话)$/i,
      /电话|phone|手机|mobile|联系/i
    ],
    exclude: null
  },
  {
    type: 'bankName',
    patterns: [
      /^(开户行|开户银行|银行名称|开户行信息|bank\s*name)$/i,
      /开户行|开户银行|银行名称|bank\s*name/i
    ],
    exclude: null
  },
  {
    type: 'bankCard',
    patterns: [
      /^(银行卡号?|bank|卡号|bankcard|账号|账户)$/i,
      /银行|bank|卡号|bankcard|账号|开户|账户/i
    ],
    exclude: null
  },
  {
    type: 'withholdRate',
    patterns: [
      /^(个税核定代征税率|核定代征税率|核定税率|代征税率|预征率|代征率)$/i,
      /核定代征|代征税率|核定税率|预征率|代征率/i
    ],
    exclude: /服务费|公积金|社保/i
  },
  {
    type: 'note',
    patterns: [
      /^(备注|note|说明|remark|类型|方式|承担|服务费|税源地|业务类型)$/i,
      /备注|note|说明|remark|类型|方式|承担|服务费|税源地|业务/i
    ],
    exclude: null
  }
];

const COL_TYPE_LABELS = {
  '':        '— 不识别 —',
  name:      ' 姓名',
  month:     '月份',
  amount:    ' 金额',
  socialBase:     ' 社保基数',
  fundBase:       ' 公积金基数',
  fundRate:       ' 公积金比例',
  bonus:          ' 年终奖',
  extraDeduction: ' 专项附加扣除',
  city:           ' 城市',
  idCard:    ' 身份证',
  phone:     ' 电话',
  bankName:  ' 开户银行',
  bankCard:  ' 银行卡',
  withholdRate: ' 核定代征率',
  note:      ' 备注',
};

/**
 * 计算某个表头匹配某个类型的得分
 */
function getColumnMatchScore(header, config) {
  const v = String(header || '').trim();
  if (!v) return 0;
  
  // 检查是否在排除列表中
  if (config.exclude && config.exclude.test(v)) return -1;
  
  // 按模式优先级匹配，得分依次递减
  for (let i = 0; i < config.patterns.length; i++) {
    if (config.patterns[i].test(v)) {
      return config.patterns.length - i;  // 前面的模式得分更高
    }
  }
  return 0;
}

/**
 * 强身份标识：行内出现身份证号 / 手机号 / 银行卡号 / 统一信用代码格式的值，
 * 说明该行一定是人员数据行，绝不能当作表头或垃圾行过滤掉。
 * （旧逻辑用"关键词命中数>=2"判断表头行，导致"身份证/银行卡/XX银行"等
 *   数据单元格值被误判，整表数据被清空，只剩银行名不含关键词的极少数行。）
 */
function rowHasStrongIdentity(row) {
  return (row || []).some(cell => {
    const s = String(cell || '').trim();
    if (!s) return false;
    if (/^\d{17}[\dXx]$/.test(s)) return true;                    // 身份证号
    if (/^1[3-9]\d{9}$/.test(s)) return true;                     // 手机号
    if (/^\d{16,19}$/.test(s)) return true;                       // 银行卡号
    if (/^[0-9A-Za-z]{18}$/.test(s) && /[A-Za-z]/.test(s)) return true; // 统一信用代码
    return false;
  });
}

/**
 * 检测下一行是否是表头延续（双行表头的第二行）
 */
function isHeaderContinuation(headerRow, nextRow) {
  if (!nextRow || !Array.isArray(nextRow)) return false;
  const nextNonEmpty = nextRow.filter(c => c != null && String(c).trim() !== '');
  if (nextNonEmpty.length === 0) return false;
  // 双行表头的第二行通常只有少数拆分的列，不超过表头列数的一半
  if (nextNonEmpty.length > Math.max(3, headerRow.length * 0.5)) return false;
  // 所有非空单元格必须是短文本，不能是数字、身份证号、手机号、银行卡号等数据值
  for (const c of nextNonEmpty) {
    const s = String(c).trim();
    if (!s) continue;
    if (/^\d+(\.\d+)?$/.test(s)) return false;       // 纯数字
    if (/^\d{17}[\dXx]$/.test(s)) return false;       // 身份证号
    if (/^1[3-9]\d{9}$/.test(s)) return false;        // 手机号
    if (/^\d{16,19}$/.test(s)) return false;          // 银行卡号
    if (s.length > 10) return false;                  // 表头文本通常较短
  }
  return true;
}

/**
 * 合并双行表头：对于每一列，若两行都有值则拼接，否则取非空值
 */
function mergeHeaderRows(row1, row2) {
  const len = Math.max(row1.length, row2.length);
  const merged = [];
  for (let i = 0; i < len; i++) {
    const h1 = String(row1[i] || '').trim();
    const h2 = String(row2[i] || '').trim();
    if (h1 && h2) merged.push(h1 + h2);
    else merged.push(h1 || h2);
  }
  return merged;
}

/**
 * 智能探测数据表：扫描前25行找到关键词最密集的行作为表头
 */
function smartDetectTable(rows) {
  const SUMMARY_RE = /合计|总计|汇总|小计|total|sum/i;
  const HEADER_RE = /月份|month|时间|日期|date|收入|income|金额|amount|姓名|name|身份证|电话|phone|手机|银行|bank|卡号/i;
  let bestIdx = 0, bestScore = 0;
  const scanEnd = Math.min(rows.length, 25);

  for (let i = 0; i < scanEnd; i++) {
    const row = rows[i] || [];
    let score = 0;
    row.forEach(cell => {
      const v = String(cell || '');
      if (!v.trim()) return;
      // 检查是否匹配任何列识别关键词
      for (const config of COL_KEYWORDS) {
        if (getColumnMatchScore(v, config) > 0) {
          score++;
          break;
        }
      }
      if (/序号|编号|^#$/.test(v)) score += 0.5;
    });
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  let headerRow = rows[bestIdx] || [];
  let dataStartIdx = bestIdx + 1;
  // 双行表头：下一行是表头延续（少量短文本拆分列）时，合并为完整表头
  if (isHeaderContinuation(headerRow, rows[dataStartIdx])) {
    headerRow = mergeHeaderRows(headerRow, rows[dataStartIdx]);
    dataStartIdx++;
  }

  const dataRows = [];
  for (let i = dataStartIdx; i < rows.length; i++) {
    const row = rows[i] || [];
    const firstCell = String(row[0] || '') + String(row[1] || '');
    if (SUMMARY_RE.test(firstCell)) continue;
    if (isSummaryLikeRow(row)) continue;
    const nonEmptyCells = row.filter(c => c != null && String(c).trim() !== '');
    if (nonEmptyCells.length === 0) continue;
    // 含身份证号/手机号/银行卡号等强身份标识 → 一定是数据行，直接保留
    if (rowHasStrongIdentity(row)) { dataRows.push(row); continue; }
    // 次级表头行：非空单元格大多是短文本表头关键词（至少3个且占60%以上）才跳过。
    // 不能再用"命中数>=2"这种宽松条件——数据行的"XX银行""身份证"等值也会命中。
    const kwCells = row.filter(cell => {
      const s = String(cell || '').trim();
      return s && HEADER_RE.test(s) && s.length <= 8;
    });
    if (kwCells.length >= 3 && kwCells.length >= nonEmptyCells.length * 0.6) continue;
    dataRows.push(row);
  }
  return { headerRow, headerRowIndex: bestIdx, dataRows };
}

/**
 * 自动推断列映射 + 构建映射UI数据
 */
function detectColumnMapping(headerRow, dataRows) {
  const mapping = {};
  const used = new Set();
  const typeScores = {}; // 记录每个类型在各列中的得分

  // 第一阶段：为每一列计算每个类型的匹配得分
  headerRow.forEach((cell, i) => {
    const v = String(cell || '').trim();
    if (!v) return;
    
    typeScores[i] = {};
    for (const config of COL_KEYWORDS) {
      typeScores[i][config.type] = getColumnMatchScore(v, config);
    }
  });

  // 第二阶段：按类型逐个选择最佳匹配列（排除金额列先不处理）
  for (const config of COL_KEYWORDS) {
    const type = config.type;
    if (type === 'amount' || used.has(type)) continue;
    
    let bestCol = null;
    let bestScore = 0;
    
    for (let i = 0; i < headerRow.length; i++) {
      if (mapping[i]) continue; // 列已被占用
      const score = typeScores[i]?.[type] || 0;
      if (score > bestScore) {
        bestScore = score;
        bestCol = i;
      }
    }
    
    if (bestCol != null && bestScore > 0) {
      mapping[bestCol] = type;
      used.add(type);
    }
  }

  // 金额列优先按表头 + 数值样本双重判定，避免把“发放方式”等列误识别成金额
  let bestAmountIdx = null;
  let bestAmountScore = -Infinity;
  headerRow.forEach((cell, i) => {
    if (mapping[i]) return;
    const score = getAmountColumnScore(cell, dataRows, i);
    if (score > bestAmountScore) {
      bestAmountScore = score;
      bestAmountIdx = i;
    }
  });
  if (bestAmountIdx != null && bestAmountScore >= 5) {
    mapping[bestAmountIdx] = 'amount';
    used.add('amount');
  }

  // 如果没识别到金额列，扫描数据找纯数值列
  if (!used.has('amount')) {
    for (let ci = 0; ci < headerRow.length; ci++) {
      if (mapping[ci]) continue;
      let numCount = 0;
      for (let ri = 0; ri < Math.min(dataRows.length, 10); ri++) {
        if (isAmountLikeNumber(dataRows[ri]?.[ci])) numCount++;
      }
      if (numCount >= Math.min(dataRows.length, 10) * 0.5) {
        mapping[ci] = 'amount';
        used.add('amount');
        break;
      }
    }
  }

  const cols = {};
  headerRow.forEach((cell, i) => {
    const v = String(cell || '').trim();
    if (!v && mapping[i] == null) return;
    const samples = [];
    for (let ri = 0; ri < Math.min(dataRows.length, 3); ri++) {
      const sv = dataRows[ri]?.[i];
      if (sv != null && String(sv).trim()) samples.push(String(sv).trim());
    }
    cols[i] = { header: v || `列${i+1}`, type: mapping[i] || '', samples };
  });

  return { cols, amountType: 'preTax' };
}
  window.BatchParse = { COL_KEYWORDS, COL_TYPE_LABELS, analyzeSheet, analyzeWorkbookSheets, buildMonthFromParts, buildSourceItem, compareMonth,
    detectColumnMapping, extractMonthHint, extractMonthHintFromRows, extractSortDateTime, extractYearHint, getAmountColumnScore,
    getColumnMatchScore, getSheetNameScore, isAmountHeaderExcluded, isAmountLikeNumber, isGarbled, isHeaderContinuation,
    isSummaryLikeRow, isSummaryLikeText, mergeHeaderRows, normalizeMonth, normalizeMonthWithHint, parseCSV, rowHasStrongIdentity,
    rowHasUsableIdentity, sanitizeBankCard, sanitizeIdCard, sanitizeName, sanitizePhone, scoreDataCoverage, smartDetectTable };
})();
