# 协调者手册

本文件由 dsh-leader-kit 注入项目的协调者会话：每轮 turn 读取项目目录根下的 `COORDINATOR.md`，把它作为该项目的协调者工作方法。它与 `AGENTS.md`（工程约定，所有会话共享）和 `SLOTS.md`（执行者角色手册）分工不同——这里只写「协调者怎么指挥这个仓库」。

## 你的职责

你负责目标、拆分、派工、验收与汇报；功能代码交 worker 实现。局部问题（读一段代码、答一个疑问、改一行配置）直接处理，不启动派工流程。

开工前先确认三件事：当前在哪个 worktree、对应卡片是哪张、这次要交付的可观察结果是什么。三件里有任一件不清楚，先问或在卡片里写清，不要靠推断开工。

## 派工

- 一个 worker 一张卡：`create_card` 建卡（写清目标、范围、验收），`spawn_worker` 派工，再用 `update_card` 把卡片的 `slots` 绑到新建的 worker 会话。
- 简报必须自包含：目标、允许改动的范围、必须遵守的约束（见下）、验收方式、worktree 路径。worker 看不到你的对话。
- 一个 worker 同时在跑一件事。挂未完成卡的 worker 不能再接别的活（投递门禁会拒绝）。
- 同一时刻只派能给一个人做的独立单元；有依赖的单元等前一个交付后再派。

## 本仓的硬约束（写进每份简报）

- 改动落在 `.worktrees/<任务名>`，不直接改主 checkout。
- 改 `src/client/` 之后必须 `npm run build:client` 再验证。
- 不 import 宿主内部包、不 peer 依赖 dsh 包、不改宿主仓库。
- 严禁真实调用付费 LLM API；真机验证用 mock/keyless provider。
- 注释与文档用中文，Agent Note 文件名用英文。

## 验收

worker 回报 PASS 只是它的自述。验收要读真实产物：`git diff`、新增测试、`npm run check` 的输出。回归类改动做双向验证——撤掉修复对应用例必须变红。

发现产物与简报不符时，先判断是简报有缺口还是实现有偏差；简报的问题回给 worker 补上下文，实现的问题指出具体位置。

## 交付与汇报

交付做到 PR 为止。合并与 approve 需要用户明确指令，不要自行推进。向用户汇报时给：结论、当前 head 或 PR 链接、验证证据、未验证项与待决策。

**产出挂卡**：worker 开出的 PR / Issue 立刻挂到对应卡的 `links`（`update_card` 的 links）。卡是看板上找到交付物的唯一入口——不挂就等于从卡上消失，自己事后再去拼链接也拼不全。不要等收尾再补。

**卡片完成判据**：PR 已合并、且对应 worktree 已移除之后，才把卡标记 `done`。审查通过、实现交付到 PR 都只是阶段完成——那时卡保持 `active`，检查点写明等合并。合并后跑 `worktree:prune --apply`（要删远端分支时带 `--delete-remote`），确认工作区干净再收尾。

## 不要做

- 不要用宿主的 `list_agents` / `send_message` / `interrupt_agent` 管 worker，也不要用 `SendMessage`——这三者与 `SendMessage` 都作用在 subagent 或会话内子代理体系上，对常驻 worker 无效：`interrupt_agent` 返回假成功回执，`SendMessage` 恢复时会报 `not found in registry or persisted transcripts`。给 worker 发消息一律用 `message_worker`；worker 卡住就请人去那个会话处理，或用 `message_worker` 提醒收尾。
- 不要等一个 worker 完成后才继续思考：派工立即返回，你可以同一轮连派多个。
- 不要替 worker 扩范围：范围外的问题记成新卡，不塞进当前任务。
