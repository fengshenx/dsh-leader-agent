/**
 * `npm start` —— 起挂本插件的日常 dsh 实例。
 *
 * 与 `npm run dev` 的分工：dev 起隔离实例（工作树内的数据根、工作树版本的插件），
 * start 起你平时用的那套（`~/.dsh` 的数据与 profile），交付前在真实组合里过一遍。
 *
 * 起实例前先构建客户端产物：`lib/client.js` 不入库，宿主下发的是构建产物，没构建
 * 过或改过 `src/client/` 没重建时，实例照常起来、只是右栏没有看板，宿主不会报错。
 * 但只有当 profile 链接的就是当前目录时才重建——从 worktree 里跑 start 时，实例
 * 加载的是链接指向的那份代码，构建当前工作树只会产出一份没人加载的产物。
 *
 * 环境变量：
 * - `DSH_HOME` 日常数据根，默认 `~/.dsh`
 * - `DSH_DSH`  dsh 可执行文件名或路径，默认 `dsh`
 *
 * 额外参数原样转给 `dsh web`：`npm start -- --no-open --port 3210`。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  LEADER_KIT_PACKAGE, PROFILE_NAME, assertLeaderKitBundle, assertWebBundle,
} from './dev-plan.mjs'

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..')

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
 * 取路径的真实身份，不存在时返回 null。
 *
 * @param {string} path - 路径
 * @returns {string | null} 规范化后的绝对路径；不存在时为 null
 */
function identityOf(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

const dshCommand = process.env.DSH_DSH || 'dsh'

// 先探可执行文件：没装 dsh 时下面每一条检查都跑不起来，而 spawnSync 的原始
// 报错（`spawnSync dsh ENOENT`）不会告诉人「装 dsh」还是「PATH 里找不到」。
const probe = spawnSync(dshCommand, ['--version'], { encoding: 'utf8' })
if (probe.error?.code === 'ENOENT') {
  console.error(`找不到 ${dshCommand}：dsh 没装，或不在 PATH 上。`)
  console.error('用 nvm 等版本管理器时，换了 shell 或 node 版本后 PATH 会重置，先确认 `command -v dsh` 有输出。')
  console.error(`装好后重跑；可执行文件名不是 dsh 时用 DSH_DSH 指定路径，例如 DSH_DSH=/opt/dsh/bin/dsh npm start。`)
  process.exit(1)
}
if (probe.error !== undefined) throw probe.error
if (probe.status !== 0) {
  console.error(`错误: ${dshCommand} --version 以退出码 ${probe.status} 结束`)
  console.error((probe.stderr || probe.stdout || '').trim())
  process.exit(1)
}
const dshVersion = probe.stdout.trim() || '未知版本'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', PROFILE_NAME)
const packagePath = join(profileDir, 'package.json')

if (!existsSync(packagePath)) {
  console.error(`找不到日常 profile: ${packagePath}`)
  console.error(`先装一次本插件（dsh 会按 ${PROFILE_NAME} 模板建出 profile）：`)
  console.error(`  ${dshCommand} plugin --profile ${PROFILE_NAME} add ${worktree}`)
  console.error('或用 DSH_HOME 指向另一个已备好的数据根。')
  process.exit(1)
}

const profilePackage = JSON.parse(readFileSync(packagePath, 'utf8'))
const bundles = profilePackage.dsh?.profile?.bundles
try {
  assertWebBundle({ profileDir, bundles })
  assertLeaderKitBundle({ profileDir, bundles, worktree })
} catch (error) {
  console.error(`错误: ${error.message}`)
  process.exit(1)
}

const pluginLink = join(profileDir, 'node_modules', LEADER_KIT_PACKAGE)
const loadedFrom = identityOf(pluginLink)
if (loadedFrom === null) {
  console.error(`错误: ${pluginLink} 不存在，profile 声明了本插件但没链接上。`)
  console.error(`重装一次: ${dshCommand} plugin --profile ${PROFILE_NAME} add ${worktree}`)
  process.exit(1)
}

// 脚本就在仓库里，identityOf(worktree) 不会是 null
const building = loadedFrom === identityOf(worktree)
if (!building) {
  console.warn(`[warn] 实例加载的是 ${loadedFrom}，不是当前目录 ${worktree}`)
  console.warn('       当前目录的改动不会被它加载；要在本目录里验证请用 npm run dev。')
}

console.log('')
console.log('== dsh-leader-kit 日常实例 ==')
console.log(`  dsh     ${dshCommand} ${dshVersion}`)
console.log(`  数据根  ${home}`)
console.log(`  插件    ${loadedFrom}`)
console.log('')

if (building) run('npm', ['run', 'build:client'], { cwd: worktree })

run(dshCommand, ['web', ...process.argv.slice(2)], {
  cwd: worktree,
  env: { ...process.env, DSH_HOME: home },
})
