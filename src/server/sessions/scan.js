// 本机（及远端镜像目录）扫描器。
//
// 增量：按 file_mtime + file_size 双比较跳过没变的文件（mtime 相同但 size 变了也要重扫）；
// 可重建：`full: true` 先清空该 host 的全部会话再重扫；
// 只读：对别家 agent 目录绝不写入（本文件只有 readdir/stat/read）；
// 容错：单个目录/文件出错只记进 errors[]，不中断整轮；
// 收尾：写 meta.last_scan_at，并清理 file_path 已消失的会话（仅当该 agent 的根目录都列得出）。
import fs from 'node:fs';
import { loadConfig } from '../../shared/config.js';
import { getAdapter } from './adapters/index.js';
import { listAgents } from './registry.js';
import {
    clearHost, existingFileStamps, pruneMissing, resolveParentLinks,
    setLastScanAt, upsertSession,
} from './store.js';

// 同一时刻只跑一轮：并发调用（UI 连点 /api/scan）会 await 同一轮并拿到真实结果，
// 返回值加 `deduped: true` 让调用方知道这是复用的一轮。
let inFlight = null;

export function isScanning() {
    return !!inFlight;
}

/**
 * registry id ↔ 适配器名 双向解析。
 * 为什么需要：目标是两拨调用方给的——scanTree 传注册表 id（`claude-code`），
 * sync/ssh.js 与 scan.extraRoots 传适配器名（`claude`）；ADAPTERS 的键是适配器名。
 * 库里 sessions.agent 一律记**注册表 id**（与 /api/agents 一致），适配器名只用来找解析器。
 */
function buildAlias() {
    const idToAdapter = new Map();
    const adapterToId = new Map();
    for (const a of listAgents()) {
        if (!a.adapter) continue;
        idToAdapter.set(a.id, a.adapter);
        if (!adapterToId.has(a.adapter)) adapterToId.set(a.adapter, a.id);
    }
    return { idToAdapter, adapterToId };
}

function resolveTarget(agentId, alias = buildAlias()) {
    if (!agentId) return null;
    const registryId = alias.idToAdapter.has(agentId)
        ? agentId
        : (alias.adapterToId.get(agentId) ?? agentId);
    const adapter = getAdapter(alias.idToAdapter.get(registryId) ?? agentId);
    if (!adapter) return null;
    return { agentId: registryId, adapter };
}

/** 该 agentId（注册表 id 或适配器名）是否有可用适配器——调用方用来提前过滤目标。 */
export function hasAdapterFor(agentId) {
    return !!resolveTarget(agentId);
}

