# Agent Note: 自动续行上限可配置（默认 200）

Status: implemented

## Problem

leader 无人值守时，机制侧每投一条 worker 回报就消耗一次自动续行额度；额度固定为 8，达到后回报停在落盘队列，只有用户开口才复位。用户看到「回报没注入」，第一反应是丢消息；排查也只能从 `notifications.json` 的 `lastError` 看出是护栏。额度本身需要保留（防止无人值守时无限自动唤醒），但 8 对数十个 worker 并行的场景太短，而且不可见、不可调。

## Decision

- **设置落宿主**：`src/host/settings-store.js` 把上限写到 `$DSH_HOME/dsh-leader-agent/settings.json`，构造时同步读、写入走临时文件 + rename；共享契约在 `src/shared/settings.js`，默认 200、范围 1–10000。坏文件、坏值退回默认并留日志，不阻断启动。
- **派工器按次取值**：`createDispatcher` 收 `getAutoResumeLimit()` 而不是常量，每次投递现取；设置页保存后不重启、不重建 worker 会话。
- **设置页分区**：看板展示与自动续行各成一块，标题、说明、范围注记分开；看板模式随后也改存宿主设置，见[看板模式改存宿主设置](2026-11-25-board-mode-host-settings.md)。看板范围文案不再说「不写入项目数据」——旧文案把「不改业务数据」说成了「不写项目配置」，容易被读成项目级设置。
- **调高上限释放被挡条目**：设置变更订阅在 `next.autoResumeLimit > previous` 时调用 `dispatcher.releaseExhausted()`，只清 `exhausted` 标记、不重置已用次数；调低不释放。
- **通道**：沿用现有 `projects` Typert 命名空间（本插件唯一的 client→host RPC 面），新增 `readSettings` / `updateAutoResumeLimit`，上限走 `number` codec；看板模式另加 `setBoardMode`（`string`），见[看板模式改存宿主设置](2026-11-25-board-mode-host-settings.md)。

## Alternatives considered

- **只把常量改成 200**：解决一次积压，但用户仍无法按无人值守时长调整，也没解释「为什么停住」。
- **存 localStorage**：宿主派工器读不到，护栏无法生效。
- **用 Cordis profile Config 自动生成设置页**：改配置需要重载插件，worker 会话与在飞状态一起丢；而且它生成在宿主通用配置页，不在本插件设置页。
- **把上限挂到项目记录**：自动续行是实例级护栏，不是项目业务事实；写进项目会引入 revision 与跨项目口径问题。
- **调高时把已用次数清零**：会让新上限被额外放大；只释放被挡条目，已消耗的唤醒仍计入。

## Consequences

- 默认无人值守窗口从 8 次拉长到 200 次；护栏仍在，但长时间无人时自动唤醒的成本更高，用户可以在设置页调低。
- 设置页只显示上限，不显示当前已用次数与积压条数；撞上限的线索仍是 `notifications.json` 的 `lastError`。
- `settings.json` 是新增的实例级文件；同一数据根下的多个项目共用，不同数据根各自独立。看板模式也写这份文件（`version` 2），见[看板模式改存宿主设置](2026-11-25-board-mode-host-settings.md)。
- 坏配置退回默认而不是让插件启动失败；下一次在设置页保存会覆盖成合法值。
- **不处理真正的丢失窗口**：同一 worker 上一轮未结算又投新消息造成的在飞覆盖、以及进程重启时正在跑的轮次，仍会丢回报；本次只把「看起来像丢」的护栏做成可配，见[投递语义提案](../../proposed/architecture/2026-11-03-worker-delivery-idempotency.md)。
- `projects` 命名空间因此同时承载项目数据与设置方法；读设置与两个写方法用显式动词区分，语义在契约注释里写清。

收益：回报不再因为一个看不见的固定 8 次上限而看起来「丢了」，护栏变成可解释、可调的设置。

## Testing

`tests/settings-store.test.js` 钉住默认值、坏值回退、落盘、并发与订阅；`tests/settings-contract.test.js` 钉住范围解析；`tests/projects-remote.test.js` 与 `tests/client-project-remote.test.js` 钉住新方法与 codec；`tests/dispatch.test.js` 的「调高上限后释放被旧上限挡下的回报」钉住释放语义；`tests/leader-wiring.test.js` 钉住装配默认 200 与落盘；`tests/e2e/settings-auto-resume.e2e.js` 在真实宿主里断言两块分区、默认 200、非法值报错、保存 350 后 reload 仍生效。双向读数：把默认值改回 8，e2e 的默认值断言变红；去掉 `releaseExhausted` 里清 `exhausted` 标记的那一行，第二次调用仍返回 1，用例变红。
