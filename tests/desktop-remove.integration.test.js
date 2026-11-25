import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
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
  // 假 .app 由 LaunchServices 拉起，可能比测试体晚一拍写文件；清理带重试。
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
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
  // 数据域必须真实存在：只 hash package.json 的指纹守不住「写 sessions」这类回归。
  for (const name of ['sessions', 'storages', 'cards', 'attachments', 'state', 'logs', 'dsh-leader-agent']) {
    mkdirSync(join(daily, name), { recursive: true })
    writeFileSync(join(daily, name, 'probe.json'), `{"domain":"${name}"}\n`)
  }
  writeFileSync(join(daily, '.env'), 'DSH_KEY=x\n', { mode: 0o600 })
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
 * @param {boolean} [options.removeMount] - 是否加 --remove-mount
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 子进程结果
 */
function runRemove({ tree, home, extraEnv = {}, prod = false, removeMount = false }) {
  const env = { ...process.env, USERPROFILE: home, HOME: home }
  delete env.DSH_HOME
  delete env.DSH_DESKTOP_APP
  Object.assign(env, extraEnv)
  const args = [
    join(tree, 'scripts', 'desktop.mjs'), '--remove',
    ...(prod ? ['--prod'] : []),
    ...(removeMount ? ['--remove-mount'] : []),
  ]
  return spawnSync(process.execPath, args, { cwd: tree, env, encoding: 'utf8' })
}

/**
 * 对整棵日常根做树级指纹：文件内容 + 修改时间 + 权限，目录与链接记类型与目标。
 *
 * 只 hash 单个 profile manifest 的版本曾让「往日常 sessions 写文件」的回归保持绿色；
 * 这里覆盖 sessions / storages / cards / credentials 等所有数据域。
 *
 * @param {string} root - 数据根
 * @returns {object | null} 相对路径到条目的映射；根不存在时为 null
 */
function snapshotTree(root) {
  if (!existsSync(root)) return null
  const result = {}
  const visit = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        result[key] = { type: 'link', target: readlinkSync(path) }
        continue
      }
      if (entry.isDirectory()) {
        result[key] = { type: 'dir' }
        visit(path, key)
        continue
      }
      const info = statSync(path)
      result[key] = {
        type: 'file',
        sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
        mtimeMs: info.mtimeMs,
        mode: info.mode & 0o777,
      }
    }
  }
  visit(root, '')
  return result
}

/**
 * 造一个能接收 `open --env DSH_HOME=...` 的假 .app：把环境写进 capture，并在
 * `$DSH_HOME/sessions` 写一个文件，模拟应用使用数据根。
 *
 * @param {string} root - 临时根
 * @param {string} capturePath - 捕获 DSH_HOME 的文件
 * @returns {string} .app 绝对路径
 */