/**
 * 扫描一组 (agent, root) 目标。
 * @param {{host?:string, source?:string, targets:Array<{agentId:string,root:string}>, full?:boolean, log?:object}} opts
 *   targets[].agentId 收注册表 id 或适配器名（见 resolveTarget）。
 */export function scanTargets({ host = 'local', source = host, targets, full = false, log = console }) {
    const started = Date.now();
    const errors = [];
    const byAgent = {};
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let scanned = 0;

    if (full) {
        const cleared = clearHost(host);
        log?.info?.(`[scan] full：清空 ${host} 的 ${cleared} 条会话后重扫`);
    }

    // agentId → 候选文件与元数据
    const alias = buildAlias();
    const perAgent = new Map();
    for (const t of targets) {
        const resolved = resolveTarget(t.agentId, alias);
        if (!resolved) continue;
        const { agentId, adapter } = resolved;
        if (!perAgent.has(agentId)) perAgent.set(agentId, { adapter, roots: new Map(), files: [] });
        const bucket = perAgent.get(agentId);
        const exists = fs.existsSync(t.root);
        bucket.roots.set(t.root, { exists, readable: exists });
        if (!exists) continue;
        try {
            const found = adapter.discover(t.root);
            bucket.files.push(...found);
        } catch (err) {
            bucket.roots.set(t.root, { exists: true, readable: false });
            errors.push({ agent: agentId, root: t.root, error: err?.message || String(err) });
        }
    }

    for (const [agentId, bucket] of perAgent) {
        const stamps = existingFileStamps(host, agentId);
        const seen = new Set();
        const parentPairs = [];
        const stat = { scanned: 0, added: 0, updated: 0, skipped: 0, errors: 0 };

        for (const file of bucket.files) {
            seen.add(file.filePath);
            scanned += 1;
            stat.scanned += 1;
            const prev = stamps.get(file.filePath);
            const unchanged = prev && prev.mtime === file.mtimeMs && prev.size === file.size;
            if (unchanged && !full) {
                skipped += 1;
                stat.skipped += 1;
                continue;
            }
            let parsed;
            try {
                parsed = bucket.adapter.parse(file.filePath);
            } catch (err) {
                errors.push({ agent: agentId, path: file.filePath, error: err?.message || String(err) });
                stat.errors += 1;
                continue;
            }
            if (!parsed) {
                // 适配器判定这条不该进索引（内部线程 / 空壳转录）
                skipped += 1;
                stat.skipped += 1;
                continue;
            }
            try {
                const outcome = upsertSession(host, source, parsed.session, parsed.messages);
                if (outcome === 'added') { added += 1; stat.added += 1; } else { updated += 1; stat.updated += 1; }
                if (parsed.session.parentNativeId) {
                    parentPairs.push({
                        childNativeId: parsed.session.nativeId,
                        parentNativeId: parsed.session.parentNativeId,
                    });
                }
            } catch (err) {
                errors.push({ agent: agentId, path: file.filePath, error: err?.message || String(err) });
                stat.errors += 1;
            }
        }

        try {
            resolveParentLinks(host, agentId, parentPairs);
        } catch (err) {
            errors.push({ agent: agentId, error: `解析子代理归属失败：${err?.message || err}` });
        }

        // 只有「根目录都在、且都列得出」时才敢判定某个会话文件消失了
        const allRootsListed = [...bucket.roots.values()].every((r) => r.readable);
        const anyRootExists = [...bucket.roots.values()].some((r) => r.exists);
        if (allRootsListed && anyRootExists && !full) {
            try {
                const removed = pruneMissing(host, agentId, seen);
                if (removed) stat.pruned = removed;
            } catch (err) {
                errors.push({ agent: agentId, error: `清理已删除会话失败：${err?.message || err}` });
            }
        }
        byAgent[agentId] = stat;
    }

    const durationMs = Date.now() - started;
    if (host === 'local') setLastScanAt(started);
    return { host, source, scanned, added, updated, skipped, durationMs, errors, byAgent };
}

/** 本机扫描：注册表里所有「有适配器」的 agent + config.scan.extraRoots 追加目录 */
export function scanTree({ host = 'local', source = host, full = false, config = null, log = console, onlyAgents = null } = {}) {
    const cfg = config ?? loadConfig();
    const disabled = new Set(cfg.scan?.disabledAgents ?? []);
    const alias = buildAlias();
    const targets = [];
    for (const agent of listAgents()) {
        if (!agent.adapter) continue;
        if (disabled.has(agent.id)) continue;
        if (onlyAgents && !onlyAgents.includes(agent.id)) continue;
        for (const root of agent.roots) targets.push({ agentId: agent.id, root: root.dir });
    }
    for (const extra of cfg.scan?.extraRoots ?? []) {
        const agentId = extra?.agent || extra?.id;
        if (!agentId || !extra?.dir) continue;
        const resolved = resolveTarget(agentId, alias);
        if (!resolved) continue;
        targets.push({ agentId: resolved.agentId, root: extra.dir });
    }
    return scanTargets({ host, source, targets, full, log });
}

/**
 * 契约入口：本机会话扫描。
 * @param {{full?:boolean, config?:object, log?:object, host?:string, source?:string}} opts
 */
export async function scanLocal(opts = {}) {
    if (inFlight) {
        const result = await inFlight;
        return { ...result, deduped: true };
    }
    const run = (async () => {
        // 先让出一次微任务：scanTree 是同步的，否则它会在 `inFlight = run` 之前跑完，
        // 导致 inFlight 永远停在已完成的 promise 上、后续扫描全被误判成「正在扫描」。
        await Promise.resolve();
        try {
            return scanTree({ host: opts.host ?? 'local', source: opts.source, full: !!opts.full, config: opts.config ?? null, log: opts.log ?? console });
        } finally {
            inFlight = null;
        }
    })();
    inFlight = run;
    return run;
}

/** 检测各 agent 的根目录存在性与可扫描性（/api/agents 用；会话计数在 query.js 里拼） */
export function detectAgents() {
    return listAgents().map((agent) => ({
        ...agent,
        detected: agent.roots.length > 0 && agent.roots.some((r) => {
            try {
                return fs.existsSync(r.dir);
            } catch {
                return false;
            }
        }),
    }));
}
