# 💬 ChatMatch – Hệ thống ghép cặp và trò chuyện trực tuyến

> **Đề tài:** Xây dựng hệ thống ghép cặp và trò chuyện trực tuyến thời gian thực sử dụng WebSocket
> **Nhóm:** 9

## 📖 Giới thiệu

Hệ thống cho phép người dùng nhập biệt danh, chọn sở thích, rồi được ghép cặp ngẫu nhiên với một người dùng khác để trò chuyện 1-1 theo thời gian thực qua **WebSocket thuần** (thư viện `ws`).

## 🏗️ Kiến trúc

```
┌────────────┐                                        ┌────────────┐
│  Client A  │                                        │  Client B  │
│ (Browser)  │                                        │ (Browser)  │
└─────┬──────┘                                        └─────┬──────┘
      │  WebSocket                          WebSocket       │
      └───────────────────┐               ┌─────────────────┘
                          ▼               ▼
                ┌───────────────────────────────────┐
                │          WebSocket Server         │
                │  ┌─────────────────────────────┐  │
                │  │ Connection Manager          │  │
                │  │ Matchmaker (Waiting Queue)  │  │
                │  │ Room Manager                │  │
                │  │ Moderation                  │  │
                │  └─────────────────────────────┘  │
                └───────────────────────────────────┘
```

## 📂 Cấu trúc thư mục

```
ChatMatch/
├── frontend/
│   ├── index.html        # Giao diện người dùng
│   ├── style.css         # Stylesheet (Dark mode, responsive)
│   └── script.js         # Frontend logic và WebSocket client
├── backend/
│   ├── server.js         # HTTP server, phục vụ frontend và WebSocket
│   ├── companionBot.js   # Trợ lý Lumi
│   ├── matchmaker.js     # Hàng đợi, mood matching & anti-targeted pairing
│   ├── roomManager.js    # Quản lý phòng chat 1-1 & Minigame Caro
│   ├── contentFilter.js  # Bộ lọc ngôn từ thô tục, xúc phạm, chat đen
│   ├── icebreakers.js    # Bộ câu hỏi phá băng kết nối người lạ
│   ├── protocol.js       # Giao thức thông điệp + schema validate
│   ├── moderation.js     # Rate limit, report, block, ban & anti-skip
│   ├── redisManager.js   # Redis Pub/Sub adapter (Multi-node scaling)
│   ├── linkSafety.js     # Heuristic nhận diện cấu trúc URL
│   ├── webRisk.js        # Tra cứu reputation URL với Google Web Risk (tùy chọn)
│   ├── attachmentStorage.js # Lưu tệp riêng tư trên Azure Blob Storage
│   ├── package.json      # Dependencies và scripts của backend
│   ├── package-lock.json # Khóa phiên bản dependencies
│   └── .env.example      # Mẫu cấu hình môi trường
├── docs/                 # Tài liệu hệ thống chi tiết
│   ├── README.md         # Mục lục tài liệu
│   ├── ARCHITECTURE.md   # Kiến trúc & nguyên lý WebSocket
│   ├── PROTOCOL.md       # Đặc tả giao thức thông điệp JSON
│   ├── TESTING.md        # Kế hoạch & kịch bản kiểm thử
│   ├── REDIS_GUIDE.md    # Hướng dẫn Redis Pub/Sub nhiều instance
│   └── SECURITY_COMPLIANCE.md # Bảo mật và tuân thủ
├── tests/
│   ├── unit-test.js      # Kiểm thử đơn vị toàn bộ module (100% pass)
│   └── load-test.js      # Script kiểm thử tải
└── README.md
```

## 🚀 Cài đặt & Chạy

### Frontend và Backend hoạt động thế nào?

- **Frontend** nằm trong `frontend/`: HTML, CSS và JavaScript chạy trong trình duyệt.
- **Backend** nằm trong `backend/`: Node.js phục vụ các file frontend qua HTTP và xử lý chat qua WebSocket.
- Vì backend đang phục vụ frontend, chỉ cần chạy **một server**. Truy cập địa chỉ HTTP của server sẽ mở giao diện; trình duyệt tự kết nối WebSocket tới cùng địa chỉ.

