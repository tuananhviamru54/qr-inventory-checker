// Dựng tin Telegram "Công nợ khách hàng (phải thu, TK 131)" và "Công nợ nhà cung cấp (phải trả, TK 331)".
// Mọi con số do chương trình cộng từ file AMIS (không qua AI) và được đối chiếu với dòng "Tổng cộng" của chính AMIS.
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
const FIELDS = ['dk_no', 'dk_co', 'ps_no', 'ps_co', 'ck_no', 'ck_co'];
const sum = (rows, f) => rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);

export const DEBT_KINDS = {
  receivable: { icon: '🧾', title: 'Công nợ khách hàng (phải thu)', who: 'khách hàng', account: '131', side: 'no', inc: 'ps_no', dec: 'ps_co', incLabel: 'Bán chịu / tăng nợ phải thu', decLabel: 'Khách đã trả / giảm nợ', openSide: 'Nợ', otherSide: 'Có', otherNote: 'khách trả trước hoặc trả dư' },
  payable: { icon: '🏭', title: 'Công nợ nhà cung cấp (phải trả)', who: 'nhà cung cấp', account: '331', side: 'co', inc: 'ps_co', dec: 'ps_no', incLabel: 'Mua chịu / tăng nợ phải trả', decLabel: 'Đã trả / giảm nợ', openSide: 'Có', otherSide: 'Nợ', otherNote: 'đã trả trước hoặc trả dư' },
};

/** Số dư theo chiều của loại công nợ: phải thu = Nợ − Có; phải trả = Có − Nợ. */
const bal = (kind, r, pos) => (kind.side === 'no' ? (r[`${pos}_no`] - r[`${pos}_co`]) : (r[`${pos}_co`] - r[`${pos}_no`]));

export function buildDebtMessage({ kind: kindKey, label, period, targetDb, dataset, updatedAt, minBalance = 100000 }) {
  const kind = DEBT_KINDS[kindKey];
  const lines = [`${kind.icon} <b>${kind.title} — ${escapeHtml(label)}</b>`, `🗓 ${period.fromDate === period.toDate ? period.fromDate : `${period.fromDate} – ${period.toDate}`} · TK ${kind.account}${targetDb ? ` · 🗄 ${escapeHtml(targetDb)}` : ''}`];
  if (updatedAt) lines.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  lines.push('');

  const missing = FIELDS.filter((f) => dataset.missingFields.includes(f));
  if (missing.length) {
    lines.push(`⚠️ Báo cáo AMIS thiếu cột (${escapeHtml(missing.join(', '))}) nên chưa tính được. Có thể MISA đã đổi tên cột — kiểm tra "headers" của nguồn trong config.json.`);
    return lines.join('\n');
  }
  const rows = dataset.rows;
  if (!rows.length) { lines.push(`Không có ${kind.who} nào có số dư hoặc phát sinh trong kỳ này.`); return lines.join('\n'); }

  const t = Object.fromEntries(FIELDS.map((f) => [f, sum(rows, f)]));
  const open = bal(kind, t, 'dk'), close = bal(kind, t, 'ck');
  lines.push(`<b>Dư cuối kỳ</b>: ${money(close)}`);
  lines.push(`Dư đầu kỳ: ${vnd(open)}`);
  lines.push(`+ ${kind.incLabel}: ${vnd(t[kind.inc])}`);
  lines.push(`− ${kind.decLabel}: ${vnd(t[kind.dec])}`);

  const own = (r) => bal(kind, r, 'ck');
  const holders = rows.filter((r) => own(r) > 0);
  const others = rows.filter((r) => own(r) < 0);
  lines.push(`${rows.length} ${kind.who} có số dư/phát sinh · còn dư ${kind.openSide}: ${holders.length}${others.length ? ` · dư bên ${kind.otherSide} (${kind.otherNote}): ${others.length} (${vnd(-others.reduce((s, r) => s + own(r), 0))})` : ''}`);

  const total = holders.reduce((s, r) => s + own(r), 0);
  const best = holders.filter((r) => own(r) >= minBalance).sort((a, b) => own(b) - own(a));
  if (best.length) {
    const subtotal = best.reduce((s, r) => s + own(r), 0);
    lines.push('', `<b>${best.length} ${kind.who} có dư cuối kỳ từ ${vnd(minBalance)} trở lên</b> (cộng ${vnd(subtotal)})`);
    best.forEach((r, i) => {
      const pct = total ? ` (${((own(r) / total) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%)` : '';
      lines.push(`${i + 1}. <code>${escapeHtml(r.ma_doi_tuong)}</code> ${escapeHtml(r.ten_doi_tuong ?? '')} — ${vnd(own(r))}${pct}`);
    });
    const small = holders.length - best.length;
    if (small) lines.push(`(Còn ${small} ${kind.who} dư dưới ${vnd(minBalance)}: ${vnd(total - subtotal)})`);
  } else lines.push('', `Không có ${kind.who} nào dư cuối kỳ từ ${vnd(minBalance)} trở lên.`);

  // Tự đối chiếu để người đọc biết con số đáng tin
  lines.push('');
  const checks = [];
  const bad = rows.filter((r) => Math.abs(bal(kind, r, 'dk') + (kind.side === 'no' ? r.ps_no - r.ps_co : r.ps_co - r.ps_no) - own(r)) > 1);
  if (bad.length) checks.push(`⚠️ ${bad.length} ${kind.who} có đầu kỳ + phát sinh ≠ cuối kỳ: ${bad.slice(0, 5).map((r) => `<code>${escapeHtml(r.ma_doi_tuong)}</code>`).join(', ')}${bad.length > 5 ? '…' : ''}`);
  const tot = dataset.totals;
  if (tot) {
    const off = FIELDS.filter((f) => f in tot && Math.abs((tot[f] ?? 0) - t[f]) > 1);
    if (off.length) checks.push(`⚠️ Tổng các dòng khác dòng "Tổng cộng" của AMIS ở: ${off.join(', ')}`);
  }
  lines.push(checks.length ? checks.join('\n') : `✔ Đã đối chiếu: tổng các dòng khớp dòng "Tổng cộng" của AMIS và đầu kỳ + phát sinh = cuối kỳ (từng ${kind.who})`);
  return lines.join('\n');
}
