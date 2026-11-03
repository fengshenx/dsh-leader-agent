# 协调者手册注入

**状态**：implemented（2026-10-29）
**范围**：`src/host/coordinator-context.js`、`src/host/index.js`、`tests/coordinator-context.test.js`、本仓根的 `COORDINATOR.md` 与 `SLOTS.md`

## 背景

角色槽位（`SLOTS.md`）早已能按卡片绑定把角色正文注入执行会话，但**协调者侧没有对应的项目级手册**：协调者会话能拿到的只有宿主读的 `AGENTS.md`（工程约定，所有会话共享）与 `leader-mode` skill（通用协议）。项目特有的指挥方式——这个仓库怎么派工、验收看什么、有哪些硬约束——只能每次口头交代，或者塞进 `AGENTS.md` 污染所有会话的上下文。

协调者与执行者的手册来源应当对称：执行者读 `SLOTS.md` 里自己那个槽位，协调者读 `COORDINATOR.md`。差别只在于「怎么找到自己」——执行者靠卡片绑定（`slots` 字段），协调者靠身份（项目注册表的 `coordinatorSessionId`）。身份是现成的，不需要再引入一份绑定。

## 决策

**项目目录根的 `COORDINATOR.md` 注入该项目的协调者会话**，无需任何绑定与 skill 加载。

- **注入通道与槽位相同**：`ctx.systemPrompt.context()` 注册运行时上下文 provider（`src/host/coordinator-context.js`），不是 section。section 进的是会话级固定的系统提示词消息，文件改了不会重写；运行时上下文每轮组装时重新求值，「改动在下一轮 turn 生效」因此是结构性的，不需要 watcher。
- **按身份决定，按目录取值**：注入函数只拿到 `resolveDirectory(sessionId)`，实现在 `src/host/index.js` 里接 `projectService.directoryOfCoordinator()`——只有协调者会话有值，worker 与普通会话一律 `undefined`。这比再传一个 `isCoordinatorSession` 判断少一条可能不一致的真源。
- **上下文顺序 104**，排在角色槽位（105）之前：协调者手册说的是「谁在指挥这个项目」，属于身份事实，先于「我这次承担哪个角色」。
- **缺失不回落**。`SLOTS.md` 缺失时回落到默认三角色，因为槽位名本身是协议的一部分；`COORDINATOR.md` 缺失时不生成兜底正文——通用方法已经由 `leader-mode` skill 覆盖，凭空生成一段「你是协调者」的空话只会挤占上下文。
- **读失败与正文为空都注入空串**，不阻断会话。两种空分开：文件缺失（`ENOENT`）是常态，静默；其他读失败（`EISDIR`、`EACCES`、磁盘 I/O）走 `logger` 留痕——否则用户改了手册却看不到生效，无从排查。手册是增量信息，不能让一次文件读取失败把整个 turn 打崩。

## 边界

- **项目索引未就绪的那一轮不注入**。`directoryOfCoordinator()` 读进程内镜像，镜像由 `loadIndex()` 重建；重建完成前所有会话都拿不到目录，协调者也是。下一轮补上，不影响第一轮开工（工具面另有「未就绪时宽松放行」的兜底，见 [协调者工具面的裁剪时序](../bug-fix/2026-10-29-coordinator-tool-gate-timing.md)）。
- **不授予工具权限**。与槽位一致：只贡献一段提示词文本，工具面由 `tools.restrict()` 按角色裁剪。
- **客户端不知道这份文件**。手册只在提示词组装时读，看板与项目树不展示它；没有 UI 编辑入口，用常规 `Write` / `Edit` 维护。
- **本仓根的两份文件是自用配置**，不是模板分发：`COORDINATOR.md` 写本仓的协调者方法，`SLOTS.md` 定义 `discuss` / `dev` / `review` 三个执行者角色。`init-project` skill 仍只写 `AGENTS.md` 的受管区块，不代生成这两份文件。

## 验证

- `tests/coordinator-context.test.js` 新增 8 个用例：注册项属性（名称 / 顺序 / 必需 / 不插值）、无会话、非协调者、正常注入、缺失与空白、缺失不记日志、读失败记日志、渲染异常记日志。
- **顺序断言用常量而非字面量**：`COORDINATOR_CONTEXT_ORDER < ROLE_CONTEXT_ORDER`。硬编码 `105` 守不住这条不变量——槽位顺序下调时旧断言照样通过（实测把 `ROLE_CONTEXT_ORDER` 改成 103，旧断言全绿、新断言变红）。
- **装配层用例**（`tests/coordinator-wiring.test.js`）：假 ctx + 假 `sessions`（cwd 指向另一份带手册的目录）跑一遍 `apply()`，断言非协调者会话不注入、协调者会话注入的是项目注册表里的目录。判据可双向验证：把接线换成 `isCoordinatorSession ? ctx.get('sessions')…header.cwd : undefined`，该用例变红；还原后绿。参数化单元测试发现不了这类接线错位——`resolveDirectory` 在桩里都是常量。
- 双向验证：把 `renderCoordinatorContext` 的正文分支临时改成恒返回空串，「协调者会话注入项目根手册正文」变红；撤掉读取失败的日志分支，「读失败（文件位置被目录占用）时返回空串并记日志」变红。还原后全绿。
- `npm run check` 全量通过。真机未取证：需要起 dev 实例把一个项目注册到本仓目录，观察协调者会话的请求里是否带上手册正文，留待下一次 GUI 取证。
