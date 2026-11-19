// Agent "Chuyên gia phân tích": đối chiếu độc lập, phân tích nguyên nhân và chốt kết luận trước khi gửi Telegram.
// Chỉ đọc số liệu được cung cấp; không tự tính lại số trong báo cáo (số luôn do code tính) và không sửa dữ liệu.
import { z } from 'zod';
import { aiEnabled, askStructured, describeAiError } from '../ai.js';
import { tablesText } from './facts.js';
import { escapeHtml } from '../util.js';

const PERSONA = `Bạn là chuyên gia phân tích kế toán kho với hơn 15 năm kinh nghiệm, am hiểu chế độ kế toán Việt Nam (Thông tư 133/200), hàng tồn kho, giá vốn, kiểm kê và đối chiếu sổ. Người đọc là giám đốc, đọc trên điện thoại: viết ngắn, đi thẳng vào điều cần biết, tiếng Việt thuần văn bản (không markdown).

Nguyên tắc bắt buộc:
- Chỉ dùng con số, mã hàng, tên hàng có trong dữ liệu được cung cấp. Tuyệt đối không bịa số liệu.
- Nguyên nhân chỉ là GIẢ THUYẾT: bắt đầu bằng "Có thể" và chỉ nêu khi có căn cứ từ chính số liệu (ví dụ tồn cuối kỳ âm trong khi trong kỳ có xuất). Không có căn cứ thì để trống, không đoán.
- Phép kiểm tra bị "bỏ qua" hoặc nguồn dữ liệu lỗi nghĩa là CHƯA có kết luận cho phần đó; không được trình bày như đã khớp.`;

const REPORT_SYSTEM = `${PERSONA}

Việc của bạn với báo cáo đối chiếu:
1. ĐỐI CHIẾU ĐỘC LẬP: đối chiếu các kết luận của chương trình (khớp / có vấn đề / bỏ qua) với các dòng dữ liệu liên quan. Nếu thấy chương trình báo khớp mà dữ liệu cho thấy lệch (hoặc ngược lại) thì ghi vào phat_hien với ma = "HỆ THỐNG".
2. PHÂN TÍCH: gom các vấn đề cùng loại, xếp theo mức ưu tiên (ảnh hưởng số liệu sổ sách lớn trước), nêu giả thuyết nguyên nhân có căn cứ và việc cần làm cụ thể.
3. CHỐT: ket_luan là 1–2 câu cho biết tình hình có ổn không và điều quan trọng nhất cần xử lý.

muc_do: "on" chỉ khi mọi phép kiểm tra đều khớp và không phép nào bị bỏ qua; "can_chu_y" khi có vài vấn đề nhỏ hoặc có phép kiểm tra bị bỏ qua; "nghiem_trong" khi nhiều mã lệch hoặc chênh lệch lớn so với tổng tồn. Nếu không có vấn đề nào, phat_hien để trống.`;

const ANSWER_SYSTEM = `${PERSONA}

Việc của bạn với câu hỏi của giám đốc: nhận BẢN NHÁP của trợ lý, đối chiếu độc lập với bảng dữ liệu rồi CHỐT câu trả lời cuối cùng.
- Nếu bản nháp đúng và đủ: giữ nguyên ý, chỉnh cho gọn.
- Nếu bản nháp sai số, thiếu mã, cộng nhầm hoặc không đúng trọng tâm câu hỏi: sửa lại theo bảng dữ liệu và đặt da_sua = true.
- phan_tich: tối đa 3 câu phân tích của chuyên gia (ý nghĩa của số liệu, giả thuyết có căn cứ, việc nên làm) khi thực sự giúp ích; để trống nếu không cần.
- Nếu dữ liệu không đủ để trả lời, nói rõ là chưa đủ dữ liệu, không đoán.`;

const Analysis = z.object({
  ket_luan: z.string(),
  muc_do: z.enum(['on', 'can_chu_y', 'nghiem_trong']),
  phat_hien: z.array(z.object({
    ma: z.string(),
    ten: z.string(),
    van_de: z.string().describe('Dữ liệu cho thấy gì, kèm con số cụ thể.'),
    nguyen_nhan_co_the: z.string().describe('Giả thuyết có căn cứ, bắt đầu bằng "Có thể"; để trống nếu không có căn cứ.'),
    viec_can_lam: z.string(),
  })).describe('Xếp theo mức ưu tiên giảm dần, tối đa 6.'),
});

