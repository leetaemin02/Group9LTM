# 🧪 Kế hoạch & Hướng dẫn Kiểm thử – WebSocket ChatMatch (Nhóm 9)

Tài liệu này cung cấp hướng dẫn kiểm thử toàn diện cho hệ thống, bao gồm kiểm thử chức năng thủ công, kiểm thử các ca biên (edge cases) và kiểm thử tải với các chỉ số đo lường hiệu năng thực tế.

---

## 1. Kiểm thử chức năng thủ công (Manual Functional Testing)

### 1.1. Chuẩn bị môi trường
1. Khởi động máy chủ:
   ```bash
   cd backend
   npm start
   ```
2. Truy cập `http://localhost:3001`. Có thể mở hai tab trên cùng máy để kiểm thử ghép cặp; mặc định server cho phép cùng IP. Đặt `DISALLOW_SAME_IP=true` nếu muốn kiểm thử bộ lọc cùng IP. Có thể dùng **Tâm sự cùng Lumi** để kiểm tra khi chỉ có một người dùng.

### 1.2. Các kịch bản kiểm thử (Test Cases)

| STT | Kịch bản kiểm thử | Thao tác thực hiện | Kết quả mong đợi |
|---|---|---|---|
| **TC-01** | Khởi động & Số người online | Mở 2 tab trình duyệt | Badge người trực tuyến ở góc phải hiển thị đúng `2`. |
| **TC-02** | Nhập biệt danh & Validate | Bỏ trống biệt danh và bấm "Bắt đầu tìm kiếm" | Hiển thị thông báo toast: "Vui lòng nhập biệt danh". |
| **TC-03** | Ghép cặp theo sở thích chung | Tab 1 chọn `Âm nhạc, Game`. Tab 2 chọn `Game, Du lịch`. Cả hai bấm tìm kiếm. | Hai bên được ghép cặp với nhau ngay lập tức, hiển thị `Sở thích chung: game`. |
| **TC-04** | Ghép cặp FIFO sau timeout | Tab 1 chọn `Sách`. Tab 2 chọn `Ẩm thực`. | Trước timeout, khác sở thích nên chưa ghép. Sau 10 giây hệ thống nới lỏng tiêu chí; nếu có nhiều người hợp lệ, người vào hàng đợi sớm nhất được chọn trước. |
| **TC-05** | Truyền nhận tin nhắn 2 chiều | Tab 1 gõ tin nhắn "Xin chào" và bấm gửi hoặc Enter | Tab 2 nhận tin nhắn tức thì có hiển thị kèm thời gian gửi. |
| **TC-06** | Chỉ báo "đang nhập…" (Typing Indicator) | Tab 1 bắt đầu gõ vào ô nhập tin | Tab 2 hiển thị hoạt ảnh ba chấm "Đối phương đang nhập…". Khi Tab 1 ngừng gõ 1.5s, chỉ báo tự biến mất. |
| **TC-07** | Phím tắt & Thao tác Bỏ qua (Skip) | Đang chat, nhấn phím `Esc` hoặc bấm nút `Bỏ qua Esc` | Phòng chat đóng, Tab của người nhấn quay lại hàng đợi tìm người mới; tab của người còn lại nhận thông báo "Đối phương đã rời phòng chat". |
| **TC-08** | Báo cáo & Chặn tạm thời (Report & Block) | Tab 1 bấm "Báo cáo", nhập lý do vi phạm và gửi; tải lại cùng tab rồi thử tìm lại | Hệ thống ghi nhận report, ngắt phòng chat, và ngăn hai phiên trình duyệt vừa ghép gặp lại nhau trong 5 phút khi `sessionStorage` còn giữ `deviceId`. |
| **TC-09** | Rate Limiting chống spam tin | Gõ và gửi liên tục hơn 5 tin nhắn trong vòng 3 giây | Máy chủ trả về lỗi "Bạn gửi tin quá nhanh, vui lòng chờ". |
| **TC-10** | Tự động kết nối lại (Exponential Backoff) | Tạm tắt mạng hoặc khởi động lại server | Client hiển thị màn hình overlay "Mất kết nối máy chủ", tự động đếm ngược để kết nối lại. Khi server mở lại, client tự phục hồi hàng đợi tìm kiếm. |

