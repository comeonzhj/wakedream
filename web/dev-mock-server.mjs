// 开发期假数据服务：与 ARCHITECTURE.md §5 + §5.1 完全同形的响应，用来在后端 worker 还没写完时
// 真实渲染并截图（浏览器里跑的是真 fetch('/api/...')，只是数据是假的）。
//
// 用法：node app/web/dev-mock-server.mjs [--port 4780]
// 打开：http://127.0.0.1:4780/#/today
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = __dirname;
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4780;

const now = Date.now();
const HOUR = 3_600_000;
const day = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const at = (h, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', color: '#d97757', detected: true, roots: ['~/.claude/projects'], sessionCount: 3, lastAt: at(18, 40) },
  { id: 'codex', name: 'Codex', color: '#12a06b', detected: true, roots: ['~/.codex/sessions'], sessionCount: 2, lastAt: at(16, 5) },
  { id: 'dsh', name: 'DeepSeek Harness', color: '#4d6bfe', detected: true, roots: ['~/.dsh/sessions'], sessionCount: 2, lastAt: at(20, 10) },
];

const PROJECTS = [
  { id: 'acme-web', name: 'acme-web', path: '/Users/demo/Github/acme-web', sessionCount: 4, lastAt: at(18, 40) },
  { id: 'rust-search', name: 'rust-search', path: '/Users/demo/Github/rust-search', sessionCount: 3, lastAt: at(16, 5) },
  { id: 'blog-engine', name: 'blog-engine', path: '/Users/demo/Github/blog-engine', sessionCount: 2, lastAt: at(11, 30) },
];

function mkSession(i, { agent, host, project, title, hour, minute, messageCount, tokens, model }) {
  const id = `${host}:${agent}:native-${i}`;
  return {
    id,
    nativeId: `native-${i}`,
    agent,
    host,
    project,
    projectPath: `/Users/demo/Github/${project}`,
    title,
    cwd: `/Users/demo/Github/${project}`,
    model: model || (agent === 'codex' ? 'gpt-5-codex' : agent === 'dsh' ? 'deepseek-chat' : 'claude-sonnet-4-5'),
    startedAt: at(hour, minute),
    endedAt: at(hour, minute + 22),
    messageCount,
    tokens,
    filePath: host === 'local'
      ? `/Users/demo/.${agent === 'claude-code' ? 'claude' : agent}/projects/${project}/native-${i}.jsonl`
      : `/Users/demo/.wakedream/cache/remote/${host.split(':')[1]}/native-${i}.jsonl`,
    fileSize: 180_000 + i * 4_321,
    isSubagent: false,
    parentId: null,
    source: host === 'local' ? 'local' : host,
    extra: {},
    preview: `${title} —— 先看现状再动手，把结论写进记忆库。`,
  };
}

const SESSIONS = [
  mkSession(1, { agent: 'claude-code', host: 'local', project: 'acme-web', title: '给会话列表加上全文搜索与 CJK 分词', hour: 9, minute: 20, messageCount: 42, tokens: 61_240 }),
  mkSession(2, { agent: 'claude-code', host: 'local', project: 'acme-web', title: '修复 WebSocket 断线重连后的重复订阅', hour: 13, minute: 5, messageCount: 18, tokens: 12_300 }),
  mkSession(3, { agent: 'claude-code', host: 'ssh:devbox', project: 'rust-search', title: '解释 indexer.rs 里的借用检查器报错', hour: 15, minute: 40, messageCount: 26, tokens: 24_800 }),
  mkSession(4, { agent: 'codex', host: 'local', project: 'rust-search', title: '把 FTS5 trigram 基准跑一遍并对比 LIKE 回退', hour: 16, minute: 5, messageCount: 31, tokens: 40_100 }),
  mkSession(5, { agent: 'codex', host: 'lan:mac-mini', project: 'blog-engine', title: '把 CI 从 CircleCI 迁到 GitHub Actions', hour: 11, minute: 30, messageCount: 22, tokens: 18_400 }),
  mkSession(6, { agent: 'dsh', host: 'local', project: 'acme-web', title: '重构索引重建的进度上报', hour: 20, minute: 10, messageCount: 27, tokens: 33_150 }),
  mkSession(7, { agent: 'dsh', host: 'lan:mac-mini', project: 'acme-web', title: '给设置页做深色模式的设计令牌梳理', hour: 21, minute: 2, messageCount: 15, tokens: 9_800, model: 'deepseek-reasoner' }),
];

