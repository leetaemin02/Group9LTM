'use strict';

const GAME_SIZES = [10, 15, 20];
const GAME_TTL_SECONDS = 7200;

function gameKey(roomId) {
  return `chat:{match}:game:${roomId}`;
}

function ensureRedis(redisManager) {
  if (!redisManager.isConnected || !redisManager.pubClient) {
    throw new Error('Redis chưa sẵn sàng để xử lý Caro.');
  }

  return redisManager.pubClient;
}

// Tạo ván cờ chung trong Redis
async function createGame(redisManager, roomId, xPlayer, oPlayer, size = 10) {
  const redis = ensureRedis(redisManager);

  if (!roomId || !xPlayer || !oPlayer || xPlayer === oPlayer) {
    throw new Error('Thông tin phòng Caro không hợp lệ.');
  }

  const boardSize = GAME_SIZES.includes(size) ? size : 10;

  const game = {
    type: 'caro',
    size: boardSize,
    winLength: 5,
    board: Array(boardSize * boardSize).fill(null),
    xPlayer,
    oPlayer,
    turn: xPlayer,
    status: 'playing',
    winner: null,
    winnerId: null,
    winningLine: null,
    lastMove: null
  };

  const result = await redis.set(
    gameKey(roomId),
    JSON.stringify(game),
    'EX',
    GAME_TTL_SECONDS,
    'NX'
  );

  if (result !== 'OK') {
    throw new Error('Phòng này đã có ván Caro.');
  }

  return game;
}

// Lấy trạng thái ván cờ từ Redis
async function getGame(redisManager, roomId) {
  const redis = ensureRedis(redisManager);

  const data = await redis.get(gameKey(roomId));

  return data ? JSON.parse(data) : null;
}

// Lua script: kiểm tra và thực hiện nước đi nguyên tử trong Redis
const MAKE_MOVE_SCRIPT = `
local key = KEYS[1]
local clientId = ARGV[1]
local index = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local raw = redis.call('GET', key)
if not raw then
  return cjson.encode({ok=false, error='Chưa có ván game nào đang diễn ra'})
end

local game = cjson.decode(raw)
local size = tonumber(game.size)
local board = game.board

if game.status ~= 'playing' then
  return cjson.encode({ok=false, error='Ván cờ đã kết thúc'})
end

if clientId ~= game.xPlayer and clientId ~= game.oPlayer then
  return cjson.encode({ok=false, error='Bạn không thuộc ván cờ này'})
end

if game.turn ~= clientId then
  return cjson.encode({ok=false, error='Chưa đến lượt của bạn'})
end

if not index or index ~= math.floor(index)
  or index < 0 or index >= size * size then
  return cjson.encode({ok=false, error='Ô không hợp lệ'})
end

local position = index + 1
if board[position] ~= cjson.null then
  return cjson.encode({ok=false, error='Ô này đã được đánh rồi'})
end

local symbol = clientId == game.xPlayer and 'X' or 'O'
board[position] = symbol
game.lastMove = index

local row = math.floor(index / size)
local col = index % size
local directions = {{0,1},{1,0},{1,1},{1,-1}}
local winLength = tonumber(game.winLength) or 5
local winningLine = nil

for _, dir in ipairs(directions) do
  local line = {index}

  for _, sign in ipairs({1,-1}) do
    local r = row + dir[1] * sign
    local c = col + dir[2] * sign

    while r >= 0 and r < size and c >= 0 and c < size do
      local cellIndex = r * size + c

      if board[cellIndex + 1] ~= symbol then
        break
      end

      table.insert(line, cellIndex)
      r = r + dir[1] * sign
      c = c + dir[2] * sign
    end
  end

  if #line >= winLength then
    table.sort(line)
    winningLine = line
    break
  end
end

if winningLine then
  game.status = 'ended'
  game.winner = symbol
  game.winnerId = clientId
  game.winningLine = winningLine
else
  local full = true

  for i = 1, size * size do
    if board[i] == cjson.null then
      full = false
      break
    end
  end

  if full then
    game.status = 'ended'
    game.winner = 'draw'
    game.winnerId = cjson.null
    game.winningLine = cjson.null
  else
    game.turn = clientId == game.xPlayer
      and game.oPlayer or game.xPlayer
  end
end

redis.call('SET', key, cjson.encode(game), 'EX', ttl)
return cjson.encode({ok=true, game=game})
`;

async function makeMove(redisManager, roomId, clientId, index) {
  const redis = ensureRedis(redisManager);

  if (!roomId || !clientId) {
    throw new Error('Thiếu thông tin phòng hoặc người chơi.');
  }

  const response = await redis.eval(
    MAKE_MOVE_SCRIPT,
    1,
    gameKey(roomId),
    clientId,
    String(index),
    String(GAME_TTL_SECONDS)
  );

  return JSON.parse(response);
}

// Reset ván cờ nguyên tử, đảo người đi trước
const RESET_GAME_SCRIPT = `
local key = KEYS[1]
local requestedSize = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local raw = redis.call('GET', key)
if not raw then
  return cjson.encode({
    ok = false,
    error = 'Chưa có ván game nào đang diễn ra'
  })
end

local game = cjson.decode(raw)
local oldX = game.xPlayer
local oldO = game.oPlayer

local size = tonumber(game.size)
if requestedSize == 10 or requestedSize == 15
  or requestedSize == 20 then
  size = requestedSize
end

game.size = size
game.winLength = 5
game.board = {}

for i = 1, size * size do
  game.board[i] = cjson.null
end

game.xPlayer = oldO
game.oPlayer = oldX
game.turn = oldO
game.status = 'playing'
game.winner = cjson.null
game.winnerId = cjson.null
game.winningLine = cjson.null
game.lastMove = cjson.null

redis.call('SET', key, cjson.encode(game), 'EX', ttl)

return cjson.encode({
  ok = true,
  game = game
})
`;

async function resetGame(redisManager, roomId, newSize = null) {
  const redis = ensureRedis(redisManager);

  const size = [10, 15, 20].includes(newSize)
    ? newSize
    : 0;

  const response = await redis.eval(
    RESET_GAME_SCRIPT,
    1,
    gameKey(roomId),
    String(size),
    String(GAME_TTL_SECONDS)
  );

  return JSON.parse(response);
}

// Xóa trạng thái Caro dùng chung
async function quitGame(redisManager, roomId) {
  const redis = ensureRedis(redisManager);

  return (await redis.del(gameKey(roomId))) === 1;
}

module.exports = {
  createGame,
  getGame,
  makeMove,
  resetGame,
  quitGame
};