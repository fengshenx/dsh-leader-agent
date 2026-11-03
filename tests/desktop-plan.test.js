import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import {
  DESKTOP_PROFILE, desktopLinkSpec, desktopPathsOf, derivedDesktopHome, expandHomePath, installedSpecOf,
  looksLikeAppPath, parseBundleExecutable, parseTasklistImages, planDesktopDisable, planDesktopEnable,
  planDesktopHome, planDshHomeEnv, planLinkAction, planProfileLockAction, resolveDesktopPaths,
  resolveHomePathsOrThrow, windowsExeCandidates,
} from '../scripts/desktop-plan.mjs'
import { LEADER_KIT_PACKAGE, WEB_APP_BUNDLE } from '../scripts/dev-plan.mjs'

const WORKTREE = '/work/repo/.worktrees/desktop-launcher'
const OTHER_WORKTREE = '/work/repo/.worktrees/feature-a'
const HOME = '/home/user'
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/desktop.mjs')

/** 造一份桌面 profile 的 package.json（桌面应用自己写的形状）。 */
function desktopPackage(overrides = {}) {
  return {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {
      'dsh-session-file-reveal': 'link:./plugins/session-file-reveal',
      ...(overrides.dependencies ?? {}),
    },
    dsh: {
      profile: {
        bundles: overrides.bundles ?? ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-session-file-reveal'],
      },
    },
  }
}

test('桌面 profile 固定在 ~/.dsh/profiles/desktop', () => {
  const paths = resolveDesktopPaths({ homeDir: HOME, env: {} })
  assert.equal(paths.home, join(HOME, '.dsh'))
  assert.equal(paths.profileDir, join(HOME, '.dsh', 'profiles', DESKTOP_PROFILE))
  assert.equal(paths.packagePath, join(HOME, '.dsh', 'profiles', 'desktop', 'package.json'))
  assert.equal(paths.linkPath, join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', LEADER_KIT_PACKAGE))
})

test('DSH_HOME 覆盖数据根，空串按未设处理', () => {
  assert.equal(resolveDesktopPaths({ homeDir: HOME, env: { DSH_HOME: '/data/home' } }).home, resolve('/data/home'))
  assert.equal(resolveDesktopPaths({ homeDir: HOME, env: { DSH_HOME: '  ' } }).home, join(HOME, '.dsh'))
})

test('首次挂载：依赖写 link:，包名追加到 bundles 末尾', () => {
  const { manifest, changed } = planDesktopEnable({ manifest: desktopPackage(), worktree: WORKTREE })
  assert.equal(changed, true)
  assert.equal(manifest.dependencies[LEADER_KIT_PACKAGE], desktopLinkSpec(WORKTREE))
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-session-file-reveal', LEADER_KIT_PACKAGE,
  ])
  // 别的依赖与字段原样保留。
  assert.equal(manifest.dependencies['dsh-session-file-reveal'], 'link:./plugins/session-file-reveal')
  assert.equal(manifest.name, 'dsh-profile-desktop')
})

test('挂载幂等：同一工作树再算一次没有变化', () => {
  const first = planDesktopEnable({ manifest: desktopPackage(), worktree: WORKTREE }).manifest
  const second = planDesktopEnable({ manifest: first, worktree: WORKTREE })
  assert.equal(second.changed, false)
  assert.deepEqual(second.manifest, first)
})

test('已装另一份来源时拒绝覆盖', () => {
  const installed = desktopPackage({ dependencies: { [LEADER_KIT_PACKAGE]: desktopLinkSpec(OTHER_WORKTREE) } })
  assert.throws(
    () => planDesktopEnable({ manifest: installed, worktree: WORKTREE }),
    /已经装了一份 dsh-leader-kit/,
  )
  const versioned = desktopPackage({ dependencies: { [LEADER_KIT_PACKAGE]: '^0.1.0' } })
  assert.throws(() => planDesktopEnable({ manifest: versioned, worktree: WORKTREE }), /已经装了一份/)
})

