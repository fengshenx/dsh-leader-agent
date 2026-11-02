/**
 * 任务卡事实在提示词中的注入点。
 *
 * 与角色槽位（`src/host/slots/index.js`）、协调者手册（`coordinator-context.js`）
 * 走同一套通道：注册运行时上下文 provider。宿主在每次模型请求前求值，但只有
 * 渲染文本与上一份快照不同时才把它作为一条 user 消息追加——所以卡片没变的
 * 那一轮不重复注入，卡片被改（worker 自己挂 PR、协调者改规格）才补一份新快照。
 *
 * 卡片事实因此不拼进任务消息：消息会冻结成派工那一刻的快照，而卡片是会被改的
 * 事实。协调者的第一条消息只说「做什么」，规格与链接由同一请求的上下文给出。
 *
 * 索引是同步内存镜像（`cards/store.js` 的 `cardIndex`）：提示词组装函数是同步的，
 * 不能在里面 await 异步落盘的卡片库。
 *
 * @module dsh-leader-kit/host/cards/card-context
 */

/** 注入项的上下文名。 */
export const CARD_CONTEXT_NAME = 'dsh-leader-kit:task-card'

/**
 * 注入项在运行时上下文里的位置。
 *
 * 排在角色槽位（105）之后：先「我承担什么角色」，再「这次具体做什么」。
 */
export const CARD_CONTEXT_ORDER = 106

/**
 * 渲染一个会话挂着的任务卡事实。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 会话 id
 * @param {Map<string, object[]>} options.cardIndex - 会话 id 到挂卡事实的反查索引
 * @returns {string} 上下文文本；没有挂卡时为空串
 */
export function renderCardContext({ sessionId, cardIndex }) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const bindings = cardIndex?.get?.(sessionId)
  if (!Array.isArray(bindings) || bindings.length === 0) return ''
  const lines = ['## 当前任务卡', '']
  if (bindings.length > 1) {
    lines.push(
      `（这个会话同时挂了 ${bindings.length} 张卡：先确认本次要服务哪一张。正常协议下一张卡一条会话。）`,
      '',
    )
  }
  for (const binding of bindings) {
    lines.push(
      `#${binding.number} ${binding.title}（cardId: ${binding.cardId}，revision: ${binding.revision}，槽位 ${binding.slot}，状态 ${binding.status}）`,
    )
    if (binding.status === 'archived') {
      lines.push('', '这张卡已归档，归档是终态：没有新活可接，也不要再改它。')
    }
    const spec = typeof binding.spec === 'string' ? binding.spec.trim() : ''
    if (spec !== '') lines.push('', '### 规格', '', spec)
    const links = Array.isArray(binding.links) ? binding.links : []
    if (links.length > 0) {
      lines.push('', '### 链接')
      for (const link of links) {
        const label = String(link?.label ?? '').trim() || '链接'
        const url = typeof link?.url === 'string' && link.url !== '' ? `：${link.url}` : ''
        const purpose = typeof link?.purpose === 'string' && link.purpose !== '' ? `（${link.purpose}）` : ''
        lines.push(`- ${label}${url}${purpose}`)
      }
    }
    lines.push('')
  }
  lines.push(
    '卡片是任务事实的真源：新增或修正链接用 `update_card` 的 `addLinks` 追加，不要整份重写；`status` 与 `spec` 由协调者维护。',
  )
  return lines.join('\n').trim()
}

/**
 * 注册任务卡上下文注入。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {Map<string, object[]>} options.cardIndex - 会话 id 到挂卡事实的反查索引
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {void}
 */
export function applyCardContext({ ctx, cardIndex, logger = () => {} }) {
  ctx.effect(() => ctx.systemPrompt.context({
    name: CARD_CONTEXT_NAME,
    order: CARD_CONTEXT_ORDER,
    // 卡片规格是项目里可编辑的 Markdown，可能含 `{{`——按字面量处理，不做插值。
    interpolate: false,
    // 运行时会关掉可选上下文；卡片事实是任务必需信息，声明必需。
    required: true,
    text: (context) => {
      const sessionId = context.agent?.id
      if (typeof sessionId !== 'string') return ''
      try {
        return renderCardContext({ sessionId, cardIndex })
      } catch (error) {
        // 求值失败会让整个 turn 崩掉。卡片是增量信息，取不到就当没有。
        logger(`dsh-leader-kit: 渲染任务卡上下文失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-leader-kit 任务卡上下文注入')
}
