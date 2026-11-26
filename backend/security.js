/**
 * security.js – Lớp phòng thủ bảo mật trung tâm (Defense-in-Depth)
 *
 * Bảo vệ ứng dụng trò chuyện ẩn danh trước các tấn công phổ biến (OWASP Top 10 / CWE):
 *   1. XSS & IP-Grabber qua URL meme/sticker/voice (allowlist chặt chẽ).
 *   2. CSWSH (Cross-Site WebSocket Hijacking – CWE-1385): kiểm tra Same-Origin mặc định & ALLOWED_ORIGINS.
 *   3. IP Spoofing qua X-Forwarded-For: chỉ tin cậy proxy khi bật TRUST_PROXY=true.
 *   4. Path Traversal & Dotfile Exposure: dùng path.resolve + path.relative an toàn.
 *   5. Timing Side-Channel trên token bí mật: dùng crypto.timingSafeEqual.
 *   6. Unicode Bidi Override (RLO U+202E) & Zero-Width Spoofing: loại bỏ ký tự điều khiển ẩn.
 *   7. File Upload Spoofing (Voice): kiểm tra magic bytes nhị phân thực sự của file âm thanh.
 *   8. DoS / Flood / Slowloris: SlidingWindowLimiter có giới hạn bộ nhớ + HTTP Security Headers (CSP, HSTS, X-Frame-Options, Referrer-Policy).
 */

'use strict';

const crypto = require('crypto');
const path = require('path');

// ─── 1. Làm sạch ký tự điều khiển / Unicode Bidi / Zero-Width ───────────────

/**
 * Loại bỏ null byte, ký tự điều khiển không in được, ký tự độ rộng 0 (ZWSP/ZWJ)
 * và ký tự đảo chiều văn bản Unicode Bidi (RLO U+202E dùng giả mạo tên/link).
 * Giữ lại \n khi allowNewlines = true (cho nội dung tin nhắn nhiều dòng).
 */
function stripDangerousUnicode(input, { allowNewlines = false } = {}) {
  if (typeof input !== 'string') return '';
  const pattern = allowNewlines
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g
    : /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
  return input.replace(pattern, '');
}

// ─── 2. So sánh token bí mật thời gian hằng số (Chống Timing Attack) ────────

function safeTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── 3. Kiểm soát URL Meme / Sticker / Voice (Chống XSS & IP-Grabber) ───────

const ALLOWED_LOCAL_STICKER_RE = /^\/assets\/stickers\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:png|gif|webp|jpg|jpeg|avif)$/i;
const ALLOWED_GIPHY_HOSTS = new Set([
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
]);

function isAllowedMemeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim();
  if (url.length === 0 || url.length > 500) return false;
  if (url.includes('..') || url.includes('\\') || /[\u0000-\u001F\s]/.test(url)) return false;

  // 1. Nhãn dán nội bộ của ứng dụng
  if (ALLOWED_LOCAL_STICKER_RE.test(url)) {
    return true;
  }

  // 2. Chỉ cho phép CDN Giphy HTTPS đã xác minh (chặn tuyệt đối IP-grabber & javascript:/data:)
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (!ALLOWED_GIPHY_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  if (!/^\/media\/[a-zA-Z0-9/_-]+\.(?:gif|webp)$/i.test(parsed.pathname)) return false;

  return true;
}

function isValidVoiceUrl(rawUrl, voiceId) {
  if (typeof rawUrl !== 'string' || typeof voiceId !== 'string') return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voiceId)) {
    return false;
  }
  return rawUrl === `/api/voice/${voiceId}`;
}

// ─── 4. Kiểm tra Magic Bytes cho File Âm Thanh (Voice Upload) ───────────────

const ALLOWED_VOICE_MIME_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/aac',
]);

function normalizeVoiceMime(rawHeader) {
  const clean = String(rawHeader || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_VOICE_MIME_TYPES.has(clean) ? clean : null;
}

/**
 * Xác thực header nhị phân (magic bytes) để chặn tải lên HTML/JS/tệp giả mạo Audio.
 */
function isValidAudioMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;

  // WebM / Matroska (EBML header: 1A 45 DF A3)
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return true;
  }
  // Ogg / Opus ("OggS")
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return true;
  }
  // MP4 / M4A (offset 4: "ftyp")
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return true;
  }
  // WAV ("RIFF" .... "WAVE")
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45
  ) {
    return true;
  }
  // MP3 (ID3 tag hoặc MPEG/AAC ADTS sync bits: 0xFF 0xE0)
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return true;
  }
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return true;
  }

  return false;
}

// ─── 5. Trích xuất IP an toàn (Chống giả mạo X-Forwarded-For) ────────────────

function normalizeIp(ip) {
  if (typeof ip !== 'string') return '127.0.0.1';
  let trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    trimmed = trimmed.slice(7);
  }
  if (trimmed === '::1') return '127.0.0.1';
  // Chặn ký tự lạ chèn vào header
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(trimmed)) return 'unknown';
  return trimmed;
}

