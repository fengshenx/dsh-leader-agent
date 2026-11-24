import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isLegacyUser, resolveBoardDefaults } from '../src/host/board-defaults.js'

/**
 * 造一个临时数据根。
 * @returns {Promise<string>} 临时目录
 */
async function makeHome() {
  return mkdtemp(join(tmpdir(), 'dsh-board-defaults-'))
}

/**
 * 写一份存储文件。
 * @param {string} home - 数据根
 * @param {string} name - 文件名
 * @param {object} value - 内容
 * @returns {Promise<void>}
 */
async function writeStore(home, name, value) {
  const directory = join(home, 'dsh-leader-agent')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), `${JSON.stringify(value)}\n`, 'utf8')
}

test('没有任何数据时是新用户，默认炫酷，并写下一次标记', async () => {
  const home = await makeHome()
  try {
    const result = await resolveBoardDefaults({ home })
    assert.deepEqual(result, { defaultMode: 'cinema', legacy: false })
    const marker = JSON.parse(await readFile(join(home, 'dsh-leader-agent', 'board-default.json'), 'utf8'))
    assert.equal(marker.version, 1)
    assert.equal(marker.legacy, false)
    assert.equal(typeof marker.capturedAt, 'string')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('已有项目就是老用户，默认工作', async () => {
  const home = await makeHome()
  try {
    await writeStore(home, 'projects.json', { version: 1, projects: [{ id: 'p1' }] })
    assert.deepEqual(await resolveBoardDefaults({ home }), { defaultMode: 'work', legacy: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('只有卡片也算老用户', async () => {
  const home = await makeHome()
  try {
    await writeStore(home, 'cards.json', { version: 1, cards: [{ id: 'c1' }] })
    assert.deepEqual(await resolveBoardDefaults({ home }), { defaultMode: 'work', legacy: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('标记只写一次：之后再加数据也保持 fresh', async () => {
  const home = await makeHome()
  try {
    await resolveBoardDefaults({ home })
    await writeStore(home, 'projects.json', { version: 1, projects: [{ id: 'p1' }] })
    assert.deepEqual(await resolveBoardDefaults({ home }), { defaultMode: 'cinema', legacy: false })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('已有标记直接读，不重新按数据算', async () => {
  const home = await makeHome()
  try {
    await writeStore(home, 'board-default.json', { version: 1, legacy: true })
    assert.deepEqual(await resolveBoardDefaults({ home }), { defaultMode: 'work', legacy: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('标记损坏时按数据重算并写回', async () => {
  const home = await makeHome()
  try {
    await writeStore(home, 'board-default.json', '{ broken')
    await writeStore(home, 'cards.json', { version: 1, cards: [{ id: 'c1' }] })
    assert.deepEqual(await resolveBoardDefaults({ home }), { defaultMode: 'work', legacy: true })
    const marker = JSON.parse(await readFile(join(home, 'dsh-leader-agent', 'board-default.json'), 'utf8'))
    assert.equal(marker.legacy, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('标记写不进去也返回按数据算出的默认值', async () => {
  const home = await makeHome()
  try {
    await writeStore(home, 'projects.json', { version: 1, projects: [{ id: 'p1' }] })
    // 把标记路径占成目录：读与写都会失败，模拟数据目录只读/磁盘满
    await mkdir(join(home, 'dsh-leader-agent', 'board-default.json'), { recursive: true })
    assert.deepEqual(await resolveBoardDefaults({ home }), { defaultMode: 'work', legacy: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('isLegacyUser 只看有没有项目或卡片', () => {
  assert.equal(isLegacyUser(), false)
  assert.equal(isLegacyUser({ projects: [], cards: [] }), false)
  assert.equal(isLegacyUser({ projects: [{}] }), true)
  assert.equal(isLegacyUser({ cards: [{}] }), true)
})
