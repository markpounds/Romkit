#!/usr/bin/env node
/**
 * 打包一份可直接交接给别人的 ROMKit 源码包。
 *
 * 排除：
 *   - dist/            构建产物（.fpk / exe / 内置 node），几十~上百 MB，可由 tools/ 重新构建
 *   - data/ 里的运行时数据  你的本地路径、DAT 清单、CRC 缓存、日志 —— 涉及隐私且体积大
 *   - .workbuddy/      会话记忆，不属于项目
 *   - 各类缓存/临时文件
 *
 * 保留：
 *   - 全部源码（server.js / lib / web / fnos / tools / tests）
 *   - README.md 与 docs 截图
 *   - data/config.json 替换成一份脱敏的示例
 *   - 新增 .gitignore，方便接手的人直接 git init
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NAME = 'ROMKit-source';
const STAGE = path.join(ROOT, '..', '.romkit-share-staging');

// 需要排除的目录与文件
const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', '.workbuddy', 'dl', 'sea', 'fpk-src', 'covers', 'cache', 'logs', 'icons', 'dats', '.romkit-share-staging']);
const SKIP_FILES = new Set(['start.log', 'crc-cache.json', '.DS_Store', 'Thumbs.db', 'ROMKit.exe', 'fnpack.exe']);

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const sp = path.join(src, name);
    const dp = path.join(dest, name);
    const st = fs.statSync(sp);
    if (st.isDirectory()) {
      if (filter.dir(name)) continue;
      copyDir(sp, dp, filter);
    } else if (st.isFile()) {
      if (filter.file(name)) continue;
      fs.copyFileSync(sp, dp);
    }
  }
}

/** 生成脱敏示例配置：保留结构，清空本地路径与清单内容 */
function sampleConfig() {
  return {
    version: 1,
    libraries: [],
    settings: {
      datDir: '',
      coverDir: '',
      dataDir: '',
      downloadCovers: false,
      coverSource: 'remote',
    },
    categories: [],
    _说明: '这是示例配置，请改成你自己的路径。首次启动后程序会自动补齐字段。',
  };
}

function main() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 1) 拷源码
  // 注意：data/ 下的真实配置/DAT 清单绝不能进包，靠白名单而不是黑名单来保证
  const filter = {
    dir: (n) => SKIP_DIRS.has(n),
    file: (n) => SKIP_FILES.has(n) || n.endsWith('.log'),
  };
  // data 不在这里拷贝，见第 2 步
  for (const d of ['lib', 'web', 'fnos', 'tools', 'tests', 'docs']) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) copyDir(src, path.join(STAGE, d), filter);
  }
  for (const f of ['server.js', 'README.md', 'HANDOVER.md', 'start.bat', '.gitignore', '.gitattributes']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
  }

  // 2) 脱敏示例配置
  // data/ 整体不从源目录拷贝，只重建空骨架 —— 真实 config.json 里有本地盘路径，
  // DAT 清单和CRC 缓存也不该外泄
  const dataDir = path.join(STAGE, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.example.json'), JSON.stringify(sampleConfig(), null, 2), 'utf8');
  for (const d of ['covers', 'icons', 'dats', 'cache', 'logs']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });

  // 兜底自检：包里绝不能出现真实配置或DAT
  for (const f of ['config.json', 'crc-cache.json']) {
    if (fs.existsSync(path.join(STAGE, 'data', f))) {
      throw new Error(`打包中止：data/${f} 是个人数据，不应出现在交接包中`);
    }
  }
  const strayDats = fs.readdirSync(path.join(STAGE, 'data', 'dats'));
  if (strayDats.length) {
    throw new Error(`打包中止：data/dats/ 非空（${strayDats.length} 个文件），可能含个人 DAT 清单`);
  }

  // 3) .gitignore
  fs.writeFileSync(path.join(STAGE, '.gitignore'), [
    '# 构建产物（体积大，可由 tools/ 重新生成）',
    'dist/',
    'fnos/deps/',
    'node_modules/',
    '',
    '# 运行时数据（含本地路径与 DAT 清单，不要提交）',
    'data/config.json',
    'data/dats/',
    'data/covers/',
    'data/icons/',
    'data/cache/',
    'data/logs/',
    'data/*.log',
    'data/crc-cache.json',
    '',
    '# 编辑器/系统',
    '.workbuddy/',
    '.DS_Store',
    'Thumbs.db',
    '*.tmp',
  ].join('\n'), 'utf8');

  // 4) 交接说明
  fs.writeFileSync(path.join(STAGE, 'HANDOVER.md'), handoverDoc(), 'utf8');

  // 5) 压缩
  const out = path.join(ROOT, '..', `${NAME}.zip`);
  fs.rmSync(out, { force: true });
  const stagingRoot = path.join(ROOT, '..');
  // Windows 的 Compress-Archive 会把整个 staging 目录塞进去，先移到临时父目录
  const tmpParent = path.join(stagingRoot, `${NAME}`);
  fs.rmSync(tmpParent, { recursive: true, force: true });
  fs.renameSync(STAGE, tmpParent);
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${tmpParent}' -DestinationPath '${out}' -Force`], { stdio: 'inherit' });
  fs.rmSync(tmpParent, { recursive: true, force: true });

  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`完成：${out}（${mb} MB）`);
}

