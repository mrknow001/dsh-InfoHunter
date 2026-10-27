/**
 * 互联网暴露面收集 —— 浏览器半：会话视图里的「暴露面收集」标签页。
 *
 * 两个区域：**收集结果**（读会话结果）与 **配置**（读写全局工具/空间测绘行）。
 * 两者都经同源 HTTP 接口 `/infohunter/...` 存取 —— 宿主半在 `index.js` 里挂的路由。
 *
 * ## 几条照规范来的做法
 *
 * - 客户端 bundle 用 `window.__ModuleLoader__.load({ id: 包名, factory })` 自注册；
 *   React 从浏览器模块表 `require('react')` 取，不额外装。
 * - factory 里**不做任何副作用**：注册、定时器、监听全部在 `apply` 里用 `ctx.effect` 登记并返回清理。
 * - 组件局部样式以 React 元素渲染，卸载即消失。
 * - 界面文案走 Client locale 服务（`ctx.get('locale')`）；服务缺失时回落到内置中文表。
 * - 颜色一律用主题 token（`--dsw-*`）带 fallback，跟随宿主明暗主题。
 *
 * @module @infohunter/dsh-information-hunter/client
 */

window.__ModuleLoader__.load({
  id: '@infohunter/dsh-information-hunter',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 接口前缀（与宿主半的 ROUTE_PREFIX 一致）。 */
    const API = '/infohunter'

    /** 面板归属的预设 id。 */
    const PRESET_ID = 'information-hunter'

    /**
     * 这份客户端 bundle 的版本。
     *
     * 与 `package.json` 的 `version` **必须一致** —— `scripts/check-modules.mjs` 会断言这一点，
     * 所以它不会静默漂移。它的用处是识别"页面是旧的"：改完 `client.js` 后没刷新页面时，
     * 宿主报的是新版本、界面还是旧代码，这时面板会显示两者不一致并提示刷新。
     */
    const CLIENT_VERSION = '0.6.4'

    /** 用途 id —— 与宿主 `vocabulary.js` 的 PURPOSES 同序同值。 */
    const PURPOSES = [
      'main_domain', 'subdomain', 'port', 'service', 'web', 'fingerprint',
      'dns', 'cert', 'osint', 'cdn', 'screenshot', 'other',
    ]

    /**
     * 空间测绘平台能返回的数据种类 —— 与 PURPOSES 同集合，去掉 `other`。
     *
     * 空间测绘是综合查询，所以映射行用**复选框**（多选）；工具是专用程序，仍用单选用途。
     * 两边的 id 与结果的 `kind` 共用一套取值。
     */
    const CAPABILITIES = PURPOSES.filter((id) => id !== 'other')

    /** 内置中文词典（同时注册进 locale 服务，缺服务时直接用它）。 */
    const ZH = {
      'view.label': '暴露面收集',
      'view.versionHint': '插件版本 v{version}',
      'view.syncedHint': '最近一次读取数据的时间',
      'view.staleClient': '宿主已是 v{host}，当前页面加载的还是 v{client} 的客户端代码 —— 按 F5 刷新页面即可。',
      'view.staleBadge': '需刷新',
      'view.moduleStaleBadge': '待重启（磁盘 v{disk}）',
      'view.moduleStale': '当前加载的插件模块是 v{loaded}，磁盘上已经是 v{disk} —— 装过新版本但还没重启。重启 DSH 后新工具与改动才会生效。',
      'tab.assets': '资产清单',
      'tab.records': '采集记录',
      'tab.config': '配置',
      'assets.colEndpoint': 'host:port',
      'assets.colStatus': 'status',
      'assets.colProto': 'protocol',
      'assets.colTitle': 'title / banner',
      'assets.colMeta': 'fingerprint',
      'results.expandHint': '点击查看完整内容',
      'results.sourcesLabel': '来源',
      'records.title': '采集记录',
      'records.empty': '还没有采集记录',
      'records.emptyHint': 'agent 用 expose_record 写下观测后，这里会按时间倒序出现一行一条。资产清单是这些记录按端点汇总的结果。',
      'records.filtered': '当前条件没有匹配的记录',
      'records.filteredHint': '换个关键词或类型试试。',
      'records.delete': '删除这条记录',
      'records.search': '搜索',
      'records.searchPlaceholder': '关键词（资产 / 证据 / 来源）',
      'records.allKinds': '全部类型',
      'results.title': '收集结果',
      'results.empty': '还没有收集到资产',
      'results.emptyHint': 'agent 用 expose_record 记录观测后，这里会按端点汇总出现。也可以先在对话里让它调 expose_config 看看有哪些工具可用。',
      'results.filtered': '当前条件没有匹配的资产',
      'results.filteredHint': '换一个语法条件，或点「清空搜索」。',
      'results.search': '搜索',
      'results.clearSearch': '清空搜索',
      'results.searchPlaceholder': '语法：status=200 AND port=443',
      'results.help': '语法说明',
      'results.helpTitle': '查询语法',
      'results.helpIntro': '与 agent 内部的查询用的是同一套语法。字段名大小写不敏感，web.status 与 status 等价。留空表示不筛选。',
      'results.helpFields': '字段',
      'results.helpOps': '运算符',
      'results.helpOpsBody': '= 等于、!= 不等于、~ 包含（不区分大小写，也可以写成 contains，例如 protocol contains sql）、> >= < <= 数值比较；AND 优先级高于 OR，可以用括号改变优先级，相邻条件省略 AND 也生效。protocol 也会匹配服务名，fingerprint 覆盖技术栈 / Server / 服务名 / 版本。',
      'results.helpExamples': '例子（点「填入」直接用）',
      'results.helpFill': '填入',
      'results.open': '在浏览器中打开',
      'results.openFallback': '打不开浏览器，已复制链接：{url}',
      'results.syntaxError': '语法错误：{message}',
      'results.catAll': '全部',
      'results.catWeb': 'Web',
      'results.catService': '服务',
      'results.catHost': '域名',
      'results.catUnknown': '未识别',
      'results.count': '命中 {total} 条',
      'results.page': '第 {from}–{to} 条',
      'results.pageSize': '每页',
      'results.prev': '上一页',
      'results.next': '下一页',
      'config.title': '配置',
      'config.hint': '全局生效（所有「互联网暴露面收集」会话共用一份）',
      'config.empty': '还没有配置任何工具或空间测绘平台',
      'config.emptyHint': '点下面的「添加一行」开始。没有配置时，agent 会如实告诉你它没有可用工具，并只能用通用手段兜底。',
      'config.addTool': '＋ 添加一行工具',
      'config.addMapping': '＋ 添加一行空间测绘',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.revert': '放弃修改',
      'config.reset': '清空',
      'config.dirty': '有未保存的修改',
      'config.resetTitle': '清空全部配置？',
      'config.resetBody': '所有工具与空间测绘行都会被移除，不可撤销。已收集的结果不受影响。',
      'config.confirmReset': '确认清空',
      'config.deleteRowTitle': '删除「{name}」？',
      'config.deleteRowBody': '这一行会从待保存的配置里移除；点「保存」后才会真正生效。',
      'config.incomplete': '未填完（agent 会当它不存在）',
      'config.enabled': '启用',
      'config.disabledHint': '停用后 agent 读不到这一行',
      'config.delete': '删除',
      'config.typeTool': '工具',
      'config.typeMapping': '空间测绘',
      'config.name': '名称',
      'config.nameTool': '工具名（如 subfinder）',
      'config.nameMapping': '平台名（如 FOFA）',
      'config.purpose': '这一行是做什么的',
      'config.capabilities': '这个平台能出哪些数据（可多选）',
      'config.capabilitiesHint': '勾选它一次查询能返回的数据种类。空间测绘是综合查询，一次往往同时出域名、IP、端口、协议、标题、指纹、证书 —— 模型据此判断缺某类数据该问哪个平台。',
      'config.capabilitiesNone': '未勾选任何数据种类 —— 模型只能先读 API 说明自己判断',
      'config.capabilityCount': '{n} 项能力',
      'config.summaryEmpty': '（未填写）',
      'config.selectAll': '全选',
      'config.selectNone': '清空',
      'config.note': '备注',
      'config.notePlaceholder': '任意补充说明',
      'config.toolPath': '工具文件路径',
      'config.toolPathPlaceholder': '如 C:\\Tools\\subfinder\\subfinder.exe 或 /usr/local/bin/nmap',
      'config.toolDoc': '工具说明（给模型看：怎么调、有什么参数、输出长什么样、注意什么）',
      'config.toolDocPlaceholder': '例：被动子域枚举。用法 subfinder -d example.com -silent，输出每行一个子域名。不做泛解析检测，结果需再经 DNS 验证。',
      'config.baseUrl': 'BaseURL',
      'config.baseUrlPlaceholder': '如 https://fofa.info/api/v1',
      'config.key': 'Key / Token',
      'config.keyPlaceholder': 'API Key',
      'config.reveal': '显示',
      'config.hide': '隐藏',
      'config.keyNote': '面板默认打码；明文会原样交给 agent（它要拿去发请求），别把不该给模型看的凭证填在这里。',
      'config.apiDoc': 'API 使用说明（给模型看：查询语法、示例请求、返回字段含义、配额限制）',
      'config.apiDocPlaceholder': '例：GET /search/global?qbase64=<base64(query)>&size=100，key 作为 query 参数 key= 传入。返回 JSON：results[] 每项含 host/ip/port/title。',
      'config.remark': '备注（测绘行）',
      'config.remarkPlaceholder': '如：会员账号，每天 10000 条配额',
      'state.connecting': '正在连接面板通道…',
      'state.failed': '接口请求失败：{message}',
      'state.readAt': '数据 {time}',
      'state.stale': '读取失败',
      'state.notThisPreset': '这个会话没有使用「互联网暴露面收集」预设。',
      'toast.saved': '配置已保存（对该 agent 的所有会话生效）。',
      'toast.cleared': '配置已清空。',
      'toast.saveFailed': '保存失败：{message}',
      'toast.clearFailed': '清空失败：{message}',
      'toast.deleteFailed': '删除失败：{message}',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.expand': '展开',
      'common.collapse': '收起',
      'purpose.main_domain': '主域名收集',
      'purpose.subdomain': '子域名收集',
      'purpose.port': '端口扫描',
      'purpose.service': '服务/协议识别',
      'purpose.web': 'Web 探活与目录',
      'purpose.fingerprint': '指纹识别',
      'purpose.dns': 'DNS 记录',
      'purpose.cert': '证书 / CT 日志',
      'purpose.osint': '公开情报 / 搜索引擎',
      'purpose.cdn': 'CDN / WAF 识别',
      'purpose.screenshot': '截图存证',
      'purpose.other': '其他',
    }

    /** 英文词典（缺键回落到中文）。 */
    const EN = {
      'view.label': 'Exposure Hunter',
      'view.versionHint': 'Plugin version v{version}',
      'view.syncedHint': 'When the data was last read',
      'view.staleClient': 'The host is v{host} but this page still runs the v{client} client bundle — press F5 to reload.',
      'view.staleBadge': 'reload',
      'view.moduleStaleBadge': 'restart (disk v{disk})',
      'view.moduleStale': 'The loaded plugin module is v{loaded} but the disk has v{disk} — a newer version is installed but not loaded. Restart DSH to apply new tools and changes.',
      'tab.assets': 'Assets',
      'tab.records': 'Records',
      'tab.config': 'Settings',
      'assets.colEndpoint': 'host:port',
      'assets.colStatus': 'status',
      'assets.colProto': 'protocol',
      'assets.colTitle': 'title / banner',
      'assets.colMeta': 'fingerprint',
      'results.expandHint': 'Click to see the full text',
      'results.sourcesLabel': 'Sources',
      'records.title': 'Collection records',
      'records.empty': 'No records yet',
      'records.emptyHint': 'Rows appear here, newest first, as the agent calls expose_record. The asset list is these records rolled up per endpoint.',
      'records.filtered': 'No records match',
      'records.filteredHint': 'Try another keyword or kind.',
      'records.delete': 'Delete this record',
      'records.search': 'Search',
      'records.searchPlaceholder': 'Keyword (asset / evidence / source)',
      'records.allKinds': 'All kinds',
      'results.title': 'Findings',
      'results.empty': 'No assets yet',
      'results.emptyHint': 'Assets appear here as soon as the agent calls expose_record. Ask it to run expose_config first to see which tools are available.',
      'results.filtered': 'No assets match this query',
      'results.filteredHint': 'Try another query, or clear the search.',
      'results.search': 'Search',
      'results.clearSearch': 'Clear search',
      'results.searchPlaceholder': 'Query: status=200 AND port=443',
      'results.help': 'Query syntax',
      'results.helpTitle': 'Query syntax',
      'results.helpIntro': 'The same grammar the agent uses. Field names are case-insensitive; web.status is the same as status. Leave empty to skip filtering.',
      'results.helpFields': 'Fields',
      'results.helpOps': 'Operators',
      'results.helpOpsBody': '= equals, != not equals, ~ contains (case-insensitive; also written as contains, e.g. protocol contains sql), > >= < <= numeric; AND binds tighter than OR, parentheses override it, and adjacent terms imply AND. protocol also matches the service name; fingerprint covers tech / Server / service / version.',
      'results.helpExamples': 'Examples (click to use)',
      'results.helpFill': 'Use',
      'results.open': 'Open in browser',
      'results.openFallback': 'Could not open a browser; the link was copied: {url}',
      'results.syntaxError': 'Query error: {message}',
      'results.catAll': 'All',
      'results.catWeb': 'Web',
      'results.catService': 'Services',
      'results.catHost': 'Hosts',
      'results.catUnknown': 'Unknown',
      'results.count': '{total} match(es)',
      'results.page': 'showing {from}–{to}',
      'results.pageSize': 'per page',
      'results.prev': 'Prev',
      'results.next': 'Next',
      'config.title': 'Settings',
      'config.hint': 'Global — shared by every Internet Exposure Hunter session',
      'config.empty': 'No tools or platforms configured yet',
      'config.emptyHint': 'Use “Add a row” below. Without configuration the agent will tell you it has no tools and fall back to generic means.',
      'config.addTool': '+ Add tool row',
      'config.addMapping': '+ Add mapping row',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.revert': 'Discard changes',
      'config.reset': 'Clear',
      'config.dirty': 'Unsaved changes',
      'config.resetTitle': 'Clear all settings?',
      'config.resetBody': 'Every tool and mapping row is removed. This cannot be undone. Findings are unaffected.',
      'config.confirmReset': 'Clear',
      'config.deleteRowTitle': 'Delete “{name}”?',
      'config.deleteRowBody': 'The row is removed from the draft; it takes effect after you press Save.',
      'config.incomplete': 'Incomplete (agent will ignore it)',
      'config.enabled': 'Enabled',
      'config.disabledHint': 'Disabled rows are invisible to the agent',
      'config.delete': 'Delete',
      'config.typeTool': 'Tool',
      'config.typeMapping': 'Mapping',
      'config.name': 'Name',
      'config.nameTool': 'Tool name (e.g. subfinder)',
      'config.nameMapping': 'Platform (e.g. FOFA)',
      'config.purpose': 'What this row is for',
      'config.capabilities': 'What this platform can return (multi-select)',
      'config.capabilitiesHint': 'Check the data kinds one query can return. Cyberspace mapping is a combined search — one query often yields hosts, IPs, ports, protocols, titles, fingerprints and certificates — so the agent can tell which platform answers which gap.',
      'config.capabilitiesNone': 'Nothing checked — the agent has to judge from the API note',
      'config.capabilityCount': '{n} kinds',
      'config.summaryEmpty': '(empty)',
      'config.selectAll': 'All',
      'config.selectNone': 'None',
      'config.note': 'Note',
      'config.notePlaceholder': 'Anything else worth recording',
      'config.toolPath': 'Tool path',
      'config.toolPathPlaceholder': 'e.g. C:\\Tools\\subfinder\\subfinder.exe or /usr/local/bin/nmap',
      'config.toolDoc': 'Usage note (what the model reads: how to call it, its flags, output shape, caveats)',
      'config.toolDocPlaceholder': 'e.g. Passive subdomain enumeration. Run subfinder -d example.com -silent; one subdomain per line. No wildcard detection — verify with DNS.',
      'config.baseUrl': 'Base URL',
      'config.baseUrlPlaceholder': 'e.g. https://fofa.info/api/v1',
      'config.key': 'Key / Token',
      'config.keyPlaceholder': 'API key',
      'config.reveal': 'Show',
      'config.hide': 'Hide',
      'config.keyNote': 'Masked here, but handed to the agent verbatim — do not store credentials the model must not see.',
      'config.apiDoc': 'API note (what the model reads: query syntax, example request, response fields, quota)',
      'config.apiDocPlaceholder': 'e.g. GET /search/global?qbase64=<base64(query)>&size=100 with key as the query parameter key=. Returns JSON: results[] with host/ip/port/title.',
      'config.remark': 'Remark',
      'config.remarkPlaceholder': 'e.g. paid account, 10k queries/day',
      'state.connecting': 'Connecting to the panel API…',
      'state.failed': 'Request failed: {message}',
      'state.readAt': 'data {time}',
      'state.stale': 'read failed',
      'state.notThisPreset': 'This session does not use the Internet Exposure Hunter preset.',
      'toast.saved': 'Settings saved (applies to every session of this agent).',
      'toast.cleared': 'Settings cleared.',
      'toast.saveFailed': 'Save failed: {message}',
      'toast.clearFailed': 'Clear failed: {message}',
      'toast.deleteFailed': 'Delete failed: {message}',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.expand': 'Expand',
      'common.collapse': 'Collapse',
      'purpose.main_domain': 'Root domains',
      'purpose.subdomain': 'Subdomains',
      'purpose.port': 'Ports',
      'purpose.service': 'Services',
      'purpose.web': 'Web',
      'purpose.fingerprint': 'Fingerprints',
      'purpose.dns': 'DNS',
      'purpose.cert': 'Certificates / CT',
      'purpose.osint': 'OSINT',
      'purpose.cdn': 'CDN / WAF',
      'purpose.screenshot': 'Screenshots',
      'purpose.other': 'Other',
    }

    /** 结果类型的着色（用主题状态色，避免自造一套色板）。 */
    const KIND_TONE = {
      main_domain: 'var(--dsw-static-violet-500, #7c3aed)',
      subdomain: 'var(--dsw-static-blue-500, #2563eb)',
      port: 'var(--dsw-static-cyan-500, #0891b2)',
      service: 'var(--dsw-static-teal-500, #0d9488)',
      web: 'var(--dsw-alias-brand-primary, #4f46e5)',
      fingerprint: 'var(--dsw-static-amber-600, #b45309)',
      dns: 'var(--dsw-static-green-600, #4d7c0f)',
      cert: 'var(--dsw-static-violet-600, #9333ea)',
      osint: 'var(--dsw-static-amber-700, #92400e)',
      cdn: 'var(--dsw-static-red-500, #db2777)',
      screenshot: 'var(--dsw-alias-label-secondary, #475467)',
      other: 'var(--dsw-alias-label-tertiary, #667085)',
    }

    /** 主题 token 快捷方式。 */
    const v = (name, fallback) => `var(${name}, ${fallback})`
    const T = {
      bg: v('--dsw-alias-bg-base', '#f6f7f9'),
      card: v('--dsw-alias-bg-layer-1', '#ffffff'),
      field: v('--dsw-alias-bg-layer-2', '#f2f4f7'),
      border: v('--dsw-alias-border-l1', '#e6e8ec'),
      borderSoft: v('--dsw-alias-border-l2', '#d5d9e0'),
      text: v('--dsw-alias-label-primary', '#101828'),
      text2: v('--dsw-alias-label-secondary', '#667085'),
      text3: v('--dsw-alias-label-tertiary', '#98a2b3'),
      brand: v('--dsw-alias-brand-primary', '#4f46e5'),
      error: v('--dsw-alias-state-error-primary', '#d92d20'),
      success: v('--dsw-alias-state-success-primary', '#039855'),
      warn: v('--dsw-alias-state-warn-primary', '#b54708'),
      code: v('--ds-font-family-code', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'),
      radius: 10,
    }

    const tint = (color, alpha = 0.14) => `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`

    // ── 接口 ────────────────────────────────────────────────────────────────

    /**
     * 调宿主接口。
     *
     * `token` 只在页面 URL 带它时补上：桌面版有时用 `?token=` 打开 Web GUI，
     * 同源 fetch 未必自动带上。
     *
     * @param {string} path - 相对 `/infohunter` 的路径。
     * @param {object} [options] - `{ method, body }`。
     * @returns {Promise<any>} 解析后的 JSON。
     */
    async function api(path, options = {}) {
      const token = new URLSearchParams(window.location.search).get('token')
      const url = `${API}${path}${token === null ? '' : `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`}`
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'same-origin',
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
      }
      if (!response.ok || payload?.error !== undefined) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      }
      return payload
    }

    // ── 小件 ────────────────────────────────────────────────────────────────

    function Card(props) {
      // 转发 className：网格项默认 `min-width: auto`，得靠 `.ih-card` 才能被压窄。
      return h('div', {
        className: props.className,
        style: { background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: 'var(--dsw-shadow-lv1, 0 1px 2px rgba(16,24,40,.06))', ...props.style },
      }, props.children)
    }

    function Pill(props) {
      return h('span', {
        title: props.title,
        style: {
          background: tint(props.tone, 0.14), color: props.tone, borderRadius: 999,
          padding: '2px 9px', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: '18px', flexShrink: 0,
          // 胶囊必须跟文字一起量宽：所在格子太窄时截断，而不是溢出压到隔壁文字上。
          maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', boxSizing: 'border-box',
        },
      }, props.children)
    }

    function buttonStyle(variant, disabled) {
      const base = {
        cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 600,
        borderRadius: 8, padding: '6px 12px', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
      }
      if (variant === 'primary') return { ...base, background: T.brand, color: '#fff', border: `1px solid ${T.brand}` }
      if (variant === 'danger') return { ...base, background: 'transparent', color: T.error, border: `1px solid ${tint(T.error, 0.45)}` }
      return { ...base, background: 'transparent', color: T.text2, border: `1px solid ${T.border}` }
    }

    function fieldStyle(extra) {
      return {
        font: 'inherit', fontSize: 12.5, color: T.text, background: T.field,
        border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 10px',
        width: '100%', boxSizing: 'border-box', ...extra,
      }
    }

    function EmptyState(props) {
      return h(Card, { style: { padding: '28px 20px', textAlign: 'center' } },
        h('div', { style: { fontSize: 13.5, fontWeight: 600, color: T.text2 } }, props.title),
        h('div', { style: { fontSize: 12.5, color: T.text3, marginTop: 6, lineHeight: 1.7 } }, props.hint),
      )
    }

    function SectionHeader(props) {
      return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 14, fontWeight: 700, color: T.text } }, props.title),
        props.hint === undefined ? null : h('span', { style: { fontSize: 12, color: T.text3 } }, props.hint),
        props.extra === undefined ? null : h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } }, props.extra),
      )
    }

    function FoldText(props) {
      const [open, setOpen] = useState(false)
      const text = props.text
      if (text === '') return h('span', { style: { color: T.text3 } }, '—')
      const max = props.max ?? 240
      if (text.length <= max) return h('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text)
      return h('span', null,
        h('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, open ? text : `${text.slice(0, max)}…`),
        h('button', {
          type: 'button',
          onClick: () => setOpen((value) => !value),
          style: { marginLeft: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.brand, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' },
        }, open ? props.t('common.collapse') : `${props.t('common.expand')}（${text.length}）`),
      )
    }

    function CopyButton(props) {
      const [done, setDone] = useState(false)
      return h('button', {
        type: 'button',
        title: props.text,
        onClick: (event) => {
          event.stopPropagation()
          if (navigator.clipboard?.writeText === undefined) return
          navigator.clipboard.writeText(props.text).then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          }, () => {})
        },
        style: {
          background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6,
          color: done ? T.success : T.text3, cursor: 'pointer', fontSize: 11, fontWeight: 600,
          padding: '2px 7px', lineHeight: '16px', flexShrink: 0,
        },
      }, done ? props.t('common.copied') : '⧉')
    }

    function Modal(props) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') props.onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.onClose])
      return h('div', {
        onClick: props.onClose,
        style: { position: 'fixed', inset: 0, background: 'rgba(16,24,40,.45)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
      },
        h('div', {
          onClick: (event) => event.stopPropagation(),
          style: { background: T.card, border: `1px solid ${T.borderSoft}`, borderRadius: 14, width: 560, maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderBottom: `1px solid ${T.border}` } },
            h('div', { style: { fontSize: 14.5, fontWeight: 700, color: T.text, flex: 1 } }, props.title),
            h('button', {
              type: 'button', title: props.t('common.close'), onClick: props.onClose,
              style: { background: T.field, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text2, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '5px 8px' },
            }, '✕'),
          ),
          h('div', { style: { flex: 1, overflow: 'auto', padding: '16px 18px' } }, props.children),
        ),
      )
    }

    function NoticeStack() {
      const [items, setItems] = useState([])
      useEffect(() => {
        const push = (notice) => {
          setItems((prev) => [...prev.slice(-3), notice])
          setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== notice.id)), notice.kind === 'error' ? 10000 : 4000)
        }
        return subscribeNotices(push)
      }, [])
      if (items.length === 0) return null
      return h('div', { style: { position: 'fixed', right: 18, bottom: 18, zIndex: 1100, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 440 } },
        items.map((notice) => h('div', {
          key: notice.id,
          style: {
            display: 'flex', gap: 8, alignItems: 'flex-start', background: T.card,
            border: `1px solid ${notice.kind === 'error' ? tint(T.error, 0.45) : T.borderSoft}`,
            borderRadius: T.radius, padding: '10px 12px',
          },
        },
          h('span', { style: { color: notice.kind === 'error' ? T.error : T.brand, fontSize: 13, lineHeight: '18px' } }, notice.kind === 'error' ? '✕' : 'ℹ'),
          h('span', { style: { flex: 1, fontSize: 12.5, color: T.text, lineHeight: 1.55, wordBreak: 'break-word', whiteSpace: 'pre-line' } }, notice.text),
          h('button', {
            type: 'button', onClick: () => setItems((prev) => prev.filter((item) => item.id !== notice.id)),
            style: { background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 2 },
          }, '✕'),
        )),
      )
    }

    /** 模块级提示订阅表：`notify` 从任意异步 catch 里调用。 */
    const noticeListeners = new Set()
    let noticeSeq = 0

    function subscribeNotices(listener) {
      noticeListeners.add(listener)
      return () => noticeListeners.delete(listener)
    }

    function notify(text, kind = 'error') {
      const notice = { id: ++noticeSeq, kind, text }
      for (const listener of noticeListeners) listener(notice)
      if (kind === 'error') console.error('[infohunter]', text)
    }

    /** 把任意抛错渲染成一行。 */
    const describe = (error) => (error instanceof Error ? error.message : String(error))

    // ── 配置行工具 ──────────────────────────────────────────────────────────

    let rowSeq = 0

    /** 新行 id。 */
    function newRowId() {
      rowSeq += 1
      return `row-${Date.now().toString(36)}-${rowSeq}`
    }

    /** 新建一行。工具带单选用途；空间测绘带多选能力，初始全不勾。 */
    function blankEntry(type) {
      const base = { id: newRowId(), type, name: '', enabled: true, note: '' }
      return type === 'tool'
        ? { ...base, purpose: 'other', path: '', description: '' }
        : { ...base, capabilities: [], baseUrl: '', key: '', apiDoc: '', remark: '' }
    }

    /** 键序稳定的 JSON：用于 dirty 判断，避免无意义抖动。 */
    function stableJson(value) {
      return JSON.stringify(value, (_key, val) => {
        if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
        const out = {}
        for (const key of Object.keys(val).sort()) out[key] = val[key]
        return out
      })
    }

    /** 打码密钥：保留后 4 位便于辨认。 */
    function maskKey(key) {
      if (key === '') return ''
      if (key.length <= 4) return '•'.repeat(key.length)
      return `${'•'.repeat(Math.min(24, key.length - 4))}${key.slice(-4)}`
    }

    // ── 区域一：收集结果 ────────────────────────────────────────────────────

    const PAGE_SIZES = [50, 100, 200]

    /** 分类色标（`unknown` = 只有端口、没有判别证据）。 */
    const CATEGORY_TONE = { web: T.brand, service: T.success, host: T.text2, unknown: T.text3 }

    /** 点击展开的气泡：完整 banner / 长标题原样显示（多行保留）。 */
    function TextBubble(props) {
      const { x, y, text, onClose } = props
      useEffect(() => {
        const close = () => onClose()
        const onKey = (event) => { if (event.key === 'Escape') close() }
        // 延迟一拍再挂监听，免得被"打开它的那一次点击"立刻关掉。
        const timer = setTimeout(() => {
          document.addEventListener('click', close)
          document.addEventListener('keydown', onKey)
        }, 0)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [])
      return h('div', {
        onClick: (event) => event.stopPropagation(),
        style: {
          position: 'fixed', top: y, left: x, zIndex: 300, maxWidth: 460, maxHeight: 320, overflow: 'auto',
          background: T.card, border: `1px solid ${T.border}`, borderRadius: 10,
          boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(16,24,40,.18))', padding: '10px 12px',
          fontFamily: T.code, fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          color: T.text,
        },
      }, text)
    }

    /** 一行一条资产：FOFA 那样的紧凑表格行，不是大卡片。 */
    function AssetRow(props) {
      const { row, t, onOpen } = props
      const [bubble, setBubble] = useState(null)
      const endpoint = row.port === 0 ? row.host : `${row.host}:${row.port}`
      const tone = CATEGORY_TONE[row.category] ?? T.text2
      const badge = row.category === 'unknown'
        ? '?'
        : row.category === 'web'
          ? (row.protocol !== '' ? row.protocol : 'web')
          : row.category === 'host'
            ? 'host'
            : (row.service !== '' ? row.service : 'service')
      // Web 资产直接给可访问的 URL：默认端口不写进去，其他端口带上。
      const isWeb = row.category === 'web' && (row.protocol === 'http' || row.protocol === 'https')
      const defaultPort = row.protocol === 'https' ? 443 : 80
      const url = isWeb
        ? `${row.protocol}://${row.host}${row.port === 0 || row.port === defaultPort ? '' : `:${row.port}`}`
        : ''
      const label = isWeb ? url : endpoint
      const sources = Array.isArray(row.sources) ? row.sources : []
      const tech = Array.isArray(row.tech) ? row.tech : []

      // 标题 / banner：Web 只看 title；服务看 banner；host 级两者都没有。
      // 不做跨类兜底 —— 那会让备注/证据文本漏进这一列。
      const titleRaw = isWeb
        ? row.title
        : (row.category === 'host'
            ? ''
            : (row.banner !== '' ? row.banner : (row.service === '' ? '' : `${row.service}${row.version === '' ? '' : ` ${row.version}`}`)))
      const firstLine = titleRaw.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
      const cellText = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
      const canExpand = cellText !== titleRaw && titleRaw !== ''
      // 指纹：Web 是技术栈 + Server；其他服务是服务名 + 版本。
      const fingerprint = isWeb
        ? [...tech.slice(0, 3), row.server].filter((value) => value !== '')
        : [row.service, row.version].filter((value) => value !== '')

      const openBubble = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setBubble({
          x: Math.max(8, Math.min(rect.left, window.innerWidth - 468)),
          y: Math.min(rect.bottom + 6, window.innerHeight - 120),
          text: titleRaw,
        })
      }

      return h('div', { className: 'ih-asset', 'data-testid': 'infohunter-asset' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
          h('span', {
            title: sources.length > 0 ? `${label}\n${t('results.sourcesLabel')}: ${sources.join(' · ')}` : label,
            style: {
              fontFamily: T.code, fontSize: 12.5, fontWeight: 600, color: isWeb ? T.brand : T.text, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, label),
          // 复制给的是链接本身，粘到浏览器就能开。
          h(CopyButton, { text: isWeb ? url : endpoint, t }),
          isWeb ? h('button', {
            type: 'button',
            title: t('results.open'),
            'aria-label': t('results.open'),
            onClick: () => onOpen(url),
            style: {
              flexShrink: 0, background: 'transparent', border: 'none', color: T.text3,
              cursor: 'pointer', fontSize: 12, padding: 1, lineHeight: 1,
            },
          }, '↗') : null,
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', overflow: 'hidden' } },
          row.status === 0
            ? h('span', { style: { fontSize: 11, color: T.text3 } }, '—')
            : h(Pill, {
                tone: row.status < 300 ? T.success : row.status < 400 ? T.brand : row.status < 500 ? T.warn : T.error,
              }, String(row.status)),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', overflow: 'hidden' } },
          h(Pill, { tone }, badge),
        ),
        h('span', {
          className: 'ih-col-title',
          title: canExpand ? t('results.expandHint') : (cellText === '' ? undefined : titleRaw),
          onClick: canExpand ? openBubble : undefined,
          style: {
            fontSize: 12, color: cellText === '' ? T.text3 : T.text, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            cursor: canExpand ? 'pointer' : 'default',
          },
        }, cellText === '' ? '—' : cellText),
        h('span', {
          className: 'ih-col-meta',
          title: fingerprint.join(' · ') || undefined,
          style: {
            fontSize: 11, color: T.text3, fontFamily: T.code, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, fingerprint.join(' · ') || '—'),
        bubble === null ? null : h(TextBubble, { ...bubble, onClose: () => setBubble(null) }),
      )
    }

    /** 采集记录：一行一次观测，密集流水。 */
    function RecordRow(props) {
      const { row, t, busy, onDelete } = props
      const tone = KIND_TONE[row.kind] ?? T.text2
      const key = `purpose.${row.kind}`
      const translated = t(key)
      const label = translated === key ? row.kind : translated
      const sources = Array.isArray(row.sources) ? row.sources : []
      const clock = new Date(row.createdAt).toLocaleTimeString()
      return h('div', { className: 'ih-rec' },
        h('span', { style: { fontFamily: T.code, fontSize: 11, color: T.text3 } }, clock),
        h(Pill, { tone }, label),
        h('span', {
          title: row.asset,
          style: {
            fontFamily: T.code, fontSize: 12, color: T.text, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, row.asset),
        h('span', {
          style: { fontSize: 11, color: T.text3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: sources.join(' · '),
        }, sources.length > 0 ? sources.join(' · ') : '—'),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          h('button', {
            type: 'button', title: t('records.delete'), disabled: busy, onClick: () => onDelete(row),
            style: {
              background: 'transparent', border: 'none', color: T.text3, cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: 11, padding: 1, lineHeight: 1,
            },
          }, '✕'),
        ),
        row.detail === '' ? null : h('div', {
          className: 'ih-rec-detail',
          style: { fontSize: 11.5, color: T.text2, lineHeight: 1.65, wordBreak: 'break-word' },
        }, h(FoldText, { text: row.detail, t, max: 200 })),
      )
    }

    /** 采集记录区：过程流水，不是结果。 */
    function RecordsArea(props) {
      const { t, sessionId } = props
      const active = props.active !== false
      const [state, setState] = useState({
        page: { rows: [], total: 0 },
        overview: { total: 0, byKind: {}, bySource: {}, updatedAt: 0 },
        rev: { config: 0, assets: 0, records: 0 },
      })
      const [kind, setKind] = useState('')
      const [keyword, setKeyword] = useState('')
      const [applied, setApplied] = useState('')
      const [pageIndex, setPageIndex] = useState(0)
      const [pageSize, setPageSize] = useState(100)
      const [syncedAt, setSyncedAt] = useState(0)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [nonce, setNonce] = useState(0)
      const revRef = useRef(-1)

      const load = useCallback(async () => {
        const search = new URLSearchParams({
          sessionId, kind, q: applied,
          offset: String(pageIndex * pageSize), limit: String(pageSize),
        })
        try {
          const payload = await api(`/records?${search}`)
          setState(payload)
          setSyncedAt(Date.now())
          props.onSynced?.(Date.now())
          setError('')
          revRef.current = payload.rev?.records ?? revRef.current
        } catch (cause) {
          setError(describe(cause))
        }
      }, [sessionId, kind, applied, pageIndex, pageSize])

      useEffect(() => { void load() }, [load, nonce])

      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const tick = async () => {
          if (document.visibilityState === 'hidden') return
          try {
            const payload = await api(`/rev?sessionId=${encodeURIComponent(sessionId)}`)
            if (!alive) return
            if (payload.rev?.records !== revRef.current) setNonce((value) => value + 1)
          } catch {
            /* 由错误行承担 */
          }
        }
        const timer = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId, active])

      const rows = state.page?.rows ?? []
      const overview = state.overview ?? { total: 0, byKind: {}, bySource: {}, updatedAt: 0 }
      const total = state.page?.total ?? 0
      const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)
      const kindChips = PURPOSES
        .map((id) => ({ id, count: overview.byKind?.[id] ?? 0 }))
        .filter((entry) => entry.count > 0)

      const removeRow = async (row) => {
        setBusy(true)
        try {
          await api(`/records/drop?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: { id: row.id } })
          setNonce((value) => value + 1)
        } catch (cause) {
          notify(t('toast.deleteFailed').replace('{message}', describe(cause)))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        // 不设标题栏：计数在 chip 上、同步时间在标签栏里；出问题才占一行。
        error === '' ? null : h('div', { style: { fontSize: 12, color: T.error, lineHeight: 1.6 } }, t('state.failed').replace('{message}', error)),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            value: keyword,
            onChange: (event) => setKeyword(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') { setPageIndex(0); setApplied(keyword.trim()) } },
            placeholder: t('records.searchPlaceholder'),
            style: fieldStyle({ flex: '1 1 220px' }),
          }),
          h('button', { type: 'button', onClick: () => { setPageIndex(0); setApplied(keyword.trim()) }, style: buttonStyle('primary') }, t('records.search')),
          h('select', { value: kind, onChange: (event) => { setKind(event.target.value); setPageIndex(0) }, style: fieldStyle({ width: 'auto', minWidth: 120 }) },
            h('option', { value: '' }, t('records.allKinds')),
            PURPOSES.map((id) => h('option', { key: id, value: id }, t(`purpose.${id}`)))),
        ),
        kindChips.length === 0 ? null : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          kindChips.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            onClick: () => { setKind(kind === entry.id ? '' : entry.id); setPageIndex(0) },
            style: {
              cursor: 'pointer', font: 'inherit', fontSize: 12, borderRadius: 8, padding: '3px 9px', fontWeight: 600,
              background: kind === entry.id ? tint(KIND_TONE[entry.id] ?? T.text2, 0.2) : 'transparent',
              color: KIND_TONE[entry.id] ?? T.text2,
              border: `1px solid ${kind === entry.id ? tint(KIND_TONE[entry.id] ?? T.text2, 0.5) : T.border}`,
            },
          }, `${t(`purpose.${entry.id}`)} · ${entry.count}`)),
        ),
        rows.length === 0
          ? h(EmptyState, {
              title: overview.total === 0 ? t('records.empty') : t('records.filtered'),
              hint: overview.total === 0 ? t('records.emptyHint') : t('records.filteredHint'),
            })
          : h('div', { className: 'ih-list' },
              rows.map((row) => h(RecordRow, { key: row.id, row, t, busy, onDelete: (target) => void removeRow(target) }))),
        total === 0 ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: T.text2 } },
          h('span', null, t('results.count').replace('{total}', String(total))),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' } },
            h('button', { type: 'button', disabled: pageIndex <= 0, onClick: () => setPageIndex((value) => Math.max(0, value - 1)), style: buttonStyle('ghost', pageIndex <= 0) }, t('results.prev')),
            h('span', { style: { fontFamily: T.code, minWidth: 62, textAlign: 'center' } }, `${pageIndex + 1} / ${Math.max(1, lastPage + 1)}`),
            h('button', { type: 'button', disabled: pageIndex >= lastPage, onClick: () => setPageIndex((value) => Math.min(lastPage, value + 1)), style: buttonStyle('ghost', pageIndex >= lastPage) }, t('results.next')),
          ),
        ),
      )
    }

    /** 语法说明弹层：字段、运算符，以及可点即填的例子。 */
    function SearchHelp(props) {
      const { t, onClose, onPick } = props
      const groups = [
        ['host', 'ip', 'port', 'protocol', 'fingerprint', 'category'],
        ['status', 'title', 'server', 'tech'],
        ['cert.subject', 'cert.issuer', 'cert.san', 'cert.notAfter'],
        ['service', 'version', 'banner', 'note'],
        ['source', 'target', 'confidence'],
      ]
      const examples = [
        'protocol contains sql',
        'fingerprint~nginx',
        'status=200 AND port=443',
        'title~后台',
        'tech=vue OR tech=react',
        '(port=80 OR port=443) AND status!=404',
        'cert.issuer~Encrypt',
      ]
      return h(Modal, { title: t('results.helpTitle'), onClose, t },
        h('div', { style: { fontSize: 12.5, color: T.text2, lineHeight: 1.75 } }, t('results.helpIntro')),
        h('div', { style: { marginTop: 14, fontSize: 12, fontWeight: 700, color: T.text } }, t('results.helpFields')),
        groups.map((group, index) => h('div', { key: `g${index}`, style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 } },
          group.map((field) => h('code', {
            key: field,
            style: {
              fontFamily: T.code, fontSize: 11.5, padding: '1px 6px', borderRadius: 5,
              color: T.text2, background: tint(T.text3, 0.1), border: `1px solid ${T.border}`,
            },
          }, field)),
        )),
        h('div', { style: { marginTop: 14, fontSize: 12, fontWeight: 700, color: T.text } }, t('results.helpOps')),
        h('div', { style: { marginTop: 6, fontSize: 12, color: T.text2, lineHeight: 1.75 } }, t('results.helpOpsBody')),
        h('div', { style: { marginTop: 14, fontSize: 12, fontWeight: 700, color: T.text } }, t('results.helpExamples')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 7 } },
          examples.map((syntax) => h('div', { key: syntax, style: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 } },
            h('code', {
              style: {
                flex: 1, minWidth: 0, fontFamily: T.code, fontSize: 12, padding: '3px 8px', borderRadius: 6,
                color: T.text, background: tint(T.text3, 0.08), border: `1px solid ${T.border}`,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, syntax),
            h('button', {
              type: 'button',
              onClick: () => onPick(syntax),
              style: { ...buttonStyle('ghost'), flexShrink: 0, padding: '3px 10px', fontSize: 11.5 },
            }, t('results.helpFill')),
          )),
        ),
      )
    }

    function AssetsArea(props) {
      const { t, sessionId } = props
      const active = props.active !== false
      const [state, setState] = useState({
        page: { rows: [], total: 0 },
        overview: { total: 0, byCategory: { web: 0, service: 0, host: 0 }, bySource: {}, updatedAt: 0 },
        rev: { config: 0, assets: 0 },
      })
      const [query, setQuery] = useState('')
      const [applied, setApplied] = useState('')
      const [category, setCategory] = useState('')
      const [pageIndex, setPageIndex] = useState(0)
      const [pageSize, setPageSize] = useState(60)
      const [syncedAt, setSyncedAt] = useState(0)
      const [error, setError] = useState('')
      const [helpOpen, setHelpOpen] = useState(false)
      const [nonce, setNonce] = useState(0)
      const revRef = useRef(-1)

      const load = useCallback(async () => {
        const search = new URLSearchParams({
          sessionId,
          q: applied,
          category,
          offset: String(pageIndex * pageSize),
          limit: String(pageSize),
        })
        try {
          const payload = await api(`/assets?${search}`)
          setState(payload)
          setSyncedAt(Date.now())
          props.onSynced?.(Date.now())
          setError('')
          revRef.current = payload.rev?.assets ?? revRef.current
        } catch (cause) {
          setError(describe(cause))
        }
      }, [sessionId, applied, category, pageIndex, pageSize])

      useEffect(() => { void load() }, [load, nonce])

      // 变更令牌轮询：值变了才重取（不订阅、不推送）。面板切走后停掉。
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const tick = async () => {
          if (document.visibilityState === 'hidden') return
          try {
            const payload = await api(`/rev?sessionId=${encodeURIComponent(sessionId)}`)
            if (!alive) return
            if (payload.rev?.assets !== revRef.current) setNonce((value) => value + 1)
          } catch {
            /* 读失败由 load 的错误行承担 */
          }
        }
        const timer = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId, active])

      useEffect(() => { setPageIndex(0) }, [applied, category, pageSize])

      const rows = state.page?.rows ?? []
      const overview = state.overview ?? { total: 0, byCategory: {}, bySource: {}, updatedAt: 0 }
      const total = state.page?.total ?? 0
      const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)
      const syntaxError = state.page?.error ?? ''

      const submitQuery = () => {
        setPageIndex(0)
        setApplied(query.trim())
      }

      /** 打开资产链接：优先用宿主下发的桥，其次 window.open（客户端会转给默认浏览器）。 */
      const openLink = (url) => {
        try {
          const bridge = props.openExternalLink ?? props.openLink
          if (typeof bridge === 'function') {
            bridge(url)
            return
          }
        } catch {
          /* 桥失败就退到 window.open */
        }
        let opened = false
        try {
          opened = window.open(url, '_blank', 'noopener,noreferrer') !== null
        } catch {
          opened = false
        }
        if (!opened) {
          // 打不开（例如客户端只允许 https 转发）：把链接复制走，别让用户白点。
          try {
            void navigator.clipboard?.writeText(url)
          } catch {
            /* 剪贴板不可用就算了 */
          }
          notify(t('results.openFallback').replace('{url}', url))
        }
      }

      const chips = [
        { id: '', label: t('results.catAll'), count: overview.total },
        { id: 'web', label: t('results.catWeb'), count: overview.byCategory?.web ?? 0 },
        { id: 'service', label: t('results.catService'), count: overview.byCategory?.service ?? 0 },
        { id: 'host', label: t('results.catHost'), count: overview.byCategory?.host ?? 0 },
        { id: 'unknown', label: t('results.catUnknown'), count: overview.byCategory?.unknown ?? 0 },
      ]

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        // 只有出问题时才占一行；正常状态不显示任何标题栏（刷新时间在标签栏里）。
        error === '' ? null : h('div', { style: { fontSize: 12, color: T.error, lineHeight: 1.6 } }, t('state.failed').replace('{message}', error)),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          // `?` 打开语法说明：不占版面，能写得更详细，例子可点即填。
          h('button', {
            type: 'button',
            title: t('results.help'),
            'aria-label': t('results.help'),
            onClick: () => setHelpOpen(true),
            style: {
              flexShrink: 0, width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', padding: 0,
              font: 'inherit', fontSize: 12, fontWeight: 700, lineHeight: 1,
              color: T.text2, background: 'transparent', border: `1px solid ${T.border}`,
            },
          }, '?'),
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submitQuery() },
            placeholder: t('results.searchPlaceholder'),
            spellCheck: false,
            style: fieldStyle({ flex: 1, fontFamily: T.code, fontSize: 12.5 }),
          }),
          h('button', { type: 'button', onClick: submitQuery, style: buttonStyle('primary') }, t('results.search')),
          applied === '' ? null : h('button', {
            type: 'button',
            onClick: () => { setQuery(''); setApplied('') },
            style: buttonStyle('ghost'),
          }, t('results.clearSearch')),
        ),
        syntaxError === ''
          ? null
          : h('div', { style: { fontSize: 11.5, color: T.warn, lineHeight: 1.6 } }, t('results.syntaxError').replace('{message}', syntaxError)),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          chips.map((entry) => h('button', {
            key: entry.id === '' ? 'all' : entry.id,
            type: 'button',
            onClick: () => setCategory(entry.id),
            style: {
              cursor: 'pointer', font: 'inherit', fontSize: 12, borderRadius: 8, padding: '3px 9px', fontWeight: 600,
              background: category === entry.id ? tint(CATEGORY_TONE[entry.id] ?? T.text2, 0.2) : 'transparent',
              color: entry.id === '' ? T.text2 : CATEGORY_TONE[entry.id] ?? T.text2,
              border: `1px solid ${category === entry.id ? tint(CATEGORY_TONE[entry.id] ?? T.text2, 0.5) : T.border}`,
            },
          }, `${entry.label} · ${entry.count}`)),
        ),
        rows.length === 0
          ? h(EmptyState, {
              title: overview.total === 0 ? t('results.empty') : t('results.filtered'),
              hint: overview.total === 0 ? t('results.emptyHint') : t('results.filteredHint'),
            })
          : h('div', { className: 'ih-list' },
              h('div', { className: 'ih-asset ih-head' },
                h('span', null, t('assets.colEndpoint')),
                h('span', null, t('assets.colStatus')),
                h('span', null, t('assets.colProto')),
                h('span', { className: 'ih-col-title' }, t('assets.colTitle')),
                h('span', { className: 'ih-col-meta' }, t('assets.colMeta'))),
              rows.map((row) => h(AssetRow, {
                key: row.key, row, t, onOpen: openLink,
              }))),
        total === 0 ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: T.text2 } },
          h('span', null, t('results.count').replace('{total}', String(total))),
          h('span', null, t('results.page').replace('{from}', String(pageIndex * pageSize + 1)).replace('{to}', String(Math.min((pageIndex + 1) * pageSize, total)))),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' } },
            h('button', { type: 'button', disabled: pageIndex <= 0, onClick: () => setPageIndex((value) => Math.max(0, value - 1)), style: buttonStyle('ghost', pageIndex <= 0) }, t('results.prev')),
            h('span', { style: { fontFamily: T.code, minWidth: 62, textAlign: 'center' } }, `${pageIndex + 1} / ${Math.max(1, lastPage + 1)}`),
            h('button', { type: 'button', disabled: pageIndex >= lastPage, onClick: () => setPageIndex((value) => Math.min(lastPage, value + 1)), style: buttonStyle('ghost', pageIndex >= lastPage) }, t('results.next')),
            h('select', { value: String(pageSize), onChange: (event) => setPageSize(Number(event.target.value)), style: fieldStyle({ width: 'auto' }) },
              PAGE_SIZES.map((size) => h('option', { key: size, value: size }, `${t('results.pageSize')} ${size}`))),
          ),
        ),
        helpOpen ? h(SearchHelp, {
          t,
          onClose: () => setHelpOpen(false),
          onPick: (syntax) => { setQuery(syntax); setApplied(syntax.trim()); setPageIndex(0); setHelpOpen(false) },
        }) : null,
      )
    }

    // ── 区域二：配置 ────────────────────────────────────────────────────────

    /**
     * 空间测绘平台的「能出哪些数据」多选。
     *
     * 用复选框而不是下拉：空间测绘是综合查询，一行平台通常同时覆盖好几层，
     * 单选会把它压扁成"只会干一件事"，模型就无从判断缺某类数据该问谁。
     */
    function CapabilityPicker(props) {
      const { entry, t, onPatch } = props
      const picked = Array.isArray(entry.capabilities) ? entry.capabilities : []
      const apply = (ids) => onPatch({ capabilities: CAPABILITIES.filter((candidate) => ids.includes(candidate)) })
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.capabilities')),
          h('span', { style: { fontFamily: T.code, fontSize: 11, color: T.text3 } }, `${picked.length}/${CAPABILITIES.length}`),
          h('button', { type: 'button', onClick: () => apply([...CAPABILITIES]), style: buttonStyle('ghost') }, t('config.selectAll')),
          h('button', { type: 'button', onClick: () => apply([]), style: buttonStyle('ghost') }, t('config.selectNone')),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          CAPABILITIES.map((id) => {
            const on = picked.includes(id)
            return h('label', {
              key: id,
              title: t(`purpose.${id}`),
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                fontSize: 12, padding: '3px 9px', borderRadius: 8, userSelect: 'none',
                color: on ? T.brand : T.text2,
                background: on ? tint(T.brand, 0.1) : 'transparent',
                border: `1px solid ${on ? tint(T.brand, 0.45) : T.border}`,
              },
            },
              h('input', {
                type: 'checkbox',
                checked: on,
                // 勾选后按声明顺序重排，避免保存前后顺序抖动导致 dirty 误判。
                onChange: () => apply(on ? picked.filter((candidate) => candidate !== id) : [...picked, id]),
              }),
              t(`purpose.${id}`),
            )
          }),
        ),
        h('div', { style: { fontSize: 11, color: picked.length === 0 ? T.warn : T.text3, lineHeight: 1.55 } },
          picked.length === 0 ? t('config.capabilitiesNone') : t('config.capabilitiesHint')),
      )
    }

    function EntryCard(props) {
      const { entry, index, t, onPatch, onChangeType, onRemove } = props
      const [revealed, setRevealed] = useState(false)
      const [confirmRemove, setConfirmRemove] = useState(false)

      const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : []
      /** 是否已经有内容 —— 决定这一行默认收起还是展开。 */
      const filled = entry.type === 'tool'
        ? entry.path.trim() !== '' || entry.description.trim() !== ''
        : entry.baseUrl.trim() !== '' || entry.key.trim() !== '' || entry.apiDoc.trim() !== '' || capabilities.length > 0
      /** 是否**可用** —— 只勾了能力但没填 BaseURL 的行会存下来，但 agent 拿它没法发请求。 */
      const complete = entry.type === 'tool'
        ? entry.path.trim() !== '' || entry.description.trim() !== ''
        : entry.baseUrl.trim() !== '' || entry.key.trim() !== '' || entry.apiDoc.trim() !== ''

      // 已经配置好的行默认收起（配置区一长就没法看）；刚点「添加一行」的空行默认展开，
      // 因为加完就要填。这是最省事的默认，不用再点一次。
      const [open, setOpen] = useState(!filled)

      /** 收起时的一行摘要：让人不展开也知道这行是什么。 */
      const summaryParts = entry.type === 'tool'
        ? [entry.path.trim() || entry.description.trim().slice(0, 80), t(`purpose.${entry.purpose}`)]
        : [entry.baseUrl.trim() || entry.apiDoc.trim().slice(0, 80), t('config.capabilityCount').replace('{n}', String(capabilities.length))]
      const summary = summaryParts.filter((part) => part !== '').join(' · ')

      return h(Card, { className: 'ih-card', style: { padding: '12px 14px', opacity: entry.enabled ? 1 : 0.62 } },
        h('div', { className: 'ih-row', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
          h('button', {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            title: open ? t('common.collapse') : t('common.expand'),
            'aria-expanded': open,
            style: {
              width: 22, height: 22, flexShrink: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: T.field, border: `1px solid ${T.border}`, borderRadius: 6,
              color: T.text2, fontSize: 10, lineHeight: 1, padding: 0,
            },
          }, open ? '▾' : '▸'),
          h('span', { style: { fontFamily: T.code, fontSize: 11, color: T.text3, minWidth: 18 } }, String(index + 1)),
          h('select', { value: entry.type, onChange: (event) => onChangeType(event.target.value), style: fieldStyle({ width: 'auto' }) },
            h('option', { value: 'tool' }, t('config.typeTool')),
            h('option', { value: 'mapping' }, t('config.typeMapping'))),
          h('input', {
            value: entry.name,
            onChange: (event) => onPatch({ name: event.target.value }),
            placeholder: entry.type === 'tool' ? t('config.nameTool') : t('config.nameMapping'),
            style: fieldStyle({ flex: '1 1 160px', minWidth: 0 }),
          }),
          complete ? null : h(Pill, { tone: T.warn }, t('config.incomplete')),
          h('label', { title: t('config.disabledHint'), style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12, color: T.text2, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: entry.enabled, onChange: (event) => onPatch({ enabled: event.target.checked }) }),
            t('config.enabled')),
          h('button', { type: 'button', onClick: () => setConfirmRemove(true), style: buttonStyle('danger') }, t('config.delete')),
        ),
        open
          ? [
              entry.type === 'tool'
                ? h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 } },
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.purpose')),
                      h('select', { value: entry.purpose, onChange: (event) => onPatch({ purpose: event.target.value }), style: fieldStyle({ width: 'auto' }) },
                        PURPOSES.map((id) => h('option', { key: id, value: id }, t(`purpose.${id}`))))),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.toolPath')),
                      h('input', { value: entry.path, onChange: (event) => onPatch({ path: event.target.value }), placeholder: t('config.toolPathPlaceholder'), style: fieldStyle({ fontFamily: T.code }) })),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.toolDoc')),
                      h('textarea', {
                        value: entry.description,
                        onChange: (event) => onPatch({ description: event.target.value }),
                        rows: 3,
                        placeholder: t('config.toolDocPlaceholder'),
                        style: fieldStyle({ fontFamily: T.code, lineHeight: 1.6, resize: 'vertical' }),
                      })),
                  )
                : h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 } },
                    h(CapabilityPicker, { entry, t, onPatch }),
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 240px', minWidth: 0 } },
                        h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.baseUrl')),
                        h('input', { value: entry.baseUrl, onChange: (event) => onPatch({ baseUrl: event.target.value }), placeholder: t('config.baseUrlPlaceholder'), style: fieldStyle({ fontFamily: T.code }) })),
                      h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 200px', minWidth: 0 } },
                        h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.key')),
                        h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                          h('input', {
                            value: revealed ? entry.key : maskKey(entry.key),
                            readOnly: !revealed,
                            onChange: (event) => onPatch({ key: event.target.value }),
                            placeholder: t('config.keyPlaceholder'),
                            style: fieldStyle({ fontFamily: T.code }),
                          }),
                          h('button', { type: 'button', onClick: () => setRevealed((value) => !value), style: buttonStyle('ghost') }, revealed ? t('config.hide') : t('config.reveal')))),
                    ),
                    h('div', { style: { fontSize: 11, color: T.text3 } }, t('config.keyNote')),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.apiDoc')),
                      h('textarea', {
                        value: entry.apiDoc,
                        onChange: (event) => onPatch({ apiDoc: event.target.value }),
                        rows: 3,
                        placeholder: t('config.apiDocPlaceholder'),
                        style: fieldStyle({ fontFamily: T.code, lineHeight: 1.6, resize: 'vertical' }),
                      })),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.remark')),
                      h('input', { value: entry.remark, onChange: (event) => onPatch({ remark: event.target.value }), placeholder: t('config.remarkPlaceholder'), style: fieldStyle() })),
                  ),
              h('label', { key: 'note', style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 } },
                h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.note')),
                h('input', { value: entry.note, onChange: (event) => onPatch({ note: event.target.value }), placeholder: t('config.notePlaceholder'), style: fieldStyle() })),
            ]
          : h('div', {
              onClick: () => setOpen(true),
              title: t('common.expand'),
              style: {
                marginTop: 6, cursor: 'pointer', fontSize: 12, color: T.text3,
                fontFamily: T.code, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              },
            }, summary === '' ? t('config.summaryEmpty') : summary),
        confirmRemove ? h(Modal, { title: t('config.deleteRowTitle').replace('{name}', entry.name || '—'), onClose: () => setConfirmRemove(false), t },
          h('div', { style: { fontSize: 13, color: T.text, lineHeight: 1.75 } }, t('config.deleteRowBody')),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
            h('button', { type: 'button', onClick: () => setConfirmRemove(false), style: buttonStyle('ghost') }, t('common.cancel')),
            h('button', { type: 'button', onClick: () => { setConfirmRemove(false); onRemove() }, style: buttonStyle('danger') }, t('config.delete')),
          ),
        ) : null,
      )
    }

    function ConfigArea(props) {
      const { t } = props
      const [saved, setSaved] = useState([])
      const [draft, setDraft] = useState([])
      const [updatedAt, setUpdatedAt] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [confirmReset, setConfirmReset] = useState(false)

      const load = useCallback(async () => {
        try {
          const payload = await api('/config')
          const entries = payload.config?.entries ?? []
          setSaved(entries)
          setDraft(entries.map((entry) => ({ ...entry })))
          setUpdatedAt(payload.config?.updatedAt ?? '')
          setError('')
        } catch (cause) {
          setError(describe(cause))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const dirty = stableJson(draft) !== stableJson(saved)

      const patch = (id, changes) => {
        setDraft((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)))
      }

      const changeType = (id, type) => {
        setDraft((prev) => prev.map((entry) => {
          if (entry.id !== id || entry.type === type) return entry
          const base = { id: entry.id, type, name: entry.name, enabled: entry.enabled, note: entry.note }
          if (type === 'tool') {
            // 多选收成单选：沿用它勾的第一个能力，没有就 other。
            const inherited = Array.isArray(entry.capabilities) && entry.capabilities.length > 0 ? entry.capabilities[0] : 'other'
            return { ...base, type: 'tool', purpose: inherited, path: '', description: '' }
          }
          // 单选摊成多选：把原来那一个用途当作唯一勾选（other 不算一种能力）。
          const seeded = entry.purpose === undefined || entry.purpose === 'other' ? [] : [entry.purpose]
          return {
            ...base,
            type: 'mapping',
            capabilities: CAPABILITIES.filter((candidate) => seeded.includes(candidate)),
            baseUrl: '',
            key: '',
            apiDoc: '',
            remark: '',
          }
        }))
      }

      const save = async () => {
        setBusy(true)
        try {
          const payload = await api('/config', { method: 'POST', body: { entries: draft } })
          const entries = payload.config?.entries ?? []
          setSaved(entries)
          setDraft(entries.map((entry) => ({ ...entry })))
          setUpdatedAt(payload.config?.updatedAt ?? '')
          notify(t('toast.saved'), 'info')
        } catch (cause) {
          notify(t('toast.saveFailed').replace('{message}', describe(cause)))
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        setConfirmReset(false)
        setBusy(true)
        try {
          const payload = await api('/config', { method: 'POST', body: { entries: [] } })
          const entries = payload.config?.entries ?? []
          setSaved(entries)
          setDraft(entries.map((entry) => ({ ...entry })))
          setUpdatedAt(payload.config?.updatedAt ?? '')
          notify(t('toast.cleared'), 'info')
        } catch (cause) {
          notify(t('toast.clearFailed').replace('{message}', describe(cause)))
        } finally {
          setBusy(false)
        }
      }

      const toolCount = draft.filter((entry) => entry.type === 'tool').length
      const mappingCount = draft.length - toolCount

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(Card, { style: { padding: '12px 14px' } },
          h(SectionHeader, {
            title: t('config.title'),
            hint: `${t('config.hint')} · ${t('config.typeTool')} ${toolCount} / ${t('config.typeMapping')} ${mappingCount}${updatedAt === '' ? '' : ` · ${new Date(updatedAt).toLocaleString()}`}`,
            extra: [
              dirty ? h(Pill, { key: 'd', tone: T.warn }, t('config.dirty')) : null,
              h('button', { key: 'r', type: 'button', disabled: busy || !dirty, onClick: () => setDraft(saved.map((entry) => ({ ...entry }))), style: buttonStyle('ghost', busy || !dirty) }, t('config.revert')),
              h('button', { key: 's', type: 'button', disabled: busy, onClick: () => void save(), style: buttonStyle('primary', busy) }, busy ? t('config.saving') : t('config.save')),
              h('button', { key: 'c', type: 'button', disabled: busy || saved.length === 0, onClick: () => setConfirmReset(true), style: buttonStyle('danger', busy || saved.length === 0) }, t('config.reset')),
            ],
          }),
          error === '' ? null : h('div', { style: { marginTop: 8, fontSize: 12, color: T.error, lineHeight: 1.6 } }, t('state.failed').replace('{message}', error)),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
            h('button', { type: 'button', onClick: () => setDraft((prev) => [...prev, blankEntry('tool')]), style: buttonStyle('ghost') }, t('config.addTool')),
            h('button', { type: 'button', onClick: () => setDraft((prev) => [...prev, blankEntry('mapping')]), style: buttonStyle('ghost') }, t('config.addMapping')),
          ),
        ),
        draft.length === 0
          ? h(EmptyState, { title: t('config.empty'), hint: t('config.emptyHint') })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              draft.map((entry, index) => h(EntryCard, {
                key: entry.id,
                entry,
                index,
                t,
                onPatch: (changes) => patch(entry.id, changes),
                onChangeType: (type) => changeType(entry.id, type),
                onRemove: () => setDraft((prev) => prev.filter((row) => row.id !== entry.id)),
              })),
            ),
        confirmReset ? h(Modal, { title: t('config.resetTitle'), onClose: () => setConfirmReset(false), t },
          h('div', { style: { fontSize: 13, color: T.text, lineHeight: 1.75 } }, t('config.resetBody')),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
            h('button', { type: 'button', onClick: () => setConfirmReset(false), style: buttonStyle('ghost') }, t('common.cancel')),
            h('button', { type: 'button', onClick: () => void reset(), style: buttonStyle('danger') }, t('config.confirmReset')),
          ),
        ) : null,
      )
    }

    // ── 会话预设门控 ────────────────────────────────────────────────────────

    /** 只警告一次（每次渲染都刷一条会把控制台淹掉）。 */
    const warned = new Set()
    function warnOnce(key, message, value) {
      if (warned.has(key)) return
      warned.add(key)
      console.warn(`[infohunter] ${message}`, value)
    }

    /**
     * 哨兵：渲染 `null`，唯一的职责是把"当前会话用没用本预设"喂回去。
     *
     * ## 为什么需要这么个东西
     *
     * `conversation.view` 是**全局** slot：注册一次，每个会话都会多出一个标签页。
     * 而浏览器半**没有任何服务能告诉你当前是哪个会话** —— `ctx.sessions` 只有
     * `retainInfo`/`binding`/`scope` 这些按 id 的接口，没有列表，也没有"当前"。
     * 当前会话的 id 与投影只通过 slot 组件的 props 下发，所以只能由一个挂在
     * 永远存在的会话级 slot 上的组件去读，再回头改 view 的注册。
     *
     * 挂在 `conversation.composer.dock`（list / scope=session / replaceRisk=none）：
     * 它是 composer 下方的环境条目，渲染 `null` 就什么都不占。
     *
     * ## 为什么用 `useSessions` 而不是 `useProjection('agentPreset')`
     *
     * `agentPreset` 投影的值是 `string | null`（`dsh-agent-preset-registry` 里
     * `agentPresetSchema = string | null`）。而官方客户端自己读这个投影用的就是
     * `useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset)`
     * —— 见 `dsh-client-ui-agent-preset` 的会话头标签。照抄官方那条路径，比赌
     * `faceOf('agentPreset')` 也挂在 keyed projection face 上安全。
     */
    function PresetWatcher(props) {
      const sessionId = props.sessionId
      // `useSessions` 是这个 slot 的标准 prop。万一取不到就退化成"永远读不到"，
      // 而不是在这里抛错 —— 那会连带把输入区弄坏。
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
      const raw = useSessions((state) => state?.byId?.[sessionId]?.projectionValues?.agentPreset)
      const preset = typeof raw === 'string' ? raw : undefined
      const matched = preset === PRESET_ID

      useEffect(() => {
        if (typeof props.useSessions !== 'function') {
          warnOnce('no-use-sessions', '这个 slot 的 props 里没有 useSessions，无法判断会话预设；面板不会显示。')
        } else if (preset === undefined && raw !== null && raw !== undefined) {
          warnOnce('odd-projection', 'agentPreset 投影值既不是字符串也不是 null，无法判断会话预设；面板不会显示。原值：', raw)
        }
        props.onChange(matched)
        // 刻意**不**在卸载时撤销。
        //
        // 如果会话切换导致这个哨兵重挂载，撤销会先把正在显示的那个 view 拿掉 ——
        // 而 view 被撤掉时界面的活动标签会退回第一个（Chat），再注册回来也恢复不了。
        // 留给下一次上报自我纠正：新会话的哨兵一挂上就会推回它自己的判断。
      }, [matched])

      return null
    }

    // ── 主视图 ──────────────────────────────────────────────────────────────

    /**
     * 面板主视图。
     *
     * @param {object} props - 框架注入的会话标准件 + `clientCtx` + `t`。
     */
    function HunterView(props) {
      const t = props.t
      const sessionId = props.sessionId === undefined || props.sessionId === null ? '' : String(props.sessionId)
      const [area, setArea] = useState('assets')
      const [syncedAt, setSyncedAt] = useState(0)
      const [info, setInfo] = useState({ version: '', onDisk: '' })

      // 版本从宿主读，不手写：面板显示的就是实际装进去的那一份清单里的版本。
      // `onDisk` 是磁盘上的现读值 —— 与已加载模块的版本不同，就说明装过新版但还没重启。
      useEffect(() => {
        let alive = true
        api('/version').then(
          (payload) => {
            if (!alive) return
            setInfo({ version: String(payload?.version ?? ''), onDisk: String(payload?.onDisk ?? '') })
          },
          () => { /* 版本取不到不影响使用 */ },
        )
        return () => { alive = false }
      }, [])

      // 两种"你看到的不是最新的"：模块旧（要重启）／页面旧（要刷新）。重启是更根本的那个，优先提示。
      const loaded = info.version
      const moduleStale = loaded !== '' && info.onDisk !== '' && info.onDisk !== loaded
      const clientStale = loaded !== '' && loaded !== CLIENT_VERSION
      const stale = moduleStale || clientStale
      const versionLabel = loaded === '' ? '' : `v${loaded}`
      const versionBadge = moduleStale
        ? t('view.moduleStaleBadge').replace('{disk}', info.onDisk)
        : clientStale ? t('view.staleBadge') : ''
      const versionHint = moduleStale
        ? t('view.moduleStale').replace('{loaded}', loaded).replace('{disk}', info.onDisk)
        : clientStale
          ? t('view.staleClient').replace('{client}', CLIENT_VERSION).replace('{host}', loaded)
          : t('view.versionHint').replace('{version}', loaded)

      return h('section', {
        'data-testid': 'infohunter-view',
        // `className` 上的规则见下面的 <style>：这是一个 flex item，默认 `min-width: auto`
        // 会让它拒绝缩到内容宽度以下（卡片网格 + 长端点），拖动 DSH 的侧边界时就会顶出去。
        className: 'ih-panel',
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.bg, color: T.text },
      },
        h(NoticeStack),
        h('style', null, [
          '.ih-btn:hover:not(:disabled){filter:brightness(.97)}',
          // 面板必须能被父容器压窄：任何一层都不能靠内容撑宽度。
          '.ih-panel,.ih-panel *{box-sizing:border-box}',
          '.ih-panel{min-width:0;width:100%;max-width:100%;overflow:hidden}',
          '.ih-panel input,.ih-panel select,.ih-panel textarea{min-width:0!important;max-width:100%}',
          '.ih-panel .ih-row{min-width:0;max-width:100%}',
          '.ih-panel .ih-card{min-width:0;overflow:hidden}',
          '.ih-panel .ih-break{overflow-wrap:anywhere;word-break:break-word}',
          // 内容盒与 DSH 对话列**同一个框**：那一列两侧有可拖动的把手，
          // `--dsh-chat-content-width` 就是它们的当前值（`.body` 上定义，会继承到 `.viewArea`）。
          // 左右**不加**内边距 —— 面板边缘就贴在对话列边缘上，齐平但不越过（宽度也不会超过它）。
          '.ih-panel .ih-inner{width:100%;max-width:var(--dsh-chat-content-width,920px);margin:0 auto;min-width:0}',
          '.ih-panel .ih-navinner{width:100%;max-width:var(--dsh-chat-content-width,920px);margin:0 auto;'
            + 'display:flex;gap:2px;align-items:center;min-width:0}',
          // 兜底：任何一行都不许横向超出内容盒。
          '.ih-panel .ih-body,.ih-panel .ih-inner{overflow-x:hidden}',
          '.ih-panel .ih-asset,.ih-panel .ih-rec{max-width:100%}',
          // 密集列表：一行一条，窄了按列退让，而不是把面板撑开。
          '.ih-panel .ih-list{border:1px solid ' + T.border + ';border-radius:' + T.radius + 'px;overflow:hidden;background:' + T.card + '}',
          '.ih-panel .ih-asset{display:grid;align-items:center;gap:10px;padding:6px 10px;min-width:0;'
            + 'grid-template-columns:minmax(0,2.6fr) 54px 74px minmax(0,1.5fr) minmax(0,1.2fr)}',
          '.ih-panel .ih-asset + .ih-asset{border-top:1px solid ' + T.border + '}',
          '.ih-panel .ih-head{font-size:11px;color:' + T.text3 + ';background:' + T.card + ';padding:5px 10px;'
            + 'border-bottom:1px solid ' + T.border + ';font-family:' + T.code + ';letter-spacing:.2px;text-transform:lowercase}',
          '.ih-panel .ih-rec{display:grid;align-items:center;gap:10px;padding:6px 10px;min-width:0;'
            + 'grid-template-columns:56px auto minmax(0,1.3fr) minmax(0,1fr) 22px}',
          '.ih-panel .ih-rec + .ih-rec{border-top:1px solid ' + T.border + '}',
          '.ih-panel .ih-rec-detail{grid-column:1/-1}',
          '@media (max-width:780px){'
            + '.ih-panel .ih-asset{grid-template-columns:minmax(0,2.2fr) 52px 70px minmax(0,1.5fr)}'
            + '.ih-panel .ih-asset .ih-col-meta{display:none}'
            + '.ih-panel .ih-rec{grid-template-columns:52px auto minmax(0,1.4fr) 22px}'
            + '.ih-panel .ih-rec > :nth-child(4){display:none}}',
          '@media (max-width:560px){'
            + '.ih-panel .ih-asset{grid-template-columns:minmax(0,1.8fr) 52px 70px}'
            + '.ih-panel .ih-asset .ih-col-title{display:none}}',
        ].join('')),
        h('nav', {
          style: {
            flexShrink: 0, display: 'flex', alignItems: 'center', padding: 0, background: T.card,
            borderBottom: `1px solid ${T.border}`, position: 'sticky', top: 0, zIndex: 20, minWidth: 0, overflow: 'hidden',
          },
        },
          h('div', { className: 'ih-navinner' },
          [['assets', t('tab.assets')], ['records', t('tab.records')], ['config', t('tab.config')]].map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            onClick: () => setArea(id),
            style: {
              padding: '11px 12px', cursor: 'pointer', border: 'none', background: 'transparent', whiteSpace: 'nowrap',
              flexShrink: 0,
              fontSize: 13, fontWeight: area === id ? 700 : 500,
              color: area === id ? T.brand : T.text2,
              borderBottom: area === id ? `2px solid ${T.brand}` : '2px solid transparent',
            },
          }, label)),
          // 右侧：刷新时间在版本号左边，中间留出间隔。
          h('div', {
            key: 'meta',
            style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0, minWidth: 0 },
          },
            syncedAt === 0 ? null : h('span', {
              key: 'sync',
              title: t('view.syncedHint'),
              style: { fontSize: 11, color: T.text3, fontFamily: T.code, whiteSpace: 'nowrap' },
            }, t('state.readAt').replace('{time}', new Date(syncedAt).toLocaleTimeString())),
            versionLabel === '' ? null : h('span', {
              key: 'version',
              title: versionHint,
              'data-testid': 'infohunter-version',
              style: {
                flexShrink: 0, fontFamily: T.code, fontSize: 11, letterSpacing: 0.2,
                color: stale ? T.warn : T.text3, whiteSpace: 'nowrap', userSelect: 'text',
                padding: '2px 6px', borderRadius: 6,
                border: `1px solid ${stale ? tint(T.warn, 0.45) : 'transparent'}`,
                background: stale ? tint(T.warn, 0.1) : 'transparent',
              },
            }, versionBadge === '' ? versionLabel : `${versionLabel} · ${versionBadge}`),
          ),
          ),
        ),
        h('div', { className: 'ih-body', style: { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' } },
          h('div', { className: 'ih-inner', style: { padding: '14px 0 28px' } },
            sessionId === ''
              ? h(EmptyState, { title: t('state.notThisPreset'), hint: t('state.connecting') })
              : [
                  // 三个区域都保持挂载：切走再切回保留滚动位置、筛选条件与未保存的编辑。
                  // 不活跃的一侧只隐藏，并把 `active` 传下去让它停掉轮询。
                  h('div', { key: 'a', style: { display: area === 'assets' ? 'block' : 'none' } },
                    h(AssetsArea, { t, sessionId, active: area === 'assets', onSynced: setSyncedAt, openExternalLink: props.openExternalLink })),
                  h('div', { key: 'r', style: { display: area === 'records' ? 'block' : 'none' } },
                    h(RecordsArea, { t, sessionId, active: area === 'records' })),
                  h('div', { key: 'c', style: { display: area === 'config' ? 'block' : 'none' } },
                    h(ConfigArea, { t })),
                ],
          ),
        ),
      )
    }

    // ── 客户端插件 ──────────────────────────────────────────────────────────

    return {
      inject: ['slots'],

      /**
       * @param {object} ctx - 浏览器半的 Cordis 上下文。
       */
      apply(ctx) {
        // 文案：优先走 Client locale 服务（注册两套词典后 bind 出 t）；服务缺失就用内置中文表。
        //
        // 这里**不能**只在 apply 时 `ctx.get('locale')` 取一次：浏览器半的插件激活顺序也不由我们控制，
        // locale 万一晚到，整个面板就会永久停在中文。所以 `t` 是**惰性**的 —— 每次渲染现查一次，
        // 服务一出现就自动切换，不需要用户重启或刷新。
        let bound
        let registered = false
        const t = (key) => {
          if (!registered) {
            registered = true
            const locale = ctx.get('locale')
            if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
              try {
                locale.register('infohunter', 'zh', ZH)
                locale.register('infohunter', 'en', EN)
                bound = locale.bind('infohunter')
              } catch (error) {
                console.warn('[infohunter] locale 注册失败，使用内置文案：', error)
              }
            }
          }
          if (typeof bound === 'function') {
            try {
              const value = bound(key)
              if (typeof value === 'string' && value !== '') return value
            } catch {
              /* 交给下面的兜底 */
            }
          }
          return ZH[key] ?? key
        }

        const VIEW_ID = 'infohunter'
        const WATCH_ID = 'infohunter-watch'
        const label = () => t('view.label')

        /**
         * `ours`：当前会话是否用着本预设；`undefined` = 还不知道。
         * `declared`：`conversation.view` 是否已声明 —— 声明就绪前注册会被丢掉。
         */
        let ours
        let declared = false
        let disposeView

        /**
         * 只有**明确读到属于本预设**才注册标签页。
         *
         * 上一版是"读不到就无条件注册"，于是每个会话都多一个标签页。根因是门控读的
         * `ctx.sessions.list` **根本不存在**（浏览器半没有会话列表服务，那是 0.1.x 的记忆），
         * 所以门控分支从来没走过，永远落到兜底。现在反过来：读不到就不显示，并打一条日志。
         */
        const syncView = () => {
          const wanted = declared && ours === true
          if (!wanted) {
            if (disposeView !== undefined) {
              try { disposeView() } catch { /* 已卸载 */ }
              disposeView = undefined
            }
            return
          }
          if (disposeView === undefined) {
            disposeView = ctx.slots.register({
              name: 'conversation.view', id: VIEW_ID, order: 20, label,
            }, (props) => h(HunterView, { ...props, t }))
          }
        }

        // view 声明：唯一能安全注册 `conversation.view` 的时机。
        ctx.effect(
          () => ctx.slots.inject('conversation.view', () => {
            declared = true
            syncView()
            return () => {
              declared = false
              try { disposeView?.() } catch { /* 已销毁 */ }
              disposeView = undefined
            }
          }),
          'infohunter.viewGate',
        )

        // 哨兵：读当前会话的预设，回来驱动 view 的注册。
        ctx.effect(
          () => ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: WATCH_ID, order: 900 },
              (props) => h(PresetWatcher, {
                ...props,
                onChange: (matched) => {
                  ours = matched
                  syncView()
                },
              }),
            )),
          'infohunter.presetWatcher',
        )
      },
    }
  },
})
