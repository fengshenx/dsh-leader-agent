import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'
import { createWorkerRegistry } from '../src/host/worker-registry.js'

after(cleanupTempDirs)

test('登记后能按子会话 id 取回', async () => {
  const home = await makeTempDir('dsh-leader-kit-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工', task: '做事' })
  const record = await registry.get('child-1')
  assert.equal(record.parentSessionId, 'parent-1')
  assert.equal(record.name, '工')
  assert.equal(typeof record.registeredAt, 'number')
})

test('同 id 重复登记是更新不是追加', async () => {
  const home = await makeTempDir('dsh-leader-kit-registry-')
  const registry = createWorkerRegistry({ home })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '旧' })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '新' })
  const record = await registry.get('child-1')
  assert.equal(record.name, '新')
  const { readFile } = await import('node:fs/promises')
  const stored = JSON.parse(await readFile(`${home}/dsh-leader-kit/workers.json`, 'utf8'))
  assert.equal(stored.workers.length, 1)
})

test('超出上限时淘汰最早的记录，文件不无界增长', async () => {
  const home = await makeTempDir('dsh-leader-kit-registry-')
  const registry = createWorkerRegistry({ home, maxWorkers: 2 })
  await registry.register({ childId: 'child-1', parentSessionId: 'parent-1', name: '一' })
  await registry.register({ childId: 'child-2', parentSessionId: 'parent-1', name: '二' })
  await registry.register({ childId: 'child-3', parentSessionId: 'parent-1', name: '三' })
  assert.equal(await registry.get('child-1'), undefined)
  assert.equal((await registry.get('child-2')).name, '二')
  assert.equal((await registry.get('child-3')).name, '三')
  const { readFile } = await import('node:fs/promises')
  const stored = JSON.parse(await readFile(`${home}/dsh-leader-kit/workers.json`, 'utf8'))
  assert.deepEqual(stored.workers.map((item) => item.childId), ['child-2', 'child-3'])
})

test('跨实例读同一份落盘（进程重启后续聊找得到工）', async () => {
  const home = await makeTempDir('dsh-leader-kit-registry-')
  await createWorkerRegistry({ home }).register({ childId: 'child-1', parentSessionId: 'parent-1', name: '工' })
  const reloaded = await createWorkerRegistry({ home }).get('child-1')
  assert.equal(reloaded.name, '工')
})

test('改显示名落盘，跨实例读得到新名', async () => {
  const home = await makeTempDir('dsh-leader-kit-registry-')
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
  const home = await makeTempDir('dsh-leader-kit-registry-')
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
  const home = await makeTempDir('dsh-leader-kit-registry-')
  const directory = `${home}/dsh-leader-kit`
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
