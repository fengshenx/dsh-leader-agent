# 包名改为 dsh-leader-agent

## 背景

`dsh-leader-kit` 的 `kit` 与产品形态不符：本 bundle 交付的是 leader agent 的编排能力——派工协议、项目树、交付看板，以及围绕它的常驻 worker 会话，不是可拆用的工具箱。`agent` 与仓库里既有的 `leader-mode`、`leader-context`、`LEADER.md` 同一套词。选名时已排除生态里被占用的词（crew / fleet / orchestrator / lead-mode），`leader` 的差异是**人在场**：leader 就是用户正在对话的会话，worker 是本 bundle 用 `ctx.agents.create` 建的常驻根会话，不依赖官方 Agent Teams，也不从 IM / GitHub 主动接活。

## 决策

- **包名与全部派生前缀改为 `dsh-leader-agent`**：包名、CSS 类名、样式常量、`@module`、日志前缀、worker 消息 kind、运行时数据目录、测试临时目录前缀一并改名。
- **连带改名**：skill `init-leader-kit` → `init-leader-agent`（目录、frontmatter、协议文本与引用）、`cordis.patch.yml` 的插件行 id、`dev-plan.mjs` 的包名常量与 bundle 断言函数、e2e 页面读数键、GitHub 仓库与 `repository` / `homepage` / `bugs` / README 徽章与图片链接、logo 文字与画布宽度、locale 展示名。
- **新名字先确认可用**：`dsh-leader-agent` 在 npm registry 未被占用；更泛的 `dsh-leader` 空着但容易被后续同名包撞上，不选。
- **不迁移运行时数据**：新数据目录是 `$DSH_HOME/dsh-leader-agent/`，旧目录下的项目、卡片、worker 登记与通知队列不读取、不搬移。包没有外部用户，因此不做旧名兼容；旧目录只可能是本机开发实例的数据，与上一次改名的口径一致（改一次名不迁移一次数据）。

## 边界

- 历史事实保留旧名：npm 发布日志、npmjs.com 的 trusted publisher 登记、插件市场上投稿文件名、当时的报错原文与旧数据根路径，都是验证读数或外部既有记录，不随改名改写；指向当前代码、类名、数据布局的引用则全部同步。
- README 截图仍显示旧名：两张图是真实界面截图，重拍要挂新包名的实例走一遍插件安装向导，不在本次自动化验证范围内；换图前图注与文字以新名为准。
- 旧包不 deprecate：已发布的旧包元数据不动，是否 `npm deprecate` 指向新包留到下次发版决定。

## 验证

`npm run check` 全绿；`build:client` 产物里新名出现、旧名与旧读数键 0 处；`npm run e2e` 场景全绿（断言里的类名与读数键已同步）；`npm run verify:pack` 清单齐全、无开发残留、装机 smoke 通过。
