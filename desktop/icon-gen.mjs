#!/usr/bin/env node
// 生成应用图标源图（1024×1024 PNG）——自己画，不用 emoji、不用第三方品牌图、不依赖任何图形库。
//
// 形状取自 web/index.html 里的品牌标记（`--accent` 暮紫 + 暖石墨底）：
//   <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>   月亮
//   <path d="M3 20.5h18"/>                                                 地平线
//   <path d="M6.5 20.5a5.5 5.5 0 0 1 11 0"/>                               地平线上方的弧
// 也就是「月亮落在地平线上」——Wake（醒来）+ Dream（做梦）的同一枚标记，桌面图标与 App 内一致。
//
// 月亮是两条同半径（8.5）圆弧围出来的区域：外弧圆心 (11.82,12.18)、内弧圆心 (17.68,6.32)，
// 所以直接写成「圆 A 减去 圆 B」的有符号距离场（SDF），再用 3×3 超采样做抗锯齿。
//
// 用法：
//   node app/desktop/icon-gen.mjs                       # → app/desktop/icon-source.png
//   node app/desktop/icon-gen.mjs --out /tmp/x.png
//   node app/desktop/icon-gen.mjs --check <png>         # 只校验尺寸/格式
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(__dirname, 'icon-source.png');
export const ICON_SIZE = 1024;

// ---------------------------------------------------------------- 几何（24×24 坐标系，与品牌 SVG 一致）
//
// 品牌标记是**描边**图形（web/index.html 里 fill="none" stroke-width="1.6"），不是填充图形：
//   月亮 = 圆心 (11.823,12.177) 半径 8.5 的圆弧，角度从 15.9° 顺时针到 254.1°（y 向下坐标系）
//          —— 这条弧就是月亮的外轮廓；图标上把它按更粗的笔宽「描」出来，才是同一个形状。
//          （第一版按 path 的填充区域画，得到一个又肥又糊的半月，和品牌标记根本不是一回事。）
//   地平线 = (3,20.5)→(21,20.5) 的圆头线段
//   中弧   = 圆心 (12,20.5) 半径 5.5 的上半圆（图标默认不画，见 withArc）
// 所有形状都给「有符号距离」（<0 在里面），抗锯齿交给超采样。
export const MOON = { cx: 11.823, cy: 12.177, r: 8.5, half: 1.0, a0: 15.9, a1: 254.1 };
export const HORIZON = { x0: 3.0, x1: 21.0, y: 20.5, half: 0.85 };
export const ARC = { cx: 12.0, cy: 20.5, r: 5.0, half: 0.85, top: true };

const DEG = 180 / Math.PI;
const degOf = (dx, dy) => ((Math.atan2(dy, dx) * DEG) + 360) % 360;
const INSIDE = -1;
const OUTSIDE = 1;

/** 月亮：外轮廓弧按 half 笔宽描粗，两端圆头；底部齐地平线（切口被地平线压住，看不见） */
export function moonSdf(x, y) {
    const dx = x - MOON.cx;
    const dy = y - MOON.cy;
    const ring = Math.abs(Math.hypot(dx, dy) - MOON.r) - MOON.half;
    if (y > HORIZON.y) return OUTSIDE; // 月亮的底边就是地平线：不往下出头
    const angle = degOf(dx, dy);
    if (angle >= MOON.a0 && angle <= MOON.a1) return ring <= 0 ? INSIDE : OUTSIDE;
    // 角向之外只剩两个圆头端帽
    const caps = [
        [MOON.cx + MOON.r * Math.cos(MOON.a0 / DEG), MOON.cy + MOON.r * Math.sin(MOON.a0 / DEG)],
        [MOON.cx + MOON.r * Math.cos(MOON.a1 / DEG), MOON.cy + MOON.r * Math.sin(MOON.a1 / DEG)],
    ];
    const capDist = Math.min(...caps.map(([cx, cy]) => Math.hypot(x - cx, y - cy)));
    return capDist <= MOON.half ? INSIDE : OUTSIDE;
}

/** 地平线：圆头线段 */
export function horizonSdf(x, y) {
    const cx = Math.min(Math.max(x, HORIZON.x0), HORIZON.x1);
    return Math.hypot(x - cx, y - HORIZON.y) <= HORIZON.half ? INSIDE : OUTSIDE;
}

/** 品牌标记里的中弧（上半圆环） */
export function arcSdf(x, y) {
    if (ARC.top && y > ARC.cy) return OUTSIDE;
    return Math.abs(Math.hypot(x - ARC.cx, y - ARC.cy) - ARC.r) <= ARC.half ? INSIDE : OUTSIDE;
}

