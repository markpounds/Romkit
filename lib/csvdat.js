'use strict';
/**
 * CSV → 自建 DAT
 *
 * 场景：手上只有一份「文件清单」（工具导出的 CSV，或直接指定服务器上的
 * ROM 文件夹），没有现成 DAT。这里把清单变成 OfflineList 格式的 DAT，
 * 走正常的注册管线，扫描时按「名称+大小」验证。
 *
 * CSV 约定（表头行必填，列顺序随意，识别下列列名）：
 *   名称 / name / title          —— 游戏显示名（缺省用文件名去后缀）
 *   文件名 / filename / file     —— ROM 文件名（必填；名称也缺时整行报错）
 *   大小(字节) / size / bytes    —— 文件字节数（「名称+大小」验证的关键列）
 *   CRC32 / crc                  —— 可选
 *   英文名 / comment             —— 可选
 *   厂商 / publisher             —— 可选
 *   地区 / location              —— 可选
 *   语言 / language              —— 可选
 *   存档类型 / saveType          —— 可选
 *   编号 / releaseNumber         —— 可选
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 去掉 BOM */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * 极简 RFC4180 解析：支持引号字段、字段内逗号/换行、"" 转义。
 * 返回 string[][]，不含空行。
 */
function parseCsv(text) {
  const src = stripBom(String(text || '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuote = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

/** 表头归一：小写、去空白、去括注（「大小(字节)」→「大小」） */
function normHeader(h) {
  return String(h || '').toLowerCase().replace(/\s+/g, '').replace(/（[^）]*）|\([^)]*\)/g, '');
}

const HEADER_MAP = {
  // 显示名
  '名称': 'title', '游戏名': 'title', '中文名': 'title', '游戏名称': 'title', '标题': 'title',
  'name': 'title', 'title': 'title',
  // 文件名
  '文件名': 'filename', '文件': 'filename', 'rom': 'filename', 'romname': 'filename',
  'filename': 'filename', 'file': 'filename', 'sourcerom': 'filename',
  // 大小
  '大小': 'size', '文件大小': 'size', '字节数': 'size', '字节': 'size',
  'size': 'size', 'bytes': 'size', 'romsize': 'size',
  // CRC
  'crc': 'crc', 'crc32': 'crc', 'crc值': 'crc',
  // 相对路径（「一个游戏 = 多个文件」的清单：文件名会重复，靠相对路径区分）
  '相对路径': 'relativePath', '相对位置': 'relativePath', '路径': 'relativePath',
  'relativepath': 'relativePath', 'relpath': 'relativePath',
  // 分组（一份 CSV 里有多个游戏时，用这列把行归到各游戏）
  '所属游戏': 'group', '分组': 'group', '游戏分组': 'group', '游戏目录': 'group',
  '修改时间': 'mtime', 'mtime': 'mtime',
  // 其余可选信息
  '英文名': 'comment', '英文名称': 'comment', '描述': 'comment', '简介': 'comment', '备注': 'comment', '说明': 'comment',
  'comment': 'comment',
  '厂商': 'publisher', '发行商': 'publisher', '发行厂商': 'publisher', 'publisher': 'publisher',
  '地区': 'location', '区域': 'location', '发行国家': 'location', 'location': 'location',
  '语言': 'language', 'language': 'language',
  '存档': 'saveType', '存档类型': 'saveType', 'savetype': 'saveType',
  '编号': 'releaseNumber', '号码': 'releaseNumber', 'releasenumber': 'releaseNumber', 'number': 'releaseNumber', 'no': 'releaseNumber',
};

/** 解析整份 CSV → { entries, errors, warnings } */
function csvToEntries(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { entries: [], errors: ['CSV 是空的'], warnings: [] };
  const header = rows[0].map(normHeader);
  const cols = new Map(); // field -> 列号（同名列取第一个）
  header.forEach((h, i) => {
    const f = HEADER_MAP[h];
    if (f && !cols.has(f)) cols.set(f, i);
  });
  const warnings = [];
  const errors = [];
  if (!cols.has('filename')) {
    errors.push('表头里找不到「文件名」列（可用列名：文件名 / filename / file / rom）');
    return { entries: [], errors, warnings };
  }
  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (f) => {
      const i = cols.get(f);
      return i === undefined ? '' : String(row[i] === undefined ? '' : row[i]).trim();
    };
    const lineNo = r + 1;
    const filename = get('filename');
    const title = get('title');
    if (!filename && !title) continue; // 整行空
    if (!filename) {
      errors.push(`第 ${lineNo} 行：缺少文件名（名称「${title}」没法参与扫描匹配）`);
      continue;
    }
    let size = 0;
    const sizeRaw = get('size').replace(/[,\s_]/g, '');
    if (sizeRaw) {
      // 只认纯数字字节；「12MB / 700M」这类一律拒绝并提示，
      // 避免 parseInt('12MB') 静默变成 12 造成大小校验全错
      if (!/^\d+$/.test(sizeRaw)) {
        warnings.push(`第 ${lineNo} 行：大小「${get('size')}」要填字节数（纯数字），已按 0 处理（将只按名称匹配）`);
        size = 0;
      } else {
        size = parseInt(sizeRaw, 10);
      }
    }
    if (!title) warnings.push(`第 ${lineNo} 行：没有「名称」，用文件名「${path.basename(filename, path.extname(filename))}」代替`);
    const num = (f) => {
      const n = parseInt(get(f), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    entries.push({
      title: title || path.basename(filename, path.extname(filename)),
      sourceRom: filename,
      romSize: size,
      crc: get('crc').replace(/^0x/i, '').toUpperCase(),
      comment: get('comment'),
      publisher: get('publisher'),
      location: get('location'),
      language: get('language'),
      saveType: get('saveType'),
      releaseNumber: num('releaseNumber'),
    });
  }
  return { entries, errors, warnings };
}

/**
 * 解析整份 CSV → 多文件游戏列表。
 * 三种模式（自动识别表头）：
 *   1) 有「相对路径」列   → 整份 CSV = 一个游戏（每行一个文件；文件名可重复）。
 *      用于「一个游戏 = 一个文件夹的一堆文件」（已安装游戏）的工具导出清单。
 *   2) 有「所属游戏/分组」列 → 同一分组的行合成一个游戏。
 *   3) 都没有            → 每行一个游戏（传统模式，走 csvToEntries）。
 * 返回 { mode, games: [{ title?, files: [{filename, name?, size, crc}], info? }], errors, warnings }
 * title 为空时由调用方兜底（CSV 文件名 / 所在文件夹名）。
 */
function csvToGames(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { mode: 'rows', games: [], errors: ['CSV 是空的'], warnings: [] };
  const header = rows[0].map(normHeader);
  const cols = new Map();
  header.forEach((h, i) => {
    const f = HEADER_MAP[h];
    if (f && !cols.has(f)) cols.set(f, i);
  });
  const errors = [];
  const warnings = [];
  if (!cols.has('filename')) {
    errors.push('表头里找不到「文件名」列（可用列名：文件名 / filename / file / rom）');
    return { mode: 'rows', games: [], errors, warnings };
  }
  const cell = (row, f) => {
    const i = cols.get(f);
    return i === undefined ? '' : String(row[i] === undefined ? '' : row[i]).trim();
  };
  const parseSize = (raw, lineNo) => {
    const s = String(raw || '').replace(/[,\s_]/g, '');
    if (!s) return 0;
    if (!/^\d+$/.test(s)) {
      warnings.push(`第 ${lineNo} 行：大小「${raw}」要填字节数（纯数字），已按 0 处理`);
      return 0;
    }
    return parseInt(s, 10);
  };
  const hasRel = cols.has('relativePath');
  const hasGroup = cols.has('group');

  if (hasRel || hasGroup) {
    const mode = hasRel ? 'single' : 'group';
    const buckets = hasRel
      ? [{ title: '', files: [], info: {} }]
      : [];
    const byGroup = new Map();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const lineNo = r + 1;
      const filename = cell(row, 'filename');
      const rel = cell(row, 'relativePath');
      if (!filename && !rel) continue;
      const size = parseSize(cell(row, 'size'), lineNo);
      const f = {
        filename: filename || rel.split(/[\\/]/).pop(),
        name: rel || filename,
        size,
        crc: cell(row, 'crc').replace(/^0x/i, '').toUpperCase(),
      };
      let bucket;
      if (hasRel) {
        bucket = buckets[0];
      } else {
        const gname = cell(row, 'group');
        if (!byGroup.has(gname)) {
          bucket = { title: gname, files: [], info: {} };
          byGroup.set(gname, bucket);
          buckets.push(bucket);
        } else {
          bucket = byGroup.get(gname);
        }
      }
      if (!bucket.info.title) {
        for (const k of ['title', 'comment', 'publisher', 'location', 'language', 'saveType']) {
          const v = cell(row, k);
          if (v) bucket.info[k] = bucket.info[k] || v;
        }
      }
      bucket.files.push(f);
    }
    if (!buckets.length || !buckets.some((b) => b.files.length)) {
      errors.push('没有解析到任何文件行');
      return { mode, games: [], errors, warnings };
    }
    return { mode, games: buckets, errors, warnings };
  }

  // 传统模式：每行一个游戏
  const r2 = csvToEntries(text);
  return {
    mode: 'rows',
    games: r2.entries.map((e) => ({
      title: e.title,
      info: { comment: e.comment, publisher: e.publisher, location: e.location, language: e.language, saveType: e.saveType },
      files: [{ filename: e.sourceRom, name: '', size: e.romSize, crc: e.crc }],
    })),
    errors: r2.errors,
    warnings: r2.warnings,
  };
}

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 从文件名取扩展名（含点、小写；无后缀返回 ''） */
function extOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ext && /^\.[\w.]+$/.test(ext) ? ext : '';
}

/**
 * 条目 → OfflineList DAT XML 文本。
 * 结构与 lib/dat.js 的 parseDatXml 对齐；CRC 可为空（空则不写 romCRC，
 * 解析后该条目无 crcs，靠名称/名称+大小匹配）。
 */
function buildDatXml({ datName, system, entries }) {
  const extSet = new Set();
  for (const e of entries) {
    const files = e.files && e.files.length ? e.files : [{ filename: e.sourceRom, name: '', size: e.romSize, crc: e.crc }];
    for (const f of files) {
      const ext = extOf(f.name || f.filename);
      if (ext) extSet.add(ext);
    }
  }
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<dat>');
  lines.push('  <configuration>');
  lines.push(`    <datName>${xmlEsc(datName)}</datName>`);
  lines.push('    <datVersion>1</datVersion>');
  lines.push(`    <system>${xmlEsc(system || '')}</system>`);
  lines.push('    <screenshotsWidth>0</screenshotsWidth>');
  lines.push('    <screenshotsHeight>0</screenshotsHeight>');
  lines.push('    <romTitle></romTitle>');
  lines.push('    <infos>');
  lines.push('      <comment visible="true" inNamingOption="false" default="true"/>');
  lines.push('      <publisher visible="true" inNamingOption="false" default="false"/>');
  lines.push('      <location visible="true" inNamingOption="false" default="false"/>');
  lines.push('      <language visible="true" inNamingOption="false" default="false"/>');
  lines.push('      <sourceRom visible="true" inNamingOption="false" default="false"/>');
  lines.push('      <romSize visible="true" inNamingOption="false" default="false"/>');
  lines.push('      <saveType visible="true" inNamingOption="false" default="false"/>');
  lines.push('      <releaseNumber visible="true" inNamingOption="false" default="false"/>');
  lines.push('    </infos>');
  lines.push('    <canOpen>');
  if (extSet.size) for (const ext of [...extSet].sort()) lines.push(`      <extension>${xmlEsc(ext)}</extension>`);
  else lines.push('      <extension>.zip</extension>');
  lines.push('    </canOpen>');
  lines.push('  </configuration>');
  lines.push('  <games>');
  entries.forEach((e, i) => {
    // 多文件条目（files 数组）或传统单文件（sourceRom/crc/romSize）统一成文件表
    const files = e.files && e.files.length
      ? e.files
      : [{ filename: e.sourceRom, name: '', size: e.romSize, crc: e.crc }];
    const totalSize = files.reduce((n, f) => n + (Number(f.size) || 0), 0) || (Number(e.romSize) || 0);
    lines.push('    <game>');
    lines.push(`      <imageNumber>${i + 1}</imageNumber>`);
    lines.push(`      <releaseNumber>${e.releaseNumber || i + 1}</releaseNumber>`);
    lines.push(`      <title>${xmlEsc(e.title)}</title>`);
    lines.push(`      <comment>${xmlEsc(e.comment)}</comment>`);
    lines.push(`      <publisher>${xmlEsc(e.publisher)}</publisher>`);
    lines.push(`      <sourceRom>${xmlEsc(e.sourceRom || (files[0] && (files[0].name || files[0].filename)) || '')}</sourceRom>`);
    lines.push(`      <location>${xmlEsc(e.location)}</location>`);
    lines.push(`      <language>${xmlEsc(e.language)}</language>`);
    lines.push(`      <romSize>${totalSize}</romSize>`);
    lines.push(`      <saveType>${xmlEsc(e.saveType)}</saveType>`);
    lines.push('      <files>');
    for (const f of files) {
      const nm = f.name || f.filename || '';
      const ext = extOf(f.name || f.filename);
      const attrs = [`extension="${xmlEsc(ext.replace('.', ''))}"`];
      if (Number(f.size) || 0) attrs.push(`size="${Number(f.size)}"`);
      // 相对路径/文件名写成 name：扫描器按它逐文件对号（文件名可重复时唯一的区分键）
      if (nm) attrs.push(`name="${xmlEsc(nm)}"`);
      lines.push(`        <romCRC ${attrs.join(' ')}>${xmlEsc(f.crc || '')}</romCRC>`);
    }
    lines.push('      </files>');
    lines.push('    </game>');
  });
  lines.push('  </games>');
  lines.push('</dat>');
  return lines.join('\n');
}

/** CSV 模板（给用户下载；BOM 在路由层加，保证 Excel 打开不乱码）
 *  mode='multi'：多文件模板（相对路径版，整份清单 = 一个游戏） */
function templateCsv(mode) {
  if (mode === 'multi') {
    const rows = [
      ['文件名', '大小(字节)', '相对路径', 'CRC32', '英文名', '备注'],
      ['eboot.bin', '3066823', 'app\\PCSG00127\\eboot.bin', '', 'Example Game', '含「相对路径」列 = 整份清单是一个游戏'],
      ['resources.psarc', '1072906776', 'app\\PCSG00127\\resources.psarc', '', '', '文件名可以重复，靠相对路径区分'],
      ['param.sfo', '916', 'addcont\\PCSG00127\\dlc\\param.sfo', '', '', '大小必须填纯数字字节数'],
    ];
    return rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
  }
  const rows = [
    ['名称', '文件名', '大小(字节)', 'CRC32', '英文名', '厂商', '地区', '语言', '备注'],
    ['超级马力欧世界', 'Super Mario World (J).smc', '524288', '', 'Super Mario World', 'Nintendo', '日本', '日语', ''],
    ['塞尔达传说 众神的三角力量', 'Zelda no Densetsu (J).smc', '1048576', '', 'The Legend of Zelda', 'Nintendo', '日本', '日语', '示例：CRC 留空也能用（按名称+大小验证）'],
    [' example', 'Example Game.bin', '734003200', 'DEADBEEF', 'Example Game', '', '', '', '大小填文件的字节数；工具「属性」里能看到'],
  ];
  return rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
}

/**
 * 直接读服务器上的文件夹生成条目（不需要上传清单）。
 * 一个文件一条：title = 去后缀的文件名，sourceRom = 文件名，romSize = 字节数。
 * recursive = true 时包含子文件夹（sourceRom 记相对路径，便于人看）。
 */
async function entriesFromFolder(folder, { recursive = false, withCrc = false } = {}) {
  const entries = [];
  const warnings = [];
  const errors = [];
  const seen = new Map(); // name|size -> 次数（同同名同大小提示）
  const walk = async (dir, rel) => {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(`读不了文件夹 ${dir}：${e.message}`);
      return;
    }
    for (const d of list) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      const relName = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        if (recursive) await walk(full, relName);
        continue;
      }
      if (!d.isFile()) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) { warnings.push(`跳过（取不到大小）：${relName}`); continue; }
      const times = seen.get(d.name + '|' + st.size) || 0;
      seen.set(d.name + '|' + st.size, times + 1);
      if (times === 1) warnings.push(`同名同大小的文件有多份：${d.name}（${st.size} 字节），只建第一条`);
      if (times > 0) continue;
      entries.push({
        title: path.basename(d.name, path.extname(d.name)),
        sourceRom: d.name,
        romSize: st.size,
        crc: '',
        comment: '',
        publisher: '',
        location: '',
        language: '',
        saveType: '',
        releaseNumber: 0,
      });
    }
  };
  await walk(folder, '');
  return { entries, warnings, errors };
}

