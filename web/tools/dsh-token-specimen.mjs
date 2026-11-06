// DSH 设计语言对照图生成器：把从 DSH 前端 bundle 里提取的真实 token 渲染成一张规格表并截图。
// 用途：WakeDream v2 的「参照物」证据（见 app/web/docs/dsh-reference.md）。
// 运行：node app/web/tools/dsh-token-specimen.mjs [--out deliverables/screenshots-v2/dsh-reference]
// 说明：token 值是从随包的 @deepseek-ai/dsh-client-ui-theme 里读出来的（浅色/深色两套），
//      这里只做可视化对照，不复制其界面资产或文案。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, arg('out', 'deliverables/screenshots-v2/dsh-reference'));
const CHROME = arg('chrome', `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`);
const PORT = 9490 + (process.pid % 100);

// ---- 从 DSH 主题包里提取的值（浅色 / 深色） ----
const STATIC = {
  'neutral-bluish': { '00': '#fff', 50: '#f9fafb', 75: '#f1f3f5', 100: '#ebeef2', 200: '#e1e5ee', 300: '#cfd3d6', 400: '#adb2b8', 500: '#979da6', 600: '#81858c', 700: '#61666b', 750: '#43454a', 800: '#353638', 850: '#2c2c2e', 875: '#232324', 900: '#1b1b1c', 950: '#151517', 1000: '#0f1115' },
  deepseek: { 50: '#edf3fe', 100: '#e4edfd', 200: '#d3e2ff', 400: '#7aaaff', 450: '#5686fe', 500: '#4176e6' },
  semantic: { 'green-500': '#22c55e', 'green-400': '#4ed17e', 'red-600': '#ec1313', 'red-400': '#f25a5a', 'amber-500': '#f59e0b', 'amber-400': '#f7ad31', 'violet-600': '#7c3aed', 'violet-400': '#a78bfa', 'blue-500': '#3b82f6' },
};
const ALIAS = [
  ['bg-base', '#fff', '#151517'],
  ['bg-layer-1', '#fff', '#232324'],
  ['bg-layer-2', '#fff', '#2c2c2e'],
  ['bg-layer-3', '#fff', '#353638'],
  ['label-primary', '#0f1115', '#f9fafb'],
  ['label-secondary', '#61666b', '#cfd3d6'],
  ['label-tertiary', '#81858c', '#adb2b8'],
  ['border-l1', '#0000000a', '#ffffff0f'],
  ['border-l2', '#0000001a', '#ffffff1f'],
  ['border-l3', '#0000001f', '#ffffff29'],
  ['brand-primary', '#0f1115', '#f9fafb'],
  ['specific-bubble', '#edf3fe', '#2c2c2e'],
  ['sidebar-fill', '#f9fafb', '#1b1b1c'],
];
const TYPE = [['xxxs', 11, 14], ['xxs', 12, 18], ['xs', 13, 20], ['s', 14, 22], ['base', 16, 24], ['m', 18, 28], ['l', 20, 28], ['xl', 24, 32]];
const MD = [['h1', 21, 30, 700], ['h2', 19, 28, 700], ['h3', 18, 26, 700], ['h4 / 正文', 14, 24, 600]];
const RADII = [['xs', 4], ['sm', 8], ['md', 12], ['lg', 16], ['xl', 20], ['panel', 28]];
const SHADOWS = [
  ['lv1', '0 2px 4px 0 #0000000d'],
  ['lv1-blur', '0 4px 12px 0 #00000005'],
  ['lv2', '0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a'],
  ['lv3', '0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014'],
];

function swatchRow(name, pairs) {
  return `<div class="row"><div class="rowlabel">${name}</div><div class="swatches">${pairs.map(([k, v]) =>
    `<div class="sw"><div class="chipbox" style="background:${v}"></div><div class="swk">${k}</div><div class="swv">${v}</div></div>`).join('')}</div></div>`;
}

