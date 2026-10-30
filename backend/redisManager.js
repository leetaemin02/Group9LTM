/**
 * redisManager.js – Quản lý kết nối Redis & Pub/Sub cho hệ thống phân tán
 *
 * Vai trò:
 *   1. Pub/Sub Message Broker: Cho phép các tiến trình / server khác nhau gửi nhận
 *      tin nhắn WebSocket qua lại khi người dùng kết nối vào các server khác nhau.
 *   2. Chia sẻ hàng đợi ghép cặp, trạng thái online và lệnh chặn có TTL.
 *   3. Chạy nhiều server instance qua một Redis endpoint dùng chung.
 *   4. Khi Redis không được bật, ứng dụng dùng in-memory cho môi trường đơn instance.
 */

'use strict';

const Redis = require('ioredis');

const MATCH_SCRIPT = `
local queueKey = KEYS[1]
local sequenceKey = KEYS[2]
local entryPrefix = KEYS[3]
local matchChannel = KEYS[4]
local onlineKey = KEYS[5]
local mode = ARGV[1]
local strictTimeout = tonumber(ARGV[2])
local disallowSameIp = ARGV[3] == 'true'
local candidateLimit = tonumber(ARGV[4])
local maxMatches = tonumber(ARGV[5])
local now = tonumber(ARGV[6])

local function blocked(a, b)
  local aKeys = { a.clientId }
  local bKeys = { b.clientId }
  if a.deviceId and a.deviceId ~= '' then table.insert(aKeys, a.deviceId) end
  if b.deviceId and b.deviceId ~= '' then table.insert(bKeys, b.deviceId) end
  for _, aKey in ipairs(aKeys) do
    for _, bKey in ipairs(bKeys) do
      if redis.call('EXISTS', 'block:{match}:' .. aKey .. ':' .. bKey) == 1
        or redis.call('EXISTS', 'block:{match}:' .. bKey .. ':' .. aKey) == 1 then
        return true
      end
    end
  end
  return false
end

local function choose(source, sourceTimedOut)
  local ids = redis.call('ZRANGE', queueKey, 0, candidateLimit - 1)
  local candidates = {}
  for _, candidateId in ipairs(ids) do
    if candidateId ~= source.clientId then
      local candidateJson = redis.call('GET', entryPrefix .. candidateId)
      if candidateJson then
        local candidate = cjson.decode(candidateJson)
        local onlineAt = redis.call('ZSCORE', onlineKey, candidateId)
        if not onlineAt or now - tonumber(onlineAt) > 90000 then
          redis.call('ZREM', queueKey, candidateId)
          redis.call('DEL', entryPrefix .. candidateId)
          candidateJson = false
        end
        if candidateJson then
        local sameIp = disallowSameIp and source.clientIp and candidate.clientIp
          and source.clientIp == candidate.clientIp
        if not sameIp and not blocked(source, candidate) then
          local common = {}
          local candidateInterests = {}
          for _, interest in ipairs(candidate.interests or {}) do
            candidateInterests[interest] = true
          end
          for _, interest in ipairs(source.interests or {}) do
            if candidateInterests[interest] then table.insert(common, interest) end
          end

          local sameMood = source.mood and candidate.mood
            and source.mood ~= 'ngau_nhien'
            and source.mood == candidate.mood
          local score = #common + (sameMood and 2 or 0)
          local hasCriteria = #(source.interests or {}) > 0
            or #(candidate.interests or {}) > 0
            or (source.mood and source.mood ~= 'ngau_nhien')
            or (candidate.mood and candidate.mood ~= 'ngau_nhien')
          local candidateTimedOut = now - tonumber(candidate.joinedAt) >= strictTimeout
          local relaxed = sourceTimedOut or candidateTimedOut

          if not hasCriteria or relaxed or score > 0 then
            table.insert(candidates, {
              entry = candidate,
              common = common,
              score = score,
              relaxed = relaxed
            })
          end
        end
        end
      end
    end
  end

  if #candidates == 0 then return false end
  local selected = candidates[1]
  local useFifo = sourceTimedOut
  for _, item in ipairs(candidates) do
    if item.relaxed then useFifo = true end
  end
  if not useFifo then
    for _, item in ipairs(candidates) do
      if item.score > selected.score then selected = item end
    end
  end

  local partnerId = selected.entry.clientId
  local matchEvent = cjson.encode({
    entry1 = {
      clientId = source.clientId,
      nickname = source.nickname,
      interests = source.interests,
      mood = source.mood
    },
    entry2 = {
      clientId = selected.entry.clientId,
      nickname = selected.entry.nickname,
      interests = selected.entry.interests,
      mood = selected.entry.mood
    },
    commonInterests = selected.common
  })
  redis.call('ZREM', queueKey, source.clientId, partnerId)
  redis.call('DEL', entryPrefix .. source.clientId, entryPrefix .. partnerId)
  redis.call('SET', 'chat:{match}:pair:' .. source.clientId, matchEvent, 'EX', 60)
  redis.call('SET', 'chat:{match}:pair:' .. partnerId, matchEvent, 'EX', 60)
  redis.call('PUBLISH', matchChannel, matchEvent)
  return true
end

if mode == 'enqueue' then
  local source = cjson.decode(ARGV[7])
  if redis.call('ZSCORE', queueKey, source.clientId) then return 0 end
  local onlineAt = redis.call('ZSCORE', onlineKey, source.clientId)
  if not onlineAt or now - tonumber(onlineAt) > 90000 then return -1 end
  local sequence = redis.call('INCR', sequenceKey)
  redis.call('ZADD', queueKey, sequence, source.clientId)
  redis.call('SET', entryPrefix .. source.clientId, ARGV[7], 'EX', 3600)
  choose(source, now - tonumber(source.joinedAt) >= strictTimeout)
  return 1
end

local matched = 0
for _ = 1, maxMatches do
  local ids = redis.call('ZRANGE', queueKey, 0, candidateLimit - 1)
  local source = nil
  for _, clientId in ipairs(ids) do
    local entryJson = redis.call('GET', entryPrefix .. clientId)
    if entryJson then
      local entry = cjson.decode(entryJson)
      local onlineAt = redis.call('ZSCORE', onlineKey, clientId)
      if not onlineAt or now - tonumber(onlineAt) > 90000 then
        redis.call('ZREM', queueKey, clientId)
        redis.call('DEL', entryPrefix .. clientId)
      elseif now - tonumber(entry.joinedAt) >= strictTimeout then
        source = entry
        break
      end
    else
      redis.call('ZREM', queueKey, clientId)
    end
  end
  if not source or not choose(source, true) then break end
  matched = matched + 1
end
return matched
`;

