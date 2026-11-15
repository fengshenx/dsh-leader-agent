# Agent Note: 项目目录失效后，不再把它的会话排除出官方工作区树

Status: implemented

## Problem

用户报告：删掉项目目录后，项目的会话「消失」，卸载插件才回到「未分组」。原因在排除集：`collectExcludedSessionIds` 无条件排除项目会话——项目的 leader 与登记的 worker——完全不看项目目录还在不在；目录删掉后项目行打不开、项目树里也没有 leader 的行，那些会话在两棵树里都不可达。

## Decision

**项目目录失效时放行它的会话。** 项目服务层用 `stat` 判目录是否可用（失败返回不可用而不抛），摘要与列表多带一个 `directoryUsable`；客户端先过滤出「还能打开的项目」，只排除这些项目的 leader 与 worker。判据用 `!== false` 而不是 `=== true`，让旧版摘要不带这个字段时保持原行为（仍排除）——退回语义由用例钉住。

### 不再改「未分组」组头判据

> **已被 [未分组组头改按会话快照判空](2026-11-04-ungrouped-header-snapshot-visibility.md) 取代**：#109 把判据与 DOM 解耦，只按会话快照与排除集判断；本节「不再改判据」的结论不再成立，本笔记其余部分（`directoryUsable` 放行会话）仍有效。

**不在渲染层复刻宿主的会话生命周期**（子代理、归档、空会话）——那等于把会话模型搬进插件，宿主一升级就错一次。

## Alternatives considered

- **继续无条件排除项目会话**：目录删掉后项目行打不开、项目树里也没有 leader 的行，会话在两棵树里都不可达。
- **在插件里复刻宿主的会话生命周期**：等于把会话模型搬进插件，宿主升级就错一次。
- **用 `directoryUsable === true` 判**：旧版摘要没有这个字段时会被当成不可用，改变既有行为；用 `!== false` 保持退回语义。

## Consequences

- `directoryUsable` 是 `stat` 的结果：慢卷上列表晚一拍；`ENOENT`、`EACCES` 与网络盘挂起一律当「不可用」，方向是降级成多显示而不是少显示。代价（目录临时不可读时左栏同时出现项目行与未分组里的同一个 leader）记在 [已知限制](../../../../docs/limitations.md)。
- 项目行的失效态由 leader 存活决定，与目录可用性无关：目录删掉后项目行照旧渲染、只是点开会失败。
- 会话能否「落到未分组」仍由宿主决定：删工作区只删注册，会话记录保留；本仓只管别把它们藏掉。
- 未验证 Windows 上 `stat` 对目录符号链接的行为；未分组组头的 DOM 结构只验过 `engines.dsh` 下限那一版。

收益：项目目录失效后，它的会话回到官方「未分组」树里仍可见、可打开。

## Testing

`tests/project-panel.test.js` 与 `tests/projects-service.test.js` 覆盖 `directoryUsable` 过滤、旧字段退回与列表标注。`tests/e2e/project-directory-gone.e2e.js`：把过滤撤成恒放行时「删目录后会话行回到官方树里可见」超时变红，还原并重建客户端产物后绿。
