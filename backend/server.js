/**
 * server.js – Khởi tạo WebSocket Server, xử lý kết nối
 *
 * Đây là điểm vào chính của Server. Module này:
 *   1. Tạo HTTP server để phục vụ frontend/ và nâng cấp kết nối lên WebSocket.
 *   2. Quản lý vòng đời kết nối: open → message → close / error.
 *   3. Heartbeat (Ping/Pong) để phát hiện kết nối "chết".
 *   4. Điều phối message đến các module: Matchmaker, RoomManager, Moderation.
 *   5. Broadcast số người online.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const {
  CLIENT_TYPES,
  ERROR_CODES,
  parseMessage,
  validatePayload,
  serverMsg,
} = require('./protocol');
const Matchmaker = require('./matchmaker');
const RoomManager = require('./roomManager');
const Moderation = require('./moderation');
const RedisManager = require('./redisManager');
const { checkContent } = require('./contentFilter');
const { analyzeLinkSafety } = require('./linkSafety');
const { checkMessageLinks } = require('./webRisk');
const {
  AttachmentError,
  createAttachmentStorage,
} = require('./attachmentStorage');
const { getRandomIcebreaker } = require('./icebreakers');
const { CompanionBot } = require('./companionBot');

// ─── Cấu hình ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const HEARTBEAT_INTERVAL = 30_000; // 30 giây
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const attachmentStorage = createAttachmentStorage();
const pendingAttachmentCompletions = new Set();
const completedAttachmentTickets = new Map();
const configuredMaxConcurrentAttachmentUploads = Number(process.env.MAX_CONCURRENT_ATTACHMENT_UPLOADS);
const MAX_CONCURRENT_ATTACHMENT_UPLOADS = Number.isSafeInteger(configuredMaxConcurrentAttachmentUploads)
  && configuredMaxConcurrentAttachmentUploads > 0
  ? configuredMaxConcurrentAttachmentUploads
  : 4;
let activeAttachmentUploads = 0;
if (!attachmentStorage.enabled) {
  console.info('[Attachments] Disabled; configure Azure Storage to enable file sharing.');
}

/** Giới hạn kết nối */
const MAX_TOTAL_CONNECTIONS = 1000;
const configuredMaxConnectionsPerIp = Number(process.env.MAX_CONNECTIONS_PER_IP);
const MAX_CONNECTIONS_PER_IP = Number.isSafeInteger(configuredMaxConnectionsPerIp)
  && configuredMaxConnectionsPerIp > 0
  ? configuredMaxConnectionsPerIp
  : 100; // Có thể tăng riêng cho load test cục bộ.
const ipConnections = new Map(); // ip -> count

// ─── MIME types cho file tĩnh ──────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.avif': 'image/avif',
};

// ─── HTTP Server (phục vụ file tĩnh) ──────────────────────────────────────

