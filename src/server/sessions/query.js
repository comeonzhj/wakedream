// 查询层：会话列表（筛选/分页/搜索/预览）、facets、统计。
//
// 搜索：`q` 走 **LIKE 子串匹配**（大小写不敏感，title/project/正文三处），不依赖 FTS5。
// 数据量在本产品形态下是「几百到几万条会话」量级，LIKE + 索引足够；
// FTS5 需要额外维护触发器与分词器（中文还要额外 tokenizer），收益不确定、易与迁移耦合，
// 因此**明确选择 LIKE 作为稳定实现**，需要时再在迁移里加 `messages_fts` 虚表替换这里。
//
// 时间范围：`day` / `from`+`to` 一律按 **sessions.started_at** 落区间（服务器本地自然日的
// 00:00:00.000–23:59:59.999，由 config.dayRange 给出）。byDay / byHour 也按 started_at 分桶。
import fs from 'node:fs';
import { dayRange } from '../../shared/config.js';
import { getDb, rowToSession } from '../db.js';
import { canonicalAgentId, listAgents as registryAgents } from './registry.js';
import { previewsFor } from './store.js';

/** 把 day/from/to 归一成 {from,to}（epoch ms，含端点）；给不出就是 null */
export function resolveRange({ day, from, to } = {}) {
    if (from !== undefined && from !== null && from !== '') {
        const f = Number(from);
        const t = to !== undefined && to !== null && to !== '' ? Number(to) : Date.now();
        if (Number.isFinite(f) && Number.isFinite(t)) return { from: f, to: t };
    }
    if (day) {
        const r = dayRange(day);
        return { from: r.start.getTime(), to: r.end.getTime() };
    }
    return null;
}

