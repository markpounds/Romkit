'use strict';
/**
 * 读不动一个文件时，把「为什么读不动」记录下来。
 * 只靠一句"权限不足或被占用"没法定位问题：可能是文件本身没读权限、
 * 也可能是某一级父目录不能进（Linux 要求每级父目录都有 x 权限）、
 * 还可能是文件已被删除或软链接失效。这里把证据都带上。
 */
/**
 * CRC 缓存的 key：路径 | 大小 | 修改时间。
 * mtime 必须取整——Node 在 Linux 上给出的是带小数的毫秒（纳秒精度），
 * 而整理后新文件的 mtime 来自 stat（原始小数）与扫描时取整后的值不一致，
 * 两边若不同时取整，预写的缓存就永远命中不了，导致每次重扫都全量重读。
 */
function crcKey(filePath, size, mtimeMs) {
  return filePath + '|' + size + '|' + Math.round(mtimeMs);
}

async function inspectReadFailure(filePath) {
  const d = {};
  try {
    const st = await fsp.lstat(filePath);
    // 统一成 4 位八进制（0000 / 0644 / 0755），"0000" 有特殊含义：连所有者都没权限
    d.mode = '0' + (st.mode & 0o777).toString(8).padStart(3, '0');
    d.uid = st.uid;
    d.gid = st.gid;
    d.link = st.isSymbolicLink();
  } catch (e) {
    d.statError = e.code || String(e.message);
  }
  // 父目录是否挡路（看不到权限就无法确认，但能确认"进不去"）
  try {
    const pst = await fsp.stat(path.dirname(filePath));
    d.parentMode = '0' + (pst.mode & 0o777).toString(8).padStart(3, '0');
    d.parentUid = pst.uid;
    d.parentGid = pst.gid;
  } catch (e) {
    d.parentBlocked = e.code || String(e.message);
  }
  return d;
}

/**
 * 扫描本地 ROM 目录，按 DAT 清单匹配。
 *
 * 匹配策略：
 *  1) 内容 CRC32 精确匹配（权威）——zip 直接读中央目录里的 CRC，无需解压；
 *  2) 文件名匹配（可选）——去掉 (Japan)[CHS] 这类标签后与标题/英文名比对；
 *  3) 两者可同时启用，CRC 优先。
 *
 * 大文件 CRC 有缓存（path + size + mtime），第二次扫描接近瞬时。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { crc32FileHex, normalizeHex } = require('./crc32');
const { listEntries } = require('./zip');
const { normalizeKey, buildCrcIndex } = require('./dat');
const store = require('./store');

const ARCHIVE_EXT = new Set(['.zip']);
const UNREADABLE_ARCHIVE_EXT = new Set(['.7z', '.rar', '.gz', '.xz', '.bz2']);
// 常见 ROM 扩展名兜底：不同 DAT 对同一份内容声明的后缀可能不一致
// （MD 有 .md/.gen/.smd/.bin，SFC 有 .sfc/.smc 等），只按 DAT 声明过滤会漏。
const COMMON_ROM_EXT = new Set([
  '.md', '.gen', '.smd', '.bin', '.sfc', '.smc', '.fig', '.gd3', '.gd7', '.dx2', '.bsx', '.swc',
  '.nes', '.fds', '.unf', '.gb', '.gbc', '.gba', '.nds', '.3ds', '.n64', '.z64', '.v64',
  '.gg', '.sms', '.sg', '.sc', '.pce', '.ngp', '.ngc', '.ws', '.wsc', '.vb', '.lynx',
  '.iso', '.cso', '.chd', '.cue', '.ccd', '.gdi', '.wbfs', '.rvz', '.cia', '.xci', '.nsp',
  '.rom', '.a26', '.a78', '.j64', '.jag', '.int', '.vec', '.min', '.uze',
]);
// 注意：`.md` 是世嘉 MD/Genesis 的标准 ROM 扩展名，绝不能整类忽略，
// 否则所有 `*.md` 的 MD 游戏 ROM 都会被当成文档过滤掉（表现为 CRC 全部不通过）。
const IGNORE_EXT = new Set(['.txt', '.nfo', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.xml', '.dat', '.json', '.sfv', '.db', '.ini', '.log', '.bak', '.tmp', '.part', '.crdownload']);

// 只有明确是说明文档的文件名才按文档忽略（README.md、说明.md …）
const DOC_NAME_RE = /^(readme|changelog|license|licence|install|guide|faq|todo|说明|使用说明|必读|教程|更新日志|变更记录)/i;
function isIgnoredFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (IGNORE_EXT.has(ext)) return true;
  if (ext === '.md' && DOC_NAME_RE.test(path.basename(name, ext))) return true;
  return false;
}

function stripTags(name) {
  return String(name)
    .replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉文件名开头的编号前缀（"0001 - Game" / "001.Game" / "[001] Game"） */
