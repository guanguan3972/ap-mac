(() => {
  // 星月写作「作品」列表提取：按卡片里"创建于"定位，取书名 + 字数
  const out = [];
  const seen = new Set();

  function pickName(text) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (!l) continue;
      if (l === '小说' || l === '剧本') continue;
      if (/^\d[\d.,]*\s*万?字$/.test(l)) continue;
      if (/创建于/.test(l)) continue;
      if (/新建章节|导入章节|作品管理|批量管理|新建作品|导入作品/.test(l)) continue;
      if (l.length >= 2 && l.length <= 40) return l;
    }
    return '';
  }

  const cards = Array.from(document.querySelectorAll('div, li, article'));
  for (const el of cards) {
    const txt = el.innerText || '';
    if (txt.length > 300) continue;
    if (!/创建于/.test(txt)) continue;
    if (!/\d[\d.,]*\s*万?字/.test(txt)) continue;

    const name = pickName(txt);
    if (!name) continue;
    const wm = txt.match(/(\d[\d.,]*\s*万?字)/);
    const words = wm ? wm[1] : '';
    const key = name + '|' + words;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name, words: words });
    if (out.length >= 100) break;
  }

  return { url: location.href, title: document.title, count: out.length, works: out };
})()