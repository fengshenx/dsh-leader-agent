/**
 * 任务看板卡片工具：`create_card`、`update_card`、`list_cards`。
 *
 * 卡片是 leader 维护的任务事实：标题、规格、状态、链接与槽位绑定。看板 UI 从工具
 * 的结构化输出重建卡片列表，因此工具返回完整卡片对象；模型看到的是 `render`
 * 给出的简短确认，不需要读全量卡片。
 *
 * @module dsh-leader-agent/host/tools/cards
 */

import { randomUUID } from 'node:crypto'
import { normalizeHttpUrl } from '../../shared/card-links.js'
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  SPEC_PAGE_CHARS,
  parseListQuery,
  renderCardDetailText,
  renderCardList,
  sliceSpec,
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

/** 卡片分类标签的最大字符数。 */
const KIND_MAX_CHARS = 24

/**
 * 校验卡片分类。
 *
 * 分类是卡面头部的只读短标签（如「研发」「方案」），不是自由文本：换行会把
 * 头部撑成两行，超长在卡面上只能截断。空串是「清除分类」的显式意图，与省略
 * （不改）区分——改卡需要这条区别。
 *
 * @param {unknown} value - 字段值
 * @returns {string | undefined} 规范化后的分类；省略时为 undefined，清除时为空串
 */
function normalizeKind(value) {
  const text = optionalString(value, 'kind')
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed === '') return ''
  // U+2028 / U+2029 / \v / \f / NEL 在 white-space: normal 下不一定换行，但都会让
  // 单行标签的判据与承诺脱节（卡面哪天改成 pre-wrap 就露出来）：一律拒。
  if (/[\r\n\u2028\u2029\v\f\u0085]/.test(trimmed)) {
    throw new Error('卡片工具: kind 不能换行')
  }
  // 按码点计数：`length` 数的是 UTF-16 码元，13 个 emoji 会被当成 26 个字符拒掉，
  // 报错里的数字还与他数出来的对不上。
  const chars = [...trimmed].length
  if (chars > KIND_MAX_CHARS) {
    throw new Error(`卡片工具: kind 最长 ${KIND_MAX_CHARS} 个字符，收到 ${chars} 个`)
  }
  return trimmed
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
      kind: { type: 'string' },
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
  return { kind: 'dsh-leader-agent-cards', scope, cards }
}

/**
 * 卡片写入的身份闸。
 *
 * 工具面在 `agent/created` 一次性裁，而换 leader 不重建旧会话：退役的那个会话手里
 * 仍留着 `create_card` / `update_card`，直到下次会话重建才按普通会话重裁。因此
 * 每次写入再判一次当前身份——退役者与普通会话同档，不能写卡。
 *
 * 判定可以是异步的：索引未就绪时问不出谁是 leader，判据要先等一次重建结果，口径
 * 与派工一致（见 `canWriteCardsFor`）。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {((sessionId: string | undefined) => boolean | Promise<boolean>) | undefined} canWrite -
 *   写卡身份判定；省略时放行，仅供文档取名字与单测构造
 * @returns {Promise<void>} 闸门通过
 * @throws {Error} 调用方不是 leader 也不是 worker
 */
async function assertCardWriter(sessionId, canWrite) {
  if (typeof canWrite !== 'function') return
  if ((await canWrite(sessionId)) === true) return
  throw new Error('卡片工具: 只有 leader 与 worker 能写卡（项目注册表尚未读出时同样拒绝）——普通会话不在任何项目编排里，没有卡可写')
}

/**
 * 建卡的身份闸：worker 不能建卡。
 *
 * 协议层的建卡动作全部属于 leader（`LEADER.md` 的「一个 worker 一张卡」、
 * `leader-mode` 的 leader 动作表），`SLOTS.md` 的各槽位也没有让执行者建卡的步骤——
 * worker 攒下的待办由它回报、leader 建卡并派工。放开这个口子会造出没有槽位、
 * 没人认领的卡，和普通会话建卡是同一种问题，只是少一道工具面拒绝。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {((sessionId: string | undefined) => boolean) | undefined} isWorkerSession - worker 判定
 * @returns {void}
 * @throws {Error} 调用方是 worker
 */
function assertCardCreator(sessionId, isWorkerSession) {
  if (typeof isWorkerSession !== 'function' || isWorkerSession(sessionId) !== true) return
  throw new Error('create_card: worker 不建卡——卡由 leader 建并派工；需要新任务请在回报里说明，交付物挂到自己卡上用 update_card 的 addLinks')
}

