'use strict';
/* 冒烟测试：读取失败的诊断信息、扫描任务回传 unreadableList、落盘权限补偿 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ROMKIT_PERM_PORT || 18994);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'romkit-perm-data');
const ROMS = path.join(os.tmpdir(), 'romkit-perm-roms');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

const DAT_XML = `<?xml version="1.0"?>
<dat>
  <configuration>
    <datName>测试清单</datName>
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
  for (let i = 0; i < 200; i++) {
    const { body } = await api(`/api/tasks/${id}`);
    if (body && body.task && ['done', 'error', 'cancelled'].includes(body.task.status)) return body.task;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('任务超时');
}

async function main() {
  for (const d of [DATA, ROMS]) {
    await fsp.rm(d, { recursive: true, force: true });
    await fsp.mkdir(d, { recursive: true });
  }
  // 一个正常 ROM + 一个真的读不动的 ROM
  await fsp.writeFile(path.join(ROMS, 'ok.gg'), 'x'.repeat(64));
  const locked = path.join(ROMS, 'locked.gg');
  await fsp.writeFile(locked, 'y'.repeat(64));
  // Windows 用 ACL 拒绝读取；POSIX 直接改权限位
  try {
    if (process.platform === 'win32') execFileSync('icacls', [locked, '/deny', '*S-1-1-0:(R)', '/Q'], { stdio: 'pipe' });
    else await fsp.chmod(locked, 0o000);
  } catch (e) { console.log('  ! 无法制造不可读文件：' + e.message); }

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ROMKIT_DATA: DATA, ROMKIT_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitReady();

    // 导入 DAT
    const datPath = path.join(ROMS, 'test.xml');
    await fsp.writeFile(datPath, DAT_XML);
    const imp = await api('/api/libraries', { method: 'POST', body: JSON.stringify({ path: datPath }) });
    const libId = imp.body && imp.body.library && imp.body.library.id;
    ok(!!libId, 'DAT 导入成功');

    // 把 ROM 目录指到测试目录后扫描
    await api(`/api/libraries/${libId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        settings: {
          romDir: ROMS, outDir: path.join(ROMS, '_out'), mode: 'zip', operation: 'copy',
          matchMode: 'both', scanMode: 'full',
        },
      }),
    });
    const scanTask = await api(`/api/libraries/${libId}/scan`, { method: 'POST', body: '{}' });
    ok(scanTask.status === 200 && !!scanTask.body.task, '扫描任务已启动');
    const task = await pollTask(scanTask.body.task.id);
    const result = task.result || {};
    ok(typeof result.elapsedMs === 'number', '扫描任务返回结果');

    const list = result.unreadableList || [];
    ok(Array.isArray(list), '扫描结果回传 unreadableList 字段（修复前被丢弃）');
    ok(list.length >= 1, `失败文件进入清单（${list.length} 个）`);
    const hit = list.find((x) => x.path && x.path.includes('locked.gg'));
    ok(!!hit, '失败文件在清单里');
    ok(!!(hit && hit.error), `失败原因有具体错误码（${hit && hit.error}）`);
    ok(!!(hit && hit.diag), '附带权限诊断信息 diag');
    ok(hit && hit.diag && (hit.diag.mode || hit.diag.statError || hit.diag.parentMode),
      'diag 含文件权限或父目录权限证据');

    // 正常文件没被误判
    const noFalse = !list.some((x) => x.path && x.path.endsWith('ok.gg'));
    ok(noFalse, '可正常读取的文件没有被误报');

    // 批量修复权限接口
    const fix = await api('/api/fs/fixperm', {
      method: 'POST', body: JSON.stringify({ paths: [path.join(ROMS, 'ok.gg'), locked] }),
    });
    ok(fix.status === 200 && typeof fix.body.fixed === 'number', 'fixperm 接口返回结果');
    ok(fix.body.fixed + fix.body.failed === 2,
      `fixperm 逐文件统计完整（成功 ${fix.body.fixed} / 失败 ${fix.body.failed}）`);
    ok(Array.isArray(fix.body.errors), 'fixperm 回传失败明细');

    // 单元测试：inspectReadFailure 对不存在的文件也能给出父目录证据
    const { inspectReadFailure } = require(path.join(ROOT, 'lib', 'scanner.js'));
    const d1 = await inspectReadFailure(path.join(ROMS, 'does-not-exist.gg'));
    ok(!!d1.statError, '不存在文件：记录 stat 失败原因');
    ok(!!d1.parentMode, '不存在文件：仍给出父目录权限证据');
    const d2 = await inspectReadFailure(path.join(ROMS, 'ok.gg'));
    ok(/^0[0-7]{3}$/.test(d2.mode || ''), `正常文件：给出八进制权限（${d2.mode}）`);
    ok(typeof d2.uid === 'number', '正常文件：给出 uid');

    // 单元测试：整理落盘的权限补偿（organizer 内部函数，通过导出验证存在性）
    const organizerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'organizer.js'), 'utf8');
    ok(/async function applySourceMode/.test(organizerSrc), 'organizer 有 applySourceMode 权限补偿');
    ok(/await applySourceMode\(dest, it\.source\.path\)/.test(organizerSrc), '复制分支调用了权限补偿');
    ok(/process\.umask\(0o022\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
      '服务端启动时把 umask 放宽到 022');
  } finally {
    srv.kill();
    for (const d of [DATA, ROMS]) {
      // Windows 上被拒绝读取的文件删不掉，先重置 ACL
      if (process.platform === 'win32') {
        try { execFileSync('icacls', [d, '/reset', '/T', '/Q'], { stdio: 'pipe' }); } catch (_) {}
      }
      await fsp.rm(d, { recursive: true, force: true });
    }
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
