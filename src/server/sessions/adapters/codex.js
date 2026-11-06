// Codex CLI 适配器。语义对齐 Wake `crates/wake-core/src/adapters/codex.rs`。
//
// 布局：`<CODEX_HOME|~/.codex>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl[.zst]`
// （以及 `archived_sessions/`）。Codex 把用户线程、guardian auto-review、compaction、
// memory consolidation 与 spawn_agent 子代理写在同一棵 rollout 树里：
//   - 首行 `session_meta.payload.source` 是**对象** = 结构化来源：只有
//     `source.subagent.thread_spawn`（用户自己派出去的活）进索引，其余（review /
//     compact / memory_consolidation / internal）是噪音，整条跳过。
//   - `thread_source` 为 subagent / guardian_review / memory_consolidation 的过渡格式同样跳过。
//   - 子代理标题取 `thread_spawn.agent_path` 末段（= spawn_agent 的 task_name），
//     退回 `agent_nickname`。父子关系 Wake 走 state_5.sqlite 的登记表；本实现只用首行里
//     自带的 `parent_thread_id`（自包含、不依赖扫描顺序），取不到就不挂。
// 事件：
//   - `response_item`：message(user/assistant) / reasoning(summary_text) /
//     function_call / function_call_output / custom_tool_call(_output)。
//   - `event_msg`：只认 token_count（累计用量取最后一个）。
//   - `compacted` / `turn_context` / `session_meta` 等是记账行，不进正文。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../jsonl.js';
import { isInjectedUserContent } from './claude.js';
import {
    clip, cleanTitle, decodedArguments, finalizeMessages, msg,
    projectNameOf, sessionRecord, str, titleFromMessages, tsOf,
} from './util.js';

const AGENT = 'codex';
const MAX_TOOL_IO = 8192;

/** 去掉 `.zst`/`.zstd` 与后缀后的 rollout 名（native id 靠首行 payload.id，这里只做兜底） */
export function rolloutName(name) {
    let n = name;
    if (n.endsWith('.zstd')) n = n.slice(0, -5);
    else if (n.endsWith('.zst')) n = n.slice(0, -4);
    return n.endsWith('.jsonl') ? n : null;
}

function isRolloutFile(name) {
    return name.startsWith('rollout-') && rolloutName(name) !== null;
}

function walk(dir, depth, out, statOf) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (depth > 0) walk(full, depth - 1, out, statOf);
            continue;
        }
        if (!entry.isFile() || !isRolloutFile(entry.name)) continue;
        const st = statOf(full);
        if (st && st.size > 0) out.push({ filePath: full, ...st, extra: {} });
    }
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
    // sessions/<YYYY>/<MM>/<DD>/，archived_sessions 有时是平铺的，深度留够
    walk(root, 4, out, statOf);
    return out;
}

function threadKind(meta) {
    const payload = meta?.payload ?? {};
    const source = payload.source;
    if (source && typeof source === 'object') {
        const spawn = source.subagent?.thread_spawn;
        if (spawn) {
            const agentPath = str(spawn.agent_path);
            const task = agentPath.split('/').filter(Boolean).pop() ?? '';
            return {
                kind: 'spawned',
                parentId: str(spawn.parent_thread_id) || null,
                title: cleanTitle(task || str(spawn.agent_nickname)),
            };
        }
        return { kind: 'internal', parentId: null, title: '' };
    }
    const threadSource = str(payload.thread_source);
    if (threadSource === 'subagent' || threadSource === 'guardian_review' || threadSource === 'memory_consolidation') {
        return { kind: 'internal', parentId: null, title: '' };
    }
    return { kind: 'user', parentId: null, title: '' };
}

