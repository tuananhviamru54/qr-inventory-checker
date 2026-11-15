import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesMessage } from '../src/sales.js';

const period = { fromDate: '01/10/2026', toDate: '31/10/2026' };
const row = (ma, ds, ck, tra, dt, von, lai) => ({ ma_kh: ma, ten_kh: `Khách ${ma}`, doanh_so: ds, chiet_khau: ck, gia_tri_tra: tra, giam_gia: 0, doanh_thu: dt, tien_von: von, lai_gop: lai });

test('doanh số theo khách hàng: liệt kê đủ khách, xếp theo doanh thu thuần, đối chiếu khớp', () => {
  const rows = [row('A', 100, 10, 0, 90, 60, 30), row('B', 500, 0, 50, 450, 400, 50)];
  const msg = buildSalesMessage({ by: 'customer', label: 'Tháng trước', period, dataset: { missingFields: ['sl_ban'], rows, totals: row('Tổng cộng', 600, 10, 50, 540, 460, 80) } });
  assert.match(msg, /Doanh số theo khách hàng — Tháng trước/);
  assert.match(msg, /Doanh thu thuần<\/b>: 540 đ/);
  assert.match(msg, /2 khách hàng có phát sinh/);
  assert.ok(msg.indexOf('<code>B</code>') < msg.indexOf('<code>A</code>'));
  assert.doesNotMatch(msg, /Nhóm VTHH/);
  assert.match(msg, /Đã đối chiếu/);
});

test('doanh số theo khách hàng: tổng lệch dòng "Tổng cộng" thì cảnh báo', () => {
  const msg = buildSalesMessage({ by: 'customer', label: 'x', period, dataset: { missingFields: [], rows: [row('A', 100, 10, 0, 90, 60, 30)], totals: row('Tổng cộng', 999, 10, 0, 90, 60, 30) } });
  assert.match(msg, /khác dòng "Tổng cộng"/);
});

test('tin lỗi dễ hiểu: lỗi chương trình, AMIS chậm, lỗi khác giữ nguyên', async () => {
  const { friendlyError } = await import('../src/bot.js');
  assert.match(friendlyError(new ReferenceError('by is not defined')), /Lỗi trong chương trình.*\n.*by is not defined/);
  assert.match(friendlyError(new Error('locator.waitFor: Timeout 30000ms exceeded')), /AMIS phản hồi chậm/);
  assert.equal(friendlyError(new Error('Tài khoản đang được dùng ở nơi khác')), 'Tài khoản đang được dùng ở nơi khác');
});

test('trang chủ: chú thích ảnh dưới giới hạn 1024 ký tự của Telegram, ô bấm trỏ tới đủ 6 báo cáo', async () => {
  const { dashboardCaption, DASHBOARD_KEYBOARD } = await import('../src/bot.js');
  const cap = dashboardCaption({ secrets: { targetDb: 'KHO QUẢNG NINH' } }, new Date('2026-11-15T03:00:00Z'));
  assert.ok(cap.length < 1024, `dài ${cap.length}`);
  assert.match(cap, /ECOPLAST QUẢNG NINH/);
  assert.match(cap, /Chủ nhật, 15\/11\/2026/);
  const data = DASHBOARD_KEYBOARD.inline_keyboard.flat().map((b) => b.callback_data);
  for (const d of ['k:menu', 'm:menu', 's:menu', 'h:menu', 'p:menu', 'q:menu', 'z:check', 'z:help']) assert.ok(data.includes(d), d);
});
