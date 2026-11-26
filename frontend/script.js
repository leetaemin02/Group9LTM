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

const MESSAGE_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:\/[^\s<>"']*)?/giu;

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
  btnOpenGroupHub: $('#btn-open-group-hub'),
  savedGroupsBadge: $('#saved-groups-badge'),
  btnOpenGameHub: $('#btn-open-game-hub'),

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
  groupCapacityPill: $('#group-capacity-pill'),
  groupCapacityText: $('#group-capacity-text'),
  groupKeepPill: $('#group-keep-pill'),
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
  btnGroupKeep: $('#btn-group-keep'),
  btnGroupKeepLabel: $('#btn-group-keep-label'),
  btnGroupMembers: $('#btn-group-members'),
  btnGroupMembersLabel: $('#btn-group-members-label'),
  btnGroupSwitch: $('#btn-group-switch'),

  // Group Side Panel
  groupPanel: $('#group-panel'),
  groupPanelCapacity: $('#group-panel-capacity'),
  btnCloseGroupPanel: $('#btn-close-group-panel'),
  groupKeepCard: $('#group-keep-card'),
  groupPanelKeepBadge: $('#group-panel-keep-badge'),
  groupKeepProgressFill: $('#group-keep-progress-fill'),
  groupPanelKeepDesc: $('#group-panel-keep-desc'),
  btnPanelVoteKeep: $('#btn-panel-vote-keep'),
  groupPanelTags: $('#group-panel-tags'),
  inputGroupMemberSearch: $('#input-group-member-search'),
  groupMembersList: $('#group-members-list'),

  // Group Hub Modal
  modalGroupHub: $('#modal-group-hub'),
  btnCloseGroupHub: $('#btn-close-group-hub'),
  groupHubTabs: $('#group-hub-tabs'),
  tabSavedCount: $('#tab-saved-count'),
  groupTabQuick: $('#group-tab-quick'),
  groupTabBrowse: $('#group-tab-browse'),
  groupTabSaved: $('#group-tab-saved'),
  groupQuickInterestsPreview: $('#group-quick-interests-preview'),
  inputGroupTopic: $('#input-group-topic'),
  groupTopicPresets: $('#group-topic-presets'),
  btnGroupJoinTopic: $('#btn-group-join-topic'),
  btnGroupCreateTopic: $('#btn-group-create-topic'),
  btnGroupJoinRandom: $('#btn-group-join-random'),
  groupBrowseFilters: $('#group-browse-filters'),
  inputGroupBrowseSearch: $('#input-group-browse-search'),
  btnRefreshGroupList: $('#btn-refresh-group-list'),
  groupBrowseList: $('#group-browse-list'),
  groupSavedList: $('#group-saved-list'),

  // @Mention Popover
  mentionPopover: $('#mention-popover'),
  btnCloseMentionPopover: $('#btn-close-mention-popover'),
  mentionPopoverList: $('#mention-popover-list'),

  // Multiplayer Game Hub Modal
  modalGameHub: $('#modal-game-hub'),
  btnCloseGameHub: $('#btn-close-game-hub'),
  gameHubTabs: $('#game-hub-tabs'),
  gameHubTabPlay: $('#game-hub-tab-play'),
  gameHubTabBrowse: $('#game-hub-tab-browse'),
  gameCatalogGrid: $('#game-catalog-grid'),
  inputGameRoomName: $('#input-game-room-name'),
  selectGameMaxPlayers: $('#select-game-max-players'),
  btnGameRoomQuick: $('#btn-game-room-quick'),
  btnGameRoomCreate: $('#btn-game-room-create'),
  inputGameRoomCode: $('#input-game-room-code'),
  btnGameRoomJoinCode: $('#btn-game-room-join-code'),
  gameBrowseFilters: $('#game-browse-filters'),
  btnRefreshGameRooms: $('#btn-refresh-game-rooms'),
  gameRoomBrowseList: $('#game-room-browse-list'),

  // Multiplayer Game Arena Panel (dùng chung cho Phòng Game & Game nhúng trong 1-1 / Lumi / Nhóm)
  multiGamePanel: $('#multi-game-panel'),
  multiGameIcon: $('#multi-game-icon'),
  multiGameTitle: $('#multi-game-title'),
  btnCopyGameCode: $('#btn-copy-game-code'),
  multiGameCode: $('#multi-game-code'),
  multiGameModeBadge: $('#multi-game-mode-badge'),
  multiGameCountPill: $('#multi-game-count-pill'),
  multiGameTimerPill: $('#multi-game-timer-pill'),
  btnMultiGameSeat: $('#btn-multi-game-seat'),
  btnMultiGameStart: $('#btn-multi-game-start'),
  btnMultiGameLobby: $('#btn-multi-game-lobby'),
  btnMultiGameClose: $('#btn-multi-game-close'),
  multiGameSwitcher: $('#multi-game-switcher'),
  multiGamePlayersStrip: $('#multi-game-players-strip'),
  multiGameArenaBody: $('#multi-game-arena-body'),

  // Giữ kết nối ẩn danh 2 chiều & Mã hẹn gặp lại (Chat 1-1)
  btnOpenPairHub: $('#btn-open-pair-hub'),
  savedPairsBadge: $('#saved-pairs-badge'),
  pairCodePill: $('#pair-code-pill'),
  pairCodePillText: $('#pair-code-pill-text'),
  btnPairKeep: $('#btn-pair-keep'),
  btnPairKeepLabel: $('#btn-pair-keep-label'),
  modalPairHub: $('#modal-pair-hub'),
  btnClosePairHub: $('#btn-close-pair-hub'),
  inputPairCode: $('#input-pair-code'),
  btnPairJoinCode: $('#btn-pair-join-code'),
  btnRefreshPairList: $('#btn-refresh-pair-list'),
  pairSavedList: $('#pair-saved-list'),
  modalPairInvite: $('#modal-pair-invite'),
  pairInviteAvatar: $('#pair-invite-avatar'),
  pairInviteName: $('#pair-invite-name'),
  pairInviteDesc: $('#pair-invite-desc'),
  btnPairInviteDecline: $('#btn-pair-invite-decline'),
  btnPairInviteAccept: $('#btn-pair-invite-accept'),
  modalPairWaiting: $('#modal-pair-waiting'),
  pairWaitAvatar: $('#pair-wait-avatar'),
  pairWaitTitle: $('#pair-wait-title'),
  pairWaitDesc: $('#pair-wait-desc'),
  btnCopyWaitPairCode: $('#btn-copy-wait-pair-code'),
  pairWaitCodeText: $('#pair-wait-code-text'),
  pairWaitHistoryPreview: $('#pair-wait-history-preview'),
  btnPairCancelWait: $('#btn-pair-cancel-wait'),

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
  btnMinigameLabel: $('#btn-minigame-label'),
  gamePanel: $('#game-panel'),
  gameStatusText: $('#game-status-text'),
  gameRuleHint: $('#game-rule-hint'),
  gameSizeControls: $('#game-size-controls'),
  btnCloseGame: $('#btn-close-game'),
  tictactoeBoard: $('#tictactoe-board'),
  btnGameReplay: $('#btn-game-replay'),

  // Game Invite & Minigame Picker Modals
  modalGameInvite: $('#modal-game-invite'),
  gameInviteIcon: $('#game-invite-icon'),
  gameInviteTitle: $('#game-invite-title'),
  gameInviterName: $('#game-inviter-name'),
  gameInviteDescription: $('#game-invite-description'),
  btnGameAccept: $('#btn-game-accept'),
  btnGameDecline: $('#btn-game-decline'),
  modalMinigamePicker: $('#modal-minigame-picker'),
  btnCloseMinigamePicker: $('#btn-close-minigame-picker'),
  minigamePickerDesc: $('#minigame-picker-desc'),
  minigamePickerGrid: $('#minigame-picker-grid'),
  pickerCaroSub: $('#picker-caro-sub'),
  pickerCardUndercover: $('#picker-card-undercover'),
  pickerUndercoverSub: $('#picker-undercover-sub'),

  // Kicked Modal
  modalKicked: $('#modal-kicked'),
  kickedReason: $('#kicked-reason'),
  btnKickedOk: $('#btn-kicked-ok'),
  modalLeaveConfirm: $('#modal-leave-confirm'),
  leaveModalTitle: $('#leave-modal-title'),
  leaveModalDesc: $('#leave-modal-desc'),
  leaveModalGroupNote: $('#leave-modal-group-note'),
  btnCancelLeave: $('#btn-cancel-leave'),
  btnKeepAndLeave: $('#btn-keep-and-leave'),
  btnConfirmLeave: $('#btn-confirm-leave'),

  // Report Modal
  modalReport: $('#modal-report'),
  reportModalDesc: $('#report-modal-desc'),
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
let invitedGameType = 'caro';
let embeddedGame = null;
let embeddedGamePlayers = [];
let embeddedGameMinimized = false;
let isCurrentPartnerBot = false;

// Giữ kết nối 1-1 State
const SAVED_PAIRS_STORAGE_KEY = 'chatmatch_saved_pairs_v1';
let currentPairKeep = null;
let savedPairsLive = [];
let incomingPairInvite = null;
let activePairWaiting = null;
let currentPartner = {
  nickname: '',
  mood: '',
  interests: [],
  avatar: '👤',
  isBot: false
};

// Group Chat State
const SAVED_GROUPS_KEY = 'chatmatch_kept_groups';
const MAX_CHAT_DOM_NODES = 300;
const GROUP_SENDER_COLORS = [
  '#ff7a59', '#2dd4bf', '#60a5fa', '#f472b6', '#fbbf24',
  '#a78bfa', '#34d399', '#fb923c', '#38bdf8', '#c084fc',
];
let isGroupMode = false;
let currentGroup = null;
let groupMembers = [];
let groupTypingUsers = new Map(); // clientId -> { nickname, timer }
let groupBrowseMode = 'all';
let savedGroupsLive = [];
let reportTargetClientId = null;
let reportTargetNickname = '';
let pendingKeepAndLeave = false;

// Multiplayer Game Room & @Mention State
let isGameRoomMode = false;
let currentGameRoom = null;
let gameRoomPlayers = [];
let selectedHubGameType = 'quiz_race';
let gameBrowseFilter = 'all';
let myPrivateGameSecret = null;
let secretWordHidden = false;
let myQuizSelection = null;
let myUndercoverVote = null;
let multiGameCountdownTimer = null;

let mentionOpen = false;
let mentionCandidates = [];
let mentionActiveIndex = 0;
let mentionStartPos = -1;

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
function showToast(message, type = 'info', duration = 3500, source = null) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  if (source === 'google_safe_browsing') appendSafeBrowsingAttribution(toast);
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
    if (typeof hideMentionPopover === 'function') hideMentionPopover();
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

// Phát hiện khi trình duyệt mất kết nối mạng
window.addEventListener('offline', () => {
  console.warn('[Network] Mất kết nối mạng');

  updateConnectionStatus('disconnected');

  if (el.reconnectOverlay) {
    el.reconnectOverlay.classList.remove('hidden');
  }

  if (el.reconnectDesc) {
    el.reconnectDesc.textContent =
      'Mất kết nối Internet. Đang chờ mạng khôi phục...';
  }

  // Đóng WebSocket để kích hoạt cơ chế Resume Session hiện có
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
});

// Phát hiện khi Internet hoạt động trở lại
window.addEventListener('online', () => {
  console.log('[Network] Đã có kết nối mạng trở lại');

  if (ws &&
      (ws.readyState === WebSocket.OPEN ||
       ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Sử dụng nút reconnect có sẵn để hủy timer cũ
  // và kết nối lại ngay
  if (el.btnReconnectNow) {
    el.btnReconnectNow.click();
  } else if (!reconnectTimer) {
    connect();
  }
});

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

      // Nếu đang ở phòng 1-1 người thật và còn token, thử resume
      if (
        currentScreen === 'chat' &&
        !isGroupMode &&
        !isGameRoomMode &&
        !isCurrentPartnerBot &&
        token &&
        /^[0-9a-f]{64}$/.test(token)
      ) {
        resumePending = true;

        console.log('[Resume] Đang yêu cầu khôi phục phòng...');
        send('resume_session', { token });
        break;
      }

      // Không có phiên 1-1 để khôi phục:
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
        } else if (currentScreen === 'chat' && isGroupMode && currentGroup) {
          const savedPass = loadSavedGroupPasses().find((p) => p.groupId === currentGroup.groupId);
          if (savedPass && savedPass.rejoinToken) {
            send('group_rejoin', { groupId: savedPass.groupId, rejoinToken: savedPass.rejoinToken });
            showToast('Đang kết nối lại vào nhóm đã giữ…', 'info');
          } else {
            send('group_join', { groupId: currentGroup.groupId });
          }
        } else if (currentScreen === 'chat' && isGameRoomMode && currentGameRoom) {
          send('game_room_join', { roomId: currentGameRoom.roomId });
        } else if (currentScreen === 'chat') {
          // Phòng Lumi hoặc không còn token khôi phục
          sessionStorage.removeItem(RESUME_TOKEN_KEY);
          showToast('Phiên trò chuyện trước đã kết thúc.', 'info');
          switchScreen('login');
        }
      }

      syncSavedGroupsWithServer();
      syncSavedPairsWithServer();
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
      } else if (attachmentUploadActive && (
        (payload.code && payload.code.startsWith('ATTACHMENT_'))
        || payload.code === 'RATE_LIMITED'
        || payload.code === 'INVALID_PAYLOAD'
        || payload.code === 'BANNED'
        || payload.code === 'REDIS_UNAVAILABLE'
        || payload.code === 'DEVICE_ID_REQUIRED'
        || payload.code === 'NOT_IN_ROOM'
      )) {
        attachmentUploadActive = false;
        pendingAttachmentFile = null;
        setAttachmentStatus('');
        updateAttachmentButton();
        showToast(payload.message, payload.code === 'RATE_LIMITED' ? 'warning' : 'error');
      } else if (payload.code && payload.code.startsWith('ATTACHMENT_')) {
        attachmentUploadActive = false;
        pendingAttachmentFile = null;
        setAttachmentStatus('');
        updateAttachmentButton();
        showToast(payload.message, 'error');
      } else if (payload.code === 'SKIP_COOLDOWN') {
        showToast('⚠️ ' + payload.message, 'warning', 4000);
      } else if (payload.code === 'BANNED') {
        showToast('🚫 ' + payload.message, 'error', 5000);
      } else if (payload.code === 'GROUP_NOT_FOUND' || payload.code === 'INVALID_REJOIN_TOKEN') {
        showToast(payload.message, 'warning', 4500);
        if (currentScreen === 'chat' && isGroupMode) {
          exitGroupUiToLogin();
        }
        syncSavedGroupsWithServer();
      } else if (payload.code === 'GAME_ROOM_NOT_FOUND') {
        showToast(payload.message, 'warning', 4500);
        if (currentScreen === 'chat' && isGameRoomMode) {
          exitGameRoomUiToLogin();
        }
      } else {
        showToast(payload.message, 'error');
      }
      break;

    case 'reported':
      showToast('Báo cáo đã được ghi nhận. Cảm ơn bạn đã góp phần giữ môi trường văn minh!', 'success');
      break;

    // ── Trò chuyện nhóm ẩn danh ─────────────────────────────
    case 'group_joined':
      handleGroupJoined(payload);
      playMatchSound();
      break;

    case 'group_left':
      handleGroupLeft(payload);
      break;

    case 'group_list':
      renderGroupBrowseList(payload.groups || [], payload.maxMembers || 60);
      break;

    case 'group_saved_list':
      handleGroupSavedList(payload);
      break;

    case 'group_member_joined':
      handleGroupMemberJoined(payload);
      break;

    case 'group_member_left':
      handleGroupMemberLeft(payload);
      break;

    case 'group_keep_updated':
      handleGroupKeepUpdated(payload);
      break;

    case 'group_keep_pass':
      handleGroupKeepPass(payload);
      break;

    case 'group_unkept':
      handleGroupUnkept(payload);
      break;

    case 'group_message': {
      const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
      const mentionedMe = mentions.some((m) => m.clientId === clientId);
      appendMessage(payload.text, 'received', payload.timestamp, payload.linkSafety, {
        clientId: payload.senderClientId,
        nickname: payload.senderNickname,
        avatar: payload.senderAvatar,
        mentions,
        mentionedMe,
      });
      clearGroupTyper(payload.senderClientId);
      if (mentionedMe) {
        playMatchSound();
        showToast(`🔔 ${payload.senderNickname} vừa nhắc đến bạn!`, 'info', 2800);
      } else {
        playMessageSound();
      }
      break;
    }

    // ── Phòng Game Nhiều Người Ẩn Danh (2–10 người) ─────────
    case 'game_room_joined':
      handleGameRoomJoined(payload);
      playMatchSound();
      break;

    case 'game_room_left':
      handleGameRoomLeft(payload);
      break;

    case 'game_room_list':
      renderGameRoomBrowseList(payload.rooms || [], payload.maxPlayers || 10);
      break;

    case 'game_room_player_joined':
      handleGameRoomPlayerJoined(payload);
      break;

    case 'game_room_player_left':
      handleGameRoomPlayerLeft(payload);
      break;

    case 'game_room_state':
      handleGameRoomState(payload);
      break;

    case 'game_room_private':
      handleGameRoomPrivate(payload);
      break;

    // ── Minigame nhúng ngay trong Chat 1-1 / Lumi AI / Nhóm chat ──
    case 'chat_game_state':
      handleChatGameState(payload);
      break;

    case 'chat_game_private':
      handleChatGamePrivate(payload);
      break;

    // ── Giữ kết nối ẩn danh 2 chiều & Mã hẹn gặp lại (Chat 1-1) ──
    case 'pair_keep_updated':
      handlePairKeepUpdated(payload);
      break;

    case 'pair_keep_pass':
      handlePairKeepPass(payload);
      break;

    case 'pair_list':
      handlePairList(payload);
      break;

    case 'pair_waiting':
      handlePairWaiting(payload);
      break;

    case 'pair_invite':
      handlePairInvite(payload);
      break;

    case 'pair_invite_declined':
      handlePairInviteDeclined(payload);
      break;

    case 'pair_removed':
      handlePairRemoved(payload);
      break;

    case 'pair_presence':
      handlePairPresence(payload);
      break;

    case 'game_room_message': {
      const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
      const mentionedMe = mentions.some((m) => m.clientId === clientId);
      appendMessage(payload.text, 'received', payload.timestamp, payload.linkSafety, {
        clientId: payload.senderClientId,
        nickname: payload.senderNickname,
        avatar: payload.senderAvatar,
        mentions,
        mentionedMe,
      });
      clearGroupTyper(payload.senderClientId);
      if (mentionedMe) {
        playMatchSound();
        showToast(`🔔 ${payload.senderNickname} vừa nhắc đến bạn!`, 'info', 2800);
      } else {
        playMessageSound();
      }
      break;
    }

    case 'game_room_voice':
      appendVoiceMessage(payload, 'received', payload.timestamp, {
        clientId: payload.senderClientId,
        nickname: payload.senderNickname,
        avatar: payload.senderAvatar,
      });
      playMessageSound();
      break;

    case 'game_room_meme':
      if (payload.isSticker) {
        appendStickerMessage(payload.url, payload.title, 'received', payload.timestamp, {
          clientId: payload.senderClientId,
          nickname: payload.senderNickname,
          avatar: payload.senderAvatar,
        });
      } else {
        appendMemeMessage(payload.url, payload.title, 'received', payload.timestamp, {
          clientId: payload.senderClientId,
          nickname: payload.senderNickname,
          avatar: payload.senderAvatar,
        });
      }
      playMessageSound();
      break;

    case 'game_room_typing':
      handleGameRoomTyping(payload);
      break;

    case 'game_room_system':
      if (payload && payload.text) addSystemMessage(payload.text);
      break;

    case 'group_voice':
      appendVoiceMessage(payload, 'received', payload.timestamp, {
        clientId: payload.senderClientId,
        nickname: payload.senderNickname,
        avatar: payload.senderAvatar,
      });
      playMessageSound();
      break;

    case 'group_meme':
      if (payload.isSticker) {
        appendStickerMessage(payload.url, payload.title, 'received', payload.timestamp, {
          clientId: payload.senderClientId,
          nickname: payload.senderNickname,
          avatar: payload.senderAvatar,
        });
      } else {
        appendMemeMessage(payload.url, payload.title, 'received', payload.timestamp, {
          clientId: payload.senderClientId,
          nickname: payload.senderNickname,
          avatar: payload.senderAvatar,
        });
      }
      playMessageSound();
      break;

    case 'group_typing':
      handleGroupTyping(payload);
      break;

    case 'group_icebreaker':
      handleIcebreaker({
        category: payload.category,
        question: payload.triggeredBy ? `${payload.triggeredBy} gợi ý: ${payload.question}` : payload.question,
      });
      break;

    case 'group_system':
      if (payload && payload.text) addSystemMessage(payload.text);
      break;

    default:
      console.warn('[WS] Unknown type:', type);
  }
}

