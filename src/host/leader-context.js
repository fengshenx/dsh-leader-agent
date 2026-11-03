/**
 * leader 手册在提示词中的注入点。
 *
 * 与角色槽位（`slots/`）对称：槽位由卡片绑定决定，leader 手册由**身份**决定——
 * 项目的 leader 会话天然就是这个项目的 leader，不需要任何绑定。手册放在项目目录
 * 根的 `LEADER.md`，每轮 turn 重新读取。
 *
 * 注入走运行时上下文（`systemPrompt.context`）而非 section，理由见 `slots/index.js`
 * 的头注释：section 进的是会话级固定的系统提示词消息，文件改了不会重写；运行时
 * 上下文每轮重新求值，「改动在下一轮 turn 生效」因此是结构性的。
 *
 * @module dsh-leader-kit/host/leader-context
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLOT_TEMPLATE_FILE } from './slots/slot-templates.js'

/** leader 手册文件名，位于项目目录下。 */
export const LEADER_CONTEXT_FILE = 'LEADER.md'

/**
 * 旧名手册文件，位于项目目录下。
 *
 * `LEADER.md` 还不存在时读它：按旧名初始化过的项目（含本仓自己）只有
 * `COORDINATOR.md`，不退回就等于升级即静默失去手册注入。
 */
export const LEGACY_LEADER_CONTEXT_FILE = 'COORDINATOR.md'

/** 注入项的上下文名。 */
export const LEADER_CONTEXT_NAME = 'dsh-leader-kit:leader'

/**
 * 注入项在运行时上下文里的位置。
 *
 * 排在角色槽位（105）之前：leader 手册说的是「谁在指挥这个项目」，属于身份事实，
 * 先于「我这次承担哪个角色」。
 */
export const LEADER_CONTEXT_ORDER = 104

/**
 * 已经报过「仍在用旧名」的项目目录。
 *
 * 手册每轮 turn 重新读取（运行时上下文每轮求值），提示如果不去重，一个项目
 * 每轮都往日志里刷同一条，真正的问题被淹没。按进程内目录去重：同一目录只报
 * 一次，换项目或重启进程再报。
 */
const warnedLegacyFallback = new Set()

/**
 * 已经报过「旧文件与新版内容不一致」的项目目录。去重理由同上。
 */
const warnedShadowedLegacy = new Set()

/**
 * 读一个手册文件。
 *
 * @param {string} file - 文件路径
 * @returns {{ body: string } | { missing: true } | { error: unknown }} 读取结果
 */
