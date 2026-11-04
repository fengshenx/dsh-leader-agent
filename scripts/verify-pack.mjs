/**
 * 发布包内容门禁：打一次真实的包，比对文件清单，再装一次、按包入口加载一遍。
 *
 * 为什么必须打真实的包：`files` 白名单只覆盖前缀，dot 目录（`.agents/skills`）的
 * 收录、npm 内置排除、`lib/` 被 `.gitignore` 忽略后的表现，都只能由 npm 自己给出。
 * `tests/skills.test.js` 守的是 `files` 与 `SKILLS_DIR` 的对齐，不是 tarball 本身。
 *
 * 为什么光有清单不够：清单只证明「必需集里的文件在包里」，证明不了「包能加载」。
 * `files` 从 `"src/**"` 收窄成 `["src/host/**"]` 时，入口与 skill 全在、清单检查全绿，
 * 而 `src/host/*` 依赖的 `src/shared/*` 一个都没进包——用户装上后第一次加载就是
 * `ERR_MODULE_NOT_FOUND`。所以最后一步是把 tarball 装进临时目录、按包名 import
 * 全部宿主侧模块。
 *
 * 先 `npm run build:client`：`lib/client.js` 不入库，没构建过时本门禁会报缺失——这正是
 * 发布前要拦的状态。命令 `npm run verify:pack`，发版链路见 README 的「发布」一节。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandNotFoundError, spawnCommandSync } from './spawn-command.mjs'
import { checkPackEntries, requiredPackFiles } from './pack-manifest.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * 装机 smoke 的子进程脚本。在临时目录里按包名加载安装好的包：这一步跑的是用户的
 * 解析路径（`exports` 映射、`main`、相对 import），不是本仓库里的源码。
 *
 * 写成独立文件而不是 `node -e`：裸说明符按 cwd 解析，脚本落在临时安装目录里即可，
 * 不依赖 eval 的基准 URL 细节，失败时的 stack 也带真实文件名。
 */
const SMOKE_SCRIPT = `
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = __PACKAGE_NAME__
const problems = []

const require = createRequire(join(process.cwd(), 'package.json'))
const pkgRoot = dirname(require.resolve(PKG + '/package.json'))

function listJs(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + '/' + entry.name
    if (entry.isDirectory()) return listJs(join(dir, entry.name), path)
    return entry.name.endsWith('.js') ? [path] : []
  })
}

try {
  const mod = await import(PKG)
  for (const key of ['name', 'inject', 'apply']) {
    if (!(key in mod)) problems.push('包入口缺导出 ' + key)
  }
  await import(PKG + '/src/host')
} catch (error) {
  problems.push('按包入口加载失败：' + (error && error.message))
}

// 逐文件加载：清单只能证明必需集在包里，传递依赖（src/shared/*、将来新增的
// 兄弟目录）漏进不了必需集，只有真加载才变成 ERR_MODULE_NOT_FOUND。
for (const dir of ['src/host', 'src/shared']) {
  const abs = join(pkgRoot, dir)
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) {
    problems.push('包里没有 ' + dir + '/（files 白名单没覆盖它）')
    continue
  }
  for (const rel of listJs(abs, dir)) {
    try {
      await import(pathToFileURL(join(pkgRoot, rel)).href)
    } catch (error) {
      problems.push('加载 ' + rel + ' 失败：' + (error && error.message))
    }
  }
}

const installed = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const patch = installed.dsh.bundle.patch
if (statSync(join(pkgRoot, patch), { throwIfNoEntry: false })?.isFile() !== true) {
  problems.push('dsh.bundle.patch 指向的文件不在包里：' + patch)
}

const clientEntry = join(pkgRoot, 'lib', 'client.js')
if (statSync(clientEntry, { throwIfNoEntry: false })?.isFile() !== true) {
  problems.push('包里没有 lib/client.js（先跑 npm run build:client）')
} else if (!readFileSync(clientEntry, 'utf8').slice(0, 200).includes('window.__ModuleLoader__.load')) {
  problems.push('包里的 lib/client.js 不是 closure-factory 产物（缺 __ModuleLoader__.load 外壳），先跑 npm run build:client')
}

if (problems.length > 0) {
  for (const problem of problems) console.error('smoke: ' + problem)
  process.exit(1)
}
`

/**
 * 去掉继承来的 npm 配置环境变量。
 *
 * npm 把自己的解析结果导出成 `npm_config_*` 给 lifecycle 脚本，`prepublishOnly` 起的
 * 这一层因此会带上外层命令的开关：`npm publish --dry-run` 下内层 `npm pack` 也进
 * dry-run，不落 tarball，装机 smoke 随即 ENOENT。门禁要按自己的参数打包与安装，
 * 不继承调用方的开关。
 *
 * @returns {object} 供子进程使用的环境变量
 */
function npmEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_config_')),
  )
}

/**
 * 跑一条 npm 命令，失败时打印输出并结束进程。
 * @param {string[]} args - npm 参数
 * @param {string} cwd - 工作目录
 * @param {string} label - 报错时的人话前缀
 * @returns {string} stdout
 */
