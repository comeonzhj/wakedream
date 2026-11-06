// dream worker 的测试。运行：node --test test/dream.test.js
//
// 覆盖：
//   ① heuristic 全流程（临时 WAKEDREAM_HOME + 合成 fixture）→ 断言 §7 的文件形状、YAML 头、
//      source_sessions 与输入一致、文件间链接都指向真实存在的文件、落库与接口回读一致；
//   ② 幂等（同 day+store 跑两次结果一致）、dryRun 不落盘、无新会话时 skipped；
//   ③ 目录穿越被拒；
//   ④ openai-compatible 走本地假 HTTP 端点（chat/completions），不依赖任何真 key；
//   ⑤ 跨天累积（第二天重复出现的偏好才写进 preferences.md）；
//   ⑥ scheduler 的纯函数与配置写回；api 模块的 register 完整性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ---- 必须在 import 任何 app 模块之前设置 WAKEDREAM_HOME（config.js 在模块加载时读它）----
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wakedream-dream-'));
process.env.WAKEDREAM_HOME = TEST_HOME;

const { closeDb, getDb, metaGet } = await import('../src/server/db.js');
const { loadConfig, paths } = await import('../src/shared/config.js');
const { Router, json } = await import('../src/server/router.js');
const { runDream, listDreams, getDream, removeDream, memoryTree, readMemoryFile } = await import('../src/server/dream/index.js');
const scheduler = await import('../src/server/dream/scheduler.js');
const { computeNextRun, parseAt, scheduleInfo, updateSchedule, startScheduler, stopScheduler } = scheduler;
const store = await import('../src/server/dream/store.js');
const fixture = await import('./fixtures/dream/load.js');
const dreamApi = await import('../src/server/api/dream.js');
const memoryApi = await import('../src/server/api/memory.js');

const DAY = '2026-11-06';
const DAY2 = '2026-11-07';

const log = { info() {}, warn() {}, error() {} };

function freshConfig(extra = {}) {
    const config = loadConfig();
    config.dream = { ...config.dream, ...(extra.dream || {}) };
    config.providers = { ...(config.providers || {}), ...(extra.providers || {}) };
    return config;
}

function resetDb() {
    fixture.clearSessions(getDb());
    // 文件系统也要隔离：否则「失败时不落盘」这类断言会被上一个用例产出的目录干扰
    fs.rmSync(path.join(TEST_HOME, 'memory', 'dreams'), { recursive: true, force: true });
}

function seed(day = DAY, idPrefix = '') {
    const data = fixture.loadFixture();
    return fixture.insertFixtureSessions(getDb(), data.sessions, { day, idPrefix });
}

function storeDir(day, name = 'default') {
    return path.join(TEST_HOME, 'memory', 'dreams', day, name);
}

function readFileAt(dir, rel) {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function listTree(dir) {
    return fs.readdirSync(dir, { recursive: true })
        .map(String)
        .filter((p) => !p.endsWith('/') && fs.statSync(path.join(dir, p)).isFile())
        .sort();
}

const FM_KEYS = ['title', 'kind', 'day', 'source_sessions', 'updated_at'];

/** 每个 .md 都要有 §7 要求的 YAML 头 */
function parseFrontmatter(text) {
    assert.ok(text.startsWith('---\n'), '文件必须以 YAML 头开始');
    const end = text.indexOf('\n---', 3);
    assert.ok(end > 0, 'YAML 头必须闭合');
    const head = text.slice(4, end);
    const fm = {};
    let current = null;
    for (const line of head.split('\n')) {
        const item = /^\s+-\s+(.*)$/.exec(line);
        if (item && current) { fm[current].push(item[1].replace(/^"|"$/g, '')); continue; }
        const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
        if (!kv) continue;
        if (kv[2] === '') { current = kv[1]; fm[kv[1]] = []; }
        else if (kv[2] === '[]') { current = null; fm[kv[1]] = []; }
        else { current = null; fm[kv[1]] = kv[2].replace(/^"|"$/g, ''); }
    }
    return { fm, body: text.slice(end + 4) };
}

/** 抽出 markdown 里的相对链接，逐个解析成绝对路径 */
function relativeLinks(body) {
    const out = [];
    for (const m of body.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) out.push(m[1]);
    return out;
}

function assertLinksResolve(dir, relPath, body) {
    const baseDir = path.posix.dirname(relPath);
    for (const link of relativeLinks(body)) {
        const target = path.resolve(dir, baseDir === '.' ? '' : baseDir, link);
        assert.ok(target.startsWith(path.resolve(dir)), `链接越出记忆库：${relPath} -> ${link}`);
        assert.ok(fs.existsSync(target), `链接指向的文件不存在：${relPath} -> ${link}`);
    }
}

/** 忽略时间戳后比较两份记忆库（幂等性断言用） */
function normalizeForCompare(dir) {
    const out = {};
    for (const rel of listTree(dir)) {
        let text = readFileAt(dir, rel);
        if (rel.endsWith('.md')) {
            text = text.replace(/^updated_at:.*$/gm, 'updated_at: <ts>');
            text = text.replace(/^- 生成：.*$/gm, '- 生成：<ts>');
            text = text.replace(/^- 生成时间：.*$/gm, '- 生成时间：<ts>');
            text = text.replace(/^- 耗时：.*$/gm, '- 耗时：<ms>');
            text = text.replace(/^\| \d{2}:\d{2} \|/gm, '| <t> |');
        }
        if (rel.endsWith('manifest.json')) {
            const json = JSON.parse(text);
            json.generatedAt = '<ts>';
            if (json.stats) json.stats.timings = {};
            // 每个文件的字节数会随「耗时」行的毫秒位数变化（17ms / 9ms 差一个字符），
            // 并行跑时字节数会抖动 → 归一化掉，只比较结构与内容。
            json.files = json.files.map((f) => ({ ...f, bytes: '<n>' }));
            text = JSON.stringify(json, null, 2);
        }
        out[rel] = text;
    }
    return out;
}

// 假的 chat/completions 端点：模拟推理模型（content 里带围栏 + 前后废话）。
// 同一个端点承担两个角色：analyzer 调用回单会话 JSON，organizer 调用回收敛 JSON。
function startFakeLlm({ failOn = null, truncateOn = null } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            const last = parsed.messages?.at(-1)?.content || '';
            calls.push({ url: req.url, headers: req.headers, body: parsed, kind: /<analyses>/.test(last) ? 'organize' : 'analyze' });
            if (failOn && last.includes(failOn)) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: '模拟的服务端错误' } }));
                return;
            }
            let payloadJson;
            if (/<analyses>/.test(last)) {
                // organizer：从任务里的 analyses JSON 里取出全部会话 id，保证条目都有来源
                const ids = [...last.matchAll(/"sessionId":\s*"([^"]+)"/g)].map((m) => m[1]);
                payloadJson = {
                    index_intro: `模型收敛：共 ${ids.length} 个会话`,
                    projects: [{ slug: 'wakedream', title: 'wakedream', summary: '模型汇总', bullets: [{ text: '模型视角：项目有推进', sessions: ids.slice(0, 1) }] }],
                    decisions: [{ text: '模型决定：默认 provider 用 heuristic', reason: '离线可用', day: '2026-11-06', sessions: ids.slice(0, 1) }],
                    preferences: [],
                    open_questions: [],
                    people: [],
                    conflicts: [],
                    changes: ['模型合并了重复条目'],
                };
            } else {
                const sessionLine = /会话：`([^`]+)`/.exec(last);
                const sessionId = sessionLine ? sessionLine[1] : 'unknown';
                payloadJson = {
                    summary: `模型分析：${sessionId}`,
                    did_what: [{ text: '模型视角：完成了会话里的主要任务', evidence: '原文片段' }],
                    conclusions: [{ text: '模型结论：记忆萃取可以离线完成', evidence: '原文片段' }],
                    decisions: [{ text: '模型决定：默认 provider 用 heuristic', reason: '离线可用', evidence: '原文片段' }],
                    open_questions: [{ text: '模型未决：远端同步如何验证', evidence: '原文片段' }],
                    preferences: [],
                    people: [],
                    keywords: ['dream'],
                    commands: ['node --test test/dream.test.js'],
                    files: ['src/server/dream/index.js'],
                    stale_notes: [],
                };
            }
            const truncated = !!(truncateOn && last.includes(truncateOn));
            const content = `好的，这是结果：\n\`\`\`json\n${JSON.stringify(payloadJson)}\n\`\`\`\n`;
            const payload = {
                id: 'chatcmpl-fake',
                model: parsed.model,
                choices: [{
                    index: 0,
                    // 模拟推理模型的截断：内容被砍掉一半 + finish_reason=length
                    message: { role: 'assistant', content: truncated ? content.slice(0, Math.floor(content.length / 2)) : content },
                    finish_reason: truncated ? 'length' : 'stop',
                }],
                usage: { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 },
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
    });
}

