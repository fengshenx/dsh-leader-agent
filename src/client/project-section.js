/**
 * 左栏「项目」区块的内容。
 *
 * 结构是**项目树**：项目行下面挂着该项目的会话，第一行固定是当前 leader，下面是
 * 被它派出的 worker 与被换下的旧 leader。点项目行打开 leader 会话；点行首槽位展开
 * 或收起子会话列表。
 *
 * 排版对齐宿主的工作区浏览：小节标题用同一套行高与三级标签色，项目行用工作区
 * 行的高度、内边距、圆角与 hover 反馈；行首槽位与官方工作区行同款——平时是目录
 * 图标，悬停整行时换成展开箭头，展开时箭头旋转朝下。图标是自带的内联路径
 * （宿主 web 端运行时没有 sprite，见 `icons.js`）。
 *
 * @module dsh-leader-agent/client/project-section
 */

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { productIcon } from './icons.js'
import { buildProjectMenuItems, isLeaderRunning, isProjectCurrent, isProjectOpenable, planProjectRename, projectDropPlan, projectSectionLayout, selectLeaderSessionRow, selectProjectSessionRows, showsProjectActivity } from './project-panel-logic.js'
import { foldSessions, nextWatermark } from './session-watermark.js'

const STYLE_ID = 'dsh-leader-agent-project-section'

