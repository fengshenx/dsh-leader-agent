/**
 * 项目区块在左栏里的落点：面板列表之下、工作区列表之上。
 *
 * 守的是纯布局问题：宿主 0.2.2 把面板列表与工作区包进同一个滚动网格后，老锚点
 * （`nav` 是左栏根的直接子元素）不再成立，区块静默退回栏底的 `sidebar.footer.action`
 * ——功能都在，位置全错。断言读 DOM 结构（落点容器、与工作区主体的文档顺序），
 * 不读像素坐标；截图只解释「当时长什么样」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchE2E, scenarioTimeout, waitForLocator } from './harness.mjs'

test('项目区块落在工作区列表之上，不退回左栏底部', { timeout: scenarioTimeout() }, async (t) => {
  const e2e = await launchE2E({ name: 'project-placement' })
  t.after(() => e2e.stop())

  await e2e.open()

  // 先等内容被 portal 到落点容器：宿主结构变了、锚点没找到时，区块会留在
  // footer 里的原锚点上，这条就等不到——正是要红的形态。
  await waitForLocator(e2e.page.locator('[data-dsh-leader-agent-projects] .dsh-leader-agent-project-section'), {
    description: '项目区块搬进左栏落点容器（没有退回栏底）',
    timeoutMs: 20_000,
  })

  const placement = await e2e.page.evaluate(() => {
    const section = document.querySelector('.dsh-leader-agent-project-section')
    const host = section?.closest('[data-dsh-leader-agent-projects]') ?? null
    const region = document.querySelector('[class*="regionArea"]')
    // 工作区主体是容器里除本插件宿主以外的元素：宿主结构里它是唯一的 occupant。
    const workspace = region === null || host === null
      ? null
      : Array.from(region.children).find((child) => child !== host) ?? null
    const inFooter = host !== null && host.closest('[class*="footArea"]') !== null
    // DOCUMENT_POSITION_FOLLOWING：工作区主体排在区块之后 = 区块在它上面。
    const aboveWorkspace = workspace !== null && section !== null
      && (section.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    return {
      inFooter,
      aboveWorkspace,
      sectionHeight: section?.getBoundingClientRect().height ?? 0,
      regionFound: region !== null,
      workspaceFound: workspace !== null,
    }
  })

  const reading = JSON.stringify(placement)
  assert.equal(placement.regionFound, true, `左栏里应有工作区容器；读数 ${reading}`)
  assert.equal(placement.workspaceFound, true, `工作区容器里应有工作区主体；读数 ${reading}`)
  assert.equal(placement.inFooter, false, `项目区块不应退回栏底的 footer 槽；读数 ${reading}`)
  assert.equal(placement.aboveWorkspace, true, `项目区块应排在工作区列表之前；读数 ${reading}`)
  assert.ok(placement.sectionHeight > 0, `项目区块不应为零高；读数 ${reading}`)

  await e2e.screenshot('project-placement')
  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
