/**
 * protocol.js – Định nghĩa và kiểm tra giao thức thông điệp (Message Protocol)
 *
 * Mọi message giữa Client ↔ Server đều là JSON có dạng:
 *   { "type": "...", "payload": { ... } }
 *
 * Module này:
 *   1. Liệt kê tất cả message type hợp lệ.
 *   2. Validate dữ liệu đầu vào từ Client.
 *   3. Cung cấp hàm tiện ích tạo message Server → Client.
 */

'use strict';

// ─── Hằng số ────────────────────────────────────────────────────────────────

/** Độ dài tối đa biệt danh */
const MAX_NICKNAME_LENGTH = 30;

/** Độ dài tối đa mỗi sở thích */
const MAX_INTEREST_LENGTH = 30;

/** Số sở thích tối đa */
const MAX_INTERESTS_COUNT = 5;

/** Độ dài tối đa tin nhắn */
const MAX_MESSAGE_LENGTH = 500;

/** Độ dài tối đa lý do báo cáo */
const MAX_REPORT_REASON_LENGTH = 200;

/** Danh sách tâm trạng hợp lệ */
const VALID_MOODS = Object.freeze([
  'vui_ve',       // ☀️ Vui vẻ, tích cực
  'tam_su',       // 🌙 Muốn tâm sự, giãi bày
  'chan_nan',     // 🌧️ Chán nản, cần người lắng nghe
  'tim_ban_game', // 🎮 Tìm đồng đội chơi game
  'hoc_tap',      // 📚 Cùng học tập, làm việc
  'ngau_nhien',   // ☕ Tùy duyên, ngẫu nhiên
]);

// ─── Danh sách message type ────────────────────────────────────────────────

/** Message type Client → Server */
const CLIENT_TYPES = Object.freeze({
  JOIN:        'join',        // Đăng ký biệt danh + sở thích + tâm trạng
  FIND_MATCH:  'find_match',  // Vào hàng đợi ghép cặp
  START_SOLO:  'start_solo',  // Bắt đầu trò chuyện/chơi game cùng Bạn Đồng Hành Lumi (Solo)
  CANCEL:      'cancel',      // Rời hàng đợi
  MESSAGE:     'message',     // Gửi tin nhắn
  ATTACHMENT_REQUEST: 'attachment_request', // Yêu cầu cấp phép tải tệp lên
  ATTACHMENT_SEND: 'attachment_send', // Chia sẻ tệp đã tải lên với đối phương
  TYPING:      'typing',      // Báo đang nhập / ngừng nhập
  SKIP:        'skip',        // Bỏ qua người hiện tại
  REPORT:      'report',      // Báo cáo đối phương
  ICEBREAKER:  'icebreaker',  // Yêu cầu câu hỏi phá băng mở đầu
  GAME_INVITE: 'game_invite', // Mời chơi minigame 1-1
  GAME_ACCEPT: 'game_accept', // Chấp nhận lời mời chơi game
  GAME_MOVE:   'game_move',   // Đánh nước cờ { index: 0..8 }
  GAME_RESET:  'game_reset',  // Chơi lại ván mới
  GAME_QUIT:   'game_quit',   // Đóng bàn cờ
});

/** Message type Server → Client */
const SERVER_TYPES = Object.freeze({
  CONNECTED:    'connected',     // Xác nhận kết nối
  WAITING:      'waiting',       // Đang trong hàng đợi
  SOLO_HINT:    'solo_hint',     // Gợi ý tâm sự/chơi game cùng Lumi khi chờ lâu
  MATCH_FOUND:  'match_found',   // Ghép cặp thành công
  MESSAGE:      'message',       // Tin nhắn từ đối phương
  ATTACHMENT_UPLOAD: 'attachment_upload', // Ticket tạm thời để tải tệp lên
  ATTACHMENT:   'attachment',    // Tệp được chia sẻ trong phòng chat
  ATTACHMENT_SENT: 'attachment_sent', // Xác nhận đã chia sẻ tệp
  LINK_WARNING: 'link_warning',  // Cảnh báo an toàn liên kết gửi cho người gửi
  TYPING:       'typing',        // Đối phương đang nhập
  PARTNER_LEFT: 'partner_left',  // Đối phương rời phòng
  ONLINE_COUNT: 'online_count',  // Số người online
  ERROR:        'error',         // Lỗi
  REPORTED:     'reported',      // Xác nhận đã report
  ICEBREAKER:   'icebreaker',    // Câu hỏi phá băng được kích hoạt
  GAME_STATE:   'game_state',    // Đồng bộ trạng thái minigame
  KICKED:       'kicked',        // Bị buộc rời phòng & khóa tạm do vi phạm
});

