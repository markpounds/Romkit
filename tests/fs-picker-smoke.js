'use strict';
/* 冒烟测试：目录选择器 /fs/list —— fnOS 授权目录根入口、目录列举、父级导航、错误提示 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT_FNOS = Number(process.env.ROMKIT_FS_PORT1 || 18992);
const PORT_WIN = Number(process.env.ROMKIT_FS_PORT2 || 18993);
const BASE1 = `http://127.0.0.1:${PORT_FNOS}`;
const BASE2 = `http://127.0.0.1:${PORT_WIN}`;

// 模拟 fnOS 环境
const AUTH_DIR = path.join(os.tmpdir(), 'romkit-fs-auth');     // 已授权目录
const SHARE_DIR = path.join(os.tmpdir(), 'romkit-fs-share');   // 共享目录
const PKGVAR = path.join(os.tmpdir(), 'romkit-fs-var');        // 应用数据目录
const DATA1 = path.join(os.tmpdir(), 'romkit-fs-data1');
const DATA2 = path.join(os.tmpdir(), 'romkit-fs-data2');

let srv1 = null, srv2 = null;
let passed = 0, failed = 0;

function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/state'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动失败 ' + base);
}

async function startServers() {
  for (const d of [AUTH_DIR, SHARE_DIR, PKGVAR, DATA1, DATA2]) {
    await fsp.rm(d, { recursive: true, force: true });
    await fsp.mkdir(d, { recursive: true });
  }
  // 授权目录里造点内容：两个子目录 + 两个 DAT 文件 + 一个隐藏项
  await fsp.mkdir(path.join(AUTH_DIR, 'roms'));
  await fsp.mkdir(path.join(AUTH_DIR, 'docs'));
  await fsp.writeFile(path.join(AUTH_DIR, 'a.zip'), 'x');
  await fsp.writeFile(path.join(AUTH_DIR, 'b.xml'), 'x');
  await fsp.writeFile(path.join(AUTH_DIR, '.hidden'), 'x');

  srv1 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      ROMKIT_DATA: DATA1, ROMKIT_PORT: String(PORT_FNOS),
      TRIM_APPDEST: '/var/apps/romkit/target',
      TRIM_APPNAME: 'romkit',
      TRIM_PKGVAR: PKGVAR,
      TRIM_DATA_ACCESSIBLE_PATHS: AUTH_DIR,
      TRIM_DATA_SHARE_PATHS: SHARE_DIR,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ROMKIT_DATA: DATA2, ROMKIT_PORT: String(PORT_WIN) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitReady(BASE1);
  await waitReady(BASE2);
}

async function main() {
  await startServers();
  try {
    // ---------- fnOS 模式 ----------
    const root1 = await (await fetch(BASE1 + '/api/fs/list')).json();
    ok(root1.fnos === true, 'fnOS 环境被正确识别');
    ok(Array.isArray(root1.authorizedPaths) && root1.authorizedPaths[0] === AUTH_DIR,
      '返回已授权目录清单');
    const authEntry = (root1.dirs || []).find((d) => d.path === AUTH_DIR);
    ok(!!authEntry && authEntry.name.startsWith('已授权 · '), '根入口包含「已授权」目录');
    ok((root1.dirs || []).some((d) => d.path === PKGVAR && d.name === '应用数据目录'),
      '根入口包含应用数据目录');
    ok((root1.dirs || []).some((d) => d.name === '主目录'), '根入口包含主目录');
    ok((root1.dirs || []).length > 0, 'fnOS 下根入口非空（修复前为空列表）');

    // 授权目录列举
    const list1 = await (await fetch(BASE1 + '/api/fs/list?path=' + encodeURIComponent(AUTH_DIR))).json();
    const names = (list1.dirs || []).map((d) => d.name);
    ok(names.includes('roms') && names.includes('docs'), '子目录被列举');
    ok(!names.includes('.hidden'), '隐藏项被过滤');
    ok((list1.files || []).map((f) => f.name).sort().join(',') === 'a.zip,b.xml',
      '只列举 .zip/.xml 文件');
    ok(JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b, 'zh'))),
      '目录按中文排序');
    ok(list1.parent === path.dirname(AUTH_DIR), '父目录计算正确');
    const sc1 = (list1.shortcuts || []).map((s) => s.name);
    ok(sc1.length === 1 && sc1[0].startsWith('授权：'), 'fnOS 快捷跳转=已授权目录');

    // 子目录的父级回到授权目录
    const sub = await (await fetch(BASE1 + '/api/fs/list?path=' + encodeURIComponent(path.join(AUTH_DIR, 'roms')))).json();
    ok(sub.parent === AUTH_DIR, '二级目录父级正确');

    // 不存在目录 → 友好错误
    const bad = await fetch(BASE1 + '/api/fs/list?path=' + encodeURIComponent(path.join(AUTH_DIR, 'nope')));
    ok(bad.status === 400, '不存在目录返回 400');
    const badBody = await bad.json();
    ok(/无法读取目录/.test(badBody.error || ''), '错误信息可读');

    // ---------- Windows 普通模式 ----------
    const root2 = await (await fetch(BASE2 + '/api/fs/list')).json();
    ok(root2.fnos === false, '非 fnOS 环境 fnos=false');
    ok((root2.dirs || []).length >= 1 && (root2.dirs || []).some((d) => /^[A-Za-z]:$/.test(d.name)),
      'Windows 罗列盘符');
    ok(!root2.authorizedPaths || root2.authorizedPaths.length === 0, '无授权目录时返回空清单');
    const list2 = await (await fetch(BASE2 + '/api/fs/list?path=' + encodeURIComponent(AUTH_DIR))).json();
    const sc2 = (list2.shortcuts || []).map((s) => s.name);
    ok(sc2.join(',') === 'Downloads,Desktop,Documents', 'Windows 快捷跳转=用户目录');
    // Windows 下盘符根的父级应是驱动器列表（空路径）
    const driveRoot = await (await fetch(BASE2 + '/api/fs/list?path=' + encodeURIComponent(process.env.SystemDrive ? process.env.SystemDrive + '\\' : 'C:\\'))).json();
    ok(driveRoot.parent === '', '盘符根父级回到驱动器列表');
  } finally {
    for (const s of [srv1, srv2]) { if (s) s.kill(); }
    for (const d of [AUTH_DIR, SHARE_DIR, PKGVAR, DATA1, DATA2]) {
      await fsp.rm(d, { recursive: true, force: true });
    }
  }
  console.log(`\n冒烟测试结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
