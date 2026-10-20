'use strict';
/* 冒烟测试：DAT 图标上传/读取/删除、待分类文件夹配置、主题按钮元素 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.ROMKIT_SMOKE_PORT || 18991);
const DATA_DIR = path.join(os.tmpdir(), 'romkit-smoke-data');
const BASE = `http://127.0.0.1:${PORT}`;
let srv = null;
let passed = 0, failed = 0;

function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

async function startServer() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ROMKIT_DATA: DATA_DIR, ROMKIT_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动失败');
}

async function main() {
  await startServer();
  try {
    // 造一个最小 OfflineList DAT 并导入，拿到 libId
    const datXml = `<?xml version="1.0"?>
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
    const p = path.join(DATA_DIR, 'test.xml');
    await fsp.writeFile(p, datXml);
    const imp = await fetch(BASE + '/api/libraries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const impBody = await imp.json();
    const libId = impBody.library.id;
    ok(!!libId, '导入 DAT 得到 libId');

    // ---- 待分类文件夹配置 ----
    const cfgRes = await fetch(BASE + '/api/config/ui', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inboxDir: 'D:\\ROMs\\Inbox' }),
    });
    ok(cfgRes.ok, 'POST /config/ui 保存待分类文件夹');
    const st = await (await fetch(BASE + '/api/state')).json();
    ok(st.ui && st.ui.inboxDir === 'D:\\ROMs\\Inbox', '/state 返回 inboxDir');
    ok(!!st.dataDir, '/state 返回 dataDir（设置里展示用）');

    // ---- 图标：未上传时 404 ----
    const noIcon = await fetch(`${BASE}/api/libraries/${libId}/icon`);
    ok(noIcon.status === 404, '未配置图标时 GET /icon 返回 404');

    // ---- 上传图标（1x1 透明 PNG） ----
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = await fetch(`${BASE}/api/libraries/${libId}/icon?name=ps.png`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
    });
    const upBody = await up.json();
    ok(up.ok && upBody.file === libId + '.png', '上传图标返回存储文件名');
    const iconFile = path.join(DATA_DIR, 'icons', libId + '.png');
    ok(fs.existsSync(iconFile), '图标文件落盘 data/icons/');

    // ---- 读取图标 ----
    const get = await fetch(`${BASE}/api/libraries/${libId}/icon`);
    const buf = Buffer.from(await get.arrayBuffer());
    ok(get.ok && get.headers.get('content-type') === 'image/png' && buf.equals(png), 'GET /icon 原样返回图片');

    // ---- 设置持久化 ----
    const lib = await (await fetch(`${BASE}/api/libraries/${libId}`)).json();
    ok(lib.library.settings.iconFile === libId + '.png', 'settings.iconFile 已持久化');
    ok(lib.library.settings.iconText === '', '上传图片时 iconText 被清空');

    // ---- 不支持的格式被拒绝 ----
    const bad = await fetch(`${BASE}/api/libraries/${libId}/icon?name=x.txt`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
    });
    ok(bad.status === 400, '非图片扩展名被拒绝（400）');

    // ---- 文字图标 + PATCH 持久化 ----
    const patch = await fetch(`${BASE}/api/libraries/${libId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { iconText: '🎮', iconFile: '' } }),
    });
    ok(patch.ok, 'PATCH 保存文字图标');
    const lib2 = await (await fetch(`${BASE}/api/libraries/${libId}`)).json();
    ok(lib2.library.settings.iconText === '🎮' && lib2.library.settings.iconFile === '', '文字图标生效、图片引用已清');

    // ---- DELETE 图标 ----
    const del = await fetch(`${BASE}/api/libraries/${libId}/icon`, { method: 'DELETE' });
    ok(del.ok, 'DELETE /icon 成功');
    ok(!fs.existsSync(iconFile), '图标文件已从磁盘删除');
    const after = await fetch(`${BASE}/api/libraries/${libId}/icon`);
    ok(after.status === 404, '删除后 GET /icon 再次 404');

    // ---- 删除库时清理图标文件 ----
    const up2 = await fetch(`${BASE}/api/libraries/${libId}/icon?name=ps.png`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
    });
    ok(up2.ok && fs.existsSync(iconFile), '重新上传图标用于删除测试');
    await fetch(`${BASE}/api/libraries/${libId}`, { method: 'DELETE' });
    ok(!fs.existsSync(iconFile), '删除清单时图标文件一并清理');
  } finally {
    if (srv) srv.kill();
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); if (srv) srv.kill(); process.exit(1); });
