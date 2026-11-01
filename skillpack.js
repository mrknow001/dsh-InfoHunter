/**
 * 技能包（zip）的解析、校验与落地。
 *
 * ## 为什么自己解析 zip
 *
 * 本包**零依赖**是硬约束（见 README：装了包就得跟着 DSH peer 版本走）。而 Node 内置的
 * zlib 已经提供了 `inflateRawSync`，所以只差一个中央目录解析器 —— 一百来行，可控。
 *
 * ## 安全边界（每一条都是必须的）
 *
 * 1. **只认 store / deflate 两种压缩方法**，加密位为 1 直接拒绝；
 * 2. **路径穿越**：绝对路径、盘符、`..` 段、空段一律拒绝 —— 这是 zip slip 的唯一入口；
 * 3. **体积上限**：单文件 4 MB、整包解压后 20 MB、条目 200 个；`inflateRawSync` 用
 *    `maxOutputLength` 兜住"压缩比炸弹"（1 KB 压成 1 GB 那种）；
 * 4. **必须有 SKILL.md**，且 frontmatter 里的 `name` 合法 —— 否则这个包对一个技能注册表毫无意义。
 *
 * 解压目标固定为 `<skillsDir>/<rowId>/`，`rowId` 由面板生成并校验成安全字符集，
 * 所以**解压路径完全由我们决定**，zip 里的路径只用于建子目录。
 *
 * @module @infohunter/dsh-information-hunter/skillpack
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * 用户上传技能的落地根目录。
 *
 * `$DSH_HOME/infohunter/skills/`，与数据、run 输出同一层级。**不写进包目录**：
 * 本包常以 `link:` 装到源码树，往包里写文件等于改用户的工作区。
 *
 * @returns {string} 绝对路径。
 */
export function defaultSkillsRoot() {
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
  return join(home, 'infohunter', 'skills')
}

/** 技能包的体积与条目上限。 */
export const SKILL_LIMITS = {
  /** 单个文件解压后上限。 */
  file: 4 * 1024 * 1024,
  /** 整包解压后总量上限。 */
  total: 20 * 1024 * 1024,
  /** 条目数上限。 */
  entries: 200,
  /** 压缩包本体上限（防止面板把几百 MB 塞进来）。 */
  archive: 20 * 1024 * 1024,
}

/** 技能名（注册表要求 kebab-case）的合法形状。 */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,48}$/

/** 行 id 的合法形状（决定解压目录名，必须是我们能控制的字符集）。 */
const ROW_ID = /^[A-Za-z0-9._-]{1,64}$/

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * 找 zip 的中央目录结尾记录（EOCD）。
 *
 * 从尾部往回扫（EOCD 后面最多 64 KB 注释），返回各段偏移。
 *
 * @param buffer - 整个 zip。
 * @returns `{ entryCount, cdOffset, cdSize }`。
 */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65_557)
  for (let at = buffer.length - 22; at >= min; at -= 1) {
    if (buffer.readUInt32LE(at) !== EOCD_SIG) continue
    return {
      entryCount: buffer.readUInt16LE(at + 10),
      cdSize: buffer.readUInt32LE(at + 12),
      cdOffset: buffer.readUInt32LE(at + 16),
    }
  }
  throw new Error('不是有效的 zip（找不到中央目录结尾）')
}

/**
 * 校验并规范化 zip 条目的相对路径。
 *
 * @param raw - zip 里的原始文件名。
 * @returns 规范化后的 posix 相对路径。
 */
function safeEntryPath(raw) {
  const text = String(raw).replace(/\\/g, '/')
  if (text === '') throw new Error('zip 里有空文件名')
  if (text.includes('\0')) throw new Error('zip 里的文件名包含空字节')
  if (text.startsWith('/')) throw new Error(`zip 里有绝对路径：${text}`)
  if (/^[A-Za-z]:/.test(text)) throw new Error(`zip 里有盘符路径：${text}`)
  const segments = text.split('/')
  const clean = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new Error(`zip 里有向上跳的路径：${text}`)
    clean.push(segment)
  }
  if (clean.length === 0) throw new Error(`zip 里有无效路径：${text}`)
  return posix.join(...clean)
}

