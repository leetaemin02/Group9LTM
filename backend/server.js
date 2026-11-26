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

try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const fs = require('fs');
const path = require('path');

// Tự động nạp file .env nếu có (Node.js 20+ native, không cài package ngoài)
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}
}
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto'); 

const {
  CLIENT_TYPES,
  ERROR_CODES,
  parseMessage,
  validatePayload,
  createMessage,
  serverMsg,
} = require('./protocol');
const Matchmaker = require('./matchmaker');
const RoomManager = require('./roomManager');
const {
  GroupManager,
  DEFAULT_MAX_GROUP_MEMBERS,
  MIN_KEEP_VOTES,
} = require('./groupManager');
const {
  GameRoomManager,
  GAME_CATALOG,
  MAX_GAME_ROOM_PLAYERS,
} = require('./gameRoomManager');
const {
  ConnectionManager,
  MAX_PAIR_HISTORY,
} = require('./connectionManager');
const { findWordChainReply } = require('./gameData');
const { stripVietnameseTones } = require('./nicknameResolver');
const Moderation = require('./moderation');
const RedisManager = require('./redis/redisManager');
const caroStore = require('./redis/caroStore');
const ResumeSessionManager = require('./redis/resumeSession');
const { addViolation, getBanRemaining, instantBan } = require('./redis/violationStore')

const { checkContent, maskProfanity, MODERATION_ACTIONS } = require('./contentFilter');
const { analyzeLinkSafety } = require('./linkSafety');
const { checkMessageLinks } = require('./safeBrowsing');
const {
  AttachmentError,
  createAttachmentStorage,
  createLocalAttachmentStorage,
} = require('./attachmentStorage');
const { getRandomIcebreaker } = require('./icebreakers');
const { CompanionBot } = require('./companionBot');
const groqChat = require('./groqChat');
const {
  getClientIp,
  isAllowedWsOrigin,
  resolveSafeStaticPath,
  getSecurityHeaders,
  normalizeVoiceMime,
  isValidAudioMagicBytes,
  SlidingWindowLimiter,
} = require('./security');


// ─── Cấu hình ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const HEARTBEAT_INTERVAL = 30_000; // 30 giây
const ROOM_RECONNECT_TIMEOUT = 30_000; //giu phong 30s khi mat ket noi
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// Cấu hình bảo mật (chống IP spoofing, DoS tạo phòng, flood frame)
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const TRUST_PROXY_HOPS = Math.max(1, Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 1);
const MAX_ACTIVE_GROUPS = Math.max(10, Number.parseInt(process.env.MAX_ACTIVE_GROUPS || '500', 10) || 500);
const MAX_ACTIVE_GAME_ROOMS = Math.max(10, Number.parseInt(process.env.MAX_ACTIVE_GAME_ROOMS || '300', 10) || 300);
const MAX_PENDING_CHAT_PER_CLIENT = 10;
const VOICE_UPLOAD_TIMEOUT_MS = 15_000;

const wsFrameLimiter = new SlidingWindowLimiter({ maxRequests: 60, windowMs: 5_000, maxKeys: 5_000 });
const resourceCreateLimiter = new SlidingWindowLimiter({ maxRequests: 10, windowMs: 60_000, maxKeys: 5_000 });
const voiceUploadLimiter = new SlidingWindowLimiter({ maxRequests: 12, windowMs: 60_000, maxKeys: 5_000 });
const pairCodeIpLimiter = new SlidingWindowLimiter({ maxRequests: 15, windowMs: 60_000, maxKeys: 5_000 });

function isHttpsRequest(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  return false;
}
const azureAttachmentStorage = createAttachmentStorage();
const attachmentStorage = azureAttachmentStorage.enabled
  ? azureAttachmentStorage
  : createLocalAttachmentStorage();
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

// Bộ đếm hạn mức upload cục bộ (chỉ dùng khi USE_REDIS=false ở chế độ 1 instance)
const localUploadQuotaState = {
  globalBytes: 0,
  conversations: new Map(), // conversationId -> { bytes: number, files: Set<string> }
  reservations: new Set(),  // uploadId đã dự trữ (idempotent)
};

async function reserveAttachmentUploadQuota({ uploadId, conversationId, size }) {
  if (redisManager.enabled) {
    if (!redisManager.isConnected) {
      return { allowed: false, unavailable: true };
    }
    return redisManager.reserveAttachmentUpload({
      uploadId,
      conversationId,
      size,
      globalLimitBytes: MAX_LIFETIME_UPLOAD_BYTES,
      conversationLimitBytes: MAX_CONVERSATION_UPLOAD_BYTES,
      conversationFileLimit: MAX_CONVERSATION_UPLOAD_FILES,
    });
  }

  if (localUploadQuotaState.reservations.has(uploadId)) {
    return { allowed: true, alreadyReserved: true };
  }
  const conv = localUploadQuotaState.conversations.get(conversationId) || { bytes: 0, files: new Set() };
  if (localUploadQuotaState.globalBytes + size > MAX_LIFETIME_UPLOAD_BYTES) {
    return { allowed: false, reason: 'global_limit' };
  }
  if (conv.files.size >= MAX_CONVERSATION_UPLOAD_FILES) {
    return { allowed: false, reason: 'conversation_file_limit' };
  }
  if (conv.bytes + size > MAX_CONVERSATION_UPLOAD_BYTES) {
    return { allowed: false, reason: 'conversation_size_limit' };
  }

  localUploadQuotaState.globalBytes += size;
  conv.bytes += size;
  conv.files.add(uploadId);
  localUploadQuotaState.conversations.set(conversationId, conv);
  localUploadQuotaState.reservations.add(uploadId);
  if (localUploadQuotaState.conversations.size > 2_000) {
    localUploadQuotaState.conversations.delete(localUploadQuotaState.conversations.keys().next().value);
  }
  if (localUploadQuotaState.reservations.size > 10_000) {
    localUploadQuotaState.reservations.delete(localUploadQuotaState.reservations.values().next().value);
  }
  return { allowed: true, alreadyReserved: false };
}

if (attachmentStorage.mode === 'azure') {
  console.info(`[Attachments] Enabled via Azure Blob Storage (${process.env.AZURE_STORAGE_ACCOUNT_NAME}/${process.env.AZURE_STORAGE_CONTAINER_NAME || 'chat-attachments'}, skipMalwareScan=${process.env.SKIP_MALWARE_SCAN === 'true'}).`);
} else {
  console.info('[Attachments] Azure Storage chưa cấu hình; dùng bộ lưu tạm an toàn trong RAM (chế độ cục bộ).');
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

function writeJsonResponse(res, statusCode, payload, req = null) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, {
    ...getSecurityHeaders({ isHtml: false, isHttps: isHttpsRequest(req) }),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function handleAttachmentUploadRequest(req, res, uploadId) {
  // Timeout nhàn rỗi 60s (tự reset khi có dữ liệu) để tải video 50MB không bị ngắt nhưng vẫn chặn Slowloris
  req.setTimeout(60_000, () => {
    if (!res.writableEnded && !res.destroyed) {
      writeJsonResponse(res, 408, { error: 'Hết thời gian chờ tải tệp lên.' }, req);
    }
    req.destroy();
  });

  const authorization = req.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/u.exec(authorization);
  if (!match) {
    req.resume();
    writeJsonResponse(res, 401, { error: 'Mã tải tệp không hợp lệ.' }, req);
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
    }, req);
    return;
  }
  const declaredLength = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== claims.size) {
    req.resume();
    writeJsonResponse(res, 400, { error: 'Kích thước tải lên không khớp với ticket.' }, req);
    return;
  }
  if (activeAttachmentUploads >= MAX_CONCURRENT_ATTACHMENT_UPLOADS) {
    req.resume();
    writeJsonResponse(res, 503, { error: 'Máy chủ đang xử lý nhiều tệp. Vui lòng thử lại sau.' }, req);
    return;
  }

  const roomId = roomManager.getRoomId(claims.clientId);
  if (!roomId || roomManager.getPartnerId(claims.clientId) !== claims.partnerId) {
    req.resume();
    writeJsonResponse(res, 409, { error: 'Phòng chat đã kết thúc; không thể tải tệp lên.' }, req);
    return;
  }
  const conversationId = [claims.clientId, claims.partnerId].sort().join(':');
  if (claims.conversationId !== conversationId) {
    req.resume();
    writeJsonResponse(res, 401, { error: 'Ticket tải tệp không thuộc phòng chat này.' }, req);
    return;
  }
  if (redisManager.enabled && !redisManager.isConnected) {
    req.resume();
    writeJsonResponse(res, 503, { error: 'Hệ thống hạn mức tải tệp tạm thời không khả dụng.' }, req);
    return;
  }

  try {
    const quota = await reserveAttachmentUploadQuota({
      uploadId,
      conversationId,
      size: claims.size,
    });
    if (quota.unavailable) {
      req.resume();
      writeJsonResponse(res, 503, { error: 'Hệ thống hạn mức tải tệp tạm thời không khả dụng.' }, req);
      return;
    }
    if (!quota.allowed) {
      req.resume();
      const error = quota.reason === 'global_limit'
        ? 'Đã đạt giới hạn tải tệp toàn hệ thống 500 MB; hiện không thể tải thêm.'
        : quota.reason === 'conversation_file_limit'
          ? 'Cuộc trò chuyện đã đạt giới hạn 5 tệp.'
          : 'Cuộc trò chuyện đã đạt giới hạn dung lượng 50 MiB.';
      writeJsonResponse(res, 429, { error }, req);
      return;
    }
  } catch (error) {
    req.resume();
    console.error('[Attachments] Could not reserve upload quota:', error.message);
    writeJsonResponse(res, 503, { error: 'Không thể xác nhận hạn mức tải tệp. Vui lòng thử lại sau.' }, req);
    return;
  }

  activeAttachmentUploads += 1;
  attachmentStorage.upload(uploadId, match[1], req)
    .then((result) => writeJsonResponse(res, 201, result, req))
    .catch((error) => {
      if (!req.complete) req.resume();
      const statusCode = error instanceof AttachmentError ? error.statusCode : 500;
      if (statusCode >= 500) {
        console.error('[Attachments] Upload failed:', error.message);
      }
      writeJsonResponse(
        res,
        statusCode,
        { error: statusCode >= 500 ? 'Không thể lưu tệp lúc này. Vui lòng thử lại.' : error.message },
        req,
      );
    })
    .finally(() => {
      activeAttachmentUploads -= 1;
    });
}

function handleLocalAttachmentGetRequest(req, res, uploadId, requestUrl) {
  if (attachmentStorage.mode !== 'local' || typeof attachmentStorage.getFile !== 'function') {
    writeJsonResponse(res, 404, { error: 'Không tìm thấy tệp.' }, req);
    return;
  }
  const exp = requestUrl.searchParams.get('exp');
  const sig = requestUrl.searchParams.get('sig');
  const item = attachmentStorage.getFile(uploadId, exp, sig);
  if (!item) {
    writeJsonResponse(res, 404, { error: 'Liên kết tải tệp không hợp lệ hoặc đã hết hạn.' }, req);
    return;
  }
  res.writeHead(200, {
    ...getSecurityHeaders({ isHtml: false, isHttps: isHttpsRequest(req) }),
    'Content-Type': item.contentType,
    'Content-Length': item.buffer.length,
    'Content-Disposition': item.disposition,
    'Cache-Control': 'private, no-store',
  });
  res.end(item.buffer);
}

// ─── Voice Recording Storage (In-Memory với TTL & Dung lượng tối đa) ──────────
const voiceStorage = new Map();
const MAX_VOICE_STORAGE_ITEMS = 200;
const MAX_VOICE_TOTAL_BYTES = 100 * 1024 * 1024; // Tổng RAM tối đa 100MB cho voice in-memory
const VOICE_TTL_MS = 60 * 60 * 1000; // 1 giờ

const VOICE_REDIS_TTL = 3600;

function voiceKey(voiceId) {
  return `chat:voice:${voiceId}`;
}

async function saveVoiceRedis(voiceId, buffer, mimeType) {
  if (!redisManager.isConnected || !redisManager.pubClient) {
    throw new Error('Redis chưa sẵn sàng');
  }

  const data = Buffer.concat([
    Buffer.from(mimeType + '\n'),
    buffer
  ]);

  await redisManager.pubClient.set(
    voiceKey(voiceId),
    data,
    'EX',
    VOICE_REDIS_TTL
  );
}

async function getVoiceRedis(voiceId) {
  if (!redisManager.isConnected || !redisManager.pubClient) {
    throw new Error('Redis chưa sẵn sàng');
  }

  const data = await redisManager.pubClient.getBuffer(
    voiceKey(voiceId)
  );

  if (!data) return null;

  const separator = data.indexOf(10);

  if (separator < 0) {
    throw new Error('Dữ liệu Voice bị lỗi');
  }

  return {
    mimeType: data.subarray(0, separator).toString(),
    buffer: data.subarray(separator + 1)
  };
}

const MAX_VOICE_BYTES = 3 * 1024 * 1024; // 3MB tối đa cho 1 đoạn ghi âm

function pruneVoiceStorage(incomingBytes = 0) {
  const now = Date.now();
  let totalBytes = 0;
  for (const [id, item] of voiceStorage.entries()) {
    if (now - item.createdAt > VOICE_TTL_MS) {
      voiceStorage.delete(id);
    } else {
      totalBytes += item.size || (item.buffer ? item.buffer.length : 0);
    }
  }
  while (
    voiceStorage.size > 0
    && (voiceStorage.size >= MAX_VOICE_STORAGE_ITEMS || totalBytes + incomingBytes > MAX_VOICE_TOTAL_BYTES)
  ) {
    const oldestKey = voiceStorage.keys().next().value;
    const oldestItem = voiceStorage.get(oldestKey);
    totalBytes -= (oldestItem && (oldestItem.size || (oldestItem.buffer ? oldestItem.buffer.length : 0))) || 0;
    voiceStorage.delete(oldestKey);
  }
}

function handleVoiceUploadRequest(req, res) {
  // 1. Chặn cross-site upload CSRF nếu request có Origin không hợp lệ
  if (req.headers.origin && !isAllowedWsOrigin(req, process.env.ALLOWED_ORIGINS)) {
    req.resume();
    writeJsonResponse(res, 403, { error: 'Origin không được phép tải lên Voice.' }, req);
    return;
  }

  // 2. Giới hạn tần suất tải Voice theo IP thật (chống DoS tràn RAM/Redis)
  const uploaderIp = getClientIp(req, { trustProxy: TRUST_PROXY, trustProxyHops: TRUST_PROXY_HOPS });
  const rateCheck = voiceUploadLimiter.check(uploaderIp);
  if (!rateCheck.allowed) {
    req.resume();
    writeJsonResponse(res, 429, { error: 'Bạn tải lên quá nhiều đoạn ghi âm. Vui lòng thử lại sau 1 phút.' }, req);
    return;
  }

  // 3. Xác thực chặt Content-Type âm thanh cho phép
  const mimeType = normalizeVoiceMime(req.headers['content-type']);
  if (!mimeType) {
    req.resume();
    writeJsonResponse(res, 415, { error: 'Định dạng âm thanh không được hỗ trợ.' }, req);
    return;
  }

  // 4. Từ chối sớm nếu Content-Length vượt quá 3MB
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_BYTES) {
    req.resume();
    writeJsonResponse(res, 413, { error: 'Voice vượt quá giới hạn 3MB.' }, req);
    return;
  }

  let bodyLength = 0;
  let aborted = false;
  const chunks = [];

  // Chống Slowloris upload treo kết nối
  const uploadTimer = setTimeout(() => {
    if (aborted || res.writableEnded || res.destroyed) return;
    aborted = true;
    chunks.length = 0;
    writeJsonResponse(res, 408, { error: 'Hết thời gian tải lên tin nhắn thoại.' }, req);
    req.destroy();
  }, VOICE_UPLOAD_TIMEOUT_MS);

  const clearUploadTimer = () => clearTimeout(uploadTimer);

  req.on('data', (chunk) => {
    if (aborted) return;

    bodyLength += chunk.length;

    if (bodyLength > MAX_VOICE_BYTES) {
      aborted = true;
      clearUploadTimer();
      chunks.length = 0;

      writeJsonResponse(res, 413, {
        error: 'Voice vượt quá giới hạn 3MB.'
      }, req);
      return;
    }

    chunks.push(chunk);
  });

  req.on('end', async () => {
    clearUploadTimer();
    if (aborted || res.writableEnded || res.destroyed) return;

    if (bodyLength === 0) {
      writeJsonResponse(res, 400, {
        error: 'Dữ liệu Voice trống.'
      }, req);
      return;
    }

    const buffer = Buffer.concat(chunks);

    // 5. Xác thực magic bytes nhị phân thực sự (chống upload HTML/JS/exe giả mạo audio)
    if (!isValidAudioMagicBytes(buffer)) {
      writeJsonResponse(res, 415, {
        error: 'Nội dung tệp không khớp định dạng âm thanh hợp lệ.'
      }, req);
      return;
    }

    const voiceId = crypto.randomUUID();

    try {
      if (redisManager.enabled) {
        await saveVoiceRedis(voiceId, buffer, mimeType);
      } else {
        pruneVoiceStorage(buffer.length);

        voiceStorage.set(voiceId, {
          buffer,
          mimeType,
          createdAt: Date.now(),
          size: buffer.length
        });
      }

      console.log('[VOICE UPLOAD]', {
        pid: process.pid,
        voiceId,
        size: buffer.length,
        storage: redisManager.enabled ? 'redis' : 'memory'
      });

      writeJsonResponse(res, 201, {
        ok: true,
        voiceId,
        url: `/api/voice/${voiceId}`
      }, req);
    } catch (error) {
      console.error('[VOICE UPLOAD ERROR]', error.message);

      writeJsonResponse(res, 503, {
        error: 'Không thể lưu Voice.'
      }, req);
    }
  });

  req.on('error', (error) => {
    clearUploadTimer();
    aborted = true;
    chunks.length = 0;
    console.error('[VOICE REQUEST ERROR]', error.message);

    writeJsonResponse(res, 500, {
      error: 'Lỗi tải Voice.'
    }, req);
  });
}

