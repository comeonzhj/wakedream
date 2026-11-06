// 把「分析结果 / 收敛结果」规范化成下游（organize / indexer）唯一认得的形状。
// 归属：dream worker。heuristic 与模型两条路都走这里，保证落盘形状一致、可单测。

/** 一条带来源的事实 */
export function item(text, { sessions = [], day = null, evidence = '', extra = {} } = {}) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    return {
        text: clean,
        sessions: [...new Set(sessions.filter(Boolean).map(String))],
        day: day || null,
        evidence: String(evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        ...extra,
    };
}

function pickArray(raw, keys) {
    for (const key of keys) {
        const value = raw?.[key];
        if (Array.isArray(value)) return value;
        if (value !== undefined && value !== null && value !== '') return [value];
    }
    return [];
}

/** 把任意 provider 的单会话输出规整成标准 analysis */
export function coerceAnalysis(raw, session) {
    const sessions = [session?.id].filter(Boolean);
    const day = session?.dateKey || null;
    const list = (key, alts) => pickArray(raw, [key, ...(alts || [])])
        .map((entry) => {
            if (typeof entry === 'string') return item(entry, { sessions, day });
            if (entry && typeof entry === 'object') {
                const text = entry.text ?? entry.item ?? entry.summary ?? entry.fact ?? String(entry);
                return item(text, {
                    sessions,
                    day,
                    evidence: entry.evidence ?? entry.quote ?? entry.source ?? '',
                });
            }
            return null;
        })
        .filter(Boolean);

    const decisions = pickArray(raw, ['decisions', 'decision']).map((entry) => {
        if (typeof entry === 'string') return item(entry, { sessions, day, extra: { reason: '' } });
        const o = entry || {};
        return item(o.text ?? o.decision ?? '', {
            sessions,
            day,
            evidence: o.evidence ?? o.quote ?? '',
            extra: { reason: String(o.reason ?? o.rationale ?? '').trim() },
        });
    }).filter(Boolean);

    const preferences = pickArray(raw, ['preferences', 'preference']).map((entry) => {
        if (typeof entry === 'string') return item(entry, { sessions, day, extra: { scope: '' } });
        const o = entry || {};
        return item(o.text ?? o.preference ?? '', {
            sessions,
            day,
            evidence: o.evidence ?? '',
            extra: { scope: String(o.scope ?? '').trim() },
        });
    }).filter(Boolean);

    const openQuestions = pickArray(raw, ['open_questions', 'openQuestions', 'open_question']).map((entry) => {
        if (typeof entry === 'string') return item(entry, { sessions, day, extra: { owner: '' } });
        const o = entry || {};
        return item(o.text ?? o.question ?? '', {
            sessions,
            day,
            evidence: o.evidence ?? '',
            extra: { owner: String(o.owner ?? '').trim() },
        });
    }).filter(Boolean);

    const nextSteps = pickArray(raw, ['next_steps', 'nextSteps', 'todo', 'todos']).map((entry) => {
        if (typeof entry === 'string') return item(entry, { sessions, day });
        const o = entry || {};
        return item(o.text ?? o.step ?? '', { sessions: o.sessions || sessions, day, evidence: o.evidence ?? '' });
    }).filter(Boolean);

    const strings = (key, alts = []) => pickArray(raw, [key, ...alts])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? entry?.name ?? ''))
        .map((s) => String(s).trim())
        .filter(Boolean);

    return {
        sessionId: session?.id ?? null,
        agent: session?.agent ?? null,
        host: session?.host ?? null,
        project: session?.project ?? 'Unknown',
        projectPath: session?.projectPath ?? null,
        title: session?.title || '',
        day,
        startedAt: session?.startedAt ?? null,
        summary: String(raw?.summary ?? '').replace(/\s+/g, ' ').trim(),
        didWhat: list('did_what', ['didWhat', 'actions', 'work']),
        conclusions: list('conclusions', ['facts', 'findings']),
        decisions,
        openQuestions,
        nextSteps,
        preferences,
        people: strings('people', ['collaborators']),
        keywords: strings('keywords', ['tags']),
        commands: strings('commands', ['invocations']),
        files: strings('files', ['paths']),
        staleNotes: strings('stale_notes', ['staleNotes', 'caveats']),
        truncated: !!raw?.transcript_truncated,
        analyzeError: raw?.__error ? String(raw.__error) : null,
        _source: raw?.__source || 'model',
    };
}

