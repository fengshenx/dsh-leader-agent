import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { desktopLinkSpec, desktopShadowPaths } from '../scripts/desktop-plan.mjs'
import { syncShadowHome } from '../scripts/desktop-shadow.mjs'
import { LEADER_AGENT_PACKAGE, WEB_APP_BUNDLE } from '../scripts/dev-plan.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(new URL('../scripts/desktop.mjs', import.meta.url)))

/**
 * 造一套能跑真实脚本的假树：`scripts/` 整份复制过去，树根按指定形态放 `.git`。
 *
 * `desktop.mjs` 用自身位置推工作树（`dirname(import.meta.url)/..`），所以复制到临时
 * 树里之后，派生数据根就落在临时树内——测试不会碰调用方的真实数据根。
 *
 * @param {import('node:test').TestContext} t - 用例上下文，负责清理临时目录
 * @param {object} [options] - 选项
 * @param {'file' | 'dir'} [options.gitMarker] - `.git` 的形态：文件 = worktree，目录 = 主 checkout
 * @returns {{ root: string, tree: string, home: string }} 临时根、假工作树、假用户主目录
 */
function makeFixture(t, { gitMarker = 'file' } = {}) {
  // realpath：脚本按 argv 里的路径推工作树，`.dev` 里的链接说明符要与之逐字相等。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsk-desktop-remove-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tree = join(root, 'tree')
  cpSync(SCRIPT_DIR, join(tree, 'scripts'), { recursive: true })
  // `scripts/dev-plan.mjs` 与 `scripts/desktop-plan.mjs` 从 `src/host/home-paths.js` 取
  // 数据根归一化，脚本跑起来必须能解析到它——缺这份就 ERR_MODULE_NOT_FOUND。
  cpSync(join(SCRIPT_DIR, '..', 'src'), join(tree, 'src'), { recursive: true })
  if (gitMarker === 'file') writeFileSync(join(tree, '.git'), 'gitdir: /elsewhere/.git/worktrees/tree\n')
  else mkdirSync(join(tree, '.git'))
  return { root, tree, home: join(root, 'home') }
}

/**
 * 造一份日常 desktop profile；`worktree` 非空时写成「本工作树挂上去了」的状态。
 *
 * 故意不建 `node_modules`：派生会去复制源依赖，缺它时 `prepareProfileDir` 直接硬
 * 失败——正好用来证明摘除不该走派生。
 *
 * @param {string} home - 假用户主目录
 * @param {object} [options] - 选项
 * @param {string | null} [options.worktree] - 已挂载的工作树，未挂时传 null
 * @returns {string} 日常数据根
 */
function seedDailyProfile(home, { worktree = null } = {}) {
  const daily = join(home, '.dsh')
  const profileDir = join(daily, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules', 'dsh-session-tabs'), { recursive: true })
  writeFileSync(join(profileDir, 'cordis.yml'), 'plugins: {}\n')
  writeProfileManifest(profileDir, worktree)
  writeFileSync(join(daily, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-probe\n')
  return daily
}

/**
 * 写一份桌面 profile 的 `package.json`。
 *
 * @param {string} profileDir - profile 目录
 * @param {string | null} worktree - 已挂载的工作树，未挂时传 null
 * @returns {void} 无返回
 */
function writeProfileManifest(profileDir, worktree) {
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: worktree === null ? {} : { [LEADER_AGENT_PACKAGE]: desktopLinkSpec(worktree) },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, ...(worktree === null ? [] : [LEADER_AGENT_PACKAGE])],
      },
    },
  }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * 跑真实的 `--remove`。数据根靠 `USERPROFILE` / `HOME` 指到临时目录，显式 `DSH_HOME`
 * 由调用方另给；父进程环境里的同名变量一律先清掉。
 *
 * @param {object} options - 选项
 * @param {string} options.tree - 假工作树
 * @param {string} options.home - 假用户主目录
 * @param {object} [options.extraEnv] - 追加的环境变量
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 子进程结果
 */
function runRemove({ tree, home, extraEnv = {}, prod = false }) {
  const env = { ...process.env, USERPROFILE: home, HOME: home }
  delete env.DSH_HOME
  delete env.DSH_DESKTOP_APP
  Object.assign(env, extraEnv)
  const args = [join(tree, 'scripts', 'desktop.mjs'), '--remove', ...(prod ? ['--prod'] : [])]
  return spawnSync(process.execPath, args, { cwd: tree, env, encoding: 'utf8' })
}

/**
 * 记下文件的内容指纹与修改时间，用于证明「真实根一个字节都没动」。
 *
 * @param {string} path - 文件路径
 * @returns {{ sha: string, mtimeMs: number }} 指纹
 */
function snapshotOf(path) {
  return {
    sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtimeMs: statSync(path).mtimeMs,
  }
}

test('worktree 内 --remove 在派生根没建过时是空操作：不建目录、不复制凭据、不误报', (t) => {
  const { tree, home } = makeFixture(t)
  const daily = seedDailyProfile(home)
  const manifestPath = join(daily, 'profiles', 'desktop', 'package.json')
  const credentialsPath = join(daily, '.credentials.yaml')
  const before = { manifest: snapshotOf(manifestPath), credentials: snapshotOf(credentialsPath) }

  const result = runRemove({ tree, home })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有可摘的挂载：/)
  assert.doesNotMatch(result.stdout, /已从 desktop profile 摘除/)
  // 数据根必须解析到这套夹具里：否则 worktree 判定或 homedir 没被指过去，下面的断言也没意义。
  assert.ok(
    result.stdout.includes(join(tree, '.dev', 'desktop-home', 'profiles', 'desktop', 'package.json')),
    `数据根没指向夹具:\n${result.stdout}`,
  )
  assert.equal(existsSync(join(tree, '.dev')), false, '派生根被创建了')
  assert.deepEqual(snapshotOf(manifestPath), before.manifest)
  assert.deepEqual(snapshotOf(credentialsPath), before.credentials)
})

