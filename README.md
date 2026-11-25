# TMC 下单调试工具

基于 Electron 的桌面调试工具，用来快速走通 **机票 / 酒店** 的「查询 → 验价 → 下单 → 支付」链路。接口调用方式参考 `mova-tmc-h5`，但所有请求都由本工具直接发出，不依赖 H5 页面。

## 功能

- **机票**：航班搜索（因公/因私）、选航班号后按 `guid` 自动拉全部报价、选报价自动查详情、常旅客拉取乘机人、验价拿 `quoteToken`、创建订单、支付、支付宝参数、查单、取消。
- **酒店**：酒店搜索（因公/因私）、详情与房型、验价、创建订单、企业支付、支付状态、支付宝参数、订单详情。
- **登录**：账号密码、手机号验证码、直接粘贴 token；支持多租户选择。
- **可配置前缀**：Java 业务与 Go 登录域名、路径前缀、默认租户均可改。
- **搜索条件记忆**：机票的出行性质、行程类型、三字码、日期、人数，以及酒店的出行性质、城市、入住/离店日期、每页数量都会保存在本机，退出重开自动恢复上一次的查询条件。
- **请求可见**：每个步骤的请求体都是可编辑 JSON；右侧 inspector 展示最近一次请求与响应，支持一键复制请求体、响应体和完整 URL，支持 Ctrl+F（macOS 为 Cmd+F）在响应/请求中查找并高亮；「请求日志」保留本次运行最多 100 条记录。
- **无 CORS 问题**：渲染进程不直接发请求，统一通过主进程 `fetch` 代理。

## 启动

要求 Node.js 18+（开发时使用 v24）。

```bash
cd tmc-tool
npm install
npm start
```

关闭窗口（左上角 ×）会直接退出应用，不会留在 Dock/后台。

首次启动 Electron 会下载二进制。

### 常见问题

- 启动时报 `Cannot read properties of undefined (reading 'whenReady')`：当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 被当作 Node 执行了。先 `unset ELECTRON_RUN_AS_NODE` 再启动。
- 请求失败先看右侧 inspector 的 HTTP 状态与响应体；`未配置域名` 说明还没在「接口配置」里填 Java / Go 域名。

## 配置

进入「接口配置」：

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| Java 业务域名 | 机票、酒店业务接口的 host | 空 |
| Java 前缀 | 业务前缀，最终 URL = `javaBase + javaPrefix + path` | `/api` |
| Go 登录域名 | 登录、用户信息接口的 host | 空 |
| Go 前缀 | 登录前缀，最终 URL = `goBase + goPrefix + path` | `/goco/api` |
| 默认租户编码 | 登录与业务请求里可选的 `tenantCode` | 空 |

配置保存在本机 `localStorage`（key：`tmc.settings.v1`），token 保存在 `tmc.token.v1`。登录成功后所有业务请求自动带 `Authorization: Bearer <token>`。

## 机票流程

1. 选择出行性质（因公 `BUSINESS` / 因私 `PRIVATE`），填写出发/到达三字码、日期、人数，点「查询航班」→ `POST /flight/search`。
2. 在航班卡片里点「选择此航班」，工具按该航班的 `guid` 自动调 `POST /flight/searchProduct`，列出这个航班下的全部报价。
3. 点某条报价的「选择此报价」，工具自动调 `POST /flight/searchDetail` 获取该 `detailKey` 的详情。
4. 点「拉取常旅客」→ `POST /passenger/list`（`source: ORG`），点选乘机人后自动填入姓名、证件、手机号；也可以手动填写。
5. 点「验价」→ `POST /air/order/price`，拿到 `quoteToken`；再「创建订单」→ `POST /air/order/create`，最后支付 `POST /air/order/pay`；因私订单可点「支付宝参数」调 `/air/order/{orderNo}/pay/alipay`。

常旅客接口通常返回脱敏证件号/手机号，工具优先用 `cardNo`/`mobile`，没有明文时回退 `cardNoMask`/`mobileMask`（与 H5 一致）；如果验价要求明文，选中后手动补全即可。

产品价格按元展示；下单的 `segmentList` 中 `salePrice`、`airportFee`、`fuelTax` 按 H5 约定传两位小数的元字符串，验价/订单金额按分展示。

## 因私预订

机票和酒店第 1 步都有「出行性质」：

- `BUSINESS`（因公）：默认值，行为与之前一致。
- `PRIVATE`（因私）：该值会透传到查询、报价、创单、支付、取消等请求的 `travelPurpose` 字段。

当前后端在搜索阶段只接收并校验 `travelPurpose`，不改变供应商搜索条件；真正的限制从验价开始，工具会原样带上该字段：

- **机票**：仅支持单航段、单乘机人、丰谊国内供应商；因私身份按登录员工、同名、身份证件类型校验（员工主数据无证件号，不再比对证件号）；创单时 `voyageType` 固定提交 `ONE_WAY`，报价与下单的 `travelPurpose` 必须一致。
- **酒店**：仅支持本人预订 1 间房、1 位入住人；入住/离店日期须在今天至未来 30 天内；入住人须与登录人本人实名一致。

因此用因私模式调试时，请先拉取常旅客或手动填写登录人本人的真实姓名、证件号和手机号；验价后切换出行性质会使 `quoteToken` 失效，工具会清空验价结果并提示重新验价。

## 酒店流程

1. 选择出行性质，在城市编码框中输入城市名/三字码，从 `/hotel/region/search` 返回的下拉结果中选城市（自动回填 cityCode 与城市名称），再填入离店日期，点「搜索酒店」→ `POST /hotel/search`。
2. 选酒店 → `POST /hotel/detail`，在房型表格里选产品。
3. 进入第 3 步会自动拉取常旅客（`POST /passenger/list`），也可点「拉取常旅客」刷新；点选后自动填入入住人姓名、证件与手机号，并作为 `employeeId` + `cardNoMask` 带入验价，无需手填证件号明文。也可以不使用常旅客，直接手动填写。点「验价」→ `POST /hotel/orders/price`。
4. 点「创建订单」→ `POST /hotel/orders/create`。
5. 企业支付 / 支付状态 / 支付宝 / 订单详情，对应 `/hotel/orders/{orderNo}/pay`、`/pay/status`、`/pay/alipay`、`/detail`。

验价请求里的 `partnerCode`、`supplyCode`、`hotelProductType` 来自详情产品；`roomNights` 由入住日期与 `nightlyPrices` 自动生成，金额单位为分。若后端要求手机号/证件号密文，请在请求体 JSON 里自行替换对应字段后再执行。

## 目录

```
main.js              Electron 主进程：窗口、IPC、HTTP 代理、冒烟截图
preload.js           contextBridge 暴露 window.tmcBridge
renderer/
  index.html         页面结构
  styles.css         样式
  lib.js             配置、登录态、api()、日志、inspector、JSON 请求体
  flight.js          机票流程
  hotel.js           酒店流程
  app.js             视图切换、登录、设置、日志
```

## 冒烟测试

```bash
unset ELECTRON_RUN_AS_NODE
npm run smoke
```

启动后会自动切换各 tab 并截图到系统临时目录，用于确认渲染无报错。若设置 `TMC_SMOKE_STEPS_FILE`（JSON 步骤文件），还会依次执行 `js`、`waitMs`、`shot` 步骤，可配合本地 mock 做全链路验证。
