'use strict';

/* ------------------------------------------------------------------ 基础 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  libs: [],
  currentId: null,
  games: [],
  filtered: [],
  stats: null,
  covers: {},
  coverInfo: null,
  coverStamp: 0,
  iconStamp: 0,
  coverGame: null,
  filter: 'all',
  search: '',
  sort: { key: 'index', dir: 1 },
  rendered: 0,
  draft: null,
  draftAssets: null,
  fsTarget: null,
  fsPath: '',
  dataDir: '',
  task: null,
  ui: null,
  iconFileOpen: '',
  fsAuthorized: [],
  libQuery: '', // 侧栏清单搜索
  catFolded: {},// 分类折叠状态
  dragLib: null,// 正在拖拽的 DAT id
  tasks: {},    // taskId -> 任务快照（支持多个 DAT 同时跑）
  libTask: {},  // libId -> 该 DAT 最近的任务 id
  pending: new Set(), // 待整理的游戏 index（扫描后算出）
  pendingInfo: null,  // { total, pending }
};

const PAGE = 300;

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof ArrayBuffer || body instanceof Blob) {
      opts.body = body;
      opts.headers['Content-Type'] = 'application/octet-stream';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch('/api' + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return raw ? text : data;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ 主题（图标按钮，位于顶栏最右侧） */
const ICON_MOON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

function refreshThemeBtn() {
  const btn = $('#btnTheme');
  if (!btn) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
  btn.title = dark ? '切换浅色' : '切换深色';
}

function fmtSize(n) {
  if (!n || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtNum(n) {
  return (n || 0).toLocaleString('zh-CN');
}

function toast(msg, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ------------------------------------------------------------------ 状态加载 */
async function loadState() {
  const st = await api('/state');
  S.libs = st.libraries || [];
  S.categories = st.categories || [];
  if (!S.currentCat) S.currentCat = ALL_CAT;
  renderCats();
  S.ui = st.ui || {};
  refreshInboxBtn();
  S.dataDir = st.dataDir || '';
  S.paths = st.paths || null;
  renderLibs();
  if (!S.currentId && S.libs.length) {
    const saved = localStorage.getItem('romkit.lastLib');
    const pick = S.libs.find((l) => l.id === saved) || S.libs[0];
    await selectLib(pick.id);
  } else if (S.currentId) {
    const still = S.libs.find((l) => l.id === S.currentId);
    if (!still) {
      S.currentId = null;
      resetMain();
    } else {
      renderHeader(still);
      renderStats();
    }
  }
}

/* ------------------------------------------------------------------ 分类 */
const ALL_CAT = '__all__';     // 「全部」= 快速切换用的总入口
const NONE_CAT = '__none__';   // 未分类

function catOf(id) { return (S.categories || []).find((c) => c.id === id) || null; }
/** 同级子分类（按分组序号排序） */
function childCats(parentId) {
  return (S.categories || [])
    .filter((c) => (c.parentId || null) === (parentId || null))
    .sort((a, b) => (a.ord || 0) - (b.ord || 0));
}
/** 某分类及其所有子分类的 id */
function catBranch(id) {
  if (id === ALL_CAT) return null; // 全部
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const c of (S.categories || [])) if (c.parentId === out[i] && !out.includes(c.id)) out.push(c.id);
  }
  return out;
}
/** 分类在树里的层级（用于分隔条缩进） */
function catDepth(id) {
  let d = 0;
  let cur = catOf(id);
  while (cur && cur.parentId) { d++; cur = catOf(cur.parentId); }
  return d;
}
/** 某范围内的清单（S.libs 已按分类树顺序排好，过滤即可保持顺序） */
function libsInCat(id) {
  if (id === ALL_CAT) return S.libs;
  const branch = catBranch(id);
  return S.libs.filter((l) => (id === NONE_CAT ? !(l.categoryId || '') : branch.includes(l.categoryId || '')));
}
/** 某分类「直属」的清单（不含子分类里的） */
function directLibs(catId) {
  const cid = catId || '';
  return S.libs.filter((l) => (l.categoryId || '') === cid);
}

/** 侧栏：分类切换（快速切换）+ 分组管理 + 批量操作 */
function renderCats() {
  const chip = $('#catChip');
  if (!chip) return;
  const id = S.currentCat || ALL_CAT;
  let name = '全部';
  let n = S.libs.length;
  if (id === NONE_CAT) {
    name = '未分类';
    n = libsInCat(NONE_CAT).length;
  } else if (id !== ALL_CAT) {
    const c = catOf(id);
    name = c ? c.name : '（已删除）';
    n = libsInCat(id).length;
  }
  chip.innerHTML = `${esc(name)} <span class="chip-n">${n}</span> ▾`;
  renderCatMenu();
  // 批量按钮只对当前分组生效，标题写清范围
  const bulk = $('#btnBulk');
  if (bulk) bulk.title = `对「${name}」分组批量操作`;
}

/** 分类快速切换下拉 */
function renderCatMenu() {
  const box = $('#catMenu');
  if (!box) return;
  const cur = S.currentCat || ALL_CAT;
  const rows = [];
  rows.push(`<button data-cat="${ALL_CAT}" class="${cur === ALL_CAT ? 'on' : ''}">全部 <span class="chip-n">${S.libs.length}</span></button>`);
  const walk = (parentId, depth) => {
    for (const c of childCats(parentId)) {
      const pad = '&nbsp;'.repeat(depth * 3);
      rows.push(`<button data-cat="${esc(c.id)}" class="${cur === c.id ? 'on' : ''}">${pad}${esc(c.name)} <span class="chip-n">${libsInCat(c.id).length}</span></button>`);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  const loose = libsInCat(NONE_CAT).length;
  rows.push(`<button data-cat="${NONE_CAT}" class="${cur === NONE_CAT ? 'on' : ''}">未分类 <span class="chip-n">${loose}</span></button>`);
  box.innerHTML = rows.join('');
}

function openCatModal() {
  renderCatTree();
  $('#catModal').classList.add('show');
}

/**
 * 分类管理弹窗：按最终排序规则展示。
 * 规则：子分类的内容排在父分类直属清单之前；组内 DAT 可上下调整，
 *      组与组之间（同级）可上下调整。
 */
function renderCatTree() {
  const box = $('#catTree');
  if (!box) return;
  const folded = S.catFolded || (S.catFolded = {});
  const rows = [];

  const catRow = (c, depth, hasChild) => `
    <div class="cat-row" data-cat="${esc(c.id)}" data-drop-cat="${esc(c.id)}">
      <span style="width:${depth * 16}px;flex:none"></span>
      ${hasChild ? `<span class="cat-fold" data-fold="${esc(c.id)}">${folded[c.id] ? '▸' : '▾'}</span>`
      : '<span class="cat-fold none">·</span>'}
      ${c.iconFile ? `<img class="cat-ico" src="/api/categories/${esc(c.id)}/icon" alt="">`
        : c.iconText ? `<span class="cat-ico txt">${esc(c.iconText)}</span>` : ''}
      <span class="cat-name">${esc(c.name)}</span>
      <span class="cat-count">${directLibs(c.id).length}</span>
      <span class="cat-ops">
        <button class="cat-op" data-catup="${esc(c.id)}" title="上移（与同级分组互换）">↑</button>
        <button class="cat-op" data-catdown="${esc(c.id)}" title="下移（与同级分组互换）">↓</button>
        <button class="cat-op" data-catren="${esc(c.id)}" title="重命名">✎</button>
        <button class="cat-op" data-caticon="${esc(c.id)}" title="${c.iconFile ? '更换分隔图片' : '设置分隔图片'}">🖼</button>
        ${c.iconFile ? `<button class="cat-op danger" data-catunicon="${esc(c.id)}" title="清除分隔图片">✕</button>` : ''}
        <button class="cat-op" data-catadd="${esc(c.id)}" title="新建子分类">＋</button>
        <button class="cat-op danger" data-catdel="${esc(c.id)}" title="删除">✕</button>
      </span>
    </div>`;

  const libRow = (l) => `
    <div class="cat-lib" data-lib="${esc(l.id)}" draggable="true">
      <span class="cat-name">${esc(l.name)}</span>
      <span class="cat-ops">
        <button class="cat-op" data-libup="${esc(l.id)}" title="在本组内上移">↑</button>
        <button class="cat-op" data-libdown="${esc(l.id)}" title="在本组内下移">↓</button>
        <select class="cat-move" data-move="${esc(l.id)}" title="移到分类">
        </select>
      </span>
    </div>`;

  // 展示顺序 = 最终排序顺序：先子分组，再本组直属清单
  const walk = (parentId, depth) => {
    for (const c of childCats(parentId)) {
      const kids = childCats(c.id);
      rows.push(catRow(c, depth, kids.length > 0));
      if (!folded[c.id]) {
        walk(c.id, depth + 1);
        for (const l of directLibs(c.id)) rows.push(libRow(l));
      }
    }
  };
  walk(null, 0);

  // 未分类
  const loose = directLibs('');
  if (loose.length) {
    rows.push(`<div class="cat-row"><span class="cat-fold none">·</span><span class="cat-name">未分类</span><span class="cat-count">${loose.length}</span></div>`);
    for (const l of loose) rows.push(libRow(l));
  }
  box.innerHTML = rows.join('') ||
    '<div class="empty-hint">还没有分类<br><span>点「＋ 新建顶层分类」开始</span></div>';

  // 填充每个 DAT 的「移到分类」下拉
  $$('.cat-move', box).forEach((sel) => {
    const libId = sel.dataset.move;
    const lib = S.libs.find((l) => l.id === libId);
    const cur = (lib && lib.categoryId) || '';
    const opts = [`<option value="">未分类</option>`]
      .concat((S.categories || []).map((c) =>
        `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.name)}</option>`));
    sel.innerHTML = opts.join('');
    sel.onchange = async () => {
      await assignCat(libId, sel.value);
      openCatModal(); // 重渲染
    };
  });
}

async function assignCat(libId, catId) {
  const target = catId === NONE_CAT ? '' : catId;
  try {
    await api(`/libraries/${libId}`, { method: 'PATCH', body: { categoryId: target } });
    const name = catId === NONE_CAT ? '未分类' : (catOf(catId) || {}).name || catId;
    toast('已移到分类：' + esc(name), 'ok');
    await loadState();
  } catch (e) { toast('移动失败：' + esc(e.message), 'err'); }
}

async function moveCat(catId, parentId) {
  const parent = parentId === NONE_CAT ? '' : (parentId === ALL_CAT ? '' : parentId);
  try {
    await api(`/categories/${catId}`, { method: 'PATCH', body: { parentId: parent } });
    await loadState();
  } catch (e) { toast('移动失败：' + esc(e.message), 'err'); }
}

async function addCat(parentId) {
  const name = await prompt2('新建分类', parentId ? '子分类名称' : '分类名称', '');
  if (!name) return;
  try {
    const r = await api('/categories', { method: 'POST', body: { name, parentId: parentId || null } });
    S.catFolded = S.catFolded || {};
    if (parentId) S.catFolded[parentId] = false;
    S.currentCat = r.category.id;
    await loadState();
  } catch (e) { toast('新建失败：' + esc(e.message), 'err'); }
}

async function catMenu(id) {
  const c = catOf(id);
  if (!c) return;
  const pick = await prompt2(`分类「${c.name}」`, '输入操作：1=更新 DAT  2=扫描  3=整理  4=下载图片  5=重命名  6=新建子分类  7=删除', '2');
  if (!pick) return;
  const key = String(pick).trim();
  if (key === '5') {
    const name = await prompt2('重命名分类', '新名称', c.name);
    if (name) { await api(`/categories/${id}`, { method: 'PATCH', body: { name } }); await loadState(); }
  } else if (key === '6') {
    await addCat(id);
  } else if (key === '7') {
    if (!confirm(`删除分类「${c.name}」？\n\n其中的 DAT 会移到上一级（没有上级就是未分类），子分类也会上提一级。`)) return;
    await api(`/categories/${id}`, { method: 'DELETE' });
    S.currentCat = ALL_CAT;
    await loadState();
  } else {
    await bulkRunForCat(id, { update: 'update', scan: 'scan', organize: 'organize', covers: null }[key] || 'scan');
  }
}

/** 批量操作改为按分类执行 */
async function bulkRunForCat(catId, kind) {
  const label = { update: '更新 DAT', scan: '扫描', organize: '整理' }[kind];
  const seg = { update: 'update', scan: 'scan', organize: 'organize' }[kind];
  let list = libsInCat(catId);
  if (kind === 'update') list = list.filter((l) => l.newDat && l.newDat.datURL);
  else if (kind === 'scan') list = list.filter((l) => l.settings.romDir);
  else list = list.filter((l) => l.settings.romDir && l.settings.outDir && l.stats && l.stats.scannedAt);
  const name = catId === ALL_CAT ? '全部' : catId === NONE_CAT ? '未分类' : (catOf(catId) || {}).name || catId;
  if (!list.length) return toast(`「${name}」里没有可${label}的清单`, 'warn');
  if (!confirm(`对分类「${name}」下的 ${list.length} 个清单执行「${label}」。\n\n继续？`)) return;

  S.bulkBusy = true;
  let okCount = 0;
  const fails = [];
  try {
    for (let i = 0; i < list.length; i++) {
      setStatus(`${label} ${i + 1}/${list.length}：${list[i].name}`, true);
      try {
        const r = await api(`/libraries/${list[i].id}/${seg}`, {
          method: 'POST', body: kind === 'organize' ? { dryRun: false } : {},
        });
        if (r.task) await pollTask(r.task.id);
        okCount++;
      } catch (e) { fails.push(`${list[i].name}：${e.message}`); }
    }
  } finally {
    S.bulkBusy = false;
    setStatus('');
  }
  await loadState();
  if (S.currentId) await loadGames();
  toast(`「${name}」${label}完成：${okCount} 个成功${fails.length ? `，${fails.length} 个失败` : ''}`, fails.length ? 'warn' : 'ok', 8000);
  if (fails.length) toast(esc('失败原因：' + fails[0]), 'err', 8000);
}

/** 上移 / 下移：分组之间互换位置（同级），DAT 在本组内互换位置 */
async function swapOrder(kind, id, delta) {
  if (kind === 'cat') {
    const c = catOf(id);
    if (!c) return;
    const sibs = childCats(c.parentId || null);
    const i = sibs.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= sibs.length) return;
    const ids = sibs.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/categories/reorder', { method: 'POST', body: { parentId: c.parentId || null, ids } });
    await loadState();
    openCatModal();
    return;
  }
  // DAT：只在本组（直属同一分类）内移动
  await moveLib(id, delta);
}

/** 在本组内移动 DAT 的位置 */
async function moveLib(libId, delta) {
  const lib = S.libs.find((l) => l.id === libId);
  if (!lib) return;
  const cid = lib.categoryId || '';
  const sibs = directLibs(cid);
  const i = sibs.findIndex((x) => x.id === libId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const ids = sibs.map((x) => x.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await api('/reorder-libraries', { method: 'POST', body: { categoryId: cid, ids } });
  } catch (e) {
    toast('排序失败：' + esc(e.message), 'err');
    return;
  }
  await loadState();
  openCatModal();
}

async function renameCat(id) {
  const c = catOf(id);
  if (!c) return;
  const name = await prompt2('重命名分类', '新名称', c.name);
  if (!name || !name.trim()) return;
  await api(`/categories/${id}`, { method: 'PATCH', body: { name: name.trim() } });
  await loadState();
  openCatModal();
}

/** 设置分组分隔条上显示的图片 */
let catIconTarget = '';
function pickCatIcon(id) {
  catIconTarget = id;
  $('#catIconPicker').click();
}

async function uploadCatIcon(file) {
  if (!catIconTarget) return;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/categories/${catIconTarget}/icon?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    toast('分隔图片已更新', 'ok');
    await loadState();
    openCatModal();
  } catch (e) {
    toast('上传失败：' + esc(e.message), 'err');
  }
}

/** 清除分类的分隔图片，回到「只显示组名」 */
async function clearCatIcon(id) {
  const c = catOf(id);
  if (!c || !c.iconFile) return;
  if (!confirm(`清除分类「${c.name}」的分隔图片？\n\n分隔条会恢复为只显示组名。`)) return;
  try {
    const res = await fetch(`/api/categories/${id}/icon`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    toast('已清除分隔图片', 'ok');
    await loadState();
    openCatModal();
  } catch (e) {
    toast('清除失败：' + esc(e.message), 'err');
  }
}

async function delCat(id) {
  const c = catOf(id);
  if (!c) return;
  if (!confirm(`删除分类「${c.name}」？\n\n其中的 DAT 会移到上一级（没有上级就是未分类）。`)) return;
  await api(`/categories/${id}`, { method: 'DELETE' });
  if (S.currentCat === id) S.currentCat = ALL_CAT;
  await loadState();
  openCatModal();
}

/**
 * 当前视图的分组序列（顺序与最终列表一致：子分组内容在前，父分组直属在后）。
 * 每项 = { cat, depth, libs }，libs 是该分组的直属清单。
 */
function sectionsInCat(id) {
  const out = [];
  const walk = (parentId, depth) => {
    for (const c of childCats(parentId)) {
      walk(c.id, depth + 1);
      out.push({ cat: c, depth, libs: directLibs(c.id) });
    }
  };
  if (id === ALL_CAT) {
    walk(null, 0);
  } else if (id !== NONE_CAT) {
    walk(id, 1);
    const c = catOf(id);
    if (c) out.push({ cat: c, depth: 0, libs: directLibs(c.id) });
  }
  const loose = directLibs('');
  if (loose.length) out.push({ cat: null, depth: 0, libs: loose, none: true });
  return out.filter((s) => s.libs.length);
}

function renderLibs() {
  const box = $('#libList');
  const key = (S.libQuery || '').trim().toLowerCase();
  const scope = S.currentCat || ALL_CAT;
  if (!S.libs.length) {
    box.innerHTML = '<div class="empty-hint">还没有 DAT<br><span>拖入 CHS_*.zip 即可开始</span></div>';
    return;
  }
  const label = $('#libSectionLabel');
  if (label) {
    const catName = scope === ALL_CAT ? '全部' : scope === NONE_CAT ? '未分类' : (catOf(scope) || {}).name;
    label.textContent = `游戏清单${catName && catName !== '全部' ? ` · ${catName}` : ''}`;
  }

  const sections = sectionsInCat(scope)
    .map((s) => ({
      ...s,
      libs: key ? s.libs.filter((l) => (l.name || '').toLowerCase().includes(key)) : s.libs,
    }))
    .filter((s) => s.libs.length || (!key && s.cat));

  if (!sections.length) {
    box.innerHTML = S.libs.length
      ? '<div class="empty-hint">这个分类下还没有 DAT<br><span>可以把 DAT 拖到左侧分类上</span></div>'
      : '<div class="empty-hint">还没有 DAT<br><span>拖入 CHS_*.zip 即可开始</span></div>';
    return;
  }

  const libHtml = (l) => {
    const games = l.stats.games || 0;
    const owned = l.stats.owned || 0;
    const pct = games ? Math.round((owned / games) * 100) : 0;
    const st = l.settings || {};
    const icon = st.iconFile
      ? `<img class="lib-ico" src="/api/libraries/${l.id}/icon?v=${S.iconStamp}" alt="">`
      : st.iconText
        ? `<span class="lib-ico txt">${esc(st.iconText)}</span>`
        : '';
    const pf = platformOf(l);
    return `
      <div class="lib-item ${l.id === S.currentId ? 'active' : ''}" data-id="${l.id}" data-cat="${esc(l.categoryId || '')}">
        ${icon}
        <div class="lib-body">
          <div class="lib-name" title="${esc(l.name)}（已拥有 ${owned} / 共 ${games}）">${esc(l.name)}</div>
          <div class="lib-sub">
            <span class="lib-plat" title="${esc(pf.raw || pf.short)}">${esc(pf.short)}</span>
            <span>·</span>
            <span>${fmtNum(owned)}/${fmtNum(games)}</span>
            ${l.error ? '<span class="badge-upd" style="background:var(--bad-soft);color:var(--bad)">错误</span>' : ''}
          </div>
          <div class="lib-bar${pct < 100 ? ' low' : ''}"><i style="width:${pct}%"></i></div>
        </div>
        <button class="lib-del" data-del="${l.id}" title="删除这个 DAT">✕</button>
      </div>`;
  };

  // 组与组之间插入分隔条（组名或该组设置的图片）
  const sepHtml = (s) => {
    if (s.none) {
      return `<div class="lib-sep" data-sep-cat=""><span class="sep-line"></span><span class="sep-name">未分类</span><span class="sep-line"></span></div>`;
    }
    const c = s.cat;
    // 配了图片：整幅横幅，组名叠在图片上，悬停出现「清除图片」
    if (c.iconFile) {
      return `<div class="lib-sep img" data-sep-cat="${esc(c.id)}" style="margin-left:${s.depth * 12}px" title="${esc(c.name)}">
        <img class="sep-banner" src="/api/categories/${esc(c.id)}/icon" alt="">
        <span class="sep-cap">${esc(c.name)}</span>
        <button class="sep-del" data-sepdel="${esc(c.id)}" title="清除这个分组的图片">✕</button>
      </div>`;
    }
    return `<div class="lib-sep" data-sep-cat="${esc(c.id)}" style="padding-left:${s.depth * 12}px">${
      c.iconText ? `<span class="sep-ico txt">${esc(c.iconText)}</span>` : ''
    }<span class="sep-name">${esc(c.name)}</span><span class="sep-line"></span></div>`;
  };

  box.innerHTML = sections.map((s) => sepHtml(s) + s.libs.map(libHtml).join('')).join('');

  // 图标文件丢失时去掉整个图标位，外观回到未配置状态
  $$('.lib-ico img', box).forEach((img) => {
    img.onerror = () => { const wrap = img.closest('.lib-ico'); if (wrap) wrap.remove(); };
  });
  $$('.sep-ico', box).forEach((img) => {
    if (img.tagName !== 'IMG') return;
    img.onerror = () => { img.remove(); };
  });
  // 横幅图片文件丢失：退回「只显示组名」的普通分隔条
  $$('.sep-banner', box).forEach((img) => {
    img.onerror = () => {
      const sep = img.closest('.lib-sep');
      if (!sep) return;
      const name = (sep.querySelector('.sep-cap') || {}).textContent || sep.title || '';
      sep.classList.remove('img');
      sep.innerHTML = `<span class="sep-name">${esc(name)}</span><span class="sep-line"></span>`;
    };
  });
  // 横幅上的「清除图片」
  $$('[data-sepdel]', box).forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      clearCatIcon(btn.dataset.sepdel);
    };
  });
  $$('.lib-item', box).forEach((el) => {
    el.onclick = () => selectLib(el.dataset.id);
    // 拖拽：组内改顺序 / 拖到分隔条上换组
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/romkit-lib', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      S.dragLib = el.dataset.id;
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); S.dragLib = null; $$('.lib-item.over', box).forEach((x) => x.classList.remove('over')); });
    el.addEventListener('dragover', (e) => {
      if (S.dragLib && S.dragLib !== el.dataset.id) { e.preventDefault(); el.classList.add('over'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('over');
      const fromId = S.dragLib || e.dataTransfer.getData('text/romkit-lib');
      if (!fromId || fromId === el.dataset.id) return;
      // 跨组拖拽 = 换组；同组拖拽 = 改顺序
      if (el.dataset.cat !== (S.libs.find((l) => l.id === fromId) || {}).categoryId) {
        await assignCat(fromId, el.dataset.cat);
        return;
      }
      await reorderLibs(fromId, el.dataset.id);
    });
  });
  // 拖到分隔条上 = 换到该组
  $$('.lib-sep', box).forEach((sep) => {
    sep.addEventListener('dragover', (e) => { if (S.dragLib) { e.preventDefault(); sep.classList.add('over'); } });
    sep.addEventListener('dragleave', () => sep.classList.remove('over'));
    sep.addEventListener('drop', async (e) => {
      e.preventDefault();
      sep.classList.remove('over');
      const fromId = S.dragLib || e.dataTransfer.getData('text/romkit-lib');
      if (!fromId) return;
      await assignCat(fromId, sep.dataset.sepCat);
    });
  });
  $$('[data-del]', box).forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteLibrary(btn.dataset.del);
    };
  });
  renderLibsQuiet(); // 重建后补回各 DAT 的运行进度
}

