/**
 * 探索图：需求 → 线索 → 方向（路） → 发现。
 *
 * ## 为什么是"路"而不是"工具调用记录"
 *
 * 一条路必须**可复核**：`(对象, 方法, 参数, 目的)` 四元组固定，重跑能得到同一批结果。
 * 只记"用过 subfinder"没有价值 —— 不知道扫的是哪个域、哪个字典、扫完没有。
 *
 * ## 状态
 *
 * `open → running → done / dead`。**没收获 ≠ 走不通**：查完没有新东西是 done（别重走），
 * 被验证码挡住是 dead（换个方法再来）。两者都要记，否则会反复重走同一条路。
 *
 * @module @infohunter/dsh-information-hunter/graph
 */

import { createHash } from 'node:crypto'

/** 节点类型。 */
export const NODE_KINDS = ['need', 'clue', 'direction', 'finding']

/** 方向（路）的状态机。 */
export const DIRECTION_STATES = ['open', 'running', 'done', 'dead']

/** 需求骨架：固定四类 + 自定义。 */
export const NEED_SKELETON = [
  { id: 'web', label: 'Web 暴露面' },
  { id: 'ports', label: '端口 + IP 暴露面' },
  { id: 'impostor', label: '仿冒站点排查' },
  { id: 'cert', label: '证书与归属' },
  { id: 'other', label: '其他' },
]

/** 单会话方向上限（超出先归档"已完成且无产出"的）。 */
export const DIRECTION_LIMIT = 2000

/** running 超过这个时长算"卡住"。 */
export const OVERDUE_MS = 20 * 60 * 1000

/** 稳定序列化：对象按键排序，保证同样的参数得到同样的 hash。 */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

/** 短哈希。 */
function hash(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex')
}

/**
 * 线索的去重键。
 *
 * @param source - 来源（domain / cert-san / icp / cidr / bing / artifact / title…）。
 * @param text - 线索正文（域名、IP、单位名…）。
 * @returns 键；正文为空时返回空串。
 */
export function clueKey(source, text) {
  const body = String(text ?? '').trim().toLowerCase()
  if (body === '') return ''
  return `clue:${hash(`${String(source ?? '').trim().toLowerCase()}|${body}`)}`
}

/**
 * 方向的去重键：`(对象, 方法, 参数, 目的)`。
 *
 * @param input - `{ target, method, params, needId }`。
 * @returns 键；缺 target 或 method 时返回空串。
 */
export function directionKey(input) {
  const target = String(input?.target ?? '').trim().toLowerCase()
  const method = String(input?.method ?? '').trim().toLowerCase()
  if (target === '' || method === '') return ''
  const need = String(input?.needId ?? 'other').trim().toLowerCase() || 'other'
  return `dir:${hash(`${target}|${method}|${stableJson(input?.params ?? {})}|${need}`)}`
}

/**
 * 发现的去重键。
 *
 * @param text - 一句话结论。
 * @returns 键。
 */
export function findingKey(text) {
  const body = String(text ?? '').trim()
  if (body === '') return ''
  return `finding:${hash(body.toLowerCase())}`
}

/**
 * 方向是否已经卡住太久（running 但没有产出）。
 *
 * @param node - 方向节点。
 * @param now - 当前时间。
 * @returns 是否超时。
 */
export function isOverdue(node, now = Date.now()) {
  if (node?.state !== 'running') return false
  const started = Number(node?.payload?.claimedAt ?? node?.updatedAt ?? 0)
  return started > 0 && now - started > OVERDUE_MS
}

/**
 * 把一堆节点汇总成态势（给 `expose_graph` 与面板用）。
 *
 * @param nodes - 该会话全部节点。
 * @param now - 当前时间。
 * @returns `{ needs, clues, directions, findings, frontier, overdue }`
 */
export function summarize(nodes, now = Date.now()) {
  const list = Array.isArray(nodes) ? nodes : []
  const byKind = (kind) => list.filter((node) => node.kind === kind)
  const directions = byKind('direction')
  const stateCount = (state) => directions.filter((node) => node.state === state).length
  return {
    needs: byKind('need').length,
    needsMet: byKind('need').filter((node) => node.state === 'met').length,
    clues: byKind('clue').length,
    cluesUnused: byKind('clue').filter((node) => node.state === 'open').length,
    directions: directions.length,
    open: stateCount('open'),
    running: stateCount('running'),
    done: stateCount('done'),
    dead: stateCount('dead'),
    findings: byKind('finding').length,
    frontier: directions
      .filter((node) => node.state === 'open')
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, 30),
    overdue: directions.filter((node) => isOverdue(node, now)).slice(0, 30),
  }
}
