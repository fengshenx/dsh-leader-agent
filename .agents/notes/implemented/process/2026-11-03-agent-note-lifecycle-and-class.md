# Agent Note 双轴：lifecycle × class

## 背景

`.agents/notes/` 此前是扁平的：72 篇 `.md` 直接堆在目录下，路径不含任何状态或类型信息。门禁（`scripts/agent-note-format.mjs`）只判四件事——文件名日期形状、唯一 H1、首节 `## 背景`、有 `## 决策`。

这带来两个具体问题：

- **分不出"这篇还需不需要读"**。仓里已经出现了被作废的记录：`2026-11-02-project-activity-indicator.md` 的整个渲染段被 StateDot 取代，`2026-10-23-dispatch-and-wakeup.md`、`2026-10-27-board-card-visual-and-interaction.md`、`2026-11-02-project-tree-session-selected.md`、`2026-10-29-drop-project-tools-and-card-checkpoint.md` 则是部分被推翻。它们和仍然有效的笔记在同一层，只能靠打开文件读正文里的「已被…取代」才认得出。
- **分不出改动的性质**。想找"这条笔记是修 bug 还是改架构"，只能靠标题猜。

宿主 dsh 早就是双轴：`{lifecycle}/{class}/yyyy-mm-dd-slug.md`，lifecycle 有 `proposed` / `implemented` / `rejected` / `archived`，class 有 `feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`。

## 决策

### 路径编码双轴，两个轴都是闭集

`.agents/notes/{lifecycle}/{class}/{文件名}`。门禁校验路径恰好三段、两段取值都在闭集内。类目口径写在 `.agents/notes/README.md`（一个事实一处归属，`AGENTS.md` 只留一句断言加链接）。

关键判别线：**改运行时行为 → feature / bug-fix / simplification / architecture；改围绕代码的工具与流程 → process / testing；删代码删行为 → simplification；在某个平台上不工作 → bug-fix。**

### 不写 `Status:` 行

宿主每个文件头写 `Status: implemented` 并与目录交叉校验。本仓不写：路径已经是状态的唯一来源，单语种仓库没有 `.zh.md` 对照需求，双写只会多出一处必须同步、又能被门禁拦下的不一致来源。

代价是这次把存量 38 篇的 `**状态**` 行全删了——取值是 `implemented`（33 篇）/ `current`（3 篇）/ `accepted`（1 篇）/ `revised`（1 篇），除第一篇外都不在 lifecycle 闭集里，留着就是与新规则直接冲突的第二处状态。删前逐篇核过：两篇长状态行（`project-scope-and-role-slots` 的 319 字符修订摘要、`client-side-findings` 的补记说明）里的内容在正文都有对应记录，删掉不丢事实。

### 骨架按 lifecycle 分档

| lifecycle | 必需节 |
|---|---|
| `implemented` / `archived` | `## 背景` + `## 决策` |
| `proposed` | `## 背景` + `## 提案` + `## 验收标准` |
| `rejected` | `## 背景` + `## 提案` + `## 否决理由` |

`archived` 沿用 implemented 的骨架：进 archived 的文件原本都是 implemented，归档只移动路径、不改正文。

### archived 只作历史，不引入冻结清单

宿主的 `archived/manifest.json` 记内容 hash、禁止任何改动，那是给 900+ 篇历史记录防篡改用的。本仓 72 篇的规模负担不起这份维护成本，门槛降到：archived 不再指导当前行为、不再修改。

归档判据也据此收紧：**整篇决策都不再指导未来工作才进 archived**，部分被取代的留在 `implemented` 并加一行 `> **已被 [标题](…) 取代**：…` 指针。

这条判据第一版就判错过一次：`2026-11-02-project-activity-indicator` 被整篇归档，理由是「全部决策（自绘 spinner 的类名、`currentColor`、关键帧）都被 StateDot 取代」。审查推翻：被取代的只有渲染段——`showsProjectActivity` 的两来源并集、归档口径、`expanded` / `leaderRunning` 边界仍在 `src/client/project-panel-logic.js:140` 跑，`project-section.js:742` 接着它，两篇 implemented 笔记也仍把它当现行读数来源。它现在在 `implemented/feature/`，取代指针收窄到渲染段。**判据要按「还有没有别的决策在跑」逐节核，不能按「最新一轮改了什么」判。**

### 笔记间链接可达进机械门禁

