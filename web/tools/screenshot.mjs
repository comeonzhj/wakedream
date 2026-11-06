// 真机渲染验证：用本机 Google Chrome + CDP（零依赖，Node 22 自带 WebSocket）逐页截图。
//
// 为什么不用 `chrome --screenshot --virtual-time-budget`：本应用会订阅 SSE（GET /api/events，
// 契约里允许长连接），虚拟时间在「有未完成网络请求」时会暂停，--screenshot 会永久挂住。
// 用 CDP 可以显式等待页面渲染完成再抓帧，对假数据服务与真实后端都适用。
//
// 用法：
//   node app/web/tools/screenshot.mjs [--base http://127.0.0.1:4780] [--out deliverables/screenshots]
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
const BASE = arg('base', 'http://127.0.0.1:4780').replace(/\/$/, '');
const OUT = path.resolve(ROOT, arg('out', 'deliverables/screenshots'));
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
// 每次跑用不同端口，避免上一次残留的 Chrome 占住调试端口导致「端口没起来」
const PORT = Number(arg('port', String(9300 + (process.pid % 500))));
const WIDTH = Number(arg('width', '1600'));
const HEIGHT = Number(arg('height', '1000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpJson(pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method });
  if (!res.ok) throw new Error(`CDP ${pathname} → ${res.status}`);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); } }, 30_000);
    });
  }
}

async function launchChrome(profileDir) {
  // chrome-headless-shell（Chrome for Testing）本身就是无头实现，不接受 --headless=new
  const isHeadlessShell = CHROME.includes('headless-shell') || CHROME.includes('headless_shell');
  const flags = [
    ...(isHeadlessShell ? [] : ['--headless=new']),
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // 无头合成器不给新帧时 captureScreenshot 会返回上一帧；这三个开关保证每次都能拿到新帧
    '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
    '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
  ];
  const child = spawn(CHROME, flags, { stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    try { await cdpJson('/json/version'); return child; } catch { await sleep(250); }
  }
  child.kill('SIGKILL');
  throw new Error('Chrome 调试端口没起来');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profileDir = fs.mkdtempSync('/tmp/wd-shot-');
  const chrome = await launchChrome(profileDir);

  const target = await cdpJson('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`异常：${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(`console.${msg.params.type}：${(msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });

  // 先取真实 id，保证详情页有数据
  const day = await cdpJson('/json/version').then(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  void day;
  let sessionId = '';
  let dreamId = '';
  const forcedSession = arg('session', '');
  const forcedDream = arg('dream', '');
  try {
    if (forcedSession) {
      sessionId = encodeURIComponent(forcedSession);
    } else {
      // 选消息最多的会话：保证转录页能验证气泡 / thinking / 工具折叠簇 / 代码块四类渲染
      const s = await fetch(`${BASE}/api/sessions?limit=50`).then((r) => r.json());
      const richest = [...(s.sessions || [])].sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))[0];
      sessionId = encodeURIComponent(richest?.id || '');
    }
    const d = await fetch(`${BASE}/api/dreams`).then((r) => r.json());
    dreamId = forcedDream || d.dreams?.[0]?.id || '';
  } catch { /* 后端没起来时也照常截首页 */ }

  const pages = [
    ['01-today', `#/today`, 'dark', '.timeline'],
    ['02-sessions', `#/sessions`, 'dark', '.col--list .row'],
    ['03-transcript', sessionId ? `#/sessions/${sessionId}` : '#/sessions', 'dark', '.msg-body, .fold'],
    ['04-dreams', dreamId ? `#/dreams/${dreamId}` : '#/dreams', 'dark', '.markdown, .col--reader .state'],
    ['05-memory', `#/memory`, 'dark', '.reader-inner .markdown'],
    ['06-hosts', `#/hosts`, 'dark', '.device-row'],
    ['07-settings', `#/settings`, 'dark', '.form-panel'],
    ['08-today-light', `#/today`, 'light', '.timeline'],
    ['09-transcript-light', sessionId ? `#/sessions/${sessionId}` : '#/sessions', 'light', '.msg-body, .fold'],
    ['10-dreams-light', dreamId ? `#/dreams/${dreamId}` : '#/dreams', 'light', '.markdown, .col--reader .state'],
  ];

  for (const [name, hash, theme, marker] of pages) {
    const url = `${BASE}/?theme=${theme}${hash}`;
    await cdp.send('Page.navigate', { url });
    // 等页面真正渲染出这一页的标志性元素，并且不再转圈
    const ready = await waitFor(cdp, `(() => {
      if (!location.hash.startsWith(${JSON.stringify(hash.slice(0, hash.indexOf('/') + 3))})) return false;
      const v = document.getElementById('view');
      if (!v || !v.children.length) return false;
      if (v.querySelector('.spinner')) return false;
      return Boolean(v.querySelector(${JSON.stringify(marker)}));
    })()`);
    if (!ready) console.warn(`  ! ${name} 等标志元素超时，仍尝试截图`);
    if (ready) {
      const diag = await cdp.send('Runtime.evaluate', {
        expression: `(() => { const v = document.getElementById('view'); return JSON.stringify({ hash: location.hash, title: document.getElementById('page-title').textContent, kids: v.children.length, text: (v.innerText || '').slice(0, 60).replace(/\\n/g, ' ') }); })()`,
        returnByValue: true,
      });
      console.log(`      DOM ${diag.result.value}`);
    } else {
      const diag = await cdp.send('Runtime.evaluate', {
        expression: `(() => { const v = document.getElementById('view'); return JSON.stringify({ hash: location.hash, title: document.getElementById('page-title').textContent, kids: v.children.length, html: v.innerHTML.slice(0, 160) }); })()`,
        returnByValue: true,
      });
      console.log(`      DOM(未就绪) ${diag.result.value}`);
      if (problems.length) console.log(`      页面错误：${problems.slice(-3).join(' | ')}`);
    }
    // 强制渲染新帧：等三帧 + 一个宏任务
    await cdp.send('Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 120)))))',
      awaitPromise: true,
      returnByValue: true,
    });
    await sleep(250);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    const title = await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("page-title").textContent + " | " + location.hash', returnByValue: true });
    console.log(`  ${name.padEnd(20)} ${ready ? 'ok ' : '超时'} ${title.result.value}`);
  }

  ws.close();
  chrome.kill('SIGKILL');
  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log(`截图输出：${OUT}`);
}

async function waitFor(cdp, expression, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      if (res.result?.value === true) return true;
    } catch { /* 页面切换中 */ }
    await sleep(200);
  }
  return false;
}

main().catch((err) => {
  console.error('截图失败：', err.message);
  process.exit(1);
});
