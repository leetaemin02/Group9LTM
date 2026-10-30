# CHÍNH SÁCH BẢO MẬT, TIÊU CHUẨN AN TOÀN & CĂN CỨ PHÁP LÝ BỘ LỌC TỪ CẤM

> Tài liệu này mô tả chi tiết các phương pháp kỹ thuật, tiêu chuẩn an toàn bảo mật thông tin (theo CVE, OWASP, NIST, RFC) và căn cứ pháp lý áp dụng trong hệ thống ghép cặp trực tuyến thời gian thực qua WebSocket.

---

## 1. CẢNH BÁO LIÊN KẾT TRONG TIN NHẮN ẨN DANH

`backend/linkSafety.js` nhận diện URL phổ biến và cảnh báo các dấu hiệu như HTTP không mã hóa, URL shortener đã biết, hostname dạng punycode/IP, thông tin đăng nhập nhúng, cổng lạ và đường dẫn có từ khóa liên quan đăng nhập/tài khoản/thanh toán. Server chỉ hiển thị nội dung bằng `textContent`, không tự biến URL thành liên kết có thể bấm.

`backend/webRisk.js` cung cấp tra cứu reputation tùy chọn qua Google Web Risk. Khi `GOOGLE_WEB_RISK_API_KEY` được cấu hình, server kiểm tra tối đa 5 URL duy nhất mỗi tin nhắn trước khi chuyển tiếp; URL khớp loại đe dọa sẽ chặn toàn bộ tin nhắn và thông báo cho cả hai phía. Tin nhắn vượt quá giới hạn 5 URL cũng bị chặn để không bỏ sót URL. Không khớp danh sách chỉ được hiển thị là “chưa ghi nhận”, không tuyên bố an toàn. API lỗi/timeout được báo là chưa kiểm tra và tin nhắn vẫn được phép gửi.

Web Risk tắt nếu không cấu hình API key. Khi bật, URL nguyên bản (bao gồm path/query) được gửi tới Google; cần công khai điều này trong chính sách quyền riêng tư, hạn chế API key chỉ dùng Web Risk, quản lý bằng secret store và theo dõi hạn mức/chi phí. Kết quả reputation được cache tối đa 5 phút trong bộ nhớ của từng tiến trình; cache không chia sẻ giữa các instance.

Ứng dụng không tự tải URL hoặc theo redirect, tránh SSRF. Heuristic và reputation đều có thể có false positive/negative; link rút gọn có thể che giấu đích thật và URL mới có thể chưa nằm trong threat list.

## 2. TỆP ĐÍNH KÈM CHAT

Tệp được lưu trong Azure Blob Storage private container. Backend dùng `DefaultAzureCredential` (Managed Identity trên Azure, developer identity khi local), kiểm tra allowlist phần mở rộng/MIME, giới hạn dung lượng và chữ ký file cơ bản. Sau upload, backend chờ blob index tag `Malware Scanning scan result` của Defender for Storage; chỉ giá trị `No threats found` mới được cấp link. Kết quả độc hại, lỗi, không quét được, tag không hợp lệ hoặc hết thời gian chờ đều fail-closed. Upload ticket được ký HMAC bằng `ATTACHMENT_TOKEN_SECRET`, giới hạn theo client/phòng chat và hết hạn sau 30 phút; upload chỉ qua endpoint cùng origin, không cấp quyền ghi Blob trực tiếp cho browser. Link tải là user-delegation SAS chỉ đọc qua HTTPS, hết hạn sau 24 giờ.

Allowlist: JPG/JPEG, PNG, GIF, WebP, MP4, WebM, PDF, DOCX, XLSX, PPTX, TXT và CSV. Ảnh/tài liệu tối đa 10 MB; video tối đa 50 MB. Tệp văn phòng được phục vụ dưới dạng download; SVG, executable và script không được chấp nhận. Kiểm tra signature chỉ xác nhận cấu trúc sơ bộ, **không thay thế quét malware**. Chỉ gửi link khi upload thành công và sender vẫn ở đúng phòng chat.

