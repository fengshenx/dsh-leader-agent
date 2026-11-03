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
} from '../src/host/leader-context.js'
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

test('手册缺失或只有空白时返回空串', async () => {
  const missing = await createProject(undefined)
  const blank = await createProject('  \n\n')
  try {
    assert.equal(loadLeaderManual(missing.directory), '')
    assert.equal(loadLeaderManual(blank.directory), '')
    const { ctx, holder } = createFakeCtx()
    applyLeaderContext({ ctx, resolveDirectory: () => missing.directory })
    assert.equal(holder.registered.text({ agent: { id: 'session-a' } }), '')
  } finally {
    await missing.cleanup()
    await blank.cleanup()
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
