/**
 * 左栏「项目」区块的内容。
 *
 * 结构是**项目树**：项目行下面挂着该项目目录里的会话。点项目行展开或收起子会话
 * 列表；协调者会话的入口在行的「更多」菜单里（项目名不再承担两个动作）。
 *
 * 排版对齐宿主的工作区浏览：小节标题用同一套行高与三级标签色，项目行用工作区
 * 行的高度、内边距、圆角与 hover 反馈；行首槽位与官方工作区行同款——平时是目录
 * 图标，悬停整行时换成展开箭头，展开时箭头旋转朝下。图标是自带的内联路径
 * （宿主 web 端运行时没有 sprite，见 `icons.js`）。
 *
 * @module dsh-leader-kit/client/project-section
 */

import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { productIcon } from './icons.js'
import { buildProjectMenuItems, isProjectOpenable, selectProjectSessionRows } from './project-panel-logic.js'
import { foldSessions, nextWatermark } from './session-watermark.js'

const STYLE_ID = 'dsh-leader-kit-project-section'

/** 区块的样式表。随主题变量走，宿主换肤时自动跟随。 */
const STYLE_TEXT = `
.dsh-leader-kit-project-section {
  display: flex;
  flex-direction: column;
  padding-right: var(--dsh-session-list-edge-inset, 0px);
}
.dsh-leader-kit-project-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 36px;
  padding-left: 4px;
  margin-bottom: 4px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-leader-kit-project-header-label {
  flex: none;
  line-height: 20px;
  font-size: 14px;
}
.dsh-leader-kit-project-header-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dsh-leader-kit-project-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.dsh-leader-kit-project-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-leader-kit-project-icon-button:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsh-leader-kit-project-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 8px;
  box-sizing: border-box;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}
@media (hover: hover) {
  .dsh-leader-kit-project-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsh-leader-kit-project-row[data-dead='true'] {
  color: var(--dsw-alias-label-secondary);
}
.dsh-leader-kit-project-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
}
/* 行首槽位：默认目录图标，悬停整行时换成展开箭头（与官方工作区行同款）。 */
.dsh-leader-kit-project-lead {
  flex: none;
  width: 16px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-leader-kit-project-lead-arrow {
  display: none;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  transition: transform 150ms var(--ds-ease-in-out, ease);
}
.dsh-leader-kit-project-lead-arrow[data-open='true'] {
  transform: rotate(90deg);
}
@media (hover: hover) {
  .dsh-leader-kit-project-row:hover .dsh-leader-kit-project-lead-arrow {
    display: inline-flex;
  }
  .dsh-leader-kit-project-row:hover .dsh-leader-kit-project-lead-folder {
    display: none;
  }
  .dsh-leader-kit-project-header:hover .dsh-leader-kit-project-lead-arrow {
    display: inline-flex;
  }
  .dsh-leader-kit-project-header:hover .dsh-leader-kit-project-lead-folder {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-leader-kit-project-lead-arrow {
    transition: none;
  }
}
.dsh-leader-kit-project-actions {
  flex: none;
  display: none;
  align-items: center;
  gap: 2px;
}
@media (hover: hover) {
  .dsh-leader-kit-project-row:hover .dsh-leader-kit-project-actions {
    display: inline-flex;
  }
}
.dsh-leader-kit-project-row[data-menu-open='true'] .dsh-leader-kit-project-actions {
  display: inline-flex;
}
.dsh-leader-kit-project-rename {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  line-height: 20px;
  padding: 0 2px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-elevated-fill);
  color: inherit;
  outline: none;
}
.dsh-leader-kit-project-menu {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  min-width: 144px;
  max-width: 360px;
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-menu-surface-fill);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  box-shadow: var(--dsw-elevation-prominent);
}
.dsh-leader-kit-project-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-leader-kit-project-menu-item:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsh-leader-kit-project-menu-item:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.dsh-leader-kit-project-menu-item[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary);
}
@media (hover: hover) {
  .dsh-leader-kit-project-menu-item[data-danger='true']:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover-danger);
  }
}
.dsh-leader-kit-project-menu-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  color: inherit;
}
.dsh-leader-kit-project-notice {
  padding: 4px 8px;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  /* 报错与目录路径都不带空格，不主动断行会横向撑出左栏。 */
  overflow-wrap: anywhere;
}
.dsh-leader-kit-project-draft {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 8px;
}
.dsh-leader-kit-project-draft-directory {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dsh-leader-kit-project-draft-action {
  padding: 4px 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
/* 会话列表与项目行左边缘对齐：项目树只有一层，取官方会话行 depth=0 的形态。
   官方那棵树是按深度缩进的——Rows.module.css 的 sessionRow 在 padding-inline-start
   里加 var(--dsh-workspace-indent)，WorkspaceBrowser.tsx 把它设成 depth * 12px。
   我们没有嵌套层级，所以不加缩进项。 */
.dsh-leader-kit-project-sessions {
  display: flex;
  flex-direction: column;
  padding: 2px 0 4px;
}
/* 会话行逐项照官方工作区会话行（宿主 Rows.module.css 的 sessionRow 与
   sessionRow 下的 title）：行高 32、行内不设 gap（标题自带左右外边距）、文字用
   一级标签色。左右内边距照官方两代写法：0.2.2 起行用透明边框吃掉 paint-inset、
   padding 只留 row_padding 与它的差，hover 背景才会比内容窄一圈；rc.2 这两个变量
   都不存在，落到 8 / 0，与那版硬编码的 8px 一致。 */
.dsh-leader-kit-session-row {
  display: flex;
  align-items: center;
  gap: 0;
  height: 32px;
  border-inline: var(--dsh-sidebar-paint-inset, 0px) solid transparent;
  background-clip: padding-box;
  padding: 0 calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px));
  box-sizing: border-box;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}
@media (hover: hover) {
  .dsh-leader-kit-session-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
/* 状态位：尺寸照官方会话行的 slot（16×20）。官方在这里放运行状态圆点或加载器，
   我们只区分「运行中」，所以只放加载器。 */
.dsh-leader-kit-session-status {
  flex: none;
  width: 16px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-leader-kit-session-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 与官方工作区会话行同字号（宿主 Rows.module.css 的 .title）。左外边距是
     刻意写的变量加兜底：rc.2 那版硬编码 4px（仓里没有这个变量），0.2.2 起官方
     改用 --dsh-sidebar-label-gap（6px）。别简化成硬编码，否则另一版会错位。 */
  font-size: 14px;
  line-height: 20px;
  margin: 0 6px 0 var(--dsh-sidebar-label-gap, 4px);
}
.dsh-leader-kit-session-spinner {
  flex: none;
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid var(--dsw-alias-label-tertiary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: dsh-leader-kit-spin 0.8s linear infinite;
}
/* 归档按钮：外观照官方会话行的 hover 动作（三级标签色、悬停提亮）。
   尺寸取宿主 0.2.2 的形态：24×24 目标 + -4px 负边距，净占位 16×16；rc.2 那版
   直接是 16×16 无负边距，净占位相同，两版视觉一致。容器不加外边距——负边距
   由按钮自己带，容器再补一份会把图标推离行右边缘。 */
.dsh-leader-kit-session-actions {
  flex: none;
  display: none;
  align-items: center;
}
@media (hover: hover) {
  .dsh-leader-kit-session-row:hover .dsh-leader-kit-session-actions {
    display: inline-flex;
  }
}
.dsh-leader-kit-session-archive {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-leader-kit-session-archive:focus-visible {
  outline-offset: -2px;
}
@media (hover: hover) {
  .dsh-leader-kit-session-archive:hover:not(:disabled) {
    color: var(--dsw-alias-label-primary);
  }
}
.dsh-leader-kit-session-archive:disabled {
  cursor: default;
  opacity: 0.5;
}
/* 展开/收起按钮：外观照官方工作区树的 overflow 按钮（12px、三级标签色、
   与会话行同样的行高，悬停时提亮到二级色）。左内边距必须落在会话行标题的
   左边缘上，否则文字会比标题缩进一截：官方 rc.2 是 calc(28px + 缩进)，0.2.2
   改成 calc(row_padding + 16 + label_gap + 缩进)。写成同一公式、给 rc.2 没有的
   变量兜底，那版得 28、0.2.2 得 34，两版都与标题对齐。右内边距两版都是 12。 */
.dsh-leader-kit-session-overflow {
  width: 100%;
  height: 28px;
  padding: 0 12px 0 calc(var(--dsh-sidebar-row-padding, 8px) + 16px + var(--dsh-sidebar-label-gap, 4px));
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 28px;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-leader-kit-session-overflow:hover {
    color: var(--dsw-alias-label-secondary);
  }
}
@keyframes dsh-leader-kit-spin {
  to { transform: rotate(360deg); }
}
`

