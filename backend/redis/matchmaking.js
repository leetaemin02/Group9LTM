const MATCH_SCRIPT = `
local queueKey = KEYS[1]
local sequenceKey = KEYS[2]
local entryPrefix = KEYS[3]
local matchChannel = KEYS[4]
local onlineKey = KEYS[5]
local mode = ARGV[1]
local strictTimeout = tonumber(ARGV[2])
local disallowSameIp = ARGV[3] == 'true'
local candidateLimit = tonumber(ARGV[4])
local maxMatches = tonumber(ARGV[5])
local now = tonumber(ARGV[6])

local function blocked(a, b)
  local aKeys = { a.clientId }
  local bKeys = { b.clientId }
  if a.deviceId and a.deviceId ~= '' then table.insert(aKeys, a.deviceId) end
  if b.deviceId and b.deviceId ~= '' then table.insert(bKeys, b.deviceId) end
  for _, aKey in ipairs(aKeys) do
    for _, bKey in ipairs(bKeys) do
      if redis.call('EXISTS', 'block:{match}:' .. aKey .. ':' .. bKey) == 1
        or redis.call('EXISTS', 'block:{match}:' .. bKey .. ':' .. aKey) == 1 then
        return true
      end
    end
  end
  return false
end

local function choose(source, sourceTimedOut)
  local ids = redis.call('ZRANGE', queueKey, 0, candidateLimit - 1)
  local candidates = {}
  for _, candidateId in ipairs(ids) do
    if candidateId ~= source.clientId then
      local candidateJson = redis.call('GET', entryPrefix .. candidateId)
      if candidateJson then
        local candidate = cjson.decode(candidateJson)
        local onlineAt = redis.call('ZSCORE', onlineKey, candidateId)
        if not onlineAt or now - tonumber(onlineAt) > 90000 then
          redis.call('ZREM', queueKey, candidateId)
          redis.call('DEL', entryPrefix .. candidateId)
          candidateJson = false
        end
        if candidateJson then
        local sameIp = disallowSameIp and source.clientIp and candidate.clientIp
          and source.clientIp == candidate.clientIp
        if not sameIp and not blocked(source, candidate) then
          local common = {}
          local candidateInterests = {}
          for _, interest in ipairs(candidate.interests or {}) do
            candidateInterests[interest] = true
          end
          for _, interest in ipairs(source.interests or {}) do
            if candidateInterests[interest] then table.insert(common, interest) end
          end

          local sameMood = source.mood and candidate.mood
            and source.mood ~= 'ngau_nhien'
            and source.mood == candidate.mood
          local score = #common + (sameMood and 2 or 0)
          local hasCriteria = #(source.interests or {}) > 0
            or #(candidate.interests or {}) > 0
            or (source.mood and source.mood ~= 'ngau_nhien')
            or (candidate.mood and candidate.mood ~= 'ngau_nhien')
          local candidateTimedOut = now - tonumber(candidate.joinedAt) >= strictTimeout
          local relaxed = sourceTimedOut or candidateTimedOut

          if not hasCriteria or relaxed or score > 0 then
            table.insert(candidates, {
              entry = candidate,
              common = common,
              score = score,
              relaxed = relaxed
            })
          end
        end
        end
      end
    end
  end

  if #candidates == 0 then return false end
  local selected = candidates[1]
  local useFifo = sourceTimedOut
  for _, item in ipairs(candidates) do
    if item.relaxed then useFifo = true end
  end
  if not useFifo then
    for _, item in ipairs(candidates) do
      if item.score > selected.score then selected = item end
    end
  end

  local partnerId = selected.entry.clientId
  local matchEvent = cjson.encode({
    entry1 = {
      clientId = source.clientId,
      nickname = source.nickname,
      interests = source.interests,
      mood = source.mood
    },
    entry2 = {
      clientId = selected.entry.clientId,
      nickname = selected.entry.nickname,
      interests = selected.entry.interests,
      mood = selected.entry.mood
    },
    commonInterests = selected.common
  })
  redis.call('ZREM', queueKey, source.clientId, partnerId)
  redis.call('DEL', entryPrefix .. source.clientId, entryPrefix .. partnerId)
  redis.call('SET', 'chat:{match}:pair:' .. source.clientId, matchEvent, 'EX', 60)
  redis.call('SET', 'chat:{match}:pair:' .. partnerId, matchEvent, 'EX', 60)
  redis.call('PUBLISH', matchChannel, matchEvent)
  return true
end

if mode == 'enqueue' then
  local source = cjson.decode(ARGV[7])
  if redis.call('ZSCORE', queueKey, source.clientId) then return 0 end
  local onlineAt = redis.call('ZSCORE', onlineKey, source.clientId)
  if not onlineAt or now - tonumber(onlineAt) > 90000 then return -1 end
  local sequence = redis.call('INCR', sequenceKey)
  redis.call('ZADD', queueKey, sequence, source.clientId)
  redis.call('SET', entryPrefix .. source.clientId, ARGV[7], 'EX', 3600)
  choose(source, now - tonumber(source.joinedAt) >= strictTimeout)
  return 1
end

local matched = 0
for _ = 1, maxMatches do
  local ids = redis.call('ZRANGE', queueKey, 0, candidateLimit - 1)
  local source = nil
  for _, clientId in ipairs(ids) do
    local entryJson = redis.call('GET', entryPrefix .. clientId)
    if entryJson then
      local entry = cjson.decode(entryJson)
      local onlineAt = redis.call('ZSCORE', onlineKey, clientId)
      if not onlineAt or now - tonumber(onlineAt) > 90000 then
        redis.call('ZREM', queueKey, clientId)
        redis.call('DEL', entryPrefix .. clientId)
      elseif now - tonumber(entry.joinedAt) >= strictTimeout then
        source = entry
        break
      end
    else
      redis.call('ZREM', queueKey, clientId)
    end
  end
  if not source or not choose(source, true) then break end
  matched = matched + 1
end
return matched
`;

module.exports = {
  MATCH_SCRIPT
};