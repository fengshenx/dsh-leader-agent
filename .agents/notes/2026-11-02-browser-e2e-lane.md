# Agent Note: 浏览器 e2e 车道

## 背景

本仓的浏览器侧证据此前只有《浏览器侧取证的执行规范》：它规定了取证顺序、断言锚与禁令，却没有可执行的落点——没有起实例的命令、没有 mock provider 的代码、没有断言文件。结果每次需要「证明界面上真的这样」时，只能借宿主的浏览器工具一层层点，一轮一轮临场发挥；结论不可复现，也进不了回归。

宿主 dsh 的 `apps/web/tests/` 是一条成熟车道（真实 chromium → SSE → apiproxy → agent loop → 工具 → 持久化，约 10–30 秒无密钥跑完）。它不能整搬：`scaffold.ts` 约 1800 行，在进程内 import 宿主 cordis 树与 `dsh-llm-replay`，而本仓明令不 import 宿主内部包、不 peer 依赖 dsh。

## 决策

### 黑盒实例，不复制 scaffold

`tests/e2e/instance.mjs` 用 `mkdtemp` 建数据根，复用 `scripts/dev-instance.mjs` 派生 profile（与 `npm run dev` 同一份组合），再 spawn `dsh web --port 0 --no-open`，从 `dsh web: <url>` 行取带 token 的地址。端口用 `--port 0` 而不是扫空闲端口，token 只从就绪行读——两者都只能来自本次运行。

### mock 按 prompt 标记驱动，而不是复用宿主 mock 包

`@deepseek-ai/dsh-llm-mock-server` 是恢复行为脚本（限流、断连、部分文本），按请求序号出行为，不能按输入决定返回哪次工具调用。派工与看板场景要的恰恰是「这条输入一定触发这次工具调用」，所以自建 ~100 行零依赖 `node:http`：只实现 `POST /v1/messages` 的 Messages SSE，按用户消息里的 `MOCK-*` 标记查脚本，脚本按请求顺序消耗，两轮场景（工具调用 → 收工）靠「没有标记时沿用上一次命中的标记」表达。没有标记就 400，不猜。

### 宿主自己的附带调用要单独归类

宿主会用同一个模型给会话起标题，它的 prompt 带着用户原文，于是场景标记也会出现在里面。若不区分，标题请求会白白吃掉一步脚本，真正的第二轮请求报「脚本已耗尽」，失败原因看起来像场景写错了。`classifyRequest()` 按 system prompt 把这类请求归为 `title`，回固定文案，不参与游标；`mock.requests` 每条都带 `kind`，断言只数 `scenario`。

### 跑道用 node:test，不引 @playwright/test

本仓只有 `node:test`。宿主本身也是「runner 与浏览器库分离」（vitest + `playwright`），本仓等价物是 `node:test` + `playwright` core。`npm run e2e` 先 `npm run build:client`——`lib/client.js` 不入库，没构建时插件在界面上什么都不显示，宿主却照常启动、不报错，这是本仓最容易静默回退的一条。

### e2e 不进 `npm run check`

check 的门禁只跑纯函数与假件，不能依赖真实 `dsh` 与 chromium。可判定的部分（标记解析、脚本游标、SSE 事件序列、就绪行解析、显式端点检测）抽成纯函数进 `npm run check`，需要真浏览器的留在 `tests/e2e/*.e2e.js`。

## 边界

- **不覆盖**：原生控件（目录选择器、系统文件对话框）、浮层像素位置与动画观感、WebKit/Firefox。这些继续靠人工取证，PR 里标注「未 GUI 实测」。
- **不做 aria golden 与 refresh 工作流**：本仓没有受评审的 UI 快照所有权，断言锚是 DOM class、计算样式与落盘文件。
- **不为了 e2e 改生产代码**：场景用现有 class 与 role；需要新选择器时那是一次产品决定，不夹带。
- **跨进程拿不到 `whenIdle()`**：轮次完成的屏障只能从浏览器侧观察（回复上屏、落盘文件出现）。这是一个已知的弱化，写进文档。
- **显式 `baseURL` 会让 mock 静默失效**：派生 profile 时检测 `cordis.yml` / `cordis.patch.yml`，命中直接报错，不靠运气。
- **会话落盘格式是宿主的**（实测 `session.v4.jsonl.zstd`）：`session-logs.mjs` 递归找文件、两种后缀都认、解压失败视为「还在写」下一轮再读，不硬编码路径与版本号。

## 验证

- `npm run e2e`：2 个场景全绿，约 4 秒（`plugin.e2e.js` 2.9s + `session.e2e.js` 3.9s，并行）。
- `npm run check`：新增 `tests/e2e-logic.test.js`（6 例）与 `tests/e2e-mock-script.test.js`（12 例），全量通过。
- **双向验证 1**：把 `plugin.e2e.js` 的标题断言从 `'项目'` 改成 `'不存在的标题'` → 该用例 30s 超时变红；还原 → 变绿。
- **双向验证 2**：把 `mock-llm.mjs` 的 `cursor.take(resolveMarker(parsed))` 改成 `cursor.take(null)`（等于撤掉标记处理）→ `session.e2e.js` 在等回复时 90s 超时变红；还原 → 变绿。
- 真机读数：实例就绪行形如 `dsh web: http://127.0.0.1:<port>/?token=<...>`；新会话的 composer 在启动早期是 `data-phase="inert"`（`aria-label="选择工作区"`），等 `contenteditable="true"` 才是可输入状态；一条消息会带来两次模型请求（`scenario` + `title`）。