/**
 * 注入区块样式表。同一页面只注入一次。
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
 * 项目区块内容。
 *
 * @param {object} props - 组件属性
 * @returns {object} React 元素
 */
export function ProjectSection(props) {
  const {
    projects, busy, remoteStatus,
    onAdd,
    naming, onConfirmNaming, onCancelNaming, onNamingChange,
    onOpen, onRename, onReplace, onRemove,
    sessionsByProject, sessionRows, expandedProjects,
    onToggleExpand, onOpenSession, onArchiveSession,
    archivedSessionIds,
    listExpanded, onToggleList,
  } = props

  useEffect(() => { ensureStyles() }, [])

  return createElement(
    'div',
    { className: 'dsh-leader-kit-project-section' },
    createElement(
      'div',
      { className: 'dsh-leader-kit-project-header' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-kit-project-header-toggle',
          'aria-expanded': listExpanded,
          title: listExpanded ? '收起项目列表' : '展开项目列表',
          onClick: onToggleList,
        },
        createElement(
          'span',
          { className: 'dsh-leader-kit-project-lead' },
          createElement(
            'span',
            { className: 'dsh-leader-kit-project-lead-folder' },
            productIcon('folder-open-outline', { size: 16 }),
          ),
          createElement(
            'span',
            {
              className: 'dsh-leader-kit-project-lead-arrow',
              'data-open': listExpanded ? 'true' : 'false',
            },
            productIcon('triangle-right-fill', { size: 14 }),
          ),
        ),
        createElement('span', { className: 'dsh-leader-kit-project-header-label' }, '项目'),
      ),
      createElement(
        'div',
        { className: 'dsh-leader-kit-project-header-actions' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-kit-project-icon-button',
            title: '加项目：选一个目录',
            disabled: busy,
            onClick: onAdd,
          },
          productIcon('project-add-outline'),
        ),
      ),
    ),
    listExpanded
      ? (remoteStatus !== ''
          ? createElement(
              'div',
              { className: 'dsh-leader-kit-project-notice' },
              remoteStatus,
            )
          : projects.length === 0
            ? createElement(
                'div',
                { className: 'dsh-leader-kit-project-notice' },
                '还没有项目。加一个即在它的目录里建好协调者会话。',
              )
            : createElement(
              'div',
              null,
              projects.map((project) => createElement(ProjectRow, {
                key: project.id,
                project,
                busy,
                onOpen,
                onRename,
                onReplace,
                onRemove,
                sessions: sessionsByProject.get(project.id) ?? [],
                sessionRows,
                expanded: expandedProjects.has(project.id),
                onToggleExpand,
                onOpenSession,
                onArchiveSession,
                archivedSessionIds,
              })),
            ))
      : null,
    // 目录名当不了项目名时才出现：这时直接提交只会换回一条没有出口的报错——
    // 项目没建成，列表里就没有那一行，行上的「重命名」也不存在。
    naming === null || naming === undefined ? null : createElement(
      'div',
      { className: 'dsh-leader-kit-project-draft' },
      createElement('div', { className: 'dsh-leader-kit-project-draft-directory' }, naming.directory),
      createElement('input', {
        type: 'text',
        className: 'dsh-leader-kit-project-rename',
        value: naming.name,
        autoFocus: true,
        onChange: (event) => onNamingChange(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') onConfirmNaming()
          if (event.key === 'Escape') onCancelNaming()
        },
      }),
      createElement(
        'div',
        { style: { display: 'flex', gap: '4px' } },
        createElement(
          'button',
          { type: 'button', disabled: busy, className: 'dsh-leader-kit-project-draft-action', onClick: onConfirmNaming },
          '建项目',
        ),
        createElement(
          'button',
          { type: 'button', className: 'dsh-leader-kit-project-draft-action', onClick: onCancelNaming },
          '取消',
        ),
      ),
      naming.error === '' || naming.error === undefined
        ? null
        : createElement('div', { className: 'dsh-leader-kit-project-notice' }, naming.error),
    ),
  )
}

