'use strict';
/* gamesToCsv / CSV 导出-导入相关冒烟测试 */
const csvdat = require('../lib/csvdat');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

// 构造两个游戏：一个单文件、一个多文件（文件夹）
const games = [
  {
    index: 1, title: '超级马力欧', comment: 'Super Mario', sourceRom: 'smb.smc',
    romSize: 524288, publisher: 'Nintendo', location: '日本', language: '日语',
    crcs: [{ crc: 'DEADBEEF', extension: 'smc', size: 524288, name: '' }],
  },
  {
    index: 2, title: 'PCSG00125', comment: '', sourceRom: '',
    romSize: 1700000000, publisher: '', location: '', language: '',
    crcs: [
      { crc: '', extension: 'bin', size: 10, name: 'app/eboot.bin' },
      { crc: '', extension: 'dat', size: 28, name: 'app/costume.dat' },
    ],
  },
];

const csv = csvdat.gamesToCsv(games);
const lines = csv.split('\r\n');
ok('首行是表头且含关键列', lines[0] === '编号,名称,英文名,文件名,大小(字节),CRC32,发行厂商,地区,语言,文件数', lines[0]);
ok('共 3 行（表头 + 2 游戏）', lines.length === 3, String(lines.length));

// 单文件行
const single = lines[1].split(',');
ok('单文件：文件名保留', single[3] === 'smb.smc');
ok('单文件：CRC 保留', single[5] === 'DEADBEEF');
ok('单文件：文件数=1', single[9] === '1');
ok('单文件：厂商保留', single[6] === 'Nintendo');

// 多文件（文件夹）行：文件名与 CRC 留空，文件数=2
const multi = lines[2].split(',');
ok('多文件：文件名留空', multi[3] === '');
ok('多文件：CRC 留空', multi[5] === '');
ok('多文件：文件数=2', multi[9] === '2');

// 含逗号/引号的字段应被转义，且能被 parseCsv 原样读回
const games2 = [{ index: 3, title: '游戏, 含逗号', comment: 'a"b', sourceRom: '', romSize: 0, publisher: '', location: '', language: '', crcs: [] }];
const parsed2 = csvdat.parseCsv(csvdat.gamesToCsv(games2))[1];
ok('含逗号标题被引号包裹且回读一致', parsed2[1] === '游戏, 含逗号', parsed2[1]);
ok('含引号被翻倍转义且回读一致', parsed2[2] === 'a"b', parsed2[2]);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
