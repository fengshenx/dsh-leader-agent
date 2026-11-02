import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEADER_KIT_PACKAGE, WEB_APP_BUNDLE, assertSeparateHome, assertWebBundle, deriveProfilePackage,
  planNodeModules, resolveDevPaths,
} from '../scripts/dev-plan.mjs'

const WORKTREE = '/work/repo/.worktrees/feature-a'
const SOURCE_HOME = '/home/user/.dsh'

/** 造一份源 profile 的 package.json。 */
function sourcePackage() {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-experimental-agent-team-profile': '0.2.1-rc.2',
      'dsh-remind': 'link:/home/user/code/dsh-remind',
      'dsh-leader-kit': 'link:/home/user/code/dsh-leader-kit',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind', 'dsh-leader-kit'],
      },
    },
  }
}

test('默认数据根落在工作树内，源 HOME 取 ~/.dsh', () => {
  const paths = resolveDevPaths({ worktree: WORKTREE, homeDir: '/home/user', env: {} })
  assert.equal(paths.home, join(WORKTREE, '.dev', 'home'))
  assert.equal(paths.sourceProfileDir, join(SOURCE_HOME, 'profiles', 'web'))
  assert.equal(paths.sourceNodeModules, join(SOURCE_HOME, 'profiles', 'web', 'node_modules'))
  assert.equal(paths.profileDir, join(WORKTREE, '.dev', 'home', 'profiles', 'web'))
})

test('DSH_HOME 与 DSH_HOME_SOURCE 都能覆盖', () => {
  const paths = resolveDevPaths({
    worktree: WORKTREE,
    homeDir: '/home/user',
    env: { DSH_HOME: '/tmp/dev-home', DSH_HOME_SOURCE: '/tmp/origin-home' },
  })
  assert.equal(paths.home, '/tmp/dev-home')
  assert.equal(paths.profileDir, '/tmp/dev-home/profiles/web')
  assert.equal(paths.sourceHome, '/tmp/origin-home')
})

test('派生 package.json 把插件依赖换成工作树链接，其余依赖照抄', () => {
  const derived = deriveProfilePackage(sourcePackage(), WORKTREE)
  assert.equal(derived.dependencies[LEADER_KIT_PACKAGE], `link:${WORKTREE}`)
  assert.equal(derived.dependencies['dsh-remind'], 'link:/home/user/code/dsh-remind')
  assert.equal(derived.dependencies['@deepseek-ai/dsh-experimental-agent-team-profile'], '0.2.1-rc.2')
})

test('派生 package.json 不改入参', () => {
  const source = sourcePackage()
  deriveProfilePackage(source, WORKTREE)
  assert.equal(source.dependencies[LEADER_KIT_PACKAGE], 'link:/home/user/code/dsh-leader-kit')
  assert.deepEqual(source.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind', 'dsh-leader-kit',
  ])
})

test('源 profile 没装本插件时，bundle 列表补上它', () => {
  const source = sourcePackage()
  source.dependencies = { 'dsh-remind': 'link:/home/user/code/dsh-remind' }
  source.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind']
  const derived = deriveProfilePackage(source, WORKTREE)
  assert.deepEqual(derived.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind', LEADER_KIT_PACKAGE,
  ])
  assert.equal(derived.dependencies[LEADER_KIT_PACKAGE], `link:${WORKTREE}`)
})

test('bundle 列表已有本插件时不重复追加', () => {
  const derived = deriveProfilePackage(sourcePackage(), WORKTREE)
  assert.equal(derived.dsh.profile.bundles.filter((name) => name === LEADER_KIT_PACKAGE).length, 1)
})

test('源 package.json 缺 dsh 段时也能派生', () => {
  const derived = deriveProfilePackage({ dependencies: {} }, WORKTREE)
  assert.deepEqual(derived.dsh.profile.bundles, [LEADER_KIT_PACKAGE])
  assert.equal(derived.dependencies[LEADER_KIT_PACKAGE], `link:${WORKTREE}`)
})

