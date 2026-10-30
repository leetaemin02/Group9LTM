/**
 * unit-test.js – Kiểm thử đơn vị các module Server
 */

'use strict';

const assert = require('assert');
const Moderation = require('../backend/moderation');
const Matchmaker = require('../backend/matchmaker');
const RoomManager = require('../backend/roomManager');
const {
  CLIENT_TYPES,
  SERVER_TYPES,
  ERROR_CODES,
  parseMessage,
  validatePayload,
  serverMsg,
} = require('../backend/protocol');
const {
  AttachmentError,
  MAX_FILE_BYTES,
  MAX_VIDEO_BYTES,
  createAttachmentStorage,
  getFilePolicy,
  hasExpectedSignature,
  normalizeFileName,
} = require('../backend/attachmentStorage');

console.log('--- 1. Testing protocol.js ---');

// Test parseMessage
assert.strictEqual(parseMessage('not json').ok, false);
assert.strictEqual(parseMessage(JSON.stringify({ type: 'unknown_type' })).ok, false);
const validJoinRaw = JSON.stringify({
  type: CLIENT_TYPES.JOIN,
  payload: { nickname: 'Alice', interests: ['Game', 'Âm nhạc'] },
});
const parsed = parseMessage(validJoinRaw);
assert.strictEqual(parsed.ok, true);

// Test validatePayload - JOIN without HTML escaping
const validJoin = validatePayload(CLIENT_TYPES.JOIN, {
  nickname: 'Alice & Bob <script>',
  interests: ['Game', 'Music'],
});
assert.strictEqual(validJoin.ok, true);
assert.strictEqual(validJoin.sanitized.nickname, 'Alice & Bob <script>', 'Nickname should not be double escaped');
assert.strictEqual(validJoin.sanitized.interests.length, 2);

// Test validatePayload - MESSAGE without HTML escaping
const validMsg = validatePayload(CLIENT_TYPES.MESSAGE, {
  text: 'Hello <world> & friends!',
});
assert.strictEqual(validMsg.ok, true);
assert.strictEqual(validMsg.sanitized.text, 'Hello <world> & friends!', 'Message text should not be double escaped');
assert.strictEqual(validatePayload(CLIENT_TYPES.ATTACHMENT_REQUEST, { fileName: 'photo.png', size: 1024 }).ok, true);
assert.strictEqual(validatePayload(CLIENT_TYPES.ATTACHMENT_REQUEST, { fileName: 'movie.mp4', size: 51 * 1024 * 1024 }).ok, false);
assert.strictEqual(validatePayload(CLIENT_TYPES.ATTACHMENT_SEND, { ticket: 'ticket' }).ok, true);

console.log('✅ protocol.js passed');

console.log('--- Testing linkSafety.js ---');
const { analyzeLinkSafety, extractUrls } = require('../backend/linkSafety');
assert.deepStrictEqual(extractUrls('Email me@example.com, but visit https://example.com/a.'), ['https://example.com/a']);
assert.deepStrictEqual(analyzeLinkSafety('Chào bạn nhé!'), {
  hasLinks: false,
  suspicious: false,
  reasons: [],
});
assert.strictEqual(analyzeLinkSafety('Xem https://example.com').hasLinks, true);
assert.strictEqual(analyzeLinkSafety('Xem https://example.com').suspicious, false);
assert.strictEqual(analyzeLinkSafety('Email me@example.com nhé').hasLinks, false, 'Email addresses are not links');
assert.ok(analyzeLinkSafety('Vào http://example.com').reasons.some((reason) => reason.includes('HTTPS')));
assert.ok(analyzeLinkSafety('Đăng nhập https://example.com/login').suspicious);
assert.ok(analyzeLinkSafety('Mở https://bit.ly/abc').suspicious);
assert.ok(analyzeLinkSafety('Mở https://user:pass@example.com').suspicious);
assert.ok(analyzeLinkSafety('Mở https://xn--e1afmkfd.example').suspicious);
assert.ok(analyzeLinkSafety('javascript:alert(1)').suspicious);
assert.strictEqual(analyzeLinkSafety('Xem https://example.com.').hasLinks, true, 'Trailing punctuation must not be included in the URL');
console.log('✅ linkSafety.js passed');

console.log('--- 2. Testing moderation.js ---');
const mod = new Moderation();

// Test rate limit
const testUser = 'user-123';
for (let i = 0; i < 5; i++) {
  assert.strictEqual(mod.checkRateLimit(testUser), true);
}
// 6th message in same window should be blocked
assert.strictEqual(mod.checkRateLimit(testUser), false);

// Test report & block
mod.addReport('user-A', 'user-B', 'Spamming');
assert.strictEqual(mod.isBlocked('user-A', 'user-B'), true);
assert.strictEqual(mod.isBlocked('user-B', 'user-A'), true);
assert.strictEqual(mod.isBlocked('user-A', 'user-C'), false);
assert.strictEqual(mod.permanentBlocks.size, 0, 'Reports should create temporary blocks only');

