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

### 起进程统一走 spawn-command，并由用例守住

`npm run dev` 与 e2e 都要起 `npm` / `dsh`，而 Windows 上 npm 装出来的是 `.cmd` / `.ps1` / 无扩展名 shim，裸 `spawn('dsh')` / `spawnSync('npm')` 必 ENOENT（#63 修过一次，真机读数见 `2026-11-02-windows-command-spawn.md`）。抽出 `dev-instance.mjs` 时曾退回裸 `spawn` / `spawnSync`，所以这里重新统一：`dev.mjs` 的构建与 `spawnDshWeb` 都经 `scripts/spawn-command.mjs`（`spawnCommandSync` / `spawnCommand`），异步路径用 `commandLaunchError` 把「命令不存在」与「cmd 起不来」分开报。

`tests/spawn-command-usage.test.js` 静态守这道线：scripts 与 e2e 夹具里**引入 `node:child_process`** 的文件必须在允许清单里（每条写理由），`dev.mjs` 里唯一的裸 `spawn` 只能是 `spawn(process.execPath)`。判据是模块说明符而不是导入语法——命名、命名空间、默认导入、`require`、`createRequire` 与动态 `import()` 都落在同一段字符串上；只认 `import { spawn }` 会被 `import * as cp from 'node:child_process'` 后调 `cp.spawn('dsh')` 绕过（第一版就是这么写的，被复审抓出来）。注释里提到也算，宁可加白名单，不留靠换写法就能绕过的缺口。选静态用例而不是单独门禁脚本：`npm run check` 已经跑 tests，不必再加一条命令，失败信息也能直接指出文件名。

### 截图走同一套夹具，不另开一条手工路径

「想看一眼界面上是什么样」过去只能手工开浏览器去点，这正是证据不可复现的来源。`e2e.screenshot(label)` 存到 `.dev/e2e-artifacts/<场景名>-<pid>/`（带进程 pid：同机并发两次 e2e 时同名场景不互相覆盖），`stop()` 前自动存一张 `final.png`（失败时它是唯一能看的东西），路径打到 stdout 供人或 agent 直接用 Read 打开。目录在 `.dev/` 下、已 gitignore：截图不入库，PR 里写读数而不是贴图。截图只是证据，回归仍靠断言——不写「截图里有某个字」这种断言。

### e2e 不进 `npm run check`

check 的门禁只跑纯函数与假件，不能依赖真实 `dsh` 与 chromium。可判定的部分（标记解析、脚本游标、SSE 事件序列、就绪行解析、显式端点检测）抽成纯函数进 `npm run check`，需要真浏览器的留在 `tests/e2e/*.e2e.js`。

## 边界

- **不覆盖**：原生控件（目录选择器、系统文件对话框）、浮层像素位置与动画观感、WebKit/Firefox。这些继续靠人工取证，PR 里标注「未 GUI 实测」。
- **不做 aria golden 与 refresh 工作流**：本仓没有受评审的 UI 快照所有权，断言锚是 DOM class、计算样式与落盘文件。
- **不为了 e2e 改生产代码**：场景用现有 class 与 role；需要新选择器时那是一次产品决定，不夹带。
- **跨进程拿不到 `whenIdle()`**：轮次完成的屏障只能从浏览器侧观察（回复上屏、落盘文件出现）。这是一个已知的弱化，写进文档。
- **显式 `baseURL` 会让 mock 静默失效**：派生 profile 时检测 `cordis.yml` / `cordis.patch.yml`，命中直接报错，不靠运气。
- **会话落盘格式是宿主的**（实测 `session.v4.jsonl.zstd`）：`session-logs.mjs` 递归找文件、两种后缀都认、解压失败视为「还在写」下一轮再读，不硬编码路径与版本号。
- **mock 的脚本游标是全局单值，一轮只支持一个会话在请求模型**：同一场景里协调者 + worker 并行时，无标记的请求会续到「最后命中的那份脚本」上，表现为脚本多跑一轮。做派工场景前先按 session id 分游标；文档的 mock 约定里写明了这条。
- **Node 需要 22.15+**：`session-logs.mjs` 用 `node:zlib` 的 zstd 解压（v22.15.0 加入），`node --test "tests/e2e/*.e2e.js"` 用 test runner 自带的 glob。旧版本上是 import 期就崩，不是跑不过，所以写进 `docs/e2e-testing.md` 的前提而不只靠 `engines`。

