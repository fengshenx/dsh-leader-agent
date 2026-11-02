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
import { normalizeHttpUrl } from '../../shared/card-links.js'
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
      label: { type: 'string', description: '链接标签，必填且非空' },
      url: { type: 'string', description: '能归一化为 http(s) 绝对地址的完整地址（如 https://…）；没有可跳转地址时省略这个字段' },
      purpose: { type: 'string', description: '这个链接的用途（可选）' },
    },
    required: ['label'],
  }
}

/**
 * 槽位绑定的 JSON Schema。
 *
 * 槽位名是机器标识：小写 ASCII 字母、数字、下划线、连字符，最长 32 字符（显示名
 * 走 `SLOTS.md` 的 `label`）。名字不是固定枚举——`properties` 里的 dev / review
 * 只是常见示例，其余名字由 `additionalProperties: true` 放行。
 *
 * 只能用宿主执行子集里的关键字（`type` / `properties` / `required` /
 * `additionalProperties` 布尔值 / `items` / `enum` / `const` 与注释字段）：本 schema
 * 同时进 `output.schema`（`cardSchema()` 复用它），而 `tools.register` 会校验
 * output schema——`propertyNames`、`pattern`，或把 `additionalProperties` 写成
 * schema 对象，都会在注册时抛 `UNSUPPORTED_SCHEMA`（见 capability-gaps 第 40 条）。
 * 入参 schema 宿主既不校验子集也不执行约束，槽位名的合法性只有 `normalizeSlots`
 * 一条执行路径。
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
    additionalProperties: true,
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
 * 序列化后静默丢字段。因此这里显式校验形状与 URL。
 *
 * 报错是写给模型看的：每条都带上「第几条、哪个标签、收到的原值、该怎么改」。
 * 只说「url 非法」会让模型原地重试，而它需要知道的是「要 http(s) 绝对地址
 * （如 https://… 的完整地址），或者干脆不传 url」。
 *
 * 整体替换（`links`）会给缺 id 的条目补一个稳定 id，条目以后能按 id 原位更新。
 * 增量追加（`addLinks`）**不能补**：补了每次都生成新 id，同一份链接会被重复
 * 追加，去重也就永远不生效——调用方没给 id 时就留空，交给 store 按
 * `label + url` 判重。
 *
 * @param {object[]} links - 原始链接条目
 * @param {{ assignIds?: boolean }} [options] - `assignIds` 为 false 时不给缺 id 的条目补 id
 * @returns {object[]} 规范化后的链接条目
 */
function normalizeLinks(links, { assignIds = true } = {}) {
  if (!Array.isArray(links)) {
    throw new Error(`卡片工具: links 必须是数组，收到 ${describeValue(links)}`)
  }
  const seenIds = new Set()
  return links.map((link, index) => {
    const where = `links 第 ${index + 1} 条`
    if (link === null || typeof link !== 'object' || Array.isArray(link)) {
      throw new Error(`卡片工具: ${where}必须是对象，收到 ${describeValue(link)}`)
    }
    if (typeof link.label !== 'string' || link.label.trim() === '') {
      const hint = typeof link.url === 'string' && link.url.trim() !== ''
        ? `（这一条带了 url ${JSON.stringify(link.url)}，但链接必须有非空 label）`
        : ''
      throw new Error(`卡片工具: ${where}缺 label${hint}；每条链接都要有非空 label`)
    }
    const label = link.label.trim()
    if (link.id !== undefined && (typeof link.id !== 'string' || link.id === '')) {
      throw new Error(`卡片工具: ${where}（label「${label}」）的 id 必须是非空字符串，收到 ${describeValue(link.id)}`)
    }
    if (link.url !== undefined && typeof link.url !== 'string') {
      throw new Error(`卡片工具: ${where}（label「${label}」）的 url 必须是字符串，收到 ${describeValue(link.url)}`)
    }
    if (link.purpose !== undefined && typeof link.purpose !== 'string') {
      throw new Error(`卡片工具: ${where}（label「${label}」）的 purpose 必须是字符串，收到 ${describeValue(link.purpose)}`)
    }
    const rawUrl = typeof link.url === 'string' ? link.url.trim() : ''
    let url = ''
    if (rawUrl !== '') {
      const normalizedUrl = normalizeHttpUrl(rawUrl)
      if (normalizedUrl === null) {
        throw new Error(
          `卡片工具: ${where}（label「${label}」）的 url 必须是 http(s) 绝对地址，`
          + `收到 ${JSON.stringify(link.url)}；请改成 https://… 这样的完整地址，或者去掉 url 字段`,
        )
      }
      url = normalizedUrl
    }
    const purpose = typeof link.purpose === 'string' ? link.purpose.trim() : ''
    // 重复 id 会让看板把两条链接当成同一条（改一行动两行）：后面那条换新 id。
    // `addLinks` 不补 id：补了每次都是新 id，去重永远不生效，交给 store 按
    // `label + url` 判重。重复且不能补时同样留空，避免两条链接撞同一个 id。
    const hasId = typeof link.id === 'string' && link.id !== ''
    const id = hasId && !seenIds.has(link.id)
      ? link.id
      : assignIds ? randomUUID() : undefined
    if (id !== undefined) seenIds.add(id)
    return {
      ...id === undefined ? {} : { id },
      label,
      ...url === '' ? {} : { url },
      ...purpose === '' ? {} : { purpose },
    }
  })
}

