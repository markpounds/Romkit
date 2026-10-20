'use strict';
/**
 * 配置持久化（JSON，原子写）
 * data/
 *   config.json        库配置 + 每库整理设置
 *   crc-cache.json     path|size|mtime -> crc32 缓存，避免重复扫大文件
 *   dats/              托管/下载的 DAT 文件
 *   logs/              操作日志
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.ROMKIT_DATA || path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CRC_CACHE_PATH = path.join(DATA_DIR, 'crc-cache.json');

const DEFAULT_SETTINGS = {
  romDir: '',
  outDir: '',
  mode: 'zip', // zip = 保留压缩包 | raw = 保留原始文件（解压/不打包）
  // 命名模板，语法与 OfflineList 一致：%u 编号 %n 名称 %p 厂商 %i 容量 %c CRC %o 国家 %g 来源 %s 存档 %e 备注 %a 语言
  fileTemplate: '%u - %n [%g]',
  archiveTemplate: '%u - %n [%g]',
  entryRename: true, // 压缩包内文件是否同步按模板改名
  naming: '{title}', // 兼容旧字段，仅在没有 fileTemplate 时兜底
  operation: 'move', // copy | move
  recursive: true,
  conflict: 'skip', // skip | overwrite | rename
  // 未识别/多余文件：keep = 留在原处；move = 移到 unmatchedDir
  unmatchedAction: 'keep',
  unmatchedDir: '',
  // 同一游戏有多份副本时：keep = 全部保留；move = 只留文件名正确的那份，其余移走
  duplicateAction: 'move',
  duplicateDir: '', // 留空则用 unmatchedDir，再留空则用 data/duplicates/<库>
  // 多盘游戏（Disc 1 / Disc 2 …）：输出到同一个子文件夹
  multiDiscFolder: true,
  // 纹理包：带「(纹理包)」的文件与主文件放进同一文件夹（仅 raw 模式）
  texturePackFolder: true,
  // BIOS：带「(Bios)」的文件与主文件放进同一文件夹（仅 raw 模式）
  biosGroupFolder: true,
  // 移动后清理源目录里变空的子文件夹
  pruneEmptyDirs: true,
  matchMode: 'both', // crc | name | both
  scanMode: 'full', // full | fast（快速模式不对裸的大文件算 CRC）
  skipHidden: true,
  // 左侧列表图标：iconText = 表情/字符；iconFile = 上传的图片文件名（存于 data/icons/）
  iconText: '',
  iconFile: '',
};

const DEFAULT_ASSETS = {
  // 截图/封面：本地目录优先，缺失时可从 DAT 的 imURL 订阅源下载
  //   dir      = 读取已有图片的目录（OfflineList 图片包）
  //   storeDir = 上传/下载得到的图片保存到哪里（留空则用 data/covers/<库>）
  cover: { enabled: true, dir: '', storeDir: '', mode: 'auto', pattern: '{im1CRC}' },
  // 预留位：后续接入截图集/视频/简介时，直接填充这些开关即可
  screenshot: { enabled: false, dir: '', pattern: '{im2CRC}' },
  video: { enabled: false, dir: '', pattern: '{title}' },
  info: { enabled: false, source: '' },
};

// 全局存储位置：留空 = 用工具自己的数据目录下的默认子目录。
// 飞牛上可在安装向导里填（会变成同名环境变量），桌面版在设置里改。
const DEFAULT_PATHS = { datDir: '', coverDir: '' };

let config = {
  version: 1,
  libraries: [],
  // 左侧分类树：{ id, name, parentId }（parentId 为空表示顶层；支持任意层级）
  categories: [],
  ui: { theme: 'light', lastLibrary: '', inboxDir: '' },
  paths: { ...DEFAULT_PATHS },
};

// ------------------------------------------------------------------ 分类
function listCategories() { return config.categories || (config.categories = []); }

function categoryById(id) { return listCategories().find((c) => c.id === id) || null; }

/** 子孙分类 id（含自身），用于「选中某分类时带上子分类里的清单」 */
function descendantCatIds(id) {
  const all = listCategories();
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const c of all) if (c.parentId === out[i] && !out.includes(c.id)) out.push(c.id);
  }
  return out;
}

function addCategory(name, parentId) {
  const list = listCategories();
  const parent = parentId && categoryById(parentId) ? parentId : null;
  const cat = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(name || '').trim() || '新分类',
    parentId: parent,
    // ord：同一父级下的排序序号（组间排序用）
    ord: nextCatOrd(parent),
    // 分组分隔条上显示的图标：iconText = 字符/表情，iconFile = 图片文件名（data/icons/）
    iconText: '',
    iconFile: '',
  };
  list.push(cat);
  return cat;
}

/** 同一父级下的下一个分类序号 */
function nextCatOrd(parentId) {
  const sibs = listCategories().filter((c) => (c.parentId || null) === (parentId || null));
  return sibs.length ? Math.max(...sibs.map((c) => c.ord || 0)) + 1 : 0;
}

