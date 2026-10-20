'use strict';
/* 冒烟测试：`.md`（世嘉 MD/Genesis ROM 扩展名）不能被当成 Markdown 文档忽略 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { scanLibrary } = require('../lib/scanner');
const { crc32FileHex } = require('../lib/crc32');
const store = require('../lib/store');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

function datXml(ext) {
  return `<?xml version="1.0"?>
<dat><configuration>
  <datName>世嘉 MD</datName><datVersion>20260101</datVersion>
  <canOpen><extension>${ext}</extension></canOpen>
</configuration><games><game>
  <imageNumber>1</imageNumber><title>刺猬索尼克</title><saveType></saveType>
  <romSize>1024</romSize><publisher>SEGA</publisher><location>7</location><sourceRom>官中</sourceRom>
  <language>4</language>
  <files><romCRC extension="${ext}">12345678</romCRC></files>
  <im1CRC>AAAA1111</im1CRC><im2CRC>BBBB2222</im2CRC><comment>C</comment><duplicateID>1</duplicateID>
</game></games></dat>`;
}

async function main() {
  const tmp = path.join(os.tmpdir(), 'romkit-md-ext');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  try {
    // DAT 声明的扩展名是 .bin，但用户的 ROM 文件是 .md
    const rom = path.join(tmp, '刺猬索尼克.md');
    await fsp.writeFile(rom, Buffer.alloc(1024, 7));
    const crc = (await crc32FileHex(rom)).toUpperCase();

    const dat = {
      games: [{ index: 1, title: '刺猬索尼克', comment: 'Sonic', romSize: 1024, publisher: 'SEGA', im1CRC: 'AAAA1111', im2CRC: 'BBBB2222', imageNumber: 1, crcs: [{ crc, extension: '.bin' }], tags: [] }],
      datVersion: 1,
      extensions: ['.bin'],
    };
    const lib = {
      id: 't20',
      settings: { ...store.DEFAULT_SETTINGS, romDir: tmp, outDir: path.join(tmp, 'out'), mode: 'raw', operation: 'copy' },
    };
    const scan = await scanLibrary(lib, dat, {});
    const g = scan.games[0];
    ok(g && g.status === 'owned', `MD 的 .md ROM 能被 CRC 匹配上（status=${g && g.status}）`);
    ok(scan.stats.owned === 1, 'owned 计数 = 1');
    ok(scan.stats.files >= 1, `.md 文件进入了候选（files=${scan.stats.files}）`);
    ok(scan.stats.readErrors === 0, '没有被误报为读取失败');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