/**
 * 把收到的值描述成一句能放进报错里的话。
 *
 * 模型看到 `[object Object]` 或 `undefined` 都无从下手；给出类型与 JSON 片段
 * 才能让它自己改对。
 *
 * @param {unknown} value - 收到的值
 * @returns {string} 描述
 */
function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value)
      return text.length > 120 ? `${text.slice(0, 120)}…` : text
    } catch {
      // 循环引用之类序列化不了的值，退回类型说明。
      return '对象'
    }
  }
  return `${typeof value} ${String(value)}`
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
      throw new Error(`卡片工具: 槽位名 ${JSON.stringify(name)} 不合法（只允许小写 ASCII 字母、数字、下划线、连字符，最长 32 字符）`)
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
 * 卡片写入的身份闸。
 *
 * 工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话：退役的那个会话手里
 * 仍留着 `create_card` / `update_card`，直到下次会话重建才按普通会话重裁。因此
 * 每次写入再判一次当前身份——退役者与普通会话同档，不能写卡。
 *
 * 判定可以是异步的：索引未就绪时问不出谁是协调者，判据要先等一次重建结果，口径
 * 与派工一致（见 `canWriteCardsFor`）。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {((sessionId: string | undefined) => boolean | Promise<boolean>) | undefined} canWrite -
 *   写卡身份判定；省略时放行，仅供文档取名字与单测构造
 * @returns {Promise<void>} 闸门通过
 * @throws {Error} 调用方不是协调者也不是 worker
 */
async function assertCardWriter(sessionId, canWrite) {
  if (typeof canWrite !== 'function') return
  if ((await canWrite(sessionId)) === true) return
  throw new Error('卡片工具: 只有协调者与 worker 能写卡（项目注册表尚未读出时同样拒绝）——普通会话不在任何项目编排里，没有卡可写')
}

/**
 * 建卡的身份闸：worker 不能建卡。
 *
 * 协议层的建卡动作全部属于协调者（`COORDINATOR.md` 的「一个 worker 一张卡」、
 * `leader-mode` 的协调者动作表），`SLOTS.md` 的各槽位也没有让执行者建卡的步骤——
 * worker 攒下的待办由它回报、协调者建卡并派工。放开这个口子会造出没有槽位、
 * 没人认领的卡，和普通会话建卡是同一种问题，只是少一道工具面拒绝。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {((sessionId: string | undefined) => boolean) | undefined} isWorkerSession - worker 判定
 * @returns {void}
 * @throws {Error} 调用方是 worker
 */
function assertCardCreator(sessionId, isWorkerSession) {
  if (typeof isWorkerSession !== 'function' || isWorkerSession(sessionId) !== true) return
  throw new Error('create_card: worker 不建卡——卡由协调者建并派工；需要新任务请在回报里说明，交付物挂到自己卡上用 update_card 的 addLinks')
}

/**
 * worker 的写卡范围闸：只允许改自己挂着的卡，且不许动槽位绑定。
 *
 * 身份闸只回答「能不能写卡」，回答不了「写哪张、写什么」。对 worker 有四条：
 *
 * - **只能改自己挂着的卡**：worker 的 cwd 就是项目目录，同项目里别的 worker 的卡
 *   它一样能改；改别人的卡会把产物落错地方。
 * - **不能改槽位绑定**：整卡替换 `slots` 正是投递门禁（`dispatch.js` 的
 *   `assertCardGateOpen`）认定必须拦下的坏状态（一个会话同时挂多张 active 卡）。
 * - **不能改状态**：`done` / `archived` 会释放执行者、抽走卡片上下文，是协调者的
 *   收工动作；重开同样是它的指派动作。worker 连合并与 approve 都不决定，判不了完成。
 * - **不能改规格**：`spec` 是协调者维护的目标、范围与验收（`program.md` 的「`status`
 *   与 `spec` 仍归协调者」、`implementation.md` 的「卡片规格与状态仍由协调者维护」）。
 *   worker 的进展与产物走回报正文与 `links`，不往 spec 里写——那会改掉验收锚点，
 *   也会冲掉 `expectedRevision`。
 *
 * 协调者不受这条约束：它本来就在管整个项目。
 *
 * @param {string} sessionId - 调用方会话 id
 * @param {object} input - 本次写入的意图
 * @param {string} input.cardId - 目标卡 id
 * @param {object | undefined} input.slots - 要写入的槽位绑定
 * @param {string | undefined} input.status - 要写入的状态
 * @param {string | undefined} input.spec - 要写入的规格
 * @param {object} options - 判定依赖
 * @param {((sessionId: string | undefined) => boolean) | undefined} options.isWorkerSession - worker 判定
 * @param {((sessionId: string) => Promise<object[]>) | undefined} options.cardBindingsOf - 会话的卡片绑定
 * @returns {Promise<void>} 范围校验通过
 * @throws {Error} 目标卡不在 worker 的绑定里，或试图改槽位绑定、改状态、改规格
 */
