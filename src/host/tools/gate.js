/**
 * 工具面分配：按调用方角色决定这个会话能看见哪些工具。
 *
 * 宿主（0.2.1-rc.2）的 `tools.register()` 不接受按步条件，`tools.restrict()`
 * 才是可用的裁剪面——它要求 scoped context（`agent.ctx`），所以裁剪必须在
 * 会话创建时对该 agent 的上下文调用一次。
 *
 * 三种角色：
 *
 * - **协调者**：项目注册表里 `coordinatorSessionId` 指向的会话，建项目时就定下；
 * - **worker**：本 bundle 派出的根会话，判定依据是 `worker-sessions.js` 的内存集合
 *   （会话由 `agents.create` 建，会话头没有 `origin` 标记，只能按登记判）；
 * - **普通会话**：其余会话。
 *
 * 协调者拿到全部工具；普通会话与 worker 都没有 worker 编排与全库查询，普通会话再
 * 少掉卡片写入——它不在项目编排里，没有卡可写。worker 的完成回报不占工具面：由
 * `dispatch.js` 订阅会话事件自动结算。
 */

/** 只有协调者能用的工具：worker 编排、会话回看与全库卡片查询。 */
export const COORDINATOR_ONLY_TOOLS = Object.freeze([
  'list_cards',
  'spawn_worker',
  'message_worker',
  'read_worker_session',
])

/**
 * 卡片写入工具：只有协调者与 worker 能写卡。
 *
 * 卡片是项目里的任务事实，而普通会话不承担任何项目编排——它建出来的卡没有槽位、
 * 没有协调者认领，只会污染看板；它也不该改别人的卡。读同样不给：`list_cards`
 * 已经在 `COORDINATOR_ONLY_TOOLS` 里。
 */
export const CARD_WRITE_TOOLS = Object.freeze([
  'create_card',
  'update_card',
])

/** 普通会话要禁掉的：派工、全库查卡，加上卡片写入。 */
export const PLAIN_SESSION_DENY_TOOLS = Object.freeze([
  ...COORDINATOR_ONLY_TOOLS,
  ...CARD_WRITE_TOOLS,
])

/**
 * worker 要禁掉的：派工与全库查卡，外加建卡。
 *
 * worker 保留 `update_card`（写回自己挂的卡），但不建卡：建卡与派工是协调者的一条
 * 动作链（`COORDINATOR.md` 的「一个 worker 一张卡」、`leader-mode` 的协调者动作表），
 * `SLOTS.md` 的各槽位也没有让执行者建卡的步骤。worker 攒下的待办由它回报、协调者
 * 建卡。执行时另有一道 `assertCardCreator`。
 */
export const WORKER_DENY_TOOLS = Object.freeze([
  ...COORDINATOR_ONLY_TOOLS,
  'create_card',
])

/**
 * 宿主 subagent 组合提供的三件工具：它们只作用在 subagent 体系上。
 *
 * 单独导出是为了给「宿主侧有哪些工具名」一个语义正确的来源，文档允许集
 * （`src/host/index.js` 的 `documentedToolNames()`）取自这里。`COORDINATOR_UNUSABLE_TOOLS`
 * 是同一份数据的另一种用法——工具面裁剪。两者共享数据、语义不同：前者的变化理由是
 * 「宿主提供什么」，后者是「协调者能不能用」；文档侧只能走 `documentedToolNames()`。
 */
export const HOST_SUBAGENT_TOOLS = Object.freeze([
  'list_agents',
  'send_message',
  'interrupt_agent',
])

/**
 * 协调者不该看到的三件宿主工具：它们只作用在 subagent 体系上。
 *
 * 协调者的 worker 由本 bundle 用 `agents.create` 建成普通根会话，因此在宿主那三
 * 件工具里都不是合法目标——`list_agents` 列不到、`send_message` 过不了血统校验、
 * `interrupt_agent` 找不到目标却仍返回成功。留着它们只会让模型照描述去用，拿到
 * 一个假回执（中止尤其危险：以为停了，其实还在跑）。协议层也写了不要用，这里是
 * 从工具面结构上消除诱因。
 *
 * 只裁协调者：普通会话可能真的用官方 subagent，那时这三件是有效的。
 *
 * 它是 `HOST_SUBAGENT_TOOLS` 的别名、不是另一份名单：要改集合请改那份。
 */
export const COORDINATOR_UNUSABLE_TOOLS = HOST_SUBAGENT_TOOLS

/**
 * 算出某个会话要禁掉的工具名。
 *
 * @param {object} options - 选项
 * @param {object} options.agent - 即将开始工作的 agent
 * @param {(sessionId: string) => boolean} options.isCoordinatorSession - 协调者判定
 * @param {(sessionId: string) => boolean} [options.isWorkerSession] - worker 判定
 * @returns {string[]} 要禁掉的工具名
 */
