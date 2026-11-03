# 项目树里被打开的 worker 会话有自己的选中态

2026-11-02。

## 背景

左栏项目树里点开一个 worker 会话，主区域切过去了，但左栏看起来「焦点还停在项目上」：项目行整行铺着底色，被点的那条会话行没有任何标记。

原因是选中态只有一层。项目行的 `data-selected` 由 `isProjectCurrent()` 判定，而它把「当前会话是本项目下的 worker」也算进来（`src/client/project-panel-logic.js`），渲染成整行 hover 底色；`SessionRow` 则只有 hover 态，没有任何「当前会话」判据与样式。于是点开 worker 后，唯一亮着的就是项目行，会话行与列表里其他行长得一样。

宿主自己的工作区树不是这么分的：工作区分组的文件夹图标用 `folderActive`（`--dsw-alias-state-business-primary`）点亮，会话行用 `.sessionRow.selected` 铺整行底色（`packages/client/ui-workspace/src/client/rows/Rows.module.css`）。项目树只实现了第一层的语义，丢了第二层。

## 决策

### 选中态分两层，照宿主工作区树

- **整行底色只给协调者会话**：新增 `isCoordinatorCurrent(project, currentSessionId, archivedSessionIds)`——当前会话是现任协调者且未归档。协调者在项目树下不单独出行，项目行就是它的入口，这条底色是唯一的位置回执。
- **项目行的「组内有当前会话」降为文件夹点亮**：`isProjectCurrent()` 的判据不变，用途从整行底色改成给行首文件夹上色（`data-active`）。worker 会话被打开时，项目行只亮图标。
- **会话行新增 `data-selected` / `aria-current="page"`**：当前会话等于行 id 时铺与 hover 同款的整行底色。

### 为什么不让两行都铺整行底色

两层层级不同。整行底色的语义是「你现在看的就是这一行」，而被打开的 worker 是项目下另一行——两层同时铺色会看成选了两个，分不清哪一行是主区域的正主。宿主的分层（分组亮图标、会话亮整行）已经把这个语义定死了。

### 为什么保留项目行的激活态

会话行可能被水位折叠（默认只露 5 条）或项目本身是收起的：这时唯一能说明「你正在看的是这一组」的就是文件夹图标。去掉它，折叠态下左栏完全没有位置回执。

### 协调者运行中：行首目录图标换成加载圈

项目行的行首槽位原本固定画目录图标。协调者跑起来时这个位置换成加载圈（新增 `isCoordinatorRunning(project, sessionRows)` 读当前协调者会话行的 `running`；归档口径由 #64 合成时补成第三个参数）。

理由与上一节相同：协调者在项目树下不单独出行，项目收起或 worker 行被水位折叠时，行首是唯一能看出「它还在干活」的位置。只认现任协调者——worker 在跑不影响项目行，它们各自的行上有自己的加载圈。

加载圈画在 `.dsh-leader-kit-project-lead-folder` 槽位**内部**，不替换容器：组内有当前会话的激活色挂在容器的 `color` 上（`project-section.js` 的 `[data-active='true'] .dsh-leader-kit-project-lead-folder`），容器一被顶掉，收起态下的活动提示与「本组有当前会话」就丢了同一处承载。边框因此写 `currentColor`（与目录图标的 `stroke: currentColor` 同源），不写死 `label-tertiary`；加载圈本身是装饰，挂 `aria-hidden="true"`。

> **已被 [2026-11-03 加载圈改用宿主 StateDot](../bug-fix/2026-11-03-spinner-aligned-with-host-state-dot.md) 取代**：加载圈现在是宿主基线模块的 `StateDot`（`state: 'ongoing'`），颜色固定 `label-tertiary`，不再用 `currentColor`；「画在槽位内部、hover 让位」这两条仍然成立。

hover 时整个槽位让位给展开箭头（既有规则对容器生效），加载圈跟着一起收起来，移开指针就回来。

### 与 #64 的合成：行首活动提示分两种来源

#64 在项目收起且名下有 worker 在跑时也把行首换成加载圈。两块不是重复：

- 协调者在项目树下**没有自己的行**，所以它跑起来时行首必须换，展开态也一样；
- worker **有自己的行**，收起态行首代显，展开后由各自的会话行带加载圈，行首回到目录图标。

合成公式（合并顺序定为先 #74、后 #64，合成落在 #64 侧）：

```js
leadActivity = showsProjectActivity({
  expanded,
  rows: childSessions,
  coordinatorRunning: isCoordinatorRunning(project, sessionRows, archivedSessionIds),
})
```

本 PR 只落地前半句；#64 rebase 时把两半并进 `showsProjectActivity` 一个判定，`data-running` 属性与 `lead-spinner` 类随之删除（统一成 `.dsh-leader-kit-project-spinner`）。合成后的取舍、归档口径与验证读数见 [2026-11-02-project-activity-indicator.md](2026-11-02-project-activity-indicator.md)。

## 边界

- 项目收起时不自动展开到当前 worker 行。展开状态归用户，自动展开会在每次切会话时重排左栏。
- 键盘可达性没变：`SessionRow` 仍是 `div`，没有 `tabIndex`，Tab 键到不了。这是既有缺口，不在本次范围。
- hover 时行首文件夹被换成展开箭头（既有行为），此时看不到文件夹的激活色；箭头不跟着亮——照宿主的做法，激活色只落在文件夹上。
- `isProjectCurrent()` 对退役协调者与归档会话的既有判据不变，相关用例原样保留。
- 当前会话若是项目工作区里用户手动开的会话（不属于项目），两层都不亮，与之前一致。
- 运行态读会话行的 `running`：会话列表还没同步回来、或协调者会话已不在索引里时按未运行处理，下一帧订阅刷新会补上。项目行不自己轮询宿主。

