// HTTP 服务入口：静态 UI + /api/*。归属：lead（冻结契约文件）
// 各 worker 的 api 模块通过 register(router) 挂路由；模块缺失时服务照常启动（便于并行开发与增量验证）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, VERSION, HOME, loadConfig, paths } from '../shared/config.js';
import { makeLogger } from '../shared/log.js';
import { getDb } from './db.js';
import { Router, json, notFound, serverError, query, readBody } from './router.js';

const log = makeLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 桌面端（Tauri）把 web/ 作为 bundle 资源随应用分发，路径与源码树不同，用 WAKEDREAM_WEB_DIR 指过去；
// 命令行/开发态默认仍是源码树里的 ../web。
const WEB_DIR = path.resolve(process.env.WAKEDREAM_WEB_DIR || path.resolve(__dirname, '../../web'));

// 固定加载顺序：health（lead）→ sessions/scan（会话摄入）→ dream/memory（做梦）→ remotes/lan（同步）
const API_MODULES = [
  './api/health.js',
  './api/sessions.js',
  './api/scan.js',
  './api/dream.js',
  './api/memory.js',
  './api/remotes.js',
  './api/lan.js',
  './api/settings.js',
];

export async function buildRouter() {
  const router = new Router();
  const loaded = [];
  const missing = [];
  for (const spec of API_MODULES) {
    try {
      const mod = await import(spec);
      if (typeof mod.register !== 'function') {
        missing.push(`${spec}（未导出 register）`);
        continue;
      }
      mod.register(router);
      loaded.push(spec);
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(spec.replace('./', ''))) {
        missing.push(spec);
      } else {
        missing.push(`${spec}（${err.message}）`);
        log.warn(`加载 ${spec} 失败：${err.message}`);
      }
    }
  }
  return { router, loaded, missing };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(WEB_DIR, `.${rel}`);
  if (!target.startsWith(WEB_DIR)) return notFound(res, 'forbidden');
  const candidates = [target];
  if (!path.extname(target)) candidates.push(path.join(WEB_DIR, 'index.html')); // SPA 兜底
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return undefined;
    } catch { /* 下一个候选 */ }
  }
  return notFound(res, `静态资源不存在：${rel}`);
}

export function createServer(router) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const started = Date.now();
    res.on('close', () => {
      if (process.env.WAKEDREAM_HTTP_LOG) log.info(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const { route, params, pathMatched } = router.match(req.method, pathname);
        if (!route) return notFound(res, pathMatched ? `方法不允许：${req.method} ${pathname}` : `未知接口：${pathname}`);
        // 带请求体的方法：在调用 handler 前统一读好 body（JSON / 表单），handler 用 ctx.body
        let body = {};
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          body = await readBody(req);
        }
        const ctx = {
          req,
          res,
          params,
          query: query(req.url),
          body,
          url,
          config: loadConfig(),
          log,
        };
        const result = await route.handler(ctx);
        if (result !== undefined && !res.writableEnded) json(res, result);
        return undefined;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res, 'only GET is served for static assets');
      return serveStatic(req, res, pathname);
    } catch (err) {
      log.error(`${req.method} ${pathname} 失败：${err?.stack || err}`);
      if (!res.writableEnded) serverError(res, err);
      return undefined;
    }
  });
}

export async function start() {
  const config = loadConfig();
  getDb();
  const { router, loaded, missing } = await buildRouter();
  const server = createServer(router);
  const port = Number(process.env.PORT || config.port || 4680);
  const host = config.lan?.enabled && config.lan?.bindAll ? '0.0.0.0' : (process.env.HOST || config.host || '127.0.0.1');
  await new Promise((resolve) => server.listen(port, host, resolve));
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  log.info(`${APP_NAME} v${VERSION} 已启动：http://${shown}:${port}  （数据目录 ${HOME}）`);
  log.info(`api 模块：已加载 ${loaded.length} 个${missing.length ? `，缺失 ${missing.join('、')}` : ''}`);
  if (process.env.WAKEDREAM_PRINT_ROUTES) for (const line of router.list()) log.info(`  ${line}`);

  const cfg = loadConfig();
  if (cfg.dream?.enabled) {
    try {
      const { startScheduler } = await import('./dream/scheduler.js');
      await startScheduler({ config: cfg, log });
    } catch (err) {
      log.warn(`做梦调度未启动：${err.message}`);
    }
  }
  return { server, port, host, router };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  start().catch((err) => {
    log.error(err?.stack || err);
    process.exit(1);
  });
}

export { paths };