function getClientIp(req, { trustProxy = false, trustProxyHops = 1 } = {}) {
  const socketIp = normalizeIp(req && req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '127.0.0.1');
  if (!trustProxy) {
    return socketIp;
  }

  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || !xff.trim()) {
    return socketIp;
  }

  const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return socketIp;

  // Lấy địa chỉ từ phía proxy tin cậy (tính từ phải sang trái theo số hop proxy)
  const hops = Math.max(1, Number.isInteger(trustProxyHops) ? trustProxyHops : 1);
  const idx = Math.max(0, parts.length - hops);
  const candidate = normalizeIp(parts[idx]);
  return candidate === 'unknown' ? socketIp : candidate;
}

// ─── 6. Phòng thủ CSWSH (Cross-Site WebSocket Hijacking – CWE-1385) ───────────

function isAllowedWsOrigin(req, allowedOriginsEnv = process.env.ALLOWED_ORIGINS) {
  const origin = req && req.headers && req.headers.origin;
  const requireOrigin = process.env.REQUIRE_ORIGIN === 'true';

  if (!origin) {
    return !requireOrigin;
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }

  if (typeof allowedOriginsEnv === 'string' && allowedOriginsEnv.trim().length > 0) {
    const allowed = allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean);
    return allowed.includes(parsedOrigin.origin);
  }

  // Mặc định (khi không khai báo ALLOWED_ORIGINS): bắt buộc Same-Origin theo Host header!
  const hostHeader = req && req.headers && req.headers.host;
  if (!hostHeader) return false;
  return parsedOrigin.host.toLowerCase() === String(hostHeader).trim().toLowerCase();
}

// ─── 7. Chống Path Traversal & Lộ tệp ẩn (Static File Server) ────────────────

function resolveSafeStaticPath(baseDir, rawPathname) {
  if (typeof rawPathname !== 'string') return null;

  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  // Chặn null byte và dấu gạch chéo ngược
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const relativeUrlPath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const segments = relativeUrlPath.split('/');
  // Chặn truy cập thư mục/tệp ẩn (.env, .git, .htaccess) hoặc segment '..'
  if (segments.some((seg) => seg === '..' || seg === '.' || seg.startsWith('.'))) {
    return null;
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeUrlPath);
  const rel = path.relative(resolvedBase, resolvedTarget);

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  return resolvedTarget;
}

// ─── 8. Bộ HTTP Security Headers (CSP, Clickjacking, Referrer, HSTS) ─────────

function getExtraBlobOrigin() {
  const customEndpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT;
  if (!customEndpoint) return '';
  try {
    const parsed = new URL(customEndpoint);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return ` ${parsed.origin}`;
    }
  } catch {
    // Bỏ qua endpoint không hợp lệ
  }
  return '';
}

function buildContentSecurityPolicy() {
  const extraBlobOrigin = getExtraBlobOrigin();
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src 'self' https://media.giphy.com https://*.giphy.com https://*.blob.core.windows.net${extraBlobOrigin} data: blob:`,
    `media-src 'self' https://*.blob.core.windows.net${extraBlobOrigin} blob:`,
    `connect-src 'self' ws: wss: https://*.blob.core.windows.net${extraBlobOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

function getSecurityHeaders({ isHtml = false, isHttps = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (isHtml) {
    headers['Content-Security-Policy'] = buildContentSecurityPolicy();
  }
  if (isHttps) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

// ─── 9. Bộ Giới Hạn Tần Suất Cửa Sổ Trượt Có Giới Hạn RAM ────────────────────

class SlidingWindowLimiter {
  constructor({ maxRequests = 30, windowMs = 10_000, maxKeys = 5_000 } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /**
   * @param {string} key
   * @returns {{ allowed: boolean, count: number, retryAfterMs: number }}
   */
  check(key) {
    const now = Date.now();
    let list = this.buckets.get(key);
    if (!list) {
      if (this.buckets.size >= this.maxKeys) {
        const oldestKey = this.buckets.keys().next().value;
        this.buckets.delete(oldestKey);
      }
      list = [now];
      this.buckets.set(key, list);
      return { allowed: true, count: 1, retryAfterMs: 0 };
    }

    const cutoff = now - this.windowMs;
    while (list.length > 0 && list[0] <= cutoff) {
      list.shift();
    }

    list.push(now);
    if (list.length > this.maxRequests) {
      const retryAfterMs = Math.max(0, this.windowMs - (now - list[0]));
      return { allowed: false, count: list.length, retryAfterMs };
    }
    return { allowed: true, count: list.length, retryAfterMs: 0 };
  }

  delete(key) {
    this.buckets.delete(key);
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.buckets.entries()) {
      while (list.length > 0 && list[0] <= cutoff) list.shift();
      if (list.length === 0) this.buckets.delete(key);
    }
  }

  clear() {
    this.buckets.clear();
  }
}

module.exports = {
  stripDangerousUnicode,
  safeTokenEquals,
  isAllowedMemeUrl,
  isValidVoiceUrl,
  normalizeVoiceMime,
  isValidAudioMagicBytes,
  normalizeIp,
  getClientIp,
  isAllowedWsOrigin,
  resolveSafeStaticPath,
  CONTENT_SECURITY_POLICY,
  getSecurityHeaders,
  SlidingWindowLimiter,
};