/** Xử lý khi ghép cặp thành công */
function handleMatchFound(payload) {
  closePairHub();
  closePairWaitingModal();
  closePairInviteModal();

  isGroupMode = false;
  isGameRoomMode = false;
  currentGroup = null;
  currentGameRoom = null;
  groupMembers = [];
  gameRoomPlayers = [];
  stopMultiGameCountdown();
  clearAllGroupTypers();
  applyChatModeUi('1v1');

  isCurrentPartnerBot = Boolean(payload.isBot);
  updateAttachmentButton();

  currentPartner = {
    nickname: payload.partnerNickname,
    mood: payload.partnerMood,
    interests: payload.commonInterests || [],
    avatar: payload.partnerAvatar || (payload.isBot ? '🤖' : '👤'),
    isBot: isCurrentPartnerBot
  };

  if (isCurrentPartnerBot) {
    currentPairKeep = null;
  } else if (payload.keptPair && payload.keptPair.isKept) {
    currentPairKeep = {
      pairId: payload.keptPair.pairId,
      pairCode: payload.keptPair.pairCode,
      mySlot: payload.keptPair.mySlot,
      myVote: true,
      partnerVote: true,
      keepCount: 2,
      isKept: true,
    };
  } else {
    currentPairKeep = {
      pairId: null,
      pairCode: null,
      mySlot: null,
      myVote: false,
      partnerVote: false,
      keepCount: 0,
      isKept: false,
    };
  }
  updatePairKeepHeaderUi();

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
  if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
  resetEmbeddedGameUi();
  myGameSymbol = null;
  currentGameState = null;

  // Xóa tin nhắn cũ
  el.chatMessages.innerHTML = '';

  // Khôi phục 30–50 tin nhắn gần nhất nếu quay lại từ "Giữ kết nối"
  if (Array.isArray(payload.history) && payload.history.length > 0) {
    addSystemMessage(`📜 Đã khôi phục ${payload.history.length} tin nhắn gần nhất giữa hai bạn:`);
    payload.history.forEach((item) => {
      const dir = item.direction === 'sent' ? 'sent' : 'received';
      if (item.type === 'voice') {
        appendVoiceMessage(item, dir, item.timestamp);
      } else if (item.type === 'attachment' && item.attachment) {
        appendAttachmentMessage(item.attachment, dir, item.timestamp);
      } else if (item.type === 'meme') {
        if (item.isSticker) {
          appendStickerMessage(item.url, item.title, dir, item.timestamp);
        } else {
          appendMemeMessage(item.url, item.title, dir, item.timestamp);
        }
      } else if (item.text) {
        appendMessage(item.text, dir, item.timestamp, item.linkSafety || null);
      }
    });
  }

  // Thêm thông báo hệ thống
  if (isCurrentPartnerBot) {
    addSystemMessage('✨ Bạn đang trò chuyện cùng Lumi. Cứ thoải mái tâm sự hoặc bấm "🎮 Chơi Game" (Đố vui, Nối từ, Đặt bom số, Caro) cùng Lumi nhé!');
  } else if (payload.keptPair && payload.keptPair.isKept) {
    addSystemMessage(`💛 Đã kết nối lại với ${payload.partnerNickname}! Mã hẹn gặp lại của hai bạn: ${payload.keptPair.pairCode} (40 tin nhắn gần nhất luôn được lưu giữ).`);
  } else {
    addSystemMessage(`🎉 Đã kết nối với ${payload.partnerNickname}! Nếu thấy hợp nhau, cả hai cùng bấm "💛 Giữ kết nối" ở góc trên để lần sau quay lại trò chuyện tiếp nhé 👋`);
  }

  // Chuyển sang màn hình chat
  switchScreen('chat');

  // Reset typing
  handleTypingIndicator(false);
}

