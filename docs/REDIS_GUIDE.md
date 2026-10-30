# Hướng dẫn Redis nhiều instance – WebSocket ChatMatch

Tài liệu này hướng dẫn cách kích hoạt Redis dùng chung cho nhiều tiến trình/máy chủ WebSocket ChatMatch.

---

## 1. Nguyên lý hoạt động của Redis Pub/Sub trong ChatMatch

Trong mô hình máy chủ đơn lẻ (Single Instance), kết nối WebSocket và một số trạng thái phòng được giữ trong RAM của tiến trình Node.js. Khi mở rộng nhiều instance, Redis chia sẻ hàng đợi ghép cặp và bộ đếm online; Pub/Sub chuyển tiếp tin nhắn và sự kiện phòng.

Khi mở rộng (Scale Horizontal) chạy **nhiều tiến trình Node.js** trên nhiều lõi CPU hoặc **nhiều máy chủ VPS** khác nhau:
- **Vấn đề:** Người dùng A kết nối vào **Server 1**, người dùng B kết nối vào **Server 2**. Server 1 không thể trực tiếp gọi `socketB.send()`.
- **Giải pháp:** Sử dụng **Redis Pub/Sub** làm Message Broker:
  1. Mỗi tiến trình Node.js lắng nghe mẫu kênh (Pattern Subscribe): `chat:client:*`.
  2. Khi Server 1 muốn gửi tin nhắn cho Người dùng B (`clientId: B`), Server 1 đẩy thông điệp vào Redis:  
     `PUBLISH chat:client:B "{...noi dung tin nhan...}"`.
  3. Redis lập tức phân phối thông điệp đến Server 2 (nơi đang giữ socket của B).
  4. Server 2 nhận được và chuyển tiếp trực tiếp xuống Client B qua kết nối WebSocket nội bộ.

```
┌──────────────┐                             ┌──────────────┐
│   Client A   │                             │   Client B   │
└──────┬───────┘                             └──────▲───────┘
       │ WebSocket                                  │ WebSocket
       ▼                                            │
┌──────────────┐                             ┌──────┴───────┐
│   Server 1   │                             │   Server 2   │
└──────┬───────┘                             └──────▲───────┘
       │                                            │
       │ PUBLISH chat:client:B                      │ SUBSCRIBE
       └──────────────────► ┌─────────────┐ ────────┘
                            │    REDIS    │
                            │   Pub/Sub   │
                            └─────────────┘
```

---

## 2. Trạng thái dùng chung và chế độ fallback

- Khi `USE_REDIS` chưa bật, server dùng hàng đợi và trạng thái cục bộ trong RAM; chế độ này phù hợp chạy một instance.
- Khi `USE_REDIS=true`, Redis là nguồn dùng chung cho hàng đợi ghép cặp và số người online. Lua script ghép cặp nguyên tử, giữ điểm sở thích/tâm trạng và FIFO; Pub/Sub chuyển tiếp tin nhắn, kết quả ghép và sự kiện rời phòng giữa các instance.
- Kết nối hiện dùng endpoint Redis tiêu chuẩn với `ioredis.Redis`; chưa cấu hình `ioredis.Cluster`. Dùng một endpoint Redis tương thích, không bật Redis Cluster mode nếu chưa bổ sung và kiểm thử cấu hình cluster client.
- Nếu Redis được bật nhưng không sẵn sàng, yêu cầu tìm người sẽ trả lỗi rõ ràng. Server **không** tự chuyển sang hàng đợi RAM vì việc này có thể tạo các hàng đợi riêng và ghép cặp sai giữa các instance.
- Sự kiện ghép cặp được lưu tạm để instance có thể khôi phục nếu lỡ thông báo Pub/Sub.

