/**
 * script.js – Client-side logic & UI Controller
 *
 * Module này:
 *   1. Quản lý kết nối WebSocket (tự động kết nối lại – exponential backoff).
 *   2. Xử lý giao diện người dùng (3 màn hình: Login/Lobby, Waiting, Chat).
 *   3. Gửi/nhận message theo giao thức JSON { type, payload }.
 *   4. Quản lý âm thanh hiệu ứng (Web Audio API).
 *   5. Tạo biệt danh ngẫu nhiên, chọn avatar, gợi ý phá băng, minigame Caro 10x10/15x15/20x20.
 *   6. Escape HTML để chống XSS ở phía client.
 */

'use strict';

// ═══════════════════════════════════════════════════
// Hằng số & Cấu hình
// ═══════════════════════════════════════════════════

/** Thời gian chờ tối thiểu trước khi kết nối lại (ms) */
const RECONNECT_BASE = 1000;

/** Thời gian chờ tối đa trước khi kết nối lại (ms) */
const RECONNECT_MAX = 30000;

/** Debounce thời gian typing (ms) */
const TYPING_DEBOUNCE = 1500;

// ═══════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const el = {
  // Header
  connectionStatus: $('#connection-status'),
  statusText: $('.status-text'),
  onlineNumber: $('#online-number'),
  btnThemeToggle: $('#btn-theme-toggle'),
  btnSoundToggle: $('#btn-sound-toggle'),

  // Screens
  screenLogin: $('#screen-login'),
  screenWaiting: $('#screen-waiting'),
  screenChat: $('#screen-chat'),

  // Login (Lobby)
  inputNickname: $('#input-nickname'),
  userAvatarPreview: $('#user-avatar-preview'),
  avatarSelector: $('#avatar-selector'),
  btnRandomName: $('#btn-random-name'),
  moodsContainer: $('#moods-container'),
  interestsContainer: $('#interests-container'),
  interestsCounter: $('#interests-counter'),
  btnStart: $('#btn-start'),
  btnStartSolo: $('#btn-start-solo'),

  // Waiting
  waitingInfo: $('#waiting-info'),
  waitTime: $('#wait-time'),
  rotatingFactText: $('#rotating-fact-text'),
  btnCancel: $('#btn-cancel'),
  soloHintBox: $('#solo-hint-box'),
  btnAcceptSolo: $('#btn-accept-solo'),

  // Chat
  partnerAvatar: $('#partner-avatar'),
  partnerNickname: $('#partner-nickname'),
  botBadge: $('#bot-badge'),
  partnerMood: $('#partner-mood'),
  partnerMoodText: $('#partner-mood-text'),
  commonInterests: $('#common-interests'),
  chatMessages: $('#chat-messages'),
  typingIndicator: $('#typing-indicator'),
  quickEmojiList: $('#quick-emoji-list'),
  inputMessage: $('#input-message'),
  btnSend: $('#btn-send'),
  inputAttachment: $('#input-attachment'),
  btnAttachment: $('#btn-attachment'),
  attachmentStatus: $('#attachment-status'),
  btnVoice: $('#btn-voice'),
  voiceRecordingBar: $('#voice-recording-bar'),
  voiceRecTimer: $('#voice-rec-timer'),
  voiceWaveVisualizer: $('#voice-wave-visualizer'),
  voiceRecHint: $('#voice-rec-hint'),
  btnVoiceCancel: $('#btn-voice-cancel'),
  btnVoiceSend: $('#btn-voice-send'),
  btnEmojiToggle: $('#btn-emoji-toggle'),
  btnStickerToggle: $('#btn-sticker-toggle'),
  emojiPickerPopover: $('#emoji-picker-popover'),
  tabPickerEmoji: $('#tab-picker-emoji'),
  tabPickerStickers: $('#tab-picker-stickers'),
  pickerEmojiView: $('#picker-emoji-view'),
  pickerStickerView: $('#picker-sticker-view'),
  stickerGridContainer: $('#sticker-grid-container'),
  stickerPackTabs: $('#sticker-pack-tabs'),
  stickerCurrentPackTitle: $('#sticker-current-pack-title'),
  inputEmojiSearch: $('#input-emoji-search'),
  btnCloseEmojiPicker: $('#btn-close-emoji-picker'),
  emojiGridContainer: $('#emoji-grid-container'),
  emojiCategoryTabs: $('#emoji-category-tabs'),
  memeSuggestionsBar: $('#meme-suggestions-bar'),
  memeKeywordHighlight: $('#meme-keyword-highlight'),
  suggestedEmojisRow: $('#suggested-emojis-row'),
  suggestedEmojisList: $('#suggested-emojis-list'),
  memeSuggestionsList: $('#meme-suggestions-list'),
  btnCloseMemeSuggestions: $('#btn-close-meme-suggestions'),
  btnSkip: $('#btn-skip'),
  btnReport: $('#btn-report'),
  charCurrent: $('#char-current'),
  btnLeaveRoom: $('#btn-leave-room'),

  // Partner Profile Modal (Lumi & Partner Info)
  modalPartnerInfo: $('#modal-partner-info'),
  modalProfileAvatar: $('#modal-profile-avatar'),
  modalProfileName: $('#modal-profile-name'),
  modalProfileMoodPill: $('#modal-profile-mood-pill'),
  modalProfileDesc: $('#modal-profile-desc'),
  modalProfileInterests: $('#modal-profile-interests'),
  btnClosePartnerInfo: $('#btn-close-partner-info'),

  // Icebreaker & Minigame actions
  btnIcebreaker: $('#btn-icebreaker'),
  icebreakerBanner: $('#icebreaker-banner'),
  icebreakerCategory: $('#icebreaker-category'),
  icebreakerText: $('#icebreaker-text'),
  btnUseIcebreaker: $('#btn-use-icebreaker'),
  btnCloseIcebreaker: $('#btn-close-icebreaker'),
  btnMinigame: $('#btn-minigame'),
  gamePanel: $('#game-panel'),
  gameStatusText: $('#game-status-text'),
  gameRuleHint: $('#game-rule-hint'),
  gameSizeControls: $('#game-size-controls'),
  btnCloseGame: $('#btn-close-game'),
  tictactoeBoard: $('#tictactoe-board'),
  btnGameReplay: $('#btn-game-replay'),

  // Game Invite Modal
  modalGameInvite: $('#modal-game-invite'),
  gameInviterName: $('#game-inviter-name'),
  gameInviteDescription: $('#game-invite-description'),
  btnGameAccept: $('#btn-game-accept'),
  btnGameDecline: $('#btn-game-decline'),

  // Kicked Modal
  modalKicked: $('#modal-kicked'),
  kickedReason: $('#kicked-reason'),
  btnKickedOk: $('#btn-kicked-ok'),
  modalLeaveConfirm: $('#modal-leave-confirm'),
  btnCancelLeave: $('#btn-cancel-leave'),
  btnConfirmLeave: $('#btn-confirm-leave'),

  // Report Modal
  modalReport: $('#modal-report'),
  inputReportReason: $('#input-report-reason'),
  btnReportCancel: $('#btn-report-cancel'),
  btnReportSubmit: $('#btn-report-submit'),

  // Toast
  toastContainer: $('#toast-container'),

  // Reconnect Overlay
  reconnectOverlay: $('#reconnect-overlay'),
  reconnectDesc: $('#reconnect-desc'),
  btnReconnectNow: $('#btn-reconnect-now'),
};

// ═══════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════

const MOOD_NAMES = {
  ngau_nhien: '☕ Tùy duyên',
  tam_su: '🌙 Muốn tâm sự',
  vui_ve: '☀️ Vui vẻ',
  tim_ban_game: '🎮 Tìm bạn game',
  hoc_tap: '📚 Cùng học',
  chan_nan: '🌧️ Buồn một chút'
};

const WAITING_TIPS = [
  "Mẹo: Chọn sở thích giúp bạn dễ gặp người cùng gu hơn nhiều đấy!",
  "Cứ mở đầu bằng một câu 'Chào bạn' đơn giản là tự nhiên nhất 👋",
  "Bí chủ đề? Thử bấm nút 'Gợi ý bắt chuyện' xem sao 🎲",
  "Làm một ván cờ Caro 1-1 là cách phá tan sự ngại ngùng nhanh nhất 🎮",
  "Tôn trọng nhau một chút là có ngay cuộc trò chuyện vui vẻ ✨",
  "Bấm phím Esc để chuyển nhanh sang người khác nhé ⏭️",
  "Lúc vắng người, bạn có thể tâm sự hoặc chơi cờ cùng Lumi 🤖"
];

let ws = null;
let clientId = null;
const RESUME_TOKEN_KEY = 'chatmatch_resume_token';
let resumePending = false;
let nickname = '';
let userAvatar = '🦊';
let interests = [];
let selectedMood = 'ngau_nhien';
let currentScreen = 'login';
let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnectCountdownTimer = null;
let waitTimer = null;
let waitSeconds = 0;
let factTimer = null;
let factIndex = 0;
let typingTimer = null;
let isTypingSent = false;
let soundEnabled = true;
let pendingAttachmentFile = null;
let attachmentUploadActive = false;

// Minigame & Partner State
let myGameSymbol = null;
let currentGameState = null;
let selectedGameSize = 10;
let isCurrentPartnerBot = false;
let currentPartner = {
  nickname: '',
  mood: '',
  interests: [],
  avatar: '👤',
  isBot: false
};

// ═══════════════════════════════════════════════════
// Audio Effects via Web Audio API (No external assets)
// ═══════════════════════════════════════════════════

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(freq, type = 'sine', duration = 0.12, volume = 0.1) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    // AudioContext might be blocked until user gesture
  }
}

/** Âm báo khi ghép cặp thành công (Chime chord) */
function playMatchSound() {
  if (!soundEnabled) return;
  try {
    playTone(523.25, 'triangle', 0.18, 0.12); // C5
    setTimeout(() => playTone(659.25, 'triangle', 0.22, 0.12), 100); // E5
    setTimeout(() => playTone(783.99, 'triangle', 0.35, 0.14), 200); // G5
  } catch (e) { }
}

/** Âm báo tin nhắn đến (Pop) */
function playMessageSound() {
  if (!soundEnabled) return;
  try {
    playTone(880, 'sine', 0.09, 0.1);
    setTimeout(() => playTone(1174.66, 'sine', 0.12, 0.08), 50);
  } catch (e) { }
}

/** Âm báo minigame click */
function playGameClickSound() {
  if (!soundEnabled) return;
  playTone(440, 'triangle', 0.07, 0.08);
}

function initSound() {
  const savedSound = localStorage.getItem('chatmatch_sound');
  soundEnabled = savedSound !== 'false';
  updateSoundIcon();
}

function initTheme() {
  const savedTheme = localStorage.getItem('chatmatch_theme');
  const theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark';
  document.documentElement.dataset.theme = theme;
  updateThemeIcon();
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('chatmatch_theme', nextTheme);
  updateThemeIcon();
  showToast(nextTheme === 'light' ? 'Đã bật giao diện sáng ☀️' : 'Đã bật giao diện tối 🌙', 'info', 1600);
}

function updateThemeIcon() {
  if (!el.btnThemeToggle) return;

  const isDark = document.documentElement.dataset.theme === 'dark';
  const icon = el.btnThemeToggle.querySelector('.theme-icon');
  if (icon) icon.textContent = isDark ? '☀️' : '🌙';

  const label = isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
  el.btnThemeToggle.title = label;
  el.btnThemeToggle.setAttribute('aria-label', label);
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('chatmatch_sound', soundEnabled ? 'true' : 'false');
  updateSoundIcon();
  if (soundEnabled) {
    playTone(600, 'sine', 0.1, 0.15);
    showToast('Đã bật âm thanh hiệu ứng 🔔', 'info', 1600);
  } else {
    showToast('Đã tắt âm thanh hiệu ứng 🔕', 'info', 1600);
  }
}

function updateSoundIcon() {
  if (el.btnSoundToggle) {
    const icon = el.btnSoundToggle.querySelector('.sound-icon');
    if (icon) {
      icon.textContent = soundEnabled ? '🔔' : '🔕';
    }
    el.btnSoundToggle.title = soundEnabled ? 'Âm thanh: Đang BẬT (Click để tắt)' : 'Âm thanh: Đang TẮT (Click để bật)';
  }
}

// ═══════════════════════════════════════════════════
// Random Nickname Generator
// ═══════════════════════════════════════════════════

const ADJECTIVES = [
  'Mộng Mơ', 'Chill', 'Vui Vẻ', 'Tí Hon', 'Phi Hành', 'Huyền Bí', 'Đáng Yêu',
  'Thông Thái', 'Lém Lỉnh', 'Can Đảm', 'Dịu Dàng', 'Bí Ẩn', 'Hài Hước', 'Tinh Nghịch'
];

const NOUNS = [
  'Cáo Nhỏ', 'Cú Đêm', 'Mèo Sao', 'Gấu Trúc', 'Hải Âu', 'Sóc Nâu', 'Chim Cánh Cụt',
  'Ninja', 'Phi Hành Gia', 'Lữ Khách', 'Thỏ Trắng', 'Rồng Lửa', 'Cún Con', 'Cà Phê'
];

