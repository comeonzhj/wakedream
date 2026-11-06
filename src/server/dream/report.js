// report.md（给人看）与 manifest.json（机器可读）的渲染。归属：dream worker。
import path from 'node:path';

function fmtTime(ms) {
    if (!ms) return '--:--';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtCost(cost) {
    if (!cost || !cost.calls) return '0（heuristic 不调用模型）';
    const total = cost.totalTokens ?? ((cost.inputTokens || 0) + (cost.outputTokens || 0));
    return `${cost.calls} 次调用，输入 ${cost.inputTokens || 0} tokens，输出 ${cost.outputTokens || 0} tokens，合计 ${total} tokens`;
}

/** 人读报告：当天总览 / 按项目与 agent 的产出 / 决定 / 未决 / 成本 / 被截断与失败项 */
export function renderReport({ day, store, organized, analyses, files = [], stats = {}, updatedAt = Date.now() }) {
    const L = [];
    L.push(`# ${day} 做梦报告`);
    L.push('');
    L.push(`- store：\`${store}\``);
    L.push(`- provider：\`${stats.provider}\`　model：\`${stats.model || '-'}\``);
    L.push(`- 会话数：${analyses.length}${stats.totalBeforeTruncate && stats.totalBeforeTruncate !== analyses.length ? `（当天共 ${stats.totalBeforeTruncate} 个，按 maxSessions=${stats.maxSessions} 截断）` : ''}`);
    L.push(`- windowDays：${stats.windowDays ?? 1}`);
    L.push(`- 记忆库：\`${stats.memoryDir || '-'}\``);
    L.push(`- 生成时间：${new Date(updatedAt).toISOString()}`);
    L.push(`- 耗时：收集 ${stats.timings?.collectMs ?? 0}ms · 分析 ${stats.timings?.analyzeMs ?? 0}ms · 收敛 ${stats.timings?.organizeMs ?? 0}ms · 落盘 ${stats.timings?.writeMs ?? 0}ms · 合计 ${stats.timings?.totalMs ?? 0}ms`);
    L.push('');

    L.push('## 今天做了什么（总览）');
    L.push('');
    L.push(organized.indexIntro || '（无）');
    L.push('');
    if (analyses.length) {
        L.push('| 时间 | agent | @主机 | 项目 | 会话 | 一句话 |');
        L.push('| --- | --- | --- | --- | --- | --- |');
        for (const a of analyses.slice().sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))) {
            const one = String(a.summary || '').replace(/\|/g, '/').slice(0, 140);
            L.push(`| ${fmtTime(a.startedAt)} | \`${a.agent || '?'}\` | @${a.host || 'local'} | ${String(a.project || '').replace(/\|/g, '/')} | \`${a.sessionId}\` | ${one} |`);
        }
        L.push('');
    }

    L.push('## 按项目 / 主题的产出');
    L.push('');
    if (!organized.projects?.length) L.push('（无）');
    for (const p of organized.projects || []) {
        L.push(`### ${p.title}（\`projects/${p.slug}.md\`）`);
        L.push('');
        L.push(`${p.summary || ''}`);
        L.push('');
        L.push(`- 会话 ${(p.sessions || []).length} 个${p.agents?.length ? `，agent：${p.agents.join('、')}` : ''}`);
        for (const b of (p.bullets || []).slice(0, 12)) {
            L.push(`- ${b.text}${b.sessions?.length ? `（来源 ${b.sessions.join('、')}）` : ''}`);
        }
        L.push('');
    }

    L.push('## 按 agent 统计');
    L.push('');
    const byAgent = new Map();
    for (const a of analyses) {
        const key = `${a.agent || '?'}@${a.host || 'local'}`;
        const bucket = byAgent.get(key) || { sessions: 0, tools: 0, conclusions: 0, decisions: 0, projects: new Set() };
        bucket.sessions += 1;
        bucket.conclusions += (a.conclusions || []).length;
        bucket.decisions += (a.decisions || []).length;
        bucket.projects.add(a.project);
        byAgent.set(key, bucket);
    }
    if (!byAgent.size) L.push('（无）');
    else {
        L.push('| agent@host | 会话 | 结论 | 决定 | 涉及项目 |');
        L.push('| --- | --- | --- | --- | --- |');
        for (const [key, b] of [...byAgent.entries()].sort((x, y) => y[1].sessions - x[1].sessions)) {
            L.push(`| \`${key}\` | ${b.sessions} | ${b.conclusions} | ${b.decisions} | ${[...b.projects].join('、')} |`);
        }
        L.push('');
    }

    L.push(`## 决定（${(organized.decisions || []).length}）`);
    L.push('');
    for (const d of organized.decisions || []) {
        L.push(`- ${d.text}（${d.day || '日期未知'}）`);
        if (d.reason) L.push(`  - 理由：${d.reason}`);
        if (d.sessions?.length) L.push(`  - 来源：${d.sessions.join('、')}`);
    }
    if (!organized.decisions?.length) L.push('（无）');
    L.push('');

    L.push(`## 未决问题（${(organized.openQuestions || []).length}）`);
    L.push('');
    for (const q of organized.openQuestions || []) {
        L.push(`- ${q.text}${q.owner ? `（跟进：${q.owner}）` : ''}${q.sessions?.length ? ` — 来源 ${q.sessions.join('、')}` : ''}`);
    }
    if (!organized.openQuestions?.length) L.push('（无）');
    L.push('');

    const nextSteps = analyses.flatMap((a) => (a.nextSteps || []).map((s) => ({ ...s, session: a.sessionId })));
    L.push(`## 下一步（${nextSteps.length}）`);
    L.push('');
    for (const s of nextSteps) L.push(`- ${s.text}（来源 ${s.session}）`);
    if (!nextSteps.length) L.push('（无）');
    L.push('');

    const carried = (organized.preferences || []).filter((p) => p.carried);
    L.push(`## 偏好（${(organized.preferences || []).length}，其中跨天继承 ${carried.length}）`);
    L.push('');
    for (const p of organized.preferences || []) {
        L.push(`- ${p.text}${p.days?.length ? `（${p.days.join('、')}）` : ''}`);
    }
    if (!organized.preferences?.length) L.push('（本次没有「重复出现」达到阈值的偏好）');
    L.push('');

    if (organized.conflicts?.length) {
        L.push(`## ⚠️ 冲突（${organized.conflicts.length}，未擅自取舍）`);
        L.push('');
        for (const c of organized.conflicts) {
            L.push(`- ${c.text}`);
            for (const side of c.sides || []) L.push(`  - ${side}`);
        }
        L.push('');
    }

    L.push('## 成本统计');
    L.push('');
    L.push(`- 模型调用：${fmtCost(stats.cost)}`);
    L.push(`- 提示词/上下文：单会话上限 ${stats.maxCharsPerSession ?? '-'} 字符（超出截断，首尾保留）`);
    L.push(`- 阶段降级：analyze=${stats.degraded?.analyze ? '有降级' : '无'}，organize=${stats.degraded?.organize ? '有降级' : '无'}${stats.degraded?.organizeReason ? `（${stats.degraded.organizeReason}）` : ''}`);
    L.push('');

    L.push('## 被截断 / 失败 / 跳过项');
    L.push('');
    const truncated = analyses.filter((a) => a.truncated);
    L.push(`- 转录被截断（超长）：${truncated.length} 个${truncated.length ? ` — ${truncated.map((a) => `\`${a.sessionId}\``).join('、')}` : ''}`);
    if (stats.maxSessionsTruncated?.length) {
        L.push(`- 因 maxSessions=${stats.maxSessions} 未纳入的会话：${stats.maxSessionsTruncated.length} 个`);
        for (const s of stats.maxSessionsTruncated) {
            L.push(`  - \`${s.id}\`（${fmtTime(s.startedAt)} ${s.agent || '?'}@${s.host || 'local'}）`);
        }
    } else {
        L.push('- 因 maxSessions 截断的会话：无');
    }
    if (stats.failures?.length) {
        L.push(`- 分析失败被跳过的会话：${stats.failures.length} 个`);
        for (const f of stats.failures) L.push(`  - \`${f.sessionId}\`：${f.error}`);
    } else {
        L.push('- 分析失败被跳过的会话：无');
    }
    if (stats.warnings?.length) {
        L.push(`- ⚠️ 告警（${stats.warnings.length}）：`);
        for (const w of stats.warnings) L.push(`  - \`${w.sessionId}\`：${w.message}`);
    } else {
        L.push('- 告警：无');
    }
    if (stats.subagentCount) L.push(`- 折叠进父会话的子会话：${stats.subagentCount} 个（不单独分析）`);
    if (stats.priorDay) L.push(`- 跨天累积来源：\`${stats.priorDay}\``);
    if (stats.dryRun) L.push('- 本次是 dryRun：**没有落盘、没有写库**');
    L.push('');

    L.push('## 产出文件');
    L.push('');
    for (const f of (files || []).filter((x) => x.path !== 'manifest.json')) {
        L.push(`- \`${f.path}\`（${Buffer.byteLength(f.content || '', 'utf8')} B，来源会话 ${(f.sourceSessions || []).length} 个）`);
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('> 记忆是从会话转录里萃取的，可能过期；每条事实都带 `source_sessions`，重要结论请回原会话核对。');
    L.push('> 记忆库是只读挂载给未来会话的：不代写别家 agent 的配置文件，只提供可复制的挂载说明（见 `_index.md`）。');
    L.push('');
    return L.join('\n');
}