test('node_modules 逐条链到源，只有插件本体指工作树', () => {
  const plan = planNodeModules({
    sourceEntries: ['@deepseek-ai', 'dsh-leader-kit', 'dsh-remind', '.pnpm'],
    existingEntries: [],
    sourceNodeModules: '/home/user/.dsh/profiles/web/node_modules',
    worktree: WORKTREE,
  })
  const byName = Object.fromEntries(plan.links.map((item) => [item.name, item.target]))
  assert.equal(byName['@deepseek-ai'], '/home/user/.dsh/profiles/web/node_modules/@deepseek-ai')
  assert.equal(byName['.pnpm'], '/home/user/.dsh/profiles/web/node_modules/.pnpm')
  assert.equal(byName[LEADER_KIT_PACKAGE], WORKTREE)
  assert.deepEqual(plan.removals, [])
})

test('目标里多出来的条目要清掉，但插件本体不动', () => {
  const plan = planNodeModules({
    sourceEntries: ['@deepseek-ai'],
    existingEntries: ['@deepseek-ai', 'dsh-leader-kit', 'stale-plugin'],
    sourceNodeModules: '/src/node_modules',
    worktree: WORKTREE,
  })
  assert.deepEqual(plan.removals, ['stale-plugin'])
  assert.equal(plan.links.length, 2)
})

test('DSH_PROFILE 覆盖源 profile 名，两边的目录都跟着换', () => {
  const paths = resolveDevPaths({
    worktree: WORKTREE,
    homeDir: '/home/user',
    env: { DSH_PROFILE: 'sdk', DSH_HOME: '/tmp/dev-home' },
  })
  assert.equal(paths.profile, 'sdk')
  assert.equal(paths.sourceProfileDir, join(SOURCE_HOME, 'profiles', 'sdk'))
  assert.equal(paths.profileDir, '/tmp/dev-home/profiles/sdk')
})

test('DSH_PROFILE 传空串时落回 web', () => {
  assert.equal(resolveDevPaths({ worktree: WORKTREE, homeDir: '/home/user', env: { DSH_PROFILE: '' } }).profile, 'web')
})

test('数据根与源 HOME 相同时拒绝，两处 profile 目录也不例外', () => {
  assert.throws(
    () => assertSeparateHome({ home: '/home/user/.dsh', sourceHome: '/home/user/.dsh' }),
    /数据根与源 HOME 是同一个目录/,
  )
})

test('数据根与源 HOME 不同时放行', () => {
  assert.doesNotThrow(() => assertSeparateHome({
    home: join(WORKTREE, '.dev', 'home'),
    sourceHome: SOURCE_HOME,
  }))
})

test('绕路的写法（.. 与斜杠）仍判定为同一个目录', () => {
  assert.throws(
    () => assertSeparateHome({ home: '/home/user/.dsh/', sourceHome: '/home/user/sub/../.dsh' }),
    /数据根与源 HOME 是同一个目录/,
  )
})

test('符号链接指向源 HOME 时也拒绝', { skip: process.platform === 'win32' ? '需要创建符号链接权限' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-plan-'))
  try {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    assert.throws(
      () => assertSeparateHome({ home: join(root, 'alias'), sourceHome: join(root, 'real') }),
      /数据根与源 HOME 是同一个目录/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('两边都不存在时按字面量比较，不会误判', () => {
  assert.doesNotThrow(() => assertSeparateHome({ home: '/nowhere/a', sourceHome: '/nowhere/b' }))
  assert.throws(() => assertSeparateHome({ home: '/nowhere/a', sourceHome: '/nowhere/a' }), /同一个目录/)
})

test('源 profile 带 web app bundle 时放行', () => {
  assert.doesNotThrow(() => assertWebBundle({
    profileDir: '/home/user/.dsh/profiles/web',
    bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, LEADER_KIT_PACKAGE],
  }))
})

test('源 profile 缺 web app bundle 时拒绝，并说清 dsh web 会静默空转', () => {
  assert.throws(
    () => assertWebBundle({ profileDir: '/home/user/.dsh/profiles/dev', bundles: ['@deepseek-ai/dsh-base'] }),
    /没有 @deepseek-ai\/dsh-web-app.*dsh web 起不来/s,
  )
})

test('源 profile 根本没写 bundles 时也拒绝', () => {
  assert.throws(() => assertWebBundle({ profileDir: '/x', bundles: undefined }), /dsh-web-app/)
})