Thiết lập container private, bật Defender for Storage On-upload malware scanning và giữ kết quả blob index tags bật. Role `Storage Blob Data Contributor` cần ở scope container và `Storage Blob Delegator` ở scope Storage Account. Tag không chống sửa đổi; không cấp credential storage cho browser, và chỉ backend được phép phát SAS sau khi đọc kết quả Defender. Mọi node cần cùng `ATTACHMENT_TOKEN_SECRET`. Cấu hình Azure lifecycle xóa blob trong `chat-attachments/chat/` sau 7 ngày; việc tạo rule lifecycle là bước vận hành riêng, không được tự động cấu hình bởi ứng dụng.

---

## 3. BLOCK BÁO CÁO TẠM THỜI VÀ BLOCK SAU VI PHẠM NGHIÊM TRỌNG

Hai luồng block có thời hạn và phạm vi khác nhau:

```
+-----------------------------------------------------------------------------------+
|             TEMPORARY REPORT AND CONTENT-VIOLATION BLOCKS                         |
+-----------------------------------------------------------------------------------+
  [Nạn nhân report / Kẻ vi phạm nội dung nghiêm trọng]
                      │
                      ▼
  +─────────────────────────────────────────────────────────+
  |                moderation.isBlocked()                   |
  +─────────────────────────────────────────────────────────+
            │                         │
            ▼                         ▼
  +───────────────────+     +───────────────────+
  | Temporary Device Pair | | Device/IP Pair     |
  |       (5 phút)       | | (content filter)    |
  +───────────────────+     +───────────────────+
            │                         │
            +───────────┬─────────────+
                        │
                        ▼
  +─────────────────────────────────────────────────────────+
  |            matchmaker.isBlocked(Entry1, Entry2)         |
  +─────────────────────────────────────────────────────────+
  | • Report: deviceId pair (5 phút, nếu có)                 |
  | • Nội dung bị lọc: deviceId/IP pair trong process       |
  | • Redis report TTL: 300 giây khi được cấu hình          |
  +─────────────────────────────────────────────────────────+
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
    [TRÙNG KHỚP CHẶN]              [HỢP LỆ]
  Từ chối cặp còn block       Ghép cặp bình thường
```

### 3.1. Phạm vi và vòng đời block:
1. **Report:** `moderation.addReport()` ghi nhận báo cáo, ngắt phòng chat và block cặp người dùng hai chiều trong 5 phút. Client dùng `sessionStorage` cho `deviceId`, nên block còn hiệu lực khi tải lại cùng tab; nếu client không gửi `deviceId`, server dùng `clientId` và không thể nhận diện phiên mới. Report không ghi vào `permanentBlocks`.
2. **Tin nhắn bị bộ lọc nội dung từ chối:** server gọi `addPermanentBlock()` cho cặp nạn nhân/người gửi vi phạm và ban client/IP 10 phút. Block thiết bị/IP này được lưu trong bộ nhớ của tiến trình, không phải dữ liệu bền vững qua lần khởi động lại server.
3. **Redis:** server có thể ghi cặp block report với TTL 300 giây khi Redis bật. Kiểm tra ghép cặp hiện dựa vào moderation trong tiến trình hiện tại; không cam kết Redis đồng bộ permanent block giữa các node.
4. `deviceId` là mã client lưu trong `sessionStorage`, không phải định danh đã xác thực. Block không thể bảo đảm ngăn ghép cặp nếu người dùng xóa dữ liệu phiên, mở phiên trình duyệt mới hoặc dữ liệu trong bộ nhớ server bị mất.

---

## 4. TIÊU CHUẨN, KỸ THUẬT & PHƯƠNG PHÁP THEO CVE VÀ HIỆP HỘI BẢO MẬT

Hệ thống được thiết kế tuân thủ nghiêm ngặt các hướng dẫn và khuyến nghị của các tổ chức bảo mật quốc tế: **OWASP** (Open Web Application Security Project), **NIST** (National Institute of Standards and Technology), **CWE** (Common Weakness Enumeration), và **IETF RFC**:

