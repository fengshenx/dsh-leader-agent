/**
 * 把项目下的会话从官方工作区树里排除。
 *
 * 官方工作区树由宿主渲染，落在左栏的 `sidebar.workspaces` 槽里，那个槽是 single
 * 且已被官方占用，第三方既不能换掉它，也没有「按项目排除会话」的扩展点。
 *
 * 官方确实提供归档接口（`workspaceRegistry.archiveSession` 会把会话从**所有**
 * 分组面里摘掉），但归档是用户可见的持久状态：会话会出现在官方的归档视图里，
 * 项目注销时还得逐个反归档，用户自己归档过的会话更不能被我们反归档。借用它做
 * 「排除」会把两件事搅在一起。
 *
 * 因此这里走**渲染层**：官方会话行带 `data-row-key="session:<id>"`，认得出会话
 * id，命中排除集的行加一个类由样式表隐藏。官方的数据层不动，用户在别处的操作
 * （打开会话、搜索）不受影响；代价是官方分组行上的会话计数仍包含被隐藏的会话。
 *
 * 同一套渲染层还负责两件工作区行的事：**藏掉项目自建的工作区**
 * （{@link HIDDEN_WORKSPACE_CLASS}，连组内属于它的行一起，
 * {@link HIDDEN_GROUP_ROW_CLASS}）与**压掉它的激活态**（{@link QUIET_CLASS}）。
 *
 * @module dsh-leader-kit/client/workspace-exclusion
 */

/** 命中排除集的会话行所用的类名。 */
const HIDDEN_CLASS = 'dsh-leader-kit-excluded-session'

/**
 * 项目自建的工作区行所用的类名。
 *
 * 协调者会话要能被官方界面打开，就得归属某个工作区；项目目录还不是工作区时，
 * 建项目会顺带注册一个（见 `ensureWorkspace`）。于是左栏工作区树里凭空多出一项
 * ——用户没加过它，项目区块里已经有同一个目录。这一项在渲染层藏掉，工作区仍留在
 * 宿主数据里（会话归属与打开路径都靠它）。用户自己加的同目录工作区不在此列：
 * 项目记录里只记插件注册的那个（`workspaceId`）。
 */
const HIDDEN_WORKSPACE_CLASS = 'dsh-leader-kit-hidden-workspace'

/**
 * 被藏掉的工作区分组里、属于该组的行所用的类名。
 *
 * 只藏 header 不够：分组展开时组内的会话行与「展开其余 N 个会话」按钮是 header 的
 * 兄弟节点，会留下一批没有标题的孤儿行（打开协调者会话本身就会展开这一组，展开
 * 是常态）。这些行跟着 header 一起藏。
 */
const HIDDEN_GROUP_ROW_CLASS = 'dsh-leader-kit-hidden-workspace-group'

/**
 * 被压掉激活态的工作区行所用的类名。
 *
 * 官方给「当前会话所在的工作区分组」的目录图标上业务主色（`folderActive`，
 * 蓝），并且只要分组里有当前会话就点亮。协调者与 worker 会话被本模块从官方树里
 * 藏掉后，被点亮的分组里看不到是谁在点亮它——分组看起来是开着的，却找不到对应
 * 的会话行。命中时把图标颜色压回三级标签色，视觉上与未打开时一致。
 */
const QUIET_CLASS = 'dsh-leader-kit-quiet-workspace'

/** 隐藏规则的样式表 id。 */
const STYLE_ID = 'dsh-leader-kit-workspace-exclusion'

const STYLE_TEXT = `
.dsh-leader-kit-excluded-session {
  display: none !important;
}
.dsh-leader-kit-hidden-workspace {
  display: none !important;
}
.dsh-leader-kit-hidden-workspace-group {
  display: none !important;
}
/* 工作区行的第一个 span 是目录图标槽（宿主 Rows.tsx 的 slot folder 顺序），
   图标颜色取自它；未激活时官方也是三级标签色（Rows.module.css 的 .slot）。 */
.dsh-leader-kit-quiet-workspace > span:first-child {
  color: var(--dsw-alias-label-tertiary);
}
`

