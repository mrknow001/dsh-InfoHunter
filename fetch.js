/**
 * 基础补全：DNS 解析 + HTTP(S) 探测（响应头 / 标题 / 正文摘要 / TLS 证书）。
 *
 * ## 为什么插件要自带这一层
 *
 * 用户配的工具常常只给"有没有、状态码是多少"，不给证书、响应头、正文；
 * 而面板的「详情」页签恰恰读的是这些字段。没有兜底，页签永远显示"未采集"。
 *
 * 顺序始终是：**先用户配置的工具，拿不到再用这里补**。这一层不做端口扫描、
 * 不做指纹识别 —— 只补"能直接观测到的事实"。
 *
 * ## 安全边界
 *
 * - 只发 GET，不加任何 payload；
 * - 默认拒绝回环、链路本地、云元数据地址（避免被当成 SSRF 跳板）；
 * - 单次超时 8 秒、最多 3 次跳转、正文只读前 16KB；
 * - 证书校验关闭（`rejectUnauthorized: false`）：收集阶段经常遇到自签/过期证书，
 *   我们记录它，而不是因为它不合规就看不到。
 *
 * @module @infohunter/dsh-information-hunter/fetch
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { promises as dns } from 'node:dns'

/** 正文最多读这么多字节（面板上限 8000 字符，留点余量给多字节字符）。 */
const BODY_LIMIT = 16 * 1024
/** 单次请求超时（毫秒）。 */
const TIMEOUT_MS = 8000
/** 最多跟随几次跳转。 */
const MAX_REDIRECTS = 3

/**
 * 是否禁止访问该主机（回环 / 链路本地 / 云元数据）。
 *
 * @param host - 主机名或 IP。
 * @returns 禁止时返回原因，允许返回空串。
 */
export function blockedHostReason(host) {
  const value = String(host ?? '').trim().toLowerCase()
  if (value === '') return '缺少主机名'
  if (value === 'localhost' || value.endsWith('.localhost')) return '回环地址'
  if (value === '169.254.169.254') return '云元数据地址'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127) return '回环地址'
    if (a === 169 && b === 254) return '链路本地地址'
    if (a === 0) return '无效地址'
  }
  if (value === '::1' || value === '[::1]') return '回环地址'
  if (value.startsWith('fe80:') || value.startsWith('[fe80:')) return '链路本地地址'
  return ''
}

/**
 * 解析一个域名（A/AAAA/CNAME）。
 *
 * 解析失败不算异常：可能只是没有 AAAA 或没有 CNAME，把能拿到的带回去。
 *
 * @param host - 域名。
 * @returns `{ ips, cname, error }`
 */
export async function resolveHost(host) {
  const name = String(host ?? '').trim()
  if (name === '') return { ips: [], cname: '', error: '缺少主机名' }
  // 已经是 IP 就不用解析。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) {
    return { ips: [name], cname: '', error: '' }
  }
  const ips = []
  let cname = ''
  try {
    const a = await dns.resolve4(name)
    ips.push(...a)
  } catch {
    /* 没有 A 记录是正常的 */
  }
  try {
    const aaaa = await dns.resolve6(name)
    ips.push(...aaaa)
  } catch {
    /* 没有 AAAA 记录是正常的 */
  }
  try {
    const chain = await dns.resolveCname(name)
    if (chain.length > 0) cname = chain[0]
  } catch {
    /* 没有 CNAME 是正常的 */
  }
  return { ips: [...new Set(ips)].slice(0, 8), cname, error: ips.length === 0 && cname === '' ? '无解析结果' : '' }
}

/**
 * 把 Node 的证书对象收敛成面板字段。
 *
 * @param cert - `socket.getPeerCertificate()` 的返回值。
 * @returns `{ subject, issuer, san, notAfter }`
 */
export function certToFields(cert) {
  if (cert === null || typeof cert !== 'object') return undefined
  const pick = (value) => (typeof value === 'string' ? value : '')
  const subject = pick(cert.subject?.CN) || pick(cert.subject?.O) || ''
  const issuer = [pick(cert.issuer?.O), pick(cert.issuer?.CN)].filter((item) => item !== '').join(' / ')
  const sanRaw = typeof cert.subjectaltname === 'string' ? cert.subjectaltname : ''
  const san = sanRaw.split(',').map((item) => item.trim().replace(/^DNS:/i, '')).filter((item) => item !== '').slice(0, 32)
  const notAfter = pick(cert.valid_to)
  if (subject === '' && issuer === '' && san.length === 0 && notAfter === '') return undefined
  return { subject, issuer, san, notAfter }
}

/**
 * 从 HTML 里取标题。
 *
 * @param html - 响应文本。
 * @returns 标题；没有就空串。
 */
