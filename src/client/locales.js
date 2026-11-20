/**
 * 本插件界面文案的字典。
 *
 * 槽位名是机器标识：`SLOTS.md` 的分节名、卡片 `slots` 的 JSON 键、槽位注入的
 * 反查键都用它，形态固定为小写 ASCII（见 `src/host/slots/slot-templates.js`）。
 * 界面上的名字不跟标识走——这里按当前界面语言翻译内置槽位名，卡面 chip 与
 * 提示文案都用翻译后的名字。
 *
 * 槽位名之外的用户可见文案也挂在同一个命名空间：宿主的 `locale/*.json` 只贡献
 * 插件显示名（`package-meta.ts` 只读 `title` / `description`），界面字符串走
 * `ctx.locale.register`。tab 标题、guide 说明、左栏 label 这些注册期文案由
 * `ctx.locale.bind` 在**取用时**读当前语言（宿主把 thunk 重读一遍）。
 *
 * 槽位名部分只放内置槽位的默认显示名。项目在 `SLOTS.md` 每节用 `label:` 声明
 * 自己的名字，优先级高于这份字典（`slotDisplayName`）；两者都没有时显示槽位名
 * 本身——不会因为缺翻译就看不见。
 *
 * @module dsh-leader-agent/client/locales
 */

/** 本插件的 locale 命名空间。 */
export const SLOT_LOCALE_NAMESPACE = 'dsh-leader-agent'

/**
 * 槽位名到字典键。
 *
 * 内置槽位（`DEFAULT_SLOT_NAMES`）在这里必须有键；`discuss` 不在默认槽位里，
 * 保留翻译是为了项目自己加同名槽位时仍显示中文。新增内置槽位时两处一起改。
 */
export const SLOT_LABEL_KEYS = Object.freeze({
  discuss: 'slot.discuss',
  dev: 'slot.dev',
  review: 'slot.review',
})

