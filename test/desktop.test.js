// 桌面端（Tauri v2 + Node 边车）自检。node --test 可跑，零依赖。
//
// 覆盖四层：
//   1) 工程与配置：tauri.conf.json 的关键字段、图标齐全、externalBin 命名与 target triple 一致；
//   2) 边车构建脚本：纯函数 + 用 esbuild 在内存里真打一次包（不打 SEA、不注入、不签名），
//      验证「变量 specifier 动态 import → 静态映射」「可选依赖占位」「提示词内联」三处构建期改写真的生效；
//   3) 边车二进制：存在/可执行/是 SEA 注入过的/内含内联提示词，并把二进制真跑起来打 /api/health；
//   4) Rust 壳的静态契约：health 轮询、失败提示、退出回收边车、web 目录与端口用环境变量传给边车。
//
// 需要先构建的用例（边车二进制）在没有产物时 **skip** 而不是判红——边车二进制不进 git
// （见 app/.gitignore），新克隆的仓库里本来就没有；构建后本地与 CI 都会硬断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(APP, 'src-tauri');
const DESKTOP = path.join(APP, 'desktop');
const BIN_DIR = path.join(SRC_TAURI, 'binaries');
const WORKFLOWS = path.resolve(APP, '.github', 'workflows');  // 仓库根 == 应用根

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const read = (p) => fs.readFileSync(p, 'utf8');

const conf = readJson(path.join(SRC_TAURI, 'tauri.conf.json'));
const cargoToml = read(path.join(SRC_TAURI, 'Cargo.toml'));
const mainRs = read(path.join(SRC_TAURI, 'src', 'main.rs'));
const desktopPkg = readJson(path.join(DESKTOP, 'package.json'));

const sidecar = await import(pathToFileURL(path.join(APP, 'scripts', 'build-sidecar.mjs')).href);
const iconGen = await import(pathToFileURL(path.join(DESKTOP, 'icon-gen.mjs')).href);

/** rustc host triple（本机 Rust 工具链在 ~/.cargo/bin）；没有 rustc 就按 Node 平台推断 */
function hostTriple() {
    const out = (() => {
        try {
            const { spawnSync } = require('node:child_process');
            const r = spawnSync(path.join(process.env.HOME || '', '.cargo', 'bin', 'rustc'), ['-vV'], { encoding: 'utf8' });
            return r.status === 0 ? r.stdout : '';
        } catch { return ''; }
    })();
    return sidecar.hostTripleFromRustcOutput(out) || sidecar.tripleFromPlatform(process.platform, process.arch);
}
const require = createRequire(import.meta.url);
const TRIPLE = hostTriple();
const SIDECAR_FILE = path.join(BIN_DIR, sidecar.sidecarFileName(TRIPLE));
const HAS_SIDECAR = fs.existsSync(SIDECAR_FILE);
const SKIP_NO_SIDECAR = HAS_SIDECAR ? false : `边车二进制还没构建（${path.relative(APP, SIDECAR_FILE)} 不存在）：先跑 node scripts/build-sidecar.mjs --target ${TRIPLE}`;
const APP_BUNDLE = path.join(SRC_TAURI, 'target', 'release', 'bundle', 'macos', 'WakeDream.app');
const SKIP_NO_APP = fs.existsSync(APP_BUNDLE) ? false : '还没有打包产物：先跑 tauri build --bundles app';

const PROMPTS_DIR = path.join(APP, 'src', 'server', 'dream', 'prompts');
const promptMarker = (() => {
    const f = path.join(PROMPTS_DIR, 'lead_system.md');
    if (!fs.existsSync(f)) return null;
    return read(f).split('\n')[0].trim().slice(0, 40);
})();

// ---------------------------------------------------------------- 1. 工程与配置