迁移让 46 处笔记间相对链接与 9 处 `docs/` 引用全部失效，靠手改必然漏。`checkLinks` 把「链接目标必须存在」变成门禁的一部分：路径解析交给调用方（它知道文件的绝对位置），`checkLinks` 只遍历与报错，保持纯函数可测。

这条门禁当场抓出 8 处早已断掉的链接（3 处 `../../docs/capability-gaps.md` 迁移后深度不足、`../development.md` 在旧结构下本就指向不存在的 `.agents/development.md`），一并修正。

### 围栏识别按 Markdown 实情：`~~~` 与缩进围栏都算

第一版只认行首的三反引号，两种围栏漏判：`~~~` 围栏里的 `## 决策` 被当成真节（只有围栏里有决策节时缺节误判通过，同名则误判重复），列表项里缩进两格的围栏里的示例链接被当真人链接误报。改成 `/^ {0,3}(```|~~~)/` 并按围栏字符配对——三反引号块里出现的波浪线只是示例内容。

### 接线要有护栏

语料用例原来自己复制了一份「读盘 + 判定 + 报错」的编排，所以把 verifier 里的 `checkLinks` 调用删掉，16 条用例照旧全绿：门禁的接线断了没人知道。现在拆成 `agent-note-audit.mjs` 的 `auditNotes(dir)`（读盘、遍历、拼违规项）与 `verify-agent-note-format.mjs`（报数、退出码），语料用例造临时语料跑 `auditNotes`，接线一断就红。

### 不引入强制的 `## 备选方案` 节

宿主强制 `## Alternatives considered`。本仓 72 篇都要补写才能过门禁，而这些备选必须来自真实回忆——集体补写必然产生编造。现有 `## 边界` 已承载"放弃了什么"。不做，需要时另开任务。

## 边界

- **`proposed/` / `rejected/` / `archived/` 目前都为空**：门禁接受这三个 lifecycle、也校验各自的必需节（无文件时按空集合规），但没有真实文件跑过。归档判据现在还只是口径——唯一的候选被审查推翻后，`archived/` 一篇都没有。
- **archived 没有冻结**：有人改了归档笔记的历史事实，门禁不会红。靠 `docs/` 与 README 的口径约束。
- **链接门禁只覆盖 `.md` 目标**：指向目录或图片的链接不判，指向 `notes/` 之外的链接按真实文件系统判（`../../AGENTS.md` 这类相对仓根的路径也校验）。
- **文件名日期仍是首次提出那天**：迁移不重命名文件，所以 lifecycle 变化时日期不动，跨 lifecycle 的时间线要靠 git 或正文里写的日期。
- **类目边界有主观余地**：`feature` 与 `bug-fix` 在"用户报了问题、修法带新交互"时重合。口径以 README 的判别线为准，本次归属按"用户报的可见缺陷记为 bug-fix"统一。
- **抬了两个文档天花板**：`docs/architecture.md` 5400 → 5600（本轮先抬到 5450，合并 main 的 #100 / #101 后只剩 2.37% 余量，再按 5% 重算）、`docs/development.md` 2550 → 2660。迁移让 13 处 `docs/` 里的笔记链接变长（多两段目录），`development.md` 的余量在 main 上 #99 加内容后就已经贴线。按规则留 5%，没有为凑数新增内容。

## 验证

- `tests/agent-note-format.test.js` 22 例全过（原 9 例）。判定分两层：纯判定在 `scripts/agent-note-format.mjs`，读盘遍历在 `scripts/agent-note-audit.mjs`，`verify-agent-note-format.mjs` 只剩报数与退出码。
- 双向验证（逐条实测读数）：
  - 撤掉 `auditNotes` 里的 `checkLinks` 调用 → 1 例红（「语料里有断链就报」）。
  - 撤掉整层判定（`checkNote` + `checkLinks` 都不调）→ 2 例红（断链 + 缺节各一条）。
  - 围栏识别回退成只认三反引号 → 4 例红（波浪线围栏的 `#`、只有围栏里的决策节算缺节、围栏里的同名节不算重复、缩进围栏里的链接示例）。
  - 撤掉路径三段判定 → 「路径必须是」用例变红。
- 迁移后 `npm run check` 的格式门禁读数为 75 篇（implemented 75，`archived/` 空）；合并 main（#100 / #101）后 PR 共 88 个文件。
- `node --test tests/*.test.js` 全绿；`npm run check` 全绿（1032 例、1015 pass / 17 skip）。
- 迁移用 `git mv`，`git status` 全部识别为 rename；正文只动链接行与 `**状态**` 行（38 篇）与被推翻段的指针。
