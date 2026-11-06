#!/usr/bin/env node
// wakedream sync —— 同步远端设备（SSH 镜像 / 局域网拉取）的会话。归属：lead（薄壳，逻辑在 src/server/sync）
// 用法：node bin/sync.js list
//       node bin/sync.js add-ssh <name> <host> [user] [port]
//       node bin/sync.js add-lan <name> <url> <token>
//       node bin/sync.js sync <remoteId|all> [--day YYYY-MM-DD]
import { loadConfig } from '../src/shared/config.js';
import { getDb } from '../src/server/db.js';

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  let sync;
  try {
    sync = await import('../src/server/sync/index.js');
  } catch (err) {
    console.error(`[sync] 同步模块尚不可用：${err.message}`);
    process.exit(2);
  }
  loadConfig();
  getDb();
  if (cmd === 'list' || !cmd) {
    const remotes = sync.listRemotes();
    if (!remotes.length) { console.log('没有登记远端设备。用 add-ssh / add-lan 添加。'); return; }
    for (const r of remotes) {
      console.log(`${r.id}  ${r.kind}  ${r.name}  ${r.kind === 'ssh' ? `${r.user ? `${r.user}@` : ''}${r.host}${r.port ? `:${r.port}` : ''}` : r.url}  ${r.enabled ? 'on' : 'off'}  ${r.lastStatus || 'never'}${r.lastError ? ` (${r.lastError})` : ''}`);
    }
    return;
  }
  if (cmd === 'add-ssh') {
    const [name, host, user, port] = rest;
    if (!name || !host) throw new Error('用法：add-ssh <name> <host> [user] [port]');
    console.log(JSON.stringify(sync.createRemote({ kind: 'ssh', name, host, user, port: port ? Number(port) : undefined }), null, 2));
    return;
  }
  if (cmd === 'add-lan') {
    const [name, url, token] = rest;
    if (!name || !url) throw new Error('用法：add-lan <name> <url> <token>');
    console.log(JSON.stringify(sync.createRemote({ kind: 'lan', name, url, token }), null, 2));
    return;
  }
  if (cmd === 'sync') {
    const target = rest[0];
    const dayIdx = rest.indexOf('--day');
    const day = dayIdx >= 0 ? rest[dayIdx + 1] : undefined;
    const targets = target === 'all' || !target ? sync.listRemotes().filter((r) => r.enabled) : [sync.listRemotes().find((r) => r.id === target || r.name === target)].filter(Boolean);
    if (!targets.length) throw new Error('没有可同步的远端设备');
    for (const r of targets) {
      const { jobId } = await sync.syncRemote(r.id, { day });
      process.stdout.write(`同步 ${r.name} ... `);
      let job = null;
      for (;;) {
        job = sync.getJob(jobId);
        if (job && ['ok', 'failed'].includes(job.status)) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      console.log(`${job.status}：拉取 ${job.pulled ?? 0} 个会话，新增 ${job.added ?? 0}${job.error ? `；错误 ${job.error}` : ''}`);
    }
    return;
  }
  console.error('未知子命令。可用：list | add-ssh | add-lan | sync');
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