async function handleVoiceGetRequest(req, res, voiceId) {
  try {
    const item = redisManager.enabled
      ? await getVoiceRedis(voiceId)
      : voiceStorage.get(voiceId);

    if (!item) {
      writeJsonResponse(res, 404, {
        error: 'Không tìm thấy Voice.'
      }, req);
      return;
    }

    console.log('[VOICE GET]', {
      pid: process.pid,
      voiceId,
      storage: redisManager.enabled ? 'redis' : 'memory'
    });

    res.writeHead(200, {
      ...getSecurityHeaders({ isHtml: false, isHttps: isHttpsRequest(req) }),
      'Content-Type': normalizeVoiceMime(item.mimeType) || 'audio/webm',
      'Content-Length': item.buffer.length,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
    });

    res.end(item.buffer);
  } catch (error) {
    console.error('[VOICE GET ERROR]', error.message);

    writeJsonResponse(res, 503, {
      error: 'Không thể lấy Voice từ Redis.'
    }, req);
  }
}

const httpServer = http.createServer((req, res) => {
  const isHttps = isHttpsRequest(req);
  let requestUrl;
  try {
    requestUrl = new URL(req.url || '/', 'http://localhost');
  } catch {
    writeJsonResponse(res, 400, { error: 'URL yêu cầu không hợp lệ.' }, req);
    return;
  }

  const uploadMatch = /^\/api\/attachments\/([0-9a-f-]{36})$/iu.exec(requestUrl.pathname);
  if (req.method === 'POST' && uploadMatch) {
    handleAttachmentUploadRequest(req, res, uploadMatch[1]);
    return;
  }
  const localAttachmentGetMatch = /^\/api\/attachments\/file\/([0-9a-f-]{36})$/iu.exec(requestUrl.pathname);
  if (req.method === 'GET' && localAttachmentGetMatch) {
    handleLocalAttachmentGetRequest(req, res, localAttachmentGetMatch[1], requestUrl);
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

  // Chỉ cho phép GET cho tài nguyên tĩnh
  if (req.method !== 'GET') {
    res.writeHead(405, {
      ...getSecurityHeaders({ isHtml: false, isHttps }),
      Allow: 'GET, POST',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Method Not Allowed');
    return;
  }

  // Bảo mật: chống path traversal trên đường dẫn gốc trước khi URL chuẩn hóa (chặn .., %2e%2e, dotfile, sibling-prefix)
  const rawStaticPath = String(req.url || '/').split('?')[0];
  const fullPath = resolveSafeStaticPath(FRONTEND_DIR, rawStaticPath);
  if (!fullPath) {
    res.writeHead(403, {
      ...getSecurityHeaders({ isHtml: false, isHttps }),
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        res.writeHead(404, {
          ...getSecurityHeaders({ isHtml: false, isHttps }),
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('Not Found');
      } else {
        res.writeHead(500, {
          ...getSecurityHeaders({ isHtml: false, isHttps }),
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('Internal Server Error');
      }
      return;
    }
    const isCodeAsset = ext === '.html' || ext === '.css' || ext === '.js';
    res.writeHead(200, {
      ...getSecurityHeaders({ isHtml: ext === '.html', isHttps }),
      'Content-Type': contentType,
      'Cache-Control': isCodeAsset ? 'no-cache, must-revalidate' : 'public, max-age=86400',
    });
    res.end(data);
  });
});

// Chống Slowloris nhưng vẫn đủ thời gian tải video lên tới 50MB qua /api/attachments/
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 10 * 60 * 1000;
httpServer.keepAliveTimeout = 15_000;

// ─── WebSocket Server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 4096, // Giới hạn kích thước payload tối đa 4KB để chống DoS / Memory Exhaustion (CWE-400 / CVE-2020-13935)
  verifyClient: (info, callback) => {
    // ── Bảo vệ chống Cross-Site WebSocket Hijacking (CSWSH - CWE-1385 / OWASP ASVS v4.0) ──
    if (!isAllowedWsOrigin(info.req, process.env.ALLOWED_ORIGINS)) {
      const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin) || 'missing';
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
  onGroupEvent: (event) => {
    handleRemoteGroupEvent(event);
  },
  onOnlineCount: (count) => {
    broadcastOnlineCount(count);
  },
});

const groupManager = new GroupManager({
  maxMembers: DEFAULT_MAX_GROUP_MEMBERS,
  minKeepVotes: MIN_KEEP_VOTES,
  redisManager,
});

const connectionManager = new ConnectionManager({
  maxHistory: MAX_PAIR_HISTORY,
  redisManager,
});

const gameRoomManager = new GameRoomManager({
  maxPlayers: MAX_GAME_ROOM_PLAYERS,
  onBroadcast: (roomId, eventType, payload, excludeClientId = null) => {
    broadcastToGameRoom(roomId, createMessage(eventType, payload), excludeClientId);
  },
  onSendTo: (targetClientId, eventType, payload) => {
    sendTo(targetClientId, createMessage(eventType, payload));
  },
});

const embeddedGameManager = new GameRoomManager({
  maxPlayers: MAX_GAME_ROOM_PLAYERS,
  onBroadcast: (embeddedRoomId, _eventType, payload) => {
    const room = embeddedGameManager.getRoom(embeddedRoomId);
    if (!room || !room.contextKey) return;
    const isGroupCtx = room.contextType === 'group';
    const groupId = isGroupCtx ? room.contextKey.slice('group:'.length) : null;
    const msg = serverMsg.chatGameState({
      ...payload,
      groupId,
      closed: false,
    });
    if (isGroupCtx) {
      broadcastToGroup(groupId, msg);
    } else {
      for (const cid of room.players.keys()) {
        if (!cid.startsWith('bot-companion-')) {
          sendTo(cid, msg);
        }
      }
      if (room.isBotSession && room.botClientId) {
        scheduleLumiEmbeddedMove(room);
      }
    }
  },
  onSendTo: (targetClientId, _eventType, payload) => {
    if (!targetClientId.startsWith('bot-companion-')) {
      sendTo(targetClientId, serverMsg.chatGamePrivate(payload));
    }
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
  closeEmbedded1v1Game(roomId, { silent: true });
  connectionManager.cleanupRoomSession(roomId);
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

// ─── Tiện ích Trò Chuyện Nhóm Ẩn Danh (O(1) Fan-out đa node) ───────────────

function deliverGroupMessageLocal(groupId, msgString, excludeClientId = null) {
  const localIds = groupManager.getLocalClientIds(groupId);
  for (const cid of localIds) {
    if (excludeClientId && cid === excludeClientId) continue;
    const c = clients.get(cid);
    if (c && c.ws.readyState === 1) {
      c.ws.send(msgString);
    }
  }
}

function handleRemoteGroupEvent(event) {
  if (!event || event.sourceInstanceId === redisManager.instanceId) return;
  if (event.kind === 'embedded_game_cmd') {
    handleRemoteEmbeddedGameCmd(event);
    return;
  }
  if (event.targetClientId) {
    const c = clients.get(event.targetClientId);
    if (c && c.ws.readyState === 1) {
      c.ws.send(event.msgString);
    }
    return;
  }
  if (event.groupId && event.msgString) {
    deliverGroupMessageLocal(event.groupId, event.msgString, event.excludeClientId || null);
  }
}

function publishEmbeddedGameCmd(cmd) {
  if (!redisManager.enabled || !redisManager.isConnected) return false;
  redisManager.publishGroupEvent({
    kind: 'embedded_game_cmd',
    ...cmd,
  }).catch((error) => {
    console.error('[EmbeddedGame] Failed to publish cross-instance command:', error.message);
  });
  return true;
}

function handleRemoteEmbeddedGameCmd(event) {
  const {
    contextKey,
    contextType,
    groupId = null,
    command,
    clientId,
    userProfile = null,
    payload = {},
    receivedAt = Date.now(),
  } = event || {};
  if (!contextKey || !command) return;

  const room = embeddedGameManager.getRoomByContext(contextKey);
  if (!room) return;

  if (command === 'sync_state') {
    if (!clientId) return;
    const snap = embeddedGameManager.buildRoomSnapshot(room);
    sendTo(clientId, serverMsg.chatGameState({
      ...snap,
      contextType: room.contextType || contextType || '1v1',
      contextKey: room.contextKey,
      groupId: room.contextType === 'group' ? room.contextKey.slice('group:'.length) : null,
      isBotSession: Boolean(room.isBotSession),
      allowAnyPlayerControl: Boolean(room.allowAnyPlayerControl),
      closed: false,
    }));
    return;
  }

  if (command === 'join') {
    if (!clientId || !userProfile) return;
    const joinRes = embeddedGameManager.joinRoom(userProfile, { roomId: room.roomId });
    if (!joinRes.ok) {
      sendTo(clientId, serverMsg.error(joinRes.code || 'GAME_ROOM_ERROR', joinRes.error));
      return;
    }
    embeddedGameManager.broadcastRoomState(room.roomId, {
      systemNotice: `🙋 ${joinRes.player.nickname} đã tham gia bàn game (${joinRes.room.playerCount}/${joinRes.room.maxPlayers})!`,
    });
    return;
  }

  if (command === 'leave') {
    if (!clientId) return;
    if (room.contextType === 'group' && groupId) {
      removePlayerFromGroupEmbeddedGame(groupId, clientId);
    } else if (room.contextType === '1v1') {
      const chatRoomId = contextKey.slice('chat:'.length);
      closeEmbedded1v1Game(chatRoomId, { closedByName: payload.closedByName || userProfile?.nickname || null });
    }
    return;
  }

  if (command === 'select') {
    const res = embeddedGameManager.selectGame(clientId, payload.gameType);
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('CHAT_GAME_ERROR', res.error));
    }
    return;
  }

  if (command === 'start') {
    const res = embeddedGameManager.startGame(clientId);
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('CHAT_GAME_ERROR', res.error));
    }
    return;
  }

  if (command === 'action') {
    const res = embeddedGameManager.handleAction(clientId, payload, { receivedAt });
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('CHAT_GAME_ACTION_ERROR', res.error));
    }
    return;
  }

  if (command === 'close') {
    if (room.contextType === '1v1') {
      const chatRoomId = contextKey.slice('chat:'.length);
      closeEmbedded1v1Game(chatRoomId, {
        closedByName: payload.closedByName || userProfile?.nickname || null,
        silent: Boolean(payload.silent),
      });
    } else if (room.contextType === 'group' && groupId) {
      if (room.hostId === clientId) {
        const hostNick = room.players.get(clientId)?.nickname || userProfile?.nickname || 'Chủ bàn';
        embeddedGameManager.destroyRoomByContext(contextKey);
        broadcastToGroup(groupId, serverMsg.chatGameState({
          contextType: 'group',
          groupId,
          closed: true,
          closedByName: hostNick,
          systemNotice: `🎮 ${hostNick} đã đóng bàn game trong nhóm.`,
        }));
      } else if (room.players.has(clientId)) {
        removePlayerFromGroupEmbeddedGame(groupId, clientId);
      }
    }
  }
}

function broadcastToGroup(groupId, msgString, excludeClientId = null) {
  deliverGroupMessageLocal(groupId, msgString, excludeClientId);
  if (redisManager.enabled && redisManager.isConnected) {
    redisManager.publishGroupEvent({
      groupId,
      msgString,
      excludeClientId,
    }).catch((error) => {
      console.error('[Group] Failed to publish group event:', error.message);
    });
  }
}

async function ensureNotGroupBanned(clientId) {
  const client = clients.get(clientId);
  if (!client) return false;

  if (redisManager.enabled) {
    return ensureNotRedisBanned(clientId);
  }

  const localBan = moderation.isBanned(clientId, client.clientIp);
  if (localBan.banned) {
    sendTo(clientId, serverMsg.error(
      ERROR_CODES.BANNED,
      `Bạn đang bị cấm trong ${localBan.remainingSec} giây nữa.`
    ));
    return false;
  }
  return true;
}

async function leaveGroupSession(clientId, { kicked = false, silent = false, reason = null } = {}) {
  if (!groupManager.isInGroup(clientId)) return null;

  const prevGroupId = groupManager.getGroupId(clientId);
  const client = clients.get(clientId);
  let result;
  try {
    result = await groupManager.leaveGroup(clientId, { kicked, reason });
  } catch (error) {
    console.error(`[Group] Failed to leave group for ${clientId}:`, error.message);
    return null;
  }

  if (client && client.state === 'GROUP_CHATTING') {
    client.state = 'CONNECTED';
    client.groupId = null;
  }

  if (prevGroupId) {
    removePlayerFromGroupEmbeddedGame(prevGroupId, clientId);
  }

  if (!result) return null;

  if (result.memberCount > 0 && result.member) {
    broadcastToGroup(
      result.groupId,
      serverMsg.groupMemberLeft({
        groupId: result.groupId,
        clientId,
        nickname: result.member.nickname,
        memberCount: result.memberCount,
        keepCount: result.keepCount,
        minKeepVotes: result.minKeepVotes,
        isKept: result.isKept,
        kicked,
        reason,
      }),
      clientId
    );
  }

  if (!silent && !kicked && client && clients.get(clientId) === client) {
    let leftReason = 'Bạn đã rời khỏi phòng nhóm.';
    if (result.destroyed) {
      leftReason = 'Mọi thành viên đã rời đi và chưa đủ 3 người giữ nhóm, cuộc trò chuyện nhóm đã tự động biến mất.';
    } else if (result.preserved) {
      leftReason = 'Nhóm đã được giữ lại vì có ít nhất 3 thành viên đồng ý. Bạn có thể quay lại trò chuyện tiếp bất cứ lúc nào!';
    }
    sendTo(clientId, serverMsg.groupLeft({
      groupId: result.groupId,
      groupName: result.groupName || '',
      preserved: result.preserved,
      destroyed: result.destroyed,
      keepCount: result.keepCount,
      minKeepVotes: result.minKeepVotes,
      isKept: result.isKept,
      reason: leftReason,
    }));
  }

  return result;
}

async function applyGroupViolationPenalty(clientId, filterResult) {
  const client = clients.get(clientId);
  if (!client) return;

  if (filterResult.action === MODERATION_ACTIONS.STRIKE_BAN) {
    if (redisManager.enabled) {
      let result;
      try {
        result = await addViolation(client.deviceId);
      } catch (error) {
        console.error('[Group Redis Violation] Không thể ghi nhận vi phạm:', error.message);
        sendTo(clientId, serverMsg.error(
          'MODERATION_UNAVAILABLE',
          'Hệ thống kiểm duyệt đang gián đoạn. Tin nhắn chưa được gửi.'
        ));
        return;
      }

      if (!result.banned) {
        sendTo(clientId, serverMsg.error(
          'VIOLATION_WARNING',
          `Cảnh báo (${result.count}/3): Tin nhắn vi phạm tiêu chuẩn cộng đồng (${filterResult.category}). Đủ 3 lần trong 3 giờ sẽ bị cấm 10 phút!`
        ));
        return;
      }

      const banExpiresAt = Date.now() + result.remainingBan * 1000;
      await leaveGroupSession(clientId, {
        kicked: true,
        reason: 'bị buộc rời nhóm do vi phạm tiêu chuẩn cộng đồng',
      });
      sendTo(clientId, serverMsg.kicked('Bạn đã bị cấm 10 phút do vi phạm 3 lần.', banExpiresAt));
      return;
    }

    // Chế độ in-memory (không bật Redis)
    client.warningCount = (client.warningCount || 0) + 1;
    if (client.warningCount < 3) {
      sendTo(clientId, serverMsg.error(
        'VIOLATION_WARNING',
        `Cảnh báo (${client.warningCount}/3): Tin nhắn vi phạm tiêu chuẩn cộng đồng (${filterResult.category}). Đủ 3 lần sẽ bị cấm 10 phút!`
      ));
      return;
    }

    client.warningCount = 0;
    const banExpiresAt = moderation.ban(clientId, client.clientIp, 'Vi phạm tiêu chuẩn cộng đồng 3 lần');
    await leaveGroupSession(clientId, {
      kicked: true,
      reason: 'bị buộc rời nhóm do vi phạm tiêu chuẩn cộng đồng',
    });
    sendTo(clientId, serverMsg.kicked('Bạn đã bị cấm 10 phút do vi phạm 3 lần.', banExpiresAt));
    return;
  }

  if (filterResult.action === MODERATION_ACTIONS.INSTANT_BAN) {
    let banExpiresAt;
    if (redisManager.enabled) {
      try {
        const banResult = await instantBan(client.deviceId);
        banExpiresAt = Date.now() + banResult.remainingBan * 1000;
      } catch (error) {
        console.error('[Group Redis Ban] Không thể ghi nhận ban tức thì:', error.message);
        sendTo(clientId, serverMsg.error(
          'MODERATION_UNAVAILABLE',
          'Hệ thống kiểm duyệt đang gián đoạn. Tin nhắn chưa được gửi.'
        ));
        return;
      }
    } else {
      banExpiresAt = moderation.ban(clientId, client.clientIp, filterResult.reason);
    }

    await leaveGroupSession(clientId, {
      kicked: true,
      reason: 'bị buộc rời nhóm do vi phạm nghiêm trọng tiêu chuẩn an toàn',
    });
    sendTo(clientId, serverMsg.kicked(filterResult.reason, banExpiresAt));
  }
}

async function handleGroupTextMessage(clientId, payload) {
  const client = clients.get(clientId);
  if (!client || client.state !== 'GROUP_CHATTING') return;

  const groupId = groupManager.getGroupId(clientId);
  if (!groupId) {
    client.state = 'CONNECTED';
    client.groupId = null;
    sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng nhóm'));
    return;
  }

  if (!(await ensureNotGroupBanned(clientId))) return;
  if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

  if (!moderation.checkRateLimit(clientId)) {
    sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin quá nhanh, vui lòng chờ'));
    return;
  }

  let text = payload.text;
  const filterResult = checkContent(text);
  if (filterResult.isViolation) {
    if (filterResult.action === MODERATION_ACTIONS.MASK) {
      text = maskProfanity(text);
    } else if (filterResult.action === MODERATION_ACTIONS.BLOCK_WARN) {
      sendTo(clientId, serverMsg.error(
        'MESSAGE_BLOCKED',
        `Tin nhắn của bạn chứa từ ngữ nhạy cảm ("${filterResult.matched}"). Vui lòng diễn đạt lại để tiếp tục trò chuyện nhé!`
      ));
      return;
    } else {
      await applyGroupViolationPenalty(clientId, filterResult);
      return;
    }
  }

  const linkSafety = analyzeLinkSafety(text);
  let reputation;
  try {
    reputation = await checkMessageLinks(text);
  } catch (error) {
    console.error('[SafeBrowsing] Could not check group message links:', error.message);
    reputation = { status: 'unavailable', checkedCount: 0, threatTypes: [], complete: false };
  }

  if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

  const unsafeScheme = linkSafety.reasons.some((reason) => reason.includes('giao thức không an toàn'));
  const hasLinkSignal = linkSafety.hasLinks || unsafeScheme;
  const reputationWarning = {
    hasLinks: hasLinkSignal,
    suspicious: linkSafety.suspicious || reputation.status === 'threat' || reputation.status === 'limit_exceeded',
    reasons: [...linkSafety.reasons],
    reputation: reputation.status,
    threatTypes: reputation.threatTypes,
  };
  if (reputation.status === 'threat') {
    reputationWarning.source = 'google_safe_browsing';
  }

  if (reputation.status === 'threat' || reputation.status === 'limit_exceeded' || unsafeScheme) {
    reputationWarning.blocked = true;
    if (reputation.status === 'threat') {
      reputationWarning.blockedReason = 'threat';
      reputationWarning.reasons.push('Google Safe Browsing đánh dấu liên kết này có thể nguy hiểm.');
    } else if (reputation.status === 'limit_exceeded') {
      reputationWarning.blockedReason = 'limit_exceeded';
      reputationWarning.reasons.push('Tin nhắn vượt quá giới hạn 5 URL được kiểm tra.');
    } else {
      reputationWarning.blockedReason = 'unsafe_scheme';
      reputationWarning.reasons.push('Tin nhắn chứa giao thức liên kết không an toàn.');
    }
    sendTo(clientId, serverMsg.linkWarning(reputationWarning));
    return;
  }

  const timestamp = new Date().toISOString();
  const messageLinkSafety = hasLinkSignal && (linkSafety.suspicious || reputation.status === 'threat')
    ? reputationWarning
    : null;

  const [groupMember, mentions] = await Promise.all([
    groupManager.getGroupMember(groupId, clientId),
    groupManager.extractGroupMentions(groupId, text),
  ]);
  const senderNickname = (groupMember && groupMember.nickname) || client.nickname;

  const msgRecord = {
    id: uuidv4(),
    type: 'message',
    groupId,
    senderClientId: clientId,
    senderNickname,
    senderAvatar: client.avatar || '🦊',
    text,
    mentions,
    timestamp,
    linkSafety: messageLinkSafety,
  };

  groupManager.recordHistoryMessage(groupId, msgRecord).catch((error) => {
    console.error('[Group] Failed to record history message:', error.message);
  });

  broadcastToGroup(groupId, serverMsg.groupMessage(msgRecord), clientId);
  if (messageLinkSafety) {
    sendTo(clientId, serverMsg.linkWarning(reputationWarning));
  }
}

// ─── Tiện ích Phòng Game Nhiều Người Ẩn Danh (2–10 người) ──────────────────

function broadcastToGameRoom(roomId, msgString, excludeClientId = null) {
  const clientIds = gameRoomManager.getRoomClientIds(roomId);
  for (const cid of clientIds) {
    if (excludeClientId && cid === excludeClientId) continue;
    const c = clients.get(cid);
    if (c && c.ws.readyState === 1) {
      c.ws.send(msgString);
    }
  }
}

function leaveGameRoomSession(clientId, { kicked = false, silent = false, reason = null } = {}) {
  if (!gameRoomManager.isInGameRoom(clientId)) return null;

  const client = clients.get(clientId);
  const result = gameRoomManager.leaveRoom(clientId, { kicked, reason });

  if (client && client.state === 'GAME_ROOM') {
    client.state = 'CONNECTED';
    client.gameRoomId = null;
  }

  if (!result) return null;

  if (!result.destroyed && result.player) {
    broadcastToGameRoom(
      result.roomId,
      serverMsg.gameRoomPlayerLeft({
        roomId: result.roomId,
        clientId,
        nickname: result.player.nickname,
        playerCount: result.playerCount,
        hostId: result.hostId,
        hostChanged: result.hostChanged,
        hostNickname: result.hostNickname,
        kicked,
        reason,
      }),
      clientId
    );
  }

  if (!silent && !kicked && client && clients.get(clientId) === client) {
    sendTo(clientId, serverMsg.gameRoomLeft({
      roomId: result.roomId,
      destroyed: result.destroyed,
      reason: result.destroyed
        ? 'Mọi người chơi đã rời đi, phòng game đã tự động đóng.'
        : 'Bạn đã rời khỏi phòng game.',
    }));
  }

  return result;
}

async function applyGameRoomViolationPenalty(clientId, filterResult) {
  const client = clients.get(clientId);
  if (!client) return;

  if (filterResult.action === MODERATION_ACTIONS.STRIKE_BAN) {
    if (redisManager.enabled) {
      let result;
      try {
        result = await addViolation(client.deviceId);
      } catch (error) {
        console.error('[GameRoom Redis Violation]', error.message);
        sendTo(clientId, serverMsg.error('MODERATION_UNAVAILABLE', 'Hệ thống kiểm duyệt đang gián đoạn. Tin nhắn chưa được gửi.'));
        return;
      }
      if (!result.banned) {
        sendTo(clientId, serverMsg.error(
          'VIOLATION_WARNING',
          `Cảnh báo (${result.count}/3): Tin nhắn vi phạm tiêu chuẩn cộng đồng (${filterResult.category}). Đủ 3 lần trong 3 giờ sẽ bị cấm 10 phút!`
        ));
        return;
      }
      const banExpiresAt = Date.now() + result.remainingBan * 1000;
      leaveGameRoomSession(clientId, { kicked: true, reason: 'vi phạm tiêu chuẩn cộng đồng' });
      sendTo(clientId, serverMsg.kicked('Bạn đã bị cấm 10 phút do vi phạm 3 lần.', banExpiresAt));
      return;
    }

    client.warningCount = (client.warningCount || 0) + 1;
    if (client.warningCount < 3) {
      sendTo(clientId, serverMsg.error(
        'VIOLATION_WARNING',
        `Cảnh báo (${client.warningCount}/3): Tin nhắn vi phạm tiêu chuẩn cộng đồng (${filterResult.category}). Đủ 3 lần sẽ bị cấm 10 phút!`
      ));
      return;
    }
    client.warningCount = 0;
    const banExpiresAt = moderation.ban(clientId, client.clientIp, 'Vi phạm tiêu chuẩn cộng đồng 3 lần');
    leaveGameRoomSession(clientId, { kicked: true, reason: 'vi phạm tiêu chuẩn cộng đồng' });
    sendTo(clientId, serverMsg.kicked('Bạn đã bị cấm 10 phút do vi phạm 3 lần.', banExpiresAt));
    return;
  }

  if (filterResult.action === MODERATION_ACTIONS.INSTANT_BAN) {
    let banExpiresAt;
    if (redisManager.enabled) {
      try {
        const banResult = await instantBan(client.deviceId);
        banExpiresAt = Date.now() + banResult.remainingBan * 1000;
      } catch (error) {
        console.error('[GameRoom Redis Ban]', error.message);
        sendTo(clientId, serverMsg.error('MODERATION_UNAVAILABLE', 'Hệ thống kiểm duyệt đang gián đoạn. Tin nhắn chưa được gửi.'));
        return;
      }
    } else {
      banExpiresAt = moderation.ban(clientId, client.clientIp, filterResult.reason);
    }
    leaveGameRoomSession(clientId, { kicked: true, reason: 'vi phạm nghiêm trọng tiêu chuẩn an toàn' });
    sendTo(clientId, serverMsg.kicked(filterResult.reason, banExpiresAt));
  }
}

async function handleGameRoomTextMessage(clientId, payload) {
  const client = clients.get(clientId);
  if (!client || client.state !== 'GAME_ROOM') return;

  const roomId = gameRoomManager.getRoomId(clientId);
  if (!roomId) {
    client.state = 'CONNECTED';
    client.gameRoomId = null;
    sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng game'));
    return;
  }

  if (!(await ensureNotGroupBanned(clientId))) return;
  if (clients.get(clientId) !== client || client.state !== 'GAME_ROOM' || gameRoomManager.getRoomId(clientId) !== roomId) return;

  if (!moderation.checkRateLimit(clientId)) {
    sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin quá nhanh, vui lòng chờ'));
    return;
  }

  let text = payload.text;
  const filterResult = checkContent(text);
  if (filterResult.isViolation) {
    if (filterResult.action === MODERATION_ACTIONS.MASK) {
      text = maskProfanity(text);
    } else if (filterResult.action === MODERATION_ACTIONS.BLOCK_WARN) {
      sendTo(clientId, serverMsg.error(
        'MESSAGE_BLOCKED',
        `Tin nhắn của bạn chứa từ ngữ nhạy cảm ("${filterResult.matched}"). Vui lòng diễn đạt lại nhé!`
      ));
      return;
    } else {
      await applyGameRoomViolationPenalty(clientId, filterResult);
      return;
    }
  }

  const linkSafety = analyzeLinkSafety(text);
  let reputation;
  try {
    reputation = await checkMessageLinks(text);
  } catch (error) {
    reputation = { status: 'unavailable', checkedCount: 0, threatTypes: [], complete: false };
  }

  if (clients.get(clientId) !== client || client.state !== 'GAME_ROOM' || gameRoomManager.getRoomId(clientId) !== roomId) return;

  const unsafeScheme = linkSafety.reasons.some((reason) => reason.includes('giao thức không an toàn'));
  const hasLinkSignal = linkSafety.hasLinks || unsafeScheme;
  const reputationWarning = {
    hasLinks: hasLinkSignal,
    suspicious: linkSafety.suspicious || reputation.status === 'threat' || reputation.status === 'limit_exceeded',
    reasons: [...linkSafety.reasons],
    reputation: reputation.status,
    threatTypes: reputation.threatTypes,
  };
  if (reputation.status === 'threat') reputationWarning.source = 'google_safe_browsing';

  if (reputation.status === 'threat' || reputation.status === 'limit_exceeded' || unsafeScheme) {
    reputationWarning.blocked = true;
    if (reputation.status === 'threat') {
      reputationWarning.blockedReason = 'threat';
      reputationWarning.reasons.push('Google Safe Browsing đánh dấu URL này có thể nguy hiểm.');
    } else if (reputation.status === 'limit_exceeded') {
      reputationWarning.blockedReason = 'limit_exceeded';
      reputationWarning.reasons.push('Tin nhắn chứa quá 5 liên kết.');
    } else {
      reputationWarning.blockedReason = 'unsafe_scheme';
    }
    sendTo(clientId, serverMsg.linkWarning(reputationWarning));
    return;
  }

  const player = gameRoomManager.getPlayer(roomId, clientId);
  const senderNickname = (player && player.nickname) || client.nickname;
  const mentions = gameRoomManager.extractRoomMentions(roomId, text);
  const timestamp = new Date().toISOString();
  const messageLinkSafety = hasLinkSignal && (linkSafety.suspicious || reputation.status === 'threat')
    ? reputationWarning
    : null;

  broadcastToGameRoom(
    roomId,
    serverMsg.gameRoomMessage({
      id: uuidv4(),
      roomId,
      senderClientId: clientId,
      senderNickname,
      senderAvatar: client.avatar || '🦊',
      text,
      mentions,
      timestamp,
      linkSafety: messageLinkSafety,
    }),
    clientId
  );

  if (messageLinkSafety) {
    sendTo(clientId, serverMsg.linkWarning(reputationWarning));
  }
}

// ─── Tiện ích Minigame Nhúng (Chat 1-1 / Lumi AI / Nhóm chat) ──────────────

function getLumiHumanId(room) {
  for (const cid of room.players.keys()) {
    if (!cid.startsWith('bot-companion-')) return cid;
  }
  return null;
}

function scheduleLumiEmbeddedMove(room) {
  if (!room || !room.isBotSession || !room.botClientId || !room.game) return;
  const g = room.game;
  const botId = room.botClientId;
  const humanId = getLumiHumanId(room);
  const fastMode = process.env.FAST_BOT_GAMES === 'true';

  if (g.phase === 'ended') {
    const endKey = `ended:${g.gameType}:${room.lastActivityAt}`;
    if (room._botScheduledKey !== endKey && humanId) {
      room._botScheduledKey = endKey;
      setTimeout(() => {
        if (!clients.has(humanId) || !roomManager.isBotRoom(humanId)) return;
        sendTo(
          humanId,
          serverMsg.message(
            'Ván này vui quá trời luôn! Bấm "🔄 Chơi ván mới" hoặc "🎮 Đổi game" để chiến tiếp với Lumi nha ✨',
            new Date().toISOString()
          )
        );
      }, fastMode ? 30 : 600);
    }
    return;
  }

  if (g.gameType === 'quiz_race' && g.phase === 'question') {
    if (g.answers && g.answers.has(botId)) return;
    const key = `quiz:${g.currentIndex}`;
    if (room._botScheduledKey === key) return;
    room._botScheduledKey = key;

    const delay = fastMode ? 40 : (1700 + Math.floor(Math.random() * 1900));
    if (room._botTimer) clearTimeout(room._botTimer);
    room._botTimer = setTimeout(() => {
      room._botTimer = null;
      const curRoom = embeddedGameManager.getRoom(room.roomId);
      if (!curRoom || !curRoom.game || curRoom.game.gameType !== 'quiz_race' || curRoom.game.phase !== 'question') return;
      if (curRoom.game.answers.has(botId)) return;

      const currentQ = curRoom.game.questions[curRoom.game.currentIndex];
      if (!currentQ) return;
      let chosen = currentQ.answer;
      if (Math.random() > 0.72) {
        const wrongs = [0, 1, 2, 3].filter((i) => i !== currentQ.answer);
        chosen = wrongs[Math.floor(Math.random() * wrongs.length)];
      }
      embeddedGameManager.handleAction(botId, { action: 'answer', optionIndex: chosen });
    }, delay);
    return;
  }

  if (g.gameType === 'word_chain' && g.phase === 'playing') {
    if (g.turnClientId !== botId) return;
    const key = `wc:${g.chain.length}:${g.requiredStart}`;
    if (room._botScheduledKey === key) return;
    room._botScheduledKey = key;

    const delay = fastMode ? 40 : (1100 + Math.floor(Math.random() * 700));
    if (room._botTimer) clearTimeout(room._botTimer);
    room._botTimer = setTimeout(() => {
      room._botTimer = null;
      const curRoom = embeddedGameManager.getRoom(room.roomId);
      if (!curRoom || !curRoom.game || curRoom.game.gameType !== 'word_chain' || curRoom.game.phase !== 'playing') return;
      if (curRoom.game.turnClientId !== botId) return;

      const reply = findWordChainReply(curRoom.game.requiredStart, curRoom.game.usedWords, stripVietnameseTones);
      if (reply) {
        embeddedGameManager.handleAction(botId, { action: 'submit_word', word: reply });
      } else {
        if (humanId && clients.has(humanId)) {
          sendTo(
            humanId,
            serverMsg.message(
              `Ôi trời âm tiết "${curRoom.game.requiredStart}" khoai quá, Lumi chịu thua lượt này luôn 😅!`,
              new Date().toISOString()
            )
          );
        }
        embeddedGameManager.forfeitWordChainTurn(curRoom.roomId, botId, 'bí từ lượt này');
      }
    }, delay);
    return;
  }

  if (g.gameType === 'mind_duel' && g.phase === 'choose') {
    if (g.choices && g.choices.has(botId)) return;
    const key = `md:${g.matchId || 'm'}:${g.round}`;
    if (room._botScheduledKey === key) return;
    room._botScheduledKey = key;

    const delay = fastMode ? 40 : (1300 + Math.floor(Math.random() * 1400));
    if (room._botTimer) clearTimeout(room._botTimer);
    room._botTimer = setTimeout(() => {
      room._botTimer = null;
      const curRoom = embeddedGameManager.getRoom(room.roomId);
      if (!curRoom || !curRoom.game || curRoom.game.gameType !== 'mind_duel' || curRoom.game.phase !== 'choose') return;
      if (curRoom.game.choices.has(botId)) return;

      const counterMap = {
        attack: 'shield',
        shield: 'bluff',
        bluff: 'attack',
        charge: 'attack',
      };
      const recentHumanCards = (curRoom.game.history || [])
        .slice(-2)
        .map((h) => (h.entries || []).find((e) => e.clientId === humanId)?.card)
        .filter(Boolean);

      let chosenCard;
      if (
        recentHumanCards.length === 2
        && recentHumanCards[0] === recentHumanCards[1]
        && counterMap[recentHumanCards[0]]
        && Math.random() < 0.6
      ) {
        chosenCard = counterMap[recentHumanCards[0]];
      } else {
        const roll = Math.random();
        if (roll < 0.28) chosenCard = 'attack';
        else if (roll < 0.52) chosenCard = 'shield';
        else if (roll < 0.76) chosenCard = 'bluff';
        else chosenCard = 'charge';
      }

      const isFinal = curRoom.game.round === curRoom.game.totalRounds;
      const stakes = isFinal ? [20, 30, 30] : [10, 20, 20, 30];
      const chosenStake = stakes[Math.floor(Math.random() * stakes.length)];
      embeddedGameManager.handleAction(botId, {
        action: 'pick_card',
        card: chosenCard,
        stake: chosenStake,
      });
    }, delay);
  }
}

function closeEmbedded1v1Game(chatRoomId, { closedByName = null, silent = false, skipRemoteRelay = false } = {}) {
  if (!chatRoomId) return;
  const contextKey = `chat:${chatRoomId}`;
  const existing = embeddedGameManager.getRoomByContext(contextKey);
  if (!existing) {
    if (!skipRemoteRelay) {
      publishEmbeddedGameCmd({
        contextType: '1v1',
        contextKey,
        command: 'close',
        payload: { closedByName, silent },
      });
    }
    return;
  }

  const recipients = [...existing.players.keys()].filter((cid) => !cid.startsWith('bot-companion-'));
  embeddedGameManager.destroyRoomByContext(contextKey);

  if (!silent) {
    const msg = serverMsg.chatGameState({
      contextType: '1v1',
      closed: true,
      closedByName,
      systemNotice: closedByName ? `🎮 ${closedByName} đã đóng trò chơi.` : null,
    });
    for (const cid of recipients) {
      sendTo(cid, msg);
    }
  }
}

function sendActiveEmbedded1v1GameIfAny(chatRoomId, clientId) {
  if (!chatRoomId || !clientId) return;
  const contextKey = `chat:${chatRoomId}`;
  const room = embeddedGameManager.getRoomByContext(contextKey);
  if (!room) {
    publishEmbeddedGameCmd({
      contextType: '1v1',
      contextKey,
      command: 'sync_state',
      clientId,
    });
    return;
  }
  const snap = embeddedGameManager.buildRoomSnapshot(room);
  sendTo(clientId, serverMsg.chatGameState({
    ...snap,
    contextType: '1v1',
    contextKey: room.contextKey,
    groupId: null,
    isBotSession: Boolean(room.isBotSession),
    allowAnyPlayerControl: Boolean(room.allowAnyPlayerControl),
    closed: false,
  }));
}

function removePlayerFromGroupEmbeddedGame(groupId, clientId) {
  if (!groupId) return;
  const contextKey = `group:${groupId}`;
  const room = embeddedGameManager.getRoomByContext(contextKey);
  if (!room || !room.players.has(clientId)) return;

  const leftNick = room.players.get(clientId)?.nickname || 'Một thành viên';
  const res = embeddedGameManager.leaveRoom(clientId);
  if (!res) return;

  if (res.destroyed) {
    broadcastToGroup(groupId, serverMsg.chatGameState({
      contextType: 'group',
      groupId,
      closed: true,
      systemNotice: '🎮 Bàn game trong nhóm đã đóng vì không còn người ngồi chơi.',
    }));
  } else {
    const notice = res.hostChanged && res.hostNickname
      ? `👋 ${leftNick} đã rời bàn game. 👑 ${res.hostNickname} trở thành chủ bàn mới.`
      : `👋 ${leftNick} đã rời bàn game (${res.playerCount}/${room.maxPlayers}).`;
    embeddedGameManager.broadcastRoomState(room.roomId, { systemNotice: notice });
  }
}

function sendActiveGroupGameIfAny(groupId, clientId) {
  if (!groupId) return;
  const room = embeddedGameManager.getRoomByContext(`group:${groupId}`);
  if (!room) {
    publishEmbeddedGameCmd({
      contextType: 'group',
      contextKey: `group:${groupId}`,
      groupId,
      command: 'sync_state',
      clientId,
    });
    return;
  }
  const snap = embeddedGameManager.buildRoomSnapshot(room);
  sendTo(clientId, serverMsg.chatGameState({
    ...snap,
    contextType: 'group',
    contextKey: room.contextKey,
    groupId,
    isBotSession: false,
    allowAnyPlayerControl: false,
    closed: false,
  }));
}

// ─── Tiện ích Giữ kết nối ẩn danh 2 chiều & Mã hẹn gặp lại (1-1) ──────────

function findOnlineClientForPairSlot(pair, targetSlot, excludeClientId = null) {
  if (!pair || !pair.slots || !pair.slots[targetSlot]) return null;
  const deviceKey = pair.slots[targetSlot].deviceKey;
  let fallback = null;
  for (const c of clients.values()) {
    if (excludeClientId && c.clientId === excludeClientId) continue;
    if (c.ws.readyState !== 1) continue;
    const hasSyncedSlot = Array.isArray(c.syncedPairLinks)
      && c.syncedPairLinks.some((l) => l.pairId === pair.pairId && l.mySlot === targetSlot);
    const matchesDevice = Boolean(deviceKey && (c.deviceId === deviceKey || c.clientId === deviceKey));
    if (hasSyncedSlot || matchesDevice) {
      if (c.state === 'CONNECTED' || c.state === 'PAIR_WAITING') return c;
      if (!fallback) fallback = c;
    }
  }
  return fallback;
}

function getPartnerPresenceForPair(pair, otherSlot, myClientId = null) {
  const waiting = connectionManager.getWaitingSlot(pair.pairId);
  if (waiting && waiting.slot === otherSlot && waiting.clientId !== myClientId && clients.has(waiting.clientId)) {
    return {
      online: true,
      busy: false,
      waitingInPair: true,
      partnerClient: clients.get(waiting.clientId),
    };
  }
  const partnerClient = findOnlineClientForPairSlot(pair, otherSlot, myClientId);
  if (!partnerClient) {
    return { online: false, busy: false, waitingInPair: false, partnerClient: null };
  }
  const busy = partnerClient.state === 'CHATTING'
    || partnerClient.state === 'GROUP_CHATTING'
    || partnerClient.state === 'GAME_ROOM';
  return {
    online: true,
    busy,
    waitingInPair: false,
    partnerClient,
  };
}

function leavePairWaiting(clientId) {
  const client = clients.get(clientId);
  const removed = connectionManager.clearWaitingByClient(clientId);
  connectionManager.clearInvitesForClient(clientId);
  if (client && client.state === 'PAIR_WAITING') {
    client.state = 'CONNECTED';
  }
  if (removed && removed.pairId) {
    connectionManager._loadPair(removed.pairId, { includeHistory: false })
      .then((pair) => {
        if (!pair) return;
        const otherSlot = removed.slot === 'A' ? 'B' : 'A';
        const partnerClient = findOnlineClientForPairSlot(pair, otherSlot, clientId);
        if (partnerClient) {
          sendTo(partnerClient.clientId, serverMsg.pairPresence({
            pairId: pair.pairId,
            partnerOnline: Boolean(clients.has(clientId)),
            partnerWaitingInPair: false,
          }));
        }
      })
      .catch(() => {});
  }
}

async function notifyPairPartnersPresence(client, isOnline) {
  if (!client || !Array.isArray(client.syncedPairLinks) || client.syncedPairLinks.length === 0) return;
  for (const link of client.syncedPairLinks) {
    try {
      const pair = await connectionManager._loadPair(link.pairId, { includeHistory: false });
      if (!pair) continue;
      const otherSlot = link.mySlot === 'A' ? 'B' : 'A';
      const partnerClient = findOnlineClientForPairSlot(pair, otherSlot, client.clientId);
      if (partnerClient) {
        const waiting = connectionManager.getWaitingSlot(pair.pairId);
        sendTo(partnerClient.clientId, serverMsg.pairPresence({
          pairId: pair.pairId,
          partnerOnline: Boolean(isOnline),
          partnerWaitingInPair: Boolean(isOnline && waiting && waiting.clientId === client.clientId),
        }));
      }
    } catch (_) {
      // Bỏ qua lỗi phụ khi gửi presence
    }
  }
}

async function startKeptPairChat(pair, clientA, clientB) {
  if (!pair || !clientA || !clientB) return;

  // Dọn trạng thái chờ / hàng đợi trước khi mở phòng 1-1
  for (const c of [clientA, clientB]) {
    if (c.soloHintTimer) {
      clearTimeout(c.soloHintTimer);
      c.soloHintTimer = null;
    }
    if (c.state === 'WAITING') matchmaker.dequeue(c.clientId);
    if (c.state === 'PAIR_WAITING') connectionManager.clearWaitingByClient(c.clientId);
    if (c.state === 'GROUP_CHATTING') {
      await leaveGroupSession(c.clientId, { silent: true });
    } else if (c.state === 'GAME_ROOM') {
      leaveGameRoomSession(c.clientId, { silent: true });
    }
  }
  connectionManager.clearWaitingPair(pair.pairId);
  connectionManager.clearInvitesForClient(clientA.clientId);
  connectionManager.clearInvitesForClient(clientB.clientId);

  if (!clients.has(clientA.clientId) || !clients.has(clientB.clientId)) return;

  // Cập nhật thông tin hiển thị mới nhất cho cả 2 slot
  await connectionManager.updateSlotProfile(pair, 'A', clientA);
  await connectionManager.updateSlotProfile(pair, 'B', clientB);

  const freshPair = (await connectionManager._loadPair(pair.pairId, { includeHistory: true })) || pair;
  const roomId = roomManager.createRoom(clientA.clientId, clientB.clientId, false, null);
  connectionManager.initRoomSession(roomId, clientA.clientId, clientB.clientId, freshPair);

  const tokenA = resumeSessionManager.createSession(clientA.clientId, roomId);
  const tokenB = resumeSessionManager.createSession(clientB.clientId, roomId);
  if (tokenA) sendTo(clientA.clientId, JSON.stringify({ type: 'resume_token', payload: { token: tokenA } }));
  if (tokenB) sendTo(clientB.clientId, JSON.stringify({ type: 'resume_token', payload: { token: tokenB } }));

  clientA.state = 'CHATTING';
  clientB.state = 'CHATTING';

  const passA = connectionManager.buildPassForSlot(freshPair, 'A');
  const passB = connectionManager.buildPassForSlot(freshPair, 'B');
  sendTo(clientA.clientId, serverMsg.pairKeepPass(passA));
  sendTo(clientB.clientId, serverMsg.pairKeepPass(passB));

  const commonInterests = (clientA.interests || []).filter((tag) => (clientB.interests || []).includes(tag));
  const historyA = connectionManager.formatHistoryForSlot(freshPair, 'A');
  const historyB = connectionManager.formatHistoryForSlot(freshPair, 'B');

  sendTo(clientA.clientId, serverMsg.matchFound(
    clientB.nickname || freshPair.slots.B.nickname,
    commonInterests,
    clientB.mood || freshPair.slots.B.mood,
    false,
    {
      partnerAvatar: clientB.avatar || freshPair.slots.B.avatar || '🦊',
      keptPair: {
        pairId: freshPair.pairId,
        pairCode: freshPair.pairCode,
        mySlot: 'A',
        myKeepVote: true,
        partnerKeepVote: true,
        isKept: true,
        historyCount: historyA.length,
      },
      history: historyA,
    }
  ));

  sendTo(clientB.clientId, serverMsg.matchFound(
    clientA.nickname || freshPair.slots.A.nickname,
    commonInterests,
    clientA.mood || freshPair.slots.A.mood,
    false,
    {
      partnerAvatar: clientA.avatar || freshPair.slots.A.avatar || '🦊',
      keptPair: {
        pairId: freshPair.pairId,
        pairCode: freshPair.pairCode,
        mySlot: 'B',
        myKeepVote: true,
        partnerKeepVote: true,
        isKept: true,
        historyCount: historyB.length,
      },
      history: historyB,
    }
  ));

  console.log(`[Connection] ★ Reconnected kept pair ${freshPair.pairCode}: ${clientA.nickname} ↔ ${clientB.nickname} (restored ${historyA.length} msgs)`);
}

async function initiatePairReconnect(clientId, pair, slot, otherSlot, { issuedPass = null } = {}) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.state === 'CHATTING') {
    sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời cuộc trò chuyện 1-1 hiện tại trước khi kết nối lại.'));
    return;
  }
  if (connectionManager.getActiveRoomForPair(pair.pairId)) {
    sendTo(clientId, serverMsg.error('PAIR_ALREADY_ACTIVE', 'Phòng hẹn của kết nối này hiện đang có đủ 2 người trò chuyện.'));
    return;
  }

  if (client.state === 'WAITING') {
    if (client.soloHintTimer) {
      clearTimeout(client.soloHintTimer);
      client.soloHintTimer = null;
    }
    matchmaker.dequeue(clientId);
    client.state = 'CONNECTED';
  } else if (client.state === 'GROUP_CHATTING') {
    await leaveGroupSession(clientId, { silent: true });
    if (clients.get(clientId) !== client) return;
  } else if (client.state === 'GAME_ROOM') {
    leaveGameRoomSession(clientId, { silent: true });
  } else if (client.state === 'PAIR_WAITING') {
    leavePairWaiting(clientId);
  }

  await connectionManager.updateSlotProfile(pair, slot, client);
  if (issuedPass) {
    sendTo(clientId, serverMsg.pairKeepPass(issuedPass));
  }

  // Trường hợp 1: Đối phương ĐÃ đợi sẵn trong phòng hẹn -> Ghép ngay tức thì!
  const waiting = connectionManager.getWaitingSlot(pair.pairId);
  if (waiting && waiting.slot === otherSlot && waiting.clientId !== clientId) {
    const waitingClient = clients.get(waiting.clientId);
    if (waitingClient && waitingClient.ws.readyState === 1) {
      const clientA = slot === 'A' ? client : waitingClient;
      const clientB = slot === 'A' ? waitingClient : client;
      await startKeptPairChat(pair, clientA, clientB);
      return;
    }
    connectionManager.clearWaitingPair(pair.pairId);
  }

  // Trường hợp 2: Vào phòng hẹn chờ riêng & gửi lời mời nếu đối phương đang online
  connectionManager.setWaitingSlot(pair.pairId, {
    clientId,
    slot,
    nickname: client.nickname || pair.slots[slot].nickname,
    avatar: client.avatar || pair.slots[slot].avatar || '🦊',
  });
  client.state = 'PAIR_WAITING';

  const presence = getPartnerPresenceForPair(pair, otherSlot, clientId);
  let invitedPartner = false;
  if (presence.partnerClient) {
    const invite = connectionManager.createInvite({
      pairId: pair.pairId,
      fromClientId: clientId,
      fromSlot: slot,
      toClientId: presence.partnerClient.clientId,
      toSlot: otherSlot,
    });
    sendTo(presence.partnerClient.clientId, serverMsg.pairInvite({
      inviteId: invite.inviteId,
      pairId: pair.pairId,
      pairCode: pair.pairCode,
      fromNickname: client.nickname || pair.slots[slot].nickname,
      fromAvatar: client.avatar || pair.slots[slot].avatar || '🦊',
      historyCount: pair.history ? pair.history.length : 0,
    }));
    sendTo(presence.partnerClient.clientId, serverMsg.pairPresence({
      pairId: pair.pairId,
      partnerOnline: true,
      partnerWaitingInPair: true,
    }));
    invitedPartner = true;
  }

  const partnerSlot = pair.slots[otherSlot];
  const history = connectionManager.formatHistoryForSlot(pair, slot);

  sendTo(clientId, serverMsg.pairWaiting({
    pairId: pair.pairId,
    pairCode: pair.pairCode,
    partnerNickname: partnerSlot.nickname,
    partnerAvatar: partnerSlot.avatar || '🦊',
    partnerOnline: Boolean(presence.online),
    invitedPartner,
    history,
    message: invitedPartner
      ? `💛 Đã gửi lời mời gặp lại đến ${partnerSlot.nickname}! Đang chờ bạn ấy bấm chấp nhận…`
      : `⏳ ${partnerSlot.nickname} hiện chưa online. Phòng hẹn đang mở (Mã: ${pair.pairCode}) — khi bạn ấy vào lại hoặc nhập mã, hai bạn sẽ tự động kết nối ngay!`,
  }));
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
  const createdRoom = roomManager.getRoom(roomId);
  if (createdRoom) {
    createdRoom.participantProfiles = new Map([
      [entry1.clientId, {
        clientId: entry1.clientId,
        deviceId: entry1.deviceId || entry1.clientId,
        nickname: (client1 && client1.nickname) || entry1.nickname || 'Bạn chat',
        avatar: (client1 && client1.avatar) || '👤',
      }],
      [entry2.clientId, {
        clientId: entry2.clientId,
        deviceId: entry2.deviceId || entry2.clientId,
        nickname: (client2 && client2.nickname) || entry2.nickname || 'Bạn chat',
        avatar: (client2 && client2.avatar) || '👤',
      }],
    ]);
  }
  connectionManager.initRoomSession(roomId, entry1.clientId, entry2.clientId, null);

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
    sendTo(entry1.clientId, serverMsg.matchFound(entry2.nickname, commonInterests, entry2.mood, false, {
      partnerAvatar: (client2 && client2.avatar) || '👤',
    }));
  }
  if (client2) {
    sendTo(entry2.clientId, serverMsg.matchFound(entry1.nickname, commonInterests, entry1.mood, false, {
      partnerAvatar: (client1 && client1.avatar) || '👤',
    }));
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
  if (client.state === 'PAIR_WAITING') {
    leavePairWaiting(clientId);
  }
  if (client.state === 'CHATTING') {
    const oldRoomId = roomManager.getRoomId(clientId);
    closeEmbedded1v1Game(oldRoomId, { closedByName: client.nickname });
    connectionManager.cleanupRoomSession(oldRoomId);
    roomManager.removeClient(clientId);
  } else if (client.state === 'GROUP_CHATTING') {
    leaveGroupSession(clientId, { silent: true }).catch((error) => {
      console.error('[Group] Failed to leave group before solo:', error.message);
    });
  } else if (client.state === 'GAME_ROOM') {
    leaveGameRoomSession(clientId, { silent: true });
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

  if (!redisManager.enabled) {
    const banStatus = moderation.isBanned(clientId, client.clientIp);
    if (banStatus && banStatus.banned) {
      sendTo(clientId, serverMsg.error(
        ERROR_CODES.BANNED,
        `Bạn đang bị cấm trong ${banStatus.remainingSec} giây nữa.`
      ));
      return false;
    }
    return true;
  }

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
      avatar: oldClient.avatar || '🦊',
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

    // Đồng bộ lại minigame nhúng 1-1 nếu hai người đang chơi dở trước khi mất kết nối
    sendActiveEmbedded1v1GameIfAny(roomId, oldId);

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

    // Kiểm duyệt biệt danh chống xúc phạm / spam nội dung vi phạm
    const nickCheck = checkContent(payload.nickname);
    if (nickCheck.isViolation) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.INVALID_PAYLOAD, 'Biệt danh chứa nội dung không phù hợp. Vui lòng chọn tên khác.'));
      return;
    }

    if (client.nickname) {
      // Đã join rồi → update nickname/interests/mood/deviceId/avatar
      client.nickname = payload.nickname;
      client.interests = payload.interests;
      client.mood = payload.mood || 'ngau_nhien';
      client.deviceId = payload.deviceId || client.deviceId || null;
      client.avatar = payload.avatar || client.avatar || '🦊';
      console.log(`[Server] Re-join: ${payload.nickname} (${clientId}) [deviceId=${client.deviceId}, mood=${client.mood}]`);
      return;
    }

    client.nickname = payload.nickname;
    client.interests = payload.interests;
    client.mood = payload.mood || 'ngau_nhien';
    client.deviceId = payload.deviceId || null;
    client.avatar = payload.avatar || '🦊';
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
    if (client.state === 'PAIR_WAITING') {
      leavePairWaiting(clientId);
    }
    if (client.state === 'CHATTING' || client.state === 'GROUP_CHATTING' || client.state === 'GAME_ROOM') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Bạn đang trong phòng chat hoặc phòng game'));
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

    // Định tuyến riêng cho trò chuyện nhóm ẩn danh và phòng game
    if (client.state === 'GROUP_CHATTING') {
      return handleGroupTextMessage(clientId, payload);
    }
    if (client.state === 'GAME_ROOM') {
      return handleGameRoomTextMessage(clientId, payload);
    }

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

    // Kiểm tra nếu đang ở phòng trò chuyện cùng Bạn Đồng Hành Lumi
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (bot) {
        // Lumi trả lời bất đồng bộ (Groq hoặc kịch bản offline), không chặn vòng lặp WebSocket
        Promise.resolve(bot.handleUserMessage(payload.text)).catch((error) => console.error('[Server] Lỗi khi Lumi xử lý tin nhắn:', error.message));
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
      console.error('[SafeBrowsing] Could not check message links:', error.message);
      reputation = { status: 'unavailable', checkedCount: 0, threatTypes: [], complete: false };
    }

    const currentClient = clients.get(clientId);
    if (!currentClient || currentClient.state !== 'CHATTING' || roomManager.getPartnerId(clientId) !== partnerId) return;

    const unsafeScheme = linkSafety.reasons.some((reason) => reason.includes('giao thức không an toàn'));
    const hasLinkSignal = linkSafety.hasLinks || unsafeScheme;
    const reputationWarning = {
      hasLinks: hasLinkSignal,
      suspicious: linkSafety.suspicious || reputation.status === 'threat' || reputation.status === 'limit_exceeded',
      reasons: [...linkSafety.reasons],
      reputation: reputation.status,
      threatTypes: reputation.threatTypes,
    };
    if (reputation.status === 'threat') {
      reputationWarning.source = 'google_safe_browsing';
    }

    if (reputation.status === 'threat' || reputation.status === 'limit_exceeded' || unsafeScheme) {
      reputationWarning.blocked = true;
      if (reputation.status === 'threat') {
        reputationWarning.blockedReason = 'threat';
        reputationWarning.reasons.push('Google Safe Browsing đánh dấu liên kết này có thể nguy hiểm.');
      } else if (reputation.status === 'limit_exceeded') {
        reputationWarning.blockedReason = 'limit_exceeded';
        reputationWarning.reasons.push('Tin nhắn vượt quá giới hạn 5 URL được kiểm tra.');
      } else {
        reputationWarning.blockedReason = 'unsafe_scheme';
        reputationWarning.reasons.push('Tin nhắn chứa giao thức liên kết không an toàn.');
      }
      sendTo(clientId, serverMsg.linkWarning(reputationWarning));
      sendTo(partnerId, serverMsg.linkWarning(reputationWarning));
      return;
    }

    const timestamp = new Date().toISOString();
    const messageLinkSafety = hasLinkSignal
      && (linkSafety.suspicious || reputation.status === 'threat')
      ? reputationWarning
      : null;
    const activeChatRoomId = roomManager.getRoomId(clientId);
    if (activeChatRoomId) {
      connectionManager.recordRoomMessage(activeChatRoomId, clientId, {
        type: 'message',
        text: payload.text,
        linkSafety: messageLinkSafety,
        timestamp,
      }).catch((err) => console.error('[Connection] record text error:', err.message));
    }
    sendTo(partnerId, serverMsg.message(payload.text, timestamp, messageLinkSafety));
    if (hasLinkSignal && (linkSafety.suspicious || reputation.status === 'threat')) {
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
    if (redisManager.enabled && !redisManager.isConnected) {
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
      const attachRoomId = roomManager.getRoomId(clientId);
      if (attachRoomId) {
        connectionManager.recordRoomMessage(attachRoomId, clientId, {
          type: 'attachment',
          attachment,
          timestamp,
        }).catch((err) => console.error('[Connection] record attachment error:', err.message));
      }
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
    if (!client) return;

    if (client.state === 'GROUP_CHATTING') {
      const groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      const now = Date.now();
      // Giới hạn tần suất gửi trạng thái đang gõ trong phòng đông (tối đa 60 người)
      if (payload.isTyping && now - (client.lastGroupTypingAt || 0) < 900) return;
      client.lastGroupTypingAt = now;
      const member = await groupManager.getGroupMember(groupId, clientId);
      broadcastToGroup(
        groupId,
        serverMsg.groupTyping({
          groupId,
          clientId,
          nickname: (member && member.nickname) || client.nickname,
          isTyping: payload.isTyping,
        }),
        clientId
      );
      return;
    }

    if (client.state === 'GAME_ROOM') {
      const roomId = gameRoomManager.getRoomId(clientId);
      if (!roomId) return;
      const now = Date.now();
      if (payload.isTyping && now - (client.lastGroupTypingAt || 0) < 900) return;
      client.lastGroupTypingAt = now;
      const player = gameRoomManager.getPlayer(roomId, clientId);
      broadcastToGameRoom(
        roomId,
        serverMsg.gameRoomTyping({
          roomId,
          clientId,
          nickname: (player && player.nickname) || client.nickname,
          isTyping: payload.isTyping,
        }),
        clientId
      );
      return;
    }

    if (client.state !== 'CHATTING') return;

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
    if (!client) return;

    if (client.state === 'GROUP_CHATTING') {
      const groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      if (!moderation.checkRateLimit(clientId)) {
        sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ.'));
        return;
      }
      if (!(await ensureNotGroupBanned(clientId))) return;
      if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

      const member = await groupManager.getGroupMember(groupId, clientId);
      const timestamp = new Date().toISOString();
      const voiceRecord = {
        id: uuidv4(),
        type: 'voice',
        groupId,
        senderClientId: clientId,
        senderNickname: (member && member.nickname) || client.nickname,
        senderAvatar: client.avatar || '🦊',
        voiceId: payload.voiceId,
        url: payload.url,
        duration: payload.duration,
        timestamp,
      };
      groupManager.recordHistoryMessage(groupId, voiceRecord).catch(() => {});
      broadcastToGroup(groupId, serverMsg.groupVoice(voiceRecord), clientId);
      return;
    }

    if (client.state === 'GAME_ROOM') {
      const roomId = gameRoomManager.getRoomId(clientId);
      if (!roomId) return;
      if (!moderation.checkRateLimit(clientId)) {
        sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ.'));
        return;
      }
      if (!(await ensureNotGroupBanned(clientId))) return;
      if (clients.get(clientId) !== client || client.state !== 'GAME_ROOM' || gameRoomManager.getRoomId(clientId) !== roomId) return;

      const player = gameRoomManager.getPlayer(roomId, clientId);
      broadcastToGameRoom(roomId, serverMsg.gameRoomVoice({
        id: uuidv4(),
        roomId,
        senderClientId: clientId,
        senderNickname: (player && player.nickname) || client.nickname,
        senderAvatar: client.avatar || '🦊',
        voiceId: payload.voiceId,
        url: payload.url,
        duration: payload.duration,
        timestamp: new Date().toISOString(),
      }), clientId);
      return;
    }

    if (client.state !== 'CHATTING') {
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

    const voiceRoomId = roomManager.getRoomId(clientId);
    if (voiceRoomId) {
      connectionManager.recordRoomMessage(voiceRoomId, clientId, {
        type: 'voice',
        voiceId: payload.voiceId,
        url: payload.url,
        duration: payload.duration,
        timestamp,
      }).catch((err) => console.error('[Connection] record voice error:', err.message));
    }

    sendTo(partnerId, serverMsg.voice({
      voiceId: payload.voiceId,
      url: payload.url,
      duration: payload.duration,
    }, timestamp));
  },

  // ── meme & sticker ────────────────────────────────────
  async [CLIENT_TYPES.MEME](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    if (payload.title && checkContent(payload.title).isViolation) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.INVALID_PAYLOAD, 'Tiêu đề nhãn dán/meme chứa nội dung không phù hợp.'));
      return;
    }

    if (client.state === 'GROUP_CHATTING') {
      const groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      if (!moderation.checkRateLimit(clientId)) {
        sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ.'));
        return;
      }
      if (!(await ensureNotGroupBanned(clientId))) return;
      if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

      const member = await groupManager.getGroupMember(groupId, clientId);
      const timestamp = new Date().toISOString();
      const memeRecord = {
        id: uuidv4(),
        type: 'meme',
        groupId,
        senderClientId: clientId,
        senderNickname: (member && member.nickname) || client.nickname,
        senderAvatar: client.avatar || '🦊',
        url: payload.url,
        title: payload.title,
        memeId: payload.memeId,
        isSticker: Boolean(payload.isSticker),
        timestamp,
      };
      groupManager.recordHistoryMessage(groupId, memeRecord).catch(() => {});
      broadcastToGroup(groupId, serverMsg.groupMeme(memeRecord), clientId);
      return;
    }

    if (client.state === 'GAME_ROOM') {
      const roomId = gameRoomManager.getRoomId(clientId);
      if (!roomId) return;
      if (!moderation.checkRateLimit(clientId)) {
        sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ.'));
        return;
      }
      if (!(await ensureNotGroupBanned(clientId))) return;
      if (clients.get(clientId) !== client || client.state !== 'GAME_ROOM' || gameRoomManager.getRoomId(clientId) !== roomId) return;

      const player = gameRoomManager.getPlayer(roomId, clientId);
      broadcastToGameRoom(roomId, serverMsg.gameRoomMeme({
        id: uuidv4(),
        roomId,
        senderClientId: clientId,
        senderNickname: (player && player.nickname) || client.nickname,
        senderAvatar: client.avatar || '🦊',
        url: payload.url,
        title: payload.title,
        memeId: payload.memeId,
        isSticker: Boolean(payload.isSticker),
        timestamp: new Date().toISOString(),
      }), clientId);
      return;
    }

    if (client.state !== 'CHATTING') {
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

    const memeRoomId = roomManager.getRoomId(clientId);
    if (memeRoomId) {
      connectionManager.recordRoomMessage(memeRoomId, clientId, {
        type: 'meme',
        url: payload.url,
        title: payload.title,
        memeId: payload.memeId,
        isSticker,
        timestamp,
      }).catch((err) => console.error('[Connection] record meme error:', err.message));
    }

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
      closeEmbedded1v1Game(roomBeforeCheck, { silent: true });
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

    closeEmbedded1v1Game(roomBeforeCheck, { silent: true });
    connectionManager.cleanupRoomSession(roomBeforeCheck);
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
  async [CLIENT_TYPES.LEAVE_ROOM](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId);
      return;
    }

    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId);
      return;
    }

    if (client.state === 'PAIR_WAITING') {
      leavePairWaiting(clientId);
      return;
    }

    if (client.state !== 'CHATTING') return;

    // Nếu đang ở phòng Bot Đồng Hành Lumi
    if (roomManager.isBotRoom(clientId)) {
      closeEmbedded1v1Game(roomManager.getRoomId(clientId), { silent: true });
      roomManager.removeClient(clientId);
      client.state = 'CONNECTED';
      console.log(`[Server] Leave Room: ${client.nickname} (${clientId}) rời phòng Bot về trang chủ`);
      return;
    }

    // Lấy thông tin đối phương trước khi xóa phòng
    const leaveRoomId = roomManager.getRoomId(clientId);
    const partnerId = roomManager.getPartnerId(clientId);

    closeEmbedded1v1Game(leaveRoomId, { silent: true });
    connectionManager.cleanupRoomSession(leaveRoomId);
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

    const reportRoomId = roomManager.getRoomId(clientId);
    closeEmbedded1v1Game(reportRoomId, { silent: true });
    // Nếu 2 người từng "Giữ kết nối", báo cáo sẽ tự động xóa vĩnh viễn kết nối đó ở cả 2 phía!
    const reportPairSess = connectionManager.getRoomSession(reportRoomId);
    if (reportPairSess && reportPairSess.pairId) {
      const removedPairId = reportPairSess.pairId;
      connectionManager.removePairById(removedPairId).catch(() => {});
      sendTo(clientId, serverMsg.pairRemoved(removedPairId, 'Đã hủy Giữ kết nối sau khi báo cáo vi phạm.'));
      sendTo(partnerId, serverMsg.pairRemoved(removedPairId, 'Kết nối đã bị hủy.'));
    }
    connectionManager.cleanupRoomSession(reportRoomId);
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
    if (!client) return;

    if (client.state === 'GROUP_CHATTING') {
      const groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      if (!moderation.checkRateLimit(clientId)) {
        sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn thao tác quá nhanh, vui lòng chờ.'));
        return;
      }
      if (!(await ensureNotGroupBanned(clientId))) return;
      if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

      const member = await groupManager.getGroupMember(groupId, clientId);
      const prompt = getRandomIcebreaker();
      broadcastToGroup(groupId, serverMsg.groupIcebreaker(prompt.text, prompt.category, (member && member.nickname) || client.nickname));
      return;
    }

    if (client.state !== 'CHATTING') return;


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

  // ── game_invite (mời chơi minigame 1-1: Caro, Đố Vui, Nối Từ, Đấu Trí Tâm Lý) ──
  async [CLIENT_TYPES.GAME_INVITE](clientId, payload) {
    if (!(await canPerformGameAction(clientId))) return;

    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const chatRoomId = roomManager.getRoomId(clientId);
    if (!chatRoomId) return;

    const gameType = (payload && payload.gameType) || 'caro';
    const requestedSize = (payload && [10, 15, 20].includes(payload.size)) ? payload.size : 10;

    // ── Nhánh 1: Các game mới (Đố Vui Tốc Độ, Nối Từ Thần Tốc, Đấu Trí Tâm Lý) ──
    if (gameType !== 'caro') {
      const info = GAME_CATALOG[gameType];
      if (!info) return;

      // Phòng Bot Lumi -> Bắt đầu chơi ngay lập tức với AI Lumi!
      if (roomManager.isBotRoom(clientId)) {
        const bot = roomManager.getBot(clientId);
        if (!bot) return;
        roomManager.quitGame(chatRoomId);
        const botInfo = bot.getPartnerInfo();
        embeddedGameManager.createEmbeddedSession(`chat:${chatRoomId}`, client, {
          gameType,
          maxPlayers: 2,
          name: `${info.icon} ${info.name} cùng ${botInfo.nickname}`,
          contextType: '1v1',
          isBotSession: true,
          botClientId: bot.botClientId,
          allowAnyPlayerControl: true,
          initialPlayers: [{
            clientId: bot.botClientId,
            deviceId: bot.botClientId,
            nickname: botInfo.nickname,
            avatar: '🤖',
          }],
          autoStart: true,
        });
        setTimeout(() => {
          if (!clients.has(clientId) || !roomManager.isBotRoom(clientId)) return;
          sendTo(
            clientId,
            serverMsg.message(
              `Chốt kèo ${info.icon} ${info.name} luôn nè! Lumi sẵn sàng so tài cùng bạn rồi đó 😉✨`,
              new Date().toISOString()
            )
          );
        }, 350);
        return;
      }

      // Phòng 1-1 người thật -> Gửi lời mời kèm tên trò chơi cho đối phương
      const partnerId = roomManager.getPartnerId(clientId);
      if (!partnerId) return;

      sendTo(partnerId, serverMsg.gameState({
        action: 'invite',
        gameType,
        gameName: info.name,
        gameIcon: info.icon,
        fromId: clientId,
        fromName: client.nickname,
      }));

      sendTo(clientId, serverMsg.gameState({
        action: 'invite_sent',
        gameType,
        gameName: info.name,
        gameIcon: info.icon,
      }));
      return;
    }

    // ── Nhánh 2: Cờ Caro 1-1 truyền thống (giữ nguyên 100%) ──
    closeEmbedded1v1Game(chatRoomId, { silent: true });

    // Nếu là phòng Bot -> Bot tự động chấp nhận ngay lập tức!
    if (roomManager.isBotRoom(clientId)) {
      const bot = roomManager.getBot(clientId);
      if (!bot) return;
      const game = roomManager.initGame(chatRoomId, clientId, bot.botClientId, requestedSize);
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
      gameType: 'caro',
      fromId: clientId,
      fromName: client.nickname,
      size: requestedSize,
    }));

    sendTo(clientId, serverMsg.gameState({
      action: 'invite_sent',
      gameType: 'caro',
      size: requestedSize,
    }));
  },

  // ── game_accept (nhận lời chơi minigame 1-1) ──────────
  async [CLIENT_TYPES.GAME_ACCEPT](clientId, payload) {
    if (!(await canPerformGameAction(clientId))) return;

    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') return;

    const roomId = roomManager.getRoomId(clientId);
    const partnerId = roomManager.getPartnerId(clientId);
    if (!roomId || !partnerId) return;

    const gameType = (payload && payload.gameType) || 'caro';

    // ── Nhánh 1: Chấp nhận lời mời chơi game mới (Đố Vui / Nối Từ / Đấu Trí Tâm Lý) ──
    if (gameType !== 'caro') {
      const info = GAME_CATALOG[gameType];
      if (!info) return;

      // Đóng bàn Caro cũ nếu đang mở
      roomManager.quitGame(roomId);
      if (redisManager.enabled) {
        caroStore.quitGame(redisManager, roomId).catch(() => {});
      }

      const partnerClient = clients.get(partnerId);
      const storedPartnerProfile = roomManager.getRoom(roomId)?.participantProfiles?.get(partnerId) || null;
      const hostUser = partnerClient || storedPartnerProfile || {
        clientId: partnerId,
        deviceId: partnerId,
        nickname: 'Bạn chat',
        avatar: '👤',
      };

      embeddedGameManager.createEmbeddedSession(`chat:${roomId}`, hostUser, {
        gameType,
        maxPlayers: 2,
        name: `${info.icon} ${info.name} (1-1)`,
        contextType: '1v1',
        isBotSession: false,
        allowAnyPlayerControl: true,
        initialPlayers: [client],
        autoStart: true,
      });
      return;
    }

    // ── Nhánh 2: Chấp nhận cờ Caro 1-1 truyền thống ──
    closeEmbedded1v1Game(roomId, { silent: true });

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
        const humanSymbol = result.game.xPlayer === clientId ? 'X' : 'O';
        const comment = result.game.winner === humanSymbol ? bot.getGameComment('playerWin') : bot.getGameComment('draw');
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
          if (currentRoom.game.turn !== bot.botClientId) return;
          const botSymbol = currentRoom.game.xPlayer === bot.botClientId ? 'X' : 'O';
          const humanSymbol = botSymbol === 'X' ? 'O' : 'X';
          const botMove = bot.computeMove(currentRoom.game.board, botSymbol, humanSymbol);
          if (botMove >= 0) {
            const botResult = roomManager.makeGameMove(roomId, bot.botClientId, botMove);
            if (botResult.ok) {
              sendTo(clientId, serverMsg.gameState({ action: 'update', game: botResult.game }));
              if (botResult.game.status === 'ended') {
                const comment = botResult.game.winner === botSymbol ? bot.getGameComment('botWin') : bot.getGameComment('draw');
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
      const bot = roomManager.getBot(clientId);
      const game = roomManager.resetGame(roomId, requestedSize);
      if (!game) return;
      sendTo(clientId, serverMsg.gameState({ action: 'start', game }));
      const botGoesFirst = Boolean(bot && game.turn === bot.botClientId);
      setTimeout(() => {
        if (!clients.has(clientId) || !roomManager.isBotRoom(clientId)) return;
        sendTo(
          clientId,
          serverMsg.message(
            botGoesFirst
              ? 'Ván mới bắt đầu rồi! Lượt này Lumi cầm quân X đi trước nha 🌟'
              : 'Ván mới bắt đầu rồi! Cố lên bạn nhé, bạn cầm quân X đi trước nha 🌟',
            new Date().toISOString()
          )
        );
      }, 300);
      if (botGoesFirst) {
        setTimeout(() => {
          const currentRoom = roomManager.getRoom(roomId);
          if (!currentRoom || !currentRoom.game || currentRoom.game.status !== 'playing') return;
          if (currentRoom.game.turn !== bot.botClientId) return;
          const botMove = bot.computeMove(currentRoom.game.board, 'X', 'O');
          if (botMove >= 0) {
            const botResult = roomManager.makeGameMove(roomId, bot.botClientId, botMove);
            if (botResult.ok) {
              sendTo(clientId, serverMsg.gameState({ action: 'update', game: botResult.game }));
            }
          }
        }, 650);
      }
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

  // ══════════════════════════════════════════════════════════════════════════
  // TRÒ CHUYỆN NHÓM ẨN DANH (TỐI ĐA 60 THÀNH VIÊN / TỰ BIẾN MẤT / GIỮ >= 3)
  // ══════════════════════════════════════════════════════════════════════════

  async [CLIENT_TYPES.GROUP_FIND](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (payload.topic) {
      const topicCheck = checkContent(payload.topic);
      if (topicCheck.isViolation) {
        sendTo(clientId, serverMsg.error('INVALID_PAYLOAD', 'Chủ đề nhóm chứa nội dung không phù hợp. Vui lòng chọn chủ đề khác.'));
        return;
      }
    }

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi vào nhóm.'));
      return;
    }

    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }

    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId, { silent: true });
    }

    let excludeGroupId = payload.excludeGroupId || null;
    if (client.state === 'GROUP_CHATTING') {
      excludeGroupId = groupManager.getGroupId(clientId) || excludeGroupId;
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }

    if (redisManager.enabled) {
      try {
        await redisManager.addOnlineClient(clientId);
      } catch (error) {
        sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Hệ thống phòng nhóm đang khởi động hoặc tạm thời gián đoạn. Vui lòng thử lại.'));
        return;
      }
      if (clients.get(clientId) !== client) return;
    }

    let result;
    try {
      result = await groupManager.findOrCreateGroup(client, {
        ...payload,
        excludeGroupId,
      });
    } catch (error) {
      console.error('[Group] findOrCreateGroup error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể tìm nhóm lúc này. Vui lòng thử lại sau.'));
      return;
    }

    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GROUP_ERROR', result.error));
      return;
    }

    client.state = 'GROUP_CHATTING';
    client.groupId = result.group.groupId;

    sendTo(clientId, serverMsg.groupJoined(result.group));
    if (!result.created) {
      broadcastToGroup(
        result.group.groupId,
        serverMsg.groupMemberJoined(result.group.groupId, result.member, result.group.memberCount, result.renamedMembers || []),
        clientId
      );
      sendActiveGroupGameIfAny(result.group.groupId, clientId);
    }
  },

  async [CLIENT_TYPES.GROUP_CREATE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!resourceCreateLimiter.check(clientId).allowed) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn tạo phòng quá nhanh, vui lòng chờ 1 phút.'));
      return;
    }
    if (!redisManager.enabled && groupManager.groups.size >= MAX_ACTIVE_GROUPS) {
      sendTo(clientId, serverMsg.error('GROUP_LIMIT_REACHED', 'Hệ thống đang có quá nhiều phòng nhóm hoạt động. Hãy tham gia một nhóm có sẵn.'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    const textToFilter = `${payload.name || ''} ${payload.topic || ''}`.trim();
    if (textToFilter) {
      const check = checkContent(textToFilter);
      if (check.isViolation) {
        sendTo(clientId, serverMsg.error('INVALID_PAYLOAD', 'Tên hoặc chủ đề nhóm chứa nội dung không phù hợp.'));
        return;
      }
    }

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi tạo nhóm.'));
      return;
    }
    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }
    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId, { silent: true });
    }
    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }

    let result;
    try {
      result = await groupManager.createGroup(client, payload);
    } catch (error) {
      console.error('[Group] createGroup error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể tạo nhóm lúc này. Vui lòng thử lại sau.'));
      return;
    }

    client.state = 'GROUP_CHATTING';
    client.groupId = result.group.groupId;
    sendTo(clientId, serverMsg.groupJoined(result.group));
  },

  async [CLIENT_TYPES.GROUP_JOIN](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi vào nhóm.'));
      return;
    }
    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }
    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId, { silent: true });
    }
    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }

    let result;
    try {
      result = await groupManager.joinGroupById(client, payload.groupId);
    } catch (error) {
      console.error('[Group] joinGroupById error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể vào nhóm lúc này.'));
      return;
    }

    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GROUP_ERROR', result.error));
      return;
    }

    client.state = 'GROUP_CHATTING';
    client.groupId = result.group.groupId;
    sendTo(clientId, serverMsg.groupJoined(result.group));
    broadcastToGroup(
      result.group.groupId,
      serverMsg.groupMemberJoined(result.group.groupId, result.member, result.group.memberCount, result.renamedMembers || []),
      clientId
    );
    sendActiveGroupGameIfAny(result.group.groupId, clientId);
  },

  async [CLIENT_TYPES.GROUP_REJOIN](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi vào lại nhóm.'));
      return;
    }
    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }
    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId, { silent: true });
    }
    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }

    let result;
    try {
      result = await groupManager.rejoinKeptGroup(client, payload.groupId, payload.rejoinToken);
    } catch (error) {
      console.error('[Group] rejoinKeptGroup error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể vào lại nhóm lúc này.'));
      return;
    }

    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GROUP_NOT_FOUND', result.error));
      return;
    }

    client.state = 'GROUP_CHATTING';
    client.groupId = result.group.groupId;
    sendTo(clientId, serverMsg.groupJoined(result.group));
    broadcastToGroup(
      result.group.groupId,
      serverMsg.groupMemberJoined(result.group.groupId, result.member, result.group.memberCount, result.renamedMembers || []),
      clientId
    );
    sendActiveGroupGameIfAny(result.group.groupId, clientId);
  },

  async [CLIENT_TYPES.GROUP_LEAVE](clientId) {
    await leaveGroupSession(clientId);
  },

  async [CLIENT_TYPES.GROUP_VOTE_KEEP](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'GROUP_CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng nhóm.'));
      return;
    }

    let result;
    try {
      result = await groupManager.setKeepVote(clientId, payload.keep);
    } catch (error) {
      console.error('[Group] setKeepVote error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể cập nhật lựa chọn giữ nhóm lúc này.'));
      return;
    }

    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GROUP_ERROR', result.error));
      return;
    }

    for (const pass of result.activeVoterPasses) {
      sendTo(pass.clientId, serverMsg.groupKeepPass(pass));
    }

    broadcastToGroup(result.groupId, serverMsg.groupKeepUpdated({
      groupId: result.groupId,
      voterClientId: result.voterClientId,
      voterNickname: result.voterNickname,
      wantsKeep: result.wantsKeep,
      keepCount: result.keepCount,
      minKeepVotes: result.minKeepVotes,
      isKept: result.isKept,
      justActivated: result.justActivated,
      justDeactivated: result.justDeactivated,
    }));
  },

  async [CLIENT_TYPES.GROUP_UNKEEP](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    let result;
    try {
      result = await groupManager.unkeepSavedGroup(payload.groupId, payload.rejoinToken);
    } catch (error) {
      console.error('[Group] unkeepSavedGroup error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể bỏ giữ nhóm lúc này.'));
      return;
    }

    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GROUP_ERROR', result.error));
      return;
    }

    if (!result.destroyed && result.memberCount > 0) {
      broadcastToGroup(result.groupId, serverMsg.groupKeepUpdated({
        groupId: result.groupId,
        voterClientId: null,
        voterNickname: client.nickname || 'Một thành viên',
        wantsKeep: false,
        keepCount: result.keepCount,
        minKeepVotes: result.minKeepVotes,
        isKept: result.isKept,
        justActivated: false,
        justDeactivated: !result.isKept,
      }));
    }

    sendTo(clientId, serverMsg.groupUnkept(result));
  },

  async [CLIENT_TYPES.GROUP_LIST](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    try {
      const groups = await groupManager.listPublicGroups(payload);
      sendTo(clientId, serverMsg.groupList(groups, groupManager.maxMembers));
    } catch (error) {
      console.error('[Group] listPublicGroups error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể tải danh sách nhóm lúc này.'));
    }
  },

  async [CLIENT_TYPES.GROUP_SYNC_SAVED](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    try {
      const { groups, expiredGroupIds } = await groupManager.syncSavedGroups(payload.passes);
      sendTo(clientId, serverMsg.groupSavedList(groups, expiredGroupIds));
    } catch (error) {
      console.error('[Group] syncSavedGroups error:', error.message);
      sendTo(clientId, serverMsg.error('GROUP_UNAVAILABLE', 'Không thể đồng bộ danh sách nhóm đã giữ.'));
    }
  },

  async [CLIENT_TYPES.GROUP_REPORT](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'GROUP_CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng nhóm để báo cáo.'));
      return;
    }
    const groupId = groupManager.getGroupId(clientId);
    if (!groupId || payload.targetClientId === clientId) return;

    const targetMember = await groupManager.getGroupMember(groupId, payload.targetClientId);
    if (!targetMember) {
      sendTo(clientId, serverMsg.error('MEMBER_NOT_FOUND', 'Thành viên này không còn trong nhóm.'));
      return;
    }

    moderation.addReport(
      client,
      { clientId: targetMember.clientId, deviceId: targetMember.memberKey },
      `[Group ${groupId}] ${payload.reason}`
    );
    if (redisManager.isConnected) {
      redisManager.addBlock(client.deviceId || clientId, targetMember.memberKey || targetMember.clientId, 300);
    }

    sendTo(clientId, serverMsg.reported());
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PHÒNG GAME NHIỀU NGƯỜI ẨN DANH (2 – 10 NGƯỜI / PHÒNG)
  // ══════════════════════════════════════════════════════════════════════════

  async [CLIENT_TYPES.GAME_ROOM_FIND](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi vào phòng game.'));
      return;
    }
    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }
    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }

    let excludeRoomId = payload.excludeRoomId || null;
    if (client.state === 'GAME_ROOM') {
      excludeRoomId = gameRoomManager.getRoomId(clientId) || excludeRoomId;
      leaveGameRoomSession(clientId, { silent: true });
    }

    const result = gameRoomManager.findOrCreateRoom(client, {
      gameType: payload.gameType,
      excludeRoomId,
    });
    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GAME_ROOM_ERROR', result.error));
      return;
    }

    client.state = 'GAME_ROOM';
    client.gameRoomId = result.room.roomId;

    sendTo(clientId, serverMsg.gameRoomJoined(result.room));
    if (!result.created) {
      broadcastToGameRoom(
        result.room.roomId,
        serverMsg.gameRoomPlayerJoined(
          result.room.roomId,
          result.player,
          result.room.playerCount,
          result.renamedMembers || []
        ),
        clientId
      );
    }
  },

  async [CLIENT_TYPES.GAME_ROOM_CREATE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!resourceCreateLimiter.check(clientId).allowed) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn tạo phòng quá nhanh, vui lòng chờ 1 phút.'));
      return;
    }
    if (gameRoomManager.rooms.size >= MAX_ACTIVE_GAME_ROOMS) {
      sendTo(clientId, serverMsg.error('GAME_ROOM_LIMIT_REACHED', 'Hệ thống đang có quá nhiều phòng game. Hãy tham gia phòng sẵn có.'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (payload.name && checkContent(payload.name).isViolation) {
      sendTo(clientId, serverMsg.error('INVALID_PAYLOAD', 'Tên phòng game chứa nội dung không phù hợp.'));
      return;
    }
    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi tạo phòng game.'));
      return;
    }
    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }
    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }
    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId, { silent: true });
    }

    const result = gameRoomManager.createRoom(client, payload);
    client.state = 'GAME_ROOM';
    client.gameRoomId = result.room.roomId;
    sendTo(clientId, serverMsg.gameRoomJoined(result.room));
  },

  async [CLIENT_TYPES.GAME_ROOM_JOIN](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời phòng chat 1-1 trước khi vào phòng game.'));
      return;
    }
    if (client.state === 'WAITING') {
      if (client.soloHintTimer) {
        clearTimeout(client.soloHintTimer);
        client.soloHintTimer = null;
      }
      matchmaker.dequeue(clientId);
      client.state = 'CONNECTED';
    }
    if (client.state === 'GROUP_CHATTING') {
      await leaveGroupSession(clientId, { silent: true });
      if (clients.get(clientId) !== client) return;
    }
    if (client.state === 'GAME_ROOM') {
      leaveGameRoomSession(clientId, { silent: true });
    }

    const result = gameRoomManager.joinRoom(client, payload);
    if (!result.ok) {
      sendTo(clientId, serverMsg.error(result.code || 'GAME_ROOM_ERROR', result.error));
      return;
    }

    client.state = 'GAME_ROOM';
    client.gameRoomId = result.room.roomId;
    sendTo(clientId, serverMsg.gameRoomJoined(result.room));
    broadcastToGameRoom(
      result.room.roomId,
      serverMsg.gameRoomPlayerJoined(
        result.room.roomId,
        result.player,
        result.room.playerCount,
        result.renamedMembers || []
      ),
      clientId
    );
  },

  [CLIENT_TYPES.GAME_ROOM_LEAVE](clientId) {
    leaveGameRoomSession(clientId);
  },

  [CLIENT_TYPES.GAME_ROOM_LIST](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    const rooms = gameRoomManager.listRooms(payload);
    sendTo(clientId, serverMsg.gameRoomList(rooms, gameRoomManager.maxPlayers, Object.values(GAME_CATALOG)));
  },

  [CLIENT_TYPES.GAME_ROOM_SELECT_GAME](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'GAME_ROOM') return;
    const res = gameRoomManager.selectGame(clientId, payload.gameType);
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('GAME_ROOM_ERROR', res.error));
    }
  },

  async [CLIENT_TYPES.GAME_ROOM_START](clientId) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'GAME_ROOM') return;
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client || client.state !== 'GAME_ROOM') return;

    const res = gameRoomManager.startGame(clientId);
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('GAME_ROOM_ERROR', res.error));
    }
  },

  async [CLIENT_TYPES.GAME_ROOM_ACTION](clientId, payload) {
    const receivedAt = Date.now();
    const client = clients.get(clientId);
    if (!client || client.state !== 'GAME_ROOM') return;
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client || client.state !== 'GAME_ROOM') return;

    const res = gameRoomManager.handleAction(clientId, payload, { receivedAt });
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('GAME_ROOM_ACTION_ERROR', res.error));
    }
  },

  [CLIENT_TYPES.GAME_ROOM_REPORT](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'GAME_ROOM') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong phòng game để báo cáo.'));
      return;
    }
    const roomId = gameRoomManager.getRoomId(clientId);
    if (!roomId || payload.targetClientId === clientId) return;

    const target = gameRoomManager.getPlayer(roomId, payload.targetClientId);
    if (!target) {
      sendTo(clientId, serverMsg.error('MEMBER_NOT_FOUND', 'Người chơi này không còn trong phòng game.'));
      return;
    }

    moderation.addReport(
      client,
      { clientId: target.clientId, deviceId: target.memberKey },
      `[GameRoom ${roomId}] ${payload.reason}`
    );
    if (redisManager.isConnected) {
      redisManager.addBlock(client.deviceId || clientId, target.memberKey || target.clientId, 300);
    }
    sendTo(clientId, serverMsg.reported());
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MINIGAME NHÚNG NGAY TRONG CHAT 1-1 / LUMI AI / NHÓM CHAT (CHƠI Ở NGOÀI)
  // ══════════════════════════════════════════════════════════════════════════

  async [CLIENT_TYPES.CHAT_GAME_OPEN](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state === 'CHATTING') {
      if (payload.gameType === 'undercover') {
        sendTo(clientId, serverMsg.error('GAME_MIN_PLAYERS', 'Trò chơi "Ai Là Gián Điệp?" cần ít nhất 3 người — hãy chơi trong Nhóm chat hoặc Phòng Game nhé!'));
        return;
      }
      const mapped = payload.gameType === 'caro_arena' ? 'caro' : payload.gameType;
      return messageHandlers[CLIENT_TYPES.GAME_INVITE](clientId, { gameType: mapped, size: 10 });
    }

    if (client.state !== 'GROUP_CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Hãy vào một cuộc trò chuyện 1-1 hoặc Nhóm chat để mở minigame.'));
      return;
    }

    const groupId = groupManager.getGroupId(clientId);
    if (!groupId) return;
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

    const contextKey = `group:${groupId}`;
    const existing = embeddedGameManager.getRoomByContext(contextKey);
    if (existing) {
      sendActiveGroupGameIfAny(groupId, clientId);
      return;
    }

    const groupMember = await groupManager.getGroupMember(groupId, clientId);
    if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING') return;

    const displayNick = (groupMember && groupMember.nickname) || client.nickname;
    const info = GAME_CATALOG[payload.gameType] || GAME_CATALOG.quiz_race;

    embeddedGameManager.createEmbeddedSession(
      contextKey,
      {
        clientId,
        deviceId: client.deviceId,
        nickname: displayNick,
        avatar: client.avatar || '🦊',
      },
      {
        gameType: payload.gameType,
        maxPlayers: MAX_GAME_ROOM_PLAYERS,
        name: `${info.icon} ${info.name} (Nhóm)`,
        contextType: 'group',
        isBotSession: false,
        allowAnyPlayerControl: false,
        autoStart: false,
        openNotice: `🎮 ${displayNick} vừa mở bàn ${info.icon} ${info.name} ngay trong nhóm! Bấm "🙋 Tham gia bàn" để vào chơi cùng (tối đa ${MAX_GAME_ROOM_PLAYERS} người).`,
      }
    );
  },

  async [CLIENT_TYPES.CHAT_GAME_JOIN](clientId) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'GROUP_CHATTING') return;
    const groupId = groupManager.getGroupId(clientId);
    if (!groupId) return;
    if (!(await ensureNotGroupBanned(clientId))) return;
    if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING' || groupManager.getGroupId(clientId) !== groupId) return;

    const room = embeddedGameManager.getRoomByContext(`group:${groupId}`);
    const groupMember = await groupManager.getGroupMember(groupId, clientId);
    if (clients.get(clientId) !== client || client.state !== 'GROUP_CHATTING') return;
    const displayNick = (groupMember && groupMember.nickname) || client.nickname;
    const userProfile = {
      clientId,
      deviceId: client.deviceId,
      nickname: displayNick,
      avatar: client.avatar || '🦊',
    };

    if (!room) {
      if (publishEmbeddedGameCmd({
        contextType: 'group',
        contextKey: `group:${groupId}`,
        groupId,
        command: 'join',
        clientId,
        userProfile,
      })) {
        return;
      }
      sendTo(clientId, serverMsg.error('GAME_ROOM_NOT_FOUND', 'Hiện chưa có bàn game nào đang mở trong nhóm.'));
      return;
    }

    const joinRes = embeddedGameManager.joinRoom(userProfile, { roomId: room.roomId });
    if (!joinRes.ok) {
      sendTo(clientId, serverMsg.error(joinRes.code || 'GAME_ROOM_ERROR', joinRes.error));
      return;
    }

    embeddedGameManager.broadcastRoomState(room.roomId, {
      systemNotice: `🙋 ${joinRes.player.nickname} đã tham gia bàn game (${joinRes.room.playerCount}/${joinRes.room.maxPlayers})!`,
    });
  },

  [CLIENT_TYPES.CHAT_GAME_LEAVE](clientId) {
    const client = clients.get(clientId);
    if (!client) return;
    if (client.state === 'GROUP_CHATTING') {
      const groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      const contextKey = `group:${groupId}`;
      if (embeddedGameManager.getRoomByContext(contextKey)) {
        removePlayerFromGroupEmbeddedGame(groupId, clientId);
      } else {
        publishEmbeddedGameCmd({
          contextType: 'group',
          contextKey,
          groupId,
          command: 'leave',
          clientId,
          userProfile: { clientId, nickname: client.nickname },
        });
      }
    } else if (client.state === 'CHATTING') {
      closeEmbedded1v1Game(roomManager.getRoomId(clientId), { closedByName: client.nickname });
    }
  },

  async [CLIENT_TYPES.CHAT_GAME_SELECT](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    let contextKey = null;
    let contextType = null;
    let groupId = null;

    if (client.state === 'CHATTING') {
      if (!(await canPerformGameAction(clientId))) return;
      if (payload.gameType === 'undercover') {
        sendTo(clientId, serverMsg.error('GAME_MIN_PLAYERS', 'Trò chơi "Ai Là Gián Điệp?" cần ít nhất 3 người chơi!'));
        return;
      }
      const chatRoomId = roomManager.getRoomId(clientId);
      if (!chatRoomId) return;
      if (payload.gameType === 'caro_arena') {
        closeEmbedded1v1Game(chatRoomId, { silent: true });
        return messageHandlers[CLIENT_TYPES.GAME_INVITE](clientId, { gameType: 'caro', size: 10 });
      }
      contextType = '1v1';
      contextKey = `chat:${chatRoomId}`;
    } else if (client.state === 'GROUP_CHATTING') {
      if (!(await ensureNotGroupBanned(clientId))) return;
      groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      contextType = 'group';
      contextKey = `group:${groupId}`;
    } else {
      return;
    }

    if (!embeddedGameManager.getRoomByContext(contextKey)) {
      if (publishEmbeddedGameCmd({
        contextType,
        contextKey,
        groupId,
        command: 'select',
        clientId,
        payload,
      })) {
        return;
      }
    }

    const res = embeddedGameManager.selectGame(clientId, payload.gameType);
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('CHAT_GAME_ERROR', res.error));
    }
  },

  async [CLIENT_TYPES.CHAT_GAME_START](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    let contextKey = null;
    let contextType = null;
    let groupId = null;

    if (client.state === 'CHATTING') {
      if (!(await canPerformGameAction(clientId))) return;
      const chatRoomId = roomManager.getRoomId(clientId);
      if (!chatRoomId) return;
      contextType = '1v1';
      contextKey = `chat:${chatRoomId}`;
    } else if (client.state === 'GROUP_CHATTING') {
      if (!(await ensureNotGroupBanned(clientId))) return;
      groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      contextType = 'group';
      contextKey = `group:${groupId}`;
    } else {
      return;
    }

    if (!embeddedGameManager.getRoomByContext(contextKey)) {
      if (publishEmbeddedGameCmd({
        contextType,
        contextKey,
        groupId,
        command: 'start',
        clientId,
      })) {
        return;
      }
    }

    const res = embeddedGameManager.startGame(clientId);
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('CHAT_GAME_ERROR', res.error));
    }
  },

  async [CLIENT_TYPES.CHAT_GAME_ACTION](clientId, payload) {
    const receivedAt = Date.now();
    const client = clients.get(clientId);
    if (!client) return;

    let contextKey = null;
    let contextType = null;
    let groupId = null;

    if (client.state === 'CHATTING') {
      if (!(await canPerformGameAction(clientId))) return;
      const chatRoomId = roomManager.getRoomId(clientId);
      if (!chatRoomId) return;
      contextType = '1v1';
      contextKey = `chat:${chatRoomId}`;
    } else if (client.state === 'GROUP_CHATTING') {
      if (!(await ensureNotGroupBanned(clientId))) return;
      groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      contextType = 'group';
      contextKey = `group:${groupId}`;
    } else {
      return;
    }

    if (!embeddedGameManager.getRoomByContext(contextKey)) {
      if (publishEmbeddedGameCmd({
        contextType,
        contextKey,
        groupId,
        command: 'action',
        clientId,
        payload,
        receivedAt,
      })) {
        return;
      }
    }

    const res = embeddedGameManager.handleAction(clientId, payload, { receivedAt });
    if (!res.ok) {
      sendTo(clientId, serverMsg.error('CHAT_GAME_ACTION_ERROR', res.error));
    }
  },

  [CLIENT_TYPES.CHAT_GAME_CLOSE](clientId) {
    const client = clients.get(clientId);
    if (!client) return;

    if (client.state === 'CHATTING') {
      closeEmbedded1v1Game(roomManager.getRoomId(clientId), { closedByName: client.nickname });
      return;
    }

    if (client.state === 'GROUP_CHATTING') {
      const groupId = groupManager.getGroupId(clientId);
      if (!groupId) return;
      const contextKey = `group:${groupId}`;
      const room = embeddedGameManager.getRoomByContext(contextKey);
      if (!room) {
        publishEmbeddedGameCmd({
          contextType: 'group',
          contextKey,
          groupId,
          command: 'close',
          clientId,
          userProfile: { clientId, nickname: client.nickname },
        });
        return;
      }
      if (room.hostId === clientId) {
        const hostNick = room.players.get(clientId)?.nickname || client.nickname;
        embeddedGameManager.destroyRoomByContext(contextKey);
        broadcastToGroup(groupId, serverMsg.chatGameState({
          contextType: 'group',
          groupId,
          closed: true,
          closedByName: hostNick,
          systemNotice: `🎮 ${hostNick} đã đóng bàn game trong nhóm.`,
        }));
      } else if (room.players.has(clientId)) {
        removePlayerFromGroupEmbeddedGame(groupId, clientId);
      }
    }
  },

  // ══════════════════════════════════════════════════════════════════════════
  // GIỮ KẾT NỐI ẨN DANH 2 CHIỀU & MÃ HẸN GẶP LẠI (CHAT 1-1)
  // ══════════════════════════════════════════════════════════════════════════

  async [CLIENT_TYPES.PAIR_VOTE_KEEP](clientId, payload) {
    const client = clients.get(clientId);
    if (!client || client.state !== 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Bạn chưa ở trong cuộc trò chuyện 1-1.'));
      return;
    }
    if (roomManager.isBotRoom(clientId)) {
      sendTo(clientId, serverMsg.error('PAIR_BOT_UNSUPPORTED', 'Bạn luôn có thể gặp lại Lumi bất cứ lúc nào từ Trang chủ nhé!'));
      return;
    }

    const roomId = roomManager.getRoomId(clientId);
    const partnerId = roomManager.getPartnerId(clientId);
    const partnerClient = partnerId ? clients.get(partnerId) : null;
    if (!roomId || !partnerId || !partnerClient) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_IN_ROOM, 'Đối phương hiện không còn trực tuyến trong phòng.'));
      return;
    }

    let result;
    try {
      result = await connectionManager.setKeepVote(roomId, client, partnerClient, payload.keep);
    } catch (error) {
      console.error('[Connection] setKeepVote error:', error.message);
      sendTo(clientId, serverMsg.error('PAIR_UNAVAILABLE', 'Không thể cập nhật Giữ kết nối lúc này. Vui lòng thử lại.'));
      return;
    }

    if (!result.ok) {
      sendTo(clientId, serverMsg.error('PAIR_ERROR', result.error || 'Không thể cập nhật Giữ kết nối.'));
      return;
    }

    // Nếu vừa hủy kết nối đã giữ -> xóa ở cả 2 bên
    if (result.justCancelled) {
      sendTo(clientId, serverMsg.pairRemoved(result.cancelledPairId, 'Bạn đã hủy Giữ kết nối này.'));
      sendTo(partnerId, serverMsg.pairRemoved(result.cancelledPairId, `${client.nickname} đã hủy Giữ kết nối này.`));
      sendTo(clientId, serverMsg.pairKeepUpdated({
        myVote: false,
        partnerVote: false,
        keepCount: 0,
        isKept: false,
        justActivated: false,
        justCancelled: true,
        actorNickname: client.nickname,
        pairId: null,
        pairCode: null,
      }));
      sendTo(partnerId, serverMsg.pairKeepUpdated({
        myVote: false,
        partnerVote: false,
        keepCount: 0,
        isKept: false,
        justActivated: false,
        justCancelled: true,
        actorNickname: client.nickname,
        pairId: null,
        pairCode: null,
      }));
      return;
    }

    // Nếu cả 2 vừa đồng ý (2/2) -> cấp thẻ kết nối + mã hẹn gặp lại cho từng bên!
    if (result.justActivated && Array.isArray(result.passes)) {
      for (const item of result.passes) {
        sendTo(item.clientId, serverMsg.pairKeepPass(item.pass));
      }
    }

    const pairId = result.pair ? result.pair.pairId : null;
    const pairCode = result.pair ? result.pair.pairCode : null;
    const historyCount = result.pair && Array.isArray(result.pair.history) ? result.pair.history.length : 0;

    // Gửi trạng thái cá nhân hóa cho người bấm
    sendTo(clientId, serverMsg.pairKeepUpdated({
      myVote: result.voterVote,
      partnerVote: result.partnerVote,
      keepCount: result.keepCount,
      isKept: result.isKept,
      justActivated: result.justActivated,
      justCancelled: false,
      actorIsMe: true,
      actorNickname: client.nickname,
      partnerNickname: partnerClient.nickname,
      pairId,
      pairCode,
      historyCount,
    }));

    // Gửi trạng thái cá nhân hóa cho đối phương
    sendTo(partnerId, serverMsg.pairKeepUpdated({
      myVote: result.partnerVote,
      partnerVote: result.voterVote,
      keepCount: result.keepCount,
      isKept: result.isKept,
      justActivated: result.justActivated,
      justCancelled: false,
      actorIsMe: false,
      actorNickname: client.nickname,
      partnerNickname: client.nickname,
      pairId,
      pairCode,
      historyCount,
    }));
  },

  async [CLIENT_TYPES.PAIR_SYNC](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    try {
      const { connections, expiredPairIds } = await connectionManager.syncSavedPairs(
        payload.passes,
        (pair, otherSlot) => getPartnerPresenceForPair(pair, otherSlot, clientId)
      );

      client.syncedPairLinks = connections.map((c) => ({ pairId: c.pairId, mySlot: c.mySlot }));
      sendTo(clientId, serverMsg.pairList(connections, expiredPairIds));

      // Thông báo online tới những người hợp cạ đang trực tuyến
      notifyPairPartnersPresence(client, true).catch(() => {});
    } catch (error) {
      console.error('[Connection] syncSavedPairs error:', error.message);
      sendTo(clientId, serverMsg.error('PAIR_UNAVAILABLE', 'Không thể đồng bộ danh sách Giữ kết nối lúc này.'));
    }
  },

  async [CLIENT_TYPES.PAIR_RECONNECT](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotRedisBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    let verified;
    try {
      verified = await connectionManager.verifyPass(payload.pairId, payload.pairToken);
    } catch (error) {
      console.error('[Connection] verifyPass error:', error.message);
      sendTo(clientId, serverMsg.error('PAIR_UNAVAILABLE', 'Không thể xác thực kết nối lúc này.'));
      return;
    }

    if (!verified) {
      sendTo(clientId, serverMsg.pairRemoved(payload.pairId, 'Kết nối này đã hết hạn hoặc đã bị hủy.'));
      return;
    }

    await initiatePairReconnect(clientId, verified.pair, verified.slot, verified.otherSlot);
  },

  async [CLIENT_TYPES.PAIR_JOIN_CODE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;
    if (!client.nickname) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.NOT_JOINED, 'Vui lòng nhập biệt danh trước'));
      return;
    }
    if (!(await ensureNotRedisBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (!connectionManager.checkCodeAttemptLimit(clientId) || !pairCodeIpLimiter.check(client.clientIp || clientId).allowed) {
      sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn nhập mã hẹn quá nhiều lần, vui lòng chờ một lát.'));
      return;
    }

    let resolved;
    try {
      resolved = await connectionManager.resolvePairByCode(payload.pairCode, client);
    } catch (error) {
      console.error('[Connection] resolvePairByCode error:', error.message);
      sendTo(clientId, serverMsg.error('PAIR_UNAVAILABLE', 'Không thể kiểm tra mã hẹn lúc này.'));
      return;
    }

    if (!resolved.ok) {
      sendTo(clientId, serverMsg.error(resolved.code || 'PAIR_NOT_FOUND', resolved.error));
      return;
    }

    await initiatePairReconnect(clientId, resolved.pair, resolved.slot, resolved.otherSlot, {
      issuedPass: resolved.pass,
    });
  },

  async [CLIENT_TYPES.PAIR_INVITE_RESPOND](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    const invite = connectionManager.consumeInvite(payload.inviteId);
    if (!invite || invite.toClientId !== clientId) {
      sendTo(clientId, serverMsg.error('PAIR_INVITE_EXPIRED', 'Lời mời kết nối lại này đã hết hạn.'));
      return;
    }

    const fromClient = clients.get(invite.fromClientId);
    if (!payload.accept) {
      if (fromClient) {
        leavePairWaiting(fromClient.clientId);
        sendTo(fromClient.clientId, serverMsg.pairInviteDeclined({
          pairId: invite.pairId,
          partnerNickname: client.nickname || 'Đối phương',
          message: `${client.nickname || 'Người ấy'} hiện đang bận nên hẹn bạn dịp khác nhé.`,
        }));
      }
      return;
    }

    if (!(await ensureNotRedisBanned(clientId))) return;
    if (clients.get(clientId) !== client) return;

    if (!fromClient || fromClient.ws.readyState !== 1) {
      sendTo(clientId, serverMsg.error('PAIR_INVITE_EXPIRED', 'Đối phương đã rời phòng hẹn trước đó.'));
      return;
    }

    const pair = await connectionManager._loadPair(invite.pairId, { includeHistory: true });
    if (!pair) {
      sendTo(clientId, serverMsg.pairRemoved(invite.pairId, 'Kết nối này không còn tồn tại.'));
      return;
    }

    if (client.state === 'CHATTING') {
      sendTo(clientId, serverMsg.error(ERROR_CODES.ALREADY_CHATTING, 'Hãy rời cuộc trò chuyện 1-1 hiện tại trước khi chấp nhận lời mời.'));
      return;
    }

    // Nếu người chấp nhận vừa mở Trang chủ chưa kịp bấm join -> tự điền biệt danh cũ của slot
    if (!client.nickname && pair.slots[invite.toSlot]) {
      client.nickname = pair.slots[invite.toSlot].nickname;
      client.avatar = pair.slots[invite.toSlot].avatar || '🦊';
      client.mood = pair.slots[invite.toSlot].mood || 'ngau_nhien';
    }

    const clientA = invite.fromSlot === 'A' ? fromClient : client;
    const clientB = invite.fromSlot === 'A' ? client : fromClient;
    await startKeptPairChat(pair, clientA, clientB);
  },

  [CLIENT_TYPES.PAIR_CANCEL_WAIT](clientId) {
    leavePairWaiting(clientId);
  },

  async [CLIENT_TYPES.PAIR_REMOVE](clientId, payload) {
    const client = clients.get(clientId);
    if (!client) return;

    let res;
    try {
      res = await connectionManager.removePairByPass(payload.pairId, payload.pairToken);
    } catch (error) {
      console.error('[Connection] removePairByPass error:', error.message);
      sendTo(clientId, serverMsg.error('PAIR_UNAVAILABLE', 'Không thể hủy kết nối lúc này.'));
      return;
    }

    if (!res.ok) {
      sendTo(clientId, serverMsg.pairRemoved(payload.pairId, 'Kết nối đã được gỡ khỏi danh sách.'));
      return;
    }

    sendTo(clientId, serverMsg.pairRemoved(res.pairId, 'Đã hủy Giữ kết nối vĩnh viễn ở cả hai phía.'));

    // Thông báo cho đối phương nếu đang trực tuyến
    for (const slotKey of ['A', 'B']) {
      const target = findOnlineClientForPairSlot({ pairId: res.pairId, slots: res.slots }, slotKey, clientId);
      if (target) {
        sendTo(target.clientId, serverMsg.pairRemoved(res.pairId, 'Một kết nối đã được hủy ở cả hai phía.'));
      }
    }
  },
};

