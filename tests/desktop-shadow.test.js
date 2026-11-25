import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { desktopShadowPaths } from '../scripts/desktop-plan.mjs'
import { assertShadowHomeSeparate, removeShadowHome, syncShadowHome } from '../scripts/desktop-shadow.mjs'
import { LEADER_AGENT_PACKAGE, WEB_APP_BUNDLE } from '../scripts/dev-plan.mjs'

/**
 * 造一份日常根 + 工作树：日常根里有 desktop profile、会话目录与凭据文件。
 *
 * @param {object} t - node:test 上下文
 * @param {object} [options] - 选项
 * @param {string} [options.patch] - 日常 profile 的 `cordis.patch.yml` 内容
 * @returns {object} 夹具
 */
function makeFixture(t, { patch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shadow-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceHome = join(root, 'home')
  const profileDir = join(sourceHome, 'profiles', 'desktop')
  const nodeModules = join(profileDir, 'node_modules')
  mkdirSync(join(nodeModules, 'dsh-session-tabs'), { recursive: true })
  mkdirSync(join(sourceHome, 'sessions'), { recursive: true })
  writeFileSync(join(sourceHome, 'sessions', 's1.json'), '{}')
  mkdirSync(join(sourceHome, 'storages'), { recursive: true })
  writeFileSync(join(sourceHome, '.env'), 'DSH_KEY=x\n')
  writeFileSync(join(sourceHome, '.credentials.yaml'), 'refs: {}\n', { mode: 0o600 })
  writeFileSync(join(sourceHome, '.anonymous-user-id'), 'anon\n')
  writeFileSync(join(sourceHome, '.DS_Store'), 'junk')

  const sourcePackage = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-session-tabs': '^0.1.6' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-session-tabs'] } },
  }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(sourcePackage, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.yml'), 'plugins: {}\n')
  if (patch !== undefined) writeFileSync(join(profileDir, 'cordis.patch.yml'), patch)

  const worktree = join(root, 'repo')
  mkdirSync(worktree, { recursive: true })
  return {
    root,
    sourceHome,
    profileDir,
    worktree,
    shadowPaths: desktopShadowPaths({ sourceHome, worktree }),
    sourcePackage,
  }
}

/**
 * 跑一次影子根同步。
 *
 * @param {object} fixture - `makeFixture` 的结果
 * @returns {object} `syncShadowHome` 的结果
 */
function sync(fixture) {
  return syncShadowHome({
    sourceHome: fixture.sourceHome,
    worktree: fixture.worktree,
    shadowPaths: fixture.shadowPaths,
    sourcePackage: fixture.sourcePackage,
  })
}

