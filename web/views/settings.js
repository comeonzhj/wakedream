// #/settings 设置：扫描目录（scan.extraRoots）/ 做梦计划（/api/dream/schedule）/ 外观（主题·字号）。
import { API } from '../assets/contract.js';
import { apiGet, apiPut, describeError } from '../assets/api.js';
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, errorBlock, loadingBlock, toast, prefs } from '../assets/ui.js';
import { escapeHtml, fmtDateTime, fmtSmart, fmtNum, agentName, homeShort } from '../assets/format.js';
import { actionButton, sectionEl, agentDot } from './common.js';
import { setThemeMode, currentThemeMode, applyZoom } from '../app.js';

/** /api/dream/schedule 的 lastRun/nextRun 可能是 epoch ms、ISO 串，或 { at, day, status } 对象 */
export function asTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') return asTime(v.at ?? v.finishedAt ?? v.startedAt ?? null);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

const PROVIDERS = [
  ['heuristic', 'heuristic（本地规则，无需 API key）'],
  ['anthropic', 'anthropic'],
  ['openai-compatible', 'openai-compatible（DeepSeek / 自建网关）'],
];

export default {
  async render(host, ctx) {
    ctx.setTopbar({ title: '设置', sub: '扫描目录 · 做梦计划 · 外观', note: '' });

    const page = h('div', { class: 'page' });
    const scroll = h('div', { class: 'page-scroll scroll' });
    const inner = h('div', { class: 'page-inner', style: 'max-width:860px' });
    scroll.append(inner);
    page.append(scroll);
    host.append(page);

    let disposed = false;
    let settings = null;
    let schedule = null;
    let agents = [];
    let settingsError = null;
    let scheduleError = null;

    async function load() {
      clear(inner);
      inner.append(loadingBlock('读取配置…'));
      const [settingsR, scheduleR, agentsR] = await Promise.allSettled([
        apiGet(API.settings), apiGet(API.dreamSchedule), apiGet(API.agents),
      ]);
      if (disposed) return;
      settings = settingsR.status === 'fulfilled' ? (settingsR.value.settings || settingsR.value) : null;
      settingsError = settingsR.status === 'rejected' ? settingsR.reason : null;
      schedule = scheduleR.status === 'fulfilled' ? (scheduleR.value.schedule || scheduleR.value) : null;
      scheduleError = scheduleR.status === 'rejected' ? scheduleR.reason : null;
      agents = agentsR.status === 'fulfilled' ? (agentsR.value.agents || []) : [];
      render();
    }

    function render() {
      clear(inner);
      inner.append(scanSection());
      inner.append(dreamSection());
      inner.append(appearanceSection());
      inner.append(infoSection());
    }

    // ---------- 扫描目录 ----------
    function scanSection() {
      const box = h('div', { class: 'form-panel' });
      if (settingsError) return sectionEl('扫描目录', { body: errorBlock(settingsError, '配置', load) });

      const roots = settings?.scan?.extraRoots || [];
      box.append(fromHtml(
        `<div class="hint">本机各 Agent 的默认目录会被自动扫描；这里补的是额外目录（例如别处的项目导出）。改完立刻写入 config.json。</div>`,
      ));
      const chips = h('div', { class: 'chips' });
      if (!roots.length) chips.append(fromHtml('<span class="hint">还没有额外目录。</span>'));
      roots.forEach((r, i) => {
        const chip = fromHtml(
          `<span class="chip">${agentDot(r.agent)}<span>${escapeHtml(agentName(r.agent) || '未知 Agent')}</span>` +
          `<span class="mono" title="${escapeHtml(r.dir || '')}">${escapeHtml(homeShort(r.dir || ''))}</span></span>`,
        );
        const x = h('button', { class: 'chip-x', type: 'button', title: '移除' });
        x.innerHTML = icon('x', 12);
        x.addEventListener('click', async () => {
          const next = roots.filter((_, idx) => idx !== i);
          await saveScanRoots(next);
        });
        chip.append(x);
        chips.append(chip);
      });
      box.append(chips);

      // 新增
      const grid = h('div', { class: 'form-grid' });
      const agentSel = h('select', { class: 'field', style: 'height:32px;padding:0 8px', 'aria-label': 'Agent' });
      agentSel.append(h('option', { value: '', text: '选择 Agent' }));
      for (const a of agents) agentSel.append(h('option', { value: a.id, text: a.name || a.id }));
      if (!agents.length) {
        for (const id of ['claude-code', 'codex', 'dsh']) agentSel.append(h('option', { value: id, text: agentName(id) }));
      }
      const dirField = h('div', { class: 'field' });
      dirField.innerHTML = `<span class="field-icon">${icon('folder', 13)}</span>`;
      const dirInput = h('input', { placeholder: '~/work/notes/agent-sessions', 'aria-label': '目录' });
      dirField.append(dirInput);
      grid.append(
        h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: 'Agent' }), agentSel),
        h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: '目录' }), dirField),
      );
      box.append(grid);
      const bar = h('div', { class: 'form-actions' });
      bar.append(actionButton('添加目录', {
        iconName: 'plus', primary: true,
        onClick: async () => {
          const dir = dirInput.value.trim();
          if (!dir) { toast({ title: '请填目录', tone: 'bad' }); return; }
          const next = [...roots, { id: `r${Date.now().toString(36)}`, agent: agentSel.value || 'claude-code', dir }];
          await saveScanRoots(next);
          dirInput.value = '';
        },
      }));
      box.append(bar);
      return sectionEl('扫描目录', { note: 'GET/PUT /api/settings · scan.extraRoots', body: box });
    }

    async function saveScanRoots(next) {
      try {
        const res = await apiPut(API.settings, { scan: { extraRoots: next } });
        settings = res.settings || settings;
        toast({ title: '已保存扫描目录', body: `${next.length} 个额外目录`, tone: 'ok' });
        render();
      } catch (err) {
        toast({ title: '保存失败', body: describeError(err, '扫描目录').desc, tone: 'bad' });
      }
    }

    // ---------- 做梦计划 ----------
    function dreamSection() {
      const box = h('div', { class: 'form-panel' });
      if (scheduleError) return sectionEl('做梦计划', { body: errorBlock(scheduleError, '做梦计划', load) });
      if (!schedule) return sectionEl('做梦计划', { body: fromHtml('<div class="hint">还没有读到计划配置。</div>') });

      const local = { ...schedule };

      const enabledRow = h('div', { class: 'setting-row' });
      enabledRow.append(fromHtml(
        `<div class="setting-main"><div class="setting-title">夜间自动做梦</div>
         <div class="setting-desc">到点由常驻进程触发；失败只记日志，不影响下一次。</div></div>`,
      ));
      const sw = h('button', { class: `switch ${local.enabled ? 'is-on' : ''}`, type: 'button', 'aria-label': '夜间自动做梦' });
      sw.addEventListener('click', async () => {
        local.enabled = !local.enabled;
        sw.classList.toggle('is-on', local.enabled);
        await saveSchedule({ enabled: local.enabled });
      });
      enabledRow.append(sw);
      box.append(enabledRow);

      const grid = h('div', { class: 'form-grid' });
      const atField = h('div', { class: 'field' });
      atField.innerHTML = `<span class="field-icon">${icon('clock', 13)}</span>`;
      const atInput = h('input', { type: 'time', value: local.at || '03:30', 'aria-label': '时间' });
      atField.append(atInput);

      const provField = h('div', { class: 'field field--select' });
      const provSel = h('select', { 'aria-label': '供应商' });
      for (const [v, label] of PROVIDERS) {
        const opt = h('option', { value: v, text: label });
        if ((local.provider || 'heuristic') === v) opt.selected = true;
        provSel.append(opt);
      }
      provField.append(provSel, fromHtml(`<span class="field-icon">${icon('chevronDown', 13)}</span>`));

      const modelField = h('div', { class: 'field' });
      modelField.innerHTML = `<span class="field-icon">${icon('cpu', 13)}</span>`;
      const modelInput = h('input', { placeholder: 'claude-sonnet-4-5 / deepseek-chat', value: local.model || '', 'aria-label': '模型' });
      modelField.append(modelInput);

      const winField = h('div', { class: 'field' });
      winField.innerHTML = `<span class="field-icon">${icon('history', 13)}</span>`;
      const winInput = h('input', { type: 'number', min: '1', max: '30', value: String(local.windowDays ?? 1), 'aria-label': '回溯天数' });
      winField.append(winInput);

      grid.append(
        h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: '几点做梦' }), atField),
        h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: '供应商 provider' }), provField),
        h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: '模型 model' }), modelField),
        h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: '回溯天数 windowDays' }), winField),
      );
      box.append(grid);

      const lastRun = asTime(local.lastRun);
      const nextRun = asTime(local.nextRun);
      const meta = h('div', { class: 'hint' });
      meta.innerHTML =
        `上次运行：<span title="${escapeHtml(lastRun ? fmtDateTime(lastRun) : '')}">${escapeHtml(lastRun ? fmtSmart(lastRun) : '从未')}</span>` +
        (typeof local.lastRun === 'object' && local.lastRun?.status ? `（${escapeHtml(local.lastRun.status)}）` : '') +
        ` · 下次运行：<span title="${escapeHtml(nextRun ? fmtDateTime(nextRun) : '')}">${escapeHtml(nextRun ? fmtSmart(nextRun) : '未排期')}</span>`;
      box.append(meta);

      const bar = h('div', { class: 'form-actions' });
      bar.append(
        actionButton('保存计划', {
          iconName: 'check', primary: true,
          onClick: () => saveSchedule({
            at: atInput.value,
            provider: provSel.value,
            model: modelInput.value.trim(),
            windowDays: Number(winInput.value) || 1,
          }),
        }),
        actionButton('立刻跑一次', { iconName: 'play', onClick: () => ctx.navigate('#/dreams') }),
      );
      box.append(bar);
      return sectionEl('做梦计划', { note: 'GET/PUT /api/dream/schedule', body: box });
    }

    async function saveSchedule(patch) {
      try {
        const res = await apiPut(API.dreamSchedule, patch);
        schedule = res.schedule || { ...schedule, ...patch };
        toast({ title: '已保存做梦计划', body: Object.keys(patch).join(' · '), tone: 'ok' });
        render();
      } catch (err) {
        toast({ title: '保存失败', body: describeError(err, '做梦计划').desc, tone: 'bad' });
      }
    }

    // ---------- 外观 ----------
    function appearanceSection() {
      const box = h('div', { class: 'form-panel' });
      const themeRow = h('div', { class: 'setting-row' });
      themeRow.append(fromHtml(
        `<div class="setting-main"><div class="setting-title">主题</div>
         <div class="setting-desc">跟随系统时用 prefers-color-scheme 自动切换；选择会记在浏览器 localStorage。</div></div>`,
      ));
      const seg = h('div', { class: 'seg' });
      const cur = currentThemeMode();
      for (const [v, label] of [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]) {
        const b = h('button', { type: 'button', class: cur === v ? 'is-active' : '', text: label });
        b.addEventListener('click', () => {
          setThemeMode(v);
          apiPut(API.settings, { ui: { theme: v } }).catch(() => { /* 后端没实现也不影响本地 */ });
          render();
        });
        seg.append(b);
      }
      themeRow.append(seg);
      box.append(themeRow);

      const zoomRow = h('div', { class: 'setting-row' });
      zoomRow.append(fromHtml(
        `<div class="setting-main"><div class="setting-title">界面字号</div>
         <div class="setting-desc">只影响本机浏览器显示，不改服务端数据。</div></div>`,
      ));
      const zseg = h('div', { class: 'seg' });
      const zoom = Number(prefs.read().zoom) || 1;
      for (const [v, label] of [[0.9, '小'], [1, '标准'], [1.1, '大'], [1.25, '更大']]) {
        const b = h('button', { type: 'button', class: zoom === v ? 'is-active' : '', text: label });
        b.addEventListener('click', () => { prefs.write({ zoom: v }); applyZoom(); render(); });
        zseg.append(b);
      }
      zoomRow.append(zseg);
      box.append(zoomRow);

      box.append(fromHtml(
        `<div class="hint">深浅两套都是自己写的中性色 + 暮紫强调色，不用系统默认蓝；状态永远「色点 + 文字」一起出现。</div>`,
      ));
      return sectionEl('外观', { note: '主题 · 字号', body: box });
    }

    // ---------- 运行信息 ----------
    function infoSection() {
      const box = h('div', { class: 'form-panel' });
      if (!settings) {
        box.append(fromHtml('<div class="hint">没有读到配置（后端可能还没起来）。</div>'));
      } else {
        const rows = [
          ['数据目录 HOME', settings._home],
          ['配置文件', settings._configPath],
          ['监听', settings.host && settings.port ? `${settings.host}:${settings.port}` : null],
          ['局域网', settings.lan ? `${settings.lan.enabled ? '已开启' : '未开启'} · deviceName ${settings.lan.deviceName || '-'}${settings.lan.bindAll ? ' · 监听 0.0.0.0' : ' · 只监听 127.0.0.1'}` : null],
          ['已配置供应商', Object.entries(settings.providers || {}).filter(([, p]) => p.hasApiKey).map(([k, p]) => `${k}${p.model ? `(${p.model})` : ''}`).join(' · ') || '无（会用 heuristic 本地规则）'],
        ];
        for (const [k, v] of rows) {
          if (!v) continue;
          box.append(fromHtml(
            `<div class="setting-row"><div class="setting-main"><div class="setting-title">${escapeHtml(k)}</div>
             <div class="setting-desc mono">${escapeHtml(String(v))}</div></div></div>`,
          ));
        }
        box.append(fromHtml(`<div class="hint">把 API key 写进 config.json 的 providers 里即可让做梦走模型：PUT /api/settings {providers:{anthropic:{apiKey:'…'}}}（界面不回显明文）。</div>`));
      }
      return sectionEl('运行信息', { note: `本机已入库 ${fmtNum(agents.reduce((a, x) => a + (x.sessionCount || 0), 0))} 个会话`, body: box });
    }

    await load();
    return { refresh: load, destroy() { disposed = true; } };
  },
};