class RedisManager {
  /**
   * @param {object} opts
   * @param {string} [opts.redisUrl] - URL kết nối Redis (vd: redis://127.0.0.1:6379)
   * @param {boolean} [opts.enabled] - Bật/tắt Redis
   * @param {function} [opts.onDirectMessage] - Callback khi nhận message cho client: (clientId, msgString) => void
   * @param {function} [opts.onMatchEvent] - Callback khi Redis phân phối một sự kiện ghép cặp
   * @param {function} [opts.onOnlineCount] - Callback cập nhật số người online toàn cụm
   */
  constructor({
    redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    enabled = process.env.USE_REDIS === 'true',
    onDirectMessage,
    onMatchEvent,
    onRoomLeft,
    onOnlineCount,
  } = {}) {
    this.redisUrl = redisUrl;
    this.enabled = enabled;
    this.isConnected = false;
    this.pubReady = false;
    this.subReady = false;
    this._subscriptionsRegistered = false;
    this.pubErrorLogged = false;
    this.subErrorLogged = false;

    this.onDirectMessage = onDirectMessage || (() => {});
    this.onMatchEvent = onMatchEvent || (() => {});
    this.onRoomLeft = onRoomLeft || (() => {});
    this.onOnlineCount = onOnlineCount || (() => {});

    this.pubClient = null;
    this.subClient = null;

    if (this.enabled) {
      this._init();
    } else {
      console.log('[Redis] ℹ️ Chế độ In-Memory đang kích hoạt (USE_REDIS chưa được bật).');
    }
  }

