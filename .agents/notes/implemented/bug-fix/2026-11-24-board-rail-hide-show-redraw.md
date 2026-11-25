# Agent Note: 会话切换不再重建线路图

Status: implemented

## Problem

宿主的右栏按会话隔离（`RightbarRoot` 保留每个会话的子树），非当前会话用 `display:none` 隐藏。看板 body 有 `keepMounted`，切走不卸载——但线路图是命令式 SVG：`ResizeObserver` 看到 stage 从 0 变回 N，就调 `drawRail` 清空并重建整层，SMIL 光点随节点一起重建，动画从头起跑。于是每次切换会话（哪怕右栏面板本身没换、宽度没变）都会看到光点跳回起点、顿一下。

宿主只负责显隐，重画是看板自己的；真正需要重画的只有「尺寸变化」或「内容/状态签名变化」。卡片行高会随标题长度与链接行变，只比宽度时线路图会停在旧几何。

## Decision

- `drawRail` 前先判：stage 尺寸为 0（隐藏）直接跳过；`railKey` / 走线 / 主题 / 减少动效 + `clientWidth` × `clientHeight` 的签名没变时跳过。隐藏期间的 0 尺寸不再清空 SVG，显示时尺寸恢复、签名相同就保留原来那层（含动画节点）。
- 看板卡片标题固定单行（`nowrap` + `ellipsis`，行高恒定 20px）：行几何不随标题长度变，列表也更整齐；完整文本放在 `title` 属性里悬停可读。
- 高度保留在签名里，兜住字体加载、locale 行高与链接行增删导致的整卡高度变化；宽度管卡片换行。不做逐行 `top`/`height` 的几何数组——标题单行后没有独立于总高变化的行位移，`clientHeight` 已覆盖。
- `ResizeObserver` 回调改成 80ms 尾防抖：尺寸连续变化时只画最后一次，不再每帧重建。

## Alternatives considered

- **逐行行几何（`rowTops` 哈希）**：能表达「总高不变、行位置变化」，但标题单行后行高变化必然改变 stage 高度，剩下的两行一增一减是极端巧合；多一轮测量与一份纯函数换不来可观察收益。
- **保留动画相位（负 `begin`/`animation-delay`）**：能让必要的重建从当前相位接上，但 SMIL 在节点后插入时按文档时间还是插入时间采样，浏览器行为没有把握；先解决「本来不用重画却重画」。
- **按时间戳/定时重画**：会在隐藏期间与轮询稳定期反复重建 SMIL 节点、动画反复起跑，正是要消除的现象。
- **只带 `clientWidth`**：标题换行或链接行变化时宽度没变，线路图停在旧位置；高度必须一起比。
- **改宿主用 `visibility`/`transform` 隐藏会话**：在宿主仓库，且影响主面板布局与无障碍；插件不能改。
- **把看板 DOM 跨会话搬过去**：宿主没有跨会话 pin 面板的公开入口，看板是每会话一份 tab body。

## Consequences

- 会话来回切时线路图节点不重建，光点连续跑；切到第一次打开且右栏收起的 worker 仍有宿主自己的面板滑入。
- 拖拽右栏宽度时线路图在**整个拖拽期间**停在旧宽度上（错位），停手 80ms 后才对齐；这是尾防抖的代价。
- 隐藏期间卡片轮询暂停（`board.js` 的 `visible` 早退），签名不变；隐藏期间行高真变了，显示后 `clientHeight` 不同仍会重画一次。
- 长标题只显示一行省略号，完整文本靠 `title` 悬停；这是行几何恒定的取舍。
- 首次打开一个收起的右栏仍会从 0 尺寸画一次，接受。

收益：会话来回切时线路图节点不重建、光点连续，不再每次切换都从头上路。

## Testing

- `npm run check`、`npm run build:client`、`npm run e2e:one board-cinema` 通过。
- 常驻守卫在 `board-cinema` 场景：切到另一个会话再切回，主干节点上的 `data-rail-keep` 仍在（节点没被替换）且 `replaceChildren` delta 0；撤掉签名比较该断言变红（`count:0`）。
- 真机探针（临时脚本，不入库）：长标题 `clientHeight` 20、`scrollWidth` 876 > `clientWidth` 503、`text-overflow: ellipsis`、`title` 为完整文本；给卡片加链接行后 stageH 198→221、trunkD `M20,32 L20,156`→`M20,32 L20,179`、`replaceChildren` +1；leader↔worker 切换计数 delta 0、sameTrunk true。
- 双向：只带宽度 → 链接行加高后 trunkD 不动；撤掉 0 尺寸跳过 → away `M0,0 L0,0`、切回重建；撤掉签名比较 → 切回重建。
- 「链接行加高 → 重画」只在探针里验证（要改夹具结构，收益不抵成本），不是常驻回归。
- 未验证：真实 running 槽位下 SMIL 光点跨隐藏/恢复的相位（种子槽位全空闲）。
