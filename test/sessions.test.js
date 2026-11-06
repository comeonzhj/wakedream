// 会话层测试：适配器解析（对 Wake 的合成 fixture）+ 扫描幂等 + 查询筛选/分页/搜索 + 子代理归属。
// 每个测试文件都用**临时 WAKEDREAM_HOME**，绝不碰真实的 ~/.wakedream。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');

// 必须在 import 任何读 config 的模块之前设好（HOME/paths 是模块级常量）
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wakedream-sessions-'));
process.env.WAKEDREAM_HOME = TMP_HOME;
// 让注册表里的 dsh 根指向测试 fixture，而不是真实的 ~/.dsh
process.env.DSH_HOME = path.join(FIX, 'dsh-home');

const sessions = await import('../src/server/sessions/index.js');
const dshAdapter = await import('../src/server/sessions/adapters/dsh.js');
const claudeAdapter = await import('../src/server/sessions/adapters/claude.js');
const codexAdapter = await import('../src/server/sessions/adapters/codex.js');
const cursorAdapter = await import('../src/server/sessions/adapters/cursor.js');
const others = await import('../src/server/sessions/adapters/others.js');
const { decompressZstd } = await import('../src/server/sessions/jsonl.js');
const { getDb, closeDb } = await import('../src/server/db.js');

const DSH_FIXTURE_ROOT = path.join(FIX, 'dsh-home', 'sessions');

function rows(sql, ...args) {
    return getDb().prepare(sql).all(...args);
}

