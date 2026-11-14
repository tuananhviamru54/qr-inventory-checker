// Điều khiển trình duyệt (Playwright): đăng nhập MISA AMIS và xuất báo cáo ra file Excel.
// Dùng hồ sơ trình duyệt cố định (.auth/profile) để AMIS nhớ thiết bị → hạn chế bị hỏi OTP lại.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { template, totp } from './util.js';
import { installNetworkGuard, assertStepAllowed, assertElementAllowed } from './readonly.js';

export class LoginError extends Error {}

const DEFAULT_SELECTORS = {
  username: 'input[name="username" i], input[name="email" i], input[type="email"], input[autocomplete="username"]',
  password: 'input[type="password"]',
  submit: 'button[type="submit"], button:has-text("Đăng nhập"), input[type="submit"]',
  otp: 'input[name*="otp" i], input[autocomplete="one-time-code"], input[placeholder*="xác thực" i], input[placeholder*="OTP" i]',
  loggedIn: '',
};

export class AmisSession {
  constructor(config, { headed = false, log = console.log } = {}) {
    this.amis = config.amis;
    this.dirs = config.dirs;
    this.sel = { ...DEFAULT_SELECTORS, ...(config.amis.selectors ?? {}) };
    this.headed = headed;
    this.log = log;
  }

  async open() {
    await fs.mkdir(this.dirs.profile, { recursive: true });
    await fs.mkdir(this.dirs.downloads, { recursive: true });
    await fs.mkdir(this.dirs.output, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.dirs.profile, {
      headless: !this.headed,
      acceptDownloads: true,
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block', // để mọi yêu cầu mạng đều đi qua lớp chặn chỉ-đọc
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: process.env.CHROMIUM_NO_SANDBOX ? ['--no-sandbox'] : [],
    });
    this.context.setDefaultTimeout(this.amis.timeoutMs ?? 30000);
    this.audit = await installNetworkGuard(this.context, { allowPost: this.amis.readOnly?.allowPost, log: this.log });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
  }

  async close() {
    if (this.audit?.nonGet.length) {
      const lines = this.audit.nonGet.map((r) => `${r.time}\t${r.blocked ? 'CHAN' : 'cho-qua'}\t${r.method}\t${r.url}\t${r.blocked ?? ''}`);
      await fs.appendFile(path.join(this.dirs.output, 'nhat-ky-yeu-cau.log'), lines.join('\n') + '\n').catch(() => {});
    }
    await this.context?.close().catch(() => {});
  }

  async screenshot(name) {
    try {
      const file = path.join(this.dirs.output, `${name}.png`);
      await this.page.screenshot({ path: file });
      return file;
    } catch { return null; }
  }

  async visible(selector) {
    if (!selector) return false;
    return this.page.locator(selector).first().isVisible().catch(() => false);
  }

  /**
   * Mở AMIS; nếu thấy form đăng nhập thì điền tài khoản. Coi là đã đăng nhập khi không còn
   * ô mật khẩu / ô OTP (và thấy selectors.loggedIn nếu có cấu hình).
   * @param manualWaitMs  thời gian chờ người dùng tự thao tác (chế độ `login` có giao diện)
   */
  async login({ username, password, totpSecret, manualWaitMs = 0 } = {}) {
    const { page, sel } = this;
    await page.goto(this.amis.loginUrl ?? this.amis.baseUrl, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + Math.max(manualWaitMs, this.amis.loginTimeoutMs ?? 45000);
    const detectUntil = Date.now() + (this.amis.loginDetectMs ?? 8000);
    let submitted = false, otpSent = 0, clearSince = 0;

    while (Date.now() < deadline) {
      const hasPwd = await this.visible(sel.password);
      const hasOtp = !hasPwd && await this.visible(sel.otp);
      if (hasPwd && !submitted && username && password) {
        this.log('→ Đăng nhập MISA AMIS…');
        if (await this.visible(sel.username)) await page.locator(sel.username).first().fill(username);
        await page.locator(sel.password).first().fill(password);
        await page.locator(sel.submit).first().click();
        submitted = true;
        clearSince = 0;
      } else if (hasOtp) {
        clearSince = 0;
        if (totpSecret && Date.now() - otpSent > 35000) {
          this.log('→ Nhập mã xác thực 2 lớp (TOTP)…');
          await page.locator(sel.otp).first().fill(await totp(totpSecret));
          await page.keyboard.press('Enter');
          otpSent = Date.now();
        } else if (!totpSecret && !manualWaitMs) {
          throw new LoginError('AMIS yêu cầu mã xác thực (OTP). Chạy `npm run login` trên máy có màn hình để xác thực 1 lần, hoặc khai báo AMIS_TOTP_SECRET.');
        }
      } else if (!hasPwd) {
        const ready = sel.loggedIn ? await this.visible(sel.loggedIn) : (submitted || Date.now() > detectUntil);
        if (ready) {
          clearSince ||= Date.now();
          if (Date.now() - clearSince >= 1500) { this.log('✓ Đã đăng nhập'); return; }
        } else clearSince = 0;
      } else if (hasPwd && !(username && password) && !manualWaitMs) {
        throw new LoginError('Thiếu AMIS_USERNAME / AMIS_PASSWORD trong file .env');
      }
      await page.waitForTimeout(500);
    }
    throw new LoginError(submitted
      ? 'Đăng nhập AMIS không thành công (sai mật khẩu, captcha, hoặc cần xác thực thêm). Xem ảnh chụp màn hình đính kèm; thử `npm run login` để đăng nhập thủ công 1 lần.'
      : 'Hết thời gian chờ đăng nhập AMIS.');
  }

  /** Chạy danh sách bước của 1 báo cáo, trả về đường dẫn file đã tải. */
  async exportReport(source, vars) {
    const { page } = this;
    let saved = null;
    const t = (s) => template(s, vars);
    for (const step of source.steps) assertStepAllowed(...Object.entries(step)[0]);
    const safeClick = async (selector) => {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: 'visible' });
      await assertElementAllowed(loc);
      await loc.click();
    };
    for (const [i, step] of source.steps.entries()) {
      const [action, arg] = Object.entries(step)[0];
      try {
        switch (action) {
          case 'goto': await page.goto(t(arg), { waitUntil: 'domcontentloaded' }); break;
          case 'click': await safeClick(t(arg)); break;
          case 'fill': {
            const loc = page.locator(t(arg.selector)).first();
            await loc.fill(t(arg.value));
            if (arg.enter) await loc.press('Enter');
            break;
          }
          case 'press': await page.keyboard.press(arg); break;
          case 'wait': await page.waitForTimeout(arg); break;
          case 'waitFor': await page.locator(t(arg)).first().waitFor({ state: 'visible' }); break;
          case 'download': {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: this.amis.downloadTimeoutMs ?? 120000 }),
              safeClick(t(arg)),
            ]);
            const ext = path.extname(download.suggestedFilename()) || '.xlsx';
            saved = path.join(this.dirs.downloads, `${source.id}${ext}`);
            await download.saveAs(saved);
            break;
          }
          default: throw new Error(`Bước không hỗ trợ: ${action}`);
        }
      } catch (e) {
        throw new Error(`Báo cáo "${source.name}" lỗi ở bước ${i + 1} (${action}: ${JSON.stringify(arg)}): ${e.message.split('\n')[0]}`);
      }
    }
    if (!saved) throw new Error(`Báo cáo "${source.name}" chưa có bước "download" trong config.json`);
    return saved;
  }
}
