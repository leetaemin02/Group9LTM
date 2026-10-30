'use strict';

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:\/[^\s<>"']*)?/giu;
const UNSAFE_SCHEME_PATTERN = /\b(?:javascript|data|file|ftp|vbscript):/iu;
const URL_SHORTENERS = new Set([
  'bit.ly',
  'cutt.ly',
  'is.gd',
  'linktr.ee',
  'rebrand.ly',
  'rb.gy',
  'shorturl.at',
  'tiny.cc',
  'tinyurl.com',
  't.co',
]);
const SENSITIVE_PATH_PATTERN = /(?:^|[/_.?&=-])(?:account|bank|billing|claim|crypto|login|password|payment|recover|reset|signin|verify|wallet)(?:$|[/_.?&=-])/iu;

function stripTrailingPunctuation(value) {
  let url = value;
  while (/[.,!?;:)\]}]$/u.test(url)) url = url.slice(0, -1);
  return url;
}

function extractUrls(text) {
  if (typeof text !== 'string') {
    throw new TypeError('URL extraction expects message text to be a string.');
  }

  return [...text.matchAll(URL_PATTERN)]
    .filter((match) => match.index === 0 || text[match.index - 1] !== '@')
    .map((match) => stripTrailingPunctuation(match[0]))
    .filter(Boolean)
    .map((link) => /^www\./iu.test(link) ? `https://${link}` : link)
    .filter((link) => {
      try {
        const url = new URL(link);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    });
}

function analyzeLinkSafety(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Link analysis expects message text to be a string.');
  }

  const links = extractUrls(text);
  const hasUnsafeScheme = UNSAFE_SCHEME_PATTERN.test(text);
  if (links.length === 0 && !hasUnsafeScheme) {
    return { hasLinks: false, suspicious: false, reasons: [] };
  }

  const reasons = new Set();
  if (hasUnsafeScheme) reasons.add('Có định dạng liên kết dùng giao thức không an toàn.');
  for (const link of links) {
    let url;
    try {
      url = new URL(link);
    } catch {
      reasons.add('Không thể phân tích cấu trúc của một liên kết.');
      continue;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reasons.add('Liên kết dùng giao thức không an toàn.');
      continue;
    }
    if (url.username || url.password) {
      reasons.add('Liên kết chứa thông tin đăng nhập trước tên miền.');
    }
    if (url.protocol === 'http:') {
      reasons.add('Liên kết không dùng HTTPS.');
    }

    const hostname = url.hostname.toLowerCase();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) || hostname.startsWith('[')) {
      reasons.add('Địa chỉ đích là IP thay vì tên miền thông thường.');
    }
    if (hostname.startsWith('xn--') || /[^\u0000-\u007f]/u.test(hostname)) {
      reasons.add('Tên miền có ký tự quốc tế hóa, có thể khó phân biệt với tên miền giả mạo.');
    }
    if (URL_SHORTENERS.has(hostname)) {
      reasons.add('Tên miền rút gọn che giấu địa chỉ đích cuối cùng.');
    }
    if (url.port && !['80', '443'].includes(url.port)) {
      reasons.add('Liên kết sử dụng cổng mạng không phổ biến.');
    }
    if (hostname.length >= 35 || (hostname.match(/-/gu) || []).length >= 3) {
      reasons.add('Tên miền dài bất thường hoặc có nhiều dấu gạch nối.');
    }
    if (SENSITIVE_PATH_PATTERN.test(`${url.pathname}${url.search}`)) {
      reasons.add('Đường dẫn nhắc đến đăng nhập, tài khoản, thanh toán hoặc xác minh.');
    }
  }

  return {
    hasLinks: true,
    suspicious: reasons.size > 0,
    reasons: [...reasons],
  };
}

module.exports = { analyzeLinkSafety, extractUrls };
