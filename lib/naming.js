'use strict';
/**
 * 命名模板引擎 —— 语法与 OfflineList 的「命名」设置保持一致
 *
 *   %n 游戏名称    %p 发行厂商    %i 容量大小    %u 游戏编号    %c CRC
 *   %o 发行国家    %g 发布来源    %s 存档类型    %e 备注        %a 语言
 *
 * 同时兼容本工具早期的 {title} 写法（老配置不必改）。
 * 默认模板：%u - %n [%g]
 */

const REGION_RE = /^(USA|Europe|Japan|China|Korea|Taiwan|Hong Kong|Australia|Germany|France|Spain|Italy|Brazil|World|Asia|Netherlands|Sweden|Canada)$/i;
const LANG_RE = /^(CHS|CHT|Chinese|China|En|Ja|Fr|De|Es|It|Ko|Zh|AI|简|繁|简中|繁中)$/i;

function fmtShortSize(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + 'MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '') + 'GB';
}

/** 从 comment 的 (Japan) [CHS] 标签里取地区 / 语言，取不到就退回字段原值 */
function regionOf(game) {
  const tags = game.tags || [];
  const hit = tags.find((t) => REGION_RE.test(t.trim()));
  if (hit) return hit.trim();
  return game.location != null && game.location !== '' ? String(game.location) : '';
}

function languageOf(game) {
  const tags = game.tags || [];
  const hit = tags.find((t) => LANG_RE.test(t.trim()));
  if (hit) return hit.trim();
  return game.language != null && game.language !== '' ? String(game.language) : '';
}

/** 生成模板替换表 */
function tokensFor(game) {
  const crc = (game.crcs && game.crcs[0] && game.crcs[0].crc) || game.crc || '';
  // 编号统一用 index：列表显示的就是它。
  // imageNumber 在 DAT 里会被多条记录共用（如 BIOS 与主文件同号），拿来做文件名会撞号
  const num = game.index || game.imageNumber || 0;
  return {
    n: game.title || game.comment || '',
    p: game.publisher || '',
    i: fmtShortSize(game.romSize || 0),
    u: num ? String(num).padStart(4, '0') : '',
    c: crc,
    o: regionOf(game),
    g: game.sourceRom || '',
    s: game.saveType || '',
    e: game.comment || '',
    a: languageOf(game),
  };
}

/**
 * 渲染模板
 * @param {string} tpl 模板字符串
 * @param {object} game 游戏对象
 * @param {object} opts {ext} 用于把 {ext}/%x 替换成扩展名（不带点）
 */
function render(tpl, game, opts = {}) {
  const t = (tpl == null || tpl === '') ? '%u - %n [%g]' : String(tpl);
  const tok = tokensFor(game);
  const ext = (opts.ext || '').replace(/^\./, '');
  tok.x = ext;
  tok.f = ext ? '.' + ext : '';

  let out = t.replace(/%([a-zA-Z])/g, (m, k) => {
    const key = k.toLowerCase();
    return tok[key] !== undefined ? String(tok[key]) : m;
  });

  // 兼容旧语法 {title} {comment} ...
  const legacy = {
    title: tok.n,
    comment: tok.e,
    publisher: tok.p,
    sourceRom: tok.g,
    index: tok.u,
    crc: tok.c,
    ext,
    im1CRC: game.im1CRC || '',
    tags: (game.tags || []).join(' '),
    saveType: tok.s,
  };
  out = out.replace(/\{(\w+)\}/g, (m, k) => (legacy[k] !== undefined ? String(legacy[k]) : m));

  return out.replace(/\s+/g, ' ').trim();
}

module.exports = { render, tokensFor, fmtShortSize, regionOf, languageOf };