## 验证

- 单测：新增「整行选中态只给协调者会话」，覆盖协调者 / worker / 别的会话 / 空值与 `undefined` / 项目不存在 / 归档协调者；新增「协调者在运行时项目行显示运行态」，覆盖协调者运行 / 未运行 / worker 在跑 / 会话表缺失 / 项目没有协调者。`tests/project-panel.test.js` 47 pass。
- 双向验证：临时删掉 `isCoordinatorCurrent()` 里的协调者判据（`project?.coordinatorSessionId !== currentSessionId`）→ 对应新用例变红（1 fail）；把 `isCoordinatorRunning()` 改成「任一 worker 在跑都算」→ 运行态用例变红（1 fail）；删掉项目行的运行态渲染分支 → 接线守卫变红（1 fail）；把加载圈改回「替代槽位容器」的结构 → 1 fail；把边框写回 `--dsw-alias-label-tertiary` → 1 fail；删掉 `aria-hidden` → 1 fail；还原 → 47 pass。
- 会话行的接线守卫：仓里没有 jsdom，`SessionRow` 渲染不出可断言的元素，所以「当前会话 → `data-selected` / `aria-current`」这条链只能读 `src/client/project-section.js` 源码断言（同 `tests/board-styles.test.js` 读样式表的做法）：`ProjectRow` 传 `selected: row.id === currentSessionId`，`SessionRow` 把它映射到两个属性。双向验证：删掉传入 `selected` 那一行 → 1 fail；删掉 `SessionRow` 里的 `data-selected` → 1 fail；还原 → 47 pass。旧口径下这两处都能静默通过（44 pass）。运行态的接线（`leadActivity` → spinner → 样式与 hover 让位）走同一种源码断言，合成后的实现与验证读数见 [2026-11-02-project-activity-indicator.md](2026-11-02-project-activity-indicator.md)。
- `npm run check`：788 tests / 779 pass / 9 skipped / 0 fail。
- `npm run build:client` 重建产物，`lib/client.js` 里 `data-selected` 4 处命中（项目行、会话行与两处样式选择器），`project-lead-spinner` 2 处命中（样式选择器与组件类名各一；类名在 #64 合成时统一成 `project-spinner`）。
- 真机（隔离 dev 实例，`DSH_HOME` 在 `.dev/home`，端口 4321；项目与 worker 登记用 seed 写入 `dsh-leader-kit/projects.json` / `workers.json`，会话目录从既有会话复制；无头 Chrome 1440×940 走 CDP 读 `data-*` 与 `getComputedStyle`，console error 计数 0）：

  | 场景 | 修复前 | 修复后 |
  |---|---|---|
  | 打开 worker 会话 | 项目行 `data-selected=true`、整行背景 `rgba(38, 49, 72, 0.06)`；会话行无标记、底色透明 | 项目行 `data-selected=null`、`data-active=true`、文件夹 `rgb(65, 118, 230)`；会话行 `data-selected=true`、`aria-current=page`、整行背景 `rgba(38, 49, 72, 0.06)` |
  | 打开协调者会话 | 项目行整行亮；会话行无标记 | 项目行整行亮（`data-selected=true`）；会话行无标记 |
  | 主区域是 worker 会话（页面重载后恢复） | 项目行整行亮、会话行无标记 | 项目行文件夹亮、会话行整行亮——两层同时可读，不再是「选了两个整行」 |

  「修复前」读数用「把 `selected` 换回 `isProjectCurrent()` 且会话行传 `selected: false` → 等 watch 重建 → 重跑探针」取得，还原后重读回到上表右列。

- 运行态的呈现用样式注入核验（隔离实例没挂 mock provider，真实「协调者正在跑」要调付费模型，不做）：页面内联本文件的真实 `STYLE_TEXT`，无头 Chrome 1440×940 走 CDP 读计算样式，对照「加载圈在槽位容器内」与「加载圈替代槽位容器」两种结构化名：

  | 结构 | 容器存在 | 加载圈在容器内 | 加载圈边框色 | 容器 `color` |
  |---|---|---|---|---|
  | 修复后 + `data-active=true` | 是 | 是 | `rgb(65, 118, 230)` | `rgb(65, 118, 230)` |
  | 修复前（替代容器）+ `data-active=true` | 否 | 否 | `rgb(120, 130, 150)` | 无 |
  | 修复后、非激活 | 是 | 是 | `rgb(120, 130, 150)` | `rgb(120, 130, 150)` |

  三者行高都是 34px（槽位没被撑开）、`width/height=12px`、`animationName=dsh-leader-kit-spin`、`border-top-color` 透明（旋转缺口）。修复前那一行就是审查实测的激活色丢失：容器被顶掉后边框落回写死的 tertiary，与图标的 `rgb(65, 118, 230)` 不一致。真实运行态下的切换依赖的是同一条渲染分支与会话行的 `running` 订阅（`ProjectPanel` 的 `sessions.list.subscribe`），这条订阅链在选中态的真机读数里已经跑通。这段读数对应已删除的自绘实现，现实现见 [2026-11-03](../bug-fix/2026-11-03-spinner-aligned-with-host-state-dot.md)。
