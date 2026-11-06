// SSH 远端同步。对齐 Wake 的 Remote hosts：SSH 拉取**只读**、只拉白名单目录、绝不碰凭证。
//
// 命令构造原则（安全）：
//   1. 只用 `child_process.spawn/execFile`（**不过 shell**），host/user/port/root 先过白名单正则，
//      任何含空白或 shell 元字符的值直接拒绝——不给远端 shell 解释的机会。
//   2. 远端命令只有 `rsync`（拉）与 `tar -cf -`（流式兜底），两者都不写远端。
//   3. 传输路径只能来自本文件的 WHITELIST；DENY_PATTERNS 是第二道闸：命中的路径永远不会进命令。
//   4. 镜像落到 `~/.wakedream/cache/remote/<remoteId>/`，再交给本机同一套适配器解析入库。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from '../../shared/config.js';
import { hasAdapterFor, scanTargets } from '../sessions/scan.js';
import { finishJob, jobLog } from './jobs.js';
import { getRemote, hostOf, markRemoteSync } from './remotes.js';

/**
 * 白名单：远端家目录下的会话目录（对齐 Wake README 的 "Remote hosts" 与
 * `crates/wake-core/src/remote.rs` 的 RemoteAgentLayout 中本实现支持的那几个 agent）。
 * 只能增补这些「会话数据」路径；凭证目录一律不进。
 */
export const WHITELIST = [
    { agent: 'claude-code', rel: '.claude/projects' },
    { agent: 'codex', rel: '.codex/sessions' },
    { agent: 'codex', rel: '.codex/archived_sessions' },
    { agent: 'dsh', rel: '.dsh/sessions' },
    { agent: 'cursor', rel: '.cursor/projects' },
    { agent: 'qoder', rel: '.qoder/projects' },
    { agent: 'kiro', rel: '.kiro/sessions/cli' },
    { agent: 'gemini', rel: '.gemini/tmp' },
    { agent: 'kimi', rel: '.kimi-code/sessions' },
];

/**
 * 明确拒绝名单：即使有人把它塞进白名单也会被拦住。
 * 覆盖 SSH/云凭证、token、私钥、以及 Wake 自己也不拉的库文件。
 */
export const DENY_PATTERNS = [
    /(^|\/)\.ssh(\/|$)/i,
    /(^|\/)\.aws(\/|$)/i,
    /(^|\/)\.gnupg(\/|$)/i,
    /(^|\/)\.config\/gh(\/|$)/i,
    /auth\.json$/i,
    /auth-profiles\.json$/i,
    /credentials?/i,
    /\.token$/i,
    /\.pem$/i,
    /\.key$/i,
    /id_(rsa|ed25519|ecdsa)/i,
    /oauth/i,
    /\.netrc$/i,
    /keychain/i,
    /\.sqlite(-wal|-shm)?$/i,
    /\.db(-wal|-shm)?$/i,
];

/** host / user / port / root 的合法形状（拒绝空白与一切 shell 元字符） */
const SAFE_HOST = /^[A-Za-z0-9._:@\-[\]]+$/;
const SAFE_USER = /^[A-Za-z0-9._-]+$/;
const SAFE_ROOT = /^[A-Za-z0-9._/~-]+$/;

