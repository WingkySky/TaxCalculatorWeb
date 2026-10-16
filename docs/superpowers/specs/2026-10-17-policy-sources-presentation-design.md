# 政策库来源列表呈现重设计——摘要行 + 展开详情

> 日期：2026-10-17 · 状态：设计已评审通过（brainstorming 会话，视觉伴侣方案对比选定 A）
> 范围：**仅**政策库页「来源与核查」编辑区（`page-policy.js` 的 `renderProvenanceEditor`）。
> 前台溯源浮层（`page-params.js` `showProvenanceModal`）保持现状。

## 一、背景与痛点

核查政策时搜到的官方文件逐条录在政策库页「来源与核查」区，现状是每条来源渲染为一个**常驻可编辑表单盒**：标题/文号/发布日期/链接 URL/发布方/确认了什么六字段全用 `<input>`（其中「确认了什么」是单行框），外加 5 个险种复选框与删除按钮，多条来源垂直堆叠。三个痛点：

1. **链接不可点击**——URL 是文本框，核对时须手动复制粘贴到浏览器。
2. **浏览杂乱**——只是想看看有哪些来源，也要面对一坨输入框；长「确认了什么」在单行框里无法阅读（官方种子里的 confirms 长达数百字）。
3. **记录多则冗长**——来源条数一多，表单盒堆叠把险种比例表挤出视口。

数据规模（tax-policy-data.json 实测）：338 城、272 条年度记录带来源、共 615 条来源、单记录最多 3 条；存在「官方佐证页」这类**只有 URL、无标题/文号/确认内容**的稀疏记录，新呈现必须优雅兼容。

## 二、目标（验收标准）

1. 有合法 URL 的来源，摘要行与阅读态都有可点击的「原文 ↗」，新开标签直达官方文件。
2. 默认态每条来源只占一行摘要；全部字段仅在展开/编辑时可见。
3. 长文本（确认了什么）阅读态为完整段落，编辑态为多行文本域。
4. 稀疏记录（仅 URL）呈现不破相；老存档、官方种子、远端合并、Excel 导入导出零影响。

## 三、方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| **A 摘要行 + 展开详情** | 每条默认一行摘要，点击展开阅读态，点「编辑」才出表单 | **选定**：三痛点一次解决，桌面/移动共用一套 markup |
| B 只读卡片 + 弹窗编辑 | 页面零输入框，编辑进弹窗 | 弃：核对最高频动作是「贴 URL + 补确认内容」，弹窗多一跳，移动端填长表单差 |
| C 紧凑表格 + 行内展开 | 来源压成表格 | 弃：长标题/长确认内容在单元格仍截断；移动端需另做一套卡片形态 |

编辑表单本身的升级三方案通用：确认了什么改 `<textarea>`；URL 仍是输入框，但摘要行/阅读态永远有可点的原文按钮。

## 四、详细设计

### ① 三态交互与状态管理

每条来源一个卡片单元，三态：

- **收起（默认）**：标题（超长截断省略）+ 元信息一行 + 证实险种 chips + 「原文 ↗」+ ▾。点整行展开。
- **展开（阅读态）**：头部同摘要（▴）；下方完整显示文号、发布日期、发布方、确认了什么（完整段落，`white-space:pre-wrap`）、「查看原文 ↗」链接；按钮「✎ 编辑」「删除此来源」。
- **编辑态**：详情区字段变表单——标题/文号/日期/发布方一行、URL 一行、确认了什么 `<textarea>`、证实险种 chip 切换；按钮「完成」。**字段改动沿用现有 onchange 即存语义**（改一字段立即落 localStorage），「完成」仅退出编辑态，不引入暂存/撤销——与页面其他编辑行为一致。

状态存 `page-policy.js` 模块级变量：

- `_pmSrcOpenSet`（Set，索引集合）：**允许多条同时展开**（对照两条来源是核查真实需求）。
- `_pmSrcEditIdx`（number|null）：**编辑态同时只允许一条**，开始编辑另一条时自动退出当前编辑。
- 切换城市/年度（`onPmCityChange`/`onPmYearChange`）时两个状态清空。

**索引漂移防护（必须）**：凡导致 `sources` 数组重建的操作——删除任一来源、恢复官方 sources（⟲）、导入覆盖——**一律重置全部展开/编辑状态**（全收起）。来源无稳定 id，索引是唯一键，宁可多收起不可错位。新增来源（`onPmSourceAdd`）则追加后直接对末位进入编辑态。

### ② 元信息与稀疏记录兜底

