const incomeEl = document.getElementById('income');
const statsEl = document.getElementById('stats');
const daysEl = document.getElementById('days');
const manualEl = document.getElementById('manual');

async function render() {
    const d = await window.earningsApi.get();
    const t = d.today || {};
    incomeEl.textContent = '¥' + Number(t.income || 0).toFixed(2);
    // 各条明细（可逐条删除）
    const perAcc = t.incomes || {};
    const keys = Object.keys(perAcc);
    const host = incomeEl.parentElement;
    const oldBox = host.querySelector('.acc-detail');
    if (oldBox) oldBox.remove();

    if (keys.length) {
        const box = document.createElement('div');
        box.className = 'acc-detail';
        box.style.cssText = 'margin-top:8px;font-size:11.5px;color:#64748b;line-height:1.9;';

        const bookCount = keys.length;

        box.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
            '<span>共 ' + bookCount + ' 本</span>' +
            '<button id="clear-all" style="margin-left:auto;height:22px;padding:0 8px;border-radius:6px;border:1px solid #fecaca;background:#fef2f2;color:#ef4444;font-size:11px;cursor:pointer;">全部清空</button>' +
            '</div>' +
            keys.map(function (k) {
                const parts = String(k).split('|');
                const tail = parts[1] || '';
                const name = tail.indexOf('nm:') === 0
                    ? ('账号' + (parts[0] || '?') + ' ' + tail.slice(3))
                    : ('账号' + (parts[0] || '?'));
                const amt = Number(perAcc[k]).toFixed(2);
                return '<div style="display:flex;align-items:center;gap:6px;">' +
                    '<span>' + name + ' ¥' + amt + '</span>' +
                    '<span data-k="' + k + '" class="del-in" style="margin-left:auto;color:#ef4444;cursor:pointer;">删除</span>' +
                    '</div>';
            }).join('');

        host.insertBefore(box, host.querySelector('.sub'));

        box.querySelectorAll('.del-in').forEach(function (el) {
            el.addEventListener('click', async function () {
                await window.earningsApi.del(el.dataset.k);
                render();
            });
        });
        const clearBtn = box.querySelector('#clear-all');
        if (clearBtn) clearBtn.addEventListener('click', async function () {
            if (!confirm('清空今天所有收益记录？')) return;
            await window.earningsApi.clear();
            render();
        });
    }

    statsEl.textContent = `更新 ${t.chapters || 0} 章 · ${t.words || 0} 字 · ${t.books || 0} 本书`;

    const days = d.days || [];
    if (!days.length) {
        daysEl.innerHTML = '<tr><td colspan="4" class="empty">还没有记录</td></tr>';
        return;
    }
    daysEl.innerHTML = days.slice().reverse().map(x => `
        <tr>
            <td>${x.date.slice(5)}</td>
            <td class="num">${x.chapters}</td>
            <td class="num">${x.words}</td>
            <td class="num">${x.income ? '¥' + Number(x.income).toFixed(2) : '—'}</td>
        </tr>`).join('');
}

document.getElementById('refresh').addEventListener('click', render);

document.getElementById('save').addEventListener('click', async () => {
    // 允许粘贴 "￥12.48"、"12,480"、"12.48元" 这类写法
    let raw = String(manualEl.value || '').replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    raw = raw.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    if (!isFinite(v) || v < 0) { alert('没读到数字，直接填 12.48 这样就行'); return; }
    const nmEl = document.getElementById('mname');
    await window.earningsApi.add(nmEl ? nmEl.value : '', v);
    manualEl.value = '';
    if (nmEl) nmEl.value = '';
    render();
});

render();

// 直接设定今日总额（覆盖明细）
const setTotalBtn = document.getElementById('set-total');
if (setTotalBtn) {
    setTotalBtn.addEventListener('click', async () => {
        const raw = String(manualEl.value || '').replace(/[０-９]/g, function (c) {
            return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
        }).replace(/[^0-9.]/g, '');
        const v = parseFloat(raw);
        if (!isFinite(v) || v < 0) { alert('先在金额框里填一个数字'); return; }
        await window.earningsApi.clear();
        await window.earningsApi.setIncome(v);
        manualEl.value = '';
        render();
    });
}


// 完成今日收益（固定下来，自动扫描不再覆盖）
const finishBtn = document.getElementById('finish');
if (finishBtn) {
    finishBtn.addEventListener('click', async () => {
        const raw = String(manualEl.value || '').replace(/[０-９]/g, function (c) {
            return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
        }).replace(/[^0-9.]/g, '');
        const v = parseFloat(raw);
        const cur = Number((document.getElementById('income').textContent || '0').replace(/[^0-9.]/g, ''));
        const use = isFinite(v) && v >= 0 ? v : cur;
        if (!confirm('把今日收益固定为 ¥' + use.toFixed(2) + '？\n\n固定后自动扫描不会再改它。')) return;
        await window.earningsApi.finish(use);
        manualEl.value = '';
        render();
    });
}
