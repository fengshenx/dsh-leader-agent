/**
 * 任务看板卡片工具：`create_card`、`update_card`、`list_cards`。
 *
 * 卡片是协调者维护的任务事实：标题、规格、状态、链接与槽位绑定。看板 UI 从工具
 * 的结构化输出重建卡片列表，因此工具返回完整卡片对象；模型看到的是 `render`
 * 给出的简短确认，不需要读全量卡片。
 *
 * @module dsh-leader-kit/host/tools/cards
 */

import { randomUUID } from 'node:crypto'
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  parseListQuery,
  renderCardList,
} from '../cards/card-list-view.js'
import { isValidSlotName } from '../slots/slot-templates.js'

/**
 * 校验可选字符串字段。
 *
 * 手写 ToolDefinition 绕过了宿主的入参 schema 校验：类型不符的参数会一路落库，
 * 直到输出 schema 校验（发生在 execute 之后）才报错——副作用已发生，调用方却
 * 看到工具失败。因此类型错误必须在落库前抛出。
 *
 * @param {unknown} value - 字段值
 * @param {string} label - 字段名，用于报错
 * @returns {string | undefined} 原值
 */
function optionalString(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`卡片工具: ${label} 必须是字符串`)
  }
  return value
}

/**
 * 校验可选数字字段。
 * @param {unknown} value - 字段值
 * @param {string} label - 字段名，用于报错
 * @returns {number | undefined} 原值
 */
function optionalNumber(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`卡片工具: ${label} 必须是数字`)
  }
  return value
}

/**
 * 链接条目的 JSON Schema。
 * @returns {object} schema
 */
function linkSchema() {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      url: { type: 'string' },
      purpose: { type: 'string' },
    },
    required: ['label'],
  }
}

/**
 * 槽位绑定的 JSON Schema。
 *
 * 槽位名由项目 `SLOTS.md` 决定，不是固定枚举——中文、日文等 Unicode 字母
 * 数字都可以。`properties` 里的 dev / review 只是常见示例，其余名字由
 * `additionalProperties` 接受。名字的合法性在 `normalizeSlots` 里校验，
 * 与解析 `SLOTS.md` 共用同一条规则。
 *
 * @returns {object} schema
 */
function slotsSchema() {
  return {
    type: 'object',
    properties: {
      dev: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      review: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
    additionalProperties: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  }
}

/**
 * 完整卡片的 JSON Schema——客户端按它重建看板。
 * @returns {object} schema
 */
function cardSchema() {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      number: { type: 'number' },
      revision: { type: 'number' },
      title: { type: 'string' },
      spec: { type: 'string' },
      status: { type: 'string', enum: ['active', 'done', 'archived'] },
      links: { type: 'array', items: linkSchema() },
      slots: slotsSchema(),
      sortOrder: { type: 'number' },
      doneAt: { type: 'number' },
      createdAt: { type: 'number' },
      updatedAt: { type: 'number' },
    },
    required: ['id', 'number', 'revision', 'title', 'status', 'createdAt', 'updatedAt'],
  }
}

/**
 * 规范化链接条目，补齐条目 id。
 *
 * 工具是手写的 ToolDefinition，宿主只校验输出 schema，入参 schema 里的
 * `required` 在运行时不生效——链接条目的 label 缺了就会以 `undefined` 落盘，
 * 序列化后静默丢字段。因此这里显式校验形状。
 *
 * @param {object[]} links - 原始链接条目
 * @returns {object[]} 规范化后的链接条目
 */
function normalizeLinks(links) {
  if (!Array.isArray(links)) {
    throw new Error('卡片工具: links 必须是数组')
  }
  return links.map((link) => {
    if (link === null || typeof link !== 'object' || Array.isArray(link)) {
      throw new Error('卡片工具: links 条目必须是对象')
    }
    if (typeof link.label !== 'string' || link.label.trim() === '') {
      throw new Error('卡片工具: links 条目缺 label')
    }
    if (link.id !== undefined && (typeof link.id !== 'string' || link.id === '')) {
      throw new Error('卡片工具: links 条目的 id 必须是非空字符串')
    }
    if (link.url !== undefined && typeof link.url !== 'string') {
      throw new Error('卡片工具: links 条目的 url 必须是字符串')
    }
    if (link.purpose !== undefined && typeof link.purpose !== 'string') {
      throw new Error('卡片工具: links 条目的 purpose 必须是字符串')
    }
    return {
      id: typeof link.id === 'string' ? link.id : randomUUID(),
      label: link.label,
      ...link.url === undefined ? {} : { url: link.url },
      ...link.purpose === undefined ? {} : { purpose: link.purpose },
    }
  })
}

