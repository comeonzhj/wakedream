// 其余 Agent 适配器：gemini / kimi / qoder / kiro。
// 每个都对齐 Wake 对应 adapter 的行语义（文件名对应 crates/wake-core/src/adapters/<x>.rs），
// 但只做「会话/消息入库」需要的那部分（不做吊销、用量统计、MCP 等）。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../jsonl.js';
import {
    cleanTitle, contentParts, decodedArguments, finalizeMessages, msg,
    projectNameOf, sessionRecord, str, titleFromMessages, tsOf,
} from './util.js';

function statOf(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0) return null;
        return { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch {
        return null;
    }
}

function toolText(name, input) {
    let args = '';
    try {
        args = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    } catch { args = ''; }
    const short = str(args).slice(0, 200);
    return short ? `${name}(${short})` : name;
}

/* ------------------------------------------------------------------ gemini */

// Gemini CLI：`~/.gemini/tmp/<projectHash>/chats/session-*.jsonl`。
// 首行是会话摘要，之后每行 `{"$set":{sessionId,messages:[...]}}` 是一次**完整快照**覆盖，
// 所以只认最后一个快照（Wake 的 gemini.rs 同判）。消息 type：user / gemini / info / error。
const GEMINI_KINDS = new Set(['user', 'gemini', 'info', 'error', 'warning']);

