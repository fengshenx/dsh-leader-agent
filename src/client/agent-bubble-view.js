/**
 * agent 消息气泡的渲染组件：leader 派来的任务与 worker 的回报共用。
 *
 * 形态：身份头（头像 + 名字）在气泡上方单独一行，气泡本身左对齐、用宿主消息气泡
 * 的底色、无描边——读起来像另一个 agent 在说话，而不是用户在说话。
 *
 * 正文按 `format` 交给宿主基线的 `MarkdownText`，逐行协议字段回退纯文本。默认只
 * 露两行，超出时给「展示更多」；气泡下方一行是时间与复制按钮，与官方消息的底部
 * chrome 同形。
 *
 * @module dsh-leader-agent/client/agent-bubble-view
 */

import { createElement, useLayoutEffect, useRef, useState } from 'react'
import { agentAvatarDataUri } from './worker-report-avatar.js'
import { ensureAgentBubbleStyles } from './agent-bubble-styles.js'
import { Markdown } from './markdown.js'
import { productIcon } from './icons.js'

/**
 * 把时间戳格式成消息时钟。
 *
 * 与宿主的 `formatMessageClock` 同口径（zh-CN 模板）：今天只显示时分；同年往日
 * 显示「M月D日 时分」；跨年再加年份。宿主按 i18n 模板渲染（英文环境下是
 * `M/D`），本仓不做多语言，固定用中文形态。
 *
 * @param {number} time - 毫秒时间戳
 * @returns {string} 时钟文本
 */
function formatBubbleClock(time) {
  const date = new Date(time)
  const now = new Date()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()) {
    return clock
  }
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  const md = date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}年${day}`
  return `${md} ${clock}`
}

/**
 * 渲染一条 agent 消息气泡。
 *
 * @param {object} props - 组件属性
 * @param {string} props.name - 说话方的显示名（身份头文本）
 * @param {string} props.avatarSeed - 头像种子；同名恒同图
 * @param {string} props.openTitle - 身份按钮的 title 提示
 * @param {() => void} [props.onOpenName] - 点击身份名时的动作（通常打开说话方的会话）
 * @param {string} props.body - 气泡正文
 * @param {'markdown' | 'text'} props.format - 正文渲染方式
 * @param {number} props.time - 消息时间（毫秒）
 * @returns {object} React 元素
 */
export function AgentBubble({ name, avatarSeed, openTitle, onOpenName, body, format, time }) {
  const [copied, setCopied] = useState(false)
  /** 是否展开全文。默认折叠：一条消息常常一屏，先给摘要。 */
  const [expanded, setExpanded] = useState(false)
  /** 折叠后是否真的有两行以上的内容——没有就不必给「展示更多」。 */
  const [overflowing, setOverflowing] = useState(false)
  const bubbleRef = useRef(null)

  // 样式必须在测量之前进 DOM，所以放在 layout 阶段而不是被动 effect：后者晚于
  // 绘制，首帧的 clamp 规则还没生效，`scrollHeight === clientHeight` 会量成「没
  // 溢出」，气泡先铺开全文再收起。注入本身幂等，跟着 body 变化重入也无所谓。
  //
  // 只有折叠态才量：展开后 `scrollHeight === clientHeight`，一量就会把按钮收掉，
  // 用户也就点不回折叠了。宽度变化（窗口缩放、字体档位）要重算，所以也听 resize。
  useLayoutEffect(() => {
    ensureAgentBubbleStyles()
    const element = bubbleRef.current
    if (element === null || expanded) return undefined
    const measure = () => { setOverflowing(element.scrollHeight > element.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [body, expanded])

  /**
   * 把正文复制到剪贴板。
   * @returns {Promise<void>} 复制完成
   */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body)
    } catch {
      // 剪贴板不可用（非安全上下文或权限被拒）：静默跳过，不打断阅读。
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return createElement(
    'div',
    { className: 'dsh-leader-agent-agent-bubble' },
    createElement(
      'div',
      { className: 'dsh-leader-agent-agent-bubble__identity' },
      createElement('img', {
        className: 'dsh-leader-agent-agent-bubble__avatar',
        src: agentAvatarDataUri(avatarSeed),
        alt: '',
      }),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-agent-bubble__name',
          title: openTitle,
          onClick: () => onOpenName?.(),
        },
        name,
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-agent-bubble__bubble' },
      // 裁剪只发生在正文层：按钮在气泡内、正文外，否则展开开关会跟着两行水位被裁掉
      createElement(
        'div',
        {
          ref: bubbleRef,
          className: 'dsh-leader-agent-agent-bubble__content',
          'data-collapsed': expanded ? undefined : 'true',
        },
        format === 'markdown'
          ? createElement(Markdown, { source: body })
          : createElement('div', { className: 'dsh-leader-agent-agent-bubble__plain' }, body),
      ),
      overflowing
        ? createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-leader-agent-agent-bubble__toggle',
              'aria-expanded': expanded,
              onClick: () => setExpanded((value) => !value),
            },
            expanded ? '收起' : '展示更多',
          )
        : null,
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-agent-bubble__meta' },
      createElement('span', { className: 'dsh-leader-agent-agent-bubble__time' }, formatBubbleClock(time)),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-agent-bubble__copy',
          'aria-label': copied ? '已复制' : '复制',
          title: copied ? '已复制' : '复制',
          onClick: () => { void copy() },
        },
        productIcon(copied ? 'check-outline' : 'copy-outline', { size: 14 }),
      ),
    ),
  )
}
