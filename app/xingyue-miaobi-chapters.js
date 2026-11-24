/* 妙笔写作 · 读章节（左栏目录容器版）
 *
 * 这是「一次调用 = 3 屏」的分片脚本，由主进程循环调用（xingyue-main.js）：
 *   CFG.phase = 'init'  → 重新锁定左栏目录容器、回到顶部、先扫一遍
 *   CFG.phase = 'step'  → 在该容器内往下滚 3 屏，边滚边扫
 *
 * 设计要点（对应交接说明的修正方向）：
 *   1. 先锁定「左侧目录」父容器（含「第1卷 / 91章 / 21.11万字」的那块），不用全文扫描，
 *      避免把正文里的「第N章 标题」当成目录行；
 *   2. 只在容器内扫「第N章」行，行首锚定，行内只取最短的那一层行元素；
 *   3. 真·滚动容器（不是页面），每调用滚 3 屏、每帧滚 <1 屏保证不跳行；
 *   4. 结果累积去重，主进程最后按章号排序。
 *
 * 页面内状态挂在 window.__mbState 上，跨多次 executeJavaScript 复用（同一文档内有效）。
 */
(async () => {
  const CFG = window.__mbCfg || {};
  const PHASE = CFG.phase === 'init' ? 'init' : 'step';

  // 每次调用滚几屏（默认 3 屏）；单帧滚动比例必须 <1，靠重叠防止虚拟列表跳行
  const FRAMES = Math.max(1, Math.min(12, Number(CFG.frames) || 3));
  const SCREEN = Math.max(0.3, Math.min(1.2, Number(CFG.screens) || 0.8));
  const DELAY = Math.max(80, Math.min(1500, Number(CFG.delay) || 230));
  const MAX_ROW = 120;          // 单行文本长度上限
  const MAX_BOX_TEXT = 40000;   // 容器文本长度上限（超过说明选到整个页面了）

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const txt = (el) => String((el && (el.innerText != null ? el.innerText : el.textContent)) || '')
    .replace(/[\s\u00a0]+/g, ' ').trim();

  /* ---------- 章号解析（支持 84 / 八十四 / 一百零四） ---------- */
  const ROW_RE = /^第\s*([0-9０-９]+|[〇零一二三四五六七八九十百千两]{1,8})\s*[章回]/;
  const DIG = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const UNI = { '十': 10, '百': 100, '千': 1000 };

  function cnToNum(s) {
    let total = 0, digit = 0, seen = false;
    for (const ch of String(s)) {
      if (DIG[ch] != null) { digit = DIG[ch]; seen = true; }
      else if (UNI[ch]) {
        const u = UNI[ch];
        if (digit === 0) digit = 1;
        total += digit * u;
        digit = 0;
        seen = true;
      } else return 0;
    }
    return seen ? total + digit : 0;
  }

  function toNum(raw) {
    const s = String(raw || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    if (/^[0-9]+$/.test(s)) return Number(s) || 0;
    return cnToNum(s);
  }

  /* ---------- 行文本 → 章节对象 ---------- */
  function parseRowText(t, wordsFixed) {
    const m = ROW_RE.exec(t);
    if (!m) return null;
    const num = toNum(m[1]);
    if (!num) return null;

    const rest = t.slice(m[0].length).trim();
    let words = Number(wordsFixed) || 0;
    let title = rest;

    if (!words) {
      const wm = /([0-9][\d,]*)\s*字/.exec(rest);
      if (wm) {
        words = Number(wm[1].replace(/[^\d]/g, ''));
        title = rest.slice(0, wm.index);
      }
    } else {
      // 字数已经从单独的节点取到了，标题里残留的「N字」切掉
      title = rest.replace(/[0-9][\d,]*\s*字.*$/, '');
    }

    title = title
      .replace(/[·•・:：\-–—]+\s*$/, '')
      .replace(/^\s*[·•・:：\-–—]+\s*/, '')
      .replace(/^[\s|｜]+/, '')
      .trim();

    return { num: num, title: title.slice(0, 40), words: words, draft: false };
  }

  // 结构化读一行：章名与字数常被拆成两个兄弟节点，各取各的，避免「标题84」+「2084字」粘成 842084
  function readRow(el) {
    const rowText = txt(el);
    const nodes = [el].concat(Array.from(el.querySelectorAll('span,div,em,i,b,p,a')));
    let head = '';
    let words = 0;
    for (let i = 0; i < nodes.length; i++) {
      const t = txt(nodes[i]);
      if (!t || t.length > 160) continue;
      if (ROW_RE.test(t) && (!head || t.length < head.length)) head = t;
      if (!words) {
        const wm = /^([0-9][\d,]*)\s*字\s*$/.exec(t);
        if (wm) words = Number(wm[1].replace(/[^\d]/g, ''));
      }
    }
    const p = parseRowText(head || rowText, words);
    if (!p) return null;
    p.draft = /草稿|创建于|删除|概要|待发布/.test(rowText);
    return p;
  }

  /* ---------- 找「最短那一层的章节行」 ---------- */
  // 行元素：自身文本以「第N章」开头、长度不夸张、内部没有更小的章节行
  function rowSeeds(root) {
    const out = [];
    const nodes = root.querySelectorAll('div,li,a,span,p,td,dd');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.childElementCount > 8) continue;
      // 便宜的先筛（textContent 不触发布局），再用 innerText 精判，避免整页 innerText 卡死
      const tc = el.textContent || '';
      if (tc.length < 3 || tc.length > MAX_ROW + 20) continue;
      if (tc.indexOf('章') < 0 && tc.indexOf('回') < 0) continue;

      const t = txt(el);
      if (t.length < 3 || t.length > MAX_ROW) continue;
      if (!ROW_RE.test(t)) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 6) continue;   // 未渲染的回收节点直接跳过

      let hasInner = false;
      const inner = el.querySelectorAll('div,li,a,span,p');
      for (let k = 0; k < inner.length; k++) {
        if (ROW_RE.test(txt(inner[k]))) { hasInner = true; break; }
      }
      if (hasInner) continue;
      out.push(el);
    }
    return out;
  }

  // 往上扩 1~3 层，把「章名 / 字数」这种被拆成兄弟节点的行合成一整行
  function expandRow(el) {
    let best = el, n = el;
    for (let i = 0; i < 4 && n && n.parentElement; i++) {
      const p = n.parentElement;
      const t = txt(p);
      if (t.length > 160) break;
      if (!ROW_RE.test(t)) break;
      if ((t.match(/第\s*[0-9０-９〇零一二三四五六七八九十百千两]{1,8}\s*[章回]/g) || []).length > 1) break;
      best = p;
      n = p;
      if (/[0-9][\d,]*\s*字/.test(t)) break;        // 已经拿到字数就够
    }
    return best;
  }

  function snapInto(acc, root) {
    if (!root) return 0;
    for (const el of rowSeeds(root)) {
      const p = readRow(expandRow(el)) || readRow(el);
      if (!p) continue;
      if (!acc.has(p.num)) acc.set(p.num, p);
    }
    // 顺手把页面自己请求到的章节数据并进来（比扒 DOM 准得多）
    mergeApiRows(acc);
    return acc.size;
  }

  /* ---------- 页面接口数据 ----------
   * 妙笔的目录是分页/虚拟的：DOM 里只放十几二十行，"滚到底"也只是真的到底了。
   * 所以真正的全量要从页面自己的接口拿：
   *   1) xingyue-net-hook.js 提前钩住 fetch/XHR，页面请求过的章节数据会存进 __mbApiRows；
   *   2) 这里再用 performance 资源计时找出页面请求过的「章节」接口地址，补拉一次。
   * 两条都按「书」隔离，换个作品就清空，避免串书。
   */
  const bookKeyOf = (u) => {
    const m = /\/books\/([A-Za-z0-9_-]+)/.exec(String(u || ''));
    return m ? m[1] : '';
  };

  function apiRowsOfThisBook() {
    const rows = window.__mbApiRows;
    if (!Array.isArray(rows) || !rows.length) return [];
    const here = bookKeyOf(location.href);
    const tagged = window.__mbBook || '';
    // 页面上有书号时，只认这本书的数据；拿不准就宁可不用，也不串书
    if (here && tagged && here !== tagged) return [];
    return rows;
  }

  function mergeApiRows(acc) {
    const rows = apiRowsOfThisBook();
    if (!rows.length) return;
    for (const r of rows) if (r && r.num && !acc.has(r.num)) acc.set(r.num, r);
  }

  // 从「页面请求过的接口」里找出章节列表，补拉一次拿全量
  // 自带解析：不依赖 xingyue-net-hook.js 有没有注入过（钩子只是提前抓，属加分项）
  async function probeApi() {
    const info = window.__mbProbe = { cands: 0, got: 0, urls: [], rows: 0 };
    try {
      const list = (typeof performance !== 'undefined' && performance && performance.getEntriesByType) ? performance.getEntriesByType('resource') : [];
      const cands = [];
      for (const e of (list || [])) {
        const it = String(e.initiatorType || '');
        if (it !== 'fetch' && it !== 'xmlhttprequest') continue;
        const u = String(e.name || '');
        if (!/^https?:/i.test(u)) continue;
        if (!/chapter/i.test(u)) continue;
        if (cands.indexOf(u) < 0) cands.push(u);
      }
      info.cands = cands.length;
      info.urls = cands.slice(0, 4).map((u) => u.slice(0, 160));
      for (const u of cands.slice(0, 4)) {
        try {
          const r = await fetch(u, { credentials: 'same-origin' });
          if (!r || !r.ok) continue;
          const t = await r.text();
          info.got++;
          noteApiTotal(t);
          const rows = apiRowsFromJson(t);
          if (rows.length) { info.rows += rows.length; absorbApiRows(rows); }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    return info;
  }

  /* ---- 接口 JSON → 章节行（自带一套，不依赖钩子） ---- */
  function apiRowOf(o) {
    if (!o || typeof o !== 'object') return null;
    let num = 0;
    for (const k of ['chapterNumber', 'chapter_number', 'chapterNo', 'chapter_no', 'number', 'num', 'index', 'order', 'sort', 'serial']) {
      const v = o[k];
      if (typeof v === 'number' && v > 0) { num = Math.floor(v); break; }
      if (typeof v === 'string' && /^\d+$/.test(v)) { num = Number(v); break; }
    }
    let title = '';
    for (const k of ['title', 'name', 'chapterTitle', 'chapter_title', 'chapterName', 'chapter_name', 'content_title']) {
      if (typeof o[k] === 'string' && o[k].trim()) { title = o[k].trim(); break; }
    }
    let words = 0;
    for (const k of ['wordCount', 'word_count', 'words', 'charCount', 'char_count', 'wordNum', 'word_num']) {
      if (typeof o[k] === 'number' && o[k] >= 0) { words = Math.round(o[k]); break; }
    }
    const m = /^\s*第\s*([0-9０-９]+)\s*[章回]/.exec(title);
    if (m) {
      const n2 = Number(String(m[1]).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
      if (n2 && !num) num = n2;
      title = title.slice(m[0].length).trim();
    }
    if (!num) return null;
    return { num: num, title: title.slice(0, 40), words: words, draft: false };
  }

  function apiRowsFromJson(text) {
    let j = null;
    try { j = JSON.parse(text); } catch (e) { return []; }
    let best = null;
    const look = (v, d) => {
      if (!v || typeof v !== 'object' || d > 4) return;
      if (Array.isArray(v)) {
        const objs = v.filter((x) => x && typeof x === 'object');
        if (objs.length >= 5) {
          const rows = objs.map(apiRowOf).filter(Boolean);
          if (rows.length >= Math.max(5, Math.floor(objs.length * 0.6)) && (!best || rows.length > best.length)) best = rows;
        }
        return;
      }
      for (const k in v) { try { look(v[k], d + 1); } catch (e) { /* ignore */ } }
    };
    look(j, 0);
    return best || [];
  }

  function noteApiTotal(text) {
    try {
      const re = /"(?:total|totalCount|totalNum|total_count|count)"\s*:\s*(\d{1,5})/g;
      let m;
      while ((m = re.exec(String(text || ''))) !== null) {
        const n = Number(m[1]);
        if (n > 0 && n <= 5000 && n > (Number(window.__mbTotal) || 0)) window.__mbTotal = n;
      }
    } catch (e) { /* ignore */ }
  }

  function absorbApiRows(rows) {
    if (!Array.isArray(window.__mbApiRows)) window.__mbApiRows = [];
    const all = window.__mbApiRows;
    for (const r of rows) {
      if (r && r.num && !all.some((x) => x.num === r.num)) all.push(r);
    }
  }


  /* ---------- 找目录父容器 ---------- */
  // 思路：拿当前渲染出来的章节行当「种子」，看它们的各级父节点里
  //      哪个同时满足「行多、文本不长、内部有可滚容器」，取评分最高的一个
  function findBox(seeds, strict) {
    const stat = new Map();
    for (const el of seeds.slice(0, 400)) {
      let n = el;
      for (let i = 0; i < 12 && n; i++) {
        n = n.parentElement;
        if (!n || n === document.documentElement || n === document.body) break;
        stat.set(n, (stat.get(n) || 0) + 1);
      }
    }

    const need = Math.min(3, seeds.length);
    let best = null;
    for (const [el, cnt] of stat) {
      if (cnt < need) continue;
      const tl = txt(el).length;
      if (tl > MAX_BOX_TEXT) continue;
      // 含正文编辑器的那块不是目录（作品页右侧就是 contenteditable 编辑器）
      if (strict !== false) {
        try { if (el.querySelector('[contenteditable="true"], textarea')) continue; } catch (e) { /* ignore */ }
      }
      const sc = pickScroller(el);
      const cls = String(el.className || '') + ' ' + String(el.id || '');
      const hint = /scroll|list|chapter|catalog|dir|sidebar|outline|tree|menu|volume|aside|panel/i.test(cls) ? 60 : 0;
      // 行多加分、文本短加分、有滚动容器加分
      const score = (sc ? 400 : 0) + hint + Math.min(cnt, 300) * 10 - Math.min(tl, 30000) / 150;
      if (!best || score > best.score) best = { el: el, cnt: cnt, sc: sc, tl: tl, cls: cls, score: score };
    }
    return best;
  }

  /* ---------- 容器内真正的可滚元素 ---------- */
  function pickScroller(root) {
    const cands = [];
    const visit = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (el === document.body || el === document.documentElement) return;
      if (el.clientHeight < 120) return;
      if (el.scrollHeight <= el.clientHeight + 8) return;
      const st = window.getComputedStyle(el);
      cands.push({ el: el, sh: el.scrollHeight, ch: el.clientHeight, oy: String(st.overflowY || '') });
    };
    visit(root);
    const all = root.querySelectorAll('div,ul,ol,section,main,aside,article');
    for (let i = 0; i < all.length && i < 5000; i++) visit(all[i]);
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = /auto|scroll|overlay/i.test(a.oy) ? 0 : 1;
      const rb = /auto|scroll|overlay/i.test(b.oy) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b.sh - b.ch) - (a.sh - a.ch);    // 可滚距离大的优先
    });
    return cands[0];
  }

  function collectScrollers(root) {
    const out = [];
    if (!root) return out;
    const push = (el) => {
      if (!el || el === document.body || el === document.documentElement) return;
      if (el.clientHeight < 80 || el.scrollHeight <= el.clientHeight + 8) return;
      if (out.some(c => c.el === el)) return;
      const st = window.getComputedStyle(el);
      out.push({ el: el, sh: el.scrollHeight, ch: el.clientHeight, oy: String(st.overflowY || '') });
    };
    push(root);
    const all = root.querySelectorAll('div,ul,ol,section,main,aside,article');
    for (let i = 0; i < all.length && i < 5000; i++) push(all[i]);
    out.sort((a, b) => {
      const ra = /auto|scroll|overlay/i.test(a.oy) ? 0 : 1;
      const rb = /auto|scroll|overlay/i.test(b.oy) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b.sh - b.ch) - (a.sh - a.ch);
    });
    return out.slice(0, 4);
  }

  // 目录卡在「加载更多」上时，替用户点一下（只认这几个短文案，别乱点）
  function clickMore(root) {
    try {
      const S2 = window.__mbState || {};
      if ((S2.moreTries || 0) >= 3) return false;
      const want = ['加载更多', '查看更多', '展开更多', '更多章节', '加载剩余'];
      const nodes = root.querySelectorAll('button,a,div,span,li,p');
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const t = txt(el);
        if (!t || t.length > 8) continue;
        if (want.indexOf(t) < 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 6) continue;
        S2.moreTries = (S2.moreTries || 0) + 1;
        el.click();
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function fire(el) {    try { el.dispatchEvent(new Event('scroll', { bubbles: false })); } catch (e) { /* ignore */ }
    // 有些虚拟列表监听的是内容层 / 捕获阶段
    try {
      const inner = el.querySelector('.n-scrollbar-content, .v-vl-items, .n-virtual-list');
      if (inner) inner.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch (e) { /* ignore */ }
    try { window.dispatchEvent(new Event('scroll')); } catch (e) { /* ignore */ }
  }

  /* ---------- 状态 ---------- */
  let S = window.__mbState;
  if (PHASE === 'init' || !S || typeof S !== 'object') S = window.__mbState = {};
  if (PHASE === 'init') {
    S.acc = new Map();
    S.box = null;
    S.cands = [];
    S.candIdx = 0;
    S.stuck = 0;
    S.atBottom = false;
    S.done = false;
    S.wheel = 0;
    S.tried = [];
  }
  if (!(S.acc instanceof Map)) S.acc = new Map();

  // 换了作品（SPA 内部跳转）→ 上一本的累积结果整份丢掉，不能串书
  const hereBook = bookKeyOf(location.href);
  if (S.book && hereBook && S.book !== hereBook) {
    S = window.__mbState = { acc: new Map() };
  }
  if (hereBook && window.__mbBook && window.__mbBook !== hereBook) {
    // 接口缓存的章节也按书隔离
    window.__mbApiRows = [];
    window.__mbTotal = 0;
  }
  S.book = hereBook;
  if (hereBook) window.__mbBook = hereBook;

  /* ---------- 初始化：锁定容器 + 回顶部 ---------- */
  function setup() {
    const seeds = rowSeeds(document);
    if (!seeds.length) return { ok: false, found: false, reason: '整页都没扫到「第N章」行' };

    const box = findBox(seeds, true) || findBox(seeds, false);
    if (!box) return { ok: false, found: false, reason: '扫到 ' + seeds.length + ' 行，但没有合适的目录容器' };

    S.box = box.el;
    S.boxCls = String(box.cls || '').slice(0, 80);
    S.cands = collectScrollers(box.el);
    S.candIdx = 0;
    S.scroller = S.cands.length ? S.cands[0].el : null;
    S.mode = S.scroller ? 'scrollTop' : 'rows';

    // 只在「第一次读」时回顶部；中途重锁容器（换书/重渲染）时保持当前位置，别把进度抖回去
    if (PHASE === 'init') {
      if (S.scroller) { try { S.scroller.scrollTop = 0; fire(S.scroller); } catch (e) { /* ignore */ } }
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }
    return { ok: true, found: true, seeds: seeds.length, box: box, mode: S.mode };
  }

  /* ---------- 诊断信息（找不到容器时排错用） ---------- */
  function diag(seeds) {
    const list = [];
    const stat = new Map();
    for (const el of (seeds || []).slice(0, 200)) {
      let n = el;
      for (let i = 0; i < 8 && n; i++) {
        n = n.parentElement;
        if (!n || n === document.body || n === document.documentElement) break;
        stat.set(n, (stat.get(n) || 0) + 1);
      }
    }
    for (const [el, cnt] of stat) {
      list.push({
        cls: String(el.className || '').toString().slice(0, 60),
        rows: cnt,
        textLen: txt(el).length,
        sh: el.scrollHeight, ch: el.clientHeight,
        oy: String(window.getComputedStyle(el).overflowY || '')
      });
    }
    list.sort((a, b) => b.rows - a.rows);
    return list.slice(0, 6);
  }

  /* ---------- 主流程 ---------- */
  // 先试着从页面自己的接口拿全量（比扒 DOM 靠谱：DOM 里只有分页/虚拟的那二十来行）
  if (PHASE === 'init') {
    try { await probeApi(); } catch (e) { /* ignore */ }
  }

  let setupInfo = null;
  if (PHASE === 'init' || !S.box || !S.box.isConnected) {
    setupInfo = setup();
    if (!setupInfo.ok) {
      // DOM 里找不到目录，但页面接口给过章节数据 → 直接用接口的，不折腾界面
      mergeApiRows(S.acc);
      const apiN = S.acc.size;
      const total0 = Number(window.__mbTotal) || 0;
      if (apiN > 0 && (!total0 || apiN >= total0 || apiN >= 5)) {
        S.mode = 'api';
        S.done = true;
        S.fromApi = true;
        return {
          ok: true, phase: PHASE, found: true, fromApi: true, done: true, mode: 'api',
          url: location.href,
          count: apiN, api: apiN, apiTotal: total0, probe: window.__mbProbe || null,
          net: (Array.isArray(window.__mbNet) ? window.__mbNet.slice(0, 6) : []),
          rows: Array.from(S.acc.values()).slice(0, 800)
        };
      }
      const seeds = rowSeeds(document);
      return {
        ok: false, phase: PHASE, found: false,
        reason: setupInfo.reason,
        url: location.href,
        diag: diag(seeds),
        api: apiN,
        apiTotal: total0,
        net: (Array.isArray(window.__mbNet) ? window.__mbNet.slice(0, 6) : []),
        count: S.acc.size,
        rows: Array.from(S.acc.values()).slice(0, 800)
      };
    }
  } else {
    // 容器还在，但块头可能变了（换书/刷新），重新确认一下行还在
    if (!rowSeeds(S.box).length) {
      setupInfo = setup();
      if (!setupInfo.ok) return { ok: false, phase: PHASE, found: false, reason: setupInfo.reason, count: S.acc.size, rows: Array.from(S.acc.values()).slice(0, 800) };
    }
  }

  const box = S.box;

  // 每次进来先把「当前可视区」扫一遍再往下滚。
  // 上一次调用末尾可能刚发过滚轮事件、列表刚换过一批行，不先读就会把这一屏整段跳过。
  if (PHASE === 'init') {
    snapInto(S.acc, box);
    await sleep(120);
    snapInto(S.acc, box);
  } else {
    await sleep(Math.min(260, DELAY));
    snapInto(S.acc, box);
  }

  // 页面接口已经报了总条数、而且已经拿全 → 不用再滚了，别动用户的界面
  const apiTotal = Number(window.__mbTotal) || 0;
  if (apiTotal && S.acc.size >= apiTotal) {
    S.done = true;
    S.fromApi = true;
  }

  const y0 = S.scroller ? S.scroller.scrollTop : (window.scrollY || 0);
  let grewFrames = 0;
  let yStart = y0;

  for (let f = 0; f < FRAMES && !S.done; f++) {
    const before = S.acc.size;
    let beforeY = 0;

    if (S.mode === 'scrollTop' && S.scroller) {
      const sc = S.scroller;
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
      beforeY = sc.scrollTop;
      if (beforeY >= max - 4) S.atBottom = true;

      if (!S.atBottom) {
        const px = Math.max(120, Math.round(sc.clientHeight * SCREEN));
        sc.scrollTop = Math.min(max, beforeY + px);
        S.moved = 1;
        fire(sc);
        await sleep(DELAY);
      } else {
        fire(sc);
        await sleep(Math.round(DELAY * 0.6));
      }
    } else if (S.mode === 'rows') {
      // 容器自己不能滚：把最后一行滚进视野，靠页面/外层滚动带动加载
      const rs = rowSeeds(box);
      if (rs.length) {
        try { rs[rs.length - 1].scrollIntoView({ block: 'end' }); } catch (e) { /* ignore */ }
      }
      fire(document.scrollingElement || document.body);
      await sleep(DELAY);
    } else {
      try { window.scrollBy(0, Math.max(120, Math.round(window.innerHeight * SCREEN))); } catch (e) { /* ignore */ }
      await sleep(DELAY);
    }

    snapInto(S.acc, box);
    const grew = S.acc.size > before;
    if (grew) { grewFrames++; S.stuck = 0; } else if (!S.atBottom) S.stuck++;

    if (!grew && !S.atBottom && S.mode === 'scrollTop') {
      const movedY = S.scroller && Math.abs(S.scroller.scrollTop - beforeY) > 2;
      if (!movedY && S.candIdx + 1 < S.cands.length) {
        // 这一层根本滚不动 → 换下一个候选可滚层再试
        S.candIdx++;
        S.scroller = S.cands[S.candIdx].el;
        S.stuck = 0;
        try { S.scroller.scrollTop = Math.max(0, yStart); fire(S.scroller); } catch (e) { /* ignore */ }
        await sleep(DELAY);
        snapInto(S.acc, box);
      } else if (S.stuck >= 2) {
        // 滚是滚动了，但列表不认程序化滚动（虚拟列表常见）。
        // 不能继续盲跳——那会把中间几十章整段跳过；退回原位，让主进程发真实滚轮事件。
        try { S.scroller.scrollTop = beforeY; fire(S.scroller); } catch (e) { /* ignore */ }
        break;
      }
    }

    // 没有可滚层、滚动也带不出新行 → 就是全渲染完了，别再空转
    if (S.mode === 'rows' && S.stuck >= 3) { S.done = true; break; }
  }

  // 到底了：再补扫两帧，确认不是懒加载（"加载更多"）还没出来
  if (S.atBottom) {
    let settleGrow = 0;
    for (let i = 0; i < 2; i++) {
      const before = S.acc.size;
      const shBefore = S.scroller ? S.scroller.scrollHeight : 0;
      fire(S.scroller || document.scrollingElement || document.body);
      await sleep(Math.round(DELAY * 1.2));
      snapInto(S.acc, box);
      const shAfter = S.scroller ? S.scroller.scrollHeight : 0;
      if (S.acc.size > before || shAfter > shBefore + 8) settleGrow++;
    }
    if (settleGrow === 0) {
      // 还有一招：页面上如果有「加载更多」这类按钮，点一下再等
      const beforeM = S.acc.size;
      if (clickMore(box)) {
        await sleep(Math.round(DELAY * 1.8));
        snapInto(S.acc, box);
        if (S.acc.size > beforeM) { S.atBottom = false; S.stuck = 0; }
        else S.done = true;
      } else {
        S.done = true;
      }
    } else { S.atBottom = false; S.stuck = 0; }
  }

  // 滚不动了（既没到底也没新行）→ 交给主进程发真实滚轮事件
  let needWheel = null;
  if (!S.done && S.stuck >= 2 && S.wheel < 400) {
    S.wheel++;
    S.stuck = 0;
    try {
      const r = box.getBoundingClientRect();
      const H = window.innerHeight || 800;
      const W = window.innerWidth || 1200;
      let wx = Math.round((r.left || 0) + Math.max(40, Math.min(r.width || 200, 240)) / 2);
      let wy = Math.round((r.top || 0) + Math.min((r.height || 300) / 2, 200));
      // 坐标必须落在可视区内，否则滚轮事件发到窗口外等于没发
      if (!(wy > 20 && wy < H - 20)) wy = Math.round(H / 2);
      if (!(wx > 20 && wx < W - 20)) wx = Math.round(Math.max(40, Math.min(W / 2, 160)));
      needWheel = { x: wx, y: wy, dy: 480 };
    } catch (e) { needWheel = null; }
  }

  const sc = S.scroller;
  const yEnd = sc ? sc.scrollTop : (window.scrollY || 0);

  // 全部读完 → 把列表位置还原到顶部，别停在书底
  if (S.done && sc && S.moved) {
    try { sc.scrollTop = 0; fire(sc); } catch (e) { /* ignore */ }
  }

  const info = {
    ok: true,
    phase: PHASE,
    found: true,
    url: location.href,
    mode: S.mode,
    yEnd: yEnd,
    y: sc ? sc.scrollTop : (window.scrollY || 0),
    sh: sc ? sc.scrollHeight : (document.documentElement.scrollHeight || 0),
    ch: sc ? sc.clientHeight : (window.innerHeight || 0),
    atBottom: !!S.atBottom,
    done: !!S.done,
    stuck: S.stuck,
    cands: S.cands.length,
    candIdx: S.candIdx,
    boxCls: S.boxCls || '',
    rendered: rowSeeds(box).length,
    count: S.acc.size,
    api: (apiRowsOfThisBook().length || 0),
    apiTotal: Number(window.__mbTotal) || 0,
    probe: window.__mbProbe || null,
    fromApi: !!S.fromApi,
    net: (Array.isArray(window.__mbNet) ? window.__mbNet.slice(0, 6) : []),
    needWheel: needWheel,
    rows: Array.from(S.acc.values()).slice(0, 800)
  };
  if (setupInfo) info.setup = { seeds: setupInfo.seeds, mode: setupInfo.mode, boxRows: setupInfo.box.cnt, boxTextLen: setupInfo.box.tl };
  return info;
})()
