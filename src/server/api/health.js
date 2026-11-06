// 健康检查与运行时信息。归属：lead
import { APP_NAME, VERSION, HOME, loadConfig } from '../../shared/config.js';
import { getDb, metaGet } from '../db.js';

export function register(router) {
  router.get('/api/health', async () => {
    getDb();
    return {
      ok: true,
      app: APP_NAME,
      version: VERSION,
      home: HOME,
      now: Date.now(),
      lastScanAt: Number(metaGet('last_scan_at') || 0) || null,
      lastDreamAt: Number(metaGet('last_dream_at') || 0) || null,
      lan: (() => {
        const c = loadConfig();
        return { enabled: !!c.lan?.enabled, deviceName: c.lan?.deviceName || null };
      })(),
    };
  });
}
