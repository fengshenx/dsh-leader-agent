/**
 * `npm run dev` —— 起一个挂本工作树插件版本的 dsh 开发实例。
 *
 * 为什么不是 `dsh plugin --profile web add <本目录> && dsh web`：那会改写用户在
 * `~/.dsh` 里的日常 profile，几个工作树并行开发时互相覆盖（后装的赢），并且开发
 * 实例与日常实例共用会话、项目与卡片数据——协调者插件在这些数据上写，混用会互相
 * 干扰。
 *
 * 这里的做法：
 * - 数据根（`DSH_HOME`）默认落在工作树内的 `.dev/home`，删掉即重置，工作树删掉
 *   时一起消失；
 * - profile 从源 HOME 的 `profiles/web` 派生：`package.json` 照抄依赖与 bundle
 *   列表（复现日常组合），只把 `dsh-leader-kit` 换成工作树链接；
 * - `node_modules` 不复制，逐条符号链接到源 profile 的同名条目——依赖仍由源里那
 *   一份承担，源里升级 dsh 或增删插件时开发实例自动跟随；
 * - 凭据文件里的 `refs` 从源 HOME 继承：数据根独立，凭据也跟着独立，新工作树第一次
 *   起实例本来要重填 API key。不做成 `DEEPSEEK_API_KEY` 启动环境注入——那样 key 会
 *   留在 agent 工具进程的环境里。只搬 `refs` 不搬 `records`（账号授权的刷新令牌两个
 *   实例各持一份会互相踢掉登录）；目标实例里已有的条目不动，界面上改过的 key 优先，
 *   要重新跟随源就删掉那一条。写入与运行中的实例共用一把写者锁，临时文件 + rename
 *   提交、权限 600；目标凭据文档不是 version 1 布局时不动（宿主会先自行迁移）；
 * - 端口默认交给系统分配（`--port 0`），设 `DEV_PORT` 可固定；
 * - 客户端产物先同步构建一次（失败当场可见），再起常驻 watch：宿主 web 组合挂着
 *   `client-hmr`，产物一变就把运行中的插件换掉，改 `src/client/` 不用刷新页面；
 *   正常退出与 SIGTERM/Ctrl-C 都会清掉 watch 子进程。
 *
 * 环境变量：
 * - `DSH_HOME`        自定义开发实例的数据根（默认 `<工作树>/.dev/home`）；**不能等于
 *                     `DSH_HOME_SOURCE`**，否则会覆写日常 profile，脚本直接拒绝
 * - `DSH_HOME_SOURCE` 源 HOME，默认 `~/.dsh`
 * - `DSH_PROFILE`     源 profile 名，默认 `web`（插件 manifest 的 platform 也是 web）
 * - `DEV_PORT`        监听端口，默认 `0`（系统分配）
 * - `DEV_NO_OPEN=1`   不自动打开浏览器
 * - `DEV_DSH`         dsh 可执行文件名，默认 `dsh`
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { withFileLockSync, writeFileAtomicSync } from './atomic-write.mjs'
import {
  COPIED_PROFILE_FILES, assertSeparateHome, assertWebBundle, deriveProfilePackage, devWebBundleHint,
  mergeCredentialRefs, planNodeModules, resolveDevPaths,
} from './dev-plan.mjs'
import { CommandNotFoundError, CommandShellError, commandLaunchError, spawnCommand, spawnCommandSync } from './spawn-command.mjs'

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..')
const paths = resolveDevPaths({ worktree, homeDir: homedir(), env: process.env })

/**
 * 跑一条命令，失败即终止。
 *
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数
 * @param {object} options - 传给 `spawnCommandSync` 的选项
 * @returns {void} 无返回
 */
function run(command, args, options) {
  const result = spawnCommandSync({ command, args, stdio: 'inherit', ...options })
  if (result.status !== 0) {
    throw new Error(`退出码 ${result.status}: ${command} ${args.join(' ')}`)
  }
}

