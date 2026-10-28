/* DAT 条目编辑（覆盖层）冒烟测试
 *
 * 覆盖：合并多条、重命名、多文件、条目级匹配方式、与更新后 DAT 的冲突检测。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const overrides = require('../lib/overrides');
const scanner = require('../lib/scanner');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-ov-' + Date.now());
overrides.setDataDirGetter(() => TMP);

function game(i, title, ext, size, crc) {
  return {
    index: i, imageNumber: i, title, comment: `${title} (China)`,
    publisher: 'T', sourceRom: 's', location: 'China', language: 'CHS',
    romSize: size, saveType: 'None',
    crcs: [{ crc, extension: ext }], tags: ['China'], ext,
  };
}

const baseDat = {
  datName: '测试', datVersion: '1', system: 'Test',
  extensions: ['.bin', '.chd'],
  games: [
    game(1, '游戏甲', '.bin', 100, '11111111'),
    game(2, '游戏甲 DLC', '.bin', 20, '22222222'),
    game(3, '游戏乙', '.chd', 300, '33333333'),
  ],
};

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  await fsp.mkdir(TMP, { recursive: true });

  console.log('\n[1] 合并两个条目');
  {
    const book = overrides.emptyBook();
    const picked = [baseDat.games[0], baseDat.games[1]];
    book.entries.push({
      id: 'ov_test1', name: '游戏甲（含 DLC）',
      files: [
        { ext: '.bin', size: 100, crc: '11111111' },
        { ext: '.bin', size: 20, crc: '22222222' },
      ],
      matchMode: 'dat',
      sourceIndexes: [1, 2],
      snapshot: picked.map(overrides.snapshotOf),
    });
    await overrides.save('libA', book);

    const res = overrides.apply(baseDat, await overrides.load('libA'));
    ok('条目数从 3 变 2', res.dat.games.length === 2, String(res.dat.games.length));
    const merged = res.dat.games.find((g) => g.index === 1);
    ok('合并条目沿用靠前那条的 index', !!merged, 'index 1 不存在');
    ok('名称取自定义名称', merged.title === '游戏甲（含 DLC）', merged.title);
    ok('包含两个文件', (merged.crcs || []).length === 2, JSON.stringify(merged.crcs));
    ok('标记为已修改', merged.overridden === true);
    ok('被吃掉的第 2 条不再出现', !res.dat.games.some((g) => g.index === 2));
    ok('未被引用的第 3 条原样保留', res.dat.games.some((g) => g.index === 3 && g.title === '游戏乙'));
    ok('没有冲突', res.conflicts.length === 0, JSON.stringify(res.conflicts));
  }

  console.log('\n[2] 更新 DAT 后检测冲突');
  {
    // 标题变了
    const changed = {
      ...baseDat,
      datVersion: '2',
      games: baseDat.games.map((g) => (g.index === 1 ? { ...g, title: '游戏甲（改名了）' } : g)),
    };
    const res = overrides.apply(changed, await overrides.load('libA'));
    ok('标题变化被识别为冲突', res.conflicts.length === 1, JSON.stringify(res.conflicts));
    ok('冲突原因提到"内容与修改时不同"',
      /不同/.test(res.conflicts[0].reasons.join(' ')), JSON.stringify(res.conflicts[0].reasons));

    // 条目被删了
    const removed = { ...baseDat, datVersion: '3', games: baseDat.games.filter((g) => g.index !== 2) };
    const res2 = overrides.apply(removed, await overrides.load('libA'));
    ok('条目消失也被识别为冲突', res2.conflicts.length === 1, JSON.stringify(res2.conflicts));
    ok('冲突原因提到"已经没有"',
      /已经没有/.test(res2.conflicts[0].reasons.join(' ')), JSON.stringify(res2.conflicts[0].reasons));
  }

  console.log('\n[3] 条目级匹配方式：只认 CRC 的条目不会被文件名蒙混');
  {
    const rom = path.join(TMP, 'rom');
    await fsp.mkdir(rom, { recursive: true });
    // 文件名叫「游戏乙」，但内容与 CRC 对不上
    await fsp.writeFile(path.join(rom, '游戏乙.chd'), Buffer.alloc(300, 9));

    const dat = {
      ...baseDat,
      games: [
        { ...game(3, '游戏乙', '.chd', 300, 'DEADBEEF'), matchMode: 'crc' },
      ],
    };
    const lib = {
      id: 'x',
      settings: { romDir: rom, outDir: path.join(TMP, 'out'), mode: 'raw', matchMode: 'both', recursive: true, skipHidden: true, scanMode: 'full' },
    };
    const scan = await scanner.scanLibrary(lib, dat, {});
    ok('条目指定 crc 时，名字对上也不算已拥有', scan.games[0].status !== 'owned', scan.games[0].status);

    // 同一条改成 name 就能匹配上
    const dat2 = { ...dat, games: [{ ...dat.games[0], matchMode: 'name' }] };
    const scan2 = await scanner.scanLibrary(lib, dat2, {});
    ok('改成 name 后按名字匹配成功', scan2.games[0].status === 'owned', scan2.games[0].status);
  }

  console.log('\n[4] 条目级 name-size');
  {
    const rom = path.join(TMP, 'rom2');
    await fsp.mkdir(rom, { recursive: true });
    await fsp.writeFile(path.join(rom, '尺寸游戏.chd'), Buffer.alloc(64, 1));
    const dat = {
      ...baseDat,
      games: [{ ...game(5, '尺寸游戏', '.chd', 64, 'ABCDABCD'), matchMode: 'name-size' }],
    };
    const lib = {
      id: 'y',
      settings: { romDir: rom, outDir: path.join(TMP, 'out2'), mode: 'raw', matchMode: 'both', recursive: true, skipHidden: true, scanMode: 'full' },
    };
    const scan = await scanner.scanLibrary(lib, dat, {});
    ok('指定 name-size 且大小一致 → 已拥有', scan.games[0].status === 'owned', scan.games[0].status);
    ok('证据来源是 name-size', (scan.games[0].matches[0] || {}).via === 'name-size',
      JSON.stringify((scan.games[0].matches[0] || {}).via));
  }

  console.log('\n[5] 总条目只存标题/英文名，其余在子条目上');
  {
    const book = overrides.emptyBook();
    book.entries.push({
      id: 'ov_fields1', name: '数码宝贝大冒险02（合集）',
      files: [
        { ext: '.bin', size: 100, crc: '11111111', label: '简' },
        { ext: '.bin', size: 20, crc: '22222222', label: '繁' },
      ],
      fields: { comment: 'Digimon Adventure 02 Collection', romSize: 120 },
      // 子条目 2 改了标题、厂商、语言
      children: [{ index: 2, fields: { title: '数码宝贝大冒险02（繁）', publisher: 'Bandai', language: 'CHT' } }],
      matchMode: 'dat',
      sourceIndexes: [1, 2],
      snapshot: [baseDat.games[0], baseDat.games[1]].map(overrides.snapshotOf),
    });
    await overrides.save('libB', book);
    const res = overrides.apply(baseDat, await overrides.load('libB'));
    const g = res.dat.games.find((x) => x.index === 1);
    ok('标题用自定义名称', g.title === '数码宝贝大冒险02（合集）', g.title);
    ok('英文名被覆盖', g.comment === 'Digimon Adventure 02 Collection', g.comment);
    ok('总条目容量可覆盖', g.romSize === 120, String(g.romSize));
    ok('厂商等字段交给子条目，总条目不直接给', g.publisher === '', g.publisher);
    ok('文件带标签', g.crcs[0].label === '简' && g.crcs[1].label === '繁', JSON.stringify(g.crcs));
    ok('文件带各自大小', g.crcs[0].size === 100 && g.crcs[1].size === 20, JSON.stringify(g.crcs.map((c) => c.size)));
    ok('多文件条目标记 multiFile', g.multiFile === true, String(g.multiFile));
    const c2 = g.children.find((x) => x.index === 2);
    ok('子条目标题可改', c2.title === '数码宝贝大冒险02（繁）', c2.title);
    ok('子条目厂商可改', c2.publisher === 'Bandai', c2.publisher);
    ok('子条目语言可改', c2.language === 'CHT', c2.language);
    // 子条目 1 没改过 → 全部跟随 DAT
    const c1 = g.children.find((x) => x.index === 1);
    ok('没改的子条目字段跟随 DAT', c1.publisher === 'T' && c1.language === 'CHS',
      `${c1.publisher}/${c1.language}`);
  }

  console.log('\n[6] 多文件条目：全部找到才算拥有');
  {
    const { crc32FileHex } = require('../lib/crc32');
    const rom = path.join(TMP, 'rom3');
    await fsp.mkdir(rom, { recursive: true });
    // 简版在，繁版不在（CRC 用真实算出来的，别用字面值）
    const f1 = path.join(rom, '合集-简.ws');
    await fsp.writeFile(f1, Buffer.alloc(4194304, 1));
    const crc1 = await crc32FileHex(f1);
    const buf2 = Buffer.alloc(4194304, 2);
    const crc2 = await crc32FileHex(await (() => {
      const p = path.join(TMP, 'tmp-繁.ws');
      return fsp.writeFile(p, buf2).then(() => p);
    })());

    const dat = {
      ...baseDat,
      games: [{
        index: 1, imageNumber: 1, title: '合集', comment: '合集 (Japan)',
        publisher: 'T', sourceRom: 's', location: 'Japan', language: 'CHS',
        romSize: 4194304, saveType: 'None',
        crcs: [
          { crc: crc1, extension: '.ws', size: 4194304, label: '简' },
          { crc: crc2, extension: '.ws', size: 4194304, label: '繁' },
        ],
        tags: ['Japan'], ext: '.ws', multiFile: true,
      }],
    };
    const lib = {
      id: 'z',
      settings: { romDir: rom, outDir: path.join(TMP, 'out3'), mode: 'raw', matchMode: 'crc', recursive: true, skipHidden: true, scanMode: 'full' },
    };
    const scan1 = await scanner.scanLibrary(lib, dat, {});
    ok('只找到一个文件 → 不算已拥有', scan1.games[0].status === 'missing', scan1.games[0].status);
    ok('fileCheck 标出已找到 1/2',
      scan1.games[0].fileCheck && scan1.games[0].fileCheck.found === 1 && scan1.games[0].fileCheck.total === 2,
      JSON.stringify(scan1.games[0].fileCheck));
    ok('缺失清单里是「繁」那份',
      scan1.games[0].fileCheck && scan1.games[0].fileCheck.missing.length === 1
        && scan1.games[0].fileCheck.missing[0].crc === crc2
        && scan1.games[0].fileCheck.missing[0].label === '繁',
      JSON.stringify(scan1.games[0].fileCheck && scan1.games[0].fileCheck.missing));

    // 补上繁版 → 已拥有
    await fsp.writeFile(path.join(rom, '合集-繁.ws'), buf2);
    const scan2 = await scanner.scanLibrary(lib, dat, {});
    ok('两个文件都在 → 已拥有', scan2.games[0].status === 'owned', scan2.games[0].status);
    ok('全部找到时不出 fileCheck', scan2.games[0].fileCheck === undefined, JSON.stringify(scan2.games[0].fileCheck));

    // 原生 DAT 的多 CRC（同一 ROM 的不同格式）保持「任一命中」
    const f3 = path.join(rom, '原生双格式.md');
    await fsp.writeFile(f3, Buffer.alloc(100, 3));
    const crc3 = await crc32FileHex(f3);
    const nativeDat = {
      ...baseDat,
      games: [{
        ...game(9, '原生双格式', '.md', 100, crc3),
        crcs: [{ crc: crc3, extension: '.md' }, { crc: 'BBBB0000', extension: '.gen' }],
      }],
    };
    const scan3 = await scanner.scanLibrary(lib, nativeDat, {});
    ok('原生多 CRC 条目仍是任一命中', scan3.games[0].status === 'owned', scan3.games[0].status);
  }

  console.log('\n[7] 合并 = 总条目 + 子条目');
  {
    const book = overrides.emptyBook();
    book.entries.push({
      id: 'ov_kids1', name: '数码宝贝大冒险02（简繁合集）',
      files: [
        { ext: '.ws', size: 4194304, crc: '632C55A1', label: '简' },
        { ext: '.ws', size: 4194304, crc: '09D4AD57', label: '繁' },
      ],
      fields: { comment: 'Digimon Adventure 02' },
      children: [
        { index: 2, fields: { title: '数码宝贝大冒险02（繁）', language: 'CHT' } },
      ],
      matchMode: 'dat',
      sourceIndexes: [1, 2],
      snapshot: [baseDat.games[0], baseDat.games[1]].map(overrides.snapshotOf),
    });
    await overrides.save('libC', book);
    const res = overrides.apply(baseDat, await overrides.load('libC'));
    const g = res.dat.games.find((x) => x.index === 1);
    ok('总条目标题 = 自定义名称', g.title === '数码宝贝大冒险02（简繁合集）', g.title);
    ok('总条目英文名 = fields.comment', g.comment === 'Digimon Adventure 02', g.comment);
    ok('总条目不带子条目以外的字段（厂商留空由子条目提供）', g.publisher === '', g.publisher);
    ok('有 2 个子条目', (g.children || []).length === 2, JSON.stringify((g.children || []).map((c) => c.index)));
    ok('子条目保留各自编号', g.children[0].index === 1 && g.children[1].index === 2,
      JSON.stringify(g.children.map((c) => c.index)));
    ok('子条目保留各自标题', g.children[0].title === '游戏甲' && g.children[1].title === '数码宝贝大冒险02（繁）',
      JSON.stringify(g.children.map((c) => c.title)));
    ok('子条目字段可单独改', g.children[1].language === 'CHT', g.children[1].language);
    ok('没改的子条目字段跟随 DAT', g.children[0].language === 'CHS', g.children[0].language);
    ok('扫描用的 CRC 是子条目的合集', (g.crcs || []).length === 2, JSON.stringify(g.crcs.map((c) => c.crc)));
  }

  console.log('\n[8] 整理：合并条目每个文件各自输出，不当重复副本');
  {
    const organizer = require('../lib/organizer');
    const { crc32FileHex } = require('../lib/crc32');
    const rom = path.join(TMP, 'rom4');
    const out = path.join(TMP, 'out4');
    await fsp.mkdir(rom, { recursive: true });
    await fsp.mkdir(out, { recursive: true });
    const a = path.join(rom, '简版.ws');
    const b = path.join(rom, '繁版.ws');
    await fsp.writeFile(a, Buffer.alloc(64, 1));
    await fsp.writeFile(b, Buffer.alloc(64, 2));
    const crcA = await crc32FileHex(a);
    const crcB = await crc32FileHex(b);

    const dat = {
      ...baseDat,
      games: [{
        index: 1, imageNumber: 1, title: '简繁合集', comment: '', publisher: '',
        sourceRom: '', location: '', language: '', romSize: 64, saveType: '',
        crcs: [
          { crc: crcA, extension: '.ws', size: 64, label: '简' },
          { crc: crcB, extension: '.ws', size: 64, label: '繁' },
        ],
        tags: [], ext: '.ws', multiFile: true,
        children: [
          { index: 1, imageNumber: 1, title: '简版', romSize: 64, crcs: [{ crc: crcA, extension: '.ws', size: 64, label: '简' }], tags: [] },
          { index: 2, imageNumber: 2, title: '繁版', romSize: 64, crcs: [{ crc: crcB, extension: '.ws', size: 64, label: '繁' }], tags: [] },
        ],
      }],
    };
    const lib = {
      id: 'w',
      settings: {
        romDir: rom, outDir: out, mode: 'raw', matchMode: 'crc', operation: 'copy',
        recursive: true, skipHidden: true, scanMode: 'full',
        duplicateAction: 'move',
      },
    };
    const scan = await scanner.scanLibrary(lib, dat, {});
    ok('两个文件都找到 → 已拥有', scan.games[0].status === 'owned', scan.games[0].status);
    const plan = await organizer.buildPlan(lib, scan, dat);
    const real = (plan.items || []).filter((it) => it.action === 'copy-file' || it.action === 'extract');
    ok('计划里输出 2 个文件', real.length === 2, JSON.stringify(real.map((i) => [i.action, i.dest])));
    ok('没有被误判成重复副本', !plan.duplicates, String(plan.duplicates));
    ok('文件名各自用子条目的编号+标题',
      real.some((i) => /繁版/.test(i.dest)) && real.some((i) => /简版/.test(i.dest)),
      JSON.stringify(real.map((i) => path.basename(i.dest))));
    ok('没有「移走副本」动作',
      !(plan.items || []).some((it) => it.action === 'remove-duplicate' || it.action === 'delete-duplicate'),
      JSON.stringify(plan.items.map((i) => i.action)));
  }

  console.log('\n[9] 删除修改后恢复原样');
  {
    const book = await overrides.load('libA');
    book.entries = [];
    await overrides.save('libA', book);
    const res = overrides.apply(baseDat, await overrides.load('libA'));
    ok('条目数回到 3', res.dat.games.length === 3, String(res.dat.games.length));
    ok('名称回到 DAT 原始值', res.dat.games.find((g) => g.index === 1).title === '游戏甲');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