function readManual(file) {
  try {
    return { body: readFileSync(file, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true }
    return { error }
  }
}

/**
 * 读项目目录下的 leader 手册。
 *
 * 返回空串，不让整个插件报错，也不注入一段空壳标题——手册是增量信息，不是必需品。
 * 但两种空要分开：文件缺失（ENOENT）是常态，静默；其他读失败（EISDIR、EACCES、
 * 磁盘 I/O）要留日志，否则用户改了手册却看不到生效时无从排查。
 *
 * 文件名按 `LEADER.md` → `COORDINATOR.md` 的顺序找：旧名是升级前初始化过的项目
 * 唯一有的那个文件，退回时记一条日志提醒改名——否则用户既看不到手册换名了，
 * 也不知道为什么新加的 `COORDINATOR.md` 还在生效。两版并存时以 `LEADER.md` 为准；
 * 内容不一致说明有人改了旧文件却没同步，同样报一条（旧文件已不参与注入）。
 * 例外是**存在但只有空白**的新版：空文件不是手册，让它遮蔽旧名等于升级到空
 * `LEADER.md` 就静默失去注入，所以照样回落到旧名。
 *
 * @param {string | undefined} directory - 项目目录绝对路径
 * @param {(message: string) => void} [logger] - 日志输出
 * @returns {string} 手册正文；没有时为空串
 */
export function loadLeaderManual(directory, logger = () => {}) {
  if (typeof directory !== 'string' || directory === '') return ''
  const primary = join(directory, LEADER_CONTEXT_FILE)
  const first = readManual(primary)
  if (first.error !== undefined) {
    logger(`dsh-leader-kit: 读取 leader 手册失败（${primary}）：${first.error instanceof Error ? first.error.message : String(first.error)}`)
    return ''
  }
  const legacy = join(directory, LEGACY_LEADER_CONTEXT_FILE)
  // 新版存在时也要看一眼旧名：两版并存且内容不同，说明有人改错了文件。旧文件的
  // 读失败不算故障——它已经不参与注入，静默即可。
  const second = readManual(legacy)
  const primaryBody = first.body === undefined ? '' : first.body.trim()
  const legacyBody = second.body === undefined ? '' : second.body.trim()
  if (primaryBody !== '') {
    if (legacyBody !== ''
      && legacyBody !== primaryBody
      && !warnedShadowedLegacy.has(directory)) {
      warnedShadowedLegacy.add(directory)
      logger(`dsh-leader-kit: ${directory} 的 ${LEGACY_LEADER_CONTEXT_FILE} 与 ${LEADER_CONTEXT_FILE} 内容不一致；以 ${LEADER_CONTEXT_FILE} 为准，旧文件已不参与注入`)
    }
    return primaryBody
  }
  if (legacyBody !== '') {
    if (!warnedLegacyFallback.has(directory)) {
      warnedLegacyFallback.add(directory)
      const reason = first.body === undefined ? '不存在' : '是空的'
      logger(`dsh-leader-kit: ${directory} 的 ${LEADER_CONTEXT_FILE} ${reason}，按旧名 ${LEGACY_LEADER_CONTEXT_FILE} 注入；请把内容迁到 ${LEADER_CONTEXT_FILE}，本版本按旧名读取`)
    }
    return legacyBody
  }
  if (second.error !== undefined) {
    logger(`dsh-leader-kit: 读取 leader 手册失败（${legacy}）：${second.error instanceof Error ? second.error.message : String(second.error)}`)
  }
  return ''
}

/**
 * 项目还没有 leader 手册时的初始化提示。
 *
 * 引导卡只发一句自然的话（「这个项目还没配置，先讲讲怎么用」），作答要求放在
 * 运行时上下文里：长文本进提示词，对话里就只留一句用户可见的消息；文件建好后
 * 手册正文取代这段提示。
 *
 * 触发面限定在「用户问用法」：用户直接派活时不该被打断，所以提示里写清了
 * 只在被问到时按它回答。
 *
 * 三种「没手册」要分开说：文件不存在、文件存在但只有空白、旧名手册有内容。
 * 前两种问的是不同的事（建文件 / 补内容），第三种根本不该问——`loadLeaderManual`
 * 会回落到旧名正文，走到这里只说明调用方绕开了它。
 *
 * @param {string} directory - 项目目录绝对路径
 * @param {object} [options] - 选项
 * @param {(directory: string) => boolean} [options.isDeclined] - 该项目是否已被明确拒绝过初始化
 * @param {(directory: string) => string | undefined} [options.declinedFileOf] - 拒绝标记文件路径，
 *   写进提示让模型知道该建在哪里；拿不到路径时这一步不出现
 * @returns {string} 提示正文；手册读失败（文件存在但读不了）或用户已拒绝初始化时为空串
 */
export function renderInitializationHint(directory, { isDeclined = () => false, declinedFileOf = () => undefined } = {}) {
  const leader = readManual(join(directory, LEADER_CONTEXT_FILE))
  // 文件存在但读不了不是「没初始化」：loadLeaderManual 已经记过日志，这里再提示
  // 会让用户去建一个已经存在的文件。
  if (leader.error !== undefined) return ''
  if (leader.body !== undefined && leader.body.trim() !== '') return ''
  const legacy = readManual(join(directory, LEGACY_LEADER_CONTEXT_FILE))
  if (legacy.body !== undefined && legacy.body.trim() !== '') return ''
  if (isDeclined(directory)) return ''
  const slots = readManual(join(directory, SLOT_TEMPLATE_FILE))
  const hasSlots = slots.body !== undefined && slots.body.trim() !== ''
  const missingLeader = leader.body === undefined
  const slotsClause = hasSlots ? '' : `\`${SLOT_TEMPLATE_FILE}\`（执行者角色手册）`
  const declinedFile = declinedFileOf(directory)
  const declinedStep = declinedFile === undefined
    ? []
    : [`4. 用户明确说不需要初始化时，建一个空文件 \`${declinedFile}\`（这是插件的本机数据目录，不在项目仓库里），此后这段提示不再出现；不要写别的内容，也不要删改用户已有的文件。`]
  return [
    '## 项目待初始化',
    '',
    missingLeader
      ? (hasSlots
        ? `这个项目还没有 \`${LEADER_CONTEXT_FILE}\`（leader 工作方法）。`
        : `这个项目还没有 \`${LEADER_CONTEXT_FILE}\`（leader 工作方法）与 ${slotsClause}。`)
      : (hasSlots
        ? `这个项目的 \`${LEADER_CONTEXT_FILE}\` 还是空的（只有空白），需要补上内容。`
        : `这个项目的 \`${LEADER_CONTEXT_FILE}\` 还是空的（只有空白），也没有 ${slotsClause}。`),
    '',
    '用户第一次问这个项目怎么用、怎么开始，或问 dsh-leader-kit 是什么时，按这个顺序回答：',
    '',
    '1. 说明 dsh-leader-kit 怎么工作：你负责拆解目标、建任务卡、派工；worker 在各自的工作区干活并回报；用户在看板上跟进进度、审核与验收。一个任务一张卡，卡上标出执行者。',
    '2. 说明两份文件各解决什么，然后问用户是否现在初始化。',
    '3. 用户明确同意后，加载 `init-leader-kit` skill 并按它执行：目录里已有的文档先读，目录是空的就写带 TODO 的骨架，不要编造项目内容。',
    ...declinedStep,
    '',
    '用户没同意前不要创建或修改任何文件；已经问过、用户还没回答时不要重复追问。用户直接派活时不要打断，按正常流程干活。',
  ].join('\n')
}

/**
 * 渲染 leader 的手册上下文。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 会话 id
 * @param {(sessionId: string) => string | undefined} options.resolveDirectory - 取会话所属项目目录；
 *   只有该项目的 leader 会话才有值，普通会话与 worker 返回 undefined
 * @param {(directory: string) => boolean} [options.isDeclined] - 该项目是否已被拒绝过初始化
 * @param {(directory: string) => string | undefined} [options.declinedFileOf] - 拒绝标记文件路径
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {string} 上下文文本；不是 leader、目录不可得或手册读失败时为空串
 */
export function renderLeaderContext({ sessionId, resolveDirectory, isDeclined = () => false, declinedFileOf = () => undefined, logger = () => {} }) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const directory = resolveDirectory(sessionId)
  if (typeof directory !== 'string' || directory === '') return ''
  const body = loadLeaderManual(directory, logger)
  if (body === '') return renderInitializationHint(directory, { isDeclined, declinedFileOf })
  return [
    '## leader 手册',
    '',
    `你是项目 ${directory} 的 leader。以下是该项目在 \`${LEADER_CONTEXT_FILE}\` 中为 leader 写下的工作方法。`,
    '',
    body,
  ].join('\n')
}

