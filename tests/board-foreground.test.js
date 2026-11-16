import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearBoardForeground,
  lastBoardForegroundSession,
  noteBoardForeground,
} from '../src/client/board-foreground.js'

test('看板前台记录：按会话记，只清自己', () => {
  noteBoardForeground('leader')
  assert.equal(lastBoardForegroundSession(), 'leader')
  clearBoardForeground('worker')
  assert.equal(lastBoardForegroundSession(), 'leader', '清别的会话不能动当前记录')
  clearBoardForeground('leader')
  assert.equal(lastBoardForegroundSession(), undefined)
})

test('看板前台记录：后一次可见覆盖前一次', () => {
  noteBoardForeground('leader')
  noteBoardForeground('worker')
  assert.equal(lastBoardForegroundSession(), 'worker')
})