/** Mở Modal xem chi tiết thông tin bạn chat hoặc trợ lý Lumi */
function showPartnerProfileModal() {
  if (isGroupMode) {
    toggleGroupSidePanel();
    return;
  }
  if (isGameRoomMode) return;
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
  if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
  resetEmbeddedGameUi();

  // Disable input
  el.inputMessage.disabled = true;
  el.btnSend.disabled = true;
  if (el.btnAttachment) el.btnAttachment.disabled = true;
  handleTypingIndicator(false);

  // Sau 2 giây quay về màn hình login
  setTimeout(() => {
    currentPairKeep = null;
    updatePairKeepHeaderUi();
    el.inputMessage.disabled = false;
    el.btnSend.disabled = false;
    updateAttachmentButton();
    switchScreen('login');
    syncSavedPairsWithServer();
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

/** Cập nhật bàn cờ Caro & lời mời minigame 1-1 */
function handleGameState(payload) {
  if (!payload) return;

  if (payload.action === 'invite_sent') {
    if (payload.gameType && payload.gameType !== 'caro') {
      showToast(
        `Đã gửi lời mời chơi ${payload.gameIcon || '🎮'} ${payload.gameName || 'trò chơi'} tới đối phương!`,
        'info'
      );
    } else {
      showToast(
        `Đã gửi lời mời cờ Caro (${payload.size || selectedGameSize}x${payload.size || selectedGameSize}) tới đối phương!`,
        'info'
      );
    }
    return;
  }

  // 1. Nhận lời mời chơi game (Caro hoặc Đố Vui / Nối Từ / Đặt Bom Số)
  if (payload.action === 'invite') {
    if (el.modalGameInvite) {
      invitedGameType = payload.gameType || 'caro';
      el.gameInviterName.textContent = payload.fromName || 'Đối phương';
      if (invitedGameType !== 'caro') {
        if (el.gameInviteIcon) el.gameInviteIcon.textContent = payload.gameIcon || '🎮';
        if (el.gameInviteTitle) el.gameInviteTitle.textContent = `Có người rủ chơi ${payload.gameName || 'game'}!`;
        if (el.gameInviteDescription) {
          el.gameInviteDescription.textContent = `${payload.fromName || 'Đối phương'} vừa rủ bạn chơi ${payload.gameIcon || '🎮'} ${payload.gameName || 'trò chơi'} ngay trong phòng chat.`;
        }
      } else {
        selectedGameSize = [10, 15, 20].includes(payload.size) ? payload.size : 10;
        if (el.gameInviteIcon) el.gameInviteIcon.textContent = '⚔️';
        if (el.gameInviteTitle) el.gameInviteTitle.textContent = 'Có người rủ chơi Caro!';
        if (el.gameSizeControls) {
          el.gameSizeControls.querySelectorAll('.size-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === selectedGameSize);
          });
        }
        if (el.gameInviteDescription) {
          el.gameInviteDescription.textContent = `${payload.fromName || 'Đối phương'} vừa gửi lời mời bạn cùng chơi cờ Caro ${selectedGameSize}x${selectedGameSize}.`;
        }
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

  resetEmbeddedGameUi();
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
  if (el.groupPanel) el.groupPanel.classList.add('hidden');
  if (el.multiGamePanel) el.multiGamePanel.classList.add('hidden');
  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');
  if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
  resetEmbeddedGameUi();
  if (isGroupMode || isGameRoomMode) {
    isGroupMode = false;
    isGameRoomMode = false;
    currentGroup = null;
    currentGameRoom = null;
    groupMembers = [];
    gameRoomPlayers = [];
    stopMultiGameCountdown();
    clearAllGroupTypers();
  }
}

// ═══════════════════════════════════════════════════
// Chat UI Functions
// ═══════════════════════════════════════════════════

function getGroupSenderColor(seed) {
  const str = String(seed || 'anon');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return GROUP_SENDER_COLORS[Math.abs(hash) % GROUP_SENDER_COLORS.length];
}

function createGroupSenderHeader(senderMeta) {
  if (!senderMeta || !senderMeta.nickname) return null;
  const header = document.createElement('div');
  header.className = 'group-msg-sender';

  const avatar = document.createElement('span');
  avatar.className = 'group-msg-avatar';
  avatar.textContent = senderMeta.avatar || '🦊';

  const name = document.createElement('span');
  name.className = 'group-msg-name';
  name.textContent = senderMeta.nickname;
  name.style.color = getGroupSenderColor(senderMeta.clientId || senderMeta.nickname);

  header.appendChild(avatar);
  header.appendChild(name);
  return header;
}

function pruneChatMessagesDom() {
  if (!el.chatMessages) return;
  while (el.chatMessages.children.length > MAX_CHAT_DOM_NODES) {
    el.chatMessages.removeChild(el.chatMessages.firstElementChild);
  }
}

/** Thêm tin nhắn vào khu vực chat */
function appendMessage(text, direction, timestamp, linkSafety = null, senderMeta = null) {
  const bubble = document.createElement('div');
  const mentionedMe = Boolean(senderMeta && senderMeta.mentionedMe);
  bubble.className = `message-bubble ${direction}${mentionedMe ? ' mentioned-me' : ''}`;

  if (direction === 'received' && senderMeta) {
    const senderHeader = createGroupSenderHeader(senderMeta);
    if (senderHeader) bubble.appendChild(senderHeader);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  const mentionsList = (senderMeta && Array.isArray(senderMeta.mentions) && senderMeta.mentions.length > 0)
    ? senderMeta.mentions
    : ((isGroupMode || isGameRoomMode) ? getActiveRoomMembersList() : []);
  appendMessageTextWithLinks(content, text, mentionsList);

  bubble.appendChild(content);

  if (shouldShowLinkSafetyNotice(linkSafety)) {
    const warning = document.createElement('div');
    warning.className = `link-safety-warning${linkSafety.suspicious ? ' suspicious' : ''}`;
    warning.textContent = getLinkSafetyMessage(linkSafety);
    if (linkSafety.source === 'google_safe_browsing') appendSafeBrowsingAttribution(warning);
    bubble.appendChild(warning);
  }

  if (timestamp) {
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(timestamp);
    bubble.appendChild(time);
  }

  el.chatMessages.appendChild(bubble);
  pruneChatMessagesDom();
  scrollToBottom();
}

function appendTextWithMentions(container, plainText, mentionsList = []) {
  if (!plainText) return;
  if (!plainText.includes('@') || !Array.isArray(mentionsList) || mentionsList.length === 0) {
    container.appendChild(document.createTextNode(plainText));
    return;
  }

  const sorted = [...mentionsList]
    .filter((m) => m && typeof m.nickname === 'string' && m.nickname.trim().length > 0)
    .sort((a, b) => b.nickname.length - a.nickname.length);

  if (sorted.length === 0) {
    container.appendChild(document.createTextNode(plainText));
    return;
  }

  const lower = plainText.toLowerCase();
  let cursor = 0;
  let i = 0;
  while (i < lower.length) {
    const atIndex = lower.indexOf('@', i);
    if (atIndex === -1) break;
    const prevChar = atIndex > 0 ? lower[atIndex - 1] : '';
    const validPrefix = atIndex === 0 || /[\s([{"'.,!?;:/-]/.test(prevChar);
    let matched = null;

    if (validPrefix) {
      const afterAt = lower.slice(atIndex + 1);
      for (const m of sorted) {
        const lowerNick = m.nickname.toLowerCase();
        if (!afterAt.startsWith(lowerNick)) continue;
        const nextChar = afterAt[lowerNick.length];
        if (nextChar === undefined || /[\s.,!?;:)\]}"'/@-]/.test(nextChar)) {
          matched = m;
          break;
        }
      }
    }

    if (matched) {
      if (atIndex > cursor) {
        container.appendChild(document.createTextNode(plainText.slice(cursor, atIndex)));
      }
      const tokenText = plainText.slice(atIndex, atIndex + 1 + matched.nickname.length);
      const pill = document.createElement('span');
      const isMeTag = matched.clientId === clientId;
      pill.className = `mention-pill${isMeTag ? ' mention-me' : ''}`;
      pill.textContent = tokenText;
      container.appendChild(pill);
      cursor = atIndex + 1 + matched.nickname.length;
      i = cursor;
    } else {
      i = atIndex + 1;
    }
  }

  if (cursor < plainText.length) {
    container.appendChild(document.createTextNode(plainText.slice(cursor)));
  }
}

function appendMessageTextWithLinks(container, text, mentionsList = []) {
  let cursor = 0;
  for (const match of text.matchAll(MESSAGE_URL_PATTERN)) {
    const start = match.index;
    if (start > 0 && text[start - 1] === '@') continue;

    let displayUrl = match[0];
    while (/[.,!?;:)\]}]$/u.test(displayUrl)) displayUrl = displayUrl.slice(0, -1);
    if (!displayUrl) continue;

    const href = /^https?:\/\//iu.test(displayUrl) ? displayUrl : `https://${displayUrl}`;
    let parsedUrl;
    try {
      parsedUrl = new URL(href);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;

    appendTextWithMentions(container, text.slice(cursor, start), mentionsList);
    const anchor = document.createElement('a');
    anchor.href = parsedUrl.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    anchor.textContent = displayUrl;
    container.appendChild(anchor);
    cursor = start + displayUrl.length;
  }
  appendTextWithMentions(container, text.slice(cursor), mentionsList);
}

function shouldShowLinkSafetyNotice(linkSafety) {
  if (!linkSafety || !linkSafety.hasLinks) return false;
  return Boolean(
    linkSafety.blocked
      || linkSafety.suspicious
      || linkSafety.reputation === 'limit_exceeded'
      || linkSafety.reputation === 'threat',
  );
}

// ─── Defense-in-Depth URL Validation (Client-side chống XSS & IP-Grabber) ────
const SAFE_LOCAL_STICKER_RE = /^\/assets\/stickers\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:png|gif|webp|jpg|jpeg|avif)$/i;
const SAFE_VOICE_URL_RE = /^\/api\/voice\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_GIPHY_HOSTS = new Set([
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
]);

function isSafeVoiceUrl(rawUrl) {
  return typeof rawUrl === 'string' && SAFE_VOICE_URL_RE.test(rawUrl.trim());
}

function isSafeMediaUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim();
  if (!url || url.length > 500 || url.includes('..') || url.includes('\\')) return false;
  if (SAFE_LOCAL_STICKER_RE.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && SAFE_GIPHY_HOSTS.has(parsed.hostname.toLowerCase())
      && /^\/media\/[a-zA-Z0-9/_-]+\.(?:gif|webp)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

// ─── Voice Audio Player & Messages ──────────────────────────────────────────
let currentPlayingAudio = null;
let currentPlayingResetFn = null;

function appendVoiceMessage(voiceData, direction, timestamp, senderMeta = null) {
  if (!voiceData || !isSafeVoiceUrl(voiceData.url)) return;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction} voice-message-bubble`;

  if (direction === 'received' && senderMeta) {
    const senderHeader = createGroupSenderHeader(senderMeta);
    if (senderHeader) bubble.appendChild(senderHeader);
  }

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
function appendStickerMessage(url, title, direction, timestamp, senderMeta = null) {
  if (!isSafeMediaUrl(url)) return;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction} sticker-message-bubble`;

  const wrap = document.createElement('div');
  wrap.className = 'message-sticker-wrap';

  if (direction === 'received' && senderMeta) {
    const senderHeader = createGroupSenderHeader(senderMeta);
    if (senderHeader) wrap.appendChild(senderHeader);
  }

  const img = document.createElement('img');
  img.src = url.trim();
  img.alt = title || 'Sticker';
  img.title = title || 'Nhãn dán';
  img.className = 'sticker-bubble-image';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';

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

function appendMemeMessage(url, title, direction, timestamp, senderMeta = null) {
  if (!isSafeMediaUrl(url)) return;
  const safeUrl = url.trim();

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction} meme-message-bubble`;

  if (direction === 'received' && senderMeta) {
    const senderHeader = createGroupSenderHeader(senderMeta);
    if (senderHeader) bubble.appendChild(senderHeader);
  }

  const card = document.createElement('div');
  card.className = 'message-meme-card';

  const img = document.createElement('img');
  img.src = safeUrl;
  img.alt = title || 'Meme GIF';
  img.className = 'meme-image';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';

  img.addEventListener('click', () => {
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
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
    url = new URL(attachment.url, location.origin);
  } catch {
    addSystemMessage('Không thể hiển thị tệp vì địa chỉ không hợp lệ.');
    return;
  }
  const isAzureSignedHttps = url.protocol === 'https:' && url.searchParams.has('sig');
  const isLocalSignedPath = url.origin === location.origin
    && /^\/api\/attachments\/file\/[0-9a-f-]{36}$/iu.test(url.pathname)
    && url.searchParams.has('sig');
  if (!isAzureSignedHttps && !isLocalSignedPath) {
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
    link.referrerPolicy = 'no-referrer';
    const image = document.createElement('img');
    image.src = url.href;
    image.alt = attachment.fileName;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
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
    link.referrerPolicy = 'no-referrer';
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
  el.btnAttachment.disabled = attachmentUploadActive || isCurrentPartnerBot || isGroupMode || isGameRoomMode || currentScreen !== 'chat';
  el.btnAttachment.title = (isGroupMode || isGameRoomMode)
    ? 'Gửi tệp hiện chỉ hỗ trợ ở chat 1-1'
    : 'Gửi ảnh hoặc file';
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

function normalizeClientFileName(name) {
  return String(name || '').split(/[\\/]/u).pop().replace(/[\u0000-\u001f\u007f]/gu, '').trim();
}

function uploadSelectedAttachment(ticket) {
  const file = pendingAttachmentFile;
  if (!file || normalizeClientFileName(file.name) !== ticket.fileName || file.size !== ticket.size) {
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

    setAttachmentStatus('Đang xác thực và tạo liên kết tải an toàn…');
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
  if (!shouldShowLinkSafetyNotice(linkSafety)) return;
  showToast(
    getLinkSafetyMessage(linkSafety),
    linkSafety.blocked ? 'error' : 'warning',
    6500,
    linkSafety.source,
  );
}

function appendSafeBrowsingAttribution(container) {
  container.appendChild(document.createTextNode(' Advisory provided by Google: '));
  const link = document.createElement('a');
  link.href = 'https://developers.google.com/safe-browsing/v4/advisory';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Safe Browsing Advisory';
  container.appendChild(link);
}

function getLinkSafetyMessage(linkSafety) {
  if (linkSafety.blocked) {
    if (linkSafety.blockedReason === 'limit_exceeded') {
      return '🚫 Tin nhắn có quá 5 liên kết nên đã bị chặn để tránh bỏ sót URL chưa được kiểm tra.';
    }
    if (linkSafety.blockedReason === 'unsafe_scheme') {
      return '🚫 Tin nhắn bị chặn vì chứa giao thức liên kết không an toàn.';
    }
    return '🚫 Tin nhắn bị chặn vì Google Safe Browsing đánh dấu URL có thể nguy hiểm. URL không được gửi cho người nhận.';
  }
  if (linkSafety.reputation === 'clean') {
    return `⚠️ Phát hiện dấu hiệu cấu trúc đáng ngờ: ${linkSafety.reasons.join(' ')}`;
  }
  if (linkSafety.suspicious) {
    return `⚠️ Liên kết có dấu hiệu đáng ngờ: ${linkSafety.reasons.join(' ')}`;
  }
  return '⚠️ Google Safe Browsing đánh dấu URL có thể nguy hiểm.';
}

/** Thêm thông báo hệ thống */
function addSystemMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'system-message';
  msg.textContent = text;
  el.chatMessages.appendChild(msg);
  pruneChatMessagesDom();
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
  hideMentionPopover();
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
  if (mentionOpen && mentionCandidates.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActiveIndex = (mentionActiveIndex + 1) % mentionCandidates.length;
      renderMentionPopover();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActiveIndex = (mentionActiveIndex - 1 + mentionCandidates.length) % mentionCandidates.length;
      renderMentionPopover();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const chosen = mentionCandidates[mentionActiveIndex];
      if (chosen) applyMentionSelection(chosen.nickname);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideMentionPopover();
      return;
    }
  }

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
  updateMentionPopover();
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
  if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
  resetEmbeddedGameUi();
  send('skip');
});

// ── Nút "Rời phòng" quay về trang chủ (Dùng Modal xác nhận) ─────────────
if (el.btnLeaveRoom) {
  // Khi bấm nút Rời phòng -> Mở Modal (cập nhật ngữ cảnh cho 1-1 hoặc Nhóm)
  el.btnLeaveRoom.addEventListener('click', () => {
    if (isGroupMode && currentGroup) {
      if (el.leaveModalTitle) el.leaveModalTitle.textContent = 'Rời phòng trò chuyện nhóm?';
      if (el.leaveModalDesc) {
        el.leaveModalDesc.textContent = `Bạn có muốn rời khỏi "${currentGroup.name}" để quay về trang chủ không?`;
      }
      if (el.leaveModalGroupNote) {
        const minVotes = currentGroup.minKeepVotes || 3;
        el.leaveModalGroupNote.classList.remove('hidden');
        el.leaveModalGroupNote.classList.toggle('is-kept', Boolean(currentGroup.isKept));
        if (currentGroup.isKept) {
          el.leaveModalGroupNote.textContent = currentGroup.myKeepVote
            ? `✅ Nhóm đã đủ ${currentGroup.keepCount}/${minVotes} thành viên giữ lại và bạn đã chọn giữ. Lần sau bạn có thể vào trò chuyện tiếp từ mục "Nhóm đã giữ".`
            : `⭐ Nhóm đã đủ ${currentGroup.keepCount}/${minVotes} thành viên giữ lại. Hãy chọn "Giữ & Rời nhóm" nếu bạn cũng muốn lưu nhóm này cho lần sau!`;
        } else {
          const remaining = Math.max(1, minVotes - (currentGroup.keepCount || 0));
          el.leaveModalGroupNote.textContent = `💨 Hiện mới có ${currentGroup.keepCount || 0}/${minVotes} thành viên chọn giữ nhóm (cần thêm ${remaining} người). Nếu tất cả thoát mà chưa đủ ${minVotes} người giữ, cuộc trò chuyện nhóm sẽ tự động biến mất.`;
        }
      }
      if (el.btnKeepAndLeave) {
        el.btnKeepAndLeave.classList.toggle('hidden', Boolean(currentGroup.myKeepVote));
      }
      if (el.btnConfirmLeave) el.btnConfirmLeave.textContent = 'Rời nhóm';
    } else if (isGameRoomMode && currentGameRoom) {
      if (el.leaveModalTitle) el.leaveModalTitle.textContent = 'Rời phòng game?';
      if (el.leaveModalDesc) {
        el.leaveModalDesc.textContent = `Bạn có chắc muốn rời khỏi "${currentGameRoom.name}" và quay về trang chủ không?`;
      }
      if (el.leaveModalGroupNote) el.leaveModalGroupNote.classList.add('hidden');
      if (el.btnKeepAndLeave) el.btnKeepAndLeave.classList.add('hidden');
      if (el.btnConfirmLeave) el.btnConfirmLeave.textContent = 'Rời phòng game';
    } else {
      if (el.leaveModalTitle) el.leaveModalTitle.textContent = 'Rời cuộc trò chuyện?';
      if (el.leaveModalDesc) {
        el.leaveModalDesc.textContent = 'Bạn có chắc chắn muốn kết thúc cuộc trò chuyện này và quay lại trang chủ không?';
      }
      if (el.leaveModalGroupNote) {
        if (!isCurrentPartnerBot && currentPairKeep) {
          el.leaveModalGroupNote.classList.remove('hidden');
          el.leaveModalGroupNote.classList.toggle('is-kept', Boolean(currentPairKeep.isKept));
          if (currentPairKeep.isKept) {
            el.leaveModalGroupNote.textContent = `💛 Hai bạn đã bật Giữ kết nối (Mã hẹn: ${currentPairKeep.pairCode}). 40 tin nhắn gần nhất được lưu lại để lần sau quay lại trò chuyện tiếp!`;
          } else if (currentPairKeep.myVote) {
            el.leaveModalGroupNote.textContent = '⏳ Bạn đã bấm Giữ kết nối nhưng đối phương chưa bấm đồng ý. Nếu rời đi lúc này, cuộc trò chuyện sẽ biến mất.';
          } else {
            el.leaveModalGroupNote.textContent = '💨 Hai bạn chưa bật Giữ kết nối nên rời đi sẽ mất cuộc trò chuyện này. Nếu thấy hợp nhau, hãy ở lại bấm "💛 Giữ kết nối" nhé!';
          }
        } else {
          el.leaveModalGroupNote.classList.add('hidden');
        }
      }
      if (el.btnKeepAndLeave) el.btnKeepAndLeave.classList.add('hidden');
      if (el.btnConfirmLeave) el.btnConfirmLeave.textContent = 'Rời phòng';
    }

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

// Bấm nút "Giữ & Rời nhóm" (khi đang ở nhóm và chưa vote giữ)
if (el.btnKeepAndLeave) {
  el.btnKeepAndLeave.addEventListener('click', () => {
    if (el.modalLeaveConfirm) el.modalLeaveConfirm.classList.add('hidden');
    if (isGroupMode && currentGroup) {
      pendingKeepAndLeave = true;
      send('group_vote_keep', { keep: true });
      // Đợi nhẹ để server xử lý phiếu giữ và cấp rejoinToken trước khi rời nhóm
      setTimeout(() => {
        if (pendingKeepAndLeave) {
          pendingKeepAndLeave = false;
          send('group_leave');
        }
      }, 280);
    }
  });
}

// Bấm nút "Rời phòng" trên Modal -> Thực hiện thoát phòng
if (el.btnConfirmLeave) {
  el.btnConfirmLeave.addEventListener('click', () => {
    if (el.modalLeaveConfirm) el.modalLeaveConfirm.classList.add('hidden');

    if (isGroupMode) {
      send('group_leave');
      return;
    }

    if (isGameRoomMode) {
      send('game_room_leave');
      return;
    }

    // Gửi tín hiệu rời phòng 1-1 lên server
    send('leave_room');

    // Dọn dẹp trạng thái chat phía giao diện
    if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
    if (el.gamePanel) el.gamePanel.classList.add('hidden');
    if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');
    if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
    resetEmbeddedGameUi();
    currentPairKeep = null;
    updatePairKeepHeaderUi();

    // Chuyển màn hình về trang chủ
    switchScreen('login');
    syncSavedPairsWithServer();
    showToast('Đã rời phòng trò chuyện', 'info');
  });
}

// ── Phím tắt Escape → Đóng modal hoặc Skip (1-1) ───────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  if (el.modalGroupHub && !el.modalGroupHub.classList.contains('hidden')) {
    el.modalGroupHub.classList.add('hidden');
    return;
  }
  if (el.modalGameHub && !el.modalGameHub.classList.contains('hidden')) {
    el.modalGameHub.classList.add('hidden');
    return;
  }
  if (el.modalMinigamePicker && !el.modalMinigamePicker.classList.contains('hidden')) {
    el.modalMinigamePicker.classList.add('hidden');
    return;
  }
  if (el.modalPairHub && !el.modalPairHub.classList.contains('hidden')) {
    closePairHub();
    return;
  }
  if (el.modalPairWaiting && !el.modalPairWaiting.classList.contains('hidden')) {
    send('pair_cancel_wait');
    closePairWaitingModal();
    return;
  }
  if (el.modalLeaveConfirm && !el.modalLeaveConfirm.classList.contains('hidden')) {
    el.modalLeaveConfirm.classList.add('hidden');
    return;
  }
  if (el.modalReport && !el.modalReport.classList.contains('hidden')) {
    el.modalReport.classList.add('hidden');
    return;
  }

  if (currentScreen === 'chat' && !isGroupMode && !isGameRoomMode) {
    e.preventDefault();
    send('skip');
  }
});

// ── Report Modal ────────────────────────────────────
el.btnReport.addEventListener('click', () => {
  reportTargetClientId = null;
  reportTargetNickname = '';
  if (el.reportModalDesc) {
    el.reportModalDesc.textContent = 'Nếu người này làm phiền hay nói năng thô lỗ, bạn hãy gửi lý do nhé. Hệ thống sẽ tạm chặn hai người gặp lại nhau trong 5 phút:';
  }
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
  if (isGroupMode && reportTargetClientId) {
    send('group_report', { targetClientId: reportTargetClientId, reason });
    reportTargetClientId = null;
    reportTargetNickname = '';
  } else if (isGameRoomMode && reportTargetClientId) {
    send('game_room_report', { targetClientId: reportTargetClientId, reason });
    reportTargetClientId = null;
    reportTargetNickname = '';
  } else {
    send('report', { reason });
  }
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

// ── Minigame (Caro + Đố Vui + Nối Từ + Bom Số + Gián Điệp ngay trong Chat 1-1 / Lumi / Nhóm) ──

if (el.btnMinigame) {
  el.btnMinigame.addEventListener('click', () => {
    // Nếu trong nhóm đã có bàn game đang mở mà người dùng vừa thu gọn -> mở lại ngay!
    if (isGroupMode && embeddedGame && embeddedGameMinimized) {
      embeddedGameMinimized = false;
      if (el.groupPanel) el.groupPanel.classList.add('hidden');
      if (el.multiGamePanel) el.multiGamePanel.classList.remove('hidden');
      updateGameRoomHeaderAndArena();
      playGameClickSound();
      return;
    }
    openMinigamePicker();
  });
}

if (el.btnCloseMinigamePicker) {
  el.btnCloseMinigamePicker.addEventListener('click', closeMinigamePicker);
}

if (el.modalMinigamePicker) {
  const backdrop = el.modalMinigamePicker.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeMinigamePicker);
}

if (el.minigamePickerGrid) {
  el.minigamePickerGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.game-choice-card');
    if (!card || !card.dataset.pickGame) return;
    if (card.classList.contains('disabled-in-mode')) {
      showToast('🕵️ Trò chơi "Ai Là Gián Điệp?" cần ít nhất 3 người — hãy chơi trong Nhóm chat hoặc Phòng Game nhé!', 'warning', 3600);
      return;
    }

    const picked = card.dataset.pickGame;
    closeMinigamePicker();
    playGameClickSound();

    if (isGroupMode) {
      const groupGameType = picked === 'caro' ? 'caro_arena' : picked;
      embeddedGameMinimized = false;
      send('chat_game_open', { gameType: groupGameType });
    } else {
      send('game_invite', picked === 'caro' ? { gameType: 'caro', size: selectedGameSize } : { gameType: picked });
    }
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
    if (invitedGameType && invitedGameType !== 'caro') {
      send('game_accept', { gameType: invitedGameType });
    } else {
      send('game_accept', { gameType: 'caro', size: selectedGameSize });
    }
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
// TÍNH NĂNG 4: TRÒ CHUYỆN NHÓM ẨN DANH (TỐI ĐA 60 NGƯỜI)
// Chọn theo Chủ đề/Sở thích hoặc Ngẫu nhiên • Tự biến mất • Giữ nhóm (>= 3)
// ═══════════════════════════════════════════════════

function loadSavedGroupPasses() {
  try {
    const raw = localStorage.getItem(SAVED_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.groupId === 'string' && typeof item.rejoinToken === 'string');
  } catch {
    return [];
  }
}

function saveSavedGroupPasses(passes) {
  try {
    localStorage.setItem(SAVED_GROUPS_KEY, JSON.stringify((passes || []).slice(0, 20)));
  } catch {
    // Bỏ qua nếu trình duyệt chặn storage
  }
  updateSavedGroupsBadge();
}

function upsertSavedGroupPass(pass) {
  if (!pass || !pass.groupId || !pass.rejoinToken) return;
  const list = loadSavedGroupPasses().filter((item) => item.groupId !== pass.groupId);
  list.unshift({
    groupId: pass.groupId,
    rejoinToken: pass.rejoinToken,
    name: pass.name || 'Nhóm ẩn danh',
    mode: pass.mode || 'random',
    topic: pass.topic || '',
    interests: Array.isArray(pass.interests) ? pass.interests : [],
    keepCount: pass.keepCount || 1,
    minKeepVotes: pass.minKeepVotes || 3,
    isKept: Boolean(pass.isKept),
    savedAt: Date.now(),
  });
  saveSavedGroupPasses(list);
}

function removeSavedGroupPass(groupId) {
  if (!groupId) return;
  const next = loadSavedGroupPasses().filter((item) => item.groupId !== groupId);
  saveSavedGroupPasses(next);
  savedGroupsLive = savedGroupsLive.filter((item) => item.groupId !== groupId);
  renderSavedGroupsList(savedGroupsLive);
}

function updateSavedGroupsBadge() {
  const passes = loadSavedGroupPasses();
  const keptCount = savedGroupsLive.length > 0
    ? savedGroupsLive.filter((g) => g.isKept).length
    : passes.filter((g) => g.isKept).length;
  const totalCount = savedGroupsLive.length > 0 ? savedGroupsLive.length : passes.length;

  if (el.savedGroupsBadge) {
    if (keptCount > 0) {
      el.savedGroupsBadge.textContent = `⭐ ${keptCount} đã giữ`;
      el.savedGroupsBadge.classList.remove('hidden');
    } else if (totalCount > 0) {
      el.savedGroupsBadge.textContent = `⭐ ${totalCount}`;
      el.savedGroupsBadge.classList.remove('hidden');
    } else {
      el.savedGroupsBadge.classList.add('hidden');
    }
  }
  if (el.tabSavedCount) {
    el.tabSavedCount.textContent = String(totalCount);
  }
}

function syncSavedGroupsWithServer() {
  const passes = loadSavedGroupPasses();
  updateSavedGroupsBadge();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (passes.length === 0) {
    savedGroupsLive = [];
    renderSavedGroupsList([]);
    return;
  }
  send('group_sync_saved', {
    passes: passes.map((p) => ({ groupId: p.groupId, rejoinToken: p.rejoinToken })),
  });
}

function collectLobbyProfileForGroup() {
  const typed = el.inputNickname ? el.inputNickname.value.trim() : '';
  nickname = typed || nickname || generateRandomNickname();
  if (el.inputNickname && !typed) {
    el.inputNickname.value = nickname;
    syncLiveFrequencyCard();
  }

  const checkedMood = el.moodsContainer ? el.moodsContainer.querySelector('input[name="mood"]:checked') : null;
  selectedMood = checkedMood ? checkedMood.value : 'ngau_nhien';

  const checkboxes = el.interestsContainer ? el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked') : [];
  interests = Array.from(checkboxes).map((cb) => cb.value);

  send('join', {
    nickname,
    interests,
    mood: selectedMood,
    avatar: userAvatar,
    deviceId: getOrCreateDeviceId(),
  });
}

function renderQuickInterestsPreview() {
  if (!el.groupQuickInterestsPreview) return;
  el.groupQuickInterestsPreview.textContent = '';

  const checkboxes = el.interestsContainer ? el.interestsContainer.querySelectorAll('input[type="checkbox"]:checked') : [];
  const selected = Array.from(checkboxes).map((cb) => cb.value);

  if (selected.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'live-pass-tag muted';
    empty.textContent = 'Chưa chọn sở thích ở sảnh • Bạn có thể nhập chủ đề bên dưới';
    el.groupQuickInterestsPreview.appendChild(empty);
    return;
  }

  selected.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'live-pass-tag';
    chip.textContent = `🎯 ${tag}`;
    el.groupQuickInterestsPreview.appendChild(chip);
  });
}

function setGroupHubTab(tabName) {
  if (!el.groupHubTabs) return;
  el.groupHubTabs.querySelectorAll('.group-hub-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  if (el.groupTabQuick) el.groupTabQuick.classList.toggle('hidden', tabName !== 'quick');
  if (el.groupTabBrowse) el.groupTabBrowse.classList.toggle('hidden', tabName !== 'browse');
  if (el.groupTabSaved) el.groupTabSaved.classList.toggle('hidden', tabName !== 'saved');

  if (tabName === 'browse') {
    requestPublicGroupList();
  } else if (tabName === 'saved') {
    syncSavedGroupsWithServer();
  }
}

function openGroupHub(initialTab = 'quick') {
  if (!el.modalGroupHub) return;
  renderQuickInterestsPreview();
  syncSavedGroupsWithServer();
  setGroupHubTab(initialTab);
  el.modalGroupHub.classList.remove('hidden');
  playTone(540, 'sine', 0.05, 0.07);
}

function closeGroupHub() {
  if (el.modalGroupHub) el.modalGroupHub.classList.add('hidden');
}

function requestPublicGroupList() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const query = el.inputGroupBrowseSearch ? el.inputGroupBrowseSearch.value.trim() : '';
  send('group_list', { mode: groupBrowseMode, query });
}

function applyChatModeUi(mode) {
  // Hỗ trợ cả boolean cũ (true -> 'group', false -> '1v1') lẫn chuỗi '1v1' | 'group' | 'game_room'
  const resolved = mode === true ? 'group' : (mode === false ? '1v1' : mode);
  const isGroup = resolved === 'group';
  const isGame = resolved === 'game_room';
  const isOneOnOne = resolved === '1v1';

  if (el.groupCapacityPill) el.groupCapacityPill.classList.toggle('hidden', !isGroup);
  if (el.groupKeepPill) el.groupKeepPill.classList.toggle('hidden', !isGroup);
  if (el.btnGroupKeep) el.btnGroupKeep.classList.toggle('hidden', !isGroup);
  if (el.btnGroupMembers) el.btnGroupMembers.classList.toggle('hidden', !isGroup);
  if (el.btnGroupSwitch) el.btnGroupSwitch.classList.toggle('hidden', !isGroup);

  if (el.btnIcebreaker) el.btnIcebreaker.classList.toggle('hidden', isGame);
  if (el.btnMinigame) el.btnMinigame.classList.toggle('hidden', isGame);
  if (el.btnSkip) el.btnSkip.classList.toggle('hidden', !isOneOnOne);
  if (el.btnReport) el.btnReport.classList.toggle('hidden', !isOneOnOne);

  if (!isOneOnOne) {
    if (el.botBadge) el.botBadge.classList.add('hidden');
    if (el.partnerMood) el.partnerMood.classList.add('hidden');
    if (el.gamePanel) el.gamePanel.classList.add('hidden');
    if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');
    if (el.btnPairKeep) el.btnPairKeep.classList.add('hidden');
    if (el.pairCodePill) el.pairCodePill.classList.add('hidden');
  }
  if (!isGroup && el.groupPanel) {
    el.groupPanel.classList.add('hidden');
  }
  if (!isGame && !embeddedGame && el.multiGamePanel) {
    el.multiGamePanel.classList.add('hidden');
  }
}

function toggleGroupSidePanel(forceState = null) {
  if (!el.groupPanel || !isGroupMode) return;
  const shouldShow = forceState !== null ? forceState : el.groupPanel.classList.contains('hidden');
  el.groupPanel.classList.toggle('hidden', !shouldShow);
  if (shouldShow) {
    if (embeddedGame && el.multiGamePanel && !el.multiGamePanel.classList.contains('hidden')) {
      el.multiGamePanel.classList.add('hidden');
      embeddedGameMinimized = true;
    }
    renderGroupMembersList();
  }
}

function updateGroupHeaderAndKeepUi() {
  if (!currentGroup) return;
  const count = currentGroup.memberCount || groupMembers.length || 0;
  const maxCap = currentGroup.maxMembers || 60;
  const keepCount = currentGroup.keepCount || 0;
  const minKeep = currentGroup.minKeepVotes || 3;
  const isKept = Boolean(currentGroup.isKept);
  const myVote = Boolean(currentGroup.myKeepVote);

  if (el.partnerAvatar) {
    el.partnerAvatar.textContent = currentGroup.mode === 'topic' ? '🎯' : '🎲';
  }
  if (el.partnerNickname) {
    el.partnerNickname.textContent = currentGroup.name || 'Phòng nhóm ẩn danh';
  }
  if (el.groupCapacityText) {
    el.groupCapacityText.textContent = `${count}/${maxCap}`;
  }
  if (el.btnGroupMembersLabel) {
    el.btnGroupMembersLabel.textContent = `Thành viên (${count}/${maxCap})`;
  }
  if (el.groupPanelCapacity) {
    el.groupPanelCapacity.textContent = `${count} / ${maxCap} thành viên đang trực tuyến`;
  }

  // Mô tả phụ trong header
  if (el.commonInterests) {
    const modeLabel = currentGroup.mode === 'topic' ? '🎯 Nhóm theo chủ đề' : '🎲 Nhóm ngẫu nhiên';
    const extraTags = currentGroup.interests && currentGroup.interests.length > 0
      ? ` • ${currentGroup.interests.join(', ')}`
      : (currentGroup.topic ? ` • ${currentGroup.topic}` : '');
    el.commonInterests.textContent = `${modeLabel}${extraTags}`;
  }

  // Badge trạng thái giữ nhóm trong header
  if (el.groupKeepPill) {
    el.groupKeepPill.classList.remove('kept', 'voting');
    if (isKept) {
      el.groupKeepPill.classList.add('kept');
      el.groupKeepPill.textContent = `⭐ Đã giữ (${keepCount}/${minKeep})`;
    } else if (keepCount > 0) {
      el.groupKeepPill.classList.add('voting');
      el.groupKeepPill.textContent = `⏳ Giữ nhóm ${keepCount}/${minKeep}`;
    } else {
      el.groupKeepPill.textContent = '💨 Tự hủy khi trống';
    }
  }

  // Nút giữ nhóm trên header
  if (el.btnGroupKeep) {
    el.btnGroupKeep.classList.toggle('active', myVote);
  }
  if (el.btnGroupKeepLabel) {
    el.btnGroupKeepLabel.textContent = myVote
      ? `Đã giữ (${keepCount}/${minKeep})`
      : `Giữ nhóm (${keepCount}/${minKeep})`;
  }

  // Thẻ giữ nhóm trong side panel
  if (el.groupKeepCard) {
    el.groupKeepCard.classList.toggle('is-kept', isKept);
  }
  if (el.groupPanelKeepBadge) {
    el.groupPanelKeepBadge.textContent = isKept ? `✅ ${keepCount}/${minKeep}` : `${keepCount} / ${minKeep}`;
  }
  if (el.groupKeepProgressFill) {
    const pct = Math.min(100, Math.round((keepCount / minKeep) * 100));
    el.groupKeepProgressFill.style.width = `${pct}%`;
  }
  if (el.groupPanelKeepDesc) {
    if (isKept) {
      el.groupPanelKeepDesc.textContent = myVote
        ? '🎉 Nhóm đã được giữ lại! Bạn có thể rời đi và quay lại trò chuyện tiếp bất cứ lúc nào từ mục "Nhóm đã giữ".'
        : '🎉 Nhóm đã đạt tối thiểu 3 người giữ! Hãy bấm "Tôi muốn giữ nhóm này" nếu bạn cũng muốn lưu lại cho lần sau.';
    } else {
      const needMore = Math.max(1, minKeep - keepCount);
      el.groupPanelKeepDesc.textContent = `Cần thêm ${needMore} thành viên chọn giữ để lưu nhóm cho lần sau. Nếu không, nhóm sẽ tự động biến mất khi mọi người thoát.`;
    }
  }
  if (el.btnPanelVoteKeep) {
    el.btnPanelVoteKeep.classList.toggle('active', myVote);
    el.btnPanelVoteKeep.textContent = myVote
      ? '✅ Bạn đang chọn giữ nhóm (Bấm để bỏ)'
      : '⭐ Tôi muốn giữ nhóm này';
  }

  // Render tags chủ đề/sở thích trong side panel
  if (el.groupPanelTags) {
    el.groupPanelTags.textContent = '';
    const modeChip = document.createElement('span');
    modeChip.className = `group-tag-chip${currentGroup.mode === 'random' ? ' mode-random' : ''}`;
    modeChip.textContent = currentGroup.mode === 'topic' ? '🎯 Theo chủ đề / sở thích' : '🎲 Nhóm ngẫu nhiên';
    el.groupPanelTags.appendChild(modeChip);

    if (currentGroup.topic) {
      const topicChip = document.createElement('span');
      topicChip.className = 'group-tag-chip';
      topicChip.textContent = `💬 ${currentGroup.topic}`;
      el.groupPanelTags.appendChild(topicChip);
    }
    (currentGroup.interests || []).forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'group-tag-chip';
      chip.textContent = `#${tag}`;
      el.groupPanelTags.appendChild(chip);
    });
  }
}

function renderGroupMembersList() {
  if (!el.groupMembersList || !currentGroup) return;
  const query = el.inputGroupMemberSearch
    ? stripVietnameseTones(el.inputGroupMemberSearch.value.trim().toLowerCase())
    : '';

  const filtered = groupMembers.filter((m) => {
    if (!query) return true;
    return stripVietnameseTones((m.nickname || '').toLowerCase()).includes(query);
  });

  el.groupMembersList.textContent = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-search-msg';
    empty.style.cssText = 'padding: 18px 8px; text-align: center; color: var(--text-muted); font-size: 0.8rem;';
    empty.textContent = 'Không tìm thấy thành viên nào khớp từ khóa.';
    el.groupMembersList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((member) => {
    const isMe = member.clientId === clientId;
    const row = document.createElement('div');
    row.className = 'group-member-row';
    row.setAttribute('role', 'listitem');

    const left = document.createElement('div');
    left.className = 'group-member-left';

    const avatar = document.createElement('span');
    avatar.className = 'group-member-avatar';
    avatar.textContent = member.avatar || '🦊';

    const meta = document.createElement('div');
    meta.className = 'group-member-meta';

    const name = document.createElement('span');
    name.className = 'group-member-name';
    name.textContent = isMe ? `${member.nickname} (Bạn)` : member.nickname;
    if (!isMe) {
      name.style.color = getGroupSenderColor(member.clientId || member.nickname);
    }

    const sub = document.createElement('span');
    sub.className = 'group-member-sub';
    sub.textContent = MOOD_NAMES[member.mood] || '☕ Đang trò chuyện';

    meta.appendChild(name);
    meta.appendChild(sub);
    left.appendChild(avatar);
    left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'group-member-right';

    if (member.wantsKeep) {
      const star = document.createElement('span');
      star.className = 'member-keep-star';
      star.title = 'Thành viên này muốn giữ lại nhóm';
      star.textContent = '⭐ Giữ';
      right.appendChild(star);
    }

    if (!isMe) {
      const tagBtn = document.createElement('button');
      tagBtn.type = 'button';
      tagBtn.className = 'btn-member-tag';
      tagBtn.title = `Nhắc đến @${member.nickname}`;
      tagBtn.textContent = '@';
      tagBtn.addEventListener('click', () => {
        insertMentionIntoInput(member.nickname);
      });
      right.appendChild(tagBtn);

      const reportBtn = document.createElement('button');
      reportBtn.type = 'button';
      reportBtn.className = 'btn-member-report';
      reportBtn.title = `Báo cáo ${member.nickname}`;
      reportBtn.textContent = '🚩';
      reportBtn.addEventListener('click', () => {
        reportTargetClientId = member.clientId;
        reportTargetNickname = member.nickname;
        if (el.reportModalDesc) {
          el.reportModalDesc.textContent = `Gửi báo cáo vi phạm đối với thành viên "${member.nickname}" trong nhóm:`;
        }
        el.modalReport.classList.remove('hidden');
        el.inputReportReason.value = '';
        el.inputReportReason.focus();
      });
      right.appendChild(reportBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    fragment.appendChild(row);
  });

  el.groupMembersList.appendChild(fragment);
}

function handleGroupJoined(payload) {
  if (!payload || !payload.groupId) return;
  closeGroupHub();
  closeGameHub();

  isGameRoomMode = false;
  currentGameRoom = null;
  gameRoomPlayers = [];
  resetEmbeddedGameUi();
  stopMultiGameCountdown();

  isGroupMode = true;
  isCurrentPartnerBot = false;
  currentGroup = {
    groupId: payload.groupId,
    name: payload.name,
    mode: payload.mode,
    topic: payload.topic || '',
    interests: payload.interests || [],
    mood: payload.mood || 'ngau_nhien',
    maxMembers: payload.maxMembers || 60,
    memberCount: payload.memberCount || (payload.members ? payload.members.length : 1),
    keepCount: payload.keepCount || 0,
    minKeepVotes: payload.minKeepVotes || 3,
    isKept: Boolean(payload.isKept),
    myKeepVote: Boolean(payload.myKeepVote),
    myRejoinToken: payload.myRejoinToken || null,
  };
  groupMembers = Array.isArray(payload.members) ? payload.members : [];
  clearAllGroupTypers();

  if (currentGroup.myKeepVote && currentGroup.myRejoinToken) {
    upsertSavedGroupPass({
      groupId: currentGroup.groupId,
      rejoinToken: currentGroup.myRejoinToken,
      name: currentGroup.name,
      mode: currentGroup.mode,
      topic: currentGroup.topic,
      interests: currentGroup.interests,
      keepCount: currentGroup.keepCount,
      minKeepVotes: currentGroup.minKeepVotes,
      isKept: currentGroup.isKept,
    });
  }

  applyChatModeUi(true);
  updateGroupHeaderAndKeepUi();
  renderGroupMembersList();

  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  el.chatMessages.innerHTML = '';
  el.inputMessage.disabled = false;
  el.btnSend.disabled = false;
  updateAttachmentButton();

  // Khôi phục lịch sử gần nhất nếu đây là nhóm ĐÃ ĐƯỢC GIỮ
  if (Array.isArray(payload.history) && payload.history.length > 0) {
    addSystemMessage('📜 Tin nhắn gần nhất được giữ lại trong nhóm:');
    payload.history.forEach((item) => {
      const direction = item.senderClientId === clientId ? 'sent' : 'received';
      const senderMeta = direction === 'received'
        ? { clientId: item.senderClientId, nickname: item.senderNickname, avatar: item.senderAvatar }
        : null;
      if (item.type === 'voice') {
        appendVoiceMessage(item, direction, item.timestamp, senderMeta);
      } else if (item.type === 'meme') {
        if (item.isSticker) {
          appendStickerMessage(item.url, item.title, direction, item.timestamp, senderMeta);
        } else {
          appendMemeMessage(item.url, item.title, direction, item.timestamp, senderMeta);
        }
      } else if (item.text) {
        appendMessage(item.text, direction, item.timestamp, item.linkSafety, senderMeta);
      }
    });
  }

  const modeIntro = currentGroup.mode === 'topic' ? 'theo chủ đề / sở thích' : 'ngẫu nhiên';
  addSystemMessage(
    `👥 Bạn đã vào "${currentGroup.name}" (${modeIntro} • ${currentGroup.memberCount}/${currentGroup.maxMembers} thành viên). Nhóm sẽ tự biến mất khi mọi người thoát trừ khi có ít nhất ${currentGroup.minKeepVotes} thành viên cùng chọn Giữ nhóm.`
  );

  switchScreen('chat');
  if (window.innerWidth >= 1024) {
    toggleGroupSidePanel(true);
  }
}

function exitGroupUiToLogin() {
  isGroupMode = false;
  currentGroup = null;
  groupMembers = [];
  resetEmbeddedGameUi();
  clearAllGroupTypers();
  applyChatModeUi(false);
  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  if (el.groupPanel) el.groupPanel.classList.add('hidden');
  if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
  switchScreen('login');
  syncSavedGroupsWithServer();
}

function handleGroupLeft(payload) {
  pendingKeepAndLeave = false;
  if (payload && payload.destroyed && payload.groupId) {
    removeSavedGroupPass(payload.groupId);
  }
  exitGroupUiToLogin();
  if (payload && payload.reason) {
    showToast(payload.reason, payload.preserved ? 'success' : 'info', 4500);
  } else {
    showToast('Đã rời phòng trò chuyện nhóm', 'info');
  }
}

function handleGroupMemberJoined(payload) {
  if (!isGroupMode || !currentGroup || payload.groupId !== currentGroup.groupId) return;
  if (Array.isArray(payload.renamedMembers) && payload.renamedMembers.length > 0) {
    payload.renamedMembers.forEach((r) => {
      const m = groupMembers.find((item) => item.clientId === r.clientId);
      if (m) m.nickname = r.newNickname;
      addSystemMessage(`🏷️ Do trùng biệt danh, "${r.oldNickname}" được đánh số thành "${r.newNickname}".`);
    });
  }
  if (payload.member) {
    const exists = groupMembers.some((m) => m.clientId === payload.member.clientId);
    if (!exists) {
      groupMembers.push(payload.member);
    }
    addSystemMessage(`✨ ${payload.member.avatar || '🦊'} ${payload.member.nickname} vừa tham gia nhóm (${payload.memberCount}/${currentGroup.maxMembers}).`);
  }
  currentGroup.memberCount = payload.memberCount || groupMembers.length;
  updateGroupHeaderAndKeepUi();
  renderGroupMembersList();
}

function handleGroupMemberLeft(payload) {
  if (!isGroupMode || !currentGroup || payload.groupId !== currentGroup.groupId) return;
  groupMembers = groupMembers.filter((m) => m.clientId !== payload.clientId);
  clearGroupTyper(payload.clientId);

  currentGroup.memberCount = payload.memberCount;
  if (typeof payload.keepCount === 'number') currentGroup.keepCount = payload.keepCount;
  if (typeof payload.isKept === 'boolean') currentGroup.isKept = payload.isKept;

  if (payload.nickname) {
    const text = payload.kicked
      ? `🚫 ${payload.nickname} đã bị buộc rời nhóm do vi phạm tiêu chuẩn cộng đồng.`
      : `👋 ${payload.nickname} đã rời nhóm (${payload.memberCount}/${currentGroup.maxMembers}).`;
    addSystemMessage(text);
  }

  updateGroupHeaderAndKeepUi();
  renderGroupMembersList();
}

function handleGroupKeepUpdated(payload) {
  if (!isGroupMode || !currentGroup || payload.groupId !== currentGroup.groupId) return;

  currentGroup.keepCount = payload.keepCount;
  currentGroup.minKeepVotes = payload.minKeepVotes || 3;
  currentGroup.isKept = Boolean(payload.isKept);

  if (payload.voterClientId) {
    const member = groupMembers.find((m) => m.clientId === payload.voterClientId);
    if (member) member.wantsKeep = Boolean(payload.wantsKeep);
    if (payload.voterClientId === clientId) {
      currentGroup.myKeepVote = Boolean(payload.wantsKeep);
      if (!payload.wantsKeep) {
        currentGroup.myRejoinToken = null;
        removeSavedGroupPass(currentGroup.groupId);
      }
    }
  }

  if (payload.justActivated) {
    addSystemMessage(`🎉 Đã đủ ${payload.keepCount}/${currentGroup.minKeepVotes} thành viên đồng ý giữ nhóm! Nhóm sẽ được lưu lại để các bạn quay lại trò chuyện tiếp lần sau.`);
    showToast('🎉 Nhóm đã được giữ lại thành công (≥ 3 thành viên)!', 'success', 4500);
    playMatchSound();
  } else if (payload.justDeactivated) {
    addSystemMessage(`⚠️ Số người giữ nhóm giảm xuống ${payload.keepCount}/${currentGroup.minKeepVotes}. Nếu mọi người rời đi lúc này, nhóm sẽ tự biến mất.`);
  } else if (payload.voterNickname) {
    const actionText = payload.wantsKeep ? 'đã chọn giữ lại nhóm' : 'đã bỏ chọn giữ nhóm';
    addSystemMessage(`⭐ ${payload.voterNickname} ${actionText} (${payload.keepCount}/${currentGroup.minKeepVotes}).`);
  }

  // Cập nhật trạng thái isKept trong localStorage nếu user đã lưu pass
  const passes = loadSavedGroupPasses();
  const idx = passes.findIndex((p) => p.groupId === currentGroup.groupId);
  if (idx >= 0) {
    passes[idx].keepCount = currentGroup.keepCount;
    passes[idx].isKept = currentGroup.isKept;
    saveSavedGroupPasses(passes);
  }

  updateGroupHeaderAndKeepUi();
  renderGroupMembersList();

  if (pendingKeepAndLeave && payload.voterClientId === clientId && payload.wantsKeep) {
    pendingKeepAndLeave = false;
    send('group_leave');
  }
}

function handleGroupKeepPass(pass) {
  if (!pass || !pass.groupId || !pass.rejoinToken) return;
  upsertSavedGroupPass(pass);
  if (currentGroup && currentGroup.groupId === pass.groupId) {
    currentGroup.myKeepVote = true;
    currentGroup.myRejoinToken = pass.rejoinToken;
  }
}

function handleGroupUnkept(payload) {
  if (!payload || !payload.groupId) return;
  removeSavedGroupPass(payload.groupId);
  showToast(
    payload.destroyed
      ? 'Đã bỏ giữ nhóm. Vì không còn đủ 3 thành viên giữ và phòng đang trống, nhóm đã tự biến mất.'
      : 'Đã bỏ giữ nhóm khỏi danh sách của bạn.',
    'info',
    4000
  );
  syncSavedGroupsWithServer();
}

function handleGroupSavedList(payload) {
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const expiredIds = Array.isArray(payload.expiredGroupIds) ? payload.expiredGroupIds : [];

  if (expiredIds.length > 0) {
    const expiredSet = new Set(expiredIds);
    const cleaned = loadSavedGroupPasses().filter((p) => !expiredSet.has(p.groupId));
    saveSavedGroupPasses(cleaned);
  }

  // Đồng bộ metadata mới nhất vào localStorage
  if (groups.length > 0) {
    const existing = loadSavedGroupPasses();
    const byId = new Map(existing.map((p) => [p.groupId, p]));
    groups.forEach((g) => {
      const prev = byId.get(g.groupId) || {};
      byId.set(g.groupId, {
        ...prev,
        groupId: g.groupId,
        rejoinToken: g.rejoinToken || prev.rejoinToken,
        name: g.name,
        mode: g.mode,
        topic: g.topic,
        interests: g.interests || [],
        keepCount: g.keepCount,
        minKeepVotes: g.minKeepVotes || 3,
        isKept: Boolean(g.isKept),
      });
    });
    saveSavedGroupPasses([...byId.values()]);
  }

  savedGroupsLive = groups;
  updateSavedGroupsBadge();
  renderSavedGroupsList(groups);
}

function renderGroupBrowseList(groups, maxMembers = 60) {
  if (!el.groupBrowseList) return;
  el.groupBrowseList.textContent = '';

  if (!groups || groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty-state';
    empty.innerHTML = `
      <span class="group-empty-icon">🌌</span>
      <p>Hiện chưa có nhóm công khai nào đang mở khớp bộ lọc. Bạn có thể tạo hoặc ghép ngay nhóm đầu tiên!</p>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-small';
    btn.textContent = '✨ Mở nhóm ngay';
    btn.addEventListener('click', () => setGroupHubTab('quick'));
    empty.appendChild(btn);
    el.groupBrowseList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  groups.forEach((g) => {
    const isFull = g.memberCount >= (g.maxMembers || maxMembers);
    const card = document.createElement('div');
    card.className = `group-list-card${g.isKept ? ' is-kept' : ''}`;

    const info = document.createElement('div');
    info.className = 'group-list-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'group-list-title-row';

    const badge = document.createElement('span');
    badge.className = `group-mode-badge ${g.mode === 'topic' ? 'topic' : 'random'}`;
    badge.textContent = g.mode === 'topic' ? '🎯 Chủ đề' : '🎲 Ngẫu nhiên';

    const nameEl = document.createElement('span');
    nameEl.className = 'group-list-name';
    nameEl.textContent = g.name;

    titleRow.appendChild(badge);
    titleRow.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'group-list-meta';
    const tagsPart = g.interests && g.interests.length > 0 ? ` • ${g.interests.map((t) => `#${t}`).join(' ')}` : '';
    const keepPart = g.isKept
      ? ` • ⭐ Đã giữ (${g.keepCount}/${g.minKeepVotes || 3})`
      : (g.keepCount > 0 ? ` • ⏳ Giữ ${g.keepCount}/${g.minKeepVotes || 3}` : ' • 💨 Tự hủy khi trống');
    meta.textContent = `👥 ${g.memberCount}/${g.maxMembers || maxMembers} người${tagsPart}${keepPart}`;

    info.appendChild(titleRow);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'group-list-actions';

    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'btn btn-primary btn-small';
    joinBtn.disabled = isFull;
    joinBtn.textContent = isFull ? 'Đã đầy' : 'Vào ngay →';
    joinBtn.addEventListener('click', () => {
      collectLobbyProfileForGroup();
      send('group_join', { groupId: g.groupId });
    });

    actions.appendChild(joinBtn);
    card.appendChild(info);
    card.appendChild(actions);
    fragment.appendChild(card);
  });

  el.groupBrowseList.appendChild(fragment);
}

function renderSavedGroupsList(groups) {
  if (!el.groupSavedList) return;
  el.groupSavedList.textContent = '';

  if (!groups || groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty-state';
    empty.innerHTML = `
      <span class="group-empty-icon">⭐</span>
      <p>Bạn chưa có nhóm nào được giữ lại. Hãy vào một nhóm và cùng ít nhất 3 thành viên bấm nút <b>Giữ nhóm</b> để lưu lại cho lần sau nhé!</p>
    `;
    el.groupSavedList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  groups.forEach((g) => {
    const card = document.createElement('div');
    card.className = `group-list-card${g.isKept ? ' is-kept' : ''}`;

    const info = document.createElement('div');
    info.className = 'group-list-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'group-list-title-row';

    const statusBadge = document.createElement('span');
    statusBadge.className = `group-mode-badge ${g.isKept ? 'random' : 'topic'}`;
    statusBadge.textContent = g.isKept
      ? `⭐ Đã giữ (${g.keepCount}/${g.minKeepVotes || 3})`
      : `⏳ Đang chờ (${g.keepCount}/${g.minKeepVotes || 3})`;

    const nameEl = document.createElement('span');
    nameEl.className = 'group-list-name';
    nameEl.textContent = g.name;

    titleRow.appendChild(statusBadge);
    titleRow.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'group-list-meta';
    const onlineText = g.memberCount > 0
      ? `🟢 ${g.memberCount}/${g.maxMembers || 60} đang trò chuyện`
      : `🌙 0/${g.maxMembers || 60} online (Sẵn sàng mở lại)`;
    const topicText = g.topic ? ` • 💬 ${g.topic}` : '';
    meta.textContent = `${onlineText}${topicText}`;

    info.appendChild(titleRow);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'group-list-actions';

    const rejoinBtn = document.createElement('button');
    rejoinBtn.type = 'button';
    rejoinBtn.className = 'btn btn-primary btn-small';
    rejoinBtn.textContent = 'Vào tiếp →';
    rejoinBtn.addEventListener('click', () => {
      collectLobbyProfileForGroup();
      send('group_rejoin', { groupId: g.groupId, rejoinToken: g.rejoinToken });
    });

    const unkeepBtn = document.createElement('button');
    unkeepBtn.type = 'button';
    unkeepBtn.className = 'btn btn-secondary btn-small';
    unkeepBtn.title = 'Bỏ giữ nhóm này';
    unkeepBtn.textContent = 'Bỏ giữ';
    unkeepBtn.addEventListener('click', () => {
      send('group_unkeep', { groupId: g.groupId, rejoinToken: g.rejoinToken });
    });

    actions.appendChild(rejoinBtn);
    actions.appendChild(unkeepBtn);
    card.appendChild(info);
    card.appendChild(actions);
    fragment.appendChild(card);
  });

  el.groupSavedList.appendChild(fragment);
}

// ── Typing indicator đa thành viên trong phòng nhóm ────────
function renderGroupTypingIndicator() {
  if (!el.typingIndicator || !isGroupMode) return;
  const typingTextEl = el.typingIndicator.querySelector('.typing-text');
  const names = [...groupTypingUsers.values()].map((item) => item.nickname).filter(Boolean);

  if (names.length === 0) {
    el.typingIndicator.classList.add('hidden');
    if (typingTextEl) typingTextEl.textContent = 'Người ấy đang gõ…';
    return;
  }

  let label = '';
  if (names.length === 1) {
    label = `${names[0]} đang gõ…`;
  } else if (names.length === 2) {
    label = `${names[0]} và ${names[1]} đang gõ…`;
  } else {
    label = `${names[0]}, ${names[1]} và ${names.length - 2} người khác đang gõ…`;
  }

  if (typingTextEl) typingTextEl.textContent = label;
  el.typingIndicator.classList.remove('hidden');
}

function clearGroupTyper(targetClientId) {
  const existing = groupTypingUsers.get(targetClientId);
  if (existing) {
    clearTimeout(existing.timer);
    groupTypingUsers.delete(targetClientId);
    if (isGameRoomMode) {
      renderGameRoomTypingIndicator();
    } else {
      renderGroupTypingIndicator();
    }
  }
}

function clearAllGroupTypers() {
  for (const [, entry] of groupTypingUsers) {
    clearTimeout(entry.timer);
  }
  groupTypingUsers.clear();
  if (el.typingIndicator) {
    el.typingIndicator.classList.add('hidden');
    const typingTextEl = el.typingIndicator.querySelector('.typing-text');
    if (typingTextEl) typingTextEl.textContent = 'Người ấy đang gõ…';
  }
}

function handleGroupTyping(payload) {
  if (!isGroupMode || !currentGroup || payload.groupId !== currentGroup.groupId) return;
  if (!payload.clientId || payload.clientId === clientId) return;

  if (!payload.isTyping) {
    clearGroupTyper(payload.clientId);
    return;
  }

  const existing = groupTypingUsers.get(payload.clientId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    groupTypingUsers.delete(payload.clientId);
    renderGroupTypingIndicator();
  }, 4000);

  groupTypingUsers.set(payload.clientId, {
    nickname: payload.nickname || 'Ai đó',
    timer,
  });
  renderGroupTypingIndicator();
}

function toggleMyKeepVote() {
  if (!isGroupMode || !currentGroup) return;
  const nextVote = !currentGroup.myKeepVote;
  send('group_vote_keep', { keep: nextVote });
  playTone(nextVote ? 680 : 420, 'triangle', 0.08, 0.08);
}

// ── Event Listeners cho Trò chuyện nhóm ────────────────────
if (el.btnOpenGroupHub) {
  el.btnOpenGroupHub.addEventListener('click', () => openGroupHub('quick'));
}

if (el.btnCloseGroupHub) {
  el.btnCloseGroupHub.addEventListener('click', closeGroupHub);
}

if (el.modalGroupHub) {
  const backdrop = el.modalGroupHub.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeGroupHub);
}

if (el.groupHubTabs) {
  el.groupHubTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.group-hub-tab');
    if (!tab || !tab.dataset.tab) return;
    setGroupHubTab(tab.dataset.tab);
  });
}

if (el.groupTopicPresets && el.inputGroupTopic) {
  el.groupTopicPresets.addEventListener('click', (e) => {
    const chip = e.target.closest('.topic-preset-chip');
    if (!chip || !chip.dataset.topic) return;
    el.inputGroupTopic.value = chip.dataset.topic;
    el.inputGroupTopic.focus();
    playTone(580, 'sine', 0.04, 0.05);
  });
}

if (el.btnGroupJoinTopic) {
  el.btnGroupJoinTopic.addEventListener('click', () => {
    collectLobbyProfileForGroup();
    const topic = el.inputGroupTopic ? el.inputGroupTopic.value.trim() : '';
    if (!topic && interests.length === 0) {
      showToast('Hãy chọn ít nhất 1 sở thích hoặc nhập chủ đề bạn muốn trò chuyện nhé!', 'warning');
      if (el.inputGroupTopic) el.inputGroupTopic.focus();
      return;
    }
    send('group_find', { mode: 'topic', topic, interests, mood: selectedMood });
  });
}

if (el.btnGroupCreateTopic) {
  el.btnGroupCreateTopic.addEventListener('click', () => {
    collectLobbyProfileForGroup();
    const topic = el.inputGroupTopic ? el.inputGroupTopic.value.trim() : '';
    if (!topic && interests.length === 0) {
      showToast('Nhập tên chủ đề hoặc chọn sở thích để tạo nhóm mới nhé!', 'warning');
      if (el.inputGroupTopic) el.inputGroupTopic.focus();
      return;
    }
    send('group_create', { mode: 'topic', topic, interests, mood: selectedMood });
  });
}

if (el.btnGroupJoinRandom) {
  el.btnGroupJoinRandom.addEventListener('click', () => {
    collectLobbyProfileForGroup();
    send('group_find', { mode: 'random', interests, mood: selectedMood });
  });
}

if (el.groupBrowseFilters) {
  el.groupBrowseFilters.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill || !pill.dataset.mode) return;
    groupBrowseMode = pill.dataset.mode;
    el.groupBrowseFilters.querySelectorAll('.filter-pill').forEach((p) => {
      p.classList.toggle('active', p === pill);
    });
    requestPublicGroupList();
  });
}

if (el.btnRefreshGroupList) {
  el.btnRefreshGroupList.addEventListener('click', requestPublicGroupList);
}

if (el.inputGroupBrowseSearch) {
  let browseSearchTimer = null;
  el.inputGroupBrowseSearch.addEventListener('input', () => {
    clearTimeout(browseSearchTimer);
    browseSearchTimer = setTimeout(requestPublicGroupList, 250);
  });
}

if (el.btnGroupKeep) {
  el.btnGroupKeep.addEventListener('click', toggleMyKeepVote);
}

if (el.btnPanelVoteKeep) {
  el.btnPanelVoteKeep.addEventListener('click', toggleMyKeepVote);
}

if (el.btnGroupMembers) {
  el.btnGroupMembers.addEventListener('click', () => toggleGroupSidePanel());
}

if (el.groupCapacityPill) {
  el.groupCapacityPill.addEventListener('click', () => toggleGroupSidePanel());
}

if (el.btnCloseGroupPanel) {
  el.btnCloseGroupPanel.addEventListener('click', () => toggleGroupSidePanel(false));
}

if (el.inputGroupMemberSearch) {
  el.inputGroupMemberSearch.addEventListener('input', renderGroupMembersList);
}

if (el.btnGroupSwitch) {
  el.btnGroupSwitch.addEventListener('click', () => {
    if (!isGroupMode || !currentGroup) return;
    send('group_find', {
      mode: currentGroup.mode || 'random',
      topic: currentGroup.topic || '',
      interests: currentGroup.interests || interests,
      mood: selectedMood,
      excludeGroupId: currentGroup.groupId,
    });
  });
}

// ═══════════════════════════════════════════════════
// TÍNH NĂNG 5: TAG @MENTION TRONG NHÓM CHAT & PHÒNG GAME
// ═══════════════════════════════════════════════════

function getActiveRoomMembersList() {
  if (isGroupMode) return groupMembers;
  if (isGameRoomMode) return gameRoomPlayers;
  return [];
}

function hideMentionPopover() {
  mentionOpen = false;
  mentionCandidates = [];
  mentionActiveIndex = 0;
  mentionStartPos = -1;
  if (el.mentionPopover) el.mentionPopover.classList.add('hidden');
}

function renderMentionPopover() {
  if (!el.mentionPopover || !el.mentionPopoverList) return;
  if (!mentionOpen || mentionCandidates.length === 0) {
    el.mentionPopover.classList.add('hidden');
    return;
  }

  el.mentionPopoverList.textContent = '';
  mentionCandidates.forEach((member, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mention-item-btn${idx === mentionActiveIndex ? ' active' : ''}`;
    btn.setAttribute('role', 'option');

    const left = document.createElement('span');
    left.className = 'mention-item-left';

    const avatar = document.createElement('span');
    avatar.className = 'mention-item-avatar';
    avatar.textContent = member.avatar || '🦊';

    const name = document.createElement('span');
    name.className = 'mention-item-name';
    name.textContent = member.nickname;
    name.style.color = getGroupSenderColor(member.clientId || member.nickname);

    left.appendChild(avatar);
    left.appendChild(name);

    const hint = document.createElement('span');
    hint.className = 'mention-item-hint';
    hint.textContent = `@${member.nickname}`;

    btn.appendChild(left);
    btn.appendChild(hint);

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyMentionSelection(member.nickname);
    });

    el.mentionPopoverList.appendChild(btn);
  });

  el.mentionPopover.classList.remove('hidden');
}

function updateMentionPopover() {
  if (!el.inputMessage || (!isGroupMode && !isGameRoomMode)) {
    hideMentionPopover();
    return;
  }

  const cursor = el.inputMessage.selectionStart ?? el.inputMessage.value.length;
  const textBefore = el.inputMessage.value.slice(0, cursor);
  const atPos = textBefore.lastIndexOf('@');

  if (atPos === -1) {
    hideMentionPopover();
    return;
  }

  const charBefore = atPos > 0 ? textBefore[atPos - 1] : '';
  if (atPos > 0 && !/[\s([{"']/.test(charBefore)) {
    hideMentionPopover();
    return;
  }

  const query = textBefore.slice(atPos + 1);
  if (query.length > 32 || /\n/.test(query)) {
    hideMentionPopover();
    return;
  }

  const normalizedQuery = stripVietnameseTones(query.trim().toLowerCase());
  const members = getActiveRoomMembersList().filter((m) => m.clientId !== clientId);

  const matched = members.filter((m) => {
    if (!normalizedQuery) return true;
    const normNick = stripVietnameseTones((m.nickname || '').toLowerCase());
    return normNick.includes(normalizedQuery);
  }).slice(0, 10);

  if (matched.length === 0) {
    hideMentionPopover();
    return;
  }

  mentionStartPos = atPos;
  mentionCandidates = matched;
  mentionActiveIndex = Math.min(mentionActiveIndex, matched.length - 1);
  mentionOpen = true;
  renderMentionPopover();
}

function applyMentionSelection(displayName) {
  if (!el.inputMessage || !displayName) return;
  const val = el.inputMessage.value;
  const cursor = el.inputMessage.selectionStart ?? val.length;
  const start = mentionStartPos >= 0 ? mentionStartPos : cursor;
  const replacement = `@${displayName} `;
  el.inputMessage.value = val.slice(0, start) + replacement + val.slice(cursor);
  const newCursor = start + replacement.length;
  el.inputMessage.selectionStart = el.inputMessage.selectionEnd = newCursor;
  if (el.charCurrent) el.charCurrent.textContent = el.inputMessage.value.length;
  hideMentionPopover();
  el.inputMessage.focus();
  playTone(620, 'sine', 0.03, 0.04);
}

function insertMentionIntoInput(displayName) {
  if (!el.inputMessage || !displayName) return;
  const val = el.inputMessage.value;
  const prefix = val.length > 0 && !/\s$/.test(val) ? ' ' : '';
  const tagText = `${prefix}@${displayName} `;
  if (val.length + tagText.length > 500) return;
  el.inputMessage.value = val + tagText;
  if (el.charCurrent) el.charCurrent.textContent = el.inputMessage.value.length;
  el.inputMessage.focus();
  hideMentionPopover();
  playTone(600, 'sine', 0.04, 0.05);
}

if (el.btnCloseMentionPopover) {
  el.btnCloseMentionPopover.addEventListener('click', hideMentionPopover);
}

// ═══════════════════════════════════════════════════
// TÍNH NĂNG 6: PHÒNG GAME NHIỀU NGƯỜI ẨN DANH (2–10 NGƯỜI)
// Đố Vui Tốc Độ • Nối Từ • Ai Là Gián Điệp • Đặt Bom Số • Caro Khán Đài
// ═══════════════════════════════════════════════════

function openGameHub(initialTab = 'play') {
  if (!el.modalGameHub) return;
  setGameHubTab(initialTab);
  el.modalGameHub.classList.remove('hidden');
  playTone(580, 'triangle', 0.06, 0.07);
}

function closeGameHub() {
  if (el.modalGameHub) el.modalGameHub.classList.add('hidden');
}

function setGameHubTab(tabName) {
  if (el.gameHubTabs) {
    el.gameHubTabs.querySelectorAll('.group-hub-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
  }
  if (el.gameHubTabPlay) el.gameHubTabPlay.classList.toggle('hidden', tabName !== 'play');
  if (el.gameHubTabBrowse) el.gameHubTabBrowse.classList.toggle('hidden', tabName !== 'browse');
  if (tabName === 'browse') requestGameRoomList();
}

function requestGameRoomList() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send('game_room_list', { gameType: gameBrowseFilter });
}

function stopMultiGameCountdown() {
  if (multiGameCountdownTimer) {
    clearInterval(multiGameCountdownTimer);
    multiGameCountdownTimer = null;
  }
  if (el.multiGameTimerPill) {
    el.multiGameTimerPill.classList.add('hidden');
    el.multiGameTimerPill.classList.remove('urgent');
  }
}

function syncMultiGameCountdown(endsAt) {
  stopMultiGameCountdown();
  if (!endsAt || !el.multiGameTimerPill) return;

  const updateTick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.multiGameTimerPill.textContent = `⏱️ ${remaining}s`;
    el.multiGameTimerPill.classList.remove('hidden');
    el.multiGameTimerPill.classList.toggle('urgent', remaining <= 5);
    if (remaining <= 0) {
      clearInterval(multiGameCountdownTimer);
      multiGameCountdownTimer = null;
    }
  };

  updateTick();
  multiGameCountdownTimer = setInterval(updateTick, 500);
}

function exitGameRoomUiToLogin() {
  isGameRoomMode = false;
  currentGameRoom = null;
  gameRoomPlayers = [];
  myPrivateGameSecret = null;
  myQuizSelection = null;
  myUndercoverVote = null;
  stopMultiGameCountdown();
  clearAllGroupTypers();
  applyChatModeUi('1v1');
  if (el.multiGamePanel) el.multiGamePanel.classList.add('hidden');
  switchScreen('login');
}

function handleGameRoomJoined(payload) {
  if (!payload || !payload.roomId) return;
  closeGameHub();
  closeGroupHub();

  isGroupMode = false;
  currentGroup = null;
  groupMembers = [];
  resetEmbeddedGameUi();
  isCurrentPartnerBot = false;

  isGameRoomMode = true;
  currentGameRoom = {
    roomId: payload.roomId,
    roomCode: payload.roomCode,
    name: payload.name,
    gameType: payload.gameType,
    gameInfo: payload.gameInfo,
    hostId: payload.hostId,
    maxPlayers: payload.maxPlayers || 10,
    playerCount: payload.playerCount || (payload.players ? payload.players.length : 1),
    status: payload.status || 'lobby',
    gameState: payload.gameState || { gameType: payload.gameType, phase: 'lobby' },
  };
  gameRoomPlayers = Array.isArray(payload.players) ? payload.players : [];
  myPrivateGameSecret = null;
  secretWordHidden = false;
  myQuizSelection = null;
  myUndercoverVote = null;
  clearAllGroupTypers();

  applyChatModeUi('game_room');
  if (el.multiGamePanel) el.multiGamePanel.classList.remove('hidden');

  if (el.icebreakerBanner) el.icebreakerBanner.classList.add('hidden');
  el.chatMessages.innerHTML = '';
  el.inputMessage.disabled = false;
  el.btnSend.disabled = false;
  updateAttachmentButton();

  updateGameRoomHeaderAndArena();

  const myPlayer = gameRoomPlayers.find((p) => p.clientId === clientId);
  const myRoomNick = myPlayer ? myPlayer.nickname : nickname;
  addSystemMessage(
    `🎮 Bạn đã vào "${currentGameRoom.name}" (Mã: ${currentGameRoom.roomCode} • ${currentGameRoom.playerCount}/${currentGameRoom.maxPlayers} người) với biệt danh ẩn danh "${myRoomNick}". Gõ @ để tag người chơi khác trong chat!`
  );

  switchScreen('chat');
}

function handleGameRoomLeft(payload) {
  exitGameRoomUiToLogin();
  showToast((payload && payload.reason) || 'Đã rời phòng game', 'info', 3500);
}

function handleGameRoomPlayerJoined(payload) {
  if (!isGameRoomMode || !currentGameRoom || payload.roomId !== currentGameRoom.roomId) return;
  if (Array.isArray(payload.renamedMembers) && payload.renamedMembers.length > 0) {
    payload.renamedMembers.forEach((r) => {
      const p = gameRoomPlayers.find((item) => item.clientId === r.clientId);
      if (p) p.nickname = r.newNickname;
      addSystemMessage(`🏷️ Do trùng biệt danh, "${r.oldNickname}" được đánh số thành "${r.newNickname}".`);
    });
  }
  if (payload.player) {
    const exists = gameRoomPlayers.some((p) => p.clientId === payload.player.clientId);
    if (!exists) gameRoomPlayers.push(payload.player);
    addSystemMessage(`✨ ${payload.player.avatar || '🦊'} ${payload.player.nickname} vừa vào phòng game (${payload.playerCount}/${currentGameRoom.maxPlayers}).`);
  }
  currentGameRoom.playerCount = payload.playerCount || gameRoomPlayers.length;
  updateGameRoomHeaderAndArena();
  if (mentionOpen) updateMentionPopover();
}

function handleGameRoomPlayerLeft(payload) {
  if (!isGameRoomMode || !currentGameRoom || payload.roomId !== currentGameRoom.roomId) return;
  gameRoomPlayers = gameRoomPlayers.filter((p) => p.clientId !== payload.clientId);
  clearGroupTyper(payload.clientId);

  currentGameRoom.playerCount = payload.playerCount;
  if (payload.hostId) {
    currentGameRoom.hostId = payload.hostId;
    gameRoomPlayers.forEach((p) => { p.isHost = p.clientId === payload.hostId; });
  }

  if (payload.nickname) {
    const text = payload.kicked
      ? `🚫 ${payload.nickname} bị buộc rời phòng game do vi phạm.`
      : `👋 ${payload.nickname} đã rời phòng game (${payload.playerCount}/${currentGameRoom.maxPlayers}).`;
    addSystemMessage(text);
  }
  if (payload.hostChanged && payload.hostNickname) {
    addSystemMessage(`👑 ${payload.hostNickname} đã trở thành chủ phòng mới.`);
  }

  updateGameRoomHeaderAndArena();
  if (mentionOpen) updateMentionPopover();
}

function handleGameRoomPrivate(payload) {
  if (!isGameRoomMode || !currentGameRoom || payload.roomId !== currentGameRoom.roomId) return;
  myPrivateGameSecret = payload;
  secretWordHidden = false;
  if (payload.gameType === 'undercover' && payload.secretWord) {
    showToast(`🤫 Từ bí mật của bạn đã được gửi trong bảng game!`, 'info', 3500);
  }
  renderMultiGameArenaBody();
}

function handleGameRoomState(payload) {
  if (!isGameRoomMode || !currentGameRoom || payload.roomId !== currentGameRoom.roomId) return;

  const prevState = currentGameRoom.gameState;
  currentGameRoom.gameType = payload.gameType || currentGameRoom.gameType;
  if (payload.gameInfo) currentGameRoom.gameInfo = payload.gameInfo;
  if (payload.hostId) currentGameRoom.hostId = payload.hostId;
  if (payload.status) currentGameRoom.status = payload.status;
  if (Array.isArray(payload.players)) {
    gameRoomPlayers = payload.players;
    currentGameRoom.playerCount = payload.players.length;
  }
  if (payload.gameState) {
    // Reset lựa chọn cá nhân khi sang câu hỏi hoặc vòng mới
    if (
      payload.gameState.gameType === 'quiz_race'
      && (!prevState || prevState.currentIndex !== payload.gameState.currentIndex || prevState.phase !== payload.gameState.phase)
    ) {
      if (payload.gameState.phase === 'question') myQuizSelection = null;
    }
    if (
      payload.gameState.gameType === 'undercover'
      && (!prevState || prevState.round !== payload.gameState.round || prevState.phase !== payload.gameState.phase)
    ) {
      if (payload.gameState.phase === 'vote') myUndercoverVote = null;
      if (payload.gameState.phase === 'lobby') myPrivateGameSecret = null;
    }
    currentGameRoom.gameState = payload.gameState;
  }

  if (payload.systemNotice) {
    addSystemMessage(payload.systemNotice);
  }

  updateGameRoomHeaderAndArena();
}

function handleGameRoomTyping(payload) {
  if (!isGameRoomMode || !currentGameRoom || payload.roomId !== currentGameRoom.roomId) return;
  if (!payload.clientId || payload.clientId === clientId) return;

  if (!payload.isTyping) {
    clearGroupTyper(payload.clientId);
    return;
  }

  const existing = groupTypingUsers.get(payload.clientId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    groupTypingUsers.delete(payload.clientId);
    renderGameRoomTypingIndicator();
  }, 4000);
  groupTypingUsers.set(payload.clientId, { nickname: payload.nickname || 'Ai đó', timer });
  renderGameRoomTypingIndicator();
}

function renderGameRoomTypingIndicator() {
  if (!el.typingIndicator || !isGameRoomMode) return;
  const typingTextEl = el.typingIndicator.querySelector('.typing-text');
  const names = [...groupTypingUsers.values()].map((item) => item.nickname).filter(Boolean);
  if (names.length === 0) {
    el.typingIndicator.classList.add('hidden');
    return;
  }
  const label = names.length === 1
    ? `${names[0]} đang gõ…`
    : (names.length === 2 ? `${names[0]} và ${names[1]} đang gõ…` : `${names[0]}, ${names[1]} và ${names.length - 2} người khác đang gõ…`);
  if (typingTextEl) typingTextEl.textContent = label;
  el.typingIndicator.classList.remove('hidden');
}

function getActiveArenaRoom() {
  return isGameRoomMode ? currentGameRoom : embeddedGame;
}

function getActiveArenaPlayers() {
  return isGameRoomMode ? gameRoomPlayers : embeddedGamePlayers;
}

function sendActiveArenaAction(payload) {
  if (isGameRoomMode) {
    send('game_room_action', payload);
  } else if (embeddedGame) {
    send('chat_game_action', payload);
  }
}

function resetEmbeddedGameUi() {
  embeddedGame = null;
  embeddedGamePlayers = [];
  embeddedGameMinimized = false;
  if (!isGameRoomMode) {
    myPrivateGameSecret = null;
    myQuizSelection = null;
    myUndercoverVote = null;
    stopMultiGameCountdown();
    if (el.multiGamePanel) el.multiGamePanel.classList.add('hidden');
  }
  if (el.btnMinigame) el.btnMinigame.classList.remove('has-live-game');
  if (el.btnMinigameLabel) el.btnMinigameLabel.textContent = 'Chơi Game';
}

function openMinigamePicker() {
  if (!el.modalMinigamePicker) return;
  if (isGroupMode) {
    if (el.minigamePickerDesc) {
      el.minigamePickerDesc.textContent = embeddedGame
        ? 'Nhóm đang có bàn game mở — chọn trò chơi hoặc mở lại bàn game ngay!'
        : 'Mở bàn game ngay trong phòng nhóm (tối đa 10 người ngồi bàn, cả nhóm cùng xem & cổ vũ)!';
    }
    if (el.pickerCaroSub) el.pickerCaroSub.textContent = '2–10 người • 2 người đấu, khán giả luân phiên';
    if (el.pickerCardUndercover) el.pickerCardUndercover.classList.remove('disabled-in-mode');
    if (el.pickerUndercoverSub) el.pickerUndercoverSub.textContent = '3–10 người • Đoán từ & tìm gián điệp ẩn danh';
  } else if (isCurrentPartnerBot) {
    if (el.minigamePickerDesc) {
      el.minigamePickerDesc.textContent = 'Chọn trò chơi để so tài ngay lập tức cùng bạn ảo Lumi AI!';
    }
    if (el.pickerCaroSub) el.pickerCaroSub.textContent = '10×10 / 15×15 / 20×20 đấu với Lumi';
    if (el.pickerCardUndercover) el.pickerCardUndercover.classList.add('disabled-in-mode');
    if (el.pickerUndercoverSub) el.pickerUndercoverSub.textContent = 'Cần ≥ 3 người (chơi trong Nhóm / Phòng Game)';
  } else {
    if (el.minigamePickerDesc) {
      el.minigamePickerDesc.textContent = 'Rủ bạn chat 1-1 chơi ngay tại đây mà không cần rời cuộc trò chuyện!';
    }
    if (el.pickerCaroSub) el.pickerCaroSub.textContent = '10×10 / 15×15 / 20×20 đối kháng 1-1';
    if (el.pickerCardUndercover) el.pickerCardUndercover.classList.add('disabled-in-mode');
    if (el.pickerUndercoverSub) el.pickerUndercoverSub.textContent = 'Cần ≥ 3 người (chơi trong Nhóm / Phòng Game)';
  }
  el.modalMinigamePicker.classList.remove('hidden');
  playTone(580, 'triangle', 0.05, 0.06);
}

function closeMinigamePicker() {
  if (el.modalMinigamePicker) el.modalMinigamePicker.classList.add('hidden');
}

function handleChatGamePrivate(payload) {
  if (!payload || isGameRoomMode || !embeddedGame) return;
  myPrivateGameSecret = payload;
  secretWordHidden = false;
  if (payload.gameType === 'undercover' && payload.secretWord) {
    showToast('🤫 Từ bí mật của bạn đã được gửi trong bảng game!', 'info', 3500);
  }
  renderMultiGameArenaBody();
}

function handleChatGameState(payload) {
  if (!payload || isGameRoomMode) return;
  if (payload.contextType === 'group' && (!isGroupMode || !currentGroup || (payload.groupId && payload.groupId !== currentGroup.groupId))) {
    return;
  }
  if (payload.contextType === '1v1' && (isGroupMode || currentScreen !== 'chat')) {
    return;
  }

  if (payload.closed) {
    resetEmbeddedGameUi();
    if (payload.systemNotice) addSystemMessage(payload.systemNotice);
    if (payload.closedByName && payload.closedByName !== nickname) {
      showToast(`${payload.closedByName} đã đóng trò chơi`, 'info');
    }
    return;
  }

  const prevState = embeddedGame ? embeddedGame.gameState : null;
  const wasNewTable = !embeddedGame;

  embeddedGame = {
    roomId: payload.roomId,
    roomCode: payload.roomCode || '',
    name: payload.name || (payload.gameInfo && payload.gameInfo.name) || 'Trò chơi',
    contextType: payload.contextType || (isGroupMode ? 'group' : '1v1'),
    groupId: payload.groupId || null,
    isBotSession: Boolean(payload.isBotSession),
    allowAnyPlayerControl: Boolean(payload.allowAnyPlayerControl),
    gameType: payload.gameType,
    gameInfo: payload.gameInfo,
    hostId: payload.hostId,
    maxPlayers: payload.maxPlayers || (isGroupMode ? 10 : 2),
    playerCount: payload.playerCount || (Array.isArray(payload.players) ? payload.players.length : 1),
    status: payload.status || 'lobby',
    gameState: payload.gameState || { gameType: payload.gameType, phase: 'lobby' },
  };
  embeddedGamePlayers = Array.isArray(payload.players) ? payload.players : [];

  if (payload.gameState) {
    if (
      payload.gameState.gameType === 'quiz_race'
      && (!prevState || prevState.currentIndex !== payload.gameState.currentIndex || prevState.phase !== payload.gameState.phase)
    ) {
      if (payload.gameState.phase === 'question') myQuizSelection = null;
    }
    if (
      payload.gameState.gameType === 'undercover'
      && (!prevState || prevState.round !== payload.gameState.round || prevState.phase !== payload.gameState.phase)
    ) {
      if (payload.gameState.phase === 'vote') myUndercoverVote = null;
      if (payload.gameState.phase === 'lobby') myPrivateGameSecret = null;
    }
  }

  if (payload.systemNotice) {
    addSystemMessage(payload.systemNotice);
  }

  // Đóng bàn Caro 1-1 cũ nếu đang mở
  if (el.gamePanel) el.gamePanel.classList.add('hidden');
  if (el.modalGameInvite) el.modalGameInvite.classList.add('hidden');

  if (el.btnMinigame) el.btnMinigame.classList.add('has-live-game');
  if (el.btnMinigameLabel) {
    el.btnMinigameLabel.textContent = isGroupMode
      ? `Game (${embeddedGame.playerCount}/${embeddedGame.maxPlayers})`
      : 'Đổi Game';
  }

  if (wasNewTable) embeddedGameMinimized = false;

  if (!embeddedGameMinimized) {
    if (isGroupMode && el.groupPanel) el.groupPanel.classList.add('hidden');
    if (el.multiGamePanel) el.multiGamePanel.classList.remove('hidden');
    updateGameRoomHeaderAndArena();
  }
}

function updateGameRoomHeaderAndArena() {
  const arenaRoom = getActiveArenaRoom();
  const arenaPlayers = getActiveArenaPlayers();
  if (!arenaRoom) return;

  const isDedicated = isGameRoomMode;
  const isGroupEmbedded = !isDedicated && arenaRoom.contextType === 'group';
  const is1v1Embedded = !isDedicated && arenaRoom.contextType === '1v1';
  const info = arenaRoom.gameInfo || { icon: '🎮', name: 'Phòng Game', minPlayers: 2 };
  const gs = arenaRoom.gameState || { phase: 'lobby' };
  const isSeated = isDedicated || arenaPlayers.some((p) => p.clientId === clientId);
  const canControl = isSeated && (arenaRoom.hostId === clientId || Boolean(arenaRoom.allowAnyPlayerControl));

  // Chỉ cập nhật header khung chat khi đang ở Phòng Game chuyên biệt
  if (isDedicated) {
    if (el.partnerAvatar) el.partnerAvatar.textContent = info.icon || '🎮';
    if (el.partnerNickname) el.partnerNickname.textContent = arenaRoom.name;
    if (el.commonInterests) {
      el.commonInterests.textContent = `🎮 Chat phòng game (${arenaRoom.playerCount}/${arenaRoom.maxPlayers}) • Gõ @ để tag người chơi`;
    }
  }

  // Cập nhật topbar đấu trường game
  if (el.multiGameIcon) el.multiGameIcon.textContent = info.icon || '🎮';
  if (el.multiGameTitle) el.multiGameTitle.textContent = info.name || 'Phòng Game';

  if (el.btnCopyGameCode) el.btnCopyGameCode.classList.toggle('hidden', !isDedicated);
  if (el.multiGameCode && isDedicated) el.multiGameCode.textContent = arenaRoom.roomCode || '------';

  if (el.multiGameModeBadge) {
    el.multiGameModeBadge.classList.toggle('hidden', isDedicated);
    if (isGroupEmbedded) {
      el.multiGameModeBadge.textContent = '👥 Bàn Game Nhóm';
    } else if (is1v1Embedded) {
      el.multiGameModeBadge.textContent = arenaRoom.isBotSession ? '🤖 Đấu cùng Lumi' : '💬 Chơi trong Chat 1-1';
    }
  }

  if (el.multiGameCountPill) el.multiGameCountPill.textContent = `👥 ${arenaRoom.playerCount}/${arenaRoom.maxPlayers}`;

  if (el.btnMultiGameSeat) {
    el.btnMultiGameSeat.classList.toggle('hidden', !isGroupEmbedded);
    if (isGroupEmbedded) {
      const isFull = arenaRoom.playerCount >= arenaRoom.maxPlayers;
      if (isSeated) {
        el.btnMultiGameSeat.textContent = '👋 Rời bàn';
        el.btnMultiGameSeat.className = 'btn btn-secondary btn-small';
        el.btnMultiGameSeat.disabled = false;
      } else {
        el.btnMultiGameSeat.textContent = isFull
          ? 'Đã đầy bàn'
          : `🙋 Tham gia (${arenaRoom.playerCount}/${arenaRoom.maxPlayers})`;
        el.btnMultiGameSeat.className = 'btn btn-primary btn-small';
        el.btnMultiGameSeat.disabled = isFull;
      }
    }
  }

  if (el.btnMultiGameClose) {
    el.btnMultiGameClose.classList.toggle('hidden', isDedicated);
    el.btnMultiGameClose.title = isGroupEmbedded && arenaRoom.hostId !== clientId
      ? 'Thu gọn bảng game (vẫn ở trong nhóm chat)'
      : 'Đóng trò chơi';
  }

  const inLobbyOrEnded = gs.phase === 'lobby' || gs.phase === 'ended';
  if (el.btnMultiGameStart) {
    el.btnMultiGameStart.classList.toggle('hidden', !canControl || !inLobbyOrEnded);
    el.btnMultiGameStart.textContent = gs.phase === 'ended' ? '🔄 Chơi ván mới' : '▶ Bắt đầu';
    el.btnMultiGameStart.disabled = arenaRoom.playerCount < (info.minPlayers || 2);
  }
  if (el.btnMultiGameLobby) {
    el.btnMultiGameLobby.classList.toggle('hidden', !canControl || gs.phase === 'lobby');
  }
  if (el.multiGameSwitcher) {
    el.multiGameSwitcher.classList.toggle('hidden', !canControl || !inLobbyOrEnded);
    el.multiGameSwitcher.querySelectorAll('.mini-game-chip').forEach((chip) => {
      const isUndercover1v1 = is1v1Embedded && chip.dataset.game === 'undercover';
      chip.classList.toggle('hidden', isUndercover1v1);
      chip.classList.toggle('active', chip.dataset.game === arenaRoom.gameType);
    });
  }

  syncMultiGameCountdown(gs.endsAt || null);
  renderGameRoomPlayersStrip();
  renderMultiGameArenaBody();
}

function renderGameRoomPlayersStrip() {
  const arenaRoom = getActiveArenaRoom();
  const arenaPlayers = getActiveArenaPlayers();
  if (!el.multiGamePlayersStrip || !arenaRoom) return;
  const gs = arenaRoom.gameState || {};
  const turnId = gs.turnClientId || gs.turn || null;
  const eliminated = new Set(gs.eliminatedIds || []);
  const canMentionInChat = isGameRoomMode || isGroupMode;

  el.multiGamePlayersStrip.textContent = '';
  const sorted = [...arenaPlayers].sort((a, b) => (b.score || 0) - (a.score || 0));

  sorted.forEach((p) => {
    const isMe = p.clientId === clientId;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `player-score-pill${isMe ? ' is-me' : ''}${turnId === p.clientId ? ' is-turn' : ''}${eliminated.has(p.clientId) ? ' eliminated' : ''}`;
    pill.title = isMe
      ? `Biệt danh của bạn: ${p.nickname}`
      : (canMentionInChat ? `Bấm để nhắc đến @${p.nickname} trong khung chat` : p.nickname);

    const crown = p.isHost ? '👑 ' : '';
    const livesInfo = (gs.gameType === 'word_chain' && gs.lives && typeof gs.lives[p.clientId] === 'number')
      ? ` ${'❤️'.repeat(gs.lives[p.clientId])}`
      : '';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = `${crown}${p.avatar || '🦊'} ${p.nickname}${isMe ? ' (Bạn)' : ''}${livesInfo}`;

    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'player-pill-score';
    scoreSpan.textContent = `${p.score || 0}đ`;

    pill.appendChild(labelSpan);
    pill.appendChild(scoreSpan);

    if (!isMe && canMentionInChat) {
      pill.addEventListener('click', () => insertMentionIntoInput(p.nickname));
    }

    el.multiGamePlayersStrip.appendChild(pill);
  });
}

function renderPodiumBlock(podium = []) {
  const wrap = document.createElement('div');
  wrap.className = 'podium-card';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight: 800; font-size: 0.92rem; text-align: center; margin-bottom: 4px;';
  title.textContent = '🏆 Bảng Xếp Hạng Ván Đấu';
  wrap.appendChild(title);

  const medals = ['🥇', '🥈', '🥉'];
  podium.slice(0, 10).forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = `podium-row${idx === 0 ? ' rank-1' : ''}`;

    const left = document.createElement('span');
    left.textContent = `${medals[idx] || `#${idx + 1}`} ${p.avatar || '🦊'} ${p.nickname}${p.clientId === clientId ? ' (Bạn)' : ''}`;

    const right = document.createElement('span');
    right.style.cssText = 'font-family: var(--font-mono); color: var(--warning);';
    right.textContent = `${p.score} điểm`;

    row.appendChild(left);
    row.appendChild(right);
    wrap.appendChild(row);
  });

  return wrap;
}

function renderMultiGameArenaBody() {
  const arenaRoom = getActiveArenaRoom();
  const arenaPlayers = getActiveArenaPlayers();
  if (!el.multiGameArenaBody || !arenaRoom) return;
  const gs = arenaRoom.gameState || { phase: 'lobby' };
  const info = arenaRoom.gameInfo || { icon: '🎮', name: 'Phòng Game', minPlayers: 2, description: '' };
  const isSeated = isGameRoomMode || arenaPlayers.some((p) => p.clientId === clientId);
  const canControl = isSeated && (arenaRoom.hostId === clientId || Boolean(arenaRoom.allowAnyPlayerControl));

  el.multiGameArenaBody.textContent = '';

  // ── Trạng thái chờ trong sảnh phòng / bàn game ────────────
  if (gs.phase === 'lobby') {
    const box = document.createElement('div');
    box.className = 'arena-hero-box';

    const icon = document.createElement('div');
    icon.className = 'arena-big-icon';
    icon.textContent = info.icon || '🎮';

    const h3 = document.createElement('h3');
    h3.textContent = info.name;

    const desc = document.createElement('p');
    desc.textContent = info.description || 'Sẵn sàng chơi cùng những người bạn ẩn danh!';

    const readyText = document.createElement('p');
    const need = Math.max(0, (info.minPlayers || 2) - arenaRoom.playerCount);
    readyText.style.fontWeight = '700';
    if (need > 0) {
      readyText.textContent = isGameRoomMode
        ? `⏳ Đang có ${arenaRoom.playerCount}/${arenaRoom.maxPlayers} người — cần thêm ${need} người nữa để bắt đầu (chia sẻ mã phòng ${arenaRoom.roomCode} hoặc đợi người chơi mới vào).`
        : `⏳ Đang có ${arenaRoom.playerCount}/${arenaRoom.maxPlayers} người ngồi bàn — cần thêm ${need} người bấm "🙋 Tham gia" để bắt đầu!`;
    } else if (canControl) {
      readyText.textContent = `✅ Đã đủ người chơi (${arenaRoom.playerCount}/${arenaRoom.maxPlayers})! Bấm "▶ Bắt đầu" ở góc trên hoặc đổi game khác nhé!`;
    } else if (!isSeated) {
      readyText.textContent = `👀 Bàn game đang mở (${arenaRoom.playerCount}/${arenaRoom.maxPlayers})! Bấm "🙋 Tham gia" ở góc trên để vào chơi hoặc ngồi xem trực tiếp!`;
    } else {
      readyText.textContent = `✅ Đã đủ người chơi (${arenaRoom.playerCount}/${arenaRoom.maxPlayers})! Đang chờ chủ bàn bấm bắt đầu…`;
    }

    box.appendChild(icon);
    box.appendChild(h3);
    box.appendChild(desc);
    box.appendChild(readyText);
    el.multiGameArenaBody.appendChild(box);
    return;
  }

  // ── GAME 1: ⚡ Đố Vui Tốc Độ ──────────────────────────────
  if (gs.gameType === 'quiz_race') {
    if (gs.phase === 'ended') {
      el.multiGameArenaBody.appendChild(renderPodiumBlock(gs.podium || []));
      return;
    }

    const card = document.createElement('div');
    card.className = 'quiz-question-card';

    const meta = document.createElement('div');
    meta.className = 'quiz-meta-row';
    meta.textContent = `CÂU ${(gs.currentIndex || 0) + 1} / ${gs.totalQuestions || 8} • ${(gs.question && gs.question.category) || 'Đố vui'} • Đã chốt: ${gs.answeredCount || 0}/${arenaRoom.playerCount}`;

    const qText = document.createElement('div');
    qText.className = 'quiz-question-text';
    qText.textContent = (gs.question && gs.question.q) || '';

    card.appendChild(meta);
    card.appendChild(qText);
    el.multiGameArenaBody.appendChild(card);

    const grid = document.createElement('div');
    grid.className = 'quiz-options-grid';
    const letters = ['A', 'B', 'C', 'D'];
    const alreadyAnswered = (gs.answeredIds || []).includes(clientId);

    ((gs.question && gs.question.options) || []).forEach((optText, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiz-option-btn';
      if (myQuizSelection === idx) btn.classList.add('selected');
      if (gs.phase === 'reveal') {
        if (idx === gs.correctIndex) btn.classList.add('correct');
        else if (myQuizSelection === idx) btn.classList.add('wrong');
      }
      btn.disabled = !isSeated || gs.phase !== 'question' || alreadyAnswered;

      const letter = document.createElement('span');
      letter.className = 'quiz-opt-letter';
      letter.textContent = letters[idx];

      const label = document.createElement('span');
      label.textContent = optText;

      btn.appendChild(letter);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        myQuizSelection = idx;
        sendActiveArenaAction({ action: 'answer', optionIndex: idx });
        playGameClickSound();
        renderMultiGameArenaBody();
      });
      grid.appendChild(btn);
    });
    el.multiGameArenaBody.appendChild(grid);

    if (gs.phase === 'reveal' && Array.isArray(gs.roundResults)) {
      const resBox = document.createElement('div');
      resBox.className = 'arena-status-banner';
      const winners = gs.roundResults.filter((r) => r.isCorrect);
      resBox.textContent = winners.length > 0
        ? `🎉 Trả lời đúng: ${winners.map((w) => `${w.nickname} (+${w.gained}đ)`).join(', ')}`
        : '😅 Chưa ai chọn đúng câu này! Chuẩn bị câu tiếp theo…';
      el.multiGameArenaBody.appendChild(resBox);
    }
    return;
  }

  // ── GAME 2: ⛓️ Nối Từ Thần Tốc ────────────────────────────
  if (gs.gameType === 'word_chain') {
    if (gs.phase === 'ended') {
      const banner = document.createElement('div');
      banner.className = 'arena-status-banner my-turn';
      banner.textContent = `🏆 Chiến thắng Nối Từ Thần Tốc: ${gs.winnerName || 'Tất cả người chơi'}!`;
      el.multiGameArenaBody.appendChild(banner);
      el.multiGameArenaBody.appendChild(renderPodiumBlock(gs.podium || []));
      return;
    }

    const isMyTurn = gs.turnClientId === clientId;
    const banner = document.createElement('div');
    banner.className = `arena-status-banner${isMyTurn ? ' my-turn' : ''}`;
    banner.textContent = isMyTurn
      ? `👉 ĐẾN LƯỢT BẠN! Nhập từ 2 tiếng bắt đầu bằng "${gs.requiredStart}"`
      : `⏳ Đang chờ ${gs.turnNickname || 'người chơi'} nối tiếp từ "${gs.requiredStart}"…`;
    el.multiGameArenaBody.appendChild(banner);

    const curBox = document.createElement('div');
    curBox.className = 'word-chain-current';
    const parts = (gs.currentWord || '').split(' ');
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size: 0.74rem; color: var(--text-muted); font-weight: 700;';
    sub.textContent = `CHUỖI TỪ (${gs.chainLength || 1}/${gs.maxChainLength || 24})`;

    const big = document.createElement('div');
    big.className = 'word-chain-big';
    big.appendChild(document.createTextNode((parts[0] || '') + ' '));
    const hl = document.createElement('span');
    hl.className = 'highlight-syllable';
    hl.textContent = parts[1] || gs.requiredStart || '';
    big.appendChild(hl);

    curBox.appendChild(sub);
    curBox.appendChild(big);
    if (gs.lastEvent) {
      const ev = document.createElement('div');
      ev.style.cssText = 'font-size: 0.78rem; color: var(--text-secondary);';
      ev.textContent = gs.lastEvent;
      curBox.appendChild(ev);
    }
    el.multiGameArenaBody.appendChild(curBox);

    if (isMyTurn) {
      const form = document.createElement('form');
      form.className = 'arena-inline-form';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'emoji-search-input';
      input.maxLength = 40;
      input.placeholder = `Ví dụ: ${gs.requiredStart} ... (2 tiếng)`;
      input.value = `${gs.requiredStart} `;

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'btn btn-primary btn-small';
      submit.textContent = '⛓️ Nối ngay';

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const word = input.value.trim();
        if (!word) return;
        sendActiveArenaAction({ action: 'submit_word', word });
        playGameClickSound();
      });

      form.appendChild(input);
      form.appendChild(submit);
      el.multiGameArenaBody.appendChild(form);
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 40);
    }

    const trail = document.createElement('div');
    trail.className = 'word-chain-trail';
    (gs.chain || []).forEach((item) => {
      const chip = document.createElement('span');
      chip.className = 'word-chain-chip';
      chip.appendChild(document.createTextNode(item.word));
      const small = document.createElement('small');
      small.textContent = `• ${item.nickname}`;
      chip.appendChild(small);
      trail.appendChild(chip);
    });
    el.multiGameArenaBody.appendChild(trail);
    return;
  }

  // ── GAME 3: 🕵️ Ai Là Gián Điệp? ──────────────────────────
  if (gs.gameType === 'undercover') {
    if (myPrivateGameSecret && myPrivateGameSecret.secretWord && gs.phase !== 'ended') {
      const secCard = document.createElement('div');
      secCard.className = 'secret-word-card';
      secCard.title = 'Bấm để ẩn/hiện từ bí mật của bạn';

      const left = document.createElement('div');
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size: 0.72rem; font-weight: 700; color: var(--text-secondary);';
      lbl.textContent = '🤫 TỪ BÍ MẬT CỦA RIÊNG BẠN (Bấm để ẩn/hiện)';
      const val = document.createElement('div');
      val.className = 'secret-word-value';
      val.textContent = secretWordHidden ? '••••••' : myPrivateGameSecret.secretWord;
      left.appendChild(lbl);
      left.appendChild(val);

      const eye = document.createElement('span');
      eye.textContent = secretWordHidden ? '👁️ Hiện' : '🙈 Ẩn';
      eye.style.fontSize = '0.8rem';

      secCard.appendChild(left);
      secCard.appendChild(eye);
      secCard.addEventListener('click', () => {
        secretWordHidden = !secretWordHidden;
        renderMultiGameArenaBody();
      });
      el.multiGameArenaBody.appendChild(secCard);
    }

    if (gs.phase === 'ended') {
      const banner = document.createElement('div');
      banner.className = 'arena-status-banner my-turn';
      banner.textContent = gs.winnerSide === 'civilians'
        ? '🎉 DÂN THƯỜNG CHIẾN THẮNG! Đã tìm ra toàn bộ gián điệp!'
        : '🕵️ GIÁN ĐIỆP CHIẾN THẮNG! Ẩn mình quá đỉnh!';
      el.multiGameArenaBody.appendChild(banner);

      if (gs.revealSecret) {
        const rev = document.createElement('div');
        rev.className = 'arena-hero-box';
        const p1 = document.createElement('p');
        p1.style.fontWeight = '700';
        p1.textContent = `🙂 Từ dân thường: "${gs.revealSecret.civilianWord}"  |  🕵️ Từ gián điệp: "${gs.revealSecret.spyWord}"`;
        const p2 = document.createElement('p');
        p2.textContent = `Gián điệp trong ván: ${(gs.revealSecret.spies || []).map((s) => s.nickname).join(', ')}`;
        rev.appendChild(p1);
        rev.appendChild(p2);
        el.multiGameArenaBody.appendChild(rev);
      }

      el.multiGameArenaBody.appendChild(renderPodiumBlock(gs.podium || []));
      return;
    }

    const isAlive = (gs.aliveIds || []).includes(clientId);

    if (gs.phase === 'clue') {
      const submitted = (gs.submittedClueIds || []).includes(clientId);
      const banner = document.createElement('div');
      banner.className = `arena-status-banner${isAlive && !submitted ? ' my-turn' : ''}`;
      banner.textContent = `🕵️ Vòng ${gs.round || 1} — Pha Mô Tả (${(gs.submittedClueIds || []).length}/${(gs.aliveIds || []).length} đã gửi)`;
      el.multiGameArenaBody.appendChild(banner);

      if (isAlive && !submitted) {
        const form = document.createElement('form');
        form.className = 'arena-inline-form';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'emoji-search-input';
        input.maxLength = 80;
        input.placeholder = 'Mô tả ngắn về từ bí mật (KHÔNG nhắc trực tiếp từ đó)…';

        const btn = document.createElement('button');
        btn.type = 'submit';
        btn.className = 'btn btn-primary btn-small';
        btn.textContent = 'Gửi gợi ý';

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const clue = input.value.trim();
          if (clue.length < 2) {
            showToast('Gợi ý cần ít nhất 2 ký tự!', 'warning');
            return;
          }
          sendActiveArenaAction({ action: 'submit_clue', clue });
          playGameClickSound();
        });
        form.appendChild(input);
        form.appendChild(btn);
        el.multiGameArenaBody.appendChild(form);
      } else {
        const waitBox = document.createElement('div');
        waitBox.className = 'arena-hero-box';
        const p = document.createElement('p');
        p.textContent = isAlive
          ? '✅ Bạn đã gửi gợi ý! Đang chờ các người chơi khác hoàn thành…'
          : '👀 Bạn đã bị loại — hãy theo dõi xem ai là Gián điệp nhé!';
        waitBox.appendChild(p);
        el.multiGameArenaBody.appendChild(waitBox);
      }
      return;
    }

    if (gs.phase === 'vote' || gs.phase === 'round_result') {
      const banner = document.createElement('div');
      banner.className = `arena-status-banner${gs.phase === 'vote' && isAlive ? ' my-turn' : ''}`;
      if (gs.phase === 'vote') {
        banner.textContent = `🗳️ Thảo luận & Bỏ phiếu tìm Gián điệp (${(gs.votedIds || []).length}/${(gs.aliveIds || []).length} đã bầu)`;
      } else if (gs.lastElimination && gs.lastElimination.tied) {
        banner.textContent = '⚖️ Phiếu hòa! Không ai bị loại vòng này. Chuẩn bị vòng tiếp theo…';
      } else if (gs.lastElimination) {
        banner.textContent = gs.lastElimination.wasSpy
          ? `🎯 ${gs.lastElimination.nickname} bị loại và ĐÚNG LÀ GIÁN ĐIỆP!`
          : `😱 ${gs.lastElimination.nickname} bị loại nhưng là Dân thường!`;
      }
      el.multiGameArenaBody.appendChild(banner);

      const grid = document.createElement('div');
      grid.className = 'clues-grid';
      const aliveSet = new Set(gs.aliveIds || []);

      (gs.clues || []).forEach((item) => {
        const card = document.createElement('div');
        card.className = `clue-card${!aliveSet.has(item.clientId) ? ' eliminated' : ''}`;

        const head = document.createElement('div');
        head.className = 'clue-card-head';
        head.textContent = `${item.avatar || '🦊'} ${item.nickname}${item.clientId === clientId ? ' (Bạn)' : ''}`;

        const text = document.createElement('div');
        text.className = 'clue-card-text';
        text.textContent = `"${item.clue}"`;

        card.appendChild(head);
        card.appendChild(text);

        if (gs.phase === 'vote' && isAlive && item.clientId !== clientId && aliveSet.has(item.clientId)) {
          const voteBtn = document.createElement('button');
          voteBtn.type = 'button';
          const isVoted = myUndercoverVote === item.clientId;
          voteBtn.className = `btn btn-small ${isVoted ? 'btn-danger' : 'btn-secondary'}`;
          voteBtn.textContent = isVoted ? '✅ Đã bầu loại người này' : '🗳️ Bầu là Gián điệp';
          voteBtn.addEventListener('click', () => {
            myUndercoverVote = item.clientId;
            sendActiveArenaAction({ action: 'vote', targetClientId: item.clientId });
            playGameClickSound();
            renderMultiGameArenaBody();
          });
          card.appendChild(voteBtn);
        }

        grid.appendChild(card);
      });
      el.multiGameArenaBody.appendChild(grid);
    }
    return;
  }

  // ── GAME 4: 💣 Đặt Bom Số ─────────────────────────────────
  if (gs.gameType === 'number_bomb') {
    if (gs.phase === 'ended') {
      const banner = document.createElement('div');
      banner.className = 'arena-status-banner my-turn';
      banner.textContent = `🏆 Người sống sót cuối cùng: ${gs.winnerName || 'Hòa'}!`;
      el.multiGameArenaBody.appendChild(banner);
      el.multiGameArenaBody.appendChild(renderPodiumBlock(gs.podium || []));
      return;
    }

    const isMyTurn = gs.phase === 'playing' && gs.turnClientId === clientId;
    const minVal = (gs.minBound ?? 0) + 1;
    const maxVal = (gs.maxBound ?? 101) - 1;

    const banner = document.createElement('div');
    banner.className = `arena-status-banner${gs.phase === 'boom' ? ' boom' : (isMyTurn ? ' my-turn' : '')}`;
    if (gs.phase === 'boom' && gs.lastBoom) {
      banner.textContent = `💥 BÙM! ${gs.lastBoom.victimNickname} dính bom số ${gs.lastBoom.bombNumber}! Đang nạp quả bom mới…`;
    } else if (isMyTurn) {
      banner.textContent = `👉 ĐẾN LƯỢT BẠN! Chọn 1 số an toàn từ ${minVal} đến ${maxVal}`;
    } else {
      banner.textContent = `⏳ Đang chờ ${gs.turnNickname || 'người chơi'} chọn số (${minVal} – ${maxVal})…`;
    }
    el.multiGameArenaBody.appendChild(banner);

    const rangeBox = document.createElement('div');
    rangeBox.className = 'bomb-range-display';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size: 0.74rem; font-weight: 700; color: var(--text-muted);';
    lbl.textContent = `VÒNG ${gs.round || 1} • KHOẢNG AN TOÀN HIỆN TẠI`;

    const bigRange = document.createElement('div');
    bigRange.className = 'bomb-range-numbers';
    bigRange.textContent = `${minVal}  ⋯  ${maxVal}`;

    rangeBox.appendChild(lbl);
    rangeBox.appendChild(bigRange);

    if (isMyTurn) {
      const form = document.createElement('form');
      form.className = 'arena-inline-form';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(minVal);
      input.max = String(maxVal);
      input.className = 'emoji-search-input';
      input.placeholder = `Nhập số (${minVal} - ${maxVal})…`;

      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.className = 'btn btn-primary btn-small';
      btn.textContent = '💣 Chốt số!';

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const num = parseInt(input.value, 10);
        if (isNaN(num) || num < minVal || num > maxVal) {
          showToast(`Vui lòng chọn số nguyên từ ${minVal} đến ${maxVal}!`, 'warning');
          return;
        }
        sendActiveArenaAction({ action: 'guess_number', number: num });
        playGameClickSound();
      });
      form.appendChild(input);
      form.appendChild(btn);
      rangeBox.appendChild(form);

      // Các nút chọn nhanh tiện lợi
      const quickRow = document.createElement('div');
      quickRow.className = 'bomb-quick-picks';
      const picks = [...new Set([
        minVal,
        Math.floor((minVal + maxVal) / 2),
        maxVal,
      ])].filter((n) => n >= minVal && n <= maxVal);
      picks.forEach((n) => {
        const qBtn = document.createElement('button');
        qBtn.type = 'button';
        qBtn.className = 'topic-preset-chip';
        qBtn.textContent = `Chọn nhanh ${n}`;
        qBtn.addEventListener('click', () => {
          sendActiveArenaAction({ action: 'guess_number', number: n });
          playGameClickSound();
        });
        quickRow.appendChild(qBtn);
      });
      rangeBox.appendChild(quickRow);
      setTimeout(() => input.focus(), 40);
    }

    el.multiGameArenaBody.appendChild(rangeBox);

    if (Array.isArray(gs.history) && gs.history.length > 0) {
      const trail = document.createElement('div');
      trail.className = 'word-chain-trail';
      gs.history.forEach((h) => {
        const chip = document.createElement('span');
        chip.className = 'word-chain-chip';
        chip.textContent = `${h.boom ? '💥' : '✅'} ${h.number} (${h.nickname})`;
        trail.appendChild(chip);
      });
      el.multiGameArenaBody.appendChild(trail);
    }
    return;
  }

  // ── GAME 5: ⚔️ Cờ Caro Khán Đài ──────────────────────────
  if (gs.gameType === 'caro_arena') {
    const isDuelist = clientId === gs.xPlayer || clientId === gs.oPlayer;
    const isMyTurn = gs.phase === 'playing' && gs.turn === clientId;

    const banner = document.createElement('div');
    banner.className = `arena-status-banner${isMyTurn ? ' my-turn' : ''}`;
    if (gs.phase === 'ended') {
      banner.textContent = gs.winner === 'draw'
        ? '🤝 Ván cờ hòa!'
        : `🏆 ${gs.winnerName || gs.winner} chiến thắng! Chủ phòng có thể bấm "Chơi ván mới" để người tiếp theo lên sàn!`;
    } else if (isMyTurn) {
      banner.textContent = `👉 Đến lượt BẠN (${clientId === gs.xPlayer ? 'X' : 'O'}) — ${gs.xNickname} (X) vs ${gs.oNickname} (O)`;
    } else {
      const turnName = gs.turn === gs.xPlayer ? gs.xNickname : gs.oNickname;
      const specText = !isDuelist ? ` • 👀 Bạn đang ở khán đài (${gs.spectatorCount || 0} khán giả)` : '';
      banner.textContent = `⏳ Lượt của ${turnName}${specText}`;
    }
    el.multiGameArenaBody.appendChild(banner);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'board-scroll-wrapper';
    const boardEl = document.createElement('div');
    const size = gs.size || 15;
    boardEl.className = `tictactoe-board size-${size}`;
    const winSet = new Set(gs.winningLine || []);

    (gs.board || []).forEach((val, idx) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      if (val === 'X') cell.classList.add('x');
      if (val === 'O') cell.classList.add('o');
      if (gs.lastMove === idx) cell.classList.add('last-move');
      if (winSet.has(idx)) cell.classList.add('winner');
      cell.textContent = val || '';
      cell.disabled = Boolean(val) || gs.phase !== 'playing' || !isMyTurn;
      cell.addEventListener('click', () => {
        sendActiveArenaAction({ action: 'caro_move', index: idx });
        playGameClickSound();
      });
      boardEl.appendChild(cell);
    });
    scrollWrap.appendChild(boardEl);
    el.multiGameArenaBody.appendChild(scrollWrap);

    if (gs.phase === 'ended') {
      el.multiGameArenaBody.appendChild(renderPodiumBlock(gs.podium || []));
    }
  }
}

