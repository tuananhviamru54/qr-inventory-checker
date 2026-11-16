// Bot Telegram: nhận câu hỏi/lệnh, hiện tiến độ, trả lời sau khi kế toán trưởng (AI) kiểm soát.
// Chỉ phục vụ đúng chat TELEGRAM_CHAT_ID; tin từ chat khác bị bỏ qua.
import { collect, dataAgeMinutes, enableWarmSession, fileAgeMinutes, refreshGroups, runPipeline, telegramOf } from './index.js';
import { Progress } from './progress.js';
import { aiEnabled, describeAiError } from './ai.js';
import { draftAnswer } from './agents/answer.js';
import { finalizeAnswer } from './agents/expert.js';
import { reviewDraft, reviewSection } from './agents/reviewer.js';
import { answerByRules, RULE_HELP } from './agents/lookup.js';
import { supervisionSection } from './report.js';
import { buildSalesMessage } from './sales.js';
import { buildStockMessage } from './stock.js';
import { buildDebtMessage } from './debt.js';
import { buildCashMessage } from './cash.js';
import { buildDailyMessage } from './daily.js';
import { buildIncomeMessage } from './income.js';
import { buildCostMessage, summarizeCost, previousRange, COST_ACCOUNTS } from './cost.js';
import { readLedger, expenseVouchers, buildVoucherMessage, writeVoucherWorkbook } from './ledger.js';
import { loadGroups, groupsKey } from './groups.js';
import { scopeConfig, tenantsOf, defaultTenantId, SYSTEM_ID } from './config.js';
import { escapeHtml, norm, parseDateRange, resolvePeriod, PERIOD_LABELS } from './util.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter } from './security.js';

// ---- Bộ điều khiển mặc định trong Telegram ----
const BTN = {
  refresh: '🔄 Lấy báo cáo mới nhất',
  stock: '📊 Báo cáo tồn kho',
  sales: '💰 Doanh số theo mặt hàng',
  salesKh: '👥 Doanh số theo khách hàng',
  ar: '🧾 Công nợ khách hàng',
  ap: '🏭 Công nợ nhà cung cấp',
  cash: '💵 Quỹ tiền',
  home: '🏠 Trang chủ',
  fin: '📑 Kết quả KD',
  cost: '💸 Chi phí',
  help: '❓ Hướng dẫn',
};
const BTN_TO_CMD = { [BTN.refresh]: '/moi', [BTN.stock]: '/tonkho', [BTN.sales]: '/doanhso', [BTN.salesKh]: '/doanhsokh', [BTN.ar]: '/congnokh', [BTN.ap]: '/congnoncc', [BTN.cash]: '/quytien', [BTN.help]: '/trogiup', [BTN.home]: '/start', [BTN.fin]: '/ketqua', [BTN.cost]: '/chiphi' };

/** Bàn phím cố định dưới ô nhập tin (luôn hiện cho tới khi bị gỡ). */
export const MENU = {
  keyboard: [[{ text: BTN.stock }, { text: BTN.cash }], [{ text: BTN.sales }, { text: BTN.salesKh }], [{ text: BTN.ar }, { text: BTN.ap }], [{ text: BTN.refresh }, { text: BTN.home }]],
  resize_keyboard: true,
  is_persistent: true,
};

/** Bàn phím riêng của chủ bot trong chat riêng: thêm nút Kết quả kinh doanh. */
export const MENU_OWNER = { ...MENU, keyboard: [...MENU.keyboard.slice(0, -1), [{ text: BTN.fin }, { text: BTN.cost }], MENU.keyboard.at(-1)] };
export const FIN_DENIED = '🔒 Báo cáo tài chính (kết quả kinh doanh, chi phí) chỉ dành cho chủ bot và chỉ xem trong chat riêng với bot.';

export const COMMANDS = [
  { command: 'start', description: 'Trang chủ: logo và các báo cáo' },
  { command: 'cuoingay', description: 'Báo cáo cuối ngày: tiền, bán hàng, công nợ, tồn kho' },
  { command: 'moi', description: 'Lấy báo cáo mới nhất (làm mới dữ liệu từ AMIS)' },
  { command: 'tonkho', description: 'Báo cáo tồn kho theo kỳ và Nhóm VTHH' },
  { command: 'baocao', description: 'Báo cáo đối chiếu (tồn kho với kiểm kê)' },
  { command: 'doanhso', description: 'Doanh số theo mặt hàng (kèm doanh thu, lãi gộp)' },
  { command: 'doanhsokh', description: 'Doanh số theo khách hàng (kèm doanh thu, lãi gộp)' },
  { command: 'congnokh', description: 'Công nợ khách hàng (phải thu, TK 131)' },
  { command: 'congnoncc', description: 'Công nợ nhà cung cấp (phải trả, TK 331)' },
  { command: 'quytien', description: 'Quỹ tiền: tiền mặt (TK 111) + tiền gửi ngân hàng (TK 112)' },
  { command: 'ketqua', description: 'Kết quả kinh doanh B02 (chỉ chủ bot, chat riêng)' },
  { command: 'chiphi', description: 'Chi phí kỳ này so với kỳ trước (chỉ chủ bot, chat riêng)' },
  { command: 'congty', description: 'Trang tổng công ty: chọn chi nhánh (chỉ chủ bot)' },
  { command: 'capnhatnhom', description: 'Cập nhật danh sách Nhóm VTHH từ AMIS' },
  { command: 'trogiup', description: 'Hướng dẫn sử dụng' },
];

/** Bàn phím chọn kỳ: tiền tố s: cho báo cáo doanh số, k: cho báo cáo tồn kho. */
const MODE_PREFIX = { sales: 's', salesKh: 'h', stock: 'k', ar: 'p', ap: 'q', cash: 'm', fin: 'f', cost: 'y' };
const PREFIX_MODE = Object.fromEntries(Object.entries(MODE_PREFIX).map(([m, p]) => [p, m]));
const REFRESH_PREFIX = { sales: 'r', salesKh: 'j', stock: 'u', ar: 'v', ap: 'w', cash: 'n', fin: 'e', cost: 'o' };
const REFRESH_MODE = Object.fromEntries(Object.entries(REFRESH_PREFIX).map(([m, p]) => [p, m]));
/** Kỳ "Tháng N" của năm hiện tại (giờ VN). */
export function monthRange(mm, now = new Date()) {
  const y = +resolvePeriod('today', now).today.split('/')[2];
  const last = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  const p2 = (n) => String(n).padStart(2, '0');
  return { fromDate: `01/${p2(mm)}/${y}`, toDate: `${p2(last)}/${p2(mm)}/${y}`, label: `Tháng ${mm}/${y}` };
}
const financeKeyboard = (p = 'f', now = new Date()) => {
  const cur = +resolvePeriod('today', now).today.split('/')[1];
  const months = Array.from({ length: cur }, (_, i) => ({ text: `Tháng ${i + 1}`, callback_data: `${p}:mon:${i + 1}` }));
  const rows = [];
  for (let i = 0; i < months.length; i += 4) rows.push(months.slice(i, i + 4));
  return { inline_keyboard: [
    ...rows,
    [{ text: 'Quý này', callback_data: `${p}:thisQuarter` }, { text: 'Quý trước', callback_data: `${p}:lastQuarter` }],
    [{ text: 'Năm nay', callback_data: `${p}:thisYear` }, { text: 'Năm trước', callback_data: `${p}:lastYear` }],
    [{ text: '📅 Tùy chọn ngày', callback_data: `${p}:custom` }],
  ] };
};
const periodKeyboard = (mode = 'sales') => {
  if (mode === 'fin' || mode === 'cost') return financeKeyboard(MODE_PREFIX[mode]);
  const p = MODE_PREFIX[mode] ?? 's';
  return { inline_keyboard: [
    [{ text: 'Hôm nay', callback_data: `${p}:today` }, { text: 'Hôm qua', callback_data: `${p}:yesterday` }],
    [{ text: 'Tuần này', callback_data: `${p}:thisWeek` }, { text: 'Tháng này', callback_data: `${p}:thisMonth` }],
    [{ text: 'Tháng trước', callback_data: `${p}:lastMonth` }, { text: '📅 Tùy chọn ngày', callback_data: `${p}:custom` }],
  ] };
};

/** Tên sổ dữ liệu hiển thị trên báo cáo, kèm chi nhánh nếu đang xem theo chi nhánh. */
/** Ghi chú khi gộp nhiều sổ mà có sổ không có nhóm đã chọn. */
const scopeNoteText = (ds) => (ds?.scopeNotes?.length ? ds.scopeNotes.map((n) => `ℹ️ ${escapeHtml(n)}`).join('\n') : '');
const dbLabel = (config) => [config.secrets.targetDb, config.branchName && `📍 ${config.branchName}`].filter(Boolean).join(' · ');

