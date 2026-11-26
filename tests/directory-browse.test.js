import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createBrowseFolder,
  directoryBrowseFailureText,
  displayCrumbs,
  parentCrumb,
  probeBrowseListing,
  visibleEntries,
} from '../src/client/directory-browse-logic.js'

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

test('probeBrowseListing 成功时返回列表，并把 signal 传给宿主', async () => {
  const signal = new AbortController().signal
  let call
  const next = listing()
  const result = await probeBrowseListing({
    listDirectory: async (...args) => {
      call = args
      return next
    },
  }, signal)
  assert.equal(result, next)
  assert.deepEqual(call, [undefined, signal])
})

test('probeBrowseListing 在 native 拒绝与取消时都返回 null', async () => {
  assert.equal(await probeBrowseListing({
    listDirectory: async () => { throw new Error('directory picker unavailable') },
  }), null)
  const aborted = new Error('aborted')
  aborted.name = 'AbortError'
  assert.equal(await probeBrowseListing({
    listDirectory: async () => { throw aborted },
  }, new AbortController().signal), null)
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
