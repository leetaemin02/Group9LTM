
const {
  addViolation,
  getViolationCount,
  getBanRemaining
} = require('../backend/redis/violationStore');

const {
  redis,
  closeRedis
} = require('../backend/redis/redisClient');

async function main() {
  const deviceId = 'test-device-001';
  const strikeKey = `violations:${deviceId}`;
  const banKey = `violations:ban:${deviceId}`;

  try {
    // Dọn dữ liệu test
    await redis.del(strikeKey, banKey);

    for (let i = 1; i <= 3; i++) {
      const result = await addViolation(deviceId);
      console.log(`Lỗi ${i}:`, result);
    }

    console.log(
      'Số lỗi sau khi ban:',
      await getViolationCount(deviceId)
    );

    console.log(
      'Thời gian ban còn lại:',
      await getBanRemaining(deviceId),
      'giây'
    );

    // Kiểm tra vi phạm tiếp khi đang ban
    console.log(
      'Khi đang ban:',
      await addViolation(deviceId)
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
