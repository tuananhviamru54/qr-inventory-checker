// Gom số liệu gốc (đã tính bằng code, không qua AI) để đưa cho các agent làm căn cứ.

const NUM = (rows, f) => Math.round(rows.reduce((s, r) => s + (Number(r[f]) || 0), 0) * 1e4) / 1e4;

export function buildFacts({ period, targetDb, datasets, results }) {
  return {
    ky_bao_cao: `${period.fromDate} - ${period.toDate}`,
    du_lieu_ke_toan: targetDb ?? null,
    nguon: Object.values(datasets).map((ds) => {
      if (ds.error) return { ten: ds.name, loi: ds.error };
      if (ds.missing) return { ten: ds.name, trang_thai: 'chưa có file' };
      const numeric = Object.keys(ds.rows[0] ?? {}).filter((k) => typeof ds.rows[0][k] === 'number');
      return { ten: ds.name, so_dong: ds.rows.length, tong: Object.fromEntries(numeric.map((f) => [f, NUM(ds.rows, f)])) };
    }),
    kiem_tra: results.map((r) => ({
      ten: r.name,
      ket_qua: r.status === 'ok' ? 'khớp' : r.status === 'fail' ? 'có vấn đề' : 'bỏ qua',
      ghi_chu: r.note ?? '',
      so_van_de: r.issues.length,
      van_de: r.issues.slice(0, 60).map((i) => ({ ma: i.key, ten: i.name, chi_tiet: i.detail })),
    })),
  };
}

/** Bảng dữ liệu dạng CSV gọn để trợ lý tra cứu khi trả lời câu hỏi. */
export function datasetCsv(ds) {
  if (!ds?.rows?.length) return '';
  const cols = Object.keys(ds.rows[0]);
  const esc = (v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.join(','), ...ds.rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
