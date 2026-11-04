# 浏览器侧证据：e2e 车道与人工取证

`npm run check` 只覆盖纯函数与落盘逻辑。圆点档位、折叠水位、浮层位置这类东西，只有把应用真跑起来才能证明。

本仓之前只有「人做取证」的规范，没有可执行的车道：读完文档仍然只能借宿主的浏览器工具一层层点，一轮一轮临场发挥，结论不可复现、不进回归。现在两条路并存：

- **e2e 车道**（`npm run e2e`）——能写成断言的行为一律走这里，一条命令跑完、可以放进 PR 证据。
- **人工取证**（[本文末节](#人工取证没有可脚本化断言时)）——只有脚本化不了的部分才走，且必须在 PR 里标注「未 GUI 实测」或写明测了什么。

## 分层与判据

| 层 | 命令 | 证明什么 | 证明不了什么 |
|---|---|---|---|
| 纯函数与落盘 | `npm run check` | 投影、状态归一、去重、串行与并发 | 浏览器里实际渲染成什么 |
| 浏览器 e2e | `npm run e2e` | 真实宿主里的挂载、交互、wire、落盘 | 未写成断言的行为；原生控件与浮层的像素位置 |
| 人工取证 | 本文末节 | 剩下那些只有人眼能判的东西 | 不可复现，不能当回归 |

能在纯函数层断言的先落 `tests/`；能在 e2e 层断言的不要再手工点。

## 车道

```sh
npm run e2e:install    # 首次：下载 chromium（约 150MB）
npm run e2e            # 构建客户端产物 + 跑全部 e2e 场景
npm run build:client && node --test tests/e2e/plugin.e2e.js   # 只跑一个文件
```

`npm run e2e` 先跑 `npm run build:client`：`lib/client.js` 不入库，没构建时插件在界面上什么都不显示，宿主却照常启动、不报错。

**单跑也要先构建**：`node --test` 不构建，新 checkout / worktree 里 `lib/` 为空，症状是每个等待都超时，不是启动失败。

**`npm run e2e -- <文件>` 不会缩小要跑的集合**：npm 把 `--` 后面的参数追加到 script 末尾，实际执行的是 `node --test "tests/e2e/*.e2e.js" <文件>`，脚本里的 glob 照旧展开，两个文件都会跑（实测 `tests 2`）。要单跑一个文件就绕过 npm script 直接调 `node --test`；改过 `src/client/` 时先自己 `npm run build:client`。

**不加 `--test-force-exit`**：它会把漏清理从「挂住/超时变红」变成「绿着通过 + 留下孤儿进程」，挂住应当暴露；已知三处已由有界清理收干净，取舍见[清理上限笔记](../.agents/notes/implemented/testing/2026-11-04-e2e-shutdown-bounded.md)。

前提：`dsh` 装好，且源 profile（默认 `~/.dsh/profiles/web`）里装过本插件——与 `npm run dev` 相同，缺任何一个都会当场报错并给出可照做的修法。Node 需要 22.15+：`session-logs.mjs` 用 `node:zlib` 的 zstd 解压（v22.15.0 加入），`node --test "tests/e2e/*.e2e.js"` 依赖 test runner 自带的 glob。旧版本上不是「跑不过」，而是 import 期就崩。

### 文件职责

```
tests/e2e/
  instance.mjs       起隔离实例：mkdtemp 数据根、派生 profile、注入 mock 端点
  harness.mjs        launchE2E()：mock + 实例 + chromium；waitFor()、waitForLocator()、describePage()
  mock-llm.mjs       本地 Messages mock（node:http，零依赖）
  mock-script.mjs    可判定部分：标记解析、脚本游标、SSE 事件序列
  session-logs.mjs   读会话日志（递归、兼容未压缩与 zstd）
  *.e2e.js           场景
tests/e2e-logic.test.js       实例侧纯函数（URL 行解析、显式端点检测）
tests/e2e-mock-script.test.js mock 纯函数
```

后两个 `*.test.js` 进 `npm run check`；`tests/e2e/**` 只有 `npm run e2e` 才跑。

### 场景模板

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchE2E, scenarioTimeout, waitFor, waitForLocator } from './harness.mjs'
import { sessionLogsContain } from './session-logs.mjs'

