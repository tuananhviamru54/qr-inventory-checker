// Thanh tiến độ trên Telegram: 1 tin nhắn được cập nhật liên tục cho tới khi có câu trả lời.
// Thời gian dự kiến còn lại tính từ thời lượng trung bình của các lần chạy trước (output/thoi-gian.json).
import fs from 'node:fs';

export const STAGE_LABELS = {
  login: 'Đăng nhập MISA AMIS (có giám sát)',
  export: 'Xuất báo cáo từ AMIS',
  reuse: 'Dùng lại dữ liệu vừa xuất',
  check: 'Đọc file và kiểm tra chéo',
  answer: 'Trợ lý soạn câu trả lời',
  review: 'Kế toán trưởng kiểm soát',
  send: 'Gửi kết quả',
};
const DEFAULT_SECONDS = { login: 12, export: 35, reuse: 1, check: 2, answer: 25, review: 25, send: 2 };

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
  }

  render(final) {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const lines = [`${final ?? '⏳'} <b>${this.title}</b>`];
    this.stages.forEach((key, i) => {
      const icon = i < this.index || final ? '✅' : i === this.index ? '🔄' : '▫️';
      const took = this.spent[key] != null ? ` (${fmt(this.spent[key])})` : '';
      lines.push(`${icon} ${i + 1}/${this.stages.length} ${STAGE_LABELS[key] ?? key}${took}`);
    });
    if (final) lines.push(`⏱ Tổng thời gian: ${fmt(elapsed)}`);
    else {
      const inStage = (Date.now() - this.stageAt) / 1000;
      const cur = this.stages[this.index];
      const left = Math.max(0, (this.avg[cur] ?? 5) - inStage)
        + this.stages.slice(this.index + 1).reduce((s, k) => s + (this.avg[k] ?? 5), 0);
      const done = this.stages.length ? Math.round((10 * Math.max(0, this.index)) / this.stages.length) : 0;
      lines.push(`${'▰'.repeat(done)}${'▱'.repeat(10 - done)}  ⏱ đã chạy ${fmt(elapsed)} · còn khoảng ${left < 3 ? 'vài giây' : fmt(left)}`);
    }
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
    if (this.tg) this.timer = setInterval(() => { this.push(); this.tg.typing(); }, this.tickMs);
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
