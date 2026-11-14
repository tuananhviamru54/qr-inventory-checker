import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { startMock } from './mock-server.js';
import { withDefaults } from '../src/config.js';
import { runPipeline } from '../src/index.js';
import { LoginError } from '../src/amis.js';
import { parseNumber, resolvePeriod, totp } from '../src/util.js';
import { blockReason, forbiddenLabel } from '../src/readonly.js';

const base = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function makeConfig(mock, root, password = 'secret') {
  const cfg = structuredClone(base);
  cfg.amis.baseUrl = mock.url;
  cfg.amis.loginTimeoutMs = 8000;
  cfg.amis.loginDetectMs = 2000;
  cfg.sources[0].steps = [
    { click: 'text=Tổng hợp tồn kho' },
    { fill: { selector: "input[placeholder*='Từ ngày']", value: '{{fromDate}}' } },
    { fill: { selector: "input[placeholder*='Đến ngày']", value: '{{toDate}}' } },
    { click: "button:has-text('Đồng ý')" },
    { click: "button:has-text('Xuất khẩu')" },
    { download: 'text=Excel' },
  ];
  cfg.secrets = { username: 'demo', password, targetDb: 'KHO QUẢNG NINH', telegramToken: 'T0KEN', telegramChatId: '42', telegramApiBase: mock.url };
  return withDefaults(cfg, root);
}

async function writeKiemKe(root) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Kiểm kê');
  ws.addRow(['Mã hàng', 'Tên hàng', 'Số lượng thực tế']);
  ws.addRow(['SP001', 'Bút bi', 70]);
  ws.addRow(['sp001', 'Bút bi', 50]);   // cùng mã, 2 vị trí → cộng dồn = 120
  ws.addRow(['SP002', 'Vở kẻ ngang', 175]);
  ws.addRow(['SP003', 'Thước kẻ', 0]);
  ws.addRow(['SP004', 'Tẩy', 50]);
  ws.addRow(['SP005', 'Hồ dán', 1007.5]);
  ws.addRow(['SP999', 'Hàng lạ', 3]);
  await wb.xlsx.writeFile(path.join(root, 'data', 'kiem_ke.xlsx'));
}

