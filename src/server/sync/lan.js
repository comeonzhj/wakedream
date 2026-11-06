// 局域网同步。本机既可以当「对端」（只读暴露当天会话的 manifest + NDJSON bundle），
// 也可以当「拉取方」（从对端拉当天会话入库，host/source = `lan:<remoteId>`）。
//
// 全流程零外部依赖：node:http 的 fetch、node:crypto 的 sha256、node:os 的网卡枚举。
// 安全边界：
//   - 只有 `config.lan.enabled` 为 true 且 token 匹配才响应 manifest/bundle（否则 401/403）。
//   - bundle 里**只**有会话元数据与消息正文；`filePath` 一律清空，本机路径不出网。
//   - 对端不需要写任何东西，pull 侧也只写自己的库。
import crypto from 'node:crypto';
import os from 'node:os';
import { Readable } from 'node:stream';
import { loadConfig, saveConfig, VERSION } from '../../shared/config.js';
import { importSession } from '../sessions/store.js';
import { getMessages, getSession, querySessions } from '../sessions/index.js';
import { finishJob, jobLog } from './jobs.js';
import { createRemote, getRemote, hostOf, listRemotes, markRemoteSync, updateRemote } from './remotes.js';

const MANIFEST_LIMIT = 500;

/** token 为空且已启用时生成一个并落进 config.json（首次开启自动生成，与 config.js 注释一致） */
export function ensureLanToken(config = loadConfig()) {
    if (config.lan?.token) return config.lan.token;
    if (!config.lan?.enabled) return '';
    const token = crypto.randomBytes(16).toString('hex');
    saveConfig({ lan: { token } });
    return token;
}

/** 校验对端请求的 token。返回 null 表示通过，否则返回 {status, error} */
export function verifyLanToken({ token, config } = {}) {
    const cfg = config ?? loadConfig();
    if (!cfg.lan?.enabled) return { status: 403, error: '本机未开启局域网同步（config.lan.enabled = false）' };
    const expected = cfg.lan.token || '';
    if (!expected) return { status: 401, error: '本机尚未生成配对 token' };
    const given = String(token ?? '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        return { status: 401, error: 'token 不匹配' };
    }
    return null;
}

/** 本机可用地址（非回环 IPv4 + 端口），给对端填 */
export function lanUrls(port) {
    const urls = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const nic of list ?? []) {
            if (nic.family !== 'IPv4' || nic.internal) continue;
            urls.push(`http://${nic.address}:${port}`);
        }
    }
    return urls;
}

/** 脱敏：把本机文件路径换成对端用不了的空值（bundle 里绝不带本机路径） */
export function sanitizeForPeer(session) {
    return {
        id: session.id,
        nativeId: session.nativeId,
        agent: session.agent,
        project: session.project,
        projectPath: null,
        title: session.title,
        host: session.host,
        cwd: session.cwd,
        model: session.model,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        messageCount: session.messageCount,
        tokens: session.tokens,
        filePath: null,
        fileSize: null,
        isSubagent: session.isSubagent,
        parentNativeId: session.parentId ? String(session.parentId).split(':').slice(2).join(':') : null,
        source: session.source,
        extra: { agent: session.agent },
    };
}

/** 一条会话 → NDJSON 文本：首行 session，随后逐行 message */
export function sessionBundle(session, messages) {
    const lines = [JSON.stringify({ type: 'session', session: sanitizeForPeer(session) })];
    for (const m of messages) {
        lines.push(JSON.stringify({
            type: 'message',
            message: { seq: m.seq, role: m.role, kind: m.kind, ts: m.ts, text: m.text, meta: m.meta },
        }));
    }
    return `${lines.join('\n')}\n`;
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 对端拉取用的清单（ARCHITECTURE §5）。只暴露元数据与体积/摘要，不含路径、不含正文。
 * @returns {{device:string, generatedAt:number, sessions:Array}}
 */
export function lanManifest({ token, day, from, to } = {}) {
    const config = loadConfig();
    const denial = verifyLanToken({ token, config });
    if (denial) return denial;
    const { sessions } = querySessions({ day, from, to, limit: MANIFEST_LIMIT, order: 'asc' });
    const items = [];
    for (const s of sessions) {
        const messages = getMessages(s.id);
        const text = sessionBundle(s, messages);
        items.push({
            id: s.id,
            agent: s.agent,
            project: s.project,
            title: s.title,
            startedAt: s.startedAt,
            messageCount: messages.length,
            bytes: Buffer.byteLength(text, 'utf8'),
            sha256: sha256(text),
        });
    }
    return {
        device: config.lan?.deviceName || os.hostname(),
        version: VERSION,
        generatedAt: Date.now(),
        sessions: items,
    };
}

/** bundle：返回 {headers, stream} 给 /api/lan/bundle 直接写出；token 不对时给 {status, error} */
export function lanBundleStream({ token, id } = {}) {
    const config = loadConfig();
    const denial = verifyLanToken({ token, config });
    if (denial) return denial;
    const session = getSession(id);
    if (!session) return { status: 404, error: `会话不存在：${id}` };
    const text = sessionBundle(session, getMessages(id));
    return {
        headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-length': Buffer.byteLength(text, 'utf8'),
            'cache-control': 'no-store',
        },
        stream: Readable.from([text]),
    };
}

