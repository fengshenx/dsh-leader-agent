/**
 * 卡片详情浮层（点卡面打开）。
 *
 * 卡面是窄栏，只放得下标题、链接与槽位；spec 全文进详情。写权限只有**链接**：
 * 看板经项目通道的 `updateCardLinks` 整体替换链接条目；完成、置顶、重命名、
 * 删除仍归 leader 的卡片工具，界面不越权写。
 *
 * 浮层外壳（遮罩、Escape、焦点循环、关闭回焦）由 `modal-shell.js` 提供；这里用
 * `headless` 模式自带头部——标题就是卡片标题本身，「卡片详情」这种无信息标题
 * 不放。
 *
 * @module dsh-leader-kit/client/card-detail
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ModalShell } from './modal-shell.js'
import {
  DETAIL_SPEC_EMPTY,
  canEditCardLinks,
  detailSections,
  statusLabel,
} from './card-detail-view.js'
import { CardLinksEditor } from './card-links-editor.js'
import { isJumpableLink, linkRowKey } from './link-row.js'
import { Markdown } from './markdown.js'
import { productIcon } from './icons.js'
import { ensureBoardStyles } from './board-styles.js'

/**
 * 卡片详情浮层。
 *
 * @param {object} props - 组件属性
 * @param {object} props.card - 目标卡片
 * @param {() => void} props.onClose - 关闭
 * @param {(method: string, args: unknown[]) => Promise<unknown>} props.callRemote - 项目通道调用
 * @param {(card: object) => void} [props.onUpdated] - 链接保存成功后的新卡片
 * @param {HTMLElement | null} [props.restoreFocus] - 关闭后焦点落点
 * @returns {object} React 元素
 */
export function CardDetail({ card, onClose, callRemote, onUpdated, restoreFocus = null }) {
  const [editing, setEditing] = useState(false)
  const editButton = useRef(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    ensureBoardStyles()
  }, [])

  // 编辑态会把「编辑链接」按钮换成编辑器；取消或保存后要把焦点还给它，否则
  // 焦点落到 body，下一次 Tab 会被浮层焦点陷阱收边到「关闭」。
  useLayoutEffect(() => {
    if (editing) {
      wasEditing.current = true
      return
    }
    if (!wasEditing.current) return
    wasEditing.current = false
    editButton.current?.focus({ preventScroll: true })
  }, [editing])
  const sections = detailSections(card)
  const done = card?.status === 'done'
  const editable = canEditCardLinks(card)

  /**
   * 保存链接。
   *
   * 失败直接抛给编辑态：它把原因挂在输入框下面，用户能照着改，不用关了
   * 重开浮层。
   *
   * @param {object[]} links - 规范化后的链接条目
   * @returns {Promise<void>} 保存完成
   */
  const saveLinks = useCallback(async (links) => {
    const updated = await callRemote('updateCardLinks', [card.id, links])
    onUpdated?.(updated)
    setEditing(false)
  }, [callRemote, card.id, onUpdated])

  return createElement(ModalShell, {
    open: true,
    onClose,
    title: card?.title ?? '',
    closeLabel: '关闭',
    headless: true,
    wide: true,
    restoreFocus,
    children: createElement(
      'div',
      { className: 'dsh-leader-kit-card-detail' },
      createElement(
        'div',
        { className: 'dsh-leader-kit-card-detail-header' },
        createElement('h2', { className: 'dsh-leader-kit-card-detail-title' }, card?.title ?? ''),
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-kit-card-detail-close',
            'aria-label': '关闭',
            onClick: onClose,
          },
          productIcon('close-outline', { size: 16 }),
        ),
      ),
      createElement(
        'div',
        { className: 'dsh-leader-kit-card-detail-meta' },
        createElement(
          'span',
          { className: 'dsh-leader-kit-card-detail-number' },
          `#${card?.number ?? '?'}`,
        ),
        createElement(
          'span',
          {
            className: `dsh-leader-kit-card-detail-status${done ? ' dsh-leader-kit-card-detail-status-done' : ''}`,
          },
          statusLabel(card?.status),
        ),
      ),
      createElement(
        'div',
        { className: 'dsh-leader-kit-card-detail-body' },
        sections.spec !== null
          ? createElement(
              'section',
              { className: 'dsh-leader-kit-card-detail-section' },
              createElement('div', { className: 'dsh-leader-kit-card-detail-section-title' }, '说明'),
              createElement(
                'div',
                { className: 'dsh-leader-kit-card-detail-text' },
                createElement(Markdown, { source: sections.spec }),
              ),
            )
          : createElement('div', { className: 'dsh-leader-kit-card-detail-muted' }, DETAIL_SPEC_EMPTY),
        sections.links.length > 0 || editable
          ? createElement(
              'section',
              { className: 'dsh-leader-kit-card-detail-section' },
              createElement(
                'div',
                { className: 'dsh-leader-kit-card-detail-section-head' },
                createElement('div', { className: 'dsh-leader-kit-card-detail-section-title' }, '链接'),
                editable && !editing
                  ? createElement(
                      'button',
                      {
                        ref: editButton,
                        type: 'button',
                        className: 'dsh-leader-kit-card-detail-section-action',
                        onClick: () => { setEditing(true) },
                      },
                      '编辑链接',
                    )
                  : null,
              ),
              editing
                ? createElement(CardLinksEditor, {
                    card,
                    onSave: saveLinks,
                    onCancel: () => { setEditing(false) },
                  })
                : createElement(
                    'div',
                    { className: 'dsh-leader-kit-card-detail-links' },
                    sections.links.map((link, index) => {
                      const row = createElement(
                        'span',
                        { className: 'dsh-leader-kit-board-link-chip-body' },
                        productIcon('link-outline', { size: 12 }),
                        createElement(
                          'span',
                          { className: 'dsh-leader-kit-board-link-chip-label' },
                          link.label ?? '',
                        ),
                        link.purpose
                          ? createElement(
                              'span',
                              { className: 'dsh-leader-kit-card-detail-link-purpose' },
                              link.purpose,
                            )
                          : null,
                      )
                      return isJumpableLink(link)
                        ? createElement(
                            'a',
                            {
                              key: linkRowKey(link, index),
                              className: 'dsh-leader-kit-card-detail-link',
                              href: link.url,
                              target: '_blank',
                              rel: 'noreferrer',
                            },
                            row,
                          )
                        : createElement(
                            'div',
                            { key: linkRowKey(link, index), className: 'dsh-leader-kit-card-detail-link' },
                            row,
                          )
                    }),
                  ),
            )
          : null,
      ),
    ),
  })
}
