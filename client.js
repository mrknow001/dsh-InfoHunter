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
    const CLIENT_VERSION = '0.16.0'

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

    /**
     * 数据「形态」id —— 与宿主 `vocabulary.js` 的 SHAPES 同序同值。
     *
     * 浏览器半与宿主半是两套模块系统，不能共享 ES 模块，所以这里复制一份 id 表；
     * 标签走 locale（`shape.<id>`）。**改一边必须改另一边**，否则勾了存不进去。
     */
    const SHAPES = [
      'org_short', 'org_full', 'credit_code', 'icp',
      'main_domain', 'subdomain', 'domain', 'ip', 'cidr',
      'port', 'endpoint', 'url', 'protocol', 'service', 'banner', 'status',
      'title', 'tech', 'cert', 'email', 'credential', 'source_code', 'shot', 'other',
    ]

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
      'tab.artifacts': '信息产物',
      'tab.records': '采集记录',
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
      'results.filteredHint': '共 {total} 条，当前条件没有命中。换一个语法，或点「清空搜索」。',
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
      'config.addSkill': '＋ 添加一行技能（zip）',
      'config.addMcp': '＋ 添加一行 MCP',
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
      'config.typeSkill': '技能',
      'config.typeMcp': 'MCP',
      'config.mcpTransport': '传输',
      'config.mcpCommand': '命令（可执行文件）',
      'config.mcpCommandPlaceholder': '如 npx 或 C:\\Tools\\server.exe',
      'config.mcpUrl': '服务地址',
      'config.mcpUrlPlaceholder': '如 https://example.com/mcp',
      'config.mcpArgs': '参数（一行一个）',
      'config.mcpArgsPlaceholder': '-y\n@modelcontextprotocol/server-filesystem\nC:\\data',
      'config.mcpEnv': '环境变量（KEY=VALUE，一行一个）',
      'config.mcpEnvPlaceholder': 'API_KEY=xxx\nDEBUG=1',
      'config.mcpCwd': '工作目录（可空）',
      'config.mcpCwdPlaceholder': '留空则用 DSH 的目录',
      'config.mcpHeaders': '请求头（KEY=VALUE，一行一个）',
      'config.mcpHeadersPlaceholder': 'Authorization=Bearer xxx',
      'config.mcpHint': '列表名会成为工具名前缀（mcp__<名字>__<工具>）。保存后立刻连接：连上的 server 会把工具直接交给模型，连不上只影响它自己。',
      'config.nameSkill': '显示名（如 内网渗透手法）',
      'config.nameMcp': 'server 名（会进工具名 mcp__<名字>__<工具>，用英文）',
      'config.skillPick': '选择技能 zip',
      'config.skillReplace': '重新上传（覆盖）',
      'config.skillBusy': '上传中…',
      'config.skillHint': 'zip 根目录必须带 SKILL.md（frontmatter 要有 name 与 description）。上传即解压到插件目录，只有用这个预设的会话能看到它。',
      'config.skillNone': '还没有上传技能包 —— 这个技能对模型不可见。',
      'config.skillMeta': '{files} 个文件 / {bytes} 字节',
      'config.skillScope': '作用域：本预设（其他预设的会话读不到）。删掉这一行并保存，落地的文件也会被回收。',
      'config.name': '名称',
      'config.nameTool': '工具名（如 subfinder）',
      'config.nameMapping': '平台名（如 FOFA）',
      'config.purpose': '这一行是做什么的',
      'config.capabilities': '这个平台能出哪些数据（可多选）',
      'config.capabilitiesHint': '勾选它一次查询能返回的数据种类。空间测绘是综合查询，一次往往同时出域名、IP、端口、协议、标题、指纹、证书 —— 模型据此判断缺某类数据该问哪个平台。',
      'config.capabilitiesNone': '未勾选任何数据种类 —— 模型只能先读 API 说明自己判断',
      'config.capabilityCount': '{n} 项能力',
      'config.inputs': '输入：这行吃什么（可多选）',
      'config.outputs': '输出：这行吐什么（可多选）',
      'config.shapesHint': '勾选它能接收 / 产出的数据形态。形态是工具之间的接插件：A 的输出命中 B 的输入，agent 就会把 A 的结果直接喂给 B —— 它不需要认识这个工具，也不会瞎猜参数。',
      'config.shapesNone': '未声明 —— agent 只能从说明里推断，推断不出就会来问你',
      'config.shapeOther': '其他（自己写）',
      'config.shapeOtherPlaceholder': '上面都不像时，用一句话写清它吃/吐什么',
      'config.shapesDeclared': '输入 {i} / 输出 {o}',
      'config.inputMode': '条件关系',
      'config.modeOr': '或（任一即可）',
      'config.modeAnd': '与（需同时）',
      'config.modeCustom': '其他（自己说明）',
      'config.modeCustomPlaceholder': '例：主域名单独可用；域名 + IP 需组合；C 段单独可用',
      'config.modeCustomNone': '关系还没写 —— agent 缺输入时会来问你，而不是猜',
      'config.modeIdle': '（只勾了一个输入时不起作用）',
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
      'toast.skillUploaded': '技能「{name}」已落地，本预设的会话立刻可用。',
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
      'purpose.domain': '域名与解析',
      'purpose.endpoint': '端口与服务',
      'purpose.system': '系统与路径',
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
      'verdict.suspect': '可疑',
      'verdict.infer': '推测',
      'verdict.suspectHint': '观测到了，但不确定算不算真资产：拦截页、默认页、停放页、泛解析产生的假子域、未经真实响应验证的 host 碰撞。',
      'verdict.inferHint': '没有直接观测，靠推理链得出：证书 SAN 同组织、CNAME 指向 CDN 所以「应该是托管」。',
      'card.expand': '详情',
      'card.collapse': '收起',
      'card.sameHost': '本页另有 {n} 个端点同 host',
      'view.app': '系统',
      'view.endpoint': '端点',
      'view.host': '主机资产',
      'view.web': 'Web资产',
      'view.hint': '主机 {endpoints} · Web {systems}',
      'hostChip.all': '全部',
      'hostChip.http': 'http/https',
      'hostChip.sql': 'sql',
      'hostChip.ssh': 'ssh',
      'hostChip.ftp': 'ftp',
      'hostChip.telnet': 'telnet',
      'hostChip.smb': 'smb',
      'hostChip.rdp': 'rdp',
      'webChip.all': '全部',
      'rail.groupProto': '按协议',
      'rail.groupStatus': '按状态码',
      'rail.groupPath': '按路径 / 指纹',
      'results.searchPlaceholderHost': '语法：protocol~sql AND port=3306，或 host~example.com',
      'results.searchPlaceholderWeb': '语法：status=200 AND title~后台，或 path~/admin/',
      'card.systemBadge': '系统',
      'card.root': '根路径',
      'card.noPort': '缺端口',
      'card.noPortHint': '这条记录声明了 Web，却没有端口 —— 采集时漏了，写成 host:端口 才能补全。',
      'card.dead': '失效',
      'card.deadHint': '上次验证时连不上 / 无法访问 —— 数据保留，只标记失效。',
      'card.noIp': '缺 IP',
      'card.noIpHint': '有端口但没记解析 IP —— 工具输出里通常有，补记一条即可。',
      'card.rootHint': '这个 Web 资产是由端点自动派生的根路径（不是模型显式登记的系统入口）。',
      'card.systemBadgeHint': '一个系统 = 端点 + 根路径。同端点下的不同应用是两个系统。',
      'card.unresolved': '待确认',
      'card.unresolvedHint': '与同端点的另一个入口只命中一项证据，判定不了 —— 去「待确认」里裁决。',
      'card.merged': '已合并 {n}',
      'card.mergedHint': '已确认与其他入口是同一个系统，可展开拆回。',
      'detail.urls': 'URL',
      'detail.emptyUrls': '这个系统还没有 URL 证据。',
      'questions.title': '待确认 {n} 条',
      'questions.hint': '这些入口可能属于同一个系统，但证据只够命中一项。合并是可逆的 —— 合并后还能拆开。',
      'questions.merge': '合并',
      'questions.keep': '保持分开',
      'questions.dismiss': '先不管',
      'questions.more': '还有 {n} 条没显示',
      'plan.stages': '阶段',
      'plan.current': '当前',
      'plan.allDone': '全部完成',
      'plan.coverage': '覆盖',
      'plan.gap': '未覆盖 {n}（共 {total}）',
      'plan.gapHint': '按资产 × 证据层统计；未覆盖数量是截断后的展示。',
      'results.emptyApp': '当前没有系统级记录 —— 让 agent 按 URL + basePath 记录系统，或切到「端点」视角看已有资产。',
      // ── 信息产物 ────────────────────────────────────────────────────────
      'artifact.all': '全部',
      'artifact.kind.cloud': '云资源',
      'artifact.kind.leak': '泄露物',
      'artifact.kind.api_doc': '接口文档',
      'artifact.kind.credential': '凭据',
      'artifact.kind.package': '安装包',
      'artifact.kind.other': '其他',
      'artifact.sev.high': '高',
      'artifact.sev.medium': '中',
      'artifact.sev.low': '低',
      'artifact.hits': '命中',
      'artifact.count': '重复 {n} 次',
      'artifact.searchPlaceholder': '按标题 / 内容 / 来源 / 发现方式过滤',
      'artifact.empty': '还没有信息产物',
      'artifact.emptyHint': '云资源、泄露物、API 文档、凭据、安装包都会记在这里。让 agent 用 expose_artifact 记录。',
      'artifact.filtered': '没有匹配的产物',
      'artifact.filteredHint': '共 {total} 条，当前条件没命中。',
      'artifact.kindLabel': '类型',
      'artifact.source': '来源',
      'artifact.howFound': '如何发现',
      'artifact.url': 'URL',
      'artifact.host': '关联主机',
      'artifact.rules': '命中规则',
      'artifact.content': '产物内容',
      'artifact.reveal': '显示原文',
      'artifact.hide': '打码',
      'settings.open': '设置',
      'settings.title': '信息产物设置',
      'settings.hint': '敏感信息正则：写入产物时自动扫描，命中的片段会打标。规则越准，噪声越少。',
      'settings.enabled': '启用浏览web资产采集',
      'settings.rules': '规则',
      'settings.ruleName': '名称',
      'settings.rulePattern': '正则',
      'settings.addRule': '新增规则',
      'settings.reset': '恢复默认',
      'settings.test': '测试',
      'settings.testPlaceholder': '粘一段文本，看会被哪些规则命中',
      'settings.testHit': '命中：{names}',
      'settings.testNone': '没有命中任何规则',
      'settings.rescan': '按当前规则重扫',
      'settings.rescanned': '已重扫 {n} 条',
      'settings.save': '保存',
      'field.ip': 'IP',
      'field.port': '端口',
      'field.protocol': '协议',
      'field.status': '状态',
      'field.category': '类型',
      'field.fingerprint': '组件',
      'field.sources': '来源',
      'field.lastSeen': '最近',
      'detail.cert': '证书',
      'detail.headers': '响应头',
      'detail.body': '正文',
      'detail.relations': '关联域名·IP',
      'detail.hasData': '已采集',
      'detail.noData': '未采集',
      'detail.subject': '主体',
      'detail.issuer': '签发者',
      'detail.notAfter': '到期',
      'detail.emptyCert': '未采集到证书 —— 该端点没有 TLS，或模型没有提交 cert 字段。',
      'detail.emptyHeaders': '未记录原始响应。已知：status={status}，server={server}，tech={tech}。',
      'detail.headersRaw': '响应头原文',
      'detail.banner': 'Banner',
      'detail.emptyBody': '未提交正文 —— 采集时要带上 body（去掉标签的可读文本）才会出现在这里。',
      'detail.bodyLength': '{n} 字',
      'detail.loading': '正在读取关联…',
      'rel.currentHint': '以下是**当前**这条资产知道的（来自结构化字段，不是推断）：',
      'rel.ip': '本端点 IP',
      'rel.cname': 'CNAME',
      'rel.noIp': '未记录 IP —— 采集时没有把解析结果写进 ip 字段。',
      'rel.sameIp': '同 IP 的其他端点',
      'rel.sameIpPorts': '同 IP 端口',
      'rel.sameIpDomains': '同 IP 域名',
      'rel.sameCname': '同 CNAME',
      'rel.certSan': '证书 SAN 里的域名',
      'rel.sameHost': '同 host 的其他端口',
      'rel.sameHostPorts': '同 host 端口',
      'rel.history': '历史',
      'rel.none': '暂无其他关联。',
      'rel.expand': '展开其余 {n} 个',
      'rel.collapse': '收起',
      'rel.copied': '已复制 {text}',
      'rel.copyFailed': '复制失败，请手动选中',
      'rel.historyHint': '采集当时的观测，不代表现在的解析结果；只有结构化写过 IP 的才显示 IP。',
      'rel.historyEmpty': '没有更早的历史记录。',
      'rel.notFound': '这条资产在库里找不到了（可能已被新数据覆盖）。',
      'rail.title': '过滤语句',
      'rail.recent': '最近使用',
      'rail.recentEmpty': '还没用过语句 —— 应用一次查询就会出现在这里。',
      'rail.clear': '清空',
      'rail.forgetCurrent': '删除当前这条',
      'rail.count': '用过 {n} 次',
      'rail.builtin': '内置常用',
      'rail.groupCheck': '排查',
      'rail.groupWeb': 'Web',
      'rail.groupService': '服务',
      'rail.groupCert': '证书',
      'rail.groupVerdict': '判定',
      'shape.org_short': '单位简称',
      'shape.org_full': '单位全称',
      'shape.credit_code': '统一社会信用代码',
      'shape.icp': '备案号',
      'shape.main_domain': '主域名',
      'shape.subdomain': '子域名',
      'shape.domain': '域名',
      'shape.ip': 'IP',
      'shape.cidr': 'C 段 / IP 段',
      'shape.port': '端口',
      'shape.endpoint': 'host:port',
      'shape.url': 'URL',
      'shape.protocol': '协议',
      'shape.service': '服务与版本',
      'shape.banner': 'banner',
      'shape.status': '状态码',
      'shape.title': '标题',
      'shape.tech': '指纹',
      'shape.cert': '证书',
      'shape.email': '邮箱',
      'shape.credential': '账号密码',
      'shape.source_code': '源码',
      'shape.shot': '截图',
      'shape.other': '其他',
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
      'tab.artifacts': 'Artifacts',
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
      'results.filteredHint': 'Nothing matched ({total} assets in total). Try another query, or clear the search.',
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
      'config.addSkill': '+ Add skill row (zip)',
      'config.addMcp': '+ Add MCP row',
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
      'config.typeSkill': 'Skill',
      'config.typeMcp': 'MCP',
      'config.mcpTransport': 'Transport',
      'config.mcpCommand': 'Command (executable)',
      'config.mcpCommandPlaceholder': 'e.g. npx or C:\\Tools\\server.exe',
      'config.mcpUrl': 'Server URL',
      'config.mcpUrlPlaceholder': 'e.g. https://example.com/mcp',
      'config.mcpArgs': 'Arguments (one per line)',
      'config.mcpArgsPlaceholder': '-y\n@modelcontextprotocol/server-filesystem\nC:\\data',
      'config.mcpEnv': 'Environment (KEY=VALUE, one per line)',
      'config.mcpEnvPlaceholder': 'API_KEY=xxx\nDEBUG=1',
      'config.mcpCwd': 'Working directory (optional)',
      'config.mcpCwdPlaceholder': 'Leave empty to use the DSH working directory',
      'config.mcpHeaders': 'Headers (KEY=VALUE, one per line)',
      'config.mcpHeadersPlaceholder': 'Authorization=Bearer xxx',
      'config.mcpHint': 'The row name becomes the tool prefix (mcp__<name>__<tool>). Saving connects immediately: a reachable server hands its tools straight to the model, and a failing one only affects itself.',
      'config.nameSkill': 'Display name (e.g. internal pentest playbook)',
      'config.nameMcp': 'Server name (becomes the tool prefix mcp__<name>__<tool>; use ASCII)',
      'config.skillPick': 'Choose skill zip',
      'config.skillReplace': 'Re-upload (overwrite)',
      'config.skillBusy': 'Uploading…',
      'config.skillHint': 'The zip must contain SKILL.md at its root, with name and description in the front matter. Uploading extracts it into the plugin directory; only sessions using this preset can see it.',
      'config.skillNone': 'No skill package uploaded yet — the model cannot see this skill.',
      'config.skillMeta': '{files} files / {bytes} bytes',
      'config.skillScope': 'Scope: this preset only (sessions of other presets cannot read it). Delete this row and save to reclaim the extracted files.',
      'config.name': 'Name',
      'config.nameTool': 'Tool name (e.g. subfinder)',
      'config.nameMapping': 'Platform (e.g. FOFA)',
      'config.purpose': 'What this row is for',
      'config.capabilities': 'What this platform can return (multi-select)',
      'config.capabilitiesHint': 'Check the data kinds one query can return. Cyberspace mapping is a combined search — one query often yields hosts, IPs, ports, protocols, titles, fingerprints and certificates — so the agent can tell which platform answers which gap.',
      'config.capabilitiesNone': 'Nothing checked — the agent has to judge from the API note',
      'config.capabilityCount': '{n} kinds',
      'config.inputs': 'Inputs — what this row consumes (multi-select)',
      'config.outputs': 'Outputs — what this row produces (multi-select)',
      'config.shapesHint': 'Check the data shapes it accepts and produces. Shapes are the connector between tools: when A\'s output matches B\'s input, the agent feeds A\'s result straight into B — it does not need to know the tool, and it will not guess arguments.',
      'config.shapesNone': 'Not declared — the agent can only infer from the notes, and will ask you if it cannot',
      'config.shapeOther': 'Other (describe it)',
      'config.shapeOtherPlaceholder': 'If none of the above fit, say in one line what it takes or produces',
      'config.shapesDeclared': 'in {i} / out {o}',
      'config.inputMode': 'Condition',
      'config.modeOr': 'or (any one)',
      'config.modeAnd': 'and (all required)',
      'config.modeCustom': 'other (describe it)',
      'config.modeCustomPlaceholder': 'e.g. main domain alone works; domain + IP must be combined; CIDR alone works',
      'config.modeCustomNone': 'No description yet — the agent will ask you instead of guessing',
      'config.modeIdle': '(no effect while only one input is checked)',
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
      'toast.skillUploaded': 'Skill "{name}" is in place and available to this preset immediately.',
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
      'purpose.domain': 'Domains',
      'purpose.endpoint': 'Ports & services',
      'purpose.system': 'Systems & paths',
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
      'verdict.suspect': 'suspect',
      'verdict.infer': 'inferred',
      'verdict.suspectHint': 'Observed, but it is not clear this is a real asset: block page, default page, parked page, wildcard-DNS phantom subdomain, or an unverified host-collision hit.',
      'verdict.inferHint': 'Not directly observed — derived from a reasoning chain, e.g. same-organisation name in the cert SAN, or a CNAME pointing at a CDN so it "should be hosted".',
      'card.expand': 'details',
      'card.collapse': 'collapse',
      'card.sameHost': '{n} more endpoint(s) on this host (this page)',
      'view.app': 'Systems',
      'view.endpoint': 'Endpoints',
      'view.host': 'Hosts',
      'view.web': 'Web',
      'view.hint': '{endpoints} hosts · {systems} web',
      'hostChip.all': 'All',
      'hostChip.http': 'http/https',
      'hostChip.sql': 'sql',
      'hostChip.ssh': 'ssh',
      'hostChip.ftp': 'ftp',
      'hostChip.telnet': 'telnet',
      'hostChip.smb': 'smb',
      'hostChip.rdp': 'rdp',
      'webChip.all': 'All',
      'rail.groupProto': 'By protocol',
      'rail.groupStatus': 'By status',
      'rail.groupPath': 'By path / stack',
      'results.searchPlaceholderHost': 'e.g. protocol~sql AND port=3306, or host~example.com',
      'results.searchPlaceholderWeb': 'e.g. status=200 AND title~admin, or path~/admin/',
      'card.systemBadge': 'system',
      'card.root': 'root',
      'card.noPort': 'no port',
      'card.noPortHint': 'This record claims web but has no port — record host:port to fix it.',
      'card.dead': 'dead',
      'card.deadHint': 'Unreachable at last verification — kept, only flagged.',
      'card.noIp': 'no IP',
      'card.noIpHint': 'Port recorded without a resolved IP — usually available from the tool output.',
      'card.rootHint': 'This web asset is the root path derived from its endpoint (not an explicitly recorded system entry).',
      'card.systemBadgeHint': 'A system = endpoint + base path. Different apps under one endpoint are different systems.',
      'card.unresolved': 'unconfirmed',
      'card.unresolvedHint': 'Only one of three signals matched another entry on this endpoint — resolve it in the pending list.',
      'card.merged': 'merged {n}',
      'card.mergedHint': 'Confirmed same system as other entries; can be split back.',
      'detail.urls': 'URLs',
      'detail.emptyUrls': 'No URL evidence for this system yet.',
      'questions.title': '{n} pending',
      'questions.hint': 'These entries may be the same system, but only one signal matched. Merging is reversible.',
      'questions.merge': 'Merge',
      'questions.keep': 'Keep separate',
      'questions.dismiss': 'Later',
      'questions.more': '{n} more not shown',
      'plan.stages': 'Stages',
      'plan.current': 'now',
      'plan.allDone': 'all done',
      'plan.coverage': 'Coverage',
      'plan.gap': '{n} uncovered (of {total})',
      'plan.gapHint': 'Per asset × evidence layer; the uncovered count is truncated.',
      'results.emptyApp': 'No system-level records yet — have the agent record systems with URL + basePath, or switch to the "Endpoints" view.',
      'artifact.all': 'All',
      'artifact.kind.cloud': 'Cloud',
      'artifact.kind.leak': 'Leak',
      'artifact.kind.api_doc': 'API doc',
      'artifact.kind.credential': 'Credential',
      'artifact.kind.package': 'Package',
      'artifact.kind.other': 'Other',
      'artifact.sev.high': 'high',
      'artifact.sev.medium': 'medium',
      'artifact.sev.low': 'low',
      'artifact.hits': 'hits',
      'artifact.count': 'seen {n}×',
      'artifact.searchPlaceholder': 'Filter by title / content / source / how found',
      'artifact.empty': 'No artifacts yet',
      'artifact.emptyHint': 'Cloud resources, leaks, API docs, credentials and packages land here. Have the agent call expose_artifact.',
      'artifact.filtered': 'Nothing matched',
      'artifact.filteredHint': '{total} artifacts in total.',
      'artifact.kindLabel': 'Kind',
      'artifact.source': 'Source',
      'artifact.howFound': 'How found',
      'artifact.url': 'URL',
      'artifact.host': 'Host',
      'artifact.rules': 'Matched rules',
      'artifact.content': 'Content',
      'artifact.reveal': 'Reveal',
      'artifact.hide': 'Mask',
      'settings.open': 'Settings',
      'settings.title': 'Artifact settings',
      'settings.hint': 'Sensitive-info regexes: scanned on write, matches are flagged. Tighter rules mean less noise.',
      'settings.enabled': 'Enable web asset browsing',
      'settings.rules': 'Rules',
      'settings.ruleName': 'Name',
      'settings.rulePattern': 'Regex',
      'settings.addRule': 'Add rule',
      'settings.reset': 'Reload',
      'settings.test': 'Test',
      'settings.testPlaceholder': 'Paste text to see which rules hit',
      'settings.testHit': 'Matched: {names}',
      'settings.testNone': 'No rule matched',
      'settings.rescan': 'Rescan with current rules',
      'settings.rescanned': 'Rescanned {n} artifacts',
      'settings.save': 'Save',
      'field.ip': 'IP',
      'field.port': 'Port',
      'field.protocol': 'Proto',
      'field.status': 'Status',
      'field.category': 'Type',
      'field.fingerprint': 'Stack',
      'field.sources': 'Source',
      'field.lastSeen': 'Seen',
      'detail.cert': 'Certificate',
      'detail.headers': 'Headers',
      'detail.body': 'Body',
      'detail.relations': 'Domains · IPs',
      'detail.hasData': 'collected',
      'detail.noData': 'not collected',
      'detail.subject': 'Subject',
      'detail.issuer': 'Issuer',
      'detail.notAfter': 'Expires',
      'detail.emptyCert': 'No certificate collected — the endpoint is not TLS, or the model did not submit cert fields.',
      'detail.emptyHeaders': 'No raw response recorded. Known: status={status}, server={server}, tech={tech}.',
      'detail.headersRaw': 'Raw headers',
      'detail.banner': 'Banner',
      'detail.emptyBody': 'No body submitted — capture it (readable text, tags stripped) to populate this tab.',
      'detail.bodyLength': '{n} chars',
      'detail.loading': 'Loading relations…',
      'rel.currentHint': 'What this asset knows right now (structured fields, not inference):',
      'rel.ip': 'Endpoint IP',
      'rel.cname': 'CNAME',
      'rel.noIp': 'No IP recorded — resolution was not written into the ip field.',
      'rel.sameIp': 'Other endpoints on the same IP',
      'rel.sameIpPorts': 'Same IP · ports',
      'rel.sameIpDomains': 'Same IP · domains',
      'rel.sameCname': 'Same CNAME',
      'rel.certSan': 'Domains in the cert SAN',
      'rel.sameHost': 'Other ports on this host',
      'rel.sameHostPorts': 'Same host · ports',
      'rel.history': 'History',
      'rel.none': 'No other relations.',
      'rel.expand': 'show {n} more',
      'rel.collapse': 'collapse',
      'rel.copied': 'Copied {text}',
      'rel.copyFailed': 'Copy failed — select it manually',
      'rel.historyHint': 'Observed at collection time — not necessarily current resolution. IP shown only when explicitly recorded.',
      'rel.historyEmpty': 'No earlier history.',
      'rel.notFound': 'This asset is no longer in the store.',
      'rail.title': 'Filters',
      'rail.recent': 'Recent',
      'rail.recentEmpty': 'No queries yet — applying one records it here.',
      'rail.clear': 'clear',
      'rail.forgetCurrent': 'Remove current',
      'rail.count': 'used {n}×',
      'rail.builtin': 'Built-in',
      'rail.groupCheck': 'Checks',
      'rail.groupWeb': 'Web',
      'rail.groupService': 'Services',
      'rail.groupCert': 'Cert',
      'rail.groupVerdict': 'Verdict',
      'shape.org_short': 'Org short name',
      'shape.org_full': 'Org legal name',
      'shape.credit_code': 'Credit code',
      'shape.icp': 'ICP filing no.',
      'shape.main_domain': 'Main domain',
      'shape.subdomain': 'Subdomain',
      'shape.domain': 'Domain',
      'shape.ip': 'IP',
      'shape.cidr': 'CIDR range',
      'shape.port': 'Port',
      'shape.endpoint': 'host:port',
      'shape.url': 'URL',
      'shape.protocol': 'Protocol',
      'shape.service': 'Service + version',
      'shape.banner': 'Banner',
      'shape.status': 'Status code',
      'shape.title': 'Title',
      'shape.tech': 'Fingerprint',
      'shape.cert': 'Certificate',
      'shape.email': 'Email',
      'shape.credential': 'Credential',
      'shape.source_code': 'Source code',
      'shape.shot': 'Screenshot',
      'shape.other': 'Other',
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
          style: { background: T.card, border: `1px solid ${T.borderSoft}`, borderRadius: 14, width: props.wide === true ? 760 : 560, maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
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

    /**
     * 上传技能 zip（原始二进制，不走 JSON）。
     *
     * @param {string} id - 配置行 id（后端按它决定落地目录）。
     * @param {File} file - 用户选的 zip。
     * @returns {Promise<{ name: string, description: string, files: number, bytes: number, uploadedAt: string }>}
     */
    async function uploadSkillZip(id, file) {
      const token = new URLSearchParams(window.location.search).get('token')
      const query = `id=${encodeURIComponent(id)}${token === null ? '' : `&token=${encodeURIComponent(token)}`}`
      const response = await fetch(`${API}/skills/upload?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/zip' },
        body: file,
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

    /** 新建一行。工具带单选用途；空间测绘带多选能力；技能行等上传。形态只对前两种有意义。 */
    function blankEntry(type) {
      const base = {
        id: newRowId(), type, name: '', enabled: true, note: '',
        inputs: [], outputs: [], inputsOther: '', outputsOther: '',
        inputMode: 'or', inputModeNote: '',
      }
      if (type === 'skill') {
        return { ...base, skillName: '', description: '', files: 0, bytes: 0, uploadedAt: '' }
      }
      if (type === 'mcp') {
        return { ...base, transport: 'stdio', command: '', args: [], env: {}, cwd: '', url: '', headers: {} }
      }
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

    const PAGE_SIZES = [30, 60, 100]

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


    /**
     * 卡片的数据模型：把"这条资产到底能显示什么"收在一个纯函数里。
     *
     * 抽出来是为了可测 —— "有就显示、没有就显示未采集"的判断不该藏在 JSX 里，
     * smoke-client 可以直接拿三种样本（Web 有标题 / 服务有 banner / 空壳 host）断言它。
     */
    function cardModel(row) {
      const port = Number(row.port) || 0
      const host = String(row.host ?? '')
      const isApp = row.nodeType === 'app'
      // 系统的身份就是它的 URL（scheme://host:port/basePath），端点是 host:port。
      const endpoint = isApp
        ? String(row.key ?? '') || `${host}${port === 0 ? '' : `:${port}`}`
        : port === 0 ? host : `${host}:${port}`
      const protocol = String(row.protocol ?? row.scheme ?? '')
      const isHttp = protocol === 'http' || protocol === 'https'
      const tech = Array.isArray(row.tech) ? row.tech : []
      const sources = Array.isArray(row.sources) ? row.sources : []
      const isWeb = isHttp || row.category === 'web'
      // 标题行：Web 看 title，服务看 banner 首行，host 级什么都没有。
      const titleRaw = isWeb
        ? String(row.title ?? '')
        : (String(row.banner ?? '') || [row.service, row.version].filter((value) => value !== undefined && value !== '').join(' '))
      const firstLine = titleRaw.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
      const titleLine = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
      const fingerprint = isWeb
        ? [...new Set([...tech.slice(0, 3), String(row.server ?? '')].filter((value) => value !== ''))]
        : [String(row.service ?? ''), String(row.version ?? '')].filter((value) => value !== '')
      return {
        endpoint,
        host,
        port,
        protocol,
        isWeb,
        isApp,
        // 系统的身份本身就是完整 URL（`http://host:port/path/`），**不能再拼一次协议** ——
        // 否则会生成 `http://http://host:port/`。端点才需要补 scheme。
        url: isApp
          ? (/^https?:\/\//i.test(endpoint) ? endpoint : '')
          : (isHttp ? `${protocol}://${endpoint}` : ''),
        verdict: String(row.verdict ?? ''),
        status: Number(row.status) || 0,
        category: String(row.category ?? 'unknown'),
        titleRaw,
        titleLine,
        canExpand: titleLine !== titleRaw && titleRaw !== '',
        fingerprint,
        sources,
        ip: String(row.ip ?? ''),
        lastSeen: Number(row.lastSeen) || 0,
        // 系统的额外信息：证据条数、合并状态、置信度。
        urlCount: Array.isArray(row.urls) ? row.urls.length : 0,
        mergeState: String(row.mergeState ?? 'single'),
        mergedFrom: Array.isArray(row.mergedFrom) ? row.mergedFrom : [],
        systemConfidence: String(row.systemConfidence ?? ''),
        /** 由端点派生的根路径资产（不是模型显式登记的系统）。 */
        derived: row.derived === true,
        /** 验活结果：dead = 上次验证连不上（不删除，只标记）。 */
        lifecycle: String(row.lifecycle ?? ''),
        lastVerifiedAt: Number(row.lastVerifiedAt) || 0,
        /**
         * 卡片上并排展示的字段。**空值也保留**（value 为空串），渲染层统一显示 `—` ——
         * 隐藏空字段会让人以为"没这一项"，而这里恰恰要让人看见"没采到"。
         */
        fields: (() => {
          const all = [
            { key: 'ip', labelKey: 'field.ip', value: String(row.ip ?? '') },
            { key: 'port', labelKey: 'field.port', value: port === 0 ? '' : String(port) },
            { key: 'protocol', labelKey: 'field.protocol', value: protocol },
            { key: 'status', labelKey: 'field.status', value: Number(row.status) ? String(row.status) : '' },
            { key: 'category', labelKey: 'field.category', value: String(row.category ?? 'unknown') },
            { key: 'fingerprint', labelKey: 'field.fingerprint', value: fingerprint.join(' · ') },
            { key: 'sources', labelKey: 'field.sources', value: sources.join(' · ') },
            {
              key: 'lastSeen',
              labelKey: 'field.lastSeen',
              value: Number(row.lastSeen) ? new Date(Number(row.lastSeen)).toLocaleString() : '',
            },
          ]
          // 域名级记录（port=0）本来就没有端口/协议/状态 —— 空字段不再占格子，
          // 但"缺端口/缺 IP"的角标仍然会提示真正的缺失。
          if (!isApp && port === 0) {
            return all.filter((item) => item.key === 'category' || item.key === 'sources' || item.value !== '')
          }
          return all
        })(),
      }
    }

    /**
     * 详情四页签的数据模型（同样抽成纯函数便于断言）。
     *
     * 每个页签都带 `has`：没有数据时页面显示"未采集 + 缺什么"，而不是留白或编内容。
     */
    function detailModel(row, relations) {
      const san = Array.isArray(row.certSan) ? row.certSan : []
      const tech = Array.isArray(row.tech) ? row.tech : []
      const cert = {
        has: Boolean(String(row.certSubject ?? '') || String(row.certIssuer ?? '') || String(row.certNotAfter ?? '') || san.length > 0),
        subject: String(row.certSubject ?? ''),
        issuer: String(row.certIssuer ?? ''),
        notAfter: String(row.certNotAfter ?? ''),
        san,
      }
      const headersRaw = String(row.headers ?? '')
      const banner = String(row.banner ?? '')
      const headers = {
        has: headersRaw !== '' || banner !== '',
        raw: headersRaw,
        banner,
        status: Number(row.status) || 0,
        server: String(row.server ?? ''),
        tech,
      }
      const bodyText = String(row.body ?? '')
      const body = { has: bodyText !== '', text: bodyText, length: bodyText.length }
      const urlItems = Array.isArray(row.urls) ? row.urls : []
      const urls = { has: urlItems.length > 0, items: urlItems }
      const current = relations?.current ?? {
        ip: '', cname: '', certSan: [], sameIpPorts: [], sameIpDomains: [], sameCname: [], sameHostPorts: [],
      }
      const history = Array.isArray(relations?.history) ? relations.history : []
      const related = {
        has: Boolean(relations?.found) && Boolean(
          current.ip || current.cname || current.certSan.length > 0
          || current.sameIpPorts.length > 0 || current.sameIpDomains.length > 0
          || current.sameCname.length > 0 || current.sameHostPorts.length > 0 || history.length > 0,
        ),
        found: Boolean(relations?.found),
        current,
        history,
      }
      return { cert, headers, body, urls, relations: related }
    }

    /**
     * 内置语句**按视图分开** —— 两种资产看的东西本来就不一样：
     * 主机资产关心协议族（sql/ssh/…），Web 资产关心状态码、标题、路径。
     * 每一条都在 smoke 里断言过能被 `parseQuery` 解析。
     */
    const BUILTIN_QUERIES = {
      endpoint: [
        { group: 'rail.groupProto', items: ['protocol~http', 'protocol~sql', 'protocol~ssh', 'service~ftp', 'service~telnet'] },
        { group: 'rail.groupCheck', items: ['port!=0', 'protocol=""', 'verdict=suspect'] },
      ],
      app: [
        { group: 'rail.groupStatus', items: ['status=200', 'status=403', 'status=404', 'status>=500'] },
        { group: 'rail.groupCheck', items: ['title=""', 'title!=""', 'status=0'] },
        { group: 'rail.groupPath', items: ['path=/', 'path~admin', 'url~news', 'tech~nginx'] },
      ],
    }

    /**
     * 一条资产 = 一张卡。
     *
     * 折叠态是「一行头部 + 一行标题 + 一片**带标签的字段网格**」，不是三条短行：
     * 卡片占满会话列，纵向堆三行会让右边空一大片，而 IP / 端口 / 协议 / 状态 / 类型 / 组件 /
     * 来源 / 最近观测本来就是并排看的。空值也占位显示 `—`，这样"没采到"是看得见的
     * （上一轮就是靠 `title=""` 这类查询才发现的空壳）。
     */
    function AssetCard(props) {
      const { t, row, model, expanded, onToggle, onOpen, relations, relationsLoading, onQuery, sameHostCount } = props
      const [bubble, setBubble] = useState(null)
      const tone = CATEGORY_TONE[model.category] ?? T.text3

      const openBubble = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setBubble({
          x: Math.max(8, Math.min(rect.left, window.innerWidth - 468)),
          y: Math.min(rect.bottom + 6, window.innerHeight - 120),
          text: model.titleRaw,
        })
      }

      /** 一个字段：标签固定宽度，值单行省略；空值渲染成 `—`。 */
      const fieldCell = (item) => {
        const isEmpty = item.value === ''
        const text = isEmpty ? '—' : item.value
        const shown = item.key === 'category' && !isEmpty ? t(`results.cat${item.value[0].toUpperCase()}${item.value.slice(1)}`) : text
        return h('div', { key: item.key, className: 'ih-acard-field' },
          h('span', { className: 'ih-acard-label' }, t(item.labelKey)),
          h('span', {
            className: 'ih-acard-value',
            title: isEmpty ? undefined : String(shown),
            style: isEmpty
              ? { color: T.text3 }
              : (item.key === 'category' ? { color: tone } : undefined),
          }, String(shown)),
        )
      }

      return h('div', { className: `ih-acard${expanded ? ' ih-acard-open' : ''}`, 'data-testid': 'infohunter-asset' },
        h('div', { className: 'ih-acard-bar', style: { background: tone } }),
        h('div', { className: 'ih-acard-main' },
          // ① 头部：端点/系统 URL + 判定 + 状态 + 复制/打开 + 详情
          h('div', { className: 'ih-acard-row' },
            h('span', { className: 'ih-acard-endpoint', title: model.endpoint }, model.endpoint),
            model.isApp
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t('card.systemBadgeHint'),
                  style: { color: T.brand, border: `1px solid ${tint(T.brand, 0.45)}`, background: tint(T.brand, 0.1) },
                }, t('card.systemBadge'))
              : null,
            // 验活失败：空间测绘的过期结果，一眼能看出来。
            model.lifecycle === 'dead'
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: model.lastVerifiedAt === 0
                    ? t('card.deadHint')
                    : `${t('card.deadHint')}\n${new Date(model.lastVerifiedAt).toLocaleString()}`,
                  style: { color: T.error, border: `1px solid ${tint(T.error, 0.45)}`, background: tint(T.error, 0.1) },
                }, t('card.dead'))
              : null,
            // 记录质量角标：不展开详情就能看出这条记录不完整。
            model.isWeb && model.port === 0 && !model.isApp
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t('card.noPortHint'),
                  style: { color: T.error, border: `1px solid ${tint(T.error, 0.45)}`, background: tint(T.error, 0.08) },
                }, t('card.noPort'))
              : null,
            !model.isApp && model.port > 0 && model.ip === ''
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t('card.noIpHint'),
                  style: { color: T.warn, border: `1px solid ${tint(T.warn, 0.45)}`, background: tint(T.warn, 0.08) },
                }, t('card.noIp'))
              : null,
            model.isApp && model.derived
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t('card.rootHint'),
                  style: { color: T.text3, border: `1px solid ${T.border}` },
                }, t('card.root'))
              : null,
            model.isApp && model.mergeState === 'unresolved'
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t('card.unresolvedHint'),
                  style: { color: T.warn, border: `1px solid ${tint(T.warn, 0.45)}`, background: tint(T.warn, 0.1) },
                }, t('card.unresolved'))
              : null,
            model.isApp && model.mergeState === 'merged'
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t('card.mergedHint'),
                  style: { color: T.text2, border: `1px solid ${T.border}` },
                }, t('card.merged').replace('{n}', String(model.mergedFrom.length)))
              : null,
            model.verdict === 'suspect' || model.verdict === 'infer'
              ? h('span', {
                  className: 'ih-acard-badge',
                  title: t(`verdict.${model.verdict}Hint`),
                  style: {
                    color: model.verdict === 'suspect' ? T.warn : T.brand,
                    border: `1px solid ${tint(model.verdict === 'suspect' ? T.warn : T.brand, 0.45)}`,
                    background: tint(model.verdict === 'suspect' ? T.warn : T.brand, 0.1),
                  },
                }, t(`verdict.${model.verdict}`))
              : null,
            model.status === 0 ? null : h(Pill, {
              tone: model.status < 300 ? T.success : model.status < 400 ? T.brand : model.status < 500 ? T.warn : T.error,
            }, String(model.status)),
            model.protocol === '' ? null : h(Pill, { tone: T.text2 }, model.protocol),
            h(CopyButton, { text: model.url === '' ? model.endpoint : model.url, t }),
            model.isWeb ? h('button', {
              type: 'button',
              title: t('results.open'),
              'aria-label': t('results.open'),
              onClick: () => onOpen(model.url),
              style: { flexShrink: 0, background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 12, padding: 1, lineHeight: 1 },
            }, '↗') : null,
            sameHostCount > 1
              ? h('button', {
                  type: 'button',
                  title: t('card.sameHost').replace('{n}', String(sameHostCount - 1)),
                  onClick: () => onQuery(`host=${model.host}`),
                  style: { ...buttonStyle('ghost'), padding: '1px 7px', fontSize: 10.5, flexShrink: 0 },
                }, `+${sameHostCount - 1}`)
              : null,
            h('button', {
              type: 'button',
              onClick: onToggle,
              style: { ...buttonStyle('ghost'), marginLeft: 'auto', padding: '2px 9px', fontSize: 11.5, flexShrink: 0 },
            }, expanded ? t('card.collapse') : t('card.expand')),
          ),
          // ② 标题：整行，最长的信息不跟别人挤
          h('div', {
            className: 'ih-acard-title',
            title: model.canExpand ? t('results.expandHint') : (model.titleLine === '' ? undefined : model.titleRaw),
            onClick: model.canExpand ? openBubble : undefined,
            style: { cursor: model.canExpand ? 'pointer' : 'default', color: model.titleLine === '' ? T.text3 : T.text },
          }, model.titleLine === '' ? '—' : model.titleLine),
          // ③ 字段网格：按可用宽度自动排，一列一列铺满
          h('div', { className: 'ih-acard-fields' }, model.fields.map(fieldCell)),
          expanded
            ? h(AssetDetail, { t, row, model, relations, relationsLoading, onQuery })
            : null,
        ),
        bubble === null ? null : h(TextBubble, { ...bubble, onClose: () => setBubble(null) }),
      )
    }

    /** 展开后的页签：证书 / 响应头 / 正文 / URL 列表（系统独有）/ 关联域名·IP。 */
    function AssetDetail(props) {
      const { t, row, model, relations, relationsLoading, onQuery } = props
      const detail = detailModel(row, relations)
      const tabs = [
        { id: 'cert', label: t('detail.cert'), has: detail.cert.has },
        { id: 'headers', label: t('detail.headers'), has: detail.headers.has },
        { id: 'body', label: t('detail.body'), has: detail.body.has },
        ...(model.isApp ? [{ id: 'urls', label: t('detail.urls'), has: detail.urls.has }] : []),
        { id: 'relations', label: t('detail.relations'), has: detail.relations.has },
      ]
      const firstWithData = tabs.find((tab) => tab.has)
      const [tab, setTab] = useState((firstWithData ?? tabs[0]).id)
      /** 关联块与历史的展开状态（按块 id，默认收起）。 */
      const [relShowAll, setRelShowAll] = useState({})
      const [histAll, setHistAll] = useState(false)
      /** 点关联 chip = 复制（不是筛选，也不是跳转）。 */
      const copyText = async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          notify(t('rel.copied').replace('{text}', text))
        } catch {
          notify(t('rel.copyFailed'))
        }
      }
      const dim = (text) => h('div', { style: { fontSize: 12, color: T.text3, lineHeight: 1.7 } }, text)
      const block = (text) => h('pre', {
        style: {
          margin: 0, fontFamily: T.code, fontSize: 11.5, lineHeight: 1.65, color: T.text2,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      }, text)
      const field = (label, value) => h('div', { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.8, minWidth: 0 } },
        h('span', { style: { color: T.text3, flexShrink: 0, minWidth: 64 } }, label),
        h('span', { style: { color: T.text, minWidth: 0, wordBreak: 'break-word', fontFamily: T.code, fontSize: 11.5 } }, value === '' ? '—' : value))
      const link = (label, query) => h('button', {
        type: 'button',
        onClick: () => onQuery(query),
        style: { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: T.brand, fontFamily: T.code, fontSize: 11.5, textDecoration: 'underline dotted' },
      }, label)

      const content = (() => {
        if (tab === 'cert') {
          if (!detail.cert.has) return dim(t('detail.emptyCert'))
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            field(t('detail.subject'), detail.cert.subject),
            field(t('detail.issuer'), detail.cert.issuer),
            field(t('detail.notAfter'), detail.cert.notAfter),
            detail.cert.san.length === 0 ? null : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 } },
              detail.cert.san.map((name) => link(name, `cert.san~${name}`))))
        }
        if (tab === 'headers') {
          if (!detail.headers.has) {
            return dim(t('detail.emptyHeaders')
              .replace('{status}', detail.headers.status === 0 ? '—' : String(detail.headers.status))
              .replace('{server}', detail.headers.server === '' ? '—' : detail.headers.server)
              .replace('{tech}', detail.headers.tech.join(' · ') || '—'))
          }
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            detail.headers.raw === '' ? null : h('div', null,
              h('div', { style: { fontSize: 11.5, color: T.text3, marginBottom: 4 } }, t('detail.headersRaw')),
              block(detail.headers.raw)),
            detail.headers.banner === '' ? null : h('div', null,
              h('div', { style: { fontSize: 11.5, color: T.text3, marginBottom: 4 } }, t('detail.banner')),
              block(detail.headers.banner)),
          )
        }
        if (tab === 'body') {
          if (!detail.body.has) return dim(t('detail.emptyBody'))
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            block(detail.body.text),
            h('div', { style: { fontSize: 11, color: T.text3 } }, t('detail.bodyLength').replace('{n}', String(detail.body.length))))
        }
        if (tab === 'urls') {
          if (!detail.urls.has) return dim(t('detail.emptyUrls'))
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 190, overflow: 'auto' } },
            detail.urls.items.map((item, index) => h('div', {
              key: `${item.url}-${index}`,
              style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0, fontFamily: T.code, fontSize: 11.5 },
            },
              h('span', {
                style: {
                  flexShrink: 0, fontSize: 10, padding: '0 5px', borderRadius: 4, color: T.text3,
                  border: `1px solid ${T.border}`, textTransform: 'lowercase',
                },
              }, item.pageType),
              h('button', {
                type: 'button',
                title: item.url,
                onClick: () => onQuery(`url~${item.url.split('/').slice(3).join('/').split('?')[0] || '/'}`),
                style: {
                  flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0,
                  cursor: 'pointer', font: 'inherit', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', textDecoration: 'underline dotted',
                },
              }, item.url),
              item.title === '' ? null : h('span', { style: { color: T.text3, flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title)))
          )
        }
        // relations：结构化块，不是一段散文。空的块整块不渲染。
        if (relationsLoading) return dim(t('detail.loading'))
        if (!detail.relations.found) return dim(t('rel.notFound'))
        const cur = detail.relations.current
        const sections = [
          { id: 'ipPorts', label: t('rel.sameIpPorts'), nodes: cur.sameIpPorts },
          { id: 'ipDomains', label: t('rel.sameIpDomains'), nodes: cur.sameIpDomains },
          { id: 'cname', label: t('rel.sameCname'), nodes: cur.sameCname },
          { id: 'hostPorts', label: t('rel.sameHostPorts'), nodes: cur.sameHostPorts },
          { id: 'san', label: t('rel.certSan'), nodes: cur.certSan.map((name) => ({ key: name, host: name, port: 0, san: true })) },
        ].filter((item) => item.nodes.length > 0)

        /** 一条关联 = 一个 chip：端口 > 0 才显示 `:端口`，域名级只显示主机名。**点击即复制**。 */
        const chip = (node) => {
          const showPort = !node.san && (Number(node.port) || 0) > 0
          const label = showPort ? `${node.host}:${node.port}` : node.host
          return h('button', {
            key: `${node.key}|${label}`,
            type: 'button',
            className: 'ih-rel-chip',
            title: node.title === '' ? `${label}（点击复制）` : `${label}\n${node.title}\n点击复制`,
            onClick: () => copyText(label),
          }, label)
        }

        const section = (item) => {
          const expanded = relShowAll[item.id] === true
          // 同一目标只出现一次：端点节点与它的根路径 Web 资产标签相同时，保留第一个。
          const unique = []
          const seen = new Set()
          for (const node of item.nodes) {
            const label = !node.san && (Number(node.port) || 0) > 0 ? `${node.host}:${node.port}` : node.host
            if (seen.has(label)) continue
            seen.add(label)
            unique.push(node)
          }
          const shown = expanded ? unique : unique.slice(0, 6)
          return h('div', { key: item.id, className: 'ih-rel-sec' },
            h('span', { className: 'ih-rel-label' }, `${item.label} ${unique.length}`),
            h('div', { className: 'ih-rel-chips' },
              shown.map(chip),
              unique.length > 6
                ? h('button', {
                    type: 'button',
                    className: 'ih-rel-more',
                    onClick: () => setRelShowAll((prev) => ({ ...prev, [item.id]: !expanded })),
                  }, expanded ? t('rel.collapse') : t('rel.expand').replace('{n}', String(unique.length - 6)))
                : null),
          )
        }

        const history = detail.relations.history
        const historyShown = histAll ? history : history.slice(0, 5)

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          // 身份行：IP / CNAME，两个字段并排
          h('div', { className: 'ih-rel-id' },
            h('span', { className: 'ih-rel-k' }, 'IP'),
            cur.ip === ''
              ? h('span', { className: 'ih-rel-empty' }, t('rel.noIp'))
              : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                  h('span', { className: 'ih-rel-v' }, cur.ip),
                  h(CopyButton, { text: cur.ip, t })),
            h('span', { className: 'ih-rel-k' }, 'CNAME'),
            cur.cname === ''
              ? h('span', { className: 'ih-rel-empty' }, '—')
              : h('span', { className: 'ih-rel-v' }, cur.cname),
          ),

          sections.length === 0
            ? h('div', { className: 'ih-rel-empty' }, t('rel.none'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, sections.map(section)),

          history.length === 0 ? null : h('div', { className: 'ih-rel-hist' },
            h('div', { className: 'ih-rel-hist-head' },
              h('span', null, `${t('rel.history')} ${history.length}`),
              history.length > 5
                ? h('button', { type: 'button', className: 'ih-rel-more', onClick: () => setHistAll((v) => !v) },
                    histAll ? t('rel.collapse') : t('rel.expand').replace('{n}', String(history.length - 5)))
                : null,
              h('span', { className: 'ih-rel-hist-note', title: t('rel.historyHint') }, 'ⓘ')),
            historyShown.map((item, index) => h('div', { key: `${item.at}-${index}`, className: 'ih-rel-hist-row' },
              h('span', { className: 'ih-rel-time' }, new Date(item.at).toLocaleString()),
              h('span', {
                className: 'ih-rel-kind',
                style: {
                  color: KIND_TONE[item.kind] ?? T.text3,
                  borderColor: tint(KIND_TONE[item.kind] ?? T.text3, 0.45),
                },
              }, item.kind),
              h('span', { className: 'ih-rel-src' }, item.sources.length === 0 ? '—' : item.sources.join('·')),
              item.explicitIp
                ? h('span', { className: 'ih-rel-ip' }, item.ip)
                : h('span', { className: 'ih-rel-empty' }, '—'))),
          ),
        )
      })()

      return h('div', { className: 'ih-detail' },
        h('div', { className: 'ih-tabs' },
          tabs.map((item) => h('button', {
            key: item.id,
            type: 'button',
            onClick: () => setTab(item.id),
            className: `ih-tab${tab === item.id ? ' ih-tab-on' : ''}`,
            title: item.has ? t('detail.hasData') : t('detail.noData'),
          },
            h('span', { className: 'ih-tab-dot', style: { background: item.has ? T.brand : T.border } }),
            item.label))),
        h('div', { className: 'ih-tab-body' }, content),
      )
    }

    /** 右侧语句栏：上半「最近使用」，下半「内置常用」。 */
    function QueryRail(props) {
      const { t, recent, onApply, onForget, onClear, error, applied, onHelp, view } = props
      const item = (q, extra) => h('div', { key: q, className: 'ih-rail-item' },
        h('button', {
          type: 'button',
          className: `ih-rail-q${applied === q ? ' ih-rail-q-on' : ''}`,
          title: q,
          onClick: () => onApply(q),
        }, q),
        extra ?? null)
      return h('aside', { className: 'ih-rail' },
        h('div', { className: 'ih-rail-head' },
          h('span', null, t('rail.title')),
          h('button', { type: 'button', onClick: onHelp, title: t('results.help'), style: { ...buttonStyle('ghost'), padding: '1px 7px', fontSize: 11 } }, '?')),
        error === '' ? null : h('div', { style: { fontSize: 11, color: T.error, lineHeight: 1.6 } }, error),
        h('div', { className: 'ih-rail-section' },
          h('div', { className: 'ih-rail-label' },
            h('span', null, t('rail.recent')),
            recent.length === 0 ? null : h('button', {
              type: 'button',
              onClick: onClear,
              style: { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: T.text3, fontSize: 11 },
            }, t('rail.clear'))),
          recent.length === 0
            ? h('div', { style: { fontSize: 11, color: T.text3, lineHeight: 1.7 } }, t('rail.recentEmpty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                recent.map((row) => item(row.q, h('span', { className: 'ih-rail-count', title: t('rail.count').replace('{n}', String(row.count)) }, String(row.count))))),
          recent.length === 0
            ? null
            : h('button', {
                type: 'button',
                onClick: () => onForget(applied),
                disabled: applied === '',
                style: { ...buttonStyle('ghost'), padding: '1px 7px', fontSize: 11, marginTop: 4, opacity: applied === '' ? 0.4 : 1 },
              }, t('rail.forgetCurrent'))),
        h('div', { className: 'ih-rail-section' },
          h('div', { className: 'ih-rail-label' }, h('span', null, t('rail.builtin'))),
          (BUILTIN_QUERIES[view] ?? BUILTIN_QUERIES.endpoint).map((group) => h('div', { key: group.group, style: { marginBottom: 6 } },
            h('div', { className: 'ih-rail-sublabel' }, t(group.group)),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              group.items.map((q) => h('button', {
                key: q,
                type: 'button',
                className: `ih-rail-q${applied === q ? ' ih-rail-q-on' : ''}`,
                title: q,
                onClick: () => onApply(q),
              }, q)))))),
      )
    }

    /** 产物的类型配色（与采集记录的 kind 配色区分开）。 */
    const ARTIFACT_TONE = {
      cloud: T.brand, leak: T.error, api_doc: T.success, credential: T.warn, package: T.text2, other: T.text3,
    }

    /** 严重级配色。 */
    const SEVERITY_TONE = { high: T.error, medium: T.warn, low: T.success }

    /** 产物卡片的数据模型（纯函数，便于断言）。 */
    function artifactCardModel(row) {
      const hits = Array.isArray(row?.hits) ? row.hits : []
      return {
        id: String(row?.id ?? ''),
        kind: String(row?.kind ?? 'other'),
        title: String(row?.title ?? ''),
        severity: String(row?.severity ?? ''),
        hits: hits.length,
        ruleNames: hits.map((hit) => hit.name).slice(0, 3),
        source: String(row?.source?.name ?? ''),
        lastSeen: Number(row?.lastSeen) || 0,
        count: Number(row?.count) || 1,
      }
    }

    /** 凭据类默认打码：投屏/截图时不该把 AK 直接亮出来。 */
    function maskSecret(text) {
      const value = String(text ?? '')
      if (value.length <= 8) return value.replace(/./g, '•')
      const head = value.slice(0, 4)
      const tail = value.slice(-4)
      return `${head}${'•'.repeat(Math.min(24, Math.max(4, value.length - 8)))}${tail}`
    }

    /** 一条产物 = 一张固定高度的卡片；点开是弹窗。 */
    function ArtifactCard(props) {
      const { t, model, onOpen } = props
      const tone = ARTIFACT_TONE[model.kind] ?? T.text3
      return h('button', { type: 'button', className: 'ih-art-card', onClick: onOpen, title: model.title },
        h('span', {
          className: 'ih-art-kind',
          style: { color: tone, borderColor: tint(tone, 0.45), background: tint(tone, 0.08) },
        }, t(`artifact.kind.${model.kind}`)),
        h('span', { className: 'ih-art-title' }, model.title),
        model.hits === 0
          ? null
          : h('span', { className: 'ih-art-sev', style: { color: SEVERITY_TONE[model.severity] ?? T.text3 } },
              `${t('artifact.hits')} ${model.hits}`),
        h('span', { className: 'ih-art-meta' },
          `${model.source === '' ? '—' : model.source}`,
          model.lastSeen === 0 ? null : ` · ${new Date(model.lastSeen).toLocaleString()}`,
          model.count > 1 ? ` · ${t('artifact.count').replace('{n}', String(model.count))}` : ''),
      )
    }

    /** 产物详情弹窗：来源 / 如何发现 / 内容 / 命中规则。 */
    function ArtifactDetail(props) {
      const { t, row, onClose } = props
      const [revealed, setRevealed] = useState(false)
      const hits = Array.isArray(row.hits) ? row.hits : []
      const secret = row.kind === 'credential'
      const content = secret && !revealed ? maskSecret(row.content) : row.content
      const line = (label, value) => h('div', { className: 'ih-art-row' },
        h('span', { className: 'ih-art-label' }, label),
        h('span', { className: 'ih-art-value' }, value === '' ? '—' : value))
      return h(Modal, { title: row.title, onClose, t, wide: true },
        h('div', { className: 'ih-art-block' },
          line(t('artifact.kindLabel'), t(`artifact.kind.${row.kind}`)),
          line(t('artifact.source'), [row.source?.name, row.source?.url].filter((v) => v !== undefined && v !== '').join(' · ')),
          line(t('artifact.howFound'), row.howFound),
          row.url === '' ? null : line(t('artifact.url'), row.url),
          row.host === '' ? null : line(t('artifact.host'), row.host)),
        hits.length === 0 ? null : h('div', { className: 'ih-art-block' },
          h('div', { className: 'ih-art-block-title' }, `${t('artifact.rules')} ${hits.length}`),
          hits.map((hit, index) => h('div', { key: `${hit.ruleId}-${index}`, className: 'ih-art-hit' },
            h('span', { style: { color: SEVERITY_TONE[hit.severity] ?? T.text3 } }, hit.name),
            h('code', null, hit.sample)))),
        h('div', { className: 'ih-art-block' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { className: 'ih-art-block-title', style: { margin: 0 } }, t('artifact.content')),
            secret
              ? h('button', {
                  type: 'button',
                  onClick: () => setRevealed((v) => !v),
                  style: { ...buttonStyle('ghost'), padding: '1px 8px', fontSize: 11 },
                }, revealed ? t('artifact.hide') : t('artifact.reveal'))
              : null),
          h('pre', { className: 'ih-art-pre' }, content === '' ? '—' : content)),
      )
    }

    /** 设置弹窗：**按 section 渲染**，加配置项 = 加一条定义，不动布局。 */
    function ArtifactSettings(props) {
      const { t, sessionId, onClose, onSaved } = props
      const [rules, setRules] = useState([])
      const [enabled, setEnabled] = useState(true)
      const [sample, setSample] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const reload = useCallback(async () => {
        try {
          const payload = await api('/settings')
          const section = payload.settings?.sensitive ?? {}
          setRules(Array.isArray(section.rules) ? section.rules : [])
          setEnabled(section.enabled !== false)
        } catch (cause) {
          setError(describe(cause))
        }
      }, [])
      useEffect(() => { void reload() }, [reload])

      const patch = (index, next) => setRules((prev) => prev.map((item, at) => (at === index ? { ...item, ...next } : item)))
      const remove = (index) => setRules((prev) => prev.filter((_, at) => at !== index))
      const add = () => setRules((prev) => [...prev, { id: `rule-${prev.length + 1}-${Date.now().toString(36)}`, name: '新规则', pattern: '', flags: 'g', severity: 'medium', enabled: true, hint: '' }])

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          await api('/settings', { method: 'POST', body: { section: 'sensitive', value: { enabled, rules } } })
          onSaved?.()
          onClose()
        } catch (cause) {
          setError(describe(cause))
        } finally {
          setBusy(false)
        }
      }

      const rescan = async () => {
        setBusy(true)
        try {
          const payload = await api(`/artifacts/rescan?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: {} })
          notify(t('settings.rescanned').replace('{n}', String(payload.updated ?? 0)))
          onSaved?.()
        } catch (cause) {
          setError(describe(cause))
        } finally {
          setBusy(false)
        }
      }

      // 样例测试：纯前端跑一遍，改了规则立刻能看到命中。
      const testHits = (() => {
        if (sample === '' || rules.length === 0) return []
        const out = []
        for (const rule of rules) {
          if (rule.enabled === false || typeof rule.pattern !== 'string' || rule.pattern === '') continue
          try {
            const regex = new RegExp(rule.pattern, rule.flags?.includes('g') ? rule.flags : `${rule.flags ?? ''}g`)
            if (regex.test(sample)) out.push(rule.name || rule.id)
          } catch {
            out.push(`${rule.name || rule.id}（正则不合法）`)
          }
        }
        return out
      })()

      return h(Modal, { title: t('settings.title'), onClose, t, wide: true },
        h('div', { style: { fontSize: 11.5, color: T.text3, lineHeight: 1.7 } }, t('settings.hint')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12 } },
          h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
          t('settings.enabled')),
        h('div', { className: 'ih-art-block' },
          h('div', { className: 'ih-art-block-title' }, `${t('settings.rules')} ${rules.length}`),
          rules.map((rule, index) => h('div', { key: rule.id ?? index, className: 'ih-rule-row' },
            h('input', { type: 'checkbox', checked: rule.enabled !== false, onChange: (event) => patch(index, { enabled: event.target.checked }) }),
            h('input', { value: rule.name ?? '', onChange: (event) => patch(index, { name: event.target.value }), placeholder: t('settings.ruleName'), style: fieldStyle({ width: 120, fontSize: 11.5 }) }),
            h('input', { value: rule.pattern ?? '', onChange: (event) => patch(index, { pattern: event.target.value }), placeholder: t('settings.rulePattern'), style: fieldStyle({ flex: 1, fontFamily: T.code, fontSize: 11.5 }) }),
            h('select', { value: rule.severity ?? 'medium', onChange: (event) => patch(index, { severity: event.target.value }), style: fieldStyle({ width: 'auto', fontSize: 11.5 }) },
              ['high', 'medium', 'low'].map((id) => h('option', { key: id, value: id }, t(`artifact.sev.${id}`)))),
            h('button', { type: 'button', onClick: () => remove(index), style: { ...buttonStyle('ghost'), padding: '1px 7px', fontSize: 11 } }, '×'))),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            h('button', { type: 'button', onClick: add, style: { ...buttonStyle('ghost'), fontSize: 11.5 } }, t('settings.addRule')),
            h('button', { type: 'button', onClick: () => void reload(), style: { ...buttonStyle('ghost'), fontSize: 11.5 } }, t('settings.reset'))),
        ),
        h('div', { className: 'ih-art-block' },
          h('div', { className: 'ih-art-block-title' }, t('settings.test')),
          h('input', {
            value: sample,
            onChange: (event) => setSample(event.target.value),
            placeholder: t('settings.testPlaceholder'),
            style: fieldStyle({ width: '100%', fontFamily: T.code, fontSize: 11.5 }),
          }),
          h('div', { style: { fontSize: 11.5, color: testHits.length > 0 ? T.warn : T.text3, marginTop: 4 } },
            sample === '' ? '' : (testHits.length === 0 ? t('settings.testNone') : t('settings.testHit').replace('{names}', testHits.join('、'))))),
        error === '' ? null : h('div', { style: { fontSize: 12, color: T.error, marginTop: 8 } }, error),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' } },
          h('button', { type: 'button', onClick: () => void rescan(), disabled: busy, style: { ...buttonStyle('ghost'), fontSize: 12 } }, t('settings.rescan')),
          h('button', { type: 'button', onClick: () => void save(), disabled: busy, style: { ...buttonStyle('primary'), fontSize: 12 } }, t('settings.save'))),
      )
    }

    /** 信息产物：第 3 个 tab，在资产清单与采集记录之间。 */
    function ArtifactsArea(props) {
      const { t, sessionId } = props
      const active = props.active !== false
      const [state, setState] = useState({
        page: { rows: [], total: 0 },
        overview: { total: 0, byKind: {}, bySeverity: {}, updatedAt: 0 },
        rev: { artifacts: 0 },
      })
      const [kind, setKind] = useState('')
      const [query, setQuery] = useState('')
      const [applied, setApplied] = useState('')
      const [pageIndex, setPageIndex] = useState(0)
      const [pageSize, setPageSize] = useState(30)
      const [error, setError] = useState('')
      const [detail, setDetail] = useState(null)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [nonce, setNonce] = useState(0)
      const revRef = useRef(-1)

      const load = useCallback(async () => {
        const search = new URLSearchParams({
          sessionId,
          kind,
          q: applied,
          offset: String(pageIndex * pageSize),
          limit: String(pageSize),
        })
        try {
          const payload = await api(`/artifacts?${search}`)
          setState(payload)
          setError('')
          revRef.current = payload.rev?.artifacts ?? revRef.current
        } catch (cause) {
          setError(describe(cause))
        }
      }, [sessionId, kind, applied, pageIndex, pageSize])

      useEffect(() => { void load() }, [load, nonce])

      // 轮询变更令牌：产物是 agent 写的，面板只读。
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const tick = async () => {
          if (document.visibilityState === 'hidden') return
          try {
            const payload = await api(`/rev?sessionId=${encodeURIComponent(sessionId)}`)
            if (!alive) return
            if ((payload.rev?.artifacts ?? 0) !== revRef.current) setNonce((v) => v + 1)
          } catch {
            /* 由 load 的错误行承担 */
          }
        }
        const timer = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId, active])

      const rows = state.page?.rows ?? []
      const overview = state.overview ?? { total: 0, byKind: {}, bySeverity: {}, updatedAt: 0 }
      const total = state.page?.total ?? 0
      const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

      const chips = [
        { id: '', label: t('artifact.all'), count: overview.total },
        ...['cloud', 'leak', 'api_doc', 'credential', 'package', 'other'].map((id) => ({
          id, label: t(`artifact.kind.${id}`), count: overview.byKind?.[id] ?? 0,
        })),
      ]

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } },
        error === '' ? null : h('div', { style: { fontSize: 12, color: T.error } }, t('state.failed').replace('{message}', error)),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => setSettingsOpen(true), style: { ...buttonStyle('ghost'), fontSize: 12 } },
            `⚙ ${t('settings.open')}`),
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') { setPageIndex(0); setApplied(query.trim()) } },
            placeholder: t('artifact.searchPlaceholder'),
            style: fieldStyle({ flex: 1, fontFamily: T.code, fontSize: 12.5 }),
          }),
          h('button', { type: 'button', onClick: () => { setPageIndex(0); setApplied(query.trim()) }, style: buttonStyle('primary') }, t('results.search')),
          applied === '' ? null : h('button', { type: 'button', onClick: () => { setQuery(''); setApplied('') }, style: buttonStyle('ghost') }, t('results.clearSearch'))),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          chips.map((entry) => h('button', {
            key: entry.id === '' ? 'all' : entry.id,
            type: 'button',
            onClick: () => { setKind(entry.id); setPageIndex(0) },
            style: {
              cursor: 'pointer', font: 'inherit', fontSize: 12, borderRadius: 8, padding: '3px 9px', fontWeight: 600,
              background: kind === entry.id ? tint(ARTIFACT_TONE[entry.id] ?? T.brand, 0.16) : 'transparent',
              color: entry.id === '' ? T.text2 : ARTIFACT_TONE[entry.id] ?? T.text2,
              border: `1px solid ${kind === entry.id ? tint(ARTIFACT_TONE[entry.id] ?? T.brand, 0.5) : T.border}`,
            },
          }, `${entry.label} · ${entry.count}`))),
        rows.length === 0
          ? h(EmptyState, {
              title: overview.total === 0 ? t('artifact.empty') : t('artifact.filtered'),
              hint: overview.total === 0 ? t('artifact.emptyHint') : t('artifact.filteredHint').replace('{total}', String(overview.total)),
            })
          : h('div', { className: 'ih-art-list' }, rows.map((row) => h(ArtifactCard, {
              key: row.id,
              t,
              model: artifactCardModel(row),
              onOpen: () => setDetail(row),
            }))),
        total === 0 ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: T.text2 } },
          h('span', null, t('results.count').replace('{total}', String(total))),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' } },
            h('button', { type: 'button', disabled: pageIndex <= 0, onClick: () => setPageIndex((v) => Math.max(0, v - 1)), style: buttonStyle('ghost', pageIndex <= 0) }, t('results.prev')),
            h('span', { style: { fontFamily: T.code, minWidth: 62, textAlign: 'center' } }, `${pageIndex + 1} / ${Math.max(1, lastPage + 1)}`),
            h('button', { type: 'button', disabled: pageIndex >= lastPage, onClick: () => setPageIndex((v) => Math.min(lastPage, v + 1)), style: buttonStyle('ghost', pageIndex >= lastPage) }, t('results.next')))),
        detail === null ? null : h(ArtifactDetail, { t, row: detail, onClose: () => setDetail(null) }),
        settingsOpen ? h(ArtifactSettings, {
          t,
          sessionId,
          onClose: () => setSettingsOpen(false),
          onSaved: () => setNonce((v) => v + 1),
        }) : null,
      )
    }

    /** 采集记录：一行一次观测，密集流水。只读 —— 记录不允许删除。 */
    function RecordRow(props) {
      const { row, t } = props
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
              rows.map((row) => h(RecordRow, { key: row.id, row, t }))),
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
      const { t, onClose, onPick, view } = props
      // 两个视角的字段表与例子都不同：主机资产只看端点属性，Web 资产看状态/标题/路径。
      const groups = view === 'app'
        ? [
            ['url', 'path', 'status', 'title'],
            ['tech', 'server', 'fingerprint', 'category'],
            ['cert.subject', 'cert.issuer', 'cert.san', 'cert.notAfter'],
            ['pageType', 'source', 'verdict', 'confidence'],
          ]
        : [
            ['host', 'ip', 'port', 'protocol'],
            ['service', 'version', 'banner', 'fingerprint'],
            ['category', 'source', 'verdict', 'confidence'],
          ]
      const examples = view === 'app'
        ? [
            'status=200',
            'status>=500',
            'path~/admin/',
            'title~后台',
            'tech~vue',
            'url~news',
            'cert.issuer~Encrypt',
          ]
        : [
            'protocol~sql',
            'protocol contains ssh',
            'port=22',
            'ip=1.2.3.4',
            'service~redis',
            'host~example.com',
            'verdict=suspect',
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
        plan: null,
        coverage: null,
        rev: { config: 0, assets: 0 },
      })
      const [query, setQuery] = useState('')
      const [applied, setApplied] = useState('')
      const [category, setCategory] = useState('')
      /** 视角：主机资产（端点，默认）/ Web 资产（系统 + 根路径）。 */
      const [view, setView] = useState('endpoint')
      /** 分面：主机看协议族，Web 看状态码。 */
      const [facet, setFacet] = useState('')
      /** 问题池：判定不了的系统对，等用户裁决。 */
      const [questions, setQuestions] = useState([])
      const [pageIndex, setPageIndex] = useState(0)
      const [pageSize, setPageSize] = useState(30)
      const [syncedAt, setSyncedAt] = useState(0)
      const [error, setError] = useState('')
      const [helpOpen, setHelpOpen] = useState(false)
      const [nonce, setNonce] = useState(0)
      const [expandedKey, setExpandedKey] = useState('')
      /** key → `{ loading, data?, error? }`；展开卡片时按需取，rev 变了就整体作废。 */
      const [relations, setRelations] = useState({})
      const [recent, setRecent] = useState([])
      const [railError, setRailError] = useState('')
      const revRef = useRef(-1)

      const load = useCallback(async () => {
        const search = new URLSearchParams({
          sessionId,
          q: applied,
          nodeType: view,
          facet,
          offset: String(pageIndex * pageSize),
          limit: String(pageSize),
        })
        try {
          const payload = await api(`/assets?${search}`)
          setState(payload)
          setSyncedAt(Date.now())
          props.onSynced?.(Date.now())
          // 计划与覆盖度是全局的：往上报给顶部栏。
          props.onStatus?.({ plan: payload.plan ?? null, coverage: payload.coverage ?? null })
          setError('')
          revRef.current = payload.rev?.assets ?? revRef.current
        } catch (cause) {
          setError(describe(cause))
        }
      }, [sessionId, applied, category, view, facet, pageIndex, pageSize])

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
            if (payload.rev?.assets !== revRef.current) {
              // 数据变了：已展开卡片的关联信息可能过期，整体作废。
              setRelations({})
              setNonce((value) => value + 1)
            }
          } catch {
            /* 读失败由 load 的错误行承担 */
          }
        }
        const timer = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId, active])

      useEffect(() => { setPageIndex(0); setFacet('') }, [applied, category, pageSize, view])

      // 问题池：只看系统视角时才显示；跟 rev 一起刷新（判定发生在写入时）。
      const loadQuestions = useCallback(async () => {
        try {
          const payload = await api(`/questions?sessionId=${encodeURIComponent(sessionId)}&status=open`)
          setQuestions(Array.isArray(payload.questions) ? payload.questions : [])
        } catch {
          /* 问题池读失败不挡资产列表 */
        }
      }, [sessionId])
      useEffect(() => {
        if (!active || view !== 'app') return undefined
        void loadQuestions()
        const timer = setInterval(() => { void loadQuestions() }, 4000)
        return () => clearInterval(timer)
      }, [active, view, loadQuestions])

      /** 裁决一条问题：合并 / 保持 / 忽略。 */
      const resolveQ = async (id, choice) => {
        try {
          await api(`/questions/resolve?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            body: { id, choice },
          })
          await loadQuestions()
          setRelations({})
          setNonce((value) => value + 1)
        } catch (cause) {
          setError(describe(cause))
        }
      }

      // 最近使用的语句（全局，任何会话都能读）。
      const loadRecent = useCallback(async () => {
        try {
          const payload = await api('/queries')
          setRecent(Array.isArray(payload.queries) ? payload.queries : [])
          setRailError('')
        } catch (cause) {
          setRailError(describe(cause))
        }
      }, [])
      useEffect(() => { void loadRecent() }, [loadRecent])

      /** 记一次使用：失败不打扰用户（语句栏是辅助功能，不能挡住资产列表）。 */
      const record = async (text) => {
        try {
          const payload = await api('/queries', { method: 'POST', body: { q: text } })
          if (Array.isArray(payload.queries)) setRecent(payload.queries)
        } catch {
          /* 忽略：下次应用还会再试 */
        }
      }

      const apply = (text) => {
        const trimmed = String(text ?? '').trim()
        setQuery(trimmed)
        setApplied(trimmed)
        setPageIndex(0)
        if (trimmed !== '') void record(trimmed)
      }

      const forget = async (text) => {
        if (text === '') return
        try {
          const payload = await api('/queries/drop', { method: 'POST', body: { q: text } })
          if (Array.isArray(payload.queries)) setRecent(payload.queries)
        } catch (cause) {
          setRailError(describe(cause))
        }
      }

      const clearRecent = async () => {
        try {
          await api('/queries/clear', { method: 'POST', body: {} })
          setRecent([])
        } catch (cause) {
          setRailError(describe(cause))
        }
      }

      const loadRelations = async (key) => {
        if (key === '') return
        setRelations((prev) => ({ ...prev, [key]: { loading: true } }))
        try {
          const payload = await api(`/assets/relations?sessionId=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(key)}`)
          setRelations((prev) => ({ ...prev, [key]: { loading: false, data: payload.relations } }))
        } catch (cause) {
          setRelations((prev) => ({ ...prev, [key]: { loading: false, error: describe(cause) } }))
        }
      }

      /** 手风琴：同一时刻只展开一张卡，展开时才去取关联。 */
      const toggleCard = (key) => {
        const next = expandedKey === key ? '' : key
        setExpandedKey(next)
        if (next !== '' && relations[next]?.data === undefined) void loadRelations(next)
      }

      const rows = state.page?.rows ?? []
      const overview = state.overview ?? { total: 0, byCategory: {}, bySource: {}, updatedAt: 0 }
      const total = state.page?.total ?? 0
      const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)
      const syntaxError = state.page?.error ?? ''


      const submitQuery = () => {
        apply(query)
      }

      /** 打开资产链接：优先用宿主下发的桥，其次 window.open（客户端会转给默认浏览器）。 */
      const openLink = (url) => {
        if (url === '') return
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
          try {
            void navigator.clipboard?.writeText(url)
          } catch {
            /* 剪贴板不可用就算了 */
          }
          notify(t('results.openFallback').replace('{url}', url))
        }
      }

      // 分面 chip：主机资产看**协议族**，Web 资产看**状态码** —— 两套完全不同的分法。
      const chips = view === 'app'
        ? [
            { id: '', label: t('webChip.all'), count: overview.byNodeType?.app ?? 0 },
            ...[200, 400, 403, 404, 500, 502].map((code) => ({
              id: String(code),
              label: String(code),
              count: overview.byStatus?.[String(code)] ?? 0,
            })),
          ]
        : [
            { id: '', label: t('hostChip.all'), count: overview.byNodeType?.endpoint ?? 0 },
            { id: 'http', label: t('hostChip.http'), count: overview.byProtocol?.http ?? 0 },
            { id: 'sql', label: t('hostChip.sql'), count: overview.byProtocol?.sql ?? 0 },
            { id: 'ssh', label: t('hostChip.ssh'), count: overview.byProtocol?.ssh ?? 0 },
            { id: 'ftp', label: t('hostChip.ftp'), count: overview.byProtocol?.ftp ?? 0 },
            { id: 'telnet', label: t('hostChip.telnet'), count: overview.byProtocol?.telnet ?? 0 },
            { id: 'smb', label: t('hostChip.smb'), count: overview.byProtocol?.smb ?? 0 },
            { id: 'rdp', label: t('hostChip.rdp'), count: overview.byProtocol?.rdp ?? 0 },
          ]

      // 本页内同 host 的端点数：只用于第 ③ 行的提示，不假装是全库统计。
      const hostCounts = new Map()
      for (const row of rows) hostCounts.set(row.host, (hostCounts.get(row.host) ?? 0) + 1)

      return h('div', { className: 'ih-assets-grid' },
        h('div', { className: 'ih-assets-main' },
          // 只有出问题时才占一行；正常状态不显示任何标题栏（刷新时间在标签栏里）。
          error === '' ? null : h('div', { style: { fontSize: 12, color: T.error, lineHeight: 1.6 } }, t('state.failed').replace('{message}', error)),
          // 视角切换：系统是默认视图（一个 URL 前缀 = 一个系统），端点是传统测绘粒度。
          // 视角切换：主机资产 = 端点清单（空间测绘那种），Web 资产 = 网站 + 系统。
          h('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
            [['endpoint', t('view.host')], ['app', t('view.web')]].map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              onClick: () => setView(id),
              style: {
                cursor: 'pointer', font: 'inherit', fontSize: 12, borderRadius: 7, padding: '3px 10px', fontWeight: 700,
                background: view === id ? T.text : 'transparent',
                color: view === id ? T.bg : T.text2,
                border: `1px solid ${view === id ? T.text : T.border}`,
              },
            }, label)),
            h('span', { style: { fontSize: 11.5, color: T.text3, marginLeft: 4 } },
              t('view.hint').replace('{systems}', String(overview.byNodeType?.app ?? 0)).replace('{endpoints}', String(overview.byNodeType?.endpoint ?? 0))),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') submitQuery() },
              placeholder: t(view === 'app' ? 'results.searchPlaceholderWeb' : 'results.searchPlaceholderHost'),
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
              onClick: () => setFacet(entry.id),
              style: {
                cursor: 'pointer', font: 'inherit', fontSize: 12, borderRadius: 8, padding: '3px 9px', fontWeight: 600,
                background: facet === entry.id ? tint(T.brand, 0.16) : 'transparent',
                color: facet === entry.id ? T.brand : T.text2,
                border: `1px solid ${facet === entry.id ? tint(T.brand, 0.5) : T.border}`,
              },
            }, `${entry.label} · ${entry.count}`)),
          ),
          // 待确认：判定不了的系统对。合并错了可以拆，所以这里给的是"建议"而不是"结论"。
          view !== 'app' || questions.length === 0 ? null : h('div', {
            style: {
              border: `1px solid ${tint(T.warn, 0.45)}`, background: tint(T.warn, 0.06), borderRadius: T.radius,
              padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
            },
          },
            h('div', { style: { fontSize: 12, fontWeight: 700, color: T.warn } },
              t('questions.title').replace('{n}', String(questions.length))),
            h('div', { style: { fontSize: 11, color: T.text3, lineHeight: 1.6 } }, t('questions.hint')),
            questions.slice(0, 12).map((item) => h('div', {
              key: item.id,
              style: { display: 'flex', flexDirection: 'column', gap: 3, borderTop: `1px solid ${T.border}`, paddingTop: 6 },
            },
              h('div', { style: { fontFamily: T.code, fontSize: 11.5, color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                `${item.payload?.a}  ↔  ${item.payload?.b}`),
              h('div', { style: { fontSize: 11, color: T.text3 } }, item.payload?.reason ?? ''),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('button', { type: 'button', onClick: () => void resolveQ(item.id, 'merge'), style: { ...buttonStyle('primary'), padding: '2px 9px', fontSize: 11 } }, t('questions.merge')),
                h('button', { type: 'button', onClick: () => void resolveQ(item.id, 'keep'), style: { ...buttonStyle('ghost'), padding: '2px 9px', fontSize: 11 } }, t('questions.keep')),
                h('button', { type: 'button', onClick: () => void resolveQ(item.id, 'dismiss'), style: { ...buttonStyle('ghost'), padding: '2px 9px', fontSize: 11 } }, t('questions.dismiss')))),
            ),
            questions.length > 12 ? h('div', { style: { fontSize: 11, color: T.text3 } }, t('questions.more').replace('{n}', String(questions.length - 12))) : null,
          ),
          rows.length === 0
            ? h(EmptyState, {
                title: overview.total === 0 ? t('results.empty') : t('results.filtered'),
                hint: overview.total === 0
                  ? (view === 'app' ? t('results.emptyApp') : t('results.emptyHint'))
                  : t('results.filteredHint').replace('{total}', String(overview.total)),
              })
            : h('div', { className: 'ih-cards' },
                rows.map((row) => h(AssetCard, {
                  key: row.key,
                  t,
                  row,
                  model: cardModel(row),
                  expanded: expandedKey === row.key,
                  onToggle: () => toggleCard(row.key),
                  onOpen: openLink,
                  relations: relations[row.key]?.data,
                  relationsLoading: relations[row.key]?.loading === true,
                  onQuery: apply,
                  sameHostCount: hostCounts.get(row.host) ?? 1,
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
        ),
        h(QueryRail, {
          t,
          view,
          recent,
          applied,
          error: railError,
          onApply: apply,
          onForget: (text) => void forget(text),
          onClear: () => void clearRecent(),
          onHelp: () => setHelpOpen(true),
        }),
        helpOpen ? h(SearchHelp, {
          t,
          view,
          onClose: () => setHelpOpen(false),
          onPick: (syntax) => { apply(syntax); setHelpOpen(false) },
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

    /**
     * 一行的「输入」或「输出」形态多选。
     *
     * 与 CapabilityPicker 同构（复选框 + 全选/清空），但语义不同：能力是"这行能出哪类数据"，
     * 形态是"这行吃什么 / 吐什么"，是工具之间自动串接的依据。勾了「其他」会多出一个输入框。
     */
    /**
     * 一行的「输入」或「输出」形态多选。
     *
     * 与 CapabilityPicker 同构（复选框 + 全选/清空），但语义不同：能力是"这行能出哪类数据"，
     * 形态是"这行吃什么 / 吐什么"，是工具之间自动串接的依据。
     *
     * 输入区的竖排顺序是固定的：
     *   ① 勾选框（最后一个是「其他」）
     *   ② 勾了「其他」→ 它的单行说明（这个"其他"指的是**输入资源**）
     *   ③ 条件关系（与 / 或 / 其他）—— 位置在②之后
     *   ④ 关系选「其他」→ 它自己的单行说明（这个"其他"指的是**组合方式**）
     * 两个"其他"是两件事，说明也各占一行，不能合并。
     */
    function ShapePicker(props) {
      const { entry, field, t, onPatch } = props
      const picked = Array.isArray(entry[field]) ? entry[field] : []
      const otherKey = `${field}Other`
      const other = typeof entry[otherKey] === 'string' ? entry[otherKey] : ''
      const isInputs = field === 'inputs'
      const mode = isInputs ? (entry.inputMode ?? 'or') : 'or'
      const modeNote = typeof entry.inputModeNote === 'string' ? entry.inputModeNote : ''
      // 勾选后按声明顺序重排，避免保存前后顺序抖动导致 dirty 误判。
      const apply = (ids) => onPatch({ [field]: SHAPES.filter((candidate) => ids.includes(candidate)) })
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11.5, color: T.text2 } }, t(field === 'inputs' ? 'config.inputs' : 'config.outputs')),
          h('span', { style: { fontFamily: T.code, fontSize: 11, color: T.text3 } }, `${picked.length}/${SHAPES.length}`),
          h('button', { type: 'button', onClick: () => apply([...SHAPES]), style: buttonStyle('ghost') }, t('config.selectAll')),
          h('button', { type: 'button', onClick: () => apply([]), style: buttonStyle('ghost') }, t('config.selectNone')),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
          SHAPES.map((id) => {
            const on = picked.includes(id)
            return h('label', {
              key: id,
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
                onChange: () => apply(on ? picked.filter((candidate) => candidate !== id) : [...picked, id]),
              }),
              t(`shape.${id}`),
            )
          }),
        ),
        // ② 输入资源是「其他」时的说明（紧跟勾选框）。
        picked.includes('other')
          ? h('input', {
              value: other,
              maxLength: 200,
              onChange: (event) => onPatch({ [otherKey]: event.target.value }),
              placeholder: t('config.shapeOtherPlaceholder'),
              style: fieldStyle(),
            })
          : null,
        // ③ 条件关系：位置在「其他」说明之后，不是插在勾选框那一行里。
        isInputs
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.inputMode')),
              h('select', {
                value: mode,
                onChange: (event) => onPatch({ inputMode: event.target.value }),
                style: fieldStyle({ width: 'auto', fontSize: 12 }),
              },
                h('option', { value: 'or' }, t('config.modeOr')),
                h('option', { value: 'and' }, t('config.modeAnd')),
                h('option', { value: 'custom' }, t('config.modeCustom'))),
              picked.length < 2
                ? h('span', { style: { fontSize: 11, color: T.text3 } }, t('config.modeIdle'))
                : null)
          : null,
        // ④ 关系是「其他」时的说明：支持 a 单独、b+c 组合这种不规则情况。
        isInputs && mode === 'custom'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('input', {
                value: modeNote,
                maxLength: 200,
                onChange: (event) => onPatch({ inputModeNote: event.target.value }),
                placeholder: t('config.modeCustomPlaceholder'),
                style: fieldStyle({ fontFamily: T.code }),
              }),
              modeNote.trim() === ''
                ? h('div', { style: { fontSize: 11, color: T.warn, lineHeight: 1.55 } }, t('config.modeCustomNone'))
                : null)
          : null,
        h('div', { style: { fontSize: 11, color: picked.length === 0 ? T.warn : T.text3, lineHeight: 1.55 } },
          picked.length === 0 ? t('config.shapesNone') : t('config.shapesHint')),
      )
    }

    /**
     * 技能行的主体：上传 / 重传 zip + 显示落地结果。
     *
     * 上传是**立即生效**的动作（不等「保存」）：文件已经解到磁盘上了，配置行只是引用它。
     * 反过来，删行/放弃修改时后端会把没人引用的目录回收掉 —— 两边对齐由 `pruneSkillDirs` 保证。
     */
    function SkillUploader(props) {
      const { entry, t, onPatch } = props
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const files = Number(entry.files) || 0
      const pick = async (file) => {
        setBusy(true)
        setError('')
        try {
          const meta = await uploadSkillZip(entry.id, file)
          onPatch({
            skillName: meta.name ?? '',
            description: meta.description ?? '',
            files: Number(meta.files) || 0,
            bytes: Number(meta.bytes) || 0,
            uploadedAt: meta.uploadedAt ?? '',
          })
          notify(t('toast.skillUploaded').replace('{name}', meta.name ?? ''))
        } catch (cause) {
          setError(describe(cause))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', { style: buttonStyle('primary', busy) },
            busy ? t('config.skillBusy') : files > 0 ? t('config.skillReplace') : t('config.skillPick'),
            h('input', {
              type: 'file',
              accept: '.zip,application/zip',
              disabled: busy,
              style: { display: 'none' },
              onChange: (event) => {
                const picked = event.target.files?.[0]
                // 清空 value：同一个文件连选两次也要触发 change。
                event.target.value = ''
                if (picked !== undefined) void pick(picked)
              },
            })),
          h('span', { style: { fontSize: 11, color: T.text3, lineHeight: 1.6 } }, t('config.skillHint')),
        ),
        error === '' ? null : h('div', { style: { fontSize: 12, color: T.error, lineHeight: 1.6 } }, error),
        files === 0
          ? h('div', { style: { fontSize: 12, color: T.warn, lineHeight: 1.7 } }, t('config.skillNone'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h(Pill, { tone: T.success }, String(entry.skillName ?? '')),
                h('span', { style: { fontSize: 11.5, color: T.text3, fontFamily: T.code } },
                  t('config.skillMeta').replace('{files}', String(files)).replace('{bytes}', String(Number(entry.bytes) || 0)))),
              h('div', { style: { fontSize: 12, color: T.text2, lineHeight: 1.65 } }, String(entry.description ?? '')),
              h('div', { style: { fontSize: 11, color: T.text3, lineHeight: 1.6 } }, t('config.skillScope'))),
      )
    }

    /**
     * MCP 行的表单。
     *
     * `args` / `env` / `headers` 在面板里都是多行文本（一行一个），提交时由宿主侧解析成
     * 数组与键值对 —— 让用户在这里写 JSON 只会写错。读取时既接受数组/对象（已保存的行）
     * 也接受字符串（正在编辑的行）。
     */
    function McpFields(props) {
      const { entry, t, onPatch } = props
      const transport = entry.transport === 'http' ? 'http' : 'stdio'
      const asLines = (value) => {
        if (Array.isArray(value)) return value.join('\n')
        if (value !== null && typeof value === 'object') return Object.entries(value).map(([key, val]) => `${key}=${String(val)}`).join('\n')
        return String(value ?? '')
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpTransport')),
            h('select', {
              value: transport,
              onChange: (event) => onPatch({ transport: event.target.value }),
              style: fieldStyle({ width: 'auto' }),
            },
              h('option', { value: 'stdio' }, 'stdio（本地进程）'),
              h('option', { value: 'http' }, 'http（远程）'))),
          transport === 'stdio'
            ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 260px', minWidth: 0 } },
                h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpCommand')),
                h('input', {
                  value: String(entry.command ?? ''),
                  onChange: (event) => onPatch({ command: event.target.value }),
                  placeholder: t('config.mcpCommandPlaceholder'),
                  style: fieldStyle({ fontFamily: T.code }),
                }))
            : h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 260px', minWidth: 0 } },
                h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpUrl')),
                h('input', {
                  value: String(entry.url ?? ''),
                  onChange: (event) => onPatch({ url: event.target.value }),
                  placeholder: t('config.mcpUrlPlaceholder'),
                  style: fieldStyle({ fontFamily: T.code }),
                })),
        ),
        transport === 'stdio'
          ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 } },
                h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpArgs')),
                h('textarea', {
                  value: asLines(entry.args),
                  onChange: (event) => onPatch({ args: event.target.value }),
                  rows: 3,
                  placeholder: t('config.mcpArgsPlaceholder'),
                  style: fieldStyle({ fontFamily: T.code, lineHeight: 1.6, resize: 'vertical' }),
                })),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 } },
                h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpEnv')),
                h('textarea', {
                  value: asLines(entry.env),
                  onChange: (event) => onPatch({ env: event.target.value }),
                  rows: 3,
                  placeholder: t('config.mcpEnvPlaceholder'),
                  style: fieldStyle({ fontFamily: T.code, lineHeight: 1.6, resize: 'vertical' }),
                })),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px', minWidth: 0 } },
                h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpCwd')),
                h('input', {
                  value: String(entry.cwd ?? ''),
                  onChange: (event) => onPatch({ cwd: event.target.value }),
                  placeholder: t('config.mcpCwdPlaceholder'),
                  style: fieldStyle({ fontFamily: T.code }),
                })))
          : h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('config.mcpHeaders')),
              h('textarea', {
                value: asLines(entry.headers),
                onChange: (event) => onPatch({ headers: event.target.value }),
                rows: 3,
                placeholder: t('config.mcpHeadersPlaceholder'),
                style: fieldStyle({ fontFamily: T.code, lineHeight: 1.6, resize: 'vertical' }),
              })),
        h('div', { style: { fontSize: 11, color: T.warn, lineHeight: 1.65 } }, t('config.mcpHint')),
      )
    }

    function EntryCard(props) {
      const { entry, index, t, onPatch, onChangeType, onRemove } = props
      const [revealed, setRevealed] = useState(false)
      const [confirmRemove, setConfirmRemove] = useState(false)

      const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : []
      const isSkill = entry.type === 'skill'
      const isMcp = entry.type === 'mcp'
      /** 是否已经有内容 —— 决定这一行默认收起还是展开。 */
      const filled = isSkill
        ? (Number(entry.files) || 0) > 0 || String(entry.skillName ?? '') !== ''
        : isMcp
          ? (String(entry.command ?? '') !== '' || String(entry.url ?? '') !== '')
          : entry.type === 'tool'
            ? entry.path.trim() !== '' || entry.description.trim() !== ''
            : entry.baseUrl.trim() !== '' || entry.key.trim() !== '' || entry.apiDoc.trim() !== '' || capabilities.length > 0
      /** 是否**可用** —— 只勾了能力但没填 BaseURL 的行会存下来，但 agent 拿它没法发请求。 */
      const complete = isSkill
        ? (Number(entry.files) || 0) > 0
        : isMcp
          ? (entry.transport === 'http' ? String(entry.url ?? '') !== '' : String(entry.command ?? '') !== '')
          : entry.type === 'tool'
            ? entry.path.trim() !== '' || entry.description.trim() !== ''
            : entry.baseUrl.trim() !== '' || entry.key.trim() !== '' || entry.apiDoc.trim() !== ''

      // 已经配置好的行默认收起（配置区一长就没法看）；刚点「添加一行」的空行默认展开，
      // 因为加完就要填。这是最省事的默认，不用再点一次。
      const [open, setOpen] = useState(!filled)

      /** 收起时的一行摘要：让人不展开也知道这行是什么。 */
      const summaryParts = isSkill
        ? [String(entry.skillName ?? '') || t('config.skillNone'), (Number(entry.files) || 0) > 0 ? `${Number(entry.files)} files` : '']
        : isMcp
          ? [String(entry.transport ?? 'stdio'), entry.transport === 'http' ? String(entry.url ?? '') : String(entry.command ?? '')]
          : entry.type === 'tool'
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
            h('option', { value: 'mapping' }, t('config.typeMapping')),
            h('option', { value: 'skill' }, t('config.typeSkill')),
            h('option', { value: 'mcp' }, t('config.typeMcp'))),
          h('input', {
            value: entry.name,
            onChange: (event) => onPatch({ name: event.target.value }),
            placeholder: entry.type === 'tool'
              ? t('config.nameTool')
              : entry.type === 'skill' ? t('config.nameSkill')
                : entry.type === 'mcp' ? t('config.nameMcp') : t('config.nameMapping'),
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
              isSkill
                ? h('div', { key: 'body', style: { marginTop: 10 } }, h(SkillUploader, { entry, t, onPatch }))
                : isMcp
                  ? h('div', { key: 'body', style: { marginTop: 10 } }, h(McpFields, { entry, t, onPatch }))
                  : entry.type === 'tool'
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
                    h(ShapePicker, { entry, field: 'inputs', t, onPatch }),
                    h(ShapePicker, { entry, field: 'outputs', t, onPatch }),
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
                    // 空间测绘不勾「输出」：它的输出就是上面的「能出哪些数据」，勾两遍等于两个真相。
                    h(ShapePicker, { entry, field: 'inputs', t, onPatch }),
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
          // 形态是两类行共用的，切类型时不丢。
          const base = {
            id: entry.id, type, name: entry.name, enabled: entry.enabled, note: entry.note,
            inputs: Array.isArray(entry.inputs) ? entry.inputs : [],
            outputs: Array.isArray(entry.outputs) ? entry.outputs : [],
            inputsOther: entry.inputsOther ?? '',
            outputsOther: entry.outputsOther ?? '',
            inputMode: entry.inputMode ?? 'or',
            inputModeNote: entry.inputModeNote ?? '',
          }
          if (type === 'skill') {
            return {
              id: entry.id, type: 'skill', name: entry.name, enabled: entry.enabled, note: entry.note,
              skillName: entry.skillName ?? '', description: entry.description ?? '',
              files: entry.files ?? 0, bytes: entry.bytes ?? 0, uploadedAt: entry.uploadedAt ?? '',
            }
          }
          if (type === 'mcp') {
            return {
              id: entry.id, type: 'mcp', name: entry.name, enabled: entry.enabled, note: entry.note,
              transport: 'stdio', command: '', args: [], env: {}, cwd: '', url: '', headers: {},
            }
          }
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
            // 空间测绘的输出由 capabilities 表达，不留 outputs。
            outputs: [],
            outputsOther: '',
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
      const skillCount = draft.filter((entry) => entry.type === 'skill').length
      const mcpCount = draft.filter((entry) => entry.type === 'mcp').length
      const mappingCount = draft.length - toolCount - skillCount - mcpCount

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(Card, { style: { padding: '12px 14px' } },
          h(SectionHeader, {
            title: t('config.title'),
            hint: `${t('config.hint')} · ${t('config.typeTool')} ${toolCount} / ${t('config.typeMapping')} ${mappingCount} / ${t('config.typeSkill')} ${skillCount} / ${t('config.typeMcp')} ${mcpCount}${updatedAt === '' ? '' : ` · ${new Date(updatedAt).toLocaleString()}`}`,
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
            h('button', { type: 'button', onClick: () => setDraft((prev) => [...prev, blankEntry('skill')]), style: buttonStyle('ghost') }, t('config.addSkill')),
            h('button', { type: 'button', onClick: () => setDraft((prev) => [...prev, blankEntry('mcp')]), style: buttonStyle('ghost') }, t('config.addMcp')),
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
      // 计划与覆盖度是**全局**状态（不分视角），所以放在顶部栏，而不是某个 tab 里。
      const [status, setStatus] = useState({ plan: null, coverage: null })
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
            + 'grid-template-columns:56px auto minmax(0,1.3fr) minmax(0,1fr)}',
          '.ih-panel .ih-rec + .ih-rec{border-top:1px solid ' + T.border + '}',
          '.ih-panel .ih-rec-detail{grid-column:1/-1}',
          '@media (max-width:780px){'
            + '.ih-panel .ih-asset{grid-template-columns:minmax(0,2.2fr) 52px 70px minmax(0,1.5fr)}'
            + '.ih-panel .ih-asset .ih-col-meta{display:none}'
            + '.ih-panel .ih-rec{grid-template-columns:52px auto minmax(0,1.4fr)}}',
          '@media (max-width:560px){'
            + '.ih-panel .ih-asset{grid-template-columns:minmax(0,1.8fr) 52px 70px}'
            + '.ih-panel .ih-asset .ih-col-title{display:none}}',
          // ── 资产卡片视图 ─────────────────────────────────────────────
          // 只有资产 tab 放宽：4/5 卡片 + 1/5 语句栏在 920px 里挤不下。
          // 资产区**不能**突破 `--dsh-chat-content-width`：那个变量就是 DSH 会话列的内容宽，
          // 列两侧的留白由它外面的容器给。一旦放宽，面板就会贴边并溢出会话列（真机上发生过）。
          '.ih-panel .ih-assets-grid{display:grid;grid-template-columns:minmax(0,4fr) minmax(200px,1fr);'
            + 'gap:14px;align-items:start;min-width:0}',
          '.ih-panel .ih-assets-main{display:flex;flex-direction:column;gap:12px;min-width:0}',
          '.ih-panel .ih-cards{border:1px solid ' + T.border + ';border-radius:' + T.radius + 'px;'
            + 'overflow:hidden;background:' + T.card + '}',
          '.ih-panel .ih-acard{display:grid;grid-template-columns:3px minmax(0,1fr);min-width:0}',
          '.ih-panel .ih-acard + .ih-acard{border-top:1px solid ' + T.border + '}',
          '.ih-panel .ih-acard-bar{border-radius:0}',
          '.ih-panel .ih-acard-main{display:flex;flex-direction:column;gap:3px;padding:7px 10px 8px;min-width:0}',
          '.ih-panel .ih-acard-row{display:flex;align-items:center;gap:6px;min-width:0}',
          '.ih-panel .ih-acard-endpoint{font-family:' + T.code + ';font-size:12.5px;font-weight:600;min-width:0;'
            + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.ih-panel .ih-acard-badge{flex-shrink:0;font-size:10.5px;line-height:1.5;padding:0 5px;border-radius:5px;'
            + 'font-family:' + T.code + ';white-space:nowrap}',
          '.ih-panel .ih-acard-title{font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;'
            + 'white-space:nowrap}',
          // 字段网格：宽卡片一排放得下好几项，窄了自己折行；空值也占一格（显示 —）。
          '.ih-panel .ih-acard-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));'
            + 'gap:1px 16px;margin-top:2px;min-width:0}',
          '.ih-panel .ih-acard-field{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px}',
          '.ih-panel .ih-acard-label{flex-shrink:0;color:' + T.text3 + ';font-size:10.5px;letter-spacing:.2px;'
            + 'min-width:2.8em}',
          '.ih-panel .ih-acard-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            + 'font-family:' + T.code + ';color:' + T.text2 + '}',
          '.ih-panel .ih-detail{min-width:0;margin-top:6px;border-top:1px solid ' + T.border + ';padding-top:7px}',
          '.ih-panel .ih-tabs{display:flex;gap:2px;align-items:center;min-width:0;overflow-x:auto}',
          '.ih-panel .ih-tab{display:inline-flex;align-items:center;gap:5px;background:transparent;border:none;'
            + 'border-bottom:2px solid transparent;color:' + T.text3 + ';font:inherit;font-size:11.5px;'
            + 'padding:3px 7px;cursor:pointer;white-space:nowrap}',
          '.ih-panel .ih-tab-on{color:' + T.text + ';border-bottom-color:' + T.brand + '}',
          '.ih-panel .ih-tab-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}',
          '.ih-panel .ih-tab-body{height:228px;overflow:auto;min-width:0;margin-top:6px;padding:8px 10px;'
            + 'border:1px solid ' + T.border + ';border-radius:8px;background:' + tint(T.text3, 0.03) + '}',
          // ── 关联块：身份行 + 分组的 chip + 历史时间线 ────────────────────
          '.ih-panel .ih-rel-id{display:flex;gap:6px 14px;flex-wrap:wrap;align-items:baseline;'
            + 'padding-bottom:6px;border-bottom:1px solid ' + T.border + '}',
          '.ih-panel .ih-rel-k{font-size:10px;letter-spacing:.4px;color:' + T.text3 + ';text-transform:uppercase}',
          '.ih-panel .ih-rel-v{font-family:' + T.code + ';font-size:12px;color:' + T.text + '}',
          '.ih-panel .ih-rel-empty{font-size:11.5px;color:' + T.text3 + '}',
          '.ih-panel .ih-rel-sec{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;align-items:baseline}',
          '.ih-panel .ih-rel-label{font-size:10.5px;color:' + T.text3 + ';white-space:nowrap;font-family:' + T.code + '}',
          '.ih-panel .ih-rel-chips{display:flex;gap:4px;flex-wrap:wrap;min-width:0}',
          '.ih-panel .ih-rel-chip{font-family:' + T.code + ';font-size:11px;line-height:1.6;padding:0 7px;'
            + 'border-radius:6px;border:1px solid ' + T.border + ';background:' + tint(T.text3, 0.06) + ';'
            + 'color:' + T.text2 + ';cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;'
            + 'white-space:nowrap}',
          '.ih-panel .ih-rel-chip:hover{border-color:' + tint(T.brand, 0.5) + ';color:' + T.brand + ';'
            + 'background:' + tint(T.brand, 0.08) + '}',
          '.ih-panel .ih-rel-more{font-family:inherit;font-size:10.5px;padding:0 6px;border-radius:6px;'
            + 'border:1px dashed ' + T.border + ';background:transparent;color:' + T.text3 + ';cursor:pointer}',
          '.ih-panel .ih-rel-more:hover{color:' + T.brand + ';border-color:' + tint(T.brand, 0.4) + '}',
          '.ih-panel .ih-rel-hist{display:flex;flex-direction:column;gap:2px;padding-top:6px;'
            + 'border-top:1px solid ' + T.border + '}',
          '.ih-panel .ih-rel-hist-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:' + T.text3 + '}',
          '.ih-panel .ih-rel-hist-note{cursor:help;opacity:.7}',
          '.ih-panel .ih-rel-hist-row{display:grid;grid-template-columns:104px auto minmax(0,1fr) auto;'
            + 'gap:8px;align-items:baseline;font-size:11px;font-family:' + T.code + ';color:' + T.text2 + '}',
          '.ih-panel .ih-rel-time{color:' + T.text3 + ';font-size:10.5px;white-space:nowrap}',
          '.ih-panel .ih-rel-kind{font-size:9.5px;line-height:1.6;padding:0 5px;border-radius:4px;'
            + 'border:1px solid;white-space:nowrap}',
          '.ih-panel .ih-rel-src{color:' + T.text3 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.ih-panel .ih-rel-ip{color:' + T.brand + ';white-space:nowrap}',
          // ── 信息产物：固定高度卡片 + 弹窗 ─────────────────────────────
          '.ih-panel .ih-art-list{display:flex;flex-direction:column;gap:6px;min-width:0}',
          '.ih-panel .ih-art-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;'
            + 'grid-template-rows:auto auto;gap:2px 8px;align-items:center;height:64px;min-width:0;'
            + 'padding:6px 10px;border:1px solid ' + T.border + ';border-radius:' + T.radius + 'px;'
            + 'background:' + T.card + ';cursor:pointer;text-align:left;font:inherit;overflow:hidden}',
          '.ih-panel .ih-art-card:hover{border-color:' + tint(T.brand, 0.45) + '}',
          '.ih-panel .ih-art-kind{grid-row:1;font-family:' + T.code + ';font-size:10px;line-height:1.7;'
            + 'padding:0 6px;border-radius:5px;border:1px solid;white-space:nowrap;flex-shrink:0}',
          '.ih-panel .ih-art-title{grid-row:1;grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;'
            + 'white-space:nowrap;font-size:12.5px;color:' + T.text + '}',
          '.ih-panel .ih-art-sev{grid-row:1;grid-column:3;font-family:' + T.code + ';font-size:10.5px;'
            + 'white-space:nowrap}',
          '.ih-panel .ih-art-meta{grid-row:2;grid-column:1/-1;min-width:0;overflow:hidden;'
            + 'text-overflow:ellipsis;white-space:nowrap;font-family:' + T.code + ';font-size:10.5px;'
            + 'color:' + T.text3 + '}',
          '.ih-panel .ih-art-block{display:flex;flex-direction:column;gap:4px;margin-top:12px;min-width:0}',
          '.ih-panel .ih-art-block-title{font-size:12px;font-weight:700;color:' + T.text + ';margin-bottom:2px}',
          '.ih-panel .ih-art-row{display:grid;grid-template-columns:80px minmax(0,1fr);gap:8px;font-size:12px;'
            + 'line-height:1.7;min-width:0}',
          '.ih-panel .ih-art-label{color:' + T.text3 + ';flex-shrink:0}',
          '.ih-panel .ih-art-value{color:' + T.text2 + ';min-width:0;word-break:break-word;'
            + 'font-family:' + T.code + ';font-size:11.5px}',
          '.ih-panel .ih-art-hit{display:flex;gap:8px;align-items:baseline;font-size:11.5px;min-width:0}',
          '.ih-panel .ih-art-hit code{font-family:' + T.code + ';font-size:11px;color:' + T.text2 + ';'
            + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
          '.ih-panel .ih-art-pre{margin:0;font-family:' + T.code + ';font-size:11.5px;line-height:1.7;'
            + 'color:' + T.text2 + ';white-space:pre-wrap;word-break:break-word;max-height:260px;'
            + 'overflow:auto;background:' + tint(T.text3, 0.06) + ';border:1px solid ' + T.border + ';'
            + 'border-radius:8px;padding:8px 10px}',
          '.ih-panel .ih-rule-row{display:flex;gap:6px;align-items:center;min-width:0;margin-top:4px}',
          // ── 顶部栏的全局状态（计划 / 覆盖度）─────────────────────────
          '.ih-panel .ih-status{display:flex;gap:14px;align-items:center;min-width:0;'
            + 'overflow:hidden;margin-left:6px}',
          '.ih-panel .ih-status-item{display:flex;align-items:center;gap:5px;min-width:0;font-size:10.5px}',
          '.ih-panel .ih-status-label{color:' + T.text3 + ';white-space:nowrap}',
          '.ih-panel .ih-status-track{width:52px;height:4px;border-radius:2px;background:' + tint(T.text3, 0.18) + ';'
            + 'overflow:hidden;flex-shrink:0}',
          '.ih-panel .ih-status-fill{display:block;height:100%;border-radius:2px}',
          '.ih-panel .ih-status-value{font-family:' + T.code + ';color:' + T.text2 + ';white-space:nowrap}',
          '@media (max-width:900px){.ih-panel .ih-status-label{display:none}}',
          // 右侧语句栏：卡片滚动时不动。
          '.ih-panel .ih-rail{position:sticky;top:8px;display:flex;flex-direction:column;gap:10px;min-width:0;'
            + 'border:1px solid ' + T.border + ';border-radius:' + T.radius + 'px;padding:9px 10px;background:' + T.card + '}',
          '.ih-panel .ih-rail-head{display:flex;align-items:center;justify-content:space-between;gap:6px;'
            + 'font-size:11.5px;font-weight:700;color:' + T.text2 + '}',
          '.ih-panel .ih-rail-section{display:flex;flex-direction:column;gap:4px;min-width:0}',
          '.ih-panel .ih-rail-label{display:flex;align-items:center;justify-content:space-between;gap:6px;'
            + 'font-size:11px;color:' + T.text3 + ';text-transform:lowercase;letter-spacing:.2px}',
          '.ih-panel .ih-rail-sublabel{font-size:10.5px;color:' + T.text3 + ';margin:2px 0 1px}',
          '.ih-panel .ih-rail-item{display:flex;align-items:center;gap:4px;min-width:0}',
          '.ih-panel .ih-rail-q{flex:1;min-width:0;text-align:left;background:transparent;border:1px solid transparent;'
            + 'border-radius:6px;padding:2px 6px;font-family:' + T.code + ';font-size:11px;color:' + T.text2 + ';'
            + 'cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.ih-panel .ih-rail-q:hover{background:' + tint(T.brand, 0.08) + ';border-color:' + tint(T.brand, 0.3) + '}',
          '.ih-panel .ih-rail-q-on{color:' + T.brand + ';border-color:' + tint(T.brand, 0.45) + ';'
            + 'background:' + tint(T.brand, 0.1) + '}',
          '.ih-panel .ih-rail-count{font-family:' + T.code + ';font-size:10px;color:' + T.text3 + ';flex-shrink:0}',
          '@media (max-width:1100px){'
            + '.ih-panel .ih-assets-grid{grid-template-columns:minmax(0,1fr) 210px}}',
          '@media (max-width:900px){'
            + '.ih-panel .ih-assets-grid{grid-template-columns:minmax(0,1fr)}'
            + '.ih-panel .ih-rail{position:static;order:-1}}',
        ].join('')),
        h('nav', {
          style: {
            flexShrink: 0, display: 'flex', alignItems: 'center', padding: 0, background: T.card,
            borderBottom: `1px solid ${T.border}`, position: 'sticky', top: 0, zIndex: 20, minWidth: 0, overflow: 'hidden',
          },
        },
          h('div', { className: 'ih-navinner' },
          [['assets', t('tab.assets')], ['artifacts', t('tab.artifacts')], ['records', t('tab.records')], ['config', t('tab.config')]].map(([id, label]) => h('button', {
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
          // 计划与覆盖度：全局状态，放顶部栏，把内容区的空间让给卡片。
          (() => {
            const stages = Array.isArray(status.plan?.stages) ? status.plan.stages : []
            const coverage = status.coverage
            if (stages.length === 0 && (coverage?.total ?? 0) === 0) return null
            const done = stages.filter((stage) => stage.state === 'done' || stage.state === 'skipped').length
            const planPct = stages.length === 0 ? 0 : Math.round((done / stages.length) * 100)
            const stageNow = stages.find((stage) => stage.state === 'active')
              ?? stages.find((stage) => stage.state === 'pending')
            const meter = (key, label, pct, value, hint, tone) => h('div', {
              key,
              className: 'ih-status-item',
              title: hint,
            },
              h('span', { className: 'ih-status-label' }, label),
              h('span', { className: 'ih-status-track' },
                h('span', { className: 'ih-status-fill', style: { width: `${pct}%`, background: tone } })),
              h('span', { className: 'ih-status-value' }, value))
            return h('div', { key: 'status', className: 'ih-status', style: { marginRight: 8 } },
              stages.length === 0 ? null : meter(
                'plan',
                t('plan.stages'),
                planPct,
                `${done}/${stages.length}`,
                stageNow === undefined ? t('plan.allDone') : `${t('plan.current')} ${stageNow.id}`,
                T.brand,
              ),
              (coverage?.total ?? 0) === 0 ? null : meter(
                'coverage',
                t('plan.coverage'),
                coverage.overall ?? 0,
                `${coverage.overall ?? 0}%`,
                t('plan.gap').replace('{n}', String(coverage.uncovered?.length ?? 0)).replace('{total}', String(coverage.total)),
                T.success,
              ))
          })(),
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
                    h(AssetsArea, { t, sessionId, active: area === 'assets', onSynced: setSyncedAt, onStatus: setStatus, openExternalLink: props.openExternalLink })),
                  h('div', { key: 'p', style: { display: area === 'artifacts' ? 'block' : 'none' } },
                    h(ArtifactsArea, { t, sessionId, active: area === 'artifacts', openExternalLink: props.openExternalLink })),
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
       * 纯函数出口，**只给测试用**。
       *
       * 卡片与详情"有数据/没数据"的判断必须能被断言 —— 否则"未采集"很容易在改动中
       * 退化成留白，而那正是用户看不出"到底采没采到"的原因。
       */
      __test: { cardModel, detailModel, BUILTIN_QUERIES },

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
