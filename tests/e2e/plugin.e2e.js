/**
 * 客户端半边在真实宿主里挂载。
 *
 * 这是本仓最容易静默回退的一条：`lib/client.js` 是构建产物且不入库，构建失败、
 * 基线模块名漂移、注入面变化都会让插件在界面上什么都不显示——宿主照常启动，
 * 没有任何报错。断言落在插件自己的容器 class 上，不用「页面能打开」代替。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchE2E } from './harness.mjs'

test('左栏项目区块在真实宿主里挂载，且浏览器不写盘', { timeout: 180_000 }, async (t) => {
  const e2e = await launchE2E()
  t.after(() => e2e.stop())

  await e2e.open()

  const section = e2e.page.locator('.dsh-leader-kit-project-section')
  await section.waitFor({ state: 'visible', timeout: 30_000 })

  // 文案来自插件的 locale 字典：容器在、文案对，才算这颗 bundle 真的跑起来了。
  await e2e.page.locator('.dsh-leader-kit-project-header-label', { hasText: '项目' }).waitFor({ state: 'visible' })
  assert.match(
    (await section.innerText()).trim(),
    /还没有项目/,
    '空数据时应显示插件的空态文案',
  )

  // 浏览器的读写边界：看板数据来自会话事件，客户端不直接写卡片库。
  assert.equal(
    existsSync(join(e2e.instance.home, 'dsh-leader-kit', 'cards.json')),
    false,
    '打开页面不应写出卡片库——浏览器侧没有文件系统',
  )

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
