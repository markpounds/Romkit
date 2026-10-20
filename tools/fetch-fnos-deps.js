'use strict';
/**
 * 下载 fnOS 打包依赖（幂等，已存在则跳过）：
 *   dist/dl/fnpack.exe               fnpack 1.2.3 Windows 版
 *   dist/dl/node-linux-x64.tar.xz    Node 22 LTS linux-x64
 *   dist/dl/node-linux-arm64.tar.xz  Node 22 LTS linux-arm64
 * 用法：node tools/fetch-fnos-deps.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DL_DIR = path.join(ROOT, 'dist', 'dl');
const NODE_VER = '22.22.2';

const FILES = [
  ['fnpack.exe', `https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64`],
  ['node-linux-x64.tar.xz', `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz`],
  ['node-linux-arm64.tar.xz', `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-arm64.tar.xz`],
];

async function download(url, dest) {
  console.log(`下载 ${path.basename(dest)} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const buf = Buffer.from(await res.arrayBuffer());
  if (total && buf.length !== total) throw new Error(`大小不符：${buf.length} != ${total}`);
  fs.writeFileSync(dest, buf);
  console.log(`  -> ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  fs.mkdirSync(DL_DIR, { recursive: true });
  for (const [name, url] of FILES) {
    const dest = path.join(DL_DIR, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
      console.log(`已存在，跳过：${name}`);
      continue;
    }
    await download(url, dest);
  }
  console.log('依赖就绪。后续执行 node tools/build-fnos.js 打包 fpk。');
}

main().catch((e) => { console.error('下载失败：', e.message); process.exit(1); });
