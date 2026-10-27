#!/usr/bin/env node
/**
 * check —— 安装前的体检。这个脚本存在的唯一理由：**这类错误全都是静默的**。
 *
 *   预设里写错一个包名，或漏掉一个必需的 config 键 →
 *   mountPreset 挂不上 → 预设被标 `broken` → 而新会话的预设选择器**会过滤掉 broken 的预设**。
 *   用户看到的是「这个预设不存在」，宿主日志、浏览器控制台、构建输出都没有红字。
 *
 * 检查项：
 *   1. `cordis.patch.yml` 是合法 YAML（含 `!!js`），结构符合 Loader 方言；
 *   2. 每个被引用的模块在这套 DSH 构建里真的存在；
 *   3. 已核实为**必需**的 config 键一个不少；
 *   4. `compaction-tool-result-pruner` 的键在白名单内，且 `head + tail < threshold`；
 *   5. 本地模块的 `exports` 与 `files` 全部可解析；客户端半存在；
 *   6. 显示资源（locale / icon）齐备；
 *   7. 每个 `.js` 语法通过。
 *
 * `yaml` 是**开发期**依赖，装在本脚本之外（见 `lib/resolve-yaml.mjs`）：
 * 插件包必须零依赖，否则 install_bundle 导入它时会去重建依赖 ——
 * 源目录 isolated、profile hoisted、两边跨盘，创建目录符号链接在 Windows 上直接 EPERM。
 * 找不到 `yaml` 时会**降级**（跳过 1 和 3，模块名单改用正则提取）并明确警告，不是失败。
 *
 * 用法：`node scripts/check-modules.mjs`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INSTALL_HINT, loadYaml } from './lib/resolve-yaml.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const localPackage = manifest.name

const failures = []
const fail = (message) => failures.push(message)
const info = (message) => console.log(`  ${message}`)

const yaml = await loadYaml()

// ── 1. 解析补丁 ────────────────────────────────────────────────────────────
console.log('\n[1] 补丁结构与 YAML 语法')
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const JS_TAG = [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ $js: String(value ?? '') }) }]

/** 展平后的所有插件行（group 的子行也收进来）。 */
const rows = []
/** 顶层 insert 的行。 */
const inserted = []
let structureChecked = false

