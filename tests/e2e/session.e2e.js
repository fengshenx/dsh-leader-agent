/**
 * 无密钥的一轮对话：页面 → wire → agent loop → mock provider → 落盘。
 *
 * 这条用例守的是整条组装链，而不是某个组件：客户端插件在真实宿主里挂载、
 * 输入框把消息送到宿主、宿主按 `DEEPSEEK_BASE_URL` 请求本地 mock、回复渲染上屏
 * 并写进会话日志。断任何一处，后面所有派工场景都不成立。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchE2E, waitFor } from './harness.mjs'
import { sessionLogsContain } from './session-logs.mjs'

/** 场景标记：mock 用它选脚本，一个标记只表达一个场景。 */
const MARKER = 'MOCK-E2E-REPLY'
const REPLY = 'mock 回执已收到'

test('一条带标记的消息走完真实宿主链，回复上屏并落盘', { timeout: 180_000 }, async (t) => {
  const e2e = await launchE2E({ name: 'session', scripts: { [MARKER]: [{ text: REPLY }] } })
  t.after(() => e2e.stop())

  await e2e.open()

  // composer 是 contenteditable 的 div，不是 input：role 定位会先命中左栏搜索框。
  // 启动早期它还是 `data-phase="inert"`（aria-label「选择工作区」），等到可编辑
  // 才是真的能输入——用 contenteditable 属性让 locator 自己等这个状态。
  const composer = e2e.page.locator('div[role="textbox"][contenteditable="true"]').first()
  await composer.click()
  await composer.fill(`${MARKER} 收工即可`)
  await composer.press('Enter')

  // 等状态而不是等时间：回复文本出现在页面上才算这一轮结束。
  await e2e.page.getByText(REPLY).first().waitFor({ state: 'visible', timeout: 90_000 })
  await e2e.screenshot('reply')

  // 宿主会额外用同一模型给会话起标题（`kind: 'title'`），它不算这一轮。
  const scenarioRequests = e2e.mock.requests.filter((request) => request.kind === 'scenario')
  assert.equal(
    scenarioRequests.length,
    1,
    `这一轮只应请求一次模型；实际请求：${e2e.mock.requests.map((request) => request.kind).join(', ') || '（无）'}`,
  )
  assert.equal(scenarioRequests[0].path, '/v1/messages', '模型请求应落在 Messages 端点')
  assert.match(scenarioRequests[0].body, new RegExp(MARKER), '请求体里应带着场景标记')

  // 上屏与落盘是两条独立的路径：屏上有字不等于日志写进去了，反过来也一样。
  await waitFor({
    description: '会话日志里出现回复文本',
    check: () => sessionLogsContain(e2e.instance.home, REPLY),
    timeoutMs: 30_000,
  })

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
