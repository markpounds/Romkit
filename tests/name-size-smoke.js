/* 「名称 + 大小」匹配模式冒烟测试
 *
 * 规则：文件名（忽略大小写/空格/标点，可带 "0365 - " 前缀编号）与 DAT 标题一致，
 *      且字节数与 DAT 的 romSize 相等，才算已拥有。
 * 不匹配时要能说清原因：缺哪个文件、哪条同名但大小不符。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const scanner = require('../lib/scanner');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-name-size-' + Date.now());

function game(i, title, ext, size) {
  return {
    index: i, imageNumber: i, title, comment: `${title} (China)`,
    publisher: 'T', sourceRom: 's', location: 'China', language: 'CHS',
    romSize: size, saveType: 'None',
    crcs: [{ crc: ('A' + i).padStart(8, '0'), extension: ext }],
    tags: ['China', 'CHS'], ext,
  };
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const rom = path.join(TMP, 'rom');
  const out = path.join(TMP, 'out');
  await fsp.mkdir(rom, { recursive: true });
  await fsp.mkdir(out, { recursive: true });

  const games = [
    game(1, '完全一致', '.chd', 100),
    game(2, '大小不符', '.chd', 100),
    game(3, '完全不存在的游戏', '.chd', 100),
    game(4, '带编号前缀', '.chd', 50),
  ];
  const dat = { games, datVersion: 1, extensions: ['.chd'], imFolder: '', romTitle: '%n', system: 'Test' };

  // 1: 名字与大小都对
  await fsp.writeFile(path.join(rom, '完全一致.chd'), Buffer.alloc(100, 1));
  // 2: 名字对、大小不对
  await fsp.writeFile(path.join(rom, '大小不符.chd'), Buffer.alloc(80, 2));
  // 3: 没有对应文件
  // 4: 带前缀编号，名字需能剥掉 "0404 - "
  await fsp.writeFile(path.join(rom, '0404 - 带编号前缀.chd'), Buffer.alloc(50, 4));

  const lib = {
    id: 't', settings: {
      romDir: rom, outDir: out, mode: 'raw', matchMode: 'name-size',
      recursive: true, skipHidden: true, scanMode: 'full',
    },
  };
  const scan = await scanner.scanLibrary(lib, dat, {});

  console.log('\n[1] 匹配结果');
  const byIndex = Object.fromEntries(scan.games.map((g) => [g.index, g]));
  ok('名称+大小都一致 → 已拥有', byIndex[1].status === 'owned', byIndex[1].status);
  ok('命中来源标记为 name-size', (byIndex[1].matches[0] || {}).via === 'name-size',
    JSON.stringify((byIndex[1].matches[0] || {}).via));
  ok('大小不符 → 不算已拥有', byIndex[2].status !== 'owned', byIndex[2].status);
  ok('带编号前缀也能匹配', byIndex[4].status === 'owned', byIndex[4].status);
  ok('统计：2 个已拥有', scan.stats.owned === 2, String(scan.stats.owned));

  console.log('\n[2] 诊断信息：说清缺什么、为什么没对上');
  ok('大小不符的条目有诊断', !!byIndex[2].sizeCheck, JSON.stringify(byIndex[2].sizeCheck));
  const sc2 = byIndex[2].sizeCheck || { actual: [], missing: [] };
  ok('诊断里有「同名但大小不符」', sc2.actual && sc2.actual.length === 1, JSON.stringify(sc2.actual));
  ok('记录了实际大小与期望大小',
    sc2.actual && sc2.actual[0].size === 80 && sc2.actual[0].expected === 100,
    JSON.stringify(sc2.actual));
  ok('也标出了缺失的期望文件名',
    (sc2.missing || []).includes('大小不符.chd'), JSON.stringify(sc2.missing));

  ok('完全没有文件的条目有诊断', !!byIndex[3].sizeCheck, JSON.stringify(byIndex[3].sizeCheck));
  const sc3 = byIndex[3].sizeCheck || { missing: [] };
  ok('缺失文件名是「标题 + 扩展名」', (sc3.missing || []).includes('完全不存在的游戏.chd'),
    JSON.stringify(sc3.missing));

  ok('匹配成功的条目不产生多余诊断', byIndex[1].sizeCheck === undefined,
    JSON.stringify(byIndex[1].sizeCheck));

  console.log('\n[3] 该模式不读文件内容（不依赖 CRC）');
  ok('没有计算过 CRC', scan.stats.crcComputed === 0, String(scan.stats.crcComputed));
  ok('CRC 缓存也没动过', scan.stats.crcFromCache === 0, String(scan.stats.crcFromCache));

  console.log('\n[4] 大小未知（romSize=0）时退化为按名字');
  const dat0 = { ...dat, games: [{ ...game(9, '无大小', '.chd', 0) }] };
  await fsp.writeFile(path.join(rom, '无大小.chd'), Buffer.alloc(33, 9));
  const scan0 = await scanner.scanLibrary(lib, dat0, {});
  ok('romSize=0 时按名字算已拥有', scan0.games[0].status === 'owned', scan0.games[0].status);

  console.log('\n[5] 压缩包内文件也按名称+大小判断');
  const zip = require('../lib/zip');
  const romZip = path.join(TMP, 'romzip');
  await fsp.mkdir(romZip, { recursive: true });
  // 打两个包：一个大小对，一个大小错
  const inner = path.join(TMP, 'inner.chd');
  await fsp.writeFile(inner, Buffer.alloc(64, 7));
  await zip.packFile(inner, path.join(romZip, '包里对.zip'), { entryName: '包里的游戏.chd' });
  await fsp.writeFile(inner, Buffer.alloc(32, 8));
  await zip.packFile(inner, path.join(romZip, '包里错.zip'), { entryName: '包里的游戏2.chd' });

  const zipDat = {
    ...dat,
    games: [game(11, '包里的游戏', '.chd', 64), game(12, '包里的游戏2', '.chd', 64)],
  };
  const zipScan = await scanner.scanLibrary(
    { ...lib, settings: { ...lib.settings, romDir: romZip } }, zipDat, {},
  );
  const z11 = zipScan.games.find((g) => g.index === 11);
  const z12 = zipScan.games.find((g) => g.index === 12);
  ok('压缩包内名称+大小都对 → 已拥有', z11.status === 'owned', z11.status);
  ok('压缩包内大小不符 → 不算已拥有', z12.status !== 'owned', z12.status);
  ok('压缩包内的不符也写进诊断',
    !!(z12.sizeCheck && (z12.sizeCheck.actual || []).length === 1),
    JSON.stringify(z12.sizeCheck && z12.sizeCheck.actual));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
