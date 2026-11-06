#!/usr/bin/env node
// wakedream dream —— 夜间做梦：把某一天的会话萃取成 wiki 式记忆库。归属：lead（薄壳，逻辑在 src/server/dream）
// 用法：node bin/dream.js [--day YYYY-MM-DD] [--provider ...] [--model X] [--window-days N] [--dry-run] [--force] [--json] [--no-scan]
// 适合交给系统 cron / launchd：每天 03:30 跑一次。
// 默认**先扫描本机会话再做梦**——夜间任务要整理的是「当天所有 agent 作业的会话」，只梦不扫会漏掉白天新写的会话。
import { loadConfig } from '../src/shared/config.js';
import { getDb } from '../src/server/db.js';

function parseArgs(argv) {
  const out = { day: null, provider: null, model: null, dryRun: false, force: false, json: false, windowDays: null, scan: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--day') out.day = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--window-days') out.windowDays = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--no-scan') out.scan = false;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node bin/dream.js [--day YYYY-MM-DD] [--provider heuristic|anthropic|openai-compatible] [--model X] [--window-days N] [--dry-run] [--force] [--json] [--no-scan]');
    return;
  }
  let mod;
  try {
    mod = await import('../src/server/dream/index.js');
  } catch (err) {
    console.error(`[dream] 做梦模块尚不可用：${err.message}`);
    process.exit(2);
  }
  const config = loadConfig();
  getDb();
  // 夜间任务的完整动作：先收（扫描会话入库），再梦（萃取记忆）
  if (args.scan) {
    try {
      const sessions = await import('../src/server/sessions/index.js');
      if (typeof sessions.scanLocal === 'function') {
        const scan = await sessions.scanLocal({});
        if (!args.json) {
          console.log(`扫描本机会话：新增 ${scan.added ?? 0}，更新 ${scan.updated ?? 0}，检查 ${scan.scanned ?? 0} 个文件`);
          for (const err of scan.errors ?? []) console.error(`  ! 扫描告警：${err}`);
        }
      }
    } catch (err) {
      console.warn(`[dream] 扫描会话失败（继续做梦）：${err.message}`);
    }
  }
  const opts = {
    day: args.day || undefined,
    provider: args.provider || config.dream.provider,
    model: args.model || config.dream.model || undefined,
    windowDays: args.windowDays ?? config.dream.windowDays,
    dryRun: args.dryRun,
    force: args.force,
  };
  const result = await mod.runDream(opts);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const fileCount = typeof result.stats?.files === 'number'
      ? result.stats.files
      : (Array.isArray(result.stats?.fileList) ? result.stats.fileList.length
        : (Array.isArray(result.stats?.files) ? result.stats.files.length : '?'));
    console.log(`做梦完成：day=${result.day ?? opts.day ?? '今天'} status=${result.status} 会话 ${result.stats?.sessionCount ?? '?'} 个，产出 ${fileCount} 个记忆文件`);
    if (result.stats?.cost?.totalTokens) console.log(`模型用量：${result.stats.cost.calls} 次调用，${result.stats.cost.totalTokens} tokens`);
    if (result.memoryDir) console.log(`记忆库：${result.memoryDir}`);
    if (result.reportPath) console.log(`报告：${result.reportPath}`);
    if (result.error) console.error(`错误：${result.error}`);
  }
  if (result.status === 'failed') process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