/** 拖拽排序：把 fromId 插到 toId 的位置（只在本组范围内有效） */
async function reorderLibs(fromId, toId) {
  const from = S.libs.find((l) => l.id === fromId);
  const to = S.libs.find((l) => l.id === toId);
  if (!from || !to) return;
  if ((from.categoryId || '') !== (to.categoryId || '')) {
    await assignCat(fromId, to.categoryId || '');
    return;
  }
  const cid = from.categoryId || '';
  const ids = directLibs(cid).map((l) => l.id);
  const i = ids.indexOf(fromId);
  const j = ids.indexOf(toId);
  if (i < 0 || j < 0) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  // 乐观更新：先按新顺序重排本组
  const next = S.libs.slice();
  const slots = [];
  next.forEach((l, idx) => { if ((l.categoryId || '') === cid) slots.push(idx); });
  slots.forEach((slot, k) => { next[slot] = S.libs.find((l) => l.id === ids[k]); });
  S.libs = next;
  renderLibs();
  try {
    await api('/reorder-libraries', { method: 'POST', body: { categoryId: cid, ids } });
  } catch (e) {
    toast('排序失败：' + esc(e.message), 'err');
    await loadState();
  }
}

/** 侧栏直接删除一个 DAT 清单 */
async function deleteLibrary(id) {
  const lib = S.libs.find((l) => l.id === id);
  if (!lib) return;
  if (!confirm(`删除清单「${lib.name}」？\n\n只删除工具里的 DAT 记录和文件，不会动你的 ROM 和截图。`)) return;
  try {
    await api(`/libraries/${id}`, { method: 'DELETE' });
    if (S.currentId === id) {
      S.currentId = null;
      closeDetail();
      resetMain();
    }
    await loadState();
    if (!S.currentId && S.libs.length) await selectLib(S.libs[0].id);
    else renderLibs();
    toast(`已删除「${lib.name}」`, 'ok');
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

function resetMain() {
  $('#libTitle').textContent = '选择左侧的游戏清单';
  $('#libMeta').innerHTML = '';
  $('#statsBar').innerHTML = '';
  S.games = [];
  S.filtered = [];
  renderTable();
  $('#tableEmpty').classList.remove('hidden');
}

async function selectLib(id) {
  if (S.currentId !== id) closeDetail();
  S.currentId = id;
  localStorage.setItem('romkit.lastLib', id);
  renderLibs();
  refreshStatus(); // 切到某个 DAT 时，顶栏显示它自己的进度
  const lib = S.libs.find((l) => l.id === id);
  if (!lib) return;
  // 待整理是「每个清单各自一份」的状态，切换时必须重新取，
  // 否则会沿用上一个清单的标记和数量（表现为切过去标记就没了）
  await loadPending();
  renderHeader(lib);
  await loadGames();
  // 常驻详情：默认展示列表第一个游戏
  if (S.games.length) openDetail(S.games[0].index);
}

/** 取当前清单的待整理统计（服务端有缓存，切清单时调用开销很小） */
async function loadPending() {
  if (!S.currentId) {
    S.pending = new Set();
    S.pendingInfo = null;
    renderStats();
    return;
  }
  try {
    const info = await api(`/libraries/${S.currentId}/pending`);
    S.pending = new Set(info.indexes || []);
    S.pendingInfo = { total: info.total || 0, pending: info.pending || 0 };
  } catch (_) {
    S.pending = new Set();
    S.pendingInfo = null;
  }
  renderStats();
}

function renderHeader(lib) {
  $('#libTitle').textContent = lib.name;
  const bits = [];
  if (lib.system) {
    const pf = platformOf(lib);
    bits.push(`<span title="${esc(pf.raw || pf.short)}"><b>平台</b> ${esc(pf.short)}</span>`);
  }
  bits.push(`<span><b>DAT</b> v${lib.datVersion}</span>`);
  if (lib.extensions && lib.extensions.length) bits.push(`<span><b>格式</b> ${esc(lib.extensions.join(' '))}</span>`);
  if (lib.settings.romDir) bits.push(`<span title="${esc(lib.settings.romDir)}"><b>ROM</b> ${esc(shortPath(lib.settings.romDir))}</span>`);
  else bits.push('<span style="color:var(--warn)">未设置 ROM 目录</span>');
  if (lib.settings.outDir) bits.push(`<span title="${esc(lib.settings.outDir)}"><b>输出</b> ${esc(shortPath(lib.settings.outDir))}</span>`);
  if (lib.error) bits.push(`<span style="color:var(--bad)">${esc(lib.error)}</span>`);
  $('#libMeta').innerHTML = bits.join('');
  // 这两个按钮已并入统计栏，可能不存在
  const bs = $('#btnScan');
  if (bs) bs.disabled = !lib.settings.romDir;
  const bo = $('#btnOrganize');
  if (bo) bo.disabled = !lib.settings.outDir;
}

/* 平台简称：DAT 的 system 字段常是厂商全称（如 "Nintendo - Nintendo Entertainment System"），
   直接显示看不出是什么平台，这里映射成玩家一眼能认出的简称。 */
const PLATFORM_SHORT = [
  // 纯缩写（清单名里常见，如「中文 - SNES」），必须排在全称规则之前
  [/\bsnes\b/i, 'SNES'],
  [/\bnes\b/i, 'NES'],
  [/\bngpc\b/i, 'NGPC'],
  [/super\s*nintendo|supernintendo|super\s*famly|sfc/i, 'SNES'],
  [/nintendo\s*entertainment\s*system/i, 'NES'],
  [/game\s*boy\s*advance|\gba\b/i, 'GBA'],
  [/game\s*boy\s*color|\bgbc\b/i, 'GBC'],
  [/game\s*boy|\bgb\b/i, 'GB'],
  [/game\s*&?\s*watch/i, 'Game & Watch'],
  [/nintendo\s*64|\bn64\b/i, 'N64'],
  [/nintendo\s*ds|\bnds\b/i, 'NDS'],
  [/nintendo\s*3\s*ds|\b3ds\b/i, '3DS'],
  [/wii\s*u/i, 'Wii U'],
  [/\bwii\b/i, 'Wii'],
  [/playstation\s*2|\bps2\b/i, 'PS2'],
  [/playstation\s*(?:portable|\bpsp\b|vita)/i, 'PSP'],
  [/playstation\s*3|\bps3\b/i, 'PS3'],
  [/playstation\s*4|\bps4\b/i, 'PS4'],
  [/playstation\s*5|\bps5\b/i, 'PS5'],
  [/playstation|\bpsx?\b/i, 'PS1'],
  [/dreamcast/i, 'Dreamcast'],
  [/sega\s*saturn/i, 'Saturn'],
  [/mega\s*drive|sega\s*genesis|\bmegadrive\b/i, 'Mega Drive'],
  [/sega\s*master\s*system/i, 'Master System'],
  [/\bgenesis\b/i, 'Genesis'],
  [/xbox\s*360/i, 'Xbox 360'],
  [/xbox\s*(?:one|series)/i, 'Xbox One'],
  [/\bxbox\b/i, 'Xbox'],
  [/neo\s*geo\s*pocket|\bngp\b/i, 'NGP'],
  [/neo\s*geo|neogeo|\barcade\b/i, 'Arcade'],
  [/pc\s*engine|\bpcengine\b|turbo\s*grafx/i, 'PC Engine'],
  [/supervision|watara/i, 'Watara'],
  [/virtual\s*boy/i, 'Virtual Boy'],
  [/atari\s*lynx|\blynx\b/i, 'Lynx'],
  [/commodore\s*64|\bc64\b/i, 'C64'],
  [/atari\s*2600|\b2600\b/i, 'Atari 2600'],
  [/game\s*&?\s*watch/i, 'Game & Watch'],
  [/zx\s*spectrum|\bspectrum\b/i, 'ZX Spectrum'],
  [/amiga/i, 'Amiga'],
  [/\bmsx\b/i, 'MSX'],
  [/\bandroid\b/i, 'Android'],
  [/\bios\b|\bdos\b|\bpc\b/i, 'PC'],
];

/** 从 DAT 的 system 全称/清单名里提炼平台简称，取不到就回退原值 */
function platformOf(lib) {
  const raw = String((lib && (lib.system || lib.romTitle)) || '').trim();
  const name = String((lib && lib.name) || '');
  for (const [re, short] of PLATFORM_SHORT) {
    if (raw && re.test(raw)) return { short, raw };
  }
  // system 为空时从清单名里找
  for (const [re, short] of PLATFORM_SHORT) {
    if (name && re.test(name)) return { short, raw };
  }
  // "Nintendo - Nintendo Entertainment System" 这类：取破折号后一段
  const tail = raw.includes(' - ') ? raw.split(' - ').pop().trim() : raw;
  return { short: tail || '未知平台', raw: raw || '' };
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…' + (p.includes('\\') ? '\\' : '/') + parts.slice(-2).join(p.includes('\\') ? '\\' : '/');
}

async function loadGames() {
  if (!S.currentId) return;
  const data = await api(`/libraries/${S.currentId}/games`);
  S.games = data.games || [];
  S.stats = data.stats || null;
  renderStats();
  await loadCovers();
  applyFilter();
}

async function loadCovers(forceRows) {
  if (!S.currentId) { S.covers = {}; return; }
  try {
    const d = await api(`/libraries/${S.currentId}/covers${forceRows ? '?refresh=1' : ''}`);
    S.covers = d.covers || {};
    S.coverInfo = d;
  } catch (_) {
    S.covers = {};
    S.coverInfo = null;
  }
}

function renderStats() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  const st = S.stats || (lib && lib.stats) || {};
  const total = st.games || 0;
  const owned = st.owned || 0;
  const missing = st.missing != null ? st.missing : total - owned;
  const dup = st.duplicates || 0;
  const pct = total ? Math.round((owned / total) * 100) : 0;
  // 待整理跟着清单走
  const pend = S.pendingInfo ? (S.pendingInfo.pending || 0) : 0;
  // 统计格就是分类页签：点一下按该类筛选，再点一下回到全部。
  // 「清单总数」即「全部」。
  const tab = (v, cls, num, label) => `
    <div class="stat ${cls} tab${S.filter === v ? ' on' : ''}" data-filter="${v}" title="${v === 'all' ? '显示全部条目' : '点击筛选：' + label + '（再点一次显示全部）'}">
      <div class="v">${num}</div><div class="k">${label}</div>
    </div>`;
  $('#statsBar').innerHTML = `
    ${tab('all', '', fmtNum(total), '清单总数')}
    ${tab('owned', 'ok', fmtNum(owned), '已拥有')}
    ${tab('missing', 'bad', fmtNum(missing), '缺失')}
    ${tab('duplicate', 'warn', fmtNum(dup), '多份副本')}
    ${tab('pending', 'pend', fmtNum(pend), '待整理')}
  `;
  $$('#statsBar .stat.tab').forEach((el) => {
    el.onclick = () => setFilter(el.dataset.filter);
  });

  // 收集进度 / 上次扫描 / 上次整理 挪到右上角按钮下方的小字里
  const meta = $('#actionsMeta');
  if (meta) {
    const items = [
      `<span>收集进度：<b style="color:var(--warn)">${pct}%</b></span>`,
      `<span>扫描：${st.scannedAt ? timeAgo(st.scannedAt) : '未扫描'}</span>`,
      `<span>更新：${lib && lib.updatedAt ? timeAgo(lib.updatedAt) : '—'}</span>`,
    ];
    meta.innerHTML = items.join('');
  }
}

/** 切换分类筛选；重复点同一个页签 = 回到全部 */
function setFilter(v) {
  S.filter = (S.filter === v) ? 'all' : v;
  renderStats();
  applyFilter();
}



function timeAgo(iso) {
  const d = new Date(iso).getTime();
  if (!d) return '—';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return new Date(iso).toLocaleDateString('zh-CN');
}

/* ------------------------------------------------------------------ 表格 */
function applyFilter() {
  const q = S.search.trim().toLowerCase();
  let list = S.games.filter((g) => {
    if (S.filter === 'owned' && g.status === 'missing') return false;
    if (S.filter === 'missing' && g.status !== 'missing') return false;
    if (S.filter === 'duplicate' && g.status !== 'duplicate') return false;
    if (S.filter === 'pending' && !(S.pending && S.pending.has(g.index))) return false;
    if (!q) return true;
    const hay = [
      g.title, g.comment, g.publisher, g.sourceRom,
      (g.crcs || []).map((c) => c.crc).join(' '),
      (g.matches || []).map((m) => m.relPath + ' ' + m.entryName).join(' '),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const { key, dir } = S.sort;
  if (key !== 'index') {
    list = list.slice().sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'size') { va = a.romSize || 0; vb = b.romSize || 0; }
      if (typeof va === 'string') return va.localeCompare(vb, 'zh') * dir;
      return ((va || 0) - (vb || 0)) * dir;
    });
  }
  // 有问题的排前面？不：保持 DAT 顺序更符合"清单感"
  S.filtered = list;
  renderTable(true);
}

function renderTable(reset = false) {
  const body = $('#gameBody');
  if (reset) { body.innerHTML = ''; S.rendered = 0; }
  const total = S.filtered.length;
  const slice = S.filtered.slice(S.rendered, S.rendered + PAGE);
  const frag = document.createDocumentFragment();
  for (const g of slice) frag.appendChild(rowOf(g));
  body.appendChild(frag);
  S.rendered += slice.length;


  const empty = $('#tableEmpty');
  if (S.games.length && !total) {
    empty.classList.remove('hidden');
    empty.innerHTML = '<div>没有符合条件的游戏</div><div class="sub">试试换个筛选条件或清空搜索</div>';
  } else if (!S.games.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = '<div>先选择一个清单，然后点击「扫描」</div><div class="sub">扫描会把 ROM 目录里的文件与 DAT 里的 CRC 逐一比对</div>';
  } else {
    empty.classList.add('hidden');
  }
}

/* ---------------- 地区旗帜（Windows 不支持国旗 emoji，直接用内联 SVG） ---------------- */
const FLAG_SVG = {
  cn: '<svg viewBox="0 0 24 16" class="flag"><rect width="24" height="16" fill="#de2910"/><polygon fill="#ffde00" points="5,3.2 5.9,5.9 8.7,5.9 6.4,7.5 7.3,10.2 5,8.6 2.7,10.2 3.6,7.5 1.3,5.9 4.1,5.9"/><circle cx="9.4" cy="3.1" r=".75" fill="#ffde00"/><circle cx="10.8" cy="5.3" r=".75" fill="#ffde00"/><circle cx="10.8" cy="7.9" r=".75" fill="#ffde00"/><circle cx="9.4" cy="10.1" r=".75" fill="#ffde00"/></svg>',
  us: '<svg viewBox="0 0 24 16" class="flag"><rect width="24" height="16" fill="#fff"/><g fill="#b22234"><rect width="24" height="2.3"/><rect y="4.6" width="24" height="2.3"/><rect y="9.2" width="24" height="2.3"/><rect y="13.8" width="24" height="2.2"/></g><rect width="10.5" height="8.6" fill="#3c3b6e"/><g fill="#fff"><circle cx="2" cy="2" r=".6"/><circle cx="5.2" cy="2" r=".6"/><circle cx="8.4" cy="2" r=".6"/><circle cx="3.6" cy="4.3" r=".6"/><circle cx="6.8" cy="4.3" r=".6"/><circle cx="2" cy="6.6" r=".6"/><circle cx="5.2" cy="6.6" r=".6"/><circle cx="8.4" cy="6.6" r=".6"/></g></svg>',
  eu: '<svg viewBox="0 0 24 16" class="flag"><rect width="24" height="16" fill="#003399"/><g fill="#ffcc00"><circle cx="12" cy="3.5" r=".9"/><circle cx="15.5" cy="5" r=".9"/><circle cx="18" cy="8" r=".9"/><circle cx="15.5" cy="11" r=".9"/><circle cx="12" cy="12.5" r=".9"/><circle cx="8.5" cy="11" r=".9"/><circle cx="6" cy="8" r=".9"/><circle cx="8.5" cy="5" r=".9"/></g></svg>',
  jp: '<svg viewBox="0 0 24 16" class="flag"><rect width="24" height="16" fill="#fff" stroke="#d8dde5" stroke-width=".6"/><circle cx="12" cy="8" r="4.6" fill="#bc002d"/></svg>',
  hk: '<svg viewBox="0 0 24 16" class="flag"><rect width="24" height="16" fill="#de2910"/><g fill="#fff"><circle cx="12" cy="8" r="1.1"/><circle cx="12" cy="4.4" r="1.25"/><circle cx="15.4" cy="6.5" r="1.25"/><circle cx="14.1" cy="10.5" r="1.25"/><circle cx="9.9" cy="10.5" r="1.25"/><circle cx="8.6" cy="6.5" r="1.25"/></g></svg>',
  // 多地区（USA, Europe 这种并列）或认不出地区时用联合国旗，
  // 比一个问号更能说明"这条不是单一地区版本"
  un: '<svg viewBox="0 0 24 16" class="flag"><rect width="24" height="16" fill="#5b92e5"/><circle cx="12" cy="8" r="5.2" fill="none" stroke="#fff" stroke-width=".9"/><ellipse cx="12" cy="8" rx="2.4" ry="5.2" fill="none" stroke="#fff" stroke-width=".7"/><path d="M6.9 6.2h10.2M6.9 9.8h10.2" stroke="#fff" stroke-width=".7"/><g fill="#fff"><circle cx="12" cy="1.9" r=".5"/><circle cx="12" cy="14.1" r=".5"/><circle cx="5.4" cy="4.9" r=".5"/><circle cx="18.6" cy="4.9" r=".5"/><circle cx="4.6" cy="8" r=".5"/><circle cx="19.4" cy="8" r=".5"/><circle cx="5.4" cy="11.1" r=".5"/><circle cx="18.6" cy="11.1" r=".5"/></g></svg>',
};

/**
 * 从标签推断国家/地区。
 * 注意 DAT 里 (USA, Europe) 这种是**一个**标签里并列多个地区，
 * 必须按逗号/斜杠/& 拆开再判断，否则整串匹配不上，以前就会掉到"未知"。
 * 多地区或认不出来时统一给联合国旗。
 */
const REGION_MAP = {
  china: { key: 'cn', label: '中国' },
  usa: { key: 'us', label: '美国' },
  europe: { key: 'eu', label: '欧洲' },
  japan: { key: 'jp', label: '日本' },
  asia: { key: 'hk', label: '亚洲' },
  'hong kong': { key: 'hk', label: '亚洲' },
  taiwan: { key: 'hk', label: '亚洲' },
  korea: { key: 'hk', label: '亚洲' },
};

function regionOf(g) {
  const raw = (g.tags || []).map((x) => String(x).toLowerCase());
  const tokens = [];
  for (const t of raw) {
    for (const part of t.split(/[,/&、+]|\bund\b/)) {
      const k = part.trim();
      if (k) tokens.push(k);
    }
  }
  const hits = [];
  for (const t of tokens) {
    const hit = REGION_MAP[t];
    if (hit && !hits.some((h) => h.key === hit.key)) hits.push(hit);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // 多地区并列：用联合国旗 + 把地区名都写进 tooltip
    return { key: 'un', label: hits.map((h) => h.label).join(' / ') };
  }
  return { key: 'un', label: '未知地区' };
}

/** 语言标签：CHS=简体中文（绿）、CHT=繁体中文（蓝）；CHS&CHT 这类合并写法会同时显示两个 */
function langTags(g) {
  const tags = (g.tags || []).map((t) => String(t));
  const hasCHS = tags.some((t) => /CHS|简/i.test(t));
  const hasCHT = tags.some((t) => /CHT|繁/i.test(t));
  const out = [];
  if (hasCHS) out.push('<span class="tag lang-chs">简体中文</span>');
  if (hasCHT) out.push('<span class="tag lang-cht">繁体中文</span>');
  if (tags.some((t) => /^AI$/i.test(t.trim()))) out.push('<span class="tag lang-ai">AI 汉化</span>');
  return out.join('');
}

function rowOf(g) {
  const tr = document.createElement('tr');
  if (g.status === 'missing') tr.className = 'missing';
  // 待整理（已匹配但源文件还没在目标位置/目标名上）用单独颜色标出来
  if (S.pending && S.pending.has(g.index)) tr.classList.add('pending');
  tr.dataset.index = g.index;

  const statusText = { owned: '已拥有', missing: '缺失', duplicate: '多份副本', unknown: '未扫描' }[g.status] || '';
  const rc = regionOf(g);
  const flag = FLAG_SVG[rc.key] || FLAG_SVG.un;
  const langs = langTags(g);
  const crc = (g.crcs || []).map((c) => c.crc).join('<br>');
  const num = padNum(g.imageNumber || g.index);

  tr.innerHTML = `
    <td class="c-num"><span class="num-badge ${g.status}" title="${statusText}">${num}</span></td>
    <td class="c-flag" title="${rc.label}">${flag}</td>
    <td>
      <div class="g-title">${esc(g.title || g.comment || '#' + g.index)}</div>
      <div class="g-sub">${esc(g.comment || '')}</div>
    </td>
    <td>${langs || '<span class="muted">—</span>'}</td>
    <td class="num mono">${g.romSize ? fmtSize(g.romSize) : '<span class="muted">—</span>'}</td>
    <td class="mono" style="font-size:11px">${crc || '<span class="muted">—</span>'}</td>
  `;
  return tr;
}

/* ------------------------------------------------------------------ 截图 / 封面 */
function padNum(n) { return String(n || 0).padStart(4, '0'); }

function openCover(index, slot = 'a') {
  const g = S.games.find((x) => x.index === index);
  if (!g) return;
  S.coverGame = g;
  S.coverSlot = slot;
  $('#coverTitle').textContent = `${padNum(g.imageNumber || g.index)} · ${g.title || g.comment || ''}${slot === 'b' ? ' · 截图' : ''}`;
  const has = !!S.covers[index] || slot === 'b';
  const img = $('#coverImg');
  if (has) {
    img.onerror = () => {
      img.removeAttribute('src');
      img.classList.remove('on');
      $('#coverEmpty').style.display = 'block';
    };
    img.src = `/api/cover/${S.currentId}/${index}?slot=${slot}&v=${S.coverStamp}`;
    img.classList.add('on');
    $('#coverEmpty').style.display = 'none';
  } else {
    img.removeAttribute('src');
    img.classList.remove('on');
    $('#coverEmpty').style.display = 'block';
  }
  const from = S.covers[index];
  $('#coverHint').textContent = from === 'local' ? '来源：已有截图目录（只读）' : from === 'cache' ? '来源：工具存储目录' : '';
  $('#coverDelete').disabled = !has || from === 'local';
  $('#coverModal').classList.add('show');
}

async function uploadCover(file) {
  const g = S.coverGame;
  if (!g || !file) return;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/cover/${S.currentId}/${g.index}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    S.coverStamp++;
    await loadCovers(true);
    applyFilter();
    openCover(g.index);
    toast('截图已保存', 'ok');
  } catch (e) {
    toast('保存失败：' + esc(e.message), 'err');
  }
}

