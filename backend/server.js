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

require('dotenv').config();

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
const RedisManager = require('./redis/redisManager');
const caroStore = require('./redis/caroStore');
const ResumeSessionManager = require('./redis/resumeSession');
const { addViolation, getBanRemaining, instantBan } = require('./redis/violationStore')

const { checkContent, maskProfanity, MODERATION_ACTIONS } = require('./contentFilter');
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
const ROOM_RECONNECT_TIMEOUT = 30_000; //giu phong 30s khi mat ket noi
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const attachmentStorage = createAttachmentStorage();
const pendingAttachmentCompletions = new Set();
const completedAttachmentTickets = new Map();
const configuredMaxConcurrentAttachmentUploads = Number(process.env.MAX_CONCURRENT_ATTACHMENT_UPLOADS);
const MAX_CONCURRENT_ATTACHMENT_UPLOADS = Number.isSafeInteger(configuredMaxConcurrentAttachmentUploads)
  && configuredMaxConcurrentAttachmentUploads > 0
  ? configuredMaxConcurrentAttachmentUploads
  : 4;
const MAX_LIFETIME_UPLOAD_BYTES = 500_000_000;
const MAX_CONVERSATION_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_UPLOAD_FILES = 5;
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
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
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

async function handleAttachmentUploadRequest(req, res, uploadId) {
  const authorization = req.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/u.exec(authorization);
  if (!match) {
    req.resume();
    writeJsonResponse(res, 401, { error: 'Mã tải tệp không hợp lệ.' });
    return;
  }

  let claims;
  try {
    claims = attachmentStorage.validateTicket(match[1], uploadId);
  } catch (error) {
    req.resume();
    const statusCode = error instanceof AttachmentError ? error.statusCode : 500;
    writeJsonResponse(res, statusCode, {
      error: error instanceof AttachmentError ? error.message : 'Không thể xác thực quyền tải tệp.',
    });
    return;
  }
  const declaredLength = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== claims.size) {
    req.resume();
    writeJsonResponse(res, 400, { error: 'Kích thước tải lên không khớp với ticket.' });
    return;
  }
  if (activeAttachmentUploads >= MAX_CONCURRENT_ATTACHMENT_UPLOADS) {
    req.resume();
    writeJsonResponse(res, 503, { error: 'Máy chủ đang xử lý nhiều tệp. Vui lòng thử lại sau.' });
    return;
  }

  const roomId = roomManager.getRoomId(claims.clientId);
  if (!roomId || roomManager.getPartnerId(claims.clientId) !== claims.partnerId) {
    req.resume();
    writeJsonResponse(res, 409, { error: 'Phòng chat đã kết thúc; không thể tải tệp lên.' });
    return;
  }
  const conversationId = [claims.clientId, claims.partnerId].sort().join(':');
  if (claims.conversationId !== conversationId) {
    req.resume();
    writeJsonResponse(res, 401, { error: 'Ticket tải tệp không thuộc phòng chat này.' });
    return;
  }
  if (!redisManager.enabled || !redisManager.isConnected) {
    req.resume();
    writeJsonResponse(res, 503, { error: 'Hệ thống hạn mức tải tệp tạm thời không khả dụng.' });
    return;
  }

  try {
    const quota = await redisManager.reserveAttachmentUpload({
      uploadId,
      conversationId,
      size: claims.size,
      globalLimitBytes: MAX_LIFETIME_UPLOAD_BYTES,
      conversationLimitBytes: MAX_CONVERSATION_UPLOAD_BYTES,
      conversationFileLimit: MAX_CONVERSATION_UPLOAD_FILES,
    });
    if (!quota.allowed) {
      req.resume();
      const error = quota.reason === 'global_limit'
        ? 'Đã đạt giới hạn tải tệp toàn hệ thống 500 MB; hiện không thể tải thêm.'
        : quota.reason === 'conversation_file_limit'
          ? 'Cuộc trò chuyện đã đạt giới hạn 5 tệp.'
          : 'Cuộc trò chuyện đã đạt giới hạn dung lượng 50 MiB.';
      writeJsonResponse(res, 429, { error });
      return;
    }
  } catch (error) {
    req.resume();
    console.error('[Attachments] Could not reserve upload quota:', error.message);
    writeJsonResponse(res, 503, { error: 'Không thể xác nhận hạn mức tải tệp. Vui lòng thử lại sau.' });
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

// ─── Voice Recording Storage (In-Memory với TTL & Dung lượng tối đa) ──────────
const voiceStorage = new Map();
const MAX_VOICE_STORAGE_ITEMS = 500;
const VOICE_TTL_MS = 60 * 60 * 1000; // 1 giờ
const MAX_VOICE_BYTES = 3 * 1024 * 1024; // 3MB tối đa cho 1 đoạn ghi âm

function pruneVoiceStorage() {
  const now = Date.now();
  for (const [id, item] of voiceStorage.entries()) {
    if (now - item.createdAt > VOICE_TTL_MS) {
      voiceStorage.delete(id);
    }
  }
  while (voiceStorage.size > MAX_VOICE_STORAGE_ITEMS) {
    const oldestKey = voiceStorage.keys().next().value;
    voiceStorage.delete(oldestKey);
  }
}

function handleVoiceUploadRequest(req, res) {
  let bodyLength = 0;
  const chunks = [];
  const contentType = req.headers['content-type'] || 'audio/webm';

  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_VOICE_BYTES) {
      req.destroy();
      writeJsonResponse(res, 413, { error: 'Tệp ghi âm vượt quá giới hạn 3MB.' });
    } else {
      chunks.push(chunk);
    }
  });

  req.on('end', () => {
    if (res.writableEnded) return;
    if (bodyLength === 0) {
      writeJsonResponse(res, 400, { error: 'Dữ liệu âm thanh trống.' });
      return;
    }
    pruneVoiceStorage();
    const voiceId = crypto.randomUUID();
    const buffer = Buffer.concat(chunks);
    voiceStorage.set(voiceId, {
      buffer,
      mimeType: contentType.split(';')[0].trim() || 'audio/webm',
      createdAt: Date.now(),
      size: buffer.length,
    });
    writeJsonResponse(res, 201, {
      ok: true,
      voiceId,
      url: `/api/voice/${voiceId}`,
    });
  });

  req.on('error', () => {
    if (!res.writableEnded) {
      writeJsonResponse(res, 500, { error: 'Lỗi tải lên âm thanh.' });
    }
  });
}

