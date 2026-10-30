# 🏛️ Kiến trúc Hệ thống – WebSocket ChatMatch (Nhóm 9)

Tài liệu này trình bày chi tiết nguyên lý hoạt động, cấu trúc phân lớp và các cơ chế xử lý cốt lõi của hệ thống trò chuyện thời gian thực.

---

## 1. Tổng quan về WebSocket so với HTTP truyền thống

### 1.1. Hạn chế của HTTP / Polling trong giao tiếp thời gian thực
- **HTTP/1.1 Request-Response:** Mô hình giao tiếp một chiều do Client khởi tạo. Server không thể chủ động đẩy (push) dữ liệu xuống Client nếu không nhận được request.
- **Short Polling:** Client liên tục gửi request định kỳ (ví dụ mỗi giây) → Lãng phí băng thông lớn do HTTP header lặp đi lặp lại và tạo tải CPU không cần thiết trên Server.
- **Long Polling:** Client gửi request, Server treo kết nối cho đến khi có dữ liệu mới. Mặc dù giảm số lượng request so với Short Polling, nhưng mỗi lần có message mới kết nối lại bị đóng và mở lại, tạo độ trễ kết nối TCP đáng kể.

### 1.2. Ưu thế của WebSocket (RFC 6455)
- **Full-Duplex (Hai chiều đồng thời):** Cả Client và Server đều có thể gửi dữ liệu bất kỳ lúc nào mà không cần chờ yêu cầu từ phía đối diện.
- **Duy trì một kết nối TCP duy nhất:** Sau khi bắt tay ban đầu thành công, kết nối TCP được giữ mở liên tục.
- **Frame Overhead cực thấp:** Mỗi frame WebSocket chỉ tốn 2 đến 10 bytes header so với hàng trăm đến hàng nghìn bytes của HTTP header.
- **Độ trễ thấp:** Dữ liệu truyền nhận gần như tức thời (vài miligiây), tối ưu cho các ứng dụng trò chuyện trực tuyến, game và tài chính.

---

## 2. Quá trình bắt tay (Handshake) & Nâng cấp kết nối

WebSocket khởi đầu bằng một yêu cầu HTTP tiêu chuẩn sử dụng cơ chế **HTTP Upgrade**:

```http
GET / HTTP/1.1
Host: localhost:3001
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

Khi Server đồng ý nâng cấp, nó phản hồi mã `101 Switching Protocols`:

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

Sau bước này, giao thức HTTP kết thúc trên socket đó và chuyển sang đóng gói nhị phân dạng khung (Frames) theo đặc tả RFC 6455.

---

## 3. Kiến trúc Phân tầng Hệ thống

```
+-------------------------------------------------------------------+
|                    TRÌNH DUYỆT (FRONTEND CLIENT)                  |
|             frontend/index.html + style.css + script.js           |
+──────────────────────────────────┬────────────────────────────────+
                  HTTP (tải giao diện)│WebSocket (chat thời gian thực)
                                   ▼
