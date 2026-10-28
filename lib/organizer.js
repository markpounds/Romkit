'use strict';
/**
 * 整理（Organizer）：按每个 DAT 独立选择的输出形态落盘。
 *   mode = 'zip'  保留压缩包：每个游戏一个 zip（内含原始 ROM）
 *   mode = 'raw'  保留原始文件：解压/裸文件直出，不打包
 *
 * 默认 copy（不删除源文件），需要移动时由用户在设置里显式开启。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { packFile, extractEntry, listEntries } = require('./zip');
const { crcKey } = require('./scanner');

/**
 * 权限修正：新建文件的权限 = 进程 umask 决定，服务环境里可能是 0600。
 * 这里把权限补到「源文件原样，且至少保证所有人可读」，避免整理后的 ROM
 * 连其他 NAS 用户（含 SMB）都读不了。失败静默（无权限 chmod 时不阻断整理）。
 */
async function applySourceMode(dest, srcPath) {
  try {
    const st = await fsp.stat(srcPath);
    const want = (st.mode & 0o777) | 0o444; // 源文件权限，且保证 group/other 可读
    await fsp.chmod(dest, want);
  } catch (_) {
    await ensureReadable(dest);
  }
}
/** 只补最小的可读位（源文件已不存在时用） */
async function ensureReadable(dest) {
  try {
    const st = await fsp.stat(dest);
    const m = st.mode & 0o777;
    if ((m & 0o044) !== 0o044) await fsp.chmod(dest, m | 0o444);
  } catch (_) {}
}
const { scanLibrary } = require('./scanner');
const store = require('./store');
const naming = require('./naming');

function sanitize(name) {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 150) s = s.slice(0, 150).trim();
  return s || 'unnamed';
}

/** 保证文件名带目标扩展名（已带则不重复追加） */
function ensureExt(name, ext) {
  if (!ext) return name;
  return name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext;
}

/* ---------------- 多盘（Disc 1 / Disc 2 …）识别 ---------------- */
const DISC_RE = /[\(\[]?\b(disc|disk|cd)\s*[_\-. ]?\s*(\d+)(\s*of\s*\d+)?\b[\)\]]?/i;

/** 拆出 disc 标记与主体名，如 "Game (Disc 2)" → {tag:'(Disc 2)', base:'Game', num:2} */
function discInfo(name) {
  const m = String(name || '').match(DISC_RE);
  if (!m) return { tag: '', base: String(name || '').trim(), num: 0 };
  let base = String(name).replace(DISC_RE, '');
  base = base.replace(/[\(\[]\s*[\)\]]/g, '').replace(/\s+/g, ' ').replace(/[\s\-_]+$/, '').trim();
  return { tag: m[0].trim(), base, num: parseInt(m[2], 10) || 0 };
}

function sourceBaseName(src) {
  const name = src.entryName || src.relPath || src.path || '';
  return path.basename(name, path.extname(name));
}

/** 同一游戏的多个文件是否构成"多盘"（至少出现两种不同的 disc 标记） */
function isMultiDisc(matches) {
  const tags = new Set();
  for (const m of matches) {
    const { tag } = discInfo(sourceBaseName(m));
    if (tag) tags.add(tag.toLowerCase());
  }
  return tags.size >= 2;
}

/* ---------------- 纹理包识别 ---------------- */
const TEXTURE_RE = /[\(\（\[]?\s*(纹理包|材质包|高清纹理|高清材质|texture\s*pack|hd\s*textures?)\s*[\)\）\]]?/i;

/** 拆出「纹理包」标记与主体名，如 "Game (纹理包)" → {tag:'(纹理包)', base:'Game'} */
function textureInfo(name) {
  const s = String(name || '');
  const m = s.match(TEXTURE_RE);
  if (!m) return { tag: '', base: s.trim() };
  let base = s.replace(TEXTURE_RE, '');
  base = base.replace(/[\(\（\[]\s*[\)\）\]]/g, '').replace(/\s+/g, ' ').replace(/[\s\-_]+$/, '').trim();
  return { tag: m[0].trim(), base };
}

/* ---------------- BIOS 识别 ---------------- */
const BIOS_RE = /[\(\（\[]?\s*(bios|内置\s*bios|系统\s*bios)\s*[\)\）\]]?/i;

/** 拆出「(Bios)」标记与主体名，如 "Game (Bios)" → {tag:'(Bios)', base:'Game'} */
function biosInfo(name) {
  const s = String(name || '');
  const m = s.match(BIOS_RE);
  if (!m) return { tag: '', base: s.trim() };
  let base = s.replace(BIOS_RE, '');
  base = base.replace(/[\(\（\[]\s*[\)\）\]]/g, '').replace(/\s+/g, ' ').replace(/[\s\-_]+$/, '').trim();
  return { tag: m[0].trim(), base };
}

/** 通用变体分组：把「带标记」与「不带标记」的同名条目收到同一个文件夹 */
function buildVariantGroups(dat, settings, enabled, infoFn) {
  const map = new Map();
  if (!enabled || settings.mode !== 'raw') return map;
  const byBase = new Map();
  for (const g of dat.games || []) {
    const t = infoFn(g.title || g.comment || '');
    const key = t.base.toLowerCase();
    if (!key) continue;
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push({ g, t });
  }
  for (const arr of byBase.values()) {
    if (arr.length < 2) continue;
    const plain = arr.find((x) => !x.t.tag);
    if (!plain || !arr.some((x) => x.t.tag)) continue;
    const baseRaw = renderName(settings.fileTemplate, plain.g, { ext: '' });
    const bi = infoFn(baseRaw);
    const folder = sanitize(bi.base || baseRaw || ('Game ' + plain.g.index));
    for (const x of arr) map.set(x.g.index, { folder, tag: x.t.tag, plain: plain.g });
  }
  return map;
}

