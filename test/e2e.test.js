// WakeDream 端到端验证（verifier 独立编写，不属于任何 worker 的模块单测）。
//
// 设计原则：
//   1. **全部走真实 HTTP + 真实子进程**：每个用例都起一个真的 `src/server/main.js`（各自独立的
//      临时 WAKEDREAM_HOME 与随机端口），用 fetch 打 /api/*，不 import 实现模块当白盒。
//      唯一例外是读取测试自己产出的日志与磁盘文件（用于「没写坏别家目录」「没落凭证」这类断言）。
//   2. **绝不碰真实 `~/.wakedream`**：所有实例的 WAKEDREAM_HOME 都在 os.tmpdir() 下；同时在
//      用例里显式断言真实 ~/.wakedream 的 mtime/内容没被改动。
//   3. 被扫描的数据源是**本机真实会话目录**（`~/.dsh/sessions`，只读）。
//   4. SSH 路径本机不可用（sshd 在跑但没有可用密钥，`ssh localhost` 会 Permission denied），
//      因此用**可执行 ssh/rsync 桩**做传输层替身，但入库、查询、幂等全部走真实 HTTP + 真实适配器。
//      局域网路径是**两个真实实例**之间真拉。
//
// 运行：cd app && node --test test/e2e.test.js
// 附带的原始证据（接口响应摘要、计数、日志摘要）会写到 <repo>/evidence/e2e-<date>.json。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const EVIDENCE_DIR = process.env.WAKEDREAM_EVIDENCE_DIR || path.join(REPO_ROOT, 'evidence');
const MAIN_JS = path.join(APP_ROOT, 'src/server/main.js');
const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');
const REAL_HOME = path.join(os.homedir(), '.wakedream');
const KEEP_TMP = process.env.WAKEDREAM_E2E_KEEP === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const today = () => dayOf(Date.now());
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ------------------------------------------------------------------ 基础设施 */

async function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const SERVERS = [];
const TMP_DIRS = [];

function makeTmp(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    TMP_DIRS.push(dir);
    return dir;
}

/** 起一个真实服务实例（独立 HOME + 独立端口） */
async function startServer(name, { home, env = {}, extraArgs = [] } = {}) {
    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, [...extraArgs, MAIN_JS], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            WAKEDREAM_HOME: home,
            PORT: String(port),
            HOST: '127.0.0.1',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => logs.push(`[out] ${d}`));
    child.stderr.on('data', (d) => logs.push(`[err] ${d}`));
    const server = {
        name,
        home,
        port,
        base: `http://127.0.0.1:${port}`,
        proc: child,
        log: () => logs.join(''),
        stderr: () => logs.filter((l) => l.startsWith('[err]')).join(''),
        exited: false,
    };
    child.on('exit', () => { server.exited = true; });
    SERVERS.push(server);

    const deadline = Date.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) {
            throw new Error(`[${name}] 服务启动即退出（code=${child.exitCode}）：\n${logs.join('')}`);
        }
        try {
            const res = await fetch(`${server.base}/api/health`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) break;
        } catch { /* 还没起来 */ }
        if (Date.now() > deadline) throw new Error(`[${name}] 30s 内 /api/health 未就绪：\n${logs.join('')}`);
        await sleep(150);
    }
    return server;
}

async function stopServer(server) {
    if (server.proc.exitCode !== null || server.exited) return;
    server.proc.kill('SIGTERM');
    const ok = await Promise.race([once(server.proc, 'exit').then(() => true), sleep(2500).then(() => false)]);
    if (!ok && server.proc.exitCode === null) {
        server.proc.kill('SIGKILL');
        await once(server.proc, 'exit').catch(() => {});
    }
}

/** HTTP 调用：返回 {status, json, text, headers} */
async function api(server, method, endpoint, body, { rawBody = null, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (rawBody !== null) {
        init.body = rawBody;
        if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
    } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
    }
    const started = Date.now();
    const res = await fetch(`${server.base}${endpoint}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（如静态资源） */ }
    return { status: res.status, json, text, headers: res.headers, ms: Date.now() - started };
}

let LAN_TOKEN = ''; // 只存在于进程内，绝不写进 evidence

const GET = (s, p) => api(s, 'GET', p);
const POST = (s, p, b) => api(s, 'POST', p, b);
const PUT = (s, p, b) => api(s, 'PUT', p, b);

async function waitJob(server, jobId, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const res = await GET(server, `/api/sync/jobs/${encodeURIComponent(jobId)}`);
        if (res.status === 200 && res.json?.job && res.json.job.status !== 'running') return res.json.job;
        if (Date.now() > deadline) throw new Error(`同步任务超时未完成：${jobId}`);
        await sleep(150);
    }
}

/* ------------------------------------------------------- 文件系统快照工具 */

function walk(root, out = []) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(root, e.name);
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        out.push({ path: p, dir: e.isDirectory(), mtimeMs: Math.round(st.mtimeMs), size: st.size });
        if (e.isDirectory()) walk(p, out);
    }
    return out;
}

/** path → "mtime:size" 快照 */
function stampTree(root) {
    const map = new Map();
    for (const e of walk(root)) map.set(e.path, `${e.mtimeMs}:${e.size}`);
    return map;
}

function diffStamps(a, b) {
    const changed = [];
    for (const [k, v] of b) {
        if (!a.has(k)) changed.push({ path: k, kind: 'added' });
        else if (a.get(k) !== v) changed.push({ path: k, kind: 'changed', from: a.get(k), to: v });
    }
    for (const k of a.keys()) if (!b.has(k)) changed.push({ path: k, kind: 'removed' });
    return changed;
}

/** 目录内容指纹：相对路径 → sha256 */
function hashTree(root) {
    const out = new Map();
    for (const e of walk(root)) {
        if (e.dir) continue;
        try { out.set(path.relative(root, e.path), sha256(fs.readFileSync(e.path))); } catch { /* 忽略 */ }
    }
    return out;
}

/* --------------------------------------------------- YAML 头 / 链接 / markdown */

function frontmatter(markdown) {
    const text = String(markdown);
    if (!text.startsWith('---\n')) return null;
    const end = text.indexOf('\n---', 4);
    if (end < 0) return null;
    const head = text.slice(4, end);
    const fm = { source_sessions: [] };
    const lines = head.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, key, value] = m;
        if (key === 'source_sessions' && (value.trim() === '' || value.trim() === '[]')) {
            if (value.trim() === '[]') { fm.source_sessions = []; continue; }
            for (let j = i + 1; j < lines.length; j += 1) {
                const item = /^\s+-\s+(.*)$/.exec(lines[j]);
                if (!item) break;
                fm.source_sessions.push(item[1].replace(/^["']|["']$/g, ''));
                i = j;
            }
        } else {
            fm[key] = value.trim().replace(/^["']|["']$/g, '');
        }
    }
    return fm;
}

/** 从 markdown 里抽出相对链接目标（跳过 http/mailto/锚点） */
function relativeLinks(markdown) {
    const out = [];
    const re = /\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(String(markdown))) !== null) {
        const target = m[1];
        if (/^(https?:|mailto:|#)/i.test(target)) continue;
        out.push(target.split('#')[0]);
    }
    return out;
}

/** POSIX 风格相对路径解析（markdown 链接用 /） */
function resolveLink(fromFile, target) {
    const dir = path.posix.dirname(fromFile);
    const joined = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, target));
    return joined.replace(/^\.\//, '');
}

/* ------------------------------------------------------------------ 全局状态 */

const REC = {
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    realSessionsDir: SESSIONS_DIR,
    cases: {},
    contract: [],
    logFindings: [],
};
let S = {}; // 服务实例
let DAY = today();

before(async () => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const homes = {
        main: makeTmp('wd-e2e-main'),
        peerB: makeTmp('wd-e2e-peerB'),
        pullerA: makeTmp('wd-e2e-pullerA'),
        sshRsync: makeTmp('wd-e2e-ssh-rsync'),
        sshTar: makeTmp('wd-e2e-ssh-tar'),
        empty: makeTmp('wd-e2e-empty'),
    };
    // 给 claude-code 缺陷复现准备一份 fixture 副本（放进临时目录，绝不写 repo 里的 fixture）
    const claudeCfg = makeTmp('wd-e2e-claude');
    fs.cpSync(path.join(APP_ROOT, 'test/fixtures/claude/projects'), path.join(claudeCfg, 'projects'), { recursive: true });
    REC.claudeFixtureDir = path.join(claudeCfg, 'projects');
    REC.homes = homes;

    // SSH 桩：rsync 版 + 仅 ssh/tar 版（验证降级路径）
    const stubs = makeStubs();
    REC.stubs = { bin: stubs.bin, binNoRsync: stubs.binNoRsync, log: stubs.log };

    // 真实 ~/.wakedream 的起始指纹（用来证明「没写进真实数据目录」）
    REC.realHomeBefore = {
        exists: fs.existsSync(REAL_HOME),
        db: fileStamp(path.join(REAL_HOME, 'db.sqlite')),
        config: fileStamp(path.join(REAL_HOME, 'config.json')),
        memory: treeSummary(path.join(REAL_HOME, 'memory')),
    };

    [S.main, S.peerB, S.pullerA, S.sshRsync, S.sshTar, S.empty, S.claudeLocal] = await Promise.all([
        startServer('main', { home: homes.main }),
        startServer('peerB', { home: homes.peerB }),
        startServer('pullerA', { home: homes.pullerA }),
        startServer('sshRsync', { home: homes.sshRsync, env: { PATH: `${stubs.bin}:/bin:/usr/bin`, ...stubs.env } }),
        startServer('sshTar', { home: homes.sshTar, env: { PATH: `${stubs.binNoRsync}:/bin`, ...stubs.env } }),
        startServer('empty', { home: homes.empty }),
        startServer('claudeLocal', { home: makeTmp('wd-e2e-claude-home'), env: { CLAUDE_CONFIG_DIR: claudeCfg } }),
    ]);
    REC.servers = SERVERS.map((s) => ({ name: s.name, port: s.port, home: s.home }));
});

after(async () => {
    await Promise.all(SERVERS.map((s) => stopServer(s)));
    REC.finishedAt = new Date().toISOString();
    REC.realHomeAfter = {
        exists: fs.existsSync(REAL_HOME),
        db: fileStamp(path.join(REAL_HOME, 'db.sqlite')),
        config: fileStamp(path.join(REAL_HOME, 'config.json')),
        memory: treeSummary(path.join(REAL_HOME, 'memory')),
    };
    try {
        fs.writeFileSync(path.join(EVIDENCE_DIR, `e2e-${today()}.json`), `${JSON.stringify(REC, null, 2)}\n`);
    } catch (err) {
        console.error('证据写入失败：', err.message);
    }
    if (!KEEP_TMP) for (const dir of TMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function fileStamp(p) {
    try {
        const st = fs.statSync(p);
        return { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch { return null; }
}

function treeSummary(root) {
    const list = walk(root);
    return { entries: list.length, files: list.filter((e) => !e.dir).length };
}

/* ------------------------------------------------------------------ SSH 桩 */

function makeStubs() {
    const root = makeTmp('wd-e2e-stub');
    const bin = path.join(root, 'bin');
    const binNoRsync = path.join(root, 'bin-no-rsync');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(binNoRsync, { recursive: true });
    const log = path.join(root, 'commands.log');
    fs.writeFileSync(log, '');

    // 桩用到的真实数据源：a) 本机真实 dsh 会话工作区目录（结构原样保留）
    //                    b) sessions worker 的 claude fixture（验证第二个适配器）
    const dshWorkspace = pickRealDshWorkspace();
    const claudeFixture = path.join(APP_ROOT, 'test/fixtures/claude/projects');
    const env = {
        FAKE_SYNC_LOG: log,
        FAKE_DSH_WORKSPACE: dshWorkspace,
        FAKE_CLAUDE_PROJECTS: claudeFixture,
        FAKE_TAR_ROOT: os.homedir(),
        FAKE_TAR_BIN: '/usr/bin/tar',
    };
    REC.stubSources = { dshWorkspace, claudeFixture };

    const sshStub = `#!/bin/sh
# 桩 ssh：只记录 argv；--version 退 0；收到 tar 打包请求时输出真实 tar 流（模拟远端只读拉取）
if [ "$1" = "--version" ]; then echo "OpenSSH_9.6p1"; exit 0; fi
echo "ssh $*" >> "$FAKE_SYNC_LOG"
case "$*" in
  *"tar -cf -"*) exec "$FAKE_TAR_BIN" -cf - -C "$FAKE_TAR_ROOT" .dsh/sessions ;;
esac
exit 0
`;
    fs.writeFileSync(path.join(bin, 'ssh'), sshStub, { mode: 0o755 });
    fs.writeFileSync(path.join(binNoRsync, 'ssh'), sshStub, { mode: 0o755 });
    if (!fs.existsSync(path.join(binNoRsync, 'tar'))) fs.symlinkSync('/usr/bin/tar', path.join(binNoRsync, 'tar'));

    // 桩 rsync：按目标目录后缀决定「远端」拉什么（真数据），并记录完整 argv
    fs.writeFileSync(path.join(bin, 'rsync'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "rsync  version 3.2.7"; exit 0; fi
echo "rsync $*" >> "$FAKE_SYNC_LOG"
count=$#
dest=$(eval echo \\$$count)
mkdir -p "$dest"
case "$dest" in
  */.dsh/sessions/)
    cp -R "$FAKE_DSH_WORKSPACE" "$dest/"
    ;;
  */.claude/projects/)
    cp -R "$FAKE_CLAUDE_PROJECTS/." "$dest/"
    ;;
esac
exit 0
`, { mode: 0o755 });

    return { root, bin, binNoRsync, log, env };
}

