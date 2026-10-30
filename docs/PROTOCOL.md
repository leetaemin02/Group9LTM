# 📨 Đặc tả Giao thức Thông điệp – WebSocket ChatMatch (Nhóm 9)

Mọi gói tin trao đổi giữa Trình duyệt (Client) và Máy chủ (Server) đều tuân theo chuẩn định dạng chuỗi JSON:

```json
{
  "type": "<message_type>",
  "payload": { ... }
}
```

---

## 1. Các thông điệp từ Client gửi lên Server (Client → Server)

### 1.1. `join` – Đăng ký danh tính ban đầu
Gửi ngay sau khi kết nối WebSocket thành công hoặc khi người dùng bắt đầu tìm kiếm.
- **Payload:**
  - `nickname` *(string, bắt buộc)*: Biệt danh người dùng, từ 1 đến 30 ký tự.
  - `interests` *(string[], tùy chọn)*: Danh sách tối đa 5 sở thích, mỗi sở thích tối đa 30 ký tự.
  - `mood` *(string, tùy chọn)*: Tâm trạng hiện tại (`ngau_nhien`, `tam_su`, `vui_ve`, `tim_ban_game`, `hoc_tap`, `chan_nan`). Mặc định là `ngau_nhien`.
- **Ví dụ:**
```json
{
  "type": "join",
  "payload": {
    "nickname": "NguyenVanA",
    "interests": ["lập trình", "công nghệ", "âm nhạc"],
    "mood": "tam_su"
  }
}
```

### 1.2. `find_match` – Yêu cầu vào hàng đợi ghép cặp
Gửi khi người dùng nhấn nút "Bắt đầu tìm kiếm" hoặc tự động sau khi bỏ qua người cũ.
- **Payload:** `{}` (rỗng)

### 1.3. `cancel` – Hủy tìm kiếm
Gửi khi người dùng muốn thoát khỏi hàng đợi chờ ghép cặp.
- **Payload:** `{}` (rỗng)

### 1.4. `message` – Gửi tin nhắn đến đối phương
Chỉ gửi khi đang ở trong phòng chat (`state === 'CHATTING'`). Tin nhắn sẽ tự động được quét qua bộ lọc `contentFilter`.
- **Payload:**
  - `text` *(string, bắt buộc)*: Nội dung tin nhắn, tối đa 500 ký tự.

### 1.5. `typing` – Báo trạng thái gõ phím
- **Payload:**
  - `isTyping` *(boolean, bắt buộc)*: `true` nếu đang gõ, `false` nếu đã dừng.

### 1.3. `start_solo` – Bắt đầu trò chuyện/chơi game cùng Bạn Đồng Hành Lumi (Solo AI)
Chủ động kích hoạt chế độ tâm sự giải tỏa cảm xúc hoặc chơi cờ Caro giải trí một mình cùng Trợ lý Lumi khi không muốn chờ đợi hoặc khi hệ thống chỉ có một mình.
- **Payload:** `{}` (rỗng)

### 1.4. `cancel` – Hủy tìm kiếm và rời hàng đợi
- **Payload:** `{}` (rỗng)

### 1.5. `message` – Gửi tin nhắn trò chuyện
- **Payload:**
  - `text` *(string, bắt buộc)*: Nội dung tin nhắn, tối đa 500 ký tự. Không được chứa từ ngữ tục tĩu hoặc vi phạm tiêu chuẩn cộng đồng.

### 1.6. `typing` – Báo trạng thái đang nhập phím
- **Payload:**
  - `isTyping` *(boolean, bắt buộc)*: `true` nếu bắt đầu gõ phím, `false` khi dừng lại.

### 1.7. `skip` – Bỏ qua đối phương hiện tại / Chuyển sang tìm người thật
Yêu cầu rời phòng chat hiện tại và tự động quay lại hàng đợi tìm người mới. Nếu đang ở phòng Bot Lumi, chuyển sang tìm kiếm bạn chat người thật. Có cơ chế giới hạn tần suất tối đa 5 lần/30 giây chống bot/tool dò tìm đối tượng.
- **Payload:** `{}` (rỗng)

### 1.8. `report` – Báo cáo vi phạm và chặn đối phương
Rời phòng chat, ghi nhận lý do vi phạm và chặn ghép cặp lại với người này trong 5 phút.
- **Payload:**
  - `reason` *(string, bắt buộc)*: Lý do báo cáo, tối đa 200 ký tự.

### 1.9. `icebreaker` – Yêu cầu gợi ý câu hỏi phá băng
Yêu cầu server gửi câu hỏi mở đầu ngẫu nhiên để xóa tan không khí ngượng ngùng giữa 2 người lạ.
- **Payload:** `{}` (rỗng)

