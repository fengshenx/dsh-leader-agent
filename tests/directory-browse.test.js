import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createBrowseFolder,
  directoryBrowseFailureText,
  displayCrumbs,
  folderCreateBlocked,
  parentCrumb,
  probeBrowseListing,
  resolveDirectoryPick,
  visibleEntries,
} from '../src/client/directory-browse-logic.js'

const browseSource = readFileSync(new URL('../src/client/directory-browse.js', import.meta.url), 'utf8')

/** 一份形状与宿主 DirectoryListing 一致的列表。 */
function listing(overrides = {}) {
  return {
    path: '/home/dev/work',
    home: '/home/dev',
    crumbs: [
      { name: '/', path: '/', hidden: false },
      { name: 'home', path: '/home', hidden: false },
      { name: 'dev', path: '/home/dev', hidden: false },
      { name: 'work', path: '/home/dev/work', hidden: false },
    ],
    entries: [
      { name: 'alpha', path: '/home/dev/work/alpha', hidden: false },
      { name: '.cache', path: '/home/dev/work/.cache', hidden: true },
    ],
    truncated: false,
    ...overrides,
  }
}

test('主目录子树内，面包屑从本地化的主目录开始', () => {
  const crumbs = displayCrumbs(listing(), '主目录')
  assert.deepEqual(crumbs, [
    { name: '主目录', path: '/home/dev', hidden: false },
    { name: 'work', path: '/home/dev/work', hidden: false },
  ])
})

test('目录不在主目录子树内时，保留完整祖先链', () => {
  const crumbs = displayCrumbs(listing({
    path: '/srv/projects',
    crumbs: [
      { name: '/', path: '/', hidden: false },
      { name: 'srv', path: '/srv', hidden: false },
      { name: 'projects', path: '/srv/projects', hidden: false },
    ],
    entries: [],
  }), '主目录')
  assert.deepEqual(crumbs.map((crumb) => crumb.path), ['/', '/srv', '/srv/projects'])
  assert.equal(crumbs.some((crumb) => crumb.name === '主目录'), false)
})

test('隐藏目录默认不渲染，勾选后全部显示', () => {
  const entries = listing().entries
  assert.deepEqual(visibleEntries(entries, false).map((entry) => entry.name), ['alpha'])
  assert.deepEqual(visibleEntries(entries, true).map((entry) => entry.name), ['alpha', '.cache'])
})

test('上一级取完整祖先链的倒数第二条，到根后为 null', () => {
  assert.equal(parentCrumb(listing()).path, '/home/dev')
  assert.equal(parentCrumb(listing({
    path: '/',
    crumbs: [{ name: '/', path: '/', hidden: false }],
    entries: [],
  })), null)
})

test('目录操作失败优先用宿主的业务文案', () => {
  const error = new Error('directory browse failed: directory-picker/unreadable: boom')
  error.rpcError = { code: 'directory-picker/unreadable', message: '目录不可读' }
  assert.equal(directoryBrowseFailureText(error), '目录不可读')
})

test('没有业务文案时退回 Error.message，非 Error 值转成字符串', () => {
  assert.equal(directoryBrowseFailureText(new Error('网络中断')), '网络中断')
  assert.equal(directoryBrowseFailureText('断线'), '断线')
  assert.equal(directoryBrowseFailureText({ rpcError: { message: '' } }), '[object Object]')
})

test('probeBrowseListing 成功时返回列表，并把内部 AbortSignal 传给宿主', async () => {
  const controller = new AbortController()
  let call
  const next = listing()
  const result = await probeBrowseListing({
    listDirectory: async (...args) => {
      call = args
      return next
    },
  }, { signal: controller.signal })
  assert.equal(result, next)
  assert.equal(call[0], undefined)
  assert.ok(call[1] instanceof AbortSignal)
})

