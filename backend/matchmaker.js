/**
 * matchmaker.js – Hàng đợi và thuật toán ghép cặp
 *
 * Thuật toán:
 *   1. Khi người dùng yêu cầu find_match → đưa vào hàng đợi (waitingQueue).
 *   2. Ngay lập tức quét hàng đợi để tìm người phù hợp nhất.
 *   3. Trước timeout: ưu tiên số sở thích chung cao nhất, FIFO khi đồng điểm.
 *   4. Nới lỏng theo thời gian chờ:
 *      - Dưới STRICT_TIMEOUT (10s): giữ các tiêu chí ghép đã chọn.
 *      - Sau STRICT_TIMEOUT: ghép người đủ điều kiện lâu nhất theo FIFO.
 *   5. Timer chạy mỗi SCAN_INTERVAL (3s) để quét lại hàng đợi cho các
 *      người dùng đã chờ quá lâu.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

// ─── Hằng số ────────────────────────────────────────────────────────────────

/** Thời gian chờ nghiêm ngặt (ms) – ưu tiên ghép theo sở thích */
const STRICT_TIMEOUT = 10_000;

/** Khoảng cách giữa các lần quét hàng đợi (ms) */
const SCAN_INTERVAL = 3_000;

// ─── Class Matchmaker ──────────────────────────────────────────────────────

class Matchmaker {
  /**
   * @param {object} opts
   * @param {function} opts.onMatch - Callback khi tìm được cặp: (entry1, entry2, commonInterests) => void
   * @param {function} [opts.isBlocked] - Callback kiểm tra block: (id1, id2) => boolean
   */
  constructor({ onMatch, isBlocked, redisManager = null, onError = () => {} }) {
    /** @type {Map<string, WaitingEntry>} clientId → entry */
    this.waitingQueue = new Map();

    /** Callback khi ghép cặp thành công */
    this.onMatch = onMatch;
    this.redisManager = redisManager;
    this.onError = onError;

    /** Callback kiểm tra block */
    this.isBlocked = typeof isBlocked === 'function' ? isBlocked : () => false;

    /** Timer quét định kỳ */
    this._scanTimer = setInterval(() => this._scanQueue(), SCAN_INTERVAL);
  }

  /**
   * Thêm người dùng vào hàng đợi.
   * @param {string} clientId
   * @param {string} nickname
   * @param {string[]} interests
   * @param {string} [mood='ngau_nhien']
   * @param {string} [clientIp=null]
   * @param {string} [deviceId=null]
   * @returns {boolean|Promise<boolean>} true nếu thao tác thêm thành công
   */
  enqueue(clientId, nickname, interests, mood = 'ngau_nhien', clientIp = null, deviceId = null) {
    const entry = {
      clientId,
      nickname,
      interests: interests || [],
      mood: mood || 'ngau_nhien',
      clientIp: clientIp || null,
      deviceId: deviceId || null,
      joinedAt: Date.now(),
    };

    if (this.redisManager && this.redisManager.enabled) {
      return this.redisManager.enqueueMatchEntry(entry).catch((error) => {
        this.onError(clientId, error);
        return false;
      });
    }

    if (this.waitingQueue.has(clientId)) return false;

    this.waitingQueue.set(clientId, entry);
    console.log(`[Matchmaker] +Enqueue: ${nickname} (${clientId}), mood=${entry.mood}, interests=[${entry.interests.join(', ')}], queueSize=${this.waitingQueue.size}`);

    // Thử ghép ngay lập tức
    this._tryMatch(entry);
    return true;
  }

  /**
   * Xóa người dùng khỏi hàng đợi.
   * @param {string} clientId
   * @returns {boolean|Promise<boolean>}
   */
  dequeue(clientId) {
    if (this.redisManager && this.redisManager.enabled) {
      return this.redisManager.dequeueMatchEntry(clientId).catch((error) => {
        this.onError(clientId, error);
        return false;
      });
    }

    const entry = this.waitingQueue.get(clientId);
    if (!entry) return false;
    this.waitingQueue.delete(clientId);
    console.log(`[Matchmaker] -Dequeue: ${entry.nickname} (${clientId}), queueSize=${this.waitingQueue.size}`);
    return true;
  }

  /**
   * Kiểm tra người dùng có đang trong hàng đợi không.
   * @param {string} clientId
   * @returns {boolean}
   */
  isWaiting(clientId) {
    return this.waitingQueue.has(clientId);
  }

  /**
   * Lấy kích thước hàng đợi hiện tại.
   * @returns {number}
   */
  get queueSize() {
    return this.waitingQueue.size;
  }

  /**
   * Tính số sở thích chung giữa hai danh sách.
   * @param {string[]} a
   * @param {string[]} b
   * @returns {string[]} Mảng các sở thích chung
   */
  _commonInterests(a, b) {
    if (!a.length || !b.length) return [];
    const setB = new Set(b);
    return a.filter((item) => setB.has(item));
  }

