/* 平台简称映射冒烟测试：从 web/app.js 里抽出 PLATFORM_SHORT + platformOf 验证 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const table = src.match(/const PLATFORM_SHORT = \[[\s\S]*?\n\];/);
const fn = src.match(/function platformOf\(lib\) \{[\s\S]*?\n\}/);
if (!table || !fn) {
  console.error('✗ 没能在 web/app.js 中找到 PLATFORM_SHORT / platformOf');
  process.exit(1);
}
eval(table[0].replace('const PLATFORM_SHORT', 'var PLATFORM_SHORT'));
eval(fn[0]);

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name} → ${got}${ok ? '' : `（期望 ${want}）`}`);
}

console.log('\n平台简称映射');

t('NES 全称', platformOf({ system: 'Nintendo - Nintendo Entertainment System', name: '中文 - NES' }).short, 'NES');
t('SNES 全称', platformOf({ system: 'Nintendo - Super Nintendo Entertainment System', name: '' }).short, 'SNES');
t('Game Boy', platformOf({ system: 'Nintendo - Nintendo Game Boy', name: '' }).short, 'GB');
t('Game Boy Advance', platformOf({ system: 'Nintendo - Nintendo Game Boy Advance', name: '' }).short, 'GBA');
t('N64', platformOf({ system: 'Nintendo - Nintendo 64', name: '' }).short, 'N64');
t('Mega Drive', platformOf({ system: 'Sega - Mega Drive - Genesis', name: '' }).short, 'Mega Drive');
t('PSP', platformOf({ system: 'Sony - PlayStation Portable', name: '' }).short, 'PSP');
t('Xbox 360', platformOf({ system: 'Microsoft - Xbox 360', name: '' }).short, 'Xbox 360');
t('带括号后缀', platformOf({ system: 'Nintendo - Nintendo Entertainment System (NES)', name: '' }).short, 'NES');
t('system 为空时回退清单名', platformOf({ system: '', name: '中文 - SNES' }).short, 'SNES');
t('清单名里的缩写 NES', platformOf({ system: '', name: '中文 - NES' }).short, 'NES');
t('认不出时取破折号后一段', platformOf({ system: 'Foo - Some Unknown Console', name: '' }).short, 'Some Unknown Console');
t('全都没有时兜底', platformOf({ system: '', name: '' }).short, '未知平台');
t('保留全称供title 展示', platformOf({ system: 'Nintendo - Nintendo Entertainment System', name: '' }).raw, 'Nintendo - Nintendo Entertainment System');

console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
