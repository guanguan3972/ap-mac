/* 妙笔页面网络嗅探：把页面自己请求到的「章节列表」接口响应截下来
 *
 * 为什么需要：妙笔左栏是虚拟列表 / 分页列表，DOM 里永远只有十几行，
 * 真正的全量在接口响应里。挂上这个钩子，页面每次请求章节数据都会顺手解析一份
 * 存进 window.__mbApiRows，读章节时直接并进结果。
 *
 * 幂等：重复注入只会跑一次。注入时机越早越好（窗口加载完就注入），
 * 这样才能截到「打开作品 → 加载目录」那一次请求。
 */
(() => {
  if (window.__mbHooked) return { ok: true, already: true };
  window.__mbHooked = true;
  if (!Array.isArray(window.__mbApiRows)) window.__mbApiRows = [];
  if (!Array.isArray(window.__mbNet)) window.__mbNet = [];

  const MAX_NET = 24;

  // 按「书」隔离：换作品就清空，别把上一本的章节混进来
  function bookKey() {
    const m = /\/books\/([A-Za-z0-9_-]+)/.exec(String(location.href || ''));
    return m ? m[1] : '';
  }
  function ensureBook() {
    const bk = bookKey();
    if (window.__mbBook !== bk) {
      window.__mbBook = bk;
      window.__mbApiRows = [];
      window.__mbNet = [];
      window.__mbTotal = 0;
    }
  }
  ensureBook();

  function numOf(o) {
    const keys = ['chapterNumber', 'chapter_number', 'chapterNo', 'chapter_no', 'number', 'num', 'index', 'order', 'sort', 'serial'];
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'number' && v > 0) return Math.floor(v);
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    }
    return 0;
  }
  function titleOf(o) {
    const keys = ['title', 'name', 'chapterTitle', 'chapter_title', 'chapterName', 'chapter_name', 'content_title'];
    for (const k of keys) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
    }
    return '';
  }
  function wordsOf(o) {
    const keys = ['wordCount', 'word_count', 'words', 'charCount', 'char_count', 'wordNum', 'word_num'];
    for (const k of keys) {
      if (typeof o[k] === 'number' && o[k] >= 0) return Math.round(o[k]);
    }
    return 0;
  }
  function asRow(o) {
    if (!o || typeof o !== 'object') return null;
    let t = titleOf(o);
    let num = numOf(o);
    const m = /^\s*第\s*([0-9０-９]+)\s*[章回]/.exec(t);
    if (m) {
      const raw = String(m[1]).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      const n2 = Number(raw);
      if (n2) num = num || n2;
      t = t.slice(m[0].length).trim();
    }
    if (!num) return null;
    return { num: num, title: t.slice(0, 40), words: wordsOf(o), draft: false };
  }

  function findChapterArray(root) {
    let best = null;
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 4) return;
      if (Array.isArray(v)) {
        const objs = v.filter((x) => x && typeof x === 'object');
        if (objs.length >= 5) {
          let hit = 0;
          for (const o of objs) if (asRow(o)) hit++;
          if (hit >= Math.max(5, Math.floor(objs.length * 0.6))) {
            if (!best || objs.length > best.length) best = objs;
          }
        }
        return;
      }
      for (const k in v) {
        try { walk(v[k], depth + 1); } catch (e) { /* ignore */ }
      }
    };
    walk(root, 0);
    return best;
  }

  function note(url, text) {
    try {
      ensureBook();
      const u = String(url || '').slice(0, 220);
      const isCh = /chapter/i.test(u);

      // 所有接口都记一笔（排错时能看到页面到底请求了哪些地址）
      if (window.__mbNet.length < MAX_NET) {
        window.__mbNet.push({ url: u, len: String(text || '').length, ch: isCh ? 1 : 0 });
      }
      if (!isCh) return;

      // 顺手记一下接口报出来的总条数（有的话就能判断是不是已经拿全了）
      const tm = /"(?:total|totalCount|totalNum|total_count|count)"\s*:\s*(\d{1,5})/g;
      let mm;
      while ((mm = tm.exec(String(text || ''))) !== null) {
        const n = Number(mm[1]);
        if (n > 0 && n <= 5000 && n > (window.__mbTotal || 0)) window.__mbTotal = n;
      }

      let j = null;
      try { j = JSON.parse(text); } catch (e) { return; }
      const arr = findChapterArray(j);
      if (!arr) return;
      const rows = arr.map(asRow).filter(Boolean);
      if (rows.length < 5) return;
      const all = window.__mbApiRows;
      let added = 0;
      for (const r of rows) {
        if (all.some((x) => x.num === r.num)) continue;
        all.push(r);
        added++;
      }
      try { console.log('[妙笔接口] ' + u + ' → ' + rows.length + ' 条，新增 ' + added + ' 条，累计 ' + all.length + (window.__mbTotal ? '，总数 ' + window.__mbTotal : '')); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  const of = window.fetch;
  if (typeof of === 'function') {    window.fetch = function (input) {
      const url = (input && input.url) || String(input || '');
      const p = of.apply(this, arguments);
      try {
        p.then((res) => {
          try {
            const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (!/json|text/i.test(ct)) return;
            res.clone().text().then((t) => note(url, t)).catch(() => {});
          } catch (e) { /* ignore */ }
        }).catch(() => {});
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__mbUrl = String(url || ''); } catch (e) { /* ignore */ }
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        const self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status < 200 || self.status >= 300) return;
            const rt = typeof self.responseType === 'string' ? self.responseType : '';
            if (rt && rt !== 'text' && rt !== 'json') return;
            const txt = self.responseType === 'json' ? JSON.stringify(self.response) : self.responseText;
            note(self.__mbUrl, txt);
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return send.apply(this, arguments);
    };
  }

  // 给读章节脚本复用：把一条接口响应交给同一套解析逻辑
  window.__mbNote = note;
  window.__mbEnsureBook = ensureBook;

  return { ok: true, installed: true };
})()
