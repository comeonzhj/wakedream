// /api/remotes* 与 /api/sync/jobs/:jobId。归属：sessions worker。
import { badRequest, notFound, readBody } from '../router.js';
import {
    createRemote, deleteRemote, getJob, getRemote, listRemotes, syncRemote, updateRemote,
} from '../sync/index.js';
import { getDb } from '../db.js';

/** 请求体：main.js 已在 handler 前读好放在 ctx.body；老版本回退自己读 */
async function bodyOf(ctx) {
    if (ctx.body !== undefined && ctx.body !== null) return ctx.body;
    try {
        return await readBody(ctx.req);
    } catch {
        return {};
    }
}

/** 带上会话计数，UI 可以直接显示「@host · 12 条」 */
function withCounts(remote) {
    const host = `${remote.kind}:${remote.id}`;
    const row = getDb().prepare('select count(*) c, max(started_at) last from sessions where host = ? and deleted = 0').get(host);
    return { ...remote, hostLabel: remote.id === 'local' ? 'local' : `@${remote.name}`, sessionCount: row?.c ?? 0, lastSessionAt: row?.last ?? null };
}

export function register(router) {
    router.get('/api/remotes', async () => ({ remotes: listRemotes().map(withCounts) }));

    router.post('/api/remotes', async (ctx) => {
        const body = await bodyOf(ctx);
        try {
            const remote = createRemote(body ?? {});
            return { remote: withCounts(remote) };
        } catch (err) {
            return badRequest(ctx.res, err.message);
        }
    });

    router.patch('/api/remotes/:id', async (ctx) => {
        const body = await bodyOf(ctx);
        const remote = updateRemote(ctx.params.id, body ?? {});
        if (!remote) return notFound(ctx.res, `远端不存在：${ctx.params.id}`);
        return { remote: withCounts(remote) };
    });

    router.delete('/api/remotes/:id', async (ctx) => {
        const remote = getRemote(ctx.params.id);
        if (!remote) return notFound(ctx.res, `远端不存在：${ctx.params.id}`);
        const res = deleteRemote(ctx.params.id);
        return { ok: true, removedSessions: res.removed, host: `${remote.kind}:${remote.id}` };
    });

    router.post('/api/remotes/:id/sync', async (ctx) => {
        const remote = getRemote(ctx.params.id);
        if (!remote) return notFound(ctx.res, `远端不存在：${ctx.params.id}`);
        const body = await bodyOf(ctx);
        try {
            const { jobId, status } = await syncRemote(ctx.params.id, {
                full: body?.full === true,
                log: (line) => ctx.log.info(`[sync ${remote.name}] ${line}`),
            });
            return { jobId, status, remoteId: remote.id, kind: remote.kind };
        } catch (err) {
            return badRequest(ctx.res, err.message);
        }
    });

    router.get('/api/sync/jobs/:jobId', async (ctx) => {
        const job = getJob(ctx.params.jobId);
        if (!job) return notFound(ctx.res, `任务不存在：${ctx.params.jobId}`);
        return { job };
    });
}
