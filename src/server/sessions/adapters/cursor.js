// Cursor 适配器。语义对齐 Wake `crates/wake-core/src/adapters/cursor.rs`。
//
// 布局：`~/.cursor/projects/<项目>/agent-transcripts/<sessionId>/<sessionId>.jsonl`，
// 子代理转录在 `…/<sessionId>/subagents/<id>.jsonl`。
// 行结构：`{role, message:{content:[{type:text|tool_use}]}}`（assistant 逐块落行、无消息 id，
// 连续 assistant 行并成一条，遇 `turn_ended` 或 user 行 flush）。
// 特点：transcript 不含 cwd、不记模型；时间只藏在 user 文字块的
// `<timestamp>Saturday, Aug 01, 2026, 9:30 AM (UTC+8)</timestamp>` 壳里；
// 人打的那句话包在 `<user_query>…</user_query>` 里（没有壳就原样）。
// 只有 `{"type":"turn_ended"}` 的空壳文件（正文在 Cursor 自己的 state.vscdb 里）跳过。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../jsonl.js';
import { isInjectedUserContent } from './claude.js';
import {
    cleanTitle, finalizeMessages, msg, sessionRecord, str, titleFromMessages,
} from './util.js';

const AGENT = 'cursor';
const MAX_TOOL_IO = 8192;

function extractTag(text, tag) {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(str(text));
    return m ? m[1].trim() : null;
}

