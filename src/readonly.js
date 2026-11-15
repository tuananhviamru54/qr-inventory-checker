// NGUYÊN TẮC CỐT LÕI: bot CHỈ ĐỌC và XUẤT báo cáo — không ghi, sửa, xoá hay thao tác làm thay đổi dữ liệu AMIS.
// Hai lớp bảo vệ, luôn bật và không có tuỳ chọn tắt:
//   1. Lớp giao diện: từ chối bấm vào nút có chữ thuộc nhóm thao tác ghi (Cất, Lưu, Ghi sổ, Xoá, Sửa, Thêm...).
//   2. Lớp mạng: chặn mọi yêu cầu PUT/PATCH/DELETE và các yêu cầu POST có đường dẫn mang nghĩa ghi dữ liệu.
import { norm } from './util.js';
import { hostAllowed } from './security.js';

export class ReadOnlyViolation extends Error {}

// So với phần đầu của chữ trên nút (đã bỏ dấu, viết thường).
const FORBIDDEN_LABELS = [
  'cat', 'luu', 'ghi so', 'bo ghi', 'xoa', 'sua', 'them', 'nhan ban', 'nhap khau', 'duyet', 'tu choi',
  'ket chuyen', 'khoa so', 'bo khoa so', 'tinh gia', 'tinh lai', 'bao tri', 'cap nhat', 'dong bo',
  'phat hanh', 'gui', 'thanh toan', 'thu tien', 'chi tien', 'lap chung tu', 'lap phieu', 'ghi tang', 'ghi giam',
  'tiep tuc dang nhap', 'dang nhap lai', // đẩy người đang dùng tài khoản ra khỏi AMIS
  'save', 'delete', 'edit', 'add', 'update', 'post', 'import',
];

// So với từng "từ" trong đường dẫn URL của yêu cầu POST (tách theo ký tự đặc biệt và chữ hoa camelCase).
const WRITE_URL_TOKENS = new Set([
  'save', 'insert', 'update', 'delete', 'remove', 'create', 'add', 'edit', 'modify', 'post', 'posted', 'unpost',
  'import', 'upload', 'approve', 'reject', 'void', 'lock', 'unlock', 'merge', 'transfer', 'sync', 'duplicate',
  'ledger', 'recalculate', 'restore', 'backup',
]);

const SAFE_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']);

export function forbiddenLabel(text) {
  const t = norm(text);
  if (!t) return null;
  return FORBIDDEN_LABELS.find((w) => t === w || t.startsWith(`${w} `)) ?? null;
}

/** Kiểm tra tĩnh 1 bước trong config trước khi chạy. */
export function assertStepAllowed(action, arg) {
  if (action === 'press' && !SAFE_KEYS.has(arg)) {
    throw new ReadOnlyViolation(`Chế độ chỉ đọc: không cho phép phím "${arg}" (chỉ: ${[...SAFE_KEYS].join(', ')})`);
  }
  if (action === 'click' || action === 'download') {
    const selectors = typeof arg === 'string' ? [arg] : [arg.selector, arg.confirm].filter(Boolean);
    for (const m of selectors.join(' , ').matchAll(/text=["']?([^"'>]+)|has-text\(\s*["'](.+?)["']\s*\)/g)) {
      const hit = forbiddenLabel(m[1] ?? m[2]);
      if (hit) throw new ReadOnlyViolation(`Chế độ chỉ đọc: không cho phép bấm "${(m[1] ?? m[2]).trim()}" (thao tác ghi dữ liệu)`);
    }
  }
}

/** Kiểm tra phần tử thật trên trang ngay trước khi bấm. */
export async function assertElementAllowed(locator) {
  const texts = await locator.evaluate((el) => [
    el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title'),
  ]).catch(() => []);
  for (const text of texts) {
    const hit = typeof text === 'string' && text.length < 80 ? forbiddenLabel(text) : null;
    if (hit) throw new ReadOnlyViolation(`Chế độ chỉ đọc: từ chối bấm nút "${text.trim()}" (thao tác ghi dữ liệu)`);
  }
}

/** Quyết định cho 1 yêu cầu mạng. Trả về lý do chặn, hoặc null nếu cho qua. */
export function blockReason(method, url, allowPost = []) {
  method = method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (method !== 'POST') return `phương thức ${method}`;
  if (allowPost.some((p) => new RegExp(p, 'i').test(url))) return null;
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch { /* giữ nguyên */ }
  const tokens = pathname.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  const hit = tokens.find((t) => WRITE_URL_TOKENS.has(t));
  return hit ? `đường dẫn có "${hit}"` : null;
}

/**
 * Gắn lớp chặn mạng vào context của Playwright. Một yêu cầu không phải GET chỉ được đi khi CẢ HAI đồng ý:
 * luật cứng tại chỗ và agent giám sát độc lập (`supervisor`, nếu có).
 */
export async function installNetworkGuard(context, { allowPost = [], log = () => {}, supervisor, allowedHosts, redact = (x) => x } = {}) {
  const audit = { blocked: [], nonGet: [] };
  await context.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url().split('?')[0];
    const foreign = allowedHosts && !hostAllowed(req.url(), allowedHosts);
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      // không cho trang chính rời khỏi máy chủ MISA (chống chuyển hướng sang trang giả mạo để lấy mật khẩu)
      if (foreign && req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()) {
        audit.blocked.push({ method, url, reason: 'điều hướng ra ngoài MISA' });
        log(`🔒 Đã chặn điều hướng tới ${url} (ngoài máy chủ MISA)`);
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue();
    }
    // không gửi dữ liệu (POST...) tới máy chủ ngoài MISA; im lặng vì đây thường là đo lường của bên thứ ba
    if (foreign) {
      audit.nonGet.push({ time: new Date().toISOString(), method, url, blocked: 'máy chủ ngoài MISA' });
      return route.abort('blockedbyclient').catch(() => {});
    }
    let reason = blockReason(method, req.url(), allowPost);
    if (!reason && supervisor) {
      const verdict = await supervisor.ask({ kind: 'request', method, url: req.url(), body: redact((req.postData() ?? '').slice(0, 400)) });
      if (!verdict.allow) reason = `giám sát: ${verdict.reason}`;
    } else if (reason && supervisor) {
      supervisor.ask({ kind: 'request', method, url: req.url() }).catch(() => {}); // để giám sát cũng ghi nhận
    }
    audit.nonGet.push({ time: new Date().toISOString(), method, url, blocked: reason });
    if (!reason) return route.continue().catch(() => {});
    audit.blocked.push({ method, url, reason });
    log(`🔒 Đã chặn ${method} ${url} (${reason})`);
    return route.abort('blockedbyclient').catch(() => {});
  });
  return audit;
}
