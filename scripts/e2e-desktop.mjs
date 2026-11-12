/**
 * 用桌面版内置的 dsh 跑 e2e：桌面版会先于 npm `latest` 发布（0.2.2 时 npm
 * `latest` 还是 rc.1，`next` 才是桌面内置的 rc.2），npm 宿主上复现不了桌面刚
 * 发的新行为。
 *
 * 做法：用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 以 Node 身份加载 `app.asar`
 * 里的 dsh（Electron 的 fs 能读 asar），生成一个临时 wrapper 作为 `DEV_DSH`，
 * 再走既有的 `npm run e2e` 车道。数据根仍由 e2e 夹具隔离。
 *
 * 只支持 macOS；找不到桌面版时直接报错，不静默退回 npm 宿主。
 *
 * @module dsh-leader-agent/scripts/e2e-desktop
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnCommandSync } from './spawn-command.mjs'

/** 仓库根目录。 */
const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 默认的桌面版安装位置。 */
const DEFAULT_APP = '/Applications/DeepSeek Harness.app'

/** 桌面版内置 dsh 的 CLI 入口，相对 `.app` 根目录。 */
const ASAR_DSH = 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

/**
 * 报错退出，不带任何降级。
 *
 * @param {string} message - 面向维护者的原因
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`dsh-leader-agent: ${message}\n`)
  process.exit(1)
}

/**
 * 定位 `.app`：显式配置优先；在桌面版会话里可直接从 `DSH_INSTALL_DIR` 反推。
 *
 * @returns {string} `.app` 的绝对路径
 */
function resolveApp() {
  if (process.env.DSH_DESKTOP_APP) return process.env.DSH_DESKTOP_APP
  const installDir = process.env.DSH_INSTALL_DIR
  const marker = '/Contents/Resources/app.asar/'
  const index = installDir === undefined ? -1 : installDir.indexOf(marker)
  if (index > 0) return installDir.slice(0, index)
  return DEFAULT_APP
}

/**
 * 给 shell 单引号转义，路径里有空格（`DeepSeek Harness.app`）时 wrapper 才不散架。
 *
 * @param {string} value - 原始参数
 * @returns {string} 可直接拼进 `sh` 脚本的字面量
 */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

if (process.platform !== 'darwin') fail('e2e:desktop 目前只支持 macOS（桌面版是 macOS 应用）')

const app = resolveApp()
const electron = join(app, 'Contents/MacOS/DeepSeek Harness')
const dshBin = join(app, ASAR_DSH)
if (!existsSync(electron)) {
  fail(`找不到桌面版：${electron}；用 DSH_DESKTOP_APP 指定 .app 路径`)
}

const nested = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const probe = spawnCommandSync({ command: electron, args: [dshBin, '--version'], env: nested, encoding: 'utf8' })
if (probe.status !== 0) {
  fail(`桌面版里的 dsh 起不来（exit ${probe.status}）：${probe.stderr || probe.error || ''}`)
}
process.stdout.write(`[e2e] 桌面宿主 ${probe.stdout.trim()}（${app}）\n`)

const wrapper = join(ROOT, '.dev', 'desktop-dsh')
mkdirSync(dirname(wrapper), { recursive: true })
writeFileSync(wrapper, `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(electron)} ${shellQuote(dshBin)} "$@"\n`)
chmodSync(wrapper, 0o755)

const npmCli = process.env.npm_execpath
if (npmCli === undefined) fail('请通过 npm run e2e:desktop 调用（拿不到 npm 的入口路径）')
const child = spawnCommandSync({
  command: process.execPath,
  args: [npmCli, 'run', 'e2e'],
  cwd: ROOT,
  stdio: 'inherit',
  // e2e 只支持 web profile；桌面版会话里注入的 DSH_PROFILE=desktop 必须压掉。
  env: { ...process.env, DEV_DSH: wrapper, DSH_PROFILE: 'web' },
})
process.exit(child.status ?? 1)
