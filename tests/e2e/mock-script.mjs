/**
 * mock provider 的可判定部分：场景标记、脚本游标、Messages SSE 事件序列。
 *
 * 单独成模块是为了让这三件事进 `npm run check`——真实取证的失败原因经常落在
 * 「标记没被识别」「脚本多走一步」这类纯逻辑上，起浏览器之前就该测出来。
 *
 * @module dsh-leader-kit/tests/e2e/mock-script
 */

/** 场景标记：写在用户输入里，一个标记只表达一个场景。 */
const MARKER = /MOCK-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g

/**
 * 递归取请求体里出现的场景标记。
 *
 * 扫全量而不是只扫最后一条 user 消息：工具调用之后的那一轮，user 消息里只有
 * `tool_result`，标记只可能留在历史或结果文本里，只看最后一轮会把它丢掉。
 *
 * @param {unknown} body - Messages 请求体
 * @returns {string[]} 去重后的标记，按出现顺序
 */
export function findMarkers(body) {
  const found = []
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(MARKER)) found.push(match[0])
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(body)
  return [...new Set(found)]
}

/**
 * 取本次请求的场景标记。
 *
 * 多个标记是场景写错了（一次只改一个变量），不能挑一个继续：那样失败会归因到
 * 错误的地方。
 *
 * @param {unknown} body - Messages 请求体
 * @returns {string | null} 标记，没有时为 null
 */
export function resolveMarker(body) {
  const markers = findMarkers(body)
  if (markers.length > 1) {
    throw new Error(`一个请求里出现了多个场景标记：${markers.join(', ')}——一个标记只表达一个场景`)
  }
  return markers[0] ?? null
}

/**
 * 按场景标记推进脚本。
 *
 * 第一轮请求带标记；工具调用之后那一轮请求里已经没有标记，于是沿用上一次命中的
 * 标记继续走同一份脚本——否则「调工具、看到结果、收工」这种两轮场景没法表达。
 *
 * @param {Record<string, object[]>} scripts - 标记到步骤列表的映射
 * @returns {{ take: (marker: string | null) => object, remaining: () => Record<string, number> }}
 *   取下一步与查询各脚本剩余步数
 */
export function createScriptCursor(scripts) {
  const positions = new Map()
  let active = null

  return {
    take(marker) {
      const name = marker ?? active
      if (name === null) {
        throw new Error('请求里没有 MOCK- 场景标记：mock 不知道这个请求该走哪份脚本（也不允许猜）')
      }
      const script = scripts[name]
      if (!Array.isArray(script) || script.length === 0) {
        throw new Error(`没有名为 ${name} 的 mock 脚本；已注册：${Object.keys(scripts).join(', ') || '（空）'}`)
      }
      active = name
      const index = positions.get(name) ?? 0
      if (index >= script.length) {
        throw new Error(`${name} 的脚本只有 ${script.length} 步，这是第 ${index + 1} 次请求——场景比脚本多跑了一轮`)
      }
      positions.set(name, index + 1)
      return script[index]
    },
    remaining() {
      return Object.fromEntries(Object.keys(scripts).map((name) => [name, scripts[name].length - (positions.get(name) ?? 0)]))
    },
  }
}

/** 标题生成的 system prompt 特征；它带着会话原文，会误命中场景标记。 */
const TITLE_REQUEST = /session title|concise title/i

/**
 * 区分场景请求与主机的附带请求。
 *
 * 宿主会用同一个模型给会话起标题（一条发后不管的独立调用），它的 prompt 里
 * 带着用户原文——于是场景标记也会出现在里面。若不区分，标题请求会白白吃掉
 * 一步脚本，真正的第二轮请求就会报「脚本已耗尽」，而失败原因看起来像是场景写
 * 错了。附带请求回固定文案，不参与场景游标。
 *
 * @param {unknown} body - Messages 请求体
 * @returns {'title' | 'scenario'} 请求类别
 */
export function classifyRequest(body) {
  const system = typeof body?.system === 'string'
    ? body.system
    : Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? '').join('\n') : ''
  return TITLE_REQUEST.test(system) ? 'title' : 'scenario'
}

/**
 * 按固定宽度切分文本。
 *
 * @param {string} text - 原文
 * @param {number} size - 每块的字符数
 * @returns {string[]} 分块
 */
function splitText(text, size) {
  const points = Array.from(text)
  const chunks = []
  for (let index = 0; index < points.length; index += size) chunks.push(points.slice(index, index + size).join(''))
  return chunks
}

/**
 * 一步脚本对应的 Messages SSE 事件。
 *
 * 事件形状照宿主 llm-mock-server 已验证过的那套（`message_start` → 内容块 →
 * `message_delta` → `message_stop`），客户端解析器不区分mock 与真实提供方。
 *
 * @param {object} step - 脚本步骤
 * @param {string} [step.text] - 文本回复
 * @param {{ name: string, input: object }} [step.tool] - 工具调用
 * @param {string} [step.model] - 回显的模型名
 * @param {number} [step.chunkSize] - 文本与 JSON 的分块大小
 * @returns {object[]} 待写入的 SSE 事件
 */
export function sseEvents(step, { chunkSize = 8, model = 'mock-model' } = {}) {
  const hasText = typeof step?.text === 'string'
  const hasTool = step?.tool !== undefined && step?.tool !== null
  if (hasText === hasTool) {
    throw new Error('一步脚本只能是文本或工具调用之一：两样都给会让两轮场景的轮次对不上')
  }
  const events = [{
    type: 'message_start',
    message: {
      id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 0 },
    },
  }]

  if (hasTool) {
    if (typeof step.tool.name !== 'string' || step.tool.name === '') {
      throw new Error('工具调用缺少 name')
    }
    const partials = splitText(JSON.stringify(step.tool.input ?? {}), chunkSize)
    events.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_mock', name: step.tool.name, input: {} },
    })
    for (const partial of partials) {
      events.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })
    }
    events.push({ type: 'content_block_stop', index: 0 })
    events.push({
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: partials.length },
    })
  } else {
    const chunks = splitText(step.text, chunkSize)
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const text of chunks) {
      events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    }
    events.push({ type: 'content_block_stop', index: 0 })
    events.push({
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: chunks.length },
    })
  }

  events.push({ type: 'message_stop' })
  return events
}
