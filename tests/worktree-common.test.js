import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertTaskName, branchFor, classifyWorktree, worktreeDirFor,
} from '../scripts/worktree-common.mjs'

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