/** 区块的样式表。随主题变量走，宿主换肤时自动跟随。 */
const STYLE_TEXT = `
.dsh-leader-agent-project-section {
  display: flex;
  flex-direction: column;
  padding-right: var(--dsh-session-list-edge-inset, 0px);
}
.dsh-leader-agent-project-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 36px;
  padding-left: 4px;
  margin-bottom: 4px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-leader-agent-project-header-label {
  flex: none;
  line-height: 20px;
  font-size: 14px;
}
.dsh-leader-agent-project-header-toggle {
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
.dsh-leader-agent-project-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.dsh-leader-agent-project-icon-button {
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
  .dsh-leader-agent-project-icon-button:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
/* 项目行之间留 2px 间距，照宿主工作区树的「groupSection 直接子元素相邻」规则。
   行高 34px、背景铺满整行，行间不留缝时上下两行的 hover 底色会贴着拼成一整块。 */
.dsh-leader-agent-project-list > * + * {
  margin-top: 2px;
}
.dsh-leader-agent-project-block {
  position: relative;
}
.dsh-leader-agent-project-row {
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
  .dsh-leader-agent-project-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
/* 组里有当前会话：点亮行首文件夹，与宿主工作区树的 folderActive 同色。整行
   底色留给会话行（leader 有自己的一行）——两层同时铺色会看成选了两个。 */
.dsh-leader-agent-project-row[data-active='true'] .dsh-leader-agent-project-lead-folder {
  color: var(--dsw-alias-state-business-primary);
}
.dsh-leader-agent-project-row[data-dead='true'] {
  color: var(--dsw-alias-label-secondary);
}
/* 拖拽落点指示线：落在行的上半插到它之前、下半插到之后，线就画在对应的行间
   缝隙里（行距 2px，线的 top/bottom 也取 -2px）。

   线挂在项目块上而不是项目行上：块 = 行 + 展开的会话列表。插入点按项目排（会话
   不是独立项），所以「落在这一行下半」的实际落点是整个块之后；挂到行上时行的底边
   在展开态是「行与会话列表」的接缝，线会差出一整个会话列表的高度。 */
.dsh-leader-agent-project-block[data-drop='before']::before,
.dsh-leader-agent-project-block[data-drop='after']::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
  pointer-events: none;
}
.dsh-leader-agent-project-block[data-drop='before']::before {
  top: -2px;
}
.dsh-leader-agent-project-block[data-drop='after']::after {
  bottom: -2px;
}
/* 拖起来的行压暗：落点线是主要反馈，源行还要看得出正在动。 */
.dsh-leader-agent-project-row[data-dragging='true'] {
  opacity: 0.5;
}
.dsh-leader-agent-project-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
}
/* 行首槽位：默认目录图标，悬停整行时换成展开箭头（与官方工作区行同款）。
   里面的图标与加载圈都是 SVG：不把这层撑成 flex 的话，SVG 按行盒基线排，圈会
   比行中心高 1.5px（34px 行实测）。 */
.dsh-leader-agent-project-lead-folder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-leader-agent-project-lead {
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
/* 行首加载圈：本组有活动时替换目录图标（尺寸与位置仍占行首槽位）。收起时
   任一会话行在跑、或 leader 自己在跑；展开后只剩 leader——其它会话行自己带
   spinner，不重复画同一个状态。悬停规则对槽位容器生效，箭头照常盖住它。
   圈本身是宿主的 StateDot（state: 'ongoing'）：轨道、呼吸弧、1.5s 周期与页面
   上多个圈的同步相位都由基线 ui-primitives 自带，不再自己写圆环。 */
.dsh-leader-agent-project-lead-arrow {
  display: none;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  transition: transform 150ms var(--ds-ease-in-out, ease);
}
.dsh-leader-agent-project-lead-arrow[data-open='true'] {
  transform: rotate(90deg);
}
@media (hover: hover) {
  .dsh-leader-agent-project-row:hover .dsh-leader-agent-project-lead-arrow {
    display: inline-flex;
  }
  .dsh-leader-agent-project-row:hover .dsh-leader-agent-project-lead-folder {
    display: none;
  }
  .dsh-leader-agent-project-header:hover .dsh-leader-agent-project-lead-arrow {
    display: inline-flex;
  }
  .dsh-leader-agent-project-header:hover .dsh-leader-agent-project-lead-folder {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-leader-agent-project-lead-arrow {
    transition: none;
  }
}
.dsh-leader-agent-project-actions {
  flex: none;
  display: none;
  align-items: center;
  gap: 2px;
}
@media (hover: hover) {
  .dsh-leader-agent-project-row:hover .dsh-leader-agent-project-actions {
    display: inline-flex;
  }
}
.dsh-leader-agent-project-row[data-menu-open='true'] .dsh-leader-agent-project-actions {
  display: inline-flex;
}
.dsh-leader-agent-project-rename {
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
.dsh-leader-agent-project-menu {
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
.dsh-leader-agent-project-menu-item {
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
  .dsh-leader-agent-project-menu-item:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsh-leader-agent-project-menu-item:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.dsh-leader-agent-project-menu-item[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary);
}
@media (hover: hover) {
  .dsh-leader-agent-project-menu-item[data-danger='true']:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover-danger);
  }
}
.dsh-leader-agent-project-menu-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  color: inherit;
}
.dsh-leader-agent-project-notice {
  padding: 4px 8px;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  /* 报错与目录路径都不带空格，不主动断行会横向撑出左栏。 */
  overflow-wrap: anywhere;
}
.dsh-leader-agent-project-draft {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 8px;
}
.dsh-leader-agent-project-draft-directory {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dsh-leader-agent-project-draft-action {
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
.dsh-leader-agent-project-sessions {
  display: flex;
  flex-direction: column;
  padding: 2px 0 4px;
}
/* 会话行同样留 2px：与项目行一样，hover 底色贴着会连成一片。 */
.dsh-leader-agent-project-sessions > * + * {
  margin-top: 2px;
}
/* 会话行逐项照官方工作区会话行（宿主 Rows.module.css 的 sessionRow 与
   sessionRow 下的 title）：行高 32、行内不设 gap（标题自带左右外边距）、文字用
   一级标签色。左右内边距照官方两代写法：0.2.2 起行用透明边框吃掉 paint-inset、
   padding 只留 row_padding 与它的差，hover 背景才会比内容窄一圈；rc.2 这两个变量
   都不存在，落到 8 / 0，与那版硬编码的 8px 一致。 */
.dsh-leader-agent-session-row {
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
  .dsh-leader-agent-session-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
/* 选中态与官方会话行同款（宿主 Rows.module.css 的 sessionRow.selected）：主区域
   正在看的那一条常驻 hover 底色，其余行只有指针停在上面时才亮。 */
.dsh-leader-agent-session-row[data-selected='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* 状态位：尺寸照官方会话行的 slot（16×20）。官方在这里放运行状态圆点或加载器，
   我们只区分「运行中」，所以只放加载器——直接渲染宿主的 StateDot，与官方会话
   行同一个组件、同一个默认尺寸。 */
.dsh-leader-agent-session-status {
  flex: none;
  width: 16px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* leader 行的行首字形：颜色照项目行首的目录图标（三级标签色），不与标题抢注意力。 */
.dsh-leader-agent-session-leader-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-leader-agent-session-title {
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
/* 归档按钮：外观照官方会话行的 hover 动作（三级标签色、悬停提亮）。
   尺寸取宿主 0.2.2 的形态：24×24 目标 + -4px 负边距，净占位 16×16；rc.2 那版
   直接是 16×16 无负边距，净占位相同，两版视觉一致。容器不加外边距——负边距
   由按钮自己带，容器再补一份会把图标推离行右边缘。 */
.dsh-leader-agent-session-actions {
  flex: none;
  display: none;
  align-items: center;
}
@media (hover: hover) {
  .dsh-leader-agent-session-row:hover .dsh-leader-agent-session-actions {
    display: inline-flex;
  }
}
.dsh-leader-agent-session-archive {
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
.dsh-leader-agent-session-archive:focus-visible {
  outline-offset: -2px;
}
@media (hover: hover) {
  .dsh-leader-agent-session-archive:hover:not(:disabled) {
    color: var(--dsw-alias-label-primary);
  }
}
.dsh-leader-agent-session-archive:disabled {
  cursor: default;
  opacity: 0.5;
}
/* 展开/收起按钮：外观照官方工作区树的 overflow 按钮（12px、三级标签色、
   与会话行同样的行高，悬停时提亮到二级色）。左内边距必须落在会话行标题的
   左边缘上，否则文字会比标题缩进一截：官方 rc.2 是 calc(28px + 缩进)，0.2.2
   改成 calc(row_padding + 16 + label_gap + 缩进)。写成同一公式、给 rc.2 没有的
   变量兜底，那版得 28、0.2.2 得 34，两版都与标题对齐。右内边距两版都是 12。 */
.dsh-leader-agent-session-overflow {
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
  .dsh-leader-agent-session-overflow:hover {
    color: var(--dsw-alias-label-secondary);
  }
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
    currentSessionId,
    onReorder,
  } = props

  useEffect(() => { ensureStyles() }, [])

  /**
   * 被拖起的项目 id；null 表示没有拖拽进行中。
   *
   * 落点判定读 ref 而不是 state：drop 处理器的闭包来自某次渲染的快照，拖拽期间
   * 的 state 更新不保证在它之前提交；ref 在事件发生时即时可读。state 只负责视觉
   * （源行压暗、落点线）。
   */
  const [draggingId, setDraggingId] = useState(null)
  const dragIdRef = useRef(null)
  /** 当前落点 `{ id, half }`；null 表示光标不在任何行上。 */
  const [dropTarget, setDropTarget] = useState(null)
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects])

  const beginDrag = (projectId) => {
    dragIdRef.current = projectId
    setDraggingId(projectId)
    setDropTarget(null)
  }

  const finishDrag = () => {
    dragIdRef.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  const dropOn = (overId, half) => {
    const activeId = dragIdRef.current
    finishDrag()
    if (activeId === null || typeof onReorder !== 'function') return
    const { anchor } = projectDropPlan(projectIds, activeId, overId, half)
    // 拖回原处不发远程调用：落点与当前位置相同，写盘只是白跑一趟。
    if (anchor === null) return
    onReorder(activeId, anchor)
  }

  const layout = projectSectionLayout({
    remoteStatus,
    listExpanded,
    projectCount: projects.length,
  })

  return createElement(
    'div',
    { className: 'dsh-leader-agent-project-section' },
    createElement(
      'div',
      { className: 'dsh-leader-agent-project-header' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-project-header-toggle',
          'aria-expanded': listExpanded,
          title: listExpanded ? '收起项目列表' : '展开项目列表',
          onClick: onToggleList,
        },
        createElement(
          'span',
          { className: 'dsh-leader-agent-project-lead' },
          createElement(
            'span',
            { className: 'dsh-leader-agent-project-lead-folder' },
            productIcon('folder-open-outline', { size: 16 }),
          ),
          createElement(
            'span',
            {
              className: 'dsh-leader-agent-project-lead-arrow',
              'data-open': listExpanded ? 'true' : 'false',
            },
            productIcon('triangle-right-fill', { size: 14 }),
          ),
        ),
        createElement('span', { className: 'dsh-leader-agent-project-header-label' }, '项目'),
      ),
      createElement(
        'div',
        { className: 'dsh-leader-agent-project-header-actions' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-agent-project-icon-button',
            title: '加项目：选一个目录',
            disabled: busy,
            onClick: onAdd,
          },
          productIcon('project-add-outline'),
        ),
      ),
    ),
    layout.status === ''
      ? null
      : createElement(
          'div',
          { className: 'dsh-leader-agent-project-notice' },
          layout.status,
        ),
    layout.showEmpty
      ? createElement(
          'div',
          { className: 'dsh-leader-agent-project-notice' },
          '还没有项目。加一个即在它的目录里建好 leader 会话。',
        )
      : null,
    layout.showList
      ? createElement(
          'div',
          { className: 'dsh-leader-agent-project-list' },
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
            currentSessionId,
            onToggleExpand,
            onOpenSession,
            onArchiveSession,
            archivedSessionIds,
            reorderable: typeof onReorder === 'function',
            dragActive: draggingId !== null,
            dragging: draggingId === project.id,
            dropHalf: dropTarget !== null && dropTarget.id === project.id ? dropTarget.half : undefined,
            onDragBegin: beginDrag,
            onDragHover: (overId, half) => {
              setDropTarget(projectDropPlan(projectIds, dragIdRef.current, overId, half).indicator)
            },
            onDropOn: dropOn,
            onDragFinish: finishDrag,
          })),
        )
      : null,
    // 目录名当不了项目名时才出现：这时直接提交只会换回一条没有出口的报错——
    // 项目没建成，列表里就没有那一行，行上的「重命名」也不存在。
    naming === null || naming === undefined ? null : createElement(
      'div',
      { className: 'dsh-leader-agent-project-draft' },
      createElement('div', { className: 'dsh-leader-agent-project-draft-directory' }, naming.directory),
      createElement('input', {
        type: 'text',
        className: 'dsh-leader-agent-project-rename',
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
          { type: 'button', disabled: busy, className: 'dsh-leader-agent-project-draft-action', onClick: onConfirmNaming },
          '建项目',
        ),
        createElement(
          'button',
          { type: 'button', className: 'dsh-leader-agent-project-draft-action', onClick: onCancelNaming },
          '取消',
        ),
      ),
      naming.error === '' || naming.error === undefined
        ? null
        : createElement('div', { className: 'dsh-leader-agent-project-notice' }, naming.error),
    ),
  )
}

/**
 * 拖拽落点在目标行的上半还是下半。
 * @param {object} event - React 拖拽事件
 * @returns {'before' | 'after'} 落点
 */
function dropHalfOf(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * 一个项目行：行首目录图标、项目名，悬停整行时行首换成展开箭头、右端露出操作按钮。
 *
 * 点行打开该项目的 leader 会话；点行首槽位折叠/展开该项目下的会话列表。leader 在
 * 子会话列表里单独占第一行（`SessionRow` 的 `leader`），项目行仍是它最短的入口。
 *
 * @param {object} props - 组件属性
 * @returns {object} React 元素
 */
function ProjectRow(props) {
  const {
    project, busy, onOpen, onRename, onReplace, onRemove,
    sessions, sessionRows, expanded, onToggleExpand, onOpenSession, onArchiveSession,
    archivedSessionIds, currentSessionId,
    reorderable, dragActive, dragging, dropHalf, onDragBegin, onDragHover, onDropOn, onDragFinish,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)
  /** 重命名校验失败的原因；输入框留在原地，原因就地显示。 */
  const [renameError, setRenameError] = useState('')
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
    const plan = planProjectRename(project.name, name)
    if (plan.action === 'keep') {
      setRenameError(plan.error)
      return
    }
    setRenaming(false)
    setRenameError('')
    if (plan.action === 'commit') onRename(project, plan.name)
  }

  const childSessions = selectProjectSessionRows({
    sessionIds: sessions,
    sessionRows,
    leaderSessionId: project.leaderSessionId,
    archivedSessionIds,
  })
  const leaderRow = selectLeaderSessionRow({
    leaderSessionId: project.leaderSessionId,
    sessionRows,
    archivedSessionIds,
  })
  // 整行底色归会话行：leader 有自己的行，worker 被打开时选中落在它自己那一行。
  // 项目行只点亮行首文件夹——分层与宿主工作区树一致（工作区分组亮文件夹图标，
  // 会话行铺整行底色）。
  const active = isProjectCurrent(project, sessions, currentSessionId, archivedSessionIds)
  // 行首加载圈只在收起时用：展开后 leader 行与 worker 行各自带 spinner，同一个
  // 状态画两处会看成两件在跑的事。
  const leadActivity = showsProjectActivity({
    expanded,
    rows: childSessions,
    leaderRunning: isLeaderRunning(project, sessionRows, archivedSessionIds),
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
    {
      className: 'dsh-leader-agent-project-block',
      'data-drop': dropHalf,
    },
    createElement(
      'div',
      {
        className: 'dsh-leader-agent-project-row',
        // 重命名时不能拖：拖拽会抢走输入框的文本选择。其余写操作在途时也不能拖：
        // 拖拽会与删除、改名交错，看起来像「操作中还能动列表」。
        draggable: reorderable && !renaming && !busy,
        'data-dragging': dragging ? 'true' : undefined,
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'move'
          // 不写数据时 Firefox 不开始拖；数据本身不参与判定，落点走行内半区。
          event.dataTransfer.setData('text/plain', project.id)
          onDragBegin(project.id)
        },
        onDragOver: (event) => {
          if (!dragActive) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          const half = dropHalfOf(event)
          // 同一个半区里 dragover 每秒来几十次，值没变就别触发重渲染。
          if (half !== dropHalf) onDragHover(project.id, half)
        },
        onDrop: (event) => {
          if (!dragActive) return
          event.preventDefault()
          onDropOn(project.id, dropHalfOf(event))
        },
        onDragEnd: onDragFinish,
        'data-dead': openable ? undefined : 'true',
        'data-active': active ? 'true' : undefined,
        'data-menu-open': menuOpen ? 'true' : undefined,
        title: `${project.name} · ${project.directory}`,
        onClick: (event) => {
          if (event.target.closest('.dsh-leader-agent-project-actions') !== null) return
          onOpen(project)
        },
      },
      createElement(
        'button',
        {
          type: 'button',
          ref: leadRef,
          className: 'dsh-leader-agent-project-lead',
          'aria-label': expanded ? '收起会话' : '展开会话',
          'aria-expanded': expanded,
          onClick: (event) => { event.stopPropagation(); onToggleExpand(project.id) },
        },
        createElement(
          'span',
          { className: 'dsh-leader-agent-project-lead-folder' },
          leadActivity
            ? createElement(StateDot, { state: 'ongoing' })
            : productIcon(expanded ? 'folder-open' : 'folder-close', { size: 16 }),
        ),
        createElement(
          'span',
          {
            className: 'dsh-leader-agent-project-lead-arrow',
            'data-open': expanded ? 'true' : 'false',
          },
          productIcon('triangle-right-fill', { size: 14 }),
        ),
      ),
      renaming
        ? createElement('input', {
            type: 'text',
            className: 'dsh-leader-agent-project-rename',
            value: name,
            autoFocus: true,
            onClick: (event) => event.stopPropagation(),
            onChange: (event) => {
              setName(event.target.value)
              setRenameError('')
            },
            onBlur: commitRename,
            onKeyDown: (event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') {
                setName(project.name)
                setRenameError('')
                setRenaming(false)
              }
            },
          })
        : createElement(
            'span',
            { className: 'dsh-leader-agent-project-title' },
            project.name,
          ),
      createElement(
        'div',
        { className: 'dsh-leader-agent-project-actions' },
        openable
          ? null
          : createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-leader-agent-project-icon-button',
                title: '换新 Leader',
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
            className: 'dsh-leader-agent-project-icon-button',
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
    // 校验失败的原因跟着输入框留在行下：提示条五秒后消失，用户要照着它改。
    renaming && renameError !== ''
      ? createElement(
          'div',
          { className: 'dsh-leader-agent-project-notice' },
          renameError,
        )
      : null,
    expanded
      ? createElement(
          'div',
          { className: 'dsh-leader-agent-project-sessions' },
          leaderRow === undefined && childSessions.length === 0
            ? createElement(
                'div',
                { className: 'dsh-leader-agent-project-notice' },
                '该项目下还没有会话。',
              )
            : [
                leaderRow === undefined
                  ? null
                  : createElement(SessionRow, {
                      key: leaderRow.id,
                      row: leaderRow,
                      leader: true,
                      selected: leaderRow.id === currentSessionId,
                      onOpenSession,
                      busy,
                    }),
                ...folded.rows.map((row) => createElement(SessionRow, {
                  key: row.id,
                  row,
                  selected: row.id === currentSessionId,
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
                        className: 'dsh-leader-agent-session-overflow',
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
 * 菜单自己渲染，不复用基线 `ui-primitives` 里的 `Menu`：类名前缀与交互都要按本仓
 * 调整，复制改写比覆写样式可控。外观照官方 `Menu`：同样的
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
      className: 'dsh-leader-agent-project-menu',
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
        className: 'dsh-leader-agent-project-menu-item',
        'data-danger': item.danger === true ? 'true' : undefined,
        onClick: () => { onClose(); item.onSelect() },
      },
      item.icon === undefined
        ? null
        : createElement(
            'span',
            { className: 'dsh-leader-agent-project-menu-icon' },
            productIcon(item.icon, { size: 14 }),
          ),
      createElement('span', null, item.label),
    )),
  )
}

/**
 * 项目下的一个会话行。
 *
 * worker 行是纯文字行：会话名在项目树里已经能看清，再加图标只会挤占标题宽度。
 * leader 行是唯一的例外——行首固定一个九宫格字形，让「这一行是项目的指挥者」
 * 在展开列表里一眼可辨；它跑起来时与其它会话行一样换成加载圈。leader 行不给归档
 * 入口：归档它等于让项目失去 leader，换人要走项目行的「换新 Leader」。悬停整行时
 * 右端露出归档入口（与官方会话行的 hover 动作同位）。
 *
 * @param {object} props - 组件属性
 * @param {boolean} [props.leader] - 是否是当前项目的 leader 行
 * @returns {object} React 元素
 */
function SessionRow(props) {
  const { row, leader, selected, onOpenSession, onArchiveSession, busy } = props
  return createElement(
    'div',
    {
      className: 'dsh-leader-agent-session-row',
      'data-session-id': row.id,
      'data-leader': leader === true ? 'true' : undefined,
      'data-selected': selected ? 'true' : undefined,
      'aria-current': selected ? 'page' : undefined,
      onClick: () => onOpenSession(row.id),
      title: row.displayTitle ?? row.title ?? row.id,
    },
    createElement(
      'span',
      { className: 'dsh-leader-agent-session-status' },
      row.running
        ? createElement(StateDot, { state: 'ongoing' })
        : leader === true
          ? createElement(
              'span',
              { className: 'dsh-leader-agent-session-leader-icon' },
              productIcon('apps-grid-fill', { size: 16 }),
            )
          : null,
    ),
    createElement(
      'span',
      { className: 'dsh-leader-agent-session-title' },
      row.title ?? row.displayTitle ?? row.id,
    ),
    leader === true
      ? null
      : createElement(
          'div',
          { className: 'dsh-leader-agent-session-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-leader-agent-session-archive',
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
