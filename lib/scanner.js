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
 * 「名称 + 大小」模式的精确索引：normalizeKey(标题) + normalizeKey(扩展名)。
 * 与上面的模糊匹配不同，这里只做**精确**比对 —— 用户选这个模式就是想要
 * "名字和大小都对上才算"，不能让"包含关系"蒙混过关。
 */
function buildExactSizeIndex(games) {
  const map = new Map();
  const add = (base, ext, g) => {
    const k = normalizeKey(base) + normalizeKey(ext || '');
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    const arr = map.get(k);
    if (!arr.includes(g)) arr.push(g);
  };
  for (const g of games) {
    const exts = (g.crcs || []).map((c) => c.extension).filter(Boolean);
    const extList = exts.length ? [...new Set(exts)] : (g.ext ? [g.ext] : ['']);
    // 标题 与「去掉标签的 comment」都作为候选名
    const bases = [g.title];
    if (g.comment) bases.push(stripTags(g.comment), g.comment);
    for (const b of bases) {
      if (!b) continue;
      for (const e of extList) add(b, e, g);
    }
  }
  return map;
}

/** 一个文件名在索引里的所有可能键（原样 / 去掉前缀编号） */
function exactKeysFor(fileBase, ext) {
  const keys = new Set();
  keys.add(normalizeKey(fileBase) + normalizeKey(ext || ''));
  const stripped = stripIndexPrefix(fileBase);
  if (stripped && stripped !== fileBase) {
    keys.add(normalizeKey(stripped) + normalizeKey(ext || ''));
  }
  return [...keys];
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
  // 「名称 + 大小」模式：完全跳过 CRC，只认名字与字节数
  // 条目级自定义匹配方式（DAT 编辑里改过的）：
  // 有的话统一用 both（CRC + 名字）再叠加大小匹配，最后按各条目自己的方式过滤，
  // 这样一次遍历就能同时满足多种方式，不用为每种方式各扫一遍。
  const customModes = (dat.games || []).filter((g) => g && g.matchMode);
  const hasCustom = customModes.length > 0;
  const scanMode = hasCustom ? 'both' : settings.matchMode;
  const sizeIndex = (settings.matchMode === 'name-size' || hasCustom)
    ? buildExactSizeIndex(dat.games)
    : null;
  const sizeDiag = new Map(); // game.index -> { actual: [{name,size,expected}] }

  // 「按文件名 + 大小逐文件匹配」索引：条目的文件声明了 name（相对路径/文件名）时启用。
  // 服务「一个游戏 = 一堆文件」的场景（已安装游戏 / 文件夹清单）——
  // 文件名和游戏标题完全对不上，必须按每个文件自己的名字对号。
  const fileSpecIndex = new Map();
  for (const g of dat.games || []) {
    (g.crcs || []).forEach((c) => {
      const n = String(c.name || '').trim();
      if (!n) return;
      const base = n.split(/[\\/]/).pop();
      const dot = base.lastIndexOf('.');
      const specBase = dot > 0 ? base.slice(0, dot) : base;
      const specExt = dot > 0 ? base.slice(dot).toLowerCase() : (c.extension || '');
      for (const k of exactKeysFor(specBase, specExt)) {
        if (!k) continue;
        if (!fileSpecIndex.has(k)) fileSpecIndex.set(k, []);
        fileSpecIndex.get(k).push({ g, spec: c });
      }
    });
  }

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

  const byName = (cand, entry, entryExt, filter) => {
    for (const g of matchByName(cand.base, nameIndex)) {
      if (filter && !filter(g)) continue;
      addMatch(g, mkSource(cand, 'name', entry, entryExt));
    }
  };

  /** 记录「同名但大小对不上」的候选，供详情页解释为什么没匹配上 */
  const noteSizeMiss = (index, name, size, expected) => {
    if (!sizeDiag.has(index)) sizeDiag.set(index, { actual: [] });
    const d = sizeDiag.get(index);
    if (!d.actual.some((a) => a.name === name && a.size === size)) {
      d.actual.push({ name, size, expected });
    }
  };

  /**
   * 名称 + 大小 严格匹配。
   * 返回 true 表示这条候选被某条目认领了。
   */
  const bySize = (cand, entry, entryExt, size) => {
    let hits = [];
    for (const k of exactKeysFor(cand.base, entryExt)) {
      const arr = sizeIndex.get(k);
      if (arr && arr.length) { hits = arr; break; }
    }
    if (!hits.length) return false;
    let claimed = false;
    for (const g of hits) {
      // 条目自带匹配方式时，只处理要求 name-size 的那条
      if (g.matchMode && g.matchMode !== 'name-size') continue;
      // 合并条目的每个文件带各自的大小；普通条目共用 romSize
      const specSizes = (g.crcs || []).map((c) => Number(c.size) || 0).filter((n) => n > 0);
      const expectList = specSizes.length ? specSizes : (g.romSize > 0 ? [g.romSize] : []);
      if (expectList.length && !expectList.includes(size)) {
        noteSizeMiss(g.index, entry && entry.name ? entry.name : cand.name, size, expectList[0]);
        continue;
      }
      addMatch(g, mkSource(cand, 'name-size', entry, entryExt));
      claimed = true;
    }
    return claimed;
  };

  /**
   * 按文件名 + 大小逐文件匹配（多文件条目：声明了 name 的每个文件）。
   * 一个游戏 = 一个文件夹里的一堆文件（已安装游戏）时，文件名与
   * 游戏标题无关，只能按每个文件自己的名字对号；大小逐文件校验。
   */
  const byFileSpec = (base, ext, size, cand, entry, entryExt) => {
    let claimed = false;
    for (const k of exactKeysFor(base, ext || entryExt || '')) {
      const hits = fileSpecIndex.get(k);
      if (!hits) continue;
      for (const { g, spec } of hits) {
        // 条目自带匹配方式时，只处理要求 name-size 的那条
        if (g.matchMode && g.matchMode !== 'name-size') continue;
        // 每个文件按自己声明的大小校验
        if (spec.size > 0 && Number(size) !== spec.size) continue;
        addMatch(g, mkSource(cand, 'name-size', entry, entryExt));
        claimed = true;
      }
    }
    return claimed;
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
        const entryLike = { ...cand, base: path.basename(e.name, eExt), ext: eExt };
        // 逐文件匹配（声明了 name 的多文件条目）
        if (fileSpecIndex.size) byFileSpec(entryLike.base, eExt, e.uncompSize || 0, cand, e, eExt);
        if (scanMode === 'name-size') {
          bySize(entryLike, e, eExt, e.uncompSize || 0);
          continue;
        }
        if (hasCustom && sizeIndex) bySize(entryLike, e, eExt, e.uncompSize || 0);
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
        if (scanMode !== 'crc') {
          // 条目没有 CRC 时，才退回到文件名匹配
          const entryBase = path.basename(e.name, path.extname(e.name));
          const candLike = { ...cand, base: entryBase, ext: eExt, entryName: e.name };
          byName(candLike, e, eExt);
        }
      }
      // 压缩包本身的名字也可以作为线索（如 "游戏名.zip" 里装的是别的东西）
      // 注意：这里要看「这一个包」有没有命中，而不是全局有没有命中过，
      // 否则扫到第二个包时这条兜底永远不会执行
      if (scanMode !== 'crc' && realEntries.length === 1 && matchCount === matchedBefore) {
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
      if (scanMode !== 'crc') byName(cand);
    } else {
      // 逐文件匹配（声明了 name 的多文件条目）：精确「文件名+大小」，先于按标题匹配
      if (fileSpecIndex.size) byFileSpec(cand.base, cand.ext, cand.size, cand, null, cand.ext);
      if (scanMode === 'name-size') {
        bySize(cand, null, cand.ext, cand.size);
        continue;
      }
      // 有自定义方式时：大小匹配只认领「指定了 name-size」的条目，不影响其它条目
      if (hasCustom && sizeIndex) bySize(cand, null, cand.ext, cand.size);
      const nameOnly = scanMode === 'name';
      if (nameOnly) {
        byName(cand);
      } else {
        const key = crcKey(cand.path, cand.size, cand.mtimeMs);
        let crc = store.cacheGet(key);
        if (crc) {
          crcFromCache++;
        } else if (settings.scanMode === 'fast' && cand.size > 64 * 1024 * 1024) {
          // 快速模式：大文件跳过内容校验
          if (scanMode === 'both') byName(cand);
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
              if (game.matchMode && game.matchMode !== 'crc' && game.matchMode !== 'both') continue;
              addMatch(game, mkSource(cand, 'crc', null, '', crc));
            }
          }
          // CRC 已知但不在 DAT 里 → 判定为「另一份文件」，不再退回文件名匹配。
          // 否则同名但内容不同的改版/汉化版会被误认成清单里那条记录（"不同的
          // CRC 视为不同的文件"）。需要无视 CRC 时把 matchMode 切成 name。
        } else if (scanMode === 'both') {
          // 只有 CRC 根本算不出来（读不动 / 快速模式跳过大文件）时，
          // 才用文件名兜底
          byName(cand);
        }
      }
      // 条目自己指定了「按名字」时，不受 CRC 权威规则约束
      if (hasCustom) byName(cand, null, cand.ext, (g) => g.matchMode === 'name');
    }

    if (processed % 10 === 0 || processed === total) report();
    if (processed % 25 === 0) await store.saveCrcCache().catch(() => {});
  }

  await store.saveCrcCache().catch(() => {});

  /**
   * 名称+大小模式的诊断：告诉用户「这条本来该叫什么名字、多大，
   * 实际找到的又是什么」，否则失败了只显示"缺失"，没法排查。
   */
  const buildSizeCheck = (g) => {
    if (!sizeIndex) return undefined;
    // 合并条目的文件带各自大小，期望值逐文件算；普通条目共用 romSize
    const specs = (g.crcs || []).map((c) => ({ ext: c.extension || '', size: Number(c.size) || 0 }));
    const perFile = specs.length > 0 && specs.every((s) => s.size > 0);
    const exts = (g.crcs || []).map((c) => c.extension).filter(Boolean);
    const extList = exts.length ? [...new Set(exts)] : (g.ext ? [g.ext] : ['']);
    const expected = perFile
      ? specs.map((s) => ({ name: (g.title || '') + s.ext, size: s.size }))
      : extList.map((e) => ({ name: (g.title || '') + e, size: g.romSize || 0 }));
    const ms = matched.get(g.index) || [];
    const found = new Set(ms.map((m) => normalizeKey(m.entryName || path.basename(m.path))));
    const missing = expected.filter((x) => !found.has(normalizeKey(x.name))).map((x) => x.name);
    const diag = sizeDiag.get(g.index);
    const actual = diag ? diag.actual : [];
    if (!missing.length && !actual.length) return undefined;
    return { expected, missing, actual };
  };

  /**
   * 多文件条目（合并产生）的对号入座：每个文件都要找到才算拥有。
   * 按 CRC 对号；CRC 对不上（名字匹配到的）补到还没命中的文件上。
   * 同一个文件的多份副本也记进来，用于「这份文件有几个副本」的重复判断。
   */
  const buildFileCheck = (g, matches) => {
    const specs = (g.crcs || []).map((c) => ({
      crc: (c.crc || '').toLowerCase(),
      ext: c.extension || '',
      size: Number(c.size) || 0,
      label: c.label || '',
      name: String(c.name || '').trim(),
    }));
    const found = new Array(specs.length).fill(false);
    const counts = new Array(specs.length).fill(0);
    // 归一化比较要跨平台：路径分隔符 / \ 都可能出现
    const normName = (p) => normalizeKey(String(p || ''));
    for (const m of matches) {
      const mc = (m.crc || '').toLowerCase();
      // 先按 CRC 对号（哪怕已经找到过——那是同一文件的另一份副本）；
      // 再按文件名对号（多文件条目声明了相对路径/文件名时）；
      // 最后才补到还没命中的文件上
      let i = mc ? specs.findIndex((s) => s.crc && s.crc === mc) : -1;
      if (i === -1) {
        const mRaw = m.entryName || m.relPath || '';
        if (mRaw) {
          const mN = normName(mRaw);
          const mB = normName(mRaw.split(/[\\/]/).pop());
          i = specs.findIndex((s, j) => !found[j] && s.name
            && (normName(s.name) === mN || normName(s.name.split(/[\\/]/).pop()) === mB)
            && (!s.size || !m.size || s.size === m.size));
        }
      }
      if (i === -1) i = specs.findIndex((s, j) => !found[j]);
      if (i === -1) i = 0;
      found[i] = true;
      counts[i]++;
    }
    const missing = specs.filter((s, i) => !found[i])
      .map((s) => ({ crc: (s.crc || '').toUpperCase(), ext: s.ext, size: s.size, label: s.label, name: s.name || '' }));
    return {
      total: specs.length,
      found: specs.length - missing.length,
      missing,
      dupes: counts.filter((n) => n > 1).length,
    };
  };

  // 条目自带匹配方式时，只保留符合该方式的证据
  const normalizeMatches = (g, arr) => {
    if (!g.matchMode) return arr;
    if (g.matchMode === 'crc') return arr.filter((m) => m.via === 'crc');
    if (g.matchMode === 'name') return arr.filter((m) => m.via === 'name' || m.via === 'name-size');
    if (g.matchMode === 'name-size') return arr.filter((m) => m.via === 'name-size');
    return arr;
  };

  const games = dat.games.map((g) => {
    const matches = normalizeMatches(g, matched.get(g.index) || []);
    // "多份副本"要看内容是否真的不同：同 CRC（或同一个文件）的多个匹配只算一份，
    // 否则 BIOS / 纹理包这类同内容文件会被误报成重复
    const distinct = new Set(matches.map((m) => (
      m.crc ? 'c:' + m.crc.toLowerCase() : 'p:' + m.path + '|' + (m.entryName || '')
    )));
    // 合并条目 / 文件夹型多文件游戏：全部文件都找到才算拥有（不是任一命中）。
    // 即使一个文件都没对上也要算 fileCheck，这样前端才能列出「缺哪些文件」；
    // 否则完全没扫到的多文件游戏会连缺失清单都没有，没法排查。
    const fc = g.multiFile ? buildFileCheck(g, matches) : null;
    const partial = fc && fc.missing.length > 0;
    let status;
    if (matches.length === 0) status = 'missing';
    else if (partial) status = 'missing';
    else if (g.multiFile) {
      // 多文件条目的「重复」按单个文件的副本数算：
      // 简版 + 繁版各一份是正常拥有，不是重复
      status = fc.dupes > 0 ? 'duplicate' : 'owned';
    } else {
      status = distinct.size > 1 ? 'duplicate' : 'owned';
    }
    const fileCheck = partial
      ? { total: fc.total, found: fc.found, missing: fc.missing }
      : undefined;
    return {
      index: g.index,
      // 多文件（文件夹型）游戏用 fileCheck 按相对路径逐个核对，sizeCheck 的
      // 「标题+扩展名」预期名对它没有意义（会产生 PCSG00127.png 这类垃圾），
      // 而且会和 fileCheck 重复，所以多文件游戏直接跳过 sizeCheck。
      sizeCheck: g.multiFile ? undefined : buildSizeCheck(g),
      fileCheck,
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
      // 合并条目的子条目（被合并进来的原条目），详情页用它做页签切换
      children: (g.children || []).map((c) => ({
        index: c.index,
        imageNumber: c.imageNumber || c.index,
        title: c.title || '',
        comment: c.comment || '',
        publisher: c.publisher || '',
        sourceRom: c.sourceRom || '',
        location: c.location || '',
        language: c.language || '',
        saveType: c.saveType || '',
        romSize: c.romSize || 0,
        im1CRC: c.im1CRC || '',
        crcs: (c.crcs || []).map((x) => ({ crc: x.crc, extension: x.extension, size: x.size || 0, label: x.label || '', name: x.name || '' })),
        tags: c.tags || [],
      })),
      im1CRC: g.im1CRC,
      im2CRC: g.im2CRC,
      tags: g.tags,
      ext: g.ext,
      // 多文件条目（文件夹游戏）：前端据此把 CRC 列 / 详情 CRC 区聚合显示，
      // 而不是把上百个文件的 CRC 逐个铺开
      multiFile: g.multiFile || false,
      overridden: g.overridden || false,
      overrideId: g.overrideId || '',
      sourceIndexes: g.sourceIndexes || [],
      status,
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