/**
 * 从源 HOME 的凭据文件继承 `refs`，返回新增的键名。
 *
 * 开发实例的数据根是独立的，凭据文件也跟着独立，新工作树第一次起实例要在界面上
 * 重填 API key。只搬 `refs`（按环境变量名存的密钥），不搬 `records`：账号授权带
 * 刷新令牌，两个实例各持一份会互相踢掉登录。目标里已有的条目不动。
 *
 * 读-改-写在宿主同一把写者锁里做：正在运行的实例可能同时在改这份文件，锁外的
 * 读-改-写会把它刚保存的值盖回去。写入走临时文件 + rename，替换后的权限位是 600，
 * 没有先落盘再 chmod 的可读窗口。
 *
 * @returns {{ keys: string[], notice: string | null }} 新增的键名与本次不合并的原因
 */
function inheritCredentialRefs() {
  if (!existsSync(paths.sourceCredentialsPath)) return { keys: [], notice: null }
  const sourceText = readFileSync(paths.sourceCredentialsPath, 'utf8')
  // 写者锁是目标文件的同目录兄弟，锁的独占创建要求父目录已存在。
  mkdirSync(dirname(paths.credentialsPath), { recursive: true, mode: 0o700 })
  return withFileLockSync(paths.credentialsPath, () => {
    const targetText = existsSync(paths.credentialsPath) ? readFileSync(paths.credentialsPath, 'utf8') : null
    const { text, keys, notice } = mergeCredentialRefs({ sourceText, targetText })
    if (text !== null) writeFileAtomicSync(paths.credentialsPath, text, { mode: 0o600, dirMode: 0o700 })
    return { keys, notice }
  })
}

// 任何写操作之前先挡「数据根 = 源 HOME」——那条路径会把源 profile 改写成自指
// 死链，日常 dsh 随后起不来。
try {
  assertSeparateHome({ home: paths.home, sourceHome: paths.sourceHome })
} catch (error) {
  console.error(`错误: ${error.message}`)
  process.exit(1)
}

const sourcePackagePath = join(paths.sourceProfileDir, 'package.json')
if (!existsSync(sourcePackagePath)) {
  console.error(`找不到源 profile: ${sourcePackagePath}`)
  console.error('先在源 HOME 里装一次本插件，让日常 profile 具备完整依赖：')
  console.error(`  dsh plugin --profile ${paths.profile} add <本仓库路径>`)
  console.error('或用 DSH_HOME_SOURCE 指向另一个已备好的 HOME。')
  process.exit(1)
}

const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'))

// 这条也在写之前：源 profile 没有 web app bundle 时派生出来的实例跑 dsh web 是
// 静默空转，早点拒绝别让人对着一个不打印任何东西的进程。
try {
  assertWebBundle({
    profileDir: paths.sourceProfileDir,
    bundles: sourcePackage.dsh?.profile?.bundles,
    hint: devWebBundleHint(),
  })
} catch (error) {
  console.error(`错误: ${error.message}`)
  process.exit(1)
}

mkdirSync(paths.profileDir, { recursive: true })

