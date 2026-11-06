// #/today 今日：当天统计条 + 24 小时时间线（按 agent/设备分布）+ 做梦状态卡 + 当天会话列表（按 agent 分组）。
import { API } from '../assets/contract.js';
import { apiGet, describeError } from '../assets/api.js';
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, errorBlock, loadingBlock, toast } from '../assets/ui.js';
import {
  agentMeta, agentName, today as todayDay, fmtDayCN, weekdayCN, fmtNum, fmtTime, fmtSmart,
  fmtDuration, fmtTokens, escapeHtml, dreamStatus, hostBadge, truncate,
} from '../assets/format.js';
import {
  agentDot, hostBadgeHtml, statCardEl, sectionEl, actionButton, sessionRowEl,
} from './common.js';
import { runScan, runDream } from '../app.js';

const DAY_MS = 86_400_000;

function dayBounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  return { start, end: start + DAY_MS - 1 };
}

export default {
  async render(host, ctx) {
    const day = ctx.route.query.day || todayDay();
    ctx.setTopbar({
      title: '今日',
      sub: `${fmtDayCN(day)} ${weekdayCN(day)}`,
      note: day === todayDay() ? '' : `正在查看 ${day}（非今天）`,
    });

    const page = h('div', { class: 'page' });
    const scroll = h('div', { class: 'page-scroll scroll' });
    const inner = h('div', { class: 'page-inner' });
    scroll.append(inner);
    page.append(scroll);
    host.append(page);

    let disposed = false;
    const cleanup = [];

    async function load() {
      clear(inner);
      inner.append(loadingBlock('正在读取当天会话…'));
      const [statsR, sessionsR, dreamsR] = await Promise.allSettled([
        apiGet(API.stats, { day }),
        apiGet(API.sessions, { day, limit: 300, withPreview: 1, order: 'desc' }),
        apiGet(API.dreams),
      ]);
      if (disposed) return;
      clear(inner);

      const stats = statsR.status === 'fulfilled' ? statsR.value : null;
      const sessions = sessionsR.status === 'fulfilled' ? (sessionsR.value.sessions || []) : [];
      const dreams = dreamsR.status === 'fulfilled' ? (dreamsR.value.dreams || []) : null;

      // 1. 统计条
      const statBar = h('div', { class: 'stat-bar' });
      const totals = stats?.totals || {
        sessions: sessionsR.status === 'fulfilled' ? (sessionsR.value.total ?? sessions.length) : null,
        messages: sessions.reduce((a, s) => a + (s.messageCount || 0), 0),
        agents: new Set(sessions.map((s) => s.agent)).size,
        projects: new Set(sessions.map((s) => s.project)).size,
        tokens: sessions.reduce((a, s) => a + (s.tokens || 0), 0),
      };
      statBar.append(
        statCardEl(fmtNum(totals?.sessions), '会话'),
        statCardEl(fmtNum(totals?.messages), '消息'),
        statCardEl(fmtNum(totals?.agents), 'Agent'),
        statCardEl(fmtNum(totals?.projects), '项目'),
        statCardEl(fmtTokens(totals?.tokens), 'Token'),
      );
      inner.append(statBar);
      if (statsR.status !== 'fulfilled') {
        inner.append(h('div', { class: 'section-note', text: `统计接口暂不可用（${describeError(statsR.reason, '统计').title}），下面数字由会话列表推算。` }));
      }

      // 2. 时间线
      inner.append(timelineSection({ day, sessions, stats, onOpen: (s) => openSession(s) }));

      // 3. 做梦状态卡
      inner.append(dreamSection({ day, dream: pickDream(dreams, day), ctx }));

      // 4. 当天会话列表
      const body = h('div', { class: 'list-block' });
      if (sessionsR.status !== 'fulfilled') {
        body.append(errorBlock(sessionsR.reason, '当天会话', load));
      } else if (!sessions.length) {
        const btn = actionButton('扫描本机会话', { iconName: 'scan', primary: true, onClick: () => runScan({}) });
        body.append(fromHtml(
          `<div class="state state--compact">
            <div class="state-icon">${icon('sunrise', 22)}</div>
            <div class="state-title">今天还没有会话</div>
            <div class="state-desc">先去扫描本机各 Agent 的数据目录；别的设备的会话可以在「设备」页同步过来。</div>
          </div>`,
        ).also((root) => root.append(h('div', { class: 'state-actions' }, btn))));
      } else {
        body.append(...groupByAgent(sessions, (s) => openSession(s)));
      }
      inner.append(sectionEl('当天会话', {
        note: sessionsR.status === 'fulfilled' ? `共 ${fmtNum(sessionsR.value.total ?? sessions.length)} 个会话 · 按 Agent 分组` : '',
        actions: sessions.length ? [actionButton('查看全部', { iconName: 'arrowRight', small: true, onClick: () => ctx.navigate('#/sessions?day=' + day) })] : [],
        body,
      }));
    }

    function openSession(s) {
      ctx.navigate(`#/sessions/${encodeURIComponent(s.id)}`);
    }

    const offScan = ctx.onEvent('scan:done', () => load());
    const offDream = ctx.onEvent('dream:done', () => load());
    cleanup.push(offScan, offDream);

    await load();

    return {
      refresh: load,
      destroy() {
        disposed = true;
        for (const off of cleanup) off?.();
      },
    };
  },
};

