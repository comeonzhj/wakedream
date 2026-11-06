// index 阶段（第三阶段）：把 organize 的收敛结果落成 §7 定义的 wiki 式记忆库。
// 归属：dream worker。
//
// 产出（全部带 YAML 头，文件间用**相对路径** markdown 链接互链）：
//   _index.md        入口：一句话总览 + 各文件链接 + 当天会话清单
//   projects/<slug>.md / decisions.md / preferences.md / open-questions.md / people.md
//   sessions/<sessionId>.md
//   report.md（给人看）· manifest.json（机器可读：文件 → source_sessions）
import path from 'node:path';
import { localTimeKey } from './collect.js';
import { renderDoc, sessionFileSlug } from './store.js';
import { mountInstructions } from './prompts/index.js';
import { renderManifest, renderReport } from './report.js';

const KIND = {
    index: 'index',
    project: 'project',
    session: 'session',
    decision: 'decision',
    preference: 'preference',
    openQuestion: 'open-question',
    people: 'people',
    report: 'report',
    manifest: 'manifest',
};

function fmtTime(ms) {
    if (!ms) return '--:--';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 会话 → 记忆库内相对链接（从根目录看） */
function sessionRelPath(sessionId) {
    return `sessions/${sessionFileSlug(sessionId)}.md`;
}

/** 从某个文件出发，指向某会话文件的相对链接 */
function relLink(fromFile, targetPath) {
    const fromDir = path.posix.dirname(fromFile);
    const rel = path.posix.relative(fromDir === '.' ? '' : fromDir, targetPath);
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function sessionsOf(items) {
    return [...new Set(items.flatMap((i) => i.sessions || []))];
}

function bulletLines(items, fromFile, { showDay = false, showEvidence = false } = {}) {
    return items.map((entry) => {
        const bits = [`- ${entry.text}`];
        if (showDay && entry.day) bits.push(`（${entry.day}）`);
        if (entry.reason) bits.push(`  \n  - 理由：${entry.reason}`);
        if (showEvidence && entry.evidence) bits.push(`  \n  - 原文：\`${entry.evidence.replace(/`/g, "'")}\``);
        const sessions = (entry.sessions || []).filter(Boolean);
        if (sessions.length) {
            // 在会话自己的摘要文件里就不再自链接，写成代码片段，避免点回自己
            const links = sessions.map((id) => (
                sessionRelPath(id) === fromFile ? `\`${id}\`` : `[${id}](${relLink(fromFile, sessionRelPath(id))})`
            )).join('、');
            bits.push(`  \n  - 来源会话：${links}`);
        }
        return bits.join('');
    });
}

// ---------------------------------------------------------------------------
// 单文件构造
// ---------------------------------------------------------------------------

