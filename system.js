/**
 * 「系统（app）」的判定核心 —— 纯函数，不碰存储、不碰 DOM。
 *
 * ## 为什么要单独一个模块
 *
 * "两条 URL 是不是同一个系统"是这次重构里唯一真正含糊的判断。把它写成散落在
 * 存储层和面板里的 if，过两周就没人说得清"为什么这两条被合并了"。所以这里只做三件事：
 *
 *   1. 把 URL 归成 `pageType`（入口 / 内容页 / 资源 / 接口）；
 *   2. 给一对 app 算「前端应用 / 认证域 / 后端应用」三项命中；
 *   3. 按**三选二**给结论：命中 ≥2 判同、恰好 1 项进问题池、0 项判不同。
 *
 * 判定结果必须带 `reason`，面板上要能原样显示"为什么合并/为什么不合并"。
 *
 * @module @infohunter/dsh-information-hunter/system
 */

/** 页面分型。只有 `entry` 才会成为系统入口；其余都是证据。 */
export const PAGE_TYPES = ['entry', 'content', 'asset', 'api', 'unknown']

/** 内容页的标题特征（中文 + 英文）。 */
const CONTENT_TITLE = /(详情|列表|第\s*\d+\s*页|更多|栏目|资讯|新闻|文章|商品|下载页|搜索结果|detail|listing|article|post|page\s*\d+)/i

/** 静态资源扩展名。 */
const ASSET_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz|tar|rar|7z|txt|xml|json)$/i

/** query 主导的特征参数（内容页常见）。 */
const CONTENT_QUERY = /[?&](?:id|p|page|cat|category|article|news|post|item|product|detail|tid|fid)=/i

/**
 * 这些 cookie 是通用埋点/负载均衡粘滞，**不能**当作"同一认证域"的证据。
 *
 * 误判代价很高：`SERVERID` 是 nginx 的粘滞 cookie，几乎每个反代站点都有；
 * 把它算进去会让两个毫不相干的系统被判成同一个。
 */
const ANON_COOKIES = new Set([
  '_ga', '_gid', '_gat', '_gcl_au', '_fbp', '_hjid', '_hjfirstseenid', '_clck', '_clsk',
  'serverid', 'route', 'jsessionid', '_csrf', 'csrftoken', 'hm_lvt', 'hm_lpvt', '_ym_uid',
  'phpsessid', 'asp.net_sessionid', 'session', 'sessionid', 'lang', 'locale', '_i18n',
])

/** 通用 HTTP 服务器名 —— 它们不进"后端应用"集合（nginx 反代下全一样）。 */
const GENERIC_SERVERS = new Set([
  'nginx', 'apache', 'apache-cgi', 'caddy', 'cloudflare', 'openresty', 'iis', 'microsoft-iis',
  'tengine', 'envoy', 'traefik', 'haproxy', 'varnish', 'ats', 'gunicorn', 'uvicorn', 'jetty',
])

/**
 * 规范化系统的根路径。
 *
 * 统一成「以 `/` 开头、以 `/` 结尾、无重复斜杠、无 query/fragment」：
 * `/admin`、`admin/`、`//admin//`、`/admin?x=1` 都收敛成 `/admin/`。
 *
 * @param input - 任意路径写法。
 * @returns 规范化后的 basePath；空值返回 `/`。
 */
