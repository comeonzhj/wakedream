// fixture 装载器：把 test/fixtures/dream/sessions.json 里的合成会话写进 sessions/messages 表。
// 归属：dream worker（测试辅助，不是产品代码）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture(name = 'sessions') {
    return JSON.parse(fs.readFileSync(path.join(HERE, `${name}.json`), 'utf8'));
}

/** 把 fixture 里某个会话的 startedLocal 平移到目标日期（用来构造跨天数据） */
export function shiftSessionToDay(session, day) {
    const [, time] = String(session.startedLocal).split('T');
    return { ...session, startedLocal: `${day}T${time || '09:00:00'}` };
}

/**
 * 写库。
 * @param {object} db getDb() 的返回
 * @param {object[]} sessions fixture 里的 sessions 数组
 * @param {{day?:string, idPrefix?:string}} [opts] day 给了就把所有会话挪到那一天
 * @returns {{ids:string[], mainIds:string[], subagentIds:string[]}}
 */
export function insertFixtureSessions(db, sessions, { day = null, idPrefix = '' } = {}) {
    const insertSession = db.prepare(
        `insert into sessions(id,native_id,agent,host,project,project_path,title,cwd,model,started_at,ended_at,
          message_count,tokens,file_path,file_size,is_subagent,parent_id,source,extra,deleted,updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    );
    const insertMessage = db.prepare(
        'insert into messages(session_id,seq,role,kind,ts,text,meta) values (?,?,?,?,?,?,?)',
    );

    const ids = [];
    const mainIds = [];
    const subagentIds = [];
    const idMap = new Map(sessions.map((s) => [s.id, `${idPrefix}${s.id}`]));

    for (const session of sessions) {
        const source = day ? shiftSessionToDay(session, day) : session;
        const id = idMap.get(session.id);
        const started = new Date(source.startedLocal).getTime();
        const ended = source.durationMs ? started + source.durationMs : null;
        const parentId = session.parentId ? (idMap.get(session.parentId) || session.parentId) : null;
        insertSession.run(
            id, source.nativeId, source.agent, source.host, source.project, source.projectPath, source.title,
            source.cwd, source.model, started, ended, source.messageCount ?? source.messages.length,
            source.tokens ?? null, `/tmp/fixtures/${id}.jsonl`, 1024,
            session.isSubagent ?? 0, parentId, source.source ?? 'local', JSON.stringify({ fixture: true }), Date.now(),
        );
        for (const message of session.messages) {
            insertMessage.run(
                id, message.seq, message.role, message.kind ?? 'text',
                started + message.seq * 1000, message.text, message.meta ? JSON.stringify(message.meta) : null,
            );
        }
        ids.push(id);
        if (session.isSubagent) subagentIds.push(id);
        else mainIds.push(id);
    }
    return { ids, mainIds, subagentIds };
}

/** 清空会话表（测试隔离用） */
export function clearSessions(db) {
    db.exec('delete from messages');
    db.exec('delete from sessions');
    db.exec('delete from dreams');
    db.exec('delete from dream_inputs');
    db.exec('delete from memory_files');
    db.exec('delete from meta');
}
