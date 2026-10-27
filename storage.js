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

import { asCapabilities, asPurpose } from './vocabulary.js'
import {
  CATEGORIES, assetKey, matchQuery, mergeAsset, normalizeAsset, parseQuery, splitEndpoint,
} from './assets.js'

/** 本包后端在 storage hub 上注册的名字（必须全局唯一）。 */
export const BACKEND_NAME = 'infohunter-sqlite'
/** 本包占用的 unit（域）名。 */
export const UNIT_NAME = 'infohunter'
/** unit 布局版本：改动表结构时递增。 */
export const UNIT_VERSION = 2

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
  }
  if (type === 'tool') {
    const path = typeof source.path === 'string' ? source.path.slice(0, 2000) : ''
    const description = typeof source.description === 'string' ? source.description.slice(0, 8000) : ''
    if (path.trim() === '' && description.trim() === '') return undefined
    return { ...base, type: 'tool', purpose: asPurpose(source.purpose) ?? ENTRY_DEFAULTS.purpose, path, description }
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
  if (baseUrl.trim() === '' && key.trim() === '' && apiDoc.trim() === '' && capabilities.length === 0) return undefined
  return { ...base, type: 'mapping', capabilities, baseUrl, key, apiDoc, remark }
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
    const type = raw !== null && typeof raw === 'object' && raw.type === 'mapping' ? 'mapping' : 'tool'
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
    certIssuer: typeof cert.issuer === 'string' ? cert.issuer.slice(0, 300) : '',
    service: typeof source.service === 'string' ? source.service.slice(0, 80) : '',
    version: typeof source.version === 'string' ? source.version.slice(0, 120) : '',
    note: typeof source.note === 'string' ? source.note.slice(0, 4000) : '',
    sources: nameList(source.sources ?? source.source, 8, 60),
    confidence,
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
  /** @type {Map<string, object>} 物理 key `${sessionId}:${id}` → 采集记录（一行一次观测） */
  #records = new Map()
  /** @type {Map<string, object>} 物理 key `${sessionId}:${host}:${port}` → 资产 */
  #assets = new Map()
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
    return doc
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
      const asset = normalizeAsset({ ...row, endpoint: normalized.asset })
      if (asset === undefined) continue
      const existed = this.#assets.has(`${sessionId}:${assetKey(asset)}`)
      await this.#upsertOne(sessionId, asset, now, now)
      if (existed) mergedAssets += 1
      else added += 1
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
    if (ast !== null) rows = rows.filter((row) => matchQuery(ast, row))
    const category = typeof query.category === 'string' ? query.category : ''
    if (CATEGORIES.includes(category)) rows = rows.filter((row) => row.category === category)
    rows.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  }

  /**
   * 概览：总数 + 分类计数 + 来源计数。
   *
   * @param {string} sessionId - 归属会话。
   * @returns {object}
   */
  overviewAssets(sessionId) {
    const rows = this.assetsOf(sessionId)
    const byCategory = { web: 0, service: 0, host: 0, unknown: 0 }
    const bySource = {}
    let updatedAt = 0
    for (const row of rows) {
      if (byCategory[row.category] !== undefined) byCategory[row.category] += 1
      const sources = Array.isArray(row.sources) && row.sources.length > 0 ? row.sources : ['(未标注来源)']
      for (const name of sources) bySource[name] = (bySource[name] ?? 0) + 1
      if ((row.lastSeen ?? 0) > updatedAt) updatedAt = row.lastSeen
    }
    return { total: rows.length, byCategory, bySource, updatedAt }
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
