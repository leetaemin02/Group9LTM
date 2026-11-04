/**
 * companionBot.js – Trợ lý Đồng hành Tâm sự & AI Minigame (Lumi)
 *
 * Đảm bảo người dùng không bao giờ bị cô độc hay bị đẩy ra ngoài khi chỉ có 1 mình:
 *   1. Lắng nghe, chia sẻ và giãi bày tâm sự chân thành theo tâm trạng của người dùng.
 *   2. Hướng dẫn các bài tập thư giãn, giải tỏa áp lực, stress.
 *   3. Chơi Minigame Cờ Caro 10x10, 15x15 hoặc 20x20 1-1 với chiến thuật tự động.
 *   4. Tự động phản hồi mượt mà với hiệu ứng typing indicator như người thật.
 *   5. (Tùy chọn) Trả lời bằng Groq API khi có GROQ_API_KEY – xem groqChat.js.
 *      Không có key, lỗi mạng hoặc hết quota → tự quay về kịch bản offline bên dưới.
 *
 * Trạng thái hội thoại (lịch sử ngắn) nằm trong RAM của instance Bot, bị xóa khi rời phòng.
 */

'use strict';

const groqChat = require('./groqChat');
const { serverMsg, MAX_MESSAGE_LENGTH } = require('./protocol');

const BOT_CLIENT_ID_PREFIX = 'bot-companion-';
const BOT_NICKNAME = 'Lumi ✨';
const BOT_MOOD = 'Lắng nghe & Thấu hiểu';
const BOT_INTERESTS = ['tâm sự', 'lắng nghe', 'game', 'thư giãn'];

/** Lời chào mở đầu theo tâm trạng – phong cách tự nhiên, ngắn gọn, thân thiện */
const WELCOME_MESSAGES_BY_MOOD = {
  chan_nan: [
    'Hế lô bạn! Dạo này đời hơi chán hay có ai làm bạn tụt mood hả? Vào đây xả với mình một chút cho nhẹ lòng nhé ✨',
    'Chào bạn nè! Nay có chuyện gì mệt mỏi hay áp lực thế? Cứ xem đây là góc nhỏ thoải mái, kể Lumi nghe xem nào!',
  ],
  tam_su: [
    'Chào bạn nha! Mình là Lumi đây. Có chuyện gì tâm tư hay drama gì nóng hổi không, kể mình hóng với nè 🌙✨',
    'Hế lô! Ngày hôm nay của bạn thế nào rồi? Cứ tự nhiên tâm sự với mình nhé, bí mật tuyệt đối luôn 😉',
  ],
  vui_ve: [
    'U là trời, thấy bạn vui vẻ là mình cũng vui lây rồi đó! Có tin gì hot kể ngay cho nóng nào 🎉',
    'Hế lô bạn! Năng lượng tích cực ngập tràn luôn ☀️ Nay có chuyện gì vui thế bạn ơi, chia sẻ miếng nào!',
  ],
  tim_ban_game: [
    'Chào chiến thần game thủ! Làm tí cờ Caro 1-1 khởi động tay chân không? Bấm nút "🎮 Caro 1-1" ở trên nhé 🎮🔥',
    'Hello bạn! Bàn cờ Caro sẵn sàng rồi nè, bấm "🎮 Caro 1-1" so tài với Lumi xem ai pro hơn nhé!',
  ],
  hoc_tap: [
    'Chào đồng chí! Đang chạy deadline hay ôn thi mà căng thẳng thế? Cứ nghỉ tay một xíu nói chuyện với mình nhé 📚☕',
    'Hế lô! Học tập với làm việc nhớ giữ gìn sức khỏe nha. Đang làm bài gì thế, khó quá thì than với mình tí nè!',
  ],
  ngau_nhien: [
    'Hế lô bạn! Mình là Lumi ✨ Rất vui được gặp bạn hôm nay. Muốn buôn chuyện vu vơ hay làm ván cờ Caro giải trí nào?',
    'Chào bạn nha! Tự nhiên lạc vào đây gặp nhau có duyên ghê. Ngày hôm nay của bạn thế nào rồi?',
  ],
};

