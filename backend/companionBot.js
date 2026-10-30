/**
 * companionBot.js – Trợ lý Đồng hành Tâm sự & AI Minigame (Lumi)
 *
 * Đảm bảo người dùng không bao giờ bị cô độc hay bị đẩy ra ngoài khi chỉ có 1 mình:
 *   1. Lắng nghe, chia sẻ và giãi bày tâm sự chân thành theo tâm trạng của người dùng.
 *   2. Hướng dẫn các bài tập thư giãn, giải tỏa áp lực, stress.
 *   3. Chơi Minigame Cờ Caro 10x10, 15x15 hoặc 20x20 1-1 với chiến thuật tự động.
 *   4. Tự động phản hồi mượt mà với hiệu ứng typing indicator như người thật.
 */

'use strict';

const BOT_CLIENT_ID_PREFIX = 'bot-companion-';
const BOT_NICKNAME = 'Lumi ✨';
const BOT_MOOD = 'Lắng nghe & Thấu hiểu';
const BOT_INTERESTS = ['tâm sự', 'lắng nghe', 'game', 'thư giãn'];

/** Lời chào mở đầu theo tâm trạng */
const WELCOME_MESSAGES_BY_MOOD = {
  chan_nan: [
    'Chào bạn nhé... Mình là Lumi. Mình nhận thấy bạn đang có chút mỏi mệt hoặc chán nản hôm nay. Không sao cả, nếu có điều gì nặng lòng, bạn cứ thoải mái trút hết ở đây nhé, mình luôn ở đây để lắng nghe bạn 🌧️🤍',
    'Chào bạn! Cuộc sống đôi lúc có những ngày thật chùng chình và nặng nề đúng không? Mình là Lumi, bạn cứ xem đây là góc nhỏ bình yên, giãi bày bất cứ điều gì bạn muốn nhé.',
  ],
  tam_su: [
    'Chào bạn! Mình là Lumi – người bạn đồng hành của bạn hôm nay. Ngày hôm nay của bạn thế nào? Nếu có câu chuyện hay tâm tư gì muốn chia sẻ, mình luôn sẵn sàng lắng nghe mọi điều 🌙✨',
    'Chào bạn thân mến! Có những chuyện giữ trong lòng mãi sẽ rất mệt. Rất vui vì bạn đã ở đây, hãy thoải mái tâm sự cùng Lumi nhé!',
  ],
  vui_ve: [
    'Chào bạn! Oa, hôm nay năng lượng tích cực của bạn lan tỏa đến cả Lumi rồi này! ☀️ Có tin vui hay điều gì hào hứng muốn chia sẻ cùng mình không nào? 🎉',
    'Chào ngày mới rực rỡ! Lumi rất vui được gặp bạn hôm nay. Hãy cùng lan tỏa niềm vui và trò chuyện vui vẻ nhé!',
  ],
  tim_ban_game: [
    'Chào game thủ! Lumi cũng cực kỳ mê game đây 🎮 Trong lúc chờ thêm người vào phòng, bạn có muốn so tài một ván Cờ Caro 1-1 với Lumi để khởi động và thư giãn đầu óc không? Bấm nút "🎮 Caro 1-1" ở trên nha!',
    'Chào bạn! Đồng đội game đây rồi! Nếu muốn giải trí một ván cờ Caro, bấm nút "🎮 Caro 1-1" ngay nhé, Lumi sẵn sàng nghênh chiến!',
  ],
  hoc_tap: [
    'Chào bạn! Cùng nhau nạp năng lượng học tập và làm việc thật tập trung nào 📚 Hôm nay bạn đang ôn tập môn gì hay làm dự án nào thế? Cần một chút âm nhạc hay trò chuyện thư giãn cứ bảo Lumi nha!',
    'Chào bạn hiếu học! Học tập và làm việc chăm chỉ là rất tốt, nhưng nhớ giải lao thư giãn mắt nhé. Có gì thú vị muốn trao đổi không nè?',
  ],
  ngau_nhien: [
    'Chào bạn! Mình là Lumi – Trợ lý Đồng hành của hệ thống. Rất có duyên khi chúng mình gặp nhau ở đây! Bạn muốn tâm sự xả stress, trò chuyện vu vơ hay thử thách một ván cờ Caro giải trí cùng mình nào? ☕✨',
  ],
};

