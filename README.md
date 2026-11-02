# 互联网暴露面收集（InformationHunter）

DSH 插件：一个专做渗透测试「暴露面收集」的 **agent 预设**，外加一块**会话面板**。

- **agent 侧**：主域名 / 子域名 / DNS / 端口 / 服务 / Web / 指纹 / CDN-WAF 逐层收集，边收集边写结构化结果。
- **配置侧**：工具（本地可执行文件 + 用法说明）与空间测绘平台（BaseURL + Key + API 说明）由用户在面板里**动态增删**，全局生效，落地 SQLite。
- **结果侧**：面板实时显示当前会话收集到的资产，可按类型/目标/来源/关键词筛选、分页、删单条、清空。

---

## 安装与验证

本包**没有任何运行时依赖**，也不需要构建步骤：源码就是产物。

```
plugin_manager  action: install_bundle
                target: D:\AI\dsh\InformationHunter
```

安装以目录方式链接工作区（`link:`），所以之后**改文件 + 重启**即可生效，不必重新打包。
装完必须**重启 DSH**：`install_bundle` 返回 `application: restart-required`（`restartReason: unmanaged-plugin`），
本插件的行在插件列表之外运行，热更不会替换已加载的模块。

重启后按这个顺序确认：

1. **新建会话 → 预设选择器里出现「互联网暴露面收集」**。
   （如果看不到，先看「设置 → 智能体预设」：那里会**显示** broken 的原因，而选择器会把 broken 的预设藏起来。）
2. 会话视图顶部多出「暴露面收集」标签页（只在用该预设的会话出现）。
3. 面板「配置」区加一行 → 保存 → 刷新页面后还在（= 落进了 SQLite）。
4. 让 agent 调一次 `expose_config`，看它读到的是不是刚配的那行。
5. 浏览器控制台没有 `[infohunter]` 前缀的警告 —— 每一条都对应一个具体的静默失败点。

不想点界面时，宿主接口可以直接用 curl 验（端口每次启动会变，取 DSH 显示的 Web 地址）：

```powershell
$port = 30289   # ← 换成当前 Web GUI 的端口

# 配置（全局）
curl "http://127.0.0.1:$port/infohunter/config"
# 保存
curl -X POST "http://127.0.0.1:$port/infohunter/config" -H 'content-type: application/json' `
  -d '{"entries":[{"id":"a","type":"tool","purpose":"subdomain","name":"subfinder","path":"C:/t/subfinder.exe","description":"被动子域枚举","enabled":true,"note":""}]}'
# 结果与变更令牌（把 <sessionId> 换成一个真实会话 id）
curl "http://127.0.0.1:$port/infohunter/results?sessionId=<sessionId>"
curl "http://127.0.0.1:$port/infohunter/rev?sessionId=<sessionId>"
```

数据库在 `$DSH_HOME/storages/infohunter.db`（默认 `C:\Users\<你>\.dsh\storages\infohunter.db`）。

### 打包分发

```powershell
pnpm run pack:dist
# 或 node scripts/pack-dist.mjs
```

产物：`dist/infohunter-dsh-information-hunter-0.2.0.tgz`（约 50 KiB，13 个文件）。

装打包件而不是目录时，把 `target` 换成 tarball 路径即可：

```
plugin_manager  action: install_bundle
                target: D:\AI\dsh\InformationHunter\dist\infohunter-dsh-information-hunter-0.2.0.tgz
