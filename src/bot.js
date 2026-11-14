// Bot Telegram: nhận câu hỏi/lệnh, hiện tiến độ, trả lời sau khi kế toán trưởng (AI) kiểm soát.
// Chỉ phục vụ đúng chat TELEGRAM_CHAT_ID; tin từ chat khác bị bỏ qua.
import { collect, dataAgeMinutes, fileAgeMinutes, runPipeline, telegramOf } from './index.js';
import { Progress } from './progress.js';
import { aiEnabled, describeAiError } from './ai.js';
import { draftAnswer } from './agents/answer.js';
import { finalizeAnswer } from './agents/expert.js';
import { reviewDraft, reviewSection } from './agents/reviewer.js';
import { answerByRules, RULE_HELP } from './agents/lookup.js';
import { supervisionSection } from './report.js';
import { buildSalesMessage } from './sales.js';
import { escapeHtml, norm, parseDateRange, resolvePeriod, PERIOD_LABELS } from './util.js';
import fs from 'node:fs';
import path from 'node:path';

// ---- Bộ điều khiển mặc định trong Telegram ----
const BTN = {
  refresh: '🔄 Lấy báo cáo mới nhất',
  stock: '📊 Báo cáo tồn kho',
  sales: '💰 Báo cáo doanh số',
  help: '❓ Hướng dẫn',
};
const BTN_TO_CMD = { [BTN.refresh]: '/moi', [BTN.stock]: '/baocao', [BTN.sales]: '/doanhso', [BTN.help]: '/trogiup' };

