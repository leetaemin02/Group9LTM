'use strict';

const assert = require('node:assert/strict');
const RedisManager = require('../backend/redisManager');

async function main() {
  const redis = new RedisManager({ enabled: false });
  const results = [0, 1, -1, -2, -3];
  const calls = [];
  redis.isConnected = true;
  redis.pubClient = {
    async eval(...args) {
      calls.push(args);
      return results.shift();
    },
  };

  assert.deepEqual(await redis.reserveAttachmentUpload({
    uploadId: 'upload-1',
    conversationId: 'conversation-1',
    size: 1024,
  }), { allowed: true, alreadyReserved: false });
  assert.equal(calls[0][1], 4, 'Quota reservation must use one atomic Redis script');
  assert.equal(calls[0][7], 500_000_000, 'Global quota should default to 500 decimal MB');
  assert.equal(calls[0][8], 50 * 1024 * 1024, 'Conversation quota should default to 50 MiB');
  assert.equal(calls[0][9], 5, 'Conversation quota should default to five files');

  assert.deepEqual(await redis.reserveAttachmentUpload({
    uploadId: 'upload-1',
    conversationId: 'conversation-1',
    size: 1024,
  }), { allowed: true, alreadyReserved: true });
  assert.deepEqual(await redis.reserveAttachmentUpload({
    uploadId: 'upload-2',
    conversationId: 'conversation-1',
    size: 1024,
  }), { allowed: false, reason: 'global_limit' });
  assert.deepEqual(await redis.reserveAttachmentUpload({
    uploadId: 'upload-3',
    conversationId: 'conversation-1',
    size: 1024,
  }), { allowed: false, reason: 'conversation_file_limit' });
  assert.deepEqual(await redis.reserveAttachmentUpload({
    uploadId: 'upload-4',
    conversationId: 'conversation-1',
    size: 1024,
  }), { allowed: false, reason: 'conversation_size_limit' });

  redis.isConnected = false;
  await assert.rejects(
    redis.reserveAttachmentUpload({
      uploadId: 'upload-5',
      conversationId: 'conversation-1',
      size: 1024,
    }),
    /Redis chưa sẵn sàng/u,
  );
  process.stdout.write('Upload quota tests passed.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
