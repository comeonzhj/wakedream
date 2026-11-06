// 转录阅读面：气泡（user 右 / assistant 左）、thinking 折叠、工具调用折叠簇、代码高亮、消息内搜索。
// 只读渲染；工具/思考的展开状态各自独立，互不连带（Wake 的约定）。
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, copyText, toast } from '../assets/ui.js';
import { renderMarkdown } from '../assets/markdown.js';
import {
  agentMeta, agentName, hostBadge, hostKindCN, fmtTime, fmtDateTime, fmtSmart, fmtNum,
  fmtTokens, fmtDuration, fmtBytes, escapeHtml, truncate, homeShort, firstLine, basename,
} from '../assets/format.js';
import { agentTagHtml, actionButton, iconButton } from './common.js';

/** 把消息序列折成「正文」与「工具簇」两类块 */
export function buildItems(messages) {
  const items = [];
  const byCallId = new Map();
  for (const m of messages) {
    if (m.kind === 'tool_call') {
      let last = items[items.length - 1];
      if (!last || last.type !== 'tools') {
        last = { type: 'tools', calls: [], orphan: [] };
        items.push(last);
      }
      const entry = { call: m, result: null };
      last.calls.push(entry);
      if (m.meta?.callId) byCallId.set(m.meta.callId, entry);
      continue;
    }
    if (m.kind === 'tool_result') {
      const id = m.meta?.callId;
      const target = id ? byCallId.get(id) : null;
      if (target && !target.result) { target.result = m; byCallId.delete(id); continue; }
      const last = items[items.length - 1];
      if (last && last.type === 'tools') {
        const open = [...last.calls].reverse().find((c) => !c.result);
        if (open) { open.result = m; continue; }
        last.orphan.push(m);
        continue;
      }
      items.push({ type: 'tools', calls: [], orphan: [m] });
      continue;
    }
    items.push({ type: 'msg', msg: m });
  }
  return items;
}

export function toolName(m) {
  const meta = m?.meta || {};
  return meta.name || meta.tool || meta.toolName || (m?.kind === 'tool_result' ? '工具结果' : '工具');
}
export function toolInput(m) {
  const meta = m?.meta || {};
  const raw = meta.input ?? meta.args ?? meta.arguments ?? meta.params;
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
}
export function toolOutput(m) {
  const meta = m?.meta || {};
  const raw = meta.output ?? meta.result ?? (m?.kind === 'tool_result' ? m.text : '');
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : String(raw);
}
function toolOk(m) {
  const meta = m?.meta || {};
  if (typeof meta.ok === 'boolean') return meta.ok;
  if (typeof meta.isError === 'boolean') return !meta.isError;
  if (meta.error) return false;
  return true;
}

/** 折叠面板（head + 懒渲染 body） */
function fold({ headHtml, buildBody, open = false, className = 'fold' }) {
  const root = fromHtml(`<div class="${className}"></div>`);
  const head = fromHtml(`<button class="fold-head" type="button">${headHtml}</button>`);
  const body = h('div', { class: 'fold-body', hidden: true });
  let built = false;
  const apply = () => {
    body.hidden = !open;
    if (open && !built) { body.append(...buildBody()); built = true; }
    head.querySelector('.fold-chevron')?.setAttribute('style', open ? '' : 'transform:rotate(-90deg)');
  };
  head.addEventListener('click', () => { open = !open; apply(); });
  root.append(head, body);
  apply();
  return root;
}

function getMarkdownOpts() {
  return { resolveHref: null, resolveAsset: (src) => src };
}

