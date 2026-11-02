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

## 边界

- 项目收起时不自动展开到当前 worker 行。展开状态归用户，自动展开会在每次切会话时重排左栏。
- 键盘可达性没变：`SessionRow` 仍是 `div`，没有 `tabIndex`，Tab 键到不了。这是既有缺口，不在本次范围。
- hover 时行首文件夹被换成展开箭头（既有行为），此时看不到文件夹的激活色；箭头不跟着亮——照宿主的做法，激活色只落在文件夹上。
- `isProjectCurrent()` 对退役协调者与归档会话的既有判据不变，相关用例原样保留。
- 当前会话若是项目工作区里用户手动开的会话（不属于项目），两层都不亮，与之前一致。

## 验证

- 单测：新增「整行选中态只给协调者会话」，覆盖协调者 / worker / 别的会话 / 空值与 `undefined` / 项目不存在 / 归档协调者。`tests/project-panel.test.js` 45 pass。
- 双向验证：临时删掉 `isCoordinatorCurrent()` 里的协调者判据（`project?.coordinatorSessionId !== currentSessionId`）→ 新用例变红（1 fail），还原 → 45 pass。
- 会话行的接线守卫：仓里没有 jsdom，`SessionRow` 渲染不出可断言的元素，所以「当前会话 → `data-selected` / `aria-current`」这条链只能读 `src/client/project-section.js` 源码断言（同 `tests/board-styles.test.js` 读样式表的做法）：`ProjectRow` 传 `selected: row.id === currentSessionId`，`SessionRow` 把它映射到两个属性。双向验证：删掉传入 `selected` 那一行 → 1 fail；删掉 `SessionRow` 里的 `data-selected` → 1 fail；还原 → 45 pass。旧口径下这两处都能静默通过（44 pass）。
- `npm run check`：786 tests / 777 pass / 9 skipped / 0 fail。
- `npm run build:client` 重建产物，`lib/client.js` 里 `data-selected` 4 处命中（项目行、会话行与两处样式选择器）。
- 真机（隔离 dev 实例，`DSH_HOME` 在 `.dev/home`，端口 4321；项目与 worker 登记用 seed 写入 `dsh-leader-kit/projects.json` / `workers.json`，会话目录从既有会话复制；无头 Chrome 1440×940 走 CDP 读 `data-*` 与 `getComputedStyle`，console error 计数 0）：

  | 场景 | 修复前 | 修复后 |
  |---|---|---|
  | 打开 worker 会话 | 项目行 `data-selected=true`、整行背景 `rgba(38, 49, 72, 0.06)`；会话行无标记、底色透明 | 项目行 `data-selected=null`、`data-active=true`、文件夹 `rgb(65, 118, 230)`；会话行 `data-selected=true`、`aria-current=page`、整行背景 `rgba(38, 49, 72, 0.06)` |
  | 打开协调者会话 | 项目行整行亮；会话行无标记 | 项目行整行亮（`data-selected=true`）；会话行无标记 |
  | 主区域是 worker 会话（页面重载后恢复） | 项目行整行亮、会话行无标记 | 项目行文件夹亮、会话行整行亮——两层同时可读，不再是「选了两个整行」 |

  「修复前」读数用「把 `selected` 换回 `isProjectCurrent()` 且会话行传 `selected: false` → 等 watch 重建 → 重跑探针」取得，还原后重读回到上表右列。
