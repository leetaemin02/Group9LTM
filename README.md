# WebSocket – Nhóm 9

## 📌 Thông tin đề tài

**Chủ đề:** WebSocket
**Nhóm:** Nhóm 9

Repository này được xây dựng nhằm tìm hiểu và thực hành **WebSocket**, một công nghệ hỗ trợ giao tiếp hai chiều (Two-way Communication) theo thời gian thực giữa **Client** và **Server** thông qua một kết nối TCP duy trì liên tục.

Thông qua đề tài, nhóm tìm hiểu nguyên lý hoạt động, kiến trúc, quá trình thiết lập kết nối WebSocket và xây dựng chương trình minh họa khả năng truyền nhận dữ liệu theo thời gian thực.

---

## 👥 Thành viên nhóm

| STT | Họ và tên            | MSSV           | Vai trò        |
| --- | -------------------- | -------------- | -------------- |
| 1   | **Dương Đình Thuận** | **2331540247** | 👑 Nhóm trưởng |
| 2   | **Nguyễn Thế Minh**  | **2331540226** | Thành viên     |
   
---

## 🎯 Mục tiêu đề tài

Đề tài hướng đến các mục tiêu:

* Tìm hiểu khái niệm và vai trò của WebSocket.
* Tìm hiểu kiến trúc hoạt động của WebSocket.
* Phân biệt WebSocket với HTTP thông thường.
* Tìm hiểu quá trình **WebSocket Handshake**.
* Hiểu cơ chế giao tiếp hai chiều giữa Client và Server.
* Thực hành xây dựng ứng dụng giao tiếp theo thời gian thực.
* Thực hiện truyền và nhận dữ liệu thông qua WebSocket.
* Tìm hiểu các ứng dụng thực tế của WebSocket.

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
};

socket.onmessage = (event) => {
    console.log("Server:", event.data);
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
* Nhận dữ liệu từ Client.
* Gửi dữ liệu đến Client.
* Xử lý các sự kiện kết nối và ngắt kết nối.

---

## 💡 Ứng dụng thực tế

WebSocket được sử dụng trong nhiều hệ thống yêu cầu dữ liệu cập nhật theo thời gian thực:

### 💬 Ứng dụng Chat

```text
User A ──> WebSocket Server ──> User B
```

Tin nhắn có thể được chuyển đến User B ngay lập tức mà không cần liên tục gửi HTTP Request.

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

Tùy thuộc vào phần thực hành của nhóm, project có thể sử dụng:

* **WebSocket**
* **TCP/IP**
* **HTTP/HTTPS**
* **HTML5**
* **CSS3**
* **JavaScript**
* **Node.js** *(nếu sử dụng Node.js làm WebSocket Server)*

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
│   ├── server.js
│   └── package.json
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

Nếu Server sử dụng Node.js:

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

---

## 🧪 Kiểm thử

Sau khi Server được khởi động, Client thực hiện kết nối:

```text
Client
   │
   │ WebSocket Connection
   ▼
Server
   │
   │ Connection Established
   ▼
Client
```

Khi Client gửi một message:

```text
Client
   │
   │ "Hello WebSocket!"
   ▼
Server
```

Server có thể xử lý và phản hồi:

```text
Server
   │
   │ "Hello Client!"
   ▼
Client
```

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

## 📚 Kiến thức đạt được

Sau khi hoàn thành đề tài, nhóm có thể:

* Hiểu được nguyên lý hoạt động của WebSocket.
* Hiểu quá trình HTTP Upgrade / WebSocket Handshake.
* Hiểu mô hình giao tiếp Full-Duplex.
* Xây dựng WebSocket Client.
* Xây dựng WebSocket Server.
* Xử lý các sự kiện `open`, `message`, `close`, `error`.
* Truyền dữ liệu theo thời gian thực.
* Áp dụng WebSocket vào các bài toán thực tế.

---

## 👥 Phân công thành viên

### Dương Đình Thuận – 2331540247

**Vai trò:** Nhóm trưởng

Nội dung phụ trách:

* Quản lý và tổ chức repository.
* Nghiên cứu nguyên lý WebSocket.
* Xây dựng và kiểm thử Server.
* Tổng hợp nội dung báo cáo.

### Nguyễn Thế Minh – 2331540226

**Vai trò:** Thành viên

Nội dung phụ trách:

* Nghiên cứu WebSocket Client.
* Xây dựng giao diện thực hành.
* Kiểm thử quá trình truyền nhận dữ liệu.
* Hỗ trợ tài liệu và báo cáo.

---

## 📌 Kết luận

WebSocket là một công nghệ quan trọng trong các hệ thống yêu cầu **giao tiếp thời gian thực**. Với khả năng duy trì kết nối liên tục và hỗ trợ giao tiếp hai chiều giữa Client và Server, WebSocket giúp xây dựng hiệu quả các ứng dụng như Chat Online, Game Online, Live Notification và Real-time Dashboard.

Thông qua đề tài, **Nhóm 9** đã tìm hiểu các khái niệm cơ bản, cơ chế hoạt động và cách triển khai WebSocket trong một ứng dụng thực tế.

---

## 👨‍💻 Thông tin nhóm

**Nhóm 9**

* 👑 **Dương Đình Thuận** — 2331540247 — Nhóm trưởng
* 👨‍💻 **Nguyễn Thế Minh** — 2331540226 — Thành viên

---

⭐ **WebSocket – Nhóm 9**
