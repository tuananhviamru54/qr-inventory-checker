// Thanh tiến độ trên Telegram: 1 tin nhắn được cập nhật liên tục cho tới khi có câu trả lời.
// Thời gian dự kiến còn lại tính từ thời lượng trung bình của các lần chạy trước (output/thoi-gian.json).
import fs from 'node:fs';

export const STAGE_LABELS = {
  login: 'Đăng nhập MISA AMIS (có giám sát)',
  export: 'Xuất báo cáo từ AMIS',
  exportDaily: 'Xuất 8 báo cáo từ AMIS (tiền, bán hàng, luỹ kế năm, công nợ, tồn kho)',
  reuse: 'Dùng lại dữ liệu vừa xuất',
  check: 'Đọc file và kiểm tra chéo',
  answer: 'Trợ lý soạn câu trả lời',
  expert: 'Chuyên gia đối chiếu, phân tích và chốt',
  review: 'Kế toán trưởng kiểm soát',
  send: 'Gửi kết quả',
};
const DEFAULT_SECONDS = { login: 12, export: 35, exportDaily: 230, reuse: 1, check: 2, answer: 25, expert: 30, review: 25, send: 2 };

const BAR = 14;
const SPINNER = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
// Câu mô tả vui theo từng bước (đổi mỗi ~2 nhịp)
const FLAVOR = {
  login: ['🔐 Đang gõ cửa MISA AMIS…', '🛡 Giám sát đứng canh từng cú bấm…', '🗝 Kiểm tra đúng sổ KHO QUẢNG NINH…'],
  exportDaily: ['💵 Đếm tiền trong quỹ…', '💰 Cộng doanh số trong ngày…', '🧾 Rà sổ công nợ khách hàng…', '🏭 Rà sổ công nợ nhà cung cấp…', '📦 Kiểm kho nhựa Ecoplast…', '🐉 Rồng kho đang gom số liệu cả ngày…'],
  export: ['🐉 Rồng kho đang lật từng trang sổ…', '📑 AMIS đang in báo cáo ra Excel…', '🧮 Đang cộng từng dòng, từng đồng…', '📦 Đếm hàng trong kho nhựa Ecoplast…', '🚚 Báo cáo đang trên đường về…'],
  reuse: ['⚡ Có sẵn số liệu mới lấy — dùng lại cho nhanh!'],
  check: ['🔍 Soi từng con số với dòng "Tổng cộng"…', '⚖️ Đầu kỳ + phát sinh = cuối kỳ? Đang kiểm…'],
  answer: ['✍️ Trợ lý đang soạn câu trả lời…'],
  expert: ['🧠 Chuyên gia đang phân tích…'],
  review: ['🧐 Kế toán trưởng đang duyệt…'],
  send: ['📨 Đóng gói báo cáo gửi bạn…'],
  default: ['⏳ Đang xử lý…'],
};
const TIPS = [
  'Bấm 🔄 <b>Làm mới</b> dưới báo cáo để lấy số mới nhất từ AMIS.',
  'Số liệu lấy trong 30 phút được dùng lại — lần sau ra ngay.',
  'Có thể bấm nhiều báo cáo liền nhau, bot xếp hàng tối đa 5 yêu cầu.',
  'Gõ nhanh: <code>/doanhso hôm qua</code> hoặc <code>/doanhso 01/11 - 10/11</code>.',
  '📅 Tùy chọn ngày có lịch bấm chọn — không cần gõ.',
  'Bot chỉ <b>đọc</b>: mọi thao tác ghi/sửa trên AMIS đều bị chặn.',
  'Gõ /start để mở lại trang chủ với đủ các báo cáo.',
  'Gặp lỗi? Bấm 🔁 <b>Thử lại</b> ngay dưới tin báo lỗi.',
];

