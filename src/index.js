#!/usr/bin/env node
// Quy trình: đăng nhập AMIS → xuất báo cáo → đọc file → kiểm tra chéo → gửi Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { AmisSession } from './amis.js';
import { readDataset } from './excel.js';
import { runChecks } from './checks.js';
import { buildMessage, writeIssuesWorkbook, supervisionSection } from './report.js';
import { buildFacts, focusRows } from './agents/facts.js';
import { analyzeAndReview } from './agents/orchestrate.js';
import { reviewSection } from './agents/reviewer.js';
import { Telegram } from './telegram.js';
import { resolvePeriod, escapeHtml } from './util.js';

function findDownloaded(dir, id) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => path.parse(n).name === id);
  return f ? path.join(dir, f) : null;
}

export function telegramOf(config) {
  const s = config.secrets;
  return new Telegram({ token: s.telegramToken, chatId: s.telegramChatId, apiBase: s.telegramApiBase });
}

// ---- Phiên AMIS giữ ấm (chế độ bot): giữ trình duyệt đã đăng nhập thêm vài phút để các yêu cầu kế tiếp không phải đăng nhập lại ----
let warmMinutes = 0;
let warm = null; // { session, timer }
export function enableWarmSession(minutes) { warmMinutes = Number(minutes) || 0; }
function takeWarmSession() {
  if (!warm) return null;
  const { session, timer } = warm;
  clearTimeout(timer);
  warm = null;
  if (session.alive()) return session;
  session.close().catch(() => {});
  return null;
}
function keepWarmSession(session) {
  const timer = setTimeout(() => { if (warm?.session === session) { warm = null; session.close().catch(() => {}); } }, warmMinutes * 60000);
  timer.unref?.();
  warm = { session, timer };
}
export async function closeWarmSession() {
  const session = takeWarmSession();
  if (session) await session.close().catch(() => {});
}
/** Số liệu giám sát của riêng lượt này (phiên giữ ấm cộng dồn qua nhiều lượt). */
function supervisionDelta(now, before) {
  if (!now || !before) return now ?? null;
  const d = { ...now };
  for (const k of ['requests', 'denied', 'clicks', 'clicksDenied', 'fills', 'aiCalls', 'aiErrors']) d[k] = (now[k] ?? 0) - (before[k] ?? 0);
  d.deniedList = (now.deniedList ?? []).slice(before.deniedList?.length ?? 0);
  return d;
}
function setConcurrentHandler(session, config, tg) {
  if (!tg) { session.onConcurrent = null; return; }
  const timeoutMs = config.amis.concurrentDecisionMs ?? 600000;
  session.onConcurrent = (detail) => tg.ask(
    `🚨 <b>${escapeHtml(config.title)}</b>\nAMIS báo tài khoản đang được dùng ở nơi khác:\n<i>${escapeHtml(detail)}</i>\n\nNếu đăng nhập tiếp, người đang dùng sẽ bị <b>đăng xuất khỏi AMIS</b> (có thể mất dữ liệu đang nhập dở).\nBạn muốn bot đăng nhập tiếp không? Không trả lời trong ${Math.round(timeoutMs / 60000) || '<1'} phút, bot tự huỷ.`,
    { timeoutMs });
}

/**
 * Lấy dữ liệu và chạy kiểm tra chéo (chưa gửi gì).
 * @param opts.download  false = dùng lại file đã có trong thư mục downloads/
 * @param opts.onStage   hàm nhận tên giai đoạn ('login' | 'export' | 'reuse' | 'check') để hiển thị tiến độ
 */
