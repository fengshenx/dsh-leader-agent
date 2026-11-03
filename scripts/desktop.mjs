/**
 * `npm run desktop` —— 把当前目录挂进桌面版的 desktop profile，再启动桌面应用。
 *
 * 为什么需要这条命令：DeepSeek Harness Desktop 是 Electron 壳 + 完整 Web 应用，
 * profile 固定为 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts`），与
 * `npm start` / `npm run dev` 用的 `profiles/web` 各管各的包与激活状态。装进 web
 * profile 的插件，桌面版看不到。
 *
 * **两套数据根，按当前目录的身份选**：
 * - 主 checkout 里跑 → 写日常 `~/.dsh/profiles/desktop`，桌面版以后启动都带着本次改动；
 * - worktree 里跑 → 派生 `./.dev/desktop-home`（profile 从日常根照抄依赖与 bundle，
 *   只把本插件换成当前工作树的链接），日常 profile 一个字节都不动。桌面 profile 只有
 *   一份，两个分支挂不进去，派生是「分支内验证而不碰别人那份」的唯一办法。
 *   代价：派生数据根的会话、项目、卡片与日常实例是两套，删掉目录即重置。
 *   `DSH_HOME` 显式指定时两条都不走，就写那一份根。
 *
 * 脚本做的事（两套根都一样）：
 * - 往 desktop profile 的 `package.json` 里写 `dsh-leader-kit: link:<当前目录>` 并把
 *   包名追加进 `dsh.profile.bundles`（主 checkout 里已装别的来源时拒绝，不覆盖人的安装）；
 * - `node_modules/dsh-leader-kit` 链到当前目录（junction，Windows 上不需要管理员）；
 * - 重建客户端产物 `lib/client.js`（不入库，漏构建时实例照常起来、右栏却没有看板）；
 * - 启动桌面应用（macOS 用 `open --env -a`，Windows 直接起 exe 并把 `DSH_HOME` 放进
 *   子进程环境；`DSH_DESKTOP_APP` 可换应用名、`.app`／exe 路径或安装目录）。
 *
 * 撤销：`npm run desktop -- --remove`（在哪个目录跑就摘哪个根的，另一份不动）。
 *
 * 走这条路径不碰 pnpm：宿主启动时只按 `bundles` 顺序解析包，不校验 `link:` 与磁盘
 * 链接是否一致（`npm run dev` 的派生 profile 就是同样跑通的）。`pnpm-lock.yaml` 因此
 * 会与 manifest 短暂不一致，下次在桌面 App 的插件管理里做安装/卸载时 pnpm 会自己
 * 补齐——link 依赖不需要网络。
 *
 * 环境变量：
 * - `DSH_HOME`       桌面数据根，默认 `~/.dsh`（worktree 内派生时忽略）；桌面应用也读它
 * - `DSH_DESKTOP_APP` 应用名、`.app` ／ exe 路径或安装目录，默认 `DeepSeek Harness`
 */

