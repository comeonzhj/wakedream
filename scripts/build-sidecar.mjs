#!/usr/bin/env node
// 打 WakeDream 边车（sidecar）：esbuild 单文件 CJS → Node SEA（node --experimental-sea-config
// 生成 blob + postject 注入到 node 副本）→ macOS 上重签名 → 冒烟自检。
//
//   node app/scripts/build-sidecar.mjs --target aarch64-apple-darwin
//
// 产物（Tauri 边车命名约定，externalBin 会自动找这个名字）：
//   app/src-tauri/binaries/wakedream-server-<target-triple>[.exe]
//
// 为什么是「打成一个 CJS 文件」而不是直接喂 ESM 给 SEA：
//   1) Node SEA 的 main 脚本走 CommonJS 加载路径，ESM 入口支持面窄；
//   2) src/** 里有三处对打包不友好的写法，必须在构建期改写（都在本文件插件里，见下）：
//      - main.js 的 `await import(spec)`（变量 specifier，esbuild 静态分析不到 → 8 个 api 模块全丢）；
//      - api/scan.js 里可选依赖的 `await import('./events.js')`（文件还不存在，esbuild 直接报错）；
//      - dream/prompts/index.js 运行时 readFileSync 本目录的 *.md（二进制里没有这些文件）→ 构建期内联；
//      - main.js / prompts 的 `import.meta.url`（CJS 下为空）→ 用 define 换成可执行文件自身的 URL。
//   这三处都是**只在内存里改**（不落盘、不动 src/**），并且每处都带硬断言：src 改了形状就报错，
//   不会静默产出坏二进制。
//
// 归属：desktop worker。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(__dirname, '..');
export const REPO_DIR = path.resolve(APP_DIR, '..');
export const DESKTOP_DIR = path.join(APP_DIR, 'desktop');
export const DEFAULT_OUT_DIR = path.join(APP_DIR, 'src-tauri', 'binaries');
export const SIDECAR_BASENAME = 'wakedream-server';
/** Node 官方 SEA 约定：postject 注入时用的 fuse 哨兵（node 源码里的常量，不可改） */
export const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// ---------------------------------------------------------------- 纯函数（可单测）

/** Node 的 (platform, arch) → Rust target triple。rustc 不在时用它兜底。 */
export function tripleFromPlatform(platform, arch) {
    const table = {
        'darwin:arm64': 'aarch64-apple-darwin',
        'darwin:x64': 'x86_64-apple-darwin',
        'win32:x64': 'x86_64-pc-windows-msvc',
        'win32:arm64': 'aarch64-pc-windows-msvc',
        'linux:x64': 'x86_64-unknown-linux-gnu',
        'linux:arm64': 'aarch64-unknown-linux-gnu',
    };
    const triple = table[`${platform}:${arch}`];
    if (!triple) throw new Error(`不认识的目标平台：${platform}/${arch}（用 --target 显式指定）`);
    return triple;
}

/** Tauri externalBin 的文件名：`<basename>-<triple>`，Windows 加 .exe */
export function sidecarFileName(triple, platform = process.platform) {
    return platform === 'win32' ? `${SIDECAR_BASENAME}-${triple}.exe` : `${SIDECAR_BASENAME}-${triple}`;
}

/** 从 `rustc -vV` 输出里取 host triple */
export function hostTripleFromRustcOutput(output) {
    const m = /^host:\s*(\S+)$/m.exec(String(output || ''));
    return m ? m[1] : null;
}

/** SEA 配置文件内容（useSnapshot/useCodeCache 关掉：会额外要求入口形状，收益不大） */
export function seaConfigObject(mainFile, outputFile, isWindows = process.platform === 'win32') {
    return {
        main: mainFile,
        output: outputFile,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        ...(isWindows ? {} : {}),
    };
}

