/**
 * load-test.js – Script kiểm thử tải (Load Testing)
 *
 * Mô phỏng nhiều client kết nối đồng thời đến WebSocket Server.
 * Đo lường:
 *   1. Thời gian kết nối (Connection Latency)
 *   2. Thời gian ghép cặp (Matchmaking Latency)
 *   3. Thời gian gửi-nhận tin nhắn (Message Round-Trip)
 *   4. Tỷ lệ ổn định ở quy mô kiểm thử
 *   5. Tỷ lệ lỗi
 *
 * Sử dụng:
 *   node load-test.js [số_client] [server_url]
 *
 * Ví dụ:
 *   node load-test.js 100 ws://localhost:3001
 *   node load-test.js 200
 */

'use strict';

const fs = require('fs');
const path = require('path');
let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = require('../backend/node_modules/ws');
}

// ─── Cấu hình ──────────────────────────────────────────────────────────────

const NUM_CLIENTS = parseInt(process.argv[2]) || 100;
const SERVER_URL = process.argv[3] || 'ws://localhost:3001';
const STAGGER_DELAY = 20;       // ms giữa mỗi client kết nối
const MESSAGE_COUNT = 3;        // số tin nhắn mỗi client gửi sau khi ghép cặp
const MESSAGE_INTERVAL = 500;   // ms giữa mỗi tin nhắn
const TEST_TIMEOUT = 120_000;   // timeout toàn bộ test (ms)

// ─── Danh sách sở thích mẫu ────────────────────────────────────────────────

const SAMPLE_INTERESTS = [
  'âm nhạc', 'phim ảnh', 'game', 'thể thao', 'công nghệ',
  'du lịch', 'ẩm thực', 'sách', 'nghệ thuật', 'lập trình',
];

// ─── Thống kê ──────────────────────────────────────────────────────────────

const stats = {
  totalClients: NUM_CLIENTS,
  connected: 0,
  connectFailed: 0,
  matched: 0,
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,

  // Latency tracking
  connectLatencies: [],
  matchLatencies: [],
  messageLatencies: [],

  startTime: 0,
  endTime: 0,
};

const clientContexts = new Map(); // clientIndex → context

// ─── Helper ────────────────────────────────────────────────────────────────

function randomNickname(index) {
  return `TestUser_${index}`;
}

function randomInterests() {
  const count = Math.floor(Math.random() * 3) + 1; // 1-3 sở thích
  const shuffled = [...SAMPLE_INTERESTS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ─── Tạo một client mô phỏng ──────────────────────────────────────────────

function createClient(index) {
  return new Promise((resolve) => {
    const context = {
      index,
      nickname: randomNickname(index),
      interests: randomInterests(),
      ws: null,
      connectStart: Date.now(),
      matchStart: 0,
      msgSent: 0,
      msgReceived: 0,
      matched: false,
      closed: false,
    };

    clientContexts.set(index, context);

    try {
      const ws = new WebSocket(SERVER_URL);
      context.ws = ws;

      // Timeout kết nối
      const connectTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          stats.connectFailed++;
          ws.terminate();
          resolve();
        }
      }, 10_000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        const latency = Date.now() - context.connectStart;
        stats.connectLatencies.push(latency);
        stats.connected++;

        // Join + find_match
        send(ws, 'join', { nickname: context.nickname, interests: context.interests });
        context.matchStart = Date.now();
        send(ws, 'find_match');

        resolve();
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          handleClientMessage(context, msg);
        } catch {
          stats.errors++;
        }
      });

      ws.on('error', () => {
        stats.errors++;
        if (!context.closed) {
          stats.connectFailed++;
          context.closed = true;
        }
        resolve();
      });

      ws.on('close', () => {
        context.closed = true;
      });
    } catch {
      stats.connectFailed++;
      resolve();
    }
  });
}

