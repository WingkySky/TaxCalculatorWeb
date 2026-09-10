/* ============================================================
 * batch-source.js — BatchSource 批量多文件源管理
 * 多文件累积状态收口（_accumRows/_accumSources/_accumFileCount/_pendingFiles/_previewSourceId）、文件读取与解析入队、源列表构建与重置。
 * 对外接口：window.BatchSource。依赖：BatchParse/Exporter；BatchView 经运行时引用（晚于本模块加载）。
 * ============================================================ */
(function () {
'use strict';
  const { isGarbled, parseCSV, analyzeWorkbookSheets, buildSourceItem } = BatchParse;
  const { ensureXLSX } = Exporter;
function handleFile(e) {
  if (e.target.files.length) handleFiles(e.target.files);
}

// 多文件处理队列 — 支持分批累加
let _pendingFiles = 0;
let _accumRows = [];
let _accumFileCount = 0;   // 已累加的文件数
let _accumSources = [];
let _previewSourceId = '';

function handleFiles(fileList) {
  // 不再清空 _accumRows，实现分批累加
  const files = Array.from(fileList);
  _pendingFiles += files.length;
  _accumFileCount += files.length;
  updateAccumIndicator();
  files.forEach(f => processFile(f));
}

function updateAccumIndicator() {
  const el = document.getElementById('accum-indicator');
  if (_accumFileCount > 0) {
    const selectedSources = _accumSources.filter(s => s.selected);
    el.style.display = '';
    el.textContent = ` 已累加 ${_accumFileCount} 个文件（${selectedSources.length} 个已选数据表，${_accumRows.length} 行数据），可继续上传更多文件`;
  } else {
    el.style.display = 'none';
  }
}

function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'csv') {
    const reader = new FileReader();
    reader.onload = e => {
      let text = e.target.result;
      if (isGarbled(text)) {
        const reader2 = new FileReader();
        reader2.onload = e2 => {
          _accumSources.push(buildSourceItem({
            type: 'csv',
            fileName: file.name,
            rows: parseCSV(e2.target.result),
            selected: true
          }));
          onFileParsed();
        };
        reader2.readAsText(file, 'gbk');
      } else {
        _accumSources.push(buildSourceItem({
          type: 'csv',
          fileName: file.name,
          rows: parseCSV(text),
          selected: true
        }));
        onFileParsed();
      }
    };
    reader.readAsText(file, 'utf-8');
  } else if (['xlsx', 'xls'].includes(ext)) {
    ensureXLSX(() => readExcel(file));
  } else {
    alert('不支持的文件格式，请上传 CSV 或 Excel 文件');
    _pendingFiles--;
  }
}

function readExcel(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const wb = XLSX.read(e.target.result, { type: 'array' });
    const sheetItems = analyzeWorkbookSheets(wb, file.name);
    sheetItems.forEach(item => _accumSources.push(item));
    onFileParsed();
  };
  reader.readAsArrayBuffer(file);
}

function onFileParsed() {
  _pendingFiles--;
  if (_pendingFiles <= 0) {
    window.BatchView.refreshBatchPreview();   // BatchView 晚于本模块加载，运行时引用
    document.getElementById('file-input').value = '';
  }
}

function collectSelectedRows() {
  const rows = [];
  _accumSources.filter(s => s.selected).forEach(source => {
    rows.push(...tagSourceRows(source));
  });
  return rows;
}

function collectPreviewRows() {
  const selectedSources = _accumSources.filter(s => s.selected);
  if (!selectedSources.length) return [];

  let previewSource = selectedSources.find(s => s.id === _previewSourceId);
  if (!previewSource) {
    previewSource = selectedSources[0];
    _previewSourceId = previewSource.id;
  }

  const rows = [];
  rows.push(...tagSourceRows(previewSource));
  return rows;
}

function tagSourceRows(source) {
  const rows = [];
  source.rows.forEach((row, idx) => {
    const tagged = Array.isArray(row) ? row.slice() : [row];
    tagged._sourceId = source.id;
    tagged._sheetName = source.sheetName || '';
    tagged._fileName = source.fileName || '';
    tagged._sheetMonthHint = source.analysis?.monthHint || '';
    tagged._sourceRowIndex = idx;
    rows.push(tagged);
  });
  return rows;
}

function buildBatchSourceLabel() {
  const selectedSources = _accumSources.filter(s => s.selected);
  const fileCount = new Set(selectedSources.map(s => s.fileName)).size;
  const sheetCount = selectedSources.filter(s => s.type === 'excel-sheet').length;
  if (sheetCount > 0) {
    return `${fileCount} 个文件 / ${selectedSources.length} 个数据表`;
  }
  return fileCount > 1 ? `${fileCount} 个文件合并` : (selectedSources[0]?.fileName || '批量数据');
}

function resetBatch() {
  _pendingFiles = 0;
  _accumRows = [];
  _accumSources = [];
  _previewSourceId = '';
  _accumFileCount = 0;
  window._batchParsed = null;
  window._batchFilename = null;
  window._batchResults = null;
  window._colMappingState = null;
  document.getElementById('batch-preview').style.display = 'none';
  document.getElementById('batch-result').style.display = 'none';
  document.getElementById('file-input').value = '';
  updateAccumIndicator();
  batchDirection = 'forward';
  batchGapReset = true;
}
// ---- 跨模块状态访问器（batch-view / 门面经此读写累积状态）----
window.BatchSource = { accumFileCount: () => _accumFileCount, accumRows: () => _accumRows, accumSources: () => _accumSources,
  pendingFiles: () => _pendingFiles, previewSourceId: () => _previewSourceId,
  setAccumRows: (rows) => { _accumRows = rows; }, setPreviewSourceId: (id) => { _previewSourceId = id; },
  buildBatchSourceLabel, buildSourceItem, collectPreviewRows, collectSelectedRows, handleFile, handleFiles, onFileParsed,
  processFile, readExcel, resetBatch, tagSourceRows, updateAccumIndicator };
})();