/** postject 的参数（macOS 必须给 macho segment 名） */
export function postjectArgs(binaryPath, blobPath, platform = process.platform) {
    const args = [binaryPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_SENTINEL_FUSE, '--overwrite'];
    if (platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
    return args;
}

/** 从 main.js 源码里解析 `const API_MODULES = [...]` —— 保持与源码同步，不另外维护一份清单 */
export function parseApiModules(source) {
    const m = /const\s+API_MODULES\s*=\s*\[([\s\S]*?)\]/.exec(String(source || ''));
    if (!m) throw new Error('解析不到 main.js 里的 API_MODULES 数组（契约变了？）');
    const specs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (!specs.length) throw new Error('API_MODULES 解析出来是空的');
    return specs;
}

/** 造一个「模块不存在」的虚拟模块：错误码与 ESM 一致，方便调用方的 try/catch 与 missing 统计 */
export function missingModuleSource(spec) {
    return [
        `const err = new Error(${JSON.stringify(`Cannot find module '${spec}'`)});`,
        "err.code = 'ERR_MODULE_NOT_FOUND';",
        'throw err;',
    ].join('\n');
}

/**
 * 生成 main.js 里动态 import 的静态替身。
 * `await import(spec)` → `await __WD_LOAD_API(spec)`，映射表里是**字面量** import，
 * esbuild 才分析得到、才会把 8 个 api 模块真的打进包里。
 */
export function apiLoaderSource(specs, existing) {
    const entries = specs.map((spec) => {
        const ok = existing.includes(spec);
        return ok
            ? `    ${JSON.stringify(spec)}: () => import(${JSON.stringify(spec)}),`
            : `    ${JSON.stringify(spec)}: () => { const e = new Error(${JSON.stringify(`Cannot find module '${spec}'`)}); e.code = 'ERR_MODULE_NOT_FOUND'; return Promise.reject(e); },`;
    });
    return [
        '// [build-sidecar] 构建期注入：把变量 specifier 的动态 import 换成静态映射',
        `const __WD_API_MODULES = {\n${entries.join('\n')}\n};`,
        'const __WD_LOAD_API = (spec) => {',
        '    const load = __WD_API_MODULES[spec];',
        "    if (!load) { const e = new Error(`Cannot find module '${spec}'`); e.code = 'ERR_MODULE_NOT_FOUND'; return Promise.reject(e); }",
        '    return load();',
        '};',
    ].join('\n');
}

/** prompts 目录下的 *.md → { name: text }，构建期内联进二进制 */
export function collectPromptTexts(promptsDir) {
    const out = {};
    for (const file of fs.readdirSync(promptsDir)) {
        if (!file.endsWith('.md')) continue;
        out[file.replace(/\.md$/, '')] = fs.readFileSync(path.join(promptsDir, file), 'utf8');
    }
    return out;
}

/** 起一个临时监听拿空闲端口（拿到就关，交给边车用） */
export function pickFreePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, host, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// ---------------------------------------------------------------- esbuild 插件

/**
 * 把 src/** 改写成「SEA 友好」的形状。全部在内存里改，不改仓库文件。
 * @param {{promptsDir:string, apiDir:string, log:Function}} opts
 */
export function seaShimPlugin({ promptsDir, apiDir, log = () => {} }) {
    const MAIN_RE = /src[/\\]server[/\\]main\.js$/;
    const PROMPTS_RE = /dream[/\\]prompts[/\\]index\.js$/;
    const VIRTUAL = 'wd-missing-module';
    let build; // esbuild 的 build 对象，onResolve 里要用 build.resolve 探测可解析性

    return {
        name: 'wakedream-sea-shim',
        setup(b) {
            build = b;

            // 1) 解析不到的相对依赖 → 虚拟模块（保留「可选依赖」语义：import 时才抛 ERR_MODULE_NOT_FOUND）
            b.onResolve({ filter: /^\.{1,2}\// }, async (args) => {
                if (args.pluginData?.wdProbing) return null; // 第二次进来直接放行给 esbuild 自己解
                let resolved;
                try {
                    resolved = await build.resolve(args.path, {
                        importer: args.importer,
                        resolveDir: args.resolveDir,
                        kind: args.kind,
                        pluginData: { wdProbing: true },
                    });
                } catch {
                    resolved = { errors: [{}] };
                }
                if (resolved.errors?.length) {
                    log(`  · 可选依赖缺失，注入占位模块：${args.path}（来自 ${path.relative(APP_DIR, args.importer || '')}）`);
                    return { path: `wd-missing:${args.path}`, namespace: VIRTUAL };
                }
                return null;
            });

            b.onLoad({ filter: /.*/, namespace: VIRTUAL }, (args) => ({
                contents: missingModuleSource(args.path.replace(/^wd-missing:/, '')),
                loader: 'js',
            }));

            // 2) main.js：变量 specifier 的动态 import → 静态映射
            b.onLoad({ filter: MAIN_RE }, (args) => {
                let src = fs.readFileSync(args.path, 'utf8');
                const specs = parseApiModules(src);
                const existing = specs.filter((s) => fs.existsSync(path.join(apiDir, path.basename(s))));
                if (!src.includes('await import(spec)')) {
                    throw new Error('main.js 里找不到 `await import(spec)`：动态 api 模块加载方式变了，请同步更新 build-sidecar.mjs');
                }
                src = src.replace('await import(spec)', 'await __WD_LOAD_API(spec)');
                src = `${apiLoaderSource(specs, existing)}\n${src}`;
                log(`  · main.js：注入 ${specs.length} 个 api 模块的静态映射（实际存在 ${existing.length} 个）`);
                return { contents: src, loader: 'js' };
            });

            // 3) prompts/index.js：把 *.md 内联进去（二进制里没有这些文件）
            b.onLoad({ filter: PROMPTS_RE }, (args) => {
                let src = fs.readFileSync(args.path, 'utf8');
                const texts = collectPromptTexts(promptsDir);
                if (!Object.keys(texts).length) throw new Error(`提示词目录是空的：${promptsDir}`);
                const NEEDLE = "const text = fs.readFileSync(file, 'utf8');";
                if (!src.includes(NEEDLE)) {
                    throw new Error('prompts/index.js 里找不到提示词读取语句：提示词加载方式变了，请同步更新 build-sidecar.mjs');
                }
                src = src.replace(NEEDLE, 'const text = __WD_EMBEDDED_PROMPTS[name] ?? fs.readFileSync(file, \'utf8\');');
                src = `const __WD_EMBEDDED_PROMPTS = ${JSON.stringify(texts)};\n${src}`;
                log(`  · prompts/index.js：内联 ${Object.keys(texts).length} 份提示词（${Object.keys(texts).join('、')}）`);
                return { contents: src, loader: 'js' };
            });
        },
    };
}

// ---------------------------------------------------------------- 构建步骤

function findRustc() {
    const candidates = [
        process.env.RUSTC,
        path.join(os.homedir(), '.cargo', 'bin', 'rustc'),
        'rustc',
    ].filter(Boolean);
    for (const bin of candidates) {
        try {
            const out = spawnSync(bin, ['-vV'], { encoding: 'utf8' });
            if (out.status === 0) return { bin, triple: hostTripleFromRustcOutput(out.stdout) };
        } catch { /* 换下一个 */ }
    }
    return null;
}

function desktopRequire() {
    return createRequire(path.join(DESKTOP_DIR, 'package.json'));
}

function ensureDeps({ install }) {
    const req = desktopRequire();
    const need = [];
    for (const name of ['esbuild', 'postject']) {
        try { req.resolve(name); } catch { need.push(name); }
    }
    if (!need.length) return req;
    if (!install) throw new Error(`app/desktop 里缺依赖：${need.join('、')}（去掉 --no-install 可以自动装）`);
    console.log(`· app/desktop 缺 ${need.join('、')}，本地安装（不碰 app/package.json）…`);
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: DESKTOP_DIR, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm install 失败');
    return desktopRequire();
}

async function runEsbuild(esbuild, { outFile, promptsDir, apiDir, log }) {
    const result = await esbuild.build({
        entryPoints: [path.join(DESKTOP_DIR, 'sidecar-entry.js')],
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8', // 中文源码保持原样落进包（否则 esbuild 默认 \uXXXX 转义）
        logLevel: 'warning',
        loader: { '.md': 'text' },
        // CJS 下 import.meta 是空的，必须换成真东西（main.js 与 prompts 都拿它算目录）。
        //
        // 注意这里**不能**写成「可执行文件自身的 file URL」：SEA 里 __filename 与 process.argv[1]
        // 都是可执行文件路径，那样 main.js 的 `isMain`（argv[1] vs import.meta.url）会判真 →
        // main.js 自己 start() 一次，sidecar-entry.js 再 start() 一次 → 同进程双实例抢端口，
        // 表现为启动即 EADDRINUSE 崩溃。所以钉成一个「挨着可执行文件、但不是可执行文件」的
        // bundle URL：isMain 恒为假，启动权唯一归 sidecar-entry.js；dirname 仍是可执行文件目录，
        // 万一没给 WAKEDREAM_WEB_DIR 也不会指向一个莫名其妙的地方。
        define: { 'import.meta.url': '__WD_META_URL__' },
        banner: {
            js: [
                '// [build-sidecar] 生成物，勿手改；源码见 app/src/**',
                'const __WD_BUNDLE_DIR__ = require("node:path").dirname(process.execPath);',
                'const __WD_META_URL__ = require("node:url").pathToFileURL(require("node:path").join(__WD_BUNDLE_DIR__, "__wakedream_sea_bundle__.cjs")).href;',
            ].join('\n'),
        },
        plugins: [seaShimPlugin({ promptsDir, apiDir, log })],
        metafile: true,
    });
    const inputs = Object.keys(result.metafile.inputs).length;
    const bytes = fs.statSync(outFile).size;
    return { inputs, bytes };
}

function generateSeaBlob(nodeBin, bundleFile, workDir) {
    const configPath = path.join(workDir, 'sea-config.json');
    const blobPath = path.join(workDir, 'sea-prep.blob');
    fs.writeFileSync(configPath, `${JSON.stringify(seaConfigObject(bundleFile, blobPath), null, 2)}\n`);
    const r = spawnSync(nodeBin, ['--experimental-sea-config', configPath], {
        cwd: workDir,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
    });
    if (r.status !== 0) {
        throw new Error(`node --experimental-sea-config 失败（exit ${r.status}）：\n${r.stderr || r.stdout}`);
    }
    if (!fs.existsSync(blobPath)) throw new Error('SEA blob 没生成');
    return blobPath;
}

function injectBlob(postjectCli, binaryPath, blobPath, { platform }) {
    const args = postjectArgs(binaryPath, blobPath, platform);
    const r = spawnSync(process.execPath, [postjectCli, ...args], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`postject 注入失败（exit ${r.status}）：\n${r.stdout || ''}${r.stderr || ''}`);
    }
    return r.stdout?.trim();
}