async function assertWorkerCardScope(sessionId, { cardId, slots, status, spec }, { isWorkerSession, cardBindingsOf }) {
  if (typeof isWorkerSession !== 'function' || isWorkerSession(sessionId) !== true) return
  if (slots !== undefined) {
    throw new Error('update_card: worker 不能改卡片的槽位绑定——换执行者请在协调者会话里做')
  }
  if (status !== undefined) {
    throw new Error('update_card: worker 不能改卡片状态——完成由协调者验收后判定（done / archived 会释放执行者），重开也是协调者的指派动作；请把交付物挂到 links 并在回报里说明已完成')
  }
  if (spec !== undefined) {
    throw new Error('update_card: worker 不能改卡片规格——spec 是协调者维护的目标、范围与验收；进展与产物写进回报、链接挂到 links')
  }
  if (typeof cardBindingsOf !== 'function') return
  const bindings = await cardBindingsOf(sessionId)
  if (bindings.some((binding) => binding.cardId === cardId)) return
  const mine = bindings.map((binding) => `#${binding.number}（cardId: ${binding.cardId}）`).join('、')
  throw new Error(`update_card: worker 只能改自己挂着的卡，${cardId} 不在你的绑定里${mine === '' ? '' : `；你的卡：${mine}`}`)
}

/**
 * 创建 `create_card` 工具定义。
 * @param {object} options - 工具选项
 * @param {{ create: (input: object) => Promise<object> }} options.store - 卡片存储
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] -
 *   解析调用方会话所属项目；卡片按项目归属，模型不传项目参数
 * @param {(sessionId: string | undefined) => boolean | Promise<boolean>} [options.canWrite] - 写卡身份判定；
 *   省略时放行，仅供文档取名字与单测构造
 * @param {(sessionId: string | undefined) => boolean} [options.isWorkerSession] - worker 判定；
 *   worker 不建卡，建卡与派工是协调者的一条动作链
 * @returns {object} dsh 工具定义
 */
