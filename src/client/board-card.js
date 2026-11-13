/**
 * 看板卡片行。
 *
 * 卡面零操作铬：只做信息与导航，不放操作按钮。active 卡按
 * 「编号 / 分类 + 信号灯 → 标题 → 链接 → 已挂载会话」组织；done 卡单行轻量
 * 变体。点卡面开详情，点链接跳目标，点会话打开该会话。
 *
 * 信息层级：编号与分类是只读元信息（纯文本、不进 Tab 序），主信号独占右上；
 * 标题独占一行、与下方内容共用左缘。链接放不下时「+N」**就地展开**，不再借
 * 开详情——入口位置与导航目标保持一致。会话入口全部直出并自然换行，不收进
 * 「+N」：状态点与角色名一眼可扫，才是「谁在这张卡上」的完整答案。
 *
 * 停滞不显示时长：卡面只由空心灯表达「停了」，时长不进卡面（不与状态争头部）。
 * 完成时间仍显示在 done 行——那是历史浏览的排序参考。
 *
 * 卡面根是 `role="button"` 且内嵌可聚焦控件，严格说这违反 ARIA 的「button 不含
 * 可聚焦后代」。这是刻意的取舍：整卡热区与嵌套控件并存，子控件保留独立
 * 按钮语义优先，键盘可达性由子控件自己保证。
 *
 * @module dsh-leader-agent/client/board-card
 */

import { createElement, memo, useLayoutEffect, useRef, useState } from 'react'
import {
  cardKind,
  cardSignal,
  fitLinkChips,
  formatDuration,
  isCardStalled,
  slotViewsForCard,
} from './board-projection.js'
import { isJumpableLink, linkRowKey, planLinkRow } from './link-row.js'
import { slotDisplayName } from './locales.js'
import { productIcon } from './icons.js'

/**
 * 键盘触发详情。
 *
 * 只在事件来自卡面根本身时触发：链接与会话是嵌套控件，它们的 Enter/Space 归自己。
 *
 * @param {object} event - 键盘事件
 * @param {object} card - 卡片
 * @param {(card: object, anchor: HTMLElement) => void} onOpenDetail - 开详情
 * @returns {void}
 */
function openDetailOnKey(event, card, onOpenDetail) {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    onOpenDetail(card, event.currentTarget)
  }
}

/**
 * 链接内容：只留标签文本。
 *
 * 卡面一行可能排到七八条链接，每条都前置一个链图标会连成一片点阵，比文字本身
 * 更抢眼——链接的类型识别留给详情浮层，卡面只表达「这里有哪些产物」。
 *
 * @param {object} link - 链接
 * @returns {object} React 元素
 */
function linkContent(link) {
  return createElement(
    'span',
    { className: 'dsh-leader-agent-board-link-body' },
    createElement('span', { className: 'dsh-leader-agent-board-link-label' }, link.label ?? ''),
  )
}

/**
 * 链接行：可见链接按实测宽度算，放不下的收进「+N」。
 *
 * 测量层是全量链接的不可见副本（`visibility: hidden` 仍参与布局），宽度变化
 * 后重排——收缩后仍能量到被收起的条目。展开态不再测量：全部直出并换行，
 * 行宽不再影响可见集合。
 *
 * @param {object} props - 组件属性
 * @param {object[]} props.links - 链接列表
 * @param {(anchor: HTMLElement) => void} props.onOpenDetail - 开详情
 * @returns {object} React 元素
 */
