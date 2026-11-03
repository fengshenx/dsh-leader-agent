/**
 * 读盘与遍历：把 `.agents/notes/` 摊平成「逐篇违规项」。判定规则在 agent-note-format.mjs。
 *
 * 抽出来是为了让「门禁脚本有没有真的调判定」这件事可测——用例里造一份带断链、
 * 缺节的临时语料跑这里，接线断掉就当场变红。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checkLinks, checkNote } from './agent-note-format.mjs'

/** 根层这两份是目录说明，不是笔记。 */
const NON_NOTE = new Set(['README.md', 'AGENTS.md'])

/** @returns {string[]} 相对 dir 的 POSIX 路径，已排序 */
function collectNotes(dir, prefix = '') {
  const paths = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) paths.push(...collectNotes(join(dir, entry.name), relPath))
    else if (entry.name.endsWith('.md') && !(prefix === '' && NON_NOTE.has(entry.name))) paths.push(relPath)
  }
  return paths.sort()
}

/**
 * @param {string} dir `.agents/notes/` 的绝对路径
 * @returns {{notes: string[], violations: string[]}} 笔记清单与 `路径 — 违规` 形式的问题
 */
export function auditNotes(dir) {
  const notes = collectNotes(dir)
  const violations = notes.flatMap((relPath) => {
    const file = join(dir, relPath)
    const text = readFileSync(file, 'utf8')
    const isReachable = url => existsSync(resolve(dirname(file), url.split('#')[0]))
    return [...checkNote(relPath, text), ...checkLinks(text, isReachable)].map(violation => `${relPath} — ${violation}`)
  })
  return { notes, violations }
}