/**
 * 校验槽位绑定结构。
 *
 * 槽位名必须与 `SLOTS.md` 解析器接受的名字一致：名字合法但解析器不认，绑定
 * 会落盘成功、注入却是空串——这种静默失效只能在写入前拦住。
 *
 * 每个槽位项必须带非空的 `sessionId`——否则槽位看起来绑上了，实际没有对应
 * 会话，后续按槽位找执行者会拿到空值。
 *
 * @param {object} slots - 原始槽位绑定
 * @returns {object} 校验通过的槽位绑定
 */
function normalizeSlots(slots) {
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) {
    throw new Error('卡片工具: slots 必须是对象')
  }
  for (const [name, binding] of Object.entries(slots)) {
    if (!isValidSlotName(name)) {
      throw new Error(`卡片工具: 槽位名 ${JSON.stringify(name)} 不合法（只允许字母、数字、下划线、连字符，最长 32 字符）`)
    }
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error(`卡片工具: 槽位 ${name} 必须是对象`)
    }
    if (typeof binding.sessionId !== 'string' || binding.sessionId.trim() === '') {
      throw new Error(`卡片工具: 槽位 ${name} 缺 sessionId`)
    }
  }
  return slots
}

/**
 * 卡片数据投影：结构化卡片随工具结果进 session log，客户端看板据此重建。
 *
 * 工具的 `render` 只给模型看文本，客户端拿不到结构化数据；`presentationMeta`
 * 投影的 `meta` 会持久化在 `tool/result` 事件上，是客户端唯一稳定的取数通道。
 *
 * @param {string} scope - `card` 表示单卡变更，`all` 表示全量快照
 * @param {object[]} cards - 卡片数组
 * @returns {object} 投影载荷
 */
function cardMeta(scope, cards) {
  return { kind: 'dsh-leader-kit-cards', scope, cards }
}

/**
 * 创建 `create_card` 工具定义。
 * @param {object} options - 工具选项
 * @param {{ create: (input: object) => Promise<object> }} options.store - 卡片存储
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] -
 *   解析调用方会话所属项目；卡片按项目归属，模型不传项目参数
 * @returns {object} dsh 工具定义
 */
export function createCreateCardTool({ store, resolveProject }) {
  return {
    name: 'create_card',
    description:
      '建立一张任务看板卡片。卡片是协调者维护的任务事实，编号自动分配且永不复用，可用返回的 number 引用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，一句话说清要做什么。' },
        spec: {
          type: 'string',
          description: '任务规格：任务简报与验收标准。协调者验收判断与 worker 防漂移的锚点。',
        },
        links: {
          type: 'array',
          items: linkSchema(),
          description: '外部引用条目（MR、Issue、设计文档等）。',
        },
        slots: {
          ...slotsSchema(),
          description: '槽位绑定：把执行或评审会话挂到卡片上。槽位名与项目 SLOTS.md 的 `## <槽位名>` 一致，可用中文。',
        },
      },
      required: ['title'],
    },
    output: {
      schema: { type: 'object', properties: { card: cardSchema() }, required: ['card'] },
      render(args, value) {
        const card = /** @type {{ card: { number: number, title: string } }} */ (value).card
        return [
          {
            type: 'text',
            text: `已建卡 #${card.number}「${card.title}」。`,
          },
        ]
      },
      presentationMeta(args, value) {
        const card = /** @type {{ card: object }} */ (value).card
        return cardMeta('card', [card])
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ title: string, spec?: string, links?: object[], slots?: object, checkpoint?: unknown }} */ (args)
      if (typeof input.title !== 'string' || input.title.trim() === '') {
        throw new Error('create_card: title 不能为空')
      }
      // checkpoint 已移除：旧会话仍传这个字段时明确拒绝，而不是收下成功回执、
      // 再把事实丢掉。
      if (input.checkpoint !== undefined) {
        throw new Error('create_card: checkpoint 已移除，任务事实请写进 spec')
      }
      const spec = optionalString(input.spec, 'spec')
      const links = input.links === undefined ? undefined : normalizeLinks(input.links)
      const slots = input.slots === undefined ? undefined : normalizeSlots(input.slots)
      // 卡片归属项目由宿主按调用方会话判定，模型不传项目参数：模型未必知道自己是
      // 在哪个项目的语境里调用工具，判据交给会话这一侧的事实更可靠。
      const project = await resolveProject?.(exec.agent?.id)
      const card = await store.create({
        title: input.title.trim(),
        ...spec === undefined ? {} : { spec },
        ...links === undefined ? {} : { links },
        ...slots === undefined ? {} : { slots },
        ...project === undefined ? {} : { projectId: project.id },
        ...exec.agent?.id === undefined ? {} : { createdBy: exec.agent.id },
      })
      return { card }
    },
  }
}

