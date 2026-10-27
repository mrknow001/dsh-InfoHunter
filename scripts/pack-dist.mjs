#!/usr/bin/env node
/**
 * pack-dist —— 打包到 `dist/`，然后**对打出来的那个 tarball 本身**做验收。
 *
 * 为什么不是"pack 完就算完"：`files` 白名单漏一项的后果是静默的 ——
 * 装到 profile 里之后，插件要么在运行期读不到 `SKILL.md`，要么 `exports["./client"]` 指空，
 * 而报错只出现在宿主启动日志的一个角落。所以这里把包解开，逐条按"装进去之后会遇到什么"来验。
 *
 * 用法：`pnpm run pack:dist`（等价于 `node scripts/pack-dist.mjs`）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadYaml } from './lib/resolve-yaml.mjs'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const distDir = join(root, 'dist')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarballName = `${manifest.name.replace(/^@/, '').replace(/\//g, '-')}-${manifest.version}.tgz`
const tarballPath = join(distDir, tarballName)

const failures = []
const ok = (message) => console.log(`  ok   ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  FAIL ${message}`)
}
const check = (condition, message) => (condition ? ok(message) : bad(message))

// ── 1. 打包 ────────────────────────────────────────────────────────────────
console.log(`\n[1] pnpm pack → dist/${tarballName}`)
mkdirSync(distDir, { recursive: true })
rmSync(tarballPath, { force: true })

const pnpmEntry = process.env.npm_execpath
const packed = pnpmEntry !== undefined && pnpmEntry.endsWith('.mjs')
  ? spawnSync(process.execPath, [pnpmEntry, 'pack', '--pack-destination', distDir], { cwd: root, encoding: 'utf8' })
  // 没有 npm_execpath（直接 `node scripts/pack-dist.mjs`）时走 PATH 上的 pnpm。
  // 传单个命令串而不是 args 数组，否则 Node 会报 shell+args 的弃用警告。
  : spawnSync('pnpm pack --pack-destination dist', { cwd: root, encoding: 'utf8', shell: true })

if (packed.status !== 0) {
  console.error(packed.stdout ?? '')
  console.error(packed.stderr ?? '')
  throw new Error(`pnpm pack 失败（退出码 ${String(packed.status)}）`)
}
if (!existsSync(tarballPath)) throw new Error(`预期产物不存在：${tarballPath}`)
ok(`产物 ${(statSync(tarballPath).size / 1024).toFixed(1)} KiB`)

// ── 2. 解开 ────────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'infohunter-pack-'))
try {
  const unpacked = spawnSync('tar', ['-xzf', tarballPath, '-C', workDir], { encoding: 'utf8' })
  if (unpacked.status !== 0) {
    console.error(unpacked.stderr ?? '')
    throw new Error('tar 解包失败（tarball 可能损坏）')
  }
  const pkgDir = join(workDir, 'package')
  check(existsSync(pkgDir), 'tarball 使用 npm 的 package/ 前缀')

  const walk = (dir, prefix = '') => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
      else out.push(rel)
    }
    return out.sort()
  }
  const files = walk(pkgDir)
  console.log(`  —— 包内 ${files.length} 个文件：`)
  for (const file of files) console.log(`     ${file}`)

  // ── 3. files 白名单完整性 ──────────────────────────────────────────────
  console.log('\n[3] files 白名单 → 实际包内文件')
  /**
   * 把单层通配（`locale/<star>.json`、`skills/<star>/SKILL.md`）展开成源码里的实际文件名。
   *
   * 注：本注释刻意不写带斜杠星号的 glob 字面量 —— 那里面含块注释终止符，会把注释提前截断。
   */
  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expand = (pattern) => {
    const segments = pattern.split('/')
    const results = []
    const recurse = (index, current) => {
      if (index === segments.length) {
        results.push(current)
        return
      }
      const segment = segments[index]
      if (segment.includes('*')) {
        const dir = current === '' ? root : join(root, current)
        if (!existsSync(dir)) return
        // `*` 只跨一个路径段，所以用 [^/]* 拼接。
        const regex = new RegExp(`^${segment.split('*').map(escapeRe).join('[^/]*')}$`)
        const needsDirectory = index + 1 < segments.length
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!regex.test(entry.name)) continue
          if (needsDirectory && !entry.isDirectory()) continue
          recurse(index + 1, current === '' ? entry.name : `${current}/${entry.name}`)
        }
        return
      }
      recurse(index + 1, current === '' ? segment : `${current}/${segment}`)
    }
    recurse(0, '')
    return results
  }

  for (const pattern of manifest.files ?? []) {
    const matches = expand(pattern)
    if (matches.length === 0) bad(`files 里的 "${pattern}" 在源码里匹配不到任何文件`)
    for (const match of matches) {
      if (!files.includes(match)) bad(`"${match}"（来自 files "${pattern}"）没有进包`)
    }
  }
  if (!failures.some((message) => message.includes('没有进包') || message.includes('匹配不到'))) {
    ok('files 里列的每一条都进了包')
  }

  // ── 4. 不该进包的东西 ──────────────────────────────────────────────────
  console.log('\n[4] 不该进包的东西')
  const junk = files.filter((file) =>
    file.startsWith('scripts/')
    || file.startsWith('node_modules/')
    || file.endsWith('pnpm-lock.yaml')
    || file.endsWith('.tgz')
    || file.startsWith('.git'),
  )
  check(junk.length === 0, '没有脚本/依赖/lockfile/tarball 混进包', )
  if (junk.length > 0) for (const file of junk) console.error(`       · ${file}`)

  // ── 5. 装进去之后运行期会读到什么 ──────────────────────────────────────
  console.log('\n[5] 运行期会读到的路径')
  const innerManifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  check(innerManifest.version === manifest.version, `包内 version 与源码一致（${innerManifest.version}）`)
  check(innerManifest.dsh?.bundle?.patch === './cordis.patch.yml', '包内声明了 dsh.bundle.patch')

  const patchTarget = innerManifest.dsh?.bundle?.patch
  check(patchTarget !== undefined && existsSync(join(pkgDir, patchTarget)), `补丁文件 ${String(patchTarget)} 在包内`)

  const clientTarget = innerManifest.exports?.['./client']
  check(typeof clientTarget === 'string' && existsSync(join(pkgDir, clientTarget)), `客户端半 ${String(clientTarget)} 在包内`)

  const iconTarget = innerManifest.exports?.['./icon']
  check(typeof iconTarget === 'string' && existsSync(join(pkgDir, iconTarget)), `图标 ${String(iconTarget)} 在包内`)
  if (typeof iconTarget === 'string' && existsSync(join(pkgDir, iconTarget))) {
    const icon = readFileSync(join(pkgDir, iconTarget), 'utf8')
    check(/^\s*<svg[\s>]/.test(icon), '图标是合法 SVG 根元素')
  }

  // preset 半按 `import.meta.url` 定位技能正文 —— 路径必须与源码布局一致。
  const skillFiles = files.filter((file) => file.startsWith('skills/') && file.endsWith('SKILL.md'))
  check(skillFiles.length > 0, `技能正文进了包（${skillFiles.length} 个）`)
  for (const file of skillFiles) {
    const text = readFileSync(join(pkgDir, file), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    check(front !== null, `${file} 带 front matter`)
    if (front !== null) {
      check(/^name:\s*\S+/m.test(front[1]), `${file} 的 front matter 有 name`)
      check(/^description:\s*\S+/m.test(front[1]), `${file} 的 front matter 有 description`)
    }
  }
  for (const locale of ['locale/zh.json', 'locale/en.json']) {
    if (!files.includes(locale)) {
      bad(`${locale} 没进包 —— Plugin Manager 会显示不出标题/描述`)
      continue
    }
    try {
      const json = JSON.parse(readFileSync(join(pkgDir, locale), 'utf8'))
      check(typeof json?.meta?.title === 'string' && json.meta.title !== '', `${locale} 有 meta.title`)
    } catch (error) {
      bad(`${locale} 不是合法 JSON：${error.message}`)
    }
  }

  // ── 6. 包内 JS 语法 + 客户端 bundle 形状 ───────────────────────────────
  console.log('\n[6] 包内 JavaScript')
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const checked = spawnSync(process.execPath, ['--check', join(pkgDir, file)], { encoding: 'utf8' })
    check(checked.status === 0, `${file} 语法通过`)
  }
  if (typeof clientTarget === 'string' && existsSync(join(pkgDir, clientTarget))) {
    const client = readFileSync(join(pkgDir, clientTarget), 'utf8')
    check(client.includes('window.__ModuleLoader__.load('), '客户端半用 __ModuleLoader__.load 注册')
    check(client.includes(`id: '${innerManifest.name}'`), `客户端 bundle 的 id 等于包名（${innerManifest.name}）`)
  }

  // ── 6b. 导入闭合 ───────────────────────────────────────────────────────
  //
  // 语法通过**不代表**能加载：`files` 漏掉一个被 import 的本地模块时，语法检查照样绿，
  // 装进去才炸在 `ERR_MODULE_NOT_FOUND`（0.2.5 就出过这事：`scope.js` 没进 files）。
  // 所以这里对每个产物模块：先用静态扫描核对相对导入都在包内，再真的 `import()` 一次。
  console.log('\n[6b] 导入闭合（相对导入 + 真实 import）')
  const shipped = new Set(files)
  const moduleFiles = files.filter((name) => name.endsWith('.js'))
  const unresolved = []
  for (const file of moduleFiles) {
    const source = readFileSync(join(pkgDir, file), 'utf8')
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = match[1].replace(/^\.\//, '')
      if (!shipped.has(target)) unresolved.push(`${file} → ${match[1]}`)
    }
  }
  check(unresolved.length === 0, '每个相对导入的目标都在包内')
  for (const entry of unresolved) console.error(`       · ${entry}`)

  // 真的加载一次：`index.js` / `preset.js` 只 import node 内建模块，可以在无宿主的情况下安全 import。
  for (const file of ['index.js', 'preset.js', 'storage.js', 'vocabulary.js']) {
    if (!shipped.has(file)) continue
    const probe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(pkgDir, file)).href)}).then(()=>{},(e)=>{console.error(e.message);process.exit(1)})`], { encoding: 'utf8' })
    check(probe.status === 0, `${file} 能在这个包内成功 import`, (probe.stderr ?? '').split('\n')[0])
  }

  // ── 7. 包内补丁与源码一致 ──────────────────────────────────────────────
  console.log('\n[7] 包内补丁')
  if (patchTarget !== undefined && existsSync(join(pkgDir, patchTarget))) {
    const inner = readFileSync(join(pkgDir, patchTarget), 'utf8')
    const outer = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    check(inner === outer, '包内补丁与源码逐字节一致')
    const yaml = await loadYaml()
    if (yaml.parse === undefined) {
      console.log('  （跳过 YAML 语法校验：没找到 yaml；逐字节一致仍是主保证）')
    } else {
      try {
        const tag = [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ $js: String(value ?? '') }) }]
        const document = yaml.parse(inner, { customTags: tag })
        check(Array.isArray(document) && document.length > 0, '包内补丁是合法 YAML')
      } catch (error) {
        bad(`包内补丁解析失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

// ── 结论 ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\npack-dist: ❌ ${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\npack-dist: 全部通过 → dist/${basename(tarballPath)}`)
  console.log('安装：plugin_manager action: install_bundle target: ' + tarballPath)
}
