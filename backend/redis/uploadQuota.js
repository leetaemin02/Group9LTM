'use strict';

const RESERVE_UPLOAD_SCRIPT = `
local uploadId = ARGV[1]
local globalLimitBytes = tonumber(ARGV[2])
local conversationLimitBytes = tonumber(ARGV[3])
local conversationFileLimit = tonumber(ARGV[4])
local size = tonumber(ARGV[5])

if redis.call('EXISTS', KEYS[4]) == 1 then
  return 1
end

local globalBytes = tonumber(redis.call('GET', KEYS[1]) or '0')
local conversationBytes = tonumber(redis.call('GET', KEYS[2]) or '0')
local conversationFiles = redis.call('SCARD', KEYS[3])

if globalBytes + size > globalLimitBytes then
  return -1
end
if conversationFiles >= conversationFileLimit then
  return -2
end
if conversationBytes + size > conversationLimitBytes then
  return -3
end

redis.call('INCRBY', KEYS[1], size)
redis.call('INCRBY', KEYS[2], size)
redis.call('SADD', KEYS[3], uploadId)
redis.call('SET', KEYS[4], size, 'EX', 3600)
return 0
`;

module.exports = { RESERVE_UPLOAD_SCRIPT };
