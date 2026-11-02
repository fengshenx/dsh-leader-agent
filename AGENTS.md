# AGENTS.md

dsh-leader-kit —— dsh（DeepSeek Harness）的**仓外插件 bundle**：协调者/worker 编排、项目树、交付看板。宿主是独立仓库，本仓只消费它的公开插件契约。本文件只列每个任务都适用的规则；细节按[按任务查阅](#按任务查阅)进归属文档。

**核心铁律：**

- 注释、文档、日志用中文，保留专业术语；Agent Note **文件名用英文**（`YYYY-MM-DD-<english-title>.md`），正文中文
- **宿主 API 按 `engines.dsh` 下限挑**（现在是 `>=0.2.1-rc.2`），不按本机最新版。只在更新版本才有的方法会在下限版本上抛 `TypeError`，而这类调用多半落在 `agent/created` 上——等于每个会话创建都失败。不确定某 API 何时引入就查宿主仓库的 tag
- **不改宿主仓库、不 import 宿主内部包、不 peer 依赖 dsh 包**：宿主产物与版本会漂移，带内部依赖的 bundle 会周期性失效（理由见 `src/host/message.js` 头注释）
- **worker 是本 bundle 用 `ctx.agents.create` 建的常驻根会话**，不走宿主 subagent 机制；宿主的 `list_agents` / `send_message` / `interrupt_agent` 对它们无效（`interrupt_agent` 还会返回假成功回执）
- **禁止直接修改主 checkout**：改动落在 `.worktrees/<任务名>`，主 checkout 保持干净
- **改 `src/client/` 必须重建再验证**：`lib/client.js` 不入库，宿主下发的是构建产物
- 不引 React / jsdom 等宿主平台依赖：client 侧用 `React.createElement`（无 JSX），hooks 与 React 实例都来自宿主的模块表
- 严禁真实调用付费 LLM API；真机验证用 mock/keyless provider

## 按任务查阅

| 任务 | 先读 |
|---|---|
| 理解整体架构、查模块归属与完整限制 | [docs/architecture.md](docs/architecture.md)（分层、运行时模型、数据流、持久化布局、已知限制） |
| 改 host 侧、加工具、动 `agent/created` | [docs/capability-gaps.md](docs/capability-gaps.md)（宿主能力边界，每条都有实测依据） |
| 加改 client 半边、看板与项目面板 | [2026-10-23-client-side-findings-and-build-constraints.md](.agents/notes/2026-10-23-client-side-findings-and-build-constraints.md) |
| 起开发实例、多 worktree 并行 | [中文 README 的开发一节](README_ZH.md#开发)、`scripts/dev.mjs` |
| worker 生命周期、派工与结算 | [2026-10-29-worker-as-root-session.md](.agents/notes/2026-10-29-worker-as-root-session.md)、[2026-10-23-dispatch-and-wakeup.md](.agents/notes/2026-10-23-dispatch-and-wakeup.md) |
| 卡片、槽位与项目绑定 | [2026-10-23-card-storage-and-numbering-scope.md](.agents/notes/2026-10-23-card-storage-and-numbering-scope.md)、[2026-10-27-project-bound-board.md](.agents/notes/2026-10-27-project-bound-board.md) |
| 项目级提示词（`COORDINATOR.md` / `SLOTS.md`） | [2026-10-29-coordinator-manual-injection.md](.agents/notes/2026-10-29-coordinator-manual-injection.md)、`src/host/coordinator-context.js`、`src/host/slots/` |
| 真机 / GUI 取证 | [docs/e2e-testing.md](docs/e2e-testing.md) |
| 审查 PR、以 bot 身份发评论 | [用 bot 身份发评论](#用-bot-身份发评论)、`scripts/github-app-token.mjs` |
| 协议层文案（`skills/`） | 现有 `skills/leader-mode/` 的行文与结构，保持同一口吻 |

## 目录与职责

```
index.js            包入口：导出 name / inject / apply（实现都在 src/host）
src/host/           宿主侧：工具、派工器、存储、项目服务、worker 会话生命周期
src/client/         浏览器侧：项目树、看板、会话行（React.createElement，无 JSX）
src/shared/         两端共用的纯函数与消息来源约定
skills/             leader-mode 协议层（SKILL.md + playbooks + references）
tests/              node:test 单测（纯函数与假件，不引 jsdom）
build/client.mjs    esbuild 客户端构建（closure-factory 封装）
scripts/            开发实例、worktree 工具、门禁（Agent Note 格式、文档工具名）
docs/               长期文档（架构、宿主能力边界、真机取证指引）
.agents/notes/      非平凡改动的决策记忆
COORDINATOR.md      本仓作为项目时，协调者会话自动注入的手册
SLOTS.md            本仓作为项目时，执行者角色槽位（discuss / dev / review）
```

## 常用命令

```bash
npm run check                     # Agent Note 格式门禁 + 文档工具名门禁 + 语法检查（index/src/scripts/build）+ 全部单测
npm run test                      # 只跑单测
npm run build:client              # 重建客户端产物 lib/client.js
npm run dev                       # 起一个挂当前工作树插件版本的 dsh 实例
npm start                         # 起日常实例（~/.dsh 的数据与 profile，先校验 dsh、profile 与产物）
npm run worktree:spawn <任务名>    # 建 .worktrees/<任务名> + feature/<任务名>
npm run worktree:prune            # 清已合并的 worktree（默认只打印，--apply 才删）
```

## 测试

- 只有 `node:test`，**没有 lint**：未使用的 import、死代码、拼写错误都抓不到，改完要手扫。
- 可判定逻辑抽成纯函数模块再测（`*-logic.js`、`dev-plan.mjs` 这类）；IO 与 React 组件不硬测，判据在宿主 UI 里的行为用真机取证。
- **假件照宿主的真实 API 面构造**：夹具多给一个宿主方法，就会掩盖「下限版本没有它」这类缺口——`tests/tool-gate.test.js` 的 `makeAgent` 是范例，它只给 rc.2 就有的 `restrict` / `get` / `schemas`。
- **修 bug 做双向验证**：精确撤销修复 → 对应用例变红 → 还原 → 全绿。没变红先怀疑用例（断言是否落在真实可观测量上），别先怀疑实现。
- 重大修复固化永久回归用例，并在同 PR 的 Agent Note 写明原因。
- 工具名只有一处来源：`src/host/index.js` 的 `createBundleTools`（门禁比对用的是它的 `documentedToolNames`）。`SLOTS.md`、`COORDINATOR.md`、`skills/**/*.md` 里反引号写的工具名由 `scripts/verify-doc-tool-names.mjs` 比对，删工具时漏改文档 `npm run check` 会红。

## 代码风格

- 纯 JS（ESM），不做 TypeScript 编译；导出函数写 JSDoc 的参数与返回。
- 注释只在 WHY 不明显时写；不解释代码做了什么，不复述控制流。
- Fail Loud：配置错误与未知异常大声报错，不静默吞错；必须吞的地方在单行注释里写明原因。
- `try` 只包可能抛出的那一句。
- 未使用的代码直接删。本仓未发布，不保留兼容垫片与旧格式迁移；**例外**是已落盘的运行时用户数据可以做读取退回（如 `name ?? label`）。
- client 侧的 CSS 写在 JS 模板字符串里时**不能出现反引号**——会截断模板。
- 用户可见文案走 `locale/*.json`，不硬编码在组件里。

## 宿主契约要点

- `tools.restrict({ deny })` 对**未注册的全局工具名直接抛错**，deny 之前先探存在性。
- 工具面按会话角色裁剪，在 `agent/created` 上应用——那个事件在**建会话内部**就发出来了，所以按身份分配工具面的会话必须让身份先于会话存在（第 37 条）。
- 建会话的实现接受调用方传入的 `sessionId`（`sessionController.create({ sessionId })` 与 `agents.create({ sessionId })`），预生成 id 是唯一不需要事后纠正的手段。
- 仓外插件不能新增 session event 类型（capability-gaps 第 8 条），卡片与项目状态只能走独立存储域 + session projection。
- client 产物不能用 `node:` 内置模块（第 23 条）。
- `ctx.sessions.list()` 只返回 live session，从会话推导的列表会随重启漂移（第 21 条）。
- profile 名要落在 `PROFILE_TEMPLATES`（`web` / `acp` / `headless` / `sdk` / `sdk-minimal`）里：自定义名会被 `dsh plugin` 按只含 `@deepseek-ai/dsh-base` 的默认模板建出来，缺 web-app bundle，插件客户端半边不加载。文档与脚本一律用 `web`。
- **agent-team（experimental）并存时 worker 会被当成隐式 Lead**：团队工具注册在 Agent scope，`restrict({ deny })` 只认全局名、挡不住，本 bundle 只做告警与运行时上下文禁令（`src/host/team-guard.js`）。机制与取舍见 [architecture 的 agent-team 并存时](docs/architecture.md#agent-team-并存时)。

## 提交与 PR

- 非平凡改动同 PR 携带 `.agents/notes/` 笔记：只记永久决策与边界，不写流水账。正文按
  `## 背景` / `## 决策` / `## 边界` / `## 验证` 分节（同现有笔记）：决策拆得开时用 `###`，
  验证写用例与双向验证读数。结构由 `npm run check` 里的 `scripts/verify-agent-note-format.mjs`
  机械校验（文件名、唯一 H1、首节与决策节、节名不重复），判定逻辑在 `scripts/agent-note-format.mjs`。
- 先 `npm run check` 再 `git add`。
- PR 附证据：单测数与新增用例、双向验证结果、真机读数；截图等临时证据不入库。
- 行为变更同步 README 与相关 `docs/`。
- 交付做到 PR 为止；合并与 approve 需用户明确指令。
- **收尾才清 worktree**：`worktree:prune` 只在 PR 合并后跑，且先确认工作区干净。未合并的分支即使 PR 关掉也不删——那是没进 `main` 的代码。

## 用 bot 身份发评论

审查意见走 GitHub App `telov-review-bot`，评论显示为 `telov-review-bot[bot]`，与作者账号（`fengshenx`）分离。merge、push 用本人凭证，bot 不做；approve 需用户明确指令。

**这套通道依赖本机私有凭据**：`scripts/github-app-token.mjs` 读 `~/.telov/`，仓库本身不带这个能力。换机器、别人 clone、或将来接 CI 都要自备 App 与 installation——没有凭据时脚本按 Fail Loud 报缺文件并以 1 退出，不会静默降级成作者身份。

- 凭据在机器本地、不入库：`~/.telov/github-app.env`（`GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID`）、`~/.telov/github-app.pem`（`chmod 600`）。该 App 的 installation 覆盖 `fengshenx` 名下全部仓库，同一份凭据 Telov 与本仓通用。
- 换 token：`node scripts/github-app-token.mjs`（RS256 JWT → installation token，1 小时有效，不落盘）。它是**纯入口**，逻辑在 `github-app-credentials.mjs`（凭据读取与 token 交换）与 `github-app-jwt.mjs`（签名）。**别给入口加「是不是被直接执行」的守卫**：`import.meta.url` 会解析软链而 `pathToFileURL(argv[1])` 不会，路径经过软链时守卫判错、脚本退 0 且 stdout 为空，`$(…)` 一侧不短路，`gh` 随后回落到本人凭证——正是要防的身份降级。
- **取 token 与调用必须写在同一行**：`TOKEN=$(node scripts/github-app-token.mjs) && GH_TOKEN="$TOKEN" gh pr comment <n> --body-file /tmp/review.md`。分两次 shell 调用时 `$TOKEN` 已丢失，`gh` 回落到本人凭证——评论照样发出，身份却静默变成作者账号；`&&` 短路是第二道防线，取不到 token 就不执行 `gh`。
- 正文含中文、换行、代码块时先写临时文件再 `--body-file`，避开 shell 引号转义；临时文件用完删掉。
- **别用 `gh api user` 验身份**：installation token 访问该端点一律 403（`Resource not accessible by integration`），那是预期形态不是故障——身份由 App slug 决定（`GET /app` 的 `slug` 是 `telov-review-bot`），用它签出的 token 发评必然显示为 `[bot]`。要确认可用性就查 `gh api /installation/repositories` 里有没有目标仓库。
- App 权限只有 `issues` / `pull_requests` / `metadata`：能发评论，不能 merge、不能 push；也**不要**把 token `export` 成全局 `GH_TOKEN`，那会让后续所有 `gh` 操作变成 bot 身份。

## 编辑本文件

- 每条规则自包含，或一行断言加链接指向归属文档；背景与理由链到归属，不就地展开。
- 别处已有的规则不复制：在归属处改，此处只放链接（宿主限制归 `docs/capability-gaps.md`，构建约束归对应 Agent Note）。
- 清晰度不损时优先压缩。
