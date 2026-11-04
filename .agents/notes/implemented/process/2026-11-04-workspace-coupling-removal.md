# 清理工作区工具耦合

## 背景

本仓早期把发版手册放进外部编排工具的工作区 skill 目录，bot 凭据的默认路径也指向那个工具的数据根，门禁还因为那个目录开过特例。那个目录并不是本仓的一部分：它的名字、skill 加载方式与凭据位置都跟着外部工具走，本仓的仓库结构和发布链却要依赖它。结果是 clone 下来的人看不到手册，门禁也解释不了为什么有两个 skill 目录，而那个产品名散落在文档、源码注释与历史笔记里。

目标是把这些耦合清零：仓库内不再出现该工具的名字与路径，同时功能不变——发版手册仍有人读、bot 凭据仍能取 token、发布包内容逐项不变。

## 决策

### 手册迁到 docs/release.md

`git mv` 原手册到 [docs/release.md](../../../../docs/release.md)，删掉 frontmatter（`name` / `description` / `whenToUse` 只在 skill 语境有意义），H1 下加一行「维护者专用 / 不随包」。

落点选 `docs/` 而不是 `.agents/skills/`：后者被 `package.json` 的 `files` 白名单打进包，并由 `SKILLS_DIR` 暴露给每个用户会话；发版手册只服务本仓维护者，出现在用户 `node_modules` 与用户的 `skill` 工具列表里都没有意义。`docs/` 既不在白名单里，也不被 skill provider 加载，`pack-manifest` 的 `/^docs\//` 是第二道防线。

代价是外部工具会话不再自动加载这篇手册。维护者从 `AGENTS.md` 的按任务查阅表进 `docs/release.md`；正文没有 Markdown 链接，搬动不产生断链。`scripts/doc-budgets.json` 登记了这篇（实测 1390 units，天花板 1460，留约 5% 余量），漏登记会让 standing docs 门禁报 UNREG。

### 凭据目录改到 ~/.dsh-leader-agent/

`CREDENTIAL_DIR` 从外部工具的数据根改到 `~/.dsh-leader-agent`，与本仓 `~/.dsh` 的命名体系统一；`homedir()` 在 Windows 走 `USERPROFILE`，不引入 XDG 假设，也不必写进任何外部目录。`ENV_FILE` / `KEY_FILE` 由常量派生，不用改。

**不做旧路径兜底**：兜底常量会把旧目录字面量写回仓库，目标直接落空；也会让「文件还在别人家目录」这件事静默长期存在，违背 Fail Loud。迁移窗口用「先复制、后合并」消掉——复制没做就合并时脚本报缺少凭证文件并以 1 退出，不会降级成作者身份。本机是复制不是移动：那份 App 凭据被别的工具共用，移动会让另一条通道立刻断。

User-Agent 从 App 名改成 `dsh-leader-agent`（它只是 HTTP 头，不是身份），仓库与文档里不再点名该 App；App 本身不改。

### 门禁收窄与替代守卫

- `PROMPT_SKILLS_DIRS` 收窄为 `['.agents/skills']`：扫描面只认会进会话提示词的那一个 skill 目录。
- 新增 `MAINTAINER_DOCS = ['docs/release.md']`：手册不进提示词，但会指挥人照做，工具名写错一样要到运行时才炸；不显式扫，它的工具名就无人守。脚本的扫描集合由 `[...PROMPT_DOCS, ...MAINTAINER_DOCS]` 加 skill 目录拼成，用例断言 `PROMPT_SKILLS_DIRS` 恰为单元素、`MAINTAINER_DOCS` 含这篇、脚本复用同一份常量。
- `pack-manifest` 删掉逐条点目录黑名单（`.dev/`、`.worktrees/`、工作区目录、`.github/`），换成「顶层以 `.` 开头一律不进包，`.agents/skills/` 例外」。这不是删防线而是收紧：将来任何新增的本地状态目录都默认进不了包；`.dev/`、`.worktrees/`、`.github/` 的旧断言原样留在用例里，证明没有放松。`.DS_Store` 规则保留，处理嵌套位置。

## 边界

- **不改 git 历史**：旧提交里的路径仍在，验收以工作树为准。
- **包内容不变**：`files` 白名单本来就不含工作区目录与 `docs/`，`.agents/skills/` 原样；`build:client` 后 `npm pack` 的文件清单迁移前后逐项相同，`engines.dsh` 与运行时行为都不受影响（只有两处注释）。
- **本机只新增 `~/.dsh-leader-agent/`**：旧目录的其它数据（会话、skills、mcp 配置等）不清理；是否弃用外部工具是另一张卡的事。
- **仓库内零字面量**：验收口径是全仓 `git grep` 搜那个外部工具的名字零命中（排除 `.worktrees/`、`.dev/`、`node_modules`）。历史笔记里的探针路径改成「本机临时脚本」这类中性说法，读数不动——中性化措辞不等于改读数；新文件与新增用例名同样不带旧字面量。
- 通用点目录规则是行为变更：比逐条黑名单更严，白名单放宽时拦得住更多东西。

## 验证

- `npm run check` 全绿：85 篇笔记格式合规（相对基线 +1）、15 篇文档工具名全部存在（相对基线不变：`docs/release.md` 顶替原工作区 skill 一篇）、15 篇 standing docs 都在天花板内（新增 `docs/release.md` 1390/1460，余量 5%）、语法 100 个文件、1070 用例通过（17 skip）、覆盖率门禁通过。
- 四条双向验证：`PROMPT_SKILLS_DIRS` 临时改回旧目录 → 扫描面用例红（pass 8 / fail 2）；撤掉通用点前缀判定 → 点目录用例红（pass 10 / fail 2）；`docs/release.md` 从 `MAINTAINER_DOCS` 拿掉 → 对应用例红（pass 9 / fail 1）；删掉 `docs/release.md` 而保留笔记里的链接 → note 格式门禁 exit 1（链接目标不存在）。各自还原后全绿。
- `npm run build:client && npm run verify:pack`：包里 92 个文件，必需项齐全、无开发残留、装机 smoke 通过；`npm pack --dry-run --json` 的清单与迁移前（最新 `main`）逐项相同。
