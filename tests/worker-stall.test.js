import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STALL_THRESHOLD_MS,
  STALL_TICK_MS,
  buildStallNoticeText,
  createStallWatch,
  formatElapsed,
  isStalled,
  stallBaseline,
} from '../src/host/worker-stall.js'

/**
 * 等待条件成立。
 * @param {() => boolean} predicate - 条件
 * @param {number} [timeoutMs] - 超时毫秒
 * @returns {Promise<boolean>} 条件是否成立
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return predicate()
}

test('时长文案按秒/分钟/小时分档，读不出时间也不崩', () => {
  assert.equal(formatElapsed(0), '0 秒')
  assert.equal(formatElapsed(30_000), '30 秒')
  assert.equal(formatElapsed(59_499), '59 秒')
  assert.equal(formatElapsed(60_000), '1 分钟')
  assert.equal(formatElapsed(15 * 60_000), '15 分钟')
  // 分钟向下取整：14 分 59 秒不能读成「15 分钟」，那看起来已经到阈值了。
  assert.equal(formatElapsed(14 * 60_000 + 59_000), '14 分钟')
  assert.equal(formatElapsed(60 * 60_000), '1 小时')
  assert.equal(formatElapsed(61 * 60_000), '1 小时 1 分钟')
  assert.equal(formatElapsed(Number.NaN), '0 秒')
  assert.equal(formatElapsed(-5000), '0 秒')
})

test('判定基线取本轮起点、最后回报、上次提醒三者最大', () => {
  assert.equal(stallBaseline({ runStartedAt: 300, lastReportAt: 200, lastAlertAt: 100 }), 300)
  assert.equal(stallBaseline({ runStartedAt: 100, lastReportAt: 300, lastAlertAt: 200 }), 300)
  assert.equal(stallBaseline({ runStartedAt: 100, lastReportAt: 200, lastAlertAt: 300 }), 300)
  // 没轮次信息时退回最后回报：冷恢复后内存里没有本轮起点。
  assert.equal(stallBaseline({ lastReportAt: 42 }), 42)
  assert.equal(stallBaseline({}), 0)
})

test('阈值边界：差一毫秒不算，到点算', () => {
  const baseline = 1_000
  assert.equal(isStalled({ baseline, now: baseline + STALL_THRESHOLD_MS - 1 }), false)
  assert.equal(isStalled({ baseline, now: baseline + STALL_THRESHOLD_MS }), true)
  assert.equal(STALL_TICK_MS < STALL_THRESHOLD_MS, true)
})

test('提醒正文是自包含纯文本：前缀、sessionId、卡、回看调用与「提醒不是中止」', () => {
  const now = 10_000_000
  const text = buildStallNoticeText({
    name: '实现派工',
    childId: 'child-1',
    elapsedMs: 22 * 60_000,
    lastReportAt: now - 3 * 60_000,
    runStartedAt: now - 22 * 60_000,
    now,
    cards: [{ number: 7, title: '修 auth 超时', slot: 'dev' }],
  })
  assert.match(text, /^【后台巡查】例行检查：worker「实现派工」已连续 22 分钟没有回报。这不一定是卡住，也不代表任务失败；这是提醒，不是中止。/)
  assert.match(text, /子会话 sessionId：child-1/)
  assert.match(text, /#7 修 auth 超时（槽位 dev）/)
  assert.match(text, /最后回报：3 分钟前/)
  assert.match(text, /read_worker_session\(\{ sessionId: "child-1", turns: 3 \}\)/)
  assert.match(text, /先查明再决定继续等待或停止/)
  assert.match(text, /没有中止 worker 的手段/)
})

test('上一轮的回报不算本轮的：复用 worker 时写「本轮还没有回报」', () => {
  const now = 10_000_000
  const text = buildStallNoticeText({
    name: '复用派工',
    childId: 'child-3',
    elapsedMs: 15 * 60_000,
    // 复用的 session 带着上一轮的回报开新轮：9 小时 6 分钟前结算，本轮 15 分钟前才开跑。
    lastReportAt: now - (9 * 60 + 6) * 60_000,
    runStartedAt: now - 15 * 60_000,
    now,
  })
  assert.match(text, /最后回报：本轮还没有回报（上一次回报在 9 小时 6 分钟前）/)
  assert.doesNotMatch(text, /最后回报：9 小时 6 分钟前/)
})

test('最后回报恰好等于本轮起点算本轮：只有严格早于才跨轮', () => {
  const now = 10_000_000
  const runStartedAt = now - 15 * 60_000
  const text = buildStallNoticeText({
    name: '同毫秒派工',
    childId: 'child-4',
    elapsedMs: 15 * 60_000,
    // 上一轮 turn/end 与新一轮派工落在同一毫秒：相等不构成「早于」。
    lastReportAt: runStartedAt,
    runStartedAt,
    now,
  })
  assert.match(text, /最后回报：15 分钟前/)
  assert.doesNotMatch(text, /本轮还没有回报/)
})

test('没有挂卡、没有回报过时如实写「无记录」，不编造轮次', () => {
  const now = 5_000_000
  const text = buildStallNoticeText({
    name: '调研',
    childId: 'child-2',
    elapsedMs: 15 * 60_000,
    runStartedAt: now - 15 * 60_000,
    now,
  })
  assert.doesNotMatch(text, /挂着的卡/)
  assert.match(text, /最后回报：无记录（这一轮还没有结束过）/)
})

test('单节拍按阈值注入，提醒后从不提醒时刻重新起算 15 分钟', async () => {
  const alerts = []
  /** @type {number | undefined} */
  let lastAlertAt
  const watch = createStallWatch({
    listRunning: async () => [{
      sessionId: 'child-1',
      name: '实现派工',
      runStartedAt: 1_000,
      lastReportAt: 500,
      lastAlertAt,
    }],
    alert: async (item) => {
      alerts.push(item)
      lastAlertAt = item.now
      return true
    },
    logger: () => {},
  })
  const start = 1_000
  const threshold = STALL_THRESHOLD_MS
  try {
    assert.equal(await watch.scan(start + threshold - 1), 0)
    assert.equal(alerts.length, 0)

    assert.equal(await watch.scan(start + threshold), 1)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].elapsedMs, threshold)
    assert.equal(alerts[0].baseline, start)

    // 提醒后 15 分钟内不再打扰。
    assert.equal(await watch.scan(start + 2 * threshold - 1), 0)
    assert.equal(await watch.scan(start + 2 * threshold), 1)
    assert.equal(alerts.length, 2)
    assert.equal(alerts[1].baseline, start + threshold)
  } finally {
    watch.dispose()
  }
})

