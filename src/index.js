#!/usr/bin/env node
// Quy trình: đăng nhập AMIS → xuất báo cáo → đọc file → kiểm tra chéo → gửi Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { AmisSession } from './amis.js';
import { readDataset } from './excel.js';
import { runChecks } from './checks.js';
import { buildMessage, writeIssuesWorkbook } from './report.js';
import { Telegram } from './telegram.js';
import { resolvePeriod, escapeHtml } from './util.js';

function findDownloaded(dir, id) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => path.parse(n).name === id);
  return f ? path.join(dir, f) : null;
}

function telegramOf(config) {
  const s = config.secrets;
  return new Telegram({ token: s.telegramToken, chatId: s.telegramChatId, apiBase: s.telegramApiBase });
}

/**
 * @param opts.download  false = dùng lại file đã có trong thư mục downloads/
 * @param opts.send      false = chỉ in ra màn hình, không gửi Telegram
 */
export async function runPipeline(config, { download = true, send = true, headed = false, log = console.log } = {}) {
  const period = resolvePeriod(config.period);
  const tg = send ? telegramOf(config) : null;
  const datasets = {};
  const amisSources = config.sources.filter((s) => s.type === 'amis');
  const files = {};
  let blocked = [];

  // 1. Tải báo cáo từ AMIS
  if (download && amisSources.length) {
    const session = new AmisSession(config, { headed, log });
    try {
      await session.open();
      await session.login(config.secrets);
      for (const src of amisSources) {
        log(`→ Xuất báo cáo: ${src.name}`);
        try {
          files[src.id] = await session.exportReport(src, period);
          log(`✓ Đã lưu ${path.relative(config.root, files[src.id])}`);
        } catch (e) {
          const shot = await session.screenshot(`loi-${src.id}`);
          datasets[src.id] = { id: src.id, name: src.name, error: e.message, screenshot: shot };
          log(`✗ ${e.message}`);
        }
      }
    } catch (e) {
      const shot = session.page ? await session.screenshot('loi-dang-nhap') : null;
      await session.close();
      if (tg) {
        await tg.sendMessage(`🚨 <b>${escapeHtml(config.title)}</b>\nKhông lấy được báo cáo từ AMIS:\n${escapeHtml(e.message)}`);
        if (shot) await tg.sendFile(shot, 'Màn hình lúc lỗi', 'sendPhoto').catch(() => {});
      }
      throw e;
    }
    blocked = session.audit?.blocked ?? [];
    await session.close();
  }

  // 2. Đọc dữ liệu
  for (const src of config.sources) {
    if (datasets[src.id]) continue;
    const file = src.type === 'amis'
      ? files[src.id] ?? findDownloaded(config.dirs.downloads, src.id)
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
  const message = buildMessage({ title: config.title, period, datasets, results, blocked, maxLines: config.maxLinesPerCheck });
  fs.mkdirSync(config.dirs.output, { recursive: true });
  const stamp = period.today.split('/').reverse().join('-');
  const issuesFile = path.join(config.dirs.output, `chenh-lech-${stamp}.xlsx`);
  const hasIssues = await writeIssuesWorkbook(issuesFile, results);

  // 4. Gửi Telegram
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
  return { period, datasets, results, message, blocked, issuesFile: hasIssues ? issuesFile : null };
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
      console.log('Đã lưu phiên đăng nhập. Từ giờ có thể chạy `npm start`.');
    } finally { await session.close(); }
  } else if (cmd === 'test-telegram') {
    await telegramOf(config).sendMessage('✅ Kết nối Telegram thành công — bot đối chiếu MISA AMIS đã sẵn sàng.');
    console.log('Đã gửi tin thử.');
  } else if (cmd === 'run') {
    const out = await runPipeline(config, { download: !flag('no-download'), send: !flag('dry-run'), headed: flag('headed') });
    if (flag('fail-on-diff') && out.results.some((r) => r.status === 'fail')) process.exitCode = 2;
  } else {
    console.log('Lệnh: run [--no-download] [--dry-run] [--headed] [--fail-on-diff] | login | test-telegram   (thêm --config <file>)');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });
}
