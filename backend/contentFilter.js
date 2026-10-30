/**
 * contentFilter.js – Bộ lọc nội dung & kiểm duyệt vi phạm tiêu chuẩn an toàn
 *
 * CĂN CỨ PHÁP LÝ & TIÊU CHUẨN CỘNG ĐỒNG:
 *   1. Luật An ninh mạng Việt Nam (Luật số 24/2018/QH14):
 *      - Điều 8: Nghiêm cấm kích động bạo lực, xúc phạm tôn giáo, phân biệt chủng tộc/vùng miền, mua bán ma túy/chất kích thích, cờ bạc, mại dâm.
 *      - Điều 16, Điều 18: Nghiêm cấm thông tin làm nhục, vu khống, xúc phạm nghiêm trọng danh dự, nhân phẩm.
 *   2. Nghị định 15/2020/NĐ-CP (Điều 101) & Nghị định 14/2022/NĐ-CP: Xử phạt hành vi xúc phạm danh dự, truyền bá tệ nạn xã hội, cờ bạc, chất cấm trên Internet.
 *   3. Bộ luật Hình sự 2015 (sửa đổi 2017) – Điều 155, 156 (Làm nhục, vu khống), Điều 249, 251 (Ma túy), Điều 321 (Đánh bạc).
 *   4. Tiêu chuẩn cộng đồng quốc tế (OWASP & Meta/Discord Community Safety Standards): Hate speech, harassment, illegal drugs/weapons.
 */

'use strict';

// ─── 1. BẢNG PHÂN LOẠI DANH MỤC VI PHẠM (CATEGORIES) ──────────────────────
const VIOLATION_CATEGORIES = {
  PROFANITY: 'Ngôn từ thô tục, chửi thề khiếm nhã',
  INSULT_HATE: 'Xúc phạm danh dự, miệt thị vùng miền, kỳ thị nhân phẩm (Điều 8, Điều 16 Luật An ninh mạng)',
  DRUGS_NARCOTICS: 'Mua bán, tàng trữ, rủ rê sử dụng chất ma túy, chất kích thích cấm (Điều 249, 251 Bộ luật Hình sự)',
  GAMBLING_FRAUD: 'Cờ bạc, cá độ trực tuyến, lừa đảo tài chính (Điều 321 Bộ luật Hình sự)',
  VIOLENCE_THREAT: 'Đe dọa bạo lực, khủng bố, xúi giục tự tử / tự hại',
  SEXUAL_HARASSMENT: 'Quấy rối tình dục, gạ gẫm 18+, chat đen, mại dâm (Điều 8 Luật An ninh mạng)',
};

