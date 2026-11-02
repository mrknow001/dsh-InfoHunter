#!/usr/bin/env node
/**
 * smoke-client —— 在 node 里跑客户端半，验证"只在用了这个预设的会话里出现面板"这条门控。
 *
 * 为什么值得单独一个测试：这条门控已经错过两次，而且**错得很安静** ——
 * 上一版读的是 `ctx.sessions.list`，而浏览器半根本没有这个服务（那是 0.1.x 的记忆），
 * 于是门控分支永远进不去、永远落到"无条件注册"的兜底，结果每个会话都多一个标签页，
 * 却没有任何报错。
 *
 * 做法：把 `window.__ModuleLoader__` 和 `react` 都换成桩，`import` 真实的 client.js，
 * 取出插件对象，再用假的 ctx 驱动 apply —— 然后手动"渲染"哨兵组件来模拟会话切换。
 *
 * 用法：`node scripts/smoke-client.mjs`（开发期脚本，不随包分发）
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
let failures = 0
const check = (ok, label, detail) => {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── 1. 静态检查：别再读不存在的服务 ────────────────────────────────────────
console.log('\n[1] 源码里没有"读不到就无条件注册"的老门控')
const source = readFileSync(join(root, 'client.js'), 'utf8')
check(!/sessions\s*\?\.\s*list/.test(source), '不再引用 sessions?.list（该服务在浏览器半不存在）')
check(!/retainedBy/.test(source), '不再依赖 retainedBy.mainView（该字段已不存在）')
// 配置行用 `Card className="ih-card"`。资产卡片如果也挂这个类并给它 display:grid，
// 整个配置区会被压成竖排（真机上发生过一次），所以资产卡片必须用自己的类名。
check(!/\.ih-card\{display:/.test(source), '不能给 .ih-card 加布局（配置行也在用这个类）')
check(/\.ih-acard\{display:grid/.test(source), '资产卡片用自己的 .ih-acard 类名')
// 内容盒必须一直跟着 DSH 会话列宽：列两侧的留白是外层容器给的。
// 面板一旦自己放大 max-width，就会贴边并溢出会话列（真机上发生过一次）。
check(/\.ih-inner\{width:100%;max-width:var\(--dsh-chat-content-width/.test(source),
  '内容盒仍然受 --dsh-chat-content-width 约束')
check(!/ih-inner\.ih-wide/.test(source), '没有给内容盒单独放宽的例外')
// 详情页签的内容区必须**固定高度**：否则切页签时高度变化，下方卡片会跟着跳（真机上反馈过）。
check(/\.ih-tab-body\{height:\d+px/.test(source), '详情页签内容区是固定高度')

// ── 2. 装载真实 client.js ───────────────────────────────────────────────────
console.log('\n[2] 装载客户端半')
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }
await import(pathToFileURL(join(root, 'client.js')).href)
check(loaded.length === 1, 'client.js 调用了 __ModuleLoader__.load 一次', String(loaded.length))

const spec = loaded[0]
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check(spec?.id === pkg.name, 'bundle id 等于包名', spec?.id)
check(typeof spec?.factory === 'function', 'factory 是函数')

// 极简 React 桩：只需要 createElement + 让 useEffect 立即执行。
const elements = []
const cleanups = []
const ReactStub = {
  createElement(type, props, ...children) {
    const element = { type, props: { ...(props ?? {}) } }
    if (children.length === 1) element.props.children = children[0]
    else if (children.length > 1) element.props.children = children
    elements.push(element)
    return element
  },
  useEffect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return undefined
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

const plugin = spec.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error(`未预期的 require：${id}`)
})
check(typeof plugin?.apply === 'function', 'factory 返回带 apply 的插件对象')
check(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), '插件声明了 slots 依赖')

// ── 2b. 卡片与详情的数据模型（纯函数，不渲染）──────────────────────────────
console.log('\n[2b] 卡片 / 详情的数据模型')
const assetsMod = await import(pathToFileURL(join(root, 'assets.js')).href)
const pure = plugin.__test
check(pure !== undefined && typeof pure.cardModel === 'function', '__test 提供了 cardModel')
check(typeof pure.detailModel === 'function', '__test 提供了 detailModel')
check(pure.BUILTIN_QUERIES !== undefined && Array.isArray(pure.BUILTIN_QUERIES.endpoint) && Array.isArray(pure.BUILTIN_QUERIES.app), '__test 提供了两套内置语句表')
// 探索图：按线索分组（抽屉的渲染依据）
const graphNodes = [
  { id: 'n1', kind: 'clue', text: 'a.com', payload: { source: 'domain' } },
  { id: 'n2', kind: 'direction', state: 'done', payload: { clueId: 'n1', method: 'subfinder', target: 'a.com' } },
  { id: 'n3', kind: 'direction', state: 'open', payload: { clueId: 'n1', method: 'httpx', target: 'a.com' } },
  { id: 'n4', kind: 'direction', state: 'running', payload: { method: 'naabu', target: '1.2.3.4' } },
]
const grouped = pure.groupByClue(graphNodes)
check(grouped.groups.length === 1 && grouped.groups[0].roads.length === 2, '探索图：路按线索归组',
  JSON.stringify(grouped.groups.map((item) => item.roads.length)))
check(grouped.orphans.length === 1 && grouped.orphans[0].id === 'n4', '探索图：没有线索来源的路进 orphans')
check(pure.groupByClue([]).groups.length === 0, '探索图：空数据不炸')

if (pure !== undefined) {
  const web = pure.cardModel({
    host: 'a.example.com', port: 443, protocol: 'https', category: 'web', title: '登录页', status: 200,
    tech: ['nginx', 'vue'], server: 'nginx', sources: ['fofa'], verdict: 'suspect', ip: '1.2.3.4', lastSeen: 1700000000000,
  })
  check(web.endpoint === 'a.example.com:443' && web.isWeb === true, 'cardModel：Web 端点')
  check(web.url === 'https://a.example.com:443', 'cardModel：Web 有可点链接', web.url)
  check(web.titleLine === '登录页', 'cardModel：标题取 title')
  check(JSON.stringify(web.fingerprint) === JSON.stringify(['nginx', 'vue']),
    'cardModel：指纹去重（server 已在 tech 里）', JSON.stringify(web.fingerprint))
  check(web.verdict === 'suspect' && web.sources.length === 1, 'cardModel：判定与来源带出')
  // 卡片上的字段必须"一个都不少"（空值也占位）：否则用户看不出"没采到"。
  const fieldKeys = web.fields.map((item) => item.key)
  check(JSON.stringify(fieldKeys) === JSON.stringify(['ip', 'port', 'protocol', 'status', 'category', 'fingerprint', 'sources', 'lastSeen']),
    'cardModel：卡片字段齐全（IP/端口/协议/状态/类型/组件/来源/最近）', fieldKeys.join(','))
  check(web.fields.every((item) => typeof item.labelKey === 'string' && item.value !== undefined),
    'cardModel：每个字段都带标签与值')
  check(web.fields.find((item) => item.key === 'fingerprint').value === 'nginx · vue', 'cardModel：组件字段用的是去重后的指纹')

  // 系统节点：身份是完整 URL，卡片还要带 URL 证据数与合并状态。
  const appRow = pure.cardModel({
    nodeType: 'app', key: 'https://h.example.com:8080/admin/', host: 'h.example.com', port: 8080,
    scheme: 'https', basePath: '/admin/', protocol: 'https', category: 'web', title: '管理后台',
    mergeState: 'unresolved', urls: [{ url: 'https://h.example.com:8080/admin/news/1.html', pageType: 'content' }, { url: 'https://h.example.com:8080/admin/x.html', pageType: 'content' }],
  })
  check(appRow.isApp === true, 'cardModel：系统节点被识别')
  check(appRow.endpoint === 'https://h.example.com:8080/admin/', 'cardModel：系统显示完整 URL', appRow.endpoint)
  // 系统的键本身就是 URL：不能再拼一次协议（否则 http://http://…）。
  check(appRow.url === 'https://h.example.com:8080/admin/', 'cardModel：系统链接不再重复拼协议', appRow.url)
  const httpApp = pure.cardModel({ nodeType: 'app', key: 'http://175.155.178.204:8000/', host: '175.155.178.204', port: 8000, protocol: 'http' })
  check(httpApp.url === 'http://175.155.178.204:8000/', 'cardModel：http 系统链接不带双协议', httpApp.url)
  check(appRow.urlCount === 2, 'cardModel：系统带 URL 证据数', String(appRow.urlCount))
  check(appRow.mergeState === 'unresolved', 'cardModel：带合并状态')
  const appDetail = pure.detailModel({ nodeType: 'app', urls: [{ url: 'https://x/a.html', pageType: 'content' }] }, undefined)
  check(appDetail.urls.has === true && appDetail.urls.items.length === 1, 'detailModel：URL 页签有数据')
  const noUrls = pure.detailModel({ nodeType: 'app' }, undefined)
  check(noUrls.urls.has === false, 'detailModel：没有 URL 证据时该页签是未采集')

  // 关联的新形状：只按"有没有东西"判断，空块不该让页签亮起；只有域名也算有关联。
  const relOnlyDomains = pure.detailModel({}, {
    found: true,
    current: { ip: '', cname: '', certSan: [], sameIpPorts: [], sameIpDomains: [{ key: 'a:0' }], sameCname: [], sameHostPorts: [] },
    history: [],
  })
  check(relOnlyDomains.relations.has === true, 'detailModel：只有同 IP 域名也算有关联')
  const relNothing = pure.detailModel({}, {
    found: true,
    current: { ip: '', cname: '', certSan: [], sameIpPorts: [], sameIpDomains: [], sameCname: [], sameHostPorts: [] },
    history: [],
  })
  check(relNothing.relations.has === false, 'detailModel：四块全空时关联页签不亮')

  const hostRow = pure.cardModel({ host: 'b.example.com', port: 0, protocol: '', category: 'host', title: '', verdict: 'infer' })
  check(hostRow.endpoint === 'b.example.com', 'cardModel：port=0 不显示 :0', hostRow.endpoint)
  check(hostRow.titleLine === '' && hostRow.canExpand === false, 'cardModel：空壳没有标题行')
  // 域名级记录（port=0）本来就没有端口/协议/状态：空字段不占格子，只留真正有值的。
  check(hostRow.fields.every((item) => item.key !== 'port' && item.key !== 'protocol'), 'cardModel：port=0 不渲染端口/协议空字段')
  check(hostRow.fields.some((item) => item.key === 'category'), 'cardModel：类型字段始终保留')
  const ipRow = pure.cardModel({ host: 'c.example.com', port: 22, ip: '1.2.3.4', category: 'service', service: 'ssh' })
  check(ipRow.fields.find((item) => item.key === 'port').value === '22', 'cardModel：有端口时照常显示')

  const svc = pure.cardModel({ host: 'c.example.com', port: 22, category: 'service', service: 'ssh', version: '8.9', banner: 'SSH-2.0-OpenSSH_8.9\n第二行' })
  check(svc.titleLine === 'SSH-2.0-OpenSSH_8.9', 'cardModel：服务取 banner 首行', svc.titleLine)
  check(svc.isWeb === false && svc.url === '', 'cardModel：服务不是 Web')

  const empty = pure.detailModel({ host: 'x.example.com', port: 80 }, undefined)
  check(empty.cert.has === false && empty.headers.has === false && empty.body.has === false,
    'detailModel：缺数据时三个页签都是 has=false')
  check(empty.relations.has === false, 'detailModel：没有关联数据时 has=false')

  const full = pure.detailModel({
    host: 'x.example.com', port: 443, certSubject: 'x.example.com', certIssuer: 'Encrypt', certNotAfter: '2027-01-01',
    certSan: ['x.example.com', 'www.x.example.com'], headers: 'HTTP/1.1 200', body: '正文', banner: '',
  }, {
    found: true,
    current: { ip: '1.1.1.1', cname: '', sameIp: [], sameCname: [], certSan: ['x.example.com'], sameHostPorts: [] },
    history: [],
  })
  check(full.cert.has === true && full.cert.san.length === 2, 'detailModel：证书页签有数据')
  check(full.headers.has === true && full.body.has === true, 'detailModel：响应头与正文页签有数据')
  check(full.relations.has === true && full.relations.current.ip === '1.1.1.1', 'detailModel：关联页签有数据')

  // 两个视角各有一套内置语句，逐条断言可解析（加错一条就红）。
  const badBuiltins = []
  for (const view of ['endpoint', 'app']) {
    for (const group of pure.BUILTIN_QUERIES[view]) {
      for (const q of group.items) {
        if (assetsMod.parseQuery(q).ast === null) badBuiltins.push(`${view}:${q}`)
      }
    }
  }
  check(badBuiltins.length === 0, '两套内置语句全部能被 parseQuery 解析', badBuiltins.join(' , '))
  check(['endpoint', 'app'].every((view) => pure.BUILTIN_QUERIES[view].every(
    (group) => typeof group.group === 'string' && group.items.length > 0,
  )), '两套内置语句分组结构正确')
}

// ── 3. 假 ctx + 假 slot 注册表 ─────────────────────────────────────────────
const slotRegistry = { 'conversation.view': [], 'conversation.composer.dock': [] }
const injectors = {}
const ctx = {
  get: () => undefined,
  effect(fn) {
    fn()
    return () => {}
  },
  slots: {
    inject(key, callback) {
      injectors[key] = callback
      return () => {}
    },
    register(options, component) {
      const bucket = slotRegistry[options.name]
      const entry = { options, component }
      bucket.push(entry)
      return () => {
        const at = bucket.indexOf(entry)
        if (at >= 0) bucket.splice(at, 1)
      }
    },
  },
}

console.log('\n[3] apply 之后的初始状态')
plugin.apply(ctx)
check(injectors['conversation.view'] !== undefined, '注入了 conversation.view')
check(injectors['conversation.composer.dock'] !== undefined, '注入了 conversation.composer.dock（哨兵）')
check(slotRegistry['conversation.view'].length === 0, '**还没注册标签页**（等投影）', String(slotRegistry['conversation.view'].length))

// ── 4. 模拟框架声明 slot + 哨兵渲染 ───────────────────────────────────────
console.log('\n[4] 声明 view slot')
injectors['conversation.view']()
check(slotRegistry['conversation.view'].length === 0, '声明就绪但仍未注册（还不知道预设）')

injectors['conversation.composer.dock']()
check(slotRegistry['conversation.composer.dock'].length === 1, '哨兵已挂到 composer.dock')
const watcherEntry = slotRegistry['conversation.composer.dock'][0]
check(watcherEntry.options.id !== 'infohunter', '哨兵用了自己的 id（不与面板混淆）', watcherEntry.options.id)

/** 渲染一次哨兵：模拟"当前会话的 agentPreset 投影是这个值"。 */
const renderWatcher = (presetValue) => {
  const state = { byId: { 'session-1': { projectionValues: { agentPreset: presetValue } } } }
  const element = watcherEntry.component({
    sessionId: 'session-1',
    // 与官方客户端同一条路径：useSessions(selector)，selector 收到 session 列表快照。
    // 见 dsh-client-ui-agent-preset 的会话头标签。
    useSessions: (selector) => selector(state),
  })
  return element?.type?.(element.props)
}

