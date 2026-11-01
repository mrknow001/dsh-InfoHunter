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

import {
  ENTRY_TYPE_LABELS, PURPOSE_LABELS, SHAPE_OTHER_MAX, asPurpose, asShapes, canonicalKind, describeInputRelation,
  describeKinds, describeShapeLegend, describePurposes, describeShapes, shapeIdList,
} from './vocabulary.js'
import { describeQuery, splitEndpoint } from './assets.js'
import { probeHttp, probeTcp, resolveHost } from './fetch.js'
import { LAYERS } from './coverage.js'
import { planProgress } from './plan.js'
import { defaultSkillsRoot, readSkillFromDir, validateSkill } from './skillpack.js'
import { MCP_TIMEOUTS, connectMcp, normalizeServerName, renderToolResult } from './mcp.js'

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
  // 输入/输出是协同的关键：用户自己配的工具模型不认识，只能靠这两行知道"吃什么、吐什么"。
  // `other` 单独处理 —— 它不是一个形态，而是"上面都不像，我另写一句"。
  // 空间测绘**没有** outputs：它的输出就是上面那行 `能出:`（capabilities），
  // 再渲染一次「输出」等于给同一件事两个真相。
  const sides = entry.type === 'skill'
    ? []
    : entry.type === 'mapping' ? [['inputs', '输入']] : [['inputs', '输入'], ['outputs', '输出']]
  const shapeLines = []
  for (const [key, label] of sides) {
    const picked = Array.isArray(entry[key]) ? entry[key] : []
    const shapes = picked.filter((id) => id !== 'other')
    // 输入要连条件关系一起说清："给一个就能查"和"必须凑齐"是两件事。
    const decided = key === 'inputs'
      ? describeInputRelation(shapes, entry.inputMode, entry.inputModeNote)
      : describeShapes(shapes)
    const other = String(entry[`${key}Other`] ?? '').trim()
    const custom = picked.includes('other')
      ? `其他: ${other === '' ? '(勾了但没写内容)' : other}`
      : ''
    const parts = [decided, custom].filter((value) => value !== '')
    shapeLines.push(`  ${label}: ${parts.length === 0 ? '(未声明 —— 只能从说明判断，判断不出就问用户)' : parts.join('；')}`)
  }
  if (entry.type === 'tool') {
    const head = `[${ENTRY_TYPE_LABELS.tool}] ${entryName} — 用途 ${entry.purpose}（${PURPOSE_LABELS[entry.purpose] ?? entry.purpose}）`
    const description = String(entry.description ?? '').trim()
    const lines = [head, `  路径: ${String(entry.path ?? '')}`]
    lines.push(description === '' ? '  说明: (未填写 —— 先看路径判断用法，或请用户补一段说明)' : `  说明: ${description.slice(0, 2000)}`)
    lines.push(...shapeLines)
    if (note !== '') lines.push(`  备注: ${note.slice(0, 400)}`)
    return lines.join('\n')
  }
  if (entry.type === 'skill') {
    const skillName = String(entry.skillName ?? '').trim()
    const description = String(entry.description ?? '').trim()
    const files = Number(entry.files) || 0
    const bytes = Number(entry.bytes) || 0
    const head = `[${ENTRY_TYPE_LABELS.skill}] ${entryName} — `
      + (skillName === '' ? '(未上传，模型看不到这个技能)' : `技能名 ${skillName}`)
    const lines = [head]
    lines.push(description === '' ? '  说明: (未填写)' : `  说明: ${description.slice(0, 800)}`)
    if (files > 0) {
      lines.push(`  技能包: ${files} 个文件，解压后 ${bytes} 字节`
        + (String(entry.uploadedAt ?? '') === '' ? '' : `，上传于 ${String(entry.uploadedAt).slice(0, 19)}`))
    }
    if (note !== '') lines.push(`  备注: ${note.slice(0, 400)}`)
    return lines.join('\n')
  }
  if (entry.type === 'mcp') {
    const transport = entry.transport === 'http' ? 'http' : 'stdio'
    const target = transport === 'http'
      ? String(entry.url ?? '')
      : [String(entry.command ?? ''), ...(Array.isArray(entry.args) ? entry.args : [])].join(' ')
    const status = mcpStatus.get(entry.id)
    const head = `[${ENTRY_TYPE_LABELS.mcp}] ${entryName} — ${transport}：${target}`
    const lines = [head]
    if (status === undefined) {
      lines.push('  状态: 未连接（这一行还没连上，模型看不到它的工具）')
    } else if (status.state === 'error') {
      lines.push(`  状态: 连接失败 —— ${String(status.error ?? '').slice(0, 400)}`)
    } else {
      const tools = Array.isArray(status.tools) ? status.tools : []
      lines.push(`  状态: 已连接，工具 ${tools.length} 个${tools.length === 0 ? '' : `（${tools.slice(0, 20).join('、')}${tools.length > 20 ? ' …' : ''}）`}`)
      lines.push('  工具名形如 mcp__<server>__<tool>，直接调用即可，参数按各自的 schema。')
    }
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
  lines.push(...shapeLines)
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
/**
 * 汇总/总览类写法。这些**不是资产** —— 它们是"清单"，要写进 detail 或最终汇总。
 *
 * 真机上出现过 `tyfo.com 子域总览` 被当成资产，在面板里是一整行 `—`。
 */
const SUMMARY_WORDS = /(总览|汇总|清单|概览|统计|summary|overview)/i

/** 字段是否为空（数组看长度）。 */
function isEmptyField(value) {
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'number') return value === 0
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * 这条记录该不该被拒。
 *
 * **规则按字段判，不按 kind 判**：只要这条记录声明了端点级事实（协议/状态码/服务/版本/
 * banner/端口 任一），就必须带端口。这样加一种记录类型不需要动规则，也不会出现
 * "这条算 port 还是 service" 的争论。
 *
 * @param row - 待写入的记录。
 * @returns 拒绝理由；空串表示通过。
 */
function rejectReason(row) {
  const asset = String(row?.asset ?? '')
  if (SUMMARY_WORDS.test(asset)) {
    return '汇总/总览不是资产 —— 写进 detail 或最终汇总，资产只记具体端点（host:port）'
  }
  const endpoint = splitEndpoint(asset)
  const port = Number(row?.port) || 0
  const declared = [
    isEmptyField(row?.protocol) ? '' : 'protocol',
    isEmptyField(row?.service) ? '' : 'service',
    isEmptyField(row?.version) ? '' : 'version',
    isEmptyField(row?.banner) ? '' : 'banner',
    Number(row?.status) > 0 ? 'status' : '',
  ].filter((item) => item !== '')
  const endpointLevel = port > 0 || endpoint.port !== undefined || declared.length > 0
  if (endpointLevel && port === 0 && endpoint.port === undefined) {
    return `声明了端点级事实（${declared.join('、') || '协议/服务'}）却没有端口 —— 写成 host:端口，80/443 也不能省`
  }
  return ''
}

/**
 * 建议补齐的字段（不拦，只点名）。
 *
 * 这是"资产里 IP 一片空"的根因：工具输出明明有 IP / 状态码，模型只填了 asset + title，
 * 旧回执照样说"成功"，于是没人发现字段丢了。
 *
 * @param row - 已通过校验的记录。
 * @returns 缺失的建议字段名。
 */
function softFieldsMissing(row) {
  const out = []
  const protocol = String(row?.protocol ?? '').toLowerCase()
  const web = protocol === 'http' || protocol === 'https' || row?.kind === 'web' || Number(row?.status) > 0
  if (isEmptyField(row?.ip)) out.push('ip')
  if (web && isEmptyField(row?.status)) out.push('status')
  if (web && isEmptyField(row?.title)) out.push('title')
  if (web && isEmptyField(row?.tech)) out.push('tech')
  return out
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
      '读取『暴露面收集』的配置：本地工具（路径 + 用法说明）、空间测绘平台'
      + '（BaseURL、Key、API 说明、能出哪些数据）、用户上传的技能、以及 MCP server（已连上的会把工具直接注册给你）。'
      + '开始任何收集动作前先调它 —— 配置由用户在面板维护，可能为空。'
      + '\n每行还声明**输入/输出形态**与输入的**条件关系**：A 的输出命中 B 的输入，B 就是 A 的下游，'
      + '把结果直接喂过去，不用猜参数（工具的输出来自 outputs，空间测绘的输出来自它勾选的「能出」）。'
      + '用 needs / produces 反查"谁吃我手上的""谁能给我要的"，看清关系（任一即可 / 需同时 / 自定义说明）够不够；'
      + '缺输入就别硬调，先回去收集或问用户。'
      + '\n本机程序只能通过 expose_tool_run 执行，平台只能通过 expose_mapping_call 查，检索用 web_search。'
      + '面板里没有的不要自己造：不要拼参数、不要假装有工具、不要到本机别处找程序。'
      + '不要把返回的 Key 写进任何落盘文件或报告。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['all', 'tool', 'mapping', 'skill', 'mcp'], description: '只列某一类，缺省 all。' },
        purpose: {
          type: 'string',
          description: `只列覆盖这类数据的能力（取值：${describePurposes()}）。工具按它的单一用途匹配，空间测绘按它勾选的能力匹配。缺省不筛选。`,
        },
        needs: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: '只列**输入**能吃它的行 —— 「我手上是子域名，谁能往下做？」填 subdomain。'
            + '给数组表示"这些我都有"（如 ["ip","port"]），此时按每行声明的条件关系判定。缺省不筛选。',
        },
        produces: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: '只列**输出**含它的行 —— 「我要 IP，谁能给我？」填 ip。缺省不筛选。',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args) {
      const wantType = ['tool', 'mapping', 'skill', 'mcp'].includes(args?.type) ? args.type : undefined
      const wantPurpose = args?.purpose === undefined ? undefined : asPurpose(args.purpose)
      /** 形态参数接受单个 id 或数组。 */
      const asShapeArg = (value) => (Array.isArray(value) ? asShapes(value) : asShapes([value]))
      const wantNeeds = args?.needs === undefined ? undefined : asShapeArg(args.needs)
      const wantProduces = args?.produces === undefined ? undefined : asShapeArg(args.produces)
      // 非法形态值不能静默当成"没筛选"——那会让模型以为所有行都不能做这件事。
      const badShape = wantNeeds !== undefined && wantNeeds.length === 0
        ? JSON.stringify(args.needs)
        : wantProduces !== undefined && wantProduces.length === 0 ? JSON.stringify(args.produces) : ''
      if (badShape !== '') {
        return { text: `「${badShape}」不是合法形态。合法取值：${shapeIdList()}。`, count: 0 }
      }
      /** 输入形态匹配：`and` 行要求全中，`or` / `custom` 行任一命中即可。 */
      const coversInputs = (entry, wanted) => {
        const declared = Array.isArray(entry.inputs) ? entry.inputs : []
        return entry.inputMode === 'and'
          ? wanted.every((id) => declared.includes(id))
          : wanted.some((id) => declared.includes(id))
      }
      /**
       * 输出匹配：工具看 `outputs` 形态，空间测绘看勾选的 `capabilities` ——
       * 后者本来就是"一次查询能出哪些数据"，再让它在面板里勾一遍输出就是第二个真相。
       */
      const coversOutputs = (entry, wanted) => wanted.every((id) => (entry.type === 'mapping'
        ? Array.isArray(entry.capabilities) && entry.capabilities.includes(id)
        : Array.isArray(entry.outputs) && entry.outputs.includes(id)))
      const entries = store
        .enabledEntries(wantType)
        .filter((entry) => wantPurpose === undefined || coversKind(entry, wantPurpose))
        .filter((entry) => wantNeeds === undefined || coversInputs(entry, wantNeeds))
        .filter((entry) => wantProduces === undefined || coversOutputs(entry, wantProduces))
      if (entries.length === 0) {
        // 区分"整份配置为空"和"筛选没命中"：混为一谈会让模型误判成用户什么都没配。
        const filters = [
          wantType === undefined ? '' : `类型 ${wantType}`,
          wantPurpose === undefined ? '' : `能力 ${wantPurpose}`,
          wantNeeds === undefined ? '' : `输入 ${wantNeeds.join('+')}`,
          wantProduces === undefined ? '' : `输出 ${wantProduces.join('+')}`,
        ].filter((part) => part !== '')
        return {
          text: filters.length > 0
            ? `没有配置行匹配「${filters.join('、')}」。去掉筛选再调一次 expose_config 可以看到全量配置；如果某个平台确实能做这件事，可能是它的能力没在面板里勾选，或者它的输入/输出形态没声明。`
            : '配置为空。请告诉用户「面板 → 配置」里还没有可用的工具或空间测绘平台 —— '
              + '没有配置就没有专项手段，不要编造能力，也不要用通用网络访问假装跑过扫描。',
          count: 0,
        }
      }
      const shown = entries.slice(0, 40)
      // 词表只在有行真正用形态时才渲染：没声明形态的老配置不必为它付上下文。
      const declared = entries.filter((e) => (Array.isArray(e.inputs) && e.inputs.length > 0)
        || (e.type !== 'mapping' && Array.isArray(e.outputs) && e.outputs.length > 0)).length
      const countOf = (type) => entries.filter((entry) => entry.type === type).length
      const head = `配置 ${entries.length} 条（工具 ${countOf('tool')} / 空间测绘 ${countOf('mapping')}`
        + ` / 技能 ${countOf('skill')} / MCP ${countOf('mcp')}；已声明输入输出的 ${declared} 条）。`
      const legend = declared === 0 ? '' : `\n形态词表（输入/输出共用这套 id）：${describeShapeLegend()}`
        + '\n串接规则：一行的输出命中另一行的输入，后者就是前者的下游（空间测绘的输出看它的「能出」）。'
      const body = shown.map(formatEntry).join('\n\n')
      const tail = entries.length > shown.length ? `\n\n…还有 ${entries.length - shown.length} 条未列出（按 need 收窄 type/purpose 再看）。` : ''
      return { text: clamp(`${head}${legend}\n\n${body}${tail}`), count: entries.length }
    },
  })

  // ── 空间测绘节流 ────────────────────────────────────────────────────────
  //
  // 空间测绘平台按调用次数计费、按频率封禁，而模型天然喜欢并发连发。
  // 章程里写"随机延迟 3–10 秒"是靠自觉，实测靠不住（跟"授权边界"写进提示词是同一种失败），
  // 所以这里做成硬约束：同一个平台两次请求之间至少隔一个随机 3–10 秒的间隔，
  // 并且**串行**——上一条没结束，下一条连发都发不出去。
  //
  // 状态放模块级（不是每次 apply 一份）：配置和 Key 本来就是全局的，
  // 多个会话、多个子代理共享同一份配额，节流也必须共享。

  /** 缺省间隔区间（毫秒）。 */
  const MAPPING_GAP_MIN = 3_000
  const MAPPING_GAP_MAX = 10_000

  /** 平台 id → 上次请求结束时刻。 */
  const mappingLastAt = new Map()
  /** 平台 id → 队尾 promise（用来串行化）。 */
  const mappingQueue = new Map()

  /**
   * 间隔区间。测试可以把 `INFOHUNTER_MAPPING_GAP_MS` 设成一个小数字，
   * 避免 smoke 真的等 3 秒；生产不设这个变量，就一定是 3–10 秒。
   *
   * @returns `[min, max]`
   */
  function mappingGapRange() {
    const override = Number(process.env.INFOHUNTER_MAPPING_GAP_MS)
    if (Number.isFinite(override) && override >= 0) return [override, override]
    return [MAPPING_GAP_MIN, MAPPING_GAP_MAX]
  }

  /**
   * 可被中断的等待。
   *
   * @param ms - 毫秒。
   * @param signal - 工具取消信号。
   * @returns {Promise<void>}
   */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener?.('abort', () => {
        clearTimeout(timer)
        reject(new Error('已取消'))
      }, { once: true })
    })
  }

  /**
   * 排队并占住一个请求槽位。
   *
   * @param platformId - 平台 id（同一平台共享节流）。
   * @param signal - 取消信号。
   * @returns `{ waited, finish }` —— 调用方**必须**在 finally 里调用 `finish()`。
   */
  async function reserveMappingSlot(platformId, signal) {
    const previous = mappingQueue.get(platformId) ?? Promise.resolve()
    let release
    const mine = new Promise((resolve) => { release = resolve })
    mappingQueue.set(platformId, previous.then(() => mine))
    await previous
    const [min, max] = mappingGapRange()
    const delay = min === max ? min : min + Math.floor(Math.random() * (max - min + 1))
    const last = mappingLastAt.get(platformId)
    const waited = last === undefined ? 0 : Math.max(0, last + delay - Date.now())
    try {
      if (waited > 0) await sleep(waited, signal)
    } catch (error) {
      // 等待期间被取消（用户中断）：必须把队列放行，否则这个平台之后永远排在它后面。
      release()
      throw error
    }
    return {
      waited,
      finish() {
        // 从**结束**时刻起算间隔：慢请求不会把下一条挤到它还没结束时发出去。
        mappingLastAt.set(platformId, Date.now())
        release()
      },
    }
  }

  // ── 2. 调空间测绘 ──────────────────────────────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_mapping_call',
    description:
      '按配置里的空间测绘平台发一次查询，自动注入 API Key 并返回响应体。'
      + '空间测绘是综合查询：一次往往同时给出域名、IP、端口、协议、banner、标题、指纹、证书。'
      + '用 expose_config 的 needs / produces 找出"吃我手上这些、吐我要的那些"的平台，再看该行声明的'
      + '条件关系够不够（需同时的行少一个条件就别硬调），不要随便挑一个平台硬塞。'
      + '平台名取自 expose_config（name 或 id，支持前缀匹配）。路径、参数、查询语法以该平台的 API 说明为准 —— '
      + '本工具只负责拼 URL 与注入 Key，不替你猜语法。'
      + '仅 GET/POST。**节流由工具强制**：同一平台串行、每次之间随机 3–10 秒，'
      + '所以连续查多个条件时一次一个地调即可，不要并发，也不用自己再 sleep。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '平台名或 id（见 expose_config）。' },
        path: { type: 'string', description: '拼在 BaseURL 之后的路径，如 search/global。缺省直接请求 BaseURL。' },
        query: { type: 'object', additionalProperties: true, description: '查询参数键值对（会 URL 编码；非字符串值按 JSON 序列化，别把 POST body 塞这里）。' },
        method: { type: 'string', enum: ['GET', 'POST'], description: '缺省 GET。' },
        body: { type: 'string', description: 'POST 的请求体，通常是 JSON 字符串。' },
        keyMode: { type: 'string', enum: ['query', 'header', 'none'], description: 'Key 注入方式：query（缺省）/ header / none。' },
        keyName: { type: 'string', description: 'Key 的参数名或头名；query 缺省 key，header 缺省 authorization。' },
        bodyMax: { type: 'number', description: '响应体截断字符数，缺省 20000，上限 200000。' },
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

      const response = await (async () => {
        // 节流是硬约束，不是建议：同一平台两次请求之间随机 3–10 秒，且串行。
        const slot = await reserveMappingSlot(String(found.id), exec?.signal)
        try {
          const res = await fetch(url, {
            method,
            headers,
            ...(method === 'POST' && body !== '' ? { body } : {}),
            signal: exec?.signal,
          })
          const textBody = await res.text()
          return { res, textBody, waited: slot.waited }
        } finally {
          slot.finish()
        }
      })()
      const raw = response.textBody
      const limit = Number.isFinite(args?.bodyMax) && args.bodyMax > 0 ? Math.min(200_000, Math.trunc(args.bodyMax)) : 20_000
      const truncated = raw.length > limit
      const text = truncated ? `${raw.slice(0, limit)}\n…[已截断，完整长度 ${raw.length}]` : raw
      const throttle = response.waited > 0 ? `（节流等待 ${(response.waited / 1000).toFixed(1)} 秒）` : ''
      return {
        text: `平台 ${label(found) || String(found.id)} 返回 HTTP ${response.res.status}${throttle}\n\n${text}`,
        status: response.res.status,
        length: raw.length,
        waitedMs: response.waited,
      }
    },
  })

  // ── 3. 记录观测（同时进「采集记录」与「资产清单」）──────────────────────
  registerToolSafely(ctx, {
    name: 'expose_record',
    description:
      '记录一次观测。同一个调用写两处，面板的两个视图就是它们：'
      + '\n· 「采集记录」——一行一条，按时间倒序，保留你写的 detail 原文，不合并（这是过程流水）。'
      + '\n· 「资产清单」——按 `host:port` 端点汇总，同端点重复记录会合并成一条（这是结果）。'
      + `\nkind 取值：${describeKinds()}`
      + '\nasset 写最小可定位单元（域名 / IP / IP:port），不要整段工具输出；detail 放证据原文（响应头、banner、证书主体、测绘原始字段）。'
      + '\n**三类都要写，但必须标**：直接观测到原值的不填或写 fact；观测到了但不确定算不算真资产'
      + '（拦截页、默认页、停放页、泛解析假子域、未经响应验证的 host 碰撞）写 suspect；'
      + '靠推理得出的写 infer，并把推理链写进 note。面板会把 suspect 标「可疑」、infer 标「推测」。'
      + '\n带 status/title/server/service/version/cert 的条目会同时补到资产上，所以可以分两次写同一个端点：先记端口，探完 Web 再补字段。'
      + '\n探到 Web 页时把 headers（响应头原文）和 body（去掉标签的正文）一起带上 —— 面板「详情」的两个页签读的就是它们；没有就显示"未采集"。'
      + '\n**工具输出里的 IP / 端口 / 状态码 / 服务名必须拆成字段写进来**，不要只在 detail 里贴一段原始输出：'
      + '\n面板是按字段展示的，字段空着就显示 `—`，等于这条资产白记了。回执里会点名"建议补"的字段，照着补一条即可。'
      + '\n没测的字段留空，不要猜。',
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
              kind: { type: 'string', description: '观测类型，取值见工具说明里的 kind 列表。这是"这次观测属于哪一层"（子域 / 端口 / Web / 指纹…），不是数据形态 —— 不要把 ip、url、cidr 这类形态值填进来。' },
              asset: { type: 'string', description: '被观测到的东西：域名 / IP / IP:端口。也可以写成 https://host:port，但那种写法等于声明"这个端点能打开 https"—— 只有真的能打开时才这么写，否则用裸 host:port。' },
              protocol: { type: 'string', description: '实测到的协议：http / https / ssh / redis 等。只有**真的能打开并返回响应**的端点才写 http / https（面板据此把资产变成可点击的链接）；只通了 TCP、TLS 握手失败、被重置的，留空或写实测到的别的协议。不写就不猜。' },
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
              headers: { type: 'string', description: 'HTTP 响应头原文（多行，最多 2000 字）。面板「详情 → 响应头」页签读它；探到 Web 页就顺手抄下来。' },
              body: { type: 'string', description: '页面正文的**可读文本**（去掉标签，最多 8000 字），不要塞整页 HTML。面板「详情 → 正文」页签读它。' },
              // ── 系统（app）定位 ──────────────────────────────────────────
              url: { type: 'string', description: '完整 URL（带路径），如 https://h:8443/admin/login。给了它就能定位到「系统」；只有 host:port 时只能记成端点。' },
              basePath: { type: 'string', description: '这个系统挂在端点的哪个根路径下（/admin/、/tenant/、/）。**只有你能判断时填**：内容页不要填，同一系统的多个页面写同一个 basePath。' },
              pageType: {
                type: 'string',
                enum: ['entry', 'content', 'asset', 'api', 'unknown'],
                description: '这条 URL 的页面类型：entry=系统入口；content=内容页（资讯/文章/商品详情）；asset=静态资源；api=接口；unknown=判不准。内容页会被挂进系统的证据列表，不会变成新系统。',
              },
              signals: {
                type: 'object',
                description: '判定"是否同一系统"的观测信号。有就填，没有就空着 —— 空着只会让判定进问题池，不会出错；猜一个反而会错并。',
                properties: {
                  templateHash: { type: 'string', description: '页面骨架指纹：HTML 去掉正文/数字/时间后取 hash（httpx 的 body hash 也算）。' },
                  entryScript: { type: 'string', description: '第一个 <script src> 的路径（SPA 判断靠它）。' },
                  faviconHash: { type: 'string', description: 'favicon 的 hash。' },
                  assetPrefix: { type: 'string', description: '静态资源目录前缀，如 /static/app-a/。' },
                  loginUrl: { type: 'string', description: '未登录时被跳转到的登录页 URL。' },
                  cookieNames: { type: 'array', items: { type: 'string' }, description: '响应里设置的业务 cookie 名（不要填 _ga / SERVERID 这类通用埋点）。' },
                },
                additionalProperties: false,
              },
              note: { type: 'string', description: '备注或推断说明。' },
              sources: { type: 'array', items: { type: 'string' }, description: '产出这条观测的工具/平台名，与面板配置同名，只写名字。' },
              confidence: { type: 'number', description: '置信度 0–100。不填表示未评估（面板留空），不要为了凑字段编一个数字。' },
              verdict: {
                type: 'string',
                enum: ['fact', 'suspect', 'infer'],
                description: '判定等级：fact = 直接观测到原值；suspect = 观测到了但不确定算不算真资产；'
                  + 'infer = 靠推理链得出（推理链写进 note）。不填 = 未判定，不覆盖已有标记；'
                  + '后续拿到直接证据写 fact 能把标记清掉。面板把 suspect 标「可疑」、infer 标「推测」。',
              },
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
      const rejected = []
      for (const [index, item] of raw.entries()) {
        const asset = typeof item?.asset === 'string' ? item.asset.trim() : ''
        if (asset === '') {
          skipped.push(`#${index + 1}（缺 asset）`)
          continue
        }
        const row = {
          ...item,
          target: target === '' ? item?.target : target,
          kind: canonicalKind(item?.kind),
          asset,
          detail: typeof item?.detail === 'string' ? item.detail : '',
        }
        const problem = rejectReason(row)
        if (problem !== '') {
          rejected.push(`${asset}：${problem}`)
          continue
        }
        records.push(row)
      }

      const { written, added, merged } = await store.appendRecords(sessionId, records)

      // ## 完整性自检（按字段，不按 kind）
      //
      // 规则看"这条记录声明了什么"，不看它的 kind —— 否则每加一种类型都要改一遍规则，
      // 也解释不清"这条算 port 还是 service"。见 rejectReason()。
      const suggested = []
      for (const row of records) {
        const lacks = softFieldsMissing(row)
        if (lacks.length > 0) suggested.push(`${row.asset} 建议补 ${lacks.join('、')}`)
      }
      const text = written.length === 0
        ? `没有写入任何记录。${rejected.length > 0 ? `被拒 ${rejected.length} 条` : ''}${skipped.length > 0 ? `，跳过 ${skipped.length} 条` : ''}`
        : `记录 ${written.length} 条（资产：新增 ${added}，合并 ${merged}）`
          + (skipped.length > 0 ? `\n跳过 ${skipped.length} 条：${skipped.join('，')}` : '')
          + (rejected.length === 0
            ? ''
            : `\n\n**${rejected.length} 条被拒**（改完再提交，只补这些即可）：\n`
              + rejected.slice(0, 30).join('\n')
              + (rejected.length > 30 ? `\n… 还有 ${rejected.length - 30} 条` : ''))
          + (suggested.length === 0
            ? ''
            : `\n\n${suggested.length} 条字段不全：工具输出里有的就补上（面板上这些位置现在是空的）：\n`
              + suggested.slice(0, 30).join('\n')
              + (suggested.length > 30 ? `\n… 还有 ${suggested.length - 30} 条` : ''))
      return {
        text,
        recorded: written.length,
        added,
        merged,
        skipped: skipped.length,
        rejected: rejected.length,
        suggested: suggested.length,
      }
    },
  })

  // ── 4. 信息产物：云资源 / 泄露物 / API 文档 / 凭据 / 安装包 ──────────────
  //
  // 和资产分开：资产是"可定位、可复核"的端点，产物是"一段文字"。
  // 所以一条产物一张卡，正文只在弹窗里看；敏感串由面板配置的正则自动打标。
  registerToolSafely(ctx, {
    name: 'expose_artifact',
    description:
      '记录**信息产物**：云资源（公开 bucket、AK）、泄露物（.git、备份包、配置）、API 文档（swagger/openapi）、'
      + '凭据（账号口令、token、私钥）、安装包（文件名/版本/下载地址），以及其它以文字为主的发现。'
      + '\n和 expose_record 的分工：资产是端点（host:port / 系统），产物是一段文字。'
      + '\n每条必须给 kind、title（一句话）、content（原文，≤8000 字）、howFound（查询语句 / 路径 / 方法）；'
      + 'source 写工具或平台名，url / host 能关联到资产就带上。'
      + '\n正文里的敏感串会按面板配置的正则自动打标，不用自己评级别。'
      + '\n**不要把整页 HTML 塞进 content**，只要证据片段和能定位它的 URL。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '一次 1–200 条。同一条产物重复提交只累加次数，不会变两行。',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['cloud', 'leak', 'api_doc', 'credential', 'package', 'other'],
                description: 'cloud=云资源；leak=泄露物；api_doc=接口文档；credential=凭据；package=安装包；other=其它。',
              },
              title: { type: 'string', description: '一句话说清这是什么（≤200 字），例如「阿里云 AccessKey（LTAI…）」或「/backup/site.zip 可下载」。' },
              content: { type: 'string', description: '产物原文或证据片段（≤8000 字）。凭据贴凭据本身，文档贴关键段落，安装包贴文件名 + 版本 + 下载 URL。' },
              source: {
                type: 'object',
                description: '来源：哪个工具 / 平台 / 页面发现的。',
                properties: {
                  name: { type: 'string', description: '工具或平台名，与面板配置同名。' },
                  type: { type: 'string', enum: ['tool', 'platform', 'url', 'manual'], description: '来源类型。' },
                  url: { type: 'string', description: '发现它的页面地址（有就填）。' },
                },
                additionalProperties: false,
              },
              howFound: { type: 'string', description: '怎么发现的：查询语句、请求的路径、用了什么方法（≤2000 字）。复核时要能照着走一遍。' },
              url: { type: 'string', description: '产物所在的 URL（可点开）。' },
              host: { type: 'string', description: '关联的域名或 IP（可空）。' },
              verdict: {
                type: 'string',
                enum: ['fact', 'suspect', 'infer'],
                description: 'fact=直接看到原文；suspect=像但没验证；infer=靠推断。不填=未判定。',
              },
              confidence: { type: 'number', description: '置信度 0–100，不填=未评估。' },
            },
            required: ['kind', 'title', 'content', 'howFound'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法记录产物')
      const items = Array.isArray(args?.items) ? args.items : []
      if (items.length === 0) throw new Error('items 不能为空')
      if (items.length > 200) throw new Error(`一次最多 200 条（收到 ${items.length} 条），请分批`)
      const { written, added, duplicated, hits } = await store.appendArtifacts(sessionId, items)
      const parts = [`记录 ${written.length} 条产物（新增 ${added}，重复合并 ${duplicated}）`]
      if (hits > 0) {
        const flagged = written.filter((row) => row.hits.length > 0)
        parts.push(`命中敏感规则 ${hits} 处：${flagged.map((row) => `${row.title}（${row.hits.map((hit) => hit.name).join('、')}）`).slice(0, 10).join('；')}`)
      }
      return { text: parts.join('\n'), recorded: written.length, added, duplicated, hits }
    },
  })

  // ── 5. 计划与态势：让"做到哪、还缺什么"可读可写 ────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_plan',
    description:
      '读取或更新本会话的**采集计划**。计划是跨轮记忆：会话是无状态的，压缩一次对话，'
      + '不落库的计划就没了。\n'
      + '不带参数 = 读计划；带 scope / stages = 合并更新。\n'
      + '阶段骨架固定：scope(确定范围) → dns → ports → services → web → systems → artifacts → wrapup，'
      + '可以追加自定义阶段，但不要删骨架。\n'
      + 'scope.targets 只登记用户**明确给出**的目标，绝不擅自放大；constraints 收 allow/deny，'
      + '**必须把指代词换成具体值**（写"只测 a.com"，不写"只测当前目标"），因为它会被单独注入后续上下文。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          description: '范围与约束（可选，给了就合并）。',
          properties: {
            targets: { type: 'array', items: { type: 'string' }, description: '用户明确给出的目标（域名 / IP / CIDR）。' },
            constraints: {
              type: 'array',
              description: '操作约束：allow / deny，text 必须自包含（含具体目标）。',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['allow', 'deny'] },
                  text: { type: 'string' },
                },
                required: ['type', 'text'],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        stages: {
          type: 'array',
          description: '阶段数组（可选）。只传要改的阶段即可，未传的保持原状。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '阶段 id（骨架里的或自定义的）。' },
              label: { type: 'string' },
              state: { type: 'string', enum: ['pending', 'active', 'done', 'skipped'] },
              tool: { type: 'string', description: '这个阶段用的是什么工具/平台。' },
              expected: { type: 'array', items: { type: 'string' }, description: '这个阶段预期落成的字段。' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法读写计划')
      const hasUpdate = args?.scope !== undefined || args?.stages !== undefined
      const plan = hasUpdate
        ? await store.savePlan(sessionId, { scope: args.scope, stages: args.stages })
        : store.plan(sessionId)
      const progress = planProgress(plan)
      const lines = plan.stages.map((stage) => {
        const mark = stage.state === 'done' ? '✓' : stage.state === 'active' ? '▶' : stage.state === 'skipped' ? '–' : '·'
        const tool = stage.tool === '' ? '' : ` [${stage.tool}]`
        return `${mark} ${stage.id}${tool}${stage.expected.length === 0 ? '' : ` → ${stage.expected.join('/')}`}`
      })
      const scopeLine = plan.scope.targets.length === 0
        ? '范围：未登记'
        : `范围：${plan.scope.targets.join('、')}`
      const constraintLine = plan.scope.constraints.length === 0
        ? '约束：无'
        : `约束：${plan.scope.constraints.map((item) => `${item.type === 'deny' ? '禁止' : '允许'} ${item.text}`).join('；')}`
      return {
        text: `${scopeLine}\n${constraintLine}\n进度 ${progress.done}/${progress.total}（${progress.pct}%），当前阶段 ${progress.current || '全部完成'}\n${lines.join('\n')}`,
        progress,
      }
    },
  })

  registerToolSafely(ctx, {
    name: 'expose_state',
    description:
      '一次拿到当前态势：计划进度 + 覆盖度（资产 × 证据层）+ 字段缺口 + 未决问题 + 最近派活。\n'
      + '**每轮开始先调它**，不要自己拼状态：会话没有记忆，这里才是真相。\n'
      + '看到"未覆盖 N（共 M）"时，N 是被截断的展示，M 才是总数 —— 别把没显示当成没做过。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法读取态势')
      const plan = store.plan(sessionId)
      const progress = planProgress(plan)
      const coverage = store.coverage(sessionId)
      const assets = store.assetsOf(sessionId)
      const missingPort = assets.filter((row) => (row.protocol === 'http' || row.protocol === 'https') && (row.port ?? 0) === 0)
      const missingIp = assets.filter((row) => (row.port ?? 0) > 0 && String(row.ip ?? '') === '')
      const openQuestions = store.questionsOf(sessionId, 'open')
      const tasks = store.tasksOf(sessionId)
      const layerLine = LAYERS.map((layer) => `${layer.label} ${coverage.byLayer[layer.id] ?? 0}/${coverage.total}`).join(' · ')
      const current = plan.stages.find((stage) => stage.state === 'active')
        ?? plan.stages.find((stage) => stage.state === 'pending')
      return {
        text: [
          `计划 ${progress.done}/${progress.total}（${progress.pct}%）${current === undefined ? '· 全部完成' : `· 当前 ${current.id}`}`,
          `资产 ${coverage.total} 条 · 完整覆盖 ${coverage.overall}%`,
          `分层：${layerLine}`,
          `未覆盖 ${coverage.uncovered.length}（共 ${coverage.total}）`,
          `缺口：缺端口 ${missingPort.length} 条、缺 IP ${missingIp.length} 条、待确认 ${openQuestions.length} 条`,
          `派活：进行中 ${tasks.filter((row) => row.state === 'running').length} / 完成 ${tasks.filter((row) => row.state === 'done').length} / 失败 ${tasks.filter((row) => row.state === 'failed').length}`,
        ].join('\n'),
        progress,
        coverage,
      }
    },
  })

  registerToolSafely(ctx, {
    name: 'expose_task',
    description:
      '登记一次派活（通常是派给子代理），用于去重与留痕。\n'
      + 'start：同一 (target, layer, tool) 已经派过或做过就不重复派，回执会告诉你重复；\n'
      + 'finish：写回结果或失败原因，**失败也要记**（负结果，避免下次重复尝试）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'finish'], description: 'start = 派活；finish = 收尾。' },
        target: { type: 'string', description: 'start 用：目标（host / IP / 域名）。' },
        layer: { type: 'string', description: 'start 用：证据层或阶段 id（dns / ports / web / systems / artifacts…）。' },
        tool: { type: 'string', description: 'start 用：用哪个工具/平台。' },
        id: { type: 'string', description: 'finish 用：任务 id。' },
        state: { type: 'string', enum: ['done', 'failed', 'skipped'], description: 'finish 用：结果状态。' },
        result: { type: 'string', description: 'finish 用：结果摘要（几条资产/产物）。' },
        error: { type: 'string', description: 'finish 用：失败原因。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法登记派活')
      if (args?.action === 'finish') {
        const id = typeof args?.id === 'string' ? args.id : ''
        if (id === '') throw new Error('finish 需要 id')
        const task = await store.finishTask(sessionId, id, { state: args?.state, result: args?.result ?? null, error: args?.error })
        if (task === undefined) throw new Error(`没有这个任务：${id}`)
        return { text: `任务 ${id} → ${task.state}${task.error === '' ? '' : `（${task.error}）`}`, task }
      }
      const { task, duplicate } = await store.startTask(sessionId, {
        target: args?.target,
        layer: args?.layer,
        tool: args?.tool,
      })
      return {
        text: duplicate
          ? `这条已经派过/做过（${task.state}）：${task.target} ${task.layer} ${task.tool} —— 不要重复派`
          : `已派：${task.id} ${task.target} ${task.layer} ${task.tool}`,
        task,
        duplicate,
      }
    },
  })

  // ── 6. 基础补全：DNS / 证书 / 响应头 / 正文（用户工具没给时兜底）──────────
  registerToolSafely(ctx, {
    name: 'expose_enrich',
    description:
      '基础补全：对一个主机做 **DNS 解析**，对已开放端口做 **HTTP(S) GET**，取回'
      + '状态码 / 响应头原文 / 页面标题 / 正文摘要 / **TLS 证书**（主体、签发者、SAN、到期），'
      + '并**自动落库**（不需要你再调 expose_record）。\n'
      + '用途：用户配置的工具只回了"端口开着/状态码是多少"，而面板「详情」页签需要证书、响应头、正文时。\n'
      + '顺序：**先用用户配置的工具**，它没给的字段再用这个补。\n'
      + '边界：只发 GET、不加参数；超时 8 秒；最多 20 个目标、并发 4；默认拒绝回环与云元数据地址。'
      + '不做端口扫描、不做指纹识别 —— 只补"能直接观测到的事实"。',
    parameters: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: '最多 20 个。有 port 才会发 HTTP 请求；只有 host 就只做 DNS 解析。',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string', description: '域名或 IP。' },
              port: { type: 'number', description: '已确认开放的端口；不填就只解析。' },
              scheme: { type: 'string', enum: ['http', 'https'], description: '不填默认 http（443 端口默认 https）。' },
            },
            required: ['host'],
            additionalProperties: false,
          },
        },
        allowPrivate: { type: 'boolean', description: '允许访问内网/回环地址（默认不允许，测试时才开）。' },
      },
      required: ['targets'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 120_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法补全')
      const targets = Array.isArray(args?.targets) ? args.targets.slice(0, 20) : []
      if (targets.length === 0) throw new Error('targets 不能为空')
      const allowPrivate = args?.allowPrivate === true

      const resolveOne = async (target) => {
        const host = String(target?.host ?? '').trim()
        const port = Number(target?.port) || 0
        const scheme = target?.scheme === 'https' ? 'https' : target?.scheme === 'http' ? 'http' : (port === 443 ? 'https' : 'http')
        const out = { host, port, scheme, ip: '', cname: '', dnsError: '' }
        if (host === '') return out
        const resolved = await resolveHost(host)
        out.ip = resolved.ips[0] ?? ''
        out.otherIps = resolved.ips.slice(1)
        out.cname = resolved.cname
        out.dnsError = resolved.error
        if (port <= 0) return out
        const probed = await probeHttp({ host, port, scheme, allowPrivate })
        out.probe = probed
        return out
      }

      // 小池子并发 4：够快，又不会一次打出去十几个连接。
      const results = []
      for (let index = 0; index < targets.length; index += 4) {
        const batch = targets.slice(index, index + 4)
        results.push(...await Promise.all(batch.map(resolveOne)))
      }

      const records = []
      const lines = []
      for (const item of results) {
        if (item.ip !== '' || item.cname !== '') {
          records.push({
            kind: 'domain',
            asset: item.host,
            ip: item.ip,
            cname: item.cname,
            sources: ['expose_enrich'],
            detail: item.otherIps.length === 0 ? '' : `其他解析：${item.otherIps.join(', ')}`,
          })
          lines.push(`${item.host} → ${item.ip || item.cname}${item.otherIps.length > 0 ? ` (+${item.otherIps.length})` : ''}`)
        } else if (item.dnsError !== '') {
          lines.push(`${item.host} → 解析失败：${item.dnsError}`)
        }
        const probe = item.probe
        if (probe === undefined) continue
        if (probe.ok !== true) {
          lines.push(`${item.host}:${item.port} → 请求失败：${probe.error}`)
          continue
        }
        const server = (() => {
          const match = /^server:\s*(.+)$/im.exec(String(probe.headers ?? ''))
          return match === null ? '' : match[1].trim()
        })()
        records.push({
          kind: 'web',
          asset: `${item.host}:${item.port}`,
          protocol: item.scheme,
          status: probe.status,
          title: probe.title,
          server,
          headers: probe.headers,
          body: probe.body,
          ip: item.ip,
          sources: ['expose_enrich'],
          detail: probe.url,
          ...(probe.cert === undefined ? {} : {
            cert: { subject: probe.cert.subject, issuer: probe.cert.issuer, san: probe.cert.san, notAfter: probe.cert.notAfter },
          }),
        })
        lines.push(`${item.host}:${item.port} → ${probe.status} ${probe.title === '' ? '' : `「${probe.title}」`}`
          + `${probe.cert === undefined ? '' : ` 证书 ${probe.cert.subject}`}`
          + `${probe.headers === '' ? '' : ' +响应头'}${probe.body === '' ? '' : ' +正文'}`)
      }

      const written = records.length === 0 ? { written: [], added: 0, merged: 0 } : await store.appendRecords(sessionId, records)
      const head = `补全 ${results.length} 个目标，写入 ${written.written.length} 条记录（新增 ${written.added}，合并 ${written.merged}）`
      return { text: `${head}\n${lines.join('\n')}`, targets: results.length, recorded: written.written.length }
    },
  })

  // ── 7. 验活：空间测绘结果必须二次验证 ──────────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_verify',
    description:
      '对资产做**二次验证**：空间测绘/搜索引擎的结果经常是几个月前的，端口早关了、站点早换了。\n'
      + '做两件事：① TCP 连通性（IP+端口还开着吗）；② 对 http/https 端口发一次 GET，'
      + '拿回状态码 / 标题 / 响应头 / 正文 / TLS 证书。\n'
      + '**连不上 → 标为失效（lifecycle=dead）**，保留原数据不删除；连得上 → 标 live，'
      + '并把这次观测到的字段合并进去（所以证书、响应头、正文会一起补上）。\n'
      + '回执会列出**变更**：状态码、标题、协议发生了变化。\n'
      + '默认验证本会话全部 Web 端点（最多 30 个）；也可以显式指定 targets。',
    parameters: {
      type: 'object',
      properties: {
        allWeb: { type: 'boolean', description: '验证本会话所有 http/https 端点（默认 false）。' },
        targets: {
          type: 'array',
          description: '显式指定要验证的端点（最多 30 个）。',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string' },
              port: { type: 'number' },
              scheme: { type: 'string', enum: ['http', 'https'] },
            },
            required: ['host', 'port'],
            additionalProperties: false,
          },
        },
        limit: { type: 'number', description: 'allWeb 时最多验多少个，缺省 30、最大 60。' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 300_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法验证')
      const assets = store.assetsOf(sessionId)
      const byKey = new Map(assets.map((row) => [row.key, row]))

      let targets = []
      if (args?.allWeb === true) {
        const limit = Math.min(60, Math.max(1, Number(args?.limit) || 30))
        targets = assets
          .filter((row) => row.nodeType !== 'app' && Number(row.port) > 0
            && (row.protocol === 'http' || row.protocol === 'https'))
          .slice(0, limit)
          .map((row) => ({ host: row.host, port: Number(row.port), scheme: row.protocol }))
      } else if (Array.isArray(args?.targets)) {
        targets = args.targets.slice(0, 30)
          .map((item) => ({
            host: String(item?.host ?? '').trim(),
            port: Number(item?.port) || 0,
            scheme: item?.scheme === 'https' ? 'https' : item?.scheme === 'http' ? 'http' : undefined,
          }))
          .filter((item) => item.host !== '' && item.port > 0)
      }
      if (targets.length === 0) throw new Error('没有可验证的目标：传 targets，或 allWeb=true')

      const lines = []
      let live = 0
      let dead = 0
      let changed = 0

      for (const target of targets) {
        const scheme = target.scheme ?? (target.port === 443 ? 'https' : 'http')
        const key = `${target.host}:${target.port}`
        const stored = byKey.get(key)
        const tcp = await probeTcp({ host: target.host, port: target.port, timeoutMs: 6000 })
        if (tcp.ok !== true) {
          dead += 1
          if (stored !== undefined) await store.applyVerification(sessionId, key, { live: false })
          lines.push(`${key} → 连接失败（${tcp.error}）· 已标记失效`)
          continue
        }
        const probe = await probeHttp({ host: target.host, port: target.port, scheme })
        if (probe.ok !== true) {
          // 端口开着但 HTTP 不通：可能是非 HTTP 服务，算"活着"但没 Web 证据。
          live += 1
          if (stored !== undefined) await store.applyVerification(sessionId, key, { live: true })
          lines.push(`${key} → 端口开着，但 HTTP 不通（${probe.error}）`)
          continue
        }
        live += 1
        const server = (() => {
          const match = /^server:\s*(.+)$/im.exec(String(probe.headers ?? ''))
          return match === null ? '' : match[1].trim()
        })()
        const fields = {
          protocol: scheme,
          status: probe.status,
          title: probe.title,
          server,
          headers: probe.headers,
          body: probe.body,
          ...(probe.cert === undefined ? {} : {
            certSubject: probe.cert.subject,
            certIssuer: probe.cert.issuer,
            certSan: probe.cert.san,
            certNotAfter: probe.cert.notAfter,
          }),
        }
        if (stored !== undefined) await store.applyVerification(sessionId, key, { live: true, fields })
        const diffs = []
        if (stored !== undefined) {
          if ((stored.status ?? 0) !== probe.status) diffs.push(`状态码 ${stored.status ?? 0} → ${probe.status}`)
          if ((stored.title ?? '') !== probe.title && probe.title !== '') diffs.push(`标题「${probe.title}」`)
          if ((stored.protocol ?? '') !== scheme) diffs.push(`协议 ${stored.protocol || '—'} → ${scheme}`)
        }
        if (diffs.length > 0) changed += 1
        lines.push(`${key} → ${probe.status}${probe.title === '' ? '' : `「${probe.title}」`}`
          + `${probe.cert === undefined ? '' : ' · 证书已补'}`
          + `${diffs.length === 0 ? '' : ` · 变更：${diffs.join('；')}`}`)
      }

      // 验活也是观测：写一条记录留痕（合并进同一资产，不会新增行）。
      const records = lines.map((line, index) => ({
        kind: 'web',
        asset: targets[index] === undefined ? '' : `${targets[index].host}:${targets[index].port}`,
        detail: line,
        sources: ['expose_verify'],
      })).filter((row) => row.asset !== '')
      if (records.length > 0) await store.appendRecords(sessionId, records)

      const head = `验证 ${targets.length} 个端点：存活 ${live}，失效 ${dead}，有变更 ${changed}`
      return { text: `${head}\n${lines.join('\n')}`, verified: targets.length, live, dead, changed }
    },
  })

  // ── 8. 查询资产 ────────────────────────────────────────────────────────
  registerToolSafely(ctx, {
    name: 'expose_asset_query',
    description:
      '按语法查询本会话的资产清单（与面板「资产清单」的搜索框同一套语法）。'
      + '\n用途：写之前查重、看某个端口/状态码有哪些、盘点缺口、给汇总取数。'
      + '\n能筛判定等级（verdict=suspect / verdict=infer）、组合字段（fingerprint~nginx、protocol~sql、title~后台）。'
      + '按最近观测倒序返回。',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: `${describeQuery()} 留空表示不筛。` },
        category: { type: 'string', enum: ['web', 'service', 'host', 'unknown'], description: '只看某一类。unknown = 只有端口、没有判别证据的。' },
        nodeType: {
          type: 'string',
          enum: ['app', 'endpoint'],
          description: 'app = 系统（host:port + 根路径），endpoint = 网络端点。面板上有视角切换，这里用同一个筛选。',
        },
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
        nodeType: typeof args?.nodeType === 'string' ? args.nodeType : '',
        limit,
        offset: 0,
      })
      if (page.error !== undefined) throw new Error(`查询语法有问题：${page.error}`)
      if (page.total === 0) return { text: '当前会话没有匹配的资产。', total: 0, returned: 0 }
      const lines = page.rows.map((row) => {
        const isApp = row.nodeType === 'app'
        const where = isApp
          ? (row.key ?? `${row.host}:${row.port}`)
          : (row.port === 0 ? row.host : `${row.host}:${row.port}`)
        // 判定要跟着一起出来：模型查重时若看不到「可疑」，会把上次标的噪声当成已验证资产。
        const mark = row.verdict === 'suspect' ? ' [可疑]' : row.verdict === 'infer' ? ' [推测]' : ''
        const bits = []
        if (row.protocol !== '') bits.push(row.protocol)
        if (row.status !== 0) bits.push(String(row.status))
        if (row.server !== '') bits.push(row.server)
        if (row.title !== '') bits.push(row.title)
        else if (row.service !== '') bits.push(row.version === '' ? row.service : `${row.service} ${row.version}`)
        // 系统的证据数量与合并状态要能看得到，否则模型会重复登记同一个系统。
        if (isApp) {
          const urlCount = Array.isArray(row.urls) ? row.urls.length : 0
          if (urlCount > 0) bits.push(`URL ${urlCount}`)
          if (row.mergeState === 'merged') bits.push(`已合并 ${Array.isArray(row.mergedFrom) ? row.mergedFrom.length : 0}`)
          if (row.mergeState === 'unresolved') bits.push('待确认')
        }
        const sources = Array.isArray(row.sources) && row.sources.length > 0 ? `  [${row.sources.join(' · ')}]` : ''
        return `${isApp ? '系统 ' : ''}${where}${mark}  ${row.category}${bits.length > 0 ? `  ${bits.join(' | ')}` : ''}${sources}`
      })
      const head = `命中 ${page.total} 条，返回 ${page.rows.length} 条（端点/系统 · 分类 · 摘要 · 来源；可疑与推测会带标记）：`
      return { text: clamp(`${head}\n${lines.join('\n')}`), total: page.total, returned: page.rows.length }
    },
  })

  // ── 5. 问题池：判定不了的系统对，收尾时统一问用户 ──────────────────────
  registerToolSafely(ctx, {
    name: 'expose_question_list',
    description:
      '列出本会话「问题池」里待确认的问题（目前只有一类：两个入口可能是同一个系统，但证据只够命中一项）。'
      + '\n**任务收尾前必须调一次**：有未决项就用 ask_user_question 一次性问清，再用 expose_question_resolve 写回。'
      + '\n问题为空说明没有需要用户裁决的东西，直接结束即可。',
    parameters: {
      type: 'object',
      properties: {
        includeResolved: { type: 'boolean', description: '连已裁决的一起返回（复盘用）。缺省只看待确认。' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法读取问题池')
      const includeResolved = args?.includeResolved === true
      const rows = includeResolved
        ? [...store.questionsOf(sessionId, 'resolved'), ...store.questionsOf(sessionId, 'open')]
        : store.questionsOf(sessionId, 'open')
      if (rows.length === 0) return { text: '问题池是空的：没有需要用户裁决的系统判定。', total: 0 }
      const lines = rows.map((row, index) => {
        const payload = row.payload ?? {}
        const signals = payload.signals ?? {}
        const hits = [
          signals.frontend ? '前端应用' : '',
          signals.auth ? '认证域' : '',
          signals.backend ? '后端应用' : '',
        ].filter((item) => item !== '').join('+') || '无'
        return `${index + 1}. [${row.status}] ${payload.a}\n   ↔ ${payload.b}\n   命中：${hits}；理由：${payload.reason}`
      })
      const head = `问题池 ${rows.length} 条（每条的选项都是 merge / keep / dismiss）：`
      return { text: clamp(`${head}\n${lines.join('\n')}`), total: rows.length }
    },
  })

  registerToolSafely(ctx, {
    name: 'expose_question_resolve',
    description:
      '裁决问题池里的一条问题。'
      + '\nmerge = 合并成一个系统（主节点保留，子节点指向它，URL 证据并过去）；'
      + 'keep = 保持两个系统（两边都标记为已确认独立）；dismiss = 先不管（仍显示为待确认，但不再反复问）。'
      + '\n裁决是**可逆**的：合并之后用户还能在面板上拆开。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '问题 id（expose_question_list 返回的那个，形如 a|b）。' },
        choice: { type: 'string', enum: ['merge', 'keep', 'dismiss'], description: '裁决结果。' },
      },
      required: ['id', 'choice'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error('没有归属会话，无法裁决问题')
      const id = typeof args?.id === 'string' ? args.id : ''
      const choice = typeof args?.choice === 'string' ? args.choice : ''
      if (id === '') throw new Error('id 必填')
      const resolved = await store.resolveQuestion(sessionId, id, choice, 'agent')
      if (resolved === undefined) throw new Error(`没有这条问题，或 choice 不是 merge/keep/dismiss：${id}`)
      const label = choice === 'merge' ? '已合并' : choice === 'keep' ? '保持独立' : '已忽略'
      return { text: `${label}：${id}` }
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
      + '\n挑哪个工具：用 needs 反查谁的输入吃得住你手上的东西，再按它声明的条件关系把输入凑齐。'
      + '\n输出超过 maxLines 会截断，完整版存成 runId；用 expose_run_query 按 runId 检索。'
      + '\n目标不需要预先登记：把 `target` 写上是方便回溯，不写也能跑。',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '面板配置里的工具名或 id（见 expose_config）。' },
        target: { type: 'string', description: '可选：这次跑的是哪个目标，只写进 run 头便于回溯，不影响能不能跑。' },
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
        throw new Error(`「${toolName}」不在面板配置里。已配置的工具：${names === '' ? '(无 —— 请让用户在面板「配置」里加一行)' : names}`)
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
      const targetLabel = target === '' ? '(未填)' : target
      const header = `# ${toolName} target=${targetLabel} exit=${String(outcome.code)} ${duration}ms`
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
          `${toolName} → target=${targetLabel}  exit=${String(outcome.code)}  ${duration}ms  共 ${totalLines} 行`,
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
      '在一次 expose_tool_run 保存的完整输出里检索，代替 grep。'
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
  let parsed
  try {
    parsed = validateSkill(raw)
  } catch (error) {
    ctx.logger?.warn?.(`[infohunter] 内置 SKILL.md 不合法：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  try {
    ctx.effect(
      () =>
        skills.register({
          name: parsed.name,
          description: parsed.description,
          content: parsed.body.replace(/^\s+/, ''),
          source: 'custom',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'infohunter.registerSkill',
    )
  } catch (error) {
    ctx.logger?.warn?.(`[infohunter] 技能 "${parsed.name}" 注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 用户上传的技能（面板「配置」里的 skill 行）──────────────────────────────

/** 内置技能的名字：用户上传的同名技能不能把它顶掉。 */
const BUNDLED_SKILL_NAME = 'info-hunter-method'

/** 已注册的用户技能 disposer（刷新时先全部撤掉再重注册）。 */
const uploadedSkillDisposers = []

/** 重注册串行化：连续两次保存配置不会交错。 */
let skillRefreshChain = Promise.resolve()

/**
 * 由行 id 派生一个稳定短后缀。
 *
 * 用确定性哈希而不是随机数：同一个行刷新前后注册名必须一样，否则模型的技能目录
 * 每次保存配置都会多出一个"新技能"。
 *
 * @param id - 配置行 id。
 * @returns 6 位 base36 后缀。
 */
function skillSuffix(id) {
  let hash = 2166136261
  for (const ch of String(id)) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36).padStart(6, '0').slice(-6)
}

/**
 * 把磁盘上的用户技能注册进**本预设的层**。
 *
 * 作用域由注册上下文决定：这里是预设挂载的 ctx，所以注册进预设层 —— 只有用这个预设的
 * 会话能看到，与其他预设、与全局技能互不影响。
 *
 * @param ctx - preset 层上下文。
 * @param store - 配置来源。
 * @returns {Promise<void>}
 */
async function registerUploadedSkills(ctx, store) {
  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.register !== 'function') return
  const root = defaultSkillsRoot()
  const used = new Set([BUNDLED_SKILL_NAME])
  const rows = store.config().entries.filter((entry) => entry.type === 'skill' && entry.enabled)
  for (const row of rows) {
    const entry = await readSkillFromDir(join(root, row.id))
    if (entry === undefined) {
      // 目录缺失 / SKILL.md 不合法：跳过，但要在日志里留痕（面板会显示"未就绪"）。
      ctx.logger?.warn?.(`[infohunter] 技能行 ${row.id} 读不到可用的 SKILL.md，已跳过`)
      continue
    }
    let name = entry.name
    if (used.has(name)) name = `${name}-${skillSuffix(row.id)}`
    used.add(name)
    try {
      uploadedSkillDisposers.push(skills.register({
        name,
        description: entry.description,
        content: entry.content,
        source: 'custom',
        invocation: { modelInvocable: true, userInvocable: true },
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[infohunter] 技能 "${name}" 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 撤掉并重新注册全部用户技能。
 *
 * @param ctx - preset 层上下文。
 * @param store - 配置来源。
 * @returns {Promise<void>}
 */
function refreshUploadedSkills(ctx, store) {
  skillRefreshChain = skillRefreshChain.then(async () => {
    for (const dispose of uploadedSkillDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 已经失效的 disposer 不算错误 */
      }
    }
    await registerUploadedSkills(ctx, store)
  }).catch((error) => {
    ctx.logger?.warn?.(`[infohunter] 刷新技能失败：${error instanceof Error ? error.message : String(error)}`)
  })
  return skillRefreshChain
}

// ── MCP server（面板「配置」里的 mcp 行）──────────────────────────────────

/** 已连上的 server（刷新时全部断开重连）。 */
const mcpConnections = []

/** 行 id → 连接状态，`expose_config` 渲染时读它（连接是异步的，渲染是同步的）。 */
const mcpStatus = new Map()

/** 重连串行化。 */
let mcpRefreshChain = Promise.resolve()

/**
 * 按配置连接全部 MCP server，并把它们的工具注册进本预设的层。
 *
 * 工具名按 DSH 的约定拼成 `mcp__<server>__<tool>`：一眼能看出它来自哪个 server，
 * 也不会和本插件自己的 `expose_*` 撞名。单个 server 连不上只影响它自己 —— 其他工具照常。
 *
 * @param ctx - preset 层上下文（`ctx.tools` 必须可用）。
 * @param store - 配置来源。
 * @returns {Promise<void>}
 */
async function registerMcpServers(ctx, store) {
  for (const item of mcpConnections.splice(0)) {
    try {
      await item.dispose()
    } catch {
      /* 已经断了 */
    }
  }
  mcpStatus.clear()
  const rows = store.config().entries.filter((entry) => entry.type === 'mcp' && entry.enabled)
  if (rows.length === 0) return
  const used = new Set()
  for (const row of rows) {
    const normalized = normalizeServerName(String(row.name ?? '').trim() || row.id)
    // 名字里没有可用 ASCII 时 normalize 会退化成 "server"，两个中文名的行就会撞车。
    // 这种情况下用行 id 派生的后缀区分，保证工具名前缀唯一。
    const server = normalized === 'server' ? `server-${skillSuffix(row.id)}` : normalized
    try {
      const connection = await connectMcp(row)
      const disposers = []
      const registered = []
      for (const tool of connection.tools) {
        const suffix = tool.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40)
        const fullName = `mcp__${server}__${suffix}`.slice(0, 64)
        if (used.has(fullName)) continue
        used.add(fullName)
        registered.push(tool.name)
        disposers.push(ctx.tools.register({
          name: fullName,
          description: `[MCP ${server}] ${tool.description === '' ? tool.name : tool.description}`.slice(0, 4000),
          // 远端给的 inputSchema 原样透传：它就是这个工具的契约，改一个字都可能编出假参数。
          parameters: tool.inputSchema,
          output: OUTPUT,
          timeoutMs: MCP_TIMEOUTS.call + 5_000,
          async execute(args, exec) {
            const result = await connection.call(tool.name, args ?? {}, exec?.signal)
            const { text, isError } = renderToolResult(result)
            return { text: clamp(text), isError }
          },
        }))
      }
      mcpConnections.push({
        rowId: row.id,
        dispose: async () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 已失效 */
            }
          }
          await connection.close()
        },
      })
      mcpStatus.set(row.id, { state: 'ok', tools: registered })
      ctx.logger?.info?.(`[infohunter] MCP「${server}」已连接，注册 ${registered.length} 个工具`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mcpStatus.set(row.id, { state: 'error', tools: [], error: message })
      ctx.logger?.warn?.(`[infohunter] MCP「${server}」连接失败：${message}`)
    }
  }
}

/**
 * 断开并重连全部 MCP server（配置变更时调用）。
 *
 * @param ctx - preset 层上下文。
 * @param store - 配置来源。
 * @returns {Promise<void>}
 */
function refreshMcpServers(ctx, store) {
  mcpRefreshChain = mcpRefreshChain.then(() => registerMcpServers(ctx, store)).catch((error) => {
    ctx.logger?.warn?.(`[infohunter] 刷新 MCP 失败：${error instanceof Error ? error.message : String(error)}`)
  })
  return mcpRefreshChain
}

/** 常驻章程段正文。 */
const INSTRUCTIONS = `\
【互联网暴露面收集 · 常驻章程】

你负责渗透测试的第一阶段：把互联网上的暴露面尽可能完整、可复核地收集下来。
你不做漏洞验证、不做利用 —— 那是后续阶段的事。你的产出是「资产清单 + 证据」。

## 一、先读配置，再建立计划
开始任何收集动作之前，按这个顺序做两件事：

1. **expose_config** —— 它告诉你用户配了哪些本地工具、哪些空间测绘平台，以及每个的用法说明
   （那是用户写的，比你的默认假设更准）。本机能执行什么、能怎么上网，以身份说明为准；
   面板里没有的本地程序，不要到别处去找。
2. **expose_plan** —— 用 scope 登记用户明确给出的目标与约束，再用 stages 把骨架阶段逐个
   标成 active/done。计划是跨轮记忆：会话没有记忆，不落库的计划压缩一次就没了。
   约束必须自包含（写"只测 a.com"，不写"只测当前目标"）。

之后每一轮开工**先调 expose_state**，不要自己拼状态：计划进度、覆盖度、字段缺口、
未决问题都在里面。看到"未覆盖 N（共 M）"时，N 是截断展示，M 才是总数。

## 二、没有固定顺序
这些层次互相喂线索，不是流水线 —— 顺序由你按当前证据决定。下面只是骨架，不是流程：

  主域名 → 子域名 → DNS/解析 IP → 端口 → 服务 → Web → 指纹 → 前置层归属

- 起手只有单个主域名时：要不要扩同主体的其他根域（备案、WHOIS、组织归属）由用户定，
  先问他一次；问完别停下，不受影响的部分继续做。
- 子域名：被动优先（证书透明、公开情报、测绘平台），再做字典爆破；爆破前先建泛解析基线。
- DNS：A/AAAA/CNAME/MX/TXT/NS。解析出来的 IP **先判归属再决定要不要扫**：
  CNAME 指向 CDN / 云 WAF 的，拿到的是边缘节点，拿去扫端口只是扫别人的基础设施 —— 排除掉；
  直连 IP、自有 WAF 的独立 IP 才回到端口层。判断依据见第六节。
- 端口：先常见端口，再按资产价值决定是否全端口；控速，不做压测。
- 服务 / Web / 指纹：banner、协议与版本、状态码、标题、响应头组合、静态资源路径、Cookie 名。
- 前置层归属：见第六节。

可用的层不止这八层，随证据取用：C 段探测、C 段 IP 反查域名、域名历史解析、host 碰撞、
空间测绘平台的综合查询……哪一层先出线索就先做。
关键在于：这些层产出的 IP 和域名只是下一轮的入口，不是结论。
历史解析查出的 IP 要回去扫端口，C 段里的 IP 要回去做服务与 Web 识别，host 碰撞要用真实响应验证。
**查到就算收集完，是错的。**

层内手法不在本段里 —— **进入某一层的深水区之前，先加载 info-hunter-method 技能**。
端口表、路径清单、指纹可靠性排序、命名规则归纳、七类假结果怎么认，都在那里。这不是「参考」，
是要用的东西。

## 三、记录纪律
**边收集边记**（expose_record），不要攒到最后 —— 面板两个视图实时读的就是它：
「采集记录」是一行一条的过程流水（不合并，保留你的证据原文），
「资产清单」是同一批记录按端点汇总出来的结果（重复会自动合并）。一次调用就够，不要写两遍。
记录是只追加的流水，没有修改和删除的入口 —— 写错了就再写一条更正，说明更正的是哪一条。

进资产清单的判据是「观测到过」，不是「检出了什么」：
拿到过 HTTP 响应（哪怕是 4xx / 5xx）、TLS 证书、banner、握手回包，都算观测到，都要入清单；
状态码、协议、服务名只是字段值，不是准入门槛。
唯一不算的是纯超时、无回包 —— 那不是资产，只写进证据。

字段 protocol 写 http / https 的前提，是这个端点**真的能打开**并返回响应；
只通了 TCP、TLS 握手失败、连接被重置，就不要标成 http / https，留空或写实测到的别的协议。
只填观察到的字段，没测的留空 —— 空着比猜一个值好。
字段 sources 只填**工具或平台的名字**（一条被多个印证就给多个），方法写 detail。
探到 Web 页时顺手把 headers（响应头原文）和 body（去掉标签的可读正文）也记下来：
面板的「详情」页签要显示它们，没记就是一片「未采集」。
写之前先 expose_asset_query 查重。

**用户工具没给全时，用 expose_enrich 补**：它对主机做 DNS 解析、对已开放端口发一次 GET，
取回状态码 / 响应头原文 / 页面标题 / 正文摘要 / TLS 证书，并**自动落库**（不用再记一遍）。
顺序永远是先用户配置的工具、拿不到再用它补；它不做端口扫描、不做指纹识别。
面板「证书 / 响应头 / 正文」三个页签读的就是这些字段 —— 不补就是一片"未采集"。
常见缺口：测绘平台只回状态码不给证书；子域枚举只给域名不给 IP（补 DNS 即可）。

**空间测绘/搜索引擎的结果必须二次验证**：那些数据经常是几个月前的，端口早关了、站点早换了。
用 expose_verify（缺省验本会话全部 Web 端点）：
- 连不上 → 自动标为失效（lifecycle=dead），**数据保留，不删除**；
- 连得上 → 标 live，并把这次观测到的状态码 / 标题 / 响应头 / 正文 / 证书一起合并进去；
- 回执里的**变更**（状态码 200→404、标题换了、协议变了）要写进最终汇总 —— 那才是用户要看的增量。
验收类工作（用户说"确认一下还活着吗"）也是它，不要凭旧数据回答。

**别把工具输出整段塞进 detail 就完事。** 我们的价值不在于"调用了工具"，而在于把工具输出
整理成结构化资产：工具回了 IP、端口、状态码、服务名、版本、标题，就逐个写进对应字段。
只写 asset 和 detail 的记录，在面板上就是一条全是「—」的空壳。
expose_record 的回执会点名"缺必填字段"和"建议补"的条目 —— 当场补一条只带缺失字段的记录，
不要留到收尾。

收尾前用 ip=""、protocol=""、status=0 各查一次，把还能从证据里补的字段补齐；
补不了的（工具确实没回）就保持空 —— 空着是事实，"编一个"不是。

## 四、系统与内容页
资产的最小单位不是 host:port，是**系统**：一个端点下可能挂着多个应用
（nginx 反代 / 微服务，https://h:8080/tenant/ 与 https://h:8080/admin/ 是两个系统）。
记 URL 时带上 url 字段，并用 basePath 声明它属于哪个系统；**拿不准 basePath 就不要填**，
只记 url 和 pageType，系统归属留给判定流程。

- 一个系统一条 kind=app 记录（url + basePath + title + 指纹）。
- 内容页、资讯、文章、商品详情：kind=url，pageType=content。**不要**给它们各自建系统。
- 静态资源、/api/ 接口同理：只当证据，pageType 写 asset / api。
- 判「是否同一系统」靠三件事：同一前端应用（入口脚本/页面骨架）、同一认证域（登录页/cookie）、
  同一后端应用（框架，不含 nginx 这类通用服务器）。命中两项才合并，命中一项系统会把它放进
  **问题池**，**不要自己拍板合并**。
- 能拿到就填 signals（templateHash / entryScript / faviconHash / assetPrefix / loginUrl / cookieNames）；
  拿不到就空着 —— 空着只是判不了，编一个会让两个系统被错误合并。

## 五、信息产物
除了端点与系统，还有一种东西要单独记：**以文字为主的发现**。用 expose_artifact，不要塞进资产。

- **云资源**：公开的对象存储、暴露的 AK、云函数 URL。
- **泄露物**：可下载的备份包、仓库元数据（.git/config）、.env、源码压缩包、配置文件。
- **接口文档**：swagger / openapi / graphql 端点。
- **凭据**：账号口令、token、私钥、数据库连接串。
- **安装包**：文件名、版本、下载地址。

每条必须给：kind、title（一句话）、content（原文片段，不是整页 HTML）、howFound（查询语句/路径/方法）。
source 写工具或平台名；能关联到资产就带 url / host。
content 里的敏感串会按面板配置的正则自动打标，不用自己评级别；但**不要把凭据在对话里复述一遍**，
写进产物就够了。

## 六、事实、可疑、推测
三类都要写，但必须分清 —— 资产清单会在端点上把它们标出来：
- **事实**：直接观测到的原值。状态码、证书主体、banner 原文、响应头。
- **可疑**：观测到了，但不确定算不算真资产。拦截页、默认页、停放页、泛解析产生的假子域、
  未经真实响应验证的 host 碰撞、同一 IP 上几十个域名共用一个响应。
- **推测**：没有直接观测，靠推理链得出。证书 SAN 里的同组织域名、CNAME 指向某 CDN 所以「应该是托管」。
推测必须把推理链写进 note 或 detail，不能当成事实写进字段。confidence 是数值把握度，按实际填。

## 七、边界与节奏
- 本阶段**只做收集**：不做漏洞验证、不做注入、不上传、不爆破口令。
- 撞到无认证的 Redis / ES / Mongo / Memcached / Docker API：**只做只读确认**
  （一个 PING、一个 _cat/indices、一个 INFO），绝不写、绝不删、绝不遍历数据 ——
  拿到「无需认证即可访问」这一条事实就停。
- 主动请求控速：横向并发不超过 10，端口不做全端口压测。
- **空间测绘平台每次请求之间随机延迟 3 到 10 秒**，不要连发；被限流就退更久再试。
  （这一条由工具强制，你只管一次一个地调，不要并发，也不用自己再等。）
- 需要登录态、更高强度扫描、或要不要扩大范围时，用 ask_user_question 一次性问清，
  同时**继续做不受影响的部分**，不要停下来干等。

## 八、前置层：CDN 和 WAF 不是一回事
先判「我探到的这个 IP 是谁的」，再决定能不能往下走。
- **CDN 和云 WAF 是同一类**：你拿到的是边缘节点，不是源站。这两者的归属判定必须落成一条指纹
  写进 tech（如 cloudflare、aliyun-cdn、tencent-cloud-waf、cloud-waf），不要只写在 note 里。
  这类资产照实记，但不要声称探到了源站。
- **自有 WAF 是另一类**：和企业自己部署的 nginx 没有区别，就是业务前面的一层反向代理或网关，
  有独立 IP；主备切换的场景下会有多个 IP。它是能探的，正常走端口、服务、Web。
判断依据：CNAME 后缀、CDN 特征头（X-Cache、CF-Ray、X-Amz-Cf-Id）、证书签发者、多域名共用同一 IP 段。

## 九、收尾
先调 **expose_check**：字段缺口（缺端口/缺 IP）与未覆盖资产要么清零，要么逐条说明为什么补不了。
然后给一份简短汇总：覆盖了哪几层、每层多少条、哪些层缺（以及为什么缺）、下一步建议。
不要复述全部条目 —— 它们在面板里。

收尾**必须**先调 expose_question_list：
- 有问题 → 用 ask_user_question 一次性问清（每个问题就是"这两个入口是不是同一个系统"），
  再用 expose_question_resolve 写回；用户说先不管就 dismiss。
- 没有问题 → 直接汇总，不要编造待确认项。`

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

  // 用户上传的技能：注册进**本预设的层**，并跟着配置变更重注册（上传/删除/停用即时生效）。
  ctx.inject(['skills', 'infohunterStore'], (scope) => {
    const store = scope.infohunterStore
    if (store === undefined) return
    void refreshUploadedSkills(scope, store)
    if (typeof store.onConfigChange === 'function') {
      const off = store.onConfigChange(() => { void refreshUploadedSkills(scope, store) })
      scope.effect(() => off, 'infohunter.skillWatch')
    }
    scope.effect(() => () => {
      for (const dispose of uploadedSkillDisposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 已失效 */
        }
      }
    }, 'infohunter.skillDispose')
  })

  // MCP：连上配置里的 server，把它们的工具注册进本预设的层；配置变了就重连。
  ctx.inject(['tools', 'infohunterStore'], (scope) => {
    const store = scope.infohunterStore
    if (store === undefined) return
    void refreshMcpServers(scope, store)
    if (typeof store.onConfigChange === 'function') {
      const off = store.onConfigChange(() => { void refreshMcpServers(scope, store) })
      scope.effect(() => off, 'infohunter.mcpWatch')
    }
    scope.effect(() => () => {
      for (const item of mcpConnections.splice(0)) {
        void item.dispose().catch(() => undefined)
      }
    }, 'infohunter.mcpDispose')
  })

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
