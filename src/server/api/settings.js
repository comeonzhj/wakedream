// 配置读写接口。归属：lead
// 安全约定：对外只暴露「是否已配置 key」，绝不回传 apiKey 明文。
import { HOME, loadConfig, saveConfig, paths } from '../../shared/config.js';

function maskConfig(cfg) {
  const providers = {};
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    providers[name] = {
      baseUrl: p?.baseUrl || null,
      model: p?.model || null,
      hasApiKey: Boolean(p?.apiKey),
      apiKeyEnv: p?.apiKeyEnv || null,
    };
  }
  return { ...cfg, providers, _home: HOME, _configPath: paths.config };
}

// 只允许通过这些键写配置，避免前端塞进任意结构
const WRITABLE = ['port', 'host', 'ui'];
const WRITABLE_OBJECTS = ['lan', 'dream', 'scan', 'providers'];

export function register(router) {
  router.get('/api/settings', async () => ({ settings: maskConfig(loadConfig()) }));

  router.put('/api/settings', async ({ body = {} }) => {
    const patch = {};
    for (const key of WRITABLE) if (body[key] !== undefined) patch[key] = body[key];
    for (const key of WRITABLE_OBJECTS) if (body[key] !== undefined) patch[key] = body[key];
    // providers 里的 apiKey 允许写入；其它字段照写
    const saved = saveConfig(patch);
    return { settings: maskConfig(saved) };
  });
}