/**
 * 「每个子文件夹 = 一个游戏」扫描（已安装游戏：一个游戏一个文件夹，
 * 里面一堆文件）。条目的每个文件带相对路径 + 大小，按「文件名+大小」逐文件验证。
 * 跳过隐藏文件和清单工具自己导出的「文件清单_*.csv」。
 */
async function gamesFromFolder(folder) {
  const games = [];
  const warnings = [];
  const errors = [];
  let list;
  try {
    list = await fsp.readdir(folder, { withFileTypes: true });
  } catch (e) {
    return { games, warnings, errors: [`读不了文件夹 ${folder}：${e.message}`] };
  }
  const walkFiles = async (dir, rel, files) => {
    let sub;
    try {
      sub = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`跳过（读不了）：${rel || dir} —— ${e.message}`);
      return;
    }
    for (const d of sub) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      const relName = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        await walkFiles(full, relName, files);
        continue;
      }
      if (!d.isFile()) continue;
      // 跳过清单工具自己导出的清单文件，避免「清单里包含清单」
      if (/^文件清单_.*\.csv$/i.test(d.name)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) { warnings.push(`跳过（取不到大小）：${relName}`); continue; }
      files.push({ filename: d.name, name: relName, size: st.size, crc: '' });
    }
  };
  for (const d of list) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const files = [];
    await walkFiles(path.join(folder, d.name), '', files);
    if (!files.length) { warnings.push(`子文件夹是空的，跳过：${d.name}`); continue; }
    games.push({ title: d.name, info: {}, files });
  }
  if (!games.length) errors.push('文件夹下没有子文件夹（每个子文件夹才算一个游戏）');
  return { games, warnings, errors };
}

