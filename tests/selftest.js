'use strict';
/**
 * 自检脚本：node tests/selftest.js
 * 覆盖：DAT 解析 / CRC 扫描 / zip 打包与解压 / 两种输出形态 / 真实 DAT 兼容性
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert');

const TMP = path.join(os.tmpdir(), 'romkit-selftest');
process.env.ROMKIT_DATA = path.join(TMP, 'data');

const { crc32FileHex } = require('../lib/crc32');
const { packFile, listEntries, extractEntry } = require('../lib/zip');
const { parseDatXml, loadDatFile } = require('../lib/dat');
const { scanLibrary } = require('../lib/scanner');
const { buildPlan, executePlan } = require('../lib/organizer');
const store = require('../lib/store');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function datXml(games) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<dat xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <configuration>
    <datName>Selftest Dat</datName>
    <imFolder>Selftest</imFolder>
    <datVersion>100</datVersion>
    <system>Sega - Game Gear</system>
    <screenshotsWidth>160</screenshotsWidth>
    <screenshotsHeight>144</screenshotsHeight>
    <infos>
      <title visible="true" inNamingOption="true" default="false"/>
      <location visible="true" inNamingOption="true" default="true"/>
      <publisher visible="true" inNamingOption="true" default="true"/>
      <sourceRom visible="true" inNamingOption="true" default="true"/>
      <romSize visible="true" inNamingOption="true" default="true"/>
      <saveType visible="true" inNamingOption="true" default="true"/>
      <releaseNumber visible="false" inNamingOption="true" default="false"/>
      <imageNumber visible="false" inNamingOption="false" default="false"/>
      <languageNumber visible="false" inNamingOption="false" default="false"/>
      <comment visible="true" inNamingOption="true" default="true"/>
      <romCRC visible="true" inNamingOption="true" default="true"/>
      <im1CRC visible="false" inNamingOption="false" default="false"/>
      <im2CRC visible="false" inNamingOption="false" default="false"/>
      <languages visible="true" inNamingOption="true" default="true"/>
    </infos>
    <canOpen><extension>.gg</extension></canOpen>
    <newDat>
      <datVersionURL>http://example.com/ver</datVersionURL>
      <datURL fileName="selftest.zip">http://example.com/dat</datURL>
      <imURL>http://example.com/img/</imURL>
    </newDat>
    <romTitle>%u - %n [%g]</romTitle>
  </configuration>
  <games>
${games.map((g, i) => `    <game>
      <imageNumber>${i + 1}</imageNumber>
      <releaseNumber>${i + 1}</releaseNumber>
      <title>${g.title}</title>
      <saveType></saveType>
      <romSize>${g.size}</romSize>
      <publisher>${g.publisher || 'Sega'}</publisher>
      <location>7</location>
      <sourceRom>${g.sourceRom || '官中'}</sourceRom>
      <language>4</language>
      <files><romCRC extension=".gg">${g.crc}</romCRC></files>
      <im1CRC>AAAA1111</im1CRC>
      <im2CRC>BBBB2222</im2CRC>
      <comment>${g.comment}</comment>
      <duplicateID>${i + 1}</duplicateID>
    </game>`).join('\n')}
  </games>
  <gui><images width="327" height="146">
    <image x="0" y="0" width="160" height="144"/>
    <image x="165" y="0" width="160" height="144"/>
  </images></gui>
</dat>`;
}

async function main() {
  await fsp.rm(TMP, { recursive: true, force: true });
  const roms = path.join(TMP, 'roms');
  const outZip = path.join(TMP, 'out-zip');
  const outRaw = path.join(TMP, 'out-raw');
  await fsp.mkdir(path.join(roms, 'sub'), { recursive: true });

  console.log('\n[1] 生成测试 ROM 与 DAT');
  const specs = [
    { title: '铁甲飞龙迷你版 (简)', comment: 'Panzer Dragoon Mini (Japan) [CHS]', size: 64 * 1024 },
    { title: '光明力量外传 - 最终冲突 (简)', comment: 'Shining Force Gaiden - Final Conflict (Japan) [CHS]', size: 200 * 1024 },
    { title: '索尼克 (简)', comment: 'Sonic the Hedgehog (Japan) [CHS]', size: 128 * 1024 },
  ];
  const games = [];
  for (let i = 0; i < specs.length; i++) {
    const p = path.join(roms, i === 2 ? 'sub' : '', `rom${i}.gg`);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, crypto.randomBytes(specs[i].size));
    const crc = await crc32FileHex(p);
    games.push({ ...specs[i], crc, path: p });
  }
  // 把第一个游戏预先打包成 zip，模拟"库里已经有压缩包"
  const zipped = path.join(roms, 'Panzer Dragoon Mini.zip');
  await packFile(games[0].path, zipped, { entryName: 'Panzer Dragoon Mini (Japan).gg', compress: true });
  await fsp.rm(games[0].path);
  games[0].zip = zipped;

  const xml = datXml(games);
  const xmlPath = path.join(TMP, 'test.xml');
  await fsp.writeFile(xmlPath, xml, 'utf8');
  ok('DAT 文件已生成', fs.existsSync(xmlPath));

  console.log('\n[2] DAT 解析');
  const { dat } = await loadDatFile(xmlPath);
  ok('datName 解析正确', dat.datName === 'Selftest Dat', dat.datName);
  ok('system 解析正确', dat.system === 'Sega - Game Gear', dat.system);
  ok('游戏数 = 3', dat.games.length === 3, String(dat.games.length));
  ok('扩展名 .gg 被识别', dat.extensions.includes('.gg'), dat.extensions.join(','));
  ok('CRC 归一化为 8 位大写', /^[0-9A-F]{8}$/.test(dat.games[0].crcs[0].crc), dat.games[0].crcs[0].crc);
  ok('中文标题正确', dat.games[0].title === '铁甲飞龙迷你版 (简)', dat.games[0].title);
  ok('标签提取 (Japan)/[CHS]', dat.games[0].tags.join('|') === 'Japan|CHS', dat.games[0].tags.join('|'));
  ok('newDat 更新源解析', dat.newDat.datVersionURL === 'http://example.com/ver');

  console.log('\n[3] zip 读写');
  const entries = await listEntries(zipped);
  ok('读取 zip 条目', entries.length === 1, String(entries.length));
  ok('zip 内 CRC 与源文件一致', entries[0].crc === games[0].crc, entries[0].crc + ' vs ' + games[0].crc);
  const extracted = path.join(TMP, 'extract-test.gg');
  await extractEntry(zipped, entries[0], extracted);
  const extCrc = await crc32FileHex(extracted);
  ok('解压后 CRC 一致', extCrc === games[0].crc, extCrc);
  ok('解压后大小一致', (await fsp.stat(extracted)).size === specs[0].size);

  console.log('\n[4] 扫描匹配');
  const lib = {
    id: 'test', name: 'Selftest',
    settings: {
      ...store.DEFAULT_SETTINGS,
      romDir: roms, outDir: outZip, mode: 'zip', matchMode: 'both', scanMode: 'full',
      operation: 'copy', // 自检要反复整理同一批源文件，不能删源
      // 本测试用固定模板，保证文件名断言稳定（默认模板的验证见 naming.test.js）
      fileTemplate: '{title}', archiveTemplate: '{title}',
    },
  };
  const scan = await scanLibrary(lib, dat, {});
  ok('扫描到 3 个文件', scan.stats.files === 3, String(scan.stats.files));
  ok('3 个游戏全部命中', scan.stats.owned === 3, JSON.stringify(scan.stats));
  ok('第一个（zip 内）状态 owned', scan.games[0].status === 'owned', scan.games[0].status);
  ok('zip 内匹配走 CRC', scan.games[0].matches[0].via === 'crc');
  ok('子目录文件被扫描到', scan.games[2].status === 'owned', scan.games[2].status);

  console.log('\n[5] 整理 → 保留压缩包 (zip)');
  const planZip = await buildPlan(lib, scan, dat);
  ok('计划 3 项', planZip.items.length === 3, String(planZip.items.length));
  const r1 = await executePlan(lib, planZip, {});
  ok('执行成功 3 项', r1.done === 3 && r1.failed === 0, JSON.stringify({ done: r1.done, failed: r1.failed, errors: r1.errors }));
  const outFiles = await fsp.readdir(outZip);
  ok('输出 3 个 zip', outFiles.filter((f) => f.endsWith('.zip')).length === 3, outFiles.join(','));
  for (const g of games) {
    const f = path.join(outZip, specs[games.indexOf(g)].title + '.zip');
    const exists = fs.existsSync(f);
    ok('输出文件名按模板：' + path.basename(f), exists);
    if (exists) {
      const e = await listEntries(f);
      ok('  └ zip 内条目 CRC 正确', e[0].crc === g.crc, e[0].crc + ' vs ' + g.crc);
    }
  }

  console.log('\n[6] 整理 → 保留原始文件 (raw)');
  const libRaw = { ...lib, settings: { ...lib.settings, mode: 'raw', outDir: outRaw } };
  const planRaw = await buildPlan(libRaw, scan, dat);
  const rawActs = planRaw.items.map((i) => i.action).sort();
  ok('zip 源 → 解压动作', rawActs.includes('extract'), rawActs.join(','));
  ok('裸文件源 → 复制动作', rawActs.includes('copy-file'), rawActs.join(','));
  const r2 = await executePlan(libRaw, planRaw, {});
  ok('执行成功 3 项', r2.done === 3 && r2.failed === 0, JSON.stringify({ done: r2.done, failed: r2.failed, errors: r2.errors }));
  const rawFiles = (await fsp.readdir(outRaw)).filter((f) => f.endsWith('.gg'));
  ok('输出 3 个 .gg 裸文件', rawFiles.length === 3, rawFiles.join(','));
  for (const f of rawFiles) {
    const crc = await crc32FileHex(path.join(outRaw, f));
    ok('  └ ' + f + ' CRC 正确', games.some((g) => g.crc === crc), crc);
  }

  console.log('\n[7] 冲突与覆盖');
  const planAgain = await buildPlan(lib, scan, dat);
  ok('重新生成计划时检测到冲突', planAgain.conflicts === 3, String(planAgain.conflicts));
  const r3 = await executePlan(lib, planAgain, {});
  ok('重复整理默认跳过', r3.skipped === 3, JSON.stringify({ skipped: r3.skipped, done: r3.done }));

  console.log('\n[8] 真实 DAT 兼容性（CHS_PS2_OL.zip）');
  const realDat = 'D:\\Downloads\\CHS_PS2_OL.zip';
  if (fs.existsSync(realDat)) {
    const { dat: ps2 } = await loadDatFile(realDat);
    ok('PS2 DAT 解析成功', ps2.games.length > 300, String(ps2.games.length));
    ok('PS2 平台名正确', ps2.system === 'Sony - PlayStation 2', ps2.system);
    ok('PS2 扩展名 .chd', ps2.extensions.includes('.chd'), ps2.extensions.join(','));
    ok('PS2 更新源存在', !!ps2.newDat.datVersionURL, String(ps2.newDat && ps2.newDat.datVersionURL));
    ok('首个游戏有中文标题', /[\u4e00-\u9fa5]/.test(ps2.games[0].title), ps2.games[0].title);
    ok('CRC 合法', /^[0-9A-F]{8}$/.test(ps2.games[0].crcs[0].crc), ps2.games[0].crcs[0].crc);
  } else {
    console.log('  - 跳过（未找到 ' + realDat + '）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
