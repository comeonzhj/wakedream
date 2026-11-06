// 接口契约镜像。冻结来源：app/docs/ARCHITECTURE.md §5 + §5.1。
// 这里只允许出现契约里已有的路径；UI 任何网络请求都必须经此文件，禁止在视图里手写 URL。
// 静态自检 test/ui-smoke.test.js 会把本表与 ARCHITECTURE.md §5 的接口清单逐条对齐。

export const API = {
  health: '/api/health',
  settings: '/api/settings',
  agents: '/api/agents',
  projects: '/api/projects',
  sessions: '/api/sessions',
  session: (id) => `/api/sessions/${encodeURIComponent(id)}`,
  stats: '/api/stats',
  scan: '/api/scan',
  remotes: '/api/remotes',
  remote: (id) => `/api/remotes/${encodeURIComponent(id)}`,
  remoteSync: (id) => `/api/remotes/${encodeURIComponent(id)}/sync`,
  syncJob: (jobId) => `/api/sync/jobs/${encodeURIComponent(jobId)}`,
  lanInfo: '/api/lan/info',
  lanPull: '/api/lan/pull',
  lanManifest: '/api/lan/manifest',
  lanBundle: '/api/lan/bundle',
  dreams: '/api/dreams',
  dream: (id) => `/api/dreams/${encodeURIComponent(id)}`,
  dreamRun: '/api/dreams/run',
  dreamSchedule: '/api/dream/schedule',
  memoryTree: '/api/memory/tree',
  memoryFile: '/api/memory/file',
  events: '/api/events',
};

// 契约清单（方法 + 路径模板），供静态自检逐条比对 ARCHITECTURE.md §5 表格。
export const API_CONTRACT = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/settings' },
  { method: 'PUT', path: '/api/settings' },
  { method: 'GET', path: '/api/agents' },
  { method: 'GET', path: '/api/projects' },
  { method: 'GET', path: '/api/sessions' },
  { method: 'GET', path: '/api/sessions/:id' },
  { method: 'GET', path: '/api/stats' },
  { method: 'POST', path: '/api/scan' },
  { method: 'GET', path: '/api/remotes' },
  { method: 'POST', path: '/api/remotes' },
  { method: 'PATCH', path: '/api/remotes/:id' },
  { method: 'DELETE', path: '/api/remotes/:id' },
  { method: 'POST', path: '/api/remotes/:id/sync' },
  { method: 'GET', path: '/api/sync/jobs/:jobId' },
  { method: 'GET', path: '/api/lan/info' },
  { method: 'POST', path: '/api/lan/pull' },
  { method: 'GET', path: '/api/lan/manifest' },
  { method: 'GET', path: '/api/lan/bundle' },
  { method: 'GET', path: '/api/dreams' },
  { method: 'GET', path: '/api/dreams/:id' },
  { method: 'POST', path: '/api/dreams/run' },
  { method: 'DELETE', path: '/api/dreams/:id' },
  { method: 'GET', path: '/api/memory/tree' },
  { method: 'GET', path: '/api/memory/file' },
  { method: 'GET', path: '/api/dream/schedule' },
  { method: 'PUT', path: '/api/dream/schedule' },
  { method: 'GET', path: '/api/events' },
];

// hash 路由表（§6 ui worker 约定）
// group 用于侧栏分组标题（v2 的信息层级：收 → 梦 → 用/系统）
export const ROUTES = [
  { name: 'today', path: '#/today', label: '今日', icon: 'sunrise', title: '今日', group: '会话' },
  { name: 'sessions', path: '#/sessions', label: '全部会话', icon: 'messages', title: '全部会话', group: '会话' },
  { name: 'dreams', path: '#/dreams', label: '梦', icon: 'moon', title: '做梦', group: '记忆' },
  { name: 'memory', path: '#/memory', label: '记忆库', icon: 'brain', title: '记忆库', group: '记忆' },
  { name: 'hosts', path: '#/hosts', label: '设备', icon: 'server', title: '设备', group: '系统' },
  { name: 'settings', path: '#/settings', label: '设置', icon: 'settings', title: '设置', group: '系统' },
];

// 记忆库文件名 → kind 标签（§7 的记忆库形状）
export const MEMORY_KINDS = {
  '_index.md': '索引',
  'decisions.md': '决定',
  'preferences.md': '偏好',
  'open-questions.md': '未决',
  'people.md': '人物',
};
