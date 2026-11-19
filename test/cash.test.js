import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCashMessage, summarizeCash } from '../src/cash.js';

const period = { fromDate: '01/11/2026', toDate: '15/11/2026' };
const tx = (ngay, thu, chi, dg, no, co, ton) => ({ ngay, so_thu: thu, so_chi: chi, dien_giai: dg, no, co, ton });
const cashRows = [tx('', '', '', 'Số dư đầu kỳ', 0, 0, 100), tx('2026-11-02', '', 'PC1', 'Chi mua giấy', 0, 300, -200), tx('2026-11-03', 'PT1', '', 'Thu tiền khách', 1000, 0, 800)];
const bankRow = (tk, dk, no, co, ck) => ({ tk_nh: tk, ten_nh: `NH ${tk}`, dau_ky: dk, ps_no: no, ps_co: co, cuoi_ky: ck });

test('quỹ tiền: tổng = tiền mặt + ngân hàng, thu/chi, cảnh báo quỹ âm, đối chiếu khớp', () => {
  const cash = { missingFields: [], rows: cashRows, totals: null };
  const bank = { missingFields: [], rows: [bankRow('A', 50, 20, 10, 60), bankRow('B', 0, 500, 0, 500)], totals: bankRow('Tổng cộng', 50, 520, 10, 560) };
  assert.equal(summarizeCash(cash).closing, 800);
  const msg = buildCashMessage({ label: 'Tháng này', period, cash, bank });
  assert.match(msg, /Tổng tiền cuối kỳ<\/b>: 1\.360 đ/);
  assert.match(msg, /Tồn cuối kỳ<\/b>: 800 đ/);
  assert.match(msg, /bị ÂM ở 1 dòng.*-200 đ/);
  assert.match(msg, /02\/11 <code>PC1<\/code> Chi mua giấy — 300 đ/);
  assert.ok(msg.indexOf('<code>B</code>') < msg.indexOf('<code>A</code>'));
  assert.match(msg, /Đã đối chiếu/);
});

test('quỹ tiền: lệch số tồn / lệch Tổng cộng thì cảnh báo; thiếu một báo cáo vẫn gửi phần còn lại', () => {
  const cash = { missingFields: [], rows: [...cashRows.slice(0, 2), tx('2026-11-03', 'PT1', '', 'Thu', 1000, 0, 999)], totals: null };
  const bank = { missingFields: [], rows: [bankRow('A', 50, 20, 10, 60)], totals: bankRow('Tổng cộng', 50, 20, 10, 99) };
  const msg = buildCashMessage({ label: 'x', period, cash, bank });
  assert.match(msg, /khác số tồn dòng cuối của AMIS/);
  assert.match(msg, /khác dòng "Tổng cộng"/);
  const part = buildCashMessage({ label: 'x', period, cash: { error: 'lỗi xuất' }, bank });
  assert.match(part, /Chưa lấy được sổ quỹ tiền mặt: lỗi xuất/);
  assert.match(part, /Dư cuối kỳ<\/b>: 60 đ/);
  assert.doesNotMatch(part, /Tổng tiền cuối kỳ/);
  assert.match(buildCashMessage({ label: 'x', period, cash: { noData: true }, bank }), /Không có phát sinh tiền mặt/);
});