  /**
   * Thử ghép entry mới vào với người đang chờ trong hàng đợi.
   * @param {WaitingEntry} newEntry
   */
  _tryMatch(newEntry) {
    const now = Date.now();
    const candidates = [];

    // Cờ chống tool ghép cùng IP (khi triển khai production bật DISALLOW_SAME_IP=true)
    const disallowSameIp = process.env.DISALLOW_SAME_IP === 'true';
    const entryTimedOut = now - newEntry.joinedAt >= STRICT_TIMEOUT;

    for (const candidate of this.waitingQueue.values()) {
      if (candidate.clientId === newEntry.clientId) continue;

      // 1. Không ghép cặp với người đang bị chặn (vĩnh viễn hoặc tạm thời)
      if (this.isBlocked(newEntry, candidate)) continue;

      // 2. Chống kẻ xấu dùng tool trên 1 máy cố tình ghép 2 tài khoản của mình
      if (disallowSameIp && newEntry.clientIp && candidate.clientIp && newEntry.clientIp === candidate.clientIp) {
        continue;
      }

      const common = this._commonInterests(newEntry.interests, candidate.interests);
      let score = common.length;

      // 3. Ưu tiên ghép theo tâm trạng (Mood Matching):
      // Nếu cả hai cùng có tâm trạng cụ thể (không phải ngẫu nhiên) và trùng nhau -> +2 điểm ưu tiên
      const sameMood = newEntry.mood !== 'ngau_nhien' && candidate.mood !== 'ngau_nhien' && newEntry.mood === candidate.mood;
      if (sameMood) {
        score += 2;
      }

      // Nếu người mới hoặc ứng viên chưa chờ đủ STRICT_TIMEOUT
      // → chỉ ghép nếu có ít nhất 1 sở thích chung hoặc cùng tâm trạng
      const candidateWaited = now - candidate.joinedAt;
      const hasCriteria = newEntry.interests.length > 0
        || candidate.interests.length > 0
        || newEntry.mood !== 'ngau_nhien'
        || candidate.mood !== 'ngau_nhien';
      const relaxed = entryTimedOut || candidateWaited >= STRICT_TIMEOUT;

      if (hasCriteria && !relaxed) {
        // Chế độ nghiêm ngặt: cần có điểm chung (sở thích hoặc tâm trạng)
        if (score === 0) continue;
      }

      candidates.push({ candidate, common, score, relaxed });
    }

    if (candidates.length > 0) {
      // Khi có người đã chờ đủ lâu, chọn ứng viên hợp lệ đầu tiên trong hàng đợi.
      // Map giữ thứ tự enqueue nên đây là lựa chọn FIFO, không phụ thuộc sở thích.
      const useFifo = entryTimedOut || candidates.some((item) => item.relaxed);
      let selected = useFifo ? candidates[0] : null;

      if (!useFifo) {
        // Trước timeout, tối đa hóa sở thích chung; giữ ứng viên FIFO khi đồng điểm.
        selected = candidates.reduce((best, item) => (
          item.score > best.score ? item : best
        ));
      }

      const bestMatch = selected.candidate;
      const bestCommon = selected.common;

      // Xóa cả hai khỏi hàng đợi
      this.waitingQueue.delete(newEntry.clientId);
      this.waitingQueue.delete(bestMatch.clientId);

      console.log(`[Matchmaker] ★ Match: ${newEntry.nickname} (${newEntry.mood}) ↔ ${bestMatch.nickname} (${bestMatch.mood}), common=[${bestCommon.join(', ')}]`);

      // Gọi callback
      this.onMatch(newEntry, bestMatch, bestCommon);
    }
  }

  /**
   * Quét định kỳ hàng đợi để ghép cặp các người chờ quá lâu.
   * Khi chờ quá STRICT_TIMEOUT, nới lỏng điều kiện → ghép FIFO.
   */
  _scanQueue() {
    if (this.redisManager && this.redisManager.enabled) {
      this.redisManager.scanMatchQueue().catch((error) => {
        console.error('[Matchmaker] Redis queue scan failed:', error.message);
      });
      return;
    }

    if (this.waitingQueue.size < 2) return;

    const now = Date.now();
    const entries = [...this.waitingQueue.values()];

    // Sắp xếp theo thời gian vào hàng đợi (chờ lâu nhất trước)
    entries.sort((a, b) => a.joinedAt - b.joinedAt);

    // Duyệt từ người chờ lâu nhất
    for (const entry of entries) {
      // Bỏ qua nếu đã bị xóa trong vòng lặp này
      if (!this.waitingQueue.has(entry.clientId)) continue;

      const waited = now - entry.joinedAt;
      if (waited >= STRICT_TIMEOUT) {
        // Đã chờ đủ lâu → thử ghép với bất kỳ ai còn trong hàng đợi
        this._tryMatch(entry);
      }
    }
  }

  /**
   * Dọn dẹp khi shutdown server.
   */
  destroy() {
    clearInterval(this._scanTimer);
    this.waitingQueue.clear();
  }
}

module.exports = Matchmaker;
