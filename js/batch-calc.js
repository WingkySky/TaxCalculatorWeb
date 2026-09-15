/* ============================================================
 * batch-calc.js — BatchCalc 批量单人计税流水线（纯逻辑）
 * 人员分组（buildPersonKey/groupPersons）、工资薪金单人管线（累计链/兜底链/城市链/年终奖双方案择优）、劳务报酬单人管线（累计/断月重置/新旧政策）。
 * 对外接口：window.BatchCalc。依赖：TaxEngine/PolicyLib/SocialIns/PageShared/TaxUtils 与 TaxState 全局别名。零 DOM。
 * ============================================================ */
(function () {
'use strict';
  const { round2 } = TaxUtils;
  const { calcBonusTaxSeparate, calcTaxOldPolicy, calcTaxReverseOldPolicy, getMonthlyBracket, isGapMonth, isNewPolicy, TAX_STRATEGIES } = TaxEngine;
  const { computeSocialInsuranceDetail } = SocialIns;
  const { CITY_POLICY_LIBRARY, findCityKey, resolvePolicyMemo } = PolicyLib;
  const { calcTaxByDirection, insertBonusRowSorted } = PageShared;
/** 人员唯一标识：有身份证优先用身份证，否则综合姓名/电话/银行卡 */
function buildPersonKey({ name, idCard, phone, bankCard }) {
  if (idCard) return 'ID:' + idCard;
  const parts = [];
  if (name && name !== '默认') parts.push('N:' + name);
  if (phone) parts.push('P:' + phone);
  if (bankCard) parts.push('B:' + bankCard);
  return parts.length > 0 ? parts.join('|') : '默认';
}

/** 按 personKey 分组并合并身份信息（取最长非空值），返回 { personKeys, personsMap } */
function groupPersons(parsed) {
  const personsMap = {};
  parsed.forEach(d => {
    if (!personsMap[d.personKey]) {
      personsMap[d.personKey] = { name: d.person, idCard: d.idCard, phone: d.phone, bankCard: d.bankCard, records: [] };
    }
    const g = personsMap[d.personKey];
    if (d.idCard && d.idCard.length > g.idCard.length) g.idCard = d.idCard;
    if (d.phone && d.phone.length > g.phone.length) g.phone = d.phone;
    if (d.bankCard && d.bankCard.length > g.bankCard.length) g.bankCard = d.bankCard;
    if (d.person && d.person !== '默认' && (!g.name || g.name === '默认')) g.name = d.person;
    g.records.push(d);
  });
  const personKeys = Object.keys(personsMap).sort((a, b) => {
    const na = personsMap[a].name || a;
    const nb = personsMap[b].name || b;
    return na.localeCompare(nb);
  });
  return { personKeys, personsMap };
}

/* ==================== 批量·工资薪金单人计税流水线 ==================== */

/** 年终奖合成记录：金额取「年终奖」列，不参与社保公积金与专项附加 */
function makeBatchBonusSynthRec(b) {
  return {
    ...b,
    amount: round2(Number(b.bonus) || 0),
    socialBase: '', fundBase: '', fundRate: '', extraDeduction: '',
    _isBonus: true
  };
}

/**
 * 单人工资薪金计税流水线（可重复执行以支持年终奖方案对比）
 * @param {object} group 人员分组
 * @param {Array} records 工资记录（月份升序）
 * @param {Array} bonusRecs 需「并入综合所得」的年终奖记录（作为收入插入发放月）
 */
function runBatchSalaryPass(group, records, bonusRecs) {
  const rows = [];

  /* 年终奖合成记录：排在发放月最后一笔工资之后；当月无工资记录时插到月序合适处 */
  let merged;
  if (bonusRecs && bonusRecs.length) {
    merged = [];
    for (let i = 0; i < records.length; i++) {
      merged.push(records[i]);
      const next = records[i + 1];
      if (!next || next.month !== records[i].month) {
        bonusRecs.filter(b => b.month === records[i].month)
          .forEach(b => merged.push(makeBatchBonusSynthRec(b)));
      }
    }
    bonusRecs.filter(b => !records.some(r => r.month === b.month)).forEach(b => {
      let idx = 0;
      merged.forEach((r, i) => { if (!r._isBonus && (r.month || '') <= b.month) idx = i + 1; });
      merged.splice(idx, 0, makeBatchBonusSynthRec(b));
    });
  } else {
    merged = records.slice();
  }

  let cumIncome = 0, cumTax = 0, cumDeduction = 0;
  let cumSI = 0, cumExtra = 0;
  let lastMonth = '', lastYear = '';

  merged.forEach(d => {
    const curYear = d.month && d.month !== '-' ? d.month.split('-')[0] : '';
    if (curYear && curYear !== lastYear) {
      if (lastYear !== '') {
        cumIncome = 0;
        cumTax = 0;
        cumDeduction = 0;
        lastMonth = '';
      }
      lastYear = curYear;
    }

    /* 城市适用链：行内城市 > 整批城市 > 工资参数城市；未知城市回退并标注 */
    const rowCityKey = d.city ? findCityKey(d.city) : null;
    const cityUnknown = !!d.city && !rowCityKey;
    const cityKey = rowCityKey || batchCityId || salaryParams.cityId;
    const pol = resolvePolicyMemo(cityKey, d.month);
    /* 公积金比例：行内「公积金比例」列 > 「工资参数」全局档位 */
    const effFundRate = (d.fundRate !== '' && d.fundRate != null) ? Number(d.fundRate) : salaryParams.fundRate;

    /* 社保公积金：年终奖行不缴社保；工资行按 行内基数×城市政策 > 全局基数 > 按应发工资作基数（勾选时）> 0 并标注 */
    let si;
    let siD = null;
    if (d._isBonus) {
      si = 0;
    } else {
      const hasRowBase = d.socialBase !== '' && d.socialBase != null && d.socialBase > 0;
      if (hasRowBase) {
        const fund = (d.fundBase !== '' && d.fundBase != null) ? d.fundBase : d.socialBase;
        siD = computeSocialInsuranceDetail(d.socialBase, fund, pol.items, effFundRate);
        si = siD.total;
      } else if (salaryParams.socialBase > 0) {
        siD = computeSocialInsuranceDetail(salaryParams.socialBase, salaryParams.fundBase, pol.items, effFundRate);
        si = siD.total;
      } else if (batchGrossAsBase) {
        siD = computeSocialInsuranceDetail(d.amount, '', pol.items, effFundRate);
        si = siD.total;
      } else {
        si = 0;
      }
    }
    si = round2(Math.max(0, Number(si) || 0));
    const siMissing = !d._isBonus && !siD;

    /* 专项附加：只认行内「专项附加扣除」列值，未录入一律按 0。
       专项附加因人而异（子女教育/房贷/赡养老人等），批量导入未录入即代表无，
       不套用「工资参数」全局值——全局兜底会把一个人的扣除错套到所有人头上。 */
    const extra = d._isBonus ? 0
      : ((d.extraDeduction !== '' && d.extraDeduction != null)
        ? Math.max(0, Number(d.extraDeduction) || 0)
        : 0);

    /* 同月多笔合并：减除费用与社保公积金同月只计一次；无月份的记录各自独立起算。
       实发口径下，当月社保公积金只从首笔记录中扣减，后续记录不再重复扣。 */
    const hasMonth = d.month && d.month !== '-';
    const isFirstOfMonth = !hasMonth || d.month !== lastMonth;
    if (isFirstOfMonth) {
      lastMonth = d.month || '';
      cumDeduction += 5000 + si + extra;
      if (!d._isBonus) {
        cumSI = round2(cumSI + si);
        cumExtra = round2(cumExtra + extra);
      }
    }

    const salaryCtx = { socialInsurance: isFirstOfMonth ? si : 0, extraDeduction: isFirstOfMonth ? extra : 0 };
    const r = calcTaxByDirection(batchDirection, d.amount, cumIncome, cumDeduction, cumTax, TAX_STRATEGIES.salary, salaryCtx);
    cumIncome = r.cumIncome;
    cumTax = r.cumTaxDue;

    rows.push({
      person: group.name,
      idCard: d.idCard || group.idCard,
      phone: d.phone || group.phone,
      bankCard: d.bankCard || group.bankCard,
      ...d,
      ...r,
      _isGap: false,
      _isOldPolicy: false,
      _isBonus: !!d._isBonus,
      _bonusSeparate: false,
      _bonusStrategy: d._isBonus ? 'combined' : '',
      _siMissing: siMissing,
      _cityUnknown: cityUnknown,
      _yearFallback: !pol.matched,
      _siDetail: siD,
      _cityKey: cityKey,
      _cumSI: cumSI,
      _cumExtra: cumExtra,
      cityName: CITY_POLICY_LIBRARY[cityKey].name + (cityUnknown ? `（未识别:${d.city}）` : ''),
      policyYearLabel: pol.label + (!pol.matched ? '（年度未匹配）' : '')
    });
  });

  return rows;
}

/** 批量·年终奖单独计税行：不进入累计链，独立按 ÷12 档计税 */
function makeBatchBonusSeparateRow(group, b, rows) {
  const amt = round2(Number(b.bonus) || 0);
  const tax = calcBonusTaxSeparate(amt);
  const bkt = getMonthlyBracket(amt);
  const rowCityKey = b.city ? findCityKey(b.city) : null;
  const cityUnknown = !!b.city && !rowCityKey;
  const cityKey = rowCityKey || batchCityId || salaryParams.cityId;
  const pol = resolvePolicyMemo(cityKey, b.month);
  let cumIncome = 0, cumDeduction = 0;
  rows.forEach(r => { if ((r.month || '') <= b.month) { cumIncome = r.cumIncome; cumDeduction = r.cumDeduction; } });
  return {
    person: group.name,
    idCard: b.idCard || group.idCard,
    phone: b.phone || group.phone,
    bankCard: b.bankCard || group.bankCard,
    ...b,
    amount: amt,
    preTax: amt,
    withholdingIncome: 0,
    cumIncome: cumIncome,
    cumDeduction: cumDeduction,
    taxableIncome: 0,
    rate: bkt.rate,
    quick: bkt.quick,
    cumTaxDue: tax,
    currentTax: tax,
    postTax: round2(amt - tax),
    _isGap: false,
    _isOldPolicy: false,
    _isBonus: true,
    _bonusSeparate: true,
    _bonusStrategy: 'separate',
    _siMissing: false,
    _cityUnknown: cityUnknown,
    _yearFallback: !pol.matched,
    _siDetail: null,
    _cityKey: cityKey,
    cityName: CITY_POLICY_LIBRARY[cityKey].name + (cityUnknown ? `（未识别:${b.city}）` : ''),
    policyYearLabel: pol.label + (!pol.matched ? '（年度未匹配）' : '')
  };
}

/** 批量·单人工资薪金入口：有年终奖时按「人 × 年」对比单独计税 vs 并入综合所得并择优；
 *  反算方向下并入对比不适用，年终奖一律单独计税独立成行。
 */
function runBatchSalaryPerson(group, records) {
  const bonusRecs = records.filter(r => (Number(r.bonus) || 0) > 0);
  if (!bonusRecs.length) {
    return runBatchSalaryPass(group, records, []);
  }
  if (batchDirection === 'reverse') {
    const rows = runBatchSalaryPass(group, records, []);
    bonusRecs.forEach(b => insertBonusRowSorted(rows, makeBatchBonusSeparateRow(group, b, rows)));
    return rows;
  }
  /* 正算方向：按年对比两方案（跨年累计互不影响，按年分别择优） */
  const baseRows = runBatchSalaryPass(group, records, []);
  const combRows = runBatchSalaryPass(group, records, bonusRecs);
  const yearTaxOf = (arr) => {
    const m = {};
    arr.forEach(r => {
      const y = (r.month || '').split('-')[0] || '-';
      m[y] = round2((m[y] || 0) + r.currentTax);
    });
    return m;
  };
  const baseY = yearTaxOf(baseRows);
  const combY = yearTaxOf(combRows);
  const sepY = {};
  bonusRecs.forEach(b => {
    const y = (b.month || '').split('-')[0] || '-';
    sepY[y] = round2((sepY[y] || 0) + calcBonusTaxSeparate(Number(b.bonus) || 0));
  });
  const planByYear = {};
  Object.keys(sepY).forEach(y => {
    const sepTotal = round2((baseY[y] || 0) + sepY[y]);
    const combTotal = combY[y] || 0;
    planByYear[y] = {
      strategy: sepTotal <= combTotal ? 'separate' : 'combined',
      saving: round2(Math.abs(sepTotal - combTotal))
    };
  });
  bonusRecs.forEach(b => {
    b._plan = planByYear[(b.month || '').split('-')[0] || '-'];
  });

  const combinedRecs = bonusRecs.filter(b => b._plan && b._plan.strategy === 'combined');
  const rows = combinedRecs.length ? runBatchSalaryPass(group, records, combinedRecs) : baseRows;
  bonusRecs.filter(b => b._plan && b._plan.strategy === 'separate')
    .forEach(b => insertBonusRowSorted(rows, makeBatchBonusSeparateRow(group, b, rows)));
  return rows;
}

/**
 * 平台核定代征口径（正向）：灵工发放表带「个税核定代征税率」列时按平台公式复算——
 * 应纳税所得额 = 收入额×80% − 当月减除 5000（不累计），税 = 应纳税所得额 × 核定税率。
 * 累计列（cumIncome/cumDeduction/cumTaxDue）仍照常滚动以便展示，但税额不参与累进与累计抵扣。
 */
function calcWithholdFlat(amount, cumIncome, cumDeduction, cumTax, rate) {
  const withholdingIncome = round2(amount * 0.8);
  /* 平台口径按当月减除 5000 计算（不累计）；cumDeduction 仅作展示透传 */
  const taxableIncome = Math.max(0, round2(withholdingIncome - 5000));
  const currentTax = round2(taxableIncome * rate);
  return {
    preTax: amount,
    withholdingIncome,
    cumIncome: cumIncome + withholdingIncome,
    cumDeduction,
    taxableIncome,
    rate,
    quick: 0,
    cumTaxDue: round2(cumTax + currentTax),
    currentTax,
    postTax: round2(amount - currentTax),
    effectiveRate: amount > 0 ? currentTax / amount : 0,
    _withholdFlat: true
  };
}

/**
 * 单人劳务报酬计税流水线（自 runBatchCalc 函数化）：新政策累计预扣 + 断月重置 + 旧政策按次，
 * 行为与原内联实现一致，逐笔返回带 _isGap/_isOldPolicy 标注的行。
 */
function runBatchLaborPass(group, records) {
  const rows = [];

  let cumIncome = 0, cumTax = 0, cumDeduction = 0;
  let lastMonth = '';
  let lastYear = '';

  records.forEach(d => {
    if (isNewPolicy(d.month)) {
      // 新政策：累计预扣
      const parts = d.month.split('-');
      const curYear = parts.length >= 2 ? parts[0] : '';

      if (curYear && curYear !== lastYear) {
        if (lastYear !== '') {
          cumIncome = 0;
          cumTax = 0;
          cumDeduction = 0;
          lastMonth = '';
        }
        lastYear = curYear;
      }

      // 断月重置：开启时，与上一月份间隔 >1 个月则重新起算
      let isGap = false;
      if (batchGapReset && lastMonth && isGapMonth(lastMonth, d.month)) {
        cumIncome = 0;
        cumTax = 0;
        cumDeduction = 0;
        lastMonth = '';
        isGap = true;
      }

      /* 同月只扣一次5000减除费用：不同月份才累加 */
      if (d.month !== lastMonth) {
        lastMonth = d.month;
        cumDeduction += 5000;
      }

      /* 行内带核定代征税率（灵工平台发放表）→ 按平台口径正向复算；反算方向不适用，回退政策口径 */
      const flatRate = (batchDirection === 'forward' && d.withholdRate !== '' && d.withholdRate != null)
        ? Number(d.withholdRate) || 0 : 0;
      const r = flatRate > 0
        ? calcWithholdFlat(d.amount, cumIncome, cumDeduction, cumTax, flatRate)
        : calcTaxByDirection(batchDirection, d.amount, cumIncome, cumDeduction, cumTax);
      cumIncome = r.cumIncome;
      cumTax = r.cumTaxDue;

      rows.push({
        person: group.name,
        idCard: d.idCard || group.idCard,
        phone: d.phone || group.phone,
        bankCard: d.bankCard || group.bankCard,
        ...d,
        ...r,
        _isGap: isGap,
        _isOldPolicy: false
      });
    } else {
      // 旧政策：按次预扣，不累计
      const r = batchDirection === 'forward' ? calcTaxOldPolicy(d.amount) : calcTaxReverseOldPolicy(d.amount);

      // 如果之前是新政策，现在切换到旧政策，需要重置累计
      if (lastMonth && isNewPolicy(lastMonth)) {
        cumIncome = 0;
        cumTax = 0;
        cumDeduction = 0;
      }
      lastMonth = d.month;

      rows.push({
        person: group.name,
        idCard: d.idCard || group.idCard,
        phone: d.phone || group.phone,
        bankCard: d.bankCard || group.bankCard,
        ...d,
        ...r,
        _isGap: false,
        _isOldPolicy: true
      });
    }
  });

  return rows;
}
  window.BatchCalc = { buildPersonKey, groupPersons, makeBatchBonusSeparateRow, makeBatchBonusSynthRec,
    runBatchLaborPass, runBatchSalaryPass, runBatchSalaryPerson };
})();
