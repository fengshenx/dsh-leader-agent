import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import {
  DESKTOP_PROFILE, desktopLinkSpec, expandHomePath, parseBundleExecutable, planDesktopDisable,
  planDesktopEnable, planLinkAction, resolveDesktopPaths,
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
  const linkAt = source.indexOf('const action = ensureLink(')
  assert.notEqual(linkAt, -1, '找不到 ensureLink 调用')
  const writeAt = source.indexOf('writeManifest(paths.packagePath, next)', linkAt)
  assert.notEqual(writeAt, -1, '挂载分支里找不到 writeManifest 调用')
  assert.ok(writeAt > linkAt, 'ensureLink 必须在 writeManifest 之前')
})

test('探活接线：进程名来自 Info.plist，不拿包名或路径去 pgrep', () => {
  // 包文件名不等于进程名（Lark.app → Feishu），DSH_DESKTOP_APP 还可能带路径。
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  assert.match(source, /const processName = executableNameOf\(appName, homeDir\)/)
  assert.match(source, /args: \['-x', processName\]/)
  assert.doesNotMatch(source, /args: \['-x', appName\]/)
  assert.doesNotMatch(source, /pgrepNameOf/)
})
