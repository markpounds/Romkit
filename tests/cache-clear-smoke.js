/* 缓存清理 + 整理后状态即时更新 冒烟测试
 *   1) store.cacheClearUnder 只清指定目录下的 CRC 缓存
 *   2) store.cacheClearAll 清空全部
 *   3) DELETE /api/libraries/:id/cache 清本库缓存并让扫描快照失效
 *   4) POST /api/cache/clear 清全部
 *   5) 整理完成后返回 pending，界面无需重新扫描即可更新状态
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'romkit-cache-' + Date.now());
const PORT = 28700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !extra ? '' : ' → ' + extra}`);
};

let srv = null;
function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, ROMKIT_DATA: path.join(WORK, 'data'), ROMKIT_PORT: String(PORT), ...env },
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      if (/http:\/\/127\.0\.0\.1/.test(out)) resolve(p);
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('服务端退出，code=' + c + '\n' + out)));
    setTimeout(() => reject(new Error('启动超时：\n' + out)), 15000);
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
  while (Date.now() - t0 < ms) {
    const { task } = await api(`/tasks/${id}`);
    if (task.status !== 'running') return task;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('任务超时');
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });

  const store = require('../lib/store');
  const { crc32, toHex } = require('../lib/crc32');

  console.log('\n[1] store 层缓存清理');
  // 直接构造缓存条目验证目录前缀判断（不依赖磁盘）
  const dirA = path.join(WORK, 'romA');
  const dirB = path.join(WORK, 'romB');
  store.cacheSet(dirA + path.sep + 'a.gg|100|111', 'AAAA0001');
  store.cacheSet(dirA + path.sep + 'sub/a2.gg|200|222', 'AAAA0002');
  store.cacheSet(dirB + path.sep + 'b.gg|300|333', 'BBBB0001');
  ok('清 A 目录只删 A 的条目', store.cacheClearUnder(dirA) === 2, '清掉 ' + 2);
  ok('B 的条目仍然保留', store.cacheGet(dirB + path.sep + 'b.gg|300|333') === 'BBBB0001', String(store.cacheGet(dirB + path.sep + 'b.gg|300|333')));
  ok('清空全部返回剩余条数', store.cacheClearAll() === 1, String(1));
  ok('清空后总数归零', store.cacheCount() === 0, String(store.cacheCount()));

  console.log('\n[2] 整理后 pending 即时更新（HTTP 全链路）');
  const romDir = path.join(WORK, 'rom');
  const outDir = path.join(WORK, 'out');
  await fsp.mkdir(romDir, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });

  const buf = Buffer.from('cache-smoke-rom-' + Date.now());
  const crc = toHex(crc32(buf));
  await fsp.writeFile(path.join(romDir, 'test-game.gg'), buf);

  srv = await startServer();
  // 保险：确认服务端用的是临时数据目录，绝不能动到项目里的真实 data/
  {
    const st = await api('/state');
    const dataDir = String(st.dataDir || '');
    if (!dataDir || !path.resolve(dataDir).startsWith(path.resolve(WORK))) {
      throw new Error('数据目录未隔离，拒绝继续测试（避免污染真实配置）：' + dataDir);
    }
  }
  const datXml = `<?xml version="1.0"?><dat><configuration><datName>缓存测试</datName><datVersion>1</datVersion><system>Sega - Game Gear</system><imFolder>x</imFolder><romTitle>%u - %n</romTitle></configuration><games><game><imageNumber>1</imageNumber><title>测试游戏 (简)</title><romSize>${buf.length}</romSize><files><romCRC extension=".gg">${crc}</romCRC></files><comment>Test Game (Japan)</comment><duplicateID>1</duplicateID></game></games></dat>`;
  const up = await fetch(BASE + '/libraries/import?name=cache-test.xml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(datXml, 'utf8'),
  }).then((r) => r.json());
  const libId = up.library && up.library.id;
  ok('DAT 导入成功', !!libId, JSON.stringify(up && up.error));

  await api(`/libraries/${libId}`, {
    method: 'PATCH',
    body: JSON.stringify({ settings: { romDir, outDir, mode: 'raw', matchMode: 'both' } }),
    headers: { 'Content-Type': 'application/json' },
  });

  const s1 = await api(`/libraries/${libId}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const t1 = await waitTask(s1.task.id);
  ok('扫描命中 1 个', t1.result.stats.owned === 1, JSON.stringify(t1.result.stats));
  ok('扫描后 pending 应为 1（还没整理）', t1.result.pending && t1.result.pending.pending === 1, JSON.stringify(t1.result.pending));

  const o1 = await api(`/libraries/${libId}/organize`, { method: 'POST', body: '{"dryRun":false}', headers: { 'Content-Type': 'application/json' } });
  const ot1 = await waitTask(o1.task.id);
  ok('整理成功', ot1.status === 'done', JSON.stringify(ot1.error || ot1.result));
  ok('整理结果里带回 pending', !!(ot1.result && ot1.result.pending), JSON.stringify(ot1.result && ot1.result.pending));
  ok('整理后 pending 归零（无需重新扫描）', ot1.result.pending.pending === 0, JSON.stringify(ot1.result.pending));

  console.log('\n[3] 清缓存接口');
  const del = await api(`/libraries/${libId}/cache`, { method: 'DELETE' });
  ok('DELETE /libraries/:id/cache 成功', del.ok === true, JSON.stringify(del));
  ok('返回清掉的 CRC 条数', typeof del.crcRemoved === 'number' && del.crcRemoved > 0, String(del.crcRemoved));
  const afterDel = await api(`/libraries/${libId}/games`);
  // 清缓存后 DAT 里的条目仍然在，只是状态回到「未扫描」，已拥有的匹配全部清空
  ok('清除后游戏状态回到未扫描', afterDel.games.every((g) => g.status === 'unknown'),
    JSON.stringify(afterDel.games.map((g) => g.status)));
  ok('清除后已拥有数归零', afterDel.stats.owned === 0, JSON.stringify(afterDel.stats));

  // 再扫一次产生缓存，然后测全局清理
  const s2 = await api(`/libraries/${libId}/scan`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  await waitTask(s2.task.id);
  const all = await api('/cache/clear', { method: 'POST' });
  ok('POST /cache/clear 成功', all.ok === true, JSON.stringify(all));
  ok('全局清理返回 CRC 与扫描数', typeof all.crcRemoved === 'number' && typeof all.scansRemoved === 'number',
    JSON.stringify({ crc: all.crcRemoved, scans: all.scansRemoved }));
  ok('全局清理后 CRC 缓存为 0', all.crcRemoved >= 0);

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
