import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockMessage } from '../src/stock.js';

const period = { fromDate: '01/11/2026', toDate: '15/11/2026' };
const row = (ma, d, n, x, c, k = 1000) => ({ ma_hang: ma, ten_hang: `Hàng ${ma}`, sl_dau_ky: d, sl_nhap: n, sl_xuat: x, sl_cuoi_ky: c, gt_dau_ky: d * k, gt_nhap: n * k, gt_xuat: x * k, gt_cuoi_ky: c * k });

test('tin tồn kho: cộng đúng, gộp mã hàng ở nhiều kho, đối chiếu khớp', () => {
  const dataset = { missingFields: [], rows: [row('A', 10, 5, 3, 12), row('A', 2, 0, 0, 2), row('B', 4, 0, 4, 0)], totals: null };
  const msg = buildStockMessage({ label: 'Tháng này', period, dataset, groups: ['ECO'] });
  assert.match(msg, /Nhóm VTHH: ECO/);
  assert.match(msg, /2 mặt hàng/);
  assert.match(msg, /Tồn cuối kỳ<\/b>: 14\.000 đ/);
  assert.match(msg, /Đã đối chiếu/);
});

test('tin tồn kho: cảnh báo tồn âm và lệch đầu kỳ + nhập − xuất', () => {
  const dataset = { missingFields: [], rows: [row('A', 10, 5, 3, 99), row('N', 0, 0, 2, -2)], totals: null };
  const msg = buildStockMessage({ label: 'x', period, dataset });
  assert.match(msg, /1 mặt hàng tồn âm/);
  assert.match(msg, /khác cuối kỳ/);
});

test('tin tồn kho: thiếu cột thì báo rõ, không bịa số', () => {
  const msg = buildStockMessage({ label: 'x', period, dataset: { missingFields: ['gt_cuoi_ky'], rows: [], totals: null } });
  assert.match(msg, /thiếu cột/);
});
