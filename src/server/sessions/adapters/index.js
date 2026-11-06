// 适配器表：registry 里的 adapter 名字 → 实现模块。
// 每个实现导出 { id, discover(root), parse(filePath) }；
// `parse` 返回 `{session, messages}`；返回 `null` 表示这条文件不该进索引
// （例如 Codex 的 guardian/review 内部线程、Cursor 只有 turn_ended 的空壳）。
import * as dsh from './dsh.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as cursor from './cursor.js';
import { gemini, kimi, qoder, kiro } from './others.js';

export const ADAPTERS = {
    dsh,
    claude,
    codex,
    cursor,
    gemini,
    kimi,
    qoder,
    kiro,
};

export function getAdapter(name) {
    return ADAPTERS[name] ?? null;
}
