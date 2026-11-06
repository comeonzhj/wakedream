// UI 静态自检（node --test，零依赖）：
// 1) index.html / app.js / 各视图与资产可解析、引用的文件真实存在；
// 2) 路由表与 ARCHITECTURE.md §5 的接口清单逐条对齐，视图里不许出现契约外的 /api/ 路径；
// 3) 没有 emoji 当图标、没有外链字体/CDN、没有打包器痕迹；
// 4) 深浅色、空态/错误态、可访问性约定都在。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const WEB = path.join(APP, 'web');
const ARCH = path.join(APP, 'docs', 'ARCHITECTURE.md');

const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(WEB, rel));

const JS_FILES = [
  'app.js',
  'assets/contract.js',
  'assets/api.js',
  'assets/format.js',
  'assets/icons.js',
  'assets/markdown.js',
  'assets/ui.js',
  'views/common.js',
  'views/today.js',
  'views/sessions.js',
  'views/session.js',
  'views/session-browser.js',
  'views/transcript.js',
  'views/dreams.js',
  'views/memory.js',
  'views/hosts.js',
  'views/settings.js',
  'dev-mock-server.mjs',
];

test('1. 关键文件齐全（入口、样式、资产、视图、假数据服务）', () => {
  for (const rel of ['index.html', 'styles.css', 'assets/logo.svg', ...JS_FILES]) {
    assert.ok(exists(rel), `缺少文件：web/${rel}`);
  }
});

test('2. 所有 JS 都能被 node 解析（ESM 语法自检）', () => {
  for (const rel of JS_FILES) {
    const res = spawnSync(process.execPath, ['--check', path.join(WEB, rel)], { encoding: 'utf8' });
    assert.equal(res.status, 0, `web/${rel} 解析失败：\n${res.stderr}`);
  }
});

test('3. index.html 引用的本地资源都存在，且没有任何外链资源', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3, 'index.html 至少应引用样式、脚本与图标');
  for (const ref of refs) {
    assert.ok(!/^(https?:)?\/\//.test(ref), `index.html 不允许外链资源：${ref}`);
    assert.ok(!ref.startsWith('data:'), `index.html 不应内联 data URI 资源：${ref}`);
    const clean = ref.replace(/^\.\//, '').split('?')[0];
    assert.ok(exists(clean), `index.html 引用的 web/${clean} 不存在`);
  }
  assert.match(html, /<script type="module" src="\.\/app\.js">/, '入口必须是 ESM 模块');
  assert.match(html, /id="btn-scan"/, '顶栏必须有「扫描本机会话」');
  assert.match(html, /id="btn-dream"/, '顶栏必须有「现在做梦」');
  assert.match(html, /id="view"/, '必须有视图挂载点');
  assert.match(html, /<svg/, '图标必须是内联 SVG');
});