  /**
   * Khởi tạo kết nối Pub & Sub tới Redis.
   */
  _init() {
    const redisOptions = {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      retryStrategy: (times) => Math.min(times * 1000, 10_000),
    };

    try {
      this.pubClient = new Redis(this.redisUrl, redisOptions);
      this.subClient = new Redis(this.redisUrl, redisOptions);

      // Xử lý sự kiện lỗi để không làm crash Node.js
      this.pubClient.on('error', (err) => {
        if (this.isConnected || !this.pubErrorLogged) {
          console.warn('[Redis Pub Error]:', err.message);
          this.pubErrorLogged = !this.isConnected;
        }
      });

      this.subClient.on('error', (err) => {
        if (this.isConnected || !this.subErrorLogged) {
          console.warn('[Redis Sub Error]:', err.message);
          this.subErrorLogged = !this.isConnected;
        }
      });

      this.pubClient.on('connect', () => {
        console.log('[Redis] ✅ Pub Client đã kết nối');
        this.pubErrorLogged = false;
        this.pubReady = true;
        this.isConnected = this.pubReady && this.subReady;
      });

      this.subClient.on('connect', () => {
        this.subErrorLogged = false;
        console.log(`[Redis] ✅ Sub Client đã kết nối. Đang đăng ký kênh Pub/Sub...`);
        this._setupSubscriptions();
      });

      this.pubClient.on('close', () => {
        this.pubReady = false;
        this.isConnected = false;
      });
      this.subClient.on('close', () => {
        this.subReady = false;
        this.isConnected = false;
      });

    } catch (err) {
      console.warn(`[Redis] ⚠️ Không thể khởi tạo Redis: ${err.message}. Tự động chạy chế độ In-Memory.`);
      this.isConnected = false;
    }
  }

  /**
   * Đăng ký lắng nghe các kênh thông điệp giữa các Server instances.
   */
  _setupSubscriptions() {
    if (!this.subClient) return;

    // Đăng ký pattern kênh theo từng client: chat:client:*
    this.subClient.psubscribe('chat:client:*', 'chat:{match}:room:*', 'chat:system:*', (err) => {
      if (err) {
        console.error('[Redis] Lỗi đăng ký kênh psubscribe:', err.message);
      } else {
        this.subReady = true;
        this.isConnected = this.pubReady && this.subReady;
        console.log('[Redis] 📡 Đã kích hoạt lắng nghe Pub/Sub đa instance');
      }
    });

    if (this._subscriptionsRegistered) return;
    this._subscriptionsRegistered = true;
    this.subClient.on('pmessage', (pattern, channel, message) => {
      try {
        if (channel.startsWith('chat:client:')) {
          // Kênh đích danh gửi cho 1 client cụ thể
          const targetClientId = channel.replace('chat:client:', '');
          this.onDirectMessage(targetClientId, message);
        } else if (channel === 'chat:{match}:room:match') {
          // Sự kiện ghép cặp giữa 2 client
          const data = JSON.parse(message);
          this.onMatchEvent(data);
        } else if (channel === 'chat:{match}:room:left') {
          this.onRoomLeft(JSON.parse(message));
        } else if (channel === 'chat:system:online') {
          // Sự kiện cập nhật số lượng online
          const data = JSON.parse(message);
          this.onOnlineCount(data.count);
        }
      } catch (err) {
        console.error('[Redis] Lỗi xử lý pmessage:', err.message);
      }
    });
  }

  async _runMatchScript(mode, entry = null) {
    if (!this.isConnected || !this.pubClient) {
      throw new Error('Redis chưa sẵn sàng; không thể thao tác hàng đợi ghép cặp.');
    }

    return this.pubClient.eval(
      MATCH_SCRIPT,
      5,
      'chat:{match}:queue',
      'chat:{match}:sequence',
      'chat:{match}:entry:',
      'chat:{match}:room:match',
      'chat:{match}:online',
      mode,
      10_000,
      process.env.DISALLOW_SAME_IP === 'true' ? 'true' : 'false',
      5_000,
      100,
      Date.now(),
      entry ? JSON.stringify(entry) : '',
    );
  }

  async enqueueMatchEntry(entry) {
    const result = await this._runMatchScript('enqueue', entry);
    if (result === -1) {
      throw new Error('Client presence expired before matchmaking request.');
    }
  }

  async dequeueMatchEntry(clientId) {
    if (!this.isConnected || !this.pubClient) {
      throw new Error('Redis chưa sẵn sàng; không thể rời hàng đợi ghép cặp.');
    }
    return this.pubClient
      .multi()
      .zrem('chat:{match}:queue', clientId)
      .del(`chat:{match}:entry:${clientId}`)
      .exec();
  }

  async scanMatchQueue() {
    return this._runMatchScript('scan');
  }

  async getPendingMatches(clientIds) {
    if (!this.isConnected || !this.pubClient || clientIds.length === 0) return [];
    const values = await this.pubClient.mget(
      ...clientIds.map((clientId) => `chat:{match}:pair:${clientId}`)
    );
    return values.flatMap((value, index) => {
      if (!value) return [];
      try {
        return [{ clientId: clientIds[index], match: JSON.parse(value) }];
      } catch (error) {
        console.error('[Redis] Invalid persisted match event:', error.message);
        return [];
      }
    });
  }