/** Mã lỗi */
const ERROR_CODES = Object.freeze({
  INVALID_FORMAT:   'INVALID_FORMAT',    // JSON sai định dạng
  INVALID_TYPE:     'INVALID_TYPE',      // type không hợp lệ
  INVALID_PAYLOAD:  'INVALID_PAYLOAD',   // payload không hợp lệ
  RATE_LIMITED:     'RATE_LIMITED',       // Gửi quá nhanh
  NOT_IN_ROOM:      'NOT_IN_ROOM',       // Chưa ở trong phòng chat
  NOT_JOINED:       'NOT_JOINED',        // Chưa đăng ký biệt danh
  ALREADY_WAITING:  'ALREADY_WAITING',   // Đã trong hàng đợi
  ALREADY_CHATTING: 'ALREADY_CHATTING',  // Đang chat rồi
  KICKED_PROFANITY: 'KICKED_PROFANITY',  // Bị kick do nói tục/khiếm nhã
  SKIP_COOLDOWN:    'SKIP_COOLDOWN',     // Spam skip quá nhanh
  BANNED:           'BANNED',            // Đang trong thời gian phạt cấm chat
});

// ─── Hàm escape HTML (chống XSS) ──────────────────────────────────────────

/**
 * Escape các ký tự đặc biệt HTML để chống XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Parse & Validate ──────────────────────────────────────────────────────

/**
 * Parse một raw string thành message object.
 * @param {string} raw - Chuỗi JSON nhận từ WebSocket
 * @returns {{ ok: boolean, msg?: object, error?: string }}
 */
function parseMessage(raw) {
  // Kiểm tra kiểu dữ liệu
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Message phải là chuỗi văn bản' };
  }

  // Giới hạn kích thước thô (tránh JSON parse khối dữ liệu quá lớn)
  if (raw.length > 2048) {
    return { ok: false, error: 'Message quá dài' };
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'JSON không hợp lệ' };
  }

  // Phải là object có trường "type"
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'Thiếu trường "type"' };
  }

  // Kiểm tra type có nằm trong danh sách hợp lệ
  const validTypes = Object.values(CLIENT_TYPES);
  if (!validTypes.includes(msg.type)) {
    return { ok: false, error: `Type "${msg.type}" không hợp lệ` };
  }

  // Đảm bảo payload là object (nếu có)
  if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null)) {
    return { ok: false, error: 'Payload phải là object' };
  }

  // Mặc định payload là {}
  if (!msg.payload) msg.payload = {};

  return { ok: true, msg };
}

/**
 * Validate payload theo từng message type.
 * @param {string} type
 * @param {object} payload
 * @returns {{ ok: boolean, error?: string, sanitized?: object }}
 */