const reportMod = new Moderation();
const reportedUsers = {
  reporter: { clientId: 'reporter-session-1', deviceId: 'reporter-device' },
  reported: { clientId: 'reported-session-1', deviceId: 'reported-device' },
};
reportMod.addReport(reportedUsers.reporter, reportedUsers.reported, 'Harassment');
reportMod.clearClient(reportedUsers.reporter.clientId);
assert.strictEqual(
  reportMod.isBlocked(
    { clientId: 'reporter-session-2', deviceId: reportedUsers.reporter.deviceId },
    { clientId: 'reported-session-2', deviceId: reportedUsers.reported.deviceId },
  ),
  true,
  'Report blocks should remain effective across reconnects for five minutes'
);
assert.strictEqual(
  reportMod.isBlocked(
    { clientId: 'reporter-session-2', deviceId: reportedUsers.reporter.deviceId },
    { clientId: 'other-session', deviceId: 'other-device' },
  ),
  false,
  'A report block must only apply to the reported pair'
);
const reportExpiry = reportMod.blockMap.get('reporter-device').get('reported-device');
reportMod.blockMap.get('reporter-device').set('reported-device', Date.now() - 1);
reportMod.blockMap.get('reported-device').set('reporter-device', Date.now() - 1);
assert.strictEqual(
  reportMod.isBlocked(
    { clientId: 'reporter-session-2', deviceId: reportedUsers.reporter.deviceId },
    { clientId: 'reported-session-2', deviceId: reportedUsers.reported.deviceId },
  ),
  false,
  'Report blocks must stop applying after expiry'
);
assert.ok(reportExpiry > Date.now(), 'Report block should initially expire in the future');

// Test report size limit
for (let i = 0; i < 1100; i++) {
  mod.addReport(`user-${i}`, `user-${i+1}`, `Reason ${i}`);
}
assert.strictEqual(mod.reports.length <= 1000, true, 'Reports must be capped at 1000');

console.log('✅ moderation.js passed');

console.log('--- 3. Testing roomManager.js ---');
const roomMgr = new RoomManager();
const roomId = roomMgr.createRoom('client-1', 'client-2');
assert.ok(roomId);
assert.strictEqual(roomMgr.getPartnerId('client-1'), 'client-2');
assert.strictEqual(roomMgr.getPartnerId('client-2'), 'client-1');

const removed = roomMgr.removeClient('client-1');
assert.strictEqual(removed.partnerId, 'client-2');
assert.strictEqual(roomMgr.getPartnerId('client-1'), null);
assert.strictEqual(roomMgr.getPartnerId('client-2'), null);

console.log('✅ roomManager.js passed');

console.log('--- 4. Testing matchmaker.js & isBlocked integration ---');
let matchedPairs = [];
const matchmaker = new Matchmaker({
  onMatch: (e1, e2, common) => {
    matchedPairs.push({ e1, e2, common });
  },
  isBlocked: (id1, id2) => mod.isBlocked(id1, id2),
});

// Enqueue user-A and user-B (they are blocked from above test)
matchmaker.enqueue('user-A', 'Alice', ['game']);
matchmaker.enqueue('user-B', 'Bob', ['game']);

// They should NOT be matched because they are blocked!
assert.strictEqual(matchedPairs.length, 0, 'Blocked users must not be matched');

// Enqueue user-C who is not blocked
matchmaker.enqueue('user-C', 'Charlie', ['game']);
// Now user-C should match with user-A!
assert.strictEqual(matchedPairs.length, 1, 'Non-blocked users should be matched');
assert.strictEqual(matchedPairs[0].common.includes('game'), true);

matchmaker.destroy();
console.log('✅ matchmaker.js passed');

console.log('--- 5. Testing contentFilter.js ---');
const { checkContent, VIOLATION_CATEGORIES } = require('../backend/contentFilter');

// Normal civil messages
assert.strictEqual(checkContent('Chào bạn, hôm nay thế nào?').ok, true);
assert.strictEqual(checkContent('Mình thích lập trình nodejs và chơi game').ok, true);
assert.strictEqual(checkContent('Thời tiết hôm nay đẹp thật đấy!').ok, true);

// Profanity / Insults
const vulgar1 = checkContent('địt mẹ mày');
assert.strictEqual(vulgar1.ok, false);
assert.ok(vulgar1.reason);

// Evasion with special characters/dots
const vulgarEvasion = checkContent('đ.ị.t con m.ẹ');
assert.strictEqual(vulgarEvasion.ok, false, 'Obfuscated vulgar words must be caught');

const vulgarSpaces = checkContent('c ặ c l ồ n');
assert.strictEqual(vulgarSpaces.ok, false, 'Spaced vulgar words must be caught');

