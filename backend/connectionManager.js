/**
 * connectionManager.js – Quản lý "Giữ kết nối" ẩn danh 2 chiều & Mã hẹn gặp lại (Chat 1-1)
 *
 * Nguyên tắc bảo mật & ẩn danh:
 *   1. KHÔNG dùng địa chỉ IP hay mã phần cứng (MAC/IMEI). Mọi định danh dựa trên token ngẫu nhiên bí mật.
 *   2. Đồng thuận 2 chiều tuyệt đối: chỉ kích hoạt "Giữ kết nối" khi CẢ 2 người trong phòng 1-1 cùng đồng ý.
 *      - Nếu rời phòng khi mới có 0 hoặc 1 người chọn -> toàn bộ bộ đệm tin nhắn tạm bị xóa sạch tức thì.
 *   3. Khi cả 2 đồng ý -> tạo cặp kết nối với:
 *      - pairId + pairToken bí mật riêng từng bên (slot A / slot B) để xác thực trên trình duyệt.
 *      - Mã hẹn gặp lại dạng CHAT-XXXX-XXXX (32^8 > 1.1 nghìn tỷ tổ hợp) để gặp lại khi đổi thiết bị.
 *      - Giữ lại tối đa 40 tin nhắn gần nhất (cấu hình 30–50 qua MAX_PAIR_HISTORY), bao gồm text / voice / meme.
 *   4. Bất kỳ bên nào bấm "Hủy giữ kết nối" hoặc "Báo cáo" -> xóa vĩnh viễn cặp kết nối, mã hẹn và lịch sử ở cả 2 phía.
 *   5. Hỗ trợ dual-mode: In-Memory (mặc định khi không bật Redis) & Redis (bền vững 30 ngày, tự gia hạn khi chat lại).
 */

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { safeTokenEquals } = require('./security');

const configuredHistoryLimit = Number(process.env.MAX_PAIR_HISTORY);
const MAX_PAIR_HISTORY = (
  Number.isSafeInteger(configuredHistoryLimit)
  && configuredHistoryLimit >= 30
  && configuredHistoryLimit <= 50
)
  ? configuredHistoryLimit
  : 40;

const PAIR_TTL_SECONDS = 30 * 24 * 3600; // 30 ngày không hoạt động sẽ tự hết hạn
const MAX_SAVED_PAIR_PASSES = 30;
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_REGEX = /^CHAT-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;

const REDIS_KEYS = {
  meta: (pairId) => `chat:pair:meta:${pairId}`,
  code: (code) => `chat:pair:code:${code}`,
  history: (pairId) => `chat:pair:history:${pairId}`,
};

function generatePairToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 ký tự hex
}

function generatePairCode() {
  const bytes = crypto.randomBytes(8);
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += PAIR_CODE_ALPHABET[bytes[i] % PAIR_CODE_ALPHABET.length];
    part2 += PAIR_CODE_ALPHABET[bytes[i + 4] % PAIR_CODE_ALPHABET.length];
  }
  return `CHAT-${part1}-${part2}`;
}