function handoverDoc() {
  return `# ROMKit 项目交接说明

> 这份压缩包包含**完整可运行的源码和全部测试**，不含任何构建产物与个人数据。

## 1. 环境要求

- **Node.js 18 或更高版本**（推荐 LTS）
- 零第三方依赖 —— \`npm install\` **不需要执行**，项目只用 Node 内置模块

\`\`\`bash
node -v   # 确认 >= v18
\`\`\`

## 2. 跑起来

\`\`\`bash
# 直接启动
node server.js

# 或者 Windows 下双击 start.bat（会自动找 Node 并开浏览器）
\`\`\`

启动后访问 http://127.0.0.1:8765
（端口被占用会自动顺延，以控制台打印的地址为准，也可用 \`ROMKIT_PORT=9000 node server.js\` 指定）

## 3. 目录结构

| 路径 | 说明 |
|------|------|
| \`server.js\` | 主服务：原生 http + SSE，零依赖；所有 API 路由都在这里 |
| \`lib/\` | 核心库（详见下表） |
| \`web/\` | 前端：原生 JS + CSS，无框架、无构建 |
| \`fnos/\` | fnOS 飞牛 NAS 的原生应用打包配置与运行时脚本 |
| \`tools/\` | 构建与生成脚本 |
| \`tests/\` | 测试（全部是零依赖的 node 脚本） |
| \`docs/\` | 界面截图 |
| \`data/\` | **运行时生成**，已放入脱敏示例配置；真实数据不入库 |

### lib/ 各模块职责

| 文件 | 职责 |
|------|------|
| \`scanner.js\` | 扫描 ROM 目录、CRC32 缓存、文件名匹配（\`matchByName\` 三级策略） |
| \`organizer.js\` | 整理/重命名逻辑、权限补偿 |
| \`store.js\` | 配置持久化、分类树与排序模型（\`ord\`） |
| \`covers.js\` | 截图/封面的下载与索引 |
| \`dat.js\` | DAT 解析（兼容 OfflineList 格式）、在线更新源 |
| \`naming.js\` | 命名模板（\`%u %n %g\` 等占位符） |
| \`zip.js\` \`crc32.js\` | zip 读写、CRC32 计算 |

## 4. 跑测试

所有测试都是独立脚本，直接跑，**不需要测试框架**：

\`\`\`bash
node tests/selftest.js          # 42 项 基础自检
node tests/naming.test.js       # 111 项 命名模板
node tests/e2e.js               # 23 项 端到端（扫描→整理全流程）
node tests/platform-smoke.js    # 14 项 平台简称映射
node tests/order-smoke.js       # 8 项  分类/清单排序模型
node tests/name-match-smoke.js  # 11 项 文件名匹配
# 还有 category / pending / paths / md-ext / perm / fs-picker / icon
\`\`\`

每个脚本结尾都会打印 \`N 通过 / M 失败\`，失败时以非 0 退出码结束，可直接接 CI。

## 5. 构建发布包

\`\`\`bash
node tools/build-fnos.js      # 生成 dist/ROMKit-fnos-<版本>.fpk（飞牛 NAS）
node tools/build-windows.js   # 生成 dist/ROMKit-Windows-便携版.zip + ROMKit.exe
\`\`\`

- 构建脚本会自动递增版本号并同步 \`server.js\` 的 \`VERSION\` 与 \`fnos/manifest\`
- 首次构建 fnOS 包需要下载内置 node 运行时（约 235 MB），之后会缓存
- Windows 便携版用 esbuild + Node SEA 打包，依赖在 \`tools/\` 中有说明

## 6. 常见改动入口

| 想改什么 | 改哪里 |
|---------|--------|
| 界面样式 | \`web/style.css\` |
| 列表/详情页交互 | \`web/app.js\`（原生 JS，无框架） |
| 加一个 API | \`server.js\`，路由用 \`p.match(/^\\/xxx$/)\` 逐段匹配 |
| 扫描/匹配规则 | \`lib/scanner.js\` |
| 整理/重命名规则 | \`lib/organizer.js\` + \`lib/naming.js\` |
| 分类与排序模型 | \`lib/store.js\`（注意 \`ord\` 字段与 \`flattenGroups\` 的前序展开规则） |
| fnOS 专属行为（权限、启动） | \`fnos/cmd/\`、\`fnos/wizard/\` |

## 7. 已知的坑（改之前先看一眼）

1. **文件权限**：服务端启动时会 \`process.umask(0o022)\`，整理落盘后还要再做一次权限补偿，否则在 fnOS 上会出现「文件无法读取」。相关代码在 \`lib/organizer.js\` 的 \`applySourceMode\`。
2. **CRC 缓存 key** 统一走 \`scanner.js\` 导出的 \`crcKey()\`（\`path|size|round(mtimeMs)\`），不要自己拼，否则改了文件 mtime 变化后不会重算。
3. **排序模型**：分类树节点和清单都有 \`ord\`；\`flattenGroups()\` 是**先递归子分组、再放本组直属清单**，所以子分类的 DAT 排在父分类直属 DAT 之前。改排序时别把这个前序顺序改回去。
4. **\`.md\` 后缀**：世嘉 MD 的 ROM 是 \`.md\`，与 Markdown 冲突。忽略文档时只忽略明确的 \`README.md\` 之类，不能按扩展名一刀切。
5. **前端图标缓存**：清单/分类图标 URL 必须带 \`?v=\${S.iconStamp}\`（或对应戳），否则换了图浏览器会复用旧缓存，看起来像没换成功。
6. **\`start.bat\` 不要手改**，它由 \`tools/gen-startbat.js\` 生成（要保证 CRLF + 纯 ASCII）。
`;
}

if (require.main === module) main();
module.exports = { main };
