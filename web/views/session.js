// #/sessions/:id 转录阅读：左侧同一套筛选与列表（保持上下文），右侧完整转录。
import { API } from '../assets/contract.js';
import { apiGet } from '../assets/api.js';
import { errorBlock, loadingBlock } from '../assets/ui.js';
import { agentName, fmtNum } from '../assets/format.js';
import { createBrowser } from './session-browser.js';
import { buildTranscript } from './transcript.js';

export default {
  async render(host, ctx) {
    const id = ctx.route.id;
    ctx.setTopbar({ title: '会话转录', sub: '载入中…', note: '' });

    let readerNode = loadingBlock('载入转录…');
    let session = null;
    let messages = [];
    let loadError = null;

    const browser = createBrowser({
      ctx,
      host,
      activeId: id,
      readerBuilder: (col) => { col.append(readerNode); },
    });

    async function fetchTranscript() {
      try {
        const res = await apiGet(API.session(id));
        session = res.session;
        messages = res.messages || [];
        loadError = null;
      } catch (err) {
        loadError = err;
        session = null;
        messages = [];
      }
      if (loadError) {
        readerNode = errorBlock(loadError, '会话转录', () => fetchTranscript().then(() => browser.setReader(readerNode)));
      } else {
        readerNode = buildTranscript({ session, messages, ctx });
        ctx.setTopbar({
          title: session.title || '会话转录',
          sub: `${agentName(session.agent)} · ${fmtNum(messages.length)} 条消息`,
          note: session.project || '',
        });
      }
      browser.setReader(readerNode);
    }

    await fetchTranscript();

    return {
      refresh: async () => { await fetchTranscript(); await browser.reload(); },
      destroy: () => browser.destroy(),
    };
  },
};
