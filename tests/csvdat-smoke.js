/* CSV 建库冒烟测试（离线）
 *
 * 覆盖：CSV 解析（引号/CRLF/BOM/中文表头别名）、条目生成与报错、
 *       DAT XML 生成 → parseDatXml 往返、模板往返、
 *       文件夹直读、覆盖层自建条目（standalone）合成。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const csvdat = require('../lib/csvdat');
const { parseDatXml } = require('../lib/dat');
const overrides = require('../lib/overrides');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

(async () => {
  console.log('— parseCsv 基础 —');
  let rows = csvdat.parseCsv('a,b,c\n1,2,3');
  ok('基本两行三列', rows.length === 2 && rows[0][2] === 'c' && rows[1][2] === '3');
  rows = csvdat.parseCsv('"带,逗号","带""引号""","多\n行"');
  ok('引号字段：逗号/转义引号/换行', rows[0][0] === '带,逗号' && rows[0][1] === '带"引号"' && rows[0][2] === '多\n行');
  rows = csvdat.parseCsv('\ufeffx,y\r\n1,2\r\n');
  ok('BOM + CRLF + 结尾换行', rows.length === 2 && rows[0][0] === 'x' && rows[1][1] === '2');
  rows = csvdat.parseCsv('a,b\n\n,\n1,2');
  ok('空行被跳过', rows.length === 2);

  console.log('— csvToEntries —');
  const csv1 = [
    '名称,文件名,大小(字节),CRC32,英文名,厂商,地区,语言',
    '超级马力欧世界,"Super Mario World (J).smc",524288,abcdef01,Super Mario World,Nintendo,日本,日语',
    '没有名字的,,,0,,',
    '坏大小,odd.bin,12MB,,',
    '缺文件名,',
    ',',
  ].join('\n');
  let r = csvdat.csvToEntries(csv1);
  ok('解析出 2 条', r.entries.length === 2, JSON.stringify(r.entries.length));
  ok('中文名/文件名/大小/CRC 全对上',
    r.entries[0].title === '超级马力欧世界' &&
    r.entries[0].sourceRom === 'Super Mario World (J).smc' &&
    r.entries[0].romSize === 524288 &&
    r.entries[0].crc === 'ABCDEF01');
  ok('名称缺省用文件名去后缀', !r.entries.some((e) => !e.title) && csvdat.csvToEntries('文件名\nonlyname.iso').entries[0].title === 'onlyname');
  ok('坏大小进 warnings 且按 0 处理', r.warnings.some((w) => w.includes('12MB')) && r.entries[1].romSize === 0);
  ok('缺文件名进 errors', r.errors.some((e) => e.includes('缺少文件名')));
  ok('整行空不算错（只解析 2 条）', r.entries.length === 2);

  const csv2 = 'name,rom,bytes\n赛尔达,zelda.sfc,1048576\n';
  r = csvdat.csvToEntries(csv2);
  ok('英文表头别名 name/rom/bytes 也能识别', r.entries.length === 1 && r.entries[0].title === '赛尔达' && r.entries[0].sourceRom === 'zelda.sfc' && r.entries[0].romSize === 1048576);

  r = csvdat.csvToEntries('title,comment\n只有名字,x');
  ok('完全没有文件名列 → 报错并给提示', r.entries.length === 0 && r.errors[0].includes('文件名'));

  console.log('— buildDatXml → parseDatXml 往返 —');
  const entries = [
    { title: '游戏A', sourceRom: 'gameA.zip', romSize: 123, crc: 'DEADBEEF', comment: 'Game A', publisher: 'P', location: '日本', language: '日语', saveType: '', releaseNumber: 0 },
    { title: '游戏B', sourceRom: 'gameB.chd', romSize: 456789, crc: '', comment: '', publisher: '', location: '', language: '', saveType: '', releaseNumber: 0 },
    { title: '带"&<>" 的名字', sourceRom: 'odd"1.bin', romSize: 1, crc: '', comment: '', publisher: '', location: '', language: '', saveType: '', releaseNumber: 0 },
  ];
  const xml = csvdat.buildDatXml({ datName: '我的清单', system: '测试机', entries });
  let dat;
  try {
    dat = parseDatXml(xml);
    ok('生成的 XML 能被 parseDatXml 解析', true);
  } catch (e) {
    ok('生成的 XML 能被 parseDatXml 解析', false, e.message);
    dat = { games: [], extensions: [] };
  }
  ok('条目数一致', dat.games.length === 3);
  ok('datName/system 正确', dat.datName === '我的清单' && dat.system === '测试机');
  ok('CRC 条目：crc/extension/romSize', dat.games[0].crcs.length === 1 && dat.games[0].crcs[0].crc === 'DEADBEEF' && dat.games[0].crcs[0].extension === 'zip' && dat.games[0].romSize === 123);
  ok('无 CRC 条目：crc 为空但保留 name/size（逐文件匹配用）', dat.games[1].crcs.length === 1 && dat.games[1].crcs[0].crc === '' && dat.games[1].crcs[0].name === 'gameB.chd' && dat.games[1].crcs[0].size === 456789);
  ok('特殊字符被转义', dat.games[2].title.includes('"') && dat.games[2].title.includes('&'));
  ok('canOpen 收集了全部后缀', dat.extensions.includes('.zip') && dat.extensions.includes('.chd') && dat.extensions.includes('.bin'));
  ok('标题归一化字段就绪（titleKey）', typeof dat.games[0].titleKey === 'string');

  console.log('— 模板往返 —');
  const t = csvdat.templateCsv();
  r = csvdat.csvToEntries(t);
  ok('模板能被自己解析', r.entries.length >= 3 && r.entries[0].sourceRom === 'Super Mario World (J).smc');
  ok('模板里大小都是纯数字字节', r.entries.every((e) => e.romSize > 0));

  console.log('— entriesFromFolder —');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'romkit-csv-'));
  fs.writeFileSync(path.join(TMP, 'a.zip'), '0123456789');
  fs.writeFileSync(path.join(TMP, 'b.txt'), '12345');
  fs.mkdirSync(path.join(TMP, 'sub'));
  fs.writeFileSync(path.join(TMP, 'sub', 'c.nes'), '123');
  fs.writeFileSync(path.join(TMP, '.hidden'), 'x');
  let got = await csvdat.entriesFromFolder(TMP, { recursive: false });
  ok('非递归：只收顶层 2 个文件（隐藏文件跳过）', got.entries.length === 2, JSON.stringify(got.entries.map((e) => e.sourceRom)));
  ok('title 去后缀、size 对', got.entries[0].title === 'a' && got.entries[0].romSize === 10);
  got = await csvdat.entriesFromFolder(TMP, { recursive: true });
  ok('递归：子文件夹也进来（3 个）', got.entries.length === 3, JSON.stringify(got.entries.map((e) => e.sourceRom)));
  const folderDat = parseDatXml(csvdat.buildDatXml({ datName: '夹子', system: '', entries: got.entries }));
  ok('文件夹条目生成 DAT 往返 OK', folderDat.games.length === 3);
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('— 覆盖层自建条目（standalone） —');
  const baseDat = { games: [{ index: 1, title: '原条目', romSize: 1, crcs: [], comment: '', publisher: '', sourceRom: '', location: '', language: '', saveType: '', tags: [], ext: '' }] };
  const book = {
    version: 1,
    entries: [
      {
        id: 'ov_manual1',
        name: '手动加的游戏',
        files: [{ ext: '.smc', size: 524288, crc: '', label: '' }],
        children: [],
        fields: { comment: 'Manual Game', publisher: 'Nintendo', location: '日本' },
        matchMode: 'name-size',
        sourceIndexes: [],
        snapshot: [],
        baseIndex: 900001,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  const ap = overrides.apply(baseDat, book);
  ok('自建条目无冲突', ap.conflicts.length === 0, JSON.stringify(ap.conflicts));
  ok('合成条目排在最后且用 baseIndex', ap.dat.games.length === 2 && ap.dat.games[1].index === 900001);
  const g = ap.dat.games[1];
  ok('标题/匹配方式/覆盖标记', g.title === '手动加的游戏' && g.matchMode === 'name-size' && g.overridden === true);
  ok('文件表带各自大小（name-size 匹配的关键）', g.crcs.length === 1 && g.crcs[0].size === 524288 && g.crcs[0].extension === '.smc');
  ok('信息字段进到子条目', g.children.length === 1 && g.children[0].comment === 'Manual Game' && g.children[0].publisher === 'Nintendo' && g.children[0].romSize === 524288);
  ok('多文件 = multiFile', overrides.apply(baseDat, { version: 1, entries: [{ ...book.entries[0], files: [{ ext: '.bin', size: 1, crc: '', label: '' }, { ext: '.cue', size: 2, crc: '', label: '' }] }] }).dat.games[1].multiFile === true);
  ok('原条目不受影响', ap.dat.games[0].title === '原条目' && !ap.dat.games[0].overridden);

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
