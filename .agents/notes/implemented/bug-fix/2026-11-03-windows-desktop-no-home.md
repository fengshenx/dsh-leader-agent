# Agent Note: 数据根按 `process.env.HOME` 解析会把 Windows 桌面端打挂

Status: implemented

## Problem

Windows 桌面端点「创建目录」报 `/api/projects/create` HTTP 404。桌面应用由资源管理器启动，进程环境里没有 `HOME`（Windows 只有 `USERPROFILE`），也没有 `DSH_HOME`；宿主自己按 `os.homedir()` 定位数据根，而本仓在没有 `DSH_HOME` 时读 `process.env.HOME`，`join(undefined, '.dsh')` 直接抛 `ERR_INVALID_ARG_TYPE`。异常发生在插件激活时第一次取 home，整个宿主半边不激活、`projects/*` endpoint 没注册，网关就把请求当 404——客户端产物由宿主单独下发，所以项目区块照常显示、点下去才炸。

## Decision

**数据根默认回落到 `os.homedir()`，与宿主的家目录口径一致；`env` 只用来读 `DSH_HOME`。** 家目录解析器保留为可注入的第二参，供单测替换。`DSH_HOME` 的优先级与「空白串按未设处理」的语义不变；posix 上 `os.homedir()` 本来就从 `HOME` 来，行为不变。

**只此一处同类问题**：全仓 `process.env.HOME` 只有这个调用点，脚本侧的家目录来自 `node:os`。

## Alternatives considered

- **继续从 `process.env.HOME` 取家目录**：Windows 桌面端没有 `HOME`，`join(undefined)` 直接抛错、插件半边不激活；与宿主 `os.homedir()` 的口径也分叉。
- **只在 Windows 上单独读 `USERPROFILE`**：多一条平台分支，仍可能与宿主 `os.homedir()` 不一致；统一回落 `os.homedir()`。（原文未记录，本次补记）

## Consequences

- **环境里本来有 `HOME` 且指向别处的人，数据根会迁移**：git-bash / MSYS 里直接起 `dsh` 又没设 `DSH_HOME` 时，旧数据根在 `%HOME%` 下，修复后变成 `os.homedir()` 那一份（宿主一直用后者），项目、卡片与待投递通知看起来「消失」。桌面端不受影响（修复前宿主半边根本没起来）。影响面窄且原状态本来就是插件与宿主分裂，不改代码，只在发版说明里提一句，让这批人去旧路径找数据。
- 开发实例、`npm start` 与 e2e 都显式设 `DSH_HOME`（隔离需要），只有桌面端会走到两个都缺的路径；复现也要同时去掉两个变量并让数据根仍落临时目录，只清 `HOME` 复现不到——这正是开发路径掩盖它的原因。

收益：Windows 桌面端不再因为缺 `HOME` 让插件半边不激活，数据根与宿主统一。

## Testing

`tests/notification-store.test.js`：字节级还原旧实现后新用例变红（`ERR_INVALID_ARG_TYPE`），还原修复后全绿。端到端在无 `HOME` / `DSH_HOME` 的临时数据根上起真实 `dsh web`：修复前项目列表与创建都是 404，修复后都是 200 且启动日志无「未激活」警告。
