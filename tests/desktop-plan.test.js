import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  DESKTOP_PROFILE, desktopLinkSpec, planDesktopDisable, planDesktopEnable, resolveDesktopPaths,
} from '../scripts/desktop-plan.mjs'
import { LEADER_KIT_PACKAGE, WEB_APP_BUNDLE } from '../scripts/dev-plan.mjs'

const WORKTREE = '/work/repo/.worktrees/desktop-launcher'
const OTHER_WORKTREE = '/work/repo/.worktrees/feature-a'
const HOME = '/home/user'

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
  const { manifest, changed } = planDesktopDisable({ manifest: installed })
  assert.equal(changed, true)
  assert.equal(LEADER_KIT_PACKAGE in manifest.dependencies, false)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-session-file-reveal'])
  assert.equal(manifest.dependencies['dsh-session-file-reveal'], 'link:./plugins/session-file-reveal')
})

test('没装时摘除是空操作', () => {
  const { changed } = planDesktopDisable({ manifest: desktopPackage() })
  assert.equal(changed, false)
})