function handleClientMessage(context, msg) {
  switch (msg.type) {
    case 'match_found': {
      if (!context.matched) {
        context.matched = true;
        stats.matched++;
        const latency = Date.now() - context.matchStart;
        stats.matchLatencies.push(latency);

        // Bắt đầu gửi tin nhắn
        startSendingMessages(context);
      }
      break;
    }

    case 'message': {
      context.msgReceived++;
      stats.messagesReceived++;

      // Tính message latency chính xác (Client A gửi -> Server -> Client B nhận)
      const received = Date.now();
      let measured = false;

      if (msg.payload && typeof msg.payload.text === 'string') {
        const match = msg.payload.text.match(/^__TS:(\d+)__/);
        if (match) {
          const sent = parseInt(match[1], 10);
          const latency = received - sent;
          if (latency >= 0 && latency < 10000) {
            stats.messageLatencies.push(latency);
            measured = true;
          }
        }
      }

      if (!measured && msg.payload && msg.payload.timestamp) {
        const sent = new Date(msg.payload.timestamp).getTime();
        const latency = received - sent;
        if (latency >= 0 && latency < 10000) {
          stats.messageLatencies.push(latency);
        }
      }
      break;
    }

    case 'waiting':
      // Đang trong hàng đợi – bình thường
      break;

    case 'partner_left':
      // Đối phương rời đi
      break;

    case 'error':
      stats.errors++;
      break;
  }
}

function startSendingMessages(context) {
  let count = 0;
  const interval = setInterval(() => {
    if (count >= MESSAGE_COUNT || context.closed || !context.ws || context.ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }

    const sentAt = Date.now();
    const text = `__TS:${sentAt}__ Test message ${count + 1} from ${context.nickname}`;
    send(context.ws, 'message', { text });
    context.msgSent++;
    stats.messagesSent++;
    count++;
  }, MESSAGE_INTERVAL);
}

// ─── Chạy test ─────────────────────────────────────────────────────────────

async function runTest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  🧪 WebSocket Load Test – Nhóm 9');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Server:     ${SERVER_URL}`);
  console.log(`  Clients:    ${NUM_CLIENTS}`);
  console.log(`  Messages:   ${MESSAGE_COUNT} per client`);
  console.log(`  Stagger:    ${STAGGER_DELAY}ms between connections`);
  console.log('═══════════════════════════════════════════════════\n');

  stats.startTime = Date.now();

  // Tạo clients lần lượt (stagger)
  console.log(`[Test] Đang tạo ${NUM_CLIENTS} clients...`);

  for (let i = 0; i < NUM_CLIENTS; i++) {
    await createClient(i);

    // Stagger delay
    if (STAGGER_DELAY > 0 && i < NUM_CLIENTS - 1) {
      await new Promise((r) => setTimeout(r, STAGGER_DELAY));
    }

    // Log tiến trình
    if ((i + 1) % 50 === 0 || i === NUM_CLIENTS - 1) {
      console.log(`[Test] Clients created: ${i + 1}/${NUM_CLIENTS}, connected: ${stats.connected}, matched: ${stats.matched}`);
    }
  }

  // Chờ đủ thời gian để hàng đợi nới lỏng tiêu chí ghép cặp sau 10 giây.
  const expectedMatches = stats.connected - (stats.connected % 2);
  const matchDeadline = Date.now() + 15_000;
  while (stats.matched < expectedMatches && Date.now() < matchDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (stats.matched < expectedMatches) {
    console.warn(`[Test] Chỉ ghép được ${stats.matched}/${expectedMatches} clients trước timeout.`);
  }

  // Chờ các client đã ghép hoàn thành gửi tin nhắn.
  console.log('\n[Test] Đang chờ hoàn thành tin nhắn...');
  await new Promise((r) => setTimeout(r, (MESSAGE_COUNT + 2) * MESSAGE_INTERVAL + 2000));

  stats.endTime = Date.now();

  // Đóng tất cả kết nối
  console.log('[Test] Đóng kết nối...');
  for (const [, ctx] of clientContexts) {
    if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
      ctx.ws.close(1000, 'Test completed');
    }
  }

  // Chờ đóng kết nối
  await new Promise((r) => setTimeout(r, 1000));

  // Dọn dẹp timer timeout
  clearTimeout(testTimeout);

  // In kết quả và lưu ra file JSON
  printResults();
  saveResultsToFile();

  process.exit(0);
}

// ─── In kết quả ────────────────────────────────────────────────────────────

