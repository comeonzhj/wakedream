// #/dreams 梦：历次运行列表 + 详情（reportMarkdown + 输入会话清单 + 记忆文件清单）+ 运行进度轮询。
import { API } from '../assets/contract.js';
import { apiGet, apiPost, apiDelete, describeError } from '../assets/api.js';
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, errorBlock, loadingBlock, emptyBlock, toast, confirmDialog } from '../assets/ui.js';
import { renderMarkdown, renderMetaStrip, parseFrontmatter } from '../assets/markdown.js';
import {
  fmtDayCN, weekdayCN, fmtDateTime, fmtDuration, fmtNum, fmtSmart, escapeHtml, truncate,
  dreamStatus, today as todayDay, agentName, hostBadge,
} from '../assets/format.js';
import { actionButton, sectionEl, agentDot, hostBadgeHtml } from './common.js';
import { runDream } from '../app.js';

export default {
  async render(host, ctx) {
    ctx.setTopbar({ title: '做梦', sub: '夜间把当天会话萃取成记忆库', note: '' });

    const listCol = h('div', { class: 'col col--list' });
    const detailCol = h('div', { class: 'col col--reader scroll' });
    host.append(h('div', { class: 'cols cols--2' }, listCol, detailCol));

    let dreams = [];
    let selectedId = ctx.route.id || ctx.route.query.dreamId || null;
    let disposed = false;
    let pollTimer = null;

    // ---------- 列表 ----------
    function renderList() {
      clear(listCol);
      const head = h('div', { class: 'col-head' });
      head.append(h('h2', { text: '做梦记录' }));
      head.append(h('span', { class: 'col-sub', text: dreams.length ? `最近 ${dreams.length} 次` : '' }));
      head.append(h('span', { class: 'spacer', style: 'flex:1' }));
      listCol.append(head);

      const body = h('div', { class: 'col-body scroll' });
      listCol.append(body);

      // 运行区
      const runner = h('div', { class: 'form-panel', style: 'margin:12px;gap:8px' });
      runner.append(h('div', { class: 'section-note', text: '把某一天的会话萃取成记忆库（同步执行，完成前请勿关闭页面）。' }));
      const row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' });
      const dayInput = h('input', { class: 'field', type: 'date', value: todayDay(), style: 'height:32px;padding:0 8px', 'aria-label': '做梦日期' });
      const providerSel = h('select', { class: 'field', style: 'height:32px;padding:0 8px', 'aria-label': '供应商' });
      for (const p of [['', '默认供应商'], ['heuristic', 'heuristic（本地规则）'], ['anthropic', 'anthropic'], ['openai-compatible', 'openai-compatible']]) {
        providerSel.append(h('option', { value: p[0], text: p[1] }));
      }
      const runBtn = actionButton('现在做梦', {
        iconName: 'play',
        primary: true,
        onClick: async () => {
          runBtn.disabled = true;
          startPolling();
          const res = await runDream({ day: dayInput.value || todayDay(), provider: providerSel.value || undefined });
          stopPolling();
          runBtn.disabled = false;
          await load();
          if (res?.dreamId) selectDream(res.dreamId);
        },
      });
      row.append(dayInput, providerSel, runBtn);
      runner.append(row);
      body.append(runner);

      if (!dreams.length) {
        body.append(emptyBlock({
          glyph: 'moon',
          title: '还没有做过梦',
          desc: '先扫描当天会话，再点上面的「现在做梦」；也可以在设置里打开夜间自动做梦。',
        }));
        return;
      }

      for (const d of dreams) {
        const st = dreamStatus(d.status);
        const row = h('button', { class: `row ${d.id === selectedId ? 'is-active' : ''}`, type: 'button' });
        const dur = d.startedAt && d.finishedAt ? fmtDuration(d.finishedAt - d.startedAt) : null;
        row.innerHTML =
          `<span class="row-title">${escapeHtml(fmtDayCN(d.day))} · ${escapeHtml(weekdayCN(d.day))}</span>` +
          `<span class="row-meta">` +
          `<span class="badge ${st.tone === 'ok' ? 'badge--ok' : st.tone === 'bad' ? 'badge--bad' : st.tone === 'busy' ? 'badge--accent' : ''}">${escapeHtml(st.label)}</span>` +
          `<span>${escapeHtml(d.provider || 'heuristic')}${d.model ? ` · ${escapeHtml(d.model)}` : ''}</span>` +
          `<span class="spacer" style="flex:1"></span>` +
          `<span class="row-time">${escapeHtml(dur ? `耗时 ${dur}` : fmtSmart(d.startedAt))}</span>` +
          `</span>` +
          `<span class="row-meta"><span>${d.sessionCount ?? 0} 个会话</span></span>`;
        row.addEventListener('click', () => selectDream(d.id));
        body.append(row);
      }
    }

    function selectDream(id) {
      selectedId = id;
      renderList();
      renderDetail();
      history.replaceState(null, '', `#/dreams/${encodeURIComponent(id)}`);
    }

    // ---------- 详情 ----------
    async function renderDetail() {
      clear(detailCol);
      if (!selectedId) {
        detailCol.append(emptyBlock({
          glyph: 'moon',
          title: '未选择做梦记录',
          desc: '从左边选一次运行，看它的报告、输入会话与产出的记忆文件。',
        }));
        return;
      }
      detailCol.append(loadingBlock('载入做梦详情…'));
      let payload;
      try {
        payload = await apiGet(API.dream(selectedId));
      } catch (err) {
        clear(detailCol);
        detailCol.append(errorBlock(err, '做梦详情', renderDetail));
        return;
      }
      if (disposed) return;
      clear(detailCol);
      const { dream, inputs = [], reportMarkdown = '' } = payload;
      const inner = h('div', { class: 'reader-inner' });

      const st = dreamStatus(dream.status);
      const top = h('div', { class: 'reader-top' });
      top.innerHTML = `${icon('moon', 16)}<span class="badge ${st.tone === 'ok' ? 'badge--ok' : st.tone === 'bad' ? 'badge--bad' : 'badge--accent'}">${escapeHtml(st.label)}</span>`;
      top.append(h('span', { class: 'spacer', style: 'flex:1' }));
      if (dream.memoryDir) {
        top.append(actionButton('打开记忆库', {
          small: true,
          iconName: 'brain',
          onClick: () => ctx.navigate(`#/memory?dreamId=${encodeURIComponent(dream.id)}`),
        }));
      }
      top.append(actionButton('删除这次记录', {
        small: true,
        iconName: 'trash',
        onClick: async () => {
          const ok = await confirmDialog({
            title: `删除 ${dream.day} 的做梦记录？`,
            body: '只删记忆产物与这条记录，不动原始会话文件。',
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await apiDelete(API.dream(dream.id));
            toast({ title: '已删除', body: `${dream.day} 的记忆产物`, tone: 'ok' });
            selectedId = null;
            history.replaceState(null, '', '#/dreams');
            await load();
          } catch (err) {
            toast({ title: '删除失败', body: describeError(err, '删除').desc, tone: 'bad' });
          }
        },
      }));
      inner.append(top);

      inner.append(h('h2', { class: 'reader-title', text: `${fmtDayCN(dream.day)}的梦` }));
      const meta = h('div', { class: 'meta-strip' });
      const dur = dream.startedAt && dream.finishedAt ? fmtDuration(dream.finishedAt - dream.startedAt) : null;
      meta.innerHTML = [
        `<span class="kv">${icon('clock', 12)}<span class="kv-v" title="${escapeHtml(fmtDateTime(dream.startedAt))}">${escapeHtml(fmtDateTime(dream.startedAt))}${dur ? ` · 耗时 ${escapeHtml(dur)}` : ''}</span></span>`,
        `<span class="kv">${icon('messages', 12)}<span class="kv-v">${dream.sessionCount ?? inputs.length} 个会话</span></span>`,
        `<span class="kv">${icon('cpu', 12)}<span class="kv-v">${escapeHtml(dream.provider || 'heuristic')}${dream.model ? ` · ${escapeHtml(dream.model)}` : ''}</span></span>`,
        dream.store ? `<span class="kv">${icon('layers', 12)}<span class="kv-v">store: ${escapeHtml(dream.store)}</span></span>` : '',
        dream.reportPath ? `<span class="kv">${icon('fileText', 12)}<span class="kv-v mono">${escapeHtml(dream.reportPath)}</span></span>` : '',
      ].filter(Boolean).join('');
      inner.append(meta);
      if (dream.error) {
        inner.append(fromHtml(`<div class="form-panel" style="border-color:var(--danger);color:var(--danger);margin-top:12px">${escapeHtml(dream.error)}</div>`));
      }

      // 报告
      const reportSection = sectionEl('萃取报告', { note: 'reportMarkdown' });
      if (reportMarkdown.trim()) {
        const md = renderMarkdown(reportMarkdown, {
          resolveHref: (href) => resolveMemoryHref(href, dream, ctx),
        });
        reportSection.append(fromHtml(`<div class="card markdown">${md.html}</div>`));
      } else {
        reportSection.append(fromHtml(
          '<div class="card hint">这次运行没有留下报告正文（可能只写入了记忆文件）。</div>',
        ));
      }
      inner.append(reportSection);

      // 输入会话
      inner.append(sectionEl('输入会话', {
        note: `${inputs.length} 个`,
        body: inputs.length
          ? fromHtml(`<div class="card" style="padding:6px 10px">${inputs.map((s) => `
              <button class="mini-row" type="button" data-session="${escapeHtml(s.id)}">
                ${agentDot(s.agent)}<span class="mini-title">${escapeHtml(truncate(s.title || s.id, 88))}</span>
                ${hostBadgeHtml(s.host)}
                <span class="badge">${s.messageCount ?? 0} 条</span>
                <span class="mini-time">${escapeHtml(fmtSmart(s.startedAt))}</span>
              </button>`).join('')}</div>`)
          : fromHtml('<div class="card hint">这次做梦没有记录输入会话（可能当天没有会话）。</div>'),
      }));
      inner.append(await memoryFilesSection(dream, ctx));

      detailCol.append(inner);
      inner.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-session]');
        if (btn) ctx.navigate(`#/sessions/${encodeURIComponent(btn.dataset.session)}`);
      });
    }

    async function memoryFilesSection(dream, ctx) {
      const box = h('div', {});
      try {
        const tree = await apiGet(API.memoryTree, { dreamId: dream.id });
        const files = tree.files || [];
        const list = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:4px' });
        list.append(fromHtml(`<div class="hint mono">${escapeHtml(tree.root || dream.memoryDir || '')}</div>`));
        for (const f of files) {
          const row = h('button', { class: 'tree-row', type: 'button' });
          row.innerHTML =
            `${icon('fileText', 13)}<span class="tree-label mono">${escapeHtml(f.path)}</span>` +
            (f.kind ? `<span class="badge">${escapeHtml(f.kind)}</span>` : '') +
            `<span class="badge">${escapeHtml(String(f.bytes ?? 0))} B</span>`;
          row.addEventListener('click', () => ctx.navigate(`#/memory?dreamId=${encodeURIComponent(dream.id)}&path=${encodeURIComponent(f.path)}`));
          list.append(row);
        }
        if (!files.length) list.append(fromHtml('<div class="hint">记忆库里还没有文件。</div>'));
        box.append(sectionEl('记忆文件', { note: `${files.length} 个`, body: list }));
      } catch (err) {
        box.append(sectionEl('记忆文件', {
          body: fromHtml(`<div class="card hint">记忆库接口暂不可用：${escapeHtml(describeError(err, '记忆库').desc)}</div>`),
        }));
      }
      return box;
    }

    // ---------- 轮询（POST 是同步的，轮询让列表与状态卡保持实时） ----------
    function startPolling() {
      stopPolling();
      pollTimer = setInterval(async () => {
        try {
          const res = await apiGet(API.dreams);
          dreams = res.dreams || [];
          renderList();
        } catch { /* 轮询失败静默，等 POST 结果 */ }
      }, 2000);
    }
    function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    async function load() {
      try {
        const res = await apiGet(API.dreams);
        dreams = res.dreams || [];
      } catch (err) {
        clear(listCol);
        listCol.append(errorBlock(err, '做梦记录', load));
        return;
      }
      if (!selectedId && dreams.length) selectedId = dreams[0].id;
      renderList();
      await renderDetail();
    }

    const offDream = ctx.onEvent('dream:done', () => load());
    await load();

    return {
      refresh: load,
      destroy() { disposed = true; stopPolling(); offDream?.(); },
    };
  },
};

/** 记忆文件的相对链接 → 应用内路由 */
export function resolveMemoryHref(href, dream, ctx) {
  if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
  const clean = href.split('#')[0];
  if (!clean) return null;
  const dreamId = dream?.id ? `dreamId=${encodeURIComponent(dream.id)}&` : '';
  return `#/memory?${dreamId}path=${encodeURIComponent(clean)}`;
}
