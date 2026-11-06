// 第一阶段 analyze：逐会话分析（对齐 cookbook 的 analyzer 角色，一个转录一个 analyzer）。
// 归属：dream worker。
//
// 两条路：
//   heuristic（provider.supportsStructured）：直接调 provider.analyzeSession，零网络零依赖。
//   模型（anthropic / openai-compatible）：用 prompts/analyzer_system.md + analyzer_task.md 调 complete()，
//   把回复里的 JSON 解析出来；**单个会话失败就跳过它并记进报告，不整轮失败**。
import { loadMessages, loadSubagents } from './collect.js';
import { renderTranscript, truncateTranscript } from './transcript.js';
import { coerceAnalysis } from './providers/normalize.js';
import { extractJsonObject } from './providers/json-extract.js';
import { fillPrompt, loadPrompt } from './prompts/index.js';

const ANALYSIS_KEYS = ['summary', 'did_what', 'conclusions', 'decisions', 'open_questions', 'preferences'];

function emptyCost() {
    return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, perSession: [] };
}

function addUsage(cost, usage, sessionId) {
    if (!usage) return;
    cost.calls += 1;
    cost.inputTokens += usage.inputTokens || 0;
    cost.outputTokens += usage.outputTokens || 0;
    cost.totalTokens += usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0));
    cost.perSession.push({ sessionId, ...usage });
}

/**
 * @param {object} opts
 * @param {object} opts.collection collectDaySessions() 的返回值
 * @param {object} opts.provider   createProvider() 的返回值
 * @param {object} opts.cfg        { maxCharsPerSession, analyzerMaxTokens, runPreferences, log }
 * @returns {{analyses:object[], failures:object[], cost:object, inputs:object[]}}
 */
export async function analyzeSessions({ collection, provider, cfg = {}, log = null, onProgress = null }) {
    const analyses = [];
    const failures = [];
    const warnings = [];
    const inputs = [];
    const cost = emptyCost();
    const maxChars = Number(cfg.maxCharsPerSession) || 24000;
    const sessions = collection.sessions || [];

    for (let i = 0; i < sessions.length; i += 1) {
        const session = sessions[i];
        let transcript = '';
        let transcriptInfo = { truncated: false, droppedChars: 0, originalChars: 0 };
        try {
            const messages = loadMessages(session.id);
            const subagents = loadSubagents(collection, session.id);
            transcript = renderTranscript({ session, messages, subagents });
            transcriptInfo = truncateTranscript(transcript, maxChars);
            inputs.push({
                sessionId: session.id,
                chars: transcriptInfo.text.length,
                originalChars: transcriptInfo.originalChars,
                truncated: transcriptInfo.truncated,
                messages: messages.length,
                subagents: subagents.length,
            });
            let analysis;
            if (provider.supportsStructured && typeof provider.analyzeSession === 'function') {
                analysis = await provider.analyzeSession({
                    session,
                    messages,
                    subagents,
                    transcript: transcriptInfo.text,
                    transcriptInfo,
                    cfg,
                });
            } else {
                const system = fillPrompt(loadPrompt('analyzer_system'), {
                    run_preferences: cfg.runPreferences ? `${cfg.runPreferences}\n` : '',
                });
                const task = fillPrompt(loadPrompt('analyzer_task'), {
                    session_id: session.id,
                    agent: session.agent || 'unknown',
                    host: session.host || 'local',
                    project: session.project || 'Unknown',
                    day: session.dateKey || collection.day,
                    transcript: transcriptInfo.text,
                });
                const completion = await provider.complete({
                    system,
                    messages: [{ role: 'user', content: task }],
                    // 推理模型（DeepSeek-V4.1-Flash 等）的 completion_tokens 里含思维 token，
                    // 预算给小了会「内容非空但被截断」，所以默认给 8192
                    maxTokens: Number(cfg.analyzerMaxTokens) || 8192,
                });
                addUsage(cost, completion?.usage, session.id);
                if (completion?.stopReason === 'length') {
                    // 截断不能静默：记进 warnings + 该会话的时效性提醒，报告里会列出来
                    warnings.push({
                        sessionId: session.id,
                        kind: 'completion-truncated',
                        message: 'analyzer 的输出被 max_tokens 截断（finish_reason=length），这份萃取可能不完整；请调大 analyzerMaxTokens 重跑',
                        inputTokens: completion.usage?.inputTokens ?? null,
                        outputTokens: completion.usage?.outputTokens ?? null,
                    });
                    log?.warn?.(`[analyze] ${session.id} 的模型输出被 max_tokens 截断（finish_reason=length）`);
                }
                const raw = extractJsonObject(typeof completion === 'string' ? completion : completion.text, { keys: ANALYSIS_KEYS });
                raw.__source = provider.name;
                analysis = coerceAnalysis(raw, session);
                if (completion?.stopReason === 'length') {
                    analysis.staleNotes = [...(analysis.staleNotes || []), '模型输出被 max_tokens 截断，萃取可能不完整（已记入报告）'];
                }
            }
            if (!analysis || typeof analysis !== 'object') throw new Error('analyzer 没有返回可用的分析结果');
            if (!analysis.sessionId) analysis.sessionId = session.id;
            if (!analysis.day) analysis.day = session.dateKey || collection.day;
            analysis.truncated = !!transcriptInfo.truncated;
            analysis._source = analysis._source || provider.name;
            analyses.push(analysis);
            log?.info?.(`[analyze] ${i + 1}/${sessions.length} ${session.id}（${transcriptInfo.text.length} 字符）`);
        } catch (err) {
            failures.push({ sessionId: session.id, agent: session.agent, error: err?.message || String(err), code: err?.code || null });
            log?.warn?.(`[analyze] 跳过 ${session.id}：${err?.message || err}`);
        }
        onProgress?.({ phase: 'analyze', done: i + 1, total: sessions.length, sessionId: session.id, failed: failures.length });
    }

    return { analyses, failures, warnings, cost, inputs };
}