function adhocSign(binaryPath, { platform, log }) {
    if (platform !== 'darwin') return 'n/a（非 macOS，跳过签名）';
    const rm = spawnSync('codesign', ['--remove-signature', binaryPath], { encoding: 'utf8' });
    log(`  · codesign --remove-signature（exit ${rm.status}）`);
    const sign = spawnSync('codesign', ['--sign', '-', '--force', '--timestamp=none', binaryPath], { encoding: 'utf8' });
    if (sign.status !== 0) throw new Error(`ad-hoc 重签失败：${sign.stderr || sign.stdout}`);
    const verify = spawnSync('codesign', ['-dv', binaryPath], { encoding: 'utf8' });
    return (verify.stderr || verify.stdout || '').trim().split('\n').filter(Boolean).slice(0, 3).join(' | ');
}

async function httpGet(url, timeoutMs = 4000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ac.signal });
        const text = await res.text();
        return { status: res.status, text };
    } finally {
        clearTimeout(t);
    }
}

/** 选一个「先探测空闲、再立刻交出」的端口——中间有被抢的窗口，所以调用方要能重试 */
export async function pickProbePort() {
    const preferred = 4701 + Math.floor(Math.random() * 199); // 4701..4899，躲开 macOS 临时端口段
    const srv = net.createServer();
    const free = await new Promise((resolve) => {
        srv.once('error', () => resolve(false));
        srv.once('listening', () => resolve(true));
        srv.listen(preferred, '127.0.0.1');
    });
    await new Promise((r) => srv.close(r));
    return free ? preferred : pickFreePort();
}

