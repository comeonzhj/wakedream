// 「做梦」的记忆库落盘层。归属：dream worker。
//
// 形状严格按 docs/ARCHITECTURE.md §7：
//   ~/.wakedream/memory/dreams/<YYYY-MM-DD>/<store>/
//     _index.md  projects/<slug>.md  decisions.md  preferences.md  open-questions.md
//     people.md  sessions/<sessionId>.md  report.md  manifest.json
//
// 安全红线（本文件是唯一的写入口）：
//   1. 只允许在 `paths.dreams` 之下写；任何越界路径直接抛错。
//   2. 写入先落到 `<store>.tmp-<pid>` 再原子 rename，重跑即覆盖，绝不半写。
//   3. 只读挂载给别人，永远不写别家 agent 的目录、不改原始会话。
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, paths } from '../../shared/config.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class MemoryPathError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MemoryPathError';
        this.code = 'E_MEMORY_PATH';
    }
}

/** 记忆库根目录（所有写入必须落在这里面） */
export function dreamsRoot() {
    return paths.dreams;
}

/** 某天某 store 的记忆库目录 */
export function storeDir(day, store = 'default') {
    const safeStore = storeSlug(store);
    return path.join(paths.dreams, String(day), safeStore);
}

/** store 名做文件名安全化（store 是目录名，不允许出现分隔符） */
export function storeSlug(store) {
    const raw = String(store ?? 'default').trim() || 'default';
    const cleaned = raw.replace(/[^\w.\u4e00-\u9fa5-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
    return cleaned || 'default';
}

/** 项目名/主题 → slug（用于 projects/<slug>.md） */
export function slugify(input, fallback = 'untitled') {
    const raw = String(input ?? '').trim();
    if (!raw) return fallback;
    const ascii = raw
        .toLowerCase()
        .replace(/['"`’]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    const trimmed = ascii.slice(0, 60).replace(/-+$/g, '');
    return trimmed || fallback;
}

/** 会话 id 里有 `:` 等字符，做文件名时统一安全化，但保持可读、可反查 */
export function sessionFileSlug(sessionId) {
    const safe = String(sessionId ?? 'unknown').replace(/[^\w.-]+/g, '_');
    if (safe.length <= 120) return safe;
    // 过长时保留尾部（尾部含 native id，是最有辨识度的部分）
    return safe.slice(0, 40) + '--' + safe.slice(-70);
}

/** 解析后的绝对路径必须落在 baseDir 之内（防 `..` / 绝对路径 / 符号链接逃逸） */
export function resolveInside(baseDir, relPath) {
    if (relPath === null || relPath === undefined || relPath === '') {
        throw new MemoryPathError('缺少路径参数');
    }
    const rel = String(relPath);
    if (rel.includes('\0')) throw new MemoryPathError('路径含非法字符');
    if (path.isAbsolute(rel)) throw new MemoryPathError(`不允许绝对路径：${rel}`);
    const base = path.resolve(baseDir);
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new MemoryPathError(`路径越界：${rel}`);
    }
    return target;
}

/** 只允许在 memory/dreams 之下写 */
export function assertUnderDreams(target) {
    const root = path.resolve(paths.dreams);
    const resolved = path.resolve(target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new MemoryPathError(`只允许写入 ${root} 之下，收到：${resolved}`);
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// YAML 头
// ---------------------------------------------------------------------------

function yamlScalar(value) {
    const s = String(value ?? '');
    if (s === '') return '""';
    // 需要引号的情况：含特殊字符 / 前后空白 / 看起来像别的类型
    if (/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .:/@+-]*$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s)) return s;
    return JSON.stringify(s);
}

/**
 * 生成 §7 要求的 YAML 头：title / kind / day / source_sessions / updated_at
 * source_sessions 用块状列表（无依赖手写 YAML，只支持这两种形状）。
 */
export function frontmatter({ title, kind, day, sourceSessions = [], updatedAt = Date.now(), extra = {} }) {
    const lines = ['---'];
    lines.push(`title: ${yamlScalar(title)}`);
    lines.push(`kind: ${yamlScalar(kind)}`);
    lines.push(`day: ${yamlScalar(day)}`);
    const sessions = [...new Set((sourceSessions || []).filter(Boolean).map(String))];
    if (!sessions.length) {
        lines.push('source_sessions: []');
    } else {
        lines.push('source_sessions:');
        for (const id of sessions) lines.push(`  - ${yamlScalar(id)}`);
    }
    lines.push(`updated_at: ${new Date(updatedAt).toISOString()}`);
    for (const [k, v] of Object.entries(extra || {})) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            if (!v.length) lines.push(`${k}: []`);
            else {
                lines.push(`${k}:`);
                for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
            }
        } else {
            lines.push(`${k}: ${yamlScalar(v)}`);
        }
    }
    lines.push('---');
    return lines.join('\n');
}

/** 拼一份带 YAML 头的完整文档 */
export function renderDoc(meta, body) {
    return `${frontmatter(meta)}\n\n${String(body ?? '').replace(/\s+$/, '')}\n`;
}

/** 读回一份文档的 YAML 头（只解析本模块写出的形状，够用且零依赖） */
export function parseDoc(text) {
    const src = String(text ?? '');
    const out = { fm: {}, body: src };
    if (!src.startsWith('---')) return out;
    const end = src.indexOf('\n---', 3);
    if (end === -1) return out;
    const head = src.slice(3, end).replace(/^\n/, '');
    out.body = src.slice(end + 4).replace(/^\n+/, '');
    let currentList = null;
    for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        const listItem = /^\s+-\s+(.*)$/.exec(line);
        if (listItem && currentList) {
            out.fm[currentList].push(unquoteYaml(listItem[1]));
            continue;
        }
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1];
        const raw = kv[2];
        if (raw === '') {
            currentList = key;
            out.fm[key] = [];
        } else if (raw === '[]') {
            currentList = null;
            out.fm[key] = [];
        } else {
            currentList = null;
            out.fm[key] = unquoteYaml(raw);
        }
    }
    return out;
}