function handleVoiceGetRequest(req, res, voiceId) {
  const item = voiceStorage.get(voiceId);
  if (!item) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Không tìm thấy đoạn ghi âm này.' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': item.mimeType,
    'Content-Length': item.buffer.length,
    'Cache-Control': 'public, max-age=3600',
    'Accept-Ranges': 'bytes',
  });
  res.end(item.buffer);
}

const httpServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const uploadMatch = /^\/api\/attachments\/([0-9a-f-]{36})$/iu.exec(requestUrl.pathname);
  if (req.method === 'POST' && uploadMatch) {
    handleAttachmentUploadRequest(req, res, uploadMatch[1]);
    return;
  }

  // Voice recording endpoints
  const voiceUploadMatch = requestUrl.pathname === '/api/voice/upload' || requestUrl.pathname === '/api/voice';
  if (req.method === 'POST' && voiceUploadMatch) {
    handleVoiceUploadRequest(req, res);
    return;
  }
  const voiceGetMatch = /^\/api\/voice\/([0-9a-f-]{36})$/iu.exec(requestUrl.pathname);
  if (req.method === 'GET' && voiceGetMatch) {
    handleVoiceGetRequest(req, res, voiceGetMatch[1]);
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

const pendingGameActions = new Map();

// Lưu timer chờ kết nối lại theo clientId
const reconnectTimers = new Map();
// clientId cũ -> thông tin phiên trước khi mất kết nối
const disconnectedClients = new Map();

// Chặn hai yêu cầu resume đồng thời cho cùng một phiên
const resumingClients = new Set();

// ─── Khởi tạo modules ─────────────────────────────────────────────────────

const roomManager = new RoomManager();
const moderation = new Moderation();

const resumeSessionManager = new ResumeSessionManager();

const redisManager = new RedisManager({
  onDirectMessage: (targetClientId, msgString) => {
    // Nhận message từ một server node khác qua Redis Pub/Sub và chuyển tiếp cho WebSocket client tại node này
    const client = clients.get(targetClientId);
    if (client && client.ws.readyState === 1) {
      client.ws.send(msgString);
    }
  },
  onMatchEvent: ({ roomId, entry1, entry2, commonInterests }) => {
    handleMatchFound(entry1, entry2, commonInterests, roomId);
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

  const roomId = roomManager.getRoomId(partnerId);

  cleanupCaroGame(roomId);
  cleanupResumeSession(partnerId);

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

function handleMatchFound(entry1, entry2, commonInterests, sharedRoomId = null) {
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
  const roomId = roomManager.createRoom(
    entry1.clientId,
    entry2.clientId,
    false,
    null,
    sharedRoomId
  );

  // Cấp Resume Token riêng cho từng người trong phòng
  const token1 = client1
    ? resumeSessionManager.createSession(entry1.clientId, roomId)
    : null;

  const token2 = client2
    ? resumeSessionManager.createSession(entry2.clientId, roomId)
    : null;

  if (client1 && token1) {
    sendTo(entry1.clientId, JSON.stringify({
      type: 'resume_token',
      payload: { token: token1 }
    }));
  }

  if (client2 && token2) {
    sendTo(entry2.clientId, JSON.stringify({
      type: 'resume_token',
      payload: { token: token2 }
    }));
  }

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

  console.log('[MATCH ROOM DEBUG]', {
    pid: process.pid,
    roomId,
    client1: entry1.clientId,
    client2: entry2.clientId
  });

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


async function ensureNotRedisBanned(clientId) {
  const client = clients.get(clientId);
  if (!client) return false;

  if (!client.deviceId) {
    sendTo(clientId, serverMsg.error(
      'DEVICE_ID_REQUIRED',
      'Không thể xác định thiết bị để kiểm tra vi phạm.'
    ));
    return false;
  }

  // Giới hạn thời gian chờ Redis là 2 giây
  let timeoutId;

  try {
    const remainingBan = await Promise.race([
      getBanRemaining(client.deviceId),

      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('REDIS_TIMEOUT'));
        }, 2000);
      })
    ]);

    // Kiểm tra kết nối còn tồn tại sau khi chờ Redis
    if (clients.get(clientId) !== client) {
      return false;
    }

    if (remainingBan > 0) {
      sendTo(clientId, serverMsg.error(
        ERROR_CODES.BANNED,
        `Bạn đang bị cấm trong ${remainingBan} giây nữa.`
      ));
      return false;
    }

    return true;

  } catch (error) {
    console.error(
      '[Redis Ban] Không thể kiểm tra trạng thái ban:',
      error.message
    );

    // Fail-Closed: Redis lỗi thì không cho tương tác với người thật
    if (clients.get(clientId) === client) {
      sendTo(clientId, serverMsg.error(
        'REDIS_UNAVAILABLE',
        'Hệ thống kiểm tra an toàn đang tạm gián đoạn. Vui lòng thử lại sau.'
      ));
    }

    return false;

  } finally {
    clearTimeout(timeoutId);
  }
}




async function canPerformGameAction(clientId) {
  const client = clients.get(clientId);

  if (!client || client.state !== 'CHATTING') {
    return false;
  }

  // Phòng Lumi được phép chơi dù đang bị ban
  if (roomManager.isBotRoom(clientId)) {
    return true;
  }

  // Ghi nhớ người đang chơi cùng trước khi gọi Redis
  const partnerId = roomManager.getPartnerId(clientId);
  if (!partnerId) return false;

  // Phòng người thật phải kiểm tra Redis Ban
  if (!(await ensureNotRedisBanned(clientId))) {
    return false;
  }

  // Chống tình trạng đổi phòng trong khi chờ Redis
  return (
    clients.get(clientId) === client &&
    client.state === 'CHATTING' &&
    !roomManager.isBotRoom(clientId) &&
    roomManager.getPartnerId(clientId) === partnerId
  );
}