function renderGameRoomBrowseList(rooms, maxPlayers = 10) {
  if (!el.gameRoomBrowseList) return;
  el.gameRoomBrowseList.textContent = '';

  if (!rooms || rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty-state';
    empty.innerHTML = `
      <span class="group-empty-icon">🎮</span>
      <p>Hiện chưa có phòng game nào đang mở. Tạo ngay phòng đầu tiên để mời mọi người cùng chơi!</p>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-small';
    btn.textContent = '✨ Tạo phòng ngay';
    btn.addEventListener('click', () => setGameHubTab('play'));
    empty.appendChild(btn);
    el.gameRoomBrowseList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  rooms.forEach((r) => {
    const isFull = r.playerCount >= (r.maxPlayers || maxPlayers);
    const card = document.createElement('div');
    card.className = 'group-list-card';

    const info = document.createElement('div');
    info.className = 'group-list-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'group-list-title-row';

    const badge = document.createElement('span');
    badge.className = 'group-mode-badge topic';
    badge.textContent = `${r.gameIcon || '🎮'} ${r.gameName || r.gameType}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'group-list-name';
    nameEl.textContent = r.name;

    titleRow.appendChild(badge);
    titleRow.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'group-list-meta';
    const statusLabel = r.status === 'playing' ? '🔥 Đang đấu' : '🟢 Đang chờ';
    meta.textContent = `👥 ${r.playerCount}/${r.maxPlayers || maxPlayers} người • 🔑 ${r.roomCode} • ${statusLabel}`;

    info.appendChild(titleRow);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'group-list-actions';

    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'btn btn-primary btn-small';
    joinBtn.disabled = isFull;
    joinBtn.textContent = isFull ? 'Đã đầy' : 'Vào phòng →';
    joinBtn.addEventListener('click', () => {
      collectLobbyProfileForGroup();
      send('game_room_join', { roomId: r.roomId });
    });

    actions.appendChild(joinBtn);
    card.appendChild(info);
    card.appendChild(actions);
    fragment.appendChild(card);
  });

  el.gameRoomBrowseList.appendChild(fragment);
}

