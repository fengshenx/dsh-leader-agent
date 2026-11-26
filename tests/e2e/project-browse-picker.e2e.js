/**
 * browse 宿主上的「加项目」：native 选择器被拒后，退回应用内目录浏览。
 *
 * 宿主在 linux 缺 zenity/kdialog、无 display、SSH 启动或非 loopback bind 时会组合
 * `browse` 选择器，`uiWorkspace.pickDirectory()` 只服务 native，必然以
 * `directory-picker/unavailable` 拒绝。这里用 `SSH_CONNECTION` 把真实宿主钉到
 * browse（判定见 `dsh-host-directory-picker-auto/src/resolve.ts`），再走真实 UI：
 * 点加项目 → 目录浏览弹层 → 从根走到临时目录 → 选中 → 项目落盘。
 *
 * 不断言选择器长什么样：路径从宿主的 `listDirectory` 来的，弹层只负责呈现；
 * 断言落在「弹层出现」「能走到目标目录」「项目真的建出来」三件事上。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { launchE2E, scenarioTimeout, waitFor, waitForLocator } from './harness.mjs'

/** 项目注册表的落盘文件。 */
const PROJECTS_FILE = (home) => join(home, 'dsh-leader-agent', 'projects.json')

/**
 * 读已落盘的项目目录列表；文件还没写出来时返回空数组。
 * @param {string} home - 实例数据根
 * @returns {string[]} 项目目录
 */
function projectDirectories(home) {
  const file = PROJECTS_FILE(home)
  if (!existsSync(file)) return []
  try {
    return (JSON.parse(readFileSync(file, 'utf8')).projects ?? []).map((project) => project.directory)
  } catch {
    // 宿主用原子写，半截文件不该出现；读失败当下一次轮询再判。
    return []
  }
}

test('browse 宿主上加项目退回应用内目录浏览并建成项目', { timeout: scenarioTimeout() }, async (t) => {
  // 目标目录放在 /tmp 下：从主目录经根走两步就能到，不依赖用户 home 的布局。
  // 不用 os.tmpdir()：macOS 上它是 /var/folders/… 的深路径，从根点进去要走十几层。
  const targetRoot = mkdtempSync('/tmp/dsh-leader-agent-e2e-browse-')
  const projectDirectory = join(targetRoot, 'project-browse')
  mkdirSync(projectDirectory)

  const e2e = await launchE2E({
    name: 'project-browse-picker',
    // 只改 launch 事实，不改宿主组合：SSH 启动是宿主选择 browse 的公开判据之一。
    env: { SSH_CONNECTION: '198.51.100.9 51234 127.0.0.1 22' },
  })
  t.after(async () => {
    await e2e.stop()
    rmSync(targetRoot, { recursive: true, force: true })
  })

  const { page } = e2e
  await e2e.open()

  const addButton = page.locator('button[title="加项目：选一个目录"]')
  await waitForLocator(addButton, { description: '左栏出现「加项目」按钮', timeoutMs: 30_000 })
  await addButton.click()

  const dialogTitle = page.getByText('选择项目目录', { exact: true })
  await waitForLocator(dialogTitle, { description: 'native 被拒后弹出应用内目录浏览', timeoutMs: 20_000 })

  const list = page.locator('.dsh-leader-agent-browse-list')
  await waitForLocator(list.locator('[data-dsh-leader-agent-browse-entry]').first(), {
    description: '目录浏览读到主目录列表',
    timeoutMs: 20_000,
  })

  // 显示链在主目录处截断（与宿主官方浏览器一致），出 home 子树只能靠「上一级」。
  const level = () => page.locator('[data-dsh-leader-agent-browse-level]')
    .getAttribute('data-dsh-leader-agent-browse-level')
  const upButton = page.locator('[data-dsh-leader-agent-browse-up]')
  await waitFor({ description: '目录浏览落在某级目录', check: async () => typeof await level() === 'string' })
  for (let depth = 0; depth < 10; depth += 1) {
    const current = await level()
    if (current === '/') break
    await upButton.click()
    await waitFor({
      description: `从 ${current} 上移到父目录`,
      check: async () => {
        const next = await level()
        return typeof next === 'string' && next !== current
      },
    })
  }
  assert.equal(await level(), '/', '应能一路回到根目录')

  await waitForLocator(list.getByRole('button', { name: 'tmp', exact: true }), {
    description: '根目录列表里出现 tmp',
  })
  await list.getByRole('button', { name: 'tmp', exact: true }).click()

  const targetName = basename(targetRoot)
  await waitForLocator(list.getByRole('button', { name: targetName, exact: true }), {
    description: 'tmp 列表里出现本次临时目录',
  })
  await list.getByRole('button', { name: targetName, exact: true }).click()

  await waitForLocator(list.getByRole('button', { name: 'project-browse', exact: true }), {
    description: '临时目录里出现目标项目目录',
  })
  // 弹层动画落定后再截图：这是给人看的证据，不作为断言。
  await e2e.screenshot('browse-dialog')
  await list.getByRole('button', { name: 'project-browse', exact: true }).click()

  const selectButton = page.locator('[data-dsh-leader-agent-browse-select]')
  await waitForLocator(selectButton, { description: '目录浏览的「选择此目录」可用' })
  await selectButton.click()

  // 弹层选完即关，项目在宿主侧建出来才刷新列表——以落盘为真源，再等行出现。
  await waitForLocator(page.locator('[data-dsh-leader-agent-projects]').getByText('project-browse', { exact: true }), {
    description: '项目行出现在左栏',
    timeoutMs: 20_000,
  })
  await waitFor({
    description: '项目目录以目标路径落盘',
    check: () => projectDirectories(e2e.instance.home).includes(projectDirectory),
    timeoutMs: 20_000,
  })

  assert.deepEqual(e2e.problems, [], '页内不应有未处理的异常或 console 错误')
})