function writeFakeApp(root, capturePath) {
  const bundle = join(root, 'DshProbeStart.app')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DshProbeStart</string>
<key>CFBundleIdentifier</key><string>local.dsh.probe-start</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`)
  const executable = join(bundle, 'Contents', 'MacOS', 'DshProbeStart')
  writeFileSync(executable, `#!/bin/sh
printf '%s' "$DSH_HOME" > '${capturePath}'
mkdir -p "$DSH_HOME/sessions"
printf '{}\\n' > "$DSH_HOME/sessions/app-write.json"
`)
  chmodSync(executable, 0o755)
  return bundle
}

/**
 * 造一个 no-op 的 `npm`，让启动用例跳过真实客户端构建。
 *
 * @param {string} root - 临时根
 * @returns {string} 含假 npm 的 bin 目录
 */
function writeFakeNpm(root) {
  const bin = join(root, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'npm'), 0o755)
  return bin
}

/**
 * 跑真实的 `desktop.mjs` 启动路径（不启动真实 App）。
 *
 * @param {object} options - 选项
 * @param {string} options.tree - 假工作树
 * @param {string} options.home - 假用户主目录
 * @param {object} options.env - 追加环境变量
 * @param {string[]} [options.args] - 命令行参数
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 子进程结果
 */
function runDesktop({ tree, home, env: extraEnv = {}, args = [] }) {
  const env = { ...process.env, USERPROFILE: home, HOME: home }
  delete env.DSH_HOME
  Object.assign(env, extraEnv)
  return spawnSync(process.execPath, [join(tree, 'scripts', 'desktop.mjs'), ...args], {
    cwd: tree,
    env,
    encoding: 'utf8',
  })
}

/** 假 .app 的落盘等待预算：300 × 100ms。 */
const WAIT_ATTEMPTS = 300
const WAIT_INTERVAL_MS = 100
const WAIT_BUDGET_SECONDS = (WAIT_ATTEMPTS * WAIT_INTERVAL_MS) / 1000

/**
 * 超时文案：把系统异步窗口与复核步骤写进错误本身，避免并发下的超时被误读成 main 回归。
 *
 * @param {string} subject - 等的东西
 * @returns {string} 失败信息
 */
function waitTimeoutMessage(subject) {
  return `等了 ${WAIT_BUDGET_SECONDS} 秒仍没等到${subject}。\n`
    + '假 .app 由 macOS LaunchServices 拉起，落盘有一段系统异步窗口；并发/高负载下会明显变慢。\n'
    + '先 `node --test tests/desktop-remove.integration.test.js` 单跑复核：单跑通过不代表 main 失败，也不代表这次改动引入回归。'
}

/**
 * 等文件出现且内容匹配，最多 30 秒。
 *
 * @param {string} path - 文件路径
 * @param {string} expected - 期待内容
 * @returns {Promise<void>} 无返回
 */
async function waitForContent(path, expected) {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (existsSync(path) && readFileSync(path, 'utf8') === expected) return
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
  }
  throw new Error(waitTimeoutMessage(`${path} 的内容 ${JSON.stringify(expected)}`))
}

/**
 * 等文件出现；LaunchServices 拉起假应用到落盘之间有一小段异步窗口，最多等 30 秒。
 *
 * @param {string} path - 文件路径
 * @returns {Promise<void>} 无返回
 */
async function waitForPath(path) {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
  }
  throw new Error(waitTimeoutMessage(`文件 ${path}`))
}

test('worktree 内 --remove 在派生根没建过时是空操作：不建目录、不复制凭据、不误报', (t) => {
  const { tree, home } = makeFixture(t)
  const daily = seedDailyProfile(home)
  const before = snapshotTree(daily)

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
  assert.deepEqual(snapshotTree(daily), before)
})

test('worktree 内 --remove 只摘派生根：不按日常 profile 重建，日常根缺 node_modules 也照常摘', (t) => {
  const { tree, home } = makeFixture(t)
  const daily = seedDailyProfile(home)
  const derivedProfileDir = join(tree, '.dev', 'desktop-home', 'profiles', 'desktop')
  mkdirSync(derivedProfileDir, { recursive: true })
  writeProfileManifest(derivedProfileDir, tree)
  const before = snapshotTree(daily)

  const result = runRemove({ tree, home })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /已从 desktop profile 摘除/)
  const after = JSON.parse(readFileSync(join(derivedProfileDir, 'package.json'), 'utf8'))
  assert.equal(LEADER_AGENT_PACKAGE in after.dependencies, false)
  assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
  assert.deepEqual(snapshotTree(daily), before)
  assert.equal(existsSync(join(tree, '.dev', 'desktop-home', '.credentials.yaml')), false, '摘除时把日常凭据复制进了派生根')
})

test('desktop:prod 且显式 DSH_HOME 时 --remove 默认不动那条根的旧版挂载', (t) => {
  const { root, tree, home } = makeFixture(t)
  seedDailyProfile(home)
  const explicitHome = join(root, 'explicit-home')
  const explicitProfileDir = join(explicitHome, 'profiles', 'desktop')
  mkdirSync(explicitProfileDir, { recursive: true })
  writeProfileManifest(explicitProfileDir, tree)
  const before = snapshotTree(explicitHome)

  const result = runRemove({ tree, home, prod: true, extraEnv: { DSH_HOME: explicitHome } })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有桌面开发数据根/)
  // 默认只删影子根；线上/指定根里旧版 link: 不顺手摘，输出要提示显式开关。
  assert.match(result.stdout, /旧版挂载/)
  assert.deepEqual(snapshotTree(explicitHome), before)
  const explicitAfter = JSON.parse(readFileSync(join(explicitProfileDir, 'package.json'), 'utf8'))
  assert.equal(LEADER_AGENT_PACKAGE in explicitAfter.dependencies, true)
})

test('desktop:prod --remove --remove-mount 才摘那条根的旧版挂载', (t) => {
  const { root, tree, home } = makeFixture(t)
  const daily = seedDailyProfile(home)
  const dailyBefore = snapshotTree(daily)
  const explicitHome = join(root, 'explicit-home')
  const explicitProfileDir = join(explicitHome, 'profiles', 'desktop')
  mkdirSync(explicitProfileDir, { recursive: true })
  writeProfileManifest(explicitProfileDir, tree)

  const result = runRemove({ tree, home, prod: true, removeMount: true, extraEnv: { DSH_HOME: explicitHome } })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /已摘除本工作树旧版挂载/)
  const explicitAfter = JSON.parse(readFileSync(join(explicitProfileDir, 'package.json'), 'utf8'))
  assert.equal(LEADER_AGENT_PACKAGE in explicitAfter.dependencies, false)
  assert.equal(LEADER_AGENT_PACKAGE in explicitAfter.dsh.profile.bundles, false)
  // 日常根仍然一个字节没动：摘的是用户显式指定的那条根。
  assert.deepEqual(snapshotTree(daily), dailyBefore)
})

test('主 checkout 的 desktop（dev）--remove 只摘派生根，线上 profile 不动', (t) => {
  const { tree, home } = makeFixture(t, { gitMarker: 'dir' })
  const daily = seedDailyProfile(home, { worktree: tree })
  const before = snapshotTree(daily)

  const result = runRemove({ tree, home })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有可摘的挂载：/)
  // `npm run desktop` 是 dev 隔离模式：即使日常 profile 上有旧版挂载，也不碰它。
  assert.deepEqual(snapshotTree(daily), before)
  assert.equal(existsSync(join(tree, '.dev')), false, '派生根没建过时不该新建')
})

test('desktop（dev）即使显式 DSH_HOME 也不碰那条根：模式只看命令', (t) => {
  const { root, tree, home } = makeFixture(t, { gitMarker: 'dir' })
  seedDailyProfile(home)
  const explicitHome = join(root, 'explicit-home')
  const explicitProfileDir = join(explicitHome, 'profiles', 'desktop')
  mkdirSync(explicitProfileDir, { recursive: true })
  writeProfileManifest(explicitProfileDir, tree)
  const before = snapshotTree(explicitHome)

  const result = runRemove({ tree, home, extraEnv: { DSH_HOME: explicitHome } })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有可摘的挂载：/)
  assert.deepEqual(snapshotTree(explicitHome), before)
  assert.equal(existsSync(join(tree, '.dev')), false, 'dev 模式没建过派生根时不该新建')
})

test('主 checkout 的 --remove 删掉影子根，线上数据与 profile 一个字节不动', { skip: process.platform !== 'darwin' ? '假 .app 的探活只在 macOS 上可验证' : false }, (t) => {
  const { tree, home, root } = makeFixture(t, { gitMarker: 'dir' })
  const daily = seedDailyProfile(home)
  const before = snapshotTree(daily)
  const shadowPaths = desktopShadowPaths({ sourceHome: daily, worktree: tree })
  assert.notEqual(shadowPaths.home, join(tree, '.dev', 'desktop-home'), 'prod 影子根不能复用 dev 根')
  const sourcePackage = JSON.parse(readFileSync(join(daily, 'profiles', 'desktop', 'package.json'), 'utf8'))
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
  assert.deepEqual(snapshotTree(daily), before)
})

test('prod 建影子后跑 dev --remove：日常数据与 prod 影子都不动', (t) => {
  const { tree, home } = makeFixture(t, { gitMarker: 'dir' })
  const daily = seedDailyProfile(home)
  const before = snapshotTree(daily)
  const shadowPaths = desktopShadowPaths({ sourceHome: daily, worktree: tree })
  const sourcePackage = JSON.parse(readFileSync(join(daily, 'profiles', 'desktop', 'package.json'), 'utf8'))
  syncShadowHome({ sourceHome: daily, worktree: tree, shadowPaths, sourcePackage })

  const result = runRemove({ tree, home })

  assert.equal(result.status, 0, `--remove 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /没有可摘的挂载：/)
  assert.equal(existsSync(join(tree, '.dev', 'desktop-home')), false, 'dev 根被 prod 影子误用或创建')
  assert.equal(existsSync(shadowPaths.home), true, 'dev --remove 删掉了 prod 影子根')
  assert.deepEqual(snapshotTree(daily), before)
})

