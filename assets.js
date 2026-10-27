/**
 * 资产模型 + 查询语法。
 *
 * ## 为什么不再用"一行一次观测"
 *
 * 旧模型一条记录 = 一次观测（`kind` + `asset` + `detail`），同一台机器会被记很多行：
 * 一条子域、一条端口、一条 Web、一条指纹…… 面板自然就长得像采集日志。
 *
 * 资产收集真正要看的是**端点**：`host:port` + 它上面的服务、状态码、标题、证书、banner。
 * 所以现在一条记录 = 一个端点，重复观测**合并**（upsert），而不是追加。
 *
 * ## 字段是扁平的
 *
 * 全部平铺（`status` / `certSubject` / …）而不是嵌套对象：查询语法、SQLite 存储、
 * 卡片渲染三边都不用递归，代价只是字段略多。`web.status` 这类写法在解析时映射到 `status`。
 *
 * @module @infohunter/dsh-information-hunter/assets
 */

/** 一条资产的字段上限（防止一次写入撑爆库/上下文）。 */
const LIMITS = {
  host: 253,
  ip: 64,
  cname: 253,
  protocol: 24,
  title: 500,
  server: 200,
  service: 80,
  version: 120,
  banner: 4000,
  note: 4000,
  certSubject: 500,
  certIssuer: 300,
  certNotAfter: 40,
  target: 300,
}
/** 数组字段的长度与元素上限。 */
const ARRAY_LIMITS = { tech: [24, 80], certSan: [32, 253], sources: [8, 60] }

/**
 * 合法分类。
 *
 * `unknown` = 只知道有这么一个端口，但没观测到任何能判断"是 Web 还是别的服务"的证据。
 * 它存在的意义就是不猜：宁可显示"未识别"，也不要按端口号编一个协议出来。
 */
export const CATEGORIES = ['web', 'service', 'host', 'unknown']

/** 这些协议算 Web（只用于把**显式给出的协议**归类，不从端口反推）。 */
const WEB_PROTOCOLS = new Set(['http', 'https', 'http2', 'h2', 'h2c', 'ws', 'wss'])

/**
 * 字符串裁剪。
 *
 * @param value - 任意值。
 * @param max - 上限。
 * @returns 裁剪后的字符串（非字符串返回空串）。
 */
function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * 数字或在合理范围内返回整数。
 *
 * @param value - 任意值。
 * @param min - 下界。
 * @param max - 上界。
 * @returns 整数或 undefined。
 */
function int(value, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  const rounded = Math.trunc(n)
  return rounded < min || rounded > max ? undefined : rounded
}

/**
 * 归一化数组字段：拆分 + 去重 + 限长。
 *
 * @param value - 任意值（数组或分隔串）。
 * @param limits - `[元素数上限, 元素长度上限]`。
 * @returns 规范后的数组。
 */
function list(value, limits) {
  const [countMax, lengthMax] = limits
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[+、,，;；]|\s{2,}/) : []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const text = str(item, lengthMax)
    if (text === '') continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= countMax) break
  }
  return out
}

/**
 * 把 `host[:port]` 或 URL 拆成 `{ host, port }`。
 *
 * @param input - 任意端点写法。
 * @returns `{ host, port }`；拆不出主机时 `host` 为空串。
 */
