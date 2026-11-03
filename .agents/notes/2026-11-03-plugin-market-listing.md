# 插件市场上架路径

## 背景

本包已发布 npm（0.1.1，OIDC），但生态里没有任何目录收录它：`dsh-leader-kit` 的 GitHub topics 是空的，搜索与市场面板都找不到。要做的是把包放进 dsh 生态的发现链路。

调研结论：**dsh 本体不内置任何索引源**（`docs/user/guide/plugin-market.zh.md`：Discover 标签页只在实验性「自定义插件索引」bundle 打开后出现，且要用户手动添加索引 URL）。生态里被广泛安装的市场 `dsh-market/dsh-market`（10k★）**本身不是目录**，它只读 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（22k★，CC0）的策展条目。因此上架是一个单点动作：向 awesome-dsh-plugin 提一条 YAML 条目，站点、dsh-market 面板与 Discover 索引都会在一天内自动跟上。

## 决策

### 只投 awesome-dsh-plugin，不自建索引源

自建索引源（官方 `@deepseek-ai/dsh-plugin-market-index` + 静态 JSON）不需要任何人审核，但要求用户先知道你、再手填 URL，只对已有受众有用。目录是唯一能被人**搜到**的入口，而它有唯一上游——绕开它做第二套索引只会多一份会漂移的清单。

### category 取 `workflow`

现有同层条目里 `eteams`（领队派发给子会话）、`dsh-agent-foreman`（父智能体派单验收）、`dsh-task-dispatch-table`（任务表调度）都归 `workflow`。本包的核心也是目标拆解 → 派工 → 收取回报 → 验收，看板是这件事的载体而不是独立的 UI 卖点。维护者说明分类不准会直接改、不因此打回，所以按实际行为选最接近的即可。

### 描述只写可核对的行为

awesome 的评审会把描述当作对代码的声明逐条核对（contributing 的「How submissions are reviewed」第 1 条），夸大是主要打回原因。因此描述里的每一句都对应本包实现：常驻 worker 会话（走 `ctx.agents.create`，不是宿主 subagent）、按角色的工具面裁剪、右侧栏按项目看板、`LEADER.md` / `SLOTS.md` 每次请求前求值、`read_worker_session` 只读回放。**不写「每个 worker 一个 worktree」**——那是本仓约定的使用方式，不是 bundle 的硬性行为。

### 不声明 `peerDependencies`

awesome 的投稿建议把 `@deepseek-ai/*` 声明成 `peerDependencies`，但那条建议面向**依赖宿主包**的插件。本包 `dependencies` 与 `peerDependencies` 都为空（不 import 宿主内部包、不 peer 依赖 dsh 包是[本仓铁律](../../AGENTS.md)），照着抄反而会把宿主包拉进依赖图并引入重复实例。这条不适用，不是遗漏。

## 边界

- **仓库必须有 `dsh-plugin` topic**：gate 与人工评审都按 topic 发现插件，`package.json` 的 `keywords` 不替代它。
- **`dsh.bundle` 是硬门槛**：只声明 `dsh.client` 无法 `dsh plugin add`，是历史上被打回最多的原因。两项本包都已具备。
- **目录不收纯聚合包**：内容只有依赖清单的 bundle 不给行。本包自带行为（工具、派工器、client 面板），不属于这一类。
- **收录 ≠ 安全审查**：README 顶部明写这不是审计。本包被收录也不构成对宿主兼容性的背书。
- **市场不提供下发**：dsh-market 的安装来源限定在目录条目内，条目变更需要等它自身的目录缓存刷新（打开面板时实时拉取 `awesome-dsh-plugin.com/plugins.json`）。

## 验证

- 条目在 awesome-dsh-plugin 的本地 clone 中写好，文件名 `data/plugins/fengshenx__dsh-leader-kit.yml`（`<owner>__<repo>.yml`，仓库名与 `url` 完全一致），YAML 单文件即全部投稿内容；两个 README 由 `scripts/generate-readme.mjs` 生成，不手改。
- 跑该仓自己的 gate `node scripts/check-submission.mjs --base <提交前 sha>`：校验 `package.json` 的 `dsh.bundle`、仓库年龄 ≥ 1 天、仓库未归档、非 DSH 本体本身。
- 本仓 `npm run check` 全绿（Agent Note 格式门禁覆盖本文件）。