function BoardLinks({ links, onOpenDetail }) {
  const row = useRef(null)
  const measure = useRef(null)
  const [visibleCount, setVisibleCount] = useState(links.length)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const rowElement = row.current
    const measureElement = measure.current
    if (rowElement === null || measureElement === null) return undefined
    const fit = () => {
      if (expanded) return
      const widths = Array.from(measureElement.children)
        .map((element) => element.getBoundingClientRect().width)
      // 测量层最后一个固定是「+N」，取的是被收起链接数的上界（links.length）：
      // 实际收起几个要等排布结果出来才知道，只能按最坏情况留位——宁可少露一个
      // 条目，也不能让「+N」被挤出可视区。结构被改坏时 fitLinkChips 把非有限值当
      // 未测量，全量展示
      const overflowWidth = widths.pop() ?? 0
      // 间距取 CSS 的真值：JS 里再写一份常量，改样式时就会算错
      const gap = Number.parseFloat(getComputedStyle(rowElement).columnGap)
      setVisibleCount(fitLinkChips({
        availableWidth: rowElement.getBoundingClientRect().width,
        chipWidths: widths,
        overflowWidth,
        gap: Number.isFinite(gap) ? gap : 0,
      }))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(fit)
    observer.observe(rowElement)
    return () => observer.disconnect()
  }, [links, expanded])

  const plan = planLinkRow(links, expanded ? links.length : visibleCount)
  const indexed = links.map((link, index) => ({ link, index }))
  const shown = expanded ? indexed : indexed.slice(0, plan.visible.length)
  const overflow = expanded ? null : plan.overflow
  const remaining = links.slice(plan.visible.length)

  return createElement(
    'div',
    {
      ref: row,
      className: expanded
        ? 'dsh-leader-agent-board-card-links dsh-leader-agent-board-card-links-expanded'
        : 'dsh-leader-agent-board-card-links',
    },
    createElement(
      'div',
      { ref: measure, 'aria-hidden': 'true', className: 'dsh-leader-agent-board-links-measure' },
      links.map((link, index) => (isJumpableLink(link)
        ? createElement('a', {
            key: linkRowKey(link, index),
            href: link.url,
            tabIndex: -1,
            className: 'dsh-leader-agent-board-link',
          }, linkContent(link))
        : createElement('button', {
            key: linkRowKey(link, index),
            type: 'button',
            tabIndex: -1,
            className: 'dsh-leader-agent-board-link',
          }, linkContent(link)))),
      createElement(
        'button',
        { type: 'button', tabIndex: -1, className: 'dsh-leader-agent-board-link dsh-leader-agent-board-link-overflow' },
        plan.measureOverflow,
      ),
    ),
    shown.map(({ link, index }) => (isJumpableLink(link)
      ? createElement('a', {
          key: linkRowKey(link, index),
          href: link.url,
          target: '_blank',
          rel: 'noreferrer',
          title: link.purpose || link.url,
          className: 'dsh-leader-agent-board-link',
          onClick: (event) => { event.stopPropagation() },
        }, linkContent(link))
      : createElement('button', {
          key: linkRowKey(link, index),
          type: 'button',
          title: link.purpose || link.label,
          className: 'dsh-leader-agent-board-link',
          onClick: (event) => {
            event.stopPropagation()
            onOpenDetail(event.currentTarget)
          },
        }, linkContent(link)))),
    overflow !== null || expanded
      ? createElement('button', {
          type: 'button',
          'aria-expanded': expanded,
          title: expanded ? undefined : remaining.map((link) => link.label).join(' · '),
          className: 'dsh-leader-agent-board-link dsh-leader-agent-board-link-overflow',
          onClick: (event) => {
            event.stopPropagation()
            setExpanded((value) => !value)
          },
        }, expanded ? '收起' : overflow)
      : null,
  )
}

/**
 * 状态档位的中文名。
 *
 * 信号灯是纯图形，档位名只出现在 title 里。`unknown` 与 `none` 不是同义：
 * 前者是「读不到这个会话」，后者是「没有会话可读」。
 */
const STATE_LABELS = {
  waiting: '等你输入',
  attention: '需注意',
  running: '执行中',
  unread: '未读',
  idle: '空闲',
  empty: '未派工',
  unknown: '状态未知',
  none: '无信号',
}

/**
 * 会话入口：状态点 + 角色名，方向箭头只在 hover 与键盘焦点时出现。
 *
 * 显示名优先取项目 `SLOTS.md` 的 `label:`，其次内置槽位的 locale 翻译，最后
 * 是槽位名本身。槽位键仍是机器标识，不随显示名变化。
 *
 * @param {object} props - 组件属性
 * @param {object} props.slot - 槽位视图（已绑定会话）
 * @param {(sessionId: string) => void} props.onOpenSession - 打开会话
 * @param {Record<string, string> | undefined} props.labels - 项目下发的槽位显示名
 * @param {(key: string) => string} props.t - 当前语言的翻译函数
 * @returns {object} React 元素
 */
function BoardSlot({ slot, onOpenSession, labels, t }) {
  const stateLabel = STATE_LABELS[slot.state] ?? slot.state
  const name = slotDisplayName(slot.name, labels, t)
  return createElement(
    'button',
    {
      type: 'button',
      className: 'dsh-leader-agent-board-slot',
      title: `${name}：${stateLabel}`,
      onClick: (event) => {
        event.stopPropagation()
        onOpenSession(slot.sessionId)
      },
    },
    createElement('span', {
      className: `dsh-leader-agent-board-slot-dot dsh-leader-agent-board-slot-dot-${slot.state}`,
    }),
    createElement('span', { className: 'dsh-leader-agent-board-slot-name' }, name),
    createElement(
      'span',
      { className: 'dsh-leader-agent-board-slot-arrow', 'aria-hidden': 'true' },
      productIcon('chevron-right-outline', { size: 12 }),
    ),
  )
}