function pickDream(dreams, day) {
  if (!dreams) return null;
  const mine = dreams.filter((d) => d.day === day);
  if (!mine.length) return null;
  return mine.find((d) => d.status === 'running') || mine[0];
}

// ---------- 时间线 ----------
function timelineSection({ day, sessions, stats, onOpen }) {
  const { start, end } = dayBounds(day);
  const span = end - start + 1;
  const card = h('div', { class: 'timeline' });

  const pct = (ts) => Math.max(0, Math.min(100, ((ts - start) / span) * 100));

  // 顶部：全部会话按小时分布（来自 /api/stats byHour；没有就用会话推算）
  const byHour = stats?.byHour?.length
    ? stats.byHour
    : Array.from({ length: 24 }, (_, hour) => ({
        hour,
        sessions: sessions.filter((s) => new Date(s.startedAt || s.endedAt || start).getHours() === hour).length,
      }));
  const maxHour = Math.max(1, ...byHour.map((x) => x.sessions || 0));
  const hourRow = h('div', { class: 'tl-row' });
  hourRow.append(h('div', { class: 'tl-label', html: `${icon('activity', 13)}<span>按小时</span>` }));
  const hourTrack = h('div', { class: 'tl-track', style: 'height:46px' });
  hourTrack.style.display = 'grid';
  hourTrack.style.gridTemplateColumns = 'repeat(24, 1fr)';
  hourTrack.style.gap = '3px';
  hourTrack.style.alignItems = 'end';
  hourTrack.style.padding = '6px 4px';
  for (let hour = 0; hour < 24; hour += 1) {
    const rec = byHour.find((x) => Number(x.hour) === hour);
    const count = rec?.sessions ?? 0;
    const isPeak = count > 0 && count === maxHour;
    const col = h('div', {
      class: 'tl-bar',
      title: `${String(hour).padStart(2, '0')}:00 · ${count} 个会话${rec?.messages ? ` · ${rec.messages} 条消息` : ''}`,
      style: `height:${Math.max(count ? 6 : 2, Math.round((count / maxHour) * 100))}%;` +
        `background:${count ? 'var(--accent)' : 'var(--line-2)'};opacity:${count ? (isPeak ? 1 : 0.42) : 1}`,
    });
    hourTrack.append(col);
  }
  // 「现在」标记画在小时轨道里，不与坐标轴刻度打架
  if (day === todayDay()) {
    const nowLeft = pct(Date.now());
    hourTrack.append(h('div', { class: 'tl-now', style: `left:${nowLeft}%`, title: `现在 ${fmtTime(Date.now())}` }));
  }
  hourRow.append(hourTrack);
  card.append(hourRow);

  // 每个 agent 一条泳道
  const byAgent = new Map();
  for (const s of sessions) {
    const key = s.agent || 'unknown';
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(s);
  }
  const agents = [...byAgent.entries()].sort((a, b) => b[1].length - a[1].length);
  const shown = agents.slice(0, 7);
  const segsByAgent = [];
  for (const [agent, list] of shown) {
    const row = h('div', { class: 'tl-row' });
    row.append(h('div', {
      class: 'tl-label',
      html: `${agentDot(agent)}<span title="${escapeHtml(agentName(agent))}">${escapeHtml(agentName(agent))}</span><span class="tl-count">${list.length}</span>`,
    }));
    const track = h('div', { class: 'tl-track' });
    for (const s of list) {
      const sStart = s.startedAt || s.endedAt || start;
      const sEnd = Math.max(s.endedAt || sStart + 4 * 60_000, sStart + 60_000);
      const left = pct(Math.max(sStart, start));
      const width = Math.max(0.4, pct(Math.min(sEnd, end)) - left);
      const host = hostBadge(s.host);
      const segTitle = `${agentName(s.agent)} · ${s.project || 'Unknown'}${host ? ` · ${host}` : ''}\n${fmtTime(sStart)}–${fmtTime(sEnd)} · ${s.messageCount || 0} 条消息\n${s.title || ''}`;
      const seg = h('div', {
        class: 'tl-seg',
        title: segTitle,
        style: `left:${left}%;width:${width}%;background:${agentMeta(s.agent).color}`,
      });
      seg.addEventListener('click', () => onOpen(s));
      track.append(seg);
    }
    segsByAgent.push({ agent, list });
    row.append(track);
    card.append(row);
  }

  if (!agents.length) {
    card.append(h('div', { class: 'state-desc', text: '当天还没有可绘制的会话。' }));
  }
  if (agents.length > shown.length) {
    card.append(h('div', { class: 'tl-legend', text: `另有 ${agents.length - shown.length} 个 Agent 的会话未在此展开。` }));
  }

  // 小时刻度
  const axis = h('div', { class: 'tl-row tl-axis' });
  axis.append(h('div', {}));
  const ticks = h('div', { class: 'tl-hours', style: 'position:relative;height:16px' });
  for (let hour = 0; hour <= 21; hour += 3) {
    ticks.append(h('span', { text: `${String(hour).padStart(2, '0')}:00`, style: `left:${(hour / 24) * 100}%` }));
  }
  axis.append(ticks);
  card.append(axis);

  // 图例（色点 + 文字）
  const legend = h('div', { class: 'tl-legend' });
  for (const { agent, list } of segsByAgent) {
    const meta = agentMeta(agent);
    legend.append(fromHtml(
      `<span class="item">${agentDot(agent)}<span>${escapeHtml(meta.name)}</span><span style="color:var(--fg-faint)">${list.length}</span></span>`,
    ));
  }
  if (legsNotEmpty(legend)) card.append(legend);

  return sectionEl('当天时间线', { note: '按小时与 Agent 分布 · 悬停看会话详情，点击直达转录', body: card });
}

