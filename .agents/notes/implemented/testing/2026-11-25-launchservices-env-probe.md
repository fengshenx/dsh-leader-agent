# Agent Note: LaunchServices 不投递 open --env 时跳过真实启动用例

Status: implemented

## Problem

`tests/desktop-remove.integration.test.js` 的「假 .app 启动」用真实 `open --env DSH_HOME=...` 拉起 fake app，等它把数据根写进 capture。沙箱、无 GUI 会话或部分系统版本上，`open` 退出码仍是 0，`--env` 却被静默丢掉：fake app 拿空 `DSH_HOME`，capture 等不到目标内容，用例白等 30 秒后变红。

初版探测把「open 起不来 / 退出非 0」「探针 app 没启动」「app 拉起但变量丢失」三种情况都判成「不支持」并 skip。审查实测：假 `open` 直接 `exit 1` 时用例 `skipped 1 / fail 0`；假 `open` 延迟 8 秒时 5 秒探测也 skip，把慢启动误判成能力缺失。只有第三种是系统限制，前两种是环境坏了、本该失败。

## Decision

- 探针只返回 `delivered` / `unsupported`：capture 已出现且内容就是 sentinel 才算 `delivered`；**capture 已出现但内容不是 sentinel**（app 已拉起、`--env` 被丢弃）才算 `unsupported`。
- `open` 起不来（`result.error`）、退出码非 0 或 stderr 非空 → 抛错，用例失败，错误写明「这是环境坏了，不是系统不支持 --env」。
- 探针 app 在 30 秒内没有出现 → 抛错，不判成「不支持」；探测预算与真实用例共用 `LAUNCH_WAIT_ATTEMPTS`。
- 沙箱 / 无 GUI 需要放行时用显式 `DSH_DESKTOP_E2E=skip`；自动 skip 只在确认「app 已拉起但变量丢失」时发生。
- 探针用 `-n` 强制新实例，与真实启动（单实例复用）不是同一条调用；`-n` 只为保证探针 app 一定被拉起。

## Alternatives considered

- **保留 5 秒探测**：审查实测 8 秒慢启动会 skip，换成 30 秒预算后同一用例 pass；短预算把慢启动误判成不支持。
- **open 失败也判成不支持**：open 坏掉时真实用例本该失败，判成跳过等于让唯一真机启动断言在所有机器上静默失效。
- **始终跳过 macOS 启动用例**：正常桌面会话本来能验证，全部跳过会让唯一一条真机断言失效。
- **总是用假 `open` 替换真实通道**：能测参数拼接，但不再验证 OS 的 `open --env` 链路；把系统限制换成假件会掩盖真实环境差异。
- **改生产启动方式**：`open --env` 仍是 macOS 给 .app 注入环境的文档通道；本次只处理不可测环境。

## Consequences

- 健康 macOS：探测 1–2 秒通过，真实用例照跑；本机 11 pass / 0 skip。
- `open` 坏掉 / 权限 / PATH 异常：用例红，并直接指向环境问题，不再绿色 skip。
- 慢启动：30 秒预算内交付不 skip；实测假 `open` 延迟 8 秒时用例 pass（34.3s）。
- 沙箱 / 无 GUI：显式 `DSH_DESKTOP_E2E=skip` 才跳过；app 已拉起但变量丢失时自动 skip 并给出桌面复核入口。
- 单次测试多约 1–30 秒探测预算（视环境）。
- 收益：只有确认「app 已拉起但变量丢失」才跳过；`open` 坏掉与慢启动分别暴露成红与正常通过，不再让唯一真机启动断言静默失效。

## Testing

`tests/desktop-remove.integration.test.js` 的四场景（假 `open` exit 1 / 延迟 8 秒 / 丢 `--env` / `DSH_DESKTOP_E2E=skip`）分别钉住 fail / pass / skip / skip；本机健康路径 11 pass / 0 skip。对照旧实现，exit 1 与 8 秒慢启动都会 skip，本实现不再吞这两类回归。
