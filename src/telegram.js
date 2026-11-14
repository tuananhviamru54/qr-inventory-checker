// Gửi tin nhắn / file về Telegram qua Bot API.
import fs from 'node:fs/promises';
import path from 'node:path';

export class Telegram {
  constructor({ token, chatId, apiBase }) {
    if (!token || !chatId) throw new Error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong file .env');
    this.chatId = chatId;
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

  async editMessage(messageId, html) {
    try {
      await this.call('editMessageText', { chat_id: this.chatId, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      if (!/not modified/i.test(e.message)) throw e;
    }
  }

  async typing() {
    await this.call('sendChatAction', { chat_id: this.chatId, action: 'typing' }).catch(() => {});
  }

  /** Long-polling lấy tin nhắn mới. */
  async getUpdates(offset, timeoutSec = 50) {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] });
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
