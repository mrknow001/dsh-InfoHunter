/**
 * 互联网暴露面收集 —— preset 半：模型工具 + 常驻提示段 + 随包技能。
 *
 * ## 形态选择
 *
 * 工具用手写的 JSON Schema 定义，**不 import `@deepseek-ai/dsh-tools`**：
 * `ToolDefinition` 要的 `parameters` 就是模型面的 JSON Schema 对象、`output.schema` 是普通
 * `JsonSchemaNode`，`defineTool` 只是把一套 DSL 编译成这两样的语法糖。手写之后本包
 * 在宿主侧**零导入**，不声明任何依赖，也就不受 DSH peer 版本约束影响。
 *
 * ## 为什么每一行都"失败只降级、绝不抛"
 *
 * 预设里任何一行挂不上，`mountPreset` 就把整条预设标成 `broken`，而**新会话的预设选择器
 * 会直接过滤掉 broken 的预设** —— 用户看到的是"这个预设不存在"，且宿主日志、浏览器控制台、
 * 构建输出全都没有红字。所以 `inject` 只留最小集（`tools`），其余一律 `ctx.get` 探测。
 *
 * @module @infohunter/dsh-information-hunter/preset
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENTRY_TYPE_LABELS, PURPOSE_LABELS, asPurpose, describePurposes } from './vocabulary.js'
import { describeQuery } from './assets.js'

/** 插件名。 */
export const name = 'infohunter-preset'

/** 必需服务只有工具目录。 */
export const inject = ['tools']

/** 常驻段的 order：在 persona 之后、一阶工具说明之前。 */
const SECTION_ORDER = 60

/** 单次工具返回给模型的最大字符数（超出截断并标注）。 */
const TOOL_TEXT_MAX = 12000

/** 渲染一段文本成模型可见内容块。 */
const renderText = (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]

/** 所有工具共用的输出契约：一个开放对象，渲染取其中的 `text`。 */
const OUTPUT = { schema: { type: 'object' }, render: renderText }

/**
 * 把文本裁到上限，超出时明确标注（模型据此知道可以再查）。
 *
 * @param {string} text - 原文。
 * @param {number} [max] - 上限。
 * @returns {string}
 */
