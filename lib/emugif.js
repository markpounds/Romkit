'use strict';
/**
 * dat.emugif.com 站点数据（发布链接 + 发布说明）。
 *
 * 为什么需要它：OfflineList 的 DAT 里只有标准字段（标题/英文名/厂商/地区/…），
 * 站点详情页上那两个东西 —— 「发布链接」和「发布说明（简介）」—— DAT 里根本没有，
 * 只能从站点自己的接口取。
 *
 * 接口是公开的（列表页自己就在用），POST 表单：
 *   https://dat.emugif.com/api/?action=user_gameList   参数 consoleType / limit / start
 *   https://dat.emugif.com/api/?action=user_datList    机种清单
 *
 * 关联方式：DAT 的 <newDat><datVersionURL> 里带 ?ver=ps2，就是机种号；
 * 拿到机种后整表拉下来（几百条几百 KB），用 ROM 的 CRC 建索引，
 * 实测 DAT 条目 100% 能命中。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const HOST = 'dat.emugif.com';
const SITE = 'https://dat.emugif.com';
const UA = 'ROMKit';
/** 缓存有效期：站点更新不频繁，一周足够；用户也能手动强制刷新 */
const TTL_MS = 7 * 24 * 3600 * 1000;

let dataDirGetter = () => path.join(process.cwd(), 'data');
function setDataDirGetter(fn) {
  if (typeof fn === 'function') dataDirGetter = fn;
}

function cacheDir() {
  return path.join(dataDirGetter(), 'cache', 'emugif');
}

function cacheFile(consoleType) {
  return path.join(cacheDir(), String(consoleType || 'x').replace(/[^\w-]/g, '_') + '.json');
}

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': UA, ...(headers || {}) }, timeout: 20000 },
      (res) => {
        // B 站封面图偶尔会 302，跟一次
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpsGet(new URL(res.headers.location, url).href, headers).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** B 站公开信息接口，返回 data.pic 等字段，无需登录 */
const BILI_VIEW = 'https://api.bilibili.com/x/web-interface/view?bvid=';
const BILI_HEADERS = { Referer: 'https://www.bilibili.com/', Accept: '*/*' };

/**
 * 抓 B 站视频封面：view 接口拿 pic，再下载图片本体。
 * 图片 CDN 有防盗链，必须带 bilibili 的 Referer —— 所以由服务端代理，
 * 前端直接 <img> 引 B 站地址会被 403。
 */
async function fetchBiliCover(bvid) {
  const raw = await httpsGet(BILI_VIEW + encodeURIComponent(bvid), BILI_HEADERS);
  let meta;
  try {
    meta = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error('B 站接口返回无法解析');
  }
  const pic = meta && meta.data && meta.data.pic;
  if (!pic) throw new Error(meta && meta.message ? meta.message : '没有封面地址');
  return httpsGet(String(pic).replace(/^http:/, 'https:'), BILI_HEADERS);
}

/**
 * B 站视频基础信息（时长 / 封面地址）。
 * 用途：嵌入式播放器不回传连续播放进度（拿不到 currentTime），
 * 前端用真实时长做"估算进度条"，让用户始终能看到一条在走的进度条。
 * 时长来自 view 接口的 data.duration（秒）。
 */
async function fetchBiliInfo(bvid) {
  const raw = await httpsGet(BILI_VIEW + encodeURIComponent(bvid), BILI_HEADERS);
  let meta;
  try {
    meta = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error('B 站接口返回无法解析');
  }
  const d = (meta && meta.data) || {};
  if (!d.bvid) throw new Error(meta && meta.message ? meta.message : '没有这个视频');
  const pic = d.pic ? String(d.pic).replace(/^http:/, 'https:') : null;
  if (!pic) throw new Error('没有封面地址');
  return { duration: Number(d.duration) || 0, pic };
}

/** 按文件头认图片类型（B 站可能回 jpg / webp / png） */
function sniffImg(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp';
  return null;
}

function postForm(action, form) {
  const body = Buffer.from(
    Object.keys(form || {})
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k]))
      .join('&')
  );
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path: '/api/?action=' + action,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': body.length,
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Referer: SITE + '/',
          Origin: SITE,
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error('站点返回 ' + res.statusCode));
          let j;
          try {
            j = JSON.parse(text);
          } catch (e) {
            return reject(new Error('站点返回内容无法解析'));
          }
          if (j.code !== 200) return reject(new Error(typeof j.data === 'string' ? j.data : '站点返回错误 ' + j.code));
          resolve(j.data || {});
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求站点超时')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 从 DAT 里认出这是不是 emugif 的数据、以及是哪个机种。
 * 两个线索：datVersionURL 的 ?ver=xx；imURL 的 /img/xx/。
 */
function consoleTypeOf(dat) {
  const nd = dat && dat.newDat;
  if (!nd) return null;
  const vu = String(nd.datVersionURL || '');
  let m = vu.match(/[?&]ver=([^&]+)/i);
  if (m && m[1]) return m[1].toLowerCase();
  const iu = String(nd.imURL || '');
  m = iu.match(/\/img\/([^/]+)\/?/i);
  if (m && m[1]) return m[1].toLowerCase();
  return null;
}

/** 该 DAT 的数据源是不是 emugif（不是就不该去拉） */
function isEmugif(dat) {
  const nd = dat && dat.newDat;
  if (!nd) return false;
  const s = String(nd.datVersionURL || '') + ' ' + String(nd.datURL || '') + ' ' + String(nd.imURL || '');
  return /emugif\.com/i.test(s);
}

