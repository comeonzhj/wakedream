// #/memory 记忆库：左侧文件树（_index.md 置顶 / projects / sessions / kind 标签）
// + 右侧 markdown 渲染（相对链接可在记忆文件间跳转）+ 顶部「复制挂载指令」。
import { API, MEMORY_KINDS } from '../assets/contract.js';
import { apiGet, describeError } from '../assets/api.js';
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, errorBlock, loadingBlock, emptyBlock, toast, copyText, confirmDialog } from '../assets/ui.js';
import { renderMarkdown, renderMetaStrip } from '../assets/markdown.js';
import { fmtBytes, fmtSmart, escapeHtml, basename, today as todayDay } from '../assets/format.js';
import { actionButton } from './common.js';

export default {
  async render(host, ctx) {
    ctx.setTopbar({ title: '记忆库', sub: '做梦产出的 wiki 式语义记忆（只读）', note: '' });

    const state = {
      dreamId: ctx.route.query.dreamId || '',
      path: ctx.route.query.path || '',
      tree: null,
      file: null,
      error: null,
      dreams: [],
    };

    const rail = h('div', { class: 'col col--rail' });
    const reader = h('div', { class: 'col col--reader scroll' });
    host.append(h('div', { class: 'cols cols--rail' }, rail, reader));

    let disposed = false;

    function syncQuery() {
      const params = new URLSearchParams();
      if (state.dreamId) params.set('dreamId', state.dreamId);
      if (state.path) params.set('path', state.path);
      const qs = params.toString();
      history.replaceState(null, '', qs ? `#/memory?${qs}` : '#/memory');
    }

    // ---------- 文件树 ----------
    function renderRail() {
      clear(rail);
      const head = h('div', { class: 'col-head' });
      head.append(h('h2', { text: '记忆库' }));
      head.append(h('span', { class: 'spacer', style: 'flex:1' }));
      rail.append(head);

      const body = h('div', { class: 'scroll', style: 'padding:8px' });
      rail.append(body);

      if (state.dreams.length) {
        const field = h('div', { class: 'field field--select', style: 'margin:4px 4px 8px' });
        const sel = h('select', { 'aria-label': '选择做梦记录' });
        sel.append(h('option', { value: '', text: '最新一次做梦' }));
        for (const d of state.dreams) {
          const opt = h('option', { value: d.id, text: `${d.day} · ${d.sessionCount ?? 0} 会话 · ${d.status}` });
          if (d.id === state.dreamId) opt.selected = true;
          sel.append(opt);
        }
        sel.addEventListener('change', () => {
          state.dreamId = sel.value;
          state.path = '';
          syncQuery();
          load();
        });
        field.append(sel, fromHtml(`<span class="field-icon">${icon('chevronDown', 13)}</span>`));
        body.append(field);
      }

      if (state.error) {
        body.append(errorBlock(state.error, '记忆库', load));
        return;
      }
      const files = state.tree?.files || [];
      if (!files.length) {
        body.append(fromHtml(
          `<div class="state state--compact"><div class="state-icon">${icon('brain', 20)}</div>
           <div class="state-title">记忆库还是空的</div>
           <div class="state-desc">跑一次「现在做梦」，这里会出现 _index.md 与各项目的记忆文件。</div></div>`,
        ));
        const btn = actionButton('去做梦', { iconName: 'moon', primary: true, onClick: () => ctx.navigate('#/dreams') });
        body.append(h('div', { class: 'state-actions', style: 'justify-content:center' }, btn));
        return;
      }

      const byPath = new Map(files.map((f) => [f.path, f]));
      const groups = new Map();
      const rootFiles = [];
      for (const f of files) {
        const dir = f.path.includes('/') ? f.path.split('/')[0] : '';
        if (!dir) rootFiles.push(f);
        else {
          if (!groups.has(dir)) groups.set(dir, []);
          groups.get(dir).push(f);
        }
      }

      // 置顶：_index.md
      const index = rootFiles.find((f) => basename(f.path) === '_index.md');
      if (index) body.append(fileRow(index, { pinned: true }));

      const rootRest = rootFiles.filter((f) => f !== index);
      if (rootRest.length) {
        body.append(h('div', { class: 'tree-group', text: '根目录' }));
        for (const f of rootRest) body.append(fileRow(f));
      }
      const order = ['projects', 'sessions', 'people'];
      const dirs = [...groups.keys()].sort((a, b) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      for (const dir of dirs) {
        body.append(h('div', { class: 'tree-group', text: dir === 'projects' ? '按项目' : dir === 'sessions' ? '按会话' : dir }));
        for (const f of groups.get(dir).sort((a, b) => a.path.localeCompare(b.path))) body.append(fileRow(f, { child: true }));
      }

      const rootLine = h('div', { class: 'hint mono', style: 'padding:10px 6px' });
      rootLine.textContent = state.tree?.root || '';
      rootLine.title = state.tree?.root || '';
      body.append(rootLine);
      void byPath;
    }

    function fileRow(f, { pinned = false, child = false } = {}) {
      const row = h('button', {
        class: `tree-row ${child ? 'tree-row--child' : ''} ${pinned ? 'tree-row--pinned' : ''} ${f.path === state.path ? 'is-active' : ''}`,
        type: 'button',
      });
      const kind = f.kind || MEMORY_KINDS[basename(f.path)] || (f.path.endsWith('.md') ? 'md' : '');
      row.innerHTML =
        `${icon(pinned ? 'bookOpen' : 'fileText', 13)}` +
        `<span class="tree-label" title="${escapeHtml(f.path)}">${escapeHtml(f.title || basename(f.path))}</span>` +
        (kind ? `<span class="badge">${escapeHtml(kind)}</span>` : '');
      row.addEventListener('click', () => {
        state.path = f.path;
        syncQuery();
        renderRail();
        loadFile();
      });
      return row;
    }

    // ---------- 阅读面 ----------
    async function loadFile() {
      clear(reader);
      if (!state.tree?.files?.length) {
        reader.append(emptyBlock({
          glyph: 'brain',
          title: '没有可读的记忆文件',
          desc: '先跑一次做梦，或者换一个做梦记录。',
          action: actionButton('去梦页', { primary: true, onClick: () => ctx.navigate('#/dreams') }),
        }));
        return;
      }
      const files = state.tree.files;
      const target = state.path && files.some((f) => f.path === state.path)
        ? state.path
        : (files.find((f) => basename(f.path) === '_index.md')?.path || files[0].path);
      state.path = target;
      reader.append(loadingBlock('读取记忆文件…'));
      try {
        const res = await apiGet(API.memoryFile, { path: target, dreamId: state.dreamId || undefined });
        if (disposed) return;
        state.file = res;
        renderFile(res);
      } catch (err) {
        clear(reader);
        reader.append(errorBlock(err, `记忆文件 ${target}`, loadFile));
      }
    }

    function renderFile(res) {
      clear(reader);
      const inner = h('div', { class: 'reader-inner' });
      const meta = state.tree.files.find((f) => f.path === res.path) || {};

      const top = h('div', { class: 'reader-top' });
      top.innerHTML = `${icon('fileText', 16)}<span class="badge">${escapeHtml(meta.kind || MEMORY_KINDS[basename(res.path)] || 'memory')}</span>`;
      top.append(h('span', { class: 'spacer', style: 'flex:1' }));
      top.append(actionButton('复制挂载指令', {
        iconName: 'clipboard', small: true, primary: true,
        onClick: () => showMountDialog(ctx, state),
      }));
      top.append(actionButton('复制路径', {
        iconName: 'copy', small: true,
        onClick: async () => {
          const full = `${state.tree?.root || ''}/${res.path}`.replace(/\/+/g, '/');
          const ok = await copyText(full);
          toast({ title: ok ? '已复制记忆文件路径' : '复制失败', body: full, tone: ok ? 'ok' : 'bad' });
        },
      }));
      inner.append(top);

      inner.append(h('h2', { class: 'reader-title mono', style: 'font-size:18px', text: res.path }));

      const md = renderMarkdown(res.markdown || '', {
        resolveHref: (href) => {
          const clean = resolveRelative(res.path, href);
          if (!clean) return null;
          return `#/memory?${state.dreamId ? `dreamId=${encodeURIComponent(state.dreamId)}&` : ''}path=${encodeURIComponent(clean)}`;
        },
      });
      const strip = renderMetaStrip(md.meta, [
        meta.bytes ? `<span class="pill">${icon('database', 12)}${escapeHtml(fmtBytes(meta.bytes))}</span>` : '',
        meta.updatedAt ? `<span class="pill">${icon('clock', 12)}${escapeHtml(fmtSmart(meta.updatedAt))}</span>` : '',
      ].filter(Boolean));
      if (strip) inner.append(fromHtml(strip));

      const bodyCard = fromHtml(`<div class="card markdown">${md.html || '<p class="hint">（空文件）</p>'}</div>`);
      inner.append(bodyCard);
      reader.append(inner);

      // 记忆文件之间的互链：点击后重新加载对应文件
      inner.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-md-link]');
        if (!a) return;
        const href = a.dataset.mdLink;
        const clean = resolveRelative(res.path, href);
        const exists = state.tree.files.some((f) => f.path === clean);
        if (!exists) {
          e.preventDefault();
          toast({ title: '记忆库里没有这个文件', body: `${clean}（链接指向的文件尚未生成）`, tone: 'info' });
          return;
        }
        e.preventDefault();
        state.path = clean;
        syncQuery();
        renderRail();
        loadFile();
        reader.scrollTop = 0;
      });
    }

    // ---------- 数据 ----------
    async function load() {
      state.error = null;
      try {
        const [treeRes, dreamsRes] = await Promise.all([
          apiGet(API.memoryTree, { dreamId: state.dreamId || undefined }),
          apiGet(API.dreams).catch(() => ({ dreams: [] })),
        ]);
        state.tree = treeRes;
        state.dreams = dreamsRes.dreams || [];
      } catch (err) {
        state.error = err;
        state.tree = null;
        renderRail();
        clear(reader);
        reader.append(errorBlock(err, '记忆库', load));
        return;
      }
      if (disposed) return;
      renderRail();
      await loadFile();
    }

    await load();

    return {
      refresh: load,
      destroy() { disposed = true; },
    };
  },
};

