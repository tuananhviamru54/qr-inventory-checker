// AGENT GIÁM SÁT ĐỘC LẬP — chạy thành một tiến trình riêng, tách khỏi tiến trình điều khiển trình duyệt.
// Mọi yêu cầu mạng không phải GET và mọi lần bấm nút của bot đều phải được tiến trình này cho phép.
// Nếu tiến trình giám sát chết hoặc không trả lời, bot coi như bị từ chối (xem supervisor-client.js).
//
// Thứ tự quyết định cho 1 yêu cầu mạng:
//   1. Luật cứng (readonly.js): PUT/PATCH/DELETE và URL mang nghĩa ghi → chặn, AI không được gỡ.
//   2. Danh sách ngoại lệ do người dùng khai trong config (allowPost) → cho qua.
//   3. Nếu có ANTHROPIC_API_KEY: Claude phân loại endpoint chưa gặp (kết quả lưu lại để lần sau không hỏi lại).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { aiEnabled, askStructured, describeAiError } from './ai.js';
import { blockReason, forbiddenLabel } from './readonly.js';

const RequestVerdict = z.object({
  loai: z.enum(['doc', 'xac_thuc', 'xuat_bao_cao', 'do_luong', 'ghi_cai_dat', 'ghi_du_lieu', 'khong_ro']),
  ly_do: z.string(),
});
const ClickVerdict = z.object({ an_toan: z.boolean(), ly_do: z.string() });
const ALLOWED = new Set(['doc', 'xac_thuc', 'xuat_bao_cao', 'do_luong']);

const SYSTEM = `Bạn là kiểm soát viên độc lập giám sát một bot tự động thao tác trên phần mềm kế toán MISA AMIS. Bot chỉ được phép ĐỌC và XUẤT báo cáo; tuyệt đối không được tạo, sửa, xoá, ghi sổ hay thay đổi bất kỳ dữ liệu hoặc thiết lập nào. Hậu quả của việc cho lọt một thao tác ghi là sổ kế toán thật của doanh nghiệp bị thay đổi, nên khi không chắc chắn hãy chọn phương án chặn.`;

const REQUEST_GUIDE = `Phân loại yêu cầu HTTP dưới đây mà trang web sắp gửi:
- doc: chỉ truy vấn/lấy dữ liệu (kể cả POST dùng để lọc, phân trang, lấy báo cáo, kiểm tra trạng thái).
- xac_thuc: đăng nhập, xác thực OTP, làm mới phiên.
- xuat_bao_cao: tạo/tải file xuất của báo cáo, không đụng tới chứng từ hay sổ sách.
- do_luong: gửi số liệu đo lường, ghi log lỗi, quảng cáo, thông báo — không liên quan dữ liệu kế toán.
- ghi_cai_dat: lưu thiết lập, bố cục, tuỳ chọn người dùng.
- ghi_du_lieu: tạo/sửa/xoá/ghi sổ/nhập khẩu/đồng bộ dữ liệu nghiệp vụ.
- khong_ro: không đủ căn cứ để xếp vào các loại trên.`;

const CLICK_GUIDE = `Bot sắp bấm vào một phần tử trên giao diện trong lúc xem và xuất báo cáo. an_toan = true chỉ khi thao tác bấm này không thể làm thay đổi dữ liệu hay thiết lập (ví dụ: mở báo cáo, chọn tham số xem, xem báo cáo, mở menu xuất, xuất Excel, xác nhận hộp thoại xuất, tải tệp, đóng hộp thoại). an_toan = false với mọi nút lưu, cất, ghi sổ, xoá, sửa, thêm, duyệt, kết chuyển, nhập khẩu, gửi, hoặc khi không chắc.`;

let state = null;

function init({ ai, allowPost, outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const cacheFile = path.join(outputDir, 'giam-sat-phan-loai.json');
  let cache = { requests: {}, clicks: {} };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) }; } catch { /* chưa có */ }
  state = {
    ai: ai ?? {}, useAi: aiEnabled(ai ?? {}), allowPost: allowPost ?? [], cacheFile, cache,
    logFile: path.join(outputDir, 'giam-sat.log'), pending: new Map(),
    stats: { requests: 0, denied: 0, clicks: 0, clicksDenied: 0, fills: 0, aiCalls: 0, aiErrors: 0, deniedList: [], lastAiError: null },
  };
}

function log(line) {
  fs.appendFileSync(state.logFile, `${new Date().toISOString()}\t${line}\n`);
}