/**
 * 一个项目行：行首目录图标、项目名，悬停整行时行首换成展开箭头、右端露出操作按钮。
 *
 * 点行打开该项目的协调者会话；点行首槽位折叠/展开该项目下的会话列表。协调者不在
 * 子会话列表里——它的入口就是这一行，重复列出会让入口含糊。
 *
 * @param {object} props - 组件属性
 * @returns {object} React 元素
 */
function ProjectRow(props) {
  const {
    project, busy, onOpen, onRename, onReplace, onRemove,
    sessions, sessionRows, expanded, onToggleExpand, onOpenSession, onArchiveSession,
    archivedSessionIds,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)
  const [menuAnchor, setMenuAnchor] = useState(null)
  const moreRef = useRef(null)
  const leadRef = useRef(null)
  const openable = isProjectOpenable(project)

  useEffect(() => {
    if (!menuOpen) return undefined
    const onDismiss = () => setMenuOpen(false)
    // Escape 关闭与官方菜单一致（宿主 Menu.tsx 也是 outside click / Escape）。
    const onKeyDown = (event) => { if (event.key === 'Escape') onDismiss() }
    window.addEventListener('click', onDismiss)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onDismiss)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const commitRename = () => {
    setRenaming(false)
    if (name !== project.name) onRename(project, name)
  }

  const childSessions = selectProjectSessionRows({
    sessionIds: sessions,
    sessionRows,
    coordinatorSessionId: project.coordinatorSessionId,
    archivedSessionIds,
  })
  // 会话列表按水位折叠：默认露出 5 条，点「展开其余」再加一页。状态留在组件
  // 本地（宿主也不持久化它），每个项目各算各的。
  const [watermark, setWatermark] = useState(0)
  const folded = foldSessions(childSessions, watermark)

  const menuItems = buildProjectMenuItems(project, {
    onRename: () => setRenaming(true),
    onReplace,
    onRemove,
  })

  return createElement(
    'div',
    null,
    createElement(
      'div',
      {
        className: 'dsh-leader-kit-project-row',
        'data-dead': openable ? undefined : 'true',
        'data-menu-open': menuOpen ? 'true' : undefined,
        role: 'treeitem',
        'aria-expanded': expanded,
        title: `${project.name} · ${project.directory}`,
        onClick: (event) => {
          if (event.target.closest('.dsh-leader-kit-project-actions') !== null) return
          onOpen(project)
        },
      },
      createElement(
        'button',
        {
          type: 'button',
          ref: leadRef,
          className: 'dsh-leader-kit-project-lead',
          'aria-label': expanded ? '收起会话' : '展开会话',
          onClick: (event) => { event.stopPropagation(); onToggleExpand(project.id) },
        },
        createElement(
          'span',
          { className: 'dsh-leader-kit-project-lead-folder' },
          productIcon(expanded ? 'folder-open' : 'folder-close', { size: 16 }),
        ),
        createElement(
          'span',
          {
            className: 'dsh-leader-kit-project-lead-arrow',
            'data-open': expanded ? 'true' : 'false',
          },
          productIcon('triangle-right-fill', { size: 14 }),
        ),
      ),
      renaming
        ? createElement('input', {
            type: 'text',
            className: 'dsh-leader-kit-project-rename',
            value: name,
            autoFocus: true,
            onClick: (event) => event.stopPropagation(),
            onChange: (event) => setName(event.target.value),
            onBlur: commitRename,
            onKeyDown: (event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') { setName(project.name); setRenaming(false) }
            },
          })
        : createElement(
            'span',
            { className: 'dsh-leader-kit-project-title' },
            project.name,
          ),
      createElement(
        'div',
        { className: 'dsh-leader-kit-project-actions' },
        openable
          ? null
          : createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-leader-kit-project-icon-button',
                title: '换新协调者',
                disabled: busy,
                onClick: (event) => { event.stopPropagation(); onReplace(project) },
              },
              productIcon('refresh-outline'),
            ),
        createElement(
          'button',
          {
            type: 'button',
            ref: moreRef,
            className: 'dsh-leader-kit-project-icon-button',
            title: '更多',
            disabled: busy,
            onClick: (event) => {
              event.stopPropagation()
              // 「更多」按钮平时不显示（悬停整行才出现），脚本触发的点击会拿到
              // 空矩形——这时退回行首槽位，菜单才不会贴到视口左上角。
              const rect = moreRef.current?.getBoundingClientRect()
              const anchorRect = rect !== undefined && rect.width > 0
                ? rect
                : leadRef.current?.getBoundingClientRect()
              setMenuAnchor(anchorRect === undefined ? null : {
                left: anchorRect.left,
                top: anchorRect.top,
                bottom: anchorRect.bottom,
              })
              setMenuOpen((value) => !value)
            },
          },
          productIcon('ellipsis-outline'),
        ),
      ),
    ),
    expanded
      ? createElement(
          'div',
          { className: 'dsh-leader-kit-project-sessions' },
          childSessions.length === 0
            ? createElement(
                'div',
                { className: 'dsh-leader-kit-project-notice' },
                '该项目下还没有会话。',
              )
            : [
                ...folded.rows.map((row) => createElement(SessionRow, {
                  key: row.id,
                  row,
                  onOpenSession,
                  onArchiveSession,
                  busy,
                })),
                folded.hiddenCount === 0 && !folded.expanded
                  ? null
                  : createElement(
                      'button',
                      {
                        key: 'overflow',
                        type: 'button',
                        className: 'dsh-leader-kit-session-overflow',
                        'aria-expanded': folded.expanded,
                        onClick: () => {
                          if (folded.expanded) {
                            setWatermark(0)
                            return
                          }
                          setWatermark((value) => nextWatermark(
                            folded.hiddenCount,
                            Math.max(value, childSessions.length - folded.hiddenCount),
                          ))
                        },
                      },
                      folded.expanded ? '收起' : folded.expandLabel,
                    ),
              ],
        )
      : null,
    menuOpen && menuAnchor !== null
      ? createPortal(
          createElement(ProjectMenu, {
            anchor: menuAnchor,
            items: menuItems,
            onClose: () => setMenuOpen(false),
          }),
          document.body,
        )
      : null,
  )
}

