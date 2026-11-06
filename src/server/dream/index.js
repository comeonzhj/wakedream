// 做梦引擎主入口。归属：dream worker。
//
//   runDream({day, provider, model, dryRun, force, windowDays, maxSessions, store})
//   三阶段对齐 cookbook 的 dynamic workflow：
//     analyze（逐会话，一个会话一个 analyzer）→ organize（整轮一次收敛）→ index（_index.md + 人读报告）
//
// 安全与幂等：
//   - 只写 ~/.wakedream/memory/dreams/<day>/<store>/，先写 <store>.tmp-<pid> 再原子 rename；
//   - 永不写别家 agent 目录、永不改原始会话（对 sessions/messages 只 select）；
//   - force=false 且当天已有成功记录且没有新会话 → status='skipped'；
//   - dryRun=true 只算不落盘（不写文件、不写库）。
import fs from 'node:fs';
import path from 'node:path';
import { dayRange, fmtDay, loadConfig, paths } from '../../shared/config.js';
import { getDb, metaSet, nowTs, rowToDream, rowToSession } from '../db.js';
import { collectDaySessions } from './collect.js';
import { analyzeSessions } from './analyze.js';
import { organizeDream } from './organize.js';
import { buildMemoryFiles } from './indexer.js';
import { findPreviousManifest, listFiles, parseDoc, readFileInside, removeStoreDir, resolveInside, storeDir, writeStoreAtomic } from './store.js';
import { createProvider, ProviderError } from './providers/index.js';

const DEFAULT_MAX_SESSIONS = 60;
const DEFAULT_MAX_CHARS = 24000;

function emptyCost() {
    return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, perSession: [] };
}

function mergeCost(a, b) {
    const out = emptyCost();
    for (const src of [a, b]) {
        if (!src) continue;
        out.calls += src.calls || 0;
        out.inputTokens += src.inputTokens || 0;
        out.outputTokens += src.outputTokens || 0;
        out.totalTokens += src.totalTokens || 0;
        out.perSession.push(...(src.perSession || []));
    }
    out.totalTokens = out.totalTokens || (out.inputTokens + out.outputTokens);
    return out;
}

function makeDreamId(day, store, startedAt) {
    return `drm_${day}_${store}_${startedAt.toString(36)}`;
}

/** 组装 provider 配置：显式参数 > config.providers[name] > 环境变量（provider 内部再兜底） */
export function providerConfigFor(name, { config, model } = {}) {
    const fromConfig = config?.providers?.[name] || {};
    return {
        ...fromConfig,
        apiKey: fromConfig.apiKey,
        baseUrl: fromConfig.baseUrl,
        model: model || fromConfig.model || undefined,
        timeoutMs: fromConfig.timeoutMs,
        retries: fromConfig.retries,
    };
}