// ── Event Listeners cho Phòng Game Nhiều Người ─────────────
if (el.btnOpenGameHub) {
  el.btnOpenGameHub.addEventListener('click', () => openGameHub('play'));
}
if (el.btnCloseGameHub) {
  el.btnCloseGameHub.addEventListener('click', closeGameHub);
}
if (el.modalGameHub) {
  const backdrop = el.modalGameHub.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeGameHub);
}
if (el.gameHubTabs) {
  el.gameHubTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.group-hub-tab');
    if (!tab || !tab.dataset.tab) return;
    setGameHubTab(tab.dataset.tab);
  });
}
if (el.gameCatalogGrid) {
  el.gameCatalogGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.game-choice-card');
    if (!card || !card.dataset.game) return;
    selectedHubGameType = card.dataset.game;
    el.gameCatalogGrid.querySelectorAll('.game-choice-card').forEach((c) => {
      c.classList.toggle('active', c === card);
    });
    playTone(560, 'sine', 0.04, 0.05);
  });
}
if (el.btnGameRoomQuick) {
  el.btnGameRoomQuick.addEventListener('click', () => {
    collectLobbyProfileForGroup();
    send('game_room_find', { gameType: selectedHubGameType });
  });
}
if (el.btnGameRoomCreate) {
  el.btnGameRoomCreate.addEventListener('click', () => {
    collectLobbyProfileForGroup();
    const name = el.inputGameRoomName ? el.inputGameRoomName.value.trim() : '';
    const maxPlayers = el.selectGameMaxPlayers ? parseInt(el.selectGameMaxPlayers.value, 10) : 10;
    send('game_room_create', {
      gameType: selectedHubGameType,
      name,
      maxPlayers: Number.isInteger(maxPlayers) ? maxPlayers : 10,
    });
  });
}
if (el.btnGameRoomJoinCode) {
  el.btnGameRoomJoinCode.addEventListener('click', () => {
    const code = el.inputGameRoomCode ? el.inputGameRoomCode.value.trim().toUpperCase() : '';
    if (!code || code.length < 4) {
      showToast('Vui lòng nhập mã phòng game hợp lệ (6 ký tự)!', 'warning');
      el.inputGameRoomCode?.focus();
      return;
    }
    collectLobbyProfileForGroup();
    send('game_room_join', { roomCode: code });
  });
}
if (el.gameBrowseFilters) {
  el.gameBrowseFilters.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill || !pill.dataset.game) return;
    gameBrowseFilter = pill.dataset.game;
    el.gameBrowseFilters.querySelectorAll('.filter-pill').forEach((p) => {
      p.classList.toggle('active', p === pill);
    });
    requestGameRoomList();
  });
}
if (el.btnRefreshGameRooms) {
  el.btnRefreshGameRooms.addEventListener('click', requestGameRoomList);
}
if (el.btnCopyGameCode) {
  el.btnCopyGameCode.addEventListener('click', () => {
    if (!currentGameRoom || !currentGameRoom.roomCode) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentGameRoom.roomCode).then(() => {
        showToast(`Đã sao chép mã phòng: ${currentGameRoom.roomCode}`, 'success', 2000);
      }).catch(() => {
        showToast(`Mã phòng game: ${currentGameRoom.roomCode}`, 'info', 2500);
      });
    } else {
      showToast(`Mã phòng game: ${currentGameRoom.roomCode}`, 'info', 2500);
    }
  });
}
if (el.btnMultiGameSeat) {
  el.btnMultiGameSeat.addEventListener('click', () => {
    if (!embeddedGame || embeddedGame.contextType !== 'group') return;
    const isSeated = embeddedGamePlayers.some((p) => p.clientId === clientId);
    send(isSeated ? 'chat_game_leave' : 'chat_game_join');
    playGameClickSound();
  });
}
if (el.btnMultiGameClose) {
  el.btnMultiGameClose.addEventListener('click', () => {
    if (isGameRoomMode || !embeddedGame) return;
    if (embeddedGame.contextType === 'group' && embeddedGame.hostId !== clientId) {
      embeddedGameMinimized = true;
      if (el.multiGamePanel) el.multiGamePanel.classList.add('hidden');
      showToast('Đã thu gọn bảng game. Bấm nút "🎮 Game" ở trên để mở lại bất cứ lúc nào!', 'info', 2800);
      return;
    }
    send('chat_game_close');
  });
}
if (el.btnMultiGameStart) {
  el.btnMultiGameStart.addEventListener('click', () => {
    if (isGameRoomMode && currentGameRoom) {
      send('game_room_start');
      playGameClickSound();
    } else if (embeddedGame) {
      send('chat_game_start');
      playGameClickSound();
    }
  });
}
if (el.btnMultiGameLobby) {
  el.btnMultiGameLobby.addEventListener('click', () => {
    if (isGameRoomMode && currentGameRoom) {
      send('game_room_action', { action: 'back_to_lobby' });
    } else if (embeddedGame) {
      send('chat_game_action', { action: 'back_to_lobby' });
    }
  });
}
if (el.multiGameSwitcher) {
  el.multiGameSwitcher.addEventListener('click', (e) => {
    const chip = e.target.closest('.mini-game-chip');
    if (!chip || !chip.dataset.game) return;
    if (isGameRoomMode && currentGameRoom) {
      send('game_room_select_game', { gameType: chip.dataset.game });
    } else if (embeddedGame) {
      send('chat_game_select', { gameType: chip.dataset.game });
    }
    playGameClickSound();
  });
}

