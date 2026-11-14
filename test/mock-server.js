// Máy chủ giả lập AMIS (trang đăng nhập + trang báo cáo có nút xuất Excel) và Telegram Bot API,
// dùng để kiểm thử toàn bộ quy trình mà không cần tài khoản thật.
import http from 'node:http';
import ExcelJS from 'exceljs';

export async function buildStockWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tổng hợp tồn kho');
  ws.addRow(['CÔNG TY TNHH DEMO']);
  ws.addRow(['TỔNG HỢP TỒN KHO']);
  ws.addRow(['Từ ngày 01/11/2026 đến ngày 14/11/2026']);
  ws.addRow([]);
  ws.addRow(['Mã hàng', 'Tên hàng', 'ĐVT', 'Đầu kỳ', '', 'Nhập kho', '', 'Xuất kho', '', 'Cuối kỳ', '']);
  ws.addRow(['', '', '', 'Số lượng', 'Giá trị', 'Số lượng', 'Giá trị', 'Số lượng', 'Giá trị', 'Số lượng', 'Giá trị']);
  for (const c of ['A', 'B', 'C']) ws.mergeCells(`${c}5:${c}6`);
  for (const [a, b] of [['D', 'E'], ['F', 'G'], ['H', 'I'], ['J', 'K']]) ws.mergeCells(`${a}5:${b}5`);
  ws.addRow(['Kho: Kho chính']);
  ws.addRow(['SP001', 'Bút bi', 'Cái', 100, 500000, 50, 250000, 30, 150000, 120, 600000]); // khớp
  ws.addRow(['SP002', 'Vở kẻ ngang', 'Quyển', 200, 0, 0, 0, 20, 0, 180, 0]);            // kiểm kê 175 → lệch
  ws.addRow(['SP003', 'Thước kẻ', 'Cái', 10, 0, 5, 0, 20, 0, -5, 0]);                    // tồn âm
  ws.addRow(['SP004', 'Tẩy', 'Cái', 40, 0, 10, 0, 5, 0, 50, 0]);                         // không cân đối (đúng là 45)
  ws.addRow(['SP005', 'Hồ dán', 'Lọ', 7, 0, 0, 0, 0, 0, '1.007,5', 0]);                  // số dạng chuỗi VN, không cân đối
  ws.addRow(['Tổng cộng', '', '', 357, 0, 65, 0, 75, 0, 1352.5, 0]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function startMock() {
  const state = { logins: [], exports: [], telegram: [], writes: [], reads: [] };
  const xlsx = await buildStockWorkbook();
  const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8">${body}`); };
  const readBody = (req) => new Promise((ok) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => ok(Buffer.concat(b))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const authed = /sid=ok/.test(req.headers.cookie ?? '');
    if (url.pathname.startsWith('/bot')) {
      const body = await readBody(req);
      const method = url.pathname.split('/').pop();
      state.telegram.push({ method, contentType: req.headers['content-type'], body: body.toString('latin1'), text: body.toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result: {} }));
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams((await readBody(req)).toString());
      state.logins.push(Object.fromEntries(form));
      if (form.get('username') === 'demo' && form.get('password') === 'secret') {
        res.writeHead(302, { 'set-cookie': 'sid=ok; Path=/; Max-Age=86400', location: '/' });
      } else res.writeHead(302, { location: '/login?err=1' });
      return res.end();
    }
    if (url.pathname === '/login') {
      return html(res, `<form method="post" action="/login"><input name="username"><input type="password" name="password"><button type="submit">Đăng nhập</button></form>`);
    }
    if (!authed) { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (url.pathname.startsWith('/api/')) {
      await readBody(req);
      (url.pathname === '/api/report/GetData' ? state.reads : state.writes).push(`${req.method} ${url.pathname}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (url.pathname === '/export') {
      state.exports.push(Object.fromEntries(url.searchParams));
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="Tong_hop_ton_kho.xlsx"',
      });
      return res.end(xlsx);
    }
    if (url.pathname === '/report') {
      return html(res, `<h1>Tổng hợp tồn kho</h1>
        <input placeholder="Từ ngày" id="f"><input placeholder="Đến ngày" id="t">
        <button onclick="document.getElementById('bar').hidden=false">Đồng ý</button>
        <button id="cat" onclick="fetch('/api/voucher/Save',{method:'POST'})">Cất</button>
        <button onclick="fetch('/api/report/GetData',{method:'POST'});fetch('/api/voucher/SaveVoucher',{method:'POST'}).catch(()=>{});fetch('/api/voucher/1',{method:'DELETE'}).catch(()=>{})">Nạp dữ liệu</button>
        <div id="bar" hidden><button onclick="document.getElementById('menu').hidden=false">Xuất khẩu</button>
        <div id="menu" hidden><a href="#" onclick="location.href='/export?from='+encodeURIComponent(f.value)+'&to='+encodeURIComponent(t.value);return false">Excel</a></div></div>`);
    }
    if (url.pathname === '/home') { state.db = url.searchParams.get('db'); return html(res, `<div id="app-home">Xin chào</div><a href="/report">Tổng hợp tồn kho</a>`); }
    return html(res, `<h2>Chọn dữ liệu kế toán</h2><a href="/home?db=HN">KHO HÀ NỘI</a> <a href="/home?db=QN">KHO QUẢNG NINH</a>`);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((ok) => server.close(ok)) };
}
