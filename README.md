# WebSocket – Nhóm 9

## 📌 Thông tin đề tài

**Chủ đề:** Xây dựng hệ thống ghép cặp và trò chuyện trực tuyến thời gian thực sử dụng WebSocket
**Nhóm:** Nhóm 9

Repository này được xây dựng nhằm tìm hiểu và thực hành **WebSocket**, một công nghệ hỗ trợ giao tiếp hai chiều (Two-way Communication) theo thời gian thực giữa **Client** và **Server** thông qua một kết nối TCP duy trì liên tục.

Thông qua đề tài, nhóm tìm hiểu nguyên lý hoạt động, kiến trúc, quá trình thiết lập kết nối WebSocket và xây dựng một hệ thống **ghép cặp ngẫu nhiên hai người dùng và trò chuyện trực tiếp (1-1)** để minh họa khả năng truyền nhận dữ liệu theo thời gian thực.

---

## 👥 Thành viên nhóm

| STT | Họ và tên                | MSSV           | Vai trò        |
| --- | ------------------------ | -------------- | -------------- |
| 1   | **Dương Đình Thuận**     | **2331540247** | 👑 Nhóm trưởng |
| 2   | **Nguyễn Thế Minh**      | **2331540226** | Thành viên     |
| 3   | **Huỳnh Thị Thanh Thảo** | **2431540240** | Thành viên     |

---

## 🧭 Định hướng đề tài

### Bài toán

Người dùng truy cập website, nhập biệt danh (và có thể chọn sở thích), sau đó bấm **"Bắt đầu"**. Hệ thống tự động **ghép cặp** người dùng đó với một người dùng khác đang chờ, rồi mở một phòng chat riêng giữa hai người. Bất cứ lúc nào, mỗi người có thể **bỏ qua (Skip)** để được ghép với người khác hoặc **thoát**.

### Luồng hoạt động tổng quát

```text
Người dùng mở web
      │
      ▼
Kết nối WebSocket ──> Nhập biệt danh / chọn sở thích
      │
      ▼
Gửi yêu cầu "find_match" ──> Vào hàng đợi (Waiting Queue)
      │
      ▼
Server tìm được người phù hợp ──> Tạo phòng chat 1-1
      │
      ▼
Hai người nhắn tin realtime ──> Skip / Thoát ──> Quay lại hàng đợi
```

### Phạm vi thực hiện

* Chat **văn bản** 1-1 giữa hai người được ghép cặp.
* Hàng đợi ghép cặp và quản lý phòng chat phía Server.
* Chỉ báo "đang nhập…", thông báo đối phương rời phòng, số người đang online.
* Cơ chế kiểm soát cơ bản: giới hạn tốc độ gửi tin, báo cáo (Report).
* Không lưu nội dung tin nhắn (chỉ giữ trong bộ nhớ khi phiên còn hoạt động).

> Video/voice call (WebRTC) **nằm ngoài phạm vi** của đề tài để tập trung vào WebSocket. Đây có thể là hướng mở rộng sau này.

---

## 🎯 Mục tiêu đề tài

Đề tài hướng đến các mục tiêu:

* Tìm hiểu khái niệm và vai trò của WebSocket.
* Tìm hiểu kiến trúc hoạt động của WebSocket.
* Phân biệt WebSocket với HTTP thông thường.
* Tìm hiểu quá trình **WebSocket Handshake**.
* Hiểu cơ chế giao tiếp hai chiều giữa Client và Server.
* Thiết kế **giao thức thông điệp (message protocol)** riêng cho ứng dụng.
* Xây dựng **thuật toán ghép cặp** dựa trên hàng đợi và sở thích người dùng.
* Quản lý nhiều kết nối đồng thời, xử lý ngắt kết nối và kết nối lại.
* Thực hành xây dựng ứng dụng giao tiếp theo thời gian thực.
* Đánh giá hiệu năng hệ thống bằng kiểm thử tải.

---

## 🔎 Các project tham khảo

Nhóm đã khảo sát một số project mã nguồn mở trên GitHub có chức năng tương tự (ghép cặp ngẫu nhiên + chat realtime):

