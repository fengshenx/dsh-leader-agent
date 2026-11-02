/**
 * 守住 Windows 上的命令入口：起 `npm` / `dsh` 只能经 `scripts/spawn-command.mjs`。
 *
 * 裸 `spawn('dsh')` / `spawnSync('npm')` 在 win32 上必 ENOENT——npm 装出来的是
 * `.cmd` / `.ps1` / 无扩展名 shim，libuv 只按 `<名>`、`<名>.exe`、`<名>.com` 找。
 * #63 修过一次，PR #71 的重构又退回去过，所以把它固定成静态用例。
 *
 * 判据是 import 语句：没有导入就不可能调用；比扫调用点稳，不会被注释或字符串误报。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 允许直接导入 `spawn` / `spawnSync` 的文件与理由。
 *
 * 分两类：实现本身，以及只起「Windows 上确实有 `.exe`」的命令（node / git / gh）。
 * npm 与 dsh 装出来的是 `.cmd` / `.ps1` / 无扩展名 shim，必须经 spawn-command。
 * 新增条目先确认理由成立，并在理由里写清——这一步就是这道门禁的全部价值。
 */
const ALLOWED = new Map([
  ['scripts/spawn-command.mjs', '实现本身：PATHEXT 解析与 cmd 命令行拼装都在这里'],
  ['scripts/dev.mjs', '只用于起 process.execPath（node 自身，绝对路径）的常驻 watch 子进程'],
  ['scripts/check-syntax.mjs', '只用于起 process.execPath 做 --check'],
  ['scripts/worktree-spawn.mjs', '只用于起 git：Windows 上有 git.exe，不经 shim'],
  ['scripts/worktree-prune.mjs', '只用于起 git / gh：Windows 上都是 .exe，不经 shim'],
])

/** 会被检查的源码：开发脚本与 e2e 夹具（两者都会起 npm / dsh）。 */
function listSources() {
  const scripts = readdirSync(join(ROOT, 'scripts'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join('scripts', name))
  const e2e = readdirSync(join(ROOT, 'tests', 'e2e'))
    .filter((name) => /\.(?:mjs|js)$/.test(name))
    .map((name) => join('tests', 'e2e', name))
  return [...scripts, ...e2e]
}

/**
 * 取一个文件里从 `node:child_process` 命名导入的 `spawn` / `spawnSync` 名字。
 *
 * @param {string} relative - 相对仓库根的路径
 * @returns {string[]} 导入的名字
 */
function bareSpawnImports(relative) {
  const text = readFileSync(join(ROOT, relative), 'utf8')
  const names = []
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name === 'spawn' || name === 'spawnSync') names.push(name)
    }
  }
  return names
}

test('起 npm / dsh 只经 spawn-command.mjs：scripts 与 e2e 夹具不裸导 spawn', () => {
  const offenders = listSources()
    .filter((relative) => !ALLOWED.has(relative) && bareSpawnImports(relative).length > 0)
    .sort()
  assert.deepEqual(
    offenders,
    [],
    `这些文件直接 import 了 spawn / spawnSync，Windows 上会让命令 ENOENT：${offenders.join(', ')}。`
    + '改用 scripts/spawn-command.mjs 的 spawnCommand / spawnCommandSync。',
  )
})

test('允许清单里的文件都还在', () => {
  // 白名单陈旧化会让这道门禁悄悄失效：文件改名后清单条目还在，新文件不再被检查。
  const missing = [...ALLOWED.keys()].filter((relative) => !existsSync(join(ROOT, relative)))
  assert.deepEqual(missing, [], `允许清单里这些文件已经不存在：${missing.join(', ')}`)
})

test('dev.mjs 的裸 spawn 只起 process.execPath', () => {
  // 注释里会提到裸 spawn 的写法（说明为什么不能那么写），按行首排除注释行。
  const calls = readFileSync(join(ROOT, 'scripts/dev.mjs'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/)/.test(line))
    .flatMap((line) => [...line.matchAll(/\b(spawn|spawnSync)\(\s*([^,)]+)/g)]
      .map((match) => `${match[1]}(${match[2].trim()})`))
  assert.deepEqual(
    calls,
    ['spawn(process.execPath)'],
    'dev.mjs 只能用 spawn 起 node 自身；起 dsh / npm 要走 spawnCommand / spawnCommandSync。',
  )
})
