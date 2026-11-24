/* 妙笔：把「第N章」在左栏目录里滚出来并给出坐标
 *
 * 为什么需要它：妙笔左栏是虚拟列表，只渲染可视区那十几行。
 * 「导入所选章节」是按坐标点行的，第 30 章之后的行根本不在 DOM 里，
 * 所以点之前要先在这个容器里滚到那一章。
 *
 * 复用读章节脚本留下的 window.__mbState（box / scroller），没有就退回整页找。
 */
(async () => {
  const CFG = window.__mbCfg || {};
  const num = Number(CFG.num) || 0;
  if (!num) return { ok: false, reason: '章号无效' };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const txt = (el) => String((el && (el.innerText != null ? el.innerText : el.textContent)) || '')
    .replace(/[\s\u00a0]+/g, ' ').trim();

  const ROW = new RegExp('^第\\s*' + num + '\\s*[章回]');

  const S = window.__mbState;
  const box = (S && S.box && S.box.isConnected) ? S.box : document;
  const sc = (S && S.scroller && S.scroller.isConnected) ? S.scroller : null;

  // 只在目录容器里、行首是「第N章」的窄行里找，取最小的一层
  function pick() {
    const out = [];
    const nodes = box.querySelectorAll('div,li,a,span,p');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const tc = el.textContent || '';
      if (tc.length > 220) continue;
      if (tc.indexOf('章') < 0 && tc.indexOf('回') < 0) continue;
      const t = txt(el);
      if (!t || t.length > 200) continue;
      if (!ROW.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 4) continue;
      out.push({ el: el, area: r.width * r.height });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.area - b.area);
    return out[0].el;
  }

  const fire = (el) => {
    try { el.dispatchEvent(new Event('scroll', { bubbles: false })); } catch (e) { /* ignore */ }
    try {
      const inner = el.querySelector('.n-scrollbar-content, .v-vl-items, .n-virtual-list');
      if (inner) inner.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch (e) { /* ignore */ }
  };

  let el = pick();
  let scrolled = 0;

  if (!el && sc) {
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const step = Math.max(120, Math.round(sc.clientHeight * 0.8));

    for (let y = 0; y <= max; y += step) {
      sc.scrollTop = Math.min(max, y);
      fire(sc);
      await sleep(150);
      scrolled++;
      el = pick();
      if (el) break;
    }
    if (!el) {   // 从头没找到 → 再倒着扫一遍（有些列表是从底部开始渲染/懒加载）
      for (let y = max; y >= 0; y -= step) {
        sc.scrollTop = Math.max(0, y);
        fire(sc);
        await sleep(120);
        scrolled++;
        el = pick();
        if (el) break;
      }
    }
  }

  if (!el) return { ok: false, reason: '目录里没找到第' + num + '章', scrolled: scrolled };

  try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
  await sleep(300);

  // 滚动后这一行可能被虚拟列表回收重建，重新取一次「活的」节点再算坐标
  const live = pick() || el;
  const r = live.getBoundingClientRect();
  const rowText = txt(live);

  if (!(r.width > 2) || !(r.height > 2)) return { ok: false, reason: '第' + num + '章这一行没渲染出来' };

  return {
    ok: true,
    num: num,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    rowText: rowText,
    scrolled: scrolled
  };
})()