/**
 * worker 的写卡范围闸：只允许改自己挂着的卡，且不许动槽位绑定。
 *
 * 身份闸只回答「能不能写卡」，回答不了「写哪张、写什么」。对 worker 有五条：
 *
 * - **只能改自己挂着的卡**：worker 的 cwd 就是项目目录，同项目里别的 worker 的卡
 *   它一样能改；改别人的卡会把产物落错地方。
 * - **不能改槽位绑定**：整卡替换 `slots` 正是投递门禁（`dispatch.js` 的
 *   `assertCardGateOpen`）认定必须拦下的坏状态（一个会话同时挂多张 active 卡）。
 * - **不能改状态**：`done` / `archived` 会释放执行者、抽走卡片上下文，是 leader 的
 *   收工动作；重开同样是它的指派动作。worker 连合并与 approve 都不决定，判不了完成。
 * - **不能改规格**：`spec` 是 leader 维护的目标、范围与验收（`program.md` 的「`status`
 *   与 `spec` 仍归 leader」、`implementation.md` 的「卡片规格与状态仍由 leader 维护」）。
 *   worker 的进展与产物走回报正文与 `links`，不往 spec 里写——那会改掉验收锚点，
 *   也会冲掉 `expectedRevision`。
 * - **不能改标题**：标题与 spec 走同一条注入通道（`SKILL.md` 的卡片事实一节），
 *   同是看板与回执里的可读标识。`title: '范围：只改文档；验收：不新增依赖'` 一样
 *   能把规格语义塞回来，只收 `spec` 等于留了个旁路。
 *
 * leader 不受这条约束：它本来就在管整个项目。
 *
 * @param {string} sessionId - 调用方会话 id
 * @param {object} input - 本次写入的意图
 * @param {string} input.cardId - 目标卡 id
 * @param {object | undefined} input.slots - 要写入的槽位绑定
 * @param {string | undefined} input.status - 要写入的状态
 * @param {string | undefined} input.spec - 要写入的规格
 * @param {string | undefined} input.title - 要写入的标题
 * @param {string | undefined} input.kind - 要写入的分类
 * @param {number | undefined} input.sortOrder - 要写入的手动排序序号
 * @param {object} options - 判定依赖
 * @param {((sessionId: string | undefined) => boolean) | undefined} options.isWorkerSession - worker 判定
 * @param {((sessionId: string) => Promise<object[]>) | undefined} options.cardBindingsOf - 会话的卡片绑定
 * @returns {Promise<void>} 范围校验通过
 * @throws {Error} 目标卡不在 worker 的绑定里，或试图改槽位绑定、改状态、改规格、改标题、改分类、改排序
 */
