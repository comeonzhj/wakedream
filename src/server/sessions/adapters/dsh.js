// DeepSeek Harness(dsh) 适配器。语义对齐 Wake `crates/wake-core/src/adapters/dsh.rs`。
//
// 布局：`~/.dsh/sessions/<project-slug>/<session-dir>/session[.vN].jsonl[.zstd]`，一目录一会话。
// 日志名带格式代数：v0 是 `session.jsonl[.zstd]`，之后 `session.vN.jsonl[.zstd]`（N 从 1 起、无前导零）。
// dsh 迁移只新增下一代、不删旧代，所以永远读**编号最大的那一代**；同一代明文与 zstd 并存时
// mtime 新者胜、平局 .zstd 胜。
//
// 事件语义（v0–v4）：
//   - 首行 {type:"session",version,id,createdAt,cwd,isSeeded,delegationDepth,parentSession,origin}
//     给权威 id/cwd/创建时间；`origin=="subagent"` 或 `delegationDepth>0` = 子代理会话，
//     按首行 parentSession 挂到父会话下（用户自己 fork 的会话也写 parentSession，但不是子代理，不挂）。
//   - 信封顶层 `surfaceOp.op === "replace"` 的行是上下文裁剪后的替代视图，整条跳过（保留原始节点）。
//   - `user/message`：`source.kind !== "user"` 的是注入上下文（agent-instructions/plugin/...），归 meta。
//   - `assistant/message`：content 块分桶 → text / reasoning(thinking) / tool-call；
//     `usage` 的 input+output+cacheRead+cacheWrite **按调用累加**（last-wins 会只剩最后一次）。
//   - `tool/result`：v4 直接挂 `message.toolCallId`，v0–v3 包在 `message.content[0]` 里。
//   - `session/end-seed {inherited:true}` = fork 截点，之前的消息是从父会话复制的 → 折叠成一条 meta。
//   - `session/title` last-wins；`subagent/descriptor.label` 是子代理任务名；
//     `request/context.model` 是模型兜底（会被 assistant 消息的 source.model 覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../jsonl.js';
import {
    clip, cleanTitle, contentParts, decodedArguments, finalizeMessages, msg,
    projectNameOf, sessionRecord, str, titleFromMessages,
} from './util.js';

const AGENT = 'dsh';
const MAX_TOOL_IO = 8192;
const NEWEST_FORMAT = 4;

/** 日志文件名 → [代数, 是否 zstd]；不是 dsh 会话日志给 null（session.lock 等） */
export function logGeneration(name) {
    let stem = name;
    let zstd = false;
    if (stem.endsWith('.zstd')) { stem = stem.slice(0, -5); zstd = true; }
    if (!stem.endsWith('.jsonl')) return null;
    stem = stem.slice(0, -6);
    if (!stem.startsWith('session')) return null;
    const version = stem.slice('session'.length);
    if (version === '') return [0, zstd];
    if (!version.startsWith('.v')) return null;
    const digits = version.slice(2);
    if (!digits || digits.startsWith('0') || !/^\d+$/.test(digits)) return null;
    return [Number(digits), zstd];
}

function statStamp(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0) return null;
        return { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch {
        return null;
    }
}

/** 在一个会话目录里挑出该读的那一代日志（Wake 的 session_log 裁决） */
export function pickSessionLog(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    let best = null;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const gen = logGeneration(entry.name);
        if (!gen) continue;
        const full = path.join(dir, entry.name);
        const stamp = statStamp(full);
        if (!stamp) continue;
        const rank = [gen[0], stamp.mtimeMs, gen[1] ? 1 : 0];
        if (!best || compareRank(rank, best.rank) > 0) best = { rank, filePath: full, ...stamp, generation: gen[0] };
    }
    return best;
}

function compareRank(a, b) {
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/** 枚举根下两层：`<project>/<session-dir>`（不递归全树，会话目录里还有别的 artifacts） */
export function discover(root) {
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
            if (!session.isDirectory()) continue;
            const picked = pickSessionLog(path.join(projectDir, session.name));
            if (!picked) continue;
            out.push({
                filePath: picked.filePath,
                mtimeMs: picked.mtimeMs,
                size: picked.size,
                extra: { projectSlug: project.name, sessionDir: session.name },
            });
        }
    }
    return out;
}

/** 只读首行拿 header（用于列表阶段，避免整文件解析） */
export function readHeader(filePath) {
    const { rows } = readJsonl(filePath);
    const first = rows.find((r) => r && r.type === 'session');
    return first ? parseHeader(first) : null;
}

function parseHeader(v) {
    if (!v || v.type !== 'session') return null;
    const id = str(v.id);
    if (!id) return null;
    const subagent = v.origin === 'subagent' || (Number(v.delegationDepth) || 0) > 0;
    const forkedFrom = str(v.parentSession) && str(v.parentSession) !== id ? str(v.parentSession) : null;
    const seedLength = forkedFrom && Number(v.seedLength) > 0 ? Number(v.seedLength) : null;
    return {
        id,
        cwd: str(v.cwd),
        createdAt: Number(v.createdAt) || 0,
        version: Number(v.version) || 0,
        subagent,
        parent: subagent ? forkedFrom : null,
        seedLength,
        seeded: v.isSeeded === true || seedLength !== null,
        delegationDepth: Number(v.delegationDepth) || 0,
        origin: str(v.origin) || null,
        agentPreset: str(v.agentPreset) || null,
    };
}