/** Bàn phím cố định dưới ô nhập tin (luôn hiện cho tới khi bị gỡ). */
export const MENU = {
  keyboard: [[{ text: BTN.refresh }, { text: BTN.stock }], [{ text: BTN.sales }], [{ text: BTN.help }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const COMMANDS = [
  { command: 'moi', description: 'Lấy báo cáo mới nhất (làm mới dữ liệu từ AMIS)' },
  { command: 'baocao', description: 'Báo cáo đối chiếu tồn kho' },
  { command: 'doanhso', description: 'Báo cáo doanh số kèm doanh thu' },
  { command: 'trogiup', description: 'Hướng dẫn sử dụng' },
];

const PERIOD_KEYBOARD = {
  inline_keyboard: [
    [{ text: 'Hôm nay', callback_data: 's:today' }, { text: 'Hôm qua', callback_data: 's:yesterday' }],
    [{ text: 'Tuần này', callback_data: 's:thisWeek' }, { text: 'Tháng này', callback_data: 's:thisMonth' }],
    [{ text: 'Tháng trước', callback_data: 's:lastMonth' }, { text: '📅 Tùy chọn ngày', callback_data: 's:custom' }],
  ],
};

const helpText = (config) => `🤖 <b>Bot đối chiếu MISA AMIS</b> (chỉ đọc)
Dùng các nút dưới ô nhập tin:
${BTN.refresh} — vào AMIS lấy dữ liệu mới rồi gửi báo cáo đối chiếu
${BTN.stock} — báo cáo đối chiếu tồn kho (dùng lại dữ liệu nếu vừa xuất)
${BTN.sales} — doanh số kèm doanh thu: Hôm nay · Hôm qua · Tuần này · Tháng này · Tháng trước · Tùy chọn ngày
(Gõ tắt: /moi · /baocao · /doanhso · /doanhso hôm qua)

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

async function sendPeriodPicker(tg, note = '') {
  await tg.sendMessage(`${note ? `${note}\n\n` : ''}💰 <b>Báo cáo doanh số</b> (kèm doanh thu thuần, lãi gộp)\nChọn kỳ cần xem:`, { reply_markup: PERIOD_KEYBOARD });
}

export async function handleSales(config, tg, range, { fresh = false, headed } = {}) {
  const period = { fromDate: range.fromDate, toDate: range.toDate, today: resolvePeriod('today').today };
  const fileKey = `doanh_so__${range.fromDate.replace(/\//g, '-')}_${range.toDate.replace(/\//g, '-')}`;
  const reuse = !fresh && fileAgeMinutes(config, fileKey) <= config.bot.maxDataAgeMinutes;
  const stages = [...(reuse ? ['reuse'] : ['login', 'export']), 'check', 'send'];
  const progress = new Progress(tg, { title: `Đang lập báo cáo doanh số — ${range.label}…`, stages, timingsFile: timingsFile(config), tickMs: config.bot.tickMs });
  await progress.start();
  try {
    const data = await collect(config, { download: !reuse, headed, tg, log: () => {}, onStage: (s) => progress.stage(s), period, sourceIds: ['doanh_so'], fileKeys: { doanh_so: fileKey } });
    await progress.stage('send');
    const ds = data.datasets.doanh_so;
    if (ds.error || ds.missing) {
      await tg.sendMessage(`⚠️ <b>Không lấy được báo cáo doanh số — ${escapeHtml(range.label)}</b>\n${escapeHtml(ds.error ?? 'chưa có dữ liệu')}`);
      await progress.finish(false);
      return { message: null };
    }
    const updatedAt = ds.file ? vnTime(fs.statSync(ds.file).mtimeMs) : '';
    const message = [
      buildSalesMessage({ label: range.label, period, targetDb: config.secrets.targetDb, dataset: ds, updatedAt }),
      supervisionSection(data.supervision, data.blocked),
    ].filter(Boolean).join('\n\n');
    await tg.sendMessage(message, {
      reply_markup: { inline_keyboard: [[
        { text: '🔄 Làm mới số liệu này', callback_data: `r:${ddmmyyyy(range.fromDate)}:${ddmmyyyy(range.toDate)}` },
        { text: '📅 Chọn kỳ khác', callback_data: 's:menu' },
      ]] },
    });
    // dọn các file doanh số theo kỳ đã cũ (> 2 ngày)
    for (const f of fs.existsSync(config.dirs.downloads) ? fs.readdirSync(config.dirs.downloads) : []) {
      const full = path.join(config.dirs.downloads, f);
      if (f.startsWith('doanh_so__') && Date.now() - fs.statSync(full).mtimeMs > 2 * 864e5) fs.rmSync(full, { force: true });
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
  const [kind, a, b] = String(data).split(':');
  if (kind === 's') {
    if (a === 'menu') return sendPeriodPicker(tg);
    if (a === 'custom') {
      state.awaitingRange = Date.now(); // vẫn cho phép gõ tay khoảng ngày
      return sendCalendar(tg, state);
    }
    if (PERIOD_LABELS[a]) return handleSales(config, tg, periodOf(a), opts);
    return tg.sendMessage('Lựa chọn không hợp lệ.');
  }
  if (kind === 'c') {
    const range = await applyCalendar(tg, state, data, opts.messageId);
    return range ? handleSales(config, tg, range, opts) : undefined;
  }
  if (kind === 'r') {
    const d = (x) => `${x.slice(0, 2)}/${x.slice(2, 4)}/${x.slice(4)}`;
    if (!/^\d{8}$/.test(a ?? '') || !/^\d{8}$/.test(b ?? '')) return tg.sendMessage('Yêu cầu làm mới không hợp lệ.');
    const fromDate = d(a), toDate = d(b);
    const key = Object.keys(PERIOD_LABELS).find((k) => resolvePeriod(k).fromDate === fromDate && resolvePeriod(k).toDate === toDate);
    return handleSales(config, tg, { fromDate, toDate, label: key ? PERIOD_LABELS[key] : `${fromDate} – ${toDate}` }, { ...opts, fresh: true });
  }
  return tg.sendMessage('Lệnh không hợp lệ.');
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

const defaultState = { awaitingRange: null, cal: null };
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
      return handleSales(config, tg, { fromDate: r.from, toDate: r.to, label: r.from === r.to ? r.from : `${r.from} – ${r.to}` }, opts);
    }
  }

  if (cmd === '/start' || cmd === '/help' || cmd === '/trogiup') return tg.sendMessage(helpText(config), { reply_markup: MENU });
  if (cmd === '/baocao') return handleReport(config, tg, { fresh: false, ...opts });
  if (cmd === '/moi') return handleReport(config, tg, { fresh: true, ...opts });
  if (cmd === '/doanhso') {
    const arg = text.slice(cmd.length).trim();
    const intent = arg ? parseSalesIntent(`doanh so ${arg}`) : { picker: true };
    return salesIntent(config, tg, intent, opts);
  }
  if (cmd.startsWith('/')) return tg.sendMessage('Lệnh không hỗ trợ. Gõ /trogiup để xem các lệnh.', { reply_markup: MENU });

  const intent = parseSalesIntent(text);
  if (intent) return salesIntent(config, tg, intent, opts);
  return handleQuestion(config, tg, text, opts);
}

function salesIntent(config, tg, intent, opts) {
  if (intent?.key) return handleSales(config, tg, periodOf(intent.key), opts);
  if (intent?.custom) return handleSales(config, tg, { fromDate: intent.custom.from, toDate: intent.custom.to, label: intent.custom.from === intent.custom.to ? intent.custom.from : `${intent.custom.from} – ${intent.custom.to}` }, opts);
  return sendPeriodPicker(tg, intent?.error ? `⚠️ ${escapeHtml(intent.error)}` : '');
}

export async function runBot(config, opts = {}) {
  const tg = telegramOf(config);
  const owner = String(config.secrets.telegramChatId);
  const state = { awaitingRange: null, cal: null };
  opts = { ...opts, state };
  console.log(`Bot đang chạy (chỉ đọc). Trợ lý AI: ${aiEnabled(config.ai) ? 'bật' : 'tắt — thiếu ANTHROPIC_API_KEY'}. Nhấn Ctrl+C để dừng.`);
  await tg.setCommands(COMMANDS).catch((e) => console.error(`Không đăng ký được menu lệnh: ${e.message}`));
  if (config.bot.announceOnStart !== false) {
    await tg.sendMessage('🤖 <b>Bot đã sẵn sàng.</b> Dùng các nút bên dưới để lấy báo cáo.', { reply_markup: MENU }).catch(() => {});
  }
  let offset;
  let busy = false;
  tg.pollerActive = true; // vòng lặp này nhận cả lần bấm nút (ví dụ quyết định đăng nhập tiếp)

  const dispatch = (work) => {
    if (busy) return tg.sendMessage('⏳ Đang xử lý yêu cầu trước, vui lòng chờ xong rồi gửi lại.').catch(() => {});
    busy = true;
    // không await: vòng lặp vẫn nhận tin để báo "đang bận" thay vì im lặng
    work()
      .catch((e) => tg.sendMessage(`🚨 Không xử lý được yêu cầu: ${escapeHtml(describeAiError(e))}`).catch(() => {}))
      .finally(() => { busy = false; });
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
          if (range) dispatch(() => handleSales(config, tg, range, opts));
        } else if (/^[sr]:/.test(cq.data ?? '') && String(cq.message?.chat?.id) === owner) {
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
