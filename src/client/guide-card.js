/**
 * leader 会话的一次性引导卡。
 *
 * 「加项目」会当场建一个 leader 会话，界面上一句话都没有：用户不知道要先写两份
 * 项目提示词，也不知道项目行就是 leader 的入口。这里在会话「还没有任何消息」时
 * 往输入框上方放一张卡，三行说完下一步；发出第一句话后 `blank` 变假、卡片自然
 * 消失，也可以点「知道了」关掉并记住。
 *
 * 卡片纯本地渲染：不写转录、不产生模型调用、不自动发消息——引导出现期间会话
 * 事件数仍为 0。
 *
 * 挂在 `conversation.input.dock`（会话作用域的 list 槽位，宿主注释是
 * "Full-width entries above the composer card"）：条目渲染空内容时不占空间，
 * 与 leader 视图入口共用同一个槽。
 *
 * @module dsh-leader-agent/client/guide-card
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, useEffect, useState } from 'react'
import { ensureBoardStyles } from './board-styles.js'
import { productIcon } from './icons.js'
import {
  canSendIntro,
  createGuideDismissal,
  readLocalStorage,
  sendIntroPrompt,
  shouldShowGuide,
} from './guide-card-logic.js'
import { leaderSessionIndex } from './leader-session-index.js'
import { SLOT_LOCALE_NAMESPACE } from './locales.js'

/**
 * 关闭标记的读写口。
 *
 * 每次渲染重新取存储而不是模块级缓存：访问 `localStorage` 这个属性在隐私模式
 * 会抛，缓存失败结果会让「已关过」的会话下次渲染又弹出来。
 *
 * @returns {{ isDismissed: (sessionId: string) => boolean, dismiss: (sessionId: string) => void }} 读写口
 */
function dismissal() {
  return createGuideDismissal(readLocalStorage(globalThis))
}

/**
 * 引导卡条目。
 *
 * @param {object} props - 槽位属性
 * @param {string} props.sessionId - 当前会话 id
 * @param {{ blank: boolean }} props.session - 当前会话快照（`InputZone.session`）
 * @param {{ setDraft?: Function, submit?: Function } | undefined} props.inputActions - 宿主输入机（会话作用域标准 props）
 * @param {(key: string) => string} props.t - 当前语言的翻译函数
 * @returns {object | null} React 元素；不该出现时为 null
 */
export function GuideCardEntry(props) {
  const { sessionId, session, inputActions, t } = props
  const [isLeader, setIsLeader] = useState(() => leaderSessionIndex.getSnapshot().has(sessionId))
  const [dismissed, setDismissed] = useState(() => dismissal().isDismissed(sessionId))

  useEffect(() => leaderSessionIndex.subscribe((ids) => {
    setIsLeader(ids.has(sessionId))
  }), [sessionId])
  useEffect(() => { setDismissed(dismissal().isDismissed(sessionId)) }, [sessionId])
  useEffect(() => ensureBoardStyles(), [])

  if (!shouldShowGuide({ isLeader, blank: session?.blank === true, dismissed })) return null

  return createElement(
    'div',
    { className: 'dsh-leader-agent-guide-card' },
    createElement('span', { className: 'dsh-leader-agent-guide-icon' }, productIcon('checklist-outline', { size: 16 })),
    createElement(
      'div',
      { className: 'dsh-leader-agent-guide-body' },
      createElement('div', { className: 'dsh-leader-agent-guide-title' }, t('guide.title')),
      createElement('div', { className: 'dsh-leader-agent-guide-steps' }, t('guide.steps')),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-guide-actions' },
      // 与 sendIntroPrompt 共用同一个判定：只差一半能力时（比如有 submit 没有
      // setDraft）宁可不画，也不留一个点了没反应的按钮。
      canSendIntro(inputActions) === false ? null : createElement(Button, {
        size: 'sm',
        variant: 'outline',
        onClick: () => { sendIntroPrompt(inputActions, t('guide.intro.prompt')) },
      }, t('guide.action.intro')),
      createElement(Button, {
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          dismissal().dismiss(sessionId)
          setDismissed(true)
        },
      }, t('guide.action.dismiss')),
    ),
  )
}

/**
 * 注册引导卡。
 *
 * order 取 90：同槽的 leader 视图入口（100）不渲染内容，顺序不影响观感，但卡片
 * 占住输入框正上方那一行。
 *
 * @param {object} ctx - 客户端 Cordis 上下文
 * @returns {void}
 */
export function mountGuideCard(ctx) {
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-leader-agent-guide',
    order: 90,
    locale: SLOT_LOCALE_NAMESPACE,
  }, GuideCardEntry)), 'dsh-leader-agent 引导卡')
}
