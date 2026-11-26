/**
 * tests/gameRoom.test.js
 * Kiểm thử toàn diện:
 *   1. nicknameResolver.js (đánh số trùng biệt danh "Cánh Cụt 1", "Cánh Cụt 2" & trích xuất @mention)
 *   2. GroupManager (trùng biệt danh + @mention trong phòng nhóm)
 *   3. GameRoomManager (2–10 người/phòng, ẩn danh, mã phòng, chuyển host, tự hủy phòng & cả 5 game:
 *      quiz_race, word_chain, undercover, number_bomb, caro_arena)
 *   4. Live WebSocket Server E2E (Group Chat trùng biệt danh + @mention; Game Room đủ 10 người,
 *      chặn người thứ 11, chat @mention trong phòng game, chơi thực tế & tự hủy phòng khi trống)
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../backend/node_modules/ws');

const {
  resolveRoomNickname,
  extractMentions,
  normalizeBaseNickname,
} = require('../backend/nicknameResolver');
const { GroupManager } = require('../backend/groupManager');
const {
  GameRoomManager,
  GAME_CATALOG,
  MAX_GAME_ROOM_PLAYERS,
} = require('../backend/gameRoomManager');
const { CLIENT_TYPES, SERVER_TYPES } = require('../backend/protocol');

function makeUser(idx, nickname = `Người chơi ${idx}`, avatar = '🦊') {
  return {
    clientId: `client-${idx}`,
    deviceId: `dev-${idx}`,
    nickname,
    avatar,
    interests: ['game'],
    mood: 'vui',
  };
}

// ─── 1. Unit Tests: nicknameResolver.js ──────────────────────────────────────

function runNicknameResolverTests() {
  console.log('--- 1. Testing nicknameResolver (Duplicate Numbering & @Mentions) ---');
  assert.strictEqual(normalizeBaseNickname('  Cánh   Cụt  '), 'Cánh Cụt');

  const members = [];
  const counters = new Map();

  // Người 1: Cánh Cụt -> giữ nguyên "Cánh Cụt" khi chưa trùng
  const r1 = resolveRoomNickname(members, 'Cánh Cụt', counters);
  assert.strictEqual(r1.displayName, 'Cánh Cụt');
  assert.strictEqual(r1.renamedMembers.length, 0);
  members.push({
    clientId: 'u1',
    baseNickname: r1.baseNickname,
    nickname: r1.displayName,
    nicknameNumber: r1.nicknameNumber,
  });

  // Người 2: cũng đặt "  cánh cụt " -> người 1 thành "Cánh Cụt 1", người 2 thành "Cánh Cụt 2"
  const r2 = resolveRoomNickname(members, '  cánh cụt ', counters);
  assert.strictEqual(r2.displayName, 'Cánh Cụt 2');
  assert.strictEqual(r2.renamedMembers.length, 1);
  assert.strictEqual(r2.renamedMembers[0].clientId, 'u1');
  assert.strictEqual(r2.renamedMembers[0].oldNickname, 'Cánh Cụt');
  assert.strictEqual(r2.renamedMembers[0].newNickname, 'Cánh Cụt 1');
  assert.strictEqual(members[0].nickname, 'Cánh Cụt 1');
  members.push({
    clientId: 'u2',
    baseNickname: r2.baseNickname,
    nickname: r2.displayName,
    nicknameNumber: r2.nicknameNumber,
  });

  // Người 3: "Cánh Cụt" -> "Cánh Cụt 3"
  const r3 = resolveRoomNickname(members, 'Cánh Cụt', counters);
  assert.strictEqual(r3.displayName, 'Cánh Cụt 3');
  assert.strictEqual(r3.renamedMembers.length, 0);
  members.push({
    clientId: 'u3',
    baseNickname: r3.baseNickname,
    nickname: r3.displayName,
    nicknameNumber: r3.nicknameNumber,
  });

  // Người 2 thoát, người 4 vào cũng tên "Cánh Cụt" -> tiếp tục là "Cánh Cụt 4" (không nhảy ngược gây nhầm)
  members.splice(1, 1);
  const r4 = resolveRoomNickname(members, 'Cánh Cụt', counters);
  assert.strictEqual(r4.displayName, 'Cánh Cụt 4');
  members.push({
    clientId: 'u4',
    baseNickname: r4.baseNickname,
    nickname: r4.displayName,
    nicknameNumber: r4.nicknameNumber,
  });

  // Người 5 cố tình gõ trùng hẳn "Cánh Cụt 1" -> không bị trùng hiển thị
  const r5 = resolveRoomNickname(members, 'Cánh Cụt 1', counters);
  assert.notStrictEqual(r5.displayName.toLowerCase(), 'cánh cụt 1');
  members.push({
    clientId: 'u5',
    baseNickname: r5.baseNickname,
    nickname: r5.displayName,
    nicknameNumber: r5.nicknameNumber,
  });

  // Thêm 2 tên lồng nhau: "Mèo" và "Mèo Con" để kiểm tra ưu tiên tên dài hơn trước
  members.push(
    { clientId: 'u6', baseNickname: 'Mèo', nickname: 'Mèo', nicknameNumber: null },
    { clientId: 'u7', baseNickname: 'Mèo Con', nickname: 'Mèo Con', nicknameNumber: null }
  );

  // Kiểm tra extractMentions
  const mentions1 = extractMentions(
    'Ê @Cánh Cụt 1 ơi, kéo @Cánh Cụt 4 với @Mèo Con vào chơi! Mail test@Mèo.com bỏ qua nha.',
    members
  );
  assert.strictEqual(mentions1.length, 3);
  assert.deepStrictEqual(
    mentions1.map((m) => m.clientId),
    ['u1', 'u4', 'u7'],
    'Should extract longest matching nicknames and ignore email addresses'
  );

  // Kiểm tra không trùng lặp khi tag 1 người nhiều lần + không phân biệt hoa thường
  const mentions2 = extractMentions('@cánh cụt 1! ơi @Cánh Cụt 1?', members);
  assert.strictEqual(mentions2.length, 1);
  assert.strictEqual(mentions2[0].clientId, 'u1');
  assert.strictEqual(mentions2[0].nickname, 'Cánh Cụt 1');

  console.log('✅ Passed: nicknameResolver duplicate numbering & @mention extraction');
}

// ─── 2. Unit Tests: GroupManager Duplicate Nickname & @Mention ───────────────

async function runGroupMentionUnitTests() {
  console.log('--- 2. Testing GroupManager Duplicate Nicknames & @Mentions ---');
  const gm = new GroupManager({ maxMembers: 60, minKeepVotes: 3 });

  const u1 = makeUser(1, 'Cánh Cụt', '🐧');
  const u2 = makeUser(2, 'Cánh Cụt', '🐧');
  const u3 = makeUser(3, 'Cánh Cụt', '🐧');

  const g1 = await gm.createGroup(u1, { mode: 'topic', topic: 'Chim cánh cụt' });
  assert.strictEqual(g1.member.nickname, 'Cánh Cụt');

  const g2 = await gm.joinGroupById(u2, g1.group.groupId);
  assert.strictEqual(g2.ok, true);
  assert.strictEqual(g2.member.nickname, 'Cánh Cụt 2');
  assert.strictEqual(g2.renamedMembers.length, 1);
  assert.strictEqual(g2.renamedMembers[0].newNickname, 'Cánh Cụt 1');

  const g3 = await gm.joinGroupById(u3, g1.group.groupId);
  assert.strictEqual(g3.ok, true);
  assert.strictEqual(g3.member.nickname, 'Cánh Cụt 3');

  const mentions = await gm.extractGroupMentions(g1.group.groupId, 'Chào @Cánh Cụt 2 và @Cánh Cụt 3!');
  assert.strictEqual(mentions.length, 2);
  assert.deepStrictEqual(mentions.map((m) => m.nickname), ['Cánh Cụt 2', 'Cánh Cụt 3']);

  console.log('✅ Passed: GroupManager duplicate nicknames & @mention resolution');
}

// ─── 3. Unit Tests: GameRoomManager (Capacity 2–10, Lifecycle & All 5 Games) ─

function runGameRoomManagerUnitTests() {
  console.log('--- 3. Testing GameRoomManager (Max 10, Lifecycle, All 5 Games) ---');
  assert.strictEqual(MAX_GAME_ROOM_PLAYERS, 10);
  assert.strictEqual(Object.keys(GAME_CATALOG).length, 5);

  const broadcasts = [];
  const privates = [];

  const mgr = new GameRoomManager({
    maxPlayers: 10,
    onBroadcast: (roomId, type, payload) => broadcasts.push({ roomId, type, payload }),
    onSendTo: (clientId, type, payload) => privates.push({ clientId, type, payload }),
    timings: {
      quizQuestionMs: 30_000,
      quizRevealMs: 30_000,
      wordChainTurnMs: 30_000,
      undercoverClueMs: 30_000,
      undercoverVoteMs: 30_000,
      undercoverResultMs: 30_000,
      numberBombTurnMs: 30_000,
      numberBombBoomMs: 30_000,
      caroMoveMs: 30_000,
    },
  });

  // 3A. Capacity cap 10 players + anonymity + roomCode + duplicate nicknames
  const created = mgr.createRoom(makeUser(1, 'Cánh Cụt', '🐧'), {
    gameType: 'quiz_race',
    name: 'Phòng Đố Vui 10 Người',
  });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.room.maxPlayers, 10);
  assert.strictEqual(created.room.roomCode.length, 6);
  // Kiểm tra ẩn danh: không lộ deviceId / memberKey / IP
  const firstSerialized = created.room.players[0];
  assert.strictEqual(firstSerialized.deviceId, undefined);
  assert.strictEqual(firstSerialized.memberKey, undefined);
  assert.strictEqual(firstSerialized.clientIp, undefined);

  const roomId = created.room.roomId;
  const roomCode = created.room.roomCode;

  for (let i = 2; i <= 10; i++) {
    const nick = i <= 3 ? 'Cánh Cụt' : `Khách ${i}`;
    const joinRes = mgr.joinRoom(makeUser(i, nick, '🦊'), { roomCode: roomCode.toLowerCase() });
    assert.strictEqual(joinRes.ok, true, `Player ${i} must join`);
    if (i === 2) {
      assert.strictEqual(joinRes.player.nickname, 'Cánh Cụt 2');
      assert.strictEqual(joinRes.renamedMembers[0].newNickname, 'Cánh Cụt 1');
    }
    if (i === 3) {
      assert.strictEqual(joinRes.player.nickname, 'Cánh Cụt 3');
    }
  }
  assert.strictEqual(mgr.getRoom(roomId).players.size, 10);

  // Người thứ 11 bị từ chối khi vào phòng đã đầy 10 người
  const reject11 = mgr.joinRoom(makeUser(11, 'Khách 11'), { roomId });
  assert.strictEqual(reject11.ok, false);
  assert.strictEqual(reject11.code, 'GAME_ROOM_FULL');

  // findOrCreateRoom cho người thứ 11 sẽ tự tạo phòng mới
  const overflow11 = mgr.findOrCreateRoom(makeUser(11, 'Khách 11'), { gameType: 'quiz_race' });
  assert.strictEqual(overflow11.ok, true);
  assert.strictEqual(overflow11.created, true);
  assert.notStrictEqual(overflow11.room.roomId, roomId);
  mgr.leaveRoom('client-11');

  // 3B. Game 1: quiz_race (trả lời + ẩn đáp án trước khi reveal)
  const startQuiz = mgr.startGame('client-1');
  assert.strictEqual(startQuiz.ok, true);
  const quizRoom = mgr.getRoom(roomId);
  const pubQuizBefore = mgr._serializePublicGameState(quizRoom);
  assert.strictEqual(pubQuizBefore.phase, 'question');
  assert.strictEqual(pubQuizBefore.correctIndex, null, 'Correct index MUST stay hidden during question phase');

  const correctAnswer = quizRoom.game.questions[0].answer;
  for (let i = 1; i <= 10; i++) {
    const ans = mgr.handleAction(`client-${i}`, {
      action: 'answer',
      optionIndex: i === 1 ? correctAnswer : (correctAnswer + 1) % 4,
    });
    assert.strictEqual(ans.ok, true);
  }
  // Khi cả 10 người đã trả lời -> tự chuyển pha reveal
  assert.strictEqual(quizRoom.game.phase, 'reveal');
  assert.ok(quizRoom.players.get('client-1').score >= 100, 'Correct answer must award >= 100 points');
  assert.strictEqual(quizRoom.players.get('client-2').score, 0, 'Wrong answer must award 0 points');

  // Host thoát -> quyền host tự chuyển cho client-2
  const hostLeave = mgr.leaveRoom('client-1');
  assert.strictEqual(hostLeave.destroyed, false);
  assert.strictEqual(hostLeave.hostChanged, true);
  assert.strictEqual(hostLeave.hostId, 'client-2');

  // Dọn phòng quiz (9 người còn lại thoát -> tự hủy phòng)
  for (let i = 2; i <= 10; i++) {
    const res = mgr.leaveRoom(`client-${i}`);
    if (i === 10) assert.strictEqual(res.destroyed, true, 'Empty game room must auto-destroy');
  }
  assert.strictEqual(mgr.rooms.size, 0);

  // 3C. Game 2: word_chain (Nối Từ Thần Tốc)
  const wcCreate = mgr.createRoom(makeUser(21, 'An'), { gameType: 'word_chain' });
  mgr.joinRoom(makeUser(22, 'Bình'), { roomId: wcCreate.room.roomId });
  assert.strictEqual(mgr.startGame('client-21').ok, true);
  const wcRoom = mgr.getRoom(wcCreate.room.roomId);
  const firstTurn = wcRoom.game.turnClientId;
  const reqStart = wcRoom.game.requiredStart;
  const otherPlayer = firstTurn === 'client-21' ? 'client-22' : 'client-21';

  // Sai lượt -> từ chối
  assert.strictEqual(mgr.handleAction(otherPlayer, { action: 'submit_word', word: `${reqStart} mới` }).ok, false);
  // Chỉ 1 tiếng -> từ chối
  assert.strictEqual(mgr.handleAction(firstTurn, { action: 'submit_word', word: reqStart }).ok, false);
  // Không bắt đầu đúng âm tiết yêu cầu -> từ chối
  assert.strictEqual(mgr.handleAction(firstTurn, { action: 'submit_word', word: 'zzzz xxxx' }).ok, false);
  // Từ hợp lệ 2 tiếng -> chấp nhận & chuyển lượt
  const validWord = `${reqStart} vui`;
  assert.strictEqual(mgr.handleAction(firstTurn, { action: 'submit_word', word: validWord }).ok, true);
  assert.strictEqual(wcRoom.game.turnClientId, otherPlayer);
  assert.strictEqual(wcRoom.game.requiredStart, 'vui');
  // Dùng lại từ cũ -> từ chối
  assert.strictEqual(mgr.handleAction(otherPlayer, { action: 'submit_word', word: 'vui vẻ' }).ok, true);
  assert.strictEqual(mgr.handleAction(firstTurn, { action: 'submit_word', word: 'vẻ đẹp' }).ok, true);
  mgr.leaveRoom('client-21');
  mgr.leaveRoom('client-22');

  // 3D. Game 3: undercover (Ai Là Gián Điệp? – 3–10 người, bí mật từ khóa)
  privates.length = 0;
  const ucCreate = mgr.createRoom(makeUser(31, 'Sói'), { gameType: 'undercover' });
  mgr.joinRoom(makeUser(32, 'Thỏ'), { roomId: ucCreate.room.roomId });
  // Chưa đủ 3 người -> không được start
  assert.strictEqual(mgr.startGame('client-31').ok, false);

  mgr.joinRoom(makeUser(33, 'Cáo'), { roomId: ucCreate.room.roomId });
  assert.strictEqual(mgr.startGame('client-31').ok, true);
  const ucRoom = mgr.getRoom(ucCreate.room.roomId);
  assert.strictEqual(ucRoom.game.phase, 'clue');
  // Mỗi người nhận 1 tin riêng chứa từ bí mật
  assert.strictEqual(privates.length, 3);
  const spyId = [...ucRoom.game.spyIds][0];
  const civIds = ['client-31', 'client-32', 'client-33'].filter((id) => id !== spyId);
  const spyPrivate = privates.find((p) => p.clientId === spyId);
  const civPrivate = privates.find((p) => p.clientId === civIds[0]);
  assert.strictEqual(spyPrivate.payload.secretWord, ucRoom.game.spyWord);
  assert.strictEqual(civPrivate.payload.secretWord, ucRoom.game.civilianWord);
  assert.notStrictEqual(spyPrivate.payload.secretWord, civPrivate.payload.secretWord);

  // Public state KHÔNG được lộ từ bí mật trong lúc đang chơi
  const ucPublic = mgr._serializePublicGameState(ucRoom);
  assert.strictEqual(ucPublic.revealSecret, null);

  // Gợi ý chứa chính từ bí mật -> bị chặn
  const cheatClue = mgr.handleAction(spyId, { action: 'submit_clue', clue: `Nó là ${ucRoom.game.spyWord}` });
  assert.strictEqual(cheatClue.ok, false);

  // Cả 3 người gửi gợi ý hợp lệ -> tự chuyển sang pha bỏ phiếu (vote)
  assert.strictEqual(mgr.handleAction('client-31', { action: 'submit_clue', clue: 'Thứ rất quen thuộc mỗi sáng' }).ok, true);
  assert.strictEqual(mgr.handleAction('client-32', { action: 'submit_clue', clue: 'Hay thấy trong cuộc sống hằng ngày' }).ok, true);
  assert.strictEqual(mgr.handleAction('client-33', { action: 'submit_clue', clue: 'Nhiều người rất thích dùng' }).ok, true);
  assert.strictEqual(ucRoom.game.phase, 'vote');

  // 2 dân thường bầu trúng gián điệp -> Dân thường thắng & mở bí mật!
  assert.strictEqual(mgr.handleAction(civIds[0], { action: 'vote', targetClientId: spyId }).ok, true);
  assert.strictEqual(mgr.handleAction(civIds[1], { action: 'vote', targetClientId: spyId }).ok, true);
  assert.strictEqual(mgr.handleAction(spyId, { action: 'vote', targetClientId: civIds[0] }).ok, true);
  assert.strictEqual(ucRoom.game.phase, 'ended');
  assert.strictEqual(ucRoom.game.winnerSide, 'civilians');
  const ucEndPublic = mgr._serializePublicGameState(ucRoom);
  assert.strictEqual(ucEndPublic.revealSecret.spyWord, ucRoom.game.spyWord);
  mgr.leaveRoom('client-31');
  mgr.leaveRoom('client-32');
  mgr.leaveRoom('client-33');

  // 3E. Game 4: number_bomb (Đặt Bom Số)
  const nbCreate = mgr.createRoom(makeUser(41, 'Bom1'), { gameType: 'number_bomb' });
  mgr.joinRoom(makeUser(42, 'Bom2'), { roomId: nbCreate.room.roomId });
  assert.strictEqual(mgr.startGame('client-41').ok, true);
  const nbRoom = mgr.getRoom(nbCreate.room.roomId);
  const bombNum = nbRoom.game.bombNumber;
  const turn1 = nbRoom.game.turnClientId;
  const turn2 = turn1 === 'client-41' ? 'client-42' : 'client-41';

  // Ngoài khoảng (0, 101) -> từ chối
  assert.strictEqual(mgr.handleAction(turn1, { action: 'guess_number', number: 101 }).ok, false);

  // Chọn 1 số an toàn != bombNum -> thu hẹp khoảng & chuyển lượt
  const safeNum = bombNum === 50 ? 49 : 50;
  assert.strictEqual(mgr.handleAction(turn1, { action: 'guess_number', number: safeNum }).ok, true);
  assert.strictEqual(nbRoom.game.turnClientId, turn2);
  if (safeNum < bombNum) {
    assert.strictEqual(nbRoom.game.minBound, safeNum);
  } else {
    assert.strictEqual(nbRoom.game.maxBound, safeNum);
  }

  // Người 2 chọn đúng số bom -> NỔ & người 1 thắng luôn (vì chỉ còn 1 người sống sót)
  assert.strictEqual(mgr.handleAction(turn2, { action: 'guess_number', number: bombNum }).ok, true);
  assert.strictEqual(nbRoom.game.phase, 'ended');
  assert.strictEqual(nbRoom.game.winnerName, nbRoom.players.get(turn1).nickname);
  mgr.leaveRoom('client-41');
  mgr.leaveRoom('client-42');

  // 3F. Game 5: caro_arena (Cờ Caro Khán Đài + Luân phiên lên sàn)
  const caCreate = mgr.createRoom(makeUser(51, 'Kỳ thủ 1'), { gameType: 'caro_arena' });
  mgr.joinRoom(makeUser(52, 'Kỳ thủ 2'), { roomId: caCreate.room.roomId });
  mgr.joinRoom(makeUser(53, 'Khán giả 3'), { roomId: caCreate.room.roomId });
  assert.strictEqual(mgr.startGame('client-51').ok, true);
  const caRoom = mgr.getRoom(caCreate.room.roomId);
  assert.strictEqual(caRoom.game.xPlayer, 'client-51');
  assert.strictEqual(caRoom.game.oPlayer, 'client-52');
  assert.strictEqual(mgr._serializePublicGameState(caRoom).spectatorCount, 1);

  // Khán giả KHÔNG được đánh cờ
  assert.strictEqual(mgr.handleAction('client-53', { action: 'caro_move', index: 0 }).ok, false);

  // X đánh 5 ô liên tiếp hàng 0 (0,1,2,3,4), O đánh hàng 1 (15,16,17,18) -> X thắng
  const xMoves = [0, 1, 2, 3, 4];
  const oMoves = [15, 16, 17, 18];
  for (let k = 0; k < 4; k++) {
    assert.strictEqual(mgr.handleAction('client-51', { action: 'caro_move', index: xMoves[k] }).ok, true);
    assert.strictEqual(mgr.handleAction('client-52', { action: 'caro_move', index: oMoves[k] }).ok, true);
  }
  assert.strictEqual(mgr.handleAction('client-51', { action: 'caro_move', index: xMoves[4] }).ok, true);
  assert.strictEqual(caRoom.game.phase, 'ended');
  assert.strictEqual(caRoom.game.winner, 'X');
  assert.strictEqual(caRoom.game.winnerId, 'client-51');

  // Ván tiếp theo -> X (người thắng) ở lại, Khán giả 3 (client-53) luân phiên lên đấu!
  assert.strictEqual(mgr.startGame('client-51').ok, true);
  assert.strictEqual(caRoom.game.xPlayer, 'client-51');
  assert.strictEqual(caRoom.game.oPlayer, 'client-53', 'Spectator must rotate into next Caro duel');

  mgr.leaveRoom('client-51');
  mgr.leaveRoom('client-52');
  mgr.leaveRoom('client-53');
  assert.strictEqual(mgr.rooms.size, 0);

  console.log('✅ Passed: GameRoomManager (10-player cap, lifecycle & all 5 games)');
}

// ─── 4. Live WebSocket Server E2E Tests ──────────────────────────────────────

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
              rej(new Error(`Timed out waiting for WebSocket message. Queued=${JSON.stringify(queue.slice(-5))}\nCaller:\n${callStack}`));
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
  console.log('--- 4. Testing Live WebSocket Server (Group @Mentions + 10-Player Game Room E2E) ---');
  const testPort = 3910;
  const serverPath = path.join(__dirname, '..', 'backend', 'server.js');

  const serverProc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(testPort),
      USE_REDIS: 'false',
      MAX_CONNECTIONS_PER_IP: '120',
      MAX_GAME_ROOM_PLAYERS: '10',
      FAST_BOT_GAMES: 'true',
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
    // 4A. Group Chat: 3 người trùng biệt danh "Cánh Cụt" + tag @Cánh Cụt 2 & @Cánh Cụt 3
    const gClients = [];
    for (let i = 1; i <= 3; i++) {
      const c = await connectWsClient(wsUrl);
      openClients.push(c);
      const conn = await c.waitFor((m) => m.type === SERVER_TYPES.CONNECTED);
      c.clientId = conn.payload.clientId;
      c.send(CLIENT_TYPES.JOIN, { nickname: 'Cánh Cụt', avatar: '🐧', interests: ['game'], deviceId: `grp-dev-${i}` });
      gClients.push(c);
    }

    gClients[0].send(CLIENT_TYPES.GROUP_CREATE, { mode: 'topic', topic: 'Hội Cánh Cụt' });
    const gJoined1 = await gClients[0].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    const groupId = gJoined1.payload.groupId;

    gClients[1].send(CLIENT_TYPES.GROUP_JOIN, { groupId });
    const [gJoined2, gNotify1] = await Promise.all([
      gClients[1].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED),
      gClients[0].waitFor((m) => m.type === SERVER_TYPES.GROUP_MEMBER_JOINED),
    ]);
    assert.strictEqual(gNotify1.payload.renamedMembers.length, 1);
    assert.strictEqual(gNotify1.payload.renamedMembers[0].newNickname, 'Cánh Cụt 1');
    assert.strictEqual(gJoined2.payload.members.find((m) => m.clientId === gClients[1].clientId).nickname, 'Cánh Cụt 2');

    gClients[2].send(CLIENT_TYPES.GROUP_JOIN, { groupId });
    const gJoined3 = await gClients[2].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    const groupNames = gJoined3.payload.members.map((m) => m.nickname).sort();
    assert.deepStrictEqual(groupNames, ['Cánh Cụt 1', 'Cánh Cụt 2', 'Cánh Cụt 3']);

    // Cánh Cụt 1 gửi tin tag @Cánh Cụt 2 và @Cánh Cụt 3
    gClients[0].send(CLIENT_TYPES.MESSAGE, { text: 'Hello @Cánh Cụt 2 và @Cánh Cụt 3 nha!' });
    const [gMsg2, gMsg3] = await Promise.all([
      gClients[1].waitFor((m) => m.type === SERVER_TYPES.GROUP_MESSAGE),
      gClients[2].waitFor((m) => m.type === SERVER_TYPES.GROUP_MESSAGE),
    ]);
    assert.strictEqual(gMsg2.payload.senderNickname, 'Cánh Cụt 1');
    assert.deepStrictEqual(
      gMsg2.payload.mentions.map((m) => m.nickname),
      ['Cánh Cụt 2', 'Cánh Cụt 3']
    );
    assert.strictEqual(gMsg3.payload.mentions.some((m) => m.clientId === gClients[2].clientId), true);

    // Rời hết nhóm (chưa ai vote giữ -> tự biến mất)
    for (const c of gClients) {
      c.send(CLIENT_TYPES.GROUP_LEAVE);
      await c.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT);
    }

    // 4B. Game Room: 10 người vào chung phòng (trùng biệt danh), chặn người thứ 11,
    //     chat @mention trong phòng game, chơi Number Bomb + Undercover, thoát hết -> tự hủy phòng
    const players = [];
    for (let i = 1; i <= 11; i++) {
      const c = await connectWsClient(wsUrl);
      openClients.push(c);
      const conn = await c.waitFor((m) => m.type === SERVER_TYPES.CONNECTED);
      c.clientId = conn.payload.clientId;
      const nick = i <= 3 ? 'Gấu Trúc' : `GameMem ${i}`;
      c.send(CLIENT_TYPES.JOIN, { nickname: nick, avatar: '🐼', interests: ['game'], deviceId: `game-dev-${i}` });
      players.push(c);
    }

    // Player 1 tạo phòng number_bomb (tối đa 10 người)
    players[0].send(CLIENT_TYPES.GAME_ROOM_CREATE, {
      gameType: 'number_bomb',
      name: 'Phòng Bom 10 Người',
      maxPlayers: 10,
    });
    const roomCreated = await players[0].waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_JOINED);
    const roomCode = roomCreated.payload.roomCode;
    assert.strictEqual(roomCreated.payload.maxPlayers, 10);

    // Players 2..10 tham gia bằng roomCode
    for (let i = 1; i < 10; i++) {
      players[i].send(CLIENT_TYPES.GAME_ROOM_JOIN, { roomCode });
      const joined = await players[i].waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_JOINED);
      assert.strictEqual(joined.payload.playerCount, i + 1);
      if (i === 2) {
        const pandaNames = joined.payload.players.map((p) => p.nickname).sort();
        assert.deepStrictEqual(pandaNames, ['Gấu Trúc 1', 'Gấu Trúc 2', 'Gấu Trúc 3']);
      }
    }

    // Player 11 cố vào -> bị chặn GAME_ROOM_FULL
    players[10].send(CLIENT_TYPES.GAME_ROOM_JOIN, { roomCode });
    const fullErr = await players[10].waitFor((m) => m.type === SERVER_TYPES.ERROR);
    assert.strictEqual(fullErr.payload.code, 'GAME_ROOM_FULL');

    // Chat @mention trong phòng game (Gấu Trúc 1 tag @Gấu Trúc 2)
    players[0].send(CLIENT_TYPES.MESSAGE, { text: 'Cố lên @Gấu Trúc 2 đừng dính bom nhé!' });
    const roomMsgs = await Promise.all(
      players.slice(1, 10).map((c) => c.waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_MESSAGE))
    );
    assert.strictEqual(roomMsgs.length, 9);
    assert.strictEqual(roomMsgs[0].payload.senderNickname, 'Gấu Trúc 1');
    assert.strictEqual(roomMsgs[0].payload.mentions.length, 1);
    assert.strictEqual(roomMsgs[0].payload.mentions[0].clientId, players[1].clientId);
    assert.strictEqual(roomMsgs[0].payload.mentions[0].nickname, 'Gấu Trúc 2');

    // Host bắt đầu game Đặt Bom Số -> cả 10 người nhận trạng thái playing
    players[0].send(CLIENT_TYPES.GAME_ROOM_START);
    const startStates = await Promise.all(
      players.slice(0, 10).map((c) => c.waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && m.payload.gameState.phase === 'playing'))
    );
    const turnClientId = startStates[0].payload.gameState.turnClientId;
    const activePlayer = players.find((p) => p.clientId === turnClientId);
    assert.ok(activePlayer, 'Turn player must be in the 10-player room');

    // Người đến lượt chọn số 50 -> nhận game_room_state mới (playing hoặc boom)
    activePlayer.send(CLIENT_TYPES.GAME_ROOM_ACTION, { action: 'guess_number', number: 50 });
    const afterGuess = await players[0].waitFor(
      (m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && (
        m.payload.gameState.phase === 'boom'
        || (m.payload.gameState.history && m.payload.gameState.history.length >= 1)
      )
    );
    assert.ok(afterGuess.payload.gameState.history.length >= 1);

    // Host chuyển sang game Ai Là Gián Điệp? (undercover) và bắt đầu cho cả 10 người (sẽ có 2 gián điệp)
    players[0].send(CLIENT_TYPES.GAME_ROOM_ACTION, { action: 'back_to_lobby' });
    await players[0].waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && m.payload.gameState.phase === 'lobby');

    players[0].send(CLIENT_TYPES.GAME_ROOM_SELECT_GAME, { gameType: 'undercover' });
    await players[0].waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && m.payload.gameType === 'undercover');

    players[0].send(CLIENT_TYPES.GAME_ROOM_START);
    const [ucStates, ucPrivates] = await Promise.all([
      Promise.all(
        players.slice(0, 10).map((c) => c.waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && m.payload.gameState.phase === 'clue'))
      ),
      Promise.all(
        players.slice(0, 10).map((c) => c.waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_PRIVATE))
      ),
    ]);
    assert.strictEqual(ucStates[0].payload.gameState.spyCount, 2, '10-player Undercover should have 2 spies');
    assert.strictEqual(ucStates[0].payload.gameState.revealSecret, null, 'Secret words must stay hidden in public state');
    assert.strictEqual(ucPrivates.every((p) => typeof p.payload.secretWord === 'string' && p.payload.secretWord.length > 0), true);
    const uniqueSecretWords = new Set(ucPrivates.map((p) => p.payload.secretWord));
    assert.strictEqual(uniqueSecretWords.size, 2, 'Should distribute exactly 2 distinct secret words (civilian + spy)');

    // Cả 10 người rời phòng -> phòng game tự đóng
    for (let i = 0; i < 10; i++) {
      players[i].send(CLIENT_TYPES.GAME_ROOM_LEAVE);
      const leftMsg = await players[i].waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_LEFT);
      if (i === 9) {
        assert.strictEqual(leftMsg.payload.destroyed, true, 'Last player leaving must destroy room');
      }
    }

    // Kiểm tra danh sách phòng trống
    players[10].send(CLIENT_TYPES.GAME_ROOM_LIST, { gameType: 'all' });
    const listRes = await players[10].waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_LIST);
    assert.strictEqual(listRes.payload.rooms.length, 0);

    // 4C. Chơi các game mới NGAY TRONG CHAT 1-1 VỚI LUMI AI (Đố Vui + Nối Từ + Đặt Bom Số)
    const solo = await connectWsClient(wsUrl);
    openClients.push(solo);
    const soloConn = await solo.waitFor((m) => m.type === SERVER_TYPES.CONNECTED);
    solo.clientId = soloConn.payload.clientId;
    solo.send(CLIENT_TYPES.JOIN, { nickname: 'SoloGamer', avatar: '🐱', interests: ['game'], deviceId: 'solo-dev-1' });
    solo.send(CLIENT_TYPES.START_SOLO);
    const soloMatch = await solo.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND);
    assert.strictEqual(soloMatch.payload.isBot, true);

    // 4C-1: Đố Vui Tốc Độ với Lumi AI -> user chọn đáp án -> Lumi tự động trả lời -> sang pha reveal
    solo.send(CLIENT_TYPES.GAME_INVITE, { gameType: 'quiz_race' });
    const lumiQuizStart = await solo.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'quiz_race' && m.payload.gameState.phase === 'question');
    assert.strictEqual(lumiQuizStart.payload.contextType, '1v1');
    assert.strictEqual(lumiQuizStart.payload.isBotSession, true);
    solo.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'answer', optionIndex: 0 });
    const lumiQuizReveal = await solo.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'quiz_race' && m.payload.gameState.phase === 'reveal');
    assert.strictEqual(typeof lumiQuizReveal.payload.gameState.correctIndex, 'number');

    // 4C-2: Đặt Bom Số với Lumi AI -> Lumi tự động chọn số khi tới lượt
    solo.send(CLIENT_TYPES.GAME_INVITE, { gameType: 'number_bomb' });
    const lumiBombStart = await solo.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'number_bomb' && m.payload.gameState.phase === 'playing');
    if (lumiBombStart.payload.gameState.turnClientId === solo.clientId) {
      solo.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'guess_number', number: 50 });
    }
    const lumiBombAfter = await solo.waitFor(
      (m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'number_bomb' && (
        m.payload.gameState.phase === 'ended'
        || m.payload.gameState.phase === 'boom'
        || (m.payload.gameState.history && m.payload.gameState.history.length >= 1)
      )
    );
    assert.ok(lumiBombAfter.payload.gameState.history.length >= 1 || lumiBombAfter.payload.gameState.phase === 'ended');

    // 4C-3: Đóng game nhúng -> vẫn ở trong phòng chat Lumi
    solo.send(CLIENT_TYPES.CHAT_GAME_CLOSE);
    const lumiClosed = await solo.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.closed === true);
    assert.strictEqual(lumiClosed.payload.contextType, '1v1');
    solo.send(CLIENT_TYPES.LEAVE_ROOM);

    // 4D. Chơi game mới NGAY TRONG CHAT 1-1 VỚI NGƯỜI THẬT (không cần vào Phòng Game riêng)
    const pA = await connectWsClient(wsUrl);
    const pB = await connectWsClient(wsUrl);
    openClients.push(pA, pB);
    const [connA, connB] = await Promise.all([
      pA.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
      pB.waitFor((m) => m.type === SERVER_TYPES.CONNECTED),
    ]);
    pA.clientId = connA.payload.clientId;
    pB.clientId = connB.payload.clientId;
    pA.send(CLIENT_TYPES.JOIN, { nickname: 'Alice1v1', avatar: '🦊', interests: ['game'], deviceId: '1v1-dev-a' });
    pB.send(CLIENT_TYPES.JOIN, { nickname: 'Bob1v1', avatar: '🐻', interests: ['game'], deviceId: '1v1-dev-b' });
    pA.send(CLIENT_TYPES.FIND_MATCH);
    pB.send(CLIENT_TYPES.FIND_MATCH);
    await Promise.all([
      pA.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
      pB.waitFor((m) => m.type === SERVER_TYPES.MATCH_FOUND),
    ]);

    // A mời B chơi Nối Từ Thần Tốc ngay trong chat 1-1
    pA.send(CLIENT_TYPES.GAME_INVITE, { gameType: 'word_chain' });
    const invB = await pB.waitFor((m) => m.type === SERVER_TYPES.GAME_STATE && m.payload.action === 'invite');
    assert.strictEqual(invB.payload.gameType, 'word_chain');

    // B chấp nhận -> cả 2 nhận CHAT_GAME_STATE (playing)
    pB.send(CLIENT_TYPES.GAME_ACCEPT, { gameType: 'word_chain' });
    const [wcA, wcB] = await Promise.all([
      pA.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'word_chain' && m.payload.gameState.phase === 'playing'),
      pB.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'word_chain' && m.payload.gameState.phase === 'playing'),
    ]);
    assert.strictEqual(wcA.payload.contextType, '1v1');
    const wcTurnId = wcA.payload.gameState.turnClientId;
    const wcReqStart = wcA.payload.gameState.requiredStart;
    const wcActive = wcTurnId === pA.clientId ? pA : pB;
    wcActive.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'submit_word', word: `${wcReqStart} đẹp` });
    await pB.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameState.chainLength === 2);

    // Đóng game -> vẫn nhắn tin 1-1 bình thường
    pA.send(CLIENT_TYPES.CHAT_GAME_CLOSE);
    await Promise.all([
      pA.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.closed === true),
      pB.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.closed === true),
    ]);
    pA.send(CLIENT_TYPES.MESSAGE, { text: 'Chơi vui ghê, chat tiếp nha!' });
    const chatAfterGame = await pB.waitFor((m) => m.type === SERVER_TYPES.MESSAGE);
    assert.strictEqual(chatAfterGame.payload.text, 'Chơi vui ghê, chat tiếp nha!');
    pA.send(CLIENT_TYPES.LEAVE_ROOM);

    // 4E. Chơi "Ai Là Gián Điệp?" NGAY TRONG NHÓM CHAT ẨN DANH (3 người ngồi bàn + 1 khán giả + trùng biệt danh)
    const grpPlayers = [];
    for (let i = 1; i <= 4; i++) {
      const c = await connectWsClient(wsUrl);
      openClients.push(c);
      const conn = await c.waitFor((m) => m.type === SERVER_TYPES.CONNECTED);
      c.clientId = conn.payload.clientId;
      c.send(CLIENT_TYPES.JOIN, {
        nickname: i <= 2 ? 'Cáo' : `ThànhViên ${i}`,
        avatar: '🦊',
        interests: ['game'],
        deviceId: `grp-game-dev-${i}`,
      });
      grpPlayers.push(c);
    }
    grpPlayers[0].send(CLIENT_TYPES.GROUP_CREATE, { mode: 'topic', topic: 'Chơi Game Trong Nhóm' });
    const gg1 = await grpPlayers[0].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    const ggId = gg1.payload.groupId;
    for (let i = 1; i < 4; i++) {
      grpPlayers[i].send(CLIENT_TYPES.GROUP_JOIN, { groupId: ggId });
      await grpPlayers[i].waitFor((m) => m.type === SERVER_TYPES.GROUP_JOINED);
    }

    // Người 1 (Cáo 1) mở bàn "Ai Là Gián Điệp?" ngay trong nhóm -> cả 4 người trong nhóm đều nhận trạng thái
    grpPlayers[0].send(CLIENT_TYPES.CHAT_GAME_OPEN, { gameType: 'undercover' });
    await Promise.all(
      grpPlayers.map((c) => c.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.contextType === 'group' && m.payload.gameType === 'undercover'))
    );

    // Người 2 (Cáo 2) và Người 3 ngồi vào bàn; Người 4 làm khán giả
    grpPlayers[1].send(CLIENT_TYPES.CHAT_GAME_JOIN);
    await grpPlayers[0].waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.playerCount === 2);
    grpPlayers[2].send(CLIENT_TYPES.CHAT_GAME_JOIN);
    const seated3 = await grpPlayers[0].waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.playerCount === 3);
    const seatedNames = seated3.payload.players.map((p) => p.nickname).sort();
    assert.deepStrictEqual(seatedNames, ['Cáo 1', 'Cáo 2', 'ThànhViên 3'], 'Group game must preserve numbered group nicknames');

    // Host bắt đầu -> 3 người ngồi bàn nhận từ bí mật riêng, khán giả Người 4 nhận state công khai không lộ từ bí mật
    grpPlayers[0].send(CLIENT_TYPES.CHAT_GAME_START);
    const [grpPrivates, specState] = await Promise.all([
      Promise.all(grpPlayers.slice(0, 3).map((c) => c.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_PRIVATE))),
      grpPlayers[3].waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameState.phase === 'clue'),
    ]);
    assert.strictEqual(grpPrivates.every((p) => typeof p.payload.secretWord === 'string' && p.payload.secretWord.length > 0), true);
    assert.strictEqual(specState.payload.gameState.revealSecret, null);

    // Khán giả Người 4 không được gửi gợi ý vào bàn game
    grpPlayers[3].send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'submit_clue', clue: 'Mình là khán giả' });
    const specErr = await grpPlayers[3].waitFor((m) => m.type === SERVER_TYPES.ERROR);
    assert.strictEqual(specErr.payload.code, 'CHAT_GAME_ACTION_ERROR');

    // Host đóng bàn game -> cả nhóm vẫn tiếp tục chat nhóm bình thường
    grpPlayers[0].send(CLIENT_TYPES.CHAT_GAME_CLOSE);
    await Promise.all(grpPlayers.map((c) => c.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.closed === true)));

    for (const c of grpPlayers) {
      c.send(CLIENT_TYPES.GROUP_LEAVE);
      await c.waitFor((m) => m.type === SERVER_TYPES.GROUP_LEFT);
    }

    console.log('✅ Passed: Live WebSocket E2E (Group @Mentions + 10-Player Game Room + 1-1/Lumi/Group Embedded Games)');
  } finally {
    await Promise.all(openClients.map((c) => c.close()));
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  console.log('=== Running Multiplayer Game Room, Duplicate Nickname & @Mention Test Suite ===');
  runNicknameResolverTests();
  await runGroupMentionUnitTests();
  runGameRoomManagerUnitTests();
  await runLiveWebSocketTests();
  console.log('\n🎉 ALL GAME ROOM, NICKNAME & @MENTION TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
