(() => {
  // 星月写作：读取当前打开章节的标题与正文
  let title = '';
  const h = document.querySelector('h1, [class*=chapter][class*=title], [class*=title][class*=chapter]');
  if (h) title = (h.innerText || '').trim();
  if (!title) {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    for (const i of inputs) {
      const v = (i.value || '').trim();
      if (/第\s*\d+\s*章/.test(v) && v.length < 60) { title = v; break; }
    }
  }
  if (!title) title = (document.title || '').trim();

  let body = '';
  const ce = document.querySelector('[contenteditable="true"]');
  if (ce) body = ce.innerText || '';

  if (!body || body.length < 50) {
    const ta = Array.from(document.querySelectorAll('textarea'))
      .map(t => t.value || '')
      .sort((a, b) => b.length - a.length)[0];
    if (ta && ta.length > (body || '').length) body = ta;
  }

  if (!body || body.length < 50) {
    const cands = Array.from(document.querySelectorAll('div, p, section, article'))
      .map(el => (el.innerText || '').trim())
      .filter(s => s.length > 200 && !/新建章节|作品管理|创建于/.test(s))
      .sort((a, b) => b.length - a.length);
    body = cands[0] || '';
  }

  return { url: location.href, title: title, body: body, len: (body || '').length };
})()