/** Cursor 的 `<timestamp>` 壳 → epoch ms：`Saturday, Aug 01, 2026, 9:30 AM (UTC+8)` */
export function cursorTs(text) {
    const raw = extractTag(text, 'timestamp');
    if (!raw) return 0;
    const cleaned = raw.replace(/\(UTC[^)]*\)/i, '').replace(/^[A-Za-z]+,\s*/, '').trim();
    const ms = Date.parse(cleaned);
    if (!Number.isNaN(ms)) return ms;
    const m = /([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(cleaned);
    if (!m) return 0;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mon = months.indexOf(m[1].toLowerCase());
    if (mon < 0) return 0;
    let hour = Number(m[4]);
    const ampm = (m[6] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const local = new Date(Number(m[3]), mon, Number(m[2]), hour, Number(m[5]), 0, 0);
    return local.getTime();
}

function userQuery(raw) {
    return extractTag(raw, 'user_query') ?? str(raw);
}

function isSubagentPath(filePath) {
    return filePath.split(path.sep).includes('subagents');
}

function sessionDirOf(filePath) {
    // <sessionId>/<file>.jsonl 或 <sessionId>/subagents/<file>.jsonl
    const dir = path.dirname(filePath);
    return path.basename(dir) === 'subagents' ? path.dirname(dir) : dir;
}

export function discover(root) {
    const out = [];
    const statOf = (p) => {
        try {
            const st = fs.statSync(p);
            return st.isFile() ? { mtimeMs: Math.round(st.mtimeMs), size: st.size } : null;
        } catch {
            return null;
        }
    };
    let projects;
    try {
        projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const project of projects) {
        if (!project.isDirectory()) continue;
        const transcripts = path.join(root, project.name, 'agent-transcripts');
        let sessions;
        try {
            sessions = fs.readdirSync(transcripts, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const session of sessions) {
            if (!session.isDirectory()) continue;
            const sessionDir = path.join(transcripts, session.name);
            const files = [];
            try {
                files.push(...fs.readdirSync(sessionDir, { withFileTypes: true })
                    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
                    .map((e) => path.join(sessionDir, e.name)));
            } catch { /* 忽略 */ }
            try {
                files.push(...fs.readdirSync(path.join(sessionDir, 'subagents'), { withFileTypes: true })
                    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
                    .map((e) => path.join(sessionDir, 'subagents', e.name)));
            } catch { /* 没有 subagents 目录 */ }
            for (const file of files) {
                const st = statOf(file);
                if (st && st.size > 0) out.push({ filePath: file, ...st, extra: { projectSlug: project.name } });
            }
        }
    }
    return out;
}

export function parse(filePath) {
    const { rows, badLines } = readJsonl(filePath);
    let unknownLines = badLines;
    let startedAt = 0;
    let endedAt = 0;
    let onlyMarker = true;
    const messages = [];
    let pending = null;

    const flush = () => {
        if (!pending) return;
        const p = pending;
        pending = null;
        if (p.texts.length) messages.push(msg('assistant', 'text', p.ts, p.texts.join('\n\n'), {}));
        for (const t of p.tools) {
            messages.push(msg('assistant', 'tool_call', p.ts, toolText(t.name, t.input), {
                name: t.name, input: t.input, callId: '',
            }));
        }
    };

    for (const row of rows) {
        if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
        const role = str(row.role);
        if (!role) {
            if (str(row.type) === 'turn_ended') { flush(); continue; }
            unknownLines += 1;
            continue;
        }
        onlyMarker = false;
        const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
        if (role === 'user') {
            flush();
            const texts = [];
            let ts = 0;
            let images = 0;
            for (const b of blocks) {
                if (!b || typeof b !== 'object') continue;
                const bt = str(b.type);
                if (bt === 'text') {
                    const raw = str(b.text);
                    const parsed = cursorTs(raw);
                    if (parsed > 0) ts = parsed;
                    const q = userQuery(raw).trim();
                    if (q) texts.push(q);
                } else if (bt === 'image') {
                    images += 1;
                }
            }
            if (!texts.length && !images) continue;
            if (ts > 0) {
                if (!startedAt) startedAt = ts;
                if (ts > endedAt) endedAt = ts;
            }
            // `<workspace>` / `<timestamp>` 之类是 Cursor 注入的上下文，归 meta、不参与标题推导
            const joined = texts.join('\n\n');
            const injected = isInjectedUserContent(joined);
            messages.push(msg('user', injected ? 'meta' : 'text', ts, joined, injected ? { type: 'injected' } : {}));
            for (let i = 0; i < images; i += 1) messages.push(msg('user', 'text', ts, `[图片 ${i + 1}]`, {}));
            continue;
        }
        if (role === 'assistant') {
            if (!pending) pending = { ts: 0, texts: [], tools: [] };
            for (const b of blocks) {
                if (!b || typeof b !== 'object') continue;
                const bt = str(b.type);
                if (bt === 'text') {
                    const t = str(b.text).trim();
                    if (t) pending.texts.push(t);
                } else if (bt === 'tool_use') {
                    pending.tools.push({
                        name: str(b.name) || 'tool',
                        input: b.input && typeof b.input === 'object' ? b.input : (b.input ?? null),
                    });
                }
            }
            continue;
        }
        unknownLines += 1;
    }
    flush();

    // 只有 turn_ended 的空壳：正文在 Cursor 的 state.vscdb 里，本实现不读库
    if (onlyMarker) return null;

    const sessionDir = sessionDirOf(filePath);
    const sessionId = path.basename(sessionDir);
    const finalized = finalizeMessages(messages);
    const subagent = isSubagentPath(filePath);
    let stat = { mtimeMs: 0, size: 0 };
    try {
        const st = fs.statSync(filePath);
        stat = { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch { /* 文件被删 */ }

    return {
        session: sessionRecord({
            nativeId: subagent ? path.basename(filePath, '.jsonl') : sessionId,
            agent: AGENT,
            // Cursor 的 transcript 不记 cwd，只有项目目录 slug；直接拿 slug 当项目名（Wake 同）
            project: sessionDir.split(path.sep).slice(-3, -2)[0] || 'Unknown',
            projectPath: null,
            title: cleanTitle(titleFromMessages(finalized) || sessionId),
            cwd: null,
            model: null,
            startedAt: startedAt || stat.mtimeMs,
            endedAt: endedAt || stat.mtimeMs,
            tokens: null,
            filePath,
            fileMtime: stat.mtimeMs,
            fileSize: stat.size,
            isSubagent: subagent,
            parentNativeId: subagent ? sessionId : null,
            extra: { projectSlug: sessionDir.split(path.sep).slice(-3, -2)[0] ?? null, unknownLines },
        }),
        messages: finalized,
    };
}

function toolText(name, input) {
    let args = '';
    try {
        args = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    } catch { args = ''; }
    const short = str(args).slice(0, 200);
    return short ? `${name}(${short})` : name;
}

export const meta = { id: AGENT, discover, parse, MAX_TOOL_IO };
