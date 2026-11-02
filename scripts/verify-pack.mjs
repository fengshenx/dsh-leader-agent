/**
 * 发布包内容门禁：打包一次（dry-run），拿真实文件清单与 `pack-manifest.mjs` 的
 * 判定规则比对。
 *
 * 为什么必须打真实的包：`files` 白名单只覆盖前缀，dot 目录（`.agents/skills`）的
 * 收录、npm 内置排除、`lib/` 被 `.gitignore` 忽略后的表现，都只能由 npm 自己给出。
 * `tests/skills.test.js` 守的是 `files` 与 `SKILLS_DIR` 的对齐，不是 tarball 本身。
 *
 * 先 `npm run build:client`：`lib/client.js` 不入库，没构建过时本门禁会报缺失——这正是
 * 发布前要拦的状态。命令 `npm run verify:pack`，发版链路见 README 的「发布」一节。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkPackEntries, requiredPackFiles } from './pack-manifest.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * 递归列出目录下的文件。
 * @param {string} dir - 目录绝对路径
 * @param {string} [prefix] - 结果前缀（POSIX 相对路径）
 * @returns {string[]} 包内相对路径
 */
function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return listFiles(join(dir, entry.name), path)
    return [path]
  })
}

/**
 * 打包并取回文件清单。
 * @returns {{entries: string[], unpackedSize: number}} tarball 内的文件路径与未压缩总大小（字节）
 */
function packEntries() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    // Windows 上 npm 是 npm.cmd，不经 shell 解析时 spawnSync 报 ENOENT。
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    console.error('verify-pack: npm pack --dry-run 失败')
    console.error((result.stderr || result.stdout || '').trim())
    process.exit(1)
  }
  // `npm pack` 会跑 prepare/prepack：将来有人加这类脚本并往 stdout 打日志，JSON 就
  // 解析不了。原始 SyntaxError 不会说清是「输出被污染」，所以在这里点出来。
  let packed
  try {
    ;[packed] = JSON.parse(result.stdout)
  } catch (error) {
    console.error(`verify-pack: 解析 npm pack --json 的输出失败（${error.message}）`)
    console.error('输出被其他脚本污染时，先查 package.json 的 prepare / prepack / postpack。stdout 前 200 字符：')
    console.error(result.stdout.slice(0, 200))
    process.exit(1)
  }
  if (!Array.isArray(packed?.files)) {
    console.error('verify-pack: npm pack --json 没有给出文件清单，stdout 前 200 字符：')
    console.error(result.stdout.slice(0, 200))
    process.exit(1)
  }
  return { entries: packed.files.map((file) => file.path), unpackedSize: packed.unpackedSize }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const skillFiles = listFiles(join(root, '.agents', 'skills'), '.agents/skills')
const localeFiles = readdirSync(join(root, 'locale')).filter((name) => name.endsWith('.json'))

const { entries, unpackedSize } = packEntries()
const { missing, forbidden } = checkPackEntries({
  entries,
  required: requiredPackFiles({ manifest, skillFiles, localeFiles }),
})

const problems = [
  ...missing.map((path) => `缺 ${path}${path === 'lib/client.js' ? '（先跑 npm run build:client）' : ''}`),
  ...forbidden.map((path) => `不该进包：${path}`),
]

// 产物在包内不代表能用：空的或没走 closure-factory 外壳的 client 产物会让插件
// 客户端半边整个起不来，而装机时没有任何报错。
const clientEntry = join(root, 'lib', 'client.js')
if (statSync(clientEntry, { throwIfNoEntry: false })?.isFile() === true) {
  const head = readFileSync(clientEntry, 'utf8').slice(0, 200)
  if (!head.includes('window.__ModuleLoader__.load')) {
    problems.push('lib/client.js 不是 closure-factory 产物（缺 __ModuleLoader__.load 外壳），先跑 npm run build:client')
  }
}

if (problems.length === 0) {
  console.log(`verify-pack: ${entries.length} 个文件（未压缩 ${Math.round(unpackedSize / 1024)} kB），必需项齐全、无开发残留`)
  process.exit(0)
}

console.error('verify-pack: 发布包门禁未通过：')
for (const problem of problems) console.error(`  ${problem}`)
process.exit(1)
