# 火车站下拉与预订页面样式统一 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将出发站、到达站合并为各自的可搜索下拉，统一火车票预订和机票售后视觉层级，不改变业务流程。

**Architecture:** 从现有已登录 Java 请求通道取候选，独立管理两个选站器的请求、候选、选中值和上下文；预订逻辑只读取已选车站。继续复用同一套表单、步骤区和主次按钮类。

**Tech Stack:** Electron、原生 HTML/CSS/JavaScript、Node test runner、离线 Electron smoke。

---

### 1. 选站数据和并发控制

- 参考 `/Users/admxj/workspace/mova/tmc/mova-tmc-h5/src/pages/train/city.vue:182-215`：`POST /train/station/search`，请求体 `{ stationName: keyword.trim() }`。读取 `groups[].stations`；空关键词保留分组及 `initial`，有关键词则按接口顺序展平。保留 `stationName` 和 `stationCode`，忽略缺字段项，用站码去重；同名不同站码保留。首版不额外请求热门站接口。
- 新增 `renderer/train-station-picker.js` 和 `test/train-station-picker.test.js`。先写测试覆盖分组、空响应、同名不同站码及无效数据；用两个可手动完成的 Promise 测试旧响应、旧错误和上下文变更都不能覆盖当前候选。运行 `node --test test/train-station-picker.test.js`，确认先失败。
- 最小实现：每个选站器持有独立序号和定时器，输入变化立即递增序号，约 250 ms 后请求；聚焦空框时加载空关键词分组。派发时捕获环境、租户和登录上下文；成功、错误及 loading 结束之前均检查序号、上下文和下拉是否还打开。关闭、选中、上下文切换均使旧请求失效。再次运行同一命令应通过。

### 2. 接入火车票页面与状态失效

- 修改 `renderer/index.html`、`renderer/train.js` 及该页面引用的主样式表。去掉两个手动站点搜索按钮和独立站点 select；每侧留一个 combobox，上下键移动、Enter 明确选中、Esc 关闭、Tab 离开，鼠标可选。用 `aria-expanded`、`aria-controls`、`aria-activedescendant` 和可读状态；中文输入法组合期间不发请求、不劫持 Enter。候选显示 `站名（站码）`，以 DOM 文本节点渲染。
- 加载中、无结果、失败可重试、未登录均在对应字段旁提示；一个字段失败不阻塞另一侧。候选只剩一条也不自动选中。查票只使用明确选中的站码，继续拒绝同站或未填日期；不把自由文本当站码。编辑已选文本立即清空该侧选值、车次、席别和待确认校验，不清空另一侧。环境、租户或登录变化清空两侧并拒绝迟到响应。保持原来的防重复提交、占座和查单行为。
- 先更新现有 Electron 火车票离线 smoke 的选站步骤，再实现。覆盖两侧选站（一侧走键盘）、真实查票请求体为站码、重新编辑后旧车次失效；网络请求全部使用 fixture，不触发真实占座。

### 3. UI 对齐与售后检查

- 对照 `renderer/index.html` 的酒店和机票下单步骤，火车票复用 `view-head`、`step`、`step-head`、`grid`、`actions` 和结果容器。查余票、验价并校验、提交占座为各自步骤的 `primary`；查经停、加载乘车人、确认差标和查单使用 `ghost`，保留禁用态。下拉宽度与字段一致，窄窗口可滚动，不遮挡弹层外的操作。
- 检查 `renderer/air-refund.js`、`renderer/air-change.js` 和售后容器：退票已有主次按钮；改签查询、预估、详情用 `ghost`，提交用 `primary`，支付按机票支付按钮的视觉规则区分。保留折叠面板、现有文案、按钮 ID/事件、禁用条件、确认弹窗和所有 API，不增加业务操作。
- 在 Electron 中对照酒店、机票下单、火车票与展开后的退票/改签；检查标准与窄窗口、键盘焦点、按钮层级、结果区域。售后仅离线检查 UI，不点击任何真实提交或支付。

### 4. 回归与交付

- `node --test test/*.test.js`：全部通过。`env -u ELECTRON_RUN_AS_NODE npm run smoke`：页面可渲染、离线火车票流程通过。`git diff --check`：无格式错误；核对改动没有触及运行时或发布规则。
- 实施时按选站逻辑、页面接入与样式分步审阅；本计划不授权推送或发 tag。将来只有确认发布、且实际变更满足同底座规则时，才使用界面热更新轨道。
