/**
 * 协调者视图目标与主区域入口。
 *
 * 官方外壳对空会话一律渲染居中的欢迎页（`Into the Unknown`），输入框也跟着
 * 居中；只有会话进入 active 形态，输入框才停靠底部，而形态由
 * `conversationPhase` 判定——它看的是「有没有已激活的会话视图目标」。
 *
 * 这里注册一个只提供活动、不产出内容的第三方视图目标：协调者会话被打开时激活
 * 它，官方外壳就自己切到 active 形态，输入框落到底部，会话区是空的。目标不
 * 注册成可见 tab，所以所有会话的头部都不会多出标签。
 *
 * @module dsh-leader-kit/client/coordinator-view
 */

import { createElement, useLayoutEffect } from 'react'
import {
  activateCoordinatorView,
  createCoordinatorViewDefinition,
} from './coordinator-view-logic.js'
import { coordinatorSessionIndex } from './coordinator-session-index.js'

/**
 * 主区域入口：当前会话是协调者时激活协调者视图目标。
 *
 * 入口本身不渲染任何东西，它只是官方外壳的一个挂钩点。激活用 layout 副作用：
 * 它在浏览器绘制之前跑，官方外壳不会先闪一下居中欢迎页再跳到底部。
 *
 * @param {object} props - 槽位注入的属性
 * @param {string} props.sessionId - 当前会话 id
 * @param {() => object | undefined} props.getUiConversation - 取会话视图服务
 * @returns {object} React 元素
 */
export function CoordinatorViewEntry(props) {
  const { sessionId, getUiConversation } = props
  useLayoutEffect(() => coordinatorSessionIndex.subscribe((ids) => {
    if (!ids.has(sessionId)) return
    activateCoordinatorView(getUiConversation?.(), sessionId)
  }), [getUiConversation, sessionId])
  return null
}

/**
 * 注册协调者视图目标与主区域入口。
 *
 * @param {object} ctx - 客户端 Cordis 上下文（已注入 `uiConversation`）
 * @returns {void}
 */
export function mountCoordinatorView(ctx) {
  try {
    ctx.uiConversation.views.register(createCoordinatorViewDefinition())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`dsh-leader-kit: 协调者视图目标注册失败：${message}`)
    return
  }
  // 入口挂在输入框上方的 dock 槽：那里按会话渲染，入口拿得到当前会话 id，
  // 而宿主在会话打开后才会建绑定——正好是激活的时机。
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-leader-kit-view',
    order: 100,
    inject: () => ({
      getUiConversation: () => ctx.get('uiConversation'),
    }),
  }, CoordinatorViewEntry)), 'dsh-leader-kit 协调者视图入口')
}
