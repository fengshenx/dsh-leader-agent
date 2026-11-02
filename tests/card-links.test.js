import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isHttpUrl, normalizeHttpUrl, normalizeLinkDrafts } from '../src/shared/card-links.js'

test('只认 http(s) 绝对地址', () => {
  assert.equal(isHttpUrl('https://github.com/o/r/pull/1'), true)
  assert.equal(isHttpUrl('http://example.com'), true)
  assert.equal(isHttpUrl('ftp://example.com'), false)
  assert.equal(isHttpUrl('javascript:alert(1)'), false)
  assert.equal(isHttpUrl('docs/report.md'), false)
  assert.equal(isHttpUrl(''), false)
  assert.equal(isHttpUrl(undefined), false)
})

test('归一化函数与判定同源：能归一化成 http(s) 的才算', () => {
  assert.equal(normalizeHttpUrl('https://example.com/pull/1'), 'https://example.com/pull/1')
  assert.equal(normalizeHttpUrl('http:example.com'), 'http://example.com/')
  assert.equal(normalizeHttpUrl('https:/example.com'), 'https://example.com/')
  assert.equal(normalizeHttpUrl('https://exa\nmple.com'), 'https://example.com/')
  assert.equal(normalizeHttpUrl('javascript:alert(1)'), null)
  assert.equal(normalizeHttpUrl('ftp://example.com'), null)
  assert.equal(normalizeHttpUrl('docs/report.md'), null)
  assert.equal(normalizeHttpUrl(''), null)
  assert.equal(normalizeHttpUrl(undefined), null)
  // 判定用的就是归一化结果，两者不会对同一个值给出不同口径
  assert.equal(isHttpUrl('https://exa\nmple.com'), normalizeHttpUrl('https://exa\nmple.com') !== null)
})

test('保存前 trim 三个字段，空 url / purpose 不落空串', () => {
  const result = normalizeLinkDrafts([
    { id: 'l1', label: ' PR ', url: ' https://example.com/pull/1 ', purpose: ' 交付 ' },
    { label: 'Issue', url: '   ', purpose: '  ' },
  ])

  assert.deepEqual(result, {
    links: [
      { id: 'l1', label: 'PR', url: 'https://example.com/pull/1', purpose: '交付' },
      { label: 'Issue' },
    ],
  })
})

test('URL 写入边界归一化：省略 // 与内嵌换行的写法不原样落盘', () => {
  const result = normalizeLinkDrafts([
    { label: '简写', url: 'http:example.com' },
    { label: '单斜杠', url: 'https:/example.com' },
    { label: '换行', url: 'https://exa\nmple.com' },
  ])

  assert.deepEqual(result, {
    links: [
      { label: '简写', url: 'http://example.com/' },
      { label: '单斜杠', url: 'https://example.com/' },
      { label: '换行', url: 'https://example.com/' },
    ],
  })
})

test('整行都空的新增行直接丢弃——那是没填完，不是错误', () => {
  assert.deepEqual(normalizeLinkDrafts([{ label: '   ' }, { label: '有效' }]), {
    links: [{ label: '有效' }],
  })
  assert.deepEqual(normalizeLinkDrafts([]), { links: [] })
})

test('只填了 URL 或用途、漏掉标签时报错，不静默吞掉用户输入', () => {
  // 粘贴 URL 后按回车就保存，静默丢行会让用户以为已经挂上了。
  assert.match(normalizeLinkDrafts([{ label: ' ', url: 'https://example.com' }]).error, /标签不能为空/)
  assert.match(normalizeLinkDrafts([{ label: '', purpose: '参考' }]).error, /标签不能为空/)
})

test('重复的条目 id 只保留第一个，其余交给宿主补新 id', () => {
  const result = normalizeLinkDrafts([
    { id: 'same', label: '甲' },
    { id: 'same', label: '乙' },
  ])

  assert.deepEqual(result.links, [{ id: 'same', label: '甲' }, { label: '乙' }])
})

test('URL 不是 http(s) 时整批拒绝并点名标签', () => {
  const result = normalizeLinkDrafts([
    { label: '仓库', url: 'https://example.com' },
    { label: '危险', url: 'javascript:alert(1)' },
  ])

  assert.equal(result.links, undefined)
  assert.match(result.error, /「危险」/)
  assert.match(result.error, /http\(s\) 绝对地址/)
})

test('形状不对时报错而不是静默丢字段', () => {
  assert.match(normalizeLinkDrafts('不是数组').error, /数组/)
  assert.match(normalizeLinkDrafts([null]).error, /必须是对象/)
  assert.match(normalizeLinkDrafts([{ label: 1 }]).error, /label 必须是字符串/)
  assert.match(normalizeLinkDrafts([{ label: 'x', url: 2 }]).error, /url 必须是字符串/)
})
