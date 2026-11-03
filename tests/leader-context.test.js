import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  LEADER_CONTEXT_FILE,
  LEADER_CONTEXT_NAME,
  LEADER_CONTEXT_ORDER,
  LEGACY_LEADER_CONTEXT_FILE,
  applyLeaderContext,
  loadLeaderManual,
  renderLeaderContext,
} from '../src/host/leader-context.js'
import { createInitDeclinedStore } from '../src/host/init-declined.js'
import { ROLE_CONTEXT_ORDER } from '../src/host/slots/index.js'

/**
 * 建一个假的服务上下文，捕获注册进来的运行时上下文。
 *
 * @returns {{ ctx: object, holder: { registered: object | undefined } }} 上下文与注册项持有者
 */
function createFakeCtx() {
  const holder = { registered: undefined }
  const ctx = {
    systemPrompt: {
      context(definition) {
        holder.registered = definition
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  return { ctx, holder }
}

/**
 * 建一个带 `LEADER.md` 的临时项目目录。
 *
 * @param {string | undefined} content - 文件内容；undefined 表示不写文件
 * @returns {Promise<{ directory: string, cleanup: () => Promise<void> }>} 目录与清理函数
 */
async function createProject(content) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-leader-'))
  if (content !== undefined) {
    await writeFile(join(directory, LEADER_CONTEXT_FILE), content, 'utf8')
  }
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('注册为运行时上下文，排在角色槽位之前', () => {
  const { ctx, holder } = createFakeCtx()
  applyLeaderContext({ ctx, resolveDirectory: () => undefined })
  assert.equal(holder.registered.name, LEADER_CONTEXT_NAME)
  assert.equal(holder.registered.order, LEADER_CONTEXT_ORDER)
  assert.ok(LEADER_CONTEXT_ORDER < ROLE_CONTEXT_ORDER)
  assert.equal(holder.registered.required, true)
  assert.equal(holder.registered.interpolate, false)
})

test('组装上下文没有会话时正文为空串', () => {
  const { ctx, holder } = createFakeCtx()
  applyLeaderContext({ ctx, resolveDirectory: () => '/tmp/project' })
  assert.equal(holder.registered.text({}), '')
})

test('不是 leader（取不到项目目录）时不注入', async () => {
  const project = await createProject('你是本项目的 leader。')
  try {
    const { ctx, holder } = createFakeCtx()
    applyLeaderContext({ ctx, resolveDirectory: () => undefined })
    assert.equal(holder.registered.text({ agent: { id: 'session-a' } }), '')
  } finally {
    await project.cleanup()
  }
})

test('leader 会话注入项目根手册正文', async () => {
  const project = await createProject('派工前先建卡，验收读真实产物。')
  try {
    const { ctx, holder } = createFakeCtx()
    applyLeaderContext({ ctx, resolveDirectory: () => project.directory })
    const text = holder.registered.text({ agent: { id: 'session-a' } })
    assert.match(text, /## leader 手册/)
    // 路径里有 `\`，直接塞进 RegExp 会被当成转义；正文里包含目录即可。
    assert.ok(text.includes(project.directory))
    assert.match(text, /派工前先建卡，验收读真实产物。/)
  } finally {
    await project.cleanup()
  }
})

test('手册缺失或只有空白时 loadLeaderManual 返回空串（提示由渲染层给）', async () => {
  const missing = await createProject(undefined)
  const blank = await createProject('  \n\n')
  try {
    assert.equal(loadLeaderManual(missing.directory), '')
    assert.equal(loadLeaderManual(blank.directory), '')
  } finally {
    await missing.cleanup()
    await blank.cleanup()
  }
})

test('项目还没有手册时注入初始化提示：解释怎么工作、问是否初始化、确认后才写', async () => {
  const project = await createProject(undefined)
  try {
    const { ctx, holder } = createFakeCtx()
    applyLeaderContext({ ctx, resolveDirectory: () => project.directory })
    const text = holder.registered.text({ agent: { id: 'session-a' } })
    assert.match(text, /## 项目待初始化/)
    assert.match(text, /LEADER\.md/)
    assert.match(text, /SLOTS\.md/)
    assert.match(text, /init-leader-kit/)
    assert.match(text, /目录是空的就写带 TODO 的骨架/)
    assert.match(text, /不要创建或修改任何文件/)
    // 用户直接派活时不打断：提示自己限定触发面。
    assert.match(text, /用户直接派活时不要打断/)
  } finally {
    await project.cleanup()
  }
})

test('已有 SLOTS.md、只缺 LEADER.md 时，提示不再说两份都缺', async () => {
  const project = await createProject(undefined)
  try {
    await writeFile(join(project.directory, 'SLOTS.md'), '# 角色槽位\n', 'utf8')
    const text = renderLeaderContext({ sessionId: 'session-a', resolveDirectory: () => project.directory })
    assert.match(text, /还没有 `LEADER\.md`（leader 工作方法）。/)
    assert.doesNotMatch(text, /与 `SLOTS\.md`（执行者角色手册）/)
  } finally {
    await project.cleanup()
  }
})

test('手册存在时注入正文，不再出现初始化提示', async () => {
  const project = await createProject('派工前先建卡。')
  try {
    const text = renderLeaderContext({ sessionId: 'session-a', resolveDirectory: () => project.directory })
    assert.match(text, /## leader 手册/)
    assert.doesNotMatch(text, /## 项目待初始化/)
  } finally {
    await project.cleanup()
  }
})

test('LEADER.md 存在但只有空白时，提示说的是补内容而不是「还没有」', async () => {
  const project = await createProject('  \n\n')
  try {
    const text = renderLeaderContext({ sessionId: 'session-a', resolveDirectory: () => project.directory })
    assert.match(text, /## 项目待初始化/)
    assert.match(text, /`LEADER\.md` 还是空的（只有空白）/)
    // 让模型去「建」一个已经存在的文件只会撞车。
    assert.doesNotMatch(text, /还没有 `LEADER\.md`/)
  } finally {
    await project.cleanup()
  }
})

test('只有旧名 COORDINATOR.md 时按旧名注入正文，不出现初始化提示', async () => {
  const project = await createProject(undefined)
  try {
    await writeFile(join(project.directory, LEGACY_LEADER_CONTEXT_FILE), '旧名时代的手册。\n', 'utf8')
    const text = renderLeaderContext({ sessionId: 'session-a', resolveDirectory: () => project.directory })
    assert.match(text, /## leader 手册/)
    assert.match(text, /旧名时代的手册。/)
    assert.doesNotMatch(text, /## 项目待初始化/)
  } finally {
    await project.cleanup()
  }
})

test('LEADER.md 是空的、旧名手册有内容时回落到旧名，不当成没初始化', async () => {
  const project = await createProject('\n \n')
  try {
    await writeFile(join(project.directory, LEGACY_LEADER_CONTEXT_FILE), '旧名时代的手册。\n', 'utf8')
    const text = renderLeaderContext({ sessionId: 'session-a', resolveDirectory: () => project.directory })
    assert.match(text, /## leader 手册/)
    assert.match(text, /旧名时代的手册。/)
    assert.doesNotMatch(text, /## 项目待初始化/)
  } finally {
    await project.cleanup()
  }
})

test('用户拒绝初始化后（数据域标记存在）不再注入提示，删掉标记下一轮恢复', async () => {
  const project = await createProject(undefined)
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-home-'))
  const declined = createInitDeclinedStore({ home })
  const options = {
    sessionId: 'session-a',
    resolveDirectory: () => project.directory,
    isDeclined: declined.isDeclined,
    declinedFileOf: declined.fileOf,
  }
  try {
    const before = renderLeaderContext(options)
    assert.match(before, /## 项目待初始化/)
    // 提示直接给出数据域里的绝对路径：模型照抄即可，不需要知道 dsh home 怎么解析。
    assert.ok(before.includes(declined.fileOf(project.directory)))
    assert.ok(declined.fileOf(project.directory).startsWith(home))
    await mkdir(declined.directory, { recursive: true })
    await writeFile(declined.fileOf(project.directory), '', 'utf8')
    assert.equal(renderLeaderContext(options), '')
    // 标记是每轮求值的：删掉后下一轮就恢复提示，不需要重启。
    await rm(declined.fileOf(project.directory))
    assert.match(renderLeaderContext(options), /## 项目待初始化/)
  } finally {
    await project.cleanup()
    await rm(home, { recursive: true, force: true })
  }
})

test('手册缺失时按没有手册处理，且不记日志', async () => {
  const missing = await createProject(undefined)
  try {
    const logged = []
    const logger = (message) => logged.push(message)
    assert.equal(loadLeaderManual(missing.directory, logger), '')
    assert.equal(loadLeaderManual(undefined, logger), '')
    assert.deepEqual(logged, [])
  } finally {
    await missing.cleanup()
  }
})

test('手册文件名写死为 LEADER.md，旧名只作读取退回', () => {
  assert.equal(LEADER_CONTEXT_FILE, 'LEADER.md')
  assert.equal(LEGACY_LEADER_CONTEXT_FILE, 'COORDINATOR.md')
})

test('两版手册都在时以 LEADER.md 为准', async () => {
  const project = await createProject('新版正文。')
  try {
    await writeFile(join(project.directory, LEGACY_LEADER_CONTEXT_FILE), '旧版正文。', 'utf8')
    assert.equal(loadLeaderManual(project.directory), '新版正文。')
  } finally {
    await project.cleanup()
  }
})

test('两版手册都在且内容一致时不提示', async () => {
  const project = await createProject('同一份正文。')
  try {
    await writeFile(join(project.directory, LEGACY_LEADER_CONTEXT_FILE), '同一份正文。', 'utf8')
    const logged = []
    assert.equal(loadLeaderManual(project.directory, (message) => logged.push(message)), '同一份正文。')
    assert.deepEqual(logged, [])
  } finally {
    await project.cleanup()
  }
})

test('两版内容不一致时提示以 LEADER.md 为准，且每个目录只报一次', async () => {
  const project = await createProject('新版正文。')
  try {
    await writeFile(join(project.directory, LEGACY_LEADER_CONTEXT_FILE), '旧版正文。', 'utf8')
    const logged = []
    const logger = (message) => logged.push(message)
    // 手册每轮重新求值：三轮只应出一条，不能刷屏。
    for (let turn = 0; turn < 3; turn += 1) {
      assert.equal(loadLeaderManual(project.directory, logger), '新版正文。')
    }
    assert.equal(logged.length, 1)
    assert.match(logged[0], /内容不一致/)
    assert.match(logged[0], /LEADER\.md/)
  } finally {
    await project.cleanup()
  }
})

test('旧名退回提示每个目录只报一次', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-leader-legacy-once-'))
  try {
    await writeFile(join(directory, LEGACY_LEADER_CONTEXT_FILE), '旧名时代的手册。', 'utf8')
    const logged = []
    const logger = (message) => logged.push(message)
    for (let turn = 0; turn < 3; turn += 1) {
      assert.equal(loadLeaderManual(directory, logger), '旧名时代的手册。')
    }
    assert.equal(logged.length, 1)
    assert.match(logged[0], /COORDINATOR\.md/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('只有旧名 COORDINATOR.md 时退回读取，并提示改名', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-leader-legacy-'))
  try {
    await writeFile(join(directory, LEGACY_LEADER_CONTEXT_FILE), '旧名时代的手册。', 'utf8')
    const logged = []
    assert.equal(loadLeaderManual(directory, (message) => logged.push(message)), '旧名时代的手册。')
    assert.equal(logged.length, 1)
    assert.match(logged[0], /COORDINATOR\.md/)
    assert.match(logged[0], /LEADER\.md/)

    // 注入路径也拿到正文：升级不会静默丢掉既有项目的手册。
    const { ctx, holder } = createFakeCtx()
    applyLeaderContext({ ctx, resolveDirectory: () => directory })
    assert.match(holder.registered.text({ agent: { id: 'session-a' } }), /旧名时代的手册。/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('新版缺失、旧名位置读失败时返回空串并记日志', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-leader-legacy-error-'))
  try {
    // 旧名位置被目录占住：不是「文件不存在」，要留日志而不是当成没有手册。
    await mkdir(join(directory, LEGACY_LEADER_CONTEXT_FILE))
    const logged = []
    assert.equal(loadLeaderManual(directory, (message) => logged.push(message)), '')
    assert.equal(logged.length, 1)
    assert.match(logged[0], /读取 leader 手册失败/)
    assert.match(logged[0], /COORDINATOR\.md/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('读失败（文件位置被目录占用）时返回空串并记日志', async () => {
  const project = await createProject(undefined)
  try {
    await mkdir(join(project.directory, LEADER_CONTEXT_FILE))
    const logged = []
    const logger = (message) => logged.push(message)
    assert.equal(loadLeaderManual(project.directory, logger), '')
    assert.equal(logged.length, 1)
    assert.match(logged[0], /读取 leader 手册失败/)
    assert.match(logged[0], new RegExp(LEADER_CONTEXT_FILE))
    // 组装路径同样只留日志、不抛错：logger 要一路传到读取点。
    const { ctx, holder } = createFakeCtx()
    applyLeaderContext({ ctx, resolveDirectory: () => project.directory, logger })
    assert.equal(holder.registered.text({ agent: { id: 'session-a' } }), '')
    assert.equal(logged.length, 2)
  } finally {
    await project.cleanup()
  }
})

test('渲染出错时返回空串并记日志，不把错误抛给组装流程', () => {
  const logged = []
  const { ctx, holder } = createFakeCtx()
  applyLeaderContext({
    ctx,
    resolveDirectory: () => {
      throw new Error('目录不可用')
    },
    logger: (message) => logged.push(message),
  })
  assert.equal(holder.registered.text({ agent: { id: 'session-a' } }), '')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /渲染 leader 手册失败/)
})
