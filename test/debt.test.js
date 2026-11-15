import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebtMessage } from '../src/debt.js';

const period = { fromDate: '01/11/2026', toDate: '15/11/2026' };
const row = (ma, dkn, dkc, psn, psc, ckn, ckc) => ({ ma_doi_tuong: ma, ten_doi_tuong: `Đối tượng ${ma}`, dk_no: dkn, dk_co: dkc, ps_no: psn, ps_co: psc, ck_no: ckn, ck_co: ckc });

test('công nợ phải thu: dư = Nợ − Có, top khách, đối chiếu khớp', () => {
  const rows = [row('K1', 100, 0, 50, 20, 130, 0), row('K2', 0, 0, 10, 40, 0, 30)];
  const dataset = { missingFields: [], rows, totals: row('Tổng cộng', 100, 0, 60, 60, 130, 30) };
  const msg = buildDebtMessage({ kind: 'receivable', label: 'x', period, dataset, minBalance: 0 });
  assert.match(msg, /Dư cuối kỳ<\/b>: 100 đ/);
  assert.match(msg, /K1/);
  assert.match(msg, /dư bên Có/);
  assert.match(msg, /Đã đối chiếu/);
});

test('công nợ phải trả: dư = Có − Nợ', () => {
  const dataset = { missingFields: [], rows: [row('N1', 0, 500, 100, 300, 0, 700)], totals: null };
  const msg = buildDebtMessage({ kind: 'payable', label: 'x', period, dataset });
  assert.match(msg, /Dư cuối kỳ<\/b>: 700 đ/);
  assert.match(msg, /Dư đầu kỳ: 500 đ/);
  assert.match(msg, /Mua chịu/);
});

test('công nợ: cảnh báo khi tổng lệch dòng "Tổng cộng" của AMIS hoặc đầu kỳ + phát sinh ≠ cuối kỳ', () => {
  const dataset = { missingFields: [], rows: [row('K1', 100, 0, 50, 20, 999, 0)], totals: row('Tổng cộng', 1, 0, 50, 20, 130, 0) };
  const msg = buildDebtMessage({ kind: 'receivable', label: 'x', period, dataset });
  assert.match(msg, /đầu kỳ \+ phát sinh ≠ cuối kỳ/);
  assert.match(msg, /khác dòng "Tổng cộng"/);
});

test('công nợ: thiếu cột thì báo rõ', () => {
  const msg = buildDebtMessage({ kind: 'receivable', label: 'x', period, dataset: { missingFields: ['ck_no'], rows: [], totals: null } });
  assert.match(msg, /thiếu cột/);
});

test('công nợ: chỉ liệt kê đối tượng dư từ 100.000 đ trở lên, đủ danh sách', () => {
  const rows = [row('A', 0, 0, 500000, 0, 500000, 0), row('B', 0, 0, 100000, 0, 100000, 0), row('C', 0, 0, 99999, 0, 99999, 0)];
  const msg = buildDebtMessage({ kind: 'receivable', label: 'x', period, dataset: { missingFields: [], rows, totals: null } });
  assert.match(msg, /2 khách hàng có dư cuối kỳ từ 100\.000 đ/);
  assert.match(msg, /<code>A<\/code>/); assert.match(msg, /<code>B<\/code>/); assert.doesNotMatch(msg, /<code>C<\/code>/);
  assert.match(msg, /Còn 1 khách hàng dư dưới/);
});