function writeJsonResponse(res, statusCode, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function handleAttachmentUploadRequest(req, res, uploadId) {
  const authorization = req.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/u.exec(authorization);
  if (!match) {
    req.resume();
    writeJsonResponse(res, 401, { error: 'Mã tải tệp không hợp lệ.' });
    return;
  }

  try {
    attachmentStorage.validateTicket(match[1], uploadId);
  } catch (error) {
    req.resume();
    const statusCode = error instanceof AttachmentError ? error.statusCode : 500;
    writeJsonResponse(res, statusCode, {
      error: error instanceof AttachmentError ? error.message : 'Không thể xác thực quyền tải tệp.',
    });
    return;
  }
  if (activeAttachmentUploads >= MAX_CONCURRENT_ATTACHMENT_UPLOADS) {
    req.resume();
    writeJsonResponse(res, 503, { error: 'Máy chủ đang xử lý nhiều tệp. Vui lòng thử lại sau.' });
    return;
  }

  activeAttachmentUploads += 1;
  attachmentStorage.upload(uploadId, match[1], req)
    .then((result) => writeJsonResponse(res, 201, result))
    .catch((error) => {
      if (!req.complete) req.resume();
      const statusCode = error instanceof AttachmentError ? error.statusCode : 500;
      if (statusCode >= 500) {
        console.error('[Attachments] Azure upload failed:', error.message);
      }
      writeJsonResponse(
        res,
        statusCode,
        { error: statusCode >= 500 ? 'Không thể lưu tệp lúc này. Vui lòng thử lại.' : error.message },
      );
    })
    .finally(() => {
      activeAttachmentUploads -= 1;
    });
}

const httpServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const uploadMatch = /^\/api\/attachments\/([0-9a-f-]{36})$/iu.exec(requestUrl.pathname);
  if (req.method === 'POST' && uploadMatch) {
    handleAttachmentUploadRequest(req, res, uploadMatch[1]);
    return;
  }

  // Chỉ cho phép GET
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let filePath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;

  // Bảo mật: chống path traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(FRONTEND_DIR, filePath);

  // Đảm bảo nằm trong thư mục client
  if (!fullPath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── WebSocket Server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 4096, // Giới hạn kích thước payload tối đa 4KB để chống DoS / Memory Exhaustion (CWE-400 / CVE-2020-13935)
  verifyClient: (info, callback) => {
    // ── Bảo vệ chống Cross-Site WebSocket Hijacking (CSWSH - CWE-1385 / OWASP ASVS v4.0) ──
    const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin);
    const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : null;

    if (allowedOrigins && origin && !allowedOrigins.includes(origin)) {
      console.warn(`[Security] 🚫 Chặn kết nối WebSocket từ Origin trái phép: "${origin}" (CSWSH Defense)`);
      return callback(false, 403, 'Forbidden Origin (CSWSH Prevention - CWE-1385)');
    }
    callback(true);
  },
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Cổng ${PORT} đang được sử dụng.`);
    console.error(`[Server] Hãy dừng tiến trình đang dùng cổng này hoặc chạy với cổng khác, ví dụ: $env:PORT=3002; npm start`);
    process.exit(1);
  }

  console.error('[Server] WebSocket server error:', err);
});

/**
 * Lưu trữ thông tin client.
 * @type {Map<string, ClientInfo>}
 *
 * ClientInfo: {
 *   ws: WebSocket,
 *   clientId: string,
 *   clientIp: string,
 *   deviceId: string | null,
 *   nickname: string | null,
 *   interests: string[],
 *   state: 'CONNECTED' | 'WAITING' | 'CHATTING',
 *   isAlive: boolean,  // cho heartbeat
 * }
 */
const clients = new Map();
const pendingChatMessages = new Map();

// ─── Khởi tạo modules ─────────────────────────────────────────────────────

const roomManager = new RoomManager();
const moderation = new Moderation();

const redisManager = new RedisManager({
  onDirectMessage: (targetClientId, msgString) => {
    // Nhận message từ một server node khác qua Redis Pub/Sub và chuyển tiếp cho WebSocket client tại node này
    const client = clients.get(targetClientId);
    if (client && client.ws.readyState === 1) {
      client.ws.send(msgString);
    }
  },
  onMatchEvent: ({ entry1, entry2, commonInterests }) => {
    handleMatchFound(entry1, entry2, commonInterests);
  },
  onRoomLeft: (event) => {
    handleRemoteRoomLeft(event);
  },
  onOnlineCount: (count) => {
    broadcastOnlineCount(count);
  },
});

const matchmaker = new Matchmaker({
  onMatch: (entry1, entry2, commonInterests) => {
    handleMatchFound(entry1, entry2, commonInterests);
  },
  redisManager,
  onError: (clientId, error) => {
    const client = clients.get(clientId);
    if (client && client.state === 'WAITING') {
      client.state = 'CONNECTED';
      sendTo(clientId, serverMsg.error('MATCHMAKING_UNAVAILABLE', 'Không thể kết nối hàng đợi ghép cặp. Vui lòng thử lại.'));
    }
    console.error(`[Matchmaker] Queue operation failed for ${clientId}:`, error.message);
  },
  // Kiểm tra chặn vĩnh viễn (Never-Match) và chặn tạm
  isBlocked: (entry1, entry2) => moderation.isBlocked(entry1, entry2),
});

// ─── Hàm tiện ích ──────────────────────────────────────────────────────────

/**
 * Gửi message cho một client qua WebSocket hoặc qua Redis Pub/Sub nếu ở node khác.
 * @param {string} clientId
 * @param {string} msgString - JSON string
 */
function sendTo(clientId, msgString) {
  const client = clients.get(clientId);
  if (client && client.ws.readyState === 1) { // WebSocket.OPEN = 1
    client.ws.send(msgString);
  } else if (redisManager.isConnected) {
    // Nếu client kết nối ở một Node.js instance khác trong cụm -> chuyển tiếp qua Redis
    redisManager.publishToClient(clientId, msgString).then((published) => {
      if (!published) {
        console.error(`[Server] Redis could not route a message to client ${clientId}`);
      }
    });
  } else if (redisManager.enabled) {
    console.error(`[Server] Redis unavailable; cannot route a message to client ${clientId}`);
  }
}

/**
 * Broadcast số người online cho tất cả client.
 */
function broadcastOnlineCount(count = clients.size) {
  const msg = serverMsg.onlineCount(count);
  for (const [, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}

function handleRemoteRoomLeft({ clientId, partnerId, reason, sourceInstanceId }) {
  if (sourceInstanceId === redisManager.instanceId) return;

  const localPartner = clients.get(partnerId);
  if (!localPartner) return;

  roomManager.removeClient(partnerId);
  localPartner.state = 'CONNECTED';
  sendTo(partnerId, serverMsg.partnerLeft(reason));
  console.log(`[Server] Remote room closed: ${clientId} ↔ ${partnerId}`);
}

function notifyRoomLeft(clientId, partnerId, reason = null) {
  const localPartner = clients.get(partnerId);
  if (localPartner) {
    sendTo(partnerId, serverMsg.partnerLeft(reason));
  } else if (!redisManager.enabled) {
    sendTo(partnerId, serverMsg.partnerLeft(reason));
  }

  if (redisManager.enabled) {
    redisManager.publishRoomLeft(clientId, partnerId, reason).catch((error) => {
      console.error('[Server] Failed to publish room-left event:', error.message);
    });
  }
}

// ─── Xử lý ghép cặp thành công ────────────────────────────────────────────

function handleMatchFound(entry1, entry2, commonInterests) {
  const client1 = clients.get(entry1.clientId);
  const client2 = clients.get(entry2.clientId);

  if (!client1 && !client2) return;
  if ((!client1 || client1.state !== 'WAITING') && (!client2 || client2.state !== 'WAITING')) {
    acknowledgeLocalMatches(client1, client2);
    return;
  }

  // Hủy bộ đếm gợi ý solo nếu có
  if (client1 && client1.soloHintTimer) {
    clearTimeout(client1.soloHintTimer);
    client1.soloHintTimer = null;
  }
  if (client2 && client2.soloHintTimer) {
    clearTimeout(client2.soloHintTimer);
    client2.soloHintTimer = null;
  }

  // Tạo phòng chat
  const roomId = roomManager.createRoom(entry1.clientId, entry2.clientId);

  // Cập nhật trạng thái
  if (client1) client1.state = 'CHATTING';
  if (client2) client2.state = 'CHATTING';

  // Mỗi server instance chỉ gửi phản hồi cho kết nối WebSocket mà nó đang quản lý.
  if (client1) {
    sendTo(entry1.clientId, serverMsg.matchFound(entry2.nickname, commonInterests, entry2.mood));
  }
  if (client2) {
    sendTo(entry2.clientId, serverMsg.matchFound(entry1.nickname, commonInterests, entry1.mood));
  }

  acknowledgeLocalMatches(client1, client2);
  console.log(`[Server] Chat started: ${entry1.nickname} (${entry1.mood}) ↔ ${entry2.nickname} (${entry2.mood}) in room ${roomId}`);
}

function acknowledgeLocalMatches(client1, client2) {
  for (const client of [client1, client2]) {
    if (client) {
      redisManager.acknowledgeMatch(client.clientId).catch((error) => {
        console.error('[Server] Failed to acknowledge Redis match:', error.message);
      });
    }
  }
}

/**
 * Khởi động phiên trò chuyện 1-1 với Bạn Đồng Hành Lumi (Solo Companion).
 * Giúp người dùng khi ở 1 mình có thể thoải mái tâm sự, giãi bày hoặc chơi game giải trí.
 * @param {string} clientId
 */
function startSoloSession(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.nickname) {
    sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
    return;
  }

  // Hủy timer gợi ý solo
  if (client.soloHintTimer) {
    clearTimeout(client.soloHintTimer);
    client.soloHintTimer = null;
  }

  // Nếu đang trong waiting -> dequeue
  if (client.state === 'WAITING') {
    matchmaker.dequeue(clientId);
  }

  // Nếu đang trong phòng khác -> dọn phòng
  if (client.state === 'CHATTING') {
    roomManager.removeClient(clientId);
  }

  // Khởi tạo Bot instance
  const bot = new CompanionBot(clientId, client.nickname, client.mood, client.interests, sendTo);
  const roomId = roomManager.createRoom(clientId, bot.botClientId, true, bot);

  client.state = 'CHATTING';

  const botInfo = bot.getPartnerInfo();
  // Gửi thông báo matchFound với cờ isBot = true
  sendTo(clientId, serverMsg.matchFound(botInfo.nickname, botInfo.interests, botInfo.mood, true));
  console.log(`[Server] 🤖 Solo Bot session started: ${client.nickname} (${client.mood}) ↔ ${botInfo.nickname} in room ${roomId}`);

  // Bot gửi lời chào mở đầu thân thiện theo tâm trạng
  bot.sendWelcome();
}

// ─── Xử lý từng loại message ──────────────────────────────────────────────

const messageHandlers = {
  // ── join ──────────────────────────────────────────────
  [CLIENT_TYPES.JOIN](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.nickname) {
      // Đã join rồi → update nickname/interests/mood/deviceId
      client.nickname = payload.nickname;
      client.interests = payload.interests;
      client.mood = payload.mood || 'ngau_nhien';
      client.deviceId = payload.deviceId || client.deviceId || null;
      console.log(`[Server] Re-join: ${payload.nickname} (${clientId}) [deviceId=${client.deviceId}, mood=${client.mood}]`);
      return;
    }

    client.nickname = payload.nickname;
    client.interests = payload.interests;
    client.mood = payload.mood || 'ngau_nhien';
    client.deviceId = payload.deviceId || null;
    console.log(`[Server] Join: ${payload.nickname} (${clientId}), deviceId=${client.deviceId}, mood=${client.mood}, interests=[${payload.interests.join(', ')}]`);
  },

  // ── find_match ────────────────────────────────────────
  [CLIENT_TYPES.FIND_MATCH](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    // Kiểm tra có đang bị cấm do phát ngôn bậy / vi phạm tiêu chuẩn cộng đồng không
    const banCheck = moderation.isBanned(clientId, client.clientIp);
    if (banCheck.banned) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.BANNED, `Tài khoản của bạn tạm thời bị cấm kết nối (${banCheck.remainingSec}s còn lại). Lý do: ${banCheck.reason}`));
      return;
    }

    // Kiểm tra đã join chưa
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }

    // Kiểm tra trạng thái
    if (client.state === 'WAITING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_WAITING, 'Bạn đang trong hàng đợi'));
      return;
    }
    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Bạn đang trong phòng chat'));
      return;
    }

    client.state = 'WAITING';
    sendTo(clientId, serverMsg.waiting());

    // Thiết lập timer gợi ý Solo Bot sau 10 giây nếu vẫn chưa ghép được ai
    if (client.soloHintTimer) clearTimeout(client.soloHintTimer);
    client.soloHintTimer = setTimeout(() => {
      if (client.state === 'WAITING') {
        sendTo(clientId, serverMsg.soloHint(10, 'Hệ thống nhận thấy hiện tại chưa có bạn chat nào... Bạn có muốn tâm sự giải bày cùng Trợ lý Lumi hoặc chơi cờ Caro giải trí không?'));
      }
    }, 10_000);

    matchmaker.enqueue(clientId, client.nickname, client.interests, client.mood, client.clientIp, client.deviceId);
  },

  // ── start_solo (chủ động tâm sự hoặc chơi game với Bot Lumi) ─────────────
  [CLIENT_TYPES.START_SOLO](clientId) {
    startSoloSession(clientId);
  },

  // ── cancel ────────────────────────────────────────────
  [CLIENT_TYPES.CANCEL](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.soloHintTimer) {
      clearTimeout(client.soloHintTimer);
      client.soloHintTimer = null;
    }

    if (client.state !== 'WAITING') return;

    matchmaker.dequeue(clientId);
    client.state = 'CONNECTED';
    console.log(`[Server] Cancel waiting: ${client.nickname} (${clientId})`);
  },

  // ── message ───────────────────────────────────────────
  async [CLIENT_TYPES.MESSAGE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng chat'));
      return;
    }

    // 1. Rate limit
    if (!moderation.checkRateLimit(clientId)) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin quá nhanh, vui lòng chờ'));
      return;
    }

    // 2. Kiểm tra bộ lọc từ ngữ khiếm nhã, thô tục, xúc phạm, chat đen
    const filterResult = checkContent(payload.text);
    if (filterResult.isViolation) {
      console.warn(`[Server] 🚫 Vi phạm nội dung cấm: ${client.nickname} (${clientId}) từ IP ${client.clientIp} - Từ ngữ: "${filterResult.matched}"`);

      // Cấm tạm thời 10 phút cả ClientID lẫn IP
      const banExpiresAt = moderation.ban(clientId, client.clientIp, filterResult.reason);
      if (redisManager.isConnected) {
        redisManager.addBlock(clientId, client.clientIp, 600);
      }

      // Chặn cặp trong bộ nhớ tiến trình để người bị hại không gặp lại người vi phạm.
      const partnerId = roomManager.getPartnerId(clientId);
      if (partnerId) {
        const partner = clients.get(partnerId);
        if (partner) {
          moderation.addPermanentBlock(partner, client);
          partner.state = 'CONNECTED';
        }
        notifyRoomLeft(clientId, partnerId, 'Đối phương đã bị hệ thống buộc rời khỏi phòng do vi phạm tiêu chuẩn cộng đồng (ngôn từ khiếm nhã).');
      }

      // Thông báo bị kick ngay lập tức cho người vi phạm
      sendTo(clientId, serverMsg.kicked(filterResult.reason, banExpiresAt));

      // Xóa phòng chat
      roomManager.removeClient(clientId);
      client.state = 'CONNECTED';
      return;
    }

    // Kiểm tra nếu đang ở phòng trò chuyện cùng Bạn Đồng Hành Lumi
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (bot) {
        bot.handleUserMessage(payload.text);
      }
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    const linkSafety = analyzeLinkSafety(payload.text);
    let reputation;
    try {
      reputation = await checkMessageLinks(payload.text);
    } catch (error) {
      console.error('[WebRisk] Could not check message links:', error.message);
      reputation = { status: 'unavailable', checkedCount: 0, threatTypes: [], complete: false };
    }

    const currentClient = clients.get(clientId);
    if (!currentClient || currentClient.state !== 'CHATTING' || roomManager.getPartnerId(clientId) !== partnerId) return;

    const reputationWarning = {
      hasLinks: linkSafety.hasLinks,
      suspicious: linkSafety.suspicious || reputation.status === 'threat' || reputation.status === 'limit_exceeded',
      reasons: [...linkSafety.reasons],
      reputation: reputation.status,
      threatTypes: reputation.threatTypes,
    };

    if (reputation.status === 'threat' || reputation.status === 'limit_exceeded') {
      reputationWarning.blocked = true;
      reputationWarning.reasons.push(
        reputation.status === 'threat'
          ? 'Google Web Risk nhận diện liên kết thuộc danh sách mối đe dọa.'
          : 'Tin nhắn vượt quá giới hạn 5 URL được kiểm tra.',
      );
      sendTo(clientId, serverMsg.linkWarning(reputationWarning));
      sendTo(partnerId, serverMsg.linkWarning(reputationWarning));
      return;
    }

    const timestamp = new Date().toISOString();
    const messageLinkSafety = linkSafety.hasLinks
      ? { ...reputationWarning, hasLinks: true }
      : null;
    sendTo(partnerId, serverMsg.message(payload.text, timestamp, messageLinkSafety));
    if (linkSafety.hasLinks) {
      sendTo(clientId, serverMsg.linkWarning(reputationWarning));
    }
  },

  [CLIENT_TYPES.ATTACHMENT_REQUEST](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING' || roomManager.isBotRoom(clientId)) {
      sendTo(clientId, serverMsg.error('ATTACHMENT_NOT_AVAILABLE', 'Chỉ có thể gửi tệp khi đang trò chuyện với người dùng.'));
      return;
    }
    if (!moderation.checkRateLimit(clientId)) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi quá nhanh, vui lòng chờ.'));
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;
    try {
      const ticket = attachmentStorage.issueUploadTicket(
        clientId,
        partnerId,
        payload.fileName,
        payload.size,
      );
      sendTo(clientId, serverMsg.attachmentUpload(ticket));
    } catch (error) {
      if (error instanceof AttachmentError) {
        sendTo(clientId, serverMsg.error('ATTACHMENT_REJECTED', error.message));
        return;
      }
      console.error('[Attachments] Could not create upload ticket:', error.message);
      sendTo(clientId, serverMsg.error('ATTACHMENT_FAILED', 'Không thể chuẩn bị tải tệp lúc này.'));
    }
  },

  async [CLIENT_TYPES.ATTACHMENT_SEND](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING' || roomManager.isBotRoom(clientId)) return;

    let claims;
    try {
      claims = attachmentStorage.validateTicket(payload.ticket);
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error;
      sendTo(clientId, serverMsg.error('ATTACHMENT_REJECTED', error.message));
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (claims.clientId !== clientId || claims.partnerId !== partnerId || !partnerId) {
      sendTo(clientId, serverMsg.error('ATTACHMENT_REJECTED', 'Tệp này không thuộc phòng chat hiện tại.'));
      return;
    }
    const completedUntil = completedAttachmentTickets.get(claims.uploadId);
    if (completedUntil && completedUntil > Date.now()) return;
    if (completedUntil) completedAttachmentTickets.delete(claims.uploadId);
    if (pendingAttachmentCompletions.has(claims.uploadId)) return;
    pendingAttachmentCompletions.add(claims.uploadId);

    try {
      const attachment = await attachmentStorage.completeUpload(clientId, payload.ticket);
      completedAttachmentTickets.set(claims.uploadId, claims.expiresAt);
      if (completedAttachmentTickets.size > 10_000) {
        const oldestTicketId = completedAttachmentTickets.keys().next().value;
        completedAttachmentTickets.delete(oldestTicketId);
      }
      const currentClient = clients.get(clientId);
      if (!currentClient || currentClient.state !== 'CHATTING' || roomManager.getPartnerId(clientId) !== partnerId) return;

      const timestamp = new Date().toISOString();
      sendTo(partnerId, serverMsg.attachment(attachment, timestamp));
      sendTo(clientId, serverMsg.attachmentSent(attachment, timestamp));
    } catch (error) {
      if (!(error instanceof AttachmentError)) {
        console.error('[Attachments] Could not finish sharing uploaded file:', error.message);
        sendTo(clientId, serverMsg.error('ATTACHMENT_FAILED', 'Không thể chia sẻ tệp lúc này. Tệp chưa được gửi.'));
        return;
      }
      sendTo(clientId, serverMsg.error('ATTACHMENT_REJECTED', error.message));
    } finally {
      pendingAttachmentCompletions.delete(claims.uploadId);
    }
  },

  // ── typing ────────────────────────────────────────────
  [CLIENT_TYPES.TYPING](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    // Nếu là phòng Bot thì không cần chuyển tiếp
    if (roomManager.isBotRoom(clientId)) return;

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    sendTo(partnerId, serverMsg.typing(payload.isTyping));
  },

  // ── skip ──────────────────────────────────────────────
  [CLIENT_TYPES.SKIP](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state !== 'CHATTING') return;

    // Nếu đang ở phòng Bot Đồng Hành -> chuyển sang hàng đợi tìm người thật
    if (roomManager.isBotRoom(clientId)) {
      roomManager.removeClient(clientId);
      client.state = 'WAITING';
      sendTo(clientId, serverMsg.waiting());
      console.log(`[Server] Skip from Bot: ${client.nickname} (${clientId}) chuyển sang tìm người thật`);

      // Timer gợi ý nếu chờ lâu
      if (client.soloHintTimer) clearTimeout(client.soloHintTimer);
      client.soloHintTimer = setTimeout(() => {
        if (client.state === 'WAITING') {
          sendTo(clientId, serverMsg.soloHint(10, 'Chưa có bạn chat mới... Bạn có muốn tiếp tục tâm sự cùng Lumi hoặc thử lại ván cờ khác không?'));
        }
      }, 10_000);

      matchmaker.enqueue(clientId, client.nickname, client.interests, client.mood, client.clientIp, client.deviceId);
      return;
    }

    // Kiểm tra chống tool/bot spam skip liên tục để dò tìm đối tượng
    const skipCheck = moderation.checkSkipLimit(clientId);
    if (!skipCheck.allowed) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.SKIP_COOLDOWN, `Bạn đang bỏ qua quá nhanh! Vui lòng chờ ${skipCheck.remainingSec}s trước khi tìm người mới.`));
      return;
    }

    const result = roomManager.removeClient(clientId);
    if (result && result.partnerId) {
      // Thông báo đối phương
      notifyRoomLeft(clientId, result.partnerId);
      const partner = clients.get(result.partnerId);
      if (partner) {
        partner.state = 'CONNECTED';
      }
    }

    // Đưa người skip trở lại hàng đợi tự động
    client.state = 'WAITING';
    sendTo(clientId, serverMsg.waiting());

    // Timer gợi ý solo
    if (client.soloHintTimer) clearTimeout(client.soloHintTimer);
    client.soloHintTimer = setTimeout(() => {
      if (client.state === 'WAITING') {
        sendTo(clientId, serverMsg.soloHint(10, 'Hệ thống nhận thấy hiện tại chưa có bạn chat nào... Bạn có muốn tâm sự giải bày cùng Trợ lý Lumi hoặc chơi cờ Caro giải trí không?'));
      }
    }, 10_000);

    matchmaker.enqueue(clientId, client.nickname, client.interests, client.mood, client.clientIp, client.deviceId);

    console.log(`[Server] Skip: ${client.nickname} (${clientId})`);
  },

  // ── report ────────────────────────────────────────────
  [CLIENT_TYPES.REPORT](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng chat để báo cáo'));
      return;
    }

    // Không báo cáo Bot
    if (roomManager.isBotRoom(clientId)) {
      sendTo(clientId, serverMsg.message('Lumi luôn cố gắng lắng nghe và đem lại không gian an toàn nhất cho bạn! Nếu bạn muốn tìm bạn chat người thật, hãy nhấn nút "Tìm người thật" nhé 🥰', new Date().toISOString()));
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    const partner = clients.get(partnerId);

    // Ghi nhận report và block tạm theo deviceId để vẫn áp dụng sau khi tải lại trang.
    moderation.addReport(client, partner || partnerId, payload.reason);
    if (redisManager.isConnected) {
      redisManager.addBlock(client.deviceId || clientId, partner?.deviceId || partnerId, 300);
    }

    // Xác nhận cho người report
    sendTo(clientId, serverMsg.reported());

    // Kết thúc phòng chat (tương tự skip)
    const result = roomManager.removeClient(clientId);
    if (result && result.partnerId) {
      notifyRoomLeft(clientId, result.partnerId, 'Đối phương đã rời phòng sau báo cáo.');
      if (partner) {
        partner.state = 'CONNECTED';
      }
    }

    // Đưa người report vào hàng đợi
    client.state = 'WAITING';
    sendTo(clientId, serverMsg.waiting());
    matchmaker.enqueue(clientId, client.nickname, client.interests, client.mood, client.clientIp, client.deviceId);
  },

  // ── icebreaker (câu hỏi phá băng gợi ý mở đầu) ─────────
  [CLIENT_TYPES.ICEBREAKER](clientId) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    if (!roomId) return;

    const prompt = getRandomIcebreaker();
    const msg = serverMsg.icebreaker(prompt.text, prompt.category);

    sendTo(clientId, msg);

    // Nếu ở phòng Bot -> Bot trả lời câu hỏi và hỏi lại người dùng
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (bot) {
        setTimeout(() => {
          sendTo(clientId, serverMsg.typing(true));
          setTimeout(() => {
            sendTo(clientId, serverMsg.typing(false));
            sendTo(clientId, serverMsg.message(`Chủ đề này thú vị ghê! Theo mình thì: "${prompt.text}"... Mình thấy cuộc sống luôn có những điều bất ngờ thú vị. Còn góc nhìn của bạn thì sao nè?`, new Date().toISOString()));
          }, 1200);
        }, 800);
      }
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (partnerId) {
      sendTo(partnerId, msg);
    }
    console.log(`[Server] 🎲 Icebreaker: [${prompt.category}] ${prompt.text} in room ${roomId}`);
  },

  // ── game_invite (mời chơi minigame 1-1) ────────────────
  [CLIENT_TYPES.GAME_INVITE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const requestedSize = (payload && [3, 8, 10].includes(payload.size)) ? payload.size : 10;

    // Nếu là phòng Bot -> Bot tự động chấp nhận ngay lập tức!
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (!bot) return;
      const roomId = roomManager.getRoomId(clientId);
      const game = roomManager.initGame(roomId, clientId, bot.botClientId, requestedSize);
      sendTo(clientId, serverMsg.gameState({ action: 'start', game }));
      setTimeout(() => {
        sendTo(clientId, serverMsg.message(`Nhận lời thách đấu luôn nè! Bàn cờ Caro ${game.size}x${game.size} (${game.winLength} ô liên tiếp để thắng), bạn cầm quân X đi trước nhé 😉`, new Date().toISOString()));
      }, 500);
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    sendTo(partnerId, serverMsg.gameState({
      action: 'invite',
      fromId: clientId,
      fromName: client.nickname,
      size: requestedSize,
    }));
  },

  // ── game_accept (nhận lời chơi minigame) ──────────────
  [CLIENT_TYPES.GAME_ACCEPT](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    const partnerId = roomManager.getPartnerId(clientId);
    if (!roomId || !partnerId) return;

    const requestedSize = (payload && [3, 8, 10].includes(payload.size)) ? payload.size : 10;
    const game = roomManager.initGame(roomId, partnerId, clientId, requestedSize);
    const msg = serverMsg.gameState({
      action: 'start',
      game,
    });

    sendTo(clientId, msg);
    sendTo(partnerId, msg);
  },

  // ── game_move (nước đi minigame) ──────────────────────
  [CLIENT_TYPES.GAME_MOVE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    if (!roomId) return;

    // Xử lý nước đi khi chơi cùng Bot
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (!bot) return;

      const result = roomManager.makeGameMove(roomId, clientId, payload.index);
      if (!result.ok) {
        sendTo(clientId, serverMsg.error('GAME_INVALID_MOVE', result.error));
        return;
      }

      // Gửi nước đi của người chơi
      sendTo(clientId, serverMsg.gameState({ action: 'update', game: result.game }));

      // Nếu người chơi kết thúc ván (thắng hoặc hòa)
      if (result.game.status === 'ended') {
        const comment = result.game.winner === 'X' ? bot.getGameComment('playerWin') : bot.getGameComment('draw');
        setTimeout(() => {
          sendTo(clientId, serverMsg.message(comment, new Date().toISOString()));
        }, 400);
        return;
      }

      // Đến lượt Bot đánh
      if (result.game.turn === bot.botClientId) {
        setTimeout(() => {
          const currentRoom = roomManager.getRoom(roomId);
          if (!currentRoom || !currentRoom.game || currentRoom.game.status !== 'playing') return;
          const botMove = bot.computeMove(currentRoom.game.board, 'O', 'X');
          if (botMove >= 0) {
            const botResult = roomManager.makeGameMove(roomId, bot.botClientId, botMove);
            if (botResult.ok) {
              sendTo(clientId, serverMsg.gameState({ action: 'update', game: botResult.game }));
              if (botResult.game.status === 'ended') {
                const comment = botResult.game.winner === 'O' ? bot.getGameComment('botWin') : bot.getGameComment('draw');
                setTimeout(() => {
                  sendTo(clientId, serverMsg.message(comment, new Date().toISOString()));
                }, 400);
              } else if (Math.random() < 0.35) {
                const moveComment = bot.getGameComment('move');
                sendTo(clientId, serverMsg.message(moveComment, new Date().toISOString()));
              }
            }
          }
        }, 750);
      }
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    const result = roomManager.makeGameMove(roomId, clientId, payload.index);
    if (!result.ok) {
      sendTo(clientId, serverMsg.error('GAME_INVALID_MOVE', result.error));
      return;
    }

    const msg = serverMsg.gameState({
      action: 'update',
      game: result.game,
    });

    sendTo(clientId, msg);
    sendTo(partnerId, msg);
  },

  // ── game_reset (chơi lại ván mới) ─────────────────────
  [CLIENT_TYPES.GAME_RESET](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    if (!roomId) return;

    const requestedSize = (payload && [3, 8, 10].includes(payload.size)) ? payload.size : null;

    if (roomManager.isBotRoom(clientId)) {
      const game = roomManager.resetGame(roomId, requestedSize);
      if (!game) return;
      sendTo(clientId, serverMsg.gameState({ action: 'start', game }));
      setTimeout(() => {
        sendTo(clientId, serverMsg.message('Ván mới bắt đầu rồi! Cố lên bạn nhé, bạn đi trước nha 🌟', new Date().toISOString()));
      }, 300);
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    const game = roomManager.resetGame(roomId, requestedSize);
    if (!game) return;

    const msg = serverMsg.gameState({
      action: 'start',
      game,
    });

    sendTo(clientId, msg);
    sendTo(partnerId, msg);
  },

  // ── game_quit (thoát minigame) ────────────────────────
  [CLIENT_TYPES.GAME_QUIT](clientId) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    if (!roomId) return;

    if (roomManager.isBotRoom(clientId)) {
      roomManager.quitGame(roomId);
      sendTo(clientId, serverMsg.gameState({ action: 'quit', quitterName: 'Bạn' }));
      setTimeout(() => {
        sendTo(clientId, serverMsg.message('Nghỉ tay một chút nhé! Cứ bảo mình nếu bạn muốn chơi tiếp nha 😊', new Date().toISOString()));
      }, 300);
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    roomManager.quitGame(roomId);
    sendTo(partnerId, serverMsg.gameState({
      action: 'quit',
      quitterName: client.nickname,
    }));
  },
};

// ─── Xử lý kết nối WebSocket ──────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  // 1. Giới hạn tổng số kết nối máy chủ
  if (clients.size >= MAX_TOTAL_CONNECTIONS) {
    console.warn(`[Server] Từ chối kết nối: Đạt giới hạn tổng kết nối (${MAX_TOTAL_CONNECTIONS})`);
    ws.close(1013, 'Máy chủ quá tải, vui lòng thử lại sau');
    return;
  }

  // 2. Giới hạn kết nối đồng thời từ một IP
  const currentIpCount = ipConnections.get(clientIp) || 0;
  if (currentIpCount >= MAX_CONNECTIONS_PER_IP) {
    console.warn(`[Server] Từ chối kết nối: IP ${clientIp} đạt giới hạn (${currentIpCount}/${MAX_CONNECTIONS_PER_IP})`);
    ws.close(1008, 'Quá nhiều kết nối từ cùng địa chỉ IP');
    return;
  }
  ipConnections.set(clientIp, currentIpCount + 1);

  const clientId = uuidv4();

  // Lưu thông tin client
  const clientInfo = {
    ws,
    clientId,
    clientIp,
    deviceId: null,
    nickname: null,
    interests: [],
    mood: 'ngau_nhien',
    state: 'CONNECTED',
    isAlive: true,
    connectedAt: Date.now(),
  };
  clients.set(clientId, clientInfo);

  console.log(`[Server] +Connected: ${clientId} from ${clientIp}, totalClients=${clients.size}`);

  if (redisManager.enabled) {
    redisManager.addOnlineClient(clientId)
      .then((onlineCount) => {
        if (clients.has(clientId)) {
          sendTo(clientId, serverMsg.connected(clientId, onlineCount));
        }
      })
      .catch((error) => {
        console.error('[Server] Failed to register online presence:', error.message);
        if (clients.has(clientId)) {
          sendTo(clientId, serverMsg.connected(clientId, clients.size));
        }
      });
  } else {
    sendTo(clientId, serverMsg.connected(clientId, clients.size));
    broadcastOnlineCount();
  }

  // ── Xử lý Pong (heartbeat) ──────────────────────────
  ws.on('pong', () => {
    clientInfo.isAlive = true;
  });

  // ── Xử lý message ───────────────────────────────────
  ws.on('message', (rawData) => {
    const raw = rawData.toString();

    // 1. Parse message
    const parseResult = parseMessage(raw);
    if (!parseResult.ok) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.INVALID_FORMAT, parseResult.error));
      return;
    }

    const { type, payload } = parseResult.msg;

    // 2. Validate payload
    const validateResult = validatePayload(type, payload);
    if (!validateResult.ok) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.INVALID_PAYLOAD, validateResult.error));
      return;
    }

    // 3. Dispatch đến handler tương ứng
    const handler = messageHandlers[type];
    if (handler) {
      if (type === CLIENT_TYPES.MESSAGE) {
        const previous = pendingChatMessages.get(clientId) || Promise.resolve();
        const pending = previous
          .then(() => handler(clientId, validateResult.sanitized))
          .catch((error) => {
            console.error(`[Server] Async message handler failed for ${type} from ${clientId}:`, error);
            sendTo(clientId, serverMsg.error('MESSAGE_PROCESSING_FAILED', 'Không thể xử lý tin nhắn lúc này. Vui lòng thử lại.'));
          });
        pendingChatMessages.set(clientId, pending);
        pending.then(() => {
          if (pendingChatMessages.get(clientId) === pending) pendingChatMessages.delete(clientId);
        });
        return;
      }

      const result = handler(clientId, validateResult.sanitized);
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          console.error(`[Server] Async message handler failed for ${type} from ${clientId}:`, error);
          sendTo(clientId, serverMsg.error('MESSAGE_PROCESSING_FAILED', 'Không thể xử lý tin nhắn lúc này. Vui lòng thử lại.'));
        });
      }
    } else {
      sendTo(clientId, serverMsg.error(ERROR_CODES.INVALID_TYPE, `Không hỗ trợ type "${type}"`));
    }
  });

  // ── Xử lý đóng kết nối ──────────────────────────────
  ws.on('close', (code, reason) => {
    console.log(`[Server] -Disconnected: ${clientInfo.nickname || clientId} (code=${code})`);
    handleDisconnect(clientId);
  });

  // ── Xử lý lỗi ───────────────────────────────────────
  ws.on('error', (err) => {
    console.error(`[Server] Error (${clientId}):`, err.message);
    handleDisconnect(clientId);
  });
});

/**
 * Xử lý khi client ngắt kết nối (close hoặc error).
 * @param {string} clientId
 */
function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  // Xóa client ngay lập tức để tránh xử lý trùng lặp do event close + error
  clients.delete(clientId);

  if (client.soloHintTimer) {
    clearTimeout(client.soloHintTimer);
    client.soloHintTimer = null;
  }

  // Giảm bộ đếm kết nối theo IP
  if (client.clientIp) {
    const ipCount = ipConnections.get(client.clientIp) || 1;
    if (ipCount <= 1) {
      ipConnections.delete(client.clientIp);
    } else {
      ipConnections.set(client.clientIp, ipCount - 1);
    }
  }

  // Nếu đang ở trong hàng đợi → xóa
  matchmaker.dequeue(clientId);

  // Nếu đang trong phòng chat → thông báo đối phương
  const result = roomManager.removeClient(clientId);
  if (result && result.partnerId) {
    notifyRoomLeft(clientId, result.partnerId);
    const partner = clients.get(result.partnerId);
    if (partner) {
      partner.state = 'CONNECTED';
    }
  }

  // Dọn dẹp moderation
  moderation.clearClient(clientId);

  if (redisManager.enabled) {
    redisManager.removeOnlineClient(clientId).catch((error) => {
      console.error('[Server] Failed to remove online presence:', error.message);
    });
  } else {
    broadcastOnlineCount();
  }
}

// ─── Heartbeat (Ping/Pong) ─────────────────────────────────────────────────

/**
 * Gửi Ping định kỳ để phát hiện kết nối "chết".
 * Nếu client không phản hồi Pong sau 1 chu kỳ → đóng kết nối.
 */
const heartbeatTimer = setInterval(() => {
  if (redisManager.enabled) {
    redisManager.refreshOnlineClients([...clients.keys()]).catch((error) => {
      console.error('[Server] Failed to refresh online presence:', error.message);
    });
  }

  for (const [clientId, client] of clients) {
    if (!client.isAlive) {
      console.log(`[Heartbeat] Terminated: ${client.nickname || clientId} (no pong)`);
      client.ws.terminate();
      handleDisconnect(clientId);
      continue;
    }

    client.isAlive = false;
    client.ws.ping(); // Client phản hồi pong → isAlive = true
  }
}, HEARTBEAT_INTERVAL);

const matchRecoveryTimer = setInterval(() => {
  if (!redisManager.enabled || !redisManager.isConnected) return;
  const waitingClientIds = [...clients.values()]
    .filter((client) => client.state === 'WAITING')
    .map((client) => client.clientId);
  if (waitingClientIds.length === 0) return;

  redisManager.getPendingMatches(waitingClientIds)
    .then((pendingMatches) => {
      for (const { match } of pendingMatches) {
        handleMatchFound(match.entry1, match.entry2, match.commonInterests);
      }
    })
    .catch((error) => {
      console.error('[Server] Failed to recover pending Redis matches:', error.message);
    });
}, 1_000);

// ─── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown() {
  console.log('\n[Server] Shutting down...');
  clearInterval(heartbeatTimer);
  clearInterval(matchRecoveryTimer);
  matchmaker.destroy();
  await redisManager.destroy();

  // Đóng tất cả kết nối
  for (const [, client] of clients) {
    client.ws.close(1001, 'Server đang tắt');
  }

  wss.close(() => {
    httpServer.close(() => {
      console.log('[Server] Bye!');
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Khởi động Server ──────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  🚀 WebSocket Chat Server – Nhóm 9');
  console.log(`  📡 HTTP:      http://localhost:${PORT}`);
  console.log(`  🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`  💓 Heartbeat: mỗi ${HEARTBEAT_INTERVAL / 1000}s`);
  console.log('═══════════════════════════════════════════════════');
});
