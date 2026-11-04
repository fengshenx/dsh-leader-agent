import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exchangeToken, readConfig } from '../scripts/github-app-credentials.mjs'

/**
 * 造一个假的 fetch 实现。
 *
 * @param {object} response - 假响应
 * @param {boolean} response.ok - 是否成功
 * @param {number} response.status - 状态码
 * @param {() => Promise<unknown>} response.body - 响应体读取器
 * @returns {typeof fetch} 假 fetch
 */
function fakeFetch(response) {
  return async () => ({
    ok: response.ok,
    status: response.status,
    text: async () => String(await response.body()),
    json: async () => response.body(),
  })
}

test('非 2xx 时报出状态码与响应正文，而不是抛 JSON 解析错误', async () => {
  const fetchImpl = fakeFetch({ ok: false, status: 502, body: async () => '<html>bad gateway</html>' })
  await assert.rejects(
    () => exchangeToken({ jwt: 'jwt', installationId: '1', fetchImpl }),
    /HTTP 502.*bad gateway/s,
  )
})

test('2xx 但响应里没有 token 时如实说出来', async () => {
  const fetchImpl = fakeFetch({ ok: true, status: 201, body: async () => ({ message: 'weird' }) })
  await assert.rejects(
    () => exchangeToken({ jwt: 'jwt', installationId: '1', fetchImpl }),
    /响应里没有 token/,
  )
})

test('成功时返回 token', async () => {
  const fetchImpl = fakeFetch({ ok: true, status: 201, body: async () => ({ token: 'ghs_example' }) })
  assert.equal(await exchangeToken({ jwt: 'jwt', installationId: '1', fetchImpl }), 'ghs_example')
})

test('token 交换带本仓 User-Agent', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return { ok: true, status: 201, text: async () => '', json: async () => ({ token: 'ghs_example' }) }
  }
  await exchangeToken({ jwt: 'jwt', installationId: '1', fetchImpl })
  assert.equal(seen[0].init.headers['User-Agent'], 'dsh-leader-agent')
})

test('凭据文件缺失时按 Fail Loud 报出路径', () => {
  assert.throws(
    () => readConfig({ envFile: '/nowhere/github-app.env' }),
    /缺少凭证文件 \/nowhere\/github-app\.env/,
  )
})

test('凭据缺字段时指出缺的是什么', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-'))
  try {
    const envFile = join(dir, 'github-app.env')
    writeFileSync(envFile, 'GITHUB_APP_ID=4881745\n')
    assert.throws(
      () => readConfig({ envFile }),
      /需同时包含 GITHUB_APP_ID 与 GITHUB_APP_INSTALLATION_ID/,
    )
    writeFileSync(envFile, 'GITHUB_APP_ID=4881745\nGITHUB_APP_INSTALLATION_ID=160244938\n')
    assert.deepEqual(readConfig({ envFile }), { appId: '4881745', installationId: '160244938' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
