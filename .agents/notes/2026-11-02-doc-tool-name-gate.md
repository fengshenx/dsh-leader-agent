# 文档里的工具名也进机械校验：一处取名字，只认 snake_case 形状

2026-11-02。

## 背景

issue #43：`SLOTS.md` 曾要求挂 `dev` 槽位的 worker 调用已删除的 `worker_done`。删工具时文档只同步了 README 与 `skills/`，`SLOTS.md` 漏了一句，那之后每一轮都有一条指向不存在工具的指令。PR #42 的对抗探针确认：撤掉那行修复，现有门禁不会变红——`tests/`、`scripts/` 对 `worker_done` 零命中。注入给会话的文档与 `tools.register` 之间没有任何机械约束。

issue #45：`src/host/projects/service.js` 与 `remote.js` 里几处注释仍在用 #34 已推翻的理由解释「项目会话为什么要归属工作区」——「只有归属工作区的会话才能被官方 UI 打开」。定稿理由在 `2026-11-02-project-owns-workspace.md`：归属是为了分组，不是可打开性。

## 决策

### 工具名只从装配列表取

`src/host/index.js` 导出 `createBundleTools()`，`apply` 遍历它注册，门禁 `import` 它取名字。没有第二份名单：删工具、改工具名，装配列表与门禁同时变。宿主提供、本仓文档会引用的三件（`list_agents` / `send_message` / `interrupt_agent`）取 `COORDINATOR_UNUSABLE_TOOLS`——仓库里唯一登记宿主工具名的常量。

### 判定只看形状，不按语境界定

issue 建议「同行含调/用/工具」才当候选。实测这条会漏：11 篇文档、41 处 `snake_case` 反引号里，6 处所在行没有这些字，其中包括 `skills/leader-mode/playbooks/program.md:11-16` 整张「协调者动作与工具」表与 `COORDINATOR.md:40` 的 `update_card`——恰好是最该守的几行。本仓代码是 JS，字段与变量写 camelCase，文档里 `snake_case` 的反引号内容实际全是工具名；全量校验在现有文档上 0 误报。

### 围栏代码块跳过

围栏里是示例代码，不是文档在让会话去调工具。

### 扫描面只覆盖注入提示词的文档

`SLOTS.md`、`COORDINATOR.md`、`skills/**/*.md`。README 与 `docs/` 是给人读的；`.agents/notes/` 记着已删工具的历史，扫进来必然误报。

### 注释改写成定稿理由

`coordinatorAttached` 的语义是「协调者此刻是否挂在工作区上」，客户端并不消费这个字段——旧注释写的「决定浏览器侧能不能打开」既过时，也没有实现依据。五处（`service.js` 的 `list` / `attachCoordinator` / `replaceCoordinator` / `ensureWorkspace` / `createCoordinatorSessionWithCtx`，`remote.js` 的 `attachCoordinator`）统一改成「归属决定分组：不归属落『未分组』，而项目会话行被渲染层藏了，只剩空组头」，并在 `ensureWorkspace` 留下「官方 UI 打开会话不要求归属」的显式更正，防止下一个人又被旧论证带偏。

## 边界

- 门禁只管文档一侧：它证明「文档写的名字注册过」，不证明注册的工具在宿主上真的可用，也判不了「这个工具对当前角色被 deny」。
- 宿主三件只能对齐本仓的登记（`COORDINATOR_UNUSABLE_TOOLS`），验不到宿主版本里是否真有它们——那是 `engines.dsh` 契约与 `docs/capability-gaps.md` 的范围。
- 只看 `snake_case`。大写宿主工具（`Read` / `Grep` / `Bash`）与 camelCase 字段不校验；将来若在文档里写非工具的 `snake_case` 标识符，门禁会报——这是刻意选的误报方向，改文档措辞即可，不要关掉门禁。
- 围栏代码块里写错工具名抓不到。
- 注释改动不改行为：`coordinatorAttached` 的取值与消费者不变。

## 验证

- `npm run check`：602 tests / 602 pass / 0 fail（新增 7 条），Agent Note 门禁 37 篇、文档工具名门禁 11 篇全过。
- 双向验证 A（门禁本身）：把 `worker_done` 写回 `SLOTS.md:35` → `npm run check` 退出 1，报 `SLOTS.md:35: worker_done 不是已注册的工具名`；还原后 11 篇全过、check 退出 0。
- 双向验证 B（判定逻辑，两个失效方向各撤一次）：
  1. 去掉 `!known.has(name)`（形状命中就报）→「已注册的工具名不报」「工具清单那种没有『调/用』字样的行也校验」「仓库里注入会话的文档零误报」3 条红；
  2. 让 `unknownToolNames` 恒返回空数组 →「不存在的工具名报出所在行」「一行里的多个未知工具名逐个报」「工具清单…」「围栏代码块里的内容不扫」4 条红；
  3. 还原 → 7 / 7 绿。
- 出处探针（工具名只有一处来源）：从 `createBundleTools` 删掉 `createListCardsTool` → 门禁报 3 处（`skills/leader-mode/SKILL.md:80` 两次、`playbooks/program.md:16`），集成用例「仓库里注入会话的文档零误报」同时红；还原后全绿。
- 覆盖率读数：语境界定版漏 6 / 41 处候选；改成形状判定后这 6 处进入校验，现有文档仍 0 误报。