test('bundles 已含本插件时不重复追加', () => {
  const manifest = desktopPackage({ bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, LEADER_KIT_PACKAGE] })
  const { manifest: next, changed } = planDesktopEnable({ manifest, worktree: WORKTREE })
  assert.equal(changed, true) // 依赖条目还是新写的
  assert.deepEqual(next.dsh.profile.bundles, manifest.dsh.profile.bundles)
})

test('profile 缺 bundles 列表时拒绝，并指向重建路径', () => {
  const manifest = desktopPackage()
  delete manifest.dsh.profile.bundles
  assert.throws(() => planDesktopEnable({ manifest, worktree: WORKTREE }), /dsh\.profile\.bundles/)
})

test('摘除只动本插件，其余 bundle 顺序保留', () => {
  const installed = planDesktopEnable({ manifest: desktopPackage(), worktree: WORKTREE }).manifest
  const { manifest, changed } = planDesktopDisable({ manifest: installed, worktree: WORKTREE })
  assert.equal(changed, true)
  assert.equal(LEADER_KIT_PACKAGE in manifest.dependencies, false)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-session-file-reveal'])
  assert.equal(manifest.dependencies['dsh-session-file-reveal'], 'link:./plugins/session-file-reveal')
})

test('没装时摘除是空操作', () => {
  const { changed } = planDesktopDisable({ manifest: desktopPackage(), worktree: WORKTREE })
  assert.equal(changed, false)
})

test('摘除只摘当前工作树挂的那份：别处来源与判不出归属都拒绝', () => {
  const other = planDesktopEnable({ manifest: desktopPackage(), worktree: OTHER_WORKTREE }).manifest
  assert.throws(
    () => planDesktopDisable({ manifest: other, worktree: WORKTREE }),
    /不是当前目录/,
  )
  // 插件管理装的版本同样不摘。
  const versioned = desktopPackage({ dependencies: { [LEADER_KIT_PACKAGE]: '^0.1.0' } })
  assert.throws(() => planDesktopDisable({ manifest: versioned, worktree: WORKTREE }), /不是当前目录/)
  // 只出现在 bundles 里：判不出是谁挂的，不猜。
  const orphan = desktopPackage({ bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, LEADER_KIT_PACKAGE] })
  assert.throws(() => planDesktopDisable({ manifest: orphan, worktree: WORKTREE }), /判不出是谁挂上去的/)
})