test('场景要证明的一句话', { timeout: scenarioTimeout() }, async (t) => {
  // scripts 的键是标记名，值是这一轮请求依次要拿到的东西
  const e2e = await launchE2E({ scripts: { 'MOCK-XXX': [{ text: '回执' }] } })
  t.after(() => e2e.stop())

  await e2e.open()
  // 交互一律用 locator 等状态；不要 page.waitForTimeout
  await e2e.page.locator('div[role="textbox"][contenteditable="true"]').first()
    .fill('MOCK-XXX 做点什么')

  // 断言锚：DOM class / 计算样式 / 落盘文件；不读 agent 的自述文本
  await waitForLocator(e2e.page.locator('.dsh-leader-agent-project-section'), { description: '项目区块挂载' })
  await waitFor({ description: '会话日志写入回执', check: () => sessionLogsContain(e2e.instance.home, '回执') })

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
```

`launchE2E()` 返回 `{ page, context, instance, mock, problems, open(), stop() }`：

- `instance.home` 是这次运行的数据根（已种好的、要断言的落盘文件都读这里）
- `instance.url` 带本次启动的 token，别用端口或 token 拼
- `mock.requests` 是本轮模型请求，每条带 `kind`：`'scenario'`（场景驱动）与 `'title'`（宿主给会话起标题）
- `problems` 收集 pageerror 与 console.error；场景末尾断言它为空
- `stop()` 幂等，先关浏览器再停实例，任何一步失败都会报出来

### mock 约定

- **一个标记只表达一个场景**，写在用户输入里：`MOCK-BOARD 看一下看板`。一个请求里出现两个标记直接报错——否则失败会归因到错误的地方。
- 脚本是**按请求顺序消耗**的：`[{ tool: { name, input } }, { text: '收工' }]` 表示先调工具、看到结果再收尾。工具调用之后那一轮请求里没有标记，mock 沿用上一次命中的标记继续走。
- **没有标记不猜**：既没有标记也没有进行中的脚本时返回 400 并写明原因，不会默默回一段文本把断言引到错误结论上。
- 脚本比实际请求少一步时报错，不静默复用最后一步。
- 会话标题生成是宿主自己的附带调用，它带着用户原文、会误命中标记；mock 按 system prompt 把它归为 `kind: 'title'` 并回固定文案，不消耗场景脚本。
- **一轮只支持一个会话在请求模型**：脚本游标是一份全局的「最后命中的标记」，同一场景里两个会话（leader + worker）并行时，无标记的请求会续到别人那份脚本上。做派工场景前先按 session id 分游标（`mock-script.mjs` 的 `createScriptCursor`）。

### 断言纪律

- **断言外部世界**：DOM 的 class、`getComputedStyle` 的具体属性、磁盘上的 JSON。不读 agent 的自述文本，不拿页面里的推理文字当证据。
- **等状态，不睡时间**。`waitFor()` 轮询到条件成立；locator 用 `contenteditable="true"`、`data-*`、可见文本这类状态条件，让 playwright 自己等。
- **等待预算按正常耗时给**。实测单场景 3–8 秒、元素 1–2 秒到位：首次启动 20 秒、元素状态 15 秒。写 60 秒/90 秒只会让失败多等一整分钟，还把「机器慢」与「等错了元素」混成同一个症状。慢机与 2 核 CI 用 `E2E_BUDGET_SCALE=1.5` 整体放大（测试级上限走 `scenarioTimeout()`，取同一个倍率）。
- **失败要带读数**。元素等待走 `waitForLocator()`：失败时报 locator、目标元素读数（计数、`visible`、边界盒、`display` / `visibility` / `checkVisibility`、宽高）与页面读数（会话行、工作区行、插件元素计数）。目标读数用来分开「不在 DOM」「在 DOM 但 `display:none`」「在 DOM 但零尺寸」——只数 count 时这三种是同一句超时。读数自身限 2 秒：页面主线程卡死时退化成 `{ unavailable }`，不把失败拖到测试级超时。自定义读数用 `describePage()`。
- **造状态用 seed**：目标状态直接写进数据文件（`<home>/dsh-leader-agent/cards.json`、`projects.json`），让界面去读。靠反复重启、反复点 UI 去凑瞬时态，永远对不齐。
- **标识符必须来自本次运行**：端口、token、会话 id、数据根都从本次实例取，不硬编码上一轮残留的值。
- **双向验证**：撤掉修复 → 断言必须变红 → 还原 → 变绿。绿了但撤掉修复也绿，说明断言没守住任何东西。

### 截图取证

要针对某个界面状态留证据时，按这三步走，不要手工开浏览器去点：

1. 在 `tests/e2e/` 写一个场景（模板见上），把要证明的状态用断言固定下来；
2. `node --test tests/e2e/<场景>.e2e.js`（改过 `src/client/` 时先 `npm run build:client`）—— 场景结束时自动存 `final.png`，场景里的 `screenshot()` 另存关键节点；
3. 读 stdout 打印的 PNG 路径（用 Read 直接打开图片），把读数写进 PR 或 Agent Note。

```js
await e2e.screenshot('reply')   // 存 .dev/e2e-artifacts/<场景名>-<pid>/reply.png，路径打印在 stdout
```

- `launchE2E({ name: 'session' })` 决定目录前缀；不传时是 `scenario`。目录带本进程 pid：同机并发两次 e2e 时同名场景不互相覆盖。
- 每个场景 `stop()` 前会**自动存一张 `final.png`**（关闭浏览器前的最后一帧）：断言失败时这张图往往就是唯一能看的东西。
- 截图落在 `.dev/` 下，已被 gitignore：**不入库**，PR 里写读数（哪张图证明了什么），不贴图。
- 截图是给人看的证据，**不替代断言**：回归靠断言，截图只解释「当时界面上是什么样」。

### 失败诊断

1. **先看耗时**：单场景正常 3–8 秒（全量约 10 秒）。跑了一分钟还没结束，先怀疑某个等待在等不会出现的元素（典型：`lib/client.js` 没构建、会话行没渲染），不是机器慢。别用 `grep` / `head` 过滤输出，`TimeoutError` 里的 locator 就是线索。报错头是「等待失败：…」而不是「等待超时」时，先看页面或浏览器是不是已经关掉、崩了——那不是选择器的问题。测试级上限 90 秒（`scenarioTimeout()`，随 `E2E_BUDGET_SCALE` 放大）。清理链上实例与 mock 卡住会变成带名字的失败，浏览器关闭超时只告警并继续（`closeBrowser()` 10 秒上限），不会无声挂住。
2. 先看 `problems`（pageerror / console.error）。本仓出过「圆点不亮」查不出原因的情况，根因是三处空 `catch`：保留会话失败、订阅就绪失败，全都吞掉，界面上只剩一个空心圈。失败必须报告，且同一目标只报一次。
3. 看 `instance.logs`（子进程 stdout/stderr 全量）与 `mock.requests`：模型请求到底有没有发出来、打到哪个端点、带没带标记。
4. **区分「数据没到」与「渲染错了」**：落盘文件里有没有、DOM 里有没有，分开查；字段不在就是数据层的问题，不在渲染层。
5. **一次性日志优于每帧日志**：首次读数打一条就够，高频刷新会把控制台淹掉。
6. 起不来先看源 profile：`dsh` 不在 PATH、profile 缺 web app bundle、`node_modules` 没装，报错都会直接说明。

### 不覆盖

- 原生控件（目录选择器、系统文件对话框）在无头浏览器里拿不到结果，只能单测 + 人工取证，PR 里如实标注。
- 浮层的像素位置、动画观感不写进 e2e：它们不进回归，写进去只会周期性红。
- WebKit / Firefox 暂不跑（宿主只在个别场景用 WebKit）；需要时给 `instance.mjs` 加引擎参数，不要复制一套 harness。

## 宿主 dsh 的方案是怎么落过来的

宿主 `apps/web/tests/` 是一条成熟的浏览器车道，但**不能整搬**：它的 `scaffold.ts`（约 1800 行）在进程内 import 宿主 cordis 树与 `dsh-llm-replay`，而本仓禁止 import 宿主内部包、不 peer 依赖 dsh。搬过来的是机制与规则，实现全部黑盒化：

| 宿主 dsh | 本仓等价物 |
|---|---|
| vitest 跑道 + `playwright` 浏览器库 | `node:test` 跑道 + `playwright` core（本仓只有 node:test） |
| `launchWebScaffold()` 进程内启动真实组合 | 黑盒 spawn `dsh web --port 0 --no-open`，从 `dsh web: <url>` 行取带 token 的地址 |
| 禁用 llm 适配器 + `dsh-llm-replay` 回放 fixture | `DEEPSEEK_BASE_URL` 指向本地 Messages mock，按 `MOCK-*` 标记出脚本 |
| host 侧 `whenIdle()` 作为轮次完成屏障 | 浏览器侧按状态同步（DOM 稳定、落盘文件出现）——跨进程拿不到 whenIdle |
| ariaSnapshot golden + `DSH_SNAPSHOT=refresh` | 不做：本仓没有受评审的 UI 快照所有权，断言锚用 class / 计算样式 / 落盘 |
| DSH_HOME 隔离、端口 0、Linux PR 必需门禁 | 复用 `scripts/dev-instance.mjs` 派生数据根；端口 0；`npm run e2e` 独立，不进 `npm run check` |

### 从宿主搬来的确定性规则

这几条是宿主踩出来的，别在本仓重踩：

- **禁 `networkidle`**：SSE 长连接下它永远不解析。
- **禁单次瞬态 DOM 采样**：从流式输出到 React commit 的每一跳都可能合并 chunk，采样天然是竞态。
- **禁固定 sleep**：等 readiness 事件、状态翻转或落盘条件。
- **pageerror / console.error 即失败**：重连与历史重同步会把断掉的通路自愈掉，套件于是认证了坏 wire。唯一例外是宿主的 session 引用释放，`watchProblems()` 按文案放行。
- **端口用 `listen(0)`**：先扫空闲端口再绑定会与并发进程抢。
- **默认不开重试**：重试只会把竞态藏起来。
- **一次只改一个变量**：两个变量同时变，失败原因就分不开。

## 人工取证：没有可脚本化断言时

只有脚本化不了的部分才走这里，且必须在 PR 里写明测了什么、没测什么。

1. **先写断言**。能进单测的先写单测并看它变红，再改实现。
2. **起隔离实例**。`DSH_HOME` 指独立目录，端口独占，不与常用实例抢。token 每次启动都变，从启动日志用正则取出写入文件，**只打印长度**，不打印全文。
3. **场景用标记驱动**。标记写在用户输入里（`MOCK-<场景名>`），本地 mock provider 按标记返回固定的工具调用序列。一个标记只表达一个场景，标记名与用例名对得上。
4. **断言与双向验证**照[断言纪律](#断言纪律)：读外部世界，撤掉修复必须变红。
5. **清理**。kill 端口、删探针脚本、截图与临时数据不入库。

无头浏览器里弹不出的原生控件（目录选择器、系统文件对话框）只能单测 + 样式注入核验，PR 里写明「未 GUI 实测」，见[不覆盖](#不覆盖)。

### 搭场景：让目标会话出现在射击位

要点的按钮长在某个会话行上（归档、打开、续聊），而这行出现在左栏需要同时满足三个条件。少一条，界面上什么都不会出现，症状还都一样「等不到」。

1. **只有登记过的 worker 会话进项目树**。`groupSessionsByProject()` 按调用方传入的 `isWorkerSession` 判身份，其余会话一律跳过（`src/host/projects/session-index.js`）——手工 New Session 造的普通会话永远不在项目树下，别指望在它上面点项目内的动作。要在项目树下取证，先让 worker 派工出来（worker 是普通根会话，会话头不带 `origin` 标记，只能按登记判定）。
2. **派工只认项目 leader**。身份来自 `projects.json` 的 `leaderSessionId`，判定读的是进程内镜像（`src/host/projects/service.js` 的 `isLeaderSession()`，镜像由 `loadIndex()` 从注册表填充）。要换 leader：停机 → 改 `projects.json` → 重启，热改文件不会被读到。
3. **mock 用首条用户消息判角色**。`firstUserText()` 含 `MOCK-WORKER-TASK` 就把该会话当 worker 首轮，直接吐文本、永不派工。所以 leader 会话的第一条消息只能带场景标记（如 `MOCK-LONG-REPORT`），worker 标记由 mock 拼进派工 task 里。

路径形式不是坑：项目目录与会话 cwd 都过 `realpath`（`src/host/projects/service.js:23`），`/tmp/...` 与 `/private/tmp/...` 判成同一个目录，不要在这上面找原因。

会话 id 从 `$DSH_HOME/sessions/--<编码后的 cwd>--/<id>` 里按 mtime 取最新，不要硬编码。左栏刷新靠窗口 focus 或整页 reload；`sessionsByProject` 每次调用都现查宿主会话注册表，不缓存，所以 reload 后仍看不到，问题在上面三条里，不在刷新时机。

**一次只改一个变量**。上面三条里任意两条同时变动，失败原因就分不开——本轮踩过：换会话与改项目目录一起做，成功之后把功劳记在了目录上，而真实原因是新会话的首条消息不再带 worker 标记。改一样、验一次、再改下一样。

## 禁止

- 用脚本（`python3` 之类）改仓库代码做文本替换。临时回退用 `git stash` 或编辑器；探针脚本放 `/tmp`，验证完删掉。
- 为了取证在仓库代码里留 `[probe]` 前缀的临时日志。要么把它转成正式的失败报告，要么删掉。
- 真实调用付费 LLM API。e2e 与运行时验证一律用本地 mock provider。
- 把截图、临时数据文件当成提交内容。
- 把 e2e 塞进 `npm run check`：那条门禁只跑纯函数，不能依赖 `dsh` 与 chromium。
