/**
 * 客户端半边在真实宿主里挂载。
 *
 * 这是本仓最容易静默回退的一条：`lib/client.js` 是构建产物且不入库，构建失败、
 * 基线模块名漂移、注入面变化都会让插件在界面上什么都不显示——宿主照常启动，
 * 没有任何报错。断言落在插件自己的容器 class 上，不用「页面能打开」代替。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchE2E, scenarioTimeout, waitForLocator } from './harness.mjs'

test('左栏项目区块在真实宿主里挂载', { timeout: scenarioTimeout() }, async (t) => {
  const e2e = await launchE2E({ name: 'plugin' })
  t.after(() => e2e.stop())

  await e2e.open()

  const section = e2e.page.locator('.dsh-leader-kit-project-section')
  await waitForLocator(section, { description: '插件项目区块在左栏挂载', timeoutMs: 20_000 })

  // 文案来自插件的 locale 字典：容器在、文案对，才算这颗 bundle 真的跑起来了。
  await waitForLocator(e2e.page.locator('.dsh-leader-kit-project-header-label', { hasText: '项目' }), {
    description: '项目区块标题文案出现',
  })
  assert.match(
    (await section.innerText()).trim(),
    /还没有项目/,
    '空数据时应显示插件的空态文案',
  )
  // 回归靠断言；截图只给人看「插件确实在界面上」，路径打印在 stdout。
  await e2e.screenshot('project-section')

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
