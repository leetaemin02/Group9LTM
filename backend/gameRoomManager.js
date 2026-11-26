/**
 * gameRoomManager.js – Quản lý Phòng Game Nhiều Người Ẩn Danh (2 – 10 người/phòng)
 *
 * Hỗ trợ 5 trò chơi hấp dẫn ngoài & kèm Caro:
 *   1. quiz_race    – ⚡ Đố Vui Tốc Độ (2–10 người)
 *   2. word_chain   – ⛓️ Nối Từ Thần Tốc (2–10 người)
 *   3. undercover   – 🕵️ Ai Là Gián Điệp? (3–10 người)
 *   4. mind_duel    – 🃏 Đấu Trí Tâm Lý (2–10 người)
 *   5. caro_arena   – ⚔️ Cờ Caro Khán Đài (2 người đấu, tối đa 10 người cổ vũ & luân phiên)
 *
 * Đặc điểm:
 *   - Tối đa 10 người / phòng game (MAX_GAME_ROOM_PLAYERS = 10).
 *   - Hoàn toàn ẩn danh, chỉ hiển thị biệt danh + avatar.
 *   - Tự động đánh số thứ tự nếu trùng biệt danh (vd: "Cánh Cụt 1", "Cánh Cụt 2").
 *   - Tự động chuyển Host nếu chủ phòng rời đi; tự hủy phòng & dọn toàn bộ timer khi phòng trống.
 */

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { checkContent } = require('./contentFilter');
const {
  resolveRoomNickname,
  extractMentions,
  stripVietnameseTones,
} = require('./nicknameResolver');
const {
  QUIZ_QUESTIONS,
  UNDERCOVER_PAIRS,
  WORD_CHAIN_SEEDS,
} = require('./gameData');

// ─── Hằng số cấu hình ────────────────────────────────────────────────────────

const configuredMaxPlayers = Number(process.env.MAX_GAME_ROOM_PLAYERS);
const MAX_GAME_ROOM_PLAYERS = (
  Number.isSafeInteger(configuredMaxPlayers)
  && configuredMaxPlayers >= 2
  && configuredMaxPlayers <= 10
)
  ? configuredMaxPlayers
  : 10;

const MIN_GAME_ROOM_PLAYERS = 2;
const MAX_ROOM_NAME_LENGTH = 50;

const GAME_CATALOG = Object.freeze({
  quiz_race: {
    id: 'quiz_race',
    name: 'Đố Vui Tốc Độ',
    icon: '⚡',
    minPlayers: 2,
    maxPlayers: 10,
    description: '8 câu đố mẹo & kiến thức, trả lời càng nhanh điểm càng cao!',
  },
  word_chain: {
    id: 'word_chain',
    name: 'Nối Từ Thần Tốc',
    icon: '⛓️',
    minPlayers: 2,
    maxPlayers: 10,
    description: 'Nối từ 2 âm tiết theo lượt dưới áp lực đếm ngược 16 giây!',
  },
  undercover: {
    id: 'undercover',
    name: 'Ai Là Gián Điệp?',
    icon: '🕵️',
    minPlayers: 3,
    maxPlayers: 10,
    description: 'Mô tả từ bí mật và bỏ phiếu tìm ra kẻ gián điệp ẩn danh!',
  },
  mind_duel: {
    id: 'mind_duel',
    name: 'Đấu Trí Tâm Lý',
    icon: '🃏',
    minPlayers: 2,
    maxPlayers: 10,
    description: '6 vòng đấu bài kín (Tấn Công • Lá Chắn • Lừa Đòn • Tích Lũy) & cược điểm, vòng cuối x2 cực căng!',
  },
  caro_arena: {
    id: 'caro_arena',
    name: 'Cờ Caro Khán Đài',
    icon: '⚔️',
    minPlayers: 2,
    maxPlayers: 10,
    description: '2 người đấu bàn 15×15, tối đa 8 khán giả cổ vũ & luân phiên lên sàn!',
  },
});

const VALID_GAME_TYPES = Object.freeze(Object.keys(GAME_CATALOG));

const MIND_DUEL_CARDS = Object.freeze({
  attack: {
    id: 'attack',
    icon: '⚔️',
    name: 'Tấn Công',
    shortDesc: 'Phá Lừa Đòn & Cướp Tích Lũy • Thua Lá Chắn',
  },
  shield: {
    id: 'shield',
    icon: '🛡️',
    name: 'Lá Chắn',
    shortDesc: 'Phản đòn Tấn Công • Bị Lừa Đòn xuyên khiên',
  },
  bluff: {
    id: 'bluff',
    icon: '🎭',
    name: 'Lừa Đòn',
    shortDesc: 'Xuyên thủng Lá Chắn • Thua Tấn Công',
  },
  charge: {
    id: 'charge',
    icon: '💰',
    name: 'Tích Lũy',
    shortDesc: 'Gom thưởng lớn nếu né được Tấn Công',
  },
});

const VALID_MIND_DUEL_CARDS = Object.freeze(Object.keys(MIND_DUEL_CARDS));
const VALID_MIND_DUEL_STAKES = Object.freeze([10, 20, 30]);
const MIND_DUEL_START_SCORE = 100;
const MIND_DUEL_TOTAL_ROUNDS = 6;

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

// ─── Class GameRoomManager ───────────────────────────────────────────────────

class GameRoomManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPlayers=10]
   * @param {function} [opts.onBroadcast] - (roomId, serverEventType, payload, excludeClientId?) => void
   * @param {function} [opts.onSendTo] - (clientId, serverEventType, payload) => void
   * @param {object} [opts.timings] - Tùy chỉnh thời gian đếm ngược (hữu ích cho unit test)
   */
  constructor({
    maxPlayers = MAX_GAME_ROOM_PLAYERS,
    onBroadcast = () => {},
    onSendTo = () => {},
    timings = {},
  } = {}) {
    this.maxPlayers = Math.min(10, Math.max(2, maxPlayers));
    this.onBroadcast = onBroadcast;
    this.onSendTo = onSendTo;
    this.timings = {
      quizQuestionMs: timings.quizQuestionMs || 14_000,
      quizRevealMs: timings.quizRevealMs || 3_500,
      wordChainTurnMs: timings.wordChainTurnMs || 16_000,
      undercoverClueMs: timings.undercoverClueMs || 30_000,
      undercoverVoteMs: timings.undercoverVoteMs || 35_000,
      undercoverResultMs: timings.undercoverResultMs || 4_000,
      mindDuelChooseMs: timings.mindDuelChooseMs || 16_000,
      mindDuelRevealMs: timings.mindDuelRevealMs || 4_500,
      caroMoveMs: timings.caroMoveMs || 30_000,
    };

    /** @type {Map<string, object>} roomId -> GameRoom */
    this.rooms = new Map();
    /** @type {Map<string, string>} roomCode -> roomId */
    this.codeToRoomId = new Map();
    /** @type {Map<string, string>} clientId -> roomId */
    this.clientRoomMap = new Map();
    /** @type {Map<string, string>} contextKey ('chat:...' | 'group:...') -> roomId */
    this.contextToRoomId = new Map();
  }

  getRoomByContext(contextKey) {
    const roomId = this.contextToRoomId.get(contextKey);
    return roomId ? (this.rooms.get(roomId) || null) : null;
  }

  destroyRoomByContext(contextKey) {
    const roomId = this.contextToRoomId.get(contextKey);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    this.contextToRoomId.delete(contextKey);
    if (!room) return null;

    this._clearAllTimers(room);
    for (const cid of room.players.keys()) {
      this.clientRoomMap.delete(cid);
    }
    this.rooms.delete(roomId);
    this.codeToRoomId.delete(room.roomCode);
    return room;
  }

  getRoomId(clientId) {
    return this.clientRoomMap.get(clientId) || null;
  }

  isInGameRoom(clientId) {
    return this.clientRoomMap.has(clientId);
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getPlayer(roomId, clientId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.players.get(clientId) || null;
  }

  getRoomClientIds(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.players.keys()] : [];
  }

  extractRoomMentions(roomId, text) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return extractMentions(text, room.players.values());
  }

  // ─── Timer helpers ─────────────────────────────────────────────────────────

  _clearRoomTimer(room) {
    if (room && room._timer) {
      clearTimeout(room._timer);
      room._timer = null;
    }
  }

  _clearBotTimer(room) {
    if (room && room._botTimer) {
      clearTimeout(room._botTimer);
      room._botTimer = null;
    }
    if (room) {
      room._botScheduledKey = null;
    }
  }

  _clearAllTimers(room) {
    this._clearRoomTimer(room);
    this._clearBotTimer(room);
  }

  _setRoomTimer(room, delayMs, fn) {
    this._clearRoomTimer(room);
    room._timer = setTimeout(() => {
      room._timer = null;
      if (!this.rooms.has(room.roomId)) return;
      fn();
    }, delayMs);
  }

  // ─── Serialization (100% Ẩn danh – KHÔNG lộ IP, deviceId, từ bí mật) ───────

  _serializePlayer(player, hostId) {
    return {
      clientId: player.clientId,
      nickname: player.nickname,
      avatar: player.avatar || '🦊',
      score: player.score || 0,
      isHost: player.clientId === hostId,
      joinedAt: player.joinedAt,
    };
  }

  _serializePublicGameState(room) {
    const g = room.game;
    if (!g) {
      return {
        gameType: room.gameType,
        phase: 'lobby',
      };
    }

    switch (g.gameType) {
      case 'quiz_race': {
        const currentQ = g.questions[g.currentIndex] || null;
        return {
          gameType: 'quiz_race',
          phase: g.phase, // 'question' | 'reveal' | 'ended'
          matchId: g.matchId || null,
          questionToken: `${g.matchId || 'q'}:${g.currentIndex}`,
          currentIndex: g.currentIndex,
          totalQuestions: g.questions.length,
          endsAt: g.endsAt || null,
          question: currentQ ? {
            q: currentQ.q,
            options: currentQ.options,
            category: currentQ.category,
          } : null,
          answeredCount: [...room.players.keys()].filter((cid) => g.answers && g.answers.has(cid)).length,
          answeredIds: g.answers ? [...g.answers.keys()].filter((cid) => room.players.has(cid)) : [],
          correctIndex: g.phase === 'reveal' && currentQ ? currentQ.answer : null,
          roundResults: g.phase === 'reveal' ? (g.lastRoundResults || []) : [],
          podium: g.phase === 'ended' ? this._buildLeaderboard(room) : [],
        };
      }

      case 'word_chain': {
        return {
          gameType: 'word_chain',
          phase: g.phase, // 'playing' | 'ended'
          currentWord: g.currentWord,
          requiredStart: g.requiredStart,
          chain: g.chain.slice(-20),
          chainLength: g.chain.length,
          maxChainLength: g.maxChainLength,
          turnClientId: g.turnClientId,
          turnNickname: room.players.get(g.turnClientId)?.nickname || '',
          endsAt: g.endsAt || null,
          lives: Object.fromEntries(g.lives),
          eliminatedIds: [...g.eliminated],
          lastEvent: g.lastEvent || null,
          winnerName: g.winnerName || null,
          podium: g.phase === 'ended' ? this._buildLeaderboard(room) : [],
        };
      }

      case 'undercover': {
        const revealedClues = (g.phase !== 'clue')
          ? [...g.clues.entries()].map(([cid, clue]) => ({
            clientId: cid,
            nickname: room.players.get(cid)?.nickname || 'Ẩn danh',
            avatar: room.players.get(cid)?.avatar || '🦊',
            clue,
          }))
          : [];

        return {
          gameType: 'undercover',
          phase: g.phase, // 'clue' | 'vote' | 'round_result' | 'ended'
          round: g.round,
          spyCount: g.spyIds.size,
          aliveIds: [...g.aliveIds],
          eliminatedIds: [...g.eliminatedIds],
          submittedClueIds: [...g.clues.keys()],
          clues: revealedClues,
          votedIds: [...g.votes.keys()],
          endsAt: g.endsAt || null,
          lastElimination: g.lastElimination || null,
          winnerSide: g.phase === 'ended' ? g.winnerSide : null,
          revealSecret: g.phase === 'ended' ? {
            civilianWord: g.civilianWord,
            spyWord: g.spyWord,
            spies: [...g.spyIds].map((cid) => ({
              clientId: cid,
              nickname: g.playerNamesSnapshot.get(cid) || room.players.get(cid)?.nickname || 'Ẩn danh',
            })),
          } : null,
          podium: g.phase === 'ended' ? this._buildLeaderboard(room) : [],
        };
      }

      case 'mind_duel': {
        const lockedIds = g.choices
          ? [...g.choices.keys()].filter((cid) => room.players.has(cid))
          : [];
        return {
          gameType: 'mind_duel',
          phase: g.phase, // 'choose' | 'reveal' | 'ended'
          matchId: g.matchId || null,
          roundToken: `${g.matchId || 'md'}:${g.round}`,
          round: g.round,
          totalRounds: g.totalRounds,
          multiplier: g.round === g.totalRounds ? 2 : 1,
          isDoubleRound: g.round === g.totalRounds,
          endsAt: g.endsAt || null,
          lockedIds,
          lockedCount: lockedIds.length,
          roundResults: g.phase === 'reveal' ? (g.lastRoundResults || []) : [],
          roundSummary: g.phase === 'reveal' ? (g.lastRoundSummary || '') : '',
          history: (g.history || []).slice(-6),
          winnerName: g.winnerName || null,
          podium: g.phase === 'ended' ? this._buildLeaderboard(room) : [],
        };
      }

      case 'caro_arena': {
        return {
          gameType: 'caro_arena',
          phase: g.phase, // 'playing' | 'ended'
          size: g.size,
          winLength: g.winLength,
          board: g.board,
          xPlayer: g.xPlayer,
          xNickname: room.players.get(g.xPlayer)?.nickname || g.xNickname || 'X',
          oPlayer: g.oPlayer,
          oNickname: room.players.get(g.oPlayer)?.nickname || g.oNickname || 'O',
          turn: g.turn,
          endsAt: g.endsAt || null,
          lastMove: g.lastMove,
          winner: g.winner,
          winnerId: g.winnerId,
          winnerName: g.winnerName || null,
          winningLine: g.winningLine,
          spectatorCount: Math.max(0, room.players.size - 2),
          podium: g.phase === 'ended' ? this._buildLeaderboard(room) : [],
        };
      }

      default:
        return { gameType: room.gameType, phase: 'lobby' };
    }
  }

  _buildLeaderboard(room) {
    return [...room.players.values()]
      .map((p) => ({
        clientId: p.clientId,
        nickname: p.nickname,
        avatar: p.avatar || '🦊',
        score: p.score || 0,
        joinedAt: p.joinedAt || 0,
      }))
      .sort((a, b) => (b.score - a.score) || (a.joinedAt - b.joinedAt))
      .map(({ joinedAt, ...entry }) => entry);
  }

  buildRoomSnapshot(room) {
    const players = [...room.players.values()]
      .map((p) => this._serializePlayer(p, room.hostId))
      .sort((a, b) => a.joinedAt - b.joinedAt);

    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      name: room.name,
      gameType: room.gameType,
      gameInfo: GAME_CATALOG[room.gameType] || GAME_CATALOG.quiz_race,
      catalog: Object.values(GAME_CATALOG),
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      playerCount: players.length,
      players,
      status: room.status, // 'lobby' | 'playing'
      gameState: this._serializePublicGameState(room),
      createdAt: room.createdAt,
    };
  }

  buildRoomSummary(room) {
    const info = GAME_CATALOG[room.gameType] || GAME_CATALOG.quiz_race;
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      name: room.name,
      gameType: room.gameType,
      gameName: info.name,
      gameIcon: info.icon,
      minPlayers: info.minPlayers,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.size,
      status: room.status,
      createdAt: room.createdAt,
    };
  }

  _broadcastState(room, extra = {}) {
    this.onBroadcast(room.roomId, 'game_room_state', {
      roomId: room.roomId,
      roomCode: room.roomCode,
      name: room.name,
      contextType: room.contextType || 'game_room',
      contextKey: room.contextKey || null,
      isBotSession: Boolean(room.isBotSession),
      allowAnyPlayerControl: Boolean(room.allowAnyPlayerControl),
      maxPlayers: room.maxPlayers,
      playerCount: room.players.size,
      gameType: room.gameType,
      gameInfo: GAME_CATALOG[room.gameType],
      hostId: room.hostId,
      status: room.status,
      players: [...room.players.values()].map((p) => this._serializePlayer(p, room.hostId)),
      gameState: this._serializePublicGameState(room),
      ...extra,
    });
  }

  /**
   * Tạo bàn game nhúng trực tiếp vào phòng chat 1-1 (người thật hoặc Lumi AI) hoặc phòng Nhóm chat.
   */
  createEmbeddedSession(contextKey, hostUser, options = {}) {
    this.destroyRoomByContext(contextKey);

    if (hostUser && hostUser.clientId && this.clientRoomMap.has(hostUser.clientId)) {
      this.leaveRoom(hostUser.clientId);
    }

    const created = this.createRoom(hostUser, {
      gameType: options.gameType,
      maxPlayers: options.maxPlayers || this.maxPlayers,
      name: options.name,
    });
    const room = this.rooms.get(created.room.roomId);
    room.contextKey = contextKey;
    room.contextType = options.contextType || '1v1';
    room.isBotSession = Boolean(options.isBotSession);
    room.botClientId = options.botClientId || null;
    room.allowAnyPlayerControl = Boolean(options.allowAnyPlayerControl);
    this.contextToRoomId.set(contextKey, room.roomId);

    const initialPlayers = Array.isArray(options.initialPlayers) ? options.initialPlayers : [];
    for (const p of initialPlayers) {
      if (p && p.clientId && p.clientId !== hostUser.clientId) {
        if (this.clientRoomMap.has(p.clientId)) {
          this.leaveRoom(p.clientId);
        }
        this.joinRoom(p, { roomId: room.roomId });
      }
    }

    if (options.autoStart) {
      const startRes = this.startGame(hostUser.clientId);
      if (!startRes.ok) {
        this._broadcastState(room);
      }
    } else {
      this._broadcastState(room, {
        systemNotice: options.openNotice || null,
      });
    }

    return {
      ok: true,
      room: this.buildRoomSnapshot(room),
    };
  }

  broadcastRoomState(roomId, extra = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this._broadcastState(room, extra);
  }

  // ─── Quản lý vòng đời phòng (Create / Find / Join / Leave) ────────────────

  createRoom(user, options = {}) {
    const gameType = VALID_GAME_TYPES.includes(options.gameType) ? options.gameType : 'quiz_race';
    const requestedMax = Number(options.maxPlayers);
    const maxPlayers = (Number.isSafeInteger(requestedMax) && requestedMax >= 2 && requestedMax <= this.maxPlayers)
      ? requestedMax
      : this.maxPlayers;

    const info = GAME_CATALOG[gameType];
    const roomId = uuidv4();
    let roomCode = generateRoomCode();
    while (this.codeToRoomId.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    const customName = typeof options.name === 'string'
      ? options.name.trim().slice(0, MAX_ROOM_NAME_LENGTH)
      : '';
    const name = customName || `${info.icon} ${info.name} #${roomCode.slice(0, 4)}`;

    const nicknameCounters = new Map();
    const resolved = resolveRoomNickname([], user.nickname, nicknameCounters);
    const now = Date.now();
    const memberKey = user.deviceId || user.clientId;

    const player = {
      clientId: user.clientId,
      memberKey,
      baseNickname: resolved.baseNickname,
      nickname: resolved.displayName,
      nicknameNumber: resolved.nicknameNumber,
      avatar: user.avatar || '🦊',
      score: 0,
      joinedAt: now,
    };

    const room = {
      roomId,
      roomCode,
      name,
      gameType,
      maxPlayers,
      hostId: user.clientId,
      status: 'lobby',
      players: new Map([[user.clientId, player]]),
      nicknameCounters,
      kickedKeys: new Set(),
      caroQueue: [user.clientId],
      game: null,
      _timer: null,
      createdAt: now,
      lastActivityAt: now,
    };

    this.rooms.set(roomId, room);
    this.codeToRoomId.set(roomCode, roomId);
    this.clientRoomMap.set(user.clientId, roomId);

    console.log(`[GameRoom] +Room ${roomCode} (${name}, max=${maxPlayers}) by ${player.nickname}`);
    return {
      ok: true,
      created: true,
      room: this.buildRoomSnapshot(room),
      player: this._serializePlayer(player, room.hostId),
      renamedMembers: [],
    };
  }

  findOrCreateRoom(user, options = {}) {
    const requestedType = options.gameType || 'any';
    const memberKey = user.deviceId || user.clientId;
    const excludeRoomId = options.excludeRoomId || null;

    const candidates = [...this.rooms.values()].filter((r) => (
      r.roomId !== excludeRoomId
      && r.players.size > 0
      && r.players.size < r.maxPlayers
      && !r.kickedKeys.has(memberKey)
      && (requestedType === 'any' || r.gameType === requestedType)
    ));

    // Ưu tiên phòng đang chờ (lobby) còn chỗ và đông người hơn để nhanh đủ người chơi
    candidates.sort((a, b) => {
      const aLobby = a.status === 'lobby' ? 0 : 1;
      const bLobby = b.status === 'lobby' ? 0 : 1;
      if (aLobby !== bLobby) return aLobby - bLobby;
      if (b.players.size !== a.players.size) return b.players.size - a.players.size;
      return a.createdAt - b.createdAt;
    });

    if (candidates.length > 0) {
      const joinRes = this.joinRoom(user, { roomId: candidates[0].roomId });
      if (joinRes.ok) return { ...joinRes, created: false };
    }

    const fallbackType = VALID_GAME_TYPES.includes(requestedType) ? requestedType : 'quiz_race';
    return this.createRoom(user, { gameType: fallbackType, maxPlayers: options.maxPlayers });
  }

  joinRoom(user, { roomId = null, roomCode = null } = {}) {
    let resolvedId = roomId;
    if (!resolvedId && typeof roomCode === 'string') {
      resolvedId = this.codeToRoomId.get(roomCode.trim().toUpperCase()) || null;
    }
    const room = resolvedId ? this.rooms.get(resolvedId) : null;
    if (!room) {
      return { ok: false, code: 'GAME_ROOM_NOT_FOUND', error: 'Không tìm thấy phòng game này hoặc phòng đã đóng.' };
    }

    const memberKey = user.deviceId || user.clientId;
    if (room.kickedKeys.has(memberKey)) {
      return { ok: false, code: 'GAME_ROOM_KICKED', error: 'Bạn đã bị buộc rời khỏi phòng game này trước đó.' };
    }
    if (room.players.has(user.clientId)) {
      return { ok: false, code: 'ALREADY_IN_GAME_ROOM', error: 'Bạn đã ở trong phòng game này rồi.' };
    }
    if (room.players.size >= room.maxPlayers) {
      return { ok: false, code: 'GAME_ROOM_FULL', error: `Phòng game đã đủ tối đa ${room.maxPlayers} người chơi.` };
    }

    const resolved = resolveRoomNickname(room.players.values(), user.nickname, room.nicknameCounters);
    const now = Date.now();
    const player = {
      clientId: user.clientId,
      memberKey,
      baseNickname: resolved.baseNickname,
      nickname: resolved.displayName,
      nicknameNumber: resolved.nicknameNumber,
      avatar: user.avatar || '🦊',
      score: 0,
      joinedAt: now,
    };

    room.players.set(user.clientId, player);
    room.caroQueue.push(user.clientId);
    room.lastActivityAt = now;
    this.clientRoomMap.set(user.clientId, room.roomId);

    return {
      ok: true,
      room: this.buildRoomSnapshot(room),
      player: this._serializePlayer(player, room.hostId),
      renamedMembers: resolved.renamedMembers,
    };
  }

  leaveRoom(clientId, { kicked = false, reason = null } = {}) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return null;
    this.clientRoomMap.delete(clientId);

    const room = this.rooms.get(roomId);
    if (!room) return null;

    const player = room.players.get(clientId) || null;
    room.players.delete(clientId);
    room.caroQueue = room.caroQueue.filter((id) => id !== clientId);

    if (kicked && player) {
      room.kickedKeys.add(player.memberKey);
    }

    // Nếu không còn ai -> tự động hủy phòng & dọn timer
    if (room.players.size === 0) {
      this._clearAllTimers(room);
      this.rooms.delete(roomId);
      this.codeToRoomId.delete(room.roomCode);
      if (room.contextKey) this.contextToRoomId.delete(room.contextKey);
      console.log(`[GameRoom] -Room ${room.roomCode} auto-destroyed (empty)`);
      return {
        roomId,
        roomCode: room.roomCode,
        player: player ? this._serializePlayer(player, room.hostId) : null,
        playerCount: 0,
        destroyed: true,
        hostId: null,
        kicked,
        reason,
      };
    }

    // Chuyển quyền chủ phòng nếu Host rời đi
    let hostChanged = false;
    if (room.hostId === clientId) {
      const nextHost = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = nextHost ? nextHost.clientId : null;
      hostChanged = true;
    }

    // Xử lý đang giữa ván khi có người rời phòng
    this._handlePlayerLeaveDuringGame(room, clientId);

    return {
      roomId,
      roomCode: room.roomCode,
      player: player ? this._serializePlayer(player, room.hostId) : null,
      playerCount: room.players.size,
      destroyed: false,
      hostId: room.hostId,
      hostChanged,
      hostNickname: room.players.get(room.hostId)?.nickname || '',
      kicked,
      reason,
    };
  }

  listRooms({ gameType = 'all' } = {}) {
    return [...this.rooms.values()]
      .filter((r) => r.players.size > 0)
      .filter((r) => (gameType === 'all' ? true : r.gameType === gameType))
      .map((r) => this.buildRoomSummary(r))
      .sort((a, b) => {
        const aFull = a.playerCount >= a.maxPlayers ? 1 : 0;
        const bFull = b.playerCount >= b.maxPlayers ? 1 : 0;
        if (aFull !== bFull) return aFull - bFull;
        if (b.playerCount !== a.playerCount) return b.playerCount - a.playerCount;
        return b.createdAt - a.createdAt;
      })
      .slice(0, 40);
  }

  // ─── Chọn game & Bắt đầu ván ───────────────────────────────────────────────

  selectGame(clientId, gameType) {
    const roomId = this.clientRoomMap.get(clientId);
    const room = roomId ? this.rooms.get(roomId) : null;
    if (!room) return { ok: false, error: 'Bạn chưa ở trong phòng game.' };
    if (!room.allowAnyPlayerControl && room.hostId !== clientId) {
      return { ok: false, error: 'Chỉ chủ phòng mới có thể đổi trò chơi.' };
    }
    if (!VALID_GAME_TYPES.includes(gameType)) return { ok: false, error: 'Trò chơi không hợp lệ.' };
    if (room.status === 'playing' && room.game && room.game.phase !== 'ended') {
      return { ok: false, error: 'Hãy kết thúc ván hiện tại trước khi đổi game.' };
    }

    this._clearAllTimers(room);
    if (room.gameType !== gameType) {
      for (const player of room.players.values()) {
        player.score = 0;
      }
    }
    room.gameType = gameType;
    room.status = 'lobby';
    room.game = null;
    room.lastActivityAt = Date.now();

    const info = GAME_CATALOG[gameType];
    const changerName = room.players.get(clientId)?.nickname || 'Chủ phòng';
    this._broadcastState(room, {
      systemNotice: `🎮 ${changerName} đã chọn trò chơi: ${info.icon} ${info.name}`,
    });
    return { ok: true };
  }

  startGame(clientId) {
    const roomId = this.clientRoomMap.get(clientId);
    const room = roomId ? this.rooms.get(roomId) : null;
    if (!room) return { ok: false, error: 'Bạn chưa ở trong phòng game.' };
    if (!room.allowAnyPlayerControl && room.hostId !== clientId) {
      return { ok: false, error: 'Chỉ chủ phòng mới có thể bắt đầu ván chơi.' };
    }

    const info = GAME_CATALOG[room.gameType];
    if (room.players.size < info.minPlayers) {
      return {
        ok: false,
        error: `Trò chơi "${info.name}" cần ít nhất ${info.minPlayers} người chơi (hiện có ${room.players.size}).`,
      };
    }

    this._clearAllTimers(room);
    // Đặt lại điểm về 0 cho mỗi ván đấu mới (trừ Cờ Caro Khán Đài giữ điểm chuỗi thắng trên khán đài)
    if (room.gameType !== 'caro_arena') {
      for (const player of room.players.values()) {
        player.score = 0;
      }
    }
    room.status = 'playing';
    room.lastActivityAt = Date.now();

    switch (room.gameType) {
      case 'quiz_race':
        this._startQuizRace(room);
        break;
      case 'word_chain':
        this._startWordChain(room);
        break;
      case 'undercover':
        this._startUndercover(room);
        break;
      case 'mind_duel':
        this._startMindDuel(room);
        break;
      case 'caro_arena':
        this._startCaroArena(room);
        break;
      default:
        return { ok: false, error: 'Trò chơi không được hỗ trợ.' };
    }

    return { ok: true };
  }

  // ─── Xử lý hành động trong game ────────────────────────────────────────────

  handleAction(clientId, payload = {}, meta = {}) {
    const roomId = this.clientRoomMap.get(clientId);
    const room = roomId ? this.rooms.get(roomId) : null;
    if (!room || !room.players.has(clientId)) {
      return { ok: false, error: 'Bạn chưa ở trong phòng game.' };
    }

    const action = payload.action;
    if (action === 'back_to_lobby') {
      if (!room.allowAnyPlayerControl && room.hostId !== clientId) {
        return { ok: false, error: 'Chỉ chủ phòng mới có thể quay về sảnh phòng game.' };
      }
      this._clearAllTimers(room);
      room.status = 'lobby';
      room.game = null;
      this._broadcastState(room, { systemNotice: '🔄 Đã quay lại chọn trò chơi.' });
      return { ok: true };
    }

    if (action === 'play_again') {
      return this.startGame(clientId);
    }

    if (!room.game) {
      return { ok: false, error: 'Ván chơi chưa bắt đầu.' };
    }

    const now = Date.now();
    const actionTimestamp = (meta && Number.isFinite(meta.receivedAt))
      ? Math.min(now, meta.receivedAt)
      : now;

    room.lastActivityAt = now;

    switch (room.game.gameType) {
      case 'quiz_race':
        return this._handleQuizAction(room, clientId, payload, actionTimestamp);
      case 'word_chain':
        return this._handleWordChainAction(room, clientId, payload, actionTimestamp);
      case 'undercover':
        return this._handleUndercoverAction(room, clientId, payload);
      case 'mind_duel':
        return this._handleMindDuelAction(room, clientId, payload, actionTimestamp);
      case 'caro_arena':
        return this._handleCaroArenaAction(room, clientId, payload);
      default:
        return { ok: false, error: 'Hành động không hợp lệ.' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GAME 1: ⚡ ĐỐ VUI TỐC ĐỘ (quiz_race — 2 đến 10 người)
  // ═══════════════════════════════════════════════════════════════════════════

  _startQuizRace(room) {
    const questions = shuffleArray(QUIZ_QUESTIONS).slice(0, 8);
    const startedAt = Date.now();
    room.game = {
      gameType: 'quiz_race',
      matchId: uuidv4(),
      phase: 'question',
      questions,
      currentIndex: 0,
      answers: new Map(), // clientId -> { optionIndex, answeredAt }
      streaks: new Map(),
      lastRoundResults: [],
      questionStartedAt: startedAt,
      endsAt: startedAt + this.timings.quizQuestionMs,
    };

    this._broadcastState(room, {
      systemNotice: '⚡ Đố Vui Tốc Độ bắt đầu! 8 câu hỏi — trả lời đúng càng nhanh điểm càng cao!',
    });

    this._setRoomTimer(room, this.timings.quizQuestionMs, () => {
      this._revealQuizQuestion(room);
    });
  }

  _handleQuizAction(room, clientId, payload, actionTimestamp = Date.now()) {
    const g = room.game;
    if (payload.action !== 'answer') return { ok: false, error: 'Hành động không hợp lệ.' };
    if (g.phase !== 'question') return { ok: false, error: 'Chưa đến lúc trả lời câu hỏi.' };
    const optionIndex = payload.optionIndex;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) {
      return { ok: false, error: 'Đáp án không hợp lệ.' };
    }
    if (g.answers.has(clientId)) {
      return { ok: false, error: 'Bạn đã chốt đáp án cho câu này rồi.' };
    }

    const answeredAt = Math.min(Date.now(), Math.max(g.questionStartedAt, actionTimestamp));
    g.answers.set(clientId, { optionIndex, answeredAt });

    // Nếu toàn bộ người chơi đang có mặt đã trả lời -> mở đáp án ngay
    const allActiveAnswered = room.players.size > 0
      && [...room.players.keys()].every((cid) => g.answers.has(cid));
    if (allActiveAnswered) {
      this._clearRoomTimer(room);
      this._revealQuizQuestion(room);
    } else {
      this._broadcastState(room);
    }
    return { ok: true };
  }

  _revealQuizQuestion(room) {
    const g = room.game;
    if (!g || g.gameType !== 'quiz_race' || g.phase !== 'question') return;

    const currentQ = g.questions[g.currentIndex];
    const evaluated = [];

    for (const [cid, player] of room.players.entries()) {
      const submission = g.answers.get(cid);
      const isCorrect = Boolean(submission && submission.optionIndex === currentQ.answer);
      const elapsedMs = submission
        ? Math.max(0, submission.answeredAt - g.questionStartedAt)
        : null;
      evaluated.push({ cid, player, submission, isCorrect, elapsedMs });
    }

    // Xác định người trả lời đúng nhanh nhất duy nhất (khi có từ 2 người trả lời đúng trở lên)
    const correctEntries = evaluated
      .filter((item) => item.isCorrect && item.elapsedMs !== null)
      .sort((a, b) => a.elapsedMs - b.elapsedMs);
    let fastestClientId = null;
    if (
      correctEntries.length >= 2
      && correctEntries[0].elapsedMs < correctEntries[1].elapsedMs
    ) {
      fastestClientId = correctEntries[0].cid;
    }

    const results = [];
    for (const item of evaluated) {
      const { cid, player, submission, isCorrect, elapsedMs } = item;
      let basePoints = 0;
      let speedBonus = 0;
      let streakBonus = 0;
      let fastestBonus = 0;
      let streak = 0;
      let gained = 0;
      const isFastest = cid === fastestClientId;

      if (isCorrect) {
        basePoints = 100;
        const remainingRatio = Math.max(0, Math.min(1, 1 - elapsedMs / this.timings.quizQuestionMs));
        speedBonus = Math.round(remainingRatio * 50);
        streak = (g.streaks.get(cid) || 0) + 1;
        g.streaks.set(cid, streak);
        streakBonus = streak >= 2 ? Math.min(20, (streak - 1) * 5) : 0;
        fastestBonus = isFastest ? 10 : 0;
        gained = basePoints + speedBonus + streakBonus + fastestBonus;
        player.score += gained;
      } else {
        g.streaks.set(cid, 0);
      }

      results.push({
        clientId: cid,
        nickname: player.nickname,
        avatar: player.avatar,
        optionIndex: submission ? submission.optionIndex : null,
        isCorrect,
        gained,
        basePoints,
        speedBonus,
        streakBonus,
        fastestBonus,
        streak,
        elapsedMs,
        isFastest,
      });
    }

    results.sort((a, b) => {
      if (a.isCorrect !== b.isCorrect) return a.isCorrect ? -1 : 1;
      if (b.gained !== a.gained) return b.gained - a.gained;
      const aTime = a.elapsedMs === null ? Number.POSITIVE_INFINITY : a.elapsedMs;
      const bTime = b.elapsedMs === null ? Number.POSITIVE_INFINITY : b.elapsedMs;
      return aTime - bTime;
    });
    g.phase = 'reveal';
    g.lastRoundResults = results;
    g.endsAt = Date.now() + this.timings.quizRevealMs;

    this._broadcastState(room);

    this._setRoomTimer(room, this.timings.quizRevealMs, () => {
      if (!room.game || room.game.gameType !== 'quiz_race') return;
      if (room.game.currentIndex + 1 >= room.game.questions.length) {
        room.game.phase = 'ended';
        room.game.endsAt = null;
        room.status = 'lobby';
        this._broadcastState(room, {
          systemNotice: '🏆 Kết thúc Đố Vui Tốc Độ! Chúc mừng những người chơi dẫn đầu!',
        });
      } else {
        const nextStart = Date.now();
        room.game.currentIndex += 1;
        room.game.phase = 'question';
        room.game.answers = new Map();
        room.game.lastRoundResults = [];
        room.game.questionStartedAt = nextStart;
        room.game.endsAt = nextStart + this.timings.quizQuestionMs;
        this._broadcastState(room);
        this._setRoomTimer(room, this.timings.quizQuestionMs, () => {
          this._revealQuizQuestion(room);
        });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GAME 2: ⛓️ NỐI TỪ THẦN TỐC (word_chain — 2 đến 10 người)
  // ═══════════════════════════════════════════════════════════════════════════

  _pickUnusedSeed(usedSet) {
    const pool = WORD_CHAIN_SEEDS.filter((w) => !usedSet.has(w.toLowerCase()));
    const list = pool.length > 0 ? pool : WORD_CHAIN_SEEDS;
    return list[Math.floor(Math.random() * list.length)];
  }

  _startWordChain(room) {
    const order = shuffleArray([...room.players.keys()]);
    const lives = new Map();
    for (const cid of order) lives.set(cid, 2);

    const seed = this._pickUnusedSeed(new Set());
    const seedParts = seed.split(' ');

    room.game = {
      gameType: 'word_chain',
      phase: 'playing',
      order,
      turnIndex: 0,
      turnClientId: order[0],
      lives,
      eliminated: new Set(),
      usedWords: new Set([seed.toLowerCase()]),
      chain: [{ word: seed, nickname: 'Hệ thống', avatar: '⛓️', isSeed: true }],
      currentWord: seed,
      requiredStart: seedParts[1],
      maxChainLength: 24,
      turnStartedAt: Date.now(),
      endsAt: Date.now() + this.timings.wordChainTurnMs,
      lastEvent: `Từ mở màn: "${seed}"`,
      winnerName: null,
    };

    const firstNick = room.players.get(order[0])?.nickname || 'Người chơi';
    this._broadcastState(room, {
      systemNotice: `⛓️ Nối Từ Thần Tốc bắt đầu! Từ mở màn: "${seed}" — Lượt của ${firstNick} (bắt đầu bằng "${seedParts[1]}")!`,
    });

    this._scheduleWordChainTimeout(room);
  }

  _penalizeWordChainTurn(room, reasonLabel = 'hết giờ') {
    const g = room.game;
    if (!g || g.gameType !== 'word_chain' || g.phase !== 'playing') return;

    this._clearRoomTimer(room);
    const timedOutId = g.turnClientId;
    const timedOutPlayer = room.players.get(timedOutId);
    const nick = timedOutPlayer ? timedOutPlayer.nickname : 'Một người chơi';
    const remainingLives = Math.max(0, (g.lives.get(timedOutId) || 1) - 1);
    g.lives.set(timedOutId, remainingLives);

    if (remainingLives === 0) {
      g.eliminated.add(timedOutId);
      g.lastEvent = `⏰ ${nick} ${reasonLabel} và đã bị loại!`;
    } else {
      g.lastEvent = `⏰ ${nick} ${reasonLabel}! Còn ${remainingLives} ❤️`;
    }

    const alive = g.order.filter((id) => room.players.has(id) && !g.eliminated.has(id));
    if (alive.length <= 1) {
      const winner = alive[0] ? room.players.get(alive[0]) : null;
      if (winner) winner.score += 20;
      g.phase = 'ended';
      g.endsAt = null;
      g.winnerName = winner ? winner.nickname : 'Hòa';
      room.status = 'lobby';
      this._broadcastState(room, {
        systemNotice: winner
          ? `🏆 ${winner.nickname} là người trụ lại cuối cùng và chiến thắng Nối Từ Thần Tốc! (+20 điểm)`
          : '⛓️ Ván Nối Từ kết thúc!',
      });
      return;
    }

    // Đổi từ mới sau khi hết giờ / bỏ lượt để tránh kẹt âm tiết quá khó
    const nextSeed = this._pickUnusedSeed(g.usedWords);
    g.usedWords.add(nextSeed.toLowerCase());
    const parts = nextSeed.split(' ');
    g.currentWord = nextSeed;
    g.requiredStart = parts[1];
    g.chain.push({ word: nextSeed, nickname: 'Đổi từ mới', avatar: '🔄', isSeed: true });

    this._advanceWordChainTurn(room);
    this._broadcastState(room, { systemNotice: `${g.lastEvent} Từ mới: "${nextSeed}".` });
    this._scheduleWordChainTimeout(room);
  }

  forfeitWordChainTurn(roomId, clientId, reasonLabel = 'chịu thua lượt này') {
    const room = this.rooms.get(roomId);
    if (!room || !room.game || room.game.gameType !== 'word_chain' || room.game.phase !== 'playing') return;
    if (room.game.turnClientId !== clientId) return;
    this._penalizeWordChainTurn(room, reasonLabel);
  }

  _scheduleWordChainTimeout(room) {
    this._setRoomTimer(room, this.timings.wordChainTurnMs, () => {
      this._penalizeWordChainTurn(room, 'hết giờ');
    });
  }

  _advanceWordChainTurn(room) {
    const g = room.game;
    const alive = g.order.filter((id) => room.players.has(id) && !g.eliminated.has(id));
    if (alive.length === 0) return;

    const currentPos = g.order.indexOf(g.turnClientId);
    for (let offset = 1; offset <= g.order.length; offset++) {
      const candidate = g.order[(currentPos + offset) % g.order.length];
      if (room.players.has(candidate) && !g.eliminated.has(candidate)) {
        g.turnClientId = candidate;
        break;
      }
    }
    g.turnStartedAt = Date.now();
    g.endsAt = Date.now() + this.timings.wordChainTurnMs;
  }

  _handleWordChainAction(room, clientId, payload, actionTimestamp = Date.now()) {
    const g = room.game;
    if (payload.action !== 'submit_word') return { ok: false, error: 'Hành động không hợp lệ.' };
    if (g.phase !== 'playing') return { ok: false, error: 'Ván chơi đã kết thúc.' };
    if (g.turnClientId !== clientId) return { ok: false, error: 'Chưa đến lượt của bạn!' };

    const raw = typeof payload.word === 'string' ? payload.word.trim().replace(/\s+/g, ' ') : '';
    if (!raw || raw.length > 40) return { ok: false, error: 'Vui lòng nhập cụm từ 2 âm tiết hợp lệ.' };

    const filterRes = checkContent(raw);
    if (filterRes.isViolation) {
      return { ok: false, error: 'Từ ngữ không phù hợp, hãy chọn từ lịch sự hơn nhé!' };
    }

    const parts = raw.split(' ');
    if (parts.length !== 2) {
      return { ok: false, error: 'Cụm từ nối phải gồm đúng 2 tiếng (ví dụ: "phê duyệt").' };
    }

    const validLetters = /^[\p{L}]+$/u;
    if (!validLetters.test(parts[0]) || !validLetters.test(parts[1])) {
      return { ok: false, error: 'Từ nối chỉ được chứa chữ cái, không chứa số hoặc ký tự đặc biệt.' };
    }

    const firstLower = parts[0].toLowerCase();
    const requiredLower = g.requiredStart.toLowerCase();
    if (firstLower !== requiredLower && stripVietnameseTones(firstLower) !== stripVietnameseTones(requiredLower)) {
      return { ok: false, error: `Từ phải bắt đầu bằng tiếng "${g.requiredStart}"!` };
    }

    const normalizedPhrase = raw.toLowerCase();
    if (g.usedWords.has(normalizedPhrase)) {
      return { ok: false, error: `Cụm từ "${raw}" đã được dùng trong ván này rồi!` };
    }

    // Hợp lệ!
    const player = room.players.get(clientId);
    const elapsed = Math.max(0, actionTimestamp - g.turnStartedAt);
    const gained = elapsed <= 6_000 ? 15 : 10;
    if (player) player.score += gained;

    g.usedWords.add(normalizedPhrase);
    g.currentWord = raw;
    g.requiredStart = parts[1];
    g.chain.push({
      word: raw,
      clientId,
      nickname: player ? player.nickname : 'Ẩn danh',
      avatar: player ? player.avatar : '🦊',
      gained,
    });
    g.lastEvent = `✅ ${player?.nickname || 'Người chơi'} nối "${raw}" (+${gained} điểm)`;

    if (g.chain.length >= g.maxChainLength) {
      this._clearRoomTimer(room);
      g.phase = 'ended';
      g.endsAt = null;
      const top = this._buildLeaderboard(room)[0];
      g.winnerName = top ? top.nickname : '';
      room.status = 'lobby';
      this._broadcastState(room, {
        systemNotice: `🎉 Chuỗi ${g.chain.length} từ hoàn hảo! ${g.winnerName} dẫn đầu bảng điểm!`,
      });
      return { ok: true };
    }

    this._advanceWordChainTurn(room);
    this._broadcastState(room);
    this._scheduleWordChainTimeout(room);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GAME 3: 🕵️ AI LÀ GIÁN ĐIỆP? (undercover — 3 đến 10 người)
  // ═══════════════════════════════════════════════════════════════════════════

  _startUndercover(room) {
    const pair = UNDERCOVER_PAIRS[Math.floor(Math.random() * UNDERCOVER_PAIRS.length)];
    const flip = Math.random() < 0.5;
    const civilianWord = flip ? pair[0] : pair[1];
    const spyWord = flip ? pair[1] : pair[0];

    const playerIds = shuffleArray([...room.players.keys()]);
    const spyCount = playerIds.length >= 7 ? 2 : 1;
    const spyIds = new Set(playerIds.slice(0, spyCount));

    const playerNamesSnapshot = new Map();
    for (const [cid, p] of room.players.entries()) {
      playerNamesSnapshot.set(cid, p.nickname);
    }

    room.game = {
      gameType: 'undercover',
      phase: 'clue', // 'clue' | 'vote' | 'round_result' | 'ended'
      round: 1,
      civilianWord,
      spyWord,
      spyIds,
      participantIds: new Set(playerIds),
      aliveIds: new Set(playerIds),
      eliminatedIds: new Set(),
      clues: new Map(), // clientId -> string
      votes: new Map(), // voterId -> targetId
      lastElimination: null,
      winnerSide: null,
      playerNamesSnapshot,
      endsAt: Date.now() + this.timings.undercoverClueMs,
    };

    // Gửi riêng từ bí mật cho từng người chơi (TUYỆT ĐỐI không gửi công khai)
    for (const cid of playerIds) {
      const secretWord = spyIds.has(cid) ? spyWord : civilianWord;
      this.onSendTo(cid, 'game_room_private', {
        roomId: room.roomId,
        gameType: 'undercover',
        secretWord,
      });
    }

    this._broadcastState(room, {
      systemNotice: `🕵️ Ai Là Gián Điệp bắt đầu! Có ${spyCount} gián điệp đang ẩn mình. Hãy xem từ bí mật của bạn và gửi gợi ý mô tả!`,
    });

    this._setRoomTimer(room, this.timings.undercoverClueMs, () => {
      this._beginUndercoverVoting(room);
    });
  }

  _beginUndercoverVoting(room) {
    const g = room.game;
    if (!g || g.gameType !== 'undercover' || g.phase !== 'clue') return;

    // Điền gợi ý mặc định cho ai chưa kịp gửi
    for (const cid of g.aliveIds) {
      if (!g.clues.has(cid)) {
        g.clues.set(cid, '(Chưa kịp mô tả)');
      }
    }

    g.phase = 'vote';
    g.votes = new Map();
    g.endsAt = Date.now() + this.timings.undercoverVoteMs;

    this._broadcastState(room, {
      systemNotice: '🗳️ Tất cả gợi ý đã mở! Hãy thảo luận (có thể tag @tên trong chat) và bỏ phiếu chọn người khả nghi nhất!',
    });

    this._setRoomTimer(room, this.timings.undercoverVoteMs, () => {
      this._resolveUndercoverVotes(room);
    });
  }

  _resolveUndercoverVotes(room) {
    const g = room.game;
    if (!g || g.gameType !== 'undercover' || g.phase !== 'vote') return;

    const tally = new Map();
    for (const targetId of g.votes.values()) {
      if (g.aliveIds.has(targetId)) {
        tally.set(targetId, (tally.get(targetId) || 0) + 1);
      }
    }

    let maxVotes = 0;
    let topTargets = [];
    for (const [tid, count] of tally.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        topTargets = [tid];
      } else if (count === maxVotes) {
        topTargets.push(tid);
      }
    }

    let notice = '';
    if (topTargets.length === 1 && maxVotes > 0) {
      const eliminatedId = topTargets[0];
      g.aliveIds.delete(eliminatedId);
      g.eliminatedIds.add(eliminatedId);
      const isSpy = g.spyIds.has(eliminatedId);
      const nick = room.players.get(eliminatedId)?.nickname || g.playerNamesSnapshot.get(eliminatedId) || 'Ẩn danh';

      g.lastElimination = {
        clientId: eliminatedId,
        nickname: nick,
        votes: maxVotes,
        wasSpy: isSpy,
        tied: false,
      };
      notice = isSpy
        ? `🎯 ${nick} bị loại (${maxVotes} phiếu) và ĐÚNG LÀ GIÁN ĐIỆP! 🕵️`
        : `😱 ${nick} bị loại (${maxVotes} phiếu) nhưng lại là DÂN THƯỜNG!`;
    } else {
      g.lastElimination = {
        clientId: null,
        nickname: null,
        votes: maxVotes,
        wasSpy: false,
        tied: true,
      };
      notice = '⚖️ Số phiếu hòa hoặc chưa có phiếu quyết định! Không ai bị loại vòng này.';
    }

    // Kiểm tra điều kiện thắng
    const aliveSpies = [...g.aliveIds].filter((id) => g.spyIds.has(id));
    const aliveCivilians = [...g.aliveIds].filter((id) => !g.spyIds.has(id));

    if (aliveSpies.length === 0) {
      g.phase = 'ended';
      g.winnerSide = 'civilians';
      g.endsAt = null;
      room.status = 'lobby';
      for (const [cid, player] of room.players.entries()) {
        if (g.participantIds.has(cid) && !g.spyIds.has(cid)) player.score += 25;
      }
      this._broadcastState(room, {
        systemNotice: `${notice} 🎉 DÂN THƯỜNG CHIẾN THẮNG! Từ dân thường: "${g.civilianWord}" • Từ gián điệp: "${g.spyWord}".`,
      });
      return;
    }

    if (aliveSpies.length >= aliveCivilians.length || g.aliveIds.size <= 2) {
      g.phase = 'ended';
      g.winnerSide = 'spies';
      g.endsAt = null;
      room.status = 'lobby';
      for (const [cid, player] of room.players.entries()) {
        if (g.participantIds.has(cid) && g.spyIds.has(cid)) player.score += 35;
      }
      this._broadcastState(room, {
        systemNotice: `${notice} 🕵️ GIÁN ĐIỆP CHIẾN THẮNG! Từ dân thường: "${g.civilianWord}" • Từ gián điệp: "${g.spyWord}".`,
      });
      return;
    }

    // Chuyển sang vòng mô tả tiếp theo
    g.phase = 'round_result';
    g.endsAt = Date.now() + this.timings.undercoverResultMs;
    this._broadcastState(room, { systemNotice: notice });

    this._setRoomTimer(room, this.timings.undercoverResultMs, () => {
      if (!room.game || room.game.gameType !== 'undercover') return;
      room.game.round += 1;
      room.game.phase = 'clue';
      room.game.clues = new Map();
      room.game.votes = new Map();
      room.game.endsAt = Date.now() + this.timings.undercoverClueMs;
      this._broadcastState(room, {
        systemNotice: `🔄 Vòng ${room.game.round}: Mời những người chơi còn lại tiếp tục gửi gợi ý mô tả mới!`,
      });
      this._setRoomTimer(room, this.timings.undercoverClueMs, () => {
        this._beginUndercoverVoting(room);
      });
    });
  }

  _handleUndercoverAction(room, clientId, payload) {
    const g = room.game;
    if (!g.aliveIds.has(clientId)) {
      return { ok: false, error: 'Bạn đã bị loại hoặc đang theo dõi ván này.' };
    }

    if (payload.action === 'submit_clue') {
      if (g.phase !== 'clue') return { ok: false, error: 'Hiện không phải pha gửi gợi ý.' };
      if (g.clues.has(clientId)) return { ok: false, error: 'Bạn đã gửi gợi ý cho vòng này rồi.' };

      const clue = typeof payload.clue === 'string' ? payload.clue.trim().slice(0, 80) : '';
      if (clue.length < 2) return { ok: false, error: 'Gợi ý cần ít nhất 2 ký tự.' };
      if (checkContent(clue).isViolation) return { ok: false, error: 'Gợi ý chứa ngôn từ không phù hợp.' };

      const myWord = g.spyIds.has(clientId) ? g.spyWord : g.civilianWord;
      if (stripVietnameseTones(clue).includes(stripVietnameseTones(myWord))) {
        return { ok: false, error: 'Không được viết trực tiếp từ bí mật của bạn vào gợi ý!' };
      }

      g.clues.set(clientId, clue);
      if (g.clues.size >= g.aliveIds.size) {
        this._clearRoomTimer(room);
        this._beginUndercoverVoting(room);
      } else {
        this._broadcastState(room);
      }
      return { ok: true };
    }

    if (payload.action === 'vote') {
      if (g.phase !== 'vote') return { ok: false, error: 'Hiện không phải pha bỏ phiếu.' };
      const targetId = payload.targetClientId;
      if (!targetId || targetId === clientId) {
        return { ok: false, error: 'Bạn không thể tự bỏ phiếu cho chính mình.' };
      }
      if (!g.aliveIds.has(targetId)) {
        return { ok: false, error: 'Người chơi này không còn trong lượt bỏ phiếu.' };
      }

      g.votes.set(clientId, targetId);
      if (g.votes.size >= g.aliveIds.size) {
        this._clearRoomTimer(room);
        this._resolveUndercoverVotes(room);
      } else {
        this._broadcastState(room);
      }
      return { ok: true };
    }

    return { ok: false, error: 'Hành động không hợp lệ.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GAME 4: 🃏 ĐẤU TRÍ TÂM LÝ (mind_duel — 2 đến 10 người)
  // ═══════════════════════════════════════════════════════════════════════════

  _resolveMindDuelPair(moveA, moveB) {
    if (!moveA && !moveB) return { delta: 0, tag: 'fold' };
    if (!moveA) return { delta: -15, tag: 'fold' };
    if (!moveB) return { delta: Math.round(moveA.stake * 0.5), tag: 'walkover' };

    const { card: a, stake: sA } = moveA;
    const { card: b, stake: sB } = moveB;

    if (a === b) {
      if (a === 'charge') return { delta: sA, tag: 'mutual_charge' };
      return { delta: 0, tag: 'clash' };
    }

    if (a === 'attack') {
      if (b === 'charge') return { delta: sA + sB, tag: 'rob_charge' };
      if (b === 'bluff') return { delta: sA + Math.round(sB * 0.5), tag: 'crush_bluff' };
      if (b === 'shield') return { delta: -sA, tag: 'blocked' };
    }

    if (a === 'shield') {
      if (b === 'attack') return { delta: sA + Math.round(sB * 0.5), tag: 'counter_shield' };
      if (b === 'bluff') return { delta: -Math.round(sA * 1.25), tag: 'pierced' };
      if (b === 'charge') return { delta: 0, tag: 'missed_charge' };
    }

    if (a === 'bluff') {
      if (b === 'shield') return { delta: sA + Math.round(sB * 0.75), tag: 'pierce_shield' };
      if (b === 'attack') return { delta: -sA, tag: 'crushed' };
      if (b === 'charge') return { delta: 0, tag: 'missed_charge' };
    }

    if (a === 'charge') {
      if (b === 'attack') return { delta: -Math.round(sA * 1.5), tag: 'robbed' };
      return { delta: Math.round(sA * 1.25), tag: 'free_charge' };
    }

    return { delta: 0, tag: 'clash' };
  }

  _formatMindDuelOutcome(move, delta, primaryTag) {
    if (!move) return '⏰ Bỏ lượt';
    if (primaryTag === 'rob_charge') return '⚔️ Cướp kho cực gắt!';
    if (primaryTag === 'crush_bluff') return '⚔️ Phá tan lừa đòn!';
    if (primaryTag === 'counter_shield') return '🛡️ Phản đòn khiên!';
    if (primaryTag === 'pierce_shield') return '🎭 Đọc vị xuyên khiên!';
    if (primaryTag === 'free_charge') return '💰 Gom thưởng trọn vẹn!';
    if (primaryTag === 'mutual_charge') return '🤝 Cùng gom hòa bình';
    if (primaryTag === 'robbed') return '💥 Bị cướp sạch kho!';
    if (primaryTag === 'blocked') return '🛡️ Đâm trúng lá chắn!';
    if (primaryTag === 'pierced') return '🎭 Bị xuyên khiên!';
    if (primaryTag === 'crushed') return '💥 Bị bắt bài lừa!';
    if (primaryTag === 'walkover') return '✨ Đối thủ bỏ lượt';
    if (delta > 0) return '🔥 Thắng thế vòng này!';
    if (delta < 0) return '😵 Bị đọc vị!';
    return '⚖️ Hòa kèo căng thẳng';
  }

  _beginMindDuelRound(room, isFirstRound = false) {
    const g = room.game;
    const now = Date.now();
    g.phase = 'choose';
    g.choices = new Map();
    g.lastRoundResults = [];
    g.lastRoundSummary = '';
    g.roundStartedAt = now;
    g.endsAt = now + this.timings.mindDuelChooseMs;

    const isDouble = g.round === g.totalRounds;
    const notice = isFirstRound
      ? `🃏 Đấu Trí Tâm Lý bắt đầu! Mỗi người có ${MIND_DUEL_START_SCORE}đ vốn — chọn lá bài kín & đặt cược qua ${g.totalRounds} vòng (vòng cuối x2 điểm)!`
      : (isDouble
        ? `🔥 VÒNG CUỐI (${g.round}/${g.totalRounds}) — NHÂN ĐÔI ĐIỂM (x2)! Cân não chọn bài & cược thật khéo nhé!`
        : `🃏 Vòng ${g.round}/${g.totalRounds}: Chọn lá bài chiến thuật & mức cược kín!`);

    this._broadcastState(room, { systemNotice: notice });

    this._setRoomTimer(room, this.timings.mindDuelChooseMs, () => {
      this._revealMindDuelRound(room);
    });
  }

  _startMindDuel(room) {
    for (const player of room.players.values()) {
      player.score = MIND_DUEL_START_SCORE;
    }

    room.game = {
      gameType: 'mind_duel',
      matchId: uuidv4(),
      phase: 'choose',
      round: 1,
      totalRounds: MIND_DUEL_TOTAL_ROUNDS,
      choices: new Map(), // clientId -> { card, stake, chosenAt }
      lastRoundResults: [],
      lastRoundSummary: '',
      history: [],
      roundStartedAt: Date.now(),
      endsAt: null,
      winnerName: null,
    };

    this._beginMindDuelRound(room, true);
  }

  _handleMindDuelAction(room, clientId, payload, actionTimestamp = Date.now()) {
    const g = room.game;
    if (payload.action !== 'pick_card') return { ok: false, error: 'Hành động không hợp lệ.' };
    if (g.phase !== 'choose') return { ok: false, error: 'Đang lật bài, vui lòng chờ vòng tiếp theo!' };

    const card = typeof payload.card === 'string' ? payload.card.trim().toLowerCase() : '';
    if (!VALID_MIND_DUEL_CARDS.includes(card)) {
      return { ok: false, error: 'Lá bài chiến thuật không hợp lệ.' };
    }
    const stake = payload.stake === undefined ? 20 : Number(payload.stake);
    if (!VALID_MIND_DUEL_STAKES.includes(stake)) {
      return { ok: false, error: 'Mức cược phải là 10, 20 hoặc 30 điểm.' };
    }
    if (g.choices.has(clientId)) {
      return { ok: false, error: 'Bạn đã chốt lá bài cho vòng này rồi.' };
    }

    const chosenAt = Math.min(Date.now(), Math.max(g.roundStartedAt || Date.now(), actionTimestamp));
    g.choices.set(clientId, { card, stake, chosenAt });

    const allActiveLocked = room.players.size > 0
      && [...room.players.keys()].every((cid) => g.choices.has(cid));
    if (allActiveLocked) {
      this._clearRoomTimer(room);
      this._revealMindDuelRound(room);
    } else {
      this._broadcastState(room);
    }
    return { ok: true };
  }

  _revealMindDuelRound(room) {
    const g = room.game;
    if (!g || g.gameType !== 'mind_duel' || g.phase !== 'choose') return;

    const activePlayers = [...room.players.entries()];
    const multiplier = g.round === g.totalRounds ? 2 : 1;
    const results = [];

    for (const [cid, player] of activePlayers) {
      const myMove = g.choices.get(cid) || null;
      const opponents = activePlayers.filter(([oid]) => oid !== cid);
      let rawDelta = 0;
      let primaryTag = myMove ? 'clash' : 'fold';
      let strongestAbs = -1;

      if (!myMove) {
        rawDelta = -15;
        primaryTag = 'fold';
      } else if (opponents.length > 0) {
        let totalPairDelta = 0;
        for (const [oid] of opponents) {
          const oppMove = g.choices.get(oid) || null;
          const pairRes = this._resolveMindDuelPair(myMove, oppMove);
          totalPairDelta += pairRes.delta;
          if (Math.abs(pairRes.delta) > strongestAbs) {
            strongestAbs = Math.abs(pairRes.delta);
            primaryTag = pairRes.tag;
          }
        }
        rawDelta = Math.round(totalPairDelta / opponents.length);
      }

      const delta = rawDelta * multiplier;
      player.score = Math.max(0, (player.score || 0) + delta);
      const cardMeta = myMove ? MIND_DUEL_CARDS[myMove.card] : null;

      results.push({
        clientId: cid,
        nickname: player.nickname,
        avatar: player.avatar,
        card: myMove ? myMove.card : null,
        cardIcon: cardMeta ? cardMeta.icon : '⏰',
        cardName: cardMeta ? cardMeta.name : 'Bỏ lượt',
        stake: myMove ? myMove.stake : 0,
        delta,
        scoreAfter: player.score,
        outcomeLabel: this._formatMindDuelOutcome(myMove, delta, primaryTag),
      });
    }

    results.sort((a, b) => (b.delta - a.delta) || (b.scoreAfter - a.scoreAfter));
    const topRound = results[0];
    const summary = topRound && topRound.delta > 0
      ? `🃏 Vòng ${g.round}${multiplier > 1 ? ' (x2)' : ''}: ${topRound.nickname} bùng nổ với ${topRound.cardIcon} ${topRound.cardName} (+${topRound.delta}đ)!`
      : `🃏 Vòng ${g.round}${multiplier > 1 ? ' (x2)' : ''}: Kèo cân não — chưa ai bứt phá!`;

    g.phase = 'reveal';
    g.lastRoundResults = results;
    g.lastRoundSummary = summary;
    g.history.push({
      round: g.round,
      multiplier,
      entries: results.map((r) => ({
        clientId: r.clientId,
        nickname: r.nickname,
        card: r.card,
        cardIcon: r.cardIcon,
        stake: r.stake,
        delta: r.delta,
      })),
    });
    g.endsAt = Date.now() + this.timings.mindDuelRevealMs;

    this._broadcastState(room);

    this._setRoomTimer(room, this.timings.mindDuelRevealMs, () => {
      if (!room.game || room.game.gameType !== 'mind_duel') return;
      if (room.game.round >= room.game.totalRounds) {
        const leaderboard = this._buildLeaderboard(room);
        const champ = leaderboard[0] || null;
        room.game.phase = 'ended';
        room.game.endsAt = null;
        room.game.winnerName = champ ? champ.nickname : 'Hòa';
        room.status = 'lobby';
        this._broadcastState(room, {
          systemNotice: champ
            ? `🏆 Kết thúc Đấu Trí Tâm Lý! Bậc thầy đọc vị: ${champ.nickname} (${champ.score} điểm)!`
            : '🃏 Ván Đấu Trí Tâm Lý đã kết thúc!',
        });
      } else {
        room.game.round += 1;
        this._beginMindDuelRound(room, false);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GAME 5: ⚔️ CỜ CARO KHÁN ĐÀI (caro_arena — 2 người đấu, tới 10 người cổ vũ)
  // ═══════════════════════════════════════════════════════════════════════════

  _startCaroArena(room) {
    const queue = room.caroQueue.filter((id) => room.players.has(id));
    for (const cid of room.players.keys()) {
      if (!queue.includes(cid)) queue.push(cid);
    }
    room.caroQueue = queue;

    const xPlayer = queue[0];
    const oPlayer = queue[1];
    const size = 15;

    room.game = {
      gameType: 'caro_arena',
      phase: 'playing',
      size,
      winLength: 5,
      board: Array(size * size).fill(null),
      xPlayer,
      xNickname: room.players.get(xPlayer)?.nickname || 'X',
      oPlayer,
      oNickname: room.players.get(oPlayer)?.nickname || 'O',
      turn: xPlayer,
      endsAt: Date.now() + this.timings.caroMoveMs,
      lastMove: null,
      winner: null,
      winnerId: null,
      winnerName: null,
      winningLine: null,
    };

    this._broadcastState(room, {
      systemNotice: `⚔️ Cờ Caro Khán Đài (15×15): ${room.game.xNickname} (X) đấu với ${room.game.oNickname} (O)!`,
    });

    this._scheduleCaroTimeout(room);
  }

  _scheduleCaroTimeout(room) {
    this._setRoomTimer(room, this.timings.caroMoveMs, () => {
      const g = room.game;
      if (!g || g.gameType !== 'caro_arena' || g.phase !== 'playing') return;

      const winnerId = g.turn === g.xPlayer ? g.oPlayer : g.xPlayer;
      const winnerSymbol = winnerId === g.xPlayer ? 'X' : 'O';
      const winnerPlayer = room.players.get(winnerId);
      if (winnerPlayer) winnerPlayer.score += 25;

      g.phase = 'ended';
      g.winner = winnerSymbol;
      g.winnerId = winnerId;
      g.winnerName = winnerPlayer ? winnerPlayer.nickname : winnerSymbol;
      g.endsAt = null;
      room.status = 'lobby';
      this._rotateCaroQueue(room, winnerId);
      this._broadcastState(room, {
        systemNotice: `⏰ Hết giờ đánh cờ! ${g.winnerName} (${winnerSymbol}) chiến thắng (+25 điểm)!`,
      });
    });
  }

  _rotateCaroQueue(room, winnerId) {
    const loserId = winnerId === room.game.xPlayer ? room.game.oPlayer : room.game.xPlayer;
    const others = room.caroQueue.filter((id) => id !== winnerId && id !== loserId && room.players.has(id));
    room.caroQueue = [
      ...(room.players.has(winnerId) ? [winnerId] : []),
      ...others,
      ...(room.players.has(loserId) ? [loserId] : []),
    ];
  }

  _handleCaroArenaAction(room, clientId, payload) {
    const g = room.game;
    if (payload.action !== 'caro_move') return { ok: false, error: 'Hành động không hợp lệ.' };
    if (g.phase !== 'playing') return { ok: false, error: 'Ván cờ đã kết thúc.' };
    if (clientId !== g.xPlayer && clientId !== g.oPlayer) {
      return { ok: false, error: 'Bạn đang là khán giả ván này — cổ vũ và chờ lượt thách đấu ván sau nhé!' };
    }
    if (g.turn !== clientId) return { ok: false, error: 'Chưa đến lượt của bạn.' };

    const index = payload.index;
    if (!Number.isInteger(index) || index < 0 || index >= g.board.length) {
      return { ok: false, error: 'Ô đánh không hợp lệ.' };
    }
    if (g.board[index] !== null) return { ok: false, error: 'Ô này đã được đánh rồi.' };

    const symbol = clientId === g.xPlayer ? 'X' : 'O';
    g.board[index] = symbol;
    g.lastMove = index;

    const size = g.size;
    const row = Math.floor(index / size);
    const col = index % size;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    let winningLine = null;

    for (const [dr, dc] of dirs) {
      const line = [index];
      for (const sign of [1, -1]) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (r >= 0 && r < size && c >= 0 && c < size) {
          const idx = r * size + c;
          if (g.board[idx] !== symbol) break;
          line.push(idx);
          r += dr * sign;
          c += dc * sign;
        }
      }
      if (line.length >= g.winLength) {
        winningLine = line.sort((a, b) => a - b);
        break;
      }
    }

    if (winningLine) {
      this._clearRoomTimer(room);
      const winnerPlayer = room.players.get(clientId);
      if (winnerPlayer) winnerPlayer.score += 25;
      g.phase = 'ended';
      g.winner = symbol;
      g.winnerId = clientId;
      g.winnerName = winnerPlayer ? winnerPlayer.nickname : symbol;
      g.winningLine = winningLine;
      g.endsAt = null;
      room.status = 'lobby';
      this._rotateCaroQueue(room, clientId);
      this._broadcastState(room, {
        systemNotice: `🏆 ${g.winnerName} (${symbol}) nối đủ 5 quân chiến thắng Cờ Caro Khán Đài! (+25 điểm)`,
      });
      return { ok: true };
    }

    if (g.board.every((cell) => cell !== null)) {
      this._clearRoomTimer(room);
      g.phase = 'ended';
      g.winner = 'draw';
      g.endsAt = null;
      room.status = 'lobby';
      this._broadcastState(room, { systemNotice: '🤝 Ván cờ Caro kết thúc hòa!' });
      return { ok: true };
    }

    g.turn = clientId === g.xPlayer ? g.oPlayer : g.xPlayer;
    g.endsAt = Date.now() + this.timings.caroMoveMs;
    this._broadcastState(room);
    this._scheduleCaroTimeout(room);
    return { ok: true };
  }

  // ─── Xử lý khi người chơi rời phòng giữa ván ──────────────────────────────

  _handlePlayerLeaveDuringGame(room, clientId) {
    const g = room.game;
    if (!g || g.phase === 'ended') return;

    if (g.gameType === 'quiz_race') {
      if (g.answers) g.answers.delete(clientId);
      if (g.streaks) g.streaks.delete(clientId);
      const allActiveAnswered = room.players.size > 0
        && [...room.players.keys()].every((cid) => g.answers && g.answers.has(cid));
      if (g.phase === 'question' && allActiveAnswered) {
        this._clearRoomTimer(room);
        this._revealQuizQuestion(room);
      } else if (g.phase === 'question') {
        this._broadcastState(room);
      }
      return;
    }

    if (g.gameType === 'word_chain') {
      g.eliminated.add(clientId);
      const alive = g.order.filter((id) => room.players.has(id) && !g.eliminated.has(id));
      if (alive.length <= 1) {
        this._clearRoomTimer(room);
        const winner = alive[0] ? room.players.get(alive[0]) : null;
        if (winner) winner.score += 20;
        g.phase = 'ended';
        g.endsAt = null;
        g.winnerName = winner ? winner.nickname : 'Hòa';
        room.status = 'lobby';
        this._broadcastState(room);
      } else if (g.turnClientId === clientId) {
        this._advanceWordChainTurn(room);
        this._broadcastState(room);
        this._scheduleWordChainTimeout(room);
      }
      return;
    }

    if (g.gameType === 'undercover') {
      g.aliveIds.delete(clientId);
      g.eliminatedIds.add(clientId);
      g.clues.delete(clientId);
      g.votes.delete(clientId);
      for (const [voterId, targetId] of [...g.votes.entries()]) {
        if (targetId === clientId) g.votes.delete(voterId);
      }
      const aliveSpies = [...g.aliveIds].filter((id) => g.spyIds.has(id));
      const aliveCivilians = [...g.aliveIds].filter((id) => !g.spyIds.has(id));

      if (aliveSpies.length === 0 || aliveSpies.length >= aliveCivilians.length || g.aliveIds.size <= 2) {
        this._clearRoomTimer(room);
        g.phase = 'ended';
        g.winnerSide = aliveSpies.length === 0 ? 'civilians' : 'spies';
        g.endsAt = null;
        room.status = 'lobby';
        for (const [cid, player] of room.players.entries()) {
          if (!g.participantIds || g.participantIds.has(cid)) {
            if (g.winnerSide === 'civilians' && !g.spyIds.has(cid)) player.score += 25;
            if (g.winnerSide === 'spies' && g.spyIds.has(cid)) player.score += 35;
          }
        }
        this._broadcastState(room);
      } else if (g.phase === 'clue' && [...g.aliveIds].every((id) => g.clues.has(id))) {
        this._clearRoomTimer(room);
        this._beginUndercoverVoting(room);
      } else if (g.phase === 'vote' && [...g.aliveIds].every((id) => g.votes.has(id))) {
        this._clearRoomTimer(room);
        this._resolveUndercoverVotes(room);
      } else {
        this._broadcastState(room);
      }
      return;
    }

    if (g.gameType === 'mind_duel') {
      if (g.choices) g.choices.delete(clientId);
      if (room.players.size <= 1) {
        this._clearRoomTimer(room);
        const winner = [...room.players.values()][0] || null;
        g.phase = 'ended';
        g.endsAt = null;
        g.winnerName = winner ? winner.nickname : 'Hòa';
        room.status = 'lobby';
        this._broadcastState(room);
      } else if (g.phase === 'choose' && [...room.players.keys()].every((cid) => g.choices.has(cid))) {
        this._clearRoomTimer(room);
        this._revealMindDuelRound(room);
      } else if (g.phase === 'choose') {
        this._broadcastState(room);
      }
      return;
    }

    if (g.gameType === 'caro_arena') {
      if (clientId === g.xPlayer || clientId === g.oPlayer) {
        this._clearRoomTimer(room);
        const winnerId = clientId === g.xPlayer ? g.oPlayer : g.xPlayer;
        const winnerSymbol = winnerId === g.xPlayer ? 'X' : 'O';
        const winnerPlayer = room.players.get(winnerId);
        if (winnerPlayer) winnerPlayer.score += 25;
        g.phase = 'ended';
        g.winner = winnerSymbol;
        g.winnerId = winnerId;
        g.winnerName = winnerPlayer ? winnerPlayer.nickname : winnerSymbol;
        g.endsAt = null;
        room.status = 'lobby';
        this._broadcastState(room);
      }
    }
  }

  destroy() {
    for (const room of this.rooms.values()) {
      this._clearAllTimers(room);
    }
    this.rooms.clear();
    this.codeToRoomId.clear();
    this.clientRoomMap.clear();
    this.contextToRoomId.clear();
  }

  get roomCount() {
    return this.rooms.size;
  }
}

module.exports = {
  GameRoomManager,
  GAME_CATALOG,
  MIND_DUEL_CARDS,
  VALID_GAME_TYPES,
  MAX_GAME_ROOM_PLAYERS,
  MIN_GAME_ROOM_PLAYERS,
  MAX_ROOM_NAME_LENGTH,
};