async function handleResumeSession(temporaryId, payload) {
  const temporaryClient = clients.get(temporaryId);

  if (!temporaryClient || temporaryClient.state !== 'CONNECTED') {
    return;
  }

  const ws = temporaryClient.ws;

  const rejectResume = (message) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'resume_failed',
        payload: { message }
      }));
    }
  };

  // 1. Kiểm tra token
  const session = resumeSessionManager.validateResumeToken(
    payload.token
  );

  if (!session) {
    rejectResume('Phiên khôi phục không hợp lệ hoặc đã hết hạn.');
    return;
  }

  const oldId = session.clientId;
  const roomId = session.roomId;

  // 2. Không cho hai kết nối cùng khôi phục một phiên
  if (resumingClients.has(oldId)) {
    rejectResume('Phiên này đang được khôi phục.');
    return;
  }

  resumingClients.add(oldId);

  try {
    // 3. Kiểm tra phòng và trạng thái kết nối cũ
    const oldClient = disconnectedClients.get(oldId);

    if (
      !oldClient ||
      clients.has(oldId) ||
      roomManager.getRoomId(oldId) !== roomId ||
      !roomManager.isDisconnected(oldId)
    ) {
      rejectResume('Không tìm thấy phòng chat cần khôi phục.');
      return;
    }

    if (!oldClient.deviceId) {
      rejectResume('Không thể xác thực thiết bị của phiên cũ.');
      return;
    }

    // 4. Kiểm tra Redis Ban, giới hạn chờ 2 giây
    let timeoutId;

    let remainingBan;

    try {
      remainingBan = await Promise.race([
        getBanRemaining(oldClient.deviceId),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('REDIS_TIMEOUT'));
          }, 2000);
        })
      ]);
    } catch (error) {
      console.error('[Resume] Redis Ban:', error.message);
      rejectResume('Hệ thống an toàn đang gián đoạn.');
      return;
    } finally {
      clearTimeout(timeoutId);
    }

    if (remainingBan > 0) {
      rejectResume(
        `Bạn đang bị cấm trong ${remainingBan} giây nữa.`
      );
      return;
    }

    // 5. Kiểm tra lại sau khi chờ Redis
    if (
      clients.get(temporaryId) !== temporaryClient ||
      temporaryClient.ws !== ws ||
      ws.readyState !== 1 ||
      clients.has(oldId) ||
      disconnectedClients.get(oldId) !== oldClient ||
      roomManager.getRoomId(oldId) !== roomId ||
      !roomManager.isDisconnected(oldId) ||
      !resumeSessionManager.validateResumeToken(payload.token)
    ) {
      rejectResume('Phiên khôi phục đã hết hạn hoặc thay đổi.');
      return;
    }

    const room = roomManager.getRoom(roomId);
    if (!room || room.isBotRoom) {
      rejectResume('Phòng chat không còn tồn tại.');
      return;
    }

    // Đồng bộ trạng thái Caro mới nhất trước khi khôi phục phiên
    let resumeGame = room.game ?? null;

    if (redisManager.enabled) {
      try {
        resumeGame = await caroStore.getGame(redisManager, roomId);

        console.log('[CARO RESUME SYNC]', {
          pid: process.pid,
          roomId,
          gameExists: !!resumeGame,
          turn: resumeGame?.turn ?? null
        });
      } catch (error) {
        console.error('[CARO RESUME ERROR]', error.message);

        rejectResume(
          'Không thể đồng bộ ván Caro. Vui lòng thử kết nối lại.'
        );
        return;
      }
    }

    // Kiểm tra lại phiên sau khi chờ Redis
    if (
      clients.get(temporaryId) !== temporaryClient ||
      temporaryClient.ws !== ws ||
      ws.readyState !== 1 ||
      clients.has(oldId) ||
      disconnectedClients.get(oldId) !== oldClient ||
      roomManager.getRoomId(oldId) !== roomId ||
      roomManager.getRoom(roomId) !== room ||
      !roomManager.isDisconnected(oldId) ||
      !resumeSessionManager.validateResumeToken(payload.token)
    ) {
      rejectResume('Phiên khôi phục đã hết hạn hoặc thay đổi.');
      return;
    }

    // Chỉ cập nhật RAM sau khi xác nhận phiên còn hợp lệ
    if (redisManager.enabled) {
      room.game = resumeGame;
    }

    // 6. Gắn WebSocket mới vào clientId cũ
    clients.delete(temporaryId);

    Object.assign(temporaryClient, {
      clientId: oldId,
      deviceId: oldClient.deviceId,
      nickname: oldClient.nickname,
      interests: [...oldClient.interests],
      mood: oldClient.mood,
      warningCount: oldClient.warningCount || 0,
      state: 'CHATTING',
      isAlive: true
    });

    clients.set(oldId, temporaryClient);

    // 7. Hủy thời gian chờ và xóa trạng thái offline
    const timer = reconnectTimers.get(oldId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(oldId);
    }

    roomManager.clearDisconnected(oldId);
    disconnectedClients.delete(oldId);

    // 8. Hủy token cũ, cấp token mới
    const newToken = resumeSessionManager.createSession(
      oldId,
      roomId
    );

    const partnerId = roomManager.getPartnerId(oldId);

    // 9. Thông báo khôi phục thành công
    ws.send(JSON.stringify({
      type: 'resume_success',
      payload: {
        clientId: oldId,
        roomId,
        partnerDisconnected: partnerId
          ? roomManager.isDisconnected(partnerId)
          : false,
        game: resumeGame
      }
    }));

    ws.send(JSON.stringify({
      type: 'resume_token',
      payload: { token: newToken }
    }));

    // 10. Đồng bộ online presence trong Redis
    if (redisManager.enabled) {
      try {
        await redisManager.removeOnlineClient(temporaryId);
        await redisManager.addOnlineClient(oldId);
      } catch (error) {
        console.error(
          '[Resume] Không thể đồng bộ online presence:',
          error.message
        );
      }
    }

    console.log(
      `[Resume] Khôi phục thành công ${oldId} vào phòng ${roomId}`
    );

  } finally {
    resumingClients.delete(oldId);
  }
}



