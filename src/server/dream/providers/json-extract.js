// 从模型回复里抠出 JSON（推理模型很爱在 JSON 前后加解释、加代码块围栏，甚至加思维链）。
// 归属：dream worker。策略：去围栏 → 括号配平扫描 → 必要时补右括号 → JSON.parse。
export class JsonExtractError extends Error {
    constructor(message, { raw = '' } = {}) {
        super(message);
        this.name = 'JsonExtractError';
        this.code = 'E_BAD_JSON';
        this.raw = raw;
    }
}

function stripFences(text) {
    const src = String(text ?? '').trim();
    const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(src);
    if (fenced && fenced[1].trim()) return fenced[1].trim();
    return src;
}

/** 找到第一个 `{` 起、括号配平的完整对象文本（跳过字符串内的括号） */
function balancedObject(src, startAt) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startAt; i < src.length; i += 1) {
        const ch = src[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(startAt, i + 1);
        }
    }
    return null;
}

/** 被截断的 JSON：尽力补上未闭合的字符串与括号 */
function repairPartial(fragment) {
    let inString = false;
    let escaped = false;
    const stack = [];
    for (let i = 0; i < fragment.length; i += 1) {
        const ch = fragment[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
        else if (ch === '}' || ch === ']') stack.pop();
    }
    let out = fragment;
    if (inString) out += '"';
    // 去掉尾部的半个键值对/元素，再补右括号
    out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/,\s*"[^"]*$/, '');
    while (stack.length) out += stack.pop();
    return out;
}

/**
 * 解析模型输出里的第一个 JSON 对象。
 * @param {string} text
 * @param {{keys?:string[]}} [opts] 期望出现的键，用于在多个候选里挑对的那个
 */
export function extractJsonObject(text, { keys = [] } = {}) {
    const src = stripFences(text);
    const candidates = [];
    let at = src.indexOf('{');
    while (at !== -1) {
        const frag = balancedObject(src, at);
        if (frag) candidates.push(frag);
        else candidates.push(repairPartial(src.slice(at)));
        at = src.indexOf('{', at + 1);
        if (candidates.length > 40) break;
    }
    if (!candidates.length) throw new JsonExtractError('模型回复里没有 JSON 对象', { raw: String(text ?? '').slice(0, 500) });

    const scored = candidates.map((frag) => {
        let parsed = null;
        try { parsed = JSON.parse(frag); } catch {
            try { parsed = JSON.parse(repairPartial(frag)); } catch { parsed = null; }
        }
        const hit = parsed && typeof parsed === 'object'
            ? keys.filter((k) => Object.prototype.hasOwnProperty.call(parsed, k)).length
            : -1;
        return { parsed, hit, size: frag.length };
    }).filter((c) => c.parsed && typeof c.parsed === 'object');

    if (!scored.length) {
        throw new JsonExtractError('模型回复里的 JSON 无法解析', { raw: String(text ?? '').slice(0, 500) });
    }
    scored.sort((a, b) => (b.hit - a.hit) || (b.size - a.size));
    return scored[0].parsed;
}

/** 强制成字符串数组（模型偶尔给单值或对象） */
export function asStringArray(value, { max = 200 } = {}) {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    const out = [];
    for (const item of list) {
        if (item === null || item === undefined) continue;
        const text = typeof item === 'string'
            ? item
            : (typeof item === 'object' ? (item.text ?? item.summary ?? item.name ?? JSON.stringify(item)) : String(item));
        const trimmed = String(text).trim();
        if (trimmed) out.push(trimmed);
        if (out.length >= max) break;
    }
    return out;
}