/**
 * 项目的操作菜单。
 *
 * 第三方插件不能 import 宿主 UI 包（dsh 的包面规则禁止功能包为绕过规则添加
 * `dsh.client.external`），所以菜单是自己渲染的，但外观照官方 `Menu`：同样的
 * 圆角、材质、阴影与行高，取的是同一批 `--dsw-*` 变量。菜单挂在 `document.body`
 * 上（portal），避免被左栏滚动区裁掉。
 *
 * @param {object} props - 组件属性
 * @param {object} props.anchor - 锚点按钮的视口矩形
 * @param {object[]} props.items - 菜单项
 * @param {Function} props.onClose - 关闭菜单
 * @returns {object} React 元素
 */
function ProjectMenu(props) {
  const { anchor, items, onClose } = props
  const ref = useRef(null)
  const [placement, setPlacement] = useState({ left: anchor.left, top: anchor.bottom + 4 })

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    const fitsBelow = anchor.bottom + 4 + height <= window.innerHeight - 12
    setPlacement(fitsBelow
      ? { left: anchor.left, top: anchor.bottom + 4 }
      : { left: anchor.left, top: Math.max(12, anchor.top - height - 4) })
  }, [anchor])

  return createElement(
    'div',
    {
      ref,
      role: 'menu',
      className: 'dsh-leader-kit-project-menu',
      'data-menu-material': 'translucent',
      style: { left: `${placement.left}px`, top: `${placement.top}px` },
      onClick: (event) => event.stopPropagation(),
    },
    items.map((item) => createElement(
      'button',
      {
        key: item.id,
        type: 'button',
        role: 'menuitem',
        className: 'dsh-leader-kit-project-menu-item',
        'data-danger': item.danger === true ? 'true' : undefined,
        onClick: () => { onClose(); item.onSelect() },
      },
      item.icon === undefined
        ? null
        : createElement(
            'span',
            { className: 'dsh-leader-kit-project-menu-icon' },
            productIcon(item.icon, { size: 14 }),
          ),
      createElement('span', null, item.label),
    )),
  )
}

