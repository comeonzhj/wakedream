// sessions 模块的对外门面（契约见 ARCHITECTURE §6）。
//   listAgents() / scanLocal() / querySessions() / getSession() / getMessages() / monthStats()
// 其余导出是给 api 层与同步层用的内部能力（适配器表、远端镜像扫描、host 标签等）。
export { listAgents, getAgent, canonicalAgentId, AGENT_IDS } from './registry.js';
export { scanLocal, scanTargets, scanTree, detectAgents, isScanning } from './scan.js';
export {
    querySessions, monthStats, stats, agentsOverview, listProjects, hostLabel, resolveRange,
} from './query.js';
export { getSession, getMessages } from './storeApi.js';
export { previewsFor } from './store.js';
export { getAdapter, ADAPTERS } from './adapters/index.js';
export { globalId, clearHost, pruneMissing } from './store.js';
