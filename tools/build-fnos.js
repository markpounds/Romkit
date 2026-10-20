'use strict';
/**
 * ROMKit 飞牛 fnOS 原生应用（.fpk）打包脚本
 * 产物：dist/ROMKit-fnos-<version>.fpk（platform=all，内置 x64/arm64 双架构 node）
 * 依赖：dist/dl/fnpack.exe + dist/dl/node-linux-{x64,arm64}.tar.xz（tools/fetch-fnos-deps.js 下载）
 * 用法：
 *   node tools/build-fnos.js            自动递增版本号（修订位）后打包
 *   node tools/build-fnos.js --no-bump  沿用当前版本号打包
 * 自动升版本是为了方便在 fnOS 上直接「覆盖安装」 updates（版本号相同无法覆盖安装）。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FNOS_SRC = path.join(ROOT, 'fnos');
const DL_DIR = path.join(DIST, 'dl');
const FNPACK = path.join(DL_DIR, 'fnpack.exe');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const STAGE = path.join(DIST, 'fpk-src', 'romkit');

function fail(msg) { console.error('打包失败：', msg); process.exit(1); }

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

async function main() {
  // ---------- 0. 前置检查 ----------
  if (!fs.existsSync(FNPACK)) fail(`缺少 fnpack：${FNPACK}`);
  const x64Tar = path.join(DL_DIR, 'node-linux-x64.tar.xz');
  const armTar = path.join(DL_DIR, 'node-linux-arm64.tar.xz');
  if (!fs.existsSync(x64Tar) || !fs.existsSync(armTar)) fail('缺少 node linux 压缩包（dist/dl/）');

  // ---------- 0a. 版本号：默认递增修订位，便于 fnOS 覆盖安装 ----------
  const noBump = process.argv.includes('--no-bump') || !!process.env.ROMKIT_NO_BUMP;
  const SERVER_JS = path.join(ROOT, 'server.js');
  const readVersion = () => {
    const m = fs.readFileSync(SERVER_JS, 'utf8').match(/const VERSION = '([^']+)'/);
    return m ? m[1] : null;
  };
  const writeVersion = (v) => {
    fs.writeFileSync(SERVER_JS,
      fs.readFileSync(SERVER_JS, 'utf8').replace(/const VERSION = '[^']*'/, `const VERSION = '${v}'`), 'utf8');
  };
  const cur = readVersion();
  if (!cur) fail('无法从 server.js 读取 VERSION');
  let version = cur;
  if (!noBump) {
    const parts = cur.split('.').map((n) => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    parts[2] += 1; // 递增修订位：2.14.0 -> 2.14.1
    version = parts.join('.');
    writeVersion(version);
    console.log(`版本递增：${cur} -> ${version}（可在 fnOS 上覆盖安装；如需沿用当前版本加 --no-bump）`);
  } else {
    console.log(`版本：${version}（--no-bump，沿用当前版本）`);
  }
  // fnos/manifest 里的 version 跟随 server.js
  const manifestPath = path.join(FNOS_SRC, 'manifest');
  const mf = fs.readFileSync(manifestPath, 'utf8');
  if (!mf.match(new RegExp(`version\\s*=\\s*${version.replace(/\./g, '\\.')}\\b`))) {
    fs.writeFileSync(manifestPath, mf.replace(/version\s*=\s*[^\n]*/, `version               = ${version}`), 'utf8');
    console.log(`manifest 版本同步为 ${version}`);
  }

  // ---------- 1. 校验 fnos 源结构 ----------
  const required = [
    'manifest', 'config/privilege', 'config/resource',
    'ICON.PNG', 'ICON_256.PNG', 'app/ui/config',
    'cmd/main', 'cmd/install_init', 'cmd/install_callback',
    'cmd/upgrade_init', 'cmd/upgrade_callback',
    'cmd/uninstall_init', 'cmd/uninstall_callback',
    'cmd/config_init', 'cmd/config_callback',
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(FNOS_SRC, rel))) fail(`fnos 源缺少：${rel}`);
  }
  fs.mkdirSync(path.join(FNOS_SRC, 'wizard'), { recursive: true });
  for (const ico of ['ICON.PNG', 'ICON_256.PNG']) {
    if (fs.statSync(path.join(FNOS_SRC, ico)).size < 500) fail(`${ico} 疑似空文件，请先运行 node tools/gen-fnos-icons.js`);
  }

  // manifest 的 service_port 必须与 app/ui/config 的 port 一致
  const manifest = fs.readFileSync(path.join(FNOS_SRC, 'manifest'), 'utf8');
  const mPort = (manifest.match(/service_port\s*=\s*(\d+)/) || [])[1];
  const uiCfg = JSON.parse(fs.readFileSync(path.join(FNOS_SRC, 'app/ui/config'), 'utf8'));
  const uPort = Object.values(uiCfg['.url'])[0].port;
  if (!mPort || String(uPort) !== String(mPort)) fail(`端口不一致：manifest=${mPort} ui/config=${uPort}`);
  console.log(`服务端口：${mPort}（manifest 与桌面入口一致）`);

  // ---------- 2. 组装暂存目录 ----------
  await fsp.rm(path.join(DIST, 'fpk-src'), { recursive: true, force: true });
  await fsp.mkdir(STAGE, { recursive: true });
  await copyDir(FNOS_SRC, STAGE);
  // 应用代码（不含开发数据）
  await fsp.copyFile(path.join(ROOT, 'server.js'), path.join(STAGE, 'app', 'server.js'));
  await copyDir(path.join(ROOT, 'lib'), path.join(STAGE, 'app', 'lib'));
  await copyDir(path.join(ROOT, 'web'), path.join(STAGE, 'app', 'web'));

  // ---------- 3. 就位双架构 node 二进制（带缓存） ----------
  const cacheDir = path.join(DL_DIR, 'nx');
  async function ensureNode(tar, inner, outName) {
    const cached = path.join(cacheDir, inner, 'bin', 'node');
    if (!fs.existsSync(cached)) {
      await fsp.mkdir(cacheDir, { recursive: true });
      console.log(`解压 ${path.basename(tar)} ...`);
      execFileSync(TAR, ['-xJf', tar, '-C', cacheDir, inner + '/bin/node'], { stdio: 'pipe' });
    }
    const dst = path.join(STAGE, 'app', 'bin', outName);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(cached, dst);
    try { fs.chmodSync(dst, 0o755); } catch (_) {}
    console.log(`内置 node：${outName}（${(fs.statSync(dst).size / 1024 / 1024).toFixed(0)} MB）`);
  }
  await ensureNode(x64Tar, 'node-v22.22.2-linux-x64', 'node-x64');
  await ensureNode(armTar, 'node-v22.22.2-linux-arm64', 'node-arm64');

  // ---------- 4. fnpack 构建 ----------
  console.log('运行 fnpack build ...');
  execFileSync(FNPACK, ['build', '-d', STAGE], { cwd: DIST, stdio: 'inherit' });

  // ---------- 5. 归位产物 ----------
  const fpkFiles = fs.readdirSync(DIST).filter((f) => f.toLowerCase().endsWith('.fpk'))
    .map((f) => ({ f, t: fs.statSync(path.join(DIST, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!fpkFiles.length) fail('fnpack 未生成 .fpk 文件');
  const src = path.join(DIST, fpkFiles[0].f);
  const out = path.join(DIST, `ROMKit-fnos-${version}.fpk`);
  if (src !== out) {
    await fsp.rm(out, { force: true });
    await fsp.rename(src, out);
  }
  console.log(`\n完成：${out}（${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB）`);
  console.log('安装：fnOS 应用中心 → 手动安装 → 选择此 .fpk');
}

main().catch((e) => fail(e && e.message ? e.message : e));