/* ------------------------------------------------------------- 拉取方 */

function normalizeUrl(url) {
    const raw = String(url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(raw)) throw new Error(`非法 url：${url}`);
    return raw;
}

function remoteIdFor(url) {
    return `lan${sha256(url).slice(0, 8)}`;
}

async function fetchJson(url, timeoutMs = 15000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
    return JSON.parse(text);
}

async function fetchText(url, timeoutMs = 60000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
    return text;
}

/** 解析对端 bundle（NDJSON）→ {session, messages} */
export function parseBundle(text) {
    let session = null;
    const messages = [];
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try {
            row = JSON.parse(trimmed);
        } catch {
            continue; // 半行/坏行：跳过，不中断整份 manifest
        }
        if (row.type === 'session' && row.session) session = row.session;
        else if (row.type === 'message' && row.message) messages.push(row.message);
    }
    return { session, messages };
}

/**
 * 从局域网对端拉取会话。
 * 远端登记进 remotes（kind='lan'，name 用对端 deviceName）；重复拉取按 id upsert，天然幂等。
 */
export async function pullFromLan({ url, token, day, from, to } = {}, job, log = null) {
    const base = normalizeUrl(url);
    const say = (line) => { jobLog(job, line); log?.(line); };
    const qs = new URLSearchParams();
    if (token) qs.set('token', token);
    if (day) qs.set('day', day);
    if (from) qs.set('from', String(from));
    if (to) qs.set('to', String(to));

    try {
        say(`拉取清单 ${base}/api/lan/manifest`);
        const manifest = await fetchJson(`${base}/api/lan/manifest?${qs.toString()}`);
        const deviceName = manifest.device || base;
        const wantedId = remoteIdFor(base);
        let remote = getRemote(wantedId);
        if (!remote) {
            remote = listRemotes().find((r) => r.kind === 'lan' && r.url === base) ?? null;
        }
        if (!remote) {
            remote = createRemote({ id: wantedId, kind: 'lan', name: deviceName, url: base, token: token ?? null });
        } else {
            remote = updateRemote(remote.id, { name: deviceName, url: base, token: token ?? remote.token });
        }
        const host = hostOf(remote);
        say(`对端 ${deviceName}（${host}）共 ${manifest.sessions.length} 条会话`);

        let added = 0;
        let updated = 0;
        let pulled = 0;
        const errors = [];
        for (const item of manifest.sessions) {
            const bq = new URLSearchParams({ token: token ?? '', id: item.id });
            try {
                const text = await fetchText(`${base}/api/lan/bundle?${bq.toString()}`);
                const { session, messages } = parseBundle(text);
                if (!session) throw new Error('bundle 缺少 session 行');
                const res = importSession(host, host, session, messages);
                if (res.outcome === 'added') added += 1; else updated += 1;
                pulled += 1;
            } catch (err) {
                errors.push({ id: item.id, error: err?.message || String(err) });
                say(`拉取 ${item.id} 失败：${err?.message || err}`);
            }
        }
        // 同 SSH：job.status 只有 running|ok|failed，「部分会话失败」记进 error
        const partial = errors.length ? `部分会话失败：${JSON.stringify(errors.slice(0, 5))}` : null;
        finishJob(job, { status: 'ok', pulled, added, updated, error: partial });
        markRemoteSync(remote.id, { status: 'ok', error: partial });
        say(`完成：${pulled} 条入库（新增 ${added}，更新 ${updated}）`);
        return { jobId: job?.id ?? null, remoteId: remote.id, pulled, added, updated, errors };
    } catch (err) {
        const message = err?.message || String(err);
        say(`失败：${message}`);
        finishJob(job, { status: 'failed', error: message });
        return { jobId: job?.id ?? null, error: message, pulled: 0, added: 0, updated: 0, errors: [{ error: message }] };
    }
}