function clamp(text, max = TOOL_TEXT_MAX) {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[已截断，原文 ${text.length} 字]`
}

/**
 * 取工具调用归属的**根**会话 id。
 *
 * 结果按会话隔离；子代理沿 `parentSession` 归一到根会话，主会话才看得到子代理收的东西。
 * 两种 `Agent` 形状都兼容（`tools` 包里声明的窄形状只有 `id`）。
 *
 * @param {object} exec - 工具执行上下文。
 * @returns {string | undefined}
 */
function sessionIdOf(exec) {
  const agent = exec?.agent
  const session = agent?.session
  const id = session?.id ?? agent?.id
  if (typeof id !== 'string' || id === '') return undefined
  const parent = session?.header?.parentSession
  return typeof parent === 'string' && parent !== '' && parent !== id ? parent : id
}

/**
 * 把一条配置行渲染成给模型看的文本块。
 *
 * 两种类型分开说：工具交代"干什么用的"，空间测绘交代"能出哪些 kind" ——
 * 因为后者是综合查询，模型真正要判断的是"缺端口数据该问哪个平台"。
 *
 * 字段一律走 `?? ''`：`HunterStore` 保证形状，但介质里可能留着旧版本写下的行，
 * 不该让一个缺字段把工具调用整个弄挂。
 *
 * @param {object} entry - 配置行。
 * @returns {string}
 */
function formatEntry(entry) {
  const note = String(entry.note ?? '').trim()
  const entryName = String(entry.name ?? '') || '(未命名)'
  if (entry.type === 'tool') {
    const head = `[${ENTRY_TYPE_LABELS.tool}] ${entryName} — 用途 ${entry.purpose}（${PURPOSE_LABELS[entry.purpose] ?? entry.purpose}）`
    const description = String(entry.description ?? '').trim()
    const lines = [head, `  路径: ${String(entry.path ?? '')}`]
    lines.push(description === '' ? '  说明: (未填写 —— 先看路径判断用法，或请用户补一段说明)' : `  说明: ${description.slice(0, 2000)}`)
    if (note !== '') lines.push(`  备注: ${note.slice(0, 400)}`)
    return lines.join('\n')
  }
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : []
  const canProduce = capabilities.length === 0
    ? '(未勾选 —— 先读 API 说明判断它能出什么)'
    : capabilities.map((id) => `${PURPOSE_LABELS[id] ?? id}(${id})`).join('、')
  const head = `[${ENTRY_TYPE_LABELS.mapping}] ${entryName} — 能出: ${canProduce}`
  const apiDoc = String(entry.apiDoc ?? '').trim()
  const key = String(entry.key ?? '')
  const lines = [head, `  BaseURL: ${String(entry.baseUrl ?? '')}`, `  Key: ${key === '' ? '(未配置)' : key}`]
  lines.push(apiDoc === '' ? '  API 说明: (未填写)' : `  API 说明: ${apiDoc.slice(0, 2000)}`)
  const remark = [note, String(entry.remark ?? '').trim()].filter((value) => value !== '').join(' / ')
  if (remark !== '') lines.push(`  备注: ${remark.slice(0, 400)}`)
  return lines.join('\n')
}

/**
 * 判断一行是否覆盖某个 kind。
 *
 * 工具看单值 `purpose`，空间测绘看多选 `capabilities` —— 这就是"综合查询"与
 * "专用工具"在数据形状上的差别。
 *
 * @param {object} entry - 配置行。
 * @param {string} kind - 用途/能力 id。
 * @returns {boolean}
 */
function coversKind(entry, kind) {
  if (entry.type === 'mapping') return Array.isArray(entry.capabilities) && entry.capabilities.includes(kind)
  return entry.purpose === kind
}

// ── 受控执行 ────────────────────────────────────────────────────────────────
//
// 预设里**没有任何 shell、文件系统、任意 HTTP 工具**。所有动作都必须穿过下面这个
// 工具，而它只做两件事：查面板配置、以 argv 方式启动进程（不过 shell）。
// 「配置即授权」于是从一句话变成一条代码路径。

/** 单次 run 保存的原始输出上限（字节）。 */
const RUN_SAVE_MAX = 8 * 1024 * 1024
/** 读取既有 run 的上限（字节）。 */
const RUN_READ_MAX = 32 * 1024 * 1024
/** 参数个数与单参长度上限 —— 防把整段脚本塞进一个参数。 */
const ARG_COUNT_MAX = 64
const ARG_LENGTH_MAX = 2000
/** stdin 上限。 */
const STDIN_MAX = 1_000_000
/** 单次执行超时。 */
const RUN_TIMEOUT_DEFAULT = 120 * 1000
const RUN_TIMEOUT_MAX = 10 * 60 * 1000
/** 默认回给模型的行数。 */
const RUN_LINES_DEFAULT = 120
const RUN_LINES_MAX = 400

/** DSH home（与宿主半用同一套解析规则）。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** run 原始输出的落脚目录。 */
function runsDir() {
  return join(dshHome(), 'infohunter', 'runs')
}

/**
 * 以 argv 方式启动一个进程并收集输出。
 *
 * `shell: false` 是硬要求：模型给的是参数数组，不是命令行字符串，
 * 因此没有管道、没有 `;`、没有重定向、没有命令替换。
 *
 * @param {string} command - 可执行文件路径。
 * @param {string[]} argv - 参数数组。
 * @param {object} options - `{ cwd, timeoutMs, stdin }`。
 * @returns {Promise<{ code?: number, error?: Error, output: string, truncated: boolean, timedOut: boolean }>}
 */
function execCapture(command, argv, options) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, argv, { cwd: options.cwd, shell: false, windowsHide: true })
    } catch (error) {
      resolve({ error, output: '', truncated: false, timedOut: false })
      return
    }
    const chunks = []
    let size = 0
    let truncated = false
    let timedOut = false
    const take = (buffer) => {
      if (size >= RUN_SAVE_MAX) {
        truncated = true
        return
      }
      const room = RUN_SAVE_MAX - size
      if (buffer.length > room) {
        chunks.push(buffer.subarray(0, room))
        size += room
        truncated = true
        return
      }
      chunks.push(buffer)
      size += buffer.length
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    }, options.timeoutMs)

    let settled = false
    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, error, output: Buffer.concat(chunks).toString('utf8'), truncated, timedOut })
    }
    child.on('error', (error) => finish(undefined, error))
    child.on('close', (code) => finish(code, undefined))
    try {
      child.stdin?.end(options.stdin === '' ? undefined : options.stdin)
    } catch {
      /* 某些可执行文件不读 stdin，忽略 */
    }
  })
}

/**
 * 把输出裁成「头 N 行 + 统计」，并保留完整版到 run 文件。
 *
 * @param {string} output - 原始输出。
 * @param {number} maxLines - 回给模型的行数上限。
 * @returns {{ text: string, totalLines: number }}
 */
function excerpt(output, maxLines) {
  const normalized = output.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const totalLines = lines.length
  if (totalLines <= maxLines) return { text: normalized, totalLines }
  const head = lines.slice(0, maxLines).join('\n')
  const tail = lines.slice(-3).join('\n')
  return { text: `${head}\n…[还有 ${totalLines - maxLines} 行，用 expose_run_query 按 runId 检索或取尾部]\n${tail}`, totalLines }
}

/**
 * 注册工具，失败只警告不中断。
 *
 * 一个工具的定义被注册表拒绝时（超时上限、schema 形状等），原来的写法会让
 * `registerTools` 整个中断 —— 前几个工具在、后面几个静默消失，而且没有任何痕迹。
 * 那正是"配置里的工具跑不起来"最难查的形态，所以逐个兜住并留日志。
 *
 * @param {object} ctx - preset 层上下文。
 * @param {object} definition - `ToolDefinition`。
 * @returns {boolean} 是否注册成功。
 */
function registerToolSafely(ctx, definition) {
  try {
    ctx.tools.register(definition)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[infohunter] 工具 ${definition.name} 注册失败：${message}`)
    return false
  }
}

