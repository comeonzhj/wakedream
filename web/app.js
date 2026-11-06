// WakeDream 前端入口：hash 路由 + 应用外壳（侧栏 / 顶栏 / 主题 / 全局动作）。
// 手写 ESM，无打包器；所有数据都走后端 JSON 接口（路径常量集中在 assets/contract.js），
// 字段名严格按 ARCHITECTURE.md §5 + §5.1。
import { API, ROUTES } from './assets/contract.js';
import { apiGet, apiPost, describeError } from './assets/api.js';
import { icon } from './assets/icons.js';
import { rememberAgents, today, fmtDay, fmtNum, fmtDateTime } from './assets/format.js';
import { h, clear, fromHtml, toast, prefs, errorBlock, wireCopyButtons } from './assets/ui.js';

const viewModules = {
  today: () => import('./views/today.js'),
  sessions: () => import('./views/sessions.js'),
  session: () => import('./views/session.js'),
  dreams: () => import('./views/dreams.js'),
  memory: () => import('./views/memory.js'),
  hosts: () => import('./views/hosts.js'),
  settings: () => import('./views/settings.js'),
};

// ---------- 全局状态 ----------
export const state = {
  health: null,
  agents: [],
  settings: null,
  busy: null,        // {label, detail, determinate, value}
  view: null,        // 当前视图句柄 {destroy?, refresh?}
  route: null,
  sse: null,
};

const listeners = new Map();
export const bus = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  },
  emit(name, payload) {
    for (const fn of listeners.get(name) || []) {
      try { fn(payload); } catch (err) { console.warn('[bus]', name, err); }
    }
  },
};

// ---------- 主题与外观 ----------
const mq = window.matchMedia('(prefers-color-scheme: dark)');
// 调试/截图用：?theme=dark|light|system 在本次会话内覆盖外观，不写入 localStorage。
const themeOverride = new URLSearchParams(location.search).get('theme');

export function currentThemeMode() {
  if (themeOverride) return themeOverride;
  const p = prefs.read();
  return p.theme || state.settings?.ui?.theme || 'system';
}
export function effectiveTheme() {
  const mode = currentThemeMode();
  if (mode === 'light' || mode === 'dark') return mode;
  return mq.matches ? 'dark' : 'light';
}
export function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const mode = currentThemeMode();
    btn.innerHTML = icon(mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : effectiveTheme() === 'dark' ? 'moon' : 'sun', 16);
    btn.title = `外观：${mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色' : '深色'}（点击切换）`;
  }
  applyZoom();
}
export function setThemeMode(mode) {
  prefs.write({ theme: mode });
  applyTheme();
  bus.emit('theme', mode);
}
export function applyZoom() {
  const p = prefs.read();
  const zoom = Number(p.zoom) || 1;
  document.documentElement.style.setProperty('--zoom', String(zoom));
}
mq.addEventListener('change', () => { if (currentThemeMode() === 'system') applyTheme(); });

