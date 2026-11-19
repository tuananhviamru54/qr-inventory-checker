import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, dashboardKeyboard } from '../src/bot.js';
import { loadConfig, scopeConfig } from '../src/config.js';

test('nhóm: /start hiện trang tổng The Five, chỉ nút inline, không có bàn phím trả lời', async () => {
  const config = scopeConfig(loadConfig('config.json', process.cwd()), 'qn', 0);
  const out = [];
  const tg = { sendFile: async (f, caption, m, o) => out.push({ f, caption, o }), sendMessage: async (t, o) => out.push({ t, o }) };
  await handleUpdate(config, tg, '/start', { group: true, ownerPrivate: false, state: {} });
  assert.equal(out.length, 1);
  assert.match(out[0].f, /logo-thefive/);
  assert.match(out[0].caption, /THE FIVE/);
  const btns = out[0].o.reply_markup.inline_keyboard.flat().map((b) => b.text).join('|');
  for (const k of ['Toàn hệ thống', 'Kho Hà Nội', 'Kho Đồng Nai', 'Kho Miền Tây', 'Kho Vĩnh Phúc', 'Kho Quảng Ninh']) assert.match(btns, new RegExp(k));
  assert.ok(!out.some((x) => x.o?.reply_markup?.keyboard));
});

test('trang báo cáo của kho trong nhóm có nút về trang tổng', () => {
  const kb = dashboardKeyboard(false, true).inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'z:co'));
  assert.ok(!kb.some((b) => /Kết quả KD|Chi phí/.test(b.text)));
});
