// 第二阶段 organize：把当天的逐会话分析收敛成一份记忆库（对齐 cookbook 的 organizer 角色，整轮一次）。
// 归属：dream worker。
//
// 两条路：
//   heuristic（provider.supportsStructured）：规则式合并 + 跨天累积 + 冲突标注。
//   模型：用 prompts/organizer_system.md + organizer_task.md 调一次 complete()，解析 JSON。
//         模型这一阶段失败/输出不可解析时**单独退回规则式收敛**，并在 stats.degraded 里写明原因——
//         不做静默降级：报告与 API 都能看到。
import { coerceOrganized } from './providers/normalize.js';
import { extractJsonObject } from './providers/json-extract.js';
import { organize as organizeHeuristic } from './providers/heuristic.js';
import { fillPrompt, loadPrompt } from './prompts/index.js';

const ORGANIZE_KEYS = ['projects', 'decisions', 'preferences', 'open_questions'];

/** 每条事实都必须能追到来源会话；没有 sessions 的条目直接丢掉，并记录丢了多少 */
export function enforceProvenance(organized, { log = null } = {}) {
    let dropped = 0;
    const clean = (items) => (items || []).filter((entry) => {
        const ok = Array.isArray(entry.sessions) && entry.sessions.length > 0;
        if (!ok) dropped += 1;
        return ok;
    });
    organized.decisions = clean(organized.decisions);
    organized.preferences = clean(organized.preferences);
    organized.openQuestions = clean(organized.openQuestions);
    for (const project of organized.projects || []) {
        project.bullets = clean(project.bullets);
        project.openQuestions = clean(project.openQuestions);
    }
    organized.droppedWithoutSource = dropped;
    if (dropped) log?.warn?.(`[organize] 丢弃 ${dropped} 条没有 source_sessions 的条目（无据不写）`);
    return organized;
}

/**
 * @returns {{organized:object, cost:object, degraded:boolean, degradeReason:string|null}}
 */
export async function organizeDream({ day, store, analyses, prior = null, provider, cfg = {}, log = null }) {
    const cost = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, perSession: [] };
    const fallback = async (reason) => {
        const organized = await organizeHeuristic({ day, store, analyses, prior });
        enforceProvenance(organized, { log });
        if (reason) {
            organized.changes = [...(organized.changes || []), `organize 阶段退回规则式收敛：${reason}`];
            organized._source = 'heuristic-fallback';
        }
        return { organized, cost, degraded: !!reason, degradeReason: reason };
    };

    if (provider.supportsStructured && typeof provider.organize === 'function') {
        try {
            const organized = await provider.organize({ day, store, analyses, prior, cfg });
            enforceProvenance(organized, { log });
            return { organized, cost, degraded: false, degradeReason: null };
        } catch (err) {
            log?.warn?.(`[organize] 结构化收敛失败：${err?.message || err}`);
            return fallback(`结构化收敛失败：${err?.message || err}`);
        }
    }

    try {
        const system = fillPrompt(loadPrompt('organizer_system'), {
            run_preferences: cfg.runPreferences ? `${cfg.runPreferences}\n` : '',
        });
        const task = fillPrompt(loadPrompt('organizer_task'), {
            day,
            store,
            prior: JSON.stringify(prior ? {
                day: prior.day,
                decisions: prior.decisions || [],
                preferences: prior.preferences || [],
                openQuestions: prior.openQuestions || [],
            } : null, null, 2),
            analyses: JSON.stringify(analyses, null, 2),
        });
        const completion = await provider.complete({
            system,
            messages: [{ role: 'user', content: task }],
            maxTokens: Number(cfg.organizerMaxTokens) || 8192,
        });
        if (completion?.usage) {
            cost.calls += 1;
            cost.inputTokens += completion.usage.inputTokens || 0;
            cost.outputTokens += completion.usage.outputTokens || 0;
            cost.totalTokens += completion.usage.totalTokens || 0;
            cost.perSession.push({ sessionId: null, ...completion.usage });
        }
        // 被 max_tokens 截断的 organizer 输出可能悄悄丢掉今天的条目 → 直接退回规则式收敛，不静默丢事实
        if (completion?.stopReason === 'length') {
            return fallback('organizer 输出被 max_tokens 截断（finish_reason=length），已退回规则式收敛');
        }
        const raw = extractJsonObject(typeof completion === 'string' ? completion : completion.text, { keys: ORGANIZE_KEYS });
        raw.__source = provider.name;
        const organized = coerceOrganized(raw, { day, store });
        // 模型可能漏掉跨天累积：把 prior 里没被提到的条目补回去（记忆只增不减）
        mergePrior(organized, prior, day);
        enforceProvenance(organized, { log });
        return { organized, cost, degraded: false, degradeReason: null };
    } catch (err) {
        return fallback(`模型收敛失败（${err?.message || err}）`);
    }
}

/** 把此前累积的偏好/决定/未决并回模型输出（按规范化文本去重，保留原有来源与日期） */
export function mergePrior(organized, prior, day) {
    if (!prior) return organized;
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s，。、；：！？,.;:!?"'`（）()\[\]【】]/g, '');
    const merge = (current, carried, mapFn) => {
        const seen = new Set((current || []).map((e) => norm(e.text)));
        const out = [...(current || [])];
        for (const entry of carried || []) {
            if (!entry?.text || seen.has(norm(entry.text))) continue;
            seen.add(norm(entry.text));
            out.push(mapFn(entry));
        }
        return out;
    };
    organized.decisions = merge(organized.decisions, prior.decisions, (e) => ({
        text: e.text, reason: e.reason || '', day: e.day || prior.day || day,
        sessions: e.sessions || [], evidence: e.evidence || '', carried: true,
    }));
    organized.preferences = merge(organized.preferences, prior.preferences, (e) => ({
        text: e.text, scope: e.scope || '', day: e.day || prior.day || day,
        days: e.days?.length ? e.days : [e.day || prior.day || day].filter(Boolean),
        sessions: e.sessions || [], evidence: e.evidence || '', carried: true,
    }));
    organized.openQuestions = merge(organized.openQuestions, prior.openQuestions, (e) => ({
        text: e.text, owner: e.owner || '', day: e.day || prior.day || day,
        days: e.days?.length ? e.days : [e.day || prior.day || day].filter(Boolean),
        sessions: e.sessions || [],
    }));
    return organized;
}
