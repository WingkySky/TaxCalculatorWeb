/* ============================================================
 * app.js — App 应用壳
 * 职责：hash 路由（四个页面）、侧边栏（折叠/移动端抽屉）、
 *       亮暗主题切换、所得类型全局切换、初始化引导。
 * 对外接口：window.App。依赖：全部模块（最后加载）。
 * ============================================================ */

(function () {
'use strict';

  /* ---------- 路由 ---------- */
  const ROUTES = ['multi', 'batch', 'annual', 'policy', 'rules', 'share'];

  function currentRoute() {
    const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.includes(h) ? h : 'multi';
  }

  function navigate(route) {
    if (!ROUTES.includes(route)) route = 'multi';
    if (currentRoute() === route) { renderRoute(); return; }
    location.hash = '#/' + route;
  }

  let booted = false;   // 启动期的 share 路由延后到 init 末尾处理（页面/各模块就绪后才能还原数据）

  function renderRoute() {
    const route = currentRoute();
    if (route === 'share') {
      if (booted) PageShare.applyShare();   // 运行期跳转分享链接
      return;                               // 启动期：由 init 末尾统一处理，避免在页面初始化前还原数据
    }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById('page-' + route);
    if (page) page.classList.add('active');
    document.querySelectorAll('.menu-item').forEach(mi =>
      mi.classList.toggle('active', mi.dataset.route === route));
    window.scrollTo(0, 0);
    closeDrawer();
  }

  function initRouting() {
    window.addEventListener('hashchange', renderRoute);
    document.querySelectorAll('.menu-item').forEach(mi => {
      mi.addEventListener('click', () => navigate(mi.dataset.route));
    });
    renderRoute();
  }

  /* ---------- 侧边栏：桌面折叠 + 移动端抽屉 ---------- */
  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('sidebar-collapse');
    const hamburger = document.getElementById('sidebar-hamburger');
    const mask = document.getElementById('drawer-mask');

    if (localStorage.getItem('tc-sidebar-collapsed') === '1') {
      sidebar.classList.add('collapsed');
    }
    collapseBtn.addEventListener('click', () => {
      const collapsed = sidebar.classList.toggle('collapsed');
      localStorage.setItem('tc-sidebar-collapsed', collapsed ? '1' : '0');
    });
    hamburger.addEventListener('click', () => {
      sidebar.classList.add('drawer-open');
      mask.classList.add('show');
    });
    mask.addEventListener('click', closeDrawer);
  }

  function closeDrawer() {
    const sidebar = document.getElementById('sidebar');
    const mask = document.getElementById('drawer-mask');
    if (sidebar) sidebar.classList.remove('drawer-open');
    if (mask) mask.classList.remove('show');
  }

  /* ---------- 主题（跟随系统 + 手动持久化） ---------- */
  function applyTheme(dark) {
    // 图标可见性由 CSS（html.theme-dark）驱动，这里只切主题 class
    document.documentElement.classList.toggle('theme-dark', dark);
  }

  function initTheme() {
    const saved = localStorage.getItem('tc-theme');
    const dark = saved ? saved === 'dark'
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(dark);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const nowDark = !document.documentElement.classList.contains('theme-dark');
      applyTheme(nowDark);
      localStorage.setItem('tc-theme', nowDark ? 'dark' : 'light');
    });
  }

  /* ---------- 所得类型全局切换（劳务 / 工资） ---------- */
  function setIncomeType(type) {
    if (type !== 'labor' && type !== 'salary') return;
    incomeType = type;
    document.querySelectorAll('.income-type-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.incomeType === type));
    const showSalary = type === 'salary';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('multi-params-card', showSalary);     // 工资参数卡内嵌于多月累计页
    show('batch-global-fallback', showSalary); // 批量页全局兜底设置（整批城市/应发作基数）
    show('batch-info-labor', !showSalary);
    show('batch-info-salary', showSalary);
    show('multi-gap-row', !showSalary);   // 断月重置不适用于工资薪金
    show('multi-bonus-row', showSalary);  // 年终奖仅工资薪金适用
    show('rules-labor', !showSalary);     // 计算规则页跟随所得类型切换
    show('rules-salary', showSalary);
    PageMulti.updateMultiInputHints();
  }

  function initIncomeType() {
    document.querySelectorAll('.income-type-btn').forEach(btn => {
      btn.addEventListener('click', () => setIncomeType(btn.dataset.incomeType));
    });
  }

  /* ---------- 计算方向切换（多月累计页） ---------- */
  function initDirection() {
    document.querySelectorAll('.direction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        const dir = btn.dataset.dir;
        btn.parentElement.querySelectorAll('.direction-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (target === 'multi') {
          multiDirection = dir;
          PageMulti.updateMultiInputHints();
        } else {
          batchDirection = dir;
        }
      });
    });
  }

  /* ---------- 政策库远端更新 ---------- */
  function onPolicyRemoteApplied(e) {
    window._policyRemoteInfo = e.detail;
    PagePolicy.onPmCityChange();   // 政策库页重渲染（含 picker 刷新 + 存储状态 + 本地改动标记）
    PageParams.syncSpPicker();     // 工资参数卡 picker 同步新城市表
    PageParams.onCityParamChange();  // 工资参数卡政策明细与批量兜底盒刷新
    console.info(`政策库已自动更新：${e.detail.from} → ${e.detail.to}（${e.detail.modified ? '保留 ' + e.detail.modified + ' 处本地修改' : '无本地冲突'}）`);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    // 官方政策数据更新先于任何 UI 构建启动期检查（file:// 换新种子的同步合并），
    // 远端 JSON 拉取为异步，完成后经 policy:remote-applied 事件刷新相关视图
    PolicyLib.applySeedUpdateIfNewer();
    window.addEventListener('policy:remote-applied', onPolicyRemoteApplied);
    PolicyLib.initRemotePolicy();

    initTheme();
    initSidebar();
    initRouting();
    initIncomeType();
    initDirection();

    PageMulti.buildMonthGrid();
    PageRules.render();   // 计算规则页税率表（与 TaxEngine 共用数据）
    PageAnnual.render();  // 年度汇算页表单（年度切换只影响计算，不需重建）

    // 有外置政策数据时默认选第一个非自定义城市
    if (Object.keys(PolicyLib.CITY_POLICY_LIBRARY).length > 1 && salaryParams.cityId === 'custom') {
      salaryParams.cityId = Object.keys(PolicyLib.CITY_POLICY_LIBRARY).find(k => k !== 'custom') || 'custom';
    }
    PageParams.syncSpPicker();
    PageParams.onCityParamChange();
    PageParams.initCard();
    setIncomeType('labor');
    PagePolicy.onPmCityChange();   // 政策库页初始化：城市下拉 + 编辑器 + 存储状态

    // 自检（初始化完成后运行，console 输出结果；node tests/run.js 跑同一份断言）
    if (window.TaxTest) TaxTest.runAll();

    // 直开分享链接（hash 即 #/share）：待页面与各模块就绪后再还原数据
    booted = true;
    if (currentRoute() === 'share') PageShare.applyShare();
  }

  window.App = { navigate, setIncomeType, init };
  document.addEventListener('DOMContentLoaded', init);
})();