/** Kịch bản phản hồi thông minh theo từ khóa cảm xúc */
const CONVERSATION_PATTERNS = [
  // 1. Áp lực, mệt mỏi, stress, kiệt sức
  {
    regex: /(mệt|stress|áp lực|kiệt sức|đuối|chán quá|oải|nản)/i,
    replies: [
      'Nghe bạn nói vậy, mình cảm thấy bạn đã phải gồng gánh rất nhiều việc gần đây rồi. Hít một hơi thật sâu nào... Thở ra từ từ. Bạn có muốn kể chi tiết điều gì đang làm bạn thấy áp lực nhất không?',
      'Bạn vất vả rồi! Đôi khi cho phép bản thân nghỉ ngơi một chút không phải là bỏ cuộc, mà là để sạc lại năng lượng. Bạn đã ăn uống đầy đủ hôm nay chưa?',
      'Lumi ở đây nghe bạn nói nè. Nếu công việc hay cuộc sống đang dồn dập quá, thử nhắm mắt lại 1 phút, buông lỏng hai vai. Mình tin bạn sẽ vượt qua được thôi, bạn giỏi hơn bạn nghĩ nhiều đấy!',
    ],
  },
  // 2. Nỗi buồn, cô đơn, khóc, thất vọng
  {
    regex: /(buồn|cô đơn|khóc|tủi thân|thất vọng|không ai hiểu|một mình)/i,
    replies: [
      'Gửi bạn một cái ôm thật ấm áp từ xa nhé 🫂 Dù đang có chuyện gì xảy ra, bạn không hề đơn độc đâu, Lumi luôn ở đây bên bạn. Hãy cứ trút hết tâm sự ra cho nhẹ lòng nhé.',
      'Khóc được cũng là một cách giải tỏa rất tốt bạn à, không cần phải lúc nào cũng tỏ ra mạnh mẽ đâu. Cứ nói ra hết với mình nhé, mình lắng nghe từ đầu đến cuối.',
      'Mỗi đám mây đen rồi cũng sẽ qua đi để nhường chỗ cho ánh mặt trời. Hãy kiên nhẫn và dịu dàng với chính bản thân mình hôm nay nhé!',
    ],
  },
  // 3. Tình cảm, tình yêu, crush, chia tay
  {
    regex: /(người yêu|crush|tình cảm|chia tay|tỏ tình|thất tình|hẹn hò)/i,
    replies: [
      'Chuyện tình cảm đúng là muôn màu muôn vẻ, vừa ngọt ngào mà cũng lắm lúc làm tim mình đau nhói nhỉ! Chuyện của bạn đang thế nào rồi, kể thêm cho Lumi nghe với?',
      'Trong tình cảm, điều quan trọng nhất vẫn là bạn cảm thấy được trân trọng và an yên. Bạn đang băn khoăn hay có niềm vui gì về người ấy thế?',
    ],
  },
  // 4. Học tập, thi cử, deadline, công việc
  {
    regex: /(học|thi|deadline|bài tập|sếp|công ty|thi cử|điểm kém)/i,
    replies: [
      'Áp lực công việc và học hành dễ làm người ta căng thẳng thật. Bí quyết của Lumi là: Chia nhỏ việc lớn thành từng việc tí hon 15 phút, làm xong việc nào gạch việc đó, sẽ thấy đỡ ngợp hơn rất nhiều đấy!',
      'Cố gắng lên nhé! Đừng quên giải lao giữa giờ, uống một ngụm nước ấm nha. Bạn đã hoàn thành được bao nhiêu phần rồi?',
    ],
  },
  // 5. Muốn chơi game, rủ chơi cờ
  {
    regex: /(chơi game|chơi cờ|caro|minigame|thách đấu|so tài)/i,
    replies: [
      'Haha thích quá! Bấm nút "🎮 Caro 1-1" ở thanh công cụ phía trên đi bạn, Lumi sẽ nhận lời thách đấu ngay và luôn nè! 🎮🔥',
      'Được luôn! Mình sẵn sàng rồi, bạn nhấn nút "🎮 Caro 1-1" ở góc trên để mở bàn cờ nhé!',
    ],
  },
  // 6. Khen ngợi, cảm ơn
  {
    regex: /(cảm ơn|thanks|thank you|lumi dễ thương|bot ngoan|đáng yêu)/i,
    replies: [
      'Được trò chuyện và đồng hành cùng bạn là niềm vui lớn nhất của Lumi mà! Cảm ơn bạn rất nhiều vì sự ấm áp này 🥰',
      'Không có chi đâu nè! Nhìn thấy bạn vui và nhẹ nhõm hơn là mình cũng thấy hạnh phúc lây rồi đó ✨',
    ],
  },
  // 7. Chào hỏi
  {
    regex: /^(chào|hi|hello|hế lô|alo|ê|lumi ơi)/i,
    replies: [
      'Chào bạn nha! Rất vui được trò chuyện cùng bạn. Hôm nay bạn có câu chuyện gì thú vị muốn chia sẻ không?',
      'Dạ Lumi nghe đây nè! Bạn đang làm gì thế, ngày hôm nay trôi qua êm ả chứ?',
    ],
  },
];