function normalizePairCode(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = cleaned.startsWith('CHAT') ? cleaned.slice(4) : cleaned;
  if (body.length !== 8) return '';
  return `CHAT-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

function buildMessagePreview(record) {
  if (!record) return '';
  if (record.type === 'voice') return '🎤 Tin nhắn thoại';
  if (record.type === 'meme') return record.isSticker ? '✨ Nhãn dán' : '🖼️ Meme';
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

class ConnectionManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxHistory=40]
   * @param {object|null} [opts.redisManager=null]
   */
  constructor({ maxHistory = MAX_PAIR_HISTORY, redisManager = null } = {}) {
    this.maxHistory = Math.min(50, Math.max(30, maxHistory));
    this.redisManager = redisManager;

    /** @type {Map<string, object>} pairId -> Pair (in-memory store) */
    this.pairs = new Map();
    /** @type {Map<string, string>} pairCode -> pairId (in-memory index) */
    this.codeToPairId = new Map();

    /**
     * Trạng thái tạm thời của từng phòng chat 1-1 đang mở:
     * chatRoomId -> {
     *   votes: Set<clientId>,
     *   pairId: string | null,
     *   slotByClientId: Map<clientId, 'A' | 'B'>,
     *   recentBuffer: Array<object>
     * }
     */
    this.activeRooms = new Map();

    /** @type {Map<string, string>} pairId -> chatRoomId (phòng 1-1 đang mở cho cặp này) */
    this.activePairRoom = new Map();

    /**
     * Phòng hẹn chờ cho cặp kết nối khi 1 bên vào trước (hoặc nhập mã hẹn gặp lại):
     * pairId -> { clientId, slot: 'A'|'B', nickname, avatar, mood, interests, deviceId, createdAt }
     */
    this.waitingSlots = new Map();
    /** @type {Map<string, string>} clientId -> pairId (tra cứu nhanh người đang đợi trong phòng hẹn) */
    this.clientWaitingPair = new Map();

    /**
     * Lời mời kết nối lại đang chờ phản hồi:
     * inviteId -> { inviteId, pairId, fromClientId, fromSlot, toClientId, toSlot, createdAt }
     */
    this.pendingInvites = new Map();

    /** Chống đoán mã: clientId -> number[] timestamps */
    this.codeAttemptTimestamps = new Map();
  }

  get _useRedis() {
    return Boolean(this.redisManager && this.redisManager.enabled);
  }

  _requireRedisClient() {
    if (!this.redisManager || !this.redisManager.isConnected || !this.redisManager.pubClient) {
      throw new Error('REDIS_UNAVAILABLE');
    }
    return this.redisManager.pubClient;
  }

  // ─── Lưu / Đọc Pair (In-memory hoặc Redis) ──────────────────────────────────

  async _savePairMeta(pair) {
    const meta = {
      pairId: pair.pairId,
      pairCode: pair.pairCode,
      createdAt: pair.createdAt,
      lastActiveAt: pair.lastActiveAt,
      slots: pair.slots,
    };

    if (!this._useRedis) {
      this.pairs.set(pair.pairId, {
        ...meta,
        history: Array.isArray(pair.history) ? pair.history.slice(-this.maxHistory) : [],
      });
      this.codeToPairId.set(pair.pairCode, pair.pairId);
      return;
    }

    const redis = this._requireRedisClient();
    const pipeline = redis.pipeline();
    pipeline.set(REDIS_KEYS.meta(pair.pairId), JSON.stringify(meta), 'EX', PAIR_TTL_SECONDS);
    pipeline.set(REDIS_KEYS.code(pair.pairCode), pair.pairId, 'EX', PAIR_TTL_SECONDS);
    await pipeline.exec();
  }

  async _loadPair(pairId, { includeHistory = true } = {}) {
    if (!pairId) return null;

    if (!this._useRedis) {
      const p = this.pairs.get(pairId);
      if (!p) return null;
      return includeHistory
        ? { ...p, history: [...p.history] }
        : { ...p, history: p.history };
    }

    const redis = this._requireRedisClient();
    const rawMeta = await redis.get(REDIS_KEYS.meta(pairId));
    if (!rawMeta) return null;
    const meta = JSON.parse(rawMeta);
    let history = [];
    if (includeHistory) {
      const rawItems = await redis.lrange(REDIS_KEYS.history(pairId), -this.maxHistory, -1);
      history = (rawItems || []).map((item) => {
        try {
          return JSON.parse(item);
        } catch (_) {
          return null;
        }
      }).filter(Boolean);
    }
    return { ...meta, history };
  }

  async _findPairIdByCode(pairCode) {
    const normalized = normalizePairCode(pairCode);
    if (!normalized) return null;

    if (!this._useRedis) {
      return this.codeToPairId.get(normalized) || null;
    }

    const redis = this._requireRedisClient();
    return (await redis.get(REDIS_KEYS.code(normalized))) || null;
  }

  async _appendHistoryRecords(pairId, records) {
    if (!pairId || !Array.isArray(records) || records.length === 0) return;

    if (!this._useRedis) {
      const pair = this.pairs.get(pairId);
      if (!pair) return;
      pair.history.push(...records);
      if (pair.history.length > this.maxHistory) {
        pair.history = pair.history.slice(-this.maxHistory);
      }
      pair.lastActiveAt = Date.now();
      return;
    }

    const redis = this._requireRedisClient();
    const serialized = records.map((r) => JSON.stringify(r));
    const pipeline = redis.pipeline();
    pipeline.rpush(REDIS_KEYS.history(pairId), ...serialized);
    pipeline.ltrim(REDIS_KEYS.history(pairId), -this.maxHistory, -1);
    pipeline.expire(REDIS_KEYS.history(pairId), PAIR_TTL_SECONDS);
    pipeline.expire(REDIS_KEYS.meta(pairId), PAIR_TTL_SECONDS);
    await pipeline.exec();
  }

  async _deletePairStorage(pair) {
    if (!pair) return;
    if (!this._useRedis) {
      this.pairs.delete(pair.pairId);
      this.codeToPairId.delete(pair.pairCode);
      return;
    }

    const redis = this._requireRedisClient();
    const pipeline = redis.pipeline();
    pipeline.del(REDIS_KEYS.meta(pair.pairId));
    pipeline.del(REDIS_KEYS.code(pair.pairCode));
    pipeline.del(REDIS_KEYS.history(pair.pairId));
    await pipeline.exec();
  }

  // ─── Quản lý vòng đời phòng 1-1 & Bộ đệm tin nhắn tạm ───────────────────────

  /**
   * Khởi tạo trạng thái Giữ kết nối cho một phòng chat 1-1 mới.
   * Nếu phòng này được mở lại từ 1 cặp đã giữ sẵn (`existingPair`), gắn luôn pairId + slotByClientId.
   */
  initRoomSession(chatRoomId, clientAId, clientBId, existingPair = null) {
    if (!chatRoomId) return;
    const slotByClientId = new Map([
      [clientAId, 'A'],
      [clientBId, 'B'],
    ]);
    const votes = new Set();
    let pairId = null;

    if (existingPair && existingPair.pairId) {
      pairId = existingPair.pairId;
      votes.add(clientAId);
      votes.add(clientBId);
      this.activePairRoom.set(pairId, chatRoomId);
    }

    this.activeRooms.set(chatRoomId, {
      votes,
      pairId,
      slotByClientId,
      recentBuffer: [],
    });
  }

  getRoomSession(chatRoomId) {
    return this.activeRooms.get(chatRoomId) || null;
  }

  getActiveRoomForPair(pairId) {
    return this.activePairRoom.get(pairId) || null;
  }

  /**
   * Ghi nhận 1 tin nhắn trong phòng 1-1:
   * - Nếu phòng CHƯA giữ kết nối: lưu tạm vào recentBuffer trong RAM (tối đa maxHistory, tự xóa khi thoát).
   * - Nếu phòng ĐÃ giữ kết nối: lưu thẳng vào lịch sử của cặp (tối đa maxHistory tin gần nhất).
   */
  async recordRoomMessage(chatRoomId, senderClientId, msgData) {
    const session = this.activeRooms.get(chatRoomId);
    if (!session) return;

    const senderSlot = session.slotByClientId.get(senderClientId) || 'A';
    const record = {
      id: msgData.id || uuidv4(),
      type: msgData.type || 'message', // 'message' | 'voice' | 'meme'
      senderSlot,
      timestamp: msgData.timestamp || new Date().toISOString(),
    };

    if (record.type === 'message') {
      record.text = msgData.text;
      if (msgData.linkSafety) record.linkSafety = msgData.linkSafety;
    } else if (record.type === 'voice') {
      record.voiceId = msgData.voiceId;
      record.url = msgData.url;
      record.duration = msgData.duration;
    } else if (record.type === 'meme') {
      record.memeId = msgData.memeId;
      record.url = msgData.url;
      record.title = msgData.title;
      record.isSticker = Boolean(msgData.isSticker);
    }

    if (session.pairId) {
      await this._appendHistoryRecords(session.pairId, [record]);
    } else {
      session.recentBuffer.push(record);
      if (session.recentBuffer.length > this.maxHistory) {
        session.recentBuffer.shift();
      }
    }
  }

  /**
   * Dọn dẹp trạng thái tạm khi phòng 1-1 kết thúc.
   * Nếu chưa đạt đồng thuận 2 chiều -> recentBuffer bị xóa sạch hoàn toàn!
   */
  cleanupRoomSession(chatRoomId) {
    const session = this.activeRooms.get(chatRoomId);
    if (!session) return null;
    this.activeRooms.delete(chatRoomId);
    if (session.pairId && this.activePairRoom.get(session.pairId) === chatRoomId) {
      this.activePairRoom.delete(session.pairId);
    }
    return session;
  }

  // ─── Bình chọn "Giữ kết nối" 2 chiều trong phòng 1-1 ───────────────────────

  /**
   * Người dùng bấm chọn / bỏ chọn "Giữ kết nối" khi đang chat 1-1.
   * Chỉ tạo cặp kết nối & mã hẹn gặp lại khi CẢ 2 cùng chọn!
   */
  async setKeepVote(chatRoomId, voterClient, partnerClient, keep) {
    let session = this.activeRooms.get(chatRoomId);
    if (!session) {
      this.initRoomSession(chatRoomId, voterClient.clientId, partnerClient.clientId);
      session = this.activeRooms.get(chatRoomId);
    }

    // Nếu phòng đã được giữ kết nối rồi mà một bên bấm Bỏ giữ -> hủy cặp kết nối luôn
    if (session.pairId) {
      if (keep) {
        const existingPair = await this._loadPair(session.pairId, { includeHistory: true });
        if (existingPair) {
          return {
            ok: true,
            isKept: true,
            justActivated: false,
            justCancelled: false,
            keepCount: 2,
            pair: existingPair,
            voterVote: true,
            partnerVote: true,
          };
        }
      } else {
        const cancelledPairId = session.pairId;
        await this.removePairById(cancelledPairId);
        session.pairId = null;
        session.votes.clear();
        session.recentBuffer = [];
        return {
          ok: true,
          isKept: false,
          justActivated: false,
          justCancelled: true,
          cancelledPairId,
          keepCount: 0,
          voterVote: false,
          partnerVote: false,
        };
      }
    }

    if (keep) {
      session.votes.add(voterClient.clientId);
    } else {
      session.votes.delete(voterClient.clientId);
    }

    const voterVote = session.votes.has(voterClient.clientId);
    const partnerVote = session.votes.has(partnerClient.clientId);
    const keepCount = (voterVote ? 1 : 0) + (partnerVote ? 1 : 0);

    // Chưa đủ 2/2 -> chỉ cập nhật trạng thái chờ
    if (keepCount < 2) {
      return {
        ok: true,
        isKept: false,
        justActivated: false,
        justCancelled: false,
        keepCount,
        voterVote,
        partnerVote,
      };
    }

    // ĐỦ 2/2 -> Kích hoạt Giữ kết nối ẩn danh 2 chiều + Mã hẹn gặp lại!
    const slotOfVoter = session.slotByClientId.get(voterClient.clientId) || 'A';
    const userA = slotOfVoter === 'A' ? voterClient : partnerClient;
    const userB = slotOfVoter === 'A' ? partnerClient : voterClient;

    let pairCode = generatePairCode();
    let guard = 0;
    while ((await this._findPairIdByCode(pairCode)) && guard < 10) {
      pairCode = generatePairCode();
      guard += 1;
    }

    const now = Date.now();
    const pair = {
      pairId: uuidv4(),
      pairCode,
      createdAt: now,
      lastActiveAt: now,
      slots: {
        A: {
          token: generatePairToken(),
          deviceKey: userA.deviceId || userA.clientId,
          nickname: userA.nickname || 'Người lạ',
          avatar: userA.avatar || '🦊',
          mood: userA.mood || 'ngau_nhien',
          interests: Array.isArray(userA.interests) ? [...userA.interests] : [],
        },
        B: {
          token: generatePairToken(),
          deviceKey: userB.deviceId || userB.clientId,
          nickname: userB.nickname || 'Người lạ',
          avatar: userB.avatar || '🦊',
          mood: userB.mood || 'ngau_nhien',
          interests: Array.isArray(userB.interests) ? [...userB.interests] : [],
        },
      },
      history: [...session.recentBuffer].slice(-this.maxHistory),
    };

    await this._savePairMeta(pair);
    if (pair.history.length > 0 && this._useRedis) {
      await this._appendHistoryRecords(pair.pairId, pair.history);
    }

    session.pairId = pair.pairId;
    session.recentBuffer = [];
    this.activePairRoom.set(pair.pairId, chatRoomId);

    const passA = this.buildPassForSlot(pair, 'A');
    const passB = this.buildPassForSlot(pair, 'B');

    console.log(`[Connection] ★ Mutual keep activated: ${pair.pairCode} (${userA.nickname} ↔ ${userB.nickname}, seeded ${pair.history.length} msgs)`);

    return {
      ok: true,
      isKept: true,
      justActivated: true,
      justCancelled: false,
      keepCount: 2,
      pair,
      voterVote: true,
      partnerVote: true,
      passes: [
        { clientId: userA.clientId, pass: passA },
        { clientId: userB.clientId, pass: passB },
      ],
    };
  }

  buildPassForSlot(pair, slot) {
    const otherSlot = slot === 'A' ? 'B' : 'A';
    const me = pair.slots[slot];
    const partner = pair.slots[otherSlot];
    const lastMsg = pair.history && pair.history.length > 0
      ? pair.history[pair.history.length - 1]
      : null;

    return {
      pairId: pair.pairId,
      pairCode: pair.pairCode,
      pairToken: me.token,
      mySlot: slot,
      partnerNickname: partner.nickname,
      partnerAvatar: partner.avatar || '🦊',
      partnerMood: partner.mood || 'ngau_nhien',
      historyCount: Array.isArray(pair.history) ? pair.history.length : 0,
      lastMessagePreview: buildMessagePreview(lastMsg),
      createdAt: pair.createdAt,
      lastActiveAt: pair.lastActiveAt,
    };
  }

  // ─── Xác thực Pass / Mã hẹn gặp lại & Đồng bộ danh sách ─────────────────────

  /**
   * Kiểm tra rate-limit nhập mã hẹn (tối đa 6 lần / 30 giây mỗi kết nối).
   */
  checkCodeAttemptLimit(clientId) {
    const now = Date.now();
    const list = (this.codeAttemptTimestamps.get(clientId) || []).filter((ts) => now - ts < 30_000);
    if (list.length >= 6) {
      this.codeAttemptTimestamps.set(clientId, list);
      return false;
    }
    list.push(now);
    this.codeAttemptTimestamps.set(clientId, list);
    return true;
  }

  async verifyPass(pairId, pairToken) {
    const pair = await this._loadPair(pairId, { includeHistory: true });
    if (!pair) return null;
    if (pair.slots.A && safeTokenEquals(pair.slots.A.token, pairToken)) {
      return { pair, slot: 'A', otherSlot: 'B' };
    }
    if (pair.slots.B && safeTokenEquals(pair.slots.B.token, pairToken)) {
      return { pair, slot: 'B', otherSlot: 'A' };
    }
    return null;
  }

  /**
   * Tra cứu cặp kết nối bằng Mã hẹn gặp lại (hỗ trợ đổi thiết bị / trình duyệt khác).
   */
  async resolvePairByCode(pairCode, caller) {
    const normalized = normalizePairCode(pairCode);
    if (!normalized) {
      return { ok: false, code: 'INVALID_PAIR_CODE', error: 'Mã hẹn gặp lại không đúng định dạng (ví dụ: CHAT-ABCD-1234).' };
    }
    const pairId = await this._findPairIdByCode(normalized);
    if (!pairId) {
      return { ok: false, code: 'PAIR_NOT_FOUND', error: 'Không tìm thấy mã hẹn gặp lại này hoặc kết nối đã bị hủy.' };
    }
    const pair = await this._loadPair(pairId, { includeHistory: true });
    if (!pair) {
      return { ok: false, code: 'PAIR_NOT_FOUND', error: 'Kết nối này đã hết hạn hoặc bị hủy.' };
    }
    if (this.activePairRoom.has(pair.pairId)) {
      return { ok: false, code: 'PAIR_ALREADY_ACTIVE', error: 'Phòng hẹn của mã này hiện đã có đủ 2 người đang trò chuyện.' };
    }

    // Xác định slot cho người nhập mã:
    // 1. Khớp deviceId đã lưu trước đó
    let slot = null;
    if (caller.deviceId) {
      if (pair.slots.A.deviceKey === caller.deviceId) slot = 'A';
      else if (pair.slots.B.deviceKey === caller.deviceId) slot = 'B';
    }

    // 2. Nếu có người kia đang đợi sẵn trong phòng hẹn -> lấy slot còn lại
    const waiting = this.waitingSlots.get(pair.pairId);
    if (!slot && waiting) {
      if (waiting.clientId === caller.clientId) {
        slot = waiting.slot;
      } else {
        slot = waiting.slot === 'A' ? 'B' : 'A';
      }
    }

    // 3. Khớp biệt danh (nếu đổi máy nhưng đặt lại đúng biệt danh cũ)
    if (!slot && caller.nickname) {
      const lower = caller.nickname.trim().toLowerCase();
      const matchA = pair.slots.A.nickname.trim().toLowerCase() === lower;
      const matchB = pair.slots.B.nickname.trim().toLowerCase() === lower;
      if (matchA && !matchB) slot = 'A';
      else if (matchB && !matchA) slot = 'B';
    }

    // 4. Mặc định slot A nếu chưa ai vào
    if (!slot) slot = 'A';

    // Cập nhật thông tin thiết bị mới cho slot này (để lần sau đồng bộ tự động luôn trên máy mới!)
    if (caller.deviceId) {
      pair.slots[slot].deviceKey = caller.deviceId;
    }
    if (caller.nickname) {
      pair.slots[slot].nickname = caller.nickname;
    }
    if (caller.avatar) {
      pair.slots[slot].avatar = caller.avatar;
    }
    if (caller.mood) {
      pair.slots[slot].mood = caller.mood;
    }
    pair.lastActiveAt = Date.now();
    await this._savePairMeta(pair);

    return {
      ok: true,
      pair,
      slot,
      otherSlot: slot === 'A' ? 'B' : 'A',
      pass: this.buildPassForSlot(pair, slot),
    };
  }

  /**
   * Cập nhật biệt danh / avatar mới nhất của 1 slot khi người dùng online lại.
   */
  async updateSlotProfile(pair, slot, user) {
    if (!pair || !pair.slots[slot] || !user) return;
    let changed = false;
    if (user.nickname && pair.slots[slot].nickname !== user.nickname) {
      pair.slots[slot].nickname = user.nickname;
      changed = true;
    }
    if (user.avatar && pair.slots[slot].avatar !== user.avatar) {
      pair.slots[slot].avatar = user.avatar;
      changed = true;
    }
    if (user.mood && pair.slots[slot].mood !== user.mood) {
      pair.slots[slot].mood = user.mood;
      changed = true;
    }
    if (user.deviceId && pair.slots[slot].deviceKey !== user.deviceId) {
      pair.slots[slot].deviceKey = user.deviceId;
      changed = true;
    }
    if (changed) {
      pair.lastActiveAt = Date.now();
      await this._savePairMeta(pair);
    }
  }

  /**
   * Đồng bộ danh sách các kết nối đã lưu từ localStorage của client.
   * @param {Array<{ pairId: string, pairToken: string }>} passes
   * @param {function(object, string): { online: boolean, busy: boolean, waitingInPair: boolean }} getPartnerPresence
   */
  async syncSavedPairs(passes = [], getPartnerPresence = () => ({ online: false, busy: false, waitingInPair: false })) {
    const connections = [];
    const expiredPairIds = [];
    const seen = new Set();

    for (const item of (passes || []).slice(0, MAX_SAVED_PAIR_PASSES)) {
      if (!item || !item.pairId || !item.pairToken || seen.has(item.pairId)) continue;
      seen.add(item.pairId);

      const verified = await this.verifyPass(item.pairId, item.pairToken);
      if (!verified) {
        expiredPairIds.push(item.pairId);
        continue;
      }

      const { pair, slot, otherSlot } = verified;
      const base = this.buildPassForSlot(pair, slot);
      const presence = getPartnerPresence(pair, otherSlot);
      connections.push({
        ...base,
        partnerOnline: Boolean(presence.online),
        partnerBusy: Boolean(presence.busy),
        partnerWaitingInPair: Boolean(presence.waitingInPair),
      });
    }

    connections.sort((a, b) => {
      const aScore = a.partnerWaitingInPair ? 3 : (a.partnerOnline ? 2 : 1);
      const bScore = b.partnerWaitingInPair ? 3 : (b.partnerOnline ? 2 : 1);
      if (bScore !== aScore) return bScore - aScore;
      return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
    });

    return { connections, expiredPairIds };
  }

  /**
   * Định dạng lịch sử tin nhắn (30–50 tin gần nhất) theo góc nhìn của slot ('A' hoặc 'B').
   */
  formatHistoryForSlot(pair, slot) {
    if (!pair || !Array.isArray(pair.history)) return [];
    return pair.history.slice(-this.maxHistory).map((item) => ({
      ...item,
      direction: item.senderSlot === slot ? 'sent' : 'received',
    }));
  }

  // ─── Phòng hẹn chờ riêng (Waiting Room theo cặp) ────────────────────────────

  setWaitingSlot(pairId, entry) {
    // Nếu client đang đợi ở cặp khác -> gỡ bỏ trước
    this.clearWaitingByClient(entry.clientId);
    this.waitingSlots.set(pairId, { ...entry, createdAt: Date.now() });
    this.clientWaitingPair.set(entry.clientId, pairId);
  }

  getWaitingSlot(pairId) {
    return this.waitingSlots.get(pairId) || null;
  }

  clearWaitingPair(pairId) {
    const existing = this.waitingSlots.get(pairId);
    if (existing) {
      this.waitingSlots.delete(pairId);
      if (this.clientWaitingPair.get(existing.clientId) === pairId) {
        this.clientWaitingPair.delete(existing.clientId);
      }
    }
    return existing || null;
  }

  clearWaitingByClient(clientId) {
    const pairId = this.clientWaitingPair.get(clientId);
    if (!pairId) return null;
    this.clientWaitingPair.delete(clientId);
    const existing = this.waitingSlots.get(pairId);
    if (existing && existing.clientId === clientId) {
      this.waitingSlots.delete(pairId);
      return { pairId, ...existing };
    }
    return null;
  }

  // ─── Lời mời kết nối lại trực tiếp ──────────────────────────────────────────

  createInvite({ pairId, fromClientId, fromSlot, toClientId, toSlot }) {
    // Xóa lời mời cũ trùng cặp nếu có
    for (const [id, inv] of this.pendingInvites.entries()) {
      if (inv.pairId === pairId) this.pendingInvites.delete(id);
    }
    const inviteId = uuidv4();
    const invite = {
      inviteId,
      pairId,
      fromClientId,
      fromSlot,
      toClientId,
      toSlot,
      createdAt: Date.now(),
    };
    this.pendingInvites.set(inviteId, invite);
    return invite;
  }

  consumeInvite(inviteId) {
    const inv = this.pendingInvites.get(inviteId) || null;
    if (inv) this.pendingInvites.delete(inviteId);
    return inv;
  }

  clearInvitesForClient(clientId) {
    const removed = [];
    for (const [id, inv] of this.pendingInvites.entries()) {
      if (inv.fromClientId === clientId || inv.toClientId === clientId) {
        this.pendingInvites.delete(id);
        removed.push(inv);
      }
    }
    return removed;
  }

  // ─── Hủy Giữ kết nối (xóa vĩnh viễn ở cả 2 phía) ───────────────────────────

  async removePairByPass(pairId, pairToken) {
    const verified = await this.verifyPass(pairId, pairToken);
    if (!verified) return { ok: false, error: 'Kết nối không tồn tại hoặc đã bị hủy.' };
    return this.removePairById(verified.pair.pairId);
  }

  async removePairById(pairId) {
    const pair = await this._loadPair(pairId, { includeHistory: false });
    if (!pair) return { ok: false, error: 'Kết nối không tồn tại hoặc đã bị hủy.' };

    await this._deletePairStorage(pair);
    this.clearWaitingPair(pairId);

    for (const [id, inv] of this.pendingInvites.entries()) {
      if (inv.pairId === pairId) this.pendingInvites.delete(id);
    }

    const activeChatRoomId = this.activePairRoom.get(pairId) || null;
    if (activeChatRoomId) {
      this.activePairRoom.delete(pairId);
      const roomSess = this.activeRooms.get(activeChatRoomId);
      if (roomSess) {
        roomSess.pairId = null;
        roomSess.votes.clear();
        roomSess.recentBuffer = [];
      }
    }

    console.log(`[Connection] -Pair ${pair.pairCode} removed permanently`);
    return {
      ok: true,
      pairId: pair.pairId,
      pairCode: pair.pairCode,
      slots: pair.slots,
      activeChatRoomId,
    };
  }

  clearClient(clientId) {
    this.clearWaitingByClient(clientId);
    this.clearInvitesForClient(clientId);
    this.codeAttemptTimestamps.delete(clientId);
  }

  destroy() {
    this.pairs.clear();
    this.codeToPairId.clear();
    this.activeRooms.clear();
    this.activePairRoom.clear();
    this.waitingSlots.clear();
    this.clientWaitingPair.clear();
    this.pendingInvites.clear();
    this.codeAttemptTimestamps.clear();
  }
}

module.exports = {
  ConnectionManager,
  MAX_PAIR_HISTORY,
  PAIR_TTL_SECONDS,
  MAX_SAVED_PAIR_PASSES,
  PAIR_CODE_REGEX,
  normalizePairCode,
};

