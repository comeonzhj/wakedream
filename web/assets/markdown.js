// 轻量 markdown 渲染器（自写，零依赖）：标题 / 列表 / 表格 / 代码 / 链接 / 引用 / 粗斜体 / 行内码。
// 记忆库（§7）与做梦报告都用它渲染；相对链接交给 resolveHref 决定跳到哪个记忆文件。
import { escapeHtml } from './format.js';
import { icon } from './icons.js';

const KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'await', 'async',
  'import', 'from', 'export', 'default', 'class', 'new', 'try', 'catch', 'finally', 'throw',
  'typeof', 'instanceof', 'def', 'elif', 'None', 'True', 'False', 'self', 'yield', 'SELECT',
  'FROM', 'WHERE', 'CREATE', 'TABLE', 'VIRTUAL', 'USING', 'INSERT', 'INTO', 'VALUES', 'ORDER',
  'BY', 'GROUP', 'LIMIT', 'AND', 'OR', 'NOT', 'NULL', 'text', 'content', 'tokenize',
];

// 语法高亮：单趟扫描 + 逐段转义（**绝不能先整体转义再匹配**，
// 否则注释规则里的 `#` 会命中实体 `&#39;` 的 `#`，把代码里的引号渲染成 `&#39;` 字面量）。
const TOKEN_RE = /(\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][A-Za-z0-9_]*)/g;
const KEYWORD_SET = new Set(KEYWORDS);

export function highlight(code) {
  let out = '';
  let last = 0;
  for (const m of String(code).matchAll(TOKEN_RE)) {
    out += escapeHtml(code.slice(last, m.index));
    const cls = m[1] ? 'tok-com' : m[2] ? 'tok-str' : m[3] ? 'tok-num' : (KEYWORD_SET.has(m[4]) ? 'tok-key' : null);
    out += cls ? `<span class="${cls}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function inline(text, ctx) {
  let s = escapeHtml(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, href) => {
    const url = ctx.resolveAsset ? ctx.resolveAsset(href) : href;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${alt || href}</a>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const routed = ctx.resolveHref ? ctx.resolveHref(href) : null;
    if (routed) return `<a href="${escapeHtml(routed)}" data-md-link="${escapeHtml(href)}">${label}</a>`;
    const safe = /^(https?:|mailto:)/i.test(href) ? href : null;
    if (safe) return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${label}</a>`;
    return `<span class="badge" title="${escapeHtml(href)}">${label}</span>`;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, url) =>
    `${pre}<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => `<code class="inline-code">${codes[Number(i)]}</code>`);
  return s;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 解析 YAML frontmatter（§7 的记忆文件头：title/kind/day/source_sessions/updated_at） */
export function parseFrontmatter(md) {
  const text = String(md ?? '');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    val = val.replace(/^["']|["']$/g, '');
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * @param {string} md markdown 正文
 * @param {object} [opts]
 * @param {(href:string)=>string|null} [opts.resolveHref] 相对链接 → 应用内路由
 * @param {(src:string)=>string} [opts.resolveAsset] 图片地址
 * @param {boolean} [opts.stripFrontmatter] 是否吞掉 frontmatter（默认吞）
 * @returns {{html:string, meta:object}}
 */
export function renderMarkdown(md, opts = {}) {
  const { meta, body } = parseFrontmatter(md);
  const ctx = { resolveHref: opts.resolveHref || null, resolveAsset: opts.resolveAsset || null };
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i += 1; continue; }

    // 代码块
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      const raw = buf.join('\n');
      out.push(
        `<div class="codeblock"><div class="codeblock-head"><span class="lang">${escapeHtml(lang || 'text')}</span>` +
        `<span class="spacer"></span><button class="btn btn--sm btn--ghost" data-copy="${escapeHtml(raw)}">${icon('copy', 12)}复制</button>` +
        `</div><pre><code>${highlight(raw)}</code></pre></div>`,
      );
      continue;
    }

    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(
        '<div class="table-scroll"><table><thead><tr>' +
        head.map((c) => `<th>${inline(c, ctx)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('') +
        '</tbody></table></div>',
      );
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2], ctx)}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${inline(buf.join('\n'), ctx).replaceAll('\n', '<br>')}</blockquote>`);
      continue;
    }

    // 列表（支持一层嵌套缩进）
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const indent = /^\s*/.exec(lines[i])[0].length;
        const text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        if (indent >= 2 && items.length) items[items.length - 1].children.push(text);
        else items.push({ text, children: [] });
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      const html = items.map((it) => {
        const sub = it.children.length
          ? `<ul>${it.children.map((c) => `<li>${inline(c, ctx)}</li>`).join('')}</ul>`
          : '';
        return `<li>${inline(it.text, ctx)}${sub}</li>`;
      }).join('');
      out.push(`<${tag}>${html}</${tag}>`);
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) &&
      !/^\s*(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
    ) { buf.push(lines[i]); i += 1; }
    out.push(`<p>${inline(buf.join('\n'), ctx).replaceAll('\n', '<br>')}</p>`);
  }
  return { html: out.join('\n'), meta: opts.stripFrontmatter === false ? meta : meta };
}

/** 记忆文件的 frontmatter → 顶部元信息条 */
export function renderMetaStrip(meta, extra = []) {
  const chips = [];
  if (meta.title) chips.push(`<span class="pill">${icon('fileText', 12)}${escapeHtml(meta.title)}</span>`);
  if (meta.kind) chips.push(`<span class="badge badge--accent">${escapeHtml(meta.kind)}</span>`);
  if (meta.day) chips.push(`<span class="pill">${icon('calendar', 12)}${escapeHtml(meta.day)}</span>`);
  const src = Array.isArray(meta.source_sessions) ? meta.source_sessions : (meta.source_sessions ? [meta.source_sessions] : []);
  if (src.length) chips.push(`<span class="pill">${icon('link', 12)}来源 ${src.length} 个会话</span>`);
  if (meta.updated_at) chips.push(`<span class="pill">${icon('clock', 12)}${escapeHtml(String(meta.updated_at))}</span>`);
  for (const e of extra) chips.push(e);
  return chips.length ? `<div class="md-meta">${chips.join('')}</div>` : '';
}