export function parse(filePath) {
    const { rows, badLines } = readJsonl(filePath);
    let unknownLines = badLines;
    let cwd = '';
    let model = null;
    let nativeId = '';
    let git = null;
    let title = '';
    let parentNativeId = null;
    let isSubagent = false;
    let threadKindValue = 'user';
    let originator = null;
    let startedAt = 0;
    let endedAt = 0;
    let tokens = null;
    const messages = [];
    const calls = new Map();

    for (const row of rows) {
        if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
        const ts = tsOf(row.timestamp);
        if (ts > 0) {
            if (!startedAt) startedAt = ts;
            if (ts > endedAt) endedAt = ts;
        }
        const type = str(row.type);
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};

        if (type === 'session_meta') {
            nativeId = str(payload.id) || nativeId;
            cwd = str(payload.cwd) || cwd;
            originator = str(payload.originator) || null;
            if (payload.git && typeof payload.git === 'object') git = payload.git;
            const tk = threadKind(row);
            threadKindValue = tk.kind;
            if (tk.kind === 'internal') return null; // 噪音线程：整条不进索引
            if (tk.kind === 'spawned') {
                isSubagent = true;
                parentNativeId = tk.parentId;
                title = tk.title;
            }
            continue;
        }

        if (type === 'turn_context') {
            if (str(payload.cwd)) cwd = str(payload.cwd);
            if (str(payload.model)) model = str(payload.model);
            continue;
        }

        if (type === 'event_msg') {
            if (str(payload.type) === 'token_count') {
                const info = payload.info ?? {};
                const usage = info.total_token_usage ?? info.totalTokenUsage ?? null;
                if (usage && typeof usage === 'object') {
                    const total = Number(usage.total_tokens ?? usage.totalTokens);
                    const sum = total || ['input_tokens', 'output_tokens', 'reasoning_output_tokens']
                        .map((k) => Number(usage[k]) || 0).reduce((a, b) => a + b, 0);
                    if (sum > 0) tokens = sum;
                }
            }
            continue;
        }

        if (type === 'response_item') {
            const pt = str(payload.type);
            if (pt === 'message') {
                const role = str(payload.role) === 'assistant' ? 'assistant' : 'user';
                const content = Array.isArray(payload.content) ? payload.content : [];
                const texts = [];
                let images = 0;
                for (const b of content) {
                    if (!b || typeof b !== 'object') continue;
                    const bt = str(b.type);
                    if (bt === 'input_text' || bt === 'output_text' || bt === 'text') {
                        const t = str(b.text);
                        if (t.trim()) texts.push(t.trim());
                    } else if (bt === 'input_image' || bt === 'image') {
                        images += 1;
                    }
                }
                if (!texts.length && !images) continue;
                const text = texts.join('\n\n').trim();
                if (role === 'user') {
                    const kind = isInjectedUserContent(text) ? 'meta' : 'text';
                    messages.push(msg('user', kind, ts, text, kind === 'meta' ? { type: 'injected' } : {}));
                } else {
                    messages.push(msg('assistant', 'text', ts, text, {}));
                }
                for (let i = 0; i < images; i += 1) {
                    messages.push(msg(role, 'text', ts, `[图片 ${i + 1}]`, {}));
                }
                continue;
            }
            if (pt === 'reasoning') {
                const summary = Array.isArray(payload.summary) ? payload.summary : [];
                const parts = summary.map((s) => str(s?.text)).filter((t) => t.trim());
                if (parts.length) messages.push(msg('assistant', 'thinking', ts, parts.join('\n\n'), {}));
                // encrypted_content 是密文，不解、不落库
                continue;
            }
            if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'local_shell_call') {
                const callId = str(payload.call_id ?? payload.id);
                const name = str(payload.name) || (pt === 'local_shell_call' ? 'shell' : pt);
                const input = decodedArguments(payload.arguments ?? payload.action ?? payload.input ?? null);
                calls.set(callId, { name, ts });
                messages.push(msg('assistant', 'tool_call', ts, toolText(name, input), { name, input, callId }));
                continue;
            }
            if (pt === 'function_call_output' || pt === 'custom_tool_call_output' || pt === 'local_shell_call_output') {
                const callId = str(payload.call_id ?? payload.id);
                const known = calls.get(callId) ?? null;
                const raw = payload.output ?? payload.content ?? '';
                const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
                const out = clip(text, MAX_TOOL_IO);
                const isError = payload.is_error === true || payload.status === 'error';
                const meta = { name: known?.name ?? '', callId, ok: !isError, output: out.text };
                if (known && ts && known.ts && ts >= known.ts) meta.durationMs = ts - known.ts;
                messages.push(msg('tool', 'tool_result', ts, out.text, meta));
                continue;
            }
            if (pt === 'web_search_call' || pt === 'image_generation_call' || pt === 'ghost_snapshot') continue;
            unknownLines += 1;
            continue;
        }

        if (type === 'compacted' || type === 'world_state' || type === 'inter_agent_communication_metadata') continue;
        unknownLines += 1;
    }

    const finalized = finalizeMessages(messages);
    const resolvedId = nativeId || (rolloutName(path.basename(filePath)) ?? path.basename(filePath));
    let stat = { mtimeMs: 0, size: 0 };
    try {
        const st = fs.statSync(filePath);
        stat = { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch { /* 文件被删 */ }

    return {
        session: sessionRecord({
            nativeId: resolvedId,
            agent: AGENT,
            project: projectNameOf(cwd),
            projectPath: cwd || null,
            title: cleanTitle(title || titleFromMessages(finalized) || resolvedId),
            cwd: cwd || null,
            model,
            startedAt: startedAt || stat.mtimeMs,
            endedAt: endedAt || stat.mtimeMs,
            tokens,
            filePath,
            fileMtime: stat.mtimeMs,
            fileSize: stat.size,
            isSubagent,
            parentNativeId,
            extra: {
                originator,
                gitBranch: str(git?.branch) || null,
                gitCommit: str(git?.commit_hash) || null,
                threadKind: threadKindValue,
                unknownLines,
            },
        }),
        messages: finalized,
    };
}

function toolText(name, input) {
    let args = '';
    try {
        args = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    } catch { args = ''; }
    const short = clip(args ?? '', 200).text;
    return short ? `${name}(${short})` : name;
}

export const meta = { id: AGENT, discover, parse };