// ─── Xử lý kết nối WebSocket ──────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req, { trustProxy: TRUST_PROXY, trustProxyHops: TRUST_PROXY_HOPS });

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
    avatar: '🦊',
    interests: [],
    mood: 'ngau_nhien',
    state: 'CONNECTED',
    groupId: null,
    gameRoomId: null,
    lastGroupTypingAt: 0,
    pendingChatCount: 0,
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

    // 0. Phòng thủ Flood / DoS cấp WebSocket Frame toàn cục
    const frameRate = wsFrameLimiter.check(clientId);
    if (!frameRate.allowed) {
      if (frameRate.count > 150) {
        console.warn(`[Security] 🚫 Ngắt kết nối flood WS từ ${clientId} (${clientInfo.clientIp}, frames=${frameRate.count}/5s)`);
        ws.close(1008, 'Gửi quá nhiều yêu cầu liên tục');
        return;
      }
      if (frameRate.count === 61 || frameRate.count % 20 === 0) {
        sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Bạn đang gửi yêu cầu quá nhanh, vui lòng chậm lại.'));
      }
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

      // Các hành động game cần xử lý theo thứ tự của từng client (chống race khi bấm nhanh)
      const gameActions = new Set([
        CLIENT_TYPES.GAME_INVITE,
        CLIENT_TYPES.GAME_ACCEPT,
        CLIENT_TYPES.GAME_MOVE,
        CLIENT_TYPES.GAME_RESET,
        CLIENT_TYPES.GAME_QUIT,
        CLIENT_TYPES.GAME_ROOM_ACTION,
        CLIENT_TYPES.CHAT_GAME_ACTION,
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
                'Không thể xử lý thao tác trò chơi lúc này.'
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
        if ((clientInfo.pendingChatCount || 0) >= MAX_PENDING_CHAT_PER_CLIENT) {
          sendTo(clientId, serverMsg.error(ERROR_CODES.RATE_LIMITED, 'Hàng đợi tin nhắn đang đầy, vui lòng gửi chậm lại.'));
          return;
        }
        clientInfo.pendingChatCount = (clientInfo.pendingChatCount || 0) + 1;
        const previous = pendingChatMessages.get(clientId) || Promise.resolve();
        const pending = previous
          .then(() => handler(clientId, validateResult.sanitized))
          .catch((error) => {
            console.error(`[Server] Async message handler failed for ${type} from ${clientId}:`, error);
            sendTo(clientId, serverMsg.error('MESSAGE_PROCESSING_FAILED', 'Không thể xử lý tin nhắn lúc này. Vui lòng thử lại.'));
          })
          .finally(() => {
            clientInfo.pendingChatCount = Math.max(0, (clientInfo.pendingChatCount || 1) - 1);
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
    closeEmbedded1v1Game(roomId, { silent: true });
    connectionManager.cleanupRoomSession(roomId);

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

  // Nếu đang ở trong phòng trò chuyện nhóm → rời nhóm (và tự xóa nhóm nếu trống & < 3 người giữ)
  if (groupManager.isInGroup(clientId)) {
    leaveGroupSession(clientId, { silent: true, reason: 'ngắt kết nối' }).catch((error) => {
      console.error(`[Group] Disconnect cleanup failed for ${clientId}:`, error.message);
    });
  }

  // Nếu đang ở trong phòng game nhiều người → rời phòng (tự chuyển Host / tự hủy nếu trống)
  if (gameRoomManager.isInGameRoom(clientId)) {
    leaveGameRoomSession(clientId, { silent: true, reason: 'ngắt kết nối' });
  }

  // Nếu đang đợi trong phòng hẹn Giữ kết nối → dọn sạch & báo offline cho đối phương
  leavePairWaiting(clientId);
  notifyPairPartnersPresence(client, false).catch(() => {});
  connectionManager.clearClient(clientId);

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
    closeEmbedded1v1Game(roomId, { silent: true });
    connectionManager.cleanupRoomSession(roomId);

    const result = roomManager.removeClient(clientId);

    if (result && result.partnerId) {
      notifyRoomLeft(clientId, result.partnerId);

      const partner = clients.get(result.partnerId);

      if (partner) {
        partner.state = 'CONNECTED';
      }
    }
  }


  // Dọn dẹp moderation & rate limiter theo phiên
  moderation.clearClient(clientId);
  wsFrameLimiter.delete(clientId);
  resourceCreateLimiter.delete(clientId);

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

const groupPruneTimer = setInterval(() => {
  groupManager.pruneStaleGroups().catch((error) => {
    console.error('[Group] Prune failed:', error.message);
  });
  moderation.pruneExpired();
  pruneVoiceStorage(0);
  if (typeof attachmentStorage.prune === 'function') attachmentStorage.prune(0);
  wsFrameLimiter.prune();
  resourceCreateLimiter.prune();
  voiceUploadLimiter.prune();
  pairCodeIpLimiter.prune();
}, 60_000);

// ─── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown() {
  console.log('\n[Server] Shutting down...');
  clearInterval(heartbeatTimer);
  clearInterval(matchRecoveryTimer);
  clearInterval(groupPruneTimer);
  matchmaker.destroy();

  // Rời tất cả phòng nhóm cục bộ trước khi tắt server để cập nhật trạng thái nhóm sạch sẽ
  const activeGroupClientIds = [...groupManager.clientGroupMap.keys()];
  await Promise.allSettled(
    activeGroupClientIds.map((cid) => leaveGroupSession(cid, { silent: true, reason: 'máy chủ bảo trì' }))
  );

  gameRoomManager.destroy();
  embeddedGameManager.destroy();
  connectionManager.destroy();

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
  console.log(`  👥 GroupChat: tối đa ${groupManager.maxMembers} thành viên/nhóm (giữ nhóm >= ${groupManager.minKeepVotes} phiếu)`);
  console.log(`  🎮 GameRooms: 5 trò chơi nhiều người (2–${gameRoomManager.maxPlayers} người/phòng)`);
  console.log(`  🤖 Lumi AI:   ${groqChat.getProviderSummary()}`);
  console.log('═══════════════════════════════════════════════════');
});
