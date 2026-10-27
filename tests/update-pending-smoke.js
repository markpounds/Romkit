/* 更新 DAT 与待整理隔离 冒烟测试
 *
 * 覆盖用户反馈的两点：
 *   ① 更新 DAT 时若内容没变，不能重置扫描进度（拥有数/待整理都应保留）
 *   ② 待整理是「每个清单各自一份」的统计，切清单不能串味
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const { crc32, toHex } = require('../lib/crc32');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'romkit-upd-' + Date.now());
const PORT = 29100 + Math.floor(Math.random() * 60);
const DAT_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

let srv = null;
let datSrv = null;
let servedDat = '';

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

function startDatServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(servedDat);
    });
    s.listen(DAT_PORT, '127.0.0.1', () => resolve(s));
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

async function waitTask(id, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const { task } = await api('/tasks/' + id);
    if (task.status !== 'running') return task;
    if (Date.now() - t0 > ms) throw new Error('任务超时');
    await new Promise((r) => setTimeout(r, 120));
  }
}

function datXml(games, version, name) {
  return `<?xml version="1.0"?>
<dat>
  <configuration>
    <datName>${name || '更新测试'}</datName><datVersion>${version}</datVersion>
    <system>Sega - Game Gear</system><imFolder>x</imFolder><romTitle>%n</romTitle>
    <newDat>
      <datVersionURL>http://127.0.0.1:${DAT_PORT}/ver.txt</datVersionURL>
      <datURL fileName="t.zip">http://127.0.0.1:${DAT_PORT}/dat.xml</datURL>
    </newDat>
  </configuration>
  <games>
${games.map((g, i) => `    <game>
      <imageNumber>${i + 1}</imageNumber><title>${g.title}</title><romSize>128</romSize>
      <files><romCRC extension=".gg">${g.crc}</romCRC></files>
      <comment>${g.title} (Japan)</comment><duplicateID>${i + 1}</duplicateID>
    </game>`).join('\n')}
  </games>
</dat>`;
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
  const romA = path.join(WORK, 'romA');
  const outA = path.join(WORK, 'outA');
  const romB = path.join(WORK, 'romB');
  const outB = path.join(WORK, 'outB');
  for (const d of [romA, outA, romB, outB]) fs.mkdirSync(d, { recursive: true });

  const bufA = Buffer.from('update-smoke-a');
  const crcA = toHex(crc32(bufA));
  await fsp.writeFile(path.join(romA, 'a.gg'), bufA);

  const bufB = Buffer.from('update-smoke-b');
  const crcB = toHex(crc32(bufB));
  await fsp.writeFile(path.join(romB, 'b.gg'), bufB);

  datSrv = await startDatServer();
  srv = await startServer();
  {
    const st = await api('/state');
    if (!path.resolve(String(st.dataDir || '')).startsWith(path.resolve(WORK))) {
      throw new Error('数据目录未隔离，中止：' + st.dataDir);
    }
  }

  const gamesA = [{ title: '更新测试甲', crc: crcA }];
  const libA = await importDat('upd-a.xml', datXml(gamesA, '1', '更新测试A'));
  const libB = await importDat('upd-b.xml', datXml([{ title: '更新测试乙', crc: crcB }], '1', '更新测试B'));
  ok('两个清单导入成功', !!libA && !!libB);

  for (const [id, rom, out] of [[libA, romA, outA], [libB, romB, outB]]) {
    await api(`/libraries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ settings: { romDir: rom, outDir: out, mode: 'raw', matchMode: 'both' } }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log('\n[1] 更新 DAT：内容没变 → 扫描进度保留');
  for (const id of [libA, libB]) {
    const s = await api(`/libraries/${id}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    await waitTask(s.task.id);
  }
  const before = await api(`/libraries/${libA}/games`);
  ok('扫描后已拥有 1 个', before.stats.owned === 1, JSON.stringify(before.stats));

  // 服务端返回同一份内容（版本、条目、CRC 都没变）
  servedDat = datXml(gamesA, '1', '更新测试A');
  const u1 = await api(`/libraries/${libA}/update`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const ut1 = await waitTask(u1.task.id);
  ok('更新任务完成', ut1.status === 'done', JSON.stringify(ut1.error || '').slice(0, 160));
  ok('识别为「内容未变化」', ut1.result && ut1.result.unchanged === true, JSON.stringify(ut1.result));
  const after = await api(`/libraries/${libA}/games`);
  ok('已拥有数量保持不变', after.stats.owned === 1, JSON.stringify(after.stats));
  ok('游戏状态仍是已拥有（没被重置成未扫描）', after.games[0].status === 'owned', after.games[0].status);

  console.log('\n[2] 更新 DAT：内容真的变了 → 扫描结果作废');
  servedDat = datXml([...gamesA, { title: '更新测试甲2', crc: 'FFFF0000' }], '2', '更新测试A');
  const u2 = await api(`/libraries/${libA}/update`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const ut2 = await waitTask(u2.task.id);
  ok('更新任务完成', ut2.status === 'done', JSON.stringify(ut2.error || '').slice(0, 160));
  ok('未标记为 unchanged', !(ut2.result && ut2.result.unchanged), JSON.stringify(ut2.result));
  const after2 = await api(`/libraries/${libA}/games`);
  ok('条目数变成 2', after2.games.length === 2, String(after2.games.length));
  ok('状态回到未扫描', after2.games.every((g) => g.status === 'unknown'),
    after2.games.map((g) => g.status).join(','));

  console.log('\n[3] 待整理按清单隔离');
  // A 重新扫一遍（2 个游戏，输出目录空 → 待整理 2）
  {
    const s = await api(`/libraries/${libA}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    await waitTask(s.task.id);
  }
  // 把 B 的两个条目都整理掉一部分：只整理，让 B 的待整理变为 0
  {
    const s = await api(`/libraries/${libB}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    await waitTask(s.task.id);
  }
  const pendA1 = await api(`/libraries/${libA}/pending`);
  const pendB1 = await api(`/libraries/${libB}/pending`);
  ok('A 的待整理为 1（新增那条没有文件）', pendA1.pending === 1, JSON.stringify(pendA1));
  ok('B 的待整理为 1（还没整理）', pendB1.pending === 1, JSON.stringify(pendB1));
  ok('重复请求走缓存，结果一致',
    JSON.stringify(await api(`/libraries/${libA}/pending`)) === JSON.stringify(pendA1));

  // 把 B 整理干净，再回头看两个清单 —— 各自的数量必须是各自的状态
  {
    const o = await api(`/libraries/${libB}/organize`, { method: 'POST', body: '{"dryRun":false}', headers: { 'Content-Type': 'application/json' } });
    await waitTask(o.task.id);
  }
  const pendA2 = await api(`/libraries/${libA}/pending`);
  const pendB2 = await api(`/libraries/${libB}/pending`);
  ok('整理后 B 的待整理归零', pendB2.pending === 0, JSON.stringify(pendB2));
  ok('B 整理后 A 不受影响，仍是 1', pendA2.pending === 1, JSON.stringify(pendA2));

  console.log('\n[4] 改设置后待整理要重算（不能用旧缓存）');
  await api(`/libraries/${libA}`, {
    method: 'PATCH',
    body: JSON.stringify({ settings: { outDir: path.join(WORK, 'outA2') } }),
    headers: { 'Content-Type': 'application/json' },
  });
  const pendA3 = await api(`/libraries/${libA}/pending`);
  // A 只有 1 个条目有对应文件，换到空目录后这 1 条都要重新整理
  ok('换输出目录后待整理按新目录重算', pendA3.pending === 1, JSON.stringify(pendA3));

  console.log('\n[5] 清理');
  srv.kill();
  datSrv.close();
  fs.rmSync(WORK, { recursive: true, force: true });

  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e.message);
  if (srv) { try { srv.kill(); } catch (_) {} }
  if (datSrv) { try { datSrv.close(); } catch (_) {} }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
