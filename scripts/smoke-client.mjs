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