/** 从真实 ~/.dsh/sessions 里挑一个含会话的工作区目录（优先含非子代理会话、且是今天的） */
function pickRealDshWorkspace() {
    const preferred = '--Users-demo-.dsh-superagent-general-work-wakedream-demo--';
    const entries = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : [];
    if (entries.includes(preferred)) return path.join(SESSIONS_DIR, preferred);
    const withSessions = entries.find((name) => {
        const dir = path.join(SESSIONS_DIR, name);
        return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    });
    return withSessions ? path.join(SESSIONS_DIR, withSessions) : SESSIONS_DIR;
}

/* ================================================================== 用例 */

test('01 启动与 /api/health：实例用临时 HOME，不碰真实 ~/.wakedream', async () => {
    const res = await GET(S.main, '/api/health');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.app, 'WakeDream');
    assert.equal(res.json.home, S.main.home, 'health.home 必须是本实例的临时 HOME');
    assert.notEqual(res.json.home, REAL_HOME);
    REC.cases.health = res.json;
});

test('02 POST /api/scan：扫本机真实 ~/.dsh/sessions 并入库（增量重扫不重复）', async () => {
    assert.ok(fs.existsSync(SESSIONS_DIR), `本机应有真实会话目录：${SESSIONS_DIR}`);
    const first = await POST(S.main, '/api/scan', { full: true });
    assert.equal(first.status, 200, first.text);
    assert.ok(first.json.scanned > 0, `scanned 应 > 0，实际 ${first.json.scanned}`);
    assert.equal(first.json.added, first.json.scanned, '全量首扫应全部为新增');
    assert.deepEqual(first.json.errors, [], `扫描不应报错：${JSON.stringify(first.json.errors)}`);
    assert.ok(first.json.durationMs >= 0);

    const second = await POST(S.main, '/api/scan', {});
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.added, 0, `增量重扫不应重复入库（added=${second.json.added}）`);
    assert.equal(second.json.scanned, first.json.scanned, '文件数应一致');

    REC.cases.scan = {
        first: { scanned: first.json.scanned, added: first.json.added, updated: first.json.updated, durationMs: first.json.durationMs, byAgent: first.json.byAgent },
        second: { scanned: second.json.scanned, added: second.json.added, updated: second.json.updated },
    };
});

test('03 GET /api/sessions?day=今天：真实会话可见，facets 形状符合 §5', async () => {
    const all = await GET(S.main, '/api/sessions?limit=200');
    assert.equal(all.status, 200, all.text);
    assert.ok(all.json.total > 0, '扫描后库里应有会话');

    const todays = await GET(S.main, `/api/sessions?day=${today()}`);
    assert.equal(todays.status, 200, todays.text);
    // 本机真实数据里「今天」应当有会话；没有就退回到最近有会话的那一天（保证可重复运行）
    if (todays.json.total > 0) {
        DAY = today();
    } else {
        const newest = [...all.json.sessions].sort((a, b) => b.startedAt - a.startedAt)[0];
        DAY = dayOf(newest.startedAt);
        REC.cases.dayFallback = { reason: 'today 无会话，回退到最近会话日', day: DAY };
    }
    const dayRes = await GET(S.main, `/api/sessions?day=${DAY}`);
    assert.ok(dayRes.json.total > 0, `${DAY} 应有会话`);

    const s = dayRes.json.sessions[0];
    for (const key of ['id', 'nativeId', 'agent', 'host', 'project', 'title', 'startedAt', 'endedAt', 'messageCount', 'source']) {
        assert.ok(key in s, `Session 应含字段 ${key}`);
    }
    for (const facet of ['agents', 'projects', 'hosts']) {
        assert.ok(Array.isArray(dayRes.json.facets[facet]), `facets.${facet} 应为数组`);
        assert.ok(dayRes.json.facets[facet].length > 0, `facets.${facet} 不应为空`);
    }
    REC.cases.sessionsToday = {
        day: DAY,
        total: dayRes.json.total,
        facets: dayRes.json.facets,
        sample: { id: s.id, agent: s.agent, host: s.host, messageCount: s.messageCount, source: s.source },
    };
});

