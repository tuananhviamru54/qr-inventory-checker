// Trả lời câu hỏi đơn giản bằng tra cứu trực tiếp số liệu AMIS — không dùng AI, nên đúng theo cách tính, không bịa.
// Hỗ trợ: hỏi theo mã hàng; hỏi hàng tồn âm; hỏi tổng tồn.
import { fmtNumber, norm, escapeHtml } from '../util.js';

function stockDataset(datasets) {
  const all = Object.values(datasets).filter((d) => d.rows?.length && 'ma_hang' in d.rows[0]);
  return all.find((d) => d.id === 'ton_kho') ?? all[0] ?? null;
}

const LABELS = [['sl_dau_ky', 'đầu kỳ'], ['sl_nhap', 'nhập'], ['sl_xuat', 'xuất'], ['sl_cuoi_ky', 'cuối kỳ']];

function describe(r) {
  const parts = LABELS.filter(([f]) => f in r).map(([f, label]) => `${label} ${fmtNumber(r[f])}`);
  const where = r.ten_kho ? ` (${escapeHtml(r.ten_kho)})` : '';
  return `• <code>${escapeHtml(r.ma_hang)}</code> ${escapeHtml(r.ten_hang ?? '')}${where}: ${parts.join(' · ')}`;
}

/** @returns {string|null} HTML trả lời, hoặc null nếu câu hỏi nằm ngoài các dạng hỗ trợ */
export function answerByRules(question, datasets) {
  const ds = stockDataset(datasets);
  if (!ds) return null;
  const n = ` ${norm(question)} `;
  const out = [];

  // 1. Hỏi theo mã hàng
  const tokens = question.split(/[\s,;:?!()"']+/).filter(Boolean).map((t) => t.toUpperCase());
  const byCode = new Map();
  for (const r of ds.rows) byCode.set(String(r.ma_hang).toUpperCase(), [...(byCode.get(String(r.ma_hang).toUpperCase()) ?? []), r]);
  const codes = [...new Set(tokens.filter((t) => byCode.has(t)))].slice(0, 10);
  for (const c of codes) out.push(...byCode.get(c).map(describe));

  // 2. Hàng tồn âm
  if (/ am kho | ton am | hang am | am ton | so am /.test(n) || (n.includes(' am ') && n.includes(' ton '))) {
    const neg = ds.rows.filter((r) => r.sl_cuoi_ky < 0);
    out.push(neg.length ? `Có <b>${neg.length}</b> dòng tồn cuối kỳ âm:` : 'Không có dòng nào tồn cuối kỳ âm.');
    out.push(...neg.slice(0, 15).map(describe));
    if (neg.length > 15) out.push(`… và ${neg.length - 15} dòng khác.`);
  }

  // 3. Tổng tồn
  if (/ tong ton | tong so luong | tong hang ton /.test(n)) {
    const total = ds.rows.reduce((s, r) => s + (Number(r.sl_cuoi_ky) || 0), 0);
    out.push(`Tổng số lượng tồn cuối kỳ: <b>${fmtNumber(Math.round(total * 1e4) / 1e4)}</b> (${ds.rows.length} dòng ${escapeHtml(ds.name)}).`);
  }

  return out.length ? out.join('\n') : null;
}

export const RULE_HELP = `Khi tắt AI, bot trả lời được các dạng câu hỏi sau (tra cứu trực tiếp từ số liệu AMIS):
• Theo mã hàng, ví dụ: <i>"A12_2 còn bao nhiêu?"</i> hoặc nhiều mã cùng lúc
• Hàng tồn âm, ví dụ: <i>"Những mã nào đang âm kho?"</i>
• Tổng tồn, ví dụ: <i>"Tổng tồn kho là bao nhiêu?"</i>
Hoặc dùng /baocao để xem báo cáo đối chiếu đầy đủ. Câu hỏi tự do cần bật AI (ANTHROPIC_API_KEY).`;
