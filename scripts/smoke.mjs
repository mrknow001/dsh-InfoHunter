#!/usr/bin/env node
/**
 * smoke —— 不依赖 Harness 的端到端自检。
 *
 * 覆盖三块真正会出错的东西：
 *   1. 自带 SQLite 后端 + store：建表、JSON 往返、增删查改、分页、版本戳、重开持久化；
 *   2. `index.js` 的 `apply`：后端注册、`provide`、HTTP 路由挂载、以及每个端点的真实收发；
 *   3. `preset.js` 的 `apply`：四个工具的定义形状（`parameters` / `output` / `execute`）、
 *      常驻段、SKILL.md 解析与技能注册。
 *
 * 用假 ctx 驱动，所以能在这台机器上跑、也不需要重启应用。开发期脚本，不随包分发。
 *
 * 用法：`node scripts/smoke.mjs`
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { createServer } from 'node:http'

let failures = 0
const check = (ok, label, detail) => {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 一个够用的假 Cordis 上下文。 */
function fakeCtx(services = {}) {
  const disposers = []
  const provided = new Map()
  const tools = []
  const routes = []
  const sections = []
  const skills = []
  const logs = []
  const pending = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    provide(key, value) {
      provided.set(key, value)
    },
    get(key) {
      return provided.get(key) ?? services[key]
    },
    inject(deps, callback) {
      // 和真 cordis 一样：依赖没就绪时**不跑回调、也不报错**，等它出现再跑。
      // 解析走 `ctx.get`，这样测试里对 `get` 的覆盖同时作用于 `inject`。
      const attempt = () => {
        if (deps.some((dep) => dep !== 'systemPrompt' && ctx.get(dep) === undefined)) return false
        const scope = { ...ctx }
        for (const dep of deps) {
          if (dep === 'systemPrompt') scope.systemPrompt = { section: (s) => sections.push(s) }
          else scope[dep] = ctx.get(dep)
        }
        callback(scope)
        return true
      }
      if (!attempt()) pending.push(attempt)
    },
    /** 模拟一个可选服务晚到（真实场景：激活顺序不保证）。 */
    _deliver(name, value) {
      services[name] = value
      for (const attempt of [...pending]) {
        if (attempt()) pending.splice(pending.indexOf(attempt), 1)
      }
    },
    get toolsRegistry() {
      return tools
    },
    _disposeAll: async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          /* 忽略 */
        }
      }
    },
  }
  ctx.tools = { register: (definition) => (tools.push(definition), () => {}) }
  ctx.skills = { register: (skill) => (skills.push(skill), () => {}) }
  ctx.logger.info = (message) => logs.push(['info', message])
  return { ctx, provided, tools, routes, sections, skills, logs }
}

/** 构造一个够用的 req/res 对，跑一次路由处理器。 */
async function callRoute(handler, { method = 'GET', url, body, raw }) {
  const payload = raw !== undefined
    ? raw
    : body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
  let status = 0
  let headers
  let text = ''
  const res = {
    writeHead(code, hdrs) {
      status = code
      headers = hdrs
    },
    end(chunk) {
      text += chunk ?? ''
    },
  }
  await handler(req, res)
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status, headers, text, json }
}

/**
 * 手搓一个 zip（store 与 deflate 两种方法都覆盖）。
 *
 * 不引第三方库：`zlib.deflateRawSync` 就是 zip 用的 deflate 裸流，剩下的只是本地头/中央目录。
 *
 * @param {{ name: string, data: string | Buffer, store?: boolean }[]} entries - 条目。
 * @returns {Buffer}
 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const compressed = entry.store === true ? raw : deflateRawSync(raw)
    const method = entry.store === true ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + compressed.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralDir, eocd])
}

/**
 * 一个会说 MCP 的假 server（stdio）。
 *
 * 用它跑真正的传输层：spawn 一个 node 子进程，走换行分隔的 JSON-RPC，
 * 这样测到的是"真的能连上"，而不是把 connectMcp 打桩。
 */
const FAKE_MCP_STDIO = [
  "let buf = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => {",
  "  buf += chunk",
  "  let at",
  "  while ((at = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, at)",
  "    buf = buf.slice(at + 1)",
  "    if (!line.trim()) continue",
  "    let message",
  "    try { message = JSON.parse(line) } catch { continue }",
  "    handle(message)",
  "  }",
  "})",
  "function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n') }",
  "function handle(message) {",
  "  if (message.method === 'initialize') {",
  "    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })",
  "  }",
  "  if (message.method === 'tools/list') {",
  "    return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping', description: '回声工具', inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }] } })",
  "  }",
  "  if (message.method === 'tools/call') {",
  "    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong:' + JSON.stringify(message.params && message.params.arguments || {}) }] } })",
  "  }",
  "  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } })",
  "}",
].join('\n')

/** 等一个异步副作用出现（注册链路是 fire-and-forget 的）。 */async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

const tempRoot = mkdtempSync(join(tmpdir(), 'infohunter-smoke-'))
const dbPath = join(tempRoot, 'infohunter.db')

// ★ 把 DSH_HOME 指到临时目录，**在任何 import 之前**。
//
// 这一行是防事故的：`index.js` 的默认数据库路径是 `$DSH_HOME/storages/infohunter.db`，
// 而 `saveConfig` 是整表覆盖。之前宿主半测试没传 `database`，于是走默认路径 ——
// **跑一次测试就覆盖掉用户的真实配置**（真机上就发生过一次）。指走 DSH_HOME 之后，
// 即使以后某个用例忘了传路径，也碰不到真实数据。
process.env.DSH_HOME = tempRoot

