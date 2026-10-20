# ROMKit 项目交接说明

> 仓库包含**完整可运行的源码和全部测试**，零第三方依赖。
> 构建产物（`dist/`）与个人运行时数据（`data/` 下的真实配置、DAT 清单）都不入库，需要时按第5 节自行生成。

## 1. 环境要求

- **Node.js 18 或更高版本**（推荐 LTS）
- 零第三方依赖 —— `npm install` **不需要执行**，项目只用 Node 内置模块

```bash
node -v   # 确认 >= v18
```

## 2. 跑起来

```bash
# 直接启动
node server.js

# 或者 Windows 下双击 start.bat（会自动找 Node 并开浏览器）
```

启动后访问 http://127.0.0.1:8765
（端口被占用会自动顺延，以控制台打印的地址为准，也可用 `ROMKIT_PORT=9000 node server.js` 指定）

## 3. 目录结构

| 路径 | 说明 |
|------|------|
| `server.js` | 主服务：原生 http + SSE，零依赖；所有 API 路由都在这里 |
| `lib/` | 核心库（详见下表） |
| `web/` | 前端：原生 JS + CSS，无框架、无构建 |
| `fnos/` | fnOS 飞牛 NAS 的原生应用打包配置与运行时脚本 |
| `tools/` | 构建与生成脚本 |
| `tests/` | 测试（全部是零依赖的 node 脚本） |
| `docs/` | 界面截图 |
| `data/` | **运行时生成**，仓库里只有 `config.example.json` 脱敏示例；真实配置与 DAT 清单不入库 |

### lib/ 各模块职责

| 文件 | 职责 |
|------|------|
| `scanner.js` | 扫描 ROM 目录、CRC32 缓存、文件名匹配（`matchByName` 三级策略） |
| `organizer.js` | 整理/重命名逻辑、权限补偿 |
| `store.js` | 配置持久化、分类树与排序模型（`ord`） |
| `covers.js` | 截图/封面的下载与索引 |
| `dat.js` | DAT 解析（兼容 OfflineList 格式）、在线更新源 |
| `naming.js` | 命名模板（`%u %n %g` 等占位符） |
| `zip.js` `crc32.js` | zip 读写、CRC32 计算 |

## 4. 跑测试

所有测试都是独立脚本，直接跑，**不需要测试框架**：

```bash
node tests/selftest.js          # 42 项 基础自检
node tests/naming.test.js       # 111 项 命名模板
node tests/e2e.js               # 23 项 端到端（扫描→整理全流程）
node tests/platform-smoke.js    # 14 项 平台简称映射
node tests/order-smoke.js       # 8 项  分类/清单排序模型
node tests/name-match-smoke.js  # 11 项 文件名匹配
# 还有 category / pending / paths / md-ext / perm / fs-picker / icon
```

每个脚本结尾都会打印 `N 通过 / M 失败`，失败时以非 0 退出码结束，可直接接 CI。

## 5. 构建发布包

```bash
node tools/build-fnos.js      # 生成 dist/ROMKit-fnos-<版本>.fpk（飞牛 NAS）
node tools/build-windows.js   # 生成 dist/ROMKit-Windows-便携版.zip + ROMKit.exe
```

- 构建脚本会自动递增版本号并同步 `server.js` 的 `VERSION` 与 `fnos/manifest`
- 首次构建 fnOS 包需要下载内置 node 运行时（约 235 MB），之后会缓存
- Windows 便携版用 esbuild + Node SEA 打包，依赖在 `tools/` 中有说明

## 6. 常见改动入口

| 想改什么 | 改哪里 |
|---------|--------|
| 界面样式 | `web/style.css` |
| 列表/详情页交互 | `web/app.js`（原生 JS，无框架） |
| 加一个 API | `server.js`，路由用 `p.match(/^\/xxx$/)` 逐段匹配 |
| 扫描/匹配规则 | `lib/scanner.js` |
| 整理/重命名规则 | `lib/organizer.js` + `lib/naming.js` |
| 分类与排序模型 | `lib/store.js`（注意 `ord` 字段与 `flattenGroups` 的前序展开规则） |
| fnOS 专属行为（权限、启动） | `fnos/cmd/`、`fnos/wizard/` |

