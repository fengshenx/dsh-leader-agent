import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GUIDE_DISMISS_PREFIX,
  createGuideDismissal,
  guideDismissKey,
  readLocalStorage,
  sendIntroPrompt,
  shouldShowGuide,
} from '../src/client/guide-card-logic.js'

/**
 * 造一个够用的存储桩。
 * @param {Record<string, string>} [initial] - 初始内容
 * @returns {object} 存储桩与它收到的写入
 */
function createStorage(initial = {}) {
  const entries = new Map(Object.entries(initial))
  const writes = []
  return {
    writes,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value])
      entries.set(key, value)
    },
  }
}

test('关闭标记按 leader 会话 id 分键', () => {
  assert.equal(guideDismissKey('session-1'), `${GUIDE_DISMISS_PREFIX}session-1`)
  assert.notEqual(guideDismissKey('session-1'), guideDismissKey('session-2'))
})

test('触发条件：leader 会话、还没有消息、没关过', () => {
  assert.equal(shouldShowGuide({ isLeader: true, blank: true, dismissed: false }), true)
})

test('缺任一条都不显示', () => {
  assert.equal(shouldShowGuide({ isLeader: false, blank: true, dismissed: false }), false)
  assert.equal(shouldShowGuide({ isLeader: true, blank: false, dismissed: false }), false)
  assert.equal(shouldShowGuide({ isLeader: true, blank: true, dismissed: true }), false)
})

test('名单与快照还没就绪时（undefined）不显示', () => {
  assert.equal(shouldShowGuide({ isLeader: undefined, blank: undefined, dismissed: undefined }), false)
  assert.equal(shouldShowGuide({}), false)
})

test('没关过时读不到标记', () => {
  const storage = createStorage()
  assert.equal(createGuideDismissal(storage).isDismissed('session-1'), false)
})

test('关掉后同一会话读得到，别的会话不受影响', () => {
  const storage = createStorage()
  const dismissal = createGuideDismissal(storage)
  dismissal.dismiss('session-1')
  assert.deepEqual(storage.writes, [[guideDismissKey('session-1'), '1']])
  assert.equal(dismissal.isDismissed('session-1'), true)
  assert.equal(dismissal.isDismissed('session-2'), false)
})

test('会话 id 缺失时不读也不写', () => {
  const storage = createStorage()
  const dismissal = createGuideDismissal(storage)
  assert.equal(dismissal.isDismissed(''), false)
  assert.equal(dismissal.isDismissed(undefined), false)
  dismissal.dismiss('')
  dismissal.dismiss(null)
  assert.deepEqual(storage.writes, [])
})

test('存储缺失时按没关过处理，写入静默丢弃', () => {
  const dismissal = createGuideDismissal(undefined)
  assert.equal(dismissal.isDismissed('session-1'), false)
  dismissal.dismiss('session-1')
})

test('隐私模式下读会抛，按没关过处理', () => {
  const dismissal = createGuideDismissal({
    getItem: () => { throw new Error('SecurityError') },
    setItem: () => {},
  })
  assert.equal(dismissal.isDismissed('session-1'), false)
})

test('隐私模式下写会抛，点击处理不抛异常', () => {
  const dismissal = createGuideDismissal({
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError') },
  })
  assert.doesNotThrow(() => { dismissal.dismiss('session-1') })
})

test('取 localStorage：属性访问抛错时当作没有存储', () => {
  assert.equal(readLocalStorage(undefined), undefined)
  const hostile = Object.defineProperty({}, 'localStorage', {
    get() { throw new Error('SecurityError') },
  })
  assert.equal(readLocalStorage(hostile), undefined)
  const storage = createStorage()
  assert.equal(readLocalStorage({ localStorage: storage }), storage)
})

test('让它自我介绍：填进输入框并当场提交', () => {
  const calls = []
  const actions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  assert.equal(sendIntroPrompt(actions, '介绍一下你自己'), true)
  assert.deepEqual(calls, [['setDraft', '介绍一下你自己'], ['submit']])
})

test('输入机缺失或残缺时不发，也不抛', () => {
  assert.equal(sendIntroPrompt(undefined, '介绍一下你自己'), false)
  assert.equal(sendIntroPrompt({}, '介绍一下你自己'), false)
  assert.equal(sendIntroPrompt({ setDraft: () => {} }, '介绍一下你自己'), false)
  assert.equal(sendIntroPrompt({ submit: () => {} }, '介绍一下你自己'), false)
})