test('假 .app 启动：dev 写 dev 根，prod 写日常根，再跑 dev 日常数据不变', { skip: process.platform !== 'darwin' ? '假 .app 启动只在 macOS 上可验证' : false }, async (t) => {
  const { tree, home, root } = makeFixture(t, { gitMarker: 'dir' })
  const daily = seedDailyProfile(home)
  const capture = join(root, 'captured-home.txt')
  const fakeApp = writeFakeApp(root, capture)
  const fakeBin = writeFakeNpm(root)
  const env = {
    DSH_DESKTOP_APP: fakeApp,
    PATH: `${fakeBin}:${process.env.PATH}`,
  }

  // dev：应用拿到的必须是 dev 根，写进去的会话不能进日常根。
  let result = runDesktop({ tree, home, env })
  assert.equal(result.status, 0, `desktop 失败:\n${result.stdout}\n${result.stderr}`)
  await waitForContent(capture, join(tree, '.dev', 'desktop-home'))
  await waitForPath(join(tree, '.dev', 'desktop-home', 'sessions', 'app-write.json'))
  assert.equal(existsSync(join(daily, 'sessions', 'app-write.json')), false)

  // prod：影子根不同，应用写日常 sessions（这是 prod 的预期）。
  rmSync(capture, { force: true })
  result = runDesktop({ tree, home, env, args: ['--prod'] })
  assert.equal(result.status, 0, `desktop:prod 失败:\n${result.stdout}\n${result.stderr}`)
  await waitForContent(capture, join(tree, '.dev', 'desktop-prod-home'))
  await waitForPath(join(daily, 'sessions', 'app-write.json'))
  assert.notEqual(join(tree, '.dev', 'desktop-prod-home'), join(tree, '.dev', 'desktop-home'))
  const afterProd = snapshotTree(daily)

  // prod 建过影子后跑 dev：仍写 dev 根，日常数据（含 prod 刚写的 app-write）不变。
  rmSync(capture, { force: true })
  result = runDesktop({ tree, home, env })
  assert.equal(result.status, 0, `desktop 失败:\n${result.stdout}\n${result.stderr}`)
  await waitForContent(capture, join(tree, '.dev', 'desktop-home'))
  await waitForPath(join(tree, '.dev', 'desktop-home', 'sessions', 'app-write.json'))
  assert.deepEqual(snapshotTree(daily), afterProd)
})

