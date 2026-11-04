import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  GUIDE_DISMISS_PREFIX,
  canSendIntro,
  createGuideDismissal,
  guideDismissKey,
  readLocalStorage,
  sendIntroPrompt,
  shouldShowGuide,
} from '../src/client/guide-card-logic.js'
import { en, zh } from '../src/client/locales.js'

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

test('了解怎么用：填进输入框并当场提交', () => {
  const calls = []
  const actions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  assert.equal(sendIntroPrompt(actions, '了解怎么用'), true)
  assert.deepEqual(calls, [['setDraft', '了解怎么用'], ['submit']])
})

test('开场正文只发一句触发语，作答要求交给运行时上下文', () => {
  // 引导卡发的是用户消息，会显示在对话里：保持一句话，长约束（怎么解释、
  // 确认前不写文件、空目录写骨架）放在 leader 上下文注入里，见
  // `renderInitializationHint`。
  for (const dict of [zh, en]) {
    assert.match(dict['guide.intro.prompt'], /dsh-leader-agent/)
    assert.doesNotMatch(dict['guide.intro.prompt'], /LEADER\.md/)
    assert.ok(dict['guide.intro.prompt'].length < 80, '引导语应是一句话')
  }
})

test('只给 submit 缺 setDraft：判定不发，按钮层也不渲染', () => {
  const submitOnly = { submit: () => {} }
  assert.equal(canSendIntro(submitOnly), false)
  assert.equal(sendIntroPrompt(submitOnly, '了解怎么用'), false)
})

test('只给 setDraft 缺 submit：同样判定不发', () => {
  const draftOnly = { setDraft: () => {} }
  assert.equal(canSendIntro(draftOnly), false)
  assert.equal(sendIntroPrompt(draftOnly, '了解怎么用'), false)
})

test('两个动作都在：判定通过，且真的发出', () => {
  const calls = []
  const both = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  assert.equal(canSendIntro(both), true)
  assert.equal(sendIntroPrompt(both, '了解怎么用'), true)
  assert.deepEqual(calls, [['setDraft', '了解怎么用'], ['submit']])
})

test('渲染守卫与发送路径共用同一个判定：只查一半就会画出假按钮', () => {
  const source = readFileSync(new URL('../src/client/guide-card.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /canSendIntro\(inputActions\) === false \? null : createElement\(Button/,
    '渲染守卫必须调 canSendIntro，而不是自己再判一次',
  )
  assert.doesNotMatch(
    source,
    /typeof inputActions\?\.submit !== 'function' \? null/,
    '只查 submit 的守卫会在缺 setDraft 时画出点了没反应的按钮',
  )
})

test('输入机整个缺失时判定为假', () => {
  assert.equal(canSendIntro(undefined), false)
  assert.equal(canSendIntro({}), false)
  assert.equal(sendIntroPrompt(undefined, '了解怎么用'), false)
})
