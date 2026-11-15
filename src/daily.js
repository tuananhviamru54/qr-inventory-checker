// "Báo cáo cuối ngày": gom số liệu của cả 6 báo cáo trên trang chủ thành 1 tin tóm tắt (gửi tự động lúc 17:30).
// Mọi con số do chương trình cộng từ file AMIS (không qua AI); phần đối chiếu dùng lại đúng các bước kiểm tra của từng báo cáo.
import { escapeHtml } from './util.js';
import { buildSalesMessage } from './sales.js';
import { buildStockMessage } from './stock.js';
import { buildDebtMessage } from './debt.js';
import { buildCashMessage, summarizeCash } from './cash.js';

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const vnd = (n) => `${nf.format(Math.round(n))} đ`;
function short(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  if (a >= 1e6) return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr`;
  return vnd(n);
}
/** "thu +X, chi −Y" hoặc "không phát sinh" khi cả hai bằng 0 */
const flow = (inLabel, a, outLabel, b) => (Math.round(a) || Math.round(b) ? `${inLabel} +${short(a)}, ${outLabel} −${short(b)}` : 'không phát sinh');
const big = (n) => `<b>${vnd(n)}</b>${Math.abs(n) >= 1e6 ? ` (≈ ${short(n)})` : ''}`;
const sum = (rows, f) => rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
const pct = (a, b) => (b ? `${((a / b) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%` : '—');
const cut = (s, n = 32) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const MEDALS = ['🥇', '🥈', '🥉'];

/** Trạng thái 1 báo cáo: 'ok' | 'empty' (AMIS báo không có dữ liệu) | 'error' */
const state = (ds) => (!ds ? 'error' : ds.error?.includes('NO_DATA') ? 'empty' : ds.error || ds.missing ? 'error' : 'ok');
const errText = (ds) => escapeHtml(cut(ds?.error ?? 'chưa có dữ liệu', 90));
/** Báo cáo chi tiết có tự đối chiếu khớp không (dùng lại đúng phần kiểm tra của báo cáo đó). */
const verified = (msg) => msg.includes('✔ Đã đối chiếu'); // các báo cáo chỉ in dòng này khi mọi phép kiểm tra đều khớp

/**
 * @param ds  { cash, bank, sales, salesKh, ar, ap, stock } — dataset đã đọc (hoặc {error})
 */
export function buildDailyMessage({ date, now = new Date(), targetDb, ds, updatedAt }) {
  const vn = new Date(now.getTime() + 7 * 3600e3);
  const period = { fromDate: date, toDate: date };
  const L = [
    '📋 <b>BÁO CÁO CUỐI NGÀY</b>',
    '🐉 <i>Tổng kho nhựa Ecoplast Quảng Ninh</i>',
    `📅 ${WEEKDAYS[vn.getUTCDay()]}, ${date}${targetDb ? ` · 🗄 ${escapeHtml(targetDb)}` : ''}`,
  ];
  if (updatedAt) L.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  const alerts = [];
  const checks = []; // [tên, true/false/null]

  // ---- 💵 Tiền ----
  L.push('━━━━━━━━━━━━━━━━━━');
  const cs = state(ds.cash), bs = state(ds.bank);
  const c = cs === 'ok' && !['no', 'co', 'ton'].some((f) => ds.cash.missingFields.includes(f)) ? summarizeCash(ds.cash) : null;
  const b = bs === 'ok' ? { open: sum(ds.bank.rows, 'dau_ky'), in: sum(ds.bank.rows, 'ps_no'), out: sum(ds.bank.rows, 'ps_co'), close: sum(ds.bank.rows, 'cuoi_ky'), n: ds.bank.rows.length } : null;
  if (c && b) L.push(`💵 <b>TIỀN HIỆN CÓ</b>: ${big(c.closing + b.close)}`);
  else L.push('💵 <b>TIỀN HIỆN CÓ</b>');
  if (c) L.push(`   🪙 Tiền mặt ${vnd(c.closing)} · hôm nay ${flow('thu', c.thu, 'chi', c.chi)}`);
  else L.push(`   🪙 Tiền mặt: ${cs === 'empty' ? 'không có phát sinh' : `⚠️ ${errText(ds.cash)}`}`);
  if (b) L.push(`   🏦 Ngân hàng ${vnd(b.close)} (${b.n} TK) · hôm nay ${flow('vào', b.in, 'ra', b.out)}`);
  else L.push(`   🏦 Ngân hàng: ${bs === 'empty' ? 'không có phát sinh' : `⚠️ ${errText(ds.bank)}`}`);
  if (c?.negatives.length) alerts.push(`Quỹ tiền mặt bị âm ở ${c.negatives.length} dòng (thấp nhất ${vnd(c.lowest)})`);
  if (c?.closing < 0) alerts.push('Tồn quỹ tiền mặt cuối ngày đang âm');
  if (c || b) checks.push(['Quỹ tiền', !/⚠️ (Tiền mặt|Ngân hàng):/.test(buildCashMessage({ label: '', period, cash: c ? ds.cash : { noData: true }, bank: b ? ds.bank : { noData: true } }))]);

  // ---- 💰 Bán hàng ----
  L.push('', '💰 <b>BÁN HÀNG HÔM NAY</b>');
  const ss = state(ds.sales), sk = state(ds.salesKh);
  const noRows = (st, d) => st === 'empty' || (st === 'ok' && !d.rows.length);
  const salesRows = ss === 'ok' ? ds.sales.rows : sk === 'ok' ? ds.salesKh.rows : null;
  if (noRows(ss, ds.sales) && noRows(sk, ds.salesKh)) L.push('   Chưa có doanh số trong ngày.');
  else if (!salesRows) L.push(`   ⚠️ ${errText(ss === 'error' ? ds.sales : ds.salesKh)}`);
  else {
    const dt = sum(salesRows, 'doanh_thu'), lg = sum(salesRows, 'lai_gop'), dsb = sum(salesRows, 'doanh_so');
    L.push(`   Doanh thu thuần ${big(dt)}`);
    L.push(`   Doanh số ${vnd(dsb)} · lãi gộp ${vnd(lg)} (${pct(lg, dt)})`);
    const nKh = sk === 'ok' ? ds.salesKh.rows.length : null, nMh = ss === 'ok' ? ds.sales.rows.length : null;
    L.push(`   ${[nKh != null && `${nKh} khách hàng`, nMh != null && `${nMh} mặt hàng`].filter(Boolean).join(' · ')}`);
    if (sk === 'ok' && ds.salesKh.rows.length) {
      L.push('   <u>Khách mua nhiều nhất</u>');
      [...ds.salesKh.rows].sort((x, y) => y.doanh_thu - x.doanh_thu).slice(0, 3).forEach((r, i) => L.push(`   ${MEDALS[i]} ${escapeHtml(cut(r.ten_kh || r.ma_kh))} — ${short(r.doanh_thu)}`));
    }
    if (ss === 'ok' && ds.sales.rows.length) {
      L.push('   <u>Mặt hàng bán chạy</u>');
      [...ds.sales.rows].sort((x, y) => y.doanh_thu - x.doanh_thu).slice(0, 3).forEach((r, i) => L.push(`   ${MEDALS[i]} ${escapeHtml(cut(r.ten_hang || r.ma_hang))} — ${short(r.doanh_thu)}`));
    }
    if (ss === 'ok' && ds.sales.rows.length) checks.push(['Doanh số mặt hàng', verified(buildSalesMessage({ label: '', period, dataset: ds.sales }))]);
    if (sk === 'ok' && ds.salesKh.rows.length) checks.push(['Doanh số khách hàng', verified(buildSalesMessage({ by: 'customer', label: '', period, dataset: ds.salesKh }))]);
    if (ss === 'ok' && sk === 'ok' && Math.abs(sum(ds.sales.rows, 'doanh_thu') - sum(ds.salesKh.rows, 'doanh_thu')) > 1) {
      alerts.push(`Doanh thu theo mặt hàng (${vnd(sum(ds.sales.rows, 'doanh_thu'))}) khác theo khách hàng (${vnd(sum(ds.salesKh.rows, 'doanh_thu'))})`);
    }
  }

  // ---- 🧾 / 🏭 Công nợ ----
  const debt = (key, d, icon, title, who, side, incLabel, decLabel, name) => {
    const st = state(d);
    if (st !== 'ok') { L.push('', `${icon} <b>${title}</b>: ${st === 'empty' ? 'không có số dư' : `⚠️ ${errText(d)}`}`); return; }
    const own = (r, p) => (side === 'no' ? r[`${p}_no`] - r[`${p}_co`] : r[`${p}_co`] - r[`${p}_no`]);
    const rows = d.rows;
    const close = rows.reduce((s, r) => s + own(r, 'ck'), 0);
    const holders = rows.filter((r) => own(r, 'ck') > 0);
    const inc = sum(rows, side === 'no' ? 'ps_no' : 'ps_co'), dec = sum(rows, side === 'no' ? 'ps_co' : 'ps_no');
    L.push('', `${icon} <b>${title}</b>: ${big(close)}`);
    L.push(`   ${holders.length} ${who} còn dư · hôm nay ${flow(incLabel, inc, decLabel, dec)}`);
    [...holders].sort((x, y) => own(y, 'ck') - own(x, 'ck')).slice(0, 3).forEach((r, i) => L.push(`   ${i + 1}. ${escapeHtml(cut(r.ten_doi_tuong || r.ma_doi_tuong))} — ${short(own(r, 'ck'))}`));
    checks.push([name, verified(buildDebtMessage({ kind: key, label: '', period, dataset: d }))]);
  };
  debt('receivable', ds.ar, '🧾', 'PHẢI THU KHÁCH', 'khách', 'no', 'bán chịu', 'thu nợ', 'Phải thu');
  debt('payable', ds.ap, '🏭', 'PHẢI TRẢ NCC', 'NCC', 'co', 'mua chịu', 'đã trả', 'Phải trả');

  // ---- 📦 Tồn kho ----
  const ks = state(ds.stock);
  if (ks !== 'ok') L.push('', `📦 <b>TỒN KHO</b>: ${ks === 'empty' ? 'không có dữ liệu' : `⚠️ ${errText(ds.stock)}`}`);
  else {
    const map = new Map();
    for (const r of ds.stock.rows) { const it = map.get(r.ma_hang) ?? { sl: 0 }; it.sl += Number(r.sl_cuoi_ky) || 0; map.set(r.ma_hang, it); }
    const items = [...map.values()];
    const negCodes = [...map.entries()].filter(([, x]) => x.sl < 0).map(([k]) => k);
    const neg = negCodes.length;
    L.push('', `📦 <b>TỒN KHO</b>: ${big(sum(ds.stock.rows, 'gt_cuoi_ky'))}`);
    L.push(`   ${items.filter((x) => x.sl > 0).length}/${items.length} mặt hàng còn tồn · hôm nay ${flow('nhập', sum(ds.stock.rows, 'gt_nhap'), 'xuất', sum(ds.stock.rows, 'gt_xuat'))}`);
    if (neg) alerts.push(`${neg} mặt hàng tồn kho âm: ${negCodes.slice(0, 5).join(', ')}${neg > 5 ? '…' : ''}`);
    checks.push(['Tồn kho', verified(buildStockMessage({ label: '', period, dataset: ds.stock }))]);
  }

  // ---- Cần chú ý + đối chiếu ----
  L.push('━━━━━━━━━━━━━━━━━━');
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) alerts.push(`Số liệu lệch khi đối chiếu: ${bad.join(', ')} — mở báo cáo chi tiết để xem`);
  if (alerts.length) { L.push('⚠️ <b>CẦN CHÚ Ý</b>'); alerts.forEach((a) => L.push(`   • ${escapeHtml(a)}`)); }
  else L.push('✅ Không có điểm bất thường.');
  L.push(`🔎 Đối chiếu: ${checks.length - bad.length}/${checks.length} báo cáo khớp số tổng của AMIS`);
  return L.join('\n');
}
