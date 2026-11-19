// Dựng tin Telegram "Báo cáo tồn kho" từ báo cáo Tổng hợp tồn kho của AMIS.
// Mọi con số do chương trình cộng từ file AMIS (không qua AI) và được tự đối chiếu: đầu kỳ + nhập − xuất = cuối kỳ.
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
const FIELDS = ['sl_dau_ky', 'sl_nhap', 'sl_xuat', 'sl_cuoi_ky', 'gt_dau_ky', 'gt_nhap', 'gt_xuat', 'gt_cuoi_ky'];
const qty = (n) => fmtNumber(Math.round(n * 1e4) / 1e4);

/** Gộp các dòng cùng mã hàng (một mặt hàng có thể nằm ở nhiều kho). */
function byItem(rows) {
  const map = new Map();
  for (const r of rows) {
    const it = map.get(r.ma_hang) ?? { ma_hang: r.ma_hang, ten_hang: r.ten_hang, ...Object.fromEntries(FIELDS.map((f) => [f, 0])) };
    for (const f of FIELDS) it[f] += Number(r[f]) || 0;
    map.set(r.ma_hang, it);
  }
  return [...map.values()];
}

export function buildStockMessage({ label, period, targetDb, dataset, updatedAt, groups = [], top = 10 }) {
  const lines = [`📊 <b>Báo cáo tồn kho — ${escapeHtml(label)}</b>`, `🗓 ${period.fromDate === period.toDate ? period.fromDate : `${period.fromDate} – ${period.toDate}`}${targetDb ? ` · 🗄 ${escapeHtml(targetDb)}` : ''}`];
  lines.push(`📦 Nhóm VTHH: ${groups.length ? escapeHtml(groups.join(', ')) : 'tất cả nhóm'}`);
  if (updatedAt) lines.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  lines.push('');

  const missing = FIELDS.filter((f) => dataset.missingFields.includes(f));
  if (missing.length) {
    lines.push(`⚠️ Báo cáo AMIS thiếu cột (${escapeHtml(missing.join(', '))}) nên chưa tính đủ. Có thể MISA đã đổi tên cột — kiểm tra "headers" của nguồn ton_kho_nhom trong config.json.`);
    return lines.join('\n');
  }
  const items = byItem(dataset.rows);
  if (!items.length) { lines.push('Không có mặt hàng nào trong kỳ này.'); return lines.join('\n'); }

  const t = Object.fromEntries(FIELDS.map((f) => [f, items.reduce((s, r) => s + r[f], 0)]));
  lines.push(`<b>Tồn cuối kỳ</b>: ${money(t.gt_cuoi_ky)} · SL ${qty(t.sl_cuoi_ky)}`);
  lines.push(`Tồn đầu kỳ: ${vnd(t.gt_dau_ky)} · SL ${qty(t.sl_dau_ky)}`);
  lines.push(`+ Nhập trong kỳ: ${vnd(t.gt_nhap)} · SL ${qty(t.sl_nhap)}`);
  lines.push(`− Xuất trong kỳ: ${vnd(t.gt_xuat)} · SL ${qty(t.sl_xuat)}`);
  const inStock = items.filter((r) => r.sl_cuoi_ky > 0).length;
  const negative = items.filter((r) => r.sl_cuoi_ky < 0);
  const moved = items.filter((r) => r.sl_nhap || r.sl_xuat).length;
  lines.push(`${items.length} mặt hàng · còn tồn ${inStock} · có phát sinh nhập/xuất ${moved}`);
  if (negative.length) lines.push(`⚠️ <b>${negative.length} mặt hàng tồn âm</b>: ${negative.slice(0, 5).map((r) => `<code>${escapeHtml(r.ma_hang)}</code> (${qty(r.sl_cuoi_ky)})`).join(', ')}${negative.length > 5 ? '…' : ''}`);

  const best = [...items].sort((a, b) => b.gt_cuoi_ky - a.gt_cuoi_ky).slice(0, top);
  lines.push('', `<b>Top ${best.length} mặt hàng theo giá trị tồn cuối kỳ</b>`);
  best.forEach((r, i) => {
    const pct = t.gt_cuoi_ky ? ` (${((r.gt_cuoi_ky / t.gt_cuoi_ky) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%)` : '';
    lines.push(`${i + 1}. <code>${escapeHtml(r.ma_hang)}</code> ${escapeHtml(r.ten_hang ?? '')} — SL ${qty(r.sl_cuoi_ky)} — ${vnd(r.gt_cuoi_ky)}${pct}`);
  });

  // Tự đối chiếu để người đọc biết con số đáng tin
  lines.push('');
  const checks = [];
  const eq = (a, b) => Math.abs(a - b) <= 1;
  if (!eq(t.sl_dau_ky + t.sl_nhap - t.sl_xuat, t.sl_cuoi_ky)) checks.push(`⚠️ Số lượng: đầu kỳ + nhập − xuất = ${qty(t.sl_dau_ky + t.sl_nhap - t.sl_xuat)}, khác cuối kỳ ${qty(t.sl_cuoi_ky)}`);
  if (!eq(t.gt_dau_ky + t.gt_nhap - t.gt_xuat, t.gt_cuoi_ky)) checks.push(`⚠️ Giá trị: đầu kỳ + nhập − xuất = ${vnd(t.gt_dau_ky + t.gt_nhap - t.gt_xuat)}, khác cuối kỳ ${vnd(t.gt_cuoi_ky)}`);
  const badRows = items.filter((r) => !eq(r.sl_dau_ky + r.sl_nhap - r.sl_xuat, r.sl_cuoi_ky));
  if (badRows.length) checks.push(`⚠️ ${badRows.length} mặt hàng có đầu kỳ + nhập − xuất ≠ cuối kỳ: ${badRows.slice(0, 5).map((r) => `<code>${escapeHtml(r.ma_hang)}</code>`).join(', ')}${badRows.length > 5 ? '…' : ''}`);
  const tot = dataset.totals;
  if (tot) {
    const off = ['sl_cuoi_ky', 'gt_cuoi_ky'].filter((f) => f in tot && !eq(tot[f] ?? 0, t[f]));
    if (off.length) checks.push(`⚠️ Tổng các dòng khác dòng "Tổng cộng" của AMIS ở: ${off.join(', ')}`);
  }
  lines.push(checks.length ? checks.join('\n') : '✔ Đã đối chiếu: đầu kỳ + nhập − xuất = cuối kỳ (cả số lượng và giá trị, từng mặt hàng)');
  return lines.join('\n');
}
