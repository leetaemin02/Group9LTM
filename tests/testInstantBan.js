
const {
  addViolation,
  getViolationCount,
  getBanRemaining,
  instantBan
} = require('../backend/redis/violationStore');

const {
  redis,
  closeRedis
} = require('../backend/redis/redisClient');

async function main() {
  const deviceId = 'test-instant-ban-001';
  const strikeKey = `violations:${deviceId}`;
  const banKey = `violations:ban:${deviceId}`;

  try {
    await redis.del(strikeKey, banKey);

    // Tạo 2 lỗi trước đó
    await addViolation(deviceId);
    await addViolation(deviceId);

    console.log(
      'Lỗi trước ban:',
      await getViolationCount(deviceId)
    );

    // Vi phạm tầng 4 -> ban ngay
    const result = await instantBan(deviceId);
    console.log('Kết quả:', result);

    console.log(
      'Lỗi sau ban:',
      await getViolationCount(deviceId)
    );

    console.log(
      'TTL ban:',
      await getBanRemaining(deviceId)
    );

  } finally {
    await redis.del(strikeKey, banKey);
    await closeRedis();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
