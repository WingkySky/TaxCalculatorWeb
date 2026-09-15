/* ============================================================
 * social-insurance.js — SocialIns 社保公积金与专项附加计算
 * 职责：按城市政策计算社保公积金明细（个人+单位+企业成本）、
 *       专项附加扣除 7 项分项按月计算与校验、房租档位建议。
 * 对外接口：window.SocialIns。依赖：PolicyLib、TaxState。
 * ============================================================ */
(function () {
'use strict';
  const { round2 } = TaxUtils;
  const { clampItemBase, resolvePolicyMemo } = PolicyLib;

const EXTRA_ITEM_STANDARDS = {
  childEducation: '¥2,000/月/孩',
  infantCare: '¥2,000/月/孩',
  education: '学历 ¥400/月 · 职业资格 ¥3,600（取得当年）',
  houseLoan: '¥1,000/月（首套房贷）',
  houseRent: '¥1,500 / ¥1,100 / ¥800（按城市档）',
  support: '独生 ¥3,000/月 · 非独生分摊每人 ≤¥1,500',
  medical: '年度汇算专用'
};


const HOUSE_RENT_TIER_HINTS = { suzhou: 1100 };
function suggestHouseRentTier(cityId) { return HOUSE_RENT_TIER_HINTS[cityId] || 1500; }

/**
 * 按分项明细计算某月专项附加扣除（元）
 * @returns {{total, messages:string[], medicalAnnual:number}} 大病医疗不参与月度预扣，仅返回年度金额供汇算提示
 */
function computeExtraDetailFor(detail, ym) {
  const msgs = [];
  const d = detail || {};
  let total = 0;
  if (d.childEducation && d.childEducation.on) {
    total += 2000 * Math.max(0, Math.floor(Number(d.childEducation.count) || 0));
  }
  if (d.infantCare && d.infantCare.on) {
    total += 2000 * Math.max(0, Math.floor(Number(d.infantCare.count) || 0));
  }
  if (d.education && d.education.on) {
    if (d.education.kind === 'cert') {
      if (ym && d.education.certMonth === ym) total += 3600;
    } else {
      total += 400;
    }
  }
  if (d.houseLoan && d.houseLoan.on && d.houseRent && d.houseRent.on) {
    msgs.push('住房贷款利息与住房租金互斥，不得同时扣除（按房贷优先计）');
  }
  if (d.houseLoan && d.houseLoan.on) {
    total += 1000;
  } else if (d.houseRent && d.houseRent.on) {
    total += Math.max(0, Number(d.houseRent.tier) || 0);
  }
  if (d.support && d.support.on) {
    if (d.support.mode === 'solo') {
      total += 3000;
    } else {
      const share = Math.max(0, Number(d.support.share) || 0);
      if (share > 1500) msgs.push('赡养老人非独生子女分摊扣除每人每月不超过 1500 元，已按 1500 计');
      total += Math.min(share, 1500);
    }
  }
  const medicalAnnual = (d.medical && d.medical.on) ? Math.max(0, Number(d.medical.annual) || 0) : 0;
  if (medicalAnnual > 0) {
    msgs.push('大病医疗不参与每月预扣预缴，年度汇算清缴时可申报（医保目录内自付累计超 15,000 元的部分，限额 80,000 元）');
  }
  return { total: total, messages: msgs, medicalAnnual: medicalAnnual };
}

/** 月度专项附加扣除（元）：分项模式按月计算（含职业资格取证月 3600），否则用单一总额 */
function getExtraDeductionFor(ym) {
  if (salaryParams.extraDetail && salaryParams.extraDetail.on) {
    return computeExtraDetailFor(salaryParams.extraDetail, ym);
  }
  return { total: Math.max(0, Number(salaryParams.extraDeduction) || 0), messages: [], medicalAnnual: 0 };
}


function computeSocialInsuranceDetail(socialBase, fundBase, items, fundRate) {
  const fr = (fundRate == null || fundRate === '' || isNaN(Number(fundRate))) ? (items.fund.personal || 0) : Number(fundRate);
  const rawFund = (fundBase === '' || fundBase == null || isNaN(parseFloat(fundBase))) ? socialBase : fundBase;
  const socialRaw = Number(socialBase) || 0;
  const fundRaw = Number(rawFund) || 0;
  const injuryItem = items.injury || { lower: null, upper: null };

  const pensionBase = clampItemBase(socialBase, items.pension);
  const medicalBase = clampItemBase(socialBase, items.medical);
  const unemploymentBase = clampItemBase(socialBase, items.unemployment);
  const injuryBase = clampItemBase(socialBase, injuryItem);
  const fundClamped = clampItemBase(rawFund, items.fund);

  const erRate = (k) => (items[k] && items[k].employer != null) ? items[k].employer : 0;
  const pension = pensionBase * items.pension.personal;
  const medical = medicalBase * items.medical.personal;
  const unemployment = unemploymentBase * items.unemployment.personal;
  const fund = Math.round(fundClamped * fr);

  const erPension = pensionBase * erRate('pension');
  const erMedical = medicalBase * erRate('medical');
  const erUnemployment = unemploymentBase * erRate('unemployment');
  const erInjury = injuryBase * erRate('injury');
  const erFundRate = (items.fund.employer != null) ? items.fund.employer : fr;
  const erFund = Math.round(fundClamped * erFundRate);

  return {
    pension: round2(pension),
    medical: round2(medical),
    unemployment: round2(unemployment),
    fund: round2(fund),
    total: round2(pension + medical + unemployment + fund),
    fundRateUsed: fr,
    employer: {
      pension: round2(erPension),
      medical: round2(erMedical),
      unemployment: round2(erUnemployment),
      injury: round2(erInjury),
      fund: round2(erFund),
      total: round2(erPension + erMedical + erUnemployment + erInjury + erFund)
    },
    socialBaseRaw: socialRaw,
    fundBaseRaw: fundRaw
  };
}

/**
 * 按城市+月份解析政策后计算社保公积金（带政策标签）
 */
function computeSocialInsuranceFor(cityId, month, socialBase, fundBase) {
  const pol = resolvePolicyMemo(cityId, month);
  const detail = computeSocialInsuranceDetail(socialBase, fundBase, pol.items, salaryParams.fundRate);
  detail.policy = pol;
  return detail;
}

/**
 * 兼容旧调用：按当前工资参数（当前月份）计算社保公积金合计
 */
function computeSocialInsurance(socialBase, fundBase) {
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return computeSocialInsuranceFor(salaryParams.cityId, ym, socialBase, fundBase).total;
}


  window.SocialIns = { EXTRA_ITEM_STANDARDS,HOUSE_RENT_TIER_HINTS,computeExtraDetailFor,computeSocialInsurance,computeSocialInsuranceDetail,computeSocialInsuranceFor,getExtraDeductionFor,suggestHouseRentTier };
})();