### Yêu cầu
- [Node.js](https://nodejs.org/) >= 18.x

### Bước 1: Cài đặt dependencies
```bash
cd backend
npm install
```

### Bước 2: Khởi động Server
```bash
npm start
```

Server sẽ chạy tại `http://localhost:3001`.
Nếu cổng 3001 đang được sử dụng, hãy chọn cổng khác, ví dụ:

```powershell
$env:PORT=3002; npm start
```

Nếu đã đổi cổng sang 3002, mở `http://localhost:3002` trong trình duyệt.

### Bật kiểm tra danh tiếng liên kết (tùy chọn)

Mặc định ứng dụng chỉ dùng heuristic cục bộ; không gửi URL ra ngoài. Để tra cứu URL với Google Web Risk:
1. Tạo Google Cloud project, bật [Web Risk API](https://cloud.google.com/web-risk/docs/lookup-api) và tạo API key; giới hạn key chỉ dùng Web Risk API.
2. Cấu hình key bằng secret/environment variable của môi trường deploy. Không commit key hoặc đặt key trong frontend.
3. Tin nhắn chứa tối đa 5 URL duy nhất sẽ được kiểm tra trước khi chuyển tiếp. Nếu Google xác nhận URL thuộc danh sách phishing/malware/phần mềm không mong muốn, server chặn toàn bộ tin nhắn và thông báo cho cả hai người dùng. Tin nhắn vượt quá giới hạn 5 URL cũng bị chặn để tránh bỏ sót URL chưa quét.
4. Nếu API lỗi, hệ thống vẫn cho gửi nhưng cảnh báo rằng liên kết chưa được xác minh. Kết quả “không có trong danh sách” không đảm bảo an toàn.

Ví dụ PowerShell cho phiên chạy local (thay bằng key thật, không lưu vào source):
```powershell
$env:GOOGLE_WEB_RISK_API_KEY='YOUR_API_KEY'
npm start
```

Việc bật API gửi URL nguyên bản (có thể gồm path/query) tới Google. Chỉ bật sau khi đã quyết định cách thông báo người dùng và rà soát điều khoản, quyền riêng tư, hạn mức/chi phí của Google Cloud. Link rút gọn có thể che giấu đích đến; ứng dụng không tự mở link hoặc theo redirect.

### Gửi ảnh, video và tài liệu

Tính năng đính kèm dùng Azure Blob Storage; nếu chưa cấu hình tài khoản storage, nút đính kèm sẽ báo chưa khả dụng. Tệp được gửi qua server tới container riêng tư, không bật public access:

- Ảnh: JPG/JPEG, PNG, GIF, WebP; tài liệu: PDF, DOCX, XLSX, PPTX, TXT, CSV — tối đa 10 MB mỗi tệp.
- Video: MP4 hoặc WebM — tối đa 50 MB.
- Tệp khác (bao gồm chương trình/script và SVG) bị từ chối. Server kiểm tra phần mở rộng, dung lượng và chữ ký định dạng cơ bản, sau đó chờ Azure Defender for Storage quét malware; chỉ kết quả `No threats found` mới được chia sẻ.
- Người nhận tải trực tiếp từ Blob qua URL HTTPS có quyền chỉ đọc, hết hạn sau 24 giờ. Hãy cấu hình Azure Storage lifecycle để xóa blob trong prefix `chat/` sau khoảng 7 ngày; lifecycle chạy bất đồng bộ nên thời điểm xóa thực tế có thể trễ. Nếu bỏ qua bước này, tệp vẫn chiếm dung lượng sau khi link hết hạn.
- Kết quả `Malicious`, `Error`, `Not scanned`, thiếu kết quả hoặc vượt thời gian chờ đều bị từ chối (fail-closed). Azure Defender có thể quét chậm; app chờ tối đa 3 phút mặc định. Bật Defender for Storage **On-upload malware scanning**, giữ bật blob index tags và đặt giới hạn chi phí quét hàng tháng.

Thiết lập:
1. Tạo Azure Storage account loại General-purpose v2 và container `chat-attachments`. Tắt anonymous/public access ở cả account và container; chỉ bật HTTPS và tối thiểu TLS 1.2.
2. Bật Defender for Storage và **On-upload malware scanning** cho Storage Account. Để mặc định bật kết quả blob index tags và cấu hình monthly scan cap/chi phí. Có thể bật soft delete/quarantine cho blob bị phát hiện có mã độc.
3. Bật system-assigned Managed Identity cho ứng dụng chạy ở Azure. Cấp `Storage Blob Data Contributor` ở phạm vi container và `Storage Blob Delegator` ở phạm vi Storage Account. Khi phát triển local, dùng identity của `az login` và cấp hai role tương tự cho user đó.
4. Đặt `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_CONTAINER_NAME` trong environment. Nếu dùng endpoint tùy chỉnh, đặt thêm `AZURE_STORAGE_BLOB_ENDPOINT`; mặc định SDK dùng `https://<account>.blob.core.windows.net`.
5. Sinh `ATTACHMENT_TOKEN_SECRET` bằng lệnh bên dưới rồi đưa vào secret store của môi trường deploy. Dùng cùng giá trị trên mọi instance; không commit `.env` hay in secret ra log.
6. Tạo file `lifecycle-policy.json` từ ví dụ dưới đây và áp dụng policy bằng Azure CLI. Prefix phải có dạng `<container>/chat/`.
7. Đặt `MAX_CONCURRENT_ATTACHMENT_UPLOADS` theo giới hạn bộ nhớ/băng thông của mỗi instance (mặc định 4); `ATTACHMENT_SCAN_TIMEOUT_MS` mặc định 180000 ms. Khi đạt giới hạn upload, server trả HTTP 503 để client thử lại sau.

PowerShell: đăng nhập local, tạo container private và sinh secret trong phiên terminal hiện tại:
```powershell
az login
$env:AZURE_STORAGE_ACCOUNT_NAME = '<storage-account-name>'
$env:AZURE_STORAGE_CONTAINER_NAME = 'chat-attachments'
$env:ATTACHMENT_TOKEN_SECRET = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
az storage container create --account-name $env:AZURE_STORAGE_ACCOUNT_NAME --name $env:AZURE_STORAGE_CONTAINER_NAME --auth-mode login --public-access off
```

Sau khi container tồn tại, cấp role cho principal chạy ứng dụng. Thay `$principalId` bằng Object ID của Managed Identity hoặc user đã `az login`; trong Azure CLI chọn đúng `--assignee-principal-type` (`ServicePrincipal` cho Managed Identity, `User` cho local developer):
```powershell
$resourceGroup = '<resource-group>'
$storageAccount = $env:AZURE_STORAGE_ACCOUNT_NAME
$containerName = $env:AZURE_STORAGE_CONTAINER_NAME
$principalId = '<principal-object-id>'
$storageId = az storage account show --name $storageAccount --resource-group $resourceGroup --query id --output tsv
$containerScope = "$storageId/blobServices/default/containers/$containerName"

az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Contributor' --scope $containerScope
az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role 'Storage Blob Delegator' --scope $storageId
```

Với local developer, lấy Object ID bằng `$principalId = az ad signed-in-user show --query id --output tsv` và đổi `ServicePrincipal` thành `User`. Cần quyền quản trị phù hợp để tạo role assignment; sau khi gán role, có thể cần chờ vài phút để RBAC có hiệu lực. Container có thể tạo từ Portal nếu lệnh CLI chưa được cấp quyền data-plane.

Ví dụ rule lifecycle JSON (tên container/prefix phải khớp cấu hình thực tế):
```json
{
  "rules": [{
    "enabled": true,
    "name": "delete-chat-attachments-after-seven-days",
    "type": "Lifecycle",
    "definition": {
      "filters": {
        "blobTypes": ["blockBlob"],
        "prefixMatch": ["chat-attachments/chat/"]
      },
      "actions": {
        "baseBlob": {
          "delete": { "daysAfterModificationGreaterThan": 7 }
        }
      }
    }
  }]
}
```
Lưu JSON trên thành `lifecycle-policy.json`, sau đó chạy lệnh Azure CLI (cần quyền quản lý Storage Account):
```powershell
az storage account management-policy create --resource-group $resourceGroup --account-name $storageAccount --policy '@lifecycle-policy.json'
az storage account management-policy show --resource-group $resourceGroup --account-name $storageAccount
```

Trong Azure App Service/Container Apps, bật Managed Identity, đặt các biến môi trường trên dưới dạng app settings/secret, rồi khởi động lại ứng dụng. Trên mọi replica phải dùng cùng account, container và `ATTACHMENT_TOKEN_SECRET`; mỗi identity phải có role phù hợp.

Ứng dụng dùng `DefaultAzureCredential`: Managed Identity trên Azure và thông tin xác thực developer đã đăng nhập khi chạy local; không lưu Storage Account Key trong mã nguồn. Upload đi qua backend để kiểm tra kích thước/chữ ký, vì vậy backend cần đủ băng thông cho tệp (đến 50 MB). Mỗi process mặc định xử lý tối đa 4 upload đồng thời. Blob index tags là kết quả scan do Defender ghi nhưng không chống sửa đổi; container phải private, không cấp credentials cho browser và chỉ backend được phép tạo SAS sau khi kiểm tra kết quả. Kết quả “No threats found” không bảo đảm tệp vô hại tuyệt đối. Tin nhắn không được lưu lịch sử sau phòng chat; blob được dọn theo lifecycle policy, nhưng Azure chạy policy bất đồng bộ nên không bảo đảm xóa chính xác vào ngày thứ 7.

Tham khảo hướng dẫn chính thức về [Defender for Storage on-upload malware scanning](https://learn.microsoft.com/azure/defender-for-cloud/on-upload-malware-scanning), [kết quả quét malware](https://learn.microsoft.com/azure/defender-for-cloud/introduction-malware-scanning), [Azure Blob lifecycle policy](https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-policy-structure), [ủy quyền Azure CLI bằng Microsoft Entra](https://learn.microsoft.com/azure/storage/blobs/authorize-data-operations-cli) và [Azure CLI quản lý lifecycle policy](https://learn.microsoft.com/cli/azure/storage/account/management-policy?view=azure-cli-latest).

Sau khi cấu hình, kiểm tra với hai trình duyệt/phiên riêng: gửi ảnh, video và tài liệu; xác nhận người nhận mở được link HTTPS, link chỉ có quyền đọc và hết hạn sau 24 giờ. Thử định dạng bị cấm, tệp quá giới hạn và upload không có ticket để xác nhận bị từ chối. Trước khi public, kiểm thử thêm quyền Azure trên đúng identity, private access, lifecycle policy và giới hạn tải đồng thời. Lỗi `403` ngay sau khi gán role thường cần thời gian để RBAC lan truyền; lỗi `AuthenticationFailed` cần kiểm tra identity/default credential và tên account/container.

### Bước 3: Mở trình duyệt
Truy cập `http://localhost:3001` (hoặc cổng đã chọn). Mặc định, các kết nối cùng IP vẫn có thể ghép cặp để hỗ trợ thử nghiệm nhiều tab trên máy local. Có thể bật giới hạn ghép cùng IP bằng `DISALLOW_SAME_IP=true`. Nếu đang dùng một mình, chọn **Tâm sự cùng Lumi**.

## 🧪 Kiểm thử

```bash
# Chạy Unit Tests
cd ..
node tests/unit-test.js

# Mô phỏng tải 100 client
node tests/load-test.js 100

# Mô phỏng tải 200 client
node tests/load-test.js 200 ws://localhost:3001
```

Để chạy 200 client trên cùng máy, hãy tăng tạm `MAX_CONNECTIONS_PER_IP` khi khởi động server; xem hướng dẫn và số liệu thực nghiệm trong `docs/TESTING.md`.

## 📨 Giao thức thông điệp

Mọi message đều là JSON: `{ "type": "...", "payload": { ... } }`

### Client → Server

| type | payload | Mô tả |
|------|---------|-------|
| `join` | `nickname`, `interests[]`, `mood`, `deviceId` | Đăng ký biệt danh, sở thích, tâm trạng và định danh thiết bị |
| `find_match` | – | Vào hàng đợi ghép cặp |
| `start_solo` | – | Vào phòng tâm sự và chơi cờ Caro giải trí cùng Trợ lý Lumi |
| `cancel` | – | Rời hàng đợi |
| `message` | `text` | Gửi tin nhắn (tự động kiểm duyệt ngôn từ) |
| `typing` | `isTyping` | Báo đang nhập / ngừng nhập |
| `skip` | – | Bỏ qua, tìm người mới (hoặc chuyển từ Bot sang người thật) |
| `report` | `reason` | Báo cáo đối phương |
| `icebreaker` | – | Yêu cầu gợi ý câu hỏi phá băng |
| `game_invite` | – | Mời đối phương chơi Minigame Caro 3x3 |
| `game_accept` | – | Chấp nhận thách đấu cờ Caro |
| `game_move` | `index` | Đánh nước đi vào ô 0-8 |
| `game_reset` | – | Chơi lại ván cờ mới |
| `game_quit` | – | Thu gọn / thoát bàn cờ |

### Server → Client

| type | payload | Mô tả |
|------|---------|-------|
| `connected` | `clientId`, `onlineCount` | Xác nhận kết nối |
| `waiting` | – | Đang trong hàng đợi ghép cặp |
| `solo_hint` | `waitSeconds`, `message` | Gợi ý tâm sự/chơi game cùng Lumi khi chỉ có 1 người hoặc chờ lâu |
| `match_found` | `partnerNickname`, `commonInterests[]`, `partnerMood`, `isBot` | Ghép cặp thành công (người thật hoặc Bot Lumi) |
| `message` | `text`, `timestamp` | Tin nhắn từ đối phương |
| `typing` | `isTyping` | Đối phương đang nhập |
| `partner_left` | `reason` | Đối phương rời phòng |
| `icebreaker` | `question`, `category` | Gợi ý chủ đề mở đầu trò chuyện |
| `game_state` | `board`, `turn`, `status`, `winner`, `winningLine` | Trạng thái bàn cờ Minigame |
| `kicked` | `reason`, `banExpiresAt` | Bị buộc rời phòng ngay lập tức do vi phạm |
| `online_count` | `count` | Số người online thời gian thực |
| `error` | `code`, `message` | Thông báo lỗi hệ thống |

## ⚙️ Tính năng chính & Điểm nhấn (Highlights)

- ✅ **Trợ lý Đồng hành Tâm sự & AI Minigame Solo (Lumi ✨)**:
  - **Giải quyết bài toán "Chỉ có 1 người dùng trực tuyến / Phòng vắng":** Người dùng không bao giờ bị đẩy ra ngoài hay phải chờ đợi đơn độc trong chán nản.
  - **Tâm sự & Giải tỏa cảm xúc:** Lắng nghe, thấu cảm, động viên ấm áp theo tâm trạng (`tam_su`, `chan_nan`, `vui_ve`, `hoc_tap`, `tim_ban_game`), chia sẻ bài tập hít thở thư giãn 4-7-8, xả stress.
  - **Minigame Caro 3x3 1-1 với AI:** Người dùng có thể bấm "🎮 Caro 1-1" bất cứ lúc nào để so tài cờ giải trí một mình. Bot sở hữu thuật toán AI thông minh (biết chặn nước nguy hiểm, ăn nước thắng) kèm các bình luận vui vẻ.
  - **Hiệu ứng Typing mượt mà:** Bot mô phỏng độ trễ gõ phím chân thực (0.8s - 1.8s) như một người bạn thật sự.
  - **Chuyển đổi linh hoạt:** Khi người dùng muốn tìm người thật, chỉ cần bấm nút "👥 Tìm người thật" là được đưa ngay về hàng đợi `Matchmaker`.
- ✅ **WebSocket thuần (`ws`)** – Tuân thủ chuẩn RFC 6455, hiệu năng cao, không phụ thuộc socket.io.
- ✅ **Ghép cặp theo Tâm trạng (Mood Matching)** – Chọn tâm trạng (Tùy duyên, Muốn tâm sự, Vui vẻ, Tìm bạn game, Cùng học tập, Cần lắng nghe) giúp kết nối những người cùng "tần số cảm xúc".
- ✅ **Gợi ý phá băng (Icebreaker Prompts)** – Tự động đề xuất chủ đề & câu hỏi độc đáo (Hài hước, Giả định, Tâm sự, Sở thích) chỉ với 1 click, dập tan cảm giác sượng sùng, ngượng ngùng giữa 2 người lạ.
- ✅ **Minigame 1-1 (Cờ Caro 3x3)** – Tích hợp trò chơi đối kháng trực tiếp ngay trong phòng chat giúp tương tác sinh động, tạo tiếng cười và gắn kết tự nhiên.
- ✅ **Chống lợi dụng Tool & Targeted Pairing**:
  - Ghép theo mức độ tương thích trước thời hạn; khi bằng điểm giữ thứ tự FIFO. Sau thời gian chờ, ghép ứng viên hợp lệ theo FIFO.
  - `Anti-Skip Spam Cooldown`: Phát hiện bot bấm skip liên tục (> 5 lần/30s) và khóa tạm 30s.
  - `Anti-Same IP`: Có thể bật bằng `DISALLOW_SAME_IP=true`; mặc định tắt để hỗ trợ thử nghiệm nhiều tab trên máy local.
- ✅ **Báo cáo và chặn ghép cặp tạm thời**:
  - Báo cáo sẽ ngắt phòng chat và chặn hai phiên trình duyệt vừa ghép không gặp lại nhau trong 5 phút, kể cả khi tải lại cùng tab nếu `sessionStorage` còn giữ `deviceId`.
  - Tin nhắn bị bộ lọc nội dung từ chối sẽ ngắt phòng, ban người gửi 10 phút và chặn cặp thiết bị/IP trong bộ nhớ tiến trình.
- ✅ **Cảnh báo và kiểm tra liên kết** – Heuristic cục bộ luôn nhận diện dấu hiệu đáng ngờ; có thể bật Google Web Risk để tra cứu phishing/malware. URL được xác nhận nguy hiểm bị chặn trước khi chuyển tiếp; API lỗi sẽ hiển thị rõ trạng thái chưa xác minh. Web Risk tùy chọn, tắt mặc định; việc tra cứu chia sẻ URL với Google.
- ✅ **Gửi tệp trong chat** – Chia sẻ ảnh/video và tài liệu phổ biến qua Azure Blob Storage riêng tư; kiểm tra loại/dung lượng, URL tải chỉ đọc hết hạn 24 giờ, hỗ trợ lifecycle xóa file sau 7 ngày.
- ✅ **Tuân thủ tiêu chuẩn an toàn bảo mật (CVE, OWASP, NIST, RFC)**:
  - **OWASP ASVS v4.0 / CWE-1385:** Chống tấn công Cross-Site WebSocket Hijacking (CSWSH) qua xác thực `Origin` trong `verifyClient`.
  - **OWASP Top 10 A03:2021 / CWE-79:** Chống XSS qua cơ chế DOM `textContent` và schema validation.
  - **CWE-400 / CWE-770:** Giới hạn `maxPayload: 4096 bytes` và Sliding Window Rate Limiter chống tấn công DoS làm cạn kiệt bộ nhớ.
  - **CWE-307:** Chống spam Skip qua Cooldown 30s. FIFO là chính sách công bằng theo thứ tự vào hàng đợi, không phải biện pháp chống timing attack.
  - Chi tiết xem tại: [`docs/SECURITY_COMPLIANCE.md`](./docs/SECURITY_COMPLIANCE.md).
- ✅ **Bộ lọc từ cấm 6 nhóm theo chuẩn pháp lý & De-obfuscation Engine**:
  - Căn cứ **Luật An ninh mạng 2018 (Điều 8, 16, 18)**, **Nghị định 15/2020/NĐ-CP (Điều 101)**, **Bộ luật Hình sự 2015 (Điều 155, 156, 249, 251, 321)** và Tiêu chuẩn cộng đồng quốc tế.
  - Phân loại rõ ràng 6 danh mục:
    1. *Ma túy & chất kích thích cấm* (Cần sa, cỏ mỹ, ke kẹo, pod chill, bóng cười...).
    2. *Xúc phạm danh dự & kỳ thị vùng miền* (Bắc kỳ chó, mọi rợ, súc vật, óc chó...).
    3. *Cờ bạc trái phép & lừa đảo* (Tài xỉu, ku casino, go88, nạp rút...).
    4. *Bạo lực & đe dọa tính mạng* (Chém chết, đâm chết, giết...).
    5. *Quấy rối tình dục & khiêu dâm* (Chat sex, show hàng, lộ vú, gạ tình...).
    6. *Ngôn từ tục tĩu, khiếm nhã*.
  - Nhận diện các chiêu trò chèn ký tự phân tách để lách luật: `c.ầ.n  s.a`, `p-o-d  c*h*i*l*l`, `đ.ị.t  m.ẹ`, `t à i  x ỉ u`.
  - **Hình phạt:** Buộc rời phòng tức thì (Instant Kick), cấm kết nối 10 phút cả IP lẫn thiết bị và chặn cặp với đối phương trong bộ nhớ tiến trình.
- ✅ **Khả năng mở rộng (Scalability)** – Hỗ trợ kiến trúc Redis Pub/Sub đa node và dự phòng In-memory linh hoạt.
- ✅ **Hàng đợi ghép cặp Redis nguyên tử** – Chia sẻ hàng đợi và số người online giữa nhiều instance; giữ chấm điểm sở thích/tâm trạng, FIFO khi bằng điểm và nới điều kiện sau thời gian chờ.
- ✅ **Tự động kết nối lại (Exponential Backoff)** và **Ping/Pong Heartbeat** (RFC 6455) phát hiện kết nối chết.

## 🔧 Công nghệ sử dụng

- **Server:** Node.js + `ws` (WebSocket thuần) + Redis (tùy chọn)
- **Client:** HTML5 + Vanilla CSS3 (Dark Mode) + Vanilla JavaScript
- **Giao thức:** WebSocket (RFC 6455) trên TCP
- **Tài liệu tham khảo:**
  - [Kiến trúc hệ thống](file:///d:/WebSocket/docs/ARCHITECTURE.md)
  - [Đặc tả giao thức thông điệp](file:///d:/WebSocket/docs/PROTOCOL.md)
  - [Hướng dẫn Redis Pub/Sub nhiều instance](./docs/REDIS_GUIDE.md)
  - [Chính sách an toàn & Căn cứ pháp lý bộ lọc](file:///d:/WebSocket/docs/SECURITY_COMPLIANCE.md)
  - [Kế hoạch kiểm thử](file:///d:/WebSocket/docs/TESTING.md)

### Redis khi triển khai nhiều instance

Đặt `USE_REDIS=true` và cấu hình `REDIS_URL` tới Redis dùng chung cho tất cả instance. Redis giữ hàng đợi ghép cặp và số người online dùng chung; Lua script thực hiện ghép cặp nguyên tử để tránh một người bị ghép vào nhiều phòng. Nếu Redis được bật nhưng chưa kết nối, thao tác tìm người sẽ báo lỗi thay vì lặng lẽ chuyển sang hàng đợi cục bộ.

Redis giúp nhiều instance phối hợp và mở rộng tải; không đảm bảo tự thân làm một instance chạy nhanh hơn. Xem giới hạn các trạng thái còn lưu trong RAM và hướng dẫn triển khai tại [`docs/REDIS_GUIDE.md`](./docs/REDIS_GUIDE.md).

## 👥 Nhóm 9