function insertDream(row) {
    getDb().prepare(
        `insert into dreams(id,day,store,status,provider,model,session_count,started_at,finished_at,memory_dir,report_path,stats,error)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
        row.id, row.day, row.store, row.status, row.provider, row.model,
        row.sessionCount, row.startedAt, row.finishedAt ?? null, row.memoryDir ?? null,
        row.reportPath ?? null, JSON.stringify(row.stats ?? {}), row.error ?? null,
    );
}

function updateDream(id, patch) {
    const fields = Object.keys(patch);
    if (!fields.length) return;
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    getDb().prepare(`update dreams set ${sets} where id = ?`).run(...fields.map((f) => patch[f]), id);
}

/** 同一 (day, store) 只保留最新一份成功记录：重跑覆盖目录，记录也替换，避免 API 读到陈旧元数据 */
function replacePreviousRuns(day, store) {
    const db = getDb();
    const rows = db.prepare("select id from dreams where day = ? and store = ? and status in ('ok','skipped','dry-run')").all(day, store);
    for (const row of rows) {
        db.prepare('delete from memory_files where dream_id = ?').run(row.id);
        db.prepare('delete from dream_inputs where dream_id = ?').run(row.id);
        db.prepare('delete from dreams where id = ?').run(row.id);
    }
}

function insertInputs(dreamId, inputs, failures) {
    const db = getDb();
    const failedIds = new Map((failures || []).map((f) => [f.sessionId, f.error]));
    const stmt = db.prepare(
        'insert into dream_inputs(dream_id, session_id, chars, notes) values (?,?,?,?) on conflict(dream_id,session_id) do update set chars = excluded.chars, notes = excluded.notes',
    );
    for (const input of inputs || []) {
        const note = failedIds.has(input.sessionId)
            ? `failed: ${failedIds.get(input.sessionId)}`
            : [input.truncated ? 'truncated' : '', `${input.messages ?? 0} messages`].filter(Boolean).join('; ');
        stmt.run(dreamId, input.sessionId, input.chars ?? 0, note || null);
    }
    // 失败但没进 inputs 的（例如渲染阶段就抛了）
    for (const [sessionId, error] of failedIds) {
        if (!(inputs || []).some((i) => i.sessionId === sessionId)) {
            stmt.run(dreamId, sessionId, 0, `failed: ${error}`);
        }
    }
}

function insertMemoryFiles(dreamId, files, updatedAt) {
    const db = getDb();
    const stmt = db.prepare(
        'insert into memory_files(dream_id, path, title, kind, source_sessions, bytes, updated_at) values (?,?,?,?,?,?,?) on conflict(dream_id,path) do update set title=excluded.title, kind=excluded.kind, source_sessions=excluded.source_sessions, bytes=excluded.bytes, updated_at=excluded.updated_at',
    );
    for (const file of files) {
        stmt.run(
            dreamId, file.path, file.title || null, file.kind || null,
            JSON.stringify(file.sourceSessions || []),
            file.bytes ?? Buffer.byteLength(file.content || '', 'utf8'),
            updatedAt,
        );
    }
}

/** 当天已有成功记录时，判断有没有「新会话」（已记录的输入之外还有会话） */
export function findNewSessions(day, store, sessions) {
    const db = getDb();
    const row = db.prepare("select id from dreams where day = ? and store = ? and status = 'ok' order by started_at desc limit 1").get(day, store);
    if (!row) return { previous: null, newSessions: sessions };
    const known = new Set(db.prepare('select session_id from dream_inputs where dream_id = ?').all(row.id).map((r) => r.session_id));
    return { previous: row.id, newSessions: sessions.filter((s) => !known.has(s.id)) };
}

function readPrior({ store, day, lookbackDays = 60 }) {
    const found = findPreviousManifest(store, day, lookbackDays);
    if (!found) return null;
    const manifest = found.manifest || {};
    return {
        day: found.day,
        dir: found.dir,
        decisions: manifest.decisions || [],
        preferences: manifest.preferences || [],
        // 上一份里「还没攒够重复次数」的偏好候选也带上来，否则跨天重复永远攒不满
        preferenceCandidates: manifest.preferenceCandidates || [],
        openQuestions: manifest.openQuestions || [],
        people: manifest.people || [],
    };
}

/**
 * 跑一次「做梦」。
 * @param {object} opts
 * @param {string} [opts.day]          YYYY-MM-DD，默认今天（本地时区自然日）
 * @param {string} [opts.provider]     heuristic | anthropic | openai-compatible
 * @param {string} [opts.model]
 * @param {boolean} [opts.dryRun]      只算不落盘（不写文件、不写库）
 * @param {boolean} [opts.force]       忽略「没有新会话」的跳过判定
 * @param {number} [opts.windowDays]   回溯天数（>1 时包含前几天的会话）
 * @param {number} [opts.maxSessions]
 * @param {string} [opts.store]
 * @param {object} [opts.config]       已加载的配置（不传则 loadConfig()）
 * @param {object} [opts.log]
 * @param {Function} [opts.onProgress] 进度回调（lead 的 SSE 会用到）
 * @returns {Promise<{dreamId:string|null,status:string,stats:object,reportPath:string|null,memoryDir:string|null,error?:string}>}
 */
export async function runDream(opts = {}) {
    const config = opts.config || loadConfig();
    const dreamCfg = config.dream || {};
    const log = opts.log || null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const dryRun = !!opts.dryRun;
    const force = !!opts.force;

    const range = dayRange(opts.day);
    const day = range.day;
    const store = String(opts.store || dreamCfg.storeName || 'default');
    const providerName = String(opts.provider || dreamCfg.provider || 'heuristic');
    const windowDays = Math.max(1, Number(opts.windowDays ?? dreamCfg.windowDays ?? 1) || 1);
    const maxSessions = Math.max(1, Number(opts.maxSessions ?? dreamCfg.maxSessions ?? DEFAULT_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS);
    const maxCharsPerSession = Math.max(1000, Number(opts.maxCharsPerSession ?? dreamCfg.maxCharsPerSession ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS);

    const startedAt = nowTs();
    const started = Date.now();
    const dir = storeDir(day, store);

    let provider;
    try {
        provider = createProvider(providerName, {
            ...providerConfigFor(providerName, { config, model: opts.model }),
            log,
        });
    } catch (err) {
        // 配置错误：明确报错，不静默降级（也不落盘）
        throw err instanceof ProviderError ? err : new ProviderError(String(err?.message || err), { code: 'E_PROVIDER' });
    }
    if (provider.requiresApiKey && !provider.hasApiKey) {
        const hint = providerName === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
        const error = new ProviderError(
            `${providerName} provider 缺少 API key（环境变量 ${hint} 或 config.providers["${providerName}"].apiKey）。`
            + '不会静默降级：请配置 key，或显式用 provider=heuristic 跑离线版。',
            { code: 'E_NO_API_KEY' },
        );
        if (!dryRun) {
            insertDream({
                id: makeDreamId(day, store, startedAt), day, store, status: 'failed', provider: providerName,
                model: provider.model, sessionCount: 0, startedAt, finishedAt: nowTs(), memoryDir: null,
                reportPath: null, stats: { error: 'missing-api-key' }, error: error.message,
            });
            error.dreamRecorded = true;
        }
        throw error;
    }

    const model = provider.model || opts.model || '';

    // ---- 收集 ----
    const collectStart = Date.now();
    const collection = collectDaySessions({ day, windowDays, maxSessions });
    const collectMs = Date.now() - collectStart;
    onProgress?.({ phase: 'collect', day, store, provider: providerName, sessions: collection.sessions.length });

    const baseStats = {
        provider: providerName,
        model,
        day,
        store,
        windowDays,
        maxSessions,
        maxCharsPerSession,
        totalBeforeTruncate: collection.totalBeforeTruncate,
        subagentCount: collection.subagentCount,
        memoryDir: dir,
        dryRun,
        window: { from: collection.from, to: collection.to },
    };

    if (!collection.sessions.length) {
        return finishSkipped({
            reason: 'no-sessions', message: `${day} 没有可整理的会话（排除子会话后为空）`,
            day, store, providerName, model, startedAt, dryRun, stats: baseStats, log,
        });
    }

    // ---- 跳过判定：当天已有成功记录且没有新会话 ----
    if (!force && !dryRun) {
        const { previous, newSessions } = findNewSessions(day, store, collection.sessions);
        if (previous && newSessions.length === 0) {
            return finishSkipped({
                reason: 'no-new-sessions',
                message: `${day}/${store} 已有成功记录（${previous}），本次没有新会话进入`,
                day, store, providerName, model, startedAt, dryRun, stats: baseStats, log,
            });
        }
    }

    // ---- analyze ----
    const analyzeStart = Date.now();
    const { analyses, failures, warnings: analyzeWarnings, cost: analyzeCost, inputs } = await analyzeSessions({
        collection,
        provider,
        cfg: { maxCharsPerSession, runPreferences: opts.runPreferences, analyzerMaxTokens: opts.analyzerMaxTokens, log },
        log,
        onProgress,
    });
    const analyzeMs = Date.now() - analyzeStart;

    const stats = {
        ...baseStats,
        sessionCount: analyses.length,
        inputCount: collection.sessions.length,
        failures,
        warnings: analyzeWarnings,
        maxSessionsTruncated: collection.truncated.map((s) => ({ id: s.id, agent: s.agent, host: s.host, startedAt: s.startedAt, title: s.title })),
        timings: { collectMs, analyzeMs: 0, organizeMs: 0, writeMs: 0, totalMs: 0 },
        degraded: {
            analyze: failures.length > 0 || analyzeWarnings.length > 0,
            organize: false,
            organizeReason: null,
            truncations: analyzeWarnings.filter((w) => w.kind === 'completion-truncated').length,
        },
        cost: emptyCost(),
    };

    if (!analyses.length) {
        const error = failures.length
            ? `全部 ${failures.length} 个会话分析失败，本次不产出记忆库：${failures[0].error}`
            : '没有任何会话被成功分析';
        const finishedAt = nowTs();
        const dreamId = makeDreamId(day, store, startedAt);
        if (!dryRun) {
            replacePreviousRuns(day, store);
            insertDream({
                id: dreamId, day, store, status: 'failed', provider: providerName, model,
                sessionCount: 0, startedAt, finishedAt, memoryDir: null, reportPath: null,
                stats, error,
            });
            insertInputs(dreamId, inputs, failures);
        }
        onProgress?.({ phase: 'done', day, store, status: 'failed', error });
        log?.error?.(`[dream] ${day}/${store} 失败：${error}`);
        return {
            dreamId: dryRun ? null : dreamId, status: 'failed', stats, reportPath: null, memoryDir: null, error,
        };
    }

    // ---- organize（含跨天累积）----
    const organizeStart = Date.now();
    const prior = opts.ignorePrior ? null : readPrior({ store, day });
    const { organized, cost: organizeCost, degraded, degradeReason } = await organizeDream({
        day, store, analyses, prior, provider,
        cfg: { runPreferences: opts.runPreferences, organizerMaxTokens: opts.organizerMaxTokens, log },
        log,
    });
    const organizeMs = Date.now() - organizeStart;
    stats.priorDay = prior?.day || null;
    stats.degraded.organize = !!degraded;
    stats.degraded.organizeReason = degradeReason;
    stats.cost = mergeCost(analyzeCost, organizeCost);
    stats.timings.analyzeMs = analyzeMs;
    stats.timings.organizeMs = organizeMs;
    onProgress?.({ phase: 'organize', day, store, projects: organized.projects?.length || 0, decisions: organized.decisions?.length || 0 });

    // ---- index（第三阶段）+ 落盘 ----
    const writeStart = Date.now();
    const { files } = buildMemoryFiles({
        day, store, organized, analyses, stats: { ...stats, memoryDir: dir }, updatedAt: Date.now(),
    });
    const fileMeta = files.map((f) => ({
        path: f.path, kind: f.kind, title: f.title,
        sourceSessions: f.sourceSessions || [], bytes: Buffer.byteLength(f.content, 'utf8'),
    }));
    // stats.files 给「数量」（CLI 直接打印就是个数），明细放 fileList
    stats.files = fileMeta.length;
    stats.fileList = fileMeta;
    stats.timings.writeMs = 0;

    const finishedAt = nowTs();
    const dreamId = makeDreamId(day, store, startedAt);
    const reportPath = path.join(dir, 'report.md');

    if (dryRun) {
        stats.timings.totalMs = Date.now() - started;
        onProgress?.({ phase: 'done', day, store, status: 'dry-run', files: files.length });
        log?.info?.(`[dream] dry-run：${day}/${store} 会产出 ${files.length} 个文件，未落盘未写库`);
        return { dreamId: null, status: 'dry-run', stats, reportPath: null, memoryDir: null, files: fileMeta };
    }

    writeStoreAtomic(dir, files);
    stats.timings.writeMs = Date.now() - writeStart;
    stats.timings.totalMs = Date.now() - started;

    // report.md 与 manifest.json 的正文里含「耗时」字段，而第一遍渲染时 writeMs/totalMs 还没算出来。
    // 落盘后用最终计时重渲染这两个文件（report 先、manifest 后——manifest 里记着 report.md 的字节数），
    // 否则报告里永远是「落盘 0ms · 合计 0ms」。
    const refreshDerivedFile = (relPath) => {
        const rebuilt = buildMemoryFiles({
            day, store, organized, analyses, stats: { ...stats, memoryDir: dir }, updatedAt: Date.now(),
        }).files.find((f) => f.path === relPath);
        if (!rebuilt) return;
        fs.writeFileSync(path.join(dir, relPath), rebuilt.content, 'utf8');
        const meta = fileMeta.find((m) => m.path === relPath);
        if (meta) meta.bytes = Buffer.byteLength(rebuilt.content, 'utf8');
    };
    refreshDerivedFile('report.md');
    refreshDerivedFile('manifest.json');
    // 注意：这里不再改动 totalMs——manifest.json 与 API/库里的 stats 必须是同一组数字，
    // 否则「报告里的耗时」和「接口返回的耗时」会差几毫秒（曾导致回归用例 22 误判）。

    // 重跑覆盖：把同一 (day, store) 的旧成功记录换成这次
    replacePreviousRuns(day, store);
    insertDream({
        id: dreamId, day, store, status: 'ok', provider: providerName, model,
        sessionCount: collection.sessions.length, startedAt, finishedAt, memoryDir: dir, reportPath, stats, error: null,
    });
    insertInputs(dreamId, inputs, failures);
    insertMemoryFiles(dreamId, fileMeta, finishedAt);
    metaSet('last_dream_at', String(finishedAt));

    onProgress?.({ phase: 'done', day, store, status: 'ok', files: files.length, dreamId });
    log?.info?.(`[dream] ${day}/${store} 完成：${analyses.length} 个会话 → ${files.length} 个文件（${dir}）`);
    return { dreamId, status: 'ok', stats, reportPath, memoryDir: dir, files: fileMeta };
}

/**
 * 跳过：**什么都不写**（不落盘、不写库），只返回状态与原因。
 * 已有成功记录时保留它，dryRun 也走这里。
 */
function finishSkipped({ reason, message, day, store, providerName, model, startedAt, dryRun, stats, log }) {
    const db = getDb();
    const previous = db.prepare(
        "select id, memory_dir from dreams where day = ? and store = ? and status = 'ok' order by started_at desc limit 1",
    ).get(day, store);
    const finalStats = {
        ...stats,
        skipReason: reason,
        sessionCount: 0,
        cost: emptyCost(),
        timings: { collectMs: 0, analyzeMs: 0, organizeMs: 0, writeMs: 0, totalMs: 0 },
    };
    log?.info?.(`[dream] 跳过：${message}`);
    return {
        dreamId: previous?.id ?? null,
        status: 'skipped',
        stats: finalStats,
        reportPath: previous?.memory_dir ? path.join(previous.memory_dir, 'report.md') : null,
        memoryDir: previous?.memory_dir ?? null,
        error: null,
        reason,
        skipped: true,
    };
}

// ---------------------------------------------------------------------------
// 查询面（契约 §6 的其余导出）
// ---------------------------------------------------------------------------

export function listDreams({ limit = 30, day = null, store = null } = {}) {
    const db = getDb();
    const clauses = [];
    const args = [];
    if (day) { clauses.push('day = ?'); args.push(day); }
    if (store) { clauses.push('store = ?'); args.push(store); }
    const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
    const rows = db.prepare(`select * from dreams ${where} order by started_at desc limit ?`).all(...args, Math.max(1, Math.min(500, Number(limit) || 30)));
    return rows.map(rowToDream);
}

export function dreamRow(id) {
    return getDb().prepare('select * from dreams where id = ?').get(id) || null;
}

/** 取一份 dream 及其输入会话；找不到返回 null */
export function getDream(id) {
    const row = dreamRow(id);
    if (!row) return null;
    const db = getDb();
    const sessionRows = db.prepare(
        `select s.* from dream_inputs di join sessions s on s.id = di.session_id where di.dream_id = ? order by s.started_at asc`,
    ).all(id);
    const inputs = sessionRows.map((r) => {
        const session = rowToSession(r);
        const note = db.prepare('select chars, notes from dream_inputs where dream_id = ? and session_id = ?').get(id, r.id);
        session.inputChars = note?.chars ?? null;
        session.inputNotes = note?.notes ?? null;
        return session;
    });
    let reportMarkdown = '';
    const reportPath = row.report_path || (row.memory_dir ? path.join(row.memory_dir, 'report.md') : null);
    if (reportPath) {
        try { reportMarkdown = fs.readFileSync(reportPath, 'utf8'); } catch { reportMarkdown = ''; }
    }
    return { dream: rowToDream(row), inputs, reportMarkdown };
}

/** 删除一次做梦的产物与记录（不动原始会话） */
export async function removeDream(id) {
    const row = dreamRow(id);
    if (!row) return { ok: false, error: 'not-found' };
    const db = getDb();
    const memoryDir = row.memory_dir;
    db.prepare('delete from memory_files where dream_id = ?').run(id);
    db.prepare('delete from dream_inputs where dream_id = ?').run(id);
    db.prepare('delete from dreams where id = ?').run(id);
    // 同一目录还被别的记录引用时不删目录
    const stillUsed = memoryDir
        ? db.prepare('select count(*) c from dreams where memory_dir = ?').get(memoryDir).c
        : 0;
    if (memoryDir && !stillUsed) {
        try { removeStoreDir(memoryDir); } catch { /* 尽力而为 */ }
    }
    return { ok: true };
}

/** 最近一次带记忆产物的 dream（/api/memory/* 不传 dreamId 时的默认） */
function latestDreamWithMemory() {
    return getDb().prepare(
        "select * from dreams where memory_dir is not null and status in ('ok','skipped') order by started_at desc limit 1",
    ).get() || null;
}

/**
 * 记忆库文件树。
 * 以**磁盘为准**（可以手改、可以拷走），frontmatter 有就用，缺了退回库里的 memory_files。
 */
export function memoryTree({ dreamId = null } = {}) {
    const row = dreamId ? dreamRow(dreamId) : latestDreamWithMemory();
    if (!row) return { root: paths.dreams, files: [] };
    const dir = row.memory_dir || storeDir(row.day, row.store);
    const files = listFiles(dir).map((file) => {
        const meta = { path: file.path, title: null, kind: null, bytes: file.bytes, updatedAt: file.updatedAt, sourceSessions: [] };
        try {
            const text = fs.readFileSync(file.absolute, 'utf8');
            const parsed = parseDoc(text);
            meta.title = parsed.fm.title || null;
            meta.kind = parsed.fm.kind || null;
            meta.sourceSessions = Array.isArray(parsed.fm.source_sessions) ? parsed.fm.source_sessions : [];
        } catch { /* 二进制或读失败：只给字节数 */ }
        if (!meta.title || !meta.sourceSessions.length) {
            const dbRow = getDb().prepare('select title, kind, source_sessions from memory_files where dream_id = ? and path = ?').get(row.id, file.path);
            if (dbRow) {
                meta.title = meta.title || dbRow.title;
                meta.kind = meta.kind || dbRow.kind;
                if (!meta.sourceSessions.length) {
                    try { meta.sourceSessions = JSON.parse(dbRow.source_sessions || '[]'); } catch { /* 忽略 */ }
                }
            }
        }
        return meta;
    });
    return { root: dir, files, dreamId: row.id, day: row.day, store: row.store };
}

/** 读一份记忆文件；越界（目录穿越）抛 MemoryPathError */
export function readMemoryFile({ path: relPath, dreamId = null } = {}) {
    const row = dreamId ? dreamRow(dreamId) : latestDreamWithMemory();
    if (!row) {
        const err = new Error('还没有任何记忆库');
        err.code = 'ENOENT';
        throw err;
    }
    const dir = row.memory_dir || storeDir(row.day, row.store);
    const resolved = resolveInside(dir, relPath);
    const { text } = readFileInside(dir, relPath);
    const parsed = parseDoc(text);
    return {
        path: resolved === dir ? '' : relPath,
        markdown: text,
        title: parsed.fm.title || null,
        kind: parsed.fm.kind || null,
        sourceSessions: Array.isArray(parsed.fm.source_sessions) ? parsed.fm.source_sessions : [],
        dreamId: row.id,
        day: row.day,
        store: row.store,
    };
}

export { parseDoc };

/** 供 scheduler / 报告使用：最近一次「真正跑过」的时间 */
export function lastRunInfo() {
    const row = getDb().prepare(
        "select id, day, status, finished_at, started_at from dreams where status in ('ok','failed') order by started_at desc limit 1",
    ).get();
    return row ? { id: row.id, day: row.day, status: row.status, at: row.finished_at ?? row.started_at } : null;
}

export { fmtDay };
