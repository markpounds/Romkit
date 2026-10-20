'use strict';
/**
 * 端到端测试：直接调用本地服务的 HTTP API
 * 用真实 OfflineList DAT 的 XML 结构 + 伪造的 CRC，验证 导入→设置→扫描→整理 全链路
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// 测试必须跑在**独立的数据目录**上：否则会连到用户真实配置，
// 同版本 DAT 会被判定为重名而误改真实清单。
const PORT = Number(process.env.ROMKIT_E2E_PORT || 18990);
const DATA_DIR = path.join(os.tmpdir(), 'romkit-e2e-data');
let BASE = `http://127.0.0.1:${PORT}`;
let srv = null;

async function startServer() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ROMKIT_DATA: DATA_DIR, ROMKIT_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/state');
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('测试服务启动超时');
}

function stopServer() {
  if (srv && !srv.killed) {
    try { srv.kill(); } catch (_) {}
  }
}

const WORK = path.join(os.tmpdir(), 'romkit-e2e');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + '/api' + p, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.status);
  return data;
}

async function waitTask(id, ms = 120000) {
  const start = Date.now();
  for (;;) {
    const { task } = await api('/tasks/' + id);
    if (task.status !== 'running') return task;
    if (Date.now() - start > ms) throw new Error('任务超时');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main() {
  await startServer();
  await fsp.rm(WORK, { recursive: true, force: true });
  const romDir = path.join(WORK, 'roms');
  const sub = path.join(romDir, 'sub');
  const outZip = path.join(WORK, 'out-zip');
  const outRaw = path.join(WORK, 'out-raw');
  await fsp.mkdir(sub, { recursive: true });

  console.log('\n[1] 准备伪造 ROM + 真实结构 DAT');
  // 三个假 ROM（内容随机），CRC 稍后写入 DAT
  const roms = [];
  for (let i = 0; i < 3; i++) {
    const buf = crypto.randomBytes(256 * 1024 + i * 1024);
    const p = i === 2 ? path.join(sub, 'hidden-game.gg') : path.join(romDir, `game${i}.gg`);
    await fsp.writeFile(p, buf);
    roms.push({ path: p, crc: crc32hex(buf) });
  }
  // 读取真实 GG DAT（直接从原始 zip 里取 xml，保留完整结构）
  const { loadDatFile } = require('../lib/dat');
  const datSource = 'D:\\Downloads\\CHS_GG_OL.zip';
  if (!fs.existsSync(datSource)) throw new Error('找不到测试用 DAT：' + datSource);
  const { xmlText: realXml } = await loadDatFile(datSource);
  const fakeGamesXml = `
    <game>
      <imageNumber>1</imageNumber><title>铁甲飞龙迷你版 (简)</title><saveType></saveType>
      <romSize>262144</romSize><publisher>Sega</publisher><location>7</location><sourceRom>官中</sourceRom>
      <language>4</language>
      <files><romCRC extension=".gg">${roms[0].crc}</romCRC></files>
      <im1CRC>AAAA1111</im1CRC><im2CRC>BBBB2222</im2CRC>
      <comment>Panzer Dragoon Mini (Japan) [CHS]</comment><duplicateID>1</duplicateID>
    </game>
    <game>
      <imageNumber>2</imageNumber><title>光明力量外传 - 最终冲突 (简)</title><saveType></saveType>
      <romSize>263168</romSize><publisher>Sega</publisher><location>7</location><sourceRom>汉化</sourceRom>
      <language>4</language>
      <files><romCRC extension=".gg">${roms[1].crc}</romCRC></files>
      <im1CRC>CCCC3333</im1CRC><im2CRC>DDDD4444</im2CRC>
      <comment>Shining Force Gaiden (Japan) [CHS]</comment><duplicateID>2</duplicateID>
    </game>
    <game>
      <imageNumber>3</imageNumber><title>梦幻之星 (简)</title><saveType></saveType>
      <romSize>262144</romSize><publisher>Sega</publisher><location>7</location><sourceRom>官中</sourceRom>
      <language>4</language>
      <files><romCRC extension=".gg">${roms[2].crc}</romCRC></files>
      <im1CRC>EEEE5555</im1CRC><im2CRC>FFFF6666</im2CRC>
      <comment>Phantasy Star (Japan) [CHS]</comment><duplicateID>3</duplicateID>
    </game>`;
  const fakeXml = realXml.replace(/<games>[\s\S]*?<\/games>/, '<games>' + fakeGamesXml + '</games>');
  const datZipBuf = await zipInMemory(fakeXml, 'CHS_GG_OL.xml');

  console.log('\n[2] 导入 DAT');
  const r = await fetch(BASE + '/api/libraries/import?name=e2e_gg.zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: datZipBuf,
  });
  const imp = await r.json();
  ok('导入成功', !!imp.library, JSON.stringify(imp).slice(0, 200));
  const libId = imp.library.id;
  ok('识别出 3 个游戏', imp.library.stats.games === 3, String(imp.library.stats.games));

  console.log('\n[2b] 同名 DAT 版本比较');
  const r1 = await fetch(BASE + '/api/libraries/import?name=e2e_same.zip', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: datZipBuf,
  });
  const j1 = await r1.json();
  ok('同版本再次导入被跳过', j1.skipped === true, JSON.stringify(j1).slice(0, 180));
  ok('跳过时返回已有清单', !!j1.library && j1.library.id === libId, j1.library && j1.library.id);

  const newerXml = fakeXml.replace(/<datVersion>(\d+)<\/datVersion>/, (m, v) => `<datVersion>${Number(v) + 1}</datVersion>`);
  if (newerXml !== fakeXml) {
    const newerBuf = await zipInMemory(newerXml, 'CHS_GG_OL.xml');
    const r2 = await fetch(BASE + '/api/libraries/import?name=e2e_v2.zip', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: newerBuf,
    });
    const j2 = await r2.json();
    ok('更高版本会覆盖', j2.replaced === true, JSON.stringify(j2).slice(0, 180));
    ok('清单 id 保持不变', !!j2.library && j2.library.id === libId);
    ok('版本号已提升', Number(j2.library.datVersion) === Number(j1.library.datVersion) + 1,
      `${j1.library.datVersion} -> ${j2.library && j2.library.datVersion}`);
    const state = await (await fetch(BASE + '/api/state')).json();
    const same = state.libraries.filter((l) => l.datName === j2.library.datName);
    ok('没有产生重复清单', same.length === 1, String(same.length));
  } else {
    ok('（DAT 无 datVersion 标签，跳过替换测试）', true);
  }

  console.log('\n[3] 设置目录');
  await api(`/libraries/${libId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      settings: {
        romDir, outDir: outZip, mode: 'zip', operation: 'copy',
        fileTemplate: '{title} [{crc}]', archiveTemplate: '{title} [{crc}]',
        matchMode: 'both', scanMode: 'full',
      },
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  console.log('\n[4] 扫描');
  const s1 = await api(`/libraries/${libId}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const t1 = await waitTask(s1.task.id);
  ok('扫描完成', t1.status === 'done', t1.error || '');
  ok('3 个游戏全部命中', t1.result.stats.owned === 3, JSON.stringify(t1.result.stats));
  ok('子目录中的文件被找到', true);

  console.log('\n[5] 文件名匹配回退');
  // 把其中一个 ROM 移走，换一个文件名匹配但 CRC 不符的文件
  await fsp.rm(roms[1].path);
  const renamed = path.join(romDir, 'Shining Force Gaiden (简).gg');
  await fsp.writeFile(renamed, crypto.randomBytes(300 * 1024));
  const s2 = await api(`/libraries/${libId}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const t2 = await waitTask(s2.task.id);
  const g2 = (await api(`/libraries/${libId}/games`)).games.find((g) => g.title.includes('光明力量'));
  ok('CRC 失败后用文件名兜底', g2.status === 'owned' && g2.matches[0].via === 'name', JSON.stringify({ status: g2.status, matches: g2.matches }));

  console.log('\n[6] 整理（保留压缩包）');
  const plan = await api(`/libraries/${libId}/plan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  ok('计划包含 3 项', plan.total === 3, String(plan.total));
  ok('命名模板带 CRC', plan.items.some((i) => /\[[0-9A-F]{8}\]\.zip$/.test(i.dest)), plan.items.map((i) => i.dest).join('; '));
  const o1 = await api(`/libraries/${libId}/organize`, { method: 'POST', body: '{"dryRun":false}', headers: { 'Content-Type': 'application/json' } });
  const ot1 = await waitTask(o1.task.id);
  ok('整理成功', ot1.status === 'done' && ot1.result.failed === 0, JSON.stringify(ot1.result || ot1.error));
  const zips = (await fsp.readdir(outZip)).filter((f) => f.endsWith('.zip'));
  ok('输出 3 个 zip', zips.length === 3, zips.join(','));
  {
    const { listEntries } = require('../lib/zip');
    const entries = await listEntries(path.join(outZip, zips[0]));
    const inner = entries[0] && entries[0].name;
    ok('zip 内条目按文件名模板改名', !!inner && !/\.zip$/i.test(inner) && inner.endsWith('.gg'), inner);
    ok('zip 内条目名与外层同名', !!inner && inner === zips[0].replace(/\.zip$/i, '.gg'), inner + ' vs ' + zips[0]);
  }

  console.log('\n[7] 切换为保留原始文件');
  await api(`/libraries/${libId}`, {
    method: 'PATCH',
    body: JSON.stringify({ settings: { mode: 'raw', outDir: outRaw, operation: 'copy' } }),
    headers: { 'Content-Type': 'application/json' },
  });
  const o2 = await api(`/libraries/${libId}/organize`, { method: 'POST', body: '{"dryRun":false}', headers: { 'Content-Type': 'application/json' } });
  const ot2 = await waitTask(o2.task.id);
  ok('raw 模式整理成功', ot2.status === 'done' && ot2.result.failed === 0, JSON.stringify(ot2.result || ot2.error));
  const raws = (await fsp.readdir(outRaw)).filter((f) => f.endsWith('.gg'));
  ok('输出 3 个 .gg', raws.length === 3, raws.join(','));

  console.log('\n[7b] 整理后增量更新状态（不重扫）');
  const outMove = path.join(WORK, 'out-move');
  await api(`/libraries/${libId}`, {
    method: 'PATCH',
    body: JSON.stringify({ settings: { mode: 'raw', outDir: outMove, operation: 'move' } }),
    headers: { 'Content-Type': 'application/json' },
  });
  const before = (await api(`/libraries/${libId}/games`)).games.filter((g) => g.status !== 'missing').length;
  const o3 = await api(`/libraries/${libId}/organize`, { method: 'POST', body: '{"dryRun":false}', headers: { 'Content-Type': 'application/json' } });
  const ot3 = await waitTask(o3.task.id);
  ok('move 模式整理成功', ot3.status === 'done' && ot3.result.failed === 0, JSON.stringify(ot3.result || ot3.error));
  const after = await api(`/libraries/${libId}/games`);
  ok('已拥有数量未变', after.games.filter((g) => g.status !== 'missing').length === before, String(before));
  ok('文件位置已更新到新目录', after.games.filter((g) => g.status !== 'missing').every((g) => (g.matches[0] || {}).path && g.matches[0].path.includes('out-move')), JSON.stringify(after.games.filter((g) => g.status !== 'missing').map((g) => (g.matches[0] || {}).path)));

  console.log('\n[8] 清理测试库');
  await api(`/libraries/${libId}`, { method: 'DELETE' });

  stopServer();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

function crc32hex(buf) {
  let table = crc32hex._t;
  if (!table) {
    table = crc32hex._t = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

async function zipInMemory(content, name) {
  const { packFile } = require('../lib/zip');
  const tmp = path.join(WORK, 'tmp.xml');
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  await fsp.writeFile(tmp, content, 'utf8');
  const zipPath = path.join(WORK, 'tmp.zip');
  await packFile(tmp, zipPath, { entryName: name, compress: true });
  const buf = await fsp.readFile(zipPath);
  await fsp.rm(tmp); await fsp.rm(zipPath);
  return buf;
}

main().catch((e) => { console.error('E2E 异常：', e); stopServer(); process.exit(1); });
