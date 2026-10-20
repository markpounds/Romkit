/* 自动归类筛选冒烟测试
 * 需求：自动归类只比对「还没集齐」的清单，已集齐的清单应被跳过，
 *       且属于已集齐清单的文件不应被搬走（提高效率且行为可预期）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const { crc32, toHex } = require('../lib/crc32');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'romkit-classify-' + Date.now());
const PORT = 28900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

let srv = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, ROMKIT_DATA: path.join(WORK, 'data'), ROMKIT_PORT: String(PORT) },
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (/http:\/\/127\.0\.0\.1/.test(out)) resolve(p); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('服务端退出 code=' + c + '\n' + out)));
    setTimeout(() => reject(new Error('启动超时\n' + out)), 15000);
  });
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.status);
  return data;
}

async function waitTask(id, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    const { task } = await api('/tasks/' + id);
    if (task.status !== 'running') return task;
    if (Date.now() - t0 > ms) throw new Error('任务超时');
    await new Promise((r) => setTimeout(r, 150));
  }
}

function datXml(title, crc, ext) {
  return `<?xml version="1.0"?><dat><configuration><datName>${title}</datName><datVersion>1</datVersion><system>Sega - Game Gear</system><imFolder>x</imFolder><romTitle>%n</romTitle></configuration><games><game><imageNumber>1</imageNumber><title>${title}-游戏</title><romSize>128</romSize><files><romCRC extension="${ext}">${crc}</romCRC></files><comment>${title} Game</comment><duplicateID>1</duplicateID></game></games></dat>`;
}

async function importDat(name, xml) {
  const r = await fetch(BASE + `/libraries/import?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(xml, 'utf8'),
  });
  const d = await r.json();
  if (!d.library) throw new Error('导入失败：' + JSON.stringify(d).slice(0, 200));
  return d.library.id;
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  const inbox = path.join(WORK, 'inbox');
  const romFull = path.join(WORK, 'rom-full');   // 已集齐清单的 ROM 目录
  const outFull = path.join(WORK, 'out-full');
  const romPart = path.join(WORK, 'rom-part');   // 未集齐清单的 ROM 目录
  const outPart = path.join(WORK, 'out-part');
  for (const d of [inbox, romFull, outFull, romPart, outPart]) fs.mkdirSync(d, { recursive: true });

  // 「已集齐」清单：它的游戏文件已经在 ROM 目录里
  const bufFull = Buffer.from('full-owned-game-content');
  const crcFull = toHex(crc32(bufFull));
  await fsp.writeFile(path.join(romFull, 'complete-game.gg'), bufFull);

  // 「未集齐」清单：ROM 目录里没有它的文件
  const bufPart = Buffer.from('partially-owned-game-content');
  const crcPart = toHex(crc32(bufPart));

  srv = await startServer();

  // 保险：确认跑在隔离的数据目录里
  {
    const st = await api('/state');
    if (!path.resolve(String(st.dataDir || '')).startsWith(path.resolve(WORK))) {
      throw new Error('数据目录未隔离，中止：' + st.dataDir);
    }
  }

  const idFull = await importDat('classify-full.xml', datXml('已集齐清单', crcFull, '.gg'));
  const idPart = await importDat('classify-part.xml', datXml('未集齐清单', crcPart, '.gg'));
  ok('两个清单导入成功', !!idFull && !!idPart);

  for (const [id, romDir, outDir] of [[idFull, romFull, outFull], [idPart, romPart, outPart]]) {
    await api(`/libraries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ settings: { romDir, outDir, mode: 'raw', matchMode: 'both' } }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 先扫一遍，让「已集齐」清单产生 owned=1 的扫描快照
  for (const id of [idFull, idPart]) {
    const s = await api(`/libraries/${id}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    await waitTask(s.task.id);
  }
  const fullScan = await api(`/libraries/${idFull}/games`);
  ok('已集齐清单确实是 owned=1/1', fullScan.stats.owned === 1 && fullScan.stats.games === 1, JSON.stringify(fullScan.stats));

  // 待分类文件夹里放两个文件：一个属于已集齐清单，一个属于未集齐清单
  await fsp.writeFile(path.join(inbox, 'complete-game.gg'), bufFull);
  await fsp.writeFile(path.join(inbox, 'partial-game.gg'), bufPart);

  await api('/config/ui', {
    method: 'POST',
    body: JSON.stringify({ inboxDir: inbox }),
    headers: { 'Content-Type': 'application/json' },
  });

  console.log('\n[1] 自动归类只比对未集齐的清单');
  const c = await api('/classify', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const ct = await waitTask(c.task.id);
  ok('归类任务完成', ct.status === 'done', JSON.stringify(ct.error || '').slice(0, 200));
  const r = ct.result || {};
  ok('跳过 1 个已集齐的清单', r.skippedComplete === 1, String(r.skippedComplete));
  ok('实际只检查 1 个清单', r.checked === 1, String(r.checked));

  console.log('\n[2] 文件去向符合预期');
  const inboxLeft = (await fsp.readdir(inbox)).sort();
  ok('属于已集齐清单的文件留在原地', inboxLeft.includes('complete-game.gg'), inboxLeft.join(','));
  ok('属于未集齐清单的文件已被搬走', !inboxLeft.includes('partial-game.gg'), inboxLeft.join(','));
  const outPartFiles = (await fsp.readdir(outPart)).filter((f) => f.endsWith('.gg'));
  ok('未集齐清单的输出目录拿到了文件', outPartFiles.length === 1, outPartFiles.join(','));
  const outFullFiles = (await fsp.readdir(outFull)).filter((f) => f.endsWith('.gg'));
  ok('已集齐清单的输出目录没有被写入', outFullFiles.length === 0, outFullFiles.join(','));

  console.log('\n[3] 全部集齐时应该一个都不比对');
  // 把未集齐清单也变成已集齐：把它要的文件放进它自己的 ROM 目录并重扫
  await fsp.writeFile(path.join(romPart, 'partial-game.gg'), bufPart);
  {
    const s = await api(`/libraries/${idPart}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    await waitTask(s.task.id);
  }
  // 重扫后 partial-game.gg 已在 outPart，再扫一次也不会改变 owned
  const partScan = await api(`/libraries/${idPart}/games`);
  ok('未集齐清单此时也已集齐', partScan.stats.owned === partScan.stats.games, JSON.stringify(partScan.stats));

  const c2 = await api('/classify', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const ct2 = await waitTask(c2.task.id);
  const r2 = ct2.result || {};
  ok('两个清单都被跳过', r2.skippedComplete === 2, String(r2.skippedComplete));
  ok('实际检查 0 个清单', r2.checked === 0, String(r2.checked));
  ok('没有文件被移动', (r2.moved || 0) === 0, String(r2.moved));

  console.log('\n[4] 清理');
  srv.kill();
  fs.rmSync(WORK, { recursive: true, force: true });

  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e.message);
  if (srv) { try { srv.kill(); } catch (_) {} }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