/** Kịch bản phản hồi dự phòng offline – vui vẻ, ngắn gọn, tự nhiên */
const CONVERSATION_PATTERNS = [
  // 1. Áp lực, mệt mỏi, stress, kiệt sức
  {
    regex: /(mệt|stress|áp lực|kiệt sức|đuối|chán quá|oải|nản)/i,
    replies: [
      'Thương bạn ghê, làm việc hay học hành quá sức rồi đúng không? Uống miếng nước rồi hít thở sâu xíu nè, có muốn kể mình nghe không?',
      'Uầy vất vả cho bạn quá! Đời người có lúc này lúc khác, thôi thì tạm gác lại 5 phút buôn chuyện với mình cho đỡ nặng đầu nha.',
      'Lumi ở đây nghe bạn xả nè. Đừng gồng quá mức nha, bạn đã cố gắng nhiều lắm rồi đó!',
    ],
  },
  // 2. Nỗi buồn, cô đơn, khóc, thất vọng
  {
    regex: /(buồn|cô đơn|khóc|tủi thân|thất vọng|không ai hiểu|một mình)/i,
    replies: [
      'Gửi bạn một cái ôm từ xa nè 🫂 Có Lumi ở đây buôn chuyện rồi, không lo cô đơn nữa đâu. Kể mình nghe chuyện gì làm bạn buồn thế?',
      'Buồn thì cứ xả ra hết đi bạn ơi, giữ trong lòng ấm ức lắm. Mình ngồi nghe bạn giãi bày từ A đến Z luôn!',
      'Mỗi ngày mây đen rồi cũng sẽ qua đi thôi. Hãy kiên nhẫn và dịu dàng với chính bản thân mình hôm nay nha!',
    ],
  },
  // 3. Tình cảm, tình yêu, crush, chia tay
  {
    regex: /(người yêu|crush|tình cảm|chia tay|tỏ tình|thất tình|hẹn hò)/i,
    replies: [
      'Uầy nhắc tới chuyện tình cảm là có nhiều chuyện để hóng lắm nè! Crush hay người yêu làm sao, kể Lumi nghe với?',
      'Chuyện tình duyên đúng là lúc ngọt như kẹo lúc đắng ngắt nhỉ. Bạn đang gặp khúc mắc hay có gì băn khoăn thế?',
    ],
  },
  // 4. Học tập, thi cử, deadline, công việc
  {
    regex: /(học|thi|deadline|bài tập|sếp|công ty|thi cử|điểm kém)/i,
    replies: [
      'Cố lên bạn ơi, vượt qua được cái deadline này là lại thảnh thơi ngay! Đang bị dí môn gì hay dự án nào thế?',
      'Deadline dí dữ quá hả? Nhớ ăn uống đầy đủ và nghỉ giải lao tí nha, than thở với mình chút rồi lại chiến tiếp nào!',
    ],
  },
  // 5. Muốn chơi game, rủ chơi cờ
  {
    regex: /(chơi game|chơi cờ|caro|minigame|thách đấu|so tài)/i,
    replies: [
      'Kèo này căng đấy! Bấm nút "🎮 Caro 1-1" ở thanh menu trên cùng đi bạn, Lumi nhận kèo ngay và luôn! 🎮🔥',
      'Haha chiến luôn! Bấm "🎮 Caro 1-1" mở bàn cờ thử tài nhau liền đi nè, xem ai thắng nha!',
    ],
  },
  // 6. Khen ngợi, cảm ơn
  {
    regex: /(cảm ơn|thanks|thank you|lumi dễ thương|bot ngoan|đáng yêu)/i,
    replies: [
      'Hihi được bạn khen là mình vui cả ngày luôn á! Có gì cứ thoải mái nhắn mình nha 🥰',
      'Không có chi nè! Thấy bạn vui là mình cũng thấy hạnh phúc lây rồi đó ✨',
    ],
  },
  // 7. Chào hỏi
  {
    regex: /^(chào|hi|hello|hế lô|alo|ê|lumi ơi)/i,
    replies: [
      'Hế lô bạn nha! Hôm nay của bạn thế nào rồi?',
      'Dạ Lumi nghe nè! Đang làm gì đấy bạn ơi, ngày hôm nay trôi qua êm ả chứ?',
    ],
  },
];