function renderName(template, game, source) {
  const ext = (source && source.ext) || (game.crcs && game.crcs[0] && game.crcs[0].extension) || '';
  return sanitize(naming.render(template, game, { ext }));
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 重复副本的存放目录：优先单独指定，其次复用未识别目录，最后落到工具自己的目录 */
function resolveDuplicateDir(lib, settings) {
  const custom = (settings.duplicateDir || '').trim() || (settings.unmatchedDir || '').trim();
  if (custom) return custom;
  return path.join(store.DATA_DIR, 'duplicates', lib.id);
}

/**
 * 给一个游戏的多个副本打分，分高的作为"保留项"。
 * 判断依据（优先级从高到低）：
 *   外层文件名与模板一致 > 压缩包内条目名与模板一致 > CRC 匹配 > 裸文件 > 单条目压缩包
 */
function rankMatches(game, matches, settings) {
  const expectedFile = sanitize(naming.render(settings.fileTemplate, game, { ext: '' })).toLowerCase();
  const expectedArc = sanitize(naming.render(settings.archiveTemplate, game, { ext: '' })).toLowerCase();
  const scoreOf = (m) => {
    let s = 0;
    const outer = path.basename(m.relPath || m.path || '', path.extname(m.relPath || m.path || '')).toLowerCase();
    if (outer && (outer === expectedArc || outer === expectedFile)) s += 100;
    else if (expectedFile && outer.startsWith(expectedFile)) s += 60; // 模板名 + 变体标记，如 "... (Bios)"
    if (m.entryName) {
      const inner = path.basename(m.entryName, path.extname(m.entryName)).toLowerCase();
      if (inner && inner === expectedFile) s += 50;
    }
    if (m.via === 'crc') s += 10;
    if (m.container === 'file') s += 3;
    if (m.entryCount === 1) s += 1;
    return s;
  };
  return [...matches].map((m) => ({ m, s: scoreOf(m) })).sort((a, b) => b.s - a.s).map((x) => x.m);
}

/** 生成整理计划（不落盘） */
async function buildPlan(lib, scan, dat) {
  const settings = { ...store.DEFAULT_SETTINGS, ...(lib.settings || {}) };
  const outDir = (settings.outDir || '').trim();
  if (!outDir) throw new Error('尚未设置输出目录');

  const targets = scan.games.filter((g) => g.status !== 'missing');
  const plan = { items: [], conflicts: 0, missingOutDir: false, outDir };

  /**
   * 多盘分组（跨 DAT 条目）。
   * 很多 DAT（如 DC）把 Disc 1 / Disc 2 记成两个独立条目、不同编号，
   * 但标题去掉 disc 标记后完全相同 —— 靠这个把它们归到一组。
   * 返回：gameIndex -> { folder, tag }
   */
  const discGroups = new Map();
  if (settings.multiDiscFolder && settings.mode === 'raw') {
    const byKey = new Map();
    for (const g of dat.games || []) {
      const d = discInfo(g.title || g.comment || '');
      if (!d.tag || !d.num) continue;
      // DAT 惯例：同一游戏的多盘共用同一个 imageNumber，配合"去掉 disc 后的标题"最稳
      const key = '#' + (g.imageNumber || g.index) + '|' + d.base.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ g, d });
    }
    for (const arr of byKey.values()) {
      const tags = new Set(arr.map((x) => x.d.tag.toLowerCase()));
      if (tags.size < 2) continue; // 只有一个盘，不算多盘组
      const baseGame = arr[0].g; // 编号最小的那个作为基准（通常是 Disc 1）
      const baseRaw = renderName(settings.fileTemplate, baseGame, { ext: '' });
      const bi = discInfo(baseRaw);
      const folder = sanitize(bi.base || baseRaw || ('Game ' + baseGame.index));
      for (const x of arr) discGroups.set(x.g.index, { folder, tag: x.d.tag, plain: baseGame });
    }
  }

  /**
   * 纹理包分组：带「(纹理包)」的条目与同名的普通条目，收进以普通条目命名的文件夹。
   * 仅「保留原始文件」模式生效。
   */
  const textureGroups = buildVariantGroups(dat, settings, settings.texturePackFolder, textureInfo);

  /** BIOS 分组：带「(Bios)」的条目与主文件收进同一文件夹 */
  const biosGroups = buildVariantGroups(dat, settings, settings.biosGroupFolder, biosInfo);

  /**
   * 每个游戏"打算保留的那一份"是谁。
   * 只有被别的条目选为保留项的文件才需要保护 —— 它可能正在被另一个游戏使用。
   * （早期版本按"被几个条目引用"判断，结果公共 BIOS 被第一个条目占住，
   *   其他条目的 BIOS 就再也输不出去了。）
   */
  // 分组条目（多盘 / 纹理包 / BIOS）的名字评判要用主条目的标题，
  // 否则 "...(Bios)" 自身的标题反而对不上 "主名 + (Bios)" 的实际文件名
  const rankGameFor = (g) => {
    const d = discGroups.get(g.index);
    if (d && d.plain) return d.plain;
    const t = textureGroups.get(g.index);
    if (t && t.plain) return t.plain;
    const b = biosGroups.get(g.index);
    if (b && b.plain) return b.plain;
    return g;
  };

  const keepUsers = new Map();
  for (const g of targets) {
    const best = rankMatches(rankGameFor(g), g.matches, settings)[0];
    if (!best) continue;
    if (!keepUsers.has(best.path)) keepUsers.set(best.path, []);
    keepUsers.get(best.path).push(g.index);
  }

  /**
   * 合并条目：它的每个文件其实是合并进来的一个「子条目」，
   * 各自按自己的编号/标题输出（0023 简、0024 繁），不能当成同一游戏的重复副本。
   * 只有同一个子条目内部出现多份同 CRC 的文件，才算真正的重复副本。
   */
  const childMatchesOf = (game, child) => {
    const set = new Set((child.crcs || []).map((c) => (c.crc || '').toLowerCase()).filter(Boolean));
    if (!set.size) return [];
    return (game.matches || []).filter((m) => m.crc && set.has(m.crc.toLowerCase()));
  };

  const planChildItem = async (game, child, childMs, keepUsers) => {
    if (!childMs.length) return;
    const ranked = rankMatches(child, childMs, settings);
    const source = ranked[0];
    if (!source) return;
    const owners = keepUsers.get(source.path) || [];
    if (owners.length > 1 && owners[0] !== game.index) {
      plan.items.push({ game: child, source, dest: source.path, action: 'skip', reason: '该文件已归入其他条目' });
      return;
    }
    const ext = source.ext || (child.crcs && child.crcs[0] && child.crcs[0].extension) || '';
    const fileBase = renderName(settings.fileTemplate, child, { ext });
    const arcBase = renderName(settings.archiveTemplate, child, { ext });
    const destName = settings.mode === 'zip' ? ensureExt(arcBase, '.zip') : ensureExt(fileBase, ext);
    const dest = path.join(outDir, destName);
    if (!isInside(outDir, dest)) {
      plan.items.push({ game: child, source, dest, action: 'skip', reason: '非法的目标路径' });
      return;
    }
    const innerExt = ext || '';
    const entryName = settings.entryRename === false
      ? (source.entryName || path.basename(source.path))
      : ensureExt(fileBase, innerExt);
    let exists = false;
    try { await fsp.access(dest); exists = true; } catch (_) {}

    let action;
    if (source.container === 'zip' && settings.mode === 'zip') action = 'copy-zip';
    else if (settings.mode === 'zip') action = 'pack';
    else action = source.container === 'zip' ? 'extract' : 'copy-file';

    const samePath = path.resolve(source.path) === path.resolve(dest);
    const destIsValidCopy = (game.matches || []).some((m) => path.resolve(m.path) === path.resolve(dest));
    if (exists && (samePath || (destIsValidCopy && settings.conflict !== 'overwrite'))) {
      plan.items.push({
        game: child, source, dest, action: 'already', exists: true, entryName,
        reason: samePath ? '就是文件本身' : '目标位置已有该游戏的文件',
      });
    } else if (exists && settings.conflict === 'skip') {
      plan.items.push({ game: child, source, dest, action: 'skip', reason: '目标已存在', exists: true, entryName });
      plan.conflicts++;
    } else {
      if (exists) plan.conflicts++;
      plan.items.push({
        game: child, source, dest, action, exists, entryName,
        size: source.size,
        relDest: path.relative(outDir, dest),
      });
    }

    // 同一个子条目的多余副本（真重复）：按设置移走或删除
    const extras = ranked.slice(1);
    plan.duplicates = (plan.duplicates || 0) + extras.length;
    if (!extras.length || settings.duplicateAction === 'keep') return;
    const isDelete = settings.duplicateAction === 'delete';
    const dupDir = isDelete ? '' : resolveDuplicateDir(lib, settings);
    for (const ex of extras) {
      if (ex.container === 'zip' && ex.entryCount > 1) {
        plan.duplicateSkipped = (plan.duplicateSkipped || 0) + 1;
        continue;
      }
      if (keepUsers.has(ex.path)) {
        plan.sharedFiles = (plan.sharedFiles || 0) + 1;
        plan.duplicates--;
        continue;
      }
      if (isDelete) {
        plan.items.push({
          game: { index: game.index, title: child.title, comment: '重复副本（删除）' },
          source: ex, dest: ex.path, action: 'delete-duplicate', size: ex.size, duplicate: true,
        });
        continue;
      }
      const dDest = path.join(dupDir, path.basename(ex.path));
      let dExists = false;
      try { await fsp.access(dDest); dExists = true; } catch (_) {}
      if (dExists && settings.conflict === 'skip') {
        plan.items.push({
          game: { index: game.index, title: child.title, comment: '重复副本' },
          source: ex, dest: dDest, action: 'skip', reason: '目标已存在', exists: true, size: ex.size, duplicate: true,
        });
        plan.conflicts++;
        continue;
      }
      plan.items.push({
        game: { index: game.index, title: child.title, comment: '重复副本' },
        source: ex, dest: dDest, action: 'remove-duplicate', exists: dExists, size: ex.size, duplicate: true,
      });
    }
  };

  for (const game of targets) {
    // 合并条目（含子条目）：每个子条目各自输出一份
    if ((game.children || []).length > 1 && (game.matches || []).length) {
      const used = new Set();
      for (const child of game.children) {
        let ms = childMatchesOf(game, child);
        if (!ms.length) {
          // 子条目没有 CRC（罕见）：把还没被其它子条目认领的匹配给它
          ms = (game.matches || []).filter((m) => !m.crc && !used.has(m.path));
        }
        for (const m of ms) used.add(m.path);
        await planChildItem(game, child, ms, keepUsers);
      }
      continue;
    }

    // 同一游戏可能有多份副本：按"文件名是否符合模板"排序，最正确的那份作为保留项
    const ranked = rankMatches(rankGameFor(game), game.matches, settings);
    const source = ranked[0];
    if (!source) continue;

    // 同一个文件被多个条目同时选为"保留项"（公共 BIOS 之类）：只让第一个条目输出
    const users = keepUsers.get(source.path) || [game.index];
    if (users.length > 1 && users[0] !== game.index) {
      plan.items.push({ game, source, dest: source.path, action: 'skip', reason: '该文件已归入其他条目' });
      continue;
    }

    // 多盘游戏（同一 DAT 条目下的多个盘）：全部保留，收进同一个子文件夹
    if (!discGroups.has(game.index) && settings.multiDiscFolder && settings.mode === 'raw' && ranked.length > 1 && isMultiDisc(ranked)) {
      const rawBase = renderName(settings.fileTemplate, game, { ext: '' });
      const gInfo = discInfo(rawBase);
      const folderName = sanitize(gInfo.base || rawBase || ('Game ' + game.index));
      for (const m of ranked) {
        const ext = m.ext || (game.crcs[0] && game.crcs[0].extension) || '';
        const d = discInfo(sourceBaseName(m));
        const leaf = sanitize(d.tag ? `${folderName} ${d.tag}` : folderName);
        const dest = path.join(outDir, folderName, ensureExt(leaf, ext));
        if (!isInside(outDir, dest)) {
          plan.items.push({ game, source: m, dest, action: 'skip', reason: '非法的目标路径' });
          continue;
        }
        let exists = false;
        try {
          await fsp.access(dest);
          exists = true;
        } catch (_) {}
        const samePath = path.resolve(m.path) === path.resolve(dest);
        const destIsCopy = game.matches.some((x) => path.resolve(x.path) === path.resolve(dest));
        if (exists && (samePath || (destIsCopy && settings.conflict !== 'overwrite'))) {
          plan.items.push({ game, source: m, dest, action: 'already', exists: true, disc: true, entryName: d.tag });
        } else if (exists && settings.conflict === 'skip') {
          plan.items.push({ game, source: m, dest, action: 'skip', reason: '目标已存在', exists: true, disc: true, entryName: d.tag });
          plan.conflicts++;
        } else {
          if (exists) plan.conflicts++;
          plan.items.push({
            game, source: m, dest,
            action: m.container === 'zip' ? 'extract' : 'copy-file',
            exists, disc: true, entryName: d.tag,
            size: m.size,
            relDest: path.relative(outDir, dest),
          });
        }
      }
      plan.multiDiscGames = (plan.multiDiscGames || 0) + 1;
      continue;
    }

    const ext = source.ext || (game.crcs[0] && game.crcs[0].extension) || '';
    const fileBase = renderName(settings.fileTemplate, game, { ext });
    const arcBase = renderName(settings.archiveTemplate, game, { ext });

    let destName;
    const dg = discGroups.get(game.index);
    const tg = textureGroups.get(game.index);
    const bg = biosGroups.get(game.index);
    // 分组条目的文件名用它**自己**的模板渲染（编号、标题都与列表一致），
    // 只把所在文件夹统一成主条目的名字
    if (dg) {
      destName = path.join(dg.folder, ensureExt(fileBase, ext));
      plan._discFolders = plan._discFolders || new Set();
      plan._discFolders.add(dg.folder);
    } else if (tg) {
      destName = path.join(tg.folder, ensureExt(fileBase, ext));
      plan._textureFolders = plan._textureFolders || new Set();
      plan._textureFolders.add(tg.folder);
    } else if (bg) {
      destName = path.join(bg.folder, ensureExt(fileBase, ext));
      plan._biosFolders = plan._biosFolders || new Set();
      plan._biosFolders.add(bg.folder);
    } else if (settings.mode === 'zip') {
      destName = ensureExt(arcBase, '.zip');
    } else {
      destName = ensureExt(fileBase, ext);
    }

    const dest = path.join(outDir, destName);
    if (!isInside(outDir, dest)) {
      plan.items.push({ game, source, dest, action: 'skip', reason: '非法的目标路径' });
      continue;
    }

    // zip 内条目名：可选按模板改名，或保留原始文件名
    const innerExt = ext || '';
    const entryName = settings.entryRename === false
      ? (source.entryName || path.basename(source.path))
      : ensureExt(fileBase, innerExt);

    let exists = false;
    try {
      await fsp.access(dest);
      exists = true;
    } catch (_) {}

    let action;
    if (source.container === 'zip' && settings.mode === 'zip') action = 'copy-zip';
    else if (settings.mode === 'zip') action = 'pack';
    else action = source.container === 'zip' ? 'extract' : 'copy-file';

    // 目标位置已经有这个游戏的某个副本了 → 无需再生成一份（否则会产生 "xxx (1).zip"）
    const samePath = path.resolve(source.path) === path.resolve(dest);
    const destIsValidCopy = game.matches.some((m) => path.resolve(m.path) === path.resolve(dest));
    if (exists && (samePath || (destIsValidCopy && settings.conflict !== 'overwrite'))) {
      plan.items.push({
        game, source, dest, action: 'already', exists: true, entryName,
        reason: samePath ? '就是文件本身' : '目标位置已有该游戏的文件',
      });
    } else if (exists && settings.conflict === 'skip') {
      // 目标被别的文件占着（不是这个游戏的副本）：按设置跳过，但重复副本仍要清理
      plan.items.push({ game, source, dest, action: 'skip', reason: '目标已存在', exists: true, entryName });
      plan.conflicts++;
    } else {
      if (exists) plan.conflicts++;
      plan.items.push({
        game, source, dest, action, exists, entryName,
        size: source.size,
        relDest: path.relative(outDir, dest),
      });
    }

    // 其余副本：只保留文件名正确的那一份，剩下的移走或删除
    const extras = ranked.slice(1);
    const keepCrc = (source.crc || '').toLowerCase();
    plan.duplicates = (plan.duplicates || 0) + extras.length;
    if (extras.length && settings.duplicateAction !== 'keep') {
      const isDelete = settings.duplicateAction === 'delete';
      const dupDir = isDelete ? '' : resolveDuplicateDir(lib, settings);
      for (const ex of extras) {
        if (ex.container === 'zip' && ex.entryCount > 1) {
          plan.duplicateSkipped = (plan.duplicateSkipped || 0) + 1;
          continue;
        }
        // 这个文件正是别的条目要保留的那一份（公共 BIOS）→ 不能当副本移走
        if (keepUsers.has(ex.path)) {
          plan.sharedFiles = (plan.sharedFiles || 0) + 1;
          plan.duplicates--;
          continue;
        }
        if (isDelete) {
          plan.items.push({
            game: { index: game.index, title: game.title, comment: '重复副本（删除）' },
            source: ex, dest: ex.path, action: 'delete-duplicate', size: ex.size, duplicate: true,
          });
          continue;
        }
        const dDest = path.join(dupDir, path.basename(ex.path));
        let dExists = false;
        try {
          await fsp.access(dDest);
          dExists = true;
        } catch (_) {}
        if (dExists && settings.conflict === 'skip') {
          plan.items.push({
            game: { index: game.index, title: game.title, comment: '重复副本' },
            source: ex, dest: dDest, action: 'skip', reason: '目标已存在', exists: true, size: ex.size, duplicate: true,
          });
          plan.conflicts++;
          continue;
        }
        plan.items.push({
          game: { index: game.index, title: game.title, comment: '重复副本' },
          source: ex, dest: dDest, action: 'remove-duplicate', exists: dExists, size: ex.size, duplicate: true,
        });
      }
    }
  }

  // 未识别 / 多余文件：可选移到一个单独目录，保持 ROM 目录干净
  const unmatchedDir = (settings.unmatchedDir || '').trim();
  if (settings.unmatchedAction === 'move' && unmatchedDir) {
    const romDir = (settings.romDir || '').trim();
    const sameAsRom = romDir && path.resolve(unmatchedDir) === path.resolve(romDir);
    const insideRom = romDir && isInside(romDir, unmatchedDir);
    if (sameAsRom || insideRom) {
      plan.warning = '「未识别文件」目录位于 ROM 目录内部，移动后下次扫描可能再次被扫到，建议放到 ROM 目录之外。';
    }
    for (const u of scan.unmatched || []) {
      const dest = path.join(unmatchedDir, path.basename(u.path));
      let exists = false;
      try {
        await fsp.access(dest);
        exists = true;
      } catch (_) {}
      if (exists && settings.conflict === 'skip') {
        plan.items.push({
          game: { index: 0, title: u.relPath, comment: '未识别文件' },
          source: { path: u.path, relPath: u.relPath, container: u.container, size: u.size, ext: path.extname(u.path) },
          dest, action: 'skip', reason: '目标已存在', exists: true, size: u.size, unmatched: true,
        });
        plan.conflicts++;
        continue;
      }
      plan.items.push({
        game: { index: 0, title: u.relPath, comment: '未识别文件' },
        source: { path: u.path, relPath: u.relPath, container: u.container, size: u.size, ext: path.extname(u.path) },
        dest, action: 'move-unmatched', exists, size: u.size, unmatched: true,
        relDest: path.relative(unmatchedDir, dest),
      });
    }
  }

  if (plan._discFolders) {
    plan.multiDiscGames = (plan.multiDiscGames || 0) + plan._discFolders.size;
    delete plan._discFolders;
  }
  if (plan._textureFolders) {
    plan.textureGroups = (plan.textureGroups || 0) + plan._textureFolders.size;
    delete plan._textureFolders;
  }
  if (plan._biosFolders) {
    plan.biosGroups = (plan.biosGroups || 0) + plan._biosFolders.size;
    delete plan._biosFolders;
  }

  // 文件名撞车消歧：%u 现在用 DAT 的 imageNumber，而这个编号在 DAT 里
  // 会被多条记录共用（本体与 DLC、多盘、BIOS）。同一批计划里如果两条
  // 落到同一个目标路径，后来的会覆盖前面的（conflict=skip 时则被跳过）。
  // 这里统一给后来的追加 -2、-3，让每个条目都能落盘且顺序稳定。
  await dedupePlanDests(plan);

  return plan;
}

