
'use strict';

const { redis } = require('./redisClient');

const MAX_STRIKES = 3;
const STRIKE_TTL = 3 * 60 * 60; // 3 giờ
const BAN_TTL = 10 * 60;       // 10 phút

const ADD_VIOLATION_SCRIPT = `
  local strikeKey = KEYS[1]
  local banKey = KEYS[2]

  local maxStrikes = tonumber(ARGV[1])
  local strikeTTL = tonumber(ARGV[2])
  local banTTL = tonumber(ARGV[3])

  -- Nếu đang bị ban, không tăng thêm vi phạm
  local remainingBan = redis.call('TTL', banKey)
  if remainingBan > 0 then
    return {0, 1, remainingBan}
  end

  -- Tăng số lần vi phạm
  local count = redis.call('INCR', strikeKey)

  -- Chỉ đặt TTL ở lần vi phạm đầu tiên
  if count == 1 then
    redis.call('EXPIRE', strikeKey, strikeTTL)
  end

  -- Nếu đủ 3 lỗi thì ban và xóa toàn bộ lỗi
  if count >= maxStrikes then
    redis.call('SET', banKey, '1', 'EX', banTTL)
    redis.call('DEL', strikeKey)
    return {count, 1, banTTL}
  end

  return {count, 0, 0}
`;

function keysFor(deviceId) {
    // kiem tra deviceId hop le
    if (typeof deviceId !== 'string' || !deviceId.trim()) {
        throw new Error('deviceId không hợp lệ');
    }
    //tao ten redis key
    return {
        strikeKey: `violations:${deviceId}`,
        banKey: `violations:ban:${deviceId}`
    };
}

async function addViolation(deviceId) {
  const { strikeKey, banKey } = keysFor(deviceId);

  const result = await redis.eval(
    ADD_VIOLATION_SCRIPT,
    2,
    strikeKey,
    banKey,
    MAX_STRIKES,
    STRIKE_TTL,
    BAN_TTL
  );

  const [count, banned, remainingBan] = result.map(Number);

  return {
    count,
    banned: banned === 1,
    remainingBan
  };
}

async function getViolationCount(deviceId) {
  const { strikeKey } = keysFor(deviceId);
  return Number(await redis.get(strikeKey) || 0);
}

async function getBanRemaining(deviceId) {
  const { banKey } = keysFor(deviceId);
  const ttl = await redis.ttl(banKey);
  return Math.max(0, ttl);
}


const INSTANT_BAN_SCRIPT = `
  local strikeKey = KEYS[1]
  local banKey = KEYS[2]
  local banTTL = tonumber(ARGV[1])

  local remaining = redis.call('TTL', banKey)

  -- Nếu đang bị ban, giữ nguyên hạn ban hiện tại
  if remaining > 0 then
    redis.call('DEL', strikeKey)
    return remaining
  end

  -- Tạo ban mới và xóa toàn bộ lỗi cũ
  redis.call('SET', banKey, '1', 'EX', banTTL)
  redis.call('DEL', strikeKey)

  return banTTL
`;

async function instantBan(deviceId) {
  const { strikeKey, banKey } = keysFor(deviceId);

  const remainingBan = await redis.eval(
    INSTANT_BAN_SCRIPT,
    2,
    strikeKey,
    banKey,
    BAN_TTL
  );

  return {
    banned: true,
    remainingBan: Number(remainingBan)
  };
}


module.exports = {
  addViolation,
  getViolationCount,
  getBanRemaining,
  instantBan
};
