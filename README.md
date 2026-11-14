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

> ⚠️ **Cần hiệu chỉnh 1 lần:** các bước bấm trên giao diện AMIS (`sources[].steps` trong `config.json`) mới là
> phỏng đoán, chưa được chạy với tài khoản AMIS thật. Phần còn lại (đăng nhập, tải file, đọc Excel, đối chiếu, Telegram)
> đã được kiểm thử tự động với máy chủ giả lập (`npm test`). Xem mục [Hiệu chỉnh bước xuất báo cáo](#hiệu-chỉnh-bước-xuất-báo-cáo).

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
| `goto` | `{ "goto": "https://actapp.misa.vn/app/report" }` |
| `click` | `{ "click": "text=Tổng hợp tồn kho" }` |
| `fill` | `{ "fill": { "selector": "input[placeholder*='Từ ngày']", "value": "{{fromDate}}", "enter": true } }` |
| `press` | `{ "press": "Enter" }` |
| `wait` / `waitFor` | `{ "wait": 3000 }` / `{ "waitFor": "text=Tổng cộng" }` |
| `download` | `{ "download": "text=Excel" }` — bấm vào phần tử làm trình duyệt tải file |

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
  Lưu ý: mỗi lần chạy trên GitHub là một "thiết bị mới" nên AMIS có thể đòi OTP/captcha; và file kiểm kê phải được
  commit vào repo.

### Xác thực 2 lớp

- OTP qua SMS/email: chạy `npm run login` một lần trên máy có màn hình; hồ sơ trình duyệt được giữ lại nên các lần sau
  thường không bị hỏi lại.
- Ứng dụng Authenticator: điền khoá bí mật vào `AMIS_TOTP_SECRET`, bot tự sinh mã.
- Captcha: bot không tự giải; khi gặp sẽ báo lỗi về Telegram kèm ảnh màn hình.

---

`index.html` là bản demo quét mã QR kiểm kho tĩnh ban đầu.