/** 简体中文字典（键集的事实来源）。 */
export const zh = Object.freeze({
  'slot.discuss': '讨论',
  'slot.dev': '开发',
  'slot.review': '审核',
  'guide.title': '这个目录有一个 Leader 了',
  'guide.steps': '你可以让它建任务卡、给 Agent 派活，在右栏看板跟进',
  'guide.action.intro': '了解怎么用',
  'guide.action.dismiss': '知道了',
  'guide.intro.prompt': '这个项目还没配置，先讲讲 dsh-leader-agent 怎么用。',
  'tabs.list': '项目会话标签',
  'tabs.close': '关闭标签',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.collapse': '收起',
  'common.save': '保存',
  'common.saving': '保存中…',
  'tab.board': '看板',
  'tab.board.description': '项目 leader 与 worker 会话里的任务交付看板',
  'project.label': '项目',
  'project.empty': '还没有项目。加一个即在它的目录里建好 leader 会话。',
  'project.add': '加项目：选一个目录',
  'project.create': '建项目',
  'project.collapseList': '收起项目列表',
  'project.expandList': '展开项目列表',
  'project.collapseSessions': '收起会话',
  'project.expandSessions': '展开会话',
  'project.noSessions': '该项目下还没有会话。',
  'project.replaceLeader': '换新 Leader',
  'project.more': '更多',
  'project.completedUnread': '已完成，待查看',
  'project.archive': '归档会话：从列表移除，并摘掉卡片上绑定的槽位',
  'project.archive.aria': '归档会话 {title}',
  'project.rename': '重命名',
  'project.remove': '删除',
  'project.remove.title': '删除项目',
  'project.remove.description': '将把项目「{name}」删除。文件夹、会话记录与 dsh 工作区都会保留。',
  'project.remove.notice': '已删除项目「{name}」。',
  'project.name.empty': '项目名不能为空',
  'project.name.tooLong': '项目名过长（上限 {max} 字）',
  'project.leaderMissing': '项目「{name}」没有可打开的 leader 会话，请换新 Leader。',
  'project.leaderDeleted': '项目「{name}」的 leader 会话已被删除，请换新 Leader。',
  'project.remoteNotReady': '项目通道未就绪。',
  'project.error.read': '读取项目失败：{message}',
  'project.error.sessions': '读取项目会话失败：{message}',
  'project.error.create': '建项目失败：{message}',
  'project.error.rename': '改名失败：{message}',
  'project.error.reorder': '调整项目顺序失败：{message}',
  'project.error.replaceLeader': '换新 Leader 失败：{message}',
  'project.error.delete': '删除失败：{message}',
  'project.error.deleteReason': '删除失败。',
  'project.error.navigation': '导航服务不可用：无法打开会话。',
  'project.error.directoryPicker': '目录选择器不可用：当前宿主无法选择目录，请换用 web profile 后再试。',
  'project.error.workspaces': '工作区服务不可用：无法归档会话。',
  'project.error.archive': '归档会话失败：{message}',
  'project.error.archivePartial': '会话已归档，但摘卡失败：{message}',
  'project.error.stopArchive': '停止并归档失败：{message}',
  'project.archive.title': '会话还在执行',
  'project.archive.description': '这个会话正在跑。归档会先停掉它的任务，再从列表移除并摘掉卡片上绑定的槽位。会话记录保留。',
  'project.archive.confirm': '停止并归档',
  'session.fold.expand': '展开其余 {count} 个会话',
  'board.fold.expand': '展开其余 {count} 张卡',
  'board.done': '已完成',
  'board.empty.title': '还没有卡片',
  'board.empty.hint': 'leader 调用 create_card 后，卡片会出现在这里',
  'board.empty.doneTitle': '全部完成',
  'board.empty.doneHintOwn': '本项目的卡片都已完成',
  'board.empty.doneHintNamed': '「{project}」的卡片都已完成',
  'board.noProject.title': '当前会话不属于任何项目',
  'board.noProject.hint': '看板按项目组织：在项目会话（leader 或 worker）里打开它。',
  'board.leaderDead.title': '该项目的 leader 会话已失效',
  'board.leaderDead.hint': '请在左栏项目区块对该项目换新 Leader，再打开看板。',
  'board.notProject.title': '看板只在项目会话中打开',
  'board.notProject.hint': '这是「{project}」所在目录里的普通会话；去该项目的 leader 或 worker 会话查看交付看板。',
  'board.thisProject': '本项目',
  'board.error.project': '读取项目失败：{message}',
  'board.error.cards': '读取卡片失败：{message}',
  'board.error.delete': '删除失败：{message}',
  'board.delete.title': '删除卡片',
  'board.slot.title': '{name}：{state}',
  'board.state.waiting': '等你输入',
  'board.state.attention': '需注意',
  'board.state.running': '执行中',
  'board.state.unread': '未读',
  'board.state.idle': '空闲',
  'board.state.empty': '未派工',
  'board.state.unknown': '状态未知',
  'board.state.none': '无信号',
  'card.status.done': '已完成',
  'card.status.archived': '已归档',
  'card.status.active': '进行中',
  'card.detail.empty': '这张卡还没有写说明。',
  'card.detail.spec': '说明',
  'card.detail.links': '链接',
  'card.detail.editLinks': '编辑链接',
  'card.detail.delete': '删除卡片',
  'card.detail.remove': '将删除卡片 #{number}「{title}」。删除后不可恢复，编号不会再分配，卡片上的槽位绑定会一并解除。',
  'card.links.empty': '这张卡还没有挂链接。',
  'card.links.label': '标签',
  'card.links.labelAria': '链接标签',
  'card.links.urlAria': '链接 URL',
  'card.links.remove': '移除链接',
  'card.links.addPurpose': '添加用途',
  'card.links.purpose': '用途（可选）',
  'card.links.purposeAria': '链接用途',
  'card.links.add': '+ 添加链接',
  'card.links.saveFailed': '保存链接失败：{message}',
  'bubble.copy': '复制',
  'bubble.copied': '已复制',
  'bubble.more': '展示更多',
  'bubble.openSession': '打开 {name} 的子会话',
  'bubble.taskTitle': 'Leader 派发的任务',
  'markdown.copy': '复制',
  'markdown.copied': '已复制',
  'markdown.code': '代码',
  'markdown.wrap': '换行',
  'markdown.unwrap': '取消换行',
  'markdown.footnotes': '脚注',
  'bubble.clock.day': '{month}月{day}日',
  'bubble.clock.dayYear': '{year}年{month}月{day}日',
})