/**
 * 注册全部模型工具。
 *
 * @param {object} ctx - preset 层上下文。
 * @param {import('./storage.js').HunterStore} store - 共享 store。
 */
function registerTools(ctx, store) {
  // ── 1. 读配置 ──────────────────────────────────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_config',
    description:
      '读取『暴露面收集』的配置：本地工具（路径 + 用法说明）与空间测绘平台'
      + '（BaseURL、Key、API 说明、勾选了能出哪些数据种类）。'
      + '开始任何收集动作前先调它 —— 配置由用户在面板维护，可能为空。'
      + '本会话**没有 shell、没有文件工具、没有任意 URL 抓取**：执行工具只能走 expose_tool_run，'
      + '查询只能走 expose_mapping_call / web_search。'
      + '因此「配置」就是这个 agent 的能力边界：面板里没有的工具跑不了，没有的平台查不了。'
      + '不要想办法绕过（不要拼参数、不要假装有工具）。'
      + '不要把返回的 Key 写进任何落盘文件或报告。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['all', 'tool', 'mapping'], description: '只列某一类，缺省 all。' },
        purpose: {
          type: 'string',
          description: `只列覆盖这类数据的能力（取值：${describePurposes()}）。工具按它的单一用途匹配，空间测绘按它勾选的能力匹配。缺省不筛选。`,
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args) {
      const wantType = args?.type === 'tool' || args?.type === 'mapping' ? args.type : undefined
      const wantPurpose = args?.purpose === undefined ? undefined : asPurpose(args.purpose)
      const entries = store
        .enabledEntries(wantType)
        .filter((entry) => wantPurpose === undefined || coversKind(entry, wantPurpose))
      if (entries.length === 0) {
        // 区分"整份配置为空"和"筛选没命中"：混为一谈会让模型误判成用户什么都没配。
        const filters = [
          wantType === undefined ? '' : `类型 ${wantType}`,
          wantPurpose === undefined ? '' : `能力 ${wantPurpose}`,
        ].filter((part) => part !== '')
        return {
          text: filters.length > 0
            ? `没有配置行匹配「${filters.join('、')}」。去掉筛选再调一次 expose_config 可以看到全量配置；如果某个平台确实能做这件事，可能是它的能力没在面板里勾选。`
            : '配置为空。请告诉用户「面板 → 配置」里还没有可用的工具或空间测绘平台。本会话没有 shell、没有文件工具、也没有任意 URL 抓取，所以没有配置就真的没有可用手段 —— 不要编造能力。',
          count: 0,
        }
      }
      const tools = entries.filter((e) => e.type === 'tool').length
      const shown = entries.slice(0, 40)
      const head = `配置 ${entries.length} 条（工具 ${tools} / 空间测绘 ${entries.length - tools}）。`
      const body = shown.map(formatEntry).join('\n\n')
      const tail = entries.length > shown.length ? `\n\n…还有 ${entries.length - shown.length} 条未列出（按 need 收窄 type/purpose 再看）。` : ''
      return { text: clamp(`${head}\n\n${body}${tail}`), count: entries.length }
    },
  })

  // ── 2. 调空间测绘 ──────────────────────────────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_mapping_call',
    description:
      '按配置里的空间测绘平台发一次查询，自动注入 API Key 并返回响应体。'
      + '空间测绘是综合查询：一次往往同时给出域名、IP、端口、协议、banner、标题、指纹、证书。'
      + '缺某一类数据时，先在 expose_config 的输出里找**勾选了该 kind** 的平台，不要随便挑一个。'
      + '平台名取自 expose_config（name 或 id，支持前缀匹配）。路径、参数、查询语法以该平台的 API 说明为准 —— '
      + '本工具只负责拼 URL 与注入 Key，不替你猜语法。'
      + '仅 GET/POST；这是单次查询，不要用它做高频扫描。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '平台名或 id（见 expose_config）。' },
        path: { type: 'string', description: '拼在 BaseURL 之后的路径，如 search/global。缺省直接请求 BaseURL。' },
        query: { type: 'object', additionalProperties: true, description: '查询参数键值对（会 URL 编码）。' },
        method: { type: 'string', enum: ['GET', 'POST'], description: '缺省 GET。' },
        body: { type: 'string', description: 'POST 的请求体，通常是 JSON 字符串。' },
        keyMode: { type: 'string', enum: ['query', 'header', 'none'], description: 'Key 注入方式：query（缺省）/ header / none。' },
        keyName: { type: 'string', description: 'Key 的参数名或头名；query 缺省 key，header 缺省 authorization。' },
        bodyMax: { type: 'number', description: '响应体截断字符数，缺省 20000。' },
      },
      required: ['provider'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 120_000,
    async execute(args, exec) {
      const mappings = store.enabledEntries('mapping')
      const needle = String(args?.provider ?? '').trim().toLowerCase()
      if (needle === '') throw new Error('provider 不能为空')
      const label = (entry) => String(entry.name ?? '').trim()
      const found =
        mappings.find((m) => String(m.id).toLowerCase() === needle)
        ?? mappings.find((m) => label(m).toLowerCase() === needle)
        ?? mappings.find((m) => label(m) !== '' && label(m).toLowerCase().includes(needle))
      if (found === undefined) {
        const names = mappings.map((m) => label(m) || String(m.id)).join('、')
        throw new Error(`找不到空间测绘平台「${String(args?.provider)}」。已启用的平台：${names === '' ? '(无 —— 请让用户在面板「配置」里添加)' : names}`)
      }
      const baseUrl = String(found.baseUrl ?? '').trim()
      const platformKey = String(found.key ?? '').trim()
      if (baseUrl === '') throw new Error(`平台「${label(found) || String(found.id)}」没有配置 BaseURL`)

      const method = String(args?.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
      const keyMode = ['query', 'header', 'none'].includes(args?.keyMode) ? args.keyMode : 'query'
      const keyName = typeof args?.keyName === 'string' && args.keyName !== '' ? args.keyName : keyMode === 'header' ? 'authorization' : 'key'

      const base = baseUrl.replace(/\/+$/, '')
      const tail = String(args?.path ?? '').replace(/^\/+/, '')
      const url = new URL(tail === '' ? base : `${base}/${tail}`)
      const query = args?.query !== null && typeof args?.query === 'object' ? args.query : {}
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue
        url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
      const headers = { accept: 'application/json, */*' }
      if (platformKey !== '' && keyMode === 'query') url.searchParams.set(keyName, platformKey)
      if (platformKey !== '' && keyMode === 'header') headers[keyName] = platformKey
      const body = typeof args?.body === 'string' ? args.body : ''
      if (method === 'POST' && body !== '') headers['content-type'] = 'application/json'

      const response = await fetch(url, {
        method,
        headers,
        ...(method === 'POST' && body !== '' ? { body } : {}),
        signal: exec?.signal,
      })
      const raw = await response.text()
      const limit = Number.isFinite(args?.bodyMax) && args.bodyMax > 0 ? Math.min(200_000, Math.trunc(args.bodyMax)) : 20_000
      const truncated = raw.length > limit
      const text = truncated ? `${raw.slice(0, limit)}\n…[已截断，完整长度 ${raw.length}]` : raw
      return { text: `平台 ${label(found) || String(found.id)} 返回 HTTP ${response.status}\n\n${text}`, status: response.status, length: raw.length }
    },
  })

  // ── 3. 记录观测（同时进「采集记录」与「资产清单」）──────────────────────
  registerToolSafely(ctx, {
    name: 'expose_record',
    description:
      '记录一次观测。同一个调用写两处，面板的两个视图就是它们：'
      + '\n· 「采集记录」——一行一条，按时间倒序，保留你写的 evidence 原文，不合并（这是过程流水）。'
      + '\n· 「资产清单」——按 `host:port` 端点汇总，同端点重复记录会合并成一条（这是结果）。'
      + `\nkind 取值：${describePurposes()}`
      + '\nasset 写最小可定位单元（域名 / IP / IP:port），不要整段工具输出；detail 放证据原文（响应头、banner、证书主体、测绘原始字段）。'
      + '\n带 status/title/server/service/version/cert 的条目会同时补到资产上，所以可以分两次写同一个端点：先记端口，探完 Web 再补字段。'
      + '\n只写实际观察到的值；没测的字段留空，不要猜。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '这批观测属于哪个根目标（主域名 / IP / 组织名）。' },
        records: {
          type: 'array',
          description: '要记录的观测（1–200 条）。',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: '观测类型，取值见工具说明里的 kind 列表。' },
              asset: { type: 'string', description: '被观测到的东西：域名 / IP / IP:端口。写成 https://host:port 也可以，scheme 会被当作协议证据。' },
              protocol: { type: 'string', description: '实测到的协议：http / https / ssh / redis 等。Web 资产务必写 http 或 https —— 面板据此把资产变成可点击的链接；不写就不猜。' },
              ip: { type: 'string', description: '解析到的 IP。' },
              cname: { type: 'string', description: 'CNAME 目标。' },
              detail: { type: 'string', description: '证据原文，供复核。' },
              status: { type: 'number', description: 'HTTP 状态码（有就填，会进资产）。' },
              title: { type: 'string', description: '页面标题。' },
              server: { type: 'string', description: 'Server 响应头原值。' },
              tech: { type: 'array', items: { type: 'string' }, description: '识别到的框架/中间件/组件名。' },
              cert: {
                type: 'object',
                description: '证书信息。',
                properties: {
                  subject: { type: 'string', description: '证书主体 CN。' },
                  issuer: { type: 'string', description: '签发者。' },
                  san: { type: 'array', items: { type: 'string' }, description: '证书里的域名列表。' },
                  notAfter: { type: 'string', description: '到期时间，原样抄。' },
                },
                additionalProperties: false,
              },
              service: { type: 'string', description: '服务名，如 redis / mysql / smb。必须来自实际识别，不要按端口号猜。' },
              version: { type: 'string', description: '服务版本。' },
              banner: { type: 'string', description: '服务的原始 banner 文本（如 SSH-2.0-OpenSSH_8.9、redis 的 INFO 首行）。没读到就留空，不要填自己的分析。' },
              note: { type: 'string', description: '备注或推断说明。' },
              sources: { type: 'array', items: { type: 'string' }, description: '产出这条观测的工具/平台名，与面板配置同名，只写名字。' },
              confidence: { type: 'number', description: '置信度 0–100。不填表示未评估（面板留空），不要为了凑字段编一个。直接观测 80+，推断 40–70。' },
            },
            required: ['asset'],
            additionalProperties: false,
          },
        },
      },
      required: ['records'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法记录')
      const target = String(args?.target ?? '').trim()
      const raw = Array.isArray(args?.records) ? args.records : []
      if (raw.length === 0) throw new Error('records 不能为空')
      if (raw.length > 200) throw new Error(`一次最多 200 条（收到 ${raw.length} 条），请分批`)

      const records = []
      const skipped = []
      for (const [index, item] of raw.entries()) {
        const asset = typeof item?.asset === 'string' ? item.asset.trim() : ''
        if (asset === '') {
          skipped.push(`#${index + 1}（缺 asset）`)
          continue
        }
        records.push({
          ...item,
          target: target === '' ? item?.target : target,
          kind: asPurpose(item?.kind) ?? 'other',
          asset,
          detail: typeof item?.detail === 'string' ? item.detail : '',
        })
      }

      const { written, added, merged } = await store.appendRecords(sessionId, records)
      const text = written.length === 0
        ? `没有写入任何记录。被跳过的条目：${skipped.join('，')}`
        : `记录 ${written.length} 条（资产：新增 ${added}，合并 ${merged}）`
          + (skipped.length > 0 ? `\n跳过 ${skipped.length} 条：${skipped.join('，')}` : '')
      return { text, recorded: written.length, added, merged, skipped: skipped.length }
    },
  })

  // ── 4. 查询资产 ────────────────────────────────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_asset_query',
    description:
      '按语法查询本会话的资产清单（与面板「资产清单」的搜索框同一套语法）。'
      + '\n用途：写之前查重、看某个端口/状态码有哪些、盘点缺口、给汇总取数。按最近观测倒序返回。',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: `${describeQuery()} 留空表示不筛。` },
        category: { type: 'string', enum: ['web', 'service', 'host', 'unknown'], description: '只看某一类。unknown = 只有端口、没有判别证据的。' },
        limit: { type: 'number', description: '返回条数上限，缺省 50、最大 200。' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法查询资产')
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(args?.limit) || 50)))
      const page = store.pageAssets(sessionId, {
        q: typeof args?.q === 'string' ? args.q : '',
        category: typeof args?.category === 'string' ? args.category : '',
        limit,
        offset: 0,
      })
      if (page.error !== undefined) throw new Error(`查询语法有问题：${page.error}`)
      if (page.total === 0) return { text: '当前会话没有匹配的资产。', total: 0, returned: 0 }
      const lines = page.rows.map((row) => {
        const where = row.port === 0 ? row.host : `${row.host}:${row.port}`
        const bits = []
        if (row.protocol !== '') bits.push(row.protocol)
        if (row.status !== 0) bits.push(String(row.status))
        if (row.server !== '') bits.push(row.server)
        if (row.title !== '') bits.push(row.title)
        else if (row.service !== '') bits.push(row.version === '' ? row.service : `${row.service} ${row.version}`)
        const sources = Array.isArray(row.sources) && row.sources.length > 0 ? `  [${row.sources.join(' · ')}]` : ''
        return `${where}  ${row.category}${bits.length > 0 ? `  ${bits.join(' | ')}` : ''}${sources}`
      })
      const head = `命中 ${page.total} 条，返回 ${page.rows.length} 条（端点 / 分类 / 摘要 / 来源）：`
      return { text: clamp(`${head}\n${lines.join('\n')}`), total: page.total, returned: page.rows.length }
    },
  })

  // ── 5. 执行面板配置里的工具（唯一的执行入口）────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_tool_run',
    description:
      '执行**面板配置里**的一个工具，返回输出。这是本会话唯一的执行入口 —— '
      + '没有 shell，所以不能管道、不能 `;`、不能重定向、不能执行未配置的程序。'
      + '\n用法：`tool` 取自 expose_config 的工具名；`args` 是**参数数组**（一个元素一个参数，'
      + '不要拼成一整行命令）。面板里没有的工具跑不了 —— 缺什么就让用户去「配置」里加一行。'
      + '\n输出超过 maxLines 会截断，完整版存成 runId；用 expose_run_query 按 runId 检索。'
      + '\n目标不需要预先登记：把 `target` 写上是方便回溯，不写也能跑。',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '面板配置里的工具名或 id（见 expose_config）。' },
        target: { type: 'string', description: '可选：这次跑的是哪个目标，只写进 run 头便于回溯，不做许可校验。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: `参数数组，逐项传入（最多 ${ARG_COUNT_MAX} 项，每项 ≤ ${ARG_LENGTH_MAX} 字符）。例：["-d","example.com","-silent"]`,
        },
        stdin: { type: 'string', description: '可选的标准输入（如批量目标列表）。' },
        timeoutMs: { type: 'number', description: `超时毫秒，缺省 ${RUN_TIMEOUT_DEFAULT}，上限 ${RUN_TIMEOUT_MAX}。` },
        maxLines: { type: 'number', description: `回给模型的行数，缺省 ${RUN_LINES_DEFAULT}，上限 ${RUN_LINES_MAX}。` },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: RUN_TIMEOUT_MAX + 30_000,
    async execute(args) {
      const toolName = String(args?.tool ?? '').trim()
      if (toolName === '') throw new Error('tool 必填（见 expose_config 的工具列表）')
      // `target` 只用于归集（写进 run 头），不参与任何许可判断 —— 这是资产收集，
      // 目标本来就是"待发现的东西"，预先声明一份清单既做不到也没有意义。
      const target = String(args?.target ?? '').trim()

      const argv = Array.isArray(args?.args) ? args.args.map((value) => String(value)) : []
      if (argv.length > ARG_COUNT_MAX) throw new Error(`参数最多 ${ARG_COUNT_MAX} 项（收到 ${argv.length} 项）`)
      if (argv.some((value) => value.length > ARG_LENGTH_MAX)) throw new Error(`单个参数不能超过 ${ARG_LENGTH_MAX} 字符`)
      const stdin = typeof args?.stdin === 'string' ? args.stdin : ''
      if (stdin.length > STDIN_MAX) throw new Error(`stdin 不能超过 ${STDIN_MAX} 字符`)

      const tool = store.enabledEntries('tool').find((row) => String(row.id) === toolName)
        ?? store.enabledEntries('tool').find((row) => String(row.name ?? '').trim().toLowerCase() === toolName.toLowerCase())
      if (tool === undefined) {
        const names = store.enabledEntries('tool').map((row) => String(row.name ?? '') || String(row.id)).join('、')
        throw new Error(`「${toolName}」不在面板配置里，不能执行。已配置的工具：${names === '' ? '(无)' : names}`)
      }
      const executable = String(tool.path ?? '').trim()
      if (executable === '') throw new Error(`工具「${String(tool.name ?? '') || toolName}」没有配置可执行文件路径`)

      const timeoutMs = Math.min(
        RUN_TIMEOUT_MAX,
        Math.max(1000, Number.isFinite(args?.timeoutMs) ? Math.trunc(args.timeoutMs) : RUN_TIMEOUT_DEFAULT),
      )
      const maxLines = Math.min(
        RUN_LINES_MAX,
        Math.max(1, Number.isFinite(args?.maxLines) ? Math.trunc(args.maxLines) : RUN_LINES_DEFAULT),
      )

      const dir = runsDir()
      await mkdir(dir, { recursive: true })
      const startedAt = Date.now()
      const outcome = await execCapture(executable, argv, { cwd: dir, timeoutMs, stdin })
      const duration = Date.now() - startedAt

      if (outcome.error !== undefined) {
        throw new Error(`启动「${executable}」失败：${outcome.error.message}`)
      }

      const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${toolName.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`
      const header = `# ${toolName} target=${target} exit=${String(outcome.code)} ${duration}ms`
      try {
        await writeFile(join(dir, runId), `${header}\n${outcome.output}`, 'utf8')
      } catch (error) {
        ctx.logger?.warn?.(`[infohunter] 保存 run 输出失败：${error instanceof Error ? error.message : String(error)}`)
      }

      const { text, totalLines } = excerpt(outcome.output, maxLines)
      const notes = [
        outcome.timedOut ? `⏱ 超时被中止（${timeoutMs}ms）` : '',
        outcome.truncated ? `输出超过 ${RUN_SAVE_MAX} 字节被截断` : '',
        outcome.code !== 0 ? `退出码 ${String(outcome.code)}` : '',
      ].filter((line) => line !== '')
      return {
        text: clamp([
          `${toolName} → target=${target}  exit=${String(outcome.code)}  ${duration}ms  共 ${totalLines} 行`,
          notes.length > 0 ? notes.join('；') : '',
          `runId: ${runId}（完整输出已保存；用 expose_run_query 检索）`,
          '',
          text,
        ].filter((line) => line !== '').join('\n')),
        runId,
        exitCode: outcome.code ?? -1,
        totalLines,
        timedOut: outcome.timedOut,
      }
    },
  })

  // ── 6. 检索已保存的 run 输出（代替 grep）───────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_run_query',
    description:
      '在一次 expose_tool_run 保存的完整输出里检索，代替 shell 的 grep —— 本会话没有 shell。'
      + '返回命中行（含行号，最多 maxMatches 条）；`pattern` 留空则返回末尾 tailLines 行。'
      + '用途：大输出（子域列表、端口清单）里挑重点，而不必把整份内容塞回上下文。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'expose_tool_run 返回的 runId。' },
        pattern: { type: 'string', description: '正则（不区分大小写）；留空表示取尾部。' },
        maxMatches: { type: 'number', description: '最多返回多少条，缺省 100，上限 500。' },
        tailLines: { type: 'number', description: 'pattern 为空时返回末尾多少行，缺省 80，上限 500。' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args) {
      const runId = String(args?.runId ?? '').trim()
      // 只允许纯文件名：挡住 ../ 之类的路径穿越。
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(runId)) throw new Error('runId 不合法')
      const path = join(runsDir(), runId)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) throw new Error(`找不到 run「${runId}」（可能已被清理）`)
      if (info.size > RUN_READ_MAX) throw new Error(`run 文件超过 ${RUN_READ_MAX} 字节，无法整体检索`)
      const raw = await readFile(path, 'utf8')
      const lines = raw.replace(/\r\n/g, '\n').split('\n')

      const pattern = String(args?.pattern ?? '')
      if (pattern === '') {
        const tail = Math.min(500, Math.max(1, Number.isFinite(args?.tailLines) ? Math.trunc(args.tailLines) : 80))
        const start = Math.max(0, lines.length - tail)
        return {
          text: clamp(`run ${runId} 共 ${lines.length} 行，末尾 ${lines.length - start} 行：\n${lines.slice(start).join('\n')}`),
          matches: lines.length - start,
        }
      }

      let regex
      try {
        regex = new RegExp(pattern, 'i')
      } catch (error) {
        throw new Error(`pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`)
      }
      const maxMatches = Math.min(500, Math.max(1, Number.isFinite(args?.maxMatches) ? Math.trunc(args.maxMatches) : 100))
      const hits = []
      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) continue
        hits.push(`${index + 1}: ${line.slice(0, 300)}`)
        if (hits.length >= maxMatches) break
      }
      if (hits.length === 0) return { text: `run ${runId} 里没有匹配「${pattern}」的行（共 ${lines.length} 行）。`, matches: 0 }
      return { text: clamp(`run ${runId} 命中 ${hits.length} 行（上限 ${maxMatches}）：\n${hits.join('\n')}`), matches: hits.length }
    },
  })
}