/** 同一批计划内目标路径重复时，给第 2 个及以后的追加 -2、-3… */
async function dedupePlanDests(plan) {
  const seen = new Map(); // 小写目标路径 -> 已出现次数
  for (const it of plan.items || []) {
    if (!it || !it.dest) continue;
    // 只有真正会写出文件的动作才需要消歧
    if (it.action !== 'copy-file' && it.action !== 'extract'
      && it.action !== 'pack' && it.action !== 'copy-zip') continue;
    const key = it.dest.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === 1) continue;
    const dir = path.dirname(it.dest);
    const ext = path.extname(it.dest);
    let base = path.basename(it.dest, ext);
    // 去掉上一次追加的后缀，避免 "xxx-2-2"
    base = base.replace(/-\d+$/, '');
    let cand = path.join(dir, `${base}-${n}${ext}`);
    // 极端情况下 -2 也已被占用，继续往后找
    let guard = n;
    while (seen.has(cand.toLowerCase()) && guard < 999) {
      guard++;
      cand = path.join(dir, `${base}-${guard}${ext}`);
    }
    seen.set(cand.toLowerCase(), 1);
    it.dest = cand;
    if (it.relDest) {
      const relDir = path.dirname(it.relDest);
      it.relDest = path.join(relDir === '.' ? '' : relDir, path.basename(cand));
    }
    it.deduped = true;
    // 目标变了，之前算的「已存在」不再作数，重新确认一次
    let exists = false;
    try { await fsp.access(cand); exists = true; } catch (_) {}
    it.exists = exists;
  }
}