const MESSAGES = {
  'local:claude-code:native-1': [
    { seq: 0, role: 'user', kind: 'text', ts: at(9, 20), text: '会话列表要支持全文搜索，中文和代码子串都得能搜到。先看现状再动手。', meta: {} },
    { seq: 1, role: 'assistant', kind: 'thinking', ts: at(9, 20, 40), text: 'FTS5 的默认 tokenizer 对 CJK 无能为力，trigram 能同时覆盖中文和代码子串。先看现有 schema 再决定迁移方式。', meta: {} },
    { seq: 2, role: 'assistant', kind: 'text', ts: at(9, 21), text: '先确认一下当前的表结构，再决定要不要引入 trigram 分词器。\n\n**要点**\n\n- `messages` 表现在没有 FTS 影子表\n- 中文短词（两个字）低于 trigram 下限，需要 LIKE 降级\n- 迁移要能在启动时幂等重跑', meta: {} },
    { seq: 3, role: 'assistant', kind: 'tool_call', ts: at(9, 21, 30), text: 'Read {"file_path":"app/src/server/db.js"}', meta: { name: 'Read', input: { file_path: 'app/src/server/db.js' }, callId: 'call_1' } },
    { seq: 4, role: 'tool', kind: 'tool_result', ts: at(9, 21, 32), text: 'schema: sessions / messages / remotes / dreams / dream_inputs / memory_files', meta: { name: 'Read', callId: 'call_1', ok: true, output: 'schema: sessions / messages / remotes / dreams / dream_inputs / memory_files', durationMs: 42 } },
    { seq: 5, role: 'assistant', kind: 'text', ts: at(9, 22), text: '现在还没有 FTS 表。下面是迁移语句：\n\n```sql\nCREATE VIRTUAL TABLE messages_fts USING fts5(\n  text,\n  content = \'messages\',\n  content_rowid = \'id\',\n  tokenize = \'trigram\'\n);\n```\n\n| 查询长度 | 走索引 | 回退 |\n|---|---|---|\n| ≥ 3 字符 | trigram 索引 | — |\n| 1–2 字符 | — | LIKE \'%..%\' |\n\n两个字（两码点）低于 trigram 下限，走 `LIKE \'%..%\'` 降级路径，在 546 万行的表上实测约 40ms，可以接受。', meta: {} },
    { seq: 6, role: 'user', kind: 'text', ts: at(9, 24), text: '中文短词比如两个字的怎么办？', meta: {} },
    { seq: 7, role: 'assistant', kind: 'thinking', ts: at(9, 24, 20), text: '需要在 UI 上提示「短查询已降级，长关键词更快」，并把这条写进测试。', meta: {} },
    { seq: 8, role: 'assistant', kind: 'text', ts: at(9, 24, 40), text: 'UI 上会提示「短查询已降级，长关键词更快」。我把这条也写进测试。', meta: {} },
    { seq: 9, role: 'assistant', kind: 'tool_call', ts: at(9, 25), text: 'Bash {"command":"npm test -- test/sessions.test.js"}', meta: { name: 'Bash', input: { command: 'npm test -- test/sessions.test.js' }, callId: 'call_2' } },
    { seq: 10, role: 'tool', kind: 'tool_result', ts: at(9, 25, 6), text: 'Error: 3 tests failed\n  CJK two-char query should fall back to LIKE\n  trigram index should be created once', meta: { name: 'Bash', callId: 'call_2', ok: false, output: 'Error: 3 tests failed\n  CJK two-char query should fall back to LIKE\n  trigram index should be created once', durationMs: 1840 } },
    { seq: 11, role: 'assistant', kind: 'text', ts: at(9, 26), text: '有 3 个测试失败，其中两个与降级路径有关，我先修这两条。', meta: {} },
    { seq: 12, role: 'assistant', kind: 'tool_call', ts: at(9, 26, 30), text: 'Grep {"pattern":"tokenize = \'trigram\'"}', meta: { name: 'Grep', input: { pattern: "tokenize = 'trigram'" }, callId: 'call_3' } },
    { seq: 13, role: 'tool', kind: 'tool_result', ts: at(9, 26, 31), text: 'db.js:88: tokenize = \'trigram\'', meta: { name: 'Grep', callId: 'call_3', ok: true, output: "db.js:88: tokenize = 'trigram'", durationMs: 12 } },
  ],
};

