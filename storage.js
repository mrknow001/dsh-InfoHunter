/**
 * 暴露面收集的持久层：一个自带的 SQLite KV 后端 + 配置/结果门面。
 *
 * ## 为什么自己写后端，而不是用 `@deepseek-ai/dsh-storage-sqlite`
 *
 * 官方后端把注册名写死成 `sqlite`，而 `ctx.storage.backend.register(name, …)` 对重名**硬失败**
 * （`duplicate-backend`）。本机 profile 里 `@howmp/dsh-pentest` 已经用同名注册了它的
 * vendored 后端，官方那个会整行启动失败 —— 组件列表里一行「异常」，随后依赖它的域全部
 * `backend-not-found`。所以本包注册自己的名字 `infohunter-sqlite`。
 *
 * ## 为什么不用 `storageDomain`
 *
 * 域层要求 `zod` 的 `valueSchema`（多一个运行时依赖），而且要在 profile 里 override
 * `storage-domain` 的 `routes` —— 而补丁的 `config` 是**整体替换**，那会连带抹掉
 * pentest / zerozen 的 storage 路由。所以这里直接用后端注册表的公开面
 * （`StorageBackend` / `KvFacet` / `KvUnit`，见 `ctx.storage` 的类型声明），
 * 自己持有 unit：没有 zod、不改任何共享行、名字也归自己。
 *
 * @module @infohunter/dsh-information-hunter/storage
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { SHAPE_OTHER_MAX, asCapabilities, asInputMode, asPurpose, asShapes } from './vocabulary.js'
import {
  DEFAULT_SENSITIVE_RULES, compileRules, fingerprintOf, normalizeArtifact, scanText,
} from './artifacts.js'
import { coverageOf } from './coverage.js'
import {
  DIRECTION_LIMIT, DIRECTION_STATES, clueKey, directionKey, findingKey, summarize,
} from './graph.js'
import { emptyPlan, normalizePlan } from './plan.js'
import {
  CATEGORIES, PROTOCOL_FAMILIES, URLS_LIMIT, WEB_STATUS_FACETS, assetKey, asVerdict, matchQuery, mergeAsset,
  mergeUrlEvidence, nodesFromRecord, normalizeAsset, parseQuery, protocolFamily, splitEndpoint,
} from './assets.js'
import { appKeyOf, collectQuestions, judgeSameSystem } from './system.js'

/** 本包后端在 storage hub 上注册的名字（必须全局唯一）。 */
export const BACKEND_NAME = 'infohunter-sqlite'
/** 本包占用的 unit（域）名。 */
export const UNIT_NAME = 'infohunter'
/** unit 布局版本：改动表结构时递增。 */
function splitUrlHost(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(String(url))
  return match === null ? '' : match[1].toLowerCase()
}

export const UNIT_VERSION = 7

/** unit 与表名只允许这些字符（它们会进 SQL 标识符）。 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

/** 配置表里唯一那一行的 key。 */
const CONFIG_KEY = 'global'

/**
 * 一个 unit 的物理表名。
 *
 * 名字来自 `defineDomain` 之外的我们自己的描述符，进 SQL 前已用 `NAME_RE` 校验过，
 * 因此可以安全插值。
 *
 * @param unit - unit 名。
 * @param table - 表名。
 * @returns 物理表名。
 */
function tableNameOf(unit, table) {
  return `u_${unit}_${table}`
}

/**
 * SQLite 支撑的 KV 后端（只实现 `kv` 这一个 facet）。
 */
export class SqliteKvBackend {
  /** @type {import('node:sqlite').DatabaseSync | undefined} */
  #db
  /** 已打开的 unit；存在即代表占用（双开是调用方 bug）。 */
  #units = new Map()
  #closing
  #closed = false

  /**
   * @param {string} path - 数据库文件路径，或 `:memory:`。
   */
  constructor(path) {
    this.path = path
    /** storage hub 需要的 facet 形状。 */
    this.kv = { open: (descriptor) => this.#openUnit(descriptor) }
  }

  /** 打开（或复用）连接。 */
  #database() {
    if (this.#db !== undefined) return this.#db
    const path = this.path === ':memory:' ? ':memory:' : this.path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE IF NOT EXISTS units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT')
    db.exec('CREATE TABLE IF NOT EXISTS unit_globals (unit TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    this.#db = db
    return db
  }

  /**
   * 打开一个 unit，按需建表并校验版本戳。
   *
   * @param {{ name: string, version: number, tables: readonly string[], hasGlobal?: boolean }} descriptor
   * @returns {Promise<object>} `KvUnit`。
   */
  async #openUnit(descriptor) {
    if (this.#closed) throw new Error('infohunter-sqlite 已关闭')
    const { name, version, tables } = descriptor
    if (!NAME_RE.test(name)) throw new Error(`unit 名不合法：${name}`)
    for (const table of tables) if (!NAME_RE.test(table)) throw new Error(`表名不合法：${table}（unit ${name}）`)
    if (this.#units.has(name)) throw new Error(`unit ${name} 已打开（双开是调用方 bug）`)

    const db = this.#database()
    const row = db.prepare('SELECT version FROM units WHERE name = ?').get(name)
    if (row === undefined) {
      db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(name, version)
    } else if (row.version > version) {
      // 介质比代码新：拒绝读，避免用旧 schema 解释新数据。
      throw new Error(`unit ${name} 在介质上是版本 ${row.version}，比代码的 ${version} 新`)
    } else if (row.version < version) {
      // 向前迁移：建表是幂等的，缺的表补上，然后更新版本戳。
      db.prepare('UPDATE units SET version = ? WHERE name = ?').run(version, name)
    }
    for (const table of tables) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${tableNameOf(name, table)}" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`)
    }

    const unit = new SqliteKvUnit(db, name, tables, descriptor.hasGlobal === true, () => {
      this.#units.delete(name)
    })
    this.#units.set(name, unit)
    return unit
  }

  /**
   * 关闭所有 unit 并释放连接。幂等。
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#closing = (async () => {
      for (const unit of [...this.#units.values()]) {
        try {
          await unit.close()
        } catch {
          /* 关闭阶段不因单个 unit 失败而中断 */
        }
      }
      this.#units.clear()
      try {
        this.#db?.close()
      } catch {
        /* 已关闭 */
      }
      this.#db = undefined
    })()
    return this.#closing
  }
}

/**
 * 一个打开的 unit：按表预编译语句，值以 JSON 文本存进 `value` 列。
 */
class SqliteKvUnit {
  #statements = new Map()
  #closed = false

  /**
   * @param {import('node:sqlite').DatabaseSync} db - 后端持有的连接（不在这里关闭）。
   * @param {string} name - unit 名。
   * @param {readonly string[]} tables - 表名列表。
   * @param {boolean} hasGlobal - 是否有 global 槽。
   * @param {() => void} onClose - 释放占用槽的回调。
   */
  constructor(db, name, tables, hasGlobal, onClose) {
    this.db = db
    this.name = name
    this.tables = tables
    this.hasGlobal = hasGlobal
    this.onClose = onClose
  }

  #assertOpen() {
    if (this.#closed) throw new Error(`unit ${this.name} 已关闭`)
  }