function generateRandomNickname() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${noun} ${adj}`;
}

// ═══════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════

/**
 * Lấy hoặc tạo Persistent Device Fingerprint ID lưu trong sessionStorage.
 * Sử dụng sessionStorage giúp mỗi tab trình duyệt hoạt động độc lập (hỗ trợ test mở 2 tab cùng trình duyệt),
 * đồng thời vẫn duy trì deviceId khi F5 reload tab đó để nhận diện thiết bị.
 */
function getOrCreateDeviceId() {
  const STORAGE_KEY = 'chatmatch_device_id';
  try {
    let id = sessionStorage.getItem(STORAGE_KEY);
    if (!id || id.length < 16) {
      if (window.crypto && crypto.randomUUID) {
        id = crypto.randomUUID();
      } else {
        id = 'dev-' + Math.random().toString(36).substring(2, 15) + '-' + Date.now().toString(36);
      }
      sessionStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch (e) {
    return 'dev-anon-' + Math.random().toString(36).substring(2, 10);
  }
}

/** Escape HTML để chống XSS */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Hiện toast thông báo */
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

/** Chuyển màn hình */
function switchScreen(screen) {
  el.screenLogin.classList.remove('active');
  el.screenWaiting.classList.remove('active');
  el.screenChat.classList.remove('active');

  if (screen !== 'chat') {
    if (typeof cancelVoiceRecording === 'function') cancelVoiceRecording();
    if (el.emojiPickerPopover) el.emojiPickerPopover.classList.add('hidden');
    if (el.memeSuggestionsBar) el.memeSuggestionsBar.classList.add('hidden');
    if (currentPlayingAudio) {
      currentPlayingAudio.pause();
      if (currentPlayingResetFn) currentPlayingResetFn();
      currentPlayingAudio = null;
      currentPlayingResetFn = null;
    }
  }

  currentScreen = screen;

  switch (screen) {
    case 'login':
      el.screenLogin.classList.add('active');
      stopWaitTimer();
      stopFactRotation();
      break;
    case 'waiting':
      el.screenWaiting.classList.add('active');
      if (el.soloHintBox) el.soloHintBox.classList.add('hidden');
      startWaitTimer();
      startFactRotation();
      break;
    case 'chat':
      el.screenChat.classList.add('active');
      stopWaitTimer();
      stopFactRotation();
      setTimeout(() => el.inputMessage.focus(), 150);
      break;
  }
  updateAttachmentButton();
}

/** Bắt đầu đếm thời gian chờ */
function startWaitTimer() {
  waitSeconds = 0;
  el.waitTime.textContent = '0';
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = setInterval(() => {
    waitSeconds++;
    el.waitTime.textContent = waitSeconds;
  }, 1000);
}

/** Dừng đếm thời gian chờ */
function stopWaitTimer() {
  if (waitTimer) {
    clearInterval(waitTimer);
    waitTimer = null;
  }
}

/** Mẹo chờ xoay vòng */
function startFactRotation() {
  stopFactRotation();
  factIndex = Math.floor(Math.random() * WAITING_TIPS.length);
  if (el.rotatingFactText) {
    el.rotatingFactText.textContent = WAITING_TIPS[factIndex];
  }
  factTimer = setInterval(() => {
    factIndex = (factIndex + 1) % WAITING_TIPS.length;
    if (el.rotatingFactText) {
      el.rotatingFactText.style.opacity = '0';
      setTimeout(() => {
        el.rotatingFactText.textContent = WAITING_TIPS[factIndex];
        el.rotatingFactText.style.opacity = '1';
      }, 250);
    }
  }, 5000);
}

function stopFactRotation() {
  if (factTimer) {
    clearInterval(factTimer);
    factTimer = null;
  }
}

/** Cập nhật bộ đếm sở thích */
function updateInterestsCounter() {
  if (!el.interestsContainer || !el.interestsCounter) return;
  const count = el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked').length;
  el.interestsCounter.textContent = `Tối đa 5 (đã chọn: ${count}/5)`;
  syncLiveFrequencyCard();
}

/** Đồng bộ Thẻ Vé Tần Số trực tiếp ở sảnh chờ (an toàn XSS với textContent) */
function syncLiveFrequencyCard() {
  const liveAvatar = $('#live-card-avatar');
  const liveName = $('#live-card-name');
  const liveMood = $('#live-card-mood');
  const liveTags = $('#live-card-tags');

  if (liveAvatar) {
    liveAvatar.textContent = userAvatar || '🦊';
  }
  if (liveName && el.inputNickname) {
    const typed = el.inputNickname.value.trim();
    liveName.textContent = typed || 'Khách Tần Số Đêm';
  }
  if (liveMood && el.moodsContainer) {
    const checkedMood = el.moodsContainer.querySelector('input[name="mood"]:checked');
    const moodKey = checkedMood ? checkedMood.value : 'ngau_nhien';
    liveMood.textContent = MOOD_NAMES[moodKey] || '☕ Tùy duyên';
  }
  if (liveTags && el.interestsContainer) {
    const checkedBoxes = el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked');
    liveTags.textContent = '';
    if (checkedBoxes.length === 0) {
      const emptySpan = document.createElement('span');
      emptySpan.className = 'live-pass-tag muted';
      emptySpan.textContent = 'Chưa chọn chủ đề ưu tiên • Ghép mở tự nhiên';
      liveTags.appendChild(emptySpan);
    } else {
      checkedBoxes.forEach((cb) => {
        const labelSpan = cb.parentElement ? cb.parentElement.querySelector('span') : null;
        const tag = document.createElement('span');
        tag.className = 'live-pass-tag';
        tag.textContent = labelSpan ? labelSpan.textContent : cb.value;
        liveTags.appendChild(tag);
      });
    }
  }
}

/** Định dạng thời gian */
function formatTime(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════
// WebSocket Connection
// ═══════════════════════════════════════════════════

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;

  console.log(`[WS] Connecting to ${wsUrl}...`);
  updateConnectionStatus('connecting');

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected!');
    reconnectAttempts = 0;
    if (reconnectCountdownTimer) {
      clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (el.reconnectOverlay) {
      el.reconnectOverlay.classList.add('hidden');
    }
    updateConnectionStatus('connected');

    // Chờ message 'connected' từ server.
    // Không gửi join hoặc find_match tại đây,
    // vì có thể phiên chat cũ đang cần được khôi phục.
  };

  ws.onmessage = (event) => {
    handleMessage(event.data);
  };

  ws.onclose = (event) => {
    console.log(`[WS] Closed (code=${event.code}, reason=${event.reason})`);
    updateConnectionStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('[WS] Error:', error);
  };
}

/** Tự động kết nối lại (Exponential Backoff) */
function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts), RECONNECT_MAX);
  reconnectAttempts++;

  let remainingSec = Math.max(1, Math.round(delay / 1000));
  console.log(`[WS] Reconnecting in ${remainingSec}s (attempt #${reconnectAttempts})...`);

  if (el.reconnectOverlay) {
    el.reconnectOverlay.classList.remove('hidden');
    el.reconnectDesc.textContent = `Tự động kết nối lại sau ${remainingSec}s (lần #${reconnectAttempts})…`;
  }
  el.statusText.textContent = `Kết nối lại sau ${remainingSec}s…`;

  if (reconnectCountdownTimer) clearInterval(reconnectCountdownTimer);
  reconnectCountdownTimer = setInterval(() => {
    remainingSec--;
    if (remainingSec > 0) {
      if (el.reconnectDesc) {
        el.reconnectDesc.textContent = `Tự động kết nối lại sau ${remainingSec}s (lần #${reconnectAttempts})…`;
      }
      el.statusText.textContent = `Kết nối lại sau ${remainingSec}s…`;
    } else {
      clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
  }, 1000);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Cập nhật trạng thái kết nối trên UI */
function updateConnectionStatus(status) {
  el.connectionStatus.className = `status-indicator ${status}`;
  switch (status) {
    case 'connected':
      el.statusText.textContent = 'Đã kết nối';
      break;
    case 'disconnected':
      el.statusText.textContent = 'Mất kết nối';
      break;
    case 'connecting':
      el.statusText.textContent = 'Đang kết nối…';
      break;
  }
}

/** Gửi message qua WebSocket */
function send(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Chưa kết nối đến server', 'error');
    return;
  }
  ws.send(JSON.stringify({ type, payload }));
}

// ═══════════════════════════════════════════════════
// Message Handlers
// ═══════════════════════════════════════════════════

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error('[WS] Invalid JSON:', raw);
    return;
  }

  const { type, payload } = msg;
  const loggedPayload = type === 'resume_token'
    ? { token: '[redacted]' }
    : type === 'attachment_upload'
      ? { ...payload, ticket: '[redacted]' }
      : ['attachment', 'attachment_sent'].includes(type)
        ? {
            ...payload,
            attachment: {
              ...payload.attachment,
              url: '[redacted]'
            }
          }
        : payload;
  console.log(`[WS] ← ${type}`, loggedPayload);

  switch (type) {
    case 'connected': {
      clientId = payload.clientId;
      el.onlineNumber.textContent = payload.onlineCount;

      const token = sessionStorage.getItem(RESUME_TOKEN_KEY);

      // Nếu đang ở phòng người thật và còn token, thử resume
      if (
        currentScreen === 'chat' &&
        !isCurrentPartnerBot &&
        token &&
        /^[0-9a-f]{64}$/.test(token)
      ) {
        resumePending = true;

        console.log('[Resume] Đang yêu cầu khôi phục phòng...');
        send('resume_session', { token });
        break;
      }

      // Không có phiên để khôi phục:
      // đăng ký lại thông tin người dùng như logic cũ
      resumePending = false;

      if (nickname) {
        send('join', {
          nickname,
          interests,
          mood: selectedMood,
          avatar: userAvatar,
          deviceId: getOrCreateDeviceId()
        });

        if (currentScreen === 'waiting') {
          send('find_match');
          showToast('Đã khôi phục hàng đợi tìm kiếm', 'info');
        } else if (currentScreen === 'chat') {
          // Phòng Lumi hoặc không còn token khôi phục
          sessionStorage.removeItem(RESUME_TOKEN_KEY);
          showToast('Phiên trò chuyện trước đã kết thúc.', 'info');
          switchScreen('login');
        }
      }

      break;
    }

    
    case 'resume_success': {
      resumePending = false;

      // Khôi phục clientId gốc để Caro nhận diện đúng X/O
      clientId = payload.clientId;

      console.log('[Resume] Khôi phục phòng thành công');

      // Giữ nguyên các tin nhắn đang hiển thị
      // Không gọi handleMatchFound() vì hàm đó xóa lịch sử chat
      if (currentScreen !== 'chat') {
        switchScreen('chat');
      }

      // Khôi phục trạng thái bàn cờ từ server
      if (payload.game) {
        handleGameState({
          action: 'update',
          game: payload.game
        });
      }

      // Cho phép tiếp tục nhập tin nhắn
      el.inputMessage.disabled = false;
      el.btnSend.disabled = false;
      updateAttachmentButton();

      if (el.reconnectOverlay) {
        el.reconnectOverlay.classList.add('hidden');
      }

      if (payload.partnerDisconnected) {
        addSystemMessage(
          'Bạn đã quay lại phòng. Đang chờ đối phương kết nối lại.'
        );
      } else {
        addSystemMessage('Đã khôi phục kết nối với phòng chat cũ.');
      }

      showToast('Đã quay lại phòng chat thành công!', 'success');
      break;
    }

    case 'resume_failed': {
      resumePending = false;

      // Không giữ token đã thất bại
      sessionStorage.removeItem(RESUME_TOKEN_KEY);

      console.warn('[Resume] Khôi phục thất bại:', payload.message);

      showToast(
        payload.message || 'Không thể khôi phục phòng chat.',
        'warning',
        5000
      );

      if (el.reconnectOverlay) {
        el.reconnectOverlay.classList.add('hidden');
      }

      if (el.gamePanel) {
        el.gamePanel.classList.add('hidden');
      }

      switchScreen('login');
      break;
    }


    case 'resume_token':
      if (typeof payload?.token === 'string' &&
          /^[0-9a-f]{64}$/.test(payload.token)) {

        sessionStorage.setItem('chatmatch_resume_token', payload.token);

        console.log('[Resume] Đã lưu Resume Token');
      }
      break;

    case 'waiting':
      // chuyển về màn hình waiting nếu đã vào màn hình chat
      switchScreen('waiting');
      break;

    case 'solo_hint':
      if (el.soloHintBox) {
        if (payload && payload.message) {
          const msgEl = el.soloHintBox.querySelector('.solo-hint-msg');
          if (msgEl) msgEl.textContent = payload.message;
        }
        el.soloHintBox.classList.remove('hidden');
      }
      break;

    case 'match_found':
      handleMatchFound(payload);
      playMatchSound();
      break;

    case 'message':
      appendMessage(payload.text, 'received', payload.timestamp, payload.linkSafety);
      playMessageSound();
      break;

    case 'voice':
      appendVoiceMessage(payload, 'received', payload.timestamp);
      playMessageSound();
      break;

    case 'meme':
      if (payload.isSticker) {
        appendStickerMessage(payload.url, payload.title, 'received', payload.timestamp);
      } else {
        appendMemeMessage(payload.url, payload.title, 'received', payload.timestamp);
      }
      playMessageSound();
      break;

    case 'link_warning':
      showLinkSafetyToast(payload);
      break;

    case 'attachment_upload':
      uploadSelectedAttachment(payload);
      break;

    case 'attachment':
      appendAttachmentMessage(payload.attachment, 'received', payload.timestamp);
      playMessageSound();
      break;

    case 'attachment_sent':
      appendAttachmentMessage(payload.attachment, 'sent', payload.timestamp);
      attachmentUploadActive = false;
      pendingAttachmentFile = null;
      setAttachmentStatus('');
      updateAttachmentButton();
      showToast('Đã gửi tệp.', 'success');
      break;

    case 'typing':
      handleTypingIndicator(payload.isTyping);
      break;

    case 'partner_left':
      handlePartnerLeft();
      break;

    case 'icebreaker':
      handleIcebreaker(payload);
      break;

    case 'game_invite':
      handleGameInvite(payload);
      break;

    case 'game_state':
      handleGameState(payload);
      break;

    case 'kicked':
      handleKicked(payload);
      break;

    case 'online_count':
      el.onlineNumber.textContent = payload.count;
      break;

    case 'error':
      if (payload.code === 'MATCHMAKING_UNAVAILABLE') {
        if (currentScreen === 'waiting') switchScreen('login');
        showToast(payload.message, 'error');
      } else if (payload.code && payload.code.startsWith('ATTACHMENT_')) {
        attachmentUploadActive = false;
        pendingAttachmentFile = null;
        setAttachmentStatus('');
        updateAttachmentButton();
        showToast(payload.message, 'error');
      } else if (payload.code === 'RATE_LIMITED' && attachmentUploadActive) {
        attachmentUploadActive = false;
        pendingAttachmentFile = null;
        setAttachmentStatus('');
        updateAttachmentButton();
        showToast(payload.message, 'warning');
      } else if (payload.code === 'SKIP_COOLDOWN') {
        showToast('⚠️ ' + payload.message, 'warning', 4000);
      } else if (payload.code === 'BANNED') {
        showToast('🚫 ' + payload.message, 'error', 5000);
      } else {
        showToast(payload.message, 'error');
      }
      break;

    case 'reported':
      showToast('Báo cáo đã được ghi nhận. Hai thiết bị sẽ không được ghép lại trong 5 phút.', 'success');
      break;

    default:
      console.warn('[WS] Unknown type:', type);
  }
}