function messagesFor(session) {
  if (MESSAGES[session.id]) return MESSAGES[session.id];
  const short = session.agent === 'codex' ? 'codex' : session.agent === 'dsh' ? 'dsh' : 'claude';
  return [
    { seq: 0, role: 'user', kind: 'text', ts: session.startedAt, text: `${session.title}。先把现状读一遍，给出方案再动手。`, meta: {} },
    { seq: 1, role: 'assistant', kind: 'thinking', ts: session.startedAt + 20_000, text: '先定位相关文件，再决定改动面。', meta: {} },
    { seq: 2, role: 'assistant', kind: 'text', ts: session.startedAt + 60_000, text: `我用 ${short} 的默认流程走了一遍：\n\n1. 读相关模块\n2. 跑一遍现有测试\n3. 改最小面\n\n结论写在下面的代码块里。`, meta: {} },
    { seq: 3, role: 'assistant', kind: 'tool_call', ts: session.startedAt + 90_000, text: 'Bash {"command":"npm test"}', meta: { name: 'Bash', input: { command: 'npm test' }, callId: 'c1' } },
    { seq: 4, role: 'tool', kind: 'tool_result', ts: session.startedAt + 120_000, text: 'pass 42 · fail 0', meta: { name: 'Bash', callId: 'c1', ok: true, output: 'pass 42 · fail 0', durationMs: 2210 } },
    { seq: 5, role: 'assistant', kind: 'text', ts: session.startedAt + 150_000, text: '测试全绿。改动集中在两个文件，没有触及其他模块。', meta: {} },
    { seq: 6, role: 'system', kind: 'meta', ts: session.startedAt + 160_000, text: 'agent-instructions', meta: { type: 'agent-instructions' } },
  ];
}

