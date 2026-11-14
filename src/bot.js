// Bot Telegram: nhận câu hỏi/lệnh, hiện tiến độ, trả lời sau khi kế toán trưởng (AI) kiểm soát.
// Chỉ phục vụ đúng chat TELEGRAM_CHAT_ID; tin từ chat khác bị bỏ qua.
import { collect, dataAgeMinutes, runPipeline, telegramOf } from './index.js';
import { Progress } from './progress.js';
import { aiEnabled, describeAiError } from './ai.js';
import { draftAnswer } from './agents/answer.js';
import { finalizeAnswer } from './agents/expert.js';
import { reviewDraft, reviewSection } from './agents/reviewer.js';
import { answerByRules, RULE_HELP } from './agents/lookup.js';
import { supervisionSection } from './report.js';
import { escapeHtml } from './util.js';
import path from 'node:path';

const HELP = `🤖 <b>Bot đối chiếu MISA AMIS</b> (chỉ đọc)
/baocao — xuất tồn kho từ AMIS, kiểm tra chéo và gửi báo cáo
/moi — như /baocao nhưng luôn lấy dữ liệu mới từ AMIS
/trogiup — xem hướng dẫn này
Hoặc gõ câu hỏi về tồn kho, ví dụ: <i>"Mã A12_2 còn tồn bao nhiêu?"</i>, <i>"Những mã nào đang âm kho?"</i>, <i>"Tổng tồn kho là bao nhiêu?"</i>

Mọi câu trả lời đều qua chuyên gia (AI) đối chiếu và chốt, rồi kế toán trưởng (AI) kiểm tra độ chính xác trước khi gửi.`;

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

export async function handleUpdate(config, tg, text, opts = {}) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  if (cmd === '/start' || cmd === '/help' || cmd === '/trogiup') return tg.sendMessage(HELP);
  if (cmd === '/baocao') return handleReport(config, tg, { fresh: false, ...opts });
  if (cmd === '/moi') return handleReport(config, tg, { fresh: true, ...opts });
  if (cmd.startsWith('/')) return tg.sendMessage('Lệnh không hỗ trợ. Gõ /trogiup để xem các lệnh.');
  return handleQuestion(config, tg, text.trim(), opts);
}

export async function runBot(config, opts = {}) {
  const tg = telegramOf(config);
  const owner = String(config.secrets.telegramChatId);
  console.log(`Bot đang chạy (chỉ đọc). Trợ lý AI: ${aiEnabled(config.ai) ? 'bật' : 'tắt — thiếu ANTHROPIC_API_KEY'}. Nhấn Ctrl+C để dừng.`);
  let offset;
  let busy = false;
  tg.pollerActive = true; // vòng lặp này nhận cả lần bấm nút (ví dụ quyết định đăng nhập tiếp)
  for (;;) {
    let updates = [];
    try { updates = await tg.getUpdates(offset, config.bot.pollSeconds ?? 50); }
    catch (e) { console.error(`Lỗi lấy tin nhắn: ${e.message}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.callback_query) { await tg.handleCallback(u.callback_query).catch(() => {}); continue; }
      const msg = u.message;
      if (!msg?.text || String(msg.chat.id) !== owner) continue;
      if (busy) { await tg.sendMessage('⏳ Đang xử lý yêu cầu trước, vui lòng chờ xong rồi gửi lại.').catch(() => {}); continue; }
      busy = true;
      // không await: vòng lặp vẫn nhận tin để báo "đang bận" thay vì im lặng
      handleUpdate(config, tg, msg.text, opts)
        .catch((e) => tg.sendMessage(`🚨 Không xử lý được yêu cầu: ${escapeHtml(describeAiError(e))}`).catch(() => {}))
        .finally(() => { busy = false; });
    }
    if (opts.once) return;
  }
}
