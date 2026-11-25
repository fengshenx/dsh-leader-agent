# Agent Note: 看板模式改存宿主设置

Status: implemented

## Problem

看板模式（工作 / 炫酷）原来存在浏览器 localStorage：同一 DSH 实例下换浏览器、清缓存或换设备就回默认；而设置页另一块自动续行已经落宿主 `settings.json`，两块范围说明互相矛盾——一个说「当前浏览器」，一个说「所有项目共用」。用户要求把原来的炫酷模式选择也改走同一份宿主配置，不再存浏览器。

## Decision

- **同一份文件**：`settings.json` 增加 `boardMode`，默认 `work`，只允许 `work` / `cinema`；`version` 升到 2。旧文件缺 `boardMode` 按 `work` 读，不迁移旧 localStorage 选择。
- **存储接口**：`settings-store.update({ boardMode })` 做校验、原子写与订阅通知；`update` 接受部分字段，在串行链内部基于当前快照合并，两个并发保存改不同字段不会互相覆盖。
- **远端**：`readSettings` 返回 `{ autoResumeLimit, boardMode }`；看板模式走 `setBoardMode`（`string`），自动续行改走显式的 `updateAutoResumeLimit`（`number`），不再用一个复用的 `updateSettings`。
- **客户端快照**：`src/client/board-mode.js` 只保留模块级 `get / subscribe / set`，不再读写 localStorage。看板挂载时读一次宿主设置，设置页保存成功后广播；其它窗口在窗口 `focus` 时重读。
- **设置页**：看板分区点击即保存，写盘成功后才改选中态并广播；失败保留原选择、就地报错并给重试。范围文案改为「保存在当前 DSH 实例，所有项目共用」。
- **不阻塞渲染**：看板先按 `work` 渲染，读到宿主 `cinema` 后切换；读配置失败保持当前快照，不让显示偏好把看板打成错误页。

## Alternatives considered

- **保留 localStorage**：宿主读不到，换浏览器不一致，和自动续行的存储域继续分叉。
- **单独开 `board-mode.json`**：多一套读写与原子写测试；设置项很少，合进 `settings.json` 更简单。
- **用 BroadcastChannel 实时跨窗口**：多一套生命周期与降级路径；窗口 `focus` 重读已覆盖实际使用。
- **一次性迁移旧 localStorage**：需要区分「宿主从未设置」与「显式选了 work」，还要继续读旧键，违背不保留兼容垫片的约定。
- **点击后乐观更新**：写盘失败时看板已经换模式，和设置页/宿主不一致；改为成功后再广播。

## Consequences

- 同一 DSH 实例下所有窗口与项目共用看板模式；换浏览器或清缓存不再回默认。
- 旧 localStorage 的炫酷选择不迁移，升级后从 `work` 起，需要重选一次（见 [限制](../../../../docs/limitations.md)）。
- 多窗口不是实时推送：另一个窗口的看板要重新挂载或窗口获得焦点才重读。
- 首次挂载会先按 `work` 渲染一帧，读到 `cinema` 后切换；没有用加载遮罩阻塞看板。
- `settings.json` 版本升到 2；旧文件缺字段按 `work` 读，不报配置损坏。
- 收益：显示偏好与机制配置统一由宿主持有，设置页两块不再暗示两种存储域。

## Testing

`tests/board-mode.test.js` 钉住内存快照、规范化、订阅与同值不广播；`tests/settings-store.test.js` 钉住 `boardMode` 默认/坏值回退/旧文件兼容/并发合并；`tests/projects-remote.test.js` 与 `tests/leader-wiring.test.js` 钉住远端方法与落盘快照；`tests/e2e/board-cinema.e2e.js` 在真实宿主里钉住默认 work、切 cinema 后写 `settings.json`、reload 仍 cinema；`tests/e2e/settings-auto-resume.e2e.js` 钉住设置页两块都走宿主配置。双向读数：把 `useBoardMode` 里的宿主读取去掉，reload 后看板停在 work，e2e 变红。
