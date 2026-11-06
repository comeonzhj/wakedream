// 格式化与语义映射：时间、数字、agent 品牌色/名、host 标签。
// 全部纯函数，无 DOM 依赖，便于静态自检。

const pad = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD（「当天」按服务器/浏览器本地自然日） */
export function fmtDay(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
export function today() { return fmtDay(new Date()); }
export function shiftDay(dayStr, delta) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  const t = new Date(y, (m || 1) - 1, d || 1);
  t.setDate(t.getDate() + delta);
  return fmtDay(t);
}
export function weekdayCN(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  const t = new Date(y, (m || 1) - 1, d || 1);
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][t.getDay()] || '';
}
export function fmtDayCN(dayStr) {
  if (!dayStr) return '—';
  const [y, m, d] = String(dayStr).split('-').map(Number);
  return `${y} 年 ${m} 月 ${d} 日`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const t = new Date(ts);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const t = new Date(ts);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}
export function fmtDayTime(ts) {
  if (!ts) return '—';
  const t = new Date(ts);
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** Wake 式智能时间：一分钟内「刚刚」、一小时内分钟数、当天时间、昨天、本年月日、更早带年份 */
export function fmtSmart(ts, nowTs = Date.now()) {
  if (!ts) return '—';
  const t = new Date(ts);
  const diff = nowTs - ts;
  if (diff < 60_000 && diff > -60_000) return '刚刚';
  if (diff > 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const todayStart = new Date(new Date(nowTs).getFullYear(), new Date(nowTs).getMonth(), new Date(nowTs).getDate()).getTime();
  if (ts >= todayStart) return fmtTime(ts);
  if (ts >= todayStart - 86_400_000) return `昨天 ${fmtTime(ts)}`;
  if (t.getFullYear() === new Date(nowTs).getFullYear()) return `${t.getMonth() + 1}-${pad(t.getDate())}`;
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN');
}
export function fmtTokens(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------- agent 品牌 ----------
// 静态表只做兜底；/api/agents 返回的 name/color 优先。
export const AGENT_REGISTRY = {
  'claude-code': { name: 'Claude Code', color: '#d97757' },
  codex: { name: 'Codex', color: '#12a06b' },
  dsh: { name: 'DeepSeek Harness', color: '#4d6bfe' },
  'deepseek-harness': { name: 'DeepSeek Harness', color: '#4d6bfe' },
  cursor: { name: 'Cursor', color: '#2db6c8' },
  gemini: { name: 'Gemini CLI', color: '#3b8bd9' },
  'gemini-cli': { name: 'Gemini CLI', color: '#3b8bd9' },
  copilot: { name: 'Copilot CLI', color: '#6e9c3f' },
  kiro: { name: 'Kiro', color: '#9148ff' },
  qoder: { name: 'Qoder', color: '#2bb454' },
  opencode: { name: 'OpenCode', color: '#c98a2e' },
  kimi: { name: 'Kimi Code', color: '#e4739e' },
  antigravity: { name: 'Antigravity', color: '#648ab5' },
  openclaw: { name: 'OpenClaw', color: '#e04a4a' },
  codebuddy: { name: 'CodeBuddy', color: '#6c4dff' },
  workbuddy: { name: 'WorkBuddy', color: '#0ec8a9' },
  hermes: { name: 'Hermes', color: '#e0b040' },
  zcode: { name: 'ZCode', color: '#8b95a5' },
  craft: { name: 'Craft Agents', color: '#9570be' },
  devin: { name: 'Devin', color: '#3bb3f1' },
  pi: { name: 'Pi', color: '#3aae8c' },
  omp: { name: 'Oh My Pi', color: '#b05ce6' },
  grok: { name: 'Grok CLI', color: '#8a7f73' },
};

const agentOverride = new Map();
/** 用 /api/agents 的返回值覆盖静态表（服务端是唯一事实源） */
export function rememberAgents(list) {
  for (const a of list || []) {
    if (!a?.id) continue;
    agentOverride.set(a.id, {
      name: a.name || AGENT_REGISTRY[a.id]?.name || a.id,
      color: normalizeColor(a.color) || AGENT_REGISTRY[a.id]?.color || fallbackColor(a.id),
    });
  }
}
export function agentMeta(id) {
  const key = String(id || '').toLowerCase();
  const ov = agentOverride.get(id) || agentOverride.get(key);
  if (ov) return ov;
  const hit = AGENT_REGISTRY[key] || AGENT_REGISTRY[key.replace(/[_\s]/g, '-')];
  if (hit) return hit;
  return { name: id || '未知 Agent', color: fallbackColor(key) };
}
export function agentColor(id) { return agentMeta(id).color; }
export function agentName(id) { return agentMeta(id).name; }

function normalizeColor(c) {
  if (!c || typeof c !== 'string') return null;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : null;
}
function fallbackColor(seed) {
  const palette = ['#8b95a5', '#7a8dff', '#2bb454', '#c98a2e', '#b05ce6', '#e4739e', '#3aaE8c', '#e04a4a'];
  let h = 0;
  for (const ch of String(seed || 'x')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** host 字段 → 展示标签：local → 本机；ssh:x / lan:x → @x */
export function hostLabel(host) {
  if (!host || host === 'local') return '本机';
  const [kind, id] = String(host).split(':');
  if (kind === 'ssh' || kind === 'lan') return id ? `@${id}` : `@${kind}`;
  return String(host);
}
/** 远端才挂 @host 徽章（本机不挂，保持列表干净） */
export function hostBadge(host) {
  const h = String(host || 'local');
  if (h === 'local') return null;
  return hostLabel(h).replace(/^@/, '@');
}
export function hostKindCN(host) {
  const [kind] = String(host || 'local').split(':');
  if (kind === 'ssh') return 'SSH';
  if (kind === 'lan') return '局域网';
  return '本机';
}

export const DREAM_STATUS = {
  running: { label: '运行中', tone: 'busy' },
  ok: { label: '已完成', tone: 'ok' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  error: { label: '失败', tone: 'bad' },
  pending: { label: '等待中', tone: 'idle' },
};
export function dreamStatus(status) {
  return DREAM_STATUS[status] || { label: status || '未知', tone: 'idle' };
}

export const REMOTE_STATUS = {
  running: { label: '同步中', tone: 'busy' },
  ok: { label: '已同步', tone: 'ok' },
  failed: { label: '同步失败', tone: 'bad' },
  never: { label: '从未同步', tone: 'idle' },
};
export function remoteStatus(s) { return REMOTE_STATUS[s] || REMOTE_STATUS.never; }

export function truncate(s, n = 120) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function firstLine(s, n = 100) {
  const line = String(s ?? '').split('\n').find((l) => l.trim()) || '';
  return truncate(line.trim(), n);
}
export function basename(p) {
  const s = String(p ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
export function homeShort(p, home = '~') {
  const s = String(p ?? '');
  const m = /^\/Users\/[^/]+/.exec(s) || /^\/home\/[^/]+/.exec(s);
  return m ? `${home}${s.slice(m[0].length)}` : s;
}
