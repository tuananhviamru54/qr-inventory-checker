// Đọc "Sổ chi tiết các tài khoản" (GLAccountLedger) của AMIS và lấy chứng từ của 1 tài khoản (vd 632, 642).
// Dạng 1: dòng "Tài khoản: 632" → các dòng chứng từ → dòng "Cộng". Dạng 2 (sổ nhiều chi nhánh): cột "Tài khoản" trên từng dòng.
import ExcelJS from 'exceljs';
import { escapeHtml, norm } from './util.js';

const cell = (v) => (v && typeof v === 'object' ? (v.result ?? v.richText?.map((x) => x.text).join('') ?? (v instanceof Date ? v : v.text ?? '')) : v);
const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/\./g, '').replace(',', '.')) || 0);
const dmy = (v) => {
  if (v instanceof Date) return `${String(v.getUTCDate()).padStart(2, '0')}/${String(v.getUTCMonth() + 1).padStart(2, '0')}`;
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(v ?? '')); if (m) return `${m[3]}/${m[2]}`;
  return String(v ?? '').slice(0, 5);
};

/** @returns {Map<string, {date,no,desc,contra,debit,credit,partner}[]>} tài khoản → các dòng chứng từ */
export async function readLedger(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  let col = null;
  const out = new Map();
  let acc = null;
  ws.eachRow((row) => {
    const v = row.values.slice(1).map(cell);
    if (!col) {
      const h = v.map((x) => norm(x));
      if (h.includes('so chung tu') && h.some((x) => x === 'phat sinh no')) {
        const i = (name) => h.indexOf(name);
        col = { date: i('ngay hach toan'), no: i('so chung tu'), desc: i('dien giai'), acc: i('tai khoan'), contra: i('tk doi ung'), debit: i('phat sinh no'), credit: i('phat sinh co'), partner: i('ten doi tuong') };
      }
      return;
    }
    const first = String(v[0] ?? '');
    const head = /^Tài khoản:\s*(\S+)/i.exec(first.normalize('NFC'));
    if (head) { acc = head[1]; if (!out.has(acc)) out.set(acc, []); return; }
    // dạng 2 (sổ nhiều chi nhánh): mỗi dòng có cột "Tài khoản" riêng, không có dòng tiêu đề khối
    if (col.acc >= 0 && String(v[col.acc] ?? '').trim()) { acc = String(v[col.acc]).trim(); if (!out.has(acc)) out.set(acc, []); }
    if (!acc) return;
    const no = String(v[col.no] ?? '').trim();
    if (!no) return; // số dư đầu kỳ, dòng Cộng, dòng trống
    out.get(acc).push({ date: v[col.date], no, desc: String(v[col.desc] ?? '').trim(), contra: String(v[col.contra] ?? '').trim(), debit: num(v[col.debit]), credit: num(v[col.credit]), partner: col.partner >= 0 ? String(v[col.partner] ?? '').trim() : '' });
  });
  if (!col) throw new Error('Không nhận ra cột của Sổ chi tiết các tài khoản (cần "Số chứng từ", "Phát sinh Nợ").');
  return out;
}

/** Chứng từ chi phí của tài khoản `account`, gộp theo số chứng từ. Số tiền = Nợ − Có. */
export function expenseVouchers(ledger, account) {
  const by = new Map();
  // Sổ liệt kê cùng 1 chứng từ ở cả TK cấp 1 (642) lẫn TK chi tiết (6421, 6421.9) → chỉ lấy khối cấp cao nhất có mặt để không cộng trùng
  const cands = [...ledger.keys()].filter((a) => a.startsWith(account));
  const top = cands.includes(account) ? [account] : cands.filter((a) => !cands.some((b) => b !== a && a.startsWith(b)));
  for (const [acc, lines] of ledger) {
    if (!top.includes(acc)) continue;
    for (const l of lines) {
      if (/^911/.test(l.contra)) continue; // bút toán kết chuyển cuối kỳ không phải chứng từ chi phí
      const v = by.get(l.no) ?? { no: l.no, date: l.date, desc: l.desc, partner: l.partner, amount: 0, lines: 0 };
      v.amount += l.debit - l.credit;
      v.lines++;
      by.set(l.no, v);
    }
  }
  return [...by.values()].filter((v) => Math.round(v.amount)).sort((a, b) => b.amount - a.amount);
}

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const vnd = (n) => `${nf.format(Math.round(n))} đ`;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildVoucherMessage({ account, name, label, period, vouchers, limit = 30 }) {
  const total = vouchers.reduce((s, v) => s + v.amount, 0);
  const L = [`🧾 <b>CHỨNG TỪ — ${escapeHtml(name)} (${account})</b>`, `🗓 ${escapeHtml(label)} · ${period.fromDate} – ${period.toDate}`, '🔒 <i>Chỉ gửi riêng cho chủ bot</i>', ''];
  if (!vouchers.length) { L.push('Không có chứng từ nào trong kỳ.'); return L.join('\n'); }
  L.push(`Tổng: <b>${vnd(total)}</b> · ${vouchers.length} chứng từ${vouchers.length > limit ? ` · hiện ${limit} chứng từ lớn nhất` : ''}`, '━━━━━━━━━━━━━━━━━━');
  vouchers.slice(0, limit).forEach((v, i) => {
    L.push(`${i + 1}. ${dmy(v.date)} <code>${escapeHtml(v.no)}</code> — <b>${vnd(v.amount)}</b>`);
    const extra = [cut(v.desc, 70), v.partner && !v.desc.includes(v.partner) ? cut(v.partner, 40) : ''].filter(Boolean).join(' · ');
    if (extra) L.push(`    ${escapeHtml(extra)}`);
  });
  if (vouchers.length > limit) {
    const rest = vouchers.slice(limit);
    L.push('', `… và ${rest.length} chứng từ khác: ${vnd(rest.reduce((s, v) => s + v.amount, 0))} (xem đủ trong file Excel đính kèm)`);
  }
  return L.join('\n');
}

/** File Excel đầy đủ chứng từ của 1 tài khoản (để chuyển kế toán / lọc thêm). */
export async function writeVoucherWorkbook(file, { account, name, period, vouchers }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`TK ${account}`);
  ws.addRow([`Chứng từ ${name} (${account}) — ${period.fromDate} – ${period.toDate}`]).font = { bold: true };
  ws.addRow([]);
  const h = ws.addRow(['STT', 'Ngày', 'Số chứng từ', 'Diễn giải', 'Đối tượng', 'Số tiền']);
  h.font = { bold: true };
  vouchers.forEach((v, i) => ws.addRow([i + 1, dmy(v.date), v.no, v.desc, v.partner, Math.round(v.amount)]));
  ws.addRow(['', '', '', 'Tổng cộng', '', Math.round(vouchers.reduce((s, v) => s + v.amount, 0))]).font = { bold: true };
  ws.getColumn(6).numFmt = '#,##0';
  [6, 8, 14, 60, 35, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  await wb.xlsx.writeFile(file);
  return file;
}