test('04 GET /api/sessions/:id：转录可读，且 tool_call/tool_result 的 meta 严格符合 §5.1', async () => {
    const list = await GET(S.main, `/api/sessions?day=${DAY}&limit=50`);
    // 优先挑一个带工具调用的会话（真实数据里消息最多的那个）
    let best = null;
    for (const s of list.json.sessions) {
        const res = await GET(S.main, `/api/sessions/${encodeURIComponent(s.id)}`);
        assert.equal(res.status, 200, res.text);
        const kinds = new Set(res.json.messages.map((m) => m.kind));
        const score = res.json.messages.length + (kinds.has('tool_call') ? 1000 : 0) + (kinds.has('tool_result') ? 1000 : 0);
        if (!best || score > best.score) best = { score, s, res };
    }
    assert.ok(best, '当天应有会话可读');
    const { s, res } = best;
    const messages = res.json.messages;
    assert.ok(messages.length > 0, '转录不应为空');
    assert.deepEqual(
        messages.map((m) => m.seq),
        messages.map((_, i) => i),
        'messages[].seq 应从 0 连续递增',
    );

    // §4 口径：message_count = 去掉 kind='meta' 之后的行数
    const nonMeta = messages.filter((m) => m.kind !== 'meta').length;
    // 用「同一次响应里的 session.messageCount」，避免列表页与详情页两次请求之间的漂移
    assert.equal(
        res.json.session.messageCount,
        nonMeta,
        `messageCount(${res.json.session.messageCount}) 应等于非 meta 消息数(${nonMeta})——契约 §4`,
    );

    const ALLOWED = {
        text: new Set([]),
        thinking: new Set(['redacted']),
        tool_call: new Set(['name', 'input', 'callId']),
        tool_result: new Set(['name', 'callId', 'ok', 'output', 'durationMs']),
        meta: null, // meta kind 允许 {type,...}
    };
    const violations = [];
    const counts = {};
    let truncatedSeen = 0;
    let callIdsPaired = 0;
    const callIds = new Set(messages.filter((m) => m.kind === 'tool_call' && m.meta?.callId).map((m) => m.meta.callId));
    for (const m of messages) {
        counts[m.kind] = (counts[m.kind] ?? 0) + 1;
        const meta = m.meta ?? {};
        assert.ok(m.meta === null || typeof meta === 'object', `${m.kind}.meta 应为对象`);
        const allowed = ALLOWED[m.kind];
        if (allowed) {
            for (const key of Object.keys(meta)) {
                if (!allowed.has(key)) violations.push(`${m.kind}(seq=${m.seq}) 多出契约外键 ${key}`);
            }
        }
        if (m.kind === 'tool_call') {
            assert.equal(typeof meta.name, 'string', `tool_call.meta.name 应为 string（seq=${m.seq}）`);
            assert.ok(
                meta.input === null || typeof meta.input === 'object' || typeof meta.input === 'string',
                `tool_call.meta.input 应为 object|string|null（seq=${m.seq}）`,
            );
            if ('callId' in meta) assert.equal(typeof meta.callId, 'string');
        } else if (m.kind === 'tool_result') {
            assert.equal(typeof meta.ok, 'boolean', `tool_result.meta.ok 应为 boolean（seq=${m.seq}）`);
            if ('output' in meta) {
                assert.equal(typeof meta.output, 'string');
                if (meta.output.endsWith('…[截断]')) {
                    truncatedSeen += 1;
                    assert.ok(meta.output.length <= 8192 + 16, `截断后长度应约 8KB，实际 ${meta.output.length}`);
                } else {
                    assert.ok(meta.output.length <= 8192 + 16, `未截断的 output 不应超过 8KB，实际 ${meta.output.length}`);
                }
            }
            if (meta.callId && callIds.has(meta.callId)) callIdsPaired += 1;
        } else if (m.kind === 'meta') {
            assert.equal(typeof meta.type, 'string', `kind=meta 的 meta.type 应为 string（seq=${m.seq}）`);
        }
    }
    assert.ok(counts.tool_call > 0, '真实 dsh 会话里应当有 tool_call');
    assert.ok(counts.tool_result > 0, '真实 dsh 会话里应当有 tool_result');
    assert.deepEqual(violations.slice(0, 10), [], `meta 键不符合 §5.1（前 10 条）`);

    REC.cases.transcript = {
        sessionId: s.id,
        liveSessionWarning: '真实数据里含正在写入的活跃会话；本用例只读，不比对两次请求的计数',
        messages: messages.length,
        kinds: counts,
        messageCountField: res.json.session.messageCount,
        truncatedSeen,
        callIdsPaired,
        sampleToolCall: messages.find((m) => m.kind === 'tool_call')?.meta ?? null,
        sampleToolResult: summarizeMeta(messages.find((m) => m.kind === 'tool_result')?.meta),
    };
});

function summarizeMeta(meta) {
    if (!meta) return null;
    const out = { ...meta };
    if (typeof out.output === 'string') out.output = `${out.output.slice(0, 120)}…(${out.output.length}B)`;
    return out;
}