// ---- Trang chủ (dashboard): logo + các ô báo cáo bấm được ----
const LOGO = fileURLToPath(new URL('../assets/logo.jpg', import.meta.url));
const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
export const DASHBOARD_KEYBOARD = { inline_keyboard: [
  [{ text: '📊 Tồn kho', callback_data: 'k:menu' }, { text: '💵 Quỹ tiền', callback_data: 'm:menu' }],
  [{ text: '💰 DS mặt hàng', callback_data: 's:menu' }, { text: '👥 DS khách hàng', callback_data: 'h:menu' }],
  [{ text: '🧾 Phải thu KH', callback_data: 'p:menu' }, { text: '🏭 Phải trả NCC', callback_data: 'q:menu' }],
  [{ text: '📋 Báo cáo cuối ngày', callback_data: 'z:daily' }],
  [{ text: '🔄 Đối chiếu kho', callback_data: 'z:check' }, { text: '❓ Hướng dẫn', callback_data: 'z:help' }],
] };
export function dashboardCaption(config, now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600e3);
  const date = `${WEEKDAYS[vn.getUTCDay()]}, ${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}/${vn.getUTCFullYear()}`;
  const db = config.secrets.targetDb ? ` · 🗄 ${escapeHtml(config.secrets.targetDb)}` : '';
  return [
    `🐉 <b>${escapeHtml(config.brand ?? 'TỔNG KHO NHỰA ECOPLAST QUẢNG NINH')}</b>`,
    `<i>Trung tâm báo cáo MISA AMIS</i>${db}`,
    ...(config.branchName ? [`📍 Chi nhánh: <b>${escapeHtml(config.branchName)}</b>`] : []),
    `📅 ${date}`,
    '━━━━━━━━━━━━━━━━━━',
    '📦 <b>KHO & BÁN HÀNG</b>',
    '   📊 Tồn kho — đầu kỳ · nhập · xuất · cuối kỳ',
    '   💰 Doanh số theo mặt hàng · Nhóm VTHH',
    '   👥 Doanh số theo khách hàng · lãi gộp',
    '💳 <b>CÔNG NỢ & DÒNG TIỀN</b>',
    '   🧾 Phải thu khách hàng (TK 131)',
    '   🏭 Phải trả nhà cung cấp (TK 331)',
    '   💵 Quỹ tiền — tiền mặt + ngân hàng',
    '📋 <b>BÁO CÁO CUỐI NGÀY</b> — tự gửi lúc 17:30',
    '━━━━━━━━━━━━━━━━━━',
    '🛡 Chỉ đọc · mọi thao tác ghi đều bị chặn',
    '👇 Chọn báo cáo bên dưới',
  ].join('\n');
}
/** Ô bấm trang chủ; chat riêng của chủ bot có thêm ô Kết quả kinh doanh (🔒). */
export const dashboardKeyboard = (ownerPrivate = false, multiCompany = false) => (ownerPrivate
  ? { inline_keyboard: [...DASHBOARD_KEYBOARD.inline_keyboard.slice(0, 3), [{ text: '📑 Kết quả KD 🔒', callback_data: 'f:menu' }, { text: '💸 Chi phí 🔒', callback_data: 'y:menu' }], ...DASHBOARD_KEYBOARD.inline_keyboard.slice(3), ...(multiCompany ? [[{ text: '⬅️ Về trang tổng công ty', callback_data: 'z:co' }]] : [])] }
  : DASHBOARD_KEYBOARD);
/** Trang tổng (chỉ chủ bot, chat riêng): công ty có nhiều chi nhánh ở trên → bấm 1 chi nhánh để vào trang báo cáo hiện tại. */
export function companyDashboard(config, now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600e3);
  const date = `${WEEKDAYS[vn.getUTCDay()]}, ${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}/${vn.getUTCFullYear()}`;
  const tenants = tenantsOf(config);
  const top = tenants.find((t) => t.top) ?? tenants[0];
  const others = tenants.filter((t) => t !== top);
  const L = [`🏢 <b>${escapeHtml(top.brand ?? top.name)}</b>`, '<i>Trang tổng · chọn chi nhánh để xem báo cáo</i>', `📅 ${date}`, '━━━━━━━━━━━━━━━━━━'];
  if (others.length) L.push(`🌐 <b>Toàn hệ thống</b> — ${escapeHtml(top.name)} + ${others.map((t) => escapeHtml(t.name)).join(' + ')}`, '');
  (top.branches ?? []).forEach((b) => L.push(`${b.icon ?? '🏭'} ${escapeHtml(b.name)}${b.codes.length > 1 ? ` — cộng tất cả chi nhánh ${escapeHtml(top.name)}` : ''}`));
  if (others.length) { L.push('', '<b>Sổ dữ liệu riêng</b>'); others.forEach((t) => L.push(`🐉 ${escapeHtml(t.name)}`)); }
  L.push('━━━━━━━━━━━━━━━━━━', '🛡 Chỉ đọc · 🔒 chỉ chủ bot', '👇 Chọn để mở trang báo cáo');
  const kb = others.length ? [[{ text: '🌐 Toàn hệ thống (gồm cả Quảng Ninh)', callback_data: `z:br:${SYSTEM_ID}:0` }]] : [];
  const br = (top.branches ?? []).map((b, i) => ({ text: `${b.icon ?? '🏭'} ${b.name}`, callback_data: `z:br:${top.id}:${i}` }));
  if (br.length) kb.push([br[0]]);
  for (let i = 1; i < br.length; i += 2) kb.push(br.slice(i, i + 2));
  if (!br.length) kb.push([{ text: `🏢 ${top.name}`, callback_data: `z:br:${top.id}:0` }]);
  others.forEach((t) => kb.push([{ text: `🐉 ${t.name}`, callback_data: `z:br:${t.id}:0` }]));
  return { caption: L.join('\n'), reply_markup: { inline_keyboard: kb } };
}
export async function sendCompanyDashboard(config, tg) {
  const { caption, reply_markup } = companyDashboard(config);
  try { await tg.sendFile(LOGO, caption, 'sendPhoto', { html: true, reply_markup }); } catch { await tg.sendMessage(caption, { reply_markup }); }
}

export async function sendDashboard(config, tg, { ownerPrivate = false } = {}) {
  const kb = dashboardKeyboard(ownerPrivate, (config.tenants?.length ?? 0) > 1);
  const caption = dashboardCaption(config) + (ownerPrivate ? '\n🔒 <i>Riêng bạn: Kết quả kinh doanh · Chi phí</i>' : '');
  try {
    await tg.sendFile(LOGO, caption, 'sendPhoto', { html: true, reply_markup: kb });
  } catch (e) {
    console.error(`Không gửi được ảnh trang chủ: ${e.message}`);
    await tg.sendMessage(caption, { reply_markup: kb }); // không gửi được ảnh → gửi chữ
  }
}

const helpText = (config) => `🤖 <b>Bot đối chiếu MISA AMIS</b> (chỉ đọc)
Dùng các nút dưới ô nhập tin:
${BTN.refresh} — vào AMIS lấy dữ liệu mới rồi gửi báo cáo đối chiếu
${BTN.stock} — tồn kho theo kỳ (Hôm nay · Hôm qua · Tuần này · Tháng này · Tháng trước · Tùy chọn ngày) và Nhóm VTHH: đầu kỳ, nhập, xuất, cuối kỳ, giá trị
${BTN.sales} — doanh số từng mặt hàng kèm doanh thu, lọc theo Nhóm VTHH: Hôm nay · Hôm qua · Tuần này · Tháng này · Tháng trước · Tùy chọn ngày
${BTN.salesKh} — doanh số từng khách hàng kèm doanh thu thuần, lãi gộp; chọn được Nhóm VTHH như doanh số mặt hàng
${BTN.ar} — công nợ phải thu (TK 131): dư đầu kỳ, phát sinh, dư cuối kỳ, top khách còn nợ
${BTN.ap} — công nợ phải trả (TK 331) theo nhà cung cấp
${BTN.cash} — tổng tiền hiện có: tồn quỹ tiền mặt (thu, chi, các khoản lớn nhất) và số dư từng tài khoản ngân hàng
(Gõ tắt: /moi · /tonkho · /congnokh · /congnoncc · /baocao (đối chiếu) · /doanhso · /doanhso hôm qua · /doanhsokh · /quytien)

${aiEnabled(config.ai)
  ? 'Hoặc gõ câu hỏi bất kỳ về tồn kho. Mọi câu trả lời đều qua chuyên gia (AI) đối chiếu và chốt, rồi kế toán trưởng (AI) kiểm tra độ chính xác trước khi gửi.'
  : RULE_HELP}`;

// ---- Lịch chọn ngày bằng nút bấm (Telegram không có ô chọn ngày sẵn) ----
const pad2 = (n) => String(n).padStart(2, '0');
const numOf = (dmy) => { const [d, m, y] = dmy.split('/').map(Number); return y * 10000 + m * 100 + d; };   // 'dd/mm/yyyy' → yyyymmdd
const dmyOf = (n) => `${pad2(n % 100)}/${pad2(Math.floor(n / 100) % 100)}/${Math.floor(n / 10000)}`;          // yyyymmdd → 'dd/mm/yyyy'
const monthShift = (ym, delta) => { let y = Math.floor(ym / 100), m = (ym % 100) - 1 + delta; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y * 100 + m + 1; };

/** Bàn phím lịch của tháng `ym` (yyyymm). Ngày sau hôm nay và (khi đang chọn ngày kết thúc) ngày trước ngày bắt đầu bị khoá. */
export function buildCalendar({ ym, todayNum, from = null }) {
  const y = Math.floor(ym / 100), m = ym % 100;
  const blank = { text: ' ', callback_data: 'c:n' };
  const nextAllowed = monthShift(ym, 1) * 100 + 1 <= todayNum;
  const rows = [
    [{ text: '‹', callback_data: `c:m:${monthShift(ym, -1)}` }, { text: `Tháng ${m}/${y}`, callback_data: 'c:n' },
      nextAllowed ? { text: '›', callback_data: `c:m:${monthShift(ym, 1)}` } : blank],
    ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((t) => ({ text: t, callback_data: 'c:n' })),
  ];
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let row = Array.from({ length: lead }, () => blank);
  for (let d = 1; d <= days; d++) {
    const n = ym * 100 + d;
    let cell;
    if (n > todayNum || (from && n < from)) cell = { text: '·', callback_data: 'c:n' };
    else cell = { text: n === from ? `✔${d}` : n === todayNum ? `•${d}` : String(d), callback_data: `c:d:${n}` };
    row.push(cell);
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(blank); rows.push(row); }
  if (from) rows.push([{ text: `📌 Chỉ 1 ngày ${dmyOf(from)}`, callback_data: 'c:o' }, { text: '↩ Chọn lại ngày bắt đầu', callback_data: 'c:r' }]);
  rows.push([{ text: '📍 Về tháng này', callback_data: 'c:t' }, { text: '✖ Huỷ', callback_data: 'c:x' }]);
  return { inline_keyboard: rows };
}

const calText = (from) => from
  ? `📅 <b>Từ ngày ${dmyOf(from)}</b> ✔\nBấm <b>ngày kết thúc</b> (hoặc "Chỉ 1 ngày").`
  : '📅 <b>Chọn khoảng ngày</b>\nBấm <b>ngày bắt đầu</b>. (Hoặc gõ thẳng, ví dụ <code>01/11/2026 - 10/11/2026</code>.)';