function page(dark) {
  const side = dark ? 2 : 1;
  const bg = dark ? '#151517' : '#fff';
  const fg = dark ? '#f9fafb' : '#0f1115';
  const fg2 = dark ? '#cfd3d6' : '#61666b';
  const fg3 = dark ? '#adb2b8' : '#81858c';
  const line1 = dark ? '#ffffff0f' : '#0000000a';
  const line2 = dark ? '#ffffff1f' : '#0000001a';
  const layer1 = dark ? '#232324' : '#fff';
  const layer2 = dark ? '#2c2c2e' : '#f9fafb';
  const layer3 = dark ? '#353638' : '#f1f3f5';
  const accent = dark ? '#7aaaff' : '#4176e6';
  const primaryFill = dark ? '#f9fafb' : '#0f1115';
  const primaryFg = dark ? '#0f1115' : '#fff';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;padding:32px 40px;background:${bg};color:${fg};
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",system-ui,sans-serif;font-size:14px;line-height:22px}
  h1{font-size:21px;line-height:30px;font-weight:700;margin:0 0 4px}
  .sub{color:${fg3};font-size:12px;margin-bottom:24px}
  h2{font-size:13px;font-weight:600;color:${fg3};letter-spacing:.04em;margin:26px 0 10px;text-transform:uppercase}
  .card{background:${layer1};border:1px solid ${line1};border-radius:16px;padding:16px 20px;margin-bottom:14px}
  .row{display:flex;gap:16px;padding:8px 0;border-bottom:1px solid ${line1};align-items:center}
  .row:last-child{border-bottom:0}
  .rowlabel{width:112px;color:${fg3};font-size:11px;flex:0 0 auto}
  .swatches{display:flex;flex-wrap:wrap;gap:10px}
  .sw{width:96px}
  .chipbox{height:34px;border-radius:8px;border:1px solid ${line2}}
  .swk{font-size:11px;color:${fg2};margin-top:4px}
  .swv{font-size:10px;color:${fg3};font-family:"SF Mono",Menlo,monospace}
  .types .t{padding:2px 0;color:${fg}}
  .grid{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  .radius{width:72px;height:56px;background:${layer2};border:1px solid ${line2};display:grid;place-items:center;font-size:11px;color:${fg3}}
  .shadowbox{width:118px;height:62px;background:${layer1};border-radius:12px;display:grid;place-items:center;font-size:11px;color:${fg3};border:1px solid ${line1}}
  .btn{height:30px;padding:0 10px;border-radius:8px;border:1px solid ${line2};background:${layer2};color:${fg};display:inline-flex;align-items:center;gap:6px;font-size:13px}
  .btn.primary{background:${primaryFill};color:${primaryFg};border-color:transparent;font-weight:500}
  .btn.ghost{background:transparent;border-color:transparent;color:${fg2}}
  .field{height:32px;border:1px solid ${line2};border-radius:8px;background:${layer2};display:flex;align-items:center;padding:0 10px;color:${fg3};font-size:13px;width:220px}
  .field.focus{border-color:${accent};box-shadow:0 0 0 2px ${dark ? 'rgba(122,170,255,.22)' : 'rgba(65,118,230,.16)'}}
  .tag{height:18px;padding:0 6px;border-radius:4px;background:${layer3};color:${fg2};font-size:11px;display:inline-flex;align-items:center}
  .bubble{background:${dark ? '#2c2c2e' : '#edf3fe'};border-radius:20px;padding:10px 16px;font-size:14px;line-height:22px;max-width:420px}
  .mono{font-family:"SF Mono",Menlo,monospace;font-size:12px;color:${fg2}}
  .kv{display:flex;gap:24px;color:${fg2};font-size:12px}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  </style></head><body>
  <h1>DSH Web 客户端 · 设计 token 对照表（${dark ? '深色' : '浅色'}）</h1>
  <div class="sub">值取自随包前端 @deepseek-ai/dsh-client-ui-theme 的 token 样式表 · 仅作设计语言对照，不含其界面资产与文案</div>

  <h2>表面与文字（别名层）</h2>
  <div class="card">${swatchRow('alias', ALIAS.map(([k, l, d]) => [k, dark ? d : l]))}</div>

  <h2>中性色阶与语义色（静态层）</h2>
  <div class="card">${swatchRow('neutral-bluish', Object.entries(STATIC['neutral-bluish']))}</div>
  <div class="card">${swatchRow('deepseek / semantic', [...Object.entries(STATIC.deepseek), ...Object.entries(STATIC.semantic)])}</div>

  <h2>字阶（固定字号 + 固定行高）</h2>
  <div class="card types">${TYPE.map(([n, s, lh]) => `<div class="t" style="font-size:${s}px;line-height:${lh}px">${n} · ${s}/${lh}　会话正文与界面文本</div>`).join('')}
  <div style="height:10px"></div>
  ${MD.map(([n, s, lh, w]) => `<div class="t" style="font-size:${s}px;line-height:${lh}px;font-weight:${w}">${n} · ${s}/${lh} · ${w}　Markdown 标题</div>`).join('')}</div>

  <h2>圆角</h2>
  <div class="card grid">${RADII.map(([n, r]) => `<div class="radius" style="border-radius:${r}px">${n} ${r}</div>`).join('')}</div>

  <h2>阴影（极淡；常驻界面基本不用）</h2>
  <div class="card grid">${SHADOWS.map(([n, v]) => `<div class="shadowbox" style="box-shadow:${v}">${n}</div>`).join('')}</div>

  <h2>组件形态</h2>
  <div class="card" style="display:flex;flex-direction:column;gap:14px">
    <div class="grid"><span class="btn primary">主操作</span><span class="btn">次级</span><span class="btn ghost">幽灵</span>
      <span class="tag">标签</span><span class="dot" style="background:${dark ? '#4ed17e' : '#22c55e'}"></span><span class="kv">成功</span>
      <span class="dot" style="background:${dark ? '#f25a5a' : '#ec1313'}"></span><span class="kv">错误</span>
      <span class="dot" style="background:${dark ? '#7aaaff' : '#4176e6'}"></span><span class="kv">业务</span></div>
    <div class="grid"><span class="field">输入框</span><span class="field focus">聚焦态（2px 焦点环）</span>
      <span class="mono">--dsh-hairline-width 0.5px</span></div>
    <div class="bubble">用户气泡：圆角 20px（radius-xl）、内边距 10/16、正文 14/22、底色用 specific-bubble</div>
  </div>
  </body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const htmlPath = '/tmp/dsh-ref/specimen.html';
  fs.writeFileSync(htmlPath, page(false).replace('</body>', '</body>'));
  fs.writeFileSync('/tmp/dsh-ref/specimen-dark.html', page(true));
  // 本地静态服务（两个文件放同目录）
  const server = (await import('node:http')).createServer((req, res) => {
    const p = req.url.split('?')[0];
    const file = p === '/dark' ? '/tmp/dsh-ref/specimen-dark.html' : htmlPath;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(8791, '127.0.0.1', r));

  const child = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dsh-ref/cp-spec',
    '--window-size=1340,1750', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1340, height: 1750, deviceScaleFactor: 1, mobile: false });
  for (const [name, url] of [['dsh-token-specimen-light', 'http://127.0.0.1:8791/'], ['dsh-token-specimen-dark', 'http://127.0.0.1:8791/dark']]) {
    await send('Page.navigate', { url });
    await sleep(900);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`  ${name}.png`);
  }
  ws.close(); child.kill('SIGKILL'); server.close();
}

main().catch((err) => { console.error('生成对照图失败：', err.message); process.exit(1); });