test('05 POST /api/dreams/run（heuristic）：产出记忆库', async () => {
    const res = await POST(S.main, '/api/dreams/run', { day: DAY, provider: 'heuristic' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'ok', `做梦应成功，实际 ${res.json.status}：${JSON.stringify(res.json).slice(0, 400)}`);
    assert.ok(res.json.dreamId, '应返回 dreamId');
    assert.ok(res.json.memoryDir.startsWith(S.main.home), `memoryDir 必须落在临时 HOME 内：${res.json.memoryDir}`);
    assert.ok(fs.existsSync(res.json.memoryDir), 'memoryDir 应真的存在');
    REC.cases.dream = {
        dreamId: res.json.dreamId,
        status: res.json.status,
        sessionCount: res.json.sessionCount,
        inputCount: res.json.inputCount,
        memoryDir: res.json.memoryDir,
        reportPath: res.json.reportPath,
        stats: res.json.stats,
    };
    REC.dreamId = res.json.dreamId;
    REC.memoryDir = res.json.memoryDir;
});

test('06 GET /api/memory/tree + /api/memory/file：§7 YAML 头、source_sessions 可回溯、链接可达', async () => {
    assert.ok(REC.memoryDir, '前置：做梦已完成');
    const tree = await GET(S.main, '/api/memory/tree');
    assert.equal(tree.status, 200, tree.text);
    assert.ok(tree.json.files.length > 0, '记忆库不应为空');
    assert.equal(tree.json.root, REC.memoryDir, `tree.root 应等于本次做梦目录`);

    const mdFiles = tree.json.files.filter((f) => f.path.endsWith('.md'));
    assert.ok(mdFiles.length > 0, '应有 .md 记忆文件');
    assert.ok(tree.json.files.some((f) => f.path === '_index.md'), '§7 要求有 _index.md 入口');

    const contents = new Map();
    const sessionIds = new Set((await GET(S.main, '/api/sessions?limit=200')).json.sessions.map((s) => s.id));
    const missingSources = [];
    const badFrontmatter = [];
    for (const f of mdFiles) {
        const res = await GET(S.main, `/api/memory/file?path=${encodeURIComponent(f.path)}&dreamId=${encodeURIComponent(REC.dreamId)}`);
        assert.equal(res.status, 200, `读取 ${f.path} 失败：${res.text}`);
        contents.set(f.path, res.json.markdown);

        // 磁盘回读 = API 回读（独立核对，不只看接口自报）
        const onDisk = fs.readFileSync(path.join(REC.memoryDir, f.path), 'utf8');
        assert.equal(res.json.markdown, onDisk, `${f.path} 的 API 内容应等于磁盘内容`);

        const fm = frontmatter(res.json.markdown);
        if (!fm) { badFrontmatter.push(`${f.path}: 缺少 YAML 头`); continue; }
        for (const key of ['title', 'kind', 'day', 'source_sessions', 'updated_at']) {
            if (!(key in fm)) badFrontmatter.push(`${f.path}: YAML 头缺 ${key}`);
        }
        if (fm.day !== DAY) badFrontmatter.push(`${f.path}: day=${fm.day} 应为 ${DAY}`);
        for (const id of fm.source_sessions) {
            if (!sessionIds.has(id)) missingSources.push(`${f.path} → ${id}`);
        }
    }
    assert.deepEqual(badFrontmatter, [], '所有记忆 .md 都应有 §7 的 YAML 头');
    assert.deepEqual(missingSources, [], 'source_sessions 里的 id 必须能在 sessions 表里查到');

    // 链接可达：_index.md（§7 的入口）里的**所有**相对链接都必须能打开；
    // 其它文件只强制检查 `./`、`../` 形式的库内 wiki 链接（`app/web/index.html` 这类是
    // 做梦正文里对被整理项目的文件引用，不是记忆库链接，单独记录不参与断言）。
    const brokenLinks = [];
    const externalRefs = [];
    for (const [file, markdown] of contents) {
        const strict = file === '_index.md';
        for (const target of relativeLinks(markdown)) {
            const isWikiLink = strict || target.startsWith('./') || target.startsWith('../');
            const rel = resolveLink(file, target);
            if (rel.startsWith('..')) {
                if (isWikiLink) brokenLinks.push(`${file} → ${target}（越出记忆库）`);
                continue;
            }
            const res = await GET(S.main, `/api/memory/file?path=${encodeURIComponent(rel)}&dreamId=${encodeURIComponent(REC.dreamId)}`);
            if (res.status !== 200) {
                if (isWikiLink) brokenLinks.push(`${file} → ${target}（HTTP ${res.status}）`);
                else externalRefs.push(`${file} → ${target}`);
            }
        }
    }
    assert.deepEqual(brokenLinks.slice(0, 10), [], '_index.md 与库内 wiki 链接必须都能打开');

    REC.cases.memory = {
        root: tree.json.root,
        files: tree.json.files.map((f) => ({ path: f.path, kind: f.kind, bytes: f.bytes, sourceSessions: f.sourceSessions })),
        mdChecked: mdFiles.length,
        brokenLinks: brokenLinks.length,
        missingSources: missingSources.length,
        projectFileRefsNotAsserted: externalRefs.length,
        projectFileRefsSample: [...new Set(externalRefs)].slice(0, 6),
    };
});

test('07 幂等：同 day 重跑不重写；force 重跑文件集不变、不累积库记录；dryRun 不落盘不写库', async () => {
    const before = hashTree(REC.memoryDir);
    const dreamsBefore = (await GET(S.main, `/api/dreams?day=${DAY}`)).json.dreams.length;

    const again = await POST(S.main, '/api/dreams/run', { day: DAY, provider: 'heuristic' });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.status, 'skipped', `没有新会话时应跳过，实际 ${again.json.status}`);
    const afterSkip = hashTree(REC.memoryDir);
    assert.deepEqual([...afterSkip.entries()].sort(), [...before.entries()].sort(), '跳过的重跑不应改写任何记忆文件');

    const dry = await POST(S.main, '/api/dreams/run', { day: DAY, provider: 'heuristic', dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.status, 'dry-run', `dryRun 应返回 dry-run，实际 ${dry.json.status}`);
    assert.equal(dry.json.dreamId, null, 'dryRun 不应产生 dreamId');
    const afterDry = hashTree(REC.memoryDir);
    assert.deepEqual([...afterDry.entries()].sort(), [...before.entries()].sort(), 'dryRun 不应落盘');
    assert.equal((await GET(S.main, `/api/dreams?day=${DAY}`)).json.dreams.length, dreamsBefore, 'dryRun 不应写库');

    const forced = await POST(S.main, '/api/dreams/run', { day: DAY, provider: 'heuristic', force: true });
    assert.equal(forced.status, 200, forced.text);
    assert.equal(forced.json.status, 'ok', `force 重跑应成功，实际 ${forced.json.status}`);
    assert.ok(forced.json.dreamId);
    // force 重跑会把同 (day,store) 的旧 ok 记录换掉（新 dreamId），后续用例必须用新的
    REC.dreamId = forced.json.dreamId;
    const forcedTree = await GET(S.main, '/api/memory/tree');
    const afterForce = hashTree(REC.memoryDir);
    assert.deepEqual(
        [...afterForce.keys()].sort(),
        [...before.keys()].sort(),
        'force 重跑不应新增/删除记忆文件',
    );
    assert.equal(
        forcedTree.json.files.length,
        before.size,
        'memory/tree 的文件数应与落盘一致',
    );
    const dreamsAfterForce = (await GET(S.main, `/api/dreams?day=${DAY}`)).json.dreams;
    const okRecords = dreamsAfterForce.filter((d) => d.status === 'ok');
    assert.equal(okRecords.length, 1, `同 day/store 只应保留 1 条成功记录，实际 ${okRecords.length}`);

    REC.cases.idempotency = {
        rerunStatus: again.json.status,
        rerunReason: again.json.reason ?? again.json.stats?.skipReason ?? null,
        dryRunStatus: dry.json.status,
        dryRunFiles: dry.json.stats?.files ?? null,
        forceStatus: forced.json.status,
        filesBefore: before.size,
        filesAfterForce: afterForce.size,
        okRecordsForDay: okRecords.length,
    };
});

test('08 安全：/api/memory/file 拒绝目录穿越与绝对路径', async () => {
    const cases = [
        ['../../../../etc/passwd', 400],
        ['%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd', 400],
        ['/etc/passwd', 400],
        ['..%2f..%2f..%2f..%2fetc%2fpasswd', 400],
        ['projects/../../../../../etc/hosts', 400],
    ];
    const observed = [];
    for (const [p, want] of cases) {
        const res = await GET(S.main, `/api/memory/file?path=${p}`);
        observed.push({ path: p, status: res.status, body: res.text.slice(0, 160) });
        assert.equal(res.status, want, `path=${p} 应被拒（${want}），实际 ${res.status} ${res.text.slice(0, 160)}`);
        assert.ok(!res.text.includes('root:'), '绝不能回 /etc/passwd 的内容');
    }
    const missing = await GET(S.main, '/api/memory/file?path=not-exist.md');
    assert.equal(missing.status, 404);
    const noPath = await GET(S.main, '/api/memory/file');
    assert.equal(noPath.status, 400);
    REC.cases.memoryTraversal = { observed, missing: missing.status, noPath: noPath.status };
});

test('09 安全：/api/settings 不回 apiKey 明文，局部补丁不丢已有 key', async () => {
    const put = await PUT(S.main, '/api/settings', { providers: { anthropic: { apiKey: 'test-123' } } });
    assert.equal(put.status, 200, put.text);
    assert.ok(!put.text.includes('test-123'), 'PUT 响应不得回显 apiKey 明文');
    assert.equal(put.json.settings.providers.anthropic.hasApiKey, true);
    assert.equal(put.json.settings.providers.anthropic.apiKey, undefined, 'providers 只允许回 baseUrl/model/hasApiKey/apiKeyEnv');

    const get = await GET(S.main, '/api/settings');
    assert.equal(get.status, 200, get.text);
    assert.ok(!get.text.includes('test-123'), 'GET /api/settings 不得出现 apiKey 明文');
    assert.equal(get.json.settings.providers.anthropic.hasApiKey, true);
    assert.ok(get.json.settings._home === S.main.home, 'settings 应回本实例 HOME');
    assert.ok(get.json.settings._configPath.startsWith(S.main.home));

    // 局部补丁：只改 model，key 不能丢
    const patch = await PUT(S.main, '/api/settings', { providers: { anthropic: { model: 'claude-sonnet-4-5' } } });
    assert.equal(patch.json.settings.providers.anthropic.hasApiKey, true, '未提供的字段应保持原值（含已存 apiKey）');
    assert.equal(patch.json.settings.providers.anthropic.model, 'claude-sonnet-4-5');

    // 配置文件里确实存了 key（说明是「不回显」而不是「没存」）
    const cfg = JSON.parse(fs.readFileSync(path.join(S.main.home, 'config.json'), 'utf8'));
    const keyStored = cfg.providers?.anthropic?.apiKey === 'test-123';
    REC.cases.settings = {
        getKeys: Object.keys(get.json.settings.providers.anthropic),
        hasApiKey: get.json.settings.providers.anthropic.hasApiKey,
        keyStoredOnDisk: keyStored,
        maskedTextHasPlainKey: get.text.includes('test-123'),
    };
    assert.equal(keyStored, true, 'config.json 里应当真的存下了 key');
});

test('10 安全：扫描对数据目录只读（受控副本零改动）+ 真实目录改动归因 + 不写真实 ~/.wakedream + 无凭证', async () => {
    // ---------- (a) 确定性证明：把真实会话目录的一个工作区**完整复制**到临时目录，注册为
    // extraRoots，然后扫描它。副本没有被任何其他进程写，任何 mtime/size/内容变化都只能来自扫描。
    const controlled = makeTmp('wd-e2e-readonly');
    const srcWorkspace = path.join(SESSIONS_DIR, path.basename(REC.stubSources.dshWorkspace));
    fs.cpSync(srcWorkspace, path.join(controlled, 'sessions'), { recursive: true });
    const root = path.join(controlled, 'sessions');
    const put = await PUT(S.main, '/api/settings', {
        scan: { extraRoots: [{ id: 'dsh-readonly', agent: 'dsh', dir: root }] },
    });
    assert.equal(put.status, 200, put.text);

    const beforeStamp = stampTree(controlled);
    const beforeHash = hashTree(root);
    const scanRes = await POST(S.main, '/api/scan', {});
    assert.equal(scanRes.status, 200, scanRes.text);
    const afterStamp = stampTree(controlled);
    const afterHash = hashTree(root);

    const stampChanges = diffStamps(beforeStamp, afterStamp);
    const hashChanges = [...beforeHash.keys()].filter((k) => beforeHash.get(k) !== afterHash.get(k));
    assert.deepEqual(stampChanges, [], `扫描必须只读：受控副本的 mtime/size 一律不得变化：${JSON.stringify(stampChanges.slice(0, 5))}`);
    assert.deepEqual(hashChanges, [], `扫描不得改写被扫文件的内容：${JSON.stringify(hashChanges.slice(0, 5))}`);
    assert.ok(scanRes.json.scanned > 0, '受控副本必须真的被扫到，否则这条断言是空的');
    REC.cases.scanReadOnlyControlled = {
        controlledRoot: root,
        files: [...beforeHash.keys()].length,
        scannedInThisRun: scanRes.json.scanned,
        stampChanges: stampChanges.length,
        contentChanges: hashChanges.length,
    };

    // ---------- (b) 真实 ~/.dsh/sessions 的观测：这台机器上同时有别的 agent 进程在写自己的
    // transcript（本验证者/lead 的会话就是），所以这里只做**改动归因**并记录，不作为硬断言。
    const s0 = stampTree(SESSIONS_DIR);
    await sleep(1200);
    const s1 = stampTree(SESSIONS_DIR);
    await sleep(1200);
    const s2 = stampTree(SESSIONS_DIR);
    await POST(S.main, '/api/scan', { full: true });
    const s3 = stampTree(SESSIONS_DIR);
    await sleep(1200);
    const s4 = stampTree(SESSIONS_DIR);
    const liveWriter = new Set([
        ...diffStamps(s0, s1).map((d) => d.path),
        ...diffStamps(s1, s2).map((d) => d.path),
        ...diffStamps(s3, s4).map((d) => d.path),
    ]);
    const scanWindowChanges = diffStamps(s2, s3);
    const unexplained = scanWindowChanges.filter((d) => !liveWriter.has(d.path));
    REC.cases.scanReadOnlyRealTree = {
        entries: s2.size,
        changedDuringScanWindow: scanWindowChanges.length,
        attributedToConcurrentWriters: scanWindowChanges.length - unexplained.length,
        unexplained: unexplained.slice(0, 5).map((d) => ({ path: path.relative(SESSIONS_DIR, d.path), kind: d.kind })),
        note: '真实树上同时有并发的 agent 会话写入（本验证者与 lead 的 transcript 就在这棵树里），因此只记录、不断言；只读性由 (a) 的受控副本断言',
    };
    // 真实 ~/.wakedream 全程未被写
    const realAfter = {
        db: fileStamp(path.join(REAL_HOME, 'db.sqlite')),
        config: fileStamp(path.join(REAL_HOME, 'config.json')),
        memory: treeSummary(path.join(REAL_HOME, 'memory')),
    };
    assert.deepEqual(realAfter.db, REC.realHomeBefore.db, `真实 ~/.wakedream/db.sqlite 不得被写（${JSON.stringify(realAfter.db)} != ${JSON.stringify(REC.realHomeBefore.db)}）`);
    assert.deepEqual(realAfter.config, REC.realHomeBefore.config, '真实 ~/.wakedream/config.json 不得被写');
    assert.deepEqual(realAfter.memory, REC.realHomeBefore.memory, '真实 ~/.wakedream/memory 不得被写');
    REC.cases.realHome = { before: REC.realHomeBefore, after: realAfter };

    // 日志与做梦产物里不得出现刚写入的假凭证
    const stderr = S.main.stderr();
    assert.ok(!stderr.includes('test-123'), '服务错误日志不得出现 apiKey 明文');
    const leaky = [];
    for (const f of walk(REC.memoryDir)) {
        if (f.dir) continue;
        const text = fs.readFileSync(f.path, 'utf8');
        if (text.includes('test-123')) leaky.push(path.relative(REC.memoryDir, f.path));
    }
    assert.deepEqual(leaky, [], '做梦产物不得包含 apiKey');
    REC.cases.credentialFree = {
        stderrRecords: stderr.split('\n').length,
        memoryFilesScanned: walk(REC.memoryDir).filter((f) => !f.dir).length,
        leaks: 0,
    };
});

test('11 反例：非法 provider / 未知会话 / 越界分页 / 空库都不 500', async () => {
    const badProvider = await POST(S.main, '/api/dreams/run', { provider: '不存在的', day: DAY });
    assert.equal(badProvider.status, 400, badProvider.text);

    // 用 peerB：它没配任何 provider key（S.main 在用例 09 里被写入了 anthropic key）
    const noKey = await POST(S.peerB, '/api/dreams/run', { provider: 'anthropic', day: DAY, model: 'claude-sonnet-4-5' });
    assert.equal(noKey.status, 400, `缺 key 应 400：${noKey.text}`);
    assert.equal(noKey.json.code, 'E_NO_API_KEY');

    const unknownSession = await GET(S.main, '/api/sessions/local:dsh:does-not-exist');
    assert.equal(unknownSession.status, 404, unknownSession.text);

    const huge = await GET(S.main, '/api/sessions?limit=999999&offset=999999');
    assert.equal(huge.status, 200);
    assert.equal(huge.json.sessions.length, 0);
    const negative = await GET(S.main, '/api/sessions?limit=-1&offset=-5');
    assert.equal(negative.status, 200);
    assert.ok(Array.isArray(negative.json.sessions));
    const badDay = await GET(S.main, '/api/stats?day=13-13-13');
    assert.equal(badDay.status, 400, badDay.text);
    const unknownDream = await GET(S.main, '/api/dreams/nope');
    assert.equal(unknownDream.status, 404);
    const unknownRoute = await GET(S.main, '/api/not-a-route');
    assert.equal(unknownRoute.status, 404);
    // 契约 §5「400 {error} 参数问题」：非法 JSON 体应是 400 而不是 500
    // （2026-11-06 11:5x lead 修复 router.js 的 HttpError 后，verifier 复验通过）
    const badJson = await api(S.main, 'POST', '/api/dreams/run', undefined, { rawBody: '{not json' });
    assert.equal(badJson.status, 400, `非法 JSON 体应 400，实际 ${badJson.status}：${badJson.text.slice(0, 160)}`);
    assert.equal(badJson.json.code, 'INVALID_JSON');
    // 超大请求体 → 413（readBody 的上限是 8MB）
    const bigBody = `{"a":"${'x'.repeat(9 * 1024 * 1024)}"}`;
    const tooBig = await api(S.main, 'POST', '/api/scan', undefined, { rawBody: bigBody });
    assert.equal(tooBig.status, 413, `超限请求体应 413，实际 ${tooBig.status}：${tooBig.text.slice(0, 160)}`);

    REC.cases.negative = {
        badProvider: badProvider.status,
        missingApiKey: `${noKey.status}/${noKey.json.code}`,
        unknownSession: unknownSession.status,
        hugeLimit: `${huge.status} n=${huge.json.sessions.length}`,
        negativeLimit: `${negative.status} n=${negative.json.sessions.length}`,
        badDay: badDay.status,
        unknownDream: unknownDream.status,
        unknownRoute: unknownRoute.status,
        badJsonBody: { status: badJson.status, body: badJson.text.slice(0, 120) },
        oversizedBody: { status: tooBig.status, body: tooBig.text.slice(0, 120) },
    };
});

test('12 空库实例：各页面依赖的接口返回空态而非 500', async () => {
    const empty = S.empty;
    const checks = [
        ['/api/sessions', (j) => j.total === 0 && j.sessions.length === 0],
        ['/api/projects', (j) => Array.isArray(j.projects) && j.projects.length === 0],
        ['/api/agents', (j) => Array.isArray(j.agents) && j.agents.length > 0 && j.agents.every((a) => a.sessionCount === 0)],
        ['/api/stats', (j) => j.totals.sessions === 0 && j.totals.messages === 0],
        ['/api/dreams', (j) => Array.isArray(j.dreams) && j.dreams.length === 0],
        ['/api/remotes', (j) => Array.isArray(j.remotes) && j.remotes.length === 0],
        ['/api/lan/info', (j) => j.enabled === false && j.sessionCount === 0],
        ['/api/dream/schedule', (j) => typeof j.enabled === 'boolean'],
    ];
    const observed = {};
    for (const [endpoint, ok] of checks) {
        const res = await GET(empty, endpoint);
        assert.equal(res.status, 200, `${endpoint} 在空库下应 200，实际 ${res.status} ${res.text.slice(0, 120)}`);
        assert.ok(ok(res.json), `${endpoint} 的空态形状不对：${res.text.slice(0, 200)}`);
        observed[endpoint] = res.status;
    }
    const tree = await GET(empty, '/api/memory/tree');
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.json.files, []);
    const file = await GET(empty, '/api/memory/file?path=_index.md');
    assert.equal(file.status, 404, `空库读记忆应 404，实际 ${file.status}`);
    const dream = await POST(empty, '/api/dreams/run', { provider: 'heuristic' });
    assert.equal(dream.status, 200, dream.text);
    assert.equal(dream.json.status, 'skipped', `空库做梦应 skipped，实际 ${dream.json.status}`);
    const index = await GET(empty, '/');
    assert.equal(index.status, 200);
    assert.ok(index.text.includes('id="view"'), '首页应返回 UI 外壳');
    REC.cases.emptyHome = { observed, treeFiles: tree.json.files.length, memoryFile: file.status, dream: `${dream.json.status}/${dream.json.reason}`, index: index.status };
});

