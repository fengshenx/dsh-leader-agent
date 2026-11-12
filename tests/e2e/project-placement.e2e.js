/**
 * 项目区块在左栏里的落点：面板列表之下、工作区列表之上。
 *
 * 守的是纯布局问题：宿主 0.2.2 把面板列表与工作区包进同一个滚动网格后，老锚点
 * （`nav` 是左栏根的直接子元素）不再成立，区块静默退回栏底的 `sidebar.footer.action`
 * ——功能都在，位置全错。断言读 DOM 结构（落点容器、宽度、与 `nav` / 工作区的文档
 * 顺序），不读像素坐标；截图只解释「当时长什么样」。
 *
 * 先等区块在**任意位置**挂载再断言：修复失效时它仍会在 footer 里出现，失败形态
 * 因此是带读数的断言红，而不是「等它进落点」的 20 秒超时。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchE2E, scenarioTimeout, waitFor, waitForLocator } from './harness.mjs'

test('项目区块落在工作区列表之上，不退回左栏底部', { timeout: scenarioTimeout() }, async (t) => {
  const e2e = await launchE2E({ name: 'project-placement' })
  t.after(() => e2e.stop())

  await e2e.open()

  await waitForLocator(e2e.page.locator('.dsh-leader-agent-project-section'), {
    description: '项目区块挂载（任意位置，退回 footer 也算）',
    state: 'attached',
    timeoutMs: 20_000,
  })

  /**
   * 落点读数。成功与失败都读同一份，断言文本里带着它。
   *
   * `expectedParent` 按宿主结构取：0.2.2 起 `nav` 在滚动网格里，落点应是网格中的
   * 工作区容器；0.2.1 的 `nav` 是左栏根的直接子元素，落点应是左栏根（容器插在
   * `nav` 与工作区之间）。两种结构下 `region` 都是 `[class*="regionArea"]`。
   *
   * @returns {Promise<object>} 读数
   */
  const readPlacement = () => e2e.page.evaluate(() => {
    const section = document.querySelector('.dsh-leader-agent-project-section')
    const host = section?.closest('[data-dsh-leader-agent-projects]') ?? null
    const region = document.querySelector('[class*="regionArea"]')
    const nav = region?.parentElement?.querySelector('nav') ?? null
    const navParent = nav?.parentElement ?? null
    // 0.2.2 的滚动网格带 data-sidebar-scrollport；display:grid 是同一结构的兜底判据。
    const scrollGrid = navParent !== null
      && (navParent.hasAttribute('data-sidebar-scrollport') || getComputedStyle(navParent).display === 'grid')
    const expectedParent = scrollGrid ? region : navParent
    // 工作区主体是工作区容器里除本插件宿主以外的元素：宿主结构里它是唯一的 occupant。
    const workspace = region === null
      ? null
      : Array.from(region.children).find((child) => child !== host) ?? null
    const sectionRect = section?.getBoundingClientRect() ?? null
    const key = host !== null ? 'host' : section?.closest('[class*="footArea"]') !== null ? 'footer' : 'elsewhere'
    return {
      key,
      regionFound: region !== null,
      navFound: nav !== null,
      scrollGrid,
      hostFound: host !== null,
      hostParentIsExpected: host !== null && expectedParent !== null && host.parentElement === expectedParent,
      inFooter: section !== null && section.closest('[class*="footArea"]') !== null,
      afterNav: nav !== null && section !== null
        && (nav.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      aboveWorkspace: workspace !== null && section !== null
        && (section.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      sectionWidth: sectionRect === null ? 0 : Math.round(sectionRect.width),
      sectionHeight: sectionRect === null ? 0 : Math.round(sectionRect.height),
    }
  })

  // 等落点稳定：mount 先落在 footer，portal 的 effect 随后才把内容搬走。连续三次
  // 读到同一个落点才判定稳定（约两个轮询间隔）；成功与失败都按同一个口径收敛，
  // 不把「还没搬完」误判成失败，也不把失败拖成超时。
  let previous = null
  let streak = 0
  const placement = await waitFor({
    description: '项目区块落点稳定（进入落点容器或停在 footer）',
    check: async () => {
      const reading = await readPlacement()
      streak = previous !== null && previous.key === reading.key ? streak + 1 : 1
      previous = reading
      return streak >= 3 ? reading : null
    },
  })

  const reading = JSON.stringify(placement)
  assert.equal(placement.navFound, true, `左栏里应有面板列表 nav；读数 ${reading}`)
  assert.equal(placement.regionFound, true, `左栏里应有工作区容器；读数 ${reading}`)
  assert.equal(placement.hostFound, true, `项目区块应被 portal 搬进左栏落点容器；读数 ${reading}`)
  assert.equal(placement.inFooter, false, `项目区块不应退回栏底的 footer 槽；读数 ${reading}`)
  // 朴素「插到 nav 之后」在 0.2.2 上会被网格摆进 4px × 8px 的空单元格：宽度是
  // 分辨「真落进容器」与「被压成竖条」的关键读数，不能只断言高度非零。
  assert.ok(placement.sectionWidth >= 100, `项目区块宽度不应被网格压成竖条（朴素写法实测 4px）；读数 ${reading}`)
  assert.equal(
    placement.hostParentIsExpected,
    true,
    `落点应是工作区容器（0.2.2）或左栏根（0.2.1），不能是滚动网格本身；读数 ${reading}`,
  )
  assert.equal(placement.afterNav, true, `项目区块应排在面板列表 nav 之后；读数 ${reading}`)
  assert.equal(placement.aboveWorkspace, true, `项目区块应排在工作区列表之前；读数 ${reading}`)
  assert.ok(placement.sectionHeight > 0, `项目区块不应为零高；读数 ${reading}`)

  await e2e.screenshot('project-placement')
  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
