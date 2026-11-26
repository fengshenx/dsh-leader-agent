# 浏览器侧证据：e2e 车道与人工取证

`npm run check` 只覆盖纯函数与落盘逻辑；圆点档位、折叠水位、交互后的落盘这类行为，只有把应用真跑起来才能证明。**样式（颜色、字号、圆角、动画、像素位置与尺寸、布局对齐）不进 e2e**：它们随宿主改版漂移，写进回归只会周期性红；唯一的例外是已修 bug 的**最小**几何守卫（项目行 vs 宿主工作区的行高/左缘、项目区块宽度），见[样式人工取证](#样式布局人工取证review-门禁)。能写成断言的行为一律走 **e2e 车道**（`npm run e2e`），其余走[人工取证](#人工取证没有可脚本化断言时)，并在 PR 里标注「未 GUI 实测」或写明测了什么。写场景的方法与纪律（断言、诊断、双向验证、搭场景）见 [e2e-scenarios 技能](../.agents/skills/e2e-scenarios/SKILL.md)；车道由来与确定性规则见[宿主方案笔记](../.agents/notes/implemented/testing/2026-11-04-e2e-host-approach-and-determinism.md)。

规则清单（细节见笔记）：只测逻辑，不测样式（已修 bug 的最小几何守卫除外）；禁 `networkidle`；禁单次瞬态 DOM 采样；禁固定 sleep；pageerror / console.error 即失败；端口用 `listen(0)`；默认不开重试；一次只改一个变量。

## 分层与判据

| 层 | 命令 | 证明什么 | 证明不了什么 |
|---|---|---|---|
| 纯函数与落盘 | `npm run check` | 投影、状态归一、去重、串行与并发 | 浏览器里实际渲染成什么 |
| 浏览器 e2e | `npm run e2e` | 真实宿主里的挂载、交互、wire、落盘与已修 bug 的最小几何守卫 | 样式与像素布局；未写成断言的行为 |
| 人工取证 | 本文末节 | 剩下那些只有人眼能判的东西 | 不可复现，不能当回归 |

能在纯函数层断言的先落 `tests/`；能在 e2e 层断言的不要再手工点。

## 车道

```sh
npm run e2e:install    # 首次：下载 chromium（约 150MB）
npm run e2e:one tests/e2e/board-card-delete.e2e.js   # 构建 + 只跑一个场景
npm run e2e            # 构建 + 全量 fail-fast（CI 语义）
npm run e2e:report     # 构建 + 全量、不中断、最后汇总
```

`e2e:one` 也接受场景名（`npm run e2e:one board-card-delete`）。三个入口都会先跑 `npm run build:client`：`lib/client.js` 不入库，没构建时插件在界面上什么都不显示，宿主却照常启动、不报错。**直接 `node --test` 不会构建**，新 checkout / worktree 里 `lib/` 为空，症状是每个等待都超时，不是启动失败。**构建了也可能坏**：改过 `src/client/` 里的 CSS，先跑 `plugin.e2e.js` 冒烟——症状与原因见[e2e-scenarios 的失败诊断](../.agents/skills/e2e-scenarios/SKILL.md#失败诊断)。

`npm run e2e -- <文件>` 现在按用法错误退出（exit 2）：runner 只接受 `--files` 后的场景列表，单跑用 `e2e:one`。**不加 `--test-force-exit`**：它把漏清理从「挂住/超时变红」变成「绿着通过 + 留下孤儿进程」，挂住应当暴露；已知三处已由有界清理收干净，取舍见[清理上限笔记](../.agents/notes/implemented/testing/2026-11-04-e2e-shutdown-bounded.md)。

### 单场景、全量与报告

| 入口 | 行为 | 用在哪 |
|---|---|---|
| `npm run e2e:one <场景>` | 只跑一个文件；退出码 0 通过 / 1 失败（含信号与起进程失败）；不清理 `.dev/e2e-artifacts/` | 定位、双向验证、看单场景截图 |
| `npm run e2e` | 按文件名顺序逐个跑；**第一个失败立刻停**；后续场景不再跑 | CI / 本地全量门禁 |
| `npm run e2e:report` | 按文件名顺序逐个跑；**每个都跑完**；最后打印 PASS/FAIL 汇总与失败文件；有失败退出 1 | 本地看全量景观、判断是不是多个场景同时坏，不用于 CI |
| `npm run e2e` / `e2e:report` + `-- --files <场景...>` | 只跑列出的场景，仍按 `--files` 顺序执行；`e2e` 仍 fail-fast，report 仍汇总 | 多 worker 拆分场景、快速验证（错峰执行） |

`--files` 是并发拆分与快速验证的入口，不是绕过全量的旁路：例如
`npm run e2e:report -- --files tests/e2e/plugin.e2e.js tests/e2e/session.e2e.js`。

`e2e` 保持 fail-fast：CI 上第一个红已经足够阻断合并，继续跑只会把失败时间拖长，并让后续场景在同一个坏环境上产生更多噪声。`e2e:report` 不是重试，也不隐藏失败：它只是把「一次失败就停」换成「跑完再算账」，最终退出码仍是 1；为什么不把所有入口都改成续跑，见 [Agent Note](../.agents/notes/implemented/testing/2026-11-20-e2e-runner-report-mode.md)。

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
  // 交互一律用 locator 等状态；断言锚是 DOM 结构/属性/可见性与落盘文件，不读计算样式与自述文本
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
2. `npm run e2e:one tests/e2e/<场景>.e2e.js`—— 会先构建；场景结束时自动存 `final.png`，场景里的 `e2e.screenshot('reply')` 另存关键节点到 `.dev/e2e-artifacts/<场景名>-<pid>/`，路径打印在 stdout；
3. 读 stdout 的 PNG 路径（用 Read 直接打开图片），把读数写进 PR 或 Agent Note。

- 目录前缀由 `launchE2E({ name: 'session' })` 决定（不传是 `scenario`），带本进程 pid，同机并发两次 e2e 时同名场景不互相覆盖；每个场景 `stop()` 前会**自动存一张 `final.png`**（关闭浏览器前的最后一帧），断言失败时它往往就是唯一能看的东西。
- 截图落在 `.dev/` 下，已被 gitignore：**不入库**，PR 里写读数（哪张图证明了什么），不贴图。截图是给人看的证据，**不替代断言**。

## 跑法与失败处理

### 负载卫生：并发车道与自动倍率

e2e 默认按整机负载自动放大等待：`resolveBudgetScale() = min(4, max(1, loadavg / ncpu))`。倍率每场景进程只解析一次，`scenarioTimeout()` 与所有等待共用；`E2E_BUDGET_SCALE` 仍优先。自动值首次使用时打印并固定，后段 load 上升不追加预算，超封顶仍红按失败处理。

**允许两条车道并发**：一条全量 + 一条 `--files` 子集（子集与全量重合也可以，实例隔离），或两条不相交的 `--files` 子集。不要并发跑 `npm run check`（它会抢 CPU 且有自己的超时），也不要让两条全量同时跑；并发时整机 load 上升，自动倍率会把「首屏确实慢」放过去；点击丢失这类问题不会因此变绿（交互本身有就绪/选中确认，见 `openProject`）。

开跑前仍看 `uptime`：自动倍率封顶 4，load 远超核数时先确认不是别的任务在抢机器；超过封顶仍红，按失败处理，不手动加单点秒数。

### 失败处理：先截图，再断言

1. 记下失败文件、退出码、`TimeoutError` 的 locator 与目标/页面读数；保留完整输出，别用 `grep` / `head` 过滤。
2. **先看截图**：`.dev/e2e-artifacts/<场景>-<pid>/final.png`（关闭前最后一帧）与场景自己的步骤图，确认界面到底停在哪。
3. 再看断言与 `problems`（pageerror / console.error）、`instance.logs`、`mock.requests`；按[技能的失败诊断](../.agents/skills/e2e-scenarios/SKILL.md#失败诊断)区分「数据没到」与「渲染错了」。
4. 空载下 `npm run e2e:one <场景>`。**单跑通过不等于修好**：必须把场景、症状、单跑结果和日期登记到下面的已知 flake 表，并追根因；没有根因就不能把「调大等待」当成修复。

### 已知 flake

| 场景 | 症状 / 触发 | 判定方法 | 是否已修 | 最后确认 |
|---|---|---|---|---|
| `guide-card` | 项目行只点一次，既没等 `data-dead` 也没等 `data-selected`；高 load 时引导卡不出现 | 失败读数看 `dead` / `selected`；`openProject` 等就绪并点到选中 | 是（openProject） | 2026-11-27 |
| `board-done-paging` | 项目行首次点击偶发丢失，下游等不到折叠开关；高 load 复现 | 空载单跑通过；失败读数 `data-selected=null` | 是（openProject） | 2026-11-27 |
| `board-cinema` | `openBoard` 的项目行只点一次，靠 500ms DOM 静默窗口；启动期侧栏刷新时点击丢失，随后等选中态超时 | 失败读数看 `dead` / `selected`；移除静默窗口，改 `openProject` 等就绪并点到选中 | 是（openProject） | 2026-11-27 |
| `avatar` | 用 `getByText('avatar')` 点文本而不是项目行，且没有就绪/选中确认；高 load 时回报气泡不出现 | 失败读数先看点击前后是否选中；改为绑定 `.project-row` 后 `openProject` | 是（openProject） | 2026-11-27 |
| `session-tabs`（多会话） | `instance.logs` 出现 `sessions.retain: unknown session`，切换/清理后常伴随等待失败 | 空载单跑通过且日志不再复现才算环境 flake；日志仍在则不是「已修」 | 否（#200，宿主生命周期，待确认） | 2026-11-20 |

`sessions.retain: unknown session` 仍可能命中上述场景；这是 #200 宿主问题，仍由 `watchProblems` 留红。

登记不等于放行：同一场景连续两次空载单跑都失败，按回归处理，不再引用本表。

### 超时口径

`waitFor()` / `waitForLocator()` 的默认 **15 秒是代码里的默认值，不是不可改的协议**：调用点可传 `timeoutMs`，首次启动的元素（输入框、项目行、工作区行）显式给 20 秒；测试级上限是 `scenarioTimeout()`（默认 90 秒，`session-tabs` 150 秒）。两者都乘自动倍率（load / 核数，封顶 4）；`E2E_BUDGET_SCALE` 显式覆盖自动值，适合固定预算与 2 核 CI。

**该调**：确认是慢机或 CI 核数不足，空载仍稳定慢；用倍率整体放大，读数写进 PR。**不该调**：单个 flaky 场景、元素没渲染、选择器等错、数据没到——这些加秒数只会把失败拖长并掩盖根因；不写 60/90 秒的单点预算，也不靠重试变绿。**交互竞态靠「等就绪 + 点到选中」，不靠加秒**：`openProject()` 先等 `data-dead` 为空，再点到 `data-selected`，失败读数带 `dead` / `selected` / `aria-current`。

### 不覆盖

- 原生控件（目录选择器、系统文件对话框）在无头浏览器里拿不到结果，只能单测 + 人工取证，PR 里如实标注。
- 颜色、字号、圆角、动画、像素位置与尺寸、布局对齐等样式不进 e2e：随宿主改版漂移，写进去只会周期性红；需要时人工取证。已修 bug 的最小几何守卫（相对行高/左缘、区块宽度）是例外，见下节。
- WebKit / Firefox 暂不跑（宿主只在个别场景用 WebKit）；需要时给 `instance.mjs` 加引擎参数，不要复制一套 harness。

## 人工取证：没有可脚本化断言时

只有脚本化不了的部分才走这里，PR 写明测了什么、没测什么。

1. **先写断言**：能进单测的先写单测并看它变红，再改实现。
2. **起隔离实例**：`DSH_HOME` 指独立目录、端口独占；token 每次启动都变，从启动日志取出写入文件，**只打印长度**。
3. **场景用标记驱动**：`MOCK-<场景名>` 写在用户输入里，本地 mock 按标记返回固定序列；一个标记只表达一个场景，标记名与用例名对得上。
4. **断言与双向验证**照 [e2e-scenarios 技能](../.agents/skills/e2e-scenarios/SKILL.md)：读外部世界，撤掉修复必须变红。
5. **清理**：kill 端口、删探针脚本；截图与临时数据不入库。

### 样式/布局人工取证（review 门禁）

样式不再有自动门禁，下面这份清单是 **review 门禁**，不是可选建议：

- **触发**：改动 `src/client/**` 的 CSS、布局或 DOM 结构影响视觉；改项目区块与宿主行/标签栏/看板/引导卡/头像的呈现；升级 `engines.dsh` 下限或宿主左栏结构。纯行为改动不触发。
- **owner**：作者在开 PR 前自测并把证据写进 PR；reviewer 审 PR 时按同一清单复核，缺证据就要求补，不用「本地看着正常」代替。
- **视口**：`1440×900` 为主；标签栏与右栏控件再看 `900` 与 `300` 宽（收缩、溢出、「更多」与右栏开关不重叠）。
- **检查面**：项目区块 vs 宿主工作区行的行高/行首左缘/标题左缘；标签栏与「更多」、右栏开关同排；引导卡/输入框左右边缘（640px 由 guide-card e2e 守）与圆角；项目行选中/入口高亮；目录浏览 300 宽不换行；头像 `reduced-motion` 静态退化。
- **证据格式**：每个面至少一张截图（按视口分组）+ 一行读数（元素名、`getBoundingClientRect()` 的宽/高/左缘，或两元素差值）写进 PR 正文或评论。截图放 `.dev/`、不入库；只有截图没有读数不算通过。
- **复核**：reviewer 对照截图与读数判断是否与改动前一致，并在 PR 里回复「已复核」或指出差异。e2e 保留的最小几何守卫若红，先按回归处理，不能用人工截图替代。

## 禁止

- 用脚本（`python3` 之类）改仓库代码做文本替换。临时回退用 `git stash` 或编辑器；探针脚本放 `/tmp`，验证完删掉。
- 为了取证在仓库代码里留 `[probe]` 前缀的临时日志。要么把它转成正式的失败报告，要么删掉。
- 真实调用付费 LLM API。e2e 与运行时验证一律用本地 mock provider。
- 把截图、临时数据文件当成提交内容。
- 把 e2e 塞进 `npm run check`：那条门禁只跑纯函数，不能依赖 `dsh` 与 chromium。
