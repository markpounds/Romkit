'use strict';
/**
 * 极简 XML 解析器（够解析 OfflineList DAT 用）
 * 支持：XML 声明、注释、DOCTYPE、CDATA、自闭合标签、属性、实体、中文
 * 不校验、不校验 DTD —— DAT 文件结构非常规整，够用且零依赖。
 */

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[g] !== undefined ? ENTITY[g] : m;
  });
}

function parseXml(src) {
  const len = src.length;
  let i = 0;

  const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  function skipWs() { while (i < len && isWs(src[i])) i++; }

  function skipMisc() {
    for (;;) {
      skipWs();
      if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i); i = e < 0 ? len : e + 2; continue; }
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? len : e + 3; continue; }
      if (src.startsWith('<!', i)) { const e = src.indexOf('>', i); i = e < 0 ? len : e + 1; continue; }
      break;
    }
  }

  function parseElement() {
    if (src[i] !== '<') throw new Error('XML 解析错误：期望 "<" 于位置 ' + i);
    i++;
    let name = '';
    while (i < len && !isWs(src[i]) && src[i] !== '/' && src[i] !== '>') name += src[i++];
    const node = { name, attrs: {}, children: [], text: '' };

    for (;;) {
      skipWs();
      if (i >= len) break;
      if (src[i] === '/' && src[i + 1] === '>') { i += 2; return node; }
      if (src[i] === '>') { i++; break; }
      let an = '';
      while (i < len && !isWs(src[i]) && src[i] !== '=' && src[i] !== '/' && src[i] !== '>') an += src[i++];
      if (!an) { i++; continue; }
      skipWs();
      let val = '';
      if (src[i] === '=') {
        i++;
        skipWs();
        const q = src[i];
        if (q === '"' || q === "'") {
          i++;
          const s = i;
          while (i < len && src[i] !== q) i++;
          val = src.slice(s, i);
          i++;
        } else {
          const s = i;
          while (i < len && !isWs(src[i]) && src[i] !== '>') i++;
          val = src.slice(s, i);
        }
      }
      node.attrs[an] = decodeEntities(val);
    }

    // 元素内容
    for (;;) {
      if (i >= len) return node;
      if (src.startsWith('</', i)) {
        const e = src.indexOf('>', i);
        i = e < 0 ? len : e + 1;
        return node;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i);
        node.text += src.slice(i + 9, e < 0 ? len : e);
        i = e < 0 ? len : e + 3;
        continue;
      }
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? len : e + 3; continue; }
      if (src[i] === '<') { node.children.push(parseElement()); continue; }
      const s = i;
      while (i < len && src[i] !== '<') i++;
      node.text += decodeEntities(src.slice(s, i));
    }
  }

  skipMisc();
  if (i >= len) throw new Error('XML 内容为空');
  const root = parseElement();
  return root;
}

/** 取第一个同名子元素 */
function child(node, name) {
  if (!node) return null;
  return node.children.find((c) => c.name === name) || null;
}

/** 取所有同名子元素 */
function children(node, name) {
  if (!node) return [];
  return node.children.filter((c) => c.name === name);
}

/** 取子元素文本 */
function textOf(node, name, dflt = '') {
  const c = child(node, name);
  return c && c.text.trim() ? c.text.trim() : dflt;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { parseXml, child, children, textOf, decodeEntities, escapeXml };
