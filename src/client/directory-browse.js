/**
 * 应用内目录浏览弹层。
 *
 * 宿主在 linux（`PATH` 上没有 zenity/kdialog）、没有 display、SSH 启动或非
 * loopback bind 时会组合 `browse` 选择器：`uiWorkspace.pickDirectory()` 只服务
 * native，调用会以 `directory-picker/unavailable` 拒绝。官方侧栏的「添加工作区」
 * 由挂载的 browse 客户端半边渲染目录树，第三方面板没有这条路径——这个弹层补上：
 * 用同一 `uiWorkspace` 上的 `listDirectory` / `createDirectory` 原语自己渲染。
 *
 * 不预判能力：native 宿主上 `pickDirectory()` 正常弹系统框；只有它拒绝、且
 * `listDirectory()` 能成功时，才说明宿主服务的是 browse（判据见 project-panel 的
 * `probeBrowseListing`）。
 *
 * @module dsh-leader-agent/client/directory-browse
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ModalShell } from './modal-shell.js'
import { productIcon } from './icons.js'
import { ensureStyleSheet } from './style-sheet.js'
import {
  directoryBrowseFailureText,
  displayCrumbs,
  parentCrumb,
  visibleEntries,
} from './directory-browse-logic.js'

/** 样式表 id；与浮层外壳的样式表分开，避免两个模块争一份内容。 */
const STYLE_ID = 'dsh-leader-agent-directory-browse'

const STYLE_TEXT = `
.dsh-leader-agent-browse {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 240px;
}

.dsh-leader-agent-browse-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 24px;
  overflow-x: auto;
  white-space: nowrap;
}

.dsh-leader-agent-browse-crumb {
  flex: none;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-browse-crumb:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-leader-agent-browse-crumb-sep {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.dsh-leader-agent-browse-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  min-height: 160px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}

.dsh-leader-agent-browse-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-leader-agent-browse-entry:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-leader-agent-browse-entry:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.dsh-leader-agent-browse-entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-leader-agent-browse-entry-arrow {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-leader-agent-browse-note {
  padding: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-leader-agent-browse-error {
  padding: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-leader-agent-browse-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-leader-agent-browse-toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.dsh-leader-agent-browse-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.dsh-leader-agent-browse-create {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dsh-leader-agent-browse-input {
  box-sizing: border-box;
  height: 30px;
  min-width: 0;
  flex: 1;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

.dsh-leader-agent-browse-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}

.dsh-leader-agent-browse-action {
  flex: none;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  cursor: pointer;
}

.dsh-leader-agent-browse-action:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.dsh-leader-agent-browse-action-quiet {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
`

/** 注入/刷新样式表；与弹层外壳相同的 HMR 处理。 */
function ensureStyles() {
  ensureStyleSheet(STYLE_ID, STYLE_TEXT)
}

/**
 * 探测宿主是否服务 browse 目录原语。
 *
 * `pickDirectory()` 只服务 native，在 browse 宿主上必然被拒；两个后端的
 * capability 在浏览器侧都读不到（`uiWorkspace` 只暴露动词）。因此用
 * `listDirectory()` 的成败当能力判据：能列出主目录就是 browse 宿主。
 * 拒绝不是错误，是判据——native 宿主上它必然也拒绝。
 *
 * @param {object} uiWorkspace - 宿主的导航服务
 * @returns {Promise<object | null>} 主目录列表；宿主不是 browse 时 null
 */
export async function probeBrowseListing(uiWorkspace) {
  try {
    return await uiWorkspace.listDirectory()
  } catch {
    return null
  }
}

/**
 * 应用内目录浏览弹层。
 *
 * @param {object} props - 组件属性
 * @param {boolean} props.open - 是否显示
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 翻译函数
 * @param {object} props.workspace - 宿主的 `uiWorkspace`（提供 listDirectory / createDirectory）
 * @param {object | null} [props.initialListing] - 打开时已有的一级列表（省一次扫描）
 * @param {boolean} [props.busy] - 宿主正在建项目，冻结操作
 * @param {(path: string) => void} props.onOpen - 选定目录
 * @param {() => void} props.onClose - 取消
 * @returns {object | null} React 元素；未打开时 null
 */