---

## 2. Kiểm thử Tải tự động (Automated Load Testing)

Hệ thống tích hợp sẵn kịch bản kiểm thử tải `tests/load-test.js` sử dụng WebSocket client tự động để mô phỏng hàng chục đến hàng trăm người dùng hoạt động đồng thời.

### 2.1. Lệnh thực thi

Kiểm thử mức cơ bản (50 clients):
```bash
node tests/load-test.js 50
```

Kiểm thử mức trung bình (100 clients):
```bash
node tests/load-test.js 100
```

Kiểm thử mức cao (200 clients, chỉ định URL máy chủ):
```bash
node tests/load-test.js 200 ws://localhost:3001
```

Mặc định máy chủ giới hạn 100 kết nối trên mỗi IP. Khi kiểm thử 200 client trên cùng máy, hãy khởi động máy chủ với giới hạn tăng riêng cho lần chạy đó:
```powershell
# Chạy trong thư mục backend
$env:MAX_CONNECTIONS_PER_IP = "250"
npm start
```
Giới hạn mặc định vẫn là 100 nếu không cấu hình biến môi trường này.

### 2.2. Các thông số đo lường hiệu năng

Sau khi chạy xong, kết quả kiểm thử được hiển thị trên bảng điều khiển và tự động xuất ra file:
`tests/load-test-results.json`

Các chỉ số quan trọng cần phân tích:

1. **Độ trễ kết nối (Connection Latency):**
   - Thời gian từ khi gửi yêu cầu HTTP Upgrade cho đến khi hoàn tất bắt tay WebSocket.
   - Thước đo: Trung bình (Avg), P50 (trung vị), P95, P99.
2. **Độ trễ ghép cặp (Matchmaking Latency):**
   - Thời gian từ khi client gửi `find_match` đến khi nhận được thông điệp `match_found`.
   - Phản ánh tốc độ xử lý của hàng đợi và giải thuật so khớp sở thích.
3. **Độ trễ tin nhắn (Message Round-Trip / Transit Latency):**
   - Thời gian chính xác tính từ lúc Client A phát tin qua WebSocket, Server định tuyến qua RoomManager, đến khi Client B nhận được tin.
   - Đạt chuẩn thời gian thực nếu độ trễ < 50ms trong môi trường mạng nội bộ hoặc < 150ms qua Internet.
4. **Tỷ lệ thành công & Tỷ lệ lỗi:**
   - Tỷ lệ kết nối thành công: `(connected / totalClients) * 100%`
   - Tỷ lệ ghép cặp thành công: `(matched / connected) * 100%`
   - Tỷ lệ lỗi: `(errors / totalClients) * 100%`

---

## 3. Số liệu kiểm thử thực nghiệm

Lần chạy ngày 2026-10-29 trên máy cục bộ với 200 client, 3 tin nhắn mỗi client và giới hạn IP tạm thời 250. Kết quả đầy đủ được ghi tại `tests/load-test-results.json`.

| Thông số | Kết quả |
|---|---:|
| **Thời gian chạy test** | 22.7 giây |
| **Kết nối thành công** | 200/200 (100%) |
| **Ghép cặp thành công** | 200/200 (100%) |
| **Tin nhắn gửi / nhận** | 600 / 600 |
| **Độ trễ kết nối (Avg / P95)** | 2.8 / 5 ms |
| **Độ trễ ghép cặp (Avg / P95 / Max)** | 175.9 / 220 / 11,973 ms |
| **Độ trễ tin nhắn (Avg / P95)** | 0.9 / 3 ms |
| **Lỗi** | 0 |

Độ trễ ghép cặp tối đa gần 12 giây là trường hợp fallback sau thời gian chờ 10 giây; phép đo không chỉ phản ánh kết nối nhanh theo sở thích.