const normPath = (url) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/{id}').replace(/\/\d{3,}(?=\/|$)/g, '/{id}');
  } catch { return url; }
};

async function classify(kind, key, prompt, schema) {
  const bucket = state.cache[kind];
  if (bucket[key]) return { ...bucket[key], by: 'đã phân loại' };
  if (!state.pending.has(key)) {
    state.pending.set(key, (async () => {
      state.stats.aiCalls++;
      const out = await askStructured(state.ai, { system: SYSTEM, user: prompt, schema, effort: 'low', model: state.ai.supervisorModel, maxTokens: 2000 });
      bucket[key] = out;
      fs.writeFileSync(state.cacheFile, JSON.stringify(state.cache, null, 1));
      return out;
    })().finally(() => state.pending.delete(key)));
  }
  return { ...(await state.pending.get(key)), by: 'AI' };
}

async function judgeRequest({ method, url, body }) {
  state.stats.requests++;
  const hard = blockReason(method, url, []);
  const excepted = state.allowPost.some((p) => new RegExp(p, 'i').test(url));
  if (hard && !excepted) return { allow: false, reason: hard, by: 'luật cứng' };
  if (excepted) return { allow: true, reason: 'ngoại lệ do người dùng khai báo', by: 'cấu hình' };
  if (!state.useAi) return { allow: true, reason: 'không vi phạm luật cứng', by: 'luật cứng' };
  const key = `${method} ${normPath(url)}`;
  try {
    const v = await classify('requests', key,
      `${REQUEST_GUIDE}\n\nPhương thức: ${method}\nURL: ${url.split('?')[0]}\nPhần đầu nội dung gửi đi: ${(body ?? '').slice(0, 400) || '(trống)'}`, RequestVerdict);
    return { allow: ALLOWED.has(v.loai), reason: `${v.loai}: ${v.ly_do}`, by: v.by };
  } catch (e) {
    state.stats.aiErrors++;
    state.stats.lastAiError = describeAiError(e);
    return { allow: true, reason: `AI giám sát lỗi (${state.stats.lastAiError}) — chỉ áp dụng luật cứng`, by: 'luật cứng' };
  }
}

async function judgeClick({ label, selector, context }) {
  state.stats.clicks++;
  const hit = forbiddenLabel(label);
  if (hit) return { allow: false, reason: `nút "${label}" thuộc nhóm thao tác ghi`, by: 'luật cứng' };
  if (!state.useAi) return { allow: true, reason: 'không vi phạm luật cứng', by: 'luật cứng' };
  const key = `${(label || selector).trim().slice(0, 80)}`;
  try {
    const v = await classify('clicks', key,
      `${CLICK_GUIDE}\n\nBáo cáo đang xử lý: ${context ?? ''}\nChữ trên phần tử: "${label ?? ''}"\nSelector: ${selector}`, ClickVerdict);
    return { allow: v.an_toan, reason: v.ly_do, by: v.by };
  } catch (e) {
    state.stats.aiErrors++;
    state.stats.lastAiError = describeAiError(e);
    return { allow: true, reason: `AI giám sát lỗi (${state.stats.lastAiError}) — chỉ áp dụng luật cứng`, by: 'luật cứng' };
  }
}

process.on('message', async (msg) => {
  try {
    if (msg.kind === 'init') { init(msg); return process.send({ id: msg.id, ok: true }); }
    if (msg.kind === 'summary') return process.send({ id: msg.id, summary: { ...state.stats, aiEnabled: state.useAi } });
    if (msg.kind === 'fill') { state.stats.fills++; log(`ĐIỀN\t${msg.selector}\t${msg.value}`); return process.send({ id: msg.id, allow: true }); }
    const verdict = msg.kind === 'request' ? await judgeRequest(msg) : await judgeClick(msg);
    const what = msg.kind === 'request' ? `${msg.method} ${msg.url.split('?')[0]}` : `BẤM "${msg.label ?? ''}" ${msg.selector}`;
    log(`${verdict.allow ? 'CHO QUA' : 'CHẶN'}\t${what}\t[${verdict.by}] ${verdict.reason}`);
    if (!verdict.allow) {
      if (msg.kind === 'request') state.stats.denied++; else state.stats.clicksDenied++;
      state.stats.deniedList.push({ what, reason: verdict.reason });
    }
    process.send({ id: msg.id, ...verdict });
  } catch (e) {
    process.send({ id: msg.id, allow: false, reason: `Lỗi giám sát: ${e.message}`, by: 'lỗi' });
  }
});
process.on('disconnect', () => process.exit(0));