async function sendCalendar(tg, state) {
  const todayNum = numOf(resolvePeriod('today').today);
  state.cal = { from: null };
  await tg.sendMessage(calText(null), { reply_markup: buildCalendar({ ym: Math.floor(todayNum / 100), todayNum }) });
}

/**
 * Xử lý 1 lần bấm trên lịch: sửa tin nhắn tại chỗ (đổi tháng, chọn ngày bắt đầu...).
 * @returns {{fromDate,toDate,label}|null} khoảng ngày đã chọn xong (cần lập báo cáo), hoặc null
 */
export async function applyCalendar(tg, state, data, messageId) {
  const todayNum = numOf(resolvePeriod('today').today);
  const [, act, arg] = String(data).split(':');
  const cal = (state.cal ??= { from: null });
  const show = (ym) => tg.editMessage(messageId, calText(cal.from), { reply_markup: buildCalendar({ ym, todayNum, from: cal.from }) });
  const done = (text) => tg.editMessage(messageId, text, { reply_markup: { inline_keyboard: [] } });
  const range = (a, b) => ({ fromDate: dmyOf(a), toDate: dmyOf(b), label: a === b ? dmyOf(a) : `${dmyOf(a)} – ${dmyOf(b)}` });
  const pick = async (a, b) => { state.cal = null; state.awaitingRange = null; const r = range(a, b); await done(`✅ Đã chọn: <b>${escapeHtml(r.label)}</b> — đang lập báo cáo…`); return r; };

  if (act === 'n') return null;
  if (act === 'x') { state.cal = null; state.awaitingRange = null; await done('Đã huỷ chọn ngày.'); return null; }
  if (act === 't') { await show(Math.floor(todayNum / 100)); return null; }
  if (act === 'm') { const ym = Number(arg); if (ym > 200000 && ym <= Math.floor(todayNum / 100)) await show(ym); return null; }
  if (act === 'r') { cal.from = null; await show(Math.floor(todayNum / 100)); return null; }
  if (act === 'o') return cal.from ? pick(cal.from, cal.from) : null;
  if (act === 'd') {
    const n = Number(arg);
    if (!(n > 20000101 && n <= todayNum)) return null;                    // ngày không hợp lệ hoặc ở tương lai
    if (!cal.from || n < cal.from) { cal.from = n; await show(Math.floor(n / 100)); return null; }
    return pick(cal.from, n);
  }
  return null;
}

