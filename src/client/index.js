/**
 * 客户端半边：左栏「项目」区块与右栏「看板」Tab。
 *
 * 宿主侧（`src/host/`）提供项目注册表、卡片存储与卡片工具；浏览器侧只负责呈现
 * 与操作。看板数据来自会话事件流里 `tool/result` 事件的 `meta`——卡片工具用
 * `output.presentationMeta` 投影的结构化卡片，与 session log 一起持久化。
 *
 * 项目数据走 dsh 官方的 Typert 远程通道（命名空间 `projects`，经 `/api` 共享
 * 通道），浏览器侧没有文件系统，项目的真源在宿主侧。
 *
 * 客户端插件在浏览器进程运行，`ctx.sidebarRightTabs` 与 `ctx.slots` 都是
 * client 服务，宿主侧插件拿不到（见 docs/capability-gaps.md 第 15 条）。
 *
 * @module dsh-leader-agent/client
 */

import { BoardBody } from './board.js'
import { mountBoardSettings } from './board-settings.js'
import { BoardGuideEntry } from './board-guide-entry.js'
import { ProjectPanel } from './project-panel.js'
import { mountGuideCard } from './guide-card.js'
import { LeaderChangesAnchor } from './leader-changes-anchor.js'
import { mountLeaderView } from './leader-view.js'
import { watchLeaderSessions } from './leader-session-index.js'
import { LOCALE_UI, SLOT_LOCALE_NAMESPACE, unknownLocaleCodes } from './locales.js'
import { callProjectRemote, mountProjectRemote } from './project-remote.js'
import { mountProjectBoardMonitor } from './project-board-monitor.js'
import { createReadySignal } from './ready-signal.js'
import { SessionTabsAnchor } from './session-tabs.js'
import { ToastOverlay } from './toast-view.js'
import { WORKER_REPORT_NODE_KIND, workerReportDefinition } from './worker-report-definition.js'
import { WorkerReportView } from './worker-report-view.js'
import { WORKER_TASK_NODE_KIND, workerTaskDefinition } from './worker-task-definition.js'
import { WorkerTaskView } from './worker-task-view.js'

/**
 * 本插件在宿主注册表里的身份：tab 类型 id、面板与入口的注册键都用它。
 *
 * 这几处必须同值（guide 入口按 provider id 分发，宿主拿它当槽位键），写两遍
 * 容易改一处漏另一处——漏了就静默退回「全局入口」，入口又对所有会话可见。
 */
const PLUGIN_ID = 'dsh-leader-agent'

export const inject = ['slots', 'sidebarRightTabs', 'sessions', 'locale']

/**
 * 注册左栏项目区块与看板 tab 类型、面板主体。
 * @param {object} ctx - 客户端 Cordis 上下文
 * @returns {void}
 */
