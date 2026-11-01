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

import { PAGE_TYPES, appKeyOf, normalizeBasePath, splitUrl } from './system.js'

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
  // 原始响应头与页面正文：面板「详情」页签要读它们，所以必须在资产上有一份结构化副本。
  // 上限按"够看清、不撑爆库"取值 —— 页面正文从来不是收集阶段的重点，证据才是。
  headers: 2000,
  body: 8000,
  note: 4000,
  certSubject: 500,
  certIssuer: 300,
  certNotAfter: 40,
  target: 300,
  // ── 「系统（app）」相关 ─────────────────────────────────────────────────
  //
  // 这些字段是"同一系统"判定的输入（system.js 的三选二）。缺了就判不了，只能进问题池；
  // 所以它们全部可选、全部照实存，不用别的字段顶替。
  url: 2048,
  basePath: 500,
  templateHash: 128,
  entryScript: 512,
  faviconHash: 128,
  assetPrefix: 512,
  loginUrl: 2048,
  errorPageHash: 128,
  mergedInto: 500,
  candidateGroup: 64,
}
/** 数组字段的长度与元素上限。 */
const ARRAY_LIMITS = {
  tech: [24, 80], certSan: [32, 253], sources: [8, 60],
  cookieNames: [24, 64], mergedFrom: [32, 500],
}
/** 一个系统最多留多少条 URL 证据（内容页只会进这里，不建系统）。 */
export const URLS_LIMIT = 200

/**
 * 合法分类。
 *
 * `unknown` = 只知道有这么一个端口，但没观测到任何能判断"是 Web 还是别的服务"的证据。
 * 它存在的意义就是不猜：宁可显示"未识别"，也不要按端口号编一个协议出来。
 */
export const CATEGORIES = ['web', 'service', 'host', 'unknown']

/**
 * 判定等级 —— 面板在 `host:port` 旁边标出来的那个记号。
 *
 * - `fact`    直接观测到原值（状态码、证书主体、banner 原文），不显示标记；
 * - `suspect` 观测到了，但不确定算不算真资产（拦截页、默认页、停放页、泛解析假子域、
 *             未经响应验证的 host 碰撞）—— 面板标「可疑」；
 * - `infer`   没有直接观测，靠推理链得出（证书 SAN 同组织、CNAME 指向 CDN 所以"应该是托管"）
 *             —— 面板标「推测」。
 *
 * 空串表示**没有判定**（老记录、或这次观测没做判定），合并时不会覆盖已有判定。
 */
export const VERDICTS = ['fact', 'suspect', 'infer']

/**
 * 资产节点类型。
 *
 * - `endpoint`：网络可达点 `host:port`（`port=0` 就是裸域名/IP）。非 HTTP 资产到此为止。
 * - `app`：HTTP 之上的**系统**，键是 `scheme://host:port/basePath`。同一端点下可以有多个。
 */
export const NODE_TYPES = ['endpoint', 'app']

/**
 * 系统的合并状态。
 *
 * - `single`     独立系统（默认）；
 * - `unresolved` 与同端点其他候选只命中一项信号，进问题池等用户裁决；
 * - `merged`     已确认与其他入口是同一系统（`mergedFrom` 记来源，可拆）。
 */
export const MERGE_STATES = ['single', 'merged', 'unresolved']

/**
 * 资产生命周期 —— 空间测绘的结果会过期，必须能被"验活"改写。
 *
 * - live：刚验证过，能连上（HTTP 资产还能拿到响应）；
 * - dead：验证时连不上 / 无法访问 —— **不删除**，只标记，保留证据；
 * - 空串：从未验证过。
 */
export const LIFECYCLES = ['live', 'dead']

/**
 * 收敛为合法的生命周期。
 *
 * @param value - 任意值。
 * @returns live / dead / 空串（未验证）。
 */
export function asLifecycle(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return LIFECYCLES.includes(text) ? text : ''
}

/**
 * 主机资产的分面（面板上那 8 个 chip）。
 *
 * 这是**协议族**，不是端口号：只看实测到的 `protocol` / `service`，
 * 两者都没有就落进 `other`（未识别）。绝不按 22/3306 这类端口号反推协议。
 */