export function splitEndpoint(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return { host: '', port: undefined, scheme: '' }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  const scheme = schemeMatch === null ? '' : schemeMatch[1].toLowerCase()
  // 去掉 scheme 与路径，只留 authority。
  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const authority = withoutScheme.split(/[/?#]/)[0]
  // IPv6 字面量：[::1]:8080
  const v6 = /^\[([0-9a-f:]+)\](?::(\d+))?$/i.exec(authority)
  if (v6 !== null) {
    return { host: v6[1].toLowerCase(), port: v6[2] === undefined ? undefined : Number(v6[2]), scheme }
  }
  const at = authority.lastIndexOf(':')
  if (at > 0 && /^\d{1,5}$/.test(authority.slice(at + 1))) {
    return { host: authority.slice(0, at).toLowerCase(), port: Number(authority.slice(at + 1)), scheme }
  }
  return { host: authority.toLowerCase(), port: undefined, scheme }
}

/**
 * 归一化一条资产（不负责合并）。
 *
 * @param raw - 任意候选值。
 * @returns 规范资产，或 `undefined`（连 host 都没有）。
 */
export function normalizeAsset(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)
  // `endpoint` 是便捷入口：`1.2.3.4:8080`、`https://a.example.com`。
  const endpoint = splitEndpoint(source.endpoint)
  const host = (str(source.host, LIMITS.host) || endpoint.host).toLowerCase()
  if (host === '') return undefined
  const port = int(source.port, 1, 65535) ?? (endpoint.port === undefined ? undefined : int(endpoint.port, 1, 65535))

  const givenProtocol = str(source.protocol, LIMITS.protocol).toLowerCase().replace(/:$/, '')
    || endpoint.scheme
  const status = int(source.status, 100, 599)
  const title = str(source.title, LIMITS.title)
  const service = str(source.service, LIMITS.service)
  const version = str(source.version, LIMITS.version)
  const banner = str(source.banner, LIMITS.banner)
  const tech = list(source.tech, ARRAY_LIMITS.tech)

  // ## 分类只从**观测到的字段**推，绝不从端口号猜
  //
  // 早先这里有一张端口表（443 → https、22 → ssh、8080 → web），那是编数据：
  // 一个只知道端口、没探过协议的主机，不该被标成 http 或 ssh。
  // 现在证据只认这些：显式协议、status、title、tech（→ web），service/version/banner（→ 服务）。
  // 都没有就是 `unknown` —— 界面上显示成"未识别"，比猜一个更诚实。
  let category = str(source.category, 16).toLowerCase()
  if (!CATEGORIES.includes(category)) {
    if (port === undefined) category = 'host'
    else if (WEB_PROTOCOLS.has(givenProtocol) || status !== undefined || title !== '' || tech.length > 0) category = 'web'
    else if (service !== '' || version !== '' || banner !== '') category = 'service'
    else category = 'unknown'
  }
  // 给了 host 却带了端口，说明它是端点级资产，不能留在 host 类里。
  if (category === 'host' && port !== undefined) {
    category = WEB_PROTOCOLS.has(givenProtocol) || status !== undefined || title !== '' || tech.length > 0
      ? 'web'
      : service !== '' || version !== '' || banner !== '' ? 'service' : 'unknown'
  }

  // 协议只认显式给出的（参数里或 endpoint 的 scheme），不按端口反推。
  const protocol = givenProtocol

  // 置信度不编造：没给就是 `null`（= 未评估），界面显示为空。
  const confidence = int(source.confidence, 0, 100) ?? null
  const certSan = list(source.certSan ?? source.cert?.san, ARRAY_LIMITS.certSan)

  return {
    target: str(source.target, LIMITS.target),
    host,
    port: port ?? 0,
    protocol,
    category,
    ip: str(source.ip, LIMITS.ip),
    cname: str(source.cname, LIMITS.cname),
    status: status ?? 0,
    title,
    server: str(source.server, LIMITS.server),
    tech,
    certSubject: str(source.certSubject ?? source.cert?.subject, LIMITS.certSubject),
    certIssuer: str(source.certIssuer ?? source.cert?.issuer, LIMITS.certIssuer),
    certSan,
    certNotAfter: str(source.certNotAfter ?? source.cert?.notAfter ?? source.cert?.not_after, LIMITS.certNotAfter),
    service,
    version,
    // `banner` 只认显式给出的 banner，不拿 `detail`（自由文本证据）顶替。
    banner,
    note: str(source.note, LIMITS.note),
    sources: list(source.sources ?? source.source, ARRAY_LIMITS.sources),
    confidence,
  }
}

/**
 * 端点身份键：同一 host:port 视为同一个资产。
 *
 * @param asset - 资产。
 * @returns 键。
 */
export function assetKey(asset) {
  return `${asset.host}:${asset.port}`
}

/**
 * 合并同一端点的两次观测。
 *
 * 语义：**新值覆盖非空旧值**，数组取并集，`firstSeen` 取早、`lastSeen` 取晚。
 * 这样"先扫到端口、后探到 title"不会变成两行。
 *
 * @param previous - 已有资产（可空）。
 * @param next - 新观测（已归一化）。
 * @param now - 本次观测时间戳。
 * @returns 合并后的资产。
 */
export function mergeAsset(previous, next, now) {
  if (previous === undefined) {
    return { ...next, firstSeen: now, lastSeen: now }
  }
  const pick = (key) => {
    const value = next[key]
    if (Array.isArray(value)) {
      const merged = new Map()
      for (const item of [...(previous[key] ?? []), ...value]) merged.set(item.toLowerCase(), item)
      return [...merged.values()]
    }
    if (typeof value === 'number') return value !== 0 ? value : previous[key]
    return value !== '' ? value : previous[key]
  }
  const merged = {}
  for (const key of Object.keys(next)) merged[key] = pick(key)
  merged.firstSeen = Math.min(previous.firstSeen ?? now, now)
  merged.lastSeen = Math.max(previous.lastSeen ?? now, now)
  return merged
}

// ────────────────────────────────────────────────────────────────────────────
// 查询语法
// ────────────────────────────────────────────────────────────────────────────
//
// 支持：`web.status=200`、`port=22`、`title~后台`、`tech=nginx`、
//       `category=web`、`(port=80 OR port=443) AND status!=404`。
// 运算符：= != ~（包含）> >= < <=。字段名大小写不敏感，`AND`/`OR` 大小写不敏感。

/** 字段别名 → 规范字段。 */
const FIELDS = {
  host: 'host', domain: 'host', endpoint: 'host',
  ip: 'ip', cname: 'cname',
  port: 'port',
  // `protocol` 同时覆盖 service —— 面板的这一列显示的就是"协议，没有就显示服务名"，
  // 所以过滤要跟看到的列一致：`protocol~sql` 能命中 mysql / mssql。
  protocol: 'protocol', proto: 'protocol', scheme: 'protocol',
  // `fingerprint` = 技术栈 + Server + 服务名 + 版本，就是面板「fingerprint」列的内容。
  fingerprint: 'fingerprint', fp: 'fingerprint',
  category: 'category', type: 'category',
  status: 'status', code: 'status', 'web.status': 'status', 'web.code': 'status',
  title: 'title', 'web.title': 'title',
  server: 'server', 'web.server': 'server',
  tech: 'tech', 'web.tech': 'tech',
  'cert.subject': 'certSubject', certsubject: 'certSubject',
  'cert.issuer': 'certIssuer', certissuer: 'certIssuer',
  'cert.san': 'certSan', certsan: 'certSan',
  'cert.notafter': 'certNotAfter', certnotafter: 'certNotAfter',
  banner: 'banner', service: 'service', version: 'version',
  note: 'note',
  source: 'sources', sources: 'sources',
  target: 'target',
  confidence: 'confidence',
}

/** 数值字段。 */
const NUMERIC_FIELDS = new Set(['port', 'status', 'confidence'])
/** 数组字段。 */
const ARRAY_FIELDS = new Set(['tech', 'certSan', 'sources'])

/**
 * 组合字段：一个条件同时看多个字段的值。
 *
 * 存在的理由是"过滤要跟列里看到的一致"。面板的 `protocol` 列在没测到协议时显示服务名，
 * `fingerprint` 列是技术栈/服务/版本的合并 —— 那过滤器也得这么看，否则用户照着列里的值打字却搜不到。
 */
const UNION_FIELDS = {
  protocol: ['protocol', 'service'],
  fingerprint: ['tech', 'server', 'service', 'version'],
}

/** 把 `contains` / `like` / `has` 当成 `~` 的别名（词法上它们是 word，不是符号）。 */
const WORD_OPERATORS = { contains: '~', like: '~', has: '~', matches: '~' }

/**
 * 词法切分。
 *
 * @param text - 查询文本。
 * @returns token 列表。
 */
function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: ch })
      i += 1
      continue
    }
    // 引号字符串
    if (ch === '"' || ch === "'") {
      const quote = ch
      let value = ''
      i += 1
      while (i < text.length && text[i] !== quote) {
        value += text[i]
        i += 1
      }
      i += 1
      tokens.push({ type: 'word', value })
      continue
    }
    // 运算符
    const op = /^(>=|<=|!=|=~|=|~|>|<)/.exec(text.slice(i))
    if (op !== null) {
      tokens.push({ type: 'op', value: op[1] })
      i += op[1].length
      continue
    }
    // 普通词（字段名或裸值），允许 `web.status`、中文
    let word = ''
    while (i < text.length && !/[\s()=!~<>]/.test(text[i])) {
      word += text[i]
      i += 1
    }
    if (word !== '') tokens.push({ type: 'word', value: word })
  }
  return tokens
}

