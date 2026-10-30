/**
 * icebreakers.js – Danh sách câu hỏi và chủ đề phá băng (Icebreaker Prompts)
 *
 * Giúp người lạ mở đầu câu chuyện tự nhiên, tránh cảm giác sượng sùng và ngập ngừng.
 */

'use strict';

const ICEBREAKER_QUESTIONS = [
  // ── Hài hước & Vui vẻ ──
  { category: 'Hài hước', text: 'Nếu cuộc đời bạn là một bộ phim, thể loại của nó sẽ là gì và tựa đề là gì?' },
  { category: 'Hài hước', text: 'Kỷ niệm "quê độ" nhớ đời nhất của bạn thời đi học là gì?' },
  { category: 'Hài hước', text: 'Nếu bị mắc kẹt trên hoang đảo với 1 người nổi tiếng, bạn sẽ chọn ai để sống sót?' },
  { category: 'Hài hước', text: 'Bạn thích ăn phở có hành hay không hành? (Chủ đề nhạy cảm đấy nhé!)' },
  { category: 'Hài hước', text: 'Kỹ năng vô dụng nhất mà bạn rất tự hào là gì?' },
  { category: 'Hài hước', text: 'Nếu biến thành một loài động vật trong 24 giờ, bạn muốn làm con gì?' },

  // ── Tình huống giả định ("Nếu như...") ──
  { category: 'Giả định', text: 'Nếu được tặng 10 tỷ ngay lúc này với điều kiện phải tiêu hết trong 24 giờ, bạn sẽ làm gì?' },
  { category: 'Giả định', text: 'Nếu có cỗ máy thời gian, bạn muốn quay về quá khứ sửa sai hay bay tới tương lai xem trước?' },
  { category: 'Giả định', text: 'Nếu được chọn 1 siêu năng lực (tàng hình, bay, đọc suy nghĩ, dịch chuyển), bạn chọn gì?' },
  { category: 'Giả định', text: 'Nếu có thể ăn tối và trò chuyện với bất kỳ ai trong lịch sử, bạn chọn ai?' },
  { category: 'Giả định', text: 'Nếu ngày mai là ngày tận thế, hôm nay bạn sẽ làm điều gì đầu tiên?' },

  // ── Tâm sự & Chiêm nghiệm ──
  { category: 'Tâm sự', text: 'Điều gì đang khiến bạn cảm thấy áp lực hoặc suy nghĩ nhiều nhất dạo gần đây?' },
  { category: 'Tâm sự', text: 'Khoảnh khắc nào trong năm nay khiến bạn cảm thấy hạnh phúc và bình yên nhất?' },
  { category: 'Tâm sự', text: 'Bạn là người hướng nội hay hướng ngoại? Khi mệt mỏi bạn nạp năng lượng bằng cách nào?' },
  { category: 'Tâm sự', text: 'Nếu được nói một câu với bản thân của 5 năm trước, bạn sẽ dặn dò điều gì?' },
  { category: 'Tâm sự', text: 'Theo bạn, điều quan trọng nhất để duy trì một mối quan hệ lâu dài là gì?' },

  // ── Sở thích & Đời sống ──
  { category: 'Sở thích', text: 'Bộ phim hoặc cuốn sách gần đây nhất khiến bạn phải suy ngẫm là gì?' },
  { category: 'Sở thích', text: 'Bài hát nào bạn có thể nghe đi nghe lại cả ngày mà không thấy chán?' },
  { category: 'Sở thích', text: 'Bạn thuộc "hệ" thích đi biển ngắm sóng hay lên núi hít thở sương lạnh?' },
  { category: 'Sở thích', text: 'Món ăn ruột cứu rỗi tâm hồn của bạn vào những ngày tồi tệ là gì?' },
  { category: 'Sở thích', text: 'Tựa game nào đã gắn liền với tuổi thơ hoặc thanh xuân của bạn nhiều nhất?' },
  { category: 'Sở thích', text: 'Cuối tuần lý tưởng nhất đối với bạn sẽ diễn ra như thế nào?' },
];

/**
 * Lấy ngẫu nhiên một câu hỏi phá băng.
 * @returns {{ category: string, text: string }}
 */
function getRandomIcebreaker() {
  const index = Math.floor(Math.random() * ICEBREAKER_QUESTIONS.length);
  const item = ICEBREAKER_QUESTIONS[index];
  return {
    category: item.category,
    text: item.text,
    question: item.text,
  };
}

module.exports = {
  ICEBREAKER_QUESTIONS,
  getRandomIcebreaker,
};