export const PROTOCOL_FAMILIES = ['http', 'sql', 'ssh', 'ftp', 'telnet', 'smb', 'rdp', 'other']

/** 协议族 → 成员（小写子串匹配，够用且好维护）。 */
const FAMILY_MEMBERS = {
  http: ['http', 'https', 'http2', 'h2', 'h2c', 'ws', 'wss', 'nginx', 'apache'],
  sql: ['mysql', 'mariadb', 'mssql', 'sqlserver', 'postgres', 'postgresql', 'pgsql', 'oracle', 'db2', 'sqlite'],
  ssh: ['ssh', 'openssh'],
  ftp: ['ftp', 'ftps', 'sftp', 'vsftpd', 'proftpd'],
  telnet: ['telnet'],
  smb: ['smb', 'smbv', 'netbios', 'microsoft-ds', 'cifs'],
  rdp: ['rdp', 'ms-wbt-server', 'rdpssl'],
}

/**
 * 判断一条资产属于哪个协议族。
 *
 * @param asset - 资产。
 * @returns 族 id（`http` / `sql` / … / `other`）。
 */
export function protocolFamily(asset) {
  const hay = [asset?.protocol, asset?.service]
    .filter((item) => typeof item === 'string' && item !== '')
    .join(' ')
    .toLowerCase()
  if (hay === '') return 'other'
  for (const family of PROTOCOL_FAMILIES) {
    if (family === 'other') continue
    const members = FAMILY_MEMBERS[family] ?? []
    if (members.some((member) => hay.includes(member))) return family
  }
  return 'other'
}

/**
 * Web 资产的状态码分面（全部 / 200 / 400 / 403 / 404 / 500 / 502）。
 *
 * 只认**真实观测到的**状态码；`0`（没测到）不属于任何一档，只在「全部」里出现。
 */
export const WEB_STATUS_FACETS = [200, 400, 403, 404, 500, 502]

/**
 * 收敛为合法的页面分型。
 *
 * @param value - 任意值。
 * @returns 分型；非法值一律 `unknown`（宁可判不了，不要瞎归类）。
 */
export function asPageType(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return PAGE_TYPES.includes(text) ? text : 'unknown'
}

/**
 * 收敛为合法的合并状态。
 *
 * @param value - 任意值。
 * @returns 状态；非法值一律 `single`。
 */
export function asMergeState(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MERGE_STATES.includes(text) ? text : 'single'
}

/**
 * 归一化系统的 URL 证据列表（内容页、接口、资源都挂在这里）。
 *
 * @param input - 数组，元素可以是字符串或 `{ url, pageType, title, firstSeen, lastSeen }`。
 * @returns 去重后的列表（按 url 小写去重，封顶 `URLS_LIMIT`）。
 */
export function normalizeUrls(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input) {
    const raw = typeof item === 'string' ? { url: item } : item
    const url = str(/** @type {any} */ (raw)?.url, LIMITS.url)
    if (url === '') continue
    const key = url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      url,
      pageType: asPageType(/** @type {any} */ (raw)?.pageType),
      title: str(/** @type {any} */ (raw)?.title, 300),
      firstSeen: Number.isFinite(/** @type {any} */ (raw)?.firstSeen) ? Number(/** @type {any} */ (raw).firstSeen) : 0,
      lastSeen: Number.isFinite(/** @type {any} */ (raw)?.lastSeen) ? Number(/** @type {any} */ (raw).lastSeen) : 0,
    })
    if (out.length >= URLS_LIMIT) break
  }
  return out
}

/** 这些协议算 Web（只用于把**显式给出的协议**归类，不从端口反推）。 */
const WEB_PROTOCOLS = new Set(['http', 'https', 'http2', 'h2', 'h2c', 'ws', 'wss'])

/**
 * 收敛判定等级。
 *
 * @param value - 任意值。
 * @returns `fact` / `suspect` / `infer`；不认识或缺失时为空串（= 未判定）。
 */
