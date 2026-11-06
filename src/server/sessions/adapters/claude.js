// Claude Code 适配器。语义对齐 Wake `crates/wake-core/src/adapters/claude.rs`。
//
// 布局：`<CLAUDE_CONFIG_DIR|~/.claude>/projects/<项目 slug>/<sessionId>.jsonl`，
// 子代理转录在 `<项目 slug>/<sessionId>/subagents/agent-*.jsonl`
// （同目录的 `agent-*.meta.json` 给 agentType / description / toolUseId）。
//
// 行语义：
//   - `isSidechain: true` 的行是内联分支（agent 派出去的工作）；读主转录时跳过，
//     子代理转录文件本身就是它们，照读。
//   - `custom-title` 行（`customTitle`）> `ai-title` 行（`aiTitle`）> 第一条用户提问 = 标题。
//   - `isMeta` / `isCompactSummary` / 注入型内容（`<environment_context`、`Caveat:` 等）归 meta，
//     不参与标题推导。
//   - assistant 内容块 text/thinking/tool_use 分桶；`message.usage` 四项累加计 token；
//     `model == "<synthetic>"` 是系统合成消息的占位，不当模型。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../jsonl.js';
import {
    clip, cleanTitle, contentParts, finalizeMessages, msg,
    projectNameOf, sessionRecord, str, titleFromMessages, tsOf,
} from './util.js';

const AGENT = 'claude-code';
const MAX_TOOL_IO = 8192;

/** 与正文无关的记账行（Wake 的 KNOWN_SKIP_TYPES） */
const SKIP_TYPES = new Set([
    'queue-operation', 'mode', 'last-prompt', 'permission-mode', 'file-history-snapshot',
    'file-history-delta', 'pr-link', 'frame-link', 'attachment', 'summary', 'atis-latch',
    'bridge-session', 'agent-name', 'cost-state', 'api-request', 'api-request-blob',
    'api-request-shape', 'relocated', 'worktree-state',
]);

const INJECTED_PREFIXES = [
    '<recommended_plugins', '<environment_context', '<user_action', '<user_instructions',
    '<permissions', '<workspace', '<system-', '<context ', '<session_context',
    'IMPORTANT: Do NOT read', 'Caveat: The messages below', '# Files pasted by the user',
    '# Files mentioned by the user', '## Referenced ChatGPT conversation',
    '# AGENTS.md instructions', '<task-notification', 'The following is the Codex agent history',
];

export function isInjectedUserContent(text) {
    const t = str(text).trimStart();
    return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

function isSubagentPath(filePath) {
    const parts = filePath.split(path.sep);
    const i = parts.lastIndexOf('subagents');
    return i > 0;
}

/** 子代理转录所属的父会话 id（`…/<sessionId>/subagents/x.jsonl`） */
function subagentParentId(filePath) {
    const parts = filePath.split(path.sep);
    const i = parts.lastIndexOf('subagents');
    return i > 0 ? parts[i - 1] : null;
}

export function discover(root) {
    const out = [];
    let projects;
    try {
        projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }
    const statOf = (p) => {
        try {
            const st = fs.statSync(p);
            return st.isFile() ? { mtimeMs: Math.round(st.mtimeMs), size: st.size } : null;
        } catch {
            return null;
        }
    };
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
                if (st && st.size > 0) {
                    out.push({
                        filePath: full, ...st,
                        extra: { projectSlug: project.name, nativeId: entry.name.slice(0, -6) },
                    });
                }
            }
        }
        // 子代理转录：<sessionId>/subagents/*.jsonl
        for (const entry of entries) {
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
                if (st && st.size > 0) {
                    out.push({
                        filePath: full, ...st,
                        extra: {
                            projectSlug: project.name,
                            parentSessionId: entry.name,
                            nativeId: sub.name.slice(0, -6),
                            isSubagent: true,
                        },
                    });
                }
            }
        }
    }
    return out;
}

function readSubagentMeta(filePath) {
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return {
            agentType: str(raw.agentType) || null,
            description: str(raw.description) || null,
            toolUseId: str(raw.toolUseId) || null,
        };
    } catch {
        return { agentType: null, description: null, toolUseId: null };
    }
}