/** 一帧一行地解析整个会话日志 */
export function parseDshLog(filePath) {
    const { rows, badLines } = readJsonl(filePath);
    const out = {
        header: null,
        title: null,
        label: null,
        model: null,
        tokens: 0,
        tokensSeen: false,
        lastTs: 0,
        messages: [],
        unknownLines: badLines,
        inherited: null,
    };
    // callId → { name, ts }，tool/result 回填用
    const calls = new Map();

    const cut = () => {
        out.inherited = out.messages.length;
        out.title = null;
        out.label = null;
        out.model = null;
        out.tokens = 0;
        out.tokensSeen = false;
    };

    for (const row of rows) {
        if (!row || typeof row !== 'object') { out.unknownLines += 1; continue; }
        const type = str(row.type);
        if (type === 'session') {
            if (Number(row.version) > NEWEST_FORMAT) out.unknownLines += 1;
            const h = parseHeader(row);
            if (h) out.header = h;
            continue;
        }
        if (row.surfaceOp && typeof row.surfaceOp === 'object' && row.surfaceOp.op === 'replace') continue;
        const ts = Number(row.time) || 0;
        if (ts > out.lastTs) out.lastTs = ts;
        const data = row.data && typeof row.data === 'object' ? row.data : {};
        const seq = Number(row.seq);
        // v0/v1 没有截点标记：第一个 seq >= 首行 seedLength 的事件起才是会话自己的
        const seedLength = out.header?.seedLength;
        if (out.inherited === null && seedLength !== null && seedLength !== undefined && Number.isFinite(seq) && seq >= seedLength) {
            cut();
        }

        if (type === 'system/message' || type === 'developer/message') {
            const parts = contentParts(data.message?.content ?? null);
            if (parts.text) {
                out.messages.push(msg('system', 'meta', ts, parts.text, {
                    type: type === 'system/message' ? 'system-prompt' : 'developer-message',
                }));
            }
            continue;
        }

        if (type === 'user/message') {
            const parts = contentParts(data.content ?? null);
            if (!parts.text) continue;
            const sourceKind = str(data.source?.kind);
            if (sourceKind && sourceKind !== 'user') {
                out.messages.push(msg('user', 'meta', ts, parts.text, { type: sourceKind }));
            } else {
                out.messages.push(msg('user', 'text', ts, parts.text, {}));
            }
            continue;
        }

        if (type === 'assistant/message') {
            const message = data.message ?? {};
            const content = Array.isArray(message.content) ? message.content : [];
            const texts = [];
            const thinking = [];
            const tools = [];
            for (const b of content) {
                if (!b || typeof b !== 'object') continue;
                const bt = str(b.type);
                if (bt === 'text') {
                    const t = str(b.text).trim();
                    if (t) texts.push(t);
                } else if (bt === 'reasoning') {
                    const t = str(b.text).trim();
                    if (t) thinking.push(t);
                } else if (bt === 'tool-call') {
                    tools.push({
                        callId: str(b.id),
                        name: str(b.name),
                        input: decodedArguments(b.arguments),
                    });
                }
            }
            const model = str(message.source?.model);
            if (model) out.model = model;
            const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
            if (usage) {
                const sum = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
                    .map((k) => Number(usage[k]) || 0)
                    .reduce((a, b) => a + b, 0);
                if (sum > 0) { out.tokens += sum; out.tokensSeen = true; }
            }
            if (out.inherited !== null && out.inherited === out.messages.length && (texts.length || thinking.length || tools.length)) {
                // 截点后的第一段回复另起一条，避免并进复制来的内容
                out.messages.push(msg('assistant', 'text', ts, '', {}));
            }
            if (texts.length) out.messages.push(msg('assistant', 'text', ts, texts.join('\n\n'), {}));
            if (thinking.length) out.messages.push(msg('assistant', 'thinking', ts, thinking.join('\n\n'), {}));
            for (const t of tools) {
                calls.set(t.callId, { name: t.name, ts });
                out.messages.push(msg('assistant', 'tool_call', ts, toolSummary(t.name, t.input), {
                    name: t.name,
                    input: t.input,
                    callId: t.callId,
                }));
            }
            continue;
        }

        if (type === 'tool/result') {
            const message = data.message ?? {};
            const block = message.toolCallId !== undefined
                ? message
                : (Array.isArray(message.content) ? message.content[0] : null) ?? {};
            const callId = str(block.toolCallId ?? block.callId ?? message.toolCallId);
            const known = calls.get(callId) ?? null;
            const parts = contentParts(block.content ?? block.output ?? null);
            const isError = block.isError === true || (data.error !== undefined && data.error !== null);
            const out8k = clip(parts.text, MAX_TOOL_IO);
            const meta = {
                name: known?.name ?? str(block.name),
                callId,
                ok: !isError,
            };
            if (out8k.text) meta.output = out8k.text;
            else meta.output = '';
            if (known && ts && known.ts && ts >= known.ts) meta.durationMs = ts - known.ts;
            out.messages.push(msg('tool', 'tool_result', ts, out8k.text, meta));
            continue;
        }

        if (type === 'session/end-seed') {
            if (data.inherited === true) cut();
            continue;
        }

        if (type === 'subagent/descriptor') {
            if (!out.label) {
                const label = str(data.label);
                if (label) out.label = cleanTitle(label);
            }
            continue;
        }

        if (type === 'session/title') {
            const t = str(data.title);
            if (t) out.title = cleanTitle(t);
            continue;
        }

        if (type === 'request/context') {
            if (!out.model && str(data.model)) out.model = str(data.model);
            continue;
        }

        if (row.ignorable === true) continue;
        // 其余已知事件（turn/step/tool-call 冗余行等）不产生正文，未知名只计数
        if (!KNOWN_EVENTS.has(type)
            && !LEGACY_EVENTS.has(type)
            && !KNOWN_PREFIXES.some((p) => type.startsWith(p))) out.unknownLines += 1;
    }

    // fork 截点：之前的消息是从父会话原样复制来的，折叠成一条说明（Wake 的 collapse_inherited）
    if (out.inherited !== null && out.inherited > 0) {
        const folded = out.messages.slice(0, out.inherited);
        const rest = out.messages.slice(out.inherited);
        out.messages = [
            msg('system', 'meta', folded[0]?.ts ?? 0, `（从父会话继承的 ${folded.length} 条消息已折叠）`, { type: 'fork-seed', count: folded.length }),
            ...rest,
        ];
    }
    return out;
}

