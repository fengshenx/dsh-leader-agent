import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'
import { createWorkerRegistry } from '../src/host/worker-registry.js'

after(cleanupTempDirs)

test('登记后能按子会话 id 取回', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工', task: '做事' })
  const record = await registry.get('child-1')
  assert.equal(record.parentSessionId, 'parent-1')
  assert.equal(record.name, '工')
  assert.equal(typeof record.registeredAt, 'number')
})

test('同 id 重复登记是更新不是追加', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '旧' })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '新' })
  const record = await registry.get('child-1')
  assert.equal(record.name, '新')
  const { readFile } = await import('node:fs/promises')
  const stored = JSON.parse(await readFile(`${home}/dsh-leader-agent/workers.json`, 'utf8'))
  assert.equal(stored.workers.length, 1)
})

test('超出上限时淘汰最早的记录，文件不无界增长', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home, maxWorkers: 2 })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '一' })
  await registry.register({ childId: 'child-2', parentSessionId: 'parent-1', name: '二' })
  await registry.register({ childId: 'child-3', parentSessionId: 'parent-1', name: '三' })
  assert.equal(await registry.get('child-1'), undefined)
  assert.equal((await registry.get('child-2')).name, '二')
  assert.equal((await registry.get('child-3')).name, '三')
  const { readFile } = await import('node:fs/promises')
  const stored = JSON.parse(await readFile(`${home}/dsh-leader-agent/workers.json`, 'utf8'))
  assert.deepEqual(stored.workers.map((item) => item.childId), ['child-2', 'child-3'])
})

test('跨实例读同一份落盘（进程重启后续聊找得到工）', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  await createWorkerRegistry({ home }).register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })
  const reloaded = await createWorkerRegistry({ home }).get('child-1')
  assert.equal(reloaded.name, '工')
})

test('改显示名落盘，跨实例读得到新名', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: 'research-sources' })
  const renamed = await registry.rename('child-1', 'write-summary')
  assert.equal(renamed.name, 'write-summary')
  // 续聊改名后进程重启，完成通知不能还喊旧名。
  assert.equal((await createWorkerRegistry({ home }).get('child-1')).name, 'write-summary')
  // 没有这条记录时返回 undefined，不凭空造记录
  assert.equal(await registry.rename('child-别的', 'x'), undefined)
  assert.equal(await registry.get('child-别的'), undefined)
})

test('删掉记录后取不到，且改动落盘', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })
  assert.equal(await registry.remove('child-1'), true)
  assert.equal(await registry.get('child-1'), undefined)
  // 第二个实例也读不到：归档是跨进程的事实，不能只改内存。
  assert.equal(await createWorkerRegistry({ home }).get('child-1'), undefined)
  // 不存在的记录不报错，返回 false 让调用方自己判断
  assert.equal(await registry.remove('child-1'), false)
})

test('登记表损坏时重建空表并保留备份', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const directory = `${home}/dsh-leader-agent`
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/workers.json`, '{oops', 'utf8')
  const warned = []
  const registry = createWorkerRegistry({ home, logger: (message) => warned.push(message) })
  assert.equal(await registry.get('child-1'), undefined)
  assert.ok(warned.length === 1 && warned[0].includes('损坏'))
  // 坏文件被挪走留证；下一次登记写回合法文件
  const { readdir, readFile } = await import('node:fs/promises')
  const files = await readdir(directory)
  assert.ok(files.some((name) => name.startsWith('workers.json.corrupt-')))
  await registry.register({ childId: 'child-2', parentSessionId: 'parent-1', name: '重建' })
  assert.deepEqual(
    JSON.parse(await readFile(`${directory}/workers.json`, 'utf8')).workers.map((item) => item.childId),
    ['child-2'],
  )
})

test('登记表结构非法时按损坏处理：合法 JSON 但缺 workers 数组', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const directory = `${home}/dsh-leader-agent`
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/workers.json`, JSON.stringify({ version: 1 }), 'utf8')
  const warned = []
  const registry = createWorkerRegistry({ home, logger: (message) => warned.push(message) })
  assert.equal(await registry.get('child-1'), undefined)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /损坏/)
})

