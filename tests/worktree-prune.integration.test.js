import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PRUNE = fileURLToPath(new URL('../scripts/worktree-prune.mjs', import.meta.url))

test('win32 上 prune --apply 先拆 junction，共享依赖不被跟穿', { skip: process.platform !== 'win32' }, (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-worktree-prune-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  const shared = join(base, 'shared', 'node_modules')
  const worktree = join(repo, '.worktrees', 'wt-int')
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

  const result = spawnSync(process.execPath, [PRUNE, 'wt-int', '--apply'], { cwd: repo, encoding: 'utf8' })
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