export function DirectoryBrowseDialog({
  open,
  t,
  workspace,
  initialListing = null,
  busy = false,
  onOpen,
  onClose,
}) {
  const [listing, setListing] = useState(initialListing)
  const [loading, setLoading] = useState(initialListing === null)
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [folderForm, setFolderForm] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  /** 只有最后一次扫描能落地：慢的旧请求回来时不能把界面退回上一级。 */
  const request = useRef({ seq: 0, controller: null })

  const load = useCallback(async (path) => {
    const seq = request.current.seq + 1
    request.current.seq = seq
    request.current.controller?.abort()
    const controller = new AbortController()
    request.current.controller = controller
    setLoading(true)
    setError('')
    setCreateError('')
    try {
      const next = await workspace.listDirectory(path, controller.signal)
      if (request.current.seq !== seq) return
      setListing(next)
      setFolderForm(false)
      setFolderName('')
    } catch (cause) {
      if (request.current.seq !== seq) return
      setError(t('project.browse.error', { message: directoryBrowseFailureText(cause) }))
    } finally {
      if (request.current.seq === seq) setLoading(false)
    }
  }, [t, workspace])

  // 打开时若没有预取结果（例如调用方只探测到能力），自己取主目录。
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (initialListing === null) void load(undefined)
  }, [initialListing, load])

  // 卸载/关闭时撤掉在途扫描：宿主的 browse 原语按 signal 停止读盘。
  useEffect(() => () => {
    request.current.controller?.abort()
  }, [])

  // 布局期注入：弹层是点完才出现的，等 effect 注入会闪一帧无样式。
  useLayoutEffect(() => {
    if (open) ensureStyles()
  }, [open])

  const submitFolder = useCallback(async () => {
    if (listing === null || creating) return
    const name = folderName.trim()
    if (name === '') return
    setCreating(true)
    setCreateError('')
    try {
      const created = await workspace.createDirectory(listing.path, name)
      await load(created)
    } catch (cause) {
      setCreateError(t('project.browse.createError', { message: directoryBrowseFailureText(cause) }))
    } finally {
      setCreating(false)
    }
  }, [creating, folderName, listing, load, t, workspace])

  const crumbs = listing === null ? [] : displayCrumbs(listing, t('project.browse.home'))
  const up = listing === null ? null : parentCrumb(listing)
  const entries = listing === null ? [] : visibleEntries(listing.entries, showHidden)
  const selectDisabled = listing === null || loading || busy
  // 扫描期间冻结导航：连点两下「上一级」时第二下读到的是旧的 listing，
  // 会把父级算成同级——宁可按完等扫描落地。
  const navigationDisabled = loading || busy

  const body = createElement(
    'div',
    { className: 'dsh-leader-agent-browse' },
    createElement(
      'div',
      { className: 'dsh-leader-agent-browse-crumbs' },
      crumbs.flatMap((crumb, index) => {
        const nodes = [createElement(
          'button',
          {
            key: crumb.path,
            type: 'button',
            className: 'dsh-leader-agent-browse-crumb',
            title: crumb.path,
            disabled: navigationDisabled,
            'data-dsh-leader-agent-browse-crumb': crumb.path,
            onClick: () => { void load(crumb.path) },
          },
          crumb.name,
        )]
        if (index < crumbs.length - 1) {
          nodes.push(createElement(
            'span',
            { key: `sep-${crumb.path}`, className: 'dsh-leader-agent-browse-crumb-sep', 'aria-hidden': 'true' },
            productIcon('chevron-right-outline', { size: 10 }),
          ))
        }
        return nodes
      }),
    ),
    createElement(
      'div',
      {
        className: 'dsh-leader-agent-browse-list',
        role: 'list',
        'data-dsh-leader-agent-browse-level': listing === null ? undefined : listing.path,
      },
      error !== ''
        ? createElement('div', { className: 'dsh-leader-agent-browse-error', role: 'alert' }, error)
        : null,
      loading
        ? createElement('div', { className: 'dsh-leader-agent-browse-note' }, t('project.browse.loading'))
        : null,
      !loading && error === '' && entries.length === 0
        ? createElement('div', { className: 'dsh-leader-agent-browse-note' }, t('project.browse.empty'))
        : null,
      loading
        ? null
        : entries.map((entry) => createElement(
          'button',
          {
            key: entry.path,
            type: 'button',
            className: 'dsh-leader-agent-browse-entry',
            title: entry.path,
            disabled: navigationDisabled,
            'data-dsh-leader-agent-browse-entry': entry.path,
            onClick: () => { void load(entry.path) },
          },
          createElement('span', { className: 'dsh-leader-agent-browse-entry-name' }, entry.name),
          createElement('span', { className: 'dsh-leader-agent-browse-entry-arrow' }, productIcon('chevron-right-outline', { size: 12 })),
        )),
    ),
    listing !== null && listing.truncated
      ? createElement(
        'div',
        { className: 'dsh-leader-agent-browse-note' },
        t('project.browse.truncated', { count: listing.entries.length }),
      )
      : null,
    createElement(
      'div',
      { className: 'dsh-leader-agent-browse-toolbar' },
      createElement(
        'div',
        { className: 'dsh-leader-agent-browse-toolbar-left' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-agent-browse-action dsh-leader-agent-browse-action-quiet',
            disabled: navigationDisabled || up === null,
            'data-dsh-leader-agent-browse-up': '',
            onClick: () => {
              if (up !== null) void load(up.path)
            },
          },
          t('project.browse.up'),
        ),
        createElement(
          'label',
          { className: 'dsh-leader-agent-browse-check' },
          createElement('input', {
            type: 'checkbox',
            checked: showHidden,
            disabled: busy,
            onChange: (event) => setShowHidden(event.target.checked),
          }),
          t('project.browse.showHidden'),
        ),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-browse-action dsh-leader-agent-browse-action-quiet',
          disabled: busy || listing === null || creating,
          onClick: () => {
            setCreateError('')
            setFolderForm((value) => !value)
          },
        },
        t('project.browse.newFolder'),
      ),
    ),
    folderForm
      ? createElement(
        'div',
        { className: 'dsh-leader-agent-browse-create' },
        createElement('input', {
          type: 'text',
          className: 'dsh-leader-agent-browse-input',
          value: folderName,
          placeholder: t('project.browse.folderName'),
          autoFocus: true,
          disabled: creating,
          onChange: (event) => {
            setFolderName(event.target.value)
            setCreateError('')
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitFolder()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setFolderForm(false)
            }
          },
        }),
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-agent-browse-action',
            disabled: creating || folderName.trim() === '',
            onClick: () => { void submitFolder() },
          },
          t('project.browse.create'),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-agent-browse-action dsh-leader-agent-browse-action-quiet',
            disabled: creating,
            onClick: () => setFolderForm(false),
          },
          t('common.cancel'),
        ),
      )
      : null,
    createError === ''
      ? null
      : createElement('div', { className: 'dsh-leader-agent-browse-error', role: 'alert' }, createError),
  )

  const footer = [
    createElement('button', {
      key: 'cancel',
      type: 'button',
      className: 'dsh-leader-agent-modal-button dsh-leader-agent-modal-button-outline',
      disabled: creating,
      onClick: onClose,
    }, t('common.cancel')),
    createElement('button', {
      key: 'open',
      type: 'button',
      'data-modal-autofocus': '',
      'data-dsh-leader-agent-browse-select': '',
      className: 'dsh-leader-agent-modal-button dsh-leader-agent-modal-button-outline',
      disabled: selectDisabled || creating,
      onClick: () => {
        if (listing !== null) onOpen(listing.path)
      },
    }, t('project.browse.select')),
  ]

  return createElement(ModalShell, {
    open,
    onClose,
    title: t('project.browse.title'),
    closeLabel: t('common.close'),
    wide: true,
    children: body,
    footer,
  })
}
