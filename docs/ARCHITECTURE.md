# WakeDream 架构与接口契约（冻结版 v1）

> 归属：lead。**这是并行开发的唯一接口事实源**；worker 只能按本文档的契约实现自己负责的目录，不得改本文件（发现契约问题先报 lead）。

## 1. 产品一句话

WakeDream 是一个**夜间会话整理客户端**：白天你与多个 Agent（Claude Code / Codex / DeepSeek Harness / Cursor …）在各自设备上作业，夜里它把**当天所有设备上的会话**收拢到一处，跑一次「做梦（dreaming）」把会话萃取成一套 **wiki 式语义记忆库**，供未来的会话只读挂载；UI 参考 Wake（左侧按 agent/项目分组的多栏列表 + 转录阅读 + 深色原生质感）。

三个动作对齐原始请求：**收（提取会话，含 SSH/局域网同步）→ 梦（夜间萃取记忆）→ 用（浏览、检索、把记忆挂给下一个会话）**。

## 2. 技术选型与约定（已定，不要改）

- 运行时：**Node.js ≥ 22.5，纯 ESM JavaScript（不引入 TypeScript 构建步骤）**，可用 JSDoc 标注类型。
- 依赖：**零运行时依赖**。数据库用内置 `node:sqlite`（`DatabaseSync`），HTTP 用 `node:http`，SSH/rsync 用 `child_process`。前端为**手写 ES Module + CSS，无打包器**。
- 编码风格：4 空格缩进（前端 2 空格）、单引号、语句带分号、文件名小写连字符；注释与 UI 文案用中文。
- 时间统一用 **epoch 毫秒整数**；「当天」按**服务器本地时区**的自然日切分。
- 一切可重建：会话索引可随时重建；**对别家 agent 数据目录只读**，绝不写入。
- 测试：`node --test test/`；每个 worker 为自己负责的模块写 `test/<area>.test.js`。

## 3. 目录与归属（写权限严格按此划分）

```
app/
  package.json                 lead
  README.md                    lead
  docs/ARCHITECTURE.md         lead（冻结）
  docs/PRODUCT.md              lead
  src/shared/config.js         lead（冻结）  路径、配置读写、日切分
  src/shared/log.js            lead（冻结）
  src/server/main.js           lead（冻结）  入口、静态服务、api 模块加载
  src/server/router.js         lead（冻结）  Router/json/readBody/query
  src/server/db.js             lead（冻结）  schema、迁移、行→JSON 转换
  src/server/api/health.js     lead
  src/server/api/settings.js   lead
  src/server/sessions/**       sessions worker   适配器 / 扫描 / 查询
  src/server/api/sessions.js   sessions worker
  src/server/api/scan.js       sessions worker
  src/server/sync/**           sessions worker   SSH + 局域网同步
  src/server/api/remotes.js    sessions worker
  src/server/api/lan.js        sessions worker
  src/server/dream/**          dream worker      做梦引擎 / 供应商 / 记忆库
  src/server/api/dream.js      dream worker
  src/server/api/memory.js     dream worker
  src/server/dream/prompts/**  dream worker
  bin/*.js                     lead（薄壳，调 worker 导出的函数）
  web/**                       ui worker         index.html / app.js / styles.css / views/**
  test/sessions.test.js        sessions worker
  test/sync.test.js            sessions worker
  test/dream.test.js           dream worker
  test/ui-smoke.test.js        ui worker（静态资源自检，可选）
  test/e2e.test.js             verifier
```

**不要写别人目录里的文件。** 需要别人改的，用 `send_message` 找对应 worker 或 lead。

## 4. 数据库 schema（`~/.wakedream/db.sqlite`，见 `src/server/db.js`）

表：`meta` / `sessions` / `messages` / `remotes` / `dreams` / `dream_inputs` / `memory_files`。
字段名在库里用 snake_case，出 API 一律用 `db.js` 里的 `rowToSession / rowToMessage / rowToRemote / rowToDream` 转 camelCase，**不要自己另写一套**。

