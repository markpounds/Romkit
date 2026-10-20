'use strict';
/**
 * ROMKit fnOS 应用图标生成器（纯代码绘制，零依赖）
 * 设计：圆角方形 + 靛蓝→紫罗兰对角渐变底 + 白色游戏手柄剪影
 * 输出（4 倍超采样抗锯齿，精确尺寸）：
 *   fnos/ICON.PNG            64x64   应用中心图标
 *   fnos/ICON_256.PNG        256x256 应用中心大图标
 *   fnos/app/ui/images/icon_64.png   64x64   桌面入口图标
 *   fnos/app/ui/images/icon_256.png  256x256 桌面入口大图标
 * 用法：node tools/gen-fnos-icons.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SS = 4; // 超采样倍数

// ---------------------------------------------------------------- PNG 编码
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- SDF 工具
// 圆角矩形：中心(cx,cy)，半宽 hw，半高 hh，圆角 r
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(px, py, cx, cy, r) { return Math.hypot(px - cx, py - cy) - r; }
// 抗锯齿覆盖度：smoothstep，d<0 全内，d>0 全外
function cov(d, feather) {
  const x = Math.max(0, Math.min(1, 0.5 - d / feather));
  return x * x * (3 - 2 * x);
}
// 十字（D-pad）：两棒半宽 bw，半长 bl
function inCross(px, py, cx, cy, bw, bl) {
  const hx = Math.abs(px - cx) <= bw && Math.abs(py - cy) <= bl;
  const vy = Math.abs(py - cy) <= bw && Math.abs(px - cx) <= bl;
  return hx || vy;
}

// ---------------------------------------------------------------- 绘制
function drawIcon(size) {
  const W = size * SS, H = size * SS;
  const px = (x) => x * W; // 归一化坐标（0~1）→ 像素
  // 手柄几何（归一化）
  const GP = { cx: 0.5, cy: 0.52, hw: 0.27, hh: 0.155, r: 0.09 };
  const feather = 1.2 * SS;
  const out = Buffer.alloc(W * H * 4);

  // 渐变端色
  const C1 = [0x63, 0x66, 0xf1]; // indigo-500  #6366f1
  const C2 = [0x8b, 0x5c, 0xf6]; // violet-500 #8b5cf6
  const C3 = [0x4f, 0x46, 0xe5]; // indigo-600 加深亮部

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x + 0.5) / W, ny = (y + 0.5) / H;
      const i = (y * W + x) * 4;

      // --- 圆角方形底板 ---
      const dBg = sdRoundRect(x + 0.5, y + 0.5, W / 2, H / 2, W / 2, H / 2, W * 0.225);
      const aBg = cov(dBg, feather);
      if (aBg <= 0) { out[i + 3] = 0; continue; }

      // --- 渐变：对角混合，加一道左上高光 ---
      let t = (nx + ny) / 2;
      let col = [
        C1[0] + (C2[0] - C1[0]) * t,
        C1[1] + (C2[1] - C1[1]) * t,
        C1[2] + (C2[2] - C1[2]) * t,
      ];
      const hl = Math.max(0, 1 - Math.hypot(nx - 0.28, ny - 0.18) / 0.55) * 0.16;
      col = col.map((v) => Math.min(255, v + 255 * hl));

      // --- 手柄剪影（白）---
      let aFg = 0;
      // 机身
      aFg = Math.max(aFg, cov(sdRoundRect(x + 0.5, y + 0.5,
        px(GP.cx), px(GP.cy), px(GP.hw), px(GP.hh), px(GP.r)), feather));
      // 左右握把：机身下方两个小圆角突起
      for (const sx of [-1, 1]) {
        const gx = px(GP.cx) + sx * px(GP.hw * 0.60);
        const gy = px(GP.cy) + px(GP.hh * 0.62);
        aFg = Math.max(aFg, cov(sdRoundRect(x + 0.5, y + 0.5, gx, gy,
          px(GP.hw * 0.30), px(GP.hh * 0.55), px(0.055)), feather));
      }
      // 十字键
      const dpX = px(GP.cx) - px(GP.hw * 0.48), dpY = px(GP.cy);
      if (inCross(x + 0.5, y + 0.5, dpX, dpY, px(0.020), px(0.062))) aFg = 1;
      // 右侧双按钮（菱形排布，保持在机身内）
      for (const [bx, by] of [[0.40, -0.30], [0.62, 0.30]]) {
        aFg = Math.max(aFg, cov(sdCircle(x + 0.5, y + 0.5,
          px(GP.cx) + px(GP.hw * bx * 1.35), px(GP.cy) + px(GP.hh * by * 2.1), px(0.024)), feather));
      }
      // 顶部双肩键小横条
      for (const sx of [-1, 1]) {
        aFg = Math.max(aFg, cov(sdRoundRect(x + 0.5, y + 0.5,
          px(GP.cx) + sx * px(GP.hw * 0.42), px(GP.cy) - px(GP.hh * 1.02),
          px(0.045), px(0.014), px(0.010)), feather));
      }

      // --- 合成 ---
      const a = aBg;
      const r = col[0] * (1 - aFg) + 255 * aFg;
      const g = col[1] * (1 - aFg) + 255 * aFg;
      const b = col[2] * (1 - aFg) + 255 * aFg;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a * 255;
    }
  }

  // 4x 盒式降采样到目标尺寸
  const dst = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += out[i]; g += out[i + 1]; b += out[i + 2]; a += out[i + 3];
        }
      }
      const n = SS * SS, j = (y * size + x) * 4;
      dst[j] = Math.round(r / n); dst[j + 1] = Math.round(g / n);
      dst[j + 2] = Math.round(b / n); dst[j + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, dst);
}

// ---------------------------------------------------------------- 输出
const targets = [
  [path.join(ROOT, 'fnos', 'ICON.PNG'), 64],
  [path.join(ROOT, 'fnos', 'ICON_256.PNG'), 256],
  [path.join(ROOT, 'fnos', 'app', 'ui', 'images', 'icon_64.png'), 64],
  [path.join(ROOT, 'fnos', 'app', 'ui', 'images', 'icon_256.png'), 256],
];
for (const [file, size] of targets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, drawIcon(size));
  console.log('生成', path.relative(ROOT, file), `${size}x${size}`);
}
console.log('图标生成完成');