/** 冒烟自检（带端口重试）：真的把二进制跑起来，用 /api/health 证明「打包没把模块图打坏」 */
export async function smokeTestBinary(binaryPath, opts) {
    const attempts = opts.attempts ?? 3;
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await smokeTestOnce(binaryPath, opts);
        } catch (err) {
            lastErr = err;
            if (!/EADDRINUSE/.test(String(err?.message))) throw err;
            (opts.log || console.log)(`  · 端口被抢，换一个重试（${i + 1}/${attempts}）`);
        }
    }
    throw lastErr;
}

async function smokeTestOnce(binaryPath, { webDir, promptMarker, timeoutMs = 30_000, log = console.log }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sea-home-'));
    const port = await pickProbePort();
    const child = spawn(binaryPath, [], {
        env: { ...process.env, PORT: String(port), WAKEDREAM_HOME: home, WAKEDREAM_WEB_DIR: webDir, WAKEDREAM_HTTP_LOG: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    const base = `http://127.0.0.1:${port}`;
    const checks = [];
    let health = null;
    const started = Date.now();
    try {
        while (Date.now() - started < timeoutMs) {
            if (child.exitCode !== null) throw new Error(`边车提前退出（exit ${child.exitCode}）：\n${out}`);
            try {
                const res = await httpGet(`${base}/api/health`, 1500);
                if (res.status === 200) {
                    health = { status: res.status, body: JSON.parse(res.text), ms: Date.now() - started };
                    break;
                }
            } catch { /* 还没起来 */ }
            await new Promise((r) => setTimeout(r, 250));
        }
        if (!health) throw new Error(`等 /api/health 超时（${timeoutMs}ms）：\n${out}`);
        checks.push({ name: 'GET /api/health', ...health, ok: health.body?.ok === true });

        const index = await httpGet(`${base}/`);
        checks.push({
            name: 'GET /（web 静态资源来自 WAKEDREAM_WEB_DIR）',
            status: index.status,
            ok: index.status === 200 && /<html/i.test(index.text),
            bytes: index.text.length,
        });

        const sessions = await httpGet(`${base}/api/sessions?limit=1`);
        const sj = JSON.parse(sessions.text);
        checks.push({
            name: 'GET /api/sessions（证明 api 模块真的被打进包）',
            status: sessions.status,
            ok: sessions.status === 200 && Array.isArray(sj.sessions),
            total: sj.total,
        });

        // 提示词内联检查：二进制里应当出现提示词原文（dream 引擎跑得起来的前提）。
        // 两种形态都认：原样 UTF-8，或 esbuild 的 \uXXXX 转义形态。
        const bin = fs.readFileSync(binaryPath);
        const escaped = [...promptMarker].map((c) => (c.charCodeAt(0) < 128 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('');
        const hit = bin.includes(Buffer.from(promptMarker, 'utf8')) || bin.includes(Buffer.from(escaped, 'utf8'));
        checks.push({ name: '二进制内含内联提示词', ok: hit, marker: `${promptMarker.slice(0, 24)}…` });

        return { ok: checks.every((c) => c.ok), checks, port, home, log: out.slice(-2000) };
    } finally {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        await new Promise((r) => setTimeout(r, 200));
        fs.rmSync(home, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------- 主流程

function parseArgs(argv) {
    const out = { target: null, outDir: DEFAULT_OUT_DIR, verify: true, install: true, keepWork: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--target') out.target = argv[++i];
        else if (a === '--out-dir') out.outDir = path.resolve(argv[++i]);
        else if (a === '--no-verify') out.verify = false;
        else if (a === '--no-install') out.install = false;
        else if (a === '--keep-work') out.keepWork = true;
        else if (a === '-h' || a === '--help') out.help = true;
        else throw new Error(`不认识的参数：${a}`);
    }
    return out;
}

const HELP = `用法：node app/scripts/build-sidecar.mjs [--target <triple>] [--out-dir <dir>] [--no-verify] [--no-install]

把 app/src/** 打成一个自包含的 Node SEA 可执行文件（WakeDream 边车），产出到
app/src-tauri/binaries/wakedream-server-<triple>（Tauri externalBin 约定名）。
--target 默认取 rustc 的 host triple（rustc 不在时按当前 Node 平台/架构推断）。`;

async function main() {
    const t0 = Date.now();
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(HELP); return; }

    const rustc = findRustc();
    const target = args.target || rustc?.triple || tripleFromPlatform(process.platform, process.arch);
    const outFile = path.join(args.outDir, sidecarFileName(target, process.platform));

    console.log(`· 目标：${target}${rustc ? `（rustc host：${rustc.triple}）` : '（rustc 不在，按 Node 平台推断）'}`);
    console.log(`· node：${process.execPath}（${process.version}）→ SEA 宿主二进制`);

    const req = ensureDeps({ install: args.install });
    const esbuild = await import(pathToFileURL(req.resolve('esbuild')).href);
    const postjectCli = path.join(path.dirname(req.resolve('postject/package.json')), 'dist', 'cli.js');
    if (!fs.existsSync(postjectCli)) throw new Error(`找不到 postject CLI：${postjectCli}`);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sea-build-'));
    fs.mkdirSync(args.outDir, { recursive: true });
    const bundleFile = path.join(workDir, 'wakedream-server.cjs');
    const promptsDir = path.join(APP_DIR, 'src', 'server', 'dream', 'prompts');
    const apiDir = path.join(APP_DIR, 'src', 'server', 'api');
    const webDir = path.join(APP_DIR, 'web');

    try {
        console.log('· esbuild 打包 src/** → 单文件 CJS');
        const bundle = await runEsbuild(esbuild, { outFile: bundleFile, promptsDir, apiDir, log: console.log });
        console.log(`  · ${bundle.inputs} 个输入模块 → ${(bundle.bytes / 1024).toFixed(1)} KiB`);

        console.log('· 生成 SEA blob（node --experimental-sea-config）');
        const blobPath = generateSeaBlob(process.execPath, bundleFile, workDir);
        console.log(`  · blob ${(fs.statSync(blobPath).size / 1024).toFixed(1)} KiB`);

        console.log('· 复制 node 二进制 + postject 注入');
        fs.copyFileSync(process.execPath, outFile);
        fs.chmodSync(outFile, 0o755);
        const injectOut = injectBlob(postjectCli, outFile, blobPath, { platform: process.platform });
        if (injectOut) console.log(`  · ${injectOut.split('\n')[0]}`);

        console.log('· 签名（macOS：注入会破坏原签名，必须 remove + ad-hoc 重签）');
        const signInfo = adhocSign(outFile, { platform: process.platform, log: console.log });
        console.log(`  · ${signInfo}`);

        const sizeMB = fs.statSync(outFile).size / 1024 / 1024;
        console.log(`· 产物：${path.relative(REPO_DIR, outFile)}（${sizeMB.toFixed(1)} MiB）`);

        // 落盘前脱敏：这份报告是按约定提交进仓库的，不能带出跑构建那台机器的标识
        // （主机名会出现在 lan.deviceName、临时 HOME 会出现在冒烟自检的日志里）。
        const sanitize = (value) => {
            if (typeof value === 'string') {
                let out = value.split(os.hostname()).join('<device>');
                // 仓库自身的绝对路径（codesign 的 Executable=… 会带出来）
                // 用「应用根」当 <repo>：已发布仓库的根就是 app/，这样渲染成 <repo>/src-tauri/… 而不是 <repo>/app/src-tauri/…
                out = out.split(APP_DIR).join('<repo>');
                out = out.split(REPO_DIR).join('<repo-root>');
                // 临时目录（冒烟自检用的假 HOME）
                out = out.replace(/\/private\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/T\/[^\s"']*/g, '<tmp-home>');
                out = out.replace(/\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/T\/[^\s"']*/g, '<tmp-home>');
                // 任何还残留的家目录绝对路径（/Users/<name>/…、/home/<name>/…）
                out = out.replace(/\/Users\/[A-Za-z0-9._-]+/g, () => '$HOME');
                out = out.replace(/\/home\/[A-Za-z0-9._-]+/g, () => '$HOME');
                return out;
            }
            if (Array.isArray(value)) return value.map(sanitize);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
            }
            return value;
        };

        const report = sanitize({
            target,
            node: process.version,
            nodePath: process.execPath,
            rustc: rustc?.bin || null,
            output: path.relative(REPO_DIR, outFile),
            bytes: fs.statSync(outFile).size,
            bundleBytes: bundle.bytes,
            bundleInputs: bundle.inputs,
            signature: signInfo,
            builtAt: new Date().toISOString(),
            durationMs: null,
            verify: null,
        });
        // 路径类字段固定用占位符（sanitize 只处理机器名与临时目录，不处理家目录路径）
        report.nodePath = '<node>';
        if (report.rustc) report.rustc = '<rustc>';

        if (args.verify) {
            console.log('· 冒烟自检：真跑二进制 + /api/health + 静态资源 + api 模块');
            const marker = fs.readFileSync(path.join(promptsDir, 'lead_system.md'), 'utf8').split('\n')[0].trim().slice(0, 40);
            const smoke = await smokeTestBinary(outFile, { webDir, promptMarker: marker });
            report.verify = smoke;
            for (const c of smoke.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.status ? ` → ${c.status}` : ''}${c.total !== undefined ? `（total=${c.total}）` : ''}`);
            if (!smoke.ok) throw new Error(`冒烟自检没过：${JSON.stringify(smoke.checks, null, 2)}\n--- 边车输出 ---\n${smoke.log}`);
        } else {
            console.log('· 跳过冒烟自检（--no-verify）');
        }

        report.durationMs = Date.now() - t0;
        const reportPath = path.join(DESKTOP_DIR, 'build-report.json');
        // 注意：verify（冒烟自检）是在上面 sanitize 之后才挂上去的，里面同样有临时 HOME、主机名与启动日志，
        // 所以落盘时必须整体再过一遍 sanitize，而不是只清洗前半段。
        fs.writeFileSync(reportPath, `${JSON.stringify(sanitize(report), null, 2)}\n`);
        console.log(`✓ 边车就绪：${path.relative(REPO_DIR, outFile)}（${sizeMB.toFixed(1)} MiB，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        console.log(`  报告：${path.relative(REPO_DIR, reportPath)}`);
    } finally {
        if (!args.keepWork) fs.rmSync(workDir, { recursive: true, force: true });
        else console.log(`· 保留中间产物：${workDir}`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    main().catch((err) => {
        console.error(`✗ 边车构建失败：${err?.message || err}`);
        if (process.env.WD_DEBUG) console.error(err?.stack);
        process.exit(1);
    });
}
