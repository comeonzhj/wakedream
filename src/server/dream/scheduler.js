// 夜间调度：常驻进程内按 config.dream.at（本地时区 HH:MM）触发当天的做梦。
// 归属：dream worker。
//
// 设计要点：
//   - startScheduler 立刻返回（不阻塞 server 启动），只挂一个定时器；
//   - 触发后**重算下一次**，所以改配置、跨天、夏令时都不会跑偏；
//   - 任何失败只记日志 + 在 dreams 里留 failed 记录，绝不崩掉常驻进程；
//   - 也支持系统 cron 直接跑 bin/dream.js（那条路不经过这里）。
import { fmtDay, loadConfig, saveConfig } from '../../shared/config.js';
import { getDb, nowTs } from '../db.js';
import { lastRunInfo, runDream } from './index.js';
import { PROVIDER_NAMES } from './providers/index.js';

const state = {
    timer: null,
    running: false,
    log: null,
    at: null,
    nextRun: null,
    lastFiredAt: null,
};

/** 解析 'HH:MM' / 'H:MM' / 'HH:MM:SS' → {hour, minute}，非法返回 null */
export function parseAt(at) {
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(at ?? ''));
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

/**
 * 下一次触发时间（epoch ms）：今天该时刻还没到就是今天，否则明天。
 * 纯函数，便于单测。
 */
export function computeNextRun(at, now = Date.now()) {
    const parsed = parseAt(at);
    if (!parsed) return null;
    const base = new Date(now);
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.hour, parsed.minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
}

function clearTimer() {
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
}

/** 尽力而为地记一条 failed（调度里出现意外错误时用；记录本身失败也不能抛） */
function recordFailure(error, day) {
    try {
        const db = getDb();
        const id = `drm_${day}_scheduler_${nowTs().toString(36)}`;
        db.prepare(
            `insert into dreams(id,day,store,status,provider,model,session_count,started_at,finished_at,memory_dir,report_path,stats,error)
             values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(id, day, 'default', 'failed', 'scheduler', null, 0, nowTs(), nowTs(), null, null, JSON.stringify({ trigger: 'scheduler' }), String(error?.message || error));
    } catch { /* 记不上就算了，绝不能因为记录失败崩进程 */ }
}

async function fire() {
    state.timer = null;
    const log = state.log;
    const day = fmtDay(new Date());
    state.lastFiredAt = nowTs();
    state.running = true;
    try {
        const config = loadConfig();
        const result = await runDream({ config, day, log });
        log?.info?.(`[scheduler] ${day} 做梦结束：status=${result.status}${result.error ? ` error=${result.error}` : ''}`);
    } catch (err) {
        log?.error?.(`[scheduler] ${day} 做梦失败（不影响常驻进程）：${err?.stack || err}`);
        // runDream 失败时自己已经记过一条的话，就不再重复记
        if (!err?.dreamRecorded) recordFailure(err, day);
    } finally {
        state.running = false;
        scheduleNext(loadConfig(), log);
    }
}

function scheduleNext(config, log) {
    clearTimer();
    const enabled = !!config?.dream?.enabled;
    const at = config?.dream?.at || '03:30';
    if (!enabled) {
        state.nextRun = null;
        return;
    }
    const next = computeNextRun(at, Date.now());
    state.nextRun = next;
    state.at = at;
    if (next === null) {
        log?.warn?.(`[scheduler] dream.at="${at}" 不是合法的 HH:MM，调度未启动`);
        return;
    }
    const delay = Math.max(0, next - Date.now());
    state.timer = setTimeout(() => { fire(); }, delay);
    // 定时器不阻止进程退出：CLI/测试里 import 这个模块不会挂住
    state.timer.unref?.();
    log?.info?.(`[scheduler] 下次做梦：${new Date(next).toISOString()}（本地 ${at}，${Math.round(delay / 1000)}s 后）`);
}

/**
 * 启动调度。**立即返回**（不 await 做梦本身），失败只记日志。
 * @param {{config?:object, log?:object, immediate?:boolean}} opts
 */
export async function startScheduler({ config = null, log = null, immediate = false } = {}) {
    state.log = log;
    const cfg = config || loadConfig();
    scheduleNext(cfg, log);
    if (immediate && cfg?.dream?.enabled) {
        // 供测试/手动验证：立刻触发一次（不等待）
        setImmediate(() => { fire(); });
    }
    return scheduleInfo();
}

export function stopScheduler() {
    clearTimer();
    state.nextRun = null;
}

/** GET /api/dream/schedule 的形状 */
export function scheduleInfo() {
    const config = loadConfig();
    const dream = config.dream || {};
    const last = (() => {
        try { return lastRunInfo(); } catch { return null; }
    })();
    return {
        enabled: !!dream.enabled,
        at: dream.at || '03:30',
        provider: dream.provider || 'heuristic',
        model: dream.model || '',
        windowDays: dream.windowDays ?? 1,
        maxSessions: dream.maxSessions ?? 60,
        store: dream.storeName || 'default',
        maxCharsPerSession: dream.maxCharsPerSession ?? 24000,
        lastRun: last ? { id: last.id, day: last.day, status: last.status, at: last.at } : null,
        nextRun: state.nextRun ?? (dream.enabled ? computeNextRun(dream.at || '03:30') : null),
        running: state.running,
        lastFiredAt: state.lastFiredAt,
    };
}

/**
 * PUT /api/dream/schedule：局部更新配置并立刻重算下一次。
 * 只接受已知字段，非法值抛错（API 层转 400）。
 */
export async function updateSchedule(patch = {}) {
    const clean = {};
    if (patch.enabled !== undefined) clean.enabled = !!patch.enabled;
    if (patch.at !== undefined) {
        if (!parseAt(patch.at)) throw new Error(`at 必须是 HH:MM（本地时区），收到：${patch.at}`);
        clean.at = String(patch.at);
    }
    if (patch.provider !== undefined) {
        const provider = String(patch.provider);
        if (!PROVIDER_NAMES.includes(provider)) throw new Error(`provider 必须是 ${PROVIDER_NAMES.join(' / ')}，收到：${provider}`);
        clean.provider = provider;
    }
    if (patch.model !== undefined) clean.model = String(patch.model || '');
    if (patch.windowDays !== undefined) {
        const days = Number(patch.windowDays);
        if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error(`windowDays 必须是 1–365 的整数，收到：${patch.windowDays}`);
        clean.windowDays = Math.floor(days);
    }
    if (patch.maxSessions !== undefined) {
        const max = Number(patch.maxSessions);
        if (!Number.isFinite(max) || max < 1 || max > 5000) throw new Error(`maxSessions 必须是 1–5000 的整数，收到：${patch.maxSessions}`);
        clean.maxSessions = Math.floor(max);
    }
    if (patch.storeName !== undefined) clean.storeName = String(patch.storeName || 'default');
    if (patch.maxCharsPerSession !== undefined) {
        const chars = Number(patch.maxCharsPerSession);
        if (!Number.isFinite(chars) || chars < 1000) throw new Error(`maxCharsPerSession 必须 >= 1000，收到：${patch.maxCharsPerSession}`);
        clean.maxCharsPerSession = Math.floor(chars);
    }
    const saved = saveConfig({ dream: clean });
    if (state.timer || saved.dream?.enabled) scheduleNext(saved, state.log);
    else state.nextRun = null;
    return { schedule: scheduleInfo(), dream: saved.dream };
}

export const _internal = { state, scheduleNext, fire };