function validatePayload(type, payload) {
  switch (type) {
    // ── join ──────────────────────────────────────────────
    case CLIENT_TYPES.JOIN: {
      // nickname bắt buộc
      if (typeof payload.nickname !== 'string' || payload.nickname.trim().length === 0) {
        return { ok: false, error: 'Biệt danh không được để trống' };
      }
      const nickname = payload.nickname.trim();
      if (nickname.length > MAX_NICKNAME_LENGTH) {
        return { ok: false, error: `Biệt danh tối đa ${MAX_NICKNAME_LENGTH} ký tự` };
      }

      // interests (tùy chọn)
      let interests = [];
      if (payload.interests !== undefined) {
        if (!Array.isArray(payload.interests)) {
          return { ok: false, error: 'interests phải là mảng' };
        }
        if (payload.interests.length > MAX_INTERESTS_COUNT) {
          return { ok: false, error: `Tối đa ${MAX_INTERESTS_COUNT} sở thích` };
        }
        for (const item of payload.interests) {
          if (typeof item !== 'string') {
            return { ok: false, error: 'Mỗi sở thích phải là chuỗi' };
          }
          const trimmed = item.trim().toLowerCase();
          if (trimmed.length === 0) continue;
          if (trimmed.length > MAX_INTEREST_LENGTH) {
            return { ok: false, error: `Mỗi sở thích tối đa ${MAX_INTEREST_LENGTH} ký tự` };
          }
          interests.push(trimmed);
        }
        // Loại bỏ trùng lặp
        interests = [...new Set(interests)];
      }

      // mood (tùy chọn, mặc định ngau_nhien)
      let mood = 'ngau_nhien';
      if (typeof payload.mood === 'string' && VALID_MOODS.includes(payload.mood.trim().toLowerCase())) {
        mood = payload.mood.trim().toLowerCase();
      }

      // deviceId (tùy chọn: định danh thiết bị lâu dài để chống ghép lại với kẻ xấu)
      let deviceId = null;
      if (typeof payload.deviceId === 'string' && payload.deviceId.trim().length > 0) {
        deviceId = payload.deviceId.trim().substring(0, 64);
      }

      return {
        ok: true,
        sanitized: {
          nickname,
          interests,
          mood,
          deviceId,
        },
      };
    }

    // ── message ──────────────────────────────────────────
    case CLIENT_TYPES.MESSAGE: {
      if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
        return { ok: false, error: 'Nội dung tin nhắn không được trống' };
      }
      const text = payload.text.trim();
      if (text.length > MAX_MESSAGE_LENGTH) {
        return { ok: false, error: `Tin nhắn tối đa ${MAX_MESSAGE_LENGTH} ký tự` };
      }
      return {
        ok: true,
        sanitized: { text },
      };
    }

    case CLIENT_TYPES.ATTACHMENT_REQUEST: {
      if (typeof payload.fileName !== 'string' || payload.fileName.length > 255) {
        return { ok: false, error: 'Tên tệp không hợp lệ' };
      }
      if (!Number.isSafeInteger(payload.size) || payload.size <= 0 || payload.size > 50 * 1024 * 1024) {
        return { ok: false, error: 'Kích thước tệp không hợp lệ hoặc vượt quá 50 MB' };
      }
      return { ok: true, sanitized: { fileName: payload.fileName, size: payload.size } };
    }

    case CLIENT_TYPES.ATTACHMENT_SEND: {
      if (typeof payload.ticket !== 'string' || payload.ticket.length === 0 || payload.ticket.length > 4096) {
        return { ok: false, error: 'Mã tải tệp không hợp lệ' };
      }
      return { ok: true, sanitized: { ticket: payload.ticket } };
    }

    // ── typing ───────────────────────────────────────────
    case CLIENT_TYPES.TYPING: {
      if (typeof payload.isTyping !== 'boolean') {
        return { ok: false, error: 'isTyping phải là boolean' };
      }
      return { ok: true, sanitized: { isTyping: payload.isTyping } };
    }

    // ── report ───────────────────────────────────────────
    case CLIENT_TYPES.REPORT: {
      if (typeof payload.reason !== 'string' || payload.reason.trim().length === 0) {
        return { ok: false, error: 'Lý do báo cáo không được trống' };
      }
      const reason = payload.reason.trim();
      if (reason.length > MAX_REPORT_REASON_LENGTH) {
        return { ok: false, error: `Lý do tối đa ${MAX_REPORT_REASON_LENGTH} ký tự` };
      }
      return {
        ok: true,
        sanitized: { reason: escapeHtml(reason) },
      };
    }

    // ── game_move ────────────────────────────────────────
    case CLIENT_TYPES.GAME_MOVE: {
      if (typeof payload.index !== 'number' || !Number.isInteger(payload.index) || payload.index < 0 || payload.index >= 100) {
        return { ok: false, error: 'Ô đánh không hợp lệ (phải từ 0 đến 99)' };
      }
      return { ok: true, sanitized: { index: payload.index } };
    }

    // ── find_match, start_solo, cancel, skip, icebreaker, game_invite, game_accept, game_reset, game_quit
    case CLIENT_TYPES.FIND_MATCH:
    case CLIENT_TYPES.START_SOLO:
    case CLIENT_TYPES.CANCEL:
    case CLIENT_TYPES.SKIP:
    case CLIENT_TYPES.ICEBREAKER:
    case CLIENT_TYPES.GAME_INVITE:
    case CLIENT_TYPES.GAME_ACCEPT:
    case CLIENT_TYPES.GAME_RESET:
    case CLIENT_TYPES.GAME_QUIT:
      return { ok: true, sanitized: {} };

    default:
      return { ok: false, error: 'Type không xác định' };
  }
}