关键字段：
- `sessions.id`：全局 id，格式 `<host>:<agent>:<native_id>`；`host` 为 `local` 或 `ssh:<remoteId>` / `lan:<remoteId>`。
- `sessions.source`：`local` | `ssh:<remoteId>` | `lan:<remoteId>`。
- `sessions.extra`：JSON 字符串，放 agent 私有字段（不要往主表加列）。
- `messages`：`seq` 从 0 递增，`kind ∈ text|thinking|tool_call|tool_result|meta`，`role ∈ user|assistant|system|tool`。
- `sessions.message_count` 口径：该会话 `messages` 里 **去掉 `kind='meta'`** 后的行数（即 text + thinking + tool_call + tool_result）；`meta` 行只用于阅读与回溯，不计入「N 条」。

## 5. HTTP API 契约（`/api/*`，全部 JSON）

必须实现（`P`=owner，`*`=已实现）：

| 方法 | 路径 | 说明 | Owner |
|---|---|---|---|
| GET | `/api/health` | 运行状态 | lead* |
| GET | `/api/settings` / PUT | 读写配置 | lead |
| GET | `/api/agents` | `{agents:[{id,name,color,detected,sessionCount,lastAt,roots:[]}]}` | sessions |
| GET | `/api/projects` | `{projects:[{id,name,path,sessionCount,lastAt}]}` | sessions |
| GET | `/api/sessions` | 查询串：`day=YYYY-MM-DD`、`from`/`to`(ms)、`agent`、`project`、`host`、`q`、`limit`(默认 100)、`offset`、`withPreview=1`、`order=desc`。返回 `{total,sessions:[Session],facets:{agents,projects,hosts}}` | sessions |
| GET | `/api/sessions/:id` | `{session:Session,messages:[Message]}`，`id` 需 `encodeURIComponent` | sessions |
| GET | `/api/stats` | `?day=` 或 `?from&to`：`{totals:{sessions,messages,agents,projects,tokens},byAgent:[],byHour:[],byDay:[]}` | sessions |
| POST | `/api/scan` | `{full?:bool}` → `{scanned,added,updated,durationMs,errors:[]}` | sessions |
| GET | `/api/remotes` | `{remotes:[Remote]}` | sessions |
| POST | `/api/remotes` | `{kind:'ssh'\|'lan',name,host,user?,port?,root?,url?,token?}` → `{remote}` | sessions |
| PATCH | `/api/remotes/:id` | 局部更新 → `{remote}` | sessions |
| DELETE | `/api/remotes/:id` | `{ok:true}`；同时清掉该 host 的远程会话缓存 | sessions |
| POST | `/api/remotes/:id/sync` | `{from?,to?,day?}` → `{jobId,status}`（异步）；同步完成后写 `last_sync/last_status` | sessions |
| GET | `/api/sync/jobs/:jobId` | `{job:{id,remoteId,status,startedAt,finishedAt,pulled,added,error,log:[]}}` | sessions |
| GET | `/api/lan/info` | 本机对端信息：`{enabled,deviceName,port,urls:[],token,sessionCount}` | sessions |
| POST | `/api/lan/pull` | `{url,token?,day?,from?,to?}` → `{jobId}` | sessions |
| GET | `/api/lan/manifest` | 对端调用：`?token=&day=` → `{device,generatedAt,sessions:[{id,agent,project,title,startedAt,messageCount,bytes,sha256}]}` | sessions |
| GET | `/api/lan/bundle` | 对端调用：`?token=&id=<sessionId>` → NDJSON：首行 `{type:'session',session}`，随后逐行 `{type:'message',message}` | sessions |
| GET | `/api/dreams` | `{dreams:[Dream]}`（默认最近 30 次） | dream |
| GET | `/api/dreams/:id` | `{dream,inputs:[Session],reportMarkdown}` | dream |
| POST | `/api/dreams/run` | `{day?,provider?,model?,dryRun?,force?}` → `{dreamId,status}`；同步执行（CLI 也复用它） | dream |
| DELETE | `/api/dreams/:id` | `{ok:true}`（只删记忆产物与记录，不动原始会话） | dream |
| GET | `/api/memory/tree` | `?dreamId=` → `{root,files:[{path,title,kind,bytes,updatedAt,sourceSessions}]}` | dream |
| GET | `/api/memory/file` | `?path=&dreamId=` → `{path,markdown}` | dream |
| GET | `/api/dream/schedule` | `{enabled,at,provider,model,windowDays,lastRun,nextRun}` | dream |
| PUT | `/api/dream/schedule` | 局部更新 → `{schedule}` | dream |
| GET | `/api/events` | SSE：`session:new`、`scan:done`、`dream:progress`、`dream:done`、`sync:progress`（可选但 UI 会用） | lead 提供 helper，各 owner 发事件 |

