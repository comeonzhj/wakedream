// sync 模块门面（契约见 ARCHITECTURE §6）。
//   listRemotes / createRemote / syncRemote / getJob / pullFromLan / lanManifest / lanBundleStream
// 另导出局域网信息、远端 CRUD 与任务列表给 api 层用。
import { createJob } from './jobs.js';
import { getRemote } from './remotes.js';
import { syncSshRemote } from './ssh.js';
import { lanBundleStream, lanManifest, lanUrls, pullFromLan as pullFromLanInner } from './lan.js';

export { listRemotes, getRemote, createRemote, updateRemote, deleteRemote, hostOf } from './remotes.js';
export { getJob, listJobs } from './jobs.js';
export { lanManifest, lanBundleStream, ensureLanToken, verifyLanToken, lanUrls, sessionBundle, parseBundle } from './lan.js';
export {
    WHITELIST, DENY_PATTERNS, syncPaths, buildRsyncArgs, buildTarArgs, isDenied, mirrorRoot, mirrorTargets, probeCommand,
} from './ssh.js';

/**
 * 触发一个远端的同步（异步）：立刻返回 `{jobId,status}`，任务在内存里推进。
 * 目前只支持 kind='ssh'（局域网用 POST /api/lan/pull）。
 */
export async function syncRemote(remoteId, opts = {}) {
    const remote = getRemote(remoteId);
    if (!remote) throw new Error(`远端不存在：${remoteId}`);
    const job = createJob({ kind: remote.kind, remoteId, label: remote.name });
    // 故意不 await：先回 jobId，UI 用 /api/sync/jobs/:jobId 看进度
    const promise = remote.kind === 'ssh'
        ? syncSshRemote(remoteId, opts, job, opts.log ?? null)
        : Promise.resolve({ error: `远端 ${remoteId} 是 ${remote.kind} 类型，请用 /api/lan/pull` });
    promise.then((result) => {
        if (result?.error && job.status === 'running') {
            job.status = 'failed';
            job.error = result.error;
            job.finishedAt = Date.now();
        }
    }).catch(() => { /* syncSshRemote 自己已记状态 */ });
    return { jobId: job.id, status: job.status };
}

/** 局域网拉取（异步）。返回 `{jobId}`，完成后写 remotes.last_sync。 */
export async function pullFromLan({ url, token, day, from, to } = {}, opts = {}) {
    if (!url) throw new Error('缺少 url');
    const job = createJob({ kind: 'lan', remoteId: null, label: url });
    const promise = pullFromLanInner({ url, token, day, from, to }, job, opts.log ?? null);
    promise.catch(() => { /* 内部已记状态 */ });
    return { jobId: job.id, status: job.status };
}

/** 本机对端信息：/api/lan/info 用 */
export function lanInfo({ config, sessionCount = 0 } = {}) {
    const cfg = config ?? {};
    const port = Number(process.env.PORT || cfg.port || 4680);
    const token = cfg.lan?.token ?? '';
    const deviceName = cfg.lan?.deviceName || '';
    const urls = lanUrls(port);
    const pair = urls.length ? `wakedream://pair?url=${encodeURIComponent(urls[0])}&token=${token}` : null;
    return {
        enabled: !!cfg.lan?.enabled,
        deviceName,
        port,
        urls,
        token,
        sessionCount,
        pair,
        hint: cfg.lan?.enabled
            ? '把任一 url + token 填到另一台设备的「局域网对端」，或直接粘贴配对串。'
            : '局域网同步未开启：在设置里打开 config.lan.enabled（需要时同时打开 bindAll 监听 0.0.0.0）。',
    };
}
