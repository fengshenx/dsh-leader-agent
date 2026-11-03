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
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { writeFileAtomicSync } from './atomic-write.mjs'
import { LEADER_KIT_PACKAGE, assertWebBundle } from './dev-plan.mjs'
import {
  DESKTOP_APP_NAME, expandHomePath, parseBundleExecutable, planDesktopDisable, planDesktopEnable,
  planLinkAction, resolveDesktopPaths,
} from './desktop-plan.mjs'
import { CommandNotFoundError, spawnCommandSync } from './spawn-command.mjs'
import { detachNodeModulesLink } from './worktree-common.mjs'

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
 * 找到 `DSH_DESKTOP_APP` 指向的 `.app`。
 *
 * 名字形态按常见安装位置探测；路径形态直接取。找不到返回 null，由调用方决定
 * 怎么说——脚本不猜一个包名去启动。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @param {string} homeDir - 用户主目录
 * @returns {string | null} `.app` 绝对路径
 */
function appBundlePath(appName, homeDir) {
  const trimmed = appName.trim()
  if (trimmed === '') return null
  if (trimmed.endsWith('.app') || trimmed.includes('/')) {
    const resolved = expandHomePath(trimmed, homeDir)
    return existsSync(resolved) ? resolved : null
  }
  const dirs = ['/Applications', join(homeDir, 'Applications'), '/System/Applications', '/Applications/Utilities']
  for (const dir of dirs) {
    const candidate = join(dir, `${trimmed}.app`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 从 `.app` 的 `Info.plist` 取进程名。
 *
 * 包文件名不等于进程名（`Lark.app` 的进程是 `Feishu`），按文件名推进程名会漏判。
 * 取不到就报错——猜一个名字比拒绝更糟：漏判运行态会写坏 profile。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @param {string} homeDir - 用户主目录
 * @returns {string} `CFBundleExecutable`
 */
function executableNameOf(appName, homeDir) {
  const bundle = appBundlePath(appName, homeDir)
  if (bundle === null) {
    throw new Error(
      `找不到应用 ${appName}。用 DSH_DESKTOP_APP 指定 .app 的完整路径，`
      + '例如 DSH_DESKTOP_APP="/Applications/DeepSeek Harness.app" npm run desktop。',
    )
  }
  const plistPath = join(bundle, 'Contents', 'Info.plist')
  if (!existsSync(plistPath)) {
    throw new Error(`${plistPath} 不存在，无法判断应用是否在运行。确认路径指向一个完整的 .app。`)
  }
  const converted = spawnCommandSync({ command: 'plutil', args: ['-convert', 'xml1', '-o', '-', plistPath], encoding: 'utf8' })
  const executable = converted.status === 0 ? parseBundleExecutable(converted.stdout) : null
  if (executable === null) {
    throw new Error(
      `读不到 ${plistPath} 的 CFBundleExecutable，无法判断 ${appName} 是否在运行。`
      + '\n先确认应用已完全退出（macOS 用 ⌘Q，关窗口只是隐藏）再重跑。',
    )
  }
  return executable
}

/**
 * 桌面应用是否正在运行。
 *
 * 运行中写 profile 不会生效（宿主只在启动时读），而且可能和应用自己的插件管理撞上，
 * 所以先探再写。Windows 上不探：脚本会在启动那一步明确提示手动打开。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @param {string} homeDir - 用户主目录
 * @returns {boolean | null} 运行中为 true，未运行为 false，探不了为 null
 * @throws 找不到应用或读不到 CFBundleExecutable 时
 */
function desktopAppRunning(appName, homeDir) {
  if (process.platform === 'win32') return null
  const processName = executableNameOf(appName, homeDir)
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
 * profile 是否正被桌面应用写入。
 *
 * 宿主的 `dsh-atomic-write` 用 `<file>.lock` 兄弟文件表达独占写：插件管理改
 * manifest 时 `package.json.lock` 在场。撞上它会写出相互覆盖的结果。
 *
 * @param {string} lockPath - 锁文件路径
 * @returns {void} 无返回
 * @throws 锁在场时
 */
function assertProfileUnlocked(lockPath) {
  if (!existsSync(lockPath)) return
  throw new Error(
    `${lockPath} 存在：桌面 App 的插件管理正在改这个 profile（宿主用 <file>.lock 表示写入中）。`
    + '\n等它结束再重跑；确认没有任何操作时可以删掉这个锁文件。',
  )
}

/**
 * 拉起桌面应用。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @returns {boolean} 是否由本脚本启动
 */
function launchDesktopApp(appName) {
  if (process.platform !== 'darwin') {
    console.log(`请手动启动 ${appName}。`)
    return false
  }
  const result = spawnCommandSync({ command: 'open', args: ['-a', appName], encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `open -a "${appName}" 失败（退出码 ${result.status}）：${(result.stderr || result.stdout || '').trim()}`
      + '\n应用名不同时用 DSH_DESKTOP_APP 指定，例如 DSH_DESKTOP_APP="/Applications/DeepSeek Harness.app" npm run desktop。',
    )
  }
  return true
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
 * 链接当前的归属：没有、是实体目录、指向别处、还是本工作树。
 *
 * @param {object} options - 选项
 * @param {string} options.linkPath - profile 里的链接路径
 * @param {string} options.worktree - 工作树绝对路径
 * @returns {'absent' | 'foreign' | 'other' | 'ours'} 归属
 */
function linkStateOf({ linkPath, worktree }) {
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  if (existing === undefined) return 'absent'
  if (!existing.isSymbolicLink()) return 'foreign'
  return identityOf(linkPath) === identityOf(worktree) ? 'ours' : 'other'
}

/**
 * 摘掉本工作树的链接。Windows 上的 junction 用 `rmdir` 拆，与本仓 worktree
 * 工具的约定一致（`unlink` 对目录链接的语义在 Windows 上不一样）。
 *
 * @param {string} linkPath - profile 里的链接路径
 * @returns {void} 无返回
 */
function detachLink(linkPath) {
  detachNodeModulesLink(linkPath, process.platform === 'win32' ? 'rmdir' : 'unlink')
}

/**
 * 校验环境并执行。
 *
 * @returns {void} 无返回
 */
function main() {
  const homeDir = homedir()
  const paths = resolveDesktopPaths({ homeDir, cwd: process.cwd(), env: process.env })
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

  const running = desktopAppRunning(appName, homeDir)
  if (running === true) {
    console.error(`${appName} 正在运行，profile 只在启动时读入。`)
    console.error('先完全退出桌面应用（macOS 用 ⌘Q，关窗口只是隐藏），再重跑本命令。')
    process.exit(1)
  }

  if (remove) {
    // 先判归属再动盘：manifest 与链接都只摘「确实是当前工作树挂的」那一份。
    const { manifest: next, changed } = planDesktopDisable({ manifest, worktree })
    const linkState = linkStateOf({ linkPath: paths.linkPath, worktree })
    if (linkState === 'other') {
      throw new Error(
        `${paths.linkPath} 指向别处（${readlinkSync(paths.linkPath)}），不是当前目录 ${worktree}，`
        + '\n不摘别人的安装：到那份来源的目录里跑 --remove，或在插件管理里卸载。',
      )
    }
    assertProfileUnlocked(paths.packageLockPath)
    if (changed) writeManifest(paths.packagePath, next)
    if (linkState === 'ours') detachLink(paths.linkPath)
    console.log('')
    console.log('== 已从 desktop profile 摘除 dsh-leader-kit ==')
    console.log(`  manifest  ${changed ? '已更新' : '本来就没有'}`)
    console.log(`  链接      ${linkState === 'ours' ? '已删除' : linkState === 'foreign' ? '是实体目录（不属于本脚本），未动' : '本来就没有'}`)
    console.log(`  profile   ${paths.profileDir}`)
    console.log('')
    console.log('重新打开 DeepSeek Harness 生效。')
    return
  }

  const { manifest: next, changed } = planDesktopEnable({ manifest, worktree })
  // 先构建、再建链接、最后写 manifest：构建失败时 profile 一点没动；链接被别人的
  // 安装挡住时 manifest 也保持原样，不会留下「声明了依赖、磁盘上没有对应链接」的
  // 坏状态。反过来链接成功而写 manifest 失败，只留一个没人引用的链接，下次重跑
  // 会当成「已指向当前目录」。
  run('npm', ['run', 'build:client'], { cwd: worktree })
  assertProfileUnlocked(paths.packageLockPath)
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

  const launched = launchDesktopApp(appName)
  console.log('')
  if (launched) {
    console.log('桌面应用已启动。右栏出现「看板」Tab、左栏出现「项目」区块即生效。')
  } else {
    console.log('profile 已挂好，启动应用后生效：右栏出现「看板」Tab、左栏出现「项目」区块。')
  }
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
