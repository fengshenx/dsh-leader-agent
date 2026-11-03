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
 * （打开会话、搜索）不受影响。
 *
 * **折叠计数要一起修**：官方的「展开其余 N 个会话」按数据层算 N，被隐藏的行也算
 * 在里面，于是数字比真能露出来的行多。同一条渲染层在分组里按「该组排除集大小
 * 减去已渲染的隐藏行」修正文案，全部被排除时把按钮收起（点了也看不到东西）。
 * 点击步长仍是官方的口径（一次 5 条），所以「还剩几条可看」准确，但一次点击新增
 * 的可见行可能少于文案的变化量。
 *
 * 同一套渲染层还负责工作区行的**激活态**（{@link QUIET_CLASS}）。工作区行本身
 * 照常显示：项目目录在工作区树里是有用的入口（用户可以在里面手动开会话），藏掉
 * 会让那些会话无处可寻。
 *
 * @module dsh-leader-kit/client/workspace-exclusion
 */

/** 命中排除集的会话行所用的类名。 */
const HIDDEN_CLASS = 'dsh-leader-kit-excluded-session'

/** 剩余可看行数为 0 时要收起的展开按钮所用的类名。 */
const HIDDEN_BUTTON_CLASS = 'dsh-leader-kit-excluded-expand'

/**
 * 宿主原文案里的数字记在按钮上，用来区分「宿主刚重写的」与「上次改写后留下的」。
 *
 * React 重写文本节点时不碰 `data-*` 属性；分不清来源就会把改写过的数字当成宿主
 * 口径再减一次，数字会一路往下掉。
 */
const ORIGIN_ATTR = 'expandOrigin'

/** 上次写进按钮的完整文案，判据见 {@link ORIGIN_ATTR}。 */
const WRITTEN_ATTR = 'expandWritten'

/**
 * 被压掉激活态的工作区行所用的类名。
 *
 * 官方给「当前会话所在的工作区分组」的目录图标上业务主色（`folderActive`，
 * 蓝），并且只要分组里有当前会话就点亮。leader 与 worker 会话被本模块从官方树里
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
.dsh-leader-kit-excluded-expand {
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
 * 按当前集合标记一棵树里的会话行、工作区行与展开按钮。
 *
 * 抽成独立函数是为了能脱离 DOM 单测：root 只需提供 `querySelectorAll`，行的形状
 * 见 `markSessionRow` / `markWorkspaceRow`，按钮的形状见 {@link adjustExpandButton}。
 * 真实调用传 `document`。
 *
 * @param {object} root - 查询根
 * @param {object} state - 标记状态
 * @param {Set<string>} state.excluded - 要排除的会话 id
 * @param {Set<string>} state.quieted - 要压掉激活态的工作区 id
 * @param {Map<string, number>} [state.excludedByGroup] - 工作区 id 到该组排除集大小；缺省不修折叠计数
 * @returns {void}
 */
export function markRows(root, { excluded, quieted, excludedByGroup }) {
  for (const row of root.querySelectorAll('[data-row-key^="session:"]')) {
    markSessionRow(row, excluded)
  }
  for (const row of root.querySelectorAll('[data-row-key^="workspace:"]')) {
    markWorkspaceRow(row, { quieted })
  }
  if (excludedByGroup !== undefined) adjustGroupOverflow(root, excludedByGroup)
}

/**
 * 算每个工作区分组里属于排除集的会话数。
 *
 * 折叠计数的修正要的是「这个组里最后一定看不见的会话有多少条」。归档的会话宿主
 * 自己就不渲染，不该计入——多减会把数字压到真值以下。
 *
 * 纯函数，数据全部由调用方给：`workspaceItems` 来自宿主工作区快照，`excluded` 是
 * 项目会话的排除集，`archivedSessionIds` 是宿主归档集合。
 *
 * @param {object} options - 输入
 * @param {object[]} options.workspaceItems - 宿主工作区快照（`{workspaceId, sessionIds}`）
 * @param {Set<string>} options.excluded - 要排除的会话 id
 * @param {Set<string>} [options.archivedSessionIds] - 已归档的会话 id
 * @returns {Map<string, number>} 工作区 id 到排除集大小；没有排除会话的组不在映射里
 */
