// 适配器共用小工具：内容块 → 文本、时间戳归一、标题与项目名推导、消息序号整理。
// 语义对齐 Wake `crates/wake-core/src/adapters/parse_utils.rs`。
import path from 'node:path';

/** 任意值 → 字符串（数字直接转，其它给空串） */
export function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
}

/** ISO 时间串 / 秒 / 毫秒 → epoch 毫秒。认不出给 0 */
export function tsOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        // 小于 1e12 当秒级（Wake 里出现的秒级时间戳）
        return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    if (typeof v === 'string' && v) {
        const ms = Date.parse(v);
        if (!Number.isNaN(ms)) return ms;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    return 0;
}

export function firstTs(...vals) {
    for (const v of vals) {
        const t = tsOf(v);
        if (t > 0) return t;
    }
    return 0;
}

/**
 * 内容块数组 → 纯文本（与 Wake 的 blocks_text 同口径：只取 text 型块，
 * 图片/工具块不产生正文，未知块忽略）。
 */
export function blocksText(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) {
        if (typeof content === 'object') return str(content.text).trim();
        return '';
    }
    const parts = [];
    for (const b of content) {
        if (typeof b === 'string') { if (b.trim()) parts.push(b.trim()); continue; }
        if (!b || typeof b !== 'object') continue;
        const type = str(b.type);
        if (type === 'text' || type === 'input_text' || type === 'output_text') {
            const t = str(b.text);
            if (t.trim()) parts.push(t.trim());
        } else if (!type && typeof b.text === 'string') {
            // 有的 agent（Gemini CLI 的快照）直接给 `{text:"…"}`，不带 type
            const t = str(b.text);
            if (t.trim()) parts.push(t.trim());
        } else if (type === 'thinking' || type === 'reasoning' || type === 'summary_text') {
            const t = str(b.thinking) || str(b.text);
            if (t.trim()) parts.push(t.trim());
        }
    }
    return parts.join('\n\n').trim();
}

/** 只取图片块数量（本实现不解码图片二进制，只记数与占位） */
export function countImages(content) {
    if (!Array.isArray(content)) return 0;
    return content.filter((b) => b && typeof b === 'object' && (b.type === 'image' || b.type === 'input_image')).length;
}

/** 内容块数组 → {text, images:[]}；images 里放占位标记（不落盘二进制） */
export function contentParts(content) {
    const text = blocksText(content);
    const images = [];
    const n = countImages(content);
    for (let i = 0; i < n; i += 1) images.push(`[图片 ${i + 1}]`);
    return { text: images.length ? [text, ...images].filter(Boolean).join('\n') : text, images };
}

/** 工具入参：模型原样输出的 JSON 字符串 → 对象；解析失败保留原文（Wake 同口径） */
export function decodedArguments(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    const text = String(raw);
    if (!text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** 截断到 max 字符，末尾加省略标记（Wake 的 clip 同口径） */
export function clip(text, max) {
    const s = str(text);
    if (s.length <= max) return { text: s, clipped: false };
    return { text: `${s.slice(0, max)}…[截断]`, clipped: true };
}

const MAX_TITLE = 120;

/** 标题候选清洗：折行、压缩空白、剥掉常见的包裹标记 */
export function cleanTitle(s) {
    let t = str(s).replace(/\s+/g, ' ').trim();
    t = t.replace(/^<[^>]{0,40}>/, '').replace(/<\/?[a-z_-]{1,20}>$/i, '').trim();
    if (t.length > MAX_TITLE) t = `${t.slice(0, MAX_TITLE)}…`;
    return t;
}

/** cwd → 项目名（Wake：路径最后一段，家目录等退化情况给 Unknown） */
export function projectNameOf(cwd) {
    const p = str(cwd).trim();
    if (!p) return 'Unknown';
    const base = path.basename(p.replace(/[/\\]+$/, ''));
    if (!base || base === '.' || base === '/') return 'Unknown';
    return base;
}

/** 会话目录名（Claude 的 `-Users-tester-proj` 转义形式）→ 可读路径 */
export function unescapeProjectSlug(slug) {
    const raw = str(slug);
    if (!raw.startsWith('-')) return '';
    return raw.replace(/-/g, '/');
}

/** 从消息里取标题：第一条有正文的 user 消息（Wake 的 title_from_messages） */
export function titleFromMessages(messages, fallbackText = '') {
    for (const m of messages) {
        if (m.role === 'user' && m.kind === 'text' && m.text.trim()) return cleanTitle(m.text);
    }
    if (fallbackText) return cleanTitle(fallbackText);
    for (const m of messages) {
        if (m.text.trim()) return cleanTitle(m.text);
    }
    return '';
}

/** 新建一条消息（内部结构，落库前由 finalizeMessages 整理 seq） */
export function msg(role, kind, ts, text, meta = {}) {
    return { role, kind, ts: ts || 0, text: text ?? '', meta: meta ?? {} };
}

/** 顺序整理：丢掉空消息、重排 seq 0..n-1（messages 表主键要求连续递增） */
export function finalizeMessages(messages) {
    const out = [];
    for (const m of messages) {
        if (!m) continue;
        const text = str(m.text).replace(/\r\n/g, '\n');
        const metaEmpty = !m.meta || Object.keys(m.meta).length === 0;
        if (!text.trim() && metaEmpty) continue;
        out.push({
            seq: out.length,
            role: m.role || 'system',
            kind: m.kind || 'text',
            ts: m.ts || 0,
            text,
            meta: m.meta ?? {},
        });
    }
    return out;
}

/** 会话对象工厂：字段与 db.js 的 sessions 表列一一对应（store 负责写库） */
export function sessionRecord(init) {
    return {
        nativeId: '',
        agent: '',
        project: 'Unknown',
        projectPath: null,
        title: '',
        cwd: null,
        model: null,
        startedAt: 0,
        endedAt: 0,
        tokens: null,
        filePath: null,
        fileMtime: 0,
        fileSize: 0,
        isSubagent: false,
        parentNativeId: null,
        extra: {},
        ...init,
    };
}
