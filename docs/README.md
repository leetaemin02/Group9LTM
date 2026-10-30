# 📚 Tài liệu Hệ thống WebSocket ChatMatch – Nhóm 9

Thư mục `docs/` chứa toàn bộ tài liệu kỹ thuật, kiến trúc, đặc tả giao thức và tài liệu kiểm thử cho đề tài **"Xây dựng hệ thống ghép cặp và trò chuyện trực tuyến thời gian thực sử dụng WebSocket"**.

---

## 📑 Danh mục tài liệu

1. **[Kiến trúc hệ thống (ARCHITECTURE.md)](ARCHITECTURE.md)**
   - Tổng quan về công nghệ WebSocket (RFC 6455) so sánh với HTTP/Polling.
   - Quá trình bắt tay (Handshake) và nâng cấp kết nối (HTTP Upgrade).
   - Mô hình kiến trúc Server và Client.
   - Vòng đời kết nối (Lifecycle) và Heartbeat Ping/Pong.
   - Thuật toán ghép cặp ngẫu nhiên và theo sở thích (Matchmaking).
   - Cơ chế kiểm soát lạm dụng (Rate Limiting, Report, Temporary Block).
   - Biện pháp bảo vệ và an toàn (Anti-DoS, Connection Quota, XSS Sanitization).

2. **[Đặc tả Giao thức Thông điệp (PROTOCOL.md)](PROTOCOL.md)**
   - Cấu trúc khung thông điệp JSON `{ type, payload }`.
   - Danh sách chi tiết các thông điệp Client → Server.
   - Danh sách chi tiết các thông điệp Server → Client.
   - Mã lỗi hệ thống (`ERROR_CODES`) và kịch bản phát sinh.
   - Quy tắc kiểm tra tính hợp lệ dữ liệu (Validation Rules).

3. **[Hướng dẫn & Kịch bản Kiểm thử (TESTING.md)](TESTING.md)**
   - Hướng dẫn kiểm thử chức năng thủ công (Manual Testing).
   - Kịch bản kiểm thử các ca biên: mất kết nối đột ngột, reconnect exponential backoff, rate limit spam, report & block.
   - Hướng dẫn chạy kiểm thử tải tự động (`tests/load-test.js`).
   - Giải thích các chỉ số hiệu năng: Connection Latency, Matchmaking Latency, Message Latency (P50, P95, P99).
   - Hướng dẫn xuất và phân tích file kết quả `load-test-results.json` để đưa vào báo cáo đề tài.

4. **[Hướng dẫn Cấu hình & Sử dụng Redis Pub/Sub (REDIS_GUIDE.md)](REDIS_GUIDE.md)**
   - Nguyên lý hoạt động của Redis Pub/Sub trong kiến trúc đa server / Cluster.
   - Cơ chế tự động dự phòng (Graceful In-Memory Fallback).
   - Hướng dẫn cài đặt và bảo mật Redis trên Linux VPS.
   - Hướng dẫn chạy PM2 Cluster Mode đa tiến trình.