// ═══════════════════════════════════════════════════
// TÍNH NĂNG 7: GIỮ KẾT NỐI ẨN DANH 2 CHIỀU & MÃ HẸN GẶP LẠI (1-1)
// ═══════════════════════════════════════════════════

function loadSavedPairPasses() {
  try {
    const raw = localStorage.getItem(SAVED_PAIRS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.pairId === 'string' && typeof p.pairToken === 'string');
  } catch (_) {
    return [];
  }
}

function savePairPasses(passes) {
  try {
    localStorage.setItem(SAVED_PAIRS_STORAGE_KEY, JSON.stringify((passes || []).slice(0, 30)));
  } catch (_) {
    // Bỏ qua nếu localStorage bị giới hạn
  }
  updateSavedPairsBadge();
}

function upsertSavedPairPass(pass) {
  if (!pass || !pass.pairId || !pass.pairToken) return;
  const list = loadSavedPairPasses();
  const idx = list.findIndex((p) => p.pairId === pass.pairId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...pass };
  } else {
    list.unshift(pass);
  }
  savePairPasses(list);
}

function removeSavedPairPass(pairId) {
  if (!pairId) return;
  const filtered = loadSavedPairPasses().filter((p) => p.pairId !== pairId);
  savePairPasses(filtered);
  savedPairsLive = savedPairsLive.filter((p) => p.pairId !== pairId);
  renderSavedPairsList();
}