// ---- Báo cáo doanh số ----
const periodOf = (key) => ({ ...resolvePeriod(key), label: PERIOD_LABELS[key] });
const ddmmyyyy = (s) => s.replace(/\//g, '');
const vnTime = (ms) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(ms);

/** Bước chọn Nhóm VTHH sau khi đã có kỳ: hiện danh sách nhóm của AMIS để bấm chọn (không chọn gì = tất cả nhóm). */
export async function beginSales(config, tg, range, opts = {}) {
  const state = opts.state ?? defaultState;
  const mode = opts.mode ?? state.mode ?? 'sales';
  const list = ['ar', 'ap', 'cash', 'fin', 'cost'].includes(mode) ? [] : loadGroups(config); // toàn hệ thống: hợp nhóm của các sổ // công nợ không có bước chọn Nhóm VTHH
  if (!list.length) return runReport(config, tg, mode, range, opts); // chưa có danh sách nhóm → lấy tất cả
  state.pick = { range, list, selected: new Set(), mode };
  await tg.sendMessage(groupText(state.pick), { reply_markup: groupKeyboard(state.pick) });
  return null;
}

function groupText({ range, list, selected }) {
  const named = list.filter((g) => g.name !== g.code).map((g) => `${g.code} = ${g.name}`).join(' · ');
  return [
    `📦 <b>Chọn Nhóm VTHH</b> — kỳ <b>${escapeHtml(range.label)}</b>`,
    'Bấm để chọn hoặc bỏ chọn (chọn được nhiều nhóm). Chọn nhóm cha như <b>HH</b> là gồm cả các nhóm con. Không chọn gì thì xem tất cả nhóm.',
    named ? `<i>${escapeHtml(named)}</i>` : '',
    selected.size ? `Đã chọn: <b>${escapeHtml([...selected].join(', '))}</b>` : '',
  ].filter(Boolean).join('\n');
}

export function groupKeyboard({ list, selected }) {
  const rows = [[{ text: '📊 Xem TẤT CẢ nhóm', callback_data: 'g:a' }]];
  let row = [];
  list.forEach((g, i) => {
    row.push({ text: `${selected.has(g.code) ? '✔ ' : ''}${g.code}`, callback_data: `g:t:${i}` });
    if (row.length === 3) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  const ctl = [];
  if (selected.size) { ctl.push({ text: `✅ Xem báo cáo (${selected.size} nhóm)`, callback_data: 'g:ok' }); ctl.push({ text: '↩ Bỏ chọn', callback_data: 'g:c' }); }
  ctl.push({ text: '✖ Huỷ', callback_data: 'g:x' });
  rows.push(ctl);
  return { inline_keyboard: rows };
}

/**
 * Xử lý 1 lần bấm trên bảng chọn nhóm (chỉ sửa giao diện).
 * @returns {{range, groups:string[]}|null} khi đã chọn xong và cần lập báo cáo
 */
export async function applyGroupPick(tg, state, data, messageId) {
  const pick = state.pick;
  const done = (text) => tg.editMessage(messageId, text, { reply_markup: { inline_keyboard: [] } });
  if (!pick) { await done('Bảng chọn này đã hết hạn. Hãy bấm lại nút báo cáo (💰 doanh số hoặc 📊 tồn kho) để chọn lại.'); return null; }
  const [, act, arg] = String(data).split(':');
  const refresh = () => tg.editMessage(messageId, groupText(pick), { reply_markup: groupKeyboard(pick) });
  if (act === 't') {
    const g = pick.list[Number(arg)];
    if (g) { pick.selected.has(g.code) ? pick.selected.delete(g.code) : pick.selected.add(g.code); await refresh(); }
    return null;
  }
  if (act === 'c') { pick.selected.clear(); await refresh(); return null; }
  if (act === 'x') { state.pick = null; await done('Đã huỷ.'); return null; }
  const groups = act === 'ok' ? [...pick.selected] : act === 'a' ? [] : null;
  if (groups === null || (act === 'ok' && !groups.length)) return null;
  state.pick = null;
  await done(`✅ Kỳ <b>${escapeHtml(pick.range.label)}</b> · Nhóm VTHH: <b>${escapeHtml(groups.length ? groups.join(', ') : 'tất cả nhóm')}</b> — đang lập báo cáo…`);
  return { range: pick.range, groups, mode: pick.mode ?? 'sales' };
}

/** Hiểu câu "doanh số hôm qua", "doanh thu tuần này", "doanh số 01/11 - 10/11"... @returns {{key}|{custom}|{picker:true}|null} */
export function parseSalesIntent(text, now = new Date()) {
  const n = ` ${norm(text)} `;
  if (!/ doanh (so|thu) /.test(n)) return null;
  for (const [key, re] of [['today', / hom nay /], ['yesterday', / hom qua /], ['thisWeek', / tuan nay /], ['thisMonth', / thang nay /], ['lastMonth', / thang truoc /]]) {
    if (re.test(n)) return { key };
  }
  if (/\d{1,2}[/\-.]\d{1,2}/.test(text)) {
    const r = parseDateRange(text, now);
    return r.error ? { picker: true, error: r.error } : { custom: r };
  }
  return { picker: true };
}

async function sendPeriodPicker(tg, note = '', mode = 'sales', state = defaultState) {
  state.mode = mode;
  const head = { stock: '📊 <b>Báo cáo tồn kho</b> (đầu kỳ, nhập, xuất, cuối kỳ, giá trị)', ar: '🧾 <b>Công nợ khách hàng</b> (phải thu, TK 131)', ap: '🏭 <b>Công nợ nhà cung cấp</b> (phải trả, TK 331)', salesKh: '👥 <b>Doanh số theo khách hàng</b> (kèm doanh thu thuần, lãi gộp)', cash: '💵 <b>Quỹ tiền</b> (tiền mặt + tiền gửi ngân hàng)', fin: '📑 <b>Kết quả hoạt động kinh doanh</b> (B02 · kỳ này so với kỳ trước) 🔒', cost: '💸 <b>Chi phí</b> (giá vốn, quản lý, tài chính, khác · kỳ này so với kỳ trước) 🔒' }[mode] ?? '💰 <b>Doanh số theo mặt hàng</b> (kèm doanh thu thuần, lãi gộp)';
  await tg.sendMessage(`${note ? `${note}\n\n` : ''}${head}\nChọn kỳ cần xem:`, { reply_markup: periodKeyboard(mode) });
}

const runReport = (config, tg, mode, range, opts) => (mode === 'cost' ? handleCost(config, tg, range, opts) : mode === 'fin' ? handleIncome(config, tg, range, opts) : mode === 'cash' ? handleCash(config, tg, range, opts) : mode === 'stock' ? handleStock(config, tg, range, opts) : mode === 'ar' || mode === 'ap' ? handleDebt(config, tg, mode, range, opts) : handleSales(config, tg, range, { ...opts, by: mode === 'salesKh' ? 'customer' : 'item' }));

const refreshButton = (config, range, groups, prefix) => `${prefix}:${ddmmyyyy(range.fromDate)}:${ddmmyyyy(range.toDate)}${groups.length ? `:${groups.map((c) => loadGroups(config).findIndex((g) => g.code === c)).filter((i) => i >= 0).join('-')}` : ''}`;

export async function handleDebt(config, tg, mode, range, { fresh = false, headed } = {}) {
  const kindKey = mode === 'ap' ? 'payable' : 'receivable';
  const sourceId = mode === 'ap' ? 'cong_no_phai_tra' : 'cong_no_phai_thu';
  const title = mode === 'ap' ? 'công nợ nhà cung cấp' : 'công nợ khách hàng';
  const period = { fromDate: range.fromDate, toDate: range.toDate, today: resolvePeriod('today').today };
  const fileKey = `${sourceId}__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}`;
  const reuse = !fresh && fileAgeMinutes(config, fileKey) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo ${title} — ${range.label}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period, sourceIds: [sourceId], fileKeys: { [sourceId]: fileKey } });
    await progress.stage('send');
    const ds = data.datasets[sourceId];
    if (ds.error?.includes('NO_DATA')) {
      await tg.sendMessage(`ℹ️ <b>Không có dữ liệu ${title} — ${escapeHtml(range.label)}</b>\nAMIS báo "Không có dữ liệu" cho kỳ này (không phải lỗi).`);
      await progress.finish(true);
      return { message: null };
    }
    if (ds.error || ds.missing) {
      await tg.sendMessage(`⚠️ <b>Không lấy được báo cáo ${title} — ${escapeHtml(range.label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null, failed: true };
    }
    const updatedAt = ds.file ? vnTime(fs.statSync(ds.file).mtimeMs) : '';
    const message = [
      buildDebtMessage({ kind: kindKey, label: range.label, period, targetDb: dbLabel(config), dataset: ds, updatedAt }),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, {
      reply_markup: { inline_keyboard: [[
        { text: '🔄 Làm mới số liệu này', callback_data: refreshButton(config, range, [], REFRESH_PREFIX[mode]) },
        { text: '📅 Chọn kỳ khác', callback_data: `${MODE_PREFIX[mode]}:menu` },
      ]] },
    });
    for (const f of fs.existsSync(config.dirs.downloads) ? fs.readdirSync(config.dirs.downloads) : []) {
      const full = path.join(config.dirs.downloads, f);
      if (f.startsWith('cong_no_phai_') && Date.now() - fs.statSync(full).mtimeMs > 2 * 864e5) fs.rmSync(full, { force: true });
    }
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Quỹ tiền: xuất 2 báo cáo trong cùng một phiên AMIS (sổ quỹ tiền mặt + bảng kê số dư ngân hàng). */
export async function handleCash(config, tg, range, { fresh = false, headed } = {}) {
  const period = { fromDate: range.fromDate, toDate: range.toDate, today: resolvePeriod('today').today };
  const ids = ['quy_tien_mat', 'so_du_ngan_hang'];
  const suffix = `__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}`;
  const fileKeys = Object.fromEntries(ids.map((id) => [id, `${id}${suffix}`]));
  const reuse = !fresh && ids.every((id) => fileAgeMinutes(config, fileKeys[id]) <= config.bot.maxDataAgeMinutes);
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo quỹ tiền — ${range.label}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period, sourceIds: ids, fileKeys });
    await progress.stage('send');
    const view = (id) => { const ds = data.datasets[id]; return ds.error?.includes('NO_DATA') ? { noData: true } : ds.missing ? { error: 'chưa có dữ liệu' } : ds; };
    const cash = view(ids[0]), bank = view(ids[1]);
    const failed = [cash, bank].some((d) => d.error);
    const file = data.datasets[ids[1]].file ?? data.datasets[ids[0]].file;
    const updatedAt = file ? vnTime(fs.statSync(file).mtimeMs) : '';
    const message = [
      buildCashMessage({ label: range.label, period, targetDb: dbLabel(config), cash, bank, updatedAt }),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, {
      reply_markup: { inline_keyboard: [[
        { text: '🔄 Làm mới số liệu này', callback_data: refreshButton(config, range, [], REFRESH_PREFIX.cash) },
        { text: '📅 Chọn kỳ khác', callback_data: `${MODE_PREFIX.cash}:menu` },
      ]] },
    });
    for (const f of fs.existsSync(config.dirs.downloads) ? fs.readdirSync(config.dirs.downloads) : []) {
      const full = path.join(config.dirs.downloads, f);
      if (ids.some((id) => f.startsWith(`${id}__`)) && Date.now() - fs.statSync(full).mtimeMs > 2 * 864e5) fs.rmSync(full, { force: true });
    }
    await progress.finish(!failed);
    return { message, failed };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

// ---- Báo cáo cuối ngày: 7 báo cáo AMIS trong 1 lần đăng nhập → 1 tin tóm tắt ----
const DAILY_SOURCES = { cash: 'quy_tien_mat', bank: 'so_du_ngan_hang', sales: 'doanh_so', salesKh: 'doanh_so_kh', ar: 'cong_no_phai_thu', ap: 'cong_no_phai_tra', stock: 'ton_kho_nhom' };
export async function handleDaily(config, tg, { fresh = false, headed, date } = {}) {
  const today = date ?? resolvePeriod('today').today;
  const period = { fromDate: today, toDate: today, today };
  const suffix = `__${today.replace(/\//g, '-')}_${today.replace(/\//g, '-')}`;
  // cùng tên file với từng báo cáo lẻ → bấm xem chi tiết ngay sau đó sẽ dùng lại, không phải xuất lại
  const fileKeys = Object.fromEntries(Object.values(DAILY_SOURCES).map((id) => [id, `${id === 'ton_kho_nhom' ? 'ton_kho' : id}${suffix}`]));
  const ids = Object.values(DAILY_SOURCES);
  const reuse = !fresh && ids.every((id) => fileAgeMinutes(config, fileKeys[id]) <= config.bot.maxDataAgeMinutes);
  const stages = [...(reuse ? ['reuse'] : ['login', 'exportDaily']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo cuối ngày ${today}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s === 'export' ? 'exportDaily' : s), period, sourceIds: ids, fileKeys, vars: { groups: '' } });
    const ds = Object.fromEntries(Object.entries(DAILY_SOURCES).map(([k, id]) => [k, data.datasets[id]]));
    // luỹ kế năm theo mặt hàng: xuất thêm doanh số 01/01 → hôm nay (dùng lại phiên AMIS đang mở)
    const ytdFrom = `01/01/${today.slice(-4)}`;
    const ytdKey = `doanh_so__${ytdFrom.replace(/\//g, '-')}_${today.replace(/\//g, '-')}`;
    const ytdReuse = !fresh && fileAgeMinutes(config, ytdKey) <= config.bot.maxDataAgeMinutes;
    const ytd = await collect(config, { download: !ytdReuse, headed, tg, log: () => {}, period: { fromDate: ytdFrom, toDate: today, today }, sourceIds: ['doanh_so'], fileKeys: { doanh_so: ytdKey }, vars: { groups: '' } })
      .catch((e) => ({ datasets: { doanh_so: { error: e.message } } }));
    ds.salesYtd = ytd.datasets.doanh_so;
    await progress.stage('send');
    const files = Object.values(data.datasets).map((d) => d.file).filter(Boolean);
    const updatedAt = files.length ? vnTime(Math.min(...files.map((f) => fs.statSync(f).mtimeMs))) : '';
    const failed = Object.values(ds).some((d) => !d || (d.error && !d.error.includes('NO_DATA')) || d.missing);
    const message = [
      buildDailyMessage({ date: today, targetDb: dbLabel(config), ds, updatedAt, brand: config.brand }),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, {
      reply_markup: { inline_keyboard: [
        [{ text: '💵 Quỹ tiền', callback_data: 'm:today' }, { text: '💰 DS mặt hàng', callback_data: 's:today' }, { text: '👥 DS khách', callback_data: 'h:today' }],
        [{ text: '🧾 Phải thu', callback_data: 'p:today' }, { text: '🏭 Phải trả', callback_data: 'q:today' }, { text: '📊 Tồn kho', callback_data: 'k:today' }],
        [{ text: '🔄 Làm mới báo cáo cuối ngày', callback_data: 'z:dailyfresh' }],
      ] },
    });
    await progress.finish(!failed);
    return { message, failed };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Mili-giây tới lần `hh:mm` giờ Việt Nam kế tiếp. */
export function msUntilVn(hhmm, now = Date.now()) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const vnNow = new Date(now + 7 * 3600e3);
  let target = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), h, m) - 7 * 3600e3;
  if (target <= now + 1000) target += 864e5;
  return target - now;
}

/** Kết quả hoạt động kinh doanh (B02): CHỈ chủ bot, CHỈ trong chat riêng — chặn tại đây để mọi đường vào đều bị kiểm. */
export async function handleIncome(config, tg, range, { fresh = false, headed, ownerPrivate = false } = {}) {
  if (!ownerPrivate || String(tg.chatId) !== String(config.secrets.telegramChatId)) { await tg.sendMessage(FIN_DENIED); return { message: null }; }
  const period = { fromDate: range.fromDate, toDate: range.toDate, today: resolvePeriod('today').today };
  const fileKey = `kqkd__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}`;
  const reuse = !fresh && fileAgeMinutes(config, fileKey) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo kết quả kinh doanh — ${range.label}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period, sourceIds: ['kqkd'], fileKeys: { kqkd: fileKey } });
    await progress.stage('send');
    const ds = data.datasets.kqkd;
    if (ds.error || ds.missing) {
      await tg.sendMessage(`⚠️ <b>Không lấy được báo cáo kết quả kinh doanh — ${escapeHtml(range.label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null, failed: true };
    }
    const updatedAt = ds.file ? vnTime(fs.statSync(ds.file).mtimeMs) : '';
    const message = [buildIncomeMessage({ label: range.label, period, targetDb: dbLabel(config), dataset: ds, updatedAt }), supervisionSection(data.supervision, data.blocked)].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, { reply_markup: { inline_keyboard: [[
      { text: '🔄 Làm mới số liệu này', callback_data: refreshButton(config, range, [], REFRESH_PREFIX.fin) },
      { text: '📅 Chọn kỳ khác', callback_data: `${MODE_PREFIX.fin}:menu` },
    ]] } });
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Chi phí: CHỈ chủ bot, CHỈ chat riêng. Xuất Bảng cân đối tài khoản cho kỳ này và kỳ trước (cùng 1 phiên AMIS). */
export async function handleCost(config, tg, range, { fresh = false, headed, ownerPrivate = false } = {}) {
  if (!ownerPrivate || String(tg.chatId) !== String(config.secrets.telegramChatId)) { await tg.sendMessage(FIN_DENIED); return { message: null }; }
  const today = resolvePeriod('today').today;
  const prevR = previousRange(range.fromDate, range.toDate);
  const key = (r) => `can_doi_tk__${r.fromDate.replace(/\//g, '-')}_${r.toDate.replace(/\//g, '-')}`;
  const need = (r) => fresh || fileAgeMinutes(config, key(r)) > config.bot.maxDataAgeMinutes;
  const reuse = !need(range) && !need(prevR);
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo chi phí — ${range.label}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const get = (r, stage) => collect(config, { download: need(r), headed, tg, log: () => {}, onStage: stage ? (s) => progress.stage(s) : () => {}, period: { ...r, today }, sourceIds: ['can_doi_tk'], fileKeys: { can_doi_tk: key(r) } });
    const a = await get(range, true);
    const b = await get(prevR, false).catch(() => null);
    await progress.stage('send');
    const ds = a.datasets.can_doi_tk;
    if (ds.error || ds.missing) {
      await tg.sendMessage(`⚠️ <b>Không lấy được báo cáo chi phí — ${escapeHtml(range.label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null, failed: true };
    }
    const pd = b?.datasets.can_doi_tk;
    const prev = pd && !pd.error && !pd.missing ? summarizeCost(pd) : null;
    const updatedAt = ds.file ? vnTime(fs.statSync(ds.file).mtimeMs) : '';
    const cur = summarizeCost(ds);
    const message = [buildCostMessage({ label: range.label, period: range, prevPeriod: prevR, targetDb: dbLabel(config), cur, prev, updatedAt }), supervisionSection(a.supervision, a.blocked)].filter(Boolean).join('\n\n');
    const dd = (x) => x.replace(/\//g, '');
    const voucherRows = COST_ACCOUNTS.filter(([k]) => Math.round(cur.items[k])).map(([k, icon, name]) => [{ text: `${icon} ${name.replace(/ \(.*\)$/, '')} — xem chứng từ`, callback_data: `y:v:${k}:${dd(range.fromDate)}:${dd(range.toDate)}` }]);
    await tg.sendMessage(message, { reply_markup: { inline_keyboard: [...voucherRows, [
      { text: '🔄 Làm mới số liệu này', callback_data: refreshButton(config, range, [], REFRESH_PREFIX.cost) },
      { text: '📅 Chọn kỳ khác', callback_data: `${MODE_PREFIX.cost}:menu` },
    ]] } });
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Chứng từ của 1 khoản chi phí (bấm từ báo cáo Chi phí). CHỈ chủ bot, CHỈ chat riêng. Kèm file Excel đầy đủ. */
export async function handleCostVouchers(config, tg, account, range, { fresh = false, headed, ownerPrivate = false } = {}) {
  if (!ownerPrivate || String(tg.chatId) !== String(config.secrets.telegramChatId)) { await tg.sendMessage(FIN_DENIED); return { message: null }; }
  const name = COST_ACCOUNTS.find(([k]) => k === account)?.[2] ?? account;
  const key = Object.keys(PERIOD_LABELS).find((k) => { const p = resolvePeriod(k); return p.fromDate === range.fromDate && p.toDate === range.toDate; });
  const label = range.label ?? (key ? PERIOD_LABELS[key] : `${range.fromDate} – ${range.toDate}`);
  const fileKey = `so_chi_tiet_tk__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}`;
  const reuse = !fresh && fileAgeMinutes(config, fileKey) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lấy chứng từ ${name} (${account}) — ${label}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period: { ...range, today: resolvePeriod('today').today }, sourceIds: ['so_chi_tiet_tk'], fileKeys: { so_chi_tiet_tk: fileKey } });
    const ds = data.datasets.so_chi_tiet_tk;
    const srcs = (ds.files ?? [ds.file]).filter((f) => f && fs.existsSync(f));
    if (!srcs.length) {
      await tg.sendMessage(`⚠️ <b>Không lấy được sổ chi tiết tài khoản — ${escapeHtml(label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null, failed: true };
    }
    const ledger = new Map();
    for (const f of srcs) for (const [k, v] of await readLedger(f)) ledger.set(k, [...(ledger.get(k) ?? []), ...v]); // nhiều sổ: nối chứng từ
    const vouchers = expenseVouchers(ledger, account);
    await progress.stage('send');
    const message = buildVoucherMessage({ account, name, label, period: range, vouchers });
    await tg.sendMessage(message);
    if (vouchers.length) {
      const xlsx = path.join(config.dirs.output, `chung-tu-${account}-${fileKey.split('__')[1]}.xlsx`);
      await writeVoucherWorkbook(xlsx, { account, name, period: range, vouchers });
      await tg.sendFile(xlsx, `📎 Đủ ${vouchers.length} chứng từ ${name} (${account}) — ${label}`).catch((e) => console.error(`Không gửi được file chứng từ: ${e.message}`));
      fs.rmSync(xlsx, { force: true });
    }
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

export async function handleStock(config, tg, range, { fresh = false, headed, groups = [] } = {}) {
  const period = { fromDate: range.fromDate, toDate: range.toDate, today: resolvePeriod('today').today };
  const fileKey = `ton_kho__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}${groups.length ? `__${groupsKey(groups)}` : ''}`;
  const reuse = !fresh && fileAgeMinutes(config, fileKey) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo tồn kho — ${range.label}${groups.length ? ` (${groups.join(', ')})` : ''}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period, sourceIds: ['ton_kho_nhom'], fileKeys: { ton_kho_nhom: fileKey }, vars: { groups: groups.join('|') } });
    await progress.stage('send');
    const ds = data.datasets.ton_kho_nhom;
    if (ds.error?.includes('NO_DATA')) {
      await tg.sendMessage(`ℹ️ <b>Không có dữ liệu tồn kho — ${escapeHtml(range.label)}</b>${groups.length ? `\n📦 Nhóm VTHH: ${escapeHtml(groups.join(', '))}` : ''}\nAMIS báo "Không có dữ liệu" cho kỳ và nhóm này (không phải lỗi).`);
      await progress.finish(true);
      return { message: null };
    }
    if (ds.error || ds.missing) {
      await tg.sendMessage(`⚠️ <b>Không lấy được báo cáo tồn kho — ${escapeHtml(range.label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null, failed: true };
    }
    const updatedAt = ds.file ? vnTime(fs.statSync(ds.file).mtimeMs) : '';
    const message = [
      buildStockMessage({ label: range.label, period, targetDb: dbLabel(config), dataset: ds, updatedAt, groups }),
      scopeNoteText(ds),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, {
      reply_markup: { inline_keyboard: [[
        { text: '🔄 Làm mới số liệu này', callback_data: refreshButton(config, range, groups, 'u') },
        { text: '📅 Chọn kỳ khác', callback_data: 'k:menu' },
      ]] },
    });
    for (const f of fs.existsSync(config.dirs.downloads) ? fs.readdirSync(config.dirs.downloads) : []) {
      const full = path.join(config.dirs.downloads, f);
      if (f.startsWith('ton_kho__') && Date.now() - fs.statSync(full).mtimeMs > 2 * 864e5) fs.rmSync(full, { force: true });
    }
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Gộp các dòng (khách × mặt hàng) thành 1 dòng mỗi khách, cộng các cột số. */
export function sumByCustomer(rows) {
  const m = new Map();
  for (const r of rows) {
    const x = m.get(r.ma_kh);
    if (!x) { m.set(r.ma_kh, { ...r }); continue; }
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number') x[k] = (x[k] ?? 0) + v;
  }
  return [...m.values()];
}

export async function handleSales(config, tg, range, { fresh = false, headed, groups = [], by = 'item' } = {}) {
  const cust = by === 'customer';
  // AMIS "theo khách hàng" không có ô lọc Nhóm VTHH → khi chọn nhóm dùng báo cáo "theo mặt hàng và khách hàng" rồi cộng theo khách
  const sourceId = cust ? (groups.length ? 'doanh_so_kh_nhom' : 'doanh_so_kh') : 'doanh_so';
  const what = cust ? 'doanh số theo khách hàng' : 'doanh số theo mặt hàng';
  const period = { fromDate: range.fromDate, toDate: range.toDate, today: resolvePeriod('today').today };
  const fileKey = `${sourceId}__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}${groups.length ? `__${groupsKey(groups)}` : ''}`;
  const reuse = !fresh && fileAgeMinutes(config, fileKey) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo ${what} — ${range.label}${groups.length ? ` (${groups.join(', ')})` : ''}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period, sourceIds: [sourceId], fileKeys: { [sourceId]: fileKey }, vars: { groups: groups.join('|') } });
    await progress.stage('send');
    let ds = data.datasets[sourceId];
    if (sourceId === 'doanh_so_kh_nhom' && ds.rows) ds = { ...ds, rows: sumByCustomer(ds.rows) };
    if (ds.error?.includes('NO_DATA')) {
      await tg.sendMessage(`ℹ️ <b>Không có ${what} — ${escapeHtml(range.label)}</b>${groups.length ? `\n📦 Nhóm VTHH: ${escapeHtml(groups.join(', '))}` : ''}\nAMIS báo "Không có dữ liệu" cho kỳ${groups.length ? ' và nhóm' : ''} này (không phải lỗi).`);
      await progress.finish(true);
      return { message: null };
    }
    if (ds.error || ds.missing) {
      await tg.sendMessage(`⚠️ <b>Không lấy được báo cáo ${what} — ${escapeHtml(range.label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null, failed: true };
    }
    const updatedAt = ds.file ? vnTime(fs.statSync(ds.file).mtimeMs) : '';
    const message = [
      buildSalesMessage({ label: range.label, period, targetDb: dbLabel(config), dataset: ds, updatedAt, groups, by }),
      scopeNoteText(ds),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, {
      reply_markup: { inline_keyboard: [[
        { text: '🔄 Làm mới số liệu này', callback_data: refreshButton(config, range, groups, cust ? 'j' : 'r') },
        { text: '📅 Chọn kỳ khác', callback_data: cust ? 'h:menu' : 's:menu' },
      ]] },
    });
    // dọn các file doanh số theo kỳ đã cũ (> 2 ngày)
    for (const f of fs.existsSync(config.dirs.downloads) ? fs.readdirSync(config.dirs.downloads) : []) {
      const full = path.join(config.dirs.downloads, f);
      if ((f.startsWith('doanh_so__') || f.startsWith('doanh_so_kh__') || f.startsWith('doanh_so_kh_nhom__')) && Date.now() - fs.statSync(full).mtimeMs > 2 * 864e5) fs.rmSync(full, { force: true });
    }
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Xử lý lần bấm nút inline của bot: s:<kỳ> chọn kỳ doanh số, r:<từ>:<đến> làm mới. */
export async function handleCallbackData(config, tg, data, opts = {}) {
  const state = opts.state ?? defaultState;
  const [kind, a, b, c] = String(data).split(':');
  if (['f', 'e', 'y', 'o'].includes(kind) && !opts.ownerPrivate) return tg.sendMessage(FIN_DENIED);
  if (kind === 'y' && a === 'v') { // y:v:<TK>:<từ ddmmyyyy>:<đến ddmmyyyy> — chứng từ của 1 khoản chi phí
    const [, , acc, f, t] = String(data).split(':');
    const d = (x) => `${x.slice(0, 2)}/${x.slice(2, 4)}/${x.slice(4)}`;
    if (!COST_ACCOUNTS.some(([k]) => k === acc) || !/^\d{8}$/.test(f ?? '') || !/^\d{8}$/.test(t ?? '')) return tg.sendMessage('Yêu cầu không hợp lệ.');
    return handleCostVouchers(config, tg, acc, { fromDate: d(f), toDate: d(t) }, opts);
  }
  if (PREFIX_MODE[kind]) {
    const mode = PREFIX_MODE[kind];
    if (a === 'menu') return sendPeriodPicker(tg, '', mode, state);
    state.mode = mode;
    if (a === 'custom') {
      state.awaitingRange = Date.now(); // vẫn cho phép gõ tay khoảng ngày
      return sendCalendar(tg, state);
    }
    if (a === 'mon' && +b >= 1 && +b <= 12) return beginSales(config, tg, monthRange(+b), { ...opts, mode });
    if (PERIOD_LABELS[a]) return beginSales(config, tg, periodOf(a), { ...opts, mode });
    return tg.sendMessage('Lựa chọn không hợp lệ.');
  }
  if (kind === 'z') {
    if (a === 'check') return handleReport(config, tg, { ...opts, fresh: false });
    if (a === 'daily') return handleDaily(config, tg, opts);
    if (a === 'dailyfresh') return handleDaily(config, tg, { ...opts, fresh: true });
    return tg.sendMessage(helpText(config), { reply_markup: MENU });
  }
  if (kind === 'c') {
    const range = await applyCalendar(tg, state, data, opts.messageId);
    return range ? beginSales(config, tg, range, opts) : undefined;
  }
  if (kind === 'g') {
    const run = await applyGroupPick(tg, state, data, opts.messageId);
    return run ? runReport(config, tg, run.mode, run.range, { ...opts, groups: run.groups }) : undefined;
  }
  if (REFRESH_MODE[kind]) {
    const d = (x) => `${x.slice(0, 2)}/${x.slice(2, 4)}/${x.slice(4)}`;
    if (!/^\d{8}$/.test(a ?? '') || !/^\d{8}$/.test(b ?? '')) return tg.sendMessage('Yêu cầu làm mới không hợp lệ.');
    const fromDate = d(a), toDate = d(b);
    const key = Object.keys(PERIOD_LABELS).find((k) => resolvePeriod(k).fromDate === fromDate && resolvePeriod(k).toDate === toDate);
    const all = loadGroups(config);
    const groups = (c ?? '').split('-').filter((x) => /^\d+$/.test(x)).map((x) => all[Number(x)]?.code).filter(Boolean);
    return runReport(config, tg, REFRESH_MODE[kind], { fromDate, toDate, label: key ? PERIOD_LABELS[key] : `${fromDate} – ${toDate}` }, { ...opts, fresh: true, groups });
  }
  return tg.sendMessage('Lệnh không hợp lệ.');
}

/** Diễn giải lỗi cho người dùng: lỗi kỹ thuật tiếng Anh → câu dễ hiểu, kèm chi tiết gốc để gửi người phụ trách. */
export function friendlyError(e) {
  const msg = describeAiError(e) || String(e);
  if (e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError) return `Lỗi trong chương trình của bot (không phải do AMIS hay do bạn). Nếu thử lại vẫn lỗi, hãy chụp màn hình này gửi người phụ trách.\nChi tiết: ${msg}`;
  if (/timeout|timed out|hết thời gian|hết \d+s/i.test(msg)) return `AMIS phản hồi chậm hoặc mạng chập chờn.\nChi tiết: ${msg}`;
  if (/fetch failed|ECONN|ENOTFOUND|net::/i.test(msg)) return `Mất kết nối mạng tới AMIS/Telegram.\nChi tiết: ${msg}`;
  return msg;
}

const timingsFile = (config) => path.join(config.dirs.output, 'thoi-gian.json');

async function handleReport(config, tg, { fresh, headed }) {
  const reuse = !fresh && dataAgeMinutes(config) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'expert', 'review', 'send'];
  const progress = new Progress(tg, { title: 'Đang lập báo cáo đối chiếu…', stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    await runPipeline(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s) });
    await progress.finish(true);
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Chế độ không dùng AI: tra cứu trực tiếp số liệu, không có agent nào can thiệp vào con số. */
async function handleRuleQuestion(config, tg, question, { headed } = {}) {
  const reuse = dataAgeMinutes(config) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: 'Đang tra cứu số liệu…', stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s) });
    await progress.stage('send');
    const answer = answerByRules(question, data.datasets);
    const message = answer
      ? [`💬 <b>${escapeHtml(question)}</b>`, answer, `<i>Tra cứu trực tiếp từ số liệu AMIS kỳ ${data.period.fromDate} – ${data.period.toDate}${reuse ? ' (dùng lại lần xuất gần nhất)' : ''}, không qua AI.</i>`, supervisionSection(data.supervision, data.blocked)].filter(Boolean).join('\n\n')
      : `Chưa hiểu câu hỏi này.\n\n${RULE_HELP}`;
    await tg.sendMessage(message);
    await progress.finish(true);
    return { message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

export async function handleQuestion(config, tg, question, { headed } = {}) {
  if (!aiEnabled(config.ai)) return handleRuleQuestion(config, tg, question, { headed });
  const reuse = dataAgeMinutes(config) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'answer', 'expert', 'review', 'send'];
  const progress = new Progress(tg, { title: 'Đang xử lý câu hỏi của bạn…', stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s) });
    let draft, review, feedback;
    for (let round = 1; ; round++) {
      await progress.stage('answer');
      draft = await draftAnswer(config.ai, { question, facts: data.facts, datasets: data.datasets, feedback });
      await progress.stage('expert');
      const finalized = await finalizeAnswer(config.ai, { question, draft: draft.text, facts: data.facts, datasets: data.datasets, feedback });
      draft = { ...draft, text: finalized.text };
      await progress.stage('review');
      review = await reviewDraft(config.ai, { draft: draft.text, facts: { ...data.facts, bang_du_lieu: tablesFor(data.datasets) }, question });
      if (review.status !== 'khong_dat' || round >= config.bot.maxReviewRounds) break;
      feedback = review.sai_sot; // kế toán trưởng trả lại → trợ lý soạn lại
    }
    await progress.stage('send');
    const head = review.status === 'khong_dat'
      ? '⛔ <b>Câu trả lời dưới đây CHƯA được kế toán trưởng chấp nhận — chỉ để tham khảo, cần kiểm tra lại trên AMIS.</b>\n\n' : '';
    const message = [
      `${head}💬 <b>${escapeHtml(question)}</b>\n\n${escapeHtml(draft.text)}`,
      `<i>Số liệu AMIS kỳ ${data.period.fromDate} – ${data.period.toDate}${reuse ? ' (dùng lại lần xuất gần nhất)' : ''}</i>`,
      reviewSection(review),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message);
    await progress.finish(true);
    return { draft, review, message };
  } catch (e) {
    await progress.finish(false);
    throw e;
  }
}

/** Kế toán trưởng cần cả bảng dữ liệu để đối chiếu câu trả lời về từng mã hàng. */
function tablesFor(datasets) {
  return Object.fromEntries(Object.values(datasets).filter((d) => d.rows?.length).map((d) => [d.name, d.rows]));
}

const defaultState = { awaitingRange: null, cal: null, pick: null, mode: 'sales' };
const AWAIT_MS = 10 * 60 * 1000;

export async function handleUpdate(config, tg, text, opts = {}) {
  const state = opts.state ?? defaultState;
  text = (BTN_TO_CMD[text.trim()] ?? text).trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');

  // đang chờ người dùng gõ khoảng ngày tuỳ chọn
  if (state.awaitingRange && Date.now() - state.awaitingRange > AWAIT_MS) state.awaitingRange = null;
  if (state.awaitingRange) {
    if (cmd.startsWith('/')) { state.awaitingRange = null; state.cal = null; } // bấm lệnh/nút khác → thôi chờ
    else if (/^(huy|huỷ|hủy|thoi|cancel)$/i.test(text.normalize('NFC'))) { state.awaitingRange = null; state.cal = null; return tg.sendMessage('Đã huỷ chọn ngày.', { reply_markup: MENU }); }
    else {
      const r = parseDateRange(text);
      if (r.error) return tg.sendMessage(`⚠️ ${escapeHtml(r.error)}\nGõ <i>huỷ</i> để thôi.`);
      state.awaitingRange = null; state.cal = null;
      return beginSales(config, tg, { fromDate: r.from, toDate: r.to, label: r.from === r.to ? r.from : `${r.from} – ${r.to}` }, opts);
    }
  }

  if (cmd === '/start') { await sendDashboard(config, tg, { ownerPrivate: opts.ownerPrivate }); return tg.sendMessage('⌨️ Bàn phím báo cáo đã sẵn sàng bên dưới.', { reply_markup: opts.ownerPrivate ? MENU_OWNER : MENU }); }
  if (cmd === '/help' || cmd === '/trogiup') return tg.sendMessage(helpText(config) + (opts.ownerPrivate ? '\n\n🔒 Riêng bạn: 📑 Kết quả KD (/ketqua) — báo cáo B02; 💸 Chi phí (/chiphi) — chi phí theo tài khoản, lợi nhuận ước tính. Đều so kỳ này với kỳ trước.' : ''), { reply_markup: opts.ownerPrivate ? MENU_OWNER : MENU });
  if (cmd === '/tonkho') return sendPeriodPicker(tg, '', 'stock', state);
  if (cmd === '/congnokh') return sendPeriodPicker(tg, '', 'ar', state);
  if (cmd === '/cuoingay') return handleDaily(config, tg, { ...opts, fresh: true });
  if (cmd === '/chiphi') return opts.ownerPrivate ? sendPeriodPicker(tg, '', 'cost', state) : tg.sendMessage(FIN_DENIED);
  if (cmd === '/ketqua') return opts.ownerPrivate ? sendPeriodPicker(tg, '', 'fin', state) : tg.sendMessage(FIN_DENIED);
  if (cmd === '/quytien') return sendPeriodPicker(tg, '', 'cash', state);
  if (cmd === '/congnoncc') return sendPeriodPicker(tg, '', 'ap', state);
  if (cmd === '/baocao') return handleReport(config, tg, { fresh: false, ...opts });
  if (cmd === '/moi') return handleReport(config, tg, { fresh: true, ...opts });
  if (cmd === '/capnhatnhom') {
    await tg.sendMessage('⏳ Đang đọc danh sách Nhóm VTHH từ AMIS (chỉ đọc)…');
    const list = await refreshGroups(config, { tg });
    return tg.sendMessage(`✅ Đã cập nhật <b>${list.length}</b> nhóm VTHH:\n${escapeHtml(list.map((g) => `${g.level ? '   ' : ''}${g.code}${g.name !== g.code ? ` — ${g.name}` : ''}`).join('\n'))}`);
  }
  if (cmd === '/doanhsokh') return sendPeriodPicker(tg, '', 'salesKh', state);
  if (cmd === '/doanhso') {
    const arg = text.slice(cmd.length).trim();
    const intent = arg ? parseSalesIntent(`doanh so ${arg}`) : { picker: true };
    state.mode = 'sales';
    return salesIntent(config, tg, intent, opts);
  }
  if (cmd.startsWith('/')) return tg.sendMessage('Lệnh không hỗ trợ. Gõ /trogiup để xem các lệnh.', { reply_markup: MENU });

  const intent = parseSalesIntent(text);
  if (intent) { state.mode = 'sales'; return salesIntent(config, tg, intent, opts); }
  return handleQuestion(config, tg, text, opts);
}

function salesIntent(config, tg, intent, opts) {
  if (intent?.key) return beginSales(config, tg, periodOf(intent.key), opts);
  if (intent?.custom) return beginSales(config, tg, { fromDate: intent.custom.from, toDate: intent.custom.to, label: intent.custom.from === intent.custom.to ? intent.custom.from : `${intent.custom.from} – ${intent.custom.to}` }, opts);
  return sendPeriodPicker(tg, intent?.error ? `⚠️ ${escapeHtml(intent.error)}` : '', 'sales', opts.state ?? defaultState);
}

// ---- Quyền dùng bot: chat riêng của chủ bot + các nhóm chủ bot đã bật (gõ /start trong nhóm) ----
// Lưu ở data/telegram-access.json: { chats: [mã nhóm], users: [mã người được ra lệnh] }. Chủ bot luôn có quyền.
function accessFile(config) { return path.join(config.root ?? process.cwd(), 'data', 'telegram-access.json'); }
export function loadAccess(config) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(accessFile(config), 'utf8')); } catch { /* chưa có */ }
  const owner = String(config.secrets.telegramChatId);
  return {
    owner,
    chats: new Set([owner, ...(config.bot.groupChatIds ?? []), ...(saved.chats ?? [])].map(String)),
    users: new Set([owner, ...(config.bot.allowedUserIds ?? []), ...(saved.users ?? [])].map(String)),
    names: saved.names ?? {},
    tenants: saved.tenants ?? {}, // mã nhóm → công ty
  };
}
function saveAccess(config, acc) {
  const file = accessFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ chats: [...acc.chats].filter((c) => c !== acc.owner), users: [...acc.users].filter((u) => u !== acc.owner), names: acc.names, tenants: acc.tenants }, null, 2), { mode: 0o600 });
}
const personName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || String(u?.id);