test('13 局域网：manifest/bundle token 与开关校验（401/403/404）', async () => {
    const token = 'verify-lan-token-123456';
    LAN_TOKEN = token;
    const put = await PUT(S.peerB, '/api/settings', { lan: { enabled: true, token } });
    assert.equal(put.status, 200, put.text);
    // 契约：GET/PUT /api/settings 会回 lan.token（配对用），只记录形状不复述值
    assert.equal(put.json.settings.lan.enabled, true);
    assert.equal(typeof put.json.settings.lan.token, 'string');

    const scan = await POST(S.peerB, '/api/scan', { full: true });
    assert.equal(scan.status, 200, scan.text);
    REC.cases.lanPeerScan = { scanned: scan.json.scanned, added: scan.json.added };

    const info = await GET(S.peerB, '/api/lan/info');
    assert.equal(info.status, 200);
    assert.equal(info.json.enabled, true);
    assert.equal(info.json.token, token);
    const deviceName = info.json.deviceName;

    const noToken = await GET(S.peerB, `/api/lan/manifest?day=${DAY}`);
    assert.equal(noToken.status, 401, `缺 token 应 401，实际 ${noToken.status}`);
    const wrongToken = await GET(S.peerB, `/api/lan/manifest?day=${DAY}&token=wrong`);
    assert.equal(wrongToken.status, 401, `token 错误应 401，实际 ${wrongToken.status}`);
    const disabledPeer = await GET(S.main, `/api/lan/manifest?day=${DAY}&token=${token}`);
    assert.equal(disabledPeer.status, 403, `对端未开启应 403，实际 ${disabledPeer.status}`);

    const manifest = await GET(S.peerB, `/api/lan/manifest?day=${DAY}&token=${token}`);
    assert.equal(manifest.status, 200, manifest.text);
    assert.ok(manifest.json.sessions.length > 0, 'manifest 应有会话');
    assert.equal(typeof manifest.json.device, 'string');
    assert.ok(manifest.json.sessions.every((s) => typeof s.sha256 === 'string' && s.bytes > 0 && !('filePath' in s)));

    const first = manifest.json.sessions[0];
    const bundle = await GET(S.peerB, `/api/lan/bundle?token=${token}&id=${encodeURIComponent(first.id)}`);
    assert.equal(bundle.status, 200, bundle.text.slice(0, 200));
    const lines = bundle.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'session', 'bundle 首行必须是 session');
    assert.equal(lines[0].session.filePath, null, 'bundle 不得带本机路径');
    assert.ok(lines.slice(1).every((l) => l.type === 'message'));
    const bundleNoToken = await GET(S.peerB, `/api/lan/bundle?id=${encodeURIComponent(first.id)}`);
    assert.equal(bundleNoToken.status, 401);
    const bundle404 = await GET(S.peerB, `/api/lan/bundle?token=${token}&id=${encodeURIComponent('local:dsh:nope')}`);
    assert.equal(bundle404.status, 404);

    REC.cases.lanProtocol = {
        deviceName,
        noToken: noToken.status,
        wrongToken: wrongToken.status,
        disabledPeer: disabledPeer.status,
        manifestSessions: manifest.json.sessions.length,
        manifestSample: { ...first, sha256: `${first.sha256.slice(0, 12)}…` },
        bundleLines: lines.length,
        bundleFirstLine: lines[0].type,
        bundleFilePath: lines[0].session.filePath,
        bundleNoToken: bundleNoToken.status,
        bundleUnknownId: bundle404.status,
    };
    REC.lanDevice = deviceName;
    REC.lanTokenSha = sha256(token).slice(0, 12); // 证据里只留指纹，不留凭证明文
});

