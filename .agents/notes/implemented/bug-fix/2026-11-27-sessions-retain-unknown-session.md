# Agent Note: worker 看板关标签不再把 leader 槽位挂到假父会话

Status: implemented

## Problem

Issue #200：切到 worker 后关闭它右栏的看板标签，页面偶发未捕获异常
`sessions.retain: unknown session <leader-id>`。看板槽位的 retain 目标始终是
leader（卡片槽位都绑 leader），不是当前显示的 worker；客户端的
`sessions.list()` 在这条路径上返回空数组，不能拿来判会话是否还活着。现有
`SlotRetention.hold` 能接住同步抛出的未知会话错误，却接不住宿主内部的异步
调用链；旧 e2e 因此在 leader 上程序化点 worker 的隐藏关闭按钮，绕开了真实路径。

## Decision

**保留目标只允许用真正的建卡会话做父级，不再拿看板当前会话兜底。** 卡片没记
`createdBy` 时，`retainTargetOf()` 返回 undefined，裸 `sessions.retain(id)` 的
未知错误原样交给保留器，槽位显示「状态未知」；不构造
`{ parentSessionId: worker, childSessionId: leader, mode: 'unknown' }` 这种宿主
不认得的父子地址。

**卸载后的迟到同步不再 retain。** `SlotRetention.dispose()` 置
`disposed`，`sync()` / `hold()` 在卸载后直接返回，避免关标签后的下一拍把已
释放的会话重新挂上。`hold()` 只捕获精确的
`sessions.retain: unknown session …`（`isUnknownSessionError`），其它异常照抛，
不让网络/宿主内部错误被静默吞成空心圈。`reference.ready` 的失败仍走原有
`onError`，不会变成未处理 rejection。

## Alternatives considered

- **用 `sessions.list()` 判断存活**：Issue #200 已实测它是空数组；拿空列表当
  「会话没了」会让所有槽位一起显示未知，不能作为守卫。
- **在 `retain` 外层吞掉全部异常**：会把宿主的真实故障也伪装成未知会话，违反
  Fail Loud；只认固定错误串。
- **保留 `parentSessionId = 当前会话` 的兜底**：切到 worker 后当前会话是 worker，
  它只是看板跟随的落点，不是 leader 的父会话；宿主地址解析可能接受但随后在
  异步链里报 unknown。宁可不 retain，也不编造地址。
- **改宿主 `SidebarSessionViews` / `SessionManager`**：不在本仓修改范围，且宿主
  内部异步调用点不可控；本仓只在调用点做可判定的门控。

## Consequences

- 没有建卡会话的存量卡片，在 leader 会话本身已从客户端目录消失时只显示「状态
  未知」，不再尝试地址兜底；之前那种兜底本来也可能把地址挂错。
- 关标签后的 retain 不会再晚到；代价是异常 late effect 被直接丢弃（这些 effect
  在卸载后没有 UI 可更新）。
- 真实用户路径（切到 worker → 关闭它右栏的看板标签）重新进入 e2e，不再用
  leader 上的程序化隐藏点击绕开。

## Testing

`tests/slot-retain.test.js` 新增：卸载后 `sync()` 不再 retain；只吞
`sessions.retain: unknown session …`，其它错误抛；`isUnknownSessionError` 边界。
`tests/e2e/board-cinema.e2e.js` 恢复真实路径：第二次切到 worker，等它的右栏
可见后悬停标签、点关闭，再继续后续 reload/模式断言；`watchProblems` 把任何
pageerror 留红。

当前环境（dsh `0.2.2-rc.2`）用真实路径连续跑多轮未能复现原 pageerror；因此本次
按调用点加固，回归守卫落在上面两个纯逻辑用例与真实路径 e2e。Issue #200 记录的
完整栈/参数仍需在能复现的宿主版本上补一次；未把「宿主缺陷」写成已定论。
