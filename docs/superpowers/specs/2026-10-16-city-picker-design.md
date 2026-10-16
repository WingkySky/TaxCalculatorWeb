# 城市选择器 CityPicker 设计（搜索+省市筛选一体·可复用模块）

- 日期：2026-10-16
- 状态：设计已评审通过（四节均获用户确认）
- 前置：`docs/superpowers/specs/2026-10-15-policy-provenance-design.md`（337 城数据落地后长列表不可用）
- 关联文件：`js/city-picker.js`（新增）、`js/page-params.js`、`js/page-policy.js`、`js/app.js`、`js/page-share.js`、`index.html`、`css/components.css`、`js/self-tests.js`、`tests/run.js`（加载清单加一行）

## 0. 背景与目标

337 城导入后城市下拉变成 337 项长列表（即便有 optgroup 分组），选城体验不可接受。目标：

- **输入快查**：输入城市名（或城市键拼音子串）即时过滤，无需回车；
- **省市筛选**：省份 chips 一键圈定范围，与关键词叠加（AND）；
- **全触点覆盖**：工资参数卡 `sp-city`、批量页整批 `batch-city`、政策库页 `pm-city` 三处统一替换；
- **独立模块**：抽象为 `js/city-picker.js`（`window.CityPicker`），未来新页面直接 mount。

| 决策点 | 结论（用户确认） |
|---|---|
| 交互形态 | 搜索+筛选一体的 combobox（级联双下拉、过滤条+原生 select 被否） |
| 面板信息密度 | 城市名右侧带数据可信度状态点（绿/黄/灰，复用前台徽标三色） |
| 模块架构 | 方案A 替换式组件：接管三个 select，散落的 5 处重建代码收敛为 `refresh()` |

### 非目标

- 全拼映射（零依赖不引拼音库；拼音检索支持到**城市键子串**级别，如 `zz`/`zheng` 命中 zzheng）
- 虚拟滚动（337 项一次性渲染）
- 批量页行内「城市」表格列（文本解析非选择器，不动）
- 引入任何外部组件库

## 1. 模块接口（js/city-picker.js）

```js
const picker = CityPicker.mount(containerEl, {
  value: 'guangzhou',        // 初始城市键
  onChange: (cityId) => {},  // 选中回调（含选空，batch 场景 cityId === ''）
  allowEmpty: false,         // 空值项（batch「跟随工资参数」）
  emptyLabel: '跟随「工资参数」中的城市',
  placeholder: '输入城市名，如 郑州'
});
picker.getValue();           // 当前城市键（'' = 空）
picker.setValue(id);         // 编程赋值（不触发 onChange，与 select 赋值语义一致）
picker.refresh();            // 城市表变化后重建索引（替代旧「重建下拉」）
picker.destroy();            // 解绑 document 级监听
```

- IIFE 命名空间，依赖 `PolicyLib`（CITY_POLICY_LIBRARY / POLICY_STATUS / statusLabel），遵循仓库「引入顺序即依赖顺序」：加载位置在 policy-library.js 之后。
- **渲染走模板字符串 + 内联事件**（与项目风格一致），`renderTriggerHTML/renderPanelHTML/renderListHTML` 为纯函数返回 HTML——Node 回归门可直测渲染输出。
- 数据通道：mount/refresh 时从 `CITY_POLICY_LIBRARY` 构建索引 `[{key, name, region, status}]`；**status 取该城 `effective` 末值最大的年度记录**（不依赖 `resolvePolicy`——它耦合 `salaryParams.policyYear`，模块保持无副作用）。
- 模块不写 localStorage、不改全局状态，值与回调全由调用方持有。

## 2. 交互与键盘

- 触发框（button，`aria-haspopup="listbox"` + `aria-expanded`）：显示状态点+城市名；空值时显示 emptyLabel 灰字。
- 面板：搜索框（`role="combobox"`、`aria-controls` 指向列表、`aria-expanded` 同步）→ 省份 chips（「全部」+ region 按索引序，选中态高亮，flex-wrap 换行）→ 结果列表（`role="listbox"`，项 `role="option"`）。
- 过滤：`q` 边输入边过滤（trim 后 `name.includes(q) || key.includes(q)`）；chips 与 q 叠加 AND；无结果显示空状态文案「无匹配城市，可换个关键词或清空省份筛选」+「清空筛选」按钮；**不清空用户输入**。
- 键盘：开面板→焦点进搜索框；↓↑ 移动高亮项（`aria-activedescendant` 同步 + 滚动跟随）；Enter 选中并收面板；Esc 收起、焦点回触发框；Tab 离开自动收起；点击面板外收起（document click 委托，destroy 时解绑）。
- 选中后：触发框文案/状态点更新、面板收起、`onChange(cityId)` 触发。

