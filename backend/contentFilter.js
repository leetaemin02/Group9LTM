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

// các cấp độ xử lý tương ứng 4 tầng
const MODERATION_ACTIONS = {
  MASK: 'MASK', // tầng 1 che dấu '*' và cho gửi đi
  BLOCK_WARN: 'BLOCK_WARN', // tầng 2: chặn tin + Nhắc nhở sửa từ (không ban, bạo lực kể chuyện)
  STRIKE_BAN: 'STRIKE_BAN', // tầng 3: chặn tin + cảnh báo 3 lần mới ban ( xúc phạm, gạ tình 18+ )
  INSTANT_BAN: 'INSTANT_BAN', //tầng 4: chặn tin + ban ngay lập tức 10 phút ( ma túy, cờ bạc, lừa đảo)
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
    pattern: /(giết\s*người|chém\s*chết|đâm\s*chết|giết\s*cả\s*nhà|cắt\s*cổ|bắn\s*chết|tự\s*tử|tự\s*sát|tự\s*hại|rạch\s*tay|nhảy\s*cầu|khủng\s*bố|đặt\s*bom|bom\s*xăng)/i,
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

//json không nhận diện đúng chữ dấu tiếng việt
const LETTER_OR_NUMBER = /[\p{L}\p{N}_]/u;
const ACTION_PRIORITY = {
  [MODERATION_ACTIONS.MASK]: 1,
  [MODERATION_ACTIONS.BLOCK_WARN]: 2,
  [MODERATION_ACTIONS.STRIKE_BAN]: 3,
  [MODERATION_ACTIONS.INSTANT_BAN]: 4,
};

function getActionByCategory(category) {
  switch (category) {
    case VIOLATION_CATEGORIES.PROFANITY: return MODERATION_ACTIONS.MASK;
    case VIOLATION_CATEGORIES.VIOLENCE_THREAT: return MODERATION_ACTIONS.BLOCK_WARN;
    case VIOLATION_CATEGORIES.INSULT_HATE:
    case VIOLATION_CATEGORIES.SEXUAL_HARASSMENT: return MODERATION_ACTIONS.STRIKE_BAN;
    case VIOLATION_CATEGORIES.DRUGS_NARCOTICS:
    case VIOLATION_CATEGORIES.GAMBLING_FRAUD: return MODERATION_ACTIONS.INSTANT_BAN;
    default: return MODERATION_ACTIONS.BLOCK_WARN;
  }
}

function isBoundary(text, start, end) {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  return (!before || !LETTER_OR_NUMBER.test(before)) &&
    (!after || !LETTER_OR_NUMBER.test(after));
}

// Giữ ánh xạ chỉ số để che đúng cả dấu chấm/khoảng trắng trong từ bị lách.
function compactWithOffsets(text) {
  let compact = '';
  const offsets = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      compact += ch.toLowerCase();
      offsets.push(i);
    } else if (/[\p{M}\u200B-\u200D\uFEFF]/u.test(ch)) {
      // Combining marks are preserved to avoid turning unrelated words into matches.
      if (/[\p{M}]/u.test(ch)) {
        compact += ch;
        offsets.push(i);
      }
    }
  }
  return { compact, offsets };
}

function scan(text) {
  const found = [];
  const add = (category, start, end, obfuscated) => {
    if (!isBoundary(text, start, end)) return;
    if (found.some(v => v.category === category && v.start === start && v.end === end)) return;
    found.push({
      category,
      start,
      end,
      matched: text.slice(start, end),
      action: getActionByCategory(category),
      obfuscated,
    });
  };

  for (const item of BANNED_PATTERNS) {
    const flags = item.pattern.flags.replace(/g/g, '') + 'gu';
    const regex = new RegExp(item.pattern.source, [...new Set(flags)].join(''));
    for (const match of text.matchAll(regex)) {
      add(item.category, match.index, match.index + match[0].length, false);
    }
  }

  const { compact, offsets } = compactWithOffsets(text);
  for (const item of STRICT_SUBSTRINGS) {
    const flags = item.pattern.flags.replace(/g/g, '') + 'g';
    const regex = new RegExp(item.pattern.source, flags);
    for (const match of compact.matchAll(regex)) {
      const start = offsets[match.index];
      const end = offsets[match.index + match[0].length - 1] + 1;
      if (start !== undefined && end !== undefined) {
        add(item.category, start, end, true);
      }
    }
  }

  return found.sort(
    (a, b) => ACTION_PRIORITY[b.action] - ACTION_PRIORITY[a.action] || a.start - b.start
  );
}

function checkContent(text) {
  const clean = {
    ok: true,
    isViolation: false,
    matched: null,
    reason: null,
    category: null,
    action: null,
    matches: [],
  };

  if (typeof text !== 'string' || text.length === 0) return clean;

  const matches = scan(text);
  if (!matches.length) return clean;

  const top = matches[0];

  return {
    ok: false,
    isViolation: true,
    matched: top.matched,
    reason: `${top.obfuscated ? 'Nghi vấn lách bộ lọc' : 'Vi phạm'}: ${top.category}`,
    category: top.category,
    action: top.action,
    matches,
  };
}

function maskProfanity(text) {
  if (typeof text !== 'string' || !text.length) return text;

  const spans = scan(text)
    .filter(match => match.category === VIOLATION_CATEGORIES.PROFANITY)
    .sort((a, b) => a.start - b.start);

  if (!spans.length) return text;

  const units = text.split('');

  for (const { start, end } of spans) {
    for (let i = start; i < end; i++) {
      if (!/\s/u.test(units[i])) units[i] = '*';
    }
  }

  return units.join('');
}

module.exports = {
  VIOLATION_CATEGORIES,
  MODERATION_ACTIONS,
  BANNED_PATTERNS,
  STRICT_SUBSTRINGS,
  checkContent,
  maskProfanity,
};

