# 协调者手册注入

## 背景

角色槽位（`SLOTS.md`）早已能按卡片绑定把角色正文注入执行会话，但 leader 侧没有项目级手册：能拿到的只有宿主读的 `AGENTS.md`（工程约定，所有会话共享）与 `leader-mode` skill（通用协议）。项目特有的指挥方式只能每次口头交代，或塞进 `AGENTS.md` 污染所有会话。手册来源应当对称：执行者读自己那个槽位，leader 读 `LEADER.md`，差别只在「怎么找到自己」——执行者靠卡片绑定，leader 靠项目注册表里的身份。

## 决策

- **项目目录根的手册注入该项目的 leader 会话**，无需任何绑定与 skill 加载；文件现名 `LEADER.md`，旧名 `COORDINATOR.md` 只作读取退回。
- **注入通道与槽位相同，走运行时上下文**（`systemPrompt.context`），不是 section：section 进的是会话级固定的提示词消息，文件改了不会重写；运行时上下文每轮组装时重新求值，「改动在下一轮 turn 生效」因此是结构性的，不需要 watcher。
- **按身份决定，按目录取值**：注入函数只拿到 `resolveDirectory(sessionId)`，实现接 `directoryOfLeader()`——只有 leader 会话有值，worker 与普通会话一律 `undefined`。这比再传一个 `isLeaderSession` 判断少一条可能不一致的真源。
- **上下文顺序 104，排在角色槽位（105）之前**：手册说的是「谁在指挥这个项目」，属于身份事实，先于「我这次承担哪个角色」。
- **缺失不生成兜底正文**：`SLOTS.md` 缺失时回落到默认角色，因为槽位名本身是协议的一部分；手册缺失时不凭空生成一段「你是 leader」的空话——通用方法已由 `leader-mode` skill 覆盖。缺失改为注入初始化提示，见[新项目的引导卡](2026-11-03-project-initialization-onboarding.md)。
- **读失败与正文为空都注入空串，不阻断会话**：文件缺失（`ENOENT`）是常态、静默；其他读失败（`EISDIR`、`EACCES`、磁盘 I/O）走 `logger` 留痕——否则用户改了手册却看不到生效，无从排查；手册是增量信息，不能让一次读文件失败把整个 turn 打崩。

## 边界

- **项目索引未就绪的那一轮不注入**：镜像重建完成前所有会话都拿不到目录，leader 也是；下一轮补上（工具面另有未就绪时宽松放行的兜底，见[协调者工具面的裁剪时序](../bug-fix/2026-10-29-coordinator-tool-gate-timing.md)）。
- **不授予工具权限**：只贡献一段提示词文本，工具面由 `tools.restrict()` 按角色裁剪。
- **客户端不知道这份文件**：手册只在提示词组装时读，看板与项目树不展示它，没有 UI 编辑入口，用常规 `Write` / `Edit` 维护。
- **本仓根的两份文件是自用配置**，不是模板分发；`init-project` skill 仍只写 `AGENTS.md` 的受管区块，不代生成。

## 验证

`tests/leader-context.test.js` 与 `tests/leader-wiring.test.js` 钉住顺序与装配层取值；顺序断言用常量（`LEADER_CONTEXT_ORDER < ROLE_CONTEXT_ORDER`），硬编码数字守不住不变量；双向：把接线换成读会话头 cwd，装配层用例变红。
