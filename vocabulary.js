/**
 * 暴露面收集的词汇表 —— 配置行的用途分类。
 *
 * 这里是**模型侧**的唯一事实源：工具描述、结果记录的 kind 取值都从这里生成。
 * 面板（client.js）有自己的一份 UI 字典（走 Client locale 服务），因为浏览器半和
 * 宿主半是两套模块系统，无法共享 ES 模块；两侧共享的是 **id**，标签各自本地化。
 *
 * @module @infohunter/dsh-information-hunter/vocabulary
 */

/** 收集用途。顺序即面板下拉与结果分组的展示顺序。 */
export const PURPOSES = [
  'main_domain',
  'subdomain',
  'port',
  'service',
  'web',
  'fingerprint',
  'dns',
  'cert',
  'osint',
  'cdn',
  'screenshot',
  'other',
]

/** 用途的中文名（工具描述用）。 */
export const PURPOSE_LABELS = {
  main_domain: '主域名收集',
  subdomain: '子域名收集',
  port: '端口扫描',
  service: '服务/协议识别',
  web: 'Web 探活与目录',
  fingerprint: '指纹识别',
  dns: 'DNS 记录',
  cert: '证书 / CT 日志',
  osint: '公开情报 / 搜索引擎',
  cdn: 'CDN / WAF 识别',
  screenshot: '截图存证',
  other: '其他',
}

/** 用途的一句话说明（工具描述用）。 */
export const PURPOSE_HINTS = {
  main_domain: '拿主域名/备案/WHOIS/企业工商信息',
  subdomain: '子域名枚举（被动/字典/证书透明日志）',
  port: 'TCP/UDP 端口开放情况',
  service: '端口上的服务与协议版本',
  web: 'HTTP(S) 探活、状态码、标题、目录与路径',
  fingerprint: 'Web 框架 / 中间件 / CMS / 组件版本',
  dns: 'A/AAAA/CNAME/MX/TXT/NS 等记录',
  cert: 'TLS 证书与 CT 日志里的域名线索',
  osint: '搜索引擎 / 代码托管 / 社工库等公开信息',
  cdn: 'CDN、WAF、云厂商归属识别',
  screenshot: '批量截图存证',
  other: '不属于以上任何一类',
}

/** 配置行的两种类型。 */
export const ENTRY_TYPES = ['tool', 'mapping']

/** 类型的中文名。 */
export const ENTRY_TYPE_LABELS = {
  tool: '工具',
  mapping: '空间测绘',
}

/**
 * 空间测绘平台**能返回的数据种类**（多选）。
 *
 * 空间测绘是综合查询：一次 FOFA/Quake/Hunter 查询往往同时给出域名、IP、端口、协议、
 * banner、标题、指纹、证书。用单选用途把它压扁会误导模型（让它以为某个平台"只会查端口"），
 * 所以映射行的语义是"这个平台能出哪些 kind"，用复选框表达；这些 id 与
 * `expose_config` 的能力筛选与资产分类共用同一套取值 —— 模型据此决定"缺端口数据该问谁"。
 *
 * 与 `PURPOSES` 的唯一差别是去掉 `other`：作为"能出什么数据"，"其他"不提供任何信息。
 */
export const CAPABILITIES = PURPOSES.filter((id) => id !== 'other')

/**
 * 收敛一组能力勾选：只保留合法 id、去重、按声明顺序排列。
 *
 * @param value - 任意值（期望是字符串数组）。
 * @returns 规范后的 id 数组；无有效项时为空数组。
 */
export function asCapabilities(value) {
  if (!Array.isArray(value)) return []
  const picked = new Set(value.filter((id) => typeof id === 'string' && CAPABILITIES.includes(id)))
  return CAPABILITIES.filter((id) => picked.has(id))
}

/**
 * 生成 `kind` 的取值说明，拼进工具描述。
 *
 * @returns 形如 `subdomain（子域名收集：子域名枚举…）；port（端口扫描：…）`。
 */
export function describePurposes() {
  return PURPOSES.map((id) => `${id}（${PURPOSE_LABELS[id]}：${PURPOSE_HINTS[id]}）`).join('；')
}

/**
 * 判断一个值是不是合法用途。
 *
 * @param value - 任意值。
 * @returns 合法时返回该 id，否则 `undefined`。
 */
export function asPurpose(value) {
  return typeof value === 'string' && PURPOSES.includes(value) ? value : undefined
}

/**
 * 判断一个值是不是合法行类型。
 *
 * @param value - 任意值。
 * @returns 合法时返回该 id，否则 `undefined`。
 */
export function asEntryType(value) {
  return typeof value === 'string' && ENTRY_TYPES.includes(value) ? value : undefined
}