/**
 * 创建 `update_card` 工具定义。
 * @param {object} options - 工具选项
 * @param {{ update: (input: object) => Promise<object> }} options.store - 卡片存储
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] -
 *   解析调用方会话所属项目；跨项目改卡会被拒绝
 * @returns {object} dsh 工具定义
 */
export function createUpdateCardTool({ store, resolveProject }) {
  return {
    name: 'update_card',
    description:
      '更新一张任务看板卡片。带 expectedRevision 时做乐观并发校验，版本不符即报错，需重新读卡再改。归档是终态，不能再改。卡片按项目归属，只能改本项目的卡。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '卡片 id（建卡时返回）。' },
        expectedRevision: {
          type: 'number',
          description: '期望的内容版本，来自上一次读到的 revision。',
        },
        title: { type: 'string', description: '新标题。' },
        spec: { type: 'string', description: '新规格。' },
        status: {
          type: 'string',
          enum: ['active', 'done', 'archived'],
          description: '新状态。active 与 done 可逆，archived 是终态。',
        },
        links: { type: 'array', items: linkSchema(), description: '新的链接条目（整体替换）。' },
        slots: {
          ...slotsSchema(),
          description: '新的槽位绑定（整体替换）。槽位名与项目 SLOTS.md 的 `## <槽位名>` 一致，可用中文。',
        },
        sortOrder: { type: 'number', description: '手动排序序号（小的在前）。' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', properties: { card: cardSchema() }, required: ['card'] },
      render(args, value) {
        const card = /** @type {{ card: { number: number, title: string, status: string } }} */ (value).card
        return [
          {
            type: 'text',
            text: `已更新卡片 #${card.number}「${card.title}」，状态 ${card.status}。`,
          },
        ]
      },
      presentationMeta(args, value) {
        const card = /** @type {{ card: object }} */ (value).card
        return cardMeta('card', [card])
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ id: string, expectedRevision?: number, title?: string, spec?: string, status?: string, links?: object[], slots?: object, sortOrder?: number, checkpoint?: unknown }} */ (args)
      if (typeof input.id !== 'string' || input.id.trim() === '') {
        throw new Error('update_card: id 不能为空')
      }
      // 见 create_card：废弃字段显式拒收，避免「回执成功但事实没落盘」。
      if (input.checkpoint !== undefined) {
        throw new Error('update_card: checkpoint 已移除，任务事实请写进 spec')
      }
      // 入参 schema 里的 required 与类型在运行时不生效（手写 ToolDefinition，
      // 宿主只校验输出 schema），因此这里逐项校验裸字段。
      if (input.expectedRevision !== undefined && !Number.isInteger(input.expectedRevision)) {
        throw new Error('update_card: expectedRevision 必须是整数')
      }
      if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim() === '')) {
        throw new Error('update_card: title 不能为空')
      }
      const spec = optionalString(input.spec, 'spec')
      const links = input.links === undefined ? undefined : normalizeLinks(input.links)
      const slots = input.slots === undefined ? undefined : normalizeSlots(input.slots)
      const sortOrder = optionalNumber(input.sortOrder, 'sortOrder')
      // 卡片按项目归属：改别人项目的卡要拒绝。无归属的存量卡不拦——没有归属可
      // 冲突，拦下来只会让存量卡永远改不动。
      //
      // 调用方自己的范围就是它所在的项目（不在任何项目里就是空串）。这条判据
      // 同时挡住两种越权：在 A 项目里改 B 项目的卡，以及在项目外改某个项目的卡。
      const project = await resolveProject?.(exec.agent?.id)
      const existing = await store.get(input.id.trim())
      const owner = typeof existing?.projectId === 'string' ? existing.projectId : ''
      const scope = typeof project?.id === 'string' ? project.id : ''
      if (owner !== '' && owner !== scope) {
        throw new Error(`update_card: 卡片 ${input.id.trim()} 属于另一个项目，不能跨项目改卡`)
      }
      const card = await store.update({
        id: input.id.trim(),
        ...input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision },
        ...input.title === undefined ? {} : { title: input.title.trim() },
        ...spec === undefined ? {} : { spec },
        ...input.status === undefined ? {} : { status: input.status },
        ...links === undefined ? {} : { links },
        ...slots === undefined ? {} : { slots },
        ...sortOrder === undefined ? {} : { sortOrder },
      })
      return { card }
    },
  }
}

