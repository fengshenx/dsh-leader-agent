/**
 * GitHub App 凭据的读取与 installation token 交换。
 *
 * 与入口 `github-app-token.mjs` 分开是因为这个文件要被用例 import：入口里不能有
 * 顶层副作用，否则「既能当脚本又能被 import」就需要一个「是不是被直接执行」的
 * 守卫，而那个守卫在路径经过软链时会判错——脚本退 0、stdout 为空，调用方的
 * `TOKEN=$(…) && gh …` 不短路，`gh` 接着回落到本人凭证，身份静默变成作者。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CREDENTIAL_DIR = join(homedir(), '.dsh-leader-agent')
export const ENV_FILE = join(CREDENTIAL_DIR, 'github-app.env')
export const KEY_FILE = join(CREDENTIAL_DIR, 'github-app.pem')

/**
 * 读 App id 与 installation id。
 *
 * `envFile` 只为用例注入不存在的路径，生产调用不传。
 *
 * @param {object} [options] - 选项
 * @param {string} [options.envFile] - 凭证文件路径
 * @returns {{ appId: string, installationId: string }} 标识
 */
export function readConfig({ envFile = ENV_FILE } = {}) {
  if (!existsSync(envFile)) {
    throw new Error(`缺少凭证文件 ${envFile}，内容形如：\nGITHUB_APP_ID=123456\nGITHUB_APP_INSTALLATION_ID=12345678`)
  }
  const entries = new Map()
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (match) entries.set(match[1], match[2])
  }
  const appId = entries.get('GITHUB_APP_ID')
  const installationId = entries.get('GITHUB_APP_INSTALLATION_ID')
  if (!appId || !installationId) {
    throw new Error(`${envFile} 需同时包含 GITHUB_APP_ID 与 GITHUB_APP_INSTALLATION_ID`)
  }
  return { appId, installationId }
}

/**
 * 用私钥换 installation token。
 *
 * 非 2xx 先按文本截断报出：代理或网关回 HTML 502 时，`json()` 抛的是
 * `Unexpected token '<'`，真实状态码被那句解析错误埋掉。
 *
 * `fetchImpl` 只为用例注入假的响应，生产调用不传。
 *
 * @param {object} options - 选项
 * @param {string} options.jwt - App JWT
 * @param {string} options.installationId - installation id
 * @param {typeof fetch} [options.fetchImpl] - fetch 实现
 * @returns {Promise<string>} installation token
 */
export async function exchangeToken({ jwt, installationId, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    // 网络挂住时不能让调用方一直等；10 秒对一次 token 交换足够宽
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-leader-agent',
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`换取 installation token 失败（HTTP ${response.status}）：${text.slice(0, 400)}`)
  }
  const body = await response.json()
  if (typeof body.token !== 'string') {
    throw new Error(`换取 installation token 的响应里没有 token：${JSON.stringify(body).slice(0, 400)}`)
  }
  return body.token
}