export function deniedToolsFor({ agent, isCoordinatorSession, isWorkerSession }) {
  const worker = typeof isWorkerSession === 'function' && isWorkerSession(agent?.id) === true
  if (worker) return [...WORKER_DENY_TOOLS]
  if (isCoordinatorSession(agent?.id)) return [...COORDINATOR_UNUSABLE_TOOLS]
  return [...PLAIN_SESSION_DENY_TOOLS]
}

/**
 * 写卡身份判定：当前协调者与 worker 可以写卡。
 *
 * 与派工的 `assertCoordinator` 同口径：索引未就绪时 `isCoordinatorSession()` 对
 * 所有会话返回 true，而写卡会落盘并归属到项目，不能建立在这个宽松判定上——问不出
 * 身份就不给写。worker 是进程内的内存集合，不依赖项目索引，先短路。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 调用方会话 id
 * @param {(sessionId: string | undefined) => boolean} options.isCoordinatorSession -
 *   协调者判定（未就绪时宽松放行）
 * @param {(sessionId: string | undefined) => boolean} options.isWorkerSession - worker 判定
 * @param {() => Promise<boolean>} options.awaitIndex - 等项目索引就绪，报告它是否读出来
 * @returns {Promise<boolean>} 是否允许写卡
 */
export async function canWriteCardsFor({ sessionId, isCoordinatorSession, isWorkerSession, awaitIndex }) {
  if (isWorkerSession(sessionId) === true) return true
  if ((await awaitIndex()) !== true) return false
  return isCoordinatorSession(sessionId) === true
}

/**
 * 把工具面裁剪应用到某个 agent 的作用域。
 *
 * 会话每次创建（含冷恢复）都会发 `agent/created`，这里跟着重算一次：作用域是
 * 新建的，上一次的限制不会留下。
 *
 * `COORDINATOR_UNUSABLE_TOOLS` 来自宿主的 subagent 组合，那个组合可以被部署
 * 禁用、也可以改由 preset 子树注册；`restrict()` 遇到没注册过的名字会直接报错，
 * 所以整批失败时逐件重试，缺的那件跳过。
 *
 * 不能用 `get(name)` 做存在性探测：省略 scope 等于**全局视图**，而 web-app 把
 * 这三件在宿主平面 `disabled: true`、改由 preset 子树注册（`cordis.patch.yml`
 * 的 tool-subagent* 行）——全局视图里没有它们，探测会把三件全部误判成「不存在」，
 * 限制就悄悄失效了。`definitions()` 是 0.2.2-alpha.2 才加的方法，`engines.dsh`
 * 下限 0.2.1-rc.2 上没有它，别在裁剪路径上引入。
 *
 * 顺带记一笔：摘掉这三件后，preset 提供的 `subagent` / `subagent_fork` 仍在，
 * 协调者于是「能派不能跟」。这两个是通用能力（只读探索也用得上），暂时留着；
 * 协议层的立场是协调者不拿它们当 worker 用。
 *
 * @param {object} options - 选项
 * @param {object} options.agent - 刚创建的 agent
 * @param {(sessionId: string) => boolean} options.isCoordinatorSession - 协调者判定
 * @param {(sessionId: string) => boolean} [options.isWorkerSession] - worker 判定
 * @returns {string[]} 实际禁掉的工具名
 */
export function applyToolGate({ agent, isCoordinatorSession, isWorkerSession }) {
  const denied = deniedToolsFor({ agent, isCoordinatorSession, isWorkerSession })
  if (denied.length === 0) return denied
  try {
    agent.ctx.tools.restrict({ deny: denied })
    return denied
  } catch (error) {
    if (!isUnknownToolError(error)) throw error
    return denyAvailable(agent, denied)
  }
}

/**
 * 判断 `restrict()` 的失败是不是「名单里有当前组合没有的工具」。
 *
 * 认的是宿主自己那句固定前缀；文案变了就按未知异常抛出（Fail Loud），
 * 不要在这里兜一个可能掩盖真实装配错误的宽匹配。
 *
 * @param {unknown} error - restrict 抛出的错误
 * @returns {boolean} 是否为未知工具名
 */
function isUnknownToolError(error) {
  return error instanceof Error && error.message.includes('names unknown global tool')
}

/**
 * 逐件应用限制，跳过当前组合里缺的那几件。
 *
 * @param {object} agent - 刚创建的 agent
 * @param {readonly string[]} names - 要禁掉的工具名
 * @returns {string[]} 实际禁掉的工具名
 */
function denyAvailable(agent, names) {
  const applied = []
  for (const name of names) {
    try {
      agent.ctx.tools.restrict({ deny: [name] })
      applied.push(name)
    } catch (error) {
      if (!isUnknownToolError(error)) throw error
    }
  }
  return applied
}
