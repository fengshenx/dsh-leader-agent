# 项目删除合并为一个入口

**范围**：`src/shared/projects.js`、`src/host/projects/service.js`、`src/host/projects/remote.js`、`src/client/project-panel.js`、`src/client/project-panel-logic.js`、`src/client/project-section.js`

## 背景

项目行的「更多」菜单原有两条破坏性入口：「从 dsh 移除工作区」（只删宿主工作区注册，项目保留）与「注销项目」（只删项目记录，工作区留在宿主里）。两者对象相反、都不完整：前者删完工作区，下次打开项目会自动重建，等于没删；后者删完项目，插件注册的工作区变成没人认领的孤儿——项目记录里的 `workspaceId` 随记录一起消失，菜单里也不再有任何入口能定位它。用户想让一个项目彻底消失，得连着点两次。

## 决策

**合成一条「删除」**：删项目记录 + 移除插件为它注册的工作区，复用 dsh 自己「删除工作区」的语义与措辞——文件夹与会话记录都保留，其会话显示在工作区树的「未分组」下。

- **顺序是先移除工作区、再删记录**：反过来时中途失败会留下一个谁都不记得的孤儿工作区（项目没了，入口也没了）。
- **只删插件自己注册的工作区**。`workspaceId` 只记插件建的那个（复用的用户工作区不记，见[项目作用域与角色槽位](../architecture/2026-10-23-project-scope-and-role-slots.md)），用户自己加的工作区不碰；没有 `workspaceId` 的项目只删记录。
- **宿主工作区服务不支持删除时仍然删项目**，把原因带回客户端并显示在提示里。这条退路等于旧的「注销项目」行为，用户仍可在官方工作区面板里手动删。
- **远程方法叫 `deleteProject`**，不叫 `remove`：`remove` 撞上的是 `RemoteNamespaceService.prototype.remove(kind, method, token)`（rc.2 的 `packages/api/gateway/src/client/index.ts:707`），整个命名空间会被拒收。**不是** Cordis 服务原型的成员——`'remove' in Service.prototype` 在 vendor/cordis 上实测为 false，照那个判断会得出相反结论（见 capability-gaps 第 28 条）。wire 契约里 `unregister` / `removeWorkspace` 一起删掉，本仓未发布，不保留旧方法。
- **二次确认**沿用 `confirm-dialog.js`，文案按项目有没有插件工作区分两支：有工作区才讲「从 dsh 工作区列表移除」与「未分组」，否则只讲删项目——不能让用户以为自己的工作区也被删了。
- **菜单里不留「打开协调者会话」**：点项目行本身就会打开协调者会话，菜单再放一个入口是重复；菜单只放行点击之外的动作。
- **「无需移除」与「移除失败」分开报**：宿主没有工作区服务、项目没有插件注册的工作区、工作区已不在宿主里，这三种都是 `skipped`，不是失败。第一版把三者都带上 `reason`，客户端按 `reason` 判失败，于是删掉一个复用用户工作区的项目后显示成「工作区未移除：该项目没有由插件注册的工作区」——正常删除被说成警告。现在 `service.removeWorkspace` 报 `skipped`、`remote.deleteProject` 透传但不带 `reason`、`describeDeletionNotice` 落到「文件夹与会话记录保留」那一支；`reason` 只留给真失败（宿主工作区服务不支持删除）。
- **重复删除按幂等成功收尾**：`deleteProject` 对不存在的项目返回 `notFound`，客户端关弹窗、刷新列表、只给一句「已删除项目」，不报「删除失败：项目不存在」——否则重复确认会让弹窗卡死，行也不消失。

## 边界

- **删除工作区会带走用户在它下面手工开的会话的归属**：宿主 `delete` 只删注册，会话日志保留，但那些会话与协调者一样落到「未分组」，官方 UI 里不再按目录分组。这是 dsh 自己的删除语义，用户明确要复用；旧设计之所以把删除拆成两步，正是为了不让这个破坏性后果随「注销项目」一起发生。
- **卡片不级联删除**：卡片仍留在库里，项目没了就无法再从看板进入它（看板按项目取卡）。与旧「注销项目」一致，删除不碰卡片是既有边界。
- **协调者会话保留**：它是用户的会话历史，删除项目只让它变回普通会话（排除集随项目列表消失，它重新出现在官方工作区树里）。
- **worker 常驻会话也不停**：`workerSessions.dispose` 与派工登记清理只在归档路径（`detachSession`）用，删除项目只动项目记录与工作区注册。项目删掉后 worker 仍在内存里跑、仍在写日志，而看板按项目取卡已经看不到它。合并成唯一入口后这个影响面比旧「注销项目」大。**是否连 worker 一起 dispose 是产品决策**：dispose 会直接掐掉正在执行的活，与「删项目不等于杀会话」的现有语义冲突，本轮不级联。

## 取证

- **单元测试**：`npm run check` 486 例全绿（合并 `origin/main` 后的基线 474）。新增/改写：菜单只有一条删除入口、删除说明的两支文案、删除成功提示的三支文案、重复删除按幂等收尾（`classifyDeletionResult`）、删除项目一并移除插件工作区、删除不碰复用的用户工作区、宿主没有工作区服务 / 工作区悬空 / 工作区被并发摘掉都报 `skipped`、宿主工作区服务不支持删除时带 `reason`、删除不存在的项目返回 `notFound`，以及 `tests/project-delete-notice.test.js` 里「真实 service → remote → 提示文案」的六条组合用例（三支 `skipped`、真失败、成功、项目不存在）。
- **双向验证**：撤掉 `service.remove` 里的 `removeWorkspace(id)` 调用 → 「删除项目一并移除插件注册的工作区」「删除项目不碰复用的用户工作区」变红，还原后全绿；把 `remove-workspace` 菜单项加回去 → 「项目菜单只有一条删除入口」变红，还原后全绿；把 `removeWorkspace` 的跳过分支改回带 `reason` → 7 例变红（3 条组合用例 + 4 条 service 用例），还原后全绿；删掉 `classifyDeletionResult` 的 `notFound` 分支 → 「重复删除按幂等成功收尾」变红；删掉 `remote.deleteProject` 的 `notFound` 字段 → 2 例变红。
- **真机取证（接口层）**：隔离 `DSH_HOME`（本工作树 `.dev/home`，`DEV_PORT=3291`）起 web 实例，用 launch token 换 cookie 后直接打 `/api/projects/*`：
  - 删建在已有用户工作区上的项目 → `{"removed":true,"workspaceRemoved":false,"skipped":true}`，用户工作区保留；修复前同一支返回带 `reason:"该项目没有由插件注册的工作区。"`，被客户端渲染成「工作区未移除」。
  - 对同一 id 再删一次 → `{"removed":false,"workspaceRemoved":false,"notFound":true,"reason":"项目不存在。"}`。
  - 删插件注册了工作区的项目 → `{"removed":true,"workspaceRemoved":true}`；`storages/workspace.json` 里该工作区记录与全局 `workspaceIds` 都消失，`dsh-leader-kit/projects.json` 清空，项目目录保留。
- **未取证**：菜单三项的画面、两支确认弹窗与提示条的实际显示——本轮修复改的是返回值形状与文案分支，渲染层未动；仍需一次绑定工作区的浏览器会话补证。
