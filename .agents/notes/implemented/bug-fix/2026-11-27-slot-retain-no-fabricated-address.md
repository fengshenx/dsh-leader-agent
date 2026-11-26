# Agent Note: 看板槽位只按裸 id 保留，不再编造子代理地址

Status: implemented

## Problem

插件热更到 0.10.0 后（App 未重启），看板卡片上的 worker 槽位「全丢」；点槽位打开
报 `历史加载失败：subagent does not belong to the supplied parent（subagent/unauthorized）`，
多个会话同时中招。

本机取证：受影响的 `worker-9c56da02-…`、`worker-c779b8b6-…`、`worker-a819a544-…`
都是根会话（会话头无 `origin`，`delegationDepth` 为 0），`workers.json` 登记正常，
`session_projcache` 里也没有把它们记成子代理。宿主 `validateAddress()` 只在地址是
子代理地址时要求 `origin === 'subagent'` 且父会话匹配——是客户端给了错误地址。

地址由旧客户端编造：`SlotRetention` 的 retain 在裸 id 报
`sessions.retain: unknown session` 时，用卡片 `createdBy` 构造
`{ parentSessionId, childSessionId, mode: 'unknown' }`。宿主 `resolveTarget()` 接受
任意地址并写进**进程内存**的地址表；热更不重启宿主，旧地址因此活过升级。新客户端
retain 时宿主按这条地址 `open()`、读历史，根会话一律被 `subagent/unauthorized` 拒绝。

0.10.0 的放大效应：`532eabe` 把 `hold()` 从「吞掉全部异常」改成「只吞 unknown
session、其它照抛」。`hold` 在 React effect 里调用，于是**一个槽位的失败会卸载整块
看板**——这才是「所有卡片的 worker 一起消失」，而不只是槽位变未知。

版本归属：编造兜底自 **v0.1.0**（`f1a4cea`）就在，0.10.0 没有新增它；0.10.0 新增的
是「单点失败炸整块板」。

## Decision

**永不构造子代理地址。** 删除 `retainTargetOf()`；槽位只调
`sessions.retain(sessionId, { source: 'dshLeaderBoard' })`。真正的子代理会话由宿主
从会话目录（`summary.origin`）自己解析地址。

**未知会话有限次重试。** `hold()` 在 `sessions.retain: unknown session` 上按
`retryDelayMs`（默认 2s）重试 `retryAttempts`（默认 3）次，用尽才报「状态未知」；
撤掉槽位或卸载时取消待跑的重试。

**单槽位失败不抛出 React。** 除未知会话外的保留错误一律经 `onError` 报告、该槽位
保持未知；不把异常抛进 effect，否则一个坏地址就能让整块看板消失。

## Alternatives considered

- **保留兜底、只改 `mode`**：宿主校验的是会话头 `origin`，根会话填什么都过不了。
- **用 `sessions.list()` 判存活**：它只返回 live session，冷启动时可能为空（
  capability-gaps 第 21 条），会把所有槽位一起标未知。
- **维持 0.10.0 的照抛**：正是它把「一个槽位坏」放大成「整块板消失」；Fail Loud
  由 `onError` 报告满足，不需要炸掉 UI。
- **无限重试**：宿主目录永远不就绪时会每 2 秒刷一次 retain，日志与 RPC 都会被刷爆。

## Consequences

- 槽位不再被污染成子代理行；宿主目录未就绪时最多 3 次重试后如实显示未知。
- 已存在于宿主内存里的旧地址不会因本修复消失：**当前进程需要重启一次 App 才能清掉**，
  之后不会再产生新地址。
- 历史 subagent 时代的 worker 不再能被看板保留：宿主认不出地址就显示未知。
- 收益：多张卡的槽位会话不会再成批报 `subagent/unauthorized`，也不会让整块看板消失。

## Testing

`tests/slot-retain.test.js` 新增重试成功、重试用尽只报一次、撤槽取消重试、
dispose 取消重试四个用例，并把「其它错误」改成「只报告不抛」；未知会话用例收紧到
`retryAttempts: 0`；删除 `retainTargetOf` 的构造地址用例。双向验证：把
`hold` 临时改回「未知会话直接报告」，两个重试用例变红，还原后 14 个用例全绿；
`npm run check` 全绿（1546 用例）。
