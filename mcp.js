/**
 * 最小 MCP 客户端（客户端侧协议实现）。
 *
 * ## 为什么不复用 `@deepseek-ai/dsh-mcp-client`
 *
 * 那个插件是**一个实例管一个 server**，只能在组合 YAML 里静态声明一行。我们要的是
 * "面板里加一行 → 立刻多一组工具、作用域跟着预设走"，它没有提供动态挂载的入口。
 * 唯一能硬来的办法是 `import()` 出 asar 里的模块对象再 `ctx.plugin()` —— 那等于把
 * 插件的可移植性绑死在这台机器、这个版本上。所以这里只实现协议的一部分：
 * `initialize` → `tools/list` → `tools/call`，够用、可控、零依赖。
 *
 * ## 传输
 *
 * - **stdio**：换行分隔的 JSON-RPC（MCP 的 stdio 约定，和 LSP 的 Content-Length 不同）。
 *   子进程的 stdout 只当协议流；不合法的行直接丢弃（有些 server 会往 stdout 打日志）。
 * - **streamable-http**：POST JSON-RPC，响应可能是 `application/json` 或
 *   `text/event-stream`（SSE）；`Mcp-Session-Id` 拿到就回带。
 *
 * @module @infohunter/dsh-information-hunter/mcp
 */

import { spawn } from 'node:child_process'

/** 我们声明的协议版本（服务端会回它支持的那个，我们不挑）。 */
const PROTOCOL_VERSION = '2024-11-05'

/** 默认的请求超时。 */
export const MCP_TIMEOUTS = {
  /** 建连 + initialize + tools/list。 */
  connect: 20_000,
  /** 单次 tools/call。 */
  call: 60_000,
}

/**
 * 规范化 server 名（它要进工具名 `mcp__<server>__<tool>`）。
 *
 * @param value - 任意字符串。
 * @returns 只含 `[A-Za-z0-9_-]` 的名字。
 */
export function normalizeServerName(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return text === '' ? 'server' : text.slice(0, 32)
}

/**
 * 把 `KEY=VALUE` 的多行文本解析成对象。
 *
 * 面板里让用户按行填，比让他们写 JSON 少出错；值里允许出现 `=`（只按第一个切）。
 *
 * @param text - 多行文本。
 * @returns `{ [key: string]: string }`
 */
export function parseKeyValueLines(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (key === '') continue
    out[key] = value
  }
  return out
}

/**
 * 把对象渲染回 `KEY=VALUE` 多行文本（面板回显用）。
 *
 * @param value - 任意对象。
 * @returns 多行文本。
 */
export function formatKeyValueLines(value) {
  if (value === null || typeof value !== 'object') return ''
  return Object.entries(value).map(([key, val]) => `${key}=${String(val)}`).join('\n')
}

/**
 * stdio 传输：一个子进程。
 */
class StdioTransport {
  #child
  #buffer = ''
  #pending = new Map()
  #nextId = 1
  #stderr = ''
  #closed = false

