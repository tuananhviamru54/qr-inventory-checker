import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRedactor, hostAllowed, allowedHostsOf, RateLimiter, hardenFiles, rotateLogs } from '../src/security.js';

test('che bí mật: mật khẩu / mã bot không lọt ra tin gửi đi, kể cả dạng mã hoá URL', () => {
  const r = makeRedactor(['P@ss word!', '123456:ABC-token', '', undefined, 'abc']);
  assert.equal(r('lỗi: P@ss word! sai'), 'lỗi: ••• sai');
  assert.equal(r(`body=password=${encodeURIComponent('P@ss word!')}&x=1`), 'body=password=•••&x=1');
  assert.equal(r('https://api.telegram.org/bot123456:ABC-token/sendMessage'), 'https://api.telegram.org/bot•••/sendMessage');
  assert.equal(r('abc giữ nguyên vì quá ngắn'), 'abc giữ nguyên vì quá ngắn');
});

test('chỉ làm việc với máy chủ MISA: tên miền con được, tên giả mạo thì không', () => {
  const hosts = allowedHostsOf({ baseUrl: 'https://actapp.misa.vn/app' });
  for (const ok of ['https://actapp.misa.vn/app/x', 'https://id.misa.vn/login', 'https://amisapp.misa.vn/', 'about:blank']) assert.ok(hostAllowed(ok, hosts), ok);
  for (const bad of ['https://misa.vn.evil.com/login', 'https://evilmisa.vn/', 'https://actapp.misa.vn.attacker.io/', 'http://example.com', 'javascript:alert(1)', 'not a url']) assert.ok(!hostAllowed(bad, hosts), bad);
  assert.ok(hostAllowed('http://127.0.0.1:3000/x', allowedHostsOf({ baseUrl: 'http://127.0.0.1:3000' })));
});

test('giới hạn tần suất: quá ngưỡng thì cảnh báo 1 lần rồi bỏ qua, hết cửa sổ thì dùng lại được', () => {
  const rl = new RateLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => rl.check('u', i)), ['ok', 'ok', 'ok', 'warn', 'drop']);
  assert.equal(rl.check('khac', 5), 'ok');
  assert.equal(rl.check('u', 5000), 'ok');
});

test('siết quyền file bí mật và xoay vòng nhật ký', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'X=1', { mode: 0o644 });
    fs.mkdirSync(path.join(root, 'output'), { mode: 0o755 });
    hardenFiles({ root, dirs: { output: path.join(root, 'output') } });
    assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, 'output')).mode & 0o777, 0o700);
    fs.writeFileSync(path.join(root, 'output', 'giam-sat.log'), 'x'.repeat(200));
    rotateLogs(path.join(root, 'output'), ['giam-sat.log'], 100);
    assert.ok(fs.existsSync(path.join(root, 'output', 'giam-sat.log.1')) && !fs.existsSync(path.join(root, 'output', 'giam-sat.log')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nhiều công ty: mỗi công ty có tài khoản, sổ dữ liệu, hồ sơ trình duyệt, thư mục tải về và Nhóm VTHH riêng', async () => {
  const { tenantConfig, defaultTenantId } = await import('../src/config.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ten-'));
  try {
    fs.writeFileSync(path.join(root, '.env.b'), 'MISA_WEB_USERNAME=userB\nMISA_WEB_PASSWORD="p@ss=B"\n');
    const base = { root, title: 'x', dirs: { profile: path.join(root, '.auth/profile'), downloads: path.join(root, 'downloads'), output: path.join(root, 'output') }, secrets: { username: 'userA', password: 'pA', targetDb: 'KHO A', telegramToken: 't' }, sources: [{ id: 'doanh_so', groups: { file: 'data/nhom_vthh.json' } }],
      tenants: [{ id: 'a', name: 'A', default: true }, { id: 'b', name: 'B', envFile: '.env.b', targetDb: 'SỔ B' }] };
    assert.equal(defaultTenantId(base), 'a');
    const a = tenantConfig(base, 'a'), b = tenantConfig(base, 'b');
    assert.equal(a.secrets.username, 'userA'); assert.equal(a.dirs.profile, base.dirs.profile);
    assert.deepEqual([b.secrets.username, b.secrets.password, b.secrets.targetDb, b.secrets.telegramToken], ['userB', 'p@ss=B', 'SỔ B', 't']);
    assert.equal(b.dirs.profile, path.join(root, '.auth-b/profile'));
    assert.equal(b.dirs.downloads, path.join(root, 'downloads/b'));
    assert.equal(b.sources[0].groups.file, 'data/nhom_vthh.b.json');
    assert.equal(tenantConfig(base, 'khong-co').tenant, 'a'); // mã lạ → công ty mặc định
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trang tổng công ty: chi nhánh trước (Toàn công ty ở đầu), sổ riêng sau; phạm vi chi nhánh có thư mục tải về riêng', async () => {
  const { companyDashboard } = await import('../src/bot.js');
  const { scopeConfig } = await import('../src/config.js');
  const config = { root: os.tmpdir(), dirs: { downloads: '/d', profile: '/p', output: '/o' }, secrets: {}, sources: [], tenants: [
    { id: 'qn', name: 'Kho Quảng Ninh', default: true },
    { id: 'tf', name: 'The Five', brand: 'CÔNG TY THE FIVE', top: true, envFile: '.khong-co', branches: [{ name: 'Toàn công ty', icon: '🏢', codes: ['A', 'B'] }, { name: 'Kho A', codes: ['A'] }, { name: 'Kho B', codes: ['B'] }] }] };
  const { caption, reply_markup } = companyDashboard(config, new Date('2026-11-15T03:00:00Z'));
  assert.match(caption, /^🏢 <b>CÔNG TY THE FIVE<\/b>/);
  assert.ok(caption.indexOf('Toàn công ty') < caption.indexOf('Kho A') && caption.indexOf('Kho B') < caption.indexOf('Kho Quảng Ninh'));
  const data = reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data, ['z:br:tf:0', 'z:br:tf:1', 'z:br:tf:2', 'z:br:qn:0']);
  const a = scopeConfig(config, 'tf', 1), all = scopeConfig(config, 'tf', 0);
  assert.deepEqual([a.branchName, a.branchCodes], ['Kho A', ['A']]);
  assert.deepEqual(all.branchCodes, ['A', 'B']);
  assert.notEqual(a.dirs.downloads, all.dirs.downloads);
  assert.equal(scopeConfig(config, 'qn', 0).branchCodes, undefined);
});
