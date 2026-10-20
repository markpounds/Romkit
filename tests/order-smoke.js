'use strict';
/* 冒烟测试：新排序规则（分类树前序展开）+ 文件名匹配 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ROMKIT_ORDER_PORT || 18996);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'romkit-order-data');
const ROMS = path.join(os.tmpdir(), 'romkit-order-roms');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
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
function dat(name) {
  return `<?xml version="1.0"?>
<dat><configuration>
  <datName>${name}</datName><datVersion>20260101</datVersion>
  <canOpen><extension>.gg</extension></canOpen>
</configuration><games><game>
  <imageNumber>1</imageNumber><title>${name}</title><saveType></saveType>
  <romSize>1024</romSize><publisher>T</publisher><location>7</location><sourceRom>官中</sourceRom>
  <language>4</language><files><romCRC extension=".gg">12345678</romCRC></files>
  <im1CRC>AAAA1111</im1CRC><im2CRC>BBBB2222</im2CRC><comment>C</comment><duplicateID>1</duplicateID>
</game></games></dat>`;
}

async function main() {
  for (const d of [DATA, ROMS]) {
    await fsp.rm(d, { recursive: true, force: true });
    await fsp.mkdir(d, { recursive: true });
  }
  await fsp.writeFile(path.join(ROMS, 'a.gg'), 'x'.repeat(32));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ROMKIT_DATA: DATA, ROMKIT_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitReady();

    // 建 6 个 DAT
    const names = ['a1.1', 'a1.2', 'a2', 'a3', 'b1', 'b2'];
    const ids = [];
    for (const n of names) {
      const p = path.join(ROMS, `${n}.xml`);
      await fsp.writeFile(p, dat(n));
      const r = await api('/api/libraries', { method: 'POST', body: JSON.stringify({ path: p }) });
      ids.push(r.body.library.id);
    }
    ok(ids.length === 6, '六个 DAT 导入成功');

    // 分类：A（含子分类 a1）、B
    const A = (await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'A' }) })).body.category;
    const a1 = (await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'a1', parentId: A.id }) })).body.category;
    const B = (await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'B' }) })).body.category;
    ok(!!A && !!a1 && !!B, '分类 A / a1 / B 建好');

    // 归类：a1.1,a1.2 → a1；a2,a3 → A；b1,b2 → B
    const assign = [['a1.1', a1.id], ['a1.2', a1.id], ['a2', A.id], ['a3', A.id], ['b1', B.id], ['b2', B.id]];
    for (let i = 0; i < assign.length; i++) {
      await api(`/api/libraries/${ids[i]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: assign[i][1] }) });
    }

    const st = await api('/api/state');
    const order = st.body.libraries.map((l) => l.name);
    ok(
      JSON.stringify(order) === JSON.stringify(['a1.1', 'a1.2', 'a2', 'a3', 'b1', 'b2']),
      `排序 = a1.1,a1.2,a2,a3,b1,b2（实得 ${order.join(',')}）`
    );

    // 组内排序：a1 组内把 a1.2 提到 a1.1 前面
    const a1Ids = st.body.libraries.filter((l) => l.categoryId === a1.id).map((l) => l.id);
    const ro = await api('/api/reorder-libraries', {
      method: 'POST', body: JSON.stringify({ categoryId: a1.id, ids: [a1Ids[1], a1Ids[0]] }),
    });
    ok(ro.status === 200, '组内排序提交成功');
    const st2 = await api('/api/state');
    const order2 = st2.body.libraries.map((l) => l.name);
    ok(
      JSON.stringify(order2) === JSON.stringify(['a1.2', 'a1.1', 'a2', 'a3', 'b1', 'b2']),
      `组内排序生效（实得 ${order2.join(',')}）`
    );

    // 排序清单必须正好是该组的直属清单：混入别组的 id 应被拒绝
    const bad = await api('/api/reorder-libraries', {
      method: 'POST', body: JSON.stringify({ categoryId: a1.id, ids: [a1Ids[0]] }),
    });
    ok(bad.status === 400, '排序清单与分组不匹配时被拒绝');

    // 组间排序：把 B 提到 A 前面
    const cats = (await api('/api/categories')).body.categories;
    const topIds = cats.filter((c) => !c.parentId).sort((x, y) => (x.ord || 0) - (y.ord || 0)).map((c) => c.id);
    const ro2 = await api('/api/categories/reorder', {
      method: 'POST', body: JSON.stringify({ parentId: null, ids: [topIds[1], topIds[0]] }),
    });
    ok(ro2.status === 200, '组间排序提交成功');
    const st3 = await api('/api/state');
    const order3 = st3.body.libraries.map((l) => l.name);
    ok(
      JSON.stringify(order3) === JSON.stringify(['b1', 'b2', 'a1.2', 'a1.1', 'a2', 'a3']),
      `组间排序生效（实得 ${order3.join(',')}）`
    );
  } finally {
    srv.kill();
    for (const d of [DATA, ROMS]) await fsp.rm(d, { recursive: true, force: true });
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
