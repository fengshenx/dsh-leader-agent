# Agent Note: HMR 换插件后样式表跟上新版本

Status: implemented

## Problem

0.7 升到 0.8 后用户看到「样式丢了不少」：新组件的类名没有规则，旧组件的样式还在，刷新或重启才恢复。宿主 `client-hmr` 换插件只拆旧 fiber 重新 `apply`，不刷新页面；本仓样式由各模块在组件挂载时按 id 自注入 `<style>`，见到同 id 已存在就直接 return，于是 0.8 新增的看板样式块停在 0.7 的文本上。

这不是 0.7 引入的：按 id 判重的注入从 0.1.0 就在，0.6→0.7 也往同一个 id 里加过新规则（如标签栏 action），同样会缺样式；0.8.0 一次加了 409 行（rail、设置）才让它普遍可见。

## Decision

样式注入统一收进 `src/client/style-sheet.js`：`ensureStyleSheet(id, text)` 在同 id 节点已存在时按内容同步 `textContent`，不存在才创建，内容相同不碰 DOM。九个样式模块的 `ensure*` 只保留 id、文本与调用，判重逻辑不再各写一份。

不清理旧版本残留的样式表节点：0.8 只是往同一个 id 里加规则，旧页面不会留下多余的块；要支持「删掉一整块」得有一份跨模块的 id 注册表。宿主侧有 `ui-renderer` 的 `meta.stylesheets` 与 client-modules 的 `removeOwnedStyles` 这类通道，但本仓 esbuild 产物不走它们，对本包没有可用的公开/稳定卸载点，代价大于收益。

## Alternatives considered

- **保持按 id 判重、升级后要求刷新页面**：用户遇到的就是「必须重启」，等于否掉宿主的免刷新承诺，0.8 的新看板样式整块失效。
- **换插件时清掉 `dsh-leader-agent-*` 节点再重注入**：需要跨模块注册表与卸载钩子，且清理到重注入之间会闪一帧无样式。
- **在页面 unload 时清理**：页面本来就会重建，没有解决问题。

## Consequences

- 升级与开发期重建都不必刷新或重启：HMR 重新 `apply` 后组件挂载即换成新文本，同 id 始终只有一张样式表。
- 组件在一次插件实例内重复挂载不会重写节点；只有换了模块实例（新版本）才会写。
- 旧版本删掉的规则仍可能留在页面里，但没有组件引用；真要删块时再引入注册表。
- 收益：客户端版本切换与应用热更新都无需刷新页面，样式与新组件同步生效。

## Testing

`tests/client-styles.test.js`：document 桩里预置一张旧文本的同 id 样式表，调用 `ensureBoardStyles()`；修复前文本保持旧值（红），修复后替换为新文本且 head 仍只有一张（绿）。另一条用例用 `textContent` setter 计数钉住「内容相同不重写」，删掉 `if` 守卫后会红。

真机 HMR（审查侧补跑）：基线 6 张样式表、看板文本 37487；插入 marker 后 500ms 读到 37530、marker 存在、节点数仍 6；还原后回到 37487。对照组把 `ensureStyleSheet` 改回无条件 `return`，20s 内 marker 一直不存在。