async function deleteCover() {
  const g = S.coverGame;
  if (!g) return;
  if (!confirm(`移除「${g.title}」的截图？\n\n只会删除工具存储目录里的图片文件。`)) return;
  try {
    await api(`/api/cover/${S.currentId}/${g.index}`, { method: 'DELETE' });
    S.coverStamp++;
    await loadCovers(true);
    applyFilter();
    openCover(g.index);
    toast('已移除', 'ok');
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

/* ------------------------------------------------------------------ 游戏详情 */
const REGION_TAGS = /^(USA|Europe|Japan|China|Korea|Taiwan|Hong Kong|Australia|Germany|France|Spain|Italy|Brazil|World|Asia|Netherlands|Sweden|Canada)$/i;
const LANG_TAGS = /^(CHS|CHT|AI|Chinese|En|Ja|Fr|De|Es|It|Ko|Zh|简|繁|简中|繁中)$/i;

function openDetail(index) {
  const g = S.games.find((x) => x.index === index);
  if (!g) return;
  S.detailGame = g;
  const has = !!S.covers[index];
  const num = padNum(g.imageNumber || g.index);
  const region = (g.tags || []).find((t) => REGION_TAGS.test(t)) || g.location || '—';
  const lang = (g.tags || []).find((t) => LANG_TAGS.test(t)) || g.language || '—';
  const statusText = { owned: '已拥有', missing: '缺失', duplicate: '多份副本', unknown: '未扫描' }[g.status] || '未扫描';
  const from = S.covers[index];

  const fields = [
    ['编号', num],
    ['标题', g.title || '—'],
    ['英文名', g.comment || '—'],
    ['发行国家', region],
    ['发行厂商', g.publisher || '—'],
    ['发布来源', g.sourceRom || '—'],
    ['容量大小', g.romSize ? fmtSize(g.romSize) : '—'],
    ['存档类型', g.saveType || '—'],
    ['语言', lang],
    ['CRC', (g.crcs || []).map((c) => c.crc).join(' / ') || '—'],
    ['状态', `<span class="pill ${g.status}">${statusText}</span>`],
  ];

  const files = (g.matches || []).map((m) => `
    <div class="file-item">
      <span class="fi-tag">${m.container === 'zip' ? 'ZIP' : 'FILE'}</span>
      ${esc(m.relPath)}${m.entryName ? `<br><span class="fi-entry">› ${esc(m.entryName)}</span>` : ''}
      <span class="pill ${m.via === 'name' ? '' : 'ok'}">${m.via === 'name' ? '文件名匹配' : 'CRC 校验'}</span>
      <br><span class="muted">${fmtSize(m.size)}</span>
    </div>`).join('') || '<div class="hint">清单里还没有找到这个文件。扫描 ROM 目录后再看。</div>';

  $('#detailBody').innerHTML = `
    <div class="detail-cover" id="detailCover"><div class="empty">加载中…</div></div>
    <div class="detail-thumbs" id="detailThumbs"></div>
    <div class="detail-name">${num} · ${esc(g.title || g.comment || '')}</div>
    <div class="detail-sub">${esc(g.comment || '')}</div>

    <dl class="df">
      ${fields.map(([k, v]) => `<dt>${k}</dt><dd class="${k === 'CRC' ? 'mono' : ''}">${typeof v === 'string' && v.includes('<span') ? v : esc(v)}</dd>`).join('')}
    </dl>

    <div class="detail-section">
      整理
      ${S.pending && S.pending.has(g.index)
        ? '<span class="pill warn">待整理</span>'
        : '<span class="pill ok">已就位</span>'}
    </div>
    <div class="detail-organize">
      <button class="btn primary" id="btnOrganizeOne" ${(g.matches || []).length ? '' : 'disabled'}>
        整理这一条
      </button>
      <span class="hint">${(g.matches || []).length
        ? '按当前清单的输出设置，把这一条的文件整理到输出目录（不影响其他条目）'
        : '这一条还没匹配到文件，先扫描 ROM 目录'}</span>
    </div>

    <div class="detail-section">文件位置</div>
    ${files}
  `;
  const btnOne = $('#btnOrganizeOne');
  if (btnOne) btnOne.onclick = () => organizeOne(g.index);

  // 常驻面板：只更新内容 + 高亮选中行
  S.detailGame = g;
  $$('#gameBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.index) === index));
  loadDetailImages(index);
}

/** 异步加载该游戏的所有图片并渲染切换器 */
async function loadDetailImages(index) {
  let slots = [];
  try {
    const r = await api(`/covers/${S.currentId}/${index}`);
    slots = r.slots || [];
  } catch (_) {}
  S.dtSlots = slots;
  S.dtIdx = 0;
  renderDetailImage();
}

function renderDetailImage() {
  const slots = S.dtSlots || [];
  const g = S.detailGame;
  const cover = $('#detailCover');
  const thumbs = $('#detailThumbs');
  if (!cover || !g) return;

  // 末尾固定一个"+"占位，点击上传；没有截图时它就是唯一一项
  const addThumb = `
    <div class="dt-thumb add" id="dtAddThumb" title="上传截图">
      <span class="plus">+</span>
      <span>添加</span>
    </div>`;

  if (!slots.length) {
    cover.innerHTML = '<div class="empty">暂无截图<br><span style="font-size:11px">点击下方的 + 上传，或在设置里指定图片目录</span></div>';
    if (thumbs) thumbs.innerHTML = addThumb;
    const add = $('#dtAddThumb');
    if (add) add.onclick = () => openCover(g.index, 'a');
    return;
  }

  const cur = slots[S.dtIdx];
  const url = `/api/cover/${S.currentId}/${g.index}?slot=${cur.slot}&v=${S.coverStamp}`;
  const multi = slots.length > 1;
  cover.innerHTML = `
    <img src="${url}" alt="" id="dtBigImg" title="点击查看大图">
    <span class="badge-src">${cur.source === 'local' ? '本地目录' : '工具存储'}</span>
    ${multi ? '<button class="cover-nav prev" id="dtPrev" title="上一张">‹</button><button class="cover-nav next" id="dtNext" title="下一张">›</button>' : ''}
  `;
  if (thumbs) {
    thumbs.innerHTML = slots.map((s, i) => `
      <div class="dt-thumb ${i === S.dtIdx ? 'on' : ''}" data-i="${i}">
        <img src="/api/cover/${S.currentId}/${g.index}?slot=${s.slot}&v=${S.coverStamp}" alt="">
        <span>${esc(s.label)}</span>
      </div>`).join('') + addThumb;
  }

  const bigImg = $('#dtBigImg');
  if (bigImg) bigImg.onclick = () => openCover(g.index, cur.slot);
  const prev = $('#dtPrev');
  const next = $('#dtNext');
  const go = (d) => { S.dtIdx = (S.dtIdx + d + slots.length) % slots.length; renderDetailImage(); };
  if (prev) prev.onclick = () => go(-1);
  if (next) next.onclick = () => go(1);
  if (thumbs) {
    $$('.dt-thumb[data-i]', thumbs).forEach((el) => {
      el.onclick = () => { S.dtIdx = parseInt(el.dataset.i, 10); renderDetailImage(); };
    });
    const add = $('#dtAddThumb');
    if (add) add.onclick = () => openCover(g.index, 'a');
  }
}

/** 清空常驻详情（切换库时用） */
function closeDetail() {
  S.detailGame = null;
  S.detailSlots = [];
  const body = $('#detailBody');
  if (!body) return;
  body.innerHTML = '<div class="detail-empty">点击左侧列表中的任意游戏<br><span>这里会显示截图和详细信息</span></div>';
  const t = $('#detailTitle');
  if (t) t.textContent = '游戏详情';
}

async function probeCover(lib) {
  $('#probeBody').innerHTML = '<div class="hint">正在逐个测试候选地址，每个最多等 5 秒…</div>';
  $('#probeModal').classList.add('show');
  try {
    const r = await api(`/libraries/${lib.id}/covers/probe`, { method: 'POST', body: {} });
    if (r.error) {
      $('#probeBody').innerHTML = `<div class="hint" style="color:var(--bad)">${esc(r.error)}</div>`;
      return;
    }
    const head = `<div class="hint" style="margin-bottom:10px">测试游戏：<b>${esc(r.game.title || '')}</b><br>源站目录：<span class="mono">${esc(r.base)}</span></div>`;
    const rows = r.results.map((x) => `
      <div class="probe-row ${x.ok ? 'ok' : 'bad'}">
        <span class="pr-flag">${x.ok ? '✓' : '✗'}</span>
        <span class="pr-url mono">${esc(x.url)}</span>
        <span class="pr-res">${x.ok ? (x.bytes / 1024).toFixed(1) + ' KB' : esc(x.error)}</span>
      </div>`).join('');
    const anyOk = r.results.some((x) => x.ok);
    const tip = anyOk
      ? '<div class="hint" style="margin-top:10px;color:var(--ok)">找到可用地址，下载时会自动用这条规则。</div>'
      : '<div class="hint" style="margin-top:10px;color:var(--bad)">所有规则都不可用，说明源站没有这些图片。建议在设置里指定本地图片目录（如 Romulus 图片包），比在线下载可靠得多。</div>';
    $('#probeBody').innerHTML = head + rows + tip;
  } catch (e) {
    $('#probeBody').innerHTML = `<div class="hint" style="color:var(--bad)">测试失败：${esc(e.message)}</div>`;
  }
}

async function fetchCovers(lib) {
  if (!confirm('从 DAT 的订阅源下载缺失截图？\n\n需要联网，游戏多时耗时较长，可随时停止。')) return;
  try {
    const { task } = await api(`/libraries/${lib.id}/covers/fetch`, { method: 'POST', body: {} });
    trackTask(task);
    setStatus('下载截图…', true);
    closeDrawer();
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

/* ------------------------------------------------------------------ 自动归类 */
/** 待分类文件夹：全局配置，直接存到服务端 */
async function saveInboxDir(p) {
  S.ui = S.ui || {};
  S.ui.inboxDir = p;
  refreshInboxBtn();
  try {
    await api('/config/ui', { method: 'POST', body: { inboxDir: p } });
    toast('待分类文件夹已设置', 'ok');
  } catch (e) {
    toast('保存失败：' + esc(e.message), 'err');
  }
}

/** 侧栏文件夹按钮的悬停提示：显示当前配置，未设置时给出引导 */
function refreshInboxBtn() {
  const btn = $('#btnInboxBrowse');
  if (!btn) return;
  const p = (S.ui && S.ui.inboxDir || '').trim();
  btn.title = p ? '待分类文件夹：' + p + '\n点击更改' : '配置待分类文件夹（尚未设置）';
  // 已配置时给个可见标记，避免选完看不出有没有生效
  btn.classList.toggle('on', !!p);
}

/** 详情页里只整理这一条 */
async function organizeOne(index) {
  if (!S.currentId) return;
  if (!confirm('只整理这一条，按当前清单的输出设置落到输出目录。\n\n继续？')) return;
  try {
    const { task } = await api(`/libraries/${S.currentId}/organize-one`, {
      method: 'POST', body: { index },
    });
    trackTask(task);
    toast('已开始整理这一条…', 'ok', 3000);
  } catch (e) {
    toast('整理失败：' + esc(e.message), 'err', 6000);
  }
}

/** 全局存储位置：直接存到服务端并立即生效 */
async function saveGlobalPath(key, p) {
  const box = key === 'datDir' ? $('#setDatDir') : $('#setCoverDir');
  try {
    const r = await api('/config/paths', { method: 'POST', body: { [key]: p } });
    S.paths = r.effective || S.paths;
    if (box) box.value = p;
    toast(key === 'datDir' ? 'DAT 保存位置已设置' : '图片保存位置已设置', 'ok');
  } catch (e) {
    toast('保存失败：' + esc(e.message), 'err');
  }
}

async function classifyAll() {
  const inbox = (S.ui && S.ui.inboxDir || '').trim();
  if (!inbox) { toast('先点左侧的文件夹图标，设置「待分类文件夹」', 'warn'); return; }
  if (!confirm(`将扫描「${inbox}」里的文件，与清单逐一比对。\n\n已集齐的清单会被自动跳过（它们不可能再有新文件待归类），只比对还有缺失的清单。\n\n命中的文件会按各清单的设置送到对应输出目录并改名；未命中的留在原处。\n\n继续？`)) return;
  try {
    const { task } = await api('/classify', { method: 'POST', body: {} });
    setStatus('正在自动归类…', true);
    await pollTask(task.id);
    const { task: t2 } = await api(`/tasks/${task.id}`);
    const r = t2.result || {};
    const parts = [`${r.moved || 0} 个文件已归位`];
    if (r.failed) parts.push(`${r.failed} 个失败`);
    if (r.skippedComplete) parts.push(`跳过 ${r.skippedComplete} 个已集齐的清单`);
    toast(esc('归类完成：' + parts.join('，')), r.failed ? 'warn' : 'ok', 7000);
    if (r.errors && r.errors.length) { console.warn('归类失败', r.errors); toast(esc('失败原因：' + r.errors[0].error || r.errors[0].title), 'err', 9000); }
    setStatus('');
    await loadState();
    if (S.currentId) await loadGames();
  } catch (e) {
    setStatus('');
    toast(esc(e.message), 'err', 7000);
  }
}

/* ------------------------------------------------------------------ 批量操作 */
async function pollTask(id, timeoutMs = 60 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error('任务超时');
    const { task } = await api(`/tasks/${id}`);
    if (task.status === 'done') return task;
    if (task.status === 'error' || task.status === 'cancelled') throw new Error(task.error || '任务已取消');
    await new Promise((r) => setTimeout(r, 900));
  }
}

async function bulkRun(kind) {
  if (S.bulkBusy) return;
  const label = { update: '更新 DAT', scan: '扫描', organize: '整理' }[kind];
  const seg = { update: 'update', scan: 'scan', organize: 'organize' }[kind];

  let list = S.libs;
  if (kind === 'update') list = list.filter((l) => l.newDat && l.newDat.datURL);
  else if (kind === 'scan') list = list.filter((l) => l.settings.romDir);
  else list = list.filter((l) => l.settings.romDir && l.settings.outDir && l.stats && l.stats.scannedAt);

  if (!list.length) return toast(`没有可${label}的清单`, 'warn');
  const skip = S.libs.length - list.length;
  const msg = kind === 'organize'
    ? `将对 ${list.length} 个清单执行整理（按各自的设置，可能包含移动/删除文件）。${skip ? `\n\n另有 ${skip} 个清单未扫描或未配置目录，会跳过。` : ''}\n\n继续？`
    : `将对 ${list.length} 个清单执行「${label}」。${skip ? `\n\n跳过 ${skip} 个（无地址 / 未配置目录）。` : ''}\n\n继续？`;
  if (!confirm(msg)) return;

  S.bulkBusy = true;
  let ok = 0;
  let noUpdate = 0;
  const fails = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const lib = list[i];
      setStatus(`${label} ${i + 1}/${list.length}：${lib.name}`, true);
      try {
        // 批量更新先问一句版本，没新版本就直接跳过 ——
        // 否则会把整份 DAT 下载一遍，即使内容没变
        if (kind === 'update') {
          const info = await api(`/libraries/${lib.id}/check-update`, { method: 'POST' }).catch(() => null);
          if (info && info.ok && !info.hasUpdate) { noUpdate++; continue; }
        }
        const r = await api(`/libraries/${lib.id}/${seg}`, {
          method: 'POST',
          body: kind === 'organize' ? { dryRun: false } : {},
        });
        if (r.task) await pollTask(r.task.id);
        ok++;
      } catch (e) {
        fails.push(`${lib.name}：${e.message}`);
      }
    }
  } finally {
    S.bulkBusy = false;
    setStatus('');
  }

  await loadState();
  if (S.currentId) { await loadPending(); await loadGames(); }
  toast(
    `${label}完成：${ok} 个成功${noUpdate ? `，${noUpdate} 个已是最新` : ''}${fails.length ? `，${fails.length} 个失败` : ''}${skip ? `（跳过 ${skip} 个）` : ''}`,
    fails.length ? 'warn' : 'ok',
    8000,
  );
  if (fails.length) {
    console.warn('批量操作失败', fails);
    toast(esc('失败原因：' + fails[0]), 'err', 10000);
  }
}

/* ------------------------------------------------------------------ 顶部操作 */
async function doScan() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  if (!lib.settings.romDir) { toast('请先在设置里指定 ROM 目录', 'warn'); openDrawer(); return; }
  try {
    const { task } = await api(`/libraries/${lib.id}/scan`, { method: 'POST' });
    trackTask(task);
    setStatus('扫描中…', true);
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

async function doOrganize() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  if (!lib.settings.outDir) { toast('请先在设置里指定输出目录', 'warn'); openDrawer(); return; }
  if (!lib.stats.scannedAt) { toast('请先扫描，确认清单里有哪些文件', 'warn'); return; }
  try {
    const plan = await api(`/libraries/${lib.id}/plan`, { method: 'POST' });
    showPlan(plan);
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

function actionLabelOf(action, isMove) {
  const map = {
    pack: isMove ? '打包并移动' : '打包 zip',
    'copy-zip': isMove ? '移动' : '复制 zip',
    extract: isMove ? '解压并移动' : '解压',
    'copy-file': isMove ? '移动' : '复制',
    skip: '跳过',
    already: '已就位',
    'move-unmatched': '移动未识别',
    'remove-duplicate': '移走副本',
    'delete-duplicate': '删除副本',
  };
  return map[action] || action;
}

function showPlan(plan) {
  const counts = { pack: 0, 'copy-zip': 0, extract: 0, 'copy-file': 0, skip: 0 };
  for (const it of plan.items) counts[it.action] = (counts[it.action] || 0) + 1;
  const modeLabel = plan.mode === 'zip' ? '保留压缩包（zip）' : '保留原始文件（不打包）';
  const actLabel = plan.operation === 'move' ? '移动源文件' : '复制（保留源文件）';
  const willDo = plan.total - counts.skip - (counts.already || 0);
  $('#planSummary').innerHTML = `
    <div class="ps"><span>输出形态</span><b>${modeLabel}</b></div>
    <div class="ps"><span>操作方式</span><b>${actLabel}</b></div>
    <div class="ps"><span>将处理</span><b>${willDo}</b><span>项</span></div>
    ${counts.already ? `<div class="ps"><span>已就位</span><b style="color:var(--ok)">${counts.already}</b></div>` : ''}
    <div class="ps"><span>跳过</span><b style="color:var(--bad)">${counts.skip}</b></div>
    <div class="ps"><span>冲突</span><b style="color:var(--warn)">${plan.conflicts}</b></div>
    ${plan.duplicates ? `<div class="ps"><span>重复副本</span><b style="color:var(--warn)">${plan.duplicates}</b><span>份</span></div>` : ''}
    ${plan.multiDiscGames ? `<div class="ps"><span>多盘子文件夹</span><b style="color:var(--accent)">${plan.multiDiscGames}</b></div>` : ''}
    ${plan.textureGroups ? `<div class="ps"><span>纹理包分组</span><b style="color:var(--accent)">${plan.textureGroups}</b></div>` : ''}
    ${plan.biosGroups ? `<div class="ps"><span>BIOS 分组</span><b style="color:var(--accent)">${plan.biosGroups}</b></div>` : ''}
    ${plan.sharedFiles ? `<div class="ps"><span>共享文件保留</span><b style="color:var(--ok)">${plan.sharedFiles}</b><span>个</span></div>` : ''}
    <div class="ps" style="flex-basis:100%"><span>输出到</span><span class="mono">${esc(plan.outDir)}</span></div>
    ${plan.duplicateSkipped ? `<div class="plan-warn">有 ${plan.duplicateSkipped} 个压缩包里装着多个游戏，为避免误伤没有移动，可按需手动处理。</div>` : ''}
    ${plan.warning ? `<div class="plan-warn">⚠ ${esc(plan.warning)}</div>` : ''}
  `;
  // 预览只列「会发生变化」的条目：已就位、跳过这些不需要动手的没必要占屏，
  // 否则真正要处理的几行会被大片"已就位"淹没
  const changing = plan.items.filter((it) => it.action !== 'already' && it.action !== 'skip');
  const hiddenRows = plan.items.length - changing.length;
  $('#planBody').innerHTML = changing.length
    ? changing.map((it) => `
    <tr>
      <td><span class="act ${it.action}">${actionLabelOf(it.action, plan.operation === 'move')}</span></td>
      <td>${esc(it.title)}${it.reason ? `<br><span class="muted" style="font-size:10.5px">${esc(it.reason)}</span>` : ''}</td>
      <td class="mono" style="font-size:10.5px;color:var(--text-3)">${esc(it.source)}</td>
      <td class="mono" style="font-size:10.5px">${esc(it.dest)}</td>
      <td class="num mono">${fmtSize(it.size)}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;padding:28px;color:var(--text-3)">没有需要处理的条目，所有文件都已在目标位置</td></tr>';
  $('#planHint').textContent = [
    hiddenRows > 0 ? `已隐藏 ${hiddenRows} 条无需处理的条目（已就位 / 跳过）` : '',
    plan.total > plan.items.length ? `清单较大，仅载入前 ${plan.items.length} 项（共 ${plan.total} 项）` : '',
  ].filter(Boolean).join('　·　');
  $('#planModal').classList.add('show');
  $('#planRun').onclick = async () => {
    const delCount = plan.items.filter((i) => i.action === 'delete-duplicate').length;
    if (delCount && !confirm(`有 ${delCount} 个重复副本将被直接删除（不进回收站）。\n\n这些文件与保留的那份 CRC 完全相同，确定继续？`)) return;
    $('#planModal').classList.remove('show');
    try {
      const { task } = await api(`/libraries/${S.currentId}/organize`, { method: 'POST', body: { dryRun: false } });
      trackTask(task);
      setStatus('整理中…', true);
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  };
}

/* 清除当前清单的缓存：CRC 缓存 + 扫描结果。匹配结果不对时用它强制重算。 */
async function clearLibCache() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  if (!confirm(`清除「${lib.name}」的缓存？\n\n会清掉这个清单的 CRC 校验缓存和扫描结果，下次扫描将重新读取文件（大库会比较慢），不改动任何 ROM 文件。`)) return;
  try {
    setStatus('正在清除缓存…');
    const r = await api(`/libraries/${lib.id}/cache`, { method: 'DELETE' });
    S.pending = new Set();
    S.pendingInfo = null;
    S.games = [];
    renderStats();
    await loadState();
    renderHeader(S.libs.find((l) => l.id === S.currentId));
    renderTable(true);
    setStatus('就绪');
    toast(esc(r.message || '缓存已清除'), 'ok', 5000);
  } catch (e) {
    setStatus('就绪');
    toast(esc('清除失败：' + e.message), 'err');
  }
}

/* 清除全部清单的缓存（设置页里用，用于「匹配错了死活不再匹配」的兜底） */
async function clearAllCache() {
  if (!confirm('清除全部缓存？\n\n会清掉所有清单的 CRC 校验缓存与扫描结果，之后每个清单都需要重新扫描（大库会比较慢）。不改动任何 ROM 文件。')) return;
  try {
    const r = await api('/cache/clear', { method: 'POST' });
    S.pending = new Set();
    S.pendingInfo = null;
    S.games = [];
    S.stats = null;
    renderStats();
    await loadState();
    if (S.currentId) {
      renderHeader(S.libs.find((l) => l.id === S.currentId));
      renderTable(true);
    }
    toast(esc(r.message || '全部缓存已清除'), 'ok', 6000);
  } catch (e) {
    toast(esc('清除失败：' + e.message), 'err');
  }
}

async function doUpdate() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  if (!lib.newDat || !lib.newDat.datVersionURL) { toast('该 DAT 未提供在线更新地址', 'warn'); return; }
  setStatus('正在检查更新…');
  try {
    const info = await api(`/libraries/${lib.id}/check-update`, { method: 'POST' });
    if (!info.ok) { toast('检查更新失败：' + esc(info.reason || ''), 'err', 5000); setStatus('就绪'); return; }
    if (!info.hasUpdate) { toast(`已是最新版本 v${info.current}`, 'ok'); setStatus('就绪'); return; }
    if (!confirm(`发现新版本：v${info.current} → v${info.remote}\n\n下载并替换当前 DAT？`)) { setStatus('就绪'); return; }
    const { task } = await api(`/libraries/${lib.id}/update`, { method: 'POST' });
    trackTask(task);
    setStatus('正在更新 DAT…');
  } catch (e) {
    toast(esc(e.message), 'err');
    setStatus('就绪');
  }
}

/* ------------------------------------------------------------------ 任务进度 */
function setStatus(text, busy = false) {
  const el = $('#statusText');
  el.innerHTML = busy ? `<span class="progress"><i style="width:0%"></i></span>${esc(text)}` : esc(text);
}

/** 任务登记：按 id 存档，并记住每个 DAT 最近的任务，互不覆盖 */
function trackTask(task) {
  if (!task || !task.id) return;
  S.tasks[task.id] = task;
  if (task.libraryId) S.libTask[task.libraryId] = task.id;
  renderTasks();
}

function taskLabel(kind) {
  return { scan: '扫描', organize: '整理', update: '更新 DAT', covers: '下载截图', classify: '自动归类' }[kind] || kind;
}


/** 顶栏只反映「当前选中 DAT」的任务；没有运行中的任务时回到就绪 */
function refreshStatus() {
  const curTid = S.currentId && S.libTask[S.currentId];
  const cur = curTid && S.tasks[curTid];
  if (cur && cur.status === 'running') {
    const p = cur.progress || {};
    setStatus(`${taskLabel(cur.kind)} ${p.total ? p.current + '/' + p.total : ''} ${p.message || ''}`, true);
    const bar = $('#statusText .progress i');
    if (bar) bar.style.width = (p.total ? Math.round((p.current / p.total) * 100) : 0) + '%';
  } else if (!Object.values(S.tasks).some((x) => x.status === 'running')) {
    setStatus('就绪');
  }
}

function libNameOf(libId) {
  const l = S.libs && S.libs.find((x) => x.id === libId);
  return l ? l.name : (libId ? String(libId).slice(0, 8) : '全局');
}

/** 底部「运行中任务」条：每个 DAT 一行，切换清单不会互相盖掉 */
function renderTasks() {
  const strip = $('#taskStrip');
  const running = Object.values(S.tasks).filter((t) => t.status === 'running');
  // 清理已结束任务的历史，避免无限增长
  for (const [id, t] of Object.entries(S.tasks)) {
    if (t.status !== 'running' && Date.now() - Date.parse(t.finishedAt || t.startedAt) > 10 * 60 * 1000) delete S.tasks[id];
  }
  if (!strip) return;
  refreshStatus();
  if (!running.length) { strip.hidden = true; strip.innerHTML = ''; renderLibsQuiet(); return; }
  strip.hidden = false;
  strip.innerHTML = running.map((t) => {
    const p = t.progress || {};
    const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
    return `<div class="task-row" data-tid="${esc(t.id)}">
      <span class="task-lib">${esc(libNameOf(t.libraryId))}</span>
      <span class="task-kind">${esc(taskLabel(t.kind))}</span>
      <span class="task-msg">${esc(p.message || '')}${p.total ? `（${p.current}/${p.total}）` : ''}</span>
      <span class="progress"><i style="width:${pct}%"></i></span>
      <span class="task-pct">${p.total ? pct + '%' : ''}</span>
      <a href="#" class="task-stop" data-stop="${esc(t.id)}">停止</a>
    </div>`;
  }).join('');
  $$('#taskStrip .task-stop').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); api(`/tasks/${a.dataset.stop}/cancel`, { method: 'POST' }); };
  });
  // 侧栏每个 DAT 上显示各自进度
  renderLibsQuiet();
}

/** 只更新侧栏条目上的进度徽标，不重建整个列表（避免打断交互） */
function renderLibsQuiet() {
  $$('#libList .lib-item').forEach((el) => {
    const id = el.dataset.id;
    const tid = S.libTask[id];
    const t = tid && S.tasks[tid];
    let badge = el.querySelector('.lib-prog');
    if (!t || t.status !== 'running') { if (badge) badge.remove(); return; }
    const p = t.progress || {};
    const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'lib-prog';
      el.querySelector('.lib-body')?.appendChild(badge) || el.appendChild(badge);
    }
    badge.innerHTML = `<span class="progress"><i style="width:${pct}%"></i></span>${esc(taskLabel(t.kind))}${p.total ? ` ${p.current}/${p.total}` : ''}`;
  });
}

function onTask(t) {
  if (!t || !t.id) return;
  S.tasks[t.id] = t;
  if (t.libraryId) S.libTask[t.libraryId] = t.id;
  renderTasks();

  const isCurrent = t.libraryId && t.libraryId === S.currentId;
  refreshStatus();
  if (t.status === 'running') return;

  if (t.status === 'error') {
    if (isCurrent) setStatus('出错了');
    // 权限类错误常常是多行的（会列出所有不可写的目录），换行要保留、
    // 停留时间也要长一些，否则用户还没来得及看就消失了
    const raw = String(t.error || '未知错误');
    const isPerm = /EACCES|EPERM|没有写权限|不可写/.test(raw);
    const html = esc(raw).replace(/\n/g, '<br>');
    toast(`任务失败（${esc(libNameOf(t.libraryId))}）：${html}`, 'err', isPerm ? 15000 : 6000);
    return;
  }
  if (t.status === 'cancelled') {
    if (isCurrent) setStatus('已取消');
    return;
  }
  if (isCurrent) setStatus('完成');
  if (t.kind === 'scan') {
    const st = t.result && t.result.stats;
    toast(`扫描完成：${st ? st.owned + '/' + st.games + ' 个游戏已找到' : ''}`, 'ok', 4000);
    if (st && st.readErrors) {
      const list = (t.result && t.result.unreadableList) || [];
      const byCode = {};
      for (const it of list) {
        const k = it.error || 'UNKNOWN';
        byCode[k] = (byCode[k] || 0) + 1;
      }
      const summary = Object.keys(byCode).length
        ? Object.keys(byCode).map((k) => `${k} ×${byCode[k]}`).join('，')
        : '未知原因（多为权限不足或文件被占用）';
      const viewBtn = list.length
        ? `<br><button class="toast-link" id="toastDiag">查看具体文件</button>` : '';
      toast(`${st.readErrors} 个文件无法读取（${esc(summary)}），已跳过。<br><span style="font-size:11px;color:var(--text-3)">这些文件不会被当作「多余文件」移走</span>${viewBtn}`, 'warn', 12000);
      const vb = $('#toastDiag');
      if (vb) vb.onclick = () => openDiag(list);
    }
    // 待整理统计：扫描结束时服务端已顺带算好
    const pend = t.result && t.result.pending;
    if (pend && pend.pending) {
      S.pending = new Set(pend.indexes || []);
      S.pendingInfo = { total: pend.total || 0, pending: pend.pending };
      toast(`扫描完成：${pend.pending} 个待整理（<span style="color:var(--warn)">列表里已用高亮标出</span>），可在详情页单条整理`, 'ok', 7000);
    } else if (pend) {
      S.pending = new Set();
      S.pendingInfo = { total: pend.total || 0, pending: 0 };
    }
    renderStats();
    loadState().then(() => loadGames());
  } else if (t.kind === 'organize') {
    const r = t.result || {};
    const placed = (r.done || 0) - (r.moved || 0);
    const parts = [`${placed} 个文件已就位`];
    if (r.moved) parts.push(`${r.moved} 个多余副本已移走`);
    if (r.prunedDirs) parts.push(`清理空文件夹 ${r.prunedDirs} 个`);
    if (r.skipped) parts.push(`跳过 ${r.skipped}`);
    if (r.failed) parts.push(`失败 ${r.failed}`);
    toast(esc('整理完成：' + parts.join('，')), r.failed ? 'warn' : 'ok', 5500);
    if (r.blockedDirs && r.blockedDirs.length) {
      // 目录没写权限时不要只给一句 EACCES，明确告诉用户是哪个目录、怎么授权
      toast(
        `有目录没有写权限，本次跳过了 ${r.permissionBlocked || 0} 条：<br><span class="mono" style="font-size:10.5px">${r.blockedDirs.slice(0, 3).map(esc).join('<br>')}</span>` +
        '<br><span style="font-size:11px">请在飞牛「应用设置 → 目录访问权限」里授予读写权限后重新整理</span>',
        'warn', 15000,
      );
    }
    if (r.errors && r.errors.length) {
      console.warn('整理错误', r.errors);
      toast(esc('首个错误：' + r.errors[0].error), 'err', 6000);
    }
    // 服务端已按执行结果增量更新状态，这里只刷新列表，无需整库重扫
    // 待整理统计也随结果一起回来了，直接套用，避免高亮和数量停留在整理前
    if (r.pending && typeof r.pending.pending === 'number') {
      S.pending = new Set(r.pending.indexes || []);
      S.pendingInfo = { total: r.pending.total || 0, pending: r.pending.pending };
      renderStats();
    }
    if (t.libraryId === S.currentId) {
      setTimeout(() => {
        if (S.currentId === t.libraryId) loadState().then(() => loadGames());
      }, 300);
    }
  } else if (t.kind === 'update') {
    const r0 = t.result || {};
    // 下载回来的 DAT 与原来一模一样：扫描结果原样保留，别提示用户去重扫
    if (r0.unchanged) {
      toast(`DAT 内容没有变化（v${r0.datVersion}，${r0.games} 个游戏），扫描进度已保留`, 'ok', 5000);
      loadState().then(() => loadGames());
      return;
    }
    const cv = t.result && t.result.covers;
    const cvText = !cv ? ''
      : cv.fail === -1 ? `<br><span style="font-size:11px">图片下载失败：${esc(cv.error || '')}</span>`
        : `<br><span style="font-size:11px">图片：新增 ${cv.ok || 0}，已有 ${cv.skipped || 0}，失败 ${cv.fail || 0}${cv.dir ? `（保存到 ${esc(cv.dir)}）` : ''}</span>`;
    toast(`DAT 已更新到 v${t.result.datVersion}（${t.result.games} 个游戏）${cvText}`, cv && cv.fail ? 'warn' : 'ok', 6000);
    loadState().then(async () => { await loadPending(); await loadGames(); });
  } else if (t.kind === 'covers') {
    const r = t.result || {};
    const msg = `截图下载完成：成功 ${r.ok || 0}，已有跳过 ${r.skipped || 0}，失败 ${r.fail || 0}`;
    toast(esc(msg), r.fail ? 'warn' : 'ok', 6000);
    if (r.aborted) {
      toast(esc(r.abortReason || '源站连续失败，已停止') + '<br><span style="font-size:11px;color:var(--text-3)">建议改用本地图片目录，比在线下载更可靠</span>', 'err', 10000);
    } else if (r.errors && r.errors.length) {
      const e0 = r.errors[0];
      const is404 = /404/.test(e0.error);
      toast(`失败示例：${esc(e0.error)}（已尝试 ${e0.tried || 1} 种地址规则）<br><span class="mono" style="font-size:10.5px;color:var(--text-3)">${esc(e0.url)}</span>${is404 ? '<br><span style="font-size:11px;color:var(--text-3)">源站没有这张图，建议在设置里指定本地图片目录</span>' : ''}`, 'err', 10000);
      console.warn('封面下载失败明细', r.errors);
    }
    S.coverStamp++;
    loadCovers(true).then(() => applyFilter());
  }
}

function initSSE() {
  // ?nosse=1 用于无头浏览器等不需要实时进度的场景
  if (new URLSearchParams(location.search).get('nosse') === '1') return;
  const es = new EventSource('/api/events');
  es.addEventListener('task', (e) => {
    try { onTask(JSON.parse(e.data)); } catch (_) {}
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

/* ------------------------------------------------------------------ 设置抽屉 */
function openDrawer() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  S.draft = JSON.parse(JSON.stringify(lib.settings));
  S.draftAssets = JSON.parse(JSON.stringify(lib.assets || {}));
  S.iconFileOpen = (lib.settings && lib.settings.iconFile) || '';
  renderDrawer(lib);
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('show');
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('show');
}

function renderDrawer(lib) {
  const d = S.draft;
  const assets = S.draftAssets || (lib.assets || {});
  S.draftAssets = assets;

  $('#drawerBody').innerHTML = `
    <div class="field">
      <label>清单名称</label>
      <input class="input" id="setName" value="${esc(lib.name)}">
      <div class="desc">仅显示用，不影响 DAT 文件本身。</div>
    </div>

    <div class="divider"></div>
    <div class="section-title">清单图标</div>

    <div class="field icon-field">
      <div class="icon-preview" id="iconPreview"></div>
      <div class="icon-ops">
        <div class="input-row">
          <input class="input" id="setIconText" maxlength="4" value="${esc(d.iconText || '')}" placeholder="表情或 1-2 个字，如 🎮">
          <button class="btn" id="btnIconUpload">上传图片…</button>
        </div>
        <div class="desc">显示在左侧列表最前方。图片建议用正方形（如 188×188 的 PNG），容器为正方形且完整缩放，不会拉伸变形；非正方形图片会居中完整放入。</div>
        <div style="margin-top:6px"><button class="btn small ghost" id="btnIconClear">移除图标</button></div>
      </div>
    </div>

    <div class="divider"></div>
    <div class="section-title">文件位置</div>

    <div class="field">
      <label>ROM 源目录</label>
      <div class="input-row">
        <input class="input mono" id="setRomDir" value="${esc(d.romDir)}" placeholder="D:\\ROMs\\PS2">
        <button class="btn" data-browse="romDir">浏览…</button>
      </div>
      <div class="desc">扫描这里的所有文件，与 DAT 清单比对。</div>
    </div>

    <div class="field">
      <label>整理输出目录</label>
      <div class="input-row">
        <input class="input mono" id="setOutDir" value="${esc(d.outDir)}" placeholder="D:\\ROMs\\PS2-整理后">
        <button class="btn" data-browse="outDir">浏览…</button>
      </div>
      <div class="desc">整理后的游戏会放到这里，按下面的形态生成。</div>
    </div>

    <div class="divider"></div>
    <div class="section-title">输出形态（每个 DAT 可独立设置）</div>

    <div class="mode-cards" id="modeCards">
      <div class="mode-card ${d.mode === 'zip' ? 'on' : ''}" data-mode="zip">
        <div class="mc-t">保留压缩包</div>
        <div class="mc-d">每个游戏打包成一个 .zip，文件名按模板重命名</div>
      </div>
      <div class="mode-card ${d.mode === 'raw' ? 'on' : ''}" data-mode="raw">
        <div class="mc-t">保留原始文件</div>
        <div class="mc-d">不打包，直接输出 ROM 本体；源是 zip 时自动解压</div>
      </div>
    </div>

    <div class="divider"></div>
    <div class="section-title">命名方式（与 OfflineList 一致）</div>

    <div class="field">
      <label>文件名模板</label>
      <input class="input mono" id="setFileTpl" value="${esc(d.fileTemplate)}" spellcheck="false">
      <div class="preview-line"><span class="pl-tag">原始文件</span><span class="pl-val" id="pvFile">—</span></div>
      <div class="preview-line"><span class="pl-tag">包内文件</span><span class="pl-val" id="pvEntry">—</span></div>
    </div>

    <div class="field">
      <label>压缩包名模板</label>
      <input class="input mono" id="setArcTpl" value="${esc(d.archiveTemplate)}" spellcheck="false">
      <div class="preview-line"><span class="pl-tag">压缩包</span><span class="pl-val" id="pvArc">—</span></div>
    </div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setEntryRename" ${d.entryRename !== false ? 'checked' : ''}> 同时重命名压缩包内的文件</label>
      <div class="desc">勾选后 zip 内部条目也按「文件名模板」改名；取消则保留 ROM 的原始文件名。</div>
    </div>

    <div class="field">
      <label style="font-size:11px;color:var(--text-3);font-weight:400">点击插入占位符</label>
      <div class="tokens" id="tokenBox"></div>
    </div>

    <div class="field">
      <label>操作方式</label>
      <div class="radio-row">
        <label><input type="radio" name="op" value="copy" ${d.operation === 'copy' ? 'checked' : ''}> 复制（保留源文件）</label>
        <label><input type="radio" name="op" value="move" ${d.operation === 'move' ? 'checked' : ''}> 移动（整理后删除源文件）</label>
      </div>
      <div class="desc">${d.operation === 'move' ? '⚠ 移动模式会删除源目录中的文件，请先确认设置正确。' : '推荐：先复制，确认无误后再手动清理源目录。'}</div>
    </div>

    <div class="field">
      <label>目标已存在时</label>
      <select class="input" id="setConflict">
        <option value="skip" ${d.conflict === 'skip' ? 'selected' : ''}>跳过（不动已有文件）</option>
        <option value="overwrite" ${d.conflict === 'overwrite' ? 'selected' : ''}>覆盖</option>
        <option value="rename" ${d.conflict === 'rename' ? 'selected' : ''}>自动改名（加序号）</option>
      </select>
    </div>

    <div class="field">
      <label>未识别 / 多余的文件</label>
      <select class="input" id="setUnmatchedAction">
        <option value="keep" ${d.unmatchedAction !== 'move' ? 'selected' : ''}>留在原处（不处理）</option>
        <option value="move" ${d.unmatchedAction === 'move' ? 'selected' : ''}>整理时移动到指定目录</option>
      </select>
      <div class="input-row" id="unmatchedDirRow" style="margin-top:6px;display:${d.unmatchedAction === 'move' ? 'flex' : 'none'}">
        <input class="input mono" id="setUnmatchedDir" value="${esc(d.unmatchedDir || '')}" placeholder="D:\\ROMs\\未识别">
        <button class="btn" data-browse="unmatchedDir">浏览…</button>
      </div>
      <div class="desc">ROM 目录里没匹配到清单的文件（含读不出内容的压缩包）会被移到这里，保持目录整洁。建议放在 ROM 目录之外。</div>
    </div>

    <div class="field">
      <label>同一游戏有多份副本时</label>
      <select class="input" id="setDuplicateAction">
        <option value="keep" ${d.duplicateAction !== 'move' && d.duplicateAction !== 'delete' ? 'selected' : ''}>全部保留</option>
        <option value="move" ${d.duplicateAction === 'move' ? 'selected' : ''}>只保留文件名正确的那一份，其余移走</option>
        <option value="delete" ${d.duplicateAction === 'delete' ? 'selected' : ''}>只保留文件名正确的那一份，其余直接删除</option>
      </select>
      <div class="input-row" id="duplicateDirRow" style="margin-top:6px;display:${d.duplicateAction === 'move' ? 'flex' : 'none'}">
        <input class="input mono" id="setDuplicateDir" value="${esc(d.duplicateDir || '')}" placeholder="留空 = 用上面的未识别目录">
        <button class="btn" data-browse="duplicateDir">浏览…</button>
      </div>
      <div class="desc">「文件名正确」指符合上面的命名模板。选「直接删除」时会在整理前二次确认；压缩包里还装着别的游戏时不动它。</div>
    </div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setMultiDisc" ${d.multiDiscFolder ? 'checked' : ''}> 多盘游戏放进同一个文件夹</label>
      <div class="desc">Disc 1 / Disc 2 这类多盘游戏，输出到以游戏名命名的子文件夹里，文件名保留盘号。仅「保留原始文件」模式生效。</div>
    </div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setTexturePack" ${d.texturePackFolder ? 'checked' : ''}> 纹理包与主文件放进同一个文件夹</label>
      <div class="desc">带「(纹理包)」的文件会和同名主文件放进同一个子文件夹，文件夹名用不带「(纹理包)」的那个。仅「保留原始文件」模式生效。</div>
    </div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setBiosGroup" ${d.biosGroupFolder ? 'checked' : ''}> BIOS 文件与主文件放进同一个文件夹</label>
      <div class="desc">带「(Bios)」的文件会和同名主文件放进同一个子文件夹，文件夹名用不带「(Bios)」的那个。仅「保留原始文件」模式生效。</div>
    </div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setPruneEmpty" ${d.pruneEmptyDirs !== false ? 'checked' : ''}> 移动后清理变空的子文件夹</label>
      <div class="desc">用「移动」整理后，源目录里被搬空的小文件夹会自动删掉（只删空的）。</div>
    </div>

    <div class="divider"></div>
    <div class="section-title">扫描选项</div>

    <div class="field">
      <label>匹配方式</label>
      <select class="input" id="setMatchMode">
        <option value="both" ${d.matchMode === 'both' ? 'selected' : ''}>CRC 优先，失败再用文件名（推荐）</option>
        <option value="crc" ${d.matchMode === 'crc' ? 'selected' : ''}>仅 CRC（最严格）</option>
        <option value="name" ${d.matchMode === 'name' ? 'selected' : ''}>仅文件名（最快，可能误判）</option>
      </select>
      <div class="desc">zip 内的 CRC 直接读目录，无需解压；裸文件需要完整读一遍，大文件首次扫描较慢，之后走缓存。</div>
    </div>

    <div class="field">
      <label>扫描深度</label>
      <select class="input" id="setScanMode">
        <option value="full" ${d.scanMode === 'full' ? 'selected' : ''}>完整校验（读取所有文件计算 CRC）</option>
        <option value="fast" ${d.scanMode === 'fast' ? 'selected' : ''}>快速（超过 64MB 的裸文件跳过 CRC）</option>
      </select>
    </div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setRecursive" ${d.recursive !== false ? 'checked' : ''}> 包含子目录</label>
    </div>

    <div class="divider"></div>
    <div class="section-title">游戏截图 / 封面</div>

    <div class="field">
      <label class="chk"><input type="checkbox" id="setCoverEnabled" ${assets.cover.enabled ? 'checked' : ''}> 在游戏列表中显示截图</label>
    </div>

    <div class="field">
      <label>截图存储位置</label>
      <div class="input-row">
        <input class="input mono" id="setCoverStore" value="${esc(assets.cover.storeDir || '')}" placeholder="留空 = 工具内 data/covers">
        <button class="btn" data-browse="coverStore">浏览…</button>
      </div>
      <div class="desc">上传或下载的截图保存在这里。指向自己的图片库目录，便于备份和在多个清单间复用。</div>
    </div>

    <div class="field">
      <label>已有截图目录（可选）</label>
      <div class="input-row">
        <input class="input mono" id="setCoverDir" value="${esc(assets.cover.dir || '')}" placeholder="OfflineList 图片包解压后的目录">
        <button class="btn" data-browse="coverDir">浏览…</button>
      </div>
      <div class="desc">按 <span class="mono">{im1CRC}.png</span> / <span class="mono">编号.png</span> / <span class="mono">标题.png</span> 自动匹配，只读不改动。</div>
    </div>

    <div class="field">
      <div class="cover-stat">
        <span>已有截图 <b id="coverCount">—</b></span>
        <span class="spacer"></span>
        <button class="btn small" id="btnProbeCover" title="测试订阅源的图片地址是否可用">地址测试</button>
        <button class="btn small" id="btnFetchCovers">下载缺失</button>
      </div>
      <div class="desc" id="coverRemoteHint">从 DAT 的 imURL 逐张下载，需要联网；也可以在列表里点缩略图手动上传。</div>
    </div>

    <div class="divider"></div>
    <div class="section-title">其他媒体（预留）</div>
    <div class="asset-row">
      <span class="ar-name">游戏截图集</span>
      <span class="ar-state">规划中</span>
      <label class="switch"><input type="checkbox" disabled><span></span></label>
    </div>
    <div class="asset-row">
      <span class="ar-name">视频</span>
      <span class="ar-state">规划中</span>
      <label class="switch"><input type="checkbox" disabled><span></span></label>
    </div>
    <div class="asset-row">
      <span class="ar-name">简介 / 元数据</span>
      <span class="ar-state">规划中</span>
      <label class="switch"><input type="checkbox" disabled><span></span></label>
    </div>

    <div class="divider"></div>
    <div class="section-title">DAT 信息</div>
    <div class="desc mono" style="line-height:1.8">
      文件：${esc(lib.datPath)}<br>
      版本：v${lib.datVersion}　游戏：${lib.stats.games}<br>
      更新源：${lib.newDat ? esc(lib.newDat.datVersionURL) : '无'}
    </div>

    <div class="divider"></div>
    <div class="section-title">存储位置</div>

    <div class="field">
      <label>DAT 保存位置</label>
      <div class="input-row">
        <input class="input mono" id="setDatDir" value="${esc((S.paths && S.paths.datDir) || '')}" placeholder="留空 = 数据目录下 dats/">
        <button class="btn" id="btnDatDir">浏览</button>
      </div>
      <div class="desc">导入与在线更新的 DAT 文件存放位置。飞牛上请先在「授权目录」里添加该路径。</div>
    </div>

    <div class="field">
      <label>图片保存位置</label>
      <div class="input-row">
        <input class="input mono" id="setCoverDir" value="${esc((S.paths && S.paths.coverDir) || '')}" placeholder="留空 = 数据目录下 covers/">
        <button class="btn" id="btnCoverDir">浏览</button>
      </div>
      <div class="desc">下载/上传的封面图片存放位置，每个清单在其下建独立子目录。清单里单独指定「截图存储位置」时以清单为准。</div>
    </div>

    <div class="field">
      <label>数据目录</label>
      <div class="input-row">
        <input class="input mono" id="setDataDir" value="${esc(S.dataDir)}" readonly>
        <button class="btn" id="btnCopyDataDir">复制</button>
      </div>
      <div class="desc">清单、设置与缓存都保存在此目录。它由启动参数决定（飞牛可在安装时设置），要改动需要重新安装或改环境变量后重启。</div>
    </div>
  `;

  // 交互绑定
  $$('#modeCards .mode-card').forEach((el) => {
    el.onclick = () => {
      d.mode = el.dataset.mode;
      $$('#modeCards .mode-card').forEach((x) => x.classList.toggle('on', x === el));
      refreshPreview(lib);
    };
  });

  // 命名模板
  const tplInputs = [$('#setFileTpl'), $('#setArcTpl')];
  let lastTplInput = tplInputs[0];
  tplInputs.forEach((inp) => inp.addEventListener('focus', () => { lastTplInput = inp; }));
  $('#setFileTpl').oninput = (e) => { d.fileTemplate = e.target.value; schedulePreview(lib); };
  $('#setArcTpl').oninput = (e) => { d.archiveTemplate = e.target.value; schedulePreview(lib); };
  $('#setEntryRename').onchange = (e) => { d.entryRename = e.target.checked; refreshPreview(lib); };

  // 占位符点击插入
  const TOKENS = [
    ['%n', '游戏名称'], ['%p', '发行厂商'], ['%i', '容量大小'], ['%u', '游戏编号'], ['%c', 'CRC'],
    ['%o', '发行国家'], ['%g', '发布来源'], ['%s', '存档类型'], ['%e', '备注'], ['%a', '语言'],
  ];
  $('#tokenBox').innerHTML = TOKENS
    .map(([k, v]) => `<span class="token" data-tok="${k}" title="插入 ${k}"><b>${k}</b>${v}</span>`).join('');
  $$('#tokenBox .token').forEach((t) => {
    t.onclick = () => {
      const inp = lastTplInput || $('#setFileTpl');
      const tok = t.dataset.tok;
      const s = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
      const e2 = inp.selectionEnd != null ? inp.selectionEnd : inp.value.length;
      inp.value = inp.value.slice(0, s) + tok + inp.value.slice(e2);
      inp.focus();
      inp.setSelectionRange(s + tok.length, s + tok.length);
      inp.dispatchEvent(new Event('input'));
    };
  });

  // 截图设置
  $('#setCoverEnabled').onchange = (e) => { S.draftAssets.cover.enabled = e.target.checked; };
  $('#setCoverStore').oninput = (e) => { S.draftAssets.cover.storeDir = e.target.value; };
  $('#setCoverDir').oninput = (e) => { S.draftAssets.cover.dir = e.target.value; };
  $('#btnFetchCovers').onclick = () => fetchCovers(lib);
  $('#btnProbeCover').onclick = () => probeCover(lib);
  if (S.coverInfo) {
    $('#coverCount').textContent = `${S.coverInfo.withCover} / ${S.coverInfo.total}`;
  } else {
    $('#coverCount').textContent = '—';
  }
  if (!lib.newDat || !lib.newDat.imURL) {
    $('#coverRemoteHint').innerHTML = '该 DAT 没有提供图片地址（imURL），请使用本地目录或手动上传。';
    $('#btnFetchCovers').disabled = true;
  }

  $$('input[name="op"]').forEach((r) => { r.onchange = () => { d.operation = r.value; }; });
  $('#setConflict').onchange = (e) => { d.conflict = e.target.value; };
  $('#setUnmatchedAction').onchange = (e) => {
    d.unmatchedAction = e.target.value;
    const row = $('#unmatchedDirRow');
    if (row) row.style.display = e.target.value === 'move' ? 'flex' : 'none';
  };
  $('#setUnmatchedDir').oninput = (e) => { d.unmatchedDir = e.target.value; };
  $('#setDuplicateAction').onchange = (e) => {
    d.duplicateAction = e.target.value;
    const row = $('#duplicateDirRow');
    if (row) row.style.display = e.target.value === 'move' ? 'flex' : 'none';
  };
  $('#setDuplicateDir').oninput = (e) => { d.duplicateDir = e.target.value; };
  $('#setMultiDisc').onchange = (e) => { d.multiDiscFolder = e.target.checked; };
  $('#setTexturePack').onchange = (e) => { d.texturePackFolder = e.target.checked; };
  $('#setBiosGroup').onchange = (e) => { d.biosGroupFolder = e.target.checked; };
  $('#setPruneEmpty').onchange = (e) => { d.pruneEmptyDirs = e.target.checked; };
  $('#setMatchMode').onchange = (e) => { d.matchMode = e.target.value; };
  $('#setScanMode').onchange = (e) => { d.scanMode = e.target.value; };
  $('#setRecursive').onchange = (e) => { d.recursive = e.target.checked; };
  $('#setRomDir').oninput = (e) => { d.romDir = e.target.value; };
  $('#setOutDir').oninput = (e) => { d.outDir = e.target.value; };
  $$('[data-browse]').forEach((b) => {
    const t = b.dataset.browse;
    const map = {
      romDir: d.romDir, outDir: d.outDir, unmatchedDir: d.unmatchedDir, duplicateDir: d.duplicateDir,
      coverStore: S.draftAssets.cover.storeDir, coverDir: S.draftAssets.cover.dir,
    };
    b.onclick = () => openFs(t, map[t]);
  });

  // 清单图标
  refreshIconPreview();
  $('#setIconText').oninput = (e) => {
    S.draft.iconText = e.target.value.slice(0, 4);
    if (S.draft.iconText) S.draft.iconFile = ''; // 文字生效时取消图片引用（旧文件在保存时清理）
    refreshIconPreview();
  };
  $('#btnIconUpload').onclick = () => $('#iconFilePicker').click();
  $('#btnIconClear').onclick = () => {
    S.draft.iconText = '';
    S.draft.iconFile = '';
    $('#setIconText').value = '';
    S.iconStamp++;
    refreshIconPreview();
  };

  // 数据目录
  $('#btnDatDir').onclick = () => openFs('gDatDir', $('#setDatDir').value.trim());
  $('#btnCoverDir').onclick = () => openFs('gCoverDir', $('#setCoverDir').value.trim());
  $('#btnCopyDataDir').onclick = async () => {
    try {
      await navigator.clipboard.writeText(S.dataDir || '');
      toast('数据目录路径已复制', 'ok');
    } catch (_) {
      $('#setDataDir').select();
      toast('请按 Ctrl+C 复制选中的路径', 'warn');
    }
  };

  refreshPreview(lib);
}

/* 清单图标预览：图片 > 文字 > 占位 */
function refreshIconPreview() {
  const box = $('#iconPreview');
  if (!box) return;
  const d = S.draft || {};
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (d.iconFile && lib) {
    box.innerHTML = `<img src="/api/libraries/${lib.id}/icon?v=${S.iconStamp}" alt="">`;
    const img = box.querySelector('img');
    if (img) img.onerror = () => { img.style.display = 'none'; };
  } else if (d.iconText) {
    box.textContent = d.iconText;
  } else {
    box.innerHTML = '<span class="icon-ph">无</span>';
  }
}

async function uploadIcon(file) {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib || !file) return;
  if (file.size > 4 << 20) { toast('图片不能超过 4MB', 'warn'); return; }
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/libraries/${lib.id}/icon?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    const r = await res.json();
    S.draft.iconFile = r.file;
    S.draft.iconText = '';
    $('#setIconText').value = '';
    S.iconStamp++; // 换了图必须绕过浏览器缓存，否则预览仍是旧图
    refreshIconPreview();
    toast('图标已上传，记得点「保存」', 'ok');
  } catch (e) {
    toast('上传失败：' + esc(e.message), 'err');
  }
}

/* ------------------------------------------------------------------ 命名预览 */
let previewTimer = null;
function schedulePreview(lib) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => refreshPreview(lib), 140);
}

async function refreshPreview(lib) {
  const d = S.draft;
  const sample = S.games[0];
  try {
    const r = await api(`/libraries/${lib.id}/preview-name`, {
      method: 'POST',
      body: {
        fileTemplate: d.fileTemplate,
        archiveTemplate: d.archiveTemplate,
        index: sample ? sample.index : undefined,
      },
    });
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#pvFile', r.fileName);
    set('#pvArc', r.archiveName);
    set('#pvEntry', d.entryRename === false ? '保留 ROM 原始文件名' : r.fileName);
  } catch (_) {
    /* 预览失败不影响保存 */
  }
}

function updatePreview(lib, sample) {
  $('#namePreview').textContent = renderNamePreview(S.draft, sample, lib);
}

async function saveSettings() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  const name = $('#setName') ? $('#setName').value.trim() : lib.name;
  try {
    // 图标图片引用被去掉时，同步删掉磁盘文件
    if (S.iconFileOpen && !S.draft.iconFile) {
      await api(`/libraries/${lib.id}/icon`, { method: 'DELETE' }).catch(() => {});
    }
    await api(`/libraries/${lib.id}`, {
      method: 'PATCH',
      body: { settings: S.draft, assets: S.draftAssets, name },
    });
    closeDrawer();
    S.coverStamp++;
    S.iconStamp++;
    toast('设置已保存', 'ok');
    await loadState();
    renderHeader(S.libs.find((l) => l.id === S.currentId));
    await loadCovers(true);
    applyFilter();
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

async function deleteLib() {
  const lib = S.libs.find((l) => l.id === S.currentId);
  if (!lib) return;
  if (!confirm(`确定从列表中移除「${lib.name}」？\n\n只会删除本工具里的清单记录，不会动你的 ROM 文件和原始 DAT。`)) return;
  await api(`/libraries/${lib.id}`, { method: 'DELETE' });
  closeDrawer();
  S.currentId = null;
  S.games = [];
  await loadState();
  if (!S.libs.length) resetMain();
}

/* ------------------------------------------------------------------ 目录选择 */
async function openFs(target, initial) {
  S.fsTarget = target;
  const TITLES = {
    romDir: '选择 ROM 源目录',
    outDir: '选择整理输出目录',
    gDatDir: '选择 DAT 保存位置',
    gCoverDir: '选择图片保存位置',
    unmatchedDir: '选择未识别文件存放目录',
    duplicateDir: '选择重复副本存放目录',
    coverStore: '选择截图存储位置',
    coverDir: '选择已有截图目录',
    inboxDir: '选择待分类文件夹',
  };
  $('#fsTitle').textContent = TITLES[target] || '选择目录';
  $('#fsModal').classList.add('show');
  await loadFs(initial || '');
}

async function loadFs(p) {
  try {
    const data = await api('/fs/list?path=' + encodeURIComponent(p));
    S.fsPath = data.path || '';
    S.fsAuthorized = data.authorizedPaths || [];
    $('#fsPath').textContent = data.path || (data.fnos ? '可用根目录' : '此电脑');
    // fnOS 且没有任何已授权目录时，在列表上方给出引导
    const hint = $('#fsHint');
    if (hint) {
      if (data.fnos && !data.path && !S.fsAuthorized.length) {
        hint.hidden = false;
        hint.textContent = '当前没有已授权的目录。请在 fnOS「应用中心 → ROMKit → 授权目录」中添加 ROM 所在目录，然后重开本窗口。';
      } else {
        hint.hidden = true;
      }
    }
    const rows = [];
    if (data.parent !== null && data.parent !== undefined) {
      rows.push(`<div class="fs-item" data-path="${esc(data.parent)}"><span class="ico">↰</span>上一级</div>`);
    }
    for (const d of data.dirs || []) {
      const locked = d.ok === false;
      rows.push(`<div class="fs-item${locked ? ' locked' : ''}" data-path="${esc(d.path)}">
        <span class="ico">${locked ? '🔒' : '▸'}</span>${esc(d.name)}
        ${locked ? '<span class="fs-tag">无权限</span>' : ''}</div>`);
    }
    for (const f of data.files || []) {
      rows.push(`<div class="fs-item file" data-path="${esc(f.path)}"><span class="ico">◻</span>${esc(f.name)}</div>`);
    }
    if (!rows.length) rows.push('<div class="fs-item"><span class="ico"></span><span class="muted">此目录为空</span></div>');
    const list = $('#fsList');
    list.innerHTML = rows.join('');
    $$('.fs-item[data-path]', list).forEach((el) => {
      el.onclick = () => {
        const p = el.dataset.path;
        if (el.classList.contains('file')) { list.dataset.picked = p; return; }
        loadFs(p);
      };
    });
    $('#fsShortcuts').innerHTML = (data.shortcuts || [])
      .map((s) => `<button data-p="${esc(s.path)}">${esc(s.name)}</button>`).join('')
      + '<button data-refresh="1" title="重新检测各目录的读写权限">重新检测权限</button>';
    $$('#fsShortcuts button').forEach((b) => {
      b.onclick = () => loadFs(b.dataset.refresh ? S.fsPath : b.dataset.p);
    });
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

/* ------------------------------------------------------------------ 读取失败诊断 */
function openDiag(list) {
  const modal = $('#diagModal');
  if (!modal) return;
  $('#diagTitle').textContent = `无法读取的文件（${list.length} 个）`;
  const onNas = /^\//.test(list[0] && list[0].path || '');
  // 特征识别：权限位 0000 = 连所有者都没有任何权限，chown 无效。
  // 典型场景：fnOS 用户个人空间（/volN/{uid}/…）的保护，或曾被 chmod 000。
  const zeroCount = list.filter((it) => it.diag && it.diag.mode === '0000').length;
  const zeroDir = (list[0] && list[0].path || '').match(/^(\/vol\d+\/\d+)\//);
  let banner = '';
  if (zeroCount) {
    const target = zeroDir ? `"${zeroDir[1]}"` : '这些文件所在目录';
    banner = `<div class="diag-banner"><b>${zeroCount} 个文件的权限位是 0000</b>（连所有者都没有任何权限，<b>修改所有者无法解决</b>）。` +
      (zeroDir ? `路径 <code>${esc(zeroDir[1])}/</code> 是 fnOS 的用户个人空间，受系统保护。` : '通常是 fnOS 用户个人空间的保护，或曾被 chmod 000。') +
      `请管理员在 fnOS 终端执行：<code>chmod -R u+rwX,go+rX ${esc(target)}</code>` +
      `；更推荐把 ROM 移到<b>共享文件夹</b>（如 /vol4/roms）后在「应用中心 → ROMKit → 授权目录」里授权它。</div>`;
  }
  $('#diagHelp').innerHTML = [
    '<b>怎么读这份清单：</b>',
    '· <code>EACCES</code>：文件或<b>任意一级父目录</b>没有读权限（Linux 要求每级父目录都能进）',
    onNas ? '· fnOS 用户：确认该目录已加到「应用中心 → ROMKit → 授权目录」，且文件权限不低于 644、目录不低于 755'
      : '· Windows 用户：确认文件没有被其他程序独占占用（如模拟器、压缩软件）',
    '· <code>ENOENT</code>：文件已不在原处，或是失效的软链接',
    '· <code>EPERM</code> / 其他：系统策略拦截或特殊文件',
    '行尾的权限信息（如 0600 uid=1000）就是当前实际状态，据此调整即可。',
  ].map((s) => `<div>${s}</div>`).join('') + banner;
  $('#diagList').innerHTML = list.map((it) => {
    const d = it.diag || {};
    const bits = [];
    if (d.mode) bits.push(d.mode);
    if (d.uid !== undefined) bits.push(`uid=${d.uid}`);
    if (d.gid !== undefined) bits.push(`gid=${d.gid}`);
    if (d.link) bits.push('软链接');
    if (d.parentMode) bits.push(`父目录 ${d.parentMode}`);
    if (d.parentBlocked) bits.push(`父目录不可访问(${d.parentBlocked})`);
    if (d.statError) bits.push(`无法 stat(${d.statError})`);
    return `<div class="fs-item"><span class="ico">⚠</span>
      <span style="flex:1;min-width:0;word-break:break-all">${esc(it.path)}</span>
      <span class="diag-meta">${esc(it.error)}${bits.length ? ' · ' + esc(bits.join(' · ')) : ''}</span></div>`;
  }).join('') || '<div class="fs-item"><span class="muted">没有明细</span></div>';
  const fixBtn = $('#diagFix');
  if (fixBtn) {
    fixBtn.onclick = async () => {
      fixBtn.disabled = true;
      try {
        const r = await api('/fs/fixperm', { method: 'POST', body: { paths: list.map((x) => x.path) } });
        toast(`权限修复：成功 ${r.fixed} 个，失败 ${r.failed} 个` +
          (r.failed ? '（已不是应用自有的文件，需管理员 chmod）' : '') +
          `<br><span style="font-size:11px;color:var(--text-3)">修复后请重新扫描</span>`, r.failed ? 'warn' : 'ok', 9000);
        if (!r.failed) modal.classList.remove('show');
      } catch (e) {
        toast('修复失败：' + esc(e.message), 'err');
      }
      fixBtn.disabled = false;
    };
  }
  modal.classList.add('show');
}

async function pickFs() {
  const p = S.fsPath;
  if (!p) { toast('请先进入一个目录', 'warn'); return; }
  // fnOS：所选目录不在已授权目录内时预警（后续扫描/整理会因权限失败）
  const auth = S.fsAuthorized || [];
  if (auth.length && !auth.some((a) => p === a || p.startsWith(a.replace(/\/+$/, '') + '/'))) {
    toast('该目录不在已授权目录中，fnOS 可能无法读写；请到「应用中心 → ROMKit → 授权目录」添加', 'warn', 8000);
  }
  const map = {
    romDir: [S.draft, 'romDir', '#setRomDir'],
    outDir: [S.draft, 'outDir', '#setOutDir'],
    unmatchedDir: [S.draft, 'unmatchedDir', '#setUnmatchedDir'],
    duplicateDir: [S.draft, 'duplicateDir', '#setDuplicateDir'],
    coverStore: [S.draftAssets.cover, 'storeDir', '#setCoverStore'],
    coverDir: [S.draftAssets.cover, 'dir', '#setCoverDir'],
  };
  const hit = map[S.fsTarget];
  if (hit) {
    hit[0][hit[1]] = p;
    const el = $(hit[2]);
    if (el) el.value = p;
  } else if (S.fsTarget === 'inboxDir') {
    await saveInboxDir(p);
  } else if (S.fsTarget === 'gDatDir' || S.fsTarget === 'gCoverDir') {
    await saveGlobalPath(S.fsTarget === 'gDatDir' ? 'datDir' : 'coverDir', p);
  }
  $('#fsModal').classList.remove('show');
}

/* ------------------------------------------------------------------ 添加 DAT */
async function importFiles(files) {
  const list = [...files].filter((f) => /\.(zip|xml)$/i.test(f.name));
  if (!list.length) { toast('只支持 .zip 或 .xml 格式的 DAT', 'warn'); return; }
  for (const f of list) {
    try {
      const buf = await f.arrayBuffer();
      const r = await api('/libraries/import?name=' + encodeURIComponent(f.name), { method: 'POST', body: buf });
      if (r.skipped) {
        toast(`「${esc(r.library.name)}」已存在 v${esc(r.existingVersion)}，高于或等于这个版本，未导入`, 'warn', 7000);
      } else if (r.replaced) {
        toast(`「${esc(r.library.name)}」已从 v${esc(r.oldVersion)} 更新到 v${esc(r.library.datVersion)}`, 'ok', 6000);
      } else {
        toast(`已添加：${esc(r.library.name)}（${r.library.stats.games} 个游戏）`, 'ok');
      }
    } catch (e) {
      toast(`添加 ${esc(f.name)} 失败：${esc(e.message)}`, 'err', 6000);
    }
  }
  await loadState();
  const last = S.libs[S.libs.length - 1];
  if (last) selectLib(last.id);
  if (list.length) { setTimeout(openDrawer, 300); }
}

async function addByPath() {
  const p = await prompt2('从本地路径添加 DAT', '输入 DAT 文件的完整路径（.zip 或 .xml）', 'D:\\ROMs\\CHS_PS2_OL.zip');
  if (!p) return;
  try {
    const r = await api('/libraries', { method: 'POST', body: { path: p } });
    if (r.skipped) {
      toast(`「${esc(r.library.name)}」已存在 v${esc(r.existingVersion)}，高于或等于这个版本，未导入`, 'warn', 7000);
    } else if (r.replaced) {
      toast(`「${esc(r.library.name)}」已从 v${esc(r.oldVersion)} 更新到 v${esc(r.library.datVersion)}`, 'ok', 6000);
    } else {
      toast(`已添加：${esc(r.library.name)}`, 'ok');
    }
    await loadState();
    selectLib(r.library.id);
    setTimeout(openDrawer, 300);
  } catch (e) {
    toast(esc(e.message), 'err', 6000);
  }
}

let promptResolve = null;
function prompt2(title, hint, placeholder = '') {
  $('#promptTitle').textContent = title;
  $('#promptHint').textContent = hint;
  $('#promptInput').value = '';
  $('#promptInput').placeholder = placeholder;
  $('#promptModal').classList.add('show');
  $('#promptInput').focus();
  return new Promise((resolve) => { promptResolve = resolve; });
}
function closePrompt(v) {
  $('#promptModal').classList.remove('show');
  if (promptResolve) { promptResolve(v); promptResolve = null; }
}

/* ------------------------------------------------------------------ 事件绑定 */
function bind() {
  $('#btnAddDat').onclick = () => $('#filePicker').click();
  $('#filePicker').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };

  // 只有存在时才绑定（老页面结构兼容）
  const bindIf = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  bindIf('#btnScan', doScan);
  bindIf('#btnOrganize', doOrganize);
  bindIf('#btnUpdate', doUpdate);
  bindIf('#btnClearCache', clearLibCache);
  $('#btnClearAllCache').onclick = clearAllCache;
  // 批量操作在左侧（只对当前选中的分组生效）
  $('#btnBulk').onclick = (e) => {
    e.stopPropagation();
    $('#bulkMenu').classList.toggle('open');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) {
      $('#bulkMenu').classList.remove('open');
      $('#catMenu').classList.remove('open');
    }
  });
  $$('#bulkMenu button').forEach((b) => {
    b.onclick = () => {
      $('#bulkMenu').classList.remove('open');
      // 批量操作改为按当前选中的分类执行（默认是「全部」）
      bulkRunForCat(S.currentCat || ALL_CAT, b.dataset.bulk);
    };
  });
  // 左侧「全部」按钮 = 快速切换分类；右侧齿轮 = 打开二级分类管理
  $('#catChip').onclick = (e) => {
    e.stopPropagation();
    $('#catMenu').classList.toggle('open');
  };
  $('#catMenu').onclick = (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    $('#catMenu').classList.remove('open');
    S.currentCat = btn.dataset.cat;
    S.libQuery = '';
    const ls = $('#libSearch');
    if (ls) ls.value = '';
    renderCats();
    renderLibs();
  };
  $('#btnCatManage').onclick = () => openCatModal();
  const ls = $('#libSearch');
  if (ls) ls.oninput = () => { S.libQuery = ls.value; renderLibs(); };
  $('#catClose').onclick = $('#catOk').onclick = () => $('#catModal').classList.remove('show');
  $('#btnCatAddRoot').onclick = async () => {
    await addCat(null);
    openCatModal();
  };
  // 弹窗内的操作统一走事件委托（每次重渲染后依然有效）
  const tree = $('#catTree');
  if (tree) {
    tree.addEventListener('click', async (e) => {
      const t = e.target;
      const gid = (k) => t.dataset[k];
      if (gid('fold')) { S.catFolded[gid('fold')] = !S.catFolded[gid('fold')]; renderCatTree(); return; }
      if (gid('catup')) return swapOrder('cat', gid('catup'), -1);
      if (gid('catdown')) return swapOrder('cat', gid('catdown'), 1);
      if (gid('catren')) return renameCat(gid('catren'));
      if (gid('caticon')) return pickCatIcon(gid('caticon'));
      if (gid('catunicon')) return clearCatIcon(gid('catunicon'));
      if (gid('catadd')) return addCat(gid('catadd'));
      if (gid('catdel')) return delCat(gid('catdel'));
      if (gid('libup')) return moveLib(gid('libup'), -1);
      if (gid('libdown')) return moveLib(gid('libdown'), 1);
    });
  }
  $('#btnLibSettings').onclick = () => { if (S.currentId) openDrawer(); else toast('先选择一个清单', 'warn'); };

  // 待分类文件夹（全局，文件夹按钮弹窗配置）
  refreshInboxBtn();
  $('#btnInboxBrowse').onclick = () => openFs('inboxDir', (S.ui && S.ui.inboxDir) || '');
  $('#btnClassify').onclick = classifyAll;

  $('#btnCloseDrawer').onclick = closeDrawer;
  $('#btnCancelSettings').onclick = closeDrawer;
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnDeleteLib').onclick = deleteLib;
  $('#scrim').onclick = () => closeDrawer();

  let tmr;
  $('#searchInput').oninput = (e) => {
    S.search = e.target.value;
    clearTimeout(tmr);
    tmr = setTimeout(applyFilter, 120);
  };

  const wrap = $('.table-wrap');
  wrap.addEventListener('scroll', () => {
    if (wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 240 && S.rendered < S.filtered.length) {
      renderTable(false);
    }
  });

  $$('thead th').forEach((th) => {
    th.style.cursor = 'pointer';
    th.onclick = () => {
      const map = { '游戏标题': 'title', '发行商 / 汉化': 'publisher', '大小': 'size', 'CRC': 'crc' };
      const key = map[th.textContent.trim()];
      if (!key) return;
      if (S.sort.key === key) S.sort.dir *= -1;
      else S.sort = { key, dir: 1 };
      applyFilter();
    };
  });

  // 拖放
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('#dropzone').classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropzone').classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropzone').classList.remove('show');
    if (e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  $('#fsClose').onclick = $('#fsCancel').onclick = () => $('#fsModal').classList.remove('show');
  $('#fsPick').onclick = pickFs;

  $('#diagClose').onclick = $('#diagOk').onclick = () => $('#diagModal').classList.remove('show');
  $('#planClose').onclick = $('#planCancel').onclick = () => $('#planModal').classList.remove('show');

  // 截图 / 详情
  $('#gameBody').addEventListener('click', (e) => {
    const cov = e.target.closest('[data-cover]');
    if (cov) {
      e.preventDefault();
      e.stopPropagation();
      openCover(parseInt(cov.dataset.cover, 10));
      return;
    }
    const tr = e.target.closest('tr[data-index]');
    if (tr) openDetail(parseInt(tr.dataset.index, 10));
  });
  $('#coverClose').onclick = () => $('#coverModal').classList.remove('show');
  $('#coverUpload').onclick = () => $('#coverFilePicker').click();
  $('#coverFilePicker').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadCover(f);
    e.target.value = '';
  };
  $('#coverDelete').onclick = deleteCover;

  // 清单图标上传
  $('#iconFilePicker').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadIcon(f);
    e.target.value = '';
  });

  // 分组分隔图片上传
  $('#catIconPicker').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadCatIcon(f);
    e.target.value = '';
  });

  $('#probeClose').onclick = $('#probeOk').onclick = () => $('#probeModal').classList.remove('show');

  $('#promptClose').onclick = $('#promptCancel').onclick = () => closePrompt(null);
  $('#promptOk').onclick = () => closePrompt($('#promptInput').value);
  $('#promptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closePrompt($('#promptInput').value);
    if (e.key === 'Escape') closePrompt(null);
  });

  $('#btnTheme').onclick = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    localStorage.setItem('romkit.theme', dark ? 'light' : 'dark');
    refreshThemeBtn();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#promptModal').classList.contains('show')) closePrompt(null);
      else if ($('#coverModal').classList.contains('show')) $('#coverModal').classList.remove('show');
      else if ($('#probeModal').classList.contains('show')) $('#probeModal').classList.remove('show');
      else if ($('#fsModal').classList.contains('show')) $('#fsModal').classList.remove('show');
      else if ($('#planModal').classList.contains('show')) $('#planModal').classList.remove('show');
      else if ($('#drawer').classList.contains('open')) closeDrawer();
    }
    if (e.key === 'F5' && !e.ctrlKey) return;
  });
}

/* ------------------------------------------------------------------ 启动 */
async function init() {
  const theme = localStorage.getItem('romkit.theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  refreshThemeBtn();
  bind();
  initSSE();
  try {
    await loadState();
  } catch (e) {
    toast('无法连接本地服务：' + esc(e.message), 'err', 8000);
  }
  // 支持 ?lib=<id>&drawer=1&dark=1 直达视图（也可作为书签）
  const qs = new URLSearchParams(location.search);
  if (qs.get('dark') === '1') {
    document.documentElement.setAttribute('data-theme', 'dark');
    refreshThemeBtn();
  }
  if (qs.get('lib')) {
    const lib = S.libs.find((l) => l.id === qs.get('lib')) || S.libs[0];
    if (lib) { await selectLib(lib.id); }
  }
  if (qs.get('drawer') === '1' && S.currentId) openDrawer();
  if (qs.get('detail') === '1' && S.games.length) openDetail(S.games[0].index);
  if (qs.get('q')) {
    const inp = $('#searchInput');
    if (inp) {
      inp.value = qs.get('q');
      S.search = qs.get('q');
      applyFilter();
    }
  }
  if (qs.get('probe') === '1' && S.currentId) probeCover(S.libs.find((l) => l.id === S.currentId));
  if (qs.get('plan') === '1' && S.currentId) doOrganize();
}

init();
