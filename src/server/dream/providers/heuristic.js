// heuristic provider：零依赖、离线可用的规则式萃取。
// 归属：dream worker。
//
// 原则（与 analyzer 提示词同一套约束）：
//   1. 只从**真实出现过的文本**里抽线索，每条都带 evidence（原文片段）与 sessions（来源会话 id）；
//      绝不编造转录里没有的事实。
//   2. 优先用户消息（任务、决定、偏好、未决）与助手消息里的结论句；工具调用用来还原「实际做了什么」。
//   3. 抽不到的东西就留空，宁可少写，不要把噪声写进记忆库。
//   4. 与模型路径共用同一套规范化 / 收敛函数，所以落盘形状完全一致，可以逐段降级。
import { item } from './normalize.js';
import { assistantTexts, humanizePayload, toolCalls, userTexts } from '../transcript.js';

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
    /^(你好|您好|hi|hello|hey|好的|好|嗯|哦|谢谢|多谢|感谢|收到|明白|ok|okay|thanks|thank you|不客气)[。.!！~～\s]*$/i,
    /^[`#>*\-\s|]+$/,
    /^我(先|来|去|现在|接着|然后|再|想|打算|准备|看看|查一下|试一下|开始)/,
    /^(让我|现在我|下面我|接下来我)/,
    // 技能/工具目录行：「dsh-badge: Add the official…」「lark-base: 多维表格…」
    /^[-*]?\s*'?[a-z][a-z0-9_-]{2,40}'?:\s.{30,}/i,
    // harness 运行时样板句
    /(current runtime context|implementation checkout|dsh file policy|browser time zone|elapsed since)/i,
    /^(agent teams is available|the team lead and all teammates)/i,
];

const ASK_VERBS = /(帮我|帮忙|请|需要|要|做|实现|修复|加|写|改|删|查|跑|建|搭|整理|生成|优化|重构|迁移|验证|测试|对比|拉下来|装上|接上|add|fix|implement|build|create|write|refactor|migrate|check|run|update|remove|make|review|integrate|scaffold|wire)/i;
const CONCLUSION_MARKERS = /(结论|结论是|因此|所以|根因|原因是|要点|关键|注意|坑|这意味着|说明|验证|通过|失败原因|问题是|必须|不能|不支持|支持|会在|结果是|=>|意味着)/;
const USER_FACT_MARKERS = /(其实|实际上|事实|前提|依赖|必须|不能|不支持|支持|要注意|记住|注意|默认|约定|规则|限制)/;
const DECISION_MARKERS = /(决定|定了|确定(?:用|按|走|采用)|采用|选择|选用|改用|换成|改成|统一(?:用|成|走)|就按|以后(?:都)?(?:用|按|走)|不要用|别用|不用|必须|优先|先做|go with|let'?s use|we'?ll use|decide[ds]?|switch to|instead of|use .{1,30} instead)/i;
const OPEN_QUESTION_MARKERS = /(待确认|待定|未决|未定|需要确认|回头|下次(?:再|说)|之后再|还不确定|不确定|怎么办|是否要|要不要|还没|尚未|TODO|FIXME|TBD|open question|need to check|follow[- ]?up)/i;
// 「下一步 / 接下来 / 待办」这类前瞻线索：既不是决定也不是未决，但要留在记忆里。
// 注意 `待办` 必须自成线索（「审批待办怎么拉」里的「待办」是名词，不算）
const NEXT_STEP_MARKERS = /(下一步|接下来|(^|[\s，。；、（(])待办|计划(?:要|做|是)|后续(?:要|再)|然后(?:要|需要|再)|next step|next up|to-?do list|remaining work|follow[- ]?up (?:with|on))/i;
const PREFERENCE_MARKERS = /(我喜欢|我倾向|我更(?:喜欢|倾向)|以后(?:都)?(?:请|要|用|按)|默认|统一(?:用|按)|请用|请按|别用|不要用|尽量|务必|一定要|记住|注意|prefer|always|never|don'?t|please use|in chinese|用中文)/i;
const REASON_MARKERS = /(因为|由于|原因是|理由是|理由：|because|since)/;
const NEGATION = /(不|别|禁|勿|避免|never|avoid|don'?t|do not)/i;

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'are', 'was', 'were', 'you', 'your',
    'can', 'not', 'but', 'all', 'any', 'our', 'out', 'use', 'using', 'used', 'make', 'made', 'get', 'got',
    'code', 'file', 'files', 'test', 'tests', 'true', 'false', 'null', 'undefined', 'const', 'function',
    'return', 'import', 'export', 'async', 'await', 'string', 'number', 'object', 'array', 'node', 'npm',
    'json', 'http', 'https', 'www', 'com', 'and/or', 'etc', 'via', 'per',
]);

function stripCodeFences(text) {
    return String(text ?? '').replace(/```[\s\S]*?```/g, ' ');
}

function inlineCodeSpans(text) {
    const out = [];
    const re = /`([^`\n]{1,120})`/g;
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) out.push(m[1].trim());
    return out;
}

function splitSentences(text) {
    return stripCodeFences(text)
        .replace(/\r\n/g, '\n')
        .split(/(?<=[。！？!?])|\n+/)
        .map((s) => s.replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s*/, '').trim())
        .filter(Boolean);
}

