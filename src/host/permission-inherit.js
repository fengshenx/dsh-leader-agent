/**
 * 新建的 worker 会话继承协调者的权限（沙箱模式 + 审批策略）。
 *
 * worker 是 `agents.create` 建的普通根会话，宿主的 `permissionPresets` 在
 * `session/created` 上给每个新会话 pin **用户默认 preset**（`pinInitialPermission()`）
 * ——协调者自己切过的 `danger-full-access` / `never` 不会跟过来。于是同一个命令
 * 协调者能跑，worker 被沙箱拒绝；需要审批的调用还会落空：审批 answerer 按会话 UI
 * 作用域注册（`ui-approval` 的 `ctx.sessions.scopeOf(owner)`），后台 worker 的会话
 * 没人在界面上打开，`ask` 一律落到 `unavailable` → 工具被拒。
 *
 * 继承在会话建好之后、首轮之前：追加 knob 覆盖事件。`source: 'delegation'` 是宿主
 * 给派生子会话的既有标记（宿主 subagent 也用它写 `approval/policy`），表示这不是
 * 用户在这条会话里的选择。
 *
 * `permission/preset` 只在协调者是 `auto` 时补写：auto 的身份不在 knob 值里——它的
 * bundle（`danger-full-access` + `ask`）不匹配任何配置 preset，`derive()` 从 knobs
 * 反推会落到 `custom`，而 auto-review 的审查门判据正是
 * `permissionPresets.current(session) === 'auto'`。只继承裸 knobs 等于「沙箱放开、
 * 审查门关掉」，比不继承更宽。普通 preset 不写名字：knobs 一致时 `derive()` 反推
 * 出的就是同一个档。
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
    return approval.overrideOf(session) ?? approval.config.policy ?? 'ask'
  } catch (error) {
    // projection 还没注册时 stateOf 会抛（宿主启停窗口）；权限读取不该让派工失败。
    logger(`dsh-leader-kit: 读协调者的审批策略失败，worker 会话保持默认：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 读出会话当前的 preset 名（`derive()` 的结果：`auto` / 配置表里的名字 / `custom`）。
 *
 * @param {object | undefined} permissionPresets - `ctx.get('permissionPresets')`
 * @param {object} session - 会话
 * @param {(message: string) => void} logger - 日志输出
 * @returns {string | undefined} preset 名；服务缺失、缺方法或读取失败时 undefined
 */
function readPreset(permissionPresets, session, logger) {
  if (permissionPresets === undefined) return undefined
  if (typeof permissionPresets.current !== 'function') {
    logger('dsh-leader-kit: permissionPresets 服务缺少 current()，无法确认协调者的 preset，worker 不继承权限')
    return undefined
  }
  try {
    return permissionPresets.current(session)
  } catch (error) {
    logger(`dsh-leader-kit: 读协调者的 preset 失败，worker 不继承权限：${error instanceof Error ? error.message : String(error)}`)
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
 * 读会话当前的 preset 身份，读不到时按「未知」处理。
 *
 * @param {object} permissionPresets - `ctx.get('permissionPresets')`
 * @param {object} session - 会话
 * @returns {string | undefined} preset 名
 */
function currentPreset(permissionPresets, session) {
  try {
    return permissionPresets.current?.(session)
  } catch {
    // 读不回当前身份不影响结果：写一次 auto 照样落在正确的身份上。
    return undefined
  }
}

/**
 * 追加一条覆盖事件，写失败时记日志。
 *
 * 会话已经建好，权限写不进去不该让派工整个失败——worker 会退回默认权限，
 * 这个偏差由返回值里的 `skipped` 交给派工结果，用户看得见。
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
 * @returns {{ sandbox?: string, approval?: string, preset?: string, skipped: { knob: string, reason: string }[] } | undefined}
 *   继承后的权限事实；组合里没有权限旋钮时 undefined
 */
export function inheritPermission({ ctx, fromSession, toSession, logger = () => {} }) {
  if (fromSession === undefined || toSession === undefined) return undefined
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const approval = ctx.get('approval')
  // 两个服务都没有：这个组合没有权限旋钮（sdk-minimal 一类），无从继承也不必告警。
  if (sandboxPolicy === undefined && approval === undefined) return undefined
  if (sandboxPolicy === undefined || approval === undefined) {
    logger('dsh-leader-kit: 权限服务只露出一半（缺 sandboxPolicy 或 approval），worker 会话的权限继承不完整')
  }

  const permissionPresets = ctx.get('permissionPresets')
  const preset = readPreset(permissionPresets, fromSession, logger)
  // 读不到 preset 身份就排除不了 auto。auto 的 bundle 与任何配置 preset 都不重合，
  // 只写裸 knobs 会得到一个无沙箱、无审查门的 worker（比不继承更宽），
  // 所以这里整体放弃继承，让 worker 停在更严的默认上。
  if (permissionPresets !== undefined && preset === undefined) {
    return { skipped: [{ knob: 'preset', reason: '读不到协调者的 preset 身份，无法排除 auto，已放弃继承' }] }
  }

  const skipped = []
  const permission = { preset, skipped }
  let sandboxSettled = false
  if (sandboxPolicy === undefined) {
    skipped.push({ knob: 'sandbox', reason: '当前组合未启用 sandboxPolicy 服务' })
  } else {
    const mode = readSandbox(sandboxPolicy, fromSession, logger)
    if (mode === undefined) {
      skipped.push({ knob: 'sandbox', reason: '读协调者的沙箱模式失败，worker 保持默认' })
    } else {
      permission.sandbox = mode
      if (currentOverride(sandboxPolicy, toSession) === mode) {
        sandboxSettled = true
      } else if (appendOverride(toSession, 'sandbox/mode', { mode, source: 'delegation' }, logger)) {
        sandboxSettled = true
      } else {
        skipped.push({ knob: 'sandbox', reason: '写 sandbox/mode 失败，worker 保持默认' })
      }
    }
  }

  if (approval === undefined) {
    skipped.push({ knob: 'approval', reason: '当前组合未启用 approval 服务' })
  } else {
    const policy = readApproval(approval, fromSession, logger)
    if (policy === undefined) {
      skipped.push({ knob: 'approval', reason: '读协调者的审批策略失败，worker 保持默认' })
    } else {
      permission.approval = policy
      if (currentOverride(approval, toSession) !== policy
        && !appendOverride(toSession, 'approval/policy', { policy, source: 'delegation' }, logger)) {
        skipped.push({ knob: 'approval', reason: '写 approval/policy 失败，worker 保持默认' })
      }
    }
  }

  if (preset === 'auto') {
    if (!sandboxSettled) {
      skipped.push({ knob: 'preset', reason: '沙箱模式没有落定，未写 auto 身份，worker 留在更严的默认上' })
    } else if (currentPreset(permissionPresets, toSession) !== 'auto') {
      // auto 的审查门认的是 preset 身份而不是 knobs：不补这条，worker 的
      // `derive()` 落到 custom，沙箱已经放开而审查门关着。
      if (!appendOverride(toSession, 'permission/preset', { preset: 'auto' }, logger)) {
        skipped.push({ knob: 'preset', reason: '写 permission/preset 失败，auto 审查门不会生效' })
      }
    }
  }
  return permission
}
