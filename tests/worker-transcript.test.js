import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldTurns, renderTranscript } from '../src/host/worker-transcript.js'
import { WORKER_TASK_SOURCE_KIND } from '../src/host/message.js'

/**
 * 造一条会话事件。
 *
 * 字段照宿主 `SessionEvent`（`{ type, seq, time, data }`）；本模块只读 `type` /
 * `time` / `data`，其余给个稳定值即可。
 *
 * @param {string} type - 事件类型
 * @param {object} data - 事件 data
 * @param {number} [time] - 时间戳
 * @returns {object} 事件
 */
function event(type, data, time = 0) {
  return { type, seq: 0, time, data }
}

/**
 * 造一条真人输入的消息事件。
 *
 * 三种生产者的 `user/message` 只靠 `source.kind` 区分：`user` 是真人输入，
 * `dsh-leader-agent/worker-task` 是 leader 投递的任务，其余是宿主注入的上下文。
 *
 * @param {string} text - 正文
 * @returns {object} 事件
 */
function user(text) {
  return event('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * 造一条 leader 投递的任务消息事件。
 * @param {string} text - 正文
 * @returns {object} 事件
 */
function task(text) {
  return event('user/message', { content: [{ type: 'text', text }], source: { kind: WORKER_TASK_SOURCE_KIND } })
}

/**
 * 造一条宿主注入的上下文消息事件（换目录、plan 模式、hooks 等）。
 * @param {string} [text] - 正文
 * @returns {object} 事件
 */
function injected(text = '工作目录已切换到 /repo') {
  return event('user/message', { content: [{ type: 'text', text }], source: { kind: 'working-directory' } })
}

/**
 * 找正文里的孤立代理项。
 * @param {string} text - 待检查文本
 * @returns {number | undefined} 首个孤立代理的下标；没有则 undefined
 */
function loneSurrogateAt(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return index
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return index
    }
  }
  return undefined
}

/**
 * 造一条助手消息事件。
 * @param {string} text - 正文
 * @returns {object} 事件
 */
function assistant(text) {
  return event('assistant/message', { message: { content: [{ type: 'text', text }] } })
}

test('按 turn/start 与 turn/end 切成回合，正文与工具调用各归其位', () => {
  const { turns, running } = foldTurns([
    event('turn/start', { turn: 1 }, 100),
    task('把登录页的文案改掉'),
    assistant('先看一下现有实现。'),
    event('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }),
    event('tool/result', { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] } }),
    event('step/end', { turn: 1, step: 1 }),
    assistant('改完了，三个文件。'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  assert.equal(running, false)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].turn, 1)
  assert.equal(turns[0].startedAt, 100)
  assert.deepEqual(turns[0].task, ['把登录页的文案改掉'])
  assert.deepEqual(turns[0].assistant, ['先看一下现有实现。', '改完了，三个文件。'])
  assert.deepEqual(turns[0].tools.map((tool) => tool.name), ['read'])
  assert.equal(turns[0].tools[0].failed, false)
  assert.deepEqual(turns[0].end, { kind: 'completed', error: undefined })
})

test('失败的工具调用带出用户可见原因', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 2 }),
    event('tool/call', { callId: 'c9', name: 'bash', arguments: '{"command":"npm test"}' }),
    event('tool/result', {
      message: { toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'exit 1' }] },
      error: { name: 'ToolError', code: 'EXIT', reason: '测试失败：2 例红' },
    }),
    event('turn/end', { turn: 2, reason: { kind: 'failed' } }),
  ])
  assert.equal(turns[0].tools[0].failed, true)
  assert.equal(turns[0].tools[0].reason, '测试失败：2 例红')
})

test('失败原因缺失时退回工具结果正文，仍然标出失败', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    event('tool/call', { callId: 'c1', name: 'write', arguments: '{}' }),
    event('tool/result', { message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'EACCES' }] } }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  assert.equal(turns[0].tools[0].reason, 'EACCES')
})

test('没有配对的 tool/result 也不丢（宿主在工具恢复路径上会补写结果事件）', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    event('tool/result', { message: { toolCallId: 'ghost', isError: true, content: [{ type: 'text', text: '中断' }] } }),
    event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
  ])
  assert.equal(turns[0].tools.length, 1)
  assert.equal(turns[0].tools[0].name, 'unknown')
  assert.equal(turns[0].tools[0].failed, true)
  assert.equal(turns[0].tools[0].reason, '中断')
})