export function asVerdict(value) {
  return typeof value === 'string' && VERDICTS.includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase()
    : ''
}

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
  // `url` 更完整（带路径），系统节点靠它推 host/port/basePath。
  const url = str(source.url, LIMITS.url)
  const parsed = url === '' ? undefined : splitUrl(url)
  const endpoint = splitEndpoint(source.endpoint)
  const host = (str(source.host, LIMITS.host) || endpoint.host || parsed?.host || '').toLowerCase()
  if (host === '') return undefined
  const port = int(source.port, 1, 65535)
    ?? (endpoint.port === undefined ? undefined : int(endpoint.port, 1, 65535))
    ?? (parsed !== undefined && parsed.port !== 0 ? int(parsed.port, 1, 65535) : undefined)

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
  // 判定同样不编造：没给就是空串（= 未判定），不会自动升级成"事实"。
  const verdict = asVerdict(source.verdict ?? source.mark)
  const certSan = list(source.certSan ?? source.cert?.san, ARRAY_LIMITS.certSan)

  // ## 系统（app）相关
  //
  // URL 是**唯一**能给出 basePath 的东西；没有 URL 就只能靠显式 basePath。
  // 两者都没有时，即便 `nodeType=app` 也退化成 endpoint —— 宁可不建系统，也不要编一个根路径。
  const nodeTypeWanted = str(source.nodeType, 16).toLowerCase() === 'app' ? 'app' : 'endpoint'
  const schemeRaw = (givenProtocol || parsed?.scheme || '').toLowerCase()
  const scheme = schemeRaw === 'http' || schemeRaw === 'https' ? schemeRaw : ''
  const basePath = normalizeBasePath(
    str(source.basePath, LIMITS.basePath) || (nodeTypeWanted === 'app' ? parsed?.basePath ?? '' : ''),
  )
  const appKey = nodeTypeWanted === 'app' ? appKeyOf({ scheme, host, port: port ?? 0, basePath }) : ''
  // 建不出合法 key（scheme 不是 http/https、或没有 basePath）→ 当作端点，不硬造系统。
  const nodeType = nodeTypeWanted === 'app' && appKey !== '' ? 'app' : 'endpoint'
  /** 判定信号可以嵌在 `signals` 里传（工具参数那样更整齐）。 */
  const signals = source.signals !== null && typeof source.signals === 'object'
    ? /** @type {Record<string, unknown>} */ (source.signals)
    : {}

  return {
    target: str(source.target, LIMITS.target),
    nodeType,
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
    // 原始响应头与可读正文：同样是"给了才有"，不从不存在的来源推导。
    headers: str(source.headers, LIMITS.headers),
    body: str(source.body, LIMITS.body),
    note: str(source.note, LIMITS.note),
    sources: list(source.sources ?? source.source, ARRAY_LIMITS.sources),
    confidence,
    verdict,
    // ── 系统定位与判定输入 ────────────────────────────────────────────────
    url,
    scheme,
    basePath: nodeType === 'app' ? basePath : '',
    pageType: asPageType(source.pageType),
    // 判定信号：一律"给了才有"，缺了就是判不了（进问题池），不补默认值。
    // 工具参数里这些字段嵌在 `signals` 下（免得把 schema 撑成二十几个平铺项），这里统一摊平。
    templateHash: str(source.templateHash ?? signals.templateHash, LIMITS.templateHash),
    entryScript: str(source.entryScript ?? signals.entryScript, LIMITS.entryScript),
    faviconHash: str(source.faviconHash ?? signals.faviconHash, LIMITS.faviconHash),
    assetPrefix: str(source.assetPrefix ?? signals.assetPrefix, LIMITS.assetPrefix),
    loginUrl: str(source.loginUrl ?? signals.loginUrl, LIMITS.loginUrl),
    errorPageHash: str(source.errorPageHash ?? signals.errorPageHash, LIMITS.errorPageHash),
    cookieNames: list(source.cookieNames ?? signals.cookieNames, ARRAY_LIMITS.cookieNames),
    urls: normalizeUrls(source.urls),
    mergeState: nodeType === 'app' ? asMergeState(source.mergeState) : 'single',
    mergedInto: nodeType === 'app' ? str(source.mergedInto, LIMITS.mergedInto) : '',
    mergedFrom: nodeType === 'app' ? list(source.mergedFrom, ARRAY_LIMITS.mergedFrom) : [],
    candidateGroup: nodeType === 'app' ? str(source.candidateGroup, LIMITS.candidateGroup) : '',
    systemConfidence: ['high', 'medium', 'low'].includes(String(source.systemConfidence ?? ''))
      ? String(source.systemConfidence)
      : '',
    /**
     * 派生节点：根路径 web 资产是由端点**自动**生成的（不是模型显式登记的）。
     * 面板上要能区分"这就是系统入口"和"我们从端点推出来的根路径"。
     */
    derived: source.derived === true,
    // 验活结果：由 expose_verify 写入，模型不填。
    lifecycle: asLifecycle(source.lifecycle),
    lastVerifiedAt: Number.isFinite(source.lastVerifiedAt) ? Number(source.lastVerifiedAt) : 0,
  }
}

