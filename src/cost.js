// Dựng tin Telegram "Chi phí" từ Bảng cân đối tài khoản (F01-DNN) của AMIS: kỳ này so với kỳ trước.
// Lấy phát sinh thật trên các tài khoản chi phí (632, 635, 641, 642, 811, 821) nên vẫn đúng khi kế toán chưa kết chuyển cuối kỳ.
import { escapeHtml } from './util.js';

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const vnd = (n) => `${nf.format(Math.round(n))} đ`;
function short(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  if (a >= 1e6) return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr`;
  return vnd(n);
}
const pct1 = (x) => `${x.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
function change(cur, prev) {
  if (Math.round(cur) === Math.round(prev)) return '＝ không đổi';
  if (!prev) return cur ? '🆕 kỳ trước = 0' : '';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return `${p >= 0 ? '▲ +' : '▼ −'}${pct1(Math.abs(p))}`;
}

export const COST_ACCOUNTS = [
  ['632', '📦', 'Giá vốn hàng bán'],
  ['641', '🚚', 'Chi phí bán hàng'],
  ['642', '🏢', 'Chi phí quản lý kinh doanh'],
  ['635', '🏦', 'Chi phí tài chính (lãi vay...)'],
  ['811', '🔸', 'Chi phí khác'],
  ['821', '🏛', 'Thuế TNDN'],
];

/** Số liệu chi phí / doanh thu của 1 kỳ từ bảng cân đối tài khoản. */
export function summarizeCost(dataset) {
  const acc = new Map();
  for (const r of dataset.rows) {
    const k = String(r.so_tk).trim();
    if (!/^\d{3}$/.test(k)) continue; // chỉ tài khoản cấp 1
    acc.set(k, { no: Number(r.ps_no) || 0, co: Number(r.ps_co) || 0, name: r.ten_tk });
  }
  const g = (k) => acc.get(k) ?? { no: 0, co: 0 };
  const closed = g('911').no > 0 || g('911').co > 0; // đã kết chuyển: bút toán sang 911 nằm bên Có của TK chi phí
  const expense = (k) => (closed ? g(k).no : g(k).no - g(k).co);
  const items = Object.fromEntries(COST_ACCOUNTS.map(([k]) => [k, expense(k)]));
  // đã kết chuyển: bên Nợ 511 lẫn cả bút toán sang 911 → chỉ lấy được doanh thu trước giảm trừ (bên Có)
  const revenue = closed ? g('511').co : g('511').co - g('511').no;
  const otherIncome = (closed ? g('515').co : g('515').co - g('515').no) + (closed ? g('711').co : g('711').co - g('711').no);
  const total = Object.entries(items).filter(([k]) => k !== '821').reduce((s, [, v]) => s + v, 0);
  return { items, revenue, otherIncome, total, closed, hasData: acc.size > 0 };
}

export function buildCostMessage({ label, period, prevPeriod, targetDb, cur, prev, updatedAt }) {
  const L = [`💸 <b>CHI PHÍ — ${escapeHtml(label)}</b>`, `🗓 ${period.fromDate} – ${period.toDate}${prevPeriod ? ` · so với ${prevPeriod.fromDate} – ${prevPeriod.toDate}` : ''}`];
  if (targetDb) L.push(`🗄 ${escapeHtml(targetDb)} · nguồn: Bảng cân đối tài khoản (F01)`);
  if (updatedAt) L.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  L.push('🔒 <i>Chỉ gửi riêng cho chủ bot</i>', '');
  if (!cur?.hasData) { L.push('Không có số liệu tài khoản trong kỳ này.'); return L.join('\n'); }
  const p = prev?.hasData ? prev : null;

  L.push(`💸 <b>TỔNG CHI PHÍ</b>: <b>${vnd(cur.total)}</b>`);
  if (p) L.push(`      kỳ trước ${short(p.total)} · ${change(cur.total, p.total)}`);
  if (cur.revenue) L.push(`      = ${pct1((cur.total / cur.revenue) * 100)} doanh thu thuần${p?.revenue ? ` (kỳ trước ${pct1((p.total / p.revenue) * 100)})` : ''}`);
  L.push('━━━━━━━━━━━━━━━━━━');
  const opex = ['641', '642', '635', '811'];
  for (const [k, icon, name] of COST_ACCOUNTS) {
    const c = cur.items[k], v = p?.items[k] ?? 0;
    if (!c && !v) continue;
    const share = cur.total && k !== '821' ? ` · ${pct1((c / cur.total) * 100)} tổng` : '';
    L.push(`${icon} ${name} <code>${k}</code>: <b>${vnd(c)}</b>${share}`);
    if (p) L.push(`      kỳ trước ${short(v)} · ${change(c, v)}`);
  }
  const opCur = opex.reduce((s, k) => s + cur.items[k], 0), opPrev = p ? opex.reduce((s, k) => s + p.items[k], 0) : 0;
  L.push('', `🧾 <b>Chi phí hoạt động</b> (ngoài giá vốn): <b>${vnd(opCur)}</b>${cur.revenue ? ` · ${pct1((opCur / cur.revenue) * 100)} doanh thu` : ''}`);
  if (p) L.push(`      kỳ trước ${short(opPrev)} · ${change(opCur, opPrev)}`);

  // lợi nhuận ước tính từ phát sinh thật (không phụ thuộc kết chuyển)
  const profit = (x) => x.revenue + x.otherIncome - x.total - x.items['821'];
  L.push('━━━━━━━━━━━━━━━━━━');
  L.push(`💰 Doanh thu thuần: ${vnd(cur.revenue)}${p ? ` · kỳ trước ${short(p.revenue)}` : ''}`);
  if (cur.otherIncome || p?.otherIncome) L.push(`➕ Thu nhập tài chính & khác: ${vnd(cur.otherIncome)}`);
  L.push(`🏆 <b>Lợi nhuận ước tính</b>: <b>${vnd(profit(cur))}</b>${cur.revenue ? ` (${pct1((profit(cur) / cur.revenue) * 100)})` : ''}`);
  if (p) L.push(`      kỳ trước ${short(profit(p))} · ${change(profit(cur), profit(p))}`);
  L.push('<i>= doanh thu thuần + thu nhập khác − chi phí − thuế, tính từ phát sinh thật trên sổ</i>');
  if (!cur.closed) L.push('', 'ℹ️ Kỳ này kế toán <b>chưa kết chuyển</b> chi phí sang TK 911 nên báo cáo B02 trên AMIS chưa phản ánh chi phí; số ở đây lấy trực tiếp từ phát sinh tài khoản nên vẫn đầy đủ.');
  return L.join('\n');
}

/** Kỳ liền trước cùng độ dài; nếu kỳ là các tháng trọn vẹn thì lùi đúng số tháng đó. */
export function previousRange(fromDate, toDate) {
  const parse = (s) => { const [d, m, y] = s.split('/').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const fmt = (dt) => `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
  const f = parse(fromDate), t = parse(toDate);
  const endOfMonth = (dt) => new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate() === dt.getUTCDate();
  if (f.getUTCDate() === 1 && endOfMonth(t)) {
    const months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth() + 1;
    return { fromDate: fmt(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - months, 1))), toDate: fmt(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0))) };
  }
  const days = Math.round((t - f) / 864e5) + 1;
  return { fromDate: fmt(new Date(f.getTime() - days * 864e5)), toDate: fmt(new Date(f.getTime() - 864e5)) };
}
