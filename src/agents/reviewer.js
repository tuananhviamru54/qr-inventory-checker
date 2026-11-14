// Agent "Kế toán trưởng": kiểm soát nội dung trước khi gửi về Telegram.
// Agent chỉ được nhận xét và bắt lỗi; số liệu trong báo cáo luôn do code tính, agent không được sửa.
import { z } from 'zod';
import { aiEnabled, askStructured, describeAiError } from '../ai.js';
import { escapeHtml } from '../util.js';

const Review = z.object({
  ket_luan: z.enum(['dat', 'dat_co_luu_y', 'khong_dat']),
  sai_sot: z.array(z.string()).describe('Điểm trong bản nháp mâu thuẫn hoặc sai so với số liệu gốc. Để trống nếu không có.'),
  nhan_xet: z.array(z.string()).describe('Nhận xét nghiệp vụ ngắn gọn của kế toán trưởng, tối đa 4 ý.'),
  de_xuat: z.array(z.string()).describe('Việc cần làm tiếp, tối đa 3 ý.'),
});

const SYSTEM = `Bạn là kế toán trưởng của một doanh nghiệp Việt Nam, nhiều năm kinh nghiệm kiểm soát sổ sách kho và công nợ theo chế độ kế toán Việt Nam. Trợ lý sắp gửi cho giám đốc một nội dung qua Telegram; bạn là người kiểm soát cuối cùng trước khi gửi.

Bạn nhận được hai thứ: SỐ LIỆU GỐC (trích trực tiếp từ MISA AMIS và tính bằng chương trình, coi là đúng) và BẢN NHÁP sẽ gửi.

Việc của bạn:
- Đối chiếu từng con số, mã hàng, kết luận trong bản nháp với số liệu gốc. Mọi chỗ lệch, bịa, suy diễn quá số liệu, hoặc trả lời không đúng câu hỏi đều ghi vào sai_sot, nêu rõ bản nháp ghi gì và số liệu gốc là gì.
- Nêu nhận xét nghiệp vụ mà một kế toán trưởng sẽ lưu ý: ví dụ tồn kho âm thường do xuất trước nhập hoặc hạch toán thiếu phiếu nhập; phép kiểm tra bị bỏ qua nghĩa là chưa có kết luận chứ không phải "khớp".
- Đề xuất việc cần làm tiếp nếu có.

Kết luận:
- "dat": bản nháp đúng với số liệu gốc, gửi được.
- "dat_co_luu_y": đúng số liệu nhưng người đọc cần biết thêm lưu ý của bạn.
- "khong_dat": có sai sót về số liệu hoặc kết luận.

Chỉ dựa vào số liệu được cung cấp; không tự đưa ra con số không có trong đó. Viết tiếng Việt, mỗi ý một câu ngắn, không dùng markdown.`;

/**
 * @returns {{ status: 'dat'|'dat_co_luu_y'|'khong_dat'|'tat'|'loi', sai_sot, nhan_xet, de_xuat, note }}
 */
export async function reviewDraft(ai, { draft, facts, question }) {
  if (!aiEnabled(ai)) return { status: 'tat', note: 'chưa bật (thiếu ANTHROPIC_API_KEY)' };
  const user = [
    question ? `CÂU HỎI CỦA GIÁM ĐỐC:\n${question}\n` : '',
    `SỐ LIỆU GỐC (JSON):\n${JSON.stringify(facts)}\n`,
    `BẢN NHÁP SẼ GỬI:\n${draft}`,
  ].join('\n');
  try {
    const r = await askStructured(ai, { system: SYSTEM, user, schema: Review, effort: ai.reviewEffort ?? 'high' });
    return { status: r.ket_luan, sai_sot: r.sai_sot, nhan_xet: r.nhan_xet.slice(0, 4), de_xuat: r.de_xuat.slice(0, 3) };
  } catch (e) {
    return { status: 'loi', note: describeAiError(e) };
  }
}

const HEAD = {
  dat: '✅ Đạt',
  dat_co_luu_y: '⚠️ Đạt, có lưu ý',
  khong_dat: '⛔ KHÔNG ĐẠT — nội dung trên có điểm chưa đúng',
};

/** Đoạn HTML "Kế toán trưởng kiểm soát" để ghép vào cuối tin Telegram. */
export function reviewSection(review) {
  if (review.status === 'tat') return `👩‍💼 <b>Kế toán trưởng (AI)</b>: ${escapeHtml(review.note)}`;
  if (review.status === 'loi') return `👩‍💼 <b>Kế toán trưởng (AI)</b>: ⚠️ CHƯA KIỂM SOÁT được nội dung này — ${escapeHtml(review.note)}`;
  const lines = [`👩‍💼 <b>Kế toán trưởng (AI) kiểm soát</b>: ${HEAD[review.status]}`];
  for (const s of review.sai_sot ?? []) lines.push(`   ⛔ ${escapeHtml(s)}`);
  for (const s of review.nhan_xet ?? []) lines.push(`   • ${escapeHtml(s)}`);
  for (const s of review.de_xuat ?? []) lines.push(`   → ${escapeHtml(s)}`);
  return lines.join('\n');
}