// ─── Tạo message Server → Client ──────────────────────────────────────────

/**
 * Tạo JSON string để gửi cho Client.
 * @param {string} type - Server message type
 * @param {object} [payload={}]
 * @returns {string}
 */
function createMessage(type, payload = {}) {
  return JSON.stringify({ type, payload });
}

// ─── Các hàm tiện ích tạo message cụ thể ──────────────────────────────────

const serverMsg = {
  connected(clientId, onlineCount) {
    return createMessage(SERVER_TYPES.CONNECTED, { clientId, onlineCount });
  },

  waiting() {
    return createMessage(SERVER_TYPES.WAITING);
  },

  soloHint(waitSeconds = 10, message = 'Bạn có muốn trò chuyện tâm sự hoặc chơi cờ Caro giải trí cùng Trợ lý Lumi không?') {
    return createMessage(SERVER_TYPES.SOLO_HINT, { waitSeconds, message });
  },

  matchFound(partnerNickname, commonInterests, partnerMood = 'ngau_nhien', isBot = false) {
    return createMessage(SERVER_TYPES.MATCH_FOUND, { partnerNickname, commonInterests, partnerMood, isBot });
  },

  message(text, timestamp, linkSafety = null) {
    return createMessage(SERVER_TYPES.MESSAGE, { text, timestamp, linkSafety });
  },

  attachmentUpload(uploadTicket) {
    return createMessage(SERVER_TYPES.ATTACHMENT_UPLOAD, uploadTicket);
  },

  attachment(attachment, timestamp) {
    return createMessage(SERVER_TYPES.ATTACHMENT, { attachment, timestamp });
  },

  attachmentSent(attachment, timestamp) {
    return createMessage(SERVER_TYPES.ATTACHMENT_SENT, { attachment, timestamp });
  },

  linkWarning(linkSafety) {
    return createMessage(SERVER_TYPES.LINK_WARNING, linkSafety);
  },

  typing(isTyping) {
    return createMessage(SERVER_TYPES.TYPING, { isTyping });
  },

  partnerLeft(reason = null) {
    return createMessage(SERVER_TYPES.PARTNER_LEFT, { reason });
  },

  onlineCount(count) {
    return createMessage(SERVER_TYPES.ONLINE_COUNT, { count });
  },

  error(code, message) {
    return createMessage(SERVER_TYPES.ERROR, { code, message });
  },

  reported() {
    return createMessage(SERVER_TYPES.REPORTED);
  },

  icebreaker(question, category) {
    return createMessage(SERVER_TYPES.ICEBREAKER, { question, category });
  },

  gameState(state) {
    return createMessage(SERVER_TYPES.GAME_STATE, state);
  },

  kicked(reason, banExpiresAt = null) {
    return createMessage(SERVER_TYPES.KICKED, { reason, banExpiresAt });
  },
};

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  CLIENT_TYPES,
  SERVER_TYPES,
  ERROR_CODES,
  VALID_MOODS,
  MAX_NICKNAME_LENGTH,
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS_COUNT,
  MAX_MESSAGE_LENGTH,
  MAX_REPORT_REASON_LENGTH,
  parseMessage,
  validatePayload,
  createMessage,
  serverMsg,
  escapeHtml,
};