function printResults() {
  const duration = (stats.endTime - stats.startTime) / 1000;

  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║           📊 KẾT QUẢ KIỂM THỬ TẢI               ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log('║                                                   ║');
  console.log(`║  Tổng thời gian test:     ${duration.toFixed(1)}s`.padEnd(52) + '║');
  console.log(`║  Tổng số client:          ${stats.totalClients}`.padEnd(52) + '║');
  console.log(`║  Kết nối thành công:      ${stats.connected}`.padEnd(52) + '║');
  console.log(`║  Kết nối thất bại:        ${stats.connectFailed}`.padEnd(52) + '║');
  console.log(`║  Ghép cặp thành công:     ${stats.matched}`.padEnd(52) + '║');
  console.log(`║  Tin nhắn gửi:            ${stats.messagesSent}`.padEnd(52) + '║');
  console.log(`║  Tin nhắn nhận:           ${stats.messagesReceived}`.padEnd(52) + '║');
  console.log(`║  Lỗi:                     ${stats.errors}`.padEnd(52) + '║');
  console.log('║                                                   ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log('║  ⏱️  ĐỘ TRỄ KẾT NỐI (Connection Latency)        ║');
  console.log('╠═══════════════════════════════════════════════════╣');

  if (stats.connectLatencies.length > 0) {
    console.log(`║  Trung bình:   ${average(stats.connectLatencies).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P50:          ${percentile(stats.connectLatencies, 50).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P95:          ${percentile(stats.connectLatencies, 95).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P99:          ${percentile(stats.connectLatencies, 99).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  Min:          ${Math.min(...stats.connectLatencies).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  Max:          ${Math.max(...stats.connectLatencies).toFixed(1)} ms`.padEnd(52) + '║');
  } else {
    console.log('║  Không có dữ liệu'.padEnd(52) + '║');
  }

  console.log('║                                                   ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log('║  🔍 ĐỘ TRỄ GHÉP CẶP (Matchmaking Latency)       ║');
  console.log('╠═══════════════════════════════════════════════════╣');

  if (stats.matchLatencies.length > 0) {
    console.log(`║  Trung bình:   ${average(stats.matchLatencies).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P50:          ${percentile(stats.matchLatencies, 50).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P95:          ${percentile(stats.matchLatencies, 95).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P99:          ${percentile(stats.matchLatencies, 99).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  Min:          ${Math.min(...stats.matchLatencies).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  Max:          ${Math.max(...stats.matchLatencies).toFixed(1)} ms`.padEnd(52) + '║');
  } else {
    console.log('║  Không có dữ liệu'.padEnd(52) + '║');
  }

  console.log('║                                                   ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log('║  💬 ĐỘ TRỄ TIN NHẮN (Message Latency)           ║');
  console.log('╠═══════════════════════════════════════════════════╣');

  if (stats.messageLatencies.length > 0) {
    console.log(`║  Trung bình:   ${average(stats.messageLatencies).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P50:          ${percentile(stats.messageLatencies, 50).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P95:          ${percentile(stats.messageLatencies, 95).toFixed(1)} ms`.padEnd(52) + '║');
    console.log(`║  P99:          ${percentile(stats.messageLatencies, 99).toFixed(1)} ms`.padEnd(52) + '║');
  } else {
    console.log('║  Không có dữ liệu'.padEnd(52) + '║');
  }

  console.log('║                                                   ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log('║  📈 TỶ LỆ                                        ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  const connectRate = stats.totalClients > 0 ? ((stats.connected / stats.totalClients) * 100).toFixed(1) : '0';
  const matchRate = stats.connected > 0 ? ((stats.matched / stats.connected) * 100).toFixed(1) : '0';
  const errorRate = stats.totalClients > 0 ? ((stats.errors / stats.totalClients) * 100).toFixed(1) : '0';
  console.log(`║  Kết nối thành công:   ${connectRate}%`.padEnd(52) + '║');
  console.log(`║  Ghép cặp thành công:  ${matchRate}%`.padEnd(52) + '║');
  console.log(`║  Tỷ lệ lỗi:           ${errorRate}%`.padEnd(52) + '║');

  console.log('║                                                   ║');
  console.log('╚═══════════════════════════════════════════════════╝');
}

/**
 * Lưu kết quả test ra file JSON để phục vụ làm báo cáo thực tế.
 */
function saveResultsToFile() {
  const duration = (stats.endTime - stats.startTime) / 1000;
  const resultData = {
    testDate: new Date().toISOString(),
    config: {
      serverUrl: SERVER_URL,
      totalClients: NUM_CLIENTS,
      messagesPerClient: MESSAGE_COUNT,
      messageIntervalMs: MESSAGE_INTERVAL,
      staggerDelayMs: STAGGER_DELAY,
    },
    summary: {
      durationSeconds: parseFloat(duration.toFixed(2)),
      connected: stats.connected,
      connectFailed: stats.connectFailed,
      connectSuccessRatePercent: parseFloat((stats.totalClients > 0 ? (stats.connected / stats.totalClients) * 100 : 0).toFixed(1)),
      matched: stats.matched,
      matchRatePercent: parseFloat((stats.connected > 0 ? (stats.matched / stats.connected) * 100 : 0).toFixed(1)),
      messagesSent: stats.messagesSent,
      messagesReceived: stats.messagesReceived,
      errors: stats.errors,
      errorRatePercent: parseFloat((stats.totalClients > 0 ? (stats.errors / stats.totalClients) * 100 : 0).toFixed(1)),
    },
    latency: {
      connection: {
        avgMs: parseFloat(average(stats.connectLatencies).toFixed(2)),
        p50Ms: parseFloat(percentile(stats.connectLatencies, 50).toFixed(2)),
        p95Ms: parseFloat(percentile(stats.connectLatencies, 95).toFixed(2)),
        p99Ms: parseFloat(percentile(stats.connectLatencies, 99).toFixed(2)),
        minMs: stats.connectLatencies.length > 0 ? Math.min(...stats.connectLatencies) : 0,
        maxMs: stats.connectLatencies.length > 0 ? Math.max(...stats.connectLatencies) : 0,
      },
      matchmaking: {
        avgMs: parseFloat(average(stats.matchLatencies).toFixed(2)),
        p50Ms: parseFloat(percentile(stats.matchLatencies, 50).toFixed(2)),
        p95Ms: parseFloat(percentile(stats.matchLatencies, 95).toFixed(2)),
        p99Ms: parseFloat(percentile(stats.matchLatencies, 99).toFixed(2)),
        minMs: stats.matchLatencies.length > 0 ? Math.min(...stats.matchLatencies) : 0,
        maxMs: stats.matchLatencies.length > 0 ? Math.max(...stats.matchLatencies) : 0,
      },
      message: {
        avgMs: parseFloat(average(stats.messageLatencies).toFixed(2)),
        p50Ms: parseFloat(percentile(stats.messageLatencies, 50).toFixed(2)),
        p95Ms: parseFloat(percentile(stats.messageLatencies, 95).toFixed(2)),
        p99Ms: parseFloat(percentile(stats.messageLatencies, 99).toFixed(2)),
        minMs: stats.messageLatencies.length > 0 ? Math.min(...stats.messageLatencies) : 0,
        maxMs: stats.messageLatencies.length > 0 ? Math.max(...stats.messageLatencies) : 0,
      },
    },
  };

  const outputPath = path.join(__dirname, 'load-test-results.json');
  try {
    fs.writeFileSync(outputPath, JSON.stringify(resultData, null, 2), 'utf-8');
    console.log(`\n💾 Đã lưu kết quả kiểm thử vào: ${outputPath}`);
  } catch (err) {
    console.error(`\n⚠️ Không thể lưu kết quả kiểm thử:`, err.message);
  }
}

// ─── Timeout toàn bộ test ──────────────────────────────────────────────────

const testTimeout = setTimeout(() => {
  console.error('\n[Test] ⚠️ Test timeout!');
  stats.endTime = Date.now();
  printResults();
  saveResultsToFile();
  process.exit(1);
}, TEST_TIMEOUT);

// ─── Chạy ──────────────────────────────────────────────────────────────────

runTest().catch((err) => {
  clearTimeout(testTimeout);
  console.error('[Test] Fatal error:', err);
  process.exit(1);
});
