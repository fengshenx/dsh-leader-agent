/**
 * 看板样式表。
 *
 * 材质与几何全部取宿主的共享令牌，不写死数值：卡面是宿主「行内卡片」的
 * 组合——`--dsw-alias-bg-layer-2` 底、`--dsw-elevation-stroke` 发丝描边、
 * `--dsw-radius-*` 圆角，hover 换描边档并升到 `--dsw-elevation-panel`；
 * 焦点环走 `--dsw-focus-ring-*`。同构的实现是宿主
 * `client-ui-agent-team` 的成员卡。
 *
 * 数值约定：8px 卡间距、13px 标题、11px 弱化文字与元信息；卡面内容共用左缘，
 * 只有会话行用发丝线另起一组。颜色一律走宿主 `--dsw-*` 令牌，不写死色值。
 * 宿主跨 bundle 共享的是组件（`PLATFORM_MODULES` 里的 `ui-primitives`，见
 * `markdown.js`），它们的 CSS module 不在这张表里，也没有 Tailwind 可用，
 * 因此样式只能自注入（沿用 `modal-shell.js` 的做法）。
 *
 * @module dsh-leader-agent/client/board-styles
 */

/** 样式表 id，同一页面只注入一次。 */
const STYLE_ID = 'dsh-leader-agent-board'

/**
 * 样式表内容。类名统一 `dsh-leader-agent-board-*` 前缀，避免与宿主样式撞名。
 */
