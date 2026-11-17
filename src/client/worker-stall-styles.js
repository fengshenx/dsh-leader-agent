/**
 * 后台巡查触发行的样式。
 *
 * 不复用 agent 气泡：气泡是「某个 agent 在说话」的形态，巡查是机制侧的一句话
 * 提示，用紧凑的整行更接近宿主的系统提示。颜色全部走宿主 `--dsw-*` 令牌。
 *
 * @module dsh-leader-agent/client/worker-stall-styles
 */

const STYLE_ID = 'dsh-leader-agent-stall-notice'

const STYLE_TEXT = `
.dsh-leader-agent-stall-notice {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 14px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-2);
  border-left: 2px solid var(--dsw-alias-state-warn-primary);
}

.dsh-leader-agent-stall-notice__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-stall-notice__icon {
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-state-warn-primary);
}

.dsh-leader-agent-stall-notice__badge {
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.dsh-leader-agent-stall-notice__name {
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.dsh-leader-agent-stall-notice__name:hover {
  color: var(--dsw-alias-label-primary);
  text-decoration: underline;
}

.dsh-leader-agent-stall-notice__time {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-stall-notice__body {
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
`

/**
 * 注入后台巡查触发行的样式（同一页面只注入一次）。
 * @returns {void}
 */
export function ensureWorkerStallStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}