export function assertSafeRemote(remote) {
    const host = String(remote.host ?? '').trim();
    if (!host) throw new Error('远端缺少 host');
    if (!SAFE_HOST.test(host)) throw new Error(`host 含非法字符：${host}`);
    if (remote.user && !SAFE_USER.test(String(remote.user))) throw new Error(`user 含非法字符：${remote.user}`);
    if (remote.port !== null && remote.port !== undefined && remote.port !== '') {
        const port = Number(remote.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port 非法：${remote.port}`);
    }
    if (remote.root && !SAFE_ROOT.test(String(remote.root))) throw new Error(`root 含非法字符：${remote.root}`);
    return true;
}

/** 白名单路径是否被拒绝名单命中（第二道闸） */
export function isDenied(rel) {
    return DENY_PATTERNS.some((re) => re.test(rel));
}

/** 该次同步真正要拉的路径（白名单 ∩ 非拒绝） */
export function syncPaths() {
    return WHITELIST.filter((w) => !isDenied(w.rel));
}

/** `user@host` 形式的 host 拆成 user/host（Wake 允许直接填 ssh config 别名或 user@host） */
export function splitHost(remote) {
    const raw = String(remote.host ?? '').trim();
    if (remote.user) return { user: String(remote.user), host: raw };
    const at = raw.lastIndexOf('@');
    if (at > 0) return { user: raw.slice(0, at), host: raw.slice(at + 1) };
    return { user: null, host: raw };
}

function sshArgs(remote) {
    const { host } = splitHost(remote);
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
    if (remote.port) args.push('-p', String(remote.port));
    args.push(host);
    return args;
}

function targetSpec(remote) {
    const { user, host } = splitHost(remote);
    return user ? `${user}@${host}` : host;
}

/** rsync 单个白名单路径的完整 argv（导出给测试断言命令构造） */
export function buildRsyncArgs(remote, rel, destDir) {
    const base = remote.root ? `${String(remote.root).replace(/\/+$/, '')}/` : '';
    const sshCmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
    if (remote.port) sshCmd.push('-p', String(remote.port));
    return [
        '-a',
        '--delete',
        '--prune-empty-dirs',
        '--ignore-errors',
        '-e', sshCmd.join(' '),
        `${targetSpec(remote)}:${base}${rel}/`,
        `${destDir}${path.sep}`,
    ];
}

/**
 * 兜底（远端没有 rsync 时）：`ssh <host> tar -cf - -C <base> <paths...>`，
 * 远端只读流式打包，本地 `tar -xf -` 解到镜像根。
 * `-C .` 依赖 ssh 非交互会话的 cwd = 远端家目录（POSIX 默认），不引入任何 shell 变量展开。
 */
export function buildTarArgs(remote, rels) {
    const base = remote.root ? String(remote.root).replace(/\/+$/, '') : '.';
    return [...sshArgs(remote), 'tar', '-cf', '-', '-C', base, ...rels];
}

export function hasCommand(name) {
    const res = spawnSync(name, ['--version'], { stdio: 'ignore' });
    return !res.error;
}

/** 镜像根：~/.wakedream/cache/remote/<remoteId>/ */
export function mirrorRoot(remoteId) {
    return path.join(paths.remote, remoteId);
}

/** 镜像里的 (agentId, 目录) → 扫描目标 */
export function mirrorTargets(remoteId) {
    const root = mirrorRoot(remoteId);
    const targets = [];
    for (const w of syncPaths()) {
        // 白名单里的 agent 用注册表 id（如 claude-code），适配器键是适配器名（claude）；
        // hasAdapterFor() 两边都认，交给 scanTargets 统一解析（修复：SSH 镜像的 .claude/projects 曾被整批丢弃）。
        if (!hasAdapterFor(w.agent)) continue;
        targets.push({ agentId: w.agent, root: path.join(root, w.rel) });
    }
    return targets;
}

function run(cmd, args, { quiet = true } = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { if (!quiet) process.stderr.write(d); stderr += d; });
        child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/** rsync 拉一个白名单目录 */
async function rsyncOne(remote, rel, log) {
    const destDir = path.join(mirrorRoot(remote.id), rel);
    fs.mkdirSync(destDir, { recursive: true });
    const args = buildRsyncArgs(remote, rel, destDir);
    log?.(`rsync ${rel}`);
    return run('rsync', args);
}

/** 兜底：一次 tar 流把全部白名单目录拉下来 */
async function tarPull(remote, rels, log) {
    const destRoot = mirrorRoot(remote.id);
    fs.mkdirSync(destRoot, { recursive: true });
    const args = buildTarArgs(remote, rels);
    log?.(`ssh+tar ${rels.join(' ')}`);
    return new Promise((resolve) => {
        const ssh = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const tar = spawn('tar', ['-xf', '-', '-C', destRoot], { stdio: ['pipe', 'ignore', 'pipe'] });
        let sshErr = '';
        let tarErr = '';
        ssh.stderr.on('data', (d) => { sshErr += d; });
        tar.stderr.on('data', (d) => { tarErr += d; });
        ssh.stdout.pipe(tar.stdin);
        ssh.on('error', (err) => { sshErr += err.message; });
        tar.on('error', (err) => { tarErr += err.message; });
        let done = 0;
        let code = 0;
        const finish = () => {
            done += 1;
            if (done < 2) return;
            resolve({ code, stdout: '', stderr: `${sshErr}${tarErr}` });
        };
        ssh.on('close', (c) => { if (c !== 0) code = c; finish(); });
        tar.on('close', (c) => { if (c !== 0 && !code) code = c; finish(); });
    });
}

/**
 * 同步一个 SSH 远端：拉镜像 → 用本机适配器解析入库（host/source = `ssh:<remoteId>`）。
 * 返回 `{jobId}`；任务状态在内存（getJob），结束后写 remotes.last_sync/last_status/last_error。
 */
export async function syncSshRemote(remoteId, opts = {}, job, log = null) {
    const remote = getRemote(remoteId);
    if (!remote) throw new Error(`远端不存在：${remoteId}`);
    if (remote.kind !== 'ssh') throw new Error(`远端 ${remoteId} 不是 ssh 类型`);
    assertSafeRemote(remote);
    const host = hostOf(remote);
    const say = (line) => { jobLog(job, line); log?.(line); };

    try {
        const wanted = syncPaths();
        const useRsync = opts.preferRsync !== false && hasCommand('rsync');
        say(useRsync ? '使用 rsync 拉取镜像' : 'rsync 不可用，降级为 ssh+tar 流式拉取');

        if (useRsync) {
            for (const w of wanted) {
                const res = await rsyncOne(remote, w.rel, say);
                if (res.code !== 0) {
                    // 远端这个目录不存在时 rsync 会退 23；其余非零当失败但要保留 stderr 尾部
                    const tail = res.stderr.trim().split('\n').slice(-4).join(' | ');
                    say(`rsync ${w.rel} 退出码 ${res.code}：${tail}`);
                    if (res.code === 255 || res.code === -1) throw new Error(`ssh 连接失败：${tail}`);
                }
            }
        } else {
            const res = await tarPull(remote, wanted.map((w) => w.rel), say);
            if (res.code !== 0) {
                const tail = res.stderr.trim().split('\n').slice(-4).join(' | ');
                throw new Error(`ssh+tar 拉取失败（退出码 ${res.code}）：${tail}`);
            }
        }

        const targets = mirrorTargets(remoteId);
        const scan = scanTargets({ host, source: host, targets, full: !!opts.full, log: { info: say } });
        const pulled = scan.scanned;
        // job.status 只取 running|ok|failed（bin/sync.js 与 UI 都按这三态等待）；
        // 「部分文件解析失败」不改变成功与否，但把明细写进 error 供 UI 提示。
        const partial = scan.errors.length ? `部分文件失败：${JSON.stringify(scan.errors.slice(0, 5))}` : null;
        finishJob(job, { status: 'ok', pulled, added: scan.added, updated: scan.updated, error: partial });
        markRemoteSync(remoteId, { status: 'ok', error: partial });
        say(`完成：拉取 ${pulled} 个会话文件，新增 ${scan.added}，更新 ${scan.updated}${partial ? '（有部分文件失败）' : ''}`);
        return { jobId: job?.id ?? null, ...scan };
    } catch (err) {
        const message = err?.message || String(err);
        say(`失败：${message}`);
        finishJob(job, { status: 'failed', error: message });
        markRemoteSync(remoteId, { status: 'failed', error: message });
        return { jobId: job?.id ?? null, error: message, scanned: 0, added: 0, updated: 0, errors: [{ error: message }] };
    }
}

/** 生成一条「复制即可用」的 ssh 探测命令（只读），给 UI 做连通性提示 */
export function probeCommand(remote) {
    const args = sshArgs(remote);
    return `ssh ${args.slice(0, -1).join(' ')} ${args[args.length - 1]} 'uname -s'`;
}
