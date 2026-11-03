import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createInitDeclinedStore } from '../src/host/init-declined.js'

/**
 * 建一个临时的 dsh home。
 * @returns {Promise<string>} home 目录
 */
function createHome() {
  return mkdtemp(join(tmpdir(), 'dsh-leader-kit-declined-'))
}

test('标记落在插件自己的数据域，不写项目目录', async () => {
  const home = await createHome()
  try {
    const declined = createInitDeclinedStore({ home })
    const file = declined.fileOf('/work/my-project')
    assert.equal(declined.directory, join(home, 'dsh-leader-kit', 'init-declined'))
    assert.ok(file.startsWith(declined.directory))
    // 文件名带项目名便于人工排查，避免只看哈希分不出是哪个项目。
    assert.ok(basename(file).startsWith('my-project-'))
    assert.equal(file.includes('/work/my-project'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('不同目录得到不同标记文件，同一目录稳定', async () => {
  const home = await createHome()
  try {
    const declined = createInitDeclinedStore({ home })
    assert.equal(declined.fileOf('/work/a'), declined.fileOf('/work/a'))
    assert.notEqual(declined.fileOf('/work/a'), declined.fileOf('/work/b'))
    // 目录名相同、上级不同也必须分开：两个项目经常都叫同名仓库目录。
    assert.notEqual(declined.fileOf('/work/a/repo'), declined.fileOf('/work/b/repo'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('没有标记文件时不算拒绝，目录不存在也不抛错', async () => {
  const home = await createHome()
  try {
    const declined = createInitDeclinedStore({ home })
    assert.equal(declined.isDeclined('/work/nothing-here'), false)
    assert.equal(declined.isDeclined(''), false)
    assert.equal(declined.isDeclined(undefined), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('写入标记文件后判定为已拒绝，删除后立刻恢复', async () => {
  const home = await createHome()
  try {
    const declined = createInitDeclinedStore({ home })
    const project = '/work/my-project'
    await mkdir(declined.directory, { recursive: true })
    await writeFile(declined.fileOf(project), '', 'utf8')
    assert.equal(declined.isDeclined(project), true)
    // 别的项目不受影响。
    assert.equal(declined.isDeclined('/work/other'), false)
    await rm(declined.fileOf(project))
    assert.equal(declined.isDeclined(project), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('项目目录名含特殊字符时仍生成合法文件名', async () => {
  const home = await createHome()
  try {
    const declined = createInitDeclinedStore({ home })
    const file = declined.fileOf('/work/我的 项目 (v2)')
    assert.equal(file.includes('/work/'), false)
    assert.equal(file.endsWith('/'), false)
    assert.ok(basename(file).length > 13)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
