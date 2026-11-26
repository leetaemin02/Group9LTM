/**
 * gameData.js – Ngân hàng nội dung cho các trò chơi nhiều người (2–10 người)
 *
 * Bao gồm:
 *   1. QUIZ_QUESTIONS: 45 câu hỏi Đố Vui Tốc Độ (kiến thức, đố mẹo, khoa học, văn hóa, công nghệ)
 *   2. UNDERCOVER_PAIRS: 40 cặp từ gần nghĩa cho game Ai Là Gián Điệp?
 *   3. WORD_CHAIN_SEEDS: 50 từ mở màn 2 âm tiết giàu khả năng nối tiếp cho game Nối Từ Thần Tốc
 */

'use strict';

const QUIZ_QUESTIONS = Object.freeze([
  { q: 'Hành tinh nào trong Hệ Mặt Trời được mệnh danh là "Hành tinh Đỏ"?', options: ['Sao Kim', 'Sao Hỏa', 'Sao Mộc', 'Sao Thủy'], answer: 1, category: 'Khoa học' },
  { q: 'Loài động vật nào có thể ngủ đứng và không thể nhảy?', options: ['Ngựa', 'Voi', 'Hươu cao cổ', 'Tê giác'], answer: 1, category: 'Thiên nhiên' },
  { q: 'Đỉnh núi cao nhất Việt Nam là đỉnh nào?', options: ['Bạch Mã', 'Fansipan', 'Pu Ta Leng', 'Langbiang'], answer: 1, category: 'Địa lý' },
  { q: 'Con gì đập thì sống, không đập thì chết?', options: ['Con lắc', 'Con tim', 'Con sóng', 'Con quay'], answer: 1, category: 'Đố mẹo' },
  { q: 'Trong giao thức mạng, chữ "HTTP" viết tắt của cụm từ nào?', options: ['HyperText Transfer Protocol', 'High Tech Transmission Port', 'Hyper Terminal Text Process', 'Host Transfer Text Protocol'], answer: 0, category: 'Công nghệ' },
  { q: 'Cầu Rồng phun lửa và nước nằm ở thành phố nào?', options: ['Huế', 'Nha Trang', 'Đà Nẵng', 'Hải Phòng'], answer: 2, category: 'Địa lý' },
  { q: 'Tháng nào trong năm có 28 ngày?', options: ['Chỉ tháng 2', 'Tháng 2 năm không nhuận', 'Tất cả 12 tháng', 'Tháng 4 và tháng 6'], answer: 2, category: 'Đố mẹo' },
  { q: 'Nguyên tố hóa học có ký hiệu "Au" là gì?', options: ['Bạc', 'Vàng', 'Nhôm', 'Đồng'], answer: 1, category: 'Khoa học' },
  { q: 'Loài chim nào chạy nhanh nhất thế giới nhưng không biết bay?', options: ['Chim cánh cụt', 'Đà điểu', 'Chim kiwi', 'Công'], answer: 1, category: 'Thiên nhiên' },
  { q: 'Ngôn ngữ lập trình nào được tạo ra chỉ trong khoảng 10 ngày bởi Brendan Eich?', options: ['Python', 'Java', 'JavaScript', 'Ruby'], answer: 2, category: 'Công nghệ' },
  { q: 'Cái gì càng rửa càng bẩn?', options: ['Quần áo', 'Nước', 'Bàn tay', 'Cái chổi'], answer: 1, category: 'Đố mẹo' },
  { q: 'Món Phở truyền thống bắt nguồn từ vùng nào của Việt Nam?', options: ['Miền Bắc', 'Miền Trung', 'Miền Tây', 'Tây Nguyên'], answer: 0, category: 'Ẩm thực' },
  { q: 'Một bàn cờ vua tiêu chuẩn có tổng cộng bao nhiêu ô vuông nhỏ?', options: ['49 ô', '64 ô', '81 ô', '100 ô'], answer: 1, category: 'Trò chơi' },
  { q: 'Âm thanh truyền nhanh nhất trong môi trường nào?', options: ['Chân không', 'Không khí', 'Nước', 'Chất rắn (như thép)'], answer: 3, category: 'Khoa học' },
  { q: 'Quốc gia nào có hình dạng trên bản đồ giống chiếc ủng?', options: ['Tây Ban Nha', 'Ý (Italy)', 'Hy Lạp', 'Bồ Đào Nha'], answer: 1, category: 'Địa lý' },
  { q: 'Cái gì có cổ nhưng không có đầu?', options: ['Cái chai / Chiếc áo', 'Cây đàn', 'Con hươu', 'Chiếc ghế'], answer: 0, category: 'Đố mẹo' },
  { q: 'Trong 1 ngày (24 giờ), kim giờ và kim phút của đồng hồ trùng nhau bao nhiêu lần?', options: ['12 lần', '22 lần', '24 lần', '23 lần'], answer: 1, category: 'Toán vui' },
  { q: 'Bạch tuộc có bao nhiêu trái tim?', options: ['1 trái tim', '2 trái tim', '3 trái tim', '4 trái tim'], answer: 2, category: 'Thiên nhiên' },
  { q: 'Bức tranh nổi tiếng "Mona Lisa" do danh họa nào vẽ?', options: ['Vincent van Gogh', 'Pablo Picasso', 'Leonardo da Vinci', 'Michelangelo'], answer: 2, category: 'Nghệ thuật' },
  { q: 'Cổng mặc định (default port) của giao thức HTTPS là số mấy?', options: ['80', '443', '8080', '22'], answer: 1, category: 'Công nghệ' },
  { q: 'Cái gì của bạn nhưng người khác lại dùng nhiều hơn bạn?', options: ['Điện thoại', 'Tên của bạn', 'Tiền bạc', 'Xe máy'], answer: 1, category: 'Đố mẹo' },
  { q: 'Đại dương nào lớn nhất và sâu nhất trên Trái Đất?', options: ['Đại Tây Dương', 'Ấn Độ Dương', 'Thái Bình Dương', 'Bắc Băng Dương'], answer: 2, category: 'Địa lý' },
  { q: 'Đội bóng nào vô địch World Cup 2022 tại Qatar?', options: ['Pháp', 'Brazil', 'Argentina', 'Croatia'], answer: 2, category: 'Thể thao' },
  { q: 'Loại vitamin nào cơ thể tự tổng hợp tốt nhất khi tiếp xúc ánh nắng sớm?', options: ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Vitamin K'], answer: 2, category: 'Khoa học' },
  { q: 'Bánh chưng truyền thống ngày Tết tượng trưng cho điều gì?', options: ['Trời', 'Đất', 'Mặt Trời', 'Biển cả'], answer: 1, category: 'Văn hóa' },
  { q: 'Nếu bạn vượt qua người đang chạy ở vị trí thứ 2 trong cuộc đua, bạn đang ở vị trí thứ mấy?', options: ['Thứ nhất', 'Thứ hai', 'Thứ ba', 'Đồng hạng nhất'], answer: 1, category: 'Đố mẹo' },
  { q: 'Mật ong tự nhiên nguyên chất để trong lọ kín có thể bảo quản được bao lâu?', options: ['6 tháng', '2 năm', '10 năm', 'Gần như vô thời hạn'], answer: 3, category: 'Khoa học' },
  { q: 'Đơn vị đo tần số của âm thanh hoặc sóng điện từ là gì?', options: ['Watt (W)', 'Hertz (Hz)', 'Volt (V)', 'Joule (J)'], answer: 1, category: 'Khoa học' },
  { q: 'Vịnh Hạ Long nằm ở tỉnh nào của Việt Nam?', options: ['Hải Phòng', 'Quảng Ninh', 'Ninh Bình', 'Thanh Hóa'], answer: 1, category: 'Địa lý' },
  { q: 'Trong bộ bài Tây 52 lá, lá Già (K) chất nào là vị vua duy nhất không có ria mép?', options: ['K Cơ ♥', 'K Rô ♦', 'K Chuồn ♣', 'K Bích ♠'], answer: 0, category: 'Thú vị' },
  { q: 'Loài động vật nào trên cạn có tốc độ chạy nhanh nhất?', options: ['Sư tử', 'Báo săn (Cheetah)', 'Linh dương', 'Ngựa đua'], answer: 1, category: 'Thiên nhiên' },
  { q: 'Phím tắt nào thường dùng để "Hoàn tác" (Undo) trên Windows?', options: ['Ctrl + Y', 'Ctrl + Z', 'Ctrl + U', 'Ctrl + X'], answer: 1, category: 'Công nghệ' },
  { q: 'Ở đâu trên thế giới mà thứ Sáu đến trước thứ Năm?', options: ['Ở cực Bắc', 'Trong từ điển tiếng Anh', 'Trên tàu vũ trụ', 'Không có nơi nào'], answer: 1, category: 'Đố mẹo' },
  { q: 'Nhạc cụ nào có 88 phím tiêu chuẩn?', options: ['Đàn organ mini', 'Đàn piano', 'Đàn accordion', 'Đàn tranh'], answer: 1, category: 'Âm nhạc' },
  { q: 'Thủ đô của đất nước Úc (Australia) là thành phố nào?', options: ['Sydney', 'Melbourne', 'Canberra', 'Brisbane'], answer: 2, category: 'Địa lý' },
  { q: 'Trong WebSocket, mã trạng thái HTTP khi nâng cấp kết nối thành công là gì?', options: ['200 OK', '101 Switching Protocols', '204 No Content', '302 Found'], answer: 1, category: 'Công nghệ' },
  { q: 'Cái gì đi nằm, đứng nằm, ngủ cũng nằm nhưng nằm thì lại đứng?', options: ['Con rắn', 'Bàn chân', 'Cái bóng', 'Cây cầu'], answer: 1, category: 'Đố mẹo' },
  { q: 'Loài quả nào thực chất thuộc họ quả mọng (berry) trong thực vật học?', options: ['Dâu tây', 'Chuối', 'Táo', 'Đào'], answer: 1, category: 'Khoa học' },
  { q: 'Màu sắc nào được tạo ra khi trộn ánh sáng Đỏ và Xanh lá (hệ màu RGB)?', options: ['Tím', 'Vàng', 'Cam', 'Xanh dương'], answer: 1, category: 'Nghệ thuật' },
  { q: 'Hồ nước ngọt tự nhiên lớn nhất Việt Nam là hồ nào?', options: ['Hồ Tây', 'Hồ Hoàn Kiếm', 'Hồ Ba Bể', 'Hồ Xuân Hương'], answer: 2, category: 'Địa lý' },
  { q: 'Có 3 quả táo trên bàn, bạn lấy đi 2 quả. Hỏi bạn có bao nhiêu quả táo?', options: ['1 quả', '2 quả', '3 quả', '0 quả'], answer: 1, category: 'Đố mẹo' },
  { q: 'Tác giả của truyện dài nổi tiếng "Mắt Biếc" là ai?', options: ['Nam Cao', 'Nguyễn Nhật Ánh', 'Tô Hoài', 'Nguyễn Ngọc Tư'], answer: 1, category: 'Văn học' },
  { q: 'Con vật nào có dấu vân tay gần giống con người đến mức dễ gây nhầm lẫn?', options: ['Gấu túi (Koala)', 'Cá heo', 'Mèo rừng', 'Sóc bay'], answer: 0, category: 'Thiên nhiên' },
  { q: 'Số nguyên tố chẵn duy nhất trong toán học là số nào?', options: ['0', '2', '4', 'Không có số nào'], answer: 1, category: 'Toán vui' },
  { q: 'Cái gì càng kéo càng ngắn?', options: ['Sợi dây thun', 'Điếu thuốc / Cây nến', 'Cái thước dây', 'Chiếc khăn'], answer: 1, category: 'Đố mẹo' },
]);

const UNDERCOVER_PAIRS = Object.freeze([
  ['Phở bò', 'Bún bò Huế'],
  ['Trà sữa', 'Cà phê sữa'],
  ['Mèo', 'Chó'],
  ['TikTok', 'YouTube'],
  ['Bãi biển', 'Hồ bơi'],
  ['Bánh mì', 'Xôi mặn'],
  ['Xe máy', 'Xe đạp'],
  ['Kính râm', 'Kính cận'],
  ['Mùa đông', 'Mùa thu'],
  ['Kem', 'Sữa chua'],
  ['Cầu lông', 'Bóng bàn'],
  ['Bóng đá', 'Bóng rổ'],
  ['Áo khoác', 'Áo mưa'],
  ['Cà phê đen', 'Trà đá'],
  ['Rạp chiếu phim', 'Sân khấu kịch'],
  ['Bút bi', 'Bút chì'],
  ['Gối ôm', 'Chăn bông'],
  ['Đồng hồ đeo tay', 'Vòng tay'],
  ['Sân bay', 'Nhà ga'],
  ['Cơm tấm', 'Cơm chiên'],
  ['Quạt máy', 'Điều hòa'],
  ['Laptop', 'Máy tính bảng'],
  ['Tai nghe', 'Loa Bluetooth'],
  ['Bánh chưng', 'Bánh tét'],
  ['Đà Lạt', 'Sa Pa'],
  ['Mì gói', 'Phở ăn liền'],
  ['Hoa hồng', 'Hoa hướng dương'],
  ['Mặt Trời', 'Mặt Trăng'],
  ['Sư tử', 'Con hổ'],
  ['Chim cánh cụt', 'Gấu Bắc Cực'],
  ['Pizza', 'Hamburger'],
  ['Nước cam', 'Nước chanh'],
  ['Siêu thị', 'Chợ truyền thống'],
  ['Giày thể thao', 'Dép lê'],
  ['Đàn guitar', 'Đàn ukulele'],
  ['Thư viện', 'Hiệu sách'],
  ['Cờ vua', 'Cờ tướng'],
  ['Mưa rào', 'Mưa phùn'],
  ['Bánh trung thu', 'Bánh pía'],
  ['Trà đào', 'Trà vải'],
]);

const WORD_CHAIN_SEEDS = Object.freeze([
  'cà phê', 'mặt trời', 'bầu trời', 'cánh cụt', 'âm nhạc',
  'đồng hồ', 'hoa hồng', 'trà sữa', 'bánh mì', 'biển xanh',
  'ngôi sao', 'mây trắng', 'gió mát', 'cầu vồng', 'ánh sáng',
  'bạn bè', 'niềm vui', 'hạnh phúc', 'tình bạn', 'ước mơ',
  'du lịch', 'thể thao', 'lập trình', 'công nghệ', 'điện thoại',
  'máy tính', 'sách vở', 'trường học', 'sinh viên', 'thành phố',
  'phố cổ', 'mùa xuân', 'mùa hè', 'mùa thu', 'mùa đông',
  'cơn mưa', 'nắng vàng', 'đêm khuya', 'bình minh', 'hoàng hôn',
  'nhà hàng', 'cửa hàng', 'siêu thị', 'công viên', 'rạp phim',
  'bóng đá', 'cầu lông', 'xe đạp', 'máy bay', 'tàu hỏa',
]);

/**
 * Kho cụm từ 2 tiếng phổ biến dùng cho Lumi AI khi chơi "Nối Từ Thần Tốc" 1-1.
 */
const WORD_CHAIN_BOT_PHRASES = Object.freeze([
  ...WORD_CHAIN_SEEDS,
  // Bắt đầu theo các âm tiết đuôi phổ biến
  'phê bình', 'phê duyệt', 'bình yên', 'bình thường', 'yên tĩnh', 'yên vui',
  'trời xanh', 'trời đất', 'đất nước', 'nước mắt', 'nước ngọt', 'mắt biếc',
  'cụt hứng', 'cụt ngủn', 'hứng thú', 'thú vị', 'vị ngọt', 'ngọt ngào',
  'nhạc sĩ', 'nhạc trẻ', 'nhạc pop', 'sĩ quan', 'trẻ em', 'trẻ trung',
  'hồ bơi', 'hồ nước', 'bơi lội', 'hồng hào', 'hồng nhung', 'hào hứng',
  'sữa chua', 'sữa tươi', 'chua cay', 'tươi cười', 'tươi đẹp', 'cười đùa',
  'mì tôm', 'mì gói', 'tôm hùm', 'gói quà', 'quà tặng', 'tặng hoa',
  'xanh biếc', 'xanh lá', 'lá cây', 'cây xanh', 'cây cối', 'biếc xanh',
  'sao băng', 'sao mai', 'băng giá', 'giá lạnh', 'lạnh lẽo', 'mai vàng',
  'trắng tinh', 'trắng xóa', 'tinh khôi', 'tinh thần', 'thần tốc', 'tốc độ',
  'mát mẻ', 'mát lạnh', 'mẻ lưới', 'vồng cầu', 'sáng tạo', 'sáng sớm',
  'tạo hình', 'hình ảnh', 'ảnh hưởng', 'sớm mai', 'bè bạn', 'bạn thân',
  'thân thiện', 'thiện cảm', 'cảm xúc', 'xúc động', 'động vật', 'vật lý',
  'vui vẻ', 'vui nhộn', 'vẻ đẹp', 'đẹp trai', 'đẹp đẽ', 'nhộn nhịp',
  'phúc hậu', 'phúc lợi', 'lợi ích', 'ích kỷ', 'bạn học', 'học sinh',
  'sinh nhật', 'nhật ký', 'ký ức', 'ức chế', 'mơ mộng', 'mơ ước',
  'mộng đẹp', 'lịch sự', 'lịch trình', 'sự thật', 'thật lòng', 'lòng tin',
  'thao trường', 'trường lớp', 'lớp học', 'trình bày', 'trình độ', 'bày tỏ',
  'nghệ sĩ', 'nghệ thuật', 'thuật toán', 'toán học', 'thoại kịch', 'kịch tính',
  'tính cách', 'tính toán', 'cách mạng', 'mạng lưới', 'vở kịch', 'vở bài',
  'học tập', 'học bổng', 'tập thể', 'thể dục', 'viên mãn', 'viên bi',
  'phố xá', 'phố đêm', 'cổ tích', 'cổ điển', 'tích cực', 'cực kỳ',
  'xuân sắc', 'sắc đẹp', 'hè phố', 'thu hoạch', 'thu nhập', 'đông đúc',
  'đông vui', 'mưa rào', 'mưa phùn', 'rào chắn', 'vàng óng', 'vàng bạc',
  'bạc hà', 'khuya khoắt', 'minh bạch', 'minh họa', 'hôn nhân', 'nhân ái',
  'hàng quán', 'hàng xóm', 'quán ăn', 'xóm làng', 'làng quê', 'quê hương',
  'thị trấn', 'thị trường', 'viên gạch', 'phim ảnh', 'phim hài', 'hài hước',
  'đá quý', 'đá bóng', 'quý giá', 'lông vũ', 'lông mày', 'đạp xe',
  'xe máy', 'xe hơi', 'bay lượn', 'bay bổng', 'hỏa tốc', 'hỏa hoạn',
  // Thêm nhóm phổ biến hàng ngày
  'ăn uống', 'uống nước', 'trà đào', 'đào hoa', 'hoa mai', 'hoa cúc',
  'con mèo', 'mèo mun', 'con chó', 'chó con', 'con cá', 'cá vàng',
  'con người', 'người yêu', 'yêu thương', 'thương nhớ', 'nhớ nhung', 'quên lãng',
  'đêm tối', 'tối giản', 'ngày mới', 'mới mẻ', 'cũ kỹ', 'cao lớn',
  'lớn mạnh', 'mạnh mẽ', 'nhỏ bé', 'bé xíu', 'nhanh nhẹn', 'chậm rãi',
  'tốt bụng', 'bụng dạ', 'chơi game', 'chơi cờ', 'cờ vua', 'vua chúa',
  'thắng lợi', 'thua cuộc', 'cuộc sống', 'sống động', 'tâm sự', 'sự kiện',
  'kiện toàn', 'thế giới', 'giới trẻ', 'thời gian', 'gian nan', 'nan giải',
  'giải trí', 'trí tuệ', 'tuệ giác', 'cảm ơn', 'ơn nghĩa', 'nghĩa tình',
  'tình yêu', 'yêu đời', 'đời thường', 'thường ngày', 'mặt trăng', 'trăng tròn',
  'tròn trĩnh', 'mây mù', 'núi rừng', 'rừng xanh', 'sông nước', 'cầu tre',
  'đường phố', 'chợ đêm', 'phòng khách', 'khách sạn', 'cửa sổ', 'sổ tay',
  'tay nghề', 'bàn ghế', 'ghế đá', 'đèn ngủ', 'ngủ ngon', 'ngon miệng',
  'miệng cười', 'điện tử', 'tử tế', 'màu sắc', 'đỏ rực', 'tím biếc',
  'đen nhánh', 'ấm áp', 'áp lực', 'lực lượng', 'hòa bình', 'khám phá',
  'phá cách', 'vũ trụ', 'trụ cột', 'tự do', 'do dự', 'dự báo',
  'báo chí', 'chí hướng', 'hướng dương', 'dương cầm', 'cầm tay', 'tay trái',
]);

/**
 * Tìm một từ 2 tiếng hợp lệ cho Lumi AI nối tiếp `requiredStart` mà chưa bị trùng.
 * @param {string} requiredStart
 * @param {Set<string>} usedWordsSet - tập các từ đã dùng (đã stripVietnameseTones)
 * @param {function(string): string} stripFn
 * @returns {string|null}
 */
function findWordChainReply(requiredStart, usedWordsSet, stripFn) {
  if (!requiredStart || typeof stripFn !== 'function') return null;
  const targetStart = stripFn(requiredStart);
  const candidates = [];

  for (const phrase of WORD_CHAIN_BOT_PHRASES) {
    const parts = phrase.split(' ');
    if (parts.length !== 2) continue;
    if (stripFn(parts[0]) !== targetStart) continue;
    const lowerPhrase = phrase.toLowerCase();
    const normPhrase = stripFn(phrase);
    if (usedWordsSet && (usedWordsSet.has(lowerPhrase) || usedWordsSet.has(normPhrase))) continue;
    candidates.push(phrase);
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = {
  QUIZ_QUESTIONS,
  UNDERCOVER_PAIRS,
  WORD_CHAIN_SEEDS,
  WORD_CHAIN_BOT_PHRASES,
  findWordChainReply,
};

