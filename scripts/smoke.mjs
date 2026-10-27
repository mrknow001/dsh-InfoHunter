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
async function callRoute(handler, { method = 'GET', url, body }) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
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
    backend.kv.open({ name: UNIT_NAME, version, tables: ['config', 'results', 'assets'], hasGlobal: false })

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
    await backend.kv.open({ name: 'other', version: 99, tables: [], hasGlobal: false })
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
  const unit2 = await backend2.kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: ['config', 'results', 'assets'], hasGlobal: false })
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
  await store2.unit.close()
  await backend2.close()

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

  const dropNoId = await callRoute(handler, { method: 'POST', url: '/infohunter/assets/drop?sessionId=s1', body: {} })
  check(dropNoId.status === 400, '缺 key 的删除返回 400')

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
  const TOOL_ROW = { id: 't', type: 'tool', purpose: 'subdomain', name: 'subfinder', path: '/bin/sub', description: '用法说明', enabled: true, note: '' }
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
  }
  const stubStore = {
    empty: false,
    enabledEntries(type) {
      if (this.empty) return []
      if (type === 'tool') return [TOOL_ROW, EXEC_ROW]
      if (type === 'mapping') return [MAPPING_ROW]
      return [TOOL_ROW, EXEC_ROW, MAPPING_ROW]
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
  }
  presetFake.ctx.get = (key) => {
    if (key === 'infohunterStore') return stubStore
    if (key === 'skills') return presetFake.ctx.skills
    return undefined
  }
  preset.apply(presetFake.ctx)

  const names = presetFake.tools.map((tool) => tool.name)
  check(names.length === 6, '注册了 6 个工具', names.join(','))
  for (const expected of ['expose_config', 'expose_mapping_call', 'expose_record', 'expose_asset_query', 'expose_tool_run', 'expose_run_query']) {
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
  check(lateFake.tools.length === 6, 'store 晚到后工具自动注册上', lateFake.tools.map((tool) => tool.name).join(','))

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
  stubStore.empty = false

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
  check(presetFake.skills[0]?.content.includes('泛解析检测'), '技能正文已注入（去掉了 front matter）')
  check(presetFake.skills[0]?.invocation?.modelInvocable === true, '技能可被模型调用')

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
  check(degraded.tools.length === 6, 'store 迟到也能补齐六个工具', degraded.tools.map((tool) => tool.name).join(','))

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
