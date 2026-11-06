// 本机 Agent 注册表（静态）。归属：sessions worker。
// 品牌名与品牌色对齐 Wake（`reference/Wake/web/src/lib/agents.ts` 与 `crates/wake-core/src/models.rs`
// 的 AgentId::ALL 声明序），顺序即侧栏展示序——新增 agent 时请保持与 Wake 同一顺序。
// roots 里的 `env` 是该 agent 自己认的配置目录环境变量；设置时**整体替换**家目录前缀，
// 与 Wake 一致（Claude Code 的 CLAUDE_CONFIG_DIR、Codex 的 CODEX_HOME、XDG_DATA_HOME 派生的几个）。
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = os.homedir();

/** agent 清单：id/name/color/roots(env 相对规格) */
const REGISTRY = [
    {
        id: 'claude-code', name: 'Claude Code', color: '#D97757',
        roots: [{ env: 'CLAUDE_CONFIG_DIR', base: ['projects'], fallback: ['.claude', 'projects'] }],
        adapter: 'claude',
    },
    {
        id: 'codex', name: 'Codex', color: '#7A8DFF',
        roots: [
            { env: 'CODEX_HOME', base: ['sessions'], fallback: ['.codex', 'sessions'] },
            { env: 'CODEX_HOME', base: ['archived_sessions'], fallback: ['.codex', 'archived_sessions'] },
        ],
        adapter: 'codex',
    },
    { id: 'qoder', name: 'Qoder CLI', color: '#2BB454', roots: [{ env: null, base: null, fallback: ['.qoder', 'projects'] }], adapter: 'qoder' },
    { id: 'copilot', name: 'Copilot CLI', color: '#6E9C3F', roots: [{ env: null, base: null, fallback: ['.copilot'] }], adapter: null },
    {
        id: 'cursor', name: 'Cursor', color: '#2DB6C8',
        roots: [{ env: null, base: null, fallback: ['.cursor', 'projects'] }],
        adapter: 'cursor',
    },
    {
        id: 'opencode', name: 'OpenCode', color: '#C98A2E',
        roots: [{ env: 'XDG_DATA_HOME', base: ['opencode'], fallback: ['.local', 'share', 'opencode'] }],
        adapter: null,
    },
    { id: 'kiro', name: 'Kiro', color: '#9148FF', roots: [{ env: null, base: null, fallback: ['.kiro', 'sessions', 'cli'] }], adapter: 'kiro' },
    { id: 'gemini', name: 'Gemini CLI', color: '#3B8BD9', roots: [{ env: null, base: null, fallback: ['.gemini', 'tmp'] }], adapter: 'gemini' },
    { id: 'pi', name: 'Pi', color: '#3AAE8C', roots: [{ env: null, base: null, fallback: ['.pi', 'agent', 'sessions'] }], adapter: null },
    { id: 'omp', name: 'Oh My Pi', color: '#B05CE6', roots: [{ env: null, base: null, fallback: ['.omp', 'agent', 'sessions'] }], adapter: null },
    { id: 'grok', name: 'Grok Build', color: '#8A7F73', roots: [{ env: null, base: null, fallback: ['.grok', 'sessions'] }], adapter: null },
    { id: 'grok-bot', name: 'Grok Bot', color: '#AC396D', roots: [], adapter: null },
    {
        id: 'kimi', name: 'Kimi Code', color: '#E4739E',
        roots: [{ env: null, base: null, fallback: ['.kimi-code', 'sessions'] }],
        adapter: 'kimi',
    },
    {
        id: 'antigravity', name: 'Antigravity', color: '#648AB5',
        roots: [{ env: null, base: null, fallback: ['.gemini', 'antigravity', 'brain'] }],
        adapter: null,
    },
    { id: 'dsh', name: 'DeepSeek Harness', color: '#4D6BFE', roots: [{ env: 'DSH_HOME', base: ['sessions'], fallback: ['.dsh', 'sessions'] }], adapter: 'dsh' },
    { id: 'hermes', name: 'Hermes Agent', color: '#E0B040', roots: [{ env: null, base: null, fallback: ['.hermes'] }], adapter: null },
    { id: 'openclaw', name: 'OpenClaw', color: '#E04A4A', roots: [{ env: null, base: null, fallback: ['.openclaw', 'agents'] }], adapter: null },
    { id: 'codebuddy', name: 'CodeBuddy', color: '#6C4DFF', roots: [{ env: null, base: null, fallback: ['.codebuddy', 'projects'] }], adapter: null },
    { id: 'workbuddy', name: 'WorkBuddy', color: '#0EC9A9', roots: [{ env: null, base: null, fallback: ['.workbuddy', 'projects'] }], adapter: null },
    {
        id: 'zcode', name: 'ZCode', color: '#8B95A5',
        roots: [{ env: 'XDG_DATA_HOME', base: ['zcode'], fallback: ['.zcode'] }],
        adapter: null,
    },
    { id: 'craft-agents', name: 'Craft Agents', color: '#9570BE', roots: [{ env: null, base: null, fallback: ['.craft-agent', 'workspaces'] }], adapter: null },
    {
        id: 'devin', name: 'Devin', color: '#3BB3F1',
        roots: [{ env: 'XDG_DATA_HOME', base: ['devin'], fallback: ['.local', 'share', 'devin'] }],
        adapter: null,
    },
    {
        id: 'kilo', name: 'Kilo Code', color: '#C8C035',
        roots: [{ env: 'XDG_DATA_HOME', base: ['kilo'], fallback: ['.local', 'share', 'kilo'] }],
        adapter: null,
    },
    {
        id: 'mimo-code', name: 'MiMo Code', color: '#FF6900',
        roots: [{ env: 'XDG_DATA_HOME', base: ['mimocode'], fallback: ['.local', 'share', 'mimocode'] }],
        adapter: null,
    },
];

