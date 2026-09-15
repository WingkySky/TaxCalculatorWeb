/* ============================================================
 * page-batch.js — PageBatch 批量计算门面与编排
 * 职责：聚合 batch-parse/calc/source/view/export 五模块为单一 window.PageBatch
 *       命名空间（index.html 内联事件与其他模块零感知）；
 *       编排 解析→分组→预览（processWithMapping）与 计算→渲染（runBatchCalc）；
 *       上传区拖拽事件绑定。
 * 对外接口：window.PageBatch（聚合 BatchParse/BatchCalc/BatchSource/BatchView/BatchExport
 *           全部公开成员 + processWithMapping/runBatchCalc/uploadArea）。
 * 依赖：BatchParse/BatchCalc/BatchSource/BatchView/BatchExport/PageShared/TaxUtils/TaxState。
 * ============================================================ */
(function () {
'use strict';
  const { parseAmount, parseFundRate } = TaxUtils;
  const { compareMonth, extractMonthHintFromRows, extractSortDateTime, extractYearHint, isSummaryLikeRow,
    normalizeMonthWithHint, rowHasUsableIdentity, sanitizeBankCard, sanitizeIdCard, sanitizeName, sanitizePhone,
    smartDetectTable } = BatchParse;
  const { buildPersonKey, groupPersons, runBatchLaborPass, runBatchSalaryPerson } = BatchCalc;
  const { handleFiles, previewSourceId, tagSourceRows } = BatchSource;
  const { renderBatchResults, showBatchPreview } = BatchView;
  const { identityFlagsOf } = PageShared;

// ==================== 上传区事件 ====================

const uploadArea = document.getElementById('upload-area');
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length) handleFiles(files);
});

/**
 * 用确认的列映射解析数据 → 展示预览
 */
function processWithMapping(dataRows, colMap, filename, sourceItems = []) {
  window._batchParsed = null;
  window._batchFilename = null;
  window._batchResults = null;
  document.getElementById('batch-result').style.display = 'none';

  const monthWarnings = [];
  const parseRowsWithMap = (rows, rowColMap) => {
    const parsedRows = [];
    rows.forEach(row => {
      if (isSummaryLikeRow(row)) return;
      let month = '', amount = 0, name = '默认', idCard = '', phone = '', bankCard = '';
      let socialBase = '', fundBase = '', fundRate = '', extraDeduction = '', bonus = '';
      let city = '';
      let withholdRate = '';
      const monthHint = row._sheetMonthHint || '';

      // 金额类单元格：空值保留 ''（区别于显式 0），供行内值优先/全局兜底判断
      const readAmt = (ci) => {
        const v = String(row[ci] == null ? '' : row[ci]).trim();
        if (v === '') return '';
        const num = parseAmount(v);
        return isNaN(num) ? '' : num;
      };

      if (rowColMap.name != null) name = String(row[rowColMap.name] || '').trim();
      if (rowColMap.month != null) month = normalizeMonthWithHint(String(row[rowColMap.month] || ''), monthHint);
      if (rowColMap.amount != null) amount = parseAmount(String(row[rowColMap.amount] || ''));
      if (rowColMap.idCard != null) idCard = sanitizeIdCard(row[rowColMap.idCard]);
      if (rowColMap.phone != null) phone = sanitizePhone(row[rowColMap.phone]);
      if (rowColMap.bankCard != null) bankCard = sanitizeBankCard(row[rowColMap.bankCard]);
      if (rowColMap.socialBase != null) socialBase = readAmt(rowColMap.socialBase);
      if (rowColMap.fundBase != null) fundBase = readAmt(rowColMap.fundBase);
      if (rowColMap.fundRate != null) fundRate = parseFundRate(row[rowColMap.fundRate]);
      if (rowColMap.extraDeduction != null) extraDeduction = readAmt(rowColMap.extraDeduction);
      if (rowColMap.bonus != null) bonus = readAmt(rowColMap.bonus);
      if (rowColMap.city != null) city = String(row[rowColMap.city] == null ? '' : row[rowColMap.city]).trim();
      /* 平台核定代征税率（如灵工发放表「个税核定代征税率 0.10」）：解析为小数比例，供核定口径计税 */
      if (rowColMap.withholdRate != null) withholdRate = parseFundRate(row[rowColMap.withholdRate]);
      if ((!month || month === '-') && monthHint) month = monthHint;
      name = sanitizeName(name) || '默认';

      if (!month || month === '-') {
        const inferredMonth = extractMonthHintFromRows([row], extractYearHint(monthHint));
        if (inferredMonth) month = inferredMonth;
      }

      const personKey = buildPersonKey({ name, idCard, phone, bankCard });

      if (amount > 0 && rowHasUsableIdentity({ name, idCard, phone, bankCard })) {
        const monthRaw = String(rowColMap.month != null ? (row[rowColMap.month] == null ? '' : row[rowColMap.month]) : '').trim();
        /* 月份闸门：所有解析途径（月份列/表内提示/行扫描）走完后仍不是 YYYY-MM 时，
           统一按当前年月测算并显式记录告警——绝不让非法月份透传进计税链
           （非法月份会使累计链按行复位、政策匹配回落最新年度，静默错算）。 */
        if (!/^\d{4}-\d{2}$/.test(month)) {
          const now = new Date();
          const fallbackYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          monthWarnings.push({
            type: rowColMap.month == null ? 'noColumn' : (monthRaw ? 'unrecognized' : 'empty'),
            sourceSheet: row._sheetName || '',
            sourceFile: row._fileName || '',
            sourceRowIndex: row._sourceRowIndex ?? 0,
            raw: monthRaw,
            resolved: fallbackYM
          });
          month = fallbackYM;
        }
        parsedRows.push({
          month,
          monthRaw,
          sortTime: extractSortDateTime(monthRaw),
          amount,
          socialBase,
          fundBase,
          fundRate,
          extraDeduction,
          bonus,
          city,
          withholdRate,
          person: name,
          idCard,
          phone,
          bankCard,
          personKey,
          sourceRowIndex: row._sourceRowIndex ?? 0,
          sourceSheet: row._sheetName || '',
          sourceFile: row._fileName || ''
        });
      }
    });
    return parsedRows;
  };

  const preferredTypes = Object.keys(colMap);
  const buildLocalColMap = (headerRow, localDataRows) => {
    const detected = BatchParse.detectColumnMapping(headerRow, localDataRows);
    const localColMap = {};
    const byType = {};
    Object.entries(detected.cols || {}).forEach(([ci, col]) => {
      if (col.type && byType[col.type] == null) byType[col.type] = Number(ci);
    });

    preferredTypes.forEach(type => {
      if (byType[type] != null) {
        localColMap[type] = byType[type];
      } else if (colMap[type] != null && headerRow[colMap[type]] != null) {
        localColMap[type] = colMap[type];
      }
    });
    return localColMap;
  };

  const selectedSources = (sourceItems || []).filter(item => item.selected);
  let parsed = [];

  if (selectedSources.length > 0) {
    selectedSources.forEach(source => {
      const taggedRows = tagSourceRows(source);
      const { headerRow, dataRows: sourceDataRows } = smartDetectTable(taggedRows);
      const localColMap = source.id === previewSourceId()
        ? { ...colMap }
        : buildLocalColMap(headerRow, sourceDataRows);

      if (localColMap.amount != null) {
        parsed.push(...parseRowsWithMap(sourceDataRows, localColMap));
      }
    });
  } else {
    parsed = parseRowsWithMap(dataRows, colMap);
  }

  const { personKeys, personsMap } = groupPersons(parsed);

  window._batchParsed = { parsed, personKeys, personsMap, sourceItems, monthWarnings };
  window._batchFilename = filename;
  showBatchPreview(parsed, personKeys, personsMap, filename);
}

