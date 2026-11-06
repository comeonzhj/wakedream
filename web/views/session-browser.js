// 会话浏览器的公共骨架：筛选栏（左）+ 会话列表（中）+ 阅读区插槽（右）。
// #/sessions 与 #/sessions/:id 共用同一套筛选与分页，切进转录时列表不会丢状态。
import { API } from '../assets/contract.js';
import { apiGet, describeError } from '../assets/api.js';
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, errorBlock, loadingBlock, emptyBlock } from '../assets/ui.js';
import {
  agentDot, hostBadgeHtml, sessionRowEl, actionButton,
} from './common.js';
import {
  today as todayDay, shiftDay, fmtNum, escapeHtml, fmtDayCN, agentName, agentMeta,
} from '../assets/format.js';

const PAGE_SIZE = 50;

export function createBrowser({ ctx, host, activeId = null, readerBuilder = null }) {
  const q0 = ctx.route.query || {};
  const filters = {
    day: q0.day || '',
    agent: q0.agent || '',
    host: q0.host || '',
    project: q0.project || '',
    q: q0.q || '',
    page: Math.max(1, Number(q0.page) || 1),
    group: q0.group || 'agent',
  };

  const rail = h('div', { class: 'col col--rail' });
  const listCol = h('div', { class: 'col col--list' });
  const readerCol = h('div', { class: 'col col--reader scroll' });
  const cols = h('div', { class: 'cols cols--3' }, rail, listCol, readerCol);
  host.append(cols);

  let facets = { agents: [], projects: [], hosts: [] };
  let state = { loading: true, error: null, total: 0, sessions: [] };
  let searchTimer = null;
  let disposed = false;

  // ---------- 筛选栏 ----------
  function renderRail() {
    clear(rail);
    const head = h('div', { class: 'col-head' }, h('h2', { text: '筛选' }));
    head.append(h('span', { class: 'spacer' }));
    head.append(actionButton('清空', {
      small: true,
      onClick: () => {
        Object.assign(filters, { day: '', agent: '', host: '', project: '', q: '', page: 1 });
        syncQuery();
        renderRail();
        load();
      },
    }));
    rail.append(head);

    const body = h('div', { class: 'scroll', style: 'padding:12px;display:flex;flex-direction:column;gap:14px' });

    // 搜索
    const searchField = h('div', { class: 'field' });
    searchField.innerHTML = `<span class="field-icon">${icon('search', 14)}</span>`;
    const input = h('input', {
      type: 'search', placeholder: '搜索会话（q）', value: filters.q,
      'aria-label': '搜索会话', id: 'session-q',
    });
    input.addEventListener('input', () => {
      filters.q = input.value;
      filters.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { syncQuery(); load(); }, 280);
    });
    searchField.append(input);
    body.append(searchField);

    // 日期
    body.append(filterGroup('日期', dateSegment()));
    // Agent
    body.append(filterGroup('Agent', optionSelect('agent', [
      { value: '', label: `全部（${facets.agents.length}）` },
      ...facets.agents.map((a) => ({ value: a.id, label: `${a.name || agentName(a.id)}（${a.count}）` })),
    ], filters.agent, () => { filters.page = 1; syncQuery(); load(); })));
    // 设备
    body.append(filterGroup('设备', optionSelect('host', [
      { value: '', label: `全部（${facets.hosts.length}）` },
      ...facets.hosts.map((x) => ({ value: x.id, label: `${x.name || x.id}（${x.count}）` })),
    ], filters.host, () => { filters.page = 1; syncQuery(); load(); })));
    // 项目
    body.append(filterGroup('项目', optionSelect('project', [
      { value: '', label: `全部（${facets.projects.length}）` },
      ...facets.projects.map((x) => ({ value: x.id, label: `${x.name || x.id}（${x.count}）` })),
    ], filters.project, () => { filters.page = 1; syncQuery(); load(); })));

    body.append(fromHtml(
      `<div class="hint">筛选条件写在地址栏（#/sessions?agent=…），可直接分享或收藏。</div>`,
    ));
    rail.append(body);

    if (ctx.route.query?.focus === 'q') setTimeout(() => input.focus(), 0);
  }

  function dateSegment() {
    const seg = h('div', { class: 'seg' });
    const presets = [
      { key: '', label: '全部' },
      { key: todayDay(), label: '今天' },
      { key: shiftDay(todayDay(), -1), label: '昨天' },
      { key: 'last7', label: '近 7 天' },
    ];
    for (const p of presets) {
      const active = (p.key === '' && !filters.day) || (p.key !== 'last7' && filters.day === p.key) ||
        (p.key === 'last7' && filters.day === todayDay() && filters._range === 7);
      const btn = h('button', { type: 'button', class: active ? 'is-active' : '', text: p.label });
      btn.addEventListener('click', () => {
        if (p.key === 'last7') { filters.day = todayDay(); filters._range = 7; }
        else { filters.day = p.key; filters._range = null; }
        filters.page = 1;
        syncQuery();
        renderRail();
        load();
      });
      seg.append(btn);
    }
    const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, seg);
    const dayInput = h('input', {
      class: 'field', type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(filters.day) ? filters.day : '',
      style: 'height:30px;padding:0 8px', 'aria-label': '指定日期',
    });
    dayInput.addEventListener('change', () => {
      filters.day = dayInput.value;
      filters.page = 1;
      syncQuery();
      load();
    });
    wrap.append(dayInput);
    return wrap;
  }

  function filterGroup(label, node) {
    return h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
      h('div', { class: 'hint', text: label }), node);
  }

  function optionSelect(key, options, value, onChange) {
    const field = h('div', { class: 'field field--select' });
    const select = h('select', { 'aria-label': key });
    for (const o of options) {
      const opt = h('option', { value: o.value, text: o.label });
      if (o.value === value) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => { filters[key] = select.value; onChange(); });
    field.append(select, fromHtml(`<span class="field-icon">${icon('chevronDown', 13)}</span>`));
    return field;
  }

  function syncQuery() {
    const params = new URLSearchParams();
    if (filters.day) params.set('day', filters.day);
    if (filters.agent) params.set('agent', filters.agent);
    if (filters.host) params.set('host', filters.host);
    if (filters.project) params.set('project', filters.project);
    if (filters.q) params.set('q', filters.q);
    if (filters.page > 1) params.set('page', String(filters.page));
    if (filters.group !== 'agent') params.set('group', filters.group);
    const qs = params.toString();
    const base = activeId ? `#/sessions/${encodeURIComponent(activeId)}` : '#/sessions';
    const next = qs ? `${base}?${qs}` : base;
    history.replaceState(null, '', next);
  }

  // ---------- 列表 ----------
  function renderList() {
    clear(listCol);
    const head = h('div', { class: 'col-head' });
    head.append(h('h2', { text: '全部会话' }));
    head.append(h('span', { class: 'col-sub', text: state.loading ? '载入中…' : `${fmtNum(state.total)} 个` }));
    head.append(h('span', { class: 'spacer' }));
    const groupBtn = actionButton(filters.group === 'agent' ? '按 Agent 分组' : '按时间平铺', {
      small: true,
      iconName: filters.group === 'agent' ? 'layers' : 'history',
      onClick: () => {
        filters.group = filters.group === 'agent' ? 'time' : 'agent';
        syncQuery();
        renderList();
      },
    });
    head.append(groupBtn);
    listCol.append(head);

    const body = h('div', { class: 'col-body scroll' });
    listCol.append(body);

    if (state.loading) { body.append(loadingBlock('载入会话…')); return; }
    if (state.error) { body.append(errorBlock(state.error, '会话列表', load)); return; }
    if (!state.sessions.length) {
      body.append(emptyBlock({
        glyph: 'search',
        title: '没有匹配的会话',
        desc: filters.q || filters.agent || filters.host || filters.project || filters.day
          ? '换一个条件，或清空筛选看看全部会话。'
          : '本机会话还没入库：先点顶栏的「扫描本机会话」。',
      }));
      return;
    }

    if (filters.group === 'agent') {
      body.append(...groupedRows(state.sessions));
    } else {
      body.append(...timeRows(state.sessions));
    }

    // 分页
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const foot = h('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--line);position:sticky;bottom:0;background:var(--list)',
    });
    const prev = actionButton('上一页', { small: true, onClick: () => { if (filters.page > 1) { filters.page -= 1; syncQuery(); load({ keepScroll: true }); } } });
    const next = actionButton('下一页', { small: true, onClick: () => { if (filters.page < pages) { filters.page += 1; syncQuery(); load({ keepScroll: true }); } } });
    prev.disabled = filters.page <= 1;
    next.disabled = filters.page >= pages;
    foot.append(
      prev, next,
      h('span', { class: 'hint', text: `第 ${filters.page} / ${pages} 页 · 每页 ${PAGE_SIZE}` }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: 'hint', text: `本页 ${state.sessions.length} 条` }),
    );
    body.append(foot);
  }

  function groupedRows(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const key = s.agent || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const out = [];
    for (const [agent, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const head = h('div', { class: 'group-head' });
      head.innerHTML =
        `${agentDot(agent, 9)}<span>${escapeHtml(agentName(agent))}</span>` +
        `<span class="spacer" style="flex:1"></span><span class="group-count">${list.length}</span>`;
      out.push(head);
      const projects = new Map();
      for (const s of list) {
        const p = s.project || 'Unknown';
        if (!projects.has(p)) projects.set(p, []);
        projects.get(p).push(s);
      }
      for (const [project, plist] of [...projects.entries()].sort((a, b) => b[1].length - a[1].length)) {
        out.push(fromHtml(`<div class="group-sub-head">${icon('folder', 12)}<span>${escapeHtml(project)}</span><span>${plist.length}</span></div>`));
        for (const s of plist) out.push(sessionRowEl(s, { active: s.id === activeId, onClick: onSelect }));
      }
    }
    return out;
  }

  function timeRows(sessions) {
    const out = [];
    let lastLabel = null;
    for (const s of sessions) {
      const label = dayLabel(s.startedAt);
      if (label !== lastLabel) {
        lastLabel = label;
        out.push(fromHtml(`<div class="group-head"><span>${escapeHtml(label)}</span><span class="spacer" style="flex:1"></span></div>`));
      }
      out.push(sessionRowEl(s, { active: s.id === activeId, onClick: onSelect }));
    }
    return out;
  }

  function dayLabel(ts) {
    if (!ts) return '未知时间';
    const d = new Date(ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (day === todayDay()) return '今天';
    if (day === shiftDay(todayDay(), -1)) return '昨天';
    return fmtDayCN(day);
  }

  function onSelect(s) {
    ctx.navigate(`#/sessions/${encodeURIComponent(s.id)}${querySuffix()}`);
  }
  function querySuffix() {
    const params = new URLSearchParams();
    if (filters.day) params.set('day', filters.day);
    if (filters.agent) params.set('agent', filters.agent);
    if (filters.host) params.set('host', filters.host);
    if (filters.project) params.set('project', filters.project);
    if (filters.q) params.set('q', filters.q);
    if (filters.page > 1) params.set('page', String(filters.page));
    if (filters.group !== 'agent') params.set('group', filters.group);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  // ---------- 数据 ----------
  async function load({ keepScroll = false } = {}) {
    state.loading = true;
    if (!keepScroll) renderList();
    else { const b = listCol.querySelector('.col-body'); if (b) { clear(b); b.append(loadingBlock('载入会话…')); } }
    const scrollTop = keepScroll ? listCol.querySelector('.col-body')?.scrollTop : 0;

    const params = {
      limit: PAGE_SIZE,
      offset: (filters.page - 1) * PAGE_SIZE,
      order: 'desc',
      withPreview: 1,
    };
    if (filters.day) {
      if (filters._range === 7) {
        params.to = Date.now();
        params.from = Date.now() - 7 * 86_400_000;
      } else {
        params.day = filters.day;
      }
    }
    if (filters.agent) params.agent = filters.agent;
    if (filters.host) params.host = filters.host;
    if (filters.project) params.project = filters.project;
    if (filters.q) params.q = filters.q;

    try {
      const res = await apiGet(API.sessions, params);
      if (disposed) return;
      state = { loading: false, error: null, total: res.total ?? (res.sessions || []).length, sessions: res.sessions || [] };
      const f = res.facets || {};
      facets = {
        agents: toFacetList(f.agents),
        projects: toFacetList(f.projects),
        hosts: toFacetList(f.hosts),
      };
    } catch (err) {
      if (disposed) return;
      state = { loading: false, error: err, total: 0, sessions: [] };
    }
    renderRail();
    renderList();
    if (keepScroll) {
      const b = listCol.querySelector('.col-body');
      if (b) b.scrollTop = scrollTop;
    }
    if (readerBuilder) { clear(readerCol); readerBuilder(readerCol, { sessions: state.sessions }); }
  }

  renderRail();
  renderList();
  if (readerBuilder) { clear(readerCol); readerBuilder(readerCol, { sessions: [] }); }
  load();

  return {
    reload: load,
    filters,
    getSessions: () => state.sessions,
    setReader(node) {
      clear(readerCol);
      readerCol.append(node);
    },
    destroy() { disposed = true; clearTimeout(searchTimer); },
  };
}

function toFacetList(list) {
  return (list || []).map((x) => (typeof x === 'string' ? { id: x, name: x, count: 0 } : x));
}

export { PAGE_SIZE };