/** 相对当前记忆文件解析链接（支持 ./ ../ 与子目录） */
export function resolveRelative(fromPath, href) {
  if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
  const clean = href.split('#')[0];
  if (!clean) return null;
  const baseDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
  const parts = `${baseDir}${clean}`.split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** 把「只读挂载记忆目录」的说明拼成可直接粘贴的片段（§7：不代写别家配置） */
export function mountInstruction(state) {
  const root = state.tree?.root || '<记忆目录>';
  const index = (state.tree?.files || []).find((f) => basename(f.path) === '_index.md');
  const projects = (state.tree?.files || []).filter((f) => f.path.startsWith('projects/')).map((f) => `  - ${f.path}`);
  return [
    '# WakeDream 长期记忆（只读挂载）',
    '',
    `记忆目录：${root}`,
    `入口文件：${index ? `${root}/${index.path}` : `${root}/_index.md`}`,
    `生成日期：${todayDay()}`,
    '',
    '把下面这段粘进新会话的 CLAUDE.md / AGENTS.md，或直接贴在提示词开头：',
    '',
    '---',
    '## 长期记忆（WakeDream，只读挂载）',
    '',
    'WakeDream 每天夜里会把当天所有 Agent（Claude Code / Codex / DeepSeek Harness …）的会话',
    '萃取成一份 wiki 式语义记忆库，目录：',
    '',
    root,
    '',
    `开始任务前先读 ${root}/_index.md，再按里面的相对链接进入：`,
    '  - projects/<项目>.md —— 各项目今天推进了什么、结论、未决问题',
    '  - decisions.md —— 当天做出的决定与理由',
    '  - preferences.md —— 用户偏好与工作方式',
    '  - open-questions.md —— 需要下个会话跟进的事',
    ...(projects.length ? projects : []),
    '',
    '约束：这个目录是**只读挂载**——不要修改其中任何文件；',
    '要沉淀新的记忆，请写进你自己的记忆区，并告诉用户你写了什么。',
    '---',
    '',
  ].join('\n');
}

function showMountDialog(ctx, state) {
  const text = mountInstruction(state);
  const pre = h('pre', {
    class: 'io-panel',
    style: 'max-height:46vh;white-space:pre-wrap;font-size:12px',
    text,
  });
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, pre);
  const bar = h('div', { style: 'display:flex;gap:8px;align-items:center' });
  bar.append(
    actionButton('复制到剪贴板', {
      iconName: 'copy', primary: true,
      onClick: async () => {
        const ok = await copyText(text);
        toast({ title: ok ? '挂载指令已复制' : '复制失败', body: ok ? '粘到新会话的 CLAUDE.md / AGENTS.md 即可' : '请手动选中复制', tone: ok ? 'ok' : 'bad' });
      },
    }),
    h('span', { class: 'hint', text: 'WakeDream 只提供指令，不代写别家的配置文件。' }),
  );
  wrap.append(bar);
  confirmDialog({
    title: '把记忆目录只读挂给新会话',
    body: wrap,
    confirmText: '关闭',
    cancelText: '关闭',
  });
}
