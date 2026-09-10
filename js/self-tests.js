/* ============================================================
 * self-tests.js — TaxTest 页面自检
 * 职责：六套件自检——计税与政策库 + 批量计税流水线 + 导出器组装 + 年度汇算 +
 *       分享链接 + 政策库同步，页面加载后自动运行并输出 console；
 *       node tests/run.js 跑同一份断言。
 * 对外接口：window.TaxTest.{runSelfTests, runBatchPipelineTests, runExporterTests, runExportStyleTests, runAll}。
 * 依赖：TaxEngine/PolicyLib/SocialIns/Exporter/PageShared/PageMulti/PageBatch/TaxState/TaxUtils。
 * ============================================================ */
(function () {
'use strict';
  const { round2, parseFundRate } = TaxUtils;
  const { calcBonusTaxSeparate, calcTaxForward, calcTaxReverse, calcSalaryCumulativeTax, compareBonusStrategies,
    findBonusTrapZone, getMonthlyBracket, isGapMonth, isNewPolicy, mergeBonusIntoEntries, TAX_STRATEGIES } = TaxEngine;
  const { CITY_POLICY_LIBRARY, findCityKey, resolvePolicy, rowsToLibrary, libraryToRows } = PolicyLib;
  const { computeSocialInsurance, computeSocialInsuranceDetail, computeExtraDetailFor, getExtraDeductionFor } = SocialIns;
  const { buildSalaryFormulaGrid, colLetter } = Exporter;
  const { buildBonusSeparateRow } = PageMulti;
  const { detectColumnMapping, groupPersons, makeBatchBonusSeparateRow, processWithMapping,
    runBatchLaborPass, runBatchSalaryPass, runBatchSalaryPerson } = PageBatch;
  const { buildBatchReportData, buildMultiReportData, maskBankCard, maskIdCard, maskPhone } = PageReport;
  const { estimateLaborWithholding, estimateSalaryWithholding, incomeOf, settle, EXTRA_ANNUAL_DEFAULTS } = TaxAnnual;
  const { decodeShare, encodeShare } = PageShare;

// ==================== Self tests ====================
// 控制台自检：城市政策库、逐险种 clamp、年度匹配、工资累计预扣、反算、劳务回归。
// 页面加载时自动运行，也可在控制台手动调用 runSelfTests() 查看明细。

function runSelfTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);

  const saved = JSON.parse(JSON.stringify(salaryParams));
  salaryParams.policyYear = 'auto';
  salaryParams.cityId = 'custom';
  salaryParams.fundRate = 0.12;
  salaryParams.socialBase = 10000;
  salaryParams.fundBase = '';
  salaryParams.extraDeduction = 1000;

  // —— 自定义城市（承接首版行为）：养老8% 医疗2% 失业0.5% 公积金12%，无上下限 ——
  eq('自定义城市三险一金 = 基数×22.5%', computeSocialInsurance(10000, ''), 2250);

  // —— 公积金月缴存额四舍五入取整到元 ——
  const customItems = resolvePolicy('custom', '2026-01').items;
  eq('公积金取整·500.5→501', computeSocialInsuranceDetail(10010, '', customItems, 0.05).fund, 501);
  eq('公积金取整·500.2→500', computeSocialInsuranceDetail(10004, '', customItems, 0.05).fund, 500);
  eq('公积金取整·公积金基数单独生效', computeSocialInsuranceDetail(10000, 8000, customItems, 0.12).fund, 960);

  // —— 城市政策：逐险种 clamp（广州2024年度：养老下限5500，医保按自然年6236，失业下限=最低工资2300）——
  const gz = resolvePolicy('guangzhou', '2025-06');
  isTrue('广州2025-06 匹配2024年度', gz.yearKey === '2024');
  const gzD = computeSocialInsuranceDetail(3000, '', gz.items, 0.05);
  eq('广州低基数·养老按下限5500', gzD.pension, round2(5500 * 0.08));
  eq('广州低基数·医疗按下限6236', gzD.medical, round2(6236 * 0.02));
  eq('广州低基数·失业(3000高于下限2300不clamp, 0.2%)', gzD.unemployment, round2(3000 * 0.002));
  eq('广州低基数·公积金(3000高于下限2300不clamp)', gzD.fund, round2(3000 * 0.05));
  eq('广州低基数·合计', gzD.total, round2(5500 * 0.08 + 6236 * 0.02 + 3000 * 0.002 + 3000 * 0.05));
  const gzHi = computeSocialInsuranceDetail(999999, '', gz.items, 0.05);
  eq('广州高基数·养老按上限27501', gzHi.pension, round2(27501 * 0.08));

  // —— 年度匹配：广州 7 月切换社保年度；固定年度覆盖 auto ——
  isTrue('广州2025-07 匹配2025年度', resolvePolicy('guangzhou', '2025-07').yearKey === '2025');
  isTrue('广州2024-06 匹配2023年度', resolvePolicy('guangzhou', '2024-06').yearKey === '2023');
  salaryParams.policyYear = '2024';
  isTrue('固定年度覆盖自动匹配', resolvePolicy('guangzhou', '2025-07').yearKey === '2024');
  salaryParams.policyYear = 'auto';
  isTrue('无匹配月份回退最新年度并标注', resolvePolicy('guangzhou', '2030-01').matched === false);

  // —— 城市别名与未知城市 ——
  isTrue('别名匹配「广州市」', findCityKey('广州市') === 'guangzhou');
  isTrue('未知城市返回 null', findCityKey('火星市') == null);

  // —— 2026 年度数据（外置 tax-policy-data.js）——
  isTrue('政策数据文件已加载（≥12城+自定义）', Object.keys(CITY_POLICY_LIBRARY).length >= 13);
  isTrue('广州2026-09 匹配2026年度（广东沿用过渡）', (() => { const p = resolvePolicy('guangzhou', '2026-09'); return p.yearKey === '2026' && p.matched; })());
  isTrue('北京2026-08 养老上限36348', resolvePolicy('beijing', '2026-08').items.pension.upper === 36348);
  isTrue('上海2026-07 养老下限7546', resolvePolicy('shanghai', '2026-07').items.pension.lower === 7546);
  isTrue('深圳2026-09 公积金下限2700（2026-09-01起新职工）', resolvePolicy('shenzhen', '2026-09').items.fund.lower === 2700);

  // —— 广东 2026-09-01 最低工资调整（粤府函〔2026〕188号）——
  isTrue('广州2026-09 公积金下限2680（随最低工资）', resolvePolicy('guangzhou', '2026-09').items.fund.lower === 2680);
  isTrue('深圳2026-09 失业下限2700/上限48471（随最低工资）', (() => {
    const u = resolvePolicy('shenzhen', '2026-09').items.unemployment;
    return u.lower === 2700 && u.upper === 48471;
  })());
  isTrue('广州2025年度公积金下限2500（2025-03起旧最低工资）', resolvePolicy('guangzhou', '2025-09').items.fund.lower === 2500);

  // —— 广深分险种口径核实（2025-09-04 检索）——
  isTrue('广州2025社保年度失业=最低工资2500/上限41112', (() => {
    const u = resolvePolicy('guangzhou', '2025-09').items.unemployment;
    return u.lower === 2500 && u.upper === 41112;
  })());
  isTrue('广州医保按自然年：2025为6236/31179', resolvePolicy('guangzhou', '2025-09').items.medical.lower === 6236);
  isTrue('深圳公积金2025年度=2360/44265（下限按2024最低工资口径）', (() => {
    const f = resolvePolicy('shenzhen', '2025-09').items.fund;
    return f.lower === 2360 && f.upper === 44265;
  })());

  // —— Excel/JSON 扁平转换 roundtrip ——
  const rtLib = rowsToLibrary(libraryToRows(CITY_POLICY_LIBRARY)).library;
  isTrue('政策库 Excel 扁平转换 roundtrip', JSON.stringify(rtLib) === JSON.stringify(CITY_POLICY_LIBRARY));

  // —— 广州 vs 深圳同薪差异（分城市政策生效）——
  const sz = resolvePolicy('shenzhen', '2025-06');
  const gz8000 = computeSocialInsuranceDetail(8000, '', gz.items, 0.05);
  const sz8000 = computeSocialInsuranceDetail(8000, '', sz.items, 0.05);
  isTrue('广州深圳同薪三险一金不同', gz8000.total !== sz8000.total);

  // —— 批量「公积金比例」列：多写法解析与行内择档 ——
  eq('parseFundRate 5→0.05', parseFundRate('5'), 0.05);
  eq('parseFundRate 12→0.12', parseFundRate('12'), 0.12);
  eq('parseFundRate 0.05→0.05', parseFundRate('0.05'), 0.05);
  eq('parseFundRate "5%"→0.05', parseFundRate('5%'), 0.05);
  isTrue('parseFundRate 空串→空（回退全局）', parseFundRate('') === '');
  isTrue('parseFundRate 120→空（非法）', parseFundRate('120') === '');
  isTrue('parseFundRate 负数→空（非法）', parseFundRate('-3') === '');
  isTrue('行内公积金比例生效：12%≠5% 缴存额', (() => {
    const d12 = computeSocialInsuranceDetail(10000, '', customItems, 0.12);
    const d05 = computeSocialInsuranceDetail(10000, '', customItems, 0.05);
    return d12.fund !== d05.fund && d12.fundRateUsed === 0.12 && d05.fundRateUsed === 0.05;
  })());
  isTrue('列识别：「公积金比例」→fundRate（不与基数列冲突）', (() => {
    const m = detectColumnMapping(['姓名', '应发工资', '公积金比例', '社保基数'], [['张三', 10000, 5, 10000]]);
    return m.cols[2].type === 'fundRate' && m.cols[3].type === 'socialBase';
  })());
  isTrue('列识别：「三险一金」表头不再映射任何类型', (() => {
    const m = detectColumnMapping(['姓名', '应发工资', '三险一金'], [['张三', 10000, 2250]]);
    return m.cols[2].type === '';
  })());
  isTrue('列识别：模板表头结构（公积金比例列 + 专项附加列）', (() => {
    const m = detectColumnMapping(
      ['姓名', '身份证号', '月份', '应发工资', '城市', '社保基数', '公积金基数', '公积金比例', '专项附加扣除'],
      [['张三', '110101199001011234', '2026-01', 10000, '广州', 10000, 10000, 5, 1000]]);
    return m.cols[7].type === 'fundRate' && m.cols[8].type === 'extraDeduction';
  })());
  isTrue('列识别：「年终奖」→bonus（不与金额列冲突）', (() => {
    const m = detectColumnMapping(
      ['姓名', '应发工资', '年终奖', '社保基数'],
      [['张三', 10000, 36000, 10000]]);
    return m.cols[1].type === 'amount' && m.cols[2].type === 'bonus' && m.cols[3].type === 'socialBase';
  })());

  // —— 政策库 JSON roundtrip ——
  const snapshot = JSON.stringify(CITY_POLICY_LIBRARY);
  isTrue('政策库导入导出 roundtrip', JSON.stringify(JSON.parse(snapshot)) === snapshot);

  // —— 工资薪金累计预扣（验收算例：月薪1万、三险一金2250、专项附加1000）——
  const ctx = { socialInsurance: 2250, extraDeduction: 1000 };
  let cumIncome = 0, cumTax = 0, cumDeduction = 0;
  const monthly = [];
  for (let m = 1; m <= 3; m++) {
    cumDeduction += 5000 + 2250 + 1000;
    const r = calcTaxForward(10000, cumIncome, cumDeduction, cumTax, TAX_STRATEGIES.salary, ctx);
    cumIncome = r.cumIncome; cumTax = r.cumTaxDue;
    monthly.push(r);
  }
  eq('工资1月个税 52.50', monthly[0].currentTax, 52.5);
  eq('工资1月实发 7697.50', monthly[0].postTax, 7697.5);
  eq('工资2月个税 52.50（累计递进）', monthly[1].currentTax, 52.5);
  eq('工资3月累计应纳税所得额 5250', monthly[2].taxableIncome, 5250);
  eq('工资3月累计个税 157.50', monthly[2].cumTaxDue, 157.5);

  // —— 反算往返：实发 7697.50 → 应发 10000 ——
  const rev = calcTaxReverse(7697.5, 0, 8250, 0, TAX_STRATEGIES.salary, ctx);
  eq('工资反算应发 10000', rev.preTax, 10000, 0.01);
  eq('工资反算实发回代 7697.50', rev.postTax, 7697.5, 0.01);

  // 高薪跳档：月薪3万，第2个月进入10%档
  const r1 = calcTaxForward(30000, 0, 8250, 0, TAX_STRATEGIES.salary, ctx);
  const r2 = calcTaxForward(30000, r1.cumIncome, 16500, r1.cumTaxDue, TAX_STRATEGIES.salary, ctx);
  eq('工资高薪1月个税（3%档）652.50', r1.currentTax, 652.5);
  eq('工资高薪2月个税（10%档）1177.50', r2.currentTax, 1177.5);

  // —— 劳务报酬回归（默认策略行为不变）——
  const l1 = calcTaxForward(10000, 0, 5000, 0);
  eq('劳务预扣收入额 ×80% = 8000', l1.withholdingIncome, 8000);
  eq('劳务1月个税 90', l1.currentTax, 90);
  eq('劳务1月税后 9910', l1.postTax, 9910);
  const lrev = calcTaxReverse(9910, 0, 5000, 0);
  eq('劳务反算税前 10000', lrev.preTax, 10000, 0.01);
  const l2 = calcTaxForward(10000, l1.cumIncome, 10000, l1.cumTaxDue);
  eq('劳务2月个税 90（累计递进）', l2.currentTax, 90);

  // —— 年终奖单独计税（÷12 定档）——
  eq('年终奖36000 → 3% 档税额 1080', calcBonusTaxSeparate(36000), 1080);
  eq('年终奖144000 → 10% 档税额 14190', calcBonusTaxSeparate(144000), 14190);
  eq('年终奖36001 → 跳 10% 档税额 3390.10', calcBonusTaxSeparate(36001), 3390.1);
  eq('年终奖123456.78 → 10% 档税额 12135.68', calcBonusTaxSeparate(123456.78), 12135.68);

  // —— 年终奖无效区间（六段边界）——
  isTrue('无效区间 37000 命中，建议回到 36000', (() => {
    const z = findBonusTrapZone(37000);
    return z && z.suggest === 36000 && z.to > 38566 && z.to < 38567;
  })());
  isTrue('无效区间上沿 38566.67 仍命中', !!findBonusTrapZone(38566.67));
  isTrue('无效区间外 40000 不命中', findBonusTrapZone(40000) == null);
  isTrue('144000 恰在下沿不命中', findBonusTrapZone(144000) == null);
  isTrue('144001 命中第二段', (() => {
    const z = findBonusTrapZone(144001);
    return z && z.suggest === 144000;
  })());
  isTrue('1120000 命中最末段，1120000.01 不命中', !!findBonusTrapZone(1120000) && findBonusTrapZone(1120000.01) == null);

  // —— 年终奖方案对比：月薪1万×12（三险一金2250+附加1000）+ 发12月年终奖36000 ——
  const bonusEntries = [];
  for (let m = 1; m <= 12; m++) {
    bonusEntries.push({ month: '2026-' + String(m).padStart(2, '0'), amount: 10000, si: 2250, extra: 1000 });
  }
  eq('全年工资累计税额（无年终奖）630', calcSalaryCumulativeTax(bonusEntries), 630);
  const bonusPlan = compareBonusStrategies(bonusEntries, { amount: 36000, month: '2026-12' });
  eq('方案对比·单独计税税额 1080', bonusPlan.separateTax, 1080);
  eq('方案对比·并入增量 2550', bonusPlan.combinedBonusTax, 2550);
  eq('方案对比·并入全年合计 3180', bonusPlan.combinedTotalTax, 3180);
  isTrue('方案对比·推荐单独计税，节税 1470', bonusPlan.recommendation === 'separate' && bonusPlan.saving === 1470);
  const bonusPlanHi = compareBonusStrategies(bonusEntries, { amount: 36000, month: '2026-01' });
  isTrue('方案对比·并入发放月不影响全年合计（3180）', bonusPlanHi.combinedTotalTax === 3180);
  const bonusMerge = mergeBonusIntoEntries(bonusEntries.slice(0, 2), { amount: 36000, month: '2026-01' });
  isTrue('年终奖插入发放月工资之后', bonusMerge.length === 3 && bonusMerge[1].isBonus === true && bonusMerge[2].month === '2026-02');

  // —— 单位部分社保（自定义城市：单位养老16% 医疗8% 失业0.5% 工伤0.2%，公积金同个人档）——
  const erDet = computeSocialInsuranceDetail(10000, '', customItems, 0.05);
  eq('单位养老 1600', erDet.employer.pension, 1600);
  eq('单位医疗 800', erDet.employer.medical, 800);
  eq('单位失业 50', erDet.employer.unemployment, 50);
  eq('单位工伤 20', erDet.employer.injury, 20);
  eq('单位公积金同个人档 500', erDet.employer.fund, 500);
  eq('单位合计 2970', erDet.employer.total, 2970);

  // —— 专项附加分项（含互斥与上限校验）——
  isTrue('分项合计：子女2000+房租1500+赡养3000=6500', (() => {
    const r = computeExtraDetailFor({
      childEducation: { on: true, count: 1 },
      houseRent: { on: true, tier: 1500 },
      support: { on: true, mode: 'solo' }
    }, '2026-01');
    return r.total === 6500 && r.messages.length === 0;
  })());
  isTrue('分项校验：房贷房租互斥提示且按房贷计', (() => {
    const r = computeExtraDetailFor({
      houseLoan: { on: true }, houseRent: { on: true, tier: 1500 }
    }, '2026-01');
    return r.total === 1000 && r.messages.some(m => m.indexOf('互斥') >= 0);
  })());
  isTrue('分项校验：非独生分摊 2000 → 按 1500 计并提示', (() => {
    const r = computeExtraDetailFor({ support: { on: true, mode: 'share', share: 2000 } }, '2026-01');
    return r.total === 1500 && r.messages.length === 1;
  })());
  isTrue('职业资格 3600 仅取得当月计入', (() => {
    const d = { education: { on: true, kind: 'cert', certMonth: '2026-06' } };
    const a = computeExtraDetailFor(d, '2026-06').total;
    const b = computeExtraDetailFor(d, '2026-07').total;
    return a === 3600 && b === 0;
  })());
  isTrue('大病医疗不计入月度预扣，返回年度金额', (() => {
    const r = computeExtraDetailFor({ medical: { on: true, annual: 40000 } }, '2026-01');
    return r.total === 0 && r.medicalAnnual === 40000 && r.messages.length === 1;
  })());
  eq('单一总额模式回退：getExtraDeductionFor', getExtraDeductionFor('2026-01').total, 1000);

  // —— Excel 公式明细网格：公式与缓存值抽查 ——
  const gridRows = [];
  (() => {
    let cumIncome = 0, cumTaxT = 0, cumDed = 0, cumSIg = 0, cumEx = 0;
    for (let m = 1; m <= 2; m++) {
      const ym = '2026-0' + m;
      const siD = computeSocialInsuranceDetail(10000, '', customItems, 0.05);
      cumDed += 5000 + siD.total + 1000;
      const rr = calcTaxForward(10000, cumIncome, cumDed, cumTaxT, TAX_STRATEGIES.salary, { socialInsurance: siD.total, extraDeduction: 1000 });
      cumIncome = rr.cumIncome; cumTaxT = rr.cumTaxDue;
      cumSIg = round2(cumSIg + siD.total); cumEx = round2(cumEx + 1000);
      gridRows.push({
        month: ym, person: '测试', preTax: 10000, postTax: rr.postTax, withholdingIncome: rr.withholdingIncome,
        cumIncome: rr.cumIncome, cumDeduction: rr.cumDeduction, taxableIncome: rr.taxableIncome,
        rate: rr.rate, quick: rr.quick, cumTaxDue: rr.cumTaxDue, currentTax: rr.currentTax,
        extraDeduction: 1000, socialInsurance: siD.total,
        _siDetail: siD, _cumSI: cumSIg, _cumExtra: cumEx, _isBonus: false
      });
    }
  })();
  const grid = buildSalaryFormulaGrid(gridRows, {
    chainKey: () => '2026', cityOf: () => 'custom', nameOf: () => '测试', cityLabel: () => '自定义政策'
  });
  isTrue('公式导出·养老公式为 ROUND(F2*0.08,2) 且缓存一致', (() => {
    const cell = grid.rows[0][8];
    return cell.f === 'ROUND(F2*0.08,2)' && Math.abs(cell.v - gridRows[0]._siDetail.pension) < 1e-9;
  })());
  isTrue('公式导出·公积金基数引用社保基数（=F2），缴存额 ROUND(G2*H2,0)', (() => {
    return grid.rows[0][6].f === 'F2' && grid.rows[0][11].f === 'ROUND(G2*H2,0)';
  })());
  isTrue('公式导出·单位养老公式 ROUND(F2*0.16,2)', grid.rows[0][13].f === 'ROUND(F2*0.16,2)');
  isTrue('公式导出·累计应发跨行相加（V2+E3）', grid.rows[1][21].f === 'V2+E3');
  isTrue('公式导出·本期预扣 MAX(0,AC3-AD3) 且缓存一致', (() => {
    const cell = grid.rows[1][30];
    return cell.f === 'MAX(0,AC3-AD3)' && Math.abs(cell.v - gridRows[1].currentTax) < 1e-9;
  })());
  isTrue('公式导出·税率列嵌套 IF 引用累计应纳税所得额', (() => {
    const f = grid.rows[0][26].f;
    return f.indexOf('Z2<=36000') >= 0 && f.indexOf('0.45') >= 0;
  })());
  isTrue('公式导出·派生列公式与缓存值成对出现', grid.rows.slice(0, 2).every(row =>
    [21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 32].every(ci => row[ci] && row[ci].f && typeof row[ci].v === 'number')));
  isTrue('公式导出·年终奖独立行用 ÷12 档公式且不进累计链', (() => {
    const bonusRow = buildBonusSeparateRow({ amount: 36000, month: '2026-02' }, gridRows);
    const withBonus = gridRows.concat([bonusRow]);
    const g2 = buildSalaryFormulaGrid(withBonus, {
      chainKey: () => '2026', cityOf: () => 'custom', nameOf: () => '测试', cityLabel: () => '自定义政策'
    });
    const last = g2.rows[2];
    return last[26].f.indexOf('/12<=3000') >= 0 && last[21] === null && last[30].f === 'ROUND(MAX(0,E4*AA4-AB4),2)' && last[30].v === 1080;
  })());

  Object.assign(salaryParams, saved);

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 个税计算自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 个税计算自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 批量计税流水线自检 ====================
// 覆盖：processWithMapping 解析/映射/分组 → runBatchSalaryPass（三险一金兜底链、
// 城市链、累计链、反算）→ runBatchSalaryPerson（年终奖双方案择优）→
// makeBatchBonusSeparateRow；劳务侧为引擎级 isGapMonth / isNewPolicy 判定
// （逐行计算与渲染接线属 DOM 流程，留在浏览器冒烟覆盖）。

function runBatchPipelineTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);

  const saved = JSON.parse(JSON.stringify(salaryParams));
  const savedBatch = { dir: batchDirection, city: batchCityId, grossAsBase: batchGrossAsBase, gap: batchGapReset };
  salaryParams.policyYear = 'auto';
  salaryParams.cityId = 'custom';
  salaryParams.socialBase = 0;
  salaryParams.fundBase = '';
  salaryParams.fundRate = 0.12;
  salaryParams.extraDeduction = 1000;
  batchDirection = 'forward';
  batchCityId = '';
  batchGrossAsBase = false;

  const group = { name: '张三', idCard: '', phone: '', bankCard: '' };
  const rec = (month, amount, extra) => Object.assign(
    { month, amount, socialBase: '', fundBase: '', fundRate: '', extraDeduction: '', bonus: '', city: '' },
    extra || {});

  // —— 三险一金兜底链：行内基数 > 全局基数 > 按应发工资作基数（勾选）> 记 0 标注 ——
  let rows = runBatchSalaryPass(group, [rec('2026-01', 10000, { socialBase: 10000 })], []);
  eq('批量兜底链·行内基数 10000×22.5%', rows[0]._siDetail.total, 2250);
  salaryParams.socialBase = 8000;
  rows = runBatchSalaryPass(group, [rec('2026-01', 10000)], []);
  eq('批量兜底链·全局基数 8000×22.5%', rows[0]._siDetail.total, 1800);
  salaryParams.socialBase = 0;
  batchGrossAsBase = true;
  rows = runBatchSalaryPass(group, [rec('2026-01', 10000)], []);
  eq('批量兜底链·按应发工资作基数 10000×22.5%', rows[0]._siDetail.total, 2250);
  batchGrossAsBase = false;
  rows = runBatchSalaryPass(group, [rec('2026-01', 10000)], []);
  isTrue('批量兜底链·全缺记 0 并标注', rows[0]._siMissing === true && rows[0]._siDetail === null);

  // —— 城市链：行内城市 > 整批城市 > 工资参数；未知回退并标注 ——
  rows = runBatchSalaryPass(group, [rec('2026-01', 10000, { socialBase: 10000, city: '深圳' })], []);
  isTrue('批量城市链·行内城市优先（深圳）', rows[0]._cityKey === 'shenzhen' && rows[0].cityName.indexOf('深圳') >= 0);
  rows = runBatchSalaryPass(group, [rec('2026-01', 10000, { socialBase: 10000, city: '火星' })], []);
  isTrue('批量城市链·未知城市回退工资参数并标注', rows[0]._cityUnknown === true && rows[0]._cityKey === 'custom' && rows[0].cityName.indexOf('未识别') >= 0);

  // —— 累计链：同月多笔只计一次、跨年重新起算 ——
  rows = runBatchSalaryPass(group, [
    rec('2026-02', 10000, { socialBase: 10000 }),
    rec('2026-02', 5000, { socialBase: 10000 })
  ], []);
  isTrue('批量累计链·同月多笔减除与三险一金只计一次',
    rows[1].cumDeduction === rows[0].cumDeduction && rows[1]._cumSI === rows[0]._cumSI);
  rows = runBatchSalaryPass(group, [rec('2026-12', 10000, { socialBase: 10000 }), rec('2027-01', 8000, { socialBase: 8000 })], []);
  eq('批量累计链·跨年重新起算', rows[1].cumIncome, 8000);

  // —— 反算方向端到端（期望实发 10000 → 应发 > 10000 且税后回代）——
  batchDirection = 'reverse';
  rows = runBatchSalaryPass(group, [rec('2026-01', 10000, { socialBase: 10000 })], []);
  isTrue('批量反算·应发>实发目标且税后≈10000', rows[0].preTax > 10000 && Math.abs(rows[0].postTax - 10000) <= 0.02);
  batchDirection = 'forward';

  // —— 年终奖：单独行计税与不进累计链 ——
  const passRows = runBatchSalaryPass(group, [
    rec('2026-01', 10000, { socialBase: 10000 }),
    rec('2026-02', 10000, { socialBase: 10000 })
  ], []);
  const sepRow = makeBatchBonusSeparateRow(group, { month: '2026-02', bonus: 36000 }, passRows);
  isTrue('批量年终奖·单独行 36000→3% 档 1080', sepRow._bonusSeparate === true && sepRow.currentTax === 1080 && sepRow.rate === 0.03);
  eq('批量年终奖·单独行不进累计链', sepRow.cumIncome, passRows[1].cumIncome);

  // —— 年终奖择优：人 × 年对比 ——
  const hiRecs = [];
  for (let m = 1; m <= 12; m++) hiRecs.push(rec('2026-' + String(m).padStart(2, '0'), 30000, { socialBase: 30000 }));
  hiRecs[5].bonus = 36000;
  let pRows = runBatchSalaryPerson(group, hiRecs);
  const hiSep = pRows.find(r => r._bonusSeparate);
  isTrue('批量择优·高薪时年终奖单独计税（1080）', !!hiSep && hiSep.currentTax === 1080);

  pRows = runBatchSalaryPerson(group, [rec('2026-01', 30000, { bonus: 38000 })]);
  const combRow = pRows.find(r => r._isBonus && r._bonusStrategy === 'combined');
  isTrue('批量择优·低薪时年终奖并入综合所得', !!combRow && pRows[pRows.length - 1].cumIncome === 68000);

  batchDirection = 'reverse';
  pRows = runBatchSalaryPerson(group, [rec('2026-01', 14000, { socialBase: 10000, bonus: 36000 })]);
  isTrue('批量年终奖·反算方向一律单独计税', pRows.some(r => r._bonusSeparate === true) && pRows.every(r => r._bonusStrategy !== 'combined'));
  batchDirection = 'forward';

  // —— processWithMapping 端到端：解析 → 映射 → 分组 → 计税 ——
  const colMap = { name: 0, month: 1, amount: 2, socialBase: 3, fundRate: 4, extraDeduction: 5, bonus: 6, city: 7 };
  processWithMapping([
    ['张三', '2026-01', '10000', '10000', '5%', '1000', '', '深圳'],
    ['张三', '2026/2', '12000', '', '', '', '', ''],
    ['合计', '', '22000', '', '', '', '', ''],
    ['李四', '2026-01', '20000', '', '', '', '', '']
  ], colMap, '回归测试.csv');
  const parsed = window._batchParsed.parsed;
  eq('批量解析·行数（剔除汇总行）', parsed.length, 3);
  isTrue('批量解析·数值/公积金比例/专项附加/城市列',
    parsed[0].amount === 10000 && parsed[0].fundRate === 0.05 && parsed[0].extraDeduction === 1000 && parsed[0].city === '深圳');
  isTrue('批量解析·月份归一 2026/2→2026-02', parsed[1].month === '2026-02');
  eq('批量分组·personKeys 人数', window._batchParsed.personKeys.length, 2);
  const zsKey = window._batchParsed.personKeys.find(k => window._batchParsed.personsMap[k].records[0].city === '深圳');
  const zsGroup = window._batchParsed.personsMap[zsKey];
  const zsRows = runBatchSalaryPerson(zsGroup, zsGroup.records);
  isTrue('批量端到端·深圳行内基数与引擎直算一致', (() => {
    const siD = computeSocialInsuranceDetail(10000, '', resolvePolicy('shenzhen', '2026-01').items, 0.05);
    return Math.abs(zsRows[0]._siDetail.total - siD.total) < 1e-9;
  })());
  const lsKey = window._batchParsed.personKeys.find(k => window._batchParsed.personsMap[k].name === '李四');
  const lsGroup = window._batchParsed.personsMap[lsKey];
  const lsRows = runBatchSalaryPerson(lsGroup, lsGroup.records);
  isTrue('批量端到端·李四无基数记 0 标注', lsRows[0]._siMissing === true && lsRows[0]._siDetail === null);

  // —— 劳务批量引擎级判定（逐行接线属 DOM 流程，见浏览器冒烟）——
  isTrue('劳务断月重置·间隔超 1 个月判定', isGapMonth('2025-10', '2026-01') === true && isGapMonth('2026-01', '2026-02') === false);
  isTrue('劳务新旧政策·2025-10 切换点', isNewPolicy('2025-09') === false && isNewPolicy('2025-10') === true);

  // —— 劳务批量管线（runBatchLaborPass，自 runBatchCalc 函数化；cumIncome 为 ×80% 收入额口径）——
  let lRows = runBatchLaborPass(group, [rec('2025-09', 10000), rec('2025-10', 10000), rec('2025-11', 10000)]);
  isTrue('劳务批量·旧政策行标注且不扣税', lRows[0]._isOldPolicy === true && lRows[0].currentTax === 0);
  isTrue('劳务批量·2025-10 起新政策累计', lRows[1]._isOldPolicy === false && lRows[1].cumIncome === 8000 && lRows[2].cumIncome === 16000);
  batchGapReset = true;
  lRows = runBatchLaborPass(group, [rec('2025-10', 10000), rec('2025-12', 10000)]);
  isTrue('劳务批量·断月重置开关生效（_isGap 且累计归零）', lRows[1]._isGap === true && lRows[1].cumIncome === 8000);
  batchGapReset = false;
  lRows = runBatchLaborPass(group, [rec('2025-10', 10000), rec('2025-12', 10000)]);
  isTrue('劳务批量·断月关闭时累计延续', lRows[1]._isGap === false && lRows[1].cumIncome === 16000);
  batchDirection = 'reverse';
  lRows = runBatchLaborPass(group, [rec('2026-01', 9910)]);
  isTrue('劳务批量·反算税前 10000 且税后回代', Math.abs(lRows[0].preTax - 10000) <= 0.01 && Math.abs(lRows[0].postTax - 9910) <= 0.01);
  batchDirection = 'forward';

  // —— 平台导出风格解析（顶部汇总区+明细区，如京创云/艾摩米发放表）：——
  // 真实文件 raw:false 下服务费率 0.0675 格式化为 "6.75%"，与明细表头构成双行表头合并；
  // 月份只出现在汇总区「9月」，需与文件名年份提示拼成 2026-09。
  const pad21 = (...vals) => { const r = vals.slice(); while (r.length < 21) r.push(''); return r; };
  const amomiRows = [
    pad21('', '客户名称：', '深圳艾摩米智能科技有限公司'),
    pad21('', '统一信用代码', '91440300MA5GAR9Y4A'),
    pad21('', '开户行账号', '44250100000100001844'),
    pad21('', '业务类型', '服务费率', '月份', '客户支付合计', '平台服务费', '税前收入', '个税', '实发金额', '核对', '备注'),
    pad21('', '灵活用工', 0.0675, '9月', 467247.42, 29544.92, 437702.5, 17465.97, 420236.53, true, ''),
    pad21('序号', '户名', '性别', '身份证号码', '手机号码', '开户行', '开户地', '账号', '计划发放收入', '发放方式独立选择',
      '税前收入', '税源地', '免税收入', '减除费用', '预扣预缴应纳税所得额', '个税核定代征税率', '速算扣除数', '需交个税', '本次实发金额', '服务费', '合计'),
    pad21('', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '6.75%', ''),
    pad21(1, '王辉', '', '110101195902021012', '13501211095', '中国银行北京亮马河大厦支行', '中国银行北京亮马河大厦支行', '4563510100864730480',
      84099.05, '公司承担服务费', 84099.05, ' 天津', 16819.81, 5000, 62279.24, 0.1, 2520, 3707.92, 80391.13, 5676.69, 89775.74),
    pad21(2, '陈景云', '', '35012219621023371X', '13599437111', '招商银行福建省福州分行', '招商银行福建省福州分行', '6231366015666699',
      41075.51, '公司承担服务费', 41075.51, ' 天津', 8215.1, 5000, 27860.41, 0.03, 0, 835.81, 40239.7, 2772.6, 43848.11),
    pad21('合计', '', '', '', '', '', '', '', 437702.5, '', 437702.5, 0, 87540.5, 30000, 320162, 0.53, 12600, 17465.97, 420236.53, 29544.92, 467247.42)
  ];
  const amomiAnalysis = BatchParse.analyzeSheet('费用明细', amomiRows, '', '2026');
  isTrue('平台表·表头锁定明细区（姓名/金额/身份证/卡号列）',
    amomiAnalysis.autoMap.nameCol === 1 && amomiAnalysis.autoMap.amountCol === 10 &&
    amomiAnalysis.autoMap.idCardCol === 3 && amomiAnalysis.autoMap.bankCardCol === 7);
  isTrue('平台表·双行表头合并后数据行 2 人（汇总区/半合并行/合计行不入数据）', amomiAnalysis.dataRowsCount === 2);
  isTrue('平台表·汇总区「9月」+文件年份提示 → 2026-09', amomiAnalysis.monthHint === '2026-09');
  isTrue('平台表·数据源工厂经 BatchParse.buildSourceItem 两侧可用', typeof BatchParse.buildSourceItem === 'function');

  Object.assign(salaryParams, saved);
  batchDirection = savedBatch.dir;
  batchCityId = savedBatch.city;
  batchGrossAsBase = savedBatch.grossAsBase;
  batchGapReset = savedBatch.gap;

  // —— 清理测试副作用：端到端用例走真实上传通道 processWithMapping，
  //    会把「回归测试.csv」灌进批量页会话状态并渲染预览——不还原的话
  //    用户每次打开页面都会在批量计算页看到这份数据（2026-09-07 用户报告） ——
  window._batchParsed = null;
  window._batchFilename = null;
  window._batchResults = null;
  const previewEl = document.getElementById('batch-preview');
  if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 批量流水线自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 批量流水线自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 导出器组装自检 ====================