/**
 * 看板卡片行。
 *
 * @param {object} props - 组件属性
 * @param {object} props.card - 卡片
 * @param {Map<string, object>} props.states - 会话 id 到状态
 * @param {number} props.now - 当前时间戳
 * @param {(card: object, anchor: HTMLElement) => void} props.onOpenDetail - 开详情
 * @param {(sessionId: string) => void} props.onOpenSession - 打开会话
 * @param {Record<string, string> | undefined} props.slotLabels - 项目下发的槽位显示名
 * @param {(key: string) => string} props.t - 当前语言的翻译函数（槽位显示名）
 * @returns {object} React 元素
 */
function BoardCardView({ card, states, now, onOpenDetail, onOpenSession, slotLabels, t }) {
  const links = Array.isArray(card.links) ? card.links : []
  const done = card.status === 'done'

  if (done) {
    return createElement(
      'div',
      {
        className: 'dsh-leader-agent-board-card-done',
        role: 'button',
        tabIndex: 0,
        onClick: (event) => onOpenDetail(card, event.currentTarget),
        onKeyDown: (event) => openDetailOnKey(event, card, onOpenDetail),
      },
      createElement(
        'span',
        { className: 'dsh-leader-agent-board-done-check' },
        productIcon('check-circle-outline', { size: 14 }),
      ),
      createElement('span', { className: 'dsh-leader-agent-board-card-number' }, `#${card.number ?? '?'}`),
      createElement('span', { className: 'dsh-leader-agent-board-done-title', title: card.title }, card.title ?? ''),
      typeof card.doneAt === 'number'
        ? createElement('span', { className: 'dsh-leader-agent-board-done-time' }, formatDuration(card.doneAt, now))
        : null,
    )
  }

  const signal = cardSignal(card, states)
  // 没有会话的角色不占位：未派工由卡面信号灯表达，卡面只列「谁在这张卡上」
  const slots = slotViewsForCard(card, states).filter((slot) => slot.sessionId !== '')
  const stalled = isCardStalled(card, states, now)
  // attention 是混合态，红实心压过停滞：失败比停着更该先看。其余档位停滞
  // 一律降成空心灯——卡面不再用文字写「停了多久」
  const hollow = stalled && signal !== 'attention'
  const kind = cardKind(card)

  return createElement(
    'div',
    {
      className: 'dsh-leader-agent-board-card',
      role: 'button',
      tabIndex: 0,
      onClick: (event) => onOpenDetail(card, event.currentTarget),
      onKeyDown: (event) => openDetailOnKey(event, card, onOpenDetail),
    },
    createElement(
      'div',
      { className: 'dsh-leader-agent-board-card-head' },
      createElement(
        'span',
        { className: 'dsh-leader-agent-board-card-id' },
        createElement('span', { className: 'dsh-leader-agent-board-card-number' }, `#${card.number ?? '?'}`),
        kind === null
          ? null
          : createElement('span', { className: 'dsh-leader-agent-board-card-kind-separator' }, '/'),
        kind === null
          ? null
          : createElement('span', { className: 'dsh-leader-agent-board-card-kind', title: kind }, kind),
      ),
      createElement(
        'span',
        { className: 'dsh-leader-agent-board-signal-slot' },
        createElement('span', {
          className: `dsh-leader-agent-board-signal dsh-leader-agent-board-signal-${signal}${hollow ? ' dsh-leader-agent-board-signal-hollow' : ''}`,
          title: STATE_LABELS[signal] ?? signal,
        }),
      ),
    ),
    createElement('span', { className: 'dsh-leader-agent-board-card-title', title: card.title }, card.title ?? ''),
    links.length > 0
      ? createElement(BoardLinks, { links, onOpenDetail: (anchor) => onOpenDetail(card, anchor) })
      : null,
    slots.length > 0
      ? createElement(
          'div',
          { className: 'dsh-leader-agent-board-card-slots' },
          slots.map((slot) => createElement(BoardSlot, {
            key: slot.name,
            slot,
            onOpenSession,
            labels: slotLabels,
            t,
          })),
        )
      : null,
  )
}

/**
 * 看板卡片行。
 *
 * 记忆化：会话状态表与卡片对象在两轮之间引用不变时不必重渲染整棵卡面——流式
 * 输出期间看板会频繁收到新事件，没有这道闸，卡面上的链接测量会跟着一起跑。
 */
export const BoardCard = memo(BoardCardView)
