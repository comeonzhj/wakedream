// provider 工厂。归属：dream worker。
//
// 契约（ARCHITECTURE.md §6）：
//   export function createProvider(name, cfg): { name, model, async complete({system,messages,maxTokens}) }
// 本实现的 `complete()` 返回 `{ text, usage, model, stopReason }`（usage 用于 dreams.stats 的成本统计）；
// 传入 string 也会被 runDream 归一化，所以调用方拿到对象或字符串都能用。
//
// 扩展面（可选，heuristic 用它做零依赖结构化萃取；模型 provider 不实现）：
//   supportsStructured: true
//   analyzeSession({session, messages, subagents, transcriptInfo}) -> analysis
//   organize({day, store, analyses, prior})                      -> organized
//
// 三个实现：
//   heuristic          默认，零依赖、离线可用，不调模型
//   anthropic          Messages API，ANTHROPIC_API_KEY，默认 claude-sonnet-4-5
//   openai-compatible  /chat/completions，OPENAI_API_KEY + OPENAI_BASE_URL（或配置里 baseUrl/apiKey/model）
import { ProviderError } from './http.js';
import { analyzeSession, organize as organizeHeuristic } from './heuristic.js';
import { createAnthropicProvider, DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL } from './anthropic.js';
import { createOpenAiCompatibleProvider, DEFAULT_MODEL as OPENAI_DEFAULT_MODEL } from './openai-compatible.js';

export const PROVIDER_NAMES = ['heuristic', 'anthropic', 'openai-compatible'];

export function createHeuristicProvider(cfg = {}) {
    return {
        name: 'heuristic',
        kind: 'heuristic',
        model: cfg.model || 'heuristic-v1',
        requiresApiKey: false,
        hasApiKey: true,
        supportsStructured: true,
        analyzeSession,
        organize: organizeHeuristic,
        async complete() {
            throw new ProviderError(
                'heuristic provider 不调用模型，因此没有 complete()；'
                + '请使用结构化的 analyzeSession()/organize()（runDream 在 provider=heuristic 时会自动走这条路）',
                { code: 'E_NO_MODEL' },
            );
        },
    };
}

function normalizeName(name) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return 'heuristic';
    if (key === 'openai' || key === 'openai_compatible' || key === 'openai-compatible' || key === 'chat-completions') return 'openai-compatible';
    if (key === 'claude' || key === 'anthropic-messages') return 'anthropic';
    if (key === 'rules' || key === 'local' || key === 'heuristic-v1') return 'heuristic';
    return key;
}

/**
 * @param {string} name heuristic | anthropic | openai-compatible
 * @param {object} cfg  { apiKey?, baseUrl?, model?, timeoutMs?, retries?, log? }
 */
export function createProvider(name, cfg = {}) {
    switch (normalizeName(name)) {
        case 'heuristic':
            return createHeuristicProvider(cfg);
        case 'anthropic':
            return createAnthropicProvider(cfg);
        case 'openai-compatible':
            return createOpenAiCompatibleProvider(cfg);
        default:
            throw new ProviderError(
                `未知 provider：${name}（可选：${PROVIDER_NAMES.join(' / ')}）`,
                { code: 'E_UNKNOWN_PROVIDER' },
            );
    }
}

/** 默认模型名（给 /api/dream/schedule 与报告用） */
export function defaultModelFor(name) {
    switch (normalizeName(name)) {
        case 'anthropic': return ANTHROPIC_DEFAULT_MODEL;
        case 'openai-compatible': return OPENAI_DEFAULT_MODEL;
        default: return '';
    }
}

export { ProviderError } from './http.js';
export { extractJsonObject, JsonExtractError } from './json-extract.js';
export { coerceAnalysis, coerceOrganized } from './normalize.js';
export { analyzeSession, organize as organizeHeuristic } from './heuristic.js';