test('1. 桌面端源码齐全（Rust 工程 / 配置 / 能力 / 占位页 / 图标 / 构建脚本）', () => {
    const need = [
        'Cargo.toml', 'build.rs', 'tauri.conf.json',
        'src/main.rs',
        'capabilities/default.json',
        'web-dist/index.html',
        'icons/icon.icns', 'icons/icon.ico', 'icons/icon.png',
        'icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png',
    ];
    for (const rel of need) {
        assert.ok(fs.existsSync(path.join(SRC_TAURI, rel)), `缺少 src-tauri/${rel}`);
    }
    for (const rel of ['sidecar-entry.js', 'icon-gen.mjs', 'icon-source.png', 'package.json']) {
        assert.ok(fs.existsSync(path.join(DESKTOP, rel)), `缺少 desktop/${rel}`);
    }
    assert.ok(fs.existsSync(path.join(APP, 'scripts', 'build-sidecar.mjs')), '缺少 scripts/build-sidecar.mjs');
    assert.ok(fs.existsSync(path.join(APP, 'docs', 'DESKTOP.md')), '缺少 docs/DESKTOP.md');
});

test('2. tauri.conf.json：identifier / productName / 三平台 targets / 版本一致', () => {
    assert.match(conf.identifier, /^[a-z0-9]+(\.[a-z0-9-]+)+$/, 'identifier 必须是反域名式');
    assert.equal(conf.identifier, 'com.wakedream.desktop');
    assert.equal(conf.productName, 'WakeDream');
    assert.equal(conf.version, '0.1.0');

    // 版本三处一致：tauri.conf.json / Cargo.toml / desktop/package.json
    const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
    assert.equal(cargoVersion, conf.version, 'Cargo.toml 与 tauri.conf.json 版本不一致');
    assert.equal(desktopPkg.version, conf.version, 'desktop/package.json 与 tauri.conf.json 版本不一致');

    // 三平台打包目标都要在
    const targets = conf.bundle.targets;
    assert.ok(Array.isArray(targets), 'bundle.targets 应当是数组');
    for (const t of ['app', 'dmg', 'nsis', 'msi', 'deb', 'appimage']) {
        assert.ok(targets.includes(t), `bundle.targets 缺 ${t}`);
    }
    assert.equal(conf.bundle.active, true);
    // macOS 本地构建必须 ad-hoc 签名，否则 Apple Silicon 直接拒绝启动
    assert.equal(conf.bundle.macOS.signingIdentity, '-');
    assert.equal(conf.bundle.macOS.hardenedRuntime, false);
});

test('3. web 静态资源作为 bundle 资源分发（不进边车二进制），运行期用 WAKEDREAM_WEB_DIR 指过去', () => {
    assert.deepEqual(conf.bundle.resources, { '../web': 'web' }, '资源要映射到 bundle 里的 web/');
    // 窗口由 Rust 侧创建（要等边车就绪才知道端口），配置里不能预建窗口
    assert.deepEqual(conf.app.windows, []);
    // 占位页只用于「启动中/启动失败」，真正界面由边车提供
    assert.equal(conf.build.frontendDist, './web-dist');
    assert.ok(fs.existsSync(path.join(SRC_TAURI, 'web-dist', 'index.html')));
});

test('4. externalBin 命名与 target triple 一致，且边车文件名符合 Tauri 约定', () => {
    assert.deepEqual(conf.bundle.externalBin, ['binaries/wakedream-server']);
    const base = path.basename(conf.bundle.externalBin[0]);
    assert.equal(base, sidecar.SIDECAR_BASENAME);
    // Tauri 找的是 binaries/<name>-<triple>[.exe]
    assert.equal(sidecar.sidecarFileName('aarch64-apple-darwin', 'darwin'), 'wakedream-server-aarch64-apple-darwin');
    assert.equal(sidecar.sidecarFileName('x86_64-pc-windows-msvc', 'win32'), 'wakedream-server-x86_64-pc-windows-msvc.exe');
    assert.equal(path.basename(SIDECAR_FILE), `${base}-${TRIPLE}${process.platform === 'win32' ? '.exe' : ''}`);
    // 本机就是 macOS arm64（真机构建验证的目标）
    if (process.platform === 'darwin' && process.arch === 'arm64') assert.equal(TRIPLE, 'aarch64-apple-darwin');
});

