// JSONL 读取工具：透明支持 `.jsonl` 与 `.jsonl.zstd`（dsh 的默认落盘格式）。
//
// dsh 的 zstd 文件是**多帧连接**（首帧写 header 行，之后每次 append 一帧）。
// 注意：Node 内置的 `zlib.zstdDecompressSync` 与 `createZstdDecompress()` 流都只解**第一帧**
// 就停（本机 Node v25.7 实测：93KB 的 session.v4.jsonl.zstd 只解出 232 字节），
// 所以这里自己按帧边界拆：扫描 zstd 魔数 → 对每个候选偏移单独解一帧 → 顺序拼接。
// 误判防护：候选帧必须解压成功、非空、首个非空白字符是 `{`（dsh 每行都是 JSON 对象）。
// 末尾半写帧（写端 append 与扫描天然并发）解压会抛错，捕获后保留已解出的部分。
import fs from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function isZstd(path) {
    return path.endsWith('.zstd');
}

/** 找出所有「看起来像 zstd 帧起点」的偏移（只做魔数粗筛，精筛在下一层） */
function frameOffsets(buf) {
    const offsets = [];
    let at = 0;
    while ((at = buf.indexOf(ZSTD_MAGIC, at)) !== -1) {
        offsets.push(at);
        at += ZSTD_MAGIC.length;
    }
    return offsets;
}

function looksLikeJsonStart(text) {
    const trimmed = text.replace(/^\s+/, '');
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * 把一个多帧 zstd buffer 解成完整文本。
 * 单帧（或 Node 以后支持多帧）时也走同一条路，结果一致。
 */
export function decompressZstd(buf) {
    if (buf.length < 4) return '';
    const offsets = frameOffsets(buf);
    if (!offsets.length) return '';
    const parts = [];
    for (const offset of offsets) {
        // 只解从该偏移开始的第一帧；Node 会忽略其后的多余字节
        let out;
        try {
            out = zlib.zstdDecompressSync(buf.subarray(offset));
        } catch {
            // 半写帧 / 误判魔数：跳过。末尾帧被截断是正常现象（dsh 边写边扫）
            continue;
        }
        if (!out.length) continue;
        const text = out.toString('utf8');
        if (!looksLikeJsonStart(text)) continue;
        parts.push(text);
    }
    return parts.join('');
}

/** 读文件全文（透明解压），读不出时抛错，由调用方收集进 errors[] */
export function readLogText(filePath) {
    const buf = fs.readFileSync(filePath);
    if (isZstd(filePath) || (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC))) {
        return decompressZstd(buf);
    }
    return buf.toString('utf8');
}

/**
 * 按行解析 JSONL，返回 [{line, value}]；坏行计数单独返回。
 * 与 Wake 的适配器一致：坏行只计数、不中断（写端半写、schema 漂移都可能出现）。
 */
export function parseJsonl(text) {
    const rows = [];
    let badLines = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            rows.push(JSON.parse(trimmed));
        } catch {
            badLines += 1;
        }
    }
    return { rows, badLines };
}

/** 一步到位：读文件 + 解压 + 逐行 JSON */
export function readJsonl(filePath) {
    return parseJsonl(readLogText(filePath));
}
