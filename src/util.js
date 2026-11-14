// Tiện ích dùng chung: chuẩn hoá chuỗi tiếng Việt, đọc số, tính kỳ báo cáo.

export function norm(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Đọc số theo cả định dạng VN (1.234,56) lẫn quốc tế (1,234.56). Trả null nếu không phải số. */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let s = String(value).trim().replace(/\s/g, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.split('.').join('');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function fmtNumber(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 4 }).format(n);
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;

/** Tính kỳ báo cáo theo giờ Việt Nam. Trả về chuỗi dd/MM/yyyy. */
export function resolvePeriod(period = 'thisMonth', now = new Date(), timeZone = 'Asia/Ho_Chi_Minh') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const y = +parts.year, m = +parts.month - 1, d = +parts.day;
  const today = new Date(Date.UTC(y, m, d));
  let from = today, to = today;
  switch (period) {
    case 'today': break;
    case 'yesterday': from = to = new Date(Date.UTC(y, m, d - 1)); break;
    case 'thisWeek': from = new Date(Date.UTC(y, m, d - ((today.getUTCDay() + 6) % 7))); break; // thứ 2 → hôm nay
    case 'thisMonth': from = new Date(Date.UTC(y, m, 1)); break;
    case 'lastMonth': from = new Date(Date.UTC(y, m - 1, 1)); to = new Date(Date.UTC(y, m, 0)); break;
    case 'thisYear': from = new Date(Date.UTC(y, 0, 1)); break;
    default:
      if (typeof period === 'object' && period.from && period.to) {
        return { fromDate: period.from, toDate: period.to, today: fmtDate(today) };
      }
      throw new Error(`Kỳ báo cáo không hợp lệ: ${JSON.stringify(period)}`);
  }
  return { fromDate: fmtDate(from), toDate: fmtDate(to), today: fmtDate(today) };
}

export function template(str, vars) {
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** TOTP (RFC 6238) cho xác thực 2 lớp bằng ứng dụng Authenticator. */
export async function totp(secretBase32, now = Date.now()) {
  const { createHmac } = await import('node:crypto');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/[\s=-]/g, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('AMIS_TOTP_SECRET không phải chuỗi base32 hợp lệ');
    bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

export const PERIOD_LABELS = { today: 'Hôm nay', yesterday: 'Hôm qua', thisWeek: 'Tuần này', thisMonth: 'Tháng này', lastMonth: 'Tháng trước' };

/**
 * Đọc khoảng ngày người dùng gõ: "01/11/2026 - 10/11/2026", "1/11 đến 10/11" (thiếu năm = năm hiện tại), hoặc 1 ngày.
 * @returns {{from:string,to:string}|{error:string}}
 */
export function parseDateRange(text, now = new Date()) {
  const ty = +resolvePeriod('today', now).today.split('/')[2];
  const found = [...String(text).matchAll(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{4}))?/g)];
  if (!found.length || found.length > 2) return { error: 'Không đọc được ngày. Hãy gửi theo dạng: 01/11/2026 - 10/11/2026 (hoặc 1 ngày: 10/11/2026).' };
  const toDate = ([, d, mo, y]) => {
    const year = y ? +y : ty;
    const dt = new Date(Date.UTC(year, +mo - 1, +d));
    return dt.getUTCFullYear() === year && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d ? dt : null;
  };
  const a = toDate(found[0]);
  const b = found[1] ? toDate(found[1]) : a;
  if (!a || !b) return { error: 'Có ngày không tồn tại trong lịch (ví dụ 31/02). Hãy gửi lại.' };
  if (a > b) return { error: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc. Hãy gửi lại.' };
  if ((b - a) / 864e5 > 366) return { error: 'Khoảng thời gian tối đa là 366 ngày. Hãy gửi lại.' };
  return { from: fmtDate(a), to: fmtDate(b) };
}
