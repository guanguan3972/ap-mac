/* 星月写作界面（独立窗口版） */
(function () {
  const q = (id) => document.getElementById(id);
  const log = (lv, msg) => { try { window.__tmAddLocalLog && window.__tmAddLocalLog(lv, msg); } catch (e) {} };
  const api = window.shellApi || {};

  // 输出前最后一道清洗：去掉 "—— 2000 字 ——"
  function scrubMarkers(s) {
    let x = String(s || '').replace(/[\u200b-\u200f\uFEFF]/g, '');
    const D = '[—–‑‒−‐－﹣~～_=─━]';
    const NUM = '[0-9０-９][0-9０-９,，\\s]*';
    x = x.replace(new RegExp(D + '{1,8}[ \\t]*' + NUM + '字[ \\t]*' + D + '{1,8}', 'g'), '');
    x = x.replace(new RegExp(D + '{1,8}[ \\t]*' + NUM + '字', 'g'), '');
    return x.replace(/[ \\t\\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }


  // 站点切换时更新按钮文字
  function syncSiteText() {
    const sel = q('xy-site');
    const site = sel ? sel.value : 'xingyue';
    const name = site === 'miaobi' ? '妙笔' : '星月';
    const b1 = q('tf-xy-load');
    const b2 = q('tf-xy-openwin');
    if (b1) b1.textContent = '读取' + name + '作品';
    if (b2) b2.textContent = '打开' + name;
    const hint = document.querySelector('#tf-xy-block .tf-hint');
    if (hint) hint.textContent = '先在这里登录' + name + '，再读作品';
    const tip = q('tf-xy-hint');
    if (tip) tip.textContent = '已载入 ' + name + ' 作品；选好后点「打开作品」。';
  }
  (function bindSite() {
    const sel = q('xy-site');
    if (sel) { sel.addEventListener('change', syncSiteText); syncSiteText(); }
  })();


  // 章节快捷选择
  (function bindSelButtons() {
    const pick = () => Array.from(document.querySelectorAll('.xy-ch'));
    const setAll = (arr, v) => arr.forEach(c => { c.checked = v; });
    const on = (id, fn) => { const b = q(id); if (b) b.addEventListener('click', (e) => { e.preventDefault(); fn(pick()); }); };
    on('xy-sel-all', a => setAll(a, true));
    on('xy-sel-invert', a => a.forEach(c => { c.checked = !c.checked; }));
    on('xy-sel-first5', a => { setAll(a, false); a.slice(0, 5).forEach(c => c.checked = true); });
    on('xy-sel-last5', a => { setAll(a, false); a.slice(-5).forEach(c => c.checked = true); });
    on('xy-sel-first10', a => { setAll(a, false); a.slice(0, 10).forEach(c => c.checked = true); });
    on('xy-sel-last10', a => { setAll(a, false); a.slice(-10).forEach(c => c.checked = true); });
  })();

  // 打开星月窗口
  (function () {
    const b = q('tm-xingyue');
    if (b) b.addEventListener('click', async () => {
      try { await api.openXingyue(); } catch (e) { alert('打开星月失败：' + e.message); }
    });
  })();

  // 读取作品 → 填下拉
  (function () {
    const b = q('tf-xy-load');
    if (b) b.addEventListener('click', async () => {
      try {
        const r = await api.syncXingyueWorks();
        if (!r || !r.ok || !r.count) { alert('没读到星月作品：确认星月窗口已登录并停在作品列表页'); return; }
        const sel = q('tf-xy-book');
        sel.innerHTML = (r.works || []).map(w => '<option value="' + String(w.name).replace(/"/g, '&quot;') + '">' + w.name + '（' + w.words + '）</option>').join('');
        log('success', '星月作品已载入：' + r.count + ' 个');
      } catch (e) { alert('读取作品出错：' + e.message); }
    });
  })();

  // 打开星月窗口（弹窗里也能开）
  (function () {
    const b = q('tf-xy-openwin');
    if (b) b.addEventListener('click', async () => {
      try {
        const sel = document.getElementById('xy-site');
        const r = await api.openXingyue(sel ? sel.value : 'xingyue');
        if (r && r.ok === false) alert('打开星月失败：' + (r.reason || '未知'));
      } catch (e) { alert('打开星月失败：' + e.message); }
    });
  })();

  // 打开作品
  (function () {
    const b = q('tf-xy-open');
    if (b) b.addEventListener('click', async () => {
      const name = (q('tf-xy-book') || {}).value;
      if (!name) { alert('请先点「读取星月作品」并选一本书'); return; }
      try {
        const r = await api.xyOpenWork(name);
        if (r && r.ok) log('success', '已打开作品：' + name);
        else alert('打开作品失败：' + ((r && r.reason) || '未知'));
      } catch (e) { alert('打开作品出错：' + e.message); }
    });
  })();

  // 读取章节 → 列表
  (function () {
    const box = q('tf-xy-chapters');
    const b = q('tf-xy-load-chapters');
    const cnt = q('tf-xy-count');
    if (!b) return;
    b.addEventListener('click', async () => {
      const sel = q('xy-site');
      const site = sel ? sel.value : undefined;
      const label = b.textContent;
      b.disabled = true;
      b.textContent = '读取中…';
      if (cnt) cnt.textContent = site === 'miaobi' ? '正在滚动左栏目录，请稍等（别关窗口）…' : '读取中…';
      try {
        const r = await api.xyListChapters(site);
        try { log('info', 'listChapters 返回: ok=' + (r && r.ok) + ' count=' + (r && r.count) + ' reason=' + (r && r.reason)); } catch (e) {}
        if (!r || !r.ok || !r.count) {
          if (cnt) cnt.textContent = '没读到章节';
          alert('没读到章节：' + ((r && r.reason) || '先点「打开作品」进到章节页'));
          return;
        }
        box.style.display = '';
        box.innerHTML = '';
        const seenNum = new Set();
        const list = (r.chapters || []).filter(c => {
          if (seenNum.has(c.num)) return false;
          seenNum.add(c.num);
          return true;
        });
        box.innerHTML = list.map(c =>
          '<div class="xy-ch-row" data-num="' + c.num + '" style="position:relative;padding:7px 6px 7px 28px;border-bottom:1px solid #eef2f7;text-align:left;line-height:1.5;">' +
          '<input type="checkbox" class="xy-ch" value="' + c.num + '" style="position:absolute;left:8px;top:50%;margin:-7px 0 0 0;width:14px;height:14px;">' +
          '<span style="display:inline;text-align:left;">第' + c.num + '章 ' + (c.title || '') +
          (c.words ? ' <span style="color:#8aa0bd;">(' + c.words + ' 字)</span>' : '') +
          (c.draft ? ' <span style="color:#d48806;">[草稿]</span>' : '') + '</span></div>').join('');

        // 点整行就能勾选
        box.querySelectorAll('.xy-ch-row').forEach(row => {
          row.addEventListener('click', (ev) => {
            const cb = row.querySelector('.xy-ch');
            if (!cb || ev.target === cb) return;
            cb.checked = !cb.checked;
          });
        });

        if (cnt) cnt.textContent = '共 ' + list.length + ' 章' + (r.atBottom === false ? '（未到底，可再点一次）' : '');
        log('success', '读到章节 ' + list.length + ' 章');
      } catch (e) {
        if (cnt) cnt.textContent = '读取失败';
        alert('读取章节出错：' + e.message);
      } finally {
        b.disabled = false;
        b.textContent = label;
      }
    });
  })();

  // 导入所选
  (function () {
    const b = q('tf-xy-grab');
    if (b) b.addEventListener('click', async () => {
      const picked = Array.from(document.querySelectorAll('.xy-ch:checked')).map(c => Number(c.value)).filter(Boolean);
      if (!picked.length) { alert('请先勾选章节'); return; }
      const uniq = Array.from(new Set(picked)).sort((a, b) => a - b);
      try {
        log('info', '开始导入 ' + uniq.length + ' 章…');
        const selSite = q('xy-site');
        const r = await api.xyGrabChapters(uniq, selSite ? selSite.value : undefined);
        if (!r || !r.ok) { alert('导入失败：' + ((r && r.reason) || '未知')); return; }
        const ta = q('tf-content');
        let ok = 0, text = '';
        for (const it of (r.results || [])) {
          if (!it.ok || !it.text) continue;
          const body = scrubMarkers(String(it.text));

          // 标题：优先用列表行里的，其次用页面标题，最后用正文第一行
          let title = '';
          if (it.rowText) {
            title = String(it.rowText)
              .replace(/^\s*第\s*\d+\s*章\s*/, '')
              .replace(/\d[\d,]*\s*字.*$/, '')
              .replace(/\[?草稿\]?/, '')
              .trim();
          }
          if (!title && it.heading) {
            title = String(it.heading).replace(/^\s*第\s*\d+\s*章\s*/, '').trim();
          }

          text += '第' + it.num + '章' + (title ? ' ' + title : '') + '\n' + body + '\n\n';
          ok++;
        }
        if (text && ta) {
          ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n\n') : '') + text;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        log('success', '导入 ' + ok + '/' + uniq.length + ' 章');
        if (!ok) alert('没有导入任何章节，请看日志');
      } catch (e) { alert('导入出错：' + e.message); }
    });
  })();

  // 只复制当前章
  (function () {
    const b = q('tf-xy-import');
    if (b) b.addEventListener('click', async () => {
      try {
        const r = await api.xyCopyChapter();
        if (!r || !r.ok) { alert('复制失败：' + ((r && r.reason) || '未知')); return; }
        const ta = q('tf-content');
        const num = (ta.value.match(/第\s*\d+\s*章/g) || []).length + 1;
        ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n\n') : '') + '第' + num + '章\n' + scrubMarkers(r.text) + '\n\n';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        log('success', '已导入当前章（' + r.len + ' 字）');
      } catch (e) { alert('复制出错：' + e.message); }
    });
  })();
})();