export function apply(ctx) {
  // 槽位显示名字典：槽位名本身是 ASCII 机器标识，卡面按当前界面语言翻译。
  // 字典晚于 UI 挂载也能生效（locale 服务会推 revision），不必等挂载顺序。
  ctx.effect(
    () => ctx.locale.register(SLOT_LOCALE_NAMESPACE, LOCALE_UI),
    'dsh-leader-agent 槽位显示名',
  )
  // 注册期文案（tab 标题、guide 说明、左栏 label）没有 `t` 形参，宿主只在
  // 取用时重读 thunk；bind 返回的函数同样在调用时读当前语言，语言切换后
  // 下次投影就是新文案，不需要重新注册。
  const t = ctx.locale.bind(SLOT_LOCALE_NAMESPACE)
  // 语言目录是宿主运行时的：本地多一个 locale 文件不代表宿主认它。只比较并告警，
  // 不把宿主列表写进构建门禁——宿主加语言时门禁不该跟着漂。
  const hostLocales = ctx.locale?.getSnapshot?.()?.locales
  if (Array.isArray(hostLocales)) {
    for (const code of unknownLocaleCodes(LOCALE_UI, hostLocales)) {
      const message = `dsh-leader-agent: locale/${code}.json 不在宿主语言目录里，运行时不会被选中`
      ctx.logger?.warn?.(message)
      // 浏览器的 client logger 不一定有 exporter；配置错误要能在 DevTools 里看见。
      console.warn(message)
    }
  }

  // 注册必须放进 effect：注册表把 effect 挂到调用方 fiber 上，在别的插件的
  // apply 里直接注册会让浏览器启动静默卡住。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PLUGIN_ID,
    kind: 'dsh-leader-agent-board',
    // 右栏按会话存布局：切会话时宿主会卸载非当前会话的栏。看板保留已访问的
    // body（keepMounted），切回来不重挂、不重新拉项目与卡片，避免闪一下。
    keepMounted: true,
    title: () => t('tab.board'),
    guide: [{
      id: 'board',
      order: 10,
      title: () => t('tab.board'),
      description: () => t('tab.board.description'),
    }],
  }), 'dsh-leader-agent 看板 tab 类型')

  // tab chip 的标题单独占一个席位：宿主在打开 tab 时就把 title thunk 的结果写进
  // 布局记录，之后切语言不会重读。这里按 definition id 接管自己的标题，让 chip
  // 跟着当前语言走；不注册时宿主回落到打开那一刻的快照。
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: PLUGIN_ID,
    locale: SLOT_LOCALE_NAMESPACE,
  }, BoardTabTitle)), 'dsh-leader-agent 看板 tab 标题')

  // 面板主体挂在 tab 类型 id 上：tab 类型 id 既是实现身份，也是它在
  // `sidebar.right.pane.tab` 座里的注册键。
  //
  // `getSessions` 与 `getUiWorkspace` 都是延迟取值器：ctx 上的服务在 apply 期
  // 未必就绪，直接取会拿到 undefined。`uiWorkspace` 由 web-app bundle 提供，
  // 第三方 bundle 不能把它写进 inject（缺服务会让整个插件挂起）。
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PLUGIN_ID,
    // 声明命名空间后宿主把当前语言的 `t` 注入组件 props，卡面上的槽位名
    // 因此随语言切换重渲染，不需要自己订阅 locale。
    locale: SLOT_LOCALE_NAMESPACE,
    inject: () => ({
      getSessions: () => ctx.sessions,
      getUiWorkspace: () => ctx.get('uiWorkspace'),
      getSidebarRight: () => ctx.get('sidebarRight'),
      callRemote: (method, args) => callProjectRemote(ctx, method, args),
      // 线路图有两套皮：浅色宿主走电蓝正交，深色宿主走黑金曲线
      getTheme: () => ctx.get('theme'),
      onThemeChange: (listener) => ctx.on('theme/change', listener),
    }),
  }, BoardBody)), 'dsh-leader-agent 看板面板')

  // 设置页：宿主的 settings.section 是公开槽位，注册了就出现在设置导航里。
  // 旧宿主没有这个槽时 inject 不触发，设置页静默缺席，看板按默认的炫酷模式走。
  mountBoardSettings(ctx, t)

  // 右栏 guide 页的「看板」入口由本插件自己渲染。宿主的入口来自 tab 类型的
  // 静态注册，注册表没有按会话过滤的扩展点（docs/capability-gaps.md 第 15 条），
  // 于是普通会话里也能看到一枚点开即空的「看板」胶囊。`sidebar.right.tab.guide.entry`
  // 按 provider id 分发，这里接管自己那一个：项目会话里画出来，其余返回 null。
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry',
    key: PLUGIN_ID,
    inject: () => ({
      callRemote: (method, args) => callProjectRemote(ctx, method, args),
    }),
  }, BoardGuideEntry)), 'dsh-leader-agent 看板入口')

  // 项目区块挂左栏底部（`sidebar.footer.action`）：左栏正文区只有
  // `sidebar.workspaces` 一个槽（已被宿主的工作区浏览占用），slot 机制没有装饰
  // 或包装能力，第三方插件无法在它旁边插入并列区块。footer 槽的 occupant 可以
  // 渲染任意内容，位置在工作区下方、设置按钮上方。
  //
  // `uiWorkspace` 只挂在 web-app bundle 上，一律惰性获取。
  //
  // 工作区服务的就绪单独用信号广播：它可能晚于本插件加载，而项目区块要订阅归档
  // 集合，订阅错过一次就再也收不到。
  const workspacesReady = createReadySignal()
  ctx.inject(['workspaces'], () => { workspacesReady.mark() })
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-leader-agent-projects',
    order: 10,
    label: () => t('project.label'),
    locale: SLOT_LOCALE_NAMESPACE,
    inject: () => ({
      callRemote: (method, args) => callProjectRemote(ctx, method, args),
      getUiWorkspace: () => ctx.get('uiWorkspace'),
      getSessions: () => ctx.sessions,
      // 归档走宿主的工作区服务：它是既有能力，别处归档的会话这里也要跟着消失。
      getWorkspaces: () => ctx.get('workspaces'),
      // 面板页是否接管主区域：宿主会话树据此不选中任何行，项目区块要同一个口径。
      getLayout: () => ctx.get('layout'),
      onWorkspacesReady: (listener) => workspacesReady.subscribe(listener),
    }),
  }, ProjectPanel)), 'dsh-leader-agent 左栏项目区块')

  // 一次性提示走跨栏浮层：`shell.overlay` 是宿主留给「徽标、toast 栈、状态
  // 药丸」这类全局表面的座位，浮在每一栏之上；窄侧栏收起项目浮层时提示仍在。
  // 宿主没有提供一行式的 toast API（`workspace.toast` 的 key 只认工作区自己的
  // 通知），所以这里自带一条，形态照宿主 Toast。
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-leader-agent-toast',
    order: 20,
  }, ToastOverlay)), 'dsh-leader-agent 提示浮层')

  // 项目会话标签栏：宿主主区域一次只挂一条会话，没有原生多标签。挂到跨栏
  // 浮层只是借一个稳定的 React 生命周期，真正的 DOM 由组件插到主面板顶部。
  // 普通会话由组件自己判定隐藏，这里不做过滤。
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-leader-agent-session-tabs',
    order: 30,
    locale: SLOT_LOCALE_NAMESPACE,
    inject: () => ({
      callRemote: (method, args) => callProjectRemote(ctx, method, args),
      getSessions: () => ctx.sessions,
      getUiWorkspace: () => ctx.get('uiWorkspace'),
      getLayout: () => ctx.get('layout'),
      getSidebarRight: () => ctx.get('sidebarRight'),
      // 「更多」菜单走宿主的 contextMenus 服务：标签栏接管按钮本身，菜单项
      // 仍由宿主与其它插件按 sessionHeader 目标注册，不在本仓复制一份。
      getContextMenus: () => ctx.get('contextMenus'),
    }),
  }, SessionTabsAnchor)), 'dsh-leader-agent 会话标签栏')

  // leader 会话不显示宿主的「已编辑 N 个文件」汇总卡片（`conversation.chat.turnTail`
  // 里的 deliverables 条目）：宿主的 slot 注册没有按会话过滤的参数，唯一的开关是
  // 全局偏好，所以走渲染层——在主面板容器上打标记，由本插件的样式表隐藏。
  // 锚点同样借 `shell.overlay` 的 React 生命周期，不渲染内容。
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-leader-agent-leader-changes',
    order: 40,
    inject: () => ({ getSessions: () => ctx.sessions }),
  }, LeaderChangesAnchor)), 'dsh-leader-agent leader 改动卡片隐藏')

  // leader 视图目标：让 leader 会话进入官方 active 形态，输入框停靠底部而会话区
  // 保持空白。`uiConversation` 由 ui-conversation bundle 提供，缺失时这个回调
  // 不执行（`ctx.inject` 单独起一个 fiber，不拖累本插件），leader 会话退化成
  // 官方欢迎页。
  ctx.inject(['uiConversation'], function mountLeaderViewFiber(conversationCtx) {
    mountLeaderView(conversationCtx)
    // 引导卡与视图入口共用输入框上方那个 dock 槽：新建项目后 leader 会话里
    // 一句话都没有，卡在这里说清下一步，发出第一句话即消失。
    mountGuideCard(conversationCtx)
    mountMessageBubbles(conversationCtx)
  })

  // 项目命名空间挂在官方 gateway client 的 `ctx.remote` 上。远程通道由官方
  // bundle 提供，缺失时这个回调不执行（`ctx.inject` 单独起一个 fiber，不拖累本
  // 插件），看板与左栏注册照常工作；面板此时显示「项目通道未就绪」。
  ctx.inject(['remote'], function mountProjectChannel(remoteCtx) {
    void mountProjectRemote(remoteCtx).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      remoteCtx.logger?.warn?.(`dsh-leader-agent: 项目通道初始化失败：${message}`)
    })
    // leader 会话名单走同一条通道：填充不挂在项目面板上，侧栏收起时面板会卸载。
    watchLeaderSessions(remoteCtx)
    // 建卡后自动打开右栏看板：监视器要走项目通道取卡片，通道没挂好就开不了。
    mountBoardMonitor(ctx)
  })
}

