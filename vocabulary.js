/**
 * 暴露面收集的词汇表 —— 配置行的用途分类。
 *
 * 这里是**模型侧**的唯一事实源：工具描述、结果记录的 kind 取值都从这里生成。
 * 面板（client.js）有自己的一份 UI 字典（走 Client locale 服务），因为浏览器半和
 * 宿主半是两套模块系统，无法共享 ES 模块；两侧共享的是 **id**，标签各自本地化。
 *
 * @module @infohunter/dsh-information-hunter/vocabulary
 */

/**
 * 记录分型（`kind`）。
 *
 * **它只是"采集记录"的标签**，回答"这次观测是关于什么的"，用于记录列表的分类与筛选。
 * 它不进资产清单（资产只看字段与 nodeType），也**不再承担必填规则** ——
 * 端口这类规则按字段判（见 preset 里的完整性检查），否则每加一个类型就要改一遍规则。
 *
 * 从 14 个收敛到 6 个：层（domain / endpoint / web / system）+ 证据（cert）+ 兜底（other）。
 */
export const PURPOSES = [
  'domain',    // 主域 / 子域 / DNS / 测绘拿到的域名
  'endpoint',  // 端口 / 服务 / 版本 / banner
  'web',       // HTTP 探活 / 状态码 / 标题 / 指纹 / CDN
  'system',    // 系统入口 / URL
  'cert',      // 证书
  'other',     // 截图等
]

/**
 * 旧 kind → 新 kind 的映射。
 *
 * 老记录里存的是 `subdomain`/`port`/`fingerprint` 这些；读取时按这张表归类，
 * **不改库**（记录不可变），只在展示与统计时用。
 */
export const KIND_ALIASES = {
  main_domain: 'domain',
  subdomain: 'domain',
  dns: 'domain',
  osint: 'domain',
  port: 'endpoint',
  service: 'endpoint',
  web: 'web',
  fingerprint: 'web',
  cdn: 'web',
  app: 'system',
  url: 'system',
  cert: 'cert',
  screenshot: 'other',
  other: 'other',
}

/**
 * 把任意 kind 收敛成 6 类之一（含旧值映射）。
 *
 * @param value - 任意值。
 * @returns 分型；不认识的一律 `other`。
 */
export function canonicalKind(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (PURPOSES.includes(text)) return text
  return KIND_ALIASES[text] ?? 'other'
}

/** 用途的中文名（工具描述用）。 */
export const PURPOSE_LABELS = {
  domain: '域名与解析',
  endpoint: '端口与服务',
  web: 'Web 与指纹',
  system: '系统与路径',
  cert: '证书',
  other: '其他',
  // 旧值保留：老记录的展示不能变成空白。
  main_domain: '主域名收集',
  subdomain: '子域名收集',
  port: '端口扫描',
  service: '服务/协议识别',
  web_old: 'Web 探活与目录',
  fingerprint: '指纹识别',
  dns: 'DNS 记录',
  cert: '证书 / CT 日志',
  osint: '公开情报 / 搜索引擎',
  cdn: 'CDN / WAF 识别',
  screenshot: '截图存证',
  app: '系统入口',
  url: '页面 / 路径证据',
  other: '其他',
}

/** 用途的一句话说明（工具描述用）。 */
export const PURPOSE_HINTS = {
  domain: '域名、解析结果、子域枚举与测绘返回的域名',
  endpoint: '端口开放情况、协议、服务名与版本、banner',
  web: 'HTTP(S) 探活、状态码、标题、框架/中间件、CDN/WAF 归属',
  system: '一个系统的入口（host:port + 根路径）与它下面的路径',
  cert: 'TLS 证书与 CT 日志里的域名线索',
  other: '不属于以上任何一类（截图、备注等）',
  // 旧值保留，供老记录展示。
  main_domain: '拿主域名/备案/WHOIS/企业工商信息',
  subdomain: '子域名枚举（被动/字典/证书透明日志）',
  port: 'TCP/UDP 端口开放情况',
  service: '端口上的服务与协议版本',
  fingerprint: 'Web 框架 / 中间件 / CMS / 组件版本',
  dns: 'A/AAAA/CNAME/MX/TXT/NS 等记录',
  osint: '搜索引擎 / 代码托管 / 社工库等公开信息',
  cdn: 'CDN、WAF、云厂商归属识别',
  screenshot: '批量截图存证',
  app: '一个系统的入口（host:port + 根路径）',
  url: '系统下的具体页面/路径（内容页、接口、文档）证据',
}