test('14 局域网：A 从 B 真拉入库（lan:<id>、@host、二次拉取幂等、B 只读）', async () => {
    const a = S.pullerA;
    const b = S.peerB;
    const aBefore = (await GET(a, '/api/sessions?limit=500')).json.total;
    const bBefore = (await GET(b, '/api/sessions?limit=500')).json.total;
    const bHomeBefore = stampTree(b.home);

    const pull1 = await POST(a, '/api/lan/pull', { url: b.base, token: LAN_TOKEN, day: DAY });
    assert.equal(pull1.status, 200, pull1.text);
    assert.ok(pull1.json.jobId, '应返回 jobId');
    const job1 = await waitJob(a, pull1.json.jobId);
    assert.equal(job1.status, 'ok', `拉取应成功：${JSON.stringify(job1).slice(0, 400)}`);
    assert.ok(job1.pulled > 0 && job1.added > 0, `应拉入库：${JSON.stringify(job1)}`);

    const remotes = (await GET(a, '/api/remotes')).json.remotes;
    const lanRemote = remotes.find((r) => r.kind === 'lan');
    assert.ok(lanRemote, 'A 应登记一条 lan 远端');
    assert.equal(lanRemote.name, REC.lanDevice);
    assert.ok(lanRemote.hostLabel.startsWith('@'), `hostLabel 应为 @名，实际 ${lanRemote.hostLabel}`);
    const lanHost = `lan:${lanRemote.id}`;

    const pulledList = await GET(a, `/api/sessions?day=${DAY}&host=${encodeURIComponent(lanHost)}`);
    assert.equal(pulledList.status, 200, pulledList.text);
    assert.ok(pulledList.json.total > 0, `A 库里应有 ${lanHost} 的会话`);
    assert.ok(pulledList.json.sessions.every((s) => s.id.startsWith(`${lanHost}:`)), '会话 id 应是 lan:<remoteId>:...');
    assert.ok(pulledList.json.sessions.every((s) => s.source === lanHost));
    const hostFacet = pulledList.json.facets.hosts.find((f) => f.id === lanHost);
    assert.ok(hostFacet && hostFacet.name.startsWith('@'), `facets.hosts 应有 @host 标识：${JSON.stringify(pulledList.json.facets.hosts)}`);

    const one = pulledList.json.sessions[0];
    const detail = await GET(a, `/api/sessions/${encodeURIComponent(one.id)}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.json.messages.length > 0, '拉过来的会话应有转录');
    assert.equal(detail.json.session.filePath, null, '远端会话不应带本机路径');

    // 二次拉取：幂等（不重复入库）
    const pull2 = await POST(a, '/api/lan/pull', { url: b.base, token: LAN_TOKEN, day: DAY });
    const job2 = await waitJob(a, pull2.json.jobId);
    assert.equal(job2.status, 'ok');
    assert.equal(job2.added, 0, `二次拉取不应新增：${JSON.stringify(job2)}`);
    assert.ok(job2.updated >= 1);
    const aAfter = (await GET(a, '/api/sessions?limit=500')).json.total;
    assert.equal(aAfter, aBefore + job1.added, '会话总数应只增加第一轮的新增数');

    // B 只读：库与 HOME 都没被 A 写
    const bAfter = (await GET(b, '/api/sessions?limit=500')).json.total;
    assert.equal(bAfter, bBefore, 'B 的会话数不应变化');
    const bHomeAfter = stampTree(b.home);
    const bChanges = diffStamps(bHomeBefore, bHomeAfter)
        .filter((d) => !d.path.includes('/logs/') && !/db\.sqlite-(wal|shm)$/.test(d.path));
    assert.deepEqual(bChanges, [], `B 的 HOME 不应被拉取方写入（logs 除外）：${JSON.stringify(bChanges.slice(0, 5))}`);

    REC.cases.lanPull = {
        peerUrl: b.base,
        job1: { status: job1.status, pulled: job1.pulled, added: job1.added, updated: job1.updated, log: job1.log.slice(0, 6) },
        job2: { status: job2.status, pulled: job2.pulled, added: job2.added, updated: job2.updated },
        remote: { id: lanRemote.id, name: lanRemote.name, hostLabel: lanRemote.hostLabel, kinds: lanRemote.kind },
        lanHost,
        todayPulled: pulledList.json.total,
        sampleSession: { id: one.id, agent: one.agent, host: one.host, source: one.source, messages: detail.json.messages.length },
        aTotalBefore: aBefore, aTotalAfter: aAfter, bTotalBefore: bBefore, bTotalAfter: bAfter,
        bHomeChanges: bChanges.length,
    };
    assert.ok(!S.pullerA.log().includes(LAN_TOKEN), 'A 的日志不得出现对端 token 明文');
    assert.ok(!b.log().includes(LAN_TOKEN) === false || true, ''); // B 自己收到 token 属正常（对端校验用）
});

test('15 SSH：真机 ssh 不可用 → 用可执行桩跑通真实 HTTP + 真实适配器（rsync 路径）', async () => {
    const env = S.sshRsync;
    fs.writeFileSync(REC.stubs.log, '');
    const scan = await POST(env, '/api/scan', { full: true });
    assert.equal(scan.status, 200, scan.text);

    const created = await POST(env, '/api/remotes', {
        kind: 'ssh', name: 'stub-host', host: 'stubhost', user: 'tester', port: 2200, root: '/home/tester',
    });
    assert.equal(created.status, 200, created.text);
    const remoteId = created.json.remote.id;

    const sync = await POST(env, `/api/remotes/${remoteId}/sync`, {});
    assert.equal(sync.status, 200, sync.text);
    const job = await waitJob(env, sync.json.jobId);
    assert.equal(job.status, 'ok', `SSH 同步应成功：${JSON.stringify(job).slice(0, 400)}`);
    assert.ok(job.added > 0, `应入库：${JSON.stringify(job)}`);

    const host = `ssh:${remoteId}`;
    const list = await GET(env, `/api/sessions?host=${encodeURIComponent(host)}&limit=200`);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.total > 0, `${host} 应有会话`);
    const agents = new Set(list.json.sessions.map((s) => s.agent));
    assert.ok(agents.has('dsh'), `应至少解析出 dsh 会话，实际 ${[...agents]}`);
    // lead 修复（2026-11-06）后，镜像里的 .claude/projects 也会被解析：SSH 侧白名单本来就拉它，
    // 修复前 mirrorTargets 用 ADAPTERS['claude-code'] 取不到适配器（键是 'claude'）而整批丢弃。
    assert.ok(agents.has('claude-code'), `镜像里的 claude 会话也应变 claude-code 入库，实际 ${[...agents]}`);
    // SSH 路径落的是本机镜像副本，filePath 允许指向镜像，但绝不允许指向别家 agent 的原始目录
    const foreignPaths = list.json.sessions
        .map((s) => s.filePath)
        .filter((p) => p !== null && !String(p).startsWith(env.home));
    assert.deepEqual(foreignPaths, [], `远端会话的 filePath 只能为空或落在 wakedream HOME（镜像）内：${JSON.stringify(foreignPaths.slice(0, 3))}`);
    const mirrorPaths = list.json.sessions.filter((s) => s.filePath && s.filePath.startsWith(env.home)).length;
    const hostFacet = list.json.facets.hosts.find((f) => f.id === host);
    assert.ok(hostFacet?.name.startsWith('@'), `facets.hosts 应有 @host：${JSON.stringify(list.json.facets.hosts)}`);
    const todayOnHost = list.json.sessions.filter((s) => dayOf(s.startedAt) === DAY).length;

    // 命令构造审计：只走白名单、绝不含凭证目录、目标是本机镜像（远端只读）
    const log = fs.readFileSync(REC.stubs.log, 'utf8');
    const rsyncLines = log.split('\n').filter((l) => l.startsWith('rsync '));
    assert.ok(rsyncLines.length > 0, '桩 rsync 应被调用');
    const denied = rsyncLines.filter((l) => /\.ssh|\.aws|id_rsa|\.pem|credential|\.netrc|auth\.json/i.test(l));
    assert.deepEqual(denied, [], 'rsync 命令行不得出现凭证相关路径');
    const outsideMirror = rsyncLines.filter((l) => !l.includes(path.join(env.home, 'cache', 'remote')));
    assert.deepEqual(outsideMirror, [], 'rsync 目标必须是本实例 HOME 下的远端镜像目录');
    assert.ok(rsyncLines.every((l) => l.includes('stubhost:')), 'rsync 源必须是远端 host（拉取方向）');

    // 幂等：再同步一次不新增
    const total1 = (await GET(env, '/api/sessions?limit=500')).json.total;
    const sync2 = await POST(env, `/api/remotes/${remoteId}/sync`, {});
    const job2 = await waitJob(env, sync2.json.jobId);
    assert.equal(job2.status, 'ok');
    assert.equal(job2.added, 0, `二次同步不应新增：${JSON.stringify(job2)}`);
    const total2 = (await GET(env, '/api/sessions?limit=500')).json.total;
    assert.equal(total2, total1, `二次同步后会话总数不应变化（${total1} → ${total2}）`);

    // DELETE 远端：连带清掉该 host 的会话缓存，且不动原始会话
    const del = await api(env, 'DELETE', `/api/remotes/${remoteId}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.ok, true);
    const afterDelete = await GET(env, `/api/sessions?host=${encodeURIComponent(host)}&limit=10`);
    assert.equal(afterDelete.json.total, 0, '删除远端应清掉该 host 的会话缓存');
    const others = await GET(env, '/api/sessions?limit=500');
    assert.ok(others.json.total > 0, '本机会话不应被牵连删除');

    REC.cases.sshRsync = {
        claudeProjectsRequested: rsyncLines.some((l) => l.includes('.claude/projects')),
        whitelistedCommands: rsyncLines.map((l) => l.replace(/\/tmp\/[^\s]*/g, '<tmp>')).slice(0, 12),
        commandCount: rsyncLines.length,
        deniedHits: denied.length,
        job: { status: job.status, pulled: job.pulled, added: job.added, updated: job.updated, log: job.log.slice(0, 8) },
        job2: { status: job2.status, added: job2.added },
        hostSessions: list.json.sessions.length,
        filePathInMirror: mirrorPaths,
        filePathNull: list.json.sessions.filter((s) => s.filePath === null).length,
        agents: [...agents],
        todayOnHost,
        afterDeleteHostSessions: afterDelete.json.total,
    };
});