test('影子根共享会话目录，凭据指回日常文件，线上 profile 只读', (t) => {
  const fixture = makeFixture(t, { patch: "- id: ui-settings\n  config:\n    locale: zh\n" })
  const before = readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')
  const result = sync(fixture)

  assert.equal(result.credentials.mode, 'appended')
  assert.equal(result.credentials.path, join(fixture.sourceHome, '.credentials.yaml'))
  // 数据目录链回日常根；文件复制（凭据另有指向，不复制）。
  assert.equal(readlinkSync(join(fixture.shadowPaths.home, 'sessions')), join(fixture.sourceHome, 'sessions'))
  assert.equal(readlinkSync(join(fixture.shadowPaths.home, 'storages')), join(fixture.sourceHome, 'storages'))
  assert.equal(lstatSync(join(fixture.shadowPaths.home, '.env')).isFile(), true)
  assert.equal(readFileSync(join(fixture.shadowPaths.home, '.env'), 'utf8'), 'DSH_KEY=x\n')
  // 顶层文件可能是 `.env` 这类密钥，影子副本只给当前用户读。
  assert.equal(statSync(join(fixture.shadowPaths.home, '.env')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(fixture.shadowPaths.home, '.credentials.yaml')), false)
  assert.equal(existsSync(join(fixture.shadowPaths.home, '.DS_Store')), false)

  // 开发 profile 从日常 profile 派生：依赖链回日常，插件本体指工作树。
  const derived = JSON.parse(readFileSync(join(fixture.shadowPaths.profileDir, 'package.json'), 'utf8'))
  assert.equal(derived.dependencies[LEADER_AGENT_PACKAGE], `link:${fixture.worktree}`)
  assert.ok(derived.dsh.profile.bundles.includes(LEADER_AGENT_PACKAGE))
  assert.equal(
    readlinkSync(join(fixture.shadowPaths.profileDir, 'node_modules', 'dsh-session-tabs')),
    join(fixture.profileDir, 'node_modules', 'dsh-session-tabs'),
  )
  assert.equal(readlinkSync(join(fixture.shadowPaths.profileDir, 'node_modules', LEADER_AGENT_PACKAGE)), fixture.worktree)

  // 凭据指向日常文件；用户原有的 patch 行保留。
  const patch = readFileSync(join(fixture.shadowPaths.profileDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: credentials/)
  assert.match(patch, new RegExp(`path: ${JSON.stringify(join(fixture.sourceHome, '.credentials.yaml')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(patch, /- id: ui-settings/)

  // 日常 profile 一个字节没动。
  assert.equal(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8'), before)
  const manifest = JSON.parse(readFileSync(fixture.shadowPaths.manifestPath, 'utf8'))
  assert.ok(manifest.entries.includes('sessions'))
  assert.ok(manifest.entries.includes('.env'))
})

test('宿主新增的顶层数据域在下次启动时搬回日常根', (t) => {
  const fixture = makeFixture(t)
  sync(fixture)

  mkdirSync(join(fixture.shadowPaths.home, 'workspaces'))
  writeFileSync(join(fixture.shadowPaths.home, 'workspaces', 'w1.json'), '{}')
  const second = sync(fixture)

  assert.deepEqual(second.migrated, ['workspaces'])
  assert.equal(readFileSync(join(fixture.sourceHome, 'workspaces', 'w1.json'), 'utf8'), '{}')
  assert.equal(readlinkSync(join(fixture.shadowPaths.home, 'workspaces')), join(fixture.sourceHome, 'workspaces'))
})

test('日常 patch 已经给出 credentials.path 时原样保留，不重复追加', (t) => {
  const fixture = makeFixture(t, { patch: "- id: credentials\n  config:\n    path: /tmp/shared-creds.yaml\n" })
  const result = sync(fixture)
  assert.equal(result.credentials.mode, 'custom')
  const patch = readFileSync(join(fixture.shadowPaths.profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal((patch.match(/- id: credentials/g) ?? []).length, 1)
  assert.match(patch, /\/tmp\/shared-creds\.yaml/)
})

test('日常 patch 的 credentials 行没有路径时拒绝启动，避免凭据分叉', (t) => {
  const fixture = makeFixture(t, { patch: "- id: credentials\n  config:\n    watch: false\n" })
  assert.throws(() => sync(fixture), /credentials/)
  // 拒绝发生在派生之后、启动之前；日常 profile 仍然没被写。
  assert.equal(existsSync(join(fixture.profileDir, 'package.json')), true)
})

test('--remove 删影子根、清空 .dev，日常 profile 不动', (t) => {
  const fixture = makeFixture(t)
  sync(fixture)
  const result = removeShadowHome({ sourceHome: fixture.sourceHome, shadowPaths: fixture.shadowPaths })

  assert.equal(result.removed, true)
  assert.equal(existsSync(fixture.shadowPaths.home), false)
  assert.equal(existsSync(join(fixture.worktree, '.dev')), false)
  assert.equal(existsSync(join(fixture.profileDir, 'package.json')), true)
  assert.equal(removeShadowHome({ sourceHome: fixture.sourceHome, shadowPaths: fixture.shadowPaths }).removed, false)
})

test('没有清单的影子根不删，先挪到旁边保留', (t) => {
  const fixture = makeFixture(t)
  const unknown = join(fixture.shadowPaths.home, 'mystery')
  mkdirSync(unknown, { recursive: true })
  writeFileSync(join(unknown, 'keep.json'), '{"keep":true}\n')

  const refused = removeShadowHome({ sourceHome: fixture.sourceHome, shadowPaths: fixture.shadowPaths })
  assert.deepEqual(refused.refused, ['mystery'])
  assert.equal(existsSync(unknown), true)

  const result = sync(fixture)
  assert.notEqual(result.foreignPath, null)
  assert.equal(readFileSync(join(result.foreignPath, 'mystery', 'keep.json'), 'utf8'), '{"keep":true}\n')
  assert.equal(existsSync(join(fixture.shadowPaths.home, 'profiles', 'desktop', 'package.json')), true)
})

test('影子里的文件副本每次同步刷新，目录保持链接', (t) => {
  const fixture = makeFixture(t)
  sync(fixture)
  writeFileSync(join(fixture.sourceHome, '.env'), 'DSH_KEY=y\n')
  sync(fixture)
  assert.equal(readFileSync(join(fixture.shadowPaths.home, '.env'), 'utf8'), 'DSH_KEY=y\n')
  assert.equal(lstatSync(join(fixture.shadowPaths.home, '.env')).isSymbolicLink(), false)
  assert.equal(readdirSync(join(fixture.shadowPaths.home, 'profiles')).includes('desktop'), true)
})

test('源根与影子根相同时拒绝同步，源根一个文件都没动', (t) => {
  const fixture = makeFixture(t)
  const before = readdirSync(fixture.sourceHome).sort()
  const samePaths = { ...fixture.shadowPaths, home: fixture.sourceHome, manifestPath: join(fixture.sourceHome, '.desktop-shadow.json') }
  assert.throws(
    () => syncShadowHome({
      sourceHome: fixture.sourceHome,
      worktree: fixture.worktree,
      shadowPaths: samePaths,
      sourcePackage: fixture.sourcePackage,
    }),
    /同一个目录/,
  )
  assert.throws(
    () => assertShadowHomeSeparate({ sourceHome: fixture.sourceHome, shadowHome: fixture.sourceHome }),
    /同一个目录/,
  )
  assert.deepEqual(readdirSync(fixture.sourceHome).sort(), before)
})

test('known 项被换成实体目录时挪到旁边保留，不跟随 rmSync 删除', (t) => {
  const fixture = makeFixture(t)
  sync(fixture)
  const sessions = join(fixture.shadowPaths.home, 'sessions')
  // Linux 的 rmSync 会把目录链接当目录报 EISDIR；只摘链接用 unlink。
  if (lstatSync(sessions).isSymbolicLink()) unlinkSync(sessions)
  else rmSync(sessions, { recursive: true })
  mkdirSync(sessions)
  writeFileSync(join(sessions, 'new-dev.json'), '{"keep":true}\n')

  const second = sync(fixture)
  // 日常根已有同名 sessions 目录：不能覆盖，挪到 .dev 下的 aside。
  assert.equal(second.conflicts.length, 1)
  const aside = second.conflicts[0].split(' -> ')[1]
  assert.equal(readFileSync(join(aside, 'new-dev.json'), 'utf8'), '{"keep":true}\n')
  assert.equal(lstatSync(join(fixture.shadowPaths.home, 'sessions')).isSymbolicLink(), true)
})
