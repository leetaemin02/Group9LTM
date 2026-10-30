/**
 * script.js – Client-side logic & UI Controller
 *
 * Module này:
 *   1. Quản lý kết nối WebSocket (tự động kết nối lại – exponential backoff).
 *   2. Xử lý giao diện người dùng (3 màn hình: Login/Lobby, Waiting, Chat).
 *   3. Gửi/nhận message theo giao thức JSON { type, payload }.
 *   4. Quản lý âm thanh hiệu ứng (Web Audio API).
 *   5. Tạo biệt danh ngẫu nhiên, chọn avatar, gợi ý phá băng, minigame Caro 3x3.
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
  btnSkip: $('#btn-skip'),
  btnReport: $('#btn-report'),
  charCurrent: $('#char-current'),

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
  btnGameAccept: $('#btn-game-accept'),
  btnGameDecline: $('#btn-game-decline'),

  // Kicked Modal
  modalKicked: $('#modal-kicked'),
  kickedReason: $('#kicked-reason'),
  btnKickedOk: $('#btn-kicked-ok'),

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
  vui_ve: '☀️ Vui vẻ, tích cực',
  tim_ban_game: '🎮 Tìm bạn game',
  hoc_tap: '📚 Cùng học tập',
  chan_nan: '🌧️ Cần lắng nghe'
};

const WAITING_TIPS = [
  "Mẹo: Chọn sở thích giúp cơ hội tìm thấy người cùng đam mê tăng 80%!",
  "Hãy bắt đầu câu chuyện bằng một lời chào ấm áp hoặc lời khen thân thiện 👋",
  "Dùng nút '🎲 Phá băng' khi bạn chưa biết bắt đầu từ chủ đề nào!",
  "Thách đấu '🎮 Caro 1-1' là cách tuyệt vời nhất để xua tan không khí ngượng ngùng!",
  "Tôn trọng lẫn nhau là quy tắc số 1 để xây dựng tình bạn đẹp ✨",
  "Phím tắt Escape giúp bạn nhanh chóng bỏ qua và chuyển sang người tiếp theo ⏭️",
  "Nếu phòng vắng, bạn luôn có thể tâm sự và chơi cờ cùng Trợ lý Lumi 🤖"
];

let ws = null;
let clientId = null;
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
  } catch (e) {}
}

/** Âm báo tin nhắn đến (Pop) */
function playMessageSound() {
  if (!soundEnabled) return;
  try {
    playTone(880, 'sine', 0.09, 0.1);
    setTimeout(() => playTone(1174.66, 'sine', 0.12, 0.08), 50);
  } catch (e) {}
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

    // Nếu đã có nickname (reconnect) → re-join
    if (nickname) {
      send('join', { nickname, interests, mood: selectedMood, avatar: userAvatar, deviceId: getOrCreateDeviceId() });

      if (currentScreen === 'waiting') {
        console.log('[WS] Reconnected while waiting -> re-enqueueing find_match');
        send('find_match');
        showToast('Đã khôi phục hàng đợi tìm kiếm', 'info');
      } else if (currentScreen === 'chat') {
        showToast('Kết nối đã được khôi phục. Phiên trò chuyện trước đã kết thúc.', 'info');
        switchScreen('login');
      }
    }
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
  const loggedPayload = type === 'attachment_upload'
    ? { ...payload, ticket: '[redacted]' }
    : ['attachment', 'attachment_sent'].includes(type)
      ? { ...payload, attachment: { ...payload.attachment, url: '[redacted]' } }
      : payload;
  console.log(`[WS] ← ${type}`, loggedPayload);

  switch (type) {
    case 'connected':
      clientId = payload.clientId;
      el.onlineNumber.textContent = payload.onlineCount;
      break;

    case 'waiting':
      // Không chuyển về màn hình waiting nếu đã vào màn hình chat
      if (currentScreen !== 'chat') {
        switchScreen('waiting');
      }
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
      if (payload.code && payload.code.startsWith('ATTACHMENT_')) {
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
        el.partnerMoodText.textContent = payload.partnerMood || 'Lắng nghe & thấu hiểu';
      }
      el.partnerMood.classList.remove('hidden');
    }
    el.commonInterests.textContent = 'Trợ lý Đồng hành lắng nghe & giải trí 24/7';
    if (el.btnSkip) {
      el.btnSkip.innerHTML = '<span class="action-icon">👥</span> Tìm người thật <kbd class="kbd-hint">Esc</kbd>';
      el.btnSkip.title = 'Chuyển sang hàng đợi tìm bạn chat người thật (Phím tắt: Esc)';
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
      el.commonInterests.textContent = `🎯 Chung sở thích: ${payload.commonInterests.join(', ')}`;
    } else {
      el.commonInterests.textContent = '✨ Ghép ngẫu nhiên cùng tâm trạng';
    }

    if (el.btnSkip) {
      el.btnSkip.innerHTML = '<span class="action-icon">⏭️</span> Bỏ qua <kbd class="kbd-hint">Esc</kbd>';
      el.btnSkip.title = 'Bỏ qua và tìm người mới (Phím tắt: Esc)';
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
    addSystemMessage('✨ Đã kết nối cùng Lumi! Bạn có thể thoải mái tâm sự hoặc bấm "🎮 Caro 1-1" để cùng chơi cờ giải trí nhé!');
  } else {
    addSystemMessage(`🎉 Đã kết nối với ${payload.partnerNickname}! Hãy gửi lời chào mở đầu câu chuyện nào 👋`);
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
    if (el.modalProfileName) el.modalProfileName.textContent = 'Lumi (AI Companion)';
    if (el.modalProfileMoodPill) el.modalProfileMoodPill.textContent = '✨ Lắng nghe & thấu hiểu';
    if (el.modalProfileDesc) {
      el.modalProfileDesc.textContent = 'Lumi là người bạn đồng hành ảo thông minh được tích hợp sẵn, luôn túc trực 24/7 để lắng nghe mọi tâm tư, chia sẻ niềm vui nỗi buồn và cùng bạn chơi cờ Caro giải trí bất cứ lúc nào!';
    }
    if (el.modalProfileInterests) {
      el.modalProfileInterests.innerHTML = `
        <span class="profile-interest-tag">💬 Tâm sự ấm áp</span>
        <span class="profile-interest-tag">🎮 Cao thủ cờ Caro</span>
        <span class="profile-interest-tag">💡 Lời khuyên tích cực</span>
        <span class="profile-interest-tag">🛡️ Không phán xét</span>
      `;
    }
  } else {
    if (el.modalProfileAvatar) el.modalProfileAvatar.textContent = currentPartner.avatar || '👤';
    if (el.modalProfileName) el.modalProfileName.textContent = currentPartner.nickname || 'Bạn chat';
    const moodLabel = MOOD_NAMES[currentPartner.mood] || currentPartner.mood || 'Tùy duyên';
    if (el.modalProfileMoodPill) el.modalProfileMoodPill.textContent = `Tâm trạng: ${moodLabel}`;
    if (el.modalProfileDesc) {
      el.modalProfileDesc.textContent = `Người bạn ẩn danh này đang có trạng thái "${moodLabel}". Hãy tôn trọng và cùng nhau tạo nên một buổi trò chuyện thú vị nhé!`;
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
        el.modalProfileInterests.innerHTML = '<span class="profile-interest-tag">Tự do khám phá</span>';
      }
    }
  }

  el.modalPartnerInfo.classList.remove('hidden');
  playTone(550, 'sine', 0.04, 0.06);
}

