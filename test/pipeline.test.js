import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { startMock } from './mock-server.js';
import { withDefaults } from '../src/config.js';
import { runPipeline } from '../src/index.js';
import { LoginError } from '../src/amis.js';
import { parseNumber, resolvePeriod, totp, parseDateRange } from '../src/util.js';
import { blockReason, forbiddenLabel } from '../src/readonly.js';
import { handleUpdate, handleCallbackData, parseSalesIntent, MENU, COMMANDS } from '../src/bot.js';
import { Telegram } from '../src/telegram.js';
import { Supervisor } from '../src/supervisor-client.js';

const base = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function makeConfig(mock, root, password = 'secret') {
  const cfg = structuredClone(base);
  cfg.amis.baseUrl = mock.url;
  cfg.amis.loginTimeoutMs = 8000;
  cfg.amis.loginDetectMs = 2000;
  cfg.sources[0].steps = [
    { click: 'text=Tổng hợp tồn kho' },
    { fill: { selector: "input[placeholder*='Từ ngày']", value: '{{fromDate}}' } },
    { fill: { selector: "input[placeholder*='Đến ngày']", value: '{{toDate}}' } },
    { click: "button:has-text('Đồng ý')" },
    { click: "button:has-text('Xuất khẩu')" },
    { download: 'text=Excel' },
  ];
  cfg.secrets = { username: 'demo', password, targetDb: 'KHO QUẢNG NINH', telegramToken: 'T0KEN', telegramChatId: '42', telegramApiBase: mock.url };
  cfg.ai = { enabled: false };
  cfg.bot = { tickMs: 200 };
  return withDefaults(cfg, root);
}

const withAi = (config, mock) => { config.ai = { ...config.ai, enabled: true, apiKey: 'test-key', baseURL: mock.url }; return config; };

async function writeKiemKe(root) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Kiểm kê');
  ws.addRow(['Mã hàng', 'Tên hàng', 'Số lượng thực tế']);
  ws.addRow(['SP001', 'Bút bi', 70]);
  ws.addRow(['sp001', 'Bút bi', 50]);   // cùng mã, 2 vị trí → cộng dồn = 120
  ws.addRow(['SP002', 'Vở kẻ ngang', 175]);
  ws.addRow(['SP003', 'Thước kẻ', 0]);
  ws.addRow(['SP004', 'Tẩy', 50]);
  ws.addRow(['SP005', 'Hồ dán', 1007.5]);
  ws.addRow(['SP999', 'Hàng lạ', 3]);
  await wb.xlsx.writeFile(path.join(root, 'data', 'kiem_ke.xlsx'));
}

