---
name: ui-ux-pro-max
description: >-
  Expert UI/UX design intelligence pack for modern web styling, micro-interactions,
  color systems, layout architecture, and accessibility. Use this skill whenever the
  user wants to improve, redesign, restyle, or audit the UI/UX of frontend components,
  themes, modals, animations, or responsive layouts.
---

# UI/UX Pro Max – Web Design Intelligence & Guidelines

Tài liệu hướng dẫn tiêu chuẩn UI/UX hiện đại chuyên biệt cho các ứng dụng Web thời gian thực (Real-time Web Apps, Chat, Minigames).
Đặc biệt tối ưu cho ngăn xếp: **HTML5 + Modern CSS (Custom Properties, Flexbox, Grid) + Vanilla JS**.

---

## 1. Nguyên Tắc Thiết Kế Cốt Lõi (Core Principles)

1. **Hiển thị có phân cấp (Visual Hierarchy)**
   - Mỗi màn hình / modal chỉ có duy nhất **1 nút hành động chính (Primary CTA)** có màu nhấn (Accent/Primary).
   - Các hành động phụ (Secondary/Tertiary) dùng `ghost`, `outline` hoặc màu nền trung tính (Neutral).
   - Tương phản kích thước font chữ: Tiêu đề (1.25rem - 1.5rem, weight 600-700), văn bản chính (0.95rem - 1rem), chú thích phụ (0.75rem - 0.85rem).

2. **Khả năng tiếp cận & Ergonomics (Accessibility - WCAG AA)**
   - Độ tương phản chữ/nền tối thiểu **4.5:1** cho văn bản thông thường và **3:1** cho văn bản lớn.
   - Vùng cảm ứng tối thiểu (Touch target size): **44x44px** trên điện thoại (mobile).
   - Luôn có trạng thái `:focus-visible` với outline rõ ràng cho người dùng điều hướng bằng bàn phím.

3. **Tính phản hồi trong thời gian thực (Real-time Feedback & Micro-interactions)**
   - Mọi tương tác click/gửi tin nhắn phải có phản hồi tức thì (< 100ms): hiệu ứng `:active` (`transform: scale(0.98)`).
   - Trạng thái chờ (Loading / Waiting): Sử dụng Skeleton screens, Spinner mượt mà, hoặc thanh tiến trình nhịp điệu (Pulsing).
   - Trạng thái kết nối (Socket): Hiển thị chấm trạng thái màu xanh/cam/đỏ kèm tooltip rõ ràng.

---

## 2. Hệ Thống Màu Sắc & Giao Diện (Theme System)

Dự án áp dụng CSS Variables để hỗ trợ cả **Dark Mode (mặc định)** và **Light Mode**:

### Dark Mode (Hiện đại, giảm mỏi mắt khi chat ban đêm)
- **Background Base:** `#0f172a` (Slate 900) hoặc `#0b0f19` (Deep Obsidian).
- **Surface / Card:** `#1e293b` (Slate 800) với viền mỏng `1px solid rgba(255, 255, 255, 0.08)`.
- **Primary / Brand:** `#6366f1` (Indigo 500) hoặc `#8b5cf6` (Purple 500) tạo cảm giác công nghệ cao.
- **Success (Online/Win):** `#10b981` (Emerald 500).
- **Warning (Waiting/Alert):** `#f59e0b` (Amber 500).
- **Danger (Report/Skip/Error):** `#ef4444` (Rose 500).
- **Text Main:** `#f8fafc` (Slate 50), **Text Muted:** `#94a3b8` (Slate 400).

---

## 3. Quy Chuẩn Thành Phần Giao Diện Ứng Dụng Chat & Minigame

### 3.1. Bong bóng Chat (Message Bubbles)
- **Tin nhắn gửi đi (Self):** Màu Primary Gradient (`linear-gradient(135deg, #6366f1, #8b5cf6)`), chữ trắng, bo tròn góc `16px 16px 4px 16px`.
- **Tin nhắn nhận về (Partner):** Nền Card tối (`#1e293b`), chữ sáng, bo tròn góc `16px 16px 16px 4px`.
- **Tin nhắn hệ thống (System Notification):** Nền bán trong suốt (`rgba(148, 163, 184, 0.1)`), chữ nhỏ, căn giữa, icon nhận diện.
- **Trạng thái gõ (Typing Indicator):** 3 chấm tròn nhấp nhô mượt mà (Wave animation), chiều cao gọn gàng.

### 3.2. Minigame Bàn Cờ Caro (Giao diện trực quan)
- Ô cờ kích thước tối thiểu **28px - 36px**, đường kẻ ô mảnh (`1px solid rgba(255, 255, 255, 0.06)`).
- Nước đi mới nhất phải có **vòng hào quang (Pulse highlight)** hoặc màu viền nổi bật để người chơi nhận biết ngay.
- Ký tự `X` (Màu đỏ/cam san hô) và `O` (Màu xanh dương/neon) với độ tương phản cao, nét đậm rõ ràng.
- Hàng 5 quân chiến thắng: Hiệu ứng đường kẻ nối (Winning line) hoặc nhấp nháy sáng (Glow effect).

### 3.3. Trạng Thái Tìm Người (Matchmaking Lobby)
- Hiển thị hoạt ảnh radar xoay tròn hoặc sóng lan tỏa (Ripple waves).
- Trích xuất mẹo hay (Tips) và câu hỏi phá băng thay đổi tuần tự (Smooth cross-fade transition) để người dùng không cảm thấy sốt ruột.

---

## 4. Danh Sách Kiểm Tra Khi Tối Ưu Code (UI/UX Checklist)

Khi chỉnh sửa bất kỳ phần HTML/CSS nào trong `frontend/`:
- [ ] Không làm tràn màn hình ngang trên điện thoại (Mobile viewport: `overflow-x: hidden`).
- [ ] Các thanh cuộn (Scrollbar) được bo góc và làm mỏng (Custom slim scrollbar).
- [ ] Đã thêm `transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1)` cho các nút bấm và trạng thái hover.
- [ ] Các lớp phủ (Modals / Overlays) có nền mờ kiểu kính (`backdrop-filter: blur(8px)`).
- [ ] Bàn phím ảo trên điện thoại không che mất ô nhập chat (`input-container` dính đáy màn hình - sticky bottom).