function isNoise(sentence) {
    const s = sentence.trim();
    if (s.length < 6) return true;
    if (NOISE_PATTERNS.some((re) => re.test(s))) return true;
    // 纯标点 / 纯符号
    if (!/[\p{L}\p{N}]/u.test(s)) return true;
    return false;
}

function clip(text, max = 180) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function normalizeKey(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[\s，。、；：！？,.;:!?"'`（）()\[\]【】《》<>*_~|]/g, '')
        .slice(0, 160);
}

/** 去重：同 key 保留第一条，合并 sessions / days */
export function dedupeItems(items, { maxPerKey = 1 } = {}) {
    const byKey = new Map();
    for (const entry of items) {
        if (!entry || !entry.text) continue;
        const key = normalizeKey(entry.text);
        if (!key) continue;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { ...entry, sessions: [...new Set(entry.sessions || [])] });
            continue;
        }
        existing.sessions = [...new Set([...(existing.sessions || []), ...(entry.sessions || [])])];
        if (!existing.evidence && entry.evidence) existing.evidence = entry.evidence;
        if (!existing.reason && entry.reason) existing.reason = entry.reason;
        const days = new Set([...(existing.days || (existing.day ? [existing.day] : [])), ...(entry.days || (entry.day ? [entry.day] : []))]);
        existing.days = [...days].sort();
        existing.occurrences = (existing.occurrences || 1) + 1;
        if (existing.occurrences > maxPerKey) { /* 保留合并后的那一条 */ }
    }
    return [...byKey.values()];
}

function bigrams(text) {
    const s = normalizeKey(text);
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
}

export function similarity(a, b) {
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter += 1;
    return (2 * inter) / (A.size + B.size);
}

// ---------------------------------------------------------------------------
// 单会话分析（对应 analyzer 角色）
// ---------------------------------------------------------------------------

function collectToolFacts(messages) {
    const calls = toolCalls(messages);
    const counts = new Map();
    for (const call of calls) counts.set(call.name, (counts.get(call.name) || 0) + 1);
    const commands = [];
    for (const call of calls) {
        const input = call.meta?.input || call.meta?.args || null;
        if (input && typeof input === 'object') {
            const cmd = input.command || input.cmd || input.script || input.query || null;
            if (typeof cmd === 'string' && cmd.trim()) commands.push(clip(cmd, 160));
        } else if (/^bash|shell|exec/i.test(call.name) && call.text) {
            commands.push(clip(call.text, 160));
        }
    }
    return {
        calls,
        counts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
        commands,
    };
}

