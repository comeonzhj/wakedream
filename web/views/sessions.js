// #/sessions 全部会话：左侧筛选 + 分组列表 + 分页，右侧阅读区空态（选中后进 #/sessions/:id）。
import { createBrowser } from './session-browser.js';
import { icon } from '../assets/icons.js';
import { h } from '../assets/ui.js';
import { actionButton } from './common.js';
import { runScan } from '../app.js';

export default {
  async render(host, ctx) {
    ctx.setTopbar({
      title: '全部会话',
      sub: '按 Agent → 项目分组 · 筛选写在地址栏',
      note: '',
    });

    const browser = createBrowser({
      ctx,
      host,
      activeId: null,
      readerBuilder: (col) => {
        col.append(readerEmpty(ctx));
      },
    });

    return {
      refresh: () => browser.reload(),
      destroy: () => browser.destroy(),
    };
  },
};

function readerEmpty(ctx) {
  const box = h('div', { class: 'state' });
  box.innerHTML =
    `<div class="state-icon">${icon('messages', 22)}</div>
     <div class="state-title">未选择会话</div>
     <div class="state-desc">从中间的列表里选一个会话，或按 ⌘K 跳到搜索框。</div>`;
  const actions = h('div', { class: 'state-actions' });
  actions.append(actionButton('扫描本机会话', { iconName: 'scan', primary: true, onClick: () => runScan({}) }));
  actions.append(actionButton('回到今日', { iconName: 'sunrise', onClick: () => ctx.navigate('#/today') }));
  box.append(actions);
  return box;
}
