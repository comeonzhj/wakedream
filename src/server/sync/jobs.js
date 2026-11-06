// 同步任务的内存注册表（不做持久化：进程重启后历史任务消失，remotes.last_* 仍在库里）。
import { randomUUID } from 'node:crypto';

const jobs = new Map();
const MAX_JOBS = 200;

export function createJob({ kind, remoteId, label = '' }) {
    const job = {
        id: randomUUID(),
        kind,
        remoteId,
        label,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        pulled: 0,
        added: 0,
        updated: 0,
        error: null,
        log: [],
    };
    jobs.set(job.id, job);
    // 只保留最近 MAX_JOBS 个，免得常驻进程里无限涨
    if (jobs.size > MAX_JOBS) {
        for (const key of jobs.keys()) {
            if (jobs.size <= MAX_JOBS) break;
            jobs.delete(key);
        }
    }
    return job;
}

export function getJob(id) {
    return jobs.get(id) ?? null;
}

export function listJobs() {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function jobLog(job, line) {
    if (!job) return;
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
}

export function finishJob(job, { status = 'ok', error = null, pulled, added, updated } = {}) {
    if (!job) return;
    job.status = status;
    job.finishedAt = Date.now();
    job.error = error;
    if (pulled !== undefined) job.pulled = pulled;
    if (added !== undefined) job.added = added;
    if (updated !== undefined) job.updated = updated;
    return job;
}
