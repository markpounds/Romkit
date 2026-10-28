'use strict';
/**
 * ROMKit 本地服务（零依赖）
 *   - 静态资源：web/
 *   - REST API：/api/*
 *   - SSE 进度推送：/api/events
 * 只监听 127.0.0.1，不对外暴露。
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const store = require('./lib/store');
const { loadDatFile, parseDatXml, normalizeKey } = require('./lib/dat');
const { scanLibrary, crcKey } = require('./lib/scanner');
const { crc32FileHex } = require('./lib/crc32');
const { buildPlan, executePlan, buildClassifyPlan, sanitize } = require('./lib/organizer');
const { checkUpdate, downloadDat } = require('./lib/updater');
const covers = require('./lib/covers');
const naming = require('./lib/naming');
const overrides = require('./lib/overrides');
const emugif = require('./lib/emugif');
const csvdat = require('./lib/csvdat');

const WEB_DIR = path.join(__dirname, 'web');
/** 单文件发行版支持：构建脚本会把 web/ 内嵌为 globalThis.__ROMKIT_WEB__（rel -> Buffer） */
const WEB_EMBED = (typeof globalThis !== 'undefined' && globalThis.__ROMKIT_WEB__) || null;
/** 监听地址：默认仅本机（安全）；NAS 等场景可用 ROMKIT_HOST=0.0.0.0 开放局域网 */
const HOST = process.env.ROMKIT_HOST || '127.0.0.1';
const VERSION = '2.20.0';
// 进程 umask：飞牛/NAS 等服务环境下可能默认 077，会让 ROMKit 整理出来的
// 文件（0600）和目录（0700）对同机其他用户（含 SMB 共享）完全不可读，
// 表现为「整理完就打不开 / 扫描时报权限不足」。这里统一放宽到 022。
if (process.platform !== 'win32' && typeof process.umask === 'function') {
  try { process.umask(0o022); } catch (_) {}
}
const PORT_START = Number(process.env.ROMKIT_PORT || 8765);

// ---------------------------------------------------------------- 运行时状态
const runtime = new Map(); // libId -> { dat, rawDat, scan, conflicts }
overrides.setDataDirGetter(() => store.DATA_DIR);
emugif.setDataDirGetter(() => store.DATA_DIR);
const tasks = new Map();
const sseClients = new Set();

function logErr(...a) { console.error('[' + new Date().toLocaleTimeString() + ']', ...a); }

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

const EMPTY_PENDING = { total: 0, pending: 0, indexes: [] };

/**
 * 整理后回填 CRC 缓存：按文件名匹配的条目在整理时并不知道自己的 CRC，
 * 不回填的话，下次扫描只能重新读文件算 CRC——「整理后重扫变慢」的主因。
 * 只处理原始文件（zip 走中央目录，本来就不需要读内容），且已有缓存就跳过。
 */
async function warmCrcCache(plan) {
  let warmed = 0;
  for (const it of plan.items || []) {
    const dest = String(it.dest || '');
    if (!dest || dest.toLowerCase().endsWith('.zip')) continue;
    try {
      const st = await fsp.stat(dest);
      if (!st.isFile()) continue;
      const key = crcKey(dest, st.size, st.mtimeMs);
      if (store.cacheGet(key)) continue;
      const crc = await crc32FileHex(dest);
      store.cacheSet(key, crc);
      warmed++;
    } catch (_) {}
  }
  return warmed;
}

/**
 * 「待整理」统计：整理计划里，输出目录还没有成品的那些条目。
 * 判据是目标文件是否已存在——不能拿"源路径 ≠ 目标路径"来判断，
 * 因为 copy 模式下源文件会一直留在 ROM 目录里，那样永远显示待整理。
 * 没配输出目录、没扫描等情况返回空统计，不算错误。
 */
async function computePending(lib, scan, dat) {
  if (!scan) return { ...EMPTY_PENDING };
  try {
    const plan = await buildPlan(lib, scan, dat);
    const indexes = [];
    for (const it of plan.items) {
      const dst = String(it.dest || '');
      if (!dst) continue;
      const src = String(it.source && it.source.path || '');
      // 源就在目标位置上（整理模式为原地改名等）
      if (src && path.resolve(src) === path.resolve(dst)) continue;
      // 目标文件已存在 = 已经整理过
      let exists = false;
      try { await fsp.access(dst); exists = true; } catch (_) {}
      if (exists) continue;
      if (it.game && it.game.index !== undefined && !indexes.includes(it.game.index)) indexes.push(it.game.index);
    }
    return { total: plan.items.length, pending: indexes.length, indexes };
  } catch (_) {
    return { ...EMPTY_PENDING };
  }
}

/**
 * 取某个清单最近一次扫描的统计（games / owned），用于「是否已集齐」这类快速判断。
 * 优先内存，其次磁盘快照；都没有就返回 0，让调用方按「未知」处理。
 * 注意：这里刻意不加载 DAT —— 判断集齐不该付出解析整个 DAT 的代价。
 */
async function scanStatsOf(lib) {
  const rt = runtime.get(lib.id);
  if (rt && rt.scan && rt.scan.stats) return rt.scan.stats;
  try {
    const raw = await fsp.readFile(path.join(store.DATA_DIR, 'cache', lib.id + '.json'), 'utf8');
    const scan = JSON.parse(raw);
    if (scan && scan.stats) {
      // 顺手放进运行时，后面真正要建计划时省一次读盘
      const cur = runtime.get(lib.id);
      if (cur && !cur.scan) cur.scan = scan;
      return scan.stats;
    }
  } catch (_) {}
  return { games: 0, owned: 0 };
}

/**
 * DAT 内容指纹：版本 + 条目数 + 每条序号与 CRC。
 * 用来判断「更新 DAT」下载回来的东西和原来是不是同一份 ——
 * 一样就没必要把扫描结果作废重扫。
 */
function datSignature(dat) {
  if (!dat) return '';
  const h = crypto.createHash('sha1');
  h.update(String(dat.datVersion || ''));
  h.update('|' + (dat.games ? dat.games.length : 0));
  for (const g of dat.games || []) {
    h.update('|' + g.index + ':' + (g.crcs || []).map((c) => c.crc + c.extension).join(','));
  }
  return h.digest('hex');
}

function taskSnapshot(t) {
  const { id, kind, libraryId, status, progress, result, error, startedAt, finishedAt } = t;
  return { id, kind, libraryId, status, progress, result, error, startedAt, finishedAt };
}

function createTask(kind, libraryId, runner) {
  const id = crypto.randomUUID();
  const task = {
    id, kind, libraryId,
    status: 'running',
    progress: { phase: 'init', message: '准备中…', current: 0, total: 0 },
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    _cancelled: false,
  };
  tasks.set(id, task);
  broadcast('task', taskSnapshot(task));

  const setProgress = (p) => {
    task.progress = { ...task.progress, ...p };
    broadcast('task', taskSnapshot(task));
  };
  const isCancelled = () => task._cancelled;

  Promise.resolve()
    .then(() => runner({ setProgress, isCancelled }))
    .then((result) => {
      task.status = isCancelled() ? 'cancelled' : 'done';
      task.result = result || null;
      task.progress = { ...task.progress, phase: 'done', message: task.status === 'done' ? '完成' : '已取消' };
    })
    .catch((e) => {
      task.status = 'error';
      task.error = e.message || String(e);
      logErr(kind, e);
    })
    .finally(() => {
      task.finishedAt = new Date().toISOString();
      broadcast('task', taskSnapshot(task));
      // 只保留最近 30 个任务
      if (tasks.size > 30) {
        const first = tasks.keys().next().value;
        if (tasks.get(first).status !== 'running') tasks.delete(first);
      }
    });

  return task;
}