/**
 * CSV 字段转义：含逗号/引号/换行/前导空格的字段用双引号包起来，内部引号翻倍。
 * 文件名里偶尔会有逗号，不转义会错位。
 */
function csvEscape(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\r\n]/.test(s) || /^[\s﻿]/.test(s) || /[\s﻿]$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * 把库里当前的游戏（rt.dat.games，已应用覆盖层，即界面上看到的实际数据）
 * 导出成可编辑的 CSV，方便批量改元数据后回导。
 *
 * 列说明：
 *   编号        游戏在 DAT 里的序号，回导时按它精准匹配（空着也能用名称/文件名兜底）
 *   名称/英文名 显示名，可改
 *   文件名      单文件游戏的 ROM 文件名；文件夹型游戏留空（文件清单不进 CSV，避免上百行）
 *   大小(字节)  参考值（单文件为 ROM 大小，文件夹型为所有文件合计）
 *   CRC32       单文件游戏的 CRC；文件夹型留空
 *   发行厂商/地区/语言  可批量改的元数据
 *   文件数      文件夹型游戏的文件个数（参考）
 *
 * 注意：多文件（文件夹）游戏只导出一行元数据，不含文件清单——文件清单来自实际
 * 文件夹，不该手工编辑。回导时按 编号/名称 匹配现有游戏，只更新元数据字段。
 */
function gamesToCsv(games) {
  const cols = ['编号', '名称', '英文名', '文件名', '大小(字节)', 'CRC32', '发行厂商', '地区', '语言', '文件数'];
  const lines = [cols.join(',')];
  for (const g of games || []) {
    const crcs = g.crcs || [];
    const multi = crcs.length > 1;
    const firstCrc = crcs[0] ? crcs[0].crc : '';
    const row = [
      g.index,
      g.title || '',
      g.comment || '',
      multi ? '' : (g.sourceRom || ''),
      g.romSize || 0,
      multi ? '' : firstCrc,
      g.publisher || '',
      g.location || '',
      g.language || '',
      multi ? crcs.length : 1,
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

module.exports = {
  parseCsv, csvToEntries, csvToGames, buildDatXml, templateCsv,
  entriesFromFolder, gamesFromFolder, gamesToCsv, csvEscape,
  normHeader, extOf, HEADER_MAP,
};
