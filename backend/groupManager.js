/**
 * groupManager.js – Quản lý phòng trò chuyện ẩn danh theo nhóm
 *
 * Tính năng cốt lõi:
 *   1. Chọn nhóm theo chủ đề / sở thích (mode: 'topic') hoặc ngẫu nhiên (mode: 'random').
 *   2. Sức chứa tối đa mặc định 60 thành viên / nhóm (cấu hình qua MAX_GROUP_MEMBERS).
 *   3. Tự động biến mất khi tất cả thành viên rời khỏi nhóm nếu chưa đủ 3 người chọn giữ lại.
 *   4. Cơ chế bình chọn giữ nhóm (MIN_KEEP_VOTES = 3):
 *      - Mỗi thành viên có thể chọn/bỏ chọn giữ lại nhóm.
 *      - Khi có ít nhất 3 thành viên cùng chọn giữ lại: nhóm được bảo lưu (dormant khi trống)
 *        để các thành viên đã chọn giữ có thể quay lại trò chuyện tiếp lần sau.
 *      - Nếu số người giữ giảm xuống dưới 3 và không còn ai trong phòng: nhóm tự động bị xóa.
 *   5. Hỗ trợ đồng thời chế độ In-Memory (đơn instance) và Redis (đa instance).
 */

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
  resolveRoomNickname,
  extractMentions,
  stripVietnameseTones,
} = require('./nicknameResolver');
const { safeTokenEquals } = require('./security');

// ─── Hằng số cấu hình ────────────────────────────────────────────────────────

const configuredMaxMembers = Number(process.env.MAX_GROUP_MEMBERS);
const DEFAULT_MAX_GROUP_MEMBERS = (
  Number.isSafeInteger(configuredMaxMembers)
  && configuredMaxMembers >= 3
  && configuredMaxMembers <= 100
)
  ? configuredMaxMembers
  : 60;

/** Số thành viên tối thiểu cần đồng ý để giữ lại nhóm */
const MIN_KEEP_VOTES = 3;

/** Số tin nhắn gần nhất lưu lại cho nhóm ĐÃ ĐƯỢC GIỮ (nhóm tạm không lưu khi biến mất) */
const MAX_KEPT_HISTORY = 50;

/** Thời gian tối đa giữ nhóm ở trạng thái ngủ đông không có hoạt động (7 ngày) */
const DORMANT_KEPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DORMANT_KEPT_TTL_SECONDS = Math.floor(DORMANT_KEPT_TTL_MS / 1000);

/** Giới hạn độ dài chủ đề / tên nhóm */
const MAX_GROUP_TOPIC_LENGTH = 60;
const MAX_GROUP_NAME_LENGTH = 60;

// ─── Tiện ích chuẩn hóa chủ đề & tính điểm tương thích ──────────────────────

function tokenizeTopic(str) {
  const normalized = stripVietnameseTones(str);
  if (!normalized) return [];
  return [...new Set(
    normalized
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2)
  )];
}

function buildGroupName(mode, topic, interests) {
  const cleanTopic = typeof topic === 'string' ? topic.trim() : '';
  if (mode === 'topic') {
    if (cleanTopic) {
      return cleanTopic.slice(0, MAX_GROUP_NAME_LENGTH);
    }
    if (Array.isArray(interests) && interests.length > 0) {
      const label = interests
        .slice(0, 2)
        .map((item) => item.charAt(0).toUpperCase() + item.slice(1))
        .join(' & ');
      return `Nhóm ${label}`.slice(0, MAX_GROUP_NAME_LENGTH);
    }
    return 'Nhóm Chủ Đề Chung';
  }
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `Nhóm Ngẫu Nhiên #${suffix}`;
}

function generateRejoinToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─── Redis key helpers ───────────────────────────────────────────────────────

const REDIS_KEYS = {
  index: 'chat:{group}:index',
  meta: (groupId) => `chat:{group}:meta:${groupId}`,
  members: (groupId) => `chat:{group}:members:${groupId}`,
  keeps: (groupId) => `chat:{group}:keeps:${groupId}`,
  history: (groupId) => `chat:{group}:history:${groupId}`,
};

// ─── Class GroupManager ──────────────────────────────────────────────────────

class GroupManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxMembers=60]
   * @param {number} [opts.minKeepVotes=3]
   * @param {object|null} [opts.redisManager=null]
   */
  constructor({
    maxMembers = DEFAULT_MAX_GROUP_MEMBERS,
    minKeepVotes = MIN_KEEP_VOTES,
    redisManager = null,
  } = {}) {
    this.maxMembers = maxMembers;
    this.minKeepVotes = minKeepVotes;
    this.redisManager = redisManager;

    /** In-memory storage (dùng cho đơn instance) */
    /** @type {Map<string, object>} groupId -> Group */
    this.groups = new Map();

    /** Tra cứu nhanh local: clientId -> groupId */
    /** @type {Map<string, string>} */
    this.clientGroupMap = new Map();

    /** Danh sách clientId đang kết nối tại instance này theo groupId (để broadcast O(1) qua Redis Pub/Sub) */
    /** @type {Map<string, Set<string>>} */
    this.localGroupClients = new Map();
  }

  get _useRedis() {
    return Boolean(this.redisManager && this.redisManager.enabled);
  }

  _requireRedisClient() {
    if (!this.redisManager || !this.redisManager.isConnected || !this.redisManager.pubClient) {
      throw new Error('Redis chưa sẵn sàng để xử lý trò chuyện nhóm.');
    }
    return this.redisManager.pubClient;
  }

  // ─── Local membership tracking (cả in-memory lẫn multi-instance) ───────────

  _trackLocalClient(groupId, clientId) {
    this.clientGroupMap.set(clientId, groupId);
    if (!this.localGroupClients.has(groupId)) {
      this.localGroupClients.set(groupId, new Set());
    }
    this.localGroupClients.get(groupId).add(clientId);
  }

  _untrackLocalClient(clientId) {
    const groupId = this.clientGroupMap.get(clientId);
    if (!groupId) return null;
    this.clientGroupMap.delete(clientId);
    const set = this.localGroupClients.get(groupId);
    if (set) {
      set.delete(clientId);
      if (set.size === 0) {
        this.localGroupClients.delete(groupId);
      }
    }
    return groupId;
  }

  getGroupId(clientId) {
    return this.clientGroupMap.get(clientId) || null;
  }

  isInGroup(clientId) {
    return this.clientGroupMap.has(clientId);
  }

  getLocalClientIds(groupId) {
    const set = this.localGroupClients.get(groupId);
    return set ? [...set] : [];
  }

  // ─── Serialization helpers ─────────────────────────────────────────────────

  _serializeMember(member) {
    return {
      clientId: member.clientId,
      nickname: member.nickname,
      avatar: member.avatar || '🦊',
      mood: member.mood || 'ngau_nhien',
      interests: Array.isArray(member.interests) ? member.interests : [],
      joinedAt: member.joinedAt,
      wantsKeep: Boolean(member.wantsKeep),
    };
  }

  _buildSnapshot(group, viewerMemberKey = null) {
    const keepMap = group.keepVotes instanceof Map
      ? group.keepVotes
      : new Map(Object.entries(group.keepVotes || {}));
    const memberList = group.members instanceof Map
      ? [...group.members.values()]
      : Object.values(group.members || {});

    const members = memberList
      .map((m) => this._serializeMember({
        ...m,
        wantsKeep: keepMap.has(m.memberKey),
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt);

    const myVote = viewerMemberKey ? keepMap.get(viewerMemberKey) || null : null;
    const isKept = keepMap.size >= this.minKeepVotes;

    return {
      groupId: group.groupId,
      name: group.name,
      mode: group.mode,
      topic: group.topic || '',
      interests: [...(group.interests || [])],
      mood: group.mood || 'ngau_nhien',
      maxMembers: group.maxMembers || this.maxMembers,
      memberCount: members.length,
      members,
      keepCount: keepMap.size,
      minKeepVotes: this.minKeepVotes,
      isKept,
      isPrivateKept: Boolean(group.isPrivateKept),
      myKeepVote: Boolean(myVote),
      myRejoinToken: myVote ? myVote.rejoinToken : null,
      status: members.length > 0 ? 'active' : 'dormant',
      createdAt: group.createdAt,
      history: isKept ? [...(group.history || [])] : [],
    };
  }

  _buildSummary(group) {
    const keepCount = group.keepVotes instanceof Map
      ? group.keepVotes.size
      : Object.keys(group.keepVotes || {}).length;
    const memberCount = group.members instanceof Map
      ? group.members.size
      : Object.keys(group.members || {}).length;

    return {
      groupId: group.groupId,
      name: group.name,
      mode: group.mode,
      topic: group.topic || '',
      interests: [...(group.interests || [])],
      mood: group.mood || 'ngau_nhien',
      maxMembers: group.maxMembers || this.maxMembers,
      memberCount,
      keepCount,
      minKeepVotes: this.minKeepVotes,
      isKept: keepCount >= this.minKeepVotes,
      isPrivateKept: Boolean(group.isPrivateKept),
      status: memberCount > 0 ? 'active' : 'dormant',
      createdAt: group.createdAt,
      lastActivityAt: group.lastActivityAt,
    };
  }

  // ─── Tính điểm khớp chủ đề / sở thích ────────────────────────────────────

  _computeTopicScore(group, { topic = '', interests = [], mood = 'ngau_nhien' }) {
    let score = 0;

    const reqTopicNorm = stripVietnameseTones(topic);
    const groupTopicNorm = stripVietnameseTones(group.topic || '');
    const groupNameNorm = stripVietnameseTones(group.name || '');

    if (reqTopicNorm && groupTopicNorm) {
      if (reqTopicNorm === groupTopicNorm) {
        score += 10;
      } else if (groupTopicNorm.includes(reqTopicNorm) || reqTopicNorm.includes(groupTopicNorm)) {
        score += 6;
      } else {
        const reqTokens = tokenizeTopic(reqTopicNorm);
        const groupTokens = new Set(tokenizeTopic(groupTopicNorm));
        const sharedTokens = reqTokens.filter((t) => groupTokens.has(t));
        score += sharedTokens.length * 3;
      }
    } else if (reqTopicNorm && groupNameNorm.includes(reqTopicNorm)) {
      score += 4;
    }

    const reqInterests = (interests || []).map((i) => stripVietnameseTones(i)).filter(Boolean);
    const groupInterestsSet = new Set((group.interests || []).map((i) => stripVietnameseTones(i)).filter(Boolean));

    for (const interest of reqInterests) {
      if (groupInterestsSet.has(interest)) {
        score += 3;
      } else if (groupTopicNorm && (groupTopicNorm.includes(interest) || interest.includes(groupTopicNorm))) {
        score += 2;
      }
    }

    if (reqTopicNorm && groupInterestsSet.has(reqTopicNorm)) {
      score += 5;
    }

    if (mood && mood !== 'ngau_nhien' && group.mood && group.mood === mood) {
      score += 1;
    }

    return score;
  }

  // ─── Redis load / save helpers ─────────────────────────────────────────────

  async _redisLoadGroup(groupId) {
    const redis = this._requireRedisClient();
    const pipeline = redis.pipeline();
    pipeline.get(REDIS_KEYS.meta(groupId));
    pipeline.hgetall(REDIS_KEYS.members(groupId));
    pipeline.hgetall(REDIS_KEYS.keeps(groupId));
    pipeline.lrange(REDIS_KEYS.history(groupId), 0, MAX_KEPT_HISTORY - 1);

    const results = await pipeline.exec();
    const rawMeta = results[0] && results[0][1];
    if (!rawMeta) return null;

    const meta = JSON.parse(rawMeta);
    const rawMembers = (results[1] && results[1][1]) || {};
    const rawKeeps = (results[2] && results[2][1]) || {};
    const rawHistory = (results[3] && results[3][1]) || [];

    const members = new Map();
    for (const [cid, json] of Object.entries(rawMembers)) {
      try {
        members.set(cid, JSON.parse(json));
      } catch {
        // Bỏ qua bản ghi hỏng
      }
    }

    const keepVotes = new Map();
    for (const [mKey, json] of Object.entries(rawKeeps)) {
      try {
        keepVotes.set(mKey, JSON.parse(json));
      } catch {
        // Bỏ qua bản ghi hỏng
      }
    }

    const history = [];
    for (const item of rawHistory) {
      try {
        history.push(JSON.parse(item));
      } catch {
        // Bỏ qua bản ghi hỏng
      }
    }

    return {
      ...meta,
      members,
      keepVotes,
      kickedKeys: new Set(meta.kickedKeys || []),
      nicknameCounters: new Map(Object.entries(meta.nicknameCounters || {})),
      isKept: keepVotes.size >= this.minKeepVotes,
      history,
    };
  }

  async _redisSaveMeta(group) {
    const redis = this._requireRedisClient();
    const meta = {
      groupId: group.groupId,
      name: group.name,
      mode: group.mode,
      topic: group.topic || '',
      interests: [...(group.interests || [])],
      mood: group.mood || 'ngau_nhien',
      maxMembers: group.maxMembers || this.maxMembers,
      createdAt: group.createdAt,
      lastActivityAt: group.lastActivityAt,
      status: group.members.size > 0 ? 'active' : 'dormant',
      isKept: group.keepVotes.size >= this.minKeepVotes,
      isPrivateKept: Boolean(group.isPrivateKept),
      kickedKeys: [...(group.kickedKeys || [])],
      nicknameCounters: group.nicknameCounters instanceof Map
        ? Object.fromEntries(group.nicknameCounters)
        : (group.nicknameCounters || {}),
    };

    const p = redis.pipeline();
    p.sadd(REDIS_KEYS.index, group.groupId);
    p.set(REDIS_KEYS.meta(group.groupId), JSON.stringify(meta), 'EX', DORMANT_KEPT_TTL_SECONDS);
    p.expire(REDIS_KEYS.members(group.groupId), DORMANT_KEPT_TTL_SECONDS);
    p.expire(REDIS_KEYS.keeps(group.groupId), DORMANT_KEPT_TTL_SECONDS);
    if (meta.isKept) {
      p.expire(REDIS_KEYS.history(group.groupId), DORMANT_KEPT_TTL_SECONDS);
    } else {
      p.del(REDIS_KEYS.history(group.groupId));
    }
    await p.exec();
  }

  async _redisDeleteGroup(groupId) {
    const redis = this._requireRedisClient();
    await redis
      .multi()
      .srem(REDIS_KEYS.index, groupId)
      .del(
        REDIS_KEYS.meta(groupId),
        REDIS_KEYS.members(groupId),
        REDIS_KEYS.keeps(groupId),
        REDIS_KEYS.history(groupId)
      )
      .exec();
  }

  async _redisListAllGroups() {
    const redis = this._requireRedisClient();
    const groupIds = await redis.smembers(REDIS_KEYS.index);
    if (!groupIds || groupIds.length === 0) return [];

    const loaded = await Promise.all(groupIds.map((id) => this._redisLoadGroup(id)));
    const valid = [];
    const staleIds = [];

    for (let i = 0; i < groupIds.length; i++) {
      if (loaded[i]) {
        valid.push(loaded[i]);
      } else {
        staleIds.push(groupIds[i]);
      }
    }

    if (staleIds.length > 0) {
      redis.srem(REDIS_KEYS.index, ...staleIds).catch(() => {});
    }

    return valid;
  }

  // ─── API công khai ─────────────────────────────────────────────────────────

  /**
   * Tạo mới một phòng nhóm và đưa người tạo vào nhóm ngay lập tức.
   */
  async createGroup(user, options = {}) {
    const mode = options.mode === 'topic' ? 'topic' : 'random';
    const topic = typeof options.topic === 'string'
      ? options.topic.trim().slice(0, MAX_GROUP_TOPIC_LENGTH)
      : '';
    const interests = Array.isArray(options.interests)
      ? [...new Set(options.interests.map((i) => String(i).trim().toLowerCase()).filter(Boolean))].slice(0, 5)
      : [...(user.interests || [])];
    const mood = options.mood || user.mood || 'ngau_nhien';
    const customName = typeof options.name === 'string'
      ? options.name.trim().slice(0, MAX_GROUP_NAME_LENGTH)
      : '';

    const groupId = uuidv4();
    const now = Date.now();
    const memberKey = user.deviceId || user.clientId;
    const nicknameCounters = new Map();
    const resolved = resolveRoomNickname([], user.nickname, nicknameCounters);
    const memberRecord = {
      clientId: user.clientId,
      memberKey,
      baseNickname: resolved.baseNickname,
      nickname: resolved.displayName,
      nicknameNumber: resolved.nicknameNumber,
      avatar: user.avatar || '🦊',
      interests: [...(user.interests || [])],
      mood: user.mood || 'ngau_nhien',
      joinedAt: now,
      instanceId: this.redisManager ? this.redisManager.instanceId : 'local',
    };

    const group = {
      groupId,
      name: customName || buildGroupName(mode, topic, interests),
      mode,
      topic,
      interests,
      mood,
      maxMembers: this.maxMembers,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      members: new Map([[user.clientId, memberRecord]]),
      keepVotes: new Map(),
      nicknameCounters,
      isKept: false,
      isPrivateKept: false,
      kickedKeys: new Set(),
      history: [],
    };

    if (this._useRedis) {
      const redis = this._requireRedisClient();
      await redis.hset(REDIS_KEYS.members(groupId), user.clientId, JSON.stringify(memberRecord));
      await this._redisSaveMeta(group);
    } else {
      this.groups.set(groupId, group);
    }

    this._trackLocalClient(groupId, user.clientId);

    console.log(`[GroupManager] +Group ${groupId} ("${group.name}", mode=${mode}) created by ${memberRecord.nickname}`);
    return {
      ok: true,
      created: true,
      group: this._buildSnapshot(group, memberKey),
      member: this._serializeMember({ ...memberRecord, wantsKeep: false }),
      renamedMembers: [],
    };
  }

  /**
   * Tìm và vào nhóm phù hợp theo chủ đề/sở thích hoặc ngẫu nhiên;
   * nếu chưa có nhóm phù hợp đang mở và còn chỗ (< 60), tự động tạo nhóm mới.
   */
  async findOrCreateGroup(user, options = {}) {
    const mode = options.mode === 'topic' ? 'topic' : 'random';
    const topic = typeof options.topic === 'string'
      ? options.topic.trim().slice(0, MAX_GROUP_TOPIC_LENGTH)
      : '';
    const interests = Array.isArray(options.interests) && options.interests.length > 0
      ? [...new Set(options.interests.map((i) => String(i).trim().toLowerCase()).filter(Boolean))].slice(0, 5)
      : [...(user.interests || [])];
    const mood = options.mood || user.mood || 'ngau_nhien';
    const memberKey = user.deviceId || user.clientId;
    const excludeGroupId = options.excludeGroupId || null;

    const allGroups = this._useRedis
      ? await this._redisListAllGroups()
      : [...this.groups.values()];

    // Lọc các nhóm đang hoạt động, mở công khai (không phải nhóm đã giữ đang ngủ đông/riêng tư), còn chỗ < 60, không bị kick
    const openGroups = allGroups.filter((g) => (
      g.groupId !== excludeGroupId
      && g.members.size > 0
      && g.members.size < (g.maxMembers || this.maxMembers)
      && !g.isPrivateKept
      && !g.kickedKeys.has(memberKey)
    ));

    let chosenGroup = null;

    if (mode === 'topic') {
      const scored = [];
      for (const group of openGroups) {
        if (group.mode !== 'topic') continue;
        const score = this._computeTopicScore(group, { topic, interests, mood });
        if (score > 0) {
          scored.push({ group, score });
        }
      }

      if (scored.length > 0) {
        // Ưu tiên điểm tương thích cao nhất; bằng điểm thì ưu tiên nhóm đông hơn (để tụ họp dễ hơn) nhưng vẫn còn chỗ
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.group.members.size !== a.group.members.size) return b.group.members.size - a.group.members.size;
          return a.group.createdAt - b.group.createdAt;
        });
        chosenGroup = scored[0].group;
      }
    } else {
      // mode === 'random': ưu tiên các nhóm ngẫu nhiên đang mở và còn chỗ
      const randomCandidates = openGroups.filter((g) => g.mode === 'random');
      if (randomCandidates.length > 0) {
        // Chọn ngẫu nhiên trong nhóm có ít hơn 60 người (ưu tiên các nhóm chưa quá đông hoặc ngẫu nhiên đều)
        chosenGroup = randomCandidates[Math.floor(Math.random() * randomCandidates.length)];
      }
    }

    if (chosenGroup) {
      const joinRes = await this.joinGroupById(user, chosenGroup.groupId);
      if (joinRes.ok) {
        return { ...joinRes, created: false };
      }
      // Nếu vừa bị đầy ở khoảnh khắc đua nhau -> tạo nhóm mới
    }

    return this.createGroup(user, { mode, topic, interests, mood });
  }

  /**
   * Vào một nhóm công khai cụ thể theo groupId.
   */
  async joinGroupById(user, groupId) {
    if (!groupId || typeof groupId !== 'string') {
      return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Không tìm thấy nhóm trò chuyện.' };
    }

    const memberKey = user.deviceId || user.clientId;
    const group = this._useRedis
      ? await this._redisLoadGroup(groupId)
      : this.groups.get(groupId);

    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Nhóm không còn tồn tại hoặc đã tự động biến mất.' };
    }

    if (group.isPrivateKept && !group.keepVotes.has(memberKey)) {
      return { ok: false, code: 'GROUP_PRIVATE', error: 'Nhóm này chỉ dành cho các thành viên đã chọn giữ lại nhóm.' };
    }

    if (group.kickedKeys.has(memberKey)) {
      return { ok: false, code: 'GROUP_KICKED', error: 'Bạn đã bị buộc rời khỏi nhóm này do vi phạm trước đó.' };
    }

    if (group.members.has(user.clientId)) {
      return { ok: false, code: 'ALREADY_IN_GROUP', error: 'Bạn đã ở trong nhóm này rồi.' };
    }

    const maxCap = group.maxMembers || this.maxMembers;
    if (group.members.size >= maxCap) {
      return { ok: false, code: 'GROUP_FULL', error: `Nhóm đã đủ tối đa ${maxCap} thành viên.` };
    }

    const now = Date.now();
    if (!group.nicknameCounters) group.nicknameCounters = new Map();
    const resolved = resolveRoomNickname(group.members.values(), user.nickname, group.nicknameCounters);
    const memberRecord = {
      clientId: user.clientId,
      memberKey,
      baseNickname: resolved.baseNickname,
      nickname: resolved.displayName,
      nicknameNumber: resolved.nicknameNumber,
      avatar: user.avatar || '🦊',
      interests: [...(user.interests || [])],
      mood: user.mood || 'ngau_nhien',
      joinedAt: now,
      instanceId: this.redisManager ? this.redisManager.instanceId : 'local',
    };

    if (this._useRedis) {
      const redis = this._requireRedisClient();
      // Kiểm tra sức chứa nguyên tử qua Lua script để tránh vượt quá 60 thành viên ở cụm đa node
      const joinScript = `
        local metaKey = KEYS[1]
        local membersKey = KEYS[2]
        local maxCap = tonumber(ARGV[1])
        local clientId = ARGV[2]
        local payload = ARGV[3]
        if redis.call('EXISTS', metaKey) == 0 then return -1 end
        if redis.call('HEXISTS', membersKey, clientId) == 1 then return -2 end
        if redis.call('HLEN', membersKey) >= maxCap then return -3 end
        redis.call('HSET', membersKey, clientId, payload)
        return redis.call('HLEN', membersKey)
      `;
      const res = await redis.eval(
        joinScript,
        2,
        REDIS_KEYS.meta(groupId),
        REDIS_KEYS.members(groupId),
        String(maxCap),
        user.clientId,
        JSON.stringify(memberRecord)
      );
      if (res === -1) {
        return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Nhóm không còn tồn tại hoặc đã tự động biến mất.' };
      }
      if (res === -2) {
        return { ok: false, code: 'ALREADY_IN_GROUP', error: 'Bạn đã ở trong nhóm này rồi.' };
      }
      if (res === -3) {
        return { ok: false, code: 'GROUP_FULL', error: `Nhóm đã đủ tối đa ${maxCap} thành viên.` };
      }
      // Cập nhật tên hiển thị đã đánh số cho thành viên cũ nếu phát sinh trùng biệt danh
      if (resolved.renamedMembers.length > 0) {
        const p = redis.pipeline();
        for (const r of resolved.renamedMembers) {
          const existingMember = group.members.get(r.clientId);
          if (existingMember) {
            p.hset(REDIS_KEYS.members(groupId), r.clientId, JSON.stringify(existingMember));
          }
        }
        await p.exec();
      }
      group.members.set(user.clientId, memberRecord);
      group.status = 'active';
      group.lastActivityAt = now;
      await this._redisSaveMeta(group);
    } else {
      group.members.set(user.clientId, memberRecord);
      group.status = 'active';
      group.lastActivityAt = now;
    }

    this._trackLocalClient(groupId, user.clientId);

    const wantsKeep = group.keepVotes.has(memberKey);
    return {
      ok: true,
      group: this._buildSnapshot(group, memberKey),
      member: this._serializeMember({ ...memberRecord, wantsKeep }),
      renamedMembers: resolved.renamedMembers,
    };
  }

  /**
   * Vào lại nhóm ĐÃ ĐƯỢC GIỮ bằng groupId + rejoinToken.
   */
  async rejoinKeptGroup(user, groupId, rejoinToken) {
    if (!groupId || typeof rejoinToken !== 'string' || !rejoinToken.trim()) {
      return { ok: false, code: 'INVALID_REJOIN_TOKEN', error: 'Thông tin vào lại nhóm không hợp lệ.' };
    }

    const group = this._useRedis
      ? await this._redisLoadGroup(groupId)
      : this.groups.get(groupId);

    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Nhóm này không còn tồn tại hoặc đã tự động biến mất.' };
    }

    // Tìm voter khớp với rejoinToken (cho phép quay lại từ phiên/tab mới mà vẫn bảo toàn số phiếu giữ!)
    let matchedVoter = null;
    for (const voter of group.keepVotes.values()) {
      if (safeTokenEquals(voter.rejoinToken, rejoinToken)) {
        matchedVoter = voter;
        break;
      }
    }

    if (!matchedVoter) {
      return { ok: false, code: 'INVALID_REJOIN_TOKEN', error: 'Bạn không có quyền vào lại nhóm này hoặc đã bỏ giữ nhóm.' };
    }

    // Chỉ cho phép quay lại khi nhóm đã đạt >= 3 người giữ (hoặc phòng vẫn đang hoạt động)
    if (group.keepVotes.size < this.minKeepVotes && group.members.size === 0) {
      return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Nhóm chưa đủ 3 người giữ nên đã tự động biến mất.' };
    }

    if (group.kickedKeys.has(matchedVoter.memberKey) || (user.deviceId && group.kickedKeys.has(user.deviceId))) {
      return { ok: false, code: 'GROUP_KICKED', error: 'Bạn đã bị buộc rời khỏi nhóm này trước đó.' };
    }

    const maxCap = group.maxMembers || this.maxMembers;
    if (group.members.size >= maxCap) {
      return { ok: false, code: 'GROUP_FULL', error: `Nhóm đã đủ tối đa ${maxCap} thành viên.` };
    }

    const now = Date.now();
    // Dùng lại memberKey gốc gắn với phiếu giữ để tránh tạo phiếu giữ trùng khi user mở tab mới!
    const canonicalMemberKey = matchedVoter.memberKey;
    if (!group.nicknameCounters) group.nicknameCounters = new Map();
    const resolved = resolveRoomNickname(group.members.values(), user.nickname, group.nicknameCounters);
    const memberRecord = {
      clientId: user.clientId,
      memberKey: canonicalMemberKey,
      baseNickname: resolved.baseNickname,
      nickname: resolved.displayName,
      nicknameNumber: resolved.nicknameNumber,
      avatar: user.avatar || '🦊',
      interests: [...(user.interests || [])],
      mood: user.mood || 'ngau_nhien',
      joinedAt: now,
      instanceId: this.redisManager ? this.redisManager.instanceId : 'local',
    };

    // Cập nhật nickname/avatar mới nhất trong phiếu giữ
    matchedVoter.nickname = resolved.displayName;
    matchedVoter.avatar = user.avatar || '🦊';

    if (this._useRedis) {
      const redis = this._requireRedisClient();
      const joinScript = `
        local metaKey = KEYS[1]
        local membersKey = KEYS[2]
        local maxCap = tonumber(ARGV[1])
        local clientId = ARGV[2]
        local payload = ARGV[3]
        if redis.call('EXISTS', metaKey) == 0 then return -1 end
        if redis.call('HLEN', membersKey) >= maxCap then return -3 end
        redis.call('HSET', membersKey, clientId, payload)
        return redis.call('HLEN', membersKey)
      `;
      const res = await redis.eval(
        joinScript,
        2,
        REDIS_KEYS.meta(groupId),
        REDIS_KEYS.members(groupId),
        String(maxCap),
        user.clientId,
        JSON.stringify(memberRecord)
      );
      if (res === -1) {
        return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Nhóm này không còn tồn tại.' };
      }
      if (res === -3) {
        return { ok: false, code: 'GROUP_FULL', error: `Nhóm đã đủ tối đa ${maxCap} thành viên.` };
      }
      if (resolved.renamedMembers.length > 0) {
        const p = redis.pipeline();
        for (const r of resolved.renamedMembers) {
          const existingMember = group.members.get(r.clientId);
          if (existingMember) {
            p.hset(REDIS_KEYS.members(groupId), r.clientId, JSON.stringify(existingMember));
          }
        }
        await p.exec();
      }
      await redis.hset(REDIS_KEYS.keeps(groupId), canonicalMemberKey, JSON.stringify(matchedVoter));
      group.members.set(user.clientId, memberRecord);
      group.status = 'active';
      group.lastActivityAt = now;
      await this._redisSaveMeta(group);
    } else {
      group.members.set(user.clientId, memberRecord);
      group.status = 'active';
      group.lastActivityAt = now;
    }

    this._trackLocalClient(groupId, user.clientId);

    return {
      ok: true,
      group: this._buildSnapshot(group, canonicalMemberKey),
      member: this._serializeMember({ ...memberRecord, wantsKeep: true }),
      renamedMembers: resolved.renamedMembers,
    };
  }

  /**
   * Bình chọn giữ hoặc bỏ giữ nhóm cho thành viên đang ở trong nhóm.
   */
  async setKeepVote(clientId, wantsKeep) {
    const groupId = this.getGroupId(clientId);
    if (!groupId) {
      return { ok: false, code: 'NOT_IN_GROUP', error: 'Bạn chưa ở trong phòng nhóm nào.' };
    }

    const group = this._useRedis
      ? await this._redisLoadGroup(groupId)
      : this.groups.get(groupId);

    if (!group) {
      this._untrackLocalClient(clientId);
      return { ok: false, code: 'GROUP_NOT_FOUND', error: 'Nhóm không còn tồn tại.' };
    }

    const member = group.members.get(clientId);
    if (!member) {
      return { ok: false, code: 'NOT_IN_GROUP', error: 'Bạn không thuộc nhóm này.' };
    }

    const wasKept = group.keepVotes.size >= this.minKeepVotes;
    const memberKey = member.memberKey;
    let voterPass = null;

    if (wantsKeep) {
      let existing = group.keepVotes.get(memberKey);
      if (!existing) {
        existing = {
          memberKey,
          nickname: member.nickname,
          avatar: member.avatar || '🦊',
          rejoinToken: generateRejoinToken(),
          votedAt: Date.now(),
        };
        group.keepVotes.set(memberKey, existing);
      } else {
        existing.nickname = member.nickname;
        existing.avatar = member.avatar || '🦊';
      }
      voterPass = existing;
    } else {
      group.keepVotes.delete(memberKey);
    }

    const nowKept = group.keepVotes.size >= this.minKeepVotes;
    group.isKept = nowKept;
    group.lastActivityAt = Date.now();

    if (!nowKept) {
      group.history = [];
    }

    if (this._useRedis) {
      const redis = this._requireRedisClient();
      if (wantsKeep && voterPass) {
        await redis.hset(REDIS_KEYS.keeps(groupId), memberKey, JSON.stringify(voterPass));
      } else {
        await redis.hdel(REDIS_KEYS.keeps(groupId), memberKey);
      }
      await this._redisSaveMeta(group);
    }

    const justActivated = !wasKept && nowKept;
    const justDeactivated = wasKept && !nowKept;

    // Thu thập danh sách tất cả thành viên đang online đã chọn giữ để gửi rejoin pass khi vừa đạt ngưỡng 3
    const activeVoterPasses = [];
    if (justActivated) {
      for (const m of group.members.values()) {
        const vote = group.keepVotes.get(m.memberKey);
        if (vote) {
          activeVoterPasses.push({
            clientId: m.clientId,
            groupId,
            rejoinToken: vote.rejoinToken,
            name: group.name,
            mode: group.mode,
            topic: group.topic || '',
            interests: [...(group.interests || [])],
            keepCount: group.keepVotes.size,
            minKeepVotes: this.minKeepVotes,
            isKept: true,
          });
        }
      }
    } else if (wantsKeep && voterPass) {
      activeVoterPasses.push({
        clientId,
        groupId,
        rejoinToken: voterPass.rejoinToken,
        name: group.name,
        mode: group.mode,
        topic: group.topic || '',
        interests: [...(group.interests || [])],
        keepCount: group.keepVotes.size,
        minKeepVotes: this.minKeepVotes,
        isKept: nowKept,
      });
    }

    return {
      ok: true,
      groupId,
      voterClientId: clientId,
      voterNickname: member.nickname,
      wantsKeep: Boolean(wantsKeep),
      keepCount: group.keepVotes.size,
      minKeepVotes: this.minKeepVotes,
      isKept: nowKept,
      justActivated,
      justDeactivated,
      activeVoterPasses,
    };
  }

  /**
   * Bỏ giữ nhóm từ màn hình Sảnh (dùng rejoinToken).
   * Nếu số phiếu giữ rơi xuống dưới 3 và nhóm không còn ai online -> xóa nhóm ngay lập tức.
   */
  async unkeepSavedGroup(groupId, rejoinToken) {
    if (!groupId || typeof rejoinToken !== 'string') {
      return { ok: false, code: 'INVALID_PAYLOAD', error: 'Thông tin nhóm không hợp lệ.' };
    }

    const group = this._useRedis
      ? await this._redisLoadGroup(groupId)
      : this.groups.get(groupId);

    if (!group) {
      return { ok: true, groupId, destroyed: true, keepCount: 0, isKept: false };
    }

    let matchedKey = null;
    for (const [mKey, voter] of group.keepVotes.entries()) {
      if (safeTokenEquals(voter.rejoinToken, rejoinToken)) {
        matchedKey = mKey;
        break;
      }
    }

    if (!matchedKey) {
      return { ok: false, code: 'INVALID_REJOIN_TOKEN', error: 'Không tìm thấy quyền giữ nhóm này.' };
    }

    group.keepVotes.delete(matchedKey);
    group.isKept = group.keepVotes.size >= this.minKeepVotes;

    let destroyed = false;
    if (group.members.size === 0 && !group.isKept) {
      destroyed = true;
      if (this._useRedis) {
        await this._redisDeleteGroup(groupId);
      } else {
        this.groups.delete(groupId);
      }
      console.log(`[GroupManager] -Group ${groupId} destroyed after unkeep (keepCount=${group.keepVotes.size} < ${this.minKeepVotes})`);
    } else if (this._useRedis) {
      const redis = this._requireRedisClient();
      await redis.hdel(REDIS_KEYS.keeps(groupId), matchedKey);
      if (!group.isKept) {
        group.history = [];
      }
      await this._redisSaveMeta(group);
    } else if (!group.isKept) {
      group.history = [];
    }

    return {
      ok: true,
      groupId,
      destroyed,
      keepCount: group.keepVotes.size,
      minKeepVotes: this.minKeepVotes,
      isKept: group.isKept,
      memberCount: group.members.size,
    };
  }

  /**
   * Rời nhóm (chủ động rời, ngắt kết nối hoặc bị kick do vi phạm).
   *
   * Quy tắc cốt lõi:
   *  - Khi mọi người thoát hết (memberCount === 0):
   *    + Nếu keepVotes.size >= 3 -> giữ nhóm ở trạng thái dormant (isPrivateKept = true).
   *    + Nếu keepVotes.size < 3  -> XÓA VĨNH VIỄN nhóm ngay lập tức!
   */
  async leaveGroup(clientId, { kicked = false, reason = null } = {}) {
    const groupId = this._untrackLocalClient(clientId);
    if (!groupId) return null;

    const group = this._useRedis
      ? await this._redisLoadGroup(groupId)
      : this.groups.get(groupId);

    if (!group) {
      return {
        groupId,
        member: null,
        memberCount: 0,
        keepCount: 0,
        minKeepVotes: this.minKeepVotes,
        isKept: false,
        destroyed: true,
        preserved: false,
      };
    }

    const member = group.members.get(clientId) || null;
    group.members.delete(clientId);

    // Nếu bị kick vì vi phạm -> tước quyền giữ nhóm và cấm quay lại nhóm này
    if (kicked && member) {
      group.keepVotes.delete(member.memberKey);
      group.kickedKeys.add(member.memberKey);
    }

    const keepCount = group.keepVotes.size;
    const isKept = keepCount >= this.minKeepVotes;
    group.isKept = isKept;

    let destroyed = false;
    let preserved = false;

    if (this._useRedis) {
      const redis = this._requireRedisClient();
      // Xóa member nguyên tử và kiểm tra còn ai trong phòng + còn đủ >=3 phiếu giữ không
      const leaveScript = `
        local indexKey = KEYS[1]
        local metaKey = KEYS[2]
        local membersKey = KEYS[3]
        local keepsKey = KEYS[4]
        local historyKey = KEYS[5]
        local clientId = ARGV[1]
        local kicked = ARGV[2] == '1'
        local memberKey = ARGV[3]
        local minKeep = tonumber(ARGV[4])

        redis.call('HDEL', membersKey, clientId)
        if kicked and memberKey ~= '' then
          redis.call('HDEL', keepsKey, memberKey)
        end

        local remaining = redis.call('HLEN', membersKey)
        local keeps = redis.call('HLEN', keepsKey)

        if remaining == 0 and keeps < minKeep then
          redis.call('SREM', indexKey, ARGV[5])
          redis.call('DEL', metaKey, membersKey, keepsKey, historyKey)
          return { 0, keeps, 1 }
        end

        return { remaining, keeps, 0 }
      `;

      const evalRes = await redis.eval(
        leaveScript,
        5,
        REDIS_KEYS.index,
        REDIS_KEYS.meta(groupId),
        REDIS_KEYS.members(groupId),
        REDIS_KEYS.keeps(groupId),
        REDIS_KEYS.history(groupId),
        clientId,
        kicked ? '1' : '0',
        member ? member.memberKey : '',
        String(this.minKeepVotes),
        groupId
      );

      const remaining = Number(evalRes[0]);
      const actualKeeps = Number(evalRes[1]);
      destroyed = Number(evalRes[2]) === 1;
      const actualIsKept = actualKeeps >= this.minKeepVotes;

      if (!destroyed) {
        group.isKept = actualIsKept;
        if (remaining === 0 && actualIsKept) {
          group.status = 'dormant';
          group.isPrivateKept = true;
          preserved = true;
        }
        group.lastActivityAt = Date.now();
        await this._redisSaveMeta(group);
      }

      if (destroyed) {
        console.log(`[GroupManager] -Group ${groupId} ("${group.name}") auto-destroyed (empty, keepCount=${actualKeeps}/${this.minKeepVotes})`);
      } else if (preserved) {
        console.log(`[GroupManager] ★ Group ${groupId} ("${group.name}") preserved in dormant mode (keepCount=${actualKeeps}/${this.minKeepVotes})`);
      }

      return {
        groupId,
        groupName: group.name,
        member: member ? this._serializeMember(member) : null,
        memberCount: remaining,
        keepCount: actualKeeps,
        minKeepVotes: this.minKeepVotes,
        isKept: actualIsKept,
        destroyed,
        preserved,
        reason,
      };
    }

    // Chế độ In-Memory
    const remaining = group.members.size;
    if (remaining === 0) {
      if (isKept) {
        group.status = 'dormant';
        group.isPrivateKept = true;
        group.lastActivityAt = Date.now();
        preserved = true;
        console.log(`[GroupManager] ★ Group ${groupId} ("${group.name}") preserved in dormant mode (keepCount=${keepCount}/${this.minKeepVotes})`);
      } else {
        this.groups.delete(groupId);
        destroyed = true;
        console.log(`[GroupManager] -Group ${groupId} ("${group.name}") auto-destroyed (empty, keepCount=${keepCount}/${this.minKeepVotes})`);
      }
    } else {
      group.lastActivityAt = Date.now();
    }

    return {
      groupId,
      groupName: group.name,
      member: member ? this._serializeMember(member) : null,
      memberCount: remaining,
      keepCount,
      minKeepVotes: this.minKeepVotes,
      isKept,
      destroyed,
      preserved,
      reason,
    };
  }

  /**
   * Lưu 1 tin nhắn vào lịch sử gần nhất CHỈ KHI nhóm đã đạt điều kiện giữ (>= 3 phiếu).
   */
  async recordHistoryMessage(groupId, messageRecord) {
    if (!groupId || !messageRecord) return;

    if (this._useRedis) {
      const redis = this._requireRedisClient();
      const keepCount = await redis.hlen(REDIS_KEYS.keeps(groupId));
      if (keepCount < this.minKeepVotes) return;

      const p = redis.pipeline();
      p.rpush(REDIS_KEYS.history(groupId), JSON.stringify(messageRecord));
      p.ltrim(REDIS_KEYS.history(groupId), -MAX_KEPT_HISTORY, -1);
      p.expire(REDIS_KEYS.history(groupId), DORMANT_KEPT_TTL_SECONDS);
      await p.exec();
      return;
    }

    const group = this.groups.get(groupId);
    if (!group || !group.isKept) return;
    group.history.push(messageRecord);
    if (group.history.length > MAX_KEPT_HISTORY) {
      group.history.splice(0, group.history.length - MAX_KEPT_HISTORY);
    }
    group.lastActivityAt = Date.now();
  }

  /**
   * Lấy danh sách các nhóm công khai đang hoạt động để người dùng duyệt/chọn.
   */
  async listPublicGroups({ mode = 'all', query = '' } = {}) {
    const allGroups = this._useRedis
      ? await this._redisListAllGroups()
      : [...this.groups.values()];

    const cleanQuery = stripVietnameseTones(query);

    const summaries = allGroups
      .filter((g) => g.members.size > 0 && !g.isPrivateKept)
      .filter((g) => (mode === 'all' ? true : g.mode === mode))
      .filter((g) => {
        if (!cleanQuery) return true;
        const haystack = [
          g.name,
          g.topic,
          ...(g.interests || []),
        ].map(stripVietnameseTones).join(' ');
        return haystack.includes(cleanQuery);
      })
      .map((g) => this._buildSummary(g))
      .sort((a, b) => {
        // Nhóm còn chỗ lên trước, sau đó sắp theo số thành viên giảm dần
        const aFull = a.memberCount >= a.maxMembers ? 1 : 0;
        const bFull = b.memberCount >= b.maxMembers ? 1 : 0;
        if (aFull !== bFull) return aFull - bFull;
        if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
        return b.lastActivityAt - a.lastActivityAt;
      })
      .slice(0, 50);

    return summaries;
  }

  /**
   * Đối chiếu danh sách nhóm đã lưu từ client (localStorage) với trạng thái thật trên server.
   * Các nhóm đã tự động biến mất sẽ nằm trong expiredGroupIds để client tự dọn sạch.
   */
  async syncSavedGroups(passes = []) {
    if (!Array.isArray(passes) || passes.length === 0) {
      return { groups: [], expiredGroupIds: [] };
    }

    const validGroups = [];
    const expiredGroupIds = [];
    const seen = new Set();

    for (const pass of passes.slice(0, 20)) {
      if (!pass || typeof pass.groupId !== 'string' || typeof pass.rejoinToken !== 'string') continue;
      if (seen.has(pass.groupId)) continue;
      seen.add(pass.groupId);

      const group = this._useRedis
        ? await this._redisLoadGroup(pass.groupId)
        : this.groups.get(pass.groupId);

      if (!group) {
        expiredGroupIds.push(pass.groupId);
        continue;
      }

      let hasMatchingToken = false;
      for (const voter of group.keepVotes.values()) {
        if (safeTokenEquals(voter.rejoinToken, pass.rejoinToken)) {
          hasMatchingToken = true;
          break;
        }
      }

      if (!hasMatchingToken) {
        expiredGroupIds.push(pass.groupId);
        continue;
      }

      // Nếu phòng đã trống và chưa đủ 3 phiếu -> đáng lẽ đã xóa, dọn luôn
      if (group.members.size === 0 && group.keepVotes.size < this.minKeepVotes) {
        if (this._useRedis) {
          await this._redisDeleteGroup(group.groupId);
        } else {
          this.groups.delete(group.groupId);
        }
        expiredGroupIds.push(pass.groupId);
        continue;
      }

      validGroups.push({
        ...this._buildSummary(group),
        rejoinToken: pass.rejoinToken,
      });
    }

    return { groups: validGroups, expiredGroupIds };
  }

  /**
   * Lấy thông tin thành viên đang trong nhóm (phục vụ kiểm tra quyền & report).
   */
  async getGroupMember(groupId, clientId) {
    if (!groupId || !clientId) return null;
    if (this._useRedis) {
      const redis = this._requireRedisClient();
      const raw = await redis.hget(REDIS_KEYS.members(groupId), clientId);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    const group = this.groups.get(groupId);
    if (!group) return null;
    return group.members.get(clientId) || null;
  }

  /**
   * Trích xuất danh sách thành viên được tag bằng @BiệtDanh trong phòng nhóm.
   */
  async extractGroupMentions(groupId, text) {
    if (!groupId || typeof text !== 'string' || !text.includes('@')) return [];
    if (this._useRedis) {
      const redis = this._requireRedisClient();
      const rawMembers = await redis.hgetall(REDIS_KEYS.members(groupId));
      const list = [];
      for (const json of Object.values(rawMembers || {})) {
        try { list.push(JSON.parse(json)); } catch {}
      }
      return extractMentions(text, list);
    }
    const group = this.groups.get(groupId);
    if (!group) return [];
    return extractMentions(text, group.members.values());
  }

  /**
   * Dọn dẹp định kỳ các nhóm ngủ đông quá hạn hoặc thành viên "ma" mất kết nối trên Redis.
   */
  async pruneStaleGroups() {
    const now = Date.now();

    if (!this._useRedis) {
      for (const [groupId, group] of this.groups.entries()) {
        if (group.members.size === 0) {
          if (!group.isKept || now - group.lastActivityAt > DORMANT_KEPT_TTL_MS) {
            this.groups.delete(groupId);
            console.log(`[GroupManager] Pruned expired group ${groupId}`);
          }
        }
      }
      return;
    }

    if (!this.redisManager.isConnected || !this.redisManager.pubClient) return;
    const redis = this.redisManager.pubClient;
    const allGroups = await this._redisListAllGroups();

    for (const group of allGroups) {
      let removedAny = false;
      for (const [cid] of group.members.entries()) {
        const onlineAt = await redis.zscore('chat:{match}:online', cid);
        if (!onlineAt || now - Number(onlineAt) > 95_000) {
          await redis.hdel(REDIS_KEYS.members(group.groupId), cid);
          group.members.delete(cid);
          this._untrackLocalClient(cid);
          removedAny = true;
        }
      }

      if (group.members.size === 0) {
        if (group.keepVotes.size < this.minKeepVotes || now - group.lastActivityAt > DORMANT_KEPT_TTL_MS) {
          await this._redisDeleteGroup(group.groupId);
          console.log(`[GroupManager] Pruned stale Redis group ${group.groupId}`);
        } else if (removedAny) {
          group.status = 'dormant';
          group.isPrivateKept = true;
          await this._redisSaveMeta(group);
        }
      }
    }
  }

  get groupCount() {
    return this.groups.size;
  }
}

module.exports = {
  GroupManager,
  DEFAULT_MAX_GROUP_MEMBERS,
  MIN_KEEP_VOTES,
  MAX_KEPT_HISTORY,
  MAX_GROUP_TOPIC_LENGTH,
  MAX_GROUP_NAME_LENGTH,
};