function unquoteYaml(raw) {
    const s = String(raw).trim();
    if (/^".*"$/.test(s)) {
        try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    return s;
}

// ---------------------------------------------------------------------------
// 目录树 / 原子写
// ---------------------------------------------------------------------------

/** 递归列出一份记忆库里的所有文件（相对路径，posix 分隔符） */
export function listFiles(dir) {
    const base = path.resolve(dir);
    const out = [];
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                let stat = null;
                try { stat = fs.statSync(full); } catch { /* 忽略竞态 */ }
                out.push({
                    path: path.relative(base, full).split(path.sep).join('/'),
                    absolute: full,
                    bytes: stat?.size ?? 0,
                    updatedAt: stat?.mtimeMs ?? null,
                });
            }
        }
    };
    walk(base);
    return out;
}

function rmrf(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch { /* 尽力而为 */ }
}

/**
 * 把一整套文件原子写入 `dir`：
 *   1. 写进同级 `<dir>.tmp-<pid>`（同日同 store 重跑即覆盖）
 *   2. 老目录挪到 `<dir>.old-<pid>`，tmp rename 成正式目录，再删老目录
 * 中途失败会把老目录挪回来，尽量不留半个记忆库。
 */
export function writeStoreAtomic(dir, files) {
    ensureHome();
    const target = assertUnderDreams(dir);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: DIR_MODE });
    const tmp = `${target}.tmp-${process.pid}`;
    const old = `${target}.old-${process.pid}`;
    rmrf(tmp);
    rmrf(old);
    try {
        fs.mkdirSync(tmp, { recursive: true, mode: DIR_MODE });
        for (const file of files) {
            const full = resolveInside(tmp, file.path);
            fs.mkdirSync(path.dirname(full), { recursive: true, mode: DIR_MODE });
            fs.writeFileSync(full, file.content, { encoding: 'utf8', mode: FILE_MODE });
        }
        if (fs.existsSync(target)) fs.renameSync(target, old);
        fs.renameSync(tmp, target);
    } catch (err) {
        rmrf(tmp);
        if (fs.existsSync(old) && !fs.existsSync(target)) {
            try { fs.renameSync(old, target); } catch { /* 忽略 */ }
        }
        throw err;
    }
    rmrf(old);
    return target;
}

/** 删除一份记忆库（DELETE /api/dreams/:id 用；只删记忆产物，不动原始会话） */
export function removeStoreDir(dir) {
    const target = assertUnderDreams(dir);
    rmrf(target);
    return true;
}

/** 读一份记忆文件；越界抛 MemoryPathError */
export function readFileInside(dir, relPath) {
    const full = resolveInside(dir, relPath);
    const text = fs.readFileSync(full, 'utf8');
    return { absolute: full, text };
}

// ---------------------------------------------------------------------------
// 跨天累积：读上一次的 manifest.json
// ---------------------------------------------------------------------------

export function manifestPath(day, store = 'default') {
    return path.join(storeDir(day, store), 'manifest.json');
}

export function loadManifest(day, store = 'default') {
    try {
        return JSON.parse(fs.readFileSync(manifestPath(day, store), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * 找同 store、早于 `beforeDay` 的最近一份 manifest（用于偏好/决定的跨天累积）。
 * 只扫 `memory/dreams/*\/<store>/manifest.json`，不递归别家目录。
 */
export function findPreviousManifest(store, beforeDay, lookbackDays = 60) {
    const safeStore = storeSlug(store);
    let days = [];
    try {
        days = fs.readdirSync(paths.dreams, { withFileTypes: true })
            .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
            .map((e) => e.name)
            .filter((d) => d < String(beforeDay))
            .sort()
            .reverse()
            .slice(0, Math.max(1, lookbackDays));
    } catch {
        return null;
    }
    for (const day of days) {
        const manifest = loadManifest(day, safeStore);
        if (manifest) return { day, store: safeStore, manifest, dir: storeDir(day, safeStore) };
    }
    return null;
}

/** 列出同 store 的所有历史天（新→旧），供 /api/memory/tree 与报告用 */
export function listStoreDays(store = 'default') {
    const safeStore = storeSlug(store);
    try {
        return fs.readdirSync(paths.dreams, { withFileTypes: true })
            .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
            .map((e) => e.name)
            .filter((day) => fs.existsSync(path.join(paths.dreams, day, safeStore)))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

/** 记忆库目录树（给人看的文本，报告与 CLI 共用） */
export function renderTree(dir, { maxEntries = 200 } = {}) {
    const files = listFiles(dir);
    const lines = [`${path.basename(path.dirname(dir))}/${path.basename(dir)}/`];
    const shown = files.slice(0, maxEntries);
    shown.forEach((f, i) => {
        const last = i === shown.length - 1;
        lines.push(`  ${last ? '└── ' : '├── '}${f.path}  (${f.bytes} B)`);
    });
    if (files.length > shown.length) lines.push(`  … 另有 ${files.length - shown.length} 个文件`);
    return lines.join('\n');
}

export const _internal = { yamlScalar, unquoteYaml, rmrf };
