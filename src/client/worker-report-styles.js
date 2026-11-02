/**
 * worker 回报气泡的样式。
 *
 * 颜色与圆角全部走宿主 `--dsw-*` 令牌，不写死色值。组件能从基线模块 import，样式
 * 拿不到：宿主包的 CSS module 在构建期编译成哈希类名、映射留在宿主产物里（包的
 * `./src/*` 导出指向源码，`files` 只发 `lib/`），跨 bundle 能引用的只有 CSS 变量。
 *
 * @module dsh-leader-kit/client/worker-report-styles
 */

const STYLE_ID = 'dsh-leader-kit-worker-report'

const STYLE_TEXT = `
.dsh-leader-kit-worker-report {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
}

.dsh-leader-kit-worker-report__identity {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dsh-leader-kit-worker-report__avatar {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  flex-shrink: 0;
}

.dsh-leader-kit-worker-report__name {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: inherit;
}

.dsh-leader-kit-worker-report__name:hover {
  color: var(--dsw-alias-label-primary);
  text-decoration: underline;
}

.dsh-leader-kit-worker-report__bubble {
  /* 行高取 compact 变体的值，与 MarkdownText 内部排版一致，否则折叠水位会差半行 */
  --dsh-leader-kit-report-line: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  /* 展开开关与正文之间留够呼吸位：2px 时它看着像最后一块内容的一部分 */
  gap: 6px;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
  /* 与宿主消息气泡同一材质：--dsw-specific-bubble 是主题给气泡的专属底色，
     自己按前景色混会偏灰，且深浅主题下强度不一致。宿主的用户气泡也没有描边。 */
  background: var(--dsw-specific-bubble);
  border: none;
  border-radius: var(--dsw-radius-xl);
  padding: 10px 16px 12px;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: var(--dsh-leader-kit-report-line);
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}

.dsh-leader-kit-worker-report__content {
  /* flex 容器里 align-items: flex-start 会让子项按内容收缩，显式撑满才不会提前换行 */
  width: 100%;
}

/* 同 card-detail-text：compact 变体把正文压成三级标签色、链接变成 inherit。
   容器类 + data-markdown-variant 是 (0,2,0)，压过 .compact 的 (0,1,0)；
   链接到 (0,2,1)，压过 .compact a 的 (0,1,1)——特异性更高，不靠注入顺序。 */
.dsh-leader-kit-worker-report__bubble [data-markdown-variant='compact'] {
  color: var(--dsw-alias-label-primary);
}

.dsh-leader-kit-worker-report__bubble [data-markdown-variant='compact'] a {
  color: var(--dsw-alias-link);
}

/* 旧消息（改造前落盘）没有 report，回退的是整条通知正文：子会话、状态、下一步
   是逐行的协议字段，按 Markdown 渲染会因软换行折成一段。这条路径保持纯文本。 */
.dsh-leader-kit-worker-report__plain {
  white-space: pre-wrap;
}

/* 默认只露两行：worker 的回报动辄一屏，协调者扫一眼摘要就够，细节按需展开。
   正文是块级元素（段落、列表、代码块），line-clamp 只能截纯文本行；按行高算
   max-height 才对块级内容生效。多出的 4px 是 compact 段落的上边距，不加会把第二行
   的下缘裁掉。裁剪只落在正文层，气泡内的展开按钮不跟着被截。 */
.dsh-leader-kit-worker-report__content[data-collapsed='true'] {
  max-height: calc(2 * var(--dsh-leader-kit-report-line) + 4px);
  overflow: hidden;
}

.dsh-leader-kit-worker-report__toggle {
  align-self: flex-start;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.dsh-leader-kit-worker-report__toggle:hover {
  color: var(--dsw-alias-label-secondary);
}

.dsh-leader-kit-worker-report__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 2px;
}

.dsh-leader-kit-worker-report__time {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-kit-worker-report__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.dsh-leader-kit-worker-report__copy:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color: var(--dsw-alias-label-secondary);
}
`

/**
 * 注入 worker 回报的样式（同一页面只注入一次）。
 * @returns {void}
 */
export function ensureWorkerReportStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}
