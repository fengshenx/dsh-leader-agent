/**
 * 设置页的两块分区：看板展示是浏览器偏好，自动续行是宿主侧实例配置。
 *
 * 断言的落点：
 * - 两个 `settings-section` 各自有标题与控件，不混在同一组；
 * - 自动续行默认 200、非法值就地报错、保存后落进 `settings.json`；
 * - reload 后重新读取配置仍是保存值；
 * - 看板展示的范围说明不再写「不写入项目数据」，改成能读懂的浏览器偏好。
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

test('设置页：看板展示与自动续行分区，保存 350 后 reload 仍生效', { timeout: scenarioTimeout() }, async (t) => {
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
  const boardScope = (await boardSection.locator('.dsh-leader-agent-settings-scope').innerText()).trim()
  assert.match(boardScope, /只保存在当前浏览器/)
  assert.doesNotMatch(boardScope, /不写入项目数据/, '看板范围的旧文案会被误读成项目配置，必须换掉')

  // 分区二：自动续行。输入框与保存按钮只在这一块里。
  assert.equal(
    (await autoSection.locator('.dsh-leader-agent-settings-subtitle').innerText()).trim(),
    '自动续行',
  )
  const input = autoSection.locator(INPUT)
  const save = autoSection.getByRole('button', { name: '保存', exact: true })
  await waitForLocator(input, { description: '自动续行输入框', timeoutMs: 10_000 })

  // 默认值来自宿主设置存储，不是浏览器 localStorage。
  await waitFor({
    description: '读到默认上限 200',
    check: async () => (await input.inputValue()) === '200',
    timeoutMs: 10_000,
  })
  const autoScope = (await autoSection.locator('.dsh-leader-agent-settings-scope').innerText()).trim()
  assert.match(autoScope, /所有项目共用/)

  // 非法值就地报错、保存按钮不可用；不弹浏览器原生校验气泡。
  await input.fill('0')
  await waitForLocator(autoSection.locator('.dsh-leader-agent-settings-error'), {
    description: '非法上限的就地报错',
    timeoutMs: 5_000,
  })
  assert.equal(await save.isDisabled(), true, '非法值时保存按钮应禁用')

  // 合法值：保存后按钮回到可用态并显示已保存。
  await input.fill('350')
  await waitFor({
    description: '合法值让保存按钮可用',
    check: async () => !(await save.isDisabled()),
    timeoutMs: 5_000,
  })
  await save.click()
  await waitForLocator(autoSection.locator('.dsh-leader-agent-settings-saved'), {
    description: '保存成功提示',
    timeoutMs: 10_000,
  })
  assert.equal(await input.inputValue(), '350')

  // 落盘是设置的唯一真源，浏览器只读回显。
  const stored = await waitFor({
    description: '自动续行上限落进 settings.json',
    check: async () => {
      try {
        return JSON.parse(await readFile(join(e2e.instance.home, 'dsh-leader-agent', 'settings.json'), 'utf8'))
      } catch {
        return undefined
      }
    },
    timeoutMs: 10_000,
  })
  assert.equal(stored.autoResumeLimit, 350)

  // reload 后重新打开设置页：宿主侧配置被重新读出，不是回到 200。
  await e2e.page.reload({ waitUntil: 'domcontentloaded' })
  const reopened = await openPluginSettings(e2e.page)
  const reloadedInput = reopened.locator(SECTION).nth(1).locator(INPUT)
  await waitFor({
    description: 'reload 后仍读到 350',
    check: async () => (await reloadedInput.inputValue()) === '350',
    timeoutMs: 15_000,
  })

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