/** Các câu phản hồi chung khi tâm sự mở */
const DEFAULT_EMPATHETIC_REPLIES = [
  'Lumi hiểu cảm giác đó của bạn... Thật tốt vì bạn đã chọn chia sẻ điều này ra thay vì giữ kín một mình. Bạn cảm thấy thế nào khi nói ra điều này?',
  'Điều bạn vừa chia sẻ thật sự rất đáng suy ngẫm. Cuộc sống luôn có những góc nhìn mới nếu mình cho bản thân một khoảng lặng. Kể tiếp cho mình nghe nhé!',
  'Mình đang chăm chú lắng nghe bạn đây. Đôi khi chỉ cần một người chịu ngồi lại lắng nghe không phán xét là lòng đã nhẹ đi một nửa rồi đúng không bạn?',
  'Cảm ơn bạn đã tin tưởng tâm sự cùng Lumi. Hãy thả lỏng cơ thể một chút nhé. Còn điều gì bạn muốn trút bỏ nữa không?',
  'Nếu thấy hơi mỏi mắt hoặc căng thẳng, bạn thử bấm nút "🎮 Caro 1-1" ở trên để làm một ván cờ giải trí cùng Lumi xem sao nhé!',
];

/** Câu bình luận khi chơi cờ Caro với Bot */
const GAME_COMMENTS = {
  onMove: [
    'Nước này được nha, bạn làm mình phải suy nghĩ kỹ rồi đấy!',
    'Uầy, thế cờ bắt đầu căng thẳng rồi đó!',
    'Được đấy! Để xem Lumi phản công thế nào nhé 😉',
    'Nước cờ tinh tế ghê!',
  ],
  onBotWin: [
    'Hehe, ván này Lumi may mắn một xíu thôi! Bạn đánh rất cừ đó, làm lại ván nữa để phục thù không nào? 🏆',
    'Ván cờ kịch tính ghê! Cảm ơn bạn đã chơi cùng Lumi nhé. Bấm "Chơi lại" để thử sức tiếp nha!',
  ],
  onPlayerWin: [
    'Oa đỉnh quá! Bạn tính toán nước cờ quá xuất sắc, Lumi xin bái phục luôn 👏 Bạn giỏi thật đó!',
    'Bạn thắng thuyết phục luôn! Đầu óc quan sát của bạn nhạy bén ghê, chơi thêm ván nữa nhé?',
  ],
  onDraw: [
    'Bất phân thắng bại luôn! Đúng là kỳ phùng địch thủ, cả hai đều phòng thủ quá chắc chắn 🎉',
    'Ván cờ hòa đẹp mắt! Bạn chơi rất cân tay đó nha!',
  ],
};

class CompanionBot {
  /**
   * Khởi tạo Bot cho một người dùng
   * @param {string} userClientId
   * @param {string} userNickname
   * @param {string} userMood
   * @param {string[]} userInterests
   * @param {function} sendCallback - function(clientId, msgString)
   */
  constructor(userClientId, userNickname, userMood, userInterests, sendCallback) {
    this.userClientId = userClientId;
    this.userNickname = userNickname || 'Bạn';
    this.userMood = userMood || 'ngau_nhien';
    this.userInterests = userInterests || [];
    this.sendCallback = sendCallback;
    this.botClientId = `${BOT_CLIENT_ID_PREFIX}${userClientId}`;

    this.isTyping = false;
    this.typingTimeout = null;
    this.replyTimeout = null;
  }

  /**
   * Lấy thông tin đối tác giả lập cho sự kiện match_found
   */
  getPartnerInfo() {
    return {
      nickname: BOT_NICKNAME,
      mood: BOT_MOOD,
      interests: BOT_INTERESTS,
      isBot: true,
    };
  }

