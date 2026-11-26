/**
 * attachmentUpload.test.js – Kiểm thử E2E luồng gửi ảnh / video / tài liệu (đủ 12 định dạng)
 *
 * Chế độ mặc định: Kiểm thử đầy đủ luồng WebSocket + HTTP Upload + Partner Download
 * bằng bộ lưu tạm cục bộ (không cần Azure/Redis).
 *
 * Chế độ Azure thật (khi đặt TEST_AZURE_LIVE=true và AZURE_STORAGE_ACCOUNT_NAME=...):
 * Chạy chính server.js thật, ghép cặp 2 client qua WebSocket, tải đủ 12 định dạng lên
 * Azure Blob Storage, tạo User Delegation SAS HTTPS và xác minh đối phương tải được 200 OK
 * khớp từng byte!
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../backend/node_modules/ws');

const { CLIENT_TYPES } = require('../backend/protocol');

const LIVE_AZURE = process.env.TEST_AZURE_LIVE === 'true';
const TEST_PORT = LIVE_AZURE ? 3914 : 3913;
const BASE_HTTP = `http://127.0.0.1:${TEST_PORT}`;
const BASE_WS = `ws://127.0.0.1:${TEST_PORT}`;

// 12 mẫu dữ liệu hợp lệ (có đúng magic bytes) cho toàn bộ định dạng trong <input accept="...">
const SAMPLE_FILES = [
  // Ảnh (5 đuôi, 4 nhóm MIME)
  {
    name: '  photo.jpg  ', // kiểm tra luôn việc trim khoảng trắng đầu/cuối
    expectedName: 'photo.jpg',
    category: 'image',
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]),
  },
  {
    name: 'sample.png',
    expectedName: 'sample.png',
    category: 'image',
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  },
  {
    name: 'anim.gif',
    expectedName: 'anim.gif',
    category: 'image',
    bytes: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'),
  },
  {
    name: 'pic.webp',
    expectedName: 'pic.webp',
    category: 'image',
    bytes: Buffer.from('RIFF\x14\x00\x00\x00WEBPVP8 \x08\x00\x00\x00\x00\x00\x00\x00', 'binary'),
  },
  // Video (2 định dạng)
  {
    name: 'clip.mp4',
    expectedName: 'clip.mp4',
    category: 'video',
    bytes: Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 'binary'),
  },
  {
    name: 'clip.webm',
    expectedName: 'clip.webm',
    category: 'video',
    bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81]),
  },
  // Tài liệu (6 định dạng)
  {
    name: 'doc.pdf',
    expectedName: 'doc.pdf',
    category: 'document',
    bytes: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8'),
  },
  {
    name: 'note.txt',
    expectedName: 'note.txt',
    category: 'document',
    bytes: Buffer.from('Xin chào ChatMatch! Kiểm thử tệp TXT tiếng Việt UTF-8.\n', 'utf8'),
  },
  {
    name: 'data.csv',
    expectedName: 'data.csv',
    category: 'document',
    bytes: Buffer.from('name,score\nAlice,10\nBob,9\n', 'utf8'),
  },
  {
    name: 'report.docx',
    expectedName: 'report.docx',
    category: 'document',
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  },
  {
    name: 'sheet.xlsx',
    expectedName: 'sheet.xlsx',
    category: 'document',
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  },
  {
    name: 'slides.pptx',
    expectedName: 'slides.pptx',
    category: 'document',
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  },
];

function startServer() {
  const env = {
    ...process.env,
    PORT: String(TEST_PORT),
    USE_REDIS: 'false',
    MAX_CONNECTIONS_PER_IP: '50',
  };

  if (LIVE_AZURE) {
    env.AZURE_STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME || 'chatmatchfiles2026';
    env.AZURE_STORAGE_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER_NAME || 'chat-attachments';
    env.ATTACHMENT_TOKEN_SECRET = process.env.ATTACHMENT_TOKEN_SECRET || crypto.randomBytes(32).toString('base64url');
    env.SKIP_MALWARE_SCAN = process.env.SKIP_MALWARE_SCAN || 'true';
  } else {
    env.AZURE_STORAGE_ACCOUNT_NAME = '';
    env.ATTACHMENT_TOKEN_SECRET = '';
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    let stderrBuf = '';
    const timer = setTimeout(() => {
      if (!started) {
        child.kill();
        reject(new Error(`Server không khởi động kịp. stderr=${stderrBuf}`));
      }
    }, 10000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (!started && text.includes(`http://localhost:${TEST_PORT}`)) {
        started = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on('exit', (code) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`Server thoát sớm (${code}): ${stderrBuf}`));
      }
    });
  });
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE_WS);
    const queue = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const w = waiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });

    const waitFor = (predicate, timeoutMs = 15000) => {
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

    const send = (type, payload = {}) => ws.send(JSON.stringify({ type, payload }));
    ws.once('open', () => resolve({ ws, waitFor, send }));
    ws.once('error', reject);
  });
}

function httpPostUpload(uploadPath, ticket, contentType, bytes) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: uploadPath,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ticket}`,
        'Content-Type': contentType,
        'Content-Length': bytes.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(bytes);
    req.end();
  });
}

function downloadUrl(rawUrl) {
  const fullUrl = new URL(rawUrl, BASE_HTTP);
  const mod = fullUrl.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(fullUrl, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

async function createMatchedPair(label) {
  const a = await connectClient();
  const b = await connectClient();
  await a.waitFor((m) => m.type === 'connected');
  await b.waitFor((m) => m.type === 'connected');

  a.send(CLIENT_TYPES.JOIN, { nickname: `Sender ${label}`, interests: ['game'], deviceId: `dev-a-${label}` });
  b.send(CLIENT_TYPES.JOIN, { nickname: `Partner ${label}`, interests: ['game'], deviceId: `dev-b-${label}` });
  a.send(CLIENT_TYPES.FIND_MATCH, {});
  b.send(CLIENT_TYPES.FIND_MATCH, {});

  await a.waitFor((m) => m.type === 'match_found');
  await b.waitFor((m) => m.type === 'match_found');
  return { a, b };
}

async function sendAndVerifyFile(a, b, sample) {
  a.send(CLIENT_TYPES.ATTACHMENT_REQUEST, { fileName: sample.name, size: sample.bytes.length });
  const ticketMsg = await a.waitFor((m) => m.type === 'attachment_upload' || m.type === 'error');
  assert.strictEqual(ticketMsg.type, 'attachment_upload', `Expected ticket for ${sample.name}, got ${JSON.stringify(ticketMsg)}`);
  assert.strictEqual(ticketMsg.payload.fileName, sample.expectedName);
  assert.strictEqual(ticketMsg.payload.category, sample.category);

  const postRes = await httpPostUpload(
    ticketMsg.payload.uploadPath,
    ticketMsg.payload.ticket,
    ticketMsg.payload.contentType,
    sample.bytes
  );
  assert.strictEqual(postRes.statusCode, 201, `Upload failed for ${sample.name}: ${postRes.statusCode} ${postRes.body}`);

  a.send(CLIENT_TYPES.ATTACHMENT_SEND, { ticket: ticketMsg.payload.ticket });
  const [sentMsg, recvMsg] = await Promise.all([
    a.waitFor((m) => m.type === 'attachment_sent' || m.type === 'error'),
    b.waitFor((m) => m.type === 'attachment'),
  ]);
  assert.strictEqual(sentMsg.type, 'attachment_sent', `Expected attachment_sent for ${sample.name}, got ${JSON.stringify(sentMsg)}`);
  assert.strictEqual(recvMsg.payload.attachment.fileName, sample.expectedName);
  assert.strictEqual(recvMsg.payload.attachment.category, sample.category);
  assert.strictEqual(recvMsg.payload.attachment.size, sample.bytes.length);

  if (LIVE_AZURE) {
    assert.ok(recvMsg.payload.attachment.url.startsWith('https://'), 'Azure URL phải là HTTPS');
    assert.ok(recvMsg.payload.attachment.url.includes('.blob.core.windows.net/'), 'URL phải trỏ về Azure Blob Storage');
    assert.ok(recvMsg.payload.attachment.url.includes('sig='), 'Azure URL phải có chữ ký SAS');
  } else {
    assert.ok(recvMsg.payload.attachment.url.startsWith('/api/attachments/file/'), 'Local fallback URL phải là đường dẫn nội bộ có ký');
    assert.ok(recvMsg.payload.attachment.url.includes('sig='), 'Local URL phải có chữ ký HMAC');
  }

  // Đối phương tải tệp về và kiểm tra khớp từng byte
  const dl = await downloadUrl(recvMsg.payload.attachment.url);
  assert.strictEqual(dl.statusCode, 200, `Partner download failed for ${sample.name}: ${dl.statusCode}`);
  assert.strictEqual(dl.body.equals(sample.bytes), true, `Downloaded bytes mismatch for ${sample.name}`);

  const expectedDisp = sample.category === 'document' ? 'attachment' : 'inline';
  assert.ok(
    String(dl.headers['content-disposition'] || '').startsWith(expectedDisp),
    `Content-Disposition for ${sample.name} should start with ${expectedDisp}, got ${dl.headers['content-disposition']}`
  );
  return recvMsg.payload.attachment;
}

(async () => {
  console.log(`=== Running Attachment E2E Test Suite (mode=${LIVE_AZURE ? 'LIVE AZURE BLOB STORAGE' : 'LOCAL FALLBACK'}) ===`);
  const serverProc = await startServer();
  const sockets = [];

  try {
    // Chia 12 định dạng thành 3 phòng chat (mỗi phòng tối đa 5 tệp theo hạn mức 5 file/phòng)
    const chunks = [
      SAMPLE_FILES.slice(0, 4),   // 4 ảnh: jpg, png, gif, webp
      SAMPLE_FILES.slice(4, 8),   // 2 video + 2 doc: mp4, webm, pdf, txt
      SAMPLE_FILES.slice(8, 12),  // 4 doc: csv, docx, xlsx, pptx
    ];

    for (let idx = 0; idx < chunks.length; idx += 1) {
      const { a, b } = await createMatchedPair(`room${idx + 1}`);
      sockets.push(a.ws, b.ws);

      for (const sample of chunks[idx]) {
        await sendAndVerifyFile(a, b, sample);
        console.log(`  ✅ [${sample.category}] ${sample.expectedName} (${sample.bytes.length} bytes) -> uploaded & downloaded OK`);
      }

      // Trong phòng 1, kiểm tra thêm bảo mật từ chối định dạng cấm, giả mạo magic bytes & hạn mức 5 tệp
      if (idx === 0) {
        // 1) Định dạng cấm (.svg / .exe)
        a.send(CLIENT_TYPES.ATTACHMENT_REQUEST, { fileName: 'xss.svg', size: 120 });
        const rejSvg = await a.waitFor((m) => m.type === 'error');
        assert.strictEqual(rejSvg.payload.code, 'ATTACHMENT_REJECTED', 'File .svg phải bị từ chối');

        // 2) Chờ hết cửa sổ rate-limit (3s / 5 req) để kiểm tra magic bytes giả mạo + giới hạn 5 tệp
        await new Promise((r) => setTimeout(r, 3100));
        a.send(CLIENT_TYPES.ATTACHMENT_REQUEST, { fileName: 'spoof.png', size: 24 });
        const spoofTicket = await a.waitFor((m) => m.type === 'attachment_upload');
        const spoofRes = await httpPostUpload(
          spoofTicket.payload.uploadPath,
          spoofTicket.payload.ticket,
          spoofTicket.payload.contentType,
          Buffer.from('<html>not a png!!</html>')
        );
        assert.strictEqual(spoofRes.statusCode, 400, 'File HTML giả đuôi PNG phải bị chặn bởi kiểm tra magic bytes');

        // Đã dùng 4/5 slot hợp lệ + 1 slot bị trừ khi reserve spoof = 5/5 -> tệp thứ 6 phải bị 429!
        a.send(CLIENT_TYPES.ATTACHMENT_REQUEST, { fileName: 'sixth.txt', size: 10 });
        const sixthTicket = await a.waitFor((m) => m.type === 'attachment_upload');
        const sixthRes = await httpPostUpload(
          sixthTicket.payload.uploadPath,
          sixthTicket.payload.ticket,
          sixthTicket.payload.contentType,
          Buffer.from('1234567890')
        );
        assert.strictEqual(sixthRes.statusCode, 429, 'Tệp thứ 6 trong cùng cuộc trò chuyện phải bị chặn 429');
        console.log('  ✅ Security checks passed (.svg rejected, spoofed PNG magic bytes blocked 400, 5-file room limit enforced 429)');
      }

      // Kiểm tra chống giả mạo chữ ký tải về ở chế độ local
      if (!LIVE_AZURE && idx === 1) {
        const fakeLocalDl = await downloadUrl('/api/attachments/file/11111111-1111-4111-8111-111111111111?exp=9999999999999&sig=forged');
        assert.strictEqual(fakeLocalDl.statusCode, 404, 'URL local giả mạo chữ ký phải bị từ chối 404');
      }

      a.ws.close();
      b.ws.close();
    }

    console.log(`\n🎉 ALL 12 ATTACHMENT FORMATS + SECURITY CHECKS PASSED (${LIVE_AZURE ? 'LIVE AZURE' : 'LOCAL FALLBACK'})!`);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ ATTACHMENT E2E TEST FAILED:', err);
    process.exit(1);
  } finally {
    for (const s of sockets) {
      try { s.terminate(); } catch (_) {}
    }
    serverProc.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
})();