try {
  // ── 1. 存储层 ────────────────────────────────────────────────────────────
  console.log('\n[1] 自带 SQLite 后端 + store')
  const { SqliteKvBackend, HunterStore, BACKEND_NAME, UNIT_NAME, UNIT_VERSION, normalizeEntries } = await import('../storage.js')
  check(BACKEND_NAME === 'infohunter-sqlite', '后端注册名不是 "sqlite"（不与官方/pentest 抢名）', BACKEND_NAME)

  const backend = new SqliteKvBackend(dbPath)
  const openUnit = (version = UNIT_VERSION) =>
    backend.kv.open({ name: UNIT_NAME, version, tables: ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links'], hasGlobal: false })

  const unit = await openUnit()
  const store = new HunterStore(unit)
  await store.load()
  check(store.config().entries.length === 0, '首次打开时配置为空')

  // 双开必须被拒（调用方 bug 要响）
  let doubleOpen
  try {
    await openUnit()
    doubleOpen = undefined
  } catch (error) {
    doubleOpen = error.message
  }
  check(doubleOpen !== undefined && doubleOpen.includes('已打开'), '同一 unit 双开被拒绝', doubleOpen)

  // 版本比介质新 → 拒绝读
  let newer
  try {
    await backend.kv.open({ name: 'other', version: 99, tables: ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links'], hasGlobal: false })
    newer = undefined
  } catch (error) {
    newer = error.message
  }
  check(newer === undefined, '更高版本的 unit 可以打开（向前兼容）', newer)

  const doc = await store.saveConfig([
    { id: 'a', type: 'tool', purpose: 'subdomain', name: 'subfinder', path: 'C:/t/subfinder.exe', description: '被动子域枚举', enabled: true, note: '' },
    // 映射行：多选能力。故意混入非法 id 与重复项，验证收敛（去非法、去重、按声明顺序）。
    {
      id: 'b',
      type: 'mapping',
      capabilities: ['port', 'web', '不存在的种类', 'cert', 'port', 'subdomain'],
      name: 'FOFA',
      baseUrl: 'https://fofa.info/api/v1',
      key: 'SECRET1234',
      apiDoc: 'GET /search/global',
      remark: '会员',
      enabled: true,
      note: '',
    },
    // 老行（单选 purpose 时代）迁移：应变成只勾该能力。
    { id: 'legacy', type: 'mapping', purpose: 'port', name: '老平台', baseUrl: 'https://old', key: '', apiDoc: 'doc', enabled: true, note: '' },
    { id: 'c', type: 'tool', name: 'empty', path: '', description: '', enabled: true, note: '' }, // 空行 → 丢弃
    { id: 'b', type: 'mapping', name: 'DUP', baseUrl: 'x', key: 'y', apiDoc: 'z', enabled: true, note: '' }, // 重复 id → 丢弃
    { type: 'tool', name: 'no-id', path: 'p', description: 'd', enabled: true, note: '' }, // 无 id → 丢弃
  ])
  check(doc.entries.length === 3, '保存时丢弃空行/重复 id/无 id 的行', String(doc.entries.length))
  check(doc.entries[0].path === 'C:/t/subfinder.exe', '工具行 path 往返正确')
  check(doc.entries[0].purpose === 'subdomain', '工具行是单选用途')
  check(doc.entries[1].key === 'SECRET1234', '测绘行 key 往返正确')

  const fofa = doc.entries[1]
  check(Array.isArray(fofa.capabilities), '测绘行用多选 capabilities')
  check(JSON.stringify(fofa.capabilities) === JSON.stringify(['subdomain', 'port', 'web', 'cert']),
    '能力勾选：去非法、去重、按声明顺序', JSON.stringify(fofa.capabilities))
  check(fofa.purpose === undefined, '测绘行不再带单值 purpose')

  const legacy = doc.entries[2]
  check(JSON.stringify(legacy.capabilities) === JSON.stringify(['port']),
    '老的单选 purpose 行迁移成只勾该能力', JSON.stringify(legacy.capabilities))

  // 只勾了能力、还没填 BaseURL 的行要留下（否则用户先勾后填的勾选会被静默丢掉）。
  const partial = await store.saveConfig([
    { id: 'p', type: 'mapping', capabilities: ['port'], name: '半成品', baseUrl: '', key: '', apiDoc: '', enabled: true, note: '' },
  ])
  check(partial.entries.length === 1, '只勾了能力的测绘行不会被当成空行丢弃', String(partial.entries.length))
  check(JSON.stringify(partial.entries[0]?.capabilities) === JSON.stringify(['port']), '半成品行的勾选被保留')
  await store.saveConfig(doc.entries)

  check(store.enabledEntries('mapping').length === 2, 'enabledEntries 按类型过滤')

  // 形态：输入/输出是工具之间自动串接的依据，必须能存、能收敛、能带「其他」。
  const shaped = await store.saveConfig([
    {
      id: 's1', type: 'tool', purpose: 'subdomain', name: 'subfinder', path: '/t/subfinder', description: '', enabled: true, note: '',
      inputs: ['main_domain', 'domain', '瞎写', 'main_domain'], outputs: ['subdomain'],
      inputMode: 'custom', inputModeNote: '主域名单独可用；域名需配合',
    },
    {
      id: 's2', type: 'mapping', name: '内部平台', baseUrl: 'https://x', key: '', apiDoc: 'doc', enabled: true, note: '',
      inputs: ['subdomain'], outputs: ['other'], outputsOther: '内部资产编号',
    },
    // 只勾了形态的空行也应该留下（用户先勾后填）。
    { id: 's3', type: 'tool', name: '半成品', path: '', description: '', enabled: true, note: '', outputs: ['ip'] },
  ])
  check(shaped.entries.length === 3, '只勾了形态的行不会被当成空行丢弃', String(shaped.entries.length))
  check(JSON.stringify(shaped.entries[0].inputs) === JSON.stringify(['main_domain', 'domain']),
    '形态收敛：去非法、去重、按声明顺序', JSON.stringify(shaped.entries[0].inputs))
  check(JSON.stringify(shaped.entries[0].outputs) === JSON.stringify(['subdomain']),
    '工具的 outputs 往返正确', JSON.stringify(shaped.entries[0].outputs))
  check(shaped.entries[0].inputMode === 'custom' && shaped.entries[0].inputModeNote === '主域名单独可用；域名需配合',
    '输入条件关系与说明往返正确',
    JSON.stringify([shaped.entries[0].inputMode, shaped.entries[0].inputModeNote]))
  check(shaped.entries[0].inputMode !== undefined && shaped.entries[2].inputMode === 'or',
    '没写关系的行缺省是 or', String(shaped.entries[2].inputMode))
  const badMode = await store.saveConfig([
    { id: 'm9', type: 'tool', name: 'x', path: '/x', description: '', enabled: true, note: '', inputMode: '瞎写' },
  ])
  check(badMode.entries[0].inputMode === 'or', '不认识的 inputMode 退回 or', badMode.entries[0].inputMode)
  // 空间测绘的输出由 capabilities 表达：这里给了 outputs 也必须被清掉，不能留第二个真相。
  check(shaped.entries[1].outputs.length === 0 && shaped.entries[1].outputsOther === '',
    '空间测绘行的输出被清掉（输出就是 capabilities）',
    JSON.stringify([shaped.entries[1].outputs, shaped.entries[1].outputsOther]))
  check(JSON.stringify(shaped.entries[1].inputs) === JSON.stringify(['subdomain']),
    '空间测绘行的输入照常保留', JSON.stringify(shaped.entries[1].inputs))
  // 工具行的「其他」自定义内容照常往返。
  const toolOther = await store.saveConfig([
    { id: 'o1', type: 'tool', name: 'x', path: '/x', description: '', enabled: true, note: '', outputs: ['other'], outputsOther: '内部资产编号' },
  ])
  check(toolOther.entries[0].outputsOther === '内部资产编号', '工具行的「其他」自定义内容往返正确')
  await store.saveConfig(doc.entries)

  await store.saveConfig([...doc.entries, { ...doc.entries[0], id: 'off', enabled: false }])
  check(store.enabledEntries().length === 3, '禁用的行不出现在 enabledEntries', String(store.enabledEntries().length))

  // ── 1b. 资产：按端点合并 + 查询语法 ────────────────────────────────────
  const assets = await import('../assets.js')

  // 归一化：**只认观测到的证据**，绝不按端口号猜协议或分类。
  const web = assets.normalizeAsset({ host: 'API.Example.com', port: 443, title: 'console' })
  check(web.category === 'web' && web.protocol === '' && web.host === 'api.example.com',
    '归一化：有 title 判 web、不按端口编协议、host 小写', `${web.category}/${web.protocol}/${web.host}`)
  const explicit = assets.normalizeAsset({ host: 'a.example.com', port: 8443, protocol: 'https' })
  check(explicit.category === 'web' && explicit.protocol === 'https', '显式给出的协议算证据',
    `${explicit.category}/${explicit.protocol}`)
  const sshBare = assets.normalizeAsset({ host: '10.0.0.5', port: 22 })
  check(sshBare.category === 'unknown' && sshBare.protocol === '',
    '只给端口 → unknown 且协议留空（不按 22 猜 ssh）', `${sshBare.category}/${sshBare.protocol}`)
  const sshReal = assets.normalizeAsset({
    host: '10.0.0.5', port: 22, service: 'ssh', version: 'OpenSSH 8.9', banner: 'SSH-2.0-OpenSSH_8.9',
  })
  check(sshReal.category === 'service' && sshReal.service === 'ssh' && sshReal.banner === 'SSH-2.0-OpenSSH_8.9',
    '有 service/version/banner 才判服务', `${sshReal.category}/${sshReal.service}`)
  const noConfidence = assets.normalizeAsset({ host: 'x.example.com', port: 80 })
  check(noConfidence.confidence === null, '没给 confidence 就是 null（不编 50）', String(noConfidence.confidence))
  const detailOnly = assets.normalizeAsset({ host: 'y.example.com', port: 22, detail: 'agent 的分析句子' })
  check(detailOnly.banner === '', 'detail 不会被当成 banner', JSON.stringify(detailOnly.banner))
  const hostOnly = assets.normalizeAsset({ host: 'example.com' })
  check(hostOnly.category === 'host' && hostOnly.port === 0, '归一化：没有端口算 host 级记录')
  const fromEndpoint = assets.normalizeAsset({ endpoint: 'http://a.example.com:8080/x?y=1' })
  check(fromEndpoint.host === 'a.example.com' && fromEndpoint.port === 8080 && fromEndpoint.protocol === 'http',
    '归一化：endpoint 能拆出 host:port 与 scheme', `${fromEndpoint.host}/${fromEndpoint.port}/${fromEndpoint.protocol}`)
  check(assets.normalizeAsset({ port: 22 }) === undefined, '归一化：没有 host 直接丢弃')

  // 判定等级（面板端点旁的「可疑 / 推测」标记）
  const suspect = assets.normalizeAsset({ host: 'w.example.com', port: 443, status: 403, verdict: 'suspect' })
  check(suspect.verdict === 'suspect', '归一化：verdict=suspect', suspect.verdict)
  const noVerdict = assets.normalizeAsset({ host: 'w.example.com', port: 443 })
  check(noVerdict.verdict === '', '没给 verdict 就是空串（不默认成事实）', JSON.stringify(noVerdict.verdict))
  check(assets.normalizeAsset({ host: 'w.example.com', verdict: '瞎写' }).verdict === '',
    '不认识的 verdict 被丢弃')
  const kept = assets.mergeAsset(assets.mergeAsset(undefined, suspect, 1), noVerdict, 2)
  check(kept.verdict === 'suspect', '合并：后续没判定的观测不会把标记抹掉', kept.verdict)
  const clearedVerdict = assets.mergeAsset(kept, assets.normalizeAsset({ host: 'w.example.com', port: 443, status: 200, verdict: 'fact' }), 3)
  check(clearedVerdict.verdict === 'fact', '合并：拿到直接证据写 fact 可以清掉标记', clearedVerdict.verdict)

  const { written, added, merged } = await store.upsertAssets('session-1', [
    { target: 'example.com', host: 'api.example.com', port: 443, sources: ['subfinder'] },
    // 同一端点第二次观测：补字段、加来源 —— 必须合并成一条，而不是两行。
    { target: 'example.com', host: 'api.example.com', port: 443, status: 200, title: '控制台', server: 'nginx', tech: ['vue'], sources: ['fofa'] },
    { target: 'example.com', host: '10.0.0.5', port: 22, service: 'ssh', version: 'OpenSSH 8.9', banner: 'SSH-2.0-OpenSSH_8.9' },
    { target: 'example.com', host: 'example.com' },
  ])
  check(written.length === 4 && added === 3 && merged === 1,
    '同端点合并：4 次写入 → 3 个资产，其中 1 次是合并', `written=${written.length} added=${added} merged=${merged}`)
  check(store.assetsOf('session-1').length === 3, '资产数按端点去重', String(store.assetsOf('session-1').length))

  const api = store.assetsOf('session-1').find((row) => row.key === 'api.example.com:443')
  check(api.status === 200 && api.title === '控制台' && api.server === 'nginx',
    '合并补上了后一次观测的字段')
  check(JSON.stringify(api.sources.slice().sort()) === JSON.stringify(['fofa', 'subfinder']),
    '合并取来源并集', JSON.stringify(api.sources))
  check(api.lastSeen >= api.firstSeen, '合并维护 firstSeen/lastSeen')

  // 查询语法
  const q = (text) => store.pageAssets('session-1', { q: text }).total
  check(q('port=443') === 1, 'port=443 命中 1 条', String(q('port=443')))
  check(q('port=22') === 1, 'port=22 命中 1 条')
  check(q('web.status=200') === 1, 'web.status=200 命中 1 条')
  check(q('status=404') === 0, 'status=404 不命中')
  check(q('status!=200') === 2, 'status!=200 命中其余 2 条', String(q('status!=200')))
  check(q('tech=vue') === 1, '数组字段按成员等值匹配')
  check(q('title~控制') === 1, '~ 做子串匹配')
  check(q('port=443 AND status=200') === 1, 'AND 生效')
  check(q('port=22 OR port=443') === 2, 'OR 生效', String(q('port=22 OR port=443')))
  check(q('(port=22 OR port=443) AND status=200') === 1, '括号改变优先级')
  check(q('category=host') === 1, 'category=host 命中无端口的域名记录')
  check(q('banner~OpenSSH') === 1, 'banner 可检索')
  check(q('source=subfinder') === 1, 'source 按成员匹配')
  check(q('ssh') === 1, '裸关键词走全字段包含')
  check(store.pageAssets('session-1', { q: 'port=443 AND' }).error !== undefined,
    '语法不完整时返回 error 而不是抛异常')
  check(q('') === 3, '空查询不筛')

  // 组合字段与 contains：过滤必须跟面板列里看到的一致
  check(q('protocol~ssh') === 1, 'protocol 也匹配服务名（列里显示的就是服务名）', String(q('protocol~ssh')))
  check(q('protocol contains ssh') === 1, 'contains 是 ~ 的别名', String(q('protocol contains ssh')))
  check(q('protocol=ssh') === 1, 'protocol 等值仍可精确匹配')
  check(q('fingerprint~OpenSSH') === 1, 'fingerprint 覆盖服务名与版本', String(q('fingerprint~OpenSSH')))
  check(q('fingerprint~nginx') === 1, 'fingerprint 覆盖 Server / 技术栈', String(q('fingerprint~nginx')))
  check(q('fingerprint=vue') === 1, 'fingerprint 等值匹配技术栈成员')
  check(q('title contains 控制') === 1, 'title 支持 contains 模糊匹配')
  check(q('fingerprint~不存在的东西') === 0, 'fingerprint 不命中时返回 0')

  const onlyWeb = store.pageAssets('session-1', { category: 'web' })
  check(onlyWeb.total === 1, '按分类筛选', String(onlyWeb.total))

  const overview = store.overviewAssets('session-1')
  check(overview.total === 3 && overview.byCategory.web === 1 && overview.byCategory.service === 1 && overview.byCategory.host === 1,
    '概览按 web/service/host 计数', JSON.stringify(overview.byCategory))

  const revBefore = store.rev('session-1').assets
  await store.deleteAsset('session-1', 'api.example.com:443')
  check(store.rev('session-1').assets > revBefore, '删除后变更令牌递增')
  check(store.assetsOf('session-1').length === 2, '删除生效')

  // 重开：验证真的落盘
  await store.unit.close()
  await backend.close()
  const backend2 = new SqliteKvBackend(dbPath)
  const unit2 = await backend2.kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links'], hasGlobal: false })
  const store2 = new HunterStore(unit2)
  await store2.load()
  check(store2.config().entries.length === 4, '重开后配置仍在', String(store2.config().entries.length))
  check(store2.config().entries[1].key === 'SECRET1234', '重开后密钥完整')
  check(store2.assetsOf('session-1').length === 2, '重开后资产仍在')
  check(Array.isArray(store2.assetsOf('session-1')[0]?.sources), '重开后 sources 仍是数组')

  // 老 `results` 行迁移：一行一次观测 → 端点资产（同端点合并、幂等）。
  await store2.unit.putRecord('results', 'session-old:port-1', {
    id: 'port-1', sessionId: 'session-old', target: 'old.com', kind: 'port',
    asset: 'old.com:8080', detail: 'nginx 1.24', source: 'nmap', confidence: 95, createdAt: 1000,
  })
  await store2.unit.putRecord('results', 'session-old:web-1', {
    id: 'web-1', sessionId: 'session-old', target: 'old.com', kind: 'web',
    asset: 'old.com:8080', detail: '登录页', sources: ['httpx'], confidence: 90, createdAt: 2000,
  })
  // 数据修复：早期迁移把 detail 写进了 banner，读取时应就地清掉（幂等）。
  await store2.unit.putRecord('assets', 'session-old:stale.example.com:80', {
    key: 'stale.example.com:80', sessionId: 'session-old', host: 'stale.example.com', port: 80,
    category: 'web', title: '', banner: '登录页', sources: [], confidence: 50,
    firstSeen: 1, lastSeen: 1,
  })
  await store2.load()
  const repaired = store2.assetsOf('session-old').find((row) => row.key === 'stale.example.com:80')
  check(repaired?.banner === '', '历史 detail 被误写成 banner 的，读取时就地清空', JSON.stringify(repaired?.banner))

  await store2.load()
  // 只看本用例关心的那个端点（上面为了测修复另外塞了一条 stale 资产）。
  const migrated = store2.assetsOf('session-old').filter((row) => row.key === 'old.com:8080')
  check(migrated.length === 1, '老的多行观测迁移到同一个端点', String(migrated.length))
  check(migrated[0].key === 'old.com:8080', '迁移按端点合并', migrated[0].key)
  check(migrated[0].banner === '', '老记录的 detail 不再塞进 banner（它不是服务 banner）', JSON.stringify(migrated[0].banner))
  check(JSON.stringify(migrated[0].sources.slice().sort()) === JSON.stringify(['httpx', 'nmap']),
    '迁移合并来源', JSON.stringify(migrated[0].sources))

  // 采集记录：追加语义（不合并）+ 按 kind/来源/关键词查询 + 概览
  const appended = await store2.appendRecords('session-rec', [
    { kind: 'subdomain', asset: 'a.example.com', detail: 'A 1.2.3.4', sources: ['subfinder'], confidence: 90 },
    { kind: 'subdomain', asset: 'a.example.com', detail: '再次观测', sources: ['fofa'] },
    { kind: 'port', asset: 'a.example.com:443', detail: 'open', sources: ['naabu'] },
  ])
  check(appended.written.length === 3, '三条同资产记录都被保留（追加不合并）', String(appended.written.length))
  check(appended.added === 2, '写记录时顺手汇总资产：host + host:port 共 2 个', JSON.stringify({ added: appended.added }))
  check(store2.recordsOf('session-rec').length === 3, '采集记录不去重')
  check(store2.assetsOf('session-rec').length === 2, '同样的观测会汇总成 2 个资产（host + host:port）',
    String(store2.assetsOf('session-rec').length))
  const recOverview = store2.overviewRecords('session-rec')
  check(recOverview.total === 3 && recOverview.byKind.subdomain === 2, '记录概览按 kind 计数', JSON.stringify(recOverview.byKind))
  check(recOverview.bySource.fofa === 1 && recOverview.bySource.subfinder === 1, '记录概览按来源计数')
  check(store2.pageRecords('session-rec', { kind: 'port' }).total === 1, '记录按 kind 过滤')
  check(store2.pageRecords('session-rec', { q: '再次观测' }).total === 1, '记录按证据关键词命中')
  check(store2.pageRecords('session-rec', { source: 'fofa' }).total === 1, '记录按来源过滤')
  await store2.deleteRecord('session-rec', appended.written[0].id)
  check(store2.recordsOf('session-rec').length === 2, '删除单条记录')
  check(await store2.clearRecords('session-rec') === 2 && store2.recordsOf('session-rec').length === 0, '清空记录')

  const cleared = await store2.clearAssets('session-1')
  check(cleared === 2 && store2.assetsOf('session-1').length === 0, '清空会话资产')

  // ── 1b2. 最近语句 + 关联关系 ────────────────────────────────────────────
  console.log('\n[1b2] 最近语句与关联关系')

  // 记录现在要保留结构化 ip / cname：关联页签的"历史"只认这些，不猜 detail 文本。
  const recWithIp = await store2.appendRecords('session-rel', [
    { kind: 'dns', asset: 'rel.example.com', ip: '10.0.0.9', cname: 'cdn.example.net', sources: ['subfinder'] },
    { kind: 'web', asset: 'rel.example.com:443', headers: 'HTTP/1.1 200\nServer: nginx', body: '登录页正文' },
  ])
  const storedRecord = store2.recordsOf('session-rel').find((row) => row.kind === 'dns')
  check(storedRecord?.ip === '10.0.0.9' && storedRecord?.cname === 'cdn.example.net',
    '采集记录保留结构化 ip / cname', JSON.stringify({ ip: storedRecord?.ip }))
  const webRecord = store2.recordsOf('session-rel').find((row) => row.kind === 'web')
  check(webRecord?.headers.includes('Server: nginx') && webRecord?.body === '登录页正文',
    '采集记录保留 headers / body')
  check(recWithIp.written.length === 2, '两条记录都写入了', String(recWithIp.written.length))

  const assetWithBody = store2.assetsOf('session-rel').find((row) => row.host === 'rel.example.com' && row.port === 443)
  check(assetWithBody?.body === '登录页正文' && assetWithBody?.headers.includes('nginx'),
    '资产上也带 headers / body')
  check(store2.pageAssets('session-rel', { q: 'body~登录页' }).total === 1,
    '正文可被查询语法检索（body~关键词）')

  // 关联：同 IP / 同 CNAME / 同 host 端口 / 证书 SAN
  // 用独立会话，避免和上面的 appendRecords 造出的资产混在一起。
  // 每个节点只该落进**一个**块：端口 > 域名 > CNAME > 同 host 端口。
  await store2.upsertAssets('session-rel2', [
    { host: 'rel2.example.com', port: 443, ip: '10.9.9.9', cname: 'cdn2.example.net', certSan: ['rel2.example.com', 'www.rel2.example.com'], category: 'web' },
    { host: 'rel2.example.com', port: 8080, ip: '10.9.9.9', category: 'unknown' },
    { host: 'domain2.example.com', port: 0, ip: '10.9.9.9', category: 'host' },
    { host: 'other2.example.com', port: 443, ip: '10.9.9.8', cname: 'cdn2.example.net', category: 'web' },
    { host: 'rel2.example.com', port: 9090, ip: '10.9.9.7', category: 'unknown' },
  ])
  const relations = store2.relationsOf('session-rel2', 'rel2.example.com:443')
  check(relations.found === true && relations.current.ip === '10.9.9.9', '关联：找到自身并带出 IP')
  check(relations.current.sameIpPorts.length === 1 && relations.current.sameIpPorts[0].port === 8080,
    '关联：同 IP 的端口（8080）', JSON.stringify(relations.current.sameIpPorts))
  check(relations.current.sameIpDomains.length === 1 && relations.current.sameIpDomains[0].host === 'domain2.example.com',
    '关联：同 IP 的域名单独成块', JSON.stringify(relations.current.sameIpDomains))
  check(relations.current.sameCname.length === 1 && relations.current.sameCname[0].host === 'other2.example.com',
    '关联：同 CNAME 命中 other2', JSON.stringify(relations.current.sameCname))
  check(relations.current.sameHostPorts.length === 1 && relations.current.sameHostPorts[0].port === 9090,
    '关联：同 host 的其他端口（9090）', JSON.stringify(relations.current.sameHostPorts))
  check(relations.current.certSan.length === 2, '关联：证书 SAN 原样带出')
  const allRelated = [
    ...relations.current.sameIpPorts, ...relations.current.sameIpDomains,
    ...relations.current.sameCname, ...relations.current.sameHostPorts,
  ]
  check(new Set(allRelated.map((node) => node.key)).size === allRelated.length, '关联：同一节点不会出现在两个块里')
  check(allRelated.every((node) => node.key !== 'rel2.example.com:443'), '关联：排除自身')

  // 历史：只认"结构化写过 ip"的记录，带时间与来源。
  const relHistory = store2.relationsOf('session-rel', 'rel.example.com:443')
  check(relHistory.history.length >= 1, '关联：历史取到采集记录', String(relHistory.history.length))
  check(relHistory.history.some((item) => item.explicitIp && item.ip === '10.0.0.9'),
    '关联：历史里显式写过的 IP 被标出来')
  const relMissing = store2.relationsOf('session-rel', 'nope.example.com:1')
  check(relMissing.found === false && relMissing.history.length === 0,
    '关联：不存在的端点返回空结构而不是抛错')

  // 最近语句：去重计数、非法不记、LRU 淘汰、删除与清空
  check((await store2.recordQuery('  status=200  ')).length === 1, '最近语句：首条记录')
  let recent = await store2.recordQuery('STATUS=200')
  check(recent.length === 1 && recent[0].count === 2, '最近语句：大小写不敏感去重并累加次数',
    JSON.stringify(recent))
  await store2.recordQuery('port=')
  check((await store2.recentQueries()).length === 1, '最近语句：语法错误不记录')
  await store2.recordQuery('   ')
  check((await store2.recentQueries()).length === 1, '最近语句：空白不记录')
  // 上限 5：连写 12 条，只留最近的 5 条（最久未用淘汰）。
  for (let index = 0; index < 12; index += 1) await store2.recordQuery(`port=${1000 + index}`)
  recent = await store2.recentQueries()
  check(recent.length === 5, '最近语句：上限 5 条', String(recent.length))
  check(recent[0].q === 'port=1011', '最近语句：最新的在最前', recent[0].q)
  check(recent.at(-1).q === 'port=1007', '最近语句：淘汰最久未用的', recent.at(-1).q)
  await store2.forgetQuery('port=1011')
  check((await store2.recentQueries()).length === 4, '最近语句：可删单条')
  check((await store2.clearQueries()).length === 0, '最近语句：可清空')

  await store2.recordQuery('verdict=suspect')
  const beforeReopen = (await store2.recentQueries()).length
  await store2.unit.close()
  await backend2.close()

  const backend3 = new SqliteKvBackend(dbPath)
  const unit3 = await backend3.kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links'], hasGlobal: false })
  const store3 = new HunterStore(unit3)
  await store3.load()
  check(store3.recentQueries().length === beforeReopen, '最近语句：重开后仍在（全局持久化）',
    String(store3.recentQueries().length))
  await store3.clearQueries()
  await store3.unit.close()
  await backend3.close()

  // 上限被调小之后：旧库里的多余语句要在**加载时**就淘汰，而不是等下一次查询。
  const backend4 = new SqliteKvBackend(dbPath)
  const unit4 = await backend4.kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links'], hasGlobal: false })
  for (let index = 0; index < 8; index += 1) {
    await unit4.putRecord('queries', `port=${2000 + index}`, {
      q: `port=${2000 + index}`, count: 1, lastUsedAt: 1000 + index,
    })
  }
  const store4 = new HunterStore(unit4)
  await store4.load()
  check(store4.recentQueries().length === 5, '最近语句：加载时就按上限收一次', String(store4.recentQueries().length))
  const leftInUnit = await unit4.loadAll()
  check(Object.keys(leftInUnit.tables.queries ?? {}).length === 5,
    '最近语句：被淘汰的那几条也从介质里删掉了',
    String(Object.keys(leftInUnit.tables.queries ?? {}).length))
  await store4.clearQueries()
  await store4.unit.close()
  await backend4.close()

  // ── 1b3. 系统（app）判定、合并与问题池 ─────────────────────────────────
  console.log('\n[1b3] 系统判定与问题池')

  const systemMod = await import('../system.js')
  check(systemMod.normalizeBasePath('admin') === '/admin/', 'basePath：补首尾斜杠')
  check(systemMod.normalizeBasePath('//a//b//') === '/a/b/', 'basePath：折叠重复斜杠')
  check(systemMod.normalizeBasePath('/x?y=1#z') === '/x/', 'basePath：剥 query 与 fragment')
  check(systemMod.normalizeBasePath('') === '/', 'basePath：空值记成根路径')
  check(systemMod.appKeyOf({ scheme: 'https', host: 'A.example.com', port: 8443, basePath: 'admin' })
    === 'https://a.example.com:8443/admin/', 'appKey：主机小写、端口保留、scheme 参与')
  check(systemMod.appKeyOf({ scheme: '', host: 'a', port: 80, basePath: '/' }) === '',
    'appKey：没有 http/https 协议就不是系统')

  const pageCases = [
    ['https://x/news/123.html', '详情', 'content'],
    ['https://x/article/hello-world-2024.html', 'Hello World', 'unknown'],
    ['https://x/admin/', '管理后台', 'entry'],
    ['https://x/tenant/', '租户平台', 'entry'],
    ['https://x/static/js/app.js', 'x', 'asset'],
    ['https://x/api/v1/user', 'x', 'api'],
  ]
  for (const [url, title, expected] of pageCases) {
    const got = systemMod.classifyPageType({ url, title })
    check(got.pageType === expected, `分型 ${expected}：${url}`, `${got.pageType} (${got.reasons.join('+')})`)
  }

  const baseApp = { host: 'x', port: 443, scheme: 'https' }
  const judgeCases = [
    ['零项命中 → 不同系统', {}, {}, false],
    ['只命中前端 → 判不了', { templateHash: 't1' }, { templateHash: 't1' }, null],
    ['前端+认证 → 同一系统', { templateHash: 't1', loginUrl: '/login' }, { templateHash: 't1', loginUrl: '/login' }, true],
    ['三项全中 → 同一系统', { templateHash: 't1', loginUrl: '/login', tech: ['spring'] }, { templateHash: 't1', loginUrl: '/login', tech: ['spring'] }, true],
    ['只有 Server 相同 → 不同系统', { tech: [] }, { tech: [] }, false],
    ['匿名 cookie 不算认证域', { cookieNames: ['SERVERID', '_ga'] }, { cookieNames: ['SERVERID', '_ga'] }, false],
  ]
  for (const [label, left, right, expected] of judgeCases) {
    const verdict = systemMod.judgeSameSystem({ ...baseApp, ...left }, { ...baseApp, ...right })
    check(verdict.same === expected, label, JSON.stringify(verdict))
  }
  const high = systemMod.judgeSameSystem(
    { ...baseApp, templateHash: 't1', loginUrl: '/login', tech: ['spring'] },
    { ...baseApp, templateHash: 't1', loginUrl: '/login', tech: ['spring'] },
  )
  check(high.confidence === 'high', '三项全中置信度 high', high.confidence)
  const crossPort = systemMod.judgeSameSystem({ ...baseApp, port: 443, templateHash: 't' }, { ...baseApp, port: 8443, templateHash: 't' })
  check(crossPort.same === false, '端口不同是硬边界，不进入判定', JSON.stringify(crossPort))

  // 存储侧：记录 → 端点 + 系统，内容页只当证据
  const backend5 = new SqliteKvBackend(dbPath)
  const unit5 = await backend5.kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links'], hasGlobal: false })
  const store5 = new HunterStore(unit5)
  await store5.load()

  await store5.appendRecords('session-app', [
    { kind: 'app', asset: 'https://h.example.com:8080/tenant/', url: 'https://h.example.com:8080/tenant/', basePath: '/tenant/', title: '租户平台', signals: { templateHash: 'T-tenant', loginUrl: 'https://h.example.com:8080/tenant/login' } },
    { kind: 'app', asset: 'https://h.example.com:8080/admin/', url: 'https://h.example.com:8080/admin/', basePath: '/admin/', title: '管理后台', templateHash: 'T-admin' },
    { kind: 'url', asset: 'https://h.example.com:8080/tenant/news/1.html', url: 'https://h.example.com:8080/tenant/news/1.html', basePath: '/tenant/', pageType: 'content', title: '资讯详情' },
    { kind: 'url', asset: 'https://h.example.com:8080/tenant/news/2.html', url: 'https://h.example.com:8080/tenant/news/2.html', basePath: '/tenant/', pageType: 'content', title: '资讯详情' },
  ])

  const apps = store5.assetsOf('session-app').filter((row) => row.nodeType === 'app')
  // 根路径 web 资产（derived）也算一个：https://h:8080/ + /tenant/ + /admin/
  check(apps.length === 3, '根路径 web 资产 + 两个系统', String(apps.length))
  check(apps.filter((row) => row.derived === true).length === 1, '其中一个是端点派生的根路径资产')
  const tenantApp = apps.find((row) => row.basePath === '/tenant/')
  const adminApp = apps.find((row) => row.basePath === '/admin/')
  check(tenantApp !== undefined && adminApp !== undefined, '租户与后台两个系统都在')
  check(tenantApp.urls.length === 3, '入口 URL + 两条内容页都进证据列表', String(tenantApp.urls?.length))
  check(tenantApp.urls.filter((item) => item.pageType === 'content').length === 2, '内容页证据带页面分型')
  const endpoints = store5.assetsOf('session-app').filter((row) => row.nodeType !== 'app')
  check(endpoints.length === 1, '同一 host:port 只生成一个端点', String(endpoints.length))

  check(store5.pageAssets('session-app', { nodeType: 'app' }).total === 3, '按视角筛 Web 资产')
  check(store5.pageAssets('session-app', { nodeType: 'endpoint' }).total === 1, '按视角筛端点')
  check(store5.overviewAssets('session-app').byNodeType.app === 3, '概览按节点类型计数')

  // 命中两项：自动合并（不再问）
  await store5.appendRecords('session-app', [
    { kind: 'app', asset: 'https://h.example.com:8080/portal/', url: 'https://h.example.com:8080/portal/', basePath: '/portal/', title: '门户', signals: { templateHash: 'T-tenant', loginUrl: 'https://h.example.com:8080/tenant/login' } },
  ])
  const afterMerge = store5.assetsOf('session-app').filter((row) => row.nodeType === 'app')
  const portal = afterMerge.find((row) => row.basePath === '/portal/')
  check(portal?.mergeState === 'merged' && portal.mergedInto !== '', '命中两项自动合并：子节点指向主节点',
    JSON.stringify({ state: portal?.mergeState, into: portal?.mergedInto }))
  check(store5.questionsOf('session-app', 'open').length === 0, '确定性合并不会进问题池')

  // 命中一项：进问题池，不合并
  await store5.appendRecords('session-app', [
    { kind: 'app', asset: 'https://h2.example.com/app/', url: 'https://h2.example.com/app/', basePath: '/app/', title: 'A', templateHash: 'ONLY-FRONT' },
    { kind: 'app', asset: 'https://h2.example.com/other/', url: 'https://h2.example.com/other/', basePath: '/other/', title: 'B', templateHash: 'ONLY-FRONT' },
  ])
  const openQuestions = store5.questionsOf('session-app', 'open')
  check(openQuestions.length === 1, '只命中一项 → 进问题池', String(openQuestions.length))
  check(openQuestions[0].payload.a.includes('/app/') && openQuestions[0].payload.b.includes('/other/'),
    '问题里带上两个系统', JSON.stringify(openQuestions[0].payload))
  check(openQuestions[0].payload.signals.frontend === true && openQuestions[0].payload.signals.auth === false,
    '问题里带上命中项')

  // 重复登记同一对不会产生第二条问题
  await store5.appendRecords('session-app', [
    { kind: 'app', asset: 'https://h2.example.com/app/', url: 'https://h2.example.com/app/', basePath: '/app/', title: 'A', templateHash: 'ONLY-FRONT' },
  ])
  check(store5.questionsOf('session-app', 'open').length === 1, '同一对问题只记一次')

  // 裁决：合并
  const resolvedQuestion = await store5.resolveQuestion('session-app', openQuestions[0].id, 'merge', 'user')
  check(resolvedQuestion?.status === 'resolved' && resolvedQuestion.resolvedChoice === 'merge', '裁决合并：问题关闭')
  const appNodes = store5.assetsOf('session-app').filter((row) => row.nodeType === 'app')
  check(appNodes.some((row) => row.mergeState === 'merged'), '裁决合并：节点已合并')

  // 拆除
  const child = appNodes.find((row) => row.mergedInto !== '')
  const splitOk = await store5.splitApp('session-app', child.key)
  check(splitOk === true, '拆分成功')
  const afterSplit = store5.assetsOf('session-app').find((row) => row.key === child.key)
  check(afterSplit.mergeState === 'single' && afterSplit.mergedInto === '', '拆分后回到独立系统')

  // ── 两个视角的分面：主机按协议族、Web 按状态码 ────────────────────────
  await store5.appendRecords('session-facet', [
    { kind: 'port', asset: 'f1.example.com:22', service: 'ssh', version: '8.9' },
    { kind: 'port', asset: 'f2.example.com:3306', service: 'mysql', version: '8.0' },
    { kind: 'web', asset: 'f3.example.com:443', protocol: 'https', status: 200, title: '首页', tech: ['nginx'] },
    { kind: 'web', asset: 'f4.example.com:443', protocol: 'https', status: 403, title: '禁止访问' },
  ])

  const endpointCount = (facet) => store5.pageAssets('session-facet', { nodeType: 'endpoint', facet }).total
  const webCount = (facet) => store5.pageAssets('session-facet', { nodeType: 'app', facet }).total
  check(endpointCount('ssh') === 1, '主机分面 ssh', String(endpointCount('ssh')))
  check(endpointCount('sql') === 1, '主机分面 sql（只看服务名，不看端口）', String(endpointCount('sql')))
  check(endpointCount('http') === 2, '主机分面 http/https', String(endpointCount('http')))
  check(endpointCount('ftp') === 0, '没有 ftp 时该分面为 0')
  check(webCount('200') === 1 && webCount('403') === 1, 'Web 分面按状态码', `${webCount('200')}/${webCount('403')}`)
  check(webCount('404') === 0, '没有 404 时该分面为 0')

  const facetOverview = store5.overviewAssets('session-facet')
  check(facetOverview.byProtocol.ssh === 1 && facetOverview.byProtocol.sql === 1 && facetOverview.byProtocol.http === 2,
    '概览的协议族计数', JSON.stringify(facetOverview.byProtocol))
  check(facetOverview.byStatus['200'] === 1 && facetOverview.byStatus['403'] === 1,
    '概览的状态码计数', JSON.stringify(facetOverview.byStatus))

  // 观测到 https 的端点会自动长出一个根路径 Web 资产，且标 derived（不冒充系统）。
  const rootApps = store5.assetsOf('session-facet').filter((row) => row.nodeType === 'app')
  check(rootApps.length === 2, '两个 https 端点各有一个根路径 Web 资产', String(rootApps.length))
  check(rootApps.every((row) => row.derived === true && row.basePath === '/'), '根路径资产标了 derived')
  check(rootApps.some((row) => row.key === 'https://f3.example.com:443/' && row.status === 200),
    '根路径资产继承端点的状态码与标题')


  // ── 信息产物：写入、去重、正则命中、设置 ──────────────────────────────
  const art1 = await store5.appendArtifacts('session-art', [
    {
      kind: 'credential',
      title: '阿里云 AccessKey',
      content: 'accessKeyId=LTAI5tQwertyuiop1234 secret=xxx',
      source: { name: 'fofa', type: 'platform' },
      howFound: 'fofa 查询 body="LTAI"',
    },
    {
      kind: 'package',
      title: '/download/app-v2.3.zip',
      content: 'https://x.example.com/download/app-v2.3.zip (12.4 MB)',
      source: 'httpx',
      howFound: '目录扫描命中 /download/',
    },
  ])
  check(art1.added === 2, '产物：写入两条', String(art1.added))
  check(art1.hits >= 1, '产物：命中敏感规则', String(art1.hits))

  const art2 = await store5.appendArtifacts('session-art', [
    {
      kind: 'credential',
      title: '阿里云 AccessKey',
      content: 'accessKeyId=LTAI5tQwertyuiop1234 secret=xxx',
      source: { name: 'fofa', type: 'platform' },
      howFound: 'fofa 查询 body="LTAI"',
    },
  ])
  check(art2.duplicated === 1 && art2.added === 0, '产物：同一条重复只累加次数', JSON.stringify(art2))
  check(store5.artifactsOf('session-art').length === 2, '产物：库里仍是两条')

  const credRow = store5.artifactsOf('session-art').find((row) => row.kind === 'credential')
  check(credRow.count === 2, '产物：重复次数记在 count 上', String(credRow.count))
  check(credRow.hits.some((hit) => hit.ruleId === 'aliyun-ak'), '产物：阿里云 AK 规则命中', JSON.stringify(credRow.hits))
  check(credRow.severity === 'high', '产物：严重级由命中推导', credRow.severity)

  check(store5.pageArtifacts('session-art', { kind: 'package' }).total === 1, '产物：按类型过滤')
  check(store5.pageArtifacts('session-art', { q: 'LTAI' }).total === 1, '产物：按内容过滤')
  check(store5.pageArtifacts('session-art', { severity: 'high' }).total === 1, '产物：按严重级过滤')
  const artOverview = store5.overviewArtifacts('session-art')
  check(artOverview.total === 2 && artOverview.byKind.credential === 1 && artOverview.bySeverity.high === 1,
    '产物：概览按类型与严重级计数', JSON.stringify(artOverview))

  // 设置：默认播种、坏正则拒绝、未知 section 原样保留
  const seeded = store5.settings().sensitive
  check(Array.isArray(seeded?.rules) && seeded.rules.length === 10, '设置：默认播种 10 条规则', String(seeded?.rules?.length))
  check(seeded.rules.filter((rule) => rule.enabled === false).length === 2, '设置：手机号/身份证默认关闭')

  let badRegexRejected = false
  try {
    await store5.saveSettings('sensitive', { enabled: true, rules: [{ id: 'x', pattern: '([' }] })
  } catch {
    badRegexRejected = true
  }
  check(badRegexRejected, '设置：坏正则被拒绝')

  await store5.saveSettings('future-section', { foo: 'bar' })
  check(store5.settings()['future-section']?.foo === 'bar', '设置：未知 section 原样保留')

  // 规则改过之后重扫
  await store5.saveSettings('sensitive', { enabled: true, rules: [{ id: 'aliyun-ak', name: '阿里云', pattern: 'LTAI[0-9A-Za-z]{12,24}', flags: 'g', severity: 'high', enabled: false }] })
  const rescanned = await store5.rescanArtifacts('session-art')
  check(rescanned === 2, '产物：重扫覆盖两条', String(rescanned))
  check(store5.artifactsOf('session-art').every((row) => row.hits.length === 0), '产物：关掉的规则重扫后不再命中')

  // ── 计划 / 派活 / 覆盖度 ───────────────────────────────────────────────
  const planMod = await import('../plan.js')
  const coverageMod = await import('../coverage.js')

  const fresh = planMod.normalizePlan(undefined)
  check(fresh.stages.length === 8, '计划：骨架 8 个阶段', String(fresh.stages.length))
  const advanced = planMod.normalizePlan({ stages: [{ id: 'scope', state: 'done' }] })
  check(advanced.stages.length === 8 && advanced.stages[0].state === 'done', '计划：只传一个阶段不会丢掉其余骨架')
  check(planMod.planProgress(advanced).done === 1 && planMod.planProgress(advanced).current === 'dns',
    '计划：进度与当前阶段', JSON.stringify(planMod.planProgress(advanced)))
  const scoped = planMod.normalizePlan({ scope: { targets: [' a.com '], constraints: [{ type: 'deny', text: '不扫端口' }] } })
  check(scoped.scope.targets[0] === 'a.com' && scoped.scope.constraints[0].type === 'deny', '计划：范围与约束归一化')

  const cov = coverageMod.coverageOf([
    { key: 'a:443', host: 'a', ip: '1.2.3.4', port: 443, protocol: 'https', status: 200, title: 'x', tech: ['nginx'] },
    { key: 'b:22', host: 'b', port: 22, service: 'ssh' },
  ], [{ assetKey: 'b:22', sourceKind: 'artifact' }])
  check(cov.total === 2 && cov.byLayer.port === 2 && cov.byLayer.dns === 1, '覆盖度：分层计数', JSON.stringify(cov.byLayer))
  check(cov.uncovered.length === 2 && cov.uncovered[0].missing.length >= cov.uncovered[1].missing.length,
    '覆盖度：未覆盖按缺口降序')

  const savedPlan = await store5.savePlan('session-plan', { scope: { targets: ['x.example.com'], constraints: [] } })
  check(savedPlan.scope.targets[0] === 'x.example.com', '计划：落库并读回')
  check(store5.plan('session-plan').stages.length === 8, '计划：读回仍是 8 个阶段')
  const staged = await store5.savePlan('session-plan', { stages: [{ id: 'scope', state: 'done' }] })
  check(staged.stages.find((stage) => stage.id === 'scope').state === 'done', '计划：阶段可推进')

  const first = await store5.startTask('session-task', { target: 'x.example.com', layer: 'ports', tool: 'naabu' })
  check(first.duplicate === false && first.task.state === 'running', '派活：首次登记')
  const again = await store5.startTask('session-task', { target: 'x.example.com', layer: 'ports', tool: 'naabu' })
  check(again.duplicate === true && again.task.id === first.task.id, '派活：同一目标同层同工具不重复派')
  const other = await store5.startTask('session-task', { target: 'x.example.com', layer: 'web', tool: 'httpx' })
  check(other.duplicate === false, '派活：换一层可以再派')
  const finished = await store5.finishTask('session-task', first.task.id, { state: 'failed', error: '超时' })
  check(finished.state === 'failed' && finished.error === '超时', '派活：失败也留痕（负结果）')
  const afterFail = await store5.startTask('session-task', { target: 'x.example.com', layer: 'ports', tool: 'naabu' })
  check(afterFail.duplicate === true, '派活：失败过的也不重复派（除非换工具）')

  await store5.link('session-task', 'x.example.com:443', 'artifact')
  const taskCoverage = store5.coverage('session-task')
  check(taskCoverage.total >= 0, '覆盖度：从存储取到结构', JSON.stringify({ total: taskCoverage.total }))


  await store5.unit.close()

  await store5.unit.close()
  await backend5.close()


  // ── 1e. 基础补全：DNS / 证书 / 响应头 ──────────────────────────────────
  console.log('\n[1e] 基础补全（fetch）')
  const fetchMod = await import('../fetch.js')
  check(fetchMod.blockedHostReason('localhost') !== '', '补全：拒绝回环地址')
  check(fetchMod.blockedHostReason('169.254.169.254') !== '', '补全：拒绝云元数据地址')
  check(fetchMod.blockedHostReason('example.com') === '', '补全：普通域名放行')
  const certFields = fetchMod.certToFields({
    subject: { CN: 'a.example.com' },
    issuer: { O: 'Encrypt', CN: 'R3' },
    subjectaltname: 'DNS:a.example.com, DNS:www.a.example.com',
    valid_to: 'Jan  1 00:00:00 2027 GMT',
  })
  check(certFields.subject === 'a.example.com' && certFields.san.length === 2, '补全：证书字段归一化', JSON.stringify(certFields))
  check(certFields.issuer === 'Encrypt / R3', '补全：签发者拼成可读形式')
  check(fetchMod.extractTitle('<html><title> 登录 后台 </title></html>') === '登录 后台', '补全：取页面标题')
  check(fetchMod.extractText('<div>a<script>x</script><b>正文</b></div>') === 'a 正文', '补全：去标签取正文')
  check(fetchMod.formatHeaders({ server: 'nginx', 'set-cookie': ['a=1', 'b=2'] }).includes('server: nginx'),
    '补全：响应头拍平成原文')

  // 本地起一个 HTTP 服务验证真实探测链路（allowPrivate=true 仅测试用）。
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-test': 'ok', server: 'smoke' })
    res.end('<html><head><title>补全测试</title></head><body><p>hello 世界</p></body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const probed = await fetchMod.probeHttp({ host: '127.0.0.1', port, scheme: 'http', allowPrivate: true })
  check(probed.ok === true && probed.status === 200, '补全：本地探测拿到 200', JSON.stringify({ ok: probed.ok, status: probed.status }))
  check(probed.title === '补全测试', '补全：探测拿到标题', probed.title)
  check(probed.headers.includes('x-test: ok'), '补全：探测拿到响应头原文')
  check(probed.body.includes('hello 世界'), '补全：探测拿到正文摘要')
  await new Promise((resolve) => server.close(resolve))

  const blockedProbe = await fetchMod.probeHttp({ host: '127.0.0.1', port, scheme: 'http' })
  check(blockedProbe.ok === false && blockedProbe.error !== '', '补全：默认拒绝回环探测', blockedProbe.error)


  // ── 1c. 技能包：zip 解析、路径安全、落地与回收 ──────────────────────────
  console.log('\n[1c] 技能包（zip）')
  const pack = await import('../skillpack.js')
  const rejects = async (run, needle) => {
    try {
      await run()
      return `没有抛错（期望包含「${needle}」）`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes(needle) ? '' : `错误信息不含「${needle}」：${message}`
    }
  }

  const zipOk = buildZip([
    { name: 'SKILL.md', data: '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文第一行\n' },
    { name: 'refs/notes.txt', data: 'hello', store: true },
  ])
  const parsedZip = pack.readZip(zipOk)
  check(parsedZip.files.length === 2, 'zip 解析：文件数正确', String(parsedZip.files.length))
  const skillMd = parsedZip.files.find((file) => file.path === 'SKILL.md')
  check(skillMd !== undefined && skillMd.data.toString('utf8').includes('演示技能'), 'zip 解析：内容正确')
  check(parsedZip.files.find((file) => file.path === 'refs/notes.txt')?.data.toString('utf8') === 'hello',
    'zip 解析：store 方法（不压缩）也读得出来')
  const parsedMeta = pack.validateSkill(skillMd.data.toString('utf8'))
  check(parsedMeta.name === 'demo-skill' && parsedMeta.description === '演示技能'
    && parsedMeta.body.includes('正文第一行'), 'SKILL.md：frontmatter 与正文分开')

  check(await rejects(() => pack.readZip(buildZip([{ name: '../evil.txt', data: 'x' }])), '向上跳') === '',
    'zip slip：.. 被拒')
  check(await rejects(() => pack.readZip(buildZip([{ name: '/etc/passwd', data: 'x' }])), '绝对路径') === '',
    'zip slip：绝对路径被拒')
  check(await rejects(() => pack.readZip(buildZip([{ name: 'C:/win.ini', data: 'x' }])), '盘符') === '',
    'zip slip：盘符路径被拒')
  check(await rejects(() => pack.readZip(Buffer.from('not a zip at all')), 'zip') === '',
    '非 zip 被拒')
  check(await rejects(() => pack.validateSkill('---\nname: Bad Name\ndescription: x\n---\nbody\n'), '不合法') === '',
    '技能名非法被拒（kebab-case）')
  check(await rejects(() => pack.validateSkill('---\nname: ok\ndescription: x\n---\n'), '正文') === '',
    '没有正文的 SKILL.md 被拒')

  const skillsRoot = join(tempRoot, 'infohunter', 'skills')
  const installed = await pack.installSkillZip(zipOk, skillsRoot, 'row-1')
  check(installed.name === 'demo-skill' && installed.files === 2, '落盘：返回技能元数据',
    JSON.stringify(installed))
  const fromDisk = await pack.readSkillFromDir(join(skillsRoot, 'row-1'))
  check(fromDisk?.name === 'demo-skill' && fromDisk.content.includes('正文第一行'), '落盘：能从磁盘读回技能')
  check(await pack.readSkillFromDir(join(skillsRoot, 'row-missing')) === undefined, '落盘：目录不存在时返回 undefined')

  // 覆盖：同一行重传必须换掉内容，而不是叠加。
  const zipV2 = buildZip([{ name: 'SKILL.md', data: '---\nname: demo-skill\ndescription: 第二版\n---\n\n新版正文\n' }])
  const reinstalled = await pack.installSkillZip(zipV2, skillsRoot, 'row-1')
  check(reinstalled.description === '第二版', '重传覆盖：描述已更新')
  const afterOverwrite = await pack.readSkillFromDir(join(skillsRoot, 'row-1'))
  check(afterOverwrite?.content.includes('新版正文'), '重传覆盖：正文已替换')

  // 没有 SKILL.md 的包不能落地，也不能把旧内容弄坏。
  const broken = await rejects(() => pack.installSkillZip(buildZip([{ name: 'readme.md', data: 'x' }]), skillsRoot, 'row-1'), 'SKILL.md')
  check(broken === '', '缺 SKILL.md 的包被拒')
  check((await pack.readSkillFromDir(join(skillsRoot, 'row-1')))?.content.includes('新版正文'),
    '被拒的包不会破坏已经落地的技能')

  await pack.installSkillZip(zipV2, skillsRoot, 'row-2')
  const pruned = await pack.pruneSkillDirs(skillsRoot, new Set(['row-2']))
  check(pruned.includes('row-1') && await pack.readSkillFromDir(join(skillsRoot, 'row-1')) === undefined,
    '回收：没有行引用的目录被删掉', pruned.join(','))
  check(await pack.readSkillFromDir(join(skillsRoot, 'row-2')) !== undefined, '回收：仍在引用的目录保留')

  // 技能行：类型要能往返，元数据只是缓存（磁盘才是真相）。
  const savedSkill = normalizeEntries([
    { id: 's-1', type: 'skill', name: '演示', enabled: true, note: '', skillName: 'demo-skill', description: '演示技能', files: 2, bytes: 42, uploadedAt: '2026-01-01T00:00:00.000Z' },
  ])[0]
  check(savedSkill.type === 'skill' && savedSkill.skillName === 'demo-skill' && savedSkill.files === 2,
    '配置：技能行往返正确', JSON.stringify(savedSkill))
  check(savedSkill.inputs.length === 0 && savedSkill.outputs.length === 0, '配置：技能行不带形态')
  check(normalizeEntries([{ id: 's-2', type: 'skill' }]).length === 1,
    '配置：刚建的空技能行不会被当成空行丢掉')

  // ── 1d. MCP：协议层与两种传输 ───────────────────────────────────────────
  console.log('\n[1d] MCP 客户端')
  const mcpMod = await import('../mcp.js')
  check(mcpMod.normalizeServerName('My Server!') === 'my-server', 'MCP：server 名规范化',
    mcpMod.normalizeServerName('My Server!'))
  check(mcpMod.normalizeServerName('') === 'server', 'MCP：空名字有兜底')
  const parsedMap = mcpMod.parseKeyValueLines('A=1\n# 注释\nB=x=y\n坏行')
  check(parsedMap.A === '1' && parsedMap.B === 'x=y' && Object.keys(parsedMap).length === 2,
    'MCP：KEY=VALUE 解析（忽略注释、值里的 = 保留）', JSON.stringify(parsedMap))
  check(mcpMod.renderToolResult({ content: [{ type: 'text', text: 'hi' }] }).text === 'hi',
    'MCP：文本结果原样返回')
  check(mcpMod.renderToolResult({ content: [] }).text.includes('空结果'), 'MCP：空结果有说明')
  check(mcpMod.renderToolResult({ content: [{ type: 'text', text: 'x' }], isError: true }).isError === true,
    'MCP：isError 透传')

  // stdio：真的 spawn 一个子进程，走完整握手。
  const stdioConn = await mcpMod.connectMcp({
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', FAKE_MCP_STDIO],
  })
  check(stdioConn.tools.length === 1 && stdioConn.tools[0].name === 'ping',
    'MCP stdio：握手后拿到 tools/list', JSON.stringify(stdioConn.tools.map((tool) => tool.name)))
  check(stdioConn.tools[0].inputSchema?.required?.[0] === 'x', 'MCP stdio：inputSchema 原样透传')
  const stdioCall = await stdioConn.call('ping', { x: 'hello' })
  check(mcpMod.renderToolResult(stdioCall).text.includes('pong:{"x":"hello"}'),
    'MCP stdio：tools/call 往返正确', mcpMod.renderToolResult(stdioCall).text)
  await stdioConn.close()
  check(await rejects(() => stdioConn.call('ping', {}), '关闭') === '', 'MCP stdio：关闭后调用明确报错')

  // http：起一个只认 JSON-RPC 的本地服务。
  const httpServer = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end('{}')
        return
      }
      const reply = (result) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
        res.end(body)
      }
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'http-fake' } })
      if (message.method === 'tools/list') return reply({ tools: [{ name: 'echo', description: 'http 回声', inputSchema: { type: 'object', properties: {} } }] })
      if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: `echo:${message.params?.arguments?.q ?? ''}` }] })
      // 通知没有 id，按 SSE 规范可以 202。
      res.writeHead(202).end()
    })
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const httpPort = httpServer.address().port
  try {
    const httpConn = await mcpMod.connectMcp({
      transport: 'http',
      url: `http://127.0.0.1:${httpPort}/mcp`,
      headers: { 'x-test': '1' },
    })
    check(httpConn.tools.length === 1 && httpConn.tools[0].name === 'echo',
      'MCP http：握手后拿到工具列表')
    const httpCall = await httpConn.call('echo', { q: 'ok' })
    check(mcpMod.renderToolResult(httpCall).text === 'echo:ok', 'MCP http：tools/call 往返正确')
    await httpConn.close()
  } finally {
    await new Promise((resolve) => httpServer.close(resolve))
  }

  // 配置行：stdio / http 两种形状都要能往返，多行文本要在宿主侧解析成数组与键值对。
  const stdioRow = normalizeEntries([{
    id: 'm1', type: 'mcp', name: '本地 server', enabled: true, note: '',
    transport: 'stdio', command: 'npx', args: '-y\npkg\n--flag', env: 'A=1\nB=2', cwd: '/tmp',
  }])[0]
  check(stdioRow.transport === 'stdio' && stdioRow.args.length === 3 && stdioRow.args[2] === '--flag',
    '配置：stdio 行的 args 按行解析', JSON.stringify(stdioRow.args))
  check(stdioRow.env.A === '1' && stdioRow.env.B === '2', '配置：env 按行解析成键值对')
  check(stdioRow.url === '' && Object.keys(stdioRow.headers).length === 0,
    '配置：stdio 行不带 http 字段')
  const httpRow = normalizeEntries([{
    id: 'm2', type: 'mcp', name: '远程', enabled: true, note: '',
    transport: 'http', url: 'https://example.com/mcp', headers: 'Authorization=Bearer x',
  }])[0]
  check(httpRow.transport === 'http' && httpRow.url === 'https://example.com/mcp'
    && httpRow.headers.Authorization === 'Bearer x', '配置：http 行的 url 与 headers 往返')
  check(httpRow.command === '' && httpRow.args.length === 0, '配置：http 行不带 stdio 字段')
  check(normalizeEntries([{ id: 'm3', type: 'mcp', name: '只有名字', enabled: true }]).length === 0,
    '配置：空 MCP 行（既无 command 也无 url 且没名字）被丢弃')

  // ── 2. Host 半：路由 ────────────────────────────────────────────────────
  console.log('\n[2] Host 半 apply + HTTP 端点')
  const host = await import('../index.js')
  const hostFake = fakeCtx({ storage: { backend: { register: () => () => {} } } })
  const routeBox = {}
  hostFake.ctx.storage = { backend: { register: (name, instance) => { routeBox.backendName = name; routeBox.backend = instance; return () => {} } } }
  // 刻意**不**提供 webServer：真实激活顺序里它可能还没注册。

  // 显式给一个临时库路径：双重保险，既不读真实配置也不写真实配置。
  host.apply(hostFake.ctx, { database: join(tempRoot, 'host.db') })
  check(routeBox.backendName === 'infohunter-sqlite', 'apply 注册了自己的后端名', routeBox.backendName)
  check(routeBox.route === undefined, 'webServer 还没就绪时不注册路由（也不放弃）', JSON.stringify(routeBox.route?.path))

  // 模拟 webServer 晚到 —— 这就是现场「面板 API 404、数据库却正常建好」的根因。
  hostFake.ctx._deliver('webServer', { register: (route) => { routeBox.route = route; return () => {} } })
  check(routeBox.route?.kind === 'prefix' && routeBox.route.path === '/infohunter', 'webServer 晚到也能挂上路由', JSON.stringify(routeBox.route?.path))

  // store 是异步就绪的（后端 open → loadAll → provide），所以断言要等它。
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(hostFake.provided.has('infohunterStore'), 'apply 通过 provide 暴露 store')
  const liveStore = hostFake.provided.get('infohunterStore')
  check(liveStore !== undefined && typeof liveStore.pageAssets === 'function', 'store 已就绪且形状正确')

  const handler = routeBox.route.handler
  const getConfig = await callRoute(handler, { url: '/infohunter/config' })
  check(getConfig.status === 200 && getConfig.headers['content-type'].includes('application/json'), 'GET /config 返回 JSON', String(getConfig.status))

  const postConfig = await callRoute(handler, {
    method: 'POST',
    url: '/infohunter/config',
    body: { entries: [{ id: 'x', type: 'tool', purpose: 'web', name: 'httpx', path: '/bin/httpx', description: '探活', enabled: true, note: '' }] },
  })
  check(postConfig.status === 200 && postConfig.json.config.entries.length === 1, 'POST /config 保存成功', JSON.stringify(postConfig.json?.config?.entries?.length))

  const noSession = await callRoute(handler, { url: '/infohunter/assets' })
  check(noSession.status === 400, 'GET /assets 缺 sessionId 返回 400', String(noSession.status))

  const assetsPage = await callRoute(handler, { url: '/infohunter/assets?sessionId=s1' })
  check(assetsPage.status === 200 && assetsPage.json.page.total === 0, 'GET /assets 空会话返回 0 条')

  const rev = await callRoute(handler, { url: '/infohunter/rev?sessionId=s1' })
  check(rev.status === 200 && typeof rev.json.rev.assets === 'number', 'GET /rev 返回令牌')

  const version = await callRoute(handler, { url: '/infohunter/version' })
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  check(version.status === 200 && version.json?.version === manifest.version,
    'GET /version 返回包内清单的版本（面板标签栏显示它）', JSON.stringify(version.json))
  check(version.json?.name === manifest.name, 'GET /version 也返回包名', String(version.json?.name))
  check(version.json?.onDisk === manifest.version,
    'GET /version 的 onDisk 等于磁盘上的版本（与已加载版本不同即「待重启」）', JSON.stringify(version.json?.onDisk))

  const unknown = await callRoute(handler, { url: '/infohunter/nope' })
  check(unknown.status === 404, '未知端点返回 404', String(unknown.status))

  // 资产与采集记录都不允许删除：这几个端点必须已经不存在，否则面板一句话就能改掉证据。
  for (const gone of ['/infohunter/assets/drop', '/infohunter/assets/clear', '/infohunter/records/drop', '/infohunter/records/clear']) {
    const res = await callRoute(handler, { method: 'POST', url: `${gone}?sessionId=s1`, body: {} })
    check(res.status === 404, `删除端点 ${gone} 已移除`, String(res.status))
  }

  // 技能上传：原始二进制上传 → 解包落地；保存配置时按引用回收。
  const uploadZip = buildZip([
    { name: 'SKILL.md', data: '---\nname: routed-skill\ndescription: 走路由上传的技能\n---\n\n正文\n' },
    { name: 'refs/a.txt', data: 'a', store: true },
  ])
  const uploadRes = await callRoute(handler, { method: 'POST', url: '/infohunter/skills/upload?id=row-9', raw: uploadZip })
  check(uploadRes.status === 200 && uploadRes.json?.name === 'routed-skill',
    'POST /skills/upload：解包并回技能名', uploadRes.text.slice(0, 100))
  check(await pack.readSkillFromDir(join(tempRoot, 'infohunter', 'skills', 'row-9')) !== undefined,
    'POST /skills/upload：已落到 <skills>/<行 id>')
  const badId = await callRoute(handler, { method: 'POST', url: '/infohunter/skills/upload?id=..%2Fevil', raw: uploadZip })
  check(badId.status >= 400, 'POST /skills/upload：非法行 id 被拒（目录名由我们决定）', String(badId.status))

  await callRoute(handler, {
    method: 'POST',
    url: '/infohunter/config',
    body: { entries: [{ id: 'row-9', type: 'skill', name: '走路由', enabled: true, note: '', skillName: 'routed-skill', description: 'd', files: 2, bytes: 1 }] },
  })
  check(await pack.readSkillFromDir(join(tempRoot, 'infohunter', 'skills', 'row-9')) !== undefined,
    '保存配置：仍被引用的技能目录保留')
  await callRoute(handler, { method: 'POST', url: '/infohunter/config', body: { entries: [] } })
  check(await pack.readSkillFromDir(join(tempRoot, 'infohunter', 'skills', 'row-9')) === undefined,
    '保存配置：删掉技能行后目录被回收')

  // 最近语句：全局（不带 sessionId），可删可清；非法语句不落库。
  const q1 = await callRoute(handler, { method: 'POST', url: '/infohunter/queries', body: { q: 'status=200' } })
  check(q1.status === 200 && q1.json?.queries?.length === 1, 'POST /queries 记录一条',
    JSON.stringify(q1.json?.queries))
  const q2 = await callRoute(handler, { method: 'POST', url: '/infohunter/queries', body: { q: 'STATUS=200' } })
  check(q2.json?.queries?.[0]?.count === 2, 'POST /queries 重复使用累加次数（大小写不敏感）')
  const qBad = await callRoute(handler, { method: 'POST', url: '/infohunter/queries', body: { q: 'port=' } })
  check(qBad.json?.queries?.length === 1, 'POST /queries 语法错误不记录')
  const qList = await callRoute(handler, { url: '/infohunter/queries' })
  check(qList.json?.queries?.length === 1, 'GET /queries 返回列表')
  const qDrop = await callRoute(handler, { method: 'POST', url: '/infohunter/queries/drop', body: { q: 'status=200' } })
  check(qDrop.json?.queries?.length === 0, 'POST /queries/drop 删掉一条')
  await callRoute(handler, { method: 'POST', url: '/infohunter/queries', body: { q: 'title!=""' } })
  const qClear = await callRoute(handler, { method: 'POST', url: '/infohunter/queries/clear', body: {} })
  check(qClear.json?.queries?.length === 0, 'POST /queries/clear 清空')

  // 关联：缺参数 400、不存在的 key 返回空结构
  const relNoSession = await callRoute(handler, { url: '/infohunter/assets/relations?key=a:1' })
  check(relNoSession.status === 400, 'GET /assets/relations 缺 sessionId 返回 400')
  const relNoKey = await callRoute(handler, { url: '/infohunter/assets/relations?sessionId=s1' })
  check(relNoKey.status === 400, 'GET /assets/relations 缺 key 返回 400')
  const relUnknown = await callRoute(handler, { url: '/infohunter/assets/relations?sessionId=s1&key=ghost:1' })
  check(relUnknown.status === 200 && relUnknown.json?.relations?.found === false,
    'GET /assets/relations 不存在的 key 返回 found=false')

  // 问题池与系统合并/拆分：判定不了的系统对走这里裁决。
  await liveStore.appendRecords('s-app', [
    { kind: 'app', asset: 'https://r.example.com/a/', url: 'https://r.example.com/a/', basePath: '/a/', title: 'A', signals: { templateHash: 'R-1' } },
    { kind: 'app', asset: 'https://r.example.com/b/', url: 'https://r.example.com/b/', basePath: '/b/', title: 'B', signals: { templateHash: 'R-1' } },
  ])
  const questionsRes = await callRoute(handler, { url: '/infohunter/questions?sessionId=s-app' })
  check(questionsRes.status === 200 && questionsRes.json?.questions?.length === 1, 'GET /questions 返回待确认问题',
    JSON.stringify(questionsRes.json?.questions?.length))
  const questionId = questionsRes.json.questions[0].id
  const resolvedFilter = await callRoute(handler, { url: '/infohunter/questions?sessionId=s-app&status=resolved' })
  check(resolvedFilter.json?.questions?.length === 0, 'GET /questions 可按状态过滤')

  const badChoice = await callRoute(handler, {
    method: 'POST', url: '/infohunter/questions/resolve?sessionId=s-app', body: { id: questionId, choice: 'nope' },
  })
  check(badChoice.status === 404, 'POST /questions/resolve 非法 choice 返回 404')
  const keptQuestion = await callRoute(handler, {
    method: 'POST', url: '/infohunter/questions/resolve?sessionId=s-app', body: { id: questionId, choice: 'keep' },
  })
  check(keptQuestion.status === 200 && keptQuestion.json?.question?.status === 'resolved', 'POST /questions/resolve 保持独立')

  const mergeNoChild = await callRoute(handler, {
    method: 'POST', url: '/infohunter/apps/merge?sessionId=s-app', body: { parent: 'https://r.example.com/a/' },
  })
  check(mergeNoChild.status === 400, 'POST /apps/merge 缺 child 返回 400')
  const mergeRes = await callRoute(handler, {
    method: 'POST', url: '/infohunter/apps/merge?sessionId=s-app',
    body: { parent: 'https://r.example.com/a/', child: 'https://r.example.com/b/' },
  })
  check(mergeRes.status === 200 && mergeRes.json?.app?.mergeState === 'merged', 'POST /apps/merge 合并两个系统')
  const splitRes = await callRoute(handler, {
    method: 'POST', url: '/infohunter/apps/split?sessionId=s-app', body: { key: 'https://r.example.com/b/' },
  })
  check(splitRes.json?.ok === true, 'POST /apps/split 拆回独立系统')

  // 信息产物与设置
  await liveStore.appendArtifacts('s-app', [
    { kind: 'leak', title: '公开的 .git/config', content: 'url = https://git.example.com/x.git', source: 'httpx', howFound: '目录扫描' },
  ])
  const artifactsRes = await callRoute(handler, { url: '/infohunter/artifacts?sessionId=s-app' })
  check(artifactsRes.status === 200 && artifactsRes.json?.page?.total === 1, 'GET /artifacts 返回产物',
    String(artifactsRes.json?.page?.total))
  check(artifactsRes.json?.overview?.byKind?.leak === 1, 'GET /artifacts 带概览')
  const rescanRes = await callRoute(handler, { method: 'POST', url: '/infohunter/artifacts/rescan?sessionId=s-app', body: {} })
  check(rescanRes.json?.updated === 1, 'POST /artifacts/rescan 重扫')
  const settingsRes = await callRoute(handler, { url: '/infohunter/settings' })
  check(settingsRes.status === 200 && Array.isArray(settingsRes.json?.settings?.sensitive?.rules), 'GET /settings 返回规则')
  const saveSettingsRes = await callRoute(handler, {
    method: 'POST', url: '/infohunter/settings',
    body: { section: 'sensitive', value: { enabled: true, rules: [{ id: 't1', name: 'T', pattern: 'AKIA[0-9A-Z]{16}', flags: 'g', severity: 'high', enabled: true }] } },
  })
  check(saveSettingsRes.status === 200 && saveSettingsRes.json?.settings?.sensitive?.rules?.length === 1, 'POST /settings 保存规则')
  const badSettings = await callRoute(handler, {
    method: 'POST', url: '/infohunter/settings',
    body: { section: 'sensitive', value: { enabled: true, rules: [{ id: 'bad', pattern: '([' }] } },
  })
  check(badSettings.status === 400, 'POST /settings 坏正则返回 400')

  const appView = await callRoute(handler, { url: '/infohunter/assets?sessionId=s-app&nodeType=app' })
  check(appView.json?.page?.total === 3, 'GET /assets?nodeType=app 只返回 Web 资产', String(appView.json?.page?.total))
  const endpointView = await callRoute(handler, { url: '/infohunter/assets?sessionId=s-app&nodeType=endpoint' })
  check(endpointView.json?.page?.total === 1, 'GET /assets?nodeType=endpoint 只返回端点', String(endpointView.json?.page?.total))
  check(appView.json?.overview?.byNodeType?.app === 3, '概览带 byNodeType.app')

  await hostFake.ctx._disposeAll()

  // ── 3. preset 半：工具定义 ──────────────────────────────────────────────
  console.log('\n[3] preset 半 apply + 工具定义')
  const preset = await import('../preset.js')
  const presetFake = fakeCtx({
    tools: undefined,
    infohunterStore: {
      enabledEntries: (type) => store.enabled ? [] : [],
      page: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
      addResults: async () => [],
    },
  })
  // 用真实 store 形状的桩，覆盖两条读路径与一条写路径。
  // 注意：工具在 apply 时就捕获了 store 引用，所以后面只能改**这个对象**的状态，
  // 重写 ctx.get 不会影响已注册的工具。
  const TOOL_ROW = {
    id: 't', type: 'tool', purpose: 'subdomain', name: 'subfinder', path: '/bin/sub', description: '用法说明',
    enabled: true, note: '', inputs: ['main_domain', 'domain'], outputs: ['subdomain', 'other'], outputsOther: '被动源命中',
  }
  // 真正会被执行的那一行：指向 node 自身，用 `-e` 跑一小段脚本 —— 确定性强、不碰网络、不碰用户文件。
  const EXEC_ROW = { id: 'r', type: 'tool', purpose: 'other', name: 'runner', path: process.execPath, description: '测试用', enabled: true, note: '' }
  const MAPPING_ROW = {
    id: 'm',
    type: 'mapping',
    capabilities: ['subdomain', 'port', 'web', 'fingerprint', 'cert'],
    name: 'FOFA',
    baseUrl: 'https://example.invalid',
    key: 'K',
    apiDoc: 'doc',
    remark: '',
    enabled: true,
    note: '',
    // 空间测绘是综合查询：吃主域名/子域/IP，吐一大堆。
    inputs: ['main_domain', 'subdomain', 'ip'],
    outputs: ['subdomain', 'port', 'endpoint', 'tech', 'cert'],
  }
  const SKILL_ROW = {
    id: 'sk', type: 'skill', name: '上传技能', enabled: true, note: '',
    skillName: 'uploaded-skill', description: '用户传上来的技能', files: 2, bytes: 64, uploadedAt: '',
  }
  const MCP_ROW = {
    id: 'mc', type: 'mcp', name: '本地 MCP', enabled: true, note: '',
    transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: {}, cwd: '',
  }
  const stubStore = {
    empty: false,
    enabledEntries(type) {
      if (this.empty) return []
      if (type === 'tool') return [TOOL_ROW, EXEC_ROW]
      if (type === 'mapping') return [MAPPING_ROW]
      if (type === 'skill') return [SKILL_ROW]
      if (type === 'mcp') return [MCP_ROW]
      return [TOOL_ROW, EXEC_ROW, MAPPING_ROW, SKILL_ROW, MCP_ROW]
    },
    assetsOf: () => [],
    appendRecords: async (sessionId, rows) => {
      const written = rows.map((row, index) => ({ id: `rec-${index}`, sessionId, ...row, createdAt: Date.now() }))
      // 桩：按端点去重，模拟真实 store 的"记录 + 汇总"计数。
      const keys = new Set()
      let added = 0
      let merged = 0
      for (const row of rows) {
        const asset = assets.normalizeAsset({ ...row, endpoint: row.asset })
        if (asset === undefined) continue
        const key = assets.assetKey(asset)
        if (keys.has(key)) merged += 1
        else { keys.add(key); added += 1 }
      }
      return { written, added, merged }
    },
    upsertAssets: async (sessionId, rows) => {
      // 桩：按端点去重，模拟真实 store 的合并计数。
      const keys = new Set()
      const written = []
      let added = 0
      for (const row of rows) {
        const asset = assets.normalizeAsset(row)
        if (asset === undefined) continue
        const key = assets.assetKey(asset)
        if (!keys.has(key)) { added += 1; keys.add(key) }
        written.push({ key, sessionId, ...asset })
      }
      return { written, added, merged: written.length - added }
    },
    pageAssets: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
    overviewAssets: () => ({ total: 0, byCategory: { web: 0, service: 0, host: 0 }, bySource: {}, updatedAt: 0 }),
    rev: () => ({ config: 0, assets: 0 }),
    /** 技能注册读的是配置；这里给一个可改的 entries。 */
    entries: [],
    config() { return { version: 1, updatedAt: '', entries: this.entries } },
    onConfigChange(listener) { return () => {} },
  }
  presetFake.ctx.get = (key) => {
    if (key === 'infohunterStore') return stubStore
    if (key === 'skills') return presetFake.ctx.skills
    return undefined
  }
  preset.apply(presetFake.ctx)

  const names = presetFake.tools.map((tool) => tool.name)
  const EXPECTED_TOOLS = [
    'expose_config', 'expose_mapping_call', 'expose_record', 'expose_artifact',
    'expose_plan', 'expose_state', 'expose_task', 'expose_enrich', 'expose_asset_query',
    'expose_question_list', 'expose_question_resolve', 'expose_tool_run', 'expose_run_query',
  ]
  check(names.length === EXPECTED_TOOLS.length, `注册了 ${EXPECTED_TOOLS.length} 个工具`, names.join(','))
  for (const expected of EXPECTED_TOOLS) {
    check(names.includes(expected), `工具 ${expected} 已注册`)
  }

  // 激活顺序无关：Host 半晚到时，工具也必须最终注册上。
  // 现场症状：重启 DSH 后在面板加工具再重启，会话里 `unknown tool "expose_tool_run"` ——
  // 那次是 `ctx.get` 取一次就放弃，六个工具静默全不注册。
  const lateFake = fakeCtx({ tools: undefined })
  preset.apply(lateFake.ctx)
  check(lateFake.tools.length === 0, 'store 未就绪时不注册工具（不抛错、不把预设弄坏）', String(lateFake.tools.length))
  check(lateFake.sections.length === 1, 'store 未就绪时章程仍然注册（不连坐）', String(lateFake.sections.length))
  lateFake.ctx._deliver('infohunterStore', stubStore)
  check(lateFake.tools.length === EXPECTED_TOOLS.length, 'store 晚到后工具自动注册上', lateFake.tools.map((tool) => tool.name).join(','))

  const problems = []
  for (const tool of presetFake.tools) {
    if (typeof tool.description !== 'string' || tool.description === '') problems.push(`${tool.name}: 缺 description`)
    if (tool.parameters?.type !== 'object') problems.push(`${tool.name}: parameters 不是 object schema`)
    if (tool.parameters?.properties === undefined) problems.push(`${tool.name}: parameters 缺 properties`)
    if (tool.output?.schema === undefined) problems.push(`${tool.name}: 缺 output.schema`)
    if (typeof tool.output?.render !== 'function') problems.push(`${tool.name}: output.render 不是函数`)
    if (typeof tool.execute !== 'function') problems.push(`${tool.name}: 缺 execute`)
    const blocks = tool.output?.render({}, { text: 'hello' })
    if (!Array.isArray(blocks) || blocks[0]?.type !== 'text' || blocks[0].text !== 'hello') problems.push(`${tool.name}: render 没产出 text 块`)
  }
  check(problems.length === 0, '每个工具的定义形状正确', problems.join('；'))

  // 工具描述里不能留过时口径：这几句曾经和章程/实际能力互相打架。
  const byName = (wanted) => presetFake.tools.find((tool) => tool.name === wanted).description
  check(!byName('expose_config').includes('没有任意 URL 抓取') && !byName('expose_config').includes('没有 shell'),
    '配置工具不再断言"没有 shell / 没有任意 URL 抓取"（那是能力描述，由身份说明负责）')
  check(byName('expose_config').includes('needs / produces'), '配置工具仍在教 needs / produces 反查')
  check(byName('expose_record').includes('suspect') && byName('expose_record').includes('infer'),
    '记录工具的说明里写了三类判定（否则模型会把"可疑"当成"不该写"）')
  check(!byName('expose_run_query').includes('本会话没有 shell'),
    '"没有 shell" 只在执行工具里说一次')
  check(byName('expose_mapping_call').includes('条件关系'), '测绘工具要求先看条件关系够不够')

  // 参数级描述：这几条曾经和章程打架（"务必写 http/https" 会把 HTTPS 硬塞给任何 443）。
  const recordParams = presetFake.tools.find((tool) => tool.name === 'expose_record').parameters.properties.records.items.properties
  check(!recordParams.protocol.description.includes('务必写'),
    'protocol 不再无条件要求 http/https')
  check(recordParams.protocol.description.includes('真的能打开'),
    'protocol 写 http/https 的前提是端点真能打开')
  check(recordParams.asset.description.includes('真的能打开'),
    'asset 写带 scheme 的 URL 也受"能打开"约束')
  check(!recordParams.confidence.description.includes('80+') && !recordParams.confidence.description.includes('40–70'),
    'confidence 不再给数字区间（那是 verdict 的活，给了会诱导编数）')
  check(recordParams.kind.description.includes('形态'),
    'kind 的说明把形态 id 挡在外面')
  const toolRunParams = presetFake.tools.find((tool) => tool.name === 'expose_tool_run').parameters.properties
  check(!toolRunParams.target.description.includes('许可'),
    'tool_run 的 target 不再提"许可校验"（那是已删除的授权层）')

  // 运行时文案也要改口：模型读到的空态提示不能再说"没有 shell / 没有任意 URL 抓取"。
  // （emptyOut 在下面的"空配置"用例里取，这里只做判定标记的验证。）

  // 查询结果的每一行要带判定标记：否则模型查重时会把上次标的"可疑"当成已验证资产。
  const realPage = stubStore.pageAssets
  try {
    stubStore.pageAssets = () => ({
      rows: [
        { host: 'a.example.com', port: 443, protocol: 'https', status: 403, category: 'web', verdict: 'suspect', sources: ['fofa'], title: '', server: '', service: '', version: '' },
        { host: 'b.example.com', port: 8443, protocol: '', status: 0, category: 'unknown', verdict: 'infer', sources: [], title: '', server: '', service: '', version: '' },
        { host: 'c.example.com', port: 22, protocol: '', status: 0, category: 'service', verdict: '', sources: [], title: '', server: '', service: 'ssh', version: '8.9' },
      ],
      total: 3,
      offset: 0,
      limit: 100,
    })
    const assetQuery = presetFake.tools.find((tool) => tool.name === 'expose_asset_query')
    const rowsOut = await assetQuery.execute({}, { agent: { id: 's1' } })
    check(rowsOut.text.includes('a.example.com:443 [可疑]'), '可疑资产在查询结果里带 [可疑]', rowsOut.text.slice(0, 120))
    check(rowsOut.text.includes('b.example.com:8443 [推测]'), '推测资产带 [推测]')
    check(rowsOut.text.includes('c.example.com:22  service') && !rowsOut.text.includes('c.example.com:22 ['),
      '事实资产不带标记')
  } finally {
    stubStore.pageAssets = realPage
  }

  // 完整性自检：工具输出里有 IP/状态码却没写进字段的，回执必须点名。
  const realAppend = stubStore.appendRecords
  stubStore.appendRecords = async (_sid, rows) => ({ written: rows, added: 0, merged: 0 })
  try {
    // 完整性自检：工具输出里有 IP/状态码却没写进字段的，回执必须点名。
    const completenessTool = presetFake.tools.find((tool) => tool.name === 'expose_record')
    const thinOut = await completenessTool.execute({
      target: 't.example.com',
      records: [
        { kind: 'web', asset: 'thin.example.com', protocol: 'https', status: 200 },   // 声明了端点级事实却没端口 → 拒
        { kind: 'domain', asset: 'example.com 子域总览' },                              // 汇总行 → 拒
        { kind: 'web', asset: 'thin2.example.com:443', title: '登录页' },               // 通过，但建议补 ip/status/tech
      ],
    }, { agent: { id: 's1' } })
    check(thinOut.rejected >= 1, '缺端口会被当场拒绝', JSON.stringify({ rejected: thinOut.rejected }))
    check(thinOut.suggested >= 1, '建议补的字段会被点名', JSON.stringify({ suggested: thinOut.suggested }))
    check(thinOut.text.includes('被拒') || thinOut.text.includes('字段不全'), '回执里带上拒绝与建议', thinOut.text.slice(0, 200))

    const fullOut = await completenessTool.execute({
      target: 't.example.com',
      records: [
        { kind: 'web', asset: 'full.example.com:443', protocol: 'https', status: 200, title: '首页', ip: '1.2.3.4', tech: ['nginx'] },
      ],
    }, { agent: { id: 's1' } })
    check(fullOut.rejected === 0 && fullOut.suggested === 0, '字段齐全时不再提示',
      JSON.stringify({ rejected: fullOut.rejected, suggested: fullOut.suggested }))

  } finally {
    stubStore.appendRecords = realAppend
  }

  // expose_artifact：写入 + 命中统计（stubStore 只需 appendArtifacts）
  const artifactTool = presetFake.tools.find((tool) => tool.name === 'expose_artifact')
  const realAppendArtifacts = stubStore.appendArtifacts
  stubStore.appendArtifacts = async (_sid, rows) => ({
    written: rows.map((row) => ({ ...row, hits: [] })),
    added: rows.length,
    duplicated: 0,
    hits: 0,
  })
  try {
    const artifactOut = await artifactTool.execute({
      items: [
        { kind: 'cloud', title: '公开 bucket', content: 'oss-cn-hangzhou bucket: demo-public', howFound: 'GET /?prefix=' },
      ],
    }, { agent: { id: 's1' } })
    check(artifactOut.recorded === 1, 'expose_artifact 写入一条', JSON.stringify(artifactOut))
    check(typeof artifactOut.text === 'string' && artifactOut.text.includes('产物'), 'expose_artifact 回执可读')
    let rejected = false
    try {
      await artifactTool.execute({ items: [] }, { agent: { id: 's1' } })
    } catch {
      rejected = true
    }
    check(rejected, 'expose_artifact 空 items 报错')
  } finally {
    stubStore.appendArtifacts = realAppendArtifacts
  }

  // expose_config 读路径
  const configTool = presetFake.tools.find((tool) => tool.name === 'expose_config')
  const configOut = await configTool.execute({ type: 'all' }, { agent: { id: 's1' } })
  check(typeof configOut.text === 'string' && configOut.text.includes('subfinder'), 'expose_config 列出了工具', configOut.text.slice(0, 60))
  check(configOut.text.includes('FOFA'), 'expose_config 列出了测绘平台')
  check(configOut.text.includes('/bin/sub'), 'expose_config 带上了工具路径')
  check(configOut.text.includes('能出:'), 'expose_config 对测绘行说明"能出哪些数据"')
  check(configOut.text.includes('port(端口扫描)') || configOut.text.includes('端口扫描(port)'),
    'expose_config 列出了测绘行勾选的能力', configOut.text.slice(configOut.text.indexOf('FOFA'), configOut.text.indexOf('FOFA') + 120))
  check(!configOut.text.includes('用途 undefined'), '测绘行不再渲染单值用途')
  check(configOut.text.includes('[技能] 上传技能 — 技能名 uploaded-skill'),
    'expose_config 列出技能行与它的注册名',
    configOut.text.slice(configOut.text.indexOf('[技能]'), configOut.text.indexOf('[技能]') + 80))
  check(configOut.text.includes('技能包: 2 个文件'), 'expose_config 标出技能包的文件数')
  check(configOut.text.includes('[MCP] 本地 MCP — stdio：npx -y pkg'),
    'expose_config 列出 MCP 行与它的启动命令',
    configOut.text.slice(configOut.text.indexOf('[MCP]'), configOut.text.indexOf('[MCP]') + 100))
  check(configOut.text.includes('未连接'), 'expose_config 说明 MCP 还没连上')

  // 输入/输出形态：多工具协同的接插件。渲染出来、词表只出一次、"其他"跟着写出来。
  check(configOut.text.includes('输入: 主域名(main_domain) / 域名(domain)（任一即可）'),
    '输入形态默认按「任一即可」渲染', configOut.text.slice(configOut.text.indexOf('输入:'), configOut.text.indexOf('输入:') + 80))
  check(configOut.text.includes('输出: 子域名(subdomain)；其他: 被动源命中'),
    'expose_config 渲染输出形态并带「其他」自定义内容')
  const fofaBlock = configOut.text.slice(configOut.text.indexOf('[空间测绘]'), configOut.text.indexOf('[空间测绘]') + 400)
  check(!fofaBlock.includes('输出:'), '空间测绘行不渲染「输出」行（输出就是「能出」）', fofaBlock.slice(0, 120))
  check(fofaBlock.includes('输入: 主域名(main_domain)'), '空间测绘行渲染输入形态')
  check((configOut.text.match(/形态词表/g) ?? []).length === 1, '形态词表整份只渲染一次')
  check(configOut.text.includes('串接规则'), 'expose_config 说明了串接规则')
  check((configOut.text.match(/输入: \(未声明/g) ?? []).length === 1,
    '只有真的没声明形态的行才显示"未声明"（这里只有 runner 那一行）')

  // 条件关系三档：与 / 或 / 自定义说明。任一即可之外的两档必须也能渲染出来。
  const originalMode = TOOL_ROW.inputMode
  try {
    TOOL_ROW.inputMode = 'and'
    const andOut = await configTool.execute({ type: 'tool' }, { agent: { id: 's1' } })
    check(andOut.text.includes('主域名(main_domain) + 域名(domain)（需同时）'),
      '关系=需同时 渲染成 A + B（需同时）', andOut.text.slice(andOut.text.indexOf('输入:'), andOut.text.indexOf('输入:') + 70))
    TOOL_ROW.inputMode = 'custom'
    TOOL_ROW.inputModeNote = '主域名单独可用；域名 + main_domain 需组合'
    const customOut = await configTool.execute({ type: 'tool' }, { agent: { id: 's1' } })
    check(customOut.text.includes('（关系: 主域名单独可用；域名 + main_domain 需组合）'),
      '关系=自定义说明 把那句话原样交给模型')
    TOOL_ROW.inputModeNote = ''
    const blankNote = await configTool.execute({ type: 'tool' }, { agent: { id: 's1' } })
    check(blankNote.text.includes('关系: 未说明 —— 问用户'),
      '自定义说明留空时明确要求问用户，而不是猜')
  } finally {
    if (originalMode === undefined) delete TOOL_ROW.inputMode
    else TOOL_ROW.inputMode = originalMode
    delete TOOL_ROW.inputModeNote
  }

  // needs / produces：模型靠它反查"谁能吃这个""谁能吐那个"，不用认识那个工具。
  const needsDomain = await configTool.execute({ needs: 'main_domain' }, { agent: { id: 's1' } })
  check(needsDomain.text.includes('FOFA') && needsDomain.text.includes('subfinder'),
    'needs=main_domain 命中两个能吃主域名的行')
  const needsSub = await configTool.execute({ produces: 'port' }, { agent: { id: 's1' } })
  check(needsSub.text.includes('FOFA') && !needsSub.text.includes('subfinder'),
    'produces=port 只命中能吐端口的平台')
  const needsNone = await configTool.execute({ needs: 'credential' }, { agent: { id: 's1' } })
  check(needsNone.count === 0 && needsNone.text.includes('输入 credential'),
    '没人能吃 credential 时明确说明筛选条件与"形态没声明"的可能')
  const badShape = await configTool.execute({ needs: '瞎写的形态' }, { agent: { id: 's1' } })
  check(badShape.count === 0 && badShape.text.includes('不是合法形态') && badShape.text.includes('main_domain'),
    '非法形态值明确报错并给出合法取值，不静默当成"没筛选"', badShape.text.slice(0, 60))

  // 关系参与筛选：and 行要全中才算命中，or 行任一即可。
  const originalMappingMode = MAPPING_ROW.inputMode
  try {
    MAPPING_ROW.inputMode = 'and'
    const andNeeds = await configTool.execute({ needs: ['subdomain', 'port'] }, { agent: { id: 's1' } })
    check(!andNeeds.text.includes('FOFA'), 'and 行：给的条件没凑齐就不命中')
    MAPPING_ROW.inputMode = 'or'
    const orNeeds = await configTool.execute({ needs: ['subdomain', 'port'] }, { agent: { id: 's1' } })
    check(orNeeds.text.includes('FOFA'), 'or 行：给的条件命中一个就算命中')
  } finally {
    if (originalMappingMode === undefined) delete MAPPING_ROW.inputMode
    else MAPPING_ROW.inputMode = originalMappingMode
  }

  // 按 kind 筛选：工具看单值 purpose，测绘看多选 capabilities —— 这是本次改动的核心语义。
  const byPort = await configTool.execute({ purpose: 'port' }, { agent: { id: 's1' } })
  check(byPort.text.includes('FOFA') && !byPort.text.includes('subfinder'), '按 port 筛选：命中覆盖 port 的平台，不含只做子域的工具')
  const byDns = await configTool.execute({ purpose: 'dns' }, { agent: { id: 's1' } })
  check(!byDns.text.includes('FOFA'), '按 dns 筛选：没勾 dns 的平台不出现')
  const byType = await configTool.execute({ type: 'mapping' }, { agent: { id: 's1' } })
  check(byType.text.includes('FOFA') && !byType.text.includes('subfinder'), '只列空间测绘')

  // 空配置：改桩的状态（工具捕获的是同一个对象）
  stubStore.empty = true
  const emptyOut = await configTool.execute({}, { agent: { id: 's1' } })
  check(emptyOut.text.includes('配置为空'), 'expose_config 在空配置时明确说明')
  check(!emptyOut.text.includes('没有 shell') && !emptyOut.text.includes('URL 抓取'),
    '空配置提示不再断言旧的能力边界（网络访问不是被禁掉的东西）', emptyOut.text.slice(0, 60))
  stubStore.empty = false

  // expose_mapping_call：节流是硬约束，不是提示词。用假 fetch 验证"串行 + 间隔"。
  const mappingTool = presetFake.tools.find((tool) => tool.name === 'expose_mapping_call')
  check(mappingTool.parameters.properties.needs === undefined
    && mappingTool.parameters.properties.provider !== undefined, 'expose_mapping_call 参数形状正确')

  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    // 测试把间隔压到 60ms，避免 smoke 真的等 3 秒；生产不设这个变量就是 3–10 秒。
    process.env.INFOHUNTER_MAPPING_GAP_MS = '60'
    const startedAt = Date.now()
    const first = await mappingTool.execute({ provider: 'FOFA', path: 'search/global' }, {})
    const afterFirst = Date.now()
    const second = await mappingTool.execute({ provider: 'FOFA', path: 'search/global' }, {})
    const afterSecond = Date.now()
    check(calls === 2, '空间测绘工具发起了两次请求', String(calls))
    check(first.text.includes('HTTP 200') && !first.text.includes('节流等待'),
      '第一次调用不等待（前面没有请求）')
    check(second.text.includes('节流等待'), '第二次调用在输出里报告了节流等待', second.text.slice(0, 40))
    check(afterSecond - afterFirst >= 55, '两次请求之间至少隔了设定的间隔', String(afterSecond - afterFirst) + 'ms')
    check(second.waitedMs >= 55, '返回值带 waitedMs（面板/模型都能看到等了多久）', String(second.waitedMs))
    check(afterSecond - startedAt >= 55, '总耗时包含等待')
    check(first.status === 200 && first.length === 11, '响应体原样返回并带长度')

    // 生产路径：不设覆盖 + 随机数取 0 → 间隔就是下界 3 秒。验证常量真的生效（会慢 3 秒）。
    delete process.env.INFOHUNTER_MAPPING_GAP_MS
    const realRandom = Math.random
    Math.random = () => 0
    try {
      const third = await mappingTool.execute({ provider: 'FOFA', path: 'search/global' }, {})
      check(third.waitedMs >= 2_900 && third.waitedMs <= 3_600,
        '不设覆盖时间隔下界就是 3 秒（生产值，不是可配的摆设）', `${third.waitedMs}ms`)
    } finally {
      Math.random = realRandom
    }
  } finally {
    delete process.env.INFOHUNTER_MAPPING_GAP_MS
    globalThis.fetch = realFetch
  }

  // expose_record：一次调用写两处（采集记录 + 资产）
  const recordTool = presetFake.tools.find((tool) => tool.name === 'expose_record')
  const recordOut = await recordTool.execute(
    {
      target: 'example.com',
      records: [
        { kind: 'subdomain', asset: 'a.example.com', detail: 'A 1.2.3.4', sources: ['subfinder'] },
        { kind: 'port', asset: 'a.example.com:443', detail: 'open', sources: ['naabu'] },
        { kind: 'web', asset: 'a.example.com:443', status: 200, title: 'OA', sources: ['httpx'] },
        { kind: 'port' },
      ],
    },
    { agent: { id: 'child', session: { id: 'child', header: { parentSession: 'root' } } } },
  )
  check(recordOut.recorded === 3 && recordOut.skipped === 1,
    '缺 asset 的条目被跳过，其余都进记录', JSON.stringify(recordOut))
  check(recordOut.added === 2, '同端点的两次观测合并成一个资产', JSON.stringify(recordOut))
  check(recordOut.text.includes('记录 3 条') && recordOut.text.includes('合并 1'), '回执同时报告记录数与资产合并情况', recordOut.text)

  let noAgent
  try {
    await recordTool.execute({ assets: [{ host: 'a' }] }, {})
    noAgent = undefined
  } catch (error) {
    noAgent = error.message
  }
  check(noAgent?.includes('归属会话') === true, '没有会话上下文时明确报错', noAgent)

  // 常驻段
  check(presetFake.sections.length === 1, '注册了一个常驻段', String(presetFake.sections.length))
  check(presetFake.sections[0]?.name === 'infohunter:method', '常驻段名字唯一', presetFake.sections[0]?.name)
  check(presetFake.sections[0]?.text.includes('暴露面'), '常驻段正文有内容')

  // 技能
  await new Promise((resolve) => setTimeout(resolve, 200))
  check(presetFake.skills.length === 1, '注册了 1 个随包技能', String(presetFake.skills.length))
  check(presetFake.skills[0]?.name === 'info-hunter-method', '技能名来自 SKILL.md 的 front matter', presetFake.skills[0]?.name)
  check(typeof presetFake.skills[0]?.description === 'string' && presetFake.skills[0].description.length > 20, '技能描述非空')
  check(presetFake.skills[0]?.content.includes('泛解析基线'), '技能正文已注入（去掉了 front matter）')
  // 授权层早就删了，技能里不能还留着"授权范围 / 未授权"这类措辞。
  check(!presetFake.skills[0]?.content.includes('授权'), '技能正文里没有残留的授权口径')
  check(presetFake.skills[0]?.invocation?.modelInvocable === true, '技能可被模型调用')

  // 用户上传的技能：注册进本预设的层（fakeCtx 的 skills 就是"本预设的注册表"）。
  const uploadedRoot = join(tempRoot, 'infohunter', 'skills')
  await pack.installSkillZip(
    buildZip([{ name: 'SKILL.md', data: '---\nname: uploaded-skill\ndescription: 用户传上来的技能\n---\n\n正文\n' }]),
    uploadedRoot,
    'up-1',
  )
  // 同名包：注册名必须加后缀，不能把内置技能顶掉。
  await pack.installSkillZip(
    buildZip([{ name: 'SKILL.md', data: '---\nname: info-hunter-method\ndescription: 同名冲突\n---\n\n正文\n' }]),
    uploadedRoot,
    'up-2',
  )
  const registeredSkills = []
  const skillsService = { register: (skill) => (registeredSkills.push(skill), () => {}) }
  stubStore.entries = [
    { id: 'up-1', type: 'skill', enabled: true },
    { id: 'up-2', type: 'skill', enabled: true },
    { id: 'up-3', type: 'tool', enabled: true },
  ]
  const skillsFake = fakeCtx({ tools: undefined, skills: skillsService, infohunterStore: stubStore })
  preset.apply(skillsFake.ctx)
  await waitFor(() => registeredSkills.length >= 3)
  check(registeredSkills.some((skill) => skill.name === 'uploaded-skill'),
    '预设半：用户上传的技能被注册', registeredSkills.map((skill) => skill.name).join(','))
  const collision = registeredSkills.find((skill) => skill.name.startsWith('info-hunter-method-'))
  check(collision !== undefined && collision.name.length > 'info-hunter-method-'.length,
    '预设半：与内置重名的技能自动加后缀', registeredSkills.map((skill) => skill.name).join(','))
  check(registeredSkills.filter((skill) => skill.name === 'info-hunter-method').length === 1,
    '预设半：内置技能没有被顶掉')
  check(registeredSkills.every((skill) => skill.invocation.modelInvocable === true),
    '预设半：上传的技能对模型可调用')

  // 停用的行不注册；目录缺失的行只 warn、不影响别的技能。
  registeredSkills.length = 0
  stubStore.entries = [
    { id: 'up-1', type: 'skill', enabled: false },
    { id: 'up-missing', type: 'skill', enabled: true },
  ]
  const disabledFake = fakeCtx({ tools: undefined, skills: skillsService, infohunterStore: stubStore })
  preset.apply(disabledFake.ctx)
  await waitFor(() => disabledFake.logs.some(([level]) => level === 'warn'))
  check(!registeredSkills.some((skill) => skill.name === 'uploaded-skill'),
    '预设半：停用的技能行不注册', registeredSkills.map((skill) => skill.name).join(','))
  check(disabledFake.logs.some(([level, message]) => level === 'warn' && message.includes('up-missing')),
    '预设半：目录缺失的技能行留下警告，不静默')
  stubStore.entries = []

  // MCP：连上配置里的 server，把它的工具注册进本预设的层。
  stubStore.entries = [{
    id: 'mcp-1',
    type: 'mcp',
    enabled: true,
    name: 'fake server',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', FAKE_MCP_STDIO],
  }]
  const mcpFake = fakeCtx({ infohunterStore: stubStore })
  mcpFake.ctx.get = (key) => {
    if (key === 'infohunterStore') return stubStore
    if (key === 'tools') return mcpFake.ctx.tools
    return undefined
  }
  preset.apply(mcpFake.ctx)
  await waitFor(() => mcpFake.tools.some((tool) => tool.name.startsWith('mcp__')), 5000)
  const mcpTool = mcpFake.tools.find((tool) => tool.name.startsWith('mcp__'))
  check(mcpTool !== undefined, '预设半：MCP 工具被注册', mcpFake.tools.map((tool) => tool.name).join(','))
  check(mcpTool?.name === 'mcp__fake-server__ping', '预设半：工具名是 mcp__<server>__<tool>', mcpTool?.name)
  check(mcpTool?.parameters?.required?.[0] === 'x', '预设半：远端 inputSchema 原样成为工具参数')
  const mcpOut = await mcpTool.execute({ x: 'hi' }, {})
  check(String(mcpOut.text).includes('pong:{"x":"hi"}'), '预设半：MCP 工具真的调到远端',
    String(mcpOut.text).slice(0, 80))
  await mcpFake.ctx._disposeAll()
  stubStore.entries = []

  // 连不上只影响它自己：留警告，不抛。
  stubStore.entries = [{
    id: 'mcp-2', type: 'mcp', enabled: true, name: 'bad server', transport: 'stdio',
    command: 'definitely-not-a-real-executable-xyz', args: [],
  }]
  const badFake = fakeCtx({ infohunterStore: stubStore })
  badFake.ctx.get = (key) => (key === 'infohunterStore' ? stubStore : key === 'tools' ? badFake.ctx.tools : undefined)
  preset.apply(badFake.ctx)
  await waitFor(() => badFake.logs.some(([level, message]) => level === 'warn' && message.includes('MCP')), 5000)
  check(badFake.logs.some(([level, message]) => level === 'warn' && message.includes('MCP')),
    '预设半：MCP 连不上只留警告，不把预设弄坏')
  check(badFake.tools.some((tool) => tool.name === 'expose_config'),
    '预设半：一个 MCP 挂了，本插件自己的工具照常注册')
  await badFake.ctx._disposeAll()
  stubStore.entries = []

  // 服务全缺时：不抛、不注册工具，但**保持等待**（而不是永久放弃）。
  const degraded = fakeCtx({})
  let degradedThrew
  try {
    preset.apply(degraded.ctx)
  } catch (error) {
    degradedThrew = error.message
  }
  check(degradedThrew === undefined, 'store/skills 都缺失时不抛', degradedThrew)
  check(degraded.tools.length === 0, 'store 缺失时不注册工具', String(degraded.tools.length))
  // 之后 store 真的出现（比如 Host 半终于装载完），工具必须补上 —— 这就是"等"，不是"放弃"。
  degraded.ctx._deliver('infohunterStore', stubStore)
  check(degraded.tools.length === EXPECTED_TOOLS.length, `store 迟到也能补齐 ${EXPECTED_TOOLS.length} 个工具`, degraded.tools.map((tool) => tool.name).join(','))

  // ── 4. 受控执行：唯一的执行入口 ────────────────────────────────────────
  //
  // 这里**不再**有任何"目标白名单"用例 —— 那是被否决的设计：资产收集的产出就是范围本身，
  // 要求预先枚举等于让用户先做完再去做。留下的约束只有**能力**层面的：
  // 工具必须来自面板、argv 方式（无 shell）、有超时/输出/参数上限。
  console.log('\n[4] 受控执行')
  const runTool = presetFake.tools.find((tool) => tool.name === 'expose_tool_run')
  const runQuery = presetFake.tools.find((tool) => tool.name === 'expose_run_query')
  const expectThrow = async (label, fn, needle) => {
    try {
      await fn()
      check(false, label, '没有抛错')
    } catch (error) {
      check(String(error.message).includes(needle), label, String(error.message))
    }
  }

  await expectThrow('未配置的工具被拒（配置即能力）',
    () => runTool.execute({ tool: 'fscan', args: [] }, {}), '不在面板配置里')
  await expectThrow('缺 tool 被拒', () => runTool.execute({}, {}), 'tool 必填')
  await expectThrow('参数条数超限被拒',
    () => runTool.execute({ tool: 'runner', args: Array.from({ length: 200 }, () => 'x') }, {}), '参数最多')
  await expectThrow('单个参数过长被拒',
    () => runTool.execute({ tool: 'runner', args: ['x'.repeat(5000)] }, {}), '单个参数不能超过')
  await expectThrow('stdin 超限被拒',
    () => runTool.execute({ tool: 'runner', stdin: 'x'.repeat(2_000_000) }, {}), 'stdin 不能超过')

  // 合法执行：真的跑起来，输出保存成 runId。**不传 target** —— 目标不需要预先登记。
  const run = await runTool.execute({
    tool: 'runner',
    args: ['-e', 'console.log("hello-run"); console.error("on-stderr")'],
    maxLines: 50,
  }, {})
  check(run.exitCode === 0, '受控执行成功（无需声明 target）', String(run.exitCode))
  check(run.text.includes('hello-run') && run.text.includes('on-stderr'), 'stdout 与 stderr 都被收集')
  check(typeof run.runId === 'string' && run.runId.endsWith('.log'), 'runId 已生成', run.runId)
  check(statSync(join(tempRoot, 'infohunter', 'runs', run.runId)).size > 0, '完整输出已落盘')

  // target 只是归集信息：带上它不改行为。
  const runWithTarget = await runTool.execute({ tool: 'runner', target: 'example.com', args: ['-e', 'console.log("t")'] }, {})
  check(runWithTarget.exitCode === 0, '带 target 也能跑（仅用于回溯）')

  const grep = await runQuery.execute({ runId: run.runId, pattern: 'hello-run' }, {})
  check(grep.matches === 1 && grep.text.includes('hello-run'), 'run 检索命中', String(grep.matches))
  const miss = await runQuery.execute({ runId: run.runId, pattern: 'nothing-here' }, {})
  check(miss.matches === 0, 'run 检索未命中')
  await expectThrow('runId 路径穿越被拒', () => runQuery.execute({ runId: '../../etc/passwd' }, {}), 'runId 不合法')
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(failures === 0 ? '\nsmoke: 全部通过' : `\nsmoke: ${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
