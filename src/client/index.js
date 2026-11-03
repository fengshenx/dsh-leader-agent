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
 * @module dsh-leader-kit/client
 */

import { BoardBody } from './board.js'
import { BoardGuideEntry } from './board-guide-entry.js'
import { ProjectPanel } from './project-panel.js'
import { mountLeaderView } from './leader-view.js'
import { watchLeaderSessions } from './leader-session-index.js'
import { SLOT_LOCALE_NAMESPACE, en, zh } from './locales.js'
import { callProjectRemote, mountProjectRemote, reportProjectRemoteError } from './project-remote.js'
import { mountProjectBoardMonitor } from './project-board-monitor.js'
import { createReadySignal } from './ready-signal.js'
import { ToastOverlay } from './toast-view.js'
import { WORKER_REPORT_NODE_KIND, workerReportDefinition } from './worker-report-definition.js'
import { WorkerReportView } from './worker-report-view.js'

/**
 * 本插件在宿主注册表里的身份：tab 类型 id、面板与入口的注册键都用它。
 *
 * 这几处必须同值（guide 入口按 provider id 分发，宿主拿它当槽位键），写两遍
 * 容易改一处漏另一处——漏了就静默退回「全局入口」，入口又对所有会话可见。
 */
const PLUGIN_ID = 'dsh-leader-kit'

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
    () => ctx.locale.register(SLOT_LOCALE_NAMESPACE, { zh, en }),
    'dsh-leader-kit 槽位显示名',
  )

  // 注册必须放进 effect：注册表把 effect 挂到调用方 fiber 上，在别的插件的
  // apply 里直接注册会让浏览器启动静默卡住。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PLUGIN_ID,
    kind: 'dsh-leader-kit-board',
    title: () => '看板',
    guide: [{
      id: 'board',
      order: 10,
      title: () => '看板',
      description: () => '项目 leader 与 worker 会话里的任务交付看板',
    }],
  }), 'dsh-leader-kit 看板 tab 类型')

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
      callRemote: (method, args) => callProjectRemote(ctx, method, args),
    }),
  }, BoardBody)), 'dsh-leader-kit 看板面板')

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
  }, BoardGuideEntry)), 'dsh-leader-kit 看板入口')

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
    id: 'dsh-leader-kit-projects',
    order: 10,
    label: '项目',
    inject: () => ({
      callRemote: (method, args) => callProjectRemote(ctx, method, args),
      getUiWorkspace: () => ctx.get('uiWorkspace'),
      getSessions: () => ctx.sessions,
      // 归档走宿主的工作区服务：它是既有能力，别处归档的会话这里也要跟着消失。
      getWorkspaces: () => ctx.get('workspaces'),
      onWorkspacesReady: (listener) => workspacesReady.subscribe(listener),
    }),
  }, ProjectPanel)), 'dsh-leader-kit 左栏项目区块')

  // 一次性提示走跨栏浮层：`shell.overlay` 是宿主留给「徽标、toast 栈、状态
  // 药丸」这类全局表面的座位，浮在每一栏之上；窄侧栏收起项目浮层时提示仍在。
  // 宿主没有提供一行式的 toast API（`workspace.toast` 的 key 只认工作区自己的
  // 通知），所以这里自带一条，形态照宿主 Toast。
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-leader-kit-toast',
    order: 20,
  }, ToastOverlay)), 'dsh-leader-kit 提示浮层')

  // leader 视图目标：让 leader 会话进入官方 active 形态，输入框停靠底部而会话区
  // 保持空白。`uiConversation` 由 ui-conversation bundle 提供，缺失时这个回调
  // 不执行（`ctx.inject` 单独起一个 fiber，不拖累本插件），leader 会话退化成
  // 官方欢迎页。
  ctx.inject(['uiConversation'], function mountLeaderViewFiber(conversationCtx) {
    mountLeaderView(conversationCtx)
    mountWorkerReport(conversationCtx)
  })

  // 项目命名空间挂在官方 gateway client 的 `ctx.remote` 上。远程通道由官方
  // bundle 提供，缺失时这个回调不执行（`ctx.inject` 单独起一个 fiber，不拖累本
  // 插件），看板与左栏注册照常工作；面板此时显示「项目通道未就绪」。
  ctx.inject(['remote'], function mountProjectChannel(remoteCtx) {
    void mountProjectRemote(remoteCtx).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      reportProjectRemoteError(message)
      remoteCtx.logger?.warn?.(`dsh-leader-kit: 项目通道挂载失败：${message}`)
    })
    // leader 会话名单走同一条通道：填充不挂在项目面板上，侧栏收起时面板会卸载。
    watchLeaderSessions(remoteCtx)
    // 建卡后自动打开右栏看板：监视器要走项目通道取卡片，通道没挂好就开不了。
    mountBoardMonitor(ctx)
  })
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
    ctx.logger?.warn?.('dsh-leader-kit: 当前宿主没有右栏服务，建卡后不自动打开看板')
    return
  }
  const stop = mountProjectBoardMonitor({
    sidebarRight,
    callRemote: (method, args) => callProjectRemote(ctx, method, args),
    logger: (message) => { ctx.logger?.warn?.(message) },
  })
  ctx.effect(() => stop, 'dsh-leader-kit 看板监视器')
}

/**
 * 注册 worker 回报的会话节点定义与渲染器。
 *
 * 定义用 exclusive claim 接管带 worker 标记的 `user/message`，让它们不再走官方的
 * 右对齐用户气泡；渲染器按节点 kind 注册，键必须等于 kind。
 *
 * @param {object} ctx - 客户端 Cordis 上下文（已注入 `uiConversation`）
 * @returns {void}
 */
function mountWorkerReport(ctx) {
  try {
    ctx.uiConversation.events.register(workerReportDefinition)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`dsh-leader-kit: worker 回报节点注册失败：${message}`)
    return
  }
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: WORKER_REPORT_NODE_KIND,
    // `uiWorkspace` 只挂在 web-app bundle 上，写进 inject 的服务缺失会让整个插件
    // 挂起——惰性获取，点击名字时才取。
    inject: () => ({
      openSession: (sessionId) => ctx.get('uiWorkspace')?.openSession(sessionId),
    }),
  }, WorkerReportView)), 'dsh-leader-kit worker 回报渲染器')
}
