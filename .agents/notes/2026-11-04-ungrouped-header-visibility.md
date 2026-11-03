# 未分组可见性改按会话快照算，项目目录失效时不再藏会话

## 背景

三条用户报告连着同一条链路：删掉工作区或项目目录后，会话「消失」，插件卸载后回到「未分组」。

定位落在两处。第一处是渲染层：`markUngroupedHeader` 原本按 DOM 判空——从「未分组」组头出发，找它所在 `groupSection` 里的会话行，全被隐藏且没有可见的展开按钮时，给组头加隐藏类。真实数据副本实测发现宿主的未分组组头与会话行**分属两个 `groupSection`**：组头那个 section 只有组头一个子元素，于是查询恒为空，判空恒成立，组头被无条件藏掉。用户看到的「未分组整组消失」就是这个。

第二处是排除集：`collectExcludedSessionIds` 无条件把项目会话排除掉，不看项目目录还在不在。目录删掉后项目行打不开（`assertUsableDirectory` 拦截），项目树里也没有 leader 的行，那些会话在两棵树里都不可达。

## 决策

### 可见性判据搬到会话快照

`project-panel.js` 用 `sessionRows` + `workspaceItems` + `excluded` + `archivedSessionIds` + `currentSessionId` 算出 `ungroupedVisibleCount`，经 `exclusion.update` 传给渲染层；`markUngroupedHeader` 只看 `visibleCount === 0 && !anyVisibleOverflow`。

口径照宿主 `sessionVisible`：不在任何工作区、`origin !== 'subagent'`、未归档、不是「非当前的空会话」。`ungroupedExcludedCount` 与新的 `ungroupedVisibleCount` 共用 `ungroupedSessionIds`，两个数必须同源，否则折叠按钮的修正与组头的显隐会对不上。

保留「有可见的展开按钮就不藏」：宁可留一个空组头，也不误伤用户自己的会话。

### 项目目录失效时放行它的会话

项目服务层新增 `isDirectoryUsable`（`stat` 判存在且是目录，失败返回 `false` 而不抛），`summarizeProject` 与 `list` 多带一个 `directoryUsable`；客户端先用 `depth === 0 && directoryUsable !== false` 过滤出「还能打开的项目」，只排除这些项目的会话。用 `!== false` 判是为了旧版宿主不带这个字段时保持原行为。

### 不做的

不在渲染层复刻宿主的会话生命周期（子代理、归档、空会话）——那是把自己绑到宿主的会话模型上，一份口径漂移就错一次。只在快照上算一次，跟着宿主升级对齐。

## 边界

- 快照计数依赖 `project-panel` 拿到的 `sessionRows` 与 `workspaceItems` 是不是最新的；宿主缓存旧值时组头会短暂按旧值显隐，下一帧纠正。
- `directoryUsable` 是 `stat` 的结果，项目目录挂载在慢速卷上时列表会晚一拍。
- 会话能否「落到未分组」仍由宿主决定：删工作区只删注册，会话记录保留；本仓只管别把它们藏掉。

## 验证

- 单测：`tests/workspace-exclusion.test.js` 30 条（新增「未分组可见数只数没被排除的会话」「未分组只剩被排除的会话时可见数为 0」）、`tests/project-panel.test.js` 46 条（新增「项目目录不可用时不排除它的会话」，含旧版宿主无字段的退回用例）、`tests/projects-service.test.js` 52 条（新增 `directoryUsable` 标注）。`npm run check`：1029 用例通过、17 跳过，71 个源文件里 55 个被加载、47 个行覆盖 100%；`src/client/workspace-exclusion.js` 从 84% 抬到 85%（实际 85.34%）。
- e2e：`tests/e2e/ungrouped-header.e2e.js` 走界面删工作区造松散会话，断言真工作区组头消失、会话行仍在、未分组组头无 `dsh-leader-kit-empty-ungrouped` 类且 `display` 不是 `none`。单跑 3.1 秒，全量串行 5 条 24 秒全绿。
- 双向验证：把判据改回「只看展开按钮」（等价于旧的 DOM 判空恒为真）→ e2e 在「组里还有会话时不能把「未分组」组头藏掉」变红（`true !== false`）→ 还原 → 变绿。
- 真实数据副本探针：修复前未分组组头 `display: none` 且带 `dsh-leader-kit-empty-ungrouped`，修复后 `display: flex`、无该类；插件一个会话行都没藏，6 个会话行始终可见——问题一直是组头被藏，不是会话行被藏。
- 走过一次弯路并已修正：原 e2e 手改 `workspace.json` 的 `sessionIds` 摘会话，宿主并不因此把它渲染成松散行，断言目标根本不会出现，60 秒超时白烧；现在造状态一律走界面动作，断言前先 `count()` 并在失败信息里带 DOM 诊断。
