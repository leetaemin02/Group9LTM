/**
 * roomManager.js – Quản lý phòng chat 1-1
 *
 * Mỗi phòng (Room) chứa đúng 2 client. Module này:
 *   1. Tạo phòng mới khi ghép cặp thành công.
 *   2. Tra cứu phòng theo clientId.
 *   3. Lấy đối phương (partner) trong phòng.
 *   4. Xóa phòng khi một bên rời đi hoặc mất kết nối.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const GAME_SIZES = [10, 15, 20];

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} roomId → Room object */
    this.rooms = new Map();

    /** @type {Map<string, string>} clientId → roomId (tra cứu nhanh) */
    this.clientRoomMap = new Map();
  }

  /**
   * Tạo phòng chat mới giữa hai client (hoặc giữa 1 client và Bot Đồng Hành).
   * @param {string} clientId1
   * @param {string} clientId2
   * @param {boolean} [isBotRoom=false]
   * @param {object|null} [botInstance=null]
   * @returns {string} roomId
   */
  createRoom(clientId1, clientId2, isBotRoom = false, botInstance = null) {
    const roomId = uuidv4();
    const room = {
      roomId,
      clients: [clientId1, clientId2],
      isBotRoom,
      bot: botInstance,
      createdAt: Date.now(),
      game: null, // Trạng thái minigame 1-1
    };

    this.rooms.set(roomId, room);
    this.clientRoomMap.set(clientId1, roomId);
    this.clientRoomMap.set(clientId2, roomId);

    console.log(`[RoomManager] +Room: ${roomId} (${clientId1} ↔ ${clientId2})${isBotRoom ? ' [BOT]' : ''}, totalRooms=${this.rooms.size}`);
    return roomId;
  }

  /**
   * Lấy roomId mà client đang ở.
   * @param {string} clientId
   * @returns {string|null}
   */
  getRoomId(clientId) {
    return this.clientRoomMap.get(clientId) || null;
  }

  /**
   * Lấy thông tin phòng theo roomId.
   * @param {string} roomId
   * @returns {Room|null}
   */
  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  /**
   * Kiểm tra client có đang trong phòng chat không.
   * @param {string} clientId
   * @returns {boolean}
   */
  isInRoom(clientId) {
    return this.clientRoomMap.has(clientId);
  }

  /**
   * Lấy clientId của đối phương trong phòng.
   * @param {string} clientId
   * @returns {string|null}
   */
  getPartnerId(clientId) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    return room.clients.find((id) => id !== clientId) || null;
  }

  /**
   * Xóa phòng chat. Trả về mảng clientId từng ở trong phòng.
   * @param {string} roomId
   * @returns {string[]} Mảng clientId
   */
  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    // Nếu là phòng Bot, dọn dẹp các timer của Bot
    if (room.bot && typeof room.bot.destroy === 'function') {
      room.bot.destroy();
    }

    const clients = [...room.clients];
    for (const cid of clients) {
      this.clientRoomMap.delete(cid);
    }
    this.rooms.delete(roomId);

    console.log(`[RoomManager] -Room: ${roomId}, totalRooms=${this.rooms.size}`);
    return clients;
  }

  /**
   * Xóa client khỏi phòng (khi rời hoặc mất kết nối).
   * Trả về { roomId, partnerId } nếu có, hoặc null.
   * @param {string} clientId
   * @returns {{ roomId: string, partnerId: string } | null}
   */
  removeClient(clientId) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) {
      this.clientRoomMap.delete(clientId);
      return null;
    }

    const partnerId = room.clients.find((id) => id !== clientId) || null;

    // Xóa phòng
    this.removeRoom(roomId);

    return { roomId, partnerId };
  }

  /**
   * Kiểm tra client có đang trò chuyện với Bot Đồng Hành không.
   * @param {string} clientId
   * @returns {boolean}
   */
  isBotRoom(clientId) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return false;
    const room = this.rooms.get(roomId);
    return Boolean(room && room.isBotRoom);
  }

  /**
   * Lấy instance Bot của phòng nếu có.
   * @param {string} clientId
   * @returns {object|null}
   */
  getBot(clientId) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    return (room && room.isBotRoom && room.bot) ? room.bot : null;
  }

  // ─── Quản lý Minigame 1-1 (Cờ Caro / Gomoku Mini) ──────────────────────

  /**
   * Khởi tạo hoặc bắt đầu ván cờ Caro trong phòng.
   * @param {string} roomId
   * @param {string} inviterId
   * @param {string} partnerId
   * @param {number} [size=10] - Kích thước cạnh bàn cờ: 10, 15 hoặc 20
   */
  initGame(roomId, inviterId, partnerId, size = 10) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const boardSize = GAME_SIZES.includes(size) ? size : 10;
    const winLength = 5;

    room.game = {
      type: 'caro',
      size: boardSize,
      winLength,
      board: Array(boardSize * boardSize).fill(null),
      xPlayer: inviterId,         // Người mời đánh trước (X)
      oPlayer: partnerId,         // Người nhận đánh sau (O)
      turn: inviterId,            // Lượt hiện tại
      status: 'playing',          // 'playing' | 'ended'
      winner: null,               // 'X' | 'O' | 'draw' | null
      winnerId: null,
      winningLine: null,
      lastMove: null,
    };

    return room.game;
  }

  /**
   * Thực hiện một nước đi trên bàn cờ.
   * @param {string} roomId
   * @param {string} clientId
   * @param {number} index
   * @returns {{ ok: boolean, error?: string, game?: object }}
   */
  makeGameMove(roomId, clientId, index) {
    const room = this.rooms.get(roomId);
    if (!room || !room.game) return { ok: false, error: 'Chưa có ván game nào đang diễn ra' };

    const game = room.game;
    const size = game.size || 10;
    const winLength = game.winLength || 5;

    if (game.status !== 'playing') return { ok: false, error: 'Ván cờ đã kết thúc' };
    if (game.turn !== clientId) return { ok: false, error: 'Chưa đến lượt của bạn' };
    if (index < 0 || index >= game.board.length) return { ok: false, error: 'Ô không hợp lệ' };
    if (game.board[index] !== null) return { ok: false, error: 'Ô này đã được đánh rồi' };

    const symbol = clientId === game.xPlayer ? 'X' : 'O';
    game.board[index] = symbol;
    game.lastMove = index;

    // Kiểm tra thắng động cho bàn cờ size x size với điều kiện thắng là winLength quân liên tiếp
    const row = Math.floor(index / size);
    const col = index % size;

    const DIRECTIONS = [
      [0, 1],   // Ngang
      [1, 0],   // Dọc
      [1, 1],   // Chéo chính \
      [1, -1],  // Chéo phụ /
    ];

    let hasWon = false;
    let winningLine = null;

    for (const [dr, dc] of DIRECTIONS) {
      const line = [index];

      // Đi xuôi theo hướng
      let r = row + dr;
      let c = col + dc;
      while (r >= 0 && r < size && c >= 0 && c < size) {
        const idx = r * size + c;
        if (game.board[idx] === symbol) {
          line.push(idx);
          r += dr;
          c += dc;
        } else {
          break;
        }
      }

      // Đi ngược lại
      r = row - dr;
      c = col - dc;
      while (r >= 0 && r < size && c >= 0 && c < size) {
        const idx = r * size + c;
        if (game.board[idx] === symbol) {
          line.unshift(idx);
          r -= dr;
          c -= dc;
        } else {
          break;
        }
      }

      if (line.length >= winLength) {
        hasWon = true;
        // Sắp xếp các ô trong winningLine theo thứ tự tăng dần
        winningLine = line.sort((a, b) => a - b);
        break;
      }
    }

    if (hasWon) {
      game.status = 'ended';
      game.winner = symbol;
      game.winnerId = clientId;
      game.winningLine = winningLine;
    } else if (game.board.every((cell) => cell !== null)) {
      game.status = 'ended';
      game.winner = 'draw';
      game.winnerId = null;
    }

    // Đổi lượt nếu game còn tiếp diễn
    if (game.status === 'playing') {
      game.turn = clientId === game.xPlayer ? game.oPlayer : game.xPlayer;
    }

    return { ok: true, game };
  }

  /**
   * Chơi lại ván mới trong cùng phòng.
   * @param {string} roomId
   * @param {number} [newSize=null]
   */
  resetGame(roomId, newSize = null) {
    const room = this.rooms.get(roomId);
    if (!room || !room.game) return null;

    // Đảo lượt đánh trước cho ván sau
    const oldX = room.game.xPlayer;
    const oldO = room.game.oPlayer;
    const size = GAME_SIZES.includes(newSize) ? newSize : (room.game.size || 10);
    const winLength = 5;

    room.game = {
      type: 'caro',
      size,
      winLength,
      board: Array(size * size).fill(null),
      xPlayer: oldO,
      oPlayer: oldX,
      turn: oldO,
      status: 'playing',
      winner: null,
      winnerId: null,
      winningLine: null,
      lastMove: null,
    };

    return room.game;
  }

  /**
   * Đóng/rời minigame.
   * @param {string} roomId
   */
  quitGame(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.game = null;
    return true;
  }

  /**
   * Số phòng hiện tại.
   * @returns {number}
   */
  get roomCount() {
    return this.rooms.size;
  }
}

module.exports = RoomManager;