// ─── 2. DANH MỤC PATTERNS THEO CHUẨN TỪNG NHÓM ────────────────────────────
const BANNED_PATTERNS = [
  // ── Nhóm A: Xúc phạm danh dự, miệt thị vùng miền, kỳ thị nhân phẩm ──
  {
    category: VIOLATION_CATEGORIES.INSULT_HATE,
    pattern: /\b(b[ắa]c\s*k[ỳy]|nam\s*k[ỳy]|trung\s*k[ỳy]|b[ắa]c\s*k[yỳ]\s*ch[oó]|nam\s*k[yỳ]\s*ch[oó]|m[ọo]i\s*r[ợo]|m[ọo]i\s*mi[êê]n|th[ằă]ng\s*khuy[ếê]t\s*t[ậa]t|con\s*khuy[ếê]t\s*t[ậa]t|thi[ểe]u\s*n[ăa]ng|b[ịi]\s*down|b[ệe]nh\s*down|óc\s*ch[óo]|ngu\s*nh[uư]\s*ch[óo]|ngu\s*nh[uư]\s*b[òo]|s[úu]c\s*v[ậa]t|con\s*s[úu]c\s*sinh|r[áa]c\s*r[ưởu]i|c[ặa]n\s*b[ãa]|ch[óo]\s*ch[ếê]t|th[ằă]ng\s*h[èe]n|con\s*ph[oò]|con\s*đ[ỹy]|cave|gái\s*bán\s*hoa)\b/i,
  },

  // ── Nhóm B: Mua bán / sử dụng chất cấm, ma túy, chất kích thích ──
  {
    category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS,
    pattern: /\b(c[ầa]n\s*sa|c[ỏo]\s*m[ỹy]|h[úu]t\s*c[ầa]n|ship\s*c[ỏo]|mua\s*c[ỏo]|b[áa]n\s*c[ỏo]|ma\s*t[úu]y|heroin|thu[ốo]c\s*l[ắa]c|bay\s*l[ắa]c|đ[ậa]p\s*đ[áa]|ng[áa]o\s*đ[áa]|h[úu]t\s*đ[áa]|ke\s*k[ẹe]o|b[úu]ng\s*ke|ch[ơơ]i\s*ke|b[óo]ng\s*c[ườu]i|b[óo]ng\s*n2o|kh[íi]\s*c[ườu]i|pod\s*chill|tinh\s*d[ầa]u\s*chill|h[ồo]ng\s*phi[ếê]n|n[ướu]c\s*vui|n[ướu]c\s*bi[ểe]n\s*ghb|n[ấa]m\s*th[ầa]n)\b/i,
  },

  // ── Nhóm C: Cờ bạc, cá độ, lừa đảo, mại dâm ──
  {
    category: VIOLATION_CATEGORIES.GAMBLING_FRAUD,
    pattern: /\b(t[àa]i\s*x[ỉi]u|l[ôô]\s*đ[ềe]|c[áa]\s*đ[ộo]|c[áa]\s*c[ượu]c|đ[áa]nh\s*b[ạa]c|casino|sunwin|go88|ku\s*casino|thabet|kubet|n[ổo]\s*h[ũu]|b[ắa]n\s*c[áa]\s*đ[ổo]i\s*th[ưởu]ng|g[áa]i\s*g[ọo]i|b[áa]n\s*d[âa]m|mua\s*d[âa]m|đi\s*kh[áa]ch|massage\s*k[íi]ch\s*d[ụu]c|b[ốo]c\s*b[áa]t\s*h[ọo]|vay\s*n[óo]ng|t[íi]n\s*d[ụu]ng\s*đ[ee]n)\b/i,
  },

  // ── Nhóm D: Bạo lực, khủng bố, tự tử, đe dọa giết người ──
  {
    category: VIOLATION_CATEGORIES.VIOLENCE_THREAT,
    pattern: /\b(gi[ếê]t\s*ng[ườu]i|ch[éê]m\s*ch[ếê]t|đ[âa]m\s*ch[ếê]t|gi[ếê]t\s*c[ảa]\s*nh[àa]|c[ắa]t\s*c[ổo]|b[ắa]n\s*ch[ếê]t|t[ựu]\s*t[ửu]|t[ựu]\s*s[áa]t|t[ựu]\s*h[ạa]i|r[ạa]ch\s*tay|nh[ảa]y\s*c[ầa]u|kh[ủu]ng\s*b[ốo]|đ[ặa]t\s*bom|bom\s*x[ăa]ng)\b/i,
  },

  // ── Nhóm E: Quấy rối tình dục, chat đen 18+ ──
  {
    category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT,
    pattern: /\b(chat\s*sex|show\s*h[àa]ng|k[eè]o\s*h[àa]ng|call\s*sex|g[ạa]\s*t[ìi]nh|quan\s*h[ệe]\s*t[ìi]nh\s*d[ụu]c|l[ủu]ng\s*lo[ạa]n|l[oồ]ng\s*l[ộo]n|s[ụu]c\s*c[ặaă]c|s[ụu]c\s*b[ìi]nh\s*x[ăa]ng|th[ủu]\s*d[âa]m|ch[ịi]ch|xo[ạa]c|nện|quất\s*nhau|l[àa]m\s*t[ìi]nh|buscu|suck\s*dick|l[ộo]\s*v[úu]|v[úu]\s*to|m[ôô]ng\s*b[ựu]|s[ờo]\s*v[úu]|b[óo]p\s*v[úu]|l[ộo]\s*b[íi]m|show\s*b[íi]m)\b/i,
  },

  // ── Nhóm F: Chửi thề tiếng Việt & tiếng Anh tục tĩu ──
  {
    category: VIOLATION_CATEGORIES.PROFANITY,
    pattern: /\b(đ[iịkịt]*t|d[iịkịt]*t|d[cç]m|đ[cç]m|đ[m|k]|d[m|k]|đ[eẹ]ch|vcl|v[cç][l|z]|đ[eẹ]o|d[eẹ]o|đ[b|v]|clmm|clgt|đ[iị]t\s*m[ẹe]|d[iị]t\s*m[ẹe]|đ[uụ]\s*m[ẹe]|d[uụ]\s*m[ẹe]|dume|đume|đụ\s*má|dụ\s*má|c[ặaă]c|k[ặaă]c|cu|d[áa]i|b[uồi]+i|l[ồo]n|l[ôồ]n|b[ưướ]m|đ[ỹy]|ph[oò]|ch[óo]\s*đ[eẻ]|ch[óo]\s*m[áa]|m[ẹe]\s*m[àa]y|b[ốo]\s*m[àa]y|fuck|fucker|fucking|bitch|bastard|asshole|dick|pussy|cunt|slut|whore|nigger|nigga|cock|blowjob|anal\s*sex)\b/i,
  },
];