/**
 * 注册随包方法论技能。
 *
 * 技能正文是包内的 `SKILL.md`，运行期按 `import.meta.url` 定位 —— 安装（链接目录或打包）
 * 两种形态都成立，且不依赖加载器给的 `baseUrl`（声明式预设行里那是**包根**，
 * 不是预设目录，靠它推技能目录会静默指错地方）。
 *
 * @param {object} ctx - preset 层上下文。
 */
async function registerSkill(ctx) {
  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.register !== 'function') {
    ctx.logger?.info?.('[infohunter] 没有 skills 服务，方法论技能未注册（工具与常驻段不受影响）。')
    return
  }
  let raw
  try {
    raw = await readFile(fileURLToPath(new URL('./skills/info-hunter-method/SKILL.md', import.meta.url)), 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`[infohunter] 读不到技能文件：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const meta = front?.[1] ?? ''
  const field = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(meta)
    return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  }
  const skillName = field('name')
  const description = field('description')
  if (skillName === '' || description === '') {
    ctx.logger?.warn?.('[infohunter] SKILL.md 缺少 name/description，技能未注册')
    return
  }
  try {
    ctx.effect(
      () =>
        skills.register({
          name: skillName,
          description,
          content: raw.slice(front?.[0].length ?? 0).replace(/^\s+/, ''),
          source: 'custom',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'infohunter.registerSkill',
    )
  } catch (error) {
    ctx.logger?.warn?.(`[infohunter] 技能 "${skillName}" 注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 常驻章程段正文。 */
const INSTRUCTIONS = `\
【互联网暴露面收集 · 常驻章程】

你负责渗透测试的第一阶段：把目标在互联网上的暴露面尽可能完整、可复核地收集下来。
你不做漏洞验证、不做利用 —— 那是后续阶段的事。你的产出是「资产清单 + 证据」。

## 一、先读配置，再动手
开始任何收集动作之前，**先调 expose_config**：它告诉你用户配了哪些本地工具、哪些空间测绘平台，
以及每个的用法说明（那是用户写的，比你的默认假设更准）。配置可能为空 —— 那就如实告诉用户
「面板 → 配置」里还没有可用工具，并说明你打算用哪些通用手段兜底（pwsh 里的系统命令、
web_fetch、web_search），不要假装自己有工具。**配置是人维护的授权边界，你只读不写。**

## 二、收集顺序（可分轮次，不必每轮走完）
1. **主域名** — 根域、备案/WHOIS、组织归属，把「一个域名」扩成「一组根域」。
2. **子域名** — 被动优先（证书透明日志、公开情报、测绘平台），再考虑字典爆破。
3. **DNS** — A/AAAA/CNAME/MX/TXT/NS，用来判断哪些子域是真的、哪些是泛解析、哪些指向第三方。
4. **端口** — 先常见端口，再按资产价值决定是否全端口；**控速、控并发**，不做压测。
5. **服务** — 端口上的协议与版本（banner / 握手特征）。
6. **Web** — HTTP(S) 探活：状态码、标题、Server/X-Powered-By、跳转链、目录与常见路径。
7. **指纹** — 框架 / 中间件 / CMS / 组件版本（静态资源路径、响应头组合、Cookie 名、运行时标记）。
8. **CDN/WAF 归属** — 直连还是前置；这决定后面能不能碰到真实源站。

中途随时回退：在端口阶段发现新子域，就回去补它的 DNS 与 Web。

## 三、记录纪律
**边收集边记**（expose_record），不要攒到最后 —— 面板两个视图实时读的就是它：
「采集记录」是一行一条的过程流水（不合并，保留你的证据原文），
「资产清单」是同一批记录按 host:port 汇总出来的结果（重复会自动合并）。
所以一次调用就够，不需要写两遍；asset 写成 1.2.3.4:8080 这种端点，纯域名就是 host 级资产。
只填观察到的字段，没测的留空 —— 空着比猜一个值好。
sources 只填**工具/平台的名字**（一条被多个印证就给多个），方法写 detail。
confidence 用观察/推断分层：直接观测 80–100，推断 40–70。写之前先 expose_asset_query 查重。

## 四、判断标准
- 只记**实际观察到**的事实；「可能存在」写进 note 并标低置信度。
- 区分「观察到」与「推断出」：证书里的域名是观察到的，它「属于同一家公司」是推断。
- 400/403 ≠ 不存在；只有 404/连接失败才是真不存在，状态码原样记进 status。
- **泛解析要识别**：随机不存在的子域也返回同样结果时，这一批结论作废。

## 五、边界
- 本阶段**只做收集**：不做漏洞验证、不做注入、不上传、不爆破口令 —— 那些不是"多做了"，是做错了。
- 主动请求控速：横向并发 ≤ 10，端口不做全端口压测。
- 收集过程中发现的资产照实记录即可，不需要谁来预先批准清单 —— **范围是你要产出的东西，不是你的输入**。
- 需要登录态或更高强度扫描、或目标本身不明确时，用 ask_user_question 一次性问清，
  同时**继续做不受影响的部分**，不要停下来干等。

## 六、收尾
给一份简短汇总：覆盖了哪几层、每层多少条、哪些层缺（以及为什么缺）、下一步建议。
不要复述全部条目 —— 它们在面板里。完整分层方法论见 info-hunter-method 技能。`

/**
 * 激活 preset 半。
 *
 * ## 工具注册必须等 store，不能"取一次算数"
 *
 * Host 半（`index.js`）和 preset 半是两个独立插件，激活顺序**不受我们控制**：
 * 重启、重装、热重载、面板里加行之后重启……任何顺序都可能出现"预设先起来、store 还没
 * `provide`"。早先这里写的是 `ctx.get('infohunterStore')` 取一次，取不到就只 warn 一下返回 ——
 * 结果是六个工具**静默全不注册**，模型那头看到的是 `unknown tool "expose_tool_run"`，
 * 而面板、数据库、配置一切正常，无从下手。
 *
 * `ctx.inject(deps, cb)` 的语义正是"等这些服务可用时再执行，已就绪就立刻执行"，
 * 所以这里改用它：无论谁先就绪，工具最终都会注册上。它和下面 `systemPrompt`、以及
 * `index.js` 里 `webServer` 的写法保持同一种模式 —— 不依赖激活顺序。
 *
 * @param {object} ctx - preset 层上下文。
 */
export function apply(ctx) {
  ctx.inject(['infohunterStore'], (scope) => {
    const store = scope.infohunterStore
    if (store === undefined || typeof store.pageAssets !== 'function') {
      // 服务出现了但形状不对：这属于真的不兼容，值得留下明确痕迹。
      ctx.logger?.warn?.('[infohunter] infohunterStore 形状不对（Host 半版本不匹配？），收集工具未注册。')
      return
    }
    registerTools(scope, store)
  })

  void registerSkill(ctx)

  // 常驻段：`ctx.inject` 保证 systemPrompt 就绪后再注册；注册本身是 fiber effect。
  // 名字全局唯一，重复注册会抛错（预设按会话挂载），所以兜一层。
  ctx.inject(['systemPrompt'], (scope) => {
    try {
      scope.systemPrompt.section({ name: 'infohunter:method', order: SECTION_ORDER, text: INSTRUCTIONS })
    } catch (error) {
      ctx.logger?.warn?.(`[infohunter] 常驻段注册失败（重复挂载？）：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