export async function collect(config, { download = true, headed = false, log = console.log, onStage = () => {}, tg = null, period: periodOverride, sourceIds, fileKeys = {}, vars = {} } = {}) {
  const period = periodOverride ?? resolvePeriod(config.period);
  const datasets = {};
  // mặc định bỏ qua các nguồn onDemand (ví dụ báo cáo doanh số chỉ lấy khi được yêu cầu)
  const active = config.sources.filter((s) => (sourceIds ? sourceIds.includes(s.id) : !s.onDemand));
  const amisSources = active.filter((s) => s.type === 'amis');
  const files = {};
  let blocked = [];
  let supervision = null;

  // 1. Tải báo cáo từ AMIS
  if (download && amisSources.length) {
    await onStage('login');
    for (let attempt = 1; ; attempt++) {
      // Phiên giữ ấm (chỉ ở chế độ bot): dùng lại trình duyệt đã đăng nhập của lượt trước → bỏ qua khởi động + đăng nhập.
      let session = takeWarmSession();
      const reused = !!session;
      try {
        if (!session) {
          session = new AmisSession(config, { headed, log });
          await session.open();
          setConcurrentHandler(session, config, tg);
          await session.login(config.secrets);
          await session.verifyDatabase(config.secrets.targetDb);
        } else setConcurrentHandler(session, config, tg);
      } catch (e) {
        const shot = session.page ? await session.screenshot('loi-dang-nhap') : null;
        await session.close();
        if (tg) {
          await tg.sendMessage(`🚨 <b>${escapeHtml(config.title)}</b>\nKhông lấy được báo cáo từ AMIS:\n${escapeHtml(e.message)}`);
          if (shot) await tg.sendFile(shot, 'Màn hình lúc lỗi', 'sendPhoto').catch(() => {});
        }
        throw e;
      }
      const blockedFrom = session.audit?.blocked.length ?? 0;
      const before = reused ? await session.supervisor.summary().catch(() => null) : null;
      await onStage('export');
      const errors = {};
      for (const src of amisSources) {
        log(`→ Xuất báo cáo: ${src.name}`);
        try {
          files[src.id] = await session.exportReport(src, { ...period, targetDb: config.secrets.targetDb ?? '', ...vars }, { fileName: fileKeys[src.id] });
          log(`✓ Đã lưu ${path.relative(config.root, files[src.id])}`);
        } catch (e) {
          const shot = await session.screenshot(`loi-${src.id}`);
          errors[src.id] = { id: src.id, name: src.name, error: e.message, screenshot: shot };
          log(`✗ ${e.message}`);
        }
      }
      // Phiên giữ ấm có thể đã hết hạn / bị đăng xuất: lỗi (không phải "không có dữ liệu") thì đóng và làm lại 1 lần bằng phiên mới.
      if (reused && attempt === 1 && Object.values(errors).some((d) => !d.error.includes('NO_DATA'))) {
        log('→ Phiên giữ ấm không còn dùng được, đăng nhập lại…');
        await session.close();
        await onStage('login');
        continue;
      }
      Object.assign(datasets, errors);
      blocked = session.audit?.blocked.slice(blockedFrom) ?? [];
      if (warmMinutes > 0 && session.alive()) {
        supervision = supervisionDelta(await session.supervisor.summary().catch(() => null), before);
        await session.flushAudit();
        await session.page.goto('about:blank').catch(() => {}); // không để trang AMIS chạy nền trong lúc chờ
        keepWarmSession(session);
      } else {
        await session.close();
        supervision = supervisionDelta(session.supervision, before);
      }
      break;
    }
  } else {
    await onStage('reuse');
  }

  // 2. Đọc dữ liệu
  await onStage('check');
  for (const src of active) {
    if (datasets[src.id]) continue;
    const file = src.type === 'amis'
      ? files[src.id] ?? findDownloaded(config.dirs.downloads, fileKeys[src.id] ?? src.id)
      : path.resolve(config.root, src.path);
    if (!file || !fs.existsSync(file)) {
      datasets[src.id] = { id: src.id, name: src.name, missing: true };
      continue;
    }
    try {
      datasets[src.id] = { id: src.id, name: src.name, file, ...(await readDataset(file, src.parse)) };
    } catch (e) {
      datasets[src.id] = { id: src.id, name: src.name, error: e.message };
    }
  }

  // 3. Kiểm tra chéo
  const results = runChecks(config.checks, datasets);
  const facts = buildFacts({ period, targetDb: config.secrets.targetDb, datasets, results });
  const focus = focusRows(config, datasets, results);
  return { period, datasets, results, blocked, supervision, facts, focus };
}

/** Đọc danh sách Nhóm VTHH hiện có trên AMIS (chỉ đọc) và lưu vào data/nhom_vthh.json. */
export async function refreshGroups(config, { tg = null, log = () => {} } = {}) {
  const src = config.sources.find((x) => x.id === 'doanh_so');
  if (!src?.groups) throw new Error('Nguồn doanh_so chưa khai báo "groups" trong config.json');
  await closeWarmSession(); // dùng chung hồ sơ trình duyệt nên phải đóng phiên giữ ấm trước
  const session = new AmisSession(config, { log });
  if (tg) {
    const timeoutMs = config.amis.concurrentDecisionMs ?? 600000;
    session.onConcurrent = (detail) => tg.ask(`🚨 AMIS báo tài khoản đang được dùng ở nơi khác:\n<i>${escapeHtml(detail)}</i>\n\nĐăng nhập tiếp sẽ <b>đăng xuất người đó khỏi AMIS</b>. Bạn muốn bot đăng nhập tiếp không?`, { timeoutMs });
  }
  try {
    await session.open();
    await session.login(config.secrets);
    await session.verifyDatabase(config.secrets.targetDb);
    const list = await session.readItemGroups(src);
    if (!list.length) throw new Error('Không đọc được nhóm nào từ AMIS');
    const { saveGroups } = await import('./groups.js');
    saveGroups(config, list);
    return list;
  } finally { await session.close(); }
}

