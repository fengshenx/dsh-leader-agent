/**
 * worker 回报气泡的渲染组件。
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
import { AVATAR_EYE_CLASS, buildAvatar } from './worker-report-avatar.js'
import { ensureAgentBubbleStyles } from './agent-bubble-styles.js'
import { formatBubbleClock } from './bubble-clock.js'
import { Markdown } from './markdown.js'
import { productIcon } from './icons.js'

/**
 * 渲染一条 worker 回报气泡。
 *
 * @param {object} props - 组件属性
 * @param {string} props.name - 说话方的显示名（身份头文本）
 * @param {string} props.avatarSeed - 头像种子；同名恒同图
 * @param {string} props.openTitle - 身份按钮的 title 提示
 * @param {() => void} [props.onOpenName] - 点击身份名时的动作（通常打开说话方的会话）
 * @param {string} props.body - 气泡正文
 * @param {'markdown' | 'text'} props.format - 正文渲染方式
 * @param {number} props.time - 消息时间（毫秒）
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 当前语言的翻译函数
 * @returns {object} React 元素
 */
export function AgentBubble({ name, avatarSeed, openTitle, onOpenName, body, format, time, t }) {
  const [copied, setCopied] = useState(false)
  /** 是否展开全文。默认折叠：一条消息常常一屏，先给摘要。 */
  const [expanded, setExpanded] = useState(false)
  /** 折叠后是否真的有两行以上的内容——没有就不必给「展示更多」。 */
  const [overflowing, setOverflowing] = useState(false)
  const bubbleRef = useRef(null)

  // 样式必须在测量之前进 DOM：clamp 规则生效后 `scrollHeight` 才反映真实溢出，
  // 否则会量成「没溢出」，气泡先铺开全文再收起。注入幂等，跟着 body 变化重入也
  // 无所谓。
  //
  // 读尺寸本身不放在 layout 阶段：`ResizeObserver.observe()` 会先投递一次初始
  // 尺寸，这次回调排在布局之后，读 `scrollHeight` 不会再触发排版。反过来在 layout
  // effect 里同步读，一次提交挂 N 条气泡就是 N 次强制排版（真机 trace：28 条气泡
  // 各一次样式重算 + 布局，共 163ms），而观察器那次本来就会把这些量掉。
  //
  // 只有折叠态才量：展开后 `scrollHeight === clientHeight`，一量就会把按钮收掉，
  // 用户也就点不回折叠了。宽度变化（窗口缩放、字体档位）要重算，所以也听 resize。
  useLayoutEffect(() => {
    ensureAgentBubbleStyles()
    const element = bubbleRef.current
    if (element === null || expanded) return undefined
    const measure = () => { setOverflowing(element.scrollHeight > element.clientHeight + 1) }
    if (typeof ResizeObserver === 'undefined') {
      // 没有观察器的引擎只能同步量一次；桌面与 Web 宿主都是 Chromium，走不到这里。
      measure()
      return undefined
    }
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

  const avatar = buildAvatar(avatarSeed)

  return createElement(
    'div',
    { className: 'dsh-leader-agent-agent-bubble' },
    createElement(
      'div',
      { className: 'dsh-leader-agent-agent-bubble__identity' },
      createElement(
        'span',
        { className: 'dsh-leader-agent-agent-bubble__avatar', 'aria-hidden': 'true' },
        createElement(
          'svg',
          { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 100 100', focusable: 'false', 'data-shape': avatar.shape },
          createElement(
            'g',
            { fill: avatar.head, stroke: avatar.stroke, strokeWidth: avatar.strokeWidth, strokeLinejoin: 'round' },
            avatar.body.map((d, index) => createElement('path', { key: index, d })),
          ),
          createElement(
            'g',
            { className: AVATAR_EYE_CLASS, fill: avatar.eye },
            avatar.eyes.map((d, index) => createElement('path', { key: index, d })),
          ),
        ),
      ),
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
          ? createElement(Markdown, { source: body, t })
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
            expanded ? t('common.collapse') : t('bubble.more'),
          )
        : null,
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-agent-bubble__meta' },
      createElement('span', { className: 'dsh-leader-agent-agent-bubble__time' }, formatBubbleClock(time, t)),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-agent-bubble__copy',
          'aria-label': copied ? t('bubble.copied') : t('bubble.copy'),
          title: copied ? t('bubble.copied') : t('bubble.copy'),
          onClick: () => { void copy() },
        },
        productIcon(copied ? 'check-outline' : 'copy-outline', { size: 14 }),
      ),
    ),
  )
}
