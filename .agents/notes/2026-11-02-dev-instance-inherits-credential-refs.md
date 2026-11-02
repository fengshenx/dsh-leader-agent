# 开发实例从源 HOME 继承凭据 refs

**状态**：implemented（2026-11-02）
**范围**：`scripts/dev-plan.mjs`、`scripts/dev.mjs`、`scripts/atomic-write.mjs`、`tests/dev-plan.test.js`、`tests/atomic-write.test.js`、`README.md`、`docs/architecture.md`

## 背景

每建一个新 worktree，第一次 `npm run dev` 都要在界面上重填一次 API key。

原因是隔离设计本身：开发实例的数据根落在工作树内的 `.dev/home`，而 `dsh-credentials-local` 把密钥存在 `<harness home>/.credentials.yaml` 里，于是新数据根的凭据文件只有 dsh 自己写的 `client-connection/browser-session` 授权，没有 `refs.DEEPSEEK_API_KEY`。日常实例那份在 `~/.dsh/.credentials.yaml`，不会被读到。

宿主的凭据解析顺序（`@deepseek-ai/dsh-credentials-local` README）是：存储文件 → 启动环境 → 项目 `.env` → `$DSH_HOME/.env`，`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`。所以 `DEEPSEEK_API_KEY=… npm run dev` 现在就能用——`scripts/dev.mjs` 把 `process.env` 原样传给子进程。但这条路把密钥物化进进程环境，agent 的 bash 工具子进程会继承它；dsh 自己刻意不这么做（存储文件「绝不物化进环境」）。

## 决策

**启动前把源 HOME 凭据文件的 `refs` 条目并进开发实例那一份**，用文本级复制，键已存在则跳过。

### 只搬 `refs`，不搬 `records`

`records` 里是账号授权（`deepseek-account-platform/default`），带刷新令牌。复制到两个实例等于同一份凭证被两处各自刷新，互相踢掉登录；共享 `path` 也一样。`refs` 只是按环境变量名存的密钥，复制无副作用。实现只读 `refs` 节内的行，`records` 永远不会进入搬运集合。

### 识别 `refs` 节形态并替换，绝不追加第二个 `refs:`

宿主的写入器产出块式（缩进两格），但删掉最后一个引用后 `Document.toString()` 落成 `refs: {}`；用户也可能手改成任意合法缩进。所以：

- 块式节按「该节第一个条目的缩进」识别条目，任意合法缩进都接受，续行更深、整体搬到目标的缩进；
- 行内映射（`refs: {}` / `refs: { A: b }`）展开成块式，原有条目原样保留；
- 写回时**替换**既有节（块式插在最后一个条目之后，行内替换该行），不追加第二个顶层 `refs:`；
- 认不出（重复顶层 `refs`、节内非条目行、缩进回退、不成对的行内映射）就抛错，**不猜拼接位置**。

只认这两种形态的代价是：不在这个子集里的合法 YAML（flow 里嵌套映射、锚点）会拒绝合并，但绝不会写坏文件。整块原样搬，多行值与引号不重新转义——密值经一次 YAML 往返就可能变形。

### 目标里已有的条目不动

用户在这个实例里通过界面保存过就写进了同一份文件；那份值优先，否则源 key 一换就会悄悄盖掉实例里改过的配置。要重新跟随源，删掉目标文件里那一条即可。

### 原子替换 + 与宿主同一把写者锁

`dsh-credentials-local` 启动时拒绝加载其他用户可读的凭据文件，且它的写走 `withFileLock` + `writeFileAtomic`。本仓不能 import 宿主的内部包（`@deepseek-ai/dsh-atomic-write`），所以在 `scripts/atomic-write.mjs` 照同一协议实现需要的那部分：

- 临时文件以 `wx` 独占创建、创建即带 600，再 `rename` 覆盖：替换后的权限是 600，没有「先落盘 644 再 chmod」的可读窗口，也没有半截文件；
- 写者锁是同目录的 `<文件名>.lock`、内容为持有者 PID，与宿主的锁路径和协议一致，所以正在运行的实例不会被 `npm run dev` 的读-改-写覆盖；
- 持有者已退出（`ESRCH`）时接管遗留锁；与宿主的差别只是没有 claim 文件串行化接管，极端并发下最多多一次重试。

### 非 version 1 的目标文档不动

目标没有 `version` 且非空时，它是 pre-release 扁平布局：宿主 `loadInitial` 会先把它迁移成 version 1 + `refs:`。此时追加 `refs:` 会让文档既不是扁平的、也没有 version，凭据插件激活失败。所以这类文档与声明其他 version 的文档都只打印原因、不写入。

## 边界

- **源 HOME 没有凭据文件时静默跳过**：新机器还没配过 key 是正常场景，开发实例照常在界面上填。
- **合并失败阻断启动**：形态认不出、重复 `refs:`、锁超时、写入失败都打印原因并 `exit 1`。静默继续会让人以为 key 已带过来，实际一进界面就缺凭据；这些形态宿主自己也会拒绝或需要人修，早失败早定位。
- **不改凭据文件其余内容**：`records`、注释、排版原样保留；行内映射会被展开成块式（宿主读的是同一语义）。目标文件末尾没有换行时补一个。
- **不提供关闭开关**：需要「这个实例不带密钥」时删掉 `.dev/home/.credentials.yaml` 里的 `refs` 条目即可；多加一个环境变量只是把同一件事换个地方做。
- **同 UID 可读**：agent 的工具进程仍能读到这份文件，这是 dsh 凭据存储本身的限制，不是本改动引入的。

## 验证

- `npm run check`：全绿，671 例；`dev-plan.test.js` 52 例（本卡片新增 16 例）、`atomic-write.test.js` 7 例。
- 双向验证：把 `scripts/dev-plan.mjs` 回退到 88b6657 的 refs 实现 → 12 例红（`refs: {}`、4 空格、行内映射两向、扁平布局、version 2、重复 refs、认不出的条目、多行值重缩进、引号键、CRLF）；还原后 52 例全绿。
- 并发探针：两个进程对同一份 `refs: {}` 目标各写一个键、故意放大读-改-写窗口——共用写者锁时 5/5 轮都保留两个键，去掉锁对照 3/3 轮丢一个键；两次运行都无 `.tmp` / `.lock` 残留。
- 解析器探针（宿主同款 `yaml@2.9.0`，`parseDocument(text, { uniqueKeys: true, prettyErrors: true })`）：旧逻辑产出的追加形态报 `DUPLICATE_KEY@4`，4 空格混排报 `BAD_INDENT@4`；新实现四种真实形态（`refs: {}`、4 空格、空节、行内非空）全部无错，且 `^refs:` 只有一处。
- 端到端（假源 HOME + `DEV_DSH` 指向替身，不启动真实实例）：目标 `refs: {}` 合并成块式、`records` 原样、权限 600、无 `.lock` 与 `.tmp` 残留；二次运行无变更、幂等；扁平布局目标不被改动并打印原因。
- gitignore 实测：`git check-ignore -v .dev/home/.credentials.yaml` 命中 `.gitignore:12:.dev/`，worktree 共享同一份 `.gitignore`。
- 真机（首版验证仍成立）：删掉 `.dev/home/.credentials.yaml` 的 `refs` 后 `DEV_NO_OPEN=1 npm run dev`，横幅打印键名、实例正常监听、模型选择器显示 DeepSeek-V4.1-Flash；运行后文件与备份逐行一致、权限 600。
