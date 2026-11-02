# 开发实例从源 HOME 继承凭据 refs

**状态**：implemented（2026-11-02）
**范围**：`scripts/dev-plan.mjs`、`scripts/dev.mjs`、`tests/dev-plan.test.js`、`README.md`、`docs/architecture.md`

## 背景

每建一个新 worktree，第一次 `npm run dev` 都要在界面上重填一次 API key。

原因是隔离设计本身：开发实例的数据根落在工作树内的 `.dev/home`，而 `dsh-credentials-local` 把密钥存在 `<harness home>/.credentials.yaml` 里，于是新数据根的凭据文件只有 dsh 自己写的 `client-connection/browser-session` 授权，没有 `refs.DEEPSEEK_API_KEY`。日常实例那份在 `~/.dsh/.credentials.yaml`，不会被读到。

宿主的凭据解析顺序（`@deepseek-ai/dsh-credentials-local` README）是：存储文件 → 启动环境 → 项目 `.env` → `$DSH_HOME/.env`，`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`。所以 `DEEPSEEK_API_KEY=… npm run dev` 现在就能用——`scripts/dev.mjs` 把 `process.env` 原样传给子进程。但这条路把密钥物化进进程环境，agent 的 bash 工具子进程会继承它；dsh 自己刻意不这么做（存储文件「绝不物化进环境」）。

## 决策

**启动前把源 HOME 凭据文件的 `refs` 条目并进开发实例那一份**，用文本级复制，键已存在则跳过。

### 只搬 `refs`，不搬 `records`

`records` 里是账号授权（`deepseek-account-platform/default`），带刷新令牌。复制到两个实例等于同一份凭证被两处各自刷新，互相踢掉登录；共享 `path` 也一样。`refs` 只是按环境变量名存的密钥，复制无副作用。

### 文本级复制，不解析值

`credentialRefBlocks` 只认 dsh 生成的形态：顶层 `refs:`、条目缩进两格、续行更深。整块原样搬，多行值与引号都不重新转义——密值经一次 YAML 往返就可能变形。顶层注释不结束 `refs` 节，它可能是下一条目的注解。

### 目标里已有的条目不动

用户在这个实例里通过界面保存过就写进了同一份文件；那份值优先，否则源 key 一换就会悄悄盖掉实例里改过的配置。要重新跟随源，删掉目标文件里那一条即可。

### 文件权限收紧到 600

`dsh-credentials-local` 启动时拒绝加载其他用户可读的凭据文件。新建走 `writeFileSync` 的 mode，已存在的文件 mode 不生效，所以写完统一 `chmodSync`。

## 边界

- **源 HOME 没有凭据文件时静默跳过**：新机器还没配过 key 是正常场景，开发实例照常在界面上填。
- **不提供关闭开关**：需要「这个实例不带密钥」时删掉 `.dev/home/.credentials.yaml` 里的 `refs` 条目即可；多加一个环境变量只是把同一件事换个地方做。
- **不改凭据文件其余内容**：`records`、注释、排版原样保留；目标文件末尾没有换行时补一个再追加 `refs:`。
- **同 UID 可读**：agent 的工具进程仍能读到这份文件，这是 dsh 凭据存储本身的限制，不是本改动引入的。

## 验证

- `npm run check`：全绿，`dev-plan.test.js` 36 例（新增 8 例：取块与多行值、顶层注释、无目标文件、目标只有 records、目标有 refs 缺键、目标已有同名键、源无 refs、空文件与末尾无换行）。
- 双向验证：撤掉 `mergeCredentialRefs` 里的 `!target.has(key)` 过滤 → 「目标已有同名键时不动——实例里保存过的值优先」变红；还原后全绿。
- 真机：删掉主 checkout `.dev/home/.credentials.yaml` 的 `refs`（模拟新 worktree），`DEV_NO_OPEN=1 npm run dev`——横幅打印「凭据引用 ~/.dsh/.credentials.yaml -> .dev/home/.credentials.yaml（DEEPSEEK_API_KEY）」，实例正常监听并打印带 token 的 URL；页面模型选择器显示 DeepSeek-V4.1-Flash（凭据缺失时该路由会返回空目录、从选择器消失），即凭据被解析。运行后文件与备份逐行一致、权限 600。