**Session（API JSON，见 `rowToSession`）**
```
{id,nativeId,agent,host,project,projectPath,title,cwd,model,startedAt,endedAt,
 messageCount,tokens,filePath,fileSize,isSubagent,parentId,source,extra,preview?}
```
**Dream**：`{id,day,store,status,provider,model,sessionCount,startedAt,finishedAt,memoryDir,reportPath,stats,error}`
**Remote**：`{id,kind,name,host,user,port,root,url,token,enabled,lastSync,lastStatus,lastError,extra}`

错误约定：`400 {error}` 参数问题；`404 {error}` 不存在；`500 {error,code}`。handler 直接 `return` 对象即自动 JSON；需要自定义状态码时用 `router.js` 的 `json(res,body,status)` 自己写响应。

**handler 上下文（ctx）**：`{ req, res, params, query, body, url, config, log }`。
- `params`：`:id` 之类的路径参数（已 decode）。
- `query`：查询串对象（字符串值）。
- `body`：`POST/PUT/PATCH/DELETE` 已自动读取并解析（JSON / urlencoded），handler 直接用 `ctx.body`；大文件或流式请求用 `readRawBody(req)`（仅限你确有流式需求时，如 `/api/lan/bundle` 之类的 GET 流）。
- `config`：`loadConfig()` 的快照。
- 长任务不要阻塞请求线程太久：超过 ~2s 的活儿返回 `{jobId}` 异步跑（见 `/api/remotes/:id/sync`）。

### 5.1 冻结补充（v1.1，由 lead 定；UI 与后端都按此实现）

**`GET /api/settings`** → `{settings:{port,host,lan,dream,providers,scan,ui,_home,_configPath}}`；`providers.<name>` 只回 `{baseUrl,model,hasApiKey,apiKeyEnv}`，**不回 apiKey 明文**。
**`PUT /api/settings`** → body 直接是**局部配置补丁**（不包一层 `settings`），例如 `{lan:{enabled:true}}`、`{dream:{provider:'anthropic',model:'claude-sonnet-4-5'}}`、`{providers:{anthropic:{apiKey:'sk-...'}}}`；返回同 GET 的 `{settings}`。未提供的字段保持原值（含已存的 apiKey）。

**`messages[].meta`（按 kind 冻结）**

| kind | meta 形状 |
|---|---|
| `text` | `{}` 或省略 |
| `thinking` | `{}`（或 `{redacted:true}`） |
| `tool_call` | `{name:string, input:object\|string\|null, callId?:string}`；`name` 是工具名（如 `Bash`/`Read`/`exec_command`） |
| `tool_result` | `{name?:string, callId?:string, ok:boolean, output?:string, durationMs?:number}`；`output` 长内容截断到 8KB 并在末尾加 `…[截断]` |
| `meta` | `{type:string, ...}`（例如 `compact_summary`、`turn_anchor`） |

同一对调用/结果用 `callId` 关联（解析不到就留空，UI 按相邻配对兜底）。UI 以 `name/input/output/ok` 为主，`tool|toolName`、`args|arguments`、`result` 只作兼容兜底，不算契约。

**`GET /api/stats`** → `{totals:{sessions,messages,agents,projects,tokens},byAgent:[{agent,sessions,messages,tokens}],byHour:[{hour:0..23,sessions,messages}],byDay:[{day:'YYYY-MM-DD',sessions,messages}]}`（byHour/byDay 升序）。

## 6. 模块契约（worker 之间的调用面，必须按签名导出）