/** Xử lý khi ghép cặp thành công */
function handleMatchFound(payload) {
  isCurrentPartnerBot = Boolean(payload.isBot);
  updateAttachmentButton();

  currentPartner = {
    nickname: payload.partnerNickname,
    mood: payload.partnerMood,
    interests: payload.commonInterests || [],
    avatar: payload.partnerAvatar || (payload.isBot ? '🤖' : '👤'),
    isBot: isCurrentPartnerBot
  };

  el.partnerNickname.textContent = payload.partnerNickname;

  if (isCurrentPartnerBot) {
    if (el.partnerAvatar) el.partnerAvatar.textContent = '🤖';
    if (el.botBadge) el.botBadge.classList.remove('hidden');
    if (el.partnerMood) {
      if (el.partnerMoodText) {
        el.partnerMoodText.textContent = payload.partnerMood || 'Lắng nghe & chia sẻ';
      }
      el.partnerMood.classList.remove('hidden');
    }
    el.commonInterests.textContent = 'Bạn ảo Lumi • Luôn ở đây khi bạn cần';
    if (el.btnSkip) {
      el.btnSkip.innerHTML = '<span class="action-icon">👥</span> Tìm người thật <kbd class="kbd-hint">Esc</kbd>';
      el.btnSkip.title = 'Chuyển sang tìm bạn chat người thật (Phím tắt: Esc)';
    }
    if (el.btnReport) el.btnReport.classList.add('hidden');
  } else {
    // Nếu partner có avatar riêng gửi kèm thì dùng, không thì ngẫu nhiên hoặc icon thân thiện
    if (el.partnerAvatar) {
      el.partnerAvatar.textContent = payload.partnerAvatar || '👤';
    }
    if (el.botBadge) el.botBadge.classList.add('hidden');

    // Hiển thị tâm trạng đối phương
    if (payload.partnerMood && MOOD_NAMES[payload.partnerMood]) {
      if (el.partnerMoodText) {
        el.partnerMoodText.textContent = MOOD_NAMES[payload.partnerMood];
      }
      el.partnerMood.classList.remove('hidden');
    } else {
      el.partnerMood.classList.add('hidden');
    }

    // Hiển thị sở thích chung
    if (payload.commonInterests && payload.commonInterests.length > 0) {
      el.commonInterests.textContent = `🎯 Cùng thích: ${payload.commonInterests.join(', ')}`;
    } else {
      el.commonInterests.textContent = '✨ Ghép ngẫu nhiên';
    }

    if (el.btnSkip) {
      el.btnSkip.innerHTML = '<span class="action-icon">⏭️</span> Bỏ qua <kbd class="kbd-hint">Esc</kbd>';
      el.btnSkip.title = 'Đổi sang người khác (Phím tắt: Esc)';
    }
    if (el.btnReport) el.btnReport.classList.remove('hidden');
  }

  // Reset các panel phụ
  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  if (el.gamePanel) el.gamePanel.classList.add('hidden');
  if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');
  myGameSymbol = null;
  currentGameState = null;

  // Xóa tin nhắn cũ
  el.chatMessages.innerHTML = '';

  // Thêm thông báo hệ thống
  if (isCurrentPartnerBot) {
    addSystemMessage('✨ Bạn đang trò chuyện cùng Lumi. Cứ thoải mái tâm sự hoặc rủ Lumi chơi Caro nhé!');
  } else {
    addSystemMessage(`🎉 Đã kết nối với ${payload.partnerNickname}! Chào nhau một câu nào 👋`);
  }

  // Chuyển sang màn hình chat
  switchScreen('chat');

  // Reset typing
  handleTypingIndicator(false);
}

/** Mở Modal xem chi tiết thông tin bạn chat hoặc trợ lý Lumi */
function showPartnerProfileModal() {
  if (!el.modalPartnerInfo) return;

  if (isCurrentPartnerBot) {
    if (el.modalProfileAvatar) el.modalProfileAvatar.textContent = '🤖';
    if (el.modalProfileName) el.modalProfileName.textContent = 'Lumi';
    if (el.modalProfileMoodPill) el.modalProfileMoodPill.textContent = '✨ Luôn sẵn sàng lắng nghe';
    if (el.modalProfileDesc) {
      el.modalProfileDesc.textContent = 'Lumi là người bạn ảo luôn ở đây để nghe bạn tâm sự mọi điều và cùng bạn làm vài ván cờ Caro giải trí bất cứ lúc nào!';
    }
    if (el.modalProfileInterests) {
      el.modalProfileInterests.innerHTML = `
        <span class="profile-interest-tag">💬 Tâm sự</span>
        <span class="profile-interest-tag">🎮 Cờ Caro</span>
        <span class="profile-interest-tag">💡 Chia sẻ</span>
        <span class="profile-interest-tag">✨ Giữ bí mật</span>
      `;
    }
  } else {
    if (el.modalProfileAvatar) el.modalProfileAvatar.textContent = currentPartner.avatar || '👤';
    if (el.modalProfileName) el.modalProfileName.textContent = currentPartner.nickname || 'Bạn chat';
    const moodLabel = MOOD_NAMES[currentPartner.mood] || currentPartner.mood || 'Tùy duyên';
    if (el.modalProfileMoodPill) el.modalProfileMoodPill.textContent = `Tâm trạng: ${moodLabel}`;
    if (el.modalProfileDesc) {
      el.modalProfileDesc.textContent = `Bạn này đang có tâm trạng "${moodLabel}". Hãy chào nhau thật tự nhiên nhé!`;
    }
    if (el.modalProfileInterests) {
      if (currentPartner.interests && currentPartner.interests.length > 0) {
        el.modalProfileInterests.textContent = '';
        for (const tag of currentPartner.interests) {
          const interestTag = document.createElement('span');
          interestTag.className = 'profile-interest-tag';
          interestTag.textContent = `✨ ${tag}`;
          el.modalProfileInterests.appendChild(interestTag);
        }
      } else {
        el.modalProfileInterests.innerHTML = '<span class="profile-interest-tag">Nói chuyện tự do</span>';
      }
    }
  }

  el.modalPartnerInfo.classList.remove('hidden');
  playTone(550, 'sine', 0.04, 0.06);
}

/** Xử lý khi đối phương rời phòng */
function handlePartnerLeft() {
  addSystemMessage('Bạn kia đã rời phòng chat.');
  showToast('Người kia đã rời đi', 'info');

  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  if (el.gamePanel) el.gamePanel.classList.add('hidden');
  if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');

  // Disable input
  el.inputMessage.disabled = true;
  el.btnSend.disabled = true;
  if (el.btnAttachment) el.btnAttachment.disabled = true;
  handleTypingIndicator(false);

  // Sau 2 giây quay về màn hình login
  setTimeout(() => {
    el.inputMessage.disabled = false;
    el.btnSend.disabled = false;
    updateAttachmentButton();
    switchScreen('login');
  }, 2200);
}

/** Xử lý nhận gợi ý phá băng */
function handleIcebreaker(payload) {
  if (!el.icebreakerBanner) return;
  el.icebreakerCategory.textContent = payload.category || 'Chủ đề';
  el.icebreakerText.textContent = payload.question;
  el.icebreakerBanner.classList.remove('hidden');
  addSystemMessage(`🎲 Gợi ý bắt chuyện: "${payload.question}"`);
}

/** Xử lý nhận lời mời chơi game */
function handleGameInvite(payload) {
  if (!el.modalGameInvite) return;
  el.gameInviterName.textContent = payload.from || 'Bạn kia';
  el.modalGameInvite.classList.remove('hidden');
  playMatchSound();
}

/** Cập nhật bàn cờ Caro (Hỗ trợ 10x10, 15x15 và 20x20) */
function handleGameState(payload) {
  if (!payload) return;

    if (payload.action === 'invite_sent') {
    showToast(
      `Đã gửi lời mời cờ Caro (${payload.size}x${payload.size}) tới đối phương!`,
      'info'
    );
    return;
  }

  // 1. Nhận lời mời chơi game
  if (payload.action === 'invite') {
    if (el.modalGameInvite) {
      el.gameInviterName.textContent = payload.fromName || 'Đối phương';
      selectedGameSize = [10, 15, 20].includes(payload.size) ? payload.size : 10;
      if (el.gameSizeControls) {
        el.gameSizeControls.querySelectorAll('.size-btn').forEach(btn => {
          btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === selectedGameSize);
        });
      }
      if (el.gameInviteDescription) {
        el.gameInviteDescription.textContent = `${payload.fromName || 'Đối phương'} vừa gửi lời mời bạn cùng chơi cờ Caro ${selectedGameSize}x${selectedGameSize}.`;
      }
      el.modalGameInvite.classList.remove('hidden');
      playMatchSound();
    }
    return;
  }

  // 2. Đối phương đóng/thoát minigame
  if (payload.action === 'quit') {
    if (el.gamePanel) el.gamePanel.classList.add('hidden');
    showToast(`${payload.quitterName || 'Đối phương'} đã đóng minigame`, 'info');
    return;
  }

  // 3. Ván đấu (start hoặc update)
  const game = payload.game || payload;
  currentGameState = game;
  if (!el.gamePanel || !game) return;

  el.gamePanel.classList.remove('hidden');

  // Xác định biểu tượng người chơi (X đánh trước)
  if (game.xPlayer === clientId) {
    myGameSymbol = 'X';
  } else if (game.oPlayer === clientId) {
    myGameSymbol = 'O';
  }

  // Kích thước bàn cờ & điều kiện thắng
  const boardLength = (game.board && game.board.length) || 100;
  const boardSize = game.size || Math.round(Math.sqrt(boardLength)) || 10;
  const winLength = game.winLength || 5;
  selectedGameSize = boardSize;

  // Cập nhật dòng gợi ý luật chơi
  if (el.gameRuleHint) {
    el.gameRuleHint.textContent = `Bàn ${boardSize}x${boardSize} • Nối liền ${winLength} ô cùng hàng/cột/chéo để thắng`;
  }

  // Cập nhật trạng thái active của các nút chọn kích thước
  if (el.gameSizeControls) {
    el.gameSizeControls.querySelectorAll('.size-btn').forEach(btn => {
      const s = parseInt(btn.dataset.size, 10);
      btn.classList.toggle('active', s === boardSize);
    });
  }

  // Render động số ô nếu số lượng ô trong DOM chưa khớp
  const totalCells = boardSize * boardSize;
  let cells = el.tictactoeBoard ? el.tictactoeBoard.querySelectorAll('.cell') : [];
  if (cells.length !== totalCells) {
    el.tictactoeBoard.className = `tictactoe-board size-${boardSize}`;
    el.tictactoeBoard.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < totalCells; i++) {
      const btn = document.createElement('button');
      btn.className = 'cell';
      btn.dataset.index = i;
      fragment.appendChild(btn);
    }
    el.tictactoeBoard.appendChild(fragment);
    cells = el.tictactoeBoard.querySelectorAll('.cell');
  } else {
    el.tictactoeBoard.className = `tictactoe-board size-${boardSize}`;
  }

  // Cập nhật giá trị và trạng thái từng ô
  const isMyTurn = game.status === 'playing' && game.turn === clientId;
  cells.forEach((cell, idx) => {
    const val = (game.board && game.board[idx]) || '';
    cell.textContent = val;
    cell.className = 'cell';
    if (val === 'X') cell.classList.add('x');
    if (val === 'O') cell.classList.add('o');

    if (typeof game.lastMove === 'number' && game.lastMove === idx) {
      cell.classList.add('last-move');
    }

    if (game.winningLine && game.winningLine.includes(idx)) {
      cell.classList.add('winner');
    }

    cell.disabled = !!val || game.status === 'ended' || !isMyTurn;
  });

  // Cập nhật thông báo trạng thái
  if (game.status === 'playing') {
    if (game.turn === clientId) {
      el.gameStatusText.textContent = `👉 Đến lượt BẠN (${myGameSymbol})`;
      el.gameStatusText.style.color = 'var(--success)';
    } else {
      const partnerSymbol = myGameSymbol === 'X' ? 'O' : 'X';
      el.gameStatusText.textContent = `⏳ Đợi bạn kia đi (${partnerSymbol})`;
      el.gameStatusText.style.color = 'var(--text-muted)';
    }
    el.btnGameReplay.classList.add('hidden');
  } else if (game.status === 'ended') {
    if (game.winner === 'draw') {
      el.gameStatusText.textContent = '🤝 Hòa cờ rồi!';
      el.gameStatusText.style.color = 'var(--warning)';
    } else if (game.winner === myGameSymbol) {
      el.gameStatusText.textContent = `🎉 BẠN THẮNG RỒI! (${game.winner})`;
      el.gameStatusText.style.color = 'var(--success)';
      playMatchSound();
    } else {
      el.gameStatusText.textContent = `😢 Bạn thua ván này rồi! (${game.winner} thắng)`;
      el.gameStatusText.style.color = 'var(--danger)';
    }
    el.btnGameReplay.classList.remove('hidden');
  }
}