test('进程名取自 Info.plist 的 CFBundleExecutable，不按包文件名猜', () => {
  // Lark.app 的进程是 Feishu：包名与进程名可以完全不同。
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Lark</string>
  <key>CFBundleExecutable</key><string>Feishu</string>
</dict></plist>`
  assert.equal(parseBundleExecutable(plist), 'Feishu')
  assert.equal(parseBundleExecutable('<dict><key>CFBundleExecutable</key><string>  DeepSeek Harness  </string></dict>'), 'DeepSeek Harness')
  // 取不到时返回 null，由调用方 fail loud。
  assert.equal(parseBundleExecutable('<dict><key>CFBundleName</key><string>Lark</string></dict>'), null)
  assert.equal(parseBundleExecutable('<dict><key>CFBundleExecutable</key><string></string></dict>'), null)
  assert.equal(parseBundleExecutable(''), null)
})

test('DSH_HOME 按宿主口径展开 ~ 与相对路径', () => {
  assert.equal(expandHomePath('~/data', HOME, '/work'), resolve(HOME, 'data'))
  assert.equal(expandHomePath('~', HOME, '/work'), resolve(HOME))
  assert.equal(expandHomePath('rel/home', HOME, '/work'), resolve('/work', 'rel/home'))
  assert.equal(expandHomePath('/abs/home', HOME, '/work'), resolve('/abs/home'))
  // Windows 上的 ~\ 与 ~/ 等价。
  assert.equal(expandHomePath('~\\data', HOME, '/work'), resolve(HOME, 'data'))
  // 只认开头的 ~：路径中间的 ~ 是普通字符。
  assert.equal(expandHomePath('/work/~x', HOME, '/work'), resolve('/work/~x'))
  assert.equal(
    resolveDesktopPaths({ homeDir: HOME, cwd: '/work', env: { DSH_HOME: '~/dsh' } }).profileDir,
    join(resolve(HOME, 'dsh'), 'profiles', DESKTOP_PROFILE),
  )
  assert.equal(
    resolveDesktopPaths({ homeDir: HOME, cwd: '/work', env: { DSH_HOME: 'data' } }).home,
    resolve('/work', 'data'),
  )
})

test('node_modules 链接只建不覆盖：别处来的安装一律拒绝', () => {
  assert.equal(planLinkAction({ exists: false, isSymbolicLink: false, sameTarget: false }), 'create')
  assert.equal(planLinkAction({ exists: true, isSymbolicLink: true, sameTarget: true }), 'keep')
  // 指向别的工作树：拒绝，不静默改指。
  assert.equal(planLinkAction({ exists: true, isSymbolicLink: true, sameTarget: false }), 'refuse')
  // 实体目录（插件管理装的）：拒绝。
  assert.equal(planLinkAction({ exists: true, isSymbolicLink: false, sameTarget: false }), 'refuse')
})

test('先建链接再写 manifest：链接被别人的安装挡住时不留坏状态', () => {
  // IO 层不硬测，只钉顺序：ensureLink 抛错时 writeManifest 还没执行，manifest
  // 保持原样；反过来会留下「bundles 声明了本插件、node_modules 却是别人的目录」。
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  const linkAt = source.indexOf('const linkAction = ensureLink(')
  assert.notEqual(linkAt, -1, '找不到 ensureLink 调用')
  const writeAt = source.indexOf('writeManifest(paths.packagePath, next)', linkAt)
  assert.notEqual(writeAt, -1, '挂载分支里找不到 writeManifest 调用')
  assert.ok(writeAt > linkAt, 'ensureLink 必须在 writeManifest 之前')
})

test('探活接线：进程名来自 Info.plist，不拿包名或路径去 pgrep', () => {
  // 包文件名不等于进程名（Lark.app → Feishu），DSH_DESKTOP_APP 还可能带路径。
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  assert.match(source, /const processName = executableNameOf\(bundle\)/)
  assert.match(source, /args: \['-x', processName\]/)
  assert.doesNotMatch(source, /args: \['-x', appName\]/)
  assert.doesNotMatch(source, /pgrepNameOf/)
})

test('相对 DSH_HOME 拒绝：open 启动的应用拿不到这个 shell 的 cwd', () => {
  assert.equal(planDshHomeEnv(''), 'unset')
  assert.equal(planDshHomeEnv(undefined), 'unset')
  assert.equal(planDshHomeEnv('/data/dsh'), 'absolute')
  assert.equal(planDshHomeEnv('~/dsh'), 'absolute')
  assert.equal(planDshHomeEnv('data'), 'relative')
  assert.equal(planDshHomeEnv('./data'), 'relative')
  // 宿主只认单独的 ~ 与 ~/、~\ 前缀，~user 照字面拼会变成 <cwd>/~user/x。
  assert.equal(planDshHomeEnv('~user/x'), 'unsupported-tilde-user')
  assert.equal(planDshHomeEnv('~user'), 'unsupported-tilde-user')
  // 首尾空白先 trim 再判：带空白的值拼出来是另一条路径。
  assert.equal(planDshHomeEnv('  /data/dsh  '), 'absolute')
  assert.equal(planDshHomeEnv('   '), 'unset')
  assert.equal(
    resolveDesktopPaths({ homeDir: HOME, env: { DSH_HOME: '  /data/dsh  ' } }).home,
    resolve('/data/dsh'),
  )
})

test('DSH_DESKTOP_APP：裸 .app 名是名字，不是相对路径', () => {
  assert.equal(looksLikeAppPath('DeepSeek Harness'), false)
  assert.equal(looksLikeAppPath('DeepSeek Harness.app'), false)
  assert.equal(looksLikeAppPath('/Applications/DeepSeek Harness.app'), true)
  assert.equal(looksLikeAppPath('~/Applications/Probe.app'), true)
  assert.equal(looksLikeAppPath('C:\\Apps\\Probe.app'), true)
})

test('Windows：裸名按 electron-builder 的每用户安装布局展开 exe 候选', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  }
  const candidates = windowsExeCandidates({ appName: 'DeepSeek Harness', env, homeDir: HOME })
  // 每用户安装（宿主 NSIS 的 perMachine: false）排第一，全机安装位置只做兜底。
  assert.deepEqual(candidates, [
    join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    join(env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    join(env['ProgramFiles(x86)'], 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ])
})

test('Windows：带 .exe 的裸名先剥扩展名，missing 的根直接跳过', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
  // 剥扩展名再拼目录名，不会得到 DeepSeek Harness.exe.exe。
  assert.deepEqual(
    windowsExeCandidates({ appName: 'DeepSeek Harness.exe', env, homeDir: HOME }),
    [join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')],
  )
  // 缺 LOCALAPPDATA 时跳过那条根，其余照常。
  assert.deepEqual(
    windowsExeCandidates({ appName: 'Probe', env: { ProgramFiles: 'C:\\Program Files' }, homeDir: HOME }),
    [join('C:\\Program Files', 'Probe', 'Probe.exe')],
  )
  // 空串不能拼成相对路径 `Programs\…`：候选列表承诺绝对路径。
  assert.deepEqual(
    windowsExeCandidates({ appName: 'Probe', env: { LOCALAPPDATA: '  ' }, homeDir: HOME }),
    [],
  )
})

// 路径形态编码的是 Windows 的绝对路径语义：POSIX 上 resolve 会把 `C:\Apps\…`
// 当成相对路径改写，断言只在 win32 上有意义。
test('Windows：exe 路径与安装目录只认给的那一处', { skip: process.platform !== 'win32' && 'Windows 路径语义' }, () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
  const exe = join('C:\\Apps', 'Probe', 'Probe.exe')
  assert.deepEqual(windowsExeCandidates({ appName: exe, env, homeDir: HOME }), [exe])
  // 安装目录：补上同名 exe，不回退默认安装位置。
  assert.deepEqual(
    windowsExeCandidates({ appName: join('C:\\Apps', 'Probe'), env, homeDir: HOME }),
    [exe],
  )
  // ~ 开头的路径展开到家目录，Windows 的 `~\` 与 `~/` 等价。
  assert.deepEqual(
    windowsExeCandidates({ appName: '~\\Apps\\Probe.exe', env, homeDir: HOME }),
    [resolve(HOME, 'Apps', 'Probe.exe')],
  )
})

test('tasklist 的 CSV 输出解析成进程名，不依赖系统语言', () => {
  const output = [
    '"DeepSeek Harness.exe","4242","Console","1","246,344 K"',
    '"docker.exe","88","Services","0","1,000 K"',
    '',
  ].join('\r\n')
  // 内存列自带逗号，只能取行首那个引号字段。
  assert.deepEqual(parseTasklistImages(output), ['DeepSeek Harness.exe', 'docker.exe'])
  // 没有匹配时打的是本地化提示行：英文与中文都不能被当成进程名。
  assert.deepEqual(parseTasklistImages('INFO: No tasks are running which match the specified criteria.\r\n'), [])
  assert.deepEqual(parseTasklistImages('信息: 没有运行的任务匹配指定标准。\r\n'), [])
  assert.deepEqual(parseTasklistImages(''), [])
})

test('宿主 <profile>/lock 按持有者进程判活：活跃拒绝、已退出放行', () => {
  // 没有锁：照常写。
  assert.equal(planProfileLockAction({ exists: false }), 'proceed')
  // 持有者在跑：宿主 applyRelease / disableAllPlugins 正在改 profile。
  assert.equal(planProfileLockAction({ exists: true, content: '4242\n', ownerAlive: true }), 'refuse')
  // 进程已退出是陈旧锁，宿主自己会接管。
  assert.equal(planProfileLockAction({ exists: true, content: '4242\n', ownerAlive: false }), 'stale')
  // 读不出 PID：宿主按「活跃」处理，脚本照抄，不赌。
  assert.equal(planProfileLockAction({ exists: true, content: '', ownerAlive: false }), 'refuse')
  assert.equal(planProfileLockAction({ exists: true, content: 'abc', ownerAlive: false }), 'refuse')
  assert.equal(planProfileLockAction({ exists: true, content: '0\n', ownerAlive: false }), 'refuse')
})

test('摘除不依赖桌面应用是否存在，且实体目录占位时整单拒绝', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // 探活在挂载分支里；--remove 分支要先返回。找不到应用同样只在挂载分支报错。
  assert.ok(source.indexOf("if (remove) {") < source.indexOf('const running = desktopAppRunning(target, process.env)'))
  assert.ok(source.indexOf("if (remove) {") < source.indexOf('throw new Error(missingAppMessage())'))
  // 实体目录 + manifest 有本插件记录：拒绝，不写 manifest。
  assert.match(source, /state === 'foreign' && planned/)
  assert.ok(source.indexOf("state === 'foreign' && planned") < source.indexOf('writeManifest(paths.packagePath, next)'))
})

test('写 manifest 的重读与写入在同一把锁里（消掉 TOCTOU）', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // 挂载与摘除各一处，都在锁内重读。
  assert.equal((source.match(/withFileLockSync\(paths\.packagePath/g) ?? []).length, 2)
  const locked = source.slice(source.indexOf('withFileLockSync(paths.packagePath, () => {'))
  assert.match(locked, /readManifest\(paths\.packagePath\)/)
})

test('启动接线：open 收 .app 绝对路径，数据根用 --env 显式传', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // open 不做 shell 展开，也不该让它按自己的 cwd 解析相对 DSH_HOME。
  assert.match(source, /'--env', `DSH_HOME=\$\{dshHome\}`, '-a', bundle/)
  assert.doesNotMatch(source, /args: \['-a', appName\]/)
  assert.match(source, /function openMacApp\(bundle, dshHome\)/)
  assert.match(source, /launchDesktopApp\(target, \{ dshHome: paths\.home \}\)/)
})

test('Windows 启动：detached 起 exe，DSH_HOME 进子进程环境', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // 单实例应用 + 已运行实例：新进程会自己退出，所以既要探活，也要把环境显式带给它。
  assert.match(source, /async function spawnWindowsApp\(exePath, dshHome\)/)
  assert.match(source, /env: \{ \.\.\.process\.env, DSH_HOME: dshHome \}/)
  assert.match(source, /detached: true/)
  // npm run 的 shell 先退出，不脱离会把应用一起收走。
  assert.match(source, /child\.unref\(\)/)
  // 只有 'spawn' 事件能证明进程创建成功；ENOENT / EACCES 走 error。
  assert.match(source, /child\.once\('spawn', resolve\)/)
})

test('Windows 探活：tasklist 走绝对路径 + CSV，不按表格输出比对', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // 表格模式的 Image Name 会截断，CSV 不会；tasklist 也不依赖 PATH。
  assert.match(source, /'system32', 'tasklist\.exe'/)
  assert.match(source, /args: \['\/FO', 'CSV', '\/NH'\]/)
  assert.match(source, /parseTasklistImages\(probe\.stdout\)/)
  // SystemRoot 与定位用的 env 是同一来源，不各读一份 process.env。
  assert.match(source, /const tasklist = join\(env\.SystemRoot/)
  assert.match(source, /if \(target\.kind === 'exe'\) return windowsAppRunning\(target\.path, env\)/)
})

test('启动 fail closed：探不到运行态不启动，open 有 stderr 不当成功', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // 校验必须真接在 main 的第一行，不能在 if 里被短路掉。
  assert.match(source, /const dailyPaths = resolveHomePathsOrThrow\(\{/)
  // 已运行实例收不到 --env（rc 仍 0），Windows 的单实例冲突同样静默，探不到就不能赌。
  assert.match(source, /target\.kind !== 'unsupported' && running === null/)
  assert.ok(source.indexOf("running === null") < source.indexOf('await launchDesktopApp(target'))
  // open 成功是静默的：stderr 非空说明环境没送到。
  assert.match(source, /const complaint = \(result\.stderr \?\? ''\)\.trim\(\)/)
  assert.match(source, /result\.status !== 0 \|\| complaint !== ''/)
})

test('锁覆盖整个读改写：自己建 <profile>/lock，只删自己那把', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // 与宿主同协议：'wx' 独占创建 + 写自己 PID。
  assert.match(source, /writeFileSync\(lockPath, `\$\{process\.pid\}\\n`, \{ flag: 'wx'/)
  assert.match(source, /readFileSync\(lockPath, 'utf8'\) === `\$\{process\.pid\}\\n`/)
  // 挂载与摘除各一处，都在持锁期间完成。
  assert.equal((source.match(/withProfileLock\(paths, \(\) => \{/g) ?? []).length, 2)
  // 一次性检查已被替换：检查与写入之间有窗口。
  assert.doesNotMatch(source, /assertProfileLockFree/)
})

test('DSH_HOME 的两种非法写法在解析入口就抛（行为级，走真实路径解析）', () => {
  // ~user/x 落到 <cwd>/~user/x 会写坏另一个目录，必须在解析前拒。
  assert.throws(
    () => resolveHomePathsOrThrow({ rawHome: '~user/x', homeDir: HOME, cwd: '/work' }),
    /~user 写法/,
  )
  assert.throws(
    () => resolveHomePathsOrThrow({ rawHome: '~user/x', homeDir: HOME }),
    (error) => !String(error.message).includes('/work/~user'),
  )
  // 相对路径：应用侧算出来的是另一条。
  assert.throws(
    () => resolveHomePathsOrThrow({ rawHome: 'probe-rel', homeDir: HOME, cwd: '/tmp' }),
    /是相对路径/,
  )
  // 合格的写法照常解析，首尾空白被 trim 掉。
  assert.equal(resolveHomePathsOrThrow({ rawHome: ' /tmp/x ', homeDir: HOME }).home, resolve('/tmp/x'))
  assert.equal(resolveHomePathsOrThrow({ rawHome: '', homeDir: HOME }).home, join(HOME, '.dsh'))
  assert.equal(resolveHomePathsOrThrow({ rawHome: '~/dsh', homeDir: HOME }).home, resolve(HOME, 'dsh'))
})

test('派生根落在工作树内的 .dev/desktop-home，形状与日常根一致', () => {
  const home = derivedDesktopHome({ worktree: WORKTREE })
  assert.equal(home, join(WORKTREE, '.dev', 'desktop-home'))
  const paths = desktopPathsOf(home)
  assert.equal(paths.home, home)
  assert.equal(paths.profileDir, join(home, 'profiles', DESKTOP_PROFILE))
  assert.equal(paths.linkPath, join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', LEADER_KIT_PACKAGE))
  // 与 npm run dev 的 .dev/home 不同目录：共用数据根会让两个实例互相写会话与卡片。
  assert.notEqual(home, join(WORKTREE, '.dev', 'home'))
})

test('主 checkout 用日常根，worktree 一律派生', () => {
  assert.deepEqual(planDesktopHome({ inWorktree: false }), { mode: 'daily', owner: null })
  // 主 checkout 里日常 profile 挂着别处时不在这里放行：由 planDesktopEnable 拒绝。
  assert.deepEqual(
    planDesktopHome({ inWorktree: false, installedSpec: 'link:/work/repo' }),
    { mode: 'daily', owner: null },
  )
  assert.deepEqual(planDesktopHome({ inWorktree: true }), { mode: 'derived', owner: null })
  // 派生分支把日常那份挂的是谁带出去，只用于提示，不参与判定。
  assert.deepEqual(
    planDesktopHome({ inWorktree: true, installedSpec: 'link:/work/repo' }),
    { mode: 'derived', owner: 'link:/work/repo' },
  )
  assert.deepEqual(
    planDesktopHome({ inWorktree: true, installedSpec: '' }),
    { mode: 'derived', owner: null },
  )
})

test('派生分支接线：worktree 内才派生，源固定成日常根', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  assert.match(source, /planDshHomeEnv\(rawHome\) === 'unset'/)
  assert.match(source, /planDesktopHome\(\{ inWorktree: inGitWorktree\(worktree\), installedSpec \}\)/)
  assert.match(source, /prepareDerivedPaths\(\{ worktree, homeDir, dailyPaths, dailyManifest \}\)/)
  assert.match(source, /env: \{ DSH_HOME: home, DSH_PROFILE: DESKTOP_PROFILE, DSH_HOME_SOURCE: dailyPaths\.home \}/)
  assert.match(source, /assertSeparateHome\(\{ home: derived\.home, sourceHome: dailyPaths\.home \}\)/)
  // worktree 标记是文件、主 checkout 是目录——用它区分身份不起 git 子进程。
  assert.match(source, /function inGitWorktree\(worktree\) \{\s*\n\s*const marker = lstatSync\(join\(worktree, '\.git'\)/)
  // 数据根独立则凭据也独立：派生时把源 HOME 的 refs 搬过来，否则一进界面就没 API key。
  assert.match(source, /const credentials = inheritCredentialRefs\(\{\s*\n\s*credentialsPath: derived\.credentialsPath,\s*\n\s*sourceCredentialsPath: derived\.sourceCredentialsPath,/)
  // 派生根要先建好 profile 再进锁：进锁时才 mkdir 会晚一步看到别的来源。
  assert.ok(
    source.indexOf('prepareDerivedPaths({ worktree, homeDir, dailyPaths, dailyManifest })')
    < source.indexOf('withProfileLock(paths, () => {'),
  )
  // 显式 DSH_HOME 时不派生：那条根是用户指定的，另找地方会让「我指定的目录没生效」。
  assert.match(source, /: \{ mode: 'daily', owner: null \}/)
})

test('派生只影响数据根：日常 profile 的说明符与链接一个都不写', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  const derivedBody = source.slice(
    source.indexOf('function prepareDerivedPaths('),
    source.indexOf('async function main()'),
  )
  // 派生只读日常根（dailyPaths / dailyManifest），不出现对 dailyPaths 的写操作。
  assert.match(derivedBody, /prepareProfileDir\(/)
  assert.doesNotMatch(derivedBody, /writeFileSync|rmSync|symlinkSync\(/)
  assert.doesNotMatch(derivedBody, /dailyPaths\.linkPath/)
})

test('已装来源的说明符按链接原样取出，供派生判定用', () => {
  assert.equal(installedSpecOf(desktopPackage()), null)
  assert.equal(
    installedSpecOf(desktopPackage({ dependencies: { [LEADER_KIT_PACKAGE]: 'link:/work/repo' } })),
    'link:/work/repo',
  )
})
