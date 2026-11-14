// Điều khiển trình duyệt (Playwright): đăng nhập MISA AMIS và xuất báo cáo ra file Excel.
// Dùng hồ sơ trình duyệt cố định (.auth/profile) để AMIS nhớ thiết bị → hạn chế bị hỏi OTP lại.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { template, totp } from './util.js';
import { installNetworkGuard, assertStepAllowed, assertElementAllowed, ReadOnlyViolation } from './readonly.js';
import { Supervisor } from './supervisor-client.js';

export class LoginError extends Error {}
const t0 = (x) => x; // URL bước goto không dùng biến

const DEFAULT_SELECTORS = {
  username: 'input[name="username" i], input[name="email" i], input[type="email"], input[autocomplete="username"]',
  password: 'input[type="password"]',
  submit: 'button.login-form-btn, button[type="submit"]:has-text("Đăng nhập"), input[type="submit"]',
  otp: 'input[name*="otp" i], input[autocomplete="one-time-code"], input[placeholder*="xác thực" i], input[placeholder*="OTP" i]',
  loggedIn: '',
};

export class AmisSession {
  constructor(config, { headed = false, log = console.log } = {}) {
    this.amis = config.amis;
    this.ai = config.ai ?? {};
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
      proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    });
    this.context.setDefaultTimeout(this.amis.timeoutMs ?? 30000);
    this.supervisor = new Supervisor({ ai: this.ai, allowPost: this.amis.readOnly?.allowPost, outputDir: this.dirs.output });
    this.audit = await installNetworkGuard(this.context, { allowPost: this.amis.readOnly?.allowPost, log: this.log, supervisor: this.supervisor });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
  }

  async close() {
    if (this.audit?.nonGet.length) {
      const lines = this.audit.nonGet.map((r) => `${r.time}\t${r.blocked ? 'CHAN' : 'cho-qua'}\t${r.method}\t${r.url}\t${r.blocked ?? ''}`);
      await fs.appendFile(path.join(this.dirs.output, 'nhat-ky-yeu-cau.log'), lines.join('\n') + '\n').catch(() => {});
    }
    await this.context?.close().catch(() => {});
    this.supervision = await this.supervisor?.summary().catch(() => null) ?? this.supervision ?? null;
    this.supervisor?.stop();
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

  /** MISA chỉ cho 1 phiên/tài khoản: nếu có người đang dùng, AMIS hỏi có đăng nhập đè (đẩy người đó ra) hay không. */
  async concurrentSessionNotice() {
    const notice = this.page.getByText('Đang có người dùng khác sử dụng tài khoản này').first();
    if (!(await notice.isVisible().catch(() => false))) return null;
    const detail = await this.page.getByText('Tài khoản này đang được sử dụng trên').first().innerText().catch(() => '');
    return detail.replace(/\s+/g, ' ').trim() || 'Tài khoản đang được dùng ở nơi khác';
  }

  throwConcurrent(detail, why) {
    throw new LoginError(`Tài khoản đang được dùng ở nơi khác (${detail}). ${why ?? 'Bot KHÔNG tự đăng nhập đè vì sẽ đẩy người đó ra khỏi AMIS. Hãy dùng một tài khoản AMIS riêng cho bot, hoặc chạy lại khi tài khoản này không có ai dùng.'}`);
  }

  /**
   * Gặp màn hình "Đang có người dùng khác...": hỏi người dùng qua `onConcurrent` (Telegram).
   * Chỉ khi nhận được 'yes' mới bấm "Tiếp tục đăng nhập"; không có kênh hỏi, 'no' hoặc hết giờ → dừng. Trả về true nếu vừa đăng nhập đè.
   */
  async resolveConcurrent() {
    const detail = await this.concurrentSessionNotice();
    if (!detail) return false;
    if (this.concurrentHandled || !this.onConcurrent) this.throwConcurrent(detail);
    const decision = await this.onConcurrent(detail);
    const stamp = new Date().toISOString();
    await fs.appendFile(path.join(this.dirs.output, 'giam-sat.log'), `${stamp}\tQUYẾT ĐỊNH CỦA NGƯỜI DÙNG\t${decision}\t${detail}\n`).catch(() => {});
    if (decision === 'no') this.throwConcurrent(detail, 'Bạn đã chọn huỷ nên bot không đăng nhập và không đụng tới phiên của người đang dùng.');
    if (decision !== 'yes') this.throwConcurrent(detail, 'Không nhận được quyết định của bạn trong thời gian chờ nên bot tự huỷ để bảo đảm an toàn.');
    this.concurrentHandled = true;
    this.log('→ Bạn đã đồng ý: đăng nhập tiếp (người đang dùng sẽ bị đăng xuất)');
    // Thao tác duy nhất được phép bấm nút này, chỉ sau khi người dùng đồng ý; nằm ngoài safeClick vì nút bị cấm trong luật cứng.
    await this.page.locator("button:has-text('Tiếp tục đăng nhập')").first().click();
    await this.page.waitForTimeout(2000);
    return true;
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
      if (!manualWaitMs && (await this.resolveConcurrent())) { submitted = true; clearSince = 0; continue; }
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

  /**
   * Xác nhận đang ở đúng dữ liệu kế toán `targetDb` (AMIS hiển thị tên dữ liệu hiện tại trên thanh tiêu đề).
   * Bot không tự chuyển dữ liệu; nếu sai thì dừng để tránh đối chiếu nhầm sổ.
   */
  async verifyDatabase(targetDb) {
    if (!targetDb) return;
    const wait = this.amis.targetDbWaitMs ?? 30000;
    // Sau đăng nhập MISA có thể đưa về trang Bàn làm việc chung (amisapp...) thay vì app Kế toán → mở lại app Kế toán.
    if (new URL(this.page.url()).host !== new URL(this.amis.baseUrl).host) {
      await this.page.goto(this.amis.baseUrl, { waitUntil: 'domcontentloaded' });
    }
    const name = this.page.getByText(targetDb, { exact: true }).first();
    let deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      if (await name.isVisible().catch(() => false)) { this.log(`✓ Đúng dữ liệu: ${targetDb}`); return; }
      if (await this.resolveConcurrent()) deadline = Date.now() + wait; // đã đăng nhập đè theo quyết định của người dùng
      await this.page.waitForTimeout(500);
    }
    throw new Error(`Dữ liệu kế toán đang mở không phải "${targetDb}". Chạy \`npm run login\`, chuyển sang đúng dữ liệu trong trình duyệt rồi chạy lại.`);
  }

  /** Cuộn danh sách xổ xuống đang mở thêm `dy` px. @returns {Promise<boolean>} false nếu đã hết */
  async scrollDropdown(dy) {
    const moved = await this.page.evaluate((delta) => {
      let el = [...document.querySelectorAll('.dropdown-item-td--text')].find((e) => e.offsetParent);
      while (el && !(el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible')) el = el.parentElement;
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop += delta;
      return el.scrollTop > before;
    }, dy);
    await this.page.waitForTimeout(200);
    return moved;
  }

  /**
   * Đọc toàn bộ danh sách Nhóm VTHH từ hộp tham số của báo cáo `source` (cần source.groups.prefix).
   * Chỉ mở hộp và đọc, không chọn gì. @returns {{code,name,level,parent}[]}
   */
  async readItemGroups(source) {
    const { page } = this;
    const url = t0(source.steps.find((x) => x.goto).goto);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator("button:has-text('Chọn tham số')").first().waitFor();
    await page.waitForTimeout(3000);
    if (!(await this.visible("button:has-text('Xem báo cáo')"))) await page.locator("button:has-text('Chọn tham số')").first().click();
    await page.locator("button:has-text('Xem báo cáo')").first().waitFor();
    await page.locator(`[data-testid='${source.groups.prefix}-di-triggerclick']`).first().click();
    await page.waitForTimeout(1500);
    const seen = new Map();
    for (let i = 0; i < 40; i++) {
      const rows = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.dropdown-item-td--text')].filter((e) => e.offsetParent);
        const byY = new Map();
        for (const c of cells) { const r = c.getBoundingClientRect(); const k = Math.round(r.y); (byY.get(k) ?? byY.set(k, []).get(k)).push({ x: Math.round(r.x), t: c.innerText.trim() }); }
        return [...byY.values()].map((v) => v.sort((a, b) => a.x - b.x)).map((v) => ({ code: v[0]?.t, name: v[1]?.t ?? v[0]?.t, x: v[0]?.x }));
      });
      for (const r of rows) if (r.code && !seen.has(r.code)) seen.set(r.code, r);
      if (!(await this.scrollDropdown(90))) break;
    }
    const all = [...seen.values()];
    const base = Math.min(...all.map((r) => r.x));
    let parent = null;
    return all.map((r) => {
      const level = r.x > base + 4 ? 1 : 0;
      if (level === 0) parent = r.code;
      return { code: r.code, name: r.name, level, parent: level ? parent : null };
    });
  }

  /** Chạy danh sách bước của 1 báo cáo, trả về đường dẫn file đã tải. */
  async exportReport(source, vars, { fileName } = {}) {
    const { page } = this;
    let saved = null;
    const t = (s) => template(s, vars);
    for (const step of source.steps) assertStepAllowed(...Object.entries(step)[0]);
    const safeClick = async (selector) => {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: 'visible' });
      await assertElementAllowed(loc);
      const label = await loc.evaluate((el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80)).catch(() => '');
      const verdict = await this.supervisor.ask({ kind: 'click', label, selector, context: source.name });
      if (!verdict.allow) throw new ReadOnlyViolation(`Agent giám sát từ chối thao tác bấm "${label || selector}": ${verdict.reason}`);
      await loc.click();
    };
    for (const [i, step] of source.steps.entries()) {
      const [action, arg] = Object.entries(step)[0];
      try {
        switch (action) {
          case 'goto': await page.goto(t(arg), { waitUntil: 'domcontentloaded' }); break;
          case 'click': {
            // dạng rút gọn: "selector"; dạng đầy đủ: { selector, ifVisible?, unlessVisible?, optional?, timeout? }
            if (typeof arg === 'string') { await safeClick(t(arg)); break; }
            if (arg.ifVisible && !(await this.visible(t(arg.ifVisible)))) break;
            if (arg.unlessVisible && (await this.visible(t(arg.unlessVisible)))) break;
            if (arg.optional) { // chờ tối đa timeout; không thấy thì bỏ qua bước này
              const seen = await page.locator(t(arg.selector)).first()
                .waitFor({ state: 'visible', timeout: arg.timeout ?? 10000 }).then(() => true, () => false);
              if (!seen) break;
            }
            await safeClick(t(arg.selector));
            break;
          }
          case 'fill': {
            // { selector, value, enter?, tab?, verify? } — verify: đọc lại giá trị sau khi điền, AMIS không nhận thì thử lại (tối đa 3 lần)
            const loc = page.locator(t(arg.selector)).first();
            const value = t(arg.value);
            this.supervisor.ask({ kind: 'fill', selector: t(arg.selector), value }).catch(() => {});
            for (let attempt = 1; ; attempt++) {
              await loc.fill(value);
              if (arg.enter) await loc.press('Enter');
              if (arg.tab) await loc.press('Tab');
              if (!arg.verify || (await loc.inputValue()) === value) break;
              if (attempt >= 3) throw new Error(`ô "${t(arg.selector)}" không nhận giá trị ${value}`);
              await page.waitForTimeout(400);
            }
            break;
          }
          case 'dateRange': {
            // { from, to, fromValue, toValue } — AMIS từ chối khoảng ngày bị đảo (từ > đến) nên đặt ô nào trước phụ thuộc vào giá trị hiện tại
            const fromLoc = page.locator(t(arg.from)).first();
            const toLoc = page.locator(t(arg.to)).first();
            const fromV = t(arg.fromValue), toV = t(arg.toValue);
            const num = (v) => { const [d, m, y] = v.split('/').map(Number); return y * 10000 + m * 100 + d; };
            const setVerified = async (loc, value) => {
              for (let attempt = 1; ; attempt++) {
                // ô ngày của AMIS chỉ nhận khi gõ phím thật (fill() không kích hoạt được)
                await loc.click();
                await page.keyboard.press('Control+A');
                await page.keyboard.type(value, { delay: 30 });
                await page.keyboard.press('Tab');
                if ((await loc.inputValue()) === value) return;
                if (attempt >= 3) throw new Error(`AMIS không nhận ngày ${value}`);
                await page.waitForTimeout(400);
              }
            };
            this.supervisor.ask({ kind: 'fill', selector: 'dateRange', value: `${fromV} - ${toV}` }).catch(() => {});
            const order = num(fromV) <= num(await toLoc.inputValue()) ? [[fromLoc, fromV], [toLoc, toV]] : [[toLoc, toV], [fromLoc, fromV]];
            for (const [loc, value] of order) await setVerified(loc, value);
            if ((await fromLoc.inputValue()) !== fromV || (await toLoc.inputValue()) !== toV) throw new Error(`khoảng ngày sau khi đặt không đúng ${fromV} – ${toV}`);
            break;
          }
          case 'setGroups': {
            // { prefix, values } — chọn đúng các Nhóm VTHH trong `values` (mã ngăn bằng '|'; rỗng = không lọc theo nhóm).
            // AMIS nhớ lựa chọn lần trước nên luôn bỏ hết nhóm đang chọn rồi chọn lại từ đầu.
            const wanted = t(arg.values).split('|').map((x) => x.trim()).filter(Boolean);
            const prefix = arg.prefix;
            const chips = page.locator(`[data-testid^='${prefix}-di-deselect-']`);
            this.supervisor.ask({ kind: 'fill', selector: 'setGroups', value: wanted.join(',') || '(tất cả nhóm)' }).catch(() => {});
            for (let n = 0; n < 40 && (await chips.count()) > 0; n++) { await chips.first().click(); await page.waitForTimeout(300); }
            if ((await chips.count()) > 0) throw new Error('không bỏ chọn hết được các nhóm cũ');
            if (wanted.length) {
              const arrow = page.locator(`[data-testid='${prefix}-di-triggerclick']`).first();
              const rows = page.locator('.dropdown-item-td--text');
              if (!(await rows.first().isVisible().catch(() => false))) await arrow.click();
              await page.waitForTimeout(800);
              for (const code of wanted) {
                const row = rows.filter({ hasText: new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
                for (let i = 0; i < 30 && !(await row.count()); i++) await this.scrollDropdown(90);
                if (!(await row.count())) throw new Error(`không thấy nhóm "${code}" trong danh sách Nhóm VTHH`);
                await row.click();
                await page.waitForTimeout(700);
              }
              if ((await chips.count()) !== wanted.length) throw new Error(`đã chọn ${await chips.count()}/${wanted.length} nhóm`);
              await arrow.click(); // đóng danh sách
              await page.waitForTimeout(500);
            }
            break;
          }
          case 'ensureChecked': { // tích ô nếu CHƯA tích (đọc trạng thái thật); không bao giờ bỏ tích. AMIS nhớ lựa chọn lần trước nên không được bấm mù.
            const label = page.locator(t(arg)).first();
            await label.waitFor({ state: 'visible' });
            const box = label.locator('input[type=checkbox]').first();
            if (!(await box.isChecked())) {
              await safeClick(t(arg));
              await page.waitForTimeout(800);
              if (!(await box.isChecked())) throw new Error(`không tích được ô "${t(arg)}"`);
            }
            break;
          }
          case 'press': await page.keyboard.press(arg); break;
          case 'wait': await page.waitForTimeout(arg); break;
          case 'waitGone': await page.locator(t(arg)).first().waitFor({ state: 'hidden' }); break;
          case 'waitFor': await page.locator(t(arg)).first().waitFor({ state: 'visible' }); break;
          case 'download': {
            // dạng rút gọn: "selector"; dạng đầy đủ: { selector, confirm?, response? }
            // confirm: nút xác nhận có thể hiện ra sau khi bấm; response: đoạn URL của yêu cầu tải file
            const spec = typeof arg === 'string' ? { selector: arg } : arg;
            if (spec.response) {
              // Lấy file trực tiếp từ phản hồi mạng (GET) có URL chứa `response`, không phụ thuộc cơ chế tải file của trình duyệt.
              const timeout = this.amis.downloadTimeoutMs ?? 120000;
              let onRoute;
              const body = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Hết ${timeout / 1000}s chờ file tải về`)), timeout);
                onRoute = async (route) => {
                  if (route.request().method() !== 'GET') return route.fallback();
                  try {
                    const res = await route.fetch();
                    if (!res.ok()) throw new Error(`Máy chủ trả mã ${res.status()} khi tải file`);
                    const buf = await res.body();
                    await route.abort().catch(() => {});
                    clearTimeout(timer);
                    resolve({ buf, url: route.request().url() });
                  } catch (e) { clearTimeout(timer); reject(e); }
                };
              });
              body.catch(() => {});
              const match = (url) => url.href.includes(spec.response);
              await page.route(match, onRoute);
              try {
                await safeClick(t(spec.selector));
                const { buf, url } = await body;
                const ext = path.extname(new URL(url).searchParams.get('file') ?? '') || '.xlsx';
                saved = path.join(this.dirs.downloads, `${fileName ?? source.id}${ext}`);
                await fs.writeFile(saved, buf);
              } finally { await page.unroute(match, onRoute).catch(() => {}); }
              break;
            }
            const pending = page.waitForEvent('download', { timeout: this.amis.downloadTimeoutMs ?? 120000 });
            pending.catch(() => {});
            await safeClick(t(spec.selector));
            if (spec.confirm) {
              const btn = page.locator(t(spec.confirm)).first();
              const shown = await btn.waitFor({ state: 'visible', timeout: spec.confirmWaitMs ?? 5000 }).then(() => true, () => false);
              if (shown) await safeClick(t(spec.confirm));
            }
            const download = await pending;
            const ext = path.extname(download.suggestedFilename()) || '.xlsx';
            saved = path.join(this.dirs.downloads, `${fileName ?? source.id}${ext}`);
            await download.saveAs(saved);
            break;
          }
          default: throw new Error(`Bước không hỗ trợ: ${action}`);
        }
      } catch (e) {
        throw new Error(`Báo cáo "${source.name}" lỗi ở bước ${i + 1} (${action}: ${JSON.stringify(arg).slice(0, 90)}): ${e.message.split('\n')[0]}`);
      }
    }
    if (!saved) throw new Error(`Báo cáo "${source.name}" chưa có bước "download" trong config.json`);
    return saved;
  }
}
