import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipText } from '../src/shared/truncate.js'

/**
 * 找出正文里第一个孤立代理的下标。
 *
 * 按 UTF-16 码元切会劈开代理对，留下渲染成 U+FFFD 的半个字符。
 *
 * @param {string} text - 待检正文
 * @returns {number | undefined} 孤立代理的下标；没有则 undefined
 */
function loneSurrogateAt(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return index
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return index
    }
  }
  return undefined
}

test('没超上限时原样返回，不画蛇添足', () => {
  assert.equal(clipText('短正文', 10), '短正文')
  assert.equal(clipText('刚好十个字符', 6), '刚好十个字符')
})

test('非字符串与空串返回空串，不把 undefined 渲染成 "undefined"', () => {
  assert.equal(clipText(undefined, 10), '')
  assert.equal(clipText(null, 10), '')
  assert.equal(clipText('', 10), '')
})

test('上限为 0 或负数时返回空串，不越界', () => {
  assert.equal(clipText('正文', 0), '')
  assert.equal(clipText('正文', -5), '')
})

test('超限时截断并标注原长，标记计入上限', () => {
  const text = clipText('甲'.repeat(200), 120, '；完整内容用 read_worker_session 回看')
  assert.ok(text.length <= 120, `正文长度 ${text.length} 超过上限`)
  assert.match(text, /^甲+…（已截断，原长 200 字符；完整内容用 read_worker_session 回看）$/)
})

test('不传提示时标记只给原长', () => {
  const text = clipText('x'.repeat(100), 60)
  assert.ok(text.length <= 60)
  assert.match(text, /…（已截断，原长 100 字符）$/)
})

test('上限装不下标记时退化成省略号，仍不超限', () => {
  const text = clipText('abcdefghij', 5)
  assert.ok(text.length <= 5, `正文长度 ${text.length} 超过上限`)
  assert.match(text, /…$/)
})

test('按码点边界退让：切点落在代理对中间时不劈开 emoji', () => {
  // 标记长度固定后，把切点挪到 emoji 的高位代理上。
  const text = `a${'😀'.repeat(50)}`
  for (let limit = 15; limit <= 30; limit += 1) {
    const clipped = clipText(text, limit)
    assert.ok(clipped.length <= limit, `limit=${limit} 超限`)
    assert.equal(loneSurrogateAt(clipped), undefined, `limit=${limit} 切出孤立代理`)
  }
})

test('组合字符被切点分开时只丢重音，不出乱码', () => {
  const text = `${'a'.repeat(50)}e\u0301`
  for (let limit = 15; limit <= 30; limit += 1) {
    const clipped = clipText(text, limit)
    assert.doesNotMatch(clipped, /\uFFFD/)
    assert.equal(loneSurrogateAt(clipped), undefined)
  }
})