export function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html ?? ''))
  if (match === null) return ''
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * 把响应头对象拍平成多行文本（面板「响应头」页签直接显示原文）。
 *
 * @param headers - `response.headers`。
 * @returns 多行文本。
 */
export function formatHeaders(headers) {
  if (headers === null || typeof headers !== 'object') return ''
  const lines = []
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
  }
  return lines.join('\n').slice(0, 1900)
}

/**
 * 取页面正文的可读文本（去标签、压空白）。
 *
 * @param html - 响应文本。
 * @returns 纯文本摘要。
 */
export function extractText(html) {
  const source = String(html ?? '')
  const withoutHead = source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const text = withoutHead.replace(/<[^>]+>/g, ' ')
  return text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().slice(0, 8000)
}

/**
 * TCP 连通性探测：只握手，不发数据。
 *
 * 空间测绘的结果经常是几个月前的，端口早就关了 —— 这一层用来确认"现在还开着吗"。
 *
 * @param input - `{ host, port, timeoutMs, allowPrivate }`。
 * @returns `{ ok, ms, error }`
 */
export function probeTcp(input) {
  const host = String(input?.host ?? '').trim()
  const port = Number(input?.port) || 0
  const timeoutMs = Number(input?.timeoutMs) || 5000
  const allowPrivate = input?.allowPrivate === true
  if (!allowPrivate) {
    const blocked = blockedHostReason(host)
    if (blocked !== '') return Promise.resolve({ ok: false, ms: 0, error: blocked })
  }
  if (host === '' || port <= 0) return Promise.resolve({ ok: false, ms: 0, error: '缺少主机或端口' })
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ ok: true, ms: Date.now() - started, error: '' }))
    socket.once('timeout', () => done({ ok: false, ms: Date.now() - started, error: '连接超时' }))
    socket.once('error', (cause) => done({
      ok: false,
      ms: Date.now() - started,
      error: cause instanceof Error ? cause.message : String(cause),
    }))
  })
}

/**
 * 发一次 GET，拿状态码 / 响应头 / 标题 / 正文 / 证书。
 *
 * @param input - `{ host, port, scheme, path, allowPrivate }`。
 * @returns `{ ok, status, headers, title, body, cert, url, error }`
 */
export function probeHttp(input) {
  const host = String(input?.host ?? '').trim()
  const port = Number(input?.port) || 0
  const scheme = String(input?.scheme ?? 'http').toLowerCase() === 'https' ? 'https' : 'http'
  const path = typeof input?.path === 'string' && input.path !== '' ? input.path : '/'
  const allowPrivate = input?.allowPrivate === true
  if (!allowPrivate) {
    const blocked = blockedHostReason(host)
    if (blocked !== '') return Promise.resolve({ ok: false, error: blocked })
  }
  if (host === '' || port <= 0) return Promise.resolve({ ok: false, error: '缺少主机或端口' })

  const go = (targetPath, redirectsLeft) => new Promise((resolve) => {
    const isHttps = scheme === 'https'
    const opts = {
      host,
      port,
      path: targetPath,
      method: 'GET',
      // 收集阶段会遇到自签/过期证书：记录它，而不是因为它不合规就看不到。
      rejectUnauthorized: false,
      servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? undefined : host,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; infohunter/0.1; +asset-collection)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        connection: 'close',
      },
      timeout: TIMEOUT_MS,
    }
    let peerCert
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = (isHttps ? httpsRequest : httpRequest)(opts, (res) => {
      const status = Number(res.statusCode) || 0
      const location = res.headers.location
      // 跳转：跟最多 3 次（相对地址也能处理）。
      if (status >= 300 && status < 400 && typeof location === 'string' && redirectsLeft > 0) {
        res.resume()
        let nextPath = location
        try {
          const parsed = new URL(location, `${scheme}://${host}:${port}`)
          nextPath = `${parsed.pathname}${parsed.search}`
        } catch {
          /* 用原样 location */
        }
        go(nextPath, redirectsLeft - 1).then(done)
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (size >= BODY_LIMIT) return
        chunks.push(chunk)
        size += chunk.length
      })
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        done({
          ok: true,
          status,
          headers: formatHeaders(res.headers),
          title: extractTitle(raw),
          body: extractText(raw),
          cert: peerCert === undefined ? undefined : certToFields(peerCert),
          url: `${scheme}://${host}:${port}${targetPath}`,
          error: '',
        })
      })
    })
    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        try {
          peerCert = socket.getPeerCertificate()
        } catch {
          /* 取不到证书就算了 */
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      done({ ok: false, error: `超时（${TIMEOUT_MS}ms）` })
    })
    req.on('error', (cause) => {
      done({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    })
    req.end()
  })

  return go(path, MAX_REDIRECTS)
}