test('quy trình đầy đủ: đăng nhập → xuất → kiểm tra chéo → Telegram', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    await writeKiemKe(root);
    const config = makeConfig(mock, root);
    const out = await runPipeline(config, { log: () => {} });

    assert.deepEqual(mock.state.logins, [{ username: 'demo', password: 'secret' }]);
    const period = resolvePeriod('thisMonth');
    assert.deepEqual(mock.state.exports, [{ from: period.fromDate, to: period.toDate }]);
    assert.equal(out.datasets.ton_kho.rows.length, 5);

    const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
    assert.deepEqual(by.amis_vs_kiem_ke.issues.map((i) => [i.kind, i.key]), [
      ['mismatch', 'SP002'], ['mismatch', 'SP003'], ['missing', 'SP999'],
    ]);
    assert.match(by.amis_vs_kiem_ke.issues[0].detail, /180 → 175 \(-5\)/);
    assert.deepEqual(by.can_doi_nxt.issues.map((i) => i.key), ['SP004', 'SP005']);
    assert.deepEqual(by.ton_am.issues.map((i) => i.key), ['SP003']);

    const calls = mock.state.telegram;
    assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
    const msg = JSON.parse(calls[0].text);
    assert.equal(msg.chat_id, '42');
    assert.match(msg.text, /SP002/);
    assert.match(msg.text, /3 vấn đề/);
    assert.match(calls[1].body, /filename="chenh-lech-.*\.xlsx"/);
    assert.ok(fs.existsSync(out.issuesFile));

    // Lần 2: phiên đã lưu trong hồ sơ trình duyệt → không phải đăng nhập lại
    await runPipeline(config, { log: () => {}, send: false });
    assert.equal(mock.state.logins.length, 1);
    assert.equal(mock.state.exports.length, 2);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('sai mật khẩu → báo lỗi về Telegram kèm ảnh màn hình', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root, 'sai');
    await assert.rejects(runPipeline(config, { log: () => {} }), LoginError);
    assert.deepEqual(mock.state.telegram.map((c) => c.method), ['sendMessage', 'sendPhoto']);
    assert.match(JSON.parse(mock.state.telegram[0].text).text, /Không lấy được báo cáo/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('sai dữ liệu kế toán → dừng, không xuất báo cáo', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root);
    config.secrets.targetDb = 'KHO HÀ NỘI';
    config.amis.targetDbWaitMs = 2000;
    await assert.rejects(runPipeline(config, { log: () => {}, send: false }), /không phải "KHO HÀ NỘI"/);
    assert.equal(mock.state.exports.length, 0);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Giả lập người dùng bấm nút trên Telegram: tìm tin hỏi có nút, rồi đẩy callback_query vào hàng đợi cập nhật.
function pressWhenAsked(mock, value) {
  let pressed = false;
  const timer = setInterval(() => {
    if (pressed) return;
    for (const c of mock.state.telegram) {
      const m = c.method === 'sendMessage' && /d:(\w+):1/.exec(c.text);
      if (m) {
        pressed = true;
        mock.state.updates.push({ update_id: 900, callback_query: { id: 'cq1', data: `d:${m[1]}:${value}`, message: { chat: { id: 42 } } } });
      }
    }
  }, 100);
  return () => clearInterval(timer);
}

test('tài khoản đang có người khác dùng: hỏi qua Telegram, chỉ đăng nhập tiếp khi người dùng đồng ý', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  const results = {};
  try {
    for (const mode of ['yes', 'no', 'timeout', 'khong-co-kenh']) {
      const mock = await startMock();
      try {
        mock.state.concurrent = true;
        const config = makeConfig(mock, root);
        config.amis.concurrentDecisionMs = 2500;
        const stop = mode === 'yes' ? pressWhenAsked(mock, 1) : mode === 'no' ? pressWhenAsked(mock, 0) : () => {};
        const run = runPipeline(config, { log: () => {}, send: mode !== 'khong-co-kenh' });
        if (mode === 'yes') {
          const out = await run; stop();
          assert.equal(mock.state.forced, 1);                        // đã bấm "Tiếp tục đăng nhập" đúng 1 lần
          assert.equal(mock.state.exports.length, 1);                // và xuất báo cáo bình thường
          assert.equal(out.datasets.ton_kho.rows.length, 5);
          const texts = mock.state.telegram.filter((c) => c.method === 'sendMessage').map((c) => c.text);
          assert.match(texts[0], /Window x64 \(1\.2\.3\.4\)/);
          assert.match(texts[0], /inline_keyboard/);
          assert.ok(mock.state.telegram.some((c) => c.method === 'answerCallbackQuery'));
          assert.ok(mock.state.telegram.some((c) => c.method === 'editMessageText' && /Bạn đã chọn: đăng nhập tiếp/.test(c.text)));
          assert.match(fs.readFileSync(path.join(root, 'output', 'giam-sat.log'), 'utf8'), /QUYẾT ĐỊNH CỦA NGƯỜI DÙNG\tyes/);
        } else {
          await assert.rejects(run, mode === 'no' ? /Bạn đã chọn huỷ/ : mode === 'timeout' ? /tự huỷ để bảo đảm an toàn/ : /KHÔNG tự đăng nhập đè/);
          stop();
          assert.equal(mock.state.forced, 0);                        // không bấm gì: phiên của người kia an toàn
          assert.deepEqual(mock.state.writes, []);
          assert.equal(mock.state.exports.length, 0);
        }
        results[mode] = true;
      } finally { await mock.close(); }
    }
    assert.deepEqual(Object.keys(results), ['yes', 'no', 'timeout', 'khong-co-kenh']);
    assert.equal(forbiddenLabel('Tiếp tục đăng nhập'), 'tiep tuc dang nhap'); // vẫn nằm trong luật cứng cho mọi lần bấm thông thường
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('thiếu file kiểm kê → bỏ qua phép so sánh, vẫn chạy các phép còn lại (không tải lại)', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root);
    await runPipeline(config, { log: () => {}, send: false });
    const out = await runPipeline(config, { log: () => {}, send: false, download: false });
    assert.equal(mock.state.exports.length, 1);
    assert.deepEqual(out.results.map((r) => r.status), ['skipped', 'fail', 'fail']);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('chỉ đọc: từ chối bấm nút ghi dữ liệu, chặn yêu cầu ghi ở tầng mạng', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    // 1. Bước cấu hình cố bấm "Cất" (kể cả bằng selector không chứa chữ) → bị từ chối, không có gì gửi lên máy chủ
    for (const selector of ['text=Cất', '#cat']) {
      const config = makeConfig(mock, root);
      config.sources[0].steps.splice(4, 0, { click: selector });
      const out = await runPipeline(config, { log: () => {}, send: false });
      assert.match(out.datasets.ton_kho.error, /Chế độ chỉ đọc/);
    }
    assert.deepEqual(mock.state.writes, []);
    assert.equal(mock.state.exports.length, 0);

    // 2. Nút trông vô hại nhưng trang tự gửi yêu cầu ghi → bị chặn ở tầng mạng, yêu cầu đọc vẫn qua
    const config = makeConfig(mock, root);
    config.sources[0].steps.splice(4, 0, { click: "button:has-text('Nạp dữ liệu')" }, { wait: 500 });
    const out = await runPipeline(config, { log: () => {} });
    assert.deepEqual(mock.state.writes, []);
    assert.deepEqual(mock.state.reads, ['POST /api/report/GetData']);
    assert.deepEqual(out.blocked.map((b) => b.method).sort(), ['DELETE', 'POST']);
    assert.equal(out.datasets.ton_kho.rows.length, 5);
    const sent = JSON.parse(mock.state.telegram[0].text).text;
    assert.match(sent, /Giám sát độc lập/);
    assert.match(sent, /SaveVoucher/);
    assert.equal(out.supervision.clicksDenied, 0);
    assert.ok(out.supervision.requests >= 2);
    assert.match(fs.readFileSync(path.join(root, 'output', 'nhat-ky-yeu-cau.log'), 'utf8'), /CHAN\tDELETE/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent kế toán trưởng: báo cáo được kiểm soát trước khi gửi', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    await writeKiemKe(root);
    const out = await runPipeline(withAi(makeConfig(mock, root), mock), { log: () => {} });
    assert.equal(out.review.status, 'dat');
    const sent = JSON.parse(mock.state.telegram[0].text).text;
    assert.match(sent, /✔ Đã kiểm tra chéo độ chính xác/);
    assert.doesNotMatch(sent, /nhận xét|đề xuất|lưu ý/i);
    // chuyên gia phân tích → kế toán trưởng trả lại (SAI_LECH_MOCK) → chuyên gia làm lại → đạt
    assert.deepEqual(mock.state.ai.filter((x) => !x.startsWith('supervisor')), ['expert:report', 'review:reject', 'expert:report', 'review:ok']);
    assert.match(sent, /🎓 <b>Chuyên gia phân tích<\/b> — 🟡 Cần chú ý/);
    assert.match(sent, /tồn cuối kỳ -5/);
    assert.match(sent, /Có thể xuất trước khi nhập phiếu/);
    assert.doesNotMatch(sent, /SAI_LECH_MOCK/);
    assert.ok(sent.indexOf('Chuyên gia phân tích') < sent.indexOf('Đã kiểm tra chéo độ chính xác'));
    assert.deepEqual(Object.keys(out.focus), ['Tồn kho AMIS', 'Kiểm kê thực tế']);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('bot Telegram: hỏi → tiến độ → trợ lý soạn → kế toán trưởng trả lại → soạn lại → gửi', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = withAi(makeConfig(mock, root), mock);
    const tg = new Telegram({ token: 'T0KEN', chatId: '42', apiBase: mock.url });
    const out = await handleUpdate(config, tg, 'Mã SP002 còn tồn bao nhiêu?');
    assert.deepEqual(mock.state.ai.filter((x) => !x.startsWith('supervisor')), ['answer', 'expert:answer', 'review:reject', 'answer', 'expert:answer', 'review:ok']);
    assert.equal(out.review.status, 'dat');
    const calls = mock.state.telegram.map((c) => ({ method: c.method, body: c.contentType?.includes('json') ? JSON.parse(c.text) : null }));
    // tin đầu tiên là thanh tiến độ, sau đó được sửa nhiều lần, cuối cùng báo hoàn tất
    assert.equal(calls[0].method, 'sendMessage');
    assert.match(calls[0].body.text, /Đang xử lý câu hỏi/);
    const edits = calls.filter((c) => c.method === 'editMessageText');
    assert.ok(edits.length >= 4);
    assert.ok(edits.some((e) => /🔄 \d\/7 Kế toán trưởng kiểm soát/.test(e.body.text)));
    assert.match(edits.at(-1).body.text, /^✅.*\n(✅.*\n){7}⏱ Tổng thời gian/s);
    const answer = calls.filter((c) => c.method === 'sendMessage').at(-1).body.text;
    assert.match(answer, /SP002 Vở kẻ ngang còn 180 quyển/);
    assert.doesNotMatch(answer, /999/);
    assert.match(answer, /🎓 Có thể SP002 đã xuất/);
    assert.match(answer, /✔ Đã kiểm tra chéo độ chính xác/);
    assert.doesNotMatch(answer, /KHÔNG ĐẠT/);
    assert.match(answer, /Giám sát độc lập/);

    // Hỏi lần 2 trong vòng 30 phút: dùng lại dữ liệu, không vào AMIS nữa
    await handleUpdate(config, tg, 'Mã SP002 còn tồn bao nhiêu?');
    assert.equal(mock.state.exports.length, 1);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('không dùng AI: tra cứu theo mã, tồn âm, tổng tồn; câu lạ → hướng dẫn; báo cáo không nhắc AI', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root); // ai.enabled = false
    const tg = new Telegram({ token: 'T0KEN', chatId: '42', apiBase: mock.url });
    const lastText = () => JSON.parse(mock.state.telegram.filter((c) => c.method === 'sendMessage').at(-1).text).text;

    await handleUpdate(config, tg, 'Mã SP002 còn bao nhiêu?');
    assert.match(lastText(), /<code>SP002<\/code> Vở kẻ ngang: đầu kỳ 200 · nhập 0 · xuất 20 · cuối kỳ 180/);
    assert.match(lastText(), /không qua AI/);

    await handleUpdate(config, tg, 'Những mã nào đang âm kho?');
    assert.match(lastText(), /Có <b>1<\/b> dòng tồn cuối kỳ âm/);
    assert.match(lastText(), /SP003/);

    await handleUpdate(config, tg, 'Tổng tồn kho là bao nhiêu?');
    assert.match(lastText(), /Tổng số lượng tồn cuối kỳ: <b>1\.007,5<\/b>|Tổng số lượng tồn cuối kỳ: <b>1\.352,5<\/b>|Tổng số lượng tồn cuối kỳ: <b>[\d.,]+<\/b>/);

    await handleUpdate(config, tg, 'Thời tiết hôm nay thế nào?');
    assert.match(lastText(), /Chưa hiểu câu hỏi này/);
    assert.equal(mock.state.ai.length, 0); // không có lời gọi AI nào (kể cả giám sát)
    assert.equal(mock.state.exports.length, 1); // 4 câu hỏi nhưng chỉ vào AMIS 1 lần

    await handleUpdate(config, tg, '/moi'); // luôn lấy dữ liệu mới → có phiên AMIS để giám sát
    assert.doesNotMatch(lastText(), /AI\)|ANTHROPIC|chưa kiểm tra độ chính xác/i);
    assert.match(lastText(), /Giám sát độc lập/);
    assert.match(lastText(), /Phân loại bằng AI: tắt \(chỉ dùng luật cứng\)/);
    assert.equal(mock.state.exports.length, 2);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent giám sát độc lập: AI chặn nút và yêu cầu ghi mà luật cứng không biết; mất liên lạc → từ chối', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    // nút "Chốt kỳ" không có trong danh sách cấm → agent giám sát (AI) từ chối
    let config = withAi(makeConfig(mock, root), mock);
    config.sources[0].steps.splice(4, 0, { click: "button:has-text('Chốt kỳ')" });
    let out = await runPipeline(config, { log: () => {}, send: false });
    assert.match(out.datasets.ton_kho.error, /Agent giám sát từ chối thao tác bấm "Chốt kỳ"/);
    assert.equal(out.supervision.clicksDenied, 1);

    // nút vô hại nhưng trang gửi POST lạ → AI phân loại là ghi dữ liệu → chặn ở tầng mạng
    config = withAi(makeConfig(mock, root), mock);
    config.sources[0].steps.splice(4, 0, { click: "button:has-text('Nạp thêm')" }, { wait: 1500 });
    out = await runPipeline(config, { log: () => {}, send: false });
    assert.deepEqual(mock.state.writes, []);
    assert.ok(out.blocked.some((b) => b.url.endsWith('/api/misc/thing') && /giám sát: ghi_du_lieu/.test(b.reason)));
    assert.equal(out.datasets.ton_kho.rows.length, 5);
    assert.match(fs.readFileSync(path.join(root, 'output', 'giam-sat.log'), 'utf8'), /CHẶN\tPOST .*\/api\/misc\/thing/);

    // tiến trình giám sát chết → mọi câu hỏi đều bị từ chối
    const sup = new Supervisor({ ai: { enabled: false }, outputDir: path.join(root, 'output'), timeoutMs: 2000 });
    assert.equal((await sup.ask({ kind: 'request', method: 'POST', url: 'http://x/api/report/get' })).allow, true);
    sup.child.kill('SIGKILL');
    await new Promise((r) => sup.child.once('exit', r));
    const verdict = await sup.ask({ kind: 'request', method: 'POST', url: 'http://x/api/report/get' });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /không phản hồi/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

async function writeSalesWorkbook(root, { totalDoanhSo = 7098100 } = {}) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Doanh số');
  ws.addRow(['TỔNG HỢP BÁN HÀNG THEO MẶT HÀNG']);
  ws.addRow(['Từ ngày 01/11/2026 đến ngày 15/11/2026']);
  ws.addRow([]);
  ws.addRow(['Mã hàng', 'Tên hàng', 'ĐVT', 'Số lượng bán', 'Doanh số bán', 'Chiết khấu', 'SL trả lại', 'Giá trị trả lại', 'Giá trị giảm giá', 'Doanh thu thuần', 'Tiền vốn', 'Lãi gộp', 'Tỷ lệ lãi gộp (%)']);
  ws.addRow(['A12_2', 'Ecoplast_Nẹp cạnh A12 (2*2500)', 'thanh', 100, 2098100, 546345, 0, 0, 0, 1551755, 1284600, 267155, 17.2]);
  ws.addRow(['SP9', 'Hàng B', 'cái', 10, 5000000, 0, 0, 0, 0, 5000000, 3000000, 2000000, 40]);
  ws.addRow(['Tổng cộng', null, null, 110, totalDoanhSo, 546345, 0, 0, 0, 6551755, 4284600, 2267155]);
  await wb.xlsx.writeFile(path.join(root, 'data', 'doanh_so.xlsx'));
}

const salesFileConfig = (mock, root) => {
  const config = makeConfig(mock, root);
  const src = config.sources.find((x) => x.id === 'doanh_so');
  src.type = 'file'; src.path = 'data/doanh_so.xlsx'; delete src.steps;
  return config;
};
const sentBodies = (mock) => mock.state.telegram.filter((c) => c.method === 'sendMessage').map((c) => JSON.parse(c.text));

test('bộ điều khiển mặc định: bàn phím cố định, menu lệnh, nút → lệnh, chọn kỳ doanh số', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root);
    const tg = new Telegram({ token: 'T0KEN', chatId: '42', apiBase: mock.url });
    await handleUpdate(config, tg, '/start', { state: { awaitingRange: null } });
    const start = sentBodies(mock).at(-1);
    assert.deepEqual(start.reply_markup.keyboard.flat().map((b) => b.text),
      ['🔄 Lấy báo cáo mới nhất', '📊 Báo cáo tồn kho', '💰 Báo cáo doanh số', '❓ Hướng dẫn']);
    assert.equal(start.reply_markup.is_persistent, true);
    assert.deepEqual(MENU.keyboard.flat().length, 4);
    assert.deepEqual(COMMANDS.map((c) => c.command), ['moi', 'baocao', 'doanhso', 'trogiup']);
    await tg.setCommands(COMMANDS);
    assert.ok(mock.state.telegram.some((c) => c.method === 'setMyCommands'));

    // bấm nút "Báo cáo doanh số" → bảng chọn kỳ với đủ 6 lựa chọn
    await handleUpdate(config, tg, '💰 Báo cáo doanh số', { state: { awaitingRange: null } });
    const picker = sentBodies(mock).at(-1);
    assert.deepEqual(picker.reply_markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]), [
      ['Hôm nay', 's:today'], ['Hôm qua', 's:yesterday'], ['Tuần này', 's:thisWeek'],
      ['Tháng này', 's:thisMonth'], ['Tháng trước', 's:lastMonth'], ['📅 Tùy chọn ngày', 's:custom'],
    ]);
    assert.equal(mock.state.exports.length, 0); // mới chỉ hiện bảng chọn, chưa vào AMIS
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('báo cáo doanh số: các kỳ, tùy chọn ngày, gõ tự do, đối chiếu tổng', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    await writeSalesWorkbook(root);
    const config = salesFileConfig(mock, root);
    const tg = new Telegram({ token: 'T0KEN', chatId: '42', apiBase: mock.url });
    const opts = { state: { awaitingRange: null } };
    const last = () => sentBodies(mock).at(-1);

    await handleCallbackData(config, tg, 's:thisMonth', opts);
    let m = last();
    assert.match(m.text, /💰 <b>Báo cáo doanh số — Tháng này<\/b>/);
    assert.match(m.text, /Doanh số bán<\/b>: 7\.098\.100 đ \(≈ 7,1 triệu\)/);
    assert.match(m.text, /− Chiết khấu: 546\.345 đ/);
    assert.match(m.text, /Doanh thu thuần<\/b>: 6\.551\.755 đ \(≈ 6,6 triệu\)/);
    assert.match(m.text, /Lãi gộp: 2\.267\.155 đ \(34,6%\)/);
    assert.match(m.text, /2 mặt hàng có phát sinh/);
    assert.ok(m.text.indexOf('SP9') < m.text.indexOf('A12_2')); // xếp theo doanh thu thuần giảm dần
    assert.match(m.text, /✔ Đã đối chiếu: tổng các dòng khớp dòng "Tổng cộng" của AMIS/);
    const month = resolvePeriod('thisMonth');
    assert.match(m.text, new RegExp(`${month.fromDate} – ${month.toDate}`));
    assert.deepEqual(m.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`r:${month.fromDate.replace(/\//g, '')}:${month.toDate.replace(/\//g, '')}`, 's:menu']);

    for (const [data, label] of [['s:today', 'Hôm nay'], ['s:yesterday', 'Hôm qua'], ['s:thisWeek', 'Tuần này'], ['s:lastMonth', 'Tháng trước']]) {
      await handleCallbackData(config, tg, data, opts);
      assert.match(last().text, new RegExp(`Báo cáo doanh số — ${label}`));
    }

    // tùy chọn ngày: bấm → bot hỏi → gõ sai thì báo lỗi và vẫn chờ → gõ đúng thì ra báo cáo
    await handleCallbackData(config, tg, 's:custom', opts);
    assert.match(last().text, /Tùy chọn ngày/);
    await handleUpdate(config, tg, '31/02/2026', opts);
    assert.match(last().text, /không tồn tại trong lịch/);
    assert.ok(opts.state.awaitingRange);
    await handleUpdate(config, tg, '01/11/2026 - 10/11/2026', opts);
    assert.match(last().text, /Báo cáo doanh số — 01\/11\/2026 – 10\/11\/2026/);
    assert.equal(opts.state.awaitingRange, null);
    await handleCallbackData(config, tg, 's:custom', opts);
    await handleUpdate(config, tg, 'huỷ', opts);
    assert.match(last().text, /Đã huỷ chọn ngày/);

    // gõ tự do và lệnh có tham số
    await handleUpdate(config, tg, 'doanh thu tuần này thế nào', opts);
    assert.match(last().text, /Báo cáo doanh số — Tuần này/);
    await handleUpdate(config, tg, '/doanhso hôm qua', opts);
    assert.match(last().text, /Báo cáo doanh số — Hôm qua/);
    await handleUpdate(config, tg, 'doanh số', opts);
    assert.ok(last().reply_markup.inline_keyboard.length === 3); // hỏi lại kỳ
    assert.equal(parseSalesIntent('tồn kho còn bao nhiêu'), null);

    // Tổng trên AMIS khác tổng các dòng → cảnh báo, không im lặng
    await writeSalesWorkbook(root, { totalDoanhSo: 9999999 });
    await handleCallbackData(config, tg, 's:today', opts);
    assert.match(last().text, /⚠️ Tổng các dòng khác dòng "Tổng cộng" của AMIS ở: doanh_so/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('báo cáo doanh số qua AMIS: ngày của kỳ được điền vào báo cáo, dùng lại dữ liệu theo kỳ, nút làm mới', async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amis-'));
  try {
    const config = makeConfig(mock, root);
    const src = config.sources.find((x) => x.id === 'doanh_so');
    src.steps = structuredClone(config.sources[0].steps); // máy chủ giả lập xuất file tồn kho → báo cáo sẽ "thiếu cột doanh số"
    const tg = new Telegram({ token: 'T0KEN', chatId: '42', apiBase: mock.url });
    const opts = { state: { awaitingRange: null } };

    await handleCallbackData(config, tg, 's:thisWeek', opts);
    const week = resolvePeriod('thisWeek');
    assert.deepEqual(mock.state.exports, [{ from: week.fromDate, to: week.toDate }]);
    assert.match(sentBodies(mock).at(-1).text, /thiếu cột/);
    assert.ok(fs.existsSync(path.join(root, 'downloads', `doanh_so__${week.fromDate.replace(/\//g, '-')}_${week.toDate.replace(/\//g, '-')}.xlsx`)));

    await handleCallbackData(config, tg, 's:thisWeek', opts);       // cùng kỳ, còn mới → dùng lại, không vào AMIS
    assert.equal(mock.state.exports.length, 1);
    await handleUpdate(config, tg, '/doanhso 01/11/2026 - 05/11/2026', opts); // kỳ khác → xuất mới với đúng ngày
    assert.deepEqual(mock.state.exports.at(-1), { from: '01/11/2026', to: '05/11/2026' });
    await handleCallbackData(config, tg, 'r:01112026:05112026', opts);       // nút làm mới → luôn xuất lại
    assert.equal(mock.state.exports.length, 3);
    assert.deepEqual(mock.state.exports.at(-1), { from: '01/11/2026', to: '05/11/2026' });
    // chạy báo cáo tồn kho không bị ảnh hưởng bởi nguồn doanh số
    const out = await runPipeline(config, { log: () => {}, send: false, download: false });
    assert.ok(!('doanh_so' in out.datasets));
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('tiện ích', async () => {
  assert.deepEqual(resolvePeriod('thisWeek', new Date('2026-11-14T05:00:00Z')), { fromDate: '09/11/2026', toDate: '14/11/2026', today: '14/11/2026' }); // thứ 7 → từ thứ 2
  assert.equal(resolvePeriod('thisWeek', new Date('2026-11-15T05:00:00Z')).fromDate, '09/11/2026');                                                       // chủ nhật
  assert.equal(resolvePeriod('thisWeek', new Date('2026-11-09T05:00:00Z')).fromDate, '09/11/2026');                                                       // thứ 2
  assert.deepEqual(parseDateRange('01/11/2026 - 10/11/2026'), { from: '01/11/2026', to: '10/11/2026' });
  assert.deepEqual(parseDateRange('1/11 đến 10/11', new Date('2026-11-14T05:00:00Z')), { from: '01/11/2026', to: '10/11/2026' });
  assert.deepEqual(parseDateRange('10-11-2026'), { from: '10/11/2026', to: '10/11/2026' });
  assert.match(parseDateRange('31/02/2026').error, /không tồn tại/);
  assert.match(parseDateRange('10/11/2026 - 01/11/2026').error, /trước hoặc bằng/);
  assert.match(parseDateRange('01/01/2024 - 01/01/2026').error, /366 ngày/);
  assert.match(parseDateRange('xin chào').error, /Không đọc được ngày/);
  assert.equal(blockReason('GET', 'https://x/api/voucher/delete'), null);
  assert.ok(blockReason('PUT', 'https://x/api/report'));
  assert.ok(blockReason('POST', 'https://x/api/INVoucher/SaveVoucher'));
  assert.equal(blockReason('POST', 'https://x/api/report/ExportExcel'), null);
  assert.equal(blockReason('POST', 'https://x/api/a/update', ['/api/a/update$']), null);
  assert.equal(forbiddenLabel('Xuất khẩu'), null);
  assert.equal(forbiddenLabel('Đồng ý'), null);
  assert.equal(forbiddenLabel('Xem thêm'), null);
  assert.equal(forbiddenLabel('Cất và Thêm'), 'cat');
  assert.equal(forbiddenLabel(' Ghi sổ '), 'ghi so');
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('(1.200)'), -1200);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('abc'), null);
  assert.deepEqual(resolvePeriod('lastMonth', new Date('2026-03-15T00:00:00Z')), { fromDate: '01/02/2026', toDate: '28/02/2026', today: '15/03/2026' });
  // 17:30 UTC đã sang ngày hôm sau theo giờ VN
  assert.equal(resolvePeriod('today', new Date('2026-11-14T17:30:00Z')).today, '15/11/2026');
  assert.equal(await totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082'); // vector RFC 6238
});