function updateSavedPairsBadge() {
  if (!el.savedPairsBadge) return;
  const list = savedPairsLive.length > 0 ? savedPairsLive : loadSavedPairPasses();
  const count = list.length;
  const onlineCount = savedPairsLive.filter((p) => p.partnerOnline || p.partnerWaitingInPair).length;

  el.savedPairsBadge.classList.toggle('hidden', count === 0);
  if (onlineCount > 0) {
    el.savedPairsBadge.textContent = `🟢 ${onlineCount} online • ${count}`;
  } else {
    el.savedPairsBadge.textContent = `💛 ${count}`;
  }
}

function syncSavedPairsWithServer() {
  const passes = loadSavedPairPasses();
  updateSavedPairsBadge();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (passes.length === 0) {
    savedPairsLive = [];
    renderSavedPairsList();
    return;
  }
  send('pair_sync', {
    passes: passes.map((p) => ({ pairId: p.pairId, pairToken: p.pairToken })),
  });
}

function copyPairCodeToClipboard(code) {
  if (!code) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => {
      showToast(`Đã sao chép Mã hẹn gặp lại: ${code}`, 'success', 2500);
    }).catch(() => {
      showToast(`Mã hẹn gặp lại của hai bạn: ${code}`, 'info', 3500);
    });
  } else {
    showToast(`Mã hẹn gặp lại của hai bạn: ${code}`, 'info', 3500);
  }
}