export function parse(filePath) {
    const { rows, badLines } = readJsonl(filePath);
    const subagent = isSubagentPath(filePath);
    const subMetaFile = subagent ? readSubagentMeta(filePath) : null;

    let cwd = '';
    let model = null;
    let customTitle = null;
    let aiTitle = null;
    let fallbackTitle = '';
    let startedAt = 0;
    let endedAt = 0;
    let tokens = 0;
    let tokensSeen = false;
    let unknownLines = badLines;
    let sessionId = '';
    let gitBranch = null;
    const messages = [];

    // pending assistant：同一个 message.id 的连续行合并成一条（分块流式写入）
    let pending = null;
    const calls = new Map();

    const flush = () => {
        if (!pending) return;
        const p = pending;
        pending = null;
        if (p.texts.length) messages.push(msg('assistant', 'text', p.ts, p.texts.join('\n\n'), {}));
        if (p.thinking.length) messages.push(msg('assistant', 'thinking', p.ts, p.thinking.join('\n\n'), {}));
        for (const t of p.tools) {
            calls.set(t.callId, { name: t.name, ts: p.ts });
            messages.push(msg('assistant', 'tool_call', p.ts, toolText(t.name, t.input), {
                name: t.name, input: t.input, callId: t.callId,
            }));
        }
    };

    for (const row of rows) {
        if (!row || typeof row !== 'object') { unknownLines += 1; continue; }
        const type = str(row.type);
        if (SKIP_TYPES.has(type)) continue;
        if (type === 'custom-title') {
            const t = str(row.customTitle).trim();
            if (t) customTitle = cleanTitle(t);
            continue;
        }
        if (type === 'ai-title') {
            const t = str(row.aiTitle).trim();
            if (t) aiTitle = cleanTitle(t);
            continue;
        }
        if (str(row.cwd)) cwd = str(row.cwd);
        if (str(row.sessionId)) sessionId = str(row.sessionId);
        if (str(row.gitBranch)) gitBranch = str(row.gitBranch);
        const ts = tsOf(row.timestamp);
        if (ts > 0) {
            if (!startedAt) startedAt = ts;
            if (ts > endedAt) endedAt = ts;
        }
        if (row.isSidechain === true && !subagent) continue;

        const message = row.message;
        if (type === 'system') {
            flush();
            const subtype = str(row.subtype);
            if (subtype === 'compact_boundary') {
                messages.push(msg('system', 'meta', ts, '── 上下文已压缩 ──', { type: 'compact-boundary' }));
            } else if (str(row.content)) {
                const out = clip(str(row.content), MAX_TOOL_IO);
                messages.push(msg('system', 'meta', ts, out.text, { type: 'system' }));
            }
            continue;
        }

        if (type === 'user') {
            flush();
            if (!message || typeof message !== 'object') continue;
            const content = message.content;
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
                        const out = clip(parts.text, MAX_TOOL_IO);
                        const isError = b.is_error === true;
                        const meta = {
                            name: known?.name ?? '',
                            callId,
                            ok: !isError,
                            output: out.text,
                        };
                        if (known && ts && known.ts && ts >= known.ts) meta.durationMs = ts - known.ts;
                        messages.push(msg('tool', 'tool_result', ts, out.text, meta));
                    }
                }
            }
            const text = texts.join('\n\n').trim();
            if (!text) { void hadToolResult; continue; }
            const isMeta = row.isMeta === true;
            const isCompact = row.isCompactSummary === true;
            const injected = isInjectedUserContent(text);
            const kind = isCompact || isMeta || injected ? 'meta' : 'text';
            if (kind === 'text' && !fallbackTitle) fallbackTitle = cleanTitle(text);
            const clipped = clip(text, MAX_TOOL_IO * 3);
            messages.push(msg('user', kind, ts, clipped.text, kind === 'meta'
                ? { type: isCompact ? 'compact-summary' : (isMeta ? 'meta' : 'injected') }
                : {}));
            continue;
        }

        if (type === 'assistant') {
            if (!message || typeof message !== 'object') continue;
            const msgId = str(message.id);
            if (!pending || (msgId && pending.id && pending.id !== msgId)) flush();
            if (!pending) pending = { id: msgId || null, ts, texts: [], thinking: [], tools: [] };
            if (!pending.id && msgId) pending.id = msgId;
            const m = str(message.model);
            if (m && m !== '<synthetic>') model = m;
            const usage = message.usage;
            if (usage && typeof usage === 'object') {
                const sum = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
                    .map((k) => Number(usage[k]) || 0)
                    .reduce((a, b) => a + b, 0);
                if (sum > 0) { tokens += sum; tokensSeen = true; }
            }
            const content = Array.isArray(message.content) ? message.content : [];
            for (const b of content) {
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
                        name: str(b.name),
                        input: b.input && typeof b.input === 'object' ? b.input : (b.input ?? null),
                    });
                }
            }
            continue;
        }

        if (type === 'result' || type === 'system-error') continue;
        unknownLines += 1;
    }
    flush();

    const nativeId = subagent
        ? (sessionId || path.basename(filePath, '.jsonl'))
        : path.basename(filePath, '.jsonl');
    const parentNativeId = subagent ? (subagentParentId(filePath) ?? null) : null;
    const finalized = finalizeMessages(messages);
    const subTitle = subMetaFile?.description ? cleanTitle(subMetaFile.description) : '';
    const title = subagent
        ? (subTitle || titleFromMessages(finalized) || nativeId)
        : (customTitle || aiTitle || fallbackTitle || titleFromMessages(finalized) || nativeId);

    let stat = { mtimeMs: 0, size: 0 };
    try {
        const st = fs.statSync(filePath);
        stat = { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch { /* 文件刚被删：保留 0，由扫描器负责清理 */ }

    return {
        session: sessionRecord({
            nativeId,
            agent: AGENT,
            project: projectNameOf(cwd),
            projectPath: cwd || null,
            title: cleanTitle(title),
            cwd: cwd || null,
            model,
            startedAt: startedAt || stat.mtimeMs,
            endedAt: endedAt || stat.mtimeMs,
            tokens: tokensSeen ? tokens : null,
            filePath,
            fileMtime: stat.mtimeMs,
            fileSize: stat.size,
            isSubagent: subagent,
            parentNativeId,
            extra: {
                gitBranch,
                slug: isSubagentPath(filePath) ? subagentParentId(filePath) : null,
                agentType: subMetaFile?.agentType ?? null,
                toolUseId: subMetaFile?.toolUseId ?? null,
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
