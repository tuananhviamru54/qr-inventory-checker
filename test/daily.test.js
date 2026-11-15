import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyMessage } from '../src/daily.js';
import { msUntilVn } from '../src/bot.js';

const ok = (rows, totals = null) => ({ missingFields: [], rows, totals });
const dbt = (ma, ckn, ckc, psn = 0, psc = 0) => ({ ma_doi_tuong: ma, ten_doi_tuong: `Tên ${ma}`, dk_no: ckn - psn + psc, dk_co: ckc, ps_no: psn, ps_co: psc, ck_no: ckn, ck_co: ckc });
const base = () => ({
  cash: ok([{ dien_giai: 'Số dư đầu kỳ', no: 0, co: 0, ton: 100 }, { dien_giai: 'Thu', ngay: '2026-11-16', so_thu: 'PT1', no: 50, co: 0, ton: 150 }]),
  bank: ok([{ tk_nh: 'A', ten_nh: 'MB', dau_ky: 1000, ps_no: 0, ps_co: 0, cuoi_ky: 1000 }]),
  sales: ok([{ ma_hang: 'H1', ten_hang: 'Ống nhựa', sl_ban: 2, doanh_so: 300, chiet_khau: 0, gia_tri_tra: 0, giam_gia: 0, doanh_thu: 300, tien_von: 200, lai_gop: 100 }]),
  salesKh: ok([{ ma_kh: 'K1', ten_kh: 'Khách 1', doanh_so: 300, chiet_khau: 0, gia_tri_tra: 0, giam_gia: 0, doanh_thu: 300, tien_von: 200, lai_gop: 100 }]),
  ar: ok([dbt('K1', 500, 0, 300, 0)]),
  ap: ok([dbt('N1', 0, 700)]),
  stock: ok([{ ma_hang: 'H1', ten_hang: 'Ống', sl_dau_ky: 5, sl_nhap: 0, sl_xuat: 2, sl_cuoi_ky: 3, gt_dau_ky: 50, gt_nhap: 0, gt_xuat: 20, gt_cuoi_ky: 30 }, { ma_hang: 'H2', ten_hang: 'Co', sl_dau_ky: 0, sl_nhap: 0, sl_xuat: 1, sl_cuoi_ky: -1, gt_dau_ky: 0, gt_nhap: 0, gt_xuat: 10, gt_cuoi_ky: -10 }]),
});

test('báo cáo cuối ngày: đủ 6 phần, tổng tiền, top khách/mặt hàng, cảnh báo tồn âm', () => {
  const msg = buildDailyMessage({ date: '16/11/2026', now: new Date('2026-11-16T10:30:00Z'), ds: base() });
  assert.match(msg, /Thứ hai, 16\/11\/2026/);
  assert.match(msg, /TIỀN HIỆN CÓ<\/b>: <b>1\.150 đ/);
  assert.match(msg, /hôm nay thu \+50 đ, chi −0 đ/);
  assert.match(msg, /Doanh thu thuần <b>300 đ/);
  assert.match(msg, /🥇 Khách 1/);
  assert.match(msg, /🥇 Ống nhựa/);
  assert.match(msg, /PHẢI THU KHÁCH<\/b>: <b>500 đ/);
  assert.match(msg, /PHẢI TRẢ NCC<\/b>: <b>700 đ/);
  assert.match(msg, /1 mặt hàng tồn kho âm: H2/);
});

test('báo cáo cuối ngày: ngày không bán hàng không báo lệch; một báo cáo lỗi vẫn gửi phần còn lại', () => {
  const ds = base();
  ds.sales = ok([]); ds.salesKh = { error: 'NO_DATA: báo cáo không có dữ liệu' };
  ds.ap = { error: 'Hết thời gian chờ' };
  const msg = buildDailyMessage({ date: '15/11/2026', ds });
  assert.match(msg, /Chưa có doanh số trong ngày/);
  assert.doesNotMatch(msg, /Doanh số mặt hàng, /);
  assert.match(msg, /PHẢI TRẢ NCC<\/b>: ⚠️ Hết thời gian chờ/);
  assert.match(msg, /TỒN KHO/);
});

test('lịch 17:30 giờ Việt Nam', () => {
  assert.equal(msUntilVn('17:30', Date.parse('2026-11-15T10:00:00Z')), 30 * 60000); // 17:00 VN → còn 30 phút
  assert.equal(msUntilVn('17:30', Date.parse('2026-11-15T11:00:00Z')), (24 * 60 - 30) * 60000); // 18:00 VN → mai
});