import { spawn } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { withFileLockSync, writeFileAtomicSync } from './atomic-write.mjs'
import { inheritCredentialRefs, prepareProfileDir } from './dev-instance.mjs'
import { CREDENTIALS_FILE, LEADER_KIT_PACKAGE, assertSeparateHome, assertWebBundle, resolveDevPaths } from './dev-plan.mjs'
import {
  DESKTOP_APP_NAME, DESKTOP_PROFILE, desktopPathsOf, derivedDesktopHome, expandHomePath,
  installedSpecOf, looksLikeAppPath, parseBundleExecutable, parseTasklistImages, planDesktopDisable,
  planDesktopEnable, planDesktopHome, planDshHomeEnv, planLinkAction, planProfileLockAction,
  resolveHomePathsOrThrow, windowsExeCandidates,
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
 * 只有带分隔符或以 `~` 开头才算路径：`DeepSeek Harness.app` 这种裸包名是名字
 * （在常见安装位置找 `/Applications/DeepSeek Harness.app`），按路径解析会找成
 * `<cwd>/DeepSeek Harness.app`。探测与启动都用这里返回的绝对路径——`open` 不做
 * shell 展开，`~/Foo.app` 原样传过去必然失败。
 *
 * @param {string} appName - 应用名或 `.app` 路径
 * @param {string} homeDir - 用户主目录
 * @returns {string | null} `.app` 绝对路径
 */
function appBundlePath(appName, homeDir) {
  const trimmed = appName.trim()
  if (trimmed === '') return null
  if (looksLikeAppPath(trimmed)) {
    const resolved = expandHomePath(trimmed, homeDir)
    if (existsSync(resolved)) return resolved
  }
  const dirs = ['/Applications', join(homeDir, 'Applications'), '/System/Applications', '/Applications/Utilities']
  const bundleName = trimmed.endsWith('.app') ? trimmed : `${trimmed}.app`
  for (const dir of dirs) {
    const candidate = join(dir, bundleName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 找到 Windows 上桌面应用的 exe。
 *
 * 候选由 `windowsExeCandidates` 算（纯函数），这里只挑第一个存在的：裸名按
 * electron-builder 的每用户安装布局展开，路径形态只认给的那一处。
 *
 * @param {string} appName - 应用名、安装目录或 exe 路径
 * @param {string} homeDir - 用户主目录
 * @param {object} env - 环境变量
 * @returns {string | null} exe 绝对路径
 */
function windowsExePath(appName, homeDir, env) {
  const candidates = windowsExeCandidates({ appName, env, homeDir })
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * 解析桌面应用在这台机器上的启动目标。
 *
 * 平台形态不同，但下游只关心两件事：路径有没有找到、探活与启动走哪条分支。macOS 是
 * `.app` 包（LaunchServices 启动，环境变量只能经 `open --env` 送），Windows 是 exe
 * （直接起进程，环境变量随 `spawn` 的 `env` 传入）；其余平台只挂载、不启动。
 *
 * @param {string} appName - `DSH_DESKTOP_APP` 或平台默认名
 * @param {object} options - 选项
 * @param {string} options.homeDir - 用户主目录
 * @param {object} options.env - 环境变量
 * @returns {{ kind: 'app' | 'exe' | 'unsupported', path: string | null }} 启动目标
 */
function desktopTarget(appName, { homeDir, env }) {
  if (process.platform === 'darwin') return { kind: 'app', path: appBundlePath(appName, homeDir) }
  if (process.platform === 'win32') return { kind: 'exe', path: windowsExePath(appName, homeDir, env) }
  return { kind: 'unsupported', path: null }
}

/**
 * 从 `.app` 的 `Info.plist` 取进程名。
 *
 * 包文件名不等于进程名（`Lark.app` 的进程是 `Feishu`），按文件名推进程名会漏判。
 * 取不到就报错——猜一个名字比拒绝更糟：漏判运行态会写坏 profile。
 *
 * @param {string} bundle - `appBundlePath` 解析出的 `.app` 绝对路径
 * @returns {string} `CFBundleExecutable`
 */
function executableNameOf(bundle) {
  const plistPath = join(bundle, 'Contents', 'Info.plist')
  if (!existsSync(plistPath)) {
    throw new Error(`${plistPath} 不存在，无法判断应用是否在运行。确认路径指向一个完整的 .app。`)
  }
  const converted = spawnCommandSync({ command: 'plutil', args: ['-convert', 'xml1', '-o', '-', plistPath], encoding: 'utf8' })
  const executable = converted.status === 0 ? parseBundleExecutable(converted.stdout) : null
  if (executable === null) {
    throw new Error(
      `读不到 ${plistPath} 的 CFBundleExecutable，无法判断 ${bundle} 是否在运行。`
      + '\n先确认应用已完全退出（macOS 用 ⌘Q，关窗口只是隐藏）再重跑。',
    )
  }
  return executable
}

/**
 * macOS 上桌面应用是否正在运行。
 *
 * 进程名取自 `.app` 的 `CFBundleExecutable`，不按包文件名猜。
 *
 * @param {string} bundle - `.app` 绝对路径
 * @returns {boolean | null} 运行中为 true，未运行为 false，探不了为 null
 * @throws 读不到 `Info.plist` 的 `CFBundleExecutable` 时
 */
function macAppRunning(bundle) {
  const processName = executableNameOf(bundle)
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
 * Windows 上桌面应用是否正在运行。
 *
 * 用 `tasklist` 的 CSV 输出按镜像名比对：默认表格输出会把超过 25 字符的 Image Name
 * 截断，CSV 不会；没有匹配时 tasklist 打的是本地化提示行，所以只认以引号开头的行。
 * `tasklist.exe` 走绝对路径，不依赖 PATH 里有没有 System32。
 *
 * @param {string} exePath - exe 绝对路径
 * @param {object} env - 环境变量，取 SystemRoot
 * @returns {boolean | null} 运行中为 true，未运行为 false，探不了为 null
 */
function windowsAppRunning(exePath, env) {
  const image = basename(exePath)
  const tasklist = join(env.SystemRoot ?? 'C:\\Windows', 'system32', 'tasklist.exe')
  let probe
  try {
    probe = spawnCommandSync({ command: tasklist, args: ['/FO', 'CSV', '/NH'], encoding: 'utf8' })
  } catch (error) {
    if (error instanceof CommandNotFoundError) return null
    throw error
  }
  if (probe.status !== 0) return null
  return parseTasklistImages(probe.stdout).some((name) => name.toLowerCase() === image.toLowerCase())
}

/**
 * 桌面应用是否正在运行。
 *
 * 运行中写 profile 不会生效（宿主只在启动时读），而且可能和应用自己的插件管理撞上，
 * 所以先探再写。探不了返回 null——那不等于「没在跑」，由启动那一步 fail closed。
 *
 * @param {{ kind: string, path: string | null }} target - `desktopTarget` 的结果
 * @param {object} env - 环境变量，Windows 上取 SystemRoot
 * @returns {boolean | null} 运行中为 true，未运行为 false，探不了为 null
 * @throws 读不到 `Info.plist` 的 `CFBundleExecutable` 时
 */
function desktopAppRunning(target, env) {
  if (target.path === null) return null
  if (target.kind === 'app') return macAppRunning(target.path)
  if (target.kind === 'exe') return windowsAppRunning(target.path, env)
  return null
}

/** 进程是否还活着；没有权限探查时按活着算，不能把「不确定」当「已退出」。 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/**
 * 持着桌面应用的 `<profile>/lock` 跑完读改写。
 *
 * 与宿主 `DesktopProjectManager.withLock` 同协议：`openSync(..., 'wx')` 建锁、写入自己
 * 的 PID、结束时删掉。只检查一下再写是不够的——检查与写入之间进来了第二个写者（桌面
 * 应用自己的 `applyRelease`、另一个终端里的本脚本）照样会相互覆盖。进程已退出的锁是
 * 陈旧的，接管后重开（宿主也这么做）。
 *
 * @param {object} paths - `resolveDesktopPaths` 的结果
 * @param {() => *} operation - 持锁期间执行的读改写
 * @returns {*} operation 的返回值
 */
function withProfileLock(paths, operation) {
  mkdirSync(paths.profileDir, { recursive: true })
  const lockPath = paths.profileLockPath
  let acquired = false
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const content = readFileSync(lockPath, 'utf8')
      const pid = Number.parseInt(content.trim(), 10)
      const action = planProfileLockAction({
        exists: true,
        content,
        ownerAlive: Number.isSafeInteger(pid) && pid > 0 ? processAlive(pid) : false,
      })
      if (action === 'refuse') {
        throw new Error(
          `${lockPath} 存在且持有者（PID ${Number.isSafeInteger(pid) && pid > 0 ? pid : '未知'}）还在：`
          + '桌面应用正在改这个 profile（宿主用 <profile>/lock 串行化插件操作），或另一个终端在跑本脚本。'
          + '\n等它结束再重跑；确认没有任何桌面应用操作时可以删掉这个锁文件。',
        )
      }
      console.log(`${lockPath} 是上次操作留下的陈旧锁（PID ${pid} 已退出），接管。`)
      rmSync(lockPath, { force: true })
    }
  }
  if (!acquired) throw new Error(`拿不到 ${lockPath}，可能是并发清理与获取撞在一起，重跑一次。`)
  try {
    return operation()
  } finally {
    // 只删自己那把：锁可能已被别人接管，删别人的会放出第二个写者。
    try {
      if (readFileSync(lockPath, 'utf8') === `${process.pid}\n`) rmSync(lockPath, { force: true })
    } catch {
      // 锁已被接管或删除，没有可回收的东西。
    }
  }
}

/**
 * 用 `open` 拉起 macOS 的 `.app`。
 *
 * 用绝对路径而不是原值：`open` 不做 shell 展开（`~/Foo.app` 原样传过去必然失败），
 * 而数据根必须显式交给应用——`open` 拉起的是新进程，不能指望它按本终端的目录去
 * 解析相对路径。`open --env` 是 macOS 给被启动进程注入环境变量的唯一途径。
 *
 * @param {string} bundle - `.app` 绝对路径
 * @param {string} dshHome - 要写进应用环境的 `DSH_HOME`（绝对路径）
 * @returns {boolean} 恒为 true；失败时抛错
 */
function openMacApp(bundle, dshHome) {
  const result = spawnCommandSync({
    command: 'open',
    args: ['--env', `DSH_HOME=${dshHome}`, '-a', bundle],
    encoding: 'utf8',
  })
  // open 成功时是静默的；有 stderr 说明环境变量没送到（典型是应用已在运行，
  // rc 仍是 0，--env 被丢掉），不能当成「已启动」。
  const complaint = (result.stderr ?? '').trim()
  if (result.status !== 0 || complaint !== '') {
    throw new Error(
      `open -a "${bundle}" 没成功（退出码 ${result.status}）：${complaint || (result.stdout ?? '').trim()}`
      + `\n先把桌面应用完全退出（⌘Q）再重跑；已运行实例收不到 --env DSH_HOME=${dshHome}。`,
    )
  }
  return true
}

/**
 * 直接起 Windows 的 exe。
 *
 * `spawn` 的 `env` 就是被启动进程的环境，不需要 macOS 那样的 `--env` 通道；但
 * `detached` + `unref` 必须有——`npm run` 的父进程先退出，不脱离的话应用会跟着
 * 被收走。`'spawn'` 事件只表示进程创建成功（ENOENT / EACCES 会走 `error`）——起得来
 * 不等于活着：缺 DLL、安装损坏、单实例冲突都会让进程随后自己退出，这几种都看不出来。
 * 单实例那条由探活拦在前面；其余靠人看到窗口没出现时重跑。
 *
 * @param {string} exePath - exe 绝对路径
 * @param {string} dshHome - 要交给应用的 `DSH_HOME`（绝对路径）
 * @returns {Promise<boolean>} 恒为 true；失败时抛错
 */
async function spawnWindowsApp(exePath, dshHome) {
  const child = spawn(exePath, [], {
    env: { ...process.env, DSH_HOME: dshHome },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => {
      reject(new Error(
        `起不了 ${exePath}（${error.code ?? error.message}）。`
        + '\n确认安装完整；DSH_DESKTOP_APP 指到安装目录或 exe 时不会回退到默认安装位置。',
      ))
    })
  })
  child.unref()
  return true
}

/**
 * 拉起桌面应用。
 *
 * 两处都用解析后的绝对路径：`open` 不做 shell 展开，exe 也不该按本终端的 cwd 解析。
 * 探不到目标（非 macOS / Windows）时只提示手动启动——profile 已经挂好，应用下次
 * 启动就会读到。
 *
 * @param {{ kind: string, path: string | null }} target - `desktopTarget` 的结果
 * @param {object} options - 选项
 * @param {string} options.dshHome - 要交给应用的 `DSH_HOME`（绝对路径）
 * @returns {Promise<boolean>} 是否由本脚本启动
 */
async function launchDesktopApp(target, { dshHome }) {
  if (target.kind === 'app' && target.path !== null) return openMacApp(target.path, dshHome)
  if (target.kind === 'exe' && target.path !== null) return spawnWindowsApp(target.path, dshHome)
  console.log(`请手动启动桌面应用（数据根 ${dshHome}）。`)
  return false
}

/**
 * 找不到桌面应用时的报错。
 *
 * 两种平台给各自的写法：macOS 是 `.app` 包名或路径，Windows 是 exe 或安装目录。
 *
 * @returns {string} 报错正文
 */
function missingAppMessage() {
  if (process.platform === 'win32') {
    return '找不到桌面应用 exe。用 DSH_DESKTOP_APP 指定 exe 路径或安装目录，例如'
      + " $env:DSH_DESKTOP_APP='C:\\Users\\<你>\\AppData\\Local\\Programs\\DeepSeek Harness'; npm run desktop"
      + '（cmd 里改用 set "DSH_DESKTOP_APP=..."）。'
  }
  return '找不到桌面应用。用 DSH_DESKTOP_APP 指定名字或 .app 的完整路径，'
    + '例如 DSH_DESKTOP_APP="/Applications/DeepSeek Harness.app" npm run desktop。'
}

/**
 * 「应用正在运行、先退出再重跑」的提示。
 *
 * 进程名用解析出来的 exe 文件名的最后一段：`DSH_DESKTOP_APP` 换过应用名时，写死的
 * `DeepSeek Harness.exe` 会把人指到不存在的进程上。
 *
 * @param {{ kind: string, path: string | null }} target - `desktopTarget` 的结果
 * @returns {string} 提示正文
 */
function quitHint(target) {
  if (process.platform === 'darwin') return '先完全退出桌面应用（macOS 用 ⌘Q，关窗口只是隐藏），再重跑本命令。'
  if (process.platform === 'win32') {
    return `先完全退出桌面应用（托盘图标右键退出，或在任务管理器里结束 ${basename(target.path)}），再重跑本命令。`
  }
  return '先完全退出桌面应用，再重跑本命令。'
}

/**
 * 探不到运行态时给人手动启动的命令。
 *
 * 数据根要显式带上：自定义 `DSH_HOME` 时应用按自己的默认值启动会读另一个 profile。
 * Windows 给两种 shell 的写法——`set "X=Y"` 在 PowerShell 里不是对的命令，而这条
 * 提示是 fail closed 时唯一的补救手段。
 *
 * @param {{ kind: string, path: string | null }} target - `desktopTarget` 的结果
 * @param {string} dshHome - `DSH_HOME` 绝对路径
 * @returns {string} 可粘贴的命令
 */
function manualLaunchHint(target, dshHome) {
  // 调用处已排除 unsupported（那条分支不启动），这里只会是 app 或 exe。
  if (target.kind === 'app') return `DSH_HOME="${dshHome}" open -a "${target.path}"`
  return `$env:DSH_HOME='${dshHome}'; & '${target.path}'（cmd: set "DSH_HOME=${dshHome}" && "${target.path}"）`
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
 * 在工作树内派生一份只挂当前工作树的 desktop profile。
 *
 * 桌面 profile 只有一份，同一数据根下挂不了两个版本。日常那份被别的来源占着时
 * （主 checkout、另一个工作树、插件管理装的实体目录）不能覆盖——那是别人的安装
 * ——所以另起一个数据根：profile 从日常根派生（依赖与 bundle 列表照抄，只把
 * 本插件换成工作树链接），依赖逐条链回日常 profile，数据（会话、项目、卡片）
 * 落在工作树内，删掉即重置。派生与链接的实现在 `dev-instance.mjs`，与
 * `npm run dev`、e2e 共用同一份，三处组合不会漂移。
 *
 * @param {object} options - 选项
 * @param {string} options.worktree - 工作树绝对路径
 * @param {string} options.homeDir - 用户主目录
 * @param {object} options.dailyPaths - 日常工作根的路径
 * @param {object} options.dailyManifest - 日常 profile 的 `package.json` 解析结果
 * @returns {{ paths: object, credentials: { keys: string[], notice: string | null } }} 派生数据根的路径与凭据继承结果
 */
function prepareDerivedPaths({ worktree, homeDir, dailyPaths, dailyManifest }) {
  const home = derivedDesktopHome({ worktree })
  // 源固定成日常根：`DSH_HOME_SOURCE` 是 `npm run dev` 的旋钮，桌面这边只认实际
  // 那份日常 profile，否则派生出来的组合与用户日常看到的不一致。
  const derived = resolveDevPaths({
    worktree,
    homeDir,
    env: { DSH_HOME: home, DSH_PROFILE: DESKTOP_PROFILE, DSH_HOME_SOURCE: dailyPaths.home },
  })
  assertSeparateHome({ home: derived.home, sourceHome: dailyPaths.home })
  prepareProfileDir({ worktree, paths: derived, sourcePackage: dailyManifest })
  // 数据根独立，凭据也跟着独立：不搬 refs 的话派生实例一进界面就没有 API key，
  // 得手填一遍。与 `npm run dev` 共用同一份实现（只搬 refs，不搬 records）。
  const credentials = inheritCredentialRefs({
    credentialsPath: derived.credentialsPath,
    sourceCredentialsPath: derived.sourceCredentialsPath,
  })
  return { paths: desktopPathsOf(home), credentials }
}

/**
 * 当前目录是不是 git worktree（而不是主 checkout）。
 *
 * worktree 的 `.git` 是文件（`gitdir: …`），主 checkout 是目录。用它区分两种身份
 * 不需要起 git 子进程：`npm run desktop` 每次会话都要跑，能省的就省。
 *
 * @param {string} worktree - 当前仓库目录
 * @returns {boolean} 是 worktree 时 true
 */
function inGitWorktree(worktree) {
  const marker = lstatSync(join(worktree, '.git'), { throwIfNoEntry: false })
  return marker?.isFile() === true
}

/**
 * 校验环境并执行。
 *
 * @returns {Promise<void>} 无返回
 */
async function main() {
  const homeDir = homedir()
  const rawHome = process.env.DSH_HOME ?? ''
  const dailyPaths = resolveHomePathsOrThrow({ rawHome, homeDir, cwd: process.cwd() })
  const appName = process.env.DSH_DESKTOP_APP || DESKTOP_APP_NAME
  const target = desktopTarget(appName, { homeDir, env: process.env })
  const remove = process.argv.slice(2).includes('--remove')

  const dailyManifest = existsSync(dailyPaths.packagePath) ? readManifest(dailyPaths.packagePath) : null
  if (dailyManifest === null) {
    if (remove) {
      console.log(`没有可摘的挂载：${dailyPaths.packagePath} 不存在。`)
      return
    }
    console.error(`找不到桌面 profile: ${dailyPaths.packagePath}`)
    console.error('桌面版第一次启动时会自己建出它：先打开一次 DeepSeek Harness，退出后再跑本命令。')
    console.error('数据根不在默认位置时用 DSH_HOME 指定（桌面应用也读它）。')
    process.exit(1)
  }

  // 显式给了 DSH_HOME 就是指定了数据根，脚本不另找地方：那条根被别人占着时照旧
  // 拒绝（由人决定要不要卸），免得「我指定的目录怎么没生效」。
  const installedSpec = installedSpecOf(dailyManifest)
  const homePlan = planDshHomeEnv(rawHome) === 'unset'
    ? planDesktopHome({ inWorktree: inGitWorktree(worktree), installedSpec })
    : { mode: 'daily', owner: null }
  const useDerived = homePlan.mode === 'derived'

  if (remove) {
    const paths = useDerived
      ? prepareDerivedPaths({ worktree, homeDir, dailyPaths, dailyManifest }).paths
      : dailyPaths
    if (!existsSync(paths.packagePath)) {
      console.log(`没有可摘的挂载：${paths.packagePath} 不存在。`)
      return
    }
    // 摘除不看应用在不在：改名、卸载之后照样要能摘。只看谁占着 profile。
    const { changed, linkState } = withProfileLock(paths, () => {
      const state = linkStateOf({ linkPath: paths.linkPath, worktree })
      if (state === 'other') {
        throw new Error(
          `${paths.linkPath} 指向别处（${readlinkSync(paths.linkPath)}），不是当前目录 ${worktree}，`
          + '\n不摘别人的安装：到那份来源的目录里跑 --remove，或在插件管理里卸载。',
        )
      }
      const written = withFileLockSync(paths.packagePath, () => {
        const { manifest: next, changed: planned } = planDesktopDisable({
          manifest: readManifest(paths.packagePath),
          worktree,
        })
        if (state === 'foreign' && planned) {
          throw new Error(
            `${paths.linkPath} 是实体目录（像是插件管理装的一份），本脚本不摘。`
            + '\n要么在 DeepSeek Harness 的插件管理里卸载，要么先手工删掉这个目录再重跑 --remove；'
            + 'manifest 里的声明这次一并保留，不留下「没有依赖、只在 bundles 里」的半摘状态。',
          )
        }
        if (planned) writeManifest(paths.packagePath, next)
        return planned
      })
      if (state === 'ours') detachLink(paths.linkPath)
      return { changed: written, linkState: state }
    })
    console.log('')
    console.log('== 已从 desktop profile 摘除 dsh-leader-kit ==')
    console.log(`  manifest  ${changed ? '已更新' : '本来就没有'}`)
    console.log(`  链接      ${linkState === 'ours' ? '已删除' : linkState === 'foreign' ? '是实体目录（不属于本脚本），未动' : '本来就没有'}`)
    console.log(`  profile   ${paths.profileDir}`)
    console.log('')
    console.log('重新打开 DeepSeek Harness 生效。')
    return
  }

  // 支持的平台上找不到应用是硬错误：再往下走只会把 profile 挂好、然后无声地不启动。
  if (target.kind !== 'unsupported' && target.path === null) throw new Error(missingAppMessage())
  const running = desktopAppRunning(target, process.env)
  if (running === true) {
    console.error(`${target.path} 正在运行，profile 只在启动时读入。`)
    console.error(quitHint(target))
    process.exit(1)
  }

  // 探活放在派生之前：应用在跑时派生根也一个字节都不动，免得改到正在被读的 profile。
  const derived = useDerived
    ? prepareDerivedPaths({ worktree, homeDir, dailyPaths, dailyManifest })
    : null
  const paths = derived?.paths ?? dailyPaths

  try {
    assertWebBundle({
      profileDir: paths.profileDir,
      bundles: readManifest(paths.packagePath)?.dsh?.profile?.bundles,
      hint: '桌面应用自己会写这个列表；缺它说明该 profile 被改坏了，'
        + '先退出应用、删掉该 profile 目录，再打开应用让它重建。',
    })
  } catch (error) {
    console.error(`错误: ${error.message}`)
    process.exit(1)
  }

  // 先构建、再建链接、最后写 manifest：构建失败时 profile 一点没动；链接被别人的
  // 安装挡住时 manifest 也保持原样，不会留下「声明了依赖、磁盘上没有对应链接」的
  // 坏状态。反过来链接成功而写 manifest 失败，只留一个没人引用的链接，下次重跑
  // 会当成「已指向当前目录」。
  run('npm', ['run', 'build:client'], { cwd: worktree })
  const { action, changed } = withProfileLock(paths, () => {
    const linkAction = ensureLink({ linkPath: paths.linkPath, worktree })
    // 重读 manifest 在锁内做：读-判-写之间不能有第二个写者插进来。
    const written = withFileLockSync(paths.packagePath, () => {
      const { manifest: next, changed: planned } = planDesktopEnable({
        manifest: readManifest(paths.packagePath),
        worktree,
      })
      if (planned) writeManifest(paths.packagePath, next)
      return planned
    })
    return { action: linkAction, changed: written }
  })

  console.log('')
  console.log(homePlan.mode === 'derived'
    ? '== dsh-leader-kit 挂进桌面版（分支隔离）=='
    : '== dsh-leader-kit 挂进桌面版 ==')
  if (homePlan.mode === 'derived') {
    console.log(`  日常 profile  ${dailyPaths.profileDir}`)
    console.log(`                挂着 ${homePlan.owner ?? '另一份安装'}，本次不动它`)
  }
  console.log(`  数据根    ${paths.home}${homePlan.mode === 'derived' ? '（会话、项目、卡片独立；删掉即重置）' : ''}`)
  console.log(`  profile   ${paths.profileDir}`)
  console.log(`  插件      ${paths.linkPath} -> ${worktree}`)
  console.log(`  manifest  ${changed ? '已更新' : '已是最新'}`)
  console.log(`  链接      ${action === 'kept' ? '已指向当前目录' : '已创建'}`)
  if (derived !== null && derived.credentials.keys.length > 0) {
    console.log(`  凭据引用  ${join(dailyPaths.home, CREDENTIALS_FILE)} -> ${paths.home}（${derived.credentials.keys.join(', ')}）`)
  }
  if (derived !== null && derived.credentials.notice !== null) {
    console.warn(`  凭据引用  ${derived.credentials.notice}`)
  }
  console.log('')

  if (target.kind !== 'unsupported' && running === null) {
    // 两端都是 fail closed：macOS 的 open --env 对已运行实例静默失效（rc 仍是 0），
    // Windows 的单实例冲突会让新进程自己退出——探不到就不能赌。
    console.log(`探不到桌面应用是否在运行（${target.kind === 'exe' ? 'tasklist' : 'pgrep'} 不可用），不自动启动。`)
    console.log(`自己启动：${manualLaunchHint(target, paths.home)}`)
    return
  }
  const launched = await launchDesktopApp(target, { dshHome: paths.home })
  console.log('')
  if (launched) {
    console.log('桌面应用已启动。右栏出现「看板」Tab、左栏出现「项目」区块即生效。')
  } else {
    console.log('profile 已挂好，启动应用后生效：右栏出现「看板」Tab、左栏出现「项目」区块。')
  }
  console.log(homePlan.mode === 'derived'
    ? '摘除：npm run desktop -- --remove（摘的是派生这份，日常 profile 未被改动）'
    : '摘除：npm run desktop -- --remove')
}

try {
  await main()
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`错误: ${detail}`)
  const frame = error instanceof Error
    ? error.stack?.split('\n').find((line) => line.trim().startsWith('at '))
    : undefined
  if (frame !== undefined) console.error(frame.trim())
  process.exit(1)
}