const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} phút ${Math.round(sec % 60)}s` : `${Math.max(0, Math.round(sec))}s`);

export class Progress {
  /**
   * @param tg      Telegram (hoặc null để tắt hiển thị)
   * @param stages  danh sách khoá giai đoạn theo thứ tự, ví dụ ['login','export','check','review','send']
   */
  constructor(tg, { title, stages, timingsFile, tickMs = 4000 }) {
    this.tg = tg; this.title = title; this.stages = stages; this.timingsFile = timingsFile; this.tickMs = tickMs;
    this.avg = { ...DEFAULT_SECONDS };
    try { Object.assign(this.avg, JSON.parse(fs.readFileSync(timingsFile, 'utf8'))); } catch { /* chưa có lịch sử */ }
    this.index = -1; this.startedAt = Date.now(); this.stageAt = Date.now(); this.spent = {};
    this.queue = Promise.resolve();
    this.ticks = 0;
    this.tipSeed = Math.floor(Math.random() * TIPS.length);
  }

  render(final) {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    if (final) { // bản tóm tắt cuối: gọn, giữ nguyên định dạng cũ
      const title = final === '✅' ? this.title.replace(/^Đang /, 'Đã ').replace(/…$/, ' — xong') : this.title.replace(/^Đang /, 'Chưa ').replace(/…$/, ' — dừng do lỗi');
      const lines = [`${final} <b>${title}</b>`];
      this.stages.forEach((key, i) => lines.push(`✅ ${i + 1}/${this.stages.length} ${STAGE_LABELS[key] ?? key}${this.spent[key] != null ? ` (${fmt(this.spent[key])})` : ''}`));
      if (final !== '✅') lines.splice(1, lines.length - 1, ...this.stages.map((key, i) => `${i < this.index ? '✅' : i === this.index ? '❌' : '▫️'} ${i + 1}/${this.stages.length} ${STAGE_LABELS[key] ?? key}${this.spent[key] != null ? ` (${fmt(this.spent[key])})` : ''}`));
      lines.push(`⏱ Tổng thời gian: ${fmt(elapsed)}`);
      return lines.join('\n');
    }
    const tick = this.ticks ?? 0;
    const cur = this.stages[this.index];
    const inStage = (Date.now() - this.stageAt) / 1000;
    const left = Math.max(0, (this.avg[cur] ?? 5) - inStage) + this.stages.slice(this.index + 1).reduce((s, k) => s + (this.avg[k] ?? 5), 0);
    const pct = Math.min(99, Math.round((100 * elapsed) / Math.max(1, elapsed + left)));
    const filled = Math.round((BAR * pct) / 100);
    const lines = [
      `${SPINNER[tick % SPINNER.length]} <b>${this.title}</b>`,
      '━━━━━━━━━━━━━━━━━━',
    ];
    this.stages.forEach((key, i) => {
      const label = STAGE_LABELS[key] ?? key;
      if (i < this.index) lines.push(`✅ ${i + 1}/${this.stages.length} ${label}${this.spent[key] != null ? ` (${fmt(this.spent[key])})` : ''}`);
      else if (i === this.index) lines.push(`🔄 ${i + 1}/${this.stages.length} <b>${label}</b> · ${fmt(inStage)}`);
      else lines.push(`▫️ ${i + 1}/${this.stages.length} ${label}`);
    });
    const flavor = FLAVOR[cur] ?? FLAVOR.default;
    lines.push(
      '━━━━━━━━━━━━━━━━━━',
      `<code>${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}</code> <b>${pct}%</b>`,
      `⏱ ${fmt(elapsed)} · còn khoảng ${left < 3 ? 'vài giây' : fmt(left)}`,
      '',
      `<i>${flavor[Math.floor(tick / 2) % flavor.length]}</i>`,
      `💡 ${TIPS[(this.tipSeed + Math.floor(tick / 3)) % TIPS.length]}`,
    );
    return lines.join('\n');
  }

  push(final) {
    if (!this.tg) return this.queue;
    const html = this.render(final);
    this.queue = this.queue.then(async () => {
      if (this.messageId == null) this.messageId = await this.tg.sendOne(html);
      else await this.tg.editMessage(this.messageId, html);
    }).catch(() => {}); // lỗi hiển thị tiến độ không được làm hỏng việc chính
    return this.queue;
  }

  async start() {
    await this.push();
    if (this.tg) this.timer = setInterval(() => { this.ticks++; this.push(); this.tg.typing(); }, this.tickMs);
  }

  /** Chuyển sang giai đoạn `key` (bỏ qua nếu không nằm trong danh sách). */
  async stage(key) {
    const i = this.stages.indexOf(key);
    if (i < 0 || i === this.index) return;
    this.closeStage();
    this.index = i;
    await this.push();
  }

  closeStage() {
    const cur = this.stages[this.index];
    if (cur) this.spent[cur] = (Date.now() - this.stageAt) / 1000;
    this.stageAt = Date.now();
  }

  async finish(ok = true) {
    clearInterval(this.timer);
    this.closeStage();
    if (ok) {
      this.index = this.stages.length;
      for (const [k, v] of Object.entries(this.spent)) this.avg[k] = Math.round((0.6 * (this.avg[k] ?? v) + 0.4 * v) * 10) / 10;
      try { fs.writeFileSync(this.timingsFile, JSON.stringify(this.avg)); } catch { /* bỏ qua */ }
    }
    await this.push(ok ? '✅' : '❌');
  }
}