/** Xử lý khi đối phương rời phòng */
function handlePartnerLeft() {
  addSystemMessage('Đối phương đã rời phòng chat.');
  showToast('Đối phương đã rời phòng', 'info');

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
  addSystemMessage(`🎲 Gợi ý phá băng (${payload.category}): "${payload.question}"`);
}

/** Xử lý nhận lời mời chơi game */
function handleGameInvite(payload) {
  if (!el.modalGameInvite) return;
  el.gameInviterName.textContent = payload.from || 'Đối phương';
  el.modalGameInvite.classList.remove('hidden');
  playMatchSound();
}

/** Cập nhật bàn cờ Caro (Hỗ trợ 10x10, 8x8, 3x3) */
function handleGameState(payload) {
  if (!payload) return;

  // 1. Nhận lời mời chơi game
  if (payload.action === 'invite') {
    if (el.modalGameInvite) {
      el.gameInviterName.textContent = payload.fromName || 'Đối phương';
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
  const winLength = game.winLength || (boardSize >= 10 ? 5 : (boardSize >= 7 ? 4 : 3));
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
      el.gameStatusText.textContent = `👉 Lượt của BẠN (${myGameSymbol})`;
      el.gameStatusText.style.color = 'var(--success)';
    } else {
      const partnerSymbol = myGameSymbol === 'X' ? 'O' : 'X';
      el.gameStatusText.textContent = `⏳ Lượt đối phương (${partnerSymbol})`;
      el.gameStatusText.style.color = 'var(--text-muted)';
    }
    el.btnGameReplay.classList.add('hidden');
  } else if (game.status === 'ended') {
    if (game.winner === 'draw') {
      el.gameStatusText.textContent = '🤝 Kết quả: Hòa cờ!';
      el.gameStatusText.style.color = 'var(--warning)';
    } else if (game.winner === myGameSymbol) {
      el.gameStatusText.textContent = `🎉 BẠN ĐÃ THẮNG! (${game.winner})`;
      el.gameStatusText.style.color = 'var(--success)';
      playMatchSound();
    } else {
      el.gameStatusText.textContent = `😢 Bạn thua rồi! (${game.winner} thắng)`;
      el.gameStatusText.style.color = 'var(--danger)';
    }
    el.btnGameReplay.classList.remove('hidden');
  }
}

/** Xử lý khi bị KICK do vi phạm từ ngữ khiếm nhã */
function handleKicked(payload) {
  if (el.kickedReason) {
    el.kickedReason.textContent = payload.reason || 'Hệ thống phát hiện bạn sử dụng ngôn từ khiếm nhã, thô tục hoặc vi phạm tiêu chuẩn cộng đồng.';
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
    playTone(500, 'sine', 0.05, 0.08);
  });
}

// ── Nút tạo biệt danh ngẫu nhiên ───────────────────
if (el.btnRandomName) {
  el.btnRandomName.addEventListener('click', () => {
    const randomName = generateRandomNickname();
    el.inputNickname.value = randomName;
    el.inputNickname.focus();
    playTone(550, 'triangle', 0.08, 0.08);
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

// ── Gửi tin nhắn ───────────────────────────────────
function sendMessage() {
  const text = el.inputMessage.value.trim();
  if (!text) return;

  // Gửi lên server
  send('message', { text });

  // Hiển thị ở phía mình
  appendMessage(text, 'sent', new Date().toISOString());

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
  send('skip');
});

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

// ── Minigame Caro (Hỗ trợ 10x10, 8x8, 3x3) ────────
if (el.btnMinigame) {
  el.btnMinigame.addEventListener('click', () => {
    send('game_invite', { size: selectedGameSize });
    showToast(`Đã gửi lời mời cờ Caro (${selectedGameSize}x${selectedGameSize}) tới đối phương!`, 'info');
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
// Khởi tạo
// ═══════════════════════════════════════════════════

initTheme();
initSound();
updateInterestsCounter();
connect();