/**
 * 看板 tab chip 的标题。
 *
 * @param {object} props - 槽位属性
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 当前语言的翻译函数
 * @returns {string} 标题
 */
function BoardTabTitle({ t }) {
  return t('tab.board')
}

/**
 * 挂载看板监视器：建卡后自动打开（或聚焦）右栏的看板 tab。
 *
 * `sidebarRight` 惰性取：它由官方右栏 bundle 提供，缺服务时监视器不启动，
 * 插件其余部分照常工作。
 *
 * @param {object} ctx - 客户端 Cordis 上下文
 * @returns {void}
 */
function mountBoardMonitor(ctx) {
  const sidebarRight = ctx.get('sidebarRight')
  if (sidebarRight === undefined || sidebarRight === null) {
    ctx.logger?.warn?.('dsh-leader-agent: 当前宿主没有右栏服务，建卡后不自动打开看板')
    return
  }
  const stop = mountProjectBoardMonitor({
    sidebarRight,
    callRemote: (method, args) => callProjectRemote(ctx, method, args),
    logger: (message) => { ctx.logger?.warn?.(message) },
  })
  ctx.effect(() => stop, 'dsh-leader-agent 看板监视器')
}

/**
 * 注册 agent 消息的会话节点定义与渲染器。
 *
 * 两类消息共用同一套注册机制：leader 派给 worker 的任务（worker 会话里，渲染成
 * 右侧用户气泡）与 worker 的回报（leader 会话里，渲染成左侧 agent 气泡）。定义都用
 * exclusive claim 接管带自家 `source.kind` 的 `user/message`，让它们不再走官方
 * 上下文行；渲染器按节点 kind 注册，键必须等于 kind。后台巡查提醒不注册节点，
 * 它是带 `【后台巡查】` 前缀的普通文本；不再注册会话节点，始终显示为官方上下文行。
 *
 * @param {object} ctx - 客户端 Cordis 上下文（已注入 `uiConversation`）
 * @returns {void}
 */
function mountMessageBubbles(ctx) {
  const bubbles = [
    { kind: WORKER_TASK_NODE_KIND, definition: workerTaskDefinition, view: WorkerTaskView, label: 'leader 任务' },
    { kind: WORKER_REPORT_NODE_KIND, definition: workerReportDefinition, view: WorkerReportView, label: 'worker 回报' },
  ]
  for (const bubble of bubbles) {
    try {
      ctx.uiConversation.events.register(bubble.definition)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.(`dsh-leader-agent: ${bubble.label}节点注册失败：${message}`)
      continue
    }
    ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: bubble.kind,
      locale: SLOT_LOCALE_NAMESPACE,
      // `uiWorkspace` 只挂在 web-app bundle 上，写进 inject 的服务缺失会让整个插件
      // 挂起——惰性获取，点击名字时才取。
      inject: () => ({
        openSession: (sessionId) => ctx.get('uiWorkspace')?.openSession(sessionId),
      }),
    }, bubble.view)), `dsh-leader-agent ${bubble.label}渲染器`)
  }
}