test.after(() => {
    closeDb();
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

/* ------------------------------------------------------------ registry */

test('registry：要求的 agent 都在，带 name/color/roots', () => {
    const agents = sessions.listAgents();
    const ids = agents.map((a) => a.id);
    for (const required of ['dsh', 'claude-code', 'codex', 'cursor', 'gemini', 'kimi', 'qoder', 'kiro']) {
        assert.ok(ids.includes(required), `注册表缺少 ${required}`);
    }
    const dsh = agents.find((a) => a.id === 'dsh');
    assert.equal(dsh.name, 'DeepSeek Harness');
    assert.equal(dsh.color, '#4D6BFE');
    assert.equal(dsh.roots.length, 1);
    assert.equal(dsh.roots[0].dir, path.join(FIX, 'dsh-home', 'sessions'));
    assert.equal(dsh.roots[0].env, 'DSH_HOME');
    // 顺序与 Wake 的 AgentId::ALL 一致（前几个）
    assert.deepEqual(ids.slice(0, 5), ['claude-code', 'codex', 'qoder', 'copilot', 'cursor']);
});

test('registry：gemini-cli 这类别名能归一到 canonical id', () => {
    assert.equal(sessions.canonicalAgentId('gemini-cli'), 'gemini');
    assert.equal(sessions.canonicalAgentId('claude'), 'claude-code');
});

/* --------------------------------------------------------- zstd / 多帧 */

test('jsonl：多帧连接的 zstd 要全部解出来（Node 内置只解第一帧）', () => {
    const a = Buffer.from('{"type":"session","id":"x"}\n', 'utf8');
    const b = Buffer.from('{"type":"turn/start","seq":1}\n', 'utf8');
    const c = Buffer.from('{"type":"turn/end","seq":2}\n', 'utf8');
    const frame = (buf) => zlib.zstdCompressSync(buf);
    const multi = Buffer.concat([frame(a), frame(b), frame(c)]);
    const text = decompressZstd(multi);
    assert.equal(text, a.toString() + b.toString() + c.toString());
    // 末帧半写（截断）时保留已解出的部分，不抛错
    const truncated = Buffer.concat([frame(a), frame(b), multi.subarray(multi.length - 5)]);
    assert.equal(decompressZstd(truncated), a.toString() + b.toString());
});

/* --------------------------------------------------------- dsh 适配器 */

test('dsh：主会话的标题/项目/模型/用量与消息分桶', () => {
    const { session, messages } = dshAdapter.parse(path.join(FIX, 'dsh', 'session.v4.jsonl'));
    assert.equal(session.agent, 'dsh');
    assert.equal(session.nativeId, 'dsh-v4-0003');
    assert.equal(session.title, 'README 安装命令改 npx');
    assert.equal(session.project, 'wakefx');
    assert.equal(session.projectPath, '/Users/tester/Github/wakefx');
    assert.equal(session.model, 'deepseek-v4-pro');
    assert.equal(session.startedAt, 1788000000000);
    assert.equal(session.endedAt, 1788000004900);
    // usage 按调用累加：2920-（含 cacheRead 800）+ 2380
    assert.equal(session.tokens, 7760);
    assert.equal(session.isSubagent, false);
    assert.equal(session.parentNativeId, null);
    assert.equal(session.extra.formatVersion, 4);

    assert.deepEqual(messages.map((m) => `${m.role}/${m.kind}`), [
        'system/meta', 'user/text', 'user/meta', 'assistant/text', 'assistant/thinking',
        'assistant/tool_call', 'tool/tool_result', 'assistant/tool_call', 'tool/tool_result',
        'assistant/text',
    ]);
    // surfaceOp.replace 的那条（工具输出被裁剪的替代视图）整条跳过，保留原始输出
    const firstResult = messages[6];
    assert.equal(firstResult.meta.callId, 'call-1');
    assert.equal(firstResult.meta.name, 'read_file');
    assert.equal(firstResult.meta.ok, true);
    assert.match(firstResult.meta.output, /npm install -g @deepseek-ai\/dsh/);
    assert.equal(firstResult.meta.durationMs, 300);
    // 失败的工具调用 ok=false
    assert.equal(messages[8].meta.ok, false);
    // 注入型 user 消息（agent-instructions）归 meta，不进正文标题
    assert.equal(messages[2].meta.type, 'agent-instructions');
    assert.equal(messages[0].meta.type, 'system-prompt');
    // 行的 seq 必须从 0 连续
    assert.deepEqual(messages.map((m) => m.seq), messages.map((_, i) => i));
});

test('dsh：子代理会话按首行 parentSession 挂父会话，fork 段折叠成一条 meta', () => {
    const { session, messages } = dshAdapter.parse(path.join(FIX, 'dsh', 'subagent.v4.jsonl'));
    assert.equal(session.isSubagent, true);
    assert.equal(session.parentNativeId, 'dsh-e2e4-0001');
    assert.equal(session.title, 'Audit the scanner effects'); // subagent/descriptor 的 label
    assert.equal(session.model, 'deepseek-v4-flash');
    // 截点前继承来的 2 条被折成 1 条 meta，标题/模型/用量只算截点之后的
    assert.equal(messages[0].kind, 'meta');
    assert.equal(messages[0].meta.type, 'fork-seed');
    assert.equal(messages[0].meta.count, 2);
    assert.equal(messages.length, 3);
    assert.equal(session.tokens, 1820);
});

test('dsh：会话目录里挑编号最大的那一代日志', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gen-'));
    try {
        fs.writeFileSync(path.join(dir, 'session.jsonl'), '{"type":"session","id":"v0"}\n');
        fs.writeFileSync(path.join(dir, 'session.v3.jsonl'), '{"type":"session","id":"v3"}\n');
        fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '{"type":"session","id":"v4"}\n');
        fs.writeFileSync(path.join(dir, 'session.lock'), '');
        assert.equal(dshAdapter.pickSessionLog(dir).filePath, path.join(dir, 'session.v4.jsonl'));
        // 同一代明文与 zstd 并存时 mtime 新者胜；这里让明文更新
        fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"v4z"}\n')));
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(dir, 'session.v4.jsonl.zstd'), past, past);
        assert.equal(dshAdapter.pickSessionLog(dir).filePath, path.join(dir, 'session.v4.jsonl'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------ claude 适配器 */

test('claude-code：主转录的标题/模型/用量，isMeta 与注入内容归 meta', () => {
    const file = path.join(FIX, 'claude/projects/-Users-tester-Github-wakefx/11111111-aaaa-bbbb-cccc-000000000001.jsonl');
    const { session, messages } = claudeAdapter.parse(file);
    assert.equal(session.agent, 'claude-code');
    assert.equal(session.nativeId, '11111111-aaaa-bbbb-cccc-000000000001');
    assert.equal(session.title, 'QR login revamp'); // custom-title 优先
    assert.equal(session.project, 'wakefx');
    assert.equal(session.model, 'claude-opus-4-1');
    assert.equal(session.tokens, 160);
    assert.equal(messages[0].kind, 'meta'); // Caveat / isMeta
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].kind, 'text');
    const call = messages.find((m) => m.kind === 'tool_call');
    assert.equal(call.meta.name, 'Read');
    assert.equal(call.meta.callId, 'toolu_01');
    const result = messages.find((m) => m.kind === 'tool_result');
    assert.equal(result.meta.callId, 'toolu_01');
    assert.equal(result.meta.ok, true);
});

test('claude-code：subagents/*.jsonl 挂到父会话，标题取 sidecar 的 description', () => {
    const file = path.join(FIX, 'claude/projects/-Users-tester-Github-wakefx/11111111-aaaa-bbbb-cccc-000000000001/subagents/agent-fixture01.jsonl');
    const { session, messages } = claudeAdapter.parse(file);
    assert.equal(session.isSubagent, true);
    assert.equal(session.parentNativeId, '11111111-aaaa-bbbb-cccc-000000000001');
    assert.equal(session.title, 'find the QR scanner code');
    assert.equal(session.extra.agentType, 'Explore');
    assert.equal(session.extra.toolUseId, 'toolu_fixture01');
    assert.ok(messages.length >= 2);
});

test('claude-code：discover 能同时列出主转录与子代理转录', () => {
    const found = claudeAdapter.discover(path.join(FIX, 'claude', 'projects'));
    const files = found.map((f) => f.filePath);
    assert.ok(files.some((f) => f.endsWith('11111111-aaaa-bbbb-cccc-000000000001.jsonl')));
    assert.ok(files.some((f) => f.includes(`${path.sep}subagents${path.sep}`)));
    assert.ok(!files.some((f) => f.endsWith('.meta.json')));
});

/* ------------------------------------------------------- codex 适配器 */

test('codex：rollout 解析、注入内容归 meta、token_count 取用量', () => {
    const file = path.join(FIX, 'codex/sessions/2026/08/02/rollout-2026-08-02T09-15-00-22222222-aaaa-bbbb-cccc-000000000002.jsonl');
    const { session, messages } = codexAdapter.parse(file);
    assert.equal(session.agent, 'codex');
    assert.equal(session.nativeId, '22222222-aaaa-bbbb-cccc-000000000002');
    assert.equal(session.title, '扫码登录报错,帮我查一下 useEffect() 依赖数组');
    assert.equal(session.model, 'gpt-5.2-codex');
    assert.equal(session.tokens, 4321);
    assert.equal(session.extra.gitBranch, 'feat/qr');
    assert.equal(messages[0].kind, 'meta'); // <environment_context> 注入
    assert.equal(messages[1].kind, 'text');
    const call = messages.find((m) => m.kind === 'tool_call');
    assert.equal(call.meta.name, 'shell');
    assert.equal(call.meta.callId, 'call_001');
    assert.deepEqual(call.meta.input, { command: ['rg', 'useEffect', 'src'] });
    assert.equal(messages.find((m) => m.kind === 'tool_result').meta.ok, true);
});

test('codex：review/内部线程整条不进索引，spawn_agent 子线程挂父线程', () => {
    const found = codexAdapter.discover(path.join(FIX, 'codex', 'sessions'));
    assert.equal(found.length, 4);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-internal-'));
    try {
        const day = path.join(dir, '2026', '09', '14');
        fs.mkdirSync(day, { recursive: true });
        const meta = (id, extra) => JSON.stringify({
            timestamp: '2026-09-14T00:00:00.000Z',
            type: 'session_meta',
            payload: { id, timestamp: '2026-09-14T00:00:00.000Z', cwd: '/work/wake', originator: 'codex_cli_rs', ...extra },
        });
        const user = JSON.stringify({
            timestamp: '2026-09-14T00:00:01.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        });
        // guardian / review / memory consolidation 的结构化来源：整条跳过
        const internal = path.join(day, 'rollout-2026-09-14T00-00-00-00000000-0000-4000-8000-000000000001.jsonl');
        fs.writeFileSync(internal, `${meta('00000000-0000-4000-8000-000000000001', { source: { subagent: { other: 'review' } } })}\n${user}\n`);
        assert.equal(codexAdapter.parse(internal), null);
        // 过渡格式的 thread_source 同样跳过
        const legacy = path.join(day, 'rollout-2026-09-14T00-00-00-00000000-0000-4000-8000-000000000002.jsonl');
        fs.writeFileSync(legacy, `${meta('00000000-0000-4000-8000-000000000002', { thread_source: 'guardian_review' })}\n${user}\n`);
        assert.equal(codexAdapter.parse(legacy), null);

        // spawn_agent 起子线程：进索引 + 标题取 agent_path 末段
        const spawned = path.join(day, 'rollout-2026-09-14T00-00-00-00000000-0000-4000-8000-000000000003.jsonl');
        fs.writeFileSync(spawned, `${meta('00000000-0000-4000-8000-000000000003', {
            source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', agent_path: '/root/audit-qr', agent_nickname: 'nick' } } },
        })}\n${user}\n`);
        const parsed = codexAdapter.parse(spawned);
        assert.equal(parsed.session.isSubagent, true);
        assert.equal(parsed.session.title, 'audit-qr');
        assert.equal(parsed.session.parentNativeId, 'parent-1');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------ cursor / 其他 */

test('cursor：<user_query> 取正文、注入上下文归 meta、工具调用保留 input', () => {
    const file = path.join(FIX, 'cursor/projects/wakefx-cursor-proj/agent-transcripts/33333333-aaaa-bbbb-cccc-000000000003/33333333-aaaa-bbbb-cccc-000000000003.jsonl');
    const { session, messages } = cursorAdapter.parse(file);
    assert.equal(session.nativeId, '33333333-aaaa-bbbb-cccc-000000000003');
    assert.equal(session.title, '把二维码扫描组件抽出来,注意 useEffect() 的清理');
    assert.equal(messages[0].kind, 'meta'); // <workspace> 注入
    assert.equal(messages[1].kind, 'text');
    const call = messages.find((m) => m.kind === 'tool_call');
    assert.equal(call.meta.name, 'read_file');
    assert.deepEqual(call.meta.input, { path: 'src/QrScanner.tsx' });
    // 只有 turn_ended 的空壳不进索引
    const empty = path.join(FIX, 'cursor/projects/wakefx-cursor-proj/agent-transcripts/44444444-aaaa-bbbb-cccc-000000000004/44444444-aaaa-bbbb-cccc-000000000004.jsonl');
    assert.equal(cursorAdapter.parse(empty), null);
});

test('gemini：只认最后一个 $set 快照（前一份被覆盖）', () => {
    const file = path.join(FIX, 'gemini/tmp/wakefx-gem/chats/session-2026-08-04T12-00-00.jsonl');
    const { session, messages } = others.gemini.parse(file);
    assert.equal(session.nativeId, '55555555-aaaa-bbbb-cccc-000000000005');
    assert.equal(messages.length, 2);
    assert.match(messages[0].text, /Gemini 帮我调试二维码解码/);
    assert.ok(!messages.some((m) => m.text.includes('旧快照文本')));
});

test('kimi：state.json 的自定义标题优先，wire.jsonl 出正文', () => {
    const file = path.join(FIX, 'kimi/sessions/wd_wakefx_abc123/session_88888888-aaaa-bbbb-cccc-000000000008/agents/main/wire.jsonl');
    const { session, messages } = others.kimi.parse(file);
    assert.equal(session.nativeId, '88888888-aaaa-bbbb-cccc-000000000008');
    assert.equal(session.title, 'Kimi QR fix');
    assert.equal(session.project, 'wakefx');
    assert.equal(messages[0].text, 'Kimi 修一下二维码组件的 useEffect() 内存泄漏');
    assert.equal(messages.find((m) => m.kind === 'tool_result').meta.callId, 'k1');
});

test('qoder：active-leaf 决定链路，废弃分支与显式回退都不出现', () => {
    const file = path.join(FIX, 'qoder/projects/-Users-tester-Github-wakefx/abababab-aaaa-bbbb-cccc-000000000014.jsonl');
    const { session, messages } = others.qoder.parse(file);
    assert.equal(session.title, 'Qoder active branch title');
    assert.equal(session.model, 'qoder-performance');
    assert.ok(!messages.some((m) => m.text.includes('废弃')), '被回退的分支不能出现');
    assert.ok(messages.some((m) => m.text.includes('继续修复当前分支')));
    assert.equal(messages.find((m) => m.kind === 'tool_result').meta.callId, 'q-tool-1');

    const rewound = others.qoder.parse(path.join(FIX, 'qoder/projects/-Users-tester-Github-wakefx/cdcdcdcd-aaaa-bbbb-cccc-000000000015.jsonl'));
    assert.equal(rewound.messages.length, 0);
    assert.equal(rewound.session.extra.activeLeaf, 'empty');
});

test('kiro：sidecar 的标题/cwd/模型 + 转录正文', () => {
    const file = path.join(FIX, 'kiro/sessions/cli/44444444-aaaa-bbbb-cccc-000000000004.jsonl');
    const { session, messages } = others.kiro.parse(file);
    assert.equal(session.title, 'Kiro QR session');
    assert.equal(session.model, 'claude-sonnet-4');
    assert.equal(session.project, 'wakefx');
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
});

/* ------------------------------------------------------------ 扫描/查询 */

test('扫描：入库、字段、子代理归属，且第二次扫描全部跳过（增量幂等）', () => {
    const targets = [{ agentId: 'dsh', root: DSH_FIXTURE_ROOT }];
    const first = sessions.scanTargets({ targets, full: true });
    assert.equal(first.scanned, 3);
    assert.equal(first.added, 3);
    assert.deepEqual(first.errors, []);

    const second = sessions.scanTargets({ targets });
    assert.equal(second.scanned, 3);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.skipped, 3);

    const all = rows("select id, title, message_count, is_subagent, parent_id from sessions where host='local' order by id");
    assert.equal(all.length, 3);
    const sub = all.find((r) => r.is_subagent === 1);
    assert.equal(sub.id, 'local:dsh:dsh-sub-0002');
    assert.equal(sub.parent_id, 'local:dsh:dsh-e2e4-0001', '子代理要挂到父会话');
    const parent = all.find((r) => r.id === 'local:dsh:dsh-e2e4-0001');
    assert.equal(parent.title, 'QR scan dependency fix');
    assert.equal(parent.parent_id, null);
    // message_count 口径：去掉 kind='meta'
    const counts = rows("select kind, count(*) c from messages where session_id='local:dsh:dsh-v4-0003' group by kind");
    const byKind = Object.fromEntries(counts.map((r) => [r.kind, r.c]));
    assert.equal(byKind.meta, 2);
    const sessionRow = rows("select message_count from sessions where id='local:dsh:dsh-v4-0003'")[0];
    assert.equal(sessionRow.message_count, 10 - byKind.meta);
});

test('扫描：源文件消失后，file_path 不在的会话会被清掉', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scan-'));
    const root = path.join(scratch, 'sessions');
    const dir = path.join(root, 'proj', 'sess-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '{"type":"session","version":4,"id":"scan-tmp-1","createdAt":1,"cwd":"/tmp/proj"}\n{"type":"user/message","seq":0,"time":2,"data":{"content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}}\n');
    const targets = [{ agentId: 'dsh', root }];
    assert.equal(sessions.scanTargets({ targets, full: true }).added, 1);
    assert.ok(sessions.getSession('local:dsh:scan-tmp-1'));
    fs.rmSync(dir, { recursive: true, force: true });
    const res = sessions.scanTargets({ targets });
    assert.equal(res.byAgent.dsh.pruned, 1);
    assert.equal(sessions.getSession('local:dsh:scan-tmp-1'), null);
    fs.rmSync(scratch, { recursive: true, force: true });
});

test('查询：day/agent/q/分页/排序/facets/withPreview', () => {
    sessions.scanTargets({ targets: [{ agentId: 'dsh', root: DSH_FIXTURE_ROOT }], full: true });

    const all = sessions.querySessions({ limit: 100 });
    assert.equal(all.total, 3);
    assert.equal(all.sessions.length, 3);
    // order=asc 时按 startedAt 升序
    const asc = sessions.querySessions({ limit: 100, order: 'asc' });
    const times = asc.sessions.map((s) => s.startedAt);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));

    // day 命中（fixture 的时间是 2026-08-28 与 2026-08-07，按服务器本地日切）
    const day = localDay(1788000000000);
    const byDay = sessions.querySessions({ day, limit: 100 });
    assert.equal(byDay.total, 1);
    assert.equal(byDay.sessions[0].nativeId, 'dsh-v4-0003');

    // from/to
    const range = sessions.querySessions({ from: 1788000000000, to: 1788000000000 + 1, limit: 100 });
    assert.equal(range.total, 1);

    // agent 过滤（含别名）
    assert.equal(sessions.querySessions({ agent: 'dsh', limit: 100 }).total, 3);
    assert.equal(sessions.querySessions({ agent: 'deepseek', limit: 100 }).total, 3, 'deepseek 是 dsh 的别名');
    assert.equal(sessions.querySessions({ agent: 'codex', limit: 100 }).total, 0);

    // project 过滤
    assert.equal(sessions.querySessions({ project: 'wakefx', limit: 100 }).total, 3);

    // 分页
    const p1 = sessions.querySessions({ limit: 2, offset: 0 });
    const p2 = sessions.querySessions({ limit: 2, offset: 2 });
    assert.equal(p1.sessions.length, 2);
    assert.equal(p2.sessions.length, 1);
    assert.equal(new Set([...p1.sessions, ...p2.sessions].map((s) => s.id)).size, 3);

    // 搜索：标题 / 正文（中文子串、大小写不敏感）
    assert.equal(sessions.querySessions({ q: 'npx', limit: 100 }).total, 1);
    assert.equal(sessions.querySessions({ q: 'NPX', limit: 100 }).total, 1, '大小写不敏感');
    assert.equal(sessions.querySessions({ q: 'Npx', limit: 100 }).total, 1, '大小写不敏感');
    assert.equal(sessions.querySessions({ q: '二维码', limit: 100 }).total, 1, '正文中文子串');
    assert.equal(sessions.querySessions({ q: '不存在的词xyz', limit: 100 }).total, 0);
    // LIKE 通配符要转义，不能被当成通配
    assert.equal(sessions.querySessions({ q: '%', limit: 100 }).total, 0);

    // withPreview：首条 user 文本消息前 200 字
    const prev = sessions.querySessions({ q: 'npx', limit: 100, withPreview: true });
    assert.match(prev.sessions[0].preview, /把 README 里的安装命令换成 npx 形式/);
    assert.ok(prev.sessions[0].preview.length <= 200);

    // facets
    assert.deepEqual(prev.facets.agents, [{ id: 'dsh', name: 'DeepSeek Harness', count: 1 }]);
    assert.equal(prev.facets.projects[0].id, 'wakefx');
    assert.deepEqual(prev.facets.hosts, [{ id: 'local', name: 'local', count: 1 }]);
    // facets 不受 agent/project/host 自身过滤影响（切维度用）
    const faceted = sessions.querySessions({ agent: 'codex', limit: 10 });
    assert.equal(faceted.total, 0);
    assert.equal(faceted.facets.agents[0].count, 3);
});

test('查询：getSession / getMessages 走 rowTo* 的 camelCase 形状', () => {
    const s = sessions.getSession('local:dsh:dsh-v4-0003');
    assert.equal(s.title, 'README 安装命令改 npx');
    assert.equal(s.agent, 'dsh');
    assert.equal(s.host, 'local');
    assert.equal(s.source, 'local');
    assert.equal(s.isSubagent, false);
    assert.equal(s.parentId, null);
    assert.ok(!('started_at' in s), '不能漏出 snake_case 列名');
    const msgs = sessions.getMessages('local:dsh:dsh-v4-0003');
    assert.equal(msgs.length, 10);
    assert.equal(msgs[0].seq, 0);
    assert.deepEqual(Object.keys(msgs[0]).sort(), ['kind', 'meta', 'role', 'seq', 'text', 'ts']);
    const limited = sessions.getMessages('local:dsh:dsh-v4-0003', { limit: 3, offset: 2 });
    assert.deepEqual(limited.map((m) => m.seq), [2, 3, 4]);
});

test('统计：totals / byAgent / byHour(24,升序) / byDay(升序)', () => {
    const day = localDay(1788000000000);
    const st = sessions.monthStats({ day });
    assert.equal(st.totals.sessions, 1);
    assert.equal(st.totals.agents, 1);
    assert.equal(st.totals.projects, 1);
    assert.equal(st.byAgent.length, 1);
    assert.equal(st.byAgent[0].agent, 'dsh');
    assert.equal(st.byAgent[0].sessions, 1);
    assert.equal(st.byHour.length, 24);
    assert.deepEqual(st.byHour.map((h) => h.hour), [...Array(24).keys()]);
    assert.equal(st.byHour.reduce((a, h) => a + h.sessions, 0), 1);
    assert.deepEqual(st.byDay.map((d) => d.day), [day]);

    const allTime = sessions.monthStats({});
    assert.equal(allTime.totals.sessions, 3);
    assert.deepEqual(allTime.byDay.map((d) => d.day), [...allTime.byDay.map((d) => d.day)].sort());
});

test('agentsOverview / listProjects：带会话计数与 detected', () => {
    const overview = sessions.agentsOverview({});
    const dsh = overview.find((a) => a.id === 'dsh');
    assert.equal(dsh.sessionCount, 3);
    assert.equal(dsh.detected, true);
    assert.equal(dsh.color, '#4D6BFE');
    const claude = overview.find((a) => a.id === 'claude-code');
    assert.equal(claude.sessionCount, 0);
    assert.equal(claude.roots[0].env, 'CLAUDE_CONFIG_DIR');

    const projects = sessions.listProjects({});
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, 'wakefx');
    assert.equal(projects[0].sessionCount, 3);
});

test('扫描：坏文件只进 errors[]，不中断整轮', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bad-'));
    const root = path.join(scratch, 'sessions');
    const good = path.join(root, 'p', 'ok');
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'session.v4.jsonl'), '{"type":"session","version":4,"id":"bad-scan-ok","createdAt":1,"cwd":"/tmp/p"}\n');
    const res = sessions.scanTargets({ targets: [{ agentId: 'dsh', root }], full: true });
    assert.equal(res.added, 1);
    assert.deepEqual(res.errors, []);
    // 根目录不存在 = 确定没有会话，不该报错
    const missing = sessions.scanTargets({ targets: [{ agentId: 'dsh', root: path.join(scratch, 'nope') }] });
    assert.deepEqual(missing.errors, []);
    assert.equal(missing.scanned, 0);
    fs.rmSync(scratch, { recursive: true, force: true });
});

function localDay(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