/**
 * 「形态」—— 工具与平台之间传递的数据量纲。
 *
 * 这是多工具协同的接插件：一行配置声明它**要吃哪些形态**（inputs）和**能吐哪些形态**
 * （outputs），模型就能靠形态对齐自动串起来 —— A 的 outputs 命中 B 的 inputs，
 * 说明 A 的结果可以直接喂给 B，不需要它认识那个工具。
 *
 * 为什么必须用户勾选而不是让模型猜：用户自己配的工具（自编译的扫描器、内部脚本、
 * 冷门平台）模型不认识，光看名字判断不出输入输出；不声明就只能靠模型瞎试参数。
 *
 * 顺序即面板勾选框的展示顺序（先组织/归属，再域名，再 IP/端口，再 Web 层，最后泛化项）。
 */
export const SHAPES = [
  'org_short',
  'org_full',
  'credit_code',
  'icp',
  'main_domain',
  'subdomain',
  'domain',
  'ip',
  'cidr',
  'port',
  'endpoint',
  'url',
  'protocol',
  'service',
  'banner',
  'status',
  'title',
  'tech',
  'cert',
  'email',
  'credential',
  'source_code',
  'shot',
  'other',
]

/** 形态的中文名。 */
export const SHAPE_LABELS = {
  org_short: '单位简称',
  org_full: '单位全称',
  credit_code: '统一社会信用代码',
  icp: '备案号',
  main_domain: '主域名',
  subdomain: '子域名',
  domain: '域名',
  ip: 'IP',
  cidr: 'C 段 / IP 段',
  port: '端口',
  endpoint: 'host:port',
  url: 'URL',
  protocol: '协议',
  service: '服务与版本',
  banner: 'banner',
  status: '状态码',
  title: '标题',
  tech: '指纹',
  cert: '证书',
  email: '邮箱',
  credential: '账号密码',
  source_code: '源码',
  shot: '截图',
  other: '其他',
}

/** 形态的一句话说明（工具描述用）。 */
export const SHAPE_HINTS = {
  org_short: '企业/组织的常用名，如「某某科技」',
  org_full: '营业执照上的全称',
  credit_code: '18 位统一社会信用代码',
  icp: 'ICP 备案号，如京ICP备xxxxxxxx号',
  main_domain: '根域，如 example.com',
  subdomain: '根域之下的主机名，如 api.example.com',
  domain: '不区分层级的域名，主域与子域都算',
  ip: '单个 IP 地址',
  cidr: '网段，如 1.2.3.0/24',
  port: '单个端口号',
  endpoint: 'host:port 形式的端点',
  url: '带 scheme 的完整地址',
  protocol: '协议名，如 http / ssh / redis',
  service: '服务名与版本，如 OpenSSH 8.9',
  banner: '服务返回的原始 banner 文本',
  status: 'HTTP 状态码',
  title: '网页标题',
  tech: '框架、中间件、CDN、WAF 等指纹',
  cert: '证书主体、签发者、SAN',
  email: '邮箱地址',
  credential: '泄露的账号 / 口令',
  source_code: '泄露的源码或代码仓库',
  shot: '截图文件',
  other: '上面都不像，需要自己写说明',
}

/** 输入/输出的「其他」自定义内容长度上限。 */
export const SHAPE_OTHER_MAX = 200

/**
 * 收敛一组形态勾选：只留合法 id、去重、按声明顺序排列。
 *
 * @param value - 任意值（期望是字符串数组）。
 * @returns 规范后的 id 数组；无有效项时为空数组。
 */
export function asShapes(value) {
  if (!Array.isArray(value)) return []
  const picked = new Set(value.filter((id) => typeof id === 'string' && SHAPES.includes(id)))
  return SHAPES.filter((id) => picked.has(id))
}

/**
 * 把形态数组渲染成模型可读的一行，如 `子域名(subdomain)、IP(ip)`。
 *
 * @param value - 形态数组。
 * @returns 渲染结果；空数组时返回空串。
 */
export function describeShapes(value) {
  return asShapes(value).map((id) => `${SHAPE_LABELS[id]}(${id})`).join('、')
}

/**
 * 形态词表 id 集合（供校验与错误提示）。
 *
 * @returns 逗号分隔的合法 id。
 */
