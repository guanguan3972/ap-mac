(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function rowEls() {
    return Array.from(document.querySelectorAll('div, li, a, span, p')).filter(el => {
      const tx = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return tx.length < 200 && /第\s*\d+\s*章/.test(tx);
    });
  }

  function listContainer() {
    const rows = rowEls();
    if (!rows.length) return null;
    const row = rows[0];
    let n = row.parentElement;
    let best = null;
    for (let i = 0; i < 14 && n; i++) {
      if (n.scrollHeight > n.clientHeight + 30 && n.clientHeight > 120 && n.contains(row)) {
        best = n;
      }
      n = n.parentElement;
    }
    return best;
  }

  const map = new Map();

  // 往上找到"同时含章名和字数"的那一层（标题和字数常被拆成两个兄弟节点）
  function rowOf(el) {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      const tx = (n.innerText || '').replace(/\s+/g, ' ').trim();
      if (tx.length > 200) break;
      if (/第\s*\d+\s*章/.test(tx) && /\d[\d,]*\s*字/.test(tx)) return n;
      n = n.parentElement;
    }
    return el;
  }

  const list = [];
  const seenText = new Set();

  function snap() {
    for (const rawEl of rowEls()) {
      const el = rowOf(rawEl);
      const tx = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const m = /第\s*(\d+)\s*章/.exec(tx);
      if (!m) continue;
      const num = Number(m[1]) || 0;
      if (!num) continue;

      const wm = /(\d[\d,]*)\s*字/.exec(tx);
      const words = wm ? Number(wm[1].replace(/,/g, '')) : 0;

      let title = tx.slice(m.index + m[0].length).trim();
      title = title.replace(/\d[\d,]*\s*字.*$/, '').replace(/创建于.*$/, '').replace(/[·\-]\s*$/, '').trim();

      const draft = /创建于|删除|生成|概要/.test(tx);
      const key = num + '|' + title + '|' + words + '|' + (draft ? 1 : 0);
      if (seenText.has(key)) continue;
      seenText.add(key);

      list.push({ num: num, title: title.slice(0, 40), words: words, draft: draft });
    }
  }

  snap();
  const box = listContainer();

  if (box) {
    // 用 scrollTop + 主动派发 scroll 事件，逼虚拟列表加载
    const fire = () => {
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
      const inner = box.querySelector('.n-scrollbar-content');
      if (inner) inner.dispatchEvent(new Event('scroll', { bubbles: true }));
    };

    for (let y = 0; y <= box.scrollHeight; y += 200) {
      box.scrollTop = y;
      fire();
      await sleep(140);
      snap();
    }
    for (let y = box.scrollHeight; y >= 0; y -= 200) {
      box.scrollTop = y;
      fire();
      await sleep(120);
      snap();
    }
    box.scrollTop = 0;
    fire();
    await sleep(150);
  }

  const out = list.map((c, i) => ({ id: i, num: c.num, title: c.title, words: c.words, draft: c.draft }));
  return {
    url: location.href,
    count: out.length,
    chapters: out.slice(0, 800),
    scrolled: !!box,
    boxInfo: box ? { cls: String(box.className || '').slice(0, 60), h: box.clientHeight, sh: box.scrollHeight } : null
  };
})()