// ---------- 做梦 ----------
const DREAM_ID = `dream-${day}-1`;
const MEMORY_ROOT = `/Users/demo/.wakedream/memory/dreams/${day}/default`;
const MEMORY_FILES = {
  '_index.md': `---
title: ${day} 记忆索引
kind: index
day: ${day}
source_sessions: [local:claude-code:native-1, local:codex:native-4, local:dsh:native-6]
updated_at: ${day} 03:31
---

# ${day} 的记忆

今天 7 个会话、3 个 Agent、3 个项目。主线是**给会话库加全文搜索**，并把 CI 从 CircleCI 迁到 GitHub Actions。

## 今天推进了什么

- [acme-web](projects/acme-web.md)：FTS5 trigram 方案定稿，短查询降级路径写入测试
- [rust-search](projects/rust-search.md)：借用检查器报错定位到生命周期标注
- [blog-engine](projects/blog-engine.md)：CI 迁移完成，流水线从 6 分钟降到 2 分 40 秒

## 相关文件

- [decisions.md](decisions.md) —— 今天做出的 3 个决定
- [preferences.md](preferences.md) —— 用户偏好
- [open-questions.md](open-questions.md) —— 悬而未决的 2 件事
- [sessions/local:claude-code:native-1.md](sessions/local:claude-code:native-1.md) —— 主线会话摘要
`,
  'projects/acme-web.md': `---
title: acme-web
kind: project
day: ${day}
source_sessions: [local:claude-code:native-1, local:claude-code:native-2, local:dsh:native-6]
updated_at: ${day} 03:31
---

# acme-web

## 推进

对话列表的全文搜索方案定稿：SQLite FTS5 + \`trigram\` 分词器，能同时覆盖中文与代码子串。

> 两个字（两码点）低于 trigram 下限，走 \`LIKE '%..%'\` 降级路径；546 万行实测约 40ms。

## 结论

- 迁移语句幂等，启动时重跑安全
- UI 上要提示「短查询已降级，长关键词更快」

## 未决

- 索引重建时的进度上报还没接进 UI
`,
  'projects/rust-search.md': `---
title: rust-search
kind: project
day: ${day}
source_sessions: [ssh:devbox:claude-code:native-3, local:codex:native-4]
updated_at: ${day} 03:31
---

# rust-search

## 推进

- 借用检查器报错定位到 \`indexer.rs\` 的 \`&mut self\` 生命周期标注
- FTS5 trigram 基准跑完，和 LIKE 回退做了对比

## 数据

| 查询 | 走索引 | 耗时 |
|---|---|---|
| \`全文搜索\`（4 字） | trigram | 3ms |
| \`搜索\`（2 字） | LIKE 回退 | 40ms |
`,
  'decisions.md': `---
title: 今天的决定
kind: decisions
day: ${day}
source_sessions: [local:claude-code:native-1, lan:mac-mini:codex:native-5]
updated_at: ${day} 03:31
---

# 决定

1. **搜索用 FTS5 trigram，不做自建分词** —— 来源：local:claude-code:native-1。理由是维护成本低、中英混排都能覆盖。
2. **CI 迁到 GitHub Actions** —— 来源：lan:mac-mini:codex:native-5。流水线从 6 分钟降到 2 分 40 秒。
3. **记忆库只读挂载，不代写别家配置** —— 来源：本产品原则；只提供可粘贴的指令片段。
`,
  'preferences.md': `---
title: 用户偏好
kind: preferences
day: ${day}
source_sessions: [local:claude-code:native-1]
updated_at: ${day} 03:31
---

# 偏好

- 先给方案再动手，改最小面
- 中文回答，代码注释也用中文
- 结论要带来源会话 id，方便回查
- 不用 emoji 当界面图标
`,
  'open-questions.md': `---
title: 悬而未决
kind: open-questions
day: ${day}
updated_at: ${day} 03:31
---

# 待跟进

- [ ] 索引重建的进度上报还没接进 UI（来源：local:dsh:native-6）
- [ ] 局域网同步的 token 轮换策略还没定
`,
  'sessions/local:claude-code:native-1.md': `---
title: 给会话列表加上全文搜索与 CJK 分词
kind: session
day: ${day}
source_sessions: [local:claude-code:native-1]
updated_at: ${day} 03:31
---

# 给会话列表加上全文搜索与 CJK 分词

做了：读完 \`db.js\` 现状，给出 FTS5 trigram 迁移方案，补齐短查询降级路径。

产出：迁移 SQL 一段、对比表一张、测试 3 条。

结论：见 [decisions.md](../decisions.md) 第 1 条。
`,
};

const DREAMS = [
  {
    id: DREAM_ID, day, store: 'default', status: 'ok', provider: 'heuristic', model: '',
    sessionCount: 7, startedAt: at(3, 30), finishedAt: at(3, 31, 12),
    memoryDir: MEMORY_ROOT, reportPath: `${MEMORY_ROOT}/_report.md`,
    stats: { files: Object.keys(MEMORY_FILES).length, chars: 4210 }, error: null,
  },
  {
    id: `dream-2026-11-05-1`, day: '2026-11-05', store: 'default', status: 'ok', provider: 'anthropic', model: 'claude-sonnet-4-5',
    sessionCount: 4, startedAt: at(3, 30) - 86_400_000, finishedAt: at(3, 32) - 86_400_000,
    memoryDir: '/Users/demo/.wakedream/memory/dreams/2026-11-05/default', reportPath: '/Users/demo/.wakedream/memory/dreams/2026-11-05/default/_report.md',
    stats: { files: 5 }, error: null,
  },
];

