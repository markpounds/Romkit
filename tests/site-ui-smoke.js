/* 站点信息 UI 冒烟测试（不联网、不开浏览器）
 *
 * 做法：按大括号配对从 web/app.js 抠出真实的 siteBlock / siteFoot /
 * renderDetailImage / bindVideoThumb / bvOf 源码，配一个极简 DOM stub 在 Node 里跑。
 * 好处：测的就是上线那份代码，改坏函数名或挪了逻辑这里立刻红。
 *
 * 覆盖：站点区块渲染与转义、合并条目按子条目取数、未同步引导、
 *       非 emugif 库隐藏、B 站视频入口（提取 BV 号 / 缩略图栏 / 内嵌播放器 /
 *       常驻进度条 / 切回图片）。
 */
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✓' : '✗'} ${n}${c || e == null || e === '' ? '' : ' → ' + e}`);
};

/** 按大括号配对抠出一个顶层函数（模板串里的 ${} 自身配对，不影响计数） */
function extract(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到函数 ' + name + '（被改名了？同步更新本测试）');
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('括号没配对：' + name);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---- 极简 DOM stub：$ 按选择器返回持久假元素 ---- */
const els = {};
function classList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    contains: (c) => s.has(c),
  };
}
function fakeEl(sel) {
  if (!els[sel]) {
    els[sel] = {
      id: sel, innerHTML: '', onclick: null, dataset: {}, _kids: {}, classList: classList(),
      querySelector(s) {
        if (!this._kids[s]) this._kids[s] = { style: {}, onerror: null };
        return this._kids[s];
      },
    };
  }
  return els[sel];
}
const $ = (sel) => fakeEl(sel);
const $$ = () => [];

const S = {
  detailGame: { index: 7, title: '测试游戏' },
  dtSlots: [], dtIdx: 0, dtVideo: false, dtCoverIdx: 7, coverStamp: 1,
  sites: {}, siteInfo: null, currentId: 'lib_x',
};
const openCover = () => {};

const fns = new Function('$', '$$', 'esc', 'S', 'openCover', [
  extract('bvOf'),
  extract('renderDetailImage'),
  extract('bindVideoThumb'),
  extract('bindVideoBar'),
  extract('siteFoot'),
  extract('siteBlock'),
  'return { bvOf, renderDetailImage, bindVideoThumb, bindVideoBar, siteBlock };',
].join('\n'))($, $$, esc, S, openCover);
const { bvOf, renderDetailImage, bindVideoThumb, bindVideoBar, siteBlock } = fns;

const reset = () => { for (const k of Object.keys(els)) delete els[k]; };

