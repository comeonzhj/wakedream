// /api/agents /api/projects /api/sessions /api/sessions/:id /api/stats。归属：sessions worker。
import { badRequest, notFound } from '../router.js';
import {
    agentsOverview, getMessages, getSession, listProjects, monthStats, querySessions,
} from '../sessions/index.js';

export function register(router) {
    router.get('/api/agents', async (ctx) => ({
        agents: agentsOverview({ day: ctx.query.day, from: ctx.query.from, to: ctx.query.to }),
    }));

    router.get('/api/projects', async (ctx) => ({
        projects: listProjects({
            day: ctx.query.day,
            from: ctx.query.from,
            to: ctx.query.to,
            q: ctx.query.q,
            host: ctx.query.host,
        }),
    }));

    router.get('/api/sessions', async (ctx) => {
        const q = ctx.query;
        return querySessions({
            day: q.day,
            from: q.from,
            to: q.to,
            agent: q.agent,
            project: q.project,
            host: q.host,
            q: q.q,
            limit: q.limit,
            offset: q.offset,
            order: q.order,
            withPreview: q.withPreview === '1' || q.withPreview === 'true',
        });
    });

    router.get('/api/sessions/:id', async (ctx) => {
        const id = ctx.params.id;
        const session = getSession(id);
        if (!session) return notFound(ctx.res, `会话不存在：${id}`);
        const limit = Number(ctx.query.limit) > 0 ? Number(ctx.query.limit) : 0;
        const offset = Number(ctx.query.offset) > 0 ? Number(ctx.query.offset) : 0;
        return { session, messages: getMessages(id, { limit, offset }) };
    });

    router.get('/api/stats', async (ctx) => {
        const { day, from, to } = ctx.query;
        if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return badRequest(ctx.res, `非法日期：${day}`);
        const statsOut = monthStats({ day, from, to });
        return statsOut;
    });
}