function legsNotEmpty(el) { return el.children.length > 0; }

// ---------- 做梦状态卡 ----------
function dreamSection({ day, dream, ctx }) {
  const card = h('div', { class: 'dream-card' });
  const status = dream ? dreamStatus(dream.status) : null;
  const running = status?.tone === 'busy';

  const glyph = h('div', { class: 'dream-glyph' });
  glyph.innerHTML = running ? '<div class="spinner"></div>' : icon('moon', 22);
  card.append(glyph);

  const main = h('div', { class: 'dream-main' });
  const title = h('div', { class: 'dream-title' });
  title.innerHTML = dream
    ? `<span>${escapeHtml(day)} 的梦</span><span class="badge ${status.tone === 'ok' ? 'badge--ok' : status.tone === 'bad' ? 'badge--bad' : 'badge--accent'}">${escapeHtml(status.label)}</span>`
    : `<span>今天还没有做梦</span><span class="badge">未运行</span>`;
  main.append(title);

  if (dream) {
    const dur = dream.startedAt && dream.finishedAt ? fmtDuration(dream.finishedAt - dream.startedAt) : null;
    const meta = h('div', { class: 'dream-meta' });
    const bits = [
      `${icon('brain', 12)}<span>${escapeHtml(String(dream.sessionCount ?? 0))} 个会话</span>`,
      `${icon('cpu', 12)}<span>${escapeHtml(dream.provider || 'heuristic')}${dream.model ? ` · ${escapeHtml(dream.model)}` : ''}</span>`,
    ];
    if (dur) bits.push(`${icon('clock', 12)}<span>耗时 ${escapeHtml(dur)}</span>`);
    if (dream.memoryDir) bits.push(`${icon('folder', 12)}<span class="mono">${escapeHtml(dream.memoryDir)}</span>`);
    meta.innerHTML = bits.map((b) => `<span class="item">${b}</span>`).join('');
    main.append(meta);
    if (dream.error) main.append(h('div', { class: 'dream-desc', style: 'color:var(--danger)', text: dream.error }));
    else if (running) main.append(h('div', { class: 'dream-desc', text: '正在把当天的会话萃取进记忆库，完成后这里会出现「查看记忆库」入口。' }));
  } else {
    main.append(h('div', {
      class: 'dream-desc',
      text: '夜里的自动做梦可以在「设置」里打开；也可以手动跑一次，把今天的会话萃取成 wiki 式记忆库。',
    }));
  }
  card.append(main);

  const actions = h('div', { class: 'dream-actions' });
  if (dream && !running) {
    actions.append(actionButton('查看记忆库', {
      iconName: 'brain',
      onClick: () => ctx.navigate(`#/memory?dreamId=${encodeURIComponent(dream.id)}`),
    }));
    actions.append(actionButton('重新做梦', {
      iconName: 'refresh',
      small: true,
      onClick: async () => { await runDream({ day, force: true }); ctx.reload(); },
    }));
  } else if (!running) {
    actions.append(actionButton('现在做梦', {
      iconName: 'play',
      primary: true,
      onClick: async () => {
        const res = await runDream({ day });
        if (res) ctx.reload();
        else toast({ title: '做梦未开始', body: '可以先用「扫描本机会话」确认当天已有数据。', tone: 'info' });
      },
    }));
  } else {
    actions.append(actionButton('查看进度', { iconName: 'activity', onClick: () => ctx.navigate('#/dreams') }));
  }
  card.append(actions);

  return sectionEl('做梦状态', { note: '夜间把当天会话萃取成记忆库', body: card });
}