function likePattern(q) {
    // LIKE 里 % 与 _ 是通配符，用户输入里的要转义
    return `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildFilter(opts, { skipAgent = false, skipProject = false, skipHost = false } = {}) {
    const where = ['s.deleted = 0'];
    const args = [];
    const range = resolveRange(opts);
    if (range) {
        where.push('s.started_at >= ? and s.started_at <= ?');
        args.push(range.from, range.to);
    }
    if (!skipAgent && opts.agent) {
        where.push('s.agent = ?');
        args.push(canonicalAgentId(opts.agent));
    }
    if (!skipProject && opts.project) {
        where.push('s.project = ?');
        args.push(String(opts.project));
    }
    if (!skipHost && opts.host) {
        where.push('s.host = ?');
        args.push(String(opts.host));
    }
    if (opts.q && String(opts.q).trim()) {
        const pat = likePattern(opts.q);
        // SQLite 的 LIKE 对 ASCII 默认就是大小写不敏感的（中文按码点逐字节比较，子串匹配照常），
        // 所以不需要 lower()，也不需要 FTS 的分词器。
        where.push(`(s.title like ? escape '\\'
            or s.project like ? escape '\\'
            or s.cwd like ? escape '\\'
            or exists (select 1 from messages m where m.session_id = s.id and m.text like ? escape '\\'))`);
        args.push(pat, pat, pat, pat);
    }
    return { sql: where.join(' and '), args, range };
}

/**
 * 会话查询。参数同 /api/sessions（ARCHITECTURE §5）。
 * @returns {{total:number, sessions:object[], facets:{agents:Array,projects:Array,hosts:Array}}}
 */
export function querySessions(opts = {}) {
    const db = getDb();
    const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 2000) : 100;
    const offset = Math.max(0, Number(opts.offset) || 0);
    const order = String(opts.order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const { sql: whereSql, args } = buildFilter(opts);

    const total = db.prepare(`select count(*) as c from sessions s where ${whereSql}`).get(...args)?.c ?? 0;
    const rows = db.prepare(`
        select s.* from sessions s
        where ${whereSql}
        order by s.started_at ${order === 'asc' ? 'asc' : 'desc'}, s.id asc
        limit ? offset ?
    `).all(...args, limit, offset);

    const sessions = rows.map((r) => rowToSession(r));
    if (opts.withPreview) {
        const previews = previewsFor(sessions.map((s) => s.id));
        for (const s of sessions) s.preview = previews.get(s.id) ?? '';
    }

    // facets：在 day/range/q 这些「内容条件」下统计，但不带 agent/project/host 三个维度自身的过滤，
    // 这样用户可以拿着 facets 直接切换维度（侧栏多栏列表就是这么用的）。
    const facetFilter = buildFilter(opts, { skipAgent: true, skipProject: true, skipHost: true });
    const facets = {
        agents: db.prepare(`
            select s.agent as id, count(*) as count from sessions s
            where ${facetFilter.sql} group by s.agent order by count desc, id asc
        `).all(...facetFilter.args),
        projects: db.prepare(`
            select s.project as id, count(*) as count from sessions s
            where ${facetFilter.sql} group by s.project order by count desc, id asc
        `).all(...facetFilter.args),
        hosts: db.prepare(`
            select s.host as id, count(*) as count from sessions s
            where ${facetFilter.sql} group by s.host order by count desc, id asc
        `).all(...facetFilter.args),
    };
    const nameOf = new Map(registryAgents().map((a) => [a.id, a.name]));
    facets.agents = facets.agents.map((f) => ({ ...f, name: nameOf.get(f.id) ?? f.id }));
    facets.projects = facets.projects.map((f) => ({ id: f.id, name: f.id, count: f.count }));
    facets.hosts = facets.hosts.map((f) => ({
        id: f.id,
        name: f.id === 'local' ? 'local' : `@${hostLabel(f.id)}`,
        count: f.count,
    }));

    return { total, sessions, facets };
}

/** `ssh:abc` / `lan:abc` → 登记表里的远端名（查不到就退回 id） */
export function hostLabel(host) {
    const m = /^(ssh|lan):(.+)$/.exec(String(host));
    if (!m) return String(host);
    const row = getDb().prepare('select name from remotes where id = ?').get(m[2]);
    return row?.name || m[2];
}

/** /api/agents：注册表 + 检测状态 + 会话计数 */
export function agentsOverview({ day, from, to } = {}) {
    const db = getDb();
    const range = resolveRange({ day, from, to });
    const where = ['deleted = 0'];
    const args = [];
    if (range) { where.push('started_at >= ? and started_at <= ?'); args.push(range.from, range.to); }
    const counts = new Map(
        db.prepare(`select agent, count(*) c, max(started_at) last from sessions where ${where.join(' and ')} group by agent`)
            .all(...args)
            .map((r) => [r.agent, r]),
    );
    return registryAgents().map((agent) => {
        const c = counts.get(agent.id);
        return {
            id: agent.id,
            name: agent.name,
            color: agent.color,
            detected: agent.roots.length > 0 && agent.roots.some((r) => {
                try {
                    return fs.existsSync(r.dir);
                } catch {
                    return false;
                }
            }),
            sessionCount: c?.c ?? 0,
            lastAt: c?.last ?? null,
            roots: agent.roots,
        };
    });
}

/** /api/projects：按项目聚合 */
export function listProjects({ day, from, to, q, host } = {}) {
    const { sql: whereSql, args } = buildFilter({ day, from, to, q, host });
    return getDb().prepare(`
        select s.project as id, s.project as name,
               min(s.project_path) as path,
               count(*) as sessionCount, max(s.started_at) as lastAt
        from sessions s where ${whereSql}
        group by s.project order by lastAt desc, id asc
    `).all(...args);
}

/**
 * 统计。`?day=` 或 `?from&to=`；返回
 * `{totals:{sessions,messages,agents,projects,tokens}, byAgent:[], byHour:[], byDay:[]}`（byHour/byDay 升序）。
 */
export function monthStats(opts = {}) {
    const db = getDb();
    const { sql: whereSql, args, range } = buildFilter(opts);
    const rows = db.prepare(`
        select s.id, s.agent, s.project, s.started_at, s.tokens
        from sessions s where ${whereSql}
    `).all(...args);
    const ids = rows.map((r) => r.id);
    const msgCounts = new Map();
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        for (const r of db.prepare(`select session_id, count(*) c from messages where session_id in (${placeholders}) group by session_id`).all(...ids)) {
            msgCounts.set(r.session_id, r.c);
        }
    }

    let messages = 0;
    let tokens = 0;
    let tokensKnown = false;
    const byAgent = new Map();
    const byHour = new Array(24).fill(null).map((_, hour) => ({ hour, sessions: 0, messages: 0 }));
    const byDay = new Map();
    const projects = new Set();

    const dayKeyOf = (ms) => {
        const d = new Date(ms);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    for (const r of rows) {
        const mc = msgCounts.get(r.id) ?? 0;
        messages += mc;
        if (r.tokens !== null && r.tokens !== undefined) { tokens += r.tokens; tokensKnown = true; }
        projects.add(r.project ?? 'Unknown');
        const a = byAgent.get(r.agent) ?? { agent: r.agent, sessions: 0, messages: 0, tokens: 0 };
        a.sessions += 1; a.messages += mc; a.tokens += r.tokens ?? 0;
        byAgent.set(r.agent, a);
        const ts = r.started_at ?? 0;
        if (ts) {
            const hour = new Date(ts).getHours();
            byHour[hour].sessions += 1;
            byHour[hour].messages += mc;
            const day = dayKeyOf(ts);
            const d = byDay.get(day) ?? { day, sessions: 0, messages: 0 };
            d.sessions += 1; d.messages += mc;
            byDay.set(day, d);
        }
    }

    const nameOf = new Map(registryAgents().map((a) => [a.id, a.name]));
    return {
        range: range ? { from: range.from, to: range.to } : null,
        totals: {
            sessions: rows.length,
            messages,
            agents: byAgent.size,
            projects: projects.size,
            tokens: tokensKnown ? tokens : null,
        },
        byAgent: [...byAgent.values()]
            .map((a) => ({ ...a, name: nameOf.get(a.agent) ?? a.agent }))
            .sort((a, b) => b.sessions - a.sessions || a.agent.localeCompare(b.agent)),
        byHour,
        byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
}

export const stats = monthStats;
