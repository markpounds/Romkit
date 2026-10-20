'use strict';
/**
 * 封面 / 截图管理
 *
 * 三个来源，按优先级：
 *   1. cache   —— data/covers/<libId>/ 下由「手动上传」或「订阅下载」得到的图片
 *   2. local   —— 用户在设置里指定的本地截图目录（OfflineList 图片包解压后的目录）
 *   3. remote  —— DAT 里的 imURL + im1CRC，按需下载（需要联网）
 *
 * 文件名约定（对 OfflineList 图片包天然兼容）：
 *   {im1CRC}.png   ← OfflineList 标准命名
 *   g{index}.png   ← 本工具手动上传时的兜底命名
 *   {index}.png / {title}.png / {romCRC}.png 也会尝试
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

// libId -> { key, map: Map<index, {file, source}>, at }
const indexCache = new Map();

/** 封面存储目录：用户在设置里指定则用之，否则落在工具自己的 data/covers/<libId> */
function cacheDir(lib) {
  const custom = lib && lib.assets && lib.assets.cover && (lib.assets.cover.storeDir || '');
  if (custom && String(custom).trim()) return String(custom).trim();
  // 全局图片保存位置（飞牛安装向导 / 设置里配），默认 data/covers/<libId>
  return path.join(store.paths().coverDir, lib.id);
}

function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
}

/**
 * 某个游戏的候选文件名（不含扩展名），按优先级排列
 * slot: 'a' = 封面（im1CRC / {编号}a），'b' = 截图（im2CRC / {编号}b）
 */
function baseNames(game, slot = 'a') {
  const idx = game.imageNumber || game.index || 0;
  const out = [];
  if (slot === 'b') {
    if (game.im2CRC) out.push(game.im2CRC);
    if (idx) {
      out.push(idx + 'b');
      out.push(String(idx).padStart(4, '0') + 'b');
      out.push(String(idx).padStart(3, '0') + 'b');
    }
    return out.filter(Boolean);
  }
  if (game.im1CRC) out.push(game.im1CRC);
  if (idx) {
    // Romulus / OfflineList 图片包：{编号}a = 封面
    out.push(idx + 'a');
    out.push('g' + idx);
    out.push(String(idx).padStart(3, '0') + 'a');
    out.push(String(idx).padStart(4, '0') + 'a');
    out.push(String(idx).padStart(3, '0'));
    out.push(String(idx));
  }
  if (game.crcs && game.crcs[0]) out.push(game.crcs[0].crc);
  if (game.title) out.push(sanitizeName(game.title));
  if (game.comment) out.push(sanitizeName(game.comment));
  return out.filter(Boolean);
}

/** 在缓存目录里找 */
async function findInCache(lib, game, slot = 'a') {
  const dir = cacheDir(lib);
  for (const base of baseNames(game, slot).slice(0, 5)) {
    for (const ext of IMG_EXT) {
      const p = path.join(dir, base + ext);
      try {
        await fsp.access(p);
        return { file: p, source: 'cache' };
      } catch (_) {}
    }
  }
  return null;
}

/**
 * 扫描目录建立「文件名(小写) -> 完整路径」索引。
 * 递归向下（默认 3 层），因为 Romulus 等图片包会按编号分到 1-500、501-1000 这类子目录里。
 */
async function dirSet(root, maxDepth = 3) {
  const map = new Map();
  async function walk(dir, depth) {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (IMG_EXT.includes(path.extname(e.name).toLowerCase())) {
        const key = e.name.toLowerCase();
        if (!map.has(key)) map.set(key, full);
      }
    }
  }
  await walk(root, 0);
  return map.size ? map : null;
}

function findInSet(map, game, slot = 'a') {
  if (!map) return null;
  for (const base of baseNames(game, slot)) {
    for (const ext of IMG_EXT) {
      const p = map.get((base + ext).toLowerCase());
      if (p) return { file: p, source: 'local' };
    }
  }
  return null;
}

/**
 * 构建封面索引 { [gameIndex]: { source, file } }
 * 结果按 coverDir 的修改时间与库状态缓存 30 秒
 */
async function buildIndex(lib, dat, { force = false } = {}) {
  const coverDir = (lib.assets && lib.assets.cover && lib.assets.cover.dir) || '';
  const storeDir = cacheDir(lib);
  const key = [coverDir, storeDir, dat && dat.datVersion, dat && dat.games.length].join('|');
  const cached = indexCache.get(lib.id);
  if (!force && cached && cached.key === key && Date.now() - cached.at < 30000) return cached.map;

  // 各扫描一次目录，之后全部走内存索引，避免上万次 stat
  const storeSet = await dirSet(storeDir, 2);
  const localSet = coverDir ? await dirSet(coverDir, 3) : null;
  const map = new Map();
  const games = (dat && dat.games) || [];
  for (const g of games) {
    // 列表缩略图优先封面，没有封面时退回截图
    let hit = storeSet ? (findInSet(storeSet, g, 'a') || findInSet(storeSet, g, 'b')) : null;
    if (hit) hit.source = 'cache';
    if (!hit && localSet) hit = findInSet(localSet, g, 'a') || findInSet(localSet, g, 'b');
    if (hit) map.set(g.index, hit);
  }
  indexCache.set(lib.id, { key, map, at: Date.now() });
  return map;
}

