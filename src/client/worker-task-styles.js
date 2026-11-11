/**
 * leader 任务气泡的样式：与用户自己的消息同形（右对齐、无身份头）。
 *
 * 颜色与圆角全部走宿主 `--dsw-*` 令牌，不写死色值。形态照宿主用户消息的
 * `UserMessageBubble` 与 `userStack`（`packages/client/ui-primitives/src/UserMessageBubble.module.css`、
 * `packages/client/ui-chat/src/client/chat/MessageItem.module.css`）：同一个气泡底色、
 * 圆角、内边距与 `white-space: pre-wrap`，宽度上限同样取内容栏的 70.2%。正文因此
 * 和宿主用户消息一样保留单换行，不做行级改写。
 *
 * 不能直接 import 宿主的 `UserMessageBubble`：它是 rc.2 之后才加进基线
 * `ui-primitives` 的导出，本仓 `engines.dsh` 下限仍是 rc.2，静态 import 在旧宿主上
 * 拿到 `undefined`。组件本身只是一层带类名的 div，样式按令牌照抄即可。
 *
 * @module dsh-leader-agent/client/worker-task-styles
 */

const STYLE_ID = 'dsh-leader-agent-worker-task'

const STYLE_TEXT = `
.dsh-leader-agent-worker-task {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  width: 100%;
}

.dsh-leader-agent-worker-task__bubble {
  box-sizing: border-box;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
  /* 与宿主消息气泡同一材质：--dsw-specific-bubble 是主题给气泡的专属底色，
     自己按前景色混会偏灰，且深浅主题下强度不一致。用户气泡没有描边。 */
  background: var(--dsw-specific-bubble);
  border: none;
  border-radius: var(--dsw-radius-xl);
  padding: 10px 16px;
  font-size: var(--dsh-content-font-size, 14px);
  /* 与宿主用户气泡一致：pre-wrap 保留原文换行；22px 是宿主气泡的行高。 */
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.dsh-leader-agent-worker-task__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 2px;
}

.dsh-leader-agent-worker-task__time {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-worker-task__copy {
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

.dsh-leader-agent-worker-task__copy:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color: var(--dsw-alias-label-secondary);
}
`

/**
 * 注入 leader 任务气泡的样式（同一页面只注入一次）。
 * @returns {void}
 */
export function ensureWorkerTaskStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}
