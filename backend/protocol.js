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

const {
  stripDangerousUnicode,
  isAllowedMemeUrl,
  isValidVoiceUrl,
} = require('./security');

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

/** Độ dài tối đa chủ đề / tên nhóm */
const MAX_GROUP_TOPIC_LENGTH = 60;
const MAX_GROUP_NAME_LENGTH = 60;
const MAX_SAVED_GROUP_PASSES = 20;

/** Danh sách chế độ tìm nhóm hợp lệ */
const VALID_GROUP_MODES = Object.freeze(['topic', 'random']);

/** Danh sách trò chơi nhiều người trong phòng game */
const VALID_MULTIPLAYER_GAMES = Object.freeze([
  'quiz_race',
  'word_chain',
  'undercover',
  'mind_duel',
  'caro_arena',
]);

/** Độ dài tối đa tên phòng game */
const MAX_GAME_ROOM_NAME_LENGTH = 50;

/** Danh sách avatar mặc định hợp lệ (hoặc emoji ngắn) */
const MAX_AVATAR_LENGTH = 8;

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
  JOIN: 'join',        // Đăng ký biệt danh + sở thích + tâm trạng
  FIND_MATCH: 'find_match',  // Vào hàng đợi ghép cặp
  START_SOLO: 'start_solo',  // Bắt đầu trò chuyện/chơi game cùng Bạn Đồng Hành Lumi (Solo)
  CANCEL: 'cancel',      // Rời hàng đợi
  MESSAGE: 'message',     // Gửi tin nhắn
  ATTACHMENT_REQUEST: 'attachment_request', // Yêu cầu cấp phép tải tệp lên
  ATTACHMENT_SEND: 'attachment_send', // Chia sẻ tệp đã tải lên với đối phương
  TYPING: 'typing',      // Báo đang nhập / ngừng nhập
  SKIP: 'skip',        // Bỏ qua người hiện tại
  REPORT: 'report',      // Báo cáo đối phương
  ICEBREAKER: 'icebreaker',  // Yêu cầu câu hỏi phá băng mở đầu
  GAME_INVITE: 'game_invite', // Mời chơi minigame 1-1
  GAME_ACCEPT: 'game_accept', // Chấp nhận lời mời chơi game
  GAME_MOVE: 'game_move',   // Đánh nước cờ { index: 0..399 }
  GAME_RESET: 'game_reset',  // Chơi lại ván mới
  GAME_QUIT: 'game_quit',   // Đóng bàn cờ
  LEAVE_ROOM: 'leave_room', // rời phòng
  VOICE: 'voice',           // G?i tin nh?n tho?i { voiceId, duration, url }
  MEME: 'meme',             // G?i meme sticker { memeId, url, title }
  RESUME_SESSION: 'resume_session',
  // ── Trò chuyện nhóm ẩn danh ─────────────────────────────
  GROUP_FIND: 'group_find',             // Tìm/ghép nhóm theo chủ đề, sở thích hoặc ngẫu nhiên
  GROUP_CREATE: 'group_create',         // Tạo phòng nhóm mới
  GROUP_JOIN: 'group_join',             // Vào nhóm công khai theo groupId
  GROUP_REJOIN: 'group_rejoin',         // Quay lại nhóm đã giữ bằng rejoinToken
  GROUP_LEAVE: 'group_leave',           // Rời nhóm
  GROUP_VOTE_KEEP: 'group_vote_keep',   // Chọn / bỏ chọn giữ lại nhóm (cần >= 3 người)
  GROUP_UNKEEP: 'group_unkeep',         // Bỏ giữ nhóm từ danh sách đã lưu
  GROUP_LIST: 'group_list',             // Lấy danh sách nhóm đang mở
  GROUP_SYNC_SAVED: 'group_sync_saved', // Đồng bộ trạng thái các nhóm đã lưu
  GROUP_REPORT: 'group_report',         // Báo cáo một thành viên trong nhóm
  // ── Phòng game nhiều người ẩn danh (2–10 người) ─────────
  GAME_ROOM_FIND: 'game_room_find',
  GAME_ROOM_CREATE: 'game_room_create',
  GAME_ROOM_JOIN: 'game_room_join',
  GAME_ROOM_LEAVE: 'game_room_leave',
  GAME_ROOM_LIST: 'game_room_list',
  GAME_ROOM_SELECT_GAME: 'game_room_select_game',
  GAME_ROOM_START: 'game_room_start',
  GAME_ROOM_ACTION: 'game_room_action',
  GAME_ROOM_REPORT: 'game_room_report',
  // ── Minigame nhúng ngay trong Chat 1-1 / Lumi AI / Nhóm chat ──
  CHAT_GAME_OPEN: 'chat_game_open',
  CHAT_GAME_JOIN: 'chat_game_join',
  CHAT_GAME_LEAVE: 'chat_game_leave',
  CHAT_GAME_SELECT: 'chat_game_select',
  CHAT_GAME_START: 'chat_game_start',
  CHAT_GAME_ACTION: 'chat_game_action',
  CHAT_GAME_CLOSE: 'chat_game_close',
  // ── Giữ kết nối ẩn danh 2 chiều & Mã hẹn gặp lại (1-1) ──
  PAIR_VOTE_KEEP: 'pair_vote_keep',
  PAIR_SYNC: 'pair_sync',
  PAIR_RECONNECT: 'pair_reconnect',
  PAIR_JOIN_CODE: 'pair_join_code',
  PAIR_INVITE_RESPOND: 'pair_invite_respond',
  PAIR_CANCEL_WAIT: 'pair_cancel_wait',
  PAIR_REMOVE: 'pair_remove',
});