test('换 leader 后改绑父会话，并留下去向痕迹', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'leader-old', name: '一' })
  await registry.register({ childId: 'child-2', parentSessionId: 'leader-old', name: '二' })
  await registry.register({ childId: 'child-3', parentSessionId: 'leader-other', name: '别家的' })

  const moved = await registry.reassignParent('leader-old', 'leader-new')
  assert.deepEqual(moved.sort(), ['child-1', 'child-2'])
  const first = await registry.get('child-1')
  assert.equal(first.parentSessionId, 'leader-new')
  // 「谁派的工」不抹掉：历史父会话按顺序留在记录里
  assert.deepEqual(first.reassignedFrom, ['leader-old'])
  // 别的父会话的工不动
  assert.equal((await registry.get('child-3')).parentSessionId, 'leader-other')
  assert.equal((await registry.get('child-3')).reassignedFrom, undefined)

  // 再换一次：改绑幂等，已经是谁的不重复叠加
  assert.deepEqual(await registry.reassignParent('leader-old', 'leader-new'), [])
  await registry.reassignParent('leader-new', 'leader-third')
  const twice = await registry.get('child-1')
  assert.equal(twice.parentSessionId, 'leader-third')
  assert.deepEqual(twice.reassignedFrom, ['leader-old', 'leader-new'])
  // 重开实例读盘：改绑落了盘，不是内存里的假象
  const reopened = await createWorkerRegistry({ home }).get('child-2')
  assert.equal(reopened.parentSessionId, 'leader-third')
  assert.deepEqual(reopened.reassignedFrom, ['leader-old', 'leader-new'])
})

test('没有可改绑的记录时不写盘', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'leader-a', name: '工' })
  const file = `${home}/dsh-leader-agent/workers.json`
  const { stat } = await import('node:fs/promises')
  const before = await stat(file)

  // 换 leader 会对每个退役 id 调一次改绑，命中 0 条是常态：不该整表重写一次
  assert.deepEqual(await registry.reassignParent('leader-missing', 'leader-b'), [])
  // 写盘走「临时文件 + rename」，会换掉 inode；没写就还是同一个文件
  assert.equal((await stat(file)).ino, before.ino)

  // 真改到的时候照常落盘（对照组，防止用例本身失效）
  assert.deepEqual(await registry.reassignParent('leader-a', 'leader-b'), ['child-1'])
  assert.notEqual((await stat(file)).ino, before.ino)
  assert.equal((await createWorkerRegistry({ home }).get('child-1')).parentSessionId, 'leader-b')
})

test('记录成功投递只更新 lastUsedAt，不动登记顺序与父会话归属', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  const registered = await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })
  const updated = await registry.markUsed('child-1', 1_700_000_000_000)
  assert.equal(updated.lastUsedAt, 1_700_000_000_000)
  assert.equal(updated.registeredAt, registered.registeredAt)
  assert.equal(updated.parentSessionId, 'parent-1')
  assert.equal(updated.lastReportAt, undefined)
  // 跨实例读得到：投递后进程重启，LRU 顺序不能退回登记时间。
  const reloaded = await createWorkerRegistry({ home }).get('child-1')
  assert.equal(reloaded.lastUsedAt, 1_700_000_000_000)
  assert.equal(await registry.markUsed('missing', 1), undefined)
})