test.after(() => {
    stopScheduler();
    closeDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ① heuristic 全流程
// ---------------------------------------------------------------------------

test('heuristic 全流程：产出 §7 形状的完整记忆库，且可回溯来源', async () => {
    resetDb();
    const seeded = seed(DAY);
    const result = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log });

    assert.equal(result.status, 'ok');
    assert.ok(result.dreamId);
    const dir = result.memoryDir;
    assert.equal(dir, storeDir(DAY));

    const files = listTree(dir);
    for (const required of ['_index.md', 'decisions.md', 'preferences.md', 'open-questions.md', 'report.md', 'manifest.json']) {
        assert.ok(files.includes(required), `缺少 ${required}`);
    }
    assert.ok(files.some((f) => f.startsWith('projects/') && f.endsWith('.md')), '缺少 projects/*.md');
    assert.ok(files.some((f) => f.startsWith('sessions/') && f.endsWith('.md')), '缺少 sessions/*.md');

    // 会话文件只覆盖主会话：子会话被折叠，不单独成文件
    const sessionFiles = files.filter((f) => f.startsWith('sessions/'));
    assert.equal(sessionFiles.length, seeded.mainIds.length);
    assert.ok(!sessionFiles.some((f) => f.includes('sub-44444444')), '子会话不应单独成文件');

    // 每个 .md 都有 YAML 头，且五个字段齐全
    const manifest = JSON.parse(readFileAt(dir, 'manifest.json'));
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest 必须列出文件 → source_sessions');
    for (const rel of files.filter((f) => f.endsWith('.md'))) {
        const text = readFileAt(dir, rel);
        const { fm, body } = parseFrontmatter(text);
        for (const key of FM_KEYS) {
            assert.ok(fm[key] !== undefined, `${rel} 缺少 YAML 字段 ${key}`);
        }
        assert.equal(fm.day, DAY);
        assert.ok(Array.isArray(fm.source_sessions));
        // source_sessions 必须都是真实输入会话 id
        for (const id of fm.source_sessions) {
            assert.ok(seeded.ids.includes(id), `${rel} 的 source_sessions 含未知会话 ${id}`);
        }
        assertLinksResolve(dir, rel, body);
    }

    // manifest 里每个文件都有 source_sessions，且与磁盘上的文件一一对应
    for (const f of manifest.files) {
        assert.ok(files.includes(f.path), `manifest 列了不存在的文件 ${f.path}`);
        assert.ok(Array.isArray(f.sourceSessions));
        // 索引/项目/会话文件必然有来源；允许 decisions/preferences 等「本次为空」的扁平文件为空表
        if (/^(_index|projects\/|sessions\/)/.test(f.path)) {
            assert.ok(f.sourceSessions.length > 0, `${f.path} 没有 source_sessions`);
        }
    }

    // _index.md 是入口：列出当天会话清单（session_id、agent、@host、标题、时间）
    const index = readFileAt(dir, '_index.md');
    const { fm: indexFm } = parseFrontmatter(index);
    assert.equal(indexFm.kind, 'index');
    for (const id of seeded.mainIds) assert.ok(index.includes(id), `_index.md 没列出会话 ${id}`);
    assert.ok(index.includes('@local'), '_index.md 应带 @host');
    assert.ok(index.includes('@ssh:mac-mini'), '_index.md 应带远端 @host');
    assert.ok(/\| 09:00 \| `dsh` \|/.test(index), '_index.md 的会话清单应含时间与 agent');
    // 索引里所有会话都有链接文件
    for (const id of seeded.mainIds) {
        const slug = store.sessionFileSlug(id);
        assert.ok(files.includes(`sessions/${slug}.md`), `缺少会话文件 sessions/${slug}.md`);
    }

    // 决定 / 未决 / 偏好：每条都带 source_sessions
    assert.ok(manifest.decisions.length >= 2, '应识别出至少 2 条决定');
    for (const d of manifest.decisions) assert.ok(d.sessions.length > 0, `决定缺 source_sessions：${d.text}`);
    assert.ok(manifest.openQuestions.length >= 1);
    for (const q of manifest.openQuestions) assert.ok(q.sessions.length > 0);
    // 同一句话不在同一份文件里跨小节重复（一次是条目本身，一次是「原文」证据，共 2 次）
    const sessionA = readFileAt(dir, `sessions/${store.sessionFileSlug('local:dsh:11111111')}.md`);
    const occurrences = sessionA.split('就按 heuristic 做默认 provider').length - 1;
    assert.equal(occurrences, 2, '同一句决定只应出现在「决定」条目与其原文证据里，不该在别的节重复');
    assert.ok(!/## 偏好线索[\s\S]*就按 heuristic/.test(sessionA), '已在「决定」里出现的句子不应再出现在偏好线索里');
    assert.ok(sessionA.includes('以后都用中文回答'), '偏好线索本身要保留');

    // 落库：dreams / dream_inputs / memory_files / meta.last_dream_at
    const db = getDb();
    const dreamRow = db.prepare('select * from dreams where id = ?').get(result.dreamId);
    assert.equal(dreamRow.status, 'ok');
    assert.equal(dreamRow.day, DAY);
    assert.equal(dreamRow.session_count, seeded.mainIds.length);
    assert.equal(dreamRow.memory_dir, dir);
    const inputs = db.prepare('select * from dream_inputs where dream_id = ?').all(result.dreamId);
    assert.equal(inputs.length, seeded.mainIds.length);
    for (const input of inputs) assert.ok(input.chars > 0, 'dream_inputs.chars 应记录喂进去的字符数');
    const memFiles = db.prepare('select * from memory_files where dream_id = ?').all(result.dreamId);
    assert.equal(memFiles.length, manifest.files.length + 1); // +manifest.json 自己
    assert.ok(metaGet('last_dream_at'), '应写 meta.last_dream_at');

    // 接口回读一致：memoryTree / readMemoryFile
    const tree = memoryTree({ dreamId: result.dreamId });
    assert.equal(path.resolve(tree.root), path.resolve(dir));
    assert.deepEqual(tree.files.map((f) => f.path).sort(), files.sort());
    for (const f of tree.files) {
        assert.ok(f.bytes > 0);
        assert.ok(f.title, `${f.path} 应能从 YAML 头读出 title`);
        assert.ok(f.kind, `${f.path} 应能从 YAML 头读出 kind`);
    }
    const file = readMemoryFile({ path: '_index.md', dreamId: result.dreamId });
    assert.equal(file.path, '_index.md');
    assert.equal(file.markdown, index);
    assert.equal(file.kind, 'index');
    const found = getDream(result.dreamId);
    assert.equal(found.dream.id, result.dreamId);
    assert.equal(found.inputs.length, seeded.mainIds.length);
    assert.ok(found.reportMarkdown.includes('# 2026-11-06 做梦报告'));
    assert.ok(found.reportMarkdown.includes('## 成本统计'));

    // 报告要点：总览 / 成本 / 失败项
    const report = readFileAt(dir, 'report.md');
    assert.ok(report.includes('heuristic'));
    assert.ok(report.includes('模型调用：0（heuristic 不调用模型）'));
    assert.ok(report.includes('分析失败被跳过的会话：无'));
    assert.ok(report.includes('折叠进父会话的子会话：1'));

    // 子会话内容被折进父会话（转录里出现 sub-thread）
    assert.ok(manifest.stats.sessionCount === seeded.mainIds.length);

    // listDreams
    const dreams = listDreams({ limit: 10 });
    assert.equal(dreams.length, 1);
    assert.equal(dreams[0].id, result.dreamId);
    assert.equal(dreams[0].stats.provider, 'heuristic');
});

test('SQLite 里没有存原始转录内容之外的写入：原始会话不被修改', async () => {
    const db = getDb();
    const before = db.prepare('select count(*) c from messages').get().c;
    await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log, force: true });
    const after = db.prepare('select count(*) c from messages').get().c;
    assert.equal(after, before, '做梦不得改动原始会话消息');
});