/**
 * 探测目录是否可写。
 * 只看 fs.access(W_OK) 在 SMB/ACL/飞牛这类环境下并不可靠（root 或 ACL 会骗过它），
 * 实际建一个临时文件再删掉才作数。返回 {ok, code, message}。
 */
async function probeWritable(dir) {
  if (!dir) return { ok: false, code: 'ENOENT', message: '目录为空' };
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    return { ok: false, code: e.code || 'MKDIR_FAILED', message: '无法创建目录：' + dir };
  }
  const probe = path.join(dir, '.romkit-write-test-' + process.pid + '-' + Date.now());
  try {
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || 'EACCES', message: '目录不可写：' + dir };
  }
}

/**
 * 整理前的写入权限预检。
 * 飞牛上最常见的失败是「目录只给了读权限」，不预检的话会整理到一半
 * 逐条失败（例如把未识别文件搬到 backup 目录时 EACCES），用户只看到
 * 一堆 rename 报错却不知道是哪个目录没权限。
 */
async function preflightWriteDirs(dirs) {
  const uniq = [...new Set(dirs.filter(Boolean).map((d) => path.resolve(d)))];
  const bad = [];
  for (const d of uniq) {
    const r = await probeWritable(d);
    if (!r.ok) bad.push({ dir: d, code: r.code, message: r.message });
  }
  if (bad.length) {
    const list = bad.map((b) => `  · ${b.dir}（${b.code}）`).join('\n');
    const err = new Error(
      '以下目录没有写入权限，整理无法进行：\n' + list +
      '\n\n请在飞牛「应用设置 → 目录访问权限」里给这些目录授予读写权限后重试。'
    );
    err.code = bad[0].code;
    err.badDirs = bad;
    throw err;
  }
}

