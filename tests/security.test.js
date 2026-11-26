/**
 * security.test.js – Bộ kiểm thử hồi quy bảo mật phòng thủ (Defensive Security QA)
 *
 * Kiểm tra các lớp phòng thủ trong backend/security.js, protocol.js, moderation.js,
 * nicknameResolver.js và kiểm thử tích hợp HTTP/WebSocket cục bộ trên server thật:
 *   1. Chặn XSS / Tabnabbing / IP-Grabber qua URL Meme, Sticker, Voice.
 *   2. Xác thực magic bytes nhị phân & MIME & rate limit cho Voice Upload.
 *   3. Chặn Unicode Bidi Override (RLO U+202E) & Zero-Width giả mạo biệt danh.
 *   4. Chặn Path Traversal (%2e%2e, dotfile .env/.git, sibling-prefix).
 *   5. Chặn IP Spoofing qua X-Forwarded-For khi TRUST_PROXY=false.
 *   6. Chặn CSWSH (Cross-Site WebSocket Hijacking) theo mặc định Same-Origin & ALLOWED_ORIGINS.
 *   7. So sánh token thời gian hằng số (timingSafeEqual) & giới hạn bộ nhớ Rate Limiter / Moderation.
 *   8. Xác minh HTTP Security Headers (CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy)
 *      và WebSocket flood / kiểm duyệt biệt danh trên server cục bộ.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../backend/node_modules/ws');

const {
  stripDangerousUnicode,
  safeTokenEquals,
  isAllowedMemeUrl,
  isValidVoiceUrl,
  normalizeVoiceMime,
  isValidAudioMagicBytes,
  getClientIp,
  isAllowedWsOrigin,
  resolveSafeStaticPath,
  getSecurityHeaders,
  SlidingWindowLimiter,
} = require('../backend/security');
const { CLIENT_TYPES, validatePayload } = require('../backend/protocol');
const { resolveRoomNickname } = require('../backend/nicknameResolver');
const Moderation = require('../backend/moderation');

// ─── PHẦN 1: KIỂM THỬ ĐƠN VỊ (UNIT TESTS) ────────────────────────────────────

function runUnitTests() {
  console.log('--- 1. Kiểm thử Allowlist URL Meme/Sticker & Voice (Chống XSS & IP-Grabber) ---');

  // Hợp lệ
  assert.strictEqual(isAllowedMemeUrl('/assets/stickers/douyin/weixiao.png'), true);
  assert.strictEqual(isAllowedMemeUrl('https://media.giphy.com/media/111ebonMs90YLu/giphy.gif'), true);
  assert.strictEqual(isAllowedMemeUrl('https://i.giphy.com/media/abc123/giphy.webp'), true);

  // Chặn XSS, data URI, IP-grabber bên ngoài, HTTP không mã hóa, path traversal
  assert.strictEqual(isAllowedMemeUrl('javascript:alert(1)'), false);
  assert.strictEqual(isAllowedMemeUrl('JAVASCRIPT:alert(document.cookie)'), false);
  assert.strictEqual(isAllowedMemeUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.strictEqual(isAllowedMemeUrl('https://evil-ip-grabber.example/track.gif'), false);
  assert.strictEqual(isAllowedMemeUrl('http://media.giphy.com/media/111ebonMs90YLu/giphy.gif'), false);
  assert.strictEqual(isAllowedMemeUrl('/assets/stickers/../../backend/server.js'), false);
  assert.strictEqual(isAllowedMemeUrl('/assets/stickers/douyin\\weixiao.png'), false);
  assert.strictEqual(isAllowedMemeUrl('https://user:pass@media.giphy.com/media/abc/giphy.gif'), false);

  // Kiểm tra qua protocol.validatePayload(MEME)
  assert.strictEqual(validatePayload(CLIENT_TYPES.MEME, {
    url: 'javascript:alert(1)',
    title: 'bad',
  }).ok, false);
  assert.strictEqual(validatePayload(CLIENT_TYPES.MEME, {
    url: 'https://tracker.invalid/pixel.png',
    title: 'ip grabber',
  }).ok, false);
  assert.strictEqual(validatePayload(CLIENT_TYPES.MEME, {
    url: '/assets/stickers/douyin/weixiao.png',
    title: 'Mỉm cười',
    isSticker: true,
  }).ok, true);

  // Voice URL & UUID phải khớp chính xác
  const uuid = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789abc';
  assert.strictEqual(isValidVoiceUrl(`/api/voice/${uuid}`, uuid), true);
  assert.strictEqual(isValidVoiceUrl('/api/voice/other-id', uuid), false);
  assert.strictEqual(isValidVoiceUrl(`/api/voice/${uuid}?next=https://evil.example`, uuid), false);
  assert.strictEqual(validatePayload(CLIENT_TYPES.VOICE, {
    voiceId: uuid,
    url: `/api/voice/${uuid}`,
    duration: Number.NaN,
  }).ok, false);

  console.log('✅ Passed: URL Allowlist & Voice validation');

  console.log('--- 2. Kiểm thử Audio Magic Bytes & MIME (Chống Upload Spoofing) ---');

  assert.strictEqual(normalizeVoiceMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.strictEqual(normalizeVoiceMime('text/html'), null);
  assert.strictEqual(normalizeVoiceMime('image/svg+xml'), null);
  assert.strictEqual(normalizeVoiceMime('application/javascript'), null);

  // Giả mạo HTML/JS trong body
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from('<html><script>alert(1)</script></html>')), false);
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from('short')), false);

  // Định dạng âm thanh hợp lệ
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81])), true, 'WebM EBML');
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00', 'binary')), true, 'Ogg');
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from('\x00\x00\x00\x18ftypmp42\x00\x00', 'binary')), true, 'MP4');
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary')), true, 'WAV');
  assert.strictEqual(isValidAudioMagicBytes(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00', 'binary')), true, 'MP3 ID3');

  console.log('✅ Passed: Audio MIME & Magic Bytes');

  console.log('--- 3. Kiểm thử Unicode Bidi (RLO) & Zero-Width Spoofing ---');

  const dirtyNick = 'Cánh\u202E Cụt\u200B\uFEFF';
  const cleanedNick = stripDangerousUnicode(dirtyNick, { allowNewlines: false });
  assert.strictEqual(cleanedNick, 'Cánh Cụt');

  const dirtyMsg = 'Xin chào\u202E\nDòng hai\u200B\x00!';
  assert.strictEqual(stripDangerousUnicode(dirtyMsg, { allowNewlines: true }), 'Xin chào\nDòng hai!');

  // Không thể dùng ký tự độ rộng 0 để lách đánh số biệt danh trùng
  const existing = [{ clientId: 'c1', baseNickname: 'Cánh Cụt', nickname: 'Cánh Cụt', nicknameNumber: null }];
  const resolved = resolveRoomNickname(existing, 'Cánh Cụt\u200B');
  assert.strictEqual(resolved.displayName, 'Cánh Cụt 2');
  assert.strictEqual(existing[0].nickname, 'Cánh Cụt 1');

  console.log('✅ Passed: Unicode Bidi & Zero-Width defense');

  console.log('--- 4. Kiểm thử Path Traversal & Dotfile Exposure ---');

  const frontendDir = path.join(__dirname, '..', 'frontend');
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/'), path.resolve(frontendDir, 'index.html'));
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/index.html'), path.resolve(frontendDir, 'index.html'));
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/../backend/server.js'), null);
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/%2e%2e/backend/.env'), null);
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/.env'), null);
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/.git/config'), null);
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/%00index.html'), null);
  assert.strictEqual(resolveSafeStaticPath(frontendDir, '/..\\backend\\server.js'), null);
  // Kiểm tra lỗi sibling-prefix (/frontend vs /frontend-secret)
  assert.strictEqual(resolveSafeStaticPath('/tmp/frontend', '/../frontend-secret/secret.txt'), null);

  console.log('✅ Passed: Path Traversal & Dotfile defense');

  console.log('--- 5. Kiểm thử Chống IP Spoofing (X-Forwarded-For) ---');

  const spoofedReq = {
    socket: { remoteAddress: '::ffff:198.51.100.10' },
    headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.42' },
  };
  assert.strictEqual(getClientIp(spoofedReq, { trustProxy: false }), '198.51.100.10', 'Phải bỏ qua XFF khi TRUST_PROXY=false');
  assert.strictEqual(getClientIp(spoofedReq, { trustProxy: true, trustProxyHops: 1 }), '203.0.113.42', 'Phải lấy IP từ proxy tin cậy bên phải cùng');

  console.log('✅ Passed: IP Spoofing defense');

  console.log('--- 6. Kiểm thử CSWSH Origin Validation ---');

  assert.strictEqual(
    isAllowedWsOrigin({ headers: { host: 'localhost:3001', origin: 'http://localhost:3001' } }, ''),
    true,
    'Same-Origin phải được chấp nhận'
  );
  assert.strictEqual(
    isAllowedWsOrigin({ headers: { host: 'localhost:3001', origin: 'https://evil.example' } }, ''),
    false,
    'Cross-Origin phải bị chặn mặc định ngay cả khi chưa cấu hình ALLOWED_ORIGINS'
  );
  assert.strictEqual(
    isAllowedWsOrigin({ headers: { host: 'localhost:3001', origin: 'https://app.example.com' } }, 'https://app.example.com'),
    true,
    'Origin trong allowlist phải được chấp nhận'
  );
  assert.strictEqual(
    isAllowedWsOrigin({ headers: { host: 'localhost:3001', origin: 'https://evil.example' } }, 'https://app.example.com'),
    false,
    'Origin ngoài allowlist phải bị chặn'
  );

  console.log('✅ Passed: CSWSH Origin defense');

  console.log('--- 7. Kiểm thử Timing-Safe Token, Headers, Rate Limiter & Moderation Prune ---');

  assert.strictEqual(safeTokenEquals('secret-token-123', 'secret-token-123'), true);
  assert.strictEqual(safeTokenEquals('secret-token-123', 'secret-token-124'), false);
  assert.strictEqual(safeTokenEquals('short', 'much-longer-token'), false);
  assert.strictEqual(safeTokenEquals('', ''), false);

  const htmlHeaders = getSecurityHeaders({ isHtml: true, isHttps: true });
  assert.ok(htmlHeaders['Content-Security-Policy'].includes("script-src 'self'"));
  assert.strictEqual(htmlHeaders['X-Frame-Options'], 'DENY');
  assert.strictEqual(htmlHeaders['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(htmlHeaders['Referrer-Policy'], 'no-referrer');
  assert.ok(htmlHeaders['Strict-Transport-Security'].includes('max-age=31536000'));

  const limiter = new SlidingWindowLimiter({ maxRequests: 2, windowMs: 1000, maxKeys: 3 });
  assert.strictEqual(limiter.check('k1').allowed, true);
  assert.strictEqual(limiter.check('k1').allowed, true);
  assert.strictEqual(limiter.check('k1').allowed, false);
  limiter.check('k2');
  limiter.check('k3');
  limiter.check('k4');
  assert.strictEqual(limiter.buckets.size, 3, 'SlidingWindowLimiter phải giới hạn số key tối đa');

  const mod = new Moderation();
  mod.bannedClients.set('expired-user', { expiresAt: Date.now() - 1000, reason: 'test' });
  mod.bannedIps.set('10.1.1.1', { expiresAt: Date.now() - 1000, reason: 'test' });
  mod.pruneExpired();
  assert.strictEqual(mod.bannedClients.size, 0, 'pruneExpired phải dọn ban hết hạn');
  assert.strictEqual(mod.bannedIps.size, 0, 'pruneExpired phải dọn IP ban hết hạn');

  console.log('✅ Passed: Timing-Safe, Headers, Rate Limiter & Moderation Prune');
}

// ─── PHẦN 2: KIỂM THỬ TÍCH HỢP HTTP & WEBSOCKET CỤC BỘ ───────────────────────

const TEST_PORT = 3912;
const BASE_HTTP = `http://127.0.0.1:${TEST_PORT}`;
const BASE_WS = `ws://127.0.0.1:${TEST_PORT}`;

function httpRequest({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: reqPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function connectWs({ headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE_WS, { headers });
    const queue = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const waiter = waiters.splice(idx, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        queue.push(msg);
      }
    });

    const waitFor = (predicate, timeoutMs = 4000) => {
      const qIdx = queue.findIndex(predicate);
      if (qIdx >= 0) return Promise.resolve(queue.splice(qIdx, 1)[0]);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const wIdx = waiters.indexOf(entry);
          if (wIdx >= 0) waiters.splice(wIdx, 1);
          rej(new Error('Timeout chờ WebSocket message'));
        }, timeoutMs);
        const entry = { predicate, resolve: res, timer };
        waiters.push(entry);
      });
    };

    const send = (type, payload = {}) => {
      ws.send(JSON.stringify({ type, payload }));
    };

    ws.once('open', () => resolve({ ws, waitFor, send }));
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`Unexpected HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
  });
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        USE_REDIS: 'false',
        TRUST_PROXY: 'false',
        MAX_CONNECTIONS_PER_IP: '4',
        ALLOWED_ORIGINS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        child.kill();
        reject(new Error('Server không khởi động kịp trong 8 giây'));
      }
    }, 8000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (!started && text.includes(`http://localhost:${TEST_PORT}`)) {
        started = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('EADDRINUSE')) {
        clearTimeout(timeout);
        reject(new Error(`Port ${TEST_PORT} đang bị chiếm`));
      }
    });

    child.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server thoát sớm với mã ${code}`));
      }
    });
  });
}

async function runLiveIntegrationTests() {
  console.log('\n--- 8. Kiểm thử tích hợp HTTP & WebSocket trên server cục bộ ---');
  const serverProc = await startLocalServer();
  const openSockets = [];

  try {
    // 8.1 Security Headers trên GET /
    const homeRes = await httpRequest({ reqPath: '/' });
    assert.strictEqual(homeRes.statusCode, 200);
    assert.ok(homeRes.headers['content-security-policy'], 'GET / phải có Content-Security-Policy');
    assert.ok(homeRes.headers['content-security-policy'].includes("script-src 'self'"));
    assert.strictEqual(homeRes.headers['x-frame-options'], 'DENY');
    assert.strictEqual(homeRes.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(homeRes.headers['referrer-policy'], 'no-referrer');
    assert.ok(homeRes.headers['permissions-policy']);

    // 8.2 Chặn Path Traversal & Dotfile & Method sai
    const travRes = await httpRequest({ reqPath: '/%2e%2e/backend/server.js' });
    assert.strictEqual(travRes.statusCode, 403, 'Path traversal %2e%2e phải bị chặn 403');
    const dotfileRes = await httpRequest({ reqPath: '/.env' });
    assert.strictEqual(dotfileRes.statusCode, 403, 'Dotfile /.env phải bị chặn 403');
    const methodRes = await httpRequest({ method: 'DELETE', reqPath: '/' });
    assert.strictEqual(methodRes.statusCode, 405, 'DELETE / phải trả 405');

    // 8.3 Voice Upload Hardening (Origin CSRF, MIME, Magic Bytes, Valid WebM, Rate Limit 429)
    const crossOriginVoice = await httpRequest({
      method: 'POST',
      reqPath: '/api/voice/upload',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'audio/webm',
      },
      body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]),
    });
    assert.strictEqual(crossOriginVoice.statusCode, 403, 'Cross-origin voice upload phải trả 403');

    const badMimeVoice = await httpRequest({
      method: 'POST',
      reqPath: '/api/voice/upload',
      headers: { 'Content-Type': 'text/html' },
      body: Buffer.from('<html>bad</html>'),
    });
    assert.strictEqual(badMimeVoice.statusCode, 415, 'Content-Type không phải audio phải trả 415');

    const spoofedAudioBody = await httpRequest({
      method: 'POST',
      reqPath: '/api/voice/upload',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    assert.strictEqual(spoofedAudioBody.statusCode, 415, 'Magic bytes giả mạo audio phải trả 415');

    const validWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x00, 0x01]);
    const okVoice = await httpRequest({
      method: 'POST',
      reqPath: '/api/voice/upload',
      headers: { 'Content-Type': 'audio/webm' },
      body: validWebm,
    });
    assert.strictEqual(okVoice.statusCode, 201, 'WebM hợp lệ phải trả 201');
    const uploadedMeta = JSON.parse(okVoice.body.toString());
    assert.ok(uploadedMeta.voiceId);
    const getVoiceRes = await httpRequest({ reqPath: uploadedMeta.url });
    assert.strictEqual(getVoiceRes.statusCode, 200);
    assert.strictEqual(getVoiceRes.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(getVoiceRes.headers['content-disposition'], 'inline');

    // Gửi tiếp để chạm ngưỡng rate limit voice upload (12/phút)
    let got429 = false;
    for (let i = 0; i < 15; i += 1) {
      const r = await httpRequest({
        method: 'POST',
        reqPath: '/api/voice/upload',
        headers: { 'Content-Type': 'audio/webm' },
        body: validWebm,
      });
      if (r.statusCode === 429) {
        got429 = true;
        break;
      }
    }
    assert.strictEqual(got429, true, 'Vượt quá giới hạn tải Voice phải bị chặn 429');

    // 8.4 CSWSH WebSocket Origin Defense
    let evilOriginBlocked = false;
    try {
      await connectWs({ headers: { Origin: 'https://evil.example' } });
    } catch (err) {
      if (err.statusCode === 403 || String(err.message).includes('403')) {
        evilOriginBlocked = true;
      }
    }
    assert.strictEqual(evilOriginBlocked, true, 'WebSocket từ Origin trái phép phải bị từ chối 403');

    // Same-Origin WebSocket phải kết nối thành công
    const c1 = await connectWs({ headers: { Origin: BASE_HTTP } });
    openSockets.push(c1.ws);
    const conn1 = await c1.waitFor((m) => m.type === 'connected');
    assert.ok(conn1.payload.clientId);

    // 8.5 Kiểm duyệt biệt danh vi phạm, chặn Meme XSS / IP-grabber, và WS Frame Flood
    c1.send(CLIENT_TYPES.JOIN, { nickname: 'bán cần sa cỏ mỹ', interests: [] });
    const badNickErr = await c1.waitFor((m) => m.type === 'error');
    assert.strictEqual(badNickErr.payload.code, 'INVALID_PAYLOAD', 'Biệt danh vi phạm phải bị từ chối');

    c1.send(CLIENT_TYPES.JOIN, { nickname: 'Cáo An Toàn', interests: [] });
    c1.send(CLIENT_TYPES.MEME, { url: 'javascript:alert(1)', title: 'test' });
    const badMemeErr1 = await c1.waitFor((m) => m.type === 'error');
    assert.strictEqual(badMemeErr1.payload.code, 'INVALID_PAYLOAD', 'Meme javascript: phải bị chặn');

    c1.send(CLIENT_TYPES.MEME, { url: 'https://evil-grabber.example/ip.gif', title: 'track' });
    const badMemeErr2 = await c1.waitFor((m) => m.type === 'error');
    assert.strictEqual(badMemeErr2.payload.code, 'INVALID_PAYLOAD', 'Meme IP-grabber ngoài allowlist phải bị chặn');

    // Flood WS > 60 frame/5s phải bị RATE_LIMITED
    for (let i = 0; i < 65; i += 1) {
      c1.send(CLIENT_TYPES.GROUP_LIST, {});
    }
    const floodErr = await c1.waitFor((m) => m.type === 'error' && m.payload.code === 'RATE_LIMITED');
    assert.strictEqual(floodErr.payload.code, 'RATE_LIMITED', 'WS frame flood phải kích hoạt RATE_LIMITED');

    // 8.6 Giả mạo X-Forwarded-For KHÔNG thể vượt qua MAX_CONNECTIONS_PER_IP=4
    // Hiện tại c1 đang chiếm 1/4 slot trên 127.0.0.1 -> mở thêm 3 kết nối với XFF giả khác nhau (tổng 4/4)
    for (let i = 2; i <= 4; i += 1) {
      const extra = await connectWs({ headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
      openSockets.push(extra.ws);
      await extra.waitFor((m) => m.type === 'connected');
    }

    // Kết nối thứ 5 dù gửi X-Forwarded-For mới tinh vẫn phải bị đóng mã 1008!
    const fifthClosedCode = await new Promise((resolve, reject) => {
      const ws5 = new WebSocket(BASE_WS, { headers: { 'X-Forwarded-For': '10.99.99.99' } });
      openSockets.push(ws5);
      const timer = setTimeout(() => reject(new Error('Kết nối thứ 5 không bị chặn dù vượt MAX_CONNECTIONS_PER_IP')), 4000);
      ws5.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws5.once('error', () => {});
    });
    assert.strictEqual(fifthClosedCode, 1008, 'Giả mạo X-Forwarded-For không được phép vượt giới hạn kết nối theo IP');

    console.log('✅ Passed: Live HTTP Security Headers, Path Traversal, Voice Hardening, CSWSH, Flood & Anti-IP-Spoofing');
  } finally {
    for (const sock of openSockets) {
      try { sock.terminate(); } catch (_) {}
    }
    serverProc.kill();
    await new Promise((res) => setTimeout(res, 250));
  }
}

(async () => {
  try {
    runUnitTests();
    await runLiveIntegrationTests();
    console.log('\n🎉 TẤT CẢ KIỂM THỬ BẢO MẬT ĐỀU VƯỢT QUA 100%!');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ KIỂM THỬ BẢO MẬT THẤT BẠI:', err);
    process.exit(1);
  }
})();