const messageHandlers = {

  [CLIENT_TYPES.RESUME_SESSION](clientId, payload) {
    return handleResumeSession(clientId, payload);
  },
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
    client.warningCount = client.warningCount || 0; // đếm số lần cảnh cáo vi phạm
    console.log(`[Server] Join: ${payload.nickname} (${clientId}), deviceId=${client.deviceId}, mood=${client.mood}, interests=[${payload.interests.join(', ')}]`);
  },

  // ── find_match ────────────────────────────────────────
  async [CLIENT_TYPES.FIND_MATCH](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    // kiem tra ban redis
    if (!(await ensureNotRedisBanned(clientId))) {
      return;
    }

    // Trong khi chờ Redis, kết nối có thể đã ngắt
    // hoặc trạng thái người dùng đã thay đổi
    if (clients.get(clientId) !== client) {
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

    if (redisManager.enabled) {
      try {
        await redisManager.addOnlineClient(clientId);
      } catch (error) {
        console.error(`[Matchmaker] Could not register online presence for ${clientId}:`, error.message);
        sendTo(clientId, serverMsg.error('MATCHMAKING_UNAVAILABLE', 'Hệ thống ghép cặp đang khởi động hoặc tạm thời không khả dụng. Vui lòng thử lại.'));
        return;
      }
      if (clients.get(clientId) !== client) return;
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

    await matchmaker.enqueue(clientId, client.nickname, client.interests, client.mood, client.clientIp, client.deviceId);
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

    // Kiểm tra người dùng có đang trong phòng chat không
    if (client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(
        ERROR_CODES.NOT_IN_ROOM,
        'Bạn chưa ở trong phòng chat'
      ));
      return;
    }

    // Chỉ kiểm tra ban Redis khi chat với người thật
    if (!roomManager.isBotRoom(clientId)) {
      if (!(await ensureNotRedisBanned(clientId))) {
        return;
      }
    }

    if (client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng chat'));
      return;
    }

    // 1. Rate limit
    if (!moderation.checkRateLimit(clientId)) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin quá nhanh, vui lòng chờ'));
      return;
    }


    // Xử lý riêng cho phòng Lumi
    if (roomManager.isBotRoom(clientId)) {
      const filterResult = checkContent(payload.text);

      if (filterResult.isViolation) {
        // Tầng 1: Che từ không phù hợp
        if (filterResult.action === MODERATION_ACTIONS.MASK) {
          payload.text = maskProfanity(payload.text);
        }

        // Tầng 2, 3, 4: Chặn tin nhưng không cộng lỗi Redis
        else {
          sendTo(clientId, serverMsg.error(
            'MESSAGE_BLOCKED',
            'Nội dung không phù hợp. Vui lòng diễn đạt lại.'
          ));
          return;
        }
      }

      const bot = roomManager.getBot(clientId);

      if (bot) {
        bot.handleUserMessage(payload.text);
      }

      return;
    }

    // 2. Kiểm tra bộ lọc nội dung phân tầng 4 cấp độ
    const filterResult = checkContent(payload.text);
    if (filterResult.isViolation) {
      // ════════ TẦNG 1: Tục tĩu nhẹ (PROFANITY) -> Che dấu sao, cho gửi tiếp ════════
      if (filterResult.action === MODERATION_ACTIONS.MASK) {
        payload.text = maskProfanity(payload.text);
      }
      // ════════ TẦNG 2: Kể chuyện nhạy cảm / bạo lực -> Chặn tin, nhắc nhở sửa từ (Không ban) ════════
      else if (filterResult.action === MODERATION_ACTIONS.BLOCK_WARN) {
        sendTo(clientId, serverMsg.error(
          'MESSAGE_BLOCKED',
          `Tin nhắn của bạn chứa từ ngữ nhạy cảm ("${filterResult.matched}"). Vui lòng diễn đạt lại câu chuyện để tiếp tục trò chuyện nhé!`
        ));
        return; // Dừng lại, không gửi cho đối phương
      }
      // ════════ TẦNG 3: Xúc phạm danh dự / Gạ tình 18+ -> Cảnh cáo 3 lần mới ban ════════

      else if (filterResult.action === MODERATION_ACTIONS.STRIKE_BAN) {

        // Bước 1: Ghi nhận vi phạm trong Redis
        let result;

        try {
          result = await addViolation(client.deviceId);
        } catch (error) {
          console.error(
            '[Redis Violation] Không thể ghi nhận vi phạm:',
            error.message
          );

          sendTo(clientId, serverMsg.error(
            'MODERATION_UNAVAILABLE',
            'Hệ thống kiểm duyệt đang gián đoạn. Tin nhắn chưa được gửi.'
          ));

          return;
        }


        // Bước 2: Chưa đủ 3 lần → cảnh cáo
        if (!result.banned) {
          sendTo(clientId, serverMsg.error(
            'VIOLATION_WARNING',
            `Cảnh báo (${result.count}/3): Tin nhắn vi phạm ` +
            `tiêu chuẩn cộng đồng (${filterResult.category}). ` +
            `Đủ 3 lần trong 3 giờ sẽ bị cấm 10 phút!`
          ));

          return;
        }

        // Bước 3: Đã đủ 3 lỗi → Redis đã tạo ban và xóa lỗi
        console.warn(
          `[Server] Redis ban: ${client.nickname} (${clientId})`
        );

        // Thời điểm ban hết hạn, dùng cho phản hồi WebSocket
        const banExpiresAt = Date.now() + result.remainingBan * 1000;

        // Bước 4: Thông báo cho người đang chat cùng
        const partnerId = roomManager.getPartnerId(clientId);

        if (partnerId) {
          notifyRoomLeft(
            clientId,
            partnerId,
            'Đối phương đã bị buộc rời phòng do vi phạm.'
          );

          const partner = clients.get(partnerId);
          if (partner) {
            partner.state = 'CONNECTED';
          }
        }

        // Bước 5: Kick người vi phạm khỏi phòng
        sendTo(
          clientId,
          serverMsg.kicked(
            'Bạn đã bị cấm 10 phút do vi phạm 3 lần.',
            banExpiresAt
          )
        );

        // Thu hồi quyền khôi phục phòng của cả hai
        cleanupResumeSession(clientId);
        cleanupResumeSession(partnerId);

        // Xóa phòng người thật
        roomManager.removeClient(clientId);
        client.state = 'CONNECTED';

        return;
      }

      // ════════ TẦNG 4: Ma túy, Cờ bạc lừa đảo -> Chặn ngay + Ban 10 phút lập tức ════════
      else if (filterResult.action === MODERATION_ACTIONS.INSTANT_BAN) {
        console.warn(`[Server] 🚫 Vi phạm nghiêm trọng: ${client.nickname} (${clientId}) - ${filterResult.reason}`);


        let banResult;

        try {
          banResult = await instantBan(client.deviceId);
        } catch (error) {
          console.error(
            '[Redis Ban] Không thể ghi nhận ban tức thì:',
            error.message
          );

          sendTo(clientId, serverMsg.error(
            'MODERATION_UNAVAILABLE',
            'Hệ thống kiểm duyệt đang gián đoạn. Tin nhắn chưa được gửi.'
          ));

          return;
        }

        const banExpiresAt =
          Date.now() + banResult.remainingBan * 1000;


        const partnerId = roomManager.getPartnerId(clientId);
        if (partnerId) {
          const partner = clients.get(partnerId);
          if (partner) {
            moderation.addPermanentBlock(partner, client);
            partner.state = 'CONNECTED';
          }
          notifyRoomLeft(clientId, partnerId, 'Đối phương đã bị buộc rời khỏi phòng do vi phạm nghiêm trọng tiêu chuẩn an toàn.');
        }
        sendTo(clientId, serverMsg.kicked(filterResult.reason, banExpiresAt));

        // Thu hồi token của cả hai người
        cleanupResumeSession(clientId);
        cleanupResumeSession(partnerId);

        // Xóa phòng
        roomManager.removeClient(clientId);
        client.state = 'CONNECTED';
        return;
      }
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

  async [CLIENT_TYPES.ATTACHMENT_REQUEST](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING' || roomManager.isBotRoom(clientId)) {
      sendTo(clientId, serverMsg.error('ATTACHMENT_NOT_AVAILABLE', 'Chỉ có thể gửi tệp khi đang trò chuyện với người dùng.'));
      return;
    }
    if (!moderation.checkRateLimit(clientId)) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi quá nhanh, vui lòng chờ.'));
      return;
    }

    // Ghi nhớ người đang chat cùng trước khi kiểm tra Redis
    const partnerBeforeCheck = roomManager.getPartnerId(clientId);

    if (!partnerBeforeCheck) return;

    // Kiểm tra Redis Ban
    if (!(await ensureNotRedisBanned(clientId))) {
      return;
    }

    // Kiểm tra lại phòng sau khi await
    if (
      clients.get(clientId) !== client ||
      client.state !== 'CHATTING' ||
      roomManager.getPartnerId(clientId) !== partnerBeforeCheck
    ) {
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;
    if (!redisManager.enabled || !redisManager.isConnected) {
      sendTo(clientId, serverMsg.error(
        'ATTACHMENT_QUOTA_UNAVAILABLE',
        'Hệ thống hạn mức tải tệp đang không khả dụng. Vui lòng thử lại sau.',
      ));
      return;
    }
    try {
      const conversationId = [clientId, partnerId].sort().join(':');
      const ticket = attachmentStorage.issueUploadTicket(
        clientId,
        partnerId,
        payload.fileName,
        payload.size,
        conversationId,
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

    const partnerBeforeCheck = roomManager.getPartnerId(clientId);
    if (!partnerBeforeCheck) return;

    if (!(await ensureNotRedisBanned(clientId))) {
      return;
    }

    if (
      clients.get(clientId) !== client ||
      client.state !== 'CHATTING' ||
      roomManager.getPartnerId(clientId) !== partnerBeforeCheck
    ) {
      return;
    }

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
  async [CLIENT_TYPES.TYPING](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    // Nếu là phòng Bot thì không cần chuyển tiếp
    if (roomManager.isBotRoom(clientId)) return;

    const partnerBeforeCheck = roomManager.getPartnerId(clientId);
    if (!partnerBeforeCheck) return;

    // Chặn gửi trạng thái đang nhập cho người thật nếu bị ban
    if (!(await ensureNotRedisBanned(clientId))) {
      return;
    }

    // Kiểm tra phòng vẫn còn nguyên sau khi chờ Redis
    if (
      clients.get(clientId) !== client ||
      client.state !== 'CHATTING' ||
      roomManager.getPartnerId(clientId) !== partnerBeforeCheck
    ) {
      return;
    }

    sendTo(
      partnerBeforeCheck,
      serverMsg.typing(payload.isTyping)
    );
  },

  // ── voice ─────────────────────────────────────────────
  async [CLIENT_TYPES.VOICE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng chat.'));
      return;
    }
    if (!moderation.checkRateLimit(clientId)) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ.'));
      return;
    }


    // Kiểm tra ban khi gửi voice cho người thật
    if (!roomManager.isBotRoom(clientId)) {
      const partnerBeforeCheck =
        roomManager.getPartnerId(clientId);

      if (!partnerBeforeCheck) return;

      // Kiểm tra trạng thái ban trong Redis
      if (!(await ensureNotRedisBanned(clientId))) {
        return;
      }

      // Kiểm tra lại sau khi await Redis
      if (
        clients.get(clientId) !== client ||
        client.state !== 'CHATTING' ||
        roomManager.isBotRoom(clientId) ||
        roomManager.getPartnerId(clientId) !== partnerBeforeCheck
      ) {
        return;
      }
    }


    const timestamp = new Date().toISOString();

    // Nếu đang ở phòng Bạn Đồng Hành Lumi
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (bot) {
        setTimeout(() => {
          sendTo(clientId, serverMsg.message('Lumi đã nghe tin nhắn thoại của bạn rồi nè! 🎙️ Giọng bạn nghe rất ấm áp và dễ thương đó ✨', new Date().toISOString()));
        }, 1200);
      }
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    sendTo(partnerId, serverMsg.voice({
      voiceId: payload.voiceId,
      url: payload.url,
      duration: payload.duration,
    }, timestamp));
  },

  // ── meme & sticker ────────────────────────────────────
  async [CLIENT_TYPES.MEME](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng chat.'));
      return;
    }
    if (!moderation.checkRateLimit(clientId)) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ.'));
      return;
    }
    // Chỉ kiểm tra ban khi gửi meme/sticker cho người thật
    if (!roomManager.isBotRoom(clientId)) {
      const partnerBeforeCheck =
        roomManager.getPartnerId(clientId);

      if (!partnerBeforeCheck) return;

      if (!(await ensureNotRedisBanned(clientId))) {
        return;
      }

      // Xác nhận phòng chat không thay đổi khi chờ Redis
      if (
        clients.get(clientId) !== client ||
        client.state !== 'CHATTING' ||
        roomManager.isBotRoom(clientId) ||
        roomManager.getPartnerId(clientId) !== partnerBeforeCheck
      ) {
        return;
      }
    }

    const timestamp = new Date().toISOString();
    const isSticker = Boolean(payload.isSticker);

    // Nếu đang ở phòng Bạn Đồng Hành Lumi
    if (roomManager.isBotRoom(clientId)) {
      const memeReplies = isSticker ? [
        'Nhãn dán cưng xỉu luôn á! 🥰✨',
        'Haha nhãn dán Douyin này đỉnh thật sự! 😂',
        'U là trời, biểu cảm chuẩn không cần chỉnh 🤣',
        'Nhãn dán siêu mặn mòi luôn bạn ơi! ✨',
      ] : [
        'Haha meme đỉnh chóp luôn á! 😂',
        'U là trời, meme này chuẩn tâm trạng ghê 🤣',
        'Meme mặn mòi quá bạn ơi! Lưu ngay vào bộ sưu tập ✨',
        'Haha cưng xỉu luôn! 🐱✨',
      ];
      const reply = memeReplies[Math.floor(Math.random() * memeReplies.length)];
      setTimeout(() => {
        sendTo(clientId, serverMsg.message(reply, new Date().toISOString()));
      }, 1000);
      return;
    }

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    sendTo(partnerId, serverMsg.meme({
      url: payload.url,
      title: payload.title,
      memeId: payload.memeId,
      isSticker,
    }, timestamp));
  },

  // ── skip ──────────────────────────────────────────────
  async [CLIENT_TYPES.SKIP](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state !== 'CHATTING') return;

    // Ghi nhớ phòng chat ban đầu
    const roomBeforeCheck = roomManager.getRoomId(clientId);

    if (!roomBeforeCheck) return;

    // SKIP sẽ chuyển người dùng sang tìm người thật
    // Vì vậy phải kiểm tra ban trước khi rời phòng hiện tại
    if (!(await ensureNotRedisBanned(clientId))) {
      return;
    }

    // Sau khi chờ Redis, kiểm tra lại trạng thái

    if (
      clients.get(clientId) !== client ||
      client.state !== 'CHATTING' ||
      roomManager.getRoomId(clientId) !== roomBeforeCheck
    ) {
      return;
    }


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

    const partnerId = roomManager.getPartnerId(clientId);

    cleanupResumeSession(clientId);
    cleanupResumeSession(partnerId);

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

  // ── leave_room (rời phòng quay về trang chủ) ───────────
  [CLIENT_TYPES.LEAVE_ROOM](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state !== 'CHATTING') return;

    // Nếu đang ở phòng Bot Đồng Hành Lumi
    if (roomManager.isBotRoom(clientId)) {
      roomManager.removeClient(clientId);
      client.state = 'CONNECTED';
      console.log(`[Server] Leave Room: ${client.nickname} (${clientId}) rời phòng Bot về trang chủ`);
      return;
    }

    // Lấy thông tin đối phương trước khi xóa phòng
    const partnerId = roomManager.getPartnerId(clientId);

    // Thu hồi token của cả hai người
    cleanupResumeSession(clientId);
    cleanupResumeSession(partnerId);

    // Xóa phòng chat
    const result = roomManager.removeClient(clientId);

    if (result && result.partnerId) {
      notifyRoomLeft(
        clientId,
        result.partnerId,
        'Đối phương đã rời khỏi phòng chat.'
      );

      const partner = clients.get(result.partnerId);

      if (partner) {
        partner.state = 'CONNECTED';
      }
    }

    client.state = 'CONNECTED';
    console.log(`[Server] Leave Room: ${client.nickname} (${clientId}) đã về trang chủ`);
  },

  // ── report ────────────────────────────────────────────
  async [CLIENT_TYPES.REPORT](clientId, payload) {
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

    // Thu hồi token và hủy timer reconnect của cả hai
    cleanupResumeSession(clientId);
    cleanupResumeSession(partnerId);

    // Kết thúc phòng chat
    const result = roomManager.removeClient(clientId);

    if (result && result.partnerId) {
      notifyRoomLeft(clientId, result.partnerId, 'Đối phương đã rời phòng sau báo cáo.');
      if (partner) {
        partner.state = 'CONNECTED';
      }
    }

    // Trước tiên chuyển về trạng thái CONNECTED
    client.state = 'CONNECTED';

    // Kiểm tra ban trước khi tìm người mới
    if (!(await ensureNotRedisBanned(clientId))) {
      return;
    }

    // Tránh đưa kết nối đã đóng hoặc đổi trạng thái vào hàng đợi
    if (
      clients.get(clientId) !== client ||
      client.state !== 'CONNECTED'
    ) {
      return;
    }

    client.state = 'WAITING';
    sendTo(clientId, serverMsg.waiting());

    matchmaker.enqueue(
      clientId,
      client.nickname,
      client.interests,
      client.mood,
      client.clientIp,
      client.deviceId
    );
  },

  // ── icebreaker (câu hỏi phá băng gợi ý mở đầu) ─────────
  async [CLIENT_TYPES.ICEBREAKER](clientId) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;


    // Chỉ kiểm tra Redis Ban khi chat với người thật
    if (!roomManager.isBotRoom(clientId)) {
      const partnerBeforeCheck =
        roomManager.getPartnerId(clientId);

      if (!partnerBeforeCheck) return;

      if (!(await ensureNotRedisBanned(clientId))) {
        return;
      }

      // Kiểm tra phòng không thay đổi khi chờ Redis
      if (
        clients.get(clientId) !== client ||
        client.state !== 'CHATTING' ||
        roomManager.isBotRoom(clientId) ||
        roomManager.getPartnerId(clientId) !== partnerBeforeCheck
      ) {
        return;
      }
    }


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
  async [CLIENT_TYPES.GAME_INVITE](clientId, payload) {
    if (!(await canPerformGameAction(clientId))) return;

    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const requestedSize = (payload && [10, 15, 20].includes(payload.size)) ? payload.size : 10;

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

    sendTo(clientId, serverMsg.gameState({
      action: 'invite_sent',
      size: requestedSize,
    }));
  },

  // ── game_accept (nhận lời chơi minigame) ──────────────
  async [CLIENT_TYPES.GAME_ACCEPT](clientId, payload) {
    if (!(await canPerformGameAction(clientId))) return;

    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    const partnerId = roomManager.getPartnerId(clientId);
    if (!roomId || !partnerId) return;

    const requestedSize = (payload && [10, 15, 20].includes(payload.size)) ? payload.size : 10;

      // ✅ THÊM LOG NGAY TẠI ĐÂY
  console.log('[CARO ACCEPT]', {
    pid: process.pid,
    roomId,
    clientId,
    gameExists: !!roomManager.getRoom(roomId)?.game
  });

    let game;

    try {
      if (redisManager.enabled) {
        // Tạo game chung trong Redis
        game = await caroStore.createGame(
          redisManager,
          roomId,
          partnerId, // Người mời: X
          clientId,  // Người chấp nhận: O
          requestedSize
        );

        // Giữ trạng thái local cho các chức năng hiện có
        const room = roomManager.getRoom(roomId);
        if (room) {
          room.game = game;
        }

        console.log('[CARO REDIS CREATE]', {
          pid: process.pid,
          roomId,
          created: true,
          turn: game.turn
        });

      } else {
        // Không dùng Redis: giữ nguyên logic cũ
        game = roomManager.initGame(
          roomId,
          partnerId,
          clientId,
          requestedSize
        );
      }

      if (!game) {
        throw new Error('Không thể khởi tạo ván Caro');
      }

      const msg = serverMsg.gameState({
        action: 'start',
        game
      });

      sendTo(clientId, msg);
      sendTo(partnerId, msg);

    } catch (error) {
      console.error('[CARO CREATE ERROR]', error.message);

      sendTo(
        clientId,
        serverMsg.error(
          'GAME_CREATE_FAILED',
          'Không thể bắt đầu ván Caro. Vui lòng thử lại.'
        )
      );
    }
  },

  // ── game_move (nước đi minigame) ──────────────────────
  async [CLIENT_TYPES.GAME_MOVE](clientId, payload) {
    if (!(await canPerformGameAction(clientId))) return;

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

    console.log('[CARO MOVE]', {
  pid: process.pid,
  roomId,
  clientId,
  gameExists: !!roomManager.getRoom(roomId)?.game
});

    const partnerId = roomManager.getPartnerId(clientId);
    if (!partnerId) return;

    let result;

    if (redisManager.enabled) {
      result = await caroStore.makeMove(
        redisManager,
        roomId,
        clientId,
        payload.index
      );

      console.log('[CARO REDIS MOVE]', {
        pid: process.pid,
        roomId,
        clientId,
        index: payload.index,
        success: result.ok,
        nextTurn: result.game?.turn
      });
    } else {
      result = roomManager.makeGameMove(
        roomId,
        clientId,
        payload.index
      );
    }
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
  async [CLIENT_TYPES.GAME_RESET](clientId, payload) {
    if (!(await canPerformGameAction(clientId))) return;

    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    if (!roomId) return;

    const requestedSize = (payload && [10, 15, 20].includes(payload.size)) ? payload.size : null;

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

    let game;

    try {
      if (redisManager.enabled) {
        const result = await caroStore.resetGame(
          redisManager,
          roomId,
          requestedSize
        );

        if (!result.ok) {
          sendTo(
            clientId,
            serverMsg.error('GAME_RESET_FAILED', result.error)
          );
          return;
        }

        game = result.game;

        // Cập nhật bản local để hỗ trợ các chức năng hiện tại
        const room = roomManager.getRoom(roomId);
        if (room) {
          room.game = game;
        }
      } else {
        game = roomManager.resetGame(roomId, requestedSize);
      }

      if (!game) return;

      // Không gửi sự kiện vào phòng mới nếu client đã rời phòng
      if (
        roomManager.getRoomId(clientId) !== roomId ||
        roomManager.getPartnerId(clientId) !== partnerId
      ) {
        return;
      }

      const msg = serverMsg.gameState({
        action: 'start',
        game
      });

      sendTo(clientId, msg);
      sendTo(partnerId, msg);

      console.log('[CARO RESET]', {
        pid: process.pid,
        roomId,
        nextTurn: game.turn
      });

    } catch (error) {
      console.error('[CARO RESET ERROR]', error.message);

      sendTo(
        clientId,
        serverMsg.error(
          'GAME_RESET_FAILED',
          'Không thể tạo ván mới. Vui lòng thử lại.'
        )
      );
    }
  },

  // ── game_quit (thoát minigame) ────────────────────────
  async [CLIENT_TYPES.GAME_QUIT](clientId) {
    if (!(await canPerformGameAction(clientId))) return;

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

    try {
      if (redisManager.enabled) {
        // Xóa bàn cờ trên Redis trước khi thông báo
        await caroStore.quitGame(redisManager, roomId);
      }

      // Dọn bản local
      roomManager.quitGame(roomId);

      if (
        roomManager.getRoomId(clientId) !== roomId ||
        roomManager.getPartnerId(clientId) !== partnerId
      ) {
        return;
      }

      sendTo(partnerId, serverMsg.gameState({
        action: 'quit',
        quitterName: client.nickname
      }));

      console.log('[CARO QUIT]', {
        pid: process.pid,
        roomId,
        clientId
      });

    } catch (error) {
      console.error('[CARO QUIT ERROR]', error.message);

      sendTo(
        clientId,
        serverMsg.error(
          'GAME_QUIT_FAILED',
          'Không thể thoát ván cờ lúc này.'
        )
      );
    }
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
    // clientId có thể thay đổi sau khi resume
    const clientId = clientInfo.clientId;

    // Chỉ WebSocket sở hữu phiên mới được gửi message
    if (
      clients.get(clientId) !== clientInfo ||
      clientInfo.ws !== ws
    ) {
      return;
    }

    const raw = rawData.toString();

    // Chặn WebSocket cũ hoặc kết nối không còn sở hữu phiên
    if (
      clients.get(clientInfo.clientId) !== clientInfo ||
      clientInfo.ws !== ws
    ) {
      return;
    }

    const activeClientId = clientInfo.clientId;

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

      // Các hành động Caro cần xử lý theo thứ tự của từng client
      const gameActions = new Set([
        CLIENT_TYPES.GAME_INVITE,
        CLIENT_TYPES.GAME_ACCEPT,
        CLIENT_TYPES.GAME_MOVE,
        CLIENT_TYPES.GAME_RESET,
        CLIENT_TYPES.GAME_QUIT
      ]);

      if (gameActions.has(type)) {
        const previous =
          pendingGameActions.get(clientId) || Promise.resolve();

        const pending = previous
          .then(() => handler(clientId, validateResult.sanitized))
          .catch((error) => {
            console.error(
              `[Game] Failed to process ${type} from ${clientId}:`,
              error
            );

            sendTo(
              clientId,
              serverMsg.error(
                'GAME_PROCESSING_FAILED',
                'Không thể xử lý thao tác Caro lúc này.'
              )
            );
          });

        pendingGameActions.set(clientId, pending);

        pending.then(() => {
          if (pendingGameActions.get(clientId) === pending) {
            pendingGameActions.delete(clientId);
          }
        });

        return;
      }

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
  ws.on('close', (code) => {
    const currentId = clientInfo.clientId;
    console.log(
      `[Server] -Disconnected: ${clientInfo.nickname || currentId} (code=${code})`
    );
    handleDisconnect(currentId, ws);
  });

  // ── Xử lý lỗi ───────────────────────────────────────
  ws.on('error', (err) => {
    console.error(
      `[Server] Error (${clientInfo.clientId}):`,
      err.message
    );

    handleDisconnect(clientInfo.clientId, ws);
  });
});