/** Message type Server → Client */
const SERVER_TYPES = Object.freeze({
  CONNECTED: 'connected',     // Xác nhận kết nối
  WAITING: 'waiting',       // Đang trong hàng đợi
  SOLO_HINT: 'solo_hint',     // Gợi ý tâm sự/chơi game cùng Lumi khi chờ lâu
  MATCH_FOUND: 'match_found',   // Ghép cặp thành công
  MESSAGE: 'message',       // Tin nhắn từ đối phương
  VOICE: 'voice',           // G?i tin nh?n tho?i { voiceId, duration, url }
  MEME: 'meme',             // G?i meme sticker { memeId, url, title }
  ATTACHMENT_UPLOAD: 'attachment_upload', // Ticket tạm thời để tải tệp lên
  ATTACHMENT: 'attachment',    // Tệp được chia sẻ trong phòng chat
  ATTACHMENT_SENT: 'attachment_sent', // Xác nhận đã chia sẻ tệp
  LINK_WARNING: 'link_warning',  // Cảnh báo an toàn liên kết gửi cho người gửi
  TYPING: 'typing',        // Đối phương đang nhập
  PARTNER_LEFT: 'partner_left',  // Đối phương rời phòng
  ONLINE_COUNT: 'online_count',  // Số người online
  ERROR: 'error',         // Lỗi
  REPORTED: 'reported',      // Xác nhận đã report
  ICEBREAKER: 'icebreaker',    // Câu hỏi phá băng được kích hoạt
  GAME_STATE: 'game_state',    // Đồng bộ trạng thái minigame
  KICKED: 'kicked',        // Bị buộc rời phòng & khóa tạm do vi phạm
  // ── Trò chuyện nhóm ẩn danh ─────────────────────────────
  GROUP_JOINED: 'group_joined',
  GROUP_LEFT: 'group_left',
  GROUP_LIST: 'group_list',
  GROUP_SAVED_LIST: 'group_saved_list',
  GROUP_MEMBER_JOINED: 'group_member_joined',
  GROUP_MEMBER_LEFT: 'group_member_left',
  GROUP_MEMBERS_RENAMED: 'group_members_renamed',
  GROUP_KEEP_UPDATED: 'group_keep_updated',
  GROUP_KEEP_PASS: 'group_keep_pass',
  GROUP_UNKEPT: 'group_unkept',
  GROUP_MESSAGE: 'group_message',
  GROUP_VOICE: 'group_voice',
  GROUP_MEME: 'group_meme',
  GROUP_TYPING: 'group_typing',
  GROUP_ICEBREAKER: 'group_icebreaker',
  GROUP_SYSTEM: 'group_system',
  // ── Phòng game nhiều người ẩn danh (2–10 người) ─────────
  GAME_ROOM_JOINED: 'game_room_joined',
  GAME_ROOM_LEFT: 'game_room_left',
  GAME_ROOM_LIST: 'game_room_list',
  GAME_ROOM_PLAYER_JOINED: 'game_room_player_joined',
  GAME_ROOM_PLAYER_LEFT: 'game_room_player_left',
  GAME_ROOM_STATE: 'game_room_state',
  GAME_ROOM_PRIVATE: 'game_room_private',
  GAME_ROOM_MESSAGE: 'game_room_message',
  GAME_ROOM_VOICE: 'game_room_voice',
  GAME_ROOM_MEME: 'game_room_meme',
  GAME_ROOM_TYPING: 'game_room_typing',
  GAME_ROOM_SYSTEM: 'game_room_system',
  // ── Minigame nhúng ngay trong Chat 1-1 / Lumi AI / Nhóm chat ──
  CHAT_GAME_STATE: 'chat_game_state',
  CHAT_GAME_PRIVATE: 'chat_game_private',
  // ── Giữ kết nối ẩn danh 2 chiều & Mã hẹn gặp lại (1-1) ──
  PAIR_KEEP_UPDATED: 'pair_keep_updated',
  PAIR_KEEP_PASS: 'pair_keep_pass',
  PAIR_LIST: 'pair_list',
  PAIR_WAITING: 'pair_waiting',
  PAIR_INVITE: 'pair_invite',
  PAIR_INVITE_DECLINED: 'pair_invite_declined',
  PAIR_REMOVED: 'pair_removed',
  PAIR_PRESENCE: 'pair_presence',
});