摘要行元信息优先级：`发布方 · 日期` → 无则 URL **域名**（`new URL` 解析，失败截取原串前 40 字符）→ 全无则不显示。标题缺失显示「未命名来源」。covers 语义沿现状：**未存（缺省）= 证实全部险种**（摘要行显示全部 5 枚 chip，编辑态全勾）；**空数组 = 明确不证实任何险种**（摘要行显示灰色「不证实险种」chip，不留看似渲染 bug 的空白）。

### ③ 原文链接与安全

- 摘要行「原文 ↗」与阅读态「查看原文 ↗」均为真 `<a target="_blank" rel="noopener noreferrer">`，仅 `^https?://i` 匹配才渲染（沿用 `showProvenanceModal` 既有规则）。
- 摘要行点击链接 `stopPropagation`，不误触展开/收起。
- 所有用户内容按现有转义纪律处理：属性用 `pmEscAttr`、文本节点转义后输出。confirms 中的 `**markdown**` 粗体记号按纯文本原样显示（与前台浮层一致，本次不做 markdown 渲染）。

### ④ 样式与移动端

- 复用现有 token 与类：`--t-border`/`--t-bg-header`/`--t-primary`/`--t-text-2`、`pm-item-input`、`btn btn-secondary btn-sm`。**注意 tokens.css 无 `--t-bg`**（var 会静默透明），表面色用 `--t-bg-container`/`--t-bg-header`。
- 新类 `.pm-source-row` 系追加到 `css/components.css`（`pm-*`/`pol-*` 类所在文件）。
- 桌面/移动**共用一套 markup**（摘要行 flex-wrap 自适应），不做 `only-mobile` 双形态。

### ⑤ 数据与兼容：零结构变更

`sources[]` 字段、`normalizeSources`、`mergeSources` 三方合并、Excel 导入导出（`libraryToRows`/`rowsToLibrary` 本就不含 sources 列）全部不动。纯渲染层重构。代码留在 `page-policy.js`（溯源编辑是政策库页职责，文件 575 行未超载，不新建文件）。

### ⑥ 纯函数下沉 PolicyLib（可测性）

`tests/run.js` 回归门**不加载 page-policy.js**，故把两个纯函数放进 `policy-library.js` 并导出，`page-policy.js` 解构使用：

- `sourceMetaText(s)`：按②的优先级返回元信息串（无则空串）。
- `safeSourceUrl(url)`：`^https?://i` 匹配返回原串否则空串。

## 五、改动面清单

| 文件 | 改动 |
|---|---|
| `js/page-policy.js` | 重写 `renderProvenanceEditor`；新增 `onPmSourceToggleExpand`/`onPmSourceStartEdit`/`onPmSourceDoneEdit` 三个 handler；字段编辑复用现有 `onPmSourceFieldChange`/`onPmSourceCoversToggle`；`onPmSourceDelete` 与 `onPmRestoreField('__rec','sources')` 路径补状态重置；`onPmSourceAdd` 追加后进入末位编辑态；`onPmCityChange`/`onPmYearChange` 清状态 |
| `js/policy-library.js` | 新增导出 `sourceMetaText`、`safeSourceUrl` |
| `css/components.css` | 追加 `.pm-source-row` 系类 |
| `js/self-tests.js` | 新增约 4 条断言：元信息发布方优先、域名回退、非法 URL 拒渲染、空 covers 语义 |

## 六、测试计划

1. **Node 回归门**：`node tests/run.js` 现有全部套件 + 新断言全过。
2. **浏览器冒烟**（临时 http 服务，alert 会阻塞命令须手动走）：收起/展开（多条同开）/编辑单飞/完成/新增（直入编辑）/删除（全收起）/⟲ 恢复官方 sources/切城市切年度清状态/稀疏记录（东莞 dg-2025「官方佐证页」）/长 confirms 段落显示（dg-2025 主来源）。
3. **移动形态**：窄视口下摘要行换行不横向溢出。

## 七、明确不做（out of scope）

- 前台溯源浮层（`showProvenanceModal`）不动，仅共享 `safeSourceUrl` 的判定规则，不顺手重构。
- 不做来源排序/搜索/批量核查视图——单记录实测最多 3 条，YAGNI；跨城核查工具属政策库路线图第④步，另行立项。
- 不做撤销/草稿暂存；不做 confirms 的 markdown 渲染。

## 八、风险与注意

- **重绘丢输入**：现有模式是任一字段 onchange 触发 `renderPolicyEditor()` 全量重绘，编辑态下正在输入的 textarea 会被刷新为已存值。沿用现状不为此改局部渲染；若实测碍手，后续单独立项。
- 展开/编辑状态是索引键，任何数组重建必须按①重置——规格评审时最容易漏的一条。