### 1.10. `game_invite` – Mời đối phương chơi Minigame Caro 3x3
- **Payload:** `{}` (rỗng)

### 1.11. `game_accept` – Chấp nhận thách đấu Minigame
- **Payload:** `{}` (rỗng)

### 1.12. `game_move` – Thực hiện nước đi trên bàn cờ Caro
- **Payload:**
  - `index` *(number, bắt buộc)*: Vị trí ô cờ từ `0` đến `8`.

### 1.13. `game_reset` – Đề nghị chơi lại ván mới
- **Payload:** `{}` (rỗng)

### 1.14. `game_quit` – Đóng bàn cờ / Thoát trò chơi
- **Payload:** `{}` (rỗng)

---

## 2. Các thông điệp từ Server gửi xuống Client (Server → Client)

### 2.1. `connected` – Xác nhận kết nối thành công
- **Payload:**
  - `clientId` *(string)*: Mã định danh UUID của client trên server.
  - `onlineCount` *(number)*: Số lượng người dùng đang kết nối tại thời điểm đó.

### 2.2. `waiting` – Xác nhận đã vào hàng đợi
- **Payload:** `{}`

### 2.3. `solo_hint` – Gợi ý chuyển sang Solo Bot khi phòng vắng hoặc chờ lâu
Gửi xuống client sau 10 giây chờ nếu hàng đợi chưa có bạn chat người thật phù hợp.
- **Payload:**
  - `waitSeconds` *(number)*: Số giây đã chờ.
  - `message` *(string)*: Lời nhắn gợi ý thân thiện.

### 2.4. `match_found` – Ghép cặp thành công
- **Payload:**
  - `partnerNickname` *(string)*: Biệt danh của đối tác.
  - `commonInterests` *(string[])*: Mảng các sở thích trùng nhau giữa 2 người.
  - `partnerMood` *(string)*: Tâm trạng hôm nay của đối phương.
  - `isBot` *(boolean, tùy chọn)*: `true` nếu đối phương là Trợ lý Đồng hành Lumi.

### 2.5. `message` – Tin nhắn trò chuyện từ đối tác
- **Payload:**
  - `text` *(string)*: Nội dung tin nhắn.
  - `timestamp` *(string, ISO 8601)*: Thời gian server tiếp nhận và chuyển tiếp tin nhắn.
  - `linkSafety` *(object, tùy chọn)*: Trạng thái URL gồm `hasLinks`, `suspicious`, `reasons`, `reputation` (`disabled`, `clean`, `limit_exceeded`, `unavailable`) và `threatTypes`. `clean` chỉ nghĩa là không khớp danh sách Google Web Risk tại thời điểm kiểm tra, không phải bảo đảm an toàn.

### `link_warning` – Cảnh báo URL cho người gửi và người nhận
- **Payload:** Cùng cấu trúc `linkSafety`; `blocked: true` nghĩa là tin nhắn không được chuyển tiếp vì URL khớp danh sách đe dọa Web Risk hoặc vượt giới hạn 5 URL.
- Web Risk tùy chọn; khi bật, server gửi URL tới Google để tra cứu. Khi API lỗi, tin nhắn được chuyển tiếp kèm trạng thái `unavailable`; không được hiểu là an toàn.

### `attachment_request` – Yêu cầu tải tệp lên
- **Client payload:** `fileName` (string), `size` (byte). Chỉ cho phép ảnh JPG/PNG/GIF/WebP, video MP4/WebM và PDF/DOCX/XLSX/PPTX/TXT/CSV; ảnh/tài liệu tối đa 10 MB, video tối đa 50 MB.
- **Server reply:** `attachment_upload` chứa `uploadId`, `ticket`, `uploadPath`, `fileName`, `contentType`, `category`, `size`, `expiresAt`. Ticket có hạn 30 phút và chỉ dành cho phiên/phòng chat đã yêu cầu.
- Client upload raw file tới `POST /api/attachments/{uploadId}` với `Authorization: Bearer <ticket>` và `Content-Type` do server cấp. Endpoint xác thực chữ ký ticket, giới hạn byte, loại nội dung và chữ ký file.