if (yaml.parse === undefined) {
  console.warn('  ⚠ 没找到 yaml，严格的 YAML 语法与结构校验**已跳过**（模块名单改用正则提取）。')
  console.warn(`    要恢复严格校验：${INSTALL_HINT}`)
  for (const line of yaml.missing ?? []) console.warn(`    试过 ${line}`)
  for (const match of patchText.matchAll(/^\s*name:\s*'([^']+)'/gm)) rows.push({ name: match[1], where: '(正则提取)' })
} else {
  let document
  try {
    document = yaml.parse(patchText, { customTags: JS_TAG })
  } catch (error) {
    console.error(`[check] ❌ cordis.patch.yml 不是合法 YAML：${error.message}`)
    process.exit(1)
  }
  structureChecked = true
  info(`cordis.patch.yml 解析通过（yaml 来自 ${yaml.from}）`)

  if (!Array.isArray(document) || document.length === 0) fail('补丁顶层应是「补丁对象」组成的数组')
  for (const [index, layer] of (document ?? []).entries()) {
    if (layer === null || typeof layer !== 'object') fail(`第 ${index + 1} 层不是映射`)
    else if (!Array.isArray(layer.insert)) fail(`第 ${index + 1} 层没有 insert 列表`)
  }

  const walk = (list, depth, where) => {
    if (!Array.isArray(list)) {
      fail(`${where}: plugins/config 不是数组`)
      return
    }
    for (const row of list) {
      if (row === null || typeof row !== 'object') {
        fail(`${where}: 有一行不是映射`)
        continue
      }
      if (typeof row.id !== 'string' || row.id === '') fail(`${where}: 有一行缺 id`)
      if (row.name === 'cordis:group') {
        if (row.group !== true) fail(`${where}: ${String(row.id)} 名字是 cordis:group 但没有 group: true`)
        walk(row.config, depth + 1, `${where}/${String(row.id)}`)
        continue
      }
      if (typeof row.name !== 'string' || row.name === '') fail(`${where}: ${String(row.id)} 缺 name`)
      if (row.isolate !== undefined) fail(`${where}/${String(row.id)}: 普通插件行不应带 isolate（只有 cordis:group 需要）`)
      rows.push({ ...row, depth, where: `${where}/${String(row.id)}` })
    }
  }

  for (const layer of document ?? []) for (const row of layer?.insert ?? []) inserted.push(row)
  info(`insert 行 ${inserted.length} 条`)

  const presetRow = inserted.find((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
  if (presetRow === undefined) fail('补丁里没有 @deepseek-ai/dsh-agent-preset 声明')
  else {
    const config = presetRow.config ?? {}
    if (typeof config.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(config.id)) {
      fail(`预设 id 不合规（只允许小写字母/数字/连字符）：${String(config.id)}`)
    }
    if (presetRow.id !== `preset-${String(config.id)}`) fail(`Loader 行 id 约定是 preset-<id>，实际是 ${String(presetRow.id)}`)
    walk(config.plugins, 0, 'preset')
    info(`预设 "${String(config.id)}" 共 ${rows.length} 个模块行（order ${String(config.order)}）`)
  }
}

// ── 2. 模块存在性 ──────────────────────────────────────────────────────────
console.log('\n[2] 模块存在性')
const isLocalName = (name) => name === localPackage || name.startsWith(`${localPackage}/`)
const allNames = [...new Set(rows.map((row) => row.name).filter((name) => typeof name === 'string' && name !== 'cordis:group'))]
for (const row of inserted) {
  if (typeof row?.name === 'string' && row.name !== 'cordis:group') allNames.push(row.name)
}
const uniqueNames = [...new Set(allNames)]
const externalNames = uniqueNames.filter((name) => !isLocalName(name))
const localNames = uniqueNames.filter(isLocalName)

/**
 * asar：`dsh/` 是应用本身，依赖在 `dsh/node_modules/`；
 * 偏移 12 是目录 JSON 的长度，JSON 从偏移 16 开始。
 */
function readAsarHeader(path) {
  try {
    const buffer = readFileSync(path)
    const length = buffer.readUInt32LE(12)
    if (length <= 0 || length > buffer.length) return undefined
    return JSON.parse(buffer.toString('utf8', 16, 16 + length))
  } catch {
    return undefined
  }
}

function asarHas(header, moduleName) {
  const lookup = (segments) => {
    let node = header
    for (const segment of segments) {
      node = node?.files?.[segment]
      if (node === undefined) return false
    }
    return typeof node === 'object' && node !== null
  }
  const tail = `node_modules/${moduleName}`.split('/')
  return lookup(['dsh', ...tail]) || lookup(tail)
}

const asarPath = [process.env.DSH_ASAR, 'D:/SoftWare/DeepSeek Harness/resources/app.asar'].find((candidate) => {
  if (typeof candidate !== 'string' || !existsSync(candidate)) return false
  const header = readAsarHeader(candidate)
  return header !== undefined && asarHas(header, '@deepseek-ai/dsh-web-app')
})

if (asarPath === undefined) {
  fail('找不到 DSH 的 app.asar，无法校验外部模块（可用 DSH_ASAR 指定）')
} else {
  const header = readAsarHeader(asarPath)
  const missing = externalNames.filter((name) => {
    const match = /^((?:@[^/]+\/)?[^/]+)/.exec(name)
    return match === null || !asarHas(header, match[1])
  })
  if (missing.length > 0) fail(`${missing.length} 个模块在这套构建里不存在：${missing.join('、')}`)
  else info(`外部模块全部存在（${externalNames.length} 个，对 app.asar 校验）`)
}

for (const moduleName of localNames) {
  const subpath = moduleName === localPackage ? '.' : `./${moduleName.slice(localPackage.length + 1)}`
  const target = (manifest.exports ?? {})[subpath]
  if (typeof target !== 'string') fail(`本地模块 ${moduleName}：exports 里没有 "${subpath}"`)
  else if (!existsSync(join(root, target))) fail(`本地模块 ${moduleName}：${target} 不存在`)
}

// ── 3. 必需 config 键 ──────────────────────────────────────────────────────
console.log('\n[3] 必需 config 键')
if (!structureChecked) {
  console.warn('  ⚠ 已跳过（需要 yaml 才能读出行级 config）。')
} else {
  // 已按这套构建的 lib/index.js 逐个核实：缺这些键会直接激活失败。
  const REQUIRED_CONFIG = {
    '@deepseek-ai/dsh-persona': ['prefix'],
    '@deepseek-ai/dsh-agent-instructions': ['maxBytes'],
    '@deepseek-ai/dsh-tool-fs-search': ['sampleOverCapGlobResults'],
    '@deepseek-ai/dsh-tool-todo': ['allowParallelInProgress'],
  }
  let problems = 0
  for (const row of rows) {
    const required = REQUIRED_CONFIG[row.name]
    if (required === undefined) continue
    const config = row.config ?? {}
    for (const key of required) {
      if (config[key] === undefined) {
        problems += 1
        fail(`${row.where}（${row.name}）缺必需 config 键 "${key}" —— 会让整条预设变 broken`)
      }
    }
  }
  const pruner = rows.find((row) => row.name === '@deepseek-ai/dsh-compaction-tool-result-pruner')
  if (pruner !== undefined) {
    const allowed = ['thresholdChars', 'headChars', 'tailChars']
    const config = pruner.config ?? {}
    for (const key of Object.keys(config)) {
      if (!allowed.includes(key)) {
        problems += 1
        fail(`${pruner.where}：未知 config 键 "${key}"（该包对未知键硬报错，白名单 ${allowed.join(', ')}）`)
      }
    }
    const threshold = config.thresholdChars ?? 8192
    const head = config.headChars ?? 4096
    const tail = config.tailChars ?? 1024
    if (head + tail >= threshold) {
      problems += 1
      fail(`${pruner.where}：headChars(${head}) + tailChars(${tail}) 必须小于 thresholdChars(${threshold})`)
    }
  }
  if (problems === 0) info('必需键齐全，pruner 配置在允许范围内')
}

// ── 4. 清单 / 显示资源 ─────────────────────────────────────────────────────
console.log('\n[4] 清单与显示资源')
for (const entry of manifest.files ?? []) {
  if (entry.includes('*')) continue
  if (!existsSync(join(root, entry))) fail(`files 里声明了不存在的 ${entry}`)
}

if (manifest.dsh?.client !== undefined) {
  const target = (manifest.exports ?? {})['./client']
  if (typeof target !== 'string' || !existsSync(join(root, target))) {
    fail('dsh.client 已声明，但 exports["./client"] 缺失或文件不存在 —— 面板会静默不出现')
  } else {
    info(`客户端半 ${target} 存在`)
  }
  if (manifest.dsh.client.platform !== 'web') fail('dsh.client.platform 应为 "web"')
}

if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch 应指向 ./cordis.patch.yml')
if ((manifest.exports ?? {})['./icon'] === undefined) fail('没导出 ./icon —— Plugin Manager 会用默认图')
if ((manifest.exports ?? {})['./locale/*.json'] === undefined) fail('没导出 ./locale/*.json —— 插件列表显示不出标题/描述')

for (const locale of ['zh', 'en']) {
  const path = join(root, 'locale', `${locale}.json`)
  if (!existsSync(path)) {
    fail(`缺少 locale/${locale}.json`)
    continue
  }
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof json?.meta?.title !== 'string' || json.meta.title.trim() === '') fail(`locale/${locale}.json 缺 meta.title`)
    if (typeof json?.meta?.description !== 'string' || json.meta.description.trim() === '') fail(`locale/${locale}.json 缺 meta.description`)
  } catch (error) {
    fail(`locale/${locale}.json 不是合法 JSON：${error.message}`)
  }
}

