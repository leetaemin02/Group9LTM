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
const { MATCH_SCRIPT } = require('./matchmaking');
const { RESERVE_UPLOAD_SCRIPT } = require('./uploadQuota');
const pubsub = require('./pubsub');
const { randomUUID } = require('crypto');



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
    this.instanceId = randomUUID();
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
      this.subClient = new Redis(this.redisUrl, {
        ...redisOptions,
        autoResubscribe: false
      });

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


      this.pubClient.on('ready', () => {
        console.log('[Redis] ✅ Pub Client đã sẵn sàng');

        this.pubErrorLogged = false;
        this.pubReady = true;

        this.isConnected = this.pubReady && this.subReady;
      });



      this.subClient.on('ready', () => {
        this.subErrorLogged = false;

        console.log(
          '[Redis] ✅ Sub Client đã sẵn sàng. Đang đăng ký kênh Pub/Sub...'
        );

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
    return pubsub.setupSubscriptions(this);
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

  async reserveAttachmentUpload({
    uploadId,
    conversationId,
    size,
    globalLimitBytes = 500_000_000,
    conversationLimitBytes = 50 * 1024 * 1024,
    conversationFileLimit = 5,
  }) {
    if (!this.isConnected || !this.pubClient) {
      throw new Error('Redis chưa sẵn sàng; không thể xác nhận hạn mức tải tệp.');
    }
    if (
      typeof uploadId !== 'string'
      || uploadId.length === 0
      || typeof conversationId !== 'string'
      || conversationId.length === 0
      || !Number.isSafeInteger(size)
      || size <= 0
      || !Number.isSafeInteger(globalLimitBytes)
      || globalLimitBytes <= 0
      || !Number.isSafeInteger(conversationLimitBytes)
      || conversationLimitBytes <= 0
      || !Number.isSafeInteger(conversationFileLimit)
      || conversationFileLimit <= 0
    ) {
      throw new TypeError('Thông tin dự trữ quota upload không hợp lệ.');
    }

    const result = await this.pubClient.eval(
      RESERVE_UPLOAD_SCRIPT,
      4,
      'chat:{upload}:global:bytes',
      `chat:{upload}:conversation:${conversationId}:bytes`,
      `chat:{upload}:conversation:${conversationId}:files`,
      `chat:{upload}:reservation:${uploadId}`,
      uploadId,
      globalLimitBytes,
      conversationLimitBytes,
      conversationFileLimit,
      size,
    );

    if (result === 0) return { allowed: true, alreadyReserved: false };
    if (result === 1) return { allowed: true, alreadyReserved: true };
    if (result === -1) return { allowed: false, reason: 'global_limit' };
    if (result === -2) return { allowed: false, reason: 'conversation_file_limit' };
    if (result === -3) return { allowed: false, reason: 'conversation_size_limit' };
    throw new Error(`Redis trả về kết quả dự trữ quota không hợp lệ: ${result}`);
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
    return pubsub.publishRoomLeft(
      this,
      clientId,
      partnerId,
      reason
    );
  }

  /**
   * Gửi thông điệp tới một Client (có thể ở node hiện tại hoặc node khác).
   * @param {string} targetClientId
   * @param {string} msgString - Chuỗi JSON
   */
  async publishToClient(targetClientId, msgString) {
    return pubsub.publishToClient(
      this,
      targetClientId,
      msgString
    );
  }

  /**
   * Phát sự kiện ghép cặp thành công tới toàn bộ cụm server.
   * @param {object} matchData
   */
  async publishMatchEvent(matchData) {
    return pubsub.publishMatchEvent(this, matchData);
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
