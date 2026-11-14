// Dựng nội dung báo cáo: tin nhắn Telegram (HTML) và file Excel chi tiết chênh lệch.
import ExcelJS from 'exceljs';
import { escapeHtml } from './util.js';

const ICON = { ok: '✅', fail: '❌', skipped: '⚠️' };

export function buildMessage({ title, period, datasets, results, blocked = [], targetDb, maxLines = 10 }) {
  const lines = [`📊 <b>${escapeHtml(title)}</b>`, `🗓 Kỳ: ${period.fromDate} – ${period.toDate}`];
  if (targetDb) lines.push(`🗄 Dữ liệu: ${escapeHtml(targetDb)}`);
  lines.push('');
  lines.push('<b>Nguồn dữ liệu</b>');
  for (const ds of Object.values(datasets)) {
    if (ds.error) lines.push(`• ${escapeHtml(ds.name)}: ⚠️ ${escapeHtml(ds.error)}`);
    else if (ds.missing) lines.push(`• ${escapeHtml(ds.name)}: ⚠️ chưa có file`);
    else lines.push(`• ${escapeHtml(ds.name)}: ${ds.rows.length} dòng${ds.missingFields.length ? ` (thiếu cột: ${escapeHtml(ds.missingFields.join(', '))})` : ''}`);
  }
  lines.push('', '<b>Kết quả kiểm tra chéo</b>');
  for (const r of results) {
    const head = r.status === 'ok' ? 'khớp' : r.status === 'fail' ? `${r.issues.length} vấn đề` : 'bỏ qua';
    lines.push(`${ICON[r.status]} <b>${escapeHtml(r.name)}</b>: ${head}${r.note ? ` — <i>${escapeHtml(r.note)}</i>` : ''}`);
    for (const i of r.issues.slice(0, maxLines)) {
      lines.push(`   • <code>${escapeHtml(i.key)}</code>${i.name ? ` ${escapeHtml(i.name)}` : ''}: ${escapeHtml(i.detail)}`);
    }
    if (r.issues.length > maxLines) lines.push(`   … và ${r.issues.length - maxLines} dòng khác (xem file Excel đính kèm)`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  lines.push('', fails
    ? `🔴 Kết luận: ${fails}/${results.length} phép kiểm tra có chênh lệch.`
    : skipped ? `🟡 Kết luận: không phát hiện chênh lệch, nhưng ${skipped} phép kiểm tra bị bỏ qua.`
    : '🟢 Kết luận: tất cả số liệu khớp.');
  if (blocked.length) {
    lines.push('', `🔒 Chế độ chỉ đọc đã chặn ${blocked.length} yêu cầu ghi dữ liệu:`);
    for (const b of blocked.slice(0, 5)) lines.push(`   • ${escapeHtml(b.method)} ${escapeHtml(b.url)} (${escapeHtml(b.reason)})`);
  }
  return lines.join('\n');
}

/** Ghi file Excel: mỗi phép kiểm tra có vấn đề là 1 sheet. Trả về false nếu không có gì để ghi. */
export async function writeIssuesWorkbook(file, results) {
  const wb = new ExcelJS.Workbook();
  let n = 0;
  for (const r of results) {
    if (!r.issues.length) continue;
    n++;
    const ws = wb.addWorksheet(`${n}. ${r.name}`.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31));
    const cols = [...new Set(r.issues.flatMap((i) => Object.keys(i.row)))];
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(12, c.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const i of r.issues) ws.addRow(i.row);
  }
  if (!n) return false;
  await wb.xlsx.writeFile(file);
  return true;
}
