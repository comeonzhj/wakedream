// openai-compatible provider：`POST {baseUrl}/chat/completions`。
// 归属：dream worker。兼容 OpenAI / DeepSeek / 各类中转端点。
//
// 推理模型（如 DeepSeek-V4.1-Flash）的坑，这里显式处理：
//   - 思维过程可能只出现在 `message.reasoning_content`，而 `message.content` 为空；
//   - 被 `finish_reason: 'length'` 截断时 content 也会是空的。
// 这两种情况都不静默吞掉：明确报错，并把 finish_reason / usage 带进错误信息。
import { pick, postJson, ProviderError, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from './http.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 4096;

function completionsUrl(baseUrl) {
    const base = String(baseUrl).replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}

export function createOpenAiCompatibleProvider(cfg = {}) {
    const apiKey = pick(cfg.apiKey, process.env.OPENAI_API_KEY, process.env.OPENAI_KEY, process.env.LLM_API_KEY);
    const baseUrl = pick(cfg.baseUrl, process.env.OPENAI_BASE_URL, process.env.OPENAI_API_BASE, DEFAULT_BASE_URL);
    const model = pick(cfg.model, process.env.OPENAI_MODEL, process.env.LLM_MODEL, DEFAULT_MODEL);
    const timeoutMs = Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const retries = cfg.retries === undefined ? DEFAULT_RETRIES : Number(cfg.retries);
    const url = completionsUrl(baseUrl);

    return {
        name: 'openai-compatible',
        kind: 'openai-compatible',
        model,
        baseUrl,
        url,
        requiresApiKey: true,
        hasApiKey: !!apiKey,

        async complete({ system = '', messages = [], maxTokens = DEFAULT_MAX_TOKENS, temperature = 0 } = {}) {
            if (!apiKey) {
                throw new ProviderError(
                    'openai-compatible provider 缺少 API key：请设置环境变量 OPENAI_API_KEY，'
                    + '或在 ~/.wakedream/config.json 的 providers["openai-compatible"].apiKey 里配置（不会自动降级）',
                    { code: 'E_NO_API_KEY' },
                );
            }
            const payload = [];
            if (system) payload.push({ role: 'system', content: String(system) });
            for (const m of messages) {
                payload.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? m.text ?? '') });
            }
            const body = {
                model,
                messages: payload,
                // 推理模型需要足够的输出预算（>=2000），否则 content 会被截空
                max_tokens: Math.max(2000, Number(maxTokens) || DEFAULT_MAX_TOKENS),
                stream: false,
            };
            if (temperature) body.temperature = temperature;

            const res = await postJson(url, {
                headers: { authorization: `Bearer ${apiKey}` },
                body,
                timeoutMs,
                retries,
                log: cfg.log,
                label: 'openai-compatible',
            });
            const json = res.json || {};
            if (json.error) {
                throw new ProviderError(`openai-compatible 返回错误：${json.error.message || JSON.stringify(json.error).slice(0, 300)}`, { code: 'E_PROVIDER', body: json });
            }
            const choice = json.choices?.[0] || {};
            const message = choice.message || {};
            const content = String(message.content ?? '').trim();
            const reasoning = String(message.reasoning_content ?? message.reasoning ?? '').trim();
            const usage = {
                inputTokens: json.usage?.prompt_tokens ?? 0,
                outputTokens: json.usage?.completion_tokens ?? 0,
                totalTokens: json.usage?.total_tokens ?? ((json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0)),
            };
            if (!content) {
                const why = choice.finish_reason === 'length'
                    ? '输出被 max_tokens 截断（finish_reason=length）'
                    : (reasoning ? '只有 reasoning_content，content 为空' : '响应里没有 content');
                throw new ProviderError(
                    `openai-compatible 返回了空文本：${why}；finish_reason=${choice.finish_reason || '未知'}，`
                    + `usage=${JSON.stringify(usage)}。请调大 maxTokens（建议 >=2000）或换用非推理模型。`,
                    { code: 'E_EMPTY_COMPLETION', body: json },
                );
            }
            return {
                text: content,
                usage,
                model: json.model || model,
                stopReason: choice.finish_reason ?? null,
                reasoning: reasoning || null,
                raw: json,
            };
        },
    };
}
