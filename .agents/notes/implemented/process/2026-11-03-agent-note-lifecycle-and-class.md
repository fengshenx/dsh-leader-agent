# Agent Note 双轴：lifecycle × class

## 背景

`.agents/notes/` 此前是扁平的：72 篇 `.md` 直接堆在目录下，路径不含任何状态或类型信息。门禁（`scripts/agent-note-format.mjs`）只判四件事——文件名日期形状、唯一 H1、首节 `## 背景`、有 `## 决策`。

这带来两个具体问题：

- **分不出"这篇还需不需要读"**。仓里已经出现了被作废的记录：`2026-11-02-project-activity-indicator.md` 的整篇决策被 StateDot 取代，`2026-10-23-dispatch-and-wakeup.md`、`2026-10-27-board-card-visual-and-interaction.md`、`2026-11-02-project-tree-session-selected.md`、`2026-10-29-drop-project-tools-and-card-checkpoint.md` 则是部分被推翻。它们和仍然有效的笔记在同一层，只能靠打开文件读正文里的「已被…取代」才认得出。
- **分不出改动的性质**。想找"这条笔记是修 bug 还是改架构"，只能靠标题猜。

宿主 dsh 早就是双轴：`{lifecycle}/{class}/yyyy-mm-dd-slug.md`，lifecycle 有 `proposed` / `implemented` / `rejected` / `archived`，class 有 `feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`。

## 决策

### 路径编码双轴，两个轴都是闭集

`.agents/notes/{lifecycle}/{class}/{文件名}`。门禁校验路径恰好三段、两段取值都在闭集内。类目口径写在 `.agents/notes/README.md`（一个事实一处归属，`AGENTS.md` 只留一句断言加链接）。

关键判别线：**改运行时行为 → feature / bug-fix / simplification / architecture；改围绕代码的工具与流程 → process / testing；删代码删行为 → simplification；在某个平台上不工作 → bug-fix。**

### 不写 `Status:` 行

宿主每个文件头写 `Status: implemented` 并与目录交叉校验。本仓不写：路径已经是状态的唯一来源，单语种仓库没有 `.zh.md` 对照需求，双写只会多出一处必须同步、又能被门禁拦下的不一致来源。

代价是本次顺手删掉了三篇新笔记里已有的 `**状态**：implemented` / `**状态**：accepted` 行——`accepted` 根本不在闭集里，留着就是与新规则直接冲突的第二处状态。

### 骨架按 lifecycle 分档

| lifecycle | 必需节 |
|---|---|
| `implemented` / `archived` | `## 背景` + `## 决策` |
| `proposed` | `## 背景` + `## 提案` + `## 验收标准` |
| `rejected` | `## 背景` + `## 提案` + `## 否决理由` |

`archived` 沿用 implemented 的骨架：进 archived 的文件原本都是 implemented，归档只移动路径、不改正文。

### archived 只作历史，不引入冻结清单

宿主的 `archived/manifest.json` 记内容 hash、禁止任何改动，那是给 900+ 篇历史记录防篡改用的。本仓 72 篇的规模负担不起这份维护成本，门槛降到：archived 不再指导当前行为、不再修改。

归档判据也据此收紧：**整篇决策都不再指导未来工作才进 archived**，部分被取代的留在 `implemented` 并加一行 `> **已被 [标题](…) 取代**：…` 指针。本次只有 `2026-11-02-project-activity-indicator` 满足——它的全部决策（自绘 spinner 的类名、`currentColor`、关键帧）都被 StateDot 方案取代，其余部分是交互约束。

### 笔记间链接可达进机械门禁

迁移让 46 处笔记间相对链接与 9 处 `docs/` 引用全部失效，靠手改必然漏。`checkLinks` 把「链接目标必须存在」变成门禁的一部分：路径解析交给调用方（它知道文件的绝对位置），`checkLinks` 只遍历与报错，保持纯函数可测。

这条门禁当场抓出 8 处早已断掉的链接（3 处 `../../docs/capability-gaps.md` 迁移后深度不足、`../development.md` 在旧结构下本就指向不存在的 `.agents/development.md`），一并修正。

### 不引入强制的 `## 备选方案` 节

宿主强制 `## Alternatives considered`。本仓 72 篇都要补写才能过门禁，而这些备选必须来自真实回忆——集体补写必然产生编造。现有 `## 边界` 已承载"放弃了什么"。不做，需要时另开任务。

## 边界

- **`proposed/` 与 `rejected/` 目前为空**：门禁接受这两个 lifecycle、也校验各自的必需节（无文件时按空集合规），但没有真实文件跑过。写第一篇时才知道规则是否顺手。
- **archived 没有冻结**：有人改了归档笔记的历史事实，门禁不会红。靠 `docs/` 与 README 的口径约束。
- **链接门禁只覆盖 `.md` 目标**：指向目录或图片的链接不判，指向 `notes/` 之外的链接按真实文件系统判（`../../AGENTS.md` 这类相对仓根的路径也校验）。
- **文件名日期仍是首次提出那天**：迁移不重命名文件，所以 lifecycle 变化时日期不动，跨 lifecycle 的时间线要靠 git 或正文里写的日期。
- **类目边界有主观余地**：`feature` 与 `bug-fix` 在"用户报了问题、修法带新交互"时重合。口径以 README 的判别线为准，本次归属按"用户报的可见缺陷记为 bug-fix"统一。
- **抬了两个文档天花板**：`docs/architecture.md` 5400 → 5450、`docs/development.md` 2550 → 2660。迁移让 13 处 `docs/` 里的笔记链接变长（多两段目录），两处余量跌破 5%（3.9% / 0.8%，后者是 main 上 #99 加内容后就已经贴线）。按规则重算到留 5%，没有新增内容。

## 验证

- `tests/agent-note-format.test.js` 16 例全过（原 9 例，新增 7 例：路径三段、lifecycle 闭集、class 闭集、proposed/rejected 必需节、链接可达、外链与锚点跳过、围栏内链接示例不算）。仓库现有笔记用例改为递归并带链接校验。
- 迁移后 `npm run check` 的格式门禁读数为 72 篇（implemented 71 / archived 1）。
- 双向验证：撤掉 `checkLinks` 调用 → 链接用例变红（`链接目标不存在` 断言失败）；恢复后全绿。撤掉路径三段判定 → 「路径必须是」用例变红。
- `node --test tests/*.test.js` 1053 例（1036 pass / 17 skip）、`npm run check` 全绿。
- 迁移用 `git mv`，`git status` 全部识别为 rename；正文只改链接行与删掉的三行 `**状态**`。
