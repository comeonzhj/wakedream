// 同步层测试：
//   ① SSH —— 用假的 ssh / rsync 可执行脚本桩（PATH 前置注入）验证命令构造、白名单、镜像入库与错误处理；
//   ② 局域网 —— 起两个**真实** http 实例（各自的临时 WAKEDREAM_HOME + 随机端口），验证
//      manifest / bundle / token 校验 / pull 幂等。
// 全程使用临时 WAKEDREAM_HOME，绝不污染真实的 ~/.wakedream。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'wakedream-sync-'));
process.env.WAKEDREAM_HOME = path.join(SCRATCH, 'home');
process.env.DSH_HOME = path.join(FIX, 'dsh-home');

const sync = await import('../src/server/sync/index.js');
const sshMod = await import('../src/server/sync/ssh.js');
const store = await import('../src/server/sessions/store.js');
const sessions = await import('../src/server/sessions/index.js');
const { closeDb } = await import('../src/server/db.js');

const CHILDREN = [];

test.after(() => {
    for (const child of CHILDREN) {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    closeDb();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
});

/* ------------------------------------------------------------ 工具 */

/** 造一个假的 rsync/ssh 可执行桩，返回伪造的 PATH 目录 */
function makeStubBin() {
    const bin = path.join(SCRATCH, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(SCRATCH, 'commands.log');
    fs.writeFileSync(log, '');

    // 假 rsync：--version 正常退 0；否则记录 argv，并按白名单把 fixture 会话“拉”到目标目录
    fs.writeFileSync(path.join(bin, 'rsync'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "rsync  version 3.2.7"; exit 0; fi
echo "rsync $*" >> "$FAKE_SYNC_LOG"
if [ -n "$FAKE_RSYNC_FAIL" ]; then
  echo "rsync: connection unexpectedly closed (fake)" >&2
  echo "rsync error: unexplained error (code 255) at io.c(228) [sender=3.2.7]" >&2
  exit "$FAKE_RSYNC_FAIL"
fi
count=$#
dest=$(eval echo \\$$count)
src=$(eval echo \\$$((count-1)))
rel=\${src#*:}
rel=\${rel%/}
mkdir -p "$dest"
case "$rel" in
  .dsh/sessions)
    mkdir -p "$dest/wakefx-remote/rem-0001"
    cp "$FAKE_DSH_FIXTURE" "$dest/wakefx-remote/rem-0001/session.v4.jsonl"
    ;;
esac
exit 0
`, { mode: 0o755 });

    // 假 ssh：记录 argv；`--version` 退 0；`tar -cf -` 时把 fixture 打成 tar 流到 stdout
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "OpenSSH_9.6p1"; exit 0; fi
echo "ssh $*" >> "$FAKE_SYNC_LOG"
case "$*" in
  *"tar -cf -"*)
    "$FAKE_TAR_BIN" -cf - -C "$FAKE_TAR_ROOT" .dsh/sessions
    ;;
esac
exit 0
`, { mode: 0o755 });

    // 无 rsync 的 PATH：把 rsync 藏起来，只留假 ssh（用来验证 tar 兜底）
    const noRsync = path.join(SCRATCH, 'bin-no-rsync');
    fs.mkdirSync(noRsync, { recursive: true });
    fs.copyFileSync(path.join(bin, 'ssh'), path.join(noRsync, 'ssh'));
    fs.chmodSync(path.join(noRsync, 'ssh'), 0o755);
    // 降级路径要真起本地 `tar -xf -`，所以这个受限 PATH 里得有 tar、但没有 rsync
    if (!fs.existsSync(path.join(noRsync, 'tar'))) fs.symlinkSync('/usr/bin/tar', path.join(noRsync, 'tar'));

    return { bin, noRsync, log };
}

async function waitJob(jobId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = sync.getJob(jobId);
        if (job && job.status !== 'running') return job;
        if (Date.now() > deadline) throw new Error(`任务超时未完成：${jobId}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

function localDay(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------- 白名单 / 命令构造 */

test('ssh：白名单只含会话目录，凭证与库文件被明确拒绝', () => {
    const rels = sshMod.syncPaths().map((w) => w.rel);
    for (const expected of ['.claude/projects', '.codex/sessions', '.dsh/sessions', '.cursor/projects']) {
        assert.ok(rels.includes(expected), `白名单缺少 ${expected}`);
    }
    for (const denied of [
        '.ssh/id_rsa', '.claude/auth.json', '.codex/auth.json', '.dsh/session.token',
        '.config/gh/hosts.yml', 'certs/server.pem', 'key.key', 'state_5.sqlite',
    ]) {
        assert.equal(sshMod.isDenied(denied), true, `${denied} 必须被拒绝`);
    }
    // 白名单本身一个都不该被拒绝名单命中
    for (const rel of rels) assert.equal(sshMod.isDenied(rel), false, `${rel} 被误杀`);
});

test('ssh：rsync 命令只用白名单路径、BatchMode、绝不写远端', () => {
    const remote = { id: 'r1', host: 'build-box', user: 'tester', port: 2222, root: '/home/tester' };
    const args = sshMod.buildRsyncArgs(remote, '.dsh/sessions', '/tmp/mirror/.dsh/sessions');
    assert.equal(args[0], '-a');
    assert.ok(args.includes('--delete'), '镜像目录要 --delete 保持与远端一致');
    assert.ok(args.includes('-e'));
    assert.match(args[args.indexOf('-e') + 1], /ssh .*BatchMode=yes/);
    assert.match(args[args.indexOf('-e') + 1], /-p 2222/);
    assert.equal(args[args.length - 2], 'tester@build-box:/home/tester/.dsh/sessions/');
    assert.equal(args[args.length - 1], '/tmp/mirror/.dsh/sessions/');
    // 命令里不能出现任何凭证路径
    for (const a of args) assert.equal(sshMod.isDenied(a), false, `命令里出现了被拒路径：${a}`);
});

test('ssh：host/user/port/root 里的 shell 元字符一律拒绝', () => {
    for (const remote of [
        { host: 'a; rm -rf /' },
        { host: 'a b' },
        { host: 'ok', user: 'u$(whoami)' },
        { host: 'ok', port: '22; ls' },
        { host: 'ok', root: '/tmp/$(x)' },
    ]) {
        assert.throws(() => sshMod.assertSafeRemote(remote), /非法/);
    }
    assert.equal(sshMod.assertSafeRemote({ host: 'build-box', user: 'tester', port: 22, root: '/home/t' }), true);
    // user@host 写法要拆得开
    assert.deepEqual(sshMod.splitHost({ host: 'tester@build-box' }), { user: 'tester', host: 'build-box' });
});

/* ------------------------------------------------------- SSH 端到端 */

test('ssh：用假 rsync 走完 创建远端 → 同步 → 镜像入库 → job/remotes 状态', async () => {
    const { bin, log } = makeStubBin();
    const oldPath = process.env.PATH;
    // PATH 只留桩目录 + /bin：确保解析到的是桩、而不是系统里的真 rsync/ssh
    process.env.PATH = `${bin}${path.delimiter}/bin`;
    process.env.FAKE_SYNC_LOG = log;
    process.env.FAKE_TAR_BIN = '/usr/bin/tar';
    process.env.FAKE_DSH_FIXTURE = path.join(FIX, 'dsh', 'session.v4.jsonl');
    delete process.env.FAKE_RSYNC_FAIL;
    try {
        const remote = sync.createRemote({ kind: 'ssh', id: 'ssh-test', name: 'build-box', host: 'build-box', user: 'tester' });
        assert.equal(remote.id, 'ssh-test');
        assert.equal(remote.kind, 'ssh');

        const { jobId } = await sync.syncRemote('ssh-test');
        assert.ok(jobId);
        const job = await waitJob(jobId);
        assert.equal(job.error, null);
        assert.ok(['ok', 'partial'].includes(job.status), `状态异常：${job.status}`);
        assert.equal(job.pulled, 1);

        // 镜像落盘 + 用本机适配器入库，host/source 都是 ssh:<remoteId>
        const mirrored = path.join(sshMod.mirrorRoot('ssh-test'), '.dsh', 'sessions', 'wakefx-remote', 'rem-0001', 'session.v4.jsonl');
        assert.ok(fs.existsSync(mirrored), `镜像文件不存在：${mirrored}`);
        const sess = sessions.getSession('ssh:ssh-test:dsh:dsh-v4-0003');
        assert.ok(sess, '远端会话没入库');
        assert.equal(sess.host, 'ssh:ssh-test');
        assert.equal(sess.source, 'ssh:ssh-test');
        assert.equal(sess.agent, 'dsh');
        assert.equal(sess.title, 'README 安装命令改 npx');
        assert.equal(sess.messageCount, 8);

        // 远端登记状态
        const stored = sync.getRemote('ssh-test');
        assert.equal(stored.lastStatus, 'ok');
        assert.ok(stored.lastSync > 0);

        // 命令里出现的是白名单路径，没有凭证
        const commands = fs.readFileSync(log, 'utf8').trim().split('\n');
        assert.ok(commands.length >= 1);
        for (const line of commands) {
            assert.ok(!/auth\.json|\.ssh\/|\.token|\.pem|\.sqlite/.test(line), `命令碰到凭证：${line}`);
        }
        assert.ok(commands.some((l) => l.includes('.dsh/sessions')));

        // 只读：每条 rsync 都是「远端:路径 → 本地镜像目录」的方向，本地端是最后一个参数
        const rsyncLines = commands.filter((l) => l.startsWith('rsync '));
        assert.ok(rsyncLines.length >= 1);
        for (const line of rsyncLines) {
            assert.match(line, /tester@build-box:\S+/);
            const dest = line.trim().split(/\s+/).pop();
            assert.ok(dest.startsWith(sshMod.mirrorRoot('ssh-test')), `目标必须是本机镜像目录：${dest}`);
        }
    } finally {
        process.env.PATH = oldPath;
    }
});

test('ssh：rsync 失败时 job 失败，stderr 尾部进 last_error', async () => {
    const { bin, log } = makeStubBin();
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}/bin`;
    process.env.FAKE_SYNC_LOG = log;
    process.env.FAKE_TAR_BIN = '/usr/bin/tar';
    process.env.FAKE_DSH_FIXTURE = path.join(FIX, 'dsh', 'session.v4.jsonl');
    process.env.FAKE_RSYNC_FAIL = '255';
    try {
        sync.createRemote({ kind: 'ssh', id: 'ssh-fail', name: 'dead-box', host: 'dead-box', user: 'tester' });
        const { jobId } = await sync.syncRemote('ssh-fail');
        const job = await waitJob(jobId);
        assert.equal(job.status, 'failed');
        assert.match(job.error, /ssh 连接失败/);
        const stored = sync.getRemote('ssh-fail');
        assert.equal(stored.lastStatus, 'failed');
        assert.match(stored.lastError, /connection unexpectedly closed/);
    } finally {
        process.env.PATH = oldPath;
        delete process.env.FAKE_RSYNC_FAIL;
    }
});

test('ssh：没有 rsync 时降级为 ssh+tar 流式拉取', async () => {
    const { noRsync, log } = makeStubBin();
    const oldPath = process.env.PATH;
    // rsync 不在 PATH 里（只有桩 ssh + /bin），验证优雅降级
    process.env.PATH = `${noRsync}${path.delimiter}/bin`;
    process.env.FAKE_SYNC_LOG = log;
    process.env.FAKE_TAR_ROOT = path.join(FIX, 'ssh-home');
    process.env.FAKE_TAR_BIN = '/usr/bin/tar';
    try {
        assert.equal(sshMod.hasCommand('rsync'), false);
        sync.createRemote({ kind: 'ssh', id: 'ssh-tar', name: 'tar-box', host: 'tar-box', user: 'tester' });
        const { jobId } = await sync.syncRemote('ssh-tar');
        const job = await waitJob(jobId);
        assert.equal(job.error, null, job.error ?? '');
        assert.ok(job.pulled >= 1);
        const commands = fs.readFileSync(log, 'utf8').trim().split('\n');
        assert.ok(commands.some((l) => l.includes('tar -cf -')), '应该走 tar 兜底');
        assert.ok(sessions.getSession('ssh:ssh-tar:dsh:dsh-v4-0003'));
    } finally {
        process.env.PATH = oldPath;
    }
});

test('ssh：PATCH / DELETE 远端会同时清掉该 host 的远程会话', async () => {
    const sess = sessions.getSession('ssh:ssh-test:dsh:dsh-v4-0003');
    assert.ok(sess);
    const updated = sync.updateRemote('ssh-test', { name: 'renamed-box', port: 2200 });
    assert.equal(updated.name, 'renamed-box');
    assert.equal(updated.port, 2200);
    const res = sync.deleteRemote('ssh-test');
    assert.equal(res.ok, true);
    assert.ok(res.removed >= 1);
    assert.equal(sessions.getSession('ssh:ssh-test:dsh:dsh-v4-0003'), null);
    assert.equal(sync.getRemote('ssh-test'), null);
});

/* ----------------------------------------------------------- 局域网 */

/** 起一个真实实例（子进程），返回 {port, base, child} */
async function startInstance({ name, port, lan }) {
    const home = path.join(SCRATCH, name);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({
        port,
        host: '127.0.0.1',
        lan,
    }, null, 2)}\n`);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { start } = await import(${JSON.stringify(path.join(APP_ROOT, 'src/server/main.js'))});
        await start();
    `], {
        env: {
            ...process.env,
            WAKEDREAM_HOME: home,
            PORT: String(port),
            DSH_HOME: path.join(FIX, 'dsh-home'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    CHILDREN.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`实例 ${name} 启动即退出：${stderr}`);
        try {
            const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) break;
        } catch { /* 还没起来 */ }
        if (Date.now() > deadline) throw new Error(`实例 ${name} 启动超时：${stderr}`);
        await new Promise((r) => setTimeout(r, 100));
    }
    return { home, base, child, stderr: () => stderr };
}

/** 让内核分配一个空闲端口：固定端口段在并行跑多个测试文件时会互相抢占（曾经因此偶发失败）。 */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

test('局域网：两个真实实例，manifest/bundle/token/pull 幂等 + @host 徽章', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const TOKEN = 'peer-token-fixture-1';
    const peer = await startInstance({
        name: 'peer',
        port: portA,
        lan: { enabled: true, token: TOKEN, deviceName: 'peer-fixture' },
    });
    const local = await startInstance({
        name: 'local',
        port: portB,
        lan: { enabled: false, token: '', deviceName: 'local-fixture' },
    });

    // 对端先把 fixture 会话扫进来
    const scan = await (await fetch(`${peer.base}/api/scan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full: true }),
    })).json();
    assert.equal(scan.added, 3);

    // token 校验：错 token 401，没开启的实例 403
    const bad = await fetch(`${peer.base}/api/lan/manifest?token=wrong`);
    assert.equal(bad.status, 401);
    const disabled = await fetch(`${local.base}/api/lan/manifest?token=${TOKEN}`);
    assert.equal(disabled.status, 403);

    // manifest 只给元数据，不给正文/路径
    const manifest = await (await fetch(`${peer.base}/api/lan/manifest?token=${TOKEN}`)).json();
    assert.equal(manifest.device, 'peer-fixture');
    assert.equal(manifest.sessions.length, 3);
    for (const item of manifest.sessions) {
        assert.deepEqual(Object.keys(item).sort(),
            ['agent', 'bytes', 'id', 'messageCount', 'project', 'sha256', 'startedAt', 'title']);
        assert.match(item.sha256, /^[0-9a-f]{64}$/);
    }

    // bundle：首行 session，随后逐行 message；本机路径必须为空
    const first = manifest.sessions[0];
    const bundleText = await (await fetch(`${peer.base}/api/lan/bundle?token=${TOKEN}&id=${encodeURIComponent(first.id)}`)).text();
    const lines = bundleText.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'session');
    assert.equal(lines[0].session.filePath, null, 'filePath 必须脱敏');
    assert.equal(lines[0].session.host, 'local');
    assert.ok(lines.slice(1).every((l) => l.type === 'message'));
    const bundle401 = await fetch(`${peer.base}/api/lan/bundle?token=nope&id=${encodeURIComponent(first.id)}`);
    assert.equal(bundle401.status, 401);

    // 本机对端信息
    const info = await (await fetch(`${peer.base}/api/lan/info`)).json();
    assert.equal(info.enabled, true);
    assert.equal(info.token, TOKEN);
    assert.equal(info.deviceName, 'peer-fixture');
    assert.ok(info.urls.length >= 1 && info.urls.every((u) => /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(u)));
    assert.match(info.pair, /^wakedream:\/\/pair\?url=/);

    // pull：异步任务 → 会话以 lan:<remoteId> 落库
    const pull = await (await fetch(`${local.base}/api/lan/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: peer.base, token: TOKEN }),
    })).json();
    assert.ok(pull.jobId);
    const job = await waitJobRemote(local.base, pull.jobId);
    assert.equal(job.status, 'ok');
    assert.equal(job.pulled, 3);
    assert.equal(job.added, 3);

    const remotes = await (await fetch(`${local.base}/api/remotes`)).json();
    assert.equal(remotes.remotes.length, 1);
    const remoteId = remotes.remotes[0].id;
    assert.equal(remotes.remotes[0].kind, 'lan');
    assert.equal(remotes.remotes[0].name, 'peer-fixture');
    assert.equal(remotes.remotes[0].lastStatus, 'ok');
    assert.equal(remotes.remotes[0].sessionCount, 3);

    const listed = await (await fetch(`${local.base}/api/sessions?limit=50`)).json();
    assert.equal(listed.total, 3);
    assert.ok(listed.sessions.every((s) => s.host === `lan:${remoteId}`));
    assert.ok(listed.sessions.every((s) => s.source === `lan:${remoteId}`));
    assert.ok(listed.sessions.every((s) => s.filePath === null));
    assert.deepEqual(listed.facets.hosts, [{ id: `lan:${remoteId}`, name: '@peer-fixture', count: 3 }]);
    // 正文确实过来了（中文标题/搜索可用）
    const searched = await (await fetch(`${local.base}/api/sessions?q=${encodeURIComponent('npx')}`)).json();
    assert.equal(searched.total, 1);
    const detail = await (await fetch(`${local.base}/api/sessions/${encodeURIComponent(searched.sessions[0].id)}`)).json();
    assert.ok(detail.messages.length > 0);
    assert.ok(detail.messages.some((m) => m.role === 'user' && /npx/.test(m.text)), '正文要完整同步过来');
    assert.equal(detail.messages[0].seq, 0);
    assert.equal(detail.messages[0].kind, 'meta', '系统提示归 meta');

    // 幂等：再拉一次是 updated，不是 added，总数不变
    const pull2 = await (await fetch(`${local.base}/api/lan/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: peer.base, token: TOKEN }),
    })).json();
    const job2 = await waitJobRemote(local.base, pull2.jobId);
    assert.equal(job2.status, 'ok');
    assert.equal(job2.added, 0);
    assert.equal(job2.updated, 3);
    const after = await (await fetch(`${local.base}/api/sessions?limit=50`)).json();
    assert.equal(after.total, 3);
    const remotesAfter = await (await fetch(`${local.base}/api/remotes`)).json();
    assert.equal(remotesAfter.remotes.length, 1, '重复拉取不该重复登记远端');

    // 错 token 拉取：任务失败，错误信息留在 job 与 remotes.last_error
    const pull3 = await (await fetch(`${local.base}/api/lan/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: peer.base, token: 'nope' }),
    })).json();
    const job3 = await waitJobRemote(local.base, pull3.jobId);
    assert.equal(job3.status, 'failed');
    assert.match(job3.error, /401/);
});

