// Các lớp bảo vệ bổ sung (ngoài nguyên tắc chỉ-đọc ở readonly.js):
//  - che bí mật (mật khẩu, mã bot, TOTP) trong mọi nội dung gửi ra ngoài / ghi log;
//  - chỉ cho trình duyệt làm việc với máy chủ MISA;
//  - siết quyền truy cập file bí mật trên đĩa, xoay vòng nhật ký;
//  - giới hạn tần suất lệnh Telegram.
import fs from 'node:fs';
import path from 'node:path';

/** Tạo hàm che các chuỗi bí mật (≥ 4 ký tự) trong văn bản. */
export function makeRedactor(secrets = []) {
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  if (!list.length) return (x) => x;
  return (text) => {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const s of list) {
      out = out.split(s).join('•••');
      const enc = encodeURIComponent(s);
      if (enc !== s) out = out.split(enc).join('•••');
    }
    return out;
  };
}
export const secretsOf = (config) => [config.secrets?.password, config.secrets?.telegramToken, config.secrets?.totpSecret, config.ai?.apiKey];

const DEFAULT_HOSTS = ['misa.vn', 'misa.com.vn', 'amis.vn'];
/** Danh sách máy chủ được phép: MISA + máy chủ trong baseUrl + amis.allowedHosts. */
export function allowedHostsOf(amis = {}) {
  const hosts = new Set([...DEFAULT_HOSTS, ...(amis.allowedHosts ?? [])].map((h) => h.toLowerCase()));
  for (const u of [amis.baseUrl, amis.loginUrl]) { try { hosts.add(new URL(u).hostname.toLowerCase()); } catch { /* bỏ qua */ } }
  return [...hosts];
}
/** true nếu URL thuộc máy chủ được phép (đúng tên hoặc là tên miền con). */
export function hostAllowed(url, hosts) {
  let host;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return u.protocol === 'about:' || u.protocol === 'blob:' || u.protocol === 'data:'; host = u.hostname.toLowerCase(); } catch { return false; }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Siết quyền file/thư mục chứa bí mật và dữ liệu tài chính: chỉ chủ tài khoản hệ điều hành đọc được. Không làm gì trên Windows. */
export function hardenFiles(config) {
  if (process.platform === 'win32') return [];
  const root = config.root ?? process.cwd();
  const targets = [[path.join(root, '.env'), 0o600], [path.join(root, '.auth'), 0o700], [config.dirs?.profile, 0o700], [config.dirs?.output, 0o700], [config.dirs?.downloads, 0o700], [path.join(root, 'data', 'telegram-access.json'), 0o600]];
  const changed = [];
  for (const [p, mode] of targets) {
    try { if (p && fs.existsSync(p) && (fs.statSync(p).mode & 0o777) !== mode) { fs.chmodSync(p, mode); changed.push(p); } } catch { /* không đổi được thì thôi */ }
  }
  return changed;
}

/** Xoay vòng nhật ký: file vượt maxBytes được đổi tên thành .1 (bản .1 cũ bị xoá) để không phình vô hạn. */
export function rotateLogs(dir, names = ['giam-sat.log', 'nhat-ky-yeu-cau.log'], maxBytes = 5 * 1024 * 1024) {
  for (const n of names) {
    const f = path.join(dir ?? '', n);
    try { if (fs.statSync(f).size > maxBytes) fs.renameSync(f, `${f}.1`); } catch { /* chưa có file */ }
  }
}

/** Giới hạn tần suất: tối đa `max` thao tác mỗi `windowMs` cho mỗi khoá (người dùng). */
export class RateLimiter {
  constructor(max = 20, windowMs = 60000) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  /** @returns {'ok'|'warn'|'drop'} 'warn' đúng 1 lần khi vừa vượt ngưỡng, sau đó 'drop' */
  check(key, now = Date.now()) {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    if (arr.length <= this.max) return 'ok';
    return arr.length === this.max + 1 ? 'warn' : 'drop';
  }
}