/** 英文字典，键与中文字典一致。 */
export const en = Object.freeze({
  'slot.discuss': 'Discuss',
  'slot.dev': 'Dev',
  'slot.review': 'Review',
  'guide.title': 'This directory has a Leader',
  'guide.steps': 'Open task cards, hand work to Agents, track progress in the board',
  'guide.action.intro': 'Show me how to use it',
  'guide.action.dismiss': 'Got it',
  'guide.intro.prompt': "This project isn't set up yet — show me how dsh-leader-agent works.",
  'tabs.list': 'Project session tabs',
  'tabs.close': 'Close tab',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.collapse': 'Collapse',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'tab.board': 'Board',
  'tab.board.description': "Delivery board for tasks in this project's leader and worker sessions",
  'project.label': 'Projects',
  'project.empty': 'No projects yet. Add one to create a Leader session in its folder.',
  'project.add': 'Add project: choose a folder',
  'project.create': 'Create project',
  'project.collapseList': 'Collapse project list',
  'project.expandList': 'Expand project list',
  'project.collapseSessions': 'Collapse sessions',
  'project.expandSessions': 'Expand sessions',
  'project.noSessions': 'No sessions in this project yet.',
  'project.replaceLeader': 'Replace Leader',
  'project.more': 'More',
  'project.completedUnread': 'Done, unread',
  'project.archive': 'Archive session: remove it from the list and release its card slot bindings',
  'project.archive.aria': 'Archive session {title}',
  'project.rename': 'Rename',
  'project.remove': 'Delete',
  'project.remove.title': 'Delete project',
  'project.remove.description': 'This deletes the project "{name}". The folder, session history, and dsh workspaces are kept.',
  'project.remove.notice': 'Deleted project "{name}".',
  'project.name.empty': 'Project name cannot be empty',
  'project.name.tooLong': 'Project name is too long (at most {max} characters)',
  'project.leaderMissing': 'Project "{name}" has no openable Leader session. Replace its Leader.',
  'project.leaderDeleted': 'The Leader session for project "{name}" has been deleted. Replace its Leader.',
  'project.remoteNotReady': 'Project channel not ready.',
  'project.error.read': 'Failed to read projects: {message}',
  'project.error.sessions': 'Failed to read project sessions: {message}',
  'project.error.create': 'Failed to create project: {message}',
  'project.error.rename': 'Failed to rename project: {message}',
  'project.error.reorder': 'Failed to reorder projects: {message}',
  'project.error.replaceLeader': 'Failed to replace the Leader: {message}',
  'project.error.delete': 'Failed to delete project: {message}',
  'project.error.deleteReason': 'Failed to delete project.',
  'project.error.navigation': 'Navigation service unavailable: cannot open the session.',
  'project.error.directoryPicker': 'Directory picker unavailable: this host cannot choose a folder. Switch to the web profile and try again.',
  'project.error.workspaces': 'Workspace service unavailable: cannot archive the session.',
  'project.error.archive': 'Failed to archive session: {message}',
  'project.error.archivePartial': 'Session archived, but releasing its card slots failed: {message}',
  'project.error.stopArchive': 'Failed to stop and archive: {message}',
  'project.archive.title': 'Session still running',
  'project.archive.description': 'This session is running. Archiving stops its tasks first, then removes it from the list and releases its card slot bindings. Session history is kept.',
  'project.archive.confirm': 'Stop and archive',
  'session.fold.expand': 'Show {count} more sessions',
  'board.fold.expand': 'Show {count} more cards',
  'board.done': 'Done',
  'board.empty.title': 'No cards yet',
  'board.empty.hint': 'Cards appear here after the leader calls create_card',
  'board.empty.doneTitle': 'All done',
  'board.empty.doneHintOwn': 'Every card in this project is done',
  'board.empty.doneHintNamed': 'Every card in {project} is done',
  'board.noProject.title': 'This session does not belong to a project',
  'board.noProject.hint': 'The board is organized by project: open it from a project session (leader or worker).',
  'board.leaderDead.title': "This project's Leader session is no longer available",
  'board.leaderDead.hint': "Use the project section in the left sidebar to replace this project's Leader, then open the board again.",
  'board.notProject.title': 'The board opens only in project sessions',
  'board.notProject.hint': "This is an ordinary session in the folder of {project}; open the project's leader or worker session to see its delivery board.",
  'board.thisProject': 'this project',
  'board.error.project': 'Failed to read project: {message}',
  'board.error.cards': 'Failed to read cards: {message}',
  'board.error.delete': 'Failed to delete card: {message}',
  'board.delete.title': 'Delete card',
  'board.slot.title': '{name}: {state}',
  'board.state.waiting': 'Waiting for you',
  'board.state.attention': 'Needs attention',
  'board.state.running': 'Running',
  'board.state.unread': 'Unread',
  'board.state.idle': 'Idle',
  'board.state.empty': 'Unassigned',
  'board.state.unknown': 'Unknown',
  'board.state.none': 'No signal',
  'card.status.done': 'Done',
  'card.status.archived': 'Archived',
  'card.status.active': 'In progress',
  'card.detail.empty': 'This card has no description yet.',
  'card.detail.spec': 'Description',
  'card.detail.links': 'Links',
  'card.detail.editLinks': 'Edit links',
  'card.detail.delete': 'Delete card',
  'card.detail.remove': 'Delete card #{number} "{title}". This cannot be undone; the number will not be reused, and the card\'s slot bindings will be released.',
  'card.links.empty': 'No links on this card yet.',
  'card.links.label': 'Label',
  'card.links.labelAria': 'Link label',
  'card.links.urlAria': 'Link URL',
  'card.links.remove': 'Remove link',
  'card.links.addPurpose': 'Add purpose',
  'card.links.purpose': 'Purpose (optional)',
  'card.links.purposeAria': 'Link purpose',
  'card.links.add': '+ Add link',
  'card.links.saveFailed': 'Failed to save links: {message}',
  'bubble.copy': 'Copy',
  'bubble.copied': 'Copied',
  'bubble.more': 'Show more',
  'bubble.openSession': "Open {name}'s child session",
  'bubble.taskTitle': 'Task from the Leader',
  'markdown.copy': 'Copy',
  'markdown.copied': 'Copied',
  'markdown.code': 'Code',
  'markdown.wrap': 'Wrap',
  'markdown.unwrap': 'No wrap',
  'markdown.footnotes': 'Footnotes',
  'bubble.clock.day': '{month}/{day}',
  'bubble.clock.dayYear': '{month}/{day}/{year}',
})

