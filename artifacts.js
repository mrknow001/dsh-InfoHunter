/**
 * 「信息产物」（artifact）：云资源、泄露物、API 文档、凭据、安装包……
 *
 * ## 它为什么不是资产
 *
 * 资产是"可定位、可复核"的东西（`host:port` / 系统）；产物是**一段文字**：
 * 一把 AK、一个公开的 bucket、一页 Swagger、一个安装包下载地址。
 * 它们没有统一格式，也不该塞进资产表的字段里，所以单独一条记录、一张卡片。
 *
 * ## 这个模块只管纯逻辑
 *
 * 归一化（限长/白名单）、去重指纹、敏感信息正则的编译与扫描。
 * 存储、路由、面板都不在这里 —— 这样扫描规则可以单独测。
 *
 * @module @infohunter/dsh-information-hunter/artifacts
 */

import { createHash } from 'node:crypto'

/** 产物类型白名单。加类型 = 这里加一项 + 面板加一个徽标。 */
export const ARTIFACT_KINDS = ['cloud', 'leak', 'api_doc', 'credential', 'package', 'other']

/** 严重级（由命中的规则里最高的那个推导）。 */
export const SEVERITIES = ['high', 'medium', 'low']

/** 单条产物的长度上限（正文只留证据，不留整页 HTML）。 */
export const CONTENT_LIMIT = 8000
export const TITLE_LIMIT = 200
export const HOW_FOUND_LIMIT = 2000
export const RULE_PATTERN_LIMIT = 500

/** 一次扫描最多留多少个命中（防止一条长文本刷出几百个）。 */
const HITS_LIMIT = 32

/**
 * 默认的敏感信息规则。
 *
 * 手机号与身份证默认**关闭**：它们噪声大，而且"收集个人信息"和"收集凭据"是两件事，
 * 默认开会在产物列表里塞满无意义的号码。
 */