test('5. 图标：源图 1024×1024 RGBA，且三色都在（透明边 / 石板底 / 暮紫标记）', () => {
    const info = iconGen.readPngSize(path.join(DESKTOP, 'icon-source.png'));
    assert.equal(info.width, 1024);
    assert.equal(info.height, 1024);
    assert.equal(info.colorType, 6, '必须是 RGBA（外面要留透明边）');

    const size = 128;
    const rgba = iconGen.renderIcon(size, 1, false);
    let transparent = 0;
    let plate = 0;
    let ink = 0;
    for (let i = 0; i < size * size; i += 1) {
        const [r, g, b, a] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]];
        if (a === 0) transparent += 1;
        else if (b > 150 && b > r && r > g) ink += 1;   // 暮紫（#9b8cff 一族）
        else plate += 1;                                 // 暖石墨底
    }
    assert.ok(transparent > 100, '四角应当是透明的（macOS 原生图标观感）');
    assert.ok(plate > 1000, '底板上色面积太小');
    assert.ok(ink > 100, '没画上月亮/地平线');
});

test('6. 图标几何与品牌标记同源：月亮/地平线的内外点判定正确', () => {
    // 月亮是「描粗的弧」，不是实心月牙：弧上算里面，弧内侧的空心与右上凹口都算外面
    const { cx, cy, r } = iconGen.MOON;
    assert.ok(iconGen.moonSdf(cx + r * Math.cos(Math.PI * 0.75), cy + r * Math.sin(Math.PI * 0.75)) < 0, '月亮弧肚子上的点应当在图形内');
    assert.ok(iconGen.moonSdf(cx - r, cy) < 0, '月亮弧左侧的点应当在图形内');
    assert.ok(iconGen.moonSdf(cx, cy) > 0, '月亮弧内侧是空的（不是实心月牙）');
    assert.ok(iconGen.moonSdf(17.5, 5) > 0, '月亮凹口里的点应当在图形外');
    assert.ok(iconGen.moonSdf(0.5, 0.5) > 0, '画布角落应当在图形外');
    // 圆头端帽：越过端点一点点仍算在图形内（不是被切平的）
    const horn = [cx + r * Math.cos(iconGen.MOON.a1 / (180 / Math.PI)), cy + r * Math.sin(iconGen.MOON.a1 / (180 / Math.PI))];
    assert.ok(iconGen.moonSdf(horn[0], horn[1] - 0.4) < 0, '月亮角应当是圆头');
    // 地平线：中点在内，正上方 3 格在外
    assert.ok(iconGen.horizonSdf(12, 20.5) < 0);
    assert.ok(iconGen.horizonSdf(12, 17) > 0);
    assert.ok(iconGen.horizonSdf(30, 20.5) > 0, '地平线不该超出线段范围');
    // 月亮不往地平线下面出头（切口被地平线压住）
    assert.ok(iconGen.moonSdf(12, 21.0) > 0);
    const bb = iconGen.glyphBBox();
    assert.ok(bb.maxY <= iconGen.HORIZON.y + iconGen.HORIZON.half + 1e-9);
});

// ---------------------------------------------------------------- 2. 边车构建脚本（纯函数）