/**
 * 注入隐藏规则。同一页面只注入一次。
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
 * 从 `data-row-key` 里取某类行的 id。
 * @param {string | null} rowKey - 行标识
 * @param {string} prefix - 前缀，如 `session:` / `workspace:`
 * @returns {string | undefined} id；前缀不匹配时 undefined
 */
function idOf(rowKey, prefix) {
  if (typeof rowKey !== 'string' || !rowKey.startsWith(prefix)) return undefined
  return rowKey.slice(prefix.length)
}

/**
 * 按排除集标记一行。
 *
 * 抽成独立函数是为了能脱离 DOM 单测：行只需提供 `getAttribute` 与 `classList`。
 *
 * @param {object} row - 会话行元素
 * @param {Set<string>} excluded - 要排除的会话 id
 * @returns {boolean} 该行是否被标记为隐藏
 */
export function markSessionRow(row, excluded) {
  const id = idOf(row.getAttribute('data-row-key'), 'session:')
  const hidden = id !== undefined && excluded.has(id)
  row.classList.toggle(HIDDEN_CLASS, hidden)
  return hidden
}

/**
 * 按两个集合标记一个工作区行。
 *
 * @param {object} row - 工作区行元素
 * @param {object} state - 标记状态
 * @param {Set<string>} state.quieted - 要压掉激活态的工作区 id
 * @param {Set<string>} state.hidden - 要整行藏掉的工作区 id
 * @returns {{ quiet: boolean, hidden: boolean }} 该行的标记结果
 */
export function markWorkspaceRow(row, { quieted, hidden }) {
  const id = idOf(row.getAttribute('data-row-key'), 'workspace:')
  const quiet = id !== undefined && quieted.has(id)
  const hide = id !== undefined && hidden.has(id)
  row.classList.toggle(QUIET_CLASS, quiet)
  row.classList.toggle(HIDDEN_WORKSPACE_CLASS, hide)
  return { quiet, hidden: hide }
}

/** 分组容器里属于该组的行：会话行与「展开其余 N 个会话」按钮。 */
const GROUP_ROW_SELECTOR = '[data-row-key^="session:"], [data-row-key^="overflow:"]'

/**
 * 找出一个行元素所属的工作区分组容器。
 *
 * 宿主的组是一个 `div`（`WorkspaceBrowser.tsx` 的 `css.groupSection`），直接子元素
 * 依次是工作区 header、嵌套分组（`div[role="group"]`）与组内会话行；header 与
 * 会话行外面各包着一层 HoverCard 的 `span`，所以行元素不是容器的直接子元素。容器
 * 的类名被 CSS Modules 改写、认不出，但**容器的父元素带 `role`**：顶层列表是
 * `tree`（`AnimatedRows`），嵌套分组是 `group`。
 *
 * @param {object} row - 行元素
 * @returns {object | undefined} 分组容器；结构对不上时 undefined
 */
function groupSectionOf(row) {
  let node = row.parentElement
  while (node !== null && node !== undefined) {
    const role = node.parentElement?.getAttribute('role')
    if (role === 'tree' || role === 'group') return node
    node = node.parentElement
  }
  return undefined
}

/**
 * 藏掉一个工作区 header 所在分组里属于该组的行。
 *
 * 嵌套分组里的行不归这一组：各自的 header 都要显示，会话行只跟着自己那一组走。
 * 抽成独立函数是为了能脱离 DOM 单测：行只需提供 `parentElement`、`getAttribute`
 * 与 `classList`，容器只需要 `querySelectorAll`。
 *
 * @param {object} headerRow - 工作区行元素
 * @param {boolean} hide - 是否藏掉
 * @returns {void}
 */
export function markGroupRows(headerRow, hide) {
  const section = groupSectionOf(headerRow)
  if (section === undefined) return
  for (const row of section.querySelectorAll(GROUP_ROW_SELECTOR)) {
    if (groupSectionOf(row) !== section) continue
    row.classList.toggle(HIDDEN_GROUP_ROW_CLASS, hide)
  }
}

