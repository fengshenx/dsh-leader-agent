import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  directoryBrowseFailureText,
  displayCrumbs,
  parentCrumb,
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
