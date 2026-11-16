# Bot báo cáo MISA AMIS → Telegram

## Nguyên tắc bắt buộc (do chủ dự án đặt)
- **Chỉ đọc và xuất báo cáo.** Không ghi, sửa, xoá, ghi đè hay làm bất kỳ thao tác nào ảnh hưởng đến dữ liệu MISA AMIS.
  Mã có 2 lớp bảo vệ: chặn nút ghi trên giao diện (`src/readonly.js`) và chặn POST có đường dẫn ghi ở tầng mạng. Không được nới lỏng.
- **Không can thiệp sửa mã hay cấu hình ở hệ thống AMIS.** Chỉ thay đổi mã của dự án này.
- Tài khoản AMIS đang được người khác dùng → bot hỏi qua Telegram, **không tự đăng nhập đè**.
- Bí mật (`.env`, `.env.misa2`, `data/telegram-access.json`) không bao giờ commit, không in ra log/chat.
- Báo cáo Kết quả kinh doanh và Chi phí: **chỉ chủ bot, chỉ khi nhắn riêng**.

## Chạy
- Cần Node.js ≥ 20.12. `npm install` rồi `npx playwright install chromium`.
- Bot: `node src/index.js bot` (24/24 dùng `pm2 start src/index.js --name amis-bot -- bot`).
- Kiểm thử: `npm test`.
- Chỉ một trình duyệt cho mỗi thư mục hồ sơ (`.auth/`, `.auth-misa2/`): dừng bot trước khi chạy script khác dùng chung hồ sơ.

## Cấu trúc
- `config.json`: các nguồn báo cáo AMIS (bước bấm/xuất, cột cần đọc), `tenants` (công ty, chi nhánh, logo).
  - `qn` Kho Quảng Ninh (mặc định, `.env`).
  - `tf` The Five (`.env.misa2`, sổ "KETOAN THE FIVE T9.2026"), chi nhánh: Toàn công ty, Hà Nội, Đồng Nai, Miền Tây, Vĩnh Phúc.
  - Phạm vi "🌐 Toàn hệ thống" = The Five + Quảng Ninh (`SYSTEM_ID = 'all'`).
- `src/amis.js` điều khiển AMIS bằng Playwright; `src/index.js` thu thập (`collect`, `collectSystem`); `src/bot.js` bot Telegram.
- Báo cáo: `sales.js`, `stock.js`, `debt`, `cash.js`, `income.js` (B02), `cost.js`, `ledger.js` (chứng từ), `daily.js` (17:30).
- `src/security.js`: ẩn bí mật trong log, chỉ cho phép host MISA, giới hạn tần suất.
- `data/nhom_vthh*.json`: danh sách Nhóm VTHH từng sổ; `assets/`: logo.

## Đã làm gần đây
- Doanh số theo khách hàng chọn được Nhóm VTHH (dùng báo cáo AMIS "theo mặt hàng và khách hàng", cộng theo khách).
- Logo riêng: The Five, Đức Phú (Kho Đồng Nai), TT Miền Tây, Quảng Ninh.
- Kiểm tra cước cont: Miền Tây T10 ghi cước vào TK 6421, không phân bổ vào giá vốn (không dùng TK 1562).
  Chưa kiểm xong Miền Tây T11 và Đồng Nai T10 (xuất sổ chi tiết quá 180 giây).
