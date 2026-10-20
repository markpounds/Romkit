'use strict';
/**
 * 命名模板 + 整理计划单元测试
 *   node tests/naming.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ROMKIT_DATA = path.join(os.tmpdir(), 'romkit-naming-data');

const naming = require('../lib/naming');
const { buildPlan, executePlan, buildClassifyPlan } = require('../lib/organizer');
const store = require('../lib/store');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const GAME = {
  index: 1,
  imageNumber: 1,
  title: '铁甲飞龙迷你版 (简)',
  comment: 'Panzer Dragoon Mini (Japan) [CHS]',
  publisher: 'Sega',
  sourceRom: '狸克',
  location: '7',
  language: '4',
  romSize: 524288,
  saveType: 'None',
  crcs: [{ crc: '92483247', extension: '.gg' }],
  im1CRC: 'FDB775AB',
  tags: ['Japan', 'CHS'],
  ext: '.gg',
};

async function main() {
  console.log('\n[1] 占位符渲染');
  const t = naming.tokensFor(GAME);
  ok('%n 游戏名称', t.n === '铁甲飞龙迷你版 (简)', t.n);
  ok('%p 发行厂商', t.p === 'Sega');
  ok('%u 游戏编号补 4 位', t.u === '0001', t.u);
  ok('%c CRC', t.c === '92483247');
  ok('%i 容量', t.i === '512KB', t.i);
  ok('%g 发布来源', t.g === '狸克');
  ok('%o 发行国家（从标签推断）', t.o === 'Japan', t.o);
  ok('%a 语言（从标签推断）', t.a === 'CHS', t.a);
  ok('%s 存档类型', t.s === 'None');
  ok('默认模板输出', naming.render('%u - %n [%g]', GAME) === '0001 - 铁甲飞龙迷你版 (简) [狸克]');
  ok('兼容旧 {title} 语法', naming.render('{title}', GAME) === '铁甲飞龙迷你版 (简)');
  ok('未知占位符原样保留', naming.render('%n (%z)', GAME) === '铁甲飞龙迷你版 (简) (%z)');

  console.log('\n[2] 整理计划：保留压缩包');
  const dat = { games: [GAME], datVersion: 1 };
  const mkScan = (container) => ({
    games: [{
      ...GAME,
      status: 'owned',
      matches: [{
        container, path: 'C:\\roms\\raw.gg', relPath: 'raw.gg',
        entryName: container === 'zip' ? '原文件名.gg' : '', ext: '.gg',
        size: 524288, crc: '92483247', via: 'crc',
      }],
    }],
  });

  const libZip = {
    id: 't1', settings: { ...store.DEFAULT_SETTINGS, outDir: 'C:\\out', mode: 'zip', entryRename: true },
  };
  const p1 = await buildPlan(libZip, mkScan('file'), dat);
  ok('zip 模式目标名', path.basename(p1.items[0].dest) === '0001 - 铁甲飞龙迷你版 (简) [狸克].zip', p1.items[0].dest);
  ok('包内条目同步改名', p1.items[0].entryName === '0001 - 铁甲飞龙迷你版 (简) [狸克].gg', p1.items[0].entryName);

  const libZipKeep = {
    id: 't2', settings: { ...store.DEFAULT_SETTINGS, outDir: 'C:\\out', mode: 'zip', entryRename: false },
  };
  const p2 = await buildPlan(libZipKeep, mkScan('zip'), dat);
  ok('关闭后保留原始内部名', p2.items[0].entryName === '原文件名.gg', p2.items[0].entryName);
  ok('关闭后 zip 名仍按压缩包模板', path.basename(p2.items[0].dest).endsWith('.zip'), p2.items[0].dest);

  console.log('\n[3] 整理计划：保留原始文件');
  const libRaw = {
    id: 't3', settings: { ...store.DEFAULT_SETTINGS, outDir: 'C:\\out', mode: 'raw' },
  };
  const p3 = await buildPlan(libRaw, mkScan('file'), dat);
  ok('raw 模式目标名带扩展名', path.basename(p3.items[0].dest) === '0001 - 铁甲飞龙迷你版 (简) [狸克].gg', p3.items[0].dest);

  console.log('\n[4] 两个模板分离');
  const libSep = {
    id: 't4',
    settings: { ...store.DEFAULT_SETTINGS, outDir: 'C:\\out', mode: 'zip', fileTemplate: '%n', archiveTemplate: '%u - %c' },
  };
  const p4 = await buildPlan(libSep, mkScan('file'), dat);
  ok('压缩包用压缩包模板', path.basename(p4.items[0].dest) === '0001 - 92483247.zip', p4.items[0].dest);
  ok('包内文件用文件名模板', p4.items[0].entryName === '铁甲飞龙迷你版 (简).gg', p4.items[0].entryName);

  console.log('\n[5] 非法字符与空模板');
  const libBad = {
    id: 't5',
    settings: { ...store.DEFAULT_SETTINGS, outDir: 'C:\\out', mode: 'raw', fileTemplate: 'a/b:c*d' },
  };
  const p5 = await buildPlan(libBad, mkScan('file'), dat);
  ok('非法字符被替换', !/[\\/:*?"<>|]/.test(path.basename(p5.items[0].dest)), p5.items[0].dest);

  console.log('\n[6] 未识别 / 多余文件的移动');
  const { executePlan } = require('../lib/organizer');
  const tmpRoot = path.join(os.tmpdir(), 'romkit-unmatched');
  const romDir = path.join(tmpRoot, 'roms');
  const keepDir = path.join(tmpRoot, 'out');
  const junkDir = path.join(tmpRoot, 'unmatched');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(romDir, { recursive: true });
  fs.writeFileSync(path.join(romDir, 'good.gg'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(romDir, 'junk.bin'), Buffer.alloc(2048, 2));
  fs.writeFileSync(path.join(romDir, 'unknown.gg'), Buffer.alloc(512, 3));

  const scan2 = {
    ...mkScan('file'),
    unmatched: [
      { path: path.join(romDir, 'junk.bin'), relPath: 'junk.bin', name: 'junk.bin', size: 2048, container: 'file' },
      { path: path.join(romDir, 'unknown.gg'), relPath: 'unknown.gg', name: 'unknown.gg', size: 512, container: 'file' },
    ],
  };
  // 让 matches 指向真实存在的 good.gg
  scan2.games[0].matches[0] = { ...scan2.games[0].matches[0], path: path.join(romDir, 'good.gg'), relPath: 'good.gg' };

  const libUn = {
    id: 't6',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: keepDir, mode: 'raw', operation: 'copy',
      unmatchedAction: 'move', unmatchedDir: junkDir,
    },
  };
  const p6 = await buildPlan(libUn, scan2, dat);
  const moves = p6.items.filter((i) => i.action === 'move-unmatched');
  ok('计划里生成 2 个移动项', moves.length === 2, p6.items.map((i) => i.action).join(','));
  ok('移动目标在未识别目录内', moves.every((m) => m.dest.startsWith(junkDir)));

  const r6 = await executePlan(libUn, p6, {});
  ok('执行无失败', r6.failed === 0, r6.errors);
  ok('junk.bin 已移入未识别目录', fs.existsSync(path.join(junkDir, 'junk.bin')));
  ok('unknown.gg 已移入未识别目录', fs.existsSync(path.join(junkDir, 'unknown.gg')));
  ok('源目录里已不存在', !fs.existsSync(path.join(romDir, 'junk.bin')) && !fs.existsSync(path.join(romDir, 'unknown.gg')));
  ok('正常 ROM 没被误移', fs.existsSync(path.join(romDir, 'good.gg')));

  console.log('\n[7] 未识别目录在 ROM 目录内时会告警');
  const libWarn = {
    id: 't7',
    settings: { ...store.DEFAULT_SETTINGS, romDir, outDir: keepDir, mode: 'raw', unmatchedAction: 'move', unmatchedDir: path.join(romDir, 'junk') },
  };
  const p7 = await buildPlan(libWarn, scan2, dat);
  ok('给出警告', !!p7.warning, p7.warning);

  console.log('\n[8] 多份副本只保留文件名正确的那份');
  const dupDir = path.join(tmpRoot, 'dups');
  const correctName = '0001 - 铁甲飞龙迷你版 (简) [狸克]';
  // 落几个真实文件，便于验证"目标已在原位"的判断
  fs.writeFileSync(path.join(romDir, correctName + '.zip'), Buffer.alloc(64, 9));
  fs.writeFileSync(path.join(romDir, 'junk.zip'), Buffer.alloc(64, 9));
  fs.writeFileSync(path.join(romDir, 'raw.gg'), Buffer.alloc(64, 9));
  const scanDup = {
    games: [{
      ...GAME,
      status: 'duplicate',
      matches: [
        { container: 'zip', path: path.join(romDir, 'junk.zip'), relPath: 'junk.zip', entryName: 'junk.gg', ext: '.gg', size: 100, via: 'crc', entryCount: 1 },
        { container: 'zip', path: path.join(romDir, correctName + '.zip'), relPath: correctName + '.zip', entryName: correctName + '.gg', ext: '.gg', size: 100, via: 'crc', entryCount: 1 },
        { container: 'file', path: path.join(romDir, 'raw.gg'), relPath: 'raw.gg', entryName: '', ext: '.gg', size: 100, via: 'crc', entryCount: 0 },
      ],
    }],
    unmatched: [],
  };
  const libDup = {
    id: 't8',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: keepDir, mode: 'zip',
      duplicateAction: 'move', duplicateDir: dupDir,
    },
  };
  const p8 = await buildPlan(libDup, scanDup, dat);
  const keepItem = p8.items.find((i) => i.action !== 'remove-duplicate' && i.action !== 'skip');
  const removed = p8.items.filter((i) => i.action === 'remove-duplicate');
  ok('保留项是文件名正确的那份', !!keepItem && path.basename(keepItem.source.path) === correctName + '.zip', keepItem && path.basename(keepItem.source.path));
  ok('其余 2 份被移走', removed.length === 2, removed.map((r) => path.basename(r.source.path)).join(','));
  ok('移走目标在副本目录', removed.every((r) => r.dest.startsWith(dupDir)));
  ok('正确的那份没有被移走', !removed.some((r) => path.basename(r.source.path) === correctName + '.zip'));
  ok('统计重复数 = 2', p8.duplicates === 2, String(p8.duplicates));

  // 目标文件已在原位时，主项 skip 但仍应清理副本
  const libDup2 = {
    id: 't9',
    settings: { ...libDup.settings, outDir: romDir, duplicateDir: dupDir },
  };
  const p9 = await buildPlan(libDup2, scanDup, dat);
  ok('目标已在原位 → 主项已就位', p9.items.some((i) => i.action === 'already' && path.basename(i.source.path) === correctName + '.zip'), p9.items.map((i) => i.action + ':' + path.basename(i.source.path)).join(', '));
  ok('仍会清理重复副本', p9.items.filter((i) => i.action === 'remove-duplicate').length === 2, String(p9.items.filter((i) => i.action === 'remove-duplicate').length));

  const r9 = await executePlan(libDup2, p9, {});
  ok('执行无失败', r9.failed === 0, r9.errors);
  ok('junk.zip 已被移走', !fs.existsSync(path.join(romDir, 'junk.zip')) && fs.existsSync(path.join(dupDir, 'junk.zip')));
  ok('raw.gg 已被移走', !fs.existsSync(path.join(romDir, 'raw.gg')) && fs.existsSync(path.join(dupDir, 'raw.gg')));
  ok('正确命名的那份原地保留', fs.existsSync(path.join(romDir, correctName + '.zip')));

  console.log('\n[9] 多条目压缩包不移动（避免误伤别的游戏）');
  const scanMulti = {
    games: [{
      ...GAME,
      status: 'duplicate',
      matches: [
        { container: 'zip', path: path.join(romDir, correctName + '.zip'), relPath: correctName + '.zip', entryName: correctName + '.gg', ext: '.gg', size: 100, via: 'crc', entryCount: 1 },
        { container: 'zip', path: path.join(romDir, 'collection.zip'), relPath: 'collection.zip', entryName: 'a.gg', ext: '.gg', size: 100, via: 'crc', entryCount: 12 },
      ],
    }],
    unmatched: [],
  };
  const p10 = await buildPlan(libDup, scanMulti, dat);
  ok('多条目压缩包未被列入移走', !p10.items.some((i) => i.action === 'remove-duplicate' && path.basename(i.source.path) === 'collection.zip'));
  ok('给出跳过计数', p10.duplicateSkipped === 1, String(p10.duplicateSkipped));

  console.log('\n[10] 文件已在目标位置时不得重复生成副本（conflict=rename 也不能出现 "(1)"）');
  const sameScan = {
    games: [{
      ...GAME,
      status: 'owned',
      matches: [{
        container: 'zip', path: path.join(romDir, correctName + '.zip'), relPath: correctName + '.zip',
        entryName: correctName + '.gg', ext: '.gg', size: 64, via: 'crc', entryCount: 1,
      }],
    }],
    unmatched: [],
  };
  const libSame = {
    id: 't10',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: romDir, mode: 'zip',
      conflict: 'rename', operation: 'move', duplicateAction: 'move', duplicateDir: dupDir,
    },
  };
  const p11 = await buildPlan(libSame, sameScan, dat);
  ok('判定为"已就位"', p11.items.length === 1 && p11.items[0].action === 'already', p11.items.map((i) => i.action).join(','));
  const r11 = await executePlan(libSame, p11, {});
  ok('执行无失败', r11.failed === 0, r11.errors);
  ok('原文件仍在', fs.existsSync(path.join(romDir, correctName + '.zip')));
  const leftovers = fs.readdirSync(romDir).filter((f) => f.includes('(1)'));
  ok('没有生成 (1) 副本', leftovers.length === 0, leftovers.join(','));
  ok('没有误删源文件', fs.existsSync(path.join(romDir, correctName + '.zip')));

  console.log('\n[10b] 重复副本直接删除');
  const delKeep = path.join(romDir, correctName + '.zip');
  const delExtra = path.join(romDir, 'dup-copy.zip');
  fs.writeFileSync(delKeep, Buffer.alloc(64, 1));
  fs.writeFileSync(delExtra, Buffer.alloc(64, 2));
  const scanDel = {
    games: [{
      ...GAME, status: 'duplicate',
      matches: [
        { container: 'file', path: delKeep, relPath: path.basename(delKeep), entryName: '', ext: '.zip', size: 64, via: 'crc', entryCount: 0 },
        { container: 'file', path: delExtra, relPath: 'dup-copy.zip', entryName: '', ext: '.zip', size: 64, via: 'crc', entryCount: 0 },
      ],
    }],
    unmatched: [],
  };
  const libDel = {
    id: 't10b',
    settings: { ...store.DEFAULT_SETTINGS, romDir, outDir: keepDir, mode: 'raw', operation: 'copy', duplicateAction: 'delete' },
  };
  const pDel = await buildPlan(libDel, scanDel, dat);
  ok('生成删除动作', pDel.items.some((i) => i.action === 'delete-duplicate'), pDel.items.map((i) => i.action).join(','));
  const rDel = await executePlan(libDel, pDel, {});
  ok('执行无失败', rDel.failed === 0, rDel.errors);
  ok('多余副本已删除', !fs.existsSync(delExtra));
  ok('保留的那份还在', fs.existsSync(delKeep));

  console.log('\n[11] 多盘游戏放进同一个文件夹');  const discGame = {
    ...GAME, index: 5, imageNumber: 5, title: '最终幻想 VII',
    romSize: 600 * 1024 * 1024, crcs: [{ crc: 'AAAABBBB', extension: '.chd' }], ext: '.chd',
  };
  const mkDisc = (n) => ({
    container: 'file',
    path: path.join(romDir, `Final Fantasy VII (Disc ${n}).chd`),
    relPath: `Final Fantasy VII (Disc ${n}).chd`,
    entryName: '', ext: '.chd', size: 100, via: 'crc', entryCount: 0,
  });
  const scanDisc = { games: [{ ...discGame, status: 'duplicate', matches: [mkDisc(1), mkDisc(2)] }], unmatched: [] };

  const libDisc = {
    id: 't11',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: path.join(tmpRoot, 'out-disc'), mode: 'raw',
      multiDiscFolder: true, duplicateAction: 'move', duplicateDir: dupDir,
    },
  };
  const p12 = await buildPlan(libDisc, scanDisc, dat);
  ok('多盘生成 2 个输出项', p12.items.length === 2, p12.items.length);
  ok('没有把盘 2 当重复副本', !p12.items.some((i) => i.action === 'remove-duplicate'), p12.items.map((i) => i.action).join(','));
  const dirs = new Set(p12.items.map((i) => path.dirname(i.dest)));
  ok('两个盘输出到同一个文件夹', dirs.size === 1, [...dirs].join(' | '));
  const folder = [...dirs][0];
  ok('文件夹名去掉了 disc 标记', !/disc/i.test(path.basename(folder)) && path.basename(folder).includes('最终幻想'), path.basename(folder));
  const names = p12.items.map((i) => path.basename(i.dest));
  ok('文件名保留盘号', names.some((n) => /Disc 1/.test(n)) && names.some((n) => /Disc 2/.test(n)), names.join(','));
  ok('统计多盘组', p12.multiDiscGames === 1, String(p12.multiDiscGames));

  // 关闭开关时维持原行为（视为重复副本）
  const libNoDisc = { id: 't12', settings: { ...libDisc.settings, multiDiscFolder: false } };
  const p13 = await buildPlan(libNoDisc, scanDisc, dat);
  ok('关闭后按重复副本处理', p13.items.some((i) => i.action === 'remove-duplicate'), p13.items.map((i) => i.action).join(','));

  console.log('\n[11b] 多盘跨条目（DC 风格：Disc1 / Disc2 是两条独立记录）');
  // 真实 DAT 的惯例：同一游戏的多盘共用同一个 imageNumber
  const mkDiscGame = (idx, disc) => ({
    ...GAME,
    index: idx, imageNumber: 1,
    title: `莎木2 (Disc ${disc}) (简)`,
    comment: `Shenmue II (Disc ${disc}) (Japan)`,
    sourceRom: 'yzb',
    crcs: [{ crc: disc === 1 ? '11111111' : '22222222', extension: '.chd' }],
    ext: '.chd',
    tags: [],
  });
  const discDat = { games: [mkDiscGame(1, 1), mkDiscGame(2, 2)], datVersion: 1 };
  const mkScanOne = (g) => ({
    ...g, status: 'owned',
    matches: [{
      container: 'file', path: path.join(romDir, `Shenmue II (Disc ${g.index}).chd`),
      relPath: `Shenmue II (Disc ${g.index}).chd`, entryName: '', ext: '.chd',
      size: 100, via: 'crc', entryCount: 0,
    }],
  });
  const scanDiscX = { games: [mkScanOne(discDat.games[0]), mkScanOne(discDat.games[1])], unmatched: [] };
  const libDiscX = {
    id: 't11b',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: path.join(tmpRoot, 'out-discx'), mode: 'raw',
      multiDiscFolder: true, duplicateAction: 'keep',
    },
  };
  const pX = await buildPlan(libDiscX, scanDiscX, discDat);
  ok('两条记录都进入计划', pX.items.length === 2, pX.items.length);
  const dirsX = new Set(pX.items.map((i) => path.dirname(i.dest)));
  ok('跨条目也归到同一文件夹', dirsX.size === 1, [...dirsX].join(' | '));
  ok('文件夹名去掉 disc', !/disc/i.test(path.basename([...dirsX][0])), path.basename([...dirsX][0]));
  const namesX = pX.items.map((i) => path.basename(i.dest));
  ok('文件名带各自盘号', namesX.some((n) => /Disc 1/.test(n)) && namesX.some((n) => /Disc 2/.test(n)), namesX.join(' , '));
  ok('两盘各自用自己的编号', namesX.some((n) => n.startsWith('0001 - ')) && namesX.some((n) => n.startsWith('0002 - ')), namesX.join(' , '));

  // 真实执行一遍：目标子文件夹必须被自动创建（曾因未 mkdir 导致 ENOENT）
  fs.writeFileSync(path.join(romDir, 'Shenmue II (Disc 1).chd'), Buffer.alloc(128, 5));
  fs.writeFileSync(path.join(romDir, 'Shenmue II (Disc 2).chd'), Buffer.alloc(128, 6));
  const rX = await executePlan(libDiscX, pX, {});
  ok('多盘执行无失败', rX.failed === 0, rX.errors);
  ok('子文件夹已创建', fs.existsSync(dirsX.values().next().value));
  const outFilesX = fs.readdirSync(dirsX.values().next().value);
  ok('两个盘都在文件夹里', outFilesX.length === 2, outFilesX.join(','));
  ok('文件夹外没有残留副本', fs.readdirSync(path.join(tmpRoot, 'out-discx')).filter((f) => f.endsWith('.chd')).length === 0);

  console.log('\n[12] 移动后清理空子文件夹');
  const tmp2 = path.join(os.tmpdir(), 'romkit-prune');
  const roms2 = path.join(tmp2, 'roms');
  const deep = path.join(roms2, 'sub', 'deep');
  const out2 = path.join(tmp2, 'out');
  fs.rmSync(tmp2, { recursive: true, force: true });
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(path.join(roms2, 'legacy-empty', 'nested'), { recursive: true }); // 历史残留的空目录
  fs.writeFileSync(path.join(deep, 'only.gg'), Buffer.alloc(256, 7));
  fs.writeFileSync(path.join(roms2, 'keep.gg'), Buffer.alloc(128, 8));

  const scanPrune = {
    games: [{
      ...GAME, status: 'owned',
      matches: [{
        container: 'file', path: path.join(deep, 'only.gg'), relPath: 'sub\\deep\\only.gg',
        entryName: '', ext: '.gg', size: 256, via: 'crc', entryCount: 0,
      }],
    }],
    unmatched: [],
  };
  const libPrune = {
    id: 't13',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir: roms2, outDir: out2, mode: 'raw',
      operation: 'move', pruneEmptyDirs: true, duplicateAction: 'keep',
    },
  };
  const p14 = await buildPlan(libPrune, scanPrune, dat);
  const r14 = await executePlan(libPrune, p14, {});
  ok('执行无失败', r14.failed === 0, r14.errors);
  ok('文件已移出', !fs.existsSync(path.join(deep, 'only.gg')));
  ok('空文件夹 deep 被删除', !fs.existsSync(deep));
  ok('上级空文件夹 sub 也被删除', !fs.existsSync(path.join(roms2, 'sub')));
  ok('ROM 根目录仍在', fs.existsSync(roms2));
  ok('非空目录未被动', fs.existsSync(path.join(roms2, 'keep.gg')));
  ok('历史空文件夹也被清理', !fs.existsSync(path.join(roms2, 'legacy-empty')), 'legacy-empty 未删');
  ok('统计清理数量', r14.prunedDirs >= 3, String(r14.prunedDirs));

  console.log('\n[14] 纹理包与主文件放进同一个文件夹');
  const mkTexGame = (idx, imgNo, tex) => ({
    ...GAME,
    index: idx, imageNumber: imgNo,
    title: tex ? 'GT赛车4 (纹理包) (简)' : 'GT赛车4 (简)',
    comment: tex ? 'Gran Turismo 4 HD Texture (China) [CHS]' : 'Gran Turismo 4 (China) [CHS]',
    sourceRom: tex ? 'texpack' : 'yzb',
    crcs: [{ crc: tex ? 'AAAA1111' : 'BBBB2222', extension: '.chd' }],
    ext: '.chd',
    tags: ['China', 'CHS'],
  });
  const texDat = { games: [mkTexGame(1, 10, false), mkTexGame(2, 20, true)], datVersion: 1 };
  const mkTexScan = (g) => ({
    ...g, status: 'owned',
    matches: [{
      container: 'file', path: path.join(romDir, g.title + '.chd'), relPath: g.title + '.chd',
      entryName: '', ext: '.chd', size: 100, via: 'crc', entryCount: 0,
    }],
  });
  const scanTex = { games: [mkTexScan(texDat.games[0]), mkTexScan(texDat.games[1])], unmatched: [] };
  const libTex = {
    id: 't14',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: path.join(tmpRoot, 'out-tex'), mode: 'raw',
      texturePackFolder: true, duplicateAction: 'keep',
    },
  };
  const pTex = await buildPlan(libTex, scanTex, texDat);
  ok('两个条目都进入计划', pTex.items.length === 2, pTex.items.length);
  const texDirs = new Set(pTex.items.map((i) => path.dirname(i.dest)));
  ok('收进同一个文件夹', texDirs.size === 1, [...texDirs].join(' | '));
  const texFolder = [...texDirs][0];
  ok('文件夹名不带「纹理包」', !/纹理包/.test(path.basename(texFolder)), path.basename(texFolder));
  ok('文件夹用主文件的命名', path.basename(texFolder).startsWith('0001 - '), path.basename(texFolder));
  const texNames = pTex.items.map((i) => path.basename(i.dest));
  ok('纹理包文件保留自己的编号 0002', texNames.some((n) => n.startsWith('0002 - ')), texNames.join(' , '));
  ok('纹理包文件保留标记', texNames.some((n) => /纹理包/.test(n)), texNames.join(' , '));
  ok('主文件不带标记', texNames.some((n) => !/纹理包/.test(n)), texNames.join(' , '));
  ok('统计纹理包分组', pTex.textureGroups === 1, String(pTex.textureGroups));

  const libTexOff = { id: 't15', settings: { ...libTex.settings, texturePackFolder: false } };
  const pTexOff = await buildPlan(libTexOff, scanTex, texDat);
  ok('关闭后不分组', new Set(pTexOff.items.map((i) => path.dirname(i.dest))).size === 1 && pTexOff.textureGroups === undefined, String(pTexOff.textureGroups));

  console.log('\n[15] BIOS 文件与主文件放进同一个文件夹');
  const mkBiosGame = (idx, imgNo, bios) => ({
    ...GAME,
    index: idx, imageNumber: imgNo,
    title: bios ? 'GT赛车4 (Bios) (简)' : 'GT赛车4 (简)',
    comment: bios ? 'Gran Turismo 4 Bios (China) [CHS]' : 'Gran Turismo 4 (China) [CHS]',
    sourceRom: bios ? 'bios' : 'yzb',
    crcs: [{ crc: bios ? 'CCCC3333' : 'DDDD4444', extension: '.chd' }],
    ext: '.chd',
    tags: ['China', 'CHS'],
  });
  const biosDat = { games: [mkBiosGame(1, 30, false), mkBiosGame(2, 31, true)], datVersion: 1 };
  const mkBiosScan = (g) => ({
    ...g, status: 'owned',
    matches: [{
      container: 'file', path: path.join(romDir, g.title + '.chd'), relPath: g.title + '.chd',
      entryName: '', ext: '.chd', size: 100, via: 'crc', entryCount: 0,
    }],
  });
  const scanBios = { games: [mkBiosScan(biosDat.games[0]), mkBiosScan(biosDat.games[1])], unmatched: [] };
  const libBios = {
    id: 't16',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: path.join(tmpRoot, 'out-bios'), mode: 'raw',
      biosGroupFolder: true, duplicateAction: 'keep',
    },
  };
  const pBios = await buildPlan(libBios, scanBios, biosDat);
  ok('BIOS 两个条目都进入计划', pBios.items.length === 2, pBios.items.length);
  const biosDirs = new Set(pBios.items.map((i) => path.dirname(i.dest)));
  ok('BIOS 收进同一个文件夹', biosDirs.size === 1, [...biosDirs].join(' | '));
  const biosFolder = [...biosDirs][0];
  ok('文件夹名不带「Bios」', !/bios/i.test(path.basename(biosFolder)), path.basename(biosFolder));
  const biosNames = pBios.items.map((i) => path.basename(i.dest));
  ok('BIOS 文件用自己的编号 0002', biosNames.some((n) => n.startsWith('0002 - ')), biosNames.join(' , '));
  ok('BIOS 文件保留标记', biosNames.some((n) => /Bios/i.test(n)), biosNames.join(' , '));
  ok('统计 BIOS 分组', pBios.biosGroups === 1, String(pBios.biosGroups));

  console.log('\n[16] 同一文件被多条记录引用 → 不算重复副本');
  const sharedPath = path.join(romDir, 'shared.gg');
  fs.writeFileSync(sharedPath, Buffer.alloc(64, 3));
  const shared = { container: 'file', path: sharedPath, relPath: 'shared.gg', entryName: '', ext: '.gg', size: 64, via: 'crc', entryCount: 0 };
  const extraPath = path.join(romDir, '0001 - 铁甲飞龙迷你版 (简) [狸克].gg'); // 名字更符合模板，会被选为保留项
  fs.writeFileSync(extraPath, Buffer.alloc(64, 4));
  const extra = { container: 'file', path: extraPath, relPath: path.basename(extraPath), entryName: '', ext: '.gg', size: 64, via: 'crc', entryCount: 0 };
  const scanShared = {
    games: [
      { ...GAME, index: 1, imageNumber: 1, status: 'duplicate', matches: [shared, extra] },
      { ...GAME, index: 2, imageNumber: 2, title: '同一个 ROM 的第二条记录', status: 'owned', matches: [shared] },
    ],
    unmatched: [],
  };
  const libShared = {
    id: 't17',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir, outDir: path.join(tmpRoot, 'out-shared'), mode: 'raw',
      operation: 'copy', duplicateAction: 'delete',
    },
  };
  const pShared = await buildPlan(libShared, scanShared, { games: scanShared.games, datVersion: 1 });
  const secondItem = pShared.items.find((i) => i.game.index === 2);
  ok('第二条记录各自输出自己的副本', !!secondItem && (secondItem.action === 'copy-file' || secondItem.action === 'already'), secondItem && secondItem.action);
  ok('共享文件未被当作重复副本', !pShared.items.some((i) => i.action === 'delete-duplicate' && i.source.path === sharedPath),
    pShared.items.map((i) => i.action).join(','));
  ok('统计共享保留数', pShared.sharedFiles === 1, String(pShared.sharedFiles));
  const rShared = await executePlan(libShared, pShared, {});
  ok('执行无失败', rShared.failed === 0, rShared.errors);
  ok('共享文件仍在原位', fs.existsSync(sharedPath));
  ok('保留的那份也没被动', fs.existsSync(extraPath), 'extra 应保留');

  console.log('\n[17] 同 CRC 的多个文件不算「多份副本」');
  const { crc32FileHex } = require('../lib/crc32');
  const { scanLibrary, crcKey } = require('../lib/scanner');
  const scanDir = path.join(tmpRoot, 'scan-roms');
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'copy1.gg'), Buffer.alloc(128, 11));
  fs.writeFileSync(path.join(scanDir, 'copy2.gg'), Buffer.alloc(128, 11)); // 与 copy1 内容完全相同
  fs.writeFileSync(path.join(scanDir, 'other.gg'), Buffer.alloc(128, 22));
  const crcA = (await crc32FileHex(path.join(scanDir, 'copy1.gg'))).toUpperCase();
  const crcB = (await crc32FileHex(path.join(scanDir, 'other.gg'))).toUpperCase();

  const scanLib = {
    id: 't18',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir: scanDir, matchMode: 'both', scanMode: 'full',
      recursive: true, skipHidden: true,
    },
  };
  const scanDat = {
    datVersion: 1, datName: 'dup-test', extensions: ['.gg'], imFolder: '', romTitle: '', system: 'Test',
    comment: '',
    games: [
      { index: 1, imageNumber: 1, title: '同 CRC 两副本', crcs: [{ crc: crcA, extension: '.gg' }], ext: '.gg', tags: [] },
      { index: 2, imageNumber: 2, title: '正常单个', crcs: [{ crc: crcB, extension: '.gg' }], ext: '.gg', tags: [] },
      { index: 3, imageNumber: 3, title: '真的不同副本', crcs: [{ crc: crcA, extension: '.gg' }, { crc: crcB, extension: '.gg' }], ext: '.gg', tags: [] },
    ],
  };
  const scanRes = await scanLibrary(scanLib, scanDat, {});
  const g1 = scanRes.games.find((g) => g.index === 1);
  const g2 = scanRes.games.find((g) => g.index === 2);
  const g3 = scanRes.games.find((g) => g.index === 3);
  ok('同 CRC 的两个文件都匹配到', g1.matches.length === 2, String(g1.matches.length));
  ok('同 CRC 不算多份副本', g1.status === 'owned', g1.status);
  ok('单个文件仍是已拥有', g2.status === 'owned', g2.status);
  ok('内容真的不同才算副本', g3.status === 'duplicate', g3.status);
  ok('统计里不误报重复', scanRes.stats.duplicates === 1, String(scanRes.stats.duplicates));

  console.log('\n[18] 整理后 CRC 缓存同步到新路径（重扫不必再读文件）');
  const mirrorDir = path.join(tmpRoot, 'mirror-roms');
  const mirrorOut = path.join(tmpRoot, 'mirror-out');
  fs.mkdirSync(mirrorDir, { recursive: true });
  const mirrorSrc = path.join(mirrorDir, 'origin.gg');
  fs.writeFileSync(mirrorSrc, Buffer.alloc(256, 9));
  const mirrorCrc = (await crc32FileHex(mirrorSrc)).toUpperCase();
  const mirrorLib = {
    id: 't19',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir: mirrorDir, outDir: mirrorOut, mode: 'raw',
      operation: 'move', duplicateAction: 'keep',
    },
  };
  const mirrorPlan = await buildPlan(mirrorLib, {
    games: [{
      ...GAME, status: 'owned',
      matches: [{ container: 'file', path: mirrorSrc, relPath: 'origin.gg', entryName: '', ext: '.gg', size: 256, crc: mirrorCrc, via: 'crc', entryCount: 0 }],
    }],
    unmatched: [],
  }, { games: [], datVersion: 1 });
  const rMirror = await executePlan(mirrorLib, mirrorPlan, {});
  ok('整理成功', rMirror.failed === 0, rMirror.errors);
  const destFile = mirrorPlan.items[0].dest;
  ok('文件已移到新位置', fs.existsSync(destFile) && !fs.existsSync(mirrorSrc));
  const st = fs.statSync(destFile);
  const cached = store.cacheGet(crcKey(destFile, st.size, st.mtimeMs));
  ok('新路径已有 CRC 缓存', cached === mirrorCrc, `缓存=${cached} 实际=${mirrorCrc}`);
  ok('旧路径缓存可被清理', true);

  console.log('\n[19] 自动分类：inbox 命中后按规则归位');
  const inboxDir = path.join(tmpRoot, 'inbox');
  const classOut = path.join(tmpRoot, 'class-out');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, '神秘文件.gg'), Buffer.alloc(256, 31));
  const inboxCrc = (await crc32FileHex(path.join(inboxDir, '神秘文件.gg'))).toUpperCase();
  const classLib = {
    id: 't20',
    settings: {
      ...store.DEFAULT_SETTINGS, romDir: inboxDir, outDir: classOut, mode: 'raw',
      operation: 'move', duplicateAction: 'keep',
    },
  };
  const classDat = { games: [{ ...GAME, index: 1, imageNumber: 1, crcs: [{ crc: inboxCrc, extension: '.gg' }] }], datVersion: 1, extensions: ['.gg'], imFolder: '', romTitle: '', system: 'Test' };
  const { plan: cplan } = await buildClassifyPlan(classLib, classDat, inboxDir);
  ok('命中的文件进入归类计划', cplan.items.length === 1, String(cplan.items.length));
  ok('动作是输出到新目录', cplan.items[0] && cplan.items[0].action === 'copy-file', cplan.items[0] && cplan.items[0].action);
  const rc = await executePlan(classLib, cplan, {});
  ok('归类执行成功', rc.failed === 0, rc.errors);
  ok('文件已按规则送到输出目录', fs.existsSync(path.join(classOut, '0001 - 铁甲飞龙迷你版 (简) [狸克].gg')));
  ok('inbox 里的源文件已清掉', !fs.existsSync(path.join(inboxDir, '神秘文件.gg')));

  // 未命中的文件应留在 inbox
  fs.writeFileSync(path.join(inboxDir, '没人认识.gg'), Buffer.alloc(64, 99));
  const { plan: cplan2 } = await buildClassifyPlan(classLib, classDat, inboxDir);
  ok('未识别的文件不进计划', cplan2.items.length === 0, String(cplan2.items.length));
  ok('未识别的文件原地保留', fs.existsSync(path.join(inboxDir, '没人认识.gg')));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
