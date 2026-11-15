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
import { loadGroups, groupsKey } from './groups.js';
import { escapeHtml, norm, parseDateRange, resolvePeriod, PERIOD_LABELS } from './util.js';
import fs from 'node:fs';
import path from 'node:path';

// ---- Bộ điều khiển mặc định trong Telegram ----
const BTN = {
  refresh: '🔄 Lấy báo cáo mới nhất',
  stock: '📊 Báo cáo tồn kho',
  sales: '💰 Doanh số theo mặt hàng',
  salesKh: '👥 Doanh số theo khách hàng',
  ar: '🧾 Công nợ khách hàng',
  ap: '🏭 Công nợ nhà cung cấp',
  help: '❓ Hướng dẫn',
};
const BTN_TO_CMD = { [BTN.refresh]: '/moi', [BTN.stock]: '/tonkho', [BTN.sales]: '/doanhso', [BTN.salesKh]: '/doanhsokh', [BTN.ar]: '/congnokh', [BTN.ap]: '/congnoncc', [BTN.help]: '/trogiup' };

/** Bàn phím cố định dưới ô nhập tin (luôn hiện cho tới khi bị gỡ). */
export const MENU = {
  keyboard: [[{ text: BTN.refresh }, { text: BTN.stock }], [{ text: BTN.sales }, { text: BTN.salesKh }], [{ text: BTN.ar }, { text: BTN.ap }], [{ text: BTN.help }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const COMMANDS = [
  { command: 'moi', description: 'Lấy báo cáo mới nhất (làm mới dữ liệu từ AMIS)' },
  { command: 'tonkho', description: 'Báo cáo tồn kho theo kỳ và Nhóm VTHH' },
  { command: 'baocao', description: 'Báo cáo đối chiếu (tồn kho với kiểm kê)' },
  { command: 'doanhso', description: 'Doanh số theo mặt hàng (kèm doanh thu, lãi gộp)' },
  { command: 'doanhsokh', description: 'Doanh số theo khách hàng (kèm doanh thu, lãi gộp)' },
  { command: 'congnokh', description: 'Công nợ khách hàng (phải thu, TK 131)' },
  { command: 'congnoncc', description: 'Công nợ nhà cung cấp (phải trả, TK 331)' },
  { command: 'capnhatnhom', description: 'Cập nhật danh sách Nhóm VTHH từ AMIS' },
  { command: 'trogiup', description: 'Hướng dẫn sử dụng' },
];

/** Bàn phím chọn kỳ: tiền tố s: cho báo cáo doanh số, k: cho báo cáo tồn kho. */
const MODE_PREFIX = { sales: 's', salesKh: 'h', stock: 'k', ar: 'p', ap: 'q' };
const PREFIX_MODE = Object.fromEntries(Object.entries(MODE_PREFIX).map(([m, p]) => [p, m]));
const REFRESH_PREFIX = { sales: 'r', salesKh: 'j', stock: 'u', ar: 'v', ap: 'w' };
const REFRESH_MODE = Object.fromEntries(Object.entries(REFRESH_PREFIX).map(([m, p]) => [p, m]));
const periodKeyboard = (mode = 'sales') => {
  const p = MODE_PREFIX[mode] ?? 's';
  return { inline_keyboard: [
    [{ text: 'Hôm nay', callback_data: `${p}:today` }, { text: 'Hôm qua', callback_data: `${p}:yesterday` }],
    [{ text: 'Tuần này', callback_data: `${p}:thisWeek` }, { text: 'Tháng này', callback_data: `${p}:thisMonth` }],
    [{ text: 'Tháng trước', callback_data: `${p}:lastMonth` }, { text: '📅 Tùy chọn ngày', callback_data: `${p}:custom` }],
  ] };
};

const helpText = (config) => `🤖 <b>Bot đối chiếu MISA AMIS</b> (chỉ đọc)
Dùng các nút dưới ô nhập tin:
${BTN.refresh} — vào AMIS lấy dữ liệu mới rồi gửi báo cáo đối chiếu
${BTN.stock} — tồn kho theo kỳ (Hôm nay · Hôm qua · Tuần này · Tháng này · Tháng trước · Tùy chọn ngày) và Nhóm VTHH: đầu kỳ, nhập, xuất, cuối kỳ, giá trị
${BTN.sales} — doanh số từng mặt hàng kèm doanh thu, lọc theo Nhóm VTHH: Hôm nay · Hôm qua · Tuần này · Tháng này · Tháng trước · Tùy chọn ngày
${BTN.salesKh} — doanh số từng khách hàng kèm doanh thu thuần, lãi gộp (cùng các kỳ như trên)
${BTN.ar} — công nợ phải thu (TK 131): dư đầu kỳ, phát sinh, dư cuối kỳ, top khách còn nợ
${BTN.ap} — công nợ phải trả (TK 331) theo nhà cung cấp
(Gõ tắt: /moi · /tonkho · /congnokh · /congnoncc · /baocao (đối chiếu) · /doanhso · /doanhso hôm qua · /doanhsokh)

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
  const list = mode === 'ar' || mode === 'ap' || mode === 'salesKh' ? [] : loadGroups(config); // công nợ không có bước chọn Nhóm VTHH
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
  const head = { stock: '📊 <b>Báo cáo tồn kho</b> (đầu kỳ, nhập, xuất, cuối kỳ, giá trị)', ar: '🧾 <b>Công nợ khách hàng</b> (phải thu, TK 131)', ap: '🏭 <b>Công nợ nhà cung cấp</b> (phải trả, TK 331)', salesKh: '👥 <b>Doanh số theo khách hàng</b> (kèm doanh thu thuần, lãi gộp)' }[mode] ?? '💰 <b>Doanh số theo mặt hàng</b> (kèm doanh thu thuần, lãi gộp)';
  await tg.sendMessage(`${note ? `${note}\n\n` : ''}${head}\nChọn kỳ cần xem:`, { reply_markup: periodKeyboard(mode) });
}

const runReport = (config, tg, mode, range, opts) => (mode === 'stock' ? handleStock(config, tg, range, opts) : mode === 'ar' || mode === 'ap' ? handleDebt(config, tg, mode, range, opts) : handleSales(config, tg, range, { ...opts, by: mode === 'salesKh' ? 'customer' : 'item' }));

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
      buildDebtMessage({ kind: kindKey, label: range.label, period, targetDb: config.secrets.targetDb, dataset: ds, updatedAt }),
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
      buildStockMessage({ label: range.label, period, targetDb: config.secrets.targetDb, dataset: ds, updatedAt, groups }),
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

export async function handleSales(config, tg, range, { fresh = false, headed, groups = [], by = 'item' } = {}) {
  const cust = by === 'customer';
  if (cust) groups = [];
  const sourceId = cust ? 'doanh_so_kh' : 'doanh_so';
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
    const ds = data.datasets[sourceId];
    if (ds.error?.includes('NO_DATA')) {
      await tg.sendMessage(`ℹ️ <b>Không có ${what} — ${escapeHtml(range.label)}</b>${groups.length ? `\n📦 Nhóm VTHH: ${escapeHtml(groups.join(', '))}` : ''}\nAMIS báo "Không có dữ liệu" cho kỳ${cust ? '' : ' và nhóm'} này (không phải lỗi).`);
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
      buildSalesMessage({ label: range.label, period, targetDb: config.secrets.targetDb, dataset: ds, updatedAt, groups, by }),
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
      if ((f.startsWith('doanh_so__') || f.startsWith('doanh_so_kh__')) && Date.now() - fs.statSync(full).mtimeMs > 2 * 864e5) fs.rmSync(full, { force: true });
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
  if (PREFIX_MODE[kind]) {
    const mode = PREFIX_MODE[kind];
    if (a === 'menu') return sendPeriodPicker(tg, '', mode, state);
    state.mode = mode;
    if (a === 'custom') {
      state.awaitingRange = Date.now(); // vẫn cho phép gõ tay khoảng ngày
      return sendCalendar(tg, state);
    }
    if (PERIOD_LABELS[a]) return beginSales(config, tg, periodOf(a), { ...opts, mode });
    return tg.sendMessage('Lựa chọn không hợp lệ.');
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

  if (cmd === '/start' || cmd === '/help' || cmd === '/trogiup') return tg.sendMessage(helpText(config), { reply_markup: MENU });
  if (cmd === '/tonkho') return sendPeriodPicker(tg, '', 'stock', state);
  if (cmd === '/congnokh') return sendPeriodPicker(tg, '', 'ar', state);
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

export async function runBot(config, opts = {}) {
  const tg = telegramOf(config);
  const owner = String(config.secrets.telegramChatId);
  const state = { awaitingRange: null, cal: null, pick: null };
  opts = { ...opts, state };
  console.log(`Bot đang chạy (chỉ đọc). Trợ lý AI: ${aiEnabled(config.ai) ? 'bật' : 'tắt — thiếu ANTHROPIC_API_KEY'}. Nhấn Ctrl+C để dừng.`);
  await tg.setCommands(COMMANDS).catch((e) => console.error(`Không đăng ký được menu lệnh: ${e.message}`));
  if (config.bot.announceOnStart !== false) {
    await tg.sendMessage('🤖 <b>Bot đã sẵn sàng.</b> Dùng các nút bên dưới để lấy báo cáo.', { reply_markup: MENU }).catch(() => {});
  }
  if (!opts.once) enableWarmSession(config.bot.keepSessionMinutes ?? 10);
  let offset;
  let busy = false;
  tg.pollerActive = true; // vòng lặp này nhận cả lần bấm nút (ví dụ quyết định đăng nhập tiếp)

  // Hàng đợi: chạy lần lượt (chung một phiên AMIS nên không chạy song song), tối đa MAX_QUEUE yêu cầu đang chờ.
  const MAX_QUEUE = config.bot.maxQueue ?? 5;
  const queue = [];
  const pump = () => {
    if (busy) return;
    const work = queue.shift();
    if (!work) return;
    busy = true;
    work()
      .then((r) => (r?.failed ? offerRetry(work, '👆 Yêu cầu trên chưa lấy được số liệu.') : null))
      .catch((e) => { console.error(e); return offerRetry(work, `🚨 <b>Không xử lý được yêu cầu</b>\n${escapeHtml(friendlyError(e))}`); })
      .finally(() => { busy = false; pump(); });
  };
  // Nút "Thử lại" dưới tin lỗi: nhớ lại yêu cầu vừa hỏng (tối đa 20) để chạy lại đúng yêu cầu đó khi bấm.
  const retries = new Map();
  let retrySeq = 0;
  const offerRetry = (work, html) => {
    const id = String(++retrySeq);
    retries.set(id, work);
    if (retries.size > 20) retries.delete(retries.keys().next().value);
    return tg.sendMessage(`${html}\nBấm nút dưới đây để chạy lại đúng yêu cầu này.`, { reply_markup: { inline_keyboard: [[{ text: '🔁 Thử lại', callback_data: `t:${id}` }]] } }).catch(() => {});
  };
  const dispatch = (work) => {
    if (queue.length >= MAX_QUEUE) return tg.sendMessage(`⏳ Hàng đợi đã đầy (${MAX_QUEUE} yêu cầu đang chờ). Vui lòng chờ bớt rồi gửi lại.`).catch(() => {});
    if (busy) tg.sendMessage(`🕒 Đã xếp hàng — còn ${queue.length + 1} yêu cầu đang chờ sau yêu cầu hiện tại, bot sẽ làm lần lượt và gửi kết quả theo thứ tự.`).catch(() => {});
    queue.push(work);
    pump();
  };

  for (;;) {
    let updates = [];
    try { updates = await tg.getUpdates(offset, config.bot.pollSeconds ?? 50); }
    catch (e) { console.error(`Lỗi lấy tin nhắn: ${e.message}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      const cq = u.callback_query;
      if (cq) {
        if (/^c:/.test(cq.data ?? '') && String(cq.message?.chat?.id) === owner) {
          await tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          const range = await applyCalendar(tg, state, cq.data, cq.message.message_id).catch(() => null); // chỉ sửa giao diện → làm ngay cả khi bot đang bận
          if (range) dispatch(() => beginSales(config, tg, range, opts));
        } else if (/^g:/.test(cq.data ?? '') && String(cq.message?.chat?.id) === owner) {
          await tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          const run = await applyGroupPick(tg, state, cq.data, cq.message.message_id).catch(() => null);
          if (run) dispatch(() => runReport(config, tg, run.mode, run.range, { ...opts, groups: run.groups }));
        } else if (/^t:/.test(cq.data ?? '') && String(cq.message?.chat?.id) === owner) {
          await tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          const work = retries.get(cq.data.slice(2));
          if (work) dispatch(work);
          else await tg.sendMessage('Nút thử lại này đã hết hạn (bot vừa khởi động lại). Hãy bấm lại nút báo cáo ở bàn phím bên dưới.').catch(() => {});
        } else if (/^[skpqhjruvw]:/.test(cq.data ?? '') && String(cq.message?.chat?.id) === owner) {
          await tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          dispatch(() => handleCallbackData(config, tg, cq.data, opts));
        } else await tg.handleCallback(cq).catch(() => {});
        continue;
      }
      const msg = u.message;
      if (!msg?.text || String(msg.chat.id) !== owner) continue;
      dispatch(() => handleUpdate(config, tg, msg.text, opts));
    }
    if (opts.once) return;
  }
}
