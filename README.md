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

### Bộ điều khiển trong Telegram

Chạy `npm run bot`: khi khởi động bot đăng ký menu lệnh của Telegram và hiện **bàn phím cố định** dưới ô nhập tin:

| Nút | Việc làm |
|---|---|
| 🔄 Lấy báo cáo mới nhất | Vào AMIS lấy dữ liệu mới (làm mới) rồi gửi báo cáo đối chiếu tồn kho (= `/moi`) |
| 📊 Báo cáo tồn kho | Báo cáo đối chiếu, dùng lại dữ liệu nếu vừa xuất trong 30 phút (= `/baocao`) |
| 💰 Báo cáo doanh số | Hiện bảng chọn kỳ: **Hôm nay · Hôm qua · Tuần này · Tháng này · Tháng trước · 📅 Tùy chọn ngày** (= `/doanhso`) |
| ❓ Hướng dẫn | Xem hướng dẫn (= `/trogiup`) |

**Báo cáo doanh số** lấy từ báo cáo *Tổng hợp bán hàng theo mặt hàng* của AMIS: doanh số bán, chiết khấu, hàng trả lại,
giảm giá, **doanh thu thuần**, tiền vốn, lãi gộp, số lượng bán và top 10 mặt hàng theo doanh thu. Mọi con số do chương
trình cộng từ file AMIS (không qua AI) và được đối chiếu với dòng "Tổng cộng" của chính AMIS (kèm kiểm tra doanh thu
thuần = doanh số − chiết khấu − trả lại − giảm giá); lệch thì báo ⚠️. Tuần tính từ thứ Hai đến hôm nay.

- **Tùy chọn ngày:** bấm 📅 sẽ hiện **lịch ngay trong tin nhắn**. Bấm ngày bắt đầu, rồi ngày kết thúc (hoặc nút "📌 Chỉ 1 ngày").
  Có nút ‹ › đổi tháng, "↩ Chọn lại ngày bắt đầu", "📍 Về tháng này", "✖ Huỷ". Ngày ở tương lai và ngày trước ngày bắt
  đầu bị khoá (hiện dấu "·"); hôm nay có dấu •. Thích gõ tay thì vẫn được: `01/11/2026 - 10/11/2026` hoặc 1 ngày
  `10/11/2026` (thiếu năm thì lấy năm nay), gõ `huỷ` để thôi. Tối đa 366 ngày.
- **Gõ tắt:** `/doanhso hôm qua`, `/doanhso 01/11/2026 - 10/11/2026`, hoặc gõ tự nhiên "doanh thu tuần này thế nào".
- Dưới mỗi báo cáo có nút **🔄 Làm mới số liệu này** (luôn lấy lại từ AMIS) và **📅 Chọn kỳ khác**. Cùng một kỳ vừa lấy
  trong 30 phút thì được dùng lại để trả lời nhanh; tin ghi rõ giờ lấy số liệu.
- Bot xử lý từng yêu cầu một; đang bận thì báo "⏳ Đang xử lý yêu cầu trước".

### Ba agent và bot hỏi–đáp

Chạy `npm run bot` để bot nghe tin nhắn Telegram (chỉ phục vụ đúng `TELEGRAM_CHAT_ID`):

| Gõ trong Telegram | Bot làm gì |
|---|---|
| `/baocao` | Lập báo cáo đối chiếu (dùng lại dữ liệu nếu vừa xuất trong `bot.maxDataAgeMinutes` phút, mặc định 30) |
| `/moi` | Như trên nhưng luôn vào AMIS lấy dữ liệu mới |
| câu hỏi bất kỳ | Ví dụ "Mã A12_2 còn tồn bao nhiêu?", "Những mã nào đang âm kho?" |

**Thanh tiến độ:** ngay khi nhận yêu cầu, bot gửi một tin liệt kê các bước (đăng nhập → xuất báo cáo → kiểm tra chéo → trợ
lý soạn trả lời → chuyên gia chốt → kế toán trưởng kiểm tra → gửi), cập nhật vài giây một lần: bước nào xong, đã chạy bao lâu, dự kiến còn
bao lâu (tính từ thời lượng các lần chạy trước, lưu ở `output/thoi-gian.json`).

