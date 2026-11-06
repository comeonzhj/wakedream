// 会话落库层：sessions / messages 两张表的读写。
// 只走 db.js 的 getDb()；字段名严格按 db.js 的 schema（snake_case），出 API 由 rowToSession 转。
import { getDb, metaSet, rowToSession } from '../db.js';

/** 全局 id：`<host>:<agent>:<nativeId>`（host 为 local / ssh:<remoteId> / lan:<remoteId>） */
export function globalId(host, agent, nativeId) {
    return `${host}:${agent}:${nativeId}`;
}

/** 会话记录（适配器产出的 camelCase 结构）→ sessions 表行 */
function toRow(id, host, source, rec) {
    return {
        id,
        native_id: rec.nativeId,
        agent: rec.agent,
        host,
        project: rec.project || 'Unknown',
        project_path: rec.projectPath ?? null,
        title: rec.title ?? '',
        cwd: rec.cwd ?? null,
        model: rec.model ?? null,
        started_at: rec.startedAt || 0,
        ended_at: rec.endedAt || rec.startedAt || 0,
        file_path: rec.filePath ?? null,
        file_mtime: rec.fileMtime ?? 0,
        file_size: rec.fileSize ?? 0,
        is_subagent: rec.isSubagent ? 1 : 0,
        parent_id: null, // 第二遍统一解析（父会话可能后落库）
        source,
        extra: JSON.stringify(rec.extra ?? {}),
        updated_at: Date.now(),
    };
}

const SESSION_COLS = [
    'id', 'native_id', 'agent', 'host', 'project', 'project_path', 'title', 'cwd', 'model',
    'started_at', 'ended_at', 'file_path', 'file_mtime', 'file_size', 'is_subagent', 'parent_id',
    'source', 'extra', 'updated_at',
];

/**
 * 写入（或更新）一条会话及其消息。messages 会被整体替换（seq 从 0 递增），
 * message_count 与 tokens 由这里统一算，避免各适配器口径不一。
 * 返回 'added' | 'updated'。
 */
export function upsertSession(host, source, rec, messages) {
    const db = getDb();
    const id = globalId(host, rec.agent, rec.nativeId);
    const existed = db.prepare('select id from sessions where id = ?').get(id);
    const row = toRow(id, host, source, rec);
    // messageCount 口径：去掉 kind='meta' 的记账行（见 ARCHITECTURE §4 注释）
    const counted = messages.filter((m) => m.kind !== 'meta').length;

    db.exec('begin');
    try {
        db.prepare(`
            insert into sessions(${SESSION_COLS.join(',')}, message_count, tokens, deleted)
            values (${SESSION_COLS.map(() => '?').join(',')}, ?, ?, 0)
            on conflict(id) do update set
                native_id = excluded.native_id,
                agent = excluded.agent,
                host = excluded.host,
                project = excluded.project,
                project_path = excluded.project_path,
                title = excluded.title,
                cwd = excluded.cwd,
                model = excluded.model,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                file_path = excluded.file_path,
                file_mtime = excluded.file_mtime,
                file_size = excluded.file_size,
                is_subagent = excluded.is_subagent,
                source = excluded.source,
                extra = excluded.extra,
                message_count = excluded.message_count,
                tokens = excluded.tokens,
                deleted = 0,
                updated_at = excluded.updated_at
        `).run(
            ...SESSION_COLS.map((c) => row[c]),
            counted,
            rec.tokens ?? null,
        );

        db.prepare('delete from messages where session_id = ?').run(id);
        const ins = db.prepare('insert into messages(session_id, seq, role, kind, ts, text, meta) values (?,?,?,?,?,?,?)');
        for (const m of messages) {
            ins.run(id, m.seq, m.role ?? null, m.kind ?? null, m.ts || 0, m.text ?? '', JSON.stringify(m.meta ?? {}));
        }
        // 父会话先落库时，子会话的 parent_id 在第二遍 resolveParentLinks 里补
        db.prepare('update sessions set parent_id = null where id = ?').run(id);
        db.exec('commit');
    } catch (err) {
        db.exec('rollback');
        throw err;
    }
    return existed ? 'updated' : 'added';
}

/** 第二遍：把 parent_native_id 解析成全局 id（父会话可能在同一轮里后落库） */
export function resolveParentLinks(host, agent, pairs) {
    const db = getDb();
    const stmt = db.prepare('update sessions set parent_id = ? where id = ?');
    let linked = 0;
    for (const { childNativeId, parentNativeId } of pairs) {
        if (!parentNativeId) continue;
        const parentId = globalId(host, agent, parentNativeId);
        const exists = db.prepare('select id from sessions where id = ?').get(parentId);
        if (!exists) continue;
        stmt.run(parentId, globalId(host, agent, childNativeId));
        linked += 1;
    }
    return linked;
}

