// Dựng tin Telegram "Quỹ tiền": tiền mặt (Sổ kế toán chi tiết quỹ tiền mặt, TK 111) + tiền gửi (Bảng kê số dư ngân hàng, TK 112).
// Mọi con số do chương trình cộng từ file AMIS (không qua AI) và được tự đối chiếu.
import { escapeHtml } from './util.js';

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const vnd = (n) => `${nf.format(Math.round(n))} đ`;
function short(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `≈ ${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  if (a >= 1e6) return `≈ ${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} triệu`;
  return '';
}
const money = (n) => (short(n) ? `${vnd(n)} (${short(n)})` : vnd(n));
const sum = (rows, f) => rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
const isOpening = (r) => /^số dư đầu kỳ$/i.test((r.dien_giai ?? '').trim());
const dmy = (s) => { if (/^\d\d\/\d\d/.test(s ?? '')) return s.slice(0, 5); const d = new Date(s ?? ''); return Number.isNaN(d.getTime()) ? '' : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

/** Tóm tắt sổ quỹ tiền mặt: đầu kỳ, thu, chi, cuối kỳ, các lần quỹ âm. */
export function summarizeCash(dataset) {
  // Toàn hệ thống: các dòng đến từ nhiều sổ (_book) → tính đầu kỳ / số tồn cuối riêng từng sổ rồi cộng
  const books = [...new Set(dataset.rows.map((r) => r._book ?? 0))];
  let opening = 0, lastTon = 0;
  for (const b of books) {
    const rows = dataset.rows.filter((r) => (r._book ?? 0) === b);
    const openRow = rows.find(isOpening);
    const txb = rows.filter((r) => !isOpening(r));
    const o = openRow ? openRow.ton : 0;
    opening += o;
    lastTon += txb.length ? txb.at(-1).ton : o;
  }
  const tx = dataset.rows.filter((r) => !isOpening(r));
  const thu = sum(tx, 'no'), chi = sum(tx, 'co');
  const closing = opening + thu - chi;
  const negatives = books.length > 1 ? [] : tx.filter((r) => r.ton < 0); // số tồn từng dòng chỉ có nghĩa trong 1 sổ
  return { opening, thu, chi, closing, lastTon, tx, negatives, lowest: negatives.length ? Math.min(...negatives.map((r) => r.ton)) : null };
}

export function buildCashMessage({ label, period, targetDb, cash, bank, updatedAt, top = 5 }) {
  const lines = [`💵 <b>Quỹ tiền — ${escapeHtml(label)}</b>`, `🗓 ${period.fromDate === period.toDate ? period.fromDate : `${period.fromDate} – ${period.toDate}`}${targetDb ? ` · 🗄 ${escapeHtml(targetDb)}` : ''}`];
  if (updatedAt) lines.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  lines.push('');
  const checks = [];

  // ---- Tiền mặt ----
  let cashClose = null;
  const cashMissing = cash && !cash.error && !cash.noData ? ['no', 'co', 'ton'].filter((f) => cash.missingFields.includes(f)) : [];
  let c = null;
  if (cash && !cash.error && !cash.noData && !cashMissing.length) { c = summarizeCash(cash); cashClose = c.closing; }
  // ---- Ngân hàng ----
  let bankClose = null;
  const bankMissing = bank && !bank.error && !bank.noData ? ['dau_ky', 'cuoi_ky'].filter((f) => bank.missingFields.includes(f)) : [];
  const bankOk = bank && !bank.error && !bank.noData && !bankMissing.length;
  if (bankOk) bankClose = sum(bank.rows, 'cuoi_ky');

  if (cashClose != null && bankClose != null) lines.push(`<b>Tổng tiền cuối kỳ</b>: ${money(cashClose + bankClose)}`, `   Tiền mặt ${vnd(cashClose)} · Ngân hàng ${vnd(bankClose)}`, '');

  lines.push('<b>🪙 Tiền mặt (TK 111)</b>');
  if (cash?.noData) lines.push('Không có phát sinh tiền mặt trong kỳ (AMIS báo không có dữ liệu).');
  else if (!cash || cash.error) lines.push(`⚠️ Chưa lấy được sổ quỹ tiền mặt: ${escapeHtml(cash?.error ?? 'chưa có dữ liệu')}`);
  else if (cashMissing.length) lines.push(`⚠️ Sổ quỹ thiếu cột (${escapeHtml(cashMissing.join(', '))}) — kiểm tra "headers" của nguồn quy_tien_mat trong config.json.`);
  else {
    lines.push(`Tồn đầu kỳ: ${vnd(c.opening)}`, `+ Thu: ${vnd(c.thu)}`, `− Chi: ${vnd(c.chi)}`, `<b>Tồn cuối kỳ</b>: ${money(c.closing)}`);
    if (c.negatives.length) lines.push(`⚠️ Quỹ tiền mặt bị ÂM ở ${c.negatives.length} dòng trong kỳ, thấp nhất ${vnd(c.lowest)} (chi trước khi có thu — cần kiểm tra thứ tự/ngày chứng từ).`);
    if (c.closing < 0) lines.push('⚠️ Tồn quỹ cuối kỳ đang âm.');
    const line = (r, amt) => `• ${dmy(r.ngay)} <code>${escapeHtml(r.so_thu || r.so_chi || '')}</code> ${escapeHtml((r.dien_giai ?? '').trim())} — ${vnd(amt)}`;
    const thuTop = c.tx.filter((r) => r.no > 0).sort((a, b) => b.no - a.no).slice(0, top);
    const chiTop = c.tx.filter((r) => r.co > 0).sort((a, b) => b.co - a.co).slice(0, top);
    if (thuTop.length) { lines.push('', `<b>${thuTop.length} khoản thu tiền mặt lớn nhất</b>`); thuTop.forEach((r) => lines.push(line(r, r.no))); }
    if (chiTop.length) { lines.push('', `<b>${chiTop.length} khoản chi tiền mặt lớn nhất</b>`); chiTop.forEach((r) => lines.push(line(r, r.co))); }
    if (Math.abs(c.closing - c.lastTon) > 1) checks.push(`⚠️ Tiền mặt: đầu kỳ + thu − chi = ${vnd(c.closing)}, khác số tồn dòng cuối của AMIS ${vnd(c.lastTon)}`);
  }

  lines.push('', '<b>🏦 Tiền gửi ngân hàng (TK 112)</b>');
  if (bank?.noData) lines.push('Không có số dư/phát sinh ngân hàng trong kỳ (AMIS báo không có dữ liệu).');
  else if (!bank || bank.error) lines.push(`⚠️ Chưa lấy được bảng kê số dư ngân hàng: ${escapeHtml(bank?.error ?? 'chưa có dữ liệu')}`);
  else if (bankMissing.length) lines.push(`⚠️ Bảng kê thiếu cột (${escapeHtml(bankMissing.join(', '))}) — kiểm tra "headers" của nguồn so_du_ngan_hang trong config.json.`);
  else {
    const t = Object.fromEntries(['dau_ky', 'ps_no', 'ps_co', 'cuoi_ky'].map((f) => [f, sum(bank.rows, f)]));
    lines.push(`Dư đầu kỳ: ${vnd(t.dau_ky)}`, `+ Tiền vào: ${vnd(t.ps_no)}`, `− Tiền ra: ${vnd(t.ps_co)}`, `<b>Dư cuối kỳ</b>: ${money(t.cuoi_ky)}`);
    const accts = [...bank.rows].sort((a, b) => b.cuoi_ky - a.cuoi_ky);
    lines.push('', `<b>${accts.length} tài khoản ngân hàng</b>`);
    accts.forEach((r, i) => lines.push(`${i + 1}. <code>${escapeHtml(r.tk_nh)}</code> ${escapeHtml(r.ten_nh ?? '')} — ${vnd(r.cuoi_ky)}${r.cuoi_ky < 0 ? ' ⚠️ âm' : ''}`));
    const bad = bank.rows.filter((r) => Math.abs(r.dau_ky + r.ps_no - r.ps_co - r.cuoi_ky) > 1);
    if (bad.length) checks.push(`⚠️ Ngân hàng: ${bad.length} tài khoản có đầu kỳ + vào − ra ≠ cuối kỳ`);
    if (bank.totals) {
      const off = ['dau_ky', 'ps_no', 'ps_co', 'cuoi_ky'].filter((f) => f in bank.totals && Math.abs((bank.totals[f] ?? 0) - t[f]) > 1);
      if (off.length) checks.push(`⚠️ Ngân hàng: tổng các dòng khác dòng "Tổng cộng" của AMIS ở: ${off.join(', ')}`);
    }
  }

  lines.push('');
  const allOk = c && bankOk;
  lines.push(checks.length ? checks.join('\n') : allOk ? '✔ Đã đối chiếu: tiền mặt đầu kỳ + thu − chi = số tồn cuối của AMIS; ngân hàng khớp dòng "Tổng cộng" và đầu kỳ + vào − ra = cuối kỳ' : 'ℹ️ Chỉ đối chiếu được phần đã lấy được số liệu.');
  return lines.join('\n');
}