function buildSessionFile(analysis, { day, updatedAt }) {
    const rel = sessionRelPath(analysis.sessionId);
    const lines = [];
    lines.push(`# ${analysis.title || analysis.sessionId}`);
    lines.push('');
    lines.push(`- 会话：\`${analysis.sessionId}\``);
    lines.push(`- agent：\`${analysis.agent || 'unknown'}\`　主机：\`@${analysis.host || 'local'}\`　项目：\`${analysis.project || 'Unknown'}\``);
    lines.push(`- 时间：${analysis.startedAt ? new Date(analysis.startedAt).toISOString() : '-'}（本地 ${fmtTime(analysis.startedAt)}）`);
    if (analysis.truncated) lines.push('- ⚠️ 转录超长，分析前做过截断（首尾保留）');
    if (analysis.analyzeError) lines.push(`- ⚠️ 分析失败：${analysis.analyzeError}`);
    lines.push('');
    if (analysis.summary) {
        lines.push('## 一句话');
        lines.push('');
        lines.push(analysis.summary);
        lines.push('');
    }
    const section = (title, items, extra = {}) => {
        if (!items?.length) return;
        lines.push(`## ${title}`);
        lines.push('');
        lines.push(...bulletLines(items, rel, extra));
        lines.push('');
    };
    section('做了什么', analysis.didWhat);
    section('结论 / 事实', analysis.conclusions, { showEvidence: true });
    section('决定', analysis.decisions, { showEvidence: true });
    section('下一步', analysis.nextSteps);
    section('未决', analysis.openQuestions);
    section('偏好线索', analysis.preferences);
    if (analysis.commands?.length) {
        lines.push('## 关键命令');
        lines.push('');
        for (const cmd of analysis.commands.slice(0, 12)) lines.push(`- \`${String(cmd).replace(/`/g, "'")}\``);
        lines.push('');
    }
    if (analysis.files?.length) {
        lines.push('## 涉及的文件');
        lines.push('');
        for (const f of analysis.files.slice(0, 15)) lines.push(`- \`${f}\``);
        lines.push('');
    }
    if (analysis.keywords?.length) {
        lines.push('## 关键词');
        lines.push('');
        lines.push(analysis.keywords.map((k) => `\`${k}\``).join('、'));
        lines.push('');
    }
    if (analysis.staleNotes?.length) {
        lines.push('## 时效性提醒');
        lines.push('');
        for (const note of analysis.staleNotes) lines.push(`- ${note}`);
        lines.push('');
    }
    lines.push('## 相关');
    lines.push('');
    lines.push(`- [记忆索引](${relLink(rel, '_index.md')})`);
    const projectRel = `projects/${analysis._projectSlug}.md`;
    if (analysis._projectSlug) lines.push(`- [项目：${analysis.project}](${relLink(rel, projectRel)})`);
    lines.push('');
    return {
        path: rel,
        kind: KIND.session,
        title: analysis.title || analysis.sessionId,
        sourceSessions: [analysis.sessionId],
        content: renderDoc({
            title: analysis.title || analysis.sessionId,
            kind: KIND.session,
            day,
            sourceSessions: [analysis.sessionId],
            updatedAt,
            extra: { agent: analysis.agent || '', host: analysis.host || 'local', project: analysis.project || '' },
        }, lines.join('\n')),
    };
}

function buildProjectFile(project, { day, updatedAt }) {
    const rel = `projects/${project.slug}.md`;
    const lines = [];
    lines.push(`# ${project.title}`);
    lines.push('');
    if (project.summary) {
        lines.push(project.summary);
        lines.push('');
    }
    lines.push(`- 会话数：${(project.sessions || []).length}`);
    if (project.agents?.length) lines.push(`- 参与 agent：${project.agents.map((a) => `\`${a}\``).join('、')}`);
    if (project.path) lines.push(`- 路径：\`${project.path}\``);
    lines.push('');
    if (project.bullets?.length) {
        lines.push('## 今天推进了什么 / 结论');
        lines.push('');
        lines.push(...bulletLines(project.bullets, rel, { showEvidence: true }));
        lines.push('');
    }
    if (project.openQuestions?.length) {
        lines.push('## 未决');
        lines.push('');
        lines.push(...bulletLines(project.openQuestions, rel));
        lines.push('');
    }
    if (project.nextSteps?.length) {
        lines.push('## 下一步');
        lines.push('');
        lines.push(...bulletLines(project.nextSteps, rel));
        lines.push('');
    }
    lines.push('## 本项目的会话');
    lines.push('');
    for (const sid of project.sessions || []) {
        lines.push(`- [${sid}](${relLink(rel, sessionRelPath(sid))})`);
    }
    lines.push('');
    lines.push('## 相关');
    lines.push('');
    lines.push(`- [记忆索引](${relLink(rel, '_index.md')})`);
    lines.push(`- [决定](${relLink(rel, 'decisions.md')})　[未决](${relLink(rel, 'open-questions.md')})`);
    lines.push('');
    return {
        path: rel,
        kind: KIND.project,
        title: project.title,
        sourceSessions: project.sessions || [],
        content: renderDoc({
            title: project.title,
            kind: KIND.project,
            day,
            sourceSessions: project.sessions || [],
            updatedAt,
            extra: { slug: project.slug },
        }, lines.join('\n')),
    };
}