/** Xử lý khi bị KICK do vi phạm từ ngữ khiếm nhã */
function handleKicked(payload) {
  if (el.kickedReason) {
    el.kickedReason.textContent = payload.reason || 'Tin nhắn của bạn có từ ngữ không phù hợp nên đã bị ngắt kết nối.';
  }
  if (el.modalKicked) {
    el.modalKicked.classList.remove('hidden');
  }

  el.inputMessage.disabled = true;
  el.btnSend.disabled = true;
  if (el.btnAttachment) el.btnAttachment.disabled = true;
  if (el.gamePanel) el.gamePanel.classList.add('hidden');
  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// Chat UI Functions
// ═══════════════════════════════════════════════════

/** Thêm tin nhắn vào khu vực chat */
function appendMessage(text, direction, timestamp, linkSafety = null) {
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction}`;

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text;

  bubble.appendChild(content);

  if (linkSafety && linkSafety.hasLinks) {
    const warning = document.createElement('div');
    warning.className = `link-safety-warning${linkSafety.suspicious ? ' suspicious' : ''}`;
    warning.textContent = getLinkSafetyMessage(linkSafety);
    bubble.appendChild(warning);
  }

  if (timestamp) {
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(timestamp);
    bubble.appendChild(time);
  }

  el.chatMessages.appendChild(bubble);
  scrollToBottom();
}

// ─── Voice Audio Player & Messages ──────────────────────────────────────────
let currentPlayingAudio = null;
let currentPlayingResetFn = null;

function appendVoiceMessage(voiceData, direction, timestamp) {
  if (!voiceData || typeof voiceData.url !== 'string') return;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction} voice-message-bubble`;

  const card = document.createElement('div');
  card.className = 'message-voice-player';

  const btnPlay = document.createElement('button');
  btnPlay.type = 'button';
  btnPlay.className = 'voice-play-btn';
  btnPlay.title = 'Phát / Tạm dừng tin nhắn thoại';
  btnPlay.setAttribute('aria-label', 'Phát tin nhắn thoại');
  btnPlay.innerHTML = `
    <svg class="icon-play" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <polygon points="6 4 20 12 6 20 6 4"></polygon>
    </svg>
    <svg class="icon-pause hidden" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1"></rect>
      <rect x="14" y="4" width="4" height="16" rx="1"></rect>
    </svg>
  `;

  const trackWrap = document.createElement('div');
  trackWrap.className = 'voice-track-wrap';

  const waveBarsContainer = document.createElement('div');
  waveBarsContainer.className = 'voice-bars-container';
  const barHeights = [30, 60, 45, 80, 100, 70, 90, 50, 75, 95, 60, 85, 40, 70, 50, 30];
  const barElements = [];
  barHeights.forEach((h) => {
    const bar = document.createElement('span');
    bar.className = 'voice-bar';
    bar.style.height = `${h}%`;
    waveBarsContainer.appendChild(bar);
    barElements.push(bar);
  });

  const progressLine = document.createElement('div');
  progressLine.className = 'voice-progress-fill';
  trackWrap.appendChild(waveBarsContainer);
  trackWrap.appendChild(progressLine);

  const durationText = document.createElement('span');
  durationText.className = 'voice-duration';
  const totalSeconds = Number(voiceData.duration) || 0;
  const formatSec = (s) => {
    const secVal = Math.max(0, Math.round(s));
    const mins = Math.floor(secVal / 60);
    const secs = secVal % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  durationText.textContent = formatSec(totalSeconds);

  card.appendChild(btnPlay);
  card.appendChild(trackWrap);
  card.appendChild(durationText);
  bubble.appendChild(card);

  if (timestamp) {
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(timestamp);
    bubble.appendChild(time);
  }

  el.chatMessages.appendChild(bubble);
  scrollToBottom();

  const audio = new Audio(voiceData.url);
  audio.preload = 'metadata';

  audio.addEventListener('loadedmetadata', () => {
    if (!totalSeconds && audio.duration && Number.isFinite(audio.duration)) {
      durationText.textContent = formatSec(audio.duration);
    }
  });

  audio.addEventListener('timeupdate', () => {
    const dur = audio.duration || totalSeconds || 1;
    const ratio = Math.min(1, Math.max(0, audio.currentTime / dur));
    progressLine.style.width = `${ratio * 100}%`;
    durationText.textContent = formatSec(audio.currentTime);

    const activeCount = Math.floor(ratio * barElements.length);
    barElements.forEach((bar, idx) => {
      bar.classList.toggle('active', idx <= activeCount);
    });
  });

  const resetPlayBtn = () => {
    const playIcon = btnPlay.querySelector('.icon-play');
    const pauseIcon = btnPlay.querySelector('.icon-pause');
    if (playIcon) playIcon.classList.remove('hidden');
    if (pauseIcon) pauseIcon.classList.add('hidden');
    btnPlay.classList.remove('playing');
  };

  const setPlayingState = () => {
    const playIcon = btnPlay.querySelector('.icon-play');
    const pauseIcon = btnPlay.querySelector('.icon-pause');
    if (playIcon) playIcon.classList.add('hidden');
    if (pauseIcon) pauseIcon.classList.remove('hidden');
    btnPlay.classList.add('playing');
  };

  audio.addEventListener('ended', () => {
    resetPlayBtn();
    progressLine.style.width = '0%';
    durationText.textContent = formatSec(audio.duration || totalSeconds);
    barElements.forEach((bar) => bar.classList.remove('active'));
    currentPlayingAudio = null;
    currentPlayingResetFn = null;
  });

  btnPlay.addEventListener('click', () => {
    if (audio.paused) {
      if (currentPlayingAudio && currentPlayingAudio !== audio) {
        currentPlayingAudio.pause();
        if (currentPlayingResetFn) currentPlayingResetFn();
      }
      currentPlayingAudio = audio;
      currentPlayingResetFn = resetPlayBtn;
      audio.play().then(() => {
        setPlayingState();
      }).catch((e) => {
        console.warn('[Voice] Phát âm thanh thất bại:', e);
        showToast('Không thể phát tin nhắn thoại này.', 'warning');
      });
    } else {
      audio.pause();
      resetPlayBtn();
      currentPlayingAudio = null;
      currentPlayingResetFn = null;
    }
  });

  trackWrap.addEventListener('click', (e) => {
    const rect = trackWrap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const dur = audio.duration || totalSeconds;
    if (dur && Number.isFinite(dur)) {
      audio.currentTime = ratio * dur;
    }
  });
}

// ─── Sticker & Meme Message Rendering ──────────────────────────────────────────
/** Hiển thị tin nhắn Nhãn dán trong suốt (Sticker Bubble) */
function appendStickerMessage(url, title, direction, timestamp) {
  if (!url || typeof url !== 'string') return;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction} sticker-message-bubble`;

  const wrap = document.createElement('div');
  wrap.className = 'message-sticker-wrap';

  const img = document.createElement('img');
  img.src = url;
  img.alt = title || 'Sticker';
  img.title = title || 'Nhãn dán';
  img.className = 'sticker-bubble-image';
  img.loading = 'lazy';

  wrap.appendChild(img);

  if (timestamp) {
    const time = document.createElement('div');
    time.className = 'sticker-meta-time';
    time.textContent = formatTime(timestamp);
    wrap.appendChild(time);
  }

  bubble.appendChild(wrap);
  el.chatMessages.appendChild(bubble);
  scrollToBottom();
}

function appendMemeMessage(url, title, direction, timestamp) {
  if (!url || typeof url !== 'string') return;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction} meme-message-bubble`;

  const card = document.createElement('div');
  card.className = 'message-meme-card';

  const img = document.createElement('img');
  img.src = url;
  img.alt = title || 'Meme GIF';
  img.className = 'meme-image';
  img.loading = 'lazy';

  img.addEventListener('click', () => {
    window.open(url, '_blank');
  });

  card.appendChild(img);

  if (title) {
    const caption = document.createElement('div');
    caption.className = 'meme-caption';
    caption.textContent = title;
    card.appendChild(caption);
  }

  bubble.appendChild(card);

  if (timestamp) {
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(timestamp);
    bubble.appendChild(time);
  }

  el.chatMessages.appendChild(bubble);
  scrollToBottom();
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) return 'Kích thước không xác định';
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function appendAttachmentMessage(attachment, direction, timestamp) {
  if (!attachment || typeof attachment.url !== 'string' || typeof attachment.fileName !== 'string') return;

  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    addSystemMessage('Không thể hiển thị tệp vì địa chỉ không hợp lệ.');
    return;
  }
  if (url.protocol !== 'https:' || !url.searchParams.has('sig')) {
    addSystemMessage('Không thể hiển thị tệp vì liên kết tải xuống không an toàn.');
    return;
  }

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction}`;
  const card = document.createElement('div');
  card.className = 'message-attachment';

  if (attachment.category === 'image' && attachment.contentType.startsWith('image/')) {
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const image = document.createElement('img');
    image.src = url.href;
    image.alt = attachment.fileName;
    image.loading = 'lazy';
    link.appendChild(image);
    card.appendChild(link);
  } else if (attachment.category === 'video' && attachment.contentType.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = url.href;
    video.controls = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', attachment.fileName);
    card.appendChild(video);
  } else {
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `📎 ${attachment.fileName}`;
    card.appendChild(link);
  }

  const meta = document.createElement('span');
  meta.className = 'attachment-meta';
  meta.textContent = `${formatFileSize(attachment.size)} · Liên kết tải hết hạn sau 24 giờ`;
  card.appendChild(meta);
  bubble.appendChild(card);

  if (timestamp) {
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(timestamp);
    bubble.appendChild(time);
  }
  el.chatMessages.appendChild(bubble);
  scrollToBottom();
}

function updateAttachmentButton() {
  if (!el.btnAttachment) return;
  el.btnAttachment.disabled = attachmentUploadActive || isCurrentPartnerBot || currentScreen !== 'chat';
}

function setAttachmentStatus(message) {
  if (!el.attachmentStatus) return;
  el.attachmentStatus.textContent = message;
  el.attachmentStatus.classList.toggle('hidden', !message);
}

function requestAttachment(file) {
  if (!file) return;
  if (currentScreen !== 'chat' || isCurrentPartnerBot || !ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Chỉ có thể gửi tệp khi đang trò chuyện với người dùng.', 'warning');
    return;
  }
  if (attachmentUploadActive) {
    showToast('Đang tải một tệp lên, vui lòng chờ.', 'warning');
    return;
  }

  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const maxBytes = ['.mp4', '.webm'].includes(extension) ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast(`Tệp vượt giới hạn ${maxBytes / 1024 / 1024} MB.`, 'error');
    return;
  }

  pendingAttachmentFile = file;
  attachmentUploadActive = true;
  updateAttachmentButton();
  setAttachmentStatus('Đang chuẩn bị tải tệp lên bộ lưu trữ an toàn…');
  send('attachment_request', { fileName: file.name, size: file.size });
}

function uploadSelectedAttachment(ticket) {
  const file = pendingAttachmentFile;
  if (!file || file.name !== ticket.fileName || file.size !== ticket.size) {
    attachmentUploadActive = false;
    pendingAttachmentFile = null;
    updateAttachmentButton();
    showToast('Tệp tải lên không khớp với yêu cầu ban đầu.', 'error');
    return;
  }

  let uploadUrl;
  try {
    uploadUrl = new URL(ticket.uploadPath, location.origin);
  } catch {
    showToast('Không thể tạo địa chỉ tải tệp lên.', 'error');
    attachmentUploadActive = false;
    pendingAttachmentFile = null;
    updateAttachmentButton();
    return;
  }
  if (uploadUrl.origin !== location.origin || !/^\/api\/attachments\/[0-9a-f-]{36}$/iu.test(uploadUrl.pathname)) {
    showToast('Máy chủ trả về địa chỉ tải tệp không hợp lệ.', 'error');
    attachmentUploadActive = false;
    pendingAttachmentFile = null;
    updateAttachmentButton();
    return;
  }

  const request = new XMLHttpRequest();
  request.open('POST', uploadUrl.href);
  request.timeout = 10 * 60 * 1000;
  request.setRequestHeader('Authorization', `Bearer ${ticket.ticket}`);
  request.setRequestHeader('Content-Type', ticket.contentType);
  request.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.floor((event.loaded / event.total) * 100);
    setAttachmentStatus(`Đang tải ${file.name}: ${percent}%`);
  });
  request.addEventListener('load', () => {
    if (request.status < 200 || request.status >= 300) {
      let message = 'Không thể tải tệp lên.';
      try {
        message = JSON.parse(request.responseText).error || message;
      } catch {
        console.error('[Attachments] Invalid upload error response.');
      }
      attachmentUploadActive = false;
      pendingAttachmentFile = null;
      setAttachmentStatus('');
      updateAttachmentButton();
      showToast(message, 'error');
      return;
    }

    setAttachmentStatus('Đang chờ Azure Defender quét mã độc trước khi chia sẻ…');
    send('attachment_send', { ticket: ticket.ticket });
  });
  request.addEventListener('error', () => {
    attachmentUploadActive = false;
    pendingAttachmentFile = null;
    setAttachmentStatus('');
    updateAttachmentButton();
    showToast('Lỗi mạng khi tải tệp lên. Vui lòng thử lại.', 'error');
  });
  request.addEventListener('timeout', () => {
    attachmentUploadActive = false;
    pendingAttachmentFile = null;
    setAttachmentStatus('');
    updateAttachmentButton();
    showToast('Tải tệp quá thời gian chờ. Vui lòng thử lại.', 'error');
  });
  request.send(file);
}

function showLinkSafetyToast(linkSafety) {
  if (!linkSafety || !linkSafety.hasLinks) return;
  showToast(getLinkSafetyMessage(linkSafety), linkSafety.blocked ? 'error' : 'warning', 6500);
}

function getLinkSafetyMessage(linkSafety) {
  if (linkSafety.blocked) {
    return linkSafety.reputation === 'limit_exceeded'
      ? '🚫 Tin nhắn có quá 5 liên kết nên đã bị chặn để tránh bỏ sót URL chưa được kiểm tra.'
      : '🚫 Tin nhắn đã bị chặn vì Google Web Risk nhận diện liên kết có thể chứa lừa đảo hoặc phần mềm độc hại. URL không được gửi cho người nhận.';
  }
  if (linkSafety.reputation === 'unavailable') {
    return '⚠️ Chưa kiểm tra được danh tiếng liên kết do dịch vụ gặp sự cố. Tin nhắn vẫn được gửi; đừng xem đây là xác nhận an toàn.';
  }
  if (linkSafety.reputation === 'clean') {
    const heuristicNote = linkSafety.suspicious ? ` Dấu hiệu cấu trúc: ${linkSafety.reasons.join(' ')}` : '';
    return `ℹ️ Google Web Risk chưa ghi nhận liên kết trong danh sách đe dọa; điều này không đảm bảo an toàn.${heuristicNote}`;
  }
  if (linkSafety.suspicious) {
    return `⚠️ Liên kết có dấu hiệu đáng ngờ: ${linkSafety.reasons.join(' ')} Hệ thống chưa xác minh danh tiếng liên kết.`;
  }
  return '⚠️ Tin nhắn có liên kết. Hệ thống chưa xác minh danh tiếng liên kết; chỉ mở nếu bạn tin người gửi.';
}

/** Thêm thông báo hệ thống */
function addSystemMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'system-message';
  msg.textContent = text;
  el.chatMessages.appendChild(msg);
  scrollToBottom();
}

/** Cuộn xuống cuối khu vực chat */
function scrollToBottom() {
  requestAnimationFrame(() => {
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  });
}

/** Hiển thị/ẩn chỉ báo "đang nhập…" */
function handleTypingIndicator(isTyping) {
  if (isTyping) {
    el.typingIndicator.classList.remove('hidden');
    scrollToBottom();
  } else {
    el.typingIndicator.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════

// ── Sound Toggle ───────────────────────────────────
if (el.btnThemeToggle) {
  el.btnThemeToggle.addEventListener('click', toggleTheme);
}

if (el.btnSoundToggle) {
  el.btnSoundToggle.addEventListener('click', toggleSound);
}

// ── Avatar Selector ────────────────────────────────
if (el.avatarSelector) {
  el.avatarSelector.addEventListener('click', (e) => {
    const chip = e.target.closest('.avatar-chip');
    if (!chip) return;
    const avatar = chip.dataset.avatar;
    if (!avatar) return;

    userAvatar = avatar;
    if (el.userAvatarPreview) {
      el.userAvatarPreview.textContent = avatar;
    }

    el.avatarSelector.querySelectorAll('.avatar-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    syncLiveFrequencyCard();
    playTone(500, 'sine', 0.05, 0.08);
  });
}

if (el.userAvatarPreview && el.avatarSelector) {
  el.userAvatarPreview.addEventListener('click', () => {
    const chips = Array.from(el.avatarSelector.querySelectorAll('.avatar-chip'));
    if (chips.length === 0) return;
    const currentIdx = chips.findIndex((c) => c.classList.contains('active'));
    const nextChip = chips[(currentIdx + 1) % chips.length];
    if (nextChip) nextChip.click();
  });
}

// ── Nút tạo biệt danh ngẫu nhiên ───────────────────
if (el.btnRandomName) {
  el.btnRandomName.addEventListener('click', () => {
    const randomName = generateRandomNickname();
    el.inputNickname.value = randomName;
    syncLiveFrequencyCard();
    el.inputNickname.focus();
    playTone(550, 'triangle', 0.08, 0.08);
  });
}

el.inputNickname.addEventListener('input', syncLiveFrequencyCard);

if (el.moodsContainer) {
  el.moodsContainer.addEventListener('change', () => {
    syncLiveFrequencyCard();
    playTone(480, 'sine', 0.04, 0.06);
  });
}

// ── Nút "Bắt đầu tìm kiếm" ────────────────────────
el.btnStart.addEventListener('click', () => {
  nickname = el.inputNickname.value.trim();
  if (!nickname) {
    showToast('Vui lòng nhập biệt danh của bạn', 'error');
    el.inputNickname.focus();
    return;
  }

  // Lấy tâm trạng đã chọn
  const checkedMood = el.moodsContainer ? el.moodsContainer.querySelector('input[name="mood"]:checked') : null;
  selectedMood = checkedMood ? checkedMood.value : 'ngau_nhien';

  // Lấy sở thích đã chọn
  const checkboxes = el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked');
  interests = Array.from(checkboxes).map((cb) => cb.value);

  // Gửi join + find_match kèm deviceId
  send('join', { nickname, interests, mood: selectedMood, avatar: userAvatar, deviceId: getOrCreateDeviceId() });
  send('find_match');
});

// ── Nút "Tâm sự cùng Lumi (Solo AI)" từ màn hình Login ──
if (el.btnStartSolo) {
  el.btnStartSolo.addEventListener('click', () => {
    nickname = el.inputNickname.value.trim() || generateRandomNickname();
    el.inputNickname.value = nickname;

    const checkedMood = el.moodsContainer ? el.moodsContainer.querySelector('input[name="mood"]:checked') : null;
    selectedMood = checkedMood ? checkedMood.value : 'ngau_nhien';

    const checkboxes = el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked');
    interests = Array.from(checkboxes).map((cb) => cb.value);

    send('join', { nickname, interests, mood: selectedMood, avatar: userAvatar, deviceId: getOrCreateDeviceId() });
    send('start_solo');
  });
}

// ── Nút "Tâm sự cùng Lumi" từ hộp gợi ý trên màn hình Waiting ──
if (el.btnAcceptSolo) {
  el.btnAcceptSolo.addEventListener('click', () => {
    send('start_solo');
  });
}

// ── Enter trên input nickname ───────────────────────
el.inputNickname.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.btnStart.click();
  }
});

// ── Giới hạn số sở thích chọn (tối đa 5) ──────────
el.interestsContainer.addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  const checked = el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked');
  if (checked.length > 5) {
    e.target.checked = false;
    showToast('Chỉ được chọn tối đa 5 sở thích', 'error');
  }
  updateInterestsCounter();
});

// ── Nút "Hủy tìm kiếm" ────────────────────────────
el.btnCancel.addEventListener('click', () => {
  send('cancel');
  switchScreen('login');
});

// ── Che dấu từ tục tĩu phía client cho người gửi ───
function maskProfanityClient(text) {
  if (!text) return text;
  const profanityPattern = /\b(đ[iịkịt]*t|d[iịkịt]*t|d[cç]m|đ[cç]m|vcl|v[cç][l|z]|đ[eẹ]o|d[eẹ]o|clmm|clgt|c[ặaă]c|k[ặaă]c|cac|cu|d[áa]i|b[uồi]+i|l[ồo]n|l[ôồ]n|fuck|bitch|shit)\b/gi;
  return text.replace(profanityPattern, (match) => '*'.repeat(match.length));
}

// ── Gửi tin nhắn ───────────────────────────────────
function sendMessage() {
  const text = el.inputMessage.value.trim();
  if (!text) return;

  // Gửi lên server
  send('message', { text });

  // Hiển thị ở phía mình đã được che dấu sao
  const displayText = maskProfanityClient(text);
  appendMessage(displayText, 'sent', new Date().toISOString());

  // Âm thanh gửi tin
  playTone(400, 'sine', 0.06, 0.06);

  // Xóa input
  el.inputMessage.value = '';
  el.charCurrent.textContent = '0';

  // Reset typing
  sendTypingState(false);

  // Auto-resize
  el.inputMessage.style.height = 'auto';
  el.inputMessage.focus();
  hideMemeSuggestions();
}

el.btnSend.addEventListener('click', sendMessage);

if (el.btnAttachment && el.inputAttachment) {
  el.btnAttachment.addEventListener('click', () => {
    if (!attachmentUploadActive) el.inputAttachment.click();
  });
  el.inputAttachment.addEventListener('change', () => {
    const [file] = el.inputAttachment.files || [];
    requestAttachment(file);
    el.inputAttachment.value = '';
  });
}

el.inputMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Đếm ký tự & auto-resize ────────────────────────
el.inputMessage.addEventListener('input', () => {
  el.charCurrent.textContent = el.inputMessage.value.length;

  el.inputMessage.style.height = 'auto';
  el.inputMessage.style.height = Math.min(el.inputMessage.scrollHeight, 120) + 'px';

  handleLocalTyping();
  checkMemeSuggestions(el.inputMessage.value);
});

// ── Quick Emoji Bar ────────────────────────────────
if (el.quickEmojiList) {
  el.quickEmojiList.addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-emoji-btn');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    if (!emoji) return;

    el.inputMessage.value += emoji;
    el.charCurrent.textContent = el.inputMessage.value.length;
    el.inputMessage.focus();
    playTone(600, 'sine', 0.04, 0.05);
  });
}

// ── Typing indicator (gửi cho đối phương) ──────────
function handleLocalTyping() {
  if (!isTypingSent) {
    sendTypingState(true);
  }

  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    sendTypingState(false);
  }, TYPING_DEBOUNCE);
}

function sendTypingState(isTyping) {
  if (isTypingSent === isTyping) return;
  isTypingSent = isTyping;
  send('typing', { isTyping });
}

// ── Nút "Bỏ qua" (Skip) ───────────────────────────
el.btnSkip.addEventListener('click', () => {
  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  if (el.gamePanel) el.gamePanel.classList.add('hidden');
  if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');
  send('skip');
});

// ── Nút "Rời phòng" quay về trang chủ (Dùng Modal xác nhận) ─────────────
if (el.btnLeaveRoom) {
  // Khi bấm nút Rời phòng -> Mở Modal
  el.btnLeaveRoom.addEventListener('click', () => {
    if (el.modalLeaveConfirm) el.modalLeaveConfirm.classList.remove('hidden');
  });
}

// Bấm nút "Ở lại" -> Đóng Modal
if (el.btnCancelLeave) {
  el.btnCancelLeave.addEventListener('click', () => {
    if (el.modalLeaveConfirm) el.modalLeaveConfirm.classList.add('hidden');
  });
}

// Bấm click ra ngoài vùng nền mờ -> Cũng đóng Modal
if (el.modalLeaveConfirm) {
  const backdrop = el.modalLeaveConfirm.querySelector('.modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      el.modalLeaveConfirm.classList.add('hidden');
    });
  }
}

// Bấm nút "Rời phòng" trên Modal -> Thực hiện thoát phòng
if (el.btnConfirmLeave) {
  el.btnConfirmLeave.addEventListener('click', () => {
    if (el.modalLeaveConfirm) el.modalLeaveConfirm.classList.add('hidden');

    // Gửi tín hiệu rời phòng lên server
    send('leave_room');

    // Dọn dẹp trạng thái chat phía giao diện
    if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
    if (el.gamePanel) el.gamePanel.classList.add('hidden');
    if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');

    // Chuyển màn hình về trang chủ
    switchScreen('login');
    showToast('Đã rời phòng trò chuyện', 'info');
  });
}

// ── Phím tắt Escape → Skip ─────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentScreen === 'chat') {
    e.preventDefault();
    send('skip');
  }
});

// ── Report Modal ────────────────────────────────────
el.btnReport.addEventListener('click', () => {
  el.modalReport.classList.remove('hidden');
  el.inputReportReason.value = '';
  el.inputReportReason.focus();
});

const logoBadge = document.querySelector('.logo-badge');
if (logoBadge) {
  logoBadge.style.cursor = 'pointer';
  logoBadge.addEventListener('click', () => {
    if (currentScreen === 'chat') {
      el.btnLeaveRoom?.click();
    } else if (currentScreen === 'waiting') {
      el.btnCancel?.click();
    }
  });
}

el.btnReportCancel.addEventListener('click', () => {
  el.modalReport.classList.add('hidden');
});

el.modalReport.querySelector('.modal-backdrop').addEventListener('click', () => {
  el.modalReport.classList.add('hidden');
});

el.btnReportSubmit.addEventListener('click', () => {
  const reason = el.inputReportReason.value.trim();
  if (!reason) {
    showToast('Vui lòng nhập lý do báo cáo', 'error');
    return;
  }
  send('report', { reason });
  el.modalReport.classList.add('hidden');
});

// ── Icebreaker (Phá băng) ───────────────────────────
if (el.btnIcebreaker) {
  el.btnIcebreaker.addEventListener('click', () => {
    send('icebreaker');
    playTone(700, 'triangle', 0.1, 0.09);
  });
}

if (el.btnUseIcebreaker) {
  el.btnUseIcebreaker.addEventListener('click', () => {
    const q = el.icebreakerText.textContent.trim();
    if (q) {
      el.inputMessage.value = q;
      el.charCurrent.textContent = q.length;
      el.inputMessage.focus();
      el.icebreakerBanner.classList.add('hidden');
      showToast('Đã chép câu hỏi vào ô chat! Bấm Enter để gửi ✨', 'info', 2000);
    }
  });
}

if (el.btnCloseIcebreaker) {
  el.btnCloseIcebreaker.addEventListener('click', () => {
    el.icebreakerBanner.classList.add('hidden');
  });
}

// ── Partner & Bot Profile Modal ────────────────────
if (el.partnerAvatar) {
  el.partnerAvatar.addEventListener('click', showPartnerProfileModal);
}

if (el.partnerMood) {
  el.partnerMood.addEventListener('click', showPartnerProfileModal);
}

if (el.botBadge) {
  el.botBadge.addEventListener('click', showPartnerProfileModal);
}

if (el.btnClosePartnerInfo) {
  el.btnClosePartnerInfo.addEventListener('click', () => {
    el.modalPartnerInfo.classList.add('hidden');
  });
}

if (el.modalPartnerInfo) {
  const backdrop = el.modalPartnerInfo.querySelector('.modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      el.modalPartnerInfo.classList.add('hidden');
    });
  }
}

// ── Minigame Caro (Hỗ trợ 10x10, 15x15 và 20x20) ────────

if (el.btnMinigame) {
  el.btnMinigame.addEventListener('click', () => {
    send('game_invite', { size: selectedGameSize });
    playGameClickSound();
  });
}


if (el.gameSizeControls) {
  el.gameSizeControls.addEventListener('click', (e) => {
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    const size = parseInt(btn.dataset.size, 10);
    if (!size || size === selectedGameSize) return;

    selectedGameSize = size;
    el.gameSizeControls.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Nếu game đang mở hoặc đã kết thúc, gửi reset với kích thước mới
    send('game_reset', { size: selectedGameSize });
    playGameClickSound();
  });
}

if (el.btnGameAccept) {
  el.btnGameAccept.addEventListener('click', () => {
    el.modalGameInvite.classList.add('hidden');
    send('game_accept', { size: selectedGameSize });
    playGameClickSound();
  });
}

if (el.btnGameDecline) {
  el.btnGameDecline.addEventListener('click', () => {
    el.modalGameInvite.classList.add('hidden');
  });
}

if (el.btnCloseGame) {
  el.btnCloseGame.addEventListener('click', () => {
    el.gamePanel.classList.add('hidden');
    send('game_quit');
  });
}

if (el.tictactoeBoard) {
  el.tictactoeBoard.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || cell.disabled) return;
    const index = parseInt(cell.dataset.index, 10);
    if (!isNaN(index)) {
      send('game_move', { index });
      playGameClickSound();
    }
  });
}

if (el.btnGameReplay) {
  el.btnGameReplay.addEventListener('click', () => {
    send('game_reset', { size: selectedGameSize });
    playGameClickSound();
  });
}

// ── Kicked Modal ───────────────────────────────────
if (el.btnKickedOk) {
  el.btnKickedOk.addEventListener('click', () => {
    el.modalKicked.classList.add('hidden');
    switchScreen('login');
  });
}

// ── Nút Thử lại kết nối ngay ───────────────────────
if (el.btnReconnectNow) {
  el.btnReconnectNow.addEventListener('click', () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (reconnectCountdownTimer) {
      clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
    if (el.reconnectDesc) {
      el.reconnectDesc.textContent = 'Đang thử kết nối lại ngay lập tức…';
    }
    connect();
  });
}

// ═══════════════════════════════════════════════════
// TÍNH NĂNG 1: GHI ÂM TIN NHẮN THOẠI (VOICE MESSAGE)
// Bấm để nói hoặc Giữ để nói (Push-to-Talk)
// ═══════════════════════════════════════════════════

let mediaRecorder = null;
let recordedAudioChunks = [];
let recordingTimerInterval = null;
let recordingSeconds = 0;
let isRecordingActive = false;
let isHoldRecording = false;
let holdTimeout = null;
let audioStream = null;

async function startVoiceRecording(isHold = false) {
  if (isRecordingActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Trình duyệt của bạn không hỗ trợ ghi âm trực tiếp.', 'error');
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.warn('[Voice] getUserMedia error:', err);
    showToast('⚠️ Vui lòng cấp quyền truy cập micro để gửi tin nhắn thoại!', 'warning');
    return;
  }

  recordedAudioChunks = [];
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => {
    return window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t);
  }) || '';

  try {
    mediaRecorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
  } catch (err) {
    mediaRecorder = new MediaRecorder(audioStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedAudioChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = () => {
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
      audioStream = null;
    }
  };

  mediaRecorder.start(100);
  isRecordingActive = true;
  isHoldRecording = isHold;
  recordingSeconds = 0;

  if (el.voiceRecordingBar) {
    el.voiceRecordingBar.classList.remove('hidden');
    if (el.voiceRecTimer) el.voiceRecTimer.textContent = '00:00';
    if (el.voiceRecHint) {
      el.voiceRecHint.textContent = isHold ? 'Đang giữ để nói… (thả để gửi)' : 'Đang ghi âm… (bấm Gửi khi xong)';
    }
  }

  playTone(550, 'sine', 0.05, 0.05);

  clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(() => {
    recordingSeconds += 1;
    const mins = Math.floor(recordingSeconds / 60).toString().padStart(2, '0');
    const secs = (recordingSeconds % 60).toString().padStart(2, '0');
    if (el.voiceRecTimer) el.voiceRecTimer.textContent = `${mins}:${secs}`;

    // Tối đa 120s tự động dừng và gửi
    if (recordingSeconds >= 120) {
      stopVoiceRecordingAndSend();
    }
  }, 1000);
}

function cancelVoiceRecording() {
  if (!isRecordingActive) return;
  clearInterval(recordingTimerInterval);
  isRecordingActive = false;
  isHoldRecording = false;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  recordedAudioChunks = [];

  if (el.voiceRecordingBar) {
    el.voiceRecordingBar.classList.add('hidden');
  }
  showToast('Đã hủy đoạn ghi âm.', 'info');
}

async function stopVoiceRecordingAndSend() {
  if (!isRecordingActive) return;
  clearInterval(recordingTimerInterval);
  const duration = Math.max(1, recordingSeconds);
  isRecordingActive = false;
  isHoldRecording = false;

  if (el.voiceRecordingBar) {
    el.voiceRecordingBar.classList.add('hidden');
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (duration < 1 && recordedAudioChunks.length === 0) {
    showToast('Đoạn ghi âm quá ngắn.', 'warning');
    return;
  }

  // Chờ chunk cuối cùng hoàn tất
  await new Promise((r) => setTimeout(r, 120));

  const audioBlob = new Blob(recordedAudioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
  if (audioBlob.size === 0) {
    showToast('Không có dữ liệu âm thanh.', 'warning');
    return;
  }

  try {
    const response = await fetch('/api/voice/upload', {
      method: 'POST',
      headers: {
        'Content-Type': audioBlob.type || 'audio/webm',
      },
      body: audioBlob,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.ok || !data.voiceId) {
      throw new Error(data.error || 'Upload voice thất bại');
    }

    // Gửi qua WebSocket
    send('voice', {
      voiceId: data.voiceId,
      url: data.url,
      duration,
    });

    // Hiển thị ở phía mình
    appendVoiceMessage({
      voiceId: data.voiceId,
      url: data.url,
      duration,
    }, 'sent', new Date().toISOString());

    playTone(600, 'sine', 0.06, 0.06);
  } catch (err) {
    console.error('[Voice] Upload error:', err);
    showToast('Không thể gửi tin nhắn thoại. Vui lòng thử lại!', 'error');
  }
}

// Gắn sự kiện cho nút Micro (Push-to-Talk & Click-to-Talk)
if (el.btnVoice) {
  let touchStartY = 0;
  let isHoldTriggered = false;

  el.btnVoice.addEventListener('click', () => {
    if (isHoldTriggered) {
      isHoldTriggered = false;
      return;
    }
    if (isRecordingActive) {
      stopVoiceRecordingAndSend();
    } else {
      startVoiceRecording(false);
    }
  });

  // Giữ chuột để nói trên máy tính (Desktop)
  el.btnVoice.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isHoldTriggered = false;
    holdTimeout = setTimeout(() => {
      isHoldTriggered = true;
      startVoiceRecording(true);
    }, 320);
  });

  window.addEventListener('mouseup', () => {
    clearTimeout(holdTimeout);
    if (isHoldRecording && isRecordingActive) {
      stopVoiceRecordingAndSend();
    }
  });

  // Bấm giữ trên màn hình cảm ứng điện thoại (Mobile Touch)
  el.btnVoice.addEventListener('touchstart', (e) => {
    isHoldTriggered = false;
    touchStartY = e.touches[0].clientY;
    holdTimeout = setTimeout(() => {
      isHoldTriggered = true;
      startVoiceRecording(true);
    }, 320);
  }, { passive: true });

  el.btnVoice.addEventListener('touchmove', (e) => {
    if (!isHoldRecording) return;
    const currentY = e.touches[0].clientY;
    // Trượt ngón tay lên hơn 60px để hủy
    if (touchStartY - currentY > 60) {
      cancelVoiceRecording();
    }
  }, { passive: true });

  el.btnVoice.addEventListener('touchend', () => {
    clearTimeout(holdTimeout);
    if (isHoldRecording && isRecordingActive) {
      stopVoiceRecordingAndSend();
    }
  });

  if (el.btnVoiceCancel) {
    el.btnVoiceCancel.addEventListener('click', cancelVoiceRecording);
  }
  if (el.btnVoiceSend) {
    el.btnVoiceSend.addEventListener('click', stopVoiceRecordingAndSend);
  }
}


// ═══════════════════════════════════════════════════
// TÍNH NĂNG 2: BIỂU TƯỢNG CẢM XÚC IPHONE EMOJI PICKER
// Phân loại chuẩn iOS: Thường dùng, Mặt cười, Động vật,
// Đồ ăn, Hoạt động, Đồ vật & Biểu tượng
// ═══════════════════════════════════════════════════

const IPHONE_EMOJIS = {
  recent: JSON.parse(localStorage.getItem('chatmatch_recent_emojis') || 'null') || [
    '❤️', '😂', '👍', '🔥', '🥰', '🥺', '✨', '🎉', '😭', '🤣', '🙏', '💖', '🥳', '👏', '☕', '🎮', '🌸', '💯'
  ],
  smileys: [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
    '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨',
    '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
    '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '😟',
    '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖',
    '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '💀', '☠️', '💩', '🤡', '👻', '👽', '🤖'
  ],
  animals: [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
    '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞',
    '🐜', '🦟', '🐢', '🐍', '🦎', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋',
    '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🌸',
    '🌺', '🌻', '🌹', '🌷', '🌼', '🍀', '🌿', '🍁', '🍂', '🌈', '☀️', '🌙', '☁️', '❄️', '⭐'
  ],
  food: [
    '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥',
    '🥝', '🍅', '🥑', '🥦', '🌽', '🌶️', '🍞', '🥐', '🥖', '🥨', '🥯', '🧀', '🍳', '🥞', '🧇', '🥓',
    '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🌮', '🌯', '🥗', '🥘', '🍜', '🍝', '🍣', '🍱',
    '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🍫', '🍬', '🍭', '☕', '🍵', '🧋', '🥤', '🍺', '🍻', '🥂', '🍷'
  ],
  activity: [
    '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🥊', '🥋',
    '⛸️', '🛹', '🛼', '⛷️', '🏂', '🏋️', '🤺', '🏇', '🧗', '🏆', '🥇', '🥈', '🥉', '🎯', '🎮', '🎲',
    '🧩', '🎨', '🎭', '🎪', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸'
  ],
  objects: [
    '💡', '📱', '💻', '⌨️', '📷', '🎥', '📺', '📻', '⏰', '🧭', '💎', '🎁', '🎈', '💌', '💖', '💔',
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '💢', '💥', '💫', '💬', '💭', '🗯️', '🎵',
    '🎶', '🔔', '📢', '🚀', '✈️', '🚗', '🚲', '🏠', '🔥', '✨', '⚡', '⚠️', '🚫', '⛔', '❌', '⭕', '❓', '❗'
  ],
};

let currentEmojiCategory = 'recent';

/** Bỏ dấu tiếng Việt để tìm kiếm linh hoạt cả có dấu lẫn không dấu */
function stripVietnameseTones(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd');
}

/** Từ điển ánh xạ từ khóa tìm kiếm cho Emoji iOS */
const EMOJI_SEARCH_TAGS = [
  { emojis: ['😂', '🤣', '😆', '😄', '😃', '😀', '😅', '😹', '😸', '😁', '🥳', '😎'], tags: ['cuoi', 'cười', 'laugh', 'haha', 'vui', 'hai', 'hài', 'funny', 'hihi', 'lol', 'kaka'] },
  { emojis: ['❤️', '💖', '💕', '💓', '💗', '💘', '💝', '💞', '💟', '🥰', '😍', '😘', '😻', '💋'], tags: ['tim', 'heart', 'yeu', 'yêu', 'love', 'iu', 'thuong', 'thương', 'hon', 'hôn', 'kiss'] },
  { emojis: ['😭', '😢', '🥺', '😿', '😥', '😰', '💔', '😞', '😔', '🙁', '☹️', '😩', '😫'], tags: ['khoc', 'khóc', 'cry', 'sad', 'buon', 'buồn', 'sau', 'sầu', 'dau', 'đau', 'huhu'] },
  { emojis: ['😡', '😠', '🤬', '😤', '👿', '💢'], tags: ['gian', 'giận', 'tuc', 'tức', 'angry', 'mad', 'dien', 'điên', 'chui', 'bực', 'doi', 'dỗi'] },
  { emojis: ['😲', '😮', '🤯', '😱', '😳', '🙀', '😯', '😦', '😧'], tags: ['soc', 'sốc', 'shock', 'omg', 'ngac nhien', 'ngạc nhiên', 'wow', 'troi oi', 'trời ơi', 'ulatr'] },
  { emojis: ['😴', '😪', '🤤', '🥱', '💤', '🌙'], tags: ['ngu', 'ngủ', 'sleep', 'met', 'mệt', 'tired', 'buon ngu', 'buồn ngủ', 'g9', 'kho', 'khò'] },
  { emojis: ['👍', '👌', '👏', '🤝', '🙌', '✌️', '🤙', '💪', '💯', '✔️', '✅'], tags: ['like', 'thich', 'thích', 'ok', 'oke', 'tuyet', 'tuyệt', 'dinh', 'đỉnh', 'good', 'chot', 'chốt'] },
  { emojis: ['🐶', '🐕', '🦮', '🐩'], tags: ['cho', 'chó', 'dog', 'cun', 'cún', 'gau'] },
  { emojis: ['🐱', '🐈', '🐈‍⬛', '😸', '😹', '😻'], tags: ['meo', 'mèo', 'cat', 'meow', 'miu'] },
  { emojis: ['🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🥩', '🍗', '🍜', '🍣', '🍱'], tags: ['an', 'ăn', 'food', 'com', 'cơm', 'doi', 'đói', 'mi', 'mì', 'them', 'thèm'] },
  { emojis: ['☕', '🍵', '🧋', '🥤', '🍺', '🍻', '🥂', '🍷'], tags: ['uong', 'uống', 'drink', 'tra', 'trà', 'cafe', 'cà phê', 'tra sua', 'trà sữa', 'bia', 'ruou', 'rượu'] },
  { emojis: ['🔥', '✨', '⚡', '🌟', '⭐', '☀️', '🌙', '☁️', '❄️', '🌈'], tags: ['lua', 'lửa', 'fire', 'chay', 'cháy', 'sao', 'star', 'nang', 'nắng', 'mua', 'mưa', 'may', 'mây', 'troi', 'trời'] },
  { emojis: ['🎮', '🎲', '🎯', '🏆', '🥇', '⚽', '🏀', '🎾'], tags: ['game', 'choi', 'chơi', 'bong', 'bóng', 'the thao', 'thể thao', 'sport'] },
  { emojis: ['👋', '🙋', '🏃', '✈️', '💨'], tags: ['chao', 'chào', 'hello', 'hi', 'tam biet', 'tạm biệt', 'bye', 'bai'] },
  { emojis: ['🙏', '💖', '🥰', '💐', '🌹', '✨'], tags: ['cam on', 'cảm ơn', 'thanks', 'thank you', 'biet on'] },
];

function renderEmojiPicker(category = currentEmojiCategory, filterQuery = '') {
  if (!el.emojiGridContainer) return;
  el.emojiGridContainer.innerHTML = '';

  const cleanQuery = filterQuery.trim().toLowerCase();
  const strippedQuery = stripVietnameseTones(cleanQuery);
  let list = [];

  if (strippedQuery) {
    // 1. Tìm kiếm theo tags thông minh (hỗ trợ cả tiếng Việt có dấu, không dấu và tiếng Anh)
    const matchedEmojis = new Set();
    EMOJI_SEARCH_TAGS.forEach((group) => {
      const match = group.tags.some((tag) => {
        const strippedTag = stripVietnameseTones(tag.toLowerCase());
        return strippedTag.includes(strippedQuery) || strippedQuery.includes(strippedTag);
      });
      if (match) {
        group.emojis.forEach((em) => matchedEmojis.add(em));
      }
    });

    if (matchedEmojis.size > 0) {
      list = Array.from(matchedEmojis);
    } else {
      // 2. Fallback: tìm trực tiếp ký tự emoji
      const all = [
        ...IPHONE_EMOJIS.smileys,
        ...IPHONE_EMOJIS.animals,
        ...IPHONE_EMOJIS.food,
        ...IPHONE_EMOJIS.activity,
        ...IPHONE_EMOJIS.objects,
      ];
      list = all.filter((e) => e.includes(cleanQuery));
      if (list.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'empty-search-msg';
        emptyMsg.style.cssText = 'padding: 24px 12px; text-align: center; color: var(--text-muted); font-size: 0.84rem; width: 100%;';
        emptyMsg.textContent = `Không tìm thấy emoji nào cho "${filterQuery}"`;
        el.emojiGridContainer.appendChild(emptyMsg);
        return;
      }
    }
  } else {
    list = IPHONE_EMOJIS[category] || IPHONE_EMOJIS.recent;
  }

  const grid = document.createElement('div');
  grid.className = 'emoji-grid';

  list.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-item-btn';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', emoji);

    btn.addEventListener('click', () => {
      insertEmojiAtCursor(emoji);
      saveRecentEmoji(emoji);
      playTone(620, 'sine', 0.03, 0.04);
    });

    grid.appendChild(btn);
  });

  el.emojiGridContainer.appendChild(grid);
}

function insertEmojiAtCursor(emoji) {
  const textarea = el.inputMessage;
  if (!textarea) return;

  const start = textarea.selectionStart || textarea.value.length;
  const end = textarea.selectionEnd || textarea.value.length;
  const text = textarea.value;

  textarea.value = text.slice(0, start) + emoji + text.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
  el.charCurrent.textContent = textarea.value.length;
  textarea.focus();

  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  handleLocalTyping();
}

function saveRecentEmoji(emoji) {
  let recent = IPHONE_EMOJIS.recent.filter((e) => e !== emoji);
  recent.unshift(emoji);
  if (recent.length > 24) recent = recent.slice(0, 24);
  IPHONE_EMOJIS.recent = recent;
  try {
    localStorage.setItem('chatmatch_recent_emojis', JSON.stringify(recent));
  } catch {}
}

// ═══════════════════════════════════════════════════
// TÍNH NĂNG 2B: KHO NHÃN DÁN (STICKER PACKS)
// Trích xuất trực tiếp nhãn dán Douyin và Animated WebP trong suốt
// ═══════════════════════════════════════════════════

const STICKER_PACKS = {
  douyin: {
    id: 'douyin',
    name: '🟡 Douyin Classic',
    stickers: [
      { id: 'dy_weixiao', title: 'Mỉm cười', url: '/assets/stickers/douyin/weixiao.png' },
      { id: 'dy_xiaoku', title: 'Cười ra nước mắt', url: '/assets/stickers/douyin/xiaoku.png' },
      { id: 'dy_daxiao', title: 'Cười lớn', url: '/assets/stickers/douyin/daxiao.png' },
      { id: 'dy_aixinshou', title: 'Bắn tim', url: '/assets/stickers/douyin/aixinshou.png' },
      { id: 'dy_kiss', title: 'Hôn gió', url: '/assets/stickers/douyin/kiss.png' },
      { id: 'dy_iloveyou', title: 'I Love You', url: '/assets/stickers/douyin/iloveyou.png' },
      { id: 'dy_aimu', title: 'Mê mẩn', url: '/assets/stickers/douyin/aimu.png' },
      { id: 'dy_haixiu', title: 'E thẹn', url: '/assets/stickers/douyin/haixiu.png' },
      { id: 'dy_666', title: '666 Đỉnh chóp', url: '/assets/stickers/douyin/666.png' },
      { id: 'dy_zan', title: 'Tán thành (Like)', url: '/assets/stickers/douyin/zan.png' },
      { id: 'dy_xiaoguzhang', title: 'Vỗ tay tán thưởng', url: '/assets/stickers/douyin/xiaoguzhang.png' },
      { id: 'dy_zhuangku', title: 'Giả ngầu đeo kính', url: '/assets/stickers/douyin/zhuangku.png' },
      { id: 'dy_baiyan', title: 'Liếc mắt coi thường', url: '/assets/stickers/douyin/baiyan.png' },
      { id: 'dy_huaixiao', title: 'Cười nham hiểm', url: '/assets/stickers/douyin/huaixiao.png' },
      { id: 'dy_goutou', title: 'Doge cười gian', url: '/assets/stickers/douyin/goutouhuaixiao.png' },
      { id: 'dy_touxiao', title: 'Cười trộm', url: '/assets/stickers/douyin/touxiao.png' },
      { id: 'dy_daku', title: 'Khóc lớn', url: '/assets/stickers/douyin/daku.png' },
      { id: 'dy_kuku', title: 'Khóc thảm thiết', url: '/assets/stickers/douyin/kuku.png' },
      { id: 'dy_kuaikule', title: 'Sắp khóc rồi', url: '/assets/stickers/douyin/kuaikule.png' },
      { id: 'dy_kelian', title: 'Đáng thương rơm rớm', url: '/assets/stickers/douyin/kelian.png' },
      { id: 'dy_fennu', title: 'Phẫn nộ', url: '/assets/stickers/douyin/fennu.png' },
      { id: 'dy_zhuakuang', title: 'Cào cấu phát điên', url: '/assets/stickers/douyin/zhuakuang.png' },
      { id: 'dy_jingkong', title: 'Kinh hoàng', url: '/assets/stickers/douyin/jingkong.png' },
      { id: 'dy_What', title: 'What? Cái gì?', url: '/assets/stickers/douyin/What.png' },
      { id: 'dy_wulian', title: 'Che mặt bất lực', url: '/assets/stickers/douyin/wulian.png' },
      { id: 'dy_koubi', title: 'Ngoáy mũi', url: '/assets/stickers/douyin/koubi.png' },
      { id: 'dy_anzhong', title: 'Ẩn nấp quan sát', url: '/assets/stickers/douyin/anzhongguancha.png' },
      { id: 'dy_baibai', title: 'Bái bai vẫy tay', url: '/assets/stickers/douyin/baibai.png' },
    ],
  },
  cats: {
    id: 'cats',
    name: '🐱 Mèo Viral',
    stickers: [
      { id: 'cat_jamming', title: 'Mèo quẩy EDM', url: 'https://media.giphy.com/media/jpbnoe3UIa8TU8LM13/giphy.gif' },
      { id: 'cat_pop', title: 'Popcat mở mồm pop pop', url: 'https://media.giphy.com/media/vQqeT3AYg8S5O/giphy.gif' },
      { id: 'cat_banana', title: 'Banana Cat khóc huhu', url: 'https://media.giphy.com/media/ISOckXUybVfQ4/giphy.gif' },
      { id: 'cat_cry', title: 'Mèo mắt ngấn lệ', url: 'https://media.giphy.com/media/L95W4wv8nnb9K/giphy.gif' },
      { id: 'cat_bongo', title: 'Bongo Cat gõ phím', url: 'https://media.giphy.com/media/3ELtfmA4Apkju/giphy.gif' },
      { id: 'cat_heart', title: 'Mèo ôm tim cưng xỉu', url: 'https://media.giphy.com/media/uw0KpagtwEJtC/giphy.gif' },
      { id: 'cat_kiss', title: 'Mèo thơm má moa moa', url: 'https://media.giphy.com/media/l4pTdcifPZLpDjL1e/giphy.gif' },
      { id: 'cat_thumbs', title: 'Mèo giơ ngón like', url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
      { id: 'cat_sleep', title: 'Mèo đắp chăn ngủ say', url: 'https://media.giphy.com/media/mguPrVJAnEHIY/giphy.gif' },
      { id: 'cat_eat', title: 'Mèo ăn nhồm nhoàm', url: 'https://media.giphy.com/media/3oEdva9BUHPIs2SkGk/giphy.gif' },
      { id: 'cat_drool', title: 'Mèo thèm chảy dãi', url: 'https://media.giphy.com/media/12uXi1GXBibALC/giphy.gif' },
      { id: 'cat_bye', title: 'Mèo vẫy tay chào', url: 'https://media.giphy.com/media/Nx0rz3jtxt99A4IpYn/giphy.gif' },
    ],
  },
  pandas: {
    id: 'pandas',
    name: '🐼 Gấu Trúc Douyin Bựa',
    stickers: [
      { id: 'panda_clap', title: 'Gấu trúc vỗ tay', url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
      { id: 'panda_toast', title: 'Leonardo nâng ly chúc mừng', url: 'https://media.giphy.com/media/GCLlQnV7Ej7Pj8z57M/giphy.gif' },
      { id: 'gigachad', title: 'Gigachad cười tự tin', url: 'https://media.giphy.com/media/CAYVZA5NRb529kKQUc/giphy.gif' },
      { id: 'panda_shy', title: 'Hải cẩu ngại ngùng', url: 'https://media.giphy.com/media/eHpWHuEUxHIre/giphy.gif' },
      { id: 'cat_pout', title: 'Dỗi quay lưng', url: 'https://media.giphy.com/media/OPU6wzx8JrHna/giphy.gif' },
      { id: 'angry_cat', title: 'Giận tím người', url: 'https://media.giphy.com/media/MDJ9IbxxvDUQM/giphy.gif' },
    ],
  },
  pepe: {
    id: 'pepe',
    name: '🐸 Pepe & Động Vật Viral',
    stickers: [
      { id: 'pepe_cry', title: 'Pepe khóc ướt gối', url: 'https://media.giphy.com/media/OPU6wzx8JrHna/giphy.gif' },
      { id: 'doge_laugh', title: 'Doge cười sảng khoái', url: 'https://media.giphy.com/media/oBQZIgNobc7EWBSYJS/giphy.gif' },
      { id: 'doge_side', title: 'Doge ánh nhìn phán xét', url: 'https://media.giphy.com/media/H5C8CevNMbpBqNqFjl/giphy.gif' },
      { id: 'doge_sleep', title: 'Doge khò khò ngon giấc', url: 'https://media.giphy.com/media/14udF3WUwwGMaA/giphy.gif' },
      { id: 'mind_blown', title: 'Nổ não ảo ma', url: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif' },
      { id: 'coffin', title: 'Vũ điệu khiêng quan tài', url: 'https://media.giphy.com/media/Wr2747CnxwBSqyK6xt/giphy.gif' },
    ],
  },
};

const TIKTOK_STICKER_PACKS = STICKER_PACKS;

let currentPickerMode = 'emoji'; // 'emoji' | 'stickers'
let currentStickerPack = 'douyin';

function setPickerMode(mode) {
  currentPickerMode = mode;
  if (mode === 'stickers') {
    el.tabPickerEmoji?.classList.remove('active');
    el.tabPickerStickers?.classList.add('active');
    el.pickerEmojiView?.classList.add('hidden');
    el.pickerStickerView?.classList.remove('hidden');
    renderStickerPicker(currentStickerPack);
  } else {
    el.tabPickerStickers?.classList.remove('active');
    el.tabPickerEmoji?.classList.add('active');
    el.pickerStickerView?.classList.add('hidden');
    el.pickerEmojiView?.classList.remove('hidden');
    renderEmojiPicker(currentEmojiCategory);
    if (el.inputEmojiSearch) el.inputEmojiSearch.focus();
  }
}

function renderStickerPicker(packKey = currentStickerPack) {
  if (!el.stickerGridContainer) return;
  const pack = STICKER_PACKS[packKey] || STICKER_PACKS.douyin;
  currentStickerPack = packKey;

  if (el.stickerCurrentPackTitle) {
    el.stickerCurrentPackTitle.textContent = pack.name;
  }

  el.stickerGridContainer.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'sticker-grid';

  pack.stickers.forEach((sticker) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-item-btn';
    btn.title = `Nhấn để gửi nhãn dán "${sticker.title}"`;
    btn.setAttribute('aria-label', sticker.title);

    const img = document.createElement('img');
    img.src = sticker.url;
    img.alt = sticker.title;
    img.loading = 'lazy';

    btn.appendChild(img);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendSticker(sticker.url, sticker.title, sticker.id);
    });

    grid.appendChild(btn);
  });

  el.stickerGridContainer.appendChild(grid);
}

function sendSticker(url, title, stickerId) {
  if (currentScreen !== 'chat') return;

  // Gửi qua WebSocket với cờ isSticker = true
  send('meme', {
    url,
    title,
    memeId: stickerId,
    isSticker: true,
  });

  // Render trực tiếp phía người gửi dạng Sticker Bubble trong suốt
  appendStickerMessage(url, title, 'sent', new Date().toISOString());

  // Âm thanh gửi
  playTone(560, 'sine', 0.05, 0.06);

  // Ẩn bảng chọn
  if (el.emojiPickerPopover) {
    el.emojiPickerPopover.classList.add('hidden');
  }

  el.inputMessage?.focus();
}

// Bật/tắt Tab Biểu tượng vs Nhãn dán
if (el.tabPickerEmoji) {
  el.tabPickerEmoji.addEventListener('click', (e) => {
    e.stopPropagation();
    setPickerMode('emoji');
  });
}
if (el.tabPickerStickers) {
  el.tabPickerStickers.addEventListener('click', (e) => {
    e.stopPropagation();
    setPickerMode('stickers');
  });
}

// Nút mở khay Emoji
if (el.btnEmojiToggle && el.emojiPickerPopover) {
  el.btnEmojiToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = el.emojiPickerPopover.classList.contains('hidden');
    if (isHidden) {
      el.emojiPickerPopover.classList.remove('hidden');
      setPickerMode('emoji');
    } else {
      if (currentPickerMode === 'emoji') {
        el.emojiPickerPopover.classList.add('hidden');
      } else {
        setPickerMode('emoji');
      }
    }
  });
}

// Nút mở khay Nhãn dán
if (el.btnStickerToggle && el.emojiPickerPopover) {
  el.btnStickerToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = el.emojiPickerPopover.classList.contains('hidden');
    if (isHidden) {
      el.emojiPickerPopover.classList.remove('hidden');
      setPickerMode('stickers');
    } else {
      if (currentPickerMode === 'stickers') {
        el.emojiPickerPopover.classList.add('hidden');
      } else {
        setPickerMode('stickers');
      }
    }
  });
}

if (el.btnCloseEmojiPicker) {
  el.btnCloseEmojiPicker.addEventListener('click', () => {
    el.emojiPickerPopover.classList.add('hidden');
  });
}

if (el.emojiCategoryTabs) {
  el.emojiCategoryTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.emoji-tab-btn');
    if (!tab) return;
    const cat = tab.dataset.cat;
    if (!cat) return;

    currentEmojiCategory = cat;
    el.emojiCategoryTabs.querySelectorAll('.emoji-tab-btn').forEach((b) => b.classList.remove('active'));
    tab.classList.add('active');

    if (el.inputEmojiSearch) el.inputEmojiSearch.value = '';
    renderEmojiPicker(currentEmojiCategory);
  });
}

if (el.stickerPackTabs) {
  el.stickerPackTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.sticker-pack-tab-btn');
    if (!tab) return;
    const pack = tab.dataset.pack;
    if (!pack) return;

    el.stickerPackTabs.querySelectorAll('.sticker-pack-tab-btn').forEach((b) => b.classList.remove('active'));
    tab.classList.add('active');
    renderStickerPicker(pack);
  });
}

if (el.inputEmojiSearch) {
  el.inputEmojiSearch.addEventListener('input', () => {
    renderEmojiPicker(currentEmojiCategory, el.inputEmojiSearch.value);
  });
}

// Bấm click ra ngoài khay emoji / sticker để đóng
document.addEventListener('click', (e) => {
  if (el.emojiPickerPopover && !el.emojiPickerPopover.classList.contains('hidden')) {
    const isClickInside = el.emojiPickerPopover.contains(e.target);
    const isClickEmojiBtn = el.btnEmojiToggle && el.btnEmojiToggle.contains(e.target);
    const isClickStickerBtn = el.btnStickerToggle && el.btnStickerToggle.contains(e.target);
    if (!isClickInside && !isClickEmojiBtn && !isClickStickerBtn) {
      el.emojiPickerPopover.classList.add('hidden');
    }
  }
});


// ═══════════════════════════════════════════════════
// TÍNH NĂNG 3: GỢI Ý NHÃN DÁN THEO TỪ KHÓA
// (Phong cách Zalo, Telegram & Messenger)
// ═══════════════════════════════════════════════════

const STICKER_DICTIONARY = [
  {
    name: 'haha',
    keywords: ['haha', 'hahaha', 'cuoi', 'cười', 'buon cuoi', 'buồn cười', 'lol', 'lmao', 'kaka', 'kkk', 'kkkk', 'hai', 'hài', 'vui', 'khoai', 'khoái'],
    repeatPattern: /^(ha|ka|he)+$/i,
    emojis: ['😂', '🤣', '😆', '😹', '😸', '🤪', '😁', '😀'],
    stickers: [
      { id: 'dy_xiaoku', title: 'Cười ra nước mắt', url: '/assets/stickers/douyin/xiaoku.png' },
      { id: 'dy_daxiao', title: 'Cười lớn', url: '/assets/stickers/douyin/daxiao.png' },
      { id: 'cat_jamming', title: 'Mèo quẩy EDM', url: 'https://media.giphy.com/media/jpbnoe3UIa8TU8LM13/giphy.gif' },
      { id: 'cat_laugh', title: 'Mèo cười rung rốn', url: 'https://media.giphy.com/media/mlvseq9yvZhba/giphy.gif' },
    ],
  },
  {
    name: 'shock',
    keywords: ['u la troi', 'u là trời', 'ulatr', 'troi oi', 'trời ơi', 'vai', 'vãi', 'omg', 'soc', 'sốc', 'bat ngo', 'bất ngờ', 'ao', 'ảo', 'ao ma', 'ảo ma', 'ảo thật đấy', 'cai gi', 'cái gì', 'wow'],
    repeatPattern: null,
    emojis: ['😱', '🤯', '😲', '😮', '😳', '🙀', '😯'],
    stickers: [
      { id: 'dy_What', title: 'What? Cái gì?', url: '/assets/stickers/douyin/What.png' },
      { id: 'dy_jingkong', title: 'Kinh hoàng', url: '/assets/stickers/douyin/jingkong.png' },
      { id: 'cat_pop', title: 'Popcat mở mồm', url: 'https://media.giphy.com/media/vQqeT3AYg8S5O/giphy.gif' },
      { id: 'mind_blown', title: 'Nổ não ảo ma', url: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif' },
    ],
  },
  {
    name: 'sad',
    keywords: ['khoc', 'khóc', 'hu hu', 'huhu', 'huhuhu', 'sad', 'sau', 'sầu', 'buon', 'buồn', 'tram cam', 'trầm cảm', 'toan', 'toang'],
    repeatPattern: /^hu+$/i,
    emojis: ['😭', '😢', '🥺', '😿', '💔', '😞', '😥', '😩'],
    stickers: [
      { id: 'dy_daku', title: 'Khóc lớn', url: '/assets/stickers/douyin/daku.png' },
      { id: 'dy_kuku', title: 'Khóc thảm thiết', url: '/assets/stickers/douyin/kuku.png' },
      { id: 'cat_banana', title: 'Banana Cat khóc', url: 'https://media.giphy.com/media/ISOckXUybVfQ4/giphy.gif' },
      { id: 'pepe_cry', title: 'Pepe khóc ướt gối', url: 'https://media.giphy.com/media/OPU6wzx8JrHna/giphy.gif' },
    ],
  },
  {
    name: 'love',
    keywords: ['yeu', 'yêu', 'iu', 'thuong', 'thương', 'tym', 'tim', 'tha tim', 'thả tim', 'ban tim', 'bắn tim', 'moa', 'hon', 'hôn', 'love'],
    repeatPattern: null,
    emojis: ['❤️', '💖', '🥰', '😍', '😘', '💕', '💋', '😻'],
    stickers: [
      { id: 'dy_aixinshou', title: 'Bắn tim Douyin', url: '/assets/stickers/douyin/aixinshou.png' },
      { id: 'dy_kiss', title: 'Hôn gió', url: '/assets/stickers/douyin/kiss.png' },
      { id: 'dy_iloveyou', title: 'I Love You', url: '/assets/stickers/douyin/iloveyou.png' },
      { id: 'cat_heart', title: 'Mèo ôm tim cute', url: 'https://media.giphy.com/media/uw0KpagtwEJtC/giphy.gif' },
    ],
  },
  {
    name: 'ok',
    keywords: ['ok', 'oke', 'duoc', 'được', 'chot', 'chốt', 'nhat tri', 'nhất trí', 'duyet', 'duyệt', 'dinh', 'đỉnh', 'like', 'hay', 'tuyet', 'tuyệt', 'dinh cao', 'đỉnh cao'],
    repeatPattern: null,
    emojis: ['👍', '👌', '👏', '💯', '🔥', '🤝', '😎', '✅'],
    stickers: [
      { id: 'dy_666', title: '666 Đỉnh chóp', url: '/assets/stickers/douyin/666.png' },
      { id: 'dy_zan', title: 'Tán thành Like', url: '/assets/stickers/douyin/zan.png' },
      { id: 'dy_xiaoguzhang', title: 'Vỗ tay tán thưởng', url: '/assets/stickers/douyin/xiaoguzhang.png' },
      { id: 'panda_clap', title: 'Gấu trúc vỗ tay', url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
    ],
  },
  {
    name: 'angry',
    keywords: ['doi', 'dỗi', 'hon', 'hờn', 'gian', 'giận', 'bat den', 'bắt đền', 'doi roi', 'dỗi rồi', 'nghi choi', 'nghỉ chơi', 'tuc', 'tức'],
    repeatPattern: null,
    emojis: ['😤', '😡', '😠', '🙄', '😒', '🤐', '👿'],
    stickers: [
      { id: 'dy_fennu', title: 'Phẫn nộ', url: '/assets/stickers/douyin/fennu.png' },
      { id: 'dy_zhuakuang', title: 'Cào cấu phát điên', url: '/assets/stickers/douyin/zhuakuang.png' },
      { id: 'cat_pout', title: 'Mèo dỗi quay lưng', url: 'https://media.giphy.com/media/OPU6wzx8JrHna/giphy.gif' },
      { id: 'angry_cat', title: 'Giận tím người', url: 'https://media.giphy.com/media/MDJ9IbxxvDUQM/giphy.gif' },
    ],
  },
  {
    name: 'sleep',
    keywords: ['ngu', 'ngủ', 'ngu day', 'ngủ đây', 'g9', 'kho', 'khò', 'buon ngu', 'buồn ngủ', 'met', 'mệt', 'ngu thoi', 'ngủ thôi', 'good night'],
    repeatPattern: null,
    emojis: ['😴', '😪', '🥱', '🤤', '💤', '🌙', '🛌'],
    stickers: [
      { id: 'cat_sleep', title: 'Mèo đắp chăn ngủ say', url: 'https://media.giphy.com/media/mguPrVJAnEHIY/giphy.gif' },
      { id: 'doge_sleep', title: 'Doge khò khò ngon lành', url: 'https://media.giphy.com/media/14udF3WUwwGMaA/giphy.gif' },
    ],
  },
  {
    name: 'eat',
    keywords: ['doi', 'đói', 'an gi', 'ăn gì', 'them', 'thèm', 'mlem', 'an com', 'ăn cơm', 'doi bung', 'đói bụng', 'an uong', 'ăn uống'],
    repeatPattern: null,
    emojis: ['🤤', '🍔', '🍟', '🍕', '🍜', '😋', '🍣', '🥩'],
    stickers: [
      { id: 'cat_eat', title: 'Mèo ăn nhồm nhoàm', url: 'https://media.giphy.com/media/3oEdva9BUHPIs2SkGk/giphy.gif' },
      { id: 'cat_drool', title: 'Chảy nước miếng', url: 'https://media.giphy.com/media/12uXi1GXBibALC/giphy.gif' },
    ],
  },
  {
    name: 'bye',
    keywords: ['tam biet', 'tạm biệt', 'bye', 'bai', 'goodbye', 'bai bai', 'bye bye', 'cut', 'cút', 'vinh biet', 'vĩnh biệt', 'rip'],
    repeatPattern: null,
    emojis: ['👋', '🙋', '🏃', '✈️', '💨', '🚶', '🫡'],
    stickers: [
      { id: 'dy_baibai', title: 'Bái bai vẫy tay', url: '/assets/stickers/douyin/baibai.png' },
      { id: 'cat_bye', title: 'Mèo vẫy tay chào', url: 'https://media.giphy.com/media/Nx0rz3jtxt99A4IpYn/giphy.gif' },
      { id: 'coffin', title: 'Tiễn biệt cụ', url: 'https://media.giphy.com/media/Wr2747CnxwBSqyK6xt/giphy.gif' },
    ],
  },
  {
    name: 'shy',
    keywords: ['ngai', 'ngại', 'xau ho', 'xấu hổ', 'nguong', 'ngượng', 'do mat', 'đỏ mặt', 'hihi', 'hihihi'],
    repeatPattern: /^hi+$/i,
    emojis: ['😳', '🙈', '👉👈', '🥺', '☺️', '🌸', '🫣'],
    stickers: [
      { id: 'dy_haixiu', title: 'E thẹn đỏ mặt', url: '/assets/stickers/douyin/haixiu.png' },
      { id: 'dy_wulian', title: 'Lấy tay che mặt', url: '/assets/stickers/douyin/wulian.png' },
      { id: 'panda_shy', title: 'Hải cẩu đỏ mặt', url: 'https://media.giphy.com/media/eHpWHuEUxHIre/giphy.gif' },
    ],
  },
  {
    name: 'judge',
    keywords: ['che', 'chê', 'che nha', 'chê nha', 'lac dau', 'lắc đầu', 'bo di', 'bỏ đi', 'thoi xong', 'thôi xong', 'lieu lieu', 'liêu liêu'],
    repeatPattern: null,
    emojis: ['😒', '🙄', '👀', '👎', '🤦', '🤷', '🤨'],
    stickers: [
      { id: 'dy_baiyan', title: 'Liếc mắt coi thường', url: '/assets/stickers/douyin/baiyan.png' },
      { id: 'dy_koubi', title: 'Ngoáy mũi', url: '/assets/stickers/douyin/koubi.png' },
      { id: 'doge_side', title: 'Ánh nhìn phán xét', url: 'https://media.giphy.com/media/H5C8CevNMbpBqNqFjl/giphy.gif' },
    ],
  },
  {
    name: 'hello',
    keywords: ['chao', 'chào', 'hello', 'hi', 'xin chao', 'xin chào', 'helo', 'halo'],
    repeatPattern: null,
    emojis: ['👋', '✨', '😃', '🤝', '🥰', '🌸'],
    stickers: [
      { id: 'dy_weixiao', title: 'Mỉm cười chào', url: '/assets/stickers/douyin/weixiao.png' },
      { id: 'dy_baibai', title: 'Vẫy tay chào', url: '/assets/stickers/douyin/baibai.png' },
      { id: 'cat_bye', title: 'Mèo vẫy tay chào', url: 'https://media.giphy.com/media/Nx0rz3jtxt99A4IpYn/giphy.gif' },
    ],
  },
  {
    name: 'thanks',
    keywords: ['cam on', 'cảm ơn', 'thanks', 'thank you', 'cmon', 'iu qua', 'iu quá'],
    repeatPattern: null,
    emojis: ['🙏', '💖', '🥰', '💐', '🌹', '✨'],
    stickers: [
      { id: 'dy_aimu', title: 'Ái mộ biết ơn', url: '/assets/stickers/douyin/aimu.png' },
      { id: 'dy_xiaoguzhang', title: 'Vỗ tay tán thưởng', url: '/assets/stickers/douyin/xiaoguzhang.png' },
      { id: 'cat_heart', title: 'Cảm ơn đáng yêu', url: 'https://media.giphy.com/media/uw0KpagtwEJtC/giphy.gif' },
    ],
  },
];

const TIKTOK_MEME_DICTIONARY = STICKER_DICTIONARY;

let lastMatchedMemeWord = '';

function checkMemeSuggestions(text) {
  if (!el.memeSuggestionsBar || !el.memeSuggestionsList) return;
  if (!text || typeof text !== 'string') {
    hideMemeSuggestions();
    return;
  }

  const raw = text.trim();
  if (!raw) {
    hideMemeSuggestions();
    return;
  }

  const rawLower = raw.toLowerCase();
  const stripped = stripVietnameseTones(rawLower);

  // Lấy từ cuối cùng đang gõ (hoặc từ duy nhất)
  const words = raw.split(/\s+/);
  const lastWord = words[words.length - 1] || '';
  const lastWordLower = lastWord.toLowerCase();
  const strippedLastWord = stripVietnameseTones(lastWordLower);

  let matchedGroup = null;
  let matchedKeyword = '';

  // 1. Ưu tiên kiểm tra từ cuối cùng theo pattern lặp âm (ví dụ: hahaha, kakaka, huhuhu, hihihi, kkkk)
  if (lastWord.length >= 2) {
    if (/^k{2,}$/i.test(lastWordLower)) {
      matchedGroup = STICKER_DICTIONARY.find((g) => g.name === 'haha');
      matchedKeyword = lastWord;
    } else {
      for (const group of STICKER_DICTIONARY) {
        if (group.repeatPattern && group.repeatPattern.test(strippedLastWord)) {
          matchedGroup = group;
          matchedKeyword = lastWord;
          break;
        }
      }
    }
  }

  // 2. Kiểm tra từ cuối cùng có trùng trực tiếp với từ khóa không
  if (!matchedGroup && lastWord.length >= 2) {
    for (const group of STICKER_DICTIONARY) {
      for (const kw of group.keywords) {
        const kwLower = kw.toLowerCase();
        const kwStripped = stripVietnameseTones(kwLower);
        if (kwLower === lastWordLower || kwStripped === strippedLastWord) {
          matchedGroup = group;
          matchedKeyword = kw;
          break;
        }
      }
      if (matchedGroup) break;
    }
  }

  // 3. Nếu chưa khớp, quét cụm từ khóa (cả có dấu và không dấu) trong toàn câu
  if (!matchedGroup) {
    for (const group of STICKER_DICTIONARY) {
      for (const kw of group.keywords) {
        const kwLower = kw.toLowerCase();
        const kwStripped = stripVietnameseTones(kwLower);

        const escapedKw = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex1 = new RegExp(`(^|\\s)${escapedKw}($|\\s|[!?,.])`, 'i');

        const escapedStripped = kwStripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex2 = new RegExp(`(^|\\s)${escapedStripped}($|\\s|[!?,.])`, 'i');

        if (regex1.test(rawLower) || regex2.test(stripped)) {
          matchedGroup = group;
          matchedKeyword = kw;
          break;
        }
      }
      if (matchedGroup) break;
    }
  }

  if (!matchedGroup) {
    hideMemeSuggestions();
    return;
  }

  const stickerList = matchedGroup.stickers || [];
  if (stickerList.length === 0) {
    hideMemeSuggestions();
    return;
  }

  lastMatchedMemeWord = matchedKeyword;
  if (el.memeKeywordHighlight) {
    el.memeKeywordHighlight.textContent = `"${matchedKeyword}"`;
  }

  // Render danh sách NHÃN DÁN tương ứng theo từ khóa
  el.memeSuggestionsList.innerHTML = '';
  stickerList.forEach((st) => {
    const card = document.createElement('div');
    card.className = 'meme-suggestion-card';
    card.title = `Nhấn để gửi nhãn dán "${st.title}"`;

    const img = document.createElement('img');
    img.src = st.url;
    img.alt = st.title;
    img.loading = 'lazy';

    const pill = document.createElement('span');
    pill.className = 'meme-card-title';
    pill.textContent = st.title;

    card.appendChild(img);
    card.appendChild(pill);

    card.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendSticker(st.url, st.title, st.id);

      // Xóa từ khóa kích hoạt khỏi ô nhập nếu cần
      if (el.inputMessage && lastMatchedMemeWord) {
        const current = el.inputMessage.value;
        const escaped = lastMatchedMemeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|\\s)${escaped}($|\\s|[!?,.])`, 'i');
        el.inputMessage.value = current.replace(regex, ' ').trim();
        el.charCurrent.textContent = el.inputMessage.value.length;
        el.inputMessage.style.height = 'auto';
      }

      hideMemeSuggestions();
    });

    el.memeSuggestionsList.appendChild(card);
  });

  el.memeSuggestionsBar.classList.remove('hidden');
}

