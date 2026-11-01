/**
 * 采集计划：阶段骨架、范围与约束。
 *
 * ## 为什么计划要落库
 *
 * 会话是无状态的：模型每轮重建世界观。计划如果只在对话里，压缩一次就没了。
 * 落库之后，"做到哪一步、下一步做什么、边界在哪"每次都能重新读出来。
 *
 * ## 阶段是固定骨架 + 可追加
 *
 * 固定骨架保证不同会话的推进方式一致（否则又变成"用户为自己的流程负责"）；
 * 允许追加是因为用户的工具组合确实可能多出一步（比如"备案查询"）。
 *
 * @module @infohunter/dsh-information-hunter/plan
 */

/** 固定的阶段骨架。顺序即推荐顺序。 */
export const STAGE_SKELETON = [
  { id: 'scope', label: '确定范围', expected: ['target'] },
  { id: 'dns', label: '解析与子域', expected: ['ip', 'cname'] },
  { id: 'ports', label: '端口', expected: ['port', 'protocol'] },
  { id: 'services', label: '服务识别', expected: ['service', 'version'] },
  { id: 'web', label: 'Web 探活', expected: ['status', 'title', 'tech'] },
  { id: 'systems', label: '系统与路径', expected: ['basePath', 'url'] },
  { id: 'artifacts', label: '信息产物', expected: ['artifact'] },
  { id: 'wrapup', label: '收尾自检', expected: [] },
]

/** 阶段状态机。 */
export const STAGE_STATES = ['pending', 'active', 'done', 'skipped']

/**
 * 新建一份空计划。
 *
 * @returns 计划对象。
 */
export function emptyPlan() {
  return {
    scope: { targets: [], constraints: [] },
    stages: STAGE_SKELETON.map((stage) => ({ ...stage, state: 'pending' })),
    updatedAt: 0,
  }
}

/**
 * 归一化计划（容错读取：缺字段补默认，多余阶段保留）。
 *
 * @param raw - 任意值。
 * @returns 计划对象。
 */
export function normalizePlan(raw) {
  const base = emptyPlan()
  if (raw === null || typeof raw !== 'object') return base
  const targets = Array.isArray(raw.scope?.targets)
    ? raw.scope.targets.map((item) => String(item).trim()).filter((item) => item !== '').slice(0, 200)
    : []
  const constraints = Array.isArray(raw.scope?.constraints)
    ? raw.scope.constraints
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({
        type: item.type === 'allow' ? 'allow' : 'deny',
        text: String(item.text ?? '').trim().slice(0, 500),
      }))
      .filter((item) => item.text !== '')
      .slice(0, 50)
    : []
  const byId = new Map(base.stages.map((stage) => [stage.id, stage]))
  const stages = []
  const input = Array.isArray(raw.stages) ? raw.stages : []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id ?? '').trim()
    if (id === '') continue
    const known = byId.get(id)
    const state = STAGE_STATES.includes(item.state) ? item.state : 'pending'
    stages.push({
      id,
      label: String(item.label ?? known?.label ?? id).slice(0, 80),
      state,
      tool: typeof item.tool === 'string' ? item.tool.slice(0, 80) : '',
      expected: Array.isArray(item.expected)
        ? item.expected.map((value) => String(value).slice(0, 40)).slice(0, 12)
        : (known?.expected ?? []),
    })
    byId.delete(id)
  }
  // 骨架里没出现在输入中的阶段补在末尾，保证阶段不会因为"没传"而消失。
  for (const stage of byId.values()) stages.push({ ...stage, state: 'pending' })
  return {
    scope: { targets, constraints },
    stages,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  }
}

/**
 * 当前阶段（第一个 active；没有 active 就取第一个 pending）。
 *
 * @param plan - 计划对象。
 * @returns 阶段；全部完成时返回 `undefined`。
 */
export function currentStage(plan) {
  const stages = Array.isArray(plan?.stages) ? plan.stages : []
  return stages.find((stage) => stage.state === 'active')
    ?? stages.find((stage) => stage.state === 'pending')
}

/**
 * 计划的完成度。
 *
 * @param plan - 计划对象。
 * @returns `{ done, total, pct, current }`
 */
export function planProgress(plan) {
  const stages = Array.isArray(plan?.stages) ? plan.stages : []
  const done = stages.filter((stage) => stage.state === 'done' || stage.state === 'skipped').length
  const total = stages.length
  return {
    done,
    total,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    current: currentStage(plan)?.id ?? '',
  }
}
