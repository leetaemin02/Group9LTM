/**
 * moderation.js – Cơ chế kiểm soát lạm dụng
 *
 *   1. Rate Limiting: giới hạn số tin nhắn mỗi giây.
 *   2. Report: ghi log báo cáo (có thể mở rộng lưu DB).
 *   3. Block tạm: chặn ghép cặp lại với người vừa bị skip/report.
 */

'use strict';

// ─── Hằng số ────────────────────────────────────────────────────────────────

/** Số tin nhắn tối đa trong 1 cửa sổ thời gian */
const RATE_LIMIT_MAX = 5;

/** Cửa sổ thời gian rate limit (ms) */
const RATE_LIMIT_WINDOW = 3_000; // 3 giây

/** Thời gian tạm chặn ghép lại với người đã report (ms) */
const BLOCK_DURATION = 5 * 60_000; // 5 phút

/** Giới hạn số lần Skip liên tục trong 30 giây để chống tool dò tìm */
const MAX_SKIPS_IN_WINDOW = 5;
const SKIP_WINDOW = 30_000;
const SKIP_COOLDOWN_DURATION = 30_000; // Phạt chờ 30 giây nếu spam skip

/** Thời gian cấm chat khi vi phạm nói tục/chat đen nghiêm trọng */
const PROFANITY_BAN_DURATION = 10 * 60_000; // 10 phút

// ─── Class Moderation ──────────────────────────────────────────────────────

class Moderation {
  constructor() {
    /**
     * Rate limit tracker: clientId → { timestamps: number[] }
     * @type {Map<string, { timestamps: number[] }>}
     */
    this.rateLimitMap = new Map();

    /**
     * Danh sách report: mảng { reporter, reported, reason, timestamp }
     * @type {Array}
     */
    this.reports = [];

    /**
     * Block tạm: deviceId (hoặc clientId dự phòng) → Map<blockedId, expireTimestamp>
     * @type {Map<string, Map<string, number>>}
     */
    this.blockMap = new Map();

    /**
     * Theo dõi spam Skip để chống bot/tool dò tìm người quen
     * clientId → { timestamps: number[], cooldownUntil: number }
     * @type {Map<string, { timestamps: number[], cooldownUntil: number }>}
     */
    this.skipTracker = new Map();

    /**
     * Danh sách cấm tạm thời (do phát ngôn thô tục / khiếm nhã)
     * clientId/clientIp → { expiresAt: number, reason: string }
     */
    this.bannedClients = new Map();
    this.bannedIps = new Map();

    /**
     * Block cặp thiết bị/IP cho các vi phạm nội dung bị kick.
     * Chỉ tồn tại trong bộ nhớ của tiến trình hiện tại.
     * @type {Set<string>} format: "devIdA:devIdB"
     */
    this.permanentBlocks = new Set();
    this.permanentIpBlocks = new Set();
  }

  // ── Rate Limiting ──────────────────────────────────────────

  /**
   * Kiểm tra và ghi nhận một tin nhắn từ client.
   * @param {string} clientId
   * @returns {boolean} true nếu ĐƯỢC PHÉP gửi, false nếu bị rate-limit
   */
  checkRateLimit(clientId) {
    const now = Date.now();

    if (!this.rateLimitMap.has(clientId)) {
      this.rateLimitMap.set(clientId, { timestamps: [now] });
      return true;
    }

    const entry = this.rateLimitMap.get(clientId);

    // Loại bỏ timestamps cũ (ngoài cửa sổ)
    entry.timestamps = entry.timestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW
    );

