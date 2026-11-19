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
  for (const k of ['f:mon:1', 'f:mon:2', 'f:thisQuarter', 'f:lastQuarter', 'f:thisYear', 'f:lastYear', 'f:custom']) assert.ok(keys.includes(k), k);
  for (const k of ['f:today', 'f:yesterday', 'f:thisWeek']) assert.ok(!keys.includes(k), k);
  assert.ok(MENU_OWNER.keyboard.flat().some((b) => /Kết quả KD/.test(b.text)));
  assert.ok(!MENU.keyboard.flat().some((b) => /Kết quả KD/.test(b.text)));
});

test('trang chủ: ô Kết quả kinh doanh chỉ có trong chat riêng của chủ bot', async () => {
  const { dashboardKeyboard, dashboardCaption } = await import('../src/bot.js');
  const data = (k) => k.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data(dashboardKeyboard(true)).includes('f:menu'));
  assert.ok(!data(dashboardKeyboard(false)).includes('f:menu'));
  assert.ok((dashboardCaption({ secrets: {} }) + '\n🔒 <i>Riêng bạn: Kết quả kinh doanh (B02)</i>').length < 1024);
});

test('kỳ Tháng N: đúng ngày đầu/cuối tháng, kể cả tháng 2', async () => {
  const { monthRange } = await import('../src/bot.js');
  assert.deepEqual(monthRange(2, new Date('2028-06-01T00:00:00Z')), { fromDate: '01/02/2028', toDate: '29/02/2028', label: 'Tháng 2/2028' });
  assert.deepEqual(monthRange(10, new Date('2026-11-15T00:00:00Z')), { fromDate: '01/10/2026', toDate: '31/10/2026', label: 'Tháng 10/2026' });
});

test('chi phí: tổng, từng tài khoản, so với kỳ trước, lợi nhuận ước tính; chỉ chủ bot', async () => {
  const { buildCostMessage, summarizeCost, previousRange } = await import('../src/cost.js');
  const acc = (rows) => ({ missingFields: [], rows: rows.map(([so_tk, ps_no, ps_co]) => ({ so_tk, ten_tk: '', ps_no, ps_co })) });
  const cur = summarizeCost(acc([['511', 200, 1200], ['632', 600, 0], ['642', 100, 0], ['635', 0, 0], ['811', 50, 0], ['515', 0, 10]]));
  const prev = summarizeCost(acc([['511', 0, 1000], ['632', 500, 0], ['642', 100, 0]]));
  assert.equal(cur.total, 750);
  const msg = buildCostMessage({ label: 'Tháng 10', period: { fromDate: '01/10/2026', toDate: '31/10/2026' }, prevPeriod: previousRange('01/10/2026', '31/10/2026'), cur, prev });
  assert.match(msg, /so với 01\/09\/2026 – 30\/09\/2026/);
  assert.match(msg, /TỔNG CHI PHÍ<\/b>: <b>750 đ<\/b>\n\s+kỳ trước 600 đ · ▲ \+25%/);
  assert.match(msg, /Giá vốn hàng bán <code>632<\/code>: <b>600 đ<\/b> · 80% tổng/);
  assert.match(msg, /Lợi nhuận ước tính<\/b>: <b>260 đ<\/b>/); // 1000 + 10 − 750
  assert.match(msg, /chưa kết chuyển/);
  assert.doesNotMatch(msg, /Chi phí bán hàng/); // = 0 cả 2 kỳ thì ẩn
  // đã kết chuyển (có TK 911): chi phí lấy bên Nợ, không bị triệt tiêu
  const closed = summarizeCost(acc([['632', 600, 600], ['911', 600, 1000], ['511', 1000, 1000]]));
  assert.equal(closed.items['632'], 600);
  assert.deepEqual(previousRange('01/11/2026', '15/11/2026'), { fromDate: '17/10/2026', toDate: '31/10/2026' });
  assert.deepEqual(previousRange('01/01/2026', '31/03/2026'), { fromDate: '01/10/2025', toDate: '31/12/2025' });

  const { handleUpdate, handleCallbackData, handleCost, dashboardKeyboard } = await import('../src/bot.js');
  const sent = [];
  const tg = (chatId) => ({ chatId, sendMessage: async (t, o) => { sent.push({ t, o }); return 1; } });
  const config = { secrets: { telegramChatId: '42' }, bot: {} };
  for (const call of [() => handleUpdate(config, tg('-100'), '/chiphi', { state: {} }), () => handleCallbackData(config, tg('-100'), 'y:mon:10', { state: {} }), () => handleCallbackData(config, tg('-100'), 'o:01102026:31102026', { state: {} }), () => handleCost(config, tg('-100'), { fromDate: '01/10/2026', toDate: '31/10/2026', label: 'x' }, { ownerPrivate: true })]) {
    await call();
    assert.match(sent.at(-1).t, /chỉ dành cho chủ bot/);
  }
  await handleUpdate(config, tg('42'), '/chiphi', { state: {}, ownerPrivate: true });
  assert.ok(sent.at(-1).o.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'y:mon:1'));
  assert.ok(dashboardKeyboard(true).inline_keyboard.flat().some((b) => b.callback_data === 'y:menu'));
  assert.ok(!dashboardKeyboard(false).inline_keyboard.flat().some((b) => b.callback_data === 'y:menu'));
});

