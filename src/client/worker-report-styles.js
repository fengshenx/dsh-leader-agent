/**
 * worker 回报气泡的样式。
 *
 * 颜色与圆角全部走宿主 `--dsw-*` 令牌，不写死色值——第三方 bundle 不能 import
 * 宿主 UI 包，只能引用它们已经落在页面上的 CSS 变量。
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
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
  /* 极淡底：按前景色混出几乎看不出的一层，靠 1px 边框交代气泡边界。 */
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xl);
  padding: 10px 16px;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 默认只露两行：worker 的回报动辄一屏，协调者扫一眼摘要就够，细节按需展开。 */
.dsh-leader-kit-worker-report__bubble[data-collapsed='true'] {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.dsh-leader-kit-worker-report__toggle {
  margin-top: -2px;
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