/** Mã lỗi */
const ERROR_CODES = Object.freeze({
  INVALID_FORMAT: 'INVALID_FORMAT',    // JSON sai định dạng
  INVALID_TYPE: 'INVALID_TYPE',      // type không hợp lệ
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',   // payload không hợp lệ
  RATE_LIMITED: 'RATE_LIMITED',       // Gửi quá nhanh
  NOT_IN_ROOM: 'NOT_IN_ROOM',       // Chưa ở trong phòng chat
  NOT_JOINED: 'NOT_JOINED',        // Chưa đăng ký biệt danh
  ALREADY_WAITING: 'ALREADY_WAITING',   // Đã trong hàng đợi
  ALREADY_CHATTING: 'ALREADY_CHATTING',  // Đang chat rồi
  KICKED_PROFANITY: 'KICKED_PROFANITY',  // Bị kick do nói tục/khiếm nhã
  SKIP_COOLDOWN: 'SKIP_COOLDOWN',     // Spam skip quá nhanh
  BANNED: 'BANNED',            // Đang trong thời gian phạt cấm chat
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

  // Giới hạn kích thước thô (khớp với maxPayload: 4096 của WebSocketServer)
  if (raw.length > 4096) {
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
      // nickname bắt buộc (loại bỏ ký tự điều khiển ẩn / Bidi spoofing)
      if (typeof payload.nickname !== 'string') {
        return { ok: false, error: 'Biệt danh không được để trống' };
      }
      const nickname = stripDangerousUnicode(payload.nickname, { allowNewlines: false }).trim().replace(/\s+/g, ' ');
      if (nickname.length === 0) {
        return { ok: false, error: 'Biệt danh không được để trống' };
      }
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

      // avatar (tùy chọn: biểu tượng emoji ngắn)
      let avatar = '🦊';
      if (typeof payload.avatar === 'string' && payload.avatar.trim().length > 0) {
        avatar = payload.avatar.trim().substring(0, MAX_AVATAR_LENGTH);
      }

      return {
        ok: true,
        sanitized: {
          nickname,
          interests,
          mood,
          deviceId,
          avatar,
        },
      };
    }

    //Tiep tuc phong neu bi rot mang
    case CLIENT_TYPES.RESUME_SESSION: {
      if (
        typeof payload?.token !== 'string' ||
        !/^[0-9a-f]{64}$/.test(payload.token)
      ) {
        return {
          ok: false,
          error: 'Resume Token không hợp lệ'
        };
      }

      return {
        ok: true,
        sanitized: {
          token: payload.token
        }
      };
    }


    //rời phòng
    case CLIENT_TYPES.LEAVE_ROOM:
      return { ok: true, sanitized: {} };

    // ── message ──────────────────────────────────────────
    case CLIENT_TYPES.MESSAGE: {
      if (typeof payload.text !== 'string') {
        return { ok: false, error: 'Nội dung tin nhắn không được trống' };
      }
      const text = stripDangerousUnicode(payload.text, { allowNewlines: true }).trim();
      if (text.length === 0) {
        return { ok: false, error: 'Nội dung tin nhắn không được trống' };
      }
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

    // ── voice ─────────────────────────────────────────────
    case CLIENT_TYPES.VOICE: {
      if (typeof payload.voiceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.voiceId)) {
        return { ok: false, error: 'voiceId không hợp lệ' };
      }
      if (!isValidVoiceUrl(payload.url, payload.voiceId)) {
        return { ok: false, error: 'url voice không hợp lệ hoặc không khớp voiceId' };
      }
      if (typeof payload.duration !== 'number' || !Number.isFinite(payload.duration) || payload.duration <= 0 || payload.duration > 120) {
        return { ok: false, error: 'duration không hợp lệ (tối đa 120 giây)' };
      }
      return {
        ok: true,
        sanitized: {
          voiceId: payload.voiceId.toLowerCase(),
          url: `/api/voice/${payload.voiceId.toLowerCase()}`,
          duration: Math.round(payload.duration * 10) / 10,
        },
      };
    }

    // ── meme & sticker ────────────────────────────────────
    case CLIENT_TYPES.MEME: {
      if (!isAllowedMemeUrl(payload.url)) {
        return { ok: false, error: 'Nguồn nhãn dán / meme không nằm trong danh sách cho phép' };
      }
      const rawTitle = typeof payload.title === 'string'
        ? stripDangerousUnicode(payload.title, { allowNewlines: false }).trim().slice(0, 100)
        : 'Meme';
      const rawMemeId = typeof payload.memeId === 'string'
        ? stripDangerousUnicode(payload.memeId, { allowNewlines: false }).trim().slice(0, 50)
        : '';
      const isSticker = Boolean(payload.isSticker);
      return {
        ok: true,
        sanitized: {
          url: payload.url.trim(),
          title: escapeHtml(rawTitle || 'Meme'),
          memeId: escapeHtml(rawMemeId),
          isSticker,
        },
      };
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
      if (typeof payload.index !== 'number' || !Number.isInteger(payload.index) || payload.index < 0 || payload.index >= 400) {
        return { ok: false, error: 'Ô đánh không hợp lệ (phải từ 0 đến 399)' };
      }
      return { ok: true, sanitized: { index: payload.index } };
    }

    case CLIENT_TYPES.GAME_INVITE:
    case CLIENT_TYPES.GAME_ACCEPT:
    case CLIENT_TYPES.GAME_RESET: {
      const sanitized = {};
      if (payload.size !== undefined) {
        if (![10, 15, 20].includes(payload.size)) {
          return { ok: false, error: 'Kích thước bàn cờ chỉ hỗ trợ 10x10, 15x15 hoặc 20x20' };
        }
        sanitized.size = payload.size;
      }
      if (payload.gameType !== undefined) {
        const rawType = typeof payload.gameType === 'string' ? payload.gameType.trim().toLowerCase() : '';
        const allowed1v1 = ['caro', 'quiz_race', 'word_chain', 'mind_duel'];
        if (!allowed1v1.includes(rawType)) {
          return { ok: false, error: 'Trò chơi 1-1 không hợp lệ' };
        }
        sanitized.gameType = rawType;
      }
      return { ok: true, sanitized };
    }

    // ── find_match, start_solo, cancel, skip, icebreaker, game_quit, group_leave
    case CLIENT_TYPES.FIND_MATCH:
    case CLIENT_TYPES.START_SOLO:
    case CLIENT_TYPES.CANCEL:
    case CLIENT_TYPES.SKIP:
    case CLIENT_TYPES.ICEBREAKER:
    case CLIENT_TYPES.GAME_QUIT:
    case CLIENT_TYPES.GROUP_LEAVE:
      return { ok: true, sanitized: {} };

    // ── group_find / group_create ────────────────────────
    case CLIENT_TYPES.GROUP_FIND:
    case CLIENT_TYPES.GROUP_CREATE: {
      const mode = typeof payload.mode === 'string' && VALID_GROUP_MODES.includes(payload.mode.trim().toLowerCase())
        ? payload.mode.trim().toLowerCase()
        : 'random';

      let topic = '';
      if (payload.topic !== undefined) {
        if (typeof payload.topic !== 'string') {
          return { ok: false, error: 'Chủ đề nhóm phải là chuỗi văn bản' };
        }
        topic = payload.topic.trim();
        if (topic.length > MAX_GROUP_TOPIC_LENGTH) {
          return { ok: false, error: `Chủ đề nhóm tối đa ${MAX_GROUP_TOPIC_LENGTH} ký tự` };
        }
      }

      let name = '';
      if (payload.name !== undefined) {
        if (typeof payload.name !== 'string') {
          return { ok: false, error: 'Tên nhóm phải là chuỗi văn bản' };
        }
        name = payload.name.trim();
        if (name.length > MAX_GROUP_NAME_LENGTH) {
          return { ok: false, error: `Tên nhóm tối đa ${MAX_GROUP_NAME_LENGTH} ký tự` };
        }
      }

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
          if (!trimmed) continue;
          if (trimmed.length > MAX_INTEREST_LENGTH) {
            return { ok: false, error: `Mỗi sở thích tối đa ${MAX_INTEREST_LENGTH} ký tự` };
          }
          interests.push(trimmed);
        }
        interests = [...new Set(interests)];
      }

      let mood = 'ngau_nhien';
      if (typeof payload.mood === 'string' && VALID_MOODS.includes(payload.mood.trim().toLowerCase())) {
        mood = payload.mood.trim().toLowerCase();
      }

      const excludeGroupId = typeof payload.excludeGroupId === 'string' && payload.excludeGroupId.trim().length <= 64
        ? payload.excludeGroupId.trim()
        : null;

      return {
        ok: true,
        sanitized: { mode, topic, name, interests, mood, excludeGroupId },
      };
    }

    // ── group_join ───────────────────────────────────────
    case CLIENT_TYPES.GROUP_JOIN: {
      if (typeof payload.groupId !== 'string' || payload.groupId.trim().length === 0 || payload.groupId.length > 64) {
        return { ok: false, error: 'groupId không hợp lệ' };
      }
      return { ok: true, sanitized: { groupId: payload.groupId.trim() } };
    }

    // ── group_rejoin / group_unkeep ──────────────────────
    case CLIENT_TYPES.GROUP_REJOIN:
    case CLIENT_TYPES.GROUP_UNKEEP: {
      if (typeof payload.groupId !== 'string' || payload.groupId.trim().length === 0 || payload.groupId.length > 64) {
        return { ok: false, error: 'groupId không hợp lệ' };
      }
      if (typeof payload.rejoinToken !== 'string' || !/^[0-9a-f]{48}$/i.test(payload.rejoinToken.trim())) {
        return { ok: false, error: 'Mã vào lại nhóm không hợp lệ' };
      }
      return {
        ok: true,
        sanitized: {
          groupId: payload.groupId.trim(),
          rejoinToken: payload.rejoinToken.trim().toLowerCase(),
        },
      };
    }

    // ── group_vote_keep ──────────────────────────────────
    case CLIENT_TYPES.GROUP_VOTE_KEEP: {
      if (typeof payload.keep !== 'boolean') {
        return { ok: false, error: 'keep phải là boolean' };
      }
      return { ok: true, sanitized: { keep: payload.keep } };
    }

    // ── group_list ───────────────────────────────────────
    case CLIENT_TYPES.GROUP_LIST: {
      const mode = typeof payload.mode === 'string' && ['all', 'topic', 'random'].includes(payload.mode.trim().toLowerCase())
        ? payload.mode.trim().toLowerCase()
        : 'all';
      const query = typeof payload.query === 'string'
        ? payload.query.trim().slice(0, MAX_GROUP_TOPIC_LENGTH)
        : '';
      return { ok: true, sanitized: { mode, query } };
    }

    // ── group_sync_saved ─────────────────────────────────
    case CLIENT_TYPES.GROUP_SYNC_SAVED: {
      if (!Array.isArray(payload.passes)) {
        return { ok: false, error: 'passes phải là mảng' };
      }
      const sanitizedPasses = [];
      for (const item of payload.passes.slice(0, MAX_SAVED_GROUP_PASSES)) {
        if (
          item
          && typeof item.groupId === 'string'
          && item.groupId.trim().length > 0
          && item.groupId.length <= 64
          && typeof item.rejoinToken === 'string'
          && /^[0-9a-f]{48}$/i.test(item.rejoinToken.trim())
        ) {
          sanitizedPasses.push({
            groupId: item.groupId.trim(),
            rejoinToken: item.rejoinToken.trim().toLowerCase(),
          });
        }
      }
      return { ok: true, sanitized: { passes: sanitizedPasses } };
    }

    // ── group_report / game_room_report ──────────────────
    case CLIENT_TYPES.GROUP_REPORT:
    case CLIENT_TYPES.GAME_ROOM_REPORT: {
      if (typeof payload.targetClientId !== 'string' || payload.targetClientId.trim().length === 0 || payload.targetClientId.length > 64) {
        return { ok: false, error: 'Thành viên bị báo cáo không hợp lệ' };
      }
      if (typeof payload.reason !== 'string' || payload.reason.trim().length === 0) {
        return { ok: false, error: 'Lý do báo cáo không được trống' };
      }
      const reason = payload.reason.trim();
      if (reason.length > MAX_REPORT_REASON_LENGTH) {
        return { ok: false, error: `Lý do tối đa ${MAX_REPORT_REASON_LENGTH} ký tự` };
      }
      return {
        ok: true,
        sanitized: {
          targetClientId: payload.targetClientId.trim(),
          reason: escapeHtml(reason),
        },
      };
    }

    // ── game_room_leave / game_room_start / chat_game_* / pair_cancel_wait ──
    case CLIENT_TYPES.GAME_ROOM_LEAVE:
    case CLIENT_TYPES.GAME_ROOM_START:
    case CLIENT_TYPES.CHAT_GAME_JOIN:
    case CLIENT_TYPES.CHAT_GAME_LEAVE:
    case CLIENT_TYPES.CHAT_GAME_START:
    case CLIENT_TYPES.CHAT_GAME_CLOSE:
    case CLIENT_TYPES.PAIR_CANCEL_WAIT:
      return { ok: true, sanitized: {} };

    // ── pair_vote_keep ───────────────────────────────────
    case CLIENT_TYPES.PAIR_VOTE_KEEP: {
      if (typeof payload.keep !== 'boolean') {
        return { ok: false, error: 'keep phải là boolean' };
      }
      return { ok: true, sanitized: { keep: payload.keep } };
    }

    // ── pair_sync ────────────────────────────────────────
    case CLIENT_TYPES.PAIR_SYNC: {
      if (!Array.isArray(payload.passes)) {
        return { ok: false, error: 'passes phải là mảng' };
      }
      const sanitizedPasses = [];
      for (const item of payload.passes.slice(0, 30)) {
        if (
          item
          && typeof item.pairId === 'string'
          && item.pairId.trim().length > 0
          && item.pairId.length <= 64
          && typeof item.pairToken === 'string'
          && /^[0-9a-f]{48}$/i.test(item.pairToken.trim())
        ) {
          sanitizedPasses.push({
            pairId: item.pairId.trim(),
            pairToken: item.pairToken.trim().toLowerCase(),
          });
        }
      }
      return { ok: true, sanitized: { passes: sanitizedPasses } };
    }

    // ── pair_reconnect / pair_remove ─────────────────────
    case CLIENT_TYPES.PAIR_RECONNECT:
    case CLIENT_TYPES.PAIR_REMOVE: {
      if (typeof payload.pairId !== 'string' || payload.pairId.trim().length === 0 || payload.pairId.length > 64) {
        return { ok: false, error: 'pairId không hợp lệ' };
      }
      if (typeof payload.pairToken !== 'string' || !/^[0-9a-f]{48}$/i.test(payload.pairToken.trim())) {
        return { ok: false, error: 'Mã xác thực kết nối không hợp lệ' };
      }
      return {
        ok: true,
        sanitized: {
          pairId: payload.pairId.trim(),
          pairToken: payload.pairToken.trim().toLowerCase(),
        },
      };
    }

    // ── pair_join_code ───────────────────────────────────
    case CLIENT_TYPES.PAIR_JOIN_CODE: {
      if (typeof payload.pairCode !== 'string' || payload.pairCode.trim().length < 8 || payload.pairCode.trim().length > 24) {
        return { ok: false, error: 'Mã hẹn gặp lại không hợp lệ (ví dụ: CHAT-ABCD-1234)' };
      }
      return { ok: true, sanitized: { pairCode: payload.pairCode.trim().toUpperCase() } };
    }

    // ── pair_invite_respond ──────────────────────────────
    case CLIENT_TYPES.PAIR_INVITE_RESPOND: {
      if (typeof payload.inviteId !== 'string' || payload.inviteId.trim().length === 0 || payload.inviteId.length > 64) {
        return { ok: false, error: 'inviteId không hợp lệ' };
      }
      if (typeof payload.accept !== 'boolean') {
        return { ok: false, error: 'accept phải là boolean' };
      }
      return {
        ok: true,
        sanitized: {
          inviteId: payload.inviteId.trim(),
          accept: payload.accept,
        },
      };
    }

    // ── game_room_find ───────────────────────────────────
    case CLIENT_TYPES.GAME_ROOM_FIND: {
      const rawType = typeof payload.gameType === 'string' ? payload.gameType.trim().toLowerCase() : 'any';
      const gameType = (rawType === 'any' || VALID_MULTIPLAYER_GAMES.includes(rawType)) ? rawType : 'any';
      const excludeRoomId = typeof payload.excludeRoomId === 'string' && payload.excludeRoomId.trim().length <= 64
        ? payload.excludeRoomId.trim()
        : null;
      return { ok: true, sanitized: { gameType, excludeRoomId } };
    }

    // ── game_room_create ─────────────────────────────────
    case CLIENT_TYPES.GAME_ROOM_CREATE: {
      const rawType = typeof payload.gameType === 'string' ? payload.gameType.trim().toLowerCase() : 'quiz_race';
      const gameType = VALID_MULTIPLAYER_GAMES.includes(rawType) ? rawType : 'quiz_race';
      let name = '';
      if (payload.name !== undefined) {
        if (typeof payload.name !== 'string') return { ok: false, error: 'Tên phòng game phải là chuỗi văn bản' };
        name = payload.name.trim();
        if (name.length > MAX_GAME_ROOM_NAME_LENGTH) {
          return { ok: false, error: `Tên phòng game tối đa ${MAX_GAME_ROOM_NAME_LENGTH} ký tự` };
        }
      }
      let maxPlayers = 10;
      if (payload.maxPlayers !== undefined) {
        const parsedMax = Number(payload.maxPlayers);
        if (!Number.isInteger(parsedMax) || parsedMax < 2 || parsedMax > 10) {
          return { ok: false, error: 'Số người tối đa mỗi phòng game phải từ 2 đến 10' };
        }
        maxPlayers = parsedMax;
      }
      return { ok: true, sanitized: { gameType, name, maxPlayers } };
    }

    // ── game_room_join ───────────────────────────────────
    case CLIENT_TYPES.GAME_ROOM_JOIN: {
      const roomId = typeof payload.roomId === 'string' && payload.roomId.trim().length <= 64
        ? payload.roomId.trim()
        : null;
      const roomCode = typeof payload.roomCode === 'string' && /^[A-Z0-9]{4,10}$/i.test(payload.roomCode.trim())
        ? payload.roomCode.trim().toUpperCase()
        : null;
      if (!roomId && !roomCode) {
        return { ok: false, error: 'Cần cung cấp mã phòng hoặc ID phòng game hợp lệ' };
      }
      return { ok: true, sanitized: { roomId, roomCode } };
    }

    // ── game_room_list ───────────────────────────────────
    case CLIENT_TYPES.GAME_ROOM_LIST: {
      const rawType = typeof payload.gameType === 'string' ? payload.gameType.trim().toLowerCase() : 'all';
      const gameType = (rawType === 'all' || VALID_MULTIPLAYER_GAMES.includes(rawType)) ? rawType : 'all';
      return { ok: true, sanitized: { gameType } };
    }

    // ── game_room_select_game / chat_game_open / chat_game_select ──
    case CLIENT_TYPES.GAME_ROOM_SELECT_GAME:
    case CLIENT_TYPES.CHAT_GAME_OPEN:
    case CLIENT_TYPES.CHAT_GAME_SELECT: {
      const rawType = typeof payload.gameType === 'string' ? payload.gameType.trim().toLowerCase() : '';
      if (!VALID_MULTIPLAYER_GAMES.includes(rawType)) {
        return { ok: false, error: 'Loại trò chơi không hợp lệ' };
      }
      return { ok: true, sanitized: { gameType: rawType } };
    }

    // ── game_room_action / chat_game_action ──────────────
    case CLIENT_TYPES.GAME_ROOM_ACTION:
    case CLIENT_TYPES.CHAT_GAME_ACTION: {
      const allowedActions = [
        'answer', 'submit_word', 'submit_clue', 'vote',
        'pick_card', 'caro_move', 'play_again', 'back_to_lobby',
      ];
      if (typeof payload.action !== 'string' || !allowedActions.includes(payload.action)) {
        return { ok: false, error: 'Thao tác game không hợp lệ' };
      }

      const sanitized = { action: payload.action };
      if (payload.action === 'answer') {
        if (!Number.isInteger(payload.optionIndex) || payload.optionIndex < 0 || payload.optionIndex > 3) {
          return { ok: false, error: 'Đáp án phải từ 0 đến 3' };
        }
        sanitized.optionIndex = payload.optionIndex;
      } else if (payload.action === 'submit_word') {
        if (typeof payload.word !== 'string' || payload.word.trim().length === 0 || payload.word.trim().length > 40) {
          return { ok: false, error: 'Từ nối không hợp lệ' };
        }
        sanitized.word = payload.word.trim();
      } else if (payload.action === 'submit_clue') {
        if (typeof payload.clue !== 'string' || payload.clue.trim().length < 2 || payload.clue.trim().length > 80) {
          return { ok: false, error: 'Gợi ý mô tả phải từ 2 đến 80 ký tự' };
        }
        sanitized.clue = payload.clue.trim();
      } else if (payload.action === 'vote') {
        if (typeof payload.targetClientId !== 'string' || payload.targetClientId.trim().length === 0 || payload.targetClientId.length > 64) {
          return { ok: false, error: 'Người chơi được bỏ phiếu không hợp lệ' };
        }
        sanitized.targetClientId = payload.targetClientId.trim();
      } else if (payload.action === 'pick_card') {
        const card = typeof payload.card === 'string' ? payload.card.trim().toLowerCase() : '';
        if (!['attack', 'shield', 'bluff', 'charge'].includes(card)) {
          return { ok: false, error: 'Lá bài chiến thuật không hợp lệ' };
        }
        const stake = payload.stake === undefined ? 20 : Number(payload.stake);
        if (![10, 20, 30].includes(stake)) {
          return { ok: false, error: 'Mức cược phải là 10, 20 hoặc 30 điểm' };
        }
        sanitized.card = card;
        sanitized.stake = stake;
      } else if (payload.action === 'caro_move') {
        if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= 400) {
          return { ok: false, error: 'Ô cờ không hợp lệ' };
        }
        sanitized.index = payload.index;
      }
      return { ok: true, sanitized };
    }

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

  matchFound(partnerNickname, commonInterests, partnerMood = 'ngau_nhien', isBot = false, extra = null) {
    const payload = { partnerNickname, commonInterests, partnerMood, isBot };
    if (extra && typeof extra === 'object') {
      Object.assign(payload, extra);
    }
    return createMessage(SERVER_TYPES.MATCH_FOUND, payload);
  },

  message(text, timestamp, linkSafety = null) {
    return createMessage(SERVER_TYPES.MESSAGE, { text, timestamp, linkSafety });
  },

  voice(voiceData, timestamp = new Date().toISOString()) {
    return createMessage(SERVER_TYPES.VOICE, { ...voiceData, timestamp });
  },

  meme(memeData, timestamp = new Date().toISOString()) {
    return createMessage(SERVER_TYPES.MEME, { ...memeData, timestamp });
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

  // ── Trò chuyện nhóm ẩn danh ─────────────────────────────
  groupJoined(group) {
    return createMessage(SERVER_TYPES.GROUP_JOINED, group);
  },

  groupLeft(data) {
    return createMessage(SERVER_TYPES.GROUP_LEFT, data);
  },

  groupList(groups, maxMembers) {
    return createMessage(SERVER_TYPES.GROUP_LIST, { groups, maxMembers });
  },

  groupSavedList(groups, expiredGroupIds = []) {
    return createMessage(SERVER_TYPES.GROUP_SAVED_LIST, { groups, expiredGroupIds });
  },

  groupMemberJoined(groupId, member, memberCount, renamedMembers = []) {
    return createMessage(SERVER_TYPES.GROUP_MEMBER_JOINED, { groupId, member, memberCount, renamedMembers });
  },

  groupMemberLeft(data) {
    return createMessage(SERVER_TYPES.GROUP_MEMBER_LEFT, data);
  },

  groupMembersRenamed(groupId, renamedMembers) {
    return createMessage(SERVER_TYPES.GROUP_MEMBERS_RENAMED, { groupId, renamedMembers });
  },

  groupKeepUpdated(data) {
    return createMessage(SERVER_TYPES.GROUP_KEEP_UPDATED, data);
  },

  groupKeepPass(pass) {
    return createMessage(SERVER_TYPES.GROUP_KEEP_PASS, pass);
  },

  groupUnkept(data) {
    return createMessage(SERVER_TYPES.GROUP_UNKEPT, data);
  },

  groupMessage(data) {
    return createMessage(SERVER_TYPES.GROUP_MESSAGE, data);
  },

  groupVoice(data) {
    return createMessage(SERVER_TYPES.GROUP_VOICE, data);
  },

  groupMeme(data) {
    return createMessage(SERVER_TYPES.GROUP_MEME, data);
  },

  groupTyping(data) {
    return createMessage(SERVER_TYPES.GROUP_TYPING, data);
  },

  groupIcebreaker(question, category, triggeredBy = null) {
    return createMessage(SERVER_TYPES.GROUP_ICEBREAKER, { question, category, triggeredBy });
  },

  groupSystem(text, timestamp = new Date().toISOString()) {
    return createMessage(SERVER_TYPES.GROUP_SYSTEM, { text, timestamp });
  },

  // ── Phòng game nhiều người ẩn danh ──────────────────────
  gameRoomJoined(room) {
    return createMessage(SERVER_TYPES.GAME_ROOM_JOINED, room);
  },

  gameRoomLeft(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_LEFT, data);
  },

  gameRoomList(rooms, maxPlayers, catalog) {
    return createMessage(SERVER_TYPES.GAME_ROOM_LIST, { rooms, maxPlayers, catalog });
  },

  gameRoomPlayerJoined(roomId, player, playerCount, renamedMembers = []) {
    return createMessage(SERVER_TYPES.GAME_ROOM_PLAYER_JOINED, { roomId, player, playerCount, renamedMembers });
  },

  gameRoomPlayerLeft(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_PLAYER_LEFT, data);
  },

  gameRoomState(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_STATE, data);
  },

  gameRoomPrivate(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_PRIVATE, data);
  },

  gameRoomMessage(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_MESSAGE, data);
  },

  gameRoomVoice(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_VOICE, data);
  },

  gameRoomMeme(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_MEME, data);
  },

  gameRoomTyping(data) {
    return createMessage(SERVER_TYPES.GAME_ROOM_TYPING, data);
  },

  gameRoomSystem(text, timestamp = new Date().toISOString()) {
    return createMessage(SERVER_TYPES.GAME_ROOM_SYSTEM, { text, timestamp });
  },

  // ── Minigame nhúng ngay trong Chat 1-1 / Lumi AI / Nhóm chat ──
  chatGameState(data) {
    return createMessage(SERVER_TYPES.CHAT_GAME_STATE, data);
  },

  chatGamePrivate(data) {
    return createMessage(SERVER_TYPES.CHAT_GAME_PRIVATE, data);
  },

  // ── Giữ kết nối ẩn danh 2 chiều & Mã hẹn gặp lại (1-1) ──
  pairKeepUpdated(data) {
    return createMessage(SERVER_TYPES.PAIR_KEEP_UPDATED, data);
  },

  pairKeepPass(pass) {
    return createMessage(SERVER_TYPES.PAIR_KEEP_PASS, pass);
  },

  pairList(connections, expiredPairIds = []) {
    return createMessage(SERVER_TYPES.PAIR_LIST, { connections, expiredPairIds });
  },

  pairWaiting(data) {
    return createMessage(SERVER_TYPES.PAIR_WAITING, data);
  },

  pairInvite(data) {
    return createMessage(SERVER_TYPES.PAIR_INVITE, data);
  },

  pairInviteDeclined(data) {
    return createMessage(SERVER_TYPES.PAIR_INVITE_DECLINED, data);
  },

  pairRemoved(pairId, message = 'Kết nối đã được hủy ở cả hai phía.') {
    return createMessage(SERVER_TYPES.PAIR_REMOVED, { pairId, message });
  },

  pairPresence(data) {
    return createMessage(SERVER_TYPES.PAIR_PRESENCE, data);
  },
};

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  CLIENT_TYPES,
  SERVER_TYPES,
  ERROR_CODES,
  VALID_MOODS,
  VALID_GROUP_MODES,
  VALID_MULTIPLAYER_GAMES,
  MAX_NICKNAME_LENGTH,
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS_COUNT,
  MAX_MESSAGE_LENGTH,
  MAX_REPORT_REASON_LENGTH,
  MAX_GROUP_TOPIC_LENGTH,
  MAX_GROUP_NAME_LENGTH,
  MAX_GAME_ROOM_NAME_LENGTH,
  parseMessage,
  validatePayload,
  createMessage,
  serverMsg,
  escapeHtml,
};
