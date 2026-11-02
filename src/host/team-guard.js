/**
 * agent-team（experimental）与本 bundle 的编排并存时的一致性护栏。
 *
 * 宿主一旦加载 `@deepseek-ai/dsh-experimental-agent-team-profile`，`agentTeams`
 * 服务就存在，`tool-agent-team` 会给每个「普通根会话」装上团队工具。本 bundle
 * 的 worker 正是普通根会话（`agents.create` 建，没有 `parentSession`），于是被
 * 当成隐式 Lead：它能自己 `spawn_teammate`、自己记 team 任务，绕开协调者与卡片
 * 的项目归属；协调者则同时看到两套派工工具。
 *
 * 工具面挡不住：团队工具注册在 Agent scope，而 `tools.restrict({ deny })` 只接受
 * 全局工具名（宿主 `packages/core/tools/src/index.ts` 的 `restrictableNames`），
 * `tool-subagent*` 的全局注册又被 agent-team-profile 禁用了。所以这里只做两件事
 * ——会话创建时告警一次，以及给协调者与 worker 的运行时上下文写明不要混用。
 * 两边的「该用什么」按各自工具面分开写：worker 没有 worker 编排工具，共用一份
 * 文案会让它去调一个被 deny 的名字。
 *
 * @module dsh-leader-kit/host/team-guard
 */

/**
 * agent-team 注入的团队工具名（dsh 0.2.1-rc.2）。
 *
 * 它们按 teammate 名字与 subagent 血统寻址，对 worker 一律无效：worker 是普通根
 * 会话，不在 roster 里。
 */
export const TEAM_TOOL_NAMES = Object.freeze([
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
])

/** 注入项的上下文名。 */
export const TEAM_BAN_CONTEXT_NAME = 'dsh-leader-kit:team-ban'

/**
 * 注入项在运行时上下文里的位置。
 *
 * 紧跟协调者手册（104）与角色槽位（105）之后：三者都是「这个会话该怎么干活」的
 * 约束，排在宿主的 SUBAGENT_DELEGATION（120）与 TEAM_IDENTITY（125）之前。
 */
export const TEAM_BAN_CONTEXT_ORDER = 106

/**
 * 各角色的正向指引：文本里提到的「该用哪个」必须落在该角色自己的工具面里。
 *
 * 协调者与 worker 的工具面不同（`tools/gate.js` 的 `COORDINATOR_ONLY_TOOLS` 对
 * worker 全禁），共用一份文案就会让 worker 照做一个它没有的工具、拿 tool-not-found。
 * 单测按这份清单核对，见 `tests/team-guard.test.js`。
 */
export const TEAM_BAN_GUIDANCE = Object.freeze({
  coordinator: Object.freeze(['spawn_worker', 'message_worker', 'create_card', 'update_card']),
  worker: Object.freeze(['update_card']),
})

const TEAM_BAN_HEADER = [
  '## 环境：agent-team 与本流程并存',
  '',
  '当前部署同时加载了 dsh 的 experimental agent-team（`agentTeams` 服务存在）。它的团队工具'
  + `（\`${TEAM_TOOL_NAMES.join('` / `')}\`）不参与本流程，不要用：`,
]

/** 协调者的禁令正文。 */
export const TEAM_BAN_TEXT_COORDINATOR = [
  ...TEAM_BAN_HEADER,
  '',
  '- 派活与续聊只用 `spawn_worker` / `message_worker`。`spawn_teammate` 建的 teammate 有父会话，'
  + '不进入 worker 登记表，完成回报也送不到协调者。',
  '- 找 worker 不要用 `send_message` / `list_agents` / `wait_agent` / `interrupt_agent`：'
  + '它们按 teammate 名字与 subagent 血统寻址，而 worker 是普通根会话，不在名册里。',
  '- 任务事实写进卡片（`create_card` / `update_card`），不要用 `team_task_*`——看板只读卡片。',
].join('\n')

/**
 * worker 的禁令正文。
 *
 * 它没有 `spawn_worker` / `message_worker` / `list_cards`（见 `tools/gate.js`），所以
 * 只讲它真能做的：当轮交付与卡片汇报。
 */
