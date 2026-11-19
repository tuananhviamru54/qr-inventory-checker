// Các phép kiểm tra chéo. Mỗi phép trả về { id, name, status, note, issues[] }.
// issue: { kind, key, name, detail, row } — detail dùng cho Telegram, row dùng cho file Excel.
import { fmtNumber } from './util.js';

function aggregate(dataset, keyFields, numFields) {
  const map = new Map();
  for (const row of dataset.rows) {
    const key = keyFields.map((k) => String(row[k]).toUpperCase()).join(' | ');
    let acc = map.get(key);
    if (!acc) { acc = { ...row }; for (const f of numFields) acc[f] = 0; map.set(key, acc); }
    for (const f of numFields) acc[f] += Number(row[f]) || 0;
  }
  return map;
}

function need(datasets, id) {
  const ds = datasets[id];
  if (!ds) return { skip: `Không có nguồn dữ liệu "${id}"` };
  if (ds.error) return { skip: `Nguồn "${ds.name}" lỗi: ${ds.error}` };
  if (ds.missing) return { skip: `Chưa có file cho nguồn "${ds.name}"` };
  return { ds };
}

function requireFields(ds, fields) {
  const miss = fields.filter((f) => ds.missingFields.includes(f));
  return miss.length ? `Nguồn "${ds.name}" thiếu cột: ${miss.join(', ')}` : null;
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** So khớp 2 nguồn theo khoá, so sánh từng cặp cột số. */
function compare(check, datasets) {
  const L = need(datasets, check.left), R = need(datasets, check.right);
  if (L.skip || R.skip) return { status: 'skipped', note: L.skip || R.skip, issues: [] };
  const lKey = check.leftKey ?? check.key, rKey = check.rightKey ?? check.key;
  const pairs = check.columns; // [{ left, right, label, tolerance }]
  const miss = requireFields(L.ds, [...lKey, ...pairs.map((p) => p.left)])
    || requireFields(R.ds, [...rKey, ...pairs.map((p) => p.right)]);
  if (miss) return { status: 'skipped', note: miss, issues: [] };

  const lMap = aggregate(L.ds, lKey, pairs.map((p) => p.left));
  const rMap = aggregate(R.ds, rKey, pairs.map((p) => p.right));
  const nameField = check.nameField ?? 'ten_hang';
  const ignoreZero = check.ignoreZeroMissing ?? true;
  const issues = [];
  for (const key of new Set([...lMap.keys(), ...rMap.keys()])) {
    const l = lMap.get(key), r = rMap.get(key);
    const name = l?.[nameField] ?? r?.[nameField] ?? '';
    if (!l || !r) {
      const have = l ?? r;
      const cols = pairs.map((p) => (l ? p.left : p.right));
      if (ignoreZero && cols.every((c) => !have[c])) continue;
      const where = l ? R.ds.name : L.ds.name;
      const row = { 'Loại': `Không có trong ${where}`, 'Mã': key, 'Tên': name };
      for (const p of pairs) {
        row[`${p.label} — ${L.ds.name}`] = l ? l[p.left] : null;
        row[`${p.label} — ${R.ds.name}`] = r ? r[p.right] : null;
        row[`${p.label} — Chênh lệch`] = null;
      }
      issues.push({
        kind: 'missing', key, name,
        detail: `không có trong ${where} (${pairs.map((p, i) => `${p.label}: ${fmtNumber(have[cols[i]])}`).join(', ')})`,
        row,
      });
      continue;
    }
    const diffs = [];
    const row = { 'Loại': 'Lệch số liệu', 'Mã': key, 'Tên': name };
    for (const p of pairs) {
      const diff = round(r[p.right] - l[p.left]);
      row[`${p.label} — ${L.ds.name}`] = l[p.left];
      row[`${p.label} — ${R.ds.name}`] = r[p.right];
      row[`${p.label} — Chênh lệch`] = diff;
      if (Math.abs(diff) > (p.tolerance ?? check.tolerance ?? 0)) {
        diffs.push(`${p.label}: ${fmtNumber(l[p.left])} → ${fmtNumber(r[p.right])} (${diff > 0 ? '+' : ''}${fmtNumber(diff)})`);
      }
    }
    if (diffs.length) issues.push({ kind: 'mismatch', key, name, detail: diffs.join('; '), row });
  }
  issues.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  const note = `${lMap.size} mã bên ${L.ds.name}, ${rMap.size} mã bên ${R.ds.name}`;
  return { status: issues.length ? 'fail' : 'ok', note, issues };
}

/** Kiểm tra cân đối trong 1 báo cáo: tổng(plus) − tổng(minus) = equals. Ví dụ đầu kỳ + nhập − xuất = cuối kỳ. */
function balance(check, datasets) {
  const S = need(datasets, check.source);
  if (S.skip) return { status: 'skipped', note: S.skip, issues: [] };
  const all = [...check.plus, ...(check.minus ?? []), check.equals];
  const miss = requireFields(S.ds, [...check.key, ...all]);
  if (miss) return { status: 'skipped', note: miss, issues: [] };
  const nameField = check.nameField ?? 'ten_hang';
  const issues = [];
  for (const r of S.ds.rows) {
    const expected = round(check.plus.reduce((s, f) => s + r[f], 0) - (check.minus ?? []).reduce((s, f) => s + r[f], 0));
    const diff = round(r[check.equals] - expected);
    if (Math.abs(diff) <= (check.tolerance ?? 0)) continue;
    const key = check.key.map((k) => r[k]).join(' | ');
    const row = { 'Loại': 'Không cân đối', 'Mã': key, 'Tên': r[nameField] ?? '' };
    for (const f of all) row[f] = r[f];
    row['Tính lại'] = expected;
    row['Chênh lệch'] = diff;
    issues.push({
      kind: 'balance', key, name: r[nameField] ?? '',
      detail: `báo cáo ghi ${fmtNumber(r[check.equals])}, tính lại ${fmtNumber(expected)} (lệch ${fmtNumber(diff)})`,
      row,
    });
  }
  return { status: issues.length ? 'fail' : 'ok', note: `${S.ds.rows.length} dòng`, issues };
}

/** Cảnh báo các dòng có giá trị cột < min (mặc định 0), ví dụ tồn kho âm. */
function negative(check, datasets) {
  const S = need(datasets, check.source);
  if (S.skip) return { status: 'skipped', note: S.skip, issues: [] };
  const miss = requireFields(S.ds, [...check.key, ...check.columns]);
  if (miss) return { status: 'skipped', note: miss, issues: [] };
  const nameField = check.nameField ?? 'ten_hang';
  const min = check.min ?? 0;
  const issues = [];
  for (const r of S.ds.rows) {
    const bad = check.columns.filter((c) => r[c] < min);
    if (!bad.length) continue;
    const key = check.key.map((k) => r[k]).join(' | ');
    const row = { 'Loại': 'Số âm', 'Mã': key, 'Tên': r[nameField] ?? '' };
    for (const c of check.columns) row[c] = r[c];
    issues.push({ kind: 'negative', key, name: r[nameField] ?? '', detail: bad.map((c) => `${c} = ${fmtNumber(r[c])}`).join('; '), row });
  }
  return { status: issues.length ? 'fail' : 'ok', note: `${S.ds.rows.length} dòng`, issues };
}

const TYPES = { compare, balance, negative };

export function runChecks(checks, datasets) {
  return checks.map((check) => {
    const fn = TYPES[check.type];
    if (!fn) return { id: check.id, name: check.name ?? check.id, status: 'skipped', note: `Loại kiểm tra không hỗ trợ: ${check.type}`, issues: [] };
    try {
      return { id: check.id, name: check.name ?? check.id, ...fn(check, datasets) };
    } catch (e) {
      return { id: check.id, name: check.name ?? check.id, status: 'skipped', note: `Lỗi: ${e.message}`, issues: [] };
    }
  });
}
