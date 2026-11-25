/**
 * 设置页的两块分区：看板展示与自动续行都走宿主 `settings.json`。
 *
 * 断言的落点：
 * - 两个 `settings-section` 各自有标题与控件，不混在同一组；
 * - 看板模式默认 work、切到 cinema 后落盘，reload 后仍选中；
 * - 自动续行默认 200、非法值就地报错、停顿后自动落进 `settings.json`；
 * - 设置行不再有 scope / hint 长说明，也没有保存按钮；
 * - reload 后重新读取配置仍是保存值。
 *
 * 不测样式：颜色、间距、像素位置不在断言里。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchE2E, scenarioTimeout, waitFor, waitForLocator } from './harness.mjs'

const SETTINGS_DIALOG = '[data-shortcut-modal="settings"]'
const SECTION = '.dsh-leader-agent-settings-section'
const INPUT = '#dsh-leader-agent-auto-resume'

/**
 * 读宿主设置文件；文件还没落盘时返回 undefined。
 * @param {object} e2e - e2e 夹具
 * @returns {Promise<object | undefined>} 设置对象
 */
async function readSettingsFile(e2e) {
  try {
    return JSON.parse(await readFile(join(e2e.instance.home, 'dsh-leader-agent', 'settings.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 打开设置面板；入口在「账号菜单 → 设置」里。
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<import('playwright').Locator>} 设置面板
 */
async function openSettings(page) {
  await page.getByRole('button', { name: '账号菜单', exact: true }).first().click()
  const entry = page.getByRole('menuitem', { name: '设置', exact: true }).first()
  await waitForLocator(entry, { description: '账号菜单里的设置入口', timeoutMs: 10_000 })
  await entry.click()
  const dialog = page.locator(SETTINGS_DIALOG)
  await waitForLocator(dialog, { description: '设置面板打开', timeoutMs: 15_000 })
  return dialog
}

/**
 * 打开本插件的设置页并等两块分区渲染完。
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<import('playwright').Locator>} 设置面板
 */
async function openPluginSettings(page) {
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: 'Leader Agent', exact: true }).click()
  const sections = dialog.locator(SECTION)
  await waitFor({
    description: '设置页渲染出两块分区',
    check: async () => (await sections.count()) === 2,
    timeoutMs: 10_000,
  })
  return dialog
}

test('设置页：看板模式与自动续行都落宿主配置，保存后 reload 仍生效', { timeout: scenarioTimeout() }, async (t) => {
  const e2e = await launchE2E({ name: 'settings-auto-resume' })
  t.after(() => e2e.stop())

  await e2e.open()
  const dialog = await openPluginSettings(e2e.page)
  const sections = dialog.locator(SECTION)
  const boardSection = sections.nth(0)
  const autoSection = sections.nth(1)

  // 分区一：看板展示。标题与选项都在自己那一块里。
  assert.equal(
    (await boardSection.locator('.dsh-leader-agent-settings-title').innerText()).trim(),
    '任务看板',
  )
  assert.equal(await boardSection.locator('.dsh-leader-agent-settings-option').count(), 2)
  assert.equal(await boardSection.locator('.dsh-leader-agent-settings-scope').count(), 0, '看板行不再写 scope 长说明')
  assert.equal(await boardSection.locator('.dsh-leader-agent-settings-hint').count(), 0, '看板行不再写 hint 长说明')

  // 看板模式：默认 work，切 cinema 后写宿主设置；不碰 localStorage。
  const workOption = boardSection.locator('.dsh-leader-agent-settings-option').filter({ hasText: '工作模式' }).first()
  const cinemaOption = boardSection.locator('.dsh-leader-agent-settings-option').filter({ hasText: '炫酷模式' }).first()
  await waitFor({
    description: '看板模式选项从宿主读到配置',
    check: async () => !(await cinemaOption.isDisabled()),
    timeoutMs: 10_000,
  })
  assert.equal(await workOption.getAttribute('aria-checked'), 'true', '默认应选中工作模式')
  await cinemaOption.click()
  await waitFor({
    description: '看板模式落进 settings.json',
    check: async () => (await readSettingsFile(e2e))?.boardMode === 'cinema',
    timeoutMs: 10_000,
  })
  assert.equal(await cinemaOption.getAttribute('aria-checked'), 'true', '保存成功后选中炫酷模式')
  assert.equal(
    await e2e.page.evaluate(() => localStorage.getItem('dsh-leader-agent.board.mode')),
    null,
    '看板模式不应再写浏览器 localStorage',
  )

  // 分区二：自动续行。只有一行标题/说明 + 右侧输入框，没有保存按钮。
  assert.equal(
    (await autoSection.locator('.dsh-leader-agent-settings-subtitle').innerText()).trim(),
    '自动续行',
  )
  assert.equal(await autoSection.locator('.dsh-leader-agent-settings-scope').count(), 0, '自动续行行不再写 scope 长说明')
  assert.equal(await autoSection.locator('.dsh-leader-agent-settings-hint').count(), 0, '自动续行行不再写 hint 长说明')
  assert.equal(await autoSection.getByRole('button', { name: '保存', exact: true }).count(), 0, '不应再有保存按钮')
  const input = autoSection.locator(INPUT)
  await waitForLocator(input, { description: '自动续行输入框', timeoutMs: 10_000 })

  // 默认值来自宿主设置存储，不是浏览器 localStorage。
  await waitFor({
    description: '读到默认上限 200',
    check: async () => (await input.inputValue()) === '200',
    timeoutMs: 10_000,
  })

  // 非法值就地报错，不提交。
  await input.fill('0')
  await waitForLocator(autoSection.locator('.dsh-leader-agent-settings-error'), {
    description: '非法上限的就地报错',
    timeoutMs: 5_000,
  })

  // 合法值：输入停顿后自动保存，行下方出现绿色「保存成功」。
  await input.fill('350')
  await waitForLocator(autoSection.locator('.dsh-leader-agent-settings-saved'), {
    description: '自动保存成功提示',
    timeoutMs: 10_000,
  })
  assert.equal((await autoSection.locator('.dsh-leader-agent-settings-saved').innerText()).trim(), '保存成功')
  assert.equal(await input.inputValue(), '350')

  // 落盘是设置的唯一真源，浏览器只读回显。
  const stored = await waitFor({
    description: '自动续行上限落进 settings.json',
    check: async () => {
      const value = await readSettingsFile(e2e)
      return value?.autoResumeLimit === 350 ? value : undefined
    },
    timeoutMs: 10_000,
  })
  assert.equal(stored.autoResumeLimit, 350)
  assert.equal(stored.boardMode, 'cinema', '保存自动续行不能把看板模式冲掉')

  // reload 后重新打开设置页：宿主侧配置被重新读出，不是回到 200。
  await e2e.page.reload({ waitUntil: 'domcontentloaded' })
  const reopened = await openPluginSettings(e2e.page)
  const reloadedBoard = reopened.locator(SECTION).nth(0)
  const reloadedCinema = reloadedBoard.locator('.dsh-leader-agent-settings-option').filter({ hasText: '炫酷模式' }).first()
  await waitFor({
    description: 'reload 后看板模式仍选中 cinema',
    check: async () => (await reloadedCinema.getAttribute('aria-checked')) === 'true',
    timeoutMs: 15_000,
  })
  const reloadedInput = reopened.locator(SECTION).nth(1).locator(INPUT)
  await waitFor({
    description: 'reload 后仍读到 350',
    check: async () => (await reloadedInput.inputValue()) === '350',
    timeoutMs: 15_000,
  })

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
