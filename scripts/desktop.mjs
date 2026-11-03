/**
 * `npm run desktop` —— 把当前工作树挂进桌面版的 desktop profile，再启动桌面应用。
 *
 * 为什么需要这条命令：DeepSeek Harness Desktop 是 Electron 壳 + 完整 Web 应用，
 * profile 固定为 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts`），与
 * `npm start` / `npm run dev` 用的 `profiles/web` 各管各的包与激活状态。装进 web
 * profile 的插件，桌面版看不到。
 *
 * 脚本做的事：
 * - 往 desktop profile 的 `package.json` 里写 `dsh-leader-kit: link:<当前目录>` 并把
 *   包名追加进 `dsh.profile.bundles`（已装别的来源时拒绝，不覆盖人的安装）；
 * - `node_modules/dsh-leader-kit` 链到当前目录（junction，Windows 上不需要管理员）；
 * - 重建客户端产物 `lib/client.js`（不入库，漏构建时实例照常起来、右栏却没有看板）；
 * - 启动桌面应用（macOS 用 `open -a`，可用 `DSH_DESKTOP_APP` 换名字或 .app 路径）。
 *
 * 撤销：`npm run desktop -- --remove`。
 *
 * 走这条路径不碰 pnpm：宿主启动时只按 `bundles` 顺序解析包，不校验 `link:` 与磁盘
 * 链接是否一致（`npm run dev` 的派生 profile 就是同样跑通的）。`pnpm-lock.yaml` 因此
 * 会与 manifest 短暂不一致，下次在桌面 App 的插件管理里做安装/卸载时 pnpm 会自己
 * 补齐——link 依赖不需要网络。
 *
 * 环境变量：
 * - `DSH_HOME`       桌面数据根，默认 `~/.dsh`；桌面应用也读这个变量
 * - `DSH_DESKTOP_APP` 应用名或 `.app` 路径，默认 `DeepSeek Harness`
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { writeFileAtomicSync } from './atomic-write.mjs'
import { LEADER_KIT_PACKAGE, assertWebBundle } from './dev-plan.mjs'
import {
  DESKTOP_APP_NAME, pgrepNameOf, planDesktopDisable, planDesktopEnable, planLinkAction, resolveDesktopPaths,
} from './desktop-plan.mjs'
import { CommandNotFoundError, spawnCommandSync } from './spawn-command.mjs'

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..')

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
    throw new Error(`退出码 ${result.status}: ${command} ${args.join(' ')}（上面是它自己的输出）`)
  }
}

/**
 * 取路径的真实身份，不存在时退回字面量。
 *
 * @param {string} path - 路径
 * @returns {string} 规范化后的绝对路径
 */