async function executePlan(lib, plan, opts = {}) {
  const settings = { ...store.DEFAULT_SETTINGS, ...(lib.settings || {}) };
  const onProgress = opts.onProgress || (() => {});
  const isCancelled = opts.isCancelled || (() => false);
  const dryRun = !!opts.dryRun;
  const outDir = plan.outDir;
  // 临时目录只用于「保留压缩包」时的重打包。优先放在输出目录下（同盘移动最快），
  // 输出目录不可写时（飞牛上很常见：只给了读权限）降级到系统临时目录，
  // 不要让一个临时目录创建失败把整个整理任务判死。
  let tmpDir = path.join(outDir, '.romkit-tmp');
  const log = [];
  // 预检阶段发现不可写的目录（输出目录以外），以及因此被跳过的条目数
  let blockedDirs = [];
  let permissionBlocked = 0;

  if (!dryRun) {
    // 写入权限预检分两档：
    //   ① 输出目录不可写 → 整个任务没意义，直接失败
    //   ② 未识别/重复副本的目标目录、或需要「搬走源文件」的源目录不可写
    //      → 只跳过受影响的那几条，别让 8 条权限问题毁掉 687 条能成功的整理
    {
      const outProbe = await probeWritable(outDir);
      if (!outProbe.ok) {
        const err = new Error(
          `输出目录没有写权限：${outDir}（${outProbe.code}）\n` +
          '请在飞牛「应用设置 → 目录访问权限」里给该目录授予读写权限后重试。'
        );
        err.code = outProbe.code;
        err.dir = outDir;
        throw err;
      }

      // 逐条算出「这条要成功，必须哪些目录可写」
      const needOf = (it) => {
        if (!it || !it.source || !it.source.path) return [];
        const srcDir = path.dirname(it.source.path);
        if (it.action === 'move-unmatched' || it.action === 'remove-duplicate') {
          return [it.dest && path.dirname(it.dest), srcDir].filter(Boolean);
        }
        if (it.action === 'delete-duplicate') return [srcDir];
        if (settings.operation === 'move') return [srcDir];
        return [];
      };

      const riskDirs = new Set();
      for (const it of plan.items || []) for (const d of needOf(it)) riskDirs.add(d);
      const badDirs = new Set();
      for (const d of [...riskDirs].slice(0, 30)) {
        const r = await probeWritable(d);
        if (!r.ok) badDirs.add(path.resolve(d));
      }
      if (badDirs.size) {
        let blocked = 0;
        for (const it of plan.items || []) {
          const miss = needOf(it).filter((d) => badDirs.has(path.resolve(d)));
          if (!miss.length) continue;
          if (it.action === 'skip' || it.action === 'already') continue;
          it.action = 'skip';
          it.reason = '目录不可写，已跳过：' + miss[0];
          blocked++;
        }
        blockedDirs = [...badDirs];
        permissionBlocked = blocked;
        for (const d of badDirs) {
          log.push({
            level: 'warn',
            title: '目录不可写',
            reason: d + '（请在飞牛应用设置里授予读写权限；本次已跳过受影响的条目）',
          });
        }
      }
    }

    await fsp.mkdir(outDir, { recursive: true }).catch((e) => {
      // 输出目录本身建不出来 → 这才是真正的致命错误，给出可操作的提示
      if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
        const err = new Error(
          `输出目录没有写权限：${outDir}\n` +
          '请在飞牛「应用设置 → 目录访问权限」里给该目录授予读写权限后重试。'
        );
        err.code = e.code;
        err.dir = outDir;
        throw err;
      }
      if (e && e.code === 'ENOTDIR') {
        const err = new Error(
          `输出目录不可用：${outDir}\n` +
          '路径上存在同名文件（不是文件夹），请换一个输出目录。'
        );
        err.code = e.code;
        err.dir = outDir;
        throw err;
      }
      throw e;
    });
    try {
      await fsp.mkdir(tmpDir, { recursive: true });
    } catch (e) {
      const fallback = path.join(os.tmpdir(), 'romkit-tmp-' + (lib.id || 'x'));
      try {
        await fsp.mkdir(fallback, { recursive: true });
        tmpDir = fallback;
        log.push({
          level: 'warn',
          title: '临时目录回退',
          reason: `输出目录下无法创建 .romkit-tmp（${(e && e.code) || e.message}），已改用 ${fallback}`,
        });
      } catch (_) {
        throw e; // 系统临时目录也建不出来，只能如实报错
      }
    }
  }

  const result = {
    done: 0, skipped: 0, failed: 0, moved: 0, prunedDirs: 0, byAction: {}, errors: [], planned: plan.items.length, log,
    blockedDirs, permissionBlocked,
  };
  const total = plan.items.length;
  const touchedDirs = new Set(); // 被搬走过文件的目录，用于整理后清理空文件夹
  const markDone = (it) => {
    result.done++;
    result.byAction[it.action] = (result.byAction[it.action] || 0) + 1;
    if (it.action === 'move-unmatched' || it.action === 'remove-duplicate' || it.action === 'delete-duplicate') result.moved++;
  };

  for (let i = 0; i < plan.items.length; i++) {
    if (isCancelled()) break;
    const it = plan.items[i];
    const label = it.game.title || it.game.comment || '#' + it.game.index;
    onProgress({
      phase: 'execute',
      message: label,
      current: i + 1,
      total,
      done: result.done,
      failed: result.failed,
      skipped: result.skipped,
    });

    if (it.action === 'skip') {
      result.skipped++;
      log.push({ level: 'skip', title: label, reason: it.reason, dest: it.dest, gameIndex: it.game && it.game.index, sourcePath: it.source && it.source.path });
      continue;
    }
    if (it.action === 'already') {
      // 目标位置已经是这个游戏的文件，什么都不用做
      markDone(it);
      log.push({ level: 'ok', title: label, action: 'already', dest: it.dest, gameIndex: it.game && it.game.index, sourcePath: it.source && it.source.path });
      continue;
    }
    if (dryRun) {
      markDone(it);
      log.push({ level: 'plan', title: label, action: it.action, dest: it.dest });
      continue;
    }

    try {
      let dest = it.dest;
      if (it.exists) {
        if (settings.conflict === 'overwrite') {
          await fsp.rm(dest, { force: true });
        } else if (settings.conflict === 'rename') {
          dest = await uniqueName(dest);
        }
      }
      // copyFile / extractEntry 都不会自动建目录（多盘输出到子文件夹时必须先建）
      await fsp.mkdir(path.dirname(dest), { recursive: true });

      if (it.action === 'delete-duplicate') {
        await fsp.rm(it.source.path, { force: true });
        touchedDirs.add(path.dirname(it.source.path));
      } else if (it.action === 'move-unmatched' || it.action === 'remove-duplicate') {
        await moveFile(it.source.path, dest);
        touchedDirs.add(path.dirname(it.source.path));
      } else if (it.action === 'copy-zip') {
        // 源本身就是单条目 zip，直接复制最快；若需要重命名内部条目则必须重新打包
        const entries = await listEntries(it.source.path).catch(() => []);
        const real = entries.filter((e) => !e.isDir);
        const only = real.length === 1 ? real[0] : real.find((e) => e.name === it.source.entryName);
        const needRename = !!(only && it.entryName && only.name !== it.entryName);
        if (only && (only.method === 0 || only.method === 8) && !needRename) {
          await fsp.copyFile(it.source.path, dest);
          await applySourceMode(dest, it.source.path);
        } else {
          await repackZip(it, dest, tmpDir);
          await ensureReadable(dest);
        }
      } else if (it.action === 'pack') {
        await repackZip(it, dest, tmpDir);
      } else if (it.action === 'extract') {
        const entries = await listEntries(it.source.path);
        const real = entries.filter((e) => !e.isDir);
        const only = real.find((e) => e.name === it.source.entryName) || real[0];
        if (!only) throw new Error('压缩包内未找到 ROM 条目');
        await extractEntry(it.source.path, only, dest);
        await applySourceMode(dest, it.source.path).catch(() => ensureReadable(dest));
      } else {
        await fsp.copyFile(it.source.path, dest);
        await applySourceMode(dest, it.source.path);
      }

      const movedAway = it.action === 'move-unmatched' || it.action === 'remove-duplicate' || it.action === 'delete-duplicate';
      if (!movedAway && settings.operation === 'move' && it.source.container === 'file') {
        await fsp.rm(it.source.path, { force: true }).catch(() => {});
        touchedDirs.add(path.dirname(it.source.path));
      } else if (!movedAway && settings.operation === 'move' && it.source.container === 'zip') {
        // 整包移动有风险（包里可能还有别的 ROM），仅当包内只有这一个条目时才删
        const entries = (await listEntries(it.source.path).catch(() => [])).filter((e) => !e.isDir);
        if (entries.length === 1) {
          await fsp.rm(it.source.path, { force: true }).catch(() => {});
          touchedDirs.add(path.dirname(it.source.path));
        }
      }

      markDone(it);
      // 内容原样搬到新路径的（裸文件复制/移动、zip 内条目解压），
      // 把 CRC 缓存一起写到新路径上，下次扫描直接命中，不用再读整个文件
      if ((it.action === 'extract' || it.source.container === 'file') && it.source.crc) {
        try {
          const st = await fsp.stat(dest);
          store.cacheSet(crcKey(dest, st.size, st.mtimeMs), it.source.crc);
        } catch (_) {}
      }
      log.push({ level: 'ok', title: label, action: it.action, dest, size: it.size, gameIndex: it.game && it.game.index, sourcePath: it.source && it.source.path });
    } catch (e) {
      result.failed++;
      // 把错误码和涉及的路径一并带出去，否则界面上只有一句
      // "EACCES: permission denied, rename '...'" 很难定位是哪个目录的问题
      const code = e && e.code ? String(e.code) : '';
      const hint = code === 'EACCES' || code === 'EPERM'
        ? '（该目录缺少写权限，请在飞牛的应用设置里授予读写权限）'
        : code === 'ENOSPC'
          ? '（磁盘空间不足）'
          : '';
      let msg = (e && e.message) || String(e);
      if (code && !msg.includes(code)) msg = `${code}: ${msg}`;
      if (hint) msg += hint;
      result.errors.push({ title: label, error: msg, code, source: it.source.path, dest: it.dest });
      log.push({ level: 'error', title: label, error: msg, code, source: it.source.path, dest: it.dest });
    }
  }

  if (!dryRun) {
    // 移动后清理 ROM 目录里的空文件夹（含历史残留），只删空的
    if (settings.pruneEmptyDirs !== false && settings.romDir && result.done > 0) {
      try {
        result.prunedDirs = await pruneEmptyDirs(settings.romDir);
        if (result.prunedDirs) log.push({ level: 'ok', title: '清理空文件夹', action: 'prune', count: result.prunedDirs });
      } catch (_) {}
    }
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await writeLog(lib, result, settings).catch(() => {});
  }
  return result;
}

