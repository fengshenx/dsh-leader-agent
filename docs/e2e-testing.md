# 浏览器侧证据：e2e 车道与人工取证

`npm run check` 只覆盖纯函数与落盘逻辑；圆点档位、折叠水位、浮层位置这类东西，只有把应用真跑起来才能证明。能写成断言的行为一律走 **e2e 车道**（`npm run e2e`），只有脚本化不了的部分才走[人工取证](#人工取证没有可脚本化断言时)，且必须在 PR 里标注「未 GUI 实测」或写明测了什么。写场景的方法与纪律（断言、诊断、双向验证、搭场景）见 [e2e-scenarios 技能](../.agents/skills/e2e-scenarios/SKILL.md)；车道为什么长这样、7 条从宿主搬来的确定性规则，见[宿主方案笔记](../.agents/notes/implemented/testing/2026-11-04-e2e-host-approach-and-determinism.md)。

规则清单（细节与理由在笔记）：禁 `networkidle`；禁单次瞬态 DOM 采样；禁固定 sleep；pageerror / console.error 即失败；端口用 `listen(0)`；默认不开重试；一次只改一个变量。

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

`npm run e2e` 先跑 `npm run build:client`：`lib/client.js` 不入库，没构建时插件在界面上什么都不显示，宿主却照常启动、不报错。**单跑也要先构建**：`node --test` 不构建，新 checkout / worktree 里 `lib/` 为空，症状是每个等待都超时，不是启动失败。**构建了也可能坏**：改过 `src/client/` 里的 CSS，先跑 `plugin.e2e.js` 冒烟——症状与原因见[e2e-scenarios 的失败诊断](../.agents/skills/e2e-scenarios/SKILL.md#失败诊断)。

**`npm run e2e -- <文件>` 不会缩小要跑的集合**：npm 把 `--` 后面的参数追加到 script 末尾，实际执行的是 `node --test "tests/e2e/*.e2e.js" <文件>`，glob 照旧展开（实测 `tests 2`）；要单跑就绕过 npm script 直接调 `node --test`。**不加 `--test-force-exit`**：它把漏清理从「挂住/超时变红」变成「绿着通过 + 留下孤儿进程」，挂住应当暴露；已知三处已由有界清理收干净，取舍见[清理上限笔记](../.agents/notes/implemented/testing/2026-11-04-e2e-shutdown-bounded.md)。

前提：`dsh` 装好，且源 profile（默认 `~/.dsh/profiles/web`）里装过本插件——与 `npm run dev` 相同，缺任何一个都会当场报错并给出可照做的修法。Node 需要 22.15+（`session-logs.mjs` 的 zstd 与 `node --test` 的 glob），旧版本上是 import 期就崩。

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
  const e2e = await launchE2E({ scripts: { 'MOCK-XXX': [{ text: '回执' }] } }) // 键是标记名，值是依次要拿到的东西
  t.after(() => e2e.stop())
  await e2e.open()
  // 交互一律用 locator 等状态；断言锚是 DOM class / 计算样式 / 落盘文件，不读自述文本
  await e2e.page.locator('div[role="textbox"][contenteditable="true"]').first().fill('MOCK-XXX 做点什么')
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
- **没有标记不猜**：既没有标记也没有进行中的脚本时返回 400 并写明原因，不会默默回一段文本把断言引到错误结论上；脚本比实际请求少一步时同样报错，不静默复用最后一步。
- 会话标题生成是宿主自己的附带调用，它带着用户原文、会误命中标记；mock 按 system prompt 把它归为 `kind: 'title'` 并回固定文案，不消耗场景脚本。
- **一轮只支持一个会话在请求模型**：脚本游标是一份全局的「最后命中的标记」，同一场景里两个会话（leader + worker）并行时，无标记的请求会续到别人那份脚本上。做派工场景前先按 session id 分游标（`mock-script.mjs` 的 `createScriptCursor`）。

### 截图取证

要针对某个界面状态留证据时，按三步走，不要手工开浏览器去点：

1. 在 `tests/e2e/` 写一个场景（模板见上），把要证明的状态用断言固定下来；
2. `node --test tests/e2e/<场景>.e2e.js`（改过 `src/client/` 时先 `npm run build:client`）—— 场景结束时自动存 `final.png`，场景里的 `e2e.screenshot('reply')` 另存关键节点到 `.dev/e2e-artifacts/<场景名>-<pid>/`，路径打印在 stdout；
3. 读 stdout 的 PNG 路径（用 Read 直接打开图片），把读数写进 PR 或 Agent Note。

- 目录前缀由 `launchE2E({ name: 'session' })` 决定（不传是 `scenario`），带本进程 pid，同机并发两次 e2e 时同名场景不互相覆盖；每个场景 `stop()` 前会**自动存一张 `final.png`**（关闭浏览器前的最后一帧），断言失败时它往往就是唯一能看的东西。
- 截图落在 `.dev/` 下，已被 gitignore：**不入库**，PR 里写读数（哪张图证明了什么），不贴图。截图是给人看的证据，**不替代断言**。

### 失败诊断

先看耗时：单场景正常 3–8 秒（全量约 10 秒），跑一分钟还没结束，先怀疑某个等待在等不会出现的元素（典型是 `lib/client.js` 没构建、会话行没渲染），不是机器慢。其余按[技能的失败诊断一节](../.agents/skills/e2e-scenarios/SKILL.md#失败诊断)：先看 `problems`（pageerror / console.error），再看 `instance.logs` 与 `mock.requests`，区分「数据没到」与「渲染错了」；一次性日志优于每帧日志。测试级上限 90 秒（`scenarioTimeout()`），清理链上实例与 mock 卡住会变成带名字的失败。

### 不覆盖

- 原生控件（目录选择器、系统文件对话框）在无头浏览器里拿不到结果，只能单测 + 人工取证，PR 里如实标注。
- 浮层的像素位置、动画观感不写进 e2e：它们不进回归，写进去只会周期性红。
- WebKit / Firefox 暂不跑（宿主只在个别场景用 WebKit）；需要时给 `instance.mjs` 加引擎参数，不要复制一套 harness。

## 人工取证：没有可脚本化断言时

只有脚本化不了的部分才走这里，且必须在 PR 里写明测了什么、没测什么。

1. **先写断言**：能进单测的先写单测并看它变红，再改实现。
2. **起隔离实例**：`DSH_HOME` 指独立目录、端口独占；token 每次启动都变，从启动日志取出写入文件，**只打印长度**。
3. **场景用标记驱动**：`MOCK-<场景名>` 写在用户输入里，本地 mock 按标记返回固定序列；一个标记只表达一个场景，标记名与用例名对得上。
4. **断言与双向验证**照 [e2e-scenarios 技能](../.agents/skills/e2e-scenarios/SKILL.md)：读外部世界，撤掉修复必须变红。
5. **清理**：kill 端口、删探针脚本；截图与临时数据不入库。

无头浏览器里弹不出的原生控件（目录选择器、系统文件对话框）只能单测 + 样式注入核验，PR 里写明「未 GUI 实测」，见[不覆盖](#不覆盖)。

## 禁止

- 用脚本（`python3` 之类）改仓库代码做文本替换。临时回退用 `git stash` 或编辑器；探针脚本放 `/tmp`，验证完删掉。
- 为了取证在仓库代码里留 `[probe]` 前缀的临时日志。要么把它转成正式的失败报告，要么删掉。
- 真实调用付费 LLM API。e2e 与运行时验证一律用本地 mock provider。
- 把截图、临时数据文件当成提交内容。
- 把 e2e 塞进 `npm run check`：那条门禁只跑纯函数，不能依赖 `dsh` 与 chromium。