## 3. 三触点改造（联动语义不变）

| 触点 | 现状 | 改后 |
|---|---|---|
| `sp-city` 工资参数卡 | select + `onCityParamChange()` | `mount(容器, {value: salaryParams.cityId, onChange: () => onCityParamChange()})`；`onCityParamChange`/`readSalaryParams` 改读 `spPicker.getValue()` |
| `batch-city` 批量整批 | select + 空值「跟随」 | `mount(..., {allowEmpty: true, emptyLabel: '跟随「工资参数」中的城市', onChange: v => { TaxState.batchCityId = v; }})` |
| `pm-city` 政策库页 | select + `onPmCityChange()` | mount；`onPmCityChange` 内的下拉重建删除；`pmAddCity` 后调 `pmPicker.refresh()` |

- 散落的 4 处 `innerHTML = buildCityOptions(...)`（app.js×2、page-share.js、page-policy.js `syncCitySelects`）改为 `spPicker.refresh() + setValue(...)`。
- `refreshBatchCitySelect` 改为 batch picker `refresh() + setValue(batchCityId || '')`。
- `buildCityOptions`（含 optgroup）**保留**：picker 接管后仅供回归断言与兜底，函数头注明。
- 页面实例持有：三个 picker 挂在各自页面模块的模块级变量（`spPicker`/`batchPicker`/`pmPicker`），跨模块经 PageParams 暴露 `getSpPicker()` 等访问器（app.js/page-share.js/page-policy.js 经此调用，避免全局裸变量）。

## 4. 样式、主题与移动端

- 触发框与现有输入框同视觉：高 38px、`--t-border`、`--t-radius`、聚焦转 `--t-primary`；状态点 8px 圆点复用 `.pol-status-*` 三色 token，零新增颜色变量，亮暗主题自动跟随。
- 面板：触发框下绝对定位，宽 `max(100%, 320px)`、`max-height:320px` 内滚、z-index 高于卡片；≤768px 改 `position:fixed` 贴触发框全宽、触控行高 ≥40px。
- chips `flex-wrap`（不裁切不隐藏）；动效仅面板 0.15s 渐入，`prefers-reduced-motion` 下直接显示。
- 样式全部进 `css/components.css`，类名前缀 `city-picker-`。

## 5. 测试与验收

**Node 回归门（self-tests 新增，渲染纯函数直测）**：

1. `buildIndex`：城市数、region 去重集合、status 取最新年度记录；
2. 过滤纯函数：「郑州」→1 条；`zz`/`zheng` 命中 zzheng；`dg` 命中东莞；region=河南 + q=州 → 郑州；无命中 → 空数组；
3. 渲染断言：panel 含 chips/`role="listbox"`/空值项置顶/状态点三态 class；
4. 既有 297 项全绿（buildCityOptions 保留故 optgroup 断言不破）。

**浏览器验收（http+IAB 冒烟）**：输入「郑州」→Enter→工资参数卡切河南口径；「广东」chip→21 城含广深；↓↓Enter 选哈尔滨；Esc 收起；batch 选「跟随」→`batchCityId=''`；新增自定义城市→refresh 后出现在列表；file:// 双击全功能；亮暗主题状态点对比度；触控行高。

**tests/run.js**：加载清单按 index.html 顺序插入 `js/city-picker.js`（policy-library.js 之后、page-params.js 之前）。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| combobox 手写键盘/焦点遗漏 | 键盘行为清单化进验收；aria 属性固定组合；渲染纯函数可测 |
| 三触点联动回归（share/app 同步时序） | 联动语义逐点保留（表格见 §3）；现有回归门覆盖 readSalaryParams/onCityParamChange |
| Node DOM 桩不足 | 渲染全部为字符串函数，事件内联；不为组件加新桩（约定：桩在 tests/run.js 补，不改源码） |
| 长列表渲染卡顿 | 337 项 innerHTML 一次性渲染实测级开销（~20KB HTML）；索引 mount 时建一次 |
| 移动端遮挡 | 面板 fixed 全宽 + 触控行高 ≥40px；max-height 限高滚动 |
