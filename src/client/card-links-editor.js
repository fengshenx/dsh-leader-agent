/**
 * 卡片详情里的链接编辑态。
 *
 * 交互对齐 Telov 的任务卡片详情：每行一条链接，标签窄、URL 占宽、行尾移除；
 * 用途默认收起，点「添加用途」才展开；底部「添加链接」与「取消 / 保存」。保存
 * 时按 `normalizeLinkDrafts` 的规则 trim、丢空行、校验 URL——那套判定与宿主侧
 * 写通道共用，界面先拦一次只是即时反馈。
 *
 * 草稿的 `key` 只服务于 React 与本地增删，提交前剔除；链接的 `id` 原样带回，
 * 新条目没有 id，由宿主在落盘时补。
 *
 * @module dsh-leader-kit/client/card-links-editor
 */

import { createElement, useLayoutEffect, useRef, useState } from 'react'
import { normalizeLinkDrafts } from '../shared/card-links.js'
import { pickInitialFocus } from './modal-focus.js'
import { productIcon } from './icons.js'

/** 新增草稿的本地 key 序号。只在编辑器内部当渲染 key，不落盘。 */
let draftSequence = 0

/**
 * 造一个草稿的本地 key。
 * @returns {string} key
 */
function nextDraftKey() {
  draftSequence += 1
  return `draft-${draftSequence}`
}

/**
 * 把卡片上的链接转成可编辑草稿。
 *
 * `key` 优先用链接 id，便于保存时原样带回；id 缺失或重复时改用本地序号——
 * 卡片工具不查重，两条链接同 id 会让改一行动两行。
 *
 * @param {object[]} links - 卡片链接
 * @returns {object[]} 草稿
 */
function toDrafts(links) {
  if (!Array.isArray(links)) return []
  const seenIds = new Set()
  return links.map((link) => {
    const id = typeof link?.id === 'string' && link.id !== '' && !seenIds.has(link.id)
      ? link.id
      : undefined
    if (id !== undefined) seenIds.add(id)
    return {
      key: id ?? nextDraftKey(),
      ...id === undefined ? {} : { id },
      label: typeof link?.label === 'string' ? link.label : '',
      url: typeof link?.url === 'string' ? link.url : '',
      ...typeof link?.purpose === 'string' ? { purpose: link.purpose } : {},
    }
  })
}

/**
 * 输入框回车即保存，但组合输入中的回车属于输入法。
 *
 * Safari 确认候选词时 `isComposing` 已经是 false，`keyCode === 229` 才是可靠
 * 信号；缺了它会变成「选词即保存」。
 *
 * @param {object} event - React 键盘事件
 * @returns {boolean} 是否应保存
 */
function isSubmitKey(event) {
  return event.key === 'Enter'
    && event.nativeEvent?.isComposing !== true
    && event.nativeEvent?.keyCode !== 229
}

/**
 * 链接编辑态。
 *
 * @param {object} props - 组件属性
 * @param {object} props.card - 正在编辑的卡片
 * @param {(links: object[]) => Promise<void>} props.onSave - 保存；失败时抛出
 * @param {() => void} props.onCancel - 取消
 * @returns {object} React 元素
 */