/**
 * 上游词汇表的运行时补充：本机真实数据（2026-11 的 dsh）里已经出现、但 Wake 那份
 * `KNOWN_SESSION_EVENT_TYPES` 快照里还没有的名字。按前缀放行，避免 unknownLines 被
 * 这类纯记账事件刷满、丢掉「schema 漂移金丝雀」的意义。
 */
const KNOWN_PREFIXES = ['job/'];

function toolSummary(name, input) {
    let args = '';
    try {
        args = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    } catch {
        args = '';
    }
    const short = clip(args ?? '', 200).text;
    return short ? `${name}(${short})` : name;
}

export function parse(filePath) {
    const parsed = parseDshLog(filePath);
    const stat = statStamp(filePath) ?? { mtimeMs: 0, size: 0 };
    const header = parsed.header;
    const nativeId = header?.id || path.basename(path.dirname(filePath));
    const cwd = header?.cwd ?? '';
    const messages = finalizeMessages(parsed.messages);
    const title = (parsed.title && parsed.title)
        || (parsed.label && parsed.label)
        || titleFromMessages(messages)
        || nativeId;
    const startedAt = header?.createdAt || stat.mtimeMs;
    const endedAt = parsed.lastTs || stat.mtimeMs;
    return {
        session: sessionRecord({
            nativeId,
            agent: AGENT,
            project: projectNameOf(cwd),
            projectPath: cwd || null,
            title: cleanTitle(title),
            cwd: cwd || null,
            model: parsed.model,
            startedAt,
            endedAt,
            tokens: parsed.tokensSeen ? parsed.tokens : null,
            filePath,
            fileMtime: stat.mtimeMs,
            fileSize: stat.size,
            isSubagent: !!header?.subagent,
            parentNativeId: header?.parent ?? null,
            extra: {
                formatVersion: header?.version ?? null,
                isSeeded: !!header?.seeded,
                delegationDepth: header?.delegationDepth ?? 0,
                origin: header?.origin ?? null,
                agentPreset: header?.agentPreset ?? null,
                unknownLines: parsed.unknownLines,
            },
        }),
        messages,
    };
}

/** dsh 已知事件词汇（照抄上游 KNOWN_SESSION_EVENT_TYPES；上面已处理的不会走到这里） */
const KNOWN_EVENTS = new Set([
    'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
    'assistant/attempt', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
    'compaction/start', 'compaction/summary', 'deliverables/presented', 'developer/message', 'feedback/message-delete',
    'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'image/offload',
    'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context',
    'request/header', 'sandbox/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted', 'session/end-seed',
    'session/title', 'session/title-llm-request', 'step/end', 'step/start', 'subagent/catalog', 'subagent/descriptor',
    'subagent/model-selection-policy', 'system/message', 'team/member', 'team/message/delivered', 'team/message/queued',
    'team/task', 'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
    'tool-workflow/run-start', 'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/result', 'turn/end',
    'turn/start', 'user/message', 'web/deepseek-search-llm-request', 'workspace/changes',
]);

const LEGACY_EVENTS = new Set([
    'assistant/chunk', 'text-chunks', 'reasoning-chunks', 'tool-call-chunks',
    'tool/code-dispatch', 'tool/code-dispatch-start',
]);

export const meta = {
    id: AGENT,
    discover,
    parse,
};