/** 某 host 下、某 agent 的 file_path → {mtime,size}，增量扫描用来跳过没变的文件 */
export function existingFileStamps(host, agent) {
    const rows = getDb()
        .prepare('select file_path, file_mtime, file_size from sessions where host = ? and agent = ?')
        .all(host, agent);
    const map = new Map();
    for (const r of rows) if (r.file_path) map.set(r.file_path, { mtime: r.file_mtime ?? 0, size: r.file_size ?? 0 });
    return map;
}

/** 删掉某 host+agent 下 file_path 已不在 seenPaths 里的会话（数据源目录列得出来时才调用） */
export function pruneMissing(host, agent, seenPaths) {
    const db = getDb();
    const rows = db.prepare('select id, file_path from sessions where host = ? and agent = ?').all(host, agent);
    const seen = seenPaths instanceof Set ? seenPaths : new Set(seenPaths);
    let removed = 0;
    for (const r of rows) {
        if (r.file_path && seen.has(r.file_path)) continue;
        db.prepare('delete from messages where session_id = ?').run(r.id);
        db.prepare('delete from sessions where id = ?').run(r.id);
        removed += 1;
    }
    return removed;
}

/** 清空某个 host（或 host+agent）的全部会话——`?full=true` 重扫与删远端时用 */
export function clearHost(host, agent = null) {
    const db = getDb();
    const rows = agent
        ? db.prepare('select id from sessions where host = ? and agent = ?').all(host, agent)
        : db.prepare('select id from sessions where host = ?').all(host);
    for (const r of rows) {
        db.prepare('delete from messages where session_id = ?').run(r.id);
        db.prepare('delete from sessions where id = ?').run(r.id);
    }
    return rows.length;
}

export function getSessionRow(id) {
    return getDb().prepare('select * from sessions where id = ? and deleted = 0').get(id) ?? null;
}

export function getMessageRows(sessionId, { limit = 0, offset = 0 } = {}) {
    const lim = Number(limit) > 0 ? Number(limit) : -1;
    return getDb()
        .prepare('select * from messages where session_id = ? order by seq asc limit ? offset ?')
        .all(sessionId, lim, Number(offset) || 0);
}

export function getSession(id) {
    const row = getSessionRow(id);
    return row ? rowToSession(row) : null;
}

/** 批量取「首条 user 文本消息」的前 N 字，给 withPreview 用 */
export function previewsFor(sessionIds, maxChars = 200) {
    const out = new Map();
    if (!sessionIds.length) return out;
    const db = getDb();
    const stmt = db.prepare(`
        select text from messages
        where session_id = ? and role = 'user' and kind = 'text' and length(trim(text)) > 0
        order by seq asc limit 1
    `);
    for (const id of sessionIds) {
        const row = stmt.get(id);
        if (row?.text) out.set(id, String(row.text).slice(0, maxChars).replace(/\s+/g, ' ').trim());
    }
    return out;
}

export function setLastScanAt(ts = Date.now()) {
    metaSet('last_scan_at', ts);
}

/**
 * 导入一条「已经是 API 形状」的会话（局域网 bundle / 远端导出的 JSON）。
 * 与适配器路径共用同一次 upsert，所以按 id 幂等：重复拉取只会覆盖，不会重复插入。
 */
export function importSession(host, source, sessionJson, messages) {
    const rec = {
        nativeId: sessionJson.nativeId,
        agent: sessionJson.agent,
        project: sessionJson.project ?? 'Unknown',
        projectPath: sessionJson.projectPath ?? null,
        title: sessionJson.title ?? '',
        cwd: sessionJson.cwd ?? null,
        model: sessionJson.model ?? null,
        startedAt: sessionJson.startedAt ?? 0,
        endedAt: sessionJson.endedAt ?? sessionJson.startedAt ?? 0,
        tokens: sessionJson.tokens ?? null,
        filePath: null, // 远端文件路径一律不落到本机库里
        fileMtime: 0,
        fileSize: sessionJson.fileSize ?? null,
        isSubagent: !!sessionJson.isSubagent,
        parentNativeId: sessionJson.parentNativeId ?? null,
        extra: { ...(sessionJson.extra ?? {}), importedFrom: host },
    };
    const normalized = messages.map((m, i) => ({
        seq: i,
        role: m.role ?? 'system',
        kind: m.kind ?? 'text',
        ts: m.ts ?? 0,
        text: m.text ?? '',
        meta: m.meta ?? {},
    }));
    const outcome = upsertSession(host, source, rec, normalized);
    if (rec.parentNativeId) {
        resolveParentLinks(host, rec.agent, [{ childNativeId: rec.nativeId, parentNativeId: rec.parentNativeId }]);
    }
    return { outcome, id: globalId(host, rec.agent, rec.nativeId) };
}