function cleanupCaroGame(roomId) {
  if (!roomId || !redisManager.enabled) return;

  caroStore.quitGame(redisManager, roomId)
    .catch((error) => {
      console.error(
        `[CARO CLEANUP ERROR] room=${roomId}:`,
        error.message
      );
    });
}

function cleanupResumeSession(clientId) {
  if (!clientId) return;

  // 1. Thu hồi Resume Token
  resumeSessionManager.revokeSession(clientId);

  // 2. Hủy timer giữ phòng
  const timer = reconnectTimers.get(clientId);

  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(clientId);
  }

  // 3. Xóa thông tin phiên offline
  disconnectedClients.delete(clientId);

  // 4. Xóa trạng thái đang khôi phục
  resumingClients.delete(clientId);
}


// ham giu phong
function holdRoomForReconnect(clientId) {
  // Đánh dấu người dùng mất kết nối trong RoomManager
  const disconnected = roomManager.markDisconnected(clientId);

  if (!disconnected) {
    return false;
  }

  // Token bắt đầu có hạn khôi phục 30 giây
  const marked = resumeSessionManager.markDisconnected(
    clientId,
    ROOM_RECONNECT_TIMEOUT
  );

  if (!marked) {
    console.warn(
      `[Resume] Không tìm thấy phiên khôi phục của ${clientId}`
    );
  }

  const { roomId, partnerId } = disconnected;

  // Tránh tạo nhiều timer cho cùng một client
  if (reconnectTimers.has(clientId)) {
    return true;
  }

  console.log(
    `[Reconnect] Giữ phòng ${roomId} cho ${clientId} trong 30 giây`
  );

  const timer = setTimeout(() => {
    reconnectTimers.delete(clientId);

    // Kiểm tra phòng còn tồn tại và đúng phòng ban đầu
    if (roomManager.getRoomId(clientId) !== roomId) {
      return;
    }

    // Nếu đã khôi phục kết nối, không xóa phòng
    if (!roomManager.isDisconnected(clientId)) {
      return;
    }

    console.log(
      `[Reconnect] Hết 30 giây, đóng phòng ${roomId}`
    );

    // Thu hồi token và thông tin phiên đã hết hạn
    cleanupResumeSession(clientId);

    // Phòng thực sự hết thời gian khôi phục
    cleanupCaroGame(roomId);

    const result = roomManager.removeClient(clientId);

    if (result && result.partnerId) {

      // Phòng không còn tồn tại nên đối phương cũng không thể resume
      disconnectedClients.delete(result.partnerId);
      resumeSessionManager.revokeSession(result.partnerId);

      // Dọn timer nếu cả hai người đều đang offline
      const partnerTimer = reconnectTimers.get(result.partnerId);

      if (partnerTimer) {
        clearTimeout(partnerTimer);
        reconnectTimers.delete(result.partnerId);
      }

      const partner = clients.get(result.partnerId);

      if (partner) {
        partner.state = 'CONNECTED';
      }

      notifyRoomLeft(
        clientId,
        result.partnerId,
        'Đối phương mất kết nối quá 30 giây.'
      );
    }
  }, ROOM_RECONNECT_TIMEOUT);

  reconnectTimers.set(clientId, timer);

  return true;
}