| Phân loại | Tiêu chuẩn / CVE liên quan | Kỹ thuật & Phương pháp đã hiện thực trong dự án |
| :--- | :--- | :--- |
| **Chống Cross-Site Hijacking** | **OWASP ASVS v4.0**<br>**CWE-1385** (Improper Origin Validation in WebSocket Handshake) | Server tích hợp hàm `verifyClient` trong `WebSocket.Server`. Kiểm tra trường `Origin` của HTTP Upgrade Handshake. Chỉ chấp nhận các origin hợp lệ trong danh sách trắng (`ALLOWED_ORIGINS`), từ chối mọi nỗ lực hijack từ website độc hại của bên thứ ba. |
| **Chống Tấn công XSS** | **OWASP Top 10: A03:2021** (Injection)<br>**CWE-79** (Improper Neutralization of Input During Web Page Generation) | **Phía Client:** Dữ liệu tin nhắn được render thuần túy qua thuộc tính `element.textContent`, loại trừ hoàn toàn việc dùng `innerHTML` không an toàn.<br>**Phía Server:** Giao thức `protocol.js` áp dụng bộ chuẩn hóa và giới hạn độ dài ký tự chặt chẽ, loại bỏ mã độc nhúng. |
| **Chống DoS & Kiệt quệ tài nguyên** | **CWE-400** (Uncontrolled Resource Consumption)<br>**CWE-770** (Allocation of Resources Without Limits or Throttling) | • Cấu hình `maxPayload: 4096 bytes` (4KB) chặn tấn công tràn bộ đệm qua WebSocket frame.<br>• Giới hạn số kết nối tối đa từ 1 địa chỉ IP (`MAX_CONNECTIONS_PER_IP = 10`) chống Socket Exhaustion.<br>• Token Bucket / Sliding Window Rate Limiter: Tối đa 5 tin nhắn / 3 giây. Vượt ngưỡng sẽ bị drop tin nhắn và cảnh báo. |
| **Chống lạm dụng thao tác** | **CWE-307** (Improper Restriction of Excessive Attempts) | • **Anti-Skip Cooldown:** Kẻ xấu dùng bot spam nút "Bỏ qua" liên tục (>5 lần/30s) để dò tìm người quen hoặc đối tượng quấy rối sẽ bị phạt đóng băng tìm kiếm 30 giây.<br>• **FIFO:** Ghép người vào trước khi đồng điểm hoặc sau timeout; đây là chính sách thứ tự, không phải biện pháp chống timing attack. |
| **Tiêu chuẩn Giao thức WebSocket** | **IETF RFC 6455** (The WebSocket Protocol) | • Heartbeat 2 chiều định kỳ (30s Ping từ Server, Pong từ Client). Tự động dọn dẹp các kết nối Zombie / Half-open socket.<br>• Đóng kết nối có mã trạng thái chuẩn RFC (`1008 Policy Violation`, `1000 Normal Closure`). |
| **Tiêu chuẩn Kiểm soát truy cập** | **NIST SP 800-53 Rev. 5** (AC-4 Information Flow Enforcement & SI-10 Input Validation) | Mọi tin nhắn đều phải qua bộ tiền kiểm tra trạng thái phòng (`RoomManager.isClientInRoom`), đảm bảo thông tin chỉ lưu chuyển giữa 2 người trong cùng phòng, không bao giờ rò rỉ sang phiên khác. |

---

## 4. CĂN CỨ PHÁP LÝ & DANH MỤC TỪ NGỮ BỊ CẤM

Để đảm bảo tính minh bạch, khách quan và tuân thủ luật pháp, danh mục từ cấm trong `backend/contentFilter.js` được xây dựng dựa trên **hệ thống văn bản quy phạm pháp luật Việt Nam** và **tiêu chuẩn cộng đồng quốc tế**.

### 4.1. Các văn bản pháp lý căn cứ:
1. **Luật An ninh mạng 2018 (Luật số 24/2018/QH14)**:
   - **Điều 8**: Các hành vi bị nghiêm cấm trên không gian mạng: Xúc phạm uy tín, danh dự, nhân phẩm của người khác; hoạt động cờ bạc, truyền bá ấn phẩm đồi trụy; xúi giục, lôi kéo người khác phạm tội.
   - **Điều 16**: Phòng ngừa, xử lý thông tin trên không gian mạng có nội dung xúc phạm nghiêm trọng danh dự, uy tín, nhân phẩm của người khác; thông tin bịa đặt, sai sự thật.
   - **Điều 18**: Phòng, chống hành vi sử dụng không gian mạng để buôn bán hàng cấm, vũ khí, chất ma túy, chất kích thích.
