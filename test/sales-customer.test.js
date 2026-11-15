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
