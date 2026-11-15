# Agent Note: 删除项目工具与卡片检查点，看板收紧到协调者会话

Status: implemented

## Problem

三项功能在模型侧没有真实收益：项目注册表已有完整的左栏 UI，`switch_project` 只返回会话 id、模型不能导航，`remove_project` 还是没有二次确认的破坏性操作；`init_project` 只是把约定文本并入 `AGENTS.md` 的受管区块；卡片的 `checkpoint` 字段没有消费方。另有一项可见性过宽：项目归属按会话 cwd 判定，普通会话与 worker 都能在右栏看到项目卡片。

## Decision

### 项目注册表只经 UI

模型不再有项目工具（`list_projects` / `add_project` / `switch_project` / `remove_project` / `init_project`），建、切、注销、换协调者都在左栏「项目」区块完成；协议层相应改写，`spawn_worker` 的拒绝文案引导用户去区块。目录选择器不可用（宿主缺 web-app 导航服务）时无法建项目，需换 web profile——显式限制，不保留工具兜底。

### 初始化改为纯 skill

`skills/init-project/SKILL.md` 不调工具：读 `references/conventions.md`，用宿主的文件编辑能力并入 `AGENTS.md` 的受管区块（标记仍是 `dsh-leader-agent:conventions:start/end`），重复执行只替换区块——幂等靠「替换同标记区块」保证。

### 删除 checkpoint

卡片只留标题、规格、状态、链接、槽位绑定与 `revision`；`expectedRevision` 的乐观并发不动（它解决并发写冲突，与检查点无关）。已落盘卡片里的 `checkpoint` 不迁移：读取时原样保留但无消费者，下一次实质更新落盘时删掉，不为清理单独 bump revision。

### 看板收紧到协调者会话

> 已被 [2026-10-30 的看板入口按会话过滤](../feature/2026-10-30-board-entry-per-session.md) 取代：看板现在对项目会话（协调者 + 该项目派出的 worker）开放，右栏入口也按会话画。本段保留当时的边界记录。

当时的收紧靠 `coordinatorSessionId` / `coordinatorAlive`（存活 = 会话记录存在且未归档，查询后端缺失按「还在」处理）与常驻摘要复核，这些形态随该篇失效。**宿主限制**仍在：右栏 tab 与「开始」页引导入口是全局静态注册，没有按会话过滤的扩展点；2026-10-30 起用 `sidebar.right.tab.guide.entry` 接管本插件自己的入口渲染来绕过。

## Alternatives considered

- **保留 `switch_project` / `remove_project` / `init_project`**：前者只返回会话 id、模型不能导航；中者是无二次确认的破坏性操作；后者只是把约定文本并入 `AGENTS.md`。项目注册表只经 UI。
- **保留卡片 `checkpoint` 字段**：没有消费方，只增加每轮注入体积；删除，存量读取保留但不再写。
- **继续让普通会话与 worker 看看板**：项目归属按 cwd 判定，普通会话也看到卡片；收紧到项目协调者（2026-10-30 又放宽到项目会话）。
- **为 headless 保留项目工具兜底**：项目是编排语境，没有 UI 时本来也没有协调者会话可打开；显式限制。

## Consequences

- 项目工具删除后 headless / 终端场景没有模型侧的建项目入口，只能靠 UI：项目是编排语境，没有 UI 时本来也没有协调者会话可打开。
- 入口曾全局可见（2026-10-30 已消除）；在那之前，普通会话点开只在面板里看到提示。
- checkpoint 的「任务事实」职责回归卡片 `spec` 与 `list_cards` 单卡查询。

收益：模型侧少三个没有真实收益的项目工具和一份没人消费的检查点，看板与卡片写入的边界更清楚。

## Testing

`tests/cards-tools.test.js` 断言 `checkpoint` 被拒且不落盘，撤掉拒收分支即红；项目工具与 `createdName` 的删除无对应用例，回归读数是装配列表与文档门禁里零命中。
