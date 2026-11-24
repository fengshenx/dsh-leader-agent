# Agent Note: 面板页接管主区域时项目区块不再保留选中态

Status: implemented

## Problem

点项目行打开 leader 后项目行整行亮；再点左栏「插件」或「自动化任务」，主区域换成了面板页，项目行与它的会话行仍铺着选中底色。宿主的会话树此时已经不选中任何行（`WorkspaceBrowser` 按 `layout.panelInfo.activePanelId` 把当前会话视作空），两棵树并排时一眼就看出不一致。窄导轨下同一件事表现成浮层不收起、入口图标还亮着。

## Decision

**选中口径跟宿主的 `panelActive` 一致。** 项目面板订阅 `layout.panelInfo`，面板页打开时把「当前会话」当空：整行选中、行首文件夹点亮与折叠水位都按这个口径算，与宿主会话树同一套判据。布局服务取不到时按「没有面板页」处理，退回旧行为而不是报错。

**窄导轨浮层在面板页接管时收起。** 浮层是固定定位的，导航走了还盖在主区域上，入口也还亮着——收起才算把这次交互结束掉。effect 依赖 `activePanelId`：面板页打开、以及从「插件」切到「自动化任务」这类面板页之间切换都收一次；在同一个面板页上主动点项目入口仍可展开（id 没变），点里面的项目行会顺带关掉面板页。

## Alternatives considered

- **维持「不跟 panelActive」**（[上一版的决定](../feature/2026-11-02-project-row-selection.md)）：宿主不选中、本仓还亮着，用户看到的是「点了两样东西，亮着的还是上一个」；这正是本次要修的症状。
- **读宿主 DOM 判断面板页**：从项目区块向上找主面板容器、比类名与结构，宿主改版就失效；布局服务是公开的客户端服务。
- **用槽位自带的 `usePanelInfo`**：`sidebar.footer.action` 的占位只拿到 `wide`，宿主不向任意槽位注入运行时钩子；只能从注入的 `getLayout` 取。

## Consequences

- 只改呈现：会话、面板选择与看板数据都不动；点项目行仍然打开 leader 并关掉面板页。
- 布局服务取不到时按「无面板页」处理，退回旧行为、不报错；root entry 的 inject 结果按 entry 缓存，这条降级路径不会在服务晚就绪后自动重试。
- 窄导轨浮层在面板页打开或面板页之间切换时收起；指针停在浮层外点击不收起，与之前相同。

收益：左栏的「现在在看哪个项目」不再比主区域多亮一层。

## Testing

`tests/e2e/project-panel-selection.e2e.js`：宽侧栏点项目行 → 点「插件」，断言项目行的 `data-selected` 与计算底色都回到未选中；再收起侧栏走窄导轨，断言浮层随面板页收起、入口底色回落、`aria-expanded` 在展开/收起两态分别为 `true` / `false`。在「插件」页手动展开浮层再切「自动化任务」，断言浮层收起、`aria-expanded` 回到 `false`（切换前 `sections: 1` → 切换后 0）。把选中口径退回「总是用当前会话」时第一段红（失败读数 `data-selected="true"`）；把浮层 effect 依赖退回 `panelActive` boolean 时面板页切换那段红（读数 `sections: 1`）；还原后绿。
