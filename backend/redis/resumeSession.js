
'use strict';

const crypto = require('crypto');

class ResumeSessionManager {
  constructor() {
    // tokenHash -> thông tin phiên chat
    this.sessions = new Map();

    // clientId -> tokenHash
    this.clientTokens = new Map();
  }

  // Cấp token cho một client trong phòng
  createSession(clientId, roomId) {
    // Hủy token cũ nếu có
    this.revokeSession(clientId);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    this.sessions.set(tokenHash, {
      clientId,
      roomId,
      expiresAt: null
    });

    this.clientTokens.set(clientId, tokenHash);

    // Chỉ trả token gốc lúc cấp cho client
    return token;
  }

  hashToken(token) {
    return crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
  }

  // Khi mất kết nối, token chỉ còn hiệu lực 30 giây
  markDisconnected(clientId, timeoutMs = 30000) {
    const tokenHash = this.clientTokens.get(clientId);
    if (!tokenHash) return false;

    const session = this.sessions.get(tokenHash);
    if (!session) return false;

    // Không gia hạn nếu đã có deadline
    if (session.expiresAt === null) {
      session.expiresAt = Date.now() + timeoutMs;
    }

    return true;
  }

  // Kiểm tra token có thuộc phiên đang chờ khôi phục không
  validateResumeToken(token) {
    if (typeof token !== 'string' ||
        !/^[0-9a-f]{64}$/.test(token)) {
      return null;
    }

    const tokenHash = this.hashToken(token);
    const session = this.sessions.get(tokenHash);

    if (!session || session.expiresAt === null) {
      return null;
    }

    if (Date.now() >= session.expiresAt) {
      return null;
    }

    return {
      clientId: session.clientId,
      roomId: session.roomId,
      expiresAt: session.expiresAt
    };
  }

  // Hủy token sau khi rời phòng hoặc hết thời hạn
  revokeSession(clientId) {
    const tokenHash = this.clientTokens.get(clientId);
    if (!tokenHash) return;

    this.sessions.delete(tokenHash);
    this.clientTokens.delete(clientId);
  }
}

module.exports = ResumeSessionManager;