export function normalizeBasePath(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return '/'
  const withoutQuery = raw.split(/[?#]/)[0]
  const withLead = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`
  const collapsed = withLead.replace(/\/{2,}/g, '/')
  const trimmed = collapsed.replace(/\/+$/, '')
  return trimmed === '' ? '/' : `${trimmed}/`
}

/**
 * 从 URL 里拆出系统定位需要的部件。
 *
 * @param input - 完整 URL 或 `host[:port][/path]`。
 * @returns `{ scheme, host, port, path, basePath }`；拆不出 host 时 host 为空串。
 */
export function splitUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return { scheme: '', host: '', port: 0, path: '/', basePath: '/' }
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text)
  const scheme = match === null ? '' : match[1].toLowerCase()
  const rest = match === null ? text : match[2]
  const authority = rest.split(/[/?#]/)[0]
  const afterAuthority = rest.slice(authority.length)
  const pathOnly = afterAuthority.split(/[?#]/)[0] || '/'

  // IPv6 字面量：[::1]:8080
  const v6 = /^\[([0-9a-f:]+)\](?::(\d+))?$/i.exec(authority)
  if (v6 !== null) {
    return {
      scheme,
      host: v6[1].toLowerCase(),
      port: v6[2] === undefined ? 0 : Number(v6[2]),
      path: pathOnly,
      basePath: normalizeBasePath(pathOnly),
    }
  }
  const at = authority.lastIndexOf(':')
  if (at > 0 && /^\d{1,5}$/.test(authority.slice(at + 1))) {
    return {
      scheme,
      host: authority.slice(0, at).toLowerCase(),
      port: Number(authority.slice(at + 1)),
      path: pathOnly,
      basePath: normalizeBasePath(pathOnly),
    }
  }
  return { scheme, host: authority.toLowerCase(), port: 0, path: pathOnly, basePath: normalizeBasePath(pathOnly) }
}

/**
 * 系统的主键：`scheme://host[:port]/basePath`。
 *
 * 规则（与 README 一致）：
 *   · scheme 参与键 —— `http` 与 `https` 是两个入口，不合并；
 *   · 显式端口保留，`:443` 与省略不合并（宁可多一条，不错并）；
 *   · 只有 http/https 能当系统入口（`ws`、`ftp` 之类没有"应用"概念）。
 *
 * @param {{ scheme: string, host: string, port?: number, basePath?: string }} parts - 部件。
 * @returns 键；scheme 不是 http/https 或 host 为空时返回空串。
 */
export function appKeyOf(parts) {
  const scheme = String(parts?.scheme ?? '').toLowerCase()
  const host = String(parts?.host ?? '').toLowerCase()
  if (host === '') return ''
  if (scheme !== 'http' && scheme !== 'https') return ''
  const port = Number(parts?.port) || 0
  const basePath = normalizeBasePath(parts?.basePath)
  return `${scheme}://${host}${port === 0 ? '' : `:${port}`}${basePath}`
}

/**
 * 系统的展示形式（与键一致，方便对照排查）。
 *
 * @param {object} parts - 同 `appKeyOf`。
 * @returns 展示串；不可作为系统时返回空串。
 */
export function appUrlOf(parts) {
  return appKeyOf(parts)
}

/**
 * 判断一条 URL 属于哪一类页面。
 *
 * 顺序很重要：先排除资源与接口，再用"内容页证据"计数，最后才当入口。
 * 入口是**最严格**的一类 —— 宁可把一条入口误成 unknown 进问题池，也不要让内容页变成系统。
 *
 * @param {object} input - `{ url, title, templateHash, knownTemplateHashes }`。
 * @returns {{ pageType: string, score: number, reasons: string[] }}
 */
export function classifyPageType(input) {
  const url = typeof input?.url === 'string' ? input.url : ''
  const title = typeof input?.title === 'string' ? input.title : ''
  const templateHash = typeof input?.templateHash === 'string' ? input.templateHash : ''
  const known = Array.isArray(input?.knownTemplateHashes) ? input.knownTemplateHashes : []
  const { path } = splitUrl(url)
  const reasons = []

  if (url === '') return { pageType: 'unknown', score: 0, reasons: ['没有 URL'] }
  if (ASSET_EXT.test(path)) return { pageType: 'asset', score: 2, reasons: ['静态资源扩展名'] }
  if (/(^|\/)(?:static|assets?|public|dist|_next|upload|uploads|media)(\/|$)/i.test(path)) {
    return { pageType: 'asset', score: 1, reasons: ['静态资源目录'] }
  }
  if (/(^|\/)api(\/|$)/i.test(path)) return { pageType: 'api', score: 2, reasons: ['/api/ 路径'] }

  let score = 0
  // 长数字 ID：`/news/123.html`、`/item/8899/`、`/post/2024` 都算。
  if (/\/\d{3,}(?:[^\w]|$)/.test(path)) {
    score += 1
    reasons.push('路径含长数字 ID')
  } else {
    // slug：`/article/hello-world-2024.html` —— 末段够长且带连字符（短连字符词多半是资源/版本名）。
    const last = path.split('/').filter((part) => part !== '').pop() ?? ''
    const stem = last.replace(/\.[a-z0-9]+$/i, '')
    if (stem.includes('-') && /[a-z]/i.test(stem) && stem.replace(/-/g, '').length >= 10) {
      score += 1
      reasons.push('路径含 slug')
    }
  }
  if (CONTENT_QUERY.test(url)) {
    score += 1
    reasons.push('query 主导')
  }
  if (CONTENT_TITLE.test(title)) {
    score += 1
    reasons.push('标题像内容页')
  }
  if (templateHash !== '' && known.includes(templateHash)) {
    score += 1
    reasons.push('骨架与已知系统相同')
  }

  if (score >= 2) return { pageType: 'content', score, reasons }
  if (score === 1) return { pageType: 'unknown', score, reasons }
  return { pageType: 'entry', score: 0, reasons: ['无内容页特征'] }
}

/**
 * 前端应用指纹是否相同。
 *
 * `entryScript`（SPA 入口脚本）、`templateHash`（页面骨架）、`assetPrefix`（静态资源目录）
 * 任一相同即算同一前端 —— 它们是同一份构建产物最直接的证据。
 *
 * @param {object} a - 第一个 app。
 * @param {object} b - 第二个 app。
 * @returns {{ hit: boolean, reason: string }}
 */
export function matchFrontend(a, b) {
  for (const [key, label] of [['entryScript', '入口脚本'], ['templateHash', '页面骨架'], ['assetPrefix', '资源目录']]) {
    const left = String(a?.[key] ?? '').trim()
    const right = String(b?.[key] ?? '').trim()
    if (left !== '' && left === right) return { hit: true, reason: `${label}相同` }
  }
  return { hit: false, reason: '前端指纹不同' }
}

/**
 * 认证域是否相同。
 *
 * `loginUrl` 相同，或**非匿名** cookie 名有交集。匿名/粘滞 cookie（`SERVERID`、`_ga`…）
 * 一律不计入 —— 这条排除是防止"nginx 反代下全部判成同系统"的关键。
 *
 * @param {object} a - 第一个 app。
 * @param {object} b - 第二个 app。
 * @returns {{ hit: boolean, reason: string }}
 */
export function matchAuth(a, b) {
  const leftLogin = String(a?.loginUrl ?? '').trim()
  const rightLogin = String(b?.loginUrl ?? '').trim()
  if (leftLogin !== '' && leftLogin === rightLogin) return { hit: true, reason: '登录页相同' }

  const names = (value) => (Array.isArray(value) ? value : [])
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item !== '' && !ANON_COOKIES.has(item))
  const left = new Set(names(a?.cookieNames))
  const shared = names(b?.cookieNames).filter((name) => left.has(name))
  if (shared.length > 0) return { hit: true, reason: `cookie 交集：${shared.slice(0, 3).join(', ')}` }
  return { hit: false, reason: '认证域不同' }
}

/**
 * 后端应用是否相同。
 *
 * 框架/中间件集合有交集，或错误页指纹相同。**`Server` 不参与判定**：
 * nginx 反代下所有站点都回同一个 Server 头，用它判同必然错。
 *
 * @param {object} a - 第一个 app。
 * @param {object} b - 第二个 app。
 * @returns {{ hit: boolean, reason: string }}
 */
export function matchBackend(a, b) {
  const frameworks = (value) => (Array.isArray(value) ? value : [])
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item !== '' && !GENERIC_SERVERS.has(item))
    .filter((item) => !GENERIC_SERVERS.has(item.replace(/[\d.]+$/, '').trim()))
  const left = new Set(frameworks(a?.tech))
  const shared = frameworks(b?.tech).filter((name) => left.has(name))
  if (shared.length > 0) return { hit: true, reason: `框架相同：${shared.slice(0, 3).join(', ')}` }

  const leftError = String(a?.errorPageHash ?? '').trim()
  const rightError = String(b?.errorPageHash ?? '').trim()
  if (leftError !== '' && leftError === rightError) return { hit: true, reason: '错误页指纹相同' }

  return { hit: false, reason: '后端应用不同' }
}

/**
 * 判定两个 app 是不是同一个系统。
 *
 * **三选二**：命中三项 → 同一系统（high）；命中两项 → 同一系统（medium）；
 * 命中一项 → 判不了（`same: null`，交给问题池）；零项 → 不同系统。
 *
 * 硬边界先切：scheme / host / port 任一不同就不进入判定（它们最多是"关联"）。
 *
 * @param {object} a - 第一个 app（含 scheme/host/port 与信号字段）。
 * @param {object} b - 第二个 app。
 * @returns {{ same: boolean | null, confidence: 'high' | 'medium' | 'low', reason: string, signals: object }}
 */
export function judgeSameSystem(a, b) {
  const hostA = String(a?.host ?? '').toLowerCase()
  const hostB = String(b?.host ?? '').toLowerCase()
  const schemeA = String(a?.scheme ?? '').toLowerCase()
  const schemeB = String(b?.scheme ?? '').toLowerCase()
  const portA = Number(a?.port) || 0
  const portB = Number(b?.port) || 0
  const empty = { frontend: false, auth: false, backend: false }
  if (hostA === '' || hostB === '') return { same: false, confidence: 'low', reason: '缺少 host', signals: empty }
  if (schemeA !== schemeB) return { same: false, confidence: 'low', reason: '协议不同', signals: empty }
  if (hostA !== hostB) return { same: false, confidence: 'low', reason: '主机不同', signals: empty }
  if (portA !== portB) return { same: false, confidence: 'low', reason: '端口不同', signals: empty }

  const frontend = matchFrontend(a, b)
  const auth = matchAuth(a, b)
  const backend = matchBackend(a, b)
  const signals = { frontend: frontend.hit, auth: auth.hit, backend: backend.hit }
  const hits = [frontend, auth, backend].filter((item) => item.hit)
  const reasons = [frontend, auth, backend].filter((item) => item.hit).map((item) => item.reason)

  if (hits.length >= 2) {
    return {
      same: true,
      confidence: hits.length === 3 ? 'high' : 'medium',
      reason: `命中 ${hits.length} 项：${reasons.join('；')}`,
      signals,
    }
  }
  if (hits.length === 1) {
    return {
      same: null,
      confidence: 'low',
      reason: `只命中 1 项（${reasons[0]}），其余两项不支持合并`,
      signals,
    }
  }
  return { same: false, confidence: 'low', reason: '三项都不命中', signals: empty }
}

/**
 * 把一组候选系统两两比较，产出"待确认"的问题对。
 *
 * 同一对只产出一次（以 `a|b` 排序后比较），并且跳过已经判定的组合。
 *
 * @param {object[]} apps - 同一端点下的候选 app。
 * @returns {object[]} `{ a, b, reason, signals }[]`
 */
export function collectQuestions(apps) {
  const list = Array.isArray(apps) ? apps.filter((item) => item !== null && typeof item === 'object') : []
  const questions = []
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const left = list[i]
      const right = list[j]
      const verdict = judgeSameSystem(left, right)
      if (verdict.same !== null) continue
      const keys = [String(left.key ?? ''), String(right.key ?? '')].sort()
      const id = `${keys[0]}|${keys[1]}`
      if (seen.has(id)) continue
      seen.add(id)
      questions.push({ a: keys[0], b: keys[1], reason: verdict.reason, signals: verdict.signals })
    }
  }
  return questions
}