  /**
   * Gửi tin nhắn chào mừng đầu tiên khi mở phòng
   */
  sendWelcome() {
    const list = WELCOME_MESSAGES_BY_MOOD[this.userMood] || WELCOME_MESSAGES_BY_MOOD.ngau_nhien;
    const text = list[Math.floor(Math.random() * list.length)];

    // Giả lập typing nhẹ 800ms
    this._simulateTypingAndSend(text, 800);
  }

  /**
   * Xử lý tin nhắn người dùng gửi đến Bot
   * @param {string} userText
   */
  handleUserMessage(userText) {
    let reply = null;

    // 1. Quét theo bộ kịch bản từ khóa
    for (const pattern of CONVERSATION_PATTERNS) {
      if (pattern.regex.test(userText)) {
        const replies = pattern.replies;
        reply = replies[Math.floor(Math.random() * replies.length)];
        break;
      }
    }

    // 2. Nếu không khớp kịch bản cụ thể, lấy ngẫu nhiên câu thấu cảm
    if (!reply) {
      reply = DEFAULT_EMPATHETIC_REPLIES[Math.floor(Math.random() * DEFAULT_EMPATHETIC_REPLIES.length)];
    }

    // Tính thời gian gõ phím tự nhiên dựa theo độ dài tin nhắn (1.2s - 2.2s)
    const typingDuration = Math.min(2200, Math.max(1100, reply.length * 25));
    this._simulateTypingAndSend(reply, typingDuration);
  }

  /**
   * Tính toán nước cờ Caro cho bàn cờ từ 10x10 đến 20x20
   * @param {(string|null)[]} board - Mảng các ô cờ
   * @param {string} botSymbol - 'X' hoặc 'O'
   * @param {string} playerSymbol - 'X' hoặc 'O'
   * @returns {number} Chỉ số ô
   */
  computeMove(board, botSymbol, playerSymbol) {
    const totalCells = board.length;
    const size = Math.round(Math.sqrt(totalCells));
    const winLength = 5;

    const availableMoves = [];
    for (let i = 0; i < totalCells; i++) {
      if (board[i] === null) availableMoves.push(i);
    }
    if (availableMoves.length === 0) return -1;

    // ── Chiến thuật cho bàn cờ Caro kích thước lớn ──
    const DIRECTIONS = [
      [0, 1],   // Ngang
      [1, 0],   // Dọc
      [1, 1],   // Chéo \
      [1, -1],  // Chéo /
    ];

    // Hàm đếm chuỗi liên tiếp tối đa nếu đặt cờ tại một ô
    const evaluateMoveStreak = (idx, symbol) => {
      const r = Math.floor(idx / size);
      const c = idx % size;
      let maxStreak = 1;
      let openEnds = 0;

      for (const [dr, dc] of DIRECTIONS) {
        let streak = 1;
        let open1 = false;
        let open2 = false;

        // Xuôi
        let step = 1;
        while (true) {
          const nr = r + dr * step;
          const nc = c + dc * step;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
          const nIdx = nr * size + nc;
          if (board[nIdx] === symbol) {
            streak++;
            step++;
          } else {
            if (board[nIdx] === null) open1 = true;
            break;
          }
        }

        // Ngược
        step = 1;
        while (true) {
          const nr = r - dr * step;
          const nc = c - dc * step;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
          const nIdx = nr * size + nc;
          if (board[nIdx] === symbol) {
            streak++;
            step++;
          } else {
            if (board[nIdx] === null) open2 = true;
            break;
          }
        }

        if (streak > maxStreak) {
          maxStreak = streak;
          openEnds = (open1 ? 1 : 0) + (open2 ? 1 : 0);
        }
      }

      return { maxStreak, openEnds };
    };

    // 1. Kiểm tra nếu Bot có nước thắng ngay (đạt winLength)
    for (const move of availableMoves) {
      const { maxStreak } = evaluateMoveStreak(move, botSymbol);
      if (maxStreak >= winLength) return move;
    }

    // 2. Chặn Người chơi nếu họ sắp thắng (đạt winLength - 1)
    for (const move of availableMoves) {
      const { maxStreak } = evaluateMoveStreak(move, playerSymbol);
      if (maxStreak >= winLength) return move;
    }

    // 3. Chặn nước đi tạo thế nguy hiểm của Người chơi (ví dụ 3 quân thông 2 đầu)
    if (winLength >= 4) {
      let dangerousMoves = [];
      for (const move of availableMoves) {
        const { maxStreak, openEnds } = evaluateMoveStreak(move, playerSymbol);
        if (maxStreak >= winLength - 1 && openEnds >= 1) {
          dangerousMoves.push(move);
        }
      }
      if (dangerousMoves.length > 0) {
        return dangerousMoves[Math.floor(Math.random() * dangerousMoves.length)];
      }
    }

    // 4. Tìm nước tấn công tốt nhất cho Bot (ưu tiên chuỗi dài & thông thoáng)
    let bestBotScore = -1;
    let candidateMoves = [];

    // Chỉ xét các ô trong bán kính 2 ô quanh các quân cờ đã đánh để chơi tập trung, chiến thuật
    const occupiedIndices = [];
    for (let i = 0; i < totalCells; i++) {
      if (board[i] !== null) occupiedIndices.push(i);
    }

    // Nếu bàn cờ trống, đánh ở ô trung tâm
    if (occupiedIndices.length === 0) {
      const center = Math.floor(size / 2) * size + Math.floor(size / 2);
      return center;
    }

    const neighborMoves = availableMoves.filter(idx => {
      const r = Math.floor(idx / size);
      const c = idx % size;
      return occupiedIndices.some(occ => {
        const or = Math.floor(occ / size);
        const oc = occ % size;
        return Math.abs(r - or) <= 2 && Math.abs(c - oc) <= 2;
      });
    });

    const movesToEvaluate = neighborMoves.length > 0 ? neighborMoves : availableMoves;

    for (const move of movesToEvaluate) {
      const botEval = evaluateMoveStreak(move, botSymbol);
      const playerEval = evaluateMoveStreak(move, playerSymbol);

      // Điểm số kết hợp giữa công và thủ
      const score = (botEval.maxStreak * 2 + botEval.openEnds) + (playerEval.maxStreak * 1.5 + playerEval.openEnds);

      if (score > bestBotScore) {
        bestBotScore = score;
        candidateMoves = [move];
      } else if (score === bestBotScore) {
        candidateMoves.push(move);
      }
    }

    if (candidateMoves.length > 0) {
      return candidateMoves[Math.floor(Math.random() * candidateMoves.length)];
    }

    return availableMoves[Math.floor(Math.random() * availableMoves.length)];
  }