test('7. 构建脚本纯函数：triple / 文件名 / SEA 配置 / postject 参数', () => {
    assert.equal(sidecar.tripleFromPlatform('darwin', 'arm64'), 'aarch64-apple-darwin');
    assert.equal(sidecar.tripleFromPlatform('darwin', 'x64'), 'x86_64-apple-darwin');
    assert.equal(sidecar.tripleFromPlatform('win32', 'x64'), 'x86_64-pc-windows-msvc');
    assert.equal(sidecar.tripleFromPlatform('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
    assert.throws(() => sidecar.tripleFromPlatform('sunos', 'sparc'), /不认识的目标平台/);

    assert.equal(sidecar.hostTripleFromRustcOutput('rustc 1.98.1\nhost: aarch64-apple-darwin\n'), 'aarch64-apple-darwin');
    assert.equal(sidecar.hostTripleFromRustcOutput('nothing here'), null);

    const cfg = sidecar.seaConfigObject('/tmp/a.cjs', '/tmp/a.blob');
    assert.equal(cfg.main, '/tmp/a.cjs');
    assert.equal(cfg.output, '/tmp/a.blob');
    assert.equal(cfg.useSnapshot, false);
    assert.equal(cfg.useCodeCache, false);
    assert.equal(cfg.disableExperimentalSEAWarning, true);

    const args = sidecar.postjectArgs('/tmp/bin', '/tmp/blob', 'darwin');
    assert.deepEqual(args.slice(0, 4), ['/tmp/bin', 'NODE_SEA_BLOB', '/tmp/blob', '--sentinel-fuse']);
    assert.ok(args.includes(sidecar.SEA_SENTINEL_FUSE));
    assert.ok(args.includes('--macho-segment-name'), 'macOS 必须给 macho segment 名');
    const linuxArgs = sidecar.postjectArgs('/tmp/bin', '/tmp/blob', 'linux');
    assert.ok(!linuxArgs.includes('--macho-segment-name'));
});

test('8. 构建脚本能从真实 main.js 解析 api 模块清单（与源码同步，不另维护一份）', () => {
    const src = read(path.join(APP, 'src', 'server', 'main.js'));
    const specs = sidecar.parseApiModules(src);
    assert.ok(specs.length >= 8, `api 模块解析出来只有 ${specs.length} 个`);
    for (const spec of specs) assert.match(spec, /^\.\/api\/[\w-]+\.js$/);
    assert.ok(specs.includes('./api/health.js'));
    assert.ok(specs.includes('./api/sessions.js'));
    assert.throws(() => sidecar.parseApiModules('const X = [];'), /解析不到/);
});

test('9. 构建脚本的「静态映射 / 缺失模块 / 提示词内联」生成逻辑', () => {
    const loader = sidecar.apiLoaderSource(['./api/health.js', './api/nope.js'], ['./api/health.js']);
    assert.match(loader, /"\.\/api\/health\.js": \(\) => import\("\.\/api\/health\.js"\)/, '存在的模块要变成字面量 import，esbuild 才分析得到');
    assert.match(loader, /"\.\/api\/nope\.js": \(\) => \{/, '不存在的模块要给拒绝函数，而不是让构建失败');
    assert.match(loader, /__WD_LOAD_API/);

    const missing = sidecar.missingModuleSource('./events.js');
    assert.match(missing, /ERR_MODULE_NOT_FOUND/, '错误码要与 ESM 一致，调用方的 try/catch 才认得');
    assert.match(missing, /Cannot find module/);

    const prompts = sidecar.collectPromptTexts(PROMPTS_DIR);
    const names = Object.keys(prompts).sort();
    assert.ok(names.length >= 6, `提示词只内联了 ${names.length} 份`);
    for (const n of ['lead_system', 'analyzer_system', 'organizer_system', 'work_request']) {
        assert.ok(names.includes(n), `缺提示词 ${n}`);
        assert.ok(prompts[n].length > 0);
    }

    const plugin = sidecar.seaShimPlugin({ promptsDir: PROMPTS_DIR, apiDir: path.join(APP, 'src', 'server', 'api') });
    assert.equal(plugin.name, 'wakedream-sea-shim');
    assert.equal(typeof plugin.setup, 'function');
});

test('10. 端口探测：pickFreePort 给出的是真的能绑上的空闲端口', async () => {
    const port = await sidecar.pickFreePort();
    assert.ok(port > 0 && port < 65536);
    await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => srv.close(resolve));
    });
});