console.log('\n[5] 用本预设的会话 → 出现面板')
renderWatcher('information-hunter')
check(slotRegistry['conversation.view'].length === 1, '注册了一个标签页', String(slotRegistry['conversation.view'].length))
const view = slotRegistry['conversation.view'][0]
check(view?.options.id === 'infohunter', 'view id 是 infohunter', view?.options.id)
check(view?.options.order === 20, 'view order 是 20', String(view?.options.order))
check(typeof view?.options.label === 'function', 'label 是函数（可随时跟着语言变）')
check(typeof view?.component === 'function', '带视图组件')

console.log('\n[6] 切到别的预设 → 面板撤掉')
renderWatcher('standard')
check(slotRegistry['conversation.view'].length === 0, '标签页已撤掉', String(slotRegistry['conversation.view'].length))

console.log('\n[7] 切回本预设 → 面板回来')
renderWatcher('information-hunter')
check(slotRegistry['conversation.view'].length === 1, '标签页回来了')

console.log('\n[8] 投影值是 null（会话没选预设）→ 不显示，且不算异常')
renderWatcher(null)
check(slotRegistry['conversation.view'].length === 0, 'null → 不显示面板', String(slotRegistry['conversation.view'].length))

console.log('\n[9] 会话行还没加载（投影读不到）→ 不显示')
renderWatcher(undefined)
check(slotRegistry['conversation.view'].length === 0, '读不到 → 不显示面板')

console.log('\n[10] 投影值类型异常 → 不显示，并且打可诊断的警告（不是静默）')
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.map(String).join(' '))
try {
  renderWatcher(42)
} finally {
  console.warn = originalWarn
}
check(slotRegistry['conversation.view'].length === 0, '类型异常 → 不显示面板')
check(
  warnings.some((line) => line.includes('[infohunter]') && line.includes('agentPreset')),
  '类型异常时打了警告',
  warnings.join(' | '),
)

console.log('\n[11] 哨兵本身不渲染任何东西')
check(renderWatcher('information-hunter') === null, '哨兵返回 null')
check(slotRegistry['conversation.composer.dock'].length === 1, '哨兵始终只占一个条目')

console.log(failures === 0 ? '\nsmoke-client: 全部通过' : `\nsmoke-client: ${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
