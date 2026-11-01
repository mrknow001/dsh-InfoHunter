/**
 * 互联网暴露面收集 —— Host 半。
 *
 * 职责只有三件：
 *   1. 注册本包自己的 SQLite 后端（名字 `infohunter-sqlite`，不与别人抢 `sqlite`）；
 *   2. 打开 unit、把 `HunterStore` 共享给 preset 半（`ctx.provide('infohunterStore')`）；
 *   3. 在 Web 服务器上挂一条 JSON 路由，供面板读写配置与结果。
 *
 * ## 为什么面板走 HTTP 路由
 *
 * 面板需要读写**跨会话**的东西（全局工具配置、当前会话的结果），这两样都不是会话日志
 * 派生的，所以既不能靠投影，也不适合塞进会话命令（那会把每次保存写成一条 command 事件）。
 * `ctx.webServer.register()` 是公开的 Host 服务，同源 `fetch` 即可，而且**可以用 curl 端到端验证** ——
 * 对一个无法点击界面的开发者来说，这是唯一能自证的路子。
 *
 * ## 为什么这里不做任何 `@deepseek-ai/*` 的 import
 *
 * 本插件以目录形式安装（install_bundle 链接工作区），裸包名不一定解析得到宿主依赖。
 * 全部只用 `node:*` 内建模块 + `ctx.<service>`，就没有解析风险，也不需要声明依赖 ——
 * 顺带绕开了 DSH peer 版本约束。
 *
 * @module @infohunter/dsh-information-hunter
 */

import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { HunterStore, SqliteKvBackend, BACKEND_NAME, UNIT_NAME, UNIT_VERSION } from './storage.js'
import { SKILL_LIMITS, assertRowId, defaultSkillsRoot, installSkillZip, pruneSkillDirs } from './skillpack.js'

/**
 * 本包清单与版本。
 *
 * 从**包内** `package.json` 读，而不是手写常量：装进去的就是这份清单，
 * 所以显示的版本一定等于实际运行的版本（链接目录与 tarball 两种形态都成立）。
 *
 * 这个值在**模块加载时**读一次，因此它代表的是"这份代码被加载时磁盘上的版本"。
 * 之后再读磁盘（`readManifestFromDisk`）就能看出模块是不是旧的 —— 那正是
 * 「插件装好了、但没重启所以新工具没出现」这个坑的判据。
 *
 * @type {{ name: string, version: string }}
 */
const MANIFEST = readManifestFromDisk() ?? { name: '@infohunter/dsh-information-hunter', version: '0.0.0-unknown' }

/** 现读磁盘上的清单（失败返回 undefined）。 */
function readManifestFromDisk() {
  try {
    const path = fileURLToPath(new URL('./package.json', import.meta.url))
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '@infohunter/dsh-information-hunter',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown',
    }
  } catch {
    return undefined
  }
}

/** 插件名。 */
export const name = 'infohunter'

/**
 * 必需服务只有 storage hub（后端注册表 + 数据面）。
 *
 * `webServer` **不写进 inject**：headless profile 没有 Web 层，写进去会让整行挂不上；
 * 面板路由在缺它时降级为"只有工具可用"。
 */
export const inject = ['storage']

/** HTTP 路由前缀（同源、与其它插件不冲突）。 */
const ROUTE_PREFIX = '/infohunter'

/** 面板读写的表名（unit 内）。 */
const TABLES = ['config', 'results', 'assets', 'queries', 'questions', 'artifacts', 'settings', 'plans', 'tasks', 'links']

/** 单个请求体的上限，防止误传巨大 JSON。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * 解析数据库文件路径。
 *
 * `$DSH_HOME` 的优先级与 DSH 自己的 home 解析一致：环境变量优先，否则 `~/.dsh`。
 *
 * @param {string | undefined} configured - 插件 config 里的 `database`。
 * @returns {string} 绝对路径。
 */
function resolveDatabasePath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    // 相对路径按 $DSH_HOME 解析，绝对路径直接使用。
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(configured)) return configured
    return join(dshHome(), configured)
  }
  return join(dshHome(), 'storages', 'infohunter.db')
}