/** 机器可读 manifest：文件 → source_sessions，以及结构化条目，供跨天累积与 API 复用 */
export function renderManifest({ day, store, organized, analyses, files, stats = {}, updatedAt = Date.now() }) {
    const payload = {
        version: 1,
        day,
        store,
        generatedAt: new Date(updatedAt).toISOString(),
        provider: stats.provider || null,
        model: stats.model || null,
        memoryDir: stats.memoryDir || null,
        windowDays: stats.windowDays ?? 1,
        sessions: analyses.map((a) => ({
            id: a.sessionId,
            agent: a.agent,
            host: a.host,
            project: a.project,
            title: a.title,
            startedAt: a.startedAt,
            file: `sessions/${String(a.sessionId).replace(/[^\w.-]+/g, '_')}.md`,
            source: a._source || 'unknown',
        })),
        files: files
            .filter((f) => f.path !== 'manifest.json')
            .map((f) => ({
                path: f.path,
                kind: f.kind,
                title: f.title,
                sourceSessions: f.sourceSessions || [],
                bytes: Buffer.byteLength(f.content, 'utf8'),
            })),
        decisions: (organized.decisions || []).map((d) => ({ text: d.text, reason: d.reason || '', day: d.day || day, sessions: d.sessions || [], evidence: d.evidence || '' })),
        preferences: (organized.preferences || []).map((p) => ({
            text: p.text, scope: p.scope || '', day: p.day || day,
            days: p.days?.length ? p.days : (p.day ? [p.day] : []),
            sessions: p.sessions || [], evidence: p.evidence || '', carried: !!p.carried,
        })),
        // 还没攒够「重复出现」次数的偏好候选，也要留给下一次做梦累积
        preferenceCandidates: (organized.preferenceCandidates || []).map((p) => ({
            text: p.text, scope: p.scope || '', day: p.day || day,
            days: p.days?.length ? p.days : (p.day ? [p.day] : []),
            sessions: p.sessions || [], evidence: p.evidence || '',
        })),
        openQuestions: (organized.openQuestions || []).map((q) => ({
            text: q.text, owner: q.owner || '', day: q.day || day,
            days: q.days?.length ? q.days : (q.day ? [q.day] : []),
            sessions: q.sessions || [],
        })),
        nextSteps: analyses.flatMap((a) => (a.nextSteps || []).map((s) => ({ text: s.text, session: a.sessionId, project: a.project }))),
        people: (organized.people || []).map((p) => ({ name: p.name, role: p.role || '', sessions: p.sessions || [] })),
        conflicts: organized.conflicts || [],
        // 收敛阶段的动作（合并 / 降级原因），人在报告里看，机器在 manifest 里看
        changes: organized.changes || [],
        organizerSource: organized._source || null,
        projects: (organized.projects || []).map((p) => ({ slug: p.slug, title: p.title, sessions: p.sessions || [] })),
        stats: {
            sessionCount: analyses.length,
            totalBeforeTruncate: stats.totalBeforeTruncate ?? analyses.length,
            maxSessions: stats.maxSessions ?? null,
            failures: stats.failures || [],
            truncatedSessions: analyses.filter((a) => a.truncated).map((a) => a.sessionId),
            warnings: stats.warnings || [],
            cost: stats.cost || { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            timings: stats.timings || {},
            degraded: stats.degraded || {},
        },
        mount: {
            path: stats.memoryDir || null,
            entry: path.posix.join('_index.md'),
        },
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
}
