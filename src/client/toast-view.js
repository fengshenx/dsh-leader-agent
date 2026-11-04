/**
 * 提示条的浮层渲染。
 *
 * 挂在宿主的 `shell.overlay` 槽位上：那是跨栏的浮层座位，窄侧栏收起浮层时
 * 提示仍然可见。视觉照宿主自带的 Toast（顶部居中、暗色表面、不拦点击），
 * 只是文案由本插件给。
 *
 * @module dsh-leader-agent/client/toast-view
 */

import { createElement, Fragment, useEffect, useState } from 'react'
import { currentToast, dismissToast, subscribeToasts } from './toast.js'

const STYLE_ID = 'dsh-leader-agent-toast-style'

// client 侧的样式写在模板字符串里，不能出现反引号。
const STYLE_TEXT = `
.dsh-leader-agent-toast {
  position: fixed;
  top: 40px;
  left: 50%;
  z-index: 1100;
  pointer-events: none;
  width: max-content;
  max-width: min(640px, calc(100vw - 48px));
  padding: 12px 16px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  font-size: 14px;
  line-height: 22px;
  box-shadow: var(--dsw-shadow-lv3);
  transform: translateX(-50%);
  animation:
    dsh-leader-agent-toast-in 160ms ease-out,
    dsh-leader-agent-toast-fade 1000ms ease var(--dsh-leader-agent-toast-hold, 4000ms) forwards;
}
@keyframes dsh-leader-agent-toast-in {
  from { opacity: 0; transform: translate(-50%, -6px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes dsh-leader-agent-toast-fade {
  to { opacity: 0; visibility: hidden; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-leader-agent-toast {
    animation: dsh-leader-agent-toast-fade 1000ms ease var(--dsh-leader-agent-toast-hold, 4000ms) forwards;
  }
}
`

/**
 * 注入提示条样式表。同一页面只注入一次。
 * @returns {void}
 */
function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}

/**
 * 提示条浮层。
 * @returns {object | null} React 元素；没有提示时不渲染
 */
export function ToastOverlay() {
  const [toast, setToast] = useState(currentToast)

  useEffect(() => {
    ensureStyles()
    // 组件挂载前已经弹出的提示也要接上：通道错误往往发生在浮层挂载之前。
    setToast(currentToast())
    return subscribeToasts(() => setToast(currentToast()))
  }, [])

  useEffect(() => {
    if (toast === null) return undefined
    const timer = setTimeout(() => dismissToast(toast.id), toast.holdMs + toast.fadeMs)
    return () => clearTimeout(timer)
  }, [toast])

  if (toast === null) return null
  return createElement(
    Fragment,
    // key 跟着每次弹出换：同一条文案连着出现两次时重挂载，动画与计时都重来。
    { key: toast.id },
    createElement(
      'div',
      {
        className: 'dsh-leader-agent-toast',
        role: 'alert',
        style: { '--dsh-leader-agent-toast-hold': `${toast.holdMs}ms` },
      },
      toast.text,
    ),
  )
}