export function excludedSessionCountsByWorkspace({
  workspaceItems,
  excluded,
  archivedSessionIds,
}) {
  const counts = new Map()
  for (const item of workspaceItems ?? []) {
    const workspaceId = item?.workspaceId
    if (typeof workspaceId !== 'string' || !Array.isArray(item.sessionIds)) continue
    let count = 0
    for (const sessionId of item.sessionIds) {
      if (excluded?.has(sessionId) !== true) continue
      if (archivedSessionIds?.has(sessionId) === true) continue
      count += 1
    }
    if (count > 0) counts.set(workspaceId, count)
  }
  return counts
}

/**
 * 取一个元素的直接子元素。
 * @param {object} element - 父元素
 * @returns {object[]} 直接子元素
 */
function directChildren(element) {
  const children = element?.children
  if (children === undefined || children === null) return []
  return Array.from(children)
}

/**
 * 找第一个带指定行前缀的直接子元素。
 * @param {object} element - 父元素
 * @param {string} prefix - 行前缀，如 `overflow:`
 * @returns {object | undefined} 子元素
 */
function directChildWithPrefix(element, prefix) {
  for (const child of directChildren(element)) {
    if (idOf(child?.getAttribute?.('data-row-key'), prefix) !== undefined) return child
  }
  return undefined
}

/**
 * 数一数每个分组里已经渲染出来、但被我们藏掉的会话行。
 *
 * 官方把会话行与展开按钮都交给 `HoverCard` 包一层 `span`，所以「分组的直接子元素」
 * 不是会话行；判据改成「向上第一个带展开按钮的祖先」。子工作区的行落在自己的
 * section 里，不会算到父组头上。
 *
 * @param {object} root - 查询根
 * @returns {Map<object, number>} 分组容器到该组已渲染且隐藏的会话行数
 */
function hiddenRowsBySection(root) {
  const counts = new Map()
  for (const row of root.querySelectorAll('[data-row-key^="session:"]')) {
    if (row.classList?.contains?.(HIDDEN_CLASS) !== true) continue
    const section = groupSectionOf(row)
    if (section === undefined) continue
    counts.set(section, (counts.get(section) ?? 0) + 1)
  }
  return counts
}

/**
 * 从一个元素向上找它所在的分组容器。
 *
 * 分组容器 = 直接子元素里有展开按钮的那个元素（`WorkspaceBrowser` 的 groupSection）。
 *
 * @param {object} element - 任意元素
 * @returns {object | undefined} 分组容器；不在任何分组里时 undefined
 */
function groupSectionOf(element) {
  for (let node = element?.parentElement; node !== undefined && node !== null; node = node.parentElement) {
    if (directChildWithPrefix(node, 'overflow:') !== undefined) return node
  }
  return undefined
}

/**
 * 读按钮上宿主自己算出来的剩余条数。
 *
 * React 重写文本节点时不会碰 `data-*`，所以「当前文本等于上次写进去的文案」说明
 * 宿主还没重写过，宿主的值仍是记下的那个；否则文本就是宿主刚写的。
 *
 * @param {object} button - 展开按钮
 * @returns {number | undefined} 宿主口径的剩余条数；文案里没有数字（「收起」）时 undefined
 */
function hostExpandCount(button) {
  const text = typeof button.textContent === 'string' ? button.textContent : ''
  const written = button.dataset?.[WRITTEN_ATTR]
  if (written !== undefined && text === written) {
    const origin = Number(button.dataset[ORIGIN_ATTR])
    return Number.isFinite(origin) ? origin : undefined
  }
  const match = /\d+/.exec(text)
  if (match === null) return undefined
  const count = Number(match[0])
  if (button.dataset !== undefined) button.dataset[ORIGIN_ATTR] = String(count)
  return count
}

/**
 * 把展开按钮的剩余数改成排除后的真实值，没有可看的就收起来。
 *
 * 只改数字、不重写整句：文案与语言都归宿主，第三方复刻一份只会随宿主改版漂移。
 *
 * @param {object} button - 展开按钮
 * @param {number} remainingVisible - 排除后还能露出来的会话数
 * @returns {number} 写进去的剩余数
 */
export function adjustExpandButton(button, remainingVisible) {
  button.classList.toggle(HIDDEN_BUTTON_CLASS, remainingVisible <= 0)
  if (remainingVisible <= 0) return remainingVisible
  const text = typeof button.textContent === 'string' ? button.textContent : ''
  if (!/\d/.test(text)) return remainingVisible
  const next = text.replace(/\d+/, String(remainingVisible))
  if (next === text) return remainingVisible
  button.textContent = next
  if (button.dataset !== undefined) button.dataset[WRITTEN_ATTR] = next
  return remainingVisible
}

