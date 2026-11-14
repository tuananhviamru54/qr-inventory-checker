// Gửi tin nhắn / file về Telegram qua Bot API.
import fs from 'node:fs/promises';
import path from 'node:path';

export class Telegram {
  constructor({ token, chatId, apiBase }) {
    if (!token || !chatId) throw new Error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong file .env');
    this.chatId = chatId;
    this.waiters = new Map();   // token → hàm nhận quyết định
    this.pollerActive = false;  // true khi vòng lặp của bot đang nhận tin (nó sẽ chuyển các lần bấm nút cho handleCallback)
    this.offset = undefined;
    this.base = `${(apiBase || 'https://api.telegram.org').replace(/\/$/, '')}/bot${token}`;
  }

  async call(method, body) {
    for (let attempt = 1; ; attempt++) {
      let res, data;
      try {
        res = await fetch(`${this.base}/${method}`, body instanceof FormData
          ? { method: 'POST', body }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        if (attempt >= 4) throw new Error(`Không kết nối được Telegram: ${e.message}`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      if (res.ok && data.ok) return data.result;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, (data.parameters?.retry_after ?? attempt * 2) * 1000));
        continue;
      }
      throw new Error(`Telegram ${method} lỗi ${res.status}: ${data.description ?? 'không rõ'}`);
    }
  }

  /** Gửi 1 tin ngắn và trả về message_id (để sửa lại sau, dùng cho thanh tiến độ). */
  async sendOne(html) {
    const m = await this.call('sendMessage', { chat_id: this.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    return m.message_id;
  }

  async editMessage(messageId, html, extra = {}) {
    try {
      await this.call('editMessageText', { chat_id: this.chatId, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } catch (e) {
      if (!/not modified/i.test(e.message)) throw e;
    }
  }

  async typing() {
    await this.call('sendChatAction', { chat_id: this.chatId, action: 'typing' }).catch(() => {});
  }

  /** Long-polling lấy tin nhắn mới. */
  async getUpdates(offset, timeoutSec = 50) {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] });
  }

  /**
   * Hỏi người dùng 1 câu có/không bằng 2 nút bấm. Trả về 'yes' | 'no' | 'timeout' (không trả lời = timeout, người gọi phải coi là KHÔNG).
   * Nếu vòng lặp của bot đang chạy thì nó chuyển lần bấm tới đây; nếu không, tự nhận tin trong lúc chờ.
   */
  async ask(html, { yes = '✅ Đăng nhập tiếp', no = '⛔ Huỷ', timeoutMs = 600000 } = {}) {
    const token = Math.random().toString(36).slice(2, 10);
    const sent = await this.call('sendMessage', {
      chat_id: this.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: yes, callback_data: `d:${token}:1` }, { text: no, callback_data: `d:${token}:0` }]] },
    });
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(token); resolve('timeout'); }, timeoutMs);
      this.waiters.set(token, (v) => { clearTimeout(timer); this.waiters.delete(token); resolve(v ? 'yes' : 'no'); });
      if (!this.pollerActive) this.pollWhileWaiting(token).catch(() => {});
    });
    const verdict = { yes: '✅ Bạn đã chọn: đăng nhập tiếp', no: '⛔ Bạn đã chọn: huỷ', timeout: '⌛ Hết thời gian chờ — bot tự huỷ' }[decision];
    await this.editMessage(sent.message_id, `${html}\n\n<b>${verdict}</b>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return decision;
  }

  async pollWhileWaiting(token) {
    while (this.waiters.has(token)) {
      const started = Date.now();
      const updates = await this.getUpdates(this.offset, 20);
      for (const u of updates) {
        this.offset = u.update_id + 1;
        if (u.callback_query) await this.handleCallback(u.callback_query);
      }
      if (!updates.length && Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 1000 - (Date.now() - started)));
    }
  }

  /** Xử lý 1 lần bấm nút. Chỉ chấp nhận từ đúng chat của chủ bot. */
  async handleCallback(cq) {
    const answer = (text) => this.call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
    if (String(cq.message?.chat?.id) !== String(this.chatId)) return answer('Không có quyền');
    const m = /^d:(\w+):([01])$/.exec(cq.data ?? '');
    if (!m) return answer('Lệnh không hợp lệ');
    const waiter = this.waiters.get(m[1]);
    if (!waiter) return answer('Yêu cầu này đã hết hạn');
    waiter(m[2] === '1');
    return answer('Đã ghi nhận');
  }

  /** Gửi tin HTML, tự tách theo dòng nếu vượt giới hạn 4096 ký tự. */
  async sendMessage(html) {
    const chunks = [];
    let cur = '';
    for (const line of html.split('\n')) {
      if (cur.length + line.length + 1 > 3900 && cur) { chunks.push(cur); cur = ''; }
      cur += (cur ? '\n' : '') + line.slice(0, 3900);
    }
    if (cur) chunks.push(cur);
    for (const text of chunks) {
      await this.call('sendMessage', { chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    }
  }

  async sendFile(file, caption, method = 'sendDocument') {
    const form = new FormData();
    form.set('chat_id', String(this.chatId));
    if (caption) form.set('caption', caption.slice(0, 1000));
    form.set(method === 'sendPhoto' ? 'photo' : 'document', new Blob([await fs.readFile(file)]), path.basename(file));
    await this.call(method, form);
  }
}