async function assertWorkerCardScope(sessionId, { cardId, slots, status, spec, title, kind, sortOrder }, { isWorkerSession, cardBindingsOf }) {
  if (typeof isWorkerSession !== 'function' || isWorkerSession(sessionId) !== true) return
  if (slots !== undefined) {
    throw new Error('update_card: worker 不能改卡片的槽位绑定——换执行者请在 leader 会话里做')
  }
  if (status !== undefined) {
    throw new Error('update_card: worker 不能改卡片状态——完成由 leader 验收后判定（done / archived 会释放执行者），重开也是 leader 的指派动作；请把交付物挂到 links 并在回报里说明已完成')
  }
  if (spec !== undefined) {
    throw new Error('update_card: worker 不能改卡片规格——spec 是 leader 维护的目标、范围与验收；进展与产物写进回报、链接挂到 links')
  }
  if (title !== undefined) {
    throw new Error('update_card: worker 不能改卡片标题——标题与 spec 走同一条注入通道，只在回执里写进展；交付物挂到 links')
  }
  if (kind !== undefined) {
    throw new Error('update_card: worker 不能改卡片分类——分类是 leader 对任务流的归类，交付物挂到 links、进展写进回报')
  }
  if (sortOrder !== undefined) {
    throw new Error('update_card: worker 不能改卡片排序——排序是 leader 对看板的组织动作，交付物挂到 links、进展写进回报')
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
 *   worker 不建卡，建卡与派工是 leader 的一条动作链
 * @returns {object} dsh 工具定义
 */
export function createCreateCardTool({ store, resolveProject, canWrite, isWorkerSession }) {
  return {
    name: 'create_card',
    description:
      '建立一张任务看板卡片。卡片是 leader 维护的任务事实，编号自动分配且永不复用，可用返回的 number 引用。worker 不建卡：新任务由 leader 建卡并派工。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，一句话说清要做什么。' },
        spec: {
          type: 'string',
          description: '任务规格：任务简报与验收标准。leader 验收判断与 worker 防漂移的锚点。',
        },
        kind: {
          type: 'string',
          description: `分类标签：卡面头部显示在编号后的短标签（如「研发」「方案」「文档」），最长 ${KIND_MAX_CHARS} 个字符、不能换行；省略即未分类。同一项目的卡用同一套分类名，卡面才能扫读。`,
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
      const input = /** @type {{ title: string, spec?: string, kind?: string, links?: object[], slots?: object, checkpoint?: unknown }} */ (args)
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
      const kind = normalizeKind(input.kind)
      const links = input.links === undefined ? undefined : normalizeLinks(input.links)
      const slots = input.slots === undefined ? undefined : normalizeSlots(input.slots)
      // 卡片归属项目由宿主按调用方会话判定，模型不传项目参数：模型未必知道自己是
      // 在哪个项目的语境里调用工具，判据交给会话这一侧的事实更可靠。
      const project = await resolveProject?.(exec.agent?.id)
      const card = await store.create({
        title: input.title.trim(),
        ...spec === undefined ? {} : { spec },
        // 建卡时空串与省略同义：新卡没有分类可清除
        ...kind === undefined || kind === '' ? {} : { kind },
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
      '更新一张任务看板卡片。带 expectedRevision 时做乐观并发校验，版本不符即报错，需重新读卡再改。链接用 addLinks 增量追加（不会覆盖别人刚写的条目），整份替换才用 links。归档是终态，不能再改。卡片按项目归属，只能改本项目的卡；worker 只能改自己挂着的卡，且不能改状态、规格、标题、分类、排序与槽位绑定。',
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
        kind: {
          type: 'string',
          description: `新分类标签（最长 ${KIND_MAX_CHARS} 个字符、不能换行）；传空串清除分类。`,
        },
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
      const input = /** @type {{ id: string, expectedRevision?: number, title?: string, spec?: string, kind?: string, status?: string, links?: object[], addLinks?: object[], slots?: object, sortOrder?: number, checkpoint?: unknown }} */ (args)
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
      // 权限先于取值：worker 根本不能碰分类，先规范化会让「超长」先报出来，
      // 让它以为改短一点就能改。
      await assertWorkerCardScope(
        exec.agent?.id,
        { cardId: input.id.trim(), slots, status: input.status, spec, title: input.title, kind: input.kind, sortOrder },
        { isWorkerSession, cardBindingsOf },
      )
      const kind = normalizeKind(input.kind)
      const card = await store.update({
        id: input.id.trim(),
        ...input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision },
        ...input.title === undefined ? {} : { title: input.title.trim() },
        ...spec === undefined ? {} : { spec },
        ...kind === undefined ? {} : { kind },
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
 * 工具面在 `agent/created` 一次性裁，而换 leader 不重建旧会话：退役的那个会话手里
 * 仍留着 `list_cards`，直到进程重启才按普通会话重裁。跨项目读取（`scope: 'all'`
 * 与按 `cardId` 单卡查询）因此在调用时再判一次——退役会话只能按默认范围读本项目
 * 的卡，与同目录的普通会话同档。
 *
 * 判据取项目摘要里的退役集合，不用 `isLeaderSession()`：后者在索引未就绪时
 * 一律放行，而摘要的解析等得起一次索引重建。会话解析不到项目时无从判定，按放行
 * 处理——读类工具，且那时它连项目归属都没有。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {(sessionId: string) => Promise<object | undefined>} [resolveProject] - 项目解析
 * @returns {Promise<void>} 闸门通过
 */
async function assertCrossProjectRead(sessionId, resolveProject) {
  const project = await resolveProject?.(sessionId)
  const retired = project?.retiredLeaderSessionIds
  if (!Array.isArray(retired) || !retired.includes(sessionId)) return
  throw new Error('list_cards: 换下的 leader 不再有跨项目查询权限——scope 用默认的 project 读本项目的卡；要读单卡完整规格请交给当前 leader')
}

/**
 * 读卡的身份闸：只有 worker 能读。
 *
 * 工具面已经把 `read_card` 从 leader 与普通会话里摘掉（`gate.js` 的
 * `WORKER_ONLY_TOOLS`）。这里再判一次是兜底：本工具有个「不传卡片」的默认分支，
 * 它按调用方的会话绑定反查，而只有 worker 有绑定；身份变化（换 leader、冷恢复）
 * 不该让读卡落到别的角色手里。leader 读卡用 `list_cards`（传 cardId）。
 *
 * @param {string | undefined} sessionId - 调用方会话 id
 * @param {((sessionId: string | undefined) => boolean) | undefined} isWorkerSession - worker 判定
 * @returns {void}
 * @throws {Error} 调用方不是 worker
 */
function assertCardReader(sessionId, isWorkerSession) {
  if (typeof isWorkerSession !== 'function') return
  if (isWorkerSession(sessionId) === true) return
  throw new Error('read_card: 只有 worker 能读卡——leader 用 list_cards（传 cardId）读单卡，普通会话不在项目编排里')
}

/**
 * 解析本次要读的卡。
 *
 * 三种入口：显式 cardId、显式 number、两者都不传（读调用方唯一绑定的卡）。第三条
 * 是 worker 找回自己任务的兜底路径：压缩、注入失效、或会话冷恢复后它手里可能没有
 * cardId。「唯一」是硬条件——多张卡时报错并列出候选，不替调用方猜，猜错会让它对着
 * 另一张卡的规格干活。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 调用方会话 id
 * @param {{ cardId?: unknown, number?: unknown }} options.input - 工具入参
 * @param {{ get: (id: string) => Promise<object | undefined>, list: (filter?: object) => Promise<object[]> }} options.store - 卡片存储
 * @param {((sessionId: string) => Promise<object[]>) | undefined} options.cardBindingsOf - 会话的卡片绑定
 * @returns {Promise<object>} 目标卡
 * @throws {Error} 参数冲突、卡片不存在、没有绑定、绑定多张、绑定指向的卡已不存在
 */
async function resolveReadTargetCard({ sessionId, input, store, cardBindingsOf }) {
  if (input.cardId !== undefined && input.number !== undefined) {
    throw new Error('read_card: cardId 与 number 只能传一个')
  }
  if (input.cardId !== undefined) {
    if (typeof input.cardId !== 'string' || input.cardId.trim() === '') {
      throw new Error('read_card: cardId 必须是非空字符串')
    }
    const card = await store.get(input.cardId.trim())
    if (card === undefined) {
      throw new Error(`read_card: 卡片不存在：cardId=${input.cardId.trim()}`)
    }
    return card
  }
  if (input.number !== undefined) {
    if (typeof input.number !== 'number' || !Number.isInteger(input.number) || input.number < 1) {
      throw new Error(`read_card: number 必须是正整数，收到 ${describeValue(input.number)}`)
    }
    const card = (await store.list()).find((item) => item.number === input.number)
    if (card === undefined) {
      throw new Error(`read_card: 没有 #${input.number} 这张卡；编号从 1 起且不复用，请确认 leader 给的编号`)
    }
    return card
  }
  if (typeof cardBindingsOf !== 'function') {
    throw new Error('read_card: 缺少会话的卡片绑定索引，读不到默认卡；请传 cardId 或 number')
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('read_card: 会话 id 不可用，读不到默认卡；请传 cardId 或 number')
  }
  const bindings = await cardBindingsOf(sessionId)
  if (bindings.length === 0) {
    throw new Error('read_card: 你没有绑定任何卡——任务可能已被 leader 关闭或改派；先回报现状、等指示。要读别的卡请传 cardId 或 number')
  }
  // 同一张卡可以同时挂多个槽位（如 dev + review），唯一性按卡片算、不按绑定条数算。
  const cards = [...new Map(bindings.map((binding) => [binding.cardId, binding])).values()]
  if (cards.length > 1) {
    const candidates = cards
      .map((binding) => `#${binding.number}（cardId: ${binding.cardId}，槽位 ${binding.slot}）`)
      .join('、')
    throw new Error(`read_card: 你同时挂着 ${cards.length} 张卡，无法确定读哪张——请传 cardId 或 number。候选：${candidates}`)
  }
  const binding = cards[0]
  const card = await store.get(binding.cardId)
  if (card === undefined) {
    throw new Error(`read_card: 绑定 #${binding.number}（cardId: ${binding.cardId}）指向的卡已不存在，请回报 leader`)
  }
  return card
}

/**
 * 读卡的项目范围闸：只能读本项目的卡。
 *
 * 与 `update_card` 同判据：调用方自己的范围就是它所在的项目（不在任何项目里就是
 * 空串）。无归属的存量卡放行——没有归属可冲突，拦下来只会让存量卡永远读不到。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 调用方会话 id
 * @param {object} options.card - 目标卡
 * @param {((sessionId: string | undefined) => Promise<object | undefined>) | undefined} options.resolveProject - 项目解析
 * @returns {Promise<void>} 范围校验通过
 * @throws {Error} 目标卡属于另一个项目
 */
async function assertReadScope({ sessionId, card, resolveProject }) {
  const project = await resolveProject?.(sessionId)
  const owner = typeof card?.projectId === 'string' ? card.projectId : ''
  const scope = typeof project?.id === 'string' ? project.id : ''
  if (owner !== '' && owner !== scope) {
    throw new Error(`read_card: 卡片 #${card.number} 属于另一个项目，不能跨项目读卡`)
  }
}

/**
 * 创建 `read_card` 工具定义。
 *
 * 只给 worker：leader 的单卡读走 `list_cards`（全文、不截断），普通会话不在项目
 * 编排里。与注入通道的关系是**冗余**而不是替代——`dsh-leader-agent:task-card`
 * 上下文每轮求值，是本工具有效时的主通道；本工具直读落盘的卡片库，兜住注入失效、
 * 快照被压缩、以及「改卡前确认 revision」这几类需要当下真源的场景。
 *
 * 规格按 `SPEC_PAGE_CHARS` 分页：worker 可能连着读好几张卡，一次给全文会把上下文
 * 灌满。分页只影响事实的呈现方式，不影响 `revision` 等其余字段。
 *
 * 不做 `presentationMeta`：看板的数据源是宿主的项目通道，工具投影只进会话历史；
 * 读操作不产生新事实，投影只会往日志里塞一份重复快照。而且返回的 `card.spec`
 * 只是当前一页，`scope: 'card'` 的投影会把看板上的完整规格覆盖成片段。
 *
 * @param {object} options - 工具选项
 * @param {{ get: (id: string) => Promise<object | undefined>, list: (filter?: object) => Promise<object[]> }} options.store - 卡片存储
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] -
 *   解析调用方会话所属项目；跨项目读卡会被拒绝
 * @param {(sessionId: string | undefined) => boolean} [options.isWorkerSession] - worker 判定；
 *   省略时放行，仅供文档取名字与单测构造
 * @param {(sessionId: string) => Promise<object[]>} [options.cardBindingsOf] - 会话挂着的卡；
 *   不传卡片时用它反查「我的卡」
 * @returns {object} dsh 工具定义
 */
export function createReadCardTool({ store, resolveProject, isWorkerSession, cardBindingsOf }) {
  return {
    name: 'read_card',
    description:
      `读一张任务卡的当前事实：标题、状态、规格、链接、槽位与 revision。不传 cardId 与 number 时读这个 worker 被分配的卡——只有唯一绑定时直接返回，没绑卡或同时挂着多张都会报错并给出下一步。规格按 ${SPEC_PAGE_CHARS} 码点分页，长规格用返回的 specPage.nextOffset 作为 specOffset 续读直到读全；改卡前确认 revision 也用它，它读的是落盘真源，不是注入快照。`,
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: '卡片 id（任务卡上下文里有）。与 number 二选一；两个都省略时读你被分配的那张卡。',
        },
        number: {
          type: 'number',
          description: '卡片编号（如 leader 消息里的 #12）。与 cardId 二选一。',
        },
        specOffset: {
          type: 'number',
          description: '规格起始字符位置，默认 0；上一页还有更多时按返回的 nextOffset 继续读。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          card: cardSchema(),
          specPage: {
            type: 'object',
            properties: {
              offset: { type: 'number' },
              chars: { type: 'number' },
              total: { type: 'number' },
              hasMore: { type: 'boolean' },
              nextOffset: { type: 'number' },
            },
            required: ['offset', 'chars', 'total', 'hasMore'],
          },
        },
        required: ['card', 'specPage'],
      },
      render(args, value) {
        const result = /** @type {{ card: object, specPage: object }} */ (value)
        return [{ type: 'text', text: renderCardDetailText(result.card, result.specPage) }]
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ cardId?: unknown, number?: unknown, specOffset?: unknown }} */ (args ?? {})
      const sessionId = exec.agent?.id
      assertCardReader(sessionId, isWorkerSession)
      const card = await resolveReadTargetCard({ sessionId, input, store, cardBindingsOf })
      await assertReadScope({ sessionId, card, resolveProject })
      const specPage = sliceSpec(card.spec, input.specOffset === undefined ? 0 : input.specOffset)
      return {
        // `spec` 是本页片段，不是全文：`specPage` 说明窗口位置，调用方按它续读。
        card: { ...card, spec: specPage.text },
        specPage,
      }
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
