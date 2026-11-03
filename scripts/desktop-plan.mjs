/**
 * `npm run desktop` 的路径解析与 profile 改写计算。
 *
 * 桌面版（DeepSeek Harness Desktop）是 Electron 壳 + 完整 Web 应用，profile 固定
 * 在 `$DSH_HOME/profiles/desktop`，与 CLI 的 `profiles/web` 各管各的包与激活状态。
 * 所以「在桌面端用」= 把本插件挂进 desktop profile；这里只算要改成什么样、什么
 * 情况该拒绝，文件系统操作在 `desktop.mjs`。
 *
 * @module dsh-leader-kit/scripts/desktop-plan
 */

import { isAbsolute, join, resolve } from 'node:path'
import { LEADER_KIT_PACKAGE } from './dev-plan.mjs'

/** 桌面应用在 Windows 上的可执行文件名后缀（Electron/electron-builder 的产物形态）。 */
const WINDOWS_EXE_EXTENSION = '.exe'

/** 桌面应用自己拥有的 profile 名；`apps/desktop/src/paths.ts` 里写死的那个。 */
export const DESKTOP_PROFILE = 'desktop'

/** 桌面应用在 macOS 上的默认名字，`open -a` 用；`DSH_DESKTOP_APP` 可换。 */
export const DESKTOP_APP_NAME = 'DeepSeek Harness'

/**
 * 按宿主的 `expandHomePath` 语义归一化路径。
 *
 * 宿主对 `DSH_HOME` 先展开 `~` 再 `resolve`（相对路径按当前目录），脚本照抄同一套
 * 口径：直接拿环境变量的字面量拼 `profiles/desktop`，`~/x` 会变成 `<cwd>/~/x`。
 * 宿主的 `home-paths` 同时认 `~/` 与 `~\`（Windows 上两种写法都有人用）。
 *
 * @param {string} input - 原始路径
 * @param {string} homeDir - 用户主目录
 * @param {string} [cwd] - 当前工作目录，相对路径的基准
 * @returns {string} 绝对路径
 */