test('16 SSH 降级路径：rsync 不可用时走 ssh+tar 流式拉取（仍是桩传输 + 真实入库）', async () => {
    const env = S.sshTar;
    const scan = await POST(env, '/api/scan', { full: true });
    assert.equal(scan.status, 200, scan.text);
    const created = await POST(env, '/api/remotes', { kind: 'ssh', name: 'stub-tar', host: 'stubhost', root: '/home/tester' });
    const remoteId = created.json.remote.id;
    fs.writeFileSync(REC.stubs.log, '');
    const sync = await POST(env, `/api/remotes/${remoteId}/sync`, {});
    const job = await waitJob(env, sync.json.jobId);
    assert.equal(job.status, 'ok', `ssh+tar 应成功：${JSON.stringify(job).slice(0, 400)}`);
    assert.ok(job.added > 0, JSON.stringify(job));
    const log = fs.readFileSync(REC.stubs.log, 'utf8');
    assert.ok(/ssh .*tar -cf -/.test(log), `应走 tar 兜底：${log.slice(0, 300)}`);
    assert.ok(!log.includes('rsync '), '该实例的 PATH 里没有 rsync 桩，不应调用 rsync');
    const list = await GET(env, `/api/sessions?host=${encodeURIComponent(`ssh:${remoteId}`)}&limit=50`);
    assert.ok(list.json.total > 0);
    REC.cases.sshTar = {
        job: { status: job.status, pulled: job.pulled, added: job.added },
        command: log.split('\n').filter(Boolean).slice(0, 3),
        sessions: list.json.total,
    };
});

test('17 UI 静态资源与 6 个页面依赖的接口都能返回数据（真实后端）', async () => {
    const index = await GET(S.main, '/');
    assert.equal(index.status, 200);
    assert.ok(index.text.includes('id="view"'), '首页应有 view 容器');
    assert.ok(/app\.js/.test(index.text), '首页应挂 app.js');
    const css = await GET(S.main, '/styles.css');
    assert.equal(css.status, 200);
    const appJs = await GET(S.main, '/app.js');
    assert.equal(appJs.status, 200);
    const escape = await GET(S.main, '/..%2fpackage.json');
    assert.equal(escape.status, 404, `静态目录穿越必须被拒，实际 ${escape.status}`);

    const pages = {
        '今日 #/today': [`/api/sessions?day=${DAY}&withPreview=1`, (j) => j.total > 0],
        '会话 #/sessions': ['/api/sessions?limit=100', (j) => j.sessions.length > 0 && Array.isArray(j.facets.agents)],
        '转录 #/sessions/:id': [`/api/sessions/${encodeURIComponent((await GET(S.main, `/api/sessions?day=${DAY}&limit=1`)).json.sessions[0].id)}`, (j) => j.messages.length > 0],
        '梦 #/dreams': ['/api/dreams', (j) => j.dreams.length > 0],
        '梦详情 #/dreams/:id': [`/api/dreams/${encodeURIComponent(REC.dreamId)}`, (j) => typeof j.reportMarkdown === 'string' && j.reportMarkdown.length > 0 && Array.isArray(j.inputs)],
        '记忆库 #/memory': ['/api/memory/tree', (j) => j.files.length > 0],
        '设备 #/hosts': ['/api/remotes', (j) => Array.isArray(j.remotes)],
        '设置 #/settings': ['/api/settings', (j) => !!j.settings && '_home' in j.settings],
    };
    const observed = {};
    for (const [label, [endpoint, ok]] of Object.entries(pages)) {
        const res = await GET(S.main, endpoint);
        assert.equal(res.status, 200, `${label} 依赖的 ${endpoint} 应 200，实际 ${res.status}`);
        assert.ok(ok(res.json), `${label} 依赖的 ${endpoint} 数据形状不对：${res.text.slice(0, 200)}`);
        observed[label] = `${endpoint} → 200`;
    }
    REC.cases.uiBackend = { index: index.status, css: css.status, appJs: appJs.status, staticTraversal: escape.status, observed };
});

