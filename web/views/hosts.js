// #/hosts 设备：Remote hosts 增删改 + SSH 同步 / 局域网拉取（作业进度轮询）+ 本机局域网卡片（配对信息）。
import { API } from '../assets/contract.js';
import { apiGet, apiPost, apiPatch, apiDelete, apiPut, describeError } from '../assets/api.js';
import { icon } from '../assets/icons.js';
import { h, clear, fromHtml, errorBlock, loadingBlock, emptyBlock, toast, confirmDialog, copyText } from '../assets/ui.js';
import { fmtDateTime, fmtSmart, fmtNum, escapeHtml, remoteStatus, today as todayDay } from '../assets/format.js';
import { actionButton, iconButton, sectionEl } from './common.js';

export default {
  async render(host, ctx) {
    ctx.setTopbar({ title: '设备', sub: 'SSH 与局域网内其他设备的会话同步', note: '' });

    const page = h('div', { class: 'page' });
    const scroll = h('div', { class: 'page-scroll scroll' });
    const inner = h('div', { class: 'page-inner' });
    scroll.append(inner);
    page.append(scroll);
    host.append(page);

    let disposed = false;
    const jobs = new Map();   // jobId -> job
    const pollers = new Map();
    let remotes = [];
    let lanInfo = null;
    let lanError = null;
    let showToken = false;
    let formOpen = false;

    async function load() {
      clear(inner);
      inner.append(loadingBlock('读取设备列表…'));
      const [remotesR, lanR] = await Promise.allSettled([apiGet(API.remotes), apiGet(API.lanInfo)]);
      if (disposed) return;
      clear(inner);

      if (remotesR.status === 'fulfilled') remotes = remotesR.value.remotes || [];
      else remotes = [];
      lanInfo = lanR.status === 'fulfilled' ? lanR.value : null;
      lanError = lanR.status === 'rejected' ? lanR.reason : null;

      inner.append(remoteSection());
      inner.append(lanSection());
      inner.append(jobsSection());
    }

    // ---------- 远端设备 ----------
    function remoteSection() {
      const box = h('div', { class: 'list-block' });
      const actions = [
        actionButton(formOpen ? '收起表单' : '新增设备', {
          iconName: formOpen ? 'chevronDown' : 'plus',
          small: true,
          onClick: () => { formOpen = !formOpen; rerender(); },
        }),
      ];
      const section = sectionEl('远端设备', {
        note: remotes.length ? `${remotes.length} 台 · @host 徽章标识来源` : '还没有配置远端设备',
        actions,
        body: box,
      });

      if (formOpen) box.append(remoteForm());

      if (!remotes.length) {
        box.append(fromHtml(
          `<div class="card hint">还没有远端设备。SSH 设备用 rsync 把会话镜像到本地缓存；局域网设备直接从对端拉当天会话。</div>`,
        ));
      }
      for (const r of remotes) box.append(remoteRow(r));
      return section;
    }

    function remoteForm() {
      const panel = h('div', { class: 'form-panel' });
      const state = { kind: 'ssh' };
      const kindRow = h('div', { class: 'setting-row' });
      kindRow.append(h('div', { class: 'setting-main' }, h('div', { class: 'setting-title', text: '类型' })));
      const seg = h('div', { class: 'seg' });
      for (const k of [['ssh', 'SSH'], ['lan', '局域网']]) {
        const b = h('button', { type: 'button', class: k[0] === 'ssh' ? 'is-active' : '', text: k[1] });
        b.addEventListener('click', () => {
          state.kind = k[0];
          for (const s of seg.children) s.classList.toggle('is-active', s === b);
          fields.replaceChildren(...buildFields());
        });
        seg.append(b);
      }
      kindRow.append(seg);
      panel.append(kindRow);

      const fields = h('div', { class: 'form-grid' });
      const values = {};
      function input(name, label, { placeholder = '', type = 'text', value = '' } = {}) {
        const wrap = h('label', { class: 'form-row' }, h('span', { class: 'form-label', text: label }));
        const field = h('div', { class: 'field' });
        const el = h('input', { type, placeholder, value, 'aria-label': label });
        el.addEventListener('input', () => { values[name] = el.value; });
        values[name] = value;
        field.append(el);
        wrap.append(field);
        return wrap;
      }
      function buildFields() {
        values.name = values.name || '';
        if (state.kind === 'ssh') {
          return [
            input('name', '名字', { placeholder: 'devbox' }),
            input('host', '主机', { placeholder: '192.168.1.20 或 devbox.local' }),
            input('user', '用户', { placeholder: 'corey' }),
            input('port', '端口', { placeholder: '22' }),
            input('root', '会话根目录', { placeholder: '~/.claude/projects' }),
          ];
        }
        return [
          input('name', '名字', { placeholder: 'mac-mini' }),
          input('url', '对端地址', { placeholder: 'http://192.168.1.30:4680' }),
          input('token', '配对 token', { placeholder: '从对端「设备」页复制' }),
        ];
      }
      fields.append(...buildFields());
      panel.append(fields);

      const bar = h('div', { class: 'form-actions' });
      bar.append(
        actionButton('保存', {
          iconName: 'check', primary: true,
          onClick: async () => {
            const body = { kind: state.kind, name: values.name?.trim() };
            if (!body.name) { toast({ title: '请填名字', tone: 'bad' }); return; }
            if (state.kind === 'ssh') {
              body.host = values.host?.trim();
              body.user = values.user?.trim() || undefined;
              body.port = values.port ? Number(values.port) : undefined;
              body.root = values.root?.trim() || undefined;
              if (!body.host) { toast({ title: '请填主机', tone: 'bad' }); return; }
            } else {
              body.url = values.url?.trim();
              body.token = values.token?.trim() || undefined;
              if (!body.url) { toast({ title: '请填对端地址', tone: 'bad' }); return; }
            }
            try {
              await apiPost(API.remotes, body);
              toast({ title: '设备已保存', body: body.name, tone: 'ok' });
              formOpen = false;
              await load();
            } catch (err) {
              toast({ title: '保存失败', body: describeError(err, '新增设备').desc, tone: 'bad' });
            }
          },
        }),
        actionButton('取消', { onClick: () => { formOpen = false; rerender(); } }),
      );
      panel.append(bar);
      return panel;
    }

    function remoteRow(r) {
      const st = remoteStatus(r.lastStatus);
      const row = h('div', { class: 'device-row' });
      const main = h('div', { class: 'device-main' });
      const target = r.kind === 'ssh'
        ? `${r.user ? `${r.user}@` : ''}${r.host || ''}${r.port ? `:${r.port}` : ''}`
        : (r.url || '');
      main.append(fromHtml(
        `<div class="device-name">
           ${icon(r.kind === 'ssh' ? 'terminal' : 'wifi', 15)}
           <span>${escapeHtml(r.name || r.id)}</span>
           <span class="badge ${r.kind === 'ssh' ? '' : 'badge--accent'}">${r.kind === 'ssh' ? 'SSH' : '局域网'}</span>
           <span class="badge ${st.tone === 'ok' ? 'badge--ok' : st.tone === 'bad' ? 'badge--bad' : st.tone === 'busy' ? 'badge--accent' : ''}">${escapeHtml(st.label)}</span>
           ${r.enabled ? '' : '<span class="badge">已停用</span>'}
         </div>
         <div class="device-sub">
           <span class="mono">${escapeHtml(target)}</span>
           ${r.root ? ` · <span class="mono">${escapeHtml(r.root)}</span>` : ''}
           · 最近同步 <span title="${escapeHtml(fmtDateTime(r.lastSync))}">${escapeHtml(r.lastSync ? fmtSmart(r.lastSync) : '从未')}</span>
         </div>`));
      if (r.lastError) main.append(fromHtml(`<div class="device-sub" style="color:var(--danger)">${escapeHtml(r.lastError)}</div>`));
      row.append(main);

      const actions = h('div', { class: 'device-actions' });

      const runLabel = r.kind === 'ssh' ? '同步' : '拉取';
      const runBtn = actionButton(runLabel, {
        small: true,
        iconName: r.kind === 'ssh' ? 'cloudDown' : 'cloudUp',
        onClick: async () => {
          runBtn.disabled = true;
          try {
            const res = r.kind === 'ssh'
              ? await apiPost(API.remoteSync(r.id), { day: todayDay() })
              : await apiPost(API.lanPull, { url: r.url, token: r.token || undefined, day: todayDay() });
            const jobId = res.jobId;
            if (!jobId) throw new Error('后端没有返回 jobId');
            toast({ title: `${runLabel}已开始`, body: `${r.name} · 作业 ${jobId}`, tone: 'info' });
            watchJob(jobId, r);
          } catch (err) {
            toast({ title: `${runLabel}失败`, body: describeError(err, runLabel).desc, tone: 'bad' });
          } finally {
            runBtn.disabled = false;
          }
        },
      });
      actions.append(runBtn);

      const sw = h('button', { class: `switch ${r.enabled ? 'is-on' : ''}`, type: 'button', title: r.enabled ? '停用' : '启用', 'aria-label': '启用/停用' });
      sw.addEventListener('click', async () => {
        try {
          await apiPatch(API.remote(r.id), { enabled: !r.enabled });
          await load();
        } catch (err) {
          toast({ title: '更新失败', body: describeError(err, '设备').desc, tone: 'bad' });
        }
      });
      actions.append(sw);

      actions.append(iconButton('trash', {
        title: '删除设备',
        onClick: async () => {
          const ok = await confirmDialog({
            title: `删除设备「${r.name}」？`,
            body: '会同时清掉这台设备已镜像到本地的会话缓存，不动远端文件。',
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await apiDelete(API.remote(r.id));
            toast({ title: '已删除', body: r.name, tone: 'ok' });
            await load();
          } catch (err) {
            toast({ title: '删除失败', body: describeError(err, '删除设备').desc, tone: 'bad' });
          }
        },
      }));
      row.append(actions);
      return row;
    }

    // ---------- 作业进度 ----------
    function watchJob(jobId, remote) {
      const tick = async () => {
        try {
          const res = await apiGet(API.syncJob(jobId));
          jobs.set(jobId, { ...(res.job || {}), remoteName: remote?.name });
          rerenderJobsOnly();
          const status = res.job?.status;
          if (status === 'ok' || status === 'failed') {
            clearInterval(pollers.get(jobId));
            pollers.delete(jobId);
            if (status === 'ok') {
              toast({ title: '同步完成', body: `${remote?.name || ''} · 拉取 ${res.job.pulled ?? 0} 个会话，新增 ${res.job.added ?? 0}`, tone: 'ok' });
              ctx.refreshShell?.();
            } else {
              toast({ title: '同步失败', body: res.job?.error || '见作业日志', tone: 'bad' });
            }
            await load();
          }
        } catch (err) {
          clearInterval(pollers.get(jobId));
          pollers.delete(jobId);
          jobs.set(jobId, { id: jobId, status: 'failed', error: describeError(err, '同步作业').desc, remoteName: remote?.name });
          rerenderJobsOnly();
        }
      };
      pollers.set(jobId, setInterval(tick, 1200));
      tick();
    }

    function jobsSection() {
      const box = h('div', { class: 'list-block', id: 'jobs-box' });
      const section = sectionEl('同步作业', { note: jobs.size ? `${jobs.size} 个` : '暂无进行中的作业', body: box });
      fillJobs(box);
      return section;
    }

    function rerenderJobsOnly() {
      const box = inner.querySelector('#jobs-box');
      if (box) fillJobs(box);
    }

    function fillJobs(box) {
      clear(box);
      if (!jobs.size) {
        box.append(fromHtml('<div class="card hint">还没有同步作业。点某台设备右侧的「同步」或「拉取」会在这里显示进度与日志。</div>'));
        return;
      }
      for (const job of jobs.values()) {
        const st = remoteStatus(job.status);
        const card = h('div', { class: 'form-panel' });
        const head = h('div', { class: 'setting-row' });
        head.append(fromHtml(
          `<div class="setting-main">
            <div class="setting-title">${escapeHtml(job.remoteName || job.remoteId || '作业')}
              <span class="badge ${st.tone === 'ok' ? 'badge--ok' : st.tone === 'bad' ? 'badge--bad' : 'badge--accent'}">${escapeHtml(st.label)}</span>
            </div>
            <div class="setting-desc mono">job ${escapeHtml(job.id || '')} · 拉取 ${job.pulled ?? 0} · 新增 ${job.added ?? 0}${job.finishedAt && job.startedAt ? ` · 耗时 ${Math.round((job.finishedAt - job.startedAt) / 100) / 10}s` : ''}</div>
          </div>`));
        card.append(head);
        const track = h('div', { class: 'progress-track' });
        const bar = h('div', { class: `progress-bar ${job.status === 'running' ? '' : 'is-determinate'}`, style: job.status === 'running' ? '' : 'width:100%' });
        track.append(bar);
        card.append(track);
        if (job.error) card.append(fromHtml(`<div class="hint" style="color:var(--danger)">${escapeHtml(job.error)}</div>`));
        if (job.log?.length) card.append(fromHtml(`<div class="log-panel">${escapeHtml(job.log.slice(-30).join('\n'))}</div>`));
        box.append(card);
      }
    }

    // ---------- 本机局域网 ----------
    function lanSection() {
      const box = h('div', { class: 'list-block' });
      const section = sectionEl('本机局域网', { note: '让同一局域网内的另一台设备拉取本机会话（只读）', body: box });

      if (lanError) {
        box.append(errorBlock(lanError, '局域网信息', load));
        return section;
      }
      if (!lanInfo) {
        box.append(emptyBlock({ glyph: 'wifi', title: '拿不到局域网信息', desc: '接口 /api/lan/info 没有返回数据。' }));
        return section;
      }

      const card = h('div', { class: 'form-panel' });
      const head = h('div', { class: 'setting-row' });
      head.append(fromHtml(
        `<div class="setting-main">
          <div class="setting-title">${escapeHtml(lanInfo.deviceName || '本机')} · 端口 ${escapeHtml(String(lanInfo.port ?? ''))}</div>
          <div class="setting-desc">本机已入库 ${fmtNum(lanInfo.sessionCount ?? 0)} 个会话 · 对端拉取时按当天筛选</div>
        </div>`));
      const sw = h('button', { class: `switch ${lanInfo.enabled ? 'is-on' : ''}`, type: 'button', 'aria-label': '启停局域网同步', title: lanInfo.enabled ? '关闭' : '开启' });
      sw.addEventListener('click', async () => {
        try {
          await apiPut(API.settings, { lan: { enabled: !lanInfo.enabled } });
          toast({ title: lanInfo.enabled ? '已关闭局域网同步' : '已开启局域网同步', tone: 'ok' });
          await load();
        } catch (err) {
          toast({ title: '切换失败', body: describeError(err, '局域网设置').desc, tone: 'bad' });
        }
      });
      head.append(h('span', { style: 'flex:1' }), sw);
      card.append(head);

      // bindAll 说明：默认只监听 127.0.0.1
      const bindRow = h('div', { class: 'setting-row' });
      bindRow.append(fromHtml(
        `<div class="setting-main">
          <div class="setting-title">允许局域网内其他设备访问</div>
          <div class="setting-desc">关闭时只监听 127.0.0.1（只有本机能连）；要让另一台设备拉取，必须打开这一项。</div>
        </div>`));
      const bindSw = h('button', {
        class: `switch ${lanInfo.bindAll ? 'is-on' : ''}`,
        type: 'button', 'aria-label': '允许局域网访问',
        title: '写入 PUT /api/settings {lan:{bindAll}}',
      });
      bindSw.addEventListener('click', async () => {
        try {
          await apiPut(API.settings, { lan: { bindAll: !lanInfo.bindAll } });
          toast({ title: '已更新监听地址', body: '重启服务后生效', tone: 'info' });
          await load();
        } catch (err) {
          toast({ title: '切换失败', body: describeError(err, '局域网设置').desc, tone: 'bad' });
        }
      });
      bindRow.append(bindSw);
      card.append(bindRow);

      // 地址列表
      const urls = lanInfo.urls || [];
      const urlBox = h('div', { class: 'url-list' });
      if (!urls.length) urlBox.append(fromHtml('<div class="hint">还没有可访问地址（局域网同步可能未开启）。</div>'));
      for (const u of urls) {
        const row = h('div', { class: 'url-row' });
        row.append(fromHtml(`<span class="url-value mono" title="${escapeHtml(u)}">${escapeHtml(u)}</span>`));
        row.append(iconButton('copy', {
          title: '复制地址',
          onClick: async () => {
            const ok = await copyText(u);
            toast({ title: ok ? '已复制地址' : '复制失败', body: u, tone: ok ? 'ok' : 'bad', timeout: 1800 });
          },
        }));
        urlBox.append(row);
      }
      card.append(urlBox);

      // token 显隐 + 配对串
      const hasToken = Boolean(lanInfo.token);
      const tokenRow = h('div', { class: 'url-row' });
      tokenRow.append(fromHtml(
        `<span class="hint" style="min-width:44px">token</span><span class="url-value mono">${escapeHtml(
          !hasToken ? '未生成（首次开启局域网同步时自动生成）'
            : showToken ? lanInfo.token : '•'.repeat(Math.min(24, lanInfo.token.length)),
        )}</span>`,
      ));
      tokenRow.append(iconButton(showToken ? 'eyeOff' : 'eye', { title: showToken ? '隐藏 token' : '显示 token', onClick: () => { showToken = !showToken; rerender(); } }));
      tokenRow.append(iconButton('copy', {
        title: '复制 token',
        onClick: async () => {
          const ok = await copyText(lanInfo.token || '');
          toast({ title: ok ? '已复制 token' : '复制失败', tone: ok ? 'ok' : 'bad', timeout: 1800 });
        },
      }));
      card.append(tokenRow);

      const pairUrl = urls[0] || `http://127.0.0.1:${lanInfo.port}`;
      // 服务端给了 pair 串就用它（wakedream://pair?...），否则自己拼一份等价的 JSON
      const pair = lanInfo.pair || JSON.stringify({ url: pairUrl, token: lanInfo.token || '', deviceName: lanInfo.deviceName || '' });
      card.append(fromHtml('<div class="hint">配对串（粘到另一台设备的「新增 → 局域网」）：</div>'));
      card.append(fromHtml(`<div class="pairing" title="点击全选">${escapeHtml(pair)}</div>`));
      const pairBar = h('div', { class: 'form-actions' });
      pairBar.append(actionButton('复制配对串', {
        iconName: 'copy', primary: true,
        onClick: async () => {
          const ok = await copyText(pair);
          toast({ title: ok ? '配对串已复制' : '复制失败', body: ok ? '在另一台设备上粘贴即可' : pair, tone: ok ? 'ok' : 'bad' });
        },
      }));
      card.append(pairBar);

      if (lanInfo.hint) card.append(fromHtml(`<div class="hint">${escapeHtml(lanInfo.hint)}</div>`));

      box.append(card);
      return section;
    }

    function rerender() {
      const top = scroll.scrollTop;
      clear(inner);
      inner.append(remoteSection());
      inner.append(lanSection());
      inner.append(jobsSection());
      scroll.scrollTop = top;
    }

    await load();
    const offDone = ctx.onEvent('scan:done', () => load());

    return {
      refresh: load,
      destroy() {
        disposed = true;
        for (const t of pollers.values()) clearInterval(t);
        pollers.clear();
        offDone?.();
      },
    };
  },
};
