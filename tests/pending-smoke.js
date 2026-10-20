'use strict';
/* 冒烟测试：扫描后统计待整理数量，以及对单条游戏发起整理 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ROMKIT_PENDING_PORT || 18996);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'romkit-pend-data');
const ROMS = path.join(os.tmpdir(), 'romkit-pend-roms');
const OUT = path.join(os.tmpdir(), 'romkit-pend-out');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

// CRC 12345678 对应内容：随便造一个文件，用文件名匹配即可（matchMode=both）
const DAT_XML = `<?xml version="1.0"?>
<dat>
  <configuration>
    <datName>待整理测试</datName>
    <datVersion>20260101</datVersion>
    <canOpen><extension>.gg</extension></canOpen>
  </configuration>
  <games>
    <game>
      <imageNumber>1</imageNumber><title>游戏甲</title><saveType></saveType>
      <romSize>1024</romSize><publisher>Tester</publisher><location>7</location><sourceRom>官中</sourceRom>
      <language>4</language>
      <files><romCRC extension=".gg">12345678</romCRC></files>
      <im1CRC>AAAA1111</im1CRC><im2CRC>BBBB2222</im2CRC>
      <comment>Game A</comment><duplicateID>1</duplicateID>
    </game>
    <game>
      <imageNumber>2</imageNumber><title>游戏乙</title><saveType></saveType>
      <romSize>1024</romSize><publisher>Tester</publisher><location>7</location><sourceRom>官中</sourceRom>
      <language>4</language>
      <files><romCRC extension=".gg">87654321</romCRC></files>
      <im1CRC>CCCC1111</im1CRC><im2CRC>DDDD2222</im2CRC>
      <comment>Game B</comment><duplicateID>2</duplicateID>
    </game>
  </games>
</dat>`;

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动失败');
}
async function pollTask(id) {
  for (let i = 0; i < 300; i++) {
    const { body } = await api(`/api/tasks/${id}`);
    if (body && body.task && ['done', 'error', 'cancelled'].includes(body.task.status)) return body.task;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('任务超时');
}

async function main() {
  for (const d of [DATA, ROMS, OUT]) {
    await fsp.rm(d, { recursive: true, force: true });
    await fsp.mkdir(d, { recursive: true });
  }
  // 两个名字能对上标题的 ROM
  await fsp.writeFile(path.join(ROMS, '游戏甲.gg'), 'a'.repeat(128));
  await fsp.writeFile(path.join(ROMS, '游戏乙.gg'), 'b'.repeat(128));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ROMKIT_DATA: DATA, ROMKIT_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitReady();
    const datPath = path.join(ROMS, 'test.xml');
    await fsp.writeFile(datPath, DAT_XML);
    const imp = await api('/api/libraries', { method: 'POST', body: JSON.stringify({ path: datPath }) });
    const libId = imp.body.library.id;

    await api(`/api/libraries/${libId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        settings: {
          romDir: ROMS, outDir: OUT, mode: 'raw', operation: 'copy',
          fileTemplate: '{title}', archiveTemplate: '{title}', matchMode: 'both', scanMode: 'full',
        },
      }),
    });

    const s1 = await api(`/api/libraries/${libId}/scan`, { method: 'POST', body: '{}' });
    const t1 = await pollTask(s1.body.task.id);
    ok(t1.status === 'done', '扫描完成');
    ok(!!t1.result.pending, '扫描结果带 pending 字段');
    ok(t1.result.pending.pending === 2, `待整理数 = 2（实得 ${t1.result.pending.pending}）`);
    ok(JSON.stringify(t1.result.pending.indexes) === '[1,2]', '待整理包含两个游戏');

    // 查询接口
    const q = await api(`/api/libraries/${libId}/pending`);
    ok(q.body.pending === 2, '/pending 接口数量一致');

    // 只整理第一条
    const one = await api(`/api/libraries/${libId}/organize-one`, { method: 'POST', body: JSON.stringify({ index: 1 }) });
    ok(one.status === 200 && !!one.body.task, 'organize-one 返回任务');
    const t2 = await pollTask(one.body.task.id);
    ok(t2.status === 'done', '单条整理任务完成');
    ok(t2.result.done >= 1, `单条整理执行了 ${t2.result.done} 项`);
    ok(t2.result.single === 1, '结果标记了整理的是哪一条');
    const outFiles = await fsp.readdir(OUT);
    ok(outFiles.some((f) => f.includes('游戏甲')), `输出目录出现游戏甲（${outFiles.join(',')}）`);
    ok(!outFiles.some((f) => f.includes('游戏乙')), '游戏乙未被整理（只整理了这一条）');

    // 整理完再统计（此时 romDir 还是原目录）：应只剩 1 条待整理
    const s2 = await api(`/api/libraries/${libId}/scan`, { method: 'POST', body: '{}' });
    const t3 = await pollTask(s2.body.task.id);
    ok(t3.result.pending.pending === 1, `整理后待整理变为 1（实得 ${t3.result.pending.pending}）`);

    // 缓存：整理后把 ROM 目录指到输出目录再扫描，应命中缓存而不是重新读文件
    await api(`/api/libraries/${libId}`, {
      method: 'PATCH', body: JSON.stringify({ settings: { romDir: OUT } }),
    });
    const s3 = await api(`/api/libraries/${libId}/scan`, { method: 'POST', body: '{}' });
    const t4 = await pollTask(s3.body.task.id);
    ok(t4.result.stats.crcFromCache >= 1 && t4.result.stats.crcComputed === 0,
      `整理后的文件命中缓存（cached=${t4.result.stats.crcFromCache}/computed=${t4.result.stats.crcComputed}）`);
  } finally {
    srv.kill();
    for (const d of [DATA, ROMS, OUT]) await fsp.rm(d, { recursive: true, force: true });
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
