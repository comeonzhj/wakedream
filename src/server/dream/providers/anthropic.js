// anthropic provider：Messages API（`POST {baseUrl}/v1/messages`）。
// 归属：dream worker。零依赖，用内置 fetch；超时/重试在 http.js 里统一处理。
import { pick, postJson, ProviderError, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from './http.js';

export const DEFAULT_MODEL = 'claude-sonnet-4-5';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export function createAnthropicProvider(cfg = {}) {
    const apiKey = pick(cfg.apiKey, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_KEY);
    const baseUrl = pick(cfg.baseUrl, process.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = pick(cfg.model, process.env.ANTHROPIC_MODEL, DEFAULT_MODEL);
    const timeoutMs = Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const retries = cfg.retries === undefined ? DEFAULT_RETRIES : Number(cfg.retries);

    return {
        name: 'anthropic',
        kind: 'anthropic',
        model,
        baseUrl,
        requiresApiKey: true,
        hasApiKey: !!apiKey,

        async complete({ system = '', messages = [], maxTokens = DEFAULT_MAX_TOKENS, temperature = 0 } = {}) {
            if (!apiKey) {
                throw new ProviderError(
                    'anthropic provider 缺少 API key：请设置环境变量 ANTHROPIC_API_KEY，'
                    + '或在 ~/.wakedream/config.json 的 providers.anthropic.apiKey 里配置（不会自动降级）',
                    { code: 'E_NO_API_KEY' },
                );
            }
            const body = {
                model,
                max_tokens: Math.max(2000, Number(maxTokens) || DEFAULT_MAX_TOKENS),
                messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? m.text ?? '') })),
            };
            if (system) body.system = String(system);
            if (temperature) body.temperature = temperature;

            const res = await postJson(`${baseUrl}/v1/messages`, {
                headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
                body,
                timeoutMs,
                retries,
                log: cfg.log,
                label: 'anthropic',
            });
            const json = res.json || {};
            if (json.type === 'error' || json.error) {
                throw new ProviderError(`anthropic 返回错误：${json.error?.message || JSON.stringify(json).slice(0, 300)}`, { code: 'E_PROVIDER', body: json });
            }
            const blocks = Array.isArray(json.content) ? json.content : [];
            const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
            const usage = {
                inputTokens: json.usage?.input_tokens ?? 0,
                outputTokens: json.usage?.output_tokens ?? 0,
                cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
                totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
            };
            if (!text) {
                throw new ProviderError(
                    `anthropic 返回了空文本（stop_reason=${json.stop_reason || '未知'}）：`
                    + '通常是 max_tokens 太小被截断，请调大 maxTokens',
                    { code: 'E_EMPTY_COMPLETION', body: json },
                );
            }
            return { text, usage, model, stopReason: json.stop_reason ?? null, raw: json };
        },
    };
}
