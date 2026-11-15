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