  /**
   * Lấy câu bình luận cho game
   * @param {'move'|'botWin'|'playerWin'|'draw'} type
   */
  getGameComment(type) {
    switch (type) {
      case 'move':
        return GAME_COMMENTS.onMove[Math.floor(Math.random() * GAME_COMMENTS.onMove.length)];
      case 'botWin':
        return GAME_COMMENTS.onBotWin[Math.floor(Math.random() * GAME_COMMENTS.onBotWin.length)];
      case 'playerWin':
        return GAME_COMMENTS.onPlayerWin[Math.floor(Math.random() * GAME_COMMENTS.onPlayerWin.length)];
      case 'draw':
        return GAME_COMMENTS.onDraw[Math.floor(Math.random() * GAME_COMMENTS.onDraw.length)];
      default:
        return '';
    }
  }

  /**
   * Hủy các timer khi rời phòng
   */
  destroy() {
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (this.replyTimeout) clearTimeout(this.replyTimeout);
  }

  // ─── Private Methods ─────────────────────────────────

  _simulateTypingAndSend(text, delayMs) {
    // 1. Gửi typing: true sau 300ms
    this.typingTimeout = setTimeout(() => {
      this.sendCallback(
        this.userClientId,
        JSON.stringify({
          type: 'typing',
          payload: { isTyping: true },
        })
      );
    }, 300);

    // 2. Gửi message & typing: false sau delayMs
    this.replyTimeout = setTimeout(() => {
      // Tắt typing
      this.sendCallback(
        this.userClientId,
        JSON.stringify({
          type: 'typing',
          payload: { isTyping: false },
        })
      );

      // Gửi tin nhắn
      this.sendCallback(
        this.userClientId,
        JSON.stringify({
          type: 'message',
          payload: {
            text,
            timestamp: new Date().toISOString(),
          },
        })
      );
    }, delayMs);
  }
}

module.exports = {
  BOT_CLIENT_ID_PREFIX,
  BOT_NICKNAME,
  BOT_MOOD,
  BOT_INTERESTS,
  CompanionBot,
};