/**
 * 读一个 zip，返回解压后的文件列表（全在内存里，体积已被上限约束）。
 *
 * @param archive - zip 二进制。
 * @returns `{ files: { path, data }[], bytes }`。
 */
export function readZip(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22) throw new Error('不是有效的 zip（太短）')
  if (archive.length > SKILL_LIMITS.archive) {
    throw new Error(`zip 太大（${archive.length} 字节，上限 ${SKILL_LIMITS.archive}）`)
  }
  const { entryCount, cdOffset, cdSize } = findEocd(archive)
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('不支持 ZIP64 格式的包')
  }
  if (entryCount === 0) throw new Error('zip 是空的')
  if (entryCount > SKILL_LIMITS.entries) throw new Error(`zip 里条目太多（${entryCount} 个，上限 ${SKILL_LIMITS.entries}）`)

  const files = []
  let total = 0
  let at = cdOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (at + 46 > archive.length) throw new Error('zip 的中央目录被截断')
    if (archive.readUInt32LE(at) !== CENTRAL_SIG) throw new Error(`zip 的第 ${index + 1} 条目录记录损坏`)
    const flags = archive.readUInt16LE(at + 8)
    const method = archive.readUInt16LE(at + 10)
    const compressedSize = archive.readUInt32LE(at + 20)
    const uncompressedSize = archive.readUInt32LE(at + 24)
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    const localOffset = archive.readUInt32LE(at + 42)
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength

    if ((flags & 0x1) !== 0) throw new Error(`不支持加密的 zip（${name}）`)
    if (method !== 0 && method !== 8) throw new Error(`不支持压缩方法 ${method}（${name}）`)
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('不支持 ZIP64 条目')
    // 目录条目：只用来建目录，不产出文件。
    if (name.endsWith('/')) continue
    if (uncompressedSize > SKILL_LIMITS.file) {
      throw new Error(`文件「${name}」解压后 ${uncompressedSize} 字节，超过单文件上限 ${SKILL_LIMITS.file}`)
    }
    total += uncompressedSize
    if (total > SKILL_LIMITS.total) throw new Error(`解压后总量超过上限 ${SKILL_LIMITS.total} 字节`)

    if (localOffset + 30 > archive.length) throw new Error(`zip 条目「${name}」的本地头越界`)
    if (archive.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`zip 条目「${name}」的本地头损坏`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > archive.length) throw new Error(`zip 条目「${name}」的数据越界`)
    const raw = archive.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else {
      try {
        // maxOutputLength 兜住压缩比炸弹：超了直接抛，不会先分配一大块内存。
        data = inflateRawSync(raw, { maxOutputLength: SKILL_LIMITS.file })
      } catch (error) {
        throw new Error(`解压「${name}」失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    files.push({ path: safeEntryPath(name), data })
  }
  if (files.length === 0) throw new Error('zip 里没有文件（只有目录）')
  return { files, bytes: total }
}

/**
 * 从 SKILL.md 原文里读 frontmatter。
 *
 * 只认 `key: value` 这种单行写法 —— 技能的 frontmatter 就只有 name / description
 * 两个字段有意义，为它引一个 YAML 解析器不值得。
 *
 * @param raw - SKILL.md 全文。
 * @returns `{ name, description, body }`（缺失时为空串）。
 */
export function parseSkillFrontmatter(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const meta = match?.[1] ?? ''
  const field = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(meta)
    return hit?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  }
  return {
    name: field('name'),
    description: field('description'),
    body: match === null ? text : text.slice(match[0].length),
  }
}

/**
 * 校验一份 SKILL.md 是否够格注册。
 *
 * @param raw - SKILL.md 全文。
 * @returns `{ name, description, body }`。
 */
export function validateSkill(raw) {
  const { name, description, body } = parseSkillFrontmatter(raw)
  if (name === '') throw new Error('SKILL.md 的 frontmatter 里没有 name')
  if (!SKILL_NAME.test(name)) {
    throw new Error(`技能名「${name}」不合法：只能用小写字母、数字、连字符，且以字母或数字开头（最长 49）`)
  }
  if (description.trim() === '') throw new Error('SKILL.md 的 frontmatter 里没有 description')
  if (body.trim() === '') throw new Error('SKILL.md 除了 frontmatter 之外没有正文')
  return { name, description: description.trim(), body }
}

/**
 * 校验行 id（它决定解压目录名）。
 *
 * @param value - 任意值。
 * @returns 合法 id。
 */
export function assertRowId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!ROW_ID.test(id)) throw new Error(`技能行 id 不合法：${JSON.stringify(value)}`)
  return id
}

/**
 * 把 zip 解到 `<root>/<rowId>/`，并校验里面的 SKILL.md。
 *
 * 先解到临时目录再整体替换：解压中途失败时不会留下半套文件把好技能弄坏。
 *
 * @param archive - zip 二进制。
 * @param root - 技能根目录。
 * @param rowId - 配置行 id。
 * @returns `{ name, description, files, bytes }`。
 */
export async function installSkillZip(archive, root, rowId) {
  const id = assertRowId(rowId)
  const { files } = readZip(archive)
  const entry = files.find((file) => file.path === 'SKILL.md')
    ?? files.find((file) => file.path.toLowerCase() === 'skill.md')
  if (entry === undefined) {
    throw new Error('zip 根目录下没有 SKILL.md（技能包必须带一份带 frontmatter 的 SKILL.md）')
  }
  const meta = validateSkill(entry.data.toString('utf8'))

  const target = join(root, id)
  const staging = join(root, `.${id}.tmp`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    for (const file of files) {
      const path = join(staging, ...file.path.split('/'))
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, file.data)
    }
    const probe = await readSkillFromDir(staging)
    if (probe === undefined) throw new Error('落地后读不到 SKILL.md')
    await rm(target, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    // rename 在同一分区上是原子的：要么旧的还在，要么新的完整到位。
    await rename(staging, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return {
    name: meta.name,
    description: meta.description,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.data.length, 0),
  }
}

/**
 * 从一个已落地的技能目录里读 SKILL.md 并校验。
 *
 * @param dir - 技能目录。
 * @returns `{ name, description, content }`，目录或文件不存在时 `undefined`。
 */
export async function readSkillFromDir(dir) {
  let raw
  try {
    raw = await readFile(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    try {
      raw = await readFile(join(dir, 'skill.md'), 'utf8')
    } catch {
      return undefined
    }
  }
  try {
    const { name, description, body } = validateSkill(raw)
    return { name, description, content: body.replace(/^\s+/, '') }
  } catch {
    return undefined
  }
}

/**
 * 删掉一个已落地的技能目录。
 *
 * @param root - 技能根目录。
 * @param rowId - 配置行 id。
 * @returns {Promise<boolean>} 真的删掉了返回 true。
 */
export async function removeSkillDir(root, rowId) {
  const id = assertRowId(rowId)
  try {
    const before = await readdir(join(root, id))
    await rm(join(root, id), { recursive: true, force: true })
    return before.length >= 0
  } catch {
    return false
  }
}

/**
 * 把落盘目录与配置行对齐：删掉没有任何行引用的目录。
 *
 * 面板允许"放弃修改"，所以上传过的行可能永远不会被保存 —— 那种目录必须清掉，
 * 否则技能目录会越攒越多而模型看不见它们。
 *
 * @param root - 技能根目录。
 * @param keepIds - 仍被引用的行 id。
 * @returns {Promise<string[]>} 被删掉的目录名。
 */
export async function pruneSkillDirs(root, keepIds) {
  let names
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    if (keepIds.has(name)) continue
    // `.x.tmp` 这种残留也一并清掉。
    await rm(join(root, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}