test('11. 边车打包真跑一次（内存 build，不做 SEA/注入/签名）：三处构建期改写都生效', { skip: !fs.existsSync(path.join(DESKTOP, 'node_modules', 'esbuild')) ? 'app/desktop/node_modules 里没有 esbuild（先 npm i -D）' : false }, async () => {
    const req = createRequire(path.join(DESKTOP, 'package.json'));
    const esbuild = await import(pathToFileURL(req.resolve('esbuild')).href);
    const result = await esbuild.build({
        entryPoints: [path.join(DESKTOP, 'sidecar-entry.js')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        charset: 'utf8',
        loader: { '.md': 'text' },
        define: { 'import.meta.url': '__WD_META_URL__' },
        banner: { js: 'const __WD_META_URL__ = "file:///tmp/x.cjs";' },
        plugins: [sidecar.seaShimPlugin({
            promptsDir: PROMPTS_DIR,
            apiDir: path.join(APP, 'src', 'server', 'api'),
            log: () => {},
        })],
    });
    const code = result.outputFiles[0].text;

    // ① 变量 specifier 的动态 import 被换掉了，8 个 api 模块真的进了包
    assert.ok(!code.includes('await import(spec)'), 'main.js 的动态 api 加载还留在包里，运行时必炸');
    for (const route of ['/api/health', '/api/sessions', '/api/scan', '/api/dreams', '/api/memory/tree', '/api/remotes', '/api/settings']) {
        assert.ok(code.includes(route), `api 模块没被打进包（找不到路由 ${route}）`);
    }
    // ② 不存在的可选依赖被换成「import 时才抛」的占位模块
    assert.ok(code.includes('ERR_MODULE_NOT_FOUND'), '可选依赖占位模块没注入');
    // ③ 提示词内联进包（二进制里没有 prompts/*.md）
    const escaped = [...promptMarker].map((c) => (c.charCodeAt(0) < 128 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('');
    assert.ok(code.includes(promptMarker) || code.includes(escaped), '提示词没有内联进包');
    // ④ import.meta.url 被替换（CJS 下不能是空的，否则 __dirname 算不出来）
    assert.ok(code.includes('__WD_META_URL__'));
});

// ---------------------------------------------------------------- 3. 边车二进制

test('12. 边车二进制存在、可执行、是 SEA 注入产物，且内含内联提示词', { skip: SKIP_NO_SIDECAR }, () => {
    const st = fs.statSync(SIDECAR_FILE);
    assert.ok(st.size > 10 * 1024 * 1024, `边车二进制只有 ${(st.size / 1024 / 1024).toFixed(1)} MiB，不像 node 副本 + SEA blob`);
    if (process.platform !== 'win32') {
        assert.ok((st.mode & 0o111) !== 0, '边车二进制没有可执行位');
    }
    const head = Buffer.alloc(4);
    const fd = fs.openSync(SIDECAR_FILE, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    // 直接比字节：Mach-O 在 arm64 上是小端（0xfeedfacf 落盘成 cf fa ed fe），别按大端整数比
    const expectedMagic = {
        darwin: 'cffaedfe', // MH_MAGIC_64（小端）
        linux: '7f454c46',  // \x7fELF
        win32: '4d5a',      // MZ
    }[process.platform];
    assert.ok(head.toString('hex').startsWith(expectedMagic), `文件头不是本平台的可执行文件：${head.toString('hex')}`);

    const buf = fs.readFileSync(SIDECAR_FILE);
    assert.ok(buf.includes(Buffer.from(sidecar.SEA_SENTINEL_FUSE, 'utf8')), '二进制里没有 SEA 的 fuse 哨兵');
    const escaped = [...promptMarker].map((c) => (c.charCodeAt(0) < 128 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('');
    assert.ok(
        buf.includes(Buffer.from(promptMarker, 'utf8')) || buf.includes(Buffer.from(escaped, 'utf8')),
        '二进制里没有内联提示词：SEA blob 很可能没注入进去',
    );
});

test('13. 边车二进制真跑起来：/api/health 返回 ok，静态资源与 api 模块都活着', { skip: SKIP_NO_SIDECAR }, async () => {
    const smoke = await sidecar.smokeTestBinary(SIDECAR_FILE, {
        webDir: path.join(APP, 'web'),
        promptMarker,
        log: () => {},
    });
    const failed = smoke.checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], `冒烟自检没过：${JSON.stringify(failed, null, 2)}\n--- 边车输出 ---\n${smoke.log}`);
    const health = smoke.checks.find((c) => c.name.includes('/api/health'));
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.app, 'WakeDream');
});

test('14. macOS 构建产物带 ad-hoc 签名（否则 Apple Silicon 拒绝执行）', { skip: SKIP_NO_SIDECAR || process.platform !== 'darwin' ? '仅 macOS 适用' : false }, async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('codesign', ['-dv', SIDECAR_FILE], { encoding: 'utf8' });
    const out = `${r.stderr}${r.stdout}`;
    assert.equal(r.status, 0, `codesign -dv 失败：${out}`);
    assert.match(out, /Signature=adhoc/, '边车不是 ad-hoc 签名：注入后忘了重签？');
});

// ---------------------------------------------------------------- 4. Rust 壳的静态契约

test('15. Rust 壳：选端口 → 拉起边车（PORT / WAKEDREAM_WEB_DIR）→ 轮询 health → 导航窗口', () => {
    assert.match(mainRs, /DEFAULT_PORT: u16 = 4680/);
    assert.match(mainRs, /fn pick_port/, '没有「默认端口被占用就换一个」的逻辑');
    assert.match(mainRs, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/, '占用了就要向内核要一个空闲端口');
    assert.match(mainRs, /\.sidecar\(SIDECAR_NAME\)/, '没用 shell 插件的 sidecar 能力拉边车');
    assert.match(mainRs, /\.env\("PORT"/);
    assert.match(mainRs, /\.env\("WAKEDREAM_WEB_DIR"/);
    assert.match(mainRs, /GET \/api\/health HTTP\/1\.1/, '没有健康检查请求');
    assert.match(mainRs, /"\\"ok\\":true"/, '健康检查没校验业务字段 ok:true');
    assert.match(mainRs, /resource_dir\(\)/, 'web 资源目录应当从 bundle 资源目录解析');
    assert.match(mainRs, /WebviewWindowBuilder::new/, '窗口应当在 Rust 侧创建（要等 health 就绪才知道端口）');
    assert.match(mainRs, /\.navigate\(/, '就绪后要把窗口导航到客户端地址');
});

test('16. Rust 壳：失败不装死（超时 + 失败提示窗），退出不留下孤儿边车', () => {
    assert.match(mainRs, /HEALTH_TIMEOUT: Duration = Duration::from_secs\(30\)/);
    assert.match(mainRs, /fn fail\(/, '没有失败提示路径');
    assert.match(mainRs, /wakedream:error/, '失败原因没有送进窗口里的占位页');
    assert.match(mainRs, /set_title/, '失败时标题要写明原因');
    assert.match(mainRs, /kill_on_drop\(true\)/, '缺 kill_on_drop 兜底');
    assert.match(mainRs, /RunEvent::ExitRequested \{ \.\. \} \| tauri::RunEvent::Exit/, '退出事件里没有回收边车');
    assert.match(mainRs, /fn kill\(&self\)/, '缺显式 kill');
    assert.match(mainRs, /fn dev_server_script/, '缺开发态（tauri dev）没有边车二进制时的 node 回退');
    // shell.sidecar() 只拼路径不检查存在性，缺文件时错误发生在 spawn() 里 → 必须自己判断
    assert.match(mainRs, /fn sidecar_path/, '缺边车路径判断（否则缺二进制时回退不到 node）');
    assert.match(mainRs, /if canned\.exists\(\)/, '没有先判断边车二进制是否存在就 spawn：缺文件时 tauri dev 会直接失败');
    // 开发态回退必须跑 sidecar-entry.js（带信号处理 + 孤儿看门狗），不能直接跑 src/server/main.js
    assert.match(mainRs, /join\("desktop"\)\.join\("sidecar-entry\.js"\)/, '开发态回退应当跑 desktop/sidecar-entry.js，否则壳被强杀时会留下孤儿 node');
    assert.match(mainRs, /on_navigation/, '没有拦截外链');
    assert.match(mainRs, /open_url\(/, '外链应当在系统浏览器里打开');
});

test('17. Rust 壳：原生感（窗口尺寸/最小尺寸、macOS 菜单、数据目录动作）', () => {
    assert.match(mainRs, /\.inner_size\(1320\.0, 880\.0\)/);
    assert.match(mainRs, /\.min_inner_size\(980\.0, 640\.0\)/);
    for (const item of ['.about(None)', '.services()', '.quit()', '.hide()', '.undo()', '.copy()', '.paste()', '.minimize()', '.close_window()', '.fullscreen()']) {
        assert.ok(mainRs.includes(item), `菜单缺 ${item}`);
    }
    assert.match(mainRs, /open_data_dir/, '缺「打开数据目录」');
    assert.match(mainRs, /open_in_browser/, '缺「在浏览器中打开」');
    assert.match(mainRs, /WAKEDREAM_HOME/, '数据目录要支持 WAKEDREAM_HOME 覆盖');
    assert.match(mainRs, /desktop\.log/, '桌面壳要有自己的日志文件');
});

test('18. 权限从紧：前端不调用 Tauri IPC，shell/opener 不下放给网页', () => {
    const cap = readJson(path.join(SRC_TAURI, 'capabilities', 'default.json'));
    assert.deepEqual(cap.permissions, ['core:default'], '不该给网页多余权限');
    for (const forbidden of ['shell:', 'opener:', 'fs:', 'process:']) {
        assert.ok(!JSON.stringify(cap.permissions).includes(forbidden), `不该给网页 ${forbidden} 权限`);
    }
    assert.deepEqual(cap.windows, ['main']);
    // shell 的 scope 只对网页 IPC 生效；这里断言 Rust 侧没有往 tauri.conf.json 里塞开放 scope
    assert.ok(!JSON.stringify(conf.plugins || {}).includes('scope'), 'plugins.scope 不该被用来放开 shell');
});

// ---------------------------------------------------------------- 5. 多平台工作流与文档

test('19. GitHub Actions：三平台矩阵用 tauri-action 打包', () => {
    const files = fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    assert.ok(files.length, '.github/workflows 下没有工作流');
    const texts = files.map((f) => read(path.join(WORKFLOWS, f)));
    const wf = texts.find((t) => t.includes('tauri-apps/tauri-action'));
    assert.ok(wf, '没有用 tauri-apps/tauri-action 的打包工作流');
    for (const os of ['macos-14', 'macos-13', 'windows-latest', 'ubuntu-22.04']) {
        assert.ok(wf.includes(os), `矩阵缺 ${os}`);
    }
    assert.ok(wf.includes('aarch64-apple-darwin'), '缺 macOS arm64 target');
    assert.ok(wf.includes('x86_64-apple-darwin'), '缺 macOS x64 target');
    assert.ok(wf.includes('x86_64-pc-windows-msvc'), '缺 Windows target');
    assert.ok(wf.includes('x86_64-unknown-linux-gnu'), '缺 Linux target');
    // 发布的仓库根就是应用根（源码在 src/、src-tauri/、web/），所以不应再设置 projectPath
    assert.ok(!wf.includes('projectPath'), '仓库根即应用根，工作流不应设置 projectPath');
    assert.ok(wf.includes('src-tauri'), '工作流要指向仓库根下的 src-tauri');
    assert.ok(wf.includes('build-sidecar.mjs'), '打包前必须先构建边车');
});

test('20. docs/DESKTOP.md：三平台构建步骤、产物位置，并如实写明未真机验证的平台', () => {
    const doc = read(path.join(APP, 'docs', 'DESKTOP.md'));
    for (const kw of ['macOS', 'Windows', 'Linux', 'tauri build', 'build-sidecar.mjs', 'src-tauri/target/release/bundle', '.app', '.dmg', 'NSIS', 'AppImage']) {
        assert.ok(doc.includes(kw), `DESKTOP.md 缺 ${kw}`);
    }
    assert.match(doc, /未真机验证|没有真机验证/, '必须如实写明 Windows/Linux 未真机验证');
    assert.ok(doc.includes('aarch64-apple-darwin'), '要写明我们实际验证的 target');
    assert.ok(doc.length > 2000, '文档太短，不像写清了前置依赖/产物/限制');
});

test('21. 打包产物：.app 与 .dmg 都在，且 .app 里三件套齐全（壳 / 边车 / web 资源）', { skip: SKIP_NO_APP }, () => {
    const appDir = path.join(SRC_TAURI, 'target', 'release', 'bundle', 'macos', 'WakeDream.app');
    assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'MacOS', 'wakedream-desktop')), '.app 里没有壳可执行文件');
    assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'MacOS', sidecar.SIDECAR_BASENAME)), '.app 里没有边车（externalBin 没打进去）');
    assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'web', 'index.html')), '.app 里没有 web 资源（bundle.resources 没生效）');
    assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'icon.icns')), '.app 里没有图标');

    const dmgDir = path.join(SRC_TAURI, 'target', 'release', 'bundle', 'dmg');
    const dmgs = fs.existsSync(dmgDir) ? fs.readdirSync(dmgDir).filter((f) => f.endsWith('.dmg')) : [];
    assert.ok(dmgs.length >= 1, '没有 .dmg 产物（跑 ./desktop/build-dmg.sh 或 tauri build）');
    const dmg = path.join(dmgDir, dmgs[0]);
    assert.ok(fs.statSync(dmg).size > 10 * 1024 * 1024, `.dmg 只有 ${(fs.statSync(dmg).size / 1024 / 1024).toFixed(1)} MiB，不像打全了`);
});
