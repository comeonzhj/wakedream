// 真机验证用的一次性入库脚本（**不是产品代码**）。
//
// 为什么存在：dream worker 按契约只读 `sessions`/`messages` 两张表，不 import sessions worker 的模块；
// 真机验证时若 sessions worker 还没扫描入库，就用这个脚本把 `~/.dsh/sessions/**` 的真实 dsh 会话
// 解析进库，让 runDream 跑在真实数据上。
//
// 用法：
//   node test/fixtures/dream/ingest-real.mjs [--home ~/.dsh/sessions] [--dry]
//
// 实现要点（自己实现，不依赖 sessions worker）：
//   - dsh 的 `session.v4.jsonl.zstd` 是**多帧连接**：扫 zstd 魔数 → 逐帧解 → 顺序拼接；
//   - 会话 id 按契约拼成 `<host>:<agent>:<native_id>`（host=local，agent=dsh）；
//   - `parentSession` 存在 → is_subagent=1 且 parent_id 指向父会话；
//   - upsert（on conflict(id) do update），重复跑不会产生重复行；**不删任何数据**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_TEXT = 20000;   // 单条消息入库上限（超出截断并标注）
const MAX_RESULT = 8000;  // 工具结果入库上限

/** 多帧 zstd：逐帧解压（Node 的 zstdDecompressSync 只解第一帧） */
function decompressZstd(buf) {
    const offsets = [];
    let at = 0;
    while ((at = buf.indexOf(ZSTD_MAGIC, at)) !== -1) { offsets.push(at); at += ZSTD_MAGIC.length; }
    const parts = [];
    for (const offset of offsets) {
        let out;
        try { out = zlib.zstdDecompressSync(buf.subarray(offset)); } catch { continue; }  // 半写帧跳过
        if (!out.length) continue;
        const text = out.toString('utf8');
        const trimmed = text.replace(/^\s+/, '');
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
        parts.push(text);
    }
    return parts.join('');
}

function cap(text, max) {
    const s = String(text ?? '');
    return s.length <= max ? s : `${s.slice(0, max)}\n…[入库时截断，原 ${s.length} 字符]`;
}

function blocksText(content) {
    if (!Array.isArray(content)) return { text: typeof content === 'string' ? content : '', thinking: '' };
    const texts = [];
    const think = [];
    for (const block of content) {
        if (!block) continue;
        if (block.type === 'text') texts.push(block.text || '');
        else if (block.type === 'reasoning' || block.type === 'thinking') think.push(block.text || '');
        else if (block.type === 'tool_use') texts.push(`[tool_use ${block.name || ''}] ${JSON.stringify(block.input ?? {})}`);
    }
    return { text: texts.join('\n').trim(), thinking: think.join('\n').trim() };
}

/** 解析一个 dsh 会话文件 → {session, messages} */
export function parseDshSession(filePath) {
    const raw = decompressZstd(fs.readFileSync(filePath));
    const events = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* 半写行 */ }
    }
    const header = events.find((e) => e.type === 'session');
    if (!header) return null;

    const nativeId = header.id;
    const id = `local:dsh:${nativeId}`;
    const agent = 'dsh';
    const host = 'local';
    let title = '';
    let model = null;
    let messages = [];
    const callNames = new Map();
    let lastTime = header.createdAt || null;
    const eventSeqs = events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
    const toolEvents = events.filter((e) => e.type === 'tool/call');

    let seq = 0;
    for (const event of events) {
        if (event.time) lastTime = Math.max(lastTime || 0, event.time);
        switch (event.type) {
            case 'session/title':
                title = event.data?.title || title;
                break;
            case 'model/selection':
                model = event.data?.model || model;
                break;
            case 'user/message': {
                const { text } = blocksText(event.data?.content);
                if (text) messages.push({ seq: seq++, role: 'user', kind: 'text', ts: event.time ?? null, text: cap(text, MAX_TEXT), meta: null });
                break;
            }
            case 'system/message': {
                const { text } = blocksText(event.data?.message?.content);
                if (text) messages.push({ seq: seq++, role: 'system', kind: 'text', ts: event.time ?? null, text: cap(text, MAX_TEXT), meta: null });
                break;
            }
            case 'assistant/message': {
                const { text, thinking } = blocksText(event.data?.message?.content);
                if (thinking) messages.push({ seq: seq++, role: 'assistant', kind: 'thinking', ts: event.time ?? null, text: cap(thinking, MAX_RESULT), meta: null });
                if (text) messages.push({ seq: seq++, role: 'assistant', kind: 'text', ts: event.time ?? null, text: cap(text, MAX_TEXT), meta: null });
                break;
            }
            case 'tool/call': {
                const name = event.data?.name || 'tool';
                if (event.data?.callId) callNames.set(event.data.callId, name);
                messages.push({
                    seq: seq++, role: 'assistant', kind: 'tool_call', ts: event.time ?? null,
                    text: cap(event.data?.arguments ?? '', MAX_TEXT),
                    meta: JSON.stringify({ name, callId: event.data?.callId ?? null }),
                });
                break;
            }
            case 'tool/result': {
                const msg = event.data?.message || {};
                const { text } = blocksText(msg.content);
                messages.push({
                    seq: seq++, role: 'tool', kind: 'tool_result', ts: event.time ?? null,
                    text: cap(text, MAX_RESULT),
                    meta: JSON.stringify({ name: callNames.get(msg.toolCallId) || 'tool', callId: msg.toolCallId ?? null, isError: !!msg.isError }),
                });
                break;
            }
            default:
                break;
        }
    }
    // 有些事件没有 message 事件，但 tool/call 太多会让 seq 很不连续；保持入库 seq 连续即可
    messages = messages.map((m, i) => ({ ...m, seq: i }));

    const cwd = header.cwd || null;
    return {
        session: {
            id,
            native_id: nativeId,
            agent,
            host,
            project: cwd ? path.basename(cwd) : 'Unknown',
            project_path: cwd,
            title: title || '(无标题)',
            cwd,
            model,
            started_at: header.createdAt ?? null,
            ended_at: lastTime,
            message_count: messages.length,
            tokens: null,
            file_path: filePath,
            file_mtime: fs.statSync(filePath).mtimeMs,
            file_size: fs.statSync(filePath).size,
            is_subagent: header.parentSession ? 1 : 0,
            parent_id: header.parentSession ? `local:dsh:${header.parentSession}` : null,
            source: 'local',
            extra: JSON.stringify({
                agentPreset: header.agentPreset ?? null,
                delegationDepth: header.delegationDepth ?? null,
                version: header.version ?? null,
                eventSeqs: eventSeqs.length,
                toolCalls: toolEvents.length,
            }),
            updated_at: Date.now(),
        },
        messages,
    };
}

