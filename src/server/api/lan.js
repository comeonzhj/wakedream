// /api/lan/*：本机作为对端（info / manifest / bundle）与作为拉取方（pull）。归属：sessions worker。
//
// manifest / bundle 是**对端**调的接口：`config.lan.enabled` 关闭时 403，token 不匹配 401；
// 返回内容只有会话元数据与消息正文，`filePath` 一律为 null（本机路径不出网）。
import { json, readBody } from '../router.js';
import { getDb } from '../db.js';
import { lanBundleStream, lanInfo, lanManifest, ensureLanToken, pullFromLan } from '../sync/index.js';

/** 请求体：main.js 已在 handler 前读好放在 ctx.body；老版本回退自己读 */
async function bodyOf(ctx) {
    if (ctx.body !== undefined && ctx.body !== null) return ctx.body;
    try {
        return await readBody(ctx.req);
    } catch {
        return {};
    }
}

function sessionCount() {
    return getDb().prepare('select count(*) c from sessions where deleted = 0').get()?.c ?? 0;
}

export function register(router) {
    router.get('/api/lan/info', async (ctx) => {
        const config = ctx.config;
        if (config.lan?.enabled && !config.lan.token) {
            config.lan.token = ensureLanToken(config); // 开启但没 token：生成并落盘
        }
        return lanInfo({ config, sessionCount: sessionCount() });
    });

    router.get('/api/lan/manifest', async (ctx) => {
        const result = lanManifest({
            token: ctx.query.token,
            day: ctx.query.day,
            from: ctx.query.from,
            to: ctx.query.to,
        });
        if (result?.status) return json(ctx.res, { error: result.error }, result.status);
        return result;
    });

    router.get('/api/lan/bundle', async (ctx) => {
        const result = lanBundleStream({ token: ctx.query.token, id: ctx.query.id });
        if (result?.status) return json(ctx.res, { error: result.error }, result.status);
        ctx.res.writeHead(200, result.headers);
        result.stream.pipe(ctx.res);
        return undefined;
    });

    router.post('/api/lan/pull', async (ctx) => {
        const body = await bodyOf(ctx);
        if (!body?.url) return json(ctx.res, { error: '缺少 url（对端地址，如 http://192.168.1.5:4680）' }, 400);
        const { jobId, status } = await pullFromLan({
            url: body.url,
            token: body.token,
            day: body.day,
            from: body.from,
            to: body.to,
        }, { log: (line) => ctx.log.info(`[lan pull] ${line}`) });
        return { jobId, status };
    });
}