/**
 * 资产身份键。
 *
 * - 端点：`host:port`（`port=0` 时就是 `host`）；
 * - 系统：归一化后的 `scheme://host:port/basePath`（归一化在 `normalizeAsset` 里做，这里只读）。
 *
 * 老数据没有 `nodeType` → 一律按端点算，键不变，不会重复。
 *
 * @param asset - 资产。
 * @returns 键。
 */
export function assetKey(asset) {
  if (asset?.nodeType === 'app') {
    const key = appKeyOf({
      scheme: asset.scheme ?? asset.protocol ?? '',
      host: asset.host,
      port: asset.port,
      basePath: asset.basePath,
    })
    if (key !== '') return key
  }
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
  if (previous === undefined) return { ...next, firstSeen: now, lastSeen: now }
  const pick = (key) => {
    const value = next[key]
    if (key === 'urls') return mergeUrlEvidence(previous.urls, value, now)
    if (Array.isArray(value)) {
      const merged = new Map()
      for (const item of [...(previous[key] ?? []), ...value]) merged.set(String(item).toLowerCase(), item)
      return [...merged.values()]
    }
    if (typeof value === 'number') return value !== 0 ? value : previous[key]
    return value !== '' ? value : previous[key]
  }
  const merged = {}
  for (const key of Object.keys(next)) merged[key] = pick(key)
  // 状态只升不降：确认合并过就是 merged，判不了就是 unresolved，绝不因为一次新观测退回 single。
  const states = [previous.mergeState, next.mergeState]
  merged.mergeState = states.includes('merged') ? 'merged'
    : states.includes('unresolved') ? 'unresolved' : 'single'
  // 分型：unknown 不覆盖已知分型（先记 URL 后判分型是正常顺序）。
  if (merged.pageType === 'unknown' && previous.pageType !== undefined && previous.pageType !== 'unknown') {
    merged.pageType = previous.pageType
  }
  merged.firstSeen = Math.min(previous.firstSeen ?? now, now)
  merged.lastSeen = Math.max(previous.lastSeen ?? now, now)
  return merged
}

/**
 * 从一条采集记录派生资产节点（端点 + 可选的系统）。
 *
 * 规则（与 README 一致）：
 *   · 记录总能产出一个**端点**（`host:port`，来自 `asset` 或 `url`）；
 *   · 只有 `kind='app'` 或显式给了 `basePath` 才产出**系统** —— 内容页的 URL 不该变成系统；
 *   · 系统节点把本条 URL 挂进 `urls[]` 当证据（去重由合并逻辑负责）。
 *
 * @param record - 已归一化的采集记录。
 * @param raw - 原始输入（`url` / `basePath` / `pageType` / 信号字段在这里）。
 * @returns `{ endpoint?: object, app?: object }`；都建不出来时返回空对象。
 */