### sessions worker
```js
// src/server/sessions/index.js
export function listAgents(): AgentMeta[]                 // 静态 registry（id,name,color,roots）
export async function scanLocal(opts?): ScanResult        // 全量/增量扫描本机各 agent 目录 → 写库
export function querySessions(opts): {total,sessions}     // 参数同 /api/sessions
export function getSession(id): Session|null
export function getMessages(sessionId, {limit,offset}?): Message[]
export function monthStats(opts): Stats
// src/server/sync/index.js
export function listRemotes(): Remote[]
export function createRemote(input): Remote
export async function syncRemote(remoteId, opts?): {jobId}
export function getJob(jobId): Job|null
export async function pullFromLan({url,token,day}): {jobId}
export function lanManifest({token,day}): Manifest        // 供 /api/lan/manifest 调用
export function lanBundleStream({token,id}): {headers, stream}  // 供 /api/lan/bundle 调用
```

### dream worker
```js
// src/server/dream/index.js
export async function runDream(opts): DreamResult        // {dreamId,status,stats,reportPath}
export function listDreams({limit}?): Dream[]
export function getDream(id): {dream,inputs,reportMarkdown}|null
export async function removeDream(id): {ok:true}
export function memoryTree({dreamId}?): {root,files:[]}
export function readMemoryFile({path,dreamId}): {path,markdown}
// src/server/dream/scheduler.js
export async function startScheduler({config, log}): void  // 到点触发 runDream，失败只记日志
export function scheduleInfo(): {...}                      // GET /api/dream/schedule 用
export async function updateSchedule(patch): {...}         // PUT 用
// src/server/dream/providers/index.js
export function createProvider(name, cfg): { name, model, async complete({system,messages,maxTokens}) }  // 至少 3 个：heuristic / anthropic / openai-compatible
```

### ui worker
- 只读 API，不写库；`web/index.html` 挂 `web/app.js`，路由用 hash（`#/today`、`#/sessions/:id`、`#/dreams/:id`、`#/memory`、`#/hosts`、`#/settings`）。
- 视觉基线：深色为主、可切浅色；左侧 220–280px 导航 + 中间列表 + 右侧阅读区；agent 品牌色圆点 + 文字（不靠纯色区分状态）；等宽字体只用于代码与路径。

## 7. 「做梦」的记忆库形状（dream worker 与 ui worker 的共享契约）

产物落盘 `~/.wakedream/memory/dreams/<YYYY-MM-DD>/<store>/`：
```
_index.md                 索引：一句话总览 + 各文件链接 + 当天会话清单
projects/<slug>.md        按项目聚合：这个项目今天推进了什么、结论、未决问题
decisions.md              当天做出的决定（含理由与来源会话 id）
preferences.md            用户偏好/工作方式（跨天累积，重复出现才写）
open-questions.md         悬而未决、需要用户或下个会话跟进的事
people.md                 出现的人/团队/协作方（可选）
sessions/<sessionId>.md   单会话摘要（做了什么事、产出、结论）
```
- 每个文件带 YAML 头：`title / kind / day / source_sessions / updated_at`。
- 文件之间用相对路径 markdown 链接互链（wiki 式），`_index.md` 是入口。
- 记忆库是**只读挂载**给未来会话的：本次实现提供「复制挂载指令」——把记忆目录路径写进 CLAUDE.md/AGENTS.md 片段供用户粘贴（不代写别家配置，与 Wake 的克制一致）。

## 8. 验收与验证

- `npm run scan` 能在本机真实数据（`~/.dsh/sessions`、`~/.claude` 等存在者）上跑通并入库。
- `npm run dream -- --day <今天>` 在无任何 API key 时用 `heuristic` provider 也能产出完整记忆库；配了 key 时走模型。
- `npm start` 后 `web/` 可浏览：当天会话时间线、转录阅读、做梦报告、记忆库浏览、远端设备管理。
- SSH 同步：用本机 sshd 或 `ssh localhost` 可验证（无远端设备时用 `test/sync.test.js` 的假 rsync/假 HTTP 对端验证协议层）。
- 局域网同步：起两个实例（不同 `WAKEDREAM_HOME` 与端口），A 从 B 拉当天会话，会话带 `@B` 徽章落在 A 的库里。