| # | Project | Công nghệ chính | Cách ghép cặp | Điểm đáng chú ý |
| - | ------- | --------------- | ------------- | --------------- |
| 1 | [Vignesh318/matching-chat-app](https://github.com/Vignesh318/matching-chat-app) | Node.js, WebSocket | Hàng đợi vào trước – ghép trước (FIFO) | Chat văn bản 1-1, có Skip và Report. Tác giả nói rõ đây là prototype, chưa sẵn sàng cho production |
| 2 | [muhibrahimkhan/stranger-chat](https://github.com/muhibrahimkhan/stranger-chat) | Node.js, Express, Socket.IO, MongoDB | Ghép theo độ tương đồng sở thích (TF-IDF + cosine similarity) | Có dịch trực tiếp, kiểm duyệt nội dung, trang admin (JWT), kiến trúc tách lớp rõ ràng |
| 3 | [playsrc/omedev](https://github.com/playsrc/omedev) | Next.js, Pusher Channels, MongoDB | FIFO: tìm phòng trống, không có thì tạo phòng mới | Chỉ lưu id phòng trong tối đa 1 ngày, giao diện responsive, có light/dark theme |
| 4 | [testvoltas1-cyber/SwiftTalk](https://github.com/testvoltas1-cyber/SwiftTalk) | React, TypeScript, WebRTC DataChannel, WebSocket | Ghép theo thẻ sở thích (tùy chọn) | Tin nhắn P2P, WebSocket làm dự phòng, có Report / Block / lọc từ thô tục |
| 5 | [aryan9867bar/RandomVideoChat](https://github.com/aryan9867bar/RandomVideoChat) | FastAPI, Redis, WebSocket, WebRTC, Docker | Hàng đợi lưu trên Redis | Tách thành Matching Service và Signalling Service; có [phần frontend](https://github.com/aryan9867bar/RandomVideoChat-Web) riêng |
| 6 | [iamshiv007/omegle-clone](https://github.com/iamshiv007/omegle-clone) | Node.js, React, Socket.IO | Ghép ngẫu nhiên đơn giản | Bản clone cơ bản, dễ đọc để hiểu luồng hoạt động |

> 📝 Nội dung bảng trên được tổng hợp từ phần mô tả (README) của từng project. Nhóm sẽ đọc kỹ mã nguồn để xác nhận trước khi đưa vào báo cáo chính thức.

---

## 🚀 Nhóm sẽ làm thêm / phát triển thêm những gì?

Từ việc khảo sát ở trên, nhóm nhận thấy các project tham khảo phần lớn hướng đến sản phẩm hoàn chỉnh (video chat, dịch, admin…) và **dùng thư viện bọc sẵn (Socket.IO, Pusher)**, nên ít làm lộ rõ cách WebSocket thực sự hoạt động. Nhóm định hướng khác biệt như sau:

### 1. Dùng WebSocket thuần (thư viện `ws`) thay vì Socket.IO / Pusher

* Tự thiết kế và xử lý toàn bộ vòng đời kết nối: `open`, `message`, `close`, `error`.
* Giúp nhóm hiểu và trình bày rõ **Handshake, Frame, Ping/Pong, Close Code** – đúng trọng tâm của môn học.

### 2. Thiết kế giao thức thông điệp JSON có tài liệu rõ ràng

* Định nghĩa đầy đủ các loại message Client ↔ Server (xem mục [Giao thức thông điệp](#-giao-thức-thông-điệp)).
* Kiểm tra dữ liệu đầu vào (validate) ở Server, từ chối message sai định dạng.

### 3. Thuật toán ghép cặp có nới lỏng theo thời gian chờ

* Ưu tiên ghép người có **nhiều sở thích chung nhất**.
* Nếu chờ quá lâu (ví dụ 10 giây) thì **tự động nới lỏng điều kiện** và ghép ngẫu nhiên để tránh chờ vô hạn.
* Cách tính điểm đơn giản, dễ giải thích hơn so với TF-IDF, phù hợp quy mô đề tài.

### 4. Độ ổn định của kết nối

* **Heartbeat (Ping/Pong)** để phát hiện kết nối "chết" và dọn khỏi hàng đợi / phòng chat.
* **Tự động kết nối lại** ở Client (exponential backoff).
* Thông báo cho đối phương khi một bên mất kết nối đột ngột.

### 5. Trải nghiệm người dùng bằng tiếng Việt

* Giao diện và thông báo hoàn toàn tiếng Việt.
* Chỉ báo "đang nhập…", số người đang online, phím tắt Skip.

### 6. Kiểm soát lạm dụng ở mức cơ bản

* Giới hạn số tin nhắn/giây (rate limiting), giới hạn độ dài tin nhắn.
* Chức năng Report và chặn tạm người vừa ghép.
* Chống XSS bằng cách escape nội dung hiển thị.

### 7. Kiểm thử tải và đo hiệu năng

* Viết script mô phỏng hàng trăm client kết nối cùng lúc.
* Đo **độ trễ ghép cặp**, **độ trễ tin nhắn** và số kết nối tối đa mà Server xử lý ổn định.
* Đưa kết quả vào báo cáo để có số liệu thực tế.

### So sánh nhanh

| Tiêu chí | Các project tham khảo | Project của Nhóm 9 |
| -------- | --------------------- | ------------------ |
| Thư viện realtime | Phần lớn dùng Socket.IO / Pusher | WebSocket thuần (`ws`) |
| Ghép cặp | FIFO hoặc theo sở thích | Theo sở thích + nới lỏng theo thời gian chờ |
| Giao thức thông điệp | Thường không được mô tả chi tiết | Có tài liệu, có validate |
| Heartbeat / kết nối lại | Chưa thấy nhắc đến trong README | Có |
| Ngôn ngữ giao diện | Tiếng Anh | Tiếng Việt |
| Kiểm thử tải | Chưa thấy nhắc đến trong README | Có, kèm số liệu |
| Video / Voice | Một số project có | Không (ngoài phạm vi) |

---

## 🏗️ Kiến trúc hệ thống

```text
┌────────────┐                                        ┌────────────┐
│  Client A  │                                        │  Client B  │
│ (Browser)  │                                        │ (Browser)  │
└─────┬──────┘                                        └─────┬──────┘
      │  WebSocket                          WebSocket       │
      └───────────────────┐               ┌─────────────────┘
                          ▼               ▼
                ┌───────────────────────────────────┐
                │          WebSocket Server         │
                │                                   │
                │  ┌─────────────────────────────┐  │
                │  │ Connection Manager          │  │  quản lý kết nối, heartbeat
                │  ├─────────────────────────────┤  │
                │  │ Matchmaker (Waiting Queue)  │  │  ghép cặp theo sở thích
                │  ├─────────────────────────────┤  │
                │  │ Room Manager                │  │  tạo / hủy phòng chat 1-1
                │  ├─────────────────────────────┤  │
                │  │ Moderation                  │  │  rate limit, report
                │  └─────────────────────────────┘  │
                └───────────────────────────────────┘
```

### Vòng đời một phiên chat

```text
 CONNECTED ──find_match──> WAITING ──match_found──> CHATTING
     ▲                        │                        │
     │                        │ cancel                 │ skip / partner_left
     └────────────────────────┴────────────────────────┘
```

---

## 📨 Giao thức thông điệp

Mọi message đều là JSON có dạng `{ "type": "...", "payload": { ... } }`.

**Client → Server**

| type | payload | Mô tả |
| ---- | ------- | ----- |
| `join` | `nickname`, `interests[]` | Đăng ký biệt danh và sở thích |
| `find_match` | – | Vào hàng đợi để tìm người ghép cặp |
| `cancel` | – | Rời hàng đợi |
| `message` | `text` | Gửi tin nhắn cho đối phương |
| `typing` | `isTyping` | Báo đang nhập / ngừng nhập |
| `skip` | – | Bỏ qua người hiện tại, tìm người mới |
| `report` | `reason` | Báo cáo đối phương |

**Server → Client**

| type | payload | Mô tả |
| ---- | ------- | ----- |
| `connected` | `clientId`, `onlineCount` | Xác nhận kết nối thành công |
| `waiting` | – | Đang trong hàng đợi |
| `match_found` | `partnerNickname`, `commonInterests[]` | Ghép cặp thành công |
| `message` | `text`, `timestamp` | Tin nhắn từ đối phương |
| `typing` | `isTyping` | Đối phương đang nhập |
| `partner_left` | – | Đối phương đã thoát hoặc mất kết nối |
| `online_count` | `count` | Cập nhật số người online |
| `error` | `code`, `message` | Thông báo lỗi (sai định dạng, gửi quá nhanh…) |

---

## 📖 WebSocket là gì?

**WebSocket** là một giao thức truyền thông được thiết kế để cung cấp khả năng giao tiếp **hai chiều, toàn thời gian thực** giữa Client và Server trên một kết nối TCP duy trì liên tục.

Khác với mô hình HTTP truyền thống, trong đó Client thường gửi Request và chờ Server trả về Response, WebSocket cho phép cả Client và Server **chủ động gửi dữ liệu cho nhau** sau khi kết nối được thiết lập.

### Đặc điểm chính

* 🔄 Giao tiếp hai chiều (Full-Duplex).
* ⚡ Truyền dữ liệu theo thời gian thực.
* 🔗 Duy trì kết nối liên tục.
* 📡 Server có thể chủ động gửi dữ liệu đến Client.
* 🚀 Giảm overhead so với việc liên tục tạo HTTP Request.
* 🌐 Hoạt động trên nền TCP.

---

## 🔄 Cơ chế hoạt động

Quá trình giao tiếp WebSocket có thể được mô tả qua các bước:

```text
┌──────────────┐                         ┌──────────────┐
│    Client    │                         │    Server    │
└──────┬───────┘                         └──────┬───────┘
       │                                        │
       │  HTTP Upgrade Request                  │
       │───────────────────────────────────────>│
       │                                        │
       │  HTTP 101 Switching Protocols          │
       │<───────────────────────────────────────│
       │                                        │
       │        WebSocket Connection            │
       │<======================================>│
       │                                        │
       │  Message                               │
       │───────────────────────────────────────>│
       │                                        │
       │  Message                               │
       │<───────────────────────────────────────│
       │                                        │
       │  Close Connection                      │
       │<======================================>│
       │                                        │
```

### 1. Client gửi yêu cầu kết nối

Client bắt đầu bằng một HTTP Request và yêu cầu Server nâng cấp kết nối từ HTTP sang WebSocket thông qua header:

```http
Connection: Upgrade
Upgrade: websocket
```

### 2. Server xác nhận

Nếu Server hỗ trợ WebSocket, Server phản hồi:

```http
HTTP/1.1 101 Switching Protocols
```

Sau bước này, kết nối HTTP được nâng cấp thành kết nối WebSocket.

### 3. Trao đổi dữ liệu

Sau khi kết nối được thiết lập, Client và Server có thể gửi dữ liệu cho nhau bất kỳ lúc nào.

```text
Client ────────────────> Server
       Message

Client <──────────────── Server
       Message
```

### 4. Đóng kết nối

Khi không cần sử dụng WebSocket nữa, một trong hai phía có thể gửi Close Frame để kết thúc kết nối.

---

## ⚔️ WebSocket và HTTP

| Tiêu chí            | HTTP                         | WebSocket                           |
| ------------------- | ---------------------------- | ----------------------------------- |
| Mô hình             | Request / Response           | Hai chiều                           |
| Kết nối             | Thường theo từng Request     | Duy trì liên tục                    |
| Server chủ động gửi | Không thuận tiện             | Có                                  |
| Real-time           | Hạn chế                      | Tốt                                 |
| Overhead            | Cao hơn khi polling liên tục | Thấp hơn sau khi kết nối            |
| Ứng dụng            | Website, REST API            | Chat, Game, Notification, Live Data |

---

## 🧩 Các thành phần chính

### Client

Client là phía khởi tạo kết nối WebSocket và có thể gửi/nhận dữ liệu.

Ví dụ JavaScript:

```javascript
const socket = new WebSocket("ws://localhost:8080");

socket.onopen = () => {
    console.log("Đã kết nối WebSocket");
    socket.send(JSON.stringify({ type: "find_match" }));
};

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log("Server:", msg.type, msg.payload);
};

socket.onclose = () => {
    console.log("Kết nối đã đóng");
};

socket.onerror = (error) => {
    console.error("WebSocket Error:", error);
};
```

### Server

Server chịu trách nhiệm:

* Chấp nhận kết nối từ Client.
* Quản lý các kết nối đang hoạt động.
* Quản lý hàng đợi và **ghép cặp** người dùng.
* Tạo, quản lý và hủy các phòng chat 1-1.
* Nhận dữ liệu từ Client và chuyển tiếp cho đúng đối phương.
* Xử lý các sự kiện kết nối và ngắt kết nối.

---

## 💡 Ứng dụng thực tế

WebSocket được sử dụng trong nhiều hệ thống yêu cầu dữ liệu cập nhật theo thời gian thực:

### 💬 Ứng dụng Chat và ghép cặp

```text
User A ──> WebSocket Server ──> User B
```

Tin nhắn có thể được chuyển đến User B ngay lập tức mà không cần liên tục gửi HTTP Request. Đây cũng là nền tảng của các ứng dụng ghép cặp trò chuyện ngẫu nhiên.

### 🎮 Game Online

WebSocket có thể được sử dụng để truyền:

* Vị trí nhân vật.
* Trạng thái người chơi.
* Sự kiện trong game.
* Điểm số.
* Thông tin trận đấu.

### 🔔 Thông báo thời gian thực

Ví dụ:

```text
Server
   │
   ├──> User 1: Có thông báo mới
   ├──> User 2: Có thông báo mới
   └──> User 3: Có thông báo mới
```

### 📊 Dữ liệu trực tiếp

WebSocket phù hợp với các hệ thống cần cập nhật liên tục như:

* Dashboard.
* Giá cổ phiếu.
* Theo dõi đơn hàng.
* Trạng thái máy chủ.
* Hệ thống giám sát.

---

## 🛠️ Công nghệ sử dụng

* **WebSocket** (thư viện [`ws`](https://github.com/websockets/ws) cho Node.js)
* **TCP/IP**
* **HTTP/HTTPS**
* **HTML5**
* **CSS3**
* **JavaScript**
* **Node.js** (WebSocket Server)

---

## 📂 Cấu trúc Repository

Cấu trúc repository dự kiến:

```text
WebSocket/
│
├── client/
│   ├── index.html
│   ├── style.css
│   └── script.js
│
├── server/
│   ├── server.js          # Khởi tạo WebSocket Server, xử lý kết nối
│   ├── matchmaker.js      # Hàng đợi và thuật toán ghép cặp
│   ├── roomManager.js     # Quản lý phòng chat 1-1
│   ├── protocol.js        # Định nghĩa và kiểm tra message
│   └── package.json
│
├── tests/
│   └── load-test.js       # Script mô phỏng nhiều client
│
├── docs/
│   └── README.md
│
└── README.md
```

> Cấu trúc thư mục có thể thay đổi tùy theo quá trình triển khai thực tế của nhóm.

---

## 🚀 Hướng dẫn chạy Project

### Bước 1: Clone Repository

```bash
git clone <repository-url>
```

Di chuyển vào thư mục project:

```bash
cd WebSocket
```

### Bước 2: Cài đặt Dependencies

```bash
cd server
npm install
```

### Bước 3: Khởi động WebSocket Server

```bash
npm start
```

Hoặc:

```bash
node server.js
```

Server có thể được khởi chạy tại:

```text
ws://localhost:8080
```

### Bước 4: Chạy Client

Mở file:

```text
client/index.html
```

bằng trình duyệt hoặc sử dụng Live Server trong Visual Studio Code.

> Để thử ghép cặp, hãy mở `client/index.html` ở **hai tab (hoặc hai trình duyệt) khác nhau** và bấm "Bắt đầu" ở cả hai.

---

## 🧪 Kiểm thử

### Kiểm thử chức năng

Sau khi Server được khởi động, mở hai Client và thực hiện:

```text
Client A ── find_match ──> Server ──┐
                                    ├── match_found ──> A và B
Client B ── find_match ──> Server ──┘

Client A ── "Hello WebSocket!" ──> Server ──> Client B
Client B ── "Hello Client!"    ──> Server ──> Client A
```

Các tình huống cần kiểm tra:

* Ghép cặp thành công giữa hai người.
* Một người chờ một mình (chưa có ai để ghép).
* Skip: cả hai quay lại hàng đợi đúng cách.
* Một bên đóng tab đột ngột: bên còn lại nhận `partner_left`.
* Gửi message sai định dạng hoặc quá nhanh: Server trả về `error`.

### Kiểm thử tải

```bash
node tests/load-test.js
```

Chỉ số cần đo: độ trễ ghép cặp, độ trễ tin nhắn, số kết nối đồng thời tối đa.

---

## 🔐 WebSocket Secure

Đối với môi trường thực tế, WebSocket có thể sử dụng **WSS (WebSocket Secure)** thay cho WS.

| Giao thức | Mô tả                          |
| --------- | ------------------------------ |
| `ws://`   | WebSocket thông thường         |
| `wss://`  | WebSocket được mã hóa bằng TLS |

Ví dụ:

```javascript
const socket = new WebSocket("wss://example.com/socket");
```

`wss://` tương tự ý tưởng của HTTPS so với HTTP, giúp bảo vệ dữ liệu truyền giữa Client và Server.

---

## 🗺️ Kế hoạch thực hiện

- [ ] Khảo sát các project tham khảo, chốt phạm vi
- [ ] Dựng WebSocket Server cơ bản (kết nối, gửi nhận message)
- [ ] Thiết kế và cài đặt giao thức thông điệp
- [ ] Cài đặt hàng đợi và ghép cặp cơ bản (FIFO)
- [ ] Xây dựng giao diện chat (Client)
- [ ] Ghép cặp theo sở thích + nới lỏng theo thời gian chờ
- [ ] Heartbeat, tự kết nối lại, xử lý ngắt kết nối
- [ ] Rate limiting, Report
- [ ] Kiểm thử chức năng và kiểm thử tải
- [ ] Hoàn thiện báo cáo và slide

---

## 📚 Kiến thức đạt được

Sau khi hoàn thành đề tài, nhóm có thể:

* Hiểu được nguyên lý hoạt động của WebSocket.
* Hiểu quá trình HTTP Upgrade / WebSocket Handshake.
* Hiểu mô hình giao tiếp Full-Duplex.
* Xây dựng WebSocket Client.
* Xây dựng WebSocket Server.
* Xử lý các sự kiện `open`, `message`, `close`, `error`.
* Thiết kế giao thức thông điệp cho ứng dụng thời gian thực.
* Xây dựng cơ chế ghép cặp và quản lý phòng chat.
* Xử lý đồng thời nhiều kết nối, heartbeat và kết nối lại.
* Đánh giá hiệu năng hệ thống bằng kiểm thử tải.
* Áp dụng WebSocket vào các bài toán thực tế.

---

## 📌 Kết luận

WebSocket là một công nghệ quan trọng trong các hệ thống yêu cầu **giao tiếp thời gian thực**. Với khả năng duy trì kết nối liên tục và hỗ trợ giao tiếp hai chiều giữa Client và Server, WebSocket giúp xây dựng hiệu quả các ứng dụng như Chat Online, Game Online, Live Notification và Real-time Dashboard.

Thông qua đề tài **"Xây dựng hệ thống ghép cặp và trò chuyện trực tuyến thời gian thực sử dụng WebSocket"**, **Nhóm 9** tìm hiểu các khái niệm cơ bản, cơ chế hoạt động của WebSocket và triển khai chúng trong một ứng dụng thực tế, đồng thời phát triển thêm các tính năng như ghép cặp theo sở thích, heartbeat, kiểm soát lạm dụng và kiểm thử tải.

---

## 👨‍💻 Thông tin nhóm

**Nhóm 9**

* 👑 **Dương Đình Thuận** — 2331540247 — Nhóm trưởng
* 👨‍💻 **Nguyễn Thế Minh** — 2331540226 — Thành viên
* 👨‍💻 **Huỳnh Thị Thanh Thảo** — 2431540240 — Thành viên

---

⭐ **WebSocket – Nhóm 9**