const FILE_RE = /(?:^|[\s'"`(])((?:~|\.{1,2}\/|\/)[\w@%+.,/=-]{3,140}|[\w-]{2,60}\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|py|rs|go|css|html|sql|sh|zsh|yml|yaml|toml|txt|log|ipynb))\b/g;

function collectFiles(texts) {
    const found = new Map();
    for (const text of texts) {
        let m;
        const re = new RegExp(FILE_RE.source, 'g');
        while ((m = re.exec(String(text ?? ''))) !== null) {
            const p = m[1].replace(/[.,;:]+$/, '');
            if (p.includes('node_modules/') || p.startsWith('/tmp/')) continue;
            if (p.length < 4) continue;
            found.set(p, (found.get(p) || 0) + 1);
        }
    }
    return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 15);
}

function collectKeywords(texts) {
    const counts = new Map();
    for (const text of texts) {
        const src = stripCodeFences(text);
        for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9_.+-]{2,}/g)) {
            const token = m[0].toLowerCase().replace(/[.+-]+$/, '');
            if (token.length < 3 || STOPWORDS.has(token)) continue;
            counts.set(token, (counts.get(token) || 0) + 1);
        }
        for (const m of src.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) {
            const token = m[0];
            if (/^(我们|你们|他们|这个|那个|什么|怎么|可以|需要|然后|所以|但是|因为|如果|已经|还是|就是|一下|一个|这些|那些|现在|这里|那里)$/.test(token)) continue;
            counts.set(token, (counts.get(token) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([token]) => token)
        .slice(0, 15);
}

const PEOPLE_BLOCKLIST = new Set([
    'local', 'ssh', 'lan', 'host', 'user', 'param', 'params', 'returns', 'example', 'example.com',
    'param.', 'type', 'link', 'see', 'deprecated', 'todo', 'ts', 'js', 'media', 'keyframes', 'import',
]);

function collectPeople(texts) {
    const found = new Set();
    for (const text of texts) {
        const src = String(text ?? '');
        for (const m of src.matchAll(/@([A-Za-z][A-Za-z0-9_.-]{2,30})/g)) {
            const name = m[1].replace(/[.-]+$/, '');
            // 排掉 @local / @param / @media 这类代码与主机名噪声
            if (PEOPLE_BLOCKLIST.has(name.toLowerCase())) continue;
            if (name.length < 3) continue;
            found.add(name);
        }
        for (const m of src.matchAll(/([\u4e00-\u9fa5]{2,4})(?:老师|同学|同事|大佬)/g)) found.add(m[1]);
    }
    return [...found].slice(0, 20);
}

function splitReason(sentence) {
    const m = REASON_MARKERS.exec(sentence);
    if (!m) return { text: trimTail(sentence), reason: '' };
    const idx = m.index;
    const head = sentence.slice(0, idx).trim();
    const tail = sentence.slice(idx + m[0].length).trim();
    if (head.length >= 4 && tail.length >= 2) return { text: trimTail(head), reason: trimTail(tail) };
    return { text: trimTail(sentence), reason: '' };
}

/** 去掉句尾残留的逗号/分号（句子在「因为」处被切开时会留下），保留问号感叹号 */
function trimTail(text) {
    return String(text ?? '').replace(/[\s，,、；;：:]+$/, '').trim();
}

/** 「以后/请/我倾向」这类说法算偏好，不算决定 */
const PREFERENCE_LEAD = /^(以后|下次|往后|请|我(?:喜欢|倾向|更(?:喜欢|倾向))|默认|统一|尽量|务必|一定要|记住)/;

/**
 * 跨小节去重：同一句话只留在优先级最高的一节里，避免一份文件里同一件事说三遍。
 * 优先级：决定 > 未决 > 结论 > 偏好 > 做了什么（越靠前越「明确」）。
 */
export function dedupeAcrossSections(sections) {
    const claimed = [];
    const order = ['decisions', 'openQuestions', 'nextSteps', 'conclusions', 'preferences', 'didWhat'];
    const out = {};
    for (const key of order) {
        out[key] = (sections[key] || []).filter((entry) => {
            const k = normalizeKey(entry.text);
            if (!k) return false;
            // 完全重复，或与已收录条目互相包含（「就按 X 做」vs「就按 X 做，因为…」）都算重复
            const dup = claimed.some((c) => c === k || (k.length >= 10 && c.length >= 10 && (k.includes(c) || c.includes(k))));
            if (dup) return false;
            claimed.push(k);
            return true;
        });
    }
    return out;
}

/**
 * 单会话规则式萃取。签名与模型路径的 analyzer 对齐：`{session, messages, subagents}` → analysis。
 */
export async function analyzeSession({ session, messages = [], subagents = [], transcriptInfo = null } = {}) {
    // 先「人化」：JSON 票据抽 title/text 字段、去 HTML，否则真实会话里的机器载荷会淹掉信号
    const users = userTexts(messages).map((t) => humanizePayload(t));
    const assistants = assistantTexts(messages).map((t) => humanizePayload(t));
    const subUserTexts = subagents.flatMap((child) => userTexts(child.messages).map((t) => humanizePayload(t)));
    const allUserTexts = [...users, ...subUserTexts];
    const toolFacts = collectToolFacts(messages);

    const userSentences = users.flatMap(splitSentences).filter((s) => !isNoise(s));
    const assistantSentences = assistants.flatMap(splitSentences).filter((s) => !isNoise(s));
    const allSentences = [...userSentences, ...assistantSentences];

    // 做了什么：用户的诉求句 + 工具调用统计（问句留给「未决」，不放进「做了什么」）
    const didWhat = [];
    for (const s of userSentences) {
        if (didWhat.length >= 6) break;
        if (/[?？]\s*$/.test(s)) continue;
        if (ASK_VERBS.test(s)) didWhat.push(item(clip(s, 160), { sessions: [session.id], day: session.dateKey, evidence: clip(s) }));
    }
    if (toolFacts.calls.length) {
        const breakdown = toolFacts.counts.slice(0, 6).map(([name, n]) => `${name}×${n}`).join('、');
        didWhat.push(item(`共 ${toolFacts.calls.length} 次工具调用（${breakdown}）`, {
            sessions: [session.id], day: session.dateKey, evidence: '',
        }));
    }

    // 结论：助手侧带结论标记的句子；用户侧的「事实句」
    const conclusions = [];
    for (const s of assistantSentences) {
        if (conclusions.length >= 10) break;
        if (CONCLUSION_MARKERS.test(s) && s.length >= 8) {
            conclusions.push(item(clip(s, 200), { sessions: [session.id], day: session.dateKey, evidence: clip(s) }));
        }
    }
    for (const s of userSentences) {
        if (conclusions.length >= 14) break;
        if (USER_FACT_MARKERS.test(s) && s.length >= 10 && !DECISION_MARKERS.test(s)) {
            conclusions.push(item(clip(s, 200), { sessions: [session.id], day: session.dateKey, evidence: clip(s) }));
        }
    }

    // 决定（「以后/请…」这类是偏好，归到偏好那一节）
    const decisions = userSentences
        .filter((s) => DECISION_MARKERS.test(s) && s.length >= 6 && !PREFERENCE_LEAD.test(s))
        .slice(0, 8)
        .map((s) => {
            const { text, reason } = splitReason(s);
            return item(clip(text, 220), {
                sessions: [session.id], day: session.dateKey, evidence: clip(s), extra: { reason: clip(reason, 160) },
            });
        })
        .filter(Boolean);

    // 未决：用户的问题（真·待办）+ 带强标记的句子；URL 结尾的 `?` 不算问题
    const isUrlTail = (s) => /https?:\/\/\S*\?\s*$/.test(s);
    const looksLikeQuestion = (s) => /[?？]\s*$/.test(s) && !isUrlTail(s) && s.length >= 8 && s.length <= 200;
    // 「无未决项」「已全部完成」这类是收尾陈述，不是新的未决
    const isResolvedStatement = (s) => /(全部完成|已解决|均已|已确认|[(（]无|^(无|没有|未发现))/.test(s);
    // 下一步：前瞻线索（用户与助手都可能写），既不算决定也不算未决，单独一节保留
    const nextSteps = [...userSentences, ...assistantSentences]
        .filter((s) => NEXT_STEP_MARKERS.test(s) && !isResolvedStatement(s) && !looksLikeQuestion(s))
        .slice(0, 6)
        .map((s) => item(clip(s, 220), { sessions: [session.id], day: session.dateKey, evidence: clip(s) }));

    const openQuestions = [
        ...userSentences.filter((s) => (OPEN_QUESTION_MARKERS.test(s) || looksLikeQuestion(s)) && !isResolvedStatement(s)),
        // 助手侧只用明确的「待跟进」标记，避免把修辞疑问句与 URL 片段当成未决
        ...assistantSentences.filter((s) => OPEN_QUESTION_MARKERS.test(s) && !isResolvedStatement(s)),
    ]
        .filter((s) => !/^(好的|谢谢)/.test(s))
        .slice(0, 8)
        .map((s) => item(clip(s, 220), { sessions: [session.id], day: session.dateKey, evidence: clip(s), extra: { owner: '' } }));

    // 偏好
    const preferences = userSentences
        .filter((s) => PREFERENCE_MARKERS.test(s) && s.length >= 6)
        .slice(0, 6)
        .map((s) => item(clip(s, 200), {
            sessions: [session.id], day: session.dateKey, evidence: clip(s), extra: { scope: session.projectPath || session.project || '' },
        }));

    // 命令与文件
    const commands = [
        ...toolFacts.commands,
        ...allUserTexts.flatMap(inlineCodeSpans).filter((c) => /[\/\s-]|^\w+$/.test(c) && c.length >= 3),
    ];
    const files = collectFiles([...allUserTexts, ...assistants, ...toolFacts.commands]);
    const keywords = collectKeywords(allSentences);
    const people = collectPeople(allUserTexts);

    // 摘要：诉求 → 产出
    const ask = userSentences[0] ? clip(userSentences[0], 120) : '(无用户消息)';
    const lastAssistant = assistantSentences.filter((s) => s.length >= 10).slice(-1)[0] || '';
    const outcome = lastAssistant ? clip(lastAssistant, 140) : '';
    const summaryParts = [`用户诉求：${ask}`];
    if (toolFacts.calls.length) summaryParts.push(`动作：${toolFacts.counts.slice(0, 4).map(([n, c]) => `${n}×${c}`).join('、')}`);
    if (outcome) summaryParts.push(`收尾：${outcome}`);
    const summary = summaryParts.join('；');

    const staleNotes = [];
    if (transcriptInfo?.truncated) {
        staleNotes.push(`转录超长，喂给分析前省略了中间 ${transcriptInfo.droppedChars} 字符（原 ${transcriptInfo.originalChars}）`);
    }
    if (!session.endedAt) staleNotes.push('会话没有结束时间，可能是仍在进行中被整理的');

    return {
        sessionId: session.id,
        agent: session.agent,
        host: session.host,
        project: session.project || 'Unknown',
        projectPath: session.projectPath || null,
        title: session.title || '',
        day: session.dateKey,
        startedAt: session.startedAt,
        summary,
        ...dedupeAcrossSections({
            didWhat: dedupeItems(didWhat, { maxPerKey: 3 }),
            conclusions: dedupeItems(conclusions, { maxPerKey: 3 }),
            decisions: dedupeItems(decisions, { maxPerKey: 3 }),
            openQuestions: dedupeItems(openQuestions, { maxPerKey: 3 }),
            nextSteps: dedupeItems(nextSteps, { maxPerKey: 3 }),
            preferences: dedupeItems(preferences, { maxPerKey: 3 }),
        }),
        people,
        keywords,
        commands: [...new Set(commands)].slice(0, 15),
        files,
        staleNotes,
        truncated: !!transcriptInfo?.truncated,
        analyzeError: null,
        _source: 'heuristic',
    };
}

// ---------------------------------------------------------------------------
// 收敛（对应 organizer 角色）
// ---------------------------------------------------------------------------

const DECISION_VALUE_RE = /(?:改用|换成|改成|统一用|统一成|统一走|采用|选用|选择|默认用|默认)\s*([A-Za-z0-9_./@+-]{2,30}|[\u4e00-\u9fa5]{2,12})/g;

/** 决定句 → {key, values[]}，用于发现「同一件事被改成了不同的值」 */
function decisionTopic(text) {
    const values = [];
    const re = new RegExp(DECISION_VALUE_RE.source, 'g');
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) values.push(m[1]);
    if (!values.length) return null;
    let key = String(text);
    for (const v of values) key = key.replace(v, '<V>');
    return { key: normalizeKey(key), values };
}

/** 找出「同主题不同取值」与「一正一否」的冲突（尽力而为，宁可漏报不要误报） */
export function detectConflicts(items) {
    const conflicts = [];
    const byTopic = new Map();
    for (const entry of items) {
        const topic = decisionTopic(entry.text);
        if (!topic || topic.key.length < 8) continue;
        // 一句话里同时提到多个取值（「A 改用 x，B 改用 y」这种并列/目录式句子）不是冲突
        if (new Set(topic.values).size > 1) continue;
        // 模板化文本（同一句套话在不同条目里复用）容易造成假冲突：要求整句有足够差异
        if (!byTopic.has(topic.key)) byTopic.set(topic.key, []);
        byTopic.get(topic.key).push({ entry, values: topic.values });
    }
    for (const [, group] of byTopic) {
        const allValues = [...new Set(group.flatMap((g) => g.values))];
        const sessions = [...new Set(group.flatMap((g) => g.entry.sessions || []))];
        const texts = [...new Set(group.map((g) => normalizeKey(g.entry.text)))];
        if (allValues.length > 1 && sessions.length > 1 && texts.length > 1) {
            conflicts.push({
                text: `同一件事在不同会话里被定成了不同的值：${allValues.join(' / ')}`,
                sides: group.map((g) => `${clip(g.entry.text, 140)}（${g.entry.day || '日期未知'}，来源 ${(g.entry.sessions || []).join('、')}）`),
                sessions,
            });
        }
    }
    // 一正一否
    for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
            const a = items[i];
            const b = items[j];
            const shared = (a.sessions || []).some((s) => (b.sessions || []).includes(s));
            if (similarity(a.text, b.text) < 0.66) continue;
            if (NEGATION.test(a.text) === NEGATION.test(b.text)) continue;
            conflicts.push({
                text: `说法互相矛盾：${clip(a.text, 90)} ⟷ ${clip(b.text, 90)}`,
                sides: [`${clip(a.text, 140)}（${a.day || '?'}，${(a.sessions || []).join('、')}）`, `${clip(b.text, 140)}（${b.day || '?'}，${(b.sessions || []).join('、')}）`],
                sessions: [...new Set([...(a.sessions || []), ...(b.sessions || [])])],
                sameSession: shared,
            });
        }
    }
    const seen = new Set();
    return conflicts.filter((c) => {
        const k = normalizeKey(c.text);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).slice(0, 20);
}