// ---------- 按 agent → 项目 分组 ----------
export function groupByAgent(sessions, onOpen, { defaultOpen = true } = {}) {
  const groups = new Map();
  for (const s of sessions) {
    const key = s.agent || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const [agent, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const group = h('div', { class: 'agent-group' });
    const head = h('button', { class: 'agent-group-head', type: 'button' });
    const hostCount = new Set(list.map((s) => s.host || 'local')).size;
    head.innerHTML =
      `${icon('chevronDown', 14)}${agentDot(agent, 10)}<span>${escapeHtml(agentName(agent))}</span>` +
      `<span class="badge">${list.length} 个会话</span>` +
      (hostCount > 1 ? `<span class="badge badge--host">${hostCount} 台设备</span>` : '') +
      `<span class="spacer"></span>` +
      `<span class="badge">${[...new Set(list.map((s) => s.project))].length} 个项目</span>`;
    const body = h('div', { class: 'agent-group-body' });
    group.append(head, body);
    out.push(group);

    const projects = new Map();
    for (const s of list) {
      const p = s.project || 'Unknown';
      if (!projects.has(p)) projects.set(p, []);
      projects.get(p).push(s);
    }
    for (const [project, plist] of [...projects.entries()].sort((a, b) => b[1].length - a[1].length)) {
      body.append(fromHtml(
        `<div class="project-row">${icon('folder', 13)}<span>${escapeHtml(project)}</span><span style="color:var(--fg-faint)">${plist.length}</span></div>`,
      ));
      for (const s of plist) {
        const row = h('button', { class: 'mini-row', type: 'button' });
        const host = hostBadge(s.host);
        row.innerHTML =
          `<span class="mini-title" title="${escapeHtml(s.title || '')}">${escapeHtml(truncate(s.title || '(无标题会话)', 90))}</span>` +
          (host ? `<span class="badge badge--host">${escapeHtml(host)}</span>` : '') +
          `<span class="badge">${s.messageCount || 0} 条</span>` +
          `<span class="mini-time">${escapeHtml(fmtSmart(s.endedAt || s.startedAt))}</span>`;
        row.addEventListener('click', () => onOpen(s));
        body.append(row);
      }
    }

    let open = defaultOpen;
    const applyOpen = () => {
      body.hidden = !open;
      head.querySelector('svg').style.transform = open ? '' : 'rotate(-90deg)';
    };
    head.addEventListener('click', () => { open = !open; applyOpen(); });
    applyOpen();
  }
  return out;
}
