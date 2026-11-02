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
 *   要重新跟随源就删掉那一条；
 * - 端口默认交给系统分配（`--port 0`），设 `DEV_PORT` 可固定。
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

import { spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  COPIED_PROFILE_FILES, assertSeparateHome, assertWebBundle, deriveProfilePackage, devWebBundleHint,
  mergeCredentialRefs, planNodeModules, resolveDevPaths,
} from './dev-plan.mjs'

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..')
const paths = resolveDevPaths({ worktree, homeDir: homedir(), env: process.env })

/**
 * 跑一条命令，失败即终止。
 *
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数
 * @param {object} options - 传给 `spawnSync` 的选项
 * @returns {void} 无返回
 */
function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error !== undefined) {
    throw new Error(`执行失败: ${command} ${args.join(' ')} —— ${result.error.message}`)
  }
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
 * @returns {string[]} 新增的键名，没有变化时为空数组
 */
function inheritCredentialRefs() {
  if (!existsSync(paths.sourceCredentialsPath)) return []
  const targetText = existsSync(paths.credentialsPath) ? readFileSync(paths.credentialsPath, 'utf8') : null
  const { text, keys } = mergeCredentialRefs({
    sourceText: readFileSync(paths.sourceCredentialsPath, 'utf8'),
    targetText,
  })
  if (text === null) return []
  writeFileSync(paths.credentialsPath, text, { mode: 0o600 })
  // 已存在的文件不受创建模式约束，dsh 会拒绝加载其他用户可读的凭据文件。
  chmodSync(paths.credentialsPath, 0o600)
  return keys
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

const inheritedCredentials = inheritCredentialRefs()

console.log('')
console.log('== dsh-leader-kit 开发实例 ==')
console.log(`  工作树    ${worktree}`)
console.log(`  数据根    ${paths.home}  （会话、项目、卡片都在这里；删掉即重置）`)
console.log(`  插件链接  ${join(nodeModulesDir, 'dsh-leader-kit')} -> ${worktree}`)
if (inheritedCredentials.length > 0) {
  console.log(`  凭据引用  ${paths.sourceCredentialsPath} -> ${paths.credentialsPath}（${inheritedCredentials.join(', ')}）`)
}
console.log('')

run('npm', ['run', 'build:client'], { cwd: worktree })

// 空字符串要落到默认值：`DEV_PORT=` 这种写法传下去会让 dsh 收到空的 --port
const port = process.env.DEV_PORT || '0'
const args = ['web', '--port', port]
if (process.env.DEV_NO_OPEN === '1') args.push('--no-open')
run(process.env.DEV_DSH || 'dsh', args, { cwd: worktree, env: { ...process.env, DSH_HOME: paths.home } })