async function repackZip(it, dest, tmpDir) {
  const src = it.source;
  const fallbackName = (e) => it.entryName || e;
  if (src.container === 'zip') {
    const entries = (await listEntries(src.path)).filter((e) => !e.isDir);
    const only = entries.find((e) => e.name === src.entryName) || entries[0];
    if (!only) throw new Error('压缩包内未找到 ROM 条目');
    const innerExt = path.extname(only.name) || '';
    const tmp = path.join(tmpDir, Date.now() + '-' + Math.random().toString(36).slice(2) + (innerExt || '.bin'));
    try {
      await extractEntry(src.path, only, tmp);
      await packFile(tmp, dest, { entryName: fallbackName(path.basename(only.name)), compress: true });
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  } else {
    await packFile(src.path, dest, {
      entryName: fallbackName(path.basename(src.path)),
      compress: true,
    });
  }
}

/** 收集 root 之下的所有子目录（限制深度，跳过系统目录） */
async function collectDirs(root, maxDepth = 5) {
  const out = [];
  async function walk(dir, depth) {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
      const full = path.join(dir, e.name);
      out.push(full);
      if (depth < maxDepth) await walk(full, depth + 1);
    }
  }
  await walk(path.resolve(root), 1);
  return out;
}

/**
 * 清理 ROM 目录下的空文件夹。
 * 注意：扫描的是整棵目录树，而不只是"本次搬空的那几个"——
 * 之前整理留下的历史空目录也要能清掉。
 * @returns {number} 删除的目录数
 */
