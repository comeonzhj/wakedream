// /api/dreams* 与 /api/dream/schedule。归属：dream worker。契约见 ARCHITECTURE.md §5。
import { badRequest, json, notFound, readBody, serverError } from '../router.js';
import { getDream, listDreams, removeDream, runDream } from '../dream/index.js';
import { scheduleInfo, updateSchedule } from '../dream/scheduler.js';
import { PROVIDER_NAMES } from '../dream/providers/index.js';

function parseLimit(value, fallback = 30) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(500, Math.floor(n));
}

function parseBool(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return undefined;
}

function parseDay(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const s = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`day 必须是 YYYY-MM-DD，收到：${s}`);
    return s;
}

/**
 * 取请求体。
 * main.js 会在调用 handler 之前统一把 body 读好放进 `ctx.body`（见 main.js 的 createServer），
 * 那时 `ctx.req` 已被消费完，所以**必须优先用 ctx.body**；
 * 只有在直接调用 handler（单测里不经过 main.js）时 ctx.body 不存在，才回退到自己读流。
 */
async function bodyOf(ctx) {
    if (ctx.body !== undefined && ctx.body !== null) return ctx.body;
    return readBody(ctx.req);
}

export function register(router) {
    // GET /api/dreams —— 默认最近 30 次
    router.get('/api/dreams', (ctx) => {
        try {
            const dreams = listDreams({
                limit: parseLimit(ctx.query.limit, 30),
                day: ctx.query.day || null,
                store: ctx.query.store || null,
            });
            return { dreams };
        } catch (err) {
            return serverError(ctx.res, err);
        }
    });

    // GET /api/dreams/:id —— {dream,inputs,reportMarkdown}
    router.get('/api/dreams/:id', (ctx) => {
        try {
            const found = getDream(ctx.params.id);
            if (!found) return notFound(ctx.res, `没有这次做梦：${ctx.params.id}`);
            return found;
        } catch (err) {
            return serverError(ctx.res, err);
        }
    });

    // POST /api/dreams/run —— 同步执行（CLI 也复用它）
    router.post('/api/dreams/run', async (ctx) => {
        let body = {};
        try {
            body = (await bodyOf(ctx)) || {};
        } catch (err) {
            return badRequest(ctx.res, err.message);
        }
        const provider = body.provider || ctx.config?.dream?.provider || 'heuristic';
        if (!PROVIDER_NAMES.includes(provider)) {
            return badRequest(ctx.res, `provider 必须是 ${PROVIDER_NAMES.join(' / ')}，收到：${provider}`);
        }
        let day;
        try {
            day = parseDay(body.day);
        } catch (err) {
            return badRequest(ctx.res, err.message);
        }
        const windowDays = body.windowDays === undefined ? undefined : Number(body.windowDays);
        if (windowDays !== undefined && (!Number.isFinite(windowDays) || windowDays < 1)) {
            return badRequest(ctx.res, `windowDays 必须是 >=1 的整数，收到：${body.windowDays}`);
        }
        try {
            const result = await runDream({
                config: ctx.config,
                day,
                provider,
                model: body.model || undefined,
                dryRun: parseBool(body.dryRun) ?? false,
                force: parseBool(body.force) ?? false,
                windowDays,
                maxSessions: body.maxSessions === undefined ? undefined : Number(body.maxSessions),
                store: body.store || undefined,
                log: ctx.log,
            });
            return {
                dreamId: result.dreamId,
                status: result.status,
                sessionCount: result.stats?.sessionCount ?? 0,
                inputCount: result.stats?.inputCount ?? 0,
                memoryDir: result.memoryDir,
                reportPath: result.reportPath,
                stats: result.stats,
                reason: result.reason ?? null,
                error: result.error ?? null,
            };
        } catch (err) {
            // provider 配置类错误（缺 key、未知 provider）明确报错，不静默降级
            if (err?.code === 'E_NO_API_KEY' || err?.code === 'E_UNKNOWN_PROVIDER') {
                return json(ctx.res, { error: err.message, code: err.code }, 400);
            }
            ctx.log?.error?.(`做梦失败：${err?.stack || err}`);
            return serverError(ctx.res, err);
        }
    });

    // DELETE /api/dreams/:id —— 只删记忆产物与记录，不动原始会话
    router.delete('/api/dreams/:id', async (ctx) => {
        try {
            const result = await removeDream(ctx.params.id);
            if (!result.ok) return notFound(ctx.res, `没有这次做梦：${ctx.params.id}`);
            return { ok: true };
        } catch (err) {
            return serverError(ctx.res, err);
        }
    });

    // GET /api/dream/schedule
    router.get('/api/dream/schedule', () => {
        const info = scheduleInfo();
        return {
            enabled: info.enabled,
            at: info.at,
            provider: info.provider,
            model: info.model,
            windowDays: info.windowDays,
            lastRun: info.lastRun,
            nextRun: info.nextRun,
            maxSessions: info.maxSessions,
            store: info.store,
            running: info.running,
        };
    });

    // PUT /api/dream/schedule
    router.put('/api/dream/schedule', async (ctx) => {
        let body = {};
        try {
            body = (await bodyOf(ctx)) || {};
        } catch (err) {
            return badRequest(ctx.res, err.message);
        }
        try {
            const { schedule } = await updateSchedule(body || {});
            return {
                schedule: {
                    enabled: schedule.enabled,
                    at: schedule.at,
                    provider: schedule.provider,
                    model: schedule.model,
                    windowDays: schedule.windowDays,
                    lastRun: schedule.lastRun,
                    nextRun: schedule.nextRun,
                },
            };
        } catch (err) {
            return badRequest(ctx.res, err.message);
        }
    });

    return router;
}
