'use strict';
/**
 * 零依赖 ZIP 读写实现（够用即可，聚焦模拟器 ROM 场景）
 *  - 读：中央目录解析，支持 ZIP64、store / deflate 解压，非 UTF-8 文件名回退 GBK
 *  - 写：单条目标准 zip，store 与 deflate 两种方式，支持 ZIP64（>4GB 单文件）
 *
 * 设计取舍：写 zip 一律使用标准 local header（不使用 data descriptor），
 * 保证 OfflineList 这类 2007 年的老程序以及各类模拟器前端都能正常读取。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { crc32 } = require('./crc32');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const ALREADY_COMPRESSED = new Set([
  '.chd', '.cso', '.zso', '.7z', '.rar', '.zip', '.gz', '.bz2', '.xz', '.rvz', '.wbfs', '.iso.mp3', '.nsp', '.xci',
]);

function decodeName(buf, flags) {
  if (flags & 0x800) {
    return buf.toString('utf8');
  }
  // 中文 zip 常见 GBK 编码；先用 utf8 试，出现替换字符再用 gbk
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (_) {
    return buf.toString('latin1');
  }
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

function parseZip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const end = Math.min(q + size, extra.length);
      if (entry.uncompSize === 0xffffffff && q + 8 <= end) { entry.uncompSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.compSize === 0xffffffff && q + 8 <= end) { entry.compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.localOffset === 0xffffffff && q + 8 <= end) { entry.localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
      return;
    }
    p += 4 + size;
  }
}

/** 读取 zip 中央目录，返回条目列表 */
async function listEntries(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('文件太小，不是有效的 zip');
    const tailLen = Math.min(size, 66000);
    const tailPos = size - tailLen;
    const tail = await readAt(fh, tailPos, tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('未找到 zip 目录结构（可能不是 zip）');

    let entryCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    const eocdAbs = tailPos + eocd;

    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = eocdAbs - 20;
      if (locPos >= 0) {
        const loc = await readAt(fh, locPos, 20);
        if (loc.length === 20 && loc.readUInt32LE(0) === SIG_EOCD64_LOC) {
          const z64Pos = Number(loc.readBigUInt64LE(8));
          const z64 = await readAt(fh, z64Pos, 56);
          if (z64.length >= 56 && z64.readUInt32LE(0) === SIG_EOCD64) {
            entryCount = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
          }
        }
      }
    }

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL) {
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const entry = {
        name: decodeName(cd.subarray(p + 46, p + 46 + nameLen), flags),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16).toString(16).toUpperCase().padStart(8, '0'),
        compSize: cd.readUInt32LE(p + 20),
        uncompSize: cd.readUInt32LE(p + 24),
        flags,
        localOffset: cd.readUInt32LE(p + 42),
        isDir: false,
      };
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (extraLen) parseZip64Extra(extra, entry);
      entry.isDir = entry.name.endsWith('/');
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** 计算条目数据区在文件中的绝对起始偏移 */
async function dataOffsetOf(fh, entry) {
  const hdr = await readAt(fh, entry.localOffset, 30);
  if (hdr.length < 30 || hdr.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error('zip 局部头损坏: ' + entry.name);
  }
  const nameLen = hdr.readUInt16LE(26);
  const extraLen = hdr.readUInt16LE(28);
  return entry.localOffset + 30 + nameLen + extraLen;
}

/** 解压单个条目到目标文件 */
async function extractEntry(zipPath, entry, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const fh = await fsp.open(zipPath, 'r');
  let start;
  try {
    start = await dataOffsetOf(fh, entry);
  } finally {
    await fh.close();
  }
  const end = start + entry.compSize - 1;
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(zipPath, { start, end, highWaterMark: 1 << 22 });
    const ws = fs.createWriteStream(destPath);
    const done = (err) => (err ? reject(err) : resolve(destPath));
    ws.on('error', done);
    ws.on('finish', () => done(null));
    if (entry.method === 0) {
      rs.on('error', done);
      rs.pipe(ws);
    } else if (entry.method === 8) {
      const inf = zlib.createInflateRaw();
      rs.on('error', (e) => inf.destroy(e));
      inf.on('error', done);
      rs.pipe(inf).pipe(ws);
    } else {
      rs.destroy();
      done(new Error('不支持的压缩方式 method=' + entry.method + '（' + entry.name + '）'));
    }
  });
}

/** 读取条目到内存（仅用于小文件，如 DAT 里的 xml） */
async function readEntryBuffer(zipPath, entry, maxBytes = 256 << 20) {
  if (entry.uncompSize > maxBytes) throw new Error('条目过大，拒绝读入内存');
  const fh = await fsp.open(zipPath, 'r');
  let start;
  try {
    start = await dataOffsetOf(fh, entry);
  } finally {
    await fh.close();
  }
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    const rs = fs.createReadStream(zipPath, { start, end: start + entry.compSize - 1 });
    const src = entry.method === 8 ? rs.pipe(zlib.createInflateRaw()) : rs;
    src.on('data', (c) => chunks.push(c));
    src.on('error', reject);
    src.on('end', () => resolve(Buffer.concat(chunks)));
  });
  return raw;
}

function zip64Extra(fields) {
  // fields: {uncompSize?, compSize?, localOffset?}
  const parts = [];
  if (fields.uncompSize !== undefined) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(fields.uncompSize)); parts.push(b); }
  if (fields.compSize !== undefined) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(fields.compSize)); parts.push(b); }
  if (fields.localOffset !== undefined) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(fields.localOffset)); parts.push(b); }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(4);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 把单个文件打包成 zip（zip 内只有这一个条目）
 * @param {string} srcPath 源文件
 * @param {string} destZip 目标 zip
 * @param {object} opts {entryName, compress, onProgress}
 */
