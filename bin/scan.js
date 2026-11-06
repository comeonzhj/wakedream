#!/usr/bin/env node
// wakedream scan —— 扫描本机（可选远端）会话入库。归属：lead（薄壳，逻辑在 src/server/sessions）
// 用法：node bin/scan.js [--full] [--json]
import { loadConfig } from '../src/shared/config.js';
import { getDb } from '../src/server/db.js';

const args = process.argv.slice(2);
const full = args.includes('--full');
const asJson = args.includes('--json');

async function main() {
  let mod;
  try {
    mod = await import('../src/server/sessions/index.js');
  } catch (err) {
    console.error(`[scan] 会话模块尚不可用：${err.message}`);
    process.exit(2);
  }
  if (typeof mod.scanLocal !== 'function') {
    console.error('[scan] src/server/sessions/index.js 未导出 scanLocal()');
    process.exit(2);
  }
  getDb();
  loadConfig();
  const result = await mod.scanLocal({ full });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`扫描完成：新增 ${result.added ?? 0}，更新 ${result.updated ?? 0}，共扫描 ${result.scanned ?? 0} 个会话文件，用时 ${result.durationMs ?? 0}ms`);
    for (const err of result.errors ?? []) console.error(`  ! ${err}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
