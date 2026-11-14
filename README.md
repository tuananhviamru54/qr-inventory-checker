# qr-inventory-checker

## Bot đối chiếu MISA AMIS → Telegram

Ứng dụng tự động:

1. **Đăng nhập** MISA AMIS bằng trình duyệt tự động (Playwright).
2. **Xuất báo cáo** ra file Excel (mặc định: *Tổng hợp tồn kho*).
3. **Kiểm tra chéo** số liệu:
   - Tồn kho AMIS ↔ file kiểm kê thực tế (`data/kiem_ke.xlsx`)
   - Cân đối: đầu kỳ + nhập − xuất = cuối kỳ
   - Cảnh báo tồn kho âm
4. **Gửi kết quả về Telegram**: tin tóm tắt + file Excel chi tiết chênh lệch. Nếu đăng nhập/xuất báo cáo lỗi, bot gửi thông báo lỗi kèm ảnh chụp màn hình.

> Các bước trong `config.json` đã được chạy thật với AMIS Kế toán (`actapp.misa.vn`): đăng nhập, mở báo cáo
> *Tổng hợp tồn kho*, đặt kỳ, chọn tất cả kho, xuất Excel (dạng dữ liệu) và tải file. Nếu MISA đổi giao diện, xem mục
> [Hiệu chỉnh bước xuất báo cáo](#hiệu-chỉnh-bước-xuất-báo-cáo).

### Nguyên tắc cốt lõi: CHỈ ĐỌC

Bot chỉ đọc và xuất báo cáo, không ghi đè hay thao tác làm thay đổi dữ liệu AMIS. Có hai lớp chặn luôn bật,
không có tuỳ chọn tắt (`src/readonly.js`):

1. **Lớp giao diện** — trước mỗi lần bấm, bot đọc chữ trên nút; nếu là thao tác ghi (Cất, Lưu, Ghi sổ, Bỏ ghi, Xoá,
   Sửa, Thêm, Nhân bản, Nhập khẩu, Duyệt, Kết chuyển, Khoá sổ, Tính giá, Cập nhật...) thì từ chối và báo lỗi.
   Phím bấm chỉ cho phép Enter/Escape/Tab/mũi tên. Bot chỉ điền vào ô tham số báo cáo (ngày tháng).
2. **Lớp mạng** — chặn mọi yêu cầu `PUT`/`PATCH`/`DELETE`, và các yêu cầu `POST` có đường dẫn mang nghĩa ghi
   (save, insert, update, delete, post, import, upload, approve...). Yêu cầu bị chặn được nêu trong tin Telegram;
   mọi yêu cầu không phải GET đều được ghi vào `output/nhat-ky-yeu-cau.log` để rà soát.

Nếu một yêu cầu *đọc* hợp lệ bị chặn nhầm (báo cáo không tải được), thêm mẫu URL vào `amis.readOnly.allowPost`
trong `config.json` sau khi đã chắc chắn nó chỉ đọc dữ liệu. Hiện có đúng một ngoại lệ:
`/api/export/v1/export/save_param` — đây là lệnh AMIS dùng để tạo file Excel xuất ra (lưu tham số của lần xuất, không
đụng tới chứng từ hay sổ sách); thiếu nó thì không xuất được.

Trang AMIS tự gửi vài yêu cầu nền khi mở (ví dụ lưu bố cục thanh bên `layout/slidebar/save`); các yêu cầu này bị chặn
và được liệt kê cuối tin Telegram — đó là hoạt động bình thường của lớp chặn.

> Lớp chặn mạng dựa trên từ khoá trong URL nên không thể bảo đảm tuyệt đối với API nội bộ của AMIS. **Bảo đảm chắc
> chắn nhất là dùng một tài khoản AMIS riêng chỉ được phân quyền Xem/In/Xuất báo cáo** — khi đó chính AMIS từ chối
> mọi thao tác ghi. Lưu ý `npm run codegen` là trình duyệt do bạn tự thao tác, không có lớp chặn này.

### Cài đặt

Cần Node.js ≥ 20.12.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # rồi điền tài khoản AMIS và Telegram
```

- **Telegram:** chat với [@BotFather](https://t.me/BotFather) → `/newbot` để lấy `TELEGRAM_BOT_TOKEN`. Nhắn 1 tin cho bot
  (hoặc thêm bot vào nhóm), rồi mở `https://api.telegram.org/bot<TOKEN>/getUpdates` để lấy `chat.id`.
  Thử kết nối: `npm run test-telegram`.
- **Dữ liệu kế toán:** đặt `AMIS_TARGET_DB="TÊN DỮ LIỆU"` trong `.env`; sau khi đăng nhập bot kiểm tra tên dữ liệu đang
  mở trên thanh tiêu đề AMIS, nếu không đúng thì dừng (bot không tự chuyển dữ liệu — hãy chuyển bằng `npm run login`). Cũng chấp nhận bộ tên biến `MISA_WEB_USERNAME`,
  `MISA_WEB_PASSWORD`, `MISA_WEB_TARGET_DB`. Trong `steps` dùng được biến `{{targetDb}}`.
- **AMIS:** nên tạo một tài khoản riêng chỉ có quyền *xem báo cáo*. Mật khẩu chỉ nằm trong `.env` (không đưa lên git).

### Sử dụng

| Lệnh | Tác dụng |
|---|---|
| `npm run login` | Mở trình duyệt có giao diện để đăng nhập / nhập OTP thủ công 1 lần. Phiên được lưu ở `.auth/profile`. |
| `npm start` | Chạy toàn bộ: đăng nhập → xuất → đối chiếu → gửi Telegram. |
| `npm run dry-run` | Như trên nhưng chỉ in kết quả ra màn hình, không gửi Telegram. |
| `npm run check` | Không vào AMIS; dùng lại file đã có trong `downloads/` (có thể tự chép file xuất tay vào `downloads/ton_kho.xlsx`). |
| `npm test` | Kiểm thử với AMIS + Telegram giả lập. |

Thêm `--headed` để xem trình duyệt chạy, `--fail-on-diff` để lệnh trả mã lỗi khi có chênh lệch.

**File kiểm kê:** đặt tại `data/kiem_ke.xlsx` (hoặc `.csv`), gồm các cột `Mã hàng`, `Tên hàng`, `Số lượng thực tế`
(mẫu: `data/kiem_ke.mau.csv`). Cùng một mã xuất hiện nhiều dòng sẽ được cộng dồn. Nếu chưa có file, phép so sánh này
được bỏ qua, các phép còn lại vẫn chạy.

### Hiệu chỉnh bước xuất báo cáo

Mỗi báo cáo AMIS là một mục trong `sources` của `config.json`, với danh sách `steps` chạy lần lượt:

| Bước | Ví dụ |
|---|---|
| `goto` | `{ "goto": "https://actapp.misa.vn/app/RP/ReportList/RPDynamicViewer/INInventoryBalanceSummary" }` |
| `click` | `{ "click": "text=Tổng hợp tồn kho" }` hoặc có điều kiện: `{ "click": { "selector": "...", "ifVisible": "...", "unlessVisible": "..." } }` |
| `fill` | `{ "fill": { "selector": "input[placeholder*='Từ ngày']", "value": "{{fromDate}}", "enter": true } }` |
| `press` | `{ "press": "Enter" }` |
| `wait` / `waitFor` | `{ "wait": 3000 }` / `{ "waitFor": "text=Tổng cộng" }` |
| `download` | `{ "download": "text=\"Tải tệp\"" }` — bấm vào phần tử làm trình duyệt tải file (dạng đầy đủ: `{ "selector": "...", "confirm": "nút xác nhận nếu hiện" }`) |

Biến dùng được: `{{fromDate}}`, `{{toDate}}`, `{{today}}` (dd/MM/yyyy), tính theo `period`:
`today`, `yesterday`, `thisMonth`, `lastMonth`, `thisYear` hoặc `{ "from": "01/01/2026", "to": "31/01/2026" }`.

Cách lấy đúng selector: chạy `npm run codegen`, thao tác xuất báo cáo bằng tay trong cửa sổ hiện ra, Playwright sẽ ghi
lại selector từng lần bấm — chép sang `steps`. Sau đó chạy `npm run dry-run -- --headed` để xem bot làm lại.

Nếu trang đăng nhập không được nhận diện đúng, khai báo lại trong `amis.selectors`
(`username`, `password`, `submit`, `otp`, `loggedIn`).

### Thêm báo cáo / phép kiểm tra

- Thêm nguồn vào `sources` (`type: "amis"` có `steps`, hoặc `type: "file"` có `path`). Trong `parse.fields`, mỗi trường
  khai báo các tên cột có thể gặp (`headers`); tiêu đề 2 tầng ghi dạng `"Cuối kỳ Số lượng"`. Dòng tiêu đề, dòng nhóm và
  dòng tổng cộng được tự nhận diện.
- Các loại phép kiểm tra trong `checks`:
  - `compare` — so khớp 2 nguồn theo `key`, so từng cặp cột trong `columns` (có `tolerance`).
  - `balance` — trong 1 nguồn: tổng `plus` − tổng `minus` = `equals`.
  - `negative` — cảnh báo giá trị cột nhỏ hơn `min` (mặc định 0).

### Chạy tự động hằng ngày

- **Máy tính / máy chủ riêng (khuyên dùng):** thêm vào crontab, ví dụ 7h30 thứ 2–7:
  `30 7 * * 1-6 cd /duong/dan/qr-inventory-checker && npm start >> output/cron.log 2>&1`
  (Windows: dùng Task Scheduler chạy `npm start`.)
- **GitHub Actions:** đã có sẵn `.github/workflows/doi-chieu.yml`. Khai báo các secret `AMIS_USERNAME`, `AMIS_PASSWORD`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (và `AMIS_TOTP_SECRET` nếu có), rồi tạo biến `AMIS_ENABLED=true` để bật.
  Lưu ý: mỗi lần chạy trên GitHub là một "thiết bị mới" nên MISA sẽ đòi mã OTP gửi về email — cách này chỉ dùng được
  nếu tài khoản xác thực bằng Authenticator (`AMIS_TOTP_SECRET`); và file kiểm kê phải được commit vào repo.

### Xác thực 2 lớp

- OTP qua SMS/email (MISA hỏi khi đăng nhập từ thiết bị mới): chạy `npm run login` một lần trên máy có màn hình, nhập
  mã và tích "Không hỏi lại trên thiết bị này"; hồ sơ trình duyệt ở `.auth/profile` được giữ lại nên các lần sau không
  bị hỏi lại.
- Ứng dụng Authenticator: điền khoá bí mật vào `AMIS_TOTP_SECRET`, bot tự sinh mã.
- Captcha: bot không tự giải; khi gặp sẽ báo lỗi về Telegram kèm ảnh màn hình.

---

`index.html` là bản demo quét mã QR kiểm kho tĩnh ban đầu.