    if (entry.timestamps.length >= RATE_LIMIT_MAX) {
      console.log(`[Moderation] Rate-limited: ${clientId} (${entry.timestamps.length} msgs in ${RATE_LIMIT_WINDOW}ms)`);
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /**
   * Dọn dẹp rate limit khi client ngắt kết nối.
   * @param {string} clientId
   */
  clearRateLimit(clientId) {
    this.rateLimitMap.delete(clientId);
  }

  // ── Report ─────────────────────────────────────────────────

  /**
   * Ghi nhận báo cáo.
   * @param {string|object} reporter
   * @param {string|object} reported
   * @param {string} reason
   */
  addReport(reporter, reported, reason) {
    const reporterId = typeof reporter === 'object' ? reporter.clientId : reporter;
    const reportedId = typeof reported === 'object' ? reported.clientId : reported;

    const report = {
      reporter: reporterId,
      reported: reportedId,
      reason,
      timestamp: new Date().toISOString(),
    };
    // Giới hạn bộ nhớ: tối đa 1000 báo cáo gần nhất
    if (this.reports.length >= 1000) {
      this.reports.shift();
    }
    this.reports.push(report);
    console.log(`[Moderation] Report: ${reporterId} → ${reportedId}: "${reason}"`);

    // Dùng deviceId để block vẫn còn hiệu lực nếu một bên tải lại trang.
    const reporterKey = typeof reporter === 'object' ? (reporter.deviceId || reporterId) : reporterId;
    const reportedKey = typeof reported === 'object' ? (reported.deviceId || reportedId) : reportedId;
    this.addBlock(reporterKey, reportedKey);
  }

  /**
   * Lấy danh sách report (dùng cho admin / debug).
   * @returns {Array}
   */
  getReports() {
    return [...this.reports];
  }

  // ── Block vĩnh viễn & Block tạm ─────────────────────────────

  /**
   * Thêm chặn vĩnh viễn giữa 2 người dùng (cả hai chiều) theo Device Token và IP.
   * Ngăn ghép cặp trong tiến trình hiện tại dù client refresh tab hoặc đổi nick.
   * @param {string|object} userA
   * @param {string|object} userB
   */
  addPermanentBlock(userA, userB) {
    const devA = typeof userA === 'object' ? (userA.deviceId || userA.clientId) : userA;
    const devB = typeof userB === 'object' ? (userB.deviceId || userB.clientId) : userB;
    const ipA = typeof userA === 'object' ? userA.clientIp : null;
    const ipB = typeof userB === 'object' ? userB.clientIp : null;

    if (devA && devB) {
      this.permanentBlocks.add(`${devA}:${devB}`);
      this.permanentBlocks.add(`${devB}:${devA}`);
      console.log(`[Moderation] 🔒 Permanent Block: ${devA} ⇎ ${devB} (Never match again)`);
    }

    if (ipA && ipB && ipA !== ipB) {
      this.permanentIpBlocks.add(`${ipA}:${ipB}`);
      this.permanentIpBlocks.add(`${ipB}:${ipA}`);
    }
  }

  /**
   * Thêm block tạm giữa hai định danh (cả hai chiều).
   * @param {string} identity1 deviceId hoặc clientId dự phòng
   * @param {string} identity2 deviceId hoặc clientId dự phòng
   */
  addBlock(identity1, identity2) {
    const expireAt = Date.now() + BLOCK_DURATION;

    if (!identity1 || !identity2) return;

    if (!this.blockMap.has(identity1)) this.blockMap.set(identity1, new Map());
    this.blockMap.get(identity1).set(identity2, expireAt);

    if (!this.blockMap.has(identity2)) this.blockMap.set(identity2, new Map());
    this.blockMap.get(identity2).set(identity1, expireAt);

    console.log(`[Moderation] Block: ${identity1} ↔ ${identity2} (${BLOCK_DURATION / 1000}s)`);
  }

  /**
   * Kiểm tra hai người dùng có đang bị block với nhau không (cả vĩnh viễn lẫn tạm thời).
   * @param {string|object} userA
   * @param {string|object} userB
   * @returns {boolean}
   */
  isBlocked(userA, userB) {
    if (!userA || !userB) return false;

    const idA = typeof userA === 'object' ? userA.clientId : userA;
    const idB = typeof userB === 'object' ? userB.clientId : userB;

    if (idA === idB) return true;

    const devA = typeof userA === 'object' ? (userA.deviceId || userA.clientId) : userA;
    const devB = typeof userB === 'object' ? (userB.deviceId || userB.clientId) : userB;

    // 1. Kiểm tra cùng thiết bị / trình duyệt (chỉ chặn khi ở Production hoặc cấu hình DISALLOW_SAME_DEVICE=true)
    const disallowSameDevice = process.env.DISALLOW_SAME_DEVICE === 'true' || process.env.NODE_ENV === 'production';
    if (disallowSameDevice && devA && devB && devA === devB) return true;

    // 2. Kiểm tra danh sách chặn vĩnh viễn (Never-Match Blocklist)
    if (devA && devB) {
      if (this.permanentBlocks.has(`${devA}:${devB}`) || this.permanentBlocks.has(`${devB}:${devA}`)) {
        return true;
      }
    }

    // 3. Kiểm tra chặn theo cặp IP đã ghi nhận vi phạm
    const ipA = typeof userA === 'object' ? userA.clientIp : null;
    const ipB = typeof userB === 'object' ? userB.clientIp : null;
    if (ipA && ipB && ipA !== ipB) {
      if (this.permanentIpBlocks.has(`${ipA}:${ipB}`) || this.permanentIpBlocks.has(`${ipB}:${ipA}`)) {
        return true;
      }
    }

    // 4. Kiểm tra block tạm theo cả clientId và deviceId để hỗ trợ reconnect.
    const identitiesA = typeof userA === 'object'
      ? [...new Set([idA, userA.deviceId].filter(Boolean))]
      : [idA];
    const identitiesB = typeof userB === 'object'
      ? [...new Set([idB, userB.deviceId].filter(Boolean))]
      : [idB];
    const now = Date.now();

    for (const identityA of identitiesA) {
      const blocks = this.blockMap.get(identityA);
      if (!blocks) continue;

      for (const identityB of identitiesB) {
        const expireAt = blocks.get(identityB);
        if (!expireAt) continue;
        if (now <= expireAt) return true;

        blocks.delete(identityB);
        const reverseBlocks = this.blockMap.get(identityB);
        if (reverseBlocks) {
          reverseBlocks.delete(identityA);
          if (reverseBlocks.size === 0) this.blockMap.delete(identityB);
        }
      }

      if (blocks.size === 0) this.blockMap.delete(identityA);
    }

    return false;
  }

  /**
   * Dọn dẹp khi client ngắt kết nối.
   * @param {string} clientId
   */
  clearClient(clientId) {
    this.clearRateLimit(clientId);
    const blocks = this.blockMap.get(clientId);
    if (blocks) {
      for (const blockedId of blocks.keys()) {
        const reverseBlocks = this.blockMap.get(blockedId);
        if (!reverseBlocks) continue;
        reverseBlocks.delete(clientId);
        if (reverseBlocks.size === 0) this.blockMap.delete(blockedId);
      }
    }
    this.blockMap.delete(clientId);
    this.skipTracker.delete(clientId);
  }

  // ── Anti-Skip Spam (Chống Tool dò tìm đối tượng cụ thể) ───────

  /**
   * Kiểm tra xem client có đang bị cooldown do spam skip không.
   * @param {string} clientId
   * @returns {{ allowed: boolean, remainingSec: number }}
   */
  checkSkipLimit(clientId) {
    const now = Date.now();
    let tracker = this.skipTracker.get(clientId);
    if (!tracker) {
      tracker = { timestamps: [now], cooldownUntil: 0 };
      this.skipTracker.set(clientId, tracker);
      return { allowed: true, remainingSec: 0 };
    }

    // Nếu đang trong thời gian phạt cooldown
    if (now < tracker.cooldownUntil) {
      const remainingSec = Math.ceil((tracker.cooldownUntil - now) / 1000);
      return { allowed: false, remainingSec };
    }

    // Lọc lại timestamps trong cửa sổ 30s
    tracker.timestamps = tracker.timestamps.filter((t) => now - t < SKIP_WINDOW);
    tracker.timestamps.push(now);

    if (tracker.timestamps.length > MAX_SKIPS_IN_WINDOW) {
      tracker.cooldownUntil = now + SKIP_COOLDOWN_DURATION;
      const remainingSec = Math.ceil(SKIP_COOLDOWN_DURATION / 1000);
      console.log(`[Moderation] ⚠️ Anti-Skip Cooldown: ${clientId} (${MAX_SKIPS_IN_WINDOW} skips/30s) -> Phạt ${remainingSec}s`);
      return { allowed: false, remainingSec };
    }

    return { allowed: true, remainingSec: 0 };
  }

  // ── Xử lý Ban / Cấm chat do vi phạm ngôn từ ──────────────────

  /**
   * Khóa tạm client và IP do vi phạm phát ngôn khiếm nhã / chat đen.
   * @param {string} clientId
   * @param {string} clientIp
   * @param {string} reason
   * @param {number} [durationMs]
   * @returns {number} Thời gian hết hạn (timestamp)
   */
  ban(clientId, clientIp, reason, durationMs = PROFANITY_BAN_DURATION) {
    const expiresAt = Date.now() + durationMs;
    const banInfo = { expiresAt, reason };

    if (clientId) this.bannedClients.set(clientId, banInfo);
    if (clientIp) this.bannedIps.set(clientIp, banInfo);

    console.log(`[Moderation] 🚫 BAN: ${clientId} (${clientIp}) trong ${durationMs / 60000} phút. Lý do: "${reason}"`);
    return expiresAt;
  }

  /**
   * Kiểm tra client hoặc IP có đang bị cấm không.
   * @param {string} clientId
   * @param {string} clientIp
   * @returns {{ banned: boolean, remainingSec: number, reason: string }}
   */
  isBanned(clientId, clientIp) {
    const now = Date.now();

    // Kiểm tra theo Client ID
    const clientBan = this.bannedClients.get(clientId);
    if (clientBan && now < clientBan.expiresAt) {
      return {
        banned: true,
        remainingSec: Math.ceil((clientBan.expiresAt - now) / 1000),
        reason: clientBan.reason,
      };
    }

    // Kiểm tra theo IP (chống mở tab mới để lách)
    if (clientIp) {
      const ipBan = this.bannedIps.get(clientIp);
      if (ipBan && now < ipBan.expiresAt) {
        return {
          banned: true,
          remainingSec: Math.ceil((ipBan.expiresAt - now) / 1000),
          reason: ipBan.reason,
        };
      }
    }

    return { banned: false, remainingSec: 0, reason: '' };
  }
}

module.exports = Moderation;