/** Các câu phản hồi chung dự phòng */
const DEFAULT_EMPATHETIC_REPLIES = [
  'Uầy vậy hả bạn? Kể tiếp mình nghe với, tò mò ghê!',
  'Mình vẫn đang chăm chú nghe bạn nói đây nè. Thấy nhẹ lòng hơn tí nào chưa?',
  'Chuẩn luôn á! Nhiều khi nói ra được với một người lắng nghe thấy thoải mái hẳn bạn nhỉ?',
  'Cảm ơn bạn đã tin tưởng chia sẻ với Lumi nha. Còn điều gì muốn trút bỏ nữa không nào?',
  'Nếu thấy hơi mỏi mắt hoặc căng thẳng, bạn thử bấm nút "🎮 Caro 1-1" ở trên làm một ván cờ giải trí cùng Lumi xem sao nhé!',
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

    /** Lịch sử hội thoại ngắn gửi kèm cho Groq: [{ role: 'user'|'assistant', content }] */
    this.history = [];
    /** Bộ đếm lượt: chỉ gửi câu trả lời của tin nhắn mới nhất khi người dùng nhắn dồn dập */
    this.turnSeq = 0;
    /** Hủy request Groq đang chạy khi rời phòng */
    this.abortController = null;
    this.destroyed = false;
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
   * Gửi tin nhắn chào mừng đầu tiên khi mở phòng.
   * Khi bật Groq, bot tự sinh câu chào năng động; ngược lại dùng lời chào thân thiện có sẵn.
   */
  sendWelcome() {
    const list = WELCOME_MESSAGES_BY_MOOD[this.userMood] || WELCOME_MESSAGES_BY_MOOD.ngau_nhien;
    const fallbackText = list[Math.floor(Math.random() * list.length)];

    if (!groqChat.isEnabled()) {
      // Giả lập typing nhẹ 800ms
      this._simulateTypingAndSend(fallbackText, 800);
      this._pushHistory('assistant', fallbackText);
      return;
    }

    // Khi bật Groq: bật typing và sinh câu chào mở màn dí dỏm bằng Groq
    this._sendTyping(true);
    const seq = ++this.turnSeq;
    const startedAt = Date.now();

    (async () => {
      let welcomeText = null;
      try {
        const welcomePrompt = `Hãy gửi 1 câu chào mở màn ngắn gọn (tối đa 25 từ), tự nhiên, hài hước và thân thiện tới bạn chat (tâm trạng hiện tại: ${this.userMood}). Xưng "mình", gọi "bạn". Không thuyết giảng hay dùng văn mẫu trị liệu.`;
        const res = await groqChat.generateReply({
          userText: welcomePrompt,
          history: [],
          mood: this.userMood,
        });
        if (res && res.text) welcomeText = res.text;
      } catch (_) {}

      if (this.destroyed || seq !== this.turnSeq) return;

      const finalWelcome = welcomeText || fallbackText;
      const targetDuration = Math.min(1800, Math.max(600, finalWelcome.length * 15));
      const remaining = Math.max(0, targetDuration - (Date.now() - startedAt));

      setTimeout(() => {
        if (this.destroyed || seq !== this.turnSeq) return;
        this._sendTyping(false);
        this._sendMessage(finalWelcome);
        this._pushHistory('assistant', finalWelcome);
      }, remaining);
    })();
  }

  /**
   * Xử lý tin nhắn người dùng gửi đến Bot.
   * Ưu tiên Groq (nếu được cấu hình), lỗi thì dùng kịch bản offline.
   * @param {string} userText
   * @returns {Promise<void>}
   */
  async handleUserMessage(userText) {
    if (this.destroyed || typeof userText !== 'string' || !userText.trim()) return;

    if (!groqChat.isEnabled()) {
      this._replyOffline(userText);
      return;
    }

    const seq = ++this.turnSeq;
    const historySnapshot = this.history.slice();
    this._pushHistory('user', userText);

    // Hủy request cũ nếu người dùng nhắn tiếp khi Lumi chưa trả lời xong
    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    // Bật typing ngay trong lúc chờ Groq
    this._clearTimers();
    this._sendTyping(true);
    const startedAt = Date.now();

    let result = null;
    try {
      result = await groqChat.generateReply({
        userText,
        history: historySnapshot,
        mood: this.userMood,
        signal,
      });
    } catch (error) {
      console.warn('[CompanionBot] Lỗi khi sinh câu trả lời Groq:', error.message);
      result = null;
    }

    // Đã rời phòng hoặc đã có tin nhắn mới hơn → bỏ câu trả lời này
    if (this.destroyed || seq !== this.turnSeq) return;
    this.abortController = null;

    const reply = result ? result.text : this._pickOfflineReply(userText);
    this._pushHistory('assistant', reply);

    // Giữ cảm giác "đang gõ" tự nhiên: tổng thời gian tối thiểu theo độ dài câu
    const targetDuration = Math.min(2600, Math.max(700, reply.length * 18));
    const remaining = Math.max(0, targetDuration - (Date.now() - startedAt));
    this.replyTimeout = setTimeout(() => {
      if (this.destroyed) return;
      this._sendTyping(false);
      this._sendMessage(reply);
    }, remaining);
  }

  /**
   * Trả lời bằng kịch bản offline (không có Groq).
   * @param {string} userText
   */
  _replyOffline(userText) {
    this._clearTimers();
    const reply = this._pickOfflineReply(userText);
    this._pushHistory('user', userText);
    this._pushHistory('assistant', reply);

    // Tính thời gian gõ phím tự nhiên dựa theo độ dài tin nhắn (1.2s - 2.2s)
    const typingDuration = Math.min(2200, Math.max(1100, reply.length * 25));
    this._simulateTypingAndSend(reply, typingDuration);
  }

  /**
   * Chọn câu trả lời từ kịch bản từ khóa offline.
   * @param {string} userText
   * @returns {string}
   */
  _pickOfflineReply(userText) {
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

    return reply;
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
    this.destroyed = true;
    this._clearTimers();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.history = [];
  }

  // ─── Private Methods ─────────────────────────────────

  _clearTimers() {
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (this.replyTimeout) clearTimeout(this.replyTimeout);
    this.typingTimeout = null;
    this.replyTimeout = null;
  }

  _pushHistory(role, content) {
    if (typeof content !== 'string' || !content) return;
    this.history.push({ role, content: content.slice(0, MAX_MESSAGE_LENGTH) });
    const max = groqChat.MAX_HISTORY_TURNS + 2;
    if (this.history.length > max) {
      this.history.splice(0, this.history.length - max);
    }
  }

  _sendTyping(isTyping) {
    this.sendCallback(this.userClientId, serverMsg.typing(isTyping));
  }

  _sendMessage(text) {
    this.sendCallback(this.userClientId, serverMsg.message(text, new Date().toISOString()));
  }

  _simulateTypingAndSend(text, delayMs) {
    // 1. Gửi typing: true sau 300ms
    this.typingTimeout = setTimeout(() => {
      if (this.destroyed) return;
      this._sendTyping(true);
    }, 300);

    // 2. Gửi message & typing: false sau delayMs
    this.replyTimeout = setTimeout(() => {
      if (this.destroyed) return;
      this._sendTyping(false);
      this._sendMessage(text);
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