### `attachment_send` – Chia sẻ tệp đã tải lên
- **Client payload:** `ticket` từ `attachment_upload`. Server xác minh tệp tồn tại trong Blob Storage và phiên vẫn ở cùng phòng trước khi phát.
- **Server behavior:** Sau khi xác minh blob tồn tại, server chờ Azure Defender for Storage trả kết quả quét. Chỉ tag `Malware Scanning scan result = No threats found` mới được chia sẻ; `Malicious`, `Error`, `Not scanned`, thiếu kết quả quá thời hạn chờ hoặc lỗi tra cứu đều không phát attachment.
- **Server events:** Khi file sạch, `attachment` được gửi tới người nhận và `attachment_sent` tới người gửi; payload gồm `attachment` (`url`, `fileName`, `contentType`, `category`, `size`, `expiresAt`) và `timestamp`. Trường hợp không có kết quả sạch, người gửi nhận `error` với mã `ATTACHMENT_REJECTED` hoặc `ATTACHMENT_FAILED`.
- URL do server ký chỉ có quyền đọc, HTTPS, hết hạn sau 24 giờ. Container phải private; blob được xóa theo Azure lifecycle policy (đề xuất sau 7 ngày).

### 2.5. `typing` – Chỉ báo đối phương đang nhập
- **Payload:**
  - `isTyping` *(boolean)*

### 2.6. `partner_left` – Đối phương đã rời khỏi phòng chat
- **Payload:**
  - `reason` *(string, tùy chọn)*: Lý do đối phương rời đi (tự thoát hoặc bị hệ thống trục xuất).

### 2.7. `icebreaker` – Gợi ý chủ đề câu hỏi phá băng
- **Payload:**
  - `question` *(string)*: Nội dung câu hỏi phá băng.
  - `category` *(string)*: Nhóm chủ đề ('Hài hước', 'Giả định', 'Tâm sự', 'Sở thích').

### 2.8. `game_state` – Trạng thái Minigame Caro 3x3
- **Payload:**
  - `action` *(string)*: Hành động (`invite` | `start` | `update` | `quit`).
  - `game` *(object)*: Chi tiết bàn cờ (`board`, `turn`, `xPlayer`, `oPlayer`, `status`, `winner`, `winningLine`).

### 2.9. `kicked` – Bị buộc rời khỏi phòng ngay lập tức
Gửi riêng cho người dùng vi phạm khi bộ lọc phát hiện ngôn từ tục tĩu, xúc phạm hoặc chat đen.
- **Payload:**
  - `reason` *(string)*: Lý do bị trục xuất.
  - `banExpiresAt` *(number)*: Thời điểm hết hạn lệnh cấm tạm thời (timestamp).

### 2.10. `online_count` – Cập nhật số người trực tuyến
- **Payload:**
  - `count` *(number)*: Số lượng kết nối hiện tại.

### 2.11. `reported` – Xác nhận đã ghi nhận báo cáo
- **Payload:** `{}`

### 2.12. `error` – Thông báo lỗi xử lý
- **Payload:**
  - `code` *(string)*: Mã lỗi chuẩn.
  - `message` *(string)*: Thông điệp mô tả lỗi hiển thị cho người dùng.

---

## 3. Bảng tra cứu Mã Lỗi (`ERROR_CODES`)

| Mã lỗi | Nguyên nhân | Phản hồi của hệ thống |
|---|---|---|
| `INVALID_FORMAT` | Message không phải JSON hoặc vượt quá 2048 bytes | Trả lỗi, không xử lý |
| `INVALID_TYPE` | Trường `type` không nằm trong danh mục hợp lệ | Trả lỗi, bỏ qua |
| `INVALID_PAYLOAD` | Dữ liệu thiếu trường bắt buộc, sai kiểu, hoặc chuỗi quá dài | Trả thông điệp lỗi cụ thể |
| `RATE_LIMITED` | Client gửi quá 5 tin nhắn trong vòng 3 giây | Bỏ qua tin nhắn, yêu cầu chờ |
| `NOT_IN_ROOM` | Gửi tin nhắn hoặc báo cáo khi chưa ở trong phòng chat | Từ chối thao tác |
| `NOT_JOINED` | Yêu cầu tìm kiếm (`find_match`) khi chưa đăng ký biệt danh | Yêu cầu nhập biệt danh |
| `ALREADY_WAITING`| Gửi `find_match` khi đang trong hàng đợi | Bỏ qua yêu cầu lặp lại |
| `ALREADY_CHATTING`| Gửi `find_match` khi đang trong phòng chat 1-1 | Yêu cầu hoàn thành phiên hiện tại |
| `SKIP_COOLDOWN` | Bấm bỏ qua liên tục (> 5 lần / 30 giây) để dùng tool dò người | Phạt dừng tìm kiếm trong 30 giây |
| `BANNED` | Đang trong thời gian bị cấm 10 phút do vi phạm từ ngữ khiếm nhã | Chặn vào hàng đợi ghép cặp |
| `KICKED_PROFANITY`| Vi phạm nội dung cấm trong tin nhắn trò chuyện | Buộc rời khỏi phòng ngay lập tức |