export function nodesFromRecord(record, raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const endpoint = normalizeAsset({ ...source, endpoint: record?.asset })
  const assetText = typeof record?.asset === 'string' ? record.asset : ''
  const url = str(source.url, LIMITS.url) || (/^https?:\/\//i.test(assetText) ? assetText : '')
  const basePath = str(source.basePath, LIMITS.basePath)
  const kind = typeof record?.kind === 'string' ? record.kind : ''
  if ((kind !== 'app' && basePath === '') || (url === '' && basePath === '')) {
    return endpoint === undefined ? {} : { endpoint }
  }
  const app = normalizeAsset({ ...source, url, basePath, nodeType: 'app' })
  if (app === undefined || app.nodeType !== 'app') {
    return endpoint === undefined ? {} : { endpoint }
  }
  const evidence = url === ''
    ? []
    : [{
        url,
        pageType: asPageType(source.pageType),
        title: app.title,
        firstSeen: 0,
        lastSeen: 0,
      }]
  return { endpoint, app: { ...app, urls: mergeUrlEvidence(app.urls, evidence, 0) } }
}

/**
 * 合并 URL 证据：按 url 去重，`firstSeen` 取早、`lastSeen` 取晚，整体封顶。
 *
 * @param previous - 已有列表。
 * @param next - 新列表。
 * @param now - 本次观测时间戳。
 * @returns 合并后的列表。
 */
export function mergeUrlEvidence(previous, next, now) {
  const map = new Map()
  for (const item of normalizeUrls(previous)) map.set(item.url.toLowerCase(), { ...item })
  for (const item of normalizeUrls(next)) {
    const key = item.url.toLowerCase()
    const existing = map.get(key)
    if (existing === undefined) {
      map.set(key, {
        ...item,
        firstSeen: item.firstSeen === 0 ? now : item.firstSeen,
        lastSeen: item.lastSeen === 0 ? now : item.lastSeen,
      })
      continue
    }
    existing.lastSeen = Math.max(existing.lastSeen, item.lastSeen === 0 ? now : item.lastSeen)
    if (existing.firstSeen === 0) existing.firstSeen = item.firstSeen === 0 ? now : item.firstSeen
    if (existing.pageType === 'unknown' && item.pageType !== 'unknown') existing.pageType = item.pageType
    if (existing.title === '' && item.title !== '') existing.title = item.title
  }
  return [...map.values()].slice(0, URLS_LIMIT)
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
  headers: 'headers', header: 'headers', 'web.headers': 'headers',
  body: 'body', text: 'body', 'web.body': 'body',
  note: 'note',
  source: 'sources', sources: 'sources',
  target: 'target',
  confidence: 'confidence',
  // 节点类型：「只要系统」`nodeType=app`、「只要端点」`nodeType=endpoint`。
  nodeType: 'nodeType', nodetype: 'nodeType',
  // 页面分型：`pageType=content` 可以单独把内容页捞出来看。
  pageType: 'pageType', pagetype: 'pageType',
  // 系统根路径：`path~/admin/`。
  basePath: 'basePath', basepath: 'basePath', path: 'basePath',
  // URL（系统的键 + 所有 URL 证据）。
  url: 'url', urls: 'url',
  mergeState: 'mergeState', mergestate: 'mergeState',
  // 验活：lifecycle=dead 捞出所有已失效资产。
  lifecycle: 'lifecycle', verified: 'lifecycle',
  // 判定等级：`verdict=suspect` / `verdict=infer`（面板端点旁的记号）。
  verdict: 'verdict', mark: 'verdict',
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
  // `url` 不是一个扁平字段：系统的键本身 + 它挂着的 URL 证据都算"这个系统的 URL"。
  // 自动解析成常量字符串，这样 `url~admin` 能把整个系统的路径都捞出来。
  if (field === 'url') {
    const collected = [asset.key, asset.url, ...(Array.isArray(asset.urls) ? asset.urls.map((item) => item?.url) : [])]
      .filter((item) => typeof item === 'string' && item !== '')
    return collected.join('\n')
  }
  // 老数据没有 nodeType：它们本来就是端点，不能因此被 `nodeType=endpoint` 漏掉。
  if (field === 'nodeType' && (asset.nodeType === undefined || asset.nodeType === '')) return 'endpoint'
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
    + 'headers / body / service / version / source / target / confidence / verdict；'
    + '运算符 =（等于） !=（不等于） ~（包含，也可写成 contains） > >= < <=；'
    + '支持 AND / OR 与括号，相邻条件视为 AND。'
    + '例：protocol contains sql、fingerprint~nginx、status=200 AND port=443、title!=""'
}