// ---------- 路由 ----------
export function parseRoute(hash = location.hash || '#/today') {
  const raw = hash.replace(/^#/, '') || '/today';
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  const head = segs[0] || 'today';
  if (head === 'sessions' && segs[1]) return { name: 'session', id: decodeURIComponent(segs.slice(1).join('/')), query, hash };
  if (head === 'dreams' && segs[1]) return { name: 'dreams', id: decodeURIComponent(segs[1]), query, hash };
  const known = new Set(Object.keys(viewModules));
  return { name: known.has(head) ? head : 'today', id: null, query, hash };
}

function routeMeta(name) {
  if (name === 'session') return { label: '转录阅读', icon: 'messages', title: '会话转录' };
  return ROUTES.find((r) => r.name === name) || ROUTES[0];
}

function renderNav(route) {
  const nav = document.getElementById('nav');
  clear(nav);
  const activeName = route.name === 'session' ? 'sessions' : route.name;
  let lastGroup = null;
  for (const r of ROUTES) {
    // 侧栏分组标题：层级靠分组表达，不靠缩进堆叠（参照物的侧栏做法）
    if (r.group && r.group !== lastGroup) {
      lastGroup = r.group;
      nav.append(h('div', { class: 'nav-group-head', text: r.group }));
    }
    const btn = h(
      'button',
      { class: `nav-row ${r.name === activeName ? 'is-active' : ''}`, type: 'button' },
      h('span', { class: 'nav-icon', html: icon(r.icon, 16) }),
      h('span', { class: 'nav-label', text: r.label }),
      r.badge ? h('span', { class: 'nav-count', text: r.badge }) : null,
    );
    btn.addEventListener('click', () => { location.hash = r.path; });
    nav.append(btn);
  }
}

// 指针／键盘模态：只有键盘操作才画焦点环（参照物：指针模态下焦点环透明）
function trackInputModality() {
  const setModality = (mode) => document.documentElement.setAttribute('data-input-modality', mode);
  setModality('pointer');
  window.addEventListener('pointerdown', () => setModality('pointer'), true);
  window.addEventListener('keydown', (e) => {
    if (['Tab', 'Enter', ' ', 'Escape'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) setModality('keyboard');
  }, true);
}

export function setTopbar({ title, sub = '', note = '' }) {
  const t = document.getElementById('page-title');
  const s = document.getElementById('page-sub');
  const n = document.getElementById('topbar-note');
  if (title) t.textContent = title;
  s.textContent = sub;
  n.textContent = note;
}

export function navigate(target) {
  if (location.hash === target) mount();
  else location.hash = target;
}

// ---------- 挂载视图 ----------
let mountToken = 0;

async function mount() {
  const token = ++mountToken;
  const host = document.getElementById('view');
  let route;
  try {
    route = parseRoute();
  } catch (err) {
    // 路由解析本身出错也必须给出错误态，绝不白屏
    console.error('[route]', err);
    clear(host);
    host.append(errorBlock(err, '路由'));
    return;
  }
  state.route = route;
  const meta = routeMeta(route.name);
  renderNav(route);
  setTopbar({ title: meta.title || meta.label, sub: '' });
  document.title = `WakeDream · ${meta.title || meta.label}`;

  state.view?.destroy?.();
  state.view = null;
  clear(host);

  const loader = viewModules[route.name] || viewModules.today;
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    host.append(errorBlock(err, '页面模块'));
    return;
  }
  if (token !== mountToken) return;

  const ctx = {
    route,
    navigate,
    setTopbar,
    state,
    bus,
    reload: () => { if (token === mountToken) mount(); },
    refreshShell: () => refreshShell(),
    onEvent: (name, fn) => bus.on(name, fn),
  };
  try {
    state.view = (await mod.default.render(host, ctx)) || null;
  } catch (err) {
    console.error('[view]', err);
    host.append(errorBlock(err, meta.title || '页面'));
  }
}

window.addEventListener('hashchange', mount);

// ---------- 侧栏状态行 ----------
function setStatus({ text, tone = '', progress = null }) {
  const line = document.getElementById('status-line');
  const track = document.getElementById('progress-track');
  clear(line);
  line.append(h('span', { class: `status-dot ${tone ? `is-${tone}` : ''}` }));
  line.append(h('span', { class: 'status-text', text, title: text }));
  if (progress === null || progress === undefined) {
    track.hidden = true;
  } else {
    track.hidden = false;
    const bar = track.firstElementChild;
    if (progress === 'indeterminate') {
      bar.classList.remove('is-determinate');
      bar.style.width = '30%';
    } else {
      bar.classList.add('is-determinate');
      bar.style.width = `${Math.max(4, Math.min(100, progress))}%`;
    }
  }
}

export function setBusy(label, detail = '', progress = 'indeterminate') {
  state.busy = label ? { label, detail } : null;
  const btnScan = document.getElementById('btn-scan');
  const btnDream = document.getElementById('btn-dream');
  if (label) {
    setStatus({ text: `${label}${detail ? ` · ${detail}` : ''}`, tone: 'busy', progress });
    if (btnScan) btnScan.disabled = true;
    if (btnDream) btnDream.disabled = true;
  } else {
    refreshShell();
    if (btnScan) btnScan.disabled = false;
    if (btnDream) btnDream.disabled = false;
    setTopbarNote('');
  }
}
function setTopbarNote(text) {
  document.getElementById('topbar-note').textContent = text;
}

// ---------- 全局动作 ----------
export async function runScan({ full = false } = {}) {
  if (state.busy) { toast({ title: '已有任务在跑', body: state.busy.label, tone: 'info' }); return null; }
  setBusy('正在扫描本机会话', full ? '全量重扫' : '增量');
  setTopbarNote('扫描中：正在读取本机各 Agent 的数据目录…');
  try {
    const res = await apiPost(API.scan, full ? { full: true } : {});
    setTopbarNote(`扫描完成：新增 ${res.added ?? 0} · 更新 ${res.updated ?? 0} · 共 ${res.scanned ?? 0} 个会话 · ${Math.round((res.durationMs ?? 0) / 100) / 10}s`);
    const errs = res.errors || [];
    toast({
      title: '扫描完成',
      body: `扫描 ${res.scanned ?? 0} · 新增 ${res.added ?? 0} · 更新 ${res.updated ?? 0}${errs.length ? ` · ${errs.length} 个目录读不了` : ''}`,
      tone: errs.length ? 'info' : 'ok',
    });
    bus.emit('scan:done', res);
    state.view?.refresh?.();
    refreshShell();
    return res;
  } catch (err) {
    const d = describeError(err, '扫描');
    setTopbarNote(`${d.title}：${d.desc}`);
    toast({ title: '扫描失败', body: d.desc, tone: 'bad' });
    return null;
  } finally {
    setBusy(null);
  }
}

export async function runDream({ day = today(), provider, force = false } = {}) {
  if (state.busy) { toast({ title: '已有任务在跑', body: state.busy.label, tone: 'info' }); return null; }
  setBusy('正在做梦', day);
  setTopbarNote(`做梦中：把 ${day} 的会话萃取成记忆库…`);
  const started = Date.now();
  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    setStatus({ text: `正在做梦 · ${day} · ${s}s`, tone: 'busy', progress: 'indeterminate' });
    setTopbarNote(`做梦中：已运行 ${s}s（heuristic 供应商秒级完成，走模型时可能要一两分钟）`);
  }, 1000);
  try {
    const body = { day };
    if (provider) body.provider = provider;
    if (force) body.force = true;
    const res = await apiPost(API.dreamRun, body);
    toast({ title: '做梦完成', body: `记忆库已写入 ${res.memoryDir || '（未返回路径）'}`, tone: 'ok' });
    setTopbarNote(`做梦完成：${res.status || 'ok'} · 会话 ${res.sessionCount ?? '—'}`);
    bus.emit('dream:done', res);
    state.view?.refresh?.();
    refreshShell();
    return res;
  } catch (err) {
    const d = describeError(err, '做梦');
    setTopbarNote(`做梦失败：${d.desc}`);
    toast({ title: '做梦失败', body: d.desc, tone: 'bad' });
    return null;
  } finally {
    clearInterval(ticker);
    setBusy(null);
  }
}

