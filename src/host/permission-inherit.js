/**
 * 新建的 worker 会话继承协调者的权限（沙箱模式 + 审批策略）。
 *
 * worker 是 `agents.create` 建的普通根会话，宿主的 `permissionPresets` 会在
 * `agent/created` 上给每个新会话 pin **用户默认 preset**（`pinInitialPermission()`，
 * `prepend` 执行）——协调者自己切过的 `danger-full-access` / `never` 不会跟过来。
 * 于是同一个命令协调者能跑，worker 被沙箱拒绝；需要审批的调用还会落空：审批
 * answerer 按会话 UI 作用域注册（`ui-approval` 的 `ctx.sessions.scopeOf(owner)`），
 * 后台 worker 的会话没人在界面上打开，`ask` 一律落到 `unavailable` → 工具被拒。
 *
 * 继承在会话建好之后、首轮之前：直接追加两个 knob 的覆盖事件。`source: 'delegation'`
 * 是宿主给派生子会话的既有标记（宿主 subagent 也用它写 `approval/policy`），表示
 * 这不是用户在这条会话里的选择。`permission/preset` 不写：它的名字由 `derive()`
 * 从 knob 值反推，knobs 一致时 UI 自然显示同一个 preset（协调者是 custom 时两边
 * 都显示 custom）。
 *
 * 边界：只继承一次，即派工那一刻。协调者之后切换 preset 不影响已派出的 worker——
 * 权限在宿主里本来就是逐会话的，worker 是独立会话。
 *
 * @module dsh-leader-kit/host/permission-inherit
 */

/**
 * 读出会话的有效沙箱模式（会话覆盖 ?? 部署默认）。
 *
 * @param {object} sandboxPolicy - `ctx.get('sandboxPolicy')`
 * @param {object} session - 会话
 * @param {(message: string) => void} logger - 日志输出
 * @returns {string | undefined} 模式；服务缺方法或解析失败时 undefined
 */
function readSandbox(sandboxPolicy, session, logger) {
  if (typeof sandboxPolicy.resolve !== 'function') {
    logger('dsh-leader-kit: sandboxPolicy 服务缺少 resolve()，worker 会话继承不到沙箱模式')
    return undefined
  }
  try {
    return sandboxPolicy.resolve({ session }).mode
  } catch (error) {
    logger(`dsh-leader-kit: 读协调者的沙箱模式失败，worker 会话保持默认：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 读出会话的有效审批策略（会话覆盖 ?? 部署默认）。
 *
 * @param {object} approval - `ctx.get('approval')`
 * @param {object} session - 会话
 * @param {(message: string) => void} logger - 日志输出
 * @returns {string | undefined} 策略；服务缺方法时 undefined
 */
function readApproval(approval, session, logger) {
  if (typeof approval.overrideOf !== 'function') {
    logger('dsh-leader-kit: approval 服务缺少 overrideOf()，worker 会话继承不到审批策略')
    return undefined
  }
  try {
    return approval.overrideOf(session) ?? approval.config?.policy ?? 'ask'
  } catch (error) {
    // projection 还没注册时 stateOf 会抛（宿主启停窗口）；权限读取不该让派工失败。
    logger(`dsh-leader-kit: 读协调者的审批策略失败，worker 会话保持默认：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 读会话当前的覆盖值，读不到时按「没有覆盖」处理。
 *
 * @param {object} service - `sandboxPolicy` 或 `approval`
 * @param {object} session - 会话
 * @returns {string | undefined} 覆盖值
 */
function currentOverride(service, session) {
  try {
    return service.overrideOf?.(session)
  } catch {
    // 读不回当前值不影响结果：写一次目标值照样落在正确的权限上。
    return undefined
  }
}

/**
 * 追加一条覆盖事件，写失败时记日志。
 *
 * 会话已经建好，权限写不进去不该让派工整个失败——worker 会退回默认权限，
 * 而这个偏差在它的失败回报里看得见。
 *
 * @param {object} session - 会话
 * @param {string} type - 事件名
 * @param {object} data - 事件负载
 * @param {(message: string) => void} logger - 日志输出
 * @returns {boolean} 是否写入成功
 */
function appendOverride(session, type, data, logger) {
  try {
    session.append(type, data)
    return true
  } catch (error) {
    logger(`dsh-leader-kit: 向 worker 会话写 ${type} 失败，它保持默认权限：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * 把协调者的有效权限写到 worker 会话上。
 *
 * 与 worker 当前值相同就不写：`permissionPresets` 已经 pin 过默认 knobs，覆盖值
 * 与默认一致时再追加一条只会在日志里留噪声。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {object} [options.fromSession] - 协调者会话（权限来源）
 * @param {object} [options.toSession] - worker 会话（写入目标）
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {string[]} 实际写入的 knob 事件名
 */
export function inheritPermission({ ctx, fromSession, toSession, logger = () => {} }) {
  if (fromSession === undefined || toSession === undefined) return []
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const approval = ctx.get('approval')
  // 两个服务都没有：这个组合没有权限旋钮（sdk-minimal 一类），无从继承也不必告警。
  if (sandboxPolicy === undefined && approval === undefined) return []
  if (sandboxPolicy === undefined || approval === undefined) {
    logger('dsh-leader-kit: 权限服务只露出一半（缺 sandboxPolicy 或 approval），worker 会话的权限继承不完整')
  }
  const applied = []
  if (sandboxPolicy !== undefined) {
    const mode = readSandbox(sandboxPolicy, fromSession, logger)
    if (mode !== undefined && currentOverride(sandboxPolicy, toSession) !== mode
      && appendOverride(toSession, 'sandbox/mode', { mode, source: 'delegation' }, logger)) {
      applied.push('sandbox/mode')
    }
  }
  if (approval !== undefined) {
    const policy = readApproval(approval, fromSession, logger)
    if (policy !== undefined && currentOverride(approval, toSession) !== policy
      && appendOverride(toSession, 'approval/policy', { policy, source: 'delegation' }, logger)) {
      applied.push('approval/policy')
    }
  }
  return applied
}
