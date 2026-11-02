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
 * @module dsh-leader-kit/host/worker-sessions
 */

import { randomUUID } from 'node:crypto'
import { agentPresetOptions, agentPresetResumeSetup } from './agent-preset.js'
import { inheritPermission } from './permission-inherit.js'
import { createUserMessage } from './message.js'

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
   * 把会话标题改成 worker 显示名。
   *
   * @param {object} handle - AgentHandle
   * @param {string} name - 显示名
   * @returns {void}
   */
  function renameTitle(handle, name) {
    const sessionTitle = ctx.get('sessionTitle')
    if (sessionTitle === undefined) {
      logger('dsh-leader-kit: 当前组合缺 sessionTitle 服务，worker 会话标题保持宿主默认')
      return
    }
    try {
      sessionTitle.rename(handle.agent.session, name)
    } catch (error) {
      logger(`dsh-leader-kit: worker 会话标题改名被拒：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 造一条协调者发来的任务消息。
   *
   * @param {string} text - 正文
   * @param {string} name - worker 显示名
   * @param {string} parentSessionId - 协调者会话 id
   * @returns {object} 用户消息
   */
  function taskMessage(text, name, parentSessionId) {
    return createUserMessage(
      [{ type: 'text', text }],
      { kind: 'dsh-leader-kit/worker-task', name, parentSessionId },
    )
  }

  /**
   * 取当前的默认模型选择，包成宿主认识的 agentOptions。
   *
   * 不传的话会话能建起来，但系统提示里的 `{{model}}` 变量没有值——deployment
   * persona 段是模板，渲染时严格插值，缺值直接让首轮失败（实测：
   * `prompt variable "{{model}}" has no value`）。协调者会话走
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
   * 把新 worker 会话挂进项目工作区。
   *
   * 归属只决定它在官方左栏里落在哪个分组：不挂就是「未分组」，而它的协调者已经
   * 挂在项目工作区里。挂失败不阻塞派工——会话已经建好并要收任务，少一层归属比
   * 派工失败轻得多，所以这里只记日志。
   *
   * @param {object} ctx - Cordis 上下文
   * @param {string | undefined} workspaceId - 目标工作区
   * @param {string} sessionId - worker 会话 id
   * @param {(message: string) => void} log - 日志输出
   * @returns {void}
   */
  function attachToWorkspace(ctx, workspaceId, sessionId, log) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return
    const workspace = ctx.get('workspaceRegistry')?.get?.(workspaceId)
    if (workspace === undefined) return
    if ((workspace.sessionIds ?? []).includes(sessionId)) return
    void workspace.attachSession(sessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      log(`dsh-leader-kit: worker 会话 ${sessionId} 挂到工作区 ${workspaceId} 失败，它会留在官方树的「未分组」里：${message}`)
    })
  }

  /**
   * 补做建会话时的「呈现」：改标题、挂项目工作区。
   *
   * @param {object} handle - AgentHandle
   * @param {string} sessionId - 会话 id
   * @param {string | undefined} name - 显示名
   * @param {string | undefined} workspaceId - 目标工作区
   * @returns {void}
   */
  function presentOne(handle, sessionId, name, workspaceId) {
    if (typeof name === 'string' && name !== '') renameTitle(handle, name)
    attachToWorkspace(ctx, workspaceId, sessionId, logger)
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
      logger(`dsh-leader-kit: worker ${sessionId} 销毁失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    return true
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
     * 开工由协调者随后的 `message_worker` 触发：这样槽位绑定可以先落盘，第一条
     * 任务请求组装时角色槽位与卡片事实才读得到。建会话本身不产生任何模型调用。
     *
     * @param {object} options - 派工参数
     * @param {string | undefined} options.cwd - 工作目录
     * @param {string} [options.name] - 显示名（同时用作会话标题）；`deferPresentation` 时由 `present` 使用
     * @param {string} [options.workspaceId] - 与协调者同属的项目工作区
     * @param {boolean} [options.deferPresentation] - 推后改名与挂工作区；派工要在绑卡成功后才做
     * @param {object} [options.permissionFrom] - 权限来源会话（协调者）；沙箱模式与审批策略从它继承
     * @param {AbortSignal} options.signal - 取消信号
     * @returns {Promise<string>} 新会话 id
     */
    async spawn({ cwd, name, workspaceId, signal, permissionFrom, deferPresentation = false }) {
      const agents = ctx.get('agents')
      if (agents === undefined) {
        throw new Error('dsh-leader-kit: 当前组合未启用 agents 服务，无法创建 worker 会话')
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
      // 权限要在首轮之前落定：宿主的 permissionPresets 已在 `agent/created` 上给
      // 这条新会话 pin 了**用户默认** preset，这里用协调者的有效值覆盖它。
      inheritPermission({ ctx, fromSession: permissionFrom, toSession: handle.agent.session, logger })
      if (!deferPresentation) presentOne(handle, sessionId, name, workspaceId)
      return sessionId
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
     * @param {string} [options.workspaceId] - 与协调者同属的项目工作区
     * @returns {void}
     */
    present(sessionId, { name, workspaceId }) {
      const handle = live.get(sessionId)
      if (handle === undefined) throw new Error(`dsh-leader-kit: 会话 ${sessionId} 不在活表里，无法补做标题与工作区归属`)
      presentOne(handle, sessionId, name, workspaceId)
    },

    /**
     * 给 worker 发消息。活着就直接投，不在内存就冷恢复后投。
     *
     * @param {object} options - 投递参数
     * @param {string} options.sessionId - worker 会话 id
     * @param {string} options.text - 正文
     * @param {string} [options.name] - 顺手改的显示名
     * @param {string} options.parentSessionId - 协调者会话 id
     * @param {AbortSignal} options.signal - 取消信号
     * @returns {Promise<'live' | 'resumed'>} 投递形态
     */
    async send({ sessionId, text, name, parentSessionId, signal }) {
      let handle = live.get(sessionId)
      const resumed = handle === undefined
      if (handle === undefined) {
        const agents = ctx.get('agents')
        if (agents === undefined) {
          throw new Error('dsh-leader-kit: 当前组合未启用 agents 服务，无法唤醒 worker 会话')
        }
        // 冷恢复建的是新的作用域，preset 组合不会自己回来；按会话投影里记的
        // preset 重新挂（宿主 resume 路径同样走 composeAgent）。
        handle = await agents.resume({ resumeSessionId: sessionId, signal, ...agentPresetResumeSetup(ctx, logger) })
        live.set(sessionId, handle)
        workerIds.add(sessionId)
      }
      const displayName = name ?? handle.agent.session?.header?.title ?? sessionId
      if (name !== undefined) renameTitle(handle, name)
      handle.agent.followup(taskMessage(text, displayName, parentSessionId))
      return resumed ? 'resumed' : 'live'
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
