/**
 * 看板默认模式的一次性判定。
 *
 * 老版本没有模式偏好，升级上来在浏览器里和新用户一样（都没有 mode key），
 * 光靠 localStorage 分不出来。这里在数据根写一份一次性标记：**第一次运行本
 * 版本时**已有项目或卡片 → `legacy`（默认工作模式），否则 `fresh`（默认炫酷）。
 * 标记只写一次，之后不再随数据增删变化——用户后来删光项目也不会把默认翻回炫酷。
 *
 * @module dsh-leader-agent/host/board-defaults
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from './home-paths.js'

const MARKER_VERSION = 1
const DATA_DIR = 'dsh-leader-agent'
const MARKER_FILE = 'board-default.json'
const PROJECTS_FILE = 'projects.json'
const CARDS_FILE = 'cards.json'

/**
 * 有项目或卡片即视为老用户。
 *
 * @param {{ projects?: object[], cards?: object[] }} [input] - 两份存储的内容
 * @returns {boolean} 是否老用户
 */
export function isLegacyUser({ projects = [], cards = [] } = {}) {
  return projects.length > 0 || cards.length > 0
}

/**
 * 读一份存储列表；文件不存在或损坏时当作空表，不阻断启动。
 *
 * @param {string} file - 存储文件路径
 * @param {string} key - 列表字段名（projects / cards）
 * @returns {Promise<object[]>} 列表
 */
async function readList(file, key) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed?.[key]) ? parsed[key] : []
  } catch {
    // 文件还没建、或者被手改坏了：没有数据可判，按空表处理
    return []
  }
}

/**
 * 读一次性标记；没有就按当前数据算一次并写回。
 *
 * @param {{ home?: string }} [options] - `home` 是 dsh 数据根
 * @returns {Promise<{ defaultMode: 'cinema' | 'work', legacy: boolean }>} 默认模式
 */
export async function resolveBoardDefaults({ home = resolveDshHome() } = {}) {
  const directory = join(home, DATA_DIR)
  const markerFile = join(directory, MARKER_FILE)
  try {
    const marker = JSON.parse(await readFile(markerFile, 'utf8'))
    if (typeof marker?.legacy === 'boolean') {
      return { defaultMode: marker.legacy ? 'work' : 'cinema', legacy: marker.legacy }
    }
  } catch {
    // 首次启动或标记损坏：下面重算并写回
  }
  const [projects, cards] = await Promise.all([
    readList(join(directory, PROJECTS_FILE), 'projects'),
    readList(join(directory, CARDS_FILE), 'cards'),
  ])
  const legacy = isLegacyUser({ projects, cards })
  // 标记只是缓存：数据目录只读或磁盘满时写不进去，不能因此让默认判定失败——
  // 老用户会退回新装的炫酷。下次启动重算即可。
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(
      markerFile,
      `${JSON.stringify({ version: MARKER_VERSION, legacy, capturedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // 原因见上：写不进标记不影响本次返回值
  }
  return { defaultMode: legacy ? 'work' : 'cinema', legacy }
}
