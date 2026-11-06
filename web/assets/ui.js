// DOM 小工具与通用状态块（空态 / 错误态 / 载入 / 提示 / 确认框 / 剪贴板）。
// 所有空态都「陈述状态 + 给一个可执行动作」，不喊口号，不白屏。
import { icon } from './icons.js';
import { describeError } from './api.js';
import { escapeHtml } from './format.js';

/** 极简 createElement：h('div', {class:'x'}, child, child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'disabled' || k === 'checked' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/**
 * 用 html 字符串建节点。
 * 单个根元素时返回该元素；有多个根元素时返回 DocumentFragment（两者都能直接 append）。
 * 早期版本只取 firstElementChild，多个兄弟节点会被静默丢掉（token 值、设备副行都因此消失过）。
 */
export function fromHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const kids = t.content.children;
  if (kids.length === 1) return t.content.firstElementChild;
  return t.content;
}

export function stateBlock({ glyph = 'info', title, desc, code = '', actions = [], tone = '' }) {
  return fromHtml(
    `<div class="state ${tone ? `state--${tone}` : ''}">
      <div class="state-icon">${icon(glyph, 22)}</div>
      <div class="state-title">${escapeHtml(title)}</div>
      ${desc ? `<div class="state-desc">${escapeHtml(desc)}</div>` : ''}
      ${code ? `<div class="state-code">${escapeHtml(code)}</div>` : ''}
      <div class="state-actions"></div>
    </div>`,
  ).also((root) => {
    const box = root.querySelector('.state-actions');
    for (const a of actions) {
      const btn = h('button', { class: `btn ${a.primary ? 'btn--primary' : ''}` }, a.label);
      btn.addEventListener('click', a.onClick);
      box.append(btn);
    }
    if (!actions.length) box.remove();
  });
}

// 小语法糖：stateBlock(...).also(fn)
Object.defineProperty(Node.prototype, 'also', {
  value(fn) { fn(this); return this; },
  writable: true, configurable: true, enumerable: false,
});

export function loadingBlock(text = '载入中…') {
  return fromHtml(
    `<div class="state"><div class="spinner"></div><div class="state-desc">${escapeHtml(text)}</div></div>`,
  );
}

export function errorBlock(err, what, onRetry) {
  const d = describeError(err, what);
  return stateBlock({
    glyph: 'alert',
    tone: 'error',
    title: d.title,
    desc: d.desc,
    code: d.code,
    actions: onRetry ? [{ label: '重试', onClick: onRetry }] : [],
  });
}

export function emptyBlock({ glyph = 'info', title, desc, action }) {
  return stateBlock({ glyph, title, desc, actions: action ? [action] : [] });
}

// ---------- 提示 ----------
export function toast({ title, body = '', tone = 'info', timeout = 4200 }) {
  const stack = document.getElementById('toast-stack');
  const glyphName = tone === 'ok' ? 'check' : tone === 'bad' ? 'alert' : 'info';
  const node = fromHtml(
    `<div class="toast toast--${tone}">
      <span class="toast-glyph">${icon(glyphName, 15)}</span>
      <div><div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}</div>
    </div>`,
  );
  stack.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

// ---------- 确认框 ----------
export function confirmDialog({ title, body, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const backdrop = fromHtml(
      `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">${escapeHtml(title)}</div>
        <div class="modal-body">${body instanceof Node ? '' : escapeHtml(body || '')}</div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div></div>`,
    );
    if (body instanceof Node) backdrop.querySelector('.modal-body').append(body);
    const done = (v) => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') done(false);
      if (act === 'ok') done(true);
    });
    document.addEventListener('keydown', onKey);
    root.append(backdrop);
    backdrop.querySelector('[data-act="ok"]').focus();
  });
}

// ---------- 剪贴板 ----------
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降级到 execCommand */ }
  try {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** 复制按钮：点完原地变成「已复制」1.6s，不弹通知（Wake 的做法） */
export function wireCopyButtons(root) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(btn.dataset.copy);
    const prev = btn.innerHTML;
    btn.innerHTML = `${icon(ok ? 'check' : 'alert', 12)}${ok ? '已复制' : '复制失败'}`;
    setTimeout(() => { btn.innerHTML = prev; }, 1600);
  });
}

export function wireMdLinks(root, onLink) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-md-link]');
    if (!a) return;
    const target = onLink?.(a.dataset.mdLink);
    if (target) { e.preventDefault(); location.hash = target; }
  });
}

// ---------- 本地偏好 ----------
const PREF_KEY = 'wakedream.prefs';
export const prefs = {
  read() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
  },
  write(patch) {
    const next = { ...prefs.read(), ...patch };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* 隐私模式忽略 */ }
    return next;
  },
};

export { escapeHtml, icon };
