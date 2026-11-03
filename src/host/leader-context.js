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
  if (first.body !== undefined) {
    if (second.body !== undefined
      && first.body.trim() !== second.body.trim()
      && !warnedShadowedLegacy.has(directory)) {
      warnedShadowedLegacy.add(directory)
      logger(`dsh-leader-kit: ${directory} 的 ${LEGACY_LEADER_CONTEXT_FILE} 与 ${LEADER_CONTEXT_FILE} 内容不一致；以 ${LEADER_CONTEXT_FILE} 为准，旧文件已不参与注入`)
    }
    return first.body.trim()
  }
  if (second.body !== undefined) {
    if (!warnedLegacyFallback.has(directory)) {
      warnedLegacyFallback.add(directory)
      logger(`dsh-leader-kit: ${directory} 仍在使用旧名 ${LEGACY_LEADER_CONTEXT_FILE}；请改名为 ${LEADER_CONTEXT_FILE}，本版本按旧名读取`)
    }
    return second.body.trim()
  }
  if (second.error !== undefined) {
    logger(`dsh-leader-kit: 读取 leader 手册失败（${legacy}）：${second.error instanceof Error ? second.error.message : String(second.error)}`)
  }
  return ''
}

/**
 * 渲染 leader 的手册上下文。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 会话 id
 * @param {(sessionId: string) => string | undefined} options.resolveDirectory - 取会话所属项目目录；
 *   只有该项目的 leader 会话才有值，普通会话与 worker 返回 undefined
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {string} 上下文文本；不是 leader、目录不可得或手册为空时为空串
 */
export function renderLeaderContext({ sessionId, resolveDirectory, logger = () => {} }) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const directory = resolveDirectory(sessionId)
  const body = loadLeaderManual(directory, logger)
  if (body === '') return ''
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
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {void}
 */
export function applyLeaderContext({ ctx, resolveDirectory, logger = () => {} }) {
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
        return renderLeaderContext({ sessionId, resolveDirectory, logger })
      } catch (error) {
        // 求值失败会让整个 turn 崩掉。手册是增量信息，取不到就当没有。
        logger(`dsh-leader-kit: 渲染 leader 手册失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-leader-kit leader 手册注入')
}