// buildSalaryFormulaGrid 边界：反算行、公积金基数独立、同月/跨年链、
// 年终奖并入与单独行、缺基数行、身份列开关、备注注入、企业总成本公式。
// 只测网格组装纯函数，不碰 XLSX/CDN IO（ensureXLSX 属浏览器冒烟）。

function runExporterTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);

  const saved = JSON.parse(JSON.stringify(salaryParams));
  salaryParams.cityId = 'custom';

  const customItems = resolvePolicy('custom', '2026-01').items;
  const mkRow = (over) => Object.assign({
    month: '2026-01', person: '测试', preTax: 10000, postTax: 6697.5,
    cumIncome: 10000, cumDeduction: 8250, taxableIncome: 1750, rate: 0.03, quick: 0,
    cumTaxDue: 52.5, currentTax: 52.5, extraDeduction: 1000,
    _siDetail: computeSocialInsuranceDetail(10000, '', customItems, 0.05),
    _cumSI: 2250, _cumExtra: 1000, _isBonus: false, _bonusSeparate: false
  }, over || {});
  const OPTS = { chainKey: (r) => String(r.month || '').split('-')[0], cityOf: () => 'custom', nameOf: () => '测试', cityLabel: () => '自定义政策' };

  // 1. 反算方向行：金额列为反算解出的应发，实发公式引用金额/三险一金/本期预扣
  const gRev = buildSalaryFormulaGrid(
    [mkRow({ preTax: 12337.11, postTax: 10000, cumTaxDue: 287.11, currentTax: 287.11, taxableIncome: 4087.11 })], OPTS);
  isTrue('公式导出·反算行金额列=反算应发且实发公式引用', gRev.rows[0][4].v === 12337.11 && gRev.rows[0][31].f === 'E2-M2-AE2');
  isTrue('公式导出·企业总成本公式 E2+S2 且缓存为数值', gRev.rows[0][32].f === 'E2+S2' && typeof gRev.rows[0][32].v === 'number');

  // 2. 公积金基数独立于社保基数时常量写入
  const gIndep = buildSalaryFormulaGrid(
    [mkRow({ _siDetail: computeSocialInsuranceDetail(10000, 8000, customItems, 0.12) })], OPTS);
  isTrue('公式导出·公积金基数独立时为常量 8000', gIndep.rows[0][6].v === 8000 && !gIndep.rows[0][6].f);

  // 3. 同月第二行：减除费用公式 IF(...) 且缓存 0
  const gSame = buildSalaryFormulaGrid([mkRow(), mkRow({ cumIncome: 20000 })], OPTS);
  isTrue('公式导出·同月第二行减除公式 IF(...) 且缓存 0', gSame.rows[1][20].f.indexOf('IF(') === 0 && gSame.rows[1][20].v === 0);

  // 4. 跨年链重启：累计应发公式重新从金额列起算
  const gCross = buildSalaryFormulaGrid([mkRow(), mkRow({ month: '2027-01', cumIncome: 8000 })], OPTS);
  isTrue('公式导出·跨年累计应发重启为金额引用', gCross.rows[1][21].f === 'E3');

  // 5. 年终奖并入行：走普通累计链（项目=年终奖、减除列仍有公式）
  const gComb = buildSalaryFormulaGrid(
    [mkRow(), mkRow({ _isBonus: true, preTax: 38000, cumIncome: 48000 })], OPTS);
  isTrue('公式导出·年终奖并入行走普通累计链',
    gComb.rows[1][3].v === '年终奖' && !!gComb.rows[1][20].f && gComb.rows[1][20].f.indexOf('IF(') === 0);

  // 6. 年终奖单独行：累计列全 null，税额用 ÷12 档公式
  const gSep = buildSalaryFormulaGrid(
    [mkRow(), mkRow({ _isBonus: true, _bonusSeparate: true, preTax: 36000, rate: 0.03, quick: 0, cumTaxDue: 1080, currentTax: 1080, postTax: 34920 })], OPTS);
  isTrue('公式导出·年终奖单独行不进累计链',
    gSep.rows[1][20] === null && gSep.rows[1][21] === null && gSep.rows[1][30].f === 'ROUND(MAX(0,E3*AA3-AB3),2)');

  // 7. 缺基数行（_siDetail null）：三险一金列常量 0 无公式，税额公式仍在
  const gMissing = buildSalaryFormulaGrid([mkRow({ _siDetail: null })], OPTS);
  isTrue('公式导出·缺基数行三险一金为常量 0 且无公式',
    gMissing.rows[0][12].v === 0 && !gMissing.rows[0][12].f && gMissing.rows[0][30].f.indexOf('MAX(0,') === 0);

  // 8. 身份列开关：身份证/电话列插入后表头与列映射整体右移
  const gId = buildSalaryFormulaGrid(
    [mkRow({ idCard: '110101199001011234', phone: '13800138000' })], Object.assign({}, OPTS, { idCard: true, phone: true }));
  isTrue('公式导出·身份列开关右移列映射', gId.headers.length === 36 && gId.rows[0][1].v === '110101199001011234' && gId.headers[3] === '月份');

  // 9. 备注注入（反算等场景由调用方补充说明）
  const gNote = buildSalaryFormulaGrid([mkRow()], Object.assign({}, OPTS, { noteExtra: () => '反算方向' }));
  isTrue('公式导出·noteExtra 注入备注列', gNote.rows[0][33].v === '反算方向');

  // —— 打印报告组装与脱敏（PageReport）——
  isTrue('打印报告·身份证脱敏', maskIdCard('110101199001011234') === '1101**********1234');
  isTrue('打印报告·电话脱敏', maskPhone('13800138000') === '138****8000');
  isTrue('打印报告·银行卡脱敏', maskBankCard('6222021234561234567') === '****4567');
  isTrue('打印报告·批量组装：分组/小计/总计/脱敏/月份范围', (() => {
    const env = { incomeType: 'salary', direction: 'forward', params: [], policyLine: '', inLabel: '应发工资', outLabel: '实发工资' };
    const d = buildBatchReportData([
      { personKey: 'ID:110101199001011234', person: '张三', idCard: '110101199001011234', month: '2026-01', preTax: 10000, socialInsurance: 1750, extraDeduction: 1000, currentTax: 52.5, postTax: 8197.5 },
      { personKey: 'ID:110101199001011234', person: '张三', idCard: '110101199001011234', month: '2026-02', preTax: 12000, socialInsurance: 1750, extraDeduction: 1000, currentTax: 170, postTax: 10080 },
      { personKey: 'P:13800138000', person: '李四', phone: '13800138000', month: '2026-01', preTax: 8000, socialInsurance: 1400, extraDeduction: 0, currentTax: 0, postTax: 6600 }
    ], env);
    const zs = d.groups.find(g => g.person === '张三');
    return d.personCount === 2 && zs && zs.rows.length === 2
      && zs.idLine.indexOf('1101**********1234') >= 0
      && Math.abs(zs.subtotal.in - 22000) < 1e-9
      && Math.abs(d.totals.in - 30000) < 1e-9 && Math.abs(d.totals.tax - 222.5) < 1e-9
      && d.monthRange === '2026-01 ~ 2026-02';
  })());
  isTrue('打印报告·空结果防呆返回 null', buildBatchReportData([], {}) === null && buildMultiReportData([], {}) === null);

  Object.assign(salaryParams, saved);

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 导出器组装自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 导出器组装自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 导出样式规格自检 ====================
// ExportStyle 纯规格层：列分组无缝无叠全覆盖（34/37 列）、语义色与数字格式映射、
// 行类型底色、dataStartRow 公式行号随动（默认行为回归保护）、汇总配对收集、
// SUMIFS 精确构造与汇总缓存合计。不碰 ExcelJS/下载 IO（属浏览器冒烟）。

function runExportStyleTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);

  const saved = JSON.parse(JSON.stringify(salaryParams));
  salaryParams.cityId = 'custom';
  const customItems = resolvePolicy('custom', '2026-01').items;
  const mkRow = (over) => Object.assign({
    month: '2026-01', person: '测试', preTax: 10000, postTax: 6697.5,
    cumIncome: 10000, cumDeduction: 8250, taxableIncome: 1750, rate: 0.03, quick: 0,
    cumTaxDue: 52.5, currentTax: 52.5, extraDeduction: 1000,
    _siDetail: computeSocialInsuranceDetail(10000, '', customItems, 0.05),
    _cumSI: 2250, _cumExtra: 1000, _isBonus: false, _bonusSeparate: false
  }, over || {});
  const OPTS = { chainKey: (r) => String(r.month || '').split('-')[0], cityOf: () => 'custom', nameOf: () => '测试', cityLabel: () => '自定义政策' };
  const S = window.ExportStyle;

  const g33 = buildSalaryFormulaGrid([mkRow()], OPTS);
  const g37 = buildSalaryFormulaGrid(
    [mkRow({ idCard: '110101199001011234', phone: '13800138000', bankCard: '6222021234561234567' })],
    Object.assign({}, OPTS, { idCard: true, phone: true, bankCard: true }));

  // —— 列 key 映射与表头一致 ——
  isTrue('样式规格·cols 映射覆盖全部列（34 列）', S.keyArray(g33.cols).length === 34 && S.keyArray(g33.cols).every(k => !!k));
  isTrue('样式规格·身份列形态覆盖（37 列）', S.keyArray(g37.cols).length === 37 && S.keyArray(g37.cols).every(k => !!k));

  // —— 分组无缝无叠全覆盖 ——
  const seg33 = S.resolveGroups(g33.cols, g33.headers.length);
  isTrue('样式规格·34 列分 7 组且首尾相接', seg33.length === 7 && seg33[0].from === 0 && seg33[6].to === 33
    && seg33.every((s, i) => i === 0 || seg33[i - 1].to + 1 === s.from));
  const seg37 = S.resolveGroups(g37.cols, g37.headers.length);
  isTrue('样式规格·37 列分组全覆盖', seg37[0].to === 6 && seg37[seg37.length - 1].to === 36
    && seg37.every((s, i) => i === 0 || seg37[i - 1].to + 1 === s.from));
  isTrue('样式规格·分组标签与淡彩填充齐备', seg33[0].label === '基本信息' && seg33[1].label === '收入与基数输入'
    && !!seg33[1].fill && !!seg33[1].color);

  // —— 语义色与数字格式 ——
  isTrue('样式规格·税额红/预扣加粗、实发绿加粗、成本橙', (() => {
    const curTax = S.colSpec('curTax'), postTax = S.colSpec('postTax'), cost = S.colSpec('cost'), cumDue = S.colSpec('cumDue');
    return curTax.color === S.PAL.taxText && curTax.bold
      && postTax.color === S.PAL.postTaxText && postTax.bold
      && cost.color === S.PAL.costText && !cost.bold
      && cumDue.color === S.PAL.taxText && !cumDue.bold;
  })());
  isTrue('样式规格·比率百分比、文本锁 @、金额交由 writer 千分位', S.colSpec('fundRate').numFmt === '0%'
    && S.colSpec('rate').numFmt === '0%' && S.colSpec('idCard').numFmt === '@'
    && S.colSpec('month').numFmt === '@' && S.colSpec('amount').numFmt === null);

  // —— 列宽与行底色 ——
  isTrue('样式规格·数值列宽保底 12、备注列 24、超长表头封顶 24', S.colWidth('amount', '应发') >= 12
    && S.colWidth('note', '备注') === 24 && S.colWidth('name', '姓名的姓名的姓名的姓名的姓名') === 24);
  isTrue('样式规格·斑马纹与年终奖行底色（bonus 优先）', S.rowFill(1, {}) === S.PAL.zebra
    && S.rowFill(1, { bonus: true }) === S.PAL.bonusRow && S.rowFill(0, {}) === null);

  // —— dataStartRow：公式行号随动，默认行为不变 ——
  const revRow = { preTax: 12337.11, postTax: 10000, cumTaxDue: 287.11, currentTax: 287.11, taxableIncome: 4087.11 };
  const gOff = buildSalaryFormulaGrid([mkRow(revRow)], Object.assign({}, OPTS, { dataStartRow: 5 }));
  isTrue('样式规格·dataStartRow=5 时实发公式行号 E5-M5-AE5', gOff.rows[0][31].f === 'E5-M5-AE5' && gOff.maxRow === 5);
  const gDef = buildSalaryFormulaGrid([mkRow(revRow)], OPTS);
  isTrue('样式规格·默认 dataStartRow 保持旧行号（回归保护）', gDef.rows[0][31].f === 'E2-M2-AE2' && gDef.maxRow === 2);

  // —— rowsMeta 行类型标记 ——
  const gMeta = buildSalaryFormulaGrid([
    mkRow(),
    mkRow({ month: '2027-01', cumIncome: 8000 }),
    mkRow({ month: '2027-02', _isBonus: true, _bonusSeparate: true, preTax: 36000, cumIncome: 44000, rate: 0.03, quick: 0, cumTaxDue: 1080, currentTax: 1080, postTax: 34920 })
  ], OPTS);
  isTrue('样式规格·rowsMeta：链首/跨年重置/单独年终奖标记', gMeta.rowsMeta[0].chainStart === true
    && gMeta.rowsMeta[1].chainStart === true && gMeta.rowsMeta[1].bonus === false && gMeta.rowsMeta[2].bonus === true);

  // —— 汇总：配对收集去重保序 + SUMIFS 精确构造 ——
  const pairs = S.collectSummaryPairs([
    mkRow(),
    mkRow({ month: '2026-02', cumIncome: 20000 }),
    mkRow({ month: '2027-01', cumIncome: 8000 }),
    mkRow({ month: '2027-01', person: '李四', cumIncome: 8000 })
  ], (r) => r.person);
  isTrue('样式规格·汇总配对按出现序去重（人×年）', pairs.length === 3
    && pairs[0].name === '测试' && pairs[0].year === '2026'
    && pairs[1].name === '测试' && pairs[1].year === '2027'
    && pairs[2].name === '李四' && pairs[2].year === '2027');
  const fs = S.summaryFormulas({ sheet: '工资计算明细', cols: g33.cols, firstRow: 5, lastRow: 16 }, { name: '测试', year: '2026' });
  isTrue('样式规格·SUMIFS 精确构造（金额 E + 姓名 A + 月份 B 年通配）',
    fs.amount === `SUMIFS('工资计算明细'!$E$5:$E$16,'工资计算明细'!$A$5:$A$16,"测试",'工资计算明细'!$B$5:$B$16,"2026*")`
    && fs.curTax === `SUMIFS('工资计算明细'!$AE$5:$AE$16,'工资计算明细'!$A$5:$A$16,"测试",'工资计算明细'!$B$5:$B$16,"2026*")`);

  // —— 汇总缓存合计（与明细网格同口径：应发/个人三险/税/实发/用工成本） ——
  const rA = mkRow({ person: '张三', preTax: 10000, currentTax: 52.5, postTax: 6697.5 });
  const rB = mkRow({ person: '张三', month: '2026-02', preTax: 12000, currentTax: 170, postTax: 10080, cumIncome: 22000 });
  const sumMeta = Exporter.buildSummaryMeta([rA, rB], (r) => r.person);
  isTrue('样式规格·汇总缓存合计=逐行求和', sumMeta.length === 1 && sumMeta[0].vals.amount === 22000
    && sumMeta[0].vals.curTax === 222.5 && sumMeta[0].vals.postTax === 16777.5
    && sumMeta[0].vals.siTotal === round2(rA._siDetail.total + rB._siDetail.total)
    && sumMeta[0].vals.cost === round2(22000 + rA._siDetail.employer.total + rB._siDetail.employer.total));

  Object.assign(salaryParams, saved);

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 导出样式规格自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 导出样式规格自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 年度汇算自检 ====================
// 收入额折算三类口径、劳务/工资预扣估算与累计预扣引擎一致、
// settle 标准算例（应退 780 验收锚点）、手填覆盖、免汇算边界、空输入防呆。

function runAnnualTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);

  // —— 收入额折算（汇算口径）——
  eq('汇算·工资收入额=全额', incomeOf('salary', 10000), 10000);
  eq('汇算·劳务收入额×80%', incomeOf('labor', 30000), 24000);
  eq('汇算·稿酬收入额×80%×70%', incomeOf('author', 10000), 5600);
  eq('汇算·特许权收入额×80%', incomeOf('royalty', 10000), 8000);
  eq('汇算·收入额负数防呆', incomeOf('labor', -5), 0);

  // —— 预扣估算：工资/劳务与累计预扣引擎一致 ——
  eq('汇算·工资预扣估算（1月1万，三险一金2250+附加1000）= 52.50',
    estimateSalaryWithholding([{ month: '2026-01', amount: 10000 }], 2250, 1000), 52.5);
  eq('汇算·劳务预扣估算（6月单笔3万）= 570',
    estimateLaborWithholding([{ month: '2026-06', amount: 30000 }]), 570);
  isTrue('汇算·劳务旧政策月（2025-09）不扣税',
    estimateLaborWithholding([{ month: '2025-09', amount: 30000 }]) === 0);

  // —— settle 标准算例（验收锚点）：工资12万+劳务6月一笔3万 → 应退 780 ——
  const r = settle({
    salaryIncome: 120000, salaryDeductionsAnnual: 27000,
    laborIncome: 30000, authorIncome: 0, royaltyIncome: 0,
    extraAnnual: EXTRA_ANNUAL_DEFAULTS.houseLoan,
    withheld: { salary: 630, labor: 570, author: 0, royalty: 0 }
  });
  eq('汇算·收入额合计 144,000', r.totalIncomeAmount, 144000);
  eq('汇算·应纳税所得额 45,000', r.taxable, 45000);
  eq('汇算·应纳税额 1,980', r.annualTax, 1980);
  isTrue('汇算·适用税率 10%（速算 2,520）', r.rate === 0.1 && r.quick === 2520);
  eq('汇算·应补税 780（验收锚点：劳务并入跳档，预扣不足）', r.payable, 780);
  isTrue('汇算·应补 780 时无免汇算标志（>400 且收入>12万）', r.exempt === false && r.refund === 0);

  // —— 手填覆盖与免汇算边界 ——
  const r2 = settle({
    salaryIncome: 130000, salaryDeductionsAnnual: 27000,
    laborIncome: 0, authorIncome: 0, royaltyIncome: 0,
    extraAnnual: 12000,
    withheld: { salary: 400, labor: 0, author: 0, royalty: 0 }
  });
  isTrue('汇算·手填预扣生效（应补 530）', r2.withheldTotal === 400 && r2.payable === 530 && r2.exempt === false);
  const r3 = settle({
    salaryIncome: 130000, salaryDeductionsAnnual: 27000,
    laborIncome: 0, authorIncome: 0, royaltyIncome: 0,
    extraAnnual: 12000,
    withheld: { salary: 560, labor: 0, author: 0, royalty: 0 }
  });
  isTrue('汇算·补税≤400 免汇算标志', r3.payable === 370 && r3.exempt === true);
  const r4 = settle({
    salaryIncome: 110000, salaryDeductionsAnnual: 20000,
    laborIncome: 0, authorIncome: 0, royaltyIncome: 0,
    extraAnnual: 12000,
    withheld: { salary: 0, labor: 0, author: 0, royalty: 0 }
  });
  isTrue('汇算·年收入≤12万且需补税 → 免汇算', r4.totalIncome <= 120000 && r4.payable > 0 && r4.exempt === true);

  // —— 空输入防呆 ——
  const r5 = settle({ withheld: {} });
  isTrue('汇算·空输入归零不抛错', r5.annualTax === 0 && r5.refund === 0 && r5.payable === 0);

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 年度汇算自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 年度汇算自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 分享链接自检 ====================
// 编解码 roundtrip（多月工资含分项与年终奖、多月劳务、汇算含预扣手填）、
// 损坏/版本不符防呆、12 月金额顺序保持。

function runShareTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);

  const multiSalary = {
    v: 1, t: 'multi', it: 'salary', y: 2026, dir: 'forward', gap: 0,
    m: [10000, 12000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9000],
    bp: { c: 'beijing', b: 10000, fb: '', fr: 0.05, ed: 1000,
      xd: { on: true, childEducation: { on: true, count: 1 }, houseRent: { on: true, tier: 1500 }, support: { on: true, mode: 'solo' } } },
    bn: { a: 36000, m: 12 }
  };
  const back1 = decodeShare(encodeShare(multiSalary));
  isTrue('分享·多月工资 roundtrip', (() => {
    return back1.t === 'multi' && back1.it === 'salary' && back1.y === 2026
      && back1.m[0] === 10000 && back1.m[1] === 12000 && back1.m[11] === 9000
      && back1.bp.c === 'beijing' && back1.bp.fr === 0.05
      && back1.bp.xd.childEducation.count === 1 && back1.bp.xd.houseRent.tier === 1500
      && back1.bn.a === 36000 && back1.bn.m === 12;
  })());
  isTrue('分享·12 月顺序保持', back1.m.join(',') === '10000,12000,0,0,0,0,0,0,0,0,0,9000');

  const multiLabor = {
    v: 1, t: 'multi', it: 'labor', y: 2026, dir: 'reverse', gap: 1,
    m: [8000, 8000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  };
  const back2 = decodeShare(encodeShare(multiLabor));
  isTrue('分享·多月劳务 roundtrip（方向/断月）',
    back2.it === 'labor' && back2.dir === 'reverse' && back2.gap === 1 && back2.bp === undefined && back2.bn === undefined);

  const annual = {
    v: 1, t: 'annual', y: 2026,
    sal: [10000, 10000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], lab: [0, 0, 0, 0, 0, 30000, 0, 0, 0, 0, 0, 0],
    au: 5000, ro: 0, sia: 27000,
    ex: [24000, 0, 4800, 12000, 0, 36000, 0],
    w: { salary: 630 }
  };
  const back3 = decodeShare(encodeShare(annual));
  isTrue('分享·汇算 roundtrip', (() => {
    return back3.t === 'annual' && back3.sal[0] === 10000 && back3.lab[5] === 30000
      && back3.au === 5000 && back3.sia === 27000
      && back3.ex[0] === 24000 && back3.ex[3] === 12000
      && back3.w.salary === 630 && back3.w.labor === undefined;
  })());

  isTrue('分享·损坏 payload 防呆', decodeShare('not-a-valid-payload!!!') === null && decodeShare('') === null);
  isTrue('分享·版本不符防呆', decodeShare(encodeShare(Object.assign({}, multiLabor, { v: 99 }))) === null);
  isTrue('分享·类型未知防呆', decodeShare(encodeShare(Object.assign({}, multiLabor, { t: 'batch' }))) === null);

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 分享链接自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 分享链接自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 政策库同步自检 ====================
// 版本比较、官方层→本机三方合并（未改字段更新/已改字段保留/新增补入/本地独有保留）、
// 本地改动标记；applyRemoteOfficial / restoreOfficialValue 涉及写本机存档，仅在 Node 门内跑。

function runPolicySyncTests() {
  const t = [];
  const eq = (name, actual, expected, eps = 0.0001) => {
    const ok = Math.abs(actual - expected) <= eps;
    t.push({ name, ok, actual, expected });
    return ok;
  };
  const isTrue = (name, cond) => eq(name, cond ? 1 : 0, 1);
  const nodeEnv = typeof localStorage === 'undefined';

  const { compareVersions, mergeLibrary, officialDiffFor } = PolicyLib;
  const rec = (personal, lower, upper, employer) => {
    const pension = { personal: personal, lower: lower, upper: upper };
    if (employer != null) pension.employer = employer;
    return { label: 'L', effective: ['2025-07', '2026-06'], pending: true, items: { pension: pension } };
  };
  const city = name => ({ name: name, years: { '2025': rec(0.08, 1000, 20000, 0.16) } });

  // —— 版本比较 ——
  isTrue('版本·相等为 0', compareVersions('2026.09', '2026.09') === 0);
  isTrue('版本·低对高为 -1', compareVersions('2026.09', '2026.10') === -1);
  isTrue('版本·高对低为 1', compareVersions('2026.10', '2026.09') === 1);
  isTrue('版本·跨年进位', compareVersions('2027.01', '2026.12') === 1);

  // —— 三方合并：核心规则 ——
  const base = { beijing: city('北京') };
  const user = JSON.parse(JSON.stringify(base));
  user.beijing.years['2025'].items.pension.lower = 1500;      // 用户改了下限
  const remote = JSON.parse(JSON.stringify(base));
  remote.beijing.years['2025'].items.pension.personal = 0.09; // 官方改了个人比例
  remote.beijing.years['2025'].items.pension.lower = 1200;    // 官方也调了用户改过的字段
  remote.beijing.years['2025'].items.pension.upper = 21000;   // 官方调了用户没动的字段
  const m = mergeLibrary(base, user, remote);
  isTrue('合并·用户未改字段采纳官方新值', m.beijing.years['2025'].items.pension.personal === 0.09);
  isTrue('合并·用户已改字段保留用户值', m.beijing.years['2025'].items.pension.lower === 1500);
  isTrue('合并·未动字段同步官方调整', m.beijing.years['2025'].items.pension.upper === 21000);

  // —— 新增 / 本地独有 ——
  const remote2 = JSON.parse(JSON.stringify(remote));
  remote2.shanghai = city('上海');                                           // 官方新增城市
  remote2.beijing.years['2026'] = rec(0.08, 1100, 22000, 0.16);             // 官方新增年度
  remote2.beijing.years['2025'].items.injury = { personal: 0, lower: null, upper: null, employer: 0.002 }; // 官方新增险种
  const user2 = JSON.parse(JSON.stringify(user));
  user2.c123abc = { name: '我的城市', years: { custom: rec(0.1, null, null, 0.1) } }; // 用户新增城市
  const m2 = mergeLibrary(base, user2, remote2);
  isTrue('合并·官方新增城市补入', !!m2.shanghai && m2.shanghai.name === '上海');
  isTrue('合并·官方新增年度补入', !!m2.beijing.years['2026']);
  isTrue('合并·官方新增险种补入', !!m2.beijing.years['2025'].items.injury && m2.beijing.years['2025'].items.injury.employer === 0.002);
  isTrue('合并·用户新增城市保留', !!m2.c123abc && m2.c123abc.name === '我的城市');
  isTrue('合并·官方排序在前、本地独有殿后', Object.keys(m2).slice(-1)[0] === 'c123abc');

  // —— 官方下线：保留本地副本不删数据 ——
  const userSh = { beijing: user.beijing, shanghai: { name: '上海', years: { '2025': rec(0.08, 1000, 20000, 0.16) } } };
  const m4 = mergeLibrary({ beijing: base.beijing, shanghai: userSh.shanghai }, userSh, { beijing: remote.beijing });
  isTrue('合并·官方移除的城市保留本地副本', !!m4.shanghai && m4.shanghai.name === '上海');

  // —— 年度说明三方 ——
  const remoteL = JSON.parse(JSON.stringify(base));
  remoteL.beijing.years['2025'].label = '官方新说明';
  const userL = JSON.parse(JSON.stringify(user));
  userL.beijing.years['2025'].label = '用户备注';
  isTrue('合并·用户改过说明保留', mergeLibrary(base, userL, remoteL).beijing.years['2025'].label === '用户备注');
  isTrue('合并·用户没改说明采纳官方', mergeLibrary(base, JSON.parse(JSON.stringify(base)), remoteL).beijing.years['2025'].label === '官方新说明');

  // —— 本地改动标记（真实库：内存改后即还原，不写存档） ——
  const bj = CITY_POLICY_LIBRARY.beijing;
  const yk0 = Object.keys(bj.years)[0];
  const snap = JSON.parse(JSON.stringify(bj));
  isTrue('标记·未改动城市无 diff', officialDiffFor('beijing', yk0) === null);
  bj.years[yk0].items.pension.lower = 1;
  const d = officialDiffFor('beijing', yk0);
  isTrue('标记·改动字段标出官方值', !!d && !!d.pension && d.pension.lower === snap.years[yk0].items.pension.lower);
  bj.years[yk0].items.pension.lower = snap.years[yk0].items.pension.lower; // 还原
  isTrue('标记·还原后 diff 消失', officialDiffFor('beijing', yk0) === null);

  // —— 远端应用全链路（写本机存档，仅 Node 门内执行） ——
  if (nodeEnv) {
    const libSnap = JSON.parse(JSON.stringify(CITY_POLICY_LIBRARY));
    const c = JSON.parse(JSON.stringify(libSnap.beijing));
    c.years[yk0].items.pension.personal = 0.99;  // 官方新比例（yk0 年度）
    const info = PolicyLib.applyRemoteOfficial({ version: '2026.10', cities: { beijing: c } });
    isTrue('远端·返回版本推进信息', !!info && info.from === '2026.09' && info.to === '2026.10');
    isTrue('远端·官方新值生效', PolicyLib.resolvePolicy('beijing', '2025-08').items.pension.personal === 0.99);
    isTrue('远端·其余城市保留', !!CITY_POLICY_LIBRARY.guangzhou);
    isTrue('远端·用户原有数值不丢', PolicyLib.resolvePolicy('beijing', '2025-08').items.pension.lower === libSnap.beijing.years[yk0].items.pension.lower);
    CITY_POLICY_LIBRARY.beijing.years[yk0].items.pension.personal = 0.5;  // 模拟用户随后改动该字段
    isTrue('远端·单字段恢复官方值',
      PolicyLib.restoreOfficialValue('beijing', yk0, 'pension', 'personal') === true
      && PolicyLib.resolvePolicy('beijing', '2025-08').items.pension.personal === 0.99);
    isTrue('远端·非更高版本不生效', PolicyLib.applyRemoteOfficial({ version: '2026.09', cities: libSnap }) === null);
    // 还原整个工作库（Node 无 localStorage，clear/写档均静默跳过）
    Object.keys(CITY_POLICY_LIBRARY).forEach(k => delete CITY_POLICY_LIBRARY[k]);
    Object.assign(CITY_POLICY_LIBRARY, libSnap);
  }

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 政策库同步自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 政策库同步自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

/* ==================== 手机端表格渲染自检 ====================
   双 DOM 结构存在性、紧凑表列数、方向文案分支、批量宽表 scroll-x 容器；
   Node 门内 document.getElementById 为一次性 stub，无法读回 innerHTML，
   这里临时换成缓存版渲染后取 HTML，结束还原（浏览器内为真 DOM，直接生效）。 */

function runMobileTableTests() {
  const t = [];
  const isTrue = (name, cond) => {
    t.push({ name, ok: !!cond, actual: cond ? 1 : 0, expected: 1 });
  };

  const origGetById = document.getElementById;
  const els = Object.create(null);
  const cachedStubEl = () => ({
    style: {}, value: '', checked: false, innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  });
  document.getElementById = id => els[id] || (els[id] = cachedStubEl());

  const savedIncomeType = incomeType, savedDir = multiDirection;
  try {
    const mkRow = (month, amount, over) => Object.assign({
      month, note: '1月', amount,
      preTax: amount, postTax: round2(amount * 0.97), currentTax: 100,
      socialInsurance: 300, extraDeduction: 0, withholdingIncome: amount,
      cumIncome: amount, cumDeduction: 5000, taxableIncome: 1000, rate: 0.03, quick: 0,
      _isBonus: false, _bonusSeparate: false, _siDetail: null, _policyLabel: '自定义政策',
      _yearFallback: false, _isGap: false, _isOldPolicy: false, _extraMsgs: [], _medicalAnnual: 0
    }, over || {});
    const compactHead = html => (html.match(/m-compact[\s\S]*?<\/thead>/) || [''])[0];

    // —— 多月·逐月明细：工资模式正算 ——
    incomeType = 'salary'; multiDirection = 'forward';
    PageMulti.renderMultiResults([mkRow('2026-01', 15000), mkRow('2026-02', 15000)], null);
    let html = els['multi-result'].innerHTML;
    isTrue('双DOM·桌面明细表存在', html.includes('only-desktop') && html.includes('detail-table'));
    isTrue('双DOM·移动紧凑表存在', html.includes('only-mobile') && html.includes('m-compact'));
    isTrue('双DOM·展开明细行存在', html.includes('m-detail-row') && html.includes('UI.toggleMobileDetailRow'));
    const mHead = compactHead(html);
    isTrue('紧凑表·5列（月份/输入/税率/预扣/输出）', (mHead.match(/<th>/g) || []).length === 5);
    isTrue('紧凑表·正算输入列=应发工资', mHead.includes('>应发工资<'));
    isTrue('紧凑表·正算输出列=实发工资', mHead.includes('>实发工资<'));
    isTrue('紧凑表·合计行存在', /class="total-row"[\s\S]*?<td>合计<\/td>/.test(html));
    isTrue('紧凑表·明细网格含工资专属列', html.includes('三险一金(个人)') && html.includes('单位社保公积金') && html.includes('专项附加'));

    // —— 方向文案分支：工资反算 ——
    multiDirection = 'reverse';
    PageMulti.renderMultiResults([mkRow('2026-01', 15000)], null);
    html = els['multi-result'].innerHTML;
    const mHead2 = compactHead(html);
    isTrue('紧凑表·反算输入列=期望实发（已知）', mHead2.includes('>期望实发（已知）<'));
    isTrue('紧凑表·反算输出列=应发工资（反算）', mHead2.includes('>应发工资（反算）<'));

    // —— 列集分支：劳务模式 ——
    incomeType = 'labor'; multiDirection = 'forward';
    PageMulti.renderMultiResults([mkRow('2026-01', 8000)], null);
    html = els['multi-result'].innerHTML;
    isTrue('紧凑表·劳务模式明细含预扣收入额', html.includes('本次预扣收入额'));
    isTrue('紧凑表·劳务模式不含社保列', !html.includes('三险一金(个人)'));

    // —— 年终奖方案对比卡：正向双方案 → 移动卡；反算 reverseOnly → 维持文字卡 ——
    incomeType = 'salary';
    const plan = {
      bonus: 30000, bonusMonth: '2026-12', separateTax: 900, separateTotalTax: 2000,
      combinedBonusTax: 1500, combinedTotalTax: 2600, recommendation: 'separate',
      saving: 600, chosen: 'separate', trap: null
    };
    PageMulti.renderMultiResults([mkRow('2026-01', 15000)], plan);
    html = els['multi-result'].innerHTML;
    isTrue('年终奖·桌面对比表存在', html.includes('only-desktop') && html.includes('年终奖方案对比'));
    isTrue('年终奖·移动方案卡数=2', (html.match(/m-bonus-card/g) || []).length === 2);
    isTrue('年终奖·移动卡含当前徽标', html.includes('class="cur"'));
    PageMulti.renderMultiResults([mkRow('2026-01', 15000)], Object.assign({}, plan, { reverseOnly: true }));
    html = els['multi-result'].innerHTML;
    isTrue('年终奖·反算方向维持文字卡（无移动卡）', html.includes('单独计税') && !html.includes('m-bonus-card'));

    // —— 行为件存在 ——
    isTrue('UI.toggleMobileDetailRow 可用', typeof UI.toggleMobileDetailRow === 'function');
    isTrue('UI.enhanceScrollX 可用', typeof UI.enhanceScrollX === 'function');

    // —— 批量页：4 张表容器统一 scroll-x（enhanceScrollX 的作用对象） ——
    incomeType = 'salary';
    PageBatch.showColumnMappingUI(
      [['姓名', '月份', '金额'], ['张三', '2026-01', '15000'], ['李四', '2026-02', '8000']],
      ['姓名', '月份', '金额'], 0,
      [['张三', '2026-01', '15000'], ['李四', '2026-02', '8000']], '映射自测.csv'
    );
    html = els['batch-preview'].innerHTML;
    isTrue('批量·列映射预览表 scroll-x 容器', html.includes('class="scroll-x"'));

    PageBatch.processWithMapping(
      [['张三', '2026-01', '15000'], ['张三', '2026-02', '15000'], ['李四', '2026-01', '8000']],
      { name: 0, month: 1, amount: 2 }, '自测.csv'
    );
    html = els['batch-preview'].innerHTML;
    isTrue('批量·预览两表（人员汇总+数据明细）scroll-x 容器≥2', (html.match(/class="scroll-x"/g) || []).length >= 2);

    const mkBatchRow = month => ({
      person: '张三', personKey: 'k', month, preTax: 15000, postTax: 14500, currentTax: 100,
      socialInsurance: 0, extraDeduction: 0, cumIncome: 15000, cumDeduction: 5000,
      taxableIncome: 1000, rate: 0.03, quick: 0, withholdingIncome: 15000,
      cityName: '自定义', policyYearLabel: 'custom', idCard: '', phone: '', bankCard: '',
      _isGap: false, _isOldPolicy: false, _siDetail: null, _isBonus: false
    });
    const r1 = mkBatchRow('2026-01'), r2 = mkBatchRow('2026-02');
    PageBatch.renderBatchResults([r1, r2], '自测.csv', ['k'], { k: { name: '张三', records: [r1, r2] } }, {});
    html = els['batch-result'].innerHTML;
    isTrue('批量·结果表 scroll-x 容器', html.includes('class="scroll-x"'));
  } finally {
    document.getElementById = origGetById;
    incomeType = savedIncomeType;
    multiDirection = savedDir;
  }

  const failed = t.filter(x => !x.ok);
  const summary = `${t.length - failed.length}/${t.length} 通过`;
  if (failed.length) {
    console.group('🧪 手机端表格渲染自检：' + summary);
    failed.forEach(f => console.error(`✗ ${f.name}：期望 ${f.expected}，实际 ${f.actual}`));
    console.groupEnd();
  } else {
    console.log('🧪 手机端表格渲染自检： ' + summary);
  }
  return { passed: t.length - failed.length, total: t.length, failed };
}

// ==================== 聚合入口 ====================

/** 全部套件聚合：浏览器自动执行与 node tests/run.js 共用同一入口 */
function runAll() {
  const suites = [
    { name: '计税与政策库', result: runSelfTests() },
    { name: '批量计税流水线', result: runBatchPipelineTests() },
    { name: '导出器组装', result: runExporterTests() },
    { name: '导出样式规格', result: runExportStyleTests() },
    { name: '年度汇算', result: runAnnualTests() },
    { name: '分享链接', result: runShareTests() },
    { name: '政策库同步', result: runPolicySyncTests() },
    { name: '手机端表格渲染', result: runMobileTableTests() }
  ];
  const failed = [];
  suites.forEach(s => s.result.failed.forEach(f => failed.push(Object.assign({ suite: s.name }, f))));
  return {
    passed: suites.reduce((a, s) => a + s.result.passed, 0),
    total: suites.reduce((a, s) => a + s.result.total, 0),
    failed,
    suites: suites.map(s => ({ name: s.name, passed: s.result.passed, total: s.result.total, failed: s.result.failed }))
  };
}

  window.TaxTest = { runSelfTests, runBatchPipelineTests, runExporterTests, runExportStyleTests, runPolicySyncTests, runAll };
})();
