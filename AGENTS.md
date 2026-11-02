# AGENTS.md – Quy tắc cho AI Agent làm việc trên ChatMatch (Nhóm 9)

File này được Antigravity, Cursor, GitHub Copilot, Codex… tự động đọc. Mọi thay đổi code phải tuân thủ các quy tắc dưới đây.

## Tổng quan dự án
- Ứng dụng ghép cặp & chat 1-1 thời gian thực qua **WebSocket thuần** (thư viện `ws`), môn Lập trình mạng.
- `backend/server.js` vừa phục vụ file tĩnh trong `frontend/` qua HTTP, vừa xử lý WebSocket trên **cùng một cổng** (mặc định 3001).
- Tài liệu chuẩn: `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/REDIS_GUIDE.md`, `docs/SECURITY_COMPLIANCE.md`, `docs/TESTING.md`, `docs/DOCKER.md`.

## Quy tắc bắt buộc

### Ngôn ngữ & module
- Backend dùng **CommonJS** (`require` / `module.exports`) và `'use strict';`. **Không** chuyển sang ES Modules (`import`/`export`).
- Frontend là **Vanilla JS + HTML + CSS**. **Không** thêm React/Vue/Tailwind/bundler hoặc bước build.
- Không thêm dependency npm mới khi chưa được người dùng đồng ý. Ưu tiên module có sẵn của Node.js.

### Giao thức WebSocket
- Mọi message có dạng JSON `{ type, payload }`, định nghĩa trong `backend/protocol.js`.
- Thêm loại message mới phải: (1) khai báo trong `CLIENT_TYPES`/`SERVER_TYPES`, (2) thêm validate trong `validatePayload`, (3) tạo builder trong `serverMsg`, (4) cập nhật `docs/PROTOCOL.md`, (5) xử lý phía `frontend/script.js`.
- Server **luôn** gửi bằng `serverMsg.*` và parse bằng `parseMessage` + `validatePayload`. Không tự chế format khác.
- Dùng hằng số giới hạn có sẵn (`MAX_MESSAGE_LENGTH`, `MAX_NICKNAME_LENGTH`…), không hard-code lại. Lưu ý `maxPayload` của WebSocket là 4KB.

### Bảo mật (không được nới lỏng)
- Nội dung người dùng hiển thị ra UI phải được escape (`escapeHtml` / `textContent`). Không dùng `innerHTML` với dữ liệu chưa escape.
- Giữ nguyên các lớp bảo vệ: kiểm tra Origin (CSWSH), giới hạn kết nối theo IP, rate limit, content filter, link safety, chống path traversal khi phục vụ file tĩnh.
- Không commit secrets. Cấu hình qua biến môi trường; `.env.example` chỉ là mẫu. **Ứng dụng không tự nạp file `.env`** (không dùng `dotenv`).

### Redis & nhiều instance
- `USE_REDIS=false` (mặc định): toàn bộ trạng thái nằm trong RAM. `USE_REDIS=true`: hàng đợi ghép cặp, bộ đếm online và Pub/Sub đi qua `backend/redisManager.js`.
- Khi Redis được bật mà không sẵn sàng, **không** tự fallback sang hàng đợi RAM.
- Trạng thái Caro, rate limit, report/ban vẫn nằm trong RAM từng instance. Code mới phải ghi rõ trạng thái nằm ở đâu.

### Phong cách code
- Comment và thông điệp hiển thị cho người dùng bằng **tiếng Việt**, theo phong cách các file hiện có (JSDoc, đề mục `// ─── ... ───`).
- Giữ nguyên comment/docstring không liên quan đến thay đổi.

## Kiểm tra trước khi hoàn tất
```bash
cd backend && npm install        # lần đầu
node tests/unit-test.js          # chạy từ thư mục gốc, phải pass 100%
node backend/server.js           # khởi động và mở http://localhost:3001
```
Thay đổi liên quan tới tải/kết nối: chạy thêm `node tests/load-test.js 100` khi server đang chạy.