// Sexual / 18+ content
const sex1 = checkContent('chat sex show cam ko em');
assert.strictEqual(sex1.ok, false);

const sex2 = checkContent('show hàng lộ vú show bím');
assert.strictEqual(sex2.ok, false);

// Drugs / Narcotics (Chất ma túy, chất kích thích cấm)
const drug1 = checkContent('bán cần sa cỏ mỹ uy tín');
assert.strictEqual(drug1.ok, false, 'Chất cấm cần sa phải bị chặn');
assert.strictEqual(drug1.category, VIOLATION_CATEGORIES.DRUGS_NARCOTICS);

const drug2 = checkContent('rủ nhau đi bay lắc hút ke cắn kẹo');
assert.strictEqual(drug2.ok, false, 'Bay lắc ke kẹo phải bị chặn');

const drug3 = checkContent('bán pod chill bóng cười phê pha');
assert.strictEqual(drug3.ok, false, 'Pod chill bóng cười phải bị chặn');

// Insult / Hate Speech / Discrimination (Xúc phạm nhân phẩm, miệt thị vùng miền)
const insult1 = checkContent('đồ con bắc kỳ chó bẩn thỉu');
assert.strictEqual(insult1.ok, false, 'Xúc phạm vùng miền phải bị chặn');
assert.strictEqual(insult1.category, VIOLATION_CATEGORIES.INSULT_HATE);

const insult2 = checkContent('mày ngu như súc vật óc chó');
assert.strictEqual(insult2.ok, false, 'Nhục mạ súc vật óc chó phải bị chặn');

// Gambling / Fraud (Cờ bạc trái phép, lừa đảo)
const gamble1 = checkContent('kèo bóng đá tài xỉu ku casino nạp rút');
assert.strictEqual(gamble1.ok, false, 'Cờ bạc tài xỉu casino phải bị chặn');
assert.strictEqual(gamble1.category, VIOLATION_CATEGORIES.GAMBLING_FRAUD);

// Violence / Threat (Đe dọa bạo lực, giết người)
const threat1 = checkContent('tao sẽ chém chết cả nhà mày');
assert.strictEqual(threat1.ok, false, 'Đe dọa bạo lực chém giết phải bị chặn');
assert.strictEqual(threat1.category, VIOLATION_CATEGORIES.VIOLENCE_THREAT);

console.log('✅ contentFilter.js passed (including drugs, hate speech, gambling, violence)');

console.log('--- 6. Testing icebreakers.js ---');
const { getRandomIcebreaker, ICEBREAKER_QUESTIONS } = require('../backend/icebreakers');

const ice = getRandomIcebreaker();
assert.ok(ice.category);
assert.ok(ice.question);
assert.strictEqual(typeof ice.question, 'string');
assert.ok(ICEBREAKER_QUESTIONS.length >= 20);

console.log('✅ icebreakers.js passed');

console.log('--- 7. Testing moderation.js (Ban & Anti-Skip Cooldown) ---');
// Ban by ID and IP
mod.ban('cheater-1', '10.0.0.1', 'Nội dung đen');
assert.strictEqual(mod.isBanned('cheater-1', '192.168.1.1').banned, true, 'Should be banned by clientId');
assert.strictEqual(mod.isBanned('cheater-other-client', '10.0.0.1').banned, true, 'Should be banned by IP');
assert.strictEqual(mod.isBanned('innocent-client', '192.168.1.2').banned, false);

// Anti-skip spam
const skipSpammer = 'skip-bot';
for (let i = 0; i < 5; i++) {
  assert.strictEqual(mod.checkSkipLimit(skipSpammer).allowed, true);
}
// 6th skip within 30s should be blocked
const skipBlocked = mod.checkSkipLimit(skipSpammer);
assert.strictEqual(skipBlocked.allowed, false);
assert.ok(skipBlocked.remainingSec > 0);

console.log('✅ moderation ban & anti-skip passed');

console.log('--- 8. Testing roomManager.js Minigame (Caro 10x10+) ---');
const gameRoomMgr = new RoomManager();
const gRoomId = gameRoomMgr.createRoom('player-X', 'player-O');

// Init game
const initialGame = gameRoomMgr.initGame(gRoomId, 'player-X', 'player-O', 10);
assert.strictEqual(initialGame.status, 'playing');
assert.strictEqual(initialGame.size, 10);
assert.strictEqual(initialGame.winLength, 5);
assert.strictEqual(initialGame.xPlayer, 'player-X');
assert.strictEqual(initialGame.oPlayer, 'player-O');
assert.strictEqual(initialGame.turn, 'player-X');

// Move 1: player-X -> cell 0
const res1 = gameRoomMgr.makeGameMove(gRoomId, 'player-X', 0);
assert.strictEqual(res1.ok, true);
assert.strictEqual(res1.game.board[0], 'X');
assert.strictEqual(res1.game.turn, 'player-O');