## 7. 已知的坑（改之前先看一眼）

1. **文件权限**：服务端启动时会 `process.umask(0o022)`，整理落盘后还要再做一次权限补偿，否则在 fnOS 上会出现「文件无法读取」。相关代码在 `lib/organizer.js` 的 `applySourceMode`。
2. **CRC 缓存 key** 统一走 `scanner.js` 导出的 `crcKey()`（`path|size|round(mtimeMs)`），不要自己拼，否则改了文件 mtime 变化后不会重算。
3. **排序模型**：分类树节点和清单都有 `ord`；`flattenGroups()` 是**先递归子分组、再放本组直属清单**，所以子分类的 DAT 排在父分类直属 DAT 之前。改排序时别把这个前序顺序改回去。
4. **`.md` 后缀**：世嘉 MD 的 ROM 是 `.md`，与 Markdown 冲突。忽略文档时只忽略明确的 `README.md` 之类，不能按扩展名一刀切。
5. **前端图标缓存**：清单/分类图标 URL 必须带 `?v=${S.iconStamp}`（或对应戳），否则换了图浏览器会复用旧缓存，看起来像没换成功。
6. **`start.bat` 不要手改**，它由 `tools/gen-startbat.js` 生成（要保证 CRLF + 纯 ASCII）。

## 8. Git 协作约定

`.gitignore` 已经排除 `dist/`、`data/` 下的真实数据与 `.workbuddy/`，直接 clone 即可开工。

**换行符已用 `.gitattributes` 固定**，clone 到任何系统都不会出问题：

| 文件类型 | 换行符 | 原因 |
|---------|-------|------|
| `fnos/cmd/*`、`fnos/wizard/*`、`fnos/config/*` | LF | 要在飞牛 NAS（Linux）上直接执行，CRLF 会导致脚本无法运行 |
| `start.bat` | CRLF | Windows 双击执行 |
| 其余源码 | LF | 跨平台一致 |
| `*.png`、`*.fpk`、`*.exe` 等 | 二进制 | 不做任何转换 |

如果你在 Windows 上开发，**不要手动改这些换行符**，让 git 处理即可。

建议的开发流程：

```bash
git clone <仓库地址> romkit
cd romkit
node server.js            # 先跑起来确认环境 OK
```

- **改完必跑测试**：至少跑 `tests/selftest.js` 和 `tests/e2e.js`；改动排序/匹配/命名时补跑对应的 `*-smoke.js`
- **单独提交**：一个改动一个 commit，message 用中文写清「改了什么 / 为什么」，方便回溯
- **不要提交**：`dist/`、`data/config.json`、`data/dats/`、`data/covers/`、`.workbuddy/`（已被忽略，手动 `git add -f` 也别提交）
- **版本号**：`server.js` 的 `VERSION` 与 `fnos/manifest` 由 `tools/build-fnos.js` 在构建时自动递增，**平时开发不必手动改**

### 代码风格（保持一致）

- 缩进 2 空格，单引号，分号结尾 —— 跟随现有代码
- 缩进层级优先用 `camelCase` 变量与 `function` 声明，少用箭头函数嵌套
- 服务端路由沿用 `p.match(/^\/xxx$/)` 逐段判断的写法，新增时保持同样风格
- 前端是原生 JS，**不要引入任何框架或构建步骤**，这是项目的核心约束

### 提交前自查清单

- [ ] `node tests/selftest.js` 通过
- [ ] `node tests/e2e.js` 通过
- [ ] 新功能有对应测试（参考 `tests/*-smoke.js` 的写法，零依赖、结尾打印 `N 通过 / M 失败`）
- [ ] 没有把本地路径、个人数据、构建产物带进提交