test('prod 的 DSH_HOME 等于影子根时拒绝启动，不重建/移走该根', { skip: process.platform !== 'darwin' ? '假 .app 的探活只在 macOS 上可验证' : false }, (t) => {
  const { tree, home, root } = makeFixture(t, { gitMarker: 'dir' })
  seedDailyProfile(home)
  const shadowHome = join(tree, '.dev', 'desktop-prod-home')
  const shadowProfile = join(shadowHome, 'profiles', 'desktop')
  mkdirSync(shadowProfile, { recursive: true })
  writeProfileManifest(shadowProfile, null)
  const before = snapshotTree(shadowHome)
  const fakeApp = writeFakeApp(root, join(root, 'capture.txt'))

  const result = runDesktop({
    tree,
    home,
    env: { DSH_DESKTOP_APP: fakeApp, DSH_HOME: shadowHome },
    args: ['--prod'],
  })

  assert.equal(result.status, 1, `应当拒绝:\n${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /同一个目录/)
  assert.deepEqual(snapshotTree(shadowHome), before)
  assert.equal(existsSync(join(tree, '.dev', 'desktop-home')), false)
})

test('--remove-mount 只与 prod 的 --remove 组合', (t) => {
  const { tree, home } = makeFixture(t)
  seedDailyProfile(home)

  const alone = runDesktop({ tree, home, args: ['--remove-mount'] })
  assert.equal(alone.status, 1)
  assert.match(alone.stderr, /只与 --remove 一起用/)

  const dev = runDesktop({ tree, home, args: ['--remove', '--remove-mount'] })
  assert.equal(dev.status, 1)
  assert.match(dev.stderr, /只用于 desktop:prod/)
  assert.equal(existsSync(join(tree, '.dev')), false)
})
