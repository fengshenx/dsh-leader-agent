import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSettingsStore } from '../src/host/settings-store.js'
import { AUTO_RESUME_LIMIT_DEFAULT } from '../src/shared/settings.js'

/**
 * 建一个隔离的数据根。
 * @returns {Promise<string>} 临时目录
 */
async function makeHome() {
  return mkdtemp(join(tmpdir(), 'dsh-leader-agent-settings-'))
}

test('文件缺失时用默认 200，不创建文件也不报错', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    assert.deepEqual(settings.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT })
    assert.equal(settings.file, join(home, 'dsh-leader-agent', 'settings.json'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读取已落盘的合法上限', async () => {
  const home = await makeHome()
  try {
    await mkdir(join(home, 'dsh-leader-agent'), { recursive: true })
    await writeFile(
      join(home, 'dsh-leader-agent', 'settings.json'),
      JSON.stringify({ version: 1, autoResumeLimit: 350 }),
      'utf8',
    )
    const settings = createSettingsStore({ home })
    assert.deepEqual(settings.get(), { autoResumeLimit: 350 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('坏值或坏 JSON 退回默认值并留日志，不阻断插件启动', async () => {
  const home = await makeHome()
  try {
    const directory = join(home, 'dsh-leader-agent')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ autoResumeLimit: 0 }), 'utf8')
    const logs = []
    const invalid = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(invalid.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT })
    assert.match(logs[0], /autoResumeLimit 非法/)

    await writeFile(join(directory, 'settings.json'), '{ 不是 JSON', 'utf8')
    const broken = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(broken.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT })
    assert.match(logs.at(-1), /读取 settings\.json 失败/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读取方向遇到非 ENOENT 错误也按默认值启动', async () => {
  const home = await makeHome()
  try {
    // 把文件路径做成目录：readFileSync 抛 EISDIR，走「其它读取失败」分支。
    await mkdir(join(home, 'dsh-leader-agent', 'settings.json'), { recursive: true })
    const logs = []
    const settings = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(settings.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT })
    assert.match(logs[0], /读取 settings\.json 失败/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('保存落盘、返回快照并通知订阅者', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    const changes = []
    const unsubscribe = settings.subscribe((next, previous) => changes.push({ next, previous }))
    const saved = await settings.update(500)
    assert.deepEqual(saved, { autoResumeLimit: 500 })
    assert.deepEqual(settings.get(), { autoResumeLimit: 500 })
    assert.deepEqual(changes, [{
      next: { autoResumeLimit: 500 },
      previous: { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT },
    }])
    const file = JSON.parse(await readFile(settings.file, 'utf8'))
    assert.deepEqual(file, { version: 1, autoResumeLimit: 500 })

    unsubscribe()
    await settings.update(600)
    assert.equal(changes.length, 1, '退订后不应再收到变更')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('非法值拒绝，不写盘也不改内存', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    for (const value of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', 10001]) {
      await assert.rejects(
        () => settings.update(value),
        /自动续行上限必须是 1–10000 之间的整数/,
      )
    }
    assert.deepEqual(settings.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT })
    await assert.rejects(() => readFile(settings.file, 'utf8'), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('订阅者抛错不把已经落盘的设置变成保存失败', async () => {
  const home = await makeHome()
  try {
    const logs = []
    const settings = createSettingsStore({ home, logger: (message) => logs.push(message) })
    settings.subscribe(() => { throw new Error('订阅者炸了') })
    const saved = await settings.update(300)
    assert.deepEqual(saved, { autoResumeLimit: 300 })
    assert.equal(JSON.parse(await readFile(settings.file, 'utf8')).autoResumeLimit, 300)
    assert.match(logs.at(-1), /设置变更订阅者失败：订阅者炸了/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发保存按串行链落盘，后一次覆盖前一次', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    await Promise.all([settings.update(300), settings.update(400)])
    assert.deepEqual(settings.get(), { autoResumeLimit: 400 })
    assert.equal(JSON.parse(await readFile(settings.file, 'utf8')).autoResumeLimit, 400)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('get 返回副本，调用方改不动存储', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    const snapshot = settings.get()
    snapshot.autoResumeLimit = 999
    assert.deepEqual(settings.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