// Move 2: Sai lượt (player-X cố đánh tiếp) -> trả về ok: false
const errMove = gameRoomMgr.makeGameMove(gRoomId, 'player-X', 1);
assert.strictEqual(errMove.ok, false);
assert.ok(errMove.error);

// Move 2: player-O -> cell 10
const res2 = gameRoomMgr.makeGameMove(gRoomId, 'player-O', 10);
assert.strictEqual(res2.ok, true);
assert.strictEqual(res2.game.board[10], 'O');
assert.strictEqual(res2.game.turn, 'player-X');

// Complete a five-in-a-row while player-O makes non-blocking moves.
gameRoomMgr.makeGameMove(gRoomId, 'player-X', 1);
gameRoomMgr.makeGameMove(gRoomId, 'player-O', 11);
gameRoomMgr.makeGameMove(gRoomId, 'player-X', 2);
gameRoomMgr.makeGameMove(gRoomId, 'player-O', 12);
gameRoomMgr.makeGameMove(gRoomId, 'player-X', 3);
gameRoomMgr.makeGameMove(gRoomId, 'player-O', 13);
const winRes = gameRoomMgr.makeGameMove(gRoomId, 'player-X', 4);
assert.strictEqual(winRes.ok, true);
assert.strictEqual(winRes.game.status, 'ended');
assert.strictEqual(winRes.game.winner, 'X');
assert.deepStrictEqual(winRes.game.winningLine, [0, 1, 2, 3, 4]);

// Reset game
const resetGame = gameRoomMgr.resetGame(gRoomId);
assert.strictEqual(resetGame.status, 'playing');
assert.strictEqual(resetGame.board.every((c) => c === null), true);
const largerResetGame = gameRoomMgr.resetGame(gRoomId, 20);
assert.strictEqual(largerResetGame.size, 20);
assert.strictEqual(largerResetGame.winLength, 5);
assert.strictEqual(largerResetGame.board.length, 400);

console.log('✅ roomManager.js Minigame passed');

console.log('--- 9. Testing matchmaker.js Mood Matching ---');
let moodMatched = [];
const moodMatchmaker = new Matchmaker({
  onMatch: (e1, e2, common) => {
    moodMatched.push({ e1, e2, common });
  },
  isBlocked: () => false,
});

// Enqueue 3 users:
// User 1: mood 'tam_su'
// User 2: mood 'vui_ve'
// User 3: mood 'tam_su' (Cùng mood với User 1)
moodMatchmaker.enqueue('user-1', 'U1', [], 'tam_su');
moodMatchmaker.enqueue('user-2', 'U2', [], 'vui_ve');
moodMatchmaker.enqueue('user-3', 'U3', [], 'tam_su');

// User 3 should match with User 1 due to +2 mood bonus
assert.strictEqual(moodMatched.length, 1);
const pair = [moodMatched[0].e1.clientId, moodMatched[0].e2.clientId];
assert.ok(pair.includes('user-1') && pair.includes('user-3'), 'Users with matching mood must be prioritized');

moodMatchmaker.destroy();
console.log('✅ matchmaker.js Mood Matching passed');

console.log('--- 9a. Testing FIFO tie-break and relaxed matching ---');
const fifoPairs = [];
const fifoTieMatchmaker = new Matchmaker({
  onMatch: (e1, e2) => fifoPairs.push([e1.clientId, e2.clientId]),
  isBlocked: () => false,
});
fifoTieMatchmaker.enqueue('tie-a', 'A', ['music']);
fifoTieMatchmaker.enqueue('tie-b', 'B', ['books']);
fifoTieMatchmaker.enqueue('tie-c', 'C', ['music', 'books']);
assert.deepStrictEqual(fifoPairs[0], ['tie-c', 'tie-a'], 'Equal scores should select the earliest queued candidate');
fifoTieMatchmaker.destroy();

let holdInitialMatches = true;
const relaxedPairs = [];
const fifoTimeoutMatchmaker = new Matchmaker({
  onMatch: (e1, e2) => relaxedPairs.push([e1.clientId, e2.clientId]),
  isBlocked: () => holdInitialMatches,
});
fifoTimeoutMatchmaker.enqueue('wait-a', 'A', ['music']);
fifoTimeoutMatchmaker.enqueue('wait-b', 'B', ['books']);
fifoTimeoutMatchmaker.enqueue('wait-c', 'C', ['music']);
holdInitialMatches = false;
const oldTime = Date.now() - 15_000;
fifoTimeoutMatchmaker.waitingQueue.get('wait-a').joinedAt = oldTime;
fifoTimeoutMatchmaker.waitingQueue.get('wait-b').joinedAt = oldTime + 1_000;
fifoTimeoutMatchmaker.waitingQueue.get('wait-c').joinedAt = oldTime + 2_000;
fifoTimeoutMatchmaker._scanQueue();
assert.deepStrictEqual(relaxedPairs[0], ['wait-a', 'wait-b'], 'Timed-out users should be paired FIFO, even when a later candidate has more shared interests');
fifoTimeoutMatchmaker.destroy();
console.log('✅ matchmaker.js FIFO and timeout relaxation passed');

