// 极简 HTTP 路由。归属：lead（冻结契约文件）
// 每个 api 模块导出 register(router)，main.js 按固定顺序加载。
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), pattern, segments, handler, name: opts.name || pattern });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== decodeURIComponent(parts[i])) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase() || route.method === 'ALL') return { route, params };
    }
    return { route: null, params: {}, pathMatched };
  }

  list() {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

export function json(res, body, status = 200) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function notFound(res, message = 'not found') {
  json(res, { error: message }, 404);
}

export function badRequest(res, message) {
  json(res, { error: message }, 400);
}

export function serverError(res, err) {
  const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
  json(res, { error: err?.message || String(err), code: err?.code }, status);
}

// 带 HTTP 状态码的错误：main.js 的兜底 catch 会按 status 回响应，而不是一律 500
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
  }
}

export function requireJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) return;
}

export async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, `请求体超过 ${limitBytes} 字节`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch { throw new HttpError(400, '请求体不是合法 JSON', 'INVALID_JSON'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return { raw };
}

export async function readRawBody(req, limitBytes = 512 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error(`请求体超过 ${limitBytes} 字节`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function query(url) {
  return Object.fromEntries(new URL(url, 'http://localhost').searchParams);
}