test('已有提醒在队列里未消费时 alert 返回 false，不计入注入数', async () => {
  const watch = createStallWatch({
    listRunning: async () => [{ sessionId: 'child-1', runStartedAt: 0 }],
    alert: async () => false,
    logger: () => {},
  })
  try {
    assert.equal(await watch.scan(STALL_THRESHOLD_MS), 0)
  } finally {
    watch.dispose()
  }
})

test('单个 worker 的提醒失败只记日志，其余 worker 照常注入', async () => {
  const logs = []
  const seen = []
  const watch = createStallWatch({
    listRunning: async () => [
      { sessionId: 'bad', runStartedAt: 0 },
      { sessionId: 'good', runStartedAt: 0 },
    ],
    alert: async (item) => {
      if (item.sessionId === 'bad') throw new Error('卡片读不出来')
      seen.push(item.sessionId)
      return true
    },
    logger: (message) => logs.push(message),
  })
  try {
    assert.equal(await watch.scan(STALL_THRESHOLD_MS), 1)
    assert.deepEqual(seen, ['good'])
    assert.match(logs[0], /worker bad 的巡查提醒注入失败：卡片读不出来/)
  } finally {
    watch.dispose()
  }
})

test('定时器按节拍扫描，dispose 后不再扫', async () => {
  let calls = 0
  const watch = createStallWatch({
    tickMs: 5,
    thresholdMs: 0,
    listRunning: async () => [{ sessionId: 'child-1', runStartedAt: 0 }],
    alert: async () => {
      calls += 1
      return true
    },
    logger: () => {},
  })
  assert.equal(await waitFor(() => calls >= 1), true)
  watch.dispose()
  const frozen = calls
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, frozen)
})

test('漏传 listRunning 或 alert 时装配即报错', () => {
  assert.throws(
    () => createStallWatch({ alert: async () => true }),
    /需要 listRunning 与 alert/,
  )
  assert.throws(
    () => createStallWatch({ listRunning: async () => [] }),
    /需要 listRunning 与 alert/,
  )
})

test('节拍的采样失败由日志兜住，不被当成未处理拒绝', async () => {
  const logs = []
  const watch = createStallWatch({
    tickMs: 5,
    thresholdMs: 0,
    listRunning: async () => {
      throw new Error('登记表损坏')
    },
    alert: async () => true,
    logger: (message) => logs.push(message),
  })
  try {
    assert.equal(await waitFor(() => logs.length >= 1), true)
    assert.match(logs[0], /巡查节拍失败：登记表损坏/)
  } finally {
    watch.dispose()
  }
})