function buildFlatFile({ relPath, title, kind, day, items, updatedAt, intro, renderItem, emptyNote }) {
    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    if (intro) {
        lines.push(intro);
        lines.push('');
    }
    if (!items.length) {
        lines.push(emptyNote || '（本次没有可确认的条目。）');
        lines.push('');
    } else {
        lines.push(...renderItem(items));
        lines.push('');
    }
    lines.push('## 相关');
    lines.push('');
    lines.push(`- [记忆索引](${relLink(relPath, '_index.md')})`);
    lines.push('');
    return {
        path: relPath,
        kind,
        title,
        sourceSessions: sessionsOf(items),
        content: renderDoc({
            title,
            kind,
            day,
            sourceSessions: sessionsOf(items),
            updatedAt,
        }, lines.join('\n')),
    };
}

function buildDecisionsFile(organized, { day, updatedAt }) {
    const items = organized.decisions || [];
    const today = items.filter((d) => d.day === day);
    const carried = items.filter((d) => d.day !== day);
    return buildFlatFile({
        relPath: 'decisions.md',
        title: '决定',
        kind: KIND.decision,
        day,
        items,
        updatedAt,
        intro: `${day} 做出的决定 ${today.length} 条，另有跨天累积 ${carried.length} 条（带原始日期与来源）。`,
        emptyNote: '（今天没有识别到明确的决定。）',
        renderItem: (list) => {
            const out = [];
            if (today.length) {
                out.push(`## ${day}`);
                out.push('');
                out.push(...bulletLines(today, 'decisions.md', { showEvidence: true }));
                out.push('');
            }
            if (carried.length) {
                out.push('## 跨天累积');
                out.push('');
                out.push(...bulletLines(carried, 'decisions.md', { showDay: true }));
                out.push('');
            }
            return out;
        },
    });
}

function buildPreferencesFile(organized, { day, updatedAt }) {
    const items = organized.preferences || [];
    // 只出现一次的偏好是「候选」：单独列出来，既让人看到线索，又不违反「重复出现才写」的规则
    const written = new Set(items.map((p) => p.text));
    const candidates = (organized.preferenceCandidates || []).filter((p) => !written.has(p.text));
    return buildFlatFile({
        relPath: 'preferences.md',
        title: '偏好与工作方式',
        kind: KIND.preference,
        day,
        items,
        updatedAt,
        intro: '跨天累积。**只有重复出现**（跨会话或跨天）的偏好才写进上面；只出现一次的放在最后的「候选」里继续攒。',
        emptyNote: '（还没有出现过两次以上的偏好 —— 这是刻意的：一次性的说法不算偏好。候选见下。）',
        renderItem: (list) => {
            const byScope = new Map();
            for (const entry of list) {
                const scope = entry.scope || '通用';
                if (!byScope.has(scope)) byScope.set(scope, []);
                byScope.get(scope).push(entry);
            }
            const out = [];
            for (const [scope, entries] of [...byScope.entries()].sort((a, b) => b[1].length - a[1].length)) {
                out.push(`## ${scope}`);
                out.push('');
                out.push(...bulletLines(entries, 'preferences.md', { showDay: true, showEvidence: true }));
                out.push('');
            }
            if (candidates.length) {
                out.push('## 候选（只出现过一次，攒够两次才升为偏好）');
                out.push('');
                out.push(...bulletLines(candidates, 'preferences.md', { showDay: true }));
                out.push('');
            }
            return out;
        },
    });
}