/** 扫描 ~/.dsh/sessions 下的全部 session.v4.jsonl.zstd */
export function findDshSessions(root) {
    const out = [];
    const walk = (dir, depth = 0) => {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.isFile() && entry.name.startsWith('session.') && entry.name.includes('.jsonl')) out.push(full);
        }
    };
    walk(root);
    return out.sort();
}

export function ingest({ sessionsRoot, dbPath, dry = false, log = console } = {}) {
    const files = findDshSessions(sessionsRoot);
    const db = new DatabaseSync(dbPath);
    db.exec('pragma busy_timeout = 5000');
    const upsertSession = db.prepare(
        `insert into sessions(id,native_id,agent,host,project,project_path,title,cwd,model,started_at,ended_at,
           message_count,tokens,file_path,file_mtime,file_size,is_subagent,parent_id,source,extra,deleted,updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
         on conflict(id) do update set
           title=excluded.title, started_at=excluded.started_at, ended_at=excluded.ended_at,
           message_count=excluded.message_count, file_path=excluded.file_path, file_mtime=excluded.file_mtime,
           file_size=excluded.file_size, is_subagent=excluded.is_subagent, parent_id=excluded.parent_id,
           project=excluded.project, project_path=excluded.project_path, model=excluded.model,
           extra=excluded.extra, updated_at=excluded.updated_at`,
    );
    const deleteMessages = db.prepare('delete from messages where session_id = ?');
    const insertMessage = db.prepare('insert into messages(session_id,seq,role,kind,ts,text,meta) values (?,?,?,?,?,?,?)');

    const summary = { scanned: 0, sessions: 0, messages: 0, skipped: [], days: {} };
    for (const file of files) {
        summary.scanned += 1;
        let parsed = null;
        try { parsed = parseDshSession(file); } catch (err) { summary.skipped.push([file, err.message]); continue; }
        if (!parsed) { summary.skipped.push([file, '没有 session 头']); continue; }
        const s = parsed.session;
        const day = s.started_at ? new Date(s.started_at).toISOString().slice(0, 10) : 'unknown';
        summary.days[day] = (summary.days[day] || 0) + 1;
        if (dry) continue;
        upsertSession.run(
            s.id, s.native_id, s.agent, s.host, s.project, s.project_path, s.title, s.cwd, s.model,
            s.started_at, s.ended_at, s.message_count, s.tokens, s.file_path, s.file_mtime, s.file_size,
            s.is_subagent, s.parent_id, s.source, s.extra, s.updated_at,
        );
        deleteMessages.run(s.id);
        for (const m of parsed.messages) insertMessage.run(s.id, m.seq, m.role, m.kind, m.ts, m.text, m.meta);
        summary.sessions += 1;
        summary.messages += parsed.messages.length;
    }
    db.close();
    return summary;
}

function main() {
    const args = process.argv.slice(2);
    const homeIdx = args.indexOf('--home');
    const sessionsRoot = homeIdx >= 0 ? args[homeIdx + 1] : path.join(os.homedir(), '.dsh', 'sessions');
    const dry = args.includes('--dry');
    const dbPath = process.env.WAKEDREAM_DB || path.join(process.env.WAKEDREAM_HOME || path.join(os.homedir(), '.wakedream'), 'db.sqlite');
    console.log(`扫描 ${sessionsRoot} → ${dbPath}${dry ? '（dry-run）' : ''}`);
    const summary = ingest({ sessionsRoot, dbPath, dry });
    console.log(`文件 ${summary.scanned} 个，入库会话 ${summary.sessions} 个，消息 ${summary.messages} 条`);
    console.log(`按天分布：${JSON.stringify(summary.days, null, 2)}`);
    if (summary.skipped.length) console.log(`跳过 ${summary.skipped.length} 个：${JSON.stringify(summary.skipped.slice(0, 5))}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
