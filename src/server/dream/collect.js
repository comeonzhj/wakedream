// 会话收集层：按「本地时区自然日」把 sessions/messages 取出来，供给做梦的三阶段。
// 归属：dream worker。
//
// 约定（与 ARCHITECTURE.md §4 / 任务书一致）：
//   - 只读 `sessions` / `messages` 两张表，**不 import sessions worker 的任何模块**，避免并行冲突。
//   - 默认排除 `is_subagent=1` 的子会话；子会话内容折叠进父会话，而不是单独分析。
//   - 按 agent 分组、按时间排序；maxSessions 截断时保留最近的会话并在报告里写明丢了哪些。
import { dayRange } from '../../shared/config.js';
import { getDb, rowToMessage, rowToSession } from '../db.js';

export const DAY_MS = 24 * 3600 * 1000;

/**
 * 收集 `day` 当天的会话（windowDays>1 时向前回溯若干自然日）。
 * @returns {{day:string, from:number, to:number, windowDays:number,
 *            sessions:object[], byAgent:Record<string,object[]>,
 *            totalBeforeTruncate:number, truncated:object[], subagentCount:number}}
 */
export function collectDaySessions({ day, windowDays = 1, maxSessions = 60, agent = null } = {}) {
    const days = Math.max(1, Math.floor(Number(windowDays) || 1));
    const range = dayRange(day);
    const to = range.end.getTime();
    const from = range.start.getTime() - (days - 1) * DAY_MS;
    const db = getDb();

    const rows = db.prepare(
        `select * from sessions
          where coalesce(deleted,0) = 0
            and coalesce(is_subagent,0) = 0
            and started_at is not null
            and started_at >= ? and started_at <= ?
          order by started_at asc`,
    ).all(from, to);

    const filtered = agent ? rows.filter((r) => r.agent === agent) : rows;

    // 子会话：只用于折叠进父会话，不单独分析
    const childRows = db.prepare(
        `select * from sessions
          where coalesce(deleted,0) = 0
            and coalesce(is_subagent,0) = 1
            and started_at is not null
            and started_at >= ? and started_at <= ?
          order by started_at asc`,
    ).all(from, to);
    const childrenByParent = new Map();
    for (const row of childRows) {
        if (!row.parent_id) continue;
        if (!childrenByParent.has(row.parent_id)) childrenByParent.set(row.parent_id, []);
        childrenByParent.get(row.parent_id).push(row);
    }

    const total = filtered.length;
    let kept = filtered;
    let truncated = [];
    const cap = Math.max(1, Math.floor(Number(maxSessions) || 60));
    if (filtered.length > cap) {
        // 保留最近 cap 个（近的更有价值），再按时间正序还给下游
        const recent = filtered.slice(filtered.length - cap);
        const keptIds = new Set(recent.map((r) => r.id));
        truncated = filtered.filter((r) => !keptIds.has(r.id)).map((r) => rowToSession(r));
        kept = recent;
    }

    const sessions = kept.map((row) => {
        const session = rowToSession(row);
        session.dateKey = localDayKey(row.started_at);
        return session;
    });

    const byAgent = {};
    for (const session of sessions) {
        const key = session.agent || 'unknown';
        if (!byAgent[key]) byAgent[key] = [];
        byAgent[key].push(session);
    }

    return {
        day: range.day,
        from,
        to,
        windowDays: days,
        sessions,
        byAgent,
        totalBeforeTruncate: total,
        truncated,
        subagentCount: childRows.length,
        _childrenByParent: childrenByParent,
    };
}

/** 取一个会话的全部消息（已按 seq 正序） */
export function loadMessages(sessionId, { maxRows = 20000 } = {}) {
    const db = getDb();
    const rows = db.prepare(
        'select * from messages where session_id = ? order by seq asc limit ?',
    ).all(sessionId, maxRows);
    return rows.map(rowToMessage);
}

/** 取某个会话的子会话（含消息），用于折叠进父会话摘要 */
export function loadSubagents(collection, parentId, { maxSubagents = 8 } = {}) {
    const rows = (collection._childrenByParent?.get(parentId)) || [];
    return rows.slice(0, maxSubagents).map((row) => ({
        session: rowToSession(row),
        messages: loadMessages(row.id),
    }));
}

/** 本地时区的 YYYY-MM-DD */
export function localDayKey(ms) {
    const d = new Date(Number(ms) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区的 HH:MM */
export function localTimeKey(ms) {
    const d = new Date(Number(ms) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
