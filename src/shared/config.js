// WakeDream 全局配置与路径。所有进程（server / cli / cron 任务）都从这里取路径，不要各自拼 home。
// 归属：lead（冻结契约文件，其他 worker 只读，不要改）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'WakeDream';
export const VERSION = '0.1.0';

export const HOME = process.env.WAKEDREAM_HOME || path.join(os.homedir(), '.wakedream');

export const paths = {
  home: HOME,
  db: path.join(HOME, 'db.sqlite'),
  config: path.join(HOME, 'config.json'),
  cache: path.join(HOME, 'cache'),
  remote: path.join(HOME, 'cache', 'remote'),
  blob: path.join(HOME, 'cache', 'blobs'),
  memory: path.join(HOME, 'memory'),
  dreams: path.join(HOME, 'memory', 'dreams'),
  logs: path.join(HOME, 'logs'),
};

export function ensureHome() {
  for (const dir of [paths.home, paths.cache, paths.remote, paths.blob, paths.memory, paths.dreams, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths.home;
}

export function defaultConfig() {
  return {
    port: 4680,
    host: '127.0.0.1',
    // 局域网同步：本机把当天会话以只读清单暴露给同一局域网内的另一台设备拉取
    lan: {
      enabled: false,
      token: '',                 // 为空时首次开启自动生成
      deviceName: os.hostname(),
      bindAll: false,            // true 时监听 0.0.0.0，否则只监听 127.0.0.1
    },
    // 夜间做梦
    dream: {
      enabled: false,            // 由 wakedream 常驻进程按 at 触发；也可交给系统 cron 调 bin/dream.js
      at: '03:30',
      provider: 'heuristic',     // heuristic | anthropic | openai-compatible
      model: '',
      windowDays: 1,             // 处理「当天」；>1 表示回溯若干天
      maxSessions: 60,
      maxCharsPerSession: 24000, // 单会话喂给模型的字符上限（超长截断并标注）
      storeName: 'default',
    },
    providers: {
      // 例：{ "anthropic": { "apiKey": "...", "baseUrl": "https://api.anthropic.com" } }
      //     { "openai-compatible": { "apiKey": "...", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" } }
    },
    scan: {
      extraRoots: [],            // [{ id, agent, dir }]
      disabledAgents: [],
    },
    ui: { defaultRange: 'today', theme: 'system' },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function loadConfig() {
  ensureHome();
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`[config] 读取 ${paths.config} 失败，使用默认配置：${err.message}`);
  }
  return deepMerge(defaultConfig(), fileCfg);
}

export function saveConfig(cfg) {
  ensureHome();
  const merged = deepMerge(loadConfig(), cfg ?? {});
  fs.writeFileSync(paths.config, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export function mergeConfig(patch) {
  return saveConfig(patch);
}

// 常用的小工具：把毫秒时间戳/日期串统一成当天（服务器本地时区）的 00:00:00–23:59:59.999
export function dayRange(dayStr) {
  const base = dayStr ? new Date(`${dayStr}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) throw new Error(`非法日期：${dayStr}`);
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000 - 1);
  return { start, end, day: fmtDay(start) };
}

export function fmtDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
