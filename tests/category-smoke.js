'use strict';
/* 冒烟测试：分类树（含子分类）、清单归类、拖拽排序、删除级联 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ROMKIT_CAT_PORT || 18997);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'romkit-cat-data');
const ROMS = path.join(os.tmpdir(), 'romkit-cat-roms');

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
function dat(name, sys) {
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

    // 建三个 DAT
    const ids = [];
    for (const n of ['甲库', '乙库', '丙库']) {
      const p = path.join(ROMS, `${n}.xml`);
      await fsp.writeFile(p, dat(n));
      const r = await api('/api/libraries', { method: 'POST', body: JSON.stringify({ path: p }) });
      ids.push(r.body.library.id);
    }
    ok(ids.length === 3, '三个 DAT 导入成功');

    const st0 = await api('/api/state');
    ok(Array.isArray(st0.body.categories), 'state 暴露 categories');

    // 顶层分类 + 子分类
    const c1 = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: '任天堂' }) });
    ok(c1.status === 200 && !!c1.body.category.id, '新建顶层分类');
    const c2 = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'GBA', parentId: c1.body.category.id }) });
    ok(c2.body.category.parentId === c1.body.category.id, '新建子分类（层级正确）');

    const cats = (await api('/api/categories')).body.categories;
    ok(cats.length === 2, '分类列表含两条');

    // 归类：甲→任天堂，乙→GBA
    await api(`/api/libraries/${ids[0]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: c1.body.category.id }) });
    await api(`/api/libraries/${ids[1]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: c2.body.category.id }) });
    const st1 = await api('/api/state');
    const byId = Object.fromEntries(st1.body.libraries.map((l) => [l.id, l]));
    ok(byId[ids[0]].categoryId === c1.body.category.id, 'DAT 归入顶层分类');
    ok(byId[ids[1]].categoryId === c2.body.category.id, 'DAT 归入子分类');
    ok(!(byId[ids[2]].categoryId || ''), '未归类的 DAT 保持未分类');

    // 无效分类 id 应被忽略而不是写坏数据
    await api(`/api/libraries/${ids[2]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: 'not-exist' }) });
    const st2 = await api('/api/state');
    ok(!(st2.body.libraries.find((l) => l.id === ids[2]).categoryId || ''), '无效分类 id 被忽略');

    // 循环父级防护：把任天堂挂到自己的子分类 GBA 下
    const bad = await api(`/api/categories/${c1.body.category.id}`, { method: 'PATCH', body: JSON.stringify({ parentId: c2.body.category.id }) });
    ok(bad.status === 400, '拒绝把分类挂到自己的子分类下（防环）');

    // 拖拽排序：未分类里只有丙库，先把甲、乙也移回未分类再排
    await api(`/api/libraries/${ids[0]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: '' }) });
    await api(`/api/libraries/${ids[1]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: '' }) });
    const order = [ids[2], ids[0], ids[1]];
    const ro = await api('/api/reorder-libraries', { method: 'POST', body: JSON.stringify({ categoryId: '', ids: order }) });
    ok(ro.status === 200, '拖拽排序提交成功');
    const st3 = await api('/api/state');
    const actual = st3.body.libraries.map((l) => l.id);
    ok(JSON.stringify(actual) === JSON.stringify(order), `顺序已生效（${actual.map((x) => x.slice(0, 4)).join(',')}）`);

    // 数量不匹配应被拒绝
    const badRo = await api('/api/reorder-libraries', { method: 'POST', body: JSON.stringify({ categoryId: '', ids: [ids[0]] }) });
    ok(badRo.status === 400, '排序数量不匹配被拒绝');

    // 删除分类：子分类上提，清单落到父级
    await api(`/api/libraries/${ids[1]}`, { method: 'PATCH', body: JSON.stringify({ categoryId: c2.body.category.id }) });
    const del = await api(`/api/categories/${c2.body.category.id}`, { method: 'DELETE' });
    ok(del.status === 200, '删除子分类成功');
    const st4 = await api('/api/state');
    ok(st4.body.libraries.find((l) => l.id === ids[1]).categoryId === c1.body.category.id, '子分类里的 DAT 上提到父分类');
  } finally {
    srv.kill();
    for (const d of [DATA, ROMS]) await fsp.rm(d, { recursive: true, force: true });
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