/**
 * 注册 leader 手册注入。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {(sessionId: string) => string | undefined} options.resolveDirectory - 取 leader 会话的项目目录
 * @param {(directory: string) => boolean} [options.isDeclined] - 该项目是否已被拒绝过初始化
 * @param {(directory: string) => string | undefined} [options.declinedFileOf] - 拒绝标记文件路径
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {void}
 */
export function applyLeaderContext({ ctx, resolveDirectory, isDeclined = () => false, declinedFileOf = () => undefined, logger = () => {} }) {
  ctx.effect(() => ctx.systemPrompt.context({
    name: LEADER_CONTEXT_NAME,
    order: LEADER_CONTEXT_ORDER,
    // 手册是项目里可编辑的 Markdown，可能含 `{{`——按字面量处理，不做插值。
    interpolate: false,
    required: true,
    text: (context) => {
      const sessionId = context.agent?.id
      if (typeof sessionId !== 'string') return ''
      try {
        return renderLeaderContext({ sessionId, resolveDirectory, isDeclined, declinedFileOf, logger })
      } catch (error) {
        // 求值失败会让整个 turn 崩掉。手册是增量信息，取不到就当没有。
        logger(`dsh-leader-kit: 渲染 leader 手册失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-leader-kit leader 手册注入')
}
