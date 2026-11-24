const userEl = document.getElementById('user');
const passEl = document.getElementById('pass');
const btn = document.getElementById('btn');
const errEl = document.getElementById('err');

async function doLogin() {
  const user = (userEl.value || '').trim();
  const pass = passEl.value || '';
  if (!user || !pass) { errEl.textContent = '请输入用户名和密码'; return; }
  btn.disabled = true;
  errEl.textContent = '正在验证…';
  try {
    const r = await window.loginApi.login(user, pass);
    if (r && r.ok) {
      errEl.textContent = '登录成功，正在启动…';
      window.loginApi.done();
    } else {
      errEl.textContent = (r && r.reason) || '登录失败';
      btn.disabled = false;
    }
  } catch (e) {
    errEl.textContent = '登录出错：' + e.message;
    btn.disabled = false;
  }
}

btn.addEventListener('click', doLogin);
passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
userEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') passEl.focus(); });
userEl.focus();