/**
 * 创建一个「同一帧只排一次」的调度器。
 *
 * 抽成独立函数是为了能脱离 DOM 单测：注入假的调度与取消函数即可验证去重与取消。
 *
 * @param {object} options - 选项
 * @param {(callback: () => void) => number} options.schedule - 调度函数，返回句柄
 * @param {(handle: number) => void} options.cancel - 取消已排的调度
 * @returns {{ run: (task: () => void) => void, cancel: () => void }} 调度器
 */
export function createFrameScheduler({ schedule, cancel }) {
  let pending = false
  let handle
  let generation = 0

  return {
    /**
     * 排一个任务。同一帧内重复调用只有第一次生效。
     * @param {() => void} task - 任务
     * @returns {void}
     */
    run(task) {
      if (pending) return
      pending = true
      generation += 1
      const current = generation
      handle = schedule(() => {
        // 已取消的调度即使回调仍被调用，任务也不能执行。
        if (current !== generation) return
        pending = false
        handle = undefined
        task()
      })
    },

    /**
     * 取消尚未执行的任务。
     * @returns {void}
     */
    cancel() {
      if (!pending) return
      pending = false
      generation += 1
      if (handle !== undefined) cancel(handle)
      handle = undefined
    },
  }
}

/**
 * 创建排除器。
 *
 * 观察整棵文档：官方树重绘、虚拟滚动新增行、以及 React 重写 className，都会触发
 * 重新标记。扫描范围是「所有会话行」，左栏里数量有限，但聊天流式渲染与看板投影
 * 更新会连续触发观察回调，因此同一帧内只扫一次。
 *
 * @returns {{ update: (state: object) => void, dispose: () => void }} 排除器
 */
export function createWorkspaceExclusion() {
  /** @type {Set<string>} 要从官方树里排除的会话 id */
  let excluded = new Set()
  /** @type {Set<string>} 要压掉激活态的工作区 id */
  let quieted = new Set()
  /** @type {Set<string>} 要整行藏掉的工作区 id */
  let hiddenWorkspaces = new Set()
  /** @type {MutationObserver | undefined} 观察器 */
  let observer

  /**
   * 按当前集合重新标记会话行与工作区行。
   * @returns {void}
   */
  const markAll = () => {
    if (typeof document === 'undefined') return
    for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
      markSessionRow(row, excluded)
    }
    for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
      const mark = markWorkspaceRow(row, { quieted, hidden: hiddenWorkspaces })
      markGroupRows(row, mark.hidden)
    }
  }

  const scheduler = createFrameScheduler({
    schedule: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  })

  if (typeof document !== 'undefined') {
    ensureStyles()
    observer = new MutationObserver(() => scheduler.run(markAll))
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })
  }

  return {
    /**
     * 更新三个集合。
     *
     * 三者变化都是低频事件，立即生效；观察回调才是高频路径，由调度器去抖。
     *
     * @param {object} state - 集合
     * @param {Iterable<string>} state.sessionIds - 要排除的会话 id
     * @param {Iterable<string>} [state.quietWorkspaceIds] - 要压掉激活态的工作区 id
     * @param {Iterable<string>} [state.hiddenWorkspaceIds] - 要整行藏掉的工作区 id
     * @returns {void}
     */
    update({ sessionIds, quietWorkspaceIds = [], hiddenWorkspaceIds = [] }) {
      excluded = new Set(sessionIds)
      quieted = new Set(quietWorkspaceIds)
      hiddenWorkspaces = new Set(hiddenWorkspaceIds)
      markAll()
    },

    /**
     * 停止观察并清理标记。
     * @returns {void}
     */
    dispose() {
      observer?.disconnect()
      observer = undefined
      // 必须先取消待执行的扫描：否则它会在清理之后把刚摘掉的标记又加回去。
      scheduler.cancel()
      if (typeof document === 'undefined') return
      const all = `.${HIDDEN_CLASS}, .${QUIET_CLASS}, .${HIDDEN_WORKSPACE_CLASS}, .${HIDDEN_GROUP_ROW_CLASS}`
      for (const row of document.querySelectorAll(all)) {
        row.classList.remove(HIDDEN_CLASS, QUIET_CLASS, HIDDEN_WORKSPACE_CLASS, HIDDEN_GROUP_ROW_CLASS)
      }
    },
  }
}