test('probeBrowseListing 在 native 拒绝时返回 null', async () => {
  assert.equal(await probeBrowseListing({
    listDirectory: async () => { throw new Error('directory picker unavailable') },
  }), null)
})

test('probeBrowseListing 在外部取消时中止请求并返回 null', async () => {
  const controller = new AbortController()
  let received
  const pending = probeBrowseListing({
    listDirectory: (_, signal) => {
      received = signal
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }, { signal: controller.signal, timeoutMs: 10_000 })
  controller.abort()
  assert.equal(await pending, null)
  assert.equal(received.aborted, true)
})

test('probeBrowseListing 超过 timeoutMs 会中止并返回 null', async () => {
  let received
  const started = Date.now()
  const result = await probeBrowseListing({
    listDirectory: (_, signal) => {
      received = signal
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }, { timeoutMs: 20 })
  assert.equal(result, null)
  assert.equal(received.aborted, true)
  assert.ok(Date.now() - started >= 10)
})

test('pickDirectory 返回 null 是用户取消，不探测 browse', async () => {
  let probed = false
  const outcome = await resolveDirectoryPick({
    pickDirectory: async () => null,
    listDirectory: async () => {
      probed = true
      return listing()
    },
  })
  assert.deepEqual(outcome, { kind: 'cancelled' })
  assert.equal(probed, false)
})

test('pick 成功直接交给建项路径，不探测 browse', async () => {
  const outcome = await resolveDirectoryPick({
    pickDirectory: async () => '/home/dev/work',
  })
  assert.deepEqual(outcome, { kind: 'picked', directory: '/home/dev/work' })
})

test('pick 被拒且 list 成功时退回 browse，两个都失败时保留原始错误', async () => {
  const browse = listing()
  const browsed = await resolveDirectoryPick({
    pickDirectory: async () => { throw new Error('native') },
    listDirectory: async () => browse,
  })
  assert.deepEqual(browsed, { kind: 'browse', listing: browse })

  const error = new Error('native picker failed')
  const failed = await resolveDirectoryPick({
    pickDirectory: async () => { throw error },
    listDirectory: async () => { throw new Error('list also failed') },
  })
  assert.equal(failed.kind, 'error')
  assert.equal(failed.error, error)
})

test('扫描中即使新建表单已开，按钮与提交都拒绝', () => {
  const idle = { listing: listing(), loading: false, busy: false, creating: false }
  assert.equal(folderCreateBlocked(idle), false)
  assert.equal(folderCreateBlocked({ ...idle, loading: true }), true)
  assert.match(browseSource, /const createBlocked = folderCreateBlocked\(\{ listing, loading, busy, creating \}\)/)
  assert.match(browseSource, /if \(folderCreateBlocked\(\{ listing, loading, busy, creating \}\)\) return/)
  assert.match(browseSource, /disabled: createBlocked/)
})

test('新建文件夹成功时传父路径与 trim 后的名字，返回宿主列表', async () => {
  let call
  const next = listing({ path: '/home/dev/work/new' })
  const result = await createBrowseFolder({
    createDirectory: async (...args) => {
      call = args
      return next
    },
  }, '/home/dev/work', '  new  ')
  assert.deepEqual(call, ['/home/dev/work', 'new'])
  assert.equal(result, next)
})

test('空名不发新建请求', async () => {
  let called = false
  const result = await createBrowseFolder({
    createDirectory: async () => {
      called = true
    },
  }, '/home/dev/work', '   ')
  assert.equal(result, null)
  assert.equal(called, false)
})

test('重名与非法字符保留宿主错误', async () => {
  for (const code of ['directory-picker/already-exists', 'directory-picker/invalid-name']) {
    const error = Object.assign(new Error(code), { rpcError: { code, message: code } })
    await assert.rejects(
      createBrowseFolder({
        createDirectory: async () => { throw error },
      }, '/home/dev/work', 'bad/name'),
      (caught) => caught === error,
    )
  }
})