function updatePairKeepHeaderUi() {
  const showKeepBtn = !isGroupMode && !isGameRoomMode && !isCurrentPartnerBot && Boolean(currentPairKeep);
  if (el.btnPairKeep) {
    el.btnPairKeep.classList.toggle('hidden', !showKeepBtn);
    el.btnPairKeep.classList.remove('active', 'partner-wants', 'is-kept');
  }
  if (el.pairCodePill) {
    const showCode = showKeepBtn && Boolean(currentPairKeep && currentPairKeep.isKept && currentPairKeep.pairCode);
    el.pairCodePill.classList.toggle('hidden', !showCode);
    if (showCode && el.pairCodePillText) {
      el.pairCodePillText.textContent = currentPairKeep.pairCode;
    }
  }
  if (!showKeepBtn || !el.btnPairKeep || !el.btnPairKeepLabel) return;

  if (currentPairKeep.isKept) {
    el.btnPairKeep.classList.add('active', 'is-kept');
    el.btnPairKeepLabel.textContent = 'Đã giữ kết nối';
    el.btnPairKeep.title = `Đã Giữ kết nối (Mã: ${currentPairKeep.pairCode}). Bấm để hủy Giữ kết nối nếu muốn.`;
  } else if (currentPairKeep.myVote) {
    el.btnPairKeep.classList.add('active');
    el.btnPairKeepLabel.textContent = 'Chờ đối phương (1/2)';
    el.btnPairKeep.title = 'Bạn đã chọn Giữ kết nối. Bấm lại để bỏ chọn.';
  } else if (currentPairKeep.partnerVote) {
    el.btnPairKeep.classList.add('partner-wants');
    el.btnPairKeepLabel.textContent = 'Đồng ý Giữ kết nối!';
    el.btnPairKeep.title = 'Đối phương đang muốn Giữ kết nối với bạn — bấm để đồng ý!';
  } else {
    el.btnPairKeepLabel.textContent = 'Giữ kết nối';
    el.btnPairKeep.title = 'Cả 2 cùng bấm để Giữ kết nối cho lần sau + nhận Mã hẹn gặp lại + lưu 40 tin nhắn gần nhất';
  }
}

function handlePairKeepUpdated(payload) {
  if (!payload || isGroupMode || isGameRoomMode || isCurrentPartnerBot) return;

  currentPairKeep = {
    pairId: payload.pairId || null,
    pairCode: payload.pairCode || null,
    myVote: Boolean(payload.myVote),
    partnerVote: Boolean(payload.partnerVote),
    keepCount: payload.keepCount || 0,
    isKept: Boolean(payload.isKept),
  };
  updatePairKeepHeaderUi();

  if (payload.justActivated) {
    addSystemMessage(
      `💛 Cả hai bạn đã đồng ý Giữ kết nối! Mã hẹn gặp lại: ${payload.pairCode} (bấm vào mã ở góc trên để sao chép). 40 tin nhắn gần nhất sẽ được lưu để lần sau vào trò chuyện tiếp!`
    );
    showToast(`💛 Đã Giữ kết nối thành công! Mã hẹn: ${payload.pairCode}`, 'success', 4800);
    playMatchSound();
  } else if (payload.justCancelled) {
    addSystemMessage(`💨 ${payload.actorNickname || 'Một người'} đã hủy Giữ kết nối. Cuộc trò chuyện sẽ không còn được lưu sau khi thoát.`);
    showToast('Đã hủy Giữ kết nối ở cả hai phía', 'info', 3500);
  } else if (!payload.actorIsMe && payload.partnerVote && !payload.myVote) {
    addSystemMessage(`💛 ${payload.actorNickname || 'Đối phương'} muốn Giữ kết nối với bạn cho lần sau! Bấm nút "💛 Đồng ý Giữ kết nối!" ở góc trên nếu bạn cũng muốn nhé.`);
    showToast(`💛 ${payload.actorNickname || 'Đối phương'} muốn Giữ kết nối với bạn!`, 'info', 4000);
    playTone(660, 'triangle', 0.08, 0.08);
  } else if (payload.actorIsMe && payload.myVote && !payload.partnerVote) {
    addSystemMessage('⏳ Bạn đã chọn Giữ kết nối (1/2). Đang chờ đối phương đồng ý…');
  } else if (payload.actorIsMe && !payload.myVote) {
    addSystemMessage('Bạn đã bỏ chọn Giữ kết nối.');
  }
}

function handlePairKeepPass(pass) {
  if (!pass || !pass.pairId || !pass.pairToken) return;
  upsertSavedPairPass(pass);
  if (currentPairKeep && currentPairKeep.pairId === pass.pairId) {
    currentPairKeep.pairCode = pass.pairCode;
    currentPairKeep.isKept = true;
    updatePairKeepHeaderUi();
  }
}

function handlePairList(payload) {
  const connections = Array.isArray(payload.connections) ? payload.connections : [];
  const expiredIds = Array.isArray(payload.expiredPairIds) ? payload.expiredPairIds : [];

  if (expiredIds.length > 0) {
    const expiredSet = new Set(expiredIds);
    const cleaned = loadSavedPairPasses().filter((p) => !expiredSet.has(p.pairId));
    savePairPasses(cleaned);
  }

  if (connections.length > 0) {
    const existing = loadSavedPairPasses();
    const byId = new Map(existing.map((p) => [p.pairId, p]));
    connections.forEach((c) => {
      const prev = byId.get(c.pairId) || {};
      byId.set(c.pairId, {
        ...prev,
        pairId: c.pairId,
        pairCode: c.pairCode || prev.pairCode,
        pairToken: c.pairToken || prev.pairToken,
        mySlot: c.mySlot || prev.mySlot,
        partnerNickname: c.partnerNickname,
        partnerAvatar: c.partnerAvatar,
        partnerMood: c.partnerMood,
        historyCount: c.historyCount,
        lastMessagePreview: c.lastMessagePreview,
        lastActiveAt: c.lastActiveAt,
      });
    });
    savePairPasses([...byId.values()]);
  }

  savedPairsLive = connections;
  updateSavedPairsBadge();
  renderSavedPairsList();
}

function handlePairPresence(payload) {
  if (!payload || !payload.pairId) return;
  const found = savedPairsLive.find((p) => p.pairId === payload.pairId);
  if (found) {
    found.partnerOnline = Boolean(payload.partnerOnline);
    found.partnerWaitingInPair = Boolean(payload.partnerWaitingInPair);
    updateSavedPairsBadge();
    renderSavedPairsList();
  }
}

function handlePairWaiting(payload) {
  if (!payload) return;
  closePairHub();
  activePairWaiting = payload;

  if (el.pairWaitAvatar) el.pairWaitAvatar.textContent = payload.partnerAvatar || '💛';
  if (el.pairWaitTitle) {
    el.pairWaitTitle.textContent = payload.invitedPartner
      ? `Đang mời ${payload.partnerNickname || 'người ấy'} gặp lại…`
      : `Phòng hẹn chờ ${payload.partnerNickname || 'người ấy'}`;
  }
  if (el.pairWaitDesc) el.pairWaitDesc.textContent = payload.message || 'Đang chờ đối phương vào lại…';
  if (el.pairWaitCodeText) el.pairWaitCodeText.textContent = payload.pairCode || '';

  if (el.pairWaitHistoryPreview) {
    el.pairWaitHistoryPreview.textContent = '';
    const history = Array.isArray(payload.history) ? payload.history.slice(-6) : [];
    if (history.length > 0) {
      const head = document.createElement('div');
      head.style.cssText = 'font-weight: 700; font-size: 0.74rem; color: var(--text-muted); margin-bottom: 2px;';
      head.textContent = `📜 Xem nhanh ${history.length} tin nhắn gần nhất (tổng ${payload.history.length} tin đã lưu):`;
      el.pairWaitHistoryPreview.appendChild(head);

      history.forEach((item) => {
        const line = document.createElement('div');
        line.className = 'pair-preview-line';
        const who = document.createElement('b');
        who.textContent = item.direction === 'sent' ? 'Bạn: ' : `${payload.partnerNickname || 'Người ấy'}: `;
        const body = document.createElement('span');
        body.textContent = item.type === 'voice'
          ? '🎤 Tin nhắn thoại'
          : (item.type === 'attachment'
            ? `📎 ${(item.attachment && item.attachment.fileName) || 'Tệp đính kèm'}`
            : (item.type === 'meme' ? (item.isSticker ? '✨ Nhãn dán' : '🖼️ Meme') : (item.text || '')));
        line.appendChild(who);
        line.appendChild(body);
        el.pairWaitHistoryPreview.appendChild(line);
      });
      el.pairWaitHistoryPreview.classList.remove('hidden');
    } else {
      el.pairWaitHistoryPreview.classList.add('hidden');
    }
  }

  if (el.modalPairWaiting) el.modalPairWaiting.classList.remove('hidden');
}

function closePairWaitingModal() {
  activePairWaiting = null;
  if (el.modalPairWaiting) el.modalPairWaiting.classList.add('hidden');
}

function handlePairInvite(payload) {
  if (!payload || !payload.inviteId) return;
  incomingPairInvite = payload;
  if (el.pairInviteAvatar) el.pairInviteAvatar.textContent = payload.fromAvatar || '💛';
  if (el.pairInviteName) el.pairInviteName.textContent = payload.fromNickname || 'Người quen';
  if (el.pairInviteDesc) {
    const countText = payload.historyCount > 0 ? ` (khôi phục ${payload.historyCount} tin nhắn gần nhất)` : '';
    el.pairInviteDesc.textContent = `${payload.fromNickname || 'Người ấy'} từ danh sách Giữ kết nối muốn tiếp tục trò chuyện 1-1 cùng bạn ngay bây giờ${countText}!`;
  }
  if (el.modalPairInvite) el.modalPairInvite.classList.remove('hidden');
  playMatchSound();
}

function closePairInviteModal() {
  incomingPairInvite = null;
  if (el.modalPairInvite) el.modalPairInvite.classList.add('hidden');
}

function handlePairInviteDeclined(payload) {
  closePairWaitingModal();
  showToast((payload && payload.message) || 'Đối phương hiện đang bận, hẹn dịp khác nhé!', 'info', 4000);
}

function handlePairRemoved(payload) {
  if (!payload || !payload.pairId) return;
  removeSavedPairPass(payload.pairId);
  if (activePairWaiting && activePairWaiting.pairId === payload.pairId) {
    closePairWaitingModal();
  }
  if (currentPairKeep && currentPairKeep.pairId === payload.pairId) {
    currentPairKeep = {
      pairId: null,
      pairCode: null,
      mySlot: null,
      myVote: false,
      partnerVote: false,
      keepCount: 0,
      isKept: false,
    };
    updatePairKeepHeaderUi();
  }
  if (payload.message) showToast(payload.message, 'info', 3500);
}

function openPairHub() {
  if (!el.modalPairHub) return;
  el.modalPairHub.classList.remove('hidden');
  syncSavedPairsWithServer();
  renderSavedPairsList();
  playTone(580, 'triangle', 0.05, 0.06);
}

function closePairHub() {
  if (el.modalPairHub) el.modalPairHub.classList.add('hidden');
}

function renderSavedPairsList() {
  if (!el.pairSavedList) return;
  const list = savedPairsLive.length > 0 ? savedPairsLive : loadSavedPairPasses();
  el.pairSavedList.textContent = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty-state';
    const icon = document.createElement('span');
    icon.className = 'group-empty-icon';
    icon.textContent = '💛';
    const p = document.createElement('p');
    p.textContent = 'Chưa có ai trong danh sách Giữ kết nối. Khi chat 1-1 gặp người hợp cạ, cả hai cùng bấm "💛 Giữ kết nối" để lưu lại lần sau và nhận Mã hẹn gặp lại nhé!';
    empty.appendChild(icon);
    empty.appendChild(p);
    el.pairSavedList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  list.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'group-list-card is-kept';

    const info = document.createElement('div');
    info.className = 'group-list-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'group-list-title-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'group-list-name';
    nameEl.textContent = `${item.partnerAvatar || '🦊'} ${item.partnerNickname || 'Người ấy'}`;

    const presencePill = document.createElement('span');
    presencePill.className = 'pair-presence-pill';
    if (item.partnerWaitingInPair) {
      presencePill.classList.add('waiting');
      presencePill.textContent = '💛 Đang chờ bạn!';
    } else if (item.partnerOnline) {
      presencePill.classList.add('online');
      presencePill.textContent = item.partnerBusy ? '🟡 Online (đang bận)' : '🟢 Đang online';
    } else {
      presencePill.textContent = '⚪ Chưa online';
    }

    titleRow.appendChild(nameEl);
    titleRow.appendChild(presencePill);

    const meta = document.createElement('div');
    meta.className = 'group-list-meta';
    const previewPart = item.lastMessagePreview ? ` • "${item.lastMessagePreview}"` : '';
    meta.textContent = `📜 ${item.historyCount || 0} tin đã lưu${previewPart}`;

    const codeRow = document.createElement('div');
    codeRow.style.marginTop = '3px';
    const codeBtn = document.createElement('button');
    codeBtn.type = 'button';
    codeBtn.className = 'room-code-chip';
    codeBtn.title = 'Bấm để sao chép Mã hẹn gặp lại (dùng được trên thiết bị khác)';
    codeBtn.textContent = `🔑 ${item.pairCode || ''}`;
    codeBtn.addEventListener('click', () => copyPairCodeToClipboard(item.pairCode));
    codeRow.appendChild(codeBtn);

    info.appendChild(titleRow);
    info.appendChild(meta);
    if (item.pairCode) info.appendChild(codeRow);

    const actions = document.createElement('div');
    actions.className = 'group-list-actions';

    const rejoinBtn = document.createElement('button');
    rejoinBtn.type = 'button';
    rejoinBtn.className = 'btn btn-primary btn-small';
    rejoinBtn.textContent = item.partnerWaitingInPair
      ? '💛 Vào gặp ngay →'
      : (item.partnerOnline ? '💬 Mời gặp lại' : '🚪 Mở phòng hẹn');
    rejoinBtn.addEventListener('click', () => {
      collectLobbyProfileForGroup();
      send('pair_reconnect', { pairId: item.pairId, pairToken: item.pairToken });
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-secondary btn-small';
    removeBtn.title = 'Hủy Giữ kết nối vĩnh viễn ở cả hai phía';
    removeBtn.textContent = '✕ Hủy';
    removeBtn.addEventListener('click', () => {
      send('pair_remove', { pairId: item.pairId, pairToken: item.pairToken });
    });

    actions.appendChild(rejoinBtn);
    actions.appendChild(removeBtn);

    card.appendChild(info);
    card.appendChild(actions);
    fragment.appendChild(card);
  });

  el.pairSavedList.appendChild(fragment);
}

// ── Event Listeners cho Giữ kết nối 1-1 & Mã hẹn gặp lại ───
if (el.btnOpenPairHub) {
  el.btnOpenPairHub.addEventListener('click', openPairHub);
}
if (el.btnClosePairHub) {
  el.btnClosePairHub.addEventListener('click', closePairHub);
}
if (el.modalPairHub) {
  const backdrop = el.modalPairHub.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closePairHub);
}
if (el.btnRefreshPairList) {
  el.btnRefreshPairList.addEventListener('click', () => {
    syncSavedPairsWithServer();
    showToast('Đã làm mới trạng thái kết nối', 'info', 1600);
  });
}
if (el.btnPairJoinCode) {
  el.btnPairJoinCode.addEventListener('click', () => {
    const code = el.inputPairCode ? el.inputPairCode.value.trim().toUpperCase() : '';
    if (!code || code.length < 8) {
      showToast('Vui lòng nhập Mã hẹn gặp lại hợp lệ (ví dụ: CHAT-A7K9-P2M4)!', 'warning');
      el.inputPairCode?.focus();
      return;
    }
    collectLobbyProfileForGroup();
    send('pair_join_code', { pairCode: code });
  });
}
if (el.inputPairCode) {
  el.inputPairCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.btnPairJoinCode?.click();
    }
  });
}
if (el.btnPairKeep) {
  el.btnPairKeep.addEventListener('click', () => {
    if (!currentPairKeep || isGroupMode || isGameRoomMode || isCurrentPartnerBot) return;
    const nextKeep = currentPairKeep.isKept ? false : !currentPairKeep.myVote;
    send('pair_vote_keep', { keep: nextKeep });
    playTone(nextKeep ? 680 : 420, 'triangle', 0.08, 0.08);
  });
}
if (el.pairCodePill) {
  el.pairCodePill.addEventListener('click', () => {
    if (currentPairKeep && currentPairKeep.pairCode) {
      copyPairCodeToClipboard(currentPairKeep.pairCode);
    }
  });
}
if (el.btnCopyWaitPairCode) {
  el.btnCopyWaitPairCode.addEventListener('click', () => {
    if (activePairWaiting && activePairWaiting.pairCode) {
      copyPairCodeToClipboard(activePairWaiting.pairCode);
    }
  });
}
if (el.btnPairCancelWait) {
  el.btnPairCancelWait.addEventListener('click', () => {
    send('pair_cancel_wait');
    closePairWaitingModal();
  });
}
if (el.btnPairInviteAccept) {
  el.btnPairInviteAccept.addEventListener('click', () => {
    if (!incomingPairInvite) return;
    const inviteId = incomingPairInvite.inviteId;
    closePairInviteModal();
    send('pair_invite_respond', { inviteId, accept: true });
    playMatchSound();
  });
}
if (el.btnPairInviteDecline) {
  el.btnPairInviteDecline.addEventListener('click', () => {
    if (!incomingPairInvite) return;
    const inviteId = incomingPairInvite.inviteId;
    closePairInviteModal();
    send('pair_invite_respond', { inviteId, accept: false });
  });
}

// ═══════════════════════════════════════════════════
// Khởi tạo
// ═══════════════════════════════════════════════════

initTheme();
initSound();
updateInterestsCounter();
updateSavedGroupsBadge();
updateSavedPairsBadge();
connect();