// 源 profile 的 cordis 配置照抄一次：之后开发实例里的改动不再被覆盖（那里是调试
// 界面开关、主题这类会随时改的东西）。cordis.patch.yml 是可选的覆盖层——用户没
// 定制过就没有这个文件，跳过即可；cordis.yml 是 dsh 生成的骨架，缺了说明源 profile
// 本身不完整，报一句能看懂的。
for (const name of COPIED_PROFILE_FILES) {
  const target = join(paths.profileDir, name)
  if (existsSync(target)) continue
  const from = join(paths.sourceProfileDir, name)
  if (!existsSync(from)) {
    if (name === 'cordis.patch.yml') continue
    console.error(`源 profile 缺少 ${name}: ${from}（源 HOME 里的 dsh 可能没起过）`)
    process.exit(1)
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
  console.error(`源 profile 没有 node_modules: ${sourceNodeModules}（先在源 HOME 里跑一次 dsh）`)
  process.exit(1)
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

// 凭据继承失败要挡住启动：静默继续会让人以为 key 已经带过来了，实际上一进界面
// 就缺凭据，而原因（形态认不出、权限不足、锁超时）只有这里能看到。
let inheritedCredentials
try {
  inheritedCredentials = inheritCredentialRefs()
} catch (error) {
  console.error(`错误: 继承 ${paths.sourceCredentialsPath} 的 refs 失败 —— ${error.message}`)
  process.exit(1)
}

console.log('')
console.log('== dsh-leader-kit 开发实例 ==')
console.log(`  工作树    ${worktree}`)
console.log(`  数据根    ${paths.home}  （会话、项目、卡片都在这里；删掉即重置）`)
console.log(`  插件链接  ${join(nodeModulesDir, 'dsh-leader-kit')} -> ${worktree}`)
if (inheritedCredentials.keys.length > 0) {
  console.log(`  凭据引用  ${paths.sourceCredentialsPath} -> ${paths.credentialsPath}（${inheritedCredentials.keys.join(', ')}）`)
}
if (inheritedCredentials.notice !== null) {
  console.warn(`  凭据引用  ${inheritedCredentials.notice}`)
}
console.log('')

run('npm', ['run', 'build:client'], { cwd: worktree })

let watcher
let dsh
let stopping = false

/**
 * 收到终止信号后清场：watcher 与 dsh 都杀掉，再按信号退出。
 *
 * 只发给本进程的 SIGTERM/SIGINT 不会经过正常返回路径，`finally` 跑不到；
 * Ctrl-C 则是整个前台进程组一起收到 SIGINT，两个子进程本来就会自己退出，
 * 这里再 kill 一次是幂等的兜底。
 *
 * @param {'SIGINT' | 'SIGTERM'} signal - 收到的信号
 * @returns {void} 无返回
 */
function stop(signal) {
  if (stopping) return
  stopping = true
  watcher?.kill()
  dsh?.kill()
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

// 常驻 watch 用独立子进程：前台留给 dsh web。首建已经同步跑过，这里只接手后续
// 改动，构建失败时 esbuild 打印错误并保留上一份产物。
watcher = spawn(process.execPath, [join(worktree, 'build', 'client.mjs'), '--watch'], {
  cwd: worktree,
  stdio: 'inherit',
})
watcher.on('exit', (code, signal) => {
  if (signal !== null || code === 0) return
  console.error(`客户端 watch 已退出（code ${code}）：后续改动不会再自动重建`)
})

// 空字符串要落到默认值：`DEV_PORT=` 这种写法传下去会让 dsh 收到空的 --port
const port = process.env.DEV_PORT || '0'
const args = ['web', '--port', port]
if (process.env.DEV_NO_OPEN === '1') args.push('--no-open')
const dshCommand = process.env.DEV_DSH || 'dsh'
// 异步起 dsh：同步等待会卡住事件循环，上面的信号处理器根本跑不到，watcher 就成了
// 孤儿。解析与拼装仍走 spawn-command，win32 上 `spawn('dsh')` 只会 ENOENT。
try {
  dsh = spawnCommand({
    command: dshCommand, args, cwd: worktree, env: { ...process.env, DSH_HOME: paths.home }, stdio: 'inherit',
  })
} catch (error) {
  if (!(error instanceof CommandNotFoundError)) throw error
  console.error(`找不到 ${dshCommand}：dsh 没装，或不在 PATH 上。`)
  console.error('用 DEV_DSH 指定路径，例如 DEV_DSH=/opt/dsh/bin/dsh npm run dev。')
  process.exit(1)
}

let outcome
try {
  outcome = await new Promise((resolve) => {
    dsh.once('error', (error) => resolve({ error: commandLaunchError(error, { command: dshCommand }) }))
    dsh.once('exit', (code, signal) => resolve({ code, signal }))
  })
} finally {
  watcher.kill()
}

if (outcome.error !== undefined) {
  // dev 没有顶层 catch，这两个错误落下去只有原始栈；文案说清该查哪里。
  if (outcome.error instanceof CommandShellError) {
    console.error(`错误: ${outcome.error.message}`)
    console.error('这是 Windows 的 cmd.exe 起不来，不是 dsh 没装：检查 ComSpec 或 %SystemRoot%\\System32\\cmd.exe。')
  } else if (outcome.error instanceof CommandNotFoundError) {
    console.error(`找不到 ${dshCommand}：dsh 没装，或不在 PATH 上。`)
    console.error('用 DEV_DSH 指定路径，例如 DEV_DSH=/opt/dsh/bin/dsh npm run dev。')
  } else {
    console.error(`无法启动 dsh: ${outcome.error.message}`)
  }
  process.exit(1)
}
if (outcome.signal !== null) {
  console.error(`dsh web 被信号 ${outcome.signal} 终止`)
  process.exitCode = 1
} else if (outcome.code !== 0) {
  console.error(`dsh web 退出码 ${outcome.code}`)
  process.exitCode = outcome.code ?? 1
}
