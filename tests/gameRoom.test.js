/**
 * tests/gameRoom.test.js
 * Kiểm thử toàn diện:
 *   1. nicknameResolver.js (đánh số trùng biệt danh "Cánh Cụt 1", "Cánh Cụt 2" & trích xuất @mention)
 *   2. GroupManager (trùng biệt danh + @mention trong phòng nhóm)
 *   3. GameRoomManager (2–10 người/phòng, ẩn danh, mã phòng, chuyển host, tự hủy phòng & cả 5 game:
 *      quiz_race, word_chain, undercover, mind_duel, caro_arena)
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
const { CLIENT_TYPES, SERVER_TYPES, validatePayload } = require('../backend/protocol');

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
      mindDuelChooseMs: 30_000,
      mindDuelRevealMs: 30_000,
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
  assert.strictEqual(pubQuizBefore.durationMs, 30_000, 'Quiz question must expose phase durationMs for countdown progress');
  assert.ok(
    typeof pubQuizBefore.remainingMs === 'number' && pubQuizBefore.remainingMs > 0 && pubQuizBefore.remainingMs <= 30_000,
    'Quiz question must expose server-computed remainingMs'
  );

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
  // Không cho phép tạo phòng Gián Điệp với maxPlayers = 2 (ở cả protocol lẫn manager) và không cho đổi phòng 2 người sang Gián Điệp
  assert.strictEqual(
    validatePayload(CLIENT_TYPES.GAME_ROOM_CREATE, { gameType: 'undercover', maxPlayers: 2 }).ok,
    false,
    'Protocol must reject undercover room with maxPlayers < 3'
  );
  assert.strictEqual(
    validatePayload(CLIENT_TYPES.GAME_ROOM_CREATE, { gameType: 'undercover', maxPlayers: 3 }).ok,
    true,
    'Protocol must accept undercover room with maxPlayers = 3'
  );
  const clampedUc = mgr.createRoom(makeUser(30, 'CheckMin'), { gameType: 'undercover', maxPlayers: 2 });
  assert.strictEqual(clampedUc.room.maxPlayers, 3, 'GameRoomManager must never create undercover room with maxPlayers < 3');
  mgr.leaveRoom('client-30');
  const twoPlayerQuiz = mgr.createRoom(makeUser(30, 'TwoOnly'), { gameType: 'quiz_race', maxPlayers: 2 });
  assert.strictEqual(mgr.selectGame('client-30', 'undercover').ok, false, 'Must block switching a 2-player room to undercover');
  mgr.leaveRoom('client-30');

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

  // 3E. Game 4: mind_duel (🃏 Đấu Trí Tâm Lý — Cược Điểm & Lật Bài)
  const mdCreate = mgr.createRoom(makeUser(41, 'CaoThủ1'), { gameType: 'mind_duel' });
  mgr.joinRoom(makeUser(42, 'CaoThủ2'), { roomId: mdCreate.room.roomId });
  assert.strictEqual(mgr.startGame('client-41').ok, true);
  const mdRoom = mgr.getRoom(mdCreate.room.roomId);
  assert.strictEqual(mdRoom.game.phase, 'choose');
  assert.strictEqual(mdRoom.players.get('client-41').score, 100, 'Mind Duel must start players at 100 pts');
  assert.strictEqual(mdRoom.players.get('client-42').score, 100);

  // Lá bài hoặc mức cược sai -> từ chối
  assert.strictEqual(mgr.handleAction('client-41', { action: 'pick_card', card: 'invalid', stake: 20 }).ok, false);
  assert.strictEqual(mgr.handleAction('client-41', { action: 'pick_card', card: 'attack', stake: 99 }).ok, false);

  // Người 1 chọn Tấn Công (cược 30) -> pha vẫn là choose, không lộ bài trong public state
  assert.strictEqual(mgr.handleAction('client-41', { action: 'pick_card', card: 'attack', stake: 30 }).ok, true);
  assert.strictEqual(mdRoom.game.phase, 'choose');
  const mdPublicChoosing = mgr._serializePublicGameState(mdRoom);
  assert.strictEqual(mdPublicChoosing.lockedCount, 1);
  assert.strictEqual(mdPublicChoosing.roundResults.length, 0, 'Choices must stay secret until reveal');
  assert.strictEqual(mdPublicChoosing.durationMs, 30_000, 'Mind Duel choose phase must expose durationMs');
  assert.ok(
    typeof mdPublicChoosing.remainingMs === 'number' && mdPublicChoosing.remainingMs > 0 && mdPublicChoosing.remainingMs <= 30_000,
    'Mind Duel choose phase must expose server-computed remainingMs'
  );

  // Người 2 chọn Tích Lũy (cược 20) -> tự lật bài! Tấn Công cướp kho: +50 (150), Tích Lũy mất -30 (70)
  assert.strictEqual(mgr.handleAction('client-42', { action: 'pick_card', card: 'charge', stake: 20 }).ok, true);
  assert.strictEqual(mdRoom.game.phase, 'reveal');
  assert.strictEqual(mdRoom.players.get('client-41').score, 150);
  assert.strictEqual(mdRoom.players.get('client-42').score, 70);
  assert.strictEqual(mdRoom.game.history.length, 1);

  // Kiểm tra vòng cuối (Vòng 6) nhân đôi điểm x2: Lừa Đòn (20) xuyên Lá Chắn (20) -> +35*2=+70 / -25*2=-50
  mdRoom.game.round = 6;
  mgr._beginMindDuelRound(mdRoom, false);
  assert.strictEqual(mgr._serializePublicGameState(mdRoom).isDoubleRound, true);
  assert.strictEqual(mgr.handleAction('client-41', { action: 'pick_card', card: 'shield', stake: 20 }).ok, true);
  assert.strictEqual(mgr.handleAction('client-42', { action: 'pick_card', card: 'bluff', stake: 20 }).ok, true);
  assert.strictEqual(mdRoom.game.phase, 'reveal');
  assert.strictEqual(mdRoom.players.get('client-41').score, 100, 'Shield pierced on x2 round: 150 - 50 = 100');
  assert.strictEqual(mdRoom.players.get('client-42').score, 140, 'Bluff pierces shield on x2 round: 70 + 70 = 140');

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

  // 3G. Regression: Quiz Race attribution, speed ordering, receivedAt fairness, score reset & leave edge cases
  const qrCreate = mgr.createRoom(makeUser(101, 'NhanhNhất', '⚡'), { gameType: 'quiz_race' });
  const qrId = qrCreate.room.roomId;
  mgr.joinRoom(makeUser(102, 'ChậmHơn', '🐢'), { roomId: qrId });
  mgr.joinRoom(makeUser(103, 'ChọnSai', '🙈'), { roomId: qrId });
  assert.strictEqual(mgr.startGame('client-101').ok, true);
  const qrRoom = mgr.getRoom(qrId);
  // Lùi questionStartedAt về 8 giây trước để mô phỏng các mốc thời gian thực tế trong quá khứ (<= Date.now())
  qrRoom.game.questionStartedAt = Date.now() - 8000;
  const q0Start = qrRoom.game.questionStartedAt;
  const q0Ans = qrRoom.game.questions[0].answer;
  const q0Token = mgr._serializePublicGameState(qrRoom).questionToken;

  // Giả lập độ trễ Redis: ChậmHơn đến sau về thời gian bấm (t+5000ms) nhưng vào handleAction trước,
  // NhanhNhất bấm sớm hơn nhiều (t+1000ms) nhưng vào handleAction sau -> NhanhNhất VẪN phải điểm cao hơn!
  assert.strictEqual(
    mgr.handleAction('client-102', { action: 'answer', optionIndex: q0Ans }, { receivedAt: q0Start + 5000 }).ok,
    true
  );
  assert.strictEqual(
    mgr.handleAction('client-103', { action: 'answer', optionIndex: (q0Ans + 1) % 4 }, { receivedAt: q0Start + 500 }).ok,
    true
  );
  assert.strictEqual(
    mgr.handleAction('client-101', { action: 'answer', optionIndex: q0Ans }, { receivedAt: q0Start + 1000 }).ok,
    true
  );

  assert.strictEqual(qrRoom.game.phase, 'reveal');
  const sFast = qrRoom.players.get('client-101').score;
  const sSlow = qrRoom.players.get('client-102').score;
  const sWrong = qrRoom.players.get('client-103').score;
  assert.ok(sFast > sSlow, `Faster correct player (${sFast}) MUST strictly outscore slower player (${sSlow})`);
  assert.ok(sSlow >= 100, 'Slower correct player must still earn >= 100');
  assert.strictEqual(sWrong, 0, 'Wrong answer must earn exactly 0');
  assert.strictEqual(qrRoom.game.lastRoundResults[0].clientId, 'client-101');
  assert.strictEqual(qrRoom.game.lastRoundResults[0].isFastest, true);
  assert.strictEqual(qrRoom.game.lastRoundResults[0].fastestBonus, 10);
  assert.strictEqual(qrRoom.game.lastRoundResults[1].clientId, 'client-102');
  assert.strictEqual(qrRoom.game.lastRoundResults[2].clientId, 'client-103');

  // Chơi ván mới (play_again) -> toàn bộ điểm phải reset về 0 và đổi questionToken!
  assert.strictEqual(mgr.handleAction('client-101', { action: 'play_again' }).ok, true);
  assert.strictEqual(qrRoom.players.get('client-101').score, 0, 'play_again must reset score to 0');
  assert.strictEqual(qrRoom.players.get('client-102').score, 0, 'play_again must reset score to 0');
  assert.strictEqual(qrRoom.players.get('client-103').score, 0, 'play_again must reset score to 0');
  assert.notStrictEqual(mgr._serializePublicGameState(qrRoom).questionToken, q0Token);

  // Người chơi đã trả lời rồi rời phòng giữa chừng KHÔNG được làm lộ đáp án sớm cho người chưa trả lời
  const qNewAns = qrRoom.game.questions[0].answer;
  assert.strictEqual(mgr.handleAction('client-103', { action: 'answer', optionIndex: qNewAns }).ok, true);
  mgr.leaveRoom('client-103');
  assert.strictEqual(qrRoom.game.phase, 'question', 'Leaving player answer must not trigger premature reveal');
  assert.strictEqual(qrRoom.game.answers.has('client-103'), false);

  // Chỉ client-101 trả lời đúng, client-102 trả lời sai -> đúng người được cộng điểm, không lệch sang đối phương
  assert.strictEqual(mgr.handleAction('client-101', { action: 'answer', optionIndex: qNewAns }).ok, true);
  assert.strictEqual(mgr.handleAction('client-102', { action: 'answer', optionIndex: (qNewAns + 2) % 4 }).ok, true);
  assert.strictEqual(qrRoom.game.phase, 'reveal');
  assert.ok(qrRoom.players.get('client-101').score >= 100);
  assert.strictEqual(qrRoom.players.get('client-102').score, 0);

  // Đổi sang game khác -> điểm reset về 0
  assert.strictEqual(mgr.handleAction('client-101', { action: 'back_to_lobby' }).ok, true);
  assert.strictEqual(mgr.selectGame('client-101', 'word_chain').ok, true);
  assert.strictEqual(qrRoom.players.get('client-101').score, 0, 'selectGame must reset scores to 0');
  mgr.leaveRoom('client-101');
  mgr.leaveRoom('client-102');

  // 3H. Regression: Undercover mid-game spectator must NOT earn points when game ends
  const uc2 = mgr.createRoom(makeUser(111, 'Dân1'), { gameType: 'undercover' });
  mgr.joinRoom(makeUser(112, 'Dân2'), { roomId: uc2.room.roomId });
  mgr.joinRoom(makeUser(113, 'Dân3'), { roomId: uc2.room.roomId });
  assert.strictEqual(mgr.startGame('client-111').ok, true);
  const uc2Room = mgr.getRoom(uc2.room.roomId);
  // Người thứ 4 vào giữa ván làm khán giả
  mgr.joinRoom(makeUser(114, 'KhánGiả'), { roomId: uc2.room.roomId });
  const uc2Spy = [...uc2Room.game.spyIds][0];
  const uc2Civs = ['client-111', 'client-112', 'client-113'].filter((id) => id !== uc2Spy);
  mgr.handleAction('client-111', { action: 'submit_clue', clue: 'Gợi ý rất quen thuộc' });
  mgr.handleAction('client-112', { action: 'submit_clue', clue: 'Ai cũng biết món này' });
  mgr.handleAction('client-113', { action: 'submit_clue', clue: 'Xuất hiện hằng ngày' });
  mgr.handleAction(uc2Civs[0], { action: 'vote', targetClientId: uc2Spy });
  mgr.handleAction(uc2Civs[1], { action: 'vote', targetClientId: uc2Spy });
  mgr.handleAction(uc2Spy, { action: 'vote', targetClientId: uc2Civs[0] });
  assert.strictEqual(uc2Room.game.phase, 'ended');
  assert.strictEqual(uc2Room.game.winnerSide, 'civilians');
  assert.strictEqual(uc2Room.players.get(uc2Civs[0]).score, 25);
  assert.strictEqual(uc2Room.players.get(uc2Civs[1]).score, 25);
  assert.strictEqual(uc2Room.players.get(uc2Spy).score, 0);
  assert.strictEqual(uc2Room.players.get('client-114').score, 0, 'Mid-game spectator must NOT earn points');
  for (const cid of ['client-111', 'client-112', 'client-113', 'client-114']) mgr.leaveRoom(cid);
  assert.strictEqual(mgr.rooms.size, 0);

  console.log('✅ Passed: GameRoomManager (10-player cap, lifecycle, scoring accuracy & all 5 games)');
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

    // Player 1 tạo phòng mind_duel (tối đa 10 người)
    players[0].send(CLIENT_TYPES.GAME_ROOM_CREATE, {
      gameType: 'mind_duel',
      name: 'Phòng Đấu Trí 10 Người',
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

    // Host bắt đầu game Đấu Trí Tâm Lý -> cả 10 người nhận trạng thái choose (vốn 100đ)
    players[0].send(CLIENT_TYPES.GAME_ROOM_START);
    const startStates = await Promise.all(
      players.slice(0, 10).map((c) => c.waitFor((m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && m.payload.gameState.phase === 'choose'))
    );
    assert.strictEqual(startStates[0].payload.gameState.round, 1);
    assert.strictEqual(startStates[0].payload.players.every((p) => p.score === 100), true);

    // Cả 10 người cùng úp bài -> tự động lật bài sang pha reveal với đủ 10 kết quả
    const cardsCycle = ['attack', 'shield', 'bluff', 'charge'];
    for (let i = 0; i < 10; i++) {
      players[i].send(CLIENT_TYPES.GAME_ROOM_ACTION, {
        action: 'pick_card',
        card: cardsCycle[i % 4],
        stake: 20,
      });
    }
    const afterReveal = await players[0].waitFor(
      (m) => m.type === SERVER_TYPES.GAME_ROOM_STATE && m.payload.gameState.phase === 'reveal'
    );
    assert.strictEqual(afterReveal.payload.gameState.roundResults.length, 10);

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

    // 4C. Chơi các game mới NGAY TRONG CHAT 1-1 VỚI LUMI AI (Đố Vui + Nối Từ + Đấu Trí Tâm Lý)
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

    // 4C-2: Đấu Trí Tâm Lý với Lumi AI -> user chọn lá bài & cược -> Lumi AI tự chọn bài -> lật bài reveal
    solo.send(CLIENT_TYPES.GAME_INVITE, { gameType: 'mind_duel' });
    const lumiMdStart = await solo.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'mind_duel' && m.payload.gameState.phase === 'choose');
    assert.strictEqual(lumiMdStart.payload.gameState.round, 1);
    solo.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'pick_card', card: 'bluff', stake: 20 });
    const lumiMdReveal = await solo.waitFor(
      (m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'mind_duel' && m.payload.gameState.phase === 'reveal'
    );
    assert.strictEqual(lumiMdReveal.payload.gameState.roundResults.length, 2);
    assert.ok(lumiMdReveal.payload.gameState.roundResults.some((r) => r.clientId === solo.clientId && r.card === 'bluff'));

    // 4C-3: Đóng game nhúng -> vẫn ở trong phòng chat Lumi
    solo.send(CLIENT_TYPES.CHAT_GAME_CLOSE);
    const lumiClosed = await solo.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.closed === true);
    assert.strictEqual(lumiClosed.payload.contextType, '1v1');

    // 4C-4: Cờ Caro với Lumi AI -> Chơi lại (GAME_RESET) đảo lượt cho Lumi đi X trước KHÔNG bị treo!
    solo.send(CLIENT_TYPES.GAME_INVITE, { gameType: 'caro', size: 10 });
    const lumiCaroStart = await solo.waitFor((m) => m.type === SERVER_TYPES.GAME_STATE && m.payload.action === 'start');
    assert.strictEqual(lumiCaroStart.payload.game.turn, solo.clientId);
    solo.send(CLIENT_TYPES.GAME_RESET, { size: 10 });
    const lumiCaroReset = await solo.waitFor((m) => m.type === SERVER_TYPES.GAME_STATE && m.payload.action === 'start');
    assert.notStrictEqual(lumiCaroReset.payload.game.turn, solo.clientId, 'After reset, Lumi should alternate to X');
    const lumiFirstMove = await solo.waitFor((m) => m.type === SERVER_TYPES.GAME_STATE && m.payload.action === 'update');
    assert.strictEqual(lumiFirstMove.payload.game.turn, solo.clientId, 'Lumi must auto-play its opening X move without deadlocking');
    solo.send(CLIENT_TYPES.GAME_QUIT);
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

    // Đóng Nối Từ -> mời chơi Đố Vui Tốc Độ 1-1 và kiểm tra cộng đúng điểm cho đúng người chơi!
    pA.send(CLIENT_TYPES.GAME_INVITE, { gameType: 'quiz_race' });
    const qInvB = await pB.waitFor((m) => m.type === SERVER_TYPES.GAME_STATE && m.payload.action === 'invite' && m.payload.gameType === 'quiz_race');
    assert.strictEqual(qInvB.payload.gameType, 'quiz_race');
    pB.send(CLIENT_TYPES.GAME_ACCEPT, { gameType: 'quiz_race' });
    const [qStartA, qStartB] = await Promise.all([
      pA.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'quiz_race' && m.payload.gameState.phase === 'question'),
      pB.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'quiz_race' && m.payload.gameState.phase === 'question'),
    ]);
    assert.strictEqual(qStartA.payload.players.length, 2);
    assert.strictEqual(qStartB.payload.players.length, 2);
    // Kiểm tra đáp án chính xác từ ngân hàng câu hỏi để pA trả lời đúng & nhanh hơn, pB trả lời sai
    const { QUIZ_QUESTIONS } = require('../backend/gameData');
    const matchedQ = QUIZ_QUESTIONS.find((item) => item.q === qStartA.payload.gameState.question.q);
    assert.ok(matchedQ, 'Question must exist in QUIZ_QUESTIONS');
    const correctIdx = matchedQ.answer;
    const wrongIdx = (correctIdx + 1) % 4;
    pA.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'answer', optionIndex: correctIdx });
    await new Promise((r) => setTimeout(r, 80));
    pB.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'answer', optionIndex: wrongIdx });
    const [qRevealA, qRevealB] = await Promise.all([
      pA.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'quiz_race' && m.payload.gameState.phase === 'reveal'),
      pB.waitFor((m) => m.type === SERVER_TYPES.CHAT_GAME_STATE && m.payload.gameType === 'quiz_race' && m.payload.gameState.phase === 'reveal'),
    ]);
    const pAScore = qRevealA.payload.players.find((p) => p.clientId === pA.clientId).score;
    const pBScore = qRevealB.payload.players.find((p) => p.clientId === pB.clientId).score;
    assert.ok(pAScore >= 100, `Alice answered correctly so Alice must get >= 100 pts (got ${pAScore})`);
    assert.strictEqual(pBScore, 0, `Bob answered wrong so Bob must get 0 pts (got ${pBScore})`);
    const resA = qRevealA.payload.gameState.roundResults.find((r) => r.clientId === pA.clientId);
    const resB = qRevealA.payload.gameState.roundResults.find((r) => r.clientId === pB.clientId);
    assert.strictEqual(resA.isCorrect, true);
    assert.strictEqual(resA.gained, pAScore);
    assert.strictEqual(resB.isCorrect, false);
    assert.strictEqual(resB.gained, 0);

    // Chơi ván mới -> reset điểm cả 2 về 0
    pA.send(CLIENT_TYPES.CHAT_GAME_ACTION, { action: 'play_again' });
    const qRestartA = await pA.waitFor(
      (m) => m.type === SERVER_TYPES.CHAT_GAME_STATE
        && m.payload.gameType === 'quiz_race'
        && m.payload.gameState.phase === 'question'
        && m.payload.gameState.questionToken !== qStartA.payload.gameState.questionToken
    );
    assert.strictEqual(qRestartA.payload.players.every((p) => p.score === 0), true, 'play_again must reset 1-1 embedded scores to 0');

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