(async () => {
  console.log('\n[1] BV 号提取');
  ok('普通 BV 链接', (bvOf(['https://www.bilibili.com/video/BV1h4421c7yK/']) || {}).bvid === 'BV1h4421c7yK');
  ok('非 B 站链接返回 null', bvOf(['https://www.123pan.com/s/xxx']) === null);
  ok('空 / 缺参返回 null', bvOf([]) === null && bvOf(null) === null);
  const b2 = bvOf(['https://a.cn/1', 'https://b23.tv/BV1abcXXXXX9']);
  ok('多个链接取第一个命中的', (b2 || {}).bvid === 'BV1abcXXXXX9');
  ok('过短的 BV 不是视频号', bvOf(['https://x.cn/BV123']) === null);

  console.log('\n[2] 图片模式 + 视频入口');
  reset();
  S.dtSlots = [{ slot: 'a', label: '封面', source: 'local' }, { slot: 'b', label: '截图', source: 'tool' }];
  S.dtIdx = 0;
  S.sites = { 7: { links: ['https://www.bilibili.com/video/BV1h4421c7yK/'], comment: '说明' } };
  S.dtVideo = false;
  renderDetailImage();
  let cover = els['#detailCover'].innerHTML;
  let thumbs = els['#detailThumbs'].innerHTML;
  ok('大图还是封面', cover.includes('dtBigImg') && !cover.includes('iframe'));
  ok('缩略图栏出现「视频」入口', thumbs.includes('dtVideoThumb') && thumbs.includes('视频'));
  ok('视频排在「添加」之前', thumbs.indexOf('dtVideoThumb') < thumbs.indexOf('dtAddThumb'));
  ok('入口带播放三角', thumbs.includes('class="play"'));
  ok('入口用 B 站封面当缩略图', thumbs.includes('class="vthumb"') && thumbs.includes('/api/bili/cover/BV1h4421c7yK'));
  ok('入口已绑定点击', typeof els['#dtVideoThumb'].onclick === 'function');
  ok('封面加载失败会回退到三角', typeof els['#dtVideoThumb'].querySelector('.vthumb').onerror === 'function');

  console.log('\n[3] 点击「视频」→ 大图区开始播放');
  els['#dtVideoThumb'].onclick();
  cover = els['#detailCover'].innerHTML;
  thumbs = els['#detailThumbs'].innerHTML;
  ok('大图区换成 B 站播放器', cover.includes('iframe') && cover.includes('player.bilibili.com'));
  ok('自动开播', cover.includes('autoplay=1'));
  ok('BV 号进了播放地址', cover.includes('bvid=BV1h4421c7yK'));
  ok('标注「B 站视频」', cover.includes('B 站视频'));
  ok('视频入口高亮', thumbs.includes('dt-thumb video on'));
  ok('封面/截图缩略图还在', thumbs.includes('封面') && thumbs.includes('截图'));
  ok('带自动播放授权（有声播放的关键）', cover.includes('allow="autoplay') && cover.includes('autoplay=1'));
  ok('不加 sandbox（会拦掉播放器控制栏）', !cover.includes('sandbox='));
  ok('下方常驻进度条（不依赖 B 站 hover 控制栏）', cover.includes('dt-video-ctrl') && cover.includes('dt-progress') && cover.includes('dt-vtime'));
  ok('进度条初始时间 0:00 / 0:00', cover.includes('0:00 / 0:00'));
  ok('播放 / 静音按钮齐备', cover.includes('id="dtVPlay"') && cover.includes('id="dtVMute"'));
  ok('已绑定进度条渲染函数（bindVideoBar 不报错）', typeof bindVideoBar === 'function');

  console.log('\n[4] 点回封面 → 回图片模式');
  S.dtIdx = 0;
  S.dtVideo = false;
  renderDetailImage();
  cover = els['#detailCover'].innerHTML;
  ok('回到封面显示', cover.includes('dtBigImg') && !cover.includes('iframe'));

  console.log('\n[5] 没有视频链接时不出现入口');
  reset();
  S.sites = { 7: { links: ['https://www.123pan.com/s/x'], comment: '没视频' } };
  S.dtVideo = false;
  renderDetailImage();
  ok('无「视频」入口', !els['#detailThumbs'].innerHTML.includes('dtVideoThumb'));
  ok('绑定函数缺参静默返回', bindVideoThumb(null) === undefined);

  console.log('\n[6] 站点区块：有链接有说明');
  reset();
  S.siteInfo = { supported: true, synced: true, matched: 10, games: 20, consoleType: 'md', fetchedAt: 1793121038451 };
  S.sites = { 7: { links: ['https://a.cn/1', 'https://b.cn/2'], comment: '这是发布说明', url: 'https://dat.emugif.com/html/game-edit.html?id=11&mode=info&consoleType=md' } };
  let h = siteBlock({ index: 7 }, { index: 7 });
  ok('有「站点信息」标题', h.includes('站点信息'));
  ok('有「发布链接」「发布说明」', h.includes('发布链接') && h.includes('发布说明'));
  ok('链接渲染成 site-link', /class="site-link"[^>]*href="https:\/\/a\.cn\/1"/.test(h));
  ok('说明文本出来了', h.includes('这是发布说明'));
  ok('有「在站点打开」', h.includes('在站点打开') && h.includes('game-edit.html'));
  ok('有「重新获取」', h.includes('btnSiteRefresh'));
  ok('显示同步时间', /同步于 \d{4}-\d{2}-\d{2}/.test(h));

  console.log('\n[7] 站点区块：转义防注入');
  S.sites = { 8: { links: ['https://x.cn/?a=1&b=2'], comment: '<script>alert(1)</script>', url: 'https://dat.emugif.com/x' } };
  h = siteBlock({ index: 8 }, { index: 8 });
  ok('说明里的 <script> 被转义', !h.includes('<script>') && h.includes('&lt;script&gt;'));
  ok('链接里的 & 被转义', h.includes('&amp;b=2'));

  console.log('\n[8] 站点区块：合并条目按当前子条目取');
  S.sites = { 23: { links: [], comment: '' }, 24: { links: ['https://c.cn/'], comment: '子条目 24 的说明', url: '' } };
  const merged = { index: 23, crcs: [], children: [{ index: 23 }, { index: 24 }] };
  h = siteBlock(merged, { index: 24 });
  ok('切到子条目 24 显示它的说明', h.includes('子条目 24 的说明') && h.includes('https://c.cn/'));
  h = siteBlock(merged, { index: 23 });
  ok('子条目没内容时提示没有', h.includes('站点上没有这一条'));

  console.log('\n[9] 站点区块：未同步引导 / 非 emugif 隐藏 / 视频标记');
  S.siteInfo = { supported: true, synced: false };
  h = siteBlock({ index: 1 }, { index: 1 });
  ok('提示未同步', h.includes('未同步') && h.includes('获取站点数据'));
  ok('有获取按钮 id', h.includes('id="btnSiteSync"'));
  S.siteInfo = { supported: false };
  ok('非 emugif 库整个区块不出现', siteBlock({ index: 1 }, { index: 1 }) === '');
  S.siteInfo = { supported: true, synced: true, matched: 3, games: 9, consoleType: 'md', fetchedAt: Date.now() };
  S.sites = { 9: { links: ['https://www.bilibili.com/video/BV1h4421c7yK/', 'https://www.123pan.com/s/x'], comment: '说明', url: 'https://dat.emugif.com/x' } };
  h = siteBlock({ index: 9 }, { index: 9 });
  ok('B 站链接标了「视频」', h.includes('BV1h4421c7yK') && h.includes('视频'));
  ok('普通链接没标「视频」', !/123pan[^<]*<\/a>\s*<span class="pill">视频</.test(h));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃', e); process.exit(1); });
