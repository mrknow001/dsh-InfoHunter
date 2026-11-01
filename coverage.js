/**
 * 覆盖度：按「资产 × 证据层」算"还缺什么"。
 *
 * ## 为什么要有它
 *
 * 面板过去只能回答"采了多少条"，回答不了"范围内还有多少没测"。
 * 没有这个数字，agent 只能凭感觉换工具 —— 这正是"不稳定"的来源。
 *
 * 口径是**证据层**而不是字段：层能指导"下一步该用哪类工具"，
 * 字段粒度太碎（缺一个 server 头不值得单独跑一轮）。
 *
 * @module @infohunter/dsh-information-hunter/coverage
 */

/** 证据层。顺序即展示顺序。 */
export const LAYERS = [
  { id: 'dns', label: '解析' },
  { id: 'port', label: '端口' },
  { id: 'service', label: '服务' },
  { id: 'web', label: 'Web' },
  { id: 'tech', label: '指纹' },
  { id: 'system', label: '系统' },
  { id: 'artifact', label: '产物' },
]

/** 判断一个字段是否为空（数字 0 视为空）。 */
function empty(value) {
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'number') return value === 0
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * 一条资产已经具备哪些层。
 *
 * @param asset - 资产节点。
 * @param linkedKinds - 锚到这条资产的来源类型（`record` / `artifact` / `question`）。
 * @returns 层 id 数组。
 */
export function layersOf(asset, linkedKinds = []) {
  const hits = []
  const protocol = String(asset?.protocol ?? '').toLowerCase()
  const isWeb = protocol === 'http' || protocol === 'https' || Number(asset?.status) > 0
  if (!empty(asset?.ip) || !empty(asset?.cname)) hits.push('dns')
  if (Number(asset?.port) > 0) hits.push('port')
  if (!empty(asset?.service) || !empty(asset?.version)) hits.push('service')
  if (isWeb || !empty(asset?.title)) hits.push('web')
  if (!empty(asset?.tech)) hits.push('tech')
  if (asset?.nodeType === 'app' || !empty(asset?.basePath)) hits.push('system')
  if (Array.isArray(linkedKinds) && linkedKinds.includes('artifact')) hits.push('artifact')
  return hits
}

/**
 * 计算一个会话的覆盖度。
 *
 * @param assets - 资产节点数组。
 * @param links - `{ assetKey, sourceKind }[]` 锚点。
 * @returns `{ total, byLayer, overall, uncovered }`
 */
export function coverageOf(assets, links = []) {
  const list = Array.isArray(assets) ? assets : []
  const kindsByAsset = new Map()
  for (const link of Array.isArray(links) ? links : []) {
    const key = String(link?.assetKey ?? '')
    if (key === '') continue
    if (!kindsByAsset.has(key)) kindsByAsset.set(key, new Set())
    kindsByAsset.get(key).add(String(link?.sourceKind ?? ''))
  }
  const byLayer = Object.fromEntries(LAYERS.map((layer) => [layer.id, 0]))
  let fullyCovered = 0
  const uncovered = []
  for (const asset of list) {
    const key = String(asset?.key ?? '')
    const kinds = [...(kindsByAsset.get(key) ?? [])]
    const hits = layersOf(asset, kinds)
    for (const id of hits) byLayer[id] = (byLayer[id] ?? 0) + 1
    const missing = LAYERS.map((layer) => layer.id).filter((id) => !hits.includes(id))
    if (missing.length === 0) fullyCovered += 1
    // 系统节点自己就是"系统"层，不必再要求它缺的那几层（它不是端点）。
    else uncovered.push({ key, host: asset?.host ?? '', missing })
  }
  uncovered.sort((a, b) => b.missing.length - a.missing.length)
  const total = list.length
  return {
    total,
    byLayer,
    overall: total === 0 ? 0 : Math.round((fullyCovered / total) * 100),
    uncovered: uncovered.slice(0, 50),
  }
}