test('局域网：按 day 拉取只拿当天的会话', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const TOKEN = 'peer-token-fixture-2';
    const peer = await startInstance({
        name: 'peer2', port: portA, lan: { enabled: true, token: TOKEN, deviceName: 'peer-2' },
    });
    const local = await startInstance({
        name: 'local2', port: portB, lan: { enabled: false, token: '', deviceName: 'local-2' },
    });
    await fetch(`${peer.base}/api/scan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full: true }),
    });

    // dsh fixture 的 startedAt = 1788000000000（本地日）；只拉这一天应该只拿到 1 条
    const day = localDay(1788000000000);
    const pull = await (await fetch(`${local.base}/api/lan/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: peer.base, token: TOKEN, day }),
    })).json();
    const job = await waitJobRemote(local.base, pull.jobId);
    assert.equal(job.pulled, 1);
    const listed = await (await fetch(`${local.base}/api/sessions?limit=50`)).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.sessions[0].nativeId, 'dsh-v4-0003');
});

async function waitJobRemote(base, jobId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const res = await fetch(`${base}/api/sync/jobs/${jobId}`);
        const { job } = await res.json();
        if (job.status !== 'running') return job;
        if (Date.now() > deadline) throw new Error(`远端任务超时：${jobId}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

/* ------------------------------------------------- 远端会话只读性 */

test('远端会话禁删：remotes 的 DELETE 只清缓存与会话记录，不动源文件', async () => {
    const remote = sync.createRemote({ kind: 'lan', id: 'lan-readonly', name: 'x', url: 'http://127.0.0.1:1' });
    store.importSession(`lan:${remote.id}`, `lan:${remote.id}`, {
        nativeId: 'n1', agent: 'dsh', project: 'p', title: '远端会话',
        startedAt: 1, endedAt: 2, messageCount: 1, isSubagent: false, parentNativeId: null, extra: {},
    }, [{ seq: 0, role: 'user', kind: 'text', ts: 1, text: 'hi', meta: {} }]);
    assert.ok(sessions.getSession(`lan:${remote.id}:dsh:n1`));
    sync.deleteRemote(remote.id);
    assert.equal(sessions.getSession(`lan:${remote.id}:dsh:n1`), null);
});
