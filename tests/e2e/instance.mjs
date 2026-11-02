/**
 * e2e 实例夹具：数据根独立、模型指向本地 mock 的 `dsh web`。
 *
 * 与 `npm run dev` 共用 profile 派生（`scripts/dev-instance.mjs`），差别只在
 * 数据根：e2e 每次跑都从空的 `mkdtemp` 根开始，跑完删掉——卡片、项目、会话都
 * 是场景自己种的，不继承上一轮的残留。
 *
 * @module dsh-leader-kit/tests/e2e/instance
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareProfileDir, spawnDshWeb } from '../../scripts/dev-instance.mjs'
import {
  COPIED_PROFILE_FILES, assertWebBundle, devWebBundleHint, explicitEndpointFiles, resolveDevPaths,
} from '../../scripts/dev-plan.mjs'

/** 仓库根：e2e 文件在 `<repo>/tests/e2e/`。 */
export const WORKTREE = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 起一个 e2e 实例。
 *
 * @param {object} options - 选项
 * @param {string} options.baseUrl - mock provider 的 base URL，写进 `DEEPSEEK_BASE_URL`
 * @param {Record<string, string>} [options.env] - 额外的环境变量
 * @returns {Promise<object>} 实例句柄：地址、数据根、日志与幂等停止函数
 */
export async function startInstance({ baseUrl, env = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-'))
  const home = join(root, 'home')
  const paths = resolveDevPaths({
    worktree: WORKTREE,
    homeDir: homedir(),
    env: { DSH_HOME: home, DSH_HOME_SOURCE: process.env.DSH_HOME_SOURCE, DSH_PROFILE: process.env.DSH_PROFILE },
  })

  const sourcePackagePath = join(paths.sourceProfileDir, 'package.json')
  if (!existsSync(sourcePackagePath)) {
    throw new Error(
      `找不到源 profile: ${sourcePackagePath}——e2e 需要一个装好本插件的日常 profile 来派生实例。`
      + '先在 ~/.dsh 里跑一次 dsh plugin add，或设 DSH_HOME_SOURCE 指向已备好的 HOME。',
    )
  }
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'))
  assertWebBundle({
    profileDir: paths.sourceProfileDir,
    bundles: sourcePackage.dsh?.profile?.bundles,
    hint: devWebBundleHint(),
  })

  prepareProfileDir({ worktree: WORKTREE, paths, sourcePackage })

  // 显式 baseURL 的优先级高于环境变量：命中时 mock 会被静默绕开，场景拿真实网络
  // 跑，断言绿了却没证明任何东西。宁可在这里报错。
  const explicit = explicitEndpointFiles(COPIED_PROFILE_FILES.map((name) => {
    const file = join(paths.profileDir, name)
    return { path: file, text: existsSync(file) ? readFileSync(file, 'utf8') : null }
  }))
  if (explicit.length > 0) {
    throw new Error(
      `profile 配置里有显式模型端点，会盖掉 DEEPSEEK_BASE_URL，e2e 的 mock 将失效：${explicit.join(', ')}。`
      + '删掉那几行，或用 DSH_HOME_SOURCE 指向一个没有显式端点的 HOME。',
    )
  }

  const instance = await spawnDshWeb({
    worktree: WORKTREE,
    args: ['web', '--port', '0', '--no-open'],
    env: {
      ...process.env,
      ...env,
      DSH_HOME: home,
      // 假的密钥只是为了让适配器通过启动检查；请求全部落在本地 mock。
      DEEPSEEK_API_KEY: 'e2e-mock-key',
      DEEPSEEK_BASE_URL: baseUrl,
    },
  })

  let stopped = false
  return {
    ...instance,
    home,
    root,
    async stop() {
      if (stopped) return
      stopped = true
      await instance.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