export function expandHomePath(input, homeDir, cwd = process.cwd()) {
  const raw = String(input ?? '')
  const expanded = raw === '~'
    ? homeDir
    : raw.startsWith('~/') || raw.startsWith('~\\') ? join(homeDir, raw.slice(2)) : raw
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

/**
 * 从 `Info.plist` 的 XML 文本里取 `CFBundleExecutable`。
 *
 * 只认 XML 形态：调用方先 `plutil -convert xml1` 再喂进来。取不到返回 null，
 * 由调用方大声报错——猜一个名字比拒绝更糟（漏判运行态会写坏 profile）。
 *
 * @param {string} xml - plist 文本
 * @returns {string | null} 可执行文件名
 */
export function parseBundleExecutable(xml) {
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(String(xml ?? ''))
  const name = match?.[1]?.trim()
  return name === undefined || name === '' ? null : name
}

/**
 * `DSH_DESKTOP_APP` 的写法是不是路径形态。
 *
 * 只有含分隔符或以 `~` 开头才算路径：`DeepSeek Harness.app` 是**名字**（去常见安装
 * 位置找同名包），按路径解析会找成 `<cwd>/DeepSeek Harness.app`。
 *
 * @param {string} input - 原始写法
 * @returns {boolean} 是否按路径处理
 */
export function looksLikeAppPath(input) {
  const raw = String(input ?? '').trim()
  return raw.includes('/') || raw.includes('\\') || raw.startsWith('~')
}

/**
 * 取路径的最后一段，`/` 与 `\` 都当分隔符。
 *
 * 不能用 `node:path` 的 `basename`：它只认当前平台的分隔符，在 POSIX 上把
 * `C:\Apps\Probe\Probe.exe` 整串当一个文件名。Windows 路径在别的平台上被解析
 * 时（测试、跨平台包装脚本）仍要取到 `Probe.exe`。
 *
 * @param {string} path - 路径
 * @returns {string} 最后一段
 */
function pathLeaf(path) {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Windows 上桌面应用 exe 的候选路径，按优先级排列。
 *
 * 只算候选、不碰文件系统：`DSH_DESKTOP_APP` 的三种写法（exe 路径、安装目录、裸名）
 * 都归一到同一组候选，由调用方挑第一个存在的。裸名按 electron-builder 的 NSIS 默认
 * 布局展开——`perMachine: false`（当前宿主的配置）装到 `%LOCALAPPDATA%\Programs\<名>`；
 * 全机安装再兜 `%ProgramFiles%` 与 `%ProgramFiles(x86)%`，宿主改了安装范围时不至于
 * 找不到应用。
 *
 * @param {object} options - 选项
 * @param {string} options.appName - 应用名、安装目录或 exe 路径
 * @param {object} [options.env] - 环境变量，读 LOCALAPPDATA / ProgramFiles / ProgramFiles(x86)
 * @param {string} options.homeDir - 用户主目录，展开 `~` 用
 * @param {string} [options.cwd] - 当前工作目录，相对路径的基准
 * @returns {string[]} 候选 exe 绝对路径
 */
export function windowsExeCandidates({ appName, env = {}, homeDir, cwd = process.cwd() }) {
  const raw = String(appName ?? '').trim()
  if (raw === '') return []
  if (looksLikeAppPath(raw)) {
    const resolved = expandHomePath(raw, homeDir, cwd)
    if (/\.exe$/i.test(resolved)) return [resolved]
    return [join(resolved, `${pathLeaf(resolved)}${WINDOWS_EXE_EXTENSION}`)]
  }
  const name = raw.replace(/\.exe$/i, '')
  // 先 trim 原值再拼：`join('', 'Programs')` 得到相对路径 `Programs`，按 cwd 解析会
  // 指到别的树形上——候选列表承诺的是绝对路径。
  const nonEmpty = (value) => {
    const text = String(value ?? '').trim()
    return text === '' ? null : text
  }
  const localAppData = nonEmpty(env.LOCALAPPDATA)
  const roots = [
    localAppData === null ? null : join(localAppData, 'Programs'),
    nonEmpty(env.ProgramFiles),
    nonEmpty(env['ProgramFiles(x86)']),
  ]
  return roots
    .filter((entry) => entry !== null)
    .map((entry) => join(entry, name, `${name}${WINDOWS_EXE_EXTENSION}`))
}

/**
 * 从 `tasklist /FO CSV` 的输出里取进程名。
 *
 * 只认以引号开头的行：没有匹配时 tasklist 输出的是本地化的提示行（英文
 * `INFO: No tasks are running…`、中文「信息: 没有运行的任务匹配指定标准。」），
 * 按文本比对会随系统语言失效。CSV 形态下 Image Name 是完整名字（默认表格模式
 * 才有 25 字符截断），这也是一律用 CSV 的原因。
 *
 * @param {string} text - tasklist 的 stdout
 * @returns {string[]} 进程名，按输出顺序
 */
export function parseTasklistImages(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => /^"([^"]*)"/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1].trim())
    .filter((name) => name !== '')
}

/**
 * `DSH_HOME` 能不能交给桌面应用。
 *
 * 相对路径的基准是发起命令的目录，而桌面应用由 `open` 启动、cwd 也不是这里，两边会
 * 算成不同的数据根。`~user` 同样不支持：宿主只展开单独的 `~` 与 `~/`、`~\` 前缀，
 * 照字面拼下去会变成 `<cwd>/~user/x`。判定前统一 `trim`——带首尾空白的值拼出来是
 * 另一条路径。
 *
 * @param {string} rawHome - 原始 `DSH_HOME`，未设时传空串
 * @returns {'unset' | 'absolute' | 'relative' | 'unsupported-tilde-user'} 判定
 */
export function planDshHomeEnv(rawHome) {
  const raw = String(rawHome ?? '').trim()
  if (raw === '') return 'unset'
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return 'absolute'
  if (raw.startsWith('~')) return 'unsupported-tilde-user'
  return isAbsolute(raw) ? 'absolute' : 'relative'
}

/**
 * 校验 `DSH_HOME` 并算出 desktop profile 的各条路径。
 *
 * 两个不合格的写法在入口就拒：相对路径的基准是发起命令的目录（应用由 `open` 启动，
 * cwd 不同），`~user` 宿主也不展开（照字面拼会落到 `<cwd>/~user/x`）。
 *
 * @param {object} options - 选项
 * @param {string} options.rawHome - 原始 `DSH_HOME`，未设时传空串
 * @param {string} options.homeDir - 用户主目录
 * @param {string} [options.cwd] - 当前工作目录
 * @returns {object} `resolveDesktopPaths` 的结果
 * @throws `DSH_HOME` 是相对路径或 `~user` 写法时
 */
