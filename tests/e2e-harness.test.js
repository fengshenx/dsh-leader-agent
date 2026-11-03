/**
 * 夹具自身的可观测性：关闭失败不能吞、清理失败要合并成一条、测试级上限跟着倍率走。
 *
 * 这些行为都在「出问题时才走」的分支上——e2e 绿的时候没人看得见，写在这里才能
 * 双向验证。假件照 Playwright `Browser` 的真实 API 面构造：只给 `close()`。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeBrowser, scenarioTimeout, stopScenario } from './e2e/harness.mjs'

test('没有浏览器句柄时直接算关闭成功', async () => {
  assert.equal(await closeBrowser(null), true)
  assert.equal(await closeBrowser(undefined), true)
})

test('关闭被拒绝要原样抛出去，不能吞成成功', async () => {
  const browser = {
    close: async () => {
      throw new Error('Target page, context or browser has been closed')
    },
  }
  await assert.rejects(() => closeBrowser(browser), /has been closed/)
})

test('关闭超时只告警并继续清理', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const inBudget = await closeBrowser({ close: () => new Promise(() => {}) }, 30)
  assert.equal(inBudget, false)
  assert.equal(warn.mock.callCount(), 1)
})

test('超时之后才拒绝的关闭不会变成未处理的 rejection', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const browser = {
    close: () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('迟到的拒绝')), 40)
    }),
  }
  assert.equal(await closeBrowser(browser, 10), false)
  // 让那条迟到的拒绝落地：没有 catch 兜底时这里是进程级 unhandled rejection。
  await new Promise((resolve) => setTimeout(resolve, 60))
})

test('清理失败合并成一条，且后续步骤与删根都照跑', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-cleanup-'))
  const order = []
  const resources = {
    browser: { close: async () => order.push('browser') },
    instance: {
      stop: async () => {
        order.push('instance')
        throw new Error('dsh web 进程 4242 在 SIGKILL 后仍未退出')
      },
    },
    mock: { stop: async () => order.push('mock') },
    root,
  }
  await assert.rejects(
    () => stopScenario(resources),
    /e2e 清理失败：\n停止实例: dsh web 进程 4242 在 SIGKILL 后仍未退出/,
  )
  assert.deepEqual(order, ['browser', 'instance', 'mock'], '前一环挂了，后面的资源仍要收掉')
  assert.equal(existsSync(root), false, '清理失败也要删掉数据根')
})

test('清理顺利时静默返回，没有数据根也不报错', async () => {
  const order = []
  await stopScenario({
    browser: { close: async () => order.push('browser') },
    instance: { stop: async () => order.push('instance') },
    mock: { stop: async () => order.push('mock') },
    root: null,
  })
  assert.deepEqual(order, ['browser', 'instance', 'mock'])
})

test('测试级上限跟着 E2E_BUDGET_SCALE 放大', () => {
  assert.equal(scenarioTimeout(), 90_000)
  process.env.E2E_BUDGET_SCALE = '1.5'
  try {
    assert.equal(scenarioTimeout(), 135_000)
  } finally {
    delete process.env.E2E_BUDGET_SCALE
  }
})