test('最后一轮没有 turn/end 时标成进行中', () => {
  const { turns, running } = foldTurns([
    event('turn/start', { turn: 1 }),
    user('第一轮'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', { turn: 2 }),
    user('第二轮'),
    assistant('还在跑'),
  ])
  assert.equal(running, true)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].end, undefined)
})

test('turn/end 之后的消息另起一段，不会并进已收尾的回合', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    task('第一轮'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    user('人在会话里补的一句话'),
  ])
  // 人下钻聊的轮次没有 turn/start：按「未标号回合」保留，不污染上一轮。
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0].task, ['第一轮'])
  assert.deepEqual(turns[1].user, ['人在会话里补的一句话'])
  assert.equal(turns[1].turn, undefined)
})

test('只渲染最近 N 个回合，并写明还有多少没展示', () => {
  const events = []
  for (let turn = 1; turn <= 4; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`任务 ${turn}`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const folded = foldTurns(events)
  const text = renderTranscript({ turns: folded.turns, sessionId: 'w-1', name: 'dev', limit: 2, running: folded.running })
  assert.match(text, /共 4 个回合/)
  assert.match(text, /任务 3/)
  assert.match(text, /任务 4/)
  assert.doesNotMatch(text, /任务 1/)
  assert.match(text, /更早的 2 个回合超出 turns=2 的范围/)
})

test('进行中的最后一轮在正文里标出，避免把半截当结论', () => {
  const folded = foldTurns([
    event('turn/start', { turn: 1 }),
    user('跑测试'),
    assistant('正在跑'),
  ])
  const text = renderTranscript({ turns: folded.turns, sessionId: 'w-1', name: 'dev', limit: 1, running: folded.running })
  assert.match(text, /仍在执行中/)
  assert.match(text, /回合 1 · 进行中/)
})

test('超长正文与失败原因按上限截断并标注', () => {
  const long = 'x'.repeat(3000)
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    user(long),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
    event('tool/result', {
      message: { toolCallId: 'c1', isError: true, content: [] },
      error: { name: 'E', code: 'E', reason: 'y'.repeat(500) },
    }),
    event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'z'.repeat(500) } } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.match(text, /已截断，原长 3000 字符/)
  assert.doesNotMatch(text, new RegExp(`y{300}`))
  // 会话级失败原因同样截断，不把整段错误栈塞进 leader 上下文。
  assert.doesNotMatch(text, new RegExp(`z{300}`))
})

test('整段正文有总上限：装不下的更早回合丢弃，保留最新的结论', () => {
  const events = []
  for (let turn = 1; turn <= 20; turn += 1) {
    events.push(event('turn/start', { turn }))
    // 每轮两条近满额消息：20 轮总量远超单次读取上限，回合数与单条上限都挡不住。
    events.push(user(`${'甲'.repeat(1990)}第${turn}轮`))
    events.push(assistant(`${'乙'.repeat(1990)}第${turn}轮`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 20 })
  // 正文总量（含头部与标注）不应显著超过 12000，更不该到几万。
  assert.ok(text.length < 13000, `正文长度 ${text.length} 超出总上限`)
  // 最新的结论必须在：丢的是更早的回合。
  assert.match(text, /第20轮/)
  assert.match(text, /超出单次读取上限/)
})

test('空日志给出明确的空态，不编造回合', () => {
  const folded = foldTurns([])
  assert.deepEqual(folded.turns, [])
  assert.equal(folded.running, false)
  const text = renderTranscript({ turns: folded.turns, sessionId: 'w-1', name: 'dev', limit: 2 })
  assert.match(text, /还没有任何回合/)
})

test('无关事件（step、请求头、压缩）不进回合视图', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    event('request/header', { headers: {} }),
    event('system/message', { content: [{ type: 'text', text: '系统提示词' }] }),
    event('compaction/start', {}),
    event('step/start', { turn: 1, step: 1 }),
    task('真正的话'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  assert.deepEqual(turns[0].task, ['真正的话'])
  assert.deepEqual(turns[0].assistant, [])
  assert.deepEqual(turns[0].tools, [])
})

test('宿主注入的上下文不冒充用户，也不占任务正文的预算', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    injected('工作目录已切换到 /repo'),
    task('把登录页的文案改掉'),
    user('顺便看下测试'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  assert.deepEqual(turns[0].task, ['把登录页的文案改掉'])
  assert.deepEqual(turns[0].user, ['顺便看下测试'])
  assert.equal(turns[0].injected, 1)
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.match(text, /任务：把登录页的文案改掉/)
  assert.match(text, /用户：顺便看下测试/)
  assert.match(text, /另有 1 条注入上下文，已省略/)
  assert.doesNotMatch(text, /工作目录已切换到/)
})

test('单条正文截断不切在代理对中间', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    // 切点正好落在 😀 的高位代理上：按码元切会留下孤立代理。
    task(`${'a'.repeat(1999)}😀`),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.equal(loneSurrogateAt(text), undefined)
  assert.match(text, /已截断，原长 2001 字符/)
})