  constructor(child) {
    this.#child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      // 只留尾部：报错时贴给用户看，别把整个日志攒在内存里。
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4000)
    })
    child.on('exit', (code) => {
      this.#closed = true
      this.#rejectAll(new Error(`MCP server 进程退出（code ${String(code)}）${this.#stderr.slice(-400)}`))
    })
    child.on('error', (error) => {
      this.#closed = true
      this.#rejectAll(error)
    })
  }

  #onData(chunk) {
    this.#buffer += chunk
    // 换行分隔：一行一条消息。最后一段可能不完整，留着等下一次。
    let at
    while ((at = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, at).trim()
      this.#buffer = this.#buffer.slice(at + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // server 往 stdout 打日志的情况很常见，不是协议错误。
        continue
      }
      this.#onMessage(message)
    }
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
      // 服务端反向请求（sampling / roots 等）：我们一个都不支持，明确回错误，
      // 否则对方会一直等。
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'client does not support this request' } })
      return
    }
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    if (message.error !== undefined && message.error !== null) {
      pending.reject(new Error(String(message.error.message ?? 'MCP server 返回错误')))
    } else {
      pending.resolve(message.result)
    }
  }

  #rejectAll(error) {
    for (const pending of [...this.#pending.values()]) pending.reject(error)
    this.#pending.clear()
  }

  #write(message) {
    if (this.#closed) throw new Error('MCP 连接已关闭')
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * 发一个请求并等响应。
   *
   * @param method - 方法名。
   * @param params - 参数。
   * @param timeoutMs - 超时。
   * @returns {Promise<unknown>} `result`。
   */
  request(method, params, timeoutMs) {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP 请求 ${method} 超时（${timeoutMs}ms）${this.#stderr.slice(-300)}`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /**
   * 发一个通知：stdio 直接写，http 走另一个 POST（不关心响应）。
   *
   * @param method - 方法名。
   * @param params - 参数。
   * @returns {void}
   */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /** 关掉子进程。 */
  async close() {
    this.#closed = true
    this.#rejectAll(new Error('MCP 连接已关闭'))
    try {
      this.#child.stdin.end()
    } catch {
      /* 已经关了 */
    }
    try {
      this.#child.kill()
    } catch {
      /* 已经退了 */
    }
  }
}

/**
 * streamable-http 传输。
 */
class HttpTransport {
  #url
  #headers
  #sessionId = ''
  #nextId = 1

  constructor(url, headers) {
    this.#url = url
    this.#headers = { ...headers }
  }

  /**
   * 发一条 JSON-RPC 并取回匹配的那条响应。
   *
   * @param message - 完整消息。
   * @param timeoutMs - 超时。
   * @returns {Promise<object>} 响应消息。
   */
  async #post(message, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = {
        ...this.#headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      }
      if (this.#sessionId !== '') headers['mcp-session-id'] = this.#sessionId
      const response = await fetch(this.#url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      const session = response.headers.get('mcp-session-id')
      if (session !== null && session !== '') this.#sessionId = session
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`MCP HTTP ${response.status}：${text.slice(0, 300)}`)
      }
      const type = response.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream')) {
        return await readSseMessage(response, message.id, timeoutMs)
      }
      const text = await response.text()
      if (text.trim() === '') return undefined
      const payload = JSON.parse(text)
      // 可能是单条，也可能是批次。
      const list = Array.isArray(payload) ? payload : [payload]
      return list.find((item) => item?.id === message.id) ?? list[0]
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param method - 方法名。
   * @param params - 参数。
   * @param timeoutMs - 超时。
   * @returns {Promise<unknown>} `result`。
   */
  async request(method, params, timeoutMs) {
    const id = this.#nextId
    this.#nextId += 1
    const response = await this.#post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    if (response?.error !== undefined && response.error !== null) {
      throw new Error(String(response.error.message ?? 'MCP server 返回错误'))
    }
    return response?.result
  }

  /**
   * @param method - 方法名。
   * @param params - 参数。
   * @returns {Promise<void>}
   */
  async notify(method, params) {
    await this.#post({ jsonrpc: '2.0', method, params }, MCP_TIMEOUTS.connect).catch(() => undefined)
  }

  /** HTTP 没有需要释放的资源。 */
  async close() {}
}

/**
 * 从 SSE 响应里取出我们那条消息。
 *
 * @param response - fetch 的响应。
 * @param id - 我们的请求 id。
 * @param timeoutMs - 超时（用于提前结束读取）。
 * @returns {Promise<object>} 消息。
 */
async function readSseMessage(response, id, timeoutMs) {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('MCP SSE 响应没有 body')
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const dataLines = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        if (dataLines.length === 0) continue
        const data = dataLines.map((line) => line.slice(5).trim()).join('\n')
        let message
        try {
          message = JSON.parse(data)
        } catch {
          continue
        }
        if (message?.id === id) return message
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  throw new Error(`MCP SSE 流里没有等到响应（id ${String(id)}）`)
}

/**
 * 建一条 MCP 连接并完成握手。
 *
 * @param {object} config - 行配置（transport / command / args / env / cwd / url / headers）。
 * @param {{ log?: (message: string) => void }} [options] - 可选日志。
 * @returns {Promise<{ tools: object[], call: (name: string, args: unknown, signal?: AbortSignal) => Promise<object>, close: () => Promise<void>, serverInfo: object }>}
 */
export async function connectMcp(config, options = {}) {
  const transport = config.transport === 'http' ? 'http' : 'stdio'
  let channel
  if (transport === 'stdio') {
    const command = String(config.command ?? '').trim()
    if (command === '') throw new Error('MCP 行没有填 command')
    const args = Array.isArray(config.args) ? config.args.map((value) => String(value)) : []
    const cwd = String(config.cwd ?? '').trim()
    const env = config.env !== null && typeof config.env === 'object' ? config.env : {}
    const child = spawn(command, args, {
      // 不过 shell：参数由面板给，拼成命令行会让空格/引号变成注入面。
      shell: false,
      cwd: cwd === '' ? undefined : cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    channel = new StdioTransport(child)
  } else {
    const url = String(config.url ?? '').trim()
    if (url === '') throw new Error('MCP 行没有填 url')
    channel = new HttpTransport(url, config.headers !== null && typeof config.headers === 'object' ? config.headers : {})
  }

  try {
    const init = await channel.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'infohunter', version: '1' },
    }, MCP_TIMEOUTS.connect)
    // 通知不等响应；stdio 是同步写，http 是另一个 POST（失败不影响握手）。
    Promise.resolve(channel.notify('notifications/initialized', {})).catch(() => undefined)

    const tools = []
    let cursor
    for (let page = 0; page < 10; page += 1) {
      const listed = await channel.request('tools/list', cursor === undefined ? {} : { cursor }, MCP_TIMEOUTS.connect)
      const batch = Array.isArray(listed?.tools) ? listed.tools : []
      for (const tool of batch) {
        if (tool === null || typeof tool !== 'object') continue
        const name = typeof tool.name === 'string' ? tool.name.trim() : ''
        if (name === '') continue
        tools.push({
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        })
      }
      cursor = typeof listed?.nextCursor === 'string' && listed.nextCursor !== '' ? listed.nextCursor : undefined
      if (cursor === undefined) break
    }

    return {
      tools,
      serverInfo: init !== null && typeof init === 'object' ? init.serverInfo ?? {} : {},
      async call(name, args, signal) {
        if (signal?.aborted === true) throw new Error('已取消')
        const result = await channel.request('tools/call', { name, arguments: args ?? {} }, MCP_TIMEOUTS.call)
        return result ?? {}
      },
      async close() {
        await channel.close()
      },
    }
  } catch (error) {
    await channel.close().catch(() => undefined)
    throw error
  }
}

/**
 * 把 `tools/call` 的结果渲染成模型可读文本。
 *
 * @param result - MCP 的 result。
 * @returns `{ text, isError }`。
 */
export function renderToolResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'resource' && typeof block.resource?.text === 'string') parts.push(block.resource.text)
    else if (block.type === 'image') parts.push(`[图片 ${String(block.mimeType ?? '')}，${String(block.data ?? '').length} 字节 base64]`)
    else parts.push(`[${String(block.type ?? 'unknown')} 内容]`)
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }
  return {
    text: parts.length === 0 ? '(MCP server 返回了空结果)' : parts.join('\n\n'),
    isError: result?.isError === true,
  }
}