function hideMemeSuggestions() {
  if (el.memeSuggestionsBar) {
    el.memeSuggestionsBar.classList.add('hidden');
  }
}

function sendMeme(url, title, memeId) {
  if (currentScreen !== 'chat') return;

  // Gửi qua WebSocket
  send('meme', { url, title, memeId, isSticker: false });

  // Render phía người gửi
  appendMemeMessage(url, title, 'sent', new Date().toISOString());

  // Âm thanh gửi
  playTone(500, 'sine', 0.05, 0.06);

  // Xóa từ khóa kích hoạt khỏi ô nhập hoặc làm sạch ô nhập nếu chỉ chứa từ đó
  if (el.inputMessage && lastMatchedMemeWord) {
    const current = el.inputMessage.value;
    const escaped = lastMatchedMemeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|\\s)${escaped}($|\\s|[!?,.])`, 'i');
    el.inputMessage.value = current.replace(regex, ' ').trim();
    el.charCurrent.textContent = el.inputMessage.value.length;
    el.inputMessage.style.height = 'auto';
  }

  hideMemeSuggestions();
  el.inputMessage?.focus();
}

if (el.btnCloseMemeSuggestions) {
  el.btnCloseMemeSuggestions.addEventListener('click', hideMemeSuggestions);
}

// ═══════════════════════════════════════════════════
// Khởi tạo
// ═══════════════════════════════════════════════════

initTheme();
initSound();
updateInterestsCounter();
connect();