function priorItems(prior, key) {
    const list = prior?.[key];
    if (!Array.isArray(list)) return [];
    return list.map((entry) => item(entry.text, {
        sessions: entry.sessions || [],
        day: entry.day || null,
        evidence: entry.evidence || '',
        extra: { reason: entry.reason || '', scope: entry.scope || '', owner: entry.owner || '', carried: true },
    })).filter(Boolean);
}

/**
 * 规则式收敛：把当天的逐会话分析 + 此前累积的偏好/决定合成一份 organized 结果。
 * 每阶段的降级点：模型不可用/输出不可解析时，organize 阶段单独退回这里。
 */
export async function organize({ day, store, analyses = [], prior = null } = {}) {
    const decisions = dedupeItems([
        ...priorItems(prior, 'decisions'),
        ...analyses.flatMap((a) => (a.decisions || []).map((d) => ({ ...d, day: d.day || a.day }))),
    ]);
    const preferencesAll = dedupeItems([
        ...priorItems(prior, 'preferences'),
        // 「还没写下的候选」也要跨天累积：一句偏好可能每天都只出现一次，攒够重复次数才算数
        ...priorItems(prior, 'preferenceCandidates'),
        ...analyses.flatMap((a) => (a.preferences || []).map((p) => ({ ...p, day: p.day || a.day }))),
    ]);
    // 「重复出现才写」：跨会话或跨天出现过至少两次
    const isRepeated = (p) => {
        const sessions = new Set(p.sessions || []);
        const days = new Set(p.days?.length ? p.days : (p.day ? [p.day] : []));
        return sessions.size >= 2 || days.size >= 2;
    };
    const preferences = preferencesAll.filter(isRepeated);

    const openQuestions = dedupeItems([
        ...priorItems(prior, 'openQuestions'),
        ...analyses.flatMap((a) => (a.openQuestions || []).map((q) => ({ ...q, day: q.day || a.day }))),
    ]);

    const peopleMap = new Map();
    for (const entry of [...(prior?.people || [])]) {
        if (entry?.name) peopleMap.set(entry.name, { name: entry.name, role: entry.role || '', sessions: entry.sessions || [] });
    }
    for (const analysis of analyses) {
        for (const name of analysis.people || []) {
            const existing = peopleMap.get(name) || { name, role: '', sessions: [] };
            existing.sessions = [...new Set([...(existing.sessions || []), analysis.sessionId])];
            peopleMap.set(name, existing);
        }
    }

    // 项目聚合
    const projectMap = new Map();
    for (const analysis of analyses) {
        const slug = projectSlug(analysis);
        if (!projectMap.has(slug)) {
            projectMap.set(slug, {
                slug,
                title: analysis.project || 'Unknown',
                path: analysis.projectPath || null,
                sessions: [],
                bullets: [],
                openQuestions: [],
                nextSteps: [],
                conclusions: [],
                didWhat: [],
                agents: new Set(),
            });
        }
        const bucket = projectMap.get(slug);
        bucket.sessions.push(analysis.sessionId);
        if (analysis.agent) bucket.agents.add(analysis.agent);
        bucket.conclusions.push(...(analysis.conclusions || []));
        bucket.didWhat.push(...(analysis.didWhat || []));
        bucket.openQuestions.push(...(analysis.openQuestions || []));
        bucket.nextSteps.push(...(analysis.nextSteps || []));
    }
    const projects = [...projectMap.values()].map((bucket) => {
        const bullets = dedupeItems([...bucket.conclusions, ...bucket.didWhat]);
        return {
            slug: bucket.slug,
            title: bucket.title,
            path: bucket.path,
            agents: [...bucket.agents],
            sessions: [...new Set(bucket.sessions)],
            bullets,
            openQuestions: dedupeItems(bucket.openQuestions),
            nextSteps: dedupeItems(bucket.nextSteps),
            summary: projectSummary(bucket, bullets),
        };
    }).sort((a, b) => b.sessions.length - a.sessions.length);

    const conflicts = detectConflicts([...decisions, ...conclusionsOf(analyses)]);
    const nextStepCount = analyses.reduce((n, a) => n + (a.nextSteps?.length || 0), 0);

    const sessionCount = analyses.length;
    return {
        day,
        store,
        indexIntro: sessionCount
            ? `本日共整理 ${sessionCount} 个会话，覆盖 ${projects.length} 个项目/主题。`
            : '本日没有可整理的会话。',
        projects,
        decisions,
        preferences,
        preferenceCandidates: preferencesAll,
        openQuestions,
        people: [...peopleMap.values()],
        conflicts,
        changes: [
            `合并 ${sessionCount} 个会话的分析结果`,
            `项目条目 ${projects.length} 个，决定 ${decisions.length} 条，未决 ${openQuestions.length} 条，下一步 ${nextStepCount} 条`,
            `偏好候选 ${preferencesAll.length} 条，其中重复出现达到阈值 ${preferences.length} 条`,
            prior ? `并入 ${prior.day || '上一份'} 的跨天累积（决定/偏好/未决）` : '无跨天累积可并入',
        ],
        _source: 'heuristic',
    };
}

function conclusionsOf(analyses) {
    return analyses.flatMap((a) => a.conclusions || []);
}

export function projectSlug(analysis) {
    // 用路径的**最后一段**做项目名：`…/work/wake-dream-client-xxxx` → `wake-dream-client-xxxx`，
    // 带上父目录（work/、src/）只会让 slug 变长且难认
    const base = analysis.projectPath
        ? String(analysis.projectPath).replace(/\/+$/, '').split('/').filter(Boolean).slice(-1)[0]
        : (analysis.project || 'unknown');
    return slug(base);
}

function slug(input) {
    const raw = String(input ?? '').trim() || 'unknown';
    const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return (cleaned || 'unknown').slice(0, 60);
}

function projectSummary(bucket, bullets) {
    const parts = [];
    parts.push(`${bucket.sessions.length} 个会话${bucket.agents.size ? `（${[...bucket.agents].join('、')}）` : ''}`);
    const first = bullets[0]?.text;
    if (first) parts.push(clip(first, 120));
    return parts.join('：');
}

export const _internal = {
    splitSentences, isNoise, collectFiles, collectKeywords, collectToolFacts, decisionTopic, clip,
};
