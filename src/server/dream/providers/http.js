// provider 共用的 HTTP 核心：超时 + 指数退避重试 + 明确的错误分类。
// 归属：dream worker。零依赖，只用内置 fetch（Node >= 22.5）。
export class ProviderError extends Error {
    constructor(message, { code = 'E_PROVIDER', status = null, retriable = false, body = null } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.code = code;
        this.status = status;
        this.retriable = retriable;
        this.body = body;
    }
}

export const DEFAULT_TIMEOUT_MS = 180000;   // 单次请求 3 分钟（推理模型会慢）
export const DEFAULT_RETRIES = 2;           // 失败后再试 2 次：共最多 3 次请求

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST JSON，带超时与最多 `retries` 次指数退避重试（1s、2s + 抖动）。
 * 重试条件：网络错误 / 超时 / 408 / 429 / 5xx。4xx（非 429）直接失败，不浪费配额。
 * @returns {Promise<{status:number, json:any, text:string, attempts:number}>}
 */
export async function postJson(url, {
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    log = null,
    label = 'provider',
} = {}) {
    const payload = JSON.stringify(body ?? {});
    let lastError = null;
    const maxAttempts = Math.max(1, (Number(retries) || 0) + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: payload,
                signal: controller.signal,
            });
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
            if (!res.ok) {
                const retriable = res.status === 408 || res.status === 429 || res.status >= 500;
                const detail = json?.error?.message || json?.message || text.slice(0, 400);
                const err = new ProviderError(
                    `${label} HTTP ${res.status}${detail ? `：${detail}` : ''}`,
                    { code: res.status === 401 || res.status === 403 ? 'E_AUTH' : 'E_HTTP', status: res.status, retriable, body: json },
                );
                if (retriable && attempt < maxAttempts) {
                    lastError = err;
                    const wait = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
                    log?.warn?.(`${label} 第 ${attempt} 次失败（${err.message}），${wait}ms 后重试`);
                    await sleep(wait);
                    continue;
                }
                throw err;
            }
            return { status: res.status, json, text, attempts: attempt };
        } catch (err) {
            if (err instanceof ProviderError && !err.retriable) throw err;
            const isAbort = err?.name === 'AbortError';
            const wrapped = err instanceof ProviderError
                ? err
                : new ProviderError(
                    isAbort ? `${label} 请求超时（${timeoutMs}ms）` : `${label} 请求失败：${err?.message || err}`,
                    { code: isAbort ? 'E_TIMEOUT' : 'E_NETWORK', retriable: true },
                );
            if (attempt < maxAttempts) {
                lastError = wrapped;
                const wait = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
                log?.warn?.(`${label} 第 ${attempt} 次失败（${wrapped.message}），${wait}ms 后重试`);
                await sleep(wait);
                continue;
            }
            throw wrapped;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError || new ProviderError(`${label} 未知失败`, { code: 'E_PROVIDER' });
}

/** 从各种 provider 配置来源里解析出一个非空字符串（显式 cfg > 环境变量 > 默认） */
export function pick(...candidates) {
    for (const value of candidates) {
        if (value === undefined || value === null) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return '';
}
