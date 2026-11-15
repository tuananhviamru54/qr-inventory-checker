import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomeMessage } from '../src/income.js';
import { handleUpdate, handleCallbackData, handleIncome, MENU, MENU_OWNER } from '../src/bot.js';

const row = (ma, now, prev) => ({ chi_tieu: `Chỉ tiêu ${ma}`, ma_so: ma, ky_nay: now, ky_truoc: prev });
const b02 = (cogs = 600) => [row('01', 1200, 1000), row('02', 200, 0), row('10', 1000, 1000), row('11', cogs, 500), row('20', 1000 - cogs, 500), row('21', 0, 0), row('22', 0, 0), row('24', 100, 100), row('30', 900 - cogs, 400), row('31', 0, 0), row('32', 0, 0), row('40', 0, 0), row('50', 900 - cogs, 400), row('51', 60, 80), row('60', 840 - cogs, 320)];
const period = { fromDate: '01/11/2026', toDate: '30/11/2026' };

test('kết quả kinh doanh: kỳ này so với kỳ trước, tỷ suất, công thức B02 khớp', () => {
  const msg = buildIncomeMessage({ label: 'Tháng này', period, dataset: { missingFields: [], rows: b02() } });
  assert.match(msg, /LỢI NHUẬN SAU THUẾ<\/b>: <b>240 đ<\/b>\n\s+kỳ trước 320 đ · ▼ −25%/);
  assert.match(msg, /Doanh thu thuần<\/b>: <b>1\.000 đ<\/b>\n\s+kỳ trước 1\.000 đ · ＝ không đổi/);
  assert.match(msg, /Giảm trừ doanh thu: 200 đ\n\s+kỳ trước 0 đ · 🆕/);
  assert.match(msg, /Lãi gộp: 40% \/ 50%/);
  assert.doesNotMatch(msg, /Doanh thu tài chính/); // dòng = 0 cả 2 kỳ được ẩn
  assert.match(msg, /✔ Đã đối chiếu/);
});

test('kết quả kinh doanh: cảnh báo chưa kết chuyển giá vốn và lệch công thức', () => {
  const rows = b02(0);
  rows.find((r) => r.ma_so === '60').ky_nay = 999;
  const msg = buildIncomeMessage({ label: 'x', period, dataset: { missingFields: [], rows } });
  assert.match(msg, /Kỳ này: giá vốn = 0.*chưa kết chuyển/);
  assert.match(msg, /Lệch công thức B02 ở: mã 60 \(kỳ này\)/);
});

test('kết quả kinh doanh: chỉ chủ bot trong chat riêng mới xem được', async () => {
  const sent = [];
  const tg = (chatId) => ({ chatId, sendMessage: async (t, o) => { sent.push({ t, o }); return 1; } });
  const config = { secrets: { telegramChatId: '42' }, bot: {} };
  const state = { awaitingRange: null };
  await handleUpdate(config, tg('-100'), '/ketqua', { state });                       // trong nhóm
  assert.match(sent.at(-1).t, /chỉ dành cho chủ bot/);
  await handleCallbackData(config, tg('-100'), 'f:thisMonth', { state });            // bấm nút trong nhóm
  assert.match(sent.at(-1).t, /chỉ dành cho chủ bot/);
  await handleCallbackData(config, tg('-100'), 'e:01112026:30112026', { state });    // nút làm mới trong nhóm
  assert.match(sent.at(-1).t, /chỉ dành cho chủ bot/);
  await handleIncome(config, tg('-100'), { fromDate: '01/11/2026', toDate: '30/11/2026', label: 'x' }, { ownerPrivate: true }); // giả mạo cờ
  assert.match(sent.at(-1).t, /chỉ dành cho chủ bot/);
  await handleUpdate(config, tg('42'), '/ketqua', { state, ownerPrivate: true });     // chat riêng của chủ bot
  assert.match(sent.at(-1).t, /Kết quả hoạt động kinh doanh/);
  const keys = sent.at(-1).o.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  for (const k of ['f:thisMonth', 'f:lastMonth', 'f:thisQuarter', 'f:lastQuarter', 'f:thisYear', 'f:lastYear', 'f:custom']) assert.ok(keys.includes(k), k);
  assert.ok(MENU_OWNER.keyboard.flat().some((b) => /Kết quả KD/.test(b.text)));
  assert.ok(!MENU.keyboard.flat().some((b) => /Kết quả KD/.test(b.text)));
});