/**
 * 项目下的一个会话行。
 *
 * 纯文字行：左边的会话图标与右边的执行者标记都不画——会话名在项目树里已经能
 * 看清，再加图标只会挤占标题的宽度。运行中的会话仍在行首留一个状态位；悬停整
 * 行时右端露出归档入口（与官方会话行的 hover 动作同位）。
 *
 * @param {object} props - 组件属性
 * @returns {object} React 元素
 */
function SessionRow(props) {
  const { row, onOpenSession, onArchiveSession, busy } = props
  return createElement(
    'div',
    {
      className: 'dsh-leader-kit-session-row',
      'data-session-id': row.id,
      onClick: () => onOpenSession(row.id),
      title: row.displayTitle ?? row.title ?? row.id,
    },
    createElement(
      'span',
      { className: 'dsh-leader-kit-session-status' },
      row.running ? createElement('span', { className: 'dsh-leader-kit-session-spinner' }) : null,
    ),
    createElement(
      'span',
      { className: 'dsh-leader-kit-session-title' },
      row.title ?? row.displayTitle ?? row.id,
    ),
    createElement(
      'div',
      { className: 'dsh-leader-kit-session-actions' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-kit-session-archive',
          title: '归档会话：从列表移除，并摘掉卡片上绑定的槽位',
          'aria-label': `归档会话 ${row.title ?? row.displayTitle ?? row.id}`,
          disabled: busy,
          onClick: (event) => {
            // 归档按钮在行内：不拦下来会连带打开会话。
            event.stopPropagation()
            onArchiveSession(row.id)
          },
        },
        productIcon('archive-outline', { size: 14 }),
      ),
    ),
  )
}
