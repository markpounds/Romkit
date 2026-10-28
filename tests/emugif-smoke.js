/* 站点数据（dat.emugif.com 发布链接 + 发布说明）冒烟测试
 *
 * 默认不联网：只测「认机种 / 建索引 / 匹配 / 出表」这些纯逻辑。
 * 想连真站跑一遍端到端：ROMKIT_NET=1 node tests/emugif-smoke.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const emugif = require('../lib/emugif');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-site-' + Date.now());
emugif.setDataDirGetter(() => TMP);

const datPs2 = {
  datName: 'Chinese Game Dat (Simplified) - PS2',
  newDat: {
    datVersionURL: 'http://dat.emugif.com/update/?ver=ps2',
    datURL: 'http://dat.emugif.com/dat/ps2.zip',
    imURL: 'http://dat.emugif.com/img/ps2/',
  },
};

const datGb = {
  datName: 'Chinese Game Dat (Simplified) - GB',
  newDat: { imURL: 'http://dat.emugif.com/img/gb/' }, // 没有 ver=，靠 imURL 兜底
};

const datOther = {
  datName: 'No-Intro',
  newDat: { datVersionURL: 'https://datomatic.no-intro.org/' },
};

function item(id, crcs, opts = {}) {
  return {
    id, releaseNumber: String(id), title: '标题' + id, orgTitle: 'Title' + id,
    comment: opts.comment || '', links: opts.links || [],
    im1CRC: opts.im1CRC || '', im2CRC: '', crcs,
    publisher: '', sourceRom: '', updateTime: 1700000000,
  };
}

const payload = {
  consoleType: 'ps2', fetchedAt: Date.now(), total: 3,
  items: [
    item(11, ['AAAAAAAA'], { links: ['https://a.cn/1', 'https://a.cn/2'], comment: '发布说明甲' }),
    item(12, ['BBBBBBBB'], { links: [], comment: '' }),                       // 什么都没有
    item(13, ['CCCCCCCC'], { links: ['https://c.cn/'], im1CRC: 'F1F1F1F1' }), // 只有链接
  ],
};

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  await fsp.mkdir(TMP, { recursive: true });

  console.log('\n[1] 认机种 / 认来源');
  ok('datVersionURL 里的 ?ver=ps2', emugif.consoleTypeOf(datPs2) === 'ps2', emugif.consoleTypeOf(datPs2));
  ok('没有 ver= 时从 imURL 兜底', emugif.consoleTypeOf(datGb) === 'gb', emugif.consoleTypeOf(datGb));
  ok('没有 newDat 时返回 null', emugif.consoleTypeOf({}) === null);
  ok('emugif 的 DAT 认得出来', emugif.isEmugif(datPs2) === true);
  ok('非 emugif 的 DAT 不认', emugif.isEmugif(datOther) === false);

  console.log('\n[2] 建索引与匹配');
  const index = emugif.buildIndex(payload);
  ok('CRC 命中（小写也认）', !!emugif.lookup(index, { crcs: [{ crc: 'aaaaaaaa' }] }));
  ok('CRC 未收录时返回 null', emugif.lookup(index, { crcs: [{ crc: '99999999' }] }) === null);
  ok('CRC 都落空时回退封面 CRC', !!emugif.lookup(index, { crcs: [{ crc: '99999999' }], im1CRC: 'f1f1f1f1' }));
  const hit = emugif.lookup(index, { crcs: [{ crc: 'AAAAAAAA' }] });
  ok('命中的是对应那条', hit && hit.id === 11, hit && hit.id);

  console.log('\n[3] 输出成前端要的形状');
  const p1 = emugif.present(hit, 'ps2');
  ok('有链接也有说明', p1 && p1.links.length === 2 && p1.comment === '发布说明甲');
  ok('带站点详情页地址', !!p1 && /game-edit\.html\?id=11.*consoleType=ps2/.test(p1.url), p1 && p1.url);
  const p2 = emugif.present(emugif.lookup(index, { crcs: [{ crc: 'BBBBBBBB' }] }), 'ps2');
  ok('两个都没有就返回 null', p2 === null);
  const p3 = emugif.present(emugif.lookup(index, { crcs: [{ crc: 'CCCCCCCC' }] }), 'ps2');
  ok('只有链接也算有内容', !!p3 && p3.links.length === 1 && p3.comment === '');

  console.log('\n[4] 整表出站点信息');
  const games = [
    { index: 1, crcs: [{ crc: 'AAAAAAAA' }], children: [] },
    { index: 2, crcs: [{ crc: 'BBBBBBBB' }] },
    // 合并条目：父条目自己没对上，被吃掉的子条目 4 有
    { index: 3, crcs: [], children: [{ index: 4, crcs: [{ crc: 'CCCCCCCC' }] }] },
    { index: 5, crcs: [{ crc: '99999999' }] },
  ];
  const r = emugif.collect(games, index, 'ps2');
  // 条目 2 虽然 CRC 对上了，但站点上那条既无链接也无说明 —— 不算「匹配到」
  ok('匹配 2 条（含子条目，无内容的不算）', r.matched === 2, r.matched);
  ok('有链接 2 条', r.withLink === 2, r.withLink);
  ok('有说明 1 条', r.withComment === 1, r.withComment);
  ok('父条目 1 有数据', !!r.sites[1]);
  ok('站点上没内容的条目 2 不出数据', !r.sites[2]);
  ok('子条目 4 单独出数据', !!r.sites[4] && r.sites[4].links.length === 1);
  ok('没收录的条目 5 不出数据', !r.sites[5]);
  ok('没有动到原对象', games[0].site === undefined && games[2].children[0].site === undefined);
  ok('没索引时返回空表', Object.keys(emugif.collect(games, null, 'ps2').sites).length === 0);

  console.log('\n[5] 缓存读写');
  ok('没有缓存时返回 null', (await emugif.readCache('ps2')) === null);
  await fsp.mkdir(emugif.cacheDir(), { recursive: true });
  await fsp.writeFile(
    path.join(emugif.cacheDir(), 'ps2.json'),
    JSON.stringify({ consoleType: 'ps2', fetchedAt: Date.now(), total: 3, items: payload.items })
  );
  const c = await emugif.readCache('ps2');
  ok('写进去能读出来', !!c && c.total === 3);
  ok('机种名做了转义', (await emugif.readCache('../../evil')) === null);

  if (process.env.ROMKIT_NET === '1') {
    console.log('\n[6] 联网端到端（真站 ps2）');
    try {
      const p = await emugif.fetchConsole('ps2', true);
      ok('拉到数据', p.items.length > 0, p.total + ' 条');
      const i2 = emugif.buildIndex(p);
      let withLink = 0, withComment = 0;
      for (const it of p.items) {
        if ((it.links || []).length) withLink++;
        if (String(it.comment || '').trim()) withComment++;
      }
      ok('确实有发布链接', withLink > 0, withLink + ' 条');
      ok('确实有发布说明', withComment > 0, withComment + ' 条');
      const any = p.items.find((x) => (x.links || []).length);
      const pr = emugif.present(any, 'ps2');
      ok('能出成前端要的形状', !!pr && pr.links.length > 0);
      ok('再读一次走缓存', !!(await emugif.readCache('ps2')));
    } catch (e) {
      ok('联网拉取', false, e.message);
    }
  } else {
    console.log('\n[6] 联网端到端（跳过，ROMKIT_NET=1 开启）');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
