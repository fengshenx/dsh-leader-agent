import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertTaskName, branchFor, classifyNodeModulesLink, classifyWorktree, teardownWorktree, worktreeDirFor,
} from '../scripts/worktree-common.mjs'

/** lstat 结果的最小假件：只回答是不是链接。 */
const linkStats = (isLink) => ({ isSymbolicLink: () => isLink })

test('合法任务名通过校验', () => {
  for (const name of ['dev-script', 'p14-fix', 'a', 'task_1', 'v1.2']) {
    assert.doesNotThrow(() => assertTaskName(name))
  }
})

test('路径穿越与分隔符一律拒绝', () => {
  for (const name of ['../escape', 'a/b', 'a\\b', '/abs', '.hidden', 'a b', '']) {
    assert.throws(() => assertTaskName(name))
  }
})

test('分支名与目录按约定派生', () => {
  assert.equal(branchFor('dev-script'), 'feature/dev-script')
  assert.equal(worktreeDirFor('/repo', 'dev-script'), join('/repo', '.worktrees', 'dev-script'))
})

test('未提交的改动挡在最前面，比"已合并"优先级高', () => {
  const verdict = classifyWorktree({
    isCurrent: false, dirty: true, mergedIntoMain: true, pullRequest: { state: 'MERGED', number: 1, url: '' },
  })
  assert.equal(verdict.removable, false)
  assert.match(verdict.reason, /未提交/)
})

test('当前所在的 worktree 不删', () => {
  const verdict = classifyWorktree({
    isCurrent: true, dirty: false, mergedIntoMain: true, pullRequest: { state: 'MERGED', number: 1, url: '' },
  })
  assert.equal(verdict.removable, false)
  assert.match(verdict.reason, /cd/)
})

test('分支已进 main 时不必看 PR', () => {
  const verdict = classifyWorktree({
    isCurrent: false, dirty: false, mergedIntoMain: true, pullRequest: undefined,
  })
  assert.equal(verdict.removable, true)
  assert.match(verdict.reason, /main/)
})

test('squash 合并后只能靠 PR 状态判', () => {
  const verdict = classifyWorktree({
    isCurrent: false, dirty: false, mergedIntoMain: false, pullRequest: { state: 'MERGED', number: 14, url: '' },
  })
  assert.equal(verdict.removable, true)
  assert.match(verdict.reason, /#14/)
})

test('PR 还开着、已关闭未合并、没有 PR、查不到状态都不删', () => {
  const base = { isCurrent: false, dirty: false, mergedIntoMain: false }
  assert.equal(classifyWorktree({ ...base, pullRequest: { state: 'OPEN', number: 13, url: '' } }).removable, false)
  assert.equal(classifyWorktree({ ...base, pullRequest: { state: 'CLOSED', number: 12, url: '' } }).removable, false)
  assert.equal(classifyWorktree({ ...base, pullRequest: null }).removable, false)
  assert.equal(classifyWorktree({ ...base, pullRequest: undefined }).removable, false)
})

test('既有未提交改动又是当前所在的，理由先说未提交改动', () => {
  const verdict = classifyWorktree({
    isCurrent: true, dirty: true, mergedIntoMain: true, pullRequest: { state: 'MERGED', number: 11, url: '' },
  })
  assert.equal(verdict.removable, false)
  assert.equal(verdict.reason, '有未提交的改动')
})

test('node_modules 不存在时不拆链接', () => {
  const action = classifyNodeModulesLink({ stats: null, platform: 'win32' })
  assert.equal(action.detach, false)
  assert.equal(action.method, null)
})

test('node_modules 是真实目录时不拆，绝不删别人的依赖', () => {
  const action = classifyNodeModulesLink({ stats: linkStats(false), platform: 'win32' })
  assert.equal(action.detach, false)
  assert.equal(action.method, null)
  assert.match(action.reason, /真实目录/)
})

test('win32 的 junction 用 rmdir 拆', () => {
  const action = classifyNodeModulesLink({ stats: linkStats(true), platform: 'win32' })
  assert.equal(action.detach, true)
  assert.equal(action.method, 'rmdir')
})

test('POSIX 的符号链接用 unlink 拆', () => {
  const action = classifyNodeModulesLink({ stats: linkStats(true), platform: 'linux' })
  assert.equal(action.detach, true)
  assert.equal(action.method, 'unlink')
})

test('先拆 node_modules 链接再执行删除', () => {
  const calls = []
  const dir = join('/repo', '.worktrees', 'task-a')
  const result = teardownWorktree({
    dir,
    platform: 'win32',
    stat: () => linkStats(true),
    detach: (path, method) => calls.push({ step: 'detach', path, method }),
    remove: () => {
      calls.push({ step: 'remove' })
      return { status: 0 }
    },
  })
  assert.deepEqual(calls, [
    { step: 'detach', path: join(dir, 'node_modules'), method: 'rmdir' },
    { step: 'remove' },
  ])
  assert.deepEqual(result, { status: 0 })
})

test('真实 node_modules 直接删除，不调拆链接', () => {
  let detached = false
  let removed = false
  teardownWorktree({
    dir: join('/repo', '.worktrees', 'task-b'),
    platform: 'win32',
    stat: () => linkStats(false),
    detach: () => { detached = true },
    remove: () => { removed = true },
  })
  assert.equal(detached, false)
  assert.equal(removed, true)
})

test('拆链接失败时不再执行删除，避免 git 跟穿链接', () => {
  let removed = false
  assert.throws(() => teardownWorktree({
    dir: join('/repo', '.worktrees', 'task-c'),
    platform: 'win32',
    stat: () => linkStats(true),
    detach: () => { throw new Error('EPERM: operation not permitted') },
    remove: () => { removed = true },
  }), /EPERM/)
  assert.equal(removed, false)
})
