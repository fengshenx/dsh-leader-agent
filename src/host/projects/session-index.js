/**
 * 项目下的会话索引：把会话按项目目录归组。
 *
 * 归组的判据是**目录 + worker 身份**，不是会话与项目的显式指针——worker 会话没有
 * 任何项目字段，只有 `SessionHeader.cwd` 能说明它跑在哪。
 *
 * **项目下只列 worker 会话**。worker 是普通根会话，会话头里没有身份标记，谁是
 * worker 只能由调用方传入的登记判定（`isWorkerSession`）说了算。同一目录里还可能
 * 有别的会话：leader 自己（入口在项目行上）、用户在项目目录里手动开的（那是用户
 * 自己的会话，不属于项目编排）。把它们混进项目会让「项目下有哪些 worker」失真。
 *
 * **目录必须按 realpath 归一后再比**。同一物理目录在会话头里有多种写法：macOS 的
 * `/tmp` 是指向 `/private/tmp` 的符号链接，项目记录里存的是用户给的原始路径，会话
 * 头里存的是宿主创建会话时的写法，两者字符串不等但目录相同。按字符串比会把同一个
 * 项目拆成两组，worker 会话与 leader 会话分家。官方 workspace 注册表也是这么做的
 * （`realpathNormalize`），第三方没有理由发明另一套。
 *
 * @module dsh-leader-agent/host/projects/session-index
 */

/**
 * 创建路径归一器：realpath 解析 + 进程内缓存。
 *
 * 缓存的是「原始路径 → 归一路径」，因为会话头里的 cwd 高度重复（同一目录的多个
 * 会话共用一个字符串），而归一结果对同一进程内不变。解析失败（目录已删）时回落
 * 解析后的绝对路径——此时会话就是「孤儿会话」，不归属任何项目，但也不能因此
 * 让整个聚合失败。
 *
 * @param {(path: string) => Promise<string>} realpath - realpath 实现
 * @returns {(path: string) => Promise<string>} 归一器
 */
export function createCanonicalizer(realpath) {
  /** @type {Map<string, string>} 原始路径到归一路径 */
  const cache = new Map()
  return async (path) => {
    const cached = cache.get(path)
    if (cached !== undefined) return cached
    let canonical
    try {
      canonical = await realpath(path)
    } catch {
      canonical = path
    }
    cache.set(path, canonical)
    return canonical
  }
}

/**
 * 按项目目录给会话归组。
 *
 * 纯函数：路径归一由调用方注入，便于测试。
 *
 * @param {object} options - 选项
 * @param {object[]} options.projects - 项目记录，每条至少有 `id` 与 `directory`
 * @param {object[]} options.sessions - 会话摘要，每条至少有 `id` 与 `cwd`
 * @param {(path: string) => Promise<string>} options.canonicalize - 路径归一器
 * @param {(sessionId: string) => boolean} options.isWorkerSession - worker 会话判定。
 *   会话头看不出身份（根会话没有 `origin` 标记），只能按登记表判，所以这里是必需的。
 * @returns {Promise<Map<string, string[]>>} 项目 id 到 worker 会话 id 列表；没有 worker 的项目不在映射里
 */
export async function groupSessionsByProject({ projects, sessions, canonicalize, isWorkerSession }) {
  /** @type {Map<string, string>} 归一后的项目目录到项目 id */
  const projectIdByDirectory = new Map()
  for (const project of projects) {
    const canonical = await canonicalize(project.directory)
    // 两个项目指向同一目录时，先注册的那个保留归属——项目是显式注册实体，重叠是
    // 用户的误操作，不该让后注册的项目悄悄接管前者的会话。
    if (!projectIdByDirectory.has(canonical)) {
      projectIdByDirectory.set(canonical, project.id)
    }
  }

  /** @type {Map<string, string[]>} 项目 id 到会话 id 列表 */
  const grouped = new Map()
  for (const session of sessions) {
    // 只有本 bundle 派出的 worker 属于项目：leader 会话的入口在项目行上，用户在项目
    // 目录里手动开的会话也不该混进项目的编排视图。身份只能按登记表判——worker 是
    // 普通根会话（由 `agents.create` 建），会话头没有 `origin` 标记。
    if (!isWorkerSession(session.id)) continue
    if (typeof session.cwd !== 'string' || session.cwd === '') continue
    const canonical = await canonicalize(session.cwd)
    const projectId = projectIdByDirectory.get(canonical)
    if (projectId === undefined) continue
    const bucket = grouped.get(projectId)
    if (bucket === undefined) {
      grouped.set(projectId, [session.id])
      continue
    }
    bucket.push(session.id)
  }
  return grouped
}