test('失败原因截断不切在代理对中间', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
    event('tool/result', {
      message: { toolCallId: 'c1', isError: true, content: [] },
      error: { name: 'E', code: 'E', reason: `${'r'.repeat(199)}😀` },
    }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.equal(loneSurrogateAt(text), undefined)
})

test('总上限硬截断不切在代理对中间', () => {
  // 工具名把一回合撑过 12000：最新回合自身超限，走 clip 的硬截断路径。
  const tools = Array.from({ length: 600 }, () => ({ name: '😀'.repeat(10), failed: undefined, reason: undefined }))
  const text = renderTranscript({
    turns: [{ turn: 1, task: [], user: [], injected: 0, assistant: [], tools, end: { kind: 'completed', error: undefined } }],
    sessionId: 'w-1',
    name: 'dev',
    limit: 1,
  })
  assert.equal(loneSurrogateAt(text), undefined)
  assert.match(text, /已截断/)
})

test('CJK 正文按上限截断，字符完整', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    task('甲'.repeat(2500)),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.match(text, new RegExp('甲'.repeat(2000)))
  assert.equal(loneSurrogateAt(text), undefined)
  assert.doesNotMatch(text, /\uFFFD/)
})

test('组合字符截断只丢重音，不出乱码', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    // 组合序列 e + U+0301 被切点分开：保留基字符，丢掉组合标记。
    task(`${'a'.repeat(1999)}e\u0301`),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.equal(loneSurrogateAt(text), undefined)
  assert.doesNotMatch(text, /\uFFFD/)
  assert.match(text, new RegExp(`${'a'.repeat(1999)}e…`))
})

test('体积溢出时如实说这些回合取不到，不承诺调 turns 可达', () => {
  const events = []
  for (let turn = 1; turn <= 20; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`${'甲'.repeat(1900)}第${turn}轮`))
    events.push(assistant(`${'乙'.repeat(1900)}第${turn}轮`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 5 })
  // 15 个在 turns=5 窗口外，另有若干个在窗口内被体积挤掉：两种成因都要说清。
  assert.match(text, /更早的 15 个回合超出 turns=5 的范围/)
  assert.match(text, /最近的 \d+ 个回合因正文超出单次读取上限被丢弃/)
  // 体积上限固定，任何 turns 值都装不回被挤掉的回合：不能暗示调参能拿到。
  assert.match(text, /单次读取的总量上限固定，调 turns 取不到这些回合/)
  assert.match(text, /需要更早的内容请用 message_worker 让 worker 自己复述/)
  assert.doesNotMatch(text, /调小 turns 可以让更早的回合装进上限/)
  assert.doesNotMatch(text, /调大 turns 可以多看更早的回合/)
})

test('只有窗口外的回合被丢时，建议调大 turns', () => {
  const events = []
  for (let turn = 1; turn <= 4; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`任务 ${turn}`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 2 })
  assert.match(text, /更早的 2 个回合超出 turns=2 的范围/)
  assert.doesNotMatch(text, /超出单次读取上限/)
  assert.match(text, /调大 turns 可以多看更早的回合/)
})

test('体积受限时任何 turns 值都不暗示调参能取到更早回合', () => {
  const events = []
  for (let turn = 1; turn <= 20; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`${'甲'.repeat(1990)}第${turn}轮`))
    events.push(assistant(`${'乙'.repeat(1990)}第${turn}轮`))
    events.push(user(`${'丙'.repeat(1990)}第${turn}轮`))
    events.push(assistant(`${'丁'.repeat(1990)}第${turn}轮`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  // 每回合近 8000 字符，任何 turns 值都装不下窗口内更早的回合：调大调小都无益。
  for (const limit of [2, 3, 4]) {
    const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit })
    assert.match(text, /因正文超出单次读取上限被丢弃/, `limit=${limit} 应触发体积溢出`)
    assert.match(text, /单次读取的总量上限固定，调 turns 取不到这些回合/)
    assert.doesNotMatch(text, /调小 turns/)
    assert.doesNotMatch(text, /调大 turns 可以多看更早的回合/)
  }
})