**1. Agent chuyên gia phân tích** (`src/agents/expert.js`) — chuyên gia kế toán kho đối chiếu độc lập, phân tích và **chốt kết luận**.
Với báo cáo: nhận kết quả các phép kiểm tra cùng các dòng dữ liệu liên quan, tự soát lại kết luận của chương trình (báo
khớp mà dữ liệu lệch thì ghi là "HỆ THỐNG"), gom nhóm vấn đề theo mức ưu tiên, nêu giả thuyết nguyên nhân (chỉ khi có
căn cứ từ số liệu, luôn bắt đầu bằng "Có thể") và việc cần làm, rồi chốt mức độ 🟢 Ổn / 🟡 Cần chú ý / 🔴 Nghiêm trọng.
Với câu hỏi tự do: kiểm lại bản nháp của trợ lý theo bảng dữ liệu, sửa nếu sai và có thể thêm tối đa 3 câu phân tích.
Phép kiểm tra bị bỏ qua không bao giờ được chốt là "ổn".

**2. Agent kế toán trưởng** (`src/agents/reviewer.js`) — kiểm tra **độ chính xác** của toàn bộ nội dung gồm cả phần chuyên gia, không tự thêm nhận xét hay đề xuất. Nó nhận
số liệu gốc (do chương trình tính từ file AMIS) và bản nháp, đối chiếu từng con số, mã hàng và kết luận. Nếu đúng: tin
gửi đi chỉ có thêm một dòng "✔ Đã kiểm tra chéo độ chính xác". Nếu sai: với câu hỏi tự do thì trả lại cho chuyên gia/trợ lý làm lại
(tối đa `bot.maxReviewRounds` vòng); vẫn sai thì câu trả lời được gửi kèm cảnh báo "KHÔNG ĐẠT" nêu rõ điểm sai. Agent này
không được sửa số liệu trong báo cáo.

**2. Agent giám sát độc lập** (`src/supervisor.js`) — chạy thành **tiến trình riêng**, tách khỏi tiến trình điều khiển
trình duyệt, giám sát từ lúc đăng nhập. Mọi yêu cầu không phải GET gửi lên MISA và mọi lần bấm nút đều phải được nó cho
phép; nếu tiến trình giám sát chết hoặc không trả lời thì thao tác bị từ chối. Luật cứng (cấm PUT/PATCH/DELETE, cấm URL và
nút mang nghĩa ghi) luôn áp dụng và AI không gỡ được; khi có khoá Claude, endpoint/nút chưa gặp còn được AI phân loại
(đọc / xác thực / xuất báo cáo / đo lường được qua; ghi dữ liệu / ghi cài đặt / không rõ bị chặn), kết quả lưu ở
`output/giam-sat-phan-loai.json`. Nhật ký đầy đủ: `output/giam-sat.log`; tóm tắt nằm cuối mỗi tin Telegram.

**4. Agent trợ lý** (`src/agents/answer.js`) — soạn câu trả lời cho câu hỏi tự do, chỉ dựa trên bảng tồn kho vừa xuất.

**Chế độ không dùng AI** (mặc định trong `config.json`: `"ai": { "enabled": false }`): `/baocao` vẫn chạy đủ — đăng nhập,
xuất, kiểm tra chéo, gửi Telegram; giám sát vẫn chặn ghi bằng luật cứng; tin báo cáo không nhắc gì tới AI. Câu hỏi được
trả lời bằng tra cứu trực tiếp số liệu (theo mã hàng, hàng tồn âm, tổng tồn), nên con số đúng theo cách tính, không
qua AI; câu hỏi ngoài các dạng này bot trả lời bằng hướng dẫn. Muốn bật AI: đặt `ANTHROPIC_API_KEY` trong `.env` và
đổi `ai.enabled` thành `true` (hoặc xoá dòng đó).