/** DSH home 目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 用户上传的技能落地根目录（实现在 skillpack 里，preset 半读的是同一处）。
 *
 * @returns {string} 绝对路径。
 */
export function skillsDir() {
  return defaultSkillsRoot()
}

/**
 * 读一个请求的原始二进制体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} maxBytes - 上限。
 * @returns {Promise<Buffer>}
 */
async function readRawBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`请求体超过 ${maxBytes} 字节`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new Error('请求体为空（没有收到 zip）')
  return Buffer.concat(chunks)
}

/**
 * 读一个请求的 JSON 体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<unknown>} 解析后的值；空体返回 `undefined`。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  return JSON.parse(text)
}

/**
 * 回一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} payload - 载荷。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 把 store 暴露成同源的 JSON 接口。
 *
 * 只做转发与形状校验，业务规则都在 `HunterStore` 里（工具走同一批方法）。
 *
 * @param {() => HunterStore} getStore - 取已就绪的 store；未就绪时抛错（→ 400/503）。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createApiHandler(getStore) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 前缀路由：把 `/infohunter` 去掉，剩下的就是端点。
    const endpoint = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    const sessionId = url.searchParams.get('sessionId') ?? ''

    try {
      // ── 版本 ──────────────────────────────────────────────────────────
      // 静态信息，不依赖 store，所以放在 getStore() 之前：面板一挂上就能显示版本。
      if (endpoint === '/version' && method === 'GET') {
        const onDisk = readManifestFromDisk()
        return sendJson(res, 200, {
          name: MANIFEST.name,
          // 已加载模块的版本 —— 面板显示这个。
          version: MANIFEST.version,
          // 磁盘上的版本 —— 与上面不同就说明装过新版本但还没重启。
          onDisk: onDisk?.version ?? '',
        })
      }

      // ── 变更令牌 ──────────────────────────────────────────────────────
      if (endpoint === '/rev' && method === 'GET') {
        return sendJson(res, 200, { rev: getStore().rev(sessionId) })
      }

      const store = getStore()

      // ── 配置（全局） ──────────────────────────────────────────────────
      if (endpoint === '/config' && method === 'GET') {
        return sendJson(res, 200, { config: store.config() })
      }
      if (endpoint === '/config' && method === 'POST') {
        const body = await readJsonBody(req)
        const entries = body !== null && typeof body === 'object' ? body.entries : undefined
        const config = await store.saveConfig(entries)
        // 配置是这堆技能目录的唯一引用来源：行没了，目录也得没。
        // 面板允许"放弃修改"，所以上传过但没保存的行会在这里被回收。
        const keep = new Set(config.entries.filter((entry) => entry.type === 'skill').map((entry) => entry.id))
        await pruneSkillDirs(skillsDir(), keep).catch(() => [])
        return sendJson(res, 200, { config })
      }

      // ── 技能包上传（按行 id 落地，覆盖即更新）───────────────────────────
      if (endpoint === '/skills/upload' && method === 'POST') {
        const rowId = assertRowId(url.searchParams.get('id'))
        const archive = await readRawBody(req, SKILL_LIMITS.archive)
        const meta = await installSkillZip(archive, skillsDir(), rowId)
        return sendJson(res, 200, { ok: true, ...meta, uploadedAt: new Date().toISOString() })
      }

      // ── 资产（按会话） ────────────────────────────────────────────────
      //
      // 只读。**资产与采集记录都不提供删除/清空端点**：收集到的东西是证据，
      // 面板上能删就意味着证据可以被悄悄改掉。要重来就让用户开新会话。
      if (endpoint === '/assets' && method === 'GET') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const page = store.pageAssets(sessionId, {
          q: url.searchParams.get('q') ?? '',
          category: url.searchParams.get('category') ?? '',
          nodeType: url.searchParams.get('nodeType') ?? '',
          facet: url.searchParams.get('facet') ?? '',
          offset: url.searchParams.get('offset') ?? '0',
          limit: url.searchParams.get('limit') ?? '',
        })
        // 计划与覆盖度顺带带出去：面板进度条跟资产同一次请求刷新，不多一个轮询。
        return sendJson(res, 200, {
          page,
          overview: store.overviewAssets(sessionId),
          plan: store.plan(sessionId),
          coverage: store.coverage(sessionId),
          rev: store.rev(sessionId),
        })
      }

      // ── 问题池（按会话）─────────────────────────────────────────────
      //
      // 判定不了的系统对（只命中一项信号）放这里，任务收尾时由 agent 统一问，
      // 或者用户在面板上直接裁决。
      if (endpoint === '/questions' && method === 'GET') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const status = url.searchParams.get('status') ?? 'open'
        return sendJson(res, 200, { questions: store.questionsOf(sessionId, status), rev: store.rev(sessionId) })
      }
      if (endpoint === '/questions/resolve' && method === 'POST') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const body = await readJsonBody(req)
        const id = body !== null && typeof body === 'object' ? body.id : undefined
        const choice = body !== null && typeof body === 'object' ? body.choice : undefined
        if (typeof id !== 'string' || id === '') {
          return sendJson(res, 400, { error: { code: 'bad-request', message: 'id 必填' } })
        }
        const resolved = await store.resolveQuestion(sessionId, id, choice, 'user')
        if (resolved === undefined) {
          return sendJson(res, 404, { error: { code: 'not-found', message: '问题不存在或 choice 非法' } })
        }
        return sendJson(res, 200, { question: resolved, rev: store.rev(sessionId) })
      }

      // ── 系统合并 / 拆分（人工调整，可逆）─────────────────────────────
      if (endpoint === '/apps/merge' && method === 'POST') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const body = await readJsonBody(req)
        const parent = body !== null && typeof body === 'object' ? body.parent : undefined
        const child = body !== null && typeof body === 'object' ? body.child : undefined
        if (typeof parent !== 'string' || typeof child !== 'string' || parent === '' || child === '') {
          return sendJson(res, 400, { error: { code: 'bad-request', message: 'parent 与 child 必填' } })
        }
        const merged = await store.mergeApps(sessionId, parent, child)
        if (merged === undefined) {
          return sendJson(res, 404, { error: { code: 'not-found', message: '找不到这两个系统节点' } })
        }
        return sendJson(res, 200, { app: merged, rev: store.rev(sessionId) })
      }
      if (endpoint === '/apps/split' && method === 'POST') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const body = await readJsonBody(req)
        const key = body !== null && typeof body === 'object' ? body.key : undefined
        if (typeof key !== 'string' || key === '') {
          return sendJson(res, 400, { error: { code: 'bad-request', message: 'key 必填' } })
        }
        const ok = await store.splitApp(sessionId, key)
        return sendJson(res, 200, { ok, rev: store.rev(sessionId) })
      }

      // ── 关联域名/IP（按会话，从已有资产与记录算）─────────────────────
      if (endpoint === '/assets/relations' && method === 'GET') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const key = url.searchParams.get('key') ?? ''
        if (key === '') return sendJson(res, 400, { error: { code: 'bad-request', message: 'key 必填' } })
        return sendJson(res, 200, { relations: store.relationsOf(sessionId, key) })
      }

      // ── 最近使用的过滤语句（全局，不分会话）───────────────────────────
      //
      // 这是面板偏好而不是证据：所以**允许**删除与清空，和资产/记录的只读语义无关。
      if (endpoint === '/queries' && method === 'GET') {
        return sendJson(res, 200, { queries: store.recentQueries() })
      }
      if (endpoint === '/queries' && method === 'POST') {
        const body = await readJsonBody(req)
        const q = body !== null && typeof body === 'object' ? body.q : undefined
        return sendJson(res, 200, { queries: await store.recordQuery(q) })
      }
      if (endpoint === '/queries/drop' && method === 'POST') {
        const body = await readJsonBody(req)
        const q = body !== null && typeof body === 'object' ? body.q : undefined
        return sendJson(res, 200, { queries: await store.forgetQuery(q) })
      }
      if (endpoint === '/queries/clear' && method === 'POST') {
        return sendJson(res, 200, { queries: await store.clearQueries() })
      }

      // ── 信息产物（按会话）─────────────────────────────────────────────
      //
      // 只读列表 + 重扫。产物是证据，同样**不提供删除端点**。
      if (endpoint === '/artifacts' && method === 'GET') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const page = store.pageArtifacts(sessionId, {
          kind: url.searchParams.get('kind') ?? '',
          q: url.searchParams.get('q') ?? '',
          severity: url.searchParams.get('severity') ?? '',
          offset: url.searchParams.get('offset') ?? '0',
          limit: url.searchParams.get('limit') ?? '',
        })
        return sendJson(res, 200, { page, overview: store.overviewArtifacts(sessionId), rev: store.rev(sessionId) })
      }
      if (endpoint === '/artifacts/rescan' && method === 'POST') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const updated = await store.rescanArtifacts(sessionId)
        return sendJson(res, 200, { updated, rev: store.rev(sessionId) })
      }

      // ── 设置（全局，section 化，未知 section 原样保留）────────────────
      if (endpoint === '/settings' && method === 'GET') {
        return sendJson(res, 200, { settings: store.settings() })
      }
      if (endpoint === '/settings' && method === 'POST') {
        const body = await readJsonBody(req)
        const section = body !== null && typeof body === 'object' ? body.section : undefined
        const value = body !== null && typeof body === 'object' ? body.value : undefined
        const settings = await store.saveSettings(section, value)
        return sendJson(res, 200, { settings })
      }

      // ── 采集记录（按会话，一行一次观测）──────────────────────────────
      if (endpoint === '/records' && method === 'GET') {
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'missing-session', message: 'sessionId 必填' } })
        const page = store.pageRecords(sessionId, {
          kind: url.searchParams.get('kind') ?? '',
          source: url.searchParams.get('source') ?? '',
          q: url.searchParams.get('q') ?? '',
          offset: url.searchParams.get('offset') ?? '0',
          limit: url.searchParams.get('limit') ?? '',
        })
        return sendJson(res, 200, { page, overview: store.overviewRecords(sessionId), rev: store.rev(sessionId) })
      }

      return sendJson(res, 404, { error: { code: 'not-found', message: `未知端点 ${method} ${endpoint}` } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notReady = message.includes('存储尚未就绪')
      return sendJson(res, notReady ? 503 : 400, { error: { code: notReady ? 'not-ready' : 'failed', message } })
    }
  }
}

/**
 * 激活 Host 半。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 注入了 `storage` 的上下文。
 * @param {{ database?: string }} [config] - 行配置。
 */