function stripIndexPrefix(name) {
  return String(name)
    .replace(/^[\s._\-#]*[\[(（]?\d{1,4}[\])）]?[\s._\-–—]+/, '')
    .replace(/^[\s._\-#]*\d{1,4}[\s._\-–—]+/, '')
    .trim();
}

/**
 * 一个名字的多个候选键。
 * 真实 ROM 文件名比 DAT 标题脏得多：
 *   "0001 - Sonic The Hedgehog (USA).md" / "刺猬索尼克 Sonic (USA).md" / "Game [En,Ja].md"
 * 所以不能只比一个归一化结果——要同时准备
 *   原样 / 去标签 / 去编号前缀 / 去标签+去编号 前缀
 * 多个形态，匹配时任意一对相等或互相包含即算命中。
 */
function nameVariants(name) {
  const out = new Set();
  const add = (v) => {
    const k = normalizeKey(v);
    if (k) out.add(k);
  };
  const base = String(name || '');
  const noTag = stripTags(base);
  const noNum = stripIndexPrefix(base);
  const noTagNoNum = stripTags(noNum);
  for (const v of [base, noTag, noNum, noTagNoNum]) {
    add(v);
    // 有些文件把扩展名也写进名字里（"Game.md (USA)"），去掉尾部扩展名再来一份
    add(v.replace(/\.[A-Za-z0-9]{1,4}$/, ''));
  }
  return [...out];
}

/** 拆成词元（用于"文件名带中文+英文"这种包含关系判断） */
function nameTokens(name) {
  return String(name || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * 名称索引：把每个游戏展开成多种形态的键，便于文件名以各种脏方式命中。
 *   exact : 归一化后的完整键 -> 游戏数组
 *   token : 词元 -> 游戏数组（用于"文件名多带了几个词"这种包含匹配）
 */
function buildNameIndex(games) {
  const exact = new Map();
  const token = new Map();
  const addExact = (k, g) => {
    if (!k || k.length < 2) return;
    if (!exact.has(k)) exact.set(k, []);
    const arr = exact.get(k);
    if (!arr.includes(g)) arr.push(g);
  };
  const addToken = (t, g) => {
    if (!t || t.length < 2) return;
    if (!token.has(t)) token.set(t, []);
    const arr = token.get(t);
    if (!arr.includes(g)) arr.push(g);
  };
  for (const g of games) {
    const sources = [g.title, g.comment].filter(Boolean);
    for (const src of sources) {
      for (const v of nameVariants(src)) addExact(v, g);
      for (const t of nameTokens(stripTags(src))) addToken(t, g);
    }
  }
  return { exact, token };
}

/**
 * 用文件名匹配 DAT 条目。
 * 规则（从强到弱）：
 *   1) 归一化后完全相等；
 *   2) 一方是另一方的前缀/后缀且长度足够（"游戏名" vs "游戏名 豪华版"）；
 *   3) 词元集合覆盖：文件名的词元覆盖了 DAT 条目的全部词元（反之不算，
 *      否则"超级马里奥"会命中"超级马里奥世界"这种完全不同的条目）。
 * 续作序号必须严格区分：文件名多一个数字（"X 2"）不算命中"X"。
 */
function matchByName(fileBase, index) {
  if (!index) return [];
  const variants = nameVariants(fileBase);
  if (!variants.length) return [];
  const files = nameTokens(stripTags(stripIndexPrefix(fileBase)));
  const fileNums = new Set(files.filter((t) => /^\d+$/.test(t)));

  // 1) 精确
  for (const v of variants) {
    const hit = index.exact.get(v);
    if (hit && hit.length) return hit;
  }

  // 2) 包含（取最长命中，避免"游戏"先于"游戏 2"被选中）
  let best = null;
  for (const v of variants) {
    if (v.length < 4) continue;
    for (const [k, arr] of index.exact) {
      if (k.length < 4) continue;
      if (v === k) return arr;
      if (v.startsWith(k) || v.endsWith(k) || k.startsWith(v) || k.endsWith(v)) {
        // 续作序号：长的那边多出数字就不算同一个游戏
        const longer = v.length > k.length ? v : k;
        const shorter = v.length > k.length ? k : v;
        if (hasExtraNumber(longer, shorter)) continue;
        if (!best || k.length > best.len) best = { len: k.length, arr };
      }
    }
  }
  if (best) return best.arr;

  // 3) 词元覆盖
  if (!files.length) return [];
  const fileSet = new Set(files);
  let bestTok = null;
  for (const [t, arr] of index.token) {
    if (!fileSet.has(t)) continue;
    // 该词元所属条目里的其他词元是否也都在文件名里
    for (const g of arr) {
      const need = new Set();
      for (const src of [g.title, g.comment].filter(Boolean)) {
        for (const tt of nameTokens(stripTags(src))) need.add(tt);
      }
      if (!need.size) continue;
      let hitAll = true;
      for (const tt of need) if (!fileSet.has(tt)) { hitAll = false; break; }
      if (!hitAll) continue;
      // 文件名多出数字词元（续作序号）→ 不算同一个游戏
      let extraNum = false;
      for (const tt of fileSet) {
        if (/^\d+$/.test(tt) && !need.has(tt)) { extraNum = true; break; }
      }
      if (extraNum) continue;
      const score = need.size;
      if (!bestTok || score > bestTok.score) bestTok = { score, arr: [g] };
      else if (score === bestTok.score) bestTok.arr.push(g);
    }
  }
  return bestTok ? bestTok.arr : [];
}

/** longer 里是否比 shorter 多出数字（续作编号） */
function hasExtraNumber(longer, shorter) {
  const numRe = /(\d+)/g;
  const a = (String(longer).match(numRe) || []);
  const b = new Set(String(shorter).match(numRe) || []);
  for (const n of a) if (!b.has(n)) return true;
  return false;
}

async function walkFiles(root, opts, onFile) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!opts.recursive) continue;
        // 跳过常见系统/工具目录
        if (/^\$RECYCLE/i.test(ent.name) || ent.name === 'System Volume Information') continue;
        if (opts.skipHidden && (ent.name.startsWith('.') || ent.name.startsWith('_'))) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (opts.skipHidden && ent.name.startsWith('.')) continue;
        await onFile(full, ent.name);
      }
    }
  }
}

/**
 * @param {object} lib 库对象（含 settings）
 * @param {object} dat 解析后的 DAT
 * @param {object} opts {onProgress, isCancelled}
 */
async function scanLibrary(lib, dat, opts = {}) {
  const settings = { ...store.DEFAULT_SETTINGS, ...(lib.settings || {}) };
  const romDir = settings.romDir;
  if (!romDir) throw new Error('尚未设置 ROM 目录');
  const stat = await fsp.stat(romDir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('ROM 目录不存在或不可访问：' + romDir);

  const onProgress = opts.onProgress || (() => {});
  const isCancelled = opts.isCancelled || (() => false);

  // 白名单 = DAT 声明的扩展名 ∪ 常见 ROM/光盘镜像扩展名。
  // 只看 DAT 声明会把 `.md`/`.gen` 这类"同一份内容换个后缀"的 ROM 直接过滤掉，
  // 表现为 MD 游戏整库 CRC 校验不通过，所以这里补一份通用清单。
  const allowedExt = new Set([
    ...dat.extensions.map((e) => e.toLowerCase()),
    ...ARCHIVE_EXT, ...UNREADABLE_ARCHIVE_EXT, ...COMMON_ROM_EXT,
  ]);
  const useExtFilter = allowedExt.size > 0;
  // DAT 明确声明的后缀，即使落在忽略名单里（如 .dat / .iso 之类）也要收：
  // 有些纹理包 / ROM 本体就是 .dat，不能一律当描述文件丢掉。
  const declaredExt = new Set(dat.extensions.map((e) => e.toLowerCase()));

  const started = Date.now();
  const candidates = []; // {path, relPath, name, ext, size, mtimeMs, container, entryName?, crc?}

  onProgress({ phase: 'walk', message: '正在遍历目录…', current: 0, total: 0 });
  await walkFiles(romDir, {
    recursive: settings.recursive !== false,
    skipHidden: settings.skipHidden !== false,
  }, async (full, name) => {
    if (isCancelled()) return;
    const ext = path.extname(name).toLowerCase();
    if (isIgnoredFile(name) && !declaredExt.has(ext)) return;
    if (useExtFilter && !allowedExt.has(ext)) return;
    let st;
    try {
      st = await fsp.stat(full);
    } catch (_) {
      return;
    }
    candidates.push({
      path: full,
      relPath: path.relative(romDir, full),
      name,
      base: path.basename(name, path.extname(name)),
      ext,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      container: ext === '.zip' ? 'zip' : UNREADABLE_ARCHIVE_EXT.has(ext) ? 'archive' : 'file',
    });
    if (candidates.length % 200 === 0) {
      onProgress({ phase: 'walk', message: '已发现 ' + candidates.length + ' 个文件…', current: candidates.length, total: 0 });
    }
  });

  onProgress({ phase: 'walk', message: '共发现 ' + candidates.length + ' 个文件', current: candidates.length, total: candidates.length });

  // 建立匹配索引
  const crcIndex = buildCrcIndex(dat.games);
  const nameIndex = buildNameIndex(dat.games);

  const matched = new Map(); // game.index -> matches[]
  const usedPaths = new Set(); // 已被任何一个游戏认领的文件
  let matchCount = 0; // 累计命中次数（用于判断「这个压缩包到底有没有匹配到」）
  const addMatch = (game, source) => {
    usedPaths.add(source.path);
    if (!matched.has(game.index)) matched.set(game.index, []);
    const arr = matched.get(game.index);
    if (!arr.some((m) => m.path === source.path && m.entryName === source.entryName)) {
      arr.push(source);
      matchCount++;
    }
  };

  const byName = (cand, entry, entryExt) => {
    for (const g of matchByName(cand.base, nameIndex)) addMatch(g, mkSource(cand, 'name', entry, entryExt));
  };

  let processed = 0;
  let crcComputed = 0;
  let crcFromCache = 0;
  let unreadable = 0;
  let readErrors = 0;
  const total = candidates.length;

  const report = () => onProgress({
    phase: 'match',
    message: '正在校验 ' + processed + '/' + total,
    current: processed,
    total,
    matched: matched.size,
    crcComputed,
    crcFromCache,
    elapsedMs: Date.now() - started,
  });

  for (const cand of candidates) {
    if (isCancelled()) break;
    processed++;

    if (cand.container === 'zip') {
      let entries = [];
      try {
        entries = await listEntries(cand.path);
      } catch (e) {
        unreadable++;
        entries = [];
      }
      const realEntries = entries.filter((e) => !e.isDir);
      cand.entryCount = realEntries.length;
      const matchedBefore = matchCount;
      for (const e of realEntries) {
        const eExt = path.extname(e.name).toLowerCase();
        // CRC 命中必须优先于「忽略名单」：纹理包 / 某些 ROM 就是 .dat 结尾，
        // 而 .dat 同时在忽略名单里（用于跳过 DAT 描述文件本身）。
        // 只要压缩包记录的 CRC 和清单里某条一致，它就是清单要的那个文件。
        const hit = e.crc ? crcIndex.get(normalizeHex(e.crc)) : null;
        if (hit) {
          // 同一个 CRC 对应多个条目时，用后缀消歧；对不上也仍然算命中
          const sameExt = eExt ? hit.filter((h) => !h.extension || h.extension === eExt) : [];
          const pick = sameExt.length ? sameExt : hit;
          for (const { game } of pick) addMatch(game, mkSource(cand, 'crc', e, eExt));
          continue;
        }
        if (isIgnoredFile(e.name)) continue;
        if (e.crc) {
          // CRC 已知且不匹配 → 这是另一份文件，不能再靠文件名硬套
          // （"不同的 CRC 视为不同的文件"）
          continue;
        }
        if (settings.matchMode !== 'crc') {
          // 条目没有 CRC 时，才退回到文件名匹配
          const entryBase = path.basename(e.name, path.extname(e.name));
          const candLike = { ...cand, base: entryBase, ext: eExt, entryName: e.name };
          byName(candLike, e, eExt);
        }
      }
      // 压缩包本身的名字也可以作为线索（如 "游戏名.zip" 里装的是别的东西）
      // 注意：这里要看「这一个包」有没有命中，而不是全局有没有命中过，
      // 否则扫到第二个包时这条兜底永远不会执行
      if (settings.matchMode !== 'crc' && realEntries.length === 1 && matchCount === matchedBefore) {
        const only = realEntries[0];
        // 条目自带的 CRC 已经证明它不是清单里的任何一条 → 不要再用包名硬套
        if (!only.crc) {
          const onlyExt = path.extname(only.name).toLowerCase();
          const candLike = { ...cand, base: path.basename(only.name, path.extname(only.name)), ext: onlyExt, entryName: only.name };
          byName(candLike, only, onlyExt);
        }
      }
    } else if (cand.container === 'archive') {
      // 7z/rar 暂时无法读 CRC，只能用文件名
      unreadable++;
      if (settings.matchMode !== 'crc') byName(cand);
    } else {
      const nameOnly = settings.matchMode === 'name';
      if (nameOnly) {
        byName(cand);
      } else {
        const key = crcKey(cand.path, cand.size, cand.mtimeMs);
        let crc = store.cacheGet(key);
        if (crc) {
          crcFromCache++;
        } else if (settings.scanMode === 'fast' && cand.size > 64 * 1024 * 1024) {
          // 快速模式：大文件跳过内容校验
          if (settings.matchMode === 'both') byName(cand);
          crc = null;
        } else {
          try {
            crc = await crc32FileHex(cand.path);
            store.cacheSet(key, crc);
            crcComputed++;
          } catch (e) {
            crc = null;
            // 读不动（权限/占用/坏盘）的文件必须记录下来：
            // 后面绝不能把它当成"清单里没有的多余文件"移走
            cand.readError = e.code || e.message || 'READ_ERROR';
            readErrors++;
            cand.readDiag = await inspectReadFailure(cand.path);
          }
        }
        if (crc) {
          const hit = crcIndex.get(crc);
          if (hit) {
            // CRC32 本身就是权威依据（碰撞概率可忽略），不再因扩展名
            // 与 DAT 声明不同而丢弃：MD 游戏常见 `.md`、`.gen`、`.bin` 混用。
            for (const { game } of hit) {
              addMatch(game, mkSource(cand, 'crc', null, '', crc));
            }
          }
          // CRC 已知但不在 DAT 里 → 判定为「另一份文件」，不再退回文件名匹配。
          // 否则同名但内容不同的改版/汉化版会被误认成清单里那条记录（"不同的
          // CRC 视为不同的文件"）。需要无视 CRC 时把 matchMode 切成 name。
        } else if (settings.matchMode === 'both') {
          // 只有 CRC 根本算不出来（读不动 / 快速模式跳过大文件）时，
          // 才用文件名兜底
          byName(cand);
        }
      }
    }

    if (processed % 10 === 0 || processed === total) report();
    if (processed % 25 === 0) await store.saveCrcCache().catch(() => {});
  }

  await store.saveCrcCache().catch(() => {});

  const games = dat.games.map((g) => {
    const matches = matched.get(g.index) || [];
    // "多份副本"要看内容是否真的不同：同 CRC（或同一个文件）的多个匹配只算一份，
    // 否则 BIOS / 纹理包这类同内容文件会被误报成重复
    const distinct = new Set(matches.map((m) => (
      m.crc ? 'c:' + m.crc.toLowerCase() : 'p:' + m.path + '|' + (m.entryName || '')
    )));
    return {
      index: g.index,
      // imageNumber 必须带出去：列表编号、截图文件名（imURL 下的 0001a.png 之类）
      // 都按它来。少了这个字段前端会退回用数组序号，编号看起来就"变了"，
      // 而且下载截图会拼错地址。
      imageNumber: g.imageNumber || g.index,
      releaseNumber: g.releaseNumber || 0,
      duplicateID: g.duplicateID || '',
      title: g.title,
      comment: g.comment,
      publisher: g.publisher,
      sourceRom: g.sourceRom,
      location: g.location,
      language: g.language,
      romSize: g.romSize,
      saveType: g.saveType,
      crcs: g.crcs,
      im1CRC: g.im1CRC,
      im2CRC: g.im2CRC,
      tags: g.tags,
      ext: g.ext,
      status: matches.length === 0 ? 'missing' : distinct.size > 1 ? 'duplicate' : 'owned',
      matches,
    };
  });

  const owned = games.filter((g) => g.status !== 'missing').length;

  // 候选池里没有被任何游戏认领的文件 —— 可由用户决定是否移到「未识别」目录
  // 读不出来的文件不算在内：宁可留在原地，也不能误判成多余文件
  const unmatched = candidates
    .filter((c) => !usedPaths.has(c.path) && !c.readError)
    .map((c) => ({
      path: c.path,
      relPath: c.relPath,
      name: c.name,
      size: c.size,
      container: c.container,
      reason: c.container === 'archive' ? '无法读取内容的压缩包' : '清单中没有对应条目',
    }));

  const unreadableList = candidates
    .filter((c) => c.readError)
    .map((c) => ({ path: c.path, relPath: c.relPath, error: c.readError, diag: c.readDiag || null }));

  return {
    scannedAt: new Date().toISOString(),
    romDir,
    elapsedMs: Date.now() - started,
    stats: {
      games: games.length,
      owned,
      missing: games.length - owned,
      duplicates: games.filter((g) => g.status === 'duplicate').length,
      files: candidates.length,
      unmatched: unmatched.length,
      readErrors,
      crcComputed,
      crcFromCache,
      unreadable,
    },
    unmatched,
    unreadableList,
    games,
  };
}

function mkSource(cand, via, entry, entryExt, fileCrc) {
  const entryName = entry ? entry.name : (cand.entryName || '');
  const isZip = !!entry || (cand.container === 'zip' && !!entryName);
  return {
    container: isZip ? 'zip' : cand.container,
    path: cand.path,
    relPath: cand.relPath,
    entryName,
    ext: entry ? entryExt : cand.ext,
    size: entry ? entry.uncompSize : cand.size,
    crc: entry ? normalizeHex(entry.crc) : (fileCrc ? normalizeHex(fileCrc) : ''),
    via, // crc | name
    entryCount: cand.entryCount || 0, // zip 内的文件数，用于判断能否安全移动整包
  };
}

module.exports = { scanLibrary, walkFiles, inspectReadFailure, crcKey, buildNameIndex, matchByName, nameVariants, stripTags, stripIndexPrefix };