function cancelTask(id) {
  const t = tasks.get(id);
  if (t && t.status === 'running') {
    t._cancelled = true;
    t.progress = { ...t.progress, message: '正在停止…' };
    broadcast('task', taskSnapshot(t));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 库管理
function newLibraryId() {
  return 'lib_' + crypto.randomBytes(4).toString('hex');
}

/** 清理某个库的图标文件（按 libId 前缀兜底，设置里的引用可能已被清空） */
async function removeLibIcons(libId) {
  const dir = path.join(store.DATA_DIR, 'icons');
  try {
    const names = await fsp.readdir(dir);
    await Promise.all(names
      .filter((n) => n.startsWith(libId + '.'))
      .map((n) => fsp.unlink(path.join(dir, n)).catch(() => {})));
  } catch (_) { /* 目录不存在等情况忽略 */ }
}

function summarize(lib) {
  const rt = runtime.get(lib.id);
  const scan = rt && rt.scan;
  return {
    id: lib.id,
    name: lib.name,
    categoryId: lib.categoryId || '',
    ord: typeof lib.ord === 'number' ? lib.ord : 0,
    system: lib.system,
    datName: lib.datName,
    datVersion: lib.datVersion,
    datPath: lib.datPath,
    datContainer: lib.datContainer,
    extensions: lib.extensions || [],
    imFolder: lib.imFolder || '',
    romTitle: lib.romTitle || '',
    newDat: (lib.datConfig && lib.datConfig.newDat) || null,
    addedAt: lib.addedAt,
    // DAT 的更新时间：重新导入/在线更新时刷新；老配置没这字段就用导入时间兜底
    updatedAt: lib.updatedAt || lib.addedAt || null,
    settings: lib.settings,
    assets: lib.assets,
    error: lib.error || null,
    stats: scan
      ? { ...scan.stats, scannedAt: scan.scannedAt, elapsedMs: scan.elapsedMs }
      : { games: rt && rt.dat ? rt.dat.games.length : 0, owned: 0, scannedAt: null },
  };
}

/**
 * 把覆盖层套到原始 DAT 上，得到参与扫描/整理的条目表。
 * 注意 rt.dat 是**套用后**的，rt.rawDat 保留原始 —— 在线更新时比对指纹、
 * 判断"内容有没有变"必须用原始的，否则永远判成变了。
 */
async function applyOverrides(libId, rawDat) {
  try {
    const book = await overrides.load(libId);
    return overrides.apply(rawDat, book);
  } catch (e) {
    return { dat: rawDat, conflicts: [] };
  }
}

/** 归一化子条目修改：只保留有 index 且字段非空的 */
function normalizeChildren(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    const idx = Number(c && c.index);
    if (!Number.isFinite(idx)) continue;
    const fields = overrides.normalizeFields(c && c.fields);
    if (!Object.keys(fields).length) continue;
    out.push({ index: idx, fields });
  }
  return out;
}

/**
 * 按 index 找游戏；找不到时落到合并条目的子条目上。
 * 子条目的原编号已被合并「吃掉」，不在 games 列表里，
 * 但它们的封面/截图是按各自编号存的，必须能找到。
 */
function findGameOrChild(rt, index) {
  const games = (rt.dat && rt.dat.games) || [];
  const hit = games.find((g) => g.index === index);
  if (hit) return hit;
  for (const g of games) {
    const kid = (g.children || []).find((c) => c.index === index);
    if (kid) return { ...kid, children: undefined };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 站点数据（dat.emugif.com 的发布链接 + 发布说明）
 *
 * DAT 里没有这两个字段，只能从站点接口取。做法是：认出 DAT 的机种号
 * （datVersionURL 里的 ?ver=ps2），整表拉一次，按 ROM 的 CRC 建索引，
 * 之后取哪条都是内存查表。缓存按机种复用 —— 同一机种多个库只拉一次。
 * ------------------------------------------------------------------------ */
const siteCache = new Map(); // consoleType -> { payload, index, at }

async function siteIndexOf(dat, { allowFetch = false } = {}) {
  if (!dat) return null;
  const ct = emugif.consoleTypeOf(dat);
  if (!ct) return null;
  let e = siteCache.get(ct);
  if (e && allowFetch && Date.now() - e.at > emugif.TTL_MS) e = null;
  if (!e) {
    let payload = await emugif.readCache(ct);
    if (!payload && allowFetch) {
      try {
        payload = await emugif.fetchConsole(ct, true);
      } catch (err) {
        return { consoleType: ct, error: err.message };
      }
    }
    if (!payload) return { consoleType: ct, error: null, empty: true };
    e = { payload, index: emugif.buildIndex(payload), at: payload.fetchedAt || Date.now() };
    siteCache.set(ct, e);
  }
  return { consoleType: ct, payload: e.payload, index: e.index };
}

async function hydrateLibrary(lib, forceReload = false) {
  if (runtime.has(lib.id) && !forceReload) return runtime.get(lib.id);
  const rt = { dat: null, scan: null, error: null };
  try {
    const { dat } = await loadDatFile(lib.datPath);
    const applied = await applyOverrides(lib.id, dat);
    rt.rawDat = dat;
    rt.dat = applied.dat;
    rt.conflicts = applied.conflicts || [];
    lib.name = lib.name || dat.datName;
    lib.datVersion = dat.datVersion;
    lib.system = dat.system;
    lib.extensions = dat.extensions;
    // 文件夹型清单（每个游戏是一个目录、由一堆文件构成，如 PSV 已安装游戏）：
    // 没有单一「文件类型」，顶部「格式」栏显示「文件夹」而不是把所有扩展名铺开
    lib.folderType = dat.games.length > 0 && dat.games.every((g) => g.multiFile);
    lib.imFolder = dat.imFolder;
    lib.romTitle = dat.romTitle;
    lib.datName = dat.datName;
  } catch (e) {
    rt.error = e.message;
    lib.error = e.message;
  }
  runtime.set(lib.id, rt);
  return rt;
}

/**
 * 整理结束后，按执行结果增量更新内存里的扫描状态。
 * 这样不用把整库（动辄几十 GB）再读一遍 CRC，统计立刻就是准的。
 */
function applyOrganizeToScan(scan, result, romDir) {
  if (!scan || !Array.isArray(scan.games)) return;
  const gone = new Set();
  for (const e of result.log || []) {
    if (e.level !== 'ok' || !e.gameIndex) continue;
    const g = scan.games.find((x) => x.index === e.gameIndex);
    if (!g) continue;
    if (e.action === 'move-unmatched' || e.action === 'remove-duplicate' || e.action === 'delete-duplicate') {
      if (e.sourcePath) gone.add(e.sourcePath);
      continue;
    }
    if (e.action === 'already' || !e.dest) continue;
    for (const m of g.matches || []) {
      if (m.path === e.sourcePath) {
        m.path = e.dest;
        try { m.relPath = path.relative(romDir || '', e.dest); } catch (_) {}
      }
    }
  }
  for (const g of scan.games) {
    if (!Array.isArray(g.matches)) continue;
    if (gone.size) g.matches = g.matches.filter((m) => !gone.has(m.path));
    // 与扫描一致：同 CRC 的多个匹配只算一份，否则整理后会被误标成"多份副本"
    const distinct = new Set(g.matches.map((m) => (
      m.crc ? 'c:' + String(m.crc).toLowerCase() : 'p:' + m.path + '|' + (m.entryName || '')
    )));
    g.status = g.matches.length === 0 ? 'missing' : distinct.size > 1 ? 'duplicate' : 'owned';
  }
  const owned = scan.games.filter((g) => g.status !== 'missing').length;
  scan.stats = {
    ...scan.stats,
    owned,
    missing: scan.games.length - owned,
    duplicates: scan.games.filter((g) => g.status === 'duplicate').length,
  };
}

/** 版本号比较（按数字段逐段比，避免 20261019 这类大数溢出） */
function cmpVersion(a, b) {
  const norm = (v) => (String(v || '').match(/\d+/g) || []).map((n) => n.padStart(12, '0'));
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const s1 = x[i] || '';
    const s2 = y[i] || '';
    if (s1 !== s2) return s1 < s2 ? -1 : 1;
  }
  return 0;
}

/** 自建条目的独立编号（覆盖层里不引用原条目时用；900000 起，避开 DAT 正常编号区间） */
function nextStandaloneIndex(book) {
  let max = 900000;
  for (const e of (book && book.entries) || []) {
    if (!(e.sourceIndexes || []).length && Number(e.baseIndex) > max) max = Number(e.baseIndex);
  }
  return max + 1;
}

/**
 * 注册 DAT。
 * 如果已存在**名字完全相同**的 DAT，就比较版本号：
 *   新的更高 → 覆盖数据文件（保留该清单的 ROM 目录、模板等设置）
 *   新的相同或更低 → 丢弃，返回 skipped
 */
async function registerDat({ buffer, fileName, sourceLabel, origin }) {
  const dir = store.paths().datDir;
  await fsp.mkdir(dir, { recursive: true });
  const id = newLibraryId();
  const ext = path.extname(fileName || '').toLowerCase() === '.zip' ? '.zip' : '.xml';
  const datPath = path.join(dir, id + ext);
  await fsp.writeFile(datPath, buffer);

  const { dat, container } = await loadDatFile(datPath);

  // —— 同名 DAT 去重：留版本高的
  const dup = dat.datName
    ? store.listLibraries().find((l) => l.datName && l.datName === dat.datName)
    : null;
  if (dup) {
    const cmp = cmpVersion(dat.datVersion, dup.datVersion);
    if (cmp <= 0) {
      await fsp.rm(datPath, { force: true });
      return { library: dup, skipped: true, reason: 'older', existingVersion: dup.datVersion };
    }
    const oldPath = dup.datPath;
    const before = dup.datVersion;
    const newPath = path.join(dir, dup.id + ext);
    if (newPath !== datPath) await fsp.writeFile(newPath, buffer);
    if (oldPath && oldPath !== newPath) await fsp.rm(oldPath, { force: true }).catch(() => {});
    await fsp.rm(datPath, { force: true }).catch(() => {});
    dup.datVersion = dat.datVersion;
    dup.datPath = newPath;
    dup.datContainer = container;
    dup.extensions = dat.extensions;
    dup.imFolder = dat.imFolder;
    dup.romTitle = dat.romTitle;
    dup.datConfig = { newDat: dat.newDat, romTitle: dat.romTitle };
    dup.updatedAt = new Date().toISOString();
    dup.error = null;
    {
      const ap = await applyOverrides(dup.id, dat);
      // 版本变了，旧扫描结果作废；覆盖层重新套一遍
      runtime.set(dup.id, { dat: ap.dat, rawDat: dat, conflicts: ap.conflicts, scan: null, error: null });
    }
    await store.save();
    return { library: dup, replaced: true, oldVersion: before };
  }

  const lib = {
    id,
    name: dat.datName || path.basename(fileName || 'DAT', path.extname(fileName || '')),
    datName: dat.datName,
    system: dat.system,
    datVersion: dat.datVersion,
    datPath,
    datContainer: container,
    extensions: dat.extensions,
    imFolder: dat.imFolder,
    romTitle: dat.romTitle,
    datConfig: { newDat: dat.newDat, romTitle: dat.romTitle },
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    origin: { type: origin.type, label: sourceLabel, at: new Date().toISOString() },
    settings: { ...store.DEFAULT_SETTINGS },
    assets: JSON.parse(JSON.stringify(store.DEFAULT_ASSETS)),
    error: null,
  };
  store.addLibrary(lib);
  {
    const ap = await applyOverrides(id, dat);
    runtime.set(id, { dat: ap.dat, rawDat: dat, conflicts: ap.conflicts, scan: null, error: null });
  }
  await store.save();
  return { library: lib };
}

// ---------------------------------------------------------------- HTTP 工具
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 8 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('JSON 格式错误'); }
}

