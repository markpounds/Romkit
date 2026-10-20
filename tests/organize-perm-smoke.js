/* 整理权限预检冒烟测试
 *
 * 飞牛上「目录只给了读权限」极常见。期望行为：
 *   ① 输出目录不可写 → 整个任务直接失败，并明确指出是哪个目录
 *   ② 备份/重复副本目录不可写 → 只跳过受影响的条目，其余照常整理
 *      （不能让 8 条权限问题毁掉几百条能成功的整理）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const organizer = require('../lib/organizer');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' → ' + extra}`);
};

const TMP = path.join(os.tmpdir(), 'romkit-perm2-' + Date.now());
const IS_WIN = process.platform === 'win32';

/** 造一个只读目录（Windows 上 chmod 不生效，用占位文件模拟不可写） */
async function makeReadOnlyDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  if (!IS_WIN) await fsp.chmod(dir, 0o555);
  return dir;
}
async function restoreDir(dir) {
  if (!IS_WIN) await fsp.chmod(dir, 0o755).catch(() => {});
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n[1] 输出目录不可写 → 立刻失败并指出目录');
  {
    const rom = path.join(TMP, 'rom1');
    const out = path.join(TMP, 'out1');
    await fsp.mkdir(rom, { recursive: true });
    await fsp.mkdir(out, { recursive: true });
    // 用一个同名文件堵住输出目录路径，制造不可写/不可建的情形
    const blockedOut = path.join(TMP, 'blocked-out');
    await fsp.writeFile(blockedOut, 'not a dir');

    const src = path.join(rom, 'a.gg');
    await fsp.writeFile(src, 'x');
    const plan = {
      outDir: path.join(blockedOut, 'sub'),
      items: [{
        game: { index: 1, title: 'A' }, action: 'copy-file', dest: path.join(blockedOut, 'sub', 'A.gg'),
        source: { path: src, container: 'file', size: 1, relPath: 'a.gg' }, size: 1,
      }],
    };
    let err = null;
    try {
      await organizer.executePlan({ id: 'l1', settings: { operation: 'copy', mode: 'raw' } }, plan, {});
    } catch (e) { err = e; }
    ok('抛出错误而不是静默', !!err, err ? err.message.slice(0, 60) : '未抛错');
    ok('错误信息点名输出目录', !!err && err.message.includes('输出目录'), err ? err.message.slice(0, 80) : '');
    ok('错误信息带权限指引', !!err && /读写权限/.test(err.message), err ? err.message.slice(0, 80) : '');
  }

  console.log('\n[2] 备份目录不可写 → 只跳过相关条目，其余照常整理');
  if (IS_WIN) {
    // Windows 上 chmod 对目录基本无效，用「目标路径上放同名文件」模拟目标不可建
    const rom = path.join(TMP, 'rom2');
    const out = path.join(TMP, 'out2');
    const badBackup = path.join(TMP, 'backup2');
    await fsp.mkdir(rom, { recursive: true });
    await fsp.mkdir(out, { recursive: true });
    await fsp.mkdir(badBackup, { recursive: true });
    // 把备份目录里「同名子目录」做成文件，让它无法作为目录写入
    const blockedChild = path.join(badBackup, 'blocked');
    await fsp.writeFile(blockedChild, 'x');

    const goodSrc = path.join(rom, 'good.gg');
    const badSrc = path.join(rom, 'bad.gg');
    await fsp.writeFile(goodSrc, 'good-content');
    await fsp.writeFile(badSrc, 'bad-content');

    const plan = {
      outDir: out,
      items: [
        {
          game: { index: 1, title: 'Good' }, action: 'copy-file', dest: path.join(out, 'Good.gg'),
          source: { path: goodSrc, container: 'file', size: 12, relPath: 'good.gg' }, size: 12,
        },
        {
          game: { index: 2, title: 'Bad' }, action: 'move-unmatched',
          dest: path.join(blockedChild, 'bad.gg'),
          source: { path: badSrc, container: 'file', size: 11, relPath: 'bad.gg' }, size: 11, unmatched: true,
        },
      ],
    };
    const res = await organizer.executePlan({ id: 'l2', settings: { operation: 'copy', mode: 'raw' } }, plan, {});
    ok('好条目仍然整理成功', fs.existsSync(path.join(out, 'Good.gg')), '文件不存在');
    ok('不可写目录被记录下来', Array.isArray(res.blockedDirs) && res.blockedDirs.length === 1,
      JSON.stringify(res.blockedDirs));
    ok('受影响的条目被跳过而不是记为失败', res.skipped === 1 && res.failed === 0,
      JSON.stringify({ skipped: res.skipped, failed: res.failed }));
    ok('源文件没有被误删', fs.existsSync(badSrc), '源文件不见了');
  } else {
    const rom = path.join(TMP, 'rom2');
    const out = path.join(TMP, 'out2');
    const badBackup = path.join(TMP, 'backup2');
    await fsp.mkdir(rom, { recursive: true });
    await fsp.mkdir(out, { recursive: true });
    await makeReadOnlyDir(badBackup);

    const goodSrc = path.join(rom, 'good.gg');
    const badSrc = path.join(rom, 'bad.gg');
    await fsp.writeFile(goodSrc, 'good-content');
    await fsp.writeFile(badSrc, 'bad-content');

    const plan = {
      outDir: out,
      items: [
        {
          game: { index: 1, title: 'Good' }, action: 'copy-file', dest: path.join(out, 'Good.gg'),
          source: { path: goodSrc, container: 'file', size: 12, relPath: 'good.gg' }, size: 12,
        },
        {
          game: { index: 2, title: 'Bad' }, action: 'move-unmatched',
          dest: path.join(badBackup, 'bad.gg'),
          source: { path: badSrc, container: 'file', size: 11, relPath: 'bad.gg' }, size: 11, unmatched: true,
        },
      ],
    };
    const res = await organizer.executePlan({ id: 'l2', settings: { operation: 'copy', mode: 'raw' } }, plan, {});
    await restoreDir(badBackup);
    ok('好条目仍然整理成功', fs.existsSync(path.join(out, 'Good.gg')), '文件不存在');
    ok('不可写目录被记录下来', Array.isArray(res.blockedDirs) && res.blockedDirs.length === 1,
      JSON.stringify(res.blockedDirs));
    ok('受影响的条目被跳过而不是记为失败', res.skipped === 1 && res.failed === 0,
      JSON.stringify({ skipped: res.skipped, failed: res.failed }));
    ok('源文件没有被误删', fs.existsSync(badSrc), '源文件不见了');
  }

  console.log('\n[3] 全部可写时不应误报');
  {
    const rom = path.join(TMP, 'rom3');
    const out = path.join(TMP, 'out3');
    await fsp.mkdir(rom, { recursive: true });
    await fsp.mkdir(out, { recursive: true });
    const s1 = path.join(rom, 'x.gg');
    await fsp.writeFile(s1, 'x-content');
    const plan = {
      outDir: out,
      items: [{
        game: { index: 1, title: 'X' }, action: 'copy-file', dest: path.join(out, 'X.gg'),
        source: { path: s1, container: 'file', size: 9, relPath: 'x.gg' }, size: 9,
      }],
    };
    const res = await organizer.executePlan({ id: 'l3', settings: { operation: 'copy', mode: 'raw' } }, plan, {});
    ok('没有 blockedDirs', (res.blockedDirs || []).length === 0, JSON.stringify(res.blockedDirs));
    ok('没有跳过也没有失败', res.skipped === 0 && res.failed === 0,
      JSON.stringify({ skipped: res.skipped, failed: res.failed }));
    ok('文件已生成', fs.existsSync(path.join(out, 'X.gg')));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
