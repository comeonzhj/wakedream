// /api/memory/*：读记忆库（只读）。归属：dream worker。契约见 ARCHITECTURE.md §5。
//
// 目录穿越防护：`/api/memory/file?path=` 的 path 交给 dream/store.js 的 resolveInside()，
// 解析后的绝对路径必须落在**该次做梦的记忆目录**内，否则 400（含 `..`、绝对路径、符号链接逃逸）。
import { badRequest, notFound, serverError } from '../router.js';
import { memoryTree, readMemoryFile } from '../dream/index.js';

export function register(router) {
    // GET /api/memory/tree?dreamId= —— 不传 dreamId 时给最近一次有记忆产物的 dream
    router.get('/api/memory/tree', (ctx) => {
        const dreamId = ctx.query.dreamId || null;
        try {
            const tree = memoryTree({ dreamId });
            return { root: tree.root, files: tree.files, dreamId: tree.dreamId ?? null, day: tree.day ?? null, store: tree.store ?? null };
        } catch (err) {
            if (err?.code === 'E_MEMORY_PATH') return badRequest(ctx.res, err.message);
            return serverError(ctx.res, err);
        }
    });

    // GET /api/memory/file?path=&dreamId=
    router.get('/api/memory/file', (ctx) => {
        const path = ctx.query.path;
        const dreamId = ctx.query.dreamId || null;
        if (!path) return badRequest(ctx.res, '缺少 path 参数');
        try {
            const file = readMemoryFile({ path, dreamId });
            return { path: file.path, markdown: file.markdown, dreamId: file.dreamId, day: file.day, store: file.store, title: file.title, kind: file.kind, sourceSessions: file.sourceSessions };
        } catch (err) {
            if (err?.code === 'E_MEMORY_PATH') return badRequest(ctx.res, err.message);
            if (err?.code === 'ENOENT') return notFound(ctx.res, dreamId ? `没有这次做梦或其记忆文件：${dreamId}` : `记忆文件不存在：${path}`);
            if (err?.code === 'EISDIR') return badRequest(ctx.res, `不是一个文件：${path}`);
            return serverError(ctx.res, err);
        }
    });

    return router;
}
