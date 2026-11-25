# Agent Note: 会话切换不再重建线路图

Status: implemented

## Problem

宿主的右栏按会话隔离（`RightbarRoot` 保留每个会话的子树），非当前会话用 `display:none` 隐藏。看板 body 有 `keepMounted`，切走不卸载——但线路图是命令式 SVG：`ResizeObserver` 看到 stage 从 0 变回 N，就调 `drawRail` 清空并重建整层，SMIL 光点随节点一起重建，动画从头起跑。于是每次切换会话（哪怕右栏面板本身没换、宽度没变）都会看到光点跳回起点、顿一下。

宿主只负责显隐，重画是看板自己的；真正需要重画的只有「几何变化」（stage 尺寸、行高与行位置）或「内容/状态签名变化」。签名漏掉行高时，标题换行后宽度没变，线路图会停在旧几何（实测短 20px）。

## Decision

- `drawRail` 前先判：stage 尺寸为 0（隐藏）直接跳过；绘制签名没变时跳过。隐藏期间的 0 尺寸不再清空 SVG，显示时尺寸恢复、签名相同就保留原来那层（含动画节点）。
- 签名由 `src/client/board-rail-signature.js` 的纯函数 `railSignature` 生成，覆盖 `drawRail` 实测的全部输入：`railKey`（行身份、卡面信号、槽位状态）、走线方式、主题、减少动效、stage 宽高、每行相对 stage 的 `top` / `height`。行几何单独进签名：`clientHeight` 取整，亚像素变化与「一行增高、一行变矮」未必体现；行坐标已减掉 stage 原点，滚动不改变签名。
- 签名抽成纯函数是为了可测：`board-rail.js` 是登记的单测不可加载文件，签名本身不碰 DOM，`tests/board-rail-signature.test.js` 直接断言哪些变化必须改签名。
- `ResizeObserver` 回调改成 80ms 尾防抖：尺寸连续变化时只画最后一次，不再每帧重建。

## Alternatives considered

- **保留动画相位（负 `begin`/`animation-delay`）**：能让必要的重建也从当前相位接上，但 SMIL 在节点后插入时按文档时间还是插入时间采样，浏览器行为没有把握；先解决「本来不用重画却重画」。
- **按时间戳/定时重画**：每隔一段时间无条件重画或按时间窗口节流，会在隐藏期间与轮询稳定期反复重建 SMIL 节点、动画反复起跑，正是本次要消除的现象；签名只在输入真的变了时才画，代价是必须把几何输入列全。
- **只带 `stage.clientHeight`**：覆盖不了「总高不变、行位置变化」与 `clientHeight` 取整漏掉的亚像素变化；多读几行 `getBoundingClientRect` 换更稳的判据。
- **改宿主用 `visibility`/`transform` 隐藏会话**：在宿主仓库，且影响主面板布局与无障碍；插件不能改。
- **把看板 DOM 跨会话搬过去**：宿主没有跨会话 pin 面板的公开入口，看板是每会话一份 tab body。
- **只在 `railKey` 变化时重画、去掉尺寸监听**：右栏宽度变化（拖拽、窗口缩放）会让线路错位。

## Consequences

- 会话来回切时线路图节点不重建，光点连续跑；切到第一次打开且右栏收起的 worker 仍有宿主自己的面板滑入。
- 拖拽右栏宽度时线路图在**整个拖拽期间**停在旧宽度上（错位），停手 80ms 后才对齐；这是尾防抖的代价，换来不逐帧重建、动画不反复起跑。
- 隐藏期间卡片轮询暂停（`board.js` 的 `visible` 早退），签名不变；隐藏期间标题/行高真变了，显示后实测几何与签名不同，仍会重画一次。
- 触发仍只有 stage 的 `ResizeObserver` 与 `railKey` 变化：两行高度同一轮里一增一减、stage 总高恰好不变时 RO 不回调，这一层不会重画；签名已能表达这种差异，缺的是逐行观察（本次未做）。
- 首次打开一个收起的右栏仍会从 0 尺寸画一次，接受。

收益：会话来回切时线路图节点不重建、光点连续，不再每次切换都从头上路。

## Testing

- `tests/board-rail-signature.test.js`：相同输入同签名；行高、行位置、stage 高、宽度、内容、走线、主题、减少动效各自改签名。
- 真机探针（临时脚本，不入库）：标题 1→2 行后 stageH 198→218、trunkD `M20,32 L20,156`→`M20,32 L20,176`、`replaceChildren` +1；leader↔worker 切换计数 delta 0、sameTrunk true。
- 双向：签名回退成只带宽度 → 标题换行后 trunkD 不动（差 20px）；撤掉 0 尺寸跳过 → away `M0,0 L0,0`、切回重建；撤掉签名比较 → 切回重建。
- 未验证：真实 running 槽位下 SMIL 光点跨隐藏/恢复的相位（种子槽位全空闲）。
