// 转录渲染：把库里的 sessions/messages 行还原成「一个会话一份纯文本转录」。
// 归属：dream worker。形状对齐 cookbook 的 plain-text export（analyzer 提示词就是按它写的）：
//   SESSION <id> / 元信息行 / `=== primary thread <id>: <agent> ===` / USER: / AGENT: /
//   TOOL CALL <tool>: / TOOL RESULT (<tool>): / 子会话渲染成 `=== sub-thread ... ===`
import { localTimeKey } from './collect.js';

const ROLE_LABEL = { user: 'USER', assistant: 'AGENT', system: 'SYSTEM', tool: 'TOOL' };

/**
 * `kind` 的取值由 §4 定义：text|thinking|tool_call|tool_result|meta。
 * 注意：**不同 adapter 对同一种内容会用不同的 kind** —— 例如 sessions worker 把用户消息
 * （票据 JSON、runtime context、system-reminder）落到 `kind='meta'`，只有用户手打的才算 `text`。
 * 所以判断「是不是人说的话」要看 role，而不是死盯 kind。
 */
const NON_TEXT_KINDS = new Set(['tool_call', 'tool_result']);
const NON_PROSE_ASSISTANT_KINDS = new Set(['tool_call', 'tool_result', 'thinking']);

function labelFor(message) {
    const role = String(message.role || 'assistant');
    if (message.kind === 'tool_call') {
        const name = toolName(message);
        return `TOOL CALL ${name}:`;
    }
    if (message.kind === 'tool_result') {
        const name = toolName(message);
        const failed = isErrorResult(message);
        return `TOOL RESULT (${name})${failed ? ' [error]' : ''}:`;
    }
    if (message.kind === 'thinking') return `${ROLE_LABEL[role] || role.toUpperCase()} (thinking):`;
    return `${ROLE_LABEL[role] || role.toUpperCase()}:`;
}

/** 不同 adapter 的错误标记不一样：isError / is_error / ok:false */
export function isErrorResult(message) {
    const meta = message.meta || {};
    return !!(meta.isError || meta.is_error || meta.ok === false || meta.success === false);
}

function toolName(message) {
    const meta = message.meta || {};
    return meta.name || meta.tool || meta.toolName || meta.command || 'tool';
}

// ---------------------------------------------------------------------------
// 文本净化：真实会话里塞满了 JSON 票据、HTML 片段与 harness 样板，
// 直接喂给分析会淹掉真正的信号，所以先「人化」再进转录与萃取。
// ---------------------------------------------------------------------------

const HTML_TAG = /<\/?[a-zA-Z][^<>]{0,200}>/g;

export function stripHtml(text) {
    return String(text ?? '')
        // harness 注入的 <system-reminder>（技能目录、运行时上下文等）不是会话内容，整块去掉
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr)>/gi, '\n')
        .replace(HTML_TAG, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const HUMAN_KEYS = ['title', 'text', 'description', 'prompt', 'task', 'summary', 'subject', 'body', 'goal', 'ask', 'content', 'message', 'request'];

/** 从一个 JSON 载荷里挖出人能读的字段（票据类消息的核心信息都在 title/text 里） */
function harvest(obj, depth = 0, out = []) {
    if (depth > 4 || out.length > 40) return out;
    if (typeof obj === 'string') {
        const s = stripHtml(obj);
        if (s.length >= 2) out.push(s);
        return out;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) harvest(item, depth + 1, out);
        return out;
    }
    if (obj && typeof obj === 'object') {
        for (const key of HUMAN_KEYS) {
            if (obj[key] !== undefined && obj[key] !== null) harvest(obj[key], depth + 1, out);
        }
        if (!out.length) {
            for (const value of Object.values(obj)) harvest(value, depth + 1, out);
        }
    }
    return out;
}

/**
 * 把一条消息文本变成适合分析的样子：
 *   - 大段 JSON（票据、事件、请求体）→ 抽出 title/text 等字段并去 HTML；
 *   - 其余文本 → 只去 HTML 标签。
 */
