# Agent Note: 看板默认改为工作模式，设置入口改为 Leader Agent

Status: implemented

## Problem

[2026-11-24 的炫酷/工作模式](2026-11-24-board-cinema-and-work-modes.md)把新装默认定成炫酷（线路图），老用户默认工作，并用宿主数据根的一次性标记区分新老。实际使用中炫酷只是演示与社媒传播素材，日常扫任务仍用纯列表；默认炫酷让新用户一打开看板先看到线路图，还要手动切回工作。另外设置导航里的入口叫「任务看板」，与插件名 `Leader Agent` 不一致，用户不好找。

## Decision

- **默认工作模式**：`BOARD_MODE_DEFAULT` 与 `normalizeBoardMode` 的兜底都改为 `work`。没有显式 `board.mode` 时直接按工作列表渲染，不写任何默认缓存。
- **移除宿主一次性判定**：删掉 `src/host/board-defaults.js`、`projects.boardDefaults` 远程方法、客户端的 `board.default` 缓存与 `pending` 首帧。显式 `board.mode` 仍然优先；换浏览器、清站点数据回工作模式。
- **设置入口改名**：`settings.section` 的导航标签统一为 `Leader Agent`；块标题仍是「任务看板」，工作与炫酷两个选项都在这一块里。
- **炫酷定位为演示**：说明文案改为「纯演示，社交媒体传播用」，英文 `Demo only, for social sharing.`，其余语言同义。
- **文档顺序**：README 先放工作模式；使用手册补炫酷说明与截图，并写清切换路径 `设置 → Leader Agent → 任务看板`。

## Consequences

- 上一版因默认拿到 `board.default=cinema` 的用户会被当成没有显式选择，回到工作模式；显式选过炫酷的人不受影响。
- 启动路径少一次异步 `boardDefaults` RPC，看板首帧不再有 `pending` 分支。
- 宿主数据根不再写 `board-default.json`；旧文件留在盘上不再读取，可忽略。
- `board-cinema` e2e 改为默认工作、在设置页切炫酷，并断言入口名、块标题与炫酷说明；`board-card-kind-navigation` 继续显式钉工作模式。

## Alternatives considered

- **保留宿主一次性判定，只把 fresh 改成 work**：标记、RPC、缓存与 pending 都只为区分新老用户；默认统一后这些全是死代码。
- **保留 `board.default` 兼容旧缓存**：会让上一版默认炫酷的用户继续停在炫酷，与「默认工作」冲突；显式选择已经单独存在 `board.mode`，不需要兼容非用户选择。
- **设置入口直接叫「看板」**：与插件名不一致，且设置页里已经有「任务看板」块标题，导航用 `Leader Agent` 更容易从插件名找到。
- **删掉炫酷模式**：它是演示和社媒素材，仍有价值；只把它降级为显式选项。

## Testing

- `tests/board-mode.test.js` 钉默认工作、未知值回工作、显式 cinema 读取、写失败回退与订阅；旧 `board.default` 缓存键被忽略、显式选择仍优先的迁移回归也在这一文件。
- `board-cinema` e2e 钉默认工作、设置页入口 `Leader Agent`、块标题「任务看板」、默认选中工作、炫酷说明，以及切换后的 rail 几何与 reload 两条路径。
- `npm run check` 通过。