function invalidate(libId) {
  indexCache.delete(libId);
}

/** 取单个游戏的某张图（slot: a=封面 b=截图） */
async function resolveSlot(lib, game, slot = 'a') {
  const hit = (await findInCache(lib, game, slot)) || null;
  if (hit) return hit;
  const coverDir = (lib.assets && lib.assets.cover && lib.assets.cover.dir) || '';
  if (!coverDir) return null;
  const set = await dirSet(coverDir, 3);
  return findInSet(set, game, slot);
}

async function resolveOne(lib, game) {
  return resolveSlot(lib, game, 'a');
}

/** 列出某个游戏可用的全部图片（封面 / 截图），供详情页切换 */
async function listSlots(lib, game) {
  const coverDir = (lib.assets && lib.assets.cover && lib.assets.cover.dir) || '';
  const storeSet = await dirSet(cacheDir(lib), 2);
  const localSet = coverDir ? await dirSet(coverDir, 3) : null;
  const find = (slot) => {
    let hit = storeSet ? findInSet(storeSet, game, slot) : null;
    if (hit) hit.source = 'cache';
    if (!hit && localSet) hit = findInSet(localSet, game, slot);
    return hit;
  };
  const out = [];
  const a = find('a');
  if (a) out.push({ slot: 'a', label: '封面', source: a.source, file: a.file });
  const b = find('b');
  if (b) out.push({ slot: 'b', label: '截图', source: b.source, file: b.file });
  return out;
}

/** 保存上传的图片 */
async function saveUpload(lib, game, buffer, filename) {
  const dir = cacheDir(lib);
  await fsp.mkdir(dir, { recursive: true });
  let ext = path.extname(filename || '').toLowerCase();
  if (!IMG_EXT.includes(ext)) ext = '.png';
  const base = game.im1CRC || ('g' + (game.imageNumber || game.index));
  // 清理同名的其他格式，避免索引命中旧图
  for (const e of IMG_EXT) {
    await fsp.rm(path.join(dir, base + e), { force: true }).catch(() => {});
    await fsp.rm(path.join(dir, 'g' + (game.imageNumber || game.index) + e), { force: true }).catch(() => {});
  }
  const file = path.join(dir, base + ext);
  await fsp.writeFile(file, buffer);
  invalidate(lib.id);
  return file;
}

async function removeCover(lib, game) {
  const dir = cacheDir(lib);
  let removed = 0;
  for (const base of ['g' + (game.imageNumber || game.index), game.im1CRC].filter(Boolean)) {
    for (const e of IMG_EXT) {
      const p = path.join(dir, base + e);
      try {
        await fsp.rm(p, { force: true });
        removed++;
      } catch (_) {}
    }
  }
  invalidate(lib.id);
  return removed;
}

async function fetchOne(url, timeoutMs = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ROMKit/1.3',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
        // 部分图片站有防盗链，带上来源页
        Referer: new URL(url).origin + '/',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) throw new Error('图片内容为空');
    // 用文件头判断真实类型，比 content-type 可靠
    let ext = null;
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
    else if (buf[0] === 0x47 && buf[1] === 0x49) ext = '.gif';
    else if (buf.subarray(8, 12).toString('ascii') === 'WEBP') ext = '.webp';
    if (!ext) throw new Error('返回内容不是图片（可能是 403/404 页面）');
    return { buf, ext };
  } finally {
    clearTimeout(t);
  }
}

/** 图片按编号分目录：1-500 / 501-1000 / …（与 Romulus、emugif 的图包结构一致） */
function rangeFolder(idx) {
  const start = Math.floor((Math.max(1, idx) - 1) / 500) * 500 + 1;
  return `${start}-${start + 499}`;
}

/**
 * 生成候选图片地址。
 * 实测可用的规则（emugif）：
 *   https://dat.emugif.com/img/gg/{区间}/{编号}a.png?crc={im1CRC}
 * 其余为兼容备用（旧式扁平命名、无 crc 参数等）。
 */