export const DEFAULT_SENSITIVE_RULES = [
  { id: 'aws-ak', name: 'AWS Access Key', pattern: 'AKIA[0-9A-Z]{16}', flags: 'g', severity: 'high', enabled: true, hint: 'AKIA 开头的 20 位' },
  { id: 'aws-sk', name: 'AWS Secret Key', pattern: 'aws_secret_access_key\\s*[=:]\\s*[A-Za-z0-9/+=]{40}', flags: 'gi', severity: 'high', enabled: true, hint: '需要上下文关键字' },
  { id: 'aliyun-ak', name: '阿里云 AccessKey', pattern: 'LTAI[0-9A-Za-z]{12,24}', flags: 'g', severity: 'high', enabled: true, hint: 'LTAI 开头' },
  { id: 'private-key', name: 'PEM 私钥', pattern: '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----', flags: 'g', severity: 'high', enabled: true, hint: '只匹配头部' },
  { id: 'github-token', name: 'GitHub Token', pattern: 'gh[pousr]_[A-Za-z0-9]{36,}', flags: 'g', severity: 'high', enabled: true, hint: 'ghp_ / gho_ / ghs_ …' },
  { id: 'jwt', name: 'JWT', pattern: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', flags: 'g', severity: 'medium', enabled: true, hint: '三段式' },
  { id: 'db-conn', name: '数据库连接串', pattern: '(?:mysql|postgres|postgresql|mongodb|redis|amqp)://[^\\s:@/]+:[^\\s@/]+@', flags: 'gi', severity: 'high', enabled: true, hint: '带口令的连接串' },
  { id: 'password-assign', name: '口令赋值', pattern: '(?:password|passwd|pwd)\\s*[=:]\\s*["\']?[^\\s"\']{6,}', flags: 'gi', severity: 'medium', enabled: true, hint: 'password=… 这类' },
  { id: 'phone-cn', name: '中国大陆手机号', pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', flags: 'g', severity: 'low', enabled: false, hint: '默认关闭' },
  { id: 'idcard-cn', name: '中国大陆身份证号', pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', flags: 'g', severity: 'medium', enabled: false, hint: '默认关闭' },
]

/**
 * 收敛为合法的产物类型。
 *
 * @param value - 任意值。
 * @returns 类型 id；非法值一律 `other`。
 */
export function asArtifactKind(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ARTIFACT_KINDS.includes(text) ? text : 'other'
}

/**
 * 收敛为合法严重级。
 *
 * @param value - 任意值。
 * @returns 严重级；非法值返回空串（= 未评估）。
 */
export function asSeverity(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SEVERITIES.includes(text) ? text : ''
}

/**
 * 归一化一条规则。
 *
 * @param raw - 任意候选。
 * @returns 规范规则，或 `undefined`（缺 pattern）。
 */
export function normalizeRule(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const pattern = typeof raw.pattern === 'string' ? raw.pattern.trim() : ''
  if (pattern === '' || pattern.length > RULE_PATTERN_LIMIT) return undefined
  const id = (typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : pattern).slice(0, 64)
  return {
    id,
    name: (typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id).slice(0, 80),
    pattern,
    flags: typeof raw.flags === 'string' ? raw.flags.replace(/[^gimsuy]/g, '') : 'g',
    severity: asSeverity(raw.severity) || 'medium',
    enabled: raw.enabled !== false,
    hint: typeof raw.hint === 'string' ? raw.hint.slice(0, 200) : '',
  }
}

/**
 * 编译一组规则。
 *
 * 一条坏正则会让整份保存失败 —— 存进去之后才发现"规则不生效"更难查。
 *
 * @param value - 规则数组。
 * @returns `{ rules, error }`；`error` 形如 `第 3 条（aliyun-ak）正则不合法：…`
 */
export function compileRules(value) {
  const list = Array.isArray(value) ? value : []
  const rules = []
  for (const [index, raw] of list.entries()) {
    const rule = normalizeRule(raw)
    if (rule === undefined) {
      return { rules: [], error: `第 ${index + 1} 条缺少 pattern（或超过 ${RULE_PATTERN_LIMIT} 字）` }
    }
    try {
      // 只用于校验：真正的匹配在 scanText 里按需构造，避免共享 lastIndex。
      const probe = new RegExp(rule.pattern, rule.flags)
      probe.exec('')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { rules: [], error: `第 ${index + 1} 条（${rule.id}）正则不合法：${message}` }
    }
    rules.push(rule)
  }
  return { rules, error: '' }
}

/**
 * 用一组规则扫描文本。
 *
 * @param text - 待扫文本。
 * @param rules - 已编译的规则。
 * @returns `{ hits, severity }`；`hits` 里带规则名与采样片段。
 */
export function scanText(text, rules) {
  const haystack = typeof text === 'string' ? text.slice(0, CONTENT_LIMIT) : ''
  if (haystack === '' || !Array.isArray(rules) || rules.length === 0) return { hits: [], severity: '' }
  const hits = []
  for (const rule of rules) {
    if (rule.enabled === false) continue
    let regex
    try {
      // 每条都新建：带 `g` 的正则有 lastIndex 状态，复用会漏匹配。
      regex = new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`)
    } catch {
      continue
    }
    let match
    let guard = 0
    while ((match = regex.exec(haystack)) !== null && guard < HITS_LIMIT) {
      guard += 1
      const sample = String(match[0]).slice(0, 120)
      if (!hits.some((item) => item.ruleId === rule.id && item.sample === sample)) {
        hits.push({ ruleId: rule.id, name: rule.name, severity: rule.severity, sample })
      }
      if (match[0] === '') regex.lastIndex += 1
      if (regex.lastIndex >= haystack.length) break
    }
    if (hits.length >= HITS_LIMIT) break
  }
  const rank = { high: 3, medium: 2, low: 1 }
  let severity = ''
  for (const hit of hits) {
    if ((rank[hit.severity] ?? 0) > (rank[severity] ?? 0)) severity = hit.severity
  }
  return { hits, severity }
}

/**
 * 产物的去重指纹。
 *
 * 同一条 AK 被反复记录时只累加次数，不新增行 —— 指纹只看"是哪条产物"，不看时间与来源。
 *
 * @param artifact - 已归一化的产物。
 * @returns 十六进制哈希。
 */
export function fingerprintOf(artifact) {
  const text = [artifact?.kind ?? '', artifact?.title ?? '', artifact?.content ?? ''].join('\u0000')
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * 归一化一条产物。
 *
 * @param raw - 任意候选。
 * @returns 规范产物，或 `undefined`（标题与内容都空）。
 */
export function normalizeArtifact(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, TITLE_LIMIT) : ''
  const content = typeof raw.content === 'string' ? raw.content.slice(0, CONTENT_LIMIT) : ''
  if (title === '' && content === '') return undefined
  const sourceRaw = raw.source
  const source = sourceRaw !== null && typeof sourceRaw === 'object'
    ? {
        name: typeof sourceRaw.name === 'string' ? sourceRaw.name.trim().slice(0, 200) : '',
        type: ['tool', 'platform', 'url', 'manual'].includes(String(sourceRaw.type ?? ''))
          ? String(sourceRaw.type)
          : 'tool',
        url: typeof sourceRaw.url === 'string' ? sourceRaw.url.slice(0, 2048) : '',
      }
    : { name: typeof sourceRaw === 'string' ? sourceRaw.trim().slice(0, 200) : '', type: 'tool', url: '' }
  return {
    kind: asArtifactKind(raw.kind),
    title: title === '' ? content.split('\n')[0].slice(0, TITLE_LIMIT) : title,
    content,
    source,
    howFound: typeof raw.howFound === 'string' ? raw.howFound.trim().slice(0, HOW_FOUND_LIMIT) : '',
    url: typeof raw.url === 'string' ? raw.url.trim().slice(0, 2048) : '',
    host: typeof raw.host === 'string' ? raw.host.trim().slice(0, 253) : '',
    verdict: ['fact', 'suspect', 'infer'].includes(String(raw.verdict ?? '')) ? String(raw.verdict) : '',
    confidence: Number.isFinite(raw.confidence) ? Math.min(100, Math.max(0, Math.round(raw.confidence))) : null,
  }
}
