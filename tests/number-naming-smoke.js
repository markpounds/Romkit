/* 重命名编号一致性冒烟测试
 *
 * 用户反馈：列表里显示 0365，整理出来的文件名却是 0401。
 * 根因是 %u 用数组序号（index），而列表显示 DAT 的 imageNumber。
 *
 * 本测试锁定三条：
 *   ① %u 使用 imageNumber，与列表一致
 *   ② DAT 里同号的多条记录不会互相覆盖（后来的追加 -2）
 *   ③ 同号但标题不同（多盘）时文件名天然不同，不应被加后缀
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { buildPlan, renderName } = require('../lib/organizer');
const naming = require('../lib/naming');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-numname-' + Date.now());

function game(o) {
  return {
    index: o.index,
    imageNumber: o.imageNumber,
    title: o.title,
    comment: o.comment || o.title,
    publisher: 'Test', sourceRom: 'src', location: 'Japan', language: 'CHS',
    romSize: 1024, saveType: 'None',
    crcs: [{ crc: o.crc, extension: '.chd' }],
    tags: ['Japan', 'CHS'], ext: '.chd',
  };
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const romDir = path.join(TMP, 'rom');
  const outDir = path.join(TMP, 'out');
  await fsp.mkdir(romDir, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });

  console.log('\n[1] %u 用 imageNumber（与列表编号一致）');
  {
    const g = game({ index: 401, imageNumber: 365, title: '装甲核心2 (v0.3.2) (简)', crc: 'AAAABBBB' });
    const t = naming.tokensFor(g);
    ok('%u = 0365（不是序号 0401）', t.u === '0365', t.u);
    const name = renderName('%u - %n', g, { ext: '.chd' });
    ok('渲染出的文件名以 0365 开头', name.startsWith('0365 - '), name);
  }

  console.log('\n[2] 同号且同名 → 后来的追加 -2，不能互相覆盖');
  {
    // 两个条目 imageNumber 都是 659、标题也相同（本体与 DLC 典型的脏数据）
    const games = [
      game({ index: 699, imageNumber: 659, title: '纷争012 (简)', crc: 'CCCC1111' }),
      game({ index: 700, imageNumber: 659, title: '纷争012 (简)', crc: 'DDDD2222' }),
    ];
    const files = ['a.chd', 'b.chd'];
    for (let i = 0; i < 2; i++) await fsp.writeFile(path.join(romDir, files[i]), `data-${i}`);
    const scan = {
      games: games.map((g, i) => ({
        ...g, status: 'owned',
        matches: [{ container: 'file', path: path.join(romDir, files[i]), relPath: files[i], ext: '.chd', size: 6, crc: g.crcs[0].crc }],
      })),
    };
    const dat = { games, datVersion: 1, extensions: ['.chd'], imFolder: '', romTitle: '' };
    const lib = { id: 't1', settings: { outDir, mode: 'raw', operation: 'copy', fileTemplate: '%u - %n', archiveTemplate: '%u - %n' } };
    const plan = await buildPlan(lib, scan, dat);
    const outs = plan.items.filter((i) => i.action === 'copy-file' || i.action === 'extract').map((i) => path.basename(i.dest));
    ok('两个目标路径不重复', new Set(outs).size === outs.length, outs.join(' , '));
    ok('第一个用 0659', outs.some((n) => n.startsWith('0659 - ')), outs.join(' , '));
    ok('第二个追加 -2', outs.some((n) => /0659 - .*-2\.chd$/.test(n)), outs.join(' , '));
    ok('两条都被标记为已消歧', plan.items.filter((i) => i.deduped).length === 1,
      String(plan.items.filter((i) => i.deduped).length));
  }

  console.log('\n[3] 同号但标题不同（多盘）→ 天然不同名，不该被加后缀');
  {
    const games = [
      game({ index: 1, imageNumber: 1, title: '莎木2 (Disc 1) (简)', crc: 'EEEE1111' }),
      game({ index: 2, imageNumber: 1, title: '莎木2 (Disc 2) (简)', crc: 'FFFF2222' }),
    ];
    const files = ['d1.chd', 'd2.chd'];
    for (let i = 0; i < 2; i++) await fsp.writeFile(path.join(romDir, files[i]), `disc-${i}`);
    const scan = {
      games: games.map((g, i) => ({
        ...g, status: 'owned',
        matches: [{ container: 'file', path: path.join(romDir, files[i]), relPath: files[i], ext: '.chd', size: 6, crc: g.crcs[0].crc }],
      })),
    };
    const dat = { games, datVersion: 1, extensions: ['.chd'], imFolder: '', romTitle: '' };
    const lib = {
      id: 't2',
      settings: {
        outDir, mode: 'raw', operation: 'copy', fileTemplate: '%u - %n', archiveTemplate: '%u - %n',
        multiDiscFolder: true,
      },
    };
    const plan = await buildPlan(lib, scan, dat);
    const outs = plan.items.map((i) => path.basename(i.dest));
    ok('两盘编号都是 0001', outs.every((n) => n.startsWith('0001 - ')), outs.join(' , '));
    ok('没有多余的后缀', !outs.some((n) => /-2\.chd$/.test(n)), outs.join(' , '));
  }

  console.log('\n[4] 磁盘上已存在同名文件时的既有行为不受影响');
  {
    const g = game({ index: 5, imageNumber: 9, title: '已存在', crc: '99998888' });
    await fsp.writeFile(path.join(romDir, 'e.chd'), 'exists-src');
    await fsp.writeFile(path.join(outDir, '0009 - 已存在.chd'), 'old');
    const scan = {
      games: [{
        ...g, status: 'owned',
        matches: [{ container: 'file', path: path.join(romDir, 'e.chd'), relPath: 'e.chd', ext: '.chd', size: 10, crc: g.crcs[0].crc }],
      }],
    };
    const dat = { games: [g], datVersion: 1, extensions: ['.chd'], imFolder: '', romTitle: '' };
    const lib = { id: 't3', settings: { outDir, mode: 'raw', operation: 'copy', fileTemplate: '%u - %n', archiveTemplate: '%u - %n', conflict: 'skip' } };
    const plan = await buildPlan(lib, scan, dat);
    const it = plan.items.find((x) => x.game.index === 5);
    ok('目标已存在时仍标记 exists', !!it && it.exists === true, JSON.stringify({ exists: it && it.exists }));
    ok('文件名仍是 0009', it && path.basename(it.dest).startsWith('0009 - '), it && path.basename(it.dest));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
