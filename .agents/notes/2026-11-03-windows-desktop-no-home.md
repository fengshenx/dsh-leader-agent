# 数据根按 `process.env.HOME` 解析会把 Windows 桌面端打挂

**日期**：2026-11-03
**状态**：accepted

## 背景

Windows 桌面端点「创建目录」报 `/api/projects/create` HTTP 404，同一插件在 macOS 上正常。

桌面应用由资源管理器启动，它的进程环境里**没有 `HOME`**（Windows 只有 `USERPROFILE`），也没有 `DSH_HOME`。宿主自己按 `os.homedir()` 定位 `~/.dsh`（`dsh-home-paths`），而本仓的 `resolveDshHome()` 在没有 `DSH_HOME` 时读的是 `process.env.HOME`——`join(undefined, '.dsh')` 直接抛 `ERR_INVALID_ARG_TYPE`。异常发生在 `apply` 的第一次取 home（`src/host/index.js:148` 建项目存储），于是整个宿主半边不激活：

```
dsh: warning: 1 entry did not activate
leader-kit-host (dsh-leader-kit): TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined
    at join (node:path:513:7)
    at resolveDshHome (src/host/notification-store.js:27:10)
    at new apply (src/host/index.js:148:47)
```

宿主半边没起来，`projects/*` 这些 endpoint 没有注册，网关不认识它们，请求落到连接层默认处理——浏览器侧拿到的就是 HTTP 404。客户端产物由宿主单独下发，不受宿主 fiber 影响，所以项目区块照常显示、点下去才炸。

`npm run dev` / `npm start` / e2e 都显式给子进程设了 `DSH_HOME`（开发与 e2e 的隔离需要），这条「两个都缺」的路径从来没有被跑到过。

## 决策

`resolveDshHome()` 默认回落到 `os.homedir()`，与宿主 `dsh-home-paths` 同口径；`env` 只用来读 `DSH_HOME`，不再读 `HOME`。

```js
export function resolveDshHome(env = process.env, resolveHome = homedir) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(resolveHome(), '.dsh')
}
```

第二参保留为家目录解析器，单测注入用。

## 边界

- **只改默认回落**。`DSH_HOME` 的优先级、空白串按未设处理的语义不变；posix 上 `os.homedir()` 本来就从 `HOME` 来，行为不变。
- **同类问题只此一处**。全仓 `process.env.HOME` 只有这一个调用点；脚本侧的 `homedir()` 来自 `node:os`，不受影响。
- **复现必须同时去掉两个变量**，并让宿主的数据根仍落在临时目录：Windows 上把 `USERPROFILE` 指到临时根（宿主用 `os.homedir()` 跟着走），清掉 `HOME` 与 `DSH_HOME`。只清 `HOME` 而留着 `DSH_HOME` 复现不到——这正是 dev/e2e 掩盖它的原因。

## 验证

- 新增用例 `进程环境没有 HOME 时回落到 os.homedir()`：删掉 `process.env.HOME` 后断言 `resolveDshHome({})` 等于 `join(os.homedir(), '.dsh')`，用例结束恢复。双向验证：把实现改回 `join(process.env.HOME, '.dsh')`，它与既有 `DSH_HOME 优先于默认家目录` 双双变红（报错行都在 `resolveDshHome`），还原后 10/10 通过。
- 端到端：临时数据根 + 无 `HOME`/`DSH_HOME` 起真实 `dsh web`。修复前启动日志就是上面那段 `1 entry did not activate`，`POST /api/projects/list` 与 `POST /api/projects/create` 均返回 HTTP 404；修复后启动无警告，两个接口都是 200（`create` 返回业务错误「项目目录不能为空」，因为请求体给的是空 `args`，与 404 不同）。
- 全量单测 1021 pass / 6 fail；6 个失败在干净 HEAD 上同样红，是本机 Windows 的 CRLF 与路径展开问题（`desktop-plan` / `doc-tool-names` / `skills`），与本次改动无关。