**Giới hạn hiện tại cần lưu ý trước khi public:** trạng thái ván Caro, rate limit, danh sách report/ban và một số trạng thái phòng vẫn ở RAM từng instance. Vì vậy, Redis hiện hỗ trợ ghép cặp và chat văn bản liên instance, nhưng chưa đồng bộ đầy đủ mọi tính năng của ứng dụng hoặc cung cấp failover bền vững cho phiên chat. Cần hoàn tất lưu trạng thái phòng/game và các bộ kiểm soát lạm dụng dùng chung trước khi mở rộng nhiều instance cho toàn bộ tính năng.

---

## 3. Cài đặt Redis trên VPS (Ubuntu / Debian)

### Bước 1: Cài đặt Redis Server
```bash
sudo apt update
sudo apt install redis-server -y
```

### Bước 2: Kiểm tra trạng thái Redis
```bash
sudo systemctl status redis-server
```
Thử ping redis:
```bash
redis-cli ping
# Phản hồi mong đợi: PONG
```

### Bước 3: Bảo mật Redis cơ bản (Tùy chọn)
Mặc định Redis chỉ lắng nghe tại `127.0.0.1` (an toàn cho các tiến trình chạy trên cùng VPS).  
Nếu muốn đặt mật khẩu, mở file `/etc/redis/redis.conf`:
```conf
requirepass MatKhauCuaBan123
```
Sau đó khởi động lại Redis:
```bash
sudo systemctl restart redis-server
```

---

## 4. Kích hoạt Redis trong mã nguồn ChatMatch

### 4.1. Cấu hình biến môi trường

Ứng dụng đọc cấu hình từ environment variables của tiến trình Node.js. `.env.example` chỉ là mẫu; ứng dụng hiện không tự nạp file `.env`. Trên PowerShell, chạy:
```env
$env:PORT='3001'
$env:USE_REDIS='true'
$env:REDIS_URL='redis://127.0.0.1:6379'
npm start
```

Trong môi trường public, cấu hình các biến này qua secret/environment settings của nền tảng deploy và dùng kết nối riêng tư cùng TLS nếu nhà cung cấp hỗ trợ. Không ghi mật khẩu Redis vào source code hoặc commit `.env`. Với endpoint TLS, dùng scheme `rediss://`.

*Ví dụ URL có mật khẩu (chỉ cấu hình qua secret store):*
```env
REDIS_URL=rediss://:PASSWORD@redis.example:6380
```

### 4.2. Chạy nhiều instance
Mọi instance phải dùng cùng Redis endpoint và bật `USE_REDIS=true`. Đặt sau load balancer hỗ trợ WebSocket:
```bash
# Chạy nhiều worker qua PM2 Cluster Mode
pm2 start backend/server.js -i max --name "chatmatch"

# Xem danh sách các tiến trình đang chạy
pm2 list

# Xem log kết nối Redis từ các tiến trình
pm2 logs chatmatch
```

Hàng đợi hiện kiểm tra tối đa 5.000 ứng viên gần nhất trong một lần ghép để giới hạn thời gian chạy script nguyên tử. Hệ thống cần được benchmark bằng đúng cấu hình Redis, số instance và tải dự kiến trước khi mở rộng lên quy mô lớn; tải ghép cặp rất lớn cần chỉ mục hàng đợi theo tiêu chí/nhóm người dùng để tránh quét tuyến tính.

---

## 5. Chạy thử nghiệm Redis cục bộ bằng Docker (Nếu dùng máy Dev)

Nếu bạn muốn chạy thử nghiệm Redis trên máy tính cá nhân qua Docker:
```bash
docker run -d --name redis-chat -p 6379:6379 redis:alpine
```
Khi Docker đang chạy, đặt `USE_REDIS=true` và `REDIS_URL=redis://127.0.0.1:6379`, sau đó chạy `node backend/server.js`. Log sẽ xác nhận cả Pub/Sub và Redis đã sẵn sàng:
```
[Redis] ✅ Pub Client đã kết nối tới redis://127.0.0.1:6379
[Redis] ✅ Sub Client đã kết nối. Đang đăng ký kênh Pub/Sub...
[Redis] 📡 Đã kích hoạt lắng nghe Pub/Sub đa instance
```
