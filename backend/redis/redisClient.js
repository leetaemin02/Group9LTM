'use strict';

const Redis = require('ioredis');

const REDIS_URL =
  process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redis = new Redis(REDIS_URL);

redis.on('ready', () => {
  console.log('[Redis Store] Connected');
});

redis.on('error', (err) => {
  console.error('[Redis Store]', err.message);
});

async function closeRedis() {
  await redis.quit();
}

module.exports = {
  redis,
  closeRedis
};