  async acknowledgeMatch(clientId) {
    if (!this.isConnected || !this.pubClient) return;
    await this.pubClient.del(`chat:{match}:pair:${clientId}`);
  }

  async _publishOnlineCount() {
    if (!this.isConnected || !this.pubClient) return 0;
    const now = Date.now();
    await this.pubClient.zremrangebyscore('chat:{match}:online', '-inf', now - 90_000);
    const count = await this.pubClient.zcard('chat:{match}:online');
    await this.pubClient.publish('chat:system:online', JSON.stringify({ count }));
    return count;
  }

  async addOnlineClient(clientId) {
    if (!this.isConnected || !this.pubClient) {
      throw new Error('Redis chưa sẵn sàng; không thể đăng ký kết nối trực tuyến.');
    }
    await this.pubClient.zadd('chat:{match}:online', Date.now(), clientId);
    return this._publishOnlineCount();
  }

  async removeOnlineClient(clientId) {
    if (!this.isConnected || !this.pubClient) return null;
    await this.pubClient.zrem('chat:{match}:online', clientId);
    return this._publishOnlineCount();
  }

  async refreshOnlineClients(clientIds) {
    if (!this.isConnected || !this.pubClient || clientIds.length === 0) return null;
    const pipeline = this.pubClient.pipeline();
    const now = Date.now();
    for (const clientId of clientIds) {
      pipeline.zadd('chat:{match}:online', now, clientId);
    }
    await pipeline.exec();
    return this._publishOnlineCount();
  }

  async publishRoomLeft(clientId, partnerId, reason = null) {
    if (!this.isConnected || !this.pubClient) return false;
    await this.pubClient.publish('chat:{match}:room:left', JSON.stringify({
      clientId,
      partnerId,
      reason,
      sourceInstanceId: this.instanceId,
    }));
    return true;
  }

  /**
   * Gửi thông điệp tới một Client (có thể ở node hiện tại hoặc node khác).
   * @param {string} targetClientId
   * @param {string} msgString - Chuỗi JSON
   */
  async publishToClient(targetClientId, msgString) {
    if (!this.isConnected || !this.pubClient) return false;
    try {
      await this.pubClient.publish(`chat:client:${targetClientId}`, msgString);
      return true;
    } catch (err) {
      console.warn(`[Redis] Lỗi publishToClient (${targetClientId}):`, err.message);
      return false;
    }
  }

  /**
   * Phát sự kiện ghép cặp thành công tới toàn bộ cụm server.
   * @param {object} matchData
   */
  async publishMatchEvent(matchData) {
    if (!this.isConnected || !this.pubClient) return false;
    try {
      await this.pubClient.publish('chat:{match}:room:match', JSON.stringify(matchData));
      return true;
    } catch (err) {
      console.warn('[Redis] Lỗi publishMatchEvent:', err.message);
      return false;
    }
  }

  /**
   * Ghi nhận lệnh chặn tạm thời (Block) vào Redis với TTL tự động hết hạn.
   * @param {string} clientId1
   * @param {string} clientId2
   * @param {number} durationSeconds - Thời gian chặn tính bằng giây (vd: 300s = 5 phút)
   */
  async addBlock(clientId1, clientId2, durationSeconds = 300) {
    if (!this.isConnected || !this.pubClient) return;
    try {
      const p = this.pubClient.pipeline();
      p.setex(`block:{match}:${clientId1}:${clientId2}`, durationSeconds, '1');
      p.setex(`block:{match}:${clientId2}:${clientId1}`, durationSeconds, '1');
      await p.exec();
    } catch (err) {
      console.warn('[Redis] Lỗi addBlock:', err.message);
    }
  }

  /**
   * Kiểm tra xem 2 client có đang bị block nhau trong Redis không.
   * @param {string} clientId1
   * @param {string} clientId2
   * @returns {Promise<boolean>}
   */
  async isBlocked(clientId1, clientId2) {
    if (!this.isConnected || !this.pubClient) return false;
    try {
      const exists = await this.pubClient.exists(`block:{match}:${clientId1}:${clientId2}`);
      return exists === 1;
    } catch {
      return false;
    }
  }

  /**
   * Đóng các kết nối Redis khi tắt server.
   */
  async destroy() {
    this.isConnected = false;
    if (this.subClient) {
      try { await this.subClient.quit(); } catch { this.subClient.disconnect(); }
    }
    if (this.pubClient) {
      try { await this.pubClient.quit(); } catch { this.pubClient.disconnect(); }
    }
  }
}

module.exports = RedisManager;