const REPORT_MD = `# ${day} 做梦报告

**输入**：7 个会话 · 3 个 Agent · 3 个项目 · 4 台设备视图（本机 / devbox / mac-mini）
**供应商**：heuristic（本地规则，无需 API key）

## 今天的主题

给会话库加全文搜索是主线，CI 迁移是支线；两条都在当天收口。

## 产出

| 文件 | 说明 |
|---|---|
| \`_index.md\` | 索引与入口 |
| \`projects/acme-web.md\` | 搜索方案定稿 |
| \`decisions.md\` | 3 条决定 + 来源会话 id |

## 备注

- 有 1 个会话来自 SSH 设备 \`devbox\`，已带 \`@devbox\` 徽章入库；
- 局域网设备 \`mac-mini\` 的会话在同步后参与了本次萃取。
`;

// ---------- remotes / lan ----------
let REMOTES = [
  {
    id: 'r-devbox', kind: 'ssh', name: 'devbox', host: '192.168.1.20', user: 'corey', port: 22,
    root: '~/.claude/projects', url: null, token: null, enabled: true,
    lastSync: at(2, 10), lastStatus: 'ok', lastError: null, extra: null,
  },
  {
    id: 'r-macmini', kind: 'lan', name: 'mac-mini', host: null, user: null, port: null,
    root: null, url: 'http://192.168.1.30:4680', token: 'wd_pair_7f3c9a12', enabled: true,
    lastSync: at(1, 40), lastStatus: 'ok', lastError: null, extra: null,
  },
];

const JOBS = new Map();