/**
 * 执行批量计算（从预览区点击按钮触发）：分派计税 → 交 BatchView 渲染
 */
function runBatchCalc() {
  const data = window._batchParsed;
  if (!data) return alert('请先上传文件');

  const { parsed, personKeys, personsMap } = data;
  const filename = window._batchFilename || '批量数据';

  // 检测哪些身份列有数据
  const identityFlags = identityFlagsOf(parsed);

  /* 逐笔计税，根据月份判断政策类型 */
  const allResults = [];
  const compareBatchRecordOrder = (a, b) => {
    const monthCmp = compareMonth(a.month, b.month);
    if (monthCmp !== 0) return monthCmp;

    const ta = a.sortTime || '';
    const tb = b.sortTime || '';
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;

    const ia = Number.isFinite(a.sourceRowIndex) ? a.sourceRowIndex : 0;
    const ib = Number.isFinite(b.sourceRowIndex) ? b.sourceRowIndex : 0;
    return ia - ib;
  };

  personKeys.forEach(key => {
    const group = personsMap[key];
    const records = group.records.slice().sort(compareBatchRecordOrder);

    if (incomeType === 'salary') {
      allResults.push(...runBatchSalaryPerson(group, records));
      return;
    }
    allResults.push(...runBatchLaborPass(group, records));
  });

  renderBatchResults(allResults, filename, personKeys, personsMap, identityFlags);
}

// ==================== 命名空间聚合（外部零感知：window.PageBatch 成员与拆分前一致） ====================

window.PageBatch = Object.assign({}, BatchParse, BatchCalc, BatchSource, BatchView, BatchExport, {
  _accumFileCount: BatchSource.accumFileCount(),
  _accumRows: BatchSource.accumRows(),
  _accumSources: BatchSource.accumSources(),
  _pendingFiles: BatchSource.pendingFiles(),
  _previewSourceId: BatchSource.previewSourceId(),
  processWithMapping,
  runBatchCalc,
  uploadArea
});
})();