function buildOpenQuestionsFile(organized, { day, updatedAt }) {
    const items = organized.openQuestions || [];
    return buildFlatFile({
        relPath: 'open-questions.md',
        title: '未决问题',
        kind: KIND.openQuestion,
        day,
        items,
        updatedAt,
        intro: '悬而未决、需要用户或下个会话跟进的事。带日期与来源会话。',
        emptyNote: '（本次没有识别到未决问题。）',
        renderItem: (list) => list.flatMap((entry) => {
            const lines = [`- ${entry.text}`];
            if (entry.owner) lines.push(`  \n  - 跟进人：${entry.owner}`);
            const days = entry.days?.length ? entry.days : (entry.day ? [entry.day] : []);
            if (days.length) lines.push(`  \n  - 提出于：${days.join('、')}`);
            const ids = (entry.sessions || []).filter(Boolean);
            if (ids.length) {
                lines.push(`  \n  - 来源会话：${ids.map((id) => `[${id}](${relLink('open-questions.md', sessionRelPath(id))})`).join('、')}`);
            }
            return lines;
        }),
    });
}

function buildPeopleFile(organized, { day, updatedAt }) {
    const people = organized.people || [];
    const items = people.map((p) => ({ text: p.role ? `${p.name}（${p.role}）` : p.name, sessions: p.sessions || [], day }));
    return buildFlatFile({
        relPath: 'people.md',
        title: '人与协作方',
        kind: KIND.people,
        day,
        items,
        updatedAt,
        intro: '会话里出现的人、团队与协作方（可选文件）。',
        emptyNote: '（本次没有识别到具体的人或团队。）',
        renderItem: (list) => bulletLines(list, 'people.md'),
    });
}

function buildIndexFile({ day, store, organized, analyses, files, stats, updatedAt, hasPeople = true }) {
    const rel = '_index.md';
    const allSessions = analyses.map((a) => a.sessionId);
    const lines = [];
    lines.push(`# ${day} 记忆索引（store: ${store}）`);
    lines.push('');
    lines.push(organized.indexIntro || `${day} 共整理 ${analyses.length} 个会话。`);
    lines.push('');
    lines.push('> 这份记忆是**只读挂载**给未来会话的：从本文件开始读。');
    lines.push('');

    lines.push('## 项目 / 主题');
    lines.push('');
    if (!organized.projects?.length) lines.push('- （本次没有可归入项目的会话）');
    for (const project of organized.projects || []) {
        lines.push(`- [${project.slug}](${relLink(rel, `projects/${project.slug}.md`)}) — ${project.summary || project.title}`);
    }
    lines.push('');

    lines.push('## 决定、偏好与未决');
    lines.push('');
    lines.push(`- [decisions.md](${relLink(rel, 'decisions.md')}) — ${(organized.decisions || []).length} 条决定（含理由与来源会话）`);
    lines.push(`- [preferences.md](${relLink(rel, 'preferences.md')}) — ${(organized.preferences || []).length} 条跨天偏好`);
    lines.push(`- [open-questions.md](${relLink(rel, 'open-questions.md')}) — ${(organized.openQuestions || []).length} 条未决`);
    if (hasPeople) lines.push(`- [people.md](${relLink(rel, 'people.md')}) — ${(organized.people || []).length} 个人/团队`);
    lines.push('');

    if (organized.conflicts?.length) {
        lines.push('## ⚠️ 冲突（同一件事有不同说法，未擅自取舍）');
        lines.push('');
        for (const conflict of organized.conflicts) {
            lines.push(`- ${conflict.text}`);
            for (const side of conflict.sides || []) lines.push(`  - ${side}`);
        }
        lines.push('');
    }

    lines.push(`## 当天的会话（${analyses.length}）`);
    lines.push('');
    lines.push('| 时间 | agent | 主机 | 会话 | 标题 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const analysis of analyses.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
        const title = String(analysis.title || analysis.sessionId).replace(/\|/g, '/');
        lines.push(`| ${fmtTime(analysis.startedAt)} | \`${analysis.agent || '?'}\` | @${analysis.host || 'local'} | [\`${analysis.sessionId}\`](${relLink(rel, sessionRelPath(analysis.sessionId))}) | ${title} |`);
    }
    lines.push('');

    lines.push('## 其他');
    lines.push('');
    lines.push(`- [report.md](${relLink(rel, 'report.md')}) — 给人看的当天报告（成本、失败项、截断项）`);
    lines.push(`- [manifest.json](${relLink(rel, 'manifest.json')}) — 机器可读：文件 → source_sessions`);
    lines.push(`- 生成：${new Date(updatedAt).toISOString()}　provider：\`${stats.provider}\`　model：\`${stats.model || '-'}\``);
    lines.push('');
    lines.push('## 挂载指令（复制粘贴给未来的会话）');
    lines.push('');
    lines.push('```text');
    lines.push(mountInstructions(stats.memoryDir || '.'));
    lines.push('```');
    lines.push('');

    return {
        path: rel,
        kind: KIND.index,
        title: `${day} 记忆索引`,
        sourceSessions: allSessions,
        content: renderDoc({
            title: `${day} 记忆索引`,
            kind: KIND.index,
            day,
            sourceSessions: allSessions,
            updatedAt,
            extra: { store },
        }, lines.join('\n')),
    };
}

