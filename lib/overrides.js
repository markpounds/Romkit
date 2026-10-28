'use strict';
/**
 * 条目覆盖层（DAT 编辑）
 *
 * DAT 是外部文件，更新时会被整份替换，所以用户的修改不能写回 DAT，
 * 而是单独存一份「覆盖层」：
 *
 *   data/overrides/<libId>.json
 *   {
 *     version: 1,
 *     entries: [{
 *       id: 'ov_ab12cd34',
 *       name: '显示/整理用的名称（即标题）',
 *       files: [{ ext:'.bin', size:123, crc:'AABBCCDD', label:'简版' }, ...],
 *       fields: { comment, publisher, sourceRom, location, language, saveType, romSize },
 *                                       // 详情页那一列字段；只存改过的，空着 = 跟随 DAT
 *       matchMode: 'dat' | 'crc' | 'name' | 'name-size',
 *       sourceIndexes: [12, 13],        // 来自哪些 DAT 条目（合并来源）
 *       snapshot: [{ index, title, romSize, crcs }],  // 用于和更新后的 DAT 对比
 *       updatedAt: ISO
 *     }]
 *   }
 *
 * 应用规则：每个覆盖条目「吃掉」它引用的 DAT 条目，换成一个合成条目。
 * 合并 = sourceIndexes 有多条；重命名/改匹配方式 = 只有一条。
 * 合成条目沿用最小 sourceIndex 作为 index，这样列表编号（imageNumber）、
 * 待整理集合等既有逻辑都不用改。
 *
 * 匹配语义：多文件条目（合并产生、或 DAT 本来就声明了多个 romCRC）是
 * 「全部命中才算拥有」，不是「任一命中」——缺哪个文件会在详情页列出来。
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let DATA_DIR_GETTER = null;
function setDataDirGetter(fn) { DATA_DIR_GETTER = fn; }
function dir() {
  const base = DATA_DIR_GETTER ? DATA_DIR_GETTER() : path.join(__dirname, '..', 'data');
  return path.join(base, 'overrides');
}
function fileOf(libId) {
  return path.join(dir(), String(libId).replace(/[^\w-]/g, '') + '.json');
}

function emptyBook() { return { version: 1, entries: [] }; }

async function load(libId) {
  try {
    const raw = await fsp.readFile(fileOf(libId), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries)) return emptyBook();
    return data;
  } catch (_) {
    return emptyBook();
  }
}

async function save(libId, data) {
  await fsp.mkdir(dir(), { recursive: true });
  const tmp = fileOf(libId) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, fileOf(libId));
}

/** 从 DAT 条目里取一段快照，用于日后检测「DAT 变了吗」 */
function snapshotOf(g) {
  return {
    index: g.index,
    title: g.title || '',
    romSize: g.romSize || 0,
    crcs: (g.crcs || []).map((c) => ({ crc: c.crc, extension: c.extension })),
  };
}

function sameSnapshot(a, b) {
  if (!a || !b) return false;
  if ((a.title || '') !== (b.title || '')) return false;
  if ((a.romSize || 0) !== (b.romSize || 0)) return false;
  const ka = (a.crcs || []).map((c) => (c.crc || '') + (c.extension || '')).sort().join('|');
  const kb = (b.crcs || []).map((c) => (c.crc || '') + (c.extension || '')).sort().join('|');
  return ka === kb;
}

/** 详情页可编辑的字段；title 指子条目标题（总条目标题走 entry.name） */
const EDITABLE_FIELDS = ['title', 'comment', 'publisher', 'sourceRom', 'location', 'language', 'saveType', 'romSize'];

/** 归一：只保留可编辑字段里的非空值，romSize 转成数字 */
function normalizeFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of EDITABLE_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (k === 'romSize') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
    } else {
      const s = String(v).trim();
      if (s) out[k] = s;
    }
  }
  return out;
}

/**
 * 把覆盖层套到 DAT 上，得到「实际参与扫描/整理」的条目表。
 * 同时算出冲突：引用的条目在 DAT 里没了，或内容变了。
 */