/** 圆角矩形 SDF */
export function roundedRectSdf(x, y, cx, cy, halfW, halfH, r) {
    const qx = Math.abs(x - cx) - (halfW - r);
    const qy = Math.abs(y - cy) - (halfH - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 24×24 坐标系里整个图形的包围盒（用来把标记在画布里摆正） */
export function glyphBBox(withArc = false) {
    const xs = [HORIZON.x0 - HORIZON.half, HORIZON.x1 + HORIZON.half];
    const ys = [HORIZON.y + HORIZON.half];
    // 只取落在月亮角度区间里的极值点：270° 不在 [a0,a1] 里，算进去会把包围盒撑高
    for (const a of [MOON.a0, MOON.a1, 90, 180].filter((a) => a >= MOON.a0 && a <= MOON.a1)) {
        const rad = a / DEG;
        xs.push(MOON.cx + (MOON.r + MOON.half) * Math.cos(rad));
        ys.push(MOON.cy + (MOON.r + MOON.half) * Math.sin(rad));
    }
    ys.push(MOON.cy + (MOON.r + MOON.half)); // 理论下界；真实下界被地平线裁掉，下面会覆盖
    if (withArc) {
        xs.push(ARC.cx - ARC.r - ARC.half, ARC.cx + ARC.r + ARC.half);
        ys.push(ARC.cy - ARC.r - ARC.half);
    }
    // 月亮底边被地平线裁掉：真实下界就是地平线下沿
    const top = Math.min(...ys.filter((v) => v < HORIZON.y));
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: top, maxY: HORIZON.y + HORIZON.half };
}

export function glyphTransform(size = ICON_SIZE, fillRatio = 0.58, withArc = false) {
    const bb = glyphBBox(withArc);
    const w = bb.maxX - bb.minX;
    const h = bb.maxY - bb.minY;
    const scale = (size * fillRatio) / Math.max(w, h);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    return { scale, cx, cy, toGlyph: (x, y) => ({ x: (x - size / 2) / scale + cx, y: (y - size / 2) / scale + cy }) };
}

function lerp(a, b, t) { return a + (b - a) * t; }

/** 渲染成 RGBA 像素缓冲 */
export function renderIcon(size = ICON_SIZE, supersample = 3, withArc = false) {
    const buf = Buffer.alloc(size * size * 4);
    const plate = { inset: size * 0.0625, radius: size * 0.195 };       // 外面留一圈透明边，更像 macOS 原生图标
    const half = size / 2 - plate.inset;
    const t = glyphTransform(size, 0.58, withArc);
    // 底板竖向渐变（暖石墨），月亮竖向渐变（暮紫 → 深一点的紫）
    const plateTop = [46, 46, 57];
    const plateBottom = [27, 27, 34];
    const inkTop = [179, 166, 255];
    const inkBottom = [124, 108, 246];
    const inv = 1 / (supersample * supersample);

    for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
            let r = 0; let g = 0; let b = 0; let a = 0;
            for (let sy = 0; sy < supersample; sy += 1) {
                for (let sx = 0; sx < supersample; sx += 1) {
                    const x = px + (sx + 0.5) / supersample;
                    const y = py + (sy + 0.5) / supersample;
                    const inPlate = roundedRectSdf(x, y, size / 2, size / 2, half, half, plate.radius) <= 0;
                    if (!inPlate) continue;
                    const v = (y / size);
                    let cr = lerp(plateTop[0], plateBottom[0], v);
                    let cg = lerp(plateTop[1], plateBottom[1], v);
                    let cb = lerp(plateTop[2], plateBottom[2], v);
                    const gp = t.toGlyph(x, y);
                    let inGlyph = moonSdf(gp.x, gp.y) <= 0 || horizonSdf(gp.x, gp.y) <= 0;
                    if (withArc && arcSdf(gp.x, gp.y) <= 0) inGlyph = true;
                    if (inGlyph) {
                        const gv = (gp.y - 3) / 18;
                        cr = lerp(inkTop[0], inkBottom[0], gv);
                        cg = lerp(inkTop[1], inkBottom[1], gv);
                        cb = lerp(inkTop[2], inkBottom[2], gv);
                    }
                    r += cr; g += cg; b += cb; a += 255;
                }
            }
            const i = (py * size + px) * 4;
            // 颜色按覆盖率归一，alpha 保留覆盖率（边缘才平滑）
            const cov = a * inv / 255;
            buf[i] = cov > 0 ? Math.round(r / (a / 255)) : 0;
            buf[i + 1] = cov > 0 ? Math.round(g / (a / 255)) : 0;
            buf[i + 2] = cov > 0 ? Math.round(b / (a / 255)) : 0;
            buf[i + 3] = Math.round(a * inv);
        }
    }
    return buf;
}

// ---------------------------------------------------------------- 最小 PNG 编码器（zlib 是内置的）

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type: RGBA
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filter
    ihdr[12] = 0;  // no interlace
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0; // filter: None
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 解析 PNG 头，返回尺寸（给测试用，避免装图片库） */
export function readPngSize(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} 不是 PNG`);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, colorType: buf[25] };
}

// ---------------------------------------------------------------- CLI

function main() {
    const argv = process.argv.slice(2);
    const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
    if (argv.includes('--check')) {
        const file = arg('check');
        const info = readPngSize(file);
        console.log(JSON.stringify(info));
        return;
    }
    const out = path.resolve(arg('out', DEFAULT_OUT));
    const size = Number(arg('size', String(ICON_SIZE)));
    const withArc = argv.includes('--with-arc');
    const t0 = Date.now();
    const rgba = renderIcon(size, 3, withArc);
    fs.writeFileSync(out, encodePng(size, size, rgba));
    const info = readPngSize(out);
    console.log(`✓ 图标源图：${out}（${info.width}×${info.height}，${(info.bytes / 1024).toFixed(0)} KiB，${Date.now() - t0}ms）`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    try { main(); } catch (err) { console.error(`✗ 图标生成失败：${err.message}`); process.exit(1); }
}