function removeCategory(id) {
  const list = listCategories();
  const cat = categoryById(id);
  if (!cat) return false;
  const i = list.indexOf(cat);
  list.splice(i, 1);
  // 子分类上提一级，清单落到父分类（没有父分类就是未分类）
  for (const c of list) if (c.parentId === id) c.parentId = cat.parentId;
  const target = cat.parentId || '';
  for (const lib of config.libraries) {
    if (lib.categoryId === id) {
      lib.categoryId = target;
      touchLibraryOrder(lib, target);
    }
  }
  return true;
}

/** 分类树排序：把同一父级下的分类按给定顺序重排 */
function reorderCategories(parentId, ids) {
  const list = listCategories();
  const pid = parentId || null;
  const sibs = list.filter((c) => (c.parentId || null) === pid);
  if (!Array.isArray(ids) || ids.length !== sibs.length) return false;
  const byId = new Map(list.map((c) => [c.id, c]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== sibs.length) return false;
  // 允许只传部分 id（局部调整），按传入顺序重新编号
  const pos = new Map(ordered.map((c, i) => [c.id, i]));
  sibs.forEach((c) => { if (pos.has(c.id)) c.ord = pos.get(c.id); });
  sibs.sort((a, b) => (a.ord || 0) - (b.ord || 0));
  sibs.forEach((c, i) => { c.ord = i; });
  return true;
}

/**
 * 组内排序：把某个分类「直属」的清单按给定顺序重排。
 * 注意只动该分类的直属清单（不含子分类里的），所以 ids 必须正好是该分类的直属清单集合。
 */
function reorderLibraries(categoryId, ids) {
  const libs = config.libraries;
  const cid = categoryId || '';
  const members = libs.filter((l) => (l.categoryId || '') === cid);
  if (!Array.isArray(ids) || ids.length !== members.length) return false;
  const byId = new Map(libs.map((l) => [l.id, l]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== members.length) return false;
  ordered.forEach((l, i) => { l.ord = i; });
  return true;
}

/** 同一父级下的子分类（按 ord 排序） */
function orderedCategories(parentId) {
  const pid = parentId || null;
  return listCategories()
    .filter((c) => (c.parentId || null) === pid)
    .sort((a, b) => (a.ord || 0) - (b.ord || 0));
}

/** 某个分类「直属」的清单（按 ord 排序） */
function libsOfCategory(catId) {
  const cid = catId || '';
  return config.libraries
    .filter((l) => (l.categoryId || '') === cid)
    .sort((a, b) => (a.ord || 0) - (b.ord || 0));
}

/** 把清单挂到某个分类时，排在该分类最后 */
function touchLibraryOrder(lib, categoryId) {
  const cid = categoryId || '';
  const sibs = libsOfCategory(cid).filter((l) => l.id !== lib.id);
  lib.ord = sibs.length ? Math.max(...sibs.map((l) => l.ord || 0)) + 1 : 0;
}

/**
 * 分类树 → 分组树。
 * 每个分组 = { cat, children:[分组], libs:[直属清单] }
 */
function buildGroupTree(parentId) {
  return orderedCategories(parentId).map((c) => ({
    cat: c,
    children: buildGroupTree(c.id),
    libs: libsOfCategory(c.id),
  }));
}

/**
 * 把分组树摊平成「清单 + 所属分组」的顺序列表。
 * 规则（用户定义）：
 *   子分类的内容排在父分类直属清单之前；同层分组按 ord 顺序；
 *   分组内部按各自 ord 顺序。
 * 例：A 直属 [a2,a3]，A 的子分类 a1 直属 [a1.1,a1.2]，B 直属 [b1,b2]，A 在 B 前
 *   → a1.1, a1.2, a2, a3, b1, b2
 */
function flattenGroups(groups, out, depth) {
  const res = out || [];
  for (const g of groups) {
    flattenGroups(g.children, res, (depth || 0) + 1);
    for (const lib of g.libs) res.push({ lib, group: g.cat, depth: depth || 0 });
  }
  return res;
}

/** 全局有序的清单列表（分类树前序展开 + 未分类垫底） */
function orderedLibraries() {
  const out = flattenGroups(buildGroupTree(null)).map((x) => x.lib);
  out.push(...libsOfCategory(''));
  return out;
}


let crcCache = {};
let dirty = false;
let crcDirty = false;

function ensureDirs() {
  for (const d of [DATA_DIR, path.join(DATA_DIR, 'dats'), path.join(DATA_DIR, 'logs'), path.join(DATA_DIR, 'icons')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    config = {
      version: 2,
      libraries: [],
      ui: { theme: 'light', lastLibrary: '', inboxDir: '' },
      paths: { ...DEFAULT_PATHS },
      ...parsed,
    };
    config.paths = { ...DEFAULT_PATHS, ...(parsed.paths || {}) };
    config.libraries = (config.libraries || []).map((lib) => migrateLibrary(lib));
  } catch (_) {
    config = {
      version: 2,
      libraries: [],
      ui: { theme: 'light', lastLibrary: '', inboxDir: '' },
      paths: { ...DEFAULT_PATHS },
    };
  }
  normalizeOrder();
  try {
    crcCache = JSON.parse(fs.readFileSync(CRC_CACHE_PATH, 'utf8'));
  } catch (_) {
    crcCache = {};
  }
  return config;
}

/**
 * 补齐排序序号：分类按同层级先后编号，清单按各自所属分类分组编号。
 * 老配置没有 ord 字段，这里按数组原有顺序推导出稳定的序号。
 */
function normalizeOrder() {
  const cats = listCategories();
  const perParent = new Map();
  cats.forEach((c) => {
    const k = c.parentId || null;
    if (!perParent.has(k)) perParent.set(k, []);
    perParent.get(k).push(c);
  });
  for (const [, sibs] of perParent) {
    sibs.forEach((c, i) => { if (typeof c.ord !== 'number') c.ord = i; });
    sibs.sort((a, b) => (a.ord || 0) - (b.ord || 0));
    sibs.forEach((c, i) => { c.ord = i; });
  }
  const perCat = new Map();
  for (const lib of config.libraries) {
    const k = lib.categoryId || '';
    if (!perCat.has(k)) perCat.set(k, []);
    perCat.get(k).push(lib);
  }
  for (const [, group] of perCat) {
    group.forEach((l, i) => { if (typeof l.ord !== 'number') l.ord = i; });
    group.sort((a, b) => (a.ord || 0) - (b.ord || 0));
    group.forEach((l, i) => { l.ord = i; });
  }
}

/** 旧配置升级：补齐新字段，且不破坏用户已改过的模板 */
function migrateLibrary(lib) {
  const settings = { ...DEFAULT_SETTINGS, ...(lib.settings || {}) };
  if (!settings.fileTemplate || settings.fileTemplate === '{title}') {
    settings.fileTemplate = DEFAULT_SETTINGS.fileTemplate;
  }
  if (!settings.archiveTemplate || settings.archiveTemplate === '{title}') {
    settings.archiveTemplate = settings.fileTemplate;
  }
  if (settings.entryRename === undefined) settings.entryRename = true;
  const assets = { ...DEFAULT_ASSETS, ...(lib.assets || {}) };
  const legacyCover = !lib.assets || !lib.assets.cover || lib.assets.cover.storeDir === undefined;
  assets.cover = { ...DEFAULT_ASSETS.cover, ...(lib.assets && lib.assets.cover) };
  // 老配置没有「存储位置」字段，说明是接入截图功能之前保存的，默认帮用户打开
  if (legacyCover) assets.cover.enabled = true;
  return { ...lib, settings, assets };
}

async function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function save() {
  await atomicWrite(CONFIG_PATH, config);
  dirty = false;
}

async function saveCrcCache() {
  if (!crcDirty) return;
  await atomicWrite(CRC_CACHE_PATH, crcCache);
  crcDirty = false;
}

function getConfig() { return config; }

function listLibraries() { return config.libraries; }

function getLibrary(id) {
  return config.libraries.find((l) => l.id === id) || null;
}

function addLibrary(lib) {
  if (typeof lib.ord !== 'number') {
    const sibs = libsOfCategory(lib.categoryId || '');
    lib.ord = sibs.length ? Math.max(...sibs.map((l) => l.ord || 0)) + 1 : 0;
  }
  config.libraries.push(lib);
  return lib;
}

function removeLibrary(id) {
  const i = config.libraries.findIndex((l) => l.id === id);
  if (i >= 0) config.libraries.splice(i, 1);
}

function cacheGet(key) { return crcCache[key]; }
function cacheSet(key, value) { crcCache[key] = value; crcDirty = true; }
function cacheDropMissing(existingKeys) {
  let changed = false;
  for (const k of Object.keys(crcCache)) {
    if (!existingKeys.has(k)) { delete crcCache[k]; changed = true; }
  }
  if (changed) crcDirty = true;
}

module.exports = {
  ROOT, DATA_DIR, CONFIG_PATH, DEFAULT_SETTINGS, DEFAULT_ASSETS, DEFAULT_PATHS,
  /** 全局存储位置：环境变量优先（飞牛安装向导写入），其次配置文件，最后落到数据目录里的默认子目录 */
  paths() {
    const cfg = config.paths || {};
    return {
      datDir: (process.env.ROMKIT_DAT_DIR || cfg.datDir || '').trim() || path.join(DATA_DIR, 'dats'),
      coverDir: (process.env.ROMKIT_COVER_DIR || cfg.coverDir || '').trim() || path.join(DATA_DIR, 'covers'),
      dataDir: DATA_DIR,
    };
  },
  load, save, saveCrcCache, getConfig, listLibraries, getLibrary, addLibrary, removeLibrary,
  cacheGet, cacheSet, cacheDropMissing, ensureDirs,
  listCategories, categoryById, descendantCatIds, addCategory, removeCategory, reorderLibraries,
  reorderCategories, orderedCategories, libsOfCategory, buildGroupTree, flattenGroups,
  orderedLibraries, touchLibraryOrder, nextCatOrd,
};