export function renderMessageBlock(m, { showMeta = false } = {}) {
  const role = m.role || 'assistant';
  const kind = m.kind || 'text';
  const opts = getMarkdownOpts();

  if (kind === 'meta') {
    if (!showMeta) return null;
    const type = m.meta?.type || m.meta?.source || 'meta';
    const node = h('div', { class: 'msg msg-system' });
    node.append(fold({
      headHtml: `${icon('info', 12)}<span class="fold-summary">元信息 · ${escapeHtml(type)}</span><span class="fold-chevron">${icon('chevronDown', 12)}</span>`,
      buildBody: () => [fromHtml(`<div class="io-panel">${escapeHtml(m.text || JSON.stringify(m.meta || {}, null, 2))}</div>`)],
    }));
    return node;
  }

  if (kind === 'thinking') {
    const text = m.text || '';
    if (!text.trim()) return null;
    const summary = truncate(firstLine(text, 160), 160);
    const node = h('div', { class: 'msg msg-assistant' });
    node.append(fold({
      className: 'thinking-fold',
      headHtml:
        `${icon('brain', 12)}<span class="fold-summary">思考 · ${escapeHtml(summary || '（空）')}</span>` +
        `<span class="fold-chevron" style="margin-left:auto">${icon('chevronDown', 12)}</span>`,
      buildBody: () => [fromHtml(`<div class="thinking-text">${escapeHtml(text)}</div>`)],
    }));
    return node;
  }

  if (kind === 'tool_call' || kind === 'tool_result') return null; // 由工具簇统一渲染

  const text = m.text || '';
  if (!text.trim()) return null;
  const rendered = renderMarkdown(text, opts);
  const node = h('div', { class: `msg msg-${role}` });
  const head = h('div', { class: 'msg-head' });
  head.innerHTML = `<span class="msg-time" title="${escapeHtml(fmtDateTime(m.ts))}">${escapeHtml(fmtTime(m.ts))}</span>` +
    (role === 'user' ? '<span>你</span>' : role === 'system' ? '<span>系统</span>' : '');
  node.append(head);
  node.append(fromHtml(`<div class="msg-body">${rendered.html}</div>`));
  return node;
}

export function renderToolCluster(cluster) {
  const calls = cluster.calls;
  const total = calls.length + cluster.orphan.length;
  const names = [...new Set([...calls.map((c) => toolName(c.call)), ...cluster.orphan.map((m) => toolName(m))])];
  const failed = calls.filter((c) => c.result && !toolOk(c.result)).length +
    cluster.orphan.filter((m) => !toolOk(m)).length;
  const node = h('div', { class: 'msg msg-assistant' });
  node.append(fold({
    headHtml:
      `<span class="fold-chevron">${icon('chevronDown', 12)}</span>` +
      `${icon('wrench', 12)}` +
      `<span class="fold-summary">${escapeHtml(names.slice(0, 4).join(' · '))}${names.length > 4 ? ` 等 ${names.length} 个工具` : ''}</span>` +
      (failed ? `<span class="badge badge--bad">${failed} 个失败</span>` : '') +
      `<span class="fold-count">${total} 次调用</span>`,
    buildBody: () => {
      const out = [];
      for (const c of calls) out.push(toolItem(c.call, c.result));
      for (const m of cluster.orphan) out.push(toolItem(null, m));
      return out;
    },
  }));
  return node;
}

function toolItem(call, result) {
  const wrap = h('div', { class: 'fold-item' });
  const name = toolName(call || result);
  const ok = result ? toolOk(result) : true;
  const dur = result?.meta?.durationMs;
  const head = h('div', { class: 'fold-item-head' });
  head.innerHTML =
    `<span class="tool-name">${escapeHtml(name)}</span>` +
    (result ? `<span class="badge ${ok ? 'badge--ok' : 'badge--bad'}">${ok ? '成功' : '失败'}</span>` : '<span class="badge">无结果</span>') +
    (dur !== undefined ? `<span>${escapeHtml(fmtDuration(dur))}</span>` : '') +
    (call?.meta?.childId ? '<span class="badge badge--accent">子代理会话</span>' : '') +
    `<span class="spacer" style="flex:1"></span>`;
  const childId = call?.meta?.childId;
  if (childId) {
    const link = actionButton('打开子代理会话', { small: true, onClick: () => { location.hash = `#/sessions/${encodeURIComponent(childId)}`; } });
    head.append(link);
  }
  wrap.append(head);

  const input = toolInput(call);
  if (input) wrap.append(panel('入参', input));
  const output = toolOutput(result || call);
  if (output) wrap.append(panel(ok ? '结果' : '错误', output, !ok));
  if (!input && !output) wrap.append(fromHtml('<div class="hint">这次调用没有记录入参与结果。</div>'));
  return wrap;
}

function panel(label, text, isError = false) {
  const shown = text.length > 600 ? `${text.slice(0, 600)}\n…（已截断显示，共 ${text.length} 字符）` : text;
  const box = h('div', {});
  const head = h('div', { class: 'fold-item-head' });
  head.innerHTML = `<span>${escapeHtml(label)}</span><span class="spacer" style="flex:1"></span>`;
  const copyBtn = fromHtml(`<button class="btn btn--sm btn--ghost" type="button">${icon('copy', 12)}复制完整原文</button>`);
  copyBtn.addEventListener('click', async () => {
    const done = await copyText(text);
    toast({ title: done ? '已复制' : '复制失败', body: `${label} · ${text.length} 字符`, tone: done ? 'ok' : 'bad', timeout: 1800 });
  });
  head.append(copyBtn);
  box.append(head, fromHtml(`<div class="io-panel ${isError ? 'is-error' : ''}">${escapeHtml(shown)}</div>`));
  return box;
}