console.log('--- 10. Testing Permanent Block by Device ID & IP (severe violations) ---');
const permMod = new Moderation();

const userVictim = {
  clientId: 'victim-socket-1',
  deviceId: 'device-victim-uuid-aaa',
  clientIp: '118.70.1.1',
};

const userAbuser = {
  clientId: 'abuser-socket-1',
  deviceId: 'device-abuser-uuid-bbb',
  clientIp: '118.70.2.2',
};

// 1. Lúc đầu chưa vi phạm nghiêm trọng thì không bị block
assert.strictEqual(permMod.isBlocked(userVictim, userAbuser), false);

// 2. Kẻ vi phạm nghiêm trọng bị đưa vào danh sách chặn vĩnh viễn.
permMod.addPermanentBlock(userVictim, userAbuser);

// Ngay lập tức bị chặn vĩnh viễn (Never-Match) cho vi phạm nghiêm trọng
assert.strictEqual(permMod.isBlocked(userVictim, userAbuser), true, 'Severe violations must create a permanent pair block');

// 3. KẺ XẤU CỐ TÌNH F5 / RELOAD TAB:
// Socket clientId bị đổi thành `abuser-socket-2`, nhưng deviceId lưu ở localStorage vẫn là `device-abuser-uuid-bbb`
const userAbuserReloaded = {
  clientId: 'abuser-socket-2', // ID mới hoàn toàn
  deviceId: 'device-abuser-uuid-bbb', // Device ID giữ nguyên
  clientIp: '118.70.2.2',
};

assert.strictEqual(
  permMod.isBlocked(userVictim, userAbuserReloaded),
  true,
  'Kẻ xấu dù F5 reload sinh socket clientId mới vẫn phải bị chặn vĩnh viễn nhờ Device ID!'
);

// 4. Kiểm tra Matchmaker từ chối ghép cặp vĩnh viễn
let permMatched = [];
const permMatchmaker = new Matchmaker({
  onMatch: (e1, e2) => permMatched.push([e1.clientId, e2.clientId]),
  isBlocked: (e1, e2) => permMod.isBlocked(e1, e2),
});

permMatchmaker.enqueue(userVictim.clientId, 'Alice', ['game'], 'ngau_nhien', userVictim.clientIp, userVictim.deviceId);
permMatchmaker.enqueue(userAbuserReloaded.clientId, 'Kẻ Xấu Đổi Tên', ['game'], 'ngau_nhien', userAbuserReloaded.clientIp, userAbuserReloaded.deviceId);

assert.strictEqual(permMatched.length, 0, 'Matchmaker tuyệt đối không được ghép cặp nạn nhân với kẻ xấu!');

// Thêm người dùng C vô tội vào hàng đợi
const userInnocent = {
  clientId: 'innocent-socket-1',
  deviceId: 'device-innocent-uuid-ccc',
  clientIp: '118.70.3.3',
};
permMatchmaker.enqueue(userInnocent.clientId, 'Charlie', ['game'], 'ngau_nhien', userInnocent.clientIp, userInnocent.deviceId);

assert.strictEqual(permMatched.length, 1, 'Người vô tội được ghép cặp bình thường');
assert.strictEqual(
  permMatched[0].includes('victim-socket-1') && permMatched[0].includes('abuser-socket-2'),
  false,
  'Kẻ xấu tính TUYỆT ĐỐI KHÔNG BAO GIỜ được ghép cặp với nạn nhân!'
);

permMatchmaker.destroy();
console.log('✅ Permanent Block passed (Chặn vĩnh viễn sau vi phạm nghiêm trọng)');

console.log('--- 11. Testing companionBot.js & Solo Room Integration ---');
const { CompanionBot } = require('../backend/companionBot');

let botMessages = [];
const mockSend = (targetId, msgStr) => {
  botMessages.push({ targetId, msg: JSON.parse(msgStr) });
};

const soloUser = 'solo-user-123';
const bot = new CompanionBot(soloUser, 'Bảo An', 'chan_nan', ['sách', 'âm nhạc'], mockSend);

// Test partner info
const partnerInfo = bot.getPartnerInfo();
assert.strictEqual(partnerInfo.isBot, true, 'Partner must have isBot = true');
assert.ok(partnerInfo.nickname.includes('Lumi'));
assert.strictEqual(typeof partnerInfo.mood, 'string');

