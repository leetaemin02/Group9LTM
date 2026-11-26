/**
 * nicknameResolver.js – Xử lý biệt danh trùng lặp & trích xuất tag @mention
 *
 * Quy tắc:
 *   1. Người chơi trong nhóm chat hoặc phòng game hoàn toàn ẩn danh, chỉ hiển thị biệt danh.
 *   2. Nếu có người trùng biệt danh (không phân biệt hoa/thường & khoảng trắng thừa):
 *      - Người đầu tiên đang dùng "Cánh Cụt" được cập nhật thành "Cánh Cụt 1".
 *      - Người tiếp theo nhận "Cánh Cụt 2", "Cánh Cụt 3", ...
 *      - Khi một người rời đi, những người còn lại giữ nguyên số thứ tự để không gây nhầm lẫn khi tag @.
 *   3. Hỗ trợ trích xuất @tag chính xác cả với biệt danh nhiều từ có dấu cách & số (vd: "@Cánh Cụt 2").
 */

'use strict';

const { stripDangerousUnicode } = require('./security');

function normalizeBaseNickname(raw) {
  if (typeof raw !== 'string') return 'Ẩn Danh';
  const cleaned = stripDangerousUnicode(raw, { allowNewlines: false });
  const collapsed = cleaned.trim().replace(/\s+/g, ' ');
  return collapsed || 'Ẩn Danh';
}

function normalizeKey(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/\s+/g, ' ').toLowerCase();
}