/** 消息内搜索高亮：返回命中数 */
export function highlightIn(root, term) {
  if (!term) return 0;
  const needle = term.toLowerCase();
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest('button, script, style, mark')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0;
    const lower = text.toLowerCase();
    while (i < text.length) {
      const at = lower.indexOf(needle, i);
      if (at < 0) { frag.append(document.createTextNode(text.slice(i))); break; }
      if (at > i) frag.append(document.createTextNode(text.slice(i, at)));
      const mark = document.createElement('mark');
      mark.className = 'hit';
      mark.textContent = text.slice(at, at + needle.length);
      frag.append(mark);
      count += 1;
      i = at + needle.length;
    }
    node.parentNode.replaceChild(frag, node);
  }
  return count;
}

/** 会话元信息头 */
export function renderSessionHeader(session, { backHref = '#/sessions', messages = [] } = {}) {
  const box = h('div', { class: 'reader-head' });
  const top = h('div', { class: 'reader-top' });
  const back = iconButton('chevronLeft', { title: '返回会话列表', onClick: () => { location.hash = backHref; } });
  top.append(back);
  top.append(fromHtml(agentTagHtml(session.agent)));
  if (session.project) top.append(fromHtml(`<span class="badge">${escapeHtml(session.project)}</span>`));
  const hb = hostBadge(session.host);
  if (hb) top.append(fromHtml(`<span class="badge badge--host">${escapeHtml(hb)}</span>`));
  if (session.model) top.append(fromHtml(`<span class="badge badge--outline">${escapeHtml(session.model)}</span>`));
  top.append(h('span', { class: 'spacer', style: 'flex:1' }));
  if (session.filePath) {
    const copyBtn = actionButton('复制路径', {
      small: true,
      iconName: 'copy',
      onClick: async () => {
        const ok = await copyText(session.filePath);
        toast({ title: ok ? '已复制会话路径' : '复制失败', body: session.filePath, tone: ok ? 'ok' : 'bad' });
      },
    });
    top.append(copyBtn);
  }
  box.append(top);

  box.append(h('h2', { class: 'reader-title', text: session.title || '(无标题会话)' }));

  const meta = h('div', { class: 'meta-strip' });
  const startTs = session.startedAt;
  const endTs = session.endedAt;
  const bits = [
    `<span class="kv">${icon('clock', 12)}<span class="kv-v" title="${escapeHtml(fmtDateTime(startTs))}">${escapeHtml(fmtSmart(startTs))}${endTs && endTs !== startTs ? ` → ${escapeHtml(fmtSmart(endTs))}` : ''}</span></span>`,
    `<span class="kv">${icon('messages', 12)}<span class="kv-v">${session.messageCount ?? messages.length} 条消息</span></span>`,
  ];
  if (session.tokens !== null && session.tokens !== undefined) {
    bits.push(`<span class="kv">${icon('zap', 12)}<span class="kv-v">${escapeHtml(fmtNum(session.tokens))} tokens</span></span>`);
  }
  if (session.fileSize) bits.push(`<span class="kv">${icon('database', 12)}<span class="kv-v">${escapeHtml(fmtBytes(session.fileSize))}</span></span>`);
  bits.push(`<span class="kv">${icon('server', 12)}<span class="kv-v">${escapeHtml(hostKindCN(session.host))} · ${escapeHtml(session.source || session.host || 'local')}</span></span>`);
  if (session.isSubagent) bits.push('<span class="badge badge--accent">子会话</span>');
  meta.innerHTML = bits.join('');
  box.append(meta);

  const paths = h('div', { class: 'meta-strip', style: 'margin-top:6px' });
  if (session.cwd) paths.append(fromHtml(`<span class="path-chip" title="${escapeHtml(session.cwd)}">${escapeHtml(homeShort(session.cwd))}</span>`));
  if (session.filePath) paths.append(fromHtml(`<span class="path-chip" title="${escapeHtml(session.filePath)}">${escapeHtml(homeShort(session.filePath))}</span>`));
  if (session.parentId) {
    const link = fromHtml(`<a href="#/sessions/${encodeURIComponent(session.parentId)}" class="badge badge--accent">父会话 ${escapeHtml(truncate(session.parentId, 40))}</a>`);
    paths.append(link);
  }
  if (paths.children.length) box.append(paths);
  return box;
}