test('旧登记表缺 lastUsedAt 时按 registeredAt 兜底', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const directory = `${home}/dsh-leader-agent`
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/workers.json`, JSON.stringify({
    version: 1,
    workers: [
      { childId: 'old-1', parentSessionId: 'parent-1', name: '旧一', registeredAt: 1_700_000_000_000 },
      { childId: 'old-2', parentSessionId: 'parent-1', name: '旧二', registeredAt: 1_700_000_001_000 },
    ],
  }), 'utf8')
  const registry = createWorkerRegistry({ home })
  assert.equal((await registry.get('old-1')).lastUsedAt, 1_700_000_000_000)
  assert.deepEqual((await registry.list()).map((item) => item.lastUsedAt), [1_700_000_001_000, 1_700_000_000_000])
  // 下一次真实写盘把兜底值落盘，但仍不动 registeredAt。
  const used = await registry.markUsed('old-1', 1_700_000_002_000)
  assert.equal(used.registeredAt, 1_700_000_000_000)
  assert.equal((await createWorkerRegistry({ home }).get('old-1')).lastUsedAt, 1_700_000_002_000)
})

test('记录回报时刻：同时更新 lastUsedAt，不动登记顺序与归属', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  const registered = await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })
  const updated = await registry.markReported('child-1', 1_700_000_000_000)
  assert.equal(updated.lastReportAt, 1_700_000_000_000)
  assert.equal(updated.lastUsedAt, 1_700_000_000_000)
  assert.equal(updated.registeredAt, registered.registeredAt)
  assert.equal(updated.parentSessionId, 'parent-1')
  assert.equal(updated.name, '工')

  // 跨实例读得到：进程重启后巡查仍能拿到最后回报。
  const reloaded = await createWorkerRegistry({ home }).get('child-1')
  assert.equal(reloaded.lastReportAt, 1_700_000_000_000)
})

test('记录回报时刻时没有这条记录就不写盘、不补登记', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  assert.equal(await registry.markReported('missing', 1), undefined)
  assert.equal(await registry.get('missing'), undefined)
})

test('续聊换模型：写 agentOptions 与来源，不动名字与父会话，跨实例读得到', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })

  const updated = await registry.setModel('child-1', {
    agentOptions: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    modelSource: 'message',
  })

  assert.deepEqual(updated.agentOptions, {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  assert.equal(updated.modelSource, 'message')
  assert.equal(updated.name, '工')
  assert.equal(updated.parentSessionId, 'parent-1')
  // 冷恢复读登记表：另一个实例必须拿到新 route。
  assert.deepEqual(
    (await createWorkerRegistry({ home }).get('child-1')).agentOptions,
    { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
  )
})

test('续聊换模型时没有这条记录就不写盘、不补登记', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })

  assert.equal(await registry.setModel('child-别的', { agentOptions: { provider: 'p', model: 'm' } }), undefined)
  assert.equal(await registry.get('child-别的'), undefined)
})

test('续聊换模型不带 modelSource 时保留原来源', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工', modelSource: 'slot' })

  const updated = await registry.setModel('child-1', { agentOptions: { provider: 'p', model: 'm' } })

  assert.equal(updated.modelSource, 'slot')
})

test('记录复用指派：写 cardId + slot，跨实例读得到', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })

  const updated = await registry.setAssignment('child-1', { cardId: 'card-9', slot: 'dev' })

  assert.deepEqual(updated.assignment, { cardId: 'card-9', slot: 'dev' })
  assert.equal(updated.name, '工')
  assert.deepEqual((await createWorkerRegistry({ home }).get('child-1')).assignment, {
    cardId: 'card-9',
    slot: 'dev',
  })
  // 没挂槽位时 slot 记 null，表示「这张卡没有角色槽位」，不是「字段没写」。
  assert.deepEqual(
    (await registry.setAssignment('child-1', { cardId: 'card-10', slot: null })).assignment,
    { cardId: 'card-10', slot: null },
  )
})

test('记录复用指派时没有这条记录就不写盘、不补登记', async () => {
  const home = await makeTempDir('dsh-leader-agent-registry-')
  const registry = createWorkerRegistry({ home })

  assert.equal(await registry.setAssignment('child-别的', { cardId: 'card-1', slot: 'dev' }), undefined)
  assert.equal(await registry.get('child-别的'), undefined)
})
