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
- **环境里本来有 `HOME` 且指向别处的人，数据根会迁移**。git-bash/MSYS 里直接起 `dsh`、又没设 `DSH_HOME` 时，旧数据根是 `%HOME%\.dsh\dsh-leader-kit`，修复后变成 `os.homedir()` 那一份（宿主一直用后者），项目、卡片与待投递通知看起来「消失」。桌面端不受影响：那条路径修复前宿主半边根本没起来，没有旧数据。影响面窄且原状态本来就是插件与宿主分裂，不改代码；发版说明里提一句，让这批人知道去 `%HOME%\.dsh\dsh-leader-kit` 找旧数据。

## 验证

- 新增用例 `进程环境没有 HOME 时回落到 os.homedir()`：删掉 `process.env.HOME` 后断言 `resolveDshHome({})` 等于 `join(os.homedir(), '.dsh')`，用例结束恢复；`DSH_HOME 优先于默认家目录` 补一条断言把「`env.HOME` 不参与」钉住。
- 双向验证（`node --test tests/notification-store.test.js`，10 个用例）：
  - 字节级还原 `origin/main` 的实现（`typeof homedir === 'function' ? homedir() : process.env.HOME`）：**9 pass / 1 fail**，红的只有新用例（`ERR_INVALID_ARG_TYPE: Received undefined`，报错行在 `resolveDshHome`）；`DSH_HOME 优先于默认家目录` 仍绿，因为原实现会优先用注入的 resolver。
  - 只把回落表达式换成 `process.env.HOME`、保留新签名与默认 `homedir`：**8 pass / 2 fail**，新用例与 `DSH_HOME 优先于默认家目录` 双双变红（后者传了 resolver，断言拿不到注入值，实际去读进程级 `HOME`）。
  - 还原修复后 **10/10**。
- 端到端：临时数据根、进程环境无 `HOME`/`DSH_HOME`、`USERPROFILE` 指向临时根，起真实 `dsh web` 后走 `/connect` 换 cookie，再 `POST /api/projects/list` 与 `POST /api/projects/create`。修复前两条都是 **404 `not found`**，启动日志里是背景那一段 `1 entry did not activate` 与 TypeError；修复后两条都是 **200**（`list` 返回 `ok:true, value:[]`，`create` 返回业务错误「项目目录不能为空」，因为请求体给的是空 `args`），无警告。**警告在就绪行之后才打印**，拿到访问地址那一刻读日志会读到空。
- 全量单测 **1030 tests / 1021 pass / 6 fail**；干净 `origin/main`（`e286870`）**1029 / 1020 / 同一 6 条**，都是本机 Windows 的既有失败，与本次改动无关：
  - `desktop-plan` 四条，断言写死 POSIX 绝对路径（如 `expected: '/data/dsh'`，Windows 上得到 `C:\data\dsh`）：`DSH_HOME 覆盖数据根，空串按未设处理`、`DSH_HOME 按宿主口径展开 ~ 与相对路径`、`相对 DSH_HOME 拒绝：open 启动的应用拿不到这个 shell 的 cwd`、`DSH_HOME 的两种非法写法在解析入口就抛（行为级，走真实路径解析）`。
  - `doc-tool-names`：`.telov/skills 也在扫描面内：运维 skill 写错工具名同样会红`。
  - `skills`：`初始化骨架默认只含 dev 与 review 两个槽位`（`\r\n` 与 `/^slots:\n  dev:/m` 不匹配）。
- `npm run check` 前四步全绿（`verify-agent-note-format` 70 篇、`verify-doc-tool-names` 14 篇、`verify-doc-budgets` 13 篇、`check-syntax` 98 文件）；第五步 `verify-coverage` 因上面 6 条既有失败拒绝执行（`单测未通过（退出码 1），覆盖率门禁未执行`），干净 `origin/main` 同样如此。直接读覆盖率补证：`node --test --experimental-test-coverage`，`notification-store.js` 行覆盖 **100.00%**（分支 90.48%、函数 86.96%），基线同为 100.00%，不回归。