export function resolveHomePathsOrThrow({ rawHome, homeDir, cwd }) {
  const verdict = planDshHomeEnv(rawHome)
  if (verdict === 'unsupported-tilde-user') {
    throw new Error(
      `DSH_HOME=${rawHome} 用了 ~user 写法：宿主只展开单独的 ~ 与 ~/、~\\ 前缀，`
      + '照字面拼下去会变成 <当前目录>/~user/…。改成 ~/…，或写绝对路径。',
    )
  }
  if (verdict === 'relative') {
    throw new Error(
      `DSH_HOME=${rawHome} 是相对路径：它的基准是发起命令的目录，而桌面应用由 open 启动、`
      + '不继承这个 shell 的环境，两边会算成不同的数据根。改成绝对路径，或用 ~/ 开头的写法。',
    )
  }
  return resolveDesktopPaths({ homeDir, cwd, env: { DSH_HOME: rawHome } })
}

/**
 * 桌面应用那把锁该不该拦。
 *
 * 宿主 `DesktopProjectManager.withLock` 用 `openSync(lock, 'wx')` 建 `<profile>/lock`、
 * 写入自己的 PID，操作完删掉。撞上还要看持有者是否活着：进程已退出的锁是陈旧的，
 * 宿主自己会 `unlink` 后重开。读不出 PID、或 PID 非法时按宿主口径当成「活跃」拒绝。
 *
 * @param {object} options - 选项
 * @param {boolean} options.exists - 锁文件在不在
 * @param {string} [options.content] - 锁文件内容
 * @param {boolean} [options.ownerAlive] - 持有进程是否存活，调用方用 `kill(pid, 0)` 判定
 * @returns {'proceed' | 'stale' | 'refuse'} 动作
 */
export function planProfileLockAction({ exists, content = '', ownerAlive = false }) {
  if (exists !== true) return 'proceed'
  const pid = Number.parseInt(String(content).trim(), 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'refuse'
  return ownerAlive === true ? 'refuse' : 'stale'
}

/**
 * 算出 `node_modules` 链接要做什么。
 *
 * 只认两种放行：不存在就建，已经指向当前工作树就不动。指向别处、或占位是实体
 * 目录（插件管理装的），一律拒绝——那是别人的安装，覆盖要由人决定。
 *
 * @param {object} options - 选项
 * @param {boolean} options.exists - 目标路径上有没有东西
 * @param {boolean} options.isSymbolicLink - 是不是符号链接
 * @param {boolean} options.sameTarget - 链接是否已指向当前工作树
 * @returns {'create' | 'keep' | 'refuse'} 动作
 */
export function planLinkAction({ exists, isSymbolicLink, sameTarget }) {
  if (exists !== true) return 'create'
  if (isSymbolicLink !== true) return 'refuse'
  return sameTarget === true ? 'keep' : 'refuse'
}

/**
 * 算出桌面 profile 的各个路径。
 *
 * @param {object} options - 选项
 * @param {string} options.homeDir - 用户主目录，默认数据根的父目录
 * @param {string} [options.cwd] - 当前工作目录，相对 `DSH_HOME` 的基准
 * @param {object} [options.env] - 环境变量，支持 `DSH_HOME`（空串按未设处理）
 * @returns {object} 数据根与 profile 内的文件路径
 */
export function resolveDesktopPaths({ homeDir, cwd, env = {} }) {
  const trimmed = String(env.DSH_HOME ?? '').trim()
  const configured = trimmed === '' ? null : trimmed
  const home = configured === null ? join(homeDir, '.dsh') : expandHomePath(configured, homeDir, cwd)
  const profileDir = join(home, 'profiles', DESKTOP_PROFILE)
  const nodeModulesDir = join(profileDir, 'node_modules')
  return {
    home,
    profileDir,
    packagePath: join(profileDir, 'package.json'),
    /** 宿主写 manifest 时用的锁（`dsh-atomic-write` 的 `<file>.lock` 兄弟文件）。 */
    packageLockPath: join(profileDir, 'package.json.lock'),
    /** 桌面应用自己那把锁：`apps/desktop/src/paths.ts` 的 `lock`，内容是持有者 PID。 */
    profileLockPath: join(profileDir, 'lock'),
    nodeModulesDir,
    linkPath: join(nodeModulesDir, LEADER_KIT_PACKAGE),
  }
}

/**
 * 本插件在这个工作树下的 `link:` 说明符。
 *
 * @param {string} worktree - 工作树绝对路径
 * @returns {string} `link:` 说明符
 */
export function desktopLinkSpec(worktree) {
  return `link:${worktree}`
}

/**
 * 读出 profile 里已经声明的本插件来源，没装时为 null。
 *
 * @param {object} manifest - profile 的 `package.json` 解析结果
 * @returns {string | null} 依赖说明符
 */
export function installedSpecOf(manifest) {
  return manifest?.dependencies?.[LEADER_KIT_PACKAGE] ?? null
}

/**
 * 算出「把本插件挂进 desktop profile」后的 manifest。
 *
 * 幂等：已经是本工作树的链接时 `changed` 为 false。已经装了一份别的来源（App 内
 * 插件管理装的版本、别的工作树）时直接拒绝——覆盖用户日常 profile 里的安装要由人
 * 决定，脚本不替它选。
 *
 * @param {object} options - 选项
 * @param {object} options.manifest - 当前 parse 出来的 `package.json`
 * @param {string} options.worktree - 工作树绝对路径
 * @returns {{ manifest: object, changed: boolean }} 新 manifest 与是否有变化
 * @throws 已装来源不同、或 profile 的 `dsh.profile` 结构不成立时
 */
export function planDesktopEnable({ manifest, worktree }) {
  const spec = desktopLinkSpec(worktree)
  const installed = installedSpecOf(manifest)
  if (installed !== null && installed !== spec) {
    throw new Error(
      `desktop profile 里已经装了一份 ${LEADER_KIT_PACKAGE}（${installed}），不是当前目录 ${worktree}。`
      + '\n它可能是桌面 App 的插件管理装的，也可能是另一个工作树挂上去的。'
      + `\n先卸掉再重跑：npm run desktop -- --remove，或在 DeepSeek Harness 的插件管理里卸载。`,
    )
  }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : null
  if (bundles === null) {
    throw new Error(
      'desktop profile 的 package.json 里没有 dsh.profile.bundles 列表：'
      + '这不是一个完整的桌面 profile。先打开一次 DeepSeek Harness 让它初始化，或删掉该 profile 让应用重建。',
    )
  }
  if (!bundles.includes(LEADER_KIT_PACKAGE)) bundles.push(LEADER_KIT_PACKAGE)
  const next = {
    ...manifest,
    dependencies: { ...(manifest.dependencies ?? {}), [LEADER_KIT_PACKAGE]: spec },
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } },
  }
  return { manifest: next, changed: JSON.stringify(next) !== JSON.stringify(manifest) }
}