/**
 * Xử lý khi client ngắt kết nối (close hoặc error).
 * @param {string} clientId
 */
function handleDisconnect(clientId, disconnectedWs = null) {
  const client = clients.get(clientId);
  if (!client) return;

  // Không cho WebSocket cũ xóa phiên đã được khôi phục
  if (disconnectedWs && client.ws !== disconnectedWs) {
    return;
  }

  // Xóa client ngay lập tức để tránh xử lý trùng lặp do event close + error
  clients.delete(clientId);

  pendingGameActions.delete(clientId);

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


  // Nếu đang chat với người thật thì giữ phòng 30 giây
  const roomId = roomManager.getRoomId(clientId);

  const shouldHoldRoom =
    roomId &&
    client.state === 'CHATTING' &&
    !roomManager.isBotRoom(clientId);

  if (shouldHoldRoom) {
    // Giữ thông tin client cũ để khôi phục sau này
    disconnectedClients.set(clientId, client);

    if (!holdRoomForReconnect(clientId)) {
      disconnectedClients.delete(clientId);
    }
  } else {
    // Phòng Lumi hoặc trường hợp khác: dọn như cũ
    // Hủy token của người đã hết thời hạn
    resumeSessionManager.revokeSession(clientId);

    const result = roomManager.removeClient(clientId);

    if (result && result.partnerId) {
      notifyRoomLeft(clientId, result.partnerId);

      const partner = clients.get(result.partnerId);

      if (partner) {
        partner.state = 'CONNECTED';
      }
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
      handleDisconnect(clientId, client.ws);
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
        handleMatchFound(match.entry1, match.entry2, match.commonInterests, match.roomId);
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