async function pruneEmptyDirs(root) {
  const dirs = await collectDirs(root);
  dirs.sort((a, b) => b.length - a.length); // 深的先删，父目录随后才会变空
  let removed = 0;
  for (const d of dirs) {
    try {
      const entries = await fsp.readdir(d);
      if (entries.length === 0) {
        await fsp.rmdir(d);
        removed++;
      }
    } catch (_) {}
  }
  return removed;
}

/** 移动文件（跨盘时自动降级为 复制+删除） */
async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    // rename 会原样保留所有者和权限，优先用它
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      // 跨设备只能复制：新建文件的权限会被 umask 影响，按源文件补回来
      await fsp.copyFile(src, dest);
      await applySourceMode(dest, src).catch(() => {});
      await fsp.rm(src, { force: true });
    } else {
      throw e;
    }
  }
}

async function uniqueName(dest) {
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let n = 1; n < 1000; n++) {
    const cand = path.join(dir, `${base} (${n})${ext}`);
    try {
      await fsp.access(cand);
    } catch (_) {
      return cand;
    }
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

async function writeLog(lib, result, settings) {
  const dir = path.join(store.DATA_DIR, 'logs');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `organize-${lib.id}-${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify({
    library: lib.name,
    at: new Date().toISOString(),
    mode: settings.mode,
    operation: settings.operation,
    outDir: settings.outDir,
    summary: { done: result.done, skipped: result.skipped, failed: result.failed },
    errors: result.errors,
    items: result.log,
  }, null, 2), 'utf8');
  return file;
}

/**
 * 自动分类：扫描「待分类文件夹」，与 DAT 匹配，
 * 命中的文件按命名规则送进输出目录（含多盘/纹理包/BIOS 分组）。
 * 未命中的文件原地不动，留给用户自己看。
 */
async function buildClassifyPlan(lib, dat, inboxDir) {
  const settings = { ...store.DEFAULT_SETTINGS, ...(lib.settings || {}) };
  const scan = await scanLibrary(
    { ...lib, settings: { ...settings, romDir: inboxDir } },
    dat,
    {},
  );
  const plan = await buildPlan(lib, scan, dat);
  // 只保留"要真正输出"的主项：副本、未识别、跳过、已就位的都不要
  plan.items = plan.items.filter((it) => (
    it.action === 'copy-file' || it.action === 'extract'
    || it.action === 'pack' || it.action === 'copy-zip'
  ));
  return { plan, scan };
}

module.exports = { buildPlan, executePlan, buildClassifyPlan, renderName, sanitize };