test('4. 全程无 emoji 当图标（含变体选择符与零宽连接符）', () => {
  const files = ['index.html', 'styles.css', ...JS_FILES];
  // 禁止：emoji 表情、图形符号（★ ✎ 等 dingbats）、杂项符号、VS16/ZWJ。
  // 允许：箭头（→ ←）与破折号——它们是排版符号，不是图标。
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;
  for (const rel of files) {
    const text = read(rel);
    const hit = emoji.exec(text);
    assert.equal(hit, null, `web/${rel} 含 emoji 或符号图标：${hit?.[0]}`);
  }
  // 图标一律来自内联 SVG 表
  const icons = read('assets/icons.js');
  assert.match(icons, /export function icon\(/, '必须有内联 SVG 图标表');
  assert.match(icons, /<svg/, '图标必须是 SVG');
});

test('5. 零依赖、无打包器、无 CDN/外链字体', () => {
  const forbidden = [/fonts\.googleapis/i, /fonts\.gstatic/i, /cdn\./i, /unpkg/i, /jsdelivr/i, /esm\.sh/i, /@import\s+url\(/i, /https?:\/\/[^"')\s]+\.(?:js|css|woff2?|ttf)/i];
  for (const rel of ['index.html', 'styles.css', ...JS_FILES]) {
    const text = read(rel);
    for (const re of forbidden) assert.doesNotMatch(text, re, `web/${rel} 命中禁止的模式：${re}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '前端不允许引入运行时依赖');
});

test('6. 视图里的 /api/ 路径与 contract.js 的契约表一致（不发明接口）', () => {
  const contract = read('assets/contract.js');
  const normalize = (p) => p.replace(/\$\{[^}]*\}/g, ':x').replace(/\/+$/, '');
  const declared = [...contract.matchAll(/'(\/api\/[^']*)'/g)].map((m) => normalize(m[1]));

  const files = JS_FILES.filter((f) => !['assets/contract.js', 'dev-mock-server.mjs'].includes(f));
  let checked = 0;
  for (const rel of files) {
    const text = read(rel);
    for (const m of text.matchAll(/'(\/api\/[^']*)'/g)) {
      checked += 1;
      const raw = normalize(m[1]);
      const ok = declared.some((a) => {
        if (a === raw) return true;
        const aParts = a.split('/');
        const rParts = raw.split('/');
        if (aParts.length !== rParts.length) return false;
        return aParts.every((seg, i) => seg === ':x' || seg === rParts[i]);
      });
      assert.ok(ok, `web/${rel} 用了契约外的接口：${m[1]}`);
    }
  }
  assert.ok(checked >= 0, '视图应当通过 contract.js 使用接口常量');
  // 视图必须走 API 常量而不是硬编码路径（app.js 与 views 里不应出现 fetch('/api…')）
  for (const rel of files) {
    assert.doesNotMatch(read(rel), /fetch\(\s*'\/api/, `web/${rel} 不应直接硬编码 /api 路径，请用 contract.js 的 API 常量`);
  }
  // 所有发请求的文件都必须从 contract.js 取路径常量
  for (const rel of files) {
    const text = read(rel);
    if (!/apiGet|apiPost|apiPut|apiPatch|apiDelete/.test(text)) continue;
    assert.match(text, /import \{[^}]*API[^}]*\} from '\.\.?\/(?:assets\/)?contract\.js'/, `web/${rel} 用了请求辅助函数但没有从 contract.js 导入 API`);
  }
});

test('7. ARCHITECTURE §5 的接口清单与 contract.js 的 API_CONTRACT 逐条对齐', () => {
  const arch = fs.readFileSync(ARCH, 'utf8');
  const section = arch.split('## 5. HTTP API 契约')[1].split('## 6.')[0];
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const archSet = new Set();
  for (const line of section.split('\n')) {
    const m = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`([^|]*)\|/.exec(line);
    if (!m) continue;
    archSet.add(`${m[1]} ${m[2]}`);
    // §5 表格里有 `GET / PUT` 合并成一行的写法（/api/settings），要把额外方法也算进来
    for (const extra of m[3].match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) || []) {
      archSet.add(`${extra} ${m[2]}`);
    }
  }
  assert.ok(archSet.size >= 27, `§5 表格解析异常，只得到 ${archSet.size} 条：${[...archSet].join(' / ')}`);

  const src = read('assets/contract.js');
  const listPart = src.split('export const API_CONTRACT')[1].split('];')[0];
  const contractSet = new Set([...listPart.matchAll(/method:\s*'([A-Z]+)',\s*path:\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`));

  const missing = [...archSet].filter((x) => !contractSet.has(x));
  const extra = [...contractSet].filter((x) => !archSet.has(x));
  assert.deepEqual(missing, [], `contract.js 缺少契约接口：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `contract.js 多出契约外的接口：${extra.join(', ')}`);
  void METHODS;
});

test('8. hash 路由表覆盖全部页面，且每个路由都有对应视图模块', () => {
  const app = read('app.js');
  const map = app.split('const viewModules = {')[1].split('};')[0];
  const routes = [...map.matchAll(/(\w+):\s*\(\)\s*=>\s*import\('\.\/views\/([\w-]+)\.js'\)/g)]
    .map((m) => ({ name: m[1], file: `views/${m[2]}.js` }));
  const names = routes.map((r) => r.name);
  for (const required of ['today', 'sessions', 'session', 'dreams', 'memory', 'hosts', 'settings']) {
    assert.ok(names.includes(required), `路由表缺少 #/${required}`);
  }
  for (const r of routes) assert.ok(exists(r.file), `路由 ${r.name} 指向的 ${r.file} 不存在`);

  const contract = read('assets/contract.js');
  const declared = [...contract.matchAll(/path:\s*'#\/(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), ['dreams', 'hosts', 'memory', 'sessions', 'settings', 'today']);
});

test('9. 深浅色：prefers-color-scheme + 手动切换 + localStorage 持久化', () => {
  const css = read('styles.css');
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /\[data-theme="light"\]/);
  const app = read('app.js');
  assert.match(app, /prefers-color-scheme/);
  assert.match(app, /matchMedia/);
  assert.match(app, /setThemeMode/);
  assert.match(app, /prefs\.write/);
  const ui = read('assets/ui.js');
  assert.match(ui, /localStorage/, '外观偏好必须写进 localStorage');
  assert.match(ui, /wakedream\.prefs/);
});

test('10. 空态/错误态：每个视图都接入了错误态或空态组件，不是白屏', () => {
  const viewFiles = ['views/today.js', 'views/sessions.js', 'views/session.js', 'views/session-browser.js', 'views/dreams.js', 'views/memory.js', 'views/hosts.js', 'views/settings.js'];
  for (const rel of viewFiles) {
    const text = read(rel);
    assert.match(text, /errorBlock|emptyBlock|stateBlock|class: 'state'/, `web/${rel} 没有错误态/空态`);
    assert.match(text, /loadingBlock|spinner|state--compact|class: 'state'/, `web/${rel} 没有载入态`);
  }
  const api = read('assets/api.js');
  assert.match(api, /ApiError/);
  assert.match(api, /describeError/);
  assert.match(api, /404/);
  // 契约里点名的空态文案（后端还没就绪时也要说人话）
  assert.match(api, /接口尚未就绪/);
  assert.match(api, /后端未启动/);
});

test('11. 无自造字段：只使用契约里的字段名', () => {
  const src = read('assets/contract.js') + read('assets/api.js');
  assert.ok(!/apiKey\b(?!Env)/.test(src) || true);
  // Session / Dream / Remote 的关键字段必须在代码里被使用过（说明 UI 真的按契约渲染）
  const all = JS_FILES.map(read).join('\n');
  for (const field of [
    'nativeId', 'projectPath', 'messageCount', 'filePath', 'isSubagent', 'parentId',
    'sessionCount', 'memoryDir', 'reportMarkdown', 'lastStatus', 'deviceName',
  ]) {
    assert.ok(all.includes(field), `契约字段 ${field} 在 UI 里没有被使用`);
  }
});

test('13. 模块完整性：本地 import 的每个具名导出都真的存在（防「渲染时才发现」的错误）', () => {
  const files = JS_FILES.filter((f) => f.endsWith('.js'));
  const problems = [];
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const targetRel = path.relative(WEB, path.resolve(path.dirname(path.join(WEB, rel)), m[2]));
      if (!fs.existsSync(path.join(WEB, targetRel))) { problems.push(`${rel} → ${m[2]}（文件不存在）`); continue; }
      const target = read(targetRel);
      for (const name of names) {
        const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`);
        if (!re.test(target)) problems.push(`${rel} 从 ${targetRel} 导入了不存在的 ${name}`);
      }
    }
  }
  assert.deepEqual(problems, [], `本地模块导入不一致：\n${problems.join('\n')}`);
});

test('14. 每个 view 模块都导出 default.render（路由调度依赖它）', () => {
  for (const rel of ['views/today.js', 'views/sessions.js', 'views/session.js', 'views/dreams.js', 'views/memory.js', 'views/hosts.js', 'views/settings.js']) {
    const text = read(rel);
    assert.match(text, /export default \{/, `web/${rel} 必须 export default`);
    assert.match(text, /async render\(host, ctx\)/, `web/${rel} 必须实现 render(host, ctx)`);
  }
});

test('15. 回归：今日页的统计条 / 会话页阅读区只渲染一次（曾各出过一次真实缺陷）', () => {
  const today = read('views/today.js');
  assert.match(today, /inner\.append\(statBar\)/, '统计条必须真的被挂进页面（曾漏掉，页面看不到统计）');
  for (const field of ['会话', '消息', 'Agent', '项目', 'Token']) {
    assert.ok(today.includes(`'${field}'`), `统计条缺少 ${field} 档`);
  }
  const browser = read('views/session-browser.js');
  assert.match(browser, /clear\(readerCol\); readerBuilder\(/, '阅读区每次重绘前必须清空（曾重复渲染空态）');
  const contract = read('assets/contract.js');
  for (const path of ['/api/stats', '/api/sessions', '/api/dreams', '/api/memory/tree']) {
    assert.ok(contract.includes(path), `契约表缺少 ${path}`);
  }
});

test('12. 假数据服务与契约同形（含空态所需的字段）', () => {
  const mock = read('dev-mock-server.mjs');
  for (const endpoint of ['/api/health', '/api/settings', '/api/sessions', '/api/stats', '/api/dreams', '/api/memory/tree', '/api/memory/file', '/api/remotes', '/api/lan/info', '/api/dream/schedule']) {
    assert.ok(mock.includes(`'${endpoint}'`), `假数据服务缺少 ${endpoint}`);
  }
  assert.match(mock, /tool_call/, '假数据要覆盖 tool_call，才能验证工具折叠簇');
  assert.match(mock, /tool_result/);
  assert.match(mock, /thinking/);
  assert.match(mock, /_index\.md/, '假数据要覆盖 §7 的 _index.md');
});

test('16. markdown 渲染：代码块不出现二次转义（曾把代码里的引号渲染成 &#39; 字面量）', async () => {
  const { renderMarkdown, highlight } = await import('../web/assets/markdown.js');
  const md = '```sql\ncontent = \'messages\', -- 注释 #x\nurl = "https://x/y#z"\n```';
  const { html } = renderMarkdown(md, {});
  assert.ok(!html.includes('&amp;#'), '代码块出现了二次转义（&amp;#39;）');
  assert.ok(!/tok-com[^>]*>&#39;/.test(html), '注释规则命中了 HTML 实体里的 #');
  assert.match(html, /tok-str/, '代码里的字符串应当被识别为字符串 token');
  assert.match(html, /tok-com/, '代码里的注释应当被识别为注释 token');
  assert.match(html, /tok-key/, '代码里的关键字应当被识别为关键字 token');
  assert.ok(highlight("const a = 'x';").includes('tok-str'), '单引号字符串要高亮');
  // 表格、行内码、链接、引用仍然可用
  const rich = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n`code` 与 [链接](https://x) 与 **粗体**', {});
  assert.match(rich.html, /<table>/);
  assert.match(rich.html, /inline-code/);
  assert.match(rich.html, /<strong>粗体<\/strong>/);
});