// Test AI Move: thắng ngay với bốn quân liên tiếp trên bàn 15x15.
const winBoard = Array(225).fill(null);
winBoard[0] = 'O';
winBoard[1] = 'O';
winBoard[2] = 'O';
winBoard[3] = 'O';
const winMove = bot.computeMove(winBoard, 'O', 'X');
assert.strictEqual(winMove, 4, 'Bot must complete five in a row');

// Test AI Move: chặn người chơi khi họ có bốn quân liên tiếp.
const blockBoard = Array(225).fill(null);
blockBoard[0] = 'X';
blockBoard[1] = 'X';
blockBoard[2] = 'X';
blockBoard[3] = 'X';
const blockMove = bot.computeMove(blockBoard, 'O', 'X');
assert.strictEqual(blockMove, 4, 'Bot must block player at index 4');

// Test AI Move: chiếm ô trung tâm bàn cờ 15x15.
const emptyBoard = Array(225).fill(null);
const centerMove = bot.computeMove(emptyBoard, 'O', 'X');
assert.strictEqual(centerMove, 112, 'Bot must prioritize the center cell on empty board');

// Test RoomManager integration with Bot
const soloRoomMgr = new RoomManager();
const soloRoomId = soloRoomMgr.createRoom(soloUser, bot.botClientId, true, bot);
assert.ok(soloRoomId);
assert.strictEqual(soloRoomMgr.isBotRoom(soloUser), true, 'Room must be recognized as Bot room');
assert.strictEqual(soloRoomMgr.getBot(soloUser), bot, 'getBot must return bot instance');

// Dọn phòng
soloRoomMgr.removeClient(soloUser);
assert.strictEqual(soloRoomMgr.isBotRoom(soloUser), false, 'Room must be removed cleanly');
bot.destroy();

console.log('✅ companionBot.js & Solo Room passed');

console.log('--- 12. Testing Caro 20x20 Move Validation & Same Device Dev Mode ---');
// Test GAME_MOVE validation up to 399
assert.strictEqual(validatePayload(CLIENT_TYPES.GAME_MOVE, { index: 0 }).ok, true);
assert.strictEqual(validatePayload(CLIENT_TYPES.GAME_MOVE, { index: 55 }).ok, true, 'Index 55 on 10x10 board must be valid');
assert.strictEqual(validatePayload(CLIENT_TYPES.GAME_MOVE, { index: 399 }).ok, true, 'Index 399 on 20x20 board must be valid');
assert.strictEqual(validatePayload(CLIENT_TYPES.GAME_MOVE, { index: 400 }).ok, false, 'Index >= 400 must be invalid');
assert.strictEqual(validatePayload(CLIENT_TYPES.GAME_MOVE, { index: -1 }).ok, false, 'Negative index must be invalid');
assert.deepStrictEqual(validatePayload(CLIENT_TYPES.GAME_INVITE, { size: 15 }).sanitized, { size: 15 });
assert.deepStrictEqual(validatePayload(CLIENT_TYPES.GAME_ACCEPT, { size: 20 }).sanitized, { size: 20 });
assert.strictEqual(validatePayload(CLIENT_TYPES.GAME_RESET, { size: 8 }).ok, false, 'Boards smaller than 10x10 must not be supported');

// Test Same-Device matching in dev mode
const devMod = new Moderation();
assert.strictEqual(
  devMod.isBlocked({ clientId: 'u1', deviceId: 'dev-shared' }, { clientId: 'u2', deviceId: 'dev-shared' }),
  false,
  'In dev mode, different clients with same deviceId must be allowed to match for easy local testing'
);

console.log('✅ Caro 20x20 & Dev Mode tests passed');

