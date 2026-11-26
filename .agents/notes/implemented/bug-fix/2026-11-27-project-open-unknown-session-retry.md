# Agent Note: 项目行打开 Leader 会话时对 unknown session 做有限重试

Status: implemented

## Problem

负载下点项目行打开 Leader 会话时，宿主 `uiWorkspace.openSession()` 同步抛 `sessions.retain: unknown session <id>`；React 点击处理器没有接住，直接变成 pageerror。栈落在宿主的 `mainView` 导航，不在槽位保留器：

```text
SessionManager.resolveTarget
ClientSessions.retain
Proxy.replaceMain
Proxy.openSession
openLeaderSession
onClick
```

宿主要求会话已在 `sessions.has()` 或 `summaries` 里；实例刚重启时项目注册表已有 `leaderSessionId`，但客户端会话目录还没加载完，负载把窗口拉大。retain 参数是 `{ source: 'mainView' }` + 裸会话 id，没有 `parentSessionId` / `childSessionId` / `mode`。槽位保留器的编造地址加固与这条路径无关，所以上次与后续的槽位修复都没有覆盖它。

## Decision

`openLeaderSession()` 接待住宿主同步抛出的 unknown：按 200 / 500 / 1000ms 递增重试 3 次，成功即返回；重试期间经 `onRetry` 让项目面板显示「Leader 会话还在加载，正在重试…」；用尽后把原错误抛出。其它错误不重试、直接抛。

面板在调用点捕获最终错误并显示「打开项目…失败：…」，点击后不再毫无反应；`watchProblems` 保持 fail-loud，没有过滤这条 pageerror。延迟函数与重试间隔都可注入，单测不真等。

## Alternatives considered

- **改宿主 `resolveTarget` / `openSession`**：本仓不改宿主仓库；catalog 是否就绪属于宿主契约，我们只能在调用点收敛。
- **吞掉 unknown 并静默返回**：用户点项目行没反应，问题从 pageerror 变成「打不开也不说」；明确拒绝。
- **无限重试**：宿主目录真没这个会话时会永久挂住点击；用尽后必须把错误交给用户。
- **先等 `sessions.list()` 出现该 id**：这条路径上客户端列表为空，不是可用的存活判定口。
- **只提示「加载中」不重试**：窗口只有几百毫秒时用户仍要手点第二次；有限自动重试更符合一次点击的预期。

## Consequences

- 启动/热更后的短暂 catalog 竞态会被自动跨过；真正不存在的会话仍在约 1.7s 后报错。
- 重试窗口内用户重复点击会各自发起一组重试，可能出现重复 toast；打开同一会话是幂等的，未额外加点击锁。
- 不触碰槽位保留器与 board 的编造地址逻辑；它们解决的是另一条路径。
- 错误文案直接带宿主 message，保留原始原因，不把它包装成「加载中」而丢失。

收益：项目行不再因一次目录未就绪的同步错误产生 pageerror，用户也能看到「加载中」或最终失败原因。

## Testing

- `tests/project-panel.test.js`：前 2 次 unknown、第 3 次成功（断言递增间隔与 `onRetry`）；用尽后抛原错误；非 unknown 立即抛；默认延迟路径成功。
- 修复前负载下 2/3 红，修复后按验收在合并后的 main 上补三场景各 ≥5 次。
- mutation：撤掉 unknown 重试，单测「前 2 次 unknown、第 3 次成功」变红。
- `npm run check` exit 0；`npm run build:client` 通过。
