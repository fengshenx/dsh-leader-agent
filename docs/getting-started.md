# 上手：从一个目录到一张卡

README 给最短路径，[使用手册](usage.md) 给每个动作的完整边界；本文把两者串成一条完整路径：**准备能并行的环境 → 加一个项目（得到一个 Leader）→ 写两份项目提示词 → 建卡派工 → 从卡上下钻**。第一次用按顺序走一遍，之后当速查。

## 一、前提：任务之间真的隔离

这套玩法不是「一个会话里放几个 agent」，而是**一个项目一个 Leader、一个任务一个 worker、一个 worker 一个 worktree**。前提没满足，派出去的活会在同一份 checkout 上互相踩：

- 每个任务一个 worktree（`npm run worktree:spawn <任务名>`），简报里写死 worker 的 worktree 路径；
- 每个 worktree 一个独立实例（`npm run dev`），数据根也独立，插件版本互不覆盖；
- 同一项目下的 worker 各在自己的会话里跑、不共享上下文——Leader 是唯一知道全局的人。

为什么必须隔离、数据落在哪儿，见 README 的[前提](../README_ZH.md#前提先跑通多-worktree-并发)与[开发](development.md)。桌面版另走 `npm run desktop`，profile 与 web 分开，见 README 的桌面版小节。

## 二、加一个项目，就得到一个 Leader

左栏「项目」区块（在「自动化任务」之下、工作区之上）→ 右上角「加项目」→ 选一个目录。项目**当场建好**，并绑定一个 leader 会话。

记住一句话：**项目行就是 Leader 的入口**。

| 你看到 | 它是什么 |
|---|---|
| 项目行 | 这个项目的 Leader 会话，点它就是打开 Leader |
| 项目行下的会话行 | Leader 派出的 worker；点它直接进那个 worker |
| 行首目录图标 / 加载圈 | 平时是目录图标；换成加载圈表示 Leader 在跑（项目收起时，名下有 worker 在跑也会换） |
| 行尾「更多」 | 重命名 / 换新 Leader / 删除 |

几个容易卡住的点：

- Leader 在项目树下**没有自己的会话行**，这不是丢了——项目行就是它；
- 目录名即项目名，可以重命名；同名目录会依次建成 `repo`、`repo-2`；
- 项目目录被删或被移走时，点项目行会先给提示；
- 删除项目只删记录，文件夹、会话记录与 dsh 工作区都保留。

## 三、两份文件：Leader 的人设，worker 的工作方法

项目目录根下放两份 Markdown。它们只贡献提示词，不授予工具权限；**改文件即改行为**——每轮模型请求前重新求值，正文变了才追加，不用重启会话。

| 文件 | 写给谁 | 写什么 |
|---|---|---|
| `LEADER.md` | 这个项目的 Leader（leader 会话，自动注入，无需绑定） | Leader 的人设与指挥方法：职责边界、拆卡粒度、派工要求、验收口径、本项目硬约束 |
| `SLOTS.md` | 被卡片 `slots` 绑定的 worker | 每个角色的工作方法与人设，按 `## <槽位名>` 分节；槽位名就是卡片里写的那个 |

文件名是 `LEADER.md`；`COORDINATOR.md` 只作为兼容入口保留（给仍按旧文件名找手册的外部工具），正文只指向 `LEADER.md`，不参与注入——本仓自己那份见 [LEADER.md](../LEADER.md)。

### `LEADER.md`：先定义 Leader 是谁

最小骨架：

```md
# leader 手册

你是这个项目的技术负责人。你只做 routing：目标、拆分、派工、验收、收尾。

- 不亲自落地：代码、测试、文档的改动一律派 worker 在它自己的 worktree 里做。
- 一个 worker 一张卡；简报必须自包含：目标、范围、约束、验收方式、worktree 路径。
- 验收读真实产物（diff、测试、检查输出），不采信 worker 的自述。
- 合并与 approve 由用户决定。
```

写人设时值得明确三件事：**你是什么角色**（技术负责人 / 产品负责人 / 评审者）、**你不做什么**（不代写、不扩范围、不自行合并）、**什么算完成**（验收口径）。没写这些，Leader 会退化成「一个会转发的助手」。

### `SLOTS.md`：定义每个角色怎么干活

顶部 frontmatter 声明显示名，正文按槽位分节；没写这个文件时回落内置两角色（`dev` / `review`），正文为空。

```md
---
slots:
  dev:
    label: 开发
  review:
    label: 审核
---

## dev

你是实现者。动手前先读相关源码与工程的 AGENTS.md。

- 改动落在自己的 worktree，不碰主 checkout。
- 先搜既有实现再动手，最小化变更范围。
- 交付做到 PR；当轮结束即自动结算，把产物与验证结果写进最后的回复。

## review

你是审查者。先按严重程度列问题，再给结论。

- 每条问题给文件与行号、触发条件、影响。
- 至少跑一条对抗探针（并发、边界值、幂等、错误路径）。
```

槽位名是 ASCII 机器标识（小写字母、数字、下划线、连字符，最长 32 字符），中文显示名写 frontmatter 的 `label`。卡片的 `slots` 字段把角色绑到会话，被绑会话每轮注入对应正文。

## 四、一张卡：从创建到下钻

以「修 Safari 上登录页错位」为例，全部动作由 Leader 调工具完成，你只需要说目标。

1. **建卡**：Leader 调 `create_card({ title, spec })`，`title` 是卡面一句话，`spec` 写目标、范围与验收。右栏「看板」Tab 自动打开。
2. **派工并绑卡**：Leader 调 `spawn_worker({ name: 'dev-safari-login', cardId, slot: 'dev' })`。立即返回会话 id，此时 worker **还没开工**，但卡片的 `dev` 槽位已经绑到它。
3. **投第一条消息才开工**：Leader 调 `message_worker({ sessionId, message: '<自包含简报>' })`。worker 在自己的 worktree 里跑，卡面 `dev` chip 亮起信号灯。
4. **完成自动回报**：那一轮结束，Leader 收到一条 worker 发言气泡（产物摘要或失败原因），不需要轮询，worker 也不用调工具交作业。
5. **下钻**：点卡面打开详情；点 `dev` chip 直接进 worker 会话，像普通会话一样看过程、接着说。
6. **收尾**：验收后 Leader 调 `update_card({ id, status: 'done' })`，槽位自动释放，worker 能接下一张卡。

规则提示：

- 卡必须是**本项目**的、`active` 状态才能绑 worker；跨项目或已关闭的卡会被拒绝；
- 一张未完成卡上的 worker 不能接别的工作；
- worker 只能改自己挂着的卡，且只能挂 `links`（PR / Issue 等）；标题、规格、状态与槽位归 Leader。

## 五、看板不出现 / 派工被拒：先查这几条

| 现象 | 原因 |
|---|---|
| 右栏没有「看板」Tab | 当前会话不属于任何项目；看板只对项目会话展示 |
| `create_card` 报没有权限 | 只有 Leader 能建卡与列卡，worker 只有 `update_card` |
| `spawn_worker` 被拒 | 卡不是本项目、不是 `active`，或这个 worker 还挂着未完成卡 |
| 改 `SLOTS.md` 没生效 | 确认改的是被绑的那个槽位名，且正文确实变了 |
| 桌面版没有看板 | 桌面版读 `desktop` profile，与 web 的插件安装互不相通 |

完整边界见[使用手册](usage.md)：派工、续聊、回看 worker 会话、卡片、看板、项目管理、槽位与 leader 手册。看板与信号灯的口径见[已知限制](limitations.md)。