export async function runBot(config, opts = {}) {
  const tg = telegramOf(config);
  const acc = loadAccess(config);
  const owner = acc.owner;
  // mỗi khung chat (riêng / nhóm) có Telegram + trạng thái riêng; chung hàng đợi vì chỉ có 1 phiên AMIS
  const ctxs = new Map();
  const ctx = (chatId) => {
    const id = String(chatId);
    if (!ctxs.has(id)) {
      const t = id === String(tg.chatId) ? tg : telegramOf({ ...config, secrets: { ...config.secrets, telegramChatId: id } });
      t.waiters = tg.waiters; t.pollerActive = true; // dùng chung danh sách chờ quyết định "đăng nhập tiếp?"
      const st = { awaitingRange: null, cal: null, pick: null };
      ctxs.set(id, { tg: t, state: st, opts: { ...opts, state: st, ownerPrivate: id === owner } }); // chat riêng của chủ bot có mã = mã chủ bot
    }
    return ctxs.get(id);
  };
  const groups = () => [...acc.chats].filter((c) => c !== owner);
  // công ty của từng khung chat: chat riêng chủ bot đổi được (/congty); nhóm cố định theo access.tenants (mặc định: công ty mặc định)
  const cfgCache = new Map();
  const cfgOf = (chat) => {
    const st = ctx(chat).state;
    const id = st.tenant ?? acc.tenants?.[chat] ?? defaultTenantId(config);
    const k = `${id}:${st.branch ?? 0}`;
    if (!cfgCache.has(k)) cfgCache.set(k, scopeConfig(config, id, st.branch ?? 0));
    return cfgCache.get(k);
  };
  console.log(`Bot đang chạy (chỉ đọc). Trợ lý AI: ${aiEnabled(config.ai) ? 'bật' : 'tắt — thiếu ANTHROPIC_API_KEY'}. Nhóm đã bật: ${groups().length ? groups().map((g) => `${acc.names[g] ?? ''} (${g})`).join(', ') : 'chưa có'}. Nhấn Ctrl+C để dừng.`);
  await tg.setCommands(COMMANDS).catch((e) => console.error(`Không đăng ký được menu lệnh: ${e.message}`));
  if (config.bot.announceOnStart !== false) {
    const home = groups()[0] ?? owner; // đã có nhóm → chào trong nhóm
    const h = ctx(home).tg;
    await sendDashboard(cfgOf(home), h).catch(() => {});
    await h.sendMessage('🤖 <b>Bot đã sẵn sàng.</b> Bấm ô trên trang chủ hoặc dùng bàn phím bên dưới.', { reply_markup: MENU }).catch(() => {});
  }
  if (!opts.once) enableWarmSession(config.bot.keepSessionMinutes ?? 10);
  // ---- Bảo vệ: giới hạn tần suất, bỏ lệnh cũ, cảnh báo người lạ ----
  const limiter = new RateLimiter(config.bot.maxActionsPerMinute ?? 20, 60000);
  const STALE_SEC = config.bot.ignoreMessagesOlderThanSec ?? 300; // tin gửi lúc bot tắt quá lâu → bỏ, tránh chạy dồn lệnh cũ
  const alerted = new Map(); // khoá → thời điểm đã báo chủ bot (mỗi khoá tối đa 1 lần / 12 giờ)
  const alertOwner = (key, html) => {
    if (Date.now() - (alerted.get(key) ?? 0) < 12 * 3600e3) return;
    alerted.set(key, Date.now());
    if (alerted.size > 500) alerted.delete(alerted.keys().next().value);
    console.log(`CẢNH BÁO: ${html.replace(/<[^>]+>/g, '')}`);
    ctx(owner).tg.sendMessage(`🚨 <b>Cảnh báo bảo mật</b>\n${html}`).catch(() => {});
  };
  const botId = opts.once ? null : await tg.call('getMe', {}).then((m) => String(m.id), () => null);
  const describe = (u) => `<b>${escapeHtml(personName(u))}</b>${u?.username ? ` (@${escapeHtml(u.username)})` : ''} · mã ${u?.id}`;
  let offset;
  let busy = false;
  tg.pollerActive = true; // vòng lặp này nhận cả lần bấm nút (ví dụ quyết định đăng nhập tiếp)

  // Hàng đợi: chạy lần lượt (chung một phiên AMIS nên không chạy song song), tối đa MAX_QUEUE yêu cầu đang chờ.
  const MAX_QUEUE = config.bot.maxQueue ?? 5;
  const queue = [];
  const pump = () => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    job.work()
      .then((r) => (r?.failed ? offerRetry(job, '👆 Yêu cầu trên chưa lấy được số liệu.') : null))
      .catch((e) => { console.error(e); return offerRetry(job, `🚨 <b>Không xử lý được yêu cầu</b>\n${escapeHtml(friendlyError(e))}`); })
      .finally(() => { busy = false; pump(); });
  };
  // Nút "Thử lại" dưới tin lỗi: nhớ lại yêu cầu vừa hỏng (tối đa 20) để chạy lại đúng yêu cầu đó khi bấm.
  const retries = new Map();
  let retrySeq = 0;
  const offerRetry = (job, html) => {
    const id = String(++retrySeq);
    retries.set(id, job);
    if (retries.size > 20) retries.delete(retries.keys().next().value);
    return job.tg.sendMessage(`${html}\nBấm nút dưới đây để chạy lại đúng yêu cầu này.`, { reply_markup: { inline_keyboard: [[{ text: '🔁 Thử lại', callback_data: `t:${id}` }]] } }).catch(() => {});
  };
  const dispatch = (t, work) => {
    if (queue.length >= MAX_QUEUE) return t.sendMessage(`⏳ Hàng đợi đã đầy (${MAX_QUEUE} yêu cầu đang chờ). Vui lòng chờ bớt rồi gửi lại.`).catch(() => {});
    if (busy) t.sendMessage(`🕒 Đã xếp hàng — còn ${queue.length + 1} yêu cầu đang chờ sau yêu cầu hiện tại, bot sẽ làm lần lượt và gửi kết quả theo thứ tự.`).catch(() => {});
    queue.push({ tg: t, work });
    pump();
  };

  // Gửi tự động báo cáo cuối ngày (mặc định 17:30 giờ Việt Nam; bot.dailyReport.enabled = false để tắt).
  // Có nhóm → gửi vào nhóm; chưa có → gửi chat riêng của chủ bot.
  const daily = { enabled: true, time: '17:30', ...(config.bot.dailyReport ?? {}) };
  if (daily.enabled && !opts.once) {
    const plan = () => {
      const wait = msUntilVn(daily.time);
      console.log(`Báo cáo cuối ngày: gửi lúc ${daily.time} (sau ${Math.round(wait / 60000)} phút)`);
      setTimeout(() => {
        const targets = groups().length ? groups() : [owner];
        targets.forEach((chat) => { const c = ctx(chat); dispatch(c.tg, () => handleDaily(cfgOf(chat), c.tg, { ...c.opts, fresh: true })); });
        plan();
      }, wait).unref?.();
    };
    plan();
  }

  for (;;) {
    let updates = [];
    try { updates = await tg.getUpdates(offset, config.bot.pollSeconds ?? 50); }
    catch (e) { console.error(`Lỗi lấy tin nhắn: ${e.message}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      const cq = u.callback_query;
      if (cq) {
        const chat = String(cq.message?.chat?.id ?? '');
        const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
        if (!acc.chats.has(chat)) { await answer('Nhóm này chưa được bật bot.'); continue; }
        if (!acc.users.has(String(cq.from?.id))) { await answer('Bạn chỉ được xem. Nhờ chủ bot cấp quyền (/themnguoi) để bấm nút.'); continue; }
        { const rl = limiter.check(String(cq.from?.id)); if (rl !== 'ok') { await answer(rl === 'warn' ? 'Bạn thao tác quá nhanh, chờ 1 phút rồi thử lại.' : undefined); continue; } }
        const { tg: t, state: st, opts: o } = ctx(chat);
        if (/^c:/.test(cq.data ?? '')) {
          await answer();
          const range = await applyCalendar(t, st, cq.data, cq.message.message_id).catch(() => null); // chỉ sửa giao diện → làm ngay cả khi bot đang bận
          if (range) dispatch(t, () => beginSales(cfgOf(chat), t, range, o));
        } else if (/^g:/.test(cq.data ?? '')) {
          await answer();
          const run = await applyGroupPick(t, st, cq.data, cq.message.message_id).catch(() => null);
          if (run) dispatch(t, () => runReport(cfgOf(chat), t, run.mode, run.range, { ...o, groups: run.groups }));
        } else if (/^t:/.test(cq.data ?? '')) {
          await answer();
          const job = retries.get(cq.data.slice(2));
          if (job) dispatch(job.tg, job.work);
          else await t.sendMessage('Nút thử lại này đã hết hạn (bot vừa khởi động lại). Hãy bấm lại nút báo cáo.').catch(() => {});
        } else if (/^z:(co|br)/.test(cq.data ?? '')) { // trang tổng / chọn chi nhánh: chỉ chủ bot trong chat riêng
          await answer();
          if (chat !== owner) { await t.sendMessage('Chỉ chủ bot chọn được công ty / chi nhánh, trong chat riêng với bot.').catch(() => {}); continue; }
          const [, kind2, tid, bi] = cq.data.split(':');
          const ten = tid === SYSTEM_ID ? { id: SYSTEM_ID } : tenantsOf(config).find((x) => x.id === tid);
          if (kind2 === 'br' && ten && (+bi === 0 || ten.branches?.[+bi])) {
            Object.assign(ctx(chat).state, { tenant: tid, branch: +bi || 0 });
            await sendDashboard(cfgOf(chat), t, { ownerPrivate: true }).catch(() => {});
          } else await sendCompanyDashboard(config, t).catch(() => {});
        } else if (/^[skpqhjmnruvwzfeyo]:/.test(cq.data ?? '')) {
          await answer();
          dispatch(t, () => handleCallbackData(cfgOf(chat), t, cq.data, o));
        } else await t.handleCallback(cq).catch(() => {});
        continue;
      }
      const msg = u.message;
      if (!msg) continue;
      const chat = String(msg.chat.id);
      const from = String(msg.from?.id ?? '');
      if (msg.date && Date.now() / 1000 - msg.date > STALE_SEC) continue; // lệnh cũ dồn lại lúc bot tắt
      // bot bị người KHÁC chủ bot kéo vào nhóm → rời nhóm ngay và báo chủ bot
      if (botId && msg.new_chat_members?.some((m) => String(m.id) === botId) && from !== owner && !acc.chats.has(chat)) {
        await tg.call('leaveChat', { chat_id: msg.chat.id }).catch(() => {});
        alertOwner(`join${chat}`, `${describe(msg.from)} vừa kéo bot vào nhóm <b>${escapeHtml(msg.chat.title ?? chat)}</b>. Bot đã tự rời nhóm.\nNếu đây là nhóm của bạn: hãy tự thêm bot rồi gõ /start trong nhóm.`);
        continue;
      }
      // nhóm thường được Telegram nâng lên siêu nhóm → mã nhóm đổi, giữ quyền cho mã mới
      if (msg.migrate_to_chat_id && acc.chats.has(chat)) {
        const nid = String(msg.migrate_to_chat_id);
        acc.chats.delete(chat); acc.chats.add(nid); acc.names[nid] = acc.names[chat]; delete acc.names[chat]; saveAccess(config, acc);
        console.log(`Nhóm ${chat} đổi mã thành ${nid}`);
        continue;
      }
      if (!msg.text) continue;
      const cmd = msg.text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
      if (!acc.chats.has(chat)) {
        // chỉ chủ bot bật được bot trong nhóm, bằng /start
        if (from === owner && cmd === '/start' && msg.chat.type !== 'private') {
          acc.chats.add(chat); acc.names[chat] = msg.chat.title ?? ''; saveAccess(config, acc);
          console.log(`Đã bật bot trong nhóm "${msg.chat.title}" (${chat})`);
          const t = ctx(chat).tg;
          await t.sendMessage(`✅ Đã bật bot trong nhóm <b>${escapeHtml(msg.chat.title ?? '')}</b>.\nMọi thành viên xem được báo cáo; chỉ người được cấp quyền mới bấm nút/ra lệnh. Báo cáo cuối ngày 17:30 sẽ gửi vào nhóm này.\nChủ bot cấp quyền cho ai: trả lời (reply) 1 tin của người đó bằng /themnguoi.`).catch(() => {});
          dispatch(t, () => handleUpdate(cfgOf(chat), t, '/start', ctx(chat).opts));
        } else if (msg.chat.type !== 'private') console.log(`Bỏ qua tin trong nhóm chưa bật: "${msg.chat.title}" (${chat})`);
        else if (!acc.users.has(from)) alertOwner(`dm${from}`, `Người lạ nhắn riêng cho bot: ${describe(msg.from)}.\nBot không trả lời và không cung cấp số liệu nào.`);
        continue;
      }
      const { tg: t, opts: o } = ctx(chat);
      // quản lý quyền (chỉ chủ bot): trả lời tin của 1 người bằng /themnguoi hoặc /boquyen
      if (cmd === '/themnguoi' || cmd === '/boquyen' || cmd === '/quyen' || cmd === '/tatnhom') {
        if (from !== owner) { await t.sendMessage('Chỉ chủ bot dùng được lệnh này.').catch(() => {}); continue; }
        const who = msg.reply_to_message?.from;
        if (cmd === '/quyen') {
          const list = [...acc.users].map((id) => `• ${escapeHtml(acc.names[`u${id}`] ?? (id === owner ? 'Chủ bot' : id))}`).join('\n');
          await t.sendMessage(`👥 <b>Người được ra lệnh cho bot</b>\n${list}\n\n🏢 Nhóm đã bật: ${groups().map((g) => escapeHtml(acc.names[g] || g)).join(', ') || 'chưa có'}`).catch(() => {});
        } else if (cmd === '/tatnhom') {
          if (chat === owner) { await t.sendMessage('Lệnh này dùng trong nhóm cần tắt.').catch(() => {}); continue; }
          acc.chats.delete(chat); saveAccess(config, acc);
          await t.sendMessage('⛔ Đã tắt bot trong nhóm này. Chủ bot gõ /start để bật lại.', { reply_markup: { remove_keyboard: true } }).catch(() => {});
        } else if (!who || who.is_bot) await t.sendMessage(`Hãy trả lời (reply) đúng 1 tin của người cần ${cmd === '/themnguoi' ? 'cấp' : 'bỏ'} quyền rồi gõ ${cmd}.`).catch(() => {});
        else if (String(who.id) === owner) await t.sendMessage('Chủ bot luôn có quyền.').catch(() => {});
        else {
          if (cmd === '/themnguoi') { acc.users.add(String(who.id)); acc.names[`u${who.id}`] = personName(who); } else acc.users.delete(String(who.id));
          saveAccess(config, acc);
          await t.sendMessage(cmd === '/themnguoi' ? `✅ <b>${escapeHtml(personName(who))}</b> đã được ra lệnh và bấm nút cho bot.` : `⛔ Đã bỏ quyền của <b>${escapeHtml(personName(who))}</b>.`).catch(() => {});
        }
        continue;
      }
      if (!acc.users.has(from)) continue; // thành viên chưa được cấp quyền: chỉ xem, bot không trả lời
      { const rl = limiter.check(from); if (rl !== 'ok') { if (rl === 'warn') await t.sendMessage('⏳ Bạn gửi lệnh quá nhanh. Chờ 1 phút rồi thử lại.').catch(() => {}); continue; } }
      // chủ bot, chat riêng, có nhiều công ty: /start, 🏠 Trang chủ, /congty → trang tổng công ty
      if (chat === owner && tenantsOf(config).length > 1 && (cmd === '/start' || cmd === '/congty' || msg.text.trim() === BTN.home)) { if (limiter.check(from) === 'ok') await sendCompanyDashboard(config, t).catch(() => {}); continue; }
      dispatch(t, () => handleUpdate(cfgOf(chat), t, msg.text, o));
    }
    if (opts.once) return;
  }
}
