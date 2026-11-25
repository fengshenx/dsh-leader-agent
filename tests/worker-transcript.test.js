import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldTurns, renderTranscript } from '../src/host/worker-transcript.js'
import { WORKER_TASK_SOURCE_KIND } from '../src/shared/worker-task.js'

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
  assert.deepEqual(turns[0].end, { kind: 'completed', failure: undefined })
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
  assert.match(text, /更早的 2 个回合可用 offset=2 继续翻页/)
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
  const long = 'x'.repeat(5000)
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    user(long),
    event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
    event('tool/result', {
      message: { toolCallId: 'c1', isError: true, content: [] },
      error: { name: 'E', code: 'E', reason: 'y'.repeat(500) },
    }),
    event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'z'.repeat(5000) } } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.match(text, /已截断，原长 5000 码元/)
  // 标记带下一步：其他回合可翻页，单条超出的部分让 worker 复述。
  assert.match(text, /read_worker_session 的 offset 翻页/)
  assert.doesNotMatch(text, new RegExp(`y{300}`))
  // 回合终态失败原因与通知同值：放宽到 4000，超出的部分才截断。
  assert.match(text, /已截断，原长 5000 码元/)
  assert.match(text, /回合 1 · z{3000}/)
  assert.ok(text.length < 9000, `正文长度 ${text.length} 超出预期`)
})

test('aborted / blocked / max-tokens 的失败说明进回看，与通知同一条文本', () => {
  const cases = [
    { reason: { kind: 'aborted', reason: { kind: 'user' } }, expected: '被取消：user' },
    { reason: { kind: 'blocked' }, expected: '被阻断：这一轮被宿主拦下，没有开始' },
    { reason: { kind: 'max-tokens' }, expected: '输出达到 token 上限，这一轮没有正常收尾' },
    { reason: { kind: 'error', error: { message: '模型不可用' } }, expected: '模型不可用' },
  ]
  for (const { reason, expected } of cases) {
    const { turns } = foldTurns([
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason }),
    ])
    const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
    assert.ok(text.includes(expected), `缺失失败说明「${expected}」：${text}`)
  }
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
  assert.match(text, /单次读取总量上限未展示/)
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

test('单条正文超限时标注原长并指向 offset 翻页，不劈开 emoji', () => {
  const { turns } = foldTurns([
    event('turn/start', { turn: 1 }),
    // 全 emoji：任何奇数切点都落在代理对中间。
    assistant('😀'.repeat(3000)),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.match(text, /已截断，原长 6000 码元/)
  assert.match(text, /read_worker_session 的 offset 翻页/)
  assert.equal(loneSurrogateAt(text), undefined)
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
    turns: [{ turn: 1, task: [], user: [], injected: 0, assistant: [], tools, end: { kind: 'completed', failure: undefined } }],
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
    task('甲'.repeat(4500)),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 1 })
  assert.match(text, new RegExp('甲'.repeat(3000)))
  assert.match(text, /已截断，原长 4500 码元/)
  assert.equal(loneSurrogateAt(text), undefined)
  assert.doesNotMatch(text, /\uFFFD/)
})

test('窗口外的更早回合给出 offset 翻页位置', () => {
  const events = []
  for (let turn = 1; turn <= 4; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`任务 ${turn}`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 2 })
  assert.match(text, /更早的 2 个回合可用 offset=2 继续翻页/)
  assert.doesNotMatch(text, /总量上限/)
})

test('体积溢出时给出下一页 offset，翻过去能取回被丢弃的回合', () => {
  const events = []
  for (let turn = 1; turn <= 20; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`${'甲'.repeat(1900)}第${turn}轮`))
    events.push(assistant(`${'乙'.repeat(1900)}第${turn}轮`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  // 每回合约 3800 字符：limit=5 时本页最多留 3 个，另 2 个被体积上限挡住。
  const first = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 5 })
  const hint = first.match(/本页有 (\d+) 个回合因单次读取总量上限未展示[^。]*可用 offset=(\d+) 翻页读取/)
  assert.ok(hint !== null, `缺少翻页提示：${first.slice(-160)}`)
  assert.equal(hint[1], '2')
  // 提示的 offset 必须真的取回被丢弃的回合，否则提示是空头支票。
  const next = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 5, offset: Number(hint[2]) })
  assert.match(next, /第16轮/)
  assert.match(next, /第17轮/)
})

test('offset 翻页时头部写明跳过的最新回合', () => {
  const events = []
  for (let turn = 1; turn <= 6; turn += 1) {
    events.push(event('turn/start', { turn }))
    events.push(task(`任务 ${turn}`))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  const { turns } = foldTurns(events)
  const text = renderTranscript({ turns, sessionId: 'w-1', name: 'dev', limit: 2, offset: 2 })
  assert.match(text, /倒序第 3–4 个（offset=2 跳过最新 2 个）/)
  assert.match(text, /任务 3/)
  assert.match(text, /任务 4/)
  assert.doesNotMatch(text, /任务 5/)
  assert.match(text, /更早的 2 个回合可用 offset=4 继续翻页/)
})
