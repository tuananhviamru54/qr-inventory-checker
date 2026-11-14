// Lớp gọi Claude dùng chung cho các agent (kế toán trưởng, trợ lý trả lời, giám sát).
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export function aiEnabled(ai = {}) {
  if (ai.enabled === false) return false;
  return Boolean(ai.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let cached;
function clientOf(ai) {
  const key = `${ai.apiKey ?? ''}|${ai.baseURL ?? ''}`;
  if (cached?.key !== key) {
    cached = { key, client: new Anthropic({ ...(ai.apiKey ? { apiKey: ai.apiKey } : {}), ...(ai.baseURL ? { baseURL: ai.baseURL } : {}) }) };
  }
  return cached.client;
}

/** Gọi Claude và nhận về JSON đúng theo `schema` (zod). Ném lỗi nếu bị từ chối hoặc không đọc được kết quả. */
export async function askStructured(ai, { system, user, schema, effort = 'medium', model, maxTokens = 16000 }) {
  const res = await clientOf(ai).beta.messages.parse({
    model: model ?? ai.model ?? DEFAULT_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // nếu model chính từ chối vì bộ lọc an toàn, API tự chuyển sang model dự phòng
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude từ chối trả lời (${res.stop_details?.category ?? 'không rõ lý do'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('Câu trả lời của Claude bị cắt do vượt giới hạn độ dài');
  if (!res.parsed_output) throw new Error('Không đọc được kết quả có cấu trúc từ Claude');
  return res.parsed_output;
}

export function describeAiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY không hợp lệ';
  if (e instanceof Anthropic.RateLimitError) return 'Claude API đang giới hạn tần suất, thử lại sau';
  if (e instanceof Anthropic.APIConnectionError) return 'không kết nối được Claude API';
  if (e instanceof Anthropic.APIError) return `Claude API lỗi ${e.status ?? ''}: ${e.message}`.trim();
  return e.message;
}
