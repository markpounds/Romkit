'use strict';
/**
 * CRC32 计算：优先使用 Node 内置 zlib.crc32（v22.2+ 原生实现），
 * 退回纯 JS 查表实现，保证在旧运行时也能工作。
 */
const zlib = require('node:zlib');
const fs = require('node:fs');

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[i] = c;
  }
  return TABLE;
}

function crc32Fallback(buf, prev = 0) {
  const t = table();
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const native = typeof zlib.crc32 === 'function';

/** 累积计算一段 buffer 的 CRC32（可链式：crc = crc32(chunk, crc)） */
function crc32(buf, prev = 0) {
  if (native) {
    try {
      return zlib.crc32(buf, prev) >>> 0;
    } catch (_) {
      /* fallthrough */
    }
  }
  return crc32Fallback(buf, prev);
}

/** 流式计算整个文件的 CRC32（16 进制大写，8 位） */
function crc32FileHex(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    let read = 0;
    const rs = fs.createReadStream(filePath, { highWaterMark: 4 << 20 });
    rs.on('data', (chunk) => {
      crc = crc32(chunk, crc);
      read += chunk.length;
      if (onProgress) onProgress(read);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve(toHex(crc)));
  });
}

function toHex(n) {
  return (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function normalizeHex(s) {
  if (!s) return '';
  return String(s).trim().toUpperCase().replace(/^0X/, '').padStart(8, '0').slice(-8);
}

module.exports = { crc32, crc32FileHex, toHex, normalizeHex, usingNative: native };