test('worktree 内 --remove 只摘派生根：不按日常 profile 重建，日常根缺 node_modules 也照常摘', (t) => {
  const { tree, home } = makeFixture(t)
  const daily = seedDailyProfile(home)
  const derivedProfileDir = join(tree, '.dev', 'desktop-home', 'profiles', 'desktop')
  mkdirSync(derivedProfileDir, { recursive: true })
  writeProfileManifest(derivedProfileDir, tree)
  const dailyManifestPath = join(daily, 'profiles', 'desktop', 'package.json')
  const before = snapshotOf(dailyManifestPath)

  const result = runRemove({ tree, home })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /已从 desktop profile 摘除/)
  const after = JSON.parse(readFileSync(join(derivedProfileDir, 'package.json'), 'utf8'))
  assert.equal(LEADER_AGENT_PACKAGE in after.dependencies, false)
  assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
  assert.deepEqual(snapshotOf(dailyManifestPath), before)
  assert.equal(existsSync(join(tree, '.dev', 'desktop-home', '.credentials.yaml')), false, '摘除时把日常凭据复制进了派生根')
})

test('desktop:prod 且显式 DSH_HOME 时 --remove 只摘那条根，不派生', (t) => {
  const { root, tree, home } = makeFixture(t)
  seedDailyProfile(home)
  const explicitHome = join(root, 'explicit-home')
  const explicitProfileDir = join(explicitHome, 'profiles', 'desktop')
  mkdirSync(explicitProfileDir, { recursive: true })
  writeProfileManifest(explicitProfileDir, tree)

  const result = runRemove({ tree, home, prod: true, extraEnv: { DSH_HOME: explicitHome } })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有桌面开发数据根/)
  // 只看用户指定的那条根：日常根里那份「没装」的状态原样留着。
  const installed = JSON.parse(readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.equal(LEADER_AGENT_PACKAGE in installed.dependencies, false)
  const explicitAfter = JSON.parse(readFileSync(join(explicitProfileDir, 'package.json'), 'utf8'))
  assert.equal(LEADER_AGENT_PACKAGE in explicitAfter.dependencies, false)
  assert.equal(existsSync(join(tree, '.dev')), false, '显式 DSH_HOME 但没建过影子根时不该派生')
})

test('主 checkout 的 desktop（dev）--remove 只摘派生根，线上 profile 不动', (t) => {
  const { tree, home } = makeFixture(t, { gitMarker: 'dir' })
  const daily = seedDailyProfile(home, { worktree: tree })
  const manifestPath = join(daily, 'profiles', 'desktop', 'package.json')
  const before = snapshotOf(manifestPath)

  const result = runRemove({ tree, home })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有可摘的挂载：/)
  // `npm run desktop` 是 dev 隔离模式：即使日常 profile 上有旧版挂载，也不碰它。
  assert.deepEqual(snapshotOf(manifestPath), before)
  assert.equal(existsSync(join(tree, '.dev')), false, '派生根没建过时不该新建')
})

test('desktop（dev）即使显式 DSH_HOME 也不碰那条根：模式只看命令', (t) => {
  const { root, tree, home } = makeFixture(t, { gitMarker: 'dir' })
  seedDailyProfile(home)
  const explicitHome = join(root, 'explicit-home')
  const explicitProfileDir = join(explicitHome, 'profiles', 'desktop')
  mkdirSync(explicitProfileDir, { recursive: true })
  writeProfileManifest(explicitProfileDir, tree)
  const before = snapshotOf(join(explicitProfileDir, 'package.json'))

  const result = runRemove({ tree, home, extraEnv: { DSH_HOME: explicitHome } })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有可摘的挂载：/)
  assert.deepEqual(snapshotOf(join(explicitProfileDir, 'package.json')), before)
  assert.equal(existsSync(join(tree, '.dev')), false, 'dev 模式没建过派生根时不该新建')
})

test('主 checkout 的 --remove 删掉影子根，线上 profile 一个字节不动', { skip: process.platform !== 'darwin' ? '假 .app 的探活只在 macOS 上可验证' : false }, (t) => {
  const { tree, home, root } = makeFixture(t, { gitMarker: 'dir' })
  const daily = seedDailyProfile(home)
  const manifestPath = join(daily, 'profiles', 'desktop', 'package.json')
  const before = snapshotOf(manifestPath)
  const shadowPaths = desktopShadowPaths({ sourceHome: daily, worktree: tree })
  const sourcePackage = JSON.parse(readFileSync(manifestPath, 'utf8'))
  syncShadowHome({ sourceHome: daily, worktree: tree, shadowPaths, sourcePackage })
  assert.equal(existsSync(shadowPaths.home), true)

  // 应用不在跑：用一个可解析、但进程名不存在的假 .app，避免真启动本机应用。
  const fakeApp = join(root, 'Fake.app')
  mkdirSync(join(fakeApp, 'Contents'), { recursive: true })
  writeFileSync(join(fakeApp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>DshProbeNone</string></dict></plist>
`)
  const result = runRemove({ tree, home, prod: true, extraEnv: { DSH_DESKTOP_APP: fakeApp } })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /已删除桌面开发数据根/)
  assert.equal(existsSync(shadowPaths.home), false)
  assert.equal(existsSync(join(tree, '.dev')), false)
  assert.deepEqual(snapshotOf(manifestPath), before)
})