/**
 * 解析查询文本。
 *
 * 语法错误不抛异常：返回 `{ ast: null, error }`，让面板把错误显示在输入框下面，
 * 而不是让整个请求 500。
 *
 * @param text - 查询文本。
 * @returns `{ ast, error }`。
 */
export function parseQuery(text) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return { ast: null, error: undefined }
  const tokens = tokenize(source)
  let at = 0

  const peek = () => tokens[at]
  const eat = () => tokens[at++]
  const fail = (message) => {
    const error = new Error(message)
    error.parse = true
    throw error
  }

  const parseOr = () => {
    let left = parseAnd()
    while (peek()?.type === 'word' && peek().value.toUpperCase() === 'OR') {
      at += 1
      left = { kind: 'or', left, right: parseAnd() }
    }
    return left
  }

  const parseAnd = () => {
    let left = parseUnary()
    for (;;) {
      const token = peek()
      if (token?.type === 'word' && token.value.toUpperCase() === 'AND') {
        at += 1
        left = { kind: 'and', left, right: parseUnary() }
        continue
      }
      // 相邻的两个条件视为 AND（`port=80 status=200` 这种写法）
      if (token !== undefined && (token.type === '(' || token.type === 'word') && !/^(AND|OR)$/i.test(token.value ?? '')) {
        left = { kind: 'and', left, right: parseUnary() }
        continue
      }
      return left
    }
  }

  const parseUnary = () => {
    const token = peek()
    if (token === undefined) fail('查询不完整：末尾缺条件')
    if (token.type === '(') {
      at += 1
      const inner = parseOr()
      if (peek()?.type !== ')') fail('缺少右括号')
      at += 1
      return inner
    }
    return parseTerm()
  }

  const parseTerm = () => {
    const first = eat()
    if (first === undefined || first.type !== 'word') fail('这里需要一个字段名')
    let field = first.value
    let op
    let value

    // `field op value`；没有运算符时当成"任意字段包含这个关键词"。
    if (peek()?.type === 'op') {
      op = eat().value
      const next = eat()
      if (next === undefined || next.type !== 'word') fail(`字段 ${field} 后面缺值`)
      value = next.value
    } else if (WORD_OPERATORS[String(peek()?.value ?? '').toLowerCase()] !== undefined) {
      // `protocol contains sql` —— 用文字写"包含"，比记 `~` 直观。
      op = WORD_OPERATORS[eat().value.toLowerCase()]
      const next = eat()
      if (next === undefined || next.type !== 'word') fail(`字段 ${field} 后面缺值`)
      value = next.value
    } else if (field.includes('=') || field.includes('~')) {
      // 允许 `port=22` 之间没有空格（词法把整段当成了一个词）
      const match = /^([^=!~<>]+)(>=|<=|!=|=~|=|~|>|<)(.+)$/.exec(field)
      if (match === null) fail(`看不懂这一段：${field}`)
      field = match[1]
      op = match[2]
      value = match[3]
    } else {
      op = '~'
      value = field
      field = '*'
    }

    const key = field.toLowerCase()
    const canonical = key === '*' ? '*' : FIELDS[key]
    if (canonical === undefined) {
      return { kind: 'term', field: '*', op: '~', value: `${field}${op}${value}` }
    }
    return { kind: 'term', field: canonical, op, value }
  }

  try {
    const ast = parseOr()
    if (at < tokens.length) fail(`多余的输入：${tokens.slice(at).map((t) => t.value ?? t.type).join(' ')}`)
    return { ast, error: undefined }
  } catch (error) {
    return { ast: null, error: error.parse === true ? error.message : String(error) }
  }
}