function identityOf(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

/**
 * 读 desktop profile 的 `package.json`，解析失败时给出可执行的修法。
 *
 * @param {string} path - `package.json` 路径
 * @returns {object} 解析结果
 */
function readManifest(path) {
  const text = readFileSync(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${path} 不是合法 JSON（${error.message}）。`
      + '\n桌面应用与 pnpm 都读这份文件，先手工修好；'
      + '确认里面没有别的插件后，也可以删掉整个 profile 目录让应用重建。',
    )
  }
}

/**
 * 覆盖写 manifest，权限沿用原文件。
 *
 * @param {string} path - `package.json` 路径
 * @param {object} manifest - 新内容
 * @returns {void} 无返回
 */
function writeManifest(path, manifest) {
  const mode = statSync(path).mode & 0o777
  writeFileAtomicSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode })
}

/**
 * 桌面应用是否正在运行。
 *
 * 运行中写 profile 不会生效（宿主只在启动时读），而且可能和应用自己的插件管理撞上，
 * 所以先探再写。Windows 上不探：脚本会在启动那一步明确提示手动打开。
 *
 * `DSH_DESKTOP_APP` 可能是 `.app` 路径，`pgrep -x` 只认进程名，要先归一化。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @returns {boolean | null} 运行中为 true，未运行为 false，探不了为 null
 */
function desktopAppRunning(appName) {
  if (process.platform === 'win32') return null
  const processName = pgrepNameOf(appName)
  if (processName === '') return null
  try {
    const probe = spawnCommandSync({ command: 'pgrep', args: ['-x', processName], encoding: 'utf8' })
    return probe.status === 0
  } catch (error) {
    // pgrep 不在 PATH 上时别把「探不了」说成「没在跑」。
    if (error instanceof CommandNotFoundError) return null
    throw error
  }
}

/**
 * 拉起桌面应用。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @returns {void} 无返回
 */
function launchDesktopApp(appName) {
  if (process.platform !== 'darwin') {
    console.log(`请手动启动 ${appName}。`)
    return
  }
  const result = spawnCommandSync({ command: 'open', args: ['-a', appName], encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `open -a "${appName}" 失败（退出码 ${result.status}）：${(result.stderr || result.stdout || '').trim()}`
      + '\n应用名不同时用 DSH_DESKTOP_APP 指定，例如 DSH_DESKTOP_APP="/Applications/DeepSeek Harness.app" npm run desktop。',
    )
  }
}

/**
 * 让 `node_modules/dsh-leader-kit` 指向当前工作树。
 *
 * 只建不覆盖：已指向同一目录时不动；指向别的目录或已被桌面 App 的插件管理装成
 * 真目录时拒绝——两种都是别人的安装，由人决定要不要换。
 *
 * @param {object} options - 选项
 * @param {string} options.linkPath - profile 里的链接路径
 * @param {string} options.worktree - 工作树绝对路径
 * @returns {'created' | 'kept'} 本次动作
 */
function ensureLink({ linkPath, worktree }) {
  mkdirSync(dirname(linkPath), { recursive: true })
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  const isSymbolicLink = existing?.isSymbolicLink() === true
  const action = planLinkAction({
    exists: existing !== undefined,
    isSymbolicLink,
    sameTarget: isSymbolicLink && identityOf(linkPath) === identityOf(worktree),
  })
  if (action === 'refuse') {
    const what = isSymbolicLink
      ? `已经指向另一份安装（${readlinkSync(linkPath)}），不是当前目录 ${worktree}`
      : '已存在且不是符号链接（像是桌面 App 插件管理装的一份实体目录）'
    throw new Error(
      `${linkPath} ${what}。`
      + '\n它可能是桌面 App 的插件管理装的，也可能是另一个工作树挂上去的。'
      + `\n先卸掉再重跑：npm run desktop -- --remove，或在 DeepSeek Harness 的插件管理里卸载。`,
    )
  }
  if (action === 'keep') return 'kept'
  symlinkSync(worktree, linkPath, 'junction')
  return 'created'
}

/**
 * 摘掉链接；不是符号链接时不动（那是别处的安装）。
 *
 * @param {string} linkPath - profile 里的链接路径
 * @returns {boolean} 是否删掉了链接
 */
function removeLink(linkPath) {
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  if (existing === undefined) return false
  if (!existing.isSymbolicLink()) return false
  rmSync(linkPath, { force: true })
  return true
}

/**
 * 校验环境并执行。
 *
 * @returns {void} 无返回
 */
function main() {
  const paths = resolveDesktopPaths({ homeDir: homedir(), env: process.env })
  const appName = process.env.DSH_DESKTOP_APP || DESKTOP_APP_NAME
  const remove = process.argv.slice(2).includes('--remove')

  if (!existsSync(paths.packagePath)) {
    console.error(`找不到桌面 profile: ${paths.packagePath}`)
    console.error('桌面版第一次启动时会自己建出它：先打开一次 DeepSeek Harness，退出后再跑本命令。')
    console.error('数据根不在默认位置时用 DSH_HOME 指定（桌面应用也读它）。')
    process.exit(1)
  }

  const manifest = readManifest(paths.packagePath)

  if (!remove) {
    try {
      assertWebBundle({
        profileDir: paths.profileDir,
        bundles: manifest?.dsh?.profile?.bundles,
        hint: '桌面应用自己会写这个列表；缺它说明该 profile 被改坏了，'
          + '先退出应用、删掉该 profile 目录，再打开应用让它重建。',
      })
    } catch (error) {
      console.error(`错误: ${error.message}`)
      process.exit(1)
    }
  }

  const running = desktopAppRunning(appName)
  if (running === true) {
    console.error(`${appName} 正在运行，profile 只在启动时读入。`)
    console.error('先完全退出桌面应用（macOS 用 ⌘Q，关窗口只是隐藏），再重跑本命令。')
    process.exit(1)
  }

  if (remove) {
    const { manifest: next, changed } = planDesktopDisable({ manifest })
    if (changed) writeManifest(paths.packagePath, next)
    const unlinked = removeLink(paths.linkPath)
    console.log('')
    console.log('== 已从 desktop profile 摘除 dsh-leader-kit ==')
    console.log(`  manifest  ${changed ? '已更新' : '本来就没有'}`)
    console.log(`  链接      ${unlinked ? '已删除' : '本来就没有'}`)
    console.log(`  profile   ${paths.profileDir}`)
    console.log('')
    console.log('重新打开 DeepSeek Harness 生效。')
    return
  }

  const { manifest: next, changed } = planDesktopEnable({ manifest, worktree })
  // 先建链接再写 manifest：链接建不起来（别人的安装占着位置）时 manifest 保持
  // 原样，不会留下「声明了依赖、磁盘上没有对应链接」的坏状态。反过来链接成功、
  // 写 manifest 失败，只是一个没人引用的链接，下次重跑会当成「已指向当前目录」。
  const action = ensureLink({ linkPath: paths.linkPath, worktree })
  if (changed) writeManifest(paths.packagePath, next)

  console.log('')
  console.log('== dsh-leader-kit 挂进桌面版 ==')
  console.log(`  数据根    ${paths.home}`)
  console.log(`  profile   ${paths.profileDir}`)
  console.log(`  插件      ${paths.linkPath} -> ${worktree}`)
  console.log(`  manifest  ${changed ? '已更新' : '已是最新'}`)
  console.log(`  链接      ${action === 'kept' ? '已指向当前目录' : '已创建'}`)
  console.log('')

  run('npm', ['run', 'build:client'], { cwd: worktree })

  launchDesktopApp(appName)
  console.log('')
  console.log('桌面应用已启动。右栏出现「看板」Tab、左栏出现「项目」区块即生效。')
  console.log('摘除：npm run desktop -- --remove')
}

try {
  main()
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`错误: ${detail}`)
  const frame = error instanceof Error
    ? error.stack?.split('\n').find((line) => line.trim().startsWith('at '))
    : undefined
  if (frame !== undefined) console.error(frame.trim())
  process.exit(1)
}