+───────────────────────────────────────────────────────────────────+
|                       BACKEND (NODE.JS SERVER)                    |
|                                                                   |
|  [ backend/server.js ] - HTTP server + WebSocket endpoint         |
|   ├─ Bảo vệ: Quota kết nối tổng & Quota theo IP                   |
|   ├─ Heartbeat: Kiểm tra định kỳ Ping/Pong (30s)                  |
|   ├─ Phục vụ file tĩnh từ frontend/ (HTML/CSS/JS)                 |
|                                                                   |
|  [ protocol.js ] - Định nghĩa và thẩm định thông điệp             |
|   ├─ Thẩm định cấu trúc và kiểu dữ liệu JSON                      |
|   └─ Giới hạn độ dài chuỗi, chống XSS                             |
|                                                                   |
|  [ matchmaker.js ] - Hàng đợi ghép cặp thông minh                 |
|   ├─ So khớp danh sách sở thích (Interests intersection)          |
|   ├─ Nới lỏng tiêu chí theo thời gian chờ (Strict Timeout 10s)    |
|   └─ Kiểm tra trạng thái chặn tạm (Block check)                   |
|                                                                   |
|  [ roomManager.js ] - Quản lý phòng chat 1-1                     |
|   ├─ Ghép đôi Client A <---> Client B                             |
|   └─ Xử lý dọn phòng khi một bên rời đi                          |
|                                                                   |
|  [ moderation.js ] - An toàn & Chống lạm dụng                     |
|   ├─ Rate Limiting (Token Bucket / Sliding Window: 5 msgs / 3s)   |
|   ├─ Tiếp nhận và lưu trữ báo cáo (Reports)                       |
|   └─ Chặn tạm thời (Temporary Block 5 phút)                       |
+-------------------------------------------------------------------+
```

---

## 4. Quản lý vòng đời kết nối & Trạng thái Client

### 4.1. Máy trạng thái (State Machine) của Client
1. **CONNECTED:** Kết nối WebSocket thành công, đã đăng ký biệt danh nhưng chưa tham gia ghép cặp.
2. **WAITING:** Đang nằm trong hàng đợi của `Matchmaker`, chờ tìm đối tác phù hợp.
3. **CHATTING:** Đã được ghép đôi vào một phòng chat 1-1 cụ thể trong `RoomManager`.

### 4.2. Cơ chế Heartbeat (Ping/Pong)
- **Vấn đề:** Khi cáp mạng bị rút hoặc mạng di động đổi sóng đột ngột, TCP connection có thể trở thành kết nối "ma" (half-open connection), Server vẫn nghĩ socket còn mở.
- **Giải pháp:**
  1. Mỗi 30 giây, Server duyệt qua tất cả client và gửi khung `Ping`.
  2. Đồng thời đánh dấu `client.isAlive = false`.
  3. Khi nhận khung `Pong` trả lời từ Client, server cập nhật lại `client.isAlive = true`.
  4. Nếu ở chu kỳ tiếp theo `client.isAlive` vẫn là `false`, Server lập tức gọi `client.ws.terminate()` và giải phóng tài nguyên.

### 4.3. Cơ chế Tự động Kết nối lại (Exponential Backoff)
Ở phía Client:
- Khi phát hiện mất kết nối (`ws.onclose`), Client không spam kết nối lại liên tục.
- Sử dụng công thức: `delay = min(BASE * 2^attempts, MAX_DELAY)` (với `BASE = 1000ms`, `MAX_DELAY = 30000ms`).
- Giao diện hiển thị đếm ngược trực quan và nút "Thử lại ngay".
- Khi kết nối thành công trở lại, nếu trước đó đang ở màn hình chờ (`waiting`), Client tự động gửi lại lệnh `find_match` để không bị kẹt.

---

## 5. Thuật toán Ghép cặp (Matchmaking Algorithm) & Chống Ghép Cố Ý

Hệ thống kết hợp giữa **ghép theo tâm trạng**, **ghép theo sở thích**, **nới lỏng theo thời gian**, và **chống người dùng dùng tool để cố ý ghép cặp với nhau**:

1. **Khởi tạo:** Khi Client gửi `find_match`, một bản ghi `WaitingEntry` được đưa vào hàng đợi:
   ```js
   { clientId, nickname, interests, mood, clientIp, joinedAt: Date.now() }
   ```

2. **Công thức tính điểm tương thích (Compatibility Score):**
   - **Tâm trạng (Mood):** Nếu cả 2 cùng chọn một tâm trạng cụ thể (không phải `ngau_nhien`) $\rightarrow$ cộng **+2 điểm**.
   - **Sở thích chung (Common Interests):** Mỗi sở thích trùng nhau $\rightarrow$ cộng **+1 điểm**.

3. **Cơ chế Chống Tool và Cố ý Ghép cặp (Anti-Targeted Pairing):**
   - **Chống cùng IP (`DISALLOW_SAME_IP`):** Ngăn chặn kẻ xấu mở 2 trình duyệt/socket trên cùng máy để tự bắt cặp riêng tư hoặc khai thác phòng chat ẩn danh.
   - **FIFO khi bằng điểm và khi nới lỏng:** Trước timeout, chọn ứng viên có điểm tương thích cao nhất; nếu bằng điểm thì giữ ứng viên vào hàng đợi sớm hơn. Khi một bên đã chờ đủ 10 giây, chọn ứng viên hợp lệ đầu tiên theo FIFO.
   - **Anti-Skip Spam Cooldown:** Nếu người dùng/bot cố tình bấm "Bỏ qua" liên tục (> 5 lần trong 30 giây) để dò tìm đối tượng mong muốn, hệ thống sẽ tự động kích hoạt hình phạt cooldown 30 giây, từ chối yêu cầu tìm mới.

4. **Chế độ Nghiêm ngặt (Strict Mode - dưới 10 giây):**
   - Chỉ ghép những người có điểm số tương thích $\ge 1$ (cùng tâm trạng hoặc có ít nhất 1 sở thích chung).
   - Bỏ qua các ứng viên đang nằm trong danh sách chặn tạm (`moderation.isBlocked()`); block report kéo dài 5 phút và được nhận diện theo `deviceId` khi có.

5. **Chế độ Nới lỏng (Relaxed Mode - sau 10 giây):**
   - Nếu một bên đã chờ đủ 10 giây mà không tìm được người cùng gu, hệ thống nới lỏng điều kiện và ghép với ứng viên hợp lệ đầu tiên theo FIFO để tránh chờ vô hạn.

6. **Bộ quét định kỳ (Periodic Scanner):**
   - Mỗi 3 giây, Matchmaker duyệt lại các ứng viên chờ lâu nhất để thực hiện ghép nới lỏng ngay khi có người mới vào hoặc timeout xảy ra.

---

## 6. Cơ chế An toàn & Kiểm duyệt Nội dung Tự động (Content Moderation & Auto-Kick)

1. **Bộ lọc ngôn từ thô tục, xúc phạm & Chat đen (`contentFilter.js`):**
   - Nhận diện các từ chửi thề, lăng mạ, phân biệt xúc phạm danh dự.
   - Chặn đứng các hành vi biến tướng làm phòng chat 18+, gạ gẫm tình dục ("chat sex", show cam, gọi đồi trụy).
   - **Chống lách luật (De-obfuscation):** Kẻ xấu thường cố tình chèn dấu chấm, dấu gạch dưới, khoảng trắng giữa các chữ cái (ví dụ: `c.ặ.c`, `đ.ị.t`, `c ặ c`, `l ồ n`). Bộ lọc tự động bóc tách các ký tự ngụy trang và đối chiếu với danh mục từ cấm nghiêm ngặt.

2. **Cơ chế Trục xuất Tức thì (Instant Kick) & Khóa tạm thời (Ban 10 phút):**
   - Ngay khi phát hiện tin nhắn vi phạm, socket gửi tin sẽ bị **buộc rời khỏi phòng chat ngay lập tức** qua thông điệp `kicked`.
   - Hệ thống tự động ghi nhận lệnh **Ban tạm thời 10 phút** cả `clientId` lẫn địa chỉ `IP` của người vi phạm. Trong thời gian này, mọi yêu cầu tìm phòng mới (`find_match`) đều bị chặn đứng với mã lỗi `BANNED`.
   - Phòng chat được giải phóng an toàn, đối tác trò chuyện nhận thông báo hệ thống giải thích rõ đối phương đã bị trục xuất vì vi phạm tiêu chuẩn cộng đồng, giúp người dùng an tâm và không bị bối rối.

3. **Giới hạn kích thước gói tin (WebSocket Max Payload):**
   - Cấu hình `maxPayload: 4096` (4KB) ngăn chặn các cuộc tấn công gửi gói tin khổng lồ làm tràn RAM máy chủ.

4. **Giới hạn kết nối trên mỗi địa chỉ IP (Per-IP Rate Limit):**
   - Ngăn chặn một máy tính mở hàng trăm kết nối ảo gây cạn kiệt socket.

5. **Chống Spam tin nhắn (Sliding Window Rate Limiter):**
   - Mỗi client chỉ được gửi tối đa 5 tin nhắn trong 3 giây. Nếu vượt quá, server trả lời lỗi `RATE_LIMITED`.

6. **Chống tấn công XSS:**
   - Dữ liệu tin nhắn và biệt danh được escape ở Server và render an toàn qua `textContent` ở Client.

---

## 7. Các Tính Năng Giữ Chân Người Dùng (Engagement Features)

1. **Gợi ý phá băng mở đầu cuộc trò chuyện (Icebreaker Prompts):**
   - Khi hai người lạ được ghép cặp, rào cản lớn nhất là cảm giác ngượng ngùng, không biết nói gì để bắt đầu.
   - Nút **🎲 Phá băng** cho phép người dùng yêu cầu hệ thống chọn ngẫu nhiên một câu hỏi thú vị (Hài hước, Giả định, Tâm sự sâu sắc, Sở thích cá nhân) và hiển thị trực tiếp lên đầu phòng chat cho cả hai cùng thảo luận.

2. **Minigame 1-1 Đối kháng (Cờ Caro / Tic-Tac-Toe 3x3):**
   - Tích hợp bàn cờ tương tác thời gian thực thông qua các thông điệp WebSocket `game_invite`, `game_move`, `game_state`.
   - Giúp hai người lạ vừa trò chuyện vừa chơi cờ giải trí, tạo tiếng cười và gắn kết tự nhiên hơn nhiều so với việc chỉ nhắn tin văn bản đơn thuần.