  #statementsFor(table) {
    let statements = this.#statements.get(table)
    if (statements === undefined) {
      const physical = tableNameOf(this.name, table)
      statements = {
        selectAll: this.db.prepare(`SELECT key, value FROM "${physical}"`),
        upsert: this.db.prepare(
          `INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ),
        remove: this.db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
      }
      this.#statements.set(table, statements)
    }
    return statements
  }

  /**
   * @returns {Promise<{ tables: Record<string, Record<string, unknown>>, global: unknown }>}
   */
  async loadAll() {
    this.#assertOpen()
    const tables = {}
    for (const table of this.tables) {
      /** @type {Record<string, unknown>} */
      const records = {}
      for (const row of this.#statementsFor(table).selectAll.all()) {
        records[row.key] = JSON.parse(row.value)
      }
      tables[table] = records
    }
    let global = null
    if (this.hasGlobal) {
      const row = this.db.prepare('SELECT value FROM unit_globals WHERE unit = ?').get(this.name)
      if (row !== undefined) global = JSON.parse(row.value)
    }
    return { tables, global }
  }

  /**
   * @param {string} table - 表名。
   * @param {string} key - 记录 key。
   * @param {unknown} value - 记录值（JSON 可序列化）。
   * @returns {Promise<void>}
   */
  async putRecord(table, key, value) {
    this.#assertOpen()
    this.#statementsFor(table).upsert.run(key, JSON.stringify(value))
  }

  /**
   * @param {string} table - 表名。
   * @param {string} key - 记录 key。
   * @returns {Promise<void>}
   */
  async deleteRecord(table, key) {
    this.#assertOpen()
    this.#statementsFor(table).remove.run(key)
  }

  /**
   * @param {unknown} value - global 槽的值。
   * @returns {Promise<void>}
   */
  async setGlobal(value) {
    this.#assertOpen()
    if (!this.hasGlobal) throw new Error(`unit ${this.name} 没有 global 槽`)
    this.db
      .prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value')
      .run(this.name, JSON.stringify(value))
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#statements.clear()
    this.onClose()
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 配置与结果的形状（手写校验：没有 zod，也不需要一个通用校验库）
// ────────────────────────────────────────────────────────────────────────────

/** 一条配置行的公共字段。 */
const ENTRY_DEFAULTS = { name: '', enabled: true, note: '', purpose: 'other' }

/**
 * 把任意来源的一行配置收敛成规范形状。
 *
 * 两种类型承载的"能做什么"语义不同：
 *   · **工具**是单一用途 —— 一个可执行文件干一件事，`purpose` 是单值；
 *   · **空间测绘**是综合查询 —— 一次查询同时出域名/IP/端口/协议/标题/指纹/证书，
 *     所以用 `capabilities` 多选表达"它能出哪些 kind"。
 * 两种 id 与结果的 `kind` 共用一套取值，模型据此决定缺哪类数据该问谁。
 *
 * 半成品（刚点加号、还没填路径）也要能落库，所以字段都给默认值；
 * 但"什么都没填"的空行会被丢弃，避免库里堆空行。
 *
 * @param {unknown} raw - 任意候选值。
 * @param {import('./vocabulary.js').ENTRY_TYPES[number]} type - 行类型。
 * @returns {object | undefined} 规范行，或 `undefined`（丢弃）。
 */
function normalizeEntry(raw, type) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)
  const id = typeof source.id === 'string' && source.id.trim() !== '' ? source.id.trim().slice(0, 64) : undefined
  if (id === undefined) return undefined
  const base = {
    id,
    type,
    name: typeof source.name === 'string' ? source.name.slice(0, 200) : ENTRY_DEFAULTS.name,
    enabled: source.enabled !== false,
    note: typeof source.note === 'string' ? source.note.slice(0, 2000) : ENTRY_DEFAULTS.note,
    // 形态：这行吃什么、吐什么。多工具协同全靠它对上号，空着表示"未声明"。
    inputs: asShapes(source.inputs),
    outputs: asShapes(source.outputs),
    inputsOther: typeof source.inputsOther === 'string' ? source.inputsOther.slice(0, SHAPE_OTHER_MAX) : '',
    outputsOther: typeof source.outputsOther === 'string' ? source.outputsOther.slice(0, SHAPE_OTHER_MAX) : '',
    // 多个输入之间的条件关系（任一即可 / 需同时 / 自定义说明）。
    inputMode: asInputMode(source.inputMode) ?? 'or',
    inputModeNote: typeof source.inputModeNote === 'string' ? source.inputModeNote.slice(0, SHAPE_OTHER_MAX) : '',
  }
  if (type === 'tool') {
    const path = typeof source.path === 'string' ? source.path.slice(0, 2000) : ''
    const description = typeof source.description === 'string' ? source.description.slice(0, 8000) : ''
    if (path.trim() === '' && description.trim() === '' && base.inputs.length === 0 && base.outputs.length === 0) {
      return undefined
    }
    return { ...base, type: 'tool', purpose: asPurpose(source.purpose) ?? ENTRY_DEFAULTS.purpose, path, description }
  }
  if (type === 'skill') {
    // 技能行的"真相"在磁盘上（`<skillsDir>/<id>/SKILL.md`）；这里存的只是上传时抓到的
    // 摘要，用来在面板和 `expose_config` 里显示，不参与注册 —— 注册一律现读磁盘，
    // 免得库里留着一份和文件不一致的描述。
    const skillName = typeof source.skillName === 'string' ? source.skillName.slice(0, 80) : ''
    const description = typeof source.description === 'string' ? source.description.slice(0, 800) : ''
    const files = Number.isFinite(source.files) ? Math.max(0, Math.trunc(source.files)) : 0
    const bytes = Number.isFinite(source.bytes) ? Math.max(0, Math.trunc(source.bytes)) : 0
    const uploadedAt = typeof source.uploadedAt === 'string' ? source.uploadedAt.slice(0, 40) : ''
    // 技能行永远保留：它是"上传"这个动作产生的，删掉目录不代表要删行。
    return { ...base, type: 'skill', skillName, description, files, bytes, uploadedAt, inputs: [], outputs: [] }
  }
  if (type === 'mcp') {
    // MCP 行：连一个 server，把它暴露的工具全部注册进来。
    // stdio 与 http 两种传输的字段互斥，所以只在对应传输下保留对应字段。
    const transport = source.transport === 'http' ? 'http' : 'stdio'
    const command = typeof source.command === 'string' ? source.command.slice(0, 2000) : ''
    const cwd = typeof source.cwd === 'string' ? source.cwd.slice(0, 2000) : ''
    const url = typeof source.url === 'string' ? source.url.slice(0, 2000) : ''
    const args = argList(source.args)
    const env = mapValue(source.env, 64, 2000)
    const headers = mapValue(source.headers, 64, 4000)
    const transportOk = transport === 'http' ? url.trim() !== '' : command.trim() !== ''
    // 和工具行一致：没填"能连上什么"的行直接丢弃，别在库里堆半成品。
    if (!transportOk) return undefined
    return {
      ...base,
      type: 'mcp',
      transport,
      command: transport === 'stdio' ? command : '',
      args: transport === 'stdio' ? args : [],
      env: transport === 'stdio' ? env : {},
      cwd: transport === 'stdio' ? cwd : '',
      url: transport === 'http' ? url : '',
      headers: transport === 'http' ? headers : {},
      inputs: [],
      outputs: [],
    }
  }
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.slice(0, 2000) : ''
  const key = typeof source.key === 'string' ? source.key.slice(0, 4000) : ''
  const apiDoc = typeof source.apiDoc === 'string' ? source.apiDoc.slice(0, 8000) : ''
  const remark = typeof source.remark === 'string' ? source.remark.slice(0, 2000) : ''
  // 老行（单选 `purpose` 时代写下的）迁到多选：把原来那一个用途当作唯一勾选。
  const capabilities = Array.isArray(source.capabilities)
    ? asCapabilities(source.capabilities)
    : asCapabilities(asPurpose(source.purpose) === undefined ? [] : [source.purpose])
  // 勾了能力也算"有内容"：否则用户先勾数据种类、还没来得及填 BaseURL 就保存，
  // 这一行会被当成空行丢掉，勾选白做。
  if (
    baseUrl.trim() === '' && key.trim() === '' && apiDoc.trim() === '' && capabilities.length === 0
    && base.inputs.length === 0
  ) return undefined
  // 空间测绘的「输出」就是 `capabilities`（一次查询能出哪些数据）——
  // 再给一个 outputs 多选是重复的第二个真相，所以这里显式清掉。
  return {
    ...base, type: 'mapping', capabilities, baseUrl, key, apiDoc, remark, outputs: [], outputsOther: '',
  }
}

/**
 * 收敛成"字符串 → 字符串"的 Map（MCP 的 env / headers）。
 *
 * @param value - 任意对象。
 * @param countMax - 最多几项。
 * @param lengthMax - 每个值多长。
 * @returns `Record<string, string>`
 */
function stringMap(value, countMax, lengthMax) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= countMax) break
    const key = String(rawKey).trim().slice(0, 200)
    if (key === '') continue
    if (rawValue === null || typeof rawValue === 'object') continue
    out[key] = String(rawValue).slice(0, lengthMax)
    count += 1
  }
  return out
}

/**
 * 面板给过来的 `KEY=VALUE` 多行文本 → 对象。
 *
 * 让用户按行填比写 JSON 少出错；值里允许出现 `=`（只按第一个切）。
 *
 * @param text - 多行文本。
 * @param countMax - 最多几项。
 * @param lengthMax - 每个值多长。
 * @returns `Record<string, string>`
 */
function parseMapLines(text, countMax, lengthMax) {
  const out = {}
  let count = 0
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (count >= countMax) break
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim().slice(0, 200)
    if (key === '') continue
    out[key] = trimmed.slice(at + 1).trim().slice(0, lengthMax)
    count += 1
  }
  return out
}

/**
 * env / headers 既接受对象，也接受面板传来的多行文本。
 *
 * @param value - 任意值。
 * @param countMax - 最多几项。
 * @param lengthMax - 每个值多长。
 * @returns `Record<string, string>`
 */
function mapValue(value, countMax, lengthMax) {
  return typeof value === 'string' ? parseMapLines(value, countMax, lengthMax) : stringMap(value, countMax, lengthMax)
}

/**
 * MCP 的参数列表：既接受数组，也接受"一行一个参数"。
 *
 * @param value - 任意值。
 * @returns string[]
 */
function argList(value) {
  if (Array.isArray(value)) return nameList(value, 64, 2000)
  if (typeof value !== 'string') return []
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').slice(0, 64)
}

/**
 * 归一化整份配置行数组。
 *
 * @param {unknown} rawEntries - 任意数组。
 * @returns {object[]} 规范行（坏行与空行被丢弃）。
 */
export function normalizeEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return []
  const out = []
  const seen = new Set()
  for (const raw of rawEntries) {
    const declared = raw !== null && typeof raw === 'object' ? raw.type : undefined
    const type = declared === 'mapping' ? 'mapping' : declared === 'skill' ? 'skill' : declared === 'mcp' ? 'mcp' : 'tool'
    const entry = normalizeEntry(raw, type)
    // id 是唯一键：重复 id 会让面板的两行互相覆盖，直接取第一条。
    if (entry === undefined || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

/** 结果分页的默认与上限。 */
export const DEFAULT_PAGE = 100
export const MAX_PAGE = 500

/** 「最近使用」语句的上限：超出按最久未用淘汰。 */
export const MAX_RECENT_QUERIES = 5

/**
 * 把来源收敛成去重后的名字数组。
 *
 * @param value - 数组或分隔串。
 * @param {number} countMax - 最多几个。
 * @param {number} lengthMax - 每个多长。
 * @returns {string[]}
 */
function nameList(value, countMax, lengthMax) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    for (const piece of item.split(/[+、,，;；]|\s{2,}/)) {
      const name = piece.trim()
      if (name === '') continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(name.slice(0, lengthMax))
      if (out.length >= countMax) return out
    }
  }
  return out
}

/**
 * 归一化一条采集记录。
 *
 * 记录是**一行一次观测**：`kind` 是观测类型（子域/端口/Web/指纹…），`asset` 是被观测到的东西，
 * `detail` 放证据原文。它只追加、不合并 —— 合并发生在资产表（`normalizeAsset`）。
 *
 * @param {unknown} raw - 任意候选值。
 * @returns {object | undefined} 规范记录，或 `undefined`（缺 asset）。
 */
export function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)
  const asset = typeof source.asset === 'string' ? source.asset.trim() : ''
  if (asset === '') return undefined
  const kind = typeof source.kind === 'string' && source.kind.trim() !== '' ? source.kind.trim().slice(0, 40) : 'other'
  const confidence =
    typeof source.confidence === 'number' && Number.isFinite(source.confidence)
      ? Math.min(100, Math.max(0, Math.round(source.confidence)))
      : null
  /** 结构化字段：记录也留一份，采集记录视图才能显示"更详细"的内容。 */
  const cert = source.cert !== null && typeof source.cert === 'object' ? source.cert : {}
  return {
    target: typeof source.target === 'string' ? source.target.slice(0, 300) : '',
    kind,
    asset: asset.slice(0, 400),
    detail: typeof source.detail === 'string' ? source.detail.slice(0, 8000) : '',
    status: typeof source.status === 'number' && Number.isFinite(source.status) ? Math.trunc(source.status) : 0,
    title: typeof source.title === 'string' ? source.title.slice(0, 500) : '',
    server: typeof source.server === 'string' ? source.server.slice(0, 200) : '',
    tech: nameList(source.tech, 24, 80),
    // 解析结果要留在记录上：面板的「关联域名·IP」历史区只认结构化值，
    // 不去 detail 自由文本里正则捞 IP（那会把证据当结论）。
    ip: typeof source.ip === 'string' ? source.ip.slice(0, 64) : '',
    cname: typeof source.cname === 'string' ? source.cname.slice(0, 253) : '',
    certIssuer: typeof cert.issuer === 'string' ? cert.issuer.slice(0, 300) : '',
    service: typeof source.service === 'string' ? source.service.slice(0, 80) : '',
    version: typeof source.version === 'string' ? source.version.slice(0, 120) : '',
    note: typeof source.note === 'string' ? source.note.slice(0, 4000) : '',
    sources: nameList(source.sources ?? source.source, 8, 60),
    confidence,
    verdict: asVerdict(source.verdict ?? source.mark),
    // 响应头与正文也随记录留一份，采集记录里能直接看原文。
    headers: typeof source.headers === 'string' ? source.headers.slice(0, 2000) : '',
    body: typeof source.body === 'string' ? source.body.slice(0, 8000) : '',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Store：把 unit 包装成"配置 + 采集记录 + 资产"三件事
// ────────────────────────────────────────────────────────────────────────────

/**
 * 配置与资产的唯一门面。
 *
 * 内存是读侧权威（`loadAll` 一次性灌入），写入走 `putRecord` 直落介质。
 * 变更令牌（rev）是内存计数：面板轮询它决定要不要重取 —— 不引入订阅/推送。
 */
export class HunterStore {
  #config = { version: 1, updatedAt: '', entries: [] }
  /** @type {Set<(doc: object) => void>} 配置变更订阅（技能注册用）。 */
  #configListeners = new Set()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${id}` → 采集记录（一行一次观测） */
  #records = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${host}:${port}` → 资产 */
  #assets = new Map()
  /** @type {Map<string, { q: string, count: number, lastUsedAt: number }>} 语句原文 → 使用统计（全局） */
  #queries = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${id}` → 问题池条目（按会话） */
  #questions = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${fingerprint}` → 信息产物（按会话） */
  #artifacts = new Map()
  /** @type {Map<string, object>} section id → 全局设置（不分会话） */
  #settings = new Map()
  /** @type {Map<string, number>} sessionId → rev（产物） */
  #artifactRevs = new Map()
  /** @type {Map<string, object>} sessionId → 计划 */
  #plans = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${id}` → 派活记录 */
  #tasks = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${assetKey}:${sourceKind}` → 锚点 */
  #links = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${id}` → 探索图节点 */
  #nodes = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${from}:${rel}:${to}` → 边 */
  #edges = new Map()
  #nodeSeq = 0
  #configRev = 0
  /** @type {Map<string, number>} sessionId → rev */
  #assetRevs = new Map()
  /** @type {Map<string, number>} sessionId → rev */
  #recordRevs = new Map()
  /** @type {Map<string, number>} sessionId → 已用最大序号 */
  #seqs = new Map()

  /**
   * @param {object} unit - 已打开的 `KvUnit`。
   */
  constructor(unit) {
    this.unit = unit
  }

  /** 从介质读入全部状态。 */
  async load() {
    const { tables } = await this.unit.loadAll()
    const configRow = tables.config?.[CONFIG_KEY]
    if (configRow !== null && typeof configRow === 'object') {
      this.#config = {
        version: 1,
        updatedAt: typeof configRow.updatedAt === 'string' ? configRow.updatedAt : '',
        entries: normalizeEntries(configRow.entries),
      }
    }
    this.#assets.clear()
    for (const [key, row] of Object.entries(tables.assets ?? {})) {
      if (row === null || typeof row !== 'object') continue
      this.#assets.set(key, row)
    }
    // 面板「最近使用」的过滤语句（全局，不分会话）。
    this.#queries.clear()
    for (const [key, row] of Object.entries(tables.queries ?? {})) {
      if (row === null || typeof row !== 'object') continue
      const q = typeof row.q === 'string' ? row.q : key
      if (q.trim() === '') continue
      this.#queries.set(q, {
        q,
        count: Number.isFinite(row.count) ? Math.max(1, Math.trunc(row.count)) : 1,
        lastUsedAt: Number.isFinite(row.lastUsedAt) ? row.lastUsedAt : 0,
      })
    }
    // 上限可能被调小过：加载时就收一次，别等用户下次查询才淘汰。
    await this.#trimQueries()
    // 信息产物（按会话）+ 全局设置（section 化，未知 section 原样保留）。
    this.#artifacts.clear()
    for (const [key, row] of Object.entries(tables.artifacts ?? {})) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.fingerprint !== 'string' || typeof row.sessionId !== 'string') continue
      this.#artifacts.set(key, {
        id: typeof row.id === 'string' ? row.id : row.fingerprint.slice(0, 16),
        sessionId: row.sessionId,
        kind: normalizeArtifact({ title: 'x', content: 'x', kind: row.kind })?.kind ?? 'other',
        title: typeof row.title === 'string' ? row.title : '',
        content: typeof row.content === 'string' ? row.content : '',
        source: row.source !== null && typeof row.source === 'object' ? row.source : { name: '', type: 'tool', url: '' },
        howFound: typeof row.howFound === 'string' ? row.howFound : '',
        url: typeof row.url === 'string' ? row.url : '',
        host: typeof row.host === 'string' ? row.host : '',
        verdict: typeof row.verdict === 'string' ? row.verdict : '',
        confidence: Number.isFinite(row.confidence) ? row.confidence : null,
        hits: Array.isArray(row.hits) ? row.hits : [],
        severity: typeof row.severity === 'string' ? row.severity : '',
        fingerprint: row.fingerprint,
        count: Number.isFinite(row.count) ? Math.max(1, Math.trunc(row.count)) : 1,
        firstSeen: Number.isFinite(row.firstSeen) ? row.firstSeen : 0,
        lastSeen: Number.isFinite(row.lastSeen) ? row.lastSeen : 0,
      })
    }
    this.#settings.clear()
    for (const [section, value] of Object.entries(tables.settings ?? {})) {
      if (value === null || typeof value !== 'object') continue
      this.#settings.set(section, value)
    }
    // 首次启动播种默认规则：只有**没有** sensitve 这一节时才写，用户改过就不覆盖。
    if (!this.#settings.has('sensitive')) {
      const seeded = { enabled: true, rules: DEFAULT_SENSITIVE_RULES.map((rule) => ({ ...rule })) }
      this.#settings.set('sensitive', seeded)
      await this.unit.putRecord('settings', 'sensitive', seeded)
    }
    // 采集纪律：默认要求"没有探索方向就不许落库"；老会话可以在这里关掉。
    if (!this.#settings.has('collection')) {
      const seeded = { enforceDirection: true }
      this.#settings.set('collection', seeded)
      await this.unit.putRecord('settings', 'collection', seeded)
    }
    // 探索图：节点与边。
    this.#nodes.clear()
    this.#nodeSeq = 0
    for (const [key, row] of Object.entries(tables.nodes ?? {})) {
      if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string') continue
      this.#nodes.set(key, row)
      const seq = Number(row.seq) || 0
      if (seq > this.#nodeSeq) this.#nodeSeq = seq
    }
    this.#edges.clear()
    for (const [key, row] of Object.entries(tables.edges ?? {})) {
      if (row === null || typeof row !== 'object') continue
      this.#edges.set(key, row)
    }
    // 计划 / 派活 / 锚点。
    this.#plans.clear()
    for (const [key, value] of Object.entries(tables.plans ?? {})) {
      const sessionId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
      this.#plans.set(sessionId, normalizePlan(value))
    }
    this.#tasks.clear()
    for (const [key, row] of Object.entries(tables.tasks ?? {})) {
      if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string') continue
      this.#tasks.set(key, {
        id: String(row.id ?? key),
        sessionId: row.sessionId,
        target: typeof row.target === 'string' ? row.target : '',
        layer: typeof row.layer === 'string' ? row.layer : '',
        tool: typeof row.tool === 'string' ? row.tool : '',
        state: ['open', 'running', 'done', 'failed', 'skipped'].includes(row.state) ? row.state : 'open',
        owner: typeof row.owner === 'string' ? row.owner : '',
        result: row.result ?? null,
        error: typeof row.error === 'string' ? row.error : '',
        startedAt: Number.isFinite(row.startedAt) ? row.startedAt : 0,
        endedAt: Number.isFinite(row.endedAt) ? row.endedAt : 0,
      })
    }
    this.#links.clear()
    for (const [key, row] of Object.entries(tables.links ?? {})) {
      if (row === null || typeof row !== 'object') continue
      this.#links.set(key, row)
    }
    // 问题池（按会话）。
    this.#questions.clear()
    for (const [key, row] of Object.entries(tables.questions ?? {})) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || typeof row.sessionId !== 'string') continue
      this.#questions.set(key, {
        id: row.id,
        sessionId: row.sessionId,
        kind: typeof row.kind === 'string' ? row.kind : 'same-system',
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
        status: row.status === 'resolved' || row.status === 'dismissed' ? row.status : 'open',
        payload: row.payload !== null && typeof row.payload === 'object' ? row.payload : {},
        options: Array.isArray(row.options) ? row.options : [],
        resolvedChoice: typeof row.resolvedChoice === 'string' ? row.resolvedChoice : '',
        resolvedBy: typeof row.resolvedBy === 'string' ? row.resolvedBy : '',
        resolvedAt: Number.isFinite(row.resolvedAt) ? row.resolvedAt : 0,
      })
    }
    // 采集记录（旧的 `results` 表就是这个形状，直接接过来当记录用）。
    this.#records.clear()
    for (const [key, row] of Object.entries(tables.results ?? {})) {
      if (row === null || typeof row !== 'object') continue
      const normalized = normalizeRecord(row)
      if (normalized === undefined) continue
      const id = typeof row.id === 'string' ? row.id : key.slice(key.indexOf(':') + 1)
      this.#records.set(key, {
        id,
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
        ...normalized,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
      })
    }
    // 老库补「根路径 web 资产」：只要观测到 http/https，就应有 `scheme://host[:port]/`。
    // 幂等（已存在就跳过），所以每次加载跑一遍是安全的。
    this.rootBackfilled = await this.#backfillRootWebAssets()
    // 数据修复（幂等）：早期版本有两次"编数据"的痕迹，读取时就地纠正并落库。
    //  1. 迁移把老记录的 `detail`（自由文本备注）塞进了 `banner` —— 那些文本仍在采集记录里，清掉即可。
    //  2. 分类曾按端口号猜（443→web、22→服务），没有观测证据的也给了结论 —— 用新规则重算。
    const legacyDetails = new Set()
    for (const row of this.#records.values()) {
      if (typeof row.detail === 'string' && row.detail !== '') legacyDetails.add(row.detail)
    }
    for (const [physical, asset] of [...this.#assets]) {
      const fixed = { ...asset }
      let changed = false
      const banner = typeof asset.banner === 'string' ? asset.banner : ''
      if (banner !== '' && legacyDetails.has(banner)) {
        fixed.banner = ''
        changed = true
      }
      const recomputed = normalizeAsset({ ...asset, category: undefined })
      if (recomputed !== undefined && recomputed.category !== asset.category) {
        fixed.category = recomputed.category
        changed = true
      }
      if (!changed) continue
      await this.unit.putRecord('assets', physical, fixed)
      this.#assets.set(physical, fixed)
    }
    // 资产：由记录派生一次（幂等），保证只有记录也有清单。
    const now = Date.now()
    for (const row of this.#records.values()) {
      const sessionId = row.sessionId
      if (sessionId === '') continue
      const asset = legacyRowToAsset(row)
      if (asset === undefined) continue
      await this.#upsertOne(sessionId, asset, row.createdAt, row.createdAt)
    }
    void now
  }

  /** 当前配置文档。 */
  config() {
    return this.#config
  }

  /**
   * 整表覆盖保存配置行。
   *
   * @param {unknown} rawEntries - 面板传来的行数组。
   * @returns {Promise<object>} 落库后的文档。
   */
  async saveConfig(rawEntries) {
    const entries = normalizeEntries(rawEntries)
    const doc = { version: 1, updatedAt: new Date().toISOString(), entries }
    await this.unit.putRecord('config', CONFIG_KEY, doc)
    this.#config = doc
    this.#configRev += 1
    // 技能行要跟着配置变化重新注册（上传 / 删除 / 停用都不能等重启）。
    for (const listener of [...this.#configListeners]) {
      try {
        listener(doc)
      } catch {
        /* 监听方自己的问题，不能反过来让保存失败 */
      }
    }
    return doc
  }

  /**
   * 订阅配置变更。
   *
   * 只用于"改完要立刻生效"的用途（目前是上传技能的注册）；面板仍然用 rev 轮询。
   *
   * @param {(doc: object) => void} listener - 变更回调。
   * @returns {() => void} 取消订阅。
   */
  onConfigChange(listener) {
    if (typeof listener !== 'function') return () => {}
    this.#configListeners.add(listener)
    return () => { this.#configListeners.delete(listener) }
  }

  /**
   * 启用中的配置行（工具读的是这个）。
   *
   * @param {'tool'|'mapping'|undefined} type - 可选类型过滤。
   * @returns {object[]}
   */
  enabledEntries(type) {
    return this.#config.entries.filter((entry) => entry.enabled && (type === undefined || entry.type === type))
  }

  // ── 最近使用的过滤语句（全局，不分会话）────────────────────────────────
  //
  // 这是**面板偏好**，不是证据：所以它可以被删、被清空，和"资产/记录不允许删除"不冲突。

  /**
   * 「最近使用」列表，按最近使用倒序。
   *
   * @param {number} [limit] - 最多几条。
   * @returns {object[]} `{ q, count, lastUsedAt }[]`
   */
  recentQueries(limit = MAX_RECENT_QUERIES) {
    return [...this.#queries.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, Math.max(1, Math.trunc(limit)))
  }

  /**
   * 按上限淘汰最久未用的语句（内存与介质一起删）。
   *
   * @returns {Promise<void>}
   */
  async #trimQueries() {
    const overflow = this.recentQueries(Number.MAX_SAFE_INTEGER).slice(MAX_RECENT_QUERIES)
    for (const item of overflow) {
      this.#queries.delete(item.q)
      await this.unit.deleteRecord('queries', item.q).catch(() => undefined)
    }
  }

  /**
   * 严格单调的排序时间戳。
   *
   * `Date.now()` 在同一毫秒内会重复 —— 那样"最新的一条"就不确定了：连点两条语句时
   * 顺序会飘（smoke 里就偶发过）。这里保证新时间戳一定大于现有最大值。
   *
   * @returns {number}
   */
  #nextQueryStamp() {
    let max = 0
    for (const item of this.#queries.values()) if (item.lastUsedAt > max) max = item.lastUsedAt
    return Math.max(Date.now(), max + 1)
  }

  /**
   * 记一次语句使用：语法不合法或空白就不记（免得语句栏塞满坏例子）。
   *
   * @param {unknown} raw - 语句原文。
   * @returns {Promise<object[]>} 记完之后的最近列表。
   */
  async recordQuery(raw) {
    const q = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
    if (q === '' || q.length > 500) return this.recentQueries()
    if (parseQuery(q).ast === null) return this.recentQueries()
    const stamp = this.#nextQueryStamp()
    // 去重按小写：查询的值比较本来就是大小写不敏感的，回显保留原文。
    const existing = [...this.#queries.values()].find((item) => item.q.toLowerCase() === q.toLowerCase())
    if (existing !== undefined) {
      existing.count += 1
      existing.lastUsedAt = stamp
      await this.unit.putRecord('queries', existing.q, existing)
    } else {
      const row = { q, count: 1, lastUsedAt: stamp }
      this.#queries.set(q, row)
      await this.unit.putRecord('queries', q, row)
    }
    // 超上限：淘汰最久未用的那些。
    await this.#trimQueries()
    return this.recentQueries()
  }

  /**
   * 删掉一条。
   *
   * @param {unknown} raw - 语句原文。
   * @returns {Promise<object[]>} 删完之后的最近列表。
   */
  async forgetQuery(raw) {
    const q = typeof raw === 'string' ? raw.trim() : ''
    if (q === '') return this.recentQueries()
    this.#queries.delete(q)
    await this.unit.deleteRecord('queries', q).catch(() => undefined)
    return this.recentQueries()
  }

  /**
   * 清空全部。
   *
   * @returns {Promise<object[]>} 空数组。
   */
  async clearQueries() {
    for (const q of [...this.#queries.keys()]) {
      await this.unit.deleteRecord('queries', q).catch(() => undefined)
    }
    this.#queries.clear()
    return []
  }

  // ── 信息产物（云资源 / 泄露物 / API 文档 / 凭据 / 安装包…）──────────────

  /**
   * 当前的敏感信息规则（section 关掉时返回空数组 = 不扫描）。
   *
   * @returns {object[]} 已编译的规则。
   */
  #sensitiveRules() {
    const section = this.#settings.get('sensitive')
    if (section?.enabled === false) return []
    const { rules } = compileRules(section?.rules ?? DEFAULT_SENSITIVE_RULES)
    return rules
  }

  /**
   * 该会话的全部产物。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object[]}
   */
  artifactsOf(sessionId) {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#artifacts) if (physical.startsWith(prefix)) out.push(row)
    return out.sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * 写入产物：同一指纹只累加次数，不新增行。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object[]} rows - 候选产物。
   * @returns {Promise<{ written: object[], added: number, duplicated: number, hits: number }>}
   */
  async appendArtifacts(sessionId, rows) {
    const now = Date.now()
    const rules = this.#sensitiveRules()
    const written = []
    let added = 0
    let duplicated = 0
    let hitTotal = 0
    for (const raw of rows) {
      const normalized = normalizeArtifact(raw)
      if (normalized === undefined) continue
      const fingerprint = fingerprintOf(normalized)
      const physical = `${sessionId}:${fingerprint}`
      const scanned = scanText(`${normalized.title}\n${normalized.content}`, rules)
      const previous = this.#artifacts.get(physical)
      const full = previous === undefined
        ? {
            id: fingerprint.slice(0, 16),
            sessionId,
            ...normalized,
            hits: scanned.hits,
            severity: scanned.severity,
            fingerprint,
            count: 1,
            firstSeen: now,
            lastSeen: now,
          }
        : {
            ...previous,
            ...normalized,
            hits: scanned.hits,
            severity: scanned.severity,
            count: previous.count + 1,
            lastSeen: now,
          }
      await this.unit.putRecord('artifacts', physical, full)
      this.#artifacts.set(physical, full)
      written.push(full)
      hitTotal += scanned.hits.length
      // 产物锚到资产：给了 host / url 就找同 host 的节点，覆盖度的「产物」层靠它。
      const host = normalized.host !== ''
        ? normalized.host
        : (normalized.url === '' ? '' : splitUrlHost(normalized.url))
      if (host !== '') {
        const matched = this.assetsOf(sessionId).filter((asset) => asset.host === host).slice(0, 5)
        for (const asset of matched) await this.link(sessionId, assetKey(asset), 'artifact')
      }
      if (previous === undefined) added += 1
      else duplicated += 1
    }
    if (written.length > 0) this.#artifactRevs.set(sessionId, (this.#artifactRevs.get(sessionId) ?? 0) + 1)
    return { written, added, duplicated, hits: hitTotal }
  }

  /**
   * 分页 + 过滤产物（按最近命中倒序）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} query - `{ kind, q, severity, offset, limit }`。
   * @returns {object} `{ rows, total, offset, limit }`。
   */
  pageArtifacts(sessionId, query = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(query.limit) || DEFAULT_PAGE)))
    const offset = Math.max(0, Math.trunc(Number(query.offset) || 0))
    let rows = this.artifactsOf(sessionId)
    const kind = typeof query.kind === 'string' ? query.kind : ''
    if (kind !== '' && kind !== 'all') rows = rows.filter((row) => row.kind === kind)
    const severity = typeof query.severity === 'string' ? query.severity : ''
    if (severity !== '') rows = rows.filter((row) => row.severity === severity)
    const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
    if (needle !== '') {
      rows = rows.filter((row) => [
        row.title, row.content, row.howFound, row.url, row.host, row.source?.name,
      ].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)))
    }
    return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  }

  /**
   * 产物概览：总数、按类型、按严重级。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  overviewArtifacts(sessionId) {
    const rows = this.artifactsOf(sessionId)
    const byKind = { cloud: 0, leak: 0, api_doc: 0, credential: 0, package: 0, other: 0 }
    const bySeverity = { high: 0, medium: 0, low: 0 }
    let updatedAt = 0
    for (const row of rows) {
      if (byKind[row.kind] !== undefined) byKind[row.kind] += 1
      if (bySeverity[row.severity] !== undefined) bySeverity[row.severity] += 1
      if ((row.lastSeen ?? 0) > updatedAt) updatedAt = row.lastSeen
    }
    return { total: rows.length, byKind, bySeverity, updatedAt }
  }

  /**
   * 全局设置（按 section）。
   *
   * @returns {object} `{ sensitive: {...}, ... }`
   */
  settings() {
    return Object.fromEntries(this.#settings)
  }

  /**
   * 保存一个 section。
   *
   * 已知 section（目前只有 `sensitive`）会被校验；**未知 section 原样保存** ——
   * 这样以后加配置项不用改存储层。
   *
   * @param {string} section - section id。
   * @param {unknown} value - 该 section 的内容。
   * @returns {Promise<object>} 保存后的全部设置。
   */
  async saveSettings(section, value) {
    const id = typeof section === 'string' ? section.trim() : ''
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(id)) throw new Error(`section 名不合法：${id}`)
    if (value === null || typeof value !== 'object') throw new Error('section 内容必须是对象')
    let normalized = value
    if (id === 'sensitive') {
      const { rules, error } = compileRules(value.rules)
      if (error !== '') throw new Error(error)
      normalized = { enabled: value.enabled !== false, rules }
    }
    await this.unit.putRecord('settings', id, normalized)
    this.#settings.set(id, normalized)
    return this.settings()
  }

  /**
   * 按当前规则重扫该会话的全部产物（规则改过之后用）。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {Promise<number>} 重扫条数。
   */
  async rescanArtifacts(sessionId) {
    const rules = this.#sensitiveRules()
    const prefix = `${sessionId}:`
    let updated = 0
    for (const [physical, row] of this.#artifacts) {
      if (!physical.startsWith(prefix)) continue
      const scanned = scanText(`${row.title}\n${row.content}`, rules)
      const full = { ...row, hits: scanned.hits, severity: scanned.severity }
      await this.unit.putRecord('artifacts', physical, full)
      this.#artifacts.set(physical, full)
      updated += 1
    }
    if (updated > 0) this.#artifactRevs.set(sessionId, (this.#artifactRevs.get(sessionId) ?? 0) + 1)
    return updated
  }

  // ── 计划 / 派活 / 锚点 ─────────────────────────────────────────────────

  /**
   * 该会话的计划（没有就返回空计划，不写库）。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  plan(sessionId) {
    return this.#plans.get(sessionId) ?? emptyPlan()
  }

  /**
   * 保存计划（合并 patch 后归一化）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} patch - `{ scope?, stages? }`。
   * @returns {Promise<object>} 保存后的计划。
   */
  async savePlan(sessionId, patch) {
    const current = this.plan(sessionId)
    const next = normalizePlan({
      scope: patch?.scope ?? current.scope,
      stages: patch?.stages ?? current.stages,
      updatedAt: Date.now(),
    })
    await this.unit.putRecord('plans', `${sessionId}:plan`, next)
    this.#plans.set(sessionId, next)
    // 计划变了，面板的进度条要跟着刷新：复用 assets 的变更令牌。
    this.#bump(sessionId)
    return next
  }

  /**
   * 该会话的派活记录。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} [state] - 只看某个状态。
   * @returns {object[]} 时间倒序。
   */
  tasksOf(sessionId, state = '') {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#tasks) {
      if (!physical.startsWith(prefix)) continue
      if (state !== '' && row.state !== state) continue
      out.push(row)
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * 派一个活（同一 `(target, layer, tool)` 已有 open/running/done 时不重复派）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} input - `{ target, layer, tool }`。
   * @returns {Promise<{ task: object, duplicate: boolean }>}
   */
  async startTask(sessionId, input) {
    const target = typeof input?.target === 'string' ? input.target.trim().slice(0, 300) : ''
    const layer = typeof input?.layer === 'string' ? input.layer.trim().slice(0, 40) : ''
    const tool = typeof input?.tool === 'string' ? input.tool.trim().slice(0, 80) : ''
    if (target === '') throw new Error('target 必填')
    const existing = this.tasksOf(sessionId).find((row) => row.target === target
      && row.layer === layer && row.tool === tool
      // failed 也算"做过"：失败原因已经记下，同参数重试只会空转；要重试就换工具。
      && ['open', 'running', 'done', 'failed'].includes(row.state))
    if (existing !== undefined) return { task: existing, duplicate: true }
    const id = `task-${Date.now().toString(36)}-${(this.#tasks.size + 1).toString(36)}`
    const task = {
      id, sessionId, target, layer, tool, state: 'running', owner: '',
      result: null, error: '', startedAt: Date.now(), endedAt: 0,
    }
    await this.unit.putRecord('tasks', `${sessionId}:${id}`, task)
    this.#tasks.set(`${sessionId}:${id}`, task)
    this.#bump(sessionId)
    return { task, duplicate: false }
  }

  /**
   * 结束一个活。失败也要记（负结果，避免重复派）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 任务 id。
   * @param {object} outcome - `{ state, result?, error? }`。
   * @returns {Promise<object | undefined>}
   */
  async finishTask(sessionId, id, outcome) {
    const physical = `${sessionId}:${id}`
    const row = this.#tasks.get(physical)
    if (row === undefined) return undefined
    const state = ['done', 'failed', 'skipped'].includes(outcome?.state) ? outcome.state : 'done'
    const next = {
      ...row,
      state,
      result: outcome?.result ?? row.result,
      error: typeof outcome?.error === 'string' ? outcome.error.slice(0, 2000) : row.error,
      endedAt: Date.now(),
    }
    await this.unit.putRecord('tasks', physical, next)
    this.#tasks.set(physical, next)
    this.#bump(sessionId)
    return next
  }

  /**
   * 把一条数据锚到资产上（幂等）。覆盖度的分子从这里来。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} assetKeyText - 资产键。
   * @param {string} sourceKind - `record` / `artifact` / `question`。
   * @returns {Promise<void>}
   */
  async link(sessionId, assetKeyText, sourceKind) {
    const key = String(assetKeyText ?? '')
    if (key === '') return
    const physical = `${sessionId}:${key}:${sourceKind}`
    const previous = this.#links.get(physical)
    const row = {
      assetKey: key,
      sourceKind,
      count: (previous?.count ?? 0) + 1,
      at: Date.now(),
    }
    await this.unit.putRecord('links', physical, row)
    this.#links.set(physical, row)
  }

  /**
   * 该会话的锚点。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object[]}
   */
  linksOf(sessionId) {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#links) if (physical.startsWith(prefix)) out.push(row)
    return out
  }

  /**
   * 覆盖度（资产 × 证据层）。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  coverage(sessionId) {
    return coverageOf(this.assetsOf(sessionId), this.linksOf(sessionId))
  }

  // ── 探索图：需求 / 线索 / 方向 / 发现 ──────────────────────────────────

  /**
   * 该会话的图节点（时间正序）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} [kind] - 只看某类节点。
   * @returns {object[]}
   */
  nodesOf(sessionId, kind = '') {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#nodes) {
      if (!physical.startsWith(prefix)) continue
      if (kind !== '' && row.kind !== kind) continue
      out.push(row)
    }
    return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  /**
   * 按 id 取节点。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 节点 id。
   * @returns {object | undefined}
   */
  nodeById(sessionId, id) {
    return this.#nodes.get(`${sessionId}:${id}`)
  }

  /**
   * 写回一个节点（内部用）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} node - 完整节点。
   * @returns {Promise<object>}
   */
  async #persistNode(sessionId, node) {
    const full = { ...node, sessionId }
    await this.unit.putRecord('nodes', `${sessionId}:${node.id}`, full)
    this.#nodes.set(`${sessionId}:${node.id}`, full)
    this.#bump(sessionId)
    return full
  }

  /**
   * 加一个节点（按 key 去重）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} input - `{ kind, key, text, state?, priority?, payload? }`。
   * @returns {Promise<{ node: object, duplicate: boolean }>}
   */
  async addNode(sessionId, input) {
    const kind = String(input?.kind ?? '')
    const key = String(input?.key ?? '')
    if (key === '') throw new Error('节点缺少 key')
    const existing = this.nodesOf(sessionId, kind).find((node) => node.key === key)
    if (existing !== undefined) return { node: existing, duplicate: true }
    this.#nodeSeq += 1
    const id = `n${this.#nodeSeq}`
    const now = Date.now()
    const node = {
      id,
      seq: this.#nodeSeq,
      kind,
      key,
      text: String(input?.text ?? '').slice(0, 500),
      state: String(input?.state ?? 'open'),
      priority: Number(input?.priority) || 0,
      payload: input?.payload !== null && typeof input?.payload === 'object' ? input.payload : {},
      createdAt: now,
      updatedAt: now,
      closedAt: 0,
    }
    await this.#persistNode(sessionId, node)
    return { node, duplicate: false }
  }

  /**
   * 加一条线索。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} input - `{ text, source, payload?, priority? }`。
   * @returns {Promise<{ node: object, duplicate: boolean }>}
   */
  async addClue(sessionId, input) {
    const text = String(input?.text ?? '').trim()
    const source = String(input?.source ?? 'other').trim().toLowerCase()
    const key = clueKey(source, text)
    if (key === '') throw new Error('线索缺少正文')
    return this.addNode(sessionId, {
      kind: 'clue',
      key,
      text,
      state: 'open',
      priority: Number(input?.priority) || 0,
      payload: { source, ...(input?.payload ?? {}) },
    })
  }

  /**
   * 加一条方向（路），已存在则复用。
   *
   * 重跑语义：已 done/dead 的路再次登记 → **改回 running**，不新建节点。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} input - `{ target, method, params, needId, clueId?, priority? }`。
   * @returns {Promise<{ node: object, duplicate: boolean, restarted: boolean }>}
   */
  async addDirection(sessionId, input) {
    const key = directionKey(input)
    if (key === '') throw new Error('方向必须给 target 与 method')
    const existing = this.nodesOf(sessionId, 'direction').find((node) => node.key === key)
    if (existing !== undefined) {
      const restarted = existing.state === 'done' || existing.state === 'dead'
      const node = restarted
        ? await this.#persistNode(sessionId, {
            ...existing,
            state: 'running',
            payload: { ...existing.payload, claimedAt: Date.now() },
            updatedAt: Date.now(),
            closedAt: 0,
          })
        : existing
      return { node, duplicate: true, restarted }
    }
    const total = this.nodesOf(sessionId, 'direction').length
    if (total >= DIRECTION_LIMIT) {
      throw new Error(`方向已达上限 ${DIRECTION_LIMIT} 条：先把走完的路结算（done/dead），不要一直新建`)
    }
    const now = Date.now()
    const { node } = await this.addNode(sessionId, {
      kind: 'direction',
      key,
      text: String(input?.text ?? `${input?.method} · ${input?.target}`).slice(0, 500),
      state: 'running',
      priority: Number(input?.priority) || 0,
      payload: {
        target: String(input?.target ?? ''),
        method: String(input?.method ?? ''),
        params: input?.params !== null && typeof input?.params === 'object' ? input.params : {},
        needId: String(input?.needId ?? 'other'),
        clueId: typeof input?.clueId === 'string' ? input.clueId : '',
        claimedAt: now,
      },
    })
    if (typeof input?.clueId === 'string' && input.clueId !== '') {
      await this.linkNodes(sessionId, node.id, 'derived_from', input.clueId)
    }
    return { node, duplicate: false, restarted: false }
  }

  /**
   * 结算一条方向。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 方向节点 id。
   * @param {string} state - `done` / `dead`。
   * @param {string} [note] - 结果或失败原因。
   * @returns {Promise<object | undefined>}
   */
  async closeDirection(sessionId, id, state, note = '') {
    const node = this.nodeById(sessionId, id)
    if (node === undefined || node.kind !== 'direction') return undefined
    if (!DIRECTION_STATES.includes(state) || state === 'open' || state === 'running') {
      throw new Error('结算只能是 done 或 dead')
    }
    if (state === 'dead' && String(note).trim() === '') throw new Error('标 dead 必须写原因')
    return this.#persistNode(sessionId, {
      ...node,
      state,
      payload: { ...node.payload, result: String(note).slice(0, 1000) },
      updatedAt: Date.now(),
      closedAt: Date.now(),
    })
  }

  /**
   * 领一条路：状态置为 running，并记录开始时间。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 方向节点 id。
   * @returns {Promise<object | undefined>}
   */
  async claimDirection(sessionId, id) {
    const node = this.nodeById(sessionId, id)
    if (node === undefined || node.kind !== 'direction') return undefined
    return this.#persistNode(sessionId, {
      ...node,
      state: 'running',
      payload: { ...node.payload, claimedAt: Date.now() },
      updatedAt: Date.now(),
    })
  }

  /**
   * 把一条线索标死（确认无价值）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 线索节点 id。
   * @returns {Promise<object | undefined>}
   */
  async closeClue(sessionId, id) {
    const node = this.nodeById(sessionId, id)
    if (node === undefined || node.kind !== 'clue') return undefined
    return this.#persistNode(sessionId, {
      ...node,
      state: 'dead',
      updatedAt: Date.now(),
      closedAt: Date.now(),
    })
  }

  /**
   * 加一条边（幂等）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} fromId - 起点节点 id。
   * @param {string} rel - 关系。
   * @param {string} toId - 终点节点 id。
   * @returns {Promise<void>}
   */
  async linkNodes(sessionId, fromId, rel, toId) {
    if (fromId === '' || toId === '') return
    const physical = `${sessionId}:${fromId}:${rel}:${toId}`
    const row = { from: fromId, rel, to: toId, at: Date.now() }
    await this.unit.putRecord('edges', physical, row)
    this.#edges.set(physical, row)
  }

  /**
   * 加一条发现，并挂到方向与资产上。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} input - `{ text, directionId, assetKeys? }`。
   * @returns {Promise<{ node: object, duplicate: boolean }>}
   */
  async addFinding(sessionId, input) {
    const text = String(input?.text ?? '').trim()
    const key = findingKey(text)
    if (key === '') throw new Error('发现缺少正文')
    const { node, duplicate } = await this.addNode(sessionId, {
      kind: 'finding',
      key,
      text,
      state: 'confirmed',
      payload: { assetKeys: Array.isArray(input?.assetKeys) ? input.assetKeys.slice(0, 50) : [] },
    })
    if (!duplicate && typeof input?.directionId === 'string' && input.directionId !== '') {
      await this.linkNodes(sessionId, node.id, 'yields', input.directionId)
    }
    return { node, duplicate }
  }

  /**
   * 某节点相关的边。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 节点 id。
   * @returns {object[]}
   */
  edgesOf(sessionId, id) {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#edges) {
      if (!physical.startsWith(prefix)) continue
      if (row.from === id || row.to === id) out.push(row)
    }
    return out
  }

  /**
   * 图态势：计数 + 待探索 + 超时。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  graphState(sessionId) {
    return summarize(this.nodesOf(sessionId))
  }

  /**
   * 写回一次验活结果（`expose_verify` 用）。
   *
   * 验活是**观测**，不是新资产：连不上就标 `dead`（保留原字段与证据），
   * 连上了就把这次观测到的字段合并进去（状态码/标题/响应头/正文/证书都可能变了）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} key - 资产键。
   * @param {object} result - `{ live, at?, fields? }`。
   * @returns {Promise<object | undefined>} 更新后的资产；键不存在时返回 undefined。
   */
  async applyVerification(sessionId, key, result) {
    const physical = `${sessionId}:${key}`
    const row = this.#assets.get(physical)
    if (row === undefined) return undefined
    const at = Number(result?.at) || Date.now()
    const next = {
      ...row,
      lifecycle: result?.live === true ? 'live' : 'dead',
      lastVerifiedAt: at,
    }
    if (result?.live === true && result?.fields !== undefined && result.fields !== null) {
      for (const [field, value] of Object.entries(result.fields)) {
        if (value === undefined || value === null) continue
        const empty = Array.isArray(value) ? value.length === 0 : String(value).trim() === ''
        if (empty) continue
        next[field] = value
      }
    }
    await this.#persistAsset(sessionId, next)
    this.#bump(sessionId)
    return next
  }

  // ── 关联关系：从已有资产与记录里算，不落新表 ──────────────────────────

  /**
   * 某个端点的关联域名/IP。
   *
   * 分两块，**标注方式不同**：
   *   · `current` 来自资产的结构化字段（ip / cname / certSan / 同 host），是"现在这条资产知道的"；
   *   · `history` 来自采集记录里**显式写过 ip** 的观测，逐条带时间与来源，代表"当时的观测"。
   *
   * 不从 `detail` 自由文本里正则捞 IP —— 那会把证据当结论，正是这个项目一直避免的事。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} key - 端点键 `host:port`。
   * @returns {{ found: boolean, key: string, current: object, history: object[] }}
   */
  relationsOf(sessionId, key) {
    const prefix = `${sessionId}:`
    const target = this.#assets.get(`${prefix}${key}`)
    const emptyCurrent = {
      ip: '', cname: '', certSan: [],
      sameIpPorts: [], sameIpDomains: [], sameCname: [], sameHostPorts: [],
    }
    if (target === undefined) return { found: false, key, current: emptyCurrent, history: [] }

    const brief = (asset) => ({
      key: assetKey(asset),
      host: asset.host,
      port: asset.port,
      protocol: asset.protocol ?? '',
      title: asset.title ?? '',
      category: asset.category,
      status: asset.status,
      verdict: asset.verdict,
      nodeType: asset.nodeType ?? 'endpoint',
    })

    const targetPort = Number(target.port) || 0
    const isDomainLevel = (asset) => (Number(asset.port) || 0) === 0
    /**
     * 这些节点是"同一条资产的不同表示"，不能出现在关联里：
     *   · 自身（同 host:port）；
     *   · 系统节点对应的那个端点（`https://h:443/` ↔ `h:443`）；
     *   · 同一 host 的**域名级节点**（`h:0`）—— 对系统而言那就是它自己。
     */
    const isSameIdentity = (asset) => {
      if (asset.host !== target.host) return false
      const port = Number(asset.port) || 0
      if (port === targetPort) return true
      return target.nodeType === 'app' && port === 0
    }

    // 一个节点只进一个块：优先级 端口 > 域名 > CNAME > 同 host 端口。
    const seen = new Set([key])
    const sameIpPorts = []
    const sameIpDomains = []
    const sameCname = []
    const sameHostPorts = []
    for (const [physical, asset] of this.#assets) {
      if (!physical.startsWith(prefix) || physical === `${prefix}${key}`) continue
      const assetKeyText = assetKey(asset)
      if (seen.has(assetKeyText) || isSameIdentity(asset)) continue
      seen.add(assetKeyText)
      if (target.ip !== '' && asset.ip === target.ip) {
        (isDomainLevel(asset) ? sameIpDomains : sameIpPorts).push(brief(asset))
        continue
      }
      if (target.cname !== '' && asset.cname === target.cname) {
        sameCname.push(brief(asset))
        continue
      }
      if (asset.host === target.host && !isDomainLevel(asset)) sameHostPorts.push(brief(asset))
    }

    const history = this.recordsOf(sessionId)
      .filter((record) => record.asset === target.host || record.asset === key || record.asset.startsWith(`${target.host}:`))
      .map((record) => ({
        at: record.createdAt,
        kind: record.kind,
        asset: record.asset,
        ip: typeof record.ip === 'string' ? record.ip : '',
        cname: typeof record.cname === 'string' ? record.cname : '',
        sources: Array.isArray(record.sources) ? record.sources : [],
        verdict: record.verdict ?? '',
        // 有显式 ip 的才算"解析记录"，其余只是当时的一条观测。
        explicitIp: typeof record.ip === 'string' && record.ip !== '',
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 50)

    return {
      found: true,
      key,
      current: {
        ip: target.ip,
        cname: target.cname,
        certSan: Array.isArray(target.certSan) ? target.certSan : [],
        sameIpPorts,
        sameIpDomains,
        sameCname,
        sameHostPorts,
      },
      history,
    }
  }

  // ── 采集记录：一行一次观测，只追加 ────────────────────────────────────

  /** 该会话下一个可用序号。 */
  #nextSeq(sessionId) {
    const cached = this.#seqs.get(sessionId)
    if (cached !== undefined) {
      const next = cached + 1
      this.#seqs.set(sessionId, next)
      return next
    }
    let max = 0
    const prefix = `${sessionId}:`
    for (const key of this.#records.keys()) {
      if (!key.startsWith(prefix)) continue
      const suffix = key.slice(prefix.length)
      const at = suffix.lastIndexOf('-')
      const n = at < 0 ? Number.NaN : Number.parseInt(suffix.slice(at + 1), 10)
      if (Number.isFinite(n) && n > max) max = n
    }
    this.#seqs.set(sessionId, max + 1)
    return max + 1
  }

  /**
   * 追加采集记录（不合并、不覆盖 —— 这就是"日志"的语义）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object[]} rows - 候选记录（会被归一化；缺 asset 的跳过）。
   * @returns {Promise<object[]>} 落库后的记录。
   */
  async appendRecords(sessionId, rows) {
    const now = Date.now()
    const written = []
    let added = 0
    let mergedAssets = 0
    for (const row of rows) {
      const normalized = normalizeRecord(row)
      if (normalized === undefined) continue
      const id = `${normalized.kind}-${this.#nextSeq(sessionId)}`
      const full = { id, sessionId, ...normalized, createdAt: now }
      const physical = `${sessionId}:${id}`
      await this.unit.putRecord('results', physical, full)
      this.#records.set(physical, full)
      written.push(full)

      // 记录是过程，资产是汇总：写记录时顺手把端点合并进资产表，
      // 这样两个视图永远一致，调用方不需要记得写两次。
      //
      // 「系统」单独一步：只有 `kind=app` 或显式 `basePath` 才产出 app 节点；
      // 内容页/资源/接口的 URL 只进 `urls[]` 当证据，绝不各自变成系统。
      const nodes = nodesFromRecord(normalized, row)
      if (nodes.endpoint === undefined) continue
      const endpointExisted = this.#assets.has(`${sessionId}:${assetKey(nodes.endpoint)}`)
      const storedEndpoint = await this.#upsertOne(sessionId, nodes.endpoint, now, now)
      if (endpointExisted) mergedAssets += 1
      else added += 1
      // 锚点：覆盖度靠它算"哪些资产被真正观测过"。
      await this.link(sessionId, assetKey(storedEndpoint), 'record')

      // 观测到 http/https 的端点，本身就构成一个**根路径 web 资产**（`https://h:8080/`）。
      // 这是"Web 资产"里最基础的那一层，不是模型显式登记的，所以标 derived。
      const rootKey = await this.#ensureRootWebAsset(sessionId, storedEndpoint, now, true)
      if (rootKey !== undefined) added += 1

      if (nodes.app !== undefined) {
        const appExisted = this.#assets.has(`${sessionId}:${assetKey(nodes.app)}`)
        const stored = await this.#upsertOne(sessionId, nodes.app, now, now)
        if (appExisted) mergedAssets += 1
        else added += 1
        await this.link(sessionId, assetKey(stored), 'record')
        // 新入口进来时和同端点的其他系统比一次：三选二命中两项就直接合并，
        // 只命中一项的进问题池（不猜）。
        await this.#considerSystems(sessionId, stored, now)
      }
    }
    if (written.length > 0) {
      this.#recordRevs.set(sessionId, (this.#recordRevs.get(sessionId) ?? 0) + 1)
      if (added + mergedAssets > 0) this.#bump(sessionId)
    }
    return { written, added, merged: mergedAssets }
  }

  /**
   * 该会话的全部采集记录。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object[]}
   */
  recordsOf(sessionId) {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#records) if (physical.startsWith(prefix)) out.push(row)
    return out
  }

  /**
   * 分页查询采集记录（时间倒序）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} query - `{ kind, source, q, offset, limit }`。
   * @returns {object} `{ rows, total, offset, limit }`。
   */
  pageRecords(sessionId, query = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(query.limit) || DEFAULT_PAGE)))
    const offset = Math.max(0, Math.trunc(Number(query.offset) || 0))
    const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
    const rows = this.recordsOf(sessionId).filter((row) => {
      if (typeof query.kind === 'string' && query.kind !== '' && row.kind !== query.kind) return false
      if (typeof query.source === 'string' && query.source !== '') {
        const wanted = query.source.toLowerCase()
        if (!row.sources.some((name) => name.toLowerCase() === wanted)) return false
      }
      if (needle !== '') {
        const hay = `${row.asset}\n${row.detail}\n${row.target}\n${row.sources.join(' ')}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  }

  /**
   * 采集记录概览：按 kind 与来源计数（面板的 chip 与筛选器用）。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  overviewRecords(sessionId) {
    const rows = this.recordsOf(sessionId)
    const byKind = {}
    const bySource = {}
    let updatedAt = 0
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
      const sources = row.sources.length > 0 ? row.sources : ['(未标注来源)']
      for (const name of sources) bySource[name] = (bySource[name] ?? 0) + 1
      if (row.createdAt > updatedAt) updatedAt = row.createdAt
    }
    return { total: rows.length, byKind, bySource, updatedAt }
  }

  /**
   * 删除一条采集记录。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 记录 id。
   * @returns {Promise<boolean>} 是否真的删掉。
   */
  async deleteRecord(sessionId, id) {
    const physical = `${sessionId}:${id}`
    if (!this.#records.has(physical)) return false
    await this.unit.deleteRecord('results', physical)
    this.#records.delete(physical)
    this.#recordRevs.set(sessionId, (this.#recordRevs.get(sessionId) ?? 0) + 1)
    return true
  }

  /**
   * 清空一个会话的采集记录。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {Promise<number>} 删掉的条数。
   */
  async clearRecords(sessionId) {
    const prefix = `${sessionId}:`
    let removed = 0
    for (const physical of [...this.#records.keys()]) {
      if (!physical.startsWith(prefix)) continue
      await this.unit.deleteRecord('results', physical)
      this.#records.delete(physical)
      removed += 1
    }
    if (removed > 0) this.#recordRevs.set(sessionId, (this.#recordRevs.get(sessionId) ?? 0) + 1)
    return removed
  }

  // ── 资产：按端点 upsert ────────────────────────────────────────────────

  /**
   * 写入或合并一批资产。
   *
   * 同一 `host:port` 再次上报会**合并**（新值补非空、数组取并集、时间戳取早/晚），
   * 而不是追加一行 —— 这是"结果不再是采集日志"的关键。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object[]} rows - 候选资产（会被归一化；无 host 的跳过）。
   * @returns {Promise<{ written: object[], added: number, merged: number }>}
   */
  async upsertAssets(sessionId, rows) {
    const now = Date.now()
    const written = []
    let added = 0
    for (const row of rows) {
      const asset = normalizeAsset(row)
      if (asset === undefined) continue
      const physical = `${sessionId}:${assetKey(asset)}`
      const existed = this.#assets.has(physical)
      const merged = await this.#upsertOne(sessionId, asset, now, now)
      if (merged === undefined) continue
      written.push(merged)
      if (!existed) added += 1
    }
    if (written.length > 0) this.#bump(sessionId)
    return { written, added, merged: written.length - added }
  }

  /**
   * 单条合并 + 落库。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} asset - 已归一化的资产。
   * @param {number} firstSeen - 本次观测时间（新资产即首次）。
   * @param {number} lastSeen - 本次观测时间。
   * @returns {Promise<object>} 落库后的资产。
   */
  async #upsertOne(sessionId, asset, firstSeen, lastSeen) {
    const key = assetKey(asset)
    const physical = `${sessionId}:${key}`
    const previous = this.#assets.get(physical)
    const merged = mergeAsset(previous, asset, lastSeen)
    merged.firstSeen = previous === undefined ? firstSeen : Math.min(previous.firstSeen ?? firstSeen, firstSeen)
    merged.lastSeen = previous === undefined ? lastSeen : Math.max(previous.lastSeen ?? lastSeen, lastSeen)
    const full = { key, sessionId, ...merged }
    await this.unit.putRecord('assets', physical, full)
    this.#assets.set(physical, full)
    return full
  }

  /**
   * 该会话的全部资产。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object[]}
   */
  assetsOf(sessionId) {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#assets) if (physical.startsWith(prefix)) out.push(row)
    return out
  }

  // ── 系统（app）判定、合并与问题池 ──────────────────────────────────────

  /**
   * 为一个 http/https 端点补上**根路径 web 资产**（`scheme://host[:port]/`）。
   *
   * 为什么要有它：Web 资产视图里最基础的一层就是"这个端口上有个网站"，
   * 它不需要模型显式登记 —— 协议是观测到的，根路径是端点本身的含义。
   * 已存在就原样返回（幂等），不覆盖模型显式登记过的同名节点。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} endpoint - 端点节点。
   * @param {number} now - 时间戳。
   * @param {boolean} derived - 是否由端点派生（面板会标出来）。
   * @returns {Promise<string | undefined>} 新建时返回键；已存在或不是 http/https 时返回 undefined。
   */
  async #ensureRootWebAsset(sessionId, endpoint, now, derived) {
    const scheme = String(endpoint?.protocol ?? '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return undefined
    if (endpoint?.nodeType === 'app') return undefined
    const key = appKeyOf({ scheme, host: endpoint.host, port: endpoint.port ?? 0, basePath: '/' })
    if (key === '' || this.#assets.has(`${sessionId}:${key}`)) return undefined
    const app = normalizeAsset({
      ...endpoint,
      // 派生节点只继承"展示事实"，**不继承判定信号**：templateHash / loginUrl 属于具体路径，
      // 挂到根路径上会让根资产误配到某个子系统（进而把两个系统合并错）。
      templateHash: '', entryScript: '', faviconHash: '', assetPrefix: '', loginUrl: '',
      errorPageHash: '', cookieNames: [],
      nodeType: 'app',
      url: `${scheme}://${endpoint.host}${(endpoint.port ?? 0) === 0 ? '' : `:${endpoint.port}`}/`,
      basePath: '/',
      derived,
    })
    if (app === undefined || app.nodeType !== 'app') return undefined
    await this.#upsertOne(sessionId, app, now, now)
    return key
  }

  /**
   * 老库补根路径 web 资产（加载时跑一次，幂等）。
   *
   * 只对**已经观测到 http/https** 的端点补，不按端口号猜 —— 这条界限不能破。
   *
   * @returns {Promise<number>} 补出来的条数。
   */
  async #backfillRootWebAssets() {
    const now = Date.now()
    let created = 0
    for (const row of [...this.#assets.values()]) {
      if (row.nodeType === 'app' || typeof row.sessionId !== 'string' || row.sessionId === '') continue
      const scheme = String(row.protocol ?? '').toLowerCase()
      if (scheme !== 'http' && scheme !== 'https') continue
      const key = appKeyOf({ scheme, host: row.host, port: row.port ?? 0, basePath: '/' })
      if (key === '' || this.#assets.has(`${row.sessionId}:${key}`)) continue
      const made = await this.#ensureRootWebAsset(row.sessionId, row, now, true)
      if (made !== undefined) created += 1
    }
    return created
  }

  /**
   * 同端点下的其他系统节点。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} app - 当前系统。
   * @returns {object[]} 最多 20 个（判定是两两比较，不做 N² 爆炸）。
   */
  #siblingApps(sessionId, app) {
    const key = assetKey(app)
    const out = []
    for (const row of this.assetsOf(sessionId)) {
      if (row.nodeType !== 'app') continue
      // 派生出来的根路径资产是"容器"，不参与系统判定（它的信号本来就不属于任何路径）。
      if (row.derived === true) continue
      if (assetKey(row) === key) continue
      if (row.host !== app.host || (row.port ?? 0) !== (app.port ?? 0)) continue
      out.push(row)
      if (out.length >= 20) break
    }
    return out
  }

  /**
   * 新系统进来时和兄弟节点比一次。
   *
   * - 三选二命中 → **确定性合并**（不再问）；
   * - 只命中一项 → 写入问题池（同一对只记一次）；
   * - 零命中 → 什么都不做（本来就是两个系统）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} app - 刚写入的系统。
   * @param {number} now - 时间戳。
   * @returns {Promise<void>}
   */
  async #considerSystems(sessionId, app, now) {
    if (app.nodeType !== 'app' || app.mergeState === 'merged') return
    for (const other of this.#siblingApps(sessionId, app)) {
      if (other.mergeState === 'merged') continue
      const verdict = judgeSameSystem(app, other)
      if (verdict.same === true) {
        // 证据多的当主节点，一样多时取 key 字典序小的 —— 保证重复执行结果一致。
        const left = (app.urls?.length ?? 0)
        const right = (other.urls?.length ?? 0)
        const canonical = left > right || (left === right && assetKey(app) < assetKey(other)) ? app : other
        const child = canonical === app ? other : app
        await this.mergeApps(sessionId, assetKey(canonical), assetKey(child), now)
      } else if (verdict.same === null) {
        await this.addQuestion(sessionId, {
          a: assetKey(app),
          b: assetKey(other),
          reason: verdict.reason,
          signals: verdict.signals,
        })
      }
    }
  }

  /**
   * 把 `childKey` 并入 `parentKey`。
   *
   * 只改引用，不删节点：URL 证据会被搬到主节点（去重），子节点的 `mergedInto` 指向主节点，
   * 面板上可一键拆回。这样"合并错了"永远可逆。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} parentKey - 主系统键。
   * @param {string} childKey - 被并入的系统键。
   * @param {number} [now] - 时间戳。
   * @returns {Promise<object | undefined>} 合并后的主节点。
   */
  async mergeApps(sessionId, parentKey, childKey, now = Date.now()) {
    if (parentKey === childKey) return undefined
    const parentPhysical = `${sessionId}:${parentKey}`
    const childPhysical = `${sessionId}:${childKey}`
    const parent = this.#assets.get(parentPhysical)
    const child = this.#assets.get(childPhysical)
    if (parent === undefined || child === undefined) return undefined
    if (parent.nodeType !== 'app' || child.nodeType !== 'app') return undefined

    const mergedParent = {
      ...parent,
      mergeState: 'merged',
      mergedFrom: [...new Set([...(parent.mergedFrom ?? []), ...(child.mergedFrom ?? []), childKey])].slice(0, 32),
      urls: mergeUrlEvidence(parent.urls, child.urls, now),
      lastSeen: Math.max(parent.lastSeen ?? 0, now),
    }
    await this.#persistAsset(sessionId, mergedParent)
    const mergedChild = {
      ...child,
      mergeState: 'merged',
      mergedInto: parentKey,
      lastSeen: Math.max(child.lastSeen ?? 0, now),
    }
    await this.#persistAsset(sessionId, mergedChild)
    this.#bump(sessionId)
    return mergedParent
  }

  /**
   * 拆分：把 `key` 从主节点里摘出去（`mergedInto` 与 `mergedFrom` 双侧清理）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} key - 被并入的系统键。
   * @returns {Promise<boolean>} 是否真的拆了。
   */
  async splitApp(sessionId, key) {
    const physical = `${sessionId}:${key}`
    const child = this.#assets.get(physical)
    if (child === undefined || child.nodeType !== 'app' || child.mergedInto === '') return false
    const parentKey = child.mergedInto
    const parent = this.#assets.get(`${sessionId}:${parentKey}`)
    await this.#persistAsset(sessionId, { ...child, mergeState: 'single', mergedInto: '' })
    if (parent !== undefined) {
      const mergedFrom = (parent.mergedFrom ?? []).filter((item) => item !== key)
      await this.#persistAsset(sessionId, {
        ...parent,
        mergeState: mergedFrom.length > 0 ? 'merged' : 'single',
        mergedFrom,
      })
    }
    this.#bump(sessionId)
    return true
  }

  /**
   * 写回一个资产节点（内部用：合并/拆分/问题裁决都会改已有节点）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} asset - 完整节点（含 key）。
   * @returns {Promise<object>} 落库后的节点。
   */
  async #persistAsset(sessionId, asset) {
    const key = asset.key ?? assetKey(asset)
    const physical = `${sessionId}:${key}`
    const full = { ...asset, key, sessionId }
    await this.unit.putRecord('assets', physical, full)
    this.#assets.set(physical, full)
    return full
  }

  /**
   * 该会话的问题池。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} [status] - `open` / `resolved` / `dismissed`；空 = 全部。
   * @returns {object[]} 时间倒序。
   */
  questionsOf(sessionId, status = '') {
    const prefix = `${sessionId}:`
    const out = []
    for (const [physical, row] of this.#questions) {
      if (!physical.startsWith(prefix)) continue
      if (status !== '' && row.status !== status) continue
      out.push(row)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 加一条问题（同一对只留一条 open）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} input - `{ a, b, reason, signals }`。
   * @returns {Promise<object | undefined>} 新建或已存在的条目。
   */
  async addQuestion(sessionId, input) {
    const a = typeof input?.a === 'string' ? input.a : ''
    const b = typeof input?.b === 'string' ? input.b : ''
    if (a === '' || b === '' || a === b) return undefined
    const pair = [a, b].sort()
    const id = `${pair[0]}|${pair[1]}`
    const existing = this.#questions.get(`${sessionId}:${id}`)
    if (existing !== undefined && existing.status === 'open') return existing
    const row = {
      id,
      sessionId,
      kind: 'same-system',
      createdAt: Date.now(),
      status: 'open',
      payload: { a: pair[0], b: pair[1], reason: String(input?.reason ?? ''), signals: input?.signals ?? {} },
      options: [
        { id: 'merge', label: '合并成一个系统' },
        { id: 'keep', label: '保持两个系统' },
        { id: 'dismiss', label: '先不管' },
      ],
      resolvedChoice: '',
      resolvedBy: '',
      resolvedAt: 0,
    }
    await this.unit.putRecord('questions', `${sessionId}:${id}`, row)
    this.#questions.set(`${sessionId}:${id}`, row)
    // 上限：每会话 300 条 open，超出丢最早的。
    const open = this.questionsOf(sessionId, 'open')
    if (open.length > 300) {
      for (const stale of open.slice(300)) {
        await this.unit.deleteRecord('questions', `${sessionId}:${stale.id}`).catch(() => undefined)
        this.#questions.delete(`${sessionId}:${stale.id}`)
      }
    }
    this.#bump(sessionId)
    return row
  }

  /**
   * 裁决一条问题。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} id - 问题 id。
   * @param {string} choice - `merge` / `keep` / `dismiss`。
   * @param {string} [by] - `agent` / `user`。
   * @returns {Promise<object | undefined>} 更新后的条目。
   */
  async resolveQuestion(sessionId, id, choice, by = 'user') {
    const physical = `${sessionId}:${id}`
    const row = this.#questions.get(physical)
    if (row === undefined) return undefined
    if (!['merge', 'keep', 'dismiss'].includes(choice)) return undefined
    if (choice === 'merge') {
      const { a, b } = row.payload ?? {}
      if (typeof a === 'string' && typeof b === 'string') await this.mergeApps(sessionId, a, b)
    } else if (choice === 'keep') {
      // 两个都改回 single，避免一直挂在"待确认"上。
      for (const key of [row.payload?.a, row.payload?.b]) {
        if (typeof key !== 'string') continue
        const node = this.#assets.get(`${sessionId}:${key}`)
        if (node !== undefined && node.mergeState === 'unresolved') {
          await this.#persistAsset(sessionId, { ...node, mergeState: 'single' })
        }
      }
    }
    const updated = {
      ...row,
      status: choice === 'dismiss' ? 'dismissed' : 'resolved',
      resolvedChoice: choice,
      resolvedBy: by,
      resolvedAt: Date.now(),
    }
    await this.unit.putRecord('questions', physical, updated)
    this.#questions.set(physical, updated)
    this.#bump(sessionId)
    return updated
  }


  /**
   * 分页 + 语法查询。
   *
   * 解析失败不抛：把 `error` 带回前端，让面板把错误显示在搜索框下面，
   * 而不是让请求 500（用户正在打字时语法必然是不完整的）。
   *
   * @param {string} sessionId - 归属会话。
   * @param {object} query - `{ q, category, offset, limit }`。
   * @returns {object} `{ rows, total, offset, limit, error }`。
   */
  pageAssets(sessionId, query = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(query.limit) || DEFAULT_PAGE)))
    const offset = Math.max(0, Math.trunc(Number(query.offset) || 0))
    const { ast, error } = parseQuery(typeof query.q === 'string' ? query.q : '')
    if (error !== undefined) return { rows: [], total: 0, offset, limit, error }

    let rows = this.assetsOf(sessionId)
    // 视角过滤：主机资产（端点）/ Web 资产（系统 + 根路径）。
    const nodeType = query.nodeType === 'app' ? 'app' : query.nodeType === 'endpoint' ? 'endpoint' : ''
    if (nodeType !== '') {
      rows = rows.filter((row) => (row.nodeType ?? 'endpoint') === nodeType)
    }
    // 分面过滤：主机资产按**协议族**，Web 资产按**状态码**。
    const facet = typeof query.facet === 'string' ? query.facet.trim().toLowerCase() : ''
    if (facet !== '') {
      rows = nodeType === 'app'
        ? rows.filter((row) => String(row.status ?? 0) === facet)
        : rows.filter((row) => protocolFamily(row) === facet)
    }
    if (ast !== null) rows = rows.filter((row) => matchQuery(ast, row))
    const category = typeof query.category === 'string' ? query.category : ''
    if (CATEGORIES.includes(category)) rows = rows.filter((row) => row.category === category)
    rows.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  }

  /**
   * 概览：总数 + 分类计数 + 来源计数 + 节点类型计数。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  overviewAssets(sessionId) {
    const rows = this.assetsOf(sessionId)
    const byCategory = { web: 0, service: 0, host: 0, unknown: 0 }
    const byNodeType = { endpoint: 0, app: 0 }
    // 主机资产视图的分面是**协议族**（http/sql/ssh/…），Web 资产视图的分面是**状态码**。
    const byProtocol = Object.fromEntries(PROTOCOL_FAMILIES.map((id) => [id, 0]))
    const byStatus = Object.fromEntries(WEB_STATUS_FACETS.map((code) => [String(code), 0]))
    const bySource = {}
    let updatedAt = 0
    for (const row of rows) {
      if (byCategory[row.category] !== undefined) byCategory[row.category] += 1
      const type = row.nodeType === 'app' ? 'app' : 'endpoint'
      byNodeType[type] += 1
      if (type === 'endpoint') {
        const family = protocolFamily(row)
        byProtocol[family] = (byProtocol[family] ?? 0) + 1
      } else if (byStatus[String(row.status ?? 0)] !== undefined) {
        byStatus[String(row.status ?? 0)] += 1
      }
      const sources = Array.isArray(row.sources) && row.sources.length > 0 ? row.sources : ['(未标注来源)']
      for (const name of sources) bySource[name] = (bySource[name] ?? 0) + 1
      if ((row.lastSeen ?? 0) > updatedAt) updatedAt = row.lastSeen
    }
    return { total: rows.length, byCategory, byNodeType, byProtocol, byStatus, bySource, updatedAt }
  }

  /**
   * 删除一条资产。
   *
   * @param {string} sessionId - 归属会话。
   * @param {string} key - 端点键 `host:port`。
   * @returns {Promise<boolean>} 是否真的删掉。
   */
  async deleteAsset(sessionId, key) {
    const physical = `${sessionId}:${key}`
    if (!this.#assets.has(physical)) return false
    await this.unit.deleteRecord('assets', physical)
    this.#assets.delete(physical)
    this.#bump(sessionId)
    return true
  }

  /**
   * 清空一个会话的资产。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {Promise<number>} 删掉的条数。
   */
  async clearAssets(sessionId) {
    const prefix = `${sessionId}:`
    let removed = 0
    for (const physical of [...this.#assets.keys()]) {
      if (!physical.startsWith(prefix)) continue
      await this.unit.deleteRecord('assets', physical)
      this.#assets.delete(physical)
      removed += 1
    }
    if (removed > 0) this.#bump(sessionId)
    return removed
  }

  #bump(sessionId) {
    this.#assetRevs.set(sessionId, (this.#assetRevs.get(sessionId) ?? 0) + 1)
  }

  /**
   * 变更令牌：面板轮询它，值一变就重取。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {{ config: number, assets: number, records: number }}
   */
  rev(sessionId) {
    return {
      config: this.#configRev,
      assets: this.#assetRevs.get(sessionId) ?? 0,
      records: this.#recordRevs.get(sessionId) ?? 0,
      artifacts: this.#artifactRevs.get(sessionId) ?? 0,
    }
  }
}

