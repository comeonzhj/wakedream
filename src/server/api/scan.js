// POST /api/scan。归属：sessions worker。
// 同步返回扫描结果（本机数据量下是秒级）；进程内单轮互斥：并发请求会 await 同一轮并带
// `deduped: true`（UI 连点不会触发并发重扫，也不会拿到 0 造成误判）。
import { readBody } from '../router.js';
import { scanLocal } from '../sessions/index.js';

/** 请求体：main.js 已在调用 handler 前读好并放在 ctx.body（新契约）；
 *  老版本没有 ctx.body 时回退到自己读一次，两种 main.js 都能跑。 */
async function bodyOf(ctx) {
    if (ctx.body !== undefined && ctx.body !== null) return ctx.body;
    try {
        return await readBody(ctx.req);
    } catch {
        return {};
    }
}

/** 尽力通知 SSE（lead 的 /api/events 若已就绪就推一条，没有就算了） */
async function emitEvent(type, data) {
    try {
        const mod = await import('./events.js');
        mod?.emit?.(type, data);
    } catch { /* 事件层还没就绪：不影响扫描 */ }
}

export function register(router) {
    router.post('/api/scan', async (ctx) => {
        const body = await bodyOf(ctx);
        const full = body?.full === true || body?.full === 'true' || ctx.query.full === 'true';
        const result = await scanLocal({ full, config: ctx.config, log: ctx.log });
        await emitEvent('scan:done', {
            scanned: result.scanned,
            added: result.added,
            updated: result.updated,
            durationMs: result.durationMs,
            errors: result.errors.length,
        });
        return {
            scanned: result.scanned,
            added: result.added,
            updated: result.updated,
            skipped: result.skipped,
            durationMs: result.durationMs,
            errors: result.errors,
            byAgent: result.byAgent,
            full,
            ...(result.deduped ? { deduped: true } : {}),
        };
    });
}