2. **Nghị định 15/2020/NĐ-CP (được sửa đổi bởi Nghị định 14/2022/NĐ-CP)**:
   - **Điều 101**: Quy định xử phạt vi phạm hành chính đối với hành vi lợi dụng mạng xã hội để cung cấp, chia sẻ thông tin miệt thị, vu khống, xúc phạm uy tín của cơ quan, tổ chức, danh dự, nhân phẩm của cá nhân; thông tin miêu tả tỉ mỉ hành vi khiêu dâm, bạo lực, cờ bạc.
3. **Bộ luật Hình sự 2015 (sửa đổi, bổ sung 2017)**:
   - **Điều 155**: Tội làm nhục người khác.
   - **Điều 156**: Tội vu khống.
   - **Điều 249, 251**: Tội tàng trữ, mua bán trái phép chất ma túy.
   - **Điều 321, 322**: Tội đánh bạc, tổ chức đánh bạc trái phép.
4. **Tiêu chuẩn cộng đồng quốc tế (Meta / Discord Community Guidelines)**:
   - Nghiêm cấm hành vi quấy rối (Harassment), gạ gẫm tình dục trái phép (Unsolicited Sexual Solicitation), ngôn từ kích động thù địch và phân biệt vùng miền (Hate Speech).

---

### 4.2. Bảng phân loại 6 nhóm hành vi và từ ngữ bị cấm trong hệ thống:

| Nhóm vi phạm | Căn cứ pháp lý | Các từ ngữ & mẫu hành vi bị cấm | Chế tài xử lý của hệ thống |
| :--- | :--- | :--- | :--- |
| **1. Ma túy & Chất kích thích cấm** (`DRUGS_NARCOTICS`) | • Điều 18 Luật An ninh mạng 2018<br>• Điều 249, 251 Bộ luật Hình sự | Cần sa, cỏ mỹ, ke, kẹo, lắc, đập đá, ma túy, thuốc lắc, hút bồ đà, ngáo đá, pod chill, bóng cười, n2o... | **Kick khỏi phòng ngay lập tức**, ban IP & thiết bị 10 phút và tạo block cặp thiết bị/IP trong bộ nhớ tiến trình. |
| **2. Xúc phạm danh dự & Kỳ thị vùng miền** (`INSULT_HATE`) | • Điều 8, 16 Luật An ninh mạng 2018<br>• Điều 155 Bộ luật Hình sự<br>• Điều 101 Nghị định 15/2020 | Bắc kỳ chó, nam kỳ chó, mọi rợ, súc vật, óc chó, đồ ăn hại, khuyết tật não, hạ đẳng, bại não... | **Kick khỏi phòng ngay lập tức**, ban IP & thiết bị 10 phút và tạo block cặp thiết bị/IP trong bộ nhớ tiến trình. |
| **3. Cờ bạc trái phép & Lừa đảo** (`GAMBLING_FRAUD`) | • Điều 8 Luật An ninh mạng 2018<br>• Điều 321, 322 Bộ luật Hình sự | Tài xỉu, ku casino, thabet, go88, sunwin, lô đề, cá độ bóng đá, nạp rút thẻ cào lừa đảo, chuyển khoản nhận thưởng... | **Kick khỏi phòng ngay lập tức**, ban IP & thiết bị 10 phút và tạo block cặp thiết bị/IP trong bộ nhớ tiến trình. |
| **4. Bạo lực & Đe dọa tính mạng** (`VIOLENCE_THREAT`) | • Điều 8 Luật An ninh mạng 2018<br>• Điều 133 Bộ luật Hình sự | Chém chết mày, giết cả nhà mày, đâm chết, cho ăn kẹo đồng, khử mày, đánh gãy chân... | **Kick khỏi phòng ngay lập tức**, ban IP & thiết bị 10 phút và tạo block cặp thiết bị/IP trong bộ nhớ tiến trình. |
| **5. Quấy rối tình dục & Khiêu dâm** (`SEXUAL_HARASSMENT`) | • Điều 8 Luật An ninh mạng 2018<br>• Điều 101 Nghị định 15/2020 | Chat sex, show hàng, show cam, lộ vú, xem bím, bú cu, liếm lồn, bán dâm, mua dâm, gạ tình... | **Kick khỏi phòng ngay lập tức**, ban IP & thiết bị 10 phút và tạo block cặp thiết bị/IP trong bộ nhớ tiến trình. |
| **6. Ngôn từ thô tục, khiếm nhã** (`PROFANITY`) | • Quy tắc ứng xử mạng xã hội (QĐ 874/QĐ-BTTTT) | Địt mẹ, đụ má, đĩ mẹ, cặc, lồn, buồi, dcm, vcl, dkm... | **Kick khỏi phòng ngay lập tức**, ban IP & thiết bị 10 phút và tạo block cặp thiết bị/IP trong bộ nhớ tiến trình. |