/** Tuổi (phút) của file AMIS cũ nhất trong downloads/, hoặc Infinity nếu thiếu file. */
export function dataAgeMinutes(config) {
  const ages = config.sources.filter((s) => s.type === 'amis' && !s.onDemand).map((s) => fileAgeMinutes(config, s.id));
  return ages.length ? Math.max(...ages) : Infinity;
}

/** Tuổi (phút) của file đã tải có tên `key`, hoặc Infinity nếu chưa có. */
export function fileAgeMinutes(config, key) {
  const f = findDownloaded(config.dirs.downloads, key);
  return f ? (Date.now() - fs.statSync(f).mtimeMs) / 60000 : Infinity;
}

/**
 * Quy trình báo cáo đầy đủ: lấy dữ liệu → kiểm tra chéo → kế toán trưởng kiểm soát → gửi Telegram.
 * @param opts.send  false = chỉ in ra màn hình, không gửi Telegram
 * @param opts.tg    dùng lại đối tượng Telegram có sẵn (bot)
 */
export async function runPipeline(config, { download = true, send = true, headed = false, log = console.log, onStage = () => {}, tg } = {}) {
  tg = send ? tg ?? telegramOf(config) : null;
  const data = await collect(config, { download, headed, log, onStage, tg });
  const { period, datasets, results, blocked, supervision, facts, focus } = data;

  const draft = buildMessage({ title: config.title, period, datasets, results, targetDb: config.secrets.targetDb, maxLines: config.maxLinesPerCheck });
  const { expert, review } = await analyzeAndReview(config, { draftHtml: draft, facts, focus, onStage });
  const message = [draft, expert.html, reviewSection(review), supervisionSection(supervision, blocked)].filter(Boolean).join('\n\n');

  fs.mkdirSync(config.dirs.output, { recursive: true });
  const stamp = period.today.split('/').reverse().join('-');
  const issuesFile = path.join(config.dirs.output, `chenh-lech-${stamp}.xlsx`);
  const hasIssues = await writeIssuesWorkbook(issuesFile, results);

  await onStage('send');
  log('\n' + message.replace(/<[^>]+>/g, '') + '\n');
  if (tg) {
    await tg.sendMessage(message);
    if (hasIssues) await tg.sendFile(issuesFile, 'Chi tiết chênh lệch');
    for (const ds of Object.values(datasets)) {
      if (ds.screenshot) await tg.sendFile(ds.screenshot, `Lỗi khi xuất: ${ds.name}`, 'sendPhoto').catch(() => {});
    }
    if (config.attachSourceFiles) {
      for (const ds of Object.values(datasets)) if (ds.file) await tg.sendFile(ds.file, ds.name);
    }
    log('✓ Đã gửi báo cáo về Telegram');
  }
  return { ...data, expert, review, message, issuesFile: hasIssues ? issuesFile : null };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith('-')) ?? 'run';
  const flag = (name) => args.includes(`--${name}`);
  const cfgIdx = args.indexOf('--config');
  const config = loadConfig(cfgIdx >= 0 ? args[cfgIdx + 1] : 'config.json');

  if (cmd === 'login') {
    // Mở trình duyệt có giao diện để đăng nhập / nhập OTP thủ công 1 lần; phiên được lưu vào .auth/profile
    const session = new AmisSession(config, { headed: true });
    await session.open();
    try {
      console.log('Hãy hoàn tất đăng nhập trong cửa sổ trình duyệt (tối đa 5 phút)…');
      await session.login({ ...config.secrets, manualWaitMs: 5 * 60 * 1000 });
      await session.verifyDatabase(config.secrets.targetDb);
      console.log('Đã lưu phiên đăng nhập. Từ giờ có thể chạy `npm start`.');
    } finally { await session.close(); }
  } else if (cmd === 'test-telegram') {
    await telegramOf(config).sendMessage('✅ Kết nối Telegram thành công — bot đối chiếu MISA AMIS đã sẵn sàng.');
    console.log('Đã gửi tin thử.');
  } else if (cmd === 'bot') {
    const { runBot } = await import('./bot.js');
    await runBot(config, { headed: flag('headed') });
  } else if (cmd === 'run') {
    const out = await runPipeline(config, { download: !flag('no-download'), send: !flag('dry-run'), headed: flag('headed') });
    if (flag('fail-on-diff') && out.results.some((r) => r.status === 'fail')) process.exitCode = 2;
  } else {
    console.log('Lệnh: run [--no-download] [--dry-run] [--headed] [--fail-on-diff] | bot | login | test-telegram   (thêm --config <file>)');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });
}
