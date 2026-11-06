// remotes 表读写（SSH 主机 + 局域网对端共用）。字段语义见 ARCHITECTURE §5 的 Remote。
import { randomUUID } from 'node:crypto';
import { getDb, rowToRemote } from '../db.js';
import { clearHost } from '../sessions/store.js';

export function listRemotes() {
    return getDb().prepare('select * from remotes order by created_at asc').all().map(rowToRemote);
}

export function getRemote(id) {
    const row = getDb().prepare('select * from remotes where id = ?').get(id);
    return rowToRemote(row);
}

/** 远端对应的 host 前缀：`ssh:<id>` / `lan:<id>` */
export function hostOf(remote) {
    return `${remote.kind}:${remote.id}`;
}

const VALID_KINDS = new Set(['ssh', 'lan']);

export function createRemote(input = {}) {
    const kind = String(input.kind ?? '').trim();
    if (!VALID_KINDS.has(kind)) throw new Error(`kind 必须是 ssh 或 lan，收到：${input.kind}`);
    const id = String(input.id ?? '').trim() || randomUUID().slice(0, 8);
    if (getRemote(id)) throw new Error(`远端已存在：${id}`);
    const name = String(input.name ?? '').trim() || (kind === 'ssh'
        ? `${input.user ? `${input.user}@` : ''}${input.host ?? id}`
        : (input.url ?? id));
    getDb().prepare(`
        insert into remotes(id, kind, name, host, user, port, root, url, token, enabled, extra, created_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
        id,
        kind,
        name,
        input.host ?? null,
        input.user ?? null,
        input.port ? Number(input.port) : null,
        input.root ?? null,
        input.url ?? null,
        input.token ?? null,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.extra ?? {}),
        Date.now(),
    );
    return getRemote(id);
}

const PATCHABLE = ['name', 'host', 'user', 'port', 'root', 'url', 'token', 'last_sync', 'last_status', 'last_error', 'extra', 'enabled'];

export function updateRemote(id, patch = {}) {
    const current = getRemote(id);
    if (!current) return null;
    const sets = [];
    const args = [];
    for (const key of PATCHABLE) {
        if (!(key in patch)) continue;
        sets.push(`${key} = ?`);
        if (key === 'port') args.push(patch.port === null || patch.port === '' ? null : Number(patch.port));
        else if (key === 'enabled') args.push(patch.enabled ? 1 : 0);
        else if (key === 'extra') args.push(JSON.stringify(patch.extra ?? {}));
        else args.push(patch[key] ?? null);
    }
    if (sets.length) {
        args.push(id);
        getDb().prepare(`update remotes set ${sets.join(', ')} where id = ?`).run(...args);
    }
    return getRemote(id);
}

/** 删除远端登记，并清掉它同步下来的会话缓存（远端会话只读且可重建） */
export function deleteRemote(id) {
    const remote = getRemote(id);
    if (!remote) return { ok: false, removed: 0 };
    const removed = clearHost(hostOf(remote));
    getDb().prepare('delete from remotes where id = ?').run(id);
    return { ok: true, removed };
}

export function markRemoteSync(id, { status, error = null }) {
    return updateRemote(id, {
        last_sync: Date.now(),
        last_status: status,
        last_error: error ? String(error).slice(-2000) : null,
    });
}