```

两者区别：**目录安装是 `link:`**，改源码 + 重启就生效，适合迭代；
**tarball 安装是 `file:`**，profile 读的是包内那份拷贝，之后改源码不生效，需要重新 `pack:dist` 再装。

`pack-dist.mjs` 不只是跑 `pnpm pack` —— 它把打出来的 tarball **解开逐条按"装进去之后会遇到什么"验收**：
`files` 白名单里每一条都真的进包、没有 `scripts/`/`node_modules`/lockfile 混进去、
`exports` 指向的文件都在、`locale` 与 `icon` 有效、每个 `.js` 语法通过、
客户端 bundle 的 id 等于包名、包内补丁与源码逐字节一致。
（`files` 漏一项的后果是静默的：运行期读不到 `SKILL.md`，或 `exports["./client"]` 指空，
报错只出现在宿主启动日志的角落。）

---

## 目录结构

```
package.json          清单：exports / files / dsh.bundle.patch / dsh.client
cordis.patch.yml      bundle 补丁：两份声明（Host 半 + agent 预设）
index.js              Host 半：自带 SQLite 后端 + store + 面板 HTTP 接口
assets.js             资产模型（归一化 / 按端点合并）与查询语法（解析 + 匹配）
storage.js            SQLite KV 后端（KvFacet/KvUnit）+ HunterStore（配置与资产）
vocabulary.js         用途分类（kind）的唯一事实源：工具描述与结果校验都用它
preset.js             preset 半：expose_* 工具 + 常驻章程段 + 随包技能注册
client.js             浏览器半：conversation.view 里的面板（结果区 + 配置区）+ 预设门控哨兵
skills/info-hunter-method/SKILL.md   分层方法论技能正文（运行期读包内文件注册）
locale/zh.json|en.json                Plugin Manager 显示的标题与描述
icon.svg                             原创图标
scripts/check-modules.mjs             开发期：安装前体检（YAML / 模块存在性 / 必需 config 键 / 清单）
scripts/smoke.mjs                     开发期：宿主半（存储 / HTTP / 工具定义）
scripts/smoke-client.mjs              开发期：浏览器半（会话预设门控）
scripts/pack-dist.mjs                 开发期：打包到 dist/ 并验收 tarball 内容
scripts/lib/resolve-yaml.mjs          开发期：在插件目录**之外**找 yaml，找不到就降级
dist/                                 打包产物（pnpm run pack:dist）
```

> ⚠️ **插件目录里绝不能有 `node_modules` 或依赖声明。**
> `install_bundle` 把一个带依赖的目录导入 profile 时，pnpm 要为 hoisted 的目标布局重建
> 这些依赖；源目录是 isolated 布局、两边还跨盘（D: → C:），创建目录符号链接在 Windows 上
> 直接 `EPERM`，整次安装失败并把 profile 回滚（连 bundle 选择一起抹掉）。
> 这个包从设计上就是**零依赖、无构建**，`yaml` 只是开发期校验用的，所以它装在
> `../infohunter-tooling/`（插件目录之外）。

`scripts/` 不随包分发（不在 `files` 里）。

---

## 架构与关键决策

这一版是**按 DSH 0.2.x 的插件规范重写**的，不是旧版的补丁。几处刻意选择的理由如下 —— 每一条都对应一个具体的失败模式。

### 1. 纯 JavaScript、零依赖、无构建

`index.js` / `preset.js` / `storage.js` / `vocabulary.js` 只 import `node:*` 内建模块，
`client.js` 只 `require('react')`（浏览器模块表提供）。**没有任何 `@deepseek-ai/*` 的导入**，
因此也不需要声明 peer 依赖 —— 顺带绕开了宿主的版本约束（旧版写死 `0.2.0-rc.2` 的 peer，
而实际运行时是 `0.2.1-rc.2`）。

工具定义是**手写的 JSON Schema**：`ToolDefinition.parameters` 要的就是模型面的 schema，
`defineTool` 只是把一套 DSL 编译成它的语法糖。手写之后就不必为了一个 helper 去引包。

### 2. 自带存储后端，名字叫 `infohunter-sqlite`

`ctx.storage.backend.register(name, backend)` 对**重名硬失败**（`duplicate-backend`）。
本机 profile 里 `@howmp/dsh-pentest` 已经用 `sqlite` 这个名字注册了它的 vendored 后端，
所以引用官方 `@deepseek-ai/dsh-storage-sqlite`（它把名字写死成 `sqlite`）会让那一行整行启动失败 ——
组件列表里一行「异常」，依赖它的域随后全部 `backend-not-found`。

于是本包自带一个薄后端（`storage.js`，约 200 行，`node:sqlite`），注册名 `infohunter-sqlite`。
它只实现 `kv` 这一个 facet，按 `KvUnitDescriptor` 的版本戳建表并**拒绝读比代码更新的介质**。

### 3. 不碰 `storageDomain`

域层要求 `zod` 的 `valueSchema`（多一个运行时依赖），而且要在 profile 里 override
`storage-domain` 的 `routes`。而**补丁的 `config` 是整体替换、从不深合并** ——
那会连带抹掉 pentest / zerozen 的 storage 路由。

所以这里直接用后端注册表的公开面（`StorageBackend` / `KvFacet` / `KvUnit`），自己持有 unit：
没有 zod、不改任何共享行、名字也归自己。

### 4. 面板走同源 HTTP 路由，不走 Remote / 会话命令

面板要读写两样**跨会话**的东西：全局工具配置、当前会话的结果。两者都不是会话日志派生的，
所以既不能靠 session projection，也不适合塞进会话命令（那会把每次保存写成一条 `command` 事件）。

`ctx.webServer.register({ kind: 'prefix', path: '/infohunter', handler })` 是公开的 Host 服务，
同源 `fetch` 即可。附带的好处是**可以在重启后用 curl 端到端验证** —— 对无法点击界面的开发场景，
这是唯一能自证的通路。

Web 层缺失时（headless profile）路由不注册，只打一条 info 日志，工具照常可用。

### 5. 预设里每一行都"失败只降级、绝不抛"

预设里任何一行挂不上，`mountPreset` 就把整条预设标成 `broken`，
而**新会话的预设选择器会直接过滤掉 broken 的预设** —— 用户看到的是"这个预设不存在"，
且宿主日志、浏览器控制台、构建输出全都没有红字。

所以：`preset.js` 的 `inject` 只留最小集（`tools`），store / skills / systemPrompt 一律
`ctx.get` 探测 + 失败降级；补丁里每一行都**取自这套构建自带的 `standard` 预设**（存在性被证明过）。

### 6. 技能走运行期注册，不用 `customSkillDirs`

声明式预设行拿不到包目录：`!!js` 里的 `baseUrl` 是**声明补丁的那个包**的根，不是预设目录。
靠它推 `skills/` 会静默指到不存在的地方（指错目录不报错，只是技能不出现）。

`preset.js` 在激活时读包内 `skills/info-hunter-method/SKILL.md`（按 `import.meta.url` 定位，
链接目录与打包两种形态都成立），解析 front matter 后 `ctx.skills.register()` 注册。

### 7. 面板只在用了该预设的会话里出现（哨兵门控）

`conversation.view` 是**全局** slot：注册一次，每个会话都会多出一个标签页。
而浏览器半**没有任何服务能告诉你当前是哪个会话** —— `ctx.sessions` 只有
`retainInfo` / `binding` / `scope` 这些按 id 的接口，既没有会话列表、也没有"当前会话"；
会话 id 与投影只通过 slot 组件的 props 下发。

所以"注册之前先判断"这件事根本不成立。做法反过来：

1. 在 `conversation.composer.dock`（**list / scope=session / replaceRisk=none**，
   渲染 `null` 就不占任何空间）挂一个**哨兵组件**；
2. 哨兵用 `useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset)`
   读当前会话的预设 —— 逐字照抄官方 `dsh-client-ui-agent-preset` 会话头标签的读法
   （`agentPreset` 投影的值是 `string | null`）；
3. 插件据此注册 / 撤销 `conversation.view` 的那个标签页。

策略是**先隐藏、确认后才显示**：只有明确读到 `information-hunter` 才注册；
`null`（没选预设）、读不到、类型异常都不显示，类型异常时在控制台打一条 `[infohunter]` 警告 ——
不是静默。

> 上一版这里是反的："读不到就无条件注册（面板永不出现更糟）"，而它读的
> `ctx.sessions.list` **根本不存在**（那是照 0.1.x 的记忆写的），所以门控从未生效，
> 每个会话都有一个标签页，且没有任何报错。
> 现在这条路径由 `scripts/smoke-client.mjs` 覆盖：用桩装载真实的 `client.js`，
> 断言"初始不注册 → 本预设注册 → 切走撤销 → 切回再注册 → `null` 不显示 →
> 读不到不显示 → 类型异常不显示且有告警"。

### 8. 边界只加在"行为"上，不加在"目标"上

先说实测到的失败（`session-306cf2db`）：预设给了 `pwsh`，于是模型为了回答"我有哪些工具"，
顺手扫了 PATH、递归遍历了磁盘上的工具库、执行了没配置的二进制（fscan / whatweb / ffuf / naabu…），
还对外连了 fofa.info、crt.sh、8.8.8.8 并调了一次 FOFA API。
它自己在那一轮里承认："提示词里没有任何一句话授权这个"。

**关键区分：那次越界全是「行为」越界（扫盘、跑未配置的程序、乱连地址），不是「目标」越界。**
所以修法是把通用逃逸口拆掉，而不是发明一个目标白名单：

预设里不再有 `tool-pwsh` / `tool-bash` / `tool-fs` / `tool-fs-search` / `tool-jobs`，
`tool-web` 也关掉了 `fetch`（只留 `web_search`）。这个 agent 能碰到外部世界的方式只剩四条，
全部是本插件自己的代码：

| 入口 | 硬约束（都是能力层面的） |
| --- | --- |
| `expose_tool_run` | 工具必须在面板配置里（**配置即能力**）；`args` 是数组、`shell: false`（没有管道 / `;` / 重定向 / 命令替换）；参数条数、单参长度、stdin、超时、输出都有上限 |
| `expose_mapping_call` | 只打配置里的平台 |
| `expose_run_query` | 只读 `$DSH_HOME/infohunter/runs/` 下自己写的文件，`runId` 过白名单（防路径穿越） |
| `web_search` | 搜索引擎查询，不接触任意外部主机 |

于是「面板配置」从一句提示词变成了一条代码路径：想用 fscan，必须在面板里显式加一行；
没加就跑不了，且没有任何别的执行入口。

> **刻意不做目标白名单。** 一开始我确实加了一层"授权范围（域名/IP/CIDR）"，但那是错的：
> 资产收集的**产出就是范围本身**。要求用户先把域名/IP 枚举出来再开始，等于让他先做完再去做。
> 而且这是纯收集、没有攻击行为，"对目标的授权"这个概念在这里本来就不成立。
> 所以这一层被完整删除了 —— 面板回到两件事：**配置工具** 与 **展示结果**。
> 目标不需要预先登记；`expose_tool_run` 的 `target` 只是写进 run 头便于回溯，不做任何许可判断。

> 剩下的代价是**没有管道**。`subfinder | httpx` 这种组合不能直接写了 ——
> 要么用 `expose_run_query` 把中间结果挑出来，再作为下一次 `expose_tool_run` 的 `stdin`，
> 要么用一个能一次做完的配置工具。这是刻意的取舍：能拼 shell 就等于能绕过"配置即能力"。

---

## 面板

标签栏右侧显示**插件版本**（`v0.2.5`）。版本由宿主从包内 `package.json` 读到后经 `/infohunter/version`
下发，不是手写常量，所以显示的就是实际装进去的那一份。

客户端 bundle 里另有一个 `CLIENT_VERSION` 常量，用来识别**页面是旧的**：改完 `client.js` 没刷新时，
宿主已更新而界面还是旧代码，此时标签栏会显示 `v0.2.6 · 需刷新`（警示色），鼠标悬停给出详情。
这两个版本号的一致性由 `check-modules.mjs` 硬断言，不会静默漂移。

### 配置区（全局，所有该 agent 的会话共用）

这就是面板的全部两件事之一：**配置工具**。两种行类型，点「添加一行」动态增：

| 类型 | 字段 |
| --- | --- |
| **工具** | 用途**单选**、名称、**工具文件路径**、**工具说明**（给模型看：怎么调、参数、输出形状、注意什么） |
| **空间测绘** | **能出哪些数据（复选框，多选）**、名称、**BaseURL**、**Key/Token**、**API 使用说明**（查询语法、示例请求、返回字段、配额）、备注 |

**为什么两种类型的"能做什么"控件不一样。** 工具是专用程序，一个可执行文件干一件事 ——
`subfinder` 就是子域枚举，用单选"用途"表达最准确。

空间测绘是**综合查询**：一次 FOFA / Quake / Hunter 查询往往同时给出域名、IP、端口、协议、
banner、标题、指纹、证书。用单选用途会把它压扁成"只会查端口"，模型就无从判断
「缺端口数据该问哪个平台」。所以映射行用**复选框**勾选它能返回的数据种类，
而这些 id 与资产分类、`expose_config` 的能力筛选共用同一套取值。

体现到模型侧，`expose_config` 的输出是：

```
[工具] subfinder — 用途 subdomain（子域名收集）
  路径: C:/Tools/subfinder.exe
  说明: 被动子域枚举…
[空间测绘] FOFA — 能出: 子域名收集(subdomain)、端口扫描(port)、Web 探活与目录(web)、指纹识别(fingerprint)、证书 / CT 日志(cert)
  BaseURL: https://fofa.info/api/v1
```

于是 `expose_config({ purpose: 'port' })` 会命中 FOFA（它勾了 port），而排除只做子域的工具。

**每行可以收起。** 已经有内容的行**默认收起**，只留一行摘要
（`类型 + 名称 + 路径/BaseURL + 用途或能力数`）；刚点「添加一行」的空行**默认展开**，
因为加完就要填。点左侧的 `▾ / ▸` 或直接点摘要那一行都能展开。这样配了十几行也不会拉成一长条。

每行还有「启用」开关与备注。Key 在面板里**默认打码**（保留后 4 位），点「显示」才明文 ——
但它是原样交给 agent 的（agent 要拿它发请求），面板里有一句提示说明这件事。
有未保存修改时会出现「有未保存的修改」角标与「放弃修改」；点「保存」才落库。
未填完的行会标「未填完（agent 会当它不存在）」；只勾了能力、还没填 BaseURL 的行也会保留
（否则"先勾选、后填 URL"的常见顺序会丢掉勾选）。

### 结果区（按会话）：两个视图，各管一件事

面板分三个标签：**资产清单** / **采集记录** / **配置**。

| 视图 | 是什么 | 行数 |
| --- | --- | --- |
| 采集记录 | 过程流水：一行一次观测，按时间倒序，不合并，保留 agent 写的证据原文 | 有多少次观测就有多少行 |
| 资产清单 | 结果：同一批记录按 `host:port` 汇总，同端点合并（补空字段、来源取并集） | 端点数 |
| 配置 | 全局工具与空间测绘平台 | — |

两者由**同一次 `expose_record` 调用**同时写入，所以不会互相漂移，agent 也不需要写两遍。

**资产清单**是密集列表，一行一条（不是大卡片）：`域名 / IP:端口` · 状态与分类 · 标题 ·
服务/来源。窄的时候按列退让（先隐藏「服务/来源」，再隐藏标题），不会横向溢出。

顶部是**语法搜索**，与模型侧 `expose_asset_query` 共用同一套解析器：

```
status=200 AND port=443
web.status=200
port=22 OR port=6379
title~后台 AND tech=nginx
(category=web OR category=service) AND status!=404
```

字段：`host` `ip` `port` `protocol` `category` `status` `title` `server` `tech`
`cert.subject` `cert.issuer` `cert.san` `cert.notAfter` `banner` `service` `version`
`source` `target` `confidence`；运算符 `=` `!=` `~` `>` `>=` `<` `<=`；`AND` / `OR` 与括号，
`AND` 优先级高于 `OR`；相邻条件省略 `AND` 也生效。语法写错时把错误显示在搜索框下面（不是 500）。

数据每 2 秒比对一次变更令牌（值变了才重取），页面不可见或切到配置区时停止轮询。

**来源是集合，不是一句话。** 一条资产可能由多个工具/平台产出或印证，所以存的是
`sources: string[]`，卡片显示成 `fofa · ksubdomain`，概览按单个名字计数 ——
选项数等于你配的工具数，不会因为组合写法炸开。

**老数据会自动迁移。** 介质里旧的 `results` 表（一行一次观测）在加载时按 `asset` 转成端点：
能拆出端口就拆，`detail` 落到 `banner`，`kind` 记进 `note`，同一端点的多行合并成一条。
迁移是幂等的，重复加载不会产生重复资产。

---

## agent 工具

六个，均为 preset 作用域（只对这个预设的 agent 可见）：

| 工具 | 作用 |
| --- | --- |
| `expose_config` | 读启用中的配置行（工具路径/说明、平台 BaseURL/Key/API 说明、平台勾选了能出哪些数据）。开工第一件事；可按 `type` / `purpose` 收窄。 |
| `expose_tool_run` | **唯一的执行入口**。只跑面板配置里的工具，`args` 是参数数组（不过 shell，因此没有管道/`;`/重定向）。`target` 可选，只写进 run 头便于回溯，**不做许可判断**。完整输出存成 `runId`。 |
| `expose_run_query` | 在某个 `runId` 的完整输出里检索（代替 `grep`）。 |
| `expose_mapping_call` | 按配置里的平台发一次 GET/POST 查询，自动注入 Key（query / header / none），返回响应体（可截断）。 |
| `expose_record` | 记录一次观测。同一次调用写两处：「采集记录」追加一行（不合并，保留证据原文），「资产清单」按 `host:port` 汇总（同端点合并）。返回记录数与资产新增/合并数。 |
| `expose_asset_query` | 用上面那套语法查本会话资产，按最近观测倒序返回精简列表。 |

`kind` 的取值（也是结果区的分组依据、空间测绘能力的取值范围）：
`main_domain` `subdomain` `port` `service` `web` `fingerprint` `dns` `cert` `osint` `cdn` `screenshot` `other`
（`other` 只对工具有意义，不作为空间测绘的可勾选能力）。

另有常驻章程段（`infohunter:method`，order 60）与技能 `info-hunter-method`：

- **章程装判据**：先读配置、边收边记、什么算观测到、事实/可疑/推测三类判定、边界与节奏、
  前置层怎么分。这些是每次决策都要用的东西，必须常驻。
- **技能装招式**：泛解析基线与三级验证、CT/测绘/历史快照挖子域、命名规则归纳、端口与路径清单、
  指纹来源可靠性排序、CDN 归属判断、七类假结果速查。只在真要做那一层时加载。

章程里有一句硬指令：「进入某一层的深水区之前，先加载 info-hunter-method 技能」——
技能靠模型自觉加载是靠不住的，得把"什么时候加载"写成纪律。技能正文约 2.9k 字，
常驻成本只有它那句 126 字的 `description`。

### 自己上传技能（面板 → 配置 → 技能行）

技能行是配置里的第三种类型。上传一个 zip，解到 `$DSH_HOME/infohunter/skills/<行 id>/`，
**注册进本预设的层** —— 用这个预设的每个会话都能看到，其他预设读不到。这不是我们自己的约定，
是 `skills` 服务本来的语义：注册落在调用上下文的 scope 里，而预设挂载的插件就是预设层。

上传即生效，不用重启：`preset.js` 订阅配置变更，收到就把这一批技能全部撤掉重注册。

**校验（不合规的包直接拒绝，不落地）**

| 检查 | 上限/规则 |
|---|---|
| zip 格式 | 只认 store / deflate，加密位为 1 拒绝，不支持 ZIP64 |
| 路径穿越 | 绝对路径、盘符、`..` 一律拒绝 —— 解压目录由**行 id** 决定，zip 里的路径只用来建子目录 |
| 体积 | 单文件 4 MB、解压后总量 20 MB、条目 200 个（`inflateRawSync` 带 `maxOutputLength`，压不住就抛） |
| 必备文件 | 根目录必须有 `SKILL.md`，frontmatter 要有 `name`（kebab-case）与 `description`，且正文非空 |

**生命周期**

- **重传 = 覆盖**：同一行 id 落地到同一个目录，先解到 `.tmp` 再 `rename`，中途失败不会弄坏旧技能。
- **删行 = 删文件**：保存配置时按"仍被引用的行 id"回收目录（`pruneSkillDirs`）。
  面板允许"放弃修改"，所以上传过但没保存的行也会被回收 —— 否则目录会越攒越多而模型看不见。
- **重名**：与内置 `info-hunter-method` 或另一个用户技能重名时，注册名自动加 `-<6位后缀>`
  （由行 id 派生的稳定哈希，刷新前后不变）。文件内容不动，只改注册名。

为什么要自己解析 zip：本包零依赖是硬约束，而 Node 的 `zlib` 已经提供 `inflateRawSync`，
剩下只差一个中央目录解析器（`skillpack.js`，一百多行）。

### MCP server（面板 → 配置 → MCP 行）

一行 = 一个 server，两种传输：

| 传输 | 字段 |
|---|---|
| `stdio` | `command` + `args`（一行一个）+ `env`（`KEY=VALUE`）+ `cwd` |
| `http` | `url` + `headers`（`KEY=VALUE`） |

保存后立刻连接（配置变更即重连，**不用重启**）：握手 `initialize` → `tools/list`，
把每个远端工具注册成 `mcp__<server>__<tool>`，直接进本预设的工具目录，模型看到的参数
就是远端给的 `inputSchema` —— 一个字段都不改（改了就是编造契约）。

**为什么不用 `@deepseek-ai/dsh-mcp-client`**：那个插件是"一个实例管一个 server"，
只能在组合 YAML 里静态声明，没有动态挂载入口。面板要"加一行就多一组工具"，只能自己管连接；
硬来的话得 `import()` asar 里的模块对象再 `ctx.plugin()`，等于把可移植性绑死在这台机器这个版本上。

`mcp.js` 只覆盖用得到的部分：

- **stdio**：换行分隔 JSON-RPC（不是 LSP 的 Content-Length），子进程 stdout 只当协议流，
  非 JSON 行直接丢弃（有些 server 会往 stdout 打日志）；服务端反向请求一律回 `-32601`，不让对方干等。
- **http**：POST JSON-RPC，响应支持 `application/json` 与 `text/event-stream`
  （SSE 按 `data:` 帧取匹配 id 的那条），`Mcp-Session-Id` 拿到就回带。
- **失败隔离**：一个 server 连不上只留一条 warn、`expose_config` 里显示"连接失败"，
  本插件自己的工具和其他 server 照常工作。
- **超时**：握手与列表 20 秒、单次调用 60 秒；关连接时 kill 子进程。

### 探索图：线索 → 路 → 发现

长会话里模型会忘掉"为什么采过这条、还有哪条没走"。探索图把这件事落库：

- **线索**（`expose_clue`）：主域名、证书 SAN、ICP、C 段、必应命中、产物里的域名；
- **路**（`expose_direction`）：`(对象, 方法, 参数, 目的)` 四元组，判据是"重跑能得到同一批结果"；
  `done` = 走完了（没收获也算），`dead` = 走不通（必须写原因）；
- **发现**：每次落库自动生成，挂到路上；
- **硬闸**：`expose_record` / `expose_artifact` 必须带 `directionId`，否则拒收
  （`settings.collection.enforceDirection` 可关）。

面板「资产清单」顶部有「探索图」按钮，抽屉里按线索分组显示每条路：工具 · 目标 · 参数 · 状态 · 产出。

### 派活：主代理调度，子代理干活

大输出、可独立、可结构化的活派给子代理（端口扫描、子域枚举、批量指纹、批量验活）；
主代理只做选路、派活、校验、落库。子代理返回固定形状的 JSON（findings / clues / negative / errors），
不写库、不做系统归属判定。同一 target 的分层是依赖链，串行；不同 target 并发 3–5。

### 验活：空间测绘的结果必须二次验证

测绘平台/搜索引擎的条目经常是几个月前的：端口关了、站点换了、证书过期了。所以有 `expose_verify`：

- **TCP 连通性**（IP + 端口）——还开着吗；
- **HTTP(S) 一次 GET**——状态码 / 标题 / 响应头 / 正文 / TLS 证书；
- **连不上** → 标 `lifecycle: dead`（面板角标「失效」），**数据保留不删除**；
- **连得上** → 标 `live`，并把这次观测到的字段合并进去（证书、响应头、正文一起补上）；
- 回执列出**变更**：状态码 200→404、标题换了、协议变了。

缺省验证本会话全部 Web 端点（上限 30，可调 60），也可以显式指定 `targets`。
`lifecycle=dead` 可以直接作为查询语法过滤失效资产。

### 基础补全：DNS / 证书 / 响应头 / 正文

用户配置的工具经常只回"端口开着、状态码是多少"，不给证书、响应头、正文 —— 而面板「详情」页签
读的恰恰是这些。所以插件自带一层兜底（`fetch.js` + `expose_enrich`）：

- **DNS**：`resolve4/6/Cname`，补"这个域名解析到哪个 IP"；
- **HTTP(S)**：GET 一次，取状态码、响应头原文、标题、正文摘要（去标签、最多 8KB）；
- **TLS 证书**：从 `socket.getPeerCertificate()` 取主体 / 签发者 / SAN / 到期；
- **自动落库**：调用即写入记录与资产，不需要模型再抄一遍。

顺序永远是**先用户工具、再用它补**。安全边界：只发 GET、超时 8 秒、最多 3 次跳转、
一次 20 个目标并发 4、默认拒绝回环与云元数据地址（避免被当成 SSRF 跳板）。
证书校验关闭（`rejectUnauthorized: false`）——收集阶段经常会遇到自签/过期证书，记录它而不是看不到。

### 信息产物（artifacts）：第 3 个 tab

云资源、泄露物、API 文档、凭据、安装包这些**以文字为主**的发现，不进资产表 —— 它们没有统一格式，
也不是"可定位的端点"。所以在「资产清单」和「采集记录」之间单独一页：

- 一条产物 = 一张**固定高度卡片**（64px）：类型徽标 + 标题 + 命中数 + 来源/时间；
- 点开是弹窗：**来源 / 如何发现 / 产物内容 / 命中规则**；`credential` 类默认打码，点「显示原文」才展开；
- 同一产物重复提交只累加 `count`（指纹 = `sha1(kind|title|content)`），不会刷出一堆重复行；
- 产物**不提供删除**（和资产、记录一致）。

#### 敏感信息正则配置

页面顶部「⚙ 设置」打开配置弹窗，**按 section 渲染**：目前只有 `sensitive`，以后加配置项
只需加一条 section 定义 + 一处服务端校验，不动存储层（未知 section 原样保留）。

- 默认 10 条规则：AWS AK/SK、阿里云 AK、PEM 私钥、GitHub Token、JWT、数据库连接串、口令赋值，
  以及默认**关闭**的手机号与身份证；
- 保存时逐条编译，坏正则整份拒绝并指出第几条；
- 写入产物时扫描，命中写进 `hits[]` 与 `severity`（取最高级）；
- 规则改过之后可以「按当前规则重扫」，不用重记。

### 两个视角：主机资产 / Web 资产

资产清单不再按"系统 / 端点"分，而是按**资产面**分：

| 视角 | 装什么 | 卡片显示 | 分面 chip |
|---|---|---|---|
| **主机资产** | 端点清单（空间测绘那种），**含 web 端点** | `ip/域名:端口`，**不带协议前缀**（协议字段仍保留真实值） | 全部 / http·https / sql / ssh / ftp / telnet / smb / rdp |
| **Web 资产** | 所有 web 面：`scheme://host:port/` 根路径 + 探测出的系统（`/admin/`、`/tenant/`） | 完整 URL | 全部 / 200 / 400 / 403 / 404 / 500 / 502 |

- 主机资产的分面是**协议族**（`protocolFamily`），只看实测到的 `protocol`/`service`，绝不按端口号猜；
- Web 资产的分面是**状态码**（`WEB_STATUS_FACETS`），只认真实观测到的状态码；
- 只要观测到 `http`/`https`，端点就会自动长出一个**根路径 Web 资产**（`https://h:8080/`），
  标记 `derived`（卡片上显示「根路径」），不冒充模型显式登记的系统；
- 两个视角的**过滤语法不同**：主机看 `protocol~sql` / `port=22` / `service~redis`，
  Web 看 `status=200` / `path~/admin/` / `title~后台`。右侧语句栏与「?」帮助都按视角切换。

### 系统（app）：Web 资产里的"系统"

**一个端点下可能挂着多个系统**（nginx 反代、微服务）：`https://h:8080/tenant/` 与
`https://h:8080/admin/` 是两个系统，不是一条 `h:8080`。所以资产表有两种节点：

| nodeType | 键 | 说明 |
|---|---|---|
| `endpoint` | `host:port` | 网络可达点（主机资产视图） |
| `app` | `scheme://host:port/basePath` | HTTP 之上的**系统**（Web 资产视图）；同一端点可多个 |

键的规则：scheme 参与（http/https 是两个入口）、显式端口不省略、basePath 统一成 `/x/`、
**不按目录猜 basePath**（只认模型显式给的 `basePath`，或 `kind=app` 的入口 URL 路径）。

#### 怎么判断"是不是同一个系统"

三件事，**三选二**：

| 项 | 命中条件 | 必须排除 |
|---|---|---|
| 前端应用 | `entryScript` / `templateHash` / `assetPrefix` 任一相同 | — |
| 认证域 | `loginUrl` 相同，或业务 `cookieNames` 有交集 | `_ga`、`SERVERID` 等匿名/粘滞 cookie |
| 后端应用 | `tech` 框架集合有交集，或错误页指纹相同 | **`Server` 不计入**（nginx 反代下全一样）、通用服务器名 |

命中 ≥2 → 同一系统（自动合并，可拆）；**恰好 1 → 判不了，进问题池**；0 → 不同系统。
硬边界：scheme / host / port 任一不同则不进入判定。

#### 内容页不是系统

路径带长数字 ID、slug、query 主导、标题像"详情/列表/第 N 页"、或骨架与已知系统相同的页面，
一律 `pageType=content`，**只进系统的 `urls[]` 证据**，不建系统。静态资源记 `asset`、
`/api/` 记 `api`。于是"必应搜出门户一堆标签/资讯"不会变成几百个系统：系统数不变，
涨的是 URL 证据（去重、封顶 200）。

#### 问题池

判定不了的系统对写进 `questions` 表（按会话），面板「待确认」区可一键**合并 / 保持分开 / 先不管**；
任务收尾时 agent 也会调 `expose_question_list`，用 `ask_user_question` 一次性问清。
合并只是引用（`mergedInto` + `mergedFrom`），**可逆**：拆分不丢任何 URL 证据。

### 资产清单：卡片 + 四页签详情

资产 tab 是 **4:1 两栏**：左边卡片流，右边过滤语句栏。

**宽度始终跟随 `--dsh-chat-content-width`**（DSH 会话列的内容宽），面板自己不放大 ——
那个变量之外的两侧留白是会话列外层容器给的，面板一旦突破就会贴边并溢出（真机上发生过一次，
`smoke-client` 现在会断言这件事）。所以 4:1 是在会话列内部分配：右栏 `minmax(200px,1fr)`，
`≤1100px` 压到 210px，`≤900px` 变单列、语句栏移到卡片上方。

卡片折叠态三行（目标 ≤ 88px）：端点（含判定标记/状态/协议/复制/详情）、标题（或 banner 首行）、
元信息（指纹 · IP · 来源 · 最近观测）。展开后是**手风琴**式四页签：

| 页签 | 内容 | 缺数据时 |
|---|---|---|
| 证书 | 主体 / 签发者 / 到期 / SAN（可点筛） | 「未采集到证书」 |
| 响应头 | `headers` 原文、`banner` | 「未记录原始响应」+ 已知的 status/server/tech |
| 正文 | `body` 可读文本 + 字数 | 「未提交正文」 |
| 关联域名·IP | 同 IP / 同 CNAME / 证书 SAN / 同 host 端口 + 历史记录 | 「暂无关联」 |

页签上有实心/空心小圆点：一眼看出哪页有东西。**"未采集"是显式状态，不是留白** ——
这是刻意的：留白会让人以为"没采到"和"没渲染"是同一件事。

关联的**历史**区来自采集记录，逐条带时间/来源；只有记录里**结构化写过 `ip`** 的才显示 IP，
不从 `detail` 自由文本里正则捞（那是把证据当结论）。历史标注一句话：
「采集当时的观测，不代表现在的解析结果」。

为此 `expose_record` 增加了 `headers` / `body` 两个字段（响应头 2 KB、正文 8 KB），
资产与记录各存一份；不提交就是「未采集」。

### 右侧过滤语句栏

- 上半**最近使用**：全局持久化（新表 `queries`，`UNIT_VERSION` 2→3），任何会话共享；
  上限 **5 条**，按最久未用淘汰；大小写不敏感去重；语法错误与空白不记录。
  这是**面板偏好**，所以允许删除/清空 —— 与"资产与记录不允许删除"不是一回事。
- 下半**内置常用**：排查（`title=""` / `category=unknown` / `port!=0`）、Web、服务、证书、判定。
  每一条都在 smoke 里断言过能被 `parseQuery` 解析，防止以后加错。



### 输入/输出形态：工具怎么自动串起来

工具行声明**输入形态**与**输出形态**（多选，另有一个"其他"可自己写）；
空间测绘行只声明**输入**——它的输出就是它勾选的「能出哪些数据」（`capabilities`），
再叠一个输出多选就是第二个真相，所以那里故意没有。

形态是同一套 id 的数据量纲：`main_domain` `subdomain` `ip` `cidr` `port` `endpoint` `url`
`protocol` `service` `banner` `status` `title` `tech` `cert` `email` `credential` `source_code` `shot` 等。

规则只有一条：**A 的输出命中 B 的输入，B 就是 A 的下游。** 模型据此把 A 的结果直接喂给 B，
不需要认识那个工具 —— 这正是用户自配的冷门工具能参与协同的原因（模型光看名字猜不出它的参数）。
`expose_config` 支持 `needs` / `produces` 反查："我手上有子域名，谁能往下做"与"我要 IP，谁能给我"；
`produces` 对工具看 `outputs`，对空间测绘看 `capabilities`。`needs` 也接受数组（"这些我都有"）。

### 输入的条件关系

勾了两个以上的输入，末尾会出现一个关系选择：

| 关系 | 渲染成 | 含义 |
|---|---|---|
| 或（任一即可，缺省） | `主域名 / IP（任一即可）` | 手上有其中任何一个就能调 |
| 与（需同时） | `IP + 端口（需同时）` | 必须凑齐勾选的全部 |
| 其他（自己说明） | `主域名、IP、C 段（关系: 主域名单独可用；域名 + IP 需组合）` | 关系不规则，以那段文字为准 |

只有多于一个输入时才出现 —— 一个输入不存在与/或的问题。选了「其他」却没写说明，
渲染成 `关系: 未说明 —— 问用户`，逼模型开口而不是猜。

为什么不让模型自己判断：它不认识这个平台，猜错的代价是**用不成立的前提查询、返回空**，
然后把空解释成"这个目标没有资产"（假结果）。让用户点一下，比让模型每轮推理便宜且可靠。

### 判定标记

资产清单收录**一切观测到的端点**，状态码与协议只是字段，不是准入门槛。
可不可信由 `verdict` 表达，面板把它标在 `host:port` 右边：

| verdict | 面板 | 含义 |
|---|---|---|
| `fact` | 不标 | 直接观测到的原值（状态码、证书主体、banner 原文） |
| `suspect` | 可疑 | 观测到了，但可能是拦截页 / 默认页 / 停放页 / 泛解析假子域 / 未经响应验证的 host 碰撞 |
| `infer` | 推测 | 靠推理链得出（证书 SAN 同组织、CNAME 指向 CDN 所以"应该是托管"） |

没给 `verdict` 的观测不会抹掉已有标记；后续拿到直接证据写 `fact` 才清掉。

资产与采集记录都是**只读证据**：面板与 HTTP 接口都没有删除/清空端点。

### 空间测绘节流

`expose_mapping_call` 对同一个平台**强制串行 + 随机 3–10 秒间隔**，从上次请求**结束**时刻起算，
等待时长会写进返回文本（`（节流等待 4.2 秒）`）和 `waitedMs` 字段。

为什么写进代码而不是提示词：章程里那句"随机延迟 3–10 秒"是自觉，而模型天生爱并发连发；
节流状态放模块级而不是每次 `apply` 一份，因为配置与 Key 本来就是全局的，多个会话/子代理
共享同一份配额，节流也必须共享。等待期间被中断会放行队列，不会把这个平台永久堵死。

测试可用 `INFOHUNTER_MAPPING_GAP_MS` 覆盖间隔（smoke 用它压到 60ms）；不设就是 3–10 秒。

预设还带了扇出能力（`subagent` / `subagent_fork` / `workflow`）：大范围目标可以按子域或网段分工、
或用 workflow 对几十个目标做同构探测。另外有 `time-context`（证书有效期/CT 时间窗要对时）、
`plan-mode`、`goal`（多阶段长任务）与
`tool-result-pruner`（原始扫描输出最容易撑爆上下文，threshold 8 KiB 以上自动剪头尾）。

`plan-mode` 的段落（替换 DSH 默认文案）写的是**收集计划**：覆盖哪几层、用什么工具或平台、
先后顺序、并发与节奏、结果怎么记怎么验证。它明确两件事 —— 计划模式里不做主动探测（列进计划等批准），
以及**不要要求用户先给范围**（范围是这一轮的产出，起点不清楚就把问题列在计划末尾）。

---

## 排查

| 现象 | 先看哪里 |
| --- | --- |
| 预设选择器里没有这一项 | **设置 → 智能体预设**：broken 的卡片会显示原因（选择器不显示） |
| 面板出现在**所有**会话 | 0.2.2 已修（见"哨兵门控"）。若仍出现，看控制台 `[infohunter]` 有没有关于 `agentPreset` 的警告 |
| 面板在**本预设**会话里也不出现 | 该会话的预设是否真的是「互联网暴露面收集」；控制台 `[infohunter]` 是否报了读不到 `useSessions` / 投影类型异常 |
| 面板顶部报「接口请求失败：HTTP 404」 | 0.2.3 已修（webServer 晚到时没挂上路由）。若仍 404，用 `curl` 打同一端口确认；再不行说明前缀路由没匹配，改成每端点一条 exact 路由 |
| 保存后刷新就没了 | `$DSH_HOME/storages/infohunter.db` 是否被创建；宿主日志里 `[infohunter]` 的 warn |
| agent 说没有工具 | 面板配置里是否有**启用**的行；`expose_config` 的返回 |

开发期四个脚本（都需要 `pnpm add -D yaml` 装一次开发依赖；都不随包分发）：

```powershell
node scripts/check-modules.mjs   # 安装前体检（YAML / 模块存在性 / 必需 config 键 / 清单 / 语法）
node scripts/smoke.mjs           # 宿主半：存储层 / HTTP 端点 / 工具定义形状
node scripts/smoke-client.mjs    # 浏览器半：会话预设门控（标签页只在该预设的会话里出现）
node scripts/pack-dist.mjs       # 打包到 dist/ 并验收 tarball
```

`pnpm test` 会依次跑前三个。

`check-modules.mjs` 查的是那些**只会静默失败**的东西：

1. `cordis.patch.yml` 的 YAML 语法与 Loader 结构（`insert` / `group` / `isolate` 用对了地方）；
2. 每个被引用的模块在这套构建里**真的存在**（逐一对 `app.asar` 校验 —— 机器上别的 Electron 应用
   也有同名文件，所以候选必须按内容验证）；
3. 已核实为**必需**的 config 键一个不少，`compaction-tool-result-pruner` 的键在白名单内、
   且 `headChars + tailChars < thresholdChars`；
4. 本地 `exports` / `files` / 客户端半 / `locale` / `icon` 全部可解析；
5. 每个 `.js` 语法通过 —— 这不只是形式：块注释里写带斜杠星号的 glob 字面量会**提前终止注释**，
   剩下的文字被当成代码，而它长得和注释几乎一样（这个坑本次踩了四次）。

---

## 已知边界

- **面板外观未在真实浏览器里验证过**（我无法操作 GUI）。逻辑层（存储、路由、工具定义、文案表）
  有 `scripts/smoke.mjs` / `scripts/smoke-client.mjs` 覆盖；视觉层需要你看一眼。
- 面板接口是**同源、不额外鉴权**的本地路由（`/infohunter/...`）：任何本机进程都能直接读写。
  这与「API Key 以明文存在 `$DSH_HOME/storages/infohunter.db`」是同一级别的暴露 ——
  能读那个库的进程本来就能读到 Key。跨站网页读不到它：响应不带 CORS 头，
  而带 JSON 体的跨站 POST 会触发预检。
- 预设里的工具/策略行取自这套构建自带的 `standard` 预设，存在性与必需 config 键都经 `check-modules.mjs` 校验。
  **往预设里加行之前先跑它**：已核实为必需的键有 `persona.prefix`、`agent-instructions.maxBytes`、
  `tool-todo.allowParallelInProgress`（以及若重新加回 `tool-fs-search` 时的 `sampleOverCapGlobResults`），
  缺任何一个都会让整条预设变 broken 并从选择器消失。
- **刻意缺省的能力**：没有 `pwsh`/`bash`，所以不能拼管道；没有 `tool-fs`，所以不能读写工作区文件
  （run 输出由插件自己写到 `$DSH_HOME/infohunter/runs/`）；`web_fetch` 关闭，只剩 `web_search`。
  这些不是遗漏，是第 8 条决策的代价。
- 面板内部文案目前中英两套（走 Client locale 服务）；`locale/*.json` 只有 `meta`，
  供 Plugin Manager 在**不激活插件**的情况下显示标题/描述/图标。