/** 站点上有哪些机种（用于提示"这个库能不能取"） */
async function fetchConsoles(force) {
  const file = path.join(cacheDir(), '_consoles.json');
  if (!force) {
    try {
      const j = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Date.now() - (j.fetchedAt || 0) < TTL_MS) return j.items || [];
    } catch (_) {}
  }
  const data = await postForm('user_datList', { publish: '' });
  const items = (data.items || []).map((x) => ({
    consoleType: x.title,
    datName: x.datName || '',
    system: x.system || '',
    gameCount: Number(x.gameCount || 0),
  }));
  await fsp.mkdir(cacheDir(), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ fetchedAt: Date.now(), items })).catch(() => {});
  return items;
}

/** 全量拉一个机种，精简后落盘 */
async function fetchConsole(consoleType, force) {
  const ct = String(consoleType || '').toLowerCase();
  if (!ct) throw new Error('缺少机种标识');
  const file = cacheFile(ct);
  if (!force) {
    try {
      const j = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (j && Array.isArray(j.items) && Date.now() - (j.fetchedAt || 0) < TTL_MS) return j;
    } catch (_) {}
  }
  const data = await postForm('user_gameList', { consoleType: ct, limit: 5000, start: 0 });
  const raw = data.items || [];
  const items = raw.map((it) => ({
    id: it.id,
    releaseNumber: it.releaseNumber || '',
    title: it.title || '',
    orgTitle: it.orgTitle || '',
    comment: it.comment || '',
    links: [it.link1, it.link2, it.link3, it.link4].filter((x) => x && String(x).trim()),
    im1CRC: up(it.im1CRC),
    im2CRC: up(it.im2CRC),
    crcs: (it.roms || []).map((r) => up(r.romCRC)).filter(Boolean),
    publisher: it.publisher || '',
    sourceRom: it.sourceRom || '',
    updateTime: Number(it.updateTime || 0),
  }));
  const payload = { consoleType: ct, fetchedAt: Date.now(), total: Number(data.total || items.length), items };
  await fsp.mkdir(cacheDir(), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(payload)).catch(() => {});
  return payload;
}

/** 读缓存（不联网）。没缓存返回 null */
async function readCache(consoleType) {
  const ct = String(consoleType || '').toLowerCase();
  if (!ct) return null;
  try {
    const j = JSON.parse(await fsp.readFile(cacheFile(ct), 'utf8'));
    if (j && Array.isArray(j.items)) return j;
  } catch (_) {}
  return null;
}

/** 用 CRC / 封面 CRC 建索引，一条 DAT 条目只要有一个 CRC 对上就算命中 */
function buildIndex(payload) {
  const byCrc = new Map();
  const byIm = new Map();
  for (const it of (payload && payload.items) || []) {
    for (const c of it.crcs || []) if (c && !byCrc.has(c)) byCrc.set(c, it);
    if (it.im1CRC && !byIm.has(it.im1CRC)) byIm.set(it.im1CRC, it);
  }
  return { byCrc, byIm };
}

/**
 * 给一条 DAT 条目找站点数据。合并条目的子条目各自有 CRC，
 * 所以传进来的可以是父条目也可以是子条目 —— 只看 CRC。
 */
function lookup(index, game) {
  if (!index || !game) return null;
  const crcs = (game.crcs || []).map((c) => up(c && (c.crc || c))).filter(Boolean);
  for (const c of crcs) {
    const hit = index.byCrc.get(c);
    if (hit) return hit;
  }
  const im = up(game.im1CRC);
  if (im && index.byIm.has(im)) return index.byIm.get(im);
  return null;
}

/** 站点详情页地址，方便用户点过去看原页面 */
function pageUrl(item, consoleType) {
  if (!item || !item.id) return '';
  const ct = String(consoleType || '').toLowerCase();
  return SITE + '/html/game-edit.html?id=' + encodeURIComponent(item.id) + '&mode=info&consoleType=' + encodeURIComponent(ct);
}

/**
 * 把站点信息整理成前端直接能用的形状。
 * 有链接/简介才返回，避免详情页挂一片空白区块。
 */
function present(item, consoleType) {
  if (!item) return null;
  const links = (item.links || []).filter(Boolean);
  const comment = String(item.comment || '').trim();
  if (!links.length && !comment) return null;
  return {
    links,
    comment,
    updateTime: item.updateTime || 0,
    releaseNumber: item.releaseNumber || '',
    orgTitle: item.orgTitle || '',
    url: pageUrl(item, consoleType),
  };
}

/**
 * 给一整张条目表算出站点信息，按 index 出表（父条目、以及合并条目里
 * 被吃掉的每个子条目，各算各的 —— 子条目仍要能显示各自的发布说明）。
 * 刻意不改 games 里的对象：扫描结果是要落盘缓存的，把外部站点数据混进去
 * 会让缓存随站点变化而失真。
 */
function collect(games, index, consoleType) {
  const sites = {};
  const stat = { matched: 0, withLink: 0, withComment: 0 };
  if (!index) return { sites, ...stat };
  for (const g of games || []) {
    const targets = [[g.index, g]];
    for (const k of g.children || []) if (k && k.index != null) targets.push([k.index, k]);
    let got = false;
    for (const [idx, obj] of targets) {
      if (idx == null) continue;
      const s = present(lookup(index, obj), consoleType);
      if (!s) continue;
      sites[idx] = s;
      if (s.links.length) stat.withLink++;
      if (s.comment) stat.withComment++;
      got = true;
    }
    if (got) stat.matched++;
  }
  return { sites, ...stat };
}

module.exports = {
  setDataDirGetter,
  cacheDir,
  consoleTypeOf,
  isEmugif,
  fetchConsoles,
  fetchConsole,
  readCache,
  buildIndex,
  lookup,
  present,
  pageUrl,
  collect,
  fetchBiliCover,
  fetchBiliInfo,
  sniffImg,
  TTL_MS,
};