export function humanizePayload(text, { maxChars = 3000 } = {}) {
    const raw = String(text ?? '');
    const trimmed = raw.trim();
    const looksJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksJson && trimmed.length >= 300) {
        try {
            const parsed = JSON.parse(trimmed);
            const parts = [...new Set(harvest(parsed).filter((s) => s.length >= 3))];
            if (parts.length) {
                const joined = parts.join('\n');
                return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n…[长载荷已压缩]`;
            }
        } catch { /* 不是合法 JSON：按普通文本处理 */ }
    }
    const plain = stripHtml(raw);
    return plain.length <= maxChars ? plain : `${plain.slice(0, maxChars)}\n…[长文本已压缩]`;
}

/** harness 自己注入的 system 样板对「这一天做了什么」没有信息量，转录里省略（只记条数） */
function isBoilerplateSystem(message) {
    return String(message.role) === 'system';
}

function indentBody(text) {
    const body = String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!body) return '  (空)';
    // 与原文一致：块内保留自己的换行；以「看起来像标签」开头的行加一个空格缩进，避免误读
    return body
        .split('\n')
        .map((line) => (/^(USER:|AGENT:|SYSTEM:|TOOL |EVENT |===|SESSION )/.test(line) ? ` ${line}` : line))
        .join('\n');
}

/**
 * 渲染一个会话（含折叠进来的子会话）。
 * @param {{session:object, messages:object[], subagents?:{session:object,messages:object[]}[]}} input
 */
export function renderTranscript({ session, messages, subagents = [] }) {
    const lines = [];
    lines.push(`SESSION ${session.id}`);
    lines.push(`title: ${session.title || '(无标题)'}`);
    lines.push(`agent: ${session.agent || 'unknown'}   host: ${session.host || 'local'}   project: ${session.project || 'Unknown'}`);
    lines.push(`cwd: ${session.cwd || '-'}`);
    lines.push(`model: ${session.model || '-'}`);
    lines.push(`started_at: ${session.startedAt ? new Date(session.startedAt).toISOString() : '-'}  (本地 ${session.startedAt ? localTimeKey(session.startedAt) : '-'})`);
    if (session.endedAt) lines.push(`ended_at: ${new Date(session.endedAt).toISOString()}`);
    lines.push(`messages: ${session.messageCount ?? messages.length}   tokens: ${session.tokens ?? '-'}   source: ${session.source || 'local'}`);
    const boilerplate = messages.filter(isBoilerplateSystem).length;
    if (boilerplate) lines.push(`note: 已省略 ${boilerplate} 条 harness 注入的 system 样板`);
    lines.push('');
    lines.push(`=== primary thread ${session.id}: ${session.agent || 'agent'} ===`);
    lines.push('');
    for (const message of messages) {
        if (isBoilerplateSystem(message)) continue;
        lines.push(labelFor(message));
        lines.push(indentBody(humanizePayload(message.text)));
        lines.push('');
    }
    for (const child of subagents) {
        lines.push(`=== sub-thread ${child.session.id}: ${child.session.agent || 'agent'} (由父会话派生的子会话) ===`);
        lines.push('');
        for (const message of child.messages) {
            if (isBoilerplateSystem(message)) continue;
            lines.push(labelFor(message));
            lines.push(indentBody(humanizePayload(message.text)));
            lines.push('');
        }
    }
    return lines.join('\n');
}

/**
 * 超长转录按 maxChars 截断：保头部（任务与起始）与尾部（结论）各一半，中间标注丢了多少。
 * 宁可截断也要保留首尾，因为结论通常在尾部。
 */
export function truncateTranscript(text, maxChars = 24000) {
    const src = String(text ?? '');
    const cap = Math.max(1000, Math.floor(Number(maxChars) || 24000));
    if (src.length <= cap) return { text: src, truncated: false, droppedChars: 0, originalChars: src.length };
    const headSize = Math.floor(cap * 0.55);
    const tailSize = cap - headSize;
    const head = src.slice(0, headSize);
    const tail = src.slice(src.length - tailSize);
    const dropped = src.length - cap;
    const marker = `\n\n…[本转录共 ${src.length} 字符，为控制上下文省略中间 ${dropped} 字符；首尾完整保留]…\n\n`;
    return { text: `${head}${marker}${tail}`, truncated: true, droppedChars: dropped, originalChars: src.length };
}

/**
 * 从消息里取「用户说了什么」的纯文本列表（heuristic 与报告都用）。
 * 只要 role=user 且不是工具事件就算 —— 用户消息常被 adapter 落成 `kind='meta'`。
 */
export function userTexts(messages) {
    return messages
        .filter((m) => m.role === 'user' && !NON_TEXT_KINDS.has(m.kind))
        .map((m) => String(m.text || '').trim())
        .filter(Boolean);
}

/** 取助手侧的可见输出（排除 thinking 与工具事件） */
export function assistantTexts(messages) {
    return messages
        .filter((m) => m.role === 'assistant' && !NON_PROSE_ASSISTANT_KINDS.has(m.kind))
        .map((m) => String(m.text || '').trim())
        .filter(Boolean);
}

/** 取工具调用（名字 + 摘要），heuristic 用它抽「实际做了什么」 */
export function toolCalls(messages) {
    return messages
        .filter((m) => m.kind === 'tool_call')
        .map((m) => {
            const meta = m.meta || {};
            return { name: meta.name || meta.tool || 'tool', text: String(m.text || '').trim(), meta };
        });
}