/** 查询过滤用的 id 别名（面板/接口里常见写法 → 注册表 canonical id） */
export const AGENT_ALIASES = {
    claude: 'claude-code',
    claudecode: 'claude-code',
    'gemini-cli': 'gemini',
    geminicli: 'gemini',
    deepseek: 'dsh',
    'deepseek-harness': 'dsh',
    cursoride: 'cursor',
    'kimi-cli': 'kimi',
    kimicode: 'kimi',
};

export function canonicalAgentId(id) {
    const raw = String(id ?? '').trim();
    if (!raw) return raw;
    if (REGISTRY.some((a) => a.id === raw)) return raw;
    return AGENT_ALIASES[raw.toLowerCase()] ?? raw;
}

/** 展开一条 root 规格为绝对路径 */
function resolveRoot(spec, env = process.env) {
    if (!spec) return null;
    if (spec.env) {
        const override = env[spec.env];
        if (override && String(override).trim()) {
            const base = String(override).trim();
            // 环境变量给的就是 agent 的配置根；base 为 null 表示该根就是家目录本身
            return spec.base ? path.join(base, ...spec.base) : base;
        }
    }
    return path.join(HOME_DIR, ...spec.fallback);
}

/**
 * 静态 registry。roots 已按当前进程环境解析成 `{dir, env}`（env 为 null 表示该目录没有覆盖变量）。
 * `adapter` 为 null 的 agent 只做展示（本实现未写它的解析器），扫描时会被跳过。
 */
export function listAgents() {
    return REGISTRY.map((a) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        adapter: a.adapter,
        roots: a.roots.map((spec) => ({ dir: resolveRoot(spec), env: spec.env ?? null })),
    }));
}

export function getAgent(id) {
    const canonical = canonicalAgentId(id);
    return listAgents().find((a) => a.id === canonical) ?? null;
}

/** 可被扫描的 agent（有适配器且有根目录规格） */
export function scannableAgents() {
    return listAgents().filter((a) => a.adapter);
}

export const AGENT_IDS = REGISTRY.map((a) => a.id);