// ---------------------------------------------------------------------------
// 对外入口：第三阶段
// ---------------------------------------------------------------------------

/**
 * 构造整套记忆文件（不落盘）。
 * @returns {{files:Array<{path:string,kind:string,title:string,sourceSessions:string[],content:string}>}}
 */
export function buildMemoryFiles({
    day, store, organized, analyses, stats = {}, updatedAt = Date.now(),
}) {
    // 会话文件要先建，才知道每个会话属于哪个 project（用于回链）
    const projectByAgentSession = new Map();
    for (const project of organized.projects || []) {
        for (const sid of project.sessions || []) projectByAgentSession.set(sid, project.slug);
    }
    for (const analysis of analyses) {
        analysis._projectSlug = projectByAgentSession.get(analysis.sessionId)
            || (analysis.projectPath ? analysis.projectPath.split('/').filter(Boolean).slice(-1)[0] : 'unknown');
        analysis._projectSlug = String(analysis._projectSlug).replace(/[^\w.-]+/g, '-').toLowerCase() || 'unknown';
    }

    const files = [];
    for (const analysis of analyses) files.push(buildSessionFile(analysis, { day, updatedAt }));
    for (const project of organized.projects || []) files.push(buildProjectFile(project, { day, updatedAt }));
    files.push(buildDecisionsFile(organized, { day, updatedAt }));
    files.push(buildPreferencesFile(organized, { day, updatedAt }));
    files.push(buildOpenQuestionsFile(organized, { day, updatedAt }));
    // people.md 是 §7 里的可选文件：没有识别到人就不产出，避免留一份空文件
    const hasPeople = (organized.people || []).length > 0;
    if (hasPeople) files.push(buildPeopleFile(organized, { day, updatedAt }));

    const index = buildIndexFile({ day, store, organized, analyses, files, stats, updatedAt, hasPeople });
    files.unshift(index);

    const report = renderDoc({
        title: `${day} 做梦报告`,
        kind: KIND.report,
        day,
        sourceSessions: analyses.map((a) => a.sessionId),
        updatedAt,
    }, renderReport({ day, store, organized, analyses, files, stats, updatedAt }));
    files.push({
        path: 'report.md',
        kind: KIND.report,
        title: `${day} 做梦报告`,
        sourceSessions: analyses.map((a) => a.sessionId),
        content: report,
    });
    const manifest = renderManifest({ day, store, organized, analyses, files, stats, updatedAt });
    files.push({
        path: 'manifest.json',
        kind: KIND.manifest,
        title: `${day} manifest`,
        sourceSessions: analyses.map((a) => a.sessionId),
        content: manifest,
    });

    // 目录树（无 YAML 头的纯文本）不进 memory_files 记录
    return { files };
}

export { sessionRelPath, relLink, fmtTime, fmtDay, KIND };
