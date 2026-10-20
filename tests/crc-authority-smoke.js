/* CRC 权威性冒烟测试
 * 覆盖用户反馈的三个问题：
 *   1) 不同的 CRC 视为不同的文件（同名但 CRC 不匹配不得硬套）
 *   2) 压缩包条目后缀与 DAT 声明不同，但 CRC 一致 → 必须匹配成功
 *   3) 输出目录不可写时，错误必须可读（而不是裸 EACCES）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const scanner = require('../lib/scanner');
const { packFile } = require('../lib/zip');
const { crc32, toHex } = require('../lib/crc32');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ' → ' + extra}`);
}

const TMP = path.join(os.tmpdir(), 'romkit-crc-authority-' + Date.now());

/** 造一个最小 DAT */
function makeDat(games, extensions) {
  return {
    datName: 'test',
    datVersion: 1,
    system: 'Test',
    extensions: extensions || ['chd'],
    imFolder: '',
    romTitle: '',
    games: games.map((g, i) => ({
      index: i + 1,
      title: g.title,
      comment: g.title,
      publisher: '',
      crcs: [{ crc: g.crc, extension: g.ext || 'chd' }],
      tags: [],
      titleKey: g.title,
      nameKey: g.title,
    })),
  };
}

async function setup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  await fsp.mkdir(path.join(TMP, 'rom'), { recursive: true });
  await fsp.mkdir(path.join(TMP, 'out'), { recursive: true });
}

function libFor(romDir, outDir, extra) {
  return {
    id: 'testlib',
    settings: {
      romDir,
      outDir,
      matchMode: 'both',
      scanMode: 'full',
      recursive: true,
      skipHidden: true,
      mode: 'raw',
      ...extra,
    },
  };
}

(async () => {
  console.log('\n[1] 不同 CRC = 不同文件');
  await setup();

  // 文件内容 A、B 不同 → CRC 不同；但文件名和 DAT 条目同名
  const contentA = Buffer.from('AAAA-content-original');
  const contentB = Buffer.from('BBBB-content-modified-patch');
  const crcA = toHex(crc32(contentA));
  const crcB = toHex(crc32(contentB));
  t('两个内容确实产生不同 CRC', crcA !== crcB, `A=${crcA} B=${crcB}`);

  await fsp.writeFile(path.join(TMP, 'rom', '同名游戏.chd'), contentA);
  const dat1 = makeDat([{ title: '同名游戏', crc: crcB }]); // 只收 B 的 CRC
  const r1 = await scanner.scanLibrary(libFor(path.join(TMP, 'rom'), path.join(TMP, 'out')), dat1, {});
  t('磁盘上只有 CRC=A 的文件，清单要的是 B → 不应匹配', r1.games[0].matches.length === 0,
    `实得 ${r1.games[0].matches.length} 个匹配`);

  // 反向：清单要的正是 A → 应匹配
  const dat2 = makeDat([{ title: '同名游戏', crc: crcA }]);
  const r2 = await scanner.scanLibrary(libFor(path.join(TMP, 'rom'), path.join(TMP, 'out')), dat2, {});
  t('清单要 A、磁盘是 A → 匹配成功', r2.games[0].matches.length === 1,
    `实得 ${r2.games[0].matches.length}`);

  console.log('\n[2] 压缩包内条目后缀不同但 CRC 一致');
  await setup();
  const packBody = Buffer.from('texture-pack-binary-content-' + Date.now());
  const packCrc = toHex(crc32(packBody));
  // 条目名用 .dat（飞牛上纹理包常见），而 DAT 声明的是 .chd
  const srcPack = path.join(TMP, 'src-pack.dat');
  await fsp.writeFile(srcPack, packBody);
  await packFile(srcPack, path.join(TMP, 'rom', '0003 - 纹理包.zip'), { entryName: '0003 - 纹理包.dat' });
  const dat3 = makeDat([{ title: '0004 - 纹理包', crc: packCrc, ext: 'chd' }], ['chd']);
  const r3 = await scanner.scanLibrary(libFor(path.join(TMP, 'rom'), path.join(TMP, 'out')), dat3, {});
  t('zip 条目 .dat ↔ DAT 声明 .chd，CRC 一致 → 应匹配', r3.games[0].matches.length === 1,
    `实得 ${r3.games[0].matches.length}，明细 ${JSON.stringify(r3.games[0].matches.map((m) => m.entryName))}`);

  console.log('\n[3] 多个压缩包时，兜底逻辑不应被前一个包"吃掉"');
  await setup();
  const bodyX = Buffer.from('pack-x-' + Date.now());
  const bodyY = Buffer.from('pack-y-' + Date.now());
  const sx = path.join(TMP, 'x.bin');
  await fsp.writeFile(sx, bodyX);
  await packFile(sx, path.join(TMP, 'rom', 'AAA-unknown.zip'), { entryName: 'whatever.bin' });
  // 第二个包：条目名就是游戏名，但条目 CRC 不在 DAT 里 → 按新规则不硬套
  const sy = path.join(TMP, 'y.dat');
  await fsp.writeFile(sy, bodyY);
  await packFile(sy, path.join(TMP, 'rom', 'BBB-游戏二.zip'), { entryName: '游戏二.dat' });
  const dat4 = makeDat([{ title: '游戏二', crc: '00000000', ext: 'dat' }], ['dat']);
  const r4 = await scanner.scanLibrary(libFor(path.join(TMP, 'rom'), path.join(TMP, 'out')), dat4, {});
  t('条目 CRC 已知但不匹配 → 不靠文件名硬套', r4.games[0].matches.length === 0,
    `实得 ${r4.games[0].matches.length}`);

  console.log('\n[4] 输出目录不可写时给出可读错误');
  await setup();
  const organizer = require('../lib/organizer');
  const plan = { outDir: path.join(TMP, 'out'), items: [] };
  let err = null;
  try {
    // 造一个指向文件的路径当输出目录 → mkdir 必然失败
    const blocker = path.join(TMP, 'out', 'not-a-dir');
    await fsp.writeFile(blocker, 'x');
    await organizer.executePlan({ id: 'l1', settings: {} }, { outDir: path.join(blocker, 'sub'), items: [] }, {});
  } catch (e) {
    err = e;
  }
  t('创建不出的输出目录 → 抛错而不是静默', !!err, err ? err.message.slice(0, 60) : '未抛错');
  if (err) {
    t('错误信息不含裸 EACCES 代码（可读性）',
      !/^EACCES/.test(err.message) && !/^ENOTDIR/.test(err.message), err.message.slice(0, 80));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
