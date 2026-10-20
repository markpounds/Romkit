'use strict';
/**
 * DAT 在线更新：沿用 DAT 内 <newDat> 的 datVersionURL / datURL，
 * 与原版 OfflineList 的更新源完全兼容（例如 http://dat.emugif.com/update/?ver=ps2）。
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const { listEntries, readEntryBuffer } = require('./zip');
const { decodeBuffer, parseDatXml } = require('./dat');

const UA = 'ROMKit/1.0 (+offlinelist compatible)';

async function fetchBuffer(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function extractVersion(buf) {
  const text = decodeBuffer(buf).trim();
  if (text.length > 4096) return null;
  const m = text.match(/\d{3,}/);
  if (!m) return null;
  // 严格一些：内容应当是"几乎只有版本号"的短文本
  const stripped = text.replace(/[\s\S]*?(\d{3,})[\s\S]*/, '$1');
  if (!stripped) return null;
  return parseInt(m[0], 10);
}

async function checkUpdate(lib) {
  const conf = lib.datConfig || {};
  const url = conf.newDat && conf.newDat.datVersionURL;
  if (!url) return { ok: false, reason: '该 DAT 未提供在线更新地址', current: lib.datVersion };
  const buf = await fetchBuffer(url);
  const remote = extractVersion(buf);
  if (remote == null) {
    return { ok: false, reason: '更新源返回内容无法识别', current: lib.datVersion, raw: decodeBuffer(buf).slice(0, 200) };
  }
  return {
    ok: true,
    current: lib.datVersion,
    remote,
    hasUpdate: remote > (lib.datVersion || 0),
    source: url,
  };
}

/**
 * 下载并替换 DAT，返回新的 `{ datPath, datVersion, dat }`
 */
async function downloadDat(lib, onProgress = () => {}) {
  const conf = lib.datConfig || {};
  const nd = conf.newDat || {};
  const datUrl = nd.datURL;
  if (!datUrl) throw new Error('该 DAT 未提供下载地址');

  onProgress({ phase: 'download', message: '正在下载 DAT…' });
  const buf = await fetchBuffer(datUrl, 120000);
  const dir = path.join(store.DATA_DIR, 'dats');
  await fsp.mkdir(dir, { recursive: true });

  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  let datPath;
  let xmlText;
  if (isZip) {
    const tmpZip = path.join(dir, lib.id + '.download.zip');
    await fsp.writeFile(tmpZip, buf);
    const entries = await listEntries(tmpZip);
    const xmlEntry = entries.find((e) => e.name.toLowerCase().endsWith('.xml'));
    if (!xmlEntry) throw new Error('下载的压缩包内没有 DAT xml');
    xmlText = decodeBuffer(await readEntryBuffer(tmpZip, xmlEntry));
    datPath = path.join(dir, lib.id + '.zip');
    await fsp.rename(tmpZip, datPath);
  } else {
    xmlText = decodeBuffer(buf);
    datPath = path.join(dir, lib.id + '.xml');
    await fsp.writeFile(datPath, buf);
  }

  const dat = parseDatXml(xmlText);
  return { datPath, dat, datVersion: dat.datVersion || 0 };
}

module.exports = { checkUpdate, downloadDat, fetchBuffer, extractVersion };
