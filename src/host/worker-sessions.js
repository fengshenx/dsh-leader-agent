/**
 * worker 会话的创建、续聊与销毁。
 *
 * worker 是**普通根会话**，不是 subagent：宿主对 subagent 有固定行为——结算即
 * 销毁（`subagent/src/manager.ts` 的 `settlementState()` 一旦走到 `ready` 就
 * `close()` + `finishDisposal()`），而且子代理会话在界面上是只读的（「此子智能体
 * 暂时只读」，`ui-subagent/src/client/index.ts` 的 composer 认领判据）。这两条
 * 合起来让 worker 既不能常驻、也没法由人下钻对话。
 *
 * 换成 `ctx.agents.create()` 建的根会话后：
 * - 生命周期由本模块持有的 `AgentHandle` 决定，不 dispose 就一直活着；
 * - 会话是普通会话，人可以直接打开它输入新指令；
 * - 会话有独立 JSONL，进程重启后由 `agents.resume()` 接着跑。
 *
 * 本模块只管「会话活着没有、这轮怎么发起」；完成回报由 `dispatch.js` 订阅会话事件
 * 结算——它在 `turn/end` 那一刻折叠这一轮的 `assistant/message`，不要求 worker 主动
 * 交付，也不占工具面。
 *
 * @module dsh-leader-agent/host/worker-sessions
 */

import { randomUUID } from 'node:crypto'
import { agentPresetOptions, agentPresetResumeSetup } from './agent-preset.js'
import { inheritPermission } from './permission-inherit.js'
import { createUserMessage } from './message.js'
import { normalizeModelSelection, resolveWorkerModelSwitch } from './worker-model.js'
import { WORKER_TASK_SOURCE_KIND } from '../shared/worker-task.js'

/**
 * 宿主以「会话已有活写句柄」拒绝冷恢复时，换成使用者能照做的说明。
 *
 * 按 `name` 判而不匹配文案：rc.2 的 `SessionAlreadyOwnedError` 只设 `name`，
 * 文案会随版本调整。
 *
 * @param {unknown} error - `agents.resume()` 抛出的错误
 * @param {string} sessionId - 目标会话 id
 * @returns {unknown} 原错误，或带 `cause` 的说明错误
 */
function explainOccupiedError(error, sessionId) {
  const occupied = error instanceof Error && error.name === 'SessionAlreadyOwnedError'
  if (!occupied) return error
  return new Error(
    `message_worker: 会话 ${sessionId} 正被另一个会话窗口占用（宿主还在使用它），暂时不能把消息投进去；请先关闭打开它的窗口再试，或直接在那个窗口里继续对话。`,
    { cause: error },
  )
}

/**
 * 创建 worker 会话管理器。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @param {(sessionId: string) => Promise<object | undefined>} [options.resolveSessionSelection] -
 *   冷恢复时按会话 id 读回创建时的模型选择；返回 undefined 表示沿用旧行为
 * @returns {object} 管理器
 */