export function createCreateCardTool({ store, resolveProject, canWrite, isWorkerSession }) {
  return {
    name: 'create_card',
    description:
      '建立一张任务看板卡片。卡片是协调者维护的任务事实，编号自动分配且永不复用，可用返回的 number 引用。worker 不建卡：新任务由协调者建卡并派工。',
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
          description: '外部引用条目（MR、Issue、设计文档等）。每条要有非空 label；url 若是 http(s) 绝对地址才会在卡上可点，传错会报错并指出是第几条。',
        },
        slots: {
          ...slotsSchema(),
          description: '槽位绑定：把执行或评审会话挂到卡片上。槽位名与项目 SLOTS.md 的 `## <槽位名>` 一致，是小写 ASCII 机器标识（字母、数字、下划线、连字符，最长 32 字符），不是显示名。',
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
      await assertCardWriter(exec.agent?.id, canWrite)
      assertCardCreator(exec.agent?.id, isWorkerSession)
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
 * @param {(sessionId: string | undefined) => boolean | Promise<boolean>} [options.canWrite] - 写卡身份判定；
 *   省略时放行，仅供文档取名字与单测构造
 * @param {(sessionId: string | undefined) => boolean} [options.isWorkerSession] - worker 判定；
 *   与 `cardBindingsOf` 一起构成 worker 的写卡范围闸
 * @param {(sessionId: string) => Promise<object[]>} [options.cardBindingsOf] - 会话挂着的卡
 * @returns {object} dsh 工具定义
 */
export function createUpdateCardTool({ store, resolveProject, canWrite, isWorkerSession, cardBindingsOf }) {
  return {
    name: 'update_card',
    description:
      '更新一张任务看板卡片。带 expectedRevision 时做乐观并发校验，版本不符即报错，需重新读卡再改。链接用 addLinks 增量追加（不会覆盖别人刚写的条目），整份替换才用 links。归档是终态，不能再改。卡片按项目归属，只能改本项目的卡；worker 只能改自己挂着的卡，且不能改状态、规格与槽位绑定。',
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
        links: {
          type: 'array',
          items: linkSchema(),
          description: '新的链接条目（整体替换）。每条要有非空 label；url 必须是 http(s) 绝对地址，传错会报错并指出是第几条。只想追加或修正个别链接时用 addLinks。',
        },
        addLinks: {
          type: 'array',
          items: linkSchema(),
          description: '追加的链接条目：按 id 合并（同 id 原位更新字段），没有 id 时按 label+url 去重；带 url 的条目同样要求 http(s) 绝对地址，传错会报错并指出是第几条。与 links 互斥。worker 建了 PR/Issue 后用这个把链接挂上。',
        },
        slots: {
          ...slotsSchema(),
          description: '新的槽位绑定（整体替换）。槽位名与项目 SLOTS.md 的 `## <槽位名>` 一致，是小写 ASCII 机器标识（字母、数字、下划线、连字符，最长 32 字符），不是显示名。',
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
      const input = /** @type {{ id: string, expectedRevision?: number, title?: string, spec?: string, status?: string, links?: object[], addLinks?: object[], slots?: object, sortOrder?: number, checkpoint?: unknown }} */ (args)
      await assertCardWriter(exec.agent?.id, canWrite)
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
      const addLinks = input.addLinks === undefined ? undefined : normalizeLinks(input.addLinks, { assignIds: false })
      // 整体替换与增量追加是两种意图；同次传会让「不覆盖别人刚写的链接」
      // 这个承诺落空，调用方却以为自己在追加。
      if (links !== undefined && addLinks !== undefined) {
        throw new Error('update_card: links 与 addLinks 不能同时传（整体替换与增量追加互斥）')
      }
      const slots = input.slots === undefined ? undefined : normalizeSlots(input.slots)
      // 关闭卡片会释放槽位上的执行者；同次再传槽位是自相矛盾的意图，收下会让
      // 调用方以为绑定生效，实际被释放。
      if ((input.status === 'done' || input.status === 'archived')
        && slots !== undefined && Object.keys(slots).length > 0) {
        throw new Error('update_card: 关闭卡片（done / archived）会释放槽位上的执行者，同次不能再绑定槽位')
      }
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
      await assertWorkerCardScope(
        exec.agent?.id,
        { cardId: input.id.trim(), slots, status: input.status, spec },
        { isWorkerSession, cardBindingsOf },
      )
      const card = await store.update({
        id: input.id.trim(),
        ...input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision },
        ...input.title === undefined ? {} : { title: input.title.trim() },
        ...spec === undefined ? {} : { spec },
        ...input.status === undefined ? {} : { status: input.status },
        ...links === undefined ? {} : { links },
        ...addLinks === undefined ? {} : { addLinks },
        ...slots === undefined ? {} : { slots },
        ...sortOrder === undefined ? {} : { sortOrder },
      })
      return { card }
    },
  }
}

/**
 * 跨项目读卡的身份闸。
 *
 * 工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话：退役的那个会话手里
 * 仍留着 `list_cards`，直到进程重启才按普通会话重裁。跨项目读取（`scope: 'all'`
 * 与按 `cardId` 单卡查询）因此在调用时再判一次——退役会话只能按默认范围读本项目
 * 的卡，与同目录的普通会话同档。
 *
 * 判据取项目摘要里的退役集合，不用 `isCoordinatorSession()`：后者在索引未就绪时
 * 一律放行，而摘要的解析等得起一次索引重建。会话解析不到项目时无从判定，按放行
 * 处理——读类工具，且那时它连项目归属都没有。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {(sessionId: string) => Promise<object | undefined>} [resolveProject] - 项目解析
 * @returns {Promise<void>} 闸门通过
 */
async function assertCrossProjectRead(sessionId, resolveProject) {
  const project = await resolveProject?.(sessionId)
  const retired = project?.retiredCoordinatorSessionIds
  if (!Array.isArray(retired) || !retired.includes(sessionId)) return
  throw new Error('list_cards: 换下的协调者不再有跨项目查询权限——scope 用默认的 project 读本项目的卡；要读单卡完整规格请交给当前协调者')
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
      // 单卡查询不受范围限制：模型拿着 cardId 来读，要的就是那张卡。但两条路径都
      // 跨项目寻址，退役会话要先过身份闸。
      if (query.scope === 'all' || query.cardId !== undefined) {
        await assertCrossProjectRead(exec.agent?.id, resolveProject)
        const cards = await store.list()
        return { cards, query }
      }
      const project = await resolveProject?.(exec.agent?.id)
      const cards = await store.list({ projectId: project?.id ?? '' })
      return { cards, query }
    },
  }
}
