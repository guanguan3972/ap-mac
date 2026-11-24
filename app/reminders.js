// 定时提醒窗口逻辑
const listEl = document.getElementById('list');
const subEl = document.getElementById('sub');
const footEl = document.getElementById('foot');

let accountNames = {};

function parseDate(text) {
    // "YYYY-MM-DD HH:mm"
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text || '');
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function daysLeft(dt) {
    const now = new Date();
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    return Math.round((b - a) / 86400000);
}

function badgeFor(days) {
    if (days < 0) return { text: '已过', cls: '' };
    if (days === 0) return { text: '今天', cls: 'hot' };
    if (days <= 3) return { text: `还剩 ${days} 天`, cls: 'warn' };
    return { text: `还剩 ${days} 天`, cls: '' };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

let privacyMode = false;

async function render() {
    try {
        const st = await window.reminderApi.getSettings();
        privacyMode = !!(st && st.privacy);
    } catch (e) { privacyMode = false; }

    let items = [];
    try { items = await window.reminderApi.getSchedule(); } catch (e) { items = []; }

    // 账号名
    try {
        const acc = await window.reminderApi.getAccounts();
        accountNames = (acc && acc.names) || {};
    } catch (e) { /* ignore */ }

    const rows = [];
    for (const it of items) {
        const dt = parseDate(it.last);
        if (!dt) continue;
        rows.push({ item: it, dt, days: daysLeft(dt) });
    }
    rows.sort((a, b) => a.dt - b.dt);

    if (footEl) {
        footEl.textContent = `共 ${rows.length} 条记录` + (window.__schedPath ? ` · ${window.__schedPath}` : '');
    }

    if (!rows.length) {
        listEl.innerHTML = '<div id="empty"><span class="big">⏰</span>还没有定时记录。<br>' +
            '用「启用定时发布」上传一批后，<br>这里会显示每本书最后一次发布的日期。</div>';
        subEl.textContent = '';
        return;
    }

    const today = rows.filter(r => r.days === 0).length;
    const soon = rows.filter(r => r.days > 0 && r.days <= 3).length;
    const over = rows.filter(r => r.days < 0).length;
    const ok = rows.length - today - soon - over;

    subEl.textContent = `共 ${rows.length} 本`;

    const statsEl = document.getElementById('stats');
    if (statsEl) {
        const chips = [];
        if (today) chips.push(`<span class="chip hot">今天 ${today}</span>`);
        if (soon) chips.push(`<span class="chip warn">3 天内 ${soon}</span>`);
        if (over) chips.push(`<span class="chip hot">已过期 ${over}</span>`);
        if (ok > 0) chips.push(`<span class="chip ok">正常 ${ok}</span>`);
        let todayLine = '';
        try {
            const st = await window.reminderApi.getTodayStats();
            if (st) {
                const incomeTxt = st.income > 0 ? ` · 收益 ¥${Number(st.income).toFixed(2)}` : '';
                todayLine = `<div class="chip today-stat">今日：更新 ${st.chapters} 章 · ${st.words} 字 · ${st.books} 本书${incomeTxt}</div>`;
            }
        } catch (e) { /* ignore */ }

        statsEl.innerHTML = todayLine + (chips.join('') || '<span class="chip">没有待发的书</span>');
    }

    // 按账号分组
    const groups = new Map();
    for (const r of rows) {
        const key = r.item.slot;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    const keySorted = [...groups.keys()].sort((a, b) => Number(a) - Number(b));

    let html = '';
    for (const slot of keySorted) {
        const gRows = groups.get(slot);
        const accName = accountNames[slot] || ('账号 ' + slot);
        html += `<div class="group">👤 ${escapeHtml(accName)} · ${gRows.length} 本</div>`;
        html += gRows.map(({ item, days }) => itemHtml(item, days, accName)).join('');
    }
    listEl.innerHTML = html;

    function itemHtml(item, days, accName) {
        const badge = badgeFor(days);
        const cls = days < 0 ? '' : (days === 0 ? 'today' : (days <= 3 ? 'soon' : ''));
        return `<div class="item ${cls}">
            <div class="row1">
                <span class="book" data-slot="${item.slot}" data-book="${escapeHtml(item.bookHash || '')}" title="点一下可以改名">${escapeHtml(privacyMode ? '📕 ★★★（隐私模式）' : (item.bookName || ('📕 ' + (item.bookHash || ''))))}</span>
                <span class="acc">${escapeHtml(accName)}</span>
                <span class="del" data-slot="${item.slot}" data-book="${escapeHtml(item.bookHash || '')}" title="这本书不需要提醒了？点这里删除">删除</span>
            </div>
            <div class="row2">
                <span class="date">${escapeHtml(item.last)}</span>
                <span class="badge ${badge.cls}">${badge.text}</span>
            </div>
            <div class="meta">${item.count ? `已排 ${item.count} 章` : '章数未记录'}${item.lastChapter ? ` · 最后一章 第${item.lastChapter}章` : ' · 最后一章 未记录'} · 记录于 ${new Date(item.updated || Date.now()).toLocaleString()}</div>
        </div>`;
    }

    listEl.querySelectorAll('.del').forEach(el => {
        el.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const name = el.closest('.item').querySelector('.book').textContent.trim();
            if (!confirm('删除「' + name + '」的提醒记录？\n（只删除这条提醒，不影响番茄里的章节）')) return;
            try {
                await window.reminderApi.removeSchedule(el.dataset.slot, el.dataset.book);
            } catch (e) { /* ignore */ }
            render();
        });
    });

    // 点书名进入改名
    listEl.querySelectorAll('.book').forEach(el => {
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const slot = el.dataset.slot;
            const book = el.dataset.book;
            const old = el.textContent.trim();

            const input = document.createElement('input');
            input.className = 'book-input';
            input.maxLength = 40;
            input.value = old.startsWith('📕 ') ? '' : old;
            input.placeholder = '输入书名，回车保存';

            el.replaceWith(input);
            input.focus();
            input.select();

            const commit = async () => {
                const v = input.value.trim();
                try {
                    if (v) await window.reminderApi.renameSchedule(slot, book, v);
                } catch (e) { /* ignore */ }
                render();
            };
            input.addEventListener('keydown', (ev2) => {
                if (ev2.key === 'Enter') { ev2.preventDefault(); commit(); }
                if (ev2.key === 'Escape') { ev2.preventDefault(); render(); }
            });
            input.addEventListener('blur', commit);
        });
    });
}

document.getElementById('refresh').addEventListener('click', render);

window.reminderApi.onChanged(() => render());

render();