/**
 * 把老的"一行一次观测"转成资产端点。
 *
 * 只为不丢历史：老行没有结构化字段，所以 `detail` 落到 `banner`、`kind` 落到 `note`，
 * 端口从 `asset` 里能拆出来就拆，拆不出来就当 host 级记录。
 * 迁移是幂等的（同端点合并），所以重复加载不会产生重复资产。
 *
 * @param {object} row - 老结果行。
 * @returns {object | undefined} 归一化后的资产。
 */
function legacyRowToAsset(row) {
  const { host, port } = splitEndpoint(row.asset)
  if (host === '') return undefined
  const kind = typeof row.kind === 'string' ? row.kind : ''
  // 只有 agent **明确断言**过的类型才当成分类证据；
  // `port` / `subdomain` 这类只说明"有个端口""有个子域"，不说明它是不是 Web，交给证据推导（可能落 unknown）。
  const asserted = kind === 'web' ? 'web' : kind === 'service' ? 'service' : undefined
  return normalizeAsset({
    target: row.target,
    host,
    port,
    category: asserted,
    // 老记录的 `detail` 是自由文本备注/证据，不是服务 banner —— 不要塞进 `banner`，
    // 否则界面会把 agent 写的分析句子当成"标题/banner"显示出来。
    sources: Array.isArray(row.sources) ? row.sources : row.source,
    confidence: row.confidence,
    // 不写 note：迁移是内部动作，不该在界面上留下"历史记录（web）"这种痕迹。
  })
}