/** 把 organizer 的输出规整成标准 organized 形状 */
export function coerceOrganized(raw, { day, store }) {
    const projects = pickArray(raw, ['projects']).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry : { title: String(entry ?? '') };
        const bullets = pickArray(o, ['bullets', 'facts', 'items']).map((b) => {
            if (typeof b === 'string') return item(b, { day });
            return item(b?.text ?? '', { sessions: b?.sessions || [], day, evidence: b?.evidence ?? '' });
        }).filter(Boolean);
        const questions = pickArray(o, ['open_questions', 'openQuestions']).map((q) => (
            typeof q === 'string' ? item(q, { day }) : item(q?.text ?? '', { sessions: q?.sessions || [], day, evidence: q?.evidence ?? '' })
        )).filter(Boolean);
        const steps = pickArray(o, ['next_steps', 'nextSteps']).map((q) => (
            typeof q === 'string' ? item(q, { day }) : item(q?.text ?? '', { sessions: q?.sessions || [], day, evidence: q?.evidence ?? '' })
        )).filter(Boolean);
        const declared = Array.isArray(o.sessions) ? o.sessions.map(String) : [];
        // 模型常常只给条目级的 sessions，不给项目级的：从条目里汇总，保证 projects/*.md 有来源
        const derived = [...new Set([
            ...declared,
            ...bullets.flatMap((b) => b.sessions || []),
            ...questions.flatMap((q) => q.sessions || []),
            ...steps.flatMap((s) => s.sessions || []),
        ])].filter(Boolean);
        return {
            slug: String(o.slug ?? '').trim(),
            title: String(o.title ?? o.name ?? o.slug ?? '未命名主题').trim(),
            summary: String(o.summary ?? '').replace(/\s+/g, ' ').trim(),
            sessions: derived,
            bullets,
            openQuestions: questions,
            nextSteps: steps,
        };
    }).filter((p) => p.slug || p.bullets.length || p.summary);

    const decisions = pickArray(raw, ['decisions']).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry : { text: String(entry ?? '') };
        return item(o.text ?? '', {
            sessions: o.sessions || [], day: o.day || day, evidence: o.evidence ?? '',
            extra: { reason: String(o.reason ?? '').trim() },
        });
    }).filter(Boolean);

    const preferences = pickArray(raw, ['preferences']).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry : { text: String(entry ?? '') };
        return item(o.text ?? '', {
            sessions: o.sessions || [],
            day: Array.isArray(o.days) && o.days.length ? o.days[0] : day,
            evidence: o.evidence ?? '',
            extra: { scope: String(o.scope ?? '').trim(), days: Array.isArray(o.days) ? o.days : undefined },
        });
    }).filter(Boolean);

    const openQuestions = pickArray(raw, ['open_questions', 'openQuestions']).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry : { text: String(entry ?? '') };
        return item(o.text ?? '', {
            sessions: o.sessions || [], day, evidence: o.evidence ?? '',
            extra: { owner: String(o.owner ?? '').trim(), days: Array.isArray(o.days) ? o.days : undefined },
        });
    }).filter(Boolean);

    const people = pickArray(raw, ['people']).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry : { name: String(entry ?? '') };
        return { name: String(o.name ?? '').trim(), role: String(o.role ?? '').trim(), sessions: [...new Set((o.sessions || []).map(String))] };
    }).filter((p) => p.name);

    const conflicts = pickArray(raw, ['conflicts']).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry : { text: String(entry ?? '') };
        return { text: String(o.text ?? '').trim(), sides: (o.sides || []).map((s) => String(s).trim()).filter(Boolean) };
    }).filter((c) => c.text);

    const changes = pickArray(raw, ['changes']).map((c) => String(typeof c === 'string' ? c : c?.text ?? '').trim()).filter(Boolean);

    return {
        day,
        store,
        indexIntro: String(raw?.index_intro ?? raw?.indexIntro ?? '').replace(/\s+/g, ' ').trim(),
        projects,
        decisions,
        preferences,
        openQuestions,
        people,
        conflicts,
        changes,
        _source: raw?.__source || 'model',
    };
}
