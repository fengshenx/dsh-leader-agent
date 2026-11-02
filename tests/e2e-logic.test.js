import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explicitEndpointFiles, parseWebUrlLine } from '../scripts/dev-plan.mjs'

test('解析 dsh web 就绪行：取出带 token 的地址与真实端口', () => {
  const parsed = parseWebUrlLine('dsh web: http://127.0.0.1:53211/?token=abc123')
  assert.deepEqual(parsed, {
    url: 'http://127.0.0.1:53211/?token=abc123',
    origin: 'http://127.0.0.1:53211',
    port: 53211,
    token: 'abc123',
  })
})

test('不是就绪行时返回 null，不把无关日志当地址', () => {
  assert.equal(parseWebUrlLine('dsh web: opening the default browser; pass --no-open to disable'), null)
  assert.equal(parseWebUrlLine('[probe] 随便一行日志'), null)
  assert.equal(parseWebUrlLine(''), null)
})

test('就绪行没有 token 时报错：无 token 的地址打不开需要鉴权的页面', () => {
  assert.throws(
    () => parseWebUrlLine('dsh web: http://127.0.0.1:53211/'),
    /没有 token/,
  )
})

test('就绪行没有端口时报错：端口 0 时宿主一定会给真实端口', () => {
  assert.throws(
    () => parseWebUrlLine('dsh web: http://127.0.0.1/?token=abc'),
    /没有端口/,
  )
})

test('地址不是合法 URL 时报错并带原值', () => {
  assert.throws(() => parseWebUrlLine('dsh web: 127.0.0.1:53211?token=abc'), /不是合法 URL/)
})

test('显式端点只认 baseURL / baseUrl，不误伤普通配置', () => {
  const files = [
    { path: '/a/cordis.yml', text: '[]' },
    { path: '/b/cordis.patch.yml', text: 'llm-deepseek:\n  baseURL: https://api.deepseek.com/anthropic\n' },
    { path: '/c/other.yml', text: 'baseUrl: http://localhost:1\n' },
    { path: '/d/none.yml', text: null },
    { path: '/e/base.yml', text: 'baseUrlMount: /x\n' },
  ]
  assert.deepEqual(explicitEndpointFiles(files), ['/b/cordis.patch.yml', '/c/other.yml'])
})