const iconPath = join(root, 'icon.svg')
if (!existsSync(iconPath)) fail('缺少 icon.svg')
else {
  const size = statSync(iconPath).size
  if (size > 256 * 1024) fail(`icon.svg 超过 256 KiB（${size} 字节）`)
  if (!/^\s*<svg[\s>]/.test(readFileSync(iconPath, 'utf8'))) fail('icon.svg 根元素不是 <svg>')
}

// 客户端 bundle 里的版本常量必须与清单一致。
//
// 它存在的意义是识别"页面是旧的"：改完 client.js 不刷新时，宿主报新版本、界面还是旧代码，
// 面板会把两者不一致标成「需刷新」。常量一旦漂移，这个提示就会误报（或永不触发），
// 所以在这里硬断言 —— 它唯一的作用就是让这个便利设施不会变成新的困惑来源。
const clientVersion = /const CLIENT_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'client.js'), 'utf8'))?.[1]
if (clientVersion === undefined) fail('client.js 里找不到 CLIENT_VERSION 常量')
else if (clientVersion !== manifest.version) {
  fail(`client.js 的 CLIENT_VERSION（${clientVersion}）与 package.json 的 version（${manifest.version}）不一致`)
} else info(`客户端版本常量与清单一致（${clientVersion}）`)

// ── 5. JavaScript 语法 ─────────────────────────────────────────────────────
// 这不只是形式主义：块注释里写 glob 字面量（斜杠+星号+斜杠）会**提前终止注释**，
// 剩下的文字被当成代码 —— 它长得和注释几乎一样，肉眼极易漏掉。
console.log('\n[5] JavaScript 语法')
const bundleScripts = (manifest.files ?? []).filter((entry) => entry.endsWith('.js') && !entry.includes('*'))
const devScripts = []
const collectScripts = (dir) => {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) collectScripts(rel)
    else if (entry.name.endsWith('.mjs')) devScripts.push(rel)
  }
}
collectScripts('scripts')
const syntaxTargets = [...new Set([...bundleScripts, ...devScripts])]
let syntaxProblems = 0
for (const file of syntaxTargets) {
  const checked = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
  if (checked.status !== 0) {
    syntaxProblems += 1
    const detail = (checked.stderr ?? '').split('\n').find((line) => line.includes('Error')) ?? '语法错误'
    fail(`${file} 语法不通过：${detail.trim()}`)
  }
}
if (syntaxProblems === 0) info(`${syntaxTargets.length} 个 JavaScript 文件语法通过`)

// ── 结论 ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n[check] ❌ ${failures.length} 项失败：`)
  for (const message of failures) console.error(`   · ${message}`)
  console.error('\n这些错误的代价是「预设静默消失，且没有任何红字」。修好再装。')
  process.exitCode = 1
} else {
  console.log(structureChecked ? '\n[check] 全部通过' : '\n[check] 通过（严格 YAML 校验已跳过）')
}
