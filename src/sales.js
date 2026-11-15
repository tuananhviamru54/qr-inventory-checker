// Dựng tin Telegram "Báo cáo doanh số" từ báo cáo Tổng hợp bán hàng theo mặt hàng của AMIS.
// Mọi con số do chương trình cộng từ file AMIS (không qua AI) và được đối chiếu với dòng "Tổng cộng" của chính AMIS.
import { fmtNumber, escapeHtml } from './util.js';

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

export function buildSalesMessage({ label, period, targetDb, dataset, updatedAt, groups = [], top = 10, by = 'item' }) {
  const cust = by === 'customer';
  const lines = [`${cust ? '👥' : '💰'} <b>Doanh số theo ${cust ? 'khách hàng' : 'mặt hàng'} — ${escapeHtml(label)}</b>`, `🗓 ${period.fromDate === period.toDate ? period.fromDate : `${period.fromDate} – ${period.toDate}`}${targetDb ? ` · 🗄 ${escapeHtml(targetDb)}` : ''}`];
  if (!cust) lines.push(`📦 Nhóm VTHH: ${groups.length ? escapeHtml(groups.join(', ')) : 'tất cả nhóm'}`);
  if (updatedAt) lines.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  lines.push('');

  const missing = ['doanh_so', 'doanh_thu', ...(cust ? [] : ['sl_ban'])].filter((f) => dataset.missingFields.includes(f));
  if (missing.length) {
    lines.push(`⚠️ Báo cáo AMIS thiếu cột (${escapeHtml(missing.join(', '))}) nên chưa tính được doanh số. Có thể MISA đã đổi tên cột — kiểm tra "headers" của nguồn ${cust ? 'doanh_so_kh' : 'doanh_so'} trong config.json.`);
    return lines.join('\n');
  }
  const rows = dataset.rows;
  if (!rows.length) { lines.push('Không có doanh số bán hàng trong kỳ này.'); return lines.join('\n'); }

  const t = Object.fromEntries(['sl_ban', 'doanh_so', 'chiet_khau', 'gia_tri_tra', 'giam_gia', 'doanh_thu', 'tien_von', 'lai_gop'].map((f) => [f, sum(rows, f)]));
  lines.push(`<b>Doanh số bán</b>: ${money(t.doanh_so)}`);
  if (t.chiet_khau) lines.push(`− Chiết khấu: ${vnd(t.chiet_khau)}`);
  if (t.gia_tri_tra) lines.push(`− Hàng trả lại: ${vnd(t.gia_tri_tra)}`);
  if (t.giam_gia) lines.push(`− Giảm giá: ${vnd(t.giam_gia)}`);
  lines.push(`<b>Doanh thu thuần</b>: ${money(t.doanh_thu)}`);
  if (!dataset.missingFields.includes('tien_von') && !dataset.missingFields.includes('lai_gop') && t.doanh_thu) {
    lines.push(`Tiền vốn: ${vnd(t.tien_von)} · Lãi gộp: ${vnd(t.lai_gop)} (${((t.lai_gop / t.doanh_thu) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%)`);
  }
  lines.push(cust ? `${rows.length} khách hàng có phát sinh` : `Số lượng bán: ${fmtNumber(Math.round(t.sl_ban * 1e4) / 1e4)} · ${rows.length} mặt hàng có phát sinh`);

  // theo khách hàng: liệt kê đủ mọi khách có phát sinh; theo mặt hàng: top
  const sorted = [...rows].sort((a, b) => b.doanh_thu - a.doanh_thu);
  const best = cust ? sorted : sorted.slice(0, top);
  lines.push('', cust ? `<b>${best.length} khách hàng theo doanh thu thuần</b>` : `<b>Top ${best.length} mặt hàng theo doanh thu thuần</b>`);
  best.forEach((r, i) => {
    const pct = t.doanh_thu ? ` (${((r.doanh_thu / t.doanh_thu) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%)` : '';
    lines.push(cust
      ? `${i + 1}. <code>${escapeHtml(r.ma_kh)}</code> ${escapeHtml((r.ten_kh ?? '').trim())} — ${vnd(r.doanh_thu)}${pct}${r.lai_gop != null && r.doanh_thu ? ` · lãi gộp ${vnd(r.lai_gop)}` : ''}`
      : `${i + 1}. <code>${escapeHtml(r.ma_hang)}</code> ${escapeHtml(r.ten_hang ?? '')} — SL ${fmtNumber(r.sl_ban)} — ${vnd(r.doanh_thu)}${pct}`);
  });

  // Tự đối chiếu để người đọc biết con số đáng tin
  lines.push('');
  const expected = t.doanh_so - t.chiet_khau - t.gia_tri_tra - t.giam_gia;
  const checks = [];
  if (Math.abs(expected - t.doanh_thu) > 1) checks.push(`⚠️ Doanh số − chiết khấu − trả lại − giảm giá = ${vnd(expected)}, khác doanh thu thuần ${vnd(t.doanh_thu)} (lệch ${vnd(t.doanh_thu - expected)})`);
  const tot = dataset.totals;
  if (tot) {
    const off = ['doanh_so', 'doanh_thu'].filter((f) => Math.abs((tot[f] ?? 0) - t[f]) > 1);
    if (off.length) checks.push(`⚠️ Tổng các dòng khác dòng "Tổng cộng" của AMIS ở: ${off.join(', ')}`);
  }
  lines.push(checks.length ? checks.join('\n') : '✔ Đã đối chiếu: tổng các dòng khớp dòng "Tổng cộng" của AMIS và doanh thu thuần = doanh số − chiết khấu − trả lại − giảm giá');
  return lines.join('\n');
}