/**
 * 取一个字段的可比较形态。
 *
 * @param asset - 资产。
 * @param field - 规范字段名。
 * @returns 数组 / 数字 / 字符串。
 */
function fieldValue(asset, field) {
  return asset[field]
}

/**
 * 比较一个条件。
 *
 * @param asset - 资产。
 * @param field - 字段。
 * @param op - 运算符。
 * @param rawValue - 值。
 * @returns 是否命中。
 */
function matchTerm(asset, field, op, rawValue) {
  const value = String(rawValue ?? '')

  // `*` = 任意字段包含
  if (field === '*') {
    const needle = value.toLowerCase()
    const hay = [
      asset.host, asset.ip, asset.title, asset.server, asset.banner, asset.service,
      asset.version, asset.certSubject, asset.certIssuer, asset.target,
      ...(asset.tech ?? []), ...(asset.certSan ?? []), ...(asset.sources ?? []),
      asset.port === 0 ? '' : String(asset.port),
    ].join('\n').toLowerCase()
    return op === '!=' ? !hay.includes(needle) : hay.includes(needle)
  }

  // 组合字段：把若干个字段的值摊平成一个字符串列表再比较。
  const members = UNION_FIELDS[field]
  if (members !== undefined) {
    const items = []
    for (const member of members) {
      const raw = asset[member]
      if (Array.isArray(raw)) for (const item of raw) items.push(String(item).toLowerCase())
      else if (raw !== undefined && raw !== null && String(raw) !== '') items.push(String(raw).toLowerCase())
    }
    const needle = value.toLowerCase()
    if (op === '!=') return !items.includes(needle)
    if (op === '=') return items.includes(needle)
    return items.some((item) => item.includes(needle))
  }

  const actual = fieldValue(asset, field)

  if (ARRAY_FIELDS.has(field)) {
    const items = Array.isArray(actual) ? actual.map((item) => String(item).toLowerCase()) : []
    const needle = value.toLowerCase()
    const hit = op === '!=' ? !items.includes(needle) : op === '=' ? items.includes(needle) : items.some((item) => item.includes(needle))
    return hit
  }

  if (NUMERIC_FIELDS.has(field)) {
    const left = typeof actual === 'number' ? actual : Number(actual ?? 0)
    const right = Number(value)
    if (!Number.isFinite(right)) return false
    switch (op) {
      case '=': return left === right
      case '!=': return left !== right
      case '>': return left > right
      case '>=': return left >= right
      case '<': return left < right
      case '<=': return left <= right
      default: return String(left).includes(value)
    }
  }

  const left = String(actual ?? '').toLowerCase()
  const needle = value.toLowerCase()
  switch (op) {
    case '=': return left === needle
    case '!=': return left !== needle
    case '>': return left > needle
    case '>=': return left >= needle
    case '<': return left < needle
    case '<=': return left <= needle
    default: return left.includes(needle)
  }
}

/**
 * 判断一条资产是否命中查询。
 *
 * @param ast - `parseQuery().ast`；`null` 表示全部命中。
 * @param asset - 资产。
 * @returns 是否命中。
 */
export function matchQuery(ast, asset) {
  if (ast === null || ast === undefined) return true
  if (ast.kind === 'and') return matchQuery(ast.left, asset) && matchQuery(ast.right, asset)
  if (ast.kind === 'or') return matchQuery(ast.left, asset) || matchQuery(ast.right, asset)
  return matchTerm(asset, ast.field, ast.op, ast.value)
}

/**
 * 给面板看的语法提示。
 *
 * @returns 一行说明。
 */
export function describeQuery() {
  return '字段：host / ip / port / protocol（含 service）/ fingerprint（技术栈+Server+服务）/ category / '
    + 'status / title / server / tech / cert.subject / cert.issuer / cert.san / cert.notAfter / banner / '
    + 'service / version / source / target / confidence；'
    + '运算符 =（等于） !=（不等于） ~（包含，也可写成 contains） > >= < <=；'
    + '支持 AND / OR 与括号，相邻条件视为 AND。'
    + '例：protocol contains sql、fingerprint~nginx、status=200 AND port=443'
}
