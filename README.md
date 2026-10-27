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
章程是"任何时候都成立"的纪律（先读配置、边收边记、观察 vs 推断、授权边界），
技能是"深水区才需要"的方法论（八层手法、置信度锚点、七类假结果陷阱）。

预设还带了扇出能力（`subagent` / `subagent_fork` / `workflow`）：大范围目标可以按子域或网段分工、
或用 workflow 对几十个目标做同构探测。另外有 `time-context`（证书有效期/CT 时间窗要对时）、
`plan-mode`（先出计划再动手）、`goal`（多阶段长任务）与
`tool-result-pruner`（原始扫描输出最容易撑爆上下文，threshold 8 KiB 以上自动剪头尾）。

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
