// 账号生成器：node make-account.js 用户名 密码A
// 输出可直接粘贴到 accounts.json 的 users 数组里的条目
const crypto = require('crypto');
const [,, user, pass] = process.argv;
if (!user || !pass) {
  console.log('用法: node make-account.js 用户名 密码');
  process.exit(1);
}
const hash = crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
console.log(JSON.stringify({ user: user, pass: hash, note: '' }, null, 2));