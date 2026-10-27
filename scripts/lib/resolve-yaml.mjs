/**
 * 解析开发期工具依赖 `yaml` —— **但绝不把它装进插件目录**。
 *
 * 为什么这么绕：插件包必须保持**零依赖**。`plugin_manager install_bundle` 把一个
 * 带依赖的目录导入 profile 时，pnpm 要为目标布局重建这些依赖；源目录是 isolated
 * 布局、profile 是 hoisted、而且两边跨盘（D: → C:），创建目录符号链接在 Windows 上
 * 直接 `EPERM`，于是整次安装失败并把 profile 回滚。
 *
 * 所以 `yaml` 放在插件目录**外面**（默认 `../infohunter-tooling`），脚本按顺序找：
 *   1. `$INFOHUNTER_TOOLING` 指定的目录
 *   2. 默认的同级 `infohunter-tooling`
 *   3. 裸解析（万一外面已经有了）
 * 都找不到就返回 `{ missing }`，由调用方决定降级 —— 不要 `exit(1)`。
 *
 * @module @infohunter/dsh-information-hunter/scripts/lib/resolve-yaml
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE_ROOT = join(HERE, '..', '..')

/** 默认的工具目录（插件目录的同级）。 */
export const TOOLING_DIR = process.env.INFOHUNTER_TOOLING ?? join(BUNDLE_ROOT, '..', 'infohunter-tooling')

/** 给人看的安装提示。 */
export const INSTALL_HINT = `在插件目录**之外**装一次：mkdir "${TOOLING_DIR}" 并放一个 package.json 后执行 pnpm add yaml`

/**
 * 找到 `yaml` 的 `parse`。
 *
 * @returns {Promise<{ parse?: (text: string, options?: object) => unknown, from?: string, missing?: string[] }>}
 */
export async function loadYaml() {
  const tried = []

  // 环境变量和默认目录常常是同一个，去重免得日志里同一条试两遍。
  const candidates = [...new Set([process.env.INFOHUNTER_TOOLING, TOOLING_DIR].filter((value) => typeof value === 'string' && value !== ''))]
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'package.json'))) {
      tried.push(`${dir}（没有 package.json）`)
      continue
    }
    try {
      const resolved = createRequire(join(dir, 'package.json')).resolve('yaml')
      const module = await import(pathToFileURL(resolved).href)
      if (typeof module.parse === 'function') return { parse: module.parse, from: dir }
      tried.push(`${dir}（yaml 没有导出 parse）`)
    } catch (error) {
      tried.push(`${dir}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    const module = await import('yaml')
    if (typeof module.parse === 'function') return { parse: module.parse, from: '(可直接解析)' }
  } catch (error) {
    tried.push(`裸解析：${error instanceof Error ? error.message : String(error)}`)
  }

  return { missing: tried }
}
