/* 编号（imageNumber）保真冒烟测试
 *
 * 背景：DAT 里的 <imageNumber> 与条目在文件中的顺序不是一回事 ——
 * 有的 DAT 会出现同号（BIOS 与主文件共用）、跳号。列表编号、截图文件名
 * （imURL 下的 0005a.png 之类）都按 imageNumber 来。
 *
 * 曾经的 bug：扫描结果里没有带出 imageNumber，前端退回用数组序号显示，
 * 表现为「列表里的编号变了」；截图下载也会拼错地址。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const scanner = require('../lib/scanner');
const { parseDatXml } = require('../lib/dat');
const covers = require('../lib/covers');
const { crc32, toHex } = require('../lib/crc32');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-imgnum-' + Date.now());

// 三份内容，CRC 各不相同
const BODIES = ['alpha-content', 'beta-content', 'gamma-content'].map((s) => Buffer.from(s));
const CRCS = BODIES.map((b) => toHex(crc32(b)));

// imageNumber 故意与顺序脱节：第 1 个是 5，第 2、3 个都是 7（同号的常见情形）
const IMG_NUMS = [5, 7, 7];

const DAT_XML = `<?xml version="1.0"?>
<dat>
  <configuration>
    <datName>编号测试</datName><datVersion>1</datVersion>
    <system>Sega - Game Gear</system><imFolder>x</imFolder><romTitle>%n</romTitle>
  </configuration>
  <games>
${IMG_NUMS.map((n, i) => `    <game>
      <imageNumber>${n}</imageNumber><title>编号游戏${i + 1}</title><romSize>${BODIES[i].length}</romSize>
      <files><romCRC extension=".gg">${CRCS[i]}</romCRC></files>
      <comment>Numbered Game ${i + 1}</comment><duplicateID>${i + 1}</duplicateID>
    </game>`).join('\n')}
  </games>
</dat>`;

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const romDir = path.join(TMP, 'rom');
  await fsp.mkdir(romDir, { recursive: true });

  console.log('\n[1] DAT 解析阶段');
  const dat = parseDatXml(DAT_XML);
  ok('解析出 3 条', dat.games.length === 3, String(dat.games.length));
  ok('imageNumber 原样保留', JSON.stringify(dat.games.map((g) => g.imageNumber)) === JSON.stringify(IMG_NUMS),
    JSON.stringify(dat.games.map((g) => g.imageNumber)));
  ok('index 是条目顺序（1,2,3）', JSON.stringify(dat.games.map((g) => g.index)) === '[1,2,3]',
    JSON.stringify(dat.games.map((g) => g.index)));

  console.log('\n[2] 扫描后必须仍然带 imageNumber');
  for (let i = 0; i < BODIES.length; i++) {
    await fsp.writeFile(path.join(romDir, `g${i + 1}.gg`), BODIES[i]);
  }
  const scan = await scanner.scanLibrary({
    id: 't', settings: { romDir, outDir: path.join(TMP, 'out'), matchMode: 'both', scanMode: 'full', recursive: true, skipHidden: true },
  }, dat, {});

  const gotNums = scan.games.map((g) => g.imageNumber);
  ok('扫描结果保留 imageNumber', JSON.stringify(gotNums) === JSON.stringify(IMG_NUMS), JSON.stringify(gotNums));
  ok('扫描结果没有被替换成 index', JSON.stringify(gotNums) !== JSON.stringify(scan.games.map((g) => g.index)),
    'imageNumber=' + JSON.stringify(gotNums) + ' index=' + JSON.stringify(scan.games.map((g) => g.index)));
  ok('全部命中（owned=3）', scan.stats.owned === 3, JSON.stringify(scan.stats));

  console.log('\n[3] 截图文件名用 imageNumber 而不是 index');
  const g5 = scan.games[0]; // 序号 1，但编号应该是 5
  const names5 = covers.baseNames(g5, 'a');
  ok('候选名里出现 0005a', names5.includes('0005a'), names5.slice(0, 6).join(','));
  ok('候选名里不出现 0001a', !names5.includes('0001a'), names5.slice(0, 6).join(','));

  const g7 = scan.games[1]; // 序号 2，编号 7
  const names7 = covers.baseNames(g7, 'a');
  ok('第二条按 0007a 拼地址', names7.includes('0007a'), names7.slice(0, 6).join(','));
  ok('第二条不会拼成 0002a', !names7.includes('0002a'), names7.slice(0, 6).join(','));

  // 同号的两条应该拿到同一组候选名（DAT 本意如此）
  const g7b = scan.games[2];
  const numPart = (arr) => arr.filter((x) => /^[0-9]+a?$/.test(x));
  ok('同号条目的数字候选名一致', JSON.stringify(numPart(covers.baseNames(g7b, 'a'))) === JSON.stringify(numPart(names7)),
    JSON.stringify(numPart(covers.baseNames(g7b, 'a'))) + ' vs ' + JSON.stringify(numPart(names7)));

  console.log('\n[4] 未扫描时（直接读 DAT）编号也一致');
  ok('DAT 侧 imageNumber 同样是 5/7/7',
    JSON.stringify(dat.games.map((g) => g.imageNumber)) === JSON.stringify(gotNums),
    JSON.stringify(dat.games.map((g) => g.imageNumber)));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