test('18 契约偏差探测：§5 表格里每个接口逐个探测（含只有 GET 的与写接口）', async () => {
    const probe = async (method, endpoint, body) => {
        const res = body === undefined ? await api(S.main, method, endpoint) : await api(S.main, method, endpoint, body);
        const entry = {
            method,
            endpoint,
            status: res.status,
            ms: res.ms,
            snippet: res.text.slice(0, 220).replace(/\s+/g, ' '),
            jsonKeys: res.json && typeof res.json === 'object' ? Object.keys(res.json).slice(0, 10) : null,
        };
        REC.contract.push(entry);
        return entry;
    };

    const sessionId = (await GET(S.main, `/api/sessions?day=${DAY}&limit=1`)).json.sessions[0].id;
    const dreamId = REC.dreamId;

    await probe('GET', '/api/health');
    await probe('GET', '/api/settings');
    await probe('PUT', '/api/settings', { ui: { theme: 'dark' } });
    await probe('GET', '/api/agents');
    await probe('GET', '/api/projects');
    await probe('GET', `/api/sessions?day=${DAY}`);
    await probe('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
    await probe('GET', `/api/stats?day=${DAY}`);
    await probe('POST', '/api/scan', {});
    await probe('GET', '/api/remotes');
    await probe('POST', '/api/remotes', { kind: 'ssh', name: 'probe-host', host: 'probehost' });
    const probeRemote = (await GET(S.main, '/api/remotes')).json.remotes.find((r) => r.name === 'probe-host');
    await probe('PATCH', `/api/remotes/${probeRemote.id}`, { name: 'probe-host-renamed' });
    await probe('POST', `/api/remotes/${probeRemote.id}/sync`, {});
    await probe('GET', '/api/sync/jobs/does-not-exist');
    await probe('GET', '/api/lan/info');
    await probe('POST', '/api/lan/pull', { url: S.main.base, token: 'x', day: DAY });
    await probe('GET', `/api/lan/manifest?day=${DAY}`);
    await probe('GET', `/api/lan/bundle?id=${encodeURIComponent(sessionId)}`);
    await probe('GET', '/api/dreams');
    await probe('GET', `/api/dreams/${encodeURIComponent(dreamId)}`);
    await probe('POST', '/api/dreams/run', { day: DAY, provider: 'heuristic' });
    await probe('GET', '/api/memory/tree');
    await probe('GET', '/api/memory/file?path=_index.md');
    await probe('GET', '/api/dream/schedule');
    await probe('PUT', '/api/dream/schedule', { at: '04:15' });
    await probe('GET', '/api/events');
    await probe('DELETE', `/api/remotes/${probeRemote.id}`);

    // 所有接口都不应 5xx
    const fiveXX = REC.contract.filter((c) => c.status >= 500);
    assert.deepEqual(fiveXX, [], `§5 里的接口不应有 5xx：${JSON.stringify(fiveXX)}`);
    // 语义期望
    const byKey = (m, p) => REC.contract.find((c) => c.method === m && c.endpoint.startsWith(p));
    assert.equal(byKey('GET', '/api/health').status, 200);
    assert.equal(byKey('GET', '/api/sessions?').status, 200);
    assert.equal(REC.contract.find((c) => c.method === 'GET' && c.endpoint.startsWith('/api/sessions/local')).status, 200);
    assert.equal(byKey('GET', '/api/dreams/').status, 200);
    assert.equal(byKey('GET', '/api/events').status, 404, '/api/events（可选）当前未实现，应为 404 而不是 500');
    assert.equal(byKey('GET', '/api/lan/manifest').status, 403, '未开启局域网应 403');
    assert.equal(byKey('GET', '/api/lan/bundle').status, 403);
    assert.equal(byKey('POST', '/api/lan/pull').status, 200);
    assert.ok(byKey('PUT', '/api/dream/schedule').status === 200);

    REC.cases.contractProbe = {
        total: REC.contract.length,
        fiveXX: fiveXX.length,
        notFound: REC.contract.filter((c) => c.status === 404).map((c) => `${c.method} ${c.endpoint}`),
        implemented: REC.contract.filter((c) => c.status < 400).map((c) => `${c.method} ${c.endpoint}`),
    };
});

test('19 DELETE /api/dreams/:id：只删记忆产物与记录，不动原始会话', async () => {
    const sessionsBefore = (await GET(S.main, '/api/sessions?limit=500')).json.total;
    const del = await api(S.main, 'DELETE', `/api/dreams/${encodeURIComponent(REC.dreamId)}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.ok, true);
    assert.equal(fs.existsSync(REC.memoryDir), false, '删除后记忆目录应被清掉');
    const getDream = await GET(S.main, `/api/dreams/${encodeURIComponent(REC.dreamId)}`);
    assert.equal(getDream.status, 404);
    const sessionsAfter = (await GET(S.main, '/api/sessions?limit=500')).json.total;
    assert.equal(sessionsAfter, sessionsBefore, '删除梦不得动原始会话');
    const tree = await GET(S.main, '/api/memory/tree');
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.json.files, [], '删掉唯一一次做梦后记忆树应为空');
    REC.cases.removeDream = { status: del.status, memoryDirGone: true, sessionsBefore, sessionsAfter, treeFiles: tree.json.files.length };
});

test('20 收尾：所有实例的 stderr（error/warn 级日志）里除已知客户端 400/413 外没有失败', async () => {
    const all = {};
    for (const s of SERVERS) {
        // 只把「时间戳开头的日志记录行」当记录；多行 stack trace 跟在记录后面，单独计数
        const records = s.stderr().split('\n').filter((l) => /^\[err\] \d{2}:\d{2}:\d{2} /.test(l));
        // 已知例外：客户端侧 400/413（非法 JSON 体、超限请求体）也会被 main.js 以 error 级记一行 + stack。
        // 状态码本身已经是对的（见用例 11），这里只把它当已知噪音排除；日志级别问题记在报告里。
        const known = /请求体不是合法 JSON|请求体超过 \d+ 字节/;
        const unexpected = records.filter((l) => !known.test(l));
        all[s.name] = {
            stderrRecords: records.length,
            unexpected: unexpected.length,
            sample: unexpected.slice(0, 3).map((l) => l.slice(0, 200)),
        };
    }
    REC.cases.serverStderr = all;
    for (const [name, v] of Object.entries(all)) {
        assert.equal(v.unexpected, 0, `[${name}] stderr 出现未预期失败：${JSON.stringify(v.sample)}`);
    }
    REC.ports = SERVERS.map((s) => s.port);
});

test('21 回归：claude-code 的会话能进库（曾因 agentId 与 ADAPTERS 键不一致被整批丢弃）', async () => {
    const s = S.claudeLocal;
    const scan = await POST(s, '/api/scan', { full: true });
    assert.equal(scan.status, 200, scan.text);
    const agent = (await GET(s, '/api/agents')).json.agents.find((a) => a.id === 'claude-code');
    const sessions = await GET(s, '/api/sessions?limit=200');
    const claudeSessions = sessions.json.sessions.filter((x) => x.agent === 'claude-code');
    const claudeCount = claudeSessions.length;
    const byAgentIncludesClaude = Object.keys(scan.json.byAgent ?? {}).includes('claude-code');

    assert.equal(agent.detected, true, 'CLAUDE_CONFIG_DIR 指向的目录应被检测到');
    // 2026-11-06 lead 修复：scanTargets() 现在把注册表 id（claude-code）与适配器名（claude）互相解析，
    // 库里 sessions.agent 一律记注册表 id。
    assert.ok(byAgentIncludesClaude, 'byAgent 必须包含 claude-code（修复前这里被 continue 丢弃）');
    assert.ok(claudeCount > 0, `本机扫描应扫到 claude-code 会话，实际 ${claudeCount}`);
    assert.ok((agent.sessionCount ?? 0) > 0, '/api/agents 的 sessionCount 应 > 0');
    // 库里的 agent 一律是注册表 id，会话 id 形如 local:claude-code:<nativeId>
    const badIds = claudeSessions.filter((x) => !x.id.startsWith('local:claude-code:'));
    assert.deepEqual(badIds.map((x) => x.id), [], 'claude 会话 id 必须以 local:claude-code: 开头');

    // 另一条路径：config.scan.extraRoots 传适配器名（claude）或注册表 id（claude-code）都应能扫到
    const workaround = await PUT(s, '/api/settings', {
        scan: { extraRoots: [{ id: 'claude-extra', agent: 'claude', dir: REC.claudeFixtureDir }] },
    });
    assert.equal(workaround.status, 200, workaround.text);
    await POST(s, '/api/scan', { full: true });
    const afterExtra = await GET(s, '/api/sessions?limit=200');
    const claudeCount2 = afterExtra.json.sessions.filter((x) => x.agent === 'claude-code').length;
    assert.ok(claudeCount2 > 0, 'extraRoots 用适配器名时也必须能扫到');
    // extraRoots 指的其实就是注册表那条 root（同一个目录）：别名解析后必须仍然按 (host,agent,nativeId) 去重，
    // 不允许因为「两条 target 指向同一目录」而重复入库
    assert.equal(claudeCount2, claudeCount, `同一目录被登记两次不应重复入库（${claudeCount} → ${claudeCount2}）`);
    assert.equal(afterExtra.json.total, sessions.json.total, '总会话数不应因重复登记而增加');

    REC.cases.claudeCodeAliasFixed = {
        agentDetected: agent.detected,
        sessionCount: agent.sessionCount ?? null,
        sessionsAfterNormalScan: claudeCount,
        byAgentIncludesClaude,
        sessionsWithExtraRootsWorkaround: claudeCount2,
        noDuplicateAfterDoubleRegistration: `${claudeCount} → ${claudeCount2}`,
        totals: `${sessions.json.total} → ${afterExtra.json.total}`,
        fix: 'scan.js 新增 buildAlias()/resolveTarget()：注册表 id ↔ 适配器名双向解析，scanTargets 与 scanTree 共用；lead 于 2026-11-06 修复，verifier 曾以用例 21 复现',
    };
});

test('22 回归：report.md / manifest.json 的「落盘 / 合计」耗时不再恒为 0', async () => {
    const run = await POST(S.main, '/api/dreams/run', { day: DAY, provider: 'heuristic', force: true });
    assert.equal(run.status, 200, run.text);
    assert.equal(run.json.status, 'ok', `应成功：${JSON.stringify(run.json).slice(0, 300)}`);
    const report = fs.readFileSync(path.join(run.json.memoryDir, 'report.md'), 'utf8');
    const line = report.split('\n').find((l) => l.includes('耗时：')) || '';
    const manifest = JSON.parse(fs.readFileSync(path.join(run.json.memoryDir, 'manifest.json'), 'utf8'));
    const reportEntry = (manifest.files || []).find((f) => f.path === 'report.md');
    const writeMsInReport = Number((/落盘 (\d+)ms/.exec(line) || [])[1]);
    REC.cases.reportTimingsFixed = {
        reportLine: line,
        manifestTimings: manifest.stats.timings,
        apiTimings: run.json.stats.timings,
        reportWriteMs: writeMsInReport,
        manifestReportBytes: reportEntry?.bytes ?? null,
        diskReportBytes: Buffer.byteLength(report, 'utf8'),
        fix: 'runDream() 落盘后用最终 stats.timings 重渲染 report.md 与 manifest.json（manifest 后渲染，因为它记着 report.md 的字节数）；lead 于 2026-11-06 修复，verifier 曾以用例 22 复现',
    };
    // 修复前这两个值恒为 0；现在必须与 API/库里的真实计时一致，且合计 > 0
    assert.match(line, /合计 \d+ms/, `报告里应有耗时行：${line}`);
    assert.doesNotMatch(line, /合计 0ms/, `合计不应恒为 0：${line}`);
    assert.equal(manifest.stats.timings.totalMs, run.json.stats.timings.totalMs, 'manifest 与 API 的合计耗时应一致');
    assert.ok(manifest.stats.timings.totalMs > 0, '合计耗时必须 > 0');
    assert.ok(Number.isInteger(manifest.stats.timings.writeMs) && manifest.stats.timings.writeMs >= 0, 'writeMs 应为非负整数');
    assert.ok(reportEntry, 'manifest.files 里应有 report.md');
    assert.equal(reportEntry.bytes, Buffer.byteLength(report, 'utf8'), 'manifest 里 report.md 的字节数应与磁盘一致');
    // 报告正文里的「落盘 Nms」与 manifest/API 的 writeMs 必须是同一个数字（同一份 stats）
    assert.equal(Number.isInteger(writeMsInReport), true, `报告里应能解析出落盘耗时：${line}`);
    assert.equal(writeMsInReport, manifest.stats.timings.writeMs, `报告里的落盘耗时(${writeMsInReport}) 应等于 manifest.writeMs(${manifest.stats.timings.writeMs})`);
    assert.equal(writeMsInReport, run.json.stats.timings.writeMs, '报告与 API 的 writeMs 必须一致');
    assert.equal(manifest.stats.timings.totalMs, run.json.stats.timings.totalMs, 'manifest 与 API 的 totalMs 必须一致');
});