function candidateUrls(base, game) {
  const idx = game.imageNumber || game.index || 0;
  const crc = game.im1CRC || '';
  const bases = [];
  if (/^http:\/\//i.test(base)) bases.push(base.replace(/^http:\/\//i, 'https://'));
  bases.push(base);

  const out = [];
  const crcQ = crc ? '?crc=' + crc : '';
  // 1) 主规则：https 优先
  if (idx) {
    for (const b of bases) out.push(`${b}${rangeFolder(idx)}/${idx}a.png${crcQ}`);
  }
  // 2) 备用：同目录下的无参形式 / 编号命名
  if (idx) {
    for (const b of bases) {
      out.push(`${b}${rangeFolder(idx)}/${idx}a.png`);
      out.push(`${b}${rangeFolder(idx)}/${idx}.png`);
    }
  }
  // 3) 兼容旧式扁平命名
  for (const b of bases) {
    if (crc) out.push(`${b}${crc}.png`);
    if (idx) out.push(`${b}${idx}a.png`);
  }
  return [...new Set(out)];
}

/**
 * 批量下载缺失封面（来自 DAT 的 imURL 订阅源）
 * @returns {{ok:number, fail:number, skipped:number, errors:[]}}
 */
async function fetchMissing(lib, dat, { onProgress = () => {}, isCancelled = () => false, concurrency = 4 } = {}) {
  const imURL = (dat.newDat && dat.newDat.imURL) || '';
  if (!imURL) throw new Error('该 DAT 没有提供图片地址（imURL）');
  const base = imURL.endsWith('/') ? imURL : imURL + '/';
  const games = dat.games.filter((g) => g.im1CRC);
  const dir = cacheDir(lib);
  await fsp.mkdir(dir, { recursive: true });
  // 先扫一次本地图片目录：已经有图的直接跳过，不浪费网络请求
  const coverDir = (lib.assets && lib.assets.cover && lib.assets.cover.dir) || '';
  const localSet = coverDir ? await dirSet(coverDir, 3) : null;

  const stat = { ok: 0, fail: 0, skipped: 0, errors: [], aborted: false };
  let done = 0;
  let streak = 0; // 连续失败计数：源站整体不通时尽早收手
  const total = games.length;
  const queue = [...games];

  const worker = async () => {
    for (;;) {
      if (isCancelled() || stat.aborted) return;
      const g = queue.shift();
      if (!g) return;
      done++;
      onProgress({ phase: 'cover', message: `下载封面 ${done}/${total}`, current: done, total, ok: stat.ok, fail: stat.fail });
      const exists = (await findInCache(lib, g))
        || (localSet ? (findInSet(localSet, g, 'a') || findInSet(localSet, g, 'b')) : null);
      if (exists) { stat.skipped++; streak = 0; continue; }

      const urls = candidateUrls(base, g);
      let saved = false;
      let lastErr = null;
      for (const url of urls) {
        if (isCancelled() || stat.aborted) break;
        try {
          const { buf, ext } = await fetchOne(url);
          await fsp.writeFile(path.join(dir, g.im1CRC + ext), buf);
          stat.ok++;
          streak = 0;
          saved = true;
          break;
        } catch (e) {
          lastErr = e;
          if (e.name === 'AbortError' || /abort/i.test(e.name || '')) break;
        }
      }
      if (!saved) {
        stat.fail++;
        streak++;
        if (stat.errors.length < 20) {
          stat.errors.push({
            title: g.title,
            url: urls[0],
            error: lastErr ? lastErr.message : '未知错误',
            tried: urls.length,
          });
        }
        // 前 12 个全部失败且一个都没成功 → 判定源站不可用，停止
        if (stat.ok === 0 && streak >= 12) {
          stat.aborted = true;
          stat.abortReason = '连续 ' + streak + ' 个游戏都下载失败，已停止（源站可能已变更或无此图片）';
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  invalidate(lib.id);
  return stat;
}

/**
 * 探测某个游戏的图片地址：把候选规则逐个打一遍，返回每个 URL 的实际结果。
 * 用于排查"源站到底有没有图/该用哪种命名"。
 */
async function probe(lib, dat, game) {
  const imURL = (dat.newDat && dat.newDat.imURL) || '';
  if (!imURL) throw new Error('该 DAT 没有提供图片地址（imURL）');
  const base = imURL.endsWith('/') ? imURL : imURL + '/';
  const urls = candidateUrls(base, game).slice(0, 10);
  const results = [];
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const { buf, ext } = await fetchOne(url, 5000);
      results.push({ url, ok: true, bytes: buf.length, ext, ms: Date.now() - t0 });
      break;
    } catch (e) {
      results.push({ url, ok: false, status: e.status || 0, error: e.message, ms: Date.now() - t0 });
    }
  }
  return {
    game: { index: game.index, title: game.title, im1CRC: game.im1CRC },
    base,
    results,
  };
}

module.exports = {
  buildIndex, resolveOne, resolveSlot, listSlots, saveUpload, removeCover, fetchMissing, probe,
  invalidate, cacheDir, cacheDirFor: cacheDir, MIME, IMG_EXT,
};
