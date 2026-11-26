/**
 * groupChat.test.js – Kiểm thử toàn diện chức năng Trò chuyện nhóm ẩn danh
 *
 * Bao gồm:
 *   1. Kiểm thử protocol.js cho toàn bộ gói tin GROUP_*
 *   2. Kiểm thử GroupManager:
 *      - Ghép theo chủ đề / sở thích vs ngẫu nhiên
 *      - Giới hạn 60 thành viên / nhóm (người thứ 61 bị từ chối join trực tiếp và tự mở nhóm mới khi find)
 *      - Tự động biến mất khi tất cả rời đi nếu < 3 người giữ (0/3 và 2/3)
 *      - Giữ lại nhóm khi có >= 3 người đồng ý giữ, bảo lưu trạng thái dormant & quay lại trò chuyện tiếp
 *      - Bỏ giữ nhóm khiến số phiếu < 3 khi phòng trống -> tự xóa ngay lập tức
 *      - Kick thành viên vi phạm không làm hỏng nhóm của người khác & thu hồi phiếu giữ của kẻ vi phạm
 *   3. Kiểm thử tích hợp WebSocket trực tiếp (server thật) bao gồm bài test 60 kết nối đồng thời trong 1 nhóm
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../backend/node_modules/ws');

const {
  CLIENT_TYPES,
  SERVER_TYPES,
  parseMessage,
  validatePayload,
} = require('../backend/protocol');
const {
  GroupManager,
  DEFAULT_MAX_GROUP_MEMBERS,
  MIN_KEEP_VOTES,
} = require('../backend/groupManager');

function makeUser(idx, overrides = {}) {
  return {
    clientId: `client-${idx}`,
    deviceId: `device-${idx}`,
    nickname: `Member${idx}`,
    avatar: '🦊',
    interests: ['âm nhạc'],
    mood: 'vui_ve',
    ...overrides,
  };
}

async function runUnitTests() {
  console.log('--- 1. Testing Group Protocol Validation ---');

  assert.strictEqual(DEFAULT_MAX_GROUP_MEMBERS, 60, 'Default max group members must be 60');
  assert.strictEqual(MIN_KEEP_VOTES, 3, 'Minimum keep votes must be 3');

  const findTopic = validatePayload(CLIENT_TYPES.GROUP_FIND, {
    mode: 'topic',
    topic: '  Tâm sự đêm khuya  ',
    interests: ['Âm nhạc', 'Game', 'âm nhạc'],
    mood: 'tam_su',
  });
  assert.strictEqual(findTopic.ok, true);
  assert.strictEqual(findTopic.sanitized.mode, 'topic');
  assert.strictEqual(findTopic.sanitized.topic, 'Tâm sự đêm khuya');
  assert.deepStrictEqual(findTopic.sanitized.interests, ['âm nhạc', 'game']);

  const badVote = validatePayload(CLIENT_TYPES.GROUP_VOTE_KEEP, { keep: 'yes' });
  assert.strictEqual(badVote.ok, false);
  assert.strictEqual(validatePayload(CLIENT_TYPES.GROUP_VOTE_KEEP, { keep: true }).ok, true);

  const badRejoin = validatePayload(CLIENT_TYPES.GROUP_REJOIN, { groupId: 'g1', rejoinToken: 'short' });
  assert.strictEqual(badRejoin.ok, false);
  const goodToken = 'a'.repeat(48);
  assert.strictEqual(validatePayload(CLIENT_TYPES.GROUP_REJOIN, { groupId: 'g1', rejoinToken: goodToken }).ok, true);

  const parsedJoin = parseMessage(JSON.stringify({
    type: CLIENT_TYPES.JOIN,
    payload: { nickname: 'Thảo', avatar: '🐼', interests: ['lập trình'], deviceId: 'dev-1' },
  }));
  assert.strictEqual(parsedJoin.ok, true);
  const validatedJoin = validatePayload(CLIENT_TYPES.JOIN, parsedJoin.msg.payload);
  assert.strictEqual(validatedJoin.ok, true);
  assert.strictEqual(validatedJoin.sanitized.avatar, '🐼');

  console.log('✅ Group protocol validation passed');

  console.log('--- 2. Testing Topic/Interest vs Random Matching ---');
  const gm = new GroupManager({ maxMembers: 60, minKeepVotes: 3 });

  const u1 = makeUser(1, { interests: ['âm nhạc', 'phim ảnh'] });
  const u2 = makeUser(2, { interests: ['âm nhạc'] });
  const u3 = makeUser(3, { interests: ['lập trình'] });
  const u4 = makeUser(4, { interests: ['âm nhạc'] });

  const r1 = await gm.findOrCreateGroup(u1, { mode: 'topic', topic: 'Góc âm nhạc', interests: u1.interests });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.created, true);

  // u2 cùng sở thích âm nhạc -> ghép chung vào nhóm r1
  const r2 = await gm.findOrCreateGroup(u2, { mode: 'topic', interests: u2.interests });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.created, false);
  assert.strictEqual(r2.group.groupId, r1.group.groupId, 'User with matching interest must join same topic group');
  assert.strictEqual(r2.group.memberCount, 2);

  // u3 khác hoàn toàn sở thích/chủ đề -> tạo nhóm chủ đề riêng
  const r3 = await gm.findOrCreateGroup(u3, { mode: 'topic', topic: 'Học NodeJS', interests: u3.interests, mood: 'hoc_tap' });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.created, true);
  assert.notStrictEqual(r3.group.groupId, r1.group.groupId);

  // u4 chọn chế độ ngẫu nhiên -> không bị trộn vào nhóm chủ đề, tự tạo/vào nhóm ngẫu nhiên
  const r4 = await gm.findOrCreateGroup(u4, { mode: 'random' });
  assert.strictEqual(r4.ok, true);
  assert.strictEqual(r4.group.mode, 'random');
  assert.notStrictEqual(r4.group.groupId, r1.group.groupId);

  const u5 = makeUser(5);
  const r5 = await gm.findOrCreateGroup(u5, { mode: 'random' });
  assert.strictEqual(r5.group.groupId, r4.group.groupId, 'Second random user should join existing open random group');

  console.log('✅ Topic/Interest vs Random matching passed');

  console.log('--- 3. Testing Auto-Disappear when everyone leaves (< 3 keep votes) ---');
  // Nhóm r1 hiện có u1, u2. Cả 2 cùng chọn giữ (2/3 < 3) rồi rời đi -> phải tự biến mất!
  const v1 = await gm.setKeepVote(u1.clientId, true);
  const v2 = await gm.setKeepVote(u2.clientId, true);
  assert.strictEqual(v1.keepCount, 1);
  assert.strictEqual(v1.isKept, false);
  assert.strictEqual(v2.keepCount, 2);
  assert.strictEqual(v2.isKept, false);

  const u1Pass = v1.activeVoterPasses[0];
  assert.ok(u1Pass && u1Pass.rejoinToken);

  const leave1 = await gm.leaveGroup(u1.clientId);
  assert.strictEqual(leave1.destroyed, false, 'Group stays alive while u2 is still inside');
  assert.strictEqual(leave1.memberCount, 1);

  const leave2 = await gm.leaveGroup(u2.clientId);
  assert.strictEqual(leave2.destroyed, true, 'Group with only 2/3 keep votes MUST auto-disappear when last member leaves');
  assert.strictEqual(leave2.preserved, false);

  // Kiểm tra không thể vào lại nhóm đã biến mất
  const failedRejoin = await gm.rejoinKeptGroup(makeUser(99), r1.group.groupId, u1Pass.rejoinToken);
  assert.strictEqual(failedRejoin.ok, false);
  assert.strictEqual(failedRejoin.code, 'GROUP_NOT_FOUND');

  // syncSavedGroups phải báo hết hạn để client tự xóa
  const syncedAfterDestroy = await gm.syncSavedGroups([{ groupId: r1.group.groupId, rejoinToken: u1Pass.rejoinToken }]);
  assert.strictEqual(syncedAfterDestroy.groups.length, 0);
  assert.deepStrictEqual(syncedAfterDestroy.expiredGroupIds, [r1.group.groupId]);

  console.log('✅ Auto-disappear with < 3 keep votes passed');

  console.log('--- 4. Testing Keep Group (>= 3 keep votes), Dormant Persistence, Rejoin & Unkeep ---');
  const k1 = makeUser(101);
  const k2 = makeUser(102);
  const k3 = makeUser(103);

  const kg1 = await gm.createGroup(k1, { mode: 'topic', topic: 'CLB Sách', interests: ['sách'] });
  const groupId = kg1.group.groupId;
  await gm.joinGroupById(k2, groupId);
  await gm.joinGroupById(k3, groupId);

  const kv1 = await gm.setKeepVote(k1.clientId, true);
  const kv2 = await gm.setKeepVote(k2.clientId, true);
  const kv3 = await gm.setKeepVote(k3.clientId, true);

  assert.strictEqual(kv1.isKept, false);
  assert.strictEqual(kv2.isKept, false);
  assert.strictEqual(kv3.isKept, true, '3rd vote MUST activate kept status');
  assert.strictEqual(kv3.justActivated, true);
  assert.strictEqual(kv3.activeVoterPasses.length, 3, 'All 3 active voters must receive rejoin passes');

  const k1Token = kv3.activeVoterPasses.find((p) => p.clientId === k1.clientId).rejoinToken;
  const k2Token = kv3.activeVoterPasses.find((p) => p.clientId === k2.clientId).rejoinToken;

  // Lưu 1 tin nhắn trong nhóm đã giữ
  await gm.recordHistoryMessage(groupId, {
    id: 'm1',
    type: 'message',
    senderClientId: k1.clientId,
    senderNickname: k1.nickname,
    senderAvatar: k1.avatar,
    text: 'Hẹn tối mai đọc tiếp nhé mọi người!',
    timestamp: new Date().toISOString(),
  });

  // Tất cả 3 người rời nhóm -> nhóm KHÔNG biến mất mà chuyển sang ngủ đông (dormant)
  await gm.leaveGroup(k1.clientId);
  await gm.leaveGroup(k2.clientId);
  const lastLeave = await gm.leaveGroup(k3.clientId);
  assert.strictEqual(lastLeave.destroyed, false, 'Kept group (>=3 votes) must NOT be destroyed');
  assert.strictEqual(lastLeave.preserved, true);

  // Người lạ tìm nhóm chủ đề "CLB Sách" KHÔNG được nhét vào nhóm riêng tư đã ngủ đông
  const stranger = makeUser(199, { interests: ['sách'] });
  const strangerRes = await gm.findOrCreateGroup(stranger, { mode: 'topic', topic: 'CLB Sách', interests: ['sách'] });
  assert.notStrictEqual(strangerRes.group.groupId, groupId, 'Stranger must not hijack dormant kept group');
  await gm.leaveGroup(stranger.clientId);

  // k1 mở tab mới (clientId & deviceId mới) và quay lại nhóm bằng rejoinToken
  const k1Returning = makeUser(201, { nickname: 'Member101_Return' });
  const rejoinRes = await gm.rejoinKeptGroup(k1Returning, groupId, k1Token);
  assert.strictEqual(rejoinRes.ok, true);
  assert.strictEqual(rejoinRes.group.groupId, groupId);
  assert.strictEqual(rejoinRes.group.isKept, true);
  assert.strictEqual(rejoinRes.group.keepCount, 3, 'Rejoining must NOT duplicate keep vote count');
  assert.strictEqual(rejoinRes.group.history.length, 1);
  assert.strictEqual(rejoinRes.group.history[0].text, 'Hẹn tối mai đọc tiếp nhé mọi người!');

  // k1 rời nhóm lại -> vẫn được giữ vì còn đủ 3 phiếu
  const leaveAgain = await gm.leaveGroup(k1Returning.clientId);
  assert.strictEqual(leaveAgain.preserved, true);
  assert.strictEqual(leaveAgain.destroyed, false);

  // k2 bỏ giữ nhóm khi phòng trống -> số phiếu giảm còn 2 (< 3) -> tự động xóa ngay lập tức!
  const unkeepRes = await gm.unkeepSavedGroup(groupId, k2Token);
  assert.strictEqual(unkeepRes.ok, true);
  assert.strictEqual(unkeepRes.keepCount, 2);
  assert.strictEqual(unkeepRes.destroyed, true, 'Dormant group dropping below 3 keep votes must immediately self-destruct');

  console.log('✅ Keep group (>=3), dormant persistence, rejoin & unkeep passed');

  console.log('--- 5. Testing 60-Member Capacity Limit & Overflow ---');
  const capManager = new GroupManager({ maxMembers: 60, minKeepVotes: 3 });
  const firstJoin = await capManager.createGroup(makeUser(1), { mode: 'random' });
  const fullGroupId = firstJoin.group.groupId;

  for (let i = 2; i <= 60; i++) {
    const res = await capManager.joinGroupById(makeUser(i), fullGroupId);
    assert.strictEqual(res.ok, true, `Member #${i} must be allowed to join`);
    assert.strictEqual(res.group.memberCount, i);
  }

  // Người thứ 61 join trực tiếp vào nhóm đầy -> bị từ chối với mã GROUP_FULL
  const member61 = makeUser(61);
  const fullReject = await capManager.joinGroupById(member61, fullGroupId);
  assert.strictEqual(fullReject.ok, false);
  assert.strictEqual(fullReject.code, 'GROUP_FULL');

  // Người thứ 61 tìm nhóm ngẫu nhiên -> tự động mở nhóm mới
  const overflowGroup = await capManager.findOrCreateGroup(member61, { mode: 'random' });
  assert.strictEqual(overflowGroup.ok, true);
  assert.strictEqual(overflowGroup.created, true);
  assert.notStrictEqual(overflowGroup.group.groupId, fullGroupId);

  // Test kick 1 thành viên vi phạm -> 59 người còn lại không bị ảnh hưởng và kẻ vi phạm không vào lại được
  await capManager.setKeepVote('client-5', true);
  const kickRes = await capManager.leaveGroup('client-5', { kicked: true, reason: 'vi phạm' });
  assert.strictEqual(kickRes.memberCount, 59);
  assert.strictEqual(kickRes.keepCount, 0, 'Kicked abuser must lose their keep vote');
  const kickedRejoin = await capManager.joinGroupById(makeUser(5), fullGroupId);
  assert.strictEqual(kickedRejoin.ok, false);
  assert.strictEqual(kickedRejoin.code, 'GROUP_KICKED');

  console.log('✅ 60-member capacity limit, overflow & kick isolation passed');
}

// ─── End-to-End Live WebSocket Server Integration Test (bao gồm 60 kết nối) ──

function connectWsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (waiters.length > 0) {
        for (let i = 0; i < waiters.length; i++) {
          if (waiters[i].predicate(msg)) {
            const waiter = waiters.splice(i, 1)[0];
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
            return;
          }
        }
      }
      queue.push(msg);
    });

    ws.once('error', reject);
    ws.once('open', () => {
      const helper = {
        ws,
        send(type, payload = {}) {
          ws.send(JSON.stringify({ type, payload }));
        },
        waitFor(predicate, timeoutMs = 6000) {
          for (let i = 0; i < queue.length; i++) {
            if (predicate(queue[i])) {
              return Promise.resolve(queue.splice(i, 1)[0]);
            }
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error('Timed out waiting for WebSocket message'));
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
      };
      resolve(helper);
    });
  });
}

async function runLiveWebSocketTests() {
  console.log('--- 6. Testing Live WebSocket Server (Group Chat + 60 Members Fan-Out) ---');
  const testPort = 3909;
  const serverPath = path.join(__dirname, '..', 'backend', 'server.js');

  const serverProc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(testPort),
      USE_REDIS: 'false',
      MAX_CONNECTIONS_PER_IP: '120',
      MAX_GROUP_MEMBERS: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  serverProc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

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
    // 6A. 3 clients vào chung nhóm theo chủ đề, nhắn tin, giữ nhóm (3/3), rời hết rồi quay lại!
    const c1 = await connectWsClient(wsUrl);
    const c2 = await connectWsClient(wsUrl);
    const c3 = await connectWsClient(wsUrl);
    openClients.push(c1, c2, c3);

    await Promise.all([
      c1.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
      c2.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
      c3.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
    ]);

    c1.send(CLIENT_TYPES.JOIN, { nickname: 'An', avatar: '🦊', interests: ['công nghệ'], deviceId: 'e2e-dev-1' });
    c2.send(CLIENT_TYPES.JOIN, { nickname: 'Bình', avatar: '🐼', interests: ['công nghệ'], deviceId: 'e2e-dev-2' });
    c3.send(CLIENT_TYPES.JOIN, { nickname: 'Chi', avatar: '🐱', interests: ['công nghệ'], deviceId: 'e2e-dev-3' });

    c1.send(CLIENT_TYPES.GROUP_FIND, { mode: 'topic', topic: 'Lập trình WebSocket', interests: ['công nghệ'] });
    const j1 = await c1.waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    const keptGroupId = j1.payload.groupId;

    c2.send(CLIENT_TYPES.GROUP_FIND, { mode: 'topic', topic: 'lap trinh websocket', interests: ['công nghệ'] });
    const j2 = await c2.waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    assert.strictEqual(j2.payload.groupId, keptGroupId, 'Tone-insensitive topic match must land in same group');

    c3.send(CLIENT_TYPES.GROUP_FIND, { mode: 'topic', interests: ['công nghệ'] });
    const j3 = await c3.waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    assert.strictEqual(j3.payload.groupId, keptGroupId);
    assert.strictEqual(j3.payload.memberCount, 3);

    // 3 người cùng chọn giữ nhóm
    c1.send(CLIENT_TYPES.GROUP_VOTE_KEEP, { keep: true });
    const p1 = await c1.waitFor((m) => m.type === SERVER_TYPES.GROUP_KEEP_PASS);
    c2.send(CLIENT_TYPES.GROUP_VOTE_KEEP, { keep: true });
    await c2.waitFor((m) => m.type === SERVER_TYPES.GROUP_KEEP_PASS);
    c3.send(CLIENT_TYPES.GROUP_VOTE_KEEP, { keep: true });
    const activated = await c1.waitFor((m) => m.type === SERVER_TYPES.GROUP_KEEP_UPDATED && m.payload.isKept === true);
    assert.strictEqual(activated.payload.keepCount, 3);

    // Gửi 1 tin nhắn trong nhóm đã giữ
    c1.send(CLIENT_TYPES.MESSAGE, { text: 'Xin chào cả nhóm WebSocket!' });
    const [recv2, recv3] = await Promise.all([
      c2.waitFor((m) => m.type === SERVER_TYPES.GROUP_MESSAGE),
      c3.waitFor((m) => m.type === SERVER_TYPES.GROUP_MESSAGE),
    ]);
    assert.strictEqual(recv2.payload.text, 'Xin chào cả nhóm WebSocket!');
    assert.strictEqual(recv2.payload.senderNickname, 'An');
    assert.strictEqual(recv3.payload.senderAvatar, '🦊');

    // Cả 3 người rời nhóm -> nhóm vẫn được bảo lưu!
    c1.send(CLIENT_TYPES.GROUP_LEAVE);
    await c1.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT);
    c2.send(CLIENT_TYPES.GROUP_LEAVE);
    await c2.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT);
    c3.send(CLIENT_TYPES.GROUP_LEAVE);
    const l3 = await c3.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT);
    assert.strictEqual(l3.payload.preserved, true);
    assert.strictEqual(l3.payload.destroyed, false);

    // c1 quay lại nhóm bằng rejoinToken và vẫn thấy tin nhắn gần nhất
    c1.send(CLIENT_TYPES.GROUP_REJOIN, { groupId: keptGroupId, rejoinToken: p1.payload.rejoinToken });
    const rejoined = await c1.waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    assert.strictEqual(rejoined.payload.groupId, keptGroupId);
    assert.strictEqual(rejoined.payload.history.length, 1);
    assert.strictEqual(rejoined.payload.history[0].text, 'Xin chào cả nhóm WebSocket!');

    c1.send(CLIENT_TYPES.GROUP_LEAVE);
    await c1.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT);

    // 6B. Stress test 60 kết nối WebSocket đồng thời vào ĐÚNG 1 nhóm!
    const swarm = [];
    for (let i = 0; i < 61; i++) {
      const cli = await connectWsClient(wsUrl);
      openClients.push(cli);
      swarm.push(cli);
    }
    await Promise.all(swarm.map((cli) => cli.waitFor((m) => m.type === SERVER_TYPES.CONNECTED)));

    swarm[0].send(CLIENT_TYPES.JOIN, { nickname: 'Swarm0', avatar: '🚀', deviceId: 'swarm-dev-0' });
    swarm[0].send(CLIENT_TYPES.GROUP_CREATE, { mode: 'random', name: 'Nhóm Kiểm Thử 60 Người' });
    const created60 = await swarm[0].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    const stressGroupId = created60.payload.groupId;

    // 59 người tiếp theo join vào cùng nhóm -> đủ 60/60
    const joinPromises = [];
    for (let i = 1; i < 60; i++) {
      swarm[i].send(CLIENT_TYPES.JOIN, { nickname: `Swarm${i}`, avatar: '🌟', deviceId: `swarm-dev-${i}` });
      swarm[i].send(CLIENT_TYPES.GROUP_JOIN, { groupId: stressGroupId });
      joinPromises.push(swarm[i].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED));
    }
    const joinedAll = await Promise.all(joinPromises);
    assert.strictEqual(joinedAll.length, 59);

    // Người thứ 61 bị từ chối vì đầy 60/60
    swarm[60].send(CLIENT_TYPES.JOIN, { nickname: 'Swarm60', avatar: '🐱', deviceId: 'swarm-dev-60' });
    swarm[60].send(CLIENT_TYPES.GROUP_JOIN, { groupId: stressGroupId });
    const fullErr = await swarm[60].waitFor((m) => m.type === SERVER_TYPES.ERROR);
    assert.strictEqual(fullErr.payload.code, 'GROUP_FULL');

    // Đo độ trễ broadcast 1 tin nhắn tới toàn bộ 59 thành viên còn lại trong nhóm 60 người
    const sendStart = Date.now();
    swarm[0].send(CLIENT_TYPES.MESSAGE, { text: 'Hello 60 members!' });
    const fanoutMsgs = await Promise.all(
      swarm.slice(1, 60).map((cli) => cli.waitFor((m) => m.type === SERVER_TYPES.GROUP_MESSAGE && m.payload.text === 'Hello 60 members!'))
    );
    const fanoutMs = Date.now() - sendStart;
    assert.strictEqual(fanoutMsgs.length, 59, 'All 59 other members must receive the broadcast message');
    console.log(`✅ Live 60-member WebSocket group broadcast passed (59 recipients delivered in ${fanoutMs}ms)`);

    // Tất cả 60 người rời đi (không có phiếu giữ) -> nhóm tự hủy
    for (let i = 0; i < 60; i++) {
      swarm[i].send(CLIENT_TYPES.GROUP_LEAVE);
    }
    const leftConfirmations = await Promise.all(
      swarm.slice(0, 60).map((cli) => cli.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT))
    );
    assert.ok(
      leftConfirmations.some((m) => m.payload.destroyed === true),
      'When all 60 members leave with 0 keep votes, the final leave MUST report destroyed=true'
    );
    console.log('✅ Live 60-member auto-disappear passed');
  } finally {
    await Promise.allSettled(openClients.map((c) => c.close()));
    serverProc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

(async () => {
  await runUnitTests();
  await runLiveWebSocketTests();
  console.log('\n🎉 ALL GROUP CHAT UNIT & LIVE 60-MEMBER TESTS PASSED! 🎉\n');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
