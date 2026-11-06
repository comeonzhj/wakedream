// prompt 文件加载器。归属：dream worker。
// 提示词放在本目录的 *.md 里（对齐 cookbook 的 message / lead / analyzer / organizer 四份），
// 这样改提示词不用改代码，也方便单测断言占位符。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map();

export const PROMPT_NAMES = [
    'work_request',      // message 模板
    'lead_system',       // lead 角色
    'analyzer_system',   // analyzer 角色
    'analyzer_task',     // 每个会话一份的任务外壳
    'organizer_system',  // organizer 角色
    'organizer_task',    // 整轮一次的收敛任务外壳
];

/** 读一份提示词原文 */
export function loadPrompt(name) {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(DIR, `${name}.md`);
    const text = fs.readFileSync(file, 'utf8');
    cache.set(name, text);
    return text;
}

/** 把所有提示词一次读出来（报告里给出校验和用） */
export function loadAllPrompts() {
    const out = {};
    for (const name of PROMPT_NAMES) out[name] = loadPrompt(name);
    return out;
}

/** 填充 `{key}` 占位符；缺变量时原样保留，方便发现漏填 */
export function fillPrompt(template, vars = {}) {
    return String(template).replace(/\{([a-zA-Z_][\w]*)\}/g, (all, key) => (
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all
    ));
}

/** 依赖方（lead 的 bin/dream.js、UI 的「复制挂载指令」）用得到的一句话挂载说明 */
export function mountInstructions(memoryDir) {
    return [
        '长期记忆（只读挂载）：',
        `- 记忆库目录：${memoryDir}`,
        '- 先读 `_index.md` 拿到目录，再按需打开 `projects/`、`decisions.md`、`preferences.md`、`open-questions.md`。',
        '- 记忆是从过去的会话里萃取的，可能过期；`source_sessions` 指回原始会话，重要结论请回原会话核对。',
    ].join('\n');
}
