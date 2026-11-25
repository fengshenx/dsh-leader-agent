import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSettingsStore } from '../src/host/settings-store.js'
import {
  AUTO_RESUME_LIMIT_DEFAULT,
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
} from '../src/shared/settings.js'

const DEFAULTS = { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT, boardMode: BOARD_MODE_DEFAULT }

/**
 * 建一个隔离的数据根。
 * @returns {Promise<string>} 临时目录
 */
async function makeHome() {
  return mkdtemp(join(tmpdir(), 'dsh-leader-agent-settings-'))
}

test('文件缺失时用默认设置，不创建文件也不报错', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    assert.deepEqual(settings.get(), DEFAULTS)
    assert.equal(settings.file, join(home, 'dsh-leader-agent', 'settings.json'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读取已落盘的合法上限与看板模式', async () => {
  const home = await makeHome()
  try {
    await mkdir(join(home, 'dsh-leader-agent'), { recursive: true })
    await writeFile(
      join(home, 'dsh-leader-agent', 'settings.json'),
      JSON.stringify({ version: 2, autoResumeLimit: 350, boardMode: BOARD_MODE_CINEMA }),
      'utf8',
    )
    const settings = createSettingsStore({ home })
    assert.deepEqual(settings.get(), { autoResumeLimit: 350, boardMode: BOARD_MODE_CINEMA })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('旧版设置文件只有上限时，看板模式按默认 work 读', async () => {
  const home = await makeHome()
  try {
    await mkdir(join(home, 'dsh-leader-agent'), { recursive: true })
    await writeFile(
      join(home, 'dsh-leader-agent', 'settings.json'),
      JSON.stringify({ version: 1, autoResumeLimit: 350 }),
      'utf8',
    )
    const logs = []
    const settings = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(settings.get(), { autoResumeLimit: 350, boardMode: BOARD_MODE_DEFAULT })
    assert.deepEqual(logs, [], '缺字段是旧文件形态，不该报配置损坏')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('坏字段按字段退回默认值并留日志，不阻断插件启动', async () => {
  const home = await makeHome()
  try {
    const directory = join(home, 'dsh-leader-agent')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({ autoResumeLimit: 0, boardMode: BOARD_MODE_CINEMA }),
      'utf8',
    )
    const logs = []
    const invalid = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(invalid.get(), { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT, boardMode: BOARD_MODE_CINEMA })
    assert.match(logs[0], /autoResumeLimit 非法/)

    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({ autoResumeLimit: 350, boardMode: 'spectacle' }),
      'utf8',
    )
    const invalidMode = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(invalidMode.get(), { autoResumeLimit: 350, boardMode: BOARD_MODE_DEFAULT })
    assert.match(logs.at(-1), /boardMode 非法/)

    await writeFile(join(directory, 'settings.json'), '{ 不是 JSON', 'utf8')
    const broken = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(broken.get(), DEFAULTS)
    assert.match(logs.at(-1), /读取 settings\.json 失败/)

    // 坏文件要在下次保存覆盖前留下原文备份，排障线索不能丢。
    const backups = (await readdir(directory)).filter((name) => name.startsWith('settings.json.corrupt-'))
    assert.equal(backups.length, 1)
    const backup = join(directory, backups[0])
    assert.equal(await readFile(backup, 'utf8'), '{ 不是 JSON')
    await broken.update({ autoResumeLimit: 321 })
    assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).autoResumeLimit, 321)
    assert.equal(await readFile(backup, 'utf8'), '{ 不是 JSON', '保存后备份仍保留原文')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('备份失败时仍按默认值启动并留下线索', {
  // 用目录写权限逼 rename 失败；root 与 Windows 上权限语义不同，不装成失败。
  skip: (process.platform === 'win32' || process.getuid?.() === 0) && '需要非 root 的 POSIX 目录权限',
}, async () => {
  const home = await makeHome()
  const directory = join(home, 'dsh-leader-agent')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'settings.json'), '{ 不是 JSON', 'utf8')
  await chmod(directory, 0o500)
  try {
    const logs = []
    const settings = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(settings.get(), DEFAULTS)
    assert.match(logs.at(-1), /读取 settings\.json 失败，备份到 .* 失败/)
    assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), '{ 不是 JSON')
  } finally {
    await chmod(directory, 0o700)
    await rm(home, { recursive: true, force: true })
  }
})

test('顶层不是对象时按坏文件备份并回默认', async () => {
  const home = await makeHome()
  try {
    const directory = join(home, 'dsh-leader-agent')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'settings.json'), '[]', 'utf8')
    const logs = []
    const settings = createSettingsStore({ home, logger: (message) => logs.push(message) })
    assert.deepEqual(settings.get(), DEFAULTS)
    assert.match(logs.at(-1), /读取 settings\.json 失败.*顶层必须是对象/)
    const backups = (await readdir(directory)).filter((name) => name.startsWith('settings.json.corrupt-'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(directory, backups[0]), 'utf8'), '[]')
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
    assert.deepEqual(settings.get(), DEFAULTS)
    assert.match(logs[0], /读取 settings\.json 失败/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('保存上限落盘、返回快照并通知订阅者', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    const changes = []
    const unsubscribe = settings.subscribe((next, previous) => changes.push({ next, previous }))
    const saved = await settings.update({ autoResumeLimit: 500 })
    assert.deepEqual(saved, { autoResumeLimit: 500, boardMode: BOARD_MODE_DEFAULT })
    assert.deepEqual(settings.get(), { autoResumeLimit: 500, boardMode: BOARD_MODE_DEFAULT })
    assert.deepEqual(changes, [{
      next: { autoResumeLimit: 500, boardMode: BOARD_MODE_DEFAULT },
      previous: DEFAULTS,
    }])
    const file = JSON.parse(await readFile(settings.file, 'utf8'))
    assert.deepEqual(file, {
      version: 2,
      autoResumeLimit: 500,
      boardMode: BOARD_MODE_DEFAULT,
    })

    unsubscribe()
    await settings.update({ autoResumeLimit: 600 })
    assert.equal(changes.length, 1, '退订后不应再收到变更')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('保存看板模式保留上限；保存上限保留看板模式', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    assert.deepEqual(
      await settings.update({ boardMode: BOARD_MODE_CINEMA }),
      { autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT, boardMode: BOARD_MODE_CINEMA },
    )
    assert.deepEqual(
      await settings.update({ autoResumeLimit: 350 }),
      { autoResumeLimit: 350, boardMode: BOARD_MODE_CINEMA },
    )
    assert.deepEqual(JSON.parse(await readFile(settings.file, 'utf8')), {
      version: 2,
      autoResumeLimit: 350,
      boardMode: BOARD_MODE_CINEMA,
    })
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
        () => settings.update({ autoResumeLimit: value }),
        /自动续行上限必须是 1–10000 之间的整数/,
      )
    }
    for (const value of ['', 'spectacle', 1, null, undefined, {}]) {
      await assert.rejects(
        () => settings.update({ boardMode: value }),
        /看板模式必须是 work 或 cinema/,
      )
    }
    await assert.rejects(() => settings.update({}), /至少需要一个字段/)
    await assert.rejects(() => settings.update({ theme: 'dark' }), /未知设置项：theme/)
    await assert.rejects(() => settings.update(500), /设置更新必须是一个对象/)
    assert.deepEqual(settings.get(), DEFAULTS)
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
    const saved = await settings.update({ autoResumeLimit: 300 })
    assert.deepEqual(saved, { autoResumeLimit: 300, boardMode: BOARD_MODE_DEFAULT })
    assert.equal(JSON.parse(await readFile(settings.file, 'utf8')).autoResumeLimit, 300)
    assert.match(logs.at(-1), /设置变更订阅者失败：订阅者炸了/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发保存按串行链落盘，同字段后一次覆盖前一次', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    await Promise.all([
      settings.update({ autoResumeLimit: 300 }),
      settings.update({ autoResumeLimit: 400 }),
    ])
    assert.deepEqual(settings.get(), { autoResumeLimit: 400, boardMode: BOARD_MODE_DEFAULT })
    assert.equal(JSON.parse(await readFile(settings.file, 'utf8')).autoResumeLimit, 400)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发保存不同字段时两次改动都保留', async () => {
  const home = await makeHome()
  try {
    const settings = createSettingsStore({ home })
    await Promise.all([
      settings.update({ autoResumeLimit: 300 }),
      settings.update({ boardMode: BOARD_MODE_CINEMA }),
    ])
    assert.deepEqual(settings.get(), {
      autoResumeLimit: 300,
      boardMode: BOARD_MODE_CINEMA,
    })
    assert.deepEqual(JSON.parse(await readFile(settings.file, 'utf8')), {
      version: 2,
      autoResumeLimit: 300,
      boardMode: BOARD_MODE_CINEMA,
    })
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
    snapshot.boardMode = BOARD_MODE_CINEMA
    assert.deepEqual(settings.get(), DEFAULTS)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
