/**
 * 为 GitHub App 生成 installation access token（默认 1 小时有效），用于以 bot 身份
 * 发 PR 评论。用法、身份边界与防错理由见 AGENTS.md「用 bot 身份发评论」。
 *
 * 本机工具：读 `~/.dsh-leader-agent/github-app.env`（`GITHUB_APP_ID` /
 * `GITHUB_APP_INSTALLATION_ID`）与 `~/.dsh-leader-agent/github-app.pem`，凭据不入库。
 *
 *   TOKEN=$(node scripts/github-app-token.mjs) && GH_TOKEN="$TOKEN" gh pr comment <n> --body-file /tmp/review.md
 *
 * 本文件只做入口：逻辑在 `github-app-credentials.mjs`（可被用例 import）与
 * `github-app-jwt.mjs`。入口不留「是不是被直接执行」的守卫——那种守卫在路径经过
 * 软链时会判错，脚本退 0、stdout 为空，而 `$(…)` 一侧不短路，`gh` 会回落到本人
 * 凭证，评论以作者身份静默发出。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createJwt } from './github-app-jwt.mjs'
import { KEY_FILE, exchangeToken, readConfig } from './github-app-credentials.mjs'

try {
  if (!existsSync(KEY_FILE)) {
    throw new Error(`缺少私钥 ${KEY_FILE}，请在 GitHub App 设置页「Generate a private key」下载后移入`)
  }
  const { appId, installationId } = readConfig()
  const jwt = createJwt({ appId, privateKey: readFileSync(KEY_FILE, 'utf8') })
  process.stdout.write(`${await exchangeToken({ jwt, installationId })}\n`)
} catch (error) {
  process.stderr.write(`github-app-token: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