function apply(dat, book) {
  const entries = (book && book.entries) || [];
  if (!entries.length) return { dat, conflicts: [] };

  const byIndex = new Map();
  for (const g of dat.games || []) byIndex.set(g.index, g);

  const consumed = new Set();
  const conflicts = [];
  const synthetic = [];

  for (const e of entries) {
    const reasons = [];
    const snapshots = [];
    let missing = false;
    for (const idx of e.sourceIndexes || []) {
      const cur = byIndex.get(idx);
      if (!cur) { missing = true; reasons.push(`DAT 里已经没有第 ${idx} 条`); continue; }
      snapshots.push(snapshotOf(cur));
      const old = (e.snapshot || []).find((s) => s.index === idx);
      if (old && !sameSnapshot(old, snapshotOf(cur))) {
        reasons.push(`第 ${idx} 条的内容与修改时不同（标题/大小/CRC 变了）`);
      }
      consumed.add(idx);
    }

    const first = (e.sourceIndexes || []).map((i) => byIndex.get(i)).find(Boolean);
    // 单来源（非合并）的覆盖条目：允许把原 DAT 字段镜像到总条目，供列表读取
    const single = (e.sourceIndexes || []).length === 1;
    if (!first && !(e.files || []).length) {
      conflicts.push({ id: e.id, name: e.name, reasons: reasons.length ? reasons : ['引用的条目不存在'] });
      continue;
    }
    if (reasons.length) conflicts.push({ id: e.id, name: e.name, reasons });

    const fields = normalizeFields(e.fields);
    const pick = (key) => (fields[key] !== undefined ? fields[key] : (first ? first[key] : ''));

    const files = (e.files || []).filter((f) => f && (f.crc || f.ext));
    // 文件表（含各自的 size / label）—— 按 CRC 索引，给子条目和扫描共用
    //   size —— 「名称+大小」模式下每个文件按自己的大小判断，而不是共用条目 romSize；
    //   label —— 用户给文件起的标签名（如 简/繁），详情页默认只显示 CRC ID。
    const filesByCrc = new Map(files.map((f) => [(f.crc || '').toUpperCase(), f]));
    const childOv = new Map(
      (e.children || []).map((c) => [Number(c && c.index), normalizeFields(c && c.fields)]),
    );

    // 子条目 = 被合并进来的原条目（各自保留 DATA 里的全部信息，可单独编辑）。
    // 详情页用编号当页签切换它们：信息、CRC、封面图片都跟着切。
    const children = [];
    for (const idx of e.sourceIndexes || []) {
      const g0 = byIndex.get(idx);
      if (!g0) continue;
      const ov = childOv.get(idx) || {};
      // 既看子条目自己的覆盖字段，也看总条目 fields（CSV 批量导入只改 fields、
      // 没动 children，所以子条目必须回退到 fields 才能把改动显示出来）
      const cpick = (key) => (ov[key] !== undefined ? ov[key]
        : (fields[key] !== undefined ? fields[key] : g0[key]));
      children.push({
        index: g0.index,
        imageNumber: g0.imageNumber || g0.index,
        title: ov.title || g0.title || '',
        comment: cpick('comment'),
        publisher: cpick('publisher'),
        sourceRom: cpick('sourceRom'),
        location: cpick('location'),
        language: cpick('language'),
        saveType: cpick('saveType'),
        romSize: ov.romSize !== undefined ? ov.romSize : (g0.romSize || 0),
        // 封面候选地址要用 im1CRC（?crc= 参数）
        im1CRC: g0.im1CRC || '',
        crcs: (g0.crcs || []).map((c) => {
          const f = filesByCrc.get((c.crc || '').toUpperCase());
          return {
            crc: (c.crc || '').toUpperCase(),
            extension: c.extension || '',
            size: (f && Number(f.size)) || g0.romSize || 0,
            label: (f && String(f.label || '').trim()) || '',
          };
        }),
        tags: g0.tags || [],
      });
    }

    // 自建条目（手动新增 / CSV 导入，不引用 DAT 原条目）：没有可引用的
    // 原条目，就把自己包装成唯一「子条目」，详情页的信息列 / 文件表 /
    // 子条目页签才能照常显示。index 用 baseIndex（服务端分配的独立编号）。
    const standalone = !(e.sourceIndexes || []).length;
    if (standalone && children.length === 0) {
      const selfIdx = e.baseIndex || 999999;
      const selfCrcs = files.map((f) => ({
        crc: (f.crc || '').toUpperCase(),
        extension: f.ext || '',
        size: Number(f.size) || 0,
        label: String(f.label || '').trim(),
        name: String(f.name || '').trim(),
      }));
      children.push({
        index: selfIdx,
        imageNumber: selfIdx,
        title: fields.title || e.name || '',
        comment: fields.comment || '',
        publisher: fields.publisher || '',
        sourceRom: fields.sourceRom || '',
        location: fields.location || '',
        language: fields.language || '',
        saveType: fields.saveType || '',
        romSize: fields.romSize !== undefined ? fields.romSize : (selfCrcs[0] ? selfCrcs[0].size : 0),
        im1CRC: '',
        crcs: selfCrcs,
        tags: [],
      });
    }

    // 扫描/整理用的扁平文件表：优先用子条目的（带各自的 size/label），
    // 子条目一个都不存在时（旧数据 / 引用条目已消失）退回文件表
    const crcs = children.length
      ? children.flatMap((c) => c.crcs)
      : files.map((f) => ({
          crc: (f.crc || '').toUpperCase(),
          extension: f.ext || '',
          size: Number(f.size) || 0,
          label: String(f.label || '').trim(),
          name: String(f.name || '').trim(),
        }));
    const g = {
      // 引用原条目时沿用它的编号；自建条目用服务端分配的 baseIndex（900000+）
      index: first ? first.index
        : ((e.sourceIndexes && e.sourceIndexes.length) ? e.sourceIndexes[0] : (e.baseIndex || 999999)),
      imageNumber: first ? (first.imageNumber || first.index)
        : ((e.sourceIndexes && e.sourceIndexes.length) ? e.sourceIndexes[0] : (e.baseIndex || 999999)),
      releaseNumber: first ? first.releaseNumber : 0,
      duplicateID: first ? first.duplicateID : '',
      title: e.name || (first ? first.title : ''),
      // 总条目自己的英文名（其余字段一律由子条目提供）。只有「单来源、非合并」
      // 的覆盖条目才把原 DAT 的字段镜像到总条目——这样 CSV 批量导入（只改 fields、
      // 没动 children）后，列表的语言/厂商列能读到；合并条目（多条来源）子条目字段
      // 各不相同，总条目必须留空，由子条目各自提供。
      comment: fields.comment !== undefined ? fields.comment : '',
      publisher: fields.publisher !== undefined ? fields.publisher : (single && first ? first.publisher : ''),
      sourceRom: fields.sourceRom !== undefined ? fields.sourceRom : (single && first ? first.sourceRom : ''),
      location: fields.location !== undefined ? fields.location : (single && first ? first.location : ''),
      language: fields.language !== undefined ? fields.language : (single && first ? first.language : ''),
      romSize: fields.romSize !== undefined
        ? fields.romSize
        : (crcs.length ? (crcs[0].size || (first ? first.romSize : 0)) : (first ? first.romSize : 0)),
      saveType: '',
      crcs: crcs.length ? crcs : (first ? first.crcs : []),
      children,
      im1CRC: first ? first.im1CRC : '',
      im2CRC: first ? first.im2CRC : '',
      tags: first ? first.tags : [],
      titleKey: '',
      nameKey: '',
      ext: files.length ? (files[0].ext || '') : (first ? first.ext : ''),
      // 合成条目的标记，供界面区分「这是你改过的」
      overridden: true,
      overrideId: e.id,
      sourceIndexes: e.sourceIndexes || [],
      // 'dat' = 跟随清单设置；其余为强制该方式
      matchMode: e.matchMode && e.matchMode !== 'dat' ? e.matchMode : '',
      // 多文件条目：扫描时按「全部命中才算拥有」处理
      // （原生 DAT 里的多个 romCRC 往往是同一 ROM 的不同格式，保持任一命中）
      multiFile: crcs.length > 1,
    };
    synthetic.push(g);
  }

  const kept = (dat.games || []).filter((g) => !consumed.has(g.index));
  const games = kept.concat(synthetic).sort((a, b) => (a.index || 0) - (b.index || 0));
  return { dat: { ...dat, games }, conflicts };
}

function newId() {
  return 'ov_' + crypto.randomBytes(4).toString('hex');
}

module.exports = {
  setDataDirGetter, load, save, apply, snapshotOf, newId, fileOf, emptyBook,
  normalizeFields, EDITABLE_FIELDS,
};
