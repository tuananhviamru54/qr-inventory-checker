// Dựng tin Telegram "Kết quả hoạt động kinh doanh" (B02-DNN của AMIS): kỳ này so với kỳ trước.
// Mọi con số lấy từ file AMIS (không qua AI) và được tự đối chiếu theo đúng công thức của mẫu B02.
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
/** "▲ +35,5%" / "▼ −12%" / "=" / "mới phát sinh" */
function change(cur, prev) {
  if (Math.round(cur) === Math.round(prev)) return '＝ không đổi';
  if (!prev) return cur ? '🆕 kỳ trước = 0' : '';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return `${p >= 0 ? '▲ +' : '▼ −'}${pct1(Math.abs(p))}`;
}

// Các dòng của mẫu B02-DNN (theo mã số) và công thức tự kiểm
const ITEMS = [
  ['01', '📈', 'Doanh thu bán hàng'],
  ['02', '➖', 'Giảm trừ doanh thu'],
  ['10', '💰', 'Doanh thu thuần', true],
  ['11', '📦', 'Giá vốn hàng bán'],
  ['20', '💵', 'Lợi nhuận gộp', true],
  ['21', '➕', 'Doanh thu tài chính'],
  ['22', '➖', 'Chi phí tài chính'],
  ['24', '🏢', 'Chi phí quản lý kinh doanh'],
  ['30', '⚙️', 'Lợi nhuận thuần từ HĐKD', true],
  ['40', '🔸', 'Lợi nhuận khác'],
  ['50', '🧮', 'Lợi nhuận trước thuế', true],
  ['51', '🏛', 'Thuế TNDN'],
  ['60', '🏆', 'LỢI NHUẬN SAU THUẾ', true],
];
const FORMULAS = [['10', ['01', -1, '02']], ['20', ['10', -1, '11']], ['30', ['20', 1, '21', -1, '22', -1, '24']], ['40', ['31', -1, '32']], ['50', ['30', 1, '40']], ['60', ['50', -1, '51']]];

export function buildIncomeMessage({ label, period, targetDb, dataset, updatedAt }) {
  const L = [`📑 <b>KẾT QUẢ HOẠT ĐỘNG KINH DOANH — ${escapeHtml(label)}</b>`, `🗓 ${period.fromDate === period.toDate ? period.fromDate : `${period.fromDate} – ${period.toDate}`} · mẫu B02-DNN${targetDb ? ` · 🗄 ${escapeHtml(targetDb)}` : ''}`];
  if (updatedAt) L.push(`🕒 Số liệu AMIS lấy lúc ${updatedAt}`);
  L.push('🔒 <i>Chỉ gửi riêng cho chủ bot</i>', '');
  const missing = ['ma_so', 'ky_nay', 'ky_truoc'].filter((f) => dataset.missingFields.includes(f));
  if (missing.length) { L.push(`⚠️ Báo cáo AMIS thiếu cột (${missing.join(', ')}) — kiểm tra "headers" của nguồn kqkd trong config.json.`); return L.join('\n'); }

  const by = new Map(dataset.rows.map((r) => [String(r.ma_so).trim().padStart(2, '0'), r]));
  const v = (code, col) => Number(by.get(code)?.[col]) || 0;
  L.push('<i>Kỳ này · so với kỳ trước</i>', '━━━━━━━━━━━━━━━━━━');
  for (const [code, icon, name, strong] of ITEMS) {
    const cur = v(code, 'ky_nay'), prev = v(code, 'ky_truoc');
    if (!strong && !cur && !prev) continue; // dòng phụ = 0 cả 2 kỳ thì ẩn cho gọn
    const head = strong ? `<b>${name}</b>: <b>${vnd(cur)}</b>` : `${name}: ${vnd(cur)}`;
    L.push(`${icon} ${head}`);
    L.push(`      kỳ trước ${short(prev)} · ${change(cur, prev)}`);
    if (code === '60' || code === '20') L.push('');
  }
  // tỷ suất
  const dt = [v('10', 'ky_nay'), v('10', 'ky_truoc')];
  if (dt[0] || dt[1]) {
    const m = (code, i) => (dt[i] ? pct1((v(code, i ? 'ky_truoc' : 'ky_nay') / dt[i]) * 100) : '—');
    L.push('📊 <b>Tỷ suất trên doanh thu thuần</b> (kỳ này / kỳ trước)');
    L.push(`   Lãi gộp: ${m('20', 0)} / ${m('20', 1)}`);
    L.push(`   Lợi nhuận sau thuế: ${m('60', 0)} / ${m('60', 1)}`);
  }

  // Lưu ý nghiệp vụ + tự đối chiếu công thức B02
  L.push('━━━━━━━━━━━━━━━━━━');
  const notes = [];
  for (const [col, name] of [['ky_nay', 'Kỳ này'], ['ky_truoc', 'Kỳ trước']]) {
    if (v('10', col) > 0 && !v('11', col)) notes.push(`${name}: giá vốn = 0 trong khi có doanh thu → có thể kế toán <b>chưa kết chuyển giá vốn/chi phí cuối kỳ</b>; lợi nhuận đang bị phóng đại.`);
  }
  const bad = [];
  for (const col of ['ky_nay', 'ky_truoc']) {
    for (const [t, f] of FORMULAS) {
      if (!by.has(t)) continue;
      let calc = v(f[0], col);
      for (let i = 1; i < f.length; i += 2) calc += f[i] * v(f[i + 1], col);
      if (Math.abs(calc - v(t, col)) > 1) bad.push(`mã ${t} (${col === 'ky_nay' ? 'kỳ này' : 'kỳ trước'})`);
    }
  }
  notes.forEach((n) => L.push(`⚠️ ${n}`));
  L.push(bad.length ? `⚠️ Lệch công thức B02 ở: ${bad.join(', ')}` : '✔ Đã đối chiếu: các dòng tổng (10, 20, 30, 40, 50, 60) khớp công thức mẫu B02');
  return L.join('\n');
}