/** 完整的转录阅读面 */
export function buildTranscript({ session, messages, ctx }) {
  const wrap = h('div', { class: 'reader-inner' });
  wrap.append(renderSessionHeader(session, { backHref: `#/sessions${ctx?.route?.query && Object.keys(ctx.route.query).length ? `?${new URLSearchParams(ctx.route.query)}` : ''}`, messages }));

  // 工具条：消息内搜索 + 显示开关
  const toolbar = h('div', { class: 'reader-toolbar' });
  const searchField = h('div', { class: 'field', style: 'max-width:280px' });
  searchField.innerHTML = `<span class="field-icon">${icon('search', 13)}</span>`;
  const searchInput = h('input', { type: 'search', placeholder: '消息内搜索', 'aria-label': '消息内搜索' });
  searchField.append(searchInput);
  toolbar.append(searchField);
  const hitLabel = h('span', { class: 'hint', text: '' });
  toolbar.append(hitLabel);
  const prevBtn = actionButton('上一个', { small: true, iconName: 'chevronLeft' });
  const nextBtn = actionButton('下一个', { small: true, iconName: 'chevronRight' });
  toolbar.append(prevBtn, nextBtn);

  let showThinking = true;
  let showMeta = false;
  const thinkingToggle = actionButton('隐藏思考', {
    small: true,
    onClick: () => {
      showThinking = !showThinking;
      thinkingToggle.querySelector('span').textContent = showThinking ? '隐藏思考' : '显示思考';
      render();
    },
  });
  const metaToggle = actionButton('显示元信息', {
    small: true,
    onClick: () => {
      showMeta = !showMeta;
      metaToggle.querySelector('span').textContent = showMeta ? '隐藏元信息' : '显示元信息';
      render();
    },
  });
  toolbar.append(h('span', { class: 'spacer', style: 'flex:1' }), thinkingToggle, metaToggle);
  wrap.append(toolbar);

  const listBox = h('div', { class: 'msg-list' });
  wrap.append(listBox);

  let marks = [];
  let markIndex = -1;

  function render() {
    clear(listBox);
    const items = buildItems(messages);
    let rendered = 0;
    for (const item of items) {
      if (item.type === 'tools') {
        if (!item.calls.length && !item.orphan.length) continue;
        listBox.append(renderToolCluster(item));
        rendered += 1;
        continue;
      }
      const m = item.msg;
      if (m.kind === 'thinking' && !showThinking) { listBox.append(thinkingCollapsedStub(m)); rendered += 1; continue; }
      const node = renderMessageBlock(m, { showMeta });
      if (node) { listBox.append(node); rendered += 1; }
    }
    if (!rendered) {
      listBox.append(fromHtml(
        `<div class="state state--compact"><div class="state-icon">${icon('messages', 20)}</div>
        <div class="state-title">这个会话没有可显示的正文</div>
        <div class="state-desc">可能只包含被隐藏的元信息与工具调用；试试打开「显示元信息」。</div></div>`,
      ));
    }
    applySearch();
  }

  function thinkingCollapsedStub(m) {
    const node = h('div', { class: 'msg msg-assistant' });
    node.append(fromHtml(
      `<div class="thinking-fold" style="cursor:pointer">${icon('brain', 12)} <span class="thinking-summary">思考已折叠（${escapeHtml(String((m.text || '').length))} 字符）· 点顶部「显示思考」展开</span></div>`,
    ));
    return node;
  }

  function applySearch() {
    const term = searchInput.value.trim();
    for (const el of listBox.querySelectorAll('mark.hit')) {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    }
    marks = [];
    markIndex = -1;
    if (!term) { hitLabel.textContent = ''; return; }
    const total = highlightIn(listBox, term);
    marks = [...listBox.querySelectorAll('mark.hit')];
    hitLabel.textContent = total ? `${total} 处命中` : '没有命中';
    if (marks.length) { markIndex = 0; focusMark(); }
  }

  function focusMark() {
    marks.forEach((m, i) => m.classList.toggle('is-current', i === markIndex));
    marks[markIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    hitLabel.textContent = `${markIndex + 1} / ${marks.length} 处命中`;
  }

  prevBtn.addEventListener('click', () => { if (marks.length) { markIndex = (markIndex - 1 + marks.length) % marks.length; focusMark(); } });
  nextBtn.addEventListener('click', () => { if (marks.length) { markIndex = (markIndex + 1) % marks.length; focusMark(); } });
  let timer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(applySearch, 200);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prevBtn.click(); else nextBtn.click(); }
  });

  render();
  return wrap;
}

export { buildItems as _buildItems };
