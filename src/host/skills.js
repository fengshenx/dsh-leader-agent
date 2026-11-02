/**
 * bundle 内置 skill 的 provider。
 *
 * 把本包 `.agents/skills/` 目录下的每个 `<name>/SKILL.md` 注册进 `ctx.skills`，
 * 让模型能通过 dsh 的 `skill` 工具发现与加载协议层。
 *
 * @module dsh-leader-kit/host/skills
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter } from '../shared/frontmatter.js'

/** 与 dsh skill-filesystem 的 bundled 语义对齐：项目内的副本优先于 bundle 副本。 */
const BUNDLED_RANK = 600

/**
 * 校验 skill 名称（kebab-case）。
 * @param {string} name - 候选名称
 * @returns {boolean} 是否合法
 */
function isValidSkillName(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

/**
 * 读取一个 skill 目录，返回可发现的候选。
 * @param {string} directory - skill 目录绝对路径
 * @param {string} providerName - provider 名称
 * @returns {Promise<object | undefined>} skill 候选；不可用时返回 undefined
 */
async function readCandidate(directory, providerName) {
  const file = join(directory, 'SKILL.md')
  let info
  try {
    info = await stat(file)
  } catch {
    return undefined
  }
  if (!info.isFile()) return undefined
  const text = await readFile(file, 'utf8')
  const { data, body } = parseFrontmatter(text)
  const name = data.name ?? ''
  const description = data.description ?? ''
  if (!isValidSkillName(name) || description === '') return undefined
  /** @type {object} */
  const candidate = {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: providerName,
    path: file,
    rank: BUNDLED_RANK,
    locator: { directory },
    resourceBase: { kind: 'directory', path: directory },
  }
  if (data.whenToUse !== undefined && data.whenToUse !== '') {
    candidate.whenToUse = data.whenToUse
  }
  return candidate
}

/**
 * 创建 bundle skill provider。
 * @param {object} options - 提供者选项
 * @param {string} options.skillsRoot - bundle 内 skills 目录绝对路径
 * @param {string} options.providerName - provider 名称
 * @returns {object} dsh skill provider
 */
export function createSkillProvider({ skillsRoot, providerName }) {
  return {
    name: providerName,
    async list() {
      let entries
      try {
        entries = await readdir(skillsRoot, { withFileTypes: true })
      } catch {
        return []
      }
      const candidates = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const candidate = await readCandidate(join(skillsRoot, entry.name), providerName)
        if (candidate !== undefined) candidates.push(candidate)
      }
      return candidates
    },
    async get(candidate) {
      const locator = candidate.locator
      if (typeof locator !== 'object' || locator === null || !('directory' in locator)) {
        return undefined
      }
      const directory = /** @type {{ directory: string }} */ (locator).directory
      const file = join(directory, 'SKILL.md')
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return undefined
      }
      const { data, body } = parseFrontmatter(text)
      return {
        ...candidate,
        description: data.description ?? candidate.description,
        content: body.trim(),
      }
    },
  }
}
