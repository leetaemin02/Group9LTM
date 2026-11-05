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
│   ├── companionBot.js   # Trợ lý Lumi (chat & cờ Caro solo)
│   ├── groqChat.js       # Hội thoại Lumi qua Groq API (tùy chọn, model cascading)
│   ├── matchmaker.js     # Hàng đợi, mood matching & anti-targeted pairing
│   ├── roomManager.js    # Quản lý phòng chat 1-1 & Minigame Caro
│   ├── contentFilter.js  # Bộ lọc ngôn ngữ không phù hợp và nội dung nhạy cảm
│   ├── icebreakers.js    # Bộ câu hỏi phá băng kết nối người lạ
│   ├── protocol.js       # Giao thức thông điệp + schema validate
│   ├── moderation.js     # Rate limit, report, block, ban & anti-skip
│   ├── redisManager.js   # Redis Pub/Sub adapter (Multi-node scaling)
│   ├── linkSafety.js     # Heuristic nhận diện cấu trúc URL
│   ├── safeBrowsing.js   # Tra cứu URL với Google Safe Browsing API v4
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
- [Node.js](https://nodejs.org/) >= 22.x

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

### Chạy bằng Docker

Repository có thể chạy bằng Docker Compose mà không cần cài Node.js trực tiếp trên máy:

```powershell
docker compose up --build
```

Sau khi server khởi động, mở `http://localhost:3001`. Giữ terminal đang chạy; nhấn `Ctrl+C` để dừng. Lần sau có thể chạy `docker compose up` để khởi động lại.

Docker Compose khởi chạy ChatMatch cùng Redis; Redis AOF được lưu trong volume `redis_data`. Redis cần được bật để dùng hàng đợi dùng chung và bộ đếm quota upload. Container mặc định không bật upload Azure. Muốn dùng Azure Blob Storage, sao chép `.env.docker.example` thành `.env` ở thư mục gốc repository rồi điền cấu hình Storage và Service Principal. `az login` trên Windows không tự đăng nhập bên trong container. Không commit file `.env` hoặc chia sẻ `AZURE_CLIENT_SECRET`/`ATTACHMENT_TOKEN_SECRET`.

Docker Desktop chỉ chạy container trên máy hiện tại, chưa đưa website lên Internet. Muốn public, cần triển khai image lên nền tảng server. Render dùng `render.yaml` để tạo Docker Web Service `group9ltm` và Redis-compatible Key Value riêng; Render không chạy Redis trong cùng container hay triển khai nguyên Docker Compose stack. Dịch vụ Render Free có thể sleep khi không hoạt động; Redis Free không lưu bền và có thể mất dữ liệu khi restart.

### Public ứng dụng trên Render (không dùng Cloudflare)

`render.yaml` cấu hình một Docker Web Service `group9ltm` và một Render Key Value riêng, cùng region Singapore. Frontend và WebSocket dùng chung domain; trình duyệt tự kết nối `wss://` khi trang được mở bằng HTTPS của Render. Không cần Cloudflare Tunnel, VPS, hoặc mở cổng Redis công khai.

1. Đẩy thay đổi lên GitHub và merge vào nhánh `main`. Blueprint chỉ deploy nhánh `main`; các commit mới trên nhánh đó tự kích hoạt deploy.
2. Trong Render Dashboard, tạo **Blueprint Instance** từ repository `leetaemin02/Group9LTM` và xác nhận tạo cả `group9ltm` cùng `group9ltm-redis`. Nếu Render yêu cầu region, giữ Singapore cho cả hai.
3. Khi Render hỏi các biến `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` và `ATTACHMENT_TOKEN_SECRET`, nhập chúng trong giao diện Render dưới dạng secret. Để bật kiểm tra URL, nhập `GOOGLE_SAFE_BROWSING_API_KEY`; API này miễn phí, không yêu cầu billing/thẻ, và chỉ được dùng cho mục đích phi thương mại. `ATTACHMENT_TOKEN_SECRET` phải có ít nhất 32 byte; không đưa secrets vào Git. Azure Service Principal cần quyền phù hợp để ghi và đọc Blob, đồng thời tài khoản Storage phải bật malware scanning nếu muốn giữ kiểm tra tệp nghiêm ngặt.
4. Chờ Web Service deploy thành công, mở URL `onrender.com` do Render hiển thị trên trang dịch vụ và thử ghép hai trình duyệt/thiết bị khác nhau, gửi tin nhắn và kiểm tra upload.
5. Để cập nhật website, merge thay đổi qua quy trình Git của dự án vào `main`. Render tự build/deploy; không cần cập nhật Cloudflare hay nhấn “Sync changes” để deploy.

**Giới hạn quan trọng của lựa chọn Free:** Render sẽ cho Web Service ngủ sau 15 phút không có lưu lượng; lần truy cập/kết nối WebSocket tiếp theo có thể mất khoảng một phút để khởi động. Render Key Value Free chỉ giữ dữ liệu trong bộ nhớ và có thể mất toàn bộ dữ liệu khi restart hoặc bảo trì. Điều này có thể làm mất hàng đợi và reset bộ đếm quota upload 500 MB; giới hạn này vì vậy không đảm bảo là trần chi phí cứng. Free phù hợp thử nghiệm/hobby, không đảm bảo website luôn sẵn sàng 24/7. Muốn tránh sleep và có Redis persistence cần nâng cấp các dịch vụ tương ứng lên gói trả phí.

### Giới hạn upload

Backend chỉ nhận file upload khi Redis đang bật và kết nối sẵn sàng. Redis dự trữ quota atomically trước khi nhận nội dung file: tối đa 5 file và 50 MiB cho mỗi cuộc trò chuyện, cùng giới hạn trọn đời 500,000,000 bytes (500 MB thập phân) trên toàn hệ thống. Khi đạt giới hạn toàn hệ thống, upload mới bị từ chối cho tới khi bộ đếm được reset thủ công; xóa blob không hoàn lại quota. Một upload được tính khi HTTP upload bắt đầu, nên upload thất bại sau bước reserve vẫn có thể tiêu quota để tránh cấp vượt hạn mức.

Giới hạn trọn đời chỉ là best-effort khi dùng Render Key Value Free: instance miễn phí không ghi liên tục dữ liệu xuống đĩa, và restart có thể làm mất counter, khiến giới hạn bắt đầu lại. Không dùng cấu hình này làm cam kết cứng về chi phí Azure. Redis local trong Compose có AOF/volume; điều này không thay đổi tính bền vững của Render Free Key Value. Azure vẫn có thể tính phí giao dịch, quét malware và tải xuống; đặt Azure budget alert riêng.

### Bật kiểm tra liên kết với Google Safe Browsing (tùy chọn, không cần thẻ)

Mặc định ứng dụng chỉ dùng heuristic cục bộ; link bình thường không bị cảnh báo chung. Để đối chiếu URL với [Google Safe Browsing API v4](https://developers.google.com/safe-browsing/v4/lookup-api):
1. Tạo/chọn Google Cloud project, bật **Safe Browsing API** (API v4) và tạo API key. Tài liệu Google nêu API miễn phí, không cần bật billing hoặc nhập thẻ. Giới hạn key chỉ dùng Safe Browsing API; nếu key trước đó bị giới hạn cho Web Risk API, sửa restriction hoặc tạo key mới.
2. Cấu hình key dưới dạng secret `GOOGLE_SAFE_BROWSING_API_KEY` trong Render hoặc biến môi trường local. Không commit key hoặc đặt key trong frontend.
3. Server gửi tối đa 5 URL trong một request để tra cứu phishing, malware và unwanted software. URL khớp threat list sẽ bị chặn; link sạch không bị cảnh báo chung. Khi Google đánh dấu link, giao diện hiển thị cảnh báo theo hướng dẫn và đường dẫn Safe Browsing Advisory.
4. Nếu thiếu key hoặc API tạm lỗi, tin nhắn vẫn được gửi; ứng dụng không hiện cảnh báo lỗi dịch vụ cho mọi URL, nhưng vẫn cảnh báo dấu hiệu cấu trúc đáng ngờ. “Không có trong danh sách” không đảm bảo an toàn. URL được gửi tới Google để kiểm tra, nên tránh dùng cho URL riêng tư.
5. Safe Browsing API v4 đã deprecated và chỉ được dùng cho mục đích phi thương mại. Đây là phương án miễn phí cho project học tập, không nên dựa vào như dịch vụ thương mại lâu dài. Google có thể ngừng hỗ trợ hoặc thay đổi hạn mức.

Ví dụ PowerShell cho phiên chạy local (không lưu key trong source):
```powershell
$env:GOOGLE_SAFE_BROWSING_API_KEY='YOUR_API_KEY'
npm start
```

Việc bật API gửi URL nguyên bản (có thể gồm path/query) tới Google. Hãy thông báo người dùng và cân nhắc quyền riêng tư trước khi bật; API miễn phí nhưng có hạn mức sử dụng. Link rút gọn có thể che giấu đích đến; ứng dụng không tự mở link hoặc theo redirect.

### Gửi ảnh, video và tài liệu

Tính năng đính kèm dùng Azure Blob Storage; nếu chưa cấu hình tài khoản storage, nút đính kèm sẽ báo chưa khả dụng. Tệp được gửi qua server tới container riêng tư, không bật public access:

- Ảnh: JPG/JPEG, PNG, GIF, WebP; tài liệu: PDF, DOCX, XLSX, PPTX, TXT, CSV — tối đa 10 MB mỗi tệp.
- Video: MP4 hoặc WebM — tối đa 50 MB.
- Tệp khác (bao gồm chương trình/script và SVG) bị từ chối. Server kiểm tra phần mở rộng, dung lượng và chữ ký định dạng cơ bản, sau đó chờ Azure Defender for Storage quét malware; chỉ kết quả `No threats found` mới được chia sẻ.
- Người nhận tải trực tiếp từ Blob qua URL HTTPS có quyền chỉ đọc, hết hạn sau 24 giờ. Policy Azure lifecycle mẫu đặt ngưỡng xóa blob trong prefix `chat/` sau 1 ngày (24 giờ). Đây không phải cam kết xóa đúng hoặc tối đa trong 24 giờ: policy xử lý bất đồng bộ, lần chạy đầu sau khi tạo/sửa có thể bắt đầu trễ tới 24 giờ, và blob có thể còn tồn tại lâu hơn. Hạn link tải không tự xóa blob.
- Kết quả `Malicious`, `Error`, `Not scanned`, thiếu kết quả hoặc vượt thời gian chờ đều bị từ chối (fail-closed). Azure Defender có thể quét chậm; app chờ tối đa 3 phút mặc định. Bật Defender for Storage **On-upload malware scanning**, giữ bật blob index tags và đặt giới hạn chi phí quét hàng tháng.

Thiết lập:
1. Tạo Azure Storage account loại General-purpose v2 và container `chat-attachments`. Tắt anonymous/public access ở cả account và container; chỉ bật HTTPS và tối thiểu TLS 1.2.
2. Bật Defender for Storage và **On-upload malware scanning** cho Storage Account. Để mặc định bật kết quả blob index tags và cấu hình monthly scan cap/chi phí. Có thể bật soft delete/quarantine cho blob bị phát hiện có mã độc.
3. Bật system-assigned Managed Identity cho ứng dụng chạy ở Azure. Cấp `Storage Blob Data Contributor` ở phạm vi container và `Storage Blob Delegator` ở phạm vi Storage Account. Khi phát triển local, dùng identity của `az login` và cấp hai role tương tự cho user đó.
4. Đặt `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_CONTAINER_NAME` trong environment. Nếu dùng endpoint tùy chỉnh, đặt thêm `AZURE_STORAGE_BLOB_ENDPOINT`; mặc định SDK dùng `https://<account>.blob.core.windows.net`.
5. Sinh `ATTACHMENT_TOKEN_SECRET` bằng lệnh bên dưới rồi đưa vào secret store của môi trường deploy. Dùng cùng giá trị trên mọi instance; không commit `.env` hay in secret ra log.
6. Áp dụng [policy lifecycle mẫu](./docs/azure-blob-lifecycle-policy.json) bằng Azure CLI hoặc Azure Portal. Prefix phải có dạng `<container>/chat/`; nếu đổi tên container, sửa prefix tương ứng. Policy đặt ngưỡng tuổi blob 1 ngày, không bảo đảm blob bị xóa chính xác hoặc tối đa sau 24 giờ.
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

az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Owner' --scope $containerScope
az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role 'Storage Blob Delegator' --scope $storageId
```

`Storage Blob Data Owner` ở scope container cần thiết vì ứng dụng đọc Defender malware-scan tags trước khi chia sẻ tệp; role này cũng bao gồm quyền dữ liệu cần cho upload. `Storage Blob Delegator` ở scope storage account cho phép tạo user-delegation SAS để cấp link tải chỉ đọc.

Với local developer, lấy Object ID bằng `$principalId = az ad signed-in-user show --query id --output tsv` và đổi `ServicePrincipal` thành `User`. Cần quyền quản trị phù hợp để tạo role assignment; sau khi gán role, có thể cần chờ vài phút để RBAC có hiệu lực. Container có thể tạo từ Portal nếu lệnh CLI chưa được cấp quyền data-plane.

Policy JSON mẫu dùng container `chat-attachments`. Azure có thể mất tới 24 giờ để bắt đầu lượt chạy đầu tiên sau khi tạo/sửa policy; các lượt xử lý tiếp theo cũng bất đồng bộ. Nếu tài khoản đã có lifecycle policy khác, hãy gộp rule này vào policy hiện tại thay vì ghi đè các rule đang dùng. Lệnh cần quyền quản lý Storage Account:
```powershell
az storage account management-policy create --resource-group $resourceGroup --account-name $storageAccount --policy '@docs/azure-blob-lifecycle-policy.json'
az storage account management-policy show --resource-group $resourceGroup --account-name $storageAccount
```

Có thể xem và xóa thủ công tệp trong Azure Portal: **Storage accounts → tài khoản storage → Data storage → Containers → `chat-attachments` → `chat/`** (Storage browser/Container). Container phải private; không bật anonymous access. Lifecycle policy nằm ở **Data management → Lifecycle management** trong Storage Account. Rule áp dụng cho blob có đường dẫn `chat/`; chỉ backend gửi file lên, Azure Blob Storage là nơi lưu file, không phải filesystem của VPS hay Git repository. Nếu bật soft delete, blob đã xóa vẫn có thể khôi phục trong thời gian lưu soft-delete; nếu bật versioning, cần policy riêng để xóa các phiên bản cũ.

Trong Azure App Service/Container Apps, bật Managed Identity, đặt các biến môi trường trên dưới dạng app settings/secret, rồi khởi động lại ứng dụng. Trên mọi replica phải dùng cùng account, container và `ATTACHMENT_TOKEN_SECRET`; mỗi identity phải có role phù hợp.

Ứng dụng dùng `DefaultAzureCredential`: Managed Identity trên Azure và thông tin xác thực developer đã đăng nhập khi chạy local; không lưu Storage Account Key trong mã nguồn. Upload đi qua backend để kiểm tra kích thước/chữ ký, vì vậy backend cần đủ băng thông cho tệp (đến 50 MB). Mỗi process mặc định xử lý tối đa 4 upload đồng thời. Blob index tags là kết quả scan do Defender ghi nhưng không chống sửa đổi; container phải private, không cấp credentials cho browser và chỉ backend được phép tạo SAS sau khi kiểm tra kết quả. Kết quả “No threats found” không bảo đảm tệp vô hại tuyệt đối. Tin nhắn không được lưu lịch sử sau phòng chat; blob được dọn theo lifecycle policy, nhưng ngưỡng 24 giờ không phải cam kết xóa chính xác/tối đa trong 24 giờ. Khi bổ sung tính năng nối lại, cần lưu metadata/định danh cuộc trò chuyện riêng và chấp nhận tệp hết hạn nếu thời gian nối lại vượt quá thời hạn lưu.

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
| `game_invite` | `size` (10, 15 hoặc 20) | Mời đối phương chơi Caro bàn 10x10, 15x15 hoặc 20x20 |
| `game_accept` | `size` (10, 15 hoặc 20) | Chấp nhận thách đấu cờ Caro theo kích thước lời mời |
| `game_move` | `index` | Đánh nước đi theo chỉ số ô trên bàn đã chọn (0-399) |
| `game_reset` | `size` (tùy chọn) | Chơi lại ván mới, có thể chọn bàn 10x10, 15x15 hoặc 20x20 |
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
  - **Minigame Caro 10x10/15x15/20x20 với Lumi:** Bàn cờ nhỏ nhất là 10x10; người chơi có thể chọn thêm bàn 15x15 hoặc 20x20. Nối 5 quân liên tiếp để thắng. Bot tính nước đi bằng chiến thuật cục bộ, ưu tiên thắng, chặn đối thủ và phát triển chuỗi quân.
  - **Trò chuyện Lumi linh hoạt (Groq API tùy chọn + Offline fallback):** Mặc định khi chưa cấu hình `GROQ_API_KEY`, Lumi chạy offline bằng kịch bản từ khóa mà không gọi dịch vụ bên ngoài. Khi cấu hình `GROQ_API_KEY`, Lumi trò chuyện tự nhiên qua Groq với định tuyến model thông minh (câu ngắn/tán gẫu dùng `llama-3.1-8b-instant`, câu dài/tâm sự sâu dùng `llama-3.3-70b-versatile`), bộ nhớ ngữ cảnh ngắn, chống prompt injection nhiều lớp và tự quay về kịch bản offline nếu mất mạng hoặc hết hạn mức.
  - **Hiệu ứng Typing mượt mà:** Bot mô phỏng độ trễ gõ phím chân thực (0.8s - 1.8s) như một người bạn thật sự.
  - **Chuyển đổi linh hoạt:** Khi người dùng muốn tìm người thật, chỉ cần bấm nút "👥 Tìm người thật" là được đưa ngay về hàng đợi `Matchmaker`.
- ✅ **WebSocket thuần (`ws`)** – Tuân thủ chuẩn RFC 6455, hiệu năng cao, không phụ thuộc socket.io.
- ✅ **Ghép cặp theo Tâm trạng (Mood Matching)** – Chọn tâm trạng (Tùy duyên, Muốn tâm sự, Vui vẻ, Tìm bạn game, Cùng học tập, Cần lắng nghe) giúp kết nối những người cùng "tần số cảm xúc".
- ✅ **Gợi ý phá băng (Icebreaker Prompts)** – Tự động đề xuất chủ đề & câu hỏi độc đáo (Hài hước, Giả định, Tâm sự, Sở thích) chỉ với 1 click, dập tan cảm giác sượng sùng, ngượng ngùng giữa 2 người lạ.
- ✅ **Minigame 1-1 (Cờ Caro 10x10, 15x15 hoặc 20x20)** – Hỗ trợ bàn cờ tối thiểu 10x10; nối 5 quân liên tiếp để thắng.
- ✅ **Chống lợi dụng Tool & Targeted Pairing**:
  - Ghép theo mức độ tương thích trước thời hạn; khi bằng điểm giữ thứ tự FIFO. Sau thời gian chờ, ghép ứng viên hợp lệ theo FIFO.
  - `Anti-Skip Spam Cooldown`: Phát hiện bot bấm skip liên tục (> 5 lần/30s) và khóa tạm 30s.
  - `Anti-Same IP`: Có thể bật bằng `DISALLOW_SAME_IP=true`; mặc định tắt để hỗ trợ thử nghiệm nhiều tab trên máy local.
- ✅ **Báo cáo và chặn ghép cặp tạm thời**:
  - Báo cáo sẽ ngắt phòng chat và chặn hai phiên trình duyệt vừa ghép không gặp lại nhau trong 5 phút, kể cả khi tải lại cùng tab nếu `sessionStorage` còn giữ `deviceId`.
  - Tin nhắn bị bộ lọc nội dung từ chối sẽ ngắt phòng, ban người gửi 10 phút và chặn cặp thiết bị/IP trong bộ nhớ tiến trình.
- ✅ **Cảnh báo và kiểm tra liên kết** – Heuristic cục bộ nhận diện một số dấu hiệu đáng ngờ; tùy chọn đối chiếu URL với Google Safe Browsing v4. URL được API đánh dấu bị chặn; dịch vụ miễn phí, nhưng đã deprecated, phi thương mại và gửi URL Google để kiểm tra.
- ✅ **Gửi tệp trong chat** – Chia sẻ ảnh/video và tài liệu phổ biến qua Azure Blob Storage riêng tư; kiểm tra loại/dung lượng, URL tải chỉ đọc hết hạn sau 24 giờ, có policy mẫu để Azure bắt đầu xóa blob sau 1 ngày (thời điểm xóa thực tế có thể trễ).
- ✅ **Tuân thủ tiêu chuẩn an toàn bảo mật (CVE, OWASP, NIST, RFC)**:
  - **OWASP ASVS v4.0 / CWE-1385:** Chống tấn công Cross-Site WebSocket Hijacking (CSWSH) qua xác thực `Origin` trong `verifyClient`.
  - **OWASP Top 10 A03:2021 / CWE-79:** Chống XSS qua cơ chế DOM `textContent` và schema validation.
  - **CWE-400 / CWE-770:** Giới hạn `maxPayload: 4096 bytes` và Sliding Window Rate Limiter chống tấn công DoS làm cạn kiệt bộ nhớ.
  - **CWE-307:** Chống spam Skip qua Cooldown 30s. FIFO là chính sách công bằng theo thứ tự vào hàng đợi, không phải biện pháp chống timing attack.
  - Chi tiết xem tại: [`docs/SECURITY_COMPLIANCE.md`](./docs/SECURITY_COMPLIANCE.md).
- ✅ **Bộ lọc nội dung 6 nhóm theo quy định & De-obfuscation Engine**:
  - Căn cứ **Luật An ninh mạng 2018 (Điều 8, 16, 18)**, **Nghị định 15/2020/NĐ-CP (Điều 101)**, **Bộ luật Hình sự 2015 (Điều 155, 156, 249, 251, 321)** và Tiêu chuẩn cộng đồng quốc tế.
  - Phân loại rõ ràng 6 danh mục:
    1. *Ma túy và chất kích thích bị kiểm soát* (ví dụ: cần sa và các chất bị cấm).
    2. *Xúc phạm danh dự và kỳ thị vùng miền*.
    3. *Cờ bạc trái phép và lừa đảo tài chính*.
    4. *Bạo lực và đe dọa gây tổn hại*.
    5. *Quấy rối và nội dung gợi dục hoặc nhạy cảm*.
    6. *Ngôn ngữ thiếu lịch sự hoặc công kích*.
  - Nhận diện cách viết biến đổi hoặc chèn ký tự nhằm né bộ lọc.
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
