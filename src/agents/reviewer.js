// Agent "Kế toán trưởng": chỉ kiểm tra ĐỘ CHÍNH XÁC của nội dung trước khi gửi về Telegram.
// Không nhận xét, không đề xuất. Số liệu trong báo cáo luôn do code tính; agent không được sửa.
import { z } from 'zod';
import { aiEnabled, askStructured, describeAiError } from '../ai.js';
import { escapeHtml } from '../util.js';

const Review = z.object({
  ket_luan: z.enum(['dat', 'khong_dat']),
  sai_sot: z.array(z.string()).describe('Từng điểm trong bản nháp sai so với số liệu gốc, nêu bản nháp ghi gì và số liệu gốc là gì. Để trống nếu không có.'),
});

const SYSTEM = `Bạn là kế toán trưởng kiểm tra độ chính xác của một nội dung sắp gửi cho giám đốc qua Telegram. Bạn KHÔNG nhận xét nghiệp vụ, KHÔNG đề xuất, KHÔNG bình luận; chỉ xác minh số liệu.

Bạn nhận được SỐ LIỆU GỐC (trích trực tiếp từ MISA AMIS và tính bằng chương trình, coi là đúng) và BẢN NHÁP sẽ gửi. Đối chiếu từng con số, mã hàng, tên hàng, đơn vị và kết luận trong bản nháp với số liệu gốc. Ghi vào sai_sot khi:
- một con số, mã hàng hoặc tên hàng không khớp số liệu gốc;
- bản nháp nêu thông tin không có trong số liệu gốc (bịa hoặc suy diễn quá mức);
- phép cộng, trừ, đếm trong bản nháp sai;
- một phép kiểm tra bị "bỏ qua" hoặc lỗi nhưng bản nháp trình bày như đã "khớp";
- với câu hỏi: câu trả lời không đúng trọng tâm câu hỏi.

Bản nháp có thể gồm cả phần "Chuyên gia phân tích". Các câu nêu giả thuyết (bắt đầu bằng "Có thể") và việc cần làm là ý kiến chuyên gia, không coi là sai chỉ vì không có sẵn trong số liệu; chỉ ghi sai_sot khi phần đó chứa con số/mã hàng sai, hoặc khẳng định chắc chắn một điều số liệu gốc không cho phép kết luận, hoặc mâu thuẫn với kết quả các phép kiểm tra.

ket_luan = "dat" nếu mọi điểm đều khớp (sai_sot để trống); "khong_dat" nếu có bất kỳ điểm sai nào. Chỉ dựa vào số liệu được cung cấp. Viết tiếng Việt, mỗi điểm sai một câu ngắn, không dùng markdown.`;

/** @returns {{ status: 'dat'|'khong_dat'|'tat'|'loi', sai_sot?: string[], note?: string }} */
export async function reviewDraft(ai, { draft, facts, question }) {
  // ai.enabled === false là lựa chọn chủ động → không nhắc gì trong tin; thiếu khoá thì báo để người dùng biết
  if (!aiEnabled(ai)) return { status: 'tat', note: ai?.enabled === false ? '' : 'thiếu ANTHROPIC_API_KEY' };
  const user = [
    question ? `CÂU HỎI CỦA GIÁM ĐỐC:\n${question}\n` : '',
    `SỐ LIỆU GỐC (JSON):\n${JSON.stringify(facts)}\n`,
    `BẢN NHÁP SẼ GỬI:\n${draft}`,
  ].join('\n');
  try {
    const r = await askStructured(ai, { system: SYSTEM, user, schema: Review, effort: ai.reviewEffort ?? 'high', maxTokens: 4000 });
    const sai = r.sai_sot.filter(Boolean);
    // kết luận và danh sách lỗi phải nhất quán: có lỗi thì không đạt
    return { status: r.ket_luan === 'dat' && !sai.length ? 'dat' : 'khong_dat', sai_sot: sai };
  } catch (e) {
    return { status: 'loi', note: describeAiError(e) };
  }
}

/** Đoạn HTML ghép vào cuối tin: đạt chỉ có 1 dòng đóng dấu; chỉ khi sai mới nêu chi tiết. */
export function reviewSection(review) {
  if (review.status === 'tat') return review.note ? `<i>Chưa kiểm tra độ chính xác bằng AI (${escapeHtml(review.note)}).</i>` : '';
  if (review.status === 'loi') return `⚠️ <b>Chưa kiểm tra được độ chính xác</b> — ${escapeHtml(review.note)}`;
  if (review.status === 'dat') return '✔ Đã kiểm tra chéo độ chính xác với số liệu gốc';
  const lines = ['⛔ <b>Kế toán trưởng: KHÔNG ĐẠT</b> — nội dung trên có điểm chưa chính xác:'];
  for (const s of review.sai_sot ?? []) lines.push(`   • ${escapeHtml(s)}`);
  return lines.join('\n');
}
