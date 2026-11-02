import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PRUNE = fileURLToPath(new URL('../scripts/worktree-prune.mjs', import.meta.url))
const WIN32 = { skip: process.platform !== 'win32' }

/**
 * 造一个临时仓库：main 上一条已合并的分支 worktree，根部与 `.dev` 里各有一个
 * 指向共享 node_modules 的 junction。
 *
 * @param {import('node:test').TestContext} t - 用例上下文，负责清理临时目录
 * @returns {{ repo: string, shared: string, worktree: string, stash: string }} 路径
 */
function makeFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-worktree-prune-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  const shared = join(base, 'shared', 'node_modules')
  const worktree = join(repo, '.worktrees', 'wt-int')
  const stash = join(repo, '.worktrees', '.dev-stash-wt-int')
  mkdirSync(join(shared, 'esbuild'), { recursive: true })
  writeFileSync(join(shared, 'esbuild', 'marker.txt'), 'marker')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.dev/\n.worktrees/\n')
  writeFileSync(join(repo, 'a.txt'), 'a')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  mkdirSync(join(repo, '.worktrees'), { recursive: true })
  execFileSync('git', ['worktree', 'add', worktree, '-b', 'feature/int'], { cwd: repo })
  symlinkSync(shared, join(worktree, 'node_modules'), 'junction')
  mkdirSync(join(worktree, '.dev', 'home', 'profiles', 'web', 'node_modules'), { recursive: true })
  writeFileSync(join(worktree, '.dev', 'home', 'session.json'), '{}')
  symlinkSync(shared, join(worktree, '.dev', 'home', 'profiles', 'web', 'node_modules', 'esbuild'), 'junction')
  return { repo, shared, worktree, stash }
}

/**
 * @param {string} repo - 临时仓库
 * @returns {import('node:child_process').SpawnSyncReturns<string>} prune 结果
 */
function runPrune(repo) {
  return spawnSync(process.execPath, [PRUNE, 'wt-int', '--apply'], { cwd: repo, encoding: 'utf8' })
}

test('win32 上 prune --apply 先拆 junction，共享依赖不被跟穿', WIN32, (t) => {
  const { repo, shared, worktree } = makeFixture(t)
  const result = runPrune(repo)
  assert.equal(result.status, 0, `prune 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[已删\] wt-int/)
  assert.equal(existsSync(join(shared, 'esbuild', 'marker.txt')), true, '共享依赖被 git 跟穿删除')
  assert.equal(existsSync(worktree), false, 'worktree 目录没有删掉')
  assert.deepEqual(
    readdirSync(join(repo, '.worktrees')).filter((name) => name.startsWith('.dev-stash-')),
    [],
    '.dev 暂存目录没有清掉',
  )
})

test('win32 上别的 prune 持锁时直接退出，不碰 worktree', WIN32, (t) => {
  const { repo, shared, worktree } = makeFixture(t)
  const lock = join(repo, '.worktrees', '.prune.lock')
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'test-holder', startedAt: Date.now() }))
  const result = runPrune(repo)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1, `持锁时没有退出:\n${output}`)
  assert.match(output, /另一个 prune 正在运行/)
  assert.equal(existsSync(worktree), true, '持锁时仍然动了 worktree')
  assert.equal(readlinkSync(join(worktree, 'node_modules')), shared, '持锁时拆了链接')
  assert.equal(existsSync(join(shared, 'esbuild', 'marker.txt')), true, '持锁时删了共享依赖')
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'test-holder')
})

test('win32 上回收 stale 锁后继续', WIN32, (t) => {
  const { repo, shared, worktree } = makeFixture(t)
  const lock = join(repo, '.worktrees', '.prune.lock')
  writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'stale', startedAt: Date.now() - 60 * 60 * 1000 }))
  const result = runPrune(repo)
  assert.equal(result.status, 0, `回收 stale 锁失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[已删\] wt-int/)
  assert.equal(existsSync(worktree), false, 'worktree 没有删掉')
  assert.equal(existsSync(lock), false, 'stale 锁没有清掉')
  assert.equal(existsSync(join(shared, 'esbuild', 'marker.txt')), true, '共享依赖被跟穿删除')
})

test('win32 上 prune --apply 接管手动留下的 .dev 暂存', WIN32, (t) => {
  const { repo, shared, worktree, stash } = makeFixture(t)
  renameSync(join(worktree, '.dev'), stash)
  const result = runPrune(repo)
  assert.equal(result.status, 0, `prune 失败:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[已删\] wt-int/)
  assert.equal(existsSync(join(shared, 'esbuild', 'marker.txt')), true, '共享依赖被 git 跟穿删除')
  assert.equal(existsSync(worktree), false, 'worktree 目录没有删掉')
  assert.equal(existsSync(stash), false, '.dev 暂存没有清掉')
})

test('win32 上 remove 失败时按原 target 恢复链接', WIN32, (t) => {
  const { repo, shared, worktree } = makeFixture(t)
  execFileSync('git', ['worktree', 'lock', worktree], { cwd: repo })
  const result = runPrune(repo)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 0, `prune 异常退出:\n${output}`)
  assert.match(output, /git worktree remove 失败/)
  assert.match(output, /node_modules 链接已恢复/)
  assert.equal(existsSync(worktree), true, '失败的 worktree 没有被保留')
  assert.equal(readlinkSync(join(worktree, 'node_modules')), shared, '链接 target 被改写')
  assert.equal(existsSync(join(worktree, '.dev', 'home', 'session.json')), true, '.dev 没有挪回')
  assert.equal(existsSync(join(shared, 'esbuild', 'marker.txt')), true, '共享依赖被跟穿删除')
  assert.equal(existsSync(join(repo, '.worktrees', '.dev-stash-wt-int')), false, '暂存没有清掉')
  assert.equal(existsSync(join(repo, '.worktrees', '.prune.lock')), false, 'prune 锁没有释放')
})

test('win32 上 .dev 与暂存同时存在时拒绝且两边都在', WIN32, (t) => {
  const { repo, shared, worktree, stash } = makeFixture(t)
  mkdirSync(join(stash, 'home'), { recursive: true })
  writeFileSync(join(stash, 'home', 'stash.json'), '{}')
  const result = runPrune(repo)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 0, `prune 异常退出:\n${output}`)
  assert.match(output, /\[失败\] wt-int/)
  assert.match(output, /同时存在/)
  assert.equal(existsSync(join(worktree, '.dev', 'home', 'session.json')), true, '.dev 被删了')
  assert.equal(existsSync(join(stash, 'home', 'stash.json')), true, '暂存被删了')
  assert.equal(lstatSync(join(worktree, 'node_modules')).isSymbolicLink(), true, 'worktree 的链接被拆了')
  assert.equal(existsSync(join(shared, 'esbuild', 'marker.txt')), true, '共享依赖被跟穿删除')
})