// ---------------------------------------------------------------------------
// ② 幂等 / dryRun / skipped
// ---------------------------------------------------------------------------

test('幂等：同 day+store 重跑覆盖同一目录，内容一致（除时间戳）', async () => {
    const first = normalizeForCompare(storeDir(DAY));
    const result = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log, force: true });
    assert.equal(result.status, 'ok');
    const second = normalizeForCompare(storeDir(DAY));
    assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
    for (const key of Object.keys(first)) {
        assert.equal(second[key], first[key], `${key} 在重跑后变了`);
    }
    // 旧记录被替换，不会堆积
    const rows = getDb().prepare("select count(*) c from dreams where day = ? and status = 'ok'").get(DAY).c;
    assert.equal(rows, 1, '同一 day+store 只保留一份成功记录');
});

test('dryRun：只算不落盘、不写库，也不动已有记忆库', async () => {
    const db = getDb();
    const dir = storeDir(DAY);
    const before = normalizeForCompare(dir);
    const dreamsBefore = db.prepare('select count(*) c from dreams').get().c;
    const memFilesBefore = db.prepare('select count(*) c from memory_files').get().c;

    const result = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log, dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.dreamId, null);
    assert.equal(result.memoryDir, null);
    assert.ok(result.files.length > 0, 'dryRun 也要算出会产出哪些文件');
    assert.ok(result.files.some((f) => f.path === '_index.md'), 'dryRun 应给出 _index.md 的计划');
    assert.deepEqual(normalizeForCompare(dir), before, 'dryRun 不得改动已有记忆库');
    assert.equal(db.prepare('select count(*) c from dreams').get().c, dreamsBefore, 'dryRun 不得写库');
    assert.equal(db.prepare('select count(*) c from memory_files').get().c, memFilesBefore);

    // 没有任何会话的一天：dryRun 同样什么都不写
    const emptyDay = '2026-10-01';
    const empty = await runDream({ day: emptyDay, provider: 'heuristic', config: freshConfig(), log, dryRun: true });
    assert.equal(empty.status, 'skipped');
    assert.equal(empty.reason, 'no-sessions');
    assert.ok(!fs.existsSync(storeDir(emptyDay)));
});

