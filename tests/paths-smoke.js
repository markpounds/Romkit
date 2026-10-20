'use strict';
/* 冒烟测试：全局存储位置（DAT / 图片）生效规则，以及 state 暴露 paths */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ROMKIT_PATHS_PORT || 18995);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'romkit-paths-data');
const DAT_DIR = path.join(os.tmpdir(), 'romkit-paths-dats');
const COVER_DIR = path.join(os.tmpdir(), 'romkit-paths-covers');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

const DAT_XML = `<?xml version="1.0"?>
<dat>
  <configuration>
    <datName>路径测试</datName>
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

async function main() {
  for (const d of [DATA, DAT_DIR, COVER_DIR]) {
    await fsp.rm(d, { recursive: true, force: true });
    await fsp.mkdir(d, { recursive: true });
  }
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      ROMKIT_DATA: DATA, ROMKIT_PORT: String(PORT),
      ROMKIT_DAT_DIR: DAT_DIR, ROMKIT_COVER_DIR: COVER_DIR,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitReady();

    const st = await api('/api/state');
    ok(!!st.body.paths, 'state 暴露 paths 字段');
    ok(st.body.paths.datDir === DAT_DIR, '环境变量 ROMKIT_DAT_DIR 生效');
    ok(st.body.paths.coverDir === COVER_DIR, '环境变量 ROMKIT_COVER_DIR 生效');
    ok(st.body.paths.dataDir === DATA, '数据目录正确');

    // 导入 DAT，应落到环境变量指定的目录
    const src = path.join(DATA, 'src.xml');
    await fsp.writeFile(src, DAT_XML);
    const imp = await api('/api/libraries', { method: 'POST', body: JSON.stringify({ path: src }) });
    ok(imp.status === 200 && !!imp.body.library, 'DAT 导入成功');
    const libId = imp.body.library.id;
    const files = await fsp.readdir(DAT_DIR).catch(() => []);
    ok(files.some((f) => /\.xml$/i.test(f)), `DAT 文件写入自定义 DAT 目录（${files.join(',')}）`);

    // 图片目录默认按每个清单建子目录（coverDir 由环境变量决定，测试进程里也要设）
    process.env.ROMKIT_COVER_DIR = COVER_DIR;
    const covers = require(path.join(ROOT, 'lib', 'covers.js'));
    const lib = { id: libId, assets: { cover: { enabled: true, dir: '', storeDir: '', mode: 'auto', pattern: '{im1CRC}' } } };
    ok(covers.cacheDirFor(lib) === path.join(COVER_DIR, libId), '封面目录 = 自定义图片目录 + 清单 id');
    const lib2 = { id: libId, assets: { cover: { enabled: true, storeDir: '/tmp/my-covers' } } };
    ok(covers.cacheDirFor(lib2) === '/tmp/my-covers', '清单自带的存储位置优先');

    // 配置文件写入（环境变量优先级更高，但接口应能存）
    const saved = await api('/api/config/paths', { method: 'POST', body: JSON.stringify({ datDir: '/tmp/from-ui', coverDir: '/tmp/from-ui-c' }) });
    ok(saved.status === 200 && saved.body.paths.datDir === '/tmp/from-ui', 'config/paths 可写入');
    ok(saved.body.effective.datDir === DAT_DIR, '环境变量优先于配置文件');
  } finally {
    srv.kill();
    for (const d of [DATA, DAT_DIR, COVER_DIR]) await fsp.rm(d, { recursive: true, force: true });
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