/**
 * 槽位名的显示文本。
 *
 * `t` 缺失时回落原名：槽位芯片只是卡面装饰信息，宿主没注入翻译席位不该让整块
 * 看板崩掉。
 *
 * @param {string} name - 槽位名（机器标识）
 * @param {((key: string, params?: Record<string, unknown>) => string) | undefined} t - 当前语言的翻译函数
 * @returns {string} 显示名；没有内置翻译或翻译函数缺失时原样返回槽位名
 */
export function slotLabel(name, t) {
  const key = SLOT_LABEL_KEYS[name]
  if (key === undefined || typeof t !== 'function') return name
  return t(key)
}

/**
 * 卡面最终使用的槽位显示名。
 *
 * 优先级：项目 `SLOTS.md` 声明的 `label:` → 内置槽位的 locale 翻译 → 槽位名
 * 本身。项目自己决定怎么称呼角色时以项目为准；没声明时内置角色按界面语言显示，
 * 自定义槽位（新加的、字典里没有的）显示原名——不会因为缺翻译就看不见。
 *
 * @param {string} name - 槽位名（机器标识）
 * @param {Record<string, string> | undefined} labels - 项目下发的槽位显示名字典
 * @param {((key: string, params?: Record<string, unknown>) => string) | undefined} t - 当前语言的翻译函数
 * @returns {string} 显示名
 */
export function slotDisplayName(name, labels, t) {
  const configured = labels?.[name]
  if (typeof configured === 'string' && configured !== '') return configured
  return slotLabel(name, t)
}