let SETTINGS = {
  port: 4680, host: '127.0.0.1',
  lan: { enabled: true, token: 'wd_pair_7f3c9a12', deviceName: 'corey-mbp', bindAll: true },
  dream: { enabled: true, at: '03:30', provider: 'heuristic', model: '', windowDays: 1, maxSessions: 60, maxCharsPerSession: 24000, storeName: 'default' },
  providers: { anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', hasApiKey: false, apiKeyEnv: null } },
  scan: { extraRoots: [{ id: 'r1', agent: 'codex', dir: '/Users/demo/work/agent-export' }], disabledAgents: [] },
  ui: { defaultRange: 'today', theme: 'system' },
  _home: '/Users/demo/.wakedream',
  _configPath: '/Users/demo/.wakedream/config.json',
};

let SCHEDULE = {
  enabled: true, at: '03:30', provider: 'heuristic', model: '', windowDays: 1,
  lastRun: at(3, 30), nextRun: at(3, 30) + 86_400_000,
};

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function send(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
const notFound = (res) => send(res, { error: 'not found' }, 404);

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}

function filterSessions(q) {
  let list = [...SESSIONS];
  const from = q.get('from') ? Number(q.get('from')) : null;
  const to = q.get('to') ? Number(q.get('to')) : null;
  const dayParam = q.get('day');
  if (dayParam) {
    const start = new Date(`${dayParam}T00:00:00`).getTime();
    list = list.filter((s) => s.startedAt >= start && s.startedAt < start + 86_400_000);
  }
  if (from) list = list.filter((s) => (s.startedAt || 0) >= from);
  if (to) list = list.filter((s) => (s.startedAt || 0) <= to);
  if (q.get('agent')) list = list.filter((s) => s.agent === q.get('agent'));
  if (q.get('project')) list = list.filter((s) => s.project === q.get('project'));
  if (q.get('host')) list = list.filter((s) => s.host === q.get('host'));
  if (q.get('q')) {
    const needle = q.get('q').toLowerCase();
    list = list.filter((s) => `${s.title} ${s.project} ${s.preview || ''}`.toLowerCase().includes(needle));
  }
  return list.sort((a, b) => (q.get('order') === 'asc' ? a.startedAt - b.startedAt : b.startedAt - a.startedAt));
}

function facets(list) {
  const count = (key) => {
    const m = new Map();
    for (const s of list) m.set(s[key], (m.get(s[key]) || 0) + 1);
    return m;
  };
  const agentCounts = count('agent');
  const projectCounts = count('project');
  const hostCounts = count('host');
  return {
    agents: AGENTS.map((a) => ({ id: a.id, name: a.name, count: agentCounts.get(a.id) || 0 })),
    projects: PROJECTS.map((p) => ({ id: p.id, name: p.name, count: projectCounts.get(p.id) || 0 })),
    hosts: [...hostCounts.entries()].map(([id, n]) => ({ id, name: id === 'local' ? 'local' : `@${id.split(':')[1]}`, count: n })),
  };
}

function stats(q) {
  const list = filterSessions(q);
  const byAgent = new Map();
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: 0, messages: 0 }));
  const byDay = new Map();
  let messages = 0;
  let tokens = 0;
  for (const s of list) {
    messages += s.messageCount || 0;
    tokens += s.tokens || 0;
    const a = byAgent.get(s.agent) || { agent: s.agent, sessions: 0, messages: 0, tokens: 0 };
    a.sessions += 1; a.messages += s.messageCount || 0; a.tokens += s.tokens || 0;
    byAgent.set(s.agent, a);
    const h = new Date(s.startedAt).getHours();
    byHour[h].sessions += 1;
    byHour[h].messages += s.messageCount || 0;
    const d = new Date(s.startedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const rec = byDay.get(key) || { day: key, sessions: 0, messages: 0 };
    rec.sessions += 1; rec.messages += s.messageCount || 0;
    byDay.set(key, rec);
  }
  return {
    totals: {
      sessions: list.length, messages,
      agents: new Set(list.map((s) => s.agent)).size,
      projects: new Set(list.map((s) => s.project)).size,
      tokens,
    },
    byAgent: [...byAgent.values()],
    byHour,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return send(res, { ok: true, name: 'WakeDream', version: '0.1.0-mock', home: SETTINGS._home, uptimeMs: now ? Date.now() - now : 0, sessions: SESSIONS.length });
  }
  if (p === '/api/settings') {
    if (req.method === 'GET') return send(res, { settings: SETTINGS });
    if (req.method === 'PUT') {
      const patch = await readBody(req);
      SETTINGS = {
        ...SETTINGS, ...patch,
        lan: { ...SETTINGS.lan, ...(patch.lan || {}) },
        dream: { ...SETTINGS.dream, ...(patch.dream || {}) },
        scan: { ...SETTINGS.scan, ...(patch.scan || {}) },
        ui: { ...SETTINGS.ui, ...(patch.ui || {}) },
        providers: { ...SETTINGS.providers, ...(patch.providers || {}) },
      };
      return send(res, { settings: SETTINGS });
    }
  }
  if (p === '/api/agents') return send(res, { agents: AGENTS });
  if (p === '/api/projects') return send(res, { projects: PROJECTS });
  if (p === '/api/sessions') {
    const all = filterSessions(q);
    const limit = Number(q.get('limit') || 100);
    const offset = Number(q.get('offset') || 0);
    const slice = all.slice(offset, offset + limit).map((s) => {
      const out = { ...s };
      if (q.get('withPreview') !== '1') delete out.preview;
      return out;
    });
    return send(res, { total: all.length, sessions: slice, facets: facets(SESSIONS) });
  }
  if (p.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(p.slice('/api/sessions/'.length));
    const session = SESSIONS.find((s) => s.id === id);
    if (!session) return send(res, { error: `会话不存在：${id}` }, 404);
    return send(res, { session, messages: messagesFor(session) });
  }
  if (p === '/api/stats') return send(res, stats(q));
  if (p === '/api/scan' && req.method === 'POST') {
    return send(res, { scanned: SESSIONS.length + 2, added: 2, updated: 5, durationMs: 812, errors: [] });
  }
  if (p === '/api/remotes' && req.method === 'GET') return send(res, { remotes: REMOTES });
  if (p === '/api/remotes' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.name) return send(res, { error: 'name 必填' }, 400);
    const remote = {
      id: `r-${Math.random().toString(36).slice(2, 8)}`, kind: body.kind || 'ssh', name: body.name,
      host: body.host ?? null, user: body.user ?? null, port: body.port ?? null, root: body.root ?? null,
      url: body.url ?? null, token: body.token ?? null, enabled: true,
      lastSync: null, lastStatus: 'never', lastError: null, extra: null,
    };
    REMOTES = [...REMOTES, remote];
    return send(res, { remote });
  }
  if (p.startsWith('/api/remotes/')) {
    const rest = p.slice('/api/remotes/'.length);
    const [rawId, action] = rest.split('/');
    const id = decodeURIComponent(rawId);
    const idx = REMOTES.findIndex((r) => r.id === id);
    if (idx < 0) return send(res, { error: '设备不存在' }, 404);
    if (action === 'sync' && req.method === 'POST') {
      const jobId = `job-${Math.random().toString(36).slice(2, 8)}`;
      JOBS.set(jobId, { id: jobId, remoteId: id, status: 'running', startedAt: Date.now(), finishedAt: null, pulled: 0, added: 0, error: null, log: [`开始同步 ${REMOTES[idx].name}`] });
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        const job = JOBS.get(jobId);
        job.pulled = step * 3;
        job.added = step * 2;
        job.log.push(`rsync ${step}/4 · 拉取 ${job.pulled} 个会话文件`);
        if (step >= 4) {
          clearInterval(timer);
          job.status = 'ok';
          job.finishedAt = Date.now();
          job.log.push('同步完成');
          REMOTES[idx] = { ...REMOTES[idx], lastSync: Date.now(), lastStatus: 'ok', lastError: null };
        }
      }, 900);
      return send(res, { jobId, status: 'running' });
    }
    if (req.method === 'PATCH') {
      const patch = await readBody(req);
      REMOTES[idx] = { ...REMOTES[idx], ...patch };
      return send(res, { remote: REMOTES[idx] });
    }
    if (req.method === 'DELETE') {
      const [removed] = REMOTES.splice(idx, 1);
      return send(res, { ok: true, removed: removed.id });
    }
  }
  if (p.startsWith('/api/sync/jobs/')) {
    const jobId = p.slice('/api/sync/jobs/'.length);
    const job = JOBS.get(jobId);
    if (!job) return send(res, { error: '作业不存在' }, 404);
    return send(res, { job });
  }
  if (p === '/api/lan/info') {
    return send(res, {
      enabled: SETTINGS.lan.enabled, deviceName: SETTINGS.lan.deviceName, port: SETTINGS.port,
      urls: SETTINGS.lan.enabled
        ? [`http://127.0.0.1:${SETTINGS.port}`, `http://192.168.1.42:${SETTINGS.port}`]
        : [],
      token: SETTINGS.lan.token, sessionCount: SESSIONS.length, bindAll: SETTINGS.lan.bindAll,
    });
  }
  if (p === '/api/lan/pull' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.url) return send(res, { error: 'url 必填' }, 400);
    const jobId = `job-lan-${Math.random().toString(36).slice(2, 8)}`;
    JOBS.set(jobId, { id: jobId, remoteId: null, status: 'running', startedAt: Date.now(), finishedAt: null, pulled: 0, added: 0, error: null, log: [`从 ${body.url} 拉取 ${body.day || '当天'} 的清单`] });
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      const job = JOBS.get(jobId);
      job.pulled = step * 2;
      job.added = step * 2;
      job.log.push(`GET /api/lan/manifest · 命中 ${job.pulled} 个会话`);
      if (step >= 3) {
        clearInterval(timer);
        job.status = 'ok';
        job.finishedAt = Date.now();
        job.log.push('拉取完成，会话已带 @mac-mini 徽章落库');
      }
    }, 900);
    return send(res, { jobId });
  }
  if (p === '/api/dreams' && req.method === 'GET') return send(res, { dreams: DREAMS });
  if (p === '/api/dreams/run' && req.method === 'POST') {
    const body = await readBody(req);
    const targetDay = body.day || day;
    const existing = DREAMS.find((d) => d.day === targetDay);
    const dream = existing || {
      id: `dream-${targetDay}-${Math.random().toString(36).slice(2, 6)}`, day: targetDay, store: 'default',
      status: 'ok', provider: body.provider || 'heuristic', model: body.model || '',
      sessionCount: filterSessions(new URLSearchParams({ day: targetDay })).length,
      startedAt: Date.now(), finishedAt: Date.now() + 42_000, memoryDir: MEMORY_ROOT,
      reportPath: `${MEMORY_ROOT}/_report.md`, stats: { files: 7 }, error: null,
    };
    if (!existing) DREAMS.unshift(dream);
    return send(res, { dreamId: dream.id, status: 'ok', stats: dream.stats, reportPath: dream.reportPath, memoryDir: dream.memoryDir, sessionCount: dream.sessionCount });
  }
  if (p.startsWith('/api/dreams/')) {
    const id = decodeURIComponent(p.slice('/api/dreams/'.length));
    const dream = DREAMS.find((d) => d.id === id);
    if (!dream) return send(res, { error: '做梦记录不存在' }, 404);
    if (req.method === 'DELETE') {
      DREAMS = DREAMS.filter((d) => d.id !== id);
      return send(res, { ok: true });
    }
    const inputs = filterSessions(new URLSearchParams({ day: dream.day }));
    return send(res, { dream, inputs, reportMarkdown: REPORT_MD });
  }
  if (p === '/api/memory/tree') {
    const dreamId = q.get('dreamId') || DREAMS[0]?.id;
    return send(res, {
      root: MEMORY_ROOT,
      dreamId,
      files: Object.entries(MEMORY_FILES).map(([file, md]) => ({
        path: file,
        title: (/title:\s*(.+)/.exec(md)?.[1] || file).trim(),
        kind: (/kind:\s*(.+)/.exec(md)?.[1] || 'md').trim(),
        bytes: Buffer.byteLength(md),
        updatedAt: at(3, 31),
        sourceSessions: [],
      })),
    });
  }
  if (p === '/api/memory/file') {
    const file = q.get('path');
    if (!file) return send(res, { error: 'path 必填' }, 400);
    const md = MEMORY_FILES[file];
    if (md === undefined) return send(res, { error: `记忆文件不存在：${file}` }, 404);
    return send(res, { path: file, markdown: md, dreamId: q.get('dreamId') || DREAMS[0]?.id });
  }
  if (p === '/api/dream/schedule') {
    if (req.method === 'GET') return send(res, { schedule: SCHEDULE });
    if (req.method === 'PUT') {
      const patch = await readBody(req);
      SCHEDULE = { ...SCHEDULE, ...patch };
      return send(res, { schedule: SCHEDULE });
    }
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': wakedream mock events\n\n');
    const t = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20_000);
    req.on('close', () => clearInterval(t));
    return undefined;
  }
  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      send(res, { error: err.message, code: 'MOCK_ERROR' }, 500);
    }
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(WEB_DIR, `.${rel}`);
  if (!target.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-mock] WakeDream 假数据服务：http://127.0.0.1:${PORT}/#/today`);
  console.log('[dev-mock] 契约同形：/api/sessions /api/stats /api/dreams /api/memory/tree /api/remotes /api/lan/info …');
});