// ---------- 外壳刷新（健康状态 / 计数） ----------
export async function refreshShell() {
  try {
    const health = await apiGet(API.health);
    state.health = health;
    const parts = [];
    if (health.version) parts.push(`v${health.version}`);
    if (health.home) parts.push(health.home);
    if (health.sessions !== undefined) parts.push(`${fmtNum(health.sessions)} 会话`);
    if (health.db?.sessions !== undefined) parts.push(`${fmtNum(health.db.sessions)} 会话`);
    setStatus({ text: parts.join(' · ') || '后端已连接', tone: 'ok' });
  } catch (err) {
    const d = describeError(err, '运行状态');
    setStatus({ text: `${d.title}：请启动 app/src/server/main.js`, tone: 'bad' });
  }
}

export async function loadAgents() {
  try {
    const res = await apiGet(API.agents);
    state.agents = res.agents || [];
    rememberAgents(state.agents);
  } catch {
    state.agents = [];
  }
}

export async function loadSettings() {
  try {
    const res = await apiGet(API.settings);
    state.settings = res.settings || res || null;
  } catch {
    state.settings = null;
  }
}

// ---------- SSE（可选；后端没实现时静默） ----------
function subscribeEvents() {
  if (state.sse || typeof EventSource === 'undefined') return;
  try {
    const es = new EventSource(API.events);
    state.sse = es;
    const relay = (name) => es.addEventListener(name, (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch { data = ev.data; }
      bus.emit(name, data);
      if (name === 'scan:done') { refreshShell(); state.view?.refresh?.(); }
      if (name === 'dream:done') { refreshShell(); state.view?.refresh?.(); }
    });
    for (const name of ['session:new', 'scan:done', 'dream:progress', 'dream:done', 'sync:progress']) relay(name);
    es.addEventListener('error', () => { /* 后端未实现 SSE 时浏览器会自动重连，保持安静 */ });
  } catch { /* 忽略 */ }
}

// ---------- 启动 ----------
function boot() {
  applyTheme();
  trackInputModality();
  const btnTheme = document.getElementById('theme-toggle');
  btnTheme.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const cur = currentThemeMode();
    setThemeMode(order[(order.indexOf(cur) + 1) % order.length]);
  });
  document.getElementById('btn-scan').addEventListener('click', () => runScan({}));
  document.getElementById('btn-dream').addEventListener('click', () => runDream({}));
  wireCopyButtons(document.body);

  // ⌘K / Ctrl+K：跳到会话页搜索
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      navigate('#/sessions?focus=q');
    }
  });

  if (!location.hash) location.hash = '#/today';
  mount();
  refreshShell();
  loadAgents().then(() => state.view?.refresh?.());
  loadSettings();
  subscribeEvents();
  setInterval(refreshShell, 30_000);
}

boot();