const Final = z.object({
  tra_loi: z.string(),
  phan_tich: z.string(),
  da_sua: z.boolean(),
});

const LEVEL = { on: '🟢 Ổn', can_chu_y: '🟡 Cần chú ý', nghiem_trong: '🔴 Nghiêm trọng' };
const strip = (h) => h.replace(/<[^>]+>/g, '');

function feedbackText(what, feedback) {
  return feedback?.length
    ? `${what} trước của bạn bị kế toán trưởng trả lại vì:\n${feedback.map((f) => `- ${f}`).join('\n')}\nHãy sửa đúng các điểm này.`
    : '';
}

/** Phân tích báo cáo đối chiếu. @returns {{status:'ok'|'tat'|'loi', html:string, plain:string, level?:string}} */
export async function analyzeReport(ai, { facts, focus, feedback }) {
  if (!aiEnabled(ai)) return { status: 'tat', html: '', plain: '' };
  const user = [
    `KẾT QUẢ CÁC PHÉP KIỂM TRA DO CHƯƠNG TRÌNH CHẠY (JSON):\n${JSON.stringify(facts)}`,
    `CÁC DÒNG DỮ LIỆU LIÊN QUAN ĐẾN CÁC VẤN ĐỀ (JSON):\n${JSON.stringify(focus)}`,
    feedbackText('Bản phân tích', feedback),
  ].filter(Boolean).join('\n\n');
  try {
    const r = await askStructured(ai, { system: REPORT_SYSTEM, user, schema: Analysis, effort: ai.expertEffort ?? 'high', maxTokens: 6000 });
    const lines = [`🎓 <b>Chuyên gia phân tích</b> — ${LEVEL[r.muc_do]}`, escapeHtml(r.ket_luan)];
    for (const f of r.phat_hien.slice(0, 6)) {
      lines.push(`• <code>${escapeHtml(f.ma)}</code> ${escapeHtml(f.ten)}: ${escapeHtml(f.van_de)}`);
      if (f.nguyen_nhan_co_the?.trim()) lines.push(`   ${escapeHtml(f.nguyen_nhan_co_the)}`);
      if (f.viec_can_lam?.trim()) lines.push(`   → ${escapeHtml(f.viec_can_lam)}`);
    }
    const html = lines.join('\n');
    return { status: 'ok', html, plain: strip(html), level: r.muc_do };
  } catch (e) {
    const html = `⚠️ <b>Chuyên gia phân tích chưa chạy được</b> — ${escapeHtml(describeAiError(e))}`;
    return { status: 'loi', html, plain: strip(html) };
  }
}

/** Chốt câu trả lời cho câu hỏi: kiểm lại bản nháp của trợ lý theo bảng dữ liệu. @returns {{status, text, corrected}} */
export async function finalizeAnswer(ai, { question, draft, facts, datasets, feedback }) {
  if (!aiEnabled(ai)) return { status: 'tat', text: draft, corrected: false };
  const user = [
    `BẢNG DỮ LIỆU:\n${tablesText(datasets)}`,
    `KẾT QUẢ KIỂM TRA CHÉO (JSON):\n${JSON.stringify(facts)}`,
    `CÂU HỎI: ${question}`,
    `BẢN NHÁP CỦA TRỢ LÝ:\n${draft}\n`,
    feedbackText('Bản chốt', feedback),
  ].filter(Boolean).join('\n\n');
  try {
    const r = await askStructured(ai, { system: ANSWER_SYSTEM, user, schema: Final, effort: ai.expertEffort ?? 'high', maxTokens: 6000 });
    const text = [r.tra_loi.trim(), r.phan_tich?.trim() ? `🎓 ${r.phan_tich.trim()}` : ''].filter(Boolean).join('\n\n');
    return { status: 'ok', text, corrected: r.da_sua };
  } catch (e) {
    // chuyên gia lỗi: vẫn giữ bản nháp để kế toán trưởng kiểm tra, không làm mất câu trả lời
    return { status: 'loi', text: draft, corrected: false, note: describeAiError(e) };
  }
}
