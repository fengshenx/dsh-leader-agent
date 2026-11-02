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
 * 同一套渲染层还负责工作区行的**激活态**（{@link QUIET_CLASS}）。工作区行本身
 * 照常显示：项目目录在工作区树里是有用的入口（用户可以在里面手动开会话），藏掉
 * 会让那些会话无处可寻。
 *
 * @module dsh-leader-kit/client/workspace-exclusion
 */

/** 命中排除集的会话行所用的类名。 */
const HIDDEN_CLASS = 'dsh-leader-kit-excluded-session'

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
 * 按压灰集标记一个工作区行。
 *
 * @param {object} row - 工作区行元素
 * @param {object} state - 标记状态
 * @param {Set<string>} state.quieted - 要压掉激活态的工作区 id
 * @returns {boolean} 该行是否被压掉激活态
 */
export function markWorkspaceRow(row, { quieted }) {
  const id = idOf(row.getAttribute('data-row-key'), 'workspace:')
  const quiet = id !== undefined && quieted.has(id)
  row.classList.toggle(QUIET_CLASS, quiet)
  return quiet
}

/**
 * 按当前集合标记一棵树里的会话行与工作区行。
 *
 * 抽成独立函数是为了能脱离 DOM 单测：root 只需提供 `querySelectorAll`，行的形状
 * 见 `markSessionRow` / `markWorkspaceRow`。真实调用传 `document`。
 *
 * @param {object} root - 查询根
 * @param {object} state - 标记状态
 * @param {Set<string>} state.excluded - 要排除的会话 id
 * @param {Set<string>} state.quieted - 要压掉激活态的工作区 id
 * @returns {void}
 */
export function markRows(root, { excluded, quieted }) {
  for (const row of root.querySelectorAll('[data-row-key^="session:"]')) {
    markSessionRow(row, excluded)
  }
  for (const row of root.querySelectorAll('[data-row-key^="workspace:"]')) {
    markWorkspaceRow(row, { quieted })
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
  /** @type {MutationObserver | undefined} 观察器 */
  let observer

  /**
   * 按当前集合重新标记整棵文档。
   * @returns {void}
   */
  const markAll = () => {
    if (typeof document === 'undefined') return
    markRows(document, { excluded, quieted })
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
     * 更新两个集合。
     *
     * 两者变化都是低频事件，立即生效；观察回调才是高频路径，由调度器去抖。
     *
     * @param {object} state - 集合
     * @param {Iterable<string>} state.sessionIds - 要排除的会话 id
     * @param {Iterable<string>} [state.quietWorkspaceIds] - 要压掉激活态的工作区 id
     * @returns {void}
     */
    update({ sessionIds, quietWorkspaceIds = [] }) {
      excluded = new Set(sessionIds)
      quieted = new Set(quietWorkspaceIds)
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
      const all = `.${HIDDEN_CLASS}, .${QUIET_CLASS}`
      for (const row of document.querySelectorAll(all)) {
        row.classList.remove(HIDDEN_CLASS, QUIET_CLASS)
      }
    },
  }
}
