// Agent trợ lý: soạn câu trả lời cho câu hỏi hỏi qua Telegram, chỉ dựa trên dữ liệu vừa xuất từ AMIS.
import { z } from 'zod';
import { askStructured } from '../ai.js';
import { tablesText } from './facts.js';

const Answer = z.object({
  tra_loi: z.string().describe('Câu trả lời bằng tiếng Việt, văn bản thuần, ngắn gọn, có số liệu cụ thể.'),
  du_can_cu: z.boolean().describe('false nếu dữ liệu được cung cấp không đủ để trả lời câu hỏi.'),
});

const SYSTEM = `Bạn là trợ lý kế toán kho. Giám đốc hỏi qua Telegram và đọc trên điện thoại, nên câu trả lời cần ngắn, đi thẳng vào số liệu.

Bạn chỉ được dùng dữ liệu trong tin nhắn này: bảng tồn kho xuất từ MISA AMIS (CSV) và kết quả các phép kiểm tra chéo. Không dùng kiến thức bên ngoài để đoán số liệu. Nếu dữ liệu không có thông tin cần thiết, nói rõ là dữ liệu hiện có không trả lời được và đặt du_can_cu = false.

Khi nêu số, ghi kèm mã hàng và tên hàng. Khi cộng nhiều dòng, nói rõ đã cộng những dòng nào (ví dụ theo kho). Số lượng viết theo kiểu Việt Nam (1.234,5). Không dùng markdown hay HTML; xuống dòng và gạch đầu dòng bằng ký tự "•" là đủ. Câu trả lời của bạn sẽ được kế toán trưởng đối chiếu lại với số liệu gốc trước khi gửi.`;

export async function draftAnswer(ai, { question, facts, datasets, feedback }) {
  const user = [
    tablesText(datasets),
    `KẾT QUẢ KIỂM TRA CHÉO (JSON):\n${JSON.stringify(facts)}`,
    feedback?.length ? `Bản nháp trước của bạn bị kế toán trưởng trả lại vì:\n${feedback.map((f) => `- ${f}`).join('\n')}\nHãy sửa đúng các điểm này.` : '',
    `CÂU HỎI: ${question}`,
  ].filter(Boolean).join('\n\n');
  const r = await askStructured(ai, { system: SYSTEM, user, schema: Answer, effort: ai.answerEffort ?? 'medium' });
  return { text: r.tra_loi.trim(), grounded: r.du_can_cu };
}
