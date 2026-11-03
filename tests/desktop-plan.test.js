import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import {
  DESKTOP_PROFILE, desktopLinkSpec, expandHomePath, looksLikeAppPath, parseBundleExecutable,
  planDesktopDisable, planDesktopEnable, planDshHomeEnv, planLinkAction, planProfileLockAction,
  resolveDesktopPaths,
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
  assert.equal(resolveDesktopPaths({ homeDir: HOME, env: { DSH_HOME: '/data/home' } }).home, '/data/home')
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
  assert.equal(expandHomePath('~/data', HOME, '/work'), join(HOME, 'data'))
  assert.equal(expandHomePath('~', HOME, '/work'), HOME)
  assert.equal(expandHomePath('rel/home', HOME, '/work'), '/work/rel/home')
  assert.equal(expandHomePath('/abs/home', HOME, '/work'), '/abs/home')
  // Windows 上的 ~\ 与 ~/ 等价。
  assert.equal(expandHomePath('~\\data', HOME, '/work'), join(HOME, 'data'))
  // 只认开头的 ~：路径中间的 ~ 是普通字符。
  assert.equal(expandHomePath('/work/~x', HOME, '/work'), '/work/~x')
  assert.equal(
    resolveDesktopPaths({ homeDir: HOME, cwd: '/work', env: { DSH_HOME: '~/dsh' } }).profileDir,
    join(HOME, 'dsh', 'profiles', DESKTOP_PROFILE),
  )
  assert.equal(
    resolveDesktopPaths({ homeDir: HOME, cwd: '/work', env: { DSH_HOME: 'data' } }).home,
    '/work/data',
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
    '/data/dsh',
  )
})

test('DSH_DESKTOP_APP：裸 .app 名是名字，不是相对路径', () => {
  assert.equal(looksLikeAppPath('DeepSeek Harness'), false)
  assert.equal(looksLikeAppPath('DeepSeek Harness.app'), false)
  assert.equal(looksLikeAppPath('/Applications/DeepSeek Harness.app'), true)
  assert.equal(looksLikeAppPath('~/Applications/Probe.app'), true)
  assert.equal(looksLikeAppPath('C:\\Apps\\Probe.app'), true)
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
  // 探活在挂载分支里；--remove 分支要先返回。
  assert.ok(source.indexOf("if (remove) {") < source.indexOf('desktopAppRunning(appBundle)'))
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
  assert.match(source, /launchDesktopApp\(appBundle, \{ dshHome: paths\.home \}\)/)
})

test('启动 fail closed：探不到运行态不启动，open 有 stderr 不当成功', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // ~user 的判定必须真接到 main 上，否则只是纯函数自娱自乐。
  assert.match(source, /homeEnv === 'unsupported-tilde-user'/)
  // 已运行实例收不到 --env（rc 仍 0），所以探活拿不到结论时不能自动启动。
  assert.match(source, /process\.platform === 'darwin' && running === null/)
  assert.ok(source.indexOf("running === null") < source.indexOf('launchDesktopApp(appBundle'))
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