async function packFile(srcPath, destZip, opts = {}) {
  const entryName = opts.entryName || path.basename(srcPath);
  const stat = await fsp.stat(srcPath);
  const rawSize = stat.size;
  const ext = path.extname(entryName).toLowerCase();
  const wantCompress = opts.compress !== false && rawSize <= 128 * 1024 * 1024 && !ALREADY_COMPRESSED.has(ext);
  await fsp.mkdir(path.dirname(destZip), { recursive: true });

  const isZip64 = rawSize >= 0xffffffff;
  const { time, date } = dosDateTime(stat.mtime);
  const nameBuf = Buffer.from(entryName, 'utf8');

  let payload;
  let method;
  if (wantCompress) {
    const data = await fsp.readFile(srcPath);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    if (compressed.length < data.length) {
      payload = compressed;
      method = 8;
      const crcNum = crc32(data);
      const crcHex = (crcNum >>> 0).toString(16).toUpperCase().padStart(8, '0');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crcNum >>> 0, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      await fsp.writeFile(destZip, Buffer.concat([local, nameBuf, payload, buildCentral({
        entryName, crcHex, compSize: payload.length, uncompSize: data.length, method: 8,
        localOffset: 0, centralOffset: 30 + nameBuf.length + payload.length, flags: 0x800, time, date,
      })]));
      return { ok: true, method: 'deflate', entryName, rawSize, zipSize: 30 + nameBuf.length + payload.length };
    }
  }

  // store 模式：先写占位头，流式复制并同步计算 CRC，最后回填头部（只读一次文件）
  method = 0;
  const fh = await fsp.open(destZip, 'w');
  try {
    const extra = isZip64 ? zip64Extra({ uncompSize: rawSize, compSize: rawSize }) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(isZip64 ? 45 : 20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(isZip64 ? 0xffffffff : 0, 18);
    header.writeUInt32LE(isZip64 ? 0xffffffff : 0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);

    let pos = 0;
    const writeAt = async (buf) => {
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off, pos + off);
        off += bytesWritten;
      }
      pos += buf.length;
    };
    await writeAt(Buffer.concat([header, nameBuf, extra]));
    const dataStart = pos;

    let crc = 0;
    let read = 0;
    const rs = fs.createReadStream(srcPath, { highWaterMark: 4 << 20 });
    for await (const chunk of rs) {
      crc = crc32(chunk, crc);
      read += chunk.length;
      await writeAt(chunk);
      if (opts.onProgress) opts.onProgress(read, rawSize);
    }
    if (read !== rawSize) throw new Error('源文件读取长度不一致: ' + srcPath);

    const crcHex = (crc >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc >>> 0, 0);
    patch.writeUInt32LE(isZip64 ? 0xffffffff : read, 4);
    patch.writeUInt32LE(isZip64 ? 0xffffffff : read, 8);
    await fh.write(patch, 0, 12, 14);

    const central = buildCentral({
      entryName, crcHex, compSize: read, uncompSize: read, method: 0,
      localOffset: 0, centralOffset: pos, flags: 0x800, time, date,
    });
    await writeAt(central);
    return { ok: true, method: 'store', entryName, rawSize, zipSize: pos, dataStart };
  } finally {
    await fh.close();
  }
}

function buildCentral(e) {
  const nameBuf = Buffer.from(e.entryName, 'utf8');
  const localOffset = e.localOffset || 0;
  const centralOffset = e.centralOffset;
  const need64 = e.uncompSize >= 0xffffffff || e.compSize >= 0xffffffff || centralOffset >= 0xffffffff;
  const extra = need64
    ? zip64Extra({
        uncompSize: e.uncompSize >= 0xffffffff ? e.uncompSize : undefined,
        compSize: e.compSize >= 0xffffffff ? e.compSize : undefined,
        localOffset: undefined,
      })
    : Buffer.alloc(0);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(SIG_CENTRAL, 0);
  cd.writeUInt16LE(need64 ? 45 : 20, 4);
  cd.writeUInt16LE(need64 ? 45 : 20, 6);
  cd.writeUInt16LE(e.flags || 0x800, 8);
  cd.writeUInt16LE(e.method, 10);
  cd.writeUInt16LE(e.time, 12);
  cd.writeUInt16LE(e.date, 14);
  cd.writeUInt32LE(parseInt(e.crcHex, 16), 16);
  cd.writeUInt32LE(Math.min(e.compSize, 0xffffffff), 20);
  cd.writeUInt32LE(Math.min(e.uncompSize, 0xffffffff), 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(extra.length, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0x20, 38);
  cd.writeUInt32LE(Math.min(localOffset, 0xffffffff), 42);

  const cdOffset = centralOffset;
  const cdSize = 46 + nameBuf.length + extra.length;

  let tail;
  const needEocd64 = need64 || centralOffset + cdSize >= 0xffffffff;
  if (needEocd64) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(SIG_EOCD64, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeUInt32LE(0, 16);
    z64.writeUInt32LE(0, 20);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(cdSize), 40);
    z64.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG_EOCD64_LOC, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    tail = Buffer.concat([z64, loc]);
  } else {
    tail = Buffer.alloc(0);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(Math.min(cdOffset, 0xffffffff), 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([cd, nameBuf, extra, tail, eocd]);
}

/** 打开 zip 判断有效性 */
async function isZipFile(filePath) {
  try {
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = await readAt(fh, 0, 4);
      return buf.length === 4 && buf.readUInt32LE(0) === SIG_LOCAL;
    } finally {
      await fh.close();
    }
  } catch (_) {
    return false;
  }
}

module.exports = { listEntries, extractEntry, readEntryBuffer, packFile, isZipFile, ALREADY_COMPRESSED };
