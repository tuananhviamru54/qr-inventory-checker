// Kết nối từ tiến trình chính tới agent giám sát (tiến trình con). Nguyên tắc: không có câu trả lời = bị từ chối.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class Supervisor {
  constructor({ ai, allowPost, outputDir, timeoutMs = 30000 }) {
    this.timeoutMs = timeoutMs;
    this.waiting = new Map();
    this.seq = 0;
    this.dead = false;
    this.child = fork(fileURLToPath(new URL('./supervisor.js', import.meta.url)), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child.on('message', (m) => { this.waiting.get(m.id)?.(m); this.waiting.delete(m.id); });
    this.child.on('exit', () => {
      this.dead = true;
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    });
    this.ready = this.send({ kind: 'init', ai, allowPost, outputDir });
  }

  send(msg) {
    if (this.dead) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, this.timeoutMs);
      this.waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
      try { this.child.send({ ...msg, id }); } catch { clearTimeout(timer); this.waiting.delete(id); resolve(null); }
    });
  }

  /** Hỏi ý kiến giám sát. Luôn trả về { allow, reason }; mất liên lạc → từ chối. */
  async ask(msg) {
    await this.ready;
    const res = await this.send(msg);
    if (!res) return { allow: false, reason: 'agent giám sát không phản hồi — dừng thao tác để bảo đảm an toàn', by: 'mất liên lạc' };
    return res;
  }

  async summary() {
    const res = await this.send({ kind: 'summary' });
    return res?.summary ?? null;
  }

  stop() {
    if (!this.dead) this.child.kill();
  }
}