## 验证

- `npm run e2e`：2 个场景全绿，约 4.7 秒（`plugin.e2e.js` 3.5s + `session.e2e.js` 4.5s，并行）。
- `npm run check`：805 用例 / 796 通过 / 0 失败 / 9 跳过（跳过为既有的平台相关用例），含新增的 `tests/e2e-logic.test.js`（6 例）、`tests/e2e-mock-script.test.js`（12 例）与 `tests/spawn-command-usage.test.js`（4 例）。
- **双向验证 1**：把 `plugin.e2e.js` 的标题断言从 `'项目'` 改成 `'不存在的标题'` → 该用例 30s 超时变红；还原 → 变绿。
- **双向验证 2**：把 `mock-llm.mjs` 的 `cursor.take(resolveMarker(parsed))` 改成 `cursor.take(null)`（等于撤掉标记处理）→ `session.e2e.js` 在等回复时 90s 超时变红；还原 → 变绿。
- **双向验证 3**（spawn 门禁）：`dev-instance.mjs` 改回裸 `spawn(dshCommand, …)` → `起子进程只经 spawn-command.mjs` 红，报出该文件；还原 → 绿。`dev.mjs` 的 `run()` 改回 `spawnSync(command, …)` → `dev.mjs 的裸 spawn 只起 process.execPath` 红，actual `['spawnSync(command)', 'spawn(process.execPath)']`；还原 → 绿。
- **双向验证 3b**（门禁覆盖导入形态）：临时加 `tests/e2e/_probe-spawn.mjs`，分别写 `import * as cp from 'node:child_process'` + `cp.spawn('dsh')`、`import cp from 'node:child_process'` + `cp.spawn('dsh')`、`createRequire(import.meta.url)('node:child_process')` + `cp.spawn('dsh')` → 三种形态各自让门禁红并报出探针文件；删掉 → 4 例全绿。把 `referencesChildProcess` 临时退化成只认 `import { … } from` → `检测覆盖命名、命名空间、默认导入与 require 形态` 红并打印「漏检的写法：import * as cp from 'node:child_process'」；还原 → 绿。
- **双向验证 4**（mock 断连，探针 `/tmp/probe-mock-abort.mjs`：`content-length: 200` 只写 12 字节后 `destroy()`）：修复前进程 exit 1，栈是 `Error: aborted … code: 'ECONNRESET'`；修复后打印 `ALIVE`、exit 0。
- **双向验证 5**（失败路径临时根，探针 `/tmp/probe-instance-clean.mjs`，`DSH_HOME_SOURCE` 指向空目录）：修复前 `before=0 after=1`（残留一个 `dsh-leader-kit-e2e-*`）；修复后 `before=0 after=0`。
- 真机读数：实例就绪行形如 `dsh web: http://127.0.0.1:<port>/?token=<...>`；新会话的 composer 在启动早期是 `data-phase="inert"`（`aria-label="选择工作区"`），等 `contenteditable="true"` 才是可输入状态；一条消息会带来两次模型请求（`scenario` + `title`）。
- 截图读数：`.dev/e2e-artifacts/session-<pid>/reply.png` 里左栏有本插件的「项目」区块，会话消息是 `MOCK-E2E-REPLY 收工即可`，回复为 `mock 回执已收到`，会话标题是 mock 回的「e2e 会话」——标题请求被单独归类这一点也在图上。
- `npm run dev` 冒烟（macOS，`DEV_NO_OPEN=1 DEV_PORT=0 node scripts/dev.mjs`）：打印数据根与插件链接、跑完 `build:client`、最后一行 `dsh web: http://127.0.0.1:59789/?token=…`；起进程改经 `spawnCommand` 后行为不变。
