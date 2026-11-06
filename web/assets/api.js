// 极薄的 fetch 封装：统一 JSON、统一错误语义。
// 后端模块可能还没写完——任何 404/500/网络失败都要给出可读原因，绝不吞掉、绝不白屏。
import { API } from './contract.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, path = '', detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
  get missing() { return this.status === 404; }
  get serverFault() { return this.status >= 500; }
}

function withQuery(path, params) {
  if (!params) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parse(res, path) {
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 400) }; }
  }
  if (!res.ok) {
    let msg = body?.error || `HTTP ${res.status}`;
    if (res.status === 404) msg = body?.error || '接口不存在（后端该模块可能还没实现）';
    throw new ApiError(msg, { status: res.status, code: body?.code ?? null, path, detail: body });
  }
  return body;
}

export async function apiGet(path, params) {
  let res;
  try {
    res = await fetch(withQuery(path, params), { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ApiError(`无法连接后端：${err.message}`, { status: 0, path });
  }
  return parse(res, path);
}

export async function apiSend(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(`无法连接后端：${err.message}`, { status: 0, path });
  }
  return parse(res, path);
}

export const apiPut = (path, body) => apiSend('PUT', path, body);
export const apiPost = (path, body) => apiSend('POST', path, body);
export const apiPatch = (path, body) => apiSend('PATCH', path, body);
export const apiDelete = (path) => apiSend('DELETE', path);

/** 把任意异常翻译成空态/错误态要用的三段话。 */
export function describeError(err, what = '数据') {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return {
        title: '后端未启动',
        desc: `无法加载${what}。请先运行 node app/src/server/main.js，或用 web/dev-mock-server.mjs 起假数据服务。`,
        code: err.message,
      };
    }
    if (err.missing) {
      return {
        title: '接口尚未就绪',
        desc: `${what}所依赖的接口还没实现（${err.path}）。后端 worker 写完后刷新即可。`,
        code: `404 ${err.path}`,
      };
    }
    if (err.serverFault) {
      return {
        title: '后端返回错误',
        desc: `${what}加载失败：${err.message}`,
        code: `${err.status}${err.code ? ` ${err.code}` : ''}`,
      };
    }
    return { title: '请求被拒绝', desc: `${what}加载失败：${err.message}`, code: `${err.status} ${err.path}` };
  }
  return { title: '出现意外错误', desc: String(err?.message || err), code: '' };
}

export { API };
