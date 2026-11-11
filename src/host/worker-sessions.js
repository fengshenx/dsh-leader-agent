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
import { WORKER_TASK_SOURCE_KIND } from '../shared/worker-task.js'

/**
 * 宿主以「会话已有活写句柄」拒绝冷恢复时，换成使用者能照做的说明。
 *
 * 按 `name` / `code` 判而不匹配文案：宿主只保证错误类型的身份，文案随版本调整。
 *
 * @param {unknown} error - `agents.resume()` 抛出的错误
 * @param {string} sessionId - 目标会话 id
 * @returns {unknown} 原错误，或带 `cause` 的说明错误
 */
function explainOccupiedError(error, sessionId) {
  const occupied = error instanceof Error
    && (error.name === 'SessionAlreadyOwnedError' || error.code === 'SessionAlreadyOwnedError')
  if (!occupied) return error
  return new Error(
    `worker 会话 ${sessionId} 正被宿主占用（已有窗口打开它的写句柄），不能在这里冷恢复；请先关闭那个会话窗口再试，或直接在那个窗口里继续对话。`,
    { cause: error },
  )
}

/**
 * 创建 worker 会话管理器。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 管理器
 */
export function createWorkerSessions({ ctx, logger = () => {} }) {
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
   * @returns {object} 用户消息
   */
  function taskMessage(text, name, parentSessionId) {
    return createUserMessage(
      [{ type: 'text', text }],
      { kind: WORKER_TASK_SOURCE_KIND, name, parentSessionId },
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
   * 把任务消息投进指定 agent 的当前轮次。
   *
   * @param {object} agent - 宿主的活 Agent（`AgentHandle.agent` 或 `agents.get()`）
   * @param {'live' | 'resumed'} form - 投递形态
   * @param {object} options - 投递参数
   * @param {string} options.sessionId - 会话 id
   * @param {string} options.text - 正文
   * @param {string} [options.name] - 顺手改的显示名
   * @param {string} options.parentSessionId - leader 会话 id
   * @returns {'live' | 'resumed'} 投递形态
   */
  function deliver(agent, form, { sessionId, text, name, parentSessionId }) {
    const displayName = name ?? agent.session?.header?.title ?? sessionId
    if (name !== undefined) renameTitle(agent, name)
    agent.steer(taskMessage(text, displayName, parentSessionId))
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
      // 先登记再恢复：`agent/created` 在 resume 内部就发出来了，晚一步这个会话
      // 会被裁成普通会话——worker 于是丢掉卡片写入，再也汇报不了自己的卡。
      const known = workerIds.has(sessionId)
      workerIds.add(sessionId)
      let handle
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, signal, ...agentPresetResumeSetup(ctx, logger) })
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
     * @param {AbortSignal} options.signal - 取消信号
     * @returns {Promise<{ sessionId: string, permission: object | undefined }>} 新会话 id 与 worker 实际生效的权限
     */
    async spawn({ cwd, name, signal, permissionFrom, deferPresentation = false }) {
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
          ...agentOptionsFromDefaults(),
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
     * @param {AbortSignal} options.signal - 取消信号
     * @returns {Promise<'live' | 'resumed'>} 投递形态
     */
    async send({ sessionId, text, name, parentSessionId, signal }) {
      const current = live.get(sessionId)
      if (current !== undefined) {
        return deliver(current.agent, 'live', { sessionId, text, name, parentSessionId })
      }
      // 复用宿主 agent 但不登记进 live：dispose 是持有句柄那一方的所有权，这里
      // 只是借它的作用域投递，不能替宿主收掉一个被人打开着的会话。
      const active = ctx.get('agents')?.get(sessionId)
      if (active !== undefined) {
        return deliver(active, 'live', { sessionId, text, name, parentSessionId })
      }
      let handle
      try {
        handle = await resumeOnce(sessionId, signal)
      } catch (error) {
        throw explainOccupiedError(error, sessionId)
      }
      return deliver(handle.agent, 'resumed', { sessionId, text, name, parentSessionId })
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
