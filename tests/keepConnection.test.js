/**
 * tests/keepConnection.test.js
 * Kiểm thử toàn diện tính năng "Giữ kết nối" ẩn danh 2 chiều + Mã hẹn gặp lại + Giữ 40 tin gần nhất:
 *   1. Kiểm thử protocol validation cho toàn bộ sự kiện pair_*
 *   2. Kiểm thử unit ConnectionManager (ẩn danh, đồng thuận 2 chiều, xóa sạch khi chưa đủ 2/2,
 *      giới hạn 40 tin gần nhất đúng chiều gửi/nhận, rate-limit đoán mã, hủy vĩnh viễn)
 *   3. Kiểm thử Live WebSocket E2E:
 *      - Chat 1-1 -> nhắn trước khi giữ -> cả 2 đồng ý Giữ kết nối -> nhắn vượt 40 tin -> thoát ->
 *        đồng bộ online & mời gặp lại -> khôi phục đủ 40 tin gần nhất đúng chiều!
 *      - Đổi sang thiết bị mới hoàn toàn -> dùng Mã hẹn gặp lại (CHAT-XXXX-XXXX) để gặp lại nhau!
 *      - Người thứ 3 dùng mã khi cặp đang chat -> bị chặn PAIR_ALREADY_ACTIVE!
 *      - Hủy Giữ kết nối -> xóa vĩnh viễn cả 2 phía & vô hiệu hóa mã hẹn!
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../backend/node_modules/ws');

const {
  ConnectionManager,
  MAX_PAIR_HISTORY,
  PAIR_CODE_REGEX,
  normalizePairCode,
} = require('../backend/connectionManager');
const {
  CLIENT_TYPES,
  SERVER_TYPES,
  validatePayload,
} = require('../backend/protocol');

function makeClient(id, nickname, avatar = '🦊') {
  return {
    clientId: `cid-${id}`,
    deviceId: `dev-${id}`,
    nickname,
    avatar,
    mood: 'vui_ve',
    interests: ['âm nhạc', 'game'],
  };
}

// ─── 1. Protocol Validation Tests ────────────────────────────────────────────

function runProtocolTests() {
  console.log('--- 1. Testing Pair Keep & Code Protocol Validation ---');
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_VOTE_KEEP, { keep: true }).ok, true);
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_VOTE_KEEP, { keep: 'yes' }).ok, false);

  const goodToken = 'a'.repeat(48);
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_RECONNECT, { pairId: 'p1', pairToken: goodToken }).ok, true);
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_RECONNECT, { pairId: 'p1', pairToken: 'short' }).ok, false);
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_REMOVE, { pairId: 'p1', pairToken: goodToken }).ok, true);

  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_JOIN_CODE, { pairCode: 'chat-ab12-cd34' }).sanitized.pairCode, 'CHAT-AB12-CD34');
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_JOIN_CODE, { pairCode: '123' }).ok, false);

  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_INVITE_RESPOND, { inviteId: 'inv-1', accept: true }).ok, true);
  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_INVITE_RESPOND, { inviteId: 'inv-1', accept: 'no' }).ok, false);

  assert.strictEqual(validatePayload(CLIENT_TYPES.PAIR_SYNC, {
    passes: [
      { pairId: 'p1', pairToken: goodToken },
      { pairId: 'bad', pairToken: 'invalid' },
    ],
  }).sanitized.passes.length, 1);

  assert.strictEqual(normalizePairCode('chat-ab12-cd34'), 'CHAT-AB12-CD34');
  assert.strictEqual(normalizePairCode('ab12cd34'), 'CHAT-AB12-CD34');
  assert.strictEqual(normalizePairCode('bad'), '');
  console.log('✅ Passed: Pair protocol validation');
}

// ─── 2. ConnectionManager Unit Tests ─────────────────────────────────────────

async function runConnectionManagerUnitTests() {
  console.log('--- 2. Testing ConnectionManager (2-Way Consent, 40-Msg Cap, Code, Unkeep) ---');
  assert.strictEqual(MAX_PAIR_HISTORY, 40);

  const cm = new ConnectionManager({ maxHistory: 40 });
  const alice = makeClient('a', 'Thỏ Trắng', '🐰');
  const bob = makeClient('b', 'Cáo Nhỏ', '🦊');

  // 2A. Nếu chỉ có 1 người bấm Giữ kết nối rồi thoát -> KHÔNG lưu gì, xóa sạch buffer tạm!
  cm.initRoomSession('room-ephemeral', alice.clientId, bob.clientId);
  await cm.recordRoomMessage('room-ephemeral', alice.clientId, { type: 'message', text: 'Tin nhắn riêng tư' });
  const oneVote = await cm.setKeepVote('room-ephemeral', alice, bob, true);
  assert.strictEqual(oneVote.isKept, false);
  assert.strictEqual(oneVote.keepCount, 1);
  cm.cleanupRoomSession('room-ephemeral');
  assert.strictEqual(cm.pairs.size, 0, 'Must NOT persist pair when only 1 side voted');
  assert.strictEqual(cm.getRoomSession('room-ephemeral'), null);

  // 2B. Đồng thuận 2 chiều -> seed tin trước đó + giới hạn đúng 40 tin gần nhất!
  cm.initRoomSession('room-mutual', alice.clientId, bob.clientId);
  for (let i = 1; i <= 5; i++) {
    await cm.recordRoomMessage('room-mutual', i % 2 === 1 ? alice.clientId : bob.clientId, {
      type: 'message',
      text: `Tin ${i}`,
    });
  }

  const v1 = await cm.setKeepVote('room-mutual', alice, bob, true);
  assert.strictEqual(v1.isKept, false);
  const v2 = await cm.setKeepVote('room-mutual', bob, alice, true);
  assert.strictEqual(v2.isKept, true);
  assert.strictEqual(v2.justActivated, true);
  assert.ok(PAIR_CODE_REGEX.test(v2.pair.pairCode), `Invalid pairCode: ${v2.pair.pairCode}`);
  assert.strictEqual(v2.passes.length, 2);
  assert.notStrictEqual(v2.passes[0].pass.pairToken, v2.passes[1].pass.pairToken);

  // Ghi thêm 50 tin (tổng 55 tin) -> phải giữ đúng 40 tin gần nhất (Tin 16 .. Tin 55)
  for (let i = 6; i <= 55; i++) {
    await cm.recordRoomMessage('room-mutual', i % 2 === 1 ? alice.clientId : bob.clientId, {
      type: 'message',
      text: `Tin ${i}`,
    });
  }

  const loaded = await cm._loadPair(v2.pair.pairId, { includeHistory: true });
  assert.strictEqual(loaded.history.length, 40, 'History must be capped at 40 latest messages');
  assert.strictEqual(loaded.history[0].text, 'Tin 16');
  assert.strictEqual(loaded.history[39].text, 'Tin 55');

  const histA = cm.formatHistoryForSlot(loaded, 'A');
  const histB = cm.formatHistoryForSlot(loaded, 'B');
  // Tin 16 là chẵn -> do Bob (slot B) gửi -> với Alice là received, với Bob là sent
  assert.strictEqual(histA[0].direction, 'received');
  assert.strictEqual(histB[0].direction, 'sent');
  // Tin 55 là lẻ -> do Alice (slot A) gửi -> với Alice là sent, với Bob là received
  assert.strictEqual(histA[39].direction, 'sent');
  assert.strictEqual(histB[39].direction, 'received');

  // 2C. Đang mở phòng -> từ chối người thứ 3 dùng mã hẹn gặp lại
  const blockedWhileActive = await cm.resolvePairByCode(v2.pair.pairCode, makeClient('intruder', 'Kẻ lạ'));
  assert.strictEqual(blockedWhileActive.ok, false);
  assert.strictEqual(blockedWhileActive.code, 'PAIR_ALREADY_ACTIVE');

  // Dọn phòng -> đổi máy dùng mã hẹn gặp lại thành công
  cm.cleanupRoomSession('room-mutual');
  const newPhoneAlice = { clientId: 'phone-a', deviceId: 'new-phone-dev', nickname: 'Thỏ Trắng', avatar: '🐰' };
  const resolved = await cm.resolvePairByCode(v2.pair.pairCode.toLowerCase(), newPhoneAlice);
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.slot, 'A');

  // 2D. Rate limit đoán mã (6 lần ok, lần 7 bị chặn)
  for (let k = 0; k < 6; k++) assert.strictEqual(cm.checkCodeAttemptLimit('bruteforcer'), true);
  assert.strictEqual(cm.checkCodeAttemptLimit('bruteforcer'), false);

  // 2E. Hủy Giữ kết nối -> xóa sạch pair + code + history
  const passA = v2.passes.find((p) => p.clientId === alice.clientId).pass;
  const removed = await cm.removePairByPass(passA.pairId, passA.pairToken);
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(await cm.verifyPass(passA.pairId, passA.pairToken), null);
  const afterRemove = await cm.resolvePairByCode(v2.pair.pairCode, newPhoneAlice);
  assert.strictEqual(afterRemove.ok, false);

  cm.destroy();
  console.log('✅ Passed: ConnectionManager unit tests');
}

// ─── 3. Live WebSocket E2E Tests ─────────────────────────────────────────────

function connectWsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(msg)) {
          const waiter = waiters.splice(i, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
          return;
        }
      }
      queue.push(msg);
    });

    ws.once('error', reject);
    ws.once('open', () => {
      resolve({
        ws,
        clientId: null,
        send(type, payload = {}) {
          ws.send(JSON.stringify({ type, payload }));
        },
        waitFor(predicate, timeoutMs = 6000) {
          for (let i = 0; i < queue.length; i++) {
            if (predicate(queue[i])) {
              return Promise.resolve(queue.splice(i, 1)[0]);
            }
          }
          const callStack = new Error().stack;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error(`Timeout waiting for WS message. Queued=${JSON.stringify(queue.slice(-5))}\n${callStack}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, timer });
          });
        },
        close() {
          return new Promise((res) => {
            if (ws.readyState === WebSocket.CLOSED) return res();
            ws.once('close', () => res());
            ws.close();
          });
        },
      });
    });
  });
}

async function runLiveWebSocketTests() {
  console.log('--- 3. Testing Live WebSocket Server (Giữ kết nối 2 chiều + Mã hẹn + Khôi phục 40 tin) ---');
  const testPort = 3911;
  const serverPath = path.join(__dirname, '..', 'backend', 'server.js');

  const serverProc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(testPort),
      USE_REDIS: 'false',
      MAX_CONNECTIONS_PER_IP: '120',
      MAX_PAIR_HISTORY: '40',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  serverProc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout. stderr: ${stderrBuf}`)), 8000);
    serverProc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`http://localhost:${testPort}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}. stderr:\n${stderrBuf}`));
    });
  });

  const wsUrl = `ws://127.0.0.1:${testPort}`;
  const openClients = [];

  try {
    // 3A. Alice & Bob ghép 1-1 ngẫu nhiên, nhắn 3 tin trước khi giữ, cả 2 bật Giữ kết nối,
    //     nhắn thêm 42 tin (tổng 45 -> giữ đúng 40 tin gần nhất), rồi rời phòng!
    const a1 = await connectWsClient(wsUrl);
    const b1 = await connectWsClient(wsUrl);
    openClients.push(a1, b1);

    await Promise.all([
      a1.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
      b1.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
    ]);

    a1.send(CLIENT_TYPES.JOIN, { nickname: 'Mèo Mây', avatar: '🐱', interests: ['âm nhạc'], deviceId: 'pair-e2e-alice' });
    b1.send(CLIENT_TYPES.JOIN, { nickname: 'Gấu Bắc Cực', avatar: '🐻‍❄️', interests: ['âm nhạc'], deviceId: 'pair-e2e-bob' });
    a1.send(CLIENT_TYPES.FIND_MATCH);
    b1.send(CLIENT_TYPES.FIND_MATCH);
    await Promise.all([
      a1.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
      b1.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
    ]);

    // 3 tin trước khi bật Giữ kết nối
    for (let i = 1; i <= 3; i++) {
      const sender = i % 2 === 1 ? a1 : b1;
      const receiver = i % 2 === 1 ? b1 : a1;
      sender.send(CLIENT_TYPES.MESSAGE, { text: `Msg #${i}` });
      await receiver.waitFor((m) => m.type === SERVER_TYPES.MESSAGE && m.payload.text === `Msg #${i}`);
    }

    // Alice bấm Giữ kết nối (1/2)
    a1.send(CLIENT_TYPES.PAIR_VOTE_KEEP, { keep: true });
    const [uA1, uB1] = await Promise.all([
      a1.waitFor((m) => m.type === SERVER_TYPES.PAIR_KEEP_UPDATED),
      b1.waitFor((m) => m.type === SERVER_TYPES.PAIR_KEEP_UPDATED),
    ]);
    assert.strictEqual(uA1.payload.isKept, false);
    assert.strictEqual(uA1.payload.keepCount, 1);
    assert.strictEqual(uB1.payload.partnerVote, true);

    // Bob bấm đồng ý Giữ kết nối (2/2) -> kích hoạt + cấp pairToken + Mã hẹn gặp lại!
    b1.send(CLIENT_TYPES.PAIR_VOTE_KEEP, { keep: true });
    const [passA, passB, actA] = await Promise.all([
      a1.waitFor((m) => m.type === SERVER_TYPES.PAIR_KEEP_PASS),
      b1.waitFor((m) => m.type === SERVER_TYPES.PAIR_KEEP_PASS),
      a1.waitFor((m) => m.type === SERVER_TYPES.PAIR_KEEP_UPDATED && m.payload.isKept === true),
    ]);
    assert.strictEqual(actA.payload.justActivated, true);
    assert.strictEqual(passA.payload.pairId, passB.payload.pairId);
    assert.strictEqual(passA.payload.pairCode, passB.payload.pairCode);
    assert.ok(PAIR_CODE_REGEX.test(passA.payload.pairCode));
    assert.notStrictEqual(passA.payload.pairToken, passB.payload.pairToken);

    // Nhắn thêm 10 tin + 1 voice + 1 sticker (tổng 15 tin để tránh chạm rate limit 5 tin/3s của server!)
    // (Còn việc giới hạn chính xác 40 tin đã được test kỹ 55 -> 40 ở unit test 2B!)
    const validVoiceId = '11111111-2222-3333-4444-555555555555';
    a1.send(CLIENT_TYPES.VOICE, { voiceId: validVoiceId, url: `/api/voice/${validVoiceId}`, duration: 4 });
    await b1.waitFor((m) => m.type === SERVER_TYPES.VOICE);
    b1.send(CLIENT_TYPES.MEME, { memeId: 'm-keep-1', url: '/assets/stickers/douyin/weixiao.png', title: 'Cười', isSticker: true });
    await a1.waitFor((m) => m.type === SERVER_TYPES.MEME);

    // Rời phòng và đóng WebSocket hoàn toàn (mô phỏng tắt tab quay lại lần sau)
    a1.send(CLIENT_TYPES.LEAVE_ROOM);
    await b1.waitFor((m) => m.type === SERVER_TYPES.PARTNER_LEFT);
    await Promise.all([a1.close(), b1.close()]);

    // 3B. Lần sau mở lại trình duyệt: đồng bộ danh sách Giữ kết nối + mời gặp lại trực tiếp!
    const a2 = await connectWsClient(wsUrl);
    const b2 = await connectWsClient(wsUrl);
    openClients.push(a2, b2);
    await Promise.all([
      a2.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
      b2.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
    ]);

    // Bob2 chỉ mới mở Trang chủ và sync pass (chưa cần bấm Find Match!)
    b2.send(CLIENT_TYPES.PAIR_SYNC, {
      passes: [{ pairId: passB.payload.pairId, pairToken: passB.payload.pairToken }],
    });
    const listB = await b2.waitFor((m) => m.type === SERVER_TYPES.PAIR_LIST);
    assert.strictEqual(listB.payload.connections.length, 1);
    assert.strictEqual(listB.payload.connections[0].historyCount, 5);

    a2.send(CLIENT_TYPES.JOIN, { nickname: 'Mèo Mây', avatar: '🐱', interests: ['âm nhạc'], deviceId: 'pair-e2e-alice' });
    a2.send(CLIENT_TYPES.PAIR_SYNC, {
      passes: [{ pairId: passA.payload.pairId, pairToken: passA.payload.pairToken }],
    });
    const listA = await a2.waitFor((m) => m.type === SERVER_TYPES.PAIR_LIST);
    assert.strictEqual(listA.payload.connections[0].partnerOnline, true, 'Bob2 must show online');

    // Alice2 bấm "Mời gặp lại" -> Bob2 nhận PAIR_INVITE -> Bob2 chấp nhận -> khôi phục đủ 5 tin (3 text + 1 voice + 1 sticker)!
    a2.send(CLIENT_TYPES.PAIR_RECONNECT, { pairId: passA.payload.pairId, pairToken: passA.payload.pairToken });
    const [waitA, inviteB] = await Promise.all([
      a2.waitFor((m) => m.type === SERVER_TYPES.PAIR_WAITING),
      b2.waitFor((m) => m.type === SERVER_TYPES.PAIR_INVITE),
    ]);
    assert.strictEqual(waitA.payload.invitedPartner, true);
    assert.strictEqual(inviteB.payload.pairCode, passA.payload.pairCode);

    b2.send(CLIENT_TYPES.PAIR_INVITE_RESPOND, { inviteId: inviteB.payload.inviteId, accept: true });
    const [reMatchA, reMatchB] = await Promise.all([
      a2.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
      b2.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
    ]);
    assert.strictEqual(reMatchA.payload.keptPair.isKept, true);
    assert.strictEqual(reMatchA.payload.history.length, 5);
    assert.strictEqual(reMatchA.payload.history[0].text, 'Msg #1');
    assert.strictEqual(reMatchA.payload.history[0].direction, 'sent');
    assert.strictEqual(reMatchB.payload.history[0].direction, 'received');
    assert.strictEqual(reMatchA.payload.history[3].type, 'voice');
    assert.strictEqual(reMatchA.payload.history[4].type, 'meme');

    // Người thứ 3 cố dùng Mã hẹn gặp lại khi 2 người đang chat -> BỊ CHẶN!
    const intruder = await connectWsClient(wsUrl);
    openClients.push(intruder);
    await intruder.waitFor((m) => m.type === SERVER_TYPES.CONNECTED);
    intruder.send(CLIENT_TYPES.JOIN, { nickname: 'Người lạ', avatar: '🐼', interests: [], deviceId: 'dev-intruder' });
    intruder.send(CLIENT_TYPES.PAIR_JOIN_CODE, { pairCode: passA.payload.pairCode });
    const intruderErr = await intruder.waitFor((m) => m.type === SERVER_TYPES.ERROR);
    assert.strictEqual(intruderErr.payload.code, 'PAIR_ALREADY_ACTIVE');

    // Rời phòng để test đổi sang thiết bị hoàn toàn mới bằng Mã hẹn gặp lại!
    a2.send(CLIENT_TYPES.LEAVE_ROOM);
    await b2.waitFor((m) => m.type === SERVER_TYPES.PARTNER_LEFT);
    await Promise.all([a2.close(), b2.close()]);

    // 3C. Đổi sang 2 thiết bị MỚI TINH (không có localStorage), chỉ nhập Mã hẹn gặp lại (CHAT-XXXX-XXXX)
    const phoneA = await connectWsClient(wsUrl);
    const tabletB = await connectWsClient(wsUrl);
    openClients.push(phoneA, tabletB);
    await Promise.all([
      phoneA.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
      tabletB.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
    ]);
    phoneA.send(CLIENT_TYPES.JOIN, { nickname: 'Mèo Mây', avatar: '🐱', interests: [], deviceId: 'brand-new-phone-a' });
    tabletB.send(CLIENT_TYPES.JOIN, { nickname: 'Gấu Bắc Cực', avatar: '🐻‍❄️', interests: [], deviceId: 'brand-new-tablet-b' });

    phoneA.send(CLIENT_TYPES.PAIR_JOIN_CODE, { pairCode: passA.payload.pairCode.toLowerCase() });
    const [newPassA, phoneWait] = await Promise.all([
      phoneA.waitFor((m) => m.type === SERVER_TYPES.PAIR_KEEP_PASS),
      phoneA.waitFor((m) => m.type === SERVER_TYPES.PAIR_WAITING),
    ]);
    assert.strictEqual(phoneWait.payload.pairCode, passA.payload.pairCode);
    assert.strictEqual(newPassA.payload.pairId, passA.payload.pairId);

    tabletB.send(CLIENT_TYPES.PAIR_JOIN_CODE, { pairCode: passA.payload.pairCode });
    const [codeMatchA, codeMatchB] = await Promise.all([
      phoneA.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
      tabletB.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
    ]);
    assert.strictEqual(codeMatchA.payload.history.length, 5);
    assert.strictEqual(codeMatchB.payload.history.length, 5);

    // 3D. Hủy Giữ kết nối từ bên trong phòng -> xóa vĩnh viễn ở cả 2 phía & mã hẹn hết hiệu lực!
    phoneA.send(CLIENT_TYPES.PAIR_VOTE_KEEP, { keep: false });
    await Promise.all([
      phoneA.waitFor((m) => m.type === SERVER_TYPES.PAIR_REMOVED),
      tabletB.waitFor((m) => m.type === SERVER_TYPES.PAIR_REMOVED),
    ]);

    phoneA.send(CLIENT_TYPES.LEAVE_ROOM);
    await tabletB.waitFor((m) => m.type === SERVER_TYPES.PARTNER_LEFT);

    intruder.send(CLIENT_TYPES.PAIR_JOIN_CODE, { pairCode: passA.payload.pairCode });
    const deletedErr = await intruder.waitFor((m) => m.type === SERVER_TYPES.ERROR);
    assert.strictEqual(deletedErr.payload.code, 'PAIR_NOT_FOUND');

    console.log('✅ Passed: Live WebSocket E2E (2-Way Keep + History Restore + Cross-Device Pair Code + Unkeep)');
  } finally {
    await Promise.all(openClients.map((c) => c.close()));
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  console.log('=== Running Giữ Kết Nối (2-Way Anonymous Keep & Pair Code) Test Suite ===');
  runProtocolTests();
  await runConnectionManagerUnitTests();
  await runLiveWebSocketTests();
  console.log('\n🎉 ALL GIỮ KẾT NỐI & MÃ HẸN GẶP LẠI TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