const STYLE_TEXT = `
.dsh-leader-agent-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.dsh-leader-agent-board-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 24px;
  /* 滚动条档位不在这里重绑：看板所在的宿主 paneBody/floatBody 已按浮起面绑成
     l2，本层再绑一次只是同值重复；写 body 的基础档反而会在浮起面上读成脏印 */
}

.dsh-leader-agent-board-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 卡面：宿主行内卡片材质——bg-layer-2 底 + elevation-stroke 发丝描边，
   hover 换描边档并升到 panel 投影。与 client-ui-agent-team 的成员卡同构：
   重绑 stroke 色而不叠 border——中性 border 配 elevation 阴影被宿主
   ui-theme 的 elevation spec 拒绝。静态取 l3 而不是成员卡的 l2：看板卡在
   浅色 sidebar 上独自立着，没有弹出面板的暗底衬着，l2 在 1x 屏读不出边界。 */
.dsh-leader-agent-board-card {
  display: block;
  box-sizing: border-box;
  width: 100%;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-2);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-elevation-stroke);
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition:
    box-shadow var(--ds-transition-duration) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration) var(--ds-ease-in-out);
}

@media (hover: hover) {
  .dsh-leader-agent-board-card:hover {
    --dsw-elevation-stroke-color: var(--dsw-alias-border-l4);
    box-shadow: var(--dsw-elevation-panel);
  }
}

/* 卡面在贴边滚动容器里，外扩焦点环会被裁掉，用内嵌环 */
.dsh-leader-agent-board-card:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}

/* 头部：左侧只读身份（#编号 / 分类），右侧主信号。两侧都不进 Tab 序，
   整行宽度留给标题；头部与标题之间只留 4px，保持同组紧凑 */
.dsh-leader-agent-board-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.dsh-leader-agent-board-card-id {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 信号灯槽：固定 14px，头部右端不随编号/分类宽度漂移 */
.dsh-leader-agent-board-signal-slot {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 16px;
}

/* 图形点的弱化沿用 alpha：这里没有「比 tertiary 更浅」的 token 档，而点要的是
   面积上的退让而不是色相的语义。文字类弱化一律换档不叠 alpha（编号/时间用
   label-caption、折叠开关用 label-secondary），两条界线互不越界。
   --dsh-leader-agent-signal-tone 同时供实心与空心使用：空心灯只把填充换成
   1px 描边，色相不动——停滞是形状变化，不是另一档状态色 */
.dsh-leader-agent-board-signal {
  display: inline-block;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  corner-shape: round;
  --dsh-leader-agent-signal-tone: var(--dsw-alias-label-tertiary);
  background: var(--dsh-leader-agent-signal-tone);
  opacity: 0.4;
}

/* 等你输入与未读同色不同动效：都在等你动作，但「有人在等」与「有结果没看」不同 */
.dsh-leader-agent-board-signal-waiting {
  --dsh-leader-agent-signal-tone: var(--dsw-static-blue-500);
  opacity: 1;
  animation: dsh-leader-agent-board-pulse 1.6s ease-in-out infinite;
}

.dsh-leader-agent-board-signal-unread {
  --dsh-leader-agent-signal-tone: var(--dsw-static-blue-500);
  opacity: 1;
}

.dsh-leader-agent-board-signal-running {
  --dsh-leader-agent-signal-tone: var(--dsw-alias-state-warn-primary);
  opacity: 1;
  animation: dsh-leader-agent-board-pulse 1.6s ease-in-out infinite;
}

.dsh-leader-agent-board-signal-attention {
  --dsh-leader-agent-signal-tone: var(--dsw-alias-state-error-primary);
  opacity: 1;
}

.dsh-leader-agent-board-signal-idle {
  --dsh-leader-agent-signal-tone: var(--dsw-alias-label-tertiary);
  opacity: 0.55;
}

/* 未派工与状态未知共用虚线圈：两者都不谎称空闲，形状上与实心档区分 */
.dsh-leader-agent-board-signal-unknown,
.dsh-leader-agent-board-signal-none {
  --dsh-leader-agent-signal-tone: var(--dsw-alias-label-tertiary);
  background: transparent;
  border: 1px dashed var(--dsw-alias-label-tertiary);
  opacity: 0.55;
}

/* 停滞：实心改空心（1px 状态色描边）。卡面不再写「停了多久」，形状就是全部
   信息；与 unknown/none 的虚线区分开——停滞是确定的空闲，不是不可知 */
.dsh-leader-agent-board-signal-hollow {
  background: transparent;
  border: 1px solid var(--dsh-leader-agent-signal-tone);
}

@keyframes dsh-leader-agent-board-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .dsh-leader-agent-board-signal-running,
  .dsh-leader-agent-board-signal-waiting { animation: none; }
}

.dsh-leader-agent-board-card-number {
  flex: none;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-caption);
}

/* 分类：只读元信息用纯文本，不加填充块、圆角或图标——填充块会被读成按钮，
   而同一张卡里真正可点的链接与会话入口会因此失去示能差。超长截断而不是
   撑宽头部：编号与信号灯都不该被分类挤走 */
.dsh-leader-agent-board-card-kind {
  min-width: 0;
  max-width: 140px;
  overflow: hidden;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-leader-agent-board-card-kind-separator {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

/* 标题独占一行：窄栏单行截断看不清任务内容，两行覆盖绝大多数标题；左缘与
   下方链接/会话一致。medium 而非 semibold——信号灯与状态色已承担强调 */
.dsh-leader-agent-board-card-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* 链接行：与标题同左缘（卡面 padding）。默认一行，放不下的由「+N」收起；
   padding-bottom 1px 给 3px 下划线的下沉留位，否则收起态的 overflow 会裁掉它 */
.dsh-leader-agent-board-card-links {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  padding-bottom: 1px;
  overflow: hidden;
  white-space: nowrap;
}

/* 展开态：全部直出并自然换行。不再裁切，焦点环与下划线都完整 */
.dsh-leader-agent-board-card-links-expanded {
  flex-wrap: wrap;
  overflow: visible;
  row-gap: 4px;
  white-space: normal;
}

/* 测量层：全量链接与「+N」的不可见副本（visibility: hidden 仍参与布局），
   只用来量真实宽度，不承载交互。标签必须与真实链接同构（a / button）——
   UA 默认样式只要有一条没被覆盖，量出的宽度就和渲染不一致 */
.dsh-leader-agent-board-links-measure {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  visibility: hidden;
  pointer-events: none;
}

/* 链接：宿主「可点击产物链接」的示能——link 色 + 500 字重、默认无下划线、
   hover 与键盘焦点同为 3px offset 点状下划线。不再套发丝线圆角壳：卡面里
   链接是文本入口，容器是整张卡；两种形状语言混在一起会抢标题。
   max-width 取 110px 内容宽，长标签截断；测量层与真实链接同一个 class */
.dsh-leader-agent-board-link {
  display: inline-flex;
  flex: none;
  align-items: center;
  box-sizing: border-box;
  max-width: 110px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-link);
  cursor: pointer;
  text-decoration: none;
  overflow: hidden;
}

/* 收起态是 overflow: hidden 的横向裁切带，外扩焦点环只剩左右两段弧，
   所以焦点环改内嵌；下划线示能与 hover 一致 */
.dsh-leader-agent-board-link:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}

@media (hover: hover) {
  .dsh-leader-agent-board-link:hover {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
}

.dsh-leader-agent-board-link-body {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.dsh-leader-agent-board-link-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「+N / 收起」：与链接同一行，但它是展开开关而非跳转目标——等宽、三级标签色，
   悬停提亮到二级；不加箭头，避免与卡面上真正会改变页面位置的入口混淆 */
.dsh-leader-agent-board-link-overflow {
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

@media (hover: hover) {
  .dsh-leader-agent-board-link-overflow:hover {
    color: var(--dsw-alias-label-secondary);
    text-decoration: none;
  }
}

/* 会话行：全部直出、自然换行，用一条发丝线把「谁在做」与「产物在哪」分开。
   行间 4px 纵向、12px 横向——不形成等宽按钮矩阵，角色数增长时不会变成按钮墙 */
.dsh-leader-agent-board-card-slots {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}

/* 会话入口：状态点 + 角色名 + 方向箭头。hover 与键盘焦点给背景块并显示箭头；
   箭头取 link 色，表达「会跳走」，而状态色只留给状态点 */
.dsh-leader-agent-board-slot {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  margin-left: -4px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--dsw-radius-xs);
  background: transparent;
  font-size: 11px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.dsh-leader-agent-board-slot:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
  color: var(--dsw-alias-label-primary);
}

.dsh-leader-agent-board-slot:focus-visible .dsh-leader-agent-board-slot-arrow {
  opacity: 1;
}

@media (hover: hover) {
  .dsh-leader-agent-board-slot:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }

  .dsh-leader-agent-board-slot:hover .dsh-leader-agent-board-slot-arrow {
    opacity: 1;
  }
}

.dsh-leader-agent-board-slot-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-leader-agent-board-slot-arrow {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-link);
  opacity: 0;
  transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out);
}

.dsh-leader-agent-board-slot-dot {
  display: inline-block;
  box-sizing: border-box;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.4;
}

.dsh-leader-agent-board-slot-dot-waiting {
  background: var(--dsw-static-blue-500);
  opacity: 1;
  animation: dsh-leader-agent-board-pulse 1.6s ease-in-out infinite;
}

.dsh-leader-agent-board-slot-dot-unread {
  background: var(--dsw-static-blue-500);
  opacity: 1;
}

.dsh-leader-agent-board-slot-dot-running {
  background: var(--dsw-alias-state-warn-primary);
  opacity: 1;
  animation: dsh-leader-agent-board-pulse 1.6s ease-in-out infinite;
}

.dsh-leader-agent-board-slot-dot-attention {
  background: var(--dsw-alias-state-error-primary);
  opacity: 1;
}

.dsh-leader-agent-board-slot-dot-idle {
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.55;
}

.dsh-leader-agent-board-slot-dot-unknown,
.dsh-leader-agent-board-slot-dot-empty {
  background: transparent;
  border: 1px dashed var(--dsw-alias-label-tertiary);
  opacity: 0.55;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-leader-agent-board-slot-dot-running,
  .dsh-leader-agent-board-slot-dot-waiting { animation: none; }
}

/* done 卡：单行轻量变体。成品不需要抢注意力，就没有卡面材质——
   透明的行，靠 hover 与 active 卡的卡面区分 */
.dsh-leader-agent-board-card-done {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  gap: 8px;
  width: 100%;
  border: 0;
  border-radius: var(--dsw-radius-md);
  padding: 6px 10px;
  background: transparent;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration) var(--ds-ease-in-out);
}

@media (hover: hover) {
  .dsh-leader-agent-board-card-done:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-leader-agent-board-card-done:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}

.dsh-leader-agent-board-done-check {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-state-success-primary);
}

.dsh-leader-agent-board-done-title {
  flex: 1;
  min-width: 0;
  /* 与卡号同字号：完成区是历史浏览，字号不该比卡号更抢眼 */
  font-size: 11px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-leader-agent-board-done-time {
  flex: none;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-caption);
}

/* done 折叠区 */
.dsh-leader-agent-board-done-section {
  margin-top: 16px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}

.dsh-leader-agent-board-done-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  border-radius: var(--dsw-radius-md);
  padding: 6px 4px;
  background: transparent;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  text-align: left;
}

@media (hover: hover) {
  .dsh-leader-agent-board-done-toggle:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-leader-agent-board-done-chevron {
  flex: none;
  display: inline-flex;
  transition: transform 200ms var(--ds-ease-in-out);
}

.dsh-leader-agent-board-done-chevron-open {
  transform: rotate(90deg);
}

.dsh-leader-agent-board-done-count {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

/* 「展开其余 / 收起」：外观照宿主工作区树的 overflow 按钮（12px、三级标签色、
   等宽行高，悬停提亮到二级色），左内边距与 done 行卡面对齐 */
.dsh-leader-agent-board-done-more {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 28px;
  text-align: left;
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-board-done-more:hover {
    color: var(--dsw-alias-label-secondary);
  }
}

/* 骨架与空态 */
.dsh-leader-agent-board-skeleton {
  height: 64px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-skeleton);
  animation: dsh-leader-agent-board-fade 1.4s ease-in-out infinite;
}

@keyframes dsh-leader-agent-board-fade {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@media (prefers-reduced-motion: reduce) {
  .dsh-leader-agent-board-skeleton { animation: none; }
}

.dsh-leader-agent-board-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 0;
  text-align: center;
}

.dsh-leader-agent-board-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-board-empty-icon-success {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.dsh-leader-agent-board-empty-title {
  margin-top: 12px;
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-leader-agent-board-empty-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* 卡片详情浮层内容 */
.dsh-leader-agent-card-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 80vh;
}

.dsh-leader-agent-card-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 24px 24px 8px;
}

.dsh-leader-agent-card-detail-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.dsh-leader-agent-card-detail-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: -6px -6px 0 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-card-detail-close:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-leader-agent-card-detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 24px 12px;
}

.dsh-leader-agent-card-detail-number {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-caption);
}

/* 分类与卡面头部同一套判据与形状：纯文本、不套容器 */
.dsh-leader-agent-card-detail-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 240px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-leader-agent-card-detail-kind-separator {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-card-detail-status {
  padding: 2px 8px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-card-detail-status-done {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.dsh-leader-agent-card-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px 24px;
}

.dsh-leader-agent-card-detail-section {
  margin-top: 16px;
}

.dsh-leader-agent-card-detail-section:first-child {
  margin-top: 0;
}

.dsh-leader-agent-card-detail-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dsh-leader-agent-card-detail-section-title {
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-card-detail-section-action {
  padding: 2px 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-card-detail-section-action:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-leader-agent-card-detail-section-action:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}

.dsh-leader-agent-card-detail-text {
  margin-top: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

/* 宿主 compact 变体把正文压成三级标签色：.markdown 与 .compact 挂在同一个根节点上、
   特异性同为 (0,1,0)，.compact 靠源顺序压过 .markdown 的 primary。链接同理——
   .compact a 的 color: inherit 压过 .markdown a 的 --dsw-alias-link。
   这里用宿主暴露的 data-markdown-variant 钩子把容器内的正文与链接压回原色：
   容器类 + 属性选择器是 (0,2,0)，高于 .compact 的 (0,1,0)；链接再叠标签选择器到
   (0,2,1)，高于 .compact a 的 (0,1,1)。特异性严格更高，不依赖样式表注入顺序。 */
.dsh-leader-agent-card-detail-text [data-markdown-variant='compact'] {
  color: var(--dsw-alias-label-primary);
}

.dsh-leader-agent-card-detail-text [data-markdown-variant='compact'] a {
  color: var(--dsw-alias-link);
}

.dsh-leader-agent-card-detail-muted {
  margin-top: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-card-detail-links {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
}

.dsh-leader-agent-card-detail-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-link);
  text-decoration: none;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3);
}

@media (hover: hover) {
  .dsh-leader-agent-card-detail-link:hover {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
}

/* 键盘焦点与 hover 同一示能；不可跳转的链接渲染成 div，不在此列 */
.dsh-leader-agent-card-detail-link:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.dsh-leader-agent-card-detail-link:last-child {
  border-bottom: 0;
}

.dsh-leader-agent-card-detail-link-purpose {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 链接编辑态：每行一张小卡，标签窄、URL 占宽，用途与增删都在行内。 */
.dsh-leader-agent-link-editor {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dsh-leader-agent-link-editor-empty {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-link-editor-row {
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}

.dsh-leader-agent-link-editor-main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dsh-leader-agent-link-editor-label,
.dsh-leader-agent-link-editor-url,
.dsh-leader-agent-link-editor-purpose {
  box-sizing: border-box;
  height: 28px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-elevated-fill);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  outline: none;
}

.dsh-leader-agent-link-editor-label {
  flex: none;
  width: 88px;
}

.dsh-leader-agent-link-editor-url {
  flex: 1 1 auto;
  min-width: 0;
}

.dsh-leader-agent-link-editor-purpose {
  width: 100%;
  height: 24px;
  margin-top: 6px;
  font-size: 12px;
}

.dsh-leader-agent-link-editor-label:focus-visible,
.dsh-leader-agent-link-editor-url:focus-visible,
.dsh-leader-agent-link-editor-purpose:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}

.dsh-leader-agent-link-editor-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-link-editor-remove:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-leader-agent-link-editor-add-purpose {
  margin-top: 4px;
  padding: 1px 4px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-link-editor-add-purpose:hover {
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-leader-agent-link-editor-add {
  align-self: flex-start;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-link-editor-add:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-leader-agent-link-editor-error {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.dsh-leader-agent-link-editor-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dsh-leader-agent-link-editor-button {
  padding: 4px 12px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-link-editor-button:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-leader-agent-link-editor-button-primary {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-2);
}

@media (hover: hover) {
  .dsh-leader-agent-link-editor-button-primary:hover {
    background: var(--dsw-alias-label-primary);
    opacity: 0.9;
  }
}

.dsh-leader-agent-link-editor-button:disabled {
  cursor: default;
  opacity: 0.5;
}

/* 右栏 guide 页的入口胶囊：复刻宿主 EntryBox 的数值（380px 宽、56px 最小高、
   14/20 内边距、14px 图标间距），宿主改样式时这里要跟着改。 */
.dsh-leader-agent-guide-entry {
  display: flex;
  gap: 14px;
  align-items: center;
  box-sizing: border-box;
  width: 380px;
  max-width: 100%;
  min-height: 56px;
  padding: 14px 20px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xl);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-guide-entry:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-leader-agent-guide-entry-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-leader-agent-guide-entry-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dsh-leader-agent-guide-entry-title {
  overflow: hidden;
  font-size: 14px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dsh-leader-agent-guide-entry-description {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* leader 会话的一次性引导条：与输入框同一套几何——宽度共用宿主给输入框外壳的
   --dsh-composer-card-max-width（同一个 token，窗口变窄时一起收），圆角同取
   --dsw-radius-panel。材质刻意比输入框轻一档：输入框是白面 + elevation-soft，
   引导条取交互悬停档的浅底、不叠投影，两块叠在一起才不会被读成两个输入框。
   文字档对齐宿主正文：标题 14/22 500，步骤 13/20（宿主里 11/12 只用于元信息，
   提示正文不该比它更小）。 */
.dsh-leader-agent-guide-card {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 10px;
  box-sizing: border-box;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 952px);
  margin: 0 auto 8px;
  padding: 10px 14px;
  border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* 图标与标题首行对齐：标题行高 22、图标 16，下沉 3px 才落在同一基线上 */
.dsh-leader-agent-guide-icon {
  margin-top: 3px;
  color: var(--dsw-alias-label-tertiary);
}

/* flex:1 + min-width:0：文本块吃掉动作左侧的全部宽度，右侧不留空；
   min-width 是为了窄窗口下让文字换行而不是把动作挤出去 */
.dsh-leader-agent-guide-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dsh-leader-agent-guide-title {
  font-size: var(--dsw-font-s-strong-14-font-size);
  line-height: var(--dsw-font-s-strong-14-line-height);
  font-weight: var(--dsw-font-s-strong-14-font-weight);
  color: var(--dsw-alias-label-primary);
}

.dsh-leader-agent-guide-steps {
  font-size: var(--dsw-font-xs-13-font-size);
  line-height: var(--dsw-font-xs-13-line-height);
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-guide-actions {
  display: flex;
  flex: none;
  gap: 4px;
  margin-left: auto;
}
`

/**
 * 注入样式表。同一页面只注入一次。
 * @returns {void}
 */
export function ensureBoardStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}
