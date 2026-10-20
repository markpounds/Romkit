'use strict';
/**
 * OfflineList DAT（datas.xsd）解析
 * 只读不写：本工具把 DAT 当作"游戏清单标准"，不修改原始 DAT 文件。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseXml, child, children, textOf } = require('./xml');
const { listEntries, readEntryBuffer } = require('./zip');
const { normalizeHex } = require('./crc32');

/** 全角转半角 + 小写 + 去标点，用于文件名/标题模糊比较 */
function normalizeKey(s) {
  if (!s) return '';
  let t = String(s).normalize('NFKC').toLowerCase();
  t = t.replace(/[\s\-_·・:：,，.。!！?？'’"“”()（）\[\]【】{}｛｝~～\/\\|+*&#@$%^;；]/g, '');
  return t;
}

/** 从 comment 提取 (Japan) [CHS] 这类标签 */
function extractTags(comment) {
  if (!comment) return [];
  const out = [];
  const re = /[\[(]([^\])]+)[\])]/g;
  let m;
  while ((m = re.exec(comment))) out.push(m[1].trim());
  return out;
}

function parseDatXml(xmlText) {
  const root = parseXml(xmlText);
  if (root.name !== 'dat') throw new Error('不是 OfflineList DAT 文件（根节点应为 <dat>）');

  const conf = child(root, 'configuration');
  if (!conf) throw new Error('DAT 缺少 <configuration>');

  const infosNode = child(conf, 'infos');
  const infoFlags = {};
  if (infosNode) {
    for (const n of infosNode.children) {
      infoFlags[n.name] = {
        visible: n.attrs.visible === 'true',
        inNamingOption: n.attrs.inNamingOption === 'true',
        default: n.attrs.default === 'true',
      };
    }
  }

  const extSet = new Set();
  const canOpen = child(conf, 'canOpen');
  if (canOpen) {
    for (const e of children(canOpen, 'extension')) {
      const v = (e.text || '').trim().toLowerCase();
      if (v) extSet.add(v.startsWith('.') ? v : '.' + v);
    }
  }

  const newDatNode = child(conf, 'newDat');
  const newDat = newDatNode
    ? {
        datVersionURL: textOf(newDatNode, 'datVersionURL'),
        datURL: textOf(newDatNode, 'datURL'),
        datFileName: (child(newDatNode, 'datURL') || { attrs: {} }).attrs.fileName || '',
        imURL: textOf(newDatNode, 'imURL'),
      }
    : null;

  const rawGames = [];
  const gamesNode = child(root, 'games');
  if (gamesNode) {
    const list = children(gamesNode, 'game');
    list.forEach((g, idx) => {
      const crcs = [];
      const filesNode = child(g, 'files');
      if (filesNode) {
        for (const rc of children(filesNode, 'romCRC')) {
          const ext = (rc.attrs.extension || '').toLowerCase();
          const crc = normalizeHex(rc.text);
          if (crc) crcs.push({ crc, extension: ext });
          if (ext) extSet.add(ext);
        }
      }
      const title = textOf(g, 'title');
      const comment = textOf(g, 'comment');
      rawGames.push({
        index: idx + 1,
        imageNumber: parseInt(textOf(g, 'imageNumber'), 10) || idx + 1,
        releaseNumber: parseInt(textOf(g, 'releaseNumber'), 10) || 0,
        title,
        comment,
        publisher: textOf(g, 'publisher'),
        sourceRom: textOf(g, 'sourceRom'),
        location: textOf(g, 'location'),
        language: textOf(g, 'language'),
        romSize: parseInt(textOf(g, 'romSize'), 10) || 0,
        saveType: textOf(g, 'saveType'),
        crcs,
        im1CRC: normalizeHex(textOf(g, 'im1CRC')),
        im2CRC: normalizeHex(textOf(g, 'im2CRC')),
        duplicateID: textOf(g, 'duplicateID'),
        tags: extractTags(comment),
        titleKey: normalizeKey(title),
        nameKey: normalizeKey(comment.replace(/[\[(][^\])]*[\])]/g, '')),
        ext: crcs.length ? crcs[0].extension : '',
      });
    });
  }

  // 同名同 CRC 去重（某些 DAT 会留重复条目）
  const seen = new Set();
  const games = [];
  for (const g of rawGames) {
    const key = g.crcs.map((c) => c.crc + c.extension).join('|') + '#' + g.title;
    if (g.crcs.length && seen.has(key)) continue;
    seen.add(key);
    games.push(g);
  }

  const dat = {
    datName: textOf(conf, 'datName', path.basename('dat')),
    imFolder: textOf(conf, 'imFolder'),
    datVersion: parseInt(textOf(conf, 'datVersion'), 10) || 0,
    system: textOf(conf, 'system'),
    screenshotsWidth: parseInt(textOf(conf, 'screenshotsWidth'), 10) || 0,
    screenshotsHeight: parseInt(textOf(conf, 'screenshotsHeight'), 10) || 0,
    romTitle: textOf(conf, 'romTitle'),
    extensions: [...extSet],
    infoFlags,
    newDat,
    games,
  };
  return dat;
}

/** 从文件（.xml 或 .zip）加载 DAT，返回 { dat, xmlText, container } */
async function loadDatFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.zip') {
    const entries = await listEntries(filePath).catch(async () => {
      throw new Error('无法读取 zip：' + filePath);
    });
    const xmlEntry =
      entries.find((e) => e.name.toLowerCase().endsWith('.xml') && /dat|ol/i.test(e.name)) ||
      entries.find((e) => e.name.toLowerCase().endsWith('.xml'));
    if (!xmlEntry) throw new Error('压缩包内没有找到 .xml 格式的 DAT 文件');
    const buf = await readEntryBuffer(filePath, xmlEntry);
    const xmlText = decodeBuffer(buf);
    return { dat: parseDatXml(xmlText), xmlText, container: 'zip', entryName: xmlEntry.name };
  }
  const buf = await fs.readFile(filePath);
  const xmlText = decodeBuffer(buf);
  return { dat: parseDatXml(xmlText), xmlText, container: 'xml' };
}

function decodeBuffer(buf) {
  // 处理 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (_) {
    return utf8;
  }
}

/** 建立 CRC -> games 索引 */
function buildCrcIndex(games) {
  const map = new Map();
  for (const g of games) {
    for (const c of g.crcs) {
      if (!map.has(c.crc)) map.set(c.crc, []);
      map.get(c.crc).push({ game: g, extension: c.extension });
    }
  }
  return map;
}

module.exports = { parseDatXml, loadDatFile, buildCrcIndex, normalizeKey, extractTags, decodeBuffer };