function stripVietnameseTones(str) {
  if (typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Cấp phát biệt danh hiển thị duy nhất trong phòng (nhóm chat hoặc phòng game).
 *
 * @param {Iterable<object>} existingMembers - Danh sách thành viên hiện tại trong phòng
 *   Mỗi phần tử có thể có { clientId, nickname, baseNickname, nicknameNumber }
 * @param {string} requestedNickname - Biệt danh người mới nhập
 * @param {Map<string, number>|object} [nicknameCounters] - Bộ đếm số thứ tự đã cấp theo baseKey (tránh tái cấp nhầm số người vừa rời)
 * @returns {{
 *   baseNickname: string,
 *   displayName: string,
 *   nicknameNumber: number | null,
 *   renamedMembers: Array<{ clientId: string, oldNickname: string, newNickname: string, nicknameNumber: number }>
 * }}
 */
function resolveRoomNickname(existingMembers, requestedNickname, nicknameCounters = null) {
  const members = Array.from(existingMembers || []);
  const baseNickname = normalizeBaseNickname(requestedNickname);
  const baseKey = normalizeKey(baseNickname);

  const usedDisplayKeys = new Set();
  const sameBaseMembers = [];

  for (const m of members) {
    const mDisplay = normalizeBaseNickname(m.nickname || m.displayName || '');
    const mBase = normalizeBaseNickname(m.baseNickname || mDisplay);
    usedDisplayKeys.add(normalizeKey(mDisplay));
    if (normalizeKey(mBase) === baseKey) {
      sameBaseMembers.push(m);
    }
  }

  const getCounter = (key) => {
    if (!nicknameCounters) return 0;
    if (nicknameCounters instanceof Map) return nicknameCounters.get(key) || 0;
    return Number(nicknameCounters[key]) || 0;
  };

  const setCounter = (key, val) => {
    if (!nicknameCounters) return;
    if (nicknameCounters instanceof Map) {
      nicknameCounters.set(key, val);
    } else {
      nicknameCounters[key] = val;
    }
  };

  const renamedMembers = [];

  // Trường hợp 1: Chưa có ai dùng cùng baseNickname và tên hiển thị cũng chưa bị trùng
  if (sameBaseMembers.length === 0 && !usedDisplayKeys.has(baseKey)) {
    return {
      baseNickname,
      displayName: baseNickname,
      nicknameNumber: null,
      renamedMembers,
    };
  }

  // Trường hợp 2: Có người trùng biệt danh -> đánh số thứ tự (1, 2, 3...)
  let maxNumber = getCounter(baseKey);

  // Tìm số lớn nhất đang dùng trong nhóm cùng baseNickname
  for (const m of sameBaseMembers) {
    if (typeof m.nicknameNumber === 'number' && m.nicknameNumber > maxNumber) {
      maxNumber = m.nicknameNumber;
    }
  }

  // Nếu có thành viên cũ cùng baseNickname nhưng CHƯA có số (ví dụ đang là "Cánh Cụt") -> đổi thành "Cánh Cụt 1"
  for (const m of sameBaseMembers) {
    if (m.nicknameNumber == null) {
      let assignedNum = 1;
      while (usedDisplayKeys.has(normalizeKey(`${m.baseNickname || baseNickname} ${assignedNum}`))) {
        assignedNum += 1;
      }
      const oldNickname = m.nickname;
      const canonicalBase = normalizeBaseNickname(m.baseNickname || m.nickname || baseNickname);
      const newNickname = `${canonicalBase} ${assignedNum}`;

      usedDisplayKeys.delete(normalizeKey(oldNickname));
      usedDisplayKeys.add(normalizeKey(newNickname));

      m.baseNickname = canonicalBase;
      m.nickname = newNickname;
      m.nicknameNumber = assignedNum;

      if (assignedNum > maxNumber) maxNumber = assignedNum;
      renamedMembers.push({
        clientId: m.clientId,
        oldNickname,
        newNickname,
        nicknameNumber: assignedNum,
      });
    }
  }

  // Cấp số tiếp theo cho người mới (đồng nhất cách viết hoa/thường theo nhóm trùng biệt danh)
  const displayBase = sameBaseMembers.length > 0
    ? normalizeBaseNickname(sameBaseMembers[0].baseNickname || baseNickname)
    : baseNickname;
  let nextNum = Math.max(maxNumber + 1, sameBaseMembers.length > 0 ? 2 : 1);
  let candidate = `${displayBase} ${nextNum}`;
  while (usedDisplayKeys.has(normalizeKey(candidate))) {
    nextNum += 1;
    candidate = `${displayBase} ${nextNum}`;
  }

  setCounter(baseKey, nextNum);

  return {
    baseNickname: displayBase,
    displayName: candidate,
    nicknameNumber: nextNum,
    renamedMembers,
  };
}

/**
 * Trích xuất danh sách thành viên được tag bằng cú pháp @BiệtDanh trong tin nhắn.
 * Ưu tiên khớp tên dài nhất trước (để "@Cánh Cụt 1" không bị khớp nhầm thành "@Cánh Cụt").
 *
 * @param {string} text
 * @param {Iterable<{ clientId: string, nickname: string }>} members
 * @returns {Array<{ clientId: string, nickname: string }>}
 */
function extractMentions(text, members) {
  if (typeof text !== 'string' || !text.includes('@')) return [];

  const memberList = Array.from(members || [])
    .filter((m) => m && m.clientId && typeof m.nickname === 'string' && m.nickname.trim().length > 0)
    .sort((a, b) => b.nickname.length - a.nickname.length);

  if (memberList.length === 0) return [];

  const lowerText = text.toLowerCase();
  const matched = [];
  const seenIds = new Set();

  // Quét từng vị trí xuất hiện ký tự '@' đứng đầu chuỗi hoặc sau khoảng trắng/dấu ngoặc
  let searchPos = 0;
  while (searchPos < lowerText.length) {
    const atIndex = lowerText.indexOf('@', searchPos);
    if (atIndex === -1) break;

    const prevChar = atIndex > 0 ? lowerText[atIndex - 1] : '';
    const validPrefix = atIndex === 0 || /[\s([{"'.,!?;:/-]/.test(prevChar);

    if (validPrefix) {
      const afterAt = lowerText.slice(atIndex + 1);
      let foundMember = null;

      for (const member of memberList) {
        const lowerName = member.nickname.toLowerCase();
        if (!afterAt.startsWith(lowerName)) continue;

        const nextChar = afterAt[lowerName.length];
        // Phải kết thúc chuỗi hoặc theo sau bởi khoảng trắng / dấu câu (không cắt giữa chữ hoặc số khác)
        const validBoundary = nextChar === undefined || /[\s.,!?;:)\]}"'/@-]/.test(nextChar);
        if (validBoundary) {
          foundMember = member;
          break;
        }
      }

      if (foundMember) {
        if (!seenIds.has(foundMember.clientId)) {
          seenIds.add(foundMember.clientId);
          matched.push({
            clientId: foundMember.clientId,
            nickname: foundMember.nickname,
          });
        }
        searchPos = atIndex + 1 + foundMember.nickname.length;
        continue;
      }
    }

    searchPos = atIndex + 1;
  }

  return matched;
}

module.exports = {
  normalizeBaseNickname,
  normalizeKey,
  stripVietnameseTones,
  resolveRoomNickname,
  extractMentions,
};