export const TEAM_BAN_TEXT_WORKER = [
  ...TEAM_BAN_HEADER,
  '',
  '- 派活不是你的事：`spawn_teammate` 建的 teammate 不在协调者的 worker 登记表里，'
  + '完成回报也送不到协调者；要让协调者继续派活就在当轮交付里说明。',
  '- 续聊与收尾不要用 `send_message` / `list_agents` / `wait_agent` / `interrupt_agent`：'
  + '它们按 teammate 名字与 subagent 血统寻址，本会话是普通根会话，不在名册里。',
  '- 当轮结束由系统结算，不用自己调停；交付落在自己的 worktree 与 PR 上，'
  + '任务事实用 `update_card` 汇报——看板只读卡片，不要用 `team_task_*`。',
].join('\n')

/**
 * 判断当前组合是否加载了 agent-team。
 *
 * 服务名是最可靠的信号：它由 agent-team 插件注册（实验包 `src/index.ts` 的
 * `super(ctx, 'agentTeams')`），profile 里加不加 bundle 只决定有没有这个服务。
 * 与 `sessionController` 一样走 `ctx.get()`：base bundle 没有它，声明成必需依赖
 * 会让整个插件挂起。
 *
 * @param {object} ctx - Cordis 上下文
 * @returns {boolean} 是否启用了 agent-team
 */
export function isAgentTeamEnabled(ctx) {
  return ctx?.get?.('agentTeams') !== undefined
}

/**
 * 算出某个会话要注入的禁令文本。
 *
 * 只给协调者与 worker：普通会话可能真的在用 agent-team 的 teammate，那套工具对
 * 它们是有效的，禁止没有依据。
 *
 * @param {object} options - 选项
 * @param {string} options.sessionId - 会话 id
 * @param {boolean} options.enabled - 当前组合是否启用了 agent-team
 * @param {(sessionId: string) => boolean} options.isCoordinatorSession - 协调者判定
 * @param {(sessionId: string) => boolean} [options.isWorkerSession] - worker 判定
 * @returns {string} 禁令文本；不适用时为空串
 */
export function teamBanFor({ sessionId, enabled, isCoordinatorSession, isWorkerSession }) {
  if (!enabled) return ''
  if (isCoordinatorSession(sessionId) === true) return TEAM_BAN_TEXT_COORDINATOR
  const worker = typeof isWorkerSession === 'function' && isWorkerSession(sessionId) === true
  return worker ? TEAM_BAN_TEXT_WORKER : ''
}

/**
 * 注册禁令注入，并给出「检测到 agent-team 时告警一次」的动作。
 *
 * 告警不能只在装配时探：bundle 的加载顺序决定 agent-team 服务可能比本插件晚
 * 注册。会话创建一定发生在两者都装配完之后，所以在 `agent/created` 上调
 * `warnOnce()`，第一次会话就把话说出来。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {(sessionId: string) => boolean} options.isCoordinatorSession - 协调者判定
 * @param {(sessionId: string) => boolean} [options.isWorkerSession] - worker 判定
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {{ warnOnce: () => void }} 告警入口
 */
export function applyTeamGuard({
  ctx, isCoordinatorSession, isWorkerSession, logger = () => {},
}) {
  ctx.effect(() => ctx.systemPrompt.context({
    name: TEAM_BAN_CONTEXT_NAME,
    order: TEAM_BAN_CONTEXT_ORDER,
    // 正文是固定中文，不含模板变量；按字面量处理，避免 `{{` 被当插值。
    interpolate: false,
    required: true,
    text: (context) => {
      const sessionId = context.agent?.id
      if (typeof sessionId !== 'string') return ''
      try {
        return teamBanFor({
          sessionId,
          enabled: isAgentTeamEnabled(ctx),
          isCoordinatorSession,
          isWorkerSession,
        })
      } catch (error) {
        // 求值失败会让整个 turn 崩掉；禁令是增量信息，取不到就当没有。
        logger(`dsh-leader-kit: 渲染 agent-team 禁令失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-leader-kit agent-team 禁令注入')

  let warned = false
  return {
    warnOnce() {
      if (warned || !isAgentTeamEnabled(ctx)) return
      warned = true
      logger(
        'dsh-leader-kit: 检测到 agent-team（`agentTeams` 服务）：它的团队工具会装进协调者与 worker 会话'
        + '——worker 是普通根会话，被 agent-team 当成隐式 Lead。工具面挡不住（团队工具注册在 Agent scope），'
        + '已在协调者与 worker 的运行时上下文里写明不要混用；要彻底隔离请从 profile 移除'
        + ' @deepseek-ai/dsh-experimental-agent-team-profile。',
      )
    },
  }
}