/**
 * 把展开按钮还原成宿主口径。
 *
 * 只在文本仍是我们写的那句时替换数字：宿主已经重写过就说明它自己是对的。
 *
 * @param {object} button - 展开按钮
 * @returns {void}
 */
function restoreExpandButton(button) {
  button.classList.remove(HIDDEN_BUTTON_CLASS)
  if (button.dataset === undefined) return
  const origin = button.dataset[ORIGIN_ATTR]
  const written = button.dataset[WRITTEN_ATTR]
  if (origin !== undefined && written !== undefined && button.textContent === written) {
    button.textContent = written.replace(/\d+/, String(origin))
  }
  delete button.dataset[ORIGIN_ATTR]
  delete button.dataset[WRITTEN_ATTR]
}

/**
 * 逐个分组修正折叠计数。
 *
 * 未渲染的那部分里有多少属于排除集，等于「该组排除集大小」减去「已渲染且已隐藏
 * 的行数」。宿主每点一次展开加 5 条（最后一次放完），文案减的是真实剩余，所以
 * 一次点击新增的可见行可能少于文案的变化量——步长是宿主的口径，改不了。
 *
 * @param {object} root - 查询根
 * @param {Map<string, number>} excludedByGroup - 工作区 id 到该组排除集大小
 * @returns {void}
 */
function adjustGroupOverflow(root, excludedByGroup) {
  const hiddenBySection = hiddenRowsBySection(root)
  // 按钮自己带分组 key（`overflow:<key>`）：不用再从工作区行反查容器。
  for (const button of root.querySelectorAll('[data-row-key^="overflow:"]')) {
    const key = idOf(button.getAttribute('data-row-key'), 'overflow:')
    if (key === undefined) continue
    const section = button.parentElement
    if (section === undefined || section === null) continue
    const hostCount = hostExpandCount(button)
    if (hostCount === undefined) continue
    const hiddenInGroup = excludedByGroup.get(key) ?? 0
    const remainingExcluded = Math.max(0, hiddenInGroup - (hiddenBySection.get(section) ?? 0))
    adjustExpandButton(button, Math.max(0, hostCount - remainingExcluded))
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
 * 观察整棵文档：官方树重绘、虚拟滚动新增行、React 重写 className，以及 React 直接
 * 改文本节点（展开按钮的数字）都会触发重新标记。扫描范围是「所有会话行」，左栏里
 * 数量有限，但聊天流式渲染与看板投影更新会连续触发观察回调，因此同一帧内只扫一次。
 *
 * @returns {{ update: (state: object) => void, dispose: () => void }} 排除器
 */
export function createWorkspaceExclusion() {
  /** @type {Set<string>} 要从官方树里排除的会话 id */
  let excluded = new Set()
  /** @type {Set<string>} 要压掉激活态的工作区 id */
  let quieted = new Set()
  /** @type {Map<string, number>} 工作区 id 到该组排除集大小 */
  let excludedByGroup = new Map()
  /** @type {MutationObserver | undefined} 观察器 */
  let observer

  /**
   * 按当前集合重新标记整棵文档。
   * @returns {void}
   */
  const markAll = () => {
    if (typeof document === 'undefined') return
    markRows(document, { excluded, quieted, excludedByGroup })
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
      characterData: true,
    })
  }

  return {
    /**
     * 更新三个集合。
     *
     * 变化都是低频事件，立即生效；观察回调才是高频路径，由调度器去抖。
     *
     * @param {object} state - 集合
     * @param {Iterable<string>} state.sessionIds - 要排除的会话 id
     * @param {Iterable<string>} [state.quietWorkspaceIds] - 要压掉激活态的工作区 id
     * @param {Map<string, number>} [state.excludedByGroup] - 工作区 id 到该组排除集大小
     * @returns {void}
     */
    update({ sessionIds, quietWorkspaceIds = [], excludedByGroup: counts }) {
      excluded = new Set(sessionIds)
      quieted = new Set(quietWorkspaceIds)
      excludedByGroup = counts ?? new Map()
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
      // 改正过的剩余数要还原成宿主口径：插件重载而页面不刷新时，留下来的是少掉的数字。
      for (const button of document.querySelectorAll('[data-row-key^="overflow:"]')) {
        restoreExpandButton(button)
      }
    },
  }
}
