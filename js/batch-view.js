/* ============================================================
 * batch-view.js — BatchView 批量页渲染与 UI 事件
 * 数据预览、列映射确认 UI、数据表选择 UI、显隐切换、批量结果渲染。仅 DOM 与模板字符串，不含计税逻辑。
 * 对外接口：window.BatchView。依赖：BatchParse/BatchSource/PageShared/TaxUtils/UI；门面经运行时引用。
 * ============================================================ */
(function () {
'use strict';
  const { formatNum, formatRate, round2 } = TaxUtils;
  const { COL_TYPE_LABELS, detectColumnMapping, smartDetectTable } = BatchParse;
  const { accumFileCount, accumSources, buildBatchSourceLabel, collectPreviewRows, collectSelectedRows,
    previewSourceId, setPreviewSourceId, setAccumRows, updateAccumIndicator } = BatchSource;
  const { gapResetRowHTML, identityFlagsOf, incomeIOLabels, oldPolicyRowHTML, siEmployerTooltip, siEmployerTotal, yearResetRowHTML } = PageShared;
function refreshBatchPreview() {
  const selectedRows = collectSelectedRows();
  setAccumRows(selectedRows);
  updateAccumIndicator();

  const container = document.getElementById('batch-preview');
  const resultBox = document.getElementById('batch-result');
  resultBox.style.display = 'none';

  if (selectedRows.length === 0) {
    const sourceHTML = renderSourceSelectionHTML(accumSources());
    container.style.display = '';
    container.innerHTML = `
      <div class="card" style="border-color:var(--t-border);">
        <div class="card-title"><span class="icon">${UI.icon("alert-triangle")}</span> 未选择可导入的数据表</div>
        <div style="font-size:14px;color:var(--t-text-2);">请至少勾选一个包含有效数据的 CSV 或 Sheet。</div>
        ${sourceHTML}
      </div>
    `;
    return;
  }

  const previewRows = collectPreviewRows();
  const { headerRow, headerRowIndex, dataRows } = smartDetectTable(previewRows);
  const label = buildBatchSourceLabel();
  showColumnMappingUI(previewRows, headerRow, headerRowIndex, dataRows, label, accumSources(), selectedRows);
}


function toggleRows(btn, selector) {
  const rows = document.querySelectorAll(selector);
  const hidden = rows[0]?.style.display === 'none';
  rows.forEach(r => r.style.display = hidden ? '' : 'none');
  btn.textContent = hidden ? '收起' : '展开全部';
}

function togglePersonTable(btn) {
  toggleRows(btn, '.person-extra');
}

function togglePreviewTable(btn) {
  toggleRows(btn, '.preview-extra');
}


/**
 * 显示列映射确认UI
 */
function showColumnMappingUI(rawRows, headerRow, headerRowIndex, dataRows, filename, sourceItems = [], selectedRows = rawRows) {
  const container = document.getElementById('batch-preview');
  const resultBox = document.getElementById('batch-result');
  resultBox.style.display = 'none';
  container.style.display = '';

  const autoMap = detectColumnMapping(headerRow, dataRows);
  window._colMappingState = { rawRows, headerRow, headerRowIndex, dataRows, filename, mapping: autoMap, sourceItems, selectedRows };

  // 统计
  const totalDataRows = dataRows.length;
  const sampleCount = Math.min(dataRows.length, 5);
  const skippedRows = headerRowIndex;

  // 构建列映射卡片
  let colsHTML = '';
  const colIndices = Object.keys(autoMap.cols).map(Number).sort((a, b) => a - b);
  colIndices.forEach(ci => {
    const col = autoMap.cols[ci];
    const isSelected = col.type !== '';
    colsHTML += `
      <div class="mapping-col ${isSelected ? 'selected' : ''}">
        <div class="col-idx">第 ${ci + 1} 列</div>
        <div class="col-header">${col.header}</div>
        <select data-col="${ci}" onchange="PageBatch.onMappingChange(this)">
          ${Object.entries(COL_TYPE_LABELS).map(([k, v]) =>
            `<option value="${k}" ${k === col.type ? 'selected' : ''}>${v}</option>`
          ).join('')}
        </select>
        <div class="col-sample">${col.samples.map(s => `<span>${s.length > 15 ? s.slice(0,15)+'…' : s}</span>`).join(' ')}</div>
      </div>`;
  });

  // 构建原始数据预览
  let previewRowsHTML = '';
  for (let ri = 0; ri < sampleCount; ri++) {
    const row = dataRows[ri] || [];
    previewRowsHTML += '<tr>';
    colIndices.forEach(ci => {
      const v = String(row[ci] || '');
      previewRowsHTML += `<td style="font-size:12px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${v || '<span style="color:var(--t-text-2);opacity:0.4;">—</span>'}</td>`;
    });
    previewRowsHTML += '</tr>';
  }
  if (dataRows.length > sampleCount) {
    previewRowsHTML += `<tr><td colspan="${colIndices.length}" style="text-align:center;color:var(--t-text-2);font-size:12px;padding:8px;">… 还有 ${dataRows.length - sampleCount} 行</td></tr>`;
  }

  let previewHeadHTML = '';
  colIndices.forEach(ci => {
    previewHeadHTML += `<th style="font-size:11px;white-space:nowrap;">${autoMap.cols[ci].header}</th>`;
  });

  const sourceHTML = renderSourceSelectionHTML(sourceItems);

  container.innerHTML = `
    <div class="card" style="border-color:var(--t-primary);border-width:1px;">
      <div class="card-title">
        <span style="display:flex;align-items:center;gap:8px;">
          <span class="icon">${UI.icon("eye")}</span>
          智能识别 — ${filename}
        </span>
        <span class="badge">自动检测</span>
      </div>

      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <div style="background:var(--t-bg-header);padding:8px 14px;border-radius:8px;font-size:13px;">
           发现 <strong style="color:var(--t-primary);">${totalDataRows}</strong> 行数据
        </div>
        <div style="background:var(--t-bg-header);padding:8px 14px;border-radius:8px;font-size:13px;">
           识别到 <strong style="color:var(--t-primary);">${colIndices.length}</strong> 列
        </div>
        ${skippedRows > 0 ? `<div style="background:var(--t-bg-header);padding:8px 14px;border-radius:8px;font-size:13px;">⏭ 跳过前 ${skippedRows} 行头部信息</div>` : ''}
      </div>

      ${sourceHTML}

      <div style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--t-text);"> 列映射 — 请确认或修改每列的用途</div>
      <div class="mapping-grid">${colsHTML}</div>

      <div style="background:var(--t-bg-header);border-radius:8px;padding:16px;border:1px solid var(--t-border);margin-bottom:16px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--t-text);"> 金额类型</div>
        <div style="display:flex;gap:16px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--t-text);">
            <input type="radio" name="amount-type" value="preTax" checked style="accent-color:var(--t-primary);"> ${incomeType === 'salary' ? '应发工资（将用累计预扣法计算个税）' : '税前收入（将用累计预扣法计算个税）'}
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--t-text);">
            <input type="radio" name="amount-type" value="postTax" style="accent-color:var(--t-primary);"> ${incomeType === 'salary' ? '实发工资（将反算应发工资）' : '税后收入（将反算税前金额）'}
          </label>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:13px;font-weight:600;color:var(--t-text-2);margin-bottom:8px;"> 原始数据预览（前 ${sampleCount} 行）</div>
        <div class="scroll-x" style="border:1px solid var(--t-border);border-radius:8px;">
          <table class="result-table" style="font-size:12px;">
            <thead><tr>${previewHeadHTML}</tr></thead>
            <tbody>${previewRowsHTML}</tbody>
          </table>
        </div>
      </div>

      <div style="display:flex;gap:12px;">
        <button class="btn btn-primary" style="flex:1;padding:12px;font-size:15px;" onclick="PageBatch.confirmColumnMapping()"> 确认映射并计算</button>
        <button class="btn btn-secondary" style="padding:12px;" onclick="PageBatch.resetBatch()"> 重新上传</button>
      </div>
    </div>
  `;
  UI.enhanceScrollX();
}

function renderSourceSelectionHTML(sourceItems) {
  if (!sourceItems || sourceItems.length <= 1) return '';

  const selectedCount = sourceItems.filter(item => item.selected).length;
  const rowsCount = sourceItems.filter(item => item.selected).reduce((sum, item) => sum + item.rows.length, 0);
  const cards = sourceItems.map(item => {
    const analysis = item.analysis || {};
    const score = typeof analysis.score === 'number' ? Math.max(0, Math.round(analysis.score)) : null;
    const monthHint = analysis.monthHint ? ` · 月份提示 ${analysis.monthHint}` : '';
    const desc = item.type === 'excel-sheet'
      ? `${item.fileName} / ${item.sheetName || 'Sheet'}`
      : item.fileName;
    const isPreview = item.id === previewSourceId();
    const isActive = isPreview || item.selected;
    return `
      <div style="padding:12px;border:1px solid ${isActive ? 'var(--t-primary)' : 'var(--t-border)'};border-radius:8px;background:${isActive ? 'var(--t-primary-bg)' : 'var(--t-bg-header)'};">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <input type="checkbox" ${item.selected ? 'checked' : ''} onchange='PageBatch.toggleBatchSource(${JSON.stringify(item.id)}, this.checked)' style="margin-top:2px;accent-color:var(--t-primary);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--t-text);word-break:break-word;">${desc}</div>
            <div style="font-size:12px;color:var(--t-text-2);margin-top:4px;">
              ${score != null ? `评分 ${score} 分 · ` : ''}${analysis.dataRowsCount || item.rows.length} 行${monthHint}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary" style="padding:6px 10px;font-size:12px;${isPreview ? 'border-color:var(--t-primary);color:var(--t-primary);' : ''}" onclick='PageBatch.setPreviewSource(${JSON.stringify(item.id)})'>${isPreview ? '已在预览' : '预览此表'}</button>
          <button type="button" class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick='PageBatch.selectOnlySource(${JSON.stringify(item.id)})'>仅用此表</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div style="background:var(--t-bg-header);border-radius:8px;padding:16px;border:1px solid var(--t-border);margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
        <div style="font-size:13px;font-weight:600;color:var(--t-text);"> 数据表选择</div>
        <div style="font-size:12px;color:var(--t-text-2);">已选 ${selectedCount} 个数据表，合计 ${rowsCount} 行</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;">${cards}</div>
      <div style="font-size:12px;color:var(--t-text-2);margin-top:10px;">系统会优先勾选最像明细数据的 Sheet；如果某个页只是汇总、模板或说明，可以取消勾选。</div>
    </div>
  `;
}

function toggleBatchSource(sourceId, checked) {
  const target = accumSources().find(item => item.id === sourceId);
  if (!target) return;
  target.selected = checked;
  if (checked) setPreviewSourceId(sourceId);
  if (!checked && previewSourceId() === sourceId) {
    setPreviewSourceId(accumSources().find(item => item.selected && item.id !== sourceId)?.id || '');
  }
  refreshBatchPreview();
}

function setPreviewSource(sourceId) {
  const target = accumSources().find(item => item.id === sourceId);
  if (!target) return;
  if (!target.selected) target.selected = true;
  setPreviewSourceId(sourceId);
  refreshBatchPreview();
}

function selectOnlySource(sourceId) {
  let matched = false;
  accumSources().forEach(item => {
    item.selected = item.id === sourceId;
    if (item.id === sourceId) matched = true;
  });
  if (!matched) return;
  setPreviewSourceId(sourceId);
  refreshBatchPreview();
}

function onMappingChange(sel) {
  const state = window._colMappingState;
  if (state) state.mapping.cols[sel.dataset.col].type = sel.value;
  sel.parentElement.classList.toggle('selected', !!sel.value);
}

function confirmColumnMapping() {
  const state = window._colMappingState;
  if (!state) return;

  // 构建列映射
  const colMap = {};
  Object.entries(state.mapping.cols).forEach(([ci, col]) => {
    if (col.type) colMap[col.type] = parseInt(ci);
  });

  if (colMap.amount == null) return alert('请至少映射一个「金额」列');

  // 金额类型
  const amountTypeRadio = document.querySelector('input[name="amount-type"]:checked');
  const amountType = amountTypeRadio ? amountTypeRadio.value : 'preTax';
  batchDirection = amountType === 'postTax' ? 'reverse' : 'forward';

  // 解析并展示预览
  window.PageBatch.processWithMapping(state.selectedRows || state.dataRows, colMap, state.filename, state.sourceItems);
}

/**
 * 预览导入数据（不计算）
 */
function showBatchPreview(parsed, personKeys, personsMap, filename) {
  const container = document.getElementById('batch-preview');
  const resultBox = document.getElementById('batch-result');
  resultBox.style.display = 'none'; // 隐藏旧结果
  container.style.display = '';

  // 统计信息
  const totalRows = parsed.length;
  const totalAmount = parsed.reduce((s, d) => s + d.amount, 0);
  const months = [...new Set(parsed.map(d => d.month).filter(m => m !== '-'))].sort();
  const monthRange = months.length > 0
    ? `${months[0]} ~ ${months[months.length - 1]}`
    : '未识别月份';

  // 检测哪些身份列有数据
  const { hasIdCard, hasPhone, hasBankCard } = identityFlagsOf(parsed);

  // 月份闸门告警：无法识别/为空/无月份列的行已按当前年月兜底，显式展示绝不静默
  const monthWarnings = (window._batchParsed && window._batchParsed.monthWarnings) || [];
  let monthWarningsHTML = '';
  if (monthWarnings.length) {
    const noCol = monthWarnings.filter(w => w.type === 'noColumn');
    const perRow = monthWarnings.filter(w => w.type !== 'noColumn');
    const lines = [];
    if (noCol.length) lines.push(`未识别到「月份」列：${noCol.length} 条记录已按当前年月 ${noCol[0].resolved} 测算`);
    if (perRow.length) {
      const detail = perRow.slice(0, 5).map(w => `第${w.sourceRowIndex + 1}行「${w.raw || '空'}」→ ${w.resolved}`).join('、');
      lines.push(`月份无法识别或为空：${perRow.length} 条记录已按当前年月测算（${detail}${perRow.length > 5 ? ' 等' : ''}）`);
    }
    monthWarningsHTML = `
      <div style="margin-bottom:20px;padding:12px 16px;background:var(--t-warning-bg);border-radius:8px;border:1px solid var(--t-warning);">
        <div style="font-size:13px;font-weight:600;color:var(--t-warning);margin-bottom:4px;">⚠ 月份信息不完整（已按当前年月兜底测算，请核对后重传）</div>
        ${lines.map(l => `<div style="font-size:12px;color:var(--t-text-2);">${l}</div>`).join('')}
      </div>`;
  }

  // 按人统计
  const personStats = personKeys.map(key => {
    const g = personsMap[key];
    const sum = g.records.reduce((s, d) => s + d.amount, 0);
    return { name: g.name, idCard: g.idCard, phone: g.phone, bankCard: g.bankCard, count: g.records.length, sum };
  });

  // 构建预览表头
  let previewHeadCols = '<th style="width:40px">#</th><th class="label-col">姓名</th>';
  if (hasIdCard) previewHeadCols += '<th>身份证号</th>';
  if (hasPhone) previewHeadCols += '<th>电话</th>';
  if (hasBankCard) previewHeadCols += '<th>银行卡号</th>';
  previewHeadCols += '<th>月份</th><th>金额</th>';

  container.innerHTML = `
    <div class="card" style="border-color:var(--t-primary);border-width:1px;">
      <div class="card-title"><span style="display:flex;align-items:center;gap:8px;"><span class="icon">${UI.icon("table")}</span> 数据预览 — ${filename}</span></div>

      <div class="summary-grid" style="margin-bottom:20px;">
        <div class="summary-item">
          <div class="label">总记录数</div>
        <div class="value blue">${totalRows}</div>
        </div>
        <div class="summary-item">
          <div class="label">涉及人数</div>
          <div class="value blue">${personKeys.length}</div>
        </div>
        <div class="summary-item">
          <div class="label">金额合计</div>
          <div class="value orange">¥${formatNum(totalAmount)}</div>
        </div>
        <div class="summary-item">
          <div class="label">月份范围</div>
          <div class="value" style="font-size:14px;color:var(--t-text);">${monthRange}</div>
        </div>
      </div>

      <!-- 分批上传提示 -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:12px 16px;background:var(--t-bg-header);border-radius:8px;border:1px solid var(--t-border);">
        <span style="font-size:14px;color:var(--t-text);flex:1;"> 已加载 <strong style="color:var(--t-primary);">${accumFileCount()}</strong> 个文件，共 <strong style="color:var(--t-primary);">${totalRows}</strong> 条记录</span>
        <label class="btn btn-secondary" style="padding:6px 14px;font-size:12px;margin:0;cursor:pointer;">
           继续上传
          <input type="file" accept=".csv,.xlsx,.xls" multiple onchange="PageBatch.handleFile(event)" style="display:none;">
        </label>
        <button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageBatch.resetBatch()"> 重置全部</button>
      </div>

      ${monthWarningsHTML}

      <!-- 人员汇总 + 数据预览（合并为紧凑区块） -->
      <div style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-size:13px;font-weight:600;color:var(--t-text-2);"> 人员汇总（${personKeys.length} 人）</div>
          ${personKeys.length > 15 ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;" onclick="PageBatch.togglePersonTable(this)">展开全部</button>` : ''}
        </div>
        <div class="scroll-x" style="border:1px solid var(--t-border);border-radius:8px;">
          <table class="result-table" style="font-size:13px;">
            <thead>
              <tr>
                <th style="width:40px">#</th>
                <th class="label-col">姓名</th>
                ${hasIdCard ? '<th>身份证号</th>' : ''}
                <th>记录数</th>
                <th>金额合计</th>
              </tr>
            </thead>
            <tbody>
              ${personStats.map((p, i) => {
                const isHidden = i >= 15 ? ' class="person-extra" style="display:none;"' : '';
                let idCol = hasIdCard ? `<td style="font-size:12px;color:var(--t-text-2);">${p.idCard ? p.idCard.slice(0,6)+'****'+p.idCard.slice(-4) : '-'}</td>` : '';
                return `<tr${isHidden}>
                  <td>${i + 1}</td>
                  <td class="label-col">${p.name}</td>
                  ${idCol}
                  <td>${p.count}</td>
                  <td style="font-weight:600;color:var(--t-primary);">¥${formatNum(p.sum)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- 数据预览表 -->
      <div style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-size:13px;font-weight:600;color:var(--t-text-2);"> 数据明细（${parsed.length} 条）</div>
          ${parsed.length > 10 ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;" onclick="PageBatch.togglePreviewTable(this)">展开全部</button>` : ''}
        </div>
        <div class="scroll-x" style="border:1px solid var(--t-border);border-radius:8px;">
          <table class="result-table" style="font-size:13px;">
            <thead><tr>${previewHeadCols}</tr></thead>
            <tbody>
              ${parsed.map((d, i) => {
                const isHidden = i >= 10 ? ' class="preview-extra" style="display:none;"' : '';
                let cols = `<td>${i + 1}</td><td class="label-col">${d.person}</td>`;
                if (hasIdCard) cols += `<td style="font-size:12px;color:var(--t-text-2);">${d.idCard || '-'}</td>`;
                if (hasPhone) cols += `<td style="font-size:12px;color:var(--t-text-2);">${d.phone ? d.phone.slice(0,3)+'****'+d.phone.slice(-4) : '-'}</td>`;
                if (hasBankCard) cols += `<td style="font-size:12px;color:var(--t-text-2);">${d.bankCard ? '****'+d.bankCard.slice(-4) : '-'}</td>`;
                cols += `<td>${d.month}</td><td>¥${formatNum(d.amount)}</td>`;
                return `<tr${isHidden}>${cols}</tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- 选择方向并计算 -->
      <div style="background:var(--t-bg-header);border-radius:8px;padding:20px;border:1px solid var(--t-border);">
        <div style="font-size:14px;font-weight:600;margin-bottom:14px;color:var(--t-text);"> 选择计算方式${incomeType === 'salary' ? '（工资薪金 · 累计预扣）' : ''}</div>
        <div class="direction-toggle" style="margin-bottom:16px;">
          <button class="direction-btn active" data-dir="forward" data-target="batch">${incomeType === 'salary' ? '应发 → 实发' : '税前 → 税后'}</button>
          <button class="direction-btn" data-dir="reverse" data-target="batch">${incomeType === 'salary' ? '实发 → 应发' : '税后 → 税前'}</button>
        </div>
        ${incomeType === 'labor' ? `
        <div class="toggle-row" style="margin-bottom:16px;">
          <div>
            <div class="toggle-label"> 断月重置</div>
            <div class="toggle-hint">开启后，同一人相邻月份中断超过1个月，累计自动归零重新起算</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" checked onclick="TaxState.batchGapReset=this.checked;">
            <span class="slider"></span>
          </label>
        </div>` : `
        <div style="font-size:12px;color:var(--t-text-2);margin-bottom:16px;">三险一金按行内城市/整批城市政策自动计算：行内基数（按城市上下限 clamp）&gt; 整批设置/全局基数 &gt; 应发工资作基数（勾选后）；公积金比例按 行内「公积金比例」列 &gt; 「工资参数」档位；均无基数则记 0 并标注。整批城市与「按应发工资作基数」在上方「全局兜底设置」中配置。</div>`}
        <button class="btn btn-primary" onclick="PageBatch.runBatchCalc()" style="width:100%;padding:12px;font-size:15px;"> 开始计算</button>
      </div>
    </div>
  `;

  // 重新绑定方向按钮事件
  container.querySelectorAll('.direction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      btn.parentElement.querySelectorAll('.direction-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      batchDirection = dir;
    });
  });
  UI.enhanceScrollX();
}

function renderBatchResults(results, filename, personKeys, personsMap, identityFlags) {
  const container = document.getElementById('batch-result');
  container.style.display = '';

  const totalPre = results.reduce((s, r) => s + r.preTax, 0);
  const totalTax = results.reduce((s, r) => s + r.currentTax, 0);
  const totalPost = results.reduce((s, r) => s + r.postTax, 0);
  const totalEmployer = results.reduce((s, r) => s + siEmployerTotal(r._siDetail), 0);

  const isSalary = incomeType === 'salary';
  const { dirLabel: directionLabel, preLabel: preColLabel, postLabel: postColLabel } = incomeIOLabels(batchDirection);

  const { hasIdCard, hasPhone, hasBankCard } = identityFlags || {};

  // 按人分组（用 personKey 分组）
  const grouped = {};
  results.forEach(r => {
    const key = r.idCard ? 'ID:' + r.idCard : (r.personKey || r.person);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  // 生成每人一块的 HTML
  let seq = 0;
  const personBlocks = personKeys.map(key => {
    const rows = grouped[key];
    if (!rows) return '';

    const personName = rows[0].person;
    const personIdCard = rows[0].idCard || '';
    const personPhone = rows[0].phone || '';
    const personBankCard = rows[0].bankCard || '';

    // 按年分组
    const yearGroups = {};
    rows.forEach(r => {
      const yr = r.month.split('-')[0] || '-';
      if (!yearGroups[yr]) yearGroups[yr] = [];
      yearGroups[yr].push(r);
    });
    const years = Object.keys(yearGroups).sort();

    let personPre = 0, personTax = 0, personPost = 0, personEmployer = 0;
    rows.forEach(r => {
      personPre += r.preTax; personTax += r.currentTax; personPost += r.postTax;
      personEmployer += siEmployerTotal(r._siDetail);
    });

    // 构建身份信息标签
    let idBadges = '';
    if (hasIdCard && personIdCard) idBadges += `<span style="font-size:11px;color:var(--t-text-2);margin-left:8px;"> ${personIdCard.slice(0,6)}****${personIdCard.slice(-4)}</span>`;
    if (hasPhone && personPhone) idBadges += `<span style="font-size:11px;color:var(--t-text-2);margin-left:8px;"> ${personPhone.slice(0,3)}****${personPhone.slice(-4)}</span>`;
    if (hasBankCard && personBankCard) idBadges += `<span style="font-size:11px;color:var(--t-text-2);margin-left:8px;"> ${personBankCard}</span>`;

    // 表头额外列
    let extraHeadCols = '';
    if (hasIdCard) extraHeadCols += '<th>身份证号</th>';
    if (hasPhone) extraHeadCols += '<th>电话</th>';
    if (hasBankCard) extraHeadCols += '<th>银行卡号</th>';

    let yearSections = '';
    years.forEach((yr, yi) => {
      const yRows = yearGroups[yr];
      const gapColspan = (isSalary ? 14 : 9) + (hasIdCard?1:0) + (hasPhone?1:0) + (hasBankCard?1:0);
      const yearSep = yi > 0
        ? yearResetRowHTML(gapColspan, yr)
        : '';

      const dataRows = yRows.map(r => {
        seq++;
        let extraCols = '';
        if (hasIdCard) extraCols += `<td style="font-size:12px;color:var(--t-text-2);">${r.idCard || '-'}</td>`;
        if (hasPhone) extraCols += `<td style="font-size:12px;color:var(--t-text-2);">${r.phone || '-'}</td>`;
        if (hasBankCard) extraCols += `<td style="font-size:12px;color:var(--t-text-2);">${r.bankCard || '-'}</td>`;

        const gapMarker = r._isGap ? gapResetRowHTML(gapColspan, r.month) : '';

        const oldPolicyMarker = r._isOldPolicy ? oldPolicyRowHTML(gapColspan, r.month) : '';

        const cityWarnMarker = (r._cityUnknown || r._yearFallback)
          ? `<tr style="background:var(--t-warning-bg);"><td colspan="${gapColspan}" style="text-align:center;padding:8px;font-weight:600;color:var(--t-warning);font-size:12px;"> ${r.month}：${r._cityUnknown ? `城市「${r.city}」未识别，已回退全局城市；` : ''}${r._yearFallback ? '政策年度未精确匹配，已用最新年度' : ''}</td></tr>`
          : '';

        const siTitle = r._siDetail
          ? ` title="养老 ¥${formatNum(r._siDetail.pension)} / 医疗 ¥${formatNum(r._siDetail.medical)} / 失业 ¥${formatNum(r._siDetail.unemployment)} / 公积金 ${formatRate(r._siDetail.fundRateUsed)} ¥${formatNum(r._siDetail.fund)}"`
          : (r._siMissing ? ' title="行内与全局均未设置基数，三险一金按 0 计算"' : '');
        const erTitle = siEmployerTooltip(r._siDetail);
        const isBonusRow = !!r._isBonus;
        const bonusSep = isBonusRow && r._bonusSeparate;
        const cumCell = (v) => (bonusSep ? '—' : `¥${formatNum(v)}`);

        return gapMarker + oldPolicyMarker + cityWarnMarker + `
          <tr${isBonusRow ? ' style="background:rgba(22,119,255,0.06);"' : ''}>
            <td>${seq}</td>
            <td>${r.month}</td>
            ${isSalary ? `<td>${r.cityName || '-'}</td><td style="font-size:12px;color:var(--t-text-2);">${r.policyYearLabel || '-'}</td>` : ''}
            ${extraCols}
            <td>¥${formatNum(batchDirection === 'forward' ? r.preTax : r.postTax)}</td>
            ${isSalary ? `<td${siTitle}${r._siMissing ? ' style="color:var(--t-warning);"' : ''}>¥${formatNum(r.socialInsurance || 0)}</td><td${erTitle}>¥${formatNum(siEmployerTotal(r._siDetail))}</td><td>¥${formatNum(r.extraDeduction || 0)}</td>` : ''}
            <td>${cumCell(r.cumIncome)}</td>
            <td>${cumCell(r.cumDeduction)}</td>
            <td>${formatRate(r.rate)}<div style="font-size:10px;color:var(--t-text-2);">速算 ${formatNum(r.quick)}${isSalary && isBonusRow ? '（÷12）' : ''}</div></td>
            <td class="tax-col">¥${formatNum(r.currentTax)}</td>
            <td class="highlight">¥${formatNum(batchDirection === 'forward' ? r.postTax : r.preTax)}</td>
            <td>${isSalary ? (isBonusRow ? `年终奖·${r._bonusStrategy === 'combined' ? '并入综合所得' : '单独计税'}` : '累计预扣') : (r._withholdFlat ? `核定代征 ${formatRate(r._withholdRate)}` : (r._isOldPolicy ? '旧政策' : '新政策'))}</td>
          </tr>`;
      }).join('');

      yearSections += yearSep + dataRows;
    });

    const totalColspan = 2 + (hasIdCard?1:0) + (hasPhone?1:0) + (hasBankCard?1:0);

    return `
      <div style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--t-bg-header);border-radius:8px 8px 0 0;border:1px solid var(--t-border);border-bottom:none;">
          <span style="font-size:15px;font-weight:700;color:var(--t-text);"> ${personName}</span>
          ${idBadges}
          <span style="font-size:12px;color:var(--t-text-2);margin-left:8px;">共 ${rows.length} 条</span>
          <span style="font-size:12px;color:var(--t-text-2);margin-left:auto;">税额合计 <span style="color:var(--t-error);font-weight:600;">¥${formatNum(personTax)}</span></span>
          ${isSalary ? `<span style="font-size:12px;color:var(--t-text-2);">单位社保 <span style="color:var(--t-text-2);font-weight:600;">¥${formatNum(personEmployer)}</span></span>
          <span style="font-size:12px;color:var(--t-text-2);">企业总成本 <span style="color:var(--t-warning);font-weight:600;">¥${formatNum(round2(personPre + personEmployer))}</span></span>` : ''}
        </div>
        <div class="scroll-x" style="border:1px solid var(--t-border);border-radius:0 0 8px 8px;">
          <table class="result-table">
            <thead>
              <tr>
                <th>#</th>
                <th>月份</th>
                ${isSalary ? '<th>城市</th><th>政策年度</th>' : ''}
                ${extraHeadCols}
                <th>${preColLabel}</th>
                ${isSalary ? '<th>三险一金(个人)</th><th>单位社保公积金</th><th>专项附加</th>' : ''}
                <th>${isSalary ? '累计应发金额' : '累计发放金额'}</th>
                <th>累计减除费用</th>
                <th>适用税率</th>
                <th>预扣税额</th>
                <th>${postColLabel}</th>
                <th>${isSalary ? '计税方式' : '政策类型'}</th>
              </tr>
            </thead>
            <tbody>
              ${yearSections}
              <tr class="total-row">
                <td colspan="${totalColspan}">小计</td>
                <td>¥${formatNum(batchDirection === 'forward' ? personPre : personPost)}</td>
                ${isSalary ? `<td></td><td></td><td>¥${formatNum(rows.reduce((s, r) => s + (r.socialInsurance || 0), 0))}</td><td>¥${formatNum(personEmployer)}</td><td>¥${formatNum(rows.reduce((s, r) => s + (r.extraDeduction || 0), 0))}</td>` : ''}
                <td></td>
                <td>¥${formatNum(rows.reduce((s, r) => s + (r.cumDeduction || 0), 0))}</td>
                <td></td>
                <td class="tax-col">¥${formatNum(personTax)}</td>
                <td class="highlight">¥${formatNum(batchDirection === 'forward' ? personPost : personPre)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item">
        <div class="label">总记录数</div>
        <div class="value blue">${results.length}</div>
      </div>
      <div class="summary-item">
        <div class="label">涉及人数</div>
        <div class="value blue">${personKeys.length}</div>
      </div>
      <div class="summary-item">
        <div class="label">累计税额</div>
        <div class="value red">¥${formatNum(totalTax)}</div>
      </div>
      <div class="summary-item">
        <div class="label">${isSalary ? '累计实发' : '累计税后'}</div>
        <div class="value green">¥${formatNum(totalPost)}</div>
      </div>
      ${isSalary ? `
      <div class="summary-item">
        <div class="label">单位社保公积金</div>
        <div class="value" style="color:var(--t-text-2);">¥${formatNum(totalEmployer)}</div>
      </div>
      <div class="summary-item">
        <div class="label">企业用工总成本</div>
        <div class="value orange">¥${formatNum(round2(totalPre + totalEmployer))}</div>
      </div>` : ''}
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <span style="background:var(--t-primary);color:#fff;font-size:12px;padding:5px 14px;border-radius:20px;font-weight:700;"> ${directionLabel}</span>
      <span style="color:var(--t-text-2);font-size:13px;">计算模式</span>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px;flex-wrap:wrap;">
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:12px;" onclick="PageBatch.resetBatch()"> 重置数据</button>
      ${isSalary ? `<button class="btn btn-green" style="padding:6px 14px;font-size:12px;" onclick="PageBatch.exportBatchExcelFormula()"> 导出 Excel（公式明细）</button>` : ''}
      <button class="btn btn-green" style="padding:6px 14px;font-size:12px;" onclick="PageBatch.exportBatchCSV()"> 导出结果 CSV</button>
      <button class="btn btn-green" style="padding:6px 14px;font-size:12px;" onclick="PageReport.printReport('batch')"> 打印报告</button>
    </div>
    ${personBlocks}
  `;

  window._batchResults = results;
  UI.enhanceScrollX();
}
  window.BatchView = { confirmColumnMapping, onMappingChange, refreshBatchPreview, renderBatchResults,
    renderSourceSelectionHTML, selectOnlySource, setPreviewSource, showBatchPreview, showColumnMappingUI,
    toggleBatchSource, togglePersonTable, togglePreviewTable, toggleRows };
})();