// ─── 3. TỪ KHÓA CẤM SUBSTRING (CHỐNG LÁCH LUẬT DẤU CHẤM, GẠCH, KHOẢNG TRẮNG) ──────
const STRICT_SUBSTRINGS = [
  // Tục tĩu & chat đen
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /đ[iịkịt]*t/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /c[ặaă]c/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /k[ặaă]c/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /b[uồi]+i/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /l[ồo]n/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /l[ôồ]n/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /đ[uụ]m[ẹe]/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /đ[uụ]m[áa]/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /dume/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /đume/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /chatsex/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /callsex/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /showh[àa]ng/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /showcam/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /l[ộo]v[úu]/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /th[ủu]d[âa]m/i },
  { category: VIOLATION_CATEGORIES.SEXUAL_HARASSMENT, pattern: /s[ụu]cc[ặaă]c/i },

  // Chất cấm lách luật (c.ầ.n s.a, k.e, k.ẹ.o, p.o.d c.h.i.l.l...)
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /c[ầa]nsa/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /c[ỏo]m[ỹy]/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /h[úu]tc[ầa]n/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /mat[úu]y/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /thu[ốo]cl[ắa]c/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /đ[ậa]pđ[áa]/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /b[óo]ngc[ườu]i/i },
  { category: VIOLATION_CATEGORIES.DRUGS_NARCOTICS, pattern: /podchill/i },

  // Miệt thị lách luật (b.ắ.c k.ỳ, m.ọ.i r.ợ...)
  { category: VIOLATION_CATEGORIES.INSULT_HATE, pattern: /b[ắa]ck[ỳy]/i },
  { category: VIOLATION_CATEGORIES.INSULT_HATE, pattern: /namk[ỳy]/i },
  { category: VIOLATION_CATEGORIES.INSULT_HATE, pattern: /m[ọo]ir[ợo]/i },
  { category: VIOLATION_CATEGORIES.INSULT_HATE, pattern: /[óo]cch[óo]/i },

  // Cờ bạc lách luật
  { category: VIOLATION_CATEGORIES.GAMBLING_FRAUD, pattern: /t[àa]ix[ỉi]u/i },
  { category: VIOLATION_CATEGORIES.GAMBLING_FRAUD, pattern: /c[áa]đ[ộo]/i },

  // Tiếng Anh
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /fuck/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /pussy/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /bitch/i },
  { category: VIOLATION_CATEGORIES.PROFANITY, pattern: /cunt/i },
];

/**
 * Kiểm tra nội dung tin nhắn có chứa từ ngữ vi phạm không.
 * @param {string} text
 * @returns {{ ok: boolean, isViolation: boolean, matched: string | null, reason: string | null, category: string | null }}
 */
function checkContent(text) {
  if (!text || typeof text !== 'string') {
    return { ok: true, isViolation: false, matched: null, reason: null, category: null };
  }

  // 1. Quét chuỗi nguyên bản
  for (const item of BANNED_PATTERNS) {
    const match = text.match(item.pattern);
    if (match) {
      return {
        ok: false,
        isViolation: true,
        matched: match[0],
        category: item.category,
        reason: `Vi phạm tiêu chuẩn an toàn: ${item.category}`,
      };
    }
  }

  // 2. Quét chuỗi chuẩn hóa (loại bỏ ký tự phân tách lách luật: ., -, _, *, @, $, khoảng trắng)
  const deObfuscated = text.toLowerCase().replace(/[\.\-_\*@\$\s]/g, '');
  for (const item of STRICT_SUBSTRINGS) {
    const match = deObfuscated.match(item.pattern);
    if (match) {
      return {
        ok: false,
        isViolation: true,
        matched: match[0],
        category: item.category,
        reason: `Cố tình lách bộ lọc: ${item.category}`,
      };
    }
  }

  return { ok: true, isViolation: false, matched: null, reason: null, category: null };
}

module.exports = {
  VIOLATION_CATEGORIES,
  BANNED_PATTERNS,
  STRICT_SUBSTRINGS,
  checkContent,
};