test('quy trình đầy đủ: đăng nhập → xuất → kiểm tra chéo → Telegram', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    await writeKiemKe(root);
    const config = makeConfig(mock, root);
    const out = await runPipeline(config, { log: () => {} });

    assert.deepEqual(mock.state.logins, [{ username: 'demo', password: 'secret' }]);
    const period = resolvePeriod('thisMonth');
    assert.deepEqual(mock.state.exports, [{ from: period.fromDate, to: period.toDate }]);
    assert.equal(out.datasets.ton_kho.rows.length, 5);
    assert.equal(mock.state.db, 'QN');

    const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
    assert.deepEqual(by.amis_vs_kiem_ke.issues.map((i) => [i.kind, i.key]), [
      ['mismatch', 'SP002'], ['mismatch', 'SP003'], ['missing', 'SP999'],
    ]);
    assert.match(by.amis_vs_kiem_ke.issues[0].detail, /180 → 175 \(-5\)/);
    assert.deepEqual(by.can_doi_nxt.issues.map((i) => i.key), ['SP004', 'SP005']);
    assert.deepEqual(by.ton_am.issues.map((i) => i.key), ['SP003']);

    const calls = mock.state.telegram;
    assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
    const msg = JSON.parse(calls[0].text);
    assert.equal(msg.chat_id, '42');
    assert.match(msg.text, /SP002/);
    assert.match(msg.text, /3 vấn đề/);
    assert.match(calls[1].body, /filename="chenh-lech-.*\.xlsx"/);
    assert.ok(fs.existsSync(out.issuesFile));

    // Lần 2: phiên đã lưu trong hồ sơ trình duyệt → không phải đăng nhập lại
    await runPipeline(config, { log: () => {}, send: false });
    assert.equal(mock.state.logins.length, 1);
    assert.equal(mock.state.exports.length, 2);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('sai mật khẩu → báo lỗi về Telegram kèm ảnh màn hình', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root, 'sai');
    await assert.rejects(runPipeline(config, { log: () => {} }), LoginError);
    assert.deepEqual(mock.state.telegram.map((c) => c.method), ['sendMessage', 'sendPhoto']);
    assert.match(JSON.parse(mock.state.telegram[0].text).text, /Không lấy được báo cáo/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('thiếu file kiểm kê → bỏ qua phép so sánh, vẫn chạy các phép còn lại (không tải lại)', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root);
    await runPipeline(config, { log: () => {}, send: false });
    const out = await runPipeline(config, { log: () => {}, send: false, download: false });
    assert.equal(mock.state.exports.length, 1);
    assert.deepEqual(out.results.map((r) => r.status), ['skipped', 'fail', 'fail']);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('chỉ đọc: từ chối bấm nút ghi dữ liệu, chặn yêu cầu ghi ở tầng mạng', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    // 1. Bước cấu hình cố bấm "Cất" (kể cả bằng selector không chứa chữ) → bị từ chối, không có gì gửi lên máy chủ
    for (const selector of ['text=Cất', '#cat']) {
      const config = makeConfig(mock, root);
      config.sources[0].steps.splice(4, 0, { click: selector });
      const out = await runPipeline(config, { log: () => {}, send: false });
      assert.match(out.datasets.ton_kho.error, /Chế độ chỉ đọc/);
    }
    assert.deepEqual(mock.state.writes, []);
    assert.equal(mock.state.exports.length, 0);

    // 2. Nút trông vô hại nhưng trang tự gửi yêu cầu ghi → bị chặn ở tầng mạng, yêu cầu đọc vẫn qua
    const config = makeConfig(mock, root);
    config.sources[0].steps.splice(4, 0, { click: "button:has-text('Nạp dữ liệu')" }, { wait: 500 });
    const out = await runPipeline(config, { log: () => {} });
    assert.deepEqual(mock.state.writes, []);
    assert.deepEqual(mock.state.reads, ['POST /api/report/GetData']);
    assert.deepEqual(out.blocked.map((b) => b.method).sort(), ['DELETE', 'POST']);
    assert.equal(out.datasets.ton_kho.rows.length, 5);
    assert.match(JSON.parse(mock.state.telegram[0].text).text, /đã chặn 2 yêu cầu ghi/);
    assert.match(fs.readFileSync(path.join(root, 'output', 'nhat-ky-yeu-cau.log'), 'utf8'), /CHAN\tDELETE/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('tiện ích', async () => {
  assert.equal(blockReason('GET', 'https://x/api/voucher/delete'), null);
  assert.ok(blockReason('PUT', 'https://x/api/report'));
  assert.ok(blockReason('POST', 'https://x/api/INVoucher/SaveVoucher'));
  assert.equal(blockReason('POST', 'https://x/api/report/ExportExcel'), null);
  assert.equal(blockReason('POST', 'https://x/api/a/update', ['/api/a/update$']), null);
  assert.equal(forbiddenLabel('Xuất khẩu'), null);
  assert.equal(forbiddenLabel('Đồng ý'), null);
  assert.equal(forbiddenLabel('Xem thêm'), null);
  assert.equal(forbiddenLabel('Cất và Thêm'), 'cat');
  assert.equal(forbiddenLabel(' Ghi sổ '), 'ghi so');
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('(1.200)'), -1200);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('abc'), null);
  assert.deepEqual(resolvePeriod('lastMonth', new Date('2026-03-15T00:00:00Z')), { fromDate: '01/02/2026', toDate: '28/02/2026', today: '15/03/2026' });
  // 17:30 UTC đã sang ngày hôm sau theo giờ VN
  assert.equal(resolvePeriod('today', new Date('2026-11-14T17:30:00Z')).today, '15/11/2026');
  assert.equal(await totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082'); // vector RFC 6238
});