test('chứng từ chi phí: đọc sổ chi tiết, không cộng trùng TK chi tiết, bỏ bút toán kết chuyển 911, gộp theo số chứng từ', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { readLedger, expenseVouchers, buildVoucherMessage } = await import('../src/ledger.js');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('S');
  ws.addRow(['SỔ CHI TIẾT CÁC TÀI KHOẢN']);
  ws.addRow(['Ngày hạch toán', 'Ngày chứng từ', 'Số chứng từ', 'Diễn giải', 'TK đối ứng', 'Phát sinh Nợ', 'Phát sinh Có', 'Dư Nợ', 'Dư Có', 'Mã đối tượng', 'Tên đối tượng']);
  ws.addRow(['Tài khoản: 642', null, null, null, null, 300, 0]);
  ws.addRow(['', '', '', 'Số dư đầu kỳ', '', '', '', 0, 0]);
  ws.addRow([new Date(Date.UTC(2026, 9, 2)), null, 'PC1', 'Mua nước', '111', 100, 0, 0, 0, '', 'Hạnh']);
  ws.addRow([new Date(Date.UTC(2026, 9, 5)), null, 'PC2', 'Sửa xe', '111', 150, 0]);
  ws.addRow([new Date(Date.UTC(2026, 9, 5)), null, 'PC2', 'Sửa xe (phụ tùng)', '111', 50, 0]);
  ws.addRow([new Date(Date.UTC(2026, 9, 31)), null, 'KC1', 'Kết chuyển', '911', 0, 300]);
  ws.addRow(['', '', '', 'Cộng', '', 300, 300]);
  ws.addRow(['Tài khoản: 6421', null, null, null, null, 100, 0]);
  ws.addRow([new Date(Date.UTC(2026, 9, 2)), null, 'PC1', 'Mua nước', '111', 100, 0]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'led-')), 's.xlsx');
  await wb.xlsx.writeFile(file);
  const v = expenseVouchers(await readLedger(file), '642');
  assert.deepEqual(v.map((x) => [x.no, x.amount]), [['PC2', 200], ['PC1', 100]]);
  const msg = buildVoucherMessage({ account: '642', name: 'Chi phí quản lý', label: 'Tháng 10', period: { fromDate: '01/10/2026', toDate: '31/10/2026' }, vouchers: v, limit: 1 });
  assert.match(msg, /Tổng: <b>300 đ<\/b> · 2 chứng từ · hiện 1 chứng từ lớn nhất/);
  assert.match(msg, /1\. 05\/10 <code>PC2<\/code> — <b>200 đ<\/b>/);
  assert.match(msg, /… và 1 chứng từ khác: 100 đ/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });

  const { handleCallbackData } = await import('../src/bot.js');
  const sent = [];
  await handleCallbackData({ secrets: { telegramChatId: '42' }, bot: {} }, { chatId: '-100', sendMessage: async (t) => sent.push(t) }, 'y:v:642:01102026:31102026', { state: {} });
  assert.match(sent.at(-1), /chỉ dành cho chủ bot/);
});
