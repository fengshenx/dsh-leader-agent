/**
 * 开发实例与 e2e 实例共用的 IO 层：派生 profile 目录、起 `dsh web`、从启动日志取地址。
 *
 * 纯计算在 `dev-plan.mjs`，这里只做文件系统与子进程。`npm run dev` 与浏览器 e2e
 * 都要「插件指向当前工作树、数据根独立、不碰 ~/.dsh」，写成两份必然漂移——e2e 会
 * 在开发实例装得下的组合之外悄悄跑，测到的就不是用户实际拿到的东西。
 *
 * @module dsh-leader-kit/scripts/dev-instance
 */

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLockSync, writeFileAtomicSync } from './atomic-write.mjs'
import { COPIED_PROFILE_FILES, deriveProfilePackage, mergeCredentialRefs, parseWebUrlLine, planNodeModules } from './dev-plan.mjs'
import { commandLaunchError, spawnCommand } from './spawn-command.mjs'

/**
 * 按源 profile 派生出目标 profile 目录。
 *
 * 配置只复制一次（用户之后在实例里改的开关不被覆盖），依赖逐条链到源、插件本体指
 * 工作树。目标里多出来的 `node_modules` 条目删掉——源里已移除的插件留着，会让
 * 「卸掉它之后还能不能起」测不出来。
 *
 * @param {object} options - 选项
 * @param {string} options.worktree - 当前工作树的绝对路径
 * @param {object} options.paths - `resolveDevPaths` 的结果
 * @param {object} options.sourcePackage - 源 profile 的 `package.json` 解析结果
 * @returns {void} 无返回
 */
export function prepareProfileDir({ worktree, paths, sourcePackage }) {
  mkdirSync(paths.profileDir, { recursive: true })

  for (const name of COPIED_PROFILE_FILES) {
    const target = join(paths.profileDir, name)
    if (existsSync(target)) continue
    const from = join(paths.sourceProfileDir, name)
    if (!existsSync(from)) {
      // cordis.patch.yml 是可选的覆盖层：用户没定制过就没有这个文件。
      if (name === 'cordis.patch.yml') continue
      throw new Error(`源 profile 缺少 ${name}: ${from}（源 HOME 里的 dsh 可能没起过）`)
    }
    copyFileSync(from, target)
  }

  writeFileSync(
    join(paths.profileDir, 'package.json'),
    `${JSON.stringify(deriveProfilePackage(sourcePackage, worktree), null, 2)}\n`,
  )

  const nodeModulesDir = join(paths.profileDir, 'node_modules')
  const sourceNodeModules = paths.sourceNodeModules
  if (!existsSync(sourceNodeModules)) {
    throw new Error(`源 profile 没有 node_modules: ${sourceNodeModules}（先在源 HOME 里跑一次 dsh）`)
  }
  mkdirSync(nodeModulesDir, { recursive: true })

  const plan = planNodeModules({
    sourceEntries: readdirSync(sourceNodeModules),
    existingEntries: readdirSync(nodeModulesDir),
    sourceNodeModules,
    worktree,
  })
  for (const name of plan.removals) rmSync(join(nodeModulesDir, name), { recursive: true, force: true })
  for (const { name, target } of plan.links) {
    const linkPath = join(nodeModulesDir, name)
    const current = lstatSync(linkPath, { throwIfNoEntry: false })
    if (current?.isSymbolicLink() && readlinkSync(linkPath) === target) continue
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(target, linkPath, 'junction')
  }
}

/**
 * 从源 HOME 的凭据文件继承 `refs`，返回新增的键名。
 *
 * 派生实例的数据根是独立的，凭据文件也跟着独立，新数据根第一次起实例要在界面上
 * 重填 API key。只搬 `refs`（按环境变量名存的密钥），不搬 `records`：账号授权带
 * 刷新令牌，两个实例各持一份会互相踢掉登录。目标里已有的条目不动。
 *
 * 读-改-写在宿主同一把写者锁里做：正在运行的实例可能同时在改这份文件，锁外的
 * 读-改-写会把它刚保存的值盖回去。写入走临时文件 + rename，替换后的权限位是 600，
 * 没有先落盘再 chmod 的可读窗口。
 *
 * `npm run dev`（`profiles/web`）与 `npm run desktop` 的派生数据根共用这一份：
 * 两边都是「换一个数据根验证本地改动」，凭据处理必须一致。
 *
 * @param {object} options - 选项
 * @param {string} options.credentialsPath - 目标数据根的 `.credentials.yaml`
 * @param {string} options.sourceCredentialsPath - 源 HOME 的 `.credentials.yaml`
 * @returns {{ keys: string[], notice: string | null }} 新增的键名与本次不合并的原因
 */