export function createWorkerSessions({ ctx, logger = () => {}, resolveSessionSelection }) {
  /** @type {Map<string, object>} 活着的 worker 会话，值为 `AgentHandle` */
  const live = new Map()
  /**
   * @type {Set<string>} 本 bundle 派出的 worker 会话 id。
   *
   * 工具面裁剪要在 `agent/created` 里同步判定「这条会话是不是 worker」，登记表是
   * 异步的，所以另存一份内存集合；启动时由调用方用登记表灌入（`adopt`）。
   */
  const workerIds = new Set()
  /**
   * @type {Map<string, Promise<object>>} 正在冷恢复的会话。
   *
   * 同一会话的并发 `send()` 共用一次 `agents.resume()`：两次恢复会建出两个作用域，
   * 后一个经 `live.set` 覆盖前一个，被覆盖的那个再没人 dispose。
   */
  const resuming = new Map()

  /**
   * 把会话标题改成 worker 显示名。
   *
   * @param {object} agent - 宿主的活 Agent
   * @param {string} name - 显示名
   * @returns {void}
   */
  function renameTitle(agent, name) {
    const sessionTitle = ctx.get('sessionTitle')
    if (sessionTitle === undefined) {
      logger('dsh-leader-agent: 当前组合缺 sessionTitle 服务，worker 会话标题保持宿主默认')
      return
    }
    try {
      sessionTitle.rename(agent.session, name)
    } catch (error) {
      logger(`dsh-leader-agent: worker 会话标题改名被拒：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 造一条 leader 发来的任务消息。
   *
   * @param {string} text - 正文
   * @param {string} name - worker 显示名
   * @param {string} parentSessionId - leader 会话 id
   * @param {string | undefined} messageId - 投递方预生成的消息 id（结算按它判回合归属）
   * @returns {object} 用户消息
   */
  function taskMessage(text, name, parentSessionId, messageId) {
    return createUserMessage(
      [{ type: 'text', text }],
      { kind: WORKER_TASK_SOURCE_KIND, name, parentSessionId },
      messageId,
    )
  }

  /**
   * 取当前的默认模型选择，包成宿主认识的 agentOptions。
   *
   * 不传的话会话能建起来，但系统提示里的 `{{model}}` 变量没有值——deployment
   * persona 段是模板，渲染时严格插值，缺值直接让首轮失败（实测：
   * `prompt variable "{{model}}" has no value`）。leader 会话走
   * `sessionController.create` 自带模型选择，worker 走 `agents.create` 就得自己给。
   *
   * @returns {object} agentOptions；当前组合没有默认模型服务时为空对象
   */
  function agentOptionsFromDefaults() {
    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined || typeof defaults.currentSelection !== 'function') return {}
    return {
      agentOptions: {
        get provider() { return defaults.currentSelection().provider },
        get model() { return defaults.currentSelection().model },
        get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
      },
    }
  }

  /**
   * 把派工选好的模型包成建会话参数。
   *
   * 显式选择用普通值而不是 getter：这是派工那一刻定下的 route，不该跟着部署默认
   * 模型之后的变化漂移。没有选择时回落到默认模型（旧行为）。
   *
   * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} selection - 模型选择
   * @returns {{ agentOptions?: object }} 建会话参数
   */
  function agentOptionsOf(selection) {
    if (selection === undefined) return agentOptionsFromDefaults()
    return { agentOptions: { ...selection } }
  }

  /**
   * 补做建会话时的「呈现」：改标题。
   *
   * @param {object} handle - AgentHandle
   * @param {string} sessionId - 会话 id
   * @param {string | undefined} name - 显示名
   * @returns {void}
   */
  function presentOne(handle, sessionId, name) {
    if (typeof name === 'string' && name !== '') renameTitle(handle.agent, name)
  }

  /**
   * 读 worker 当前使用的模型选择。
   *
   * 0.2.2 起 `agent.model.current()` 是权威入口（待生效的选择优先于上一次请求）；
   * rc.2 没有它，live route 在 `agent.options` 上。两者都读不到时返回 undefined，
   * 由调用方决定是报错还是只换完整 route。
   *
   * @param {object} agent - 宿主的活 Agent
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} 当前选择
   */
  function currentAgentSelection(agent) {
    const live = typeof agent.model?.current === 'function' ? agent.model.current() : undefined
    return normalizeModelSelection(live) ?? normalizeModelSelection(agent.options)
  }

  /**
   * 把新的模型选择装到活 Agent 上。
   *
   * 优先走宿主自己的 `model.select()`：它追加 `model/selection`、让下一步请求换 route，
   * 也与模型选择器共用同一份持久投影。rc.2 没有这个入口，只能改 `agent.options`
   * （那个版本的 loop 每次请求都读它）并手工补一条 `model/selection` 事件——不碰
   * `sessionController.selectModel()`，那会把 worker 的 route 存成用户的全局默认模型。
   *
   * @param {object} agent - 宿主的活 Agent
   * @param {{ provider: string, model: string, reasoningEffort?: string }} selection - 新选择
   * @returns {void}
   */
  function applyAgentSelection(agent, selection) {
    if (typeof agent.model?.select === 'function') {
      agent.model.select(selection)
      return
    }
    const options = agent.options
    if (options === null || typeof options !== 'object') {
      throw new Error('message_worker: 宿主 agent 缺少 model.select() 与 options，无法切换模型')
    }
    // 整体换一个普通对象而不是逐字段赋值：回落部署默认时 `options` 可能是只有
    // getter 的对象（本 bundle 自己造的 `agentOptionsFromDefaults`），赋值会抛
    // TypeError。先改 live route 再落事件，改不动时不要留下「日志说换了、实际没换」。
    const next = { ...options, provider: selection.provider, model: selection.model }
    if (selection.reasoningEffort === undefined) delete next.reasoningEffort
    else next.reasoningEffort = selection.reasoningEffort
    agent.options = next
    agent.session.append('model/selection', { ...selection })
  }

  /**
   * 投递失败时把 live route 退回切换前。
   *
   * 新旧宿主各自的真源不同：0.2.2+ 用 `model.select()` 选回，rc.2 恢复
   * `agent.options` 并补回旧选择。只有切换前本来就有 route 才能回滚；新宿主没有
   * 清空选择的公开入口，不能凭一个不存在的旧 route 造事件。
   *
   * @param {object} agent - 宿主的活 Agent
   * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} previous - 切换前的选择
   * @returns {void}
   */
  function restoreAgentSelection(agent, previous) {
    if (previous !== undefined) applyAgentSelection(agent, previous)
  }

  /**
   * 把任务消息投进指定 agent 的当前轮次。
   *
   * @param {object} agent - 宿主的活 Agent（`AgentHandle.agent` 或 `agents.get()`）
   * @param {'live' | 'resumed'} form - 投递形态
   * @param {object} options - 投递参数
   * @param {string} options.sessionId - 会话 id
   * @param {string} options.text - 正文
   * @param {string} [options.name] - 顺手改的显示名
   * @param {string} options.parentSessionId - leader 会话 id
   * @param {string | undefined} options.messageId - 调用方预生成的消息 id
   * @returns {'live' | 'resumed'} 投递形态
   */
  function deliver(agent, form, { sessionId, text, name, parentSessionId, messageId }) {
    const displayName = name ?? agent.session?.header?.title ?? sessionId
    if (name !== undefined) renameTitle(agent, name)
    agent.steer(taskMessage(text, displayName, parentSessionId, messageId))
    return form
  }

  /**
   * 销毁一个 worker 会话。
   *
   * @param {string} sessionId - 会话 id
   * @returns {Promise<boolean>} 是否确实销毁了一个在内存里的会话
   */
  async function disposeOne(sessionId) {
    const handle = live.get(sessionId)
    live.delete(sessionId)
    workerIds.delete(sessionId)
    if (handle === undefined) return false
    try {
      await handle.dispose()
    } catch (error) {
      logger(`dsh-leader-agent: worker ${sessionId} 销毁失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    return true
  }

  /**
   * 冷恢复一次会话；同一会话的并发调用共用这一次 `agents.resume()`。
   *
   * 两次恢复会建出两个作用域，后一个经 `live.set` 覆盖前一个，被覆盖的那个再没人
   * dispose——同一会话被并发唤醒时泄漏一个 agent。共用同一次恢复后两条消息各自
   * 投到同一个 handle。
   *
   * @param {string} sessionId - 会话 id
   * @param {AbortSignal} signal - 取消信号
   * @returns {Promise<object>} AgentHandle
   */
  function resumeOnce(sessionId, signal) {
    const pending = resuming.get(sessionId)
    if (pending !== undefined) return pending
    const task = (async () => {
      const agents = ctx.get('agents')
      if (agents === undefined) {
        throw new Error('dsh-leader-agent: 当前组合未启用 agents 服务，无法唤醒 worker 会话')
      }
      // 冷恢复建的是新的作用域，preset 组合不会自己回来；按会话投影里记的
      // preset 重新挂（宿主 resume 路径同样走 composeAgent）。
      //
      // 模型也要按派工登记表传回去：rc.2 的 resume 只从 agentOptions 取 route，
      // 不传的话自定义模型的 worker 冷恢复后没有 provider/model，首轮直接失败。
      const selection = typeof resolveSessionSelection === 'function'
        ? await resolveSessionSelection(sessionId)
        : undefined
      // 先登记再恢复：`agent/created` 在 resume 内部就发出来了，晚一步这个会话
      // 会被裁成普通会话——worker 于是丢掉卡片写入，再也汇报不了自己的卡。
      const known = workerIds.has(sessionId)
      workerIds.add(sessionId)
      let handle
      try {
        handle = await agents.resume({
          resumeSessionId: sessionId,
          signal,
          ...selection === undefined ? {} : { agentOptions: { ...selection } },
          ...agentPresetResumeSetup(ctx, logger),
        })
      } catch (error) {
        // 只回滚这次新登记的身份：已收编的 worker id 不能被抹掉，会话 id 不复用、
        // 留着不会误判（见 `forget`），抹掉反而让它下次被判成普通会话。
        if (!known) workerIds.delete(sessionId)
        throw error
      }
      live.set(sessionId, handle)
      return handle
    })()
    resuming.set(sessionId, task)
    // 清理挂在 `task` 的派生链上、不改它的结果：每条调用方各拿原错误。挂在
    // `set` 之后，同步失败的分支才不会删掉一个还没登记的条目。
    void task.catch(() => {}).finally(() => { resuming.delete(sessionId) })
    return task
  }

  return {
    /**
     * 判定某会话是否本 bundle 派出的 worker（同步，供工具面裁剪用）。
     *
     * @param {string} sessionId - 会话 id
     * @returns {boolean} 是否 worker
     */
    isWorkerSession(sessionId) {
      return workerIds.has(sessionId)
    },

    /**
     * 收编一个已存在的 worker 会话 id（进程启动时按登记表灌入）。
     *
     * @param {string} sessionId - 会话 id
     * @returns {void}
     */
    adopt(sessionId) {
      workerIds.add(sessionId)
    },

    /**
     * 取活着的 worker 会话句柄。
     *
     * @param {string} sessionId - 会话 id
     * @returns {object | undefined} AgentHandle；不在内存时 undefined
     */
    get(sessionId) {
      return live.get(sessionId)
    },

    /**
     * 忘掉一个已被宿主销毁的会话。
     *
     * 宿主自己销毁会话（会话管理里删除、外部归档等）时，这边的活表还留着失活
     * 句柄——之后 `message_worker` 会走 live 分支投给一个死会话，回执是成功而
     * worker 不会动。所以 `agent/disposed` 里要把记录摘掉，让续聊改走冷恢复。
     *
     * 只摘记录，不调宿主 dispose：会话已经没了，再销毁一次是多余动作。
     *
     * `workerIds` 故意保留：会话 id 不复用，留着「这个 id 曾是我的 worker」不会
     * 误判（工具面照旧按 worker 裁），冷恢复时 `send` 会重新把它放回活表。
     *
     * @param {string} sessionId - 会话 id
     * @returns {void}
     */
    forget(sessionId) {
      live.delete(sessionId)
    },

    /**
     * 新建一个 worker 会话，但**不投递任务**。
     *
     * 开工由 leader 随后的 `message_worker` 触发：这样槽位绑定可以先落盘，第一条
     * 任务请求组装时角色槽位与卡片事实才读得到。建会话本身不产生任何模型调用。
     *
     * @param {object} options - 派工参数
     * @param {string | undefined} options.cwd - 工作目录
     * @param {string} [options.name] - 显示名（同时用作会话标题）；`deferPresentation` 时由 `present` 使用
     * @param {boolean} [options.deferPresentation] - 推后改名与挂工作区；派工要在绑卡成功后才做
     * @param {object} [options.permissionFrom] - 权限来源会话（leader）；沙箱模式与审批策略从它继承
     * @param {{ provider: string, model: string, reasoningEffort?: string }} [options.selection] - 派工选好的模型
     * @param {AbortSignal} options.signal - 取消信号
     * @returns {Promise<{ sessionId: string, permission: object | undefined }>} 新会话 id 与 worker 实际生效的权限
     */
    async spawn({ cwd, name, signal, permissionFrom, deferPresentation = false, selection }) {
      const agents = ctx.get('agents')
      if (agents === undefined) {
        throw new Error('dsh-leader-agent: 当前组合未启用 agents 服务，无法创建 worker 会话')
      }
      const sessionId = `worker-${randomUUID()}`
      // 先解析 preset 再登记：解析失败就不该建会话——一个没有 bash / read 的
      // worker 只会空转，不如当场报错。
      const preset = await agentPresetOptions(ctx, logger)
      // 先登记再创建：`agent/created` 在 create 内部就发出来了，晚一步判定不到。
      workerIds.add(sessionId)
      const meta = {
        ...cwd === undefined ? {} : { cwd },
        ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset },
      }
      let handle
      try {
        handle = await agents.create({
          sessionId,
          signal,
          ...agentOptionsOf(selection),
          ...preset.setup === undefined ? {} : { setup: preset.setup },
          ...Object.keys(meta).length === 0 ? {} : { meta },
        })
      } catch (error) {
        // 会话没建成，身份也不能留着——否则这个 id 永远被判成 worker。
        workerIds.delete(sessionId)
        throw error
      }
      live.set(sessionId, handle)
      // 权限要在首轮之前落定：宿主的 permissionPresets 已在 `session/created` 上给
      // 这条新会话 pin 了**用户默认** preset，这里用 leader 的有效值覆盖它。
      const permission = inheritPermission({ ctx, fromSession: permissionFrom, toSession: handle.agent.session, logger })
      if (!deferPresentation) presentOne(handle, sessionId, name)
      return { sessionId, permission }
    },

    /**
     * 补做建会话时的「呈现」：改标题、挂项目工作区。
     *
     * `renameTitle` 会追加 `session/title` 事件，这是让一条零 turn 会话在磁盘上
     * materialize 的步骤；派工把它推后到绑卡成功之后，绑定失败回滚时磁盘上就
     * 不会留下一条空会话。
     *
     * @param {string} sessionId - 会话 id
     * @param {object} options - 呈现参数
     * @param {string} [options.name] - 显示名
     * @returns {void}
     */
    present(sessionId, { name }) {
      const handle = live.get(sessionId)
      if (handle === undefined) throw new Error(`dsh-leader-agent: 会话 ${sessionId} 不在活表里，无法补做标题与工作区归属`)
      presentOne(handle, sessionId, name)
    },

    /**
     * 给 worker 发消息。活着就直接投，不在内存就冷恢复后投。
     *
     * 投递边界是 **next-step**（`steer`）：worker 正在跑时消息插进它当前轮次的
     * 下一个 step，模型下一步就带着它；空闲（含冷恢复）时宿主会立刻开一轮，
     * 这一条成为首步输入。用 `followup` 则是 next-turn 边界——worker 忙时消息
     * 要等本轮结束才作为另一轮进入，leader 的纠偏/返工指令白等一整轮，本轮
     * 结束时还会先按旧产物结算一条通知。
     *
     * 「活着」有两层：本模块的 `live` 表，以及宿主自己的活 agent 表。GUI 打开
     * 或启动时恢复过的会话只在后者里，写句柄随它的 agent 常驻、不随 `turn/end`
     * 释放——这时去 `agents.resume()` 会被宿主判成「已有活写句柄」。必须先复用
     * 宿主 agent 直接投递，投不了才冷恢复。
     *
     * @param {object} options - 投递参数
     * @param {string} options.sessionId - worker 会话 id
     * @param {string} options.text - 正文
     * @param {string} [options.name] - 顺手改的显示名
     * @param {string} options.parentSessionId - leader 会话 id
     * @param {string} [options.messageId] - 调用方预生成的消息 id
     * @param {string} [options.model] - 同次切换到的模型（`provider/model` 或裸模型 id）
     * @param {string} [options.effort] - 同次切换到的 reasoning effort
     * @param {AbortSignal} options.signal - 取消信号
     * @returns {Promise<{ form: 'live' | 'resumed', selection: { provider: string, model: string, reasoningEffort?: string } | undefined }>}
     *   投递形态与本次实际装上的新模型选择
     */
    async send({ sessionId, text, name, parentSessionId, messageId, signal, model, effort }) {
      let agent
      let form
      const current = live.get(sessionId)
      if (current !== undefined) {
        agent = current.agent
        form = 'live'
      } else {
        // 复用宿主 agent 但不登记进 live：dispose 是持有句柄那一方的所有权，这里
        // 只是借它的作用域投递，不能替宿主收掉一个被人打开着的会话。
        const active = ctx.get('agents')?.get(sessionId)
        if (active !== undefined) {
          agent = active
          form = 'live'
        }
      }
      // 预检必须先于冷恢复：`resolveWorkerModelSwitch` 会调 `llm.resolveCallConfig`，
      // 失败时不能在磁盘上留下一个刚被唤醒、随后常驻的 live worker。冷 worker 的
      // 当前 route 从登记表读，和 resume 之后装上去的那条是同一个真源。
      let selection
      if (model !== undefined || effort !== undefined) {
        const currentSelection = agent === undefined
          ? typeof resolveSessionSelection === 'function'
            ? normalizeModelSelection(await resolveSessionSelection(sessionId))
            : undefined
          : currentAgentSelection(agent)
        selection = await resolveWorkerModelSwitch({
          ctx,
          current: currentSelection,
          model,
          effort,
          signal,
        })
      }
      if (agent === undefined) {
        let handle
        try {
          handle = await resumeOnce(sessionId, signal)
        } catch (error) {
          throw explainOccupiedError(error, sessionId)
        }
        agent = handle.agent
        form = 'resumed'
      }
      if (selection === undefined) {
        deliver(agent, form, { sessionId, text, name, parentSessionId, messageId })
        return { form, selection }
      }
      const previous = currentAgentSelection(agent)
      // 没有旧 route 就没有回滚目标；新宿主也没有清空选择的公开入口。先拒绝，
      // 不能先切过去、等投递失败再留下一个无法撤销的新 route。连切换入口都没有
      // 的宿主仍交给 applyAgentSelection 报它自己的缺 API 错误。
      if (previous === undefined && (typeof agent.model?.select === 'function' || agent.options !== undefined)) {
        throw new Error('message_worker: 该 worker 没有可回滚的当前模型选择，无法换模型；请重新派工（`spawn_worker`）并在派工时指定 model，或在宿主会话里手动设置模型。')
      }
      try {
        applyAgentSelection(agent, selection)
        deliver(agent, form, { sessionId, text, name, parentSessionId, messageId })
      } catch (error) {
        try {
          restoreAgentSelection(agent, previous)
        } catch (restoreError) {
          logger(`dsh-leader-agent: worker ${sessionId} 的模型回滚失败，live route 可能停在新选择：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
        }
        throw error
      }
      return { form, selection }
    },

    /**
     * 销毁一个 worker 会话（归档、删除项目、插件卸载时用）。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<boolean>} 是否确实销毁了一个在内存里的会话
     */
    dispose(sessionId) {
      return disposeOne(sessionId)
    },

    /**
     * 销毁全部在内存的 worker 会话（插件卸载）。
     *
     * @returns {Promise<void>} 全部处理完
     */
    async disposeAll() {
      await Promise.all([...live.keys()].map((id) => disposeOne(id)))
    },
  }
}
