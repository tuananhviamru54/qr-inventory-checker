// Đọc file báo cáo (xlsx/csv) xuất từ MISA AMIS hoặc file kiểm kê thành danh sách dòng dữ liệu.
// Tự dò dòng tiêu đề (bỏ qua các dòng tên công ty, tên báo cáo...) và hỗ trợ tiêu đề 2 tầng
// kiểu "Đầu kỳ" > "Số lượng" | "Giá trị".
import ExcelJS from 'exceljs';
import path from 'node:path';
import { norm, parseNumber } from './util.js';

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return v.text;
    if ('error' in v) return null;
    return null;
  }
  return v;
}

async function loadGrid(file, sheet) {
  const wb = new ExcelJS.Workbook();
  const ext = path.extname(file).toLowerCase();
  let ws;
  if (ext === '.csv') {
    ws = await wb.csv.readFile(file);
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    await wb.xlsx.readFile(file);
    ws = typeof sheet === 'string' ? wb.getWorksheet(sheet) : wb.worksheets[sheet ?? 0];
  } else {
    throw new Error(`Chỉ hỗ trợ file .xlsx hoặc .csv (nhận được: ${path.basename(file)}). Hãy chọn xuất Excel dạng .xlsx.`);
  }
  if (!ws) throw new Error(`Không tìm thấy sheet "${sheet}" trong ${path.basename(file)}`);
  const grid = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => { cells[c - 1] = cellValue(cell.value); });
    grid[r - 1] = cells;
  });
  return grid.map((r) => r ?? []);
}

/** Tạo nhãn cột cho dòng tiêu đề r; nếu twoRow thì ghép thêm dòng r+1. */
function buildLabels(grid, r, twoRow) {
  const top = grid[r] ?? [];
  const sub = twoRow ? grid[r + 1] ?? [] : [];
  const width = Math.max(top.length, sub.length);
  const labels = [];
  let carry = '';
  for (let c = 0; c < width; c++) {
    let t = norm(top[c]);
    const s = norm(sub[c]);
    if (twoRow && !t && s) t = carry; // ô gộp ngang chưa được điền
    if (t) carry = t;
    const set = new Set();
    if (twoRow && s && s !== t) set.add(`${t} ${s}`.trim());
    else if (t) set.add(t);
    labels.push(set);
  }
  return labels;
}

function matchFields(labels, fields) {
  const map = {};
  for (const [name, spec] of Object.entries(fields)) {
    const aliases = (Array.isArray(spec) ? spec : spec.headers).map(norm);
    for (const alias of aliases) {
      const col = labels.findIndex((set) => set.has(alias));
      if (col >= 0) { map[name] = col; break; }
    }
  }
  return map;
}

/**
 * @param file  đường dẫn file
 * @param parse { sheet?, key: [..], fields: { ten: { headers: [..], type?: 'number'|'text' } }, skipKeyPattern? }
 */
export async function readDataset(file, parse) {
  const grid = await loadGrid(file, parse.sheet);
  const keyFields = parse.key;
  let best = null;
  for (let r = 0; r < Math.min(grid.length, 50); r++) {
    for (const twoRow of [false, true]) {
      const map = matchFields(buildLabels(grid, r, twoRow), parse.fields);
      if (!keyFields.every((k) => k in map)) continue;
      const score = Object.keys(map).length;
      if (!best || score > best.score) best = { r, twoRow, map, score };
    }
  }
  if (!best) {
    const wanted = keyFields.map((k) => (parse.fields[k]?.headers ?? parse.fields[k] ?? [k]).join(' / ')).join('; ');
    throw new Error(`Không tìm thấy dòng tiêu đề trong ${path.basename(file)} (cần cột: ${wanted}). Kiểm tra lại "headers" trong config.json.`);
  }
  const missing = Object.keys(parse.fields).filter((f) => !(f in best.map));
  const skip = new RegExp(parse.skipKeyPattern ?? '^(tong|cong|so dong|nguoi lap|ngay)\\b', 'i');
  const rows = [];
  const start = best.r + (best.twoRow ? 2 : 1);
  for (let r = start; r < grid.length; r++) {
    const raw = grid[r];
    const row = {};
    for (const [name, col] of Object.entries(best.map)) {
      const spec = parse.fields[name];
      const type = Array.isArray(spec) ? 'number' : spec.type ?? 'number';
      const v = raw[col];
      row[name] = type === 'text' || keyFields.includes(name)
        ? (v == null ? '' : String(v).trim())
        : parseNumber(v) ?? 0;
    }
    const keyVals = keyFields.map((k) => row[k]);
    if (keyVals.some((k) => !k)) continue; // dòng trống
    // dòng nhóm (vd "Kho: Kho chính"): chỉ có ô khoá, các cột khác đều trống
    const others = Object.entries(best.map).filter(([name]) => !keyFields.includes(name));
    if (others.length && others.every(([, col]) => raw[col] == null || raw[col] === '')) continue;
    if (skip.test(norm(keyVals[0]))) continue; // dòng tổng cộng
    // dòng đánh số cột (A, B, 1, 2...) ngay dưới tiêu đề
    if (r === start && /^(\(?[a-z0-9]\)?)$/i.test(keyVals[0])) continue;
    rows.push(row);
  }
  return { rows, missingFields: missing, headerRow: best.r + 1 };
}