---

### 4.3. Thuật toán chống lách luật (De-obfuscation Engine):

Kẻ xấu thường cố tình viết chèn ký tự phân tách hoặc ký hiệu đặc biệt để qua mặt các bộ lọc từ thông thường. Hệ thống trang bị **2 giai đoạn kiểm duyệt song song**:

1. **Giai đoạn 1 (Regex Boundaries)**: Quét các cụm từ theo ranh giới từ nguyên mẫu và các biến thể leetspeak (viết tắt bằng số, ký tự đặc biệt).
2. **Giai đoạn 2 (De-obfuscation Normalization)**:
   - Loại bỏ toàn bộ các ký tự xen kẽ: dấu chấm (`.`), gạch ngang (`-`), gạch dưới (`_`), dấu hoa thị (`*`), dấu `@`, dấu `$`, khoảng trắng (` `).
   - Ví dụ:
     - `đ . ị . t   m . ẹ` $\rightarrow$ Chuyển thành `địtmẹ` $\rightarrow$ **Bắt trúng 100%**.
     - `c . ầ . n   s . a` $\rightarrow$ Chuyển thành `cầnsa` $\rightarrow$ **Bắt trúng 100%**.
     - `p - o - d   c * h * i * l * l` $\rightarrow$ Chuyển thành `podchill` $\rightarrow$ **Bắt trúng 100%**.
     - `t à i   x ỉ u` $\rightarrow$ Chuyển thành `tàixỉu` $\rightarrow$ **Bắt trúng 100%**.

---

## 5. TỔNG KẾT KIỂM THỬ AN TOÀN (TEST VERIFICATION)

Hệ thống có các kịch bản kiểm thử tự động trong `tests/unit-test.js`, bao gồm:

- [x] **Test Section 1**: Chuẩn hóa & xác thực gói tin giao thức `protocol.js`.
- [x] **Test Section 2**: Hạn chế tần suất tin nhắn (Rate Limit - Token Bucket).
- [x] **Test Section 3**: Quản lý phòng chat và giải phóng kết nối cô lập (`roomManager.js`).
- [x] **Test Section 4**: Bộ ghép cặp tôn trọng danh sách đen `isBlocked`.
- [x] **Test Section 5**: Bộ lọc 6 nhóm từ cấm (Chất ma túy, Kỳ thị vùng miền, Cờ bạc, Đe dọa bạo lực, Tình dục khiêu dâm, Tục tĩu) và cơ chế de-obfuscation lách ký tự.
- [x] **Test Section 6**: Thư viện câu hỏi phá băng mở đầu văn minh (`icebreakers.js`).
- [x] **Test Section 7**: Xử phạt cấm kết nối tạm thời theo IP + Client ID và Anti-Skip Cooldown.
- [x] **Test Section 8**: Trạng thái Minigame Caro 3x3 đồng bộ an toàn.
- [x] **Test Section 9**: Thuật toán ưu tiên tâm trạng (Mood Matching Bonus).
- [x] **Test Report Block:** Báo cáo tạo block hai chiều 5 phút theo `deviceId`, còn hiệu lực qua reconnect và tự hết hạn.
- [x] **Test FIFO:** Đồng điểm và ghép nới lỏng sau timeout đều giữ thứ tự hàng đợi.
- [x] **Test Section 10**: Chặn cặp thiết bị/IP khi gọi trực tiếp `addPermanentBlock()` cho nội dung bị bộ lọc từ chối; trạng thái này ở bộ nhớ tiến trình, không phải block report.