export function shapeIdList() {
  return SHAPES.join(' / ')
}

/**
 * 生成整张形态词表，拼进 `expose_config` 的开头。
 *
 * 模型只有拿到过一次完整词表，才可能理解某行里 `subdomain` 的确切含义；
 * 逐行重复渲染标签会让几十行配置膨胀成上千行。
 *
 * @returns 形如 `主域名(main_domain：根域，如 example.com)；…`。
 */
export function describeShapeLegend() {
  return SHAPES.map((id) => `${SHAPE_LABELS[id]}(${id}：${SHAPE_HINTS[id]})`).join('；')
}

// ────────────────────────────────────────────────────────────────────────────
// 输入条件关系
// ────────────────────────────────────────────────────────────────────────────

/**
 * 一行声明的多个输入之间的**条件关系**。
 *
 * 为什么需要它：勾了 `ip` 和 `port` 之后，"给我一个 IP 就能查"与"必须 IP 加端口
 * 一起才查"是两件完全不同的事 —— 前者模型可以随时调，后者缺一个就得先回去收集。
 * 让它由用户点一下决定，比让模型猜可靠：模型不认识这个平台，猜错的代价是
 * 用不成立的前提查询，返回空，然后把空解释成"这个目标没有资产"（假结果）。
 *
 * - `or`     （缺省）任一即可：手上有其中任何一个就能查；
 * - `and`   需同时：必须凑齐勾选的全部才能查；
 * - `custom` 自定义说明：关系不是简单与/或（如"a 单独可用，b+c 需组合，c 单独可用"），
 *            以 `inputModeNote` 的自由文本为准。
 */
export const INPUT_MODES = ['or', 'and', 'custom']

/** 关系的中文名。 */
export const INPUT_MODE_LABELS = {
  or: '任一即可',
  and: '需同时',
  custom: '自定义说明',
}

/**
 * 判断一个值是不是合法关系。
 *
 * @param value - 任意值。
 * @returns 合法时返回该 id，否则 `undefined`。
 */
export function asInputMode(value) {
  return typeof value === 'string' && INPUT_MODES.includes(value) ? value : undefined
}

/**
 * 渲染"这些输入怎么组合"。
 *
 * @param shapes - 已收敛的形态数组。
 * @param mode - 关系。
 * @param note - 自定义说明。
 * @returns 形如 `主域名 / IP（任一即可）`；只有一个输入时不带关系后缀。
 */
export function describeInputRelation(shapes, mode, note) {
  const names = asShapes(shapes).map((id) => `${SHAPE_LABELS[id]}(${id})`)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  const custom = String(note ?? '').trim()
  if (mode === 'and') return `${names.join(' + ')}（需同时）`
  if (mode === 'custom') {
    return `${names.join('、')}（关系: ${custom === '' ? '未说明 —— 问用户' : custom}）`
  }
  return `${names.join(' / ')}（任一即可）`
}

/** 配置行的四种类型。 */
export const ENTRY_TYPES = ['tool', 'mapping', 'skill', 'mcp']

/** 类型的中文名。 */
export const ENTRY_TYPE_LABELS = {
  tool: '工具',
  mapping: '空间测绘',
  skill: '技能',
  mcp: 'MCP',
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
/**
 * 空间测绘行「能出哪些数据」的取值。
 *
 * **与记录的 `kind` 解耦**：这里描述的是"这个平台能吐出哪些数据"（能力），
 * 记录里的 kind 描述的是"这次观测属于哪一层"（分型）。两者独立演化，
 * 加一种记录类型不该影响配置页能选什么，反之亦然。
 */
export const CAPABILITIES = [
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
]

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
  return CAPABILITIES.map((id) => `${id}（${PURPOSE_LABELS[id]}：${PURPOSE_HINTS[id]}）`).join('；')
}

/**
 * 记录 `kind` 的取值说明（6 类）。
 *
 * @returns 一行说明。
 */
export function describeKinds() {
  return PURPOSES.map((id) => `${id}（${PURPOSE_LABELS[id]}：${PURPOSE_HINTS[id]}）`).join('；')
}

/**
 * 判断一个值是不是合法用途。
 *
 * @param value - 任意值。
 * @returns 合法时返回该 id，否则 `undefined`。
 */
export function asPurpose(value) {
  return typeof value === 'string' && CAPABILITIES.includes(value) ? value : undefined
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
