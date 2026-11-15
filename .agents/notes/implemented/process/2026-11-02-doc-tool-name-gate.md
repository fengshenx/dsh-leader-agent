# 文档里的工具名也进机械校验：一处取名字，只认 snake_case 形状

## 背景

`SLOTS.md` 曾要求挂 `dev` 槽位的 worker 调用已删除的 `worker_done`：删工具时文档只同步了 README 与 `skills/`，注入给会话的文档与 `tools.register` 之间没有任何机械约束。另一处是注释用已被推翻的理由解释「项目会话为什么归属工作区」，那个理由后来随[项目与 dsh 工作区解耦](../architecture/2026-11-03-project-workspace-decoupled.md)整体删除。

## 决策

- **工具名只从装配列表取**：`createBundleTools()` 既用于注册也供门禁 `documentedToolNames()` 取名字，删工具或改名时两处同时变；宿主提供、文档会引用的三件从 `HOST_SUBAGENT_TOOLS` 取。`COORDINATOR_UNUSABLE_TOOLS` 是同一份数据的别名但语义不同，拿 deny 名单当「已知工具集合」会让门禁跟着「协调者能不能用」漂移。
- **守门用例用正向断言**：门禁必须 import `documentedToolNames()`、不 import `gate.js` 的任何符号、源码里不得出现宿主三件的名字；只断言「不含某个符号名」可被改写导入或内联数组绕过。
- **判定只看形状**：同行含「调 / 用 / 工具」才当候选会漏掉整张协调者动作表这类最该守的行；本仓代码用 camelCase，文档里反引号包着的 `snake_case` 实际全是工具名，全量校验在现有文档上零误报。
- **围栏跳过，但不配对要报错**：围栏里是示例代码；围栏不配对时静默会让后半篇整段跳过、门禁照样绿。
- **扫描面只覆盖注入提示词的文档**：`SLOTS.md`、`LEADER.md`、`.agents/skills/**/*.md` 与维护者手册 `docs/release.md`（`MAINTAINER_DOCS`）。README 与其余 `docs/` 是给人读的，`.agents/notes/` 记着已删工具的历史。

## 边界

- 门禁只管文档一侧：它证明「文档写的名字注册过」，不证明工具在宿主上可用，也判不了「这个工具对当前角色被 deny」。
- 宿主三件只能对齐本仓的登记，验不到宿主版本里是否真有它们——那是 `engines.dsh` 契约与 `docs/capability-gaps.md` 的范围。
- 只看 `snake_case`：大写宿主工具与 camelCase 字段不校验；将来在文档里写非工具的 `snake_case` 标识符会误报——这是刻意选的误报方向，改文档措辞，不要关掉门禁。
- 围栏代码块里写错工具名抓不到（围栏本身不配对则会报错）。

## 验证

`tests/doc-tool-names.test.js`；双向读数：把 `worker_done` 写回 `SLOTS.md` → 退出 1 并报出文件名与行，还原后退 0；`scanToolNames` 不再返回 `unclosedFence` → 「围栏没闭合时报出错位置」红。