/**
 * 算出「把本插件从 desktop profile 摘掉」后的 manifest。
 *
 * `--remove` 是包级摘除：profile 里可能挂着别的工作树的链接，或是插件管理装的
 * 版本。只摘「能判定是本工作树挂上去的」那份：依赖说明符不等于当前工作树的
 * `link:` 时直接拒绝，判不出归属也拒绝——摘错等于把别人的安装删掉。
 *
 * @param {object} options - 选项
 * @param {object} options.manifest - 当前 parse 出来的 `package.json`
 * @param {string} options.worktree - 工作树绝对路径
 * @returns {{ manifest: object, changed: boolean }} 新 manifest 与是否有变化
 * @throws 装了别处来源、或只出现在 bundles 里判不出归属时
 */
export function planDesktopDisable({ manifest, worktree }) {
  const installed = installedSpecOf(manifest)
  const current = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const inBundles = current.includes(LEADER_KIT_PACKAGE)
  if (installed === null && !inBundles) {
    return { manifest, changed: false }
  }
  if (installed === null) {
    throw new Error(
      `desktop profile 的 dsh.profile.bundles 里有 ${LEADER_KIT_PACKAGE}，但没有对应的依赖条目，`
      + '判不出是谁挂上去的。确认那份安装确实属于当前目录后手工删掉该 bundle 项，或整条重装。',
    )
  }
  if (installed !== desktopLinkSpec(worktree)) {
    throw new Error(
      `desktop profile 里装的 ${LEADER_KIT_PACKAGE} 是 ${installed}，不是当前目录 ${worktree}。`
      + '\n不摘别人的安装：到那份来源的目录里跑 npm run desktop -- --remove，'
      + '或在 DeepSeek Harness 的插件管理里卸载。',
    )
  }
  const dependencies = { ...(manifest?.dependencies ?? {}) }
  delete dependencies[LEADER_KIT_PACKAGE]
  const bundles = current.filter((name) => name !== LEADER_KIT_PACKAGE)
  const next = {
    ...manifest,
    dependencies,
    dsh: { ...manifest?.dsh, profile: { ...manifest?.dsh?.profile, bundles } },
  }
  return { manifest: next, changed: true }
}