export function apply(ctx, config = {}) {
  const databasePath = resolveDatabasePath(config.database)
  const backend = new SqliteKvBackend(databasePath)

  /** @type {HunterStore | undefined} */
  let store
  /** 初始化完成（可能失败）的 promise，路由等它。 */
  const ready = (async () => {
    const unit = await backend.kv.open({
      name: UNIT_NAME,
      version: UNIT_VERSION,
      tables: TABLES,
      hasGlobal: false,
    })
    store = new HunterStore(unit)
    await store.load()
    ctx.provide('infohunterStore', store)
    return store
  })()

  // 失败要响，但不要连累整行：路由会以 503 说明原因，工具栏照常可用。
  ready.catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[infohunter] 存储初始化失败（${databasePath}）：${message}`)
  })

  // 后端注册是 effect：卸载时先摘名字再关连接。
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register(BACKEND_NAME, backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'infohunter.registerBackend')

  // Web 层可选，但**必须等它就绪**。
  //
  // 这里原来是 `const webServer = ctx.get('webServer')` —— 在 apply 那一刻只探一次。
  // `webServer` 刻意没写进 `inject`（headless profile 没有它，写进去会让整行挂不上），
  // 于是激活顺序上它**不保证此刻已经注册**；拿不到就静默跳过注册、永不重试。
  // 现场表现就是：数据库正常建好、工具正常注册，但面板 API 永远 404，
  // 而宿主侧没有任何报错。真实故障正是如此。
  // `ctx.inject` 会等这个服务出现后再跑回调；缺失时只是回调不跑，父插件照常激活。
  const handle = createApiHandler(() => {
    if (store === undefined) throw new Error('存储尚未就绪')
    return store
  })

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
      'infohunter.registerRoutes',
    )
    ctx.logger?.info?.(`[infohunter] 面板接口已挂在 ${ROUTE_PREFIX}（数据库 ${databasePath}）`)
  })
}