function runNpm(args, cwd, label) {
  let result
  try {
    // Windows 上 npm 是 shim（npm.cmd），直接 spawnSync('npm') 报 ENOENT。
    result = spawnCommandSync({ command: 'npm', args, cwd, encoding: 'utf8', env: npmEnv() })
  } catch (error) {
    if (!(error instanceof CommandNotFoundError)) throw error
    console.error(`verify-pack: ${label}失败：${error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`verify-pack: ${label}失败`)
    console.error((result.stderr || result.stdout || '').trim())
    process.exit(1)
  }
  return result.stdout
}

/**
 * 打一次真实的包，取回 tarball 与文件清单。
 * @param {string} destination - tarball 落盘目录
 * @returns {{entries: string[], unpackedSize: number, tarball: string}} 文件清单、未压缩总大小与 tarball 路径
 */
function packTarball(destination) {
  // `npm pack` 会跑 prepare/prepack：将来有人加这类脚本并往 stdout 打日志，JSON 就
  // 解析不了。原始 SyntaxError 不会说清是「输出被污染」，所以在这里点出来。
  const stdout = runNpm(['pack', '--json', '--pack-destination', destination], root, 'npm pack 执行')
  let packed
  try {
    ;[packed] = JSON.parse(stdout)
  } catch (error) {
    console.error(`verify-pack: 解析 npm pack --json 的输出失败（${error.message}）`)
    console.error('输出被其他脚本污染时，先查 package.json 的 prepare / prepack / postpack。stdout 前 200 字符：')
    console.error(stdout.slice(0, 200))
    process.exit(1)
  }
  if (!Array.isArray(packed?.files) || typeof packed.filename !== 'string') {
    console.error('verify-pack: npm pack --json 没有给出文件清单或文件名，stdout 前 200 字符：')
    console.error(stdout.slice(0, 200))
    process.exit(1)
  }
  return {
    entries: packed.files.map((file) => file.path),
    unpackedSize: packed.unpackedSize,
    tarball: join(destination, packed.filename),
  }
}

/**
 * 把 tarball 装进干净的临时目录并加载一遍。
 *
 * 零运行时依赖，所以这一步不需要 registry：装的是本地 tarball，装出来的
 * `node_modules` 只有本包。
 *
 * @param {string} tarball - tarball 绝对路径
 * @param {string} name - 包名
 * @param {string} dir - 临时目录
 * @returns {void} 门禁不通过时打印原因并结束进程
 */
function installSmoke(tarball, name, dir) {
  const installDir = join(dir, 'install')
  mkdirSync(installDir)
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'pack-smoke', version: '0.0.0', private: true }, null, 2))

  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', tarball], installDir, '装机（npm install）')

  const scriptPath = join(installDir, '__pack-smoke__.mjs')
  writeFileSync(scriptPath, SMOKE_SCRIPT.replace('__PACKAGE_NAME__', JSON.stringify(name)))
  const result = spawnCommandSync({ command: process.execPath, args: [scriptPath], cwd: installDir, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error('verify-pack: 装机 smoke 未通过（装好的包里缺可用性）：')
    console.error((result.stderr || result.stdout || '').trim())
    process.exit(1)
  }
}

/**
 * 递归列出目录下的文件。
 * @param {string} dir - 目录绝对路径
 * @param {string} [prefix] - 结果前缀（POSIX 相对路径）
 * @returns {string[]} 包内相对路径
 */
function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // 开发机残留（.DS_Store）不排除的话，必需集会要求它进包，而黑名单又拦它。
    if (entry.name.startsWith('.')) return []
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return listFiles(join(dir, entry.name), path)
    return [path]
  })
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const skillFiles = listFiles(join(root, '.agents', 'skills'), '.agents/skills')
const localeFiles = readdirSync(join(root, 'locale')).filter((name) => name.endsWith('.json'))

const tempDir = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-pack-'))
// 门禁失败走 process.exit（会跳过 finally），清理挂在 exit 上：装好的临时目录
// 有几十 MB，失败路径更不能留。
process.once('exit', () => rmSync(tempDir, { recursive: true, force: true }))

const { entries, unpackedSize, tarball } = packTarball(tempDir)
const { missing, forbidden } = checkPackEntries({
  entries,
  required: requiredPackFiles({ manifest, skillFiles, localeFiles }),
})

const problems = [
  ...missing.map((path) => `缺 ${path}${path === 'lib/client.js' ? '（先跑 npm run build:client）' : ''}`),
  ...forbidden.map((path) => `不该进包：${path}`),
]

if (problems.length > 0) {
  console.error('verify-pack: 发布包门禁未通过：')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

installSmoke(tarball, manifest.name, tempDir)
const size = typeof unpackedSize === 'number' ? `（未压缩 ${Math.round(unpackedSize / 1024)} kB）` : ''
console.log(`verify-pack: ${entries.length} 个文件${size}，必需项齐全、无开发残留，装机 smoke 通过`)