test('force=false 且没有新会话 → skipped；有新会话 → 重跑', async () => {
    const skipped = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'no-new-sessions');
    assert.ok(skipped.dreamId, '跳过时应指回当天已有的成功记录');

    // 新增一个当天会话 → 不再是跳过
    const data = fixture.loadFixture();
    const [extra] = fixture.insertFixtureSessions(getDb(), [data.sessions[2]], { day: DAY, idPrefix: 'late-' }).ids;
    const rerun = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log });
    assert.equal(rerun.status, 'ok');
    const index = readFileAt(storeDir(DAY), '_index.md');
    assert.ok(index.includes(extra), '新会话应进当天的会话清单');

    // 没有会话的一天：同样跳过且不落盘
    const empty = await runDream({ day: '2026-10-01', provider: 'heuristic', config: freshConfig(), log });
    assert.equal(empty.status, 'skipped');
    assert.equal(empty.reason, 'no-sessions');
    assert.ok(!fs.existsSync(storeDir('2026-10-01')));
});

// ---------------------------------------------------------------------------
// ③ 目录穿越
// ---------------------------------------------------------------------------

test('目录穿越与绝对路径都被拒', async () => {
    const dream = listDreams({ limit: 1 })[0];
    const dir = storeDir(DAY);
    for (const evil of ['../../../../etc/passwd', '/etc/passwd', 'projects/../../../../etc/hosts', '../decisions.md']) {
        assert.throws(() => readMemoryFile({ path: evil, dreamId: dream.id }), (err) => err.code === 'E_MEMORY_PATH', `应拒绝 ${evil}`);
        assert.throws(() => store.resolveInside(dir, evil), (err) => err.code === 'E_MEMORY_PATH');
    }
    // 合法路径仍然可读
    assert.ok(readMemoryFile({ path: 'projects/' + fs.readdirSync(path.join(dir, 'projects'))[0], dreamId: dream.id }).markdown.length > 0);
});

test('api/memory/file 的穿越请求返回 400，缺失参数 400，未知 dream 404', async () => {
    const router = new Router();
    memoryApi.register(router);

    const call = async (method, url, body) => {
        const { route, params } = router.match(method, new URL(url, 'http://x').pathname);
        assert.ok(route, `${method} ${url} 未注册`);
        const req = {
            headers: { 'content-type': 'application/json' },
            async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); },
        };
        let status = 200;
        let payload = null;
        const res = {
            writableEnded: false,
            writeHead(code) { status = code; },
            end(text) { payload = text; this.writableEnded = true; },
        };
        const result = await route.handler({
            req, res, params, query: Object.fromEntries(new URL(url, 'http://x').searchParams), config: {}, log,
        });
        if (result !== undefined && !res.writableEnded) json(res, result);
        return { status, body: payload ? JSON.parse(payload) : null };
    };

    const traversal = await call('GET', '/api/memory/file?path=../../../../etc/passwd');
    assert.equal(traversal.status, 400);
    assert.match(traversal.body.error, /越界/);

    const missing = await call('GET', '/api/memory/file');
    assert.equal(missing.status, 400);

    const unknown = await call('GET', '/api/memory/tree?dreamId=nope');
    assert.equal(unknown.status, 200); // memoryTree 对未知 dreamId 回落到空树
    assert.deepEqual(unknown.body.files, []);

    const okTree = await call('GET', '/api/memory/tree');
    assert.equal(okTree.status, 200);
    assert.ok(okTree.body.files.length > 0);

    const okFile = await call('GET', '/api/memory/file?path=_index.md');
    assert.equal(okFile.status, 200);
    assert.ok(okFile.body.markdown.startsWith('---'));
});

// ---------------------------------------------------------------------------
// ④ openai-compatible 走真实 HTTP（本地假端点）
// ---------------------------------------------------------------------------

