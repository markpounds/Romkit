/* 多文件条目（一个游戏 = 一堆文件）冒烟测试
 *
 * 场景：已安装游戏（如 PSV 的 PCSG00127）没有单个 ROM 文件，
 * 一个游戏 = 一个文件夹里的一堆文件（文件名会重复，靠相对路径区分）。
 * 覆盖：csvToGames 识别「相对路径」列 → buildDatXml 写 name/size 属性 →
 *       parseDatXml 往返 → scanLibrary 按「文件名+大小」逐文件对号
 *       （齐 = owned；缺 = missing 且能列出缺哪个文件）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const csvdat = require('../lib/csvdat');
const { parseDatXml } = require('../lib/dat');
const scanner = require('../lib/scanner');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-multifile-' + Date.now());

(async () => {
  console.log('— csvToGames：相对路径模式（整份 = 一个游戏）—');
  const csv = [
    '"文件名","大小(字节)","大小(MB)","相对路径","修改时间"',
    '"costume.dat","28","0","addcont\\PCSG00127\\dlc\\costume.dat","2019-06-04 23:24:10"',
    '"param.sfo","916","0.001","addcont\\PCSG00127\\sce_sys\\param.sfo","2019-06-04 23:24:10"',
    '"eboot.bin","3066823","2.925","app\\PCSG00127\\eboot.bin","2020-01-17 11:16:18"',
    '"pack00.g1l","8722824","8.319","app\\PCSG00127\\Res\\bgm\\pack00.g1l","2025-01-25 16:06:56"',
  ].join('\r\n');
  let r = csvdat.csvToGames(csv);
  ok('识别为 single 模式（整份 = 一个游戏）', r.mode === 'single' && r.games.length === 1, JSON.stringify(r).slice(0, 120));
  ok('4 个文件全部带相对路径与大小',
    r.games[0].files.length === 4 &&
    r.games[0].files[0].name === 'addcont\\PCSG00127\\dlc\\costume.dat' &&
    r.games[0].files[0].size === 28 &&
    r.games[0].files[2].size === 3066823);
  ok('修改时间列被忽略（无警告）', r.warnings.length === 0 && r.errors.length === 0);

  console.log('— csvToGames：分组模式 —');
  const csvG = [
    '所属游戏,文件名,大小(字节)',
    '游戏A,a.bin,10',
    '游戏B,b.bin,20',
    '游戏A,a2.bin,30',
  ].join('\n');
  r = csvdat.csvToGames(csvG);
  ok('按分组合成 2 个游戏', r.mode === 'group' && r.games.length === 2, JSON.stringify(r.games.map((g) => g.title)));
  ok('游戏A 有 2 个文件', r.games.find((g) => g.title === '游戏A').files.length === 2);

  console.log('— csvToGames：无相对路径/分组 → 传统模式 —');
  r = csvdat.csvToGames('名称,文件名,大小(字节)\n单文件,x.iso,5\n');
  ok('退回每行一个游戏', r.mode === 'rows' && r.games.length === 1 && r.games[0].files[0].size === 5);

  console.log('— buildDatXml → parseDatXml 往返（name/size 属性）—');
  const xml = csvdat.buildDatXml({
    datName: '已安装游戏', system: 'PSV',
    entries: [{ title: 'PCSG00127', files: r0files() }],
  });
  function r0files() {
    return [
      { filename: 'costume.dat', name: 'addcont\\PCSG00127\\dlc\\costume.dat', size: 28, crc: '' },
      { filename: 'eboot.bin', name: 'app\\PCSG00127\\eboot.bin', size: 3066823, crc: '' },
    ];
  }
  let dat;
  try {
    dat = parseDatXml(xml);
    ok('XML 解析成功', true);
  } catch (e) {
    ok('XML 解析成功', false, e.message);
    dat = { games: [], extensions: [] };
  }
  ok('条目 1 个、romSize = 文件大小之和', dat.games.length === 1 && dat.games[0].romSize === 3066851, String(dat.games[0] && dat.games[0].romSize));
  ok('crcs 带 name/size', dat.games[0].crcs.length === 2 && dat.games[0].crcs[0].name === 'addcont\\PCSG00127\\dlc\\costume.dat' && dat.games[0].crcs[0].size === 28);

  console.log('— scanLibrary：逐文件验证（模拟真实文件夹）—');
  const rom = path.join(TMP, 'rom');
  await fsp.mkdir(path.join(rom, 'app', 'PCSG00127'), { recursive: true });
  await fsp.mkdir(path.join(rom, 'addcont', 'PCSG00127', 'dlc'), { recursive: true });
  await fsp.writeFile(path.join(rom, 'app', 'PCSG00127', 'eboot.bin'), Buffer.alloc(3066823, 1));
  await fsp.writeFile(path.join(rom, 'addcont', 'PCSG00127', 'dlc', 'costume.dat'), Buffer.alloc(28, 2));

  const lib = {
    id: 't', settings: {
      romDir: rom, outDir: path.join(TMP, 'out'), mode: 'raw', matchMode: 'name-size',
      recursive: true, skipHidden: true, scanMode: 'full',
    },
  };
  const scan = await scanner.scanLibrary(lib, dat, {});
  const g = scan.games.find((x) => x.title === 'PCSG00127');
  ok('两个文件都在 → owned（多文件）', g && g.status === 'owned', JSON.stringify(g && { status: g.status, fc: g.fileCheck }));
  ok('无缺失', g && (!g.fileCheck || g.fileCheck.missing.length === 0));

  // 删掉一个文件 → missing，且能说出缺哪个
  await fsp.rm(path.join(rom, 'addcont', 'PCSG00127', 'dlc', 'costume.dat'));
  const scan2 = await scanner.scanLibrary(lib, dat, {});
  const g2 = scan2.games.find((x) => x.title === 'PCSG00127');
  ok('缺一个文件 → missing', g2 && g2.status === 'missing', g2 && g2.status);
  ok('缺失报告指名 costume.dat', g2 && g2.fileCheck && g2.fileCheck.missing.some((m) => (m.name || '').includes('costume.dat')), JSON.stringify(g2 && g2.fileCheck));

  // 大小不对 → 同样 missing（逐文件大小校验）
  await fsp.writeFile(path.join(rom, 'addcont', 'PCSG00127', 'dlc', 'costume.dat'), Buffer.alloc(30, 2));
  const scan3 = await scanner.scanLibrary(lib, dat, {});
  const g3 = scan3.games.find((x) => x.title === 'PCSG00127');
  ok('大小不对 → missing（逐文件大小校验）', g3 && g3.status === 'missing', g3 && g3.status);

  // 同名不同目录的重复文件也能各就各位
  const csvDup = [
    '"文件名","大小(字节)","相对路径"',
    '"param.sfo","916","addcont\\G1\\param.sfo"',
    '"param.sfo","916","addcont\\G2\\param.sfo"',
  ].join('\r\n');
  const gd = csvdat.csvToGames(csvDup);
  const datDup = parseDatXml(csvdat.buildDatXml({ datName: '同名测试', system: '', entries: [{ title: 'G', files: gd.games[0].files }] }));
  await fsp.mkdir(path.join(rom, 'addcont', 'G1'), { recursive: true });
  await fsp.mkdir(path.join(rom, 'addcont', 'G2'), { recursive: true });
  await fsp.writeFile(path.join(rom, 'addcont', 'G1', 'param.sfo'), Buffer.alloc(916, 3));
  await fsp.writeFile(path.join(rom, 'addcont', 'G2', 'param.sfo'), Buffer.alloc(916, 3));
  const scan4 = await scanner.scanLibrary(lib, datDup, {});
  const g4 = scan4.games.find((x) => x.title === 'G');
  ok('同名文件（不同目录）两个都能对上 → owned', g4 && g4.status === 'owned', JSON.stringify(g4 && { status: g4.status, fc: g4.fileCheck }));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