/**
 * 创建 `list_cards` 工具定义。
 *
 * 模型读 `render` 的列表视图（摘要 + 分页），客户端读 `presentationMeta` 的全量
 * 投影——看板要按全量卡片重建视图，不能被分页与状态过滤裁掉。因此工具返回全量
 * 卡片，分页只发生在模型可见的文本上。
 *
 * 卡片按项目归属：默认只列调用方所在项目的卡（一个项目一个看板，模型看到的与
 * 看板看到的同一份）。`scope: 'all'` 才跨项目列全库。
 *
 * @param {object} options - 工具选项
 * @param {{ list: (filter?: object) => Promise<object[]> }} options.store - 卡片存储
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] -
 *   解析调用方会话所属项目
 * @returns {object} dsh 工具定义
 */
export function createListCardsTool({ store, resolveProject }) {
  return {
    name: 'list_cards',
    description:
      '按最近更新倒序列出任务看板卡片（默认只列本项目的 active 卡，20 张一页）；传 cardId 读取单卡完整规格与链接。',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: '可选，只读指定卡片的完整当前事实（spec / links 全文）；单卡查询忽略 status 与分页参数',
        },
        status: {
          type: 'string',
          enum: ['active', 'done', 'archived', 'all'],
          description: '状态过滤，默认 active；查历史卡用 done / archived / all',
        },
        scope: {
          type: 'string',
          enum: ['project', 'all'],
          description: '范围，默认 project（本项目的卡）；all 跨项目列全库',
        },
        limit: {
          type: 'number',
          description: `单页张数，默认 ${LIST_DEFAULT_LIMIT}，上限 ${LIST_MAX_LIMIT}`,
        },
        offset: {
          type: 'number',
          description: '从第几张开始（按最近更新倒序），翻页用',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cards: { type: 'array', items: cardSchema() },
          query: {
            type: 'object',
            properties: {
              cardId: { type: 'string' },
              status: { type: 'string' },
              scope: { type: 'string' },
              limit: { type: 'number' },
              offset: { type: 'number' },
            },
            required: ['status', 'scope', 'limit', 'offset'],
          },
        },
        required: ['cards', 'query'],
      },
      render(args, value) {
        const result = /** @type {{ cards: object[], query: { cardId?: string, status: string, scope: string, limit: number, offset: number } }} */ (value)
        return [{ type: 'text', text: renderCardList(result.cards, result.query) }]
      },
      presentationMeta(args, value) {
        const result = /** @type {{ cards: object[] }} */ (value)
        return cardMeta('all', result.cards)
      },
    },
    async execute(args, exec) {
      const query = parseListQuery(args)
      // 单卡查询不受范围限制：模型拿着 cardId 来读，要的就是那张卡。
      if (query.scope === 'all' || query.cardId !== undefined) {
        const cards = await store.list()
        return { cards, query }
      }
      const project = await resolveProject?.(exec.agent?.id)
      const cards = await store.list({ projectId: project?.id ?? '' })
      return { cards, query }
    },
  }
}