export function CardLinksEditor({ card, onSave, onCancel }) {
  const [drafts, setDrafts] = useState(() => toDrafts(card?.links))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const root = useRef(null)
  const submitFocus = useRef(null)
  const restoreFocus = useRef(false)

  // 点「编辑链接」后按钮被编辑器替换，焦点若不主动接住会落回 body；沿用浮层的
  // 初始聚焦规则：优先标了 data-modal-autofocus 的首个 label，没有链接时落到
  // 「+ 添加链接」。
  useLayoutEffect(() => {
    const element = root.current
    if (element !== null) pickInitialFocus(element).focus({ preventScroll: true })
  }, [])

  // saving 期间控件 disabled，被聚焦的元素会 blur；保存失败后把焦点还给提交前
  // 的元素（Enter 提交回到输入框，点「保存」则回到重新启用的按钮）。成功与取消
  // 由外层回焦「编辑链接」。
  useLayoutEffect(() => {
    if (saving || !restoreFocus.current) return
    restoreFocus.current = false
    const target = submitFocus.current
    if (target instanceof HTMLElement && target.isConnected) {
      target.focus({ preventScroll: true })
      return
    }
    const element = root.current
    if (element !== null) pickInitialFocus(element).focus({ preventScroll: true })
  }, [saving])

  /**
   * 改一条草稿的字段。
   * @param {string} key - 草稿 key
   * @param {string} field - 字段名
   * @param {string} value - 新值
   * @returns {void}
   */
  function update(key, field, value) {
    setError('')
    setDrafts((current) => current.map((draft) => (
      draft.key === key ? { ...draft, [field]: value } : draft
    )))
  }

  /**
   * 移除一条草稿。
   * @param {string} key - 草稿 key
   * @returns {void}
   */
  function remove(key) {
    setError('')
    setDrafts((current) => current.filter((draft) => draft.key !== key))
  }

  /**
   * 追加一条空草稿。
   * @returns {void}
   */
  function add() {
    setError('')
    setDrafts((current) => [...current, { key: nextDraftKey(), label: '', url: '' }])
  }

  /**
   * 提交草稿。
   * @returns {Promise<void>} 保存完成
   */
  async function submit() {
    if (saving) return
    const normalized = normalizeLinkDrafts(drafts.map(({ key: _key, ...draft }) => draft))
    if (normalized.error !== undefined) {
      setError(normalized.error)
      return
    }
    setError('')
    const active = document.activeElement
    submitFocus.current = root.current?.contains(active) === true ? active : null
    restoreFocus.current = false
    setSaving(true)
    try {
      await onSave(normalized.links)
    } catch (cause) {
      setError(`保存链接失败：${cause instanceof Error ? cause.message : String(cause)}`)
      restoreFocus.current = true
    } finally {
      setSaving(false)
    }
  }

  return createElement(
    'div',
    { ref: root, className: 'dsh-leader-kit-link-editor' },
    drafts.length === 0
      ? createElement(
          'p',
          { className: 'dsh-leader-kit-link-editor-empty' },
          '这张卡还没有挂链接。',
        )
      : drafts.map((draft, index) => createElement(
          'div',
          { key: draft.key, className: 'dsh-leader-kit-link-editor-row' },
          createElement(
            'div',
            { className: 'dsh-leader-kit-link-editor-main' },
            createElement('input', {
              type: 'text',
              className: 'dsh-leader-kit-link-editor-label',
              value: draft.label,
              placeholder: '标签',
              'aria-label': '链接标签',
              ...index === 0 ? { 'data-modal-autofocus': '' } : {},
              disabled: saving,
              onChange: (event) => update(draft.key, 'label', event.target.value),
              onKeyDown: (event) => {
                if (isSubmitKey(event)) void submit()
              },
            }),
            createElement('input', {
              type: 'text',
              className: 'dsh-leader-kit-link-editor-url',
              value: draft.url,
              placeholder: 'https://…',
              'aria-label': '链接 URL',
              disabled: saving,
              onChange: (event) => update(draft.key, 'url', event.target.value),
              onKeyDown: (event) => {
                if (isSubmitKey(event)) void submit()
              },
            }),
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-leader-kit-link-editor-remove',
                title: '移除链接',
                'aria-label': '移除链接',
                disabled: saving,
                onClick: () => remove(draft.key),
              },
              productIcon('close-outline', { size: 14 }),
            ),
          ),
          draft.purpose === undefined
            ? createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-leader-kit-link-editor-add-purpose',
                  disabled: saving,
                  onClick: () => update(draft.key, 'purpose', ''),
                },
                '添加用途',
              )
            : createElement('input', {
                type: 'text',
                className: 'dsh-leader-kit-link-editor-purpose',
                value: draft.purpose,
                placeholder: '用途（可选）',
                'aria-label': '链接用途',
                disabled: saving,
                onChange: (event) => update(draft.key, 'purpose', event.target.value),
                onKeyDown: (event) => {
                  if (isSubmitKey(event)) void submit()
                },
              }),
        )),
    createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-leader-kit-link-editor-add',
        disabled: saving,
        onClick: add,
      },
      '+ 添加链接',
    ),
    error === ''
      ? null
      : createElement('div', { className: 'dsh-leader-kit-link-editor-error', role: 'alert' }, error),
    createElement(
      'div',
      { className: 'dsh-leader-kit-link-editor-actions' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-kit-link-editor-button',
          disabled: saving,
          onClick: onCancel,
        },
        '取消',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-kit-link-editor-button dsh-leader-kit-link-editor-button-primary',
          disabled: saving,
          onClick: () => { void submit() },
        },
        saving ? '保存中…' : '保存',
      ),
    ),
  )
}
