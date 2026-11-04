# 包名改为 dsh-leader-agent

**日期**：2026-11-04
**范围**：全仓标识（包名、CSS 前缀、skill 名、插件行 id、GitHub 仓库名），含 `.agents/notes/` 中对当前实现的引用

## 背景

`dsh-leader-kit` 的 `kit` 与产品形态不符：本 bundle 交付的是 leader agent 的编排能力——派工协议、项目树、交付看板，以及围绕它的常驻 worker 会话，不是一组可拆用的工具箱。`agent` 与仓库里既有的 `leader-mode`、`leader-context`、`LEADER.md` 同一套词。

选名时查了 npm registry（2026-11-04）：`dsh-leader-agent` 返回 404（未占用）；`dsh-leader` 同样空着，但更泛，容易被后续同名包撞上。包未对外发布给真实用户，不做旧名兼容，也不做数据迁移。

## 决策

- 包名与全部派生前缀：`dsh-leader-kit` → `dsh-leader-agent`，连带 CSS 类名、`STYLE_ID`、`@module`、日志前缀、worker 消息 kind、运行时数据目录、测试临时目录前缀
- skill `init-leader-kit` → `init-leader-agent`（目录、frontmatter、协议文本与文档引用）
- `cordis.patch.yml` 插件行 id `leader-kit-host` → `leader-agent-host`
- `scripts/dev-plan.mjs` 常量 `LEADER_KIT_PACKAGE` → `LEADER_AGENT_PACKAGE`，`assertLeaderKitBundle` → `assertLeaderAgentBundle`
- e2e 页面读数键 `leaderKit` → `leaderAgent`
- GitHub 仓库 `fengshenx/dsh-leader-kit` → `fengshenx/dsh-leader-agent`，`package.json` 的 `repository` / `homepage` / `bugs`、README 徽章与图片链接同步
- 日志位图（`docs/assets/readme/logo-*.svg`）文字改新名，画布宽度 470 → 510 容纳加长的两字符
- locale 展示名 `Leader Kit` → `Leader Agent`、`队长工具包` → `队长 Agent`

### 不迁移运行时数据

新数据目录是 `$DSH_HOME/dsh-leader-agent/`。旧 `$DSH_HOME/dsh-leader-kit/` 下的项目、卡片、worker 登记与通知队列不读取、不搬移：包没有外部用户，旧目录只可能是本机开发实例的数据。这与 2026-11-02 那次改名的口径一致（见 [2026-11-02-rename-to-leader-kit.md](2026-11-02-rename-to-leader-kit.md)）。

## 边界

- **历史事实保留旧名**：`.agents/notes/` 里的 npm 发布日志（`dsh-leader-kit@0.1.0` / `@0.1.1`）、npmjs.com 的 Trusted Publisher 登记、awesome-dsh-plugin 的投稿文件名、当时的报错原文与旧数据根路径，都是验证读数或外部既有记录，不随改名改写。指向当前代码、类名、数据布局的引用则全部同步。
- **README 截图仍显示旧名**：`board.png` 与 `desktop-add-plugin.png` 是真实界面截图，图内的项目名与插件输入框仍是 `dsh-leader-kit`。重拍需要挂新包名的实例并走一遍插件安装向导，不在本次自动化验证范围内；换图前 README 的图注与文字说明以新名为准。
- **旧包不 deprecate**：`dsh-leader-kit@0.2.1` 已发布在 npm，本次不改动该包元数据。是否发 `npm deprecate` 指向新包，留到下次发版决定。

## 验证

- `npm run check`：全绿（Agent Note 格式 80 篇、文档工具名 14 篇、13 篇文档预算、语法 100 文件、1063 用例通过 / 17 跳过）
- `npm run build:client`：产物 `lib/client.js` 含 `dsh-leader-agent` 465 处，`dsh-leader-kit` / `leaderKit` 0 处
- `npm run e2e`：真实宿主 + 本地 mock + chromium，6 条场景全绿（断言里的 CSS 类名与读数键已同步新名）
- `npm run verify:pack`：91 个文件、必需项齐全、无开发残留，装机 smoke 通过
