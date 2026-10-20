'use strict';
/**
 * ROMKit Windows 单文件打包脚本
 * 产物：dist/ROMKit.exe（Node SEA 单文件，web 资源已内嵌，双击即用）
 * 依赖：esbuild + postject（装在 node 工作区 node_modules）
 * 用法：node tools/build-windows.js
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SEA_DIR = path.join(DIST, 'sea');
const NODE_EXE = process.execPath; // 用当前 node 作为运行时基底
const OUT_EXE = path.join(DIST, 'ROMKit.exe');

// esbuild / postject 从 node 工作区加载
const WORKSPACE = 'C:\\Users\\markx\\.workbuddy\\binaries\\node\\workspace';
const esbuild = require(path.join(WORKSPACE, 'node_modules', 'esbuild'));
const postject = require(path.join(WORKSPACE, 'node_modules', 'postject')).inject;

async function main() {
  const t0 = Date.now();
  await fsp.rm(SEA_DIR, { recursive: true, force: true });
  await fsp.mkdir(SEA_DIR, { recursive: true });

  // ---------- 1. 收集 web 静态资源 ----------
  const webDir = path.join(ROOT, 'web');
  const assets = {};
  let totalSize = 0;
  async function walk(dir, rel = '') {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), r);
      else {
        const buf = await fsp.readFile(path.join(dir, ent.name));
        assets['/' + r] = buf.toString('base64');
        totalSize += buf.length;
      }
    }
  }
  await walk(webDir);
  const names = Object.keys(assets);
  console.log(`[1/5] 内嵌 web 资源 ${names.length} 个文件（${(totalSize / 1024).toFixed(0)} KB）`);

  // ---------- 2. 生成入口并 esbuild 打包 ----------
  const entry = path.join(SEA_DIR, 'entry.js');
  const prelude = [
    '// 由 tools/build-windows.js 自动生成，请勿手改',
    "const __path = require('node:path');",
    '// 数据目录固定放在可执行文件旁边（SEA 下 __dirname 即 exe 所在目录）',
    "process.env.ROMKIT_DATA = process.env.ROMKIT_DATA || __path.join(__dirname, 'data');",
    '// 内嵌 web 资源：rel -> Buffer',
    "globalThis.__ROMKIT_WEB__ = {",
    ...names.map((n) => `  ${JSON.stringify(n)}: Buffer.from(${JSON.stringify(assets[n])}, 'base64'),`),
    '};',
    '// 双击运行（无额外参数）时自动打开浏览器',
    "if (process.argv.length <= 1) process.argv.push('--open');",
    "require('../../server.js');",
  ].join('\n');
  await fsp.writeFile(entry, prelude, 'utf8');

  const bundle = path.join(SEA_DIR, 'server.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const bundleSize = fs.statSync(bundle).size;
  console.log(`[2/5] esbuild 打包完成 server.bundle.js（${(bundleSize / 1024).toFixed(0)} KB）`);

  // ---------- 3. 生成 SEA blob ----------
  const seaConfig = path.join(SEA_DIR, 'sea-config.json');
  await fsp.writeFile(seaConfig, JSON.stringify({
    main: bundle,
    output: path.join(SEA_DIR, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  }, null, 2), 'utf8');
  execFileSync(NODE_EXE, ['--experimental-sea-config', seaConfig], { cwd: ROOT, stdio: 'pipe' });
  const blobSize = fs.statSync(path.join(SEA_DIR, 'sea-prep.blob')).size;
  console.log(`[3/5] SEA blob 生成完成（${(blobSize / 1024 / 1024).toFixed(1)} MB）`);

  // ---------- 4. 注入 node.exe ----------
  await fsp.copyFile(NODE_EXE, OUT_EXE);
  await postject(OUT_EXE, 'NODE_SEA_BLOB', fs.readFileSync(path.join(SEA_DIR, 'sea-prep.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });
  console.log(`[4/5] 已注入：${OUT_EXE}（${(fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1)} MB）`);

  // ---------- 5. 功能自检：隔离端口 + 隔离数据目录实跑一次 ----------
  const { spawn } = require('node:child_process');
  const testPort = 18999;
  const testData = path.join(SEA_DIR, 'testdata');
  await fsp.rm(testData, { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    let lastErr = '';
    const child = spawn(OUT_EXE, [], {
      cwd: SEA_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ROMKIT_PORT: String(testPort), ROMKIT_DATA: testData },
    });
    let childOut = '';
    child.stdout.on('data', (d) => { childOut += d; });
    child.stderr.on('data', (d) => { childOut += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`自检超时：服务未在 60s 内就绪（大体积 exe 首次运行可能被杀毒实时扫描拖慢）\n最后一次错误：${lastErr || '（无）'}\n子进程输出：${childOut.trim() || '（无）'}`));
    }, 60000);
    (async () => {
      for (let i = 0; i < 240; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${testPort}/api/state`);
          if (r.ok) {
            const page = await fetch(`http://127.0.0.1:${testPort}/`);
            const html = await page.text();
            if (!html.includes('ROMKit')) throw new Error('页面内容异常');
            // 写入型验证：POST 一次配置，确认数据目录可写且配置落盘
            // （服务启动时只创建 dats/icons/logs 目录，config.json 仅在设置变更时写入）
            const w = await fetch(`http://127.0.0.1:${testPort}/api/config/ui`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ inboxDir: '__selftest__' }),
            });
            if (!w.ok) throw new Error('配置写入失败 HTTP ' + w.status);
            if (!fs.existsSync(path.join(testData, 'config.json'))) throw new Error('数据目录未创建');
            clearTimeout(timer);
            child.kill();
            console.log(`[5/5] 自检通过：API/页面/配置写入均正常（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
            return resolve();
          }
        } catch (e) { lastErr = e && e.message ? e.message : String(e); }
        await new Promise((r) => setTimeout(r, 250));
      }
      child.kill();
      reject(new Error('自检失败：轮询结束服务仍未就绪，最后一次错误：' + (lastErr || '（无）')));
    })().catch(reject);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('进程提前退出，code=' + code + '\n子进程输出：' + (childOut.trim() || '（无）'))); });
  });
  await fsp.rm(testData, { recursive: true, force: true });

  // ---------- 6. 便携 zip：ROMKit.exe + 使用说明 ----------
  const stage = path.join(SEA_DIR, 'zipstage', 'ROMKit');
  await fsp.rm(path.join(SEA_DIR, 'zipstage'), { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  await fsp.copyFile(OUT_EXE, path.join(stage, 'ROMKit.exe'));
  await fsp.writeFile(path.join(stage, '使用说明.txt'), [
    'ROMKit 使用说明（Windows 便携版）',
    '================================',
    '',
    '一、启动',
    '  双击 ROMKit.exe，稍等 1~2 秒会自动打开浏览器进入界面。',
    '  如果没有自动打开，请手动访问：http://127.0.0.1:8765/',
    '  （若 8765 被占用，程序会自动改用 8766、8767……，以黑色窗口里显示的地址为准）',
    '',
    '二、退出',
    '  直接关闭那个黑色命令行窗口即可退出。',
    '',
    '三、数据保存在哪里',
    '  所有数据（库、清单、设置、图标）都保存在 ROMKit.exe 同一目录下的 data\\ 文件夹里。',
    '  · 换电脑/重装：只要带上整个 data\\ 文件夹，数据就全部跟着走。',
    '  · 想清零重来：退出程序后删掉 data\\ 文件夹即可。',
    '',
    '四、分享给别人',
    '  直接把这一整个文件夹（或压缩包）发出去，对方解压后双击 ROMKit.exe 就能用，',
    '  无需安装 Node.js 或任何其他依赖。',
    '',
    '五、常见问题',
    '  Q1: 杀毒软件报毒怎么办？',
    '      本程序是单文件绿色软件，没有任何网络上传行为。某些杀毒软件对“单文件',
    '      打包的可执行程序”会误报，请在杀毒软件里选择“信任/允许”即可。',
    '  Q2: 浏览器打不开页面？',
    '      请使用 Chrome / Edge / Firefox 等现代浏览器；确认黑色窗口处于打开状态。',
    '  Q3: 端口被占用？',
    '      程序会自动顺延到下一个可用端口，看黑色窗口里打印的地址访问即可。',
    '',
  ].join('\r\n'), 'utf8');
  const zipPath = path.join(DIST, 'ROMKit-Windows-便携版.zip');
  await fsp.rm(zipPath, { force: true });
  // Windows 10+ 自带 tar.exe，-a 按扩展名生成 zip
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
    ['-a', '-c', '-f', zipPath, '-C', path.join(SEA_DIR, 'zipstage'), 'ROMKit'],
    { stdio: 'pipe' });
  const zipSize = fs.statSync(zipPath).size;
  console.log(`[6/6] 便携版已生成：${zipPath}（${(zipSize / 1024 / 1024).toFixed(1)} MB）`);
}

main().catch((e) => { console.error('打包失败：', e); process.exit(1); });