export const gemini = {
    id: 'gemini',
    discover(root) {
        const out = [];
        let projects;
        try {
            projects = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return out;
        }
        const push = (file, slug) => {
            const st = statOf(file);
            if (st) out.push({ filePath: file, ...st, extra: { projectHash: slug } });
        };
        for (const project of projects) {
            if (!project.isDirectory()) continue;
            const chats = path.join(root, project.name, 'chats');
            let entries;
            try {
                entries = fs.readdirSync(chats, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.jsonl')) push(path.join(chats, entry.name), project.name);
            }
        }
        return out;
    },
    parse(filePath) {
        const { rows, badLines } = readJsonl(filePath);
        let unknownLines = badLines;
        let sessionId = '';
        let projectHash = '';
        let startedAt = 0;
        let lastUpdated = 0;
        let snapshot = null;
        for (const row of rows) {
            if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
            if (row.$set && typeof row.$set === 'object') {
                snapshot = row.$set;
                continue;
            }
            if (row.checkpoint !== undefined) continue; // 记锚点，不是正文
            if (str(row.sessionId)) {
                sessionId = str(row.sessionId);
                projectHash = str(row.projectHash) || projectHash;
                startedAt = tsOf(row.startTime) || startedAt;
                lastUpdated = tsOf(row.lastUpdated) || lastUpdated;
                continue;
            }
            unknownLines += 1;
        }
        const messages = [];
        for (const m of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
            if (!m || typeof m !== 'object') continue;
            const kind = str(m.type);
            if (kind && !GEMINI_KINDS.has(kind)) unknownLines += 1;
            const parts = contentParts(m.content ?? null);
            if (!parts.text) continue;
            const ts = tsOf(m.timestamp);
            if (ts > 0) {
                if (!startedAt) startedAt = ts;
                if (ts > lastUpdated) lastUpdated = ts;
            }
            if (kind === 'user') messages.push(msg('user', 'text', ts, parts.text, {}));
            else if (kind === 'gemini') messages.push(msg('assistant', 'text', ts, parts.text, {}));
            else messages.push(msg('system', 'meta', ts, parts.text, { type: kind || 'info' }));
        }
        const finalized = finalizeMessages(messages);
        const nativeId = sessionId || str(snapshot?.sessionId) || path.basename(filePath, '.jsonl');
        const stat = statOf(filePath) ?? { mtimeMs: 0, size: 0 };
        return {
            session: sessionRecord({
                nativeId,
                agent: 'gemini',
                // transcript 里没有 cwd，只有 projectHash（Wake 同：给不出真实项目路径）
                project: projectHash || `gemini:${nativeId}`,
                projectPath: null,
                title: cleanTitle(titleFromMessages(finalized) || nativeId),
                cwd: null,
                model: null,
                startedAt: startedAt || stat.mtimeMs,
                endedAt: lastUpdated || stat.mtimeMs,
                tokens: null,
                filePath,
                fileMtime: stat.mtimeMs,
                fileSize: stat.size,
                isSubagent: false,
                parentNativeId: null,
                extra: { projectHash: projectHash || null, unknownLines },
            }),
            messages: finalized,
        };
    },
};

/* -------------------------------------------------------------------- kimi */

// Kimi Code：`~/.kimi-code/sessions/<projectSlug>/session_<id>/`，会话元数据在 state.json
// （title / isCustomTitle / createdAt / updatedAt / agents），正文在该目录 agents/<agentId>/wire.jsonl。
// agents 里 parentAgentId 非空的 agent 是子代理，挂到会话（不是会话的子会话，按 agent 处理）。
const KIMI_SKIP = new Set([
    'metadata', 'config.update', 'tools.set_active_tools', 'turn.ended', 'turn.started',
    'session.ended', 'permission.request', 'permission.response', 'state.update', 'compaction',
]);

export const kimi = {
    id: 'kimi',
    discover(root) {
        const out = [];
        let projects;
        try {
            projects = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const project of projects) {
            if (!project.isDirectory()) continue;
            const projectDir = path.join(root, project.name);
            let sessions;
            try {
                sessions = fs.readdirSync(projectDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const session of sessions) {
                if (!session.isDirectory() || !session.name.startsWith('session_')) continue;
                const sessionDir = path.join(projectDir, session.name);
                let agents;
                try {
                    agents = fs.readdirSync(path.join(sessionDir, 'agents'), { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const agent of agents) {
                    if (!agent.isDirectory()) continue;
                    const wire = path.join(sessionDir, 'agents', agent.name, 'wire.jsonl');
                    const st = statOf(wire);
                    if (st) {
                        out.push({
                            filePath: wire, ...st,
                            extra: { sessionDir, projectSlug: project.name, agentId: agent.name },
                        });
                    }
                }
            }
        }
        return out;
    },
    parse(filePath) {
        const sessionDir = path.dirname(path.dirname(path.dirname(filePath)));
        let state = {};
        try {
            state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
        } catch { state = {}; }
        const { rows, badLines } = readJsonl(filePath);
        let unknownLines = badLines;
        let createdAt = tsOf(state.createdAt);
        let updatedAt = tsOf(state.updatedAt);
        let model = null;
        const messages = [];
        const calls = new Map();

        for (const row of rows) {
            if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
            const type = str(row.type);
            if (type === 'metadata') {
                createdAt = Number(row.created_at) || createdAt;
                continue;
            }
            if (type === 'turn.prompt') {
                const input = Array.isArray(row.input) ? row.input : [];
                const texts = input.map((b) => str(b?.text)).filter((t) => t.trim());
                if (!texts.length) continue;
                const originKind = str(row.origin?.kind);
                const injected = originKind && originKind !== 'user';
                messages.push(msg('user', injected ? 'meta' : 'text', createdAt, texts.join('\n\n'), injected ? { type: originKind } : {}));
                continue;
            }
            if (type === 'context.append_message') {
                const m = row.message ?? {};
                const parts = contentParts(m.content ?? null);
                if (!parts.text) continue;
                const role = str(m.role) === 'user' ? 'user' : 'assistant';
                const mModel = str(m.model);
                if (mModel) model = mModel;
                messages.push(msg(role, role === 'user' ? 'text' : 'text', updatedAt, parts.text, {}));
                continue;
            }
            if (type === 'context.append_loop_event') {
                const ev = row.event ?? {};
                const evType = str(ev.type);
                if (evType === 'tool.call' || evType === 'tool.request') {
                    const callId = str(ev.toolCallId ?? ev.callId);
                    const name = str(ev.name ?? ev.toolName) || 'tool';
                    const input = decodedArguments(ev.arguments ?? ev.input ?? null);
                    calls.set(callId, { name, ts: updatedAt });
                    messages.push(msg('assistant', 'tool_call', updatedAt, toolText(name, input), { name, input, callId }));
                } else if (evType === 'tool.result') {
                    const callId = str(ev.toolCallId ?? ev.callId);
                    const known = calls.get(callId) ?? null;
                    const result = ev.result ?? {};
                    const raw = result.output ?? result.content ?? result.text ?? '';
                    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
                    const isError = result.isError === true || ev.isError === true;
                    const meta = { name: known?.name ?? str(ev.name) ?? '', callId, ok: !isError, output: str(text).slice(0, 8192) };
                    messages.push(msg('tool', 'tool_result', updatedAt, meta.output, meta));
                } else if (!KIMI_SKIP.has(evType)) {
                    unknownLines += 1;
                }
                continue;
            }
            if (KIMI_SKIP.has(type)) continue;
            unknownLines += 1;
        }

        const finalized = finalizeMessages(messages);
        const nativeId = path.basename(sessionDir).replace(/^session_/, '') || path.basename(sessionDir);
        const customTitle = state.isCustomTitle ? cleanTitle(state.title) : '';
        const stat = statOf(filePath) ?? { mtimeMs: 0, size: 0 };
        return {
            session: sessionRecord({
                nativeId,
                agent: 'kimi',
                project: projectOfKimi(sessionDir),
                projectPath: null,
                title: cleanTitle(customTitle || titleFromMessages(finalized) || nativeId),
                cwd: null,
                model,
                startedAt: createdAt || stat.mtimeMs,
                endedAt: updatedAt || stat.mtimeMs,
                tokens: null,
                filePath,
                fileMtime: stat.mtimeMs,
                fileSize: stat.size,
                isSubagent: false,
                parentNativeId: null,
                extra: {
                    sessionDir,
                    stateTitle: str(state.title) || null,
                    isCustomTitle: state.isCustomTitle === true,
                    agentId: path.basename(path.dirname(filePath)),
                    unknownLines,
                },
            }),
            messages: finalized,
        };
    },
};

function projectOfKimi(sessionDir) {
    const parts = sessionDir.split(path.sep);
    const sessionsIdx = parts.lastIndexOf('sessions');
    const raw = sessionsIdx >= 0 ? parts[sessionsIdx + 1] : '';
    if (!raw) return 'Unknown';
    // 目录名形如 wd_wakefx_abc123：取中间那段作为项目名，取不出就原样
    const m = /^[a-z]{2}_(.+)_[0-9a-f]{4,}$/i.exec(raw);
    return m ? m[1] : raw;
}

/* ------------------------------------------------------------------- qoder */

// Qoder CLI：`~/.qoder/projects/<slug>/<sessionId>.jsonl`（Claude 同族格式）+ `<sessionId>/subagents/*.jsonl`。
// 关键差别：文件是**树**，`active-leaf` 行指向当前分支，只有从根到该叶的链路（含共享
// message.id 的 assistant 分片与它们直接挂着的 tool_result）才是「详情里该显示的」；
// `{"leafUuid":null}` 表示已显式回退到空会话，整条会话正文为空。
const QODER_SKIP = new Set([
    'queue-operation', 'mode', 'last-prompt', 'permission-mode', 'file-history-snapshot',
    'file-history-delta', 'pr-link', 'frame-link', 'summary', 'atis-latch', 'bridge-session',
    'agent-name', 'cost-state', 'api-request', 'api-request-blob', 'api-request-shape',
    'relocated', 'worktree-state', 'active-leaf', 'runtime-config', 'custom-title', 'ai-title',
]);

function qoderIsSubagentPath(filePath) {
    return filePath.split(path.sep).includes('subagents');
}

export const qoder = {
    id: 'qoder',
    discover(root) {
        const out = [];
        let projects;
        try {
            projects = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const project of projects) {
            if (!project.isDirectory()) continue;
            const projectDir = path.join(root, project.name);
            let entries;
            try {
                entries = fs.readdirSync(projectDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    const full = path.join(projectDir, entry.name);
                    const st = statOf(full);
                    if (st) out.push({ filePath: full, ...st, extra: { projectSlug: project.name } });
                    continue;
                }
                if (!entry.isDirectory()) continue;
                const subDir = path.join(projectDir, entry.name, 'subagents');
                let subs;
                try {
                    subs = fs.readdirSync(subDir, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const sub of subs) {
                    if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
                    const full = path.join(subDir, sub.name);
                    const st = statOf(full);
                    if (st) {
                        out.push({
                            filePath: full, ...st,
                            extra: { projectSlug: project.name, parentSessionId: entry.name, isSubagent: true },
                        });
                    }
                }
            }
        }
        return out;
    },
    parse(filePath) {
        const { rows, badLines } = readJsonl(filePath);
        const subagentFile = qoderIsSubagentPath(filePath);
        let unknownLines = badLines;
        let cwd = '';
        let sessionId = '';
        let gitBranch = null;
        let customTitle = '';
        let aiTitle = '';
        let fallbackTitle = '';
        let runtimeModel = null;
        let startedAt = 0;
        let endedAt = 0;
        let tokens = 0;
        let tokensSeen = false;
        let activeLeaf = { state: 'missing' };
        let worktreePath = null;
        const nodes = new Map();
        const order = [];

        for (const row of rows) {
            if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
            const type = str(row.type);
            if (str(row.cwd) && !cwd) cwd = str(row.cwd);
            if (str(row.sessionId)) sessionId = str(row.sessionId);
            if (str(row.gitBranch)) gitBranch = str(row.gitBranch);
            if (type === 'custom-title') { if (str(row.customTitle)) customTitle = cleanTitle(str(row.customTitle)); continue; }
            if (type === 'ai-title') { if (str(row.aiTitle)) aiTitle = cleanTitle(str(row.aiTitle)); continue; }
            if (type === 'active-leaf') {
                activeLeaf = row.leafUuid === null || row.leafUuid === undefined
                    ? { state: 'empty' }
                    : { state: 'uuid', id: str(row.leafUuid) };
                continue;
            }
            if (type === 'runtime-config') {
                runtimeModel = str(row.model) || runtimeModel;
                continue;
            }
            if (type === 'relocated') { cwd = str(row.relocatedCwd) || cwd; continue; }
            if (type === 'worktree-state') {
                // 进过 worktree 也仍按会话起始的目录归项目（Wake 同口径）：只把 worktree 路径记进 extra
                const ws = row.worktreeSession;
                if (ws && typeof ws === 'object') worktreePath = str(ws.worktreePath) || worktreePath;
                continue;
            }
            if (type === 'user' || type === 'assistant' || type === 'system' || type === 'attachment') {
                if (!subagentFile && row.isSidechain === true) continue;
                const uuid = str(row.uuid);
                if (!uuid) { unknownLines += 1; continue; }
                const parent = str(row.logicalParentUuid) || str(row.parentUuid) || null;
                if (!nodes.has(uuid)) order.push(uuid);
                nodes.set(uuid, { row, parent });
                continue;
            }
            if (QODER_SKIP.has(type)) continue;
            unknownLines += 1;
        }

        // 活动链路
        let chain = [];
        if (!subagentFile) {
            if (activeLeaf.state === 'empty') {
                chain = [];
            } else {
                let cursor = activeLeaf.state === 'uuid' && nodes.has(activeLeaf.id)
                    ? activeLeaf.id
                    : order[order.length - 1];
                const seen = new Set();
                while (cursor && !seen.has(cursor)) {
                    seen.add(cursor);
                    const node = nodes.get(cursor);
                    if (!node) break;
                    chain.push(cursor);
                    cursor = node.parent;
                }
                chain.reverse();
            }
        } else {
            chain = [...order];
        }
        const chainSet = new Set(chain);
        // 同一 message.id 的 assistant 分片 + 直接挂在链路上的 tool_result 也要收
        const chainMsgIds = new Set();
        for (const id of chainSet) {
            const node = nodes.get(id);
            if (node && str(node.row.type) === 'assistant') {
                const mid = str(node.row.message?.id);
                if (mid) chainMsgIds.add(mid);
            }
        }
        const included = new Set(chainSet);
        for (const id of order) {
            const node = nodes.get(id);
            if (!node) continue;
            const t = str(node.row.type);
            if (t === 'assistant' && chainMsgIds.has(str(node.row.message?.id))) { included.add(id); continue; }
            if (t === 'user' && node.parent && included.has(node.parent)) {
                const content = node.row.message?.content;
                if (Array.isArray(content) && content.some((b) => str(b?.type) === 'tool_result')) included.add(id);
            }
        }

        // 依文件顺序产出消息，assistant 分片按 message.id 合并
        const messages = [];
        const calls = new Map();
        let pending = null;
        const flush = () => {
            if (!pending) return;
            const p = pending;
            pending = null;
            if (p.texts.length) messages.push(msg('assistant', 'text', p.ts, p.texts.join('\n\n'), {}));
            if (p.thinking.length) messages.push(msg('assistant', 'thinking', p.ts, p.thinking.join('\n\n'), {}));
            for (const t of p.tools) {
                calls.set(t.callId, { name: t.name, ts: p.ts });
                messages.push(msg('assistant', 'tool_call', p.ts, toolText(t.name, t.input), { name: t.name, input: t.input, callId: t.callId }));
            }
        };

        for (const id of order) {
            if (!included.has(id)) continue;
            const node = nodes.get(id);
            const row = node.row;
            const type = str(row.type);
            const ts = tsOf(row.timestamp);
            if (ts > 0) {
                if (!startedAt) startedAt = ts;
                if (ts > endedAt) endedAt = ts;
            }
            if (type === 'attachment') continue;
            if (type === 'system') {
                flush();
                const content = row.content ?? row.message?.content;
                const parts = contentParts(content ?? null);
                if (parts.text) messages.push(msg('system', 'meta', ts, parts.text, { type: 'system' }));
                continue;
            }
            if (type === 'user') {
                flush();
                const content = row.message?.content;
                const texts = [];
                let hadToolResult = false;
                if (typeof content === 'string') {
                    if (content.trim()) texts.push(content.trim());
                } else if (Array.isArray(content)) {
                    for (const b of content) {
                        if (!b || typeof b !== 'object') continue;
                        const bt = str(b.type);
                        if (bt === 'text') {
                            const t = str(b.text).trim();
                            if (t) texts.push(t);
                        } else if (bt === 'tool_result') {
                            hadToolResult = true;
                            const callId = str(b.tool_use_id);
                            const known = calls.get(callId) ?? null;
                            const parts = contentParts(b.content ?? null);
                            const out = parts.text.slice(0, 8192);
                            const isError = b.is_error === true;
                            const meta = { name: known?.name ?? '', callId, ok: !isError, output: out };
                            if (known && ts && known.ts && ts >= known.ts) meta.durationMs = ts - known.ts;
                            messages.push(msg('tool', 'tool_result', ts, out, meta));
                        }
                    }
                }
                const text = texts.join('\n\n').trim();
                if (!text) { void hadToolResult; continue; }
                const isMeta = row.isMeta === true;
                const kind = isMeta ? 'meta' : 'text';
                if (kind === 'text' && !fallbackTitle) fallbackTitle = cleanTitle(text);
                messages.push(msg('user', kind, ts, text, kind === 'meta' ? { type: 'meta' } : {}));
                continue;
            }
            if (type === 'assistant') {
                const message = row.message ?? {};
                const mid = str(message.id);
                if (!pending || (mid && pending.id && pending.id !== mid)) flush();
                if (!pending) pending = { id: mid || null, ts, texts: [], thinking: [], tools: [] };
                const mModel = str(message.model);
                if (mModel) runtimeModel = mModel;
                const usage = message.usage;
                if (usage && typeof usage === 'object') {
                    const sum = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'total_tokens']
                        .map((k) => Number(usage[k]) || 0).reduce((a, b) => a + b, 0);
                    if (sum > 0) { tokens += sum; tokensSeen = true; }
                }
                for (const b of Array.isArray(message.content) ? message.content : []) {
                    if (!b || typeof b !== 'object') continue;
                    const bt = str(b.type);
                    if (bt === 'text') {
                        const t = str(b.text).trim();
                        if (t) pending.texts.push(t);
                    } else if (bt === 'thinking') {
                        const t = str(b.thinking).trim();
                        if (t) pending.thinking.push(t);
                    } else if (bt === 'tool_use') {
                        pending.tools.push({
                            callId: str(b.id),
                            name: str(b.name) || 'tool',
                            input: b.input && typeof b.input === 'object' ? b.input : (b.input ?? null),
                        });
                    }
                }
                continue;
            }
        }
        flush();

        const finalized = finalizeMessages(messages);
        const parentSessionId = subagentFile ? path.basename(path.dirname(path.dirname(filePath))) : null;
        const nativeId = subagentFile
            ? (sessionId || path.basename(filePath, '.jsonl'))
            : (sessionId || path.basename(filePath, '.jsonl'));
        const stat = statOf(filePath) ?? { mtimeMs: 0, size: 0 };
        return {
            session: sessionRecord({
                nativeId,
                agent: 'qoder',
                project: projectNameOf(cwd),
                projectPath: cwd || null,
                title: cleanTitle(customTitle || aiTitle || fallbackTitle || titleFromMessages(finalized) || nativeId),
                cwd: cwd || null,
                model: runtimeModel,
                startedAt: startedAt || stat.mtimeMs,
                endedAt: endedAt || stat.mtimeMs,
                tokens: tokensSeen ? tokens : null,
                filePath,
                fileMtime: stat.mtimeMs,
                fileSize: stat.size,
                isSubagent: subagentFile,
                parentNativeId: parentSessionId,
                extra: { gitBranch, unknownLines, activeLeaf: activeLeaf.state, worktreePath },
            }),
            messages: finalized,
        };
    },
};

/* -------------------------------------------------------------------- kiro */

// Kiro：`~/.kiro/sessions/cli/<id>.jsonl`（转录）+ `<id>.json`（sidecar：标题/cwd/模型）。
// 转录行 `{kind:"Prompt"|"AssistantMessage", data:{content:[{kind:"text",data:"…"}], meta:{timestamp(秒)}}}`，
// 未知 kind 只计数（Wake 的 kiro.rs 同判）。
export const kiro = {
    id: 'kiro',
    discover(root) {
        const out = [];
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const full = path.join(root, entry.name);
            const st = statOf(full);
            if (st) out.push({ filePath: full, ...st, extra: {} });
        }
        return out;
    },
    parse(filePath) {
        let side = {};
        try {
            side = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/, '.json'), 'utf8'));
        } catch { side = {}; }
        const { rows, badLines } = readJsonl(filePath);
        let unknownLines = badLines;
        let startedAt = tsOf(side.created_at);
        let updatedAt = tsOf(side.updated_at);
        const messages = [];
        for (const row of rows) {
            if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
            const kind = str(row.kind);
            if (kind !== 'Prompt' && kind !== 'AssistantMessage') { unknownLines += 1; continue; }
            const data = row.data;
            if (!data || typeof data !== 'object') { unknownLines += 1; continue; }
            const content = Array.isArray(data.content) ? data.content : [];
            const texts = [];
            for (const b of content) {
                if (!b || typeof b !== 'object') continue;
                const bk = str(b.kind) || str(b.type);
                if (bk === 'text') {
                    const t = str(b.data ?? b.text).trim();
                    if (t) texts.push(t);
                }
            }
            if (!texts.length) continue;
            const sec = Number(data.meta?.timestamp) || 0;
            const ts = sec > 0 ? (sec < 1e12 ? sec * 1000 : sec) : 0;
            if (ts > 0) {
                if (!startedAt) startedAt = ts;
                if (ts > updatedAt) updatedAt = ts;
            }
            messages.push(msg(kind === 'Prompt' ? 'user' : 'assistant', 'text', ts, texts.join('\n\n'), {}));
        }
        const finalized = finalizeMessages(messages);
        const nativeId = str(side.session_id) || path.basename(filePath, '.jsonl');
        const model = str(side.session_state?.rts_model_state?.model_info?.model_name)
            || str(side.session_state?.rts_model_state?.model_info?.model_id) || null;
        const stat = statOf(filePath) ?? { mtimeMs: 0, size: 0 };
        return {
            session: sessionRecord({
                nativeId,
                agent: 'kiro',
                project: projectNameOf(str(side.cwd)),
                projectPath: str(side.cwd) || null,
                title: cleanTitle(str(side.title) || titleFromMessages(finalized) || nativeId),
                cwd: str(side.cwd) || null,
                model,
                startedAt: startedAt || stat.mtimeMs,
                endedAt: updatedAt || stat.mtimeMs,
                tokens: null,
                filePath,
                fileMtime: stat.mtimeMs,
                fileSize: stat.size,
                isSubagent: false,
                parentNativeId: null,
                extra: { unknownLines },
            }),
            messages: finalized,
        };
    },
};