/** 命名预览用：补上扩展名（已带则不重复） */
function ensureExtSuffix(name, ext, isZip) {
  const s = String(name || '').trim();
  if (isZip) return /\.zip$/i.test(s) ? s : s + '.zip';
  if (!ext) return s;
  return s.toLowerCase().endsWith(ext.toLowerCase()) ? s : s + ext;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (WEB_EMBED) {
    const hit = WEB_EMBED[rel];
    if (hit) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(hit);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

// ---------------------------------------------------------------- API
// fnOS 的多路径环境变量用 `:` 分隔（Linux 路径不含冒号）；Windows 上路径自带盘符冒号，改用 `;`
function splitPaths(v) {
  if (!v) return [];
  const sep = process.platform === 'win32' ? ';' : ':';
  return v.split(sep).map((s) => s.trim()).filter(Boolean);
}

/**
 * 目录是否真的"进得去、读得到"。
 * fnOS 上授权目录是随时可变的（用户在应用中心添加/移除），而进程启动时拿到的
 * TRIM_DATA_ACCESSIBLE_PATHS 不会自己更新——所以每次列目录都实时探测一次，
 * 用户刚授权完立刻就能用，不用重启应用。
 */
async function canEnter(p) {
  try {
    await fsp.access(p, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// 目录选择器的根入口：Windows 罗列盘符；Linux/fnOS 罗列授权目录、共享、存储卷等
async function fsRoots() {
  const roots = [];
  const seen = new Set();
  const os = require('node:os');
  const add = async (p, name) => {
    if (!p || seen.has(p)) return;
    try { const st = await fsp.stat(p); if (!st.isDirectory()) return; } catch (_) { return; }
    seen.add(p);
    // 实时探测：进不去的目录照样列出来，但标成不可访问（点击时给出原因）
    roots.push({ name: name || path.basename(p) || p, path: p, ok: await canEnter(p) });
  };
  // fnOS：用户在「应用中心 → 授权目录」里授权的路径（应用进程可读写）
  for (const p of splitPaths(process.env.TRIM_DATA_ACCESSIBLE_PATHS)) {
    await add(p, '已授权 · ' + (path.basename(p) || p));
  }
  // fnOS：config/resource 声明的共享目录
  for (const p of splitPaths(process.env.TRIM_DATA_SHARE_PATHS)) {
    await add(p, '共享 · ' + (path.basename(p) || p));
  }
  // fnOS：存储空间 /vol1 ~ /vol8
  for (let i = 1; i <= 8; i++) await add('/vol' + i);
  if (process.env.TRIM_PKGVAR) await add(process.env.TRIM_PKGVAR, '应用数据目录');
  await add('/', '文件系统根目录 /');
  await add(os.homedir(), '主目录');
  return roots;
}

async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = req.method;
  const q = url.searchParams;

  // ---------- 某个游戏可用的图片列表：/api/covers/:libId/:index
  const mcovl = p.match(/^\/covers\/([\w-]+)\/(\d+)$/);
  if (mcovl && method === 'GET') {
    const lib = store.getLibrary(mcovl[1]);
    if (!lib) return json(res, 404, { error: '库不存在' });
    const rt = await hydrateLibrary(lib);
    const game = findGameOrChild(rt, parseInt(mcovl[2], 10));
    if (!game) return json(res, 404, { error: '游戏不存在' });
    const slots = await covers.listSlots(lib, game);
    return json(res, 200, {
      index: game.index,
      slots: slots.map((s) => ({ slot: s.slot, label: s.label, source: s.source })),
    });
  }

  // ---------- 封面图片：/api/cover/:libId/:index
  const mcov = p.match(/^\/cover\/([\w-]+)\/(\d+)$/);
  if (mcov) {
    const lib = store.getLibrary(mcov[1]);
    if (!lib) return json(res, 404, { error: '库不存在' });
    const rt = await hydrateLibrary(lib);
    const index = parseInt(mcov[2], 10);
    const game = findGameOrChild(rt, index);
    if (!game) return json(res, 404, { error: '游戏不存在' });

    if (method === 'GET') {
      const slot = q.get('slot') === 'b' ? 'b' : 'a';
      const hit = await covers.resolveSlot(lib, game, slot);
      if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no cover'); }
      const ext = path.extname(hit.file).toLowerCase();
      try {
        const stat = await fsp.stat(hit.file);
        res.writeHead(200, {
          'Content-Type': covers.MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
          'X-Cover-Source': hit.source,
        });
        fs.createReadStream(hit.file).pipe(res);
        return;
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (method === 'POST') {
      const buf = await readBody(req, 24 << 20);
      if (!buf.length) return json(res, 400, { error: '图片为空' });
      const file = await covers.saveUpload(lib, game, buf, q.get('name') || '');
      return json(res, 200, { ok: true, file });
    }

    if (method === 'DELETE') {
      const removed = await covers.removeCover(lib, game);
      return json(res, 200, { ok: true, removed });
    }
  }

  // ---------- B 站视频封面代理：/api/bili/cover/:bvid
  // B 站图片 CDN 有防盗链，前端 <img> 直连会被 403，必须由本机中转。
  // 抓下来按 BV 号缓存到磁盘，第二次直接回文件。
  const mbili = p.match(/^\/bili\/cover\/(BV[0-9A-Za-z]{10})$/);
  if (mbili && method === 'GET') {
    const bvid = mbili[1];
    const dir = path.join(store.DATA_DIR, 'cache', 'emugif', 'bv');
    const file = path.join(dir, bvid + '.bin');
    let buf = null;
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && st.size > 0) buf = await fsp.readFile(file);
    } catch (_) {}
    if (!buf) {
      try {
        buf = await emugif.fetchBiliCover(bvid);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(file, buf).catch(() => {});
      } catch (e) {
        return json(res, 404, { error: '拿不到 B 站封面：' + e.message });
      }
    }
    res.writeHead(200, {
      'Content-Type': emugif.sniffImg(buf) || 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'max-age=604800',
    });
    return res.end(buf);
  }

  // ---------- B 站视频信息（时长等）：/api/bili/info/:bvid
  // 嵌入式播放器不回传连续进度，前端用真实时长做估算进度条。
  const mbinfo = p.match(/^\/bili\/info\/(BV[0-9A-Za-z]{10})$/);
  if (mbinfo && method === 'GET') {
    const bvid = mbinfo[1];
    try {
      const info = await emugif.fetchBiliInfo(bvid);
      return json(res, 200, { duration: info.duration, bvid });
    } catch (e) {
      return json(res, 502, { error: '拿不到 B 站视频信息：' + e.message });
    }
  }

  // ---------- 状态
  if (p === '/state' && method === 'GET') {
    const libs = store.listLibraries();
    for (const lib of libs) await hydrateLibrary(lib);
    // 清单按分类树前序展开排序（子分类内容在前，父分类直属在后）
    const ordered = store.orderedLibraries();
    return json(res, 200, {
      version: VERSION,
      dataDir: store.DATA_DIR,
      paths: store.paths(),
      libraries: ordered.map(summarize),
      categories: store.listCategories(),
      tasks: [...tasks.values()].map(taskSnapshot).slice(-10),
      ui: store.getConfig().ui,
    });
  }

  // 单个任务状态（批量操作轮询用）
  const mtask = p.match(/^\/tasks\/([\w-]+)$/);
  if (mtask && method === 'GET') {
    const t = tasks.get(mtask[1]);
    if (!t) return json(res, 404, { error: '任务不存在' });
    return json(res, 200, { task: taskSnapshot(t) });
  }

  // ---------- 保存全局界面设置（如待分类文件夹）
  if (p === '/config/ui' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ui = store.getConfig().ui || (store.getConfig().ui = {});
    if (typeof body.inboxDir === 'string') ui.inboxDir = body.inboxDir.trim();
    await store.save();
    return json(res, 200, { ui: store.getConfig().ui });
  }

  // ---------- 全局存储位置（DAT / 图片）；数据目录由启动参数决定，改它要重启
  if (p === '/config/paths' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const paths = store.getConfig().paths || (store.getConfig().paths = {});
    for (const k of ['datDir', 'coverDir']) {
      if (typeof body[k] === 'string') paths[k] = body[k].trim();
    }
    await store.save();
    return json(res, 200, { paths: store.getConfig().paths, effective: store.paths() });
  }

  // ---------- 自动分类：把「待分类文件夹」里的文件按各清单规则归位
  if (p === '/classify' && method === 'POST') {
    const inbox = (store.getConfig().ui && store.getConfig().ui.inboxDir || '').trim();
    if (!inbox) return json(res, 400, { error: '请先在左侧设置「待分类文件夹」' });
    const stat = await fsp.stat(inbox).catch(() => null);
    if (!stat || !stat.isDirectory()) return json(res, 400, { error: '待分类文件夹不存在：' + inbox });

    const task = createTask('classify', null, async ({ setProgress, isCancelled }) => {
      const libs = store.listLibraries();

      // 先筛掉「已经全部拥有」的清单：它们不可能再收待分类文件夹里的新文件，
      // 却要为此把整个待分类夹遍历一遍并建计划（大库很贵）。
      // 拿不到扫描结果时按「未集齐」处理，宁可多跑也不漏。
      setProgress({ phase: 'classify', message: '正在筛选待匹配的清单…', current: 0, total: libs.length });
      const targets = [];
      let skippedComplete = 0;
      let skippedNoOut = 0;
      for (const lib of libs) {
        if (!lib.settings || !lib.settings.outDir) { skippedNoOut++; continue; }
        const stats = await scanStatsOf(lib);
        const games = stats.games || 0;
        const owned = stats.owned || 0;
        if (games > 0 && owned >= games) { skippedComplete++; continue; }
        targets.push(lib);
      }

      let moved = 0;
      let failed = 0;
      const errors = [];
      const report = [];
      for (let i = 0; i < targets.length; i++) {
        if (isCancelled()) break;
        const lib = targets[i];
        setProgress({
          phase: 'classify',
          message: `正在比对「${lib.name}」…（已跳过 ${skippedComplete} 个已集齐的清单）`,
          current: i + 1,
          total: targets.length,
        });
        const rt = await hydrateLibrary(lib);
        if (!rt.dat || !lib.settings.outDir) continue;
        let built;
        try {
          built = await buildClassifyPlan(lib, rt.dat, inbox);
        } catch (e) {
          errors.push(lib.name + '：' + e.message);
          continue;
        }
        if (!built.plan.items.length) continue;
        const r = await executePlan(lib, built.plan, {
          onProgress: setProgress,
          isCancelled,
          dryRun: false,
        });
        moved += r.done;
        failed += r.failed;
        report.push({ lib: lib.name, moved: r.done, failed: r.failed });
        if (r.errors && r.errors.length) errors.push(...r.errors.map((x) => x.title + '：' + x.error));
        // 归位后刷新该库状态，拥有数立刻可见
        try {
          rt.scan = await scanLibrary(lib, rt.dat, {});
          await fsp.writeFile(path.join(store.DATA_DIR, 'cache', lib.id + '.json'), JSON.stringify(rt.scan)).catch(() => {});
        } catch (_) {}
      }
      await store.saveCrcCache().catch(() => {});
      return {
        moved,
        failed,
        errors: errors.slice(0, 50),
        report,
        checked: targets.length,
        skippedComplete,
        skippedNoOut,
      };
    });
    return json(res, 200, { task: taskSnapshot(task) });
  }

  if (p === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // ---------- 添加 DAT：从本地文件路径
  if (p === '/libraries' && method === 'POST') {
    const body = await readJson(req);
    const src = (body.path || '').trim();
    if (!src) return json(res, 400, { error: '缺少 path' });
    const stat = await fsp.stat(src).catch(() => null);
    if (!stat || !stat.isFile()) return json(res, 400, { error: '文件不存在：' + src });
    const buffer = await fsp.readFile(src);
    const r = await registerDat({ buffer, fileName: path.basename(src), sourceLabel: src, origin: { type: 'local' } });
    return json(res, 200, { library: summarize(r.library), skipped: !!r.skipped, replaced: !!r.replaced, existingVersion: r.existingVersion || '', oldVersion: r.oldVersion || '' });
  }

  // ---------- 添加 DAT：浏览器拖拽上传（body 为文件二进制）
  if (p === '/libraries/import' && method === 'POST') {
    const name = sanitize(q.get('name') || 'uploaded.xml');
    const buffer = await readBody(req, 128 << 20);
    if (!buffer.length) return json(res, 400, { error: '文件为空' });
    const r = await registerDat({ buffer, fileName: name, sourceLabel: name, origin: { type: 'upload' } });
    return json(res, 200, { library: summarize(r.library), skipped: !!r.skipped, replaced: !!r.replaced, existingVersion: r.existingVersion || '', oldVersion: r.oldVersion || '' });
  }

  // ---------- CSV 模板下载（自带 BOM，Excel 直接打开不乱码）
  if (p === '/csv-template' && method === 'GET') {
    const body = Buffer.from('\ufeff' + csvdat.templateCsv(q.get('mode') === 'multi' ? 'multi' : ''), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="romkit-games-template.csv"',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  // ---------- 新建清单：导入 CSV 文件清单
  // body: { name?, system?, csv } 单份；或 { csvs: [{ name, text }] } 多份
  // （含「相对路径」列的清单 = 一个游戏多文件，适合已安装游戏的工具导出清单）
  if (p === '/libraries/from-csv' && method === 'POST') {
    const body = await readJson(req);
    const inputs = Array.isArray(body.csvs) && body.csvs.length
      ? body.csvs.map((c) => ({ label: String((c && c.name) || '').trim(), text: String((c && c.text) || '') }))
      : [{ label: '', text: String(body.csv || '') }];
    const games = [];
    const allErrors = [];
    const allWarnings = [];
    for (const { label, text } of inputs) {
      if (!text.trim()) continue;
      const parsed = csvdat.csvToGames(text);
      const tag = label ? `（${label}）` : '';
      for (const e of parsed.errors) allErrors.push(e + tag);
      for (const w of parsed.warnings) allWarnings.push(w + tag);
      for (const g of parsed.games) {
        if (!g.files || !g.files.length) continue;
        // 游戏名兜底：所属文件夹名（前端把 CSV 文件名传进来）→ CSV 文件名 → 「未命名」
        games.push({
          title: g.title || label.replace(/\.[^.]+$/, '') || '未命名游戏',
          comment: (g.info && g.info.comment) || '',
          publisher: (g.info && g.info.publisher) || '',
          location: (g.info && g.info.location) || '',
          language: (g.info && g.info.language) || '',
          saveType: (g.info && g.info.saveType) || '',
          files: g.files,
        });
      }
    }
    if (!games.length) {
      return json(res, 400, {
        error: allErrors[0] || '没有解析到任何条目',
        errors: allErrors, warnings: allWarnings,
      });
    }
    const name = String(body.name || '').trim() || 'CSV 清单';
    const xml = csvdat.buildDatXml({ datName: name, system: body.system, entries: games });
    const r = await registerDat({
      buffer: Buffer.from(xml, 'utf8'),
      fileName: sanitize(name) + '.xml',
      sourceLabel: 'CSV 导入',
      origin: { type: 'csv' },
    });
    if (r.library && !r.skipped && !r.replaced) {
      // 文件清单通常没有 CRC：这类库默认按「名称+大小」验证
      r.library.settings.matchMode = 'name-size';
      await store.save();
    }
    return json(res, 200, {
      library: summarize(r.library),
      skipped: !!r.skipped, replaced: !!r.replaced,
      stats: { total: games.length },
      errors: allErrors, warnings: allWarnings,
    });
  }

  // ---------- 新建清单：直接读服务器上的文件夹
  // body: { name?, system?, folder, recursive?, mode? }
  //   mode='files'（默认）：一个文件 = 一个游戏
  //   mode='games'：每个子文件夹 = 一个游戏（多文件条目，适合已安装游戏）
  if (p === '/libraries/from-folder' && method === 'POST') {
    const body = await readJson(req);
    const folder = String(body.folder || '').trim();
    if (!folder) return json(res, 400, { error: '缺少文件夹路径' });
    const st = await fsp.stat(folder).catch(() => null);
    if (!st || !st.isDirectory()) return json(res, 400, { error: '文件夹不存在：' + folder });
    const multi = body.mode === 'games';
    let games;
    let got;
    if (multi) {
      got = await csvdat.gamesFromFolder(folder);
      games = got.games.map((g) => ({
        title: g.title,
        comment: '', publisher: '', location: '', language: '', saveType: '',
        files: g.files,
      }));
    } else {
      got = await csvdat.entriesFromFolder(folder, { recursive: !!body.recursive });
      games = got.entries.map((e) => ({
        title: e.title, comment: '', publisher: '', location: '', language: '', saveType: '',
        files: [{ filename: e.sourceRom, name: '', size: e.romSize, crc: e.crc }],
      }));
    }
    if (!games.length) {
      return json(res, 400, {
        error: got.errors[0] || '文件夹里没有可识别的文件',
        errors: got.errors, warnings: got.warnings,
      });
    }
    const name = String(body.name || '').trim() || path.basename(folder);
    const xml = csvdat.buildDatXml({ datName: name, system: body.system, entries: games });
    const r = await registerDat({
      buffer: Buffer.from(xml, 'utf8'),
      fileName: sanitize(name) + '.xml',
      sourceLabel: folder,
      origin: { type: 'folder' },
    });
    if (r.library && !r.skipped && !r.replaced) {
      r.library.settings.matchMode = 'name-size';
      // ROM 目录顺手指过去，用户不用再填一遍
      if (!r.library.settings.romDir) r.library.settings.romDir = folder;
      await store.save();
    }
    return json(res, 200, {
      library: summarize(r.library),
      skipped: !!r.skipped, replaced: !!r.replaced,
      stats: { total: games.length },
      errors: got.errors, warnings: got.warnings,
    });
  }

  // ---------- 封面批量下载 / 命名预览（路径含两段，需先于通用库路由匹配）
  const mFix = p.match(/^\/libraries\/([\w-]+)\/(covers\/fetch|covers\/probe|preview-name)$/);
  if (mFix && method === 'POST') {
    const lib = store.getLibrary(mFix[1]);
    if (!lib) return json(res, 404, { error: '库不存在' });
    const rt = await hydrateLibrary(lib);
    if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });

    if (mFix[2] === 'covers/probe') {
      const body = await readJson(req);
      const withCrc = rt.dat.games.filter((g) => g.im1CRC);
      const game = rt.dat.games.find((g) => g.index === parseInt(body.index, 10)) || withCrc[0];
      if (!game) return json(res, 400, { error: '没有可用于测试的游戏' });
      try {
        const info = await covers.probe(lib, rt.dat, game);
        return json(res, 200, info);
      } catch (e) {
        return json(res, 200, { error: e.message, results: [] });
      }
    }

    if (mFix[2] === 'preview-name') {
      const body = await readJson(req);
      const game = rt.dat.games.find((g) => g.index === parseInt(body.index, 10)) || rt.dat.games[0];
      if (!game) return json(res, 400, { error: '没有可预览的游戏' });
      const ext = (body.ext || game.ext || (game.crcs[0] && game.crcs[0].extension) || '.bin');
      const fileName = naming.render(body.fileTemplate, game, { ext });
      const archiveName = naming.render(body.archiveTemplate, game, { ext });
      return json(res, 200, {
        game: { title: game.title, index: game.index, comment: game.comment },
        fileName: ensureExtSuffix(fileName, ext, false),
        entryName: ensureExtSuffix(fileName, ext, false),
        archiveName: ensureExtSuffix(archiveName, '.zip', true),
      });
    }

    const busy = [...tasks.values()].some((t) => t.libraryId === lib.id && t.status === 'running');
    if (busy) return json(res, 409, { error: '该库已有任务在运行' });
    const task = createTask('covers', lib.id, async ({ setProgress, isCancelled }) => {
      const stat = await covers.fetchMissing(lib, rt.dat, { onProgress: setProgress, isCancelled });
      covers.invalidate(lib.id);
      return stat;
    });
    return json(res, 200, { task: taskSnapshot(task) });
  }

  // 注意：这里要允许两段以上的路径（如 /libraries/:id/overrides/:oid），
  // 只匹配一段会让子资源的 GET/PATCH/DELETE 全部落到 404
  const m = p.match(/^\/libraries\/([\w-]+)(\/.*)?$/);
  if (m) {
    const lib = store.getLibrary(m[1]);
    if (!lib) return json(res, 404, { error: '库不存在' });
    const action = m[2] || '';

    // ---------- 详情 / 游戏列表
    if (!action && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      return json(res, 200, {
        library: summarize(lib),
        dat: rt.dat ? {
          datName: rt.dat.datName,
          system: rt.dat.system,
          datVersion: rt.dat.datVersion,
          romTitle: rt.dat.romTitle,
          extensions: rt.dat.extensions,
          games: rt.dat.games.length,
        } : null,
      });
    }

    // ---------- 修改设置
    if (!action && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJson(req);
      if (body.settings) {
        lib.settings = { ...lib.settings, ...body.settings };
        // 输出目录/模板/形态都影响整理计划，待整理结果必须重算
        const rt = runtime.get(lib.id);
        if (rt) rt.pending = null;
      }
      if (body.assets) {
        lib.assets = { ...lib.assets, ...body.assets };
        covers.invalidate(lib.id);
      }
      if (typeof body.name === 'string' && body.name.trim()) lib.name = body.name.trim();
      // 归属分类（左侧分类树；空字符串 = 未分类）
      if (body.categoryId !== undefined) {
        const cid = String(body.categoryId || '');
        const next = cid && store.categoryById(cid) ? cid : '';
        if (next !== (lib.categoryId || '')) {
          lib.categoryId = next;
          // 换组后排到新分组最后
          store.touchLibraryOrder(lib, next);
        }
      }
      await store.save();
      return json(res, 200, { library: summarize(lib) });
    }

    // ---------- 删除
    if (!action && method === 'DELETE') {
      store.removeLibrary(lib.id);
      runtime.delete(lib.id);
      await removeLibIcons(lib.id);
      await store.save();
      return json(res, 200, { ok: true });
    }

    // ---------- 清单图标：/api/libraries/:id/icon
    if (action === '/icon') {
      const dir = path.join(store.DATA_DIR, 'icons');
      const file = lib.settings && lib.settings.iconFile ? path.basename(String(lib.settings.iconFile)) : '';
      const fp = file ? path.join(dir, file) : '';

      if (method === 'GET') {
        if (!fp) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no icon'); }
        try {
          const stat = await fsp.stat(fp);
          if (!stat.isFile()) throw new Error('not a file');
          const ext = path.extname(fp).toLowerCase();
          res.writeHead(200, {
            'Content-Type': covers.MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(fp).pipe(res);
          return;
        } catch (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no icon');
        }
      }

      if (method === 'POST') {
        const buf = await readBody(req, 4 << 20);
        if (!buf.length) return json(res, 400, { error: '图片为空' });
        const ext = path.extname(q.get('name') || '').toLowerCase();
        if (!covers.IMG_EXT.includes(ext)) return json(res, 400, { error: '只支持 png / jpg / jpeg / webp / gif / bmp 图片' });
        await fsp.mkdir(dir, { recursive: true });
        const name = lib.id + ext;
        await removeLibIcons(lib.id);
        await fsp.writeFile(path.join(dir, name), buf);
        lib.settings = { ...lib.settings, iconFile: name, iconText: '' };
        await store.save();
        return json(res, 200, { ok: true, file: name });
      }

      if (method === 'DELETE') {
        await removeLibIcons(lib.id);
        lib.settings = { ...lib.settings, iconFile: '', iconText: '' };
        await store.save();
        return json(res, 200, { ok: true });
      }
    }

    // ---------- 封面索引
    if (action === '/covers' && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      const map = await covers.buildIndex(lib, rt.dat, { force: q.get('refresh') === '1' });
      const list = {};
      for (const [k, v] of map) list[k] = v.source;
      return json(res, 200, {
        total: rt.dat.games.length,
        withCover: map.size,
        covers: list,
        enabled: !!(lib.assets.cover && lib.assets.cover.enabled),
        storeDir: covers.cacheDir(lib),
        sourceDir: (lib.assets.cover && lib.assets.cover.dir) || '',
        remoteAvailable: !!(rt.dat.newDat && rt.dat.newDat.imURL),
      });
    }

    // ---------- 站点数据：状态 / 手动同步（发布链接 + 发布说明）
    if (action === '/site' && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      const fromEmugif = emugif.isEmugif(rt.rawDat || rt.dat);
      const consoleType = emugif.consoleTypeOf(rt.rawDat || rt.dat);
      const cachedCt = consoleType ? await emugif.readCache(consoleType) : null;
      const site = await siteIndexOf(rt.rawDat || rt.dat);
      let matched = 0;
      let withLink = 0;
      let withComment = 0;
      if (site && site.index) {
        const games = (rt.scan && rt.scan.games) || rt.dat.games;
        const r = emugif.collect(games, site && site.index, site && site.consoleType);
        matched = r.matched;
        withLink = r.withLink;
        withComment = r.withComment;
      }
      return json(res, 200, {
        supported: fromEmugif && !!consoleType,
        consoleType: consoleType || '',
        synced: !!cachedCt,
        fetchedAt: cachedCt ? cachedCt.fetchedAt : null,
        total: cachedCt ? cachedCt.total : 0,
        games: rt.dat.games.length,
        matched,
        withLink,
        withComment,
        error: site && site.error ? site.error : null,
      });
    }

    if (action === '/site/sync' && method === 'POST') {
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      const src = rt.rawDat || rt.dat;
      if (!emugif.isEmugif(src)) return json(res, 400, { error: '这个 DAT 不是来自 dat.emugif.com，没有站点数据可取' });
      const ct = emugif.consoleTypeOf(src);
      if (!ct) return json(res, 400, { error: '认不出这个 DAT 对应的机种' });

      const task = createTask('site', lib.id, async ({ setProgress }) => {
        setProgress({ phase: 'site', message: `正在下载「${ct}」的站点数据…`, current: 0, total: 1 });
        const payload = await emugif.fetchConsole(ct, true);
        siteCache.delete(ct);
        const games = (rt.scan && rt.scan.games) || rt.dat.games;
        const site = await siteIndexOf(src);
        const r = emugif.collect(games, site && site.index, site && site.consoleType);
        setProgress({ phase: 'done', message: '完成', current: 1, total: 1 });
        return {
          consoleType: ct,
          total: payload.total,
          games: games.length,
          matched: r.matched,
          withLink: r.withLink,
          withComment: r.withComment,
        };
      });
      return json(res, 200, { task: taskSnapshot(task) });
    }

    // ---------- 游戏列表
    if (action === '/games' && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      const scan = rt.scan;
      const games = scan
        ? scan.games
        : rt.dat.games.map((g) => ({ ...g, status: 'unknown', matches: [] }));
      // 站点数据只读缓存：列表接口不该顺手联网，要拉由前端显式点同步
      const site = await siteIndexOf(rt.rawDat || rt.dat);
      const { sites } = emugif.collect(games, site && site.index, site && site.consoleType);
      return json(res, 200, {
        games,
        sites,
        stats: scan ? { ...scan.stats, scannedAt: scan.scannedAt, elapsedMs: scan.elapsedMs } : { games: games.length, owned: 0, scannedAt: null },
        romDir: scan ? scan.romDir : lib.settings.romDir,
        // 文件夹型清单（每个游戏是目录、由多文件构成）：前端据此把「格式」栏显示成
        // 「文件夹」、并把 CRC 列 / 详情 CRC 区按文件数聚合，而不是把上百个 CRC 铺开
        folderType: games.length > 0 && games.every((g) => g.multiFile),
      });
    }

    // ---------- 导出当前库的 CSV（含已应用的覆盖层，即界面上看到的实际数据）
    // 方便批量改元数据后回导。多文件（文件夹）游戏只导一行元数据，不含文件清单。
    if (action === '/dat-export.csv' && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      const body = Buffer.from('\ufeff' + csvdat.gamesToCsv(rt.dat.games), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(sanitize(lib.name) + '.csv')}"`,
      });
      return res.end(body);
    }

    // ---------- 从 CSV 回导：按 编号/名称/文件名 匹配现有游戏，批量更新元数据；
    // 未匹配且带文件名+大小的行当作新增单文件条目。改动走覆盖层，不破坏原 DAT。
    if (action === '/import-csv' && method === 'POST') {
      const body = await readJson(req);
      const csv = String(body.csv || '');
      if (!csv.trim()) return json(res, 400, { error: 'CSV 内容为空' });
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      const games = (rt.rawDat || rt.dat).games || [];
      const byIndex = new Map(games.map((g) => [g.index, g]));
      const byTitle = new Map(games.map((g) => [normalizeKey(g.title || ''), g]).filter(([, g]) => g && g.title));
      const byRom = new Map(games.map((g) => [normalizeKey(g.sourceRom || ''), g]).filter(([, g]) => g && g.sourceRom));

      const rows = csvdat.parseCsv(csv);
      if (rows.length < 2) return json(res, 400, { error: 'CSV 没有数据行（至少需要表头 + 一行）' });
      const header = rows[0].map((h) => String(h).trim());
      const col = (name) => header.findIndex((h) => h === name);
      const ci = {
        index: col('编号'), title: col('名称'), comment: col('英文名'),
        filename: col('文件名'), size: col('大小(字节)'), crc: col('CRC32'),
        publisher: col('发行厂商'), location: col('地区'), language: col('语言'),
      };
      const get = (r, i) => (i >= 0 && i < r.length ? String(r[i] || '').trim() : '');

      const book = await overrides.load(lib.id);
      book.entries = book.entries || [];
      const updated = [];
      const added = [];
      const skipped = [];
      const warnings = [];

      for (let n = 1; n < rows.length; n++) {
        const r = rows[n];
        const title = get(r, ci.title);
        if (!title && ci.index < 0) { skipped.push(`第 ${n + 1} 行：没有名称也无法匹配`); continue; }

        // 匹配现有游戏：优先 编号（精准），其次 名称，再次 文件名
        let matched = null;
        const idxRaw = get(r, ci.index);
        if (idxRaw !== '') {
          const idx = Number(idxRaw);
          if (Number.isFinite(idx) && byIndex.has(idx)) matched = byIndex.get(idx);
        }
        if (!matched && title) matched = byTitle.get(normalizeKey(title));
        if (!matched && ci.filename >= 0) {
          const fn = get(r, ci.filename);
          if (fn) matched = byRom.get(normalizeKey(fn));
        }

        const fields = overrides.normalizeFields({
          comment: get(r, ci.comment),
          publisher: get(r, ci.publisher),
          location: get(r, ci.location),
          language: get(r, ci.language),
        });

        if (matched) {
          // 更新覆盖层里引用该 index 的条目（没有就新建）
          let entry = book.entries.find((e) => (e.sourceIndexes || []).includes(matched.index));
          if (!entry) {
            entry = {
              id: overrides.newId(),
              name: '', fields: {}, children: [], files: [],
              matchMode: 'dat', sourceIndexes: [matched.index],
              snapshot: [overrides.snapshotOf(matched)],
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            };
            book.entries.push(entry);
          }
          entry.fields = { ...(entry.fields || {}), ...fields };
          if (title) entry.name = title; // 改名（显示名）
          entry.updatedAt = new Date().toISOString();
          updated.push(matched.index);
          continue;
        }

        // 未匹配：带文件名 + 大小 → 新增单文件条目；否则跳过
        const fn = get(r, ci.filename);
        const sizeRaw = get(r, ci.size).replace(/[,\s_]/g, '');
        const size = Number(sizeRaw) || 0;
        const crc = get(r, ci.crc).toUpperCase();
        if (fn && (size || crc)) {
          const ext = (path.extname(fn).replace(/^\./, '') || '').toLowerCase();
          const entry = {
            id: overrides.newId(),
            name: title || fn,
            files: [{ ext, size, crc, label: '' }],
            children: [],
            fields,
            matchMode: 'name-size',
            sourceIndexes: [],
            snapshot: [],
            baseIndex: nextStandaloneIndex(book),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          book.entries.push(entry);
          added.push(entry.name);
        } else {
          skipped.push(`第 ${n + 1} 行「${title || fn || '（无名）'}」：未匹配到现有游戏，且不是有效的「文件名+大小」新条目`);
        }
      }

      await overrides.save(lib.id, book);
      // 刷新内存里的覆盖结果，让下次读取立刻生效
      const rawNow = rt.rawDat || rt.dat;
      const ap = await applyOverrides(lib.id, rawNow);
      runtime.set(lib.id, { ...rt, dat: ap.dat, rawDat: rawNow, conflicts: ap.conflicts, scan: null, pending: null });
      await store.save();

      return json(res, 200, {
        updated: updated.length, added: added.length, skipped: skipped.length,
        updatedIndexes: updated, addedNames: added, skippedRows: skipped, warnings,
      });
    }

    // ---------- 扫描
    if (action === '/scan' && method === 'POST') {
      const busy = [...tasks.values()].some((t) => t.libraryId === lib.id && t.status === 'running');
      if (busy) return json(res, 409, { error: '该库已有任务在运行' });
      const rt = await hydrateLibrary(lib);
      if (!rt.dat) return json(res, 400, { error: rt.error || 'DAT 未加载' });
      if (!lib.settings.romDir) return json(res, 400, { error: '请先设置 ROM 目录' });

      const task = createTask('scan', lib.id, async ({ setProgress, isCancelled }) => {
        const scan = await scanLibrary(lib, rt.dat, { onProgress: setProgress, isCancelled });
        rt.scan = scan;
        lib.lastScan = scan.scannedAt;
        await fsp.mkdir(path.join(store.DATA_DIR, 'cache'), { recursive: true });
        await fsp.writeFile(path.join(store.DATA_DIR, 'cache', lib.id + '.json'), JSON.stringify(scan)).catch(() => {});
        await store.save();

        // 扫描完顺手算出「待整理」数量
        const pendingInfo = await computePending(lib, scan, rt.dat);
        rt.pending = pendingInfo;
        return {
          stats: scan.stats,
          elapsedMs: scan.elapsedMs,
          // 待整理统计（扫描结束时顺带算好）
          pending: pendingInfo,
          // 读不动的文件清单（含错误原因与权限证据），供前端排查定位
          unreadableList: (scan.unreadableList || []).slice(0, 300),
        };
      });
      return json(res, 200, { task: taskSnapshot(task) });
    }

    // ---------- 清除本清单的缓存（CRC + 扫描快照）
    // 场景：文件内容变了但大小/mtime 恰好没变，或想强制重新匹配一遍
    if (action === '/cache' && method === 'DELETE') {
      const romDir = lib.settings && lib.settings.romDir;
      const crcRemoved = store.cacheClearUnder(romDir);
      await store.saveCrcCache().catch(() => {});
      // 扫描快照（含匹配结果）也要一起清掉，否则下次打开还是旧的匹配
      const cacheFile = path.join(store.DATA_DIR, 'cache', lib.id + '.json');
      let scanRemoved = false;
      try {
        await fsp.rm(cacheFile, { force: true });
        scanRemoved = true;
      } catch (_) {}
      const rt = runtime.get(lib.id);
      if (rt) {
        rt.scan = null;
        rt.pending = null;
      }
      lib.lastScan = null;
      await store.save().catch(() => {});
      return json(res, 200, {
        ok: true,
        crcRemoved,
        scanRemoved,
        romDir: romDir || '',
        message: `已清除 ${crcRemoved} 条 CRC 缓存与扫描结果，下次扫描会重新计算`,
      });
    }

    // ---------- 整理计划
    if (action === '/plan' && method === 'POST') {
      const rt = await hydrateLibrary(lib);
      if (!rt.scan) return json(res, 400, { error: '请先扫描' });
      const plan = await buildPlan(lib, rt.scan, rt.dat);
      const items = plan.items.slice(0, 500).map((it) => ({
        index: it.game.index,
        title: it.game.title,
        status: it.game.status,
        action: it.action,
        reason: it.reason || '',
        dest: it.relDest || it.dest,
        source: it.source.relPath + (it.source.entryName ? ' › ' + it.source.entryName : ''),
        size: it.size || it.source.size,
        exists: !!it.exists,
      }));
      return json(res, 200, {
        outDir: plan.outDir,
        total: plan.items.length,
        conflicts: plan.conflicts,
        warning: plan.warning || '',
        duplicates: plan.duplicates || 0,
        duplicateSkipped: plan.duplicateSkipped || 0,
        multiDiscGames: plan.multiDiscGames || 0,
        textureGroups: plan.textureGroups || 0,
        biosGroups: plan.biosGroups || 0,
        sharedFiles: plan.sharedFiles || 0,
        items,
        mode: lib.settings.mode,
        operation: lib.settings.operation,
      });
    }

    // ---------- 条目编辑（覆盖层）
    if (action === '/overrides' && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      const book = await overrides.load(lib.id);
      const raw = rt.rawDat || rt.dat;
      const rawByIndex = new Map((raw.games || []).map((g) => [g.index, g]));
      // bases：被引用条目在 DAT 里的原始字段（前端用来判断「改没改过」）
      const bases = {};
      const entries = (book.entries || []).map((e) => ({
        ...e,
        // members：已合并进来的来源条目（列表里已经看不到它们了）
        members: (e.sourceIndexes || []).map((i) => {
          const g = rawByIndex.get(i);
          if (g) {
            bases[i] = {
              title: g.title || '', comment: g.comment || '', publisher: g.publisher || '',
              sourceRom: g.sourceRom || '', location: g.location || '', language: g.language || '',
              saveType: g.saveType || '', romSize: g.romSize || 0,
            };
          }
          return {
            index: i,
            title: g ? g.title : '',
            // 子条目在 DAT 里的原始信息：编辑界面用它判断「改没改过」
            comment: g ? g.comment : '',
            publisher: g ? g.publisher : '',
            sourceRom: g ? g.sourceRom : '',
            location: g ? g.location : '',
            language: g ? g.language : '',
            saveType: g ? g.saveType : '',
            romSize: g ? g.romSize : 0,
            imageNumber: g ? g.imageNumber : i,
            crcCount: g ? (g.crcs || []).length : 0,
            // 各自声明的文件：勾选/取消勾选来源时，前端按这个增删文件行
            files: g ? (g.crcs || []).map((c) => ({
              crc: (c.crc || '').toUpperCase(),
              ext: c.extension || '',
              size: g.romSize || 0,
              label: c.label || '',
            })) : [],
          };
        }),
      }));
      return json(res, 200, {
        entries,
        conflicts: (rt.conflicts || []),
        bases,
      });
    }

    // 新建：indexes 一条=重命名/改匹配方式，多条=合并
    if (action === '/overrides' && method === 'POST') {
      const body = await readJson(req);
      const indexes = (body.indexes || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));

      // —— 自建条目（手动新增，不引用 DAT 原条目）：
      //    文件表完全由请求提供，默认按「名称+大小」验证
      if (body.standalone || !indexes.length) {
        const files = (Array.isArray(body.files) ? body.files : []).map((f) => ({
          ext: String((f && f.ext) || '').trim().toLowerCase(),
          size: Number(f && f.size) || 0,
          crc: String((f && f.crc) || '').trim().toUpperCase(),
          label: String((f && f.label) || '').trim(),
        })).filter((f) => f.ext || f.crc);
        if (!files.length) return json(res, 400, { error: '至少要有一个文件（后缀或 CRC）' });
        if (!String(body.name || '').trim()) return json(res, 400, { error: '名称不能为空' });
        const book = await overrides.load(lib.id);
        const entry = {
          id: overrides.newId(),
          name: String(body.name).trim(),
          files,
          children: [],
          fields: overrides.normalizeFields(body.fields),
          matchMode: ['crc', 'name', 'name-size'].includes(body.matchMode) ? body.matchMode : 'name-size',
          sourceIndexes: [],
          snapshot: [],
          baseIndex: nextStandaloneIndex(book),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        book.entries = book.entries || [];
        book.entries.push(entry);
        await overrides.save(lib.id, book);

        const rt0 = await hydrateLibrary(lib);
        const raw0 = rt0.rawDat || rt0.dat;
        const ap0 = await applyOverrides(lib.id, raw0);
        runtime.set(lib.id, { ...rt0, dat: ap0.dat, rawDat: raw0, conflicts: ap0.conflicts, scan: null, pending: null });
        await store.save();
        return json(res, 200, { entry, conflicts: ap0.conflicts, standalone: true });
      }
      if (!indexes.length) return json(res, 400, { error: '请先选择要编辑的条目' });
      const rt = await hydrateLibrary(lib);
      const raw = rt.rawDat || rt.dat;
      const byIndex = new Map((raw.games || []).map((g) => [g.index, g]));
      const picked = indexes.map((i) => byIndex.get(i)).filter(Boolean);
      if (!picked.length) return json(res, 400, { error: '选中的条目在当前 DAT 里不存在' });

      // 合并时默认用 DAT 里靠前的那条的标题（indexes 已按用户勾选顺序，
      // 这里再按 DAT 顺序排一次，保证"靠前"是真靠前）
      picked.sort((a, b) => a.index - b.index);
      // 一个条目可以包含多个文件（合并就是把这些文件并到一起），
      // 所以只能按「CRC + 后缀」去重 —— 同后缀的不同文件必须都保留
      // DAT 声明的文件不能丢：勾选（吃掉）的来源条目，它的每个文件都必须保留在
      // 覆盖条目里。否则对应 ROM 的 CRC 在清单里查不到，会被当成「未识别」
      // 被整理走。所以文件表 = 前端编辑过的（保留标签/大小）∪ DAT 声明的文件。
      const declared = [];
      const seenDecl = new Set();
      const pushDecl = (ext, size, crc, label) => {
        const key = (crc || '').toUpperCase() + '|' + (ext || '');
        if (seenDecl.has(key)) return;
        seenDecl.add(key);
        declared.push({
          ext: ext || '',
          size: Number(size) || 0,
          crc: (crc || '').toUpperCase(),
          label: label || '',
        });
      };
      for (const g of picked) {
        if ((g.crcs || []).length) {
          for (const c of g.crcs || []) pushDecl(c.extension, g.romSize || 0, c.crc, c.label);
        } else {
          pushDecl(g.ext || '', g.romSize || 0, '', '');
        }
      }
      // 前端编辑过的文件表（标签/大小），漏掉的 DAT 文件在后面补回来
      const bodyFiles = Array.isArray(body.files) ? body.files : null;

      const book = await overrides.load(lib.id);
      const clientFiles = bodyFiles
        ? bodyFiles.map((f) => ({
            ext: String((f && f.ext) || '').trim(),
            size: Number(f && f.size) || 0,
            crc: String((f && f.crc) || '').trim().toUpperCase(),
            label: String((f && f.label) || '').trim(),
          })).filter((f) => f.crc || f.ext)
        : null;
      const haveCrc = new Set((clientFiles || []).map((f) => f.crc + '|' + f.ext));
      const declMap = new Map(declared.map((d) => [d.crc + '|' + d.ext, d]));
      const files = (clientFiles || [])
        // 大小没填/丢了（旧数据常见）→ 用 DAT 声明的大小补上
        .map((f) => {
          if (f.size) return f;
          const d = declMap.get(f.crc + '|' + f.ext);
          return d && d.size ? { ...f, size: d.size } : f;
        })
        .concat(declared.filter((d) => !haveCrc.has(d.crc + '|' + d.ext)));
      const entry = {
        id: overrides.newId(),
        name: String(body.name || picked[0].title || '').trim() || picked[0].title,
        files,
        // 子条目（被合并进来的原条目）各自的信息修改
        children: normalizeChildren(body.children),
        fields: overrides.normalizeFields(body.fields),
        matchMode: ['crc', 'name', 'name-size'].includes(body.matchMode) ? body.matchMode : 'dat',
        sourceIndexes: picked.map((g) => g.index),
        snapshot: picked.map(overrides.snapshotOf),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // 同一个 DAT 条目只能被一个覆盖条目吃掉，先清掉旧的
      book.entries = (book.entries || []).filter(
        (e) => !(e.sourceIndexes || []).some((i) => entry.sourceIndexes.includes(i)),
      );
      book.entries.push(entry);
      await overrides.save(lib.id, book);

      const ap = await applyOverrides(lib.id, raw);
      const cur = runtime.get(lib.id) || {};
      runtime.set(lib.id, { ...cur, dat: ap.dat, rawDat: raw, conflicts: ap.conflicts, scan: null, pending: null });
      await store.save();
      return json(res, 200, { entry, conflicts: ap.conflicts });
    }

    const ovMatch = action.match(/^\/overrides\/([\w-]+)$/);
    if (ovMatch && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJson(req);
      const book = await overrides.load(lib.id);
      const entry = (book.entries || []).find((e) => e.id === ovMatch[1]);
      if (!entry) return json(res, 404, { error: '该修改不存在（可能已被删除）' });
      if (typeof body.name === 'string' && body.name.trim()) entry.name = body.name.trim();
      if (body.matchMode !== undefined) {
        entry.matchMode = ['crc', 'name', 'name-size'].includes(body.matchMode) ? body.matchMode : 'dat';
      }
      if (body.fields !== undefined) entry.fields = overrides.normalizeFields(body.fields);
      if (body.children !== undefined) entry.children = normalizeChildren(body.children);
      if (Array.isArray(body.files)) {
        // 与 POST 相同的并集规则：前端编辑的保留，DAT 声明的文件一个都不能少
        const rt0 = await hydrateLibrary(lib);
        const raw0 = rt0.rawDat || rt0.dat;
        const byIdx0 = new Map((raw0.games || []).map((g) => [g.index, g]));
        const decl = [];
        const seenD = new Set();
        for (const i of entry.sourceIndexes || []) {
          const g = byIdx0.get(i);
          if (!g) continue;
          if ((g.crcs || []).length) {
            for (const c of g.crcs || []) {
              const key = (c.crc || '').toUpperCase() + '|' + (c.extension || '');
              if (seenD.has(key)) continue;
              seenD.add(key);
              decl.push({ ext: c.extension || '', size: g.romSize || 0, crc: (c.crc || '').toUpperCase(), label: c.label || '' });
            }
          } else {
            const key = '|' + (g.ext || '');
            if (!seenD.has(key)) { seenD.add(key); decl.push({ ext: g.ext || '', size: g.romSize || 0, crc: '', label: '' }); }
          }
        }
        const cf = body.files.map((f) => ({
          ext: String((f && f.ext) || '').trim(),
          size: Number(f && f.size) || 0,
          crc: String((f && f.crc) || '').trim().toUpperCase(),
          label: String((f && f.label) || '').trim(),
        })).filter((f) => f.crc || f.ext);
        const have0 = new Set(cf.map((f) => f.crc + '|' + f.ext));
        const declMap0 = new Map(decl.map((d) => [d.crc + '|' + d.ext, d]));
        entry.files = cf
          .map((f) => {
            if (f.size) return f;
            const d = declMap0.get(f.crc + '|' + f.ext);
            return d && d.size ? { ...f, size: d.size } : f;
          })
          .concat(decl.filter((d) => !have0.has(d.crc + '|' + d.ext)));
      }
      entry.updatedAt = new Date().toISOString();
      await overrides.save(lib.id, book);

      const rt = await hydrateLibrary(lib);
      const raw = rt.rawDat || rt.dat;
      const ap = await applyOverrides(lib.id, raw);
      runtime.set(lib.id, { ...rt, dat: ap.dat, rawDat: raw, conflicts: ap.conflicts, scan: null, pending: null });
      return json(res, 200, { entry, conflicts: ap.conflicts });
    }

    if (ovMatch && method === 'DELETE') {
      const book = await overrides.load(lib.id);
      const before = (book.entries || []).length;
      book.entries = (book.entries || []).filter((e) => e.id !== ovMatch[1]);
      if (book.entries.length === before) return json(res, 404, { error: '该修改不存在' });
      await overrides.save(lib.id, book);
      const rt = await hydrateLibrary(lib);
      const raw = rt.rawDat || rt.dat;
      const ap = await applyOverrides(lib.id, raw);
      runtime.set(lib.id, { ...rt, dat: ap.dat, rawDat: raw, conflicts: ap.conflicts, scan: null, pending: null });
      return json(res, 200, { ok: true, conflicts: ap.conflicts });
    }

    // ---------- 执行整理
    // ---------- 待整理统计：输出目录里还没有对应成品的条目
    if (action === '/pending' && method === 'GET') {
      const rt = await hydrateLibrary(lib);
      if (!rt.scan) return json(res, 200, { ...EMPTY_PENDING });
      // 算一次就缓存：切换清单时会频繁请求，每次都重建计划太贵
      if (rt.pending) return json(res, 200, rt.pending);
      try {
        const info = await computePending(lib, rt.scan, rt.dat);
        rt.pending = info;
        return json(res, 200, info);
      } catch (e) {
        return json(res, 200, { ...EMPTY_PENDING, reason: e.message });
      }
    }

    // ---------- 只整理某一条（详情页里对单个游戏发起）
    if (action === '/organize-one' && method === 'POST') {
      const body = await readJson(req);
      const idx = parseInt(body.index, 10);
      if (Number.isNaN(idx)) return json(res, 400, { error: '缺少 index' });
      const rt = await hydrateLibrary(lib);
      if (!rt.scan) return json(res, 400, { error: '请先扫描' });
      const busy = [...tasks.values()].some((t) => t.libraryId === lib.id && t.status === 'running');
      if (busy) return json(res, 409, { error: '该库已有任务在运行' });

      const plan = await buildPlan(lib, rt.scan, rt.dat);
      const before = plan.items.length;
      plan.items = plan.items.filter((it) => it.game && it.game.index === idx);
      if (!plan.items.length) {
        return json(res, 400, { error: '这条没有需要整理的内容（可能已整理到位或未匹配到文件）' });
      }
      const task = createTask('organize', lib.id, async ({ setProgress, isCancelled }) => {
        const result = await executePlan(lib, plan, { onProgress: setProgress, isCancelled });
        applyOrganizeToScan(rt.scan, result, lib.settings.romDir);
        lib.lastOrganize = new Date().toISOString();
        await store.save();
        await warmCrcCache(plan).catch(() => {});
        await store.saveCrcCache().catch(() => {});
        return { ...result, single: idx, planned: plan.items.length, filtered: before - plan.items.length };
      });
      return json(res, 200, { task: taskSnapshot(task) });
    }

    if (action === '/organize' && method === 'POST') {
      const body = await readJson(req);
      const rt = await hydrateLibrary(lib);
      if (!rt.scan) return json(res, 400, { error: '请先扫描' });
      const busy = [...tasks.values()].some((t) => t.libraryId === lib.id && t.status === 'running');
      if (busy) return json(res, 409, { error: '该库已有任务在运行' });

      const plan = await buildPlan(lib, rt.scan, rt.dat);
      const dryRun = !!body.dryRun;
      const task = createTask('organize', lib.id, async ({ setProgress, isCancelled }) => {
        const result = await executePlan(lib, plan, { onProgress: setProgress, isCancelled, dryRun });
        let pendingInfo = rt.pending || { ...EMPTY_PENDING };
        if (!dryRun) {
          applyOrganizeToScan(rt.scan, result, lib.settings.romDir);
          lib.lastOrganize = new Date().toISOString();
          await store.save();
          // 整理出的文件回填 CRC 缓存，之后重扫不再整库重读
          await warmCrcCache(plan).catch(() => {});
          await store.saveCrcCache().catch(() => {});
          // 整理完立刻重算「待整理」，否则界面要等下一次扫描才更新高亮和数量
          pendingInfo = await computePending(lib, rt.scan, rt.dat).catch(() => ({ ...EMPTY_PENDING }));
          rt.pending = pendingInfo;
          // 同步更新扫描缓存，重启后不用重扫
          await fsp.writeFile(path.join(store.DATA_DIR, 'cache', lib.id + '.json'), JSON.stringify(rt.scan)).catch(() => {});
        }
        return {
          done: result.done, skipped: result.skipped, failed: result.failed, planned: result.planned,
          moved: result.moved, prunedDirs: result.prunedDirs || 0, byAction: result.byAction,
          errors: result.errors.slice(0, 50),
          pending: pendingInfo,
          // 输出目录以外不可写的目录（例如备份目录只给了读权限），
          // 这些目录相关的条目本次被跳过，需要用户去授权后重试
          blockedDirs: result.blockedDirs || [],
          permissionBlocked: result.permissionBlocked || 0,
        };
      });
      return json(res, 200, { task: taskSnapshot(task) });
    }

    // ---------- 检查更新
    if (action === '/check-update' && method === 'POST') {
      try {
        const info = await checkUpdate(lib);
        return json(res, 200, info);
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message, current: lib.datVersion });
      }
    }

    // ---------- 执行更新
    if (action === '/update' && method === 'POST') {
      const busy = [...tasks.values()].some((t) => t.libraryId === lib.id && t.status === 'running');
      if (busy) return json(res, 409, { error: '该库已有任务在运行' });
      const task = createTask('update', lib.id, async ({ setProgress }) => {
        // 先记下更新前的 DAT 与扫描结果：如果这次下载回来的 DAT 和原来
        // 完全一样（版本没变、条目与 CRC 全同），就不能把扫描进度清掉，
        // 否则用户只是点了下「更新 DAT」就得整库重扫一遍。
        const rt0 = await hydrateLibrary(lib).catch(() => null);
        const oldDat = rt0 && (rt0.rawDat || rt0.dat);
        const oldScan = rt0 && rt0.scan;
        const oldSig = oldDat ? datSignature(oldDat) : '';

        const resu = await downloadDat(lib, setProgress);
        const unchanged = !!oldSig && oldSig === datSignature(resu.dat);

        lib.datPath = resu.datPath;
        lib.datVersion = resu.datVersion;
        lib.datName = resu.dat.datName;
        lib.system = resu.dat.system;
        lib.extensions = resu.dat.extensions;
        lib.datConfig = { newDat: resu.dat.newDat, romTitle: resu.dat.romTitle };
        lib.error = null;
        // 内容没变不算更新，保留原来的时间
        if (!unchanged) lib.updatedAt = new Date().toISOString();
        const apU = await applyOverrides(lib.id, resu.dat);
        runtime.set(lib.id, {
          dat: apU.dat,
          rawDat: resu.dat,
          conflicts: apU.conflicts,
          // 内容没变就沿用原来的扫描结果，界面上的拥有数/待整理都不动
          scan: unchanged ? (oldScan || null) : null,
          error: null,
          pending: unchanged ? (rt0 && rt0.pending) : null,
        });
        await store.save();

        // 更新完自动把新 DAT 的图片下载到设置好的图片保存位置（失败不影响 DAT 更新结果）
        const cov = lib.assets && lib.assets.cover;
        if (cov && cov.enabled && !unchanged) {
          try {
            setProgress({ phase: 'covers', message: '正在下载图片…' });
            const stat = await covers.fetchMissing(lib, resu.dat, { onProgress: setProgress });
            covers.invalidate(lib.id);
            return {
              datVersion: resu.datVersion,
              games: resu.dat.games.length,
              unchanged,
              covers: { ok: stat.ok || 0, skipped: stat.skipped || 0, fail: stat.fail || 0, dir: covers.cacheDirFor(lib) },
            };
          } catch (e) {
            return {
              datVersion: resu.datVersion,
              games: resu.dat.games.length,
              unchanged,
              covers: { fail: -1, error: e.message },
            };
          }
        }
        return { datVersion: resu.datVersion, games: resu.dat.games.length, unchanged, covers: null };
      });
      return json(res, 200, { task: taskSnapshot(task) });
    }
  }

  // ---------- 任务
  const mt = p.match(/^\/tasks\/([\w-]+)$/);
  if (mt && method === 'GET') {
    const t = tasks.get(mt[1]);
    if (!t) return json(res, 404, { error: '任务不存在' });
    return json(res, 200, { task: taskSnapshot(t) });
  }
  const mc = p.match(/^\/tasks\/([\w-]+)\/cancel$/);
  if (mc && method === 'POST') {
    return json(res, 200, { ok: cancelTask(mc[1]) });
  }

  // ---------- 分类（左侧分类树）
  if (p === '/categories' && method === 'GET') {
    return json(res, 200, { categories: store.listCategories() });
  }
  if (p === '/categories' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const cat = store.addCategory(body.name, body.parentId);
    await store.save();
    return json(res, 200, { category: cat, categories: store.listCategories() });
  }
  // ---------- 分类图标（左侧分组分隔条上显示）：/api/categories/:id/icon
  const mCatIcon = p.match(/^\/categories\/([\w-]+)\/icon$/);
  if (mCatIcon) {
    const cat = store.categoryById(mCatIcon[1]);
    if (!cat) return json(res, 404, { error: '分类不存在' });
    const dir = path.join(store.DATA_DIR, 'icons');
    const file = cat.iconFile ? path.basename(String(cat.iconFile)) : '';
    const fp = file ? path.join(dir, file) : '';

    if (method === 'GET') {
      if (!fp) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no icon'); }
      try {
        const stat = await fsp.stat(fp);
        if (!stat.isFile()) throw new Error('not a file');
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, {
          'Content-Type': covers.MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(fp).pipe(res);
        return;
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no icon');
      }
    }

    if (method === 'POST') {
      const buf = await readBody(req, 4 << 20);
      if (!buf.length) return json(res, 400, { error: '图片为空' });
      const ext = path.extname(q.get('name') || '').toLowerCase();
      if (!covers.IMG_EXT.includes(ext)) return json(res, 400, { error: '只支持 png / jpg / jpeg / webp / gif / bmp 图片' });
      await fsp.mkdir(dir, { recursive: true });
      const name = 'cat_' + cat.id + ext;
      try {
        const old = await fsp.readdir(dir);
        await Promise.all(old
          .filter((n) => n.startsWith('cat_' + cat.id + '.'))
          .map((n) => fsp.unlink(path.join(dir, n)).catch(() => {})));
      } catch (_) {}
      await fsp.writeFile(path.join(dir, name), buf);
      cat.iconFile = name;
      cat.iconText = '';
      await store.save();
      return json(res, 200, { ok: true, file: name });
    }

    if (method === 'DELETE') {
      try {
        const old = await fsp.readdir(dir);
        await Promise.all(old
          .filter((n) => n.startsWith('cat_' + cat.id + '.'))
          .map((n) => fsp.unlink(path.join(dir, n)).catch(() => {})));
      } catch (_) {}
      cat.iconFile = '';
      cat.iconText = '';
      await store.save();
      return json(res, 200, { ok: true });
    }
  }

  const mCat = p.match(/^\/categories\/([\w-]+)$/);
  if (mCat && (method === 'PATCH' || method === 'PUT')) {
    const cat = store.categoryById(mCat[1]);
    if (!cat) return json(res, 404, { error: '分类不存在' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (typeof body.name === 'string' && body.name.trim()) cat.name = body.name.trim();
    if (typeof body.iconText === 'string') cat.iconText = body.iconText.trim();
    if (body.parentId !== undefined) {
      const pid = String(body.parentId || '');
      // 不能把自己或自己的子孙设为父分类
      if (pid && (pid === cat.id || store.descendantCatIds(cat.id).includes(pid))) {
        return json(res, 400, { error: '不能把分类移动到它自己或其子分类下' });
      }
      const next = pid && store.categoryById(pid) ? pid : null;
      if (next !== (cat.parentId || null)) {
        cat.parentId = next;
        cat.ord = store.nextCatOrd(next);
      }
    }
    await store.save();
    return json(res, 200, { category: cat, categories: store.listCategories() });
  }
  if (mCat && method === 'DELETE') {
    if (!store.removeCategory(mCat[1])) return json(res, 404, { error: '分类不存在' });
    await store.save();
    return json(res, 200, { ok: true, categories: store.listCategories() });
  }

  // ---------- 分类组排序：{ parentId, ids: [...] }（parentId 空 = 顶层）
  if (p === '/categories/reorder' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!store.reorderCategories(String(body.parentId || ''), ids)) {
      return json(res, 400, { error: '排序分类与当前层级不匹配' });
    }
    await store.save();
    return json(res, 200, { ok: true });
  }

  // ---------- 清除全部缓存（所有清单的 CRC 缓存 + 扫描快照）
  if (p === '/cache/clear' && method === 'POST') {
    const crcRemoved = store.cacheClearAll();
    await store.saveCrcCache().catch(() => {});
    let scansRemoved = 0;
    const cacheDir = path.join(store.DATA_DIR, 'cache');
    try {
      const files = await fsp.readdir(cacheDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        await fsp.rm(path.join(cacheDir, f), { force: true }).catch(() => {});
        scansRemoved++;
      }
    } catch (_) {}
    // 内存里的运行时状态也一并失效，避免界面还显示旧的匹配结果
    for (const [id, rt] of runtime) {
      rt.scan = null;
      rt.pending = null;
      const lib = store.getLibrary(id);
      if (lib) lib.lastScan = null;
      covers.invalidate(id);
    }
    await store.save().catch(() => {});
    return json(res, 200, {
      ok: true,
      crcRemoved,
      scansRemoved,
      message: `已清除全部缓存：${crcRemoved} 条 CRC、${scansRemoved} 份扫描结果`,
    });
  }

  // ---------- 组内清单排序：{ categoryId, ids: [...] }（只允许该分类的直属清单）
  if (p === '/reorder-libraries' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!store.reorderLibraries(String(body.categoryId || ''), ids)) {
      return json(res, 400, { error: '排序清单与当前分组不匹配' });
    }
    await store.save();
    return json(res, 200, { ok: true });
  }

  // ---------- 文件系统浏览（目录选择器）
  if (p === '/fs/list' && method === 'GET') {
    const target = q.get('path') || '';
    const isFnOS = !!(process.env.TRIM_APPDEST || process.env.TRIM_APPNAME);
    if (!target) {
      let dirs = [];
      if (process.platform === 'win32' && !isFnOS) {
        for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          try {
            await fsp.access(c + ':\\');
            dirs.push({ name: c + ':', path: c + ':\\', ok: true });
          } catch (_) {}
        }
      } else {
        // 每次打开选择器都重新判定一次权限（fnOS 授权随时可变）
        dirs = await fsRoots();
      }
      const home = require('node:os').homedir();
      const authPaths = splitPaths(process.env.TRIM_DATA_ACCESSIBLE_PATHS);
      return json(res, 200, { path: '', parent: null, dirs, files: [], home, fnos: isFnOS, authorizedPaths: authPaths });
    }
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        // 符号链接要跟进去判断类型（fnOS 的共享目录就是软链）
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
          try { isDir = (await fsp.stat(path.join(target, e.name))).isDirectory(); } catch (_) { continue; }
        }
        const full = path.join(target, e.name);
        // 子目录同样实时探测，进不去的标 ok:false（前端显示锁标记）
        if (isDir) dirs.push({ name: e.name, path: full, ok: await canEnter(full) });
        else if (/\.(zip|xml)$/i.test(e.name)) files.push({ name: e.name, path: full });
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

      // 父目录：Windows 盘符根的父级是驱动器列表；Linux 下 / 的父级回根入口列表
      let parent = path.dirname(target);
      if (/^[A-Za-z]:\\?$/.test(target)) parent = '';
      if (process.platform !== 'win32') {
        if (target === '/') parent = null;
        else if (parent === '/') parent = '';
      }
      // 快捷跳转：Windows 桌面版用用户目录；fnOS 用已授权目录
      const shortcuts = [];
      if (process.platform === 'win32' && !isFnOS) {
        const home = require('node:os').homedir();
        for (const s of ['Downloads', 'Desktop', 'Documents']) {
          shortcuts.push({ name: s, path: path.join(home, s) });
        }
      } else {
        for (const p of splitPaths(process.env.TRIM_DATA_ACCESSIBLE_PATHS)) {
          shortcuts.push({ name: '授权：' + (path.basename(p) || p), path: p });
        }
      }
      return json(res, 200, { path: target, parent, dirs, files, shortcuts });
    } catch (e) {
      let msg = '无法读取目录：' + e.message;
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        msg = isFnOS
          ? '没有权限访问该目录。请在 fnOS「应用中心 → ROMKit → 授权目录」中添加此目录后重试'
          : '没有权限访问该目录（' + e.message + '）';
      }
      return json(res, 400, { error: msg });
    }
  }

  if (p === '/fs/exists' && method === 'GET') {
    const target = q.get('path') || '';
    try {
      const st = await fsp.stat(target);
      return json(res, 200, { exists: true, isDirectory: st.isDirectory() });
    } catch (_) {
      return json(res, 200, { exists: false });
    }
  }

  // ---------- 批量修复权限（读取失败诊断弹窗的「尝试修复」） ----------
  // 适用：ROMKit 旧版本在 umask 0777 环境下整理出的 0000 文件/目录。
  // 应用用户是自己创建的文件的所有者，可以直接 chmod；曾被第三方 chown
  // 过的文件会失败（EPERM），那种只能管理员处理。
  if (p === '/fs/fixperm' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((s) => typeof s === 'string' && s).slice(0, 500)
      : [];
    let fixed = 0;
    const errors = [];
    for (const pt of paths) {
      try {
        const st = await fsp.stat(pt);
        // 目录 755；文件保留可执行位（若有），否则 644
        const want = st.isDirectory() ? 0o755 : ((st.mode & 0o111) ? 0o755 : 0o644);
        await fsp.chmod(pt, want);
        fixed++;
      } catch (e) {
        errors.push({ path: pt, error: e.code || String(e.message) });
        // 顺手把摸得到的父目录修一下，可能让后续层级可以继续修
        try { await fsp.chmod(path.dirname(pt), 0o755); } catch (_) {}
      }
    }
    return json(res, 200, { fixed, failed: errors.length, errors: errors.slice(0, 50) });
  }

  return json(res, 404, { error: '未知接口：' + p });
}

// ---------------------------------------------------------------- 启动
async function main() {
  store.load();
  const libs = store.listLibraries();
  for (const lib of libs) {
    await hydrateLibrary(lib).catch(() => {});
    // 尝试恢复上次扫描结果
    const cacheFile = path.join(store.DATA_DIR, 'cache', lib.id + '.json');
    try {
      const raw = await fsp.readFile(cacheFile, 'utf8');
      const scan = JSON.parse(raw);
      const rt = runtime.get(lib.id);
      if (rt && rt.dat) rt.scan = scan;
    } catch (_) {}
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (e) {
      logErr('request error', req.method, req.url, e.message);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });

  let port = PORT_START;
  let tries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 20) {
      tries++;
      port++;
      setTimeout(() => server.listen(port, HOST), 50);
    } else {
      logErr('服务启动失败：', e.message);
      process.exit(1);
    }
  });

  server.listen(port, HOST, () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  ROMKit 已启动');
    console.log('  ' + url);
    console.log('  数据目录：' + store.DATA_DIR);
    console.log('  （关闭此窗口即退出）');
    console.log('');
  // 端口文件供 start.bat 发现实际端口；安装目录只读时（如 fnOS）静默失败
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'data', '.port'), String(port));
  } catch (_) {}

    if (process.argv.includes('--open') && process.platform === 'win32') {
      const { spawn } = require('node:child_process');
      try {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (_) {}
    }
  });
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
