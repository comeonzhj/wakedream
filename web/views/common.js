// 视图之间共用的展示件（agent 色点+文字、@host 徽章、会话行、区块、统计卡）。
// 约定：色点永远与文字同现，不靠纯色区分状态（Wake 的可达性约定）。
import { icon } from '../assets/icons.js';
import { h, fromHtml, stateBlock } from '../assets/ui.js';
import {
  agentMeta, hostBadge, fmtSmart, fmtNum, fmtTokens, fmtTime, escapeHtml, truncate,
} from '../assets/format.js';

export function agentDot(agent, size = 8) {
  const meta = agentMeta(agent);
  return `<span class="dot ${size > 8 ? 'dot--lg' : ''}" style="--agent-color:${meta.color}"></span>`;
}

export function agentTagHtml(agent, { label = null } = {}) {
  const meta = agentMeta(agent);
  return `<span class="agent-tag" style="--agent-color:${meta.color}">${agentDot(agent)}<span class="agent-name">${escapeHtml(label || meta.name)}</span></span>`;
}

export function hostBadgeHtml(host) {
  const b = hostBadge(host);
  return b ? `<span class="badge badge--host">${escapeHtml(b)}</span>` : '';
}

export function statCardEl(value, label) {
  return fromHtml(`<div class="stat"><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-label">${escapeHtml(label)}</div></div>`);
}

export function statsBar(totals, { day } = {}) {
  const box = h('div', { class: 'stat-bar' });
  box.append(
    statCardEl(fmtNum(totals?.sessions ?? 0), '会话'),
    statCardEl(fmtNum(totals?.messages ?? 0), '消息'),
    statCardEl(fmtNum(totals?.agents ?? 0), 'Agent'),
    statCardEl(fmtNum(totals?.projects ?? 0), '项目'),
    statCardEl(fmtTokens(totals?.tokens), day ? 'Token（当日）' : 'Token'),
  );
  return box;
}

export function sectionEl(title, { note = '', actions = [], body } = {}) {
  const head = h('div', { class: 'section-head' }, h('h3', { text: title }));
  if (note) head.append(h('span', { class: 'section-note', text: note }));
  head.append(h('span', { class: 'spacer' }));
  for (const a of actions) head.append(a);
  const section = h('section', { class: 'section' }, head);
  if (body) section.append(body);
  return section;
}

export function actionButton(label, { iconName = null, primary = false, small = false, title = '', onClick } = {}) {
  const btn = h('button', { class: `btn ${primary ? 'btn--primary' : ''} ${small ? 'btn--sm' : ''}`, type: 'button', title: title || label });
  btn.innerHTML = `${iconName ? icon(iconName, small ? 12 : 14) : ''}<span>${escapeHtml(label)}</span>`;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

export function iconButton(iconName, { title = '', onClick, active = false } = {}) {
  const btn = h('button', { class: `icon-btn ${active ? 'is-active' : ''}`, type: 'button', title, 'aria-label': title });
  btn.innerHTML = icon(iconName, 15);
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

/** 会话行（中栏列表 + 今日页共用） */
export function sessionRowEl(session, { active = false, onClick, showPreview = true } = {}) {
  const meta = agentMeta(session.agent);
  const row = h('button', { class: `row ${active ? 'is-active' : ''}`, type: 'button', 'data-session-id': session.id });
  const title = h('span', { class: 'row-title', text: session.title || '(无标题会话)', title: session.title || '' });
  row.append(title);
  const metaRow = h('span', { class: 'row-meta' });
  metaRow.innerHTML =
    `${agentDot(session.agent)}<span>${escapeHtml(meta.name)}</span>` +
    `<span class="badge">${escapeHtml(session.project || 'Unknown')}</span>` +
    hostBadgeHtml(session.host) +
    `<span class="spacer"></span>` +
    `<span class="row-time" title="${escapeHtml(session.startedAt ? new Date(session.startedAt).toLocaleString('zh-CN') : '')}">${escapeHtml(fmtSmart(session.endedAt || session.startedAt))}</span>`;
  row.append(metaRow);
  if (showPreview && session.preview) {
    row.append(h('span', { class: 'row-preview', text: truncate(session.preview, 140) }));
  }
  if (onClick) row.addEventListener('click', () => onClick(session));
  return row;
}

/** 标题 + 说明的信息区（今日页/设备页共用） */
export function listEmpty({ glyph = 'info', title, desc, action }) {
  return stateBlock({ glyph, title, desc, actions: action ? [action] : [] });
}

export function sessionMetaChips(session, { home = '~' } = {}) {
  const chips = [];
  chips.push(agentTagHtml(session.agent));
  if (session.project) chips.push(`<span class="badge">${escapeHtml(session.project)}</span>`);
  const hb = hostBadgeHtml(session.host);
  if (hb) chips.push(hb);
  if (session.model) chips.push(`<span class="badge badge--outline">${escapeHtml(session.model)}</span>`);
  if (session.isSubagent) chips.push('<span class="badge">子会话</span>');
  return chips.join('');
}

export { fmtTime, escapeHtml };