Các agent AI cần `ANTHROPIC_API_KEY` trong `.env` (model mặc định `claude-opus-5-5`, đổi ở `ai.model` trong
`config.json`). Không có khoá: `/baocao` vẫn chạy, giám sát dùng luật cứng, tin báo cáo ghi rõ kế toán trưởng AI chưa bật,
và bot không trả lời câu hỏi tự do. Khi bật AI, bảng tồn kho và phần đầu nội dung các yêu cầu gửi lên AMIS được gửi tới
Claude API để phân tích.

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
| `npm start` | Chạy toàn bộ: đăng nhập → xuất → đối chiếu → kế toán trưởng kiểm soát → gửi Telegram. |
| `npm run bot` | Bot nghe lệnh và câu hỏi trên Telegram, có thanh tiến độ. |
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
| `click` | `{ "click": "text=Tổng hợp tồn kho" }` hoặc có điều kiện: `{ "click": { "selector": "...", "ifVisible": "...", "unlessVisible": "...", "optional": true, "timeout": 15000 } }` (`optional`: chờ tối đa `timeout`, không thấy thì bỏ qua) |
| `fill` | `{ "fill": { "selector": "input[placeholder*='Từ ngày']", "value": "{{fromDate}}", "enter": true } }` |
| `fill` (nâng cao) | `{ "fill": { "selector": "...", "value": "{{fromDate}}", "tab": true, "verify": true } }` — `tab`: bấm Tab sau khi điền; `verify`: đọc lại giá trị, AMIS không nhận thì thử lại (ô ngày của AMIS đôi khi bỏ qua lần điền đầu) |
| `dateRange` | `{ "dateRange": { "from": "...", "to": "...", "fromValue": "{{fromDate}}", "toValue": "{{toDate}}" } }` — đặt khoảng ngày, tự chọn thứ tự điền để AMIS không từ chối (từ > đến), đọc lại để xác nhận |
| `ensureChecked` | `{ "ensureChecked": "label:has-text('Chọn tất cả vật tư')" }` — tích ô nếu chưa tích (AMIS nhớ lựa chọn lần trước nên không bấm mù) |
| `press` | `{ "press": "Enter" }` |
| `wait` / `waitFor` / `waitGone` | `{ "wait": 3000 }` / `{ "waitFor": "text=Tổng cộng" }` / `{ "waitGone": "button:has-text('Xem báo cáo')" }` (chờ phần tử biến mất) |
| `download` | `{ "download": { "selector": "text=\"Tải tệp\"", "response": "/file-access/download" } }` — bấm rồi lưu file từ phản hồi mạng có URL chứa `response`. Dạng `{ "download": "selector" }` dùng cơ chế tải file của trình duyệt. |

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

### Một tài khoản, một phiên (quan trọng)

MISA chỉ cho **một phiên đăng nhập cho mỗi tài khoản**: đăng nhập ở nơi mới sẽ đẩy phiên cũ ra. Nếu bot dùng chung tài
khoản với người thật, mỗi lần chạy có thể làm người đó bị văng khỏi AMIS (mất dữ liệu đang nhập dở). Cách tốt nhất vẫn là
**tạo một tài khoản AMIS riêng cho bot**, chỉ có quyền xem/xuất báo cáo.

Khi AMIS hỏi "Đang có người dùng khác sử dụng tài khoản này", bot **dừng lại và hỏi bạn trên Telegram** (kèm thiết bị/IP
đang dùng) với hai nút:
- **✅ Đăng nhập tiếp**: bot mới bấm "Tiếp tục đăng nhập" (người kia bị đăng xuất), rồi làm việc bình thường.
- **⛔ Huỷ**: bot dừng, không đụng tới phiên của người kia.

Không bấm gì trong `amis.concurrentDecisionMs` (mặc định 10 phút) thì bot **tự huỷ**. Chỉ bấm của đúng chat
`TELEGRAM_CHAT_ID` mới được tính. Chạy không có Telegram (ví dụ `--dry-run`) thì luôn huỷ. Mọi quyết định được ghi vào
`output/giam-sat.log`. Đây là lần bấm duy nhất được phép với nút này; với mọi thao tác khác nó vẫn nằm trong danh sách cấm.

### Xác thực 2 lớp

- OTP qua SMS/email (MISA hỏi khi đăng nhập từ thiết bị mới): chạy `npm run login` một lần trên máy có màn hình, nhập
  mã và tích "Không hỏi lại trên thiết bị này"; hồ sơ trình duyệt ở `.auth/profile` được giữ lại nên các lần sau không
  bị hỏi lại.
- Ứng dụng Authenticator: điền khoá bí mật vào `AMIS_TOTP_SECRET`, bot tự sinh mã.
- Captcha: bot không tự giải; khi gặp sẽ báo lỗi về Telegram kèm ảnh màn hình.

---

`index.html` là bản demo quét mã QR kiểm kho tĩnh ban đầu.
