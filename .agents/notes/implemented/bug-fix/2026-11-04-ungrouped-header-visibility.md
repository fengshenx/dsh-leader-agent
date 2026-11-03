# 未分组可见性改按会话快照算，项目目录失效时不再藏会话

## 背景

三条用户报告连着同一条链路：删掉工作区或项目目录后，会话「消失」，插件卸载后回到「未分组」。

定位落在两处。**排除集这条站得住**：`collectExcludedSessionIds` 无条件把项目会话排除掉，不看项目目录还在不在。目录删掉后项目行打不开（`assertUsableDirectory` 拦截），项目树里也没有 leader 的行，那些会话在两棵树里都不可达。

渲染层那条的初版诊断**没有复现出来**。初版说「宿主把未分组组头与会话行渲染在两个不同的 `groupSection` 里，组头那个 section 只有组头一个子元素，于是判空恒真」——实测（`0.2.1-rc.2`，默认视图，组内 1 条与 6 条含折叠两种状态）组头与会话行在**同一个** `groupSection` 里，组头在前、行在后，`header.parentElement` 里就能查到行；宿主 JSX（`dsh-client-ui-workspace/lib/client.js:3196-3240`）也是同一结构。旧判据在这种状态下判得准，不成立「无条件藏组头」。

旧判据真正会藏错的形态是「组内的行全被插件自己的排除集隐藏」：判据只能看到一排带隐藏类的行，得出「组里没内容」，连组头一起藏。项目目录失效后仍然排除它的会话，正好落进这个形态——**这条和排除集那条是同一个根因的两面**，修好排除集，组头随之恢复。

所以 `ungroupedVisibleCount` 按**防御性判据**保留：DOM 判据只在行已渲染时准，快照滞后时会误藏；但不能把它写成「复现出来的原诊断」。

## 决策

### 可见性判据：DOM 兜底 + 会话快照，三条都空才藏

`project-panel.js` 用 `sessionRows` + `workspaceItems` + `excluded` + `archivedSessionIds` + `currentSessionId` 算出 `ungroupedVisibleCount`，经 `exclusion.update` 传给渲染层。`markUngroupedHeader` 的判据是三条的交集：

1. DOM 里没有可见会话行（快照滞后时按渲染结果兜底）；
2. 没有可见的「展开其余 N 个会话」（数据层还有没渲染的行）；
3. 快照上未被排除的未分组会话数为 0（行还没画出来时按数据层兜底）。

`visibleCount` 缺省（调用方漏传）时**不当成 0**，只走前两条——否则任何新调用方漏传都会静默回退成「无条件藏」。三条各自堵一个误伤面，藏错组头的代价是整组看不见，留个空组头只是多点一下。

口径照宿主 `sessionVisible`：不在任何工作区、`origin !== 'subagent'`、未归档、不是「非当前的空会话」。`ungroupedExcludedCount` 与新的 `ungroupedVisibleCount` 共用 `ungroupedSessionIds`，两个数必须同源，否则折叠按钮的修正与组头的显隐会对不上。

### 项目目录失效时放行它的会话

项目服务层新增 `isDirectoryUsable`（`stat` 判存在且是目录，失败返回 `false` 而不抛），`summarizeProject` 与 `list` 多带一个 `directoryUsable`；客户端的 `collectExcludedSessionIds` 先按 `directoryUsable !== false` 过滤出「还能打开的项目」，只排除这些项目的 leader 与 worker。用 `!== false` 判是为了旧版宿主不带这个字段时保持原行为。

### 不做的

不在渲染层复刻宿主的会话生命周期（子代理、归档、空会话）——那是把自己绑到宿主的会话模型上，一份口径漂移就错一次。只在快照上算一次，跟着宿主升级对齐。

## 边界

- 快照计数依赖 `project-panel` 拿到的 `sessionRows` 与 `workspaceItems` 是不是最新的；宿主缓存旧值时组头会短暂按旧值显隐，下一帧纠正。DOM 兜底就是为这个窗口留的。
- 归档视图下组头显隐可能与组内内容不一致：宿主有三种归档筛选，插件只按「默认排除归档」算，`workspaces.list.getSnapshot()` 不暴露当前 filter。
- `directoryUsable` 是 `stat` 的结果：目录挂慢速卷上时列表晚一拍；`ENOENT` 与 `EACCES` 一律当「不可用」，方向安全（多显示），代价是目录临时不可读时左栏会同时出现项目行与未分组里的同一个 leader。
- 会话能否「落到未分组」仍由宿主决定：删工作区只删注册，会话记录保留；本仓只管别把它们藏掉。
- 与 #102 的先后：本笔记落在 `.agents/notes/` 根层，#102 正在迁到 `{lifecycle}/{class}/` 并加路径门禁。**建议 #102 先合**——门禁先落地，#105 再 rebase 时把这篇挪到 `implemented/bug-fix/`，#102 已经给 #101 做过同样的 rebase；反过来则要再补一次搬运。

## 验证

- 单测：`tests/workspace-exclusion.test.js` 34 条（新增四条判据形态：快照 0 但 DOM 有可见行、调用方漏传计数、快照说还有会话但 DOM 没画、排除器 `update`/`dispose` 的标记与清理）、`tests/project-panel.test.js` 46 条、`tests/projects-service.test.js` 52 条。`npm run check`：1033 用例通过（17 跳过）、71 个源文件里 55 个被加载、48 个行覆盖 100%、16 个登记不可加载。
- `src/client/workspace-exclusion.js` 行覆盖从 85.34% 补到 **100%**（分支 85.83%、函数 96.77%），因此从 `coverage-manifest.json` 的 `thresholds` 里摘掉，回到「未登记即要求 100%」的默认口径，不再贴 85 的线。
- e2e 两条，各证明一条路径（见文件头注释）：删工作区那条在旧实现下也绿，守的是「删工作区别把会话一起带走」；删项目目录那条是 `directoryUsable` 修复的回归用例。单跑 3.1s + 3.8s。
- 双向验证（三次，都实测）：
  - 判据退回「只看快照」→ 三条用例红（快照 0 但 DOM 有行、漏传计数、有展开按钮），还原 34 绿；
  - 判据退回「只看 DOM」（撤数据层那条）→ 一条红（快照说还有会话但 DOM 没画），还原 34 绿；
  - **e2e 撤修复**：把 `collectExcludedSessionIds` 的 `directoryUsable` 过滤撤成恒真（等于 main 的行为）+ `npm run build:client` → 「删项目目录后组头恢复」超时变红（最后一次观察 `false`），还原并重建后两条全绿。这一条是复审要求的「精确回退到 main 实现」。
- 手工结构探针（rc.2，删工作区后）：`div.<hash>_groupSection` 共 1 个，组头 `parentElement` 的 children 是组头 + 1 个会话行 span，`querySelectorAll('[data-row-key^="session:"]')` 查到 1 行且未被隐藏——初版「两个 section、判空恒真」的诊断与实测不符。
- 走过的弯路：初版 e2e 手改 `workspace.json` 摘会话，宿主不会因此把它渲染成松散行；第二版删目录用例在启动即有会话的实例上等 `[data-row-key="workspace:"]`，那个组头根本不存在（没有 stray 会话），30 秒超时——现在先删工作区造出未分组，再登记项目。
- 未验证：Windows 上 `stat` 对目录符号链接的行为（本机 macOS）；宿主版本 > rc.2 下未分组组头的 DOM 结构（只验了 `engines.dsh` 下限 rc.2）。
