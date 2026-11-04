/**
 * 角色槽位到提示词文本的投影。
 *
 * 一个会话是否注入角色正文，取决于它有没有被绑到某张卡片的槽位上。绑定的真源是
 * 卡片库里的 `slots` 字段（`{ 槽位名: { sessionId } }`），本模块只做反查与渲染：
 *
 * - 反查：会话 id → 槽位名。宿主侧是内存索引，因为提示词组装函数是同步的，
 *   不能在里面 `await` 去读异步的卡片库。
 * - 渲染：槽位名 → 项目目录下的 `SLOTS.md` 正文。
 *
 * 槽位配置读的是**项目目录**下的 `SLOTS.md`，不是会话自己的目录：项目是编排
 * 容器，手册属于项目。worker 与 leader 在同一个项目目录里运行，两边读到的是同一
 * 份手册。
 *
 * 注入是**加法**：槽位只贡献一段角色说明，不注册工具、不改工具可见性——dsh
 * 没有角色权限模型，槽位也不应该被当成权限授予。
 *
 * @module dsh-leader-agent/host/slots/role-context
 */

import { loadSlotTemplates } from './slot-templates.js'

/**
 * 渲染一个会话的角色上下文。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 会话 id
 * @param {Map<string, string>} options.slotIndex - 会话 id 到槽位名的反查索引
 * @param {((sessionId: string) => string | undefined)} options.resolveDirectory - 取会话所属项目目录
 * @returns {string} 角色上下文文本；无角色时为空串
 */
export function renderRoleContext({ sessionId, slotIndex, resolveDirectory }) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const slotName = slotIndex.get(sessionId)
  if (slotName === undefined) return ''
  const directory = resolveDirectory(sessionId)
  if (directory === undefined || directory === '') return ''
  const slot = loadSlotTemplates(directory).get(slotName)
  if (slot === undefined || slot.body === '') return ''
  return [
    '## 角色槽位',
    '',
    `你当前承担「${slotName}」槽位的角色。以下是该槽位在项目 ${directory} 中定义的方法与人设。`,
    '它只描述你的工作方法，不授予你任何工具权限——可用工具由宿主决定。',
    '',
    slot.body,
  ].join('\n')
}
