# 项目目录失效后，不再把它的会话排除出官方工作区树

## 背景

用户报告：删掉项目目录后，项目的会话「消失」，卸载插件才回到「未分组」。

初版把原因记成两处，实测只有一处成立。

**排除集这条站得住**：`collectExcludedSessionIds` 无条件排除项目会话——项目的 leader 与登记的 worker——完全不看项目目录还在不在。目录删掉后项目行打不开（打开前本仓的 `assertUsableDirectory` 会拦），项目树里也没有 leader 的行，那些会话在两棵树里都不可达。

**组头判据那条复现不出来**。初版说「宿主把「未分组」组头与会话行渲染在两个不同的 `groupSection` 里，组头那个 section 只有组头一个子元素，判空恒真」。实测（`0.2.1-rc.2`，默认视图，组内 1 条与 6 条含折叠两种状态）组头 `div[data-row-key="workspace:"]` 与会话行在**同一个** `groupSection` 里，组头在前、行在后，`header.parentElement` 里就查得到行；宿主 JSX（`dsh-client-ui-workspace/lib/client.js:3196-3240`）同样是这个结构。旧判据在这种状态下判得准，不存在「无条件藏组头」。

旧判据唯一会藏错的形态是「组内的行全被本仓的排除集隐藏」：判据看到一排带隐藏类的行，得出「组里没内容」，连组头一起藏。项目目录失效后仍然排除它的会话，正好落进这个形态——**它和排除集那条是同一个根因的表象**，修好排除集，组头跟着恢复。

main 的 `089b5a6`（#101 项目与 dsh 工作区解耦）已经给 `markUngroupedHeader` 加过「组内还有可见的『展开其余 N 个会话』就不藏」的兜底，方向是宁可留一个空组头也不误伤用户自己的会话。本 PR 不再碰这个判据。

## 决策

### 项目目录失效时放行它的会话

项目服务层新增 `isDirectoryUsable`（`stat` 判存在且是目录，失败返回 `false` 而不抛），`summarizeProject` 与 `list` 多带一个 `directoryUsable`；客户端 `collectExcludedSessionIds` 先按 `directoryUsable !== false` 过滤出「还能打开的项目」，只排除这些项目的 leader 与 worker。用 `!== false` 而不是 `=== true`，是为了旧版摘要不带这个字段时保持原行为（仍排除）——退回语义由 `tests/project-panel.test.js` 的旧字段用例钉住。

### 不再改「未分组」组头判据

组头与会话行同 section 已实测，错藏形态的根因在排除集；#101 的 overflow 兜底又把误伤方向收到只剩「快照滞后、行还没画出来」这一理论边界。再叠一套快照计数判据会和 main 抢同一个 class：两条判据各自算出的结论不一致时，最后写 class 的那条说了算，问题会以「有时藏有时不藏」的形式回来。组头的实测事实与结论记在 `docs/capability-gaps.md` 第 45 条。

### 不做的

不在渲染层复刻宿主的会话生命周期（子代理、归档、空会话）——那等于把会话模型搬进插件，宿主一升级就错一次。

## 边界

- `directoryUsable` 是 `stat` 的结果：慢卷上列表晚一拍；`ENOENT`、`EACCES` 与网络盘挂起一律当「不可用」，方向是降级成多显示而不是少显示，代价（目录临时不可读时左栏同时出现项目行与未分组里的同一个 leader）记在 [limitations](../../../../docs/limitations.md)。
- 项目行的失效态由 `leaderAlive` 决定（`isProjectOpenable`），与目录可用性无关：目录删掉后项目行照旧渲染、只是点开会失败。e2e 因此不拿 `data-dead` 断言目录。
- 会话能否「落到未分组」仍由宿主决定：删工作区只删注册，会话记录保留；本仓只管别把它们藏掉。
- 上一轮 dev 在这里叠加过的组头判据改动（`ungroupedVisibleCount` 三条交集、`markUngroupedHeader` 新判据、相关单测与 84 行覆盖门槛调整）已整体回退到 main，不进本 PR。

## 验证

- 单测：`tests/project-panel.test.js` 46 条（新增 `directoryUsable` 过滤与旧字段退回）、`tests/projects-service.test.js` 52 条（新增 `list` 标注目录可用性）、`tests/workspace-exclusion.test.js` 28 条（回退到 main 后由 main 的用例盖住组头判据）。`npm run check`：1044 用例通过（17 跳过），71 个源文件里 55 个被加载、47 个行覆盖 100%、16 个登记为单测不可加载。
- e2e：`tests/e2e/project-directory-gone.e2e.js`，单跑 4.0s 绿。造法走界面动作——发一条消息让会话非空且成为当前会话（宿主只渲染非空或当前会话的行，否则 `rowExists:false` 会让断言假绿），删工作区把它赶进「未分组」，登记项目指向一个临时目录；然后断言行被排除 → 删目录 + `focus` 触发刷新 → 行回到官方树里可见（`display !== 'none'` 且无隐藏类）、「未分组」组头未被藏、项目行仍在。
- 双向验证：把 `collectExcludedSessionIds` 的 `directoryUsable` 过滤撤成恒真（等于 main 的行为）+ `npm run build:client` → e2e 在「删目录后会话行回到官方树里可见」上 30 秒超时变红，最后一次观察 `false`；还原并重建后 4.0s 绿。
- 未验证：Windows 上 `stat` 对目录符号链接的行为（本机 macOS）；宿主 > rc.2 的未分组组头 DOM 结构（只验 `engines.dsh` 下限 rc.2）。
