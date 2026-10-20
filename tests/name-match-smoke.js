'use strict';
/* 冒烟测试：按文件名匹配 DAT 条目（各种脏文件名） */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { scanLibrary } = require('../lib/scanner');
const store = require('../lib/store');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

/** 构造一个只有标题的假 DAT（不含 CRC，走纯文件名匹配） */
function fakeDat(games) {
  return {
    games: games.map((t, i) => ({
      index: i + 1,
      title: t,
      comment: t,
      romSize: 0,
      publisher: '',
      location: '',
      sourceRom: '',
      language: '',
      im1CRC: '',
      im2CRC: '',
      imageNumber: i + 1,
      crcs: [],
      tags: [],
    })),
    datVersion: 1,
    extensions: ['.gg'],
  };
}

async function matchOne(fileName, title) {
  const tmp = path.join(os.tmpdir(), 'romkit-name-' + Math.random().toString(36).slice(2));
  await fsp.mkdir(tmp, { recursive: true });
  try {
    await fsp.writeFile(path.join(tmp, fileName), 'x'.repeat(16));
    const lib = {
      id: 'nametest',
      settings: { ...store.DEFAULT_SETTINGS, romDir: tmp, outDir: path.join(tmp, 'out'), mode: 'raw', operation: 'copy', matchMode: 'name' },
    };
    const scan = await scanLibrary(lib, fakeDat([title]), {});
    return scan.games[0].status === 'owned';
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const cases = [
    ['完全同名', 'Sonic The Hedgehog.gg', 'Sonic The Hedgehog', true],
    ['带编号前缀', '0001 - Sonic The Hedgehog.gg', 'Sonic The Hedgehog', true],
    ['带方括号编号', '[001] Sonic The Hedgehog.gg', 'Sonic The Hedgehog', true],
    ['带地区标签', 'Sonic The Hedgehog (USA).gg', 'Sonic The Hedgehog', true],
    ['带语言标签', 'Sonic The Hedgehog (USA) [En,Ja].gg', 'Sonic The Hedgehog', true],
    ['带全角括号', 'Sonic The Hedgehog（USA）.gg', 'Sonic The Hedgehog', true],
    ['标题带地区、文件不带', 'Sonic The Hedgehog.gg', 'Sonic The Hedgehog (USA)', true],
    ['文件带扩展名写进名字', 'Sonic The Hedgehog.gg (USA).gg', 'Sonic The Hedgehog', true],
    ['中文标题', '刺猬索尼克.gg', '刺猬索尼克', true],
    ['文件名多一个词', 'Sonic The Hedgehog 2.gg', 'Sonic The Hedgehog', false],
    ['完全不同的名字', 'Mario Bros.gg', 'Sonic The Hedgehog', false],
  ];
  for (const [label, file, title, expect] of cases) {
    const got = await matchOne(file, title);
    ok(got === expect, `${label}：${file} ↔ ${title} → ${got ? '命中' : '未命中'}（期望${expect ? '命中' : '未命中'}）`);
  }

  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