export function inheritCredentialRefs({ credentialsPath, sourceCredentialsPath }) {
  if (!existsSync(sourceCredentialsPath)) return { keys: [], notice: null }
  const sourceText = readFileSync(sourceCredentialsPath, 'utf8')
  // 写者锁是目标文件的同目录兄弟，锁的独占创建要求父目录已存在。
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 })
  return withFileLockSync(credentialsPath, () => {
    const targetText = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : null
    const { text, keys, notice } = mergeCredentialRefs({ sourceText, targetText })
    if (text !== null) writeFileAtomicSync(credentialsPath, text, { mode: 0o600, dirMode: 0o700 })
    return { keys, notice }
  })
}

/**
 * 起一个 `dsh web`，等到它打印带 token 的访问地址。
 *
 * 只解析就绪行，不猜端口、不轮询探测——宿主在挂载完成后才打印这一行，之前发请求
 * 会拿到 401 或连接失败，重试日志还会把真正的启动错误埋掉。子进程退出、启动超时
 * 都带上已捕获的输出报错。
 *
 * @param {object} options - 选项
 * @param {string} options.worktree - 子进程的 cwd
 * @param {object} options.env - 子进程环境变量（应含 `DSH_HOME`）
 * @param {string[]} [options.args] - 传给 dsh 的参数
 * @param {string} [options.dshCommand] - dsh 可执行文件，默认 `dsh`
 * @param {number} [options.timeoutMs] - 等就绪行的预算，默认 60 秒
 * @returns {Promise<{ url: string, origin: string, port: number, token: string, logs: string[], stop: () => Promise<void> }>}
 *   带 token 的地址与幂等的停止函数
 */
export function spawnDshWeb({
  worktree, env, args = [], dshCommand = process.env.DEV_DSH || 'dsh', timeoutMs = 60_000,
}) {
  // win32 上解析不到 shim 会同步抛：统一成 rejected promise，调用方只处理一种失败形态。
  let child
  try {
    child = spawnCommand({ command: dshCommand, args, cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return Promise.reject(error)
  }
  const logs = []
  let pending = ''
  let settled = false
  let timer = null
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  /** 就绪与失败都只落地一次：任一方先到，后续输出只进日志。 */
  const settle = (error, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error !== null) rejectReady(error)
    else resolveReady(value)
  }

  /** 先 TERM 等退出，超时再 KILL：直接 KILL 会留下半写的数据文件。 */
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const exited = await new Promise((resolveExit) => {
      const killTimer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(false) }, 5_000)
      child.once('exit', () => { clearTimeout(killTimer); resolveExit(true) })
    })
    if (!exited) await new Promise((resolveExit) => child.once('exit', resolveExit))
  }

  /** 子进程的 stdout/stderr 都攒进 logs：启动失败时这些是唯一的线索。 */
  const collect = (chunk) => {
    const text = chunk.toString()
    logs.push(text)
    if (settled) return
    pending += text
    let index = pending.indexOf('\n')
    while (index >= 0) {
      const line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      let parsed
      try {
        parsed = parseWebUrlLine(line)
      } catch (error) {
        settle(error, null)
        child.kill('SIGKILL')
        return
      }
      if (parsed !== null) {
        settle(null, { ...parsed, logs, stop })
        return
      }
      index = pending.indexOf('\n')
    }
  }

  timer = setTimeout(() => {
    child.kill('SIGKILL')
    settle(new Error(`等待 ${timeoutMs}ms 没有出现 "dsh web: <url>" 行。输出：\n${logs.join('')}`), null)
  }, timeoutMs)

  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.once('error', (error) => {
    const normalized = commandLaunchError(error, { command: dshCommand })
    settle(new Error(`无法启动 ${dshCommand}: ${normalized.message}`), null)
  })
  child.once('exit', (code, signal) => {
    settle(new Error(`dsh web 在就绪前退出（code ${code}, signal ${signal}）。输出：\n${logs.join('')}`), null)
  })

  return ready
}