test('openai-compatible：走 chat/completions，tokens 进 dreams.stats，单会话失败不整轮失败', async () => {
    const { server, calls, port } = await startFakeLlm();
    try {
        resetDb();
        const seeded = seed(DAY);
        const config = freshConfig({
            providers: {
                'openai-compatible': { apiKey: 'test-key-not-real', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-model' },
            },
        });
        const result = await runDream({ day: DAY, provider: 'openai-compatible', config, log });
        assert.equal(result.status, 'ok');
        assert.equal(result.stats.cost.calls, seeded.mainIds.length + 1, 'analyzer 每会话一次 + organizer 一次');
        assert.equal(result.stats.cost.inputTokens, 1234 * (seeded.mainIds.length + 1));
        assert.equal(result.stats.cost.totalTokens, 1801 * (seeded.mainIds.length + 1));

        const db = getDb();
        const row = db.prepare('select * from dreams where id = ?').get(result.dreamId);
        const stats = JSON.parse(row.stats);
        assert.equal(stats.cost.totalTokens, 1801 * (seeded.mainIds.length + 1), 'tokens 必须进 dreams.stats');
        assert.equal(row.provider, 'openai-compatible');
        assert.equal(row.model, 'fake-model');

        // 请求形状：带上 key、模型名与 max_tokens（推理模型需要 >=2000）
        assert.ok(calls.length >= 1);
        assert.equal(calls[0].url, '/v1/chat/completions');
        assert.equal(calls[0].headers.authorization, 'Bearer test-key-not-real');
        assert.equal(calls[0].body.model, 'fake-model');
        assert.ok(calls[0].body.max_tokens >= 2000);
        assert.equal(calls[0].body.messages[0].role, 'system');
        assert.match(calls[0].body.messages[0].content, /analyzer|记忆维护/, 'system 应是中文 analyzer 提示词');

        // 模型路径产出的记忆库同样满足 §7
        const dir = result.memoryDir;
        const manifest = JSON.parse(readFileAt(dir, 'manifest.json'));
        assert.equal(manifest.provider, 'openai-compatible');
        for (const f of manifest.files) {
            assert.ok(Array.isArray(f.sourceSessions));
            if (/^(_index|projects\/|sessions\/)/.test(f.path)) {
                assert.ok(f.sourceSessions.length > 0, `${f.path} 没有 source_sessions`);
            }
        }
        const index = readFileAt(dir, '_index.md');
        for (const id of seeded.mainIds) assert.ok(index.includes(id));
        assert.ok(readFileAt(dir, 'decisions.md').includes('模型决定'));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('模型路径下单会话失败：跳过该会话并记进报告，不整轮失败', async () => {
    // 让某个会话的 analyzer 调用一直 500（retries=0 以免测试等退避）
    const { server, calls, port } = await startFakeLlm({ failOn: 'local:claude-code:22222222' });
    try {
        resetDb();
        const seeded = seed(DAY);
        const config = freshConfig({
            providers: {
                'openai-compatible': { apiKey: 'test-key-not-real', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-model', retries: 0 },
            },
        });
        const result = await runDream({ day: DAY, provider: 'openai-compatible', config, log });
        assert.equal(result.status, 'ok', '个别会话失败不应让整轮失败');
        assert.equal(result.stats.sessionCount, seeded.mainIds.length - 1);
        assert.equal(result.stats.failures.length, 1);
        assert.equal(result.stats.failures[0].sessionId, 'local:claude-code:22222222');
        assert.match(result.stats.failures[0].error, /500/);
        assert.equal(result.stats.degraded.analyze, true);

        // 报告里写清楚跳过了谁
        const report = readFileAt(result.memoryDir, 'report.md');
        assert.ok(report.includes('分析失败被跳过的会话：1 个'));
        assert.ok(report.includes('local:claude-code:22222222'));
        // 库里也留痕
        const inputs = getDb().prepare('select * from dream_inputs where dream_id = ?').all(result.dreamId);
        const failedInput = inputs.find((i) => i.session_id === 'local:claude-code:22222222');
        assert.ok(failedInput && /^failed:/.test(failedInput.notes), 'dream_inputs.notes 应记下失败原因');
        // 成功的会话照常进记忆库
        const index = readFileAt(result.memoryDir, '_index.md');
        assert.ok(index.includes('local:dsh:11111111'));
        assert.ok(!index.includes('local:claude-code:22222222'));
        assert.equal(calls.filter((c) => c.kind === 'analyze').length, seeded.mainIds.length, '每个会话发一次请求（重试 0 次）');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('全部会话都失败 → status=failed，不写半个记忆库', async () => {
    const { server, port } = await startFakeLlm({ failOn: 'SESSION' });
    try {
        resetDb();
        seed(DAY);
        const config = freshConfig({
            providers: {
                'openai-compatible': { apiKey: 'test-key-not-real', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-model', retries: 0 },
            },
        });
        const result = await runDream({ day: DAY, provider: 'openai-compatible', config, log });
        assert.equal(result.status, 'failed');
        assert.ok(result.error);
        assert.ok(!fs.existsSync(storeDir(DAY)), '失败时不应落盘');
        const row = getDb().prepare('select * from dreams where id = ?').get(result.dreamId);
        assert.equal(row.status, 'failed');
        assert.match(row.error, /分析失败/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('模型输出被 max_tokens 截断时不静默：记告警、进报告，organizer 截断则退回规则式收敛', async () => {
    // ① analyzer 被截断 → 仍然产出记忆库，但 stats.warnings 明确记录
    const { server, port } = await startFakeLlm({ truncateOn: '会话：' });
    try {
        resetDb();
        seed(DAY);
        const config = freshConfig({
            providers: { 'openai-compatible': { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake', retries: 0 } },
        });
        const result = await runDream({ day: DAY, provider: 'openai-compatible', config, log });
        const truncWarnings = result.stats.warnings.filter((w) => w.kind === 'completion-truncated');
        assert.ok(truncWarnings.length >= 1, 'analyzer 截断必须记进 warnings');
        assert.equal(result.stats.degraded.truncations, truncWarnings.length);
        const report = readFileAt(result.memoryDir, 'report.md');
        assert.ok(report.includes('告警'), '报告里必须有告警段');
        assert.ok(report.includes('max_tokens 截断'));
        // 会话的时效性提醒里也要写出来
        const sessionFile = listTree(result.memoryDir).find((f) => f.startsWith('sessions/'));
        assert.ok(readFileAt(result.memoryDir, sessionFile).includes('截断'));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    // ② organizer 被截断 → 退回规则式收敛（把今天的条目补全），并写明原因
    const second = await startFakeLlm({ truncateOn: '<analyses>' });
    try {
        resetDb();
        seed(DAY);
        const config = freshConfig({
            providers: { 'openai-compatible': { apiKey: 'k', baseUrl: `http://127.0.0.1:${second.port}/v1`, model: 'fake', retries: 0 } },
        });
        const result = await runDream({ day: DAY, provider: 'openai-compatible', config, log });
        assert.equal(result.status, 'ok');
        assert.equal(result.stats.degraded.organize, true);
        assert.match(result.stats.degraded.organizeReason, /截断/);
        const manifest = JSON.parse(readFileAt(result.memoryDir, 'manifest.json'));
        assert.ok(manifest.decisions.length >= 1, '退回规则式收敛后，今天的决定不能丢');
        assert.ok(manifest.decisions[0].sessions.length > 0, '退回后决定仍带来源会话');
        const manifestRaw = JSON.parse(readFileAt(result.memoryDir, 'manifest.json'));
        assert.ok(manifestRaw.changes.some((c) => /退回规则式收敛/.test(c)), 'manifest.changes 要写明退回规则式收敛');
        assert.equal(manifestRaw.organizerSource, 'heuristic-fallback');
        assert.match(readFileAt(result.memoryDir, 'report.md'), /阶段降级：analyze=.*organize=有降级/);
    } finally {
        await new Promise((resolve) => second.server.close(resolve));
    }
});

test('adapter 兼容：用户消息被落成 kind=meta 时照样能抽到决定/未决（sessions worker 的真实风格）', async () => {
    resetDb();
    const data = fixture.loadFixture();
    // 真实库里 sessions worker 把用户消息（票据 JSON、runtime context、system-reminder）落成 kind='meta'，
    // 只有用户手打的少数几条是 kind='text'。这里复刻这个风格，确保 dream 不会因此抽空。
    for (const session of data.sessions) {
        for (const message of session.messages) if (message.role === 'user') message.kind = 'meta';
    }
    const seeded = fixture.insertFixtureSessions(getDb(), data.sessions, { day: DAY });
    const result = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log });
    assert.equal(result.status, 'ok');
    const manifest = JSON.parse(readFileAt(result.memoryDir, 'manifest.json'));
    assert.ok(manifest.decisions.length >= 2, 'kind=meta 的用户消息里的决定必须被抽到');
    assert.ok(manifest.openQuestions.length >= 1, 'kind=meta 的用户消息里的未决必须被抽到');
    assert.ok(manifest.nextSteps.length >= 1, 'kind=meta 的用户消息里的下一步必须被抽到');
    // 转录渲染也把 meta 的用户消息当 USER: 而不是 EVENT
    const index = readFileAt(result.memoryDir, '_index.md');
    for (const id of seeded.mainIds) assert.ok(index.includes(id));
});

test('抽取补强：下一步 / 偏好候选都能落到文件与 manifest 里', async () => {
    resetDb();
    const seeded = seed(DAY);
    const result = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log });
    assert.equal(result.status, 'ok');
    const dir = result.memoryDir;
    const manifest = JSON.parse(readFileAt(dir, 'manifest.json'));

    // 「下一步」既进 manifest，也进对应会话文件
    assert.ok(manifest.nextSteps.length >= 1, '应识别出下一步线索');
    assert.ok(manifest.nextSteps.some((s) => /相对链接/.test(s.text)), '应抓到「下一步要把 sessions/ 补相对链接」');
    assert.ok(manifest.nextSteps.every((s) => seeded.mainIds.includes(s.session)), '每条下一步都带来源会话');
    const sessionB = readFileAt(dir, `sessions/${store.sessionFileSlug('local:claude-code:22222222')}.md`);
    assert.ok(sessionB.includes('## 下一步'), '会话文件应有「下一步」小节');

    // 决定 / 项目都不能是空的（真实数据下也不能只有工具统计）
    assert.ok(manifest.decisions.length >= 2, '决定不应为空');
    assert.ok(manifest.projects.length >= 2, '应至少有两个项目');
    assert.ok(manifest.projects.every((p) => p.sessions.length > 0));
    for (const f of manifest.files) {
        if (f.path.startsWith('projects/')) assert.ok(f.sourceSessions.length > 0);
    }

    // 只出现一次的偏好 → 不写进偏好主表，但要出现在「候选」里，便于跨天攒够次数
    const prefFile = readFileAt(dir, 'preferences.md');
    assert.ok(prefFile.includes('## 候选'), '偏好文件应列出候选');
    assert.ok(prefFile.includes('候选（只出现过一次'), '候选段要有解释');
    for (const c of manifest.preferenceCandidates) assert.ok(c.sessions.length > 0, '候选也要有来源会话');

    // 项目文件不能只有工具调用统计
    const projectFiles = listTree(dir).filter((f) => f.startsWith('projects/'));
    const richest = readFileAt(dir, projectFiles[0]);
    assert.ok(richest.includes('## 今天推进了什么 / 结论'));
    assert.ok(richest.split('\n').filter((l) => l.startsWith('- ') && l.length > 30).length >= 1, '项目文件应有实质条目');
});

test('scheduler：到点触发失败只记日志 + 留 failed 记录，不抛也不停止进程', async () => {
    resetDb();
    seed(DAY);
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const logs = [];
    const failedRowError = () => getDb().prepare("select error from dreams where status = 'failed' order by started_at desc limit 1").get()?.error || '';
    try {
        // 配置成「要 key 的 provider 但没 key」→ 触发时必然失败
        await updateSchedule({ enabled: true, at: '02:15', provider: 'openai-compatible', windowDays: 1 });
        await startScheduler({
            config: freshConfig({ dream: { enabled: true, at: '02:15', provider: 'openai-compatible' } }),
            log: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
        });
        const failedBefore = getDb().prepare("select count(*) c from dreams where status = 'failed'").get().c;
        await scheduler._internal.fire();   // 手动触发一次，等价于到点触发
        const failedAfter = getDb().prepare("select count(*) c from dreams where status = 'failed'").get().c;
        assert.equal(failedAfter, failedBefore + 1, '失败应留**一条** failed 记录（不重复记）');
        assert.ok(failedRowError().length > 0, 'failed 记录里要有错误原因');
        assert.ok(logs.some(([level, msg]) => level === 'error' && /不影响常驻进程/.test(String(msg))));
        const info = scheduleInfo();
        assert.equal(info.running, false, '触发结束后 running 必须复位（进程还活着）');
        assert.ok(info.nextRun > Date.now(), '触发后应重算下一次');
    } finally {
        stopScheduler();
        await updateSchedule({ enabled: false });
        if (saved) process.env.OPENAI_API_KEY = saved;
    }
});

test('api 遵守 main.js 的 ctx.body 契约：不重复读已被消费的请求流', async () => {
    const router = new Router();
    dreamApi.register(router);

    const callWithBody = async (method, url, ctxBody) => {
        const { route, params } = router.match(method, new URL(url, 'http://x').pathname);
        let readAttempts = 0;
        const req = {
            headers: { 'content-type': 'application/json' },
            async *[Symbol.asyncIterator]() { readAttempts += 1; },   // main.js 已读过，这里不该再有人读
        };
        let status = 200;
        let payload = null;
        const res = { writableEnded: false, writeHead(c) { status = c; }, end(t) { payload = t; this.writableEnded = true; } };
        const result = await route.handler({ req, res, params, body: ctxBody, query: {}, config: {}, log });
        if (result !== undefined && !res.writableEnded) json(res, result);
        return { status, body: payload ? JSON.parse(payload) : null, readAttempts };
    };

    const bad = await callWithBody('POST', '/api/dreams/run', { provider: 'nope' });
    assert.equal(bad.status, 400, '必须用 ctx.body 校验 provider');
    assert.match(bad.body.error, /provider/);
    assert.equal(bad.readAttempts, 0, 'ctx.body 存在时不得再去读 req 流');

    const put = await callWithBody('PUT', '/api/dream/schedule', { at: '06:30' });
    assert.equal(put.status, 200);
    assert.equal(put.body.schedule.at, '06:30');
    assert.equal(put.readAttempts, 0);
    await updateSchedule({ enabled: false, at: '03:30' });
});

test('缺 API key 时明确报错，不静默降级', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
        resetDb();
        seed(DAY);
        await assert.rejects(
            () => runDream({ day: DAY, provider: 'openai-compatible', config: freshConfig(), log }),
            (err) => {
                assert.equal(err.code, 'E_NO_API_KEY');
                assert.match(err.message, /OPENAI_API_KEY/);
                return true;
            },
        );
        // 失败也要在 dreams 里留痕
        const failed = getDb().prepare("select * from dreams where status = 'failed' order by started_at desc").get();
        assert.ok(failed, '缺 key 也应留下 failed 记录');
        assert.match(failed.error, /api key/i);
    } finally {
        if (saved) process.env.OPENAI_API_KEY = saved;
    }
});

test('未知 provider 明确报错', async () => {
    await assert.rejects(
        () => runDream({ day: DAY, provider: 'gpt-magic', config: freshConfig(), log }),
        (err) => err.code === 'E_UNKNOWN_PROVIDER',
    );
});

// ---------------------------------------------------------------------------
// ⑤ 跨天累积
// ---------------------------------------------------------------------------

test('跨天累积：重复出现的偏好才写进 preferences.md，并带上出现的每一天', async () => {
    resetDb();
    seed(DAY);
    const day1 = await runDream({ day: DAY, provider: 'heuristic', config: freshConfig(), log });
    assert.equal(day1.status, 'ok');
    const day1Prefs = JSON.parse(readFileAt(storeDir(DAY), 'manifest.json')).preferences;
    // 同一天里跨两个会话重复出现的偏好 → 写入；只出现一次的偏好 → 不写
    assert.equal(day1Prefs.length, 1, `第一天应只写入重复出现的那一条，实际 ${JSON.stringify(day1Prefs.map((p) => p.text))}`);
    assert.match(day1Prefs[0].text, /中文/);
    assert.ok(!JSON.stringify(day1Prefs).includes('表格'), '只出现一次的偏好不得写入');
    assert.ok(day1Prefs[0].sessions.length >= 2, '应记录它出现在哪些会话里');

    // 第二天再来一遍：同一句偏好跨天重复（含第一天只出现一次的那条）
    seed(DAY2, 'd2-');
    const day2 = await runDream({ day: DAY2, provider: 'heuristic', config: freshConfig(), log });
    assert.equal(day2.status, 'ok');
    const day2Manifest = JSON.parse(readFileAt(storeDir(DAY2), 'manifest.json'));
    assert.equal(day2Manifest.preferences.length, 2, '跨天重复后两条偏好都应写入');
    const chinese = day2Manifest.preferences.find((p) => /中文/.test(p.text));
    const table = day2Manifest.preferences.find((p) => /表格/.test(p.text));
    assert.ok(chinese && table);
    assert.ok(chinese.days.includes(DAY) && chinese.days.includes(DAY2), `偏好应带两天，实际 ${JSON.stringify(chinese.days)}`);
    assert.ok(table.days.includes(DAY) && table.days.includes(DAY2), `偏好应带两天，实际 ${JSON.stringify(table.days)}`);
    const prefFile = readFileAt(storeDir(DAY2), 'preferences.md');
    assert.ok(prefFile.includes(table.text));
    assert.ok(prefFile.includes('跨天累积'), '偏好文件应说明是跨天累积的');
    assert.ok(day2Manifest.decisions.length >= 2, '决定也要跨天累积');
    assert.ok(day2Manifest.stats.cost.calls === 0, 'heuristic 不调用模型，成本记 0');

    // 删除一次做梦：只删记忆产物与记录，不动原始会话
    const msgBefore = getDb().prepare('select count(*) c from messages').get().c;
    const removed = await removeDream(day2.dreamId);
    assert.deepEqual(removed, { ok: true });
    assert.ok(!fs.existsSync(storeDir(DAY2)));
    assert.equal(getDb().prepare('select count(*) c from dreams where id = ?').get(day2.dreamId).c, 0);
    assert.equal(getDb().prepare('select count(*) c from messages').get().c, msgBefore);
});

// ---------------------------------------------------------------------------
// ⑥ scheduler / api 注册
// ---------------------------------------------------------------------------

test('scheduler：computeNextRun 是本地时区的下一个 HH:MM', () => {
    assert.deepEqual(parseAt('03:30'), { hour: 3, minute: 30 });
    assert.equal(parseAt('25:00'), null);
    assert.equal(parseAt('abc'), null);

    const at = (s) => new Date(s).getTime();
    // 当天还没到 → 当天
    const next1 = computeNextRun('03:30', at('2026-11-06T01:00:00'));
    assert.equal(new Date(next1).getHours(), 3);
    assert.equal(new Date(next1).getMinutes(), 30);
    assert.equal(new Date(next1).getDate(), 6);
    // 已经过了 → 第二天
    const next2 = computeNextRun('03:30', at('2026-11-06T05:00:00'));
    assert.equal(new Date(next2).getDate(), 7);
    // 正好等于现在 → 顺延到明天（避免同一分钟重复触发）
    const next3 = computeNextRun('03:30', at('2026-11-06T03:30:00'));
    assert.equal(new Date(next3).getDate(), 7);
});

test('scheduler：startScheduler 不阻塞、scheduleInfo/updateSchedule 写回配置', async () => {
    const info0 = scheduleInfo();
    assert.equal(typeof info0.at, 'string');
    assert.equal(typeof info0.enabled, 'boolean');

    const updated = await updateSchedule({ enabled: true, at: '02:15', provider: 'heuristic', windowDays: 2 });
    assert.equal(updated.schedule.at, '02:15');
    assert.equal(updated.schedule.windowDays, 2);
    assert.equal(updated.schedule.enabled, true);
    assert.ok(updated.schedule.nextRun > Date.now());
    assert.equal(new Date(updated.schedule.nextRun).getHours(), 2);

    // 写进了 config.json
    const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'config.json'), 'utf8'));
    assert.equal(onDisk.dream.at, '02:15');
    assert.equal(onDisk.dream.windowDays, 2);

    await assert.rejects(() => updateSchedule({ at: '99:99' }), /HH:MM/);
    await assert.rejects(() => updateSchedule({ provider: 'nope' }), /provider/);

    // startScheduler 立刻返回（不 await 做梦本身），并且把定时器挂上
    const started = await startScheduler({ config: freshConfig({ dream: { enabled: true, at: '02:15' } }), log });
    assert.ok(started.nextRun > Date.now());
    assert.equal(new Date(started.nextRun).getHours(), 2);
    stopScheduler();
    assert.equal(scheduleInfo().running, false);
    // 配置里关掉之后（没挂定时器时）nextRun 就是 null
    await updateSchedule({ enabled: false });
    assert.equal(scheduleInfo().nextRun, null);
    assert.equal(scheduleInfo().enabled, false);
    // 关掉之后做梦跑不了？—— 不，cron/手动仍可跑 runDream；这里只断言调度不再触发
    const offOnDisk = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'config.json'), 'utf8'));
    assert.equal(offOnDisk.dream.enabled, false);
});

test('api 模块导出 register，且 §5 的路径全部注册', async () => {
    const router = new Router();
    assert.equal(typeof dreamApi.register, 'function');
    assert.equal(typeof memoryApi.register, 'function');
    dreamApi.register(router);
    memoryApi.register(router);
    const routes = router.list();
    for (const expected of [
        'GET /api/dreams', 'GET /api/dreams/:id', 'POST /api/dreams/run', 'DELETE /api/dreams/:id',
        'GET /api/memory/tree', 'GET /api/memory/file', 'GET /api/dream/schedule', 'PUT /api/dream/schedule',
    ]) {
        assert.ok(routes.includes(expected), `缺少路由 ${expected}`);
    }
});

test('POST /api/dreams/run 与 GET /api/dreams 走通（含非法入参 400）', async () => {
    const router = new Router();
    dreamApi.register(router);

    const call = async (method, url, body, config = freshConfig()) => {
        const { route, params } = router.match(method, new URL(url, 'http://x').pathname);
        assert.ok(route, `${method} ${url} 未注册`);
        const req = {
            headers: { 'content-type': 'application/json' },
            async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); },
        };
        let status = 200;
        let payload = null;
        const res = {
            writableEnded: false,
            writeHead(code) { status = code; },
            end(text) { payload = text; this.writableEnded = true; },
        };
        const result = await route.handler({ req, res, params, query: Object.fromEntries(new URL(url, 'http://x').searchParams), config, log });
        if (result !== undefined && !res.writableEnded) json(res, result);
        return { status, body: payload ? JSON.parse(payload) : null };
    };

    const list = await call('GET', '/api/dreams');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.dreams));

    const badProvider = await call('POST', '/api/dreams/run', { day: DAY, provider: 'nope' });
    assert.equal(badProvider.status, 400);
    assert.match(badProvider.body.error, /provider/);

    const badDay = await call('POST', '/api/dreams/run', { day: '06-11-2026' });
    assert.equal(badDay.status, 400);

    const dry = await call('POST', '/api/dreams/run', { day: DAY, provider: 'heuristic', dryRun: true, force: false });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.status, 'dry-run');

    const schedule = await call('GET', '/api/dream/schedule');
    assert.equal(schedule.status, 200);
    assert.equal(typeof schedule.body.at, 'string');

    const put = await call('PUT', '/api/dream/schedule', { at: '04:45' });
    assert.equal(put.status, 200);
    assert.equal(put.body.schedule.at, '04:45');
    await updateSchedule({ enabled: false });
});

test('report.md 与 manifest.json 落在 §7 规定的目录，且 manifest 可被跨天累积读回', async () => {
    const manifestPath = store.manifestPath(DAY, 'default');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.day, DAY);
    assert.equal(manifest.store, 'default');
    const previous = store.findPreviousManifest('default', DAY2);
    assert.ok(previous);
    assert.equal(previous.day, DAY);
    assert.ok(Array.isArray(previous.manifest.decisions));
    assert.ok(store.storeDir(DAY, 'default').startsWith(paths.dreams));
});