(async () => {
  console.log('--- Testing Azure Blob attachment validation and upload tickets ---');
  assert.strictEqual(getFilePolicy('photo.PNG', 1024).category, 'image');
  assert.strictEqual(getFilePolicy('movie.webm', MAX_VIDEO_BYTES).category, 'video');
  assert.throws(() => getFilePolicy('program.exe', 100), AttachmentError);
  assert.throws(() => getFilePolicy('report.pdf', MAX_FILE_BYTES + 1), AttachmentError);
  assert.throws(() => getFilePolicy('movie.mp4', MAX_VIDEO_BYTES + 1), AttachmentError);
  assert.strictEqual(normalizeFileName('C:\\fakepath\\report.pdf'), 'report.pdf');
  assert.strictEqual(hasExpectedSignature('application/pdf', Buffer.from('%PDF-1.7')), true);
  assert.strictEqual(hasExpectedSignature('image/png', Buffer.from('not a png')), false);

  const disabledAttachments = createAttachmentStorage({ accountName: '' });
  assert.strictEqual(disabledAttachments.enabled, false);
  assert.throws(
    () => disabledAttachments.issueUploadTicket('sender', 'receiver', 'photo.png', 100),
    (error) => error instanceof AttachmentError && error.statusCode === 503,
  );
  assert.throws(
    () => createAttachmentStorage({ accountName: 'testaccount', tokenSecret: '' }),
    /ATTACHMENT_TOKEN_SECRET must contain at least 32 bytes/u,
  );

  let uploadedBytes;
  let uploadHeaders;
  let malwareScanResult;
  let malwareTagReads = 0;
  let delegationKeyRequests = 0;
  const fakeBlob = {
    url: 'https://testaccount.blob.core.windows.net/chat-attachments/chat/test',
    async uploadStream(stream, blockSize, concurrency, options) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      uploadedBytes = Buffer.concat(chunks);
      uploadHeaders = options;
    },
    async getProperties() {
      return { contentLength: uploadedBytes.length, contentType: 'image/png' };
    },
    async getTags() {
      malwareTagReads += 1;
      if (!malwareScanResult) return { blobTagSet: [] };
      return {
        blobTagSet: [{ key: 'Malware Scanning scan result', value: malwareScanResult }],
      };
    },
  };
  const fakeServiceClient = {
    getContainerClient: () => ({ getBlockBlobClient: () => fakeBlob }),
    async getUserDelegationKey() {
      delegationKeyRequests += 1;
      return {
        signedObjectId: '00000000-0000-4000-8000-000000000001',
        signedTenantId: '00000000-0000-4000-8000-000000000002',
        signedStartsOn: new Date(Date.now() - 60_000),
        signedExpiresOn: new Date(Date.now() + 24 * 60 * 60 * 1000),
        signedService: 'b',
        signedVersion: '2020-02-10',
        value: Buffer.alloc(32, 1).toString('base64'),
      };
    },
  };
  const attachmentStorage = createAttachmentStorage({
    accountName: 'testaccount',
    containerName: 'chat-attachments',
    tokenSecret: 'test-upload-secret-0123456789-abcdefgh',
    blobServiceClient: fakeServiceClient,
    sleep: async () => {
      malwareScanResult = 'No threats found';
    },
  });
  const ticket = attachmentStorage.issueUploadTicket('sender', 'receiver', 'photo.png', 8);
  const ticketClaims = attachmentStorage.validateTicket(ticket.ticket, ticket.uploadId);
  assert.strictEqual(ticketClaims.partnerId, 'receiver');
  assert.throws(
    () => attachmentStorage.validateTicket(`${ticket.ticket}x`, ticket.uploadId),
    AttachmentError,
  );

  const { Readable } = require('stream');
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const uploadRequest = Readable.from([...pngSignature].map((byte) => Buffer.from([byte])));
  uploadRequest.headers = { 'content-length': '8', 'content-type': 'image/png' };
  await attachmentStorage.upload(ticket.uploadId, ticket.ticket, uploadRequest);
  assert.deepStrictEqual(uploadedBytes, pngSignature, 'The backend should stream the verified bytes to Blob Storage');
  assert.deepStrictEqual(uploadHeaders.conditions, { ifNoneMatch: '*' }, 'Upload tickets must not overwrite an existing blob');
  assert.ok(uploadHeaders.blobHTTPHeaders.blobContentDisposition.startsWith('inline;'));
  malwareScanResult = '';
  const completedAttachment = await attachmentStorage.completeUpload('sender', ticket.ticket);
  const downloadUrl = new URL(completedAttachment.url);
  assert.strictEqual(downloadUrl.protocol, 'https:');
  assert.strictEqual(downloadUrl.searchParams.get('sp'), 'r', 'Download SAS must be read-only');
  assert.strictEqual(downloadUrl.searchParams.get('sr'), 'b', 'Download SAS must be scoped to one blob');
  assert.strictEqual(Object.hasOwn(completedAttachment, 'ownerClientId'), false);
  assert.strictEqual(Object.hasOwn(completedAttachment, 'partnerClientId'), false);
  assert.strictEqual(malwareTagReads, 2, 'The server must wait until Defender reports a clean scan before issuing a SAS URL');
  assert.strictEqual(delegationKeyRequests, 1);
  malwareScanResult = 'Malicious';
  const maliciousTicket = attachmentStorage.issueUploadTicket('sender', 'receiver', 'malware.png', 8);
  await assert.rejects(
    attachmentStorage.completeUpload('sender', maliciousTicket.ticket),
    (error) => error instanceof AttachmentError && error.statusCode === 422,
    'A malicious scan result must never receive a download URL',
  );
  for (const result of ['Not scanned', 'Error']) {
    malwareScanResult = result;
    const unscannedTicket = attachmentStorage.issueUploadTicket('sender', 'receiver', 'unscanned.png', 8);
    await assert.rejects(
      attachmentStorage.completeUpload('sender', unscannedTicket.ticket),
      (error) => error instanceof AttachmentError && error.statusCode === 503,
      `${result} scan results must never receive a download URL`,
    );
  }
  assert.strictEqual(delegationKeyRequests, 1, 'Rejected scan results must not request a download SAS');

  let timeoutClock = 1_000;
  const noScanBlob = {
    ...fakeBlob,
    async getTags() {
      return { blobTagSet: [] };
    },
  };
  const noScanServiceClient = {
    ...fakeServiceClient,
    getContainerClient: () => ({ getBlockBlobClient: () => noScanBlob }),
  };
  const timeoutStorage = createAttachmentStorage({
    accountName: 'testaccount',
    tokenSecret: 'test-upload-secret-0123456789-abcdefgh',
    blobServiceClient: noScanServiceClient,
    now: () => timeoutClock,
    malwareScanTimeoutMs: 5,
    malwareScanPollIntervalMs: 5,
    sleep: async (milliseconds) => {
      timeoutClock += milliseconds;
    },
  });
  const timeoutTicket = timeoutStorage.issueUploadTicket('sender', 'receiver', 'pending.png', 8);
  await assert.rejects(
    timeoutStorage.completeUpload('sender', timeoutTicket.ticket),
    (error) => error instanceof AttachmentError && error.statusCode === 503,
    'A scan timeout must fail closed instead of returning a download URL',
  );
  assert.strictEqual(delegationKeyRequests, 1, 'A scan timeout must not request a download SAS');
  console.log('✅ Azure Blob attachment validation and upload tickets passed');

  console.log('--- Testing Google Web Risk URL checker ---');
  const { createWebRiskChecker } = require('../backend/webRisk');
  const disabledChecker = createWebRiskChecker({
    apiKey: '',
    fetchImpl: () => assert.fail('Web Risk must not be called without an API key'),
  });
  assert.strictEqual((await disabledChecker('https://example.com')).status, 'disabled');
  const tooManyUrls = Array.from({ length: 6 }, (_, index) => `https://example${index}.com`).join(' ');
  const limitedChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: () => assert.fail('Over-limit URL messages must not partially scan and pass'),
  });
  assert.strictEqual((await limitedChecker(tooManyUrls)).status, 'limit_exceeded');

  let fetchCount = 0;
  let requestUrl;
  const cleanChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      fetchCount++;
      requestUrl = url;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.strictEqual((await cleanChecker('See https://example.com')).status, 'clean');
  assert.strictEqual((await cleanChecker('Again https://example.com')).status, 'clean');
  assert.strictEqual(fetchCount, 1, 'Clean URL results should be cached');
  assert.strictEqual(requestUrl.searchParams.get('uri'), 'https://example.com');
  assert.ok(requestUrl.searchParams.getAll('threatTypes').includes('SOCIAL_ENGINEERING'));

  const threatChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ threat: { threatTypes: ['SOCIAL_ENGINEERING'] } }),
    }),
  });
  const threatResult = await threatChecker('Visit https://phishing.example');
  assert.strictEqual(threatResult.status, 'threat');
  assert.deepStrictEqual(threatResult.threatTypes, ['SOCIAL_ENGINEERING']);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const unavailableChecker = createWebRiskChecker({
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.strictEqual((await unavailableChecker('https://example.net')).status, 'unavailable');
  } finally {
    console.error = originalConsoleError;
  }
  console.log('✅ Google Web Risk URL checker passed');

  console.log('--- 13. Testing Redis-backed Matchmaker adapter ---');
  const redisQueue = {
    enabled: true,
    entries: [],
    enqueueMatchEntry(entry) {
      this.entries.push(entry);
      return Promise.resolve();
    },
    dequeueMatchEntry(clientId) {
      this.entries = this.entries.filter((entry) => entry.clientId !== clientId);
      return Promise.resolve();
    },
    scanMatchQueue() {
      return Promise.resolve(0);
    },
  };
  const redisMatchmaker = new Matchmaker({
    onMatch: () => assert.fail('Redis adapter must not use the local matching callback'),
    redisManager: redisQueue,
  });
  try {
    await redisMatchmaker.enqueue('redis-user-1', 'Redis Alice', ['game'], 'tam_su');
    assert.strictEqual(redisMatchmaker.waitingQueue.size, 0, 'Redis mode must not retain an instance-local queue');
    assert.strictEqual(redisQueue.entries.length, 1);
    assert.strictEqual(redisQueue.entries[0].interests[0], 'game');
    await redisMatchmaker.dequeue('redis-user-1');
    assert.strictEqual(redisQueue.entries.length, 0, 'Redis mode must remove cancelled users from the shared queue');
  } finally {
    redisMatchmaker.destroy();
  }
  console.log('✅ Redis-backed Matchmaker adapter passed');
  console.log('\n🎉 ALL UNIT TESTS PASSED SUCCESSFULLY! 🎉\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
