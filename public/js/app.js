// js/app.js — Domino Arena client: screens, net, hand UI, chat, modals
import { Board3D } from './board3d.js?v=33';
import { Home3D } from './home3d.js?v=7';
import { tileImage, setTheme as setTileTheme, getTheme, THEME_NAMES } from './tiles.js?v=15';
import { getQuality, setQuality } from './quality.js?v=3';
import { sfx } from './sfx.js?v=17';
import { VoiceChat } from './voice.js?v=2';

const $ = id => document.getElementById(id);
// Guarded event binding: a missing chat node must never abort boot.
function bindEl(id, ev, fn, opts) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn, opts);
  return el;
}
const VARIANT_DESC = {
  block: 'عادي (Block): بدون سحب — لا تملك حركة متطابقة؟ تمرير (باص). الفائز بالجولة يكسب مجموع نقاط كروت الخصوم المتبقية.',
  draw: 'سحب (Draw): عند عدم امتلاك كارت متطابق، تسحب من السحابة حتى تجد كارت يمكن لعبه. نفس قواعد احتساب النقاط.',
  allfives: 'مضاعفات الخمسة (خمسات): إذا كان مجموع أطراف السلسلة يقبل القسمة على 5 تكسب نقاط فورية. أول دبل يصبح سنتر يفتح 4 اتجاهات!',
};

// ── state ──
let socket, myId, myToken, myName, roomCode, isHost = false, lastLobbyState = null;
let view = null;
let prevHand = [];
let newlyDrawnTileId = null;
let selectedTile = null;
let board = null;
let home3d = null, lobby3d = null;
let lastActionKey = '';
let chatOpen = false, unread = 0, emojiPopOpen = false;

// ── chat session state ──
// `mid` is the server-assigned, room-scoped message id — the dedupe key that
// keeps a chat:history replay and a live chat:msg from drawing the same message
// twice. `at` is the server clock and is the only source for day/grouping
// comparisons (the local clock may be skewed).
const CHAT_SEEN_MAX = 500;
const CHAT_GROUP_MS = 3 * 60 * 1000;
const CHAT_TYPING_TTL_MS = 3000;
const CHAT_TYPING_THROTTLE_MS = 1200;

// Inline HUD iconography — one stroke family, sized by the surrounding slot.
// Static strings only; never interpolate user data into these.
const SVG_BOT = '<svg class="icon-bot" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"></rect><circle cx="9" cy="12" r="1"></circle><circle cx="15" cy="12" r="1"></circle><path d="M9 16h6"></path><path d="M12 7V4"></path><circle cx="12" cy="3" r="1"></circle></svg>';
const SVG_TILE = '<svg class="icon-tile" viewBox="0 0 14 20" width="11" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.5" y="1.5" width="11" height="17" rx="2.5"></rect><path d="M1.5 10h11"></path><circle cx="5" cy="5.5" r=".9" fill="currentColor" stroke="none"></circle><circle cx="9" cy="14.5" r=".9" fill="currentColor" stroke="none"></circle></svg>';
const SVG_COPY = '<svg class="icon-copy" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const chatSeen = new Set();
let chatSeenOrder = [];
let chatLastAt = 0;              // msg.at of the previous rendered message
let chatLastWho = '';            // pid (or name fallback) of the previous user message
let chatLastDay = '';            // local day key derived from msg.at
let chatLastWasUser = false;
let chatUnreadDividerShown = false;
let chatScrolledUp = false;
let chatTypingSentAt = 0;
const chatTypers = new Map();    // pid -> { name, timer }
let chatHintTimer = null;

// ── voice session state ──
// The engine (js/voice.js) owns media + signaling; this module only renders it.
// One engine instance exists per live socket, is disposed with the room, and is
// recreated lazily on the next join. `voiceSelf` mirrors the engine's onSelf
// snapshot so re-renders (lobby/game state) never need to poke the engine.
let voiceEngine = null;
let voiceInitFailed = false;
let voiceSelf = { joined: false, muted: false, hostMuted: false, speaking: false, status: 'idle', error: null };
let voicePeerList = [];
const voiceSpeaking = new Set();          // pids currently speaking (self included)
const voicePeerRows = new Map();          // pid -> { row, ...refs }
let voicePeerOrderKey = '';
let voicePanelOpen = false;
let voicePttPref = (() => {
  try { return localStorage.getItem('domino_voice_ptt') === '1'; } catch { return false; }
})();
let voiceFabHeld = false;
let voiceHeldAt = 0;
let voicePttDown = false;      // local PTT intent (the engine exposes speaking, not talking)
let voiceDevices = [];
let voiceDeviceBusy = false;
let voiceSelectedDevice = 'default';
let voiceDeviceKey = '';
let voiceLiveSeen = false;
const VOICE_IDLE = Object.freeze({ joined: false, muted: false, hostMuted: false, speaking: false, status: 'idle', error: null });

// ── chat content ──
const CHAT_PHRASES = [
  'سلام عليكم 👋', 'يلا نلعب 🔥', 'حظ سعيد 🍀', 'لعبة حلوة 👏',
  'شطارة يا وحش 😎', 'يا سلام 😂', 'يا ساتر 😅', 'قعدة جميلة 🤝', 'هههههه 😂',
];
// curated ≤ Emoji-13 glyphs so they render on older Windows/Android too
// the important ones, always visible above the input — one tap sends instantly
const CHAT_QUICK_EMOJIS = ['😂', '🔥', '👏', '😎', '😮', '😢', '🎉', '🤝', '👍', '🍀'];
const CHAT_EMOJI_GROUPS = [
  ['وجوه', '😀 😄 😅 😂 🤣 😉 😊 😍 🤩 😎 🤔 😮 😴 😢 😭 😤 🤯 🥵 😇 🙃 🙄 😬 😁 🥴'],
  ['إشارات', '👍 👎 👏 🙌 🤝 🙏 💪 ✌️ 🤞 🤙 👊 👋'],
  ['قلوب', '❤️ 🧡 💛 💚 💙 💜 🖤 💔 💯 ✨ 🔥 ⭐ 🌟 💥'],
  ['متفرقات', '🎉 🎊 🏆 🥇 🥈 🥉 🍀 🎯 🃏 🎲 🧠 👀 🤫 😈 🤡 💀'],
].map(([cat, list]) => [cat, list.split(' ')]);
// per-player identity colors (index = seat order in view.players)
const CHAT_COLORS = ['247,179,43', '46,230,168', '122,165,255', '255,122,149'];
let lastTimerKey = null, lastTickSec = null;
let clockOffset = 0; // server clock minus client clock, captured per state
let autoPlayTimer = null;
let spectating = false; // true when riding along without a seat
let myReady = false;    // my authoritative ready flag (mirrored from lobby:state, never sniffed from button text)

// ── F3.3 performance overlay (toggle with the P key) ──
// Deliberately dependency-free: it reads three.js's own renderer.info plus a few
// counters we maintain here, so it costs ~nothing when hidden and tells the truth
// when shown. Used to validate the F0.4/F3.1/F3.2 optimisations on real devices.
let perfOn = false, perfRaf = 0, perfTimer = null;
let perfFrames = 0, perfFrameStart = 0, perfMsgs = 0;
let perfLastSyncMs = 0, perfSyncCount = 0;
let perfPeakGeos = 0, perfPeakTexs = 0, perfMinFps = Infinity, perfMaxSyncMs = 0;
// F4.2: the chosen bot difficulty + personality for quick-play and lobby-add.
let botLevel = 'medium';
let botProfile = (() => {
  try { return localStorage.getItem('domino_bot_profile') || 'balanced'; } catch { return 'balanced'; }
})();
const BOT_LEVEL_LABEL = { easy: 'سهل', medium: 'متوسط', hard: 'صعب', expert: 'خبير' };
const BOT_PROFILE_LABEL = { balanced: 'متوازن', aggressive: 'هجومي', defensive: 'دفاعي' };
// F4.3: the active tile skin. Applied to the 2D hand immediately and to the 3D
// board (which repaints its pooled materials) whenever a board exists.
let tileTheme = (() => {
  try {
    const t = localStorage.getItem('domino_theme');
    return t && THEME_NAMES.includes(t) ? t : 'classic';
  } catch { return 'classic'; }
})();
setTileTheme(tileTheme);

function applyTheme(name) {
  if (!THEME_NAMES.includes(name)) return;
  tileTheme = name;
  try { localStorage.setItem('domino_theme', name); } catch { /* no storage */ }
  setTileTheme(name);          // 2D painters + dataURL cache
  board?.setTheme?.(name);     // 3D board repaints (no-op when no board yet)
  renderHand?.();              // hand tiles are themed images
  document.querySelectorAll('#themeRow .diff-chip')
    .forEach(c => c.classList.toggle('active', c.dataset.theme === name));
}

// Build the 3D game table. There is no 2D table mode: if WebGL is unavailable
// the board is null and the hand/HUD remain fully playable.
function createBoard(canvas, cbs) {
  try {
    return new Board3D(canvas, cbs);
  } catch (err) {
    console.warn('[domino] 3D board unavailable:', err?.message || err);
    toast('الطاولة 3D مش متاحة على الجهاز ده — اللعب شغال من إيدك.', 5000);
    return null;
  }
}

// ══════════ screens ══════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $(`screen-${name}`);
  if (target) target.classList.add('active');
  // The chat cluster is global (body-level) and must only exist while seated in
  // a room — it rides along on lobby AND game, never on home.
  document.body.classList.toggle('in-room', name !== 'home' && !!roomCode);
  // Layout hook: the fixed chat/voice rail is repositioned on the lobby (mobile)
  // so it never sits on top of the host-config controls.
  document.body.classList.toggle('in-lobby', name === 'lobby');
  // Self-heal: whenever the lobby becomes visible the code box must show a
  // code — repaint from the freshest known source in case an earlier paint
  // was missed, stale, or rendered while roomCode was still unset.
  if (name === 'lobby') paintLobbyCode(lastLobbyState);
  if (name === 'game' && !board) {
    board = createBoard($('table3d'), { onMarkerClick, onBoardMiss, onBoneyardClick: onBoneyardDraw });
  }
  if (name === 'game') setTimeout(() => board?.resize(), 50);
  home3d?.setActive(name === 'home');
  lobby3d?.setActive(name === 'lobby');
  // The board owns a single rAF loop; pause it while another screen is shown.
  board?.setActive?.(name === 'game');
  syncVoiceVisibility();
}

// ══════════ home & lobby effects ══════════
function spawnFallingTiles(containerId) {
  const hero = $(containerId);
  if (!hero) return;
  hero.innerHTML = '';
  // 3 depth layers: far (small/blurred/faint) → near (large/sharp/brighter).
  // Each tile drifts + tumbles with its own physics for a premium parallax feel.
  const LAYERS = [
    { cls: 'far',  count: 9,  size: [26, 40] },
    { cls: 'mid',  count: 8,  size: [44, 62] },
    { cls: 'near', count: 6,  size: [70, 98] },
  ];
  const total = LAYERS.reduce((s, l) => s + l.count, 0);
  let slot = 0;
  for (const layer of LAYERS) {
    for (let i = 0; i < layer.count; i++) {
      const img = document.createElement('img');
      img.src = tileImage(Math.floor(Math.random() * 7), Math.floor(Math.random() * 7));
      img.className = `fall ${layer.cls}`;
      const size = layer.size[0] + Math.random() * (layer.size[1] - layer.size[0]);
      // even horizontal spread with jitter — pure random clumps to one side
      const left = (slot++ / total) * 96 + (Math.random() * 12 - 6);
      img.style.left = Math.max(0, Math.min(94, left)) + 'vw';
      img.style.width = size + 'px';
      img.style.setProperty('--rot0', Math.random() * 360 + 'deg');
      img.style.setProperty('--rot1', (Math.random() < .5 ? -1 : 1) * (200 + Math.random() * 360) + 'deg');
      img.style.setProperty('--sway', (Math.random() < .5 ? -1 : 1) * (20 + Math.random() * 60) + 'px');
      img.style.animationDuration = 9 + Math.random() * 12 + 's';
      img.style.animationDelay = -Math.random() * 20 + 's';
      hero.appendChild(img);
    }
  }
}

function initHome() {
  try {
    home3d = new Home3D($('home3d'));
    home3d.setActive(true);
  } catch (err) {
    console.warn('home3d unavailable — using CSS falling tiles', err);
    home3d = null;
  }
  if (!home3d) spawnFallingTiles('heroTiles');
  try {
    lobby3d = new Home3D($('lobby3d'));
  } catch (err) {
    console.warn('lobby3d unavailable — using CSS falling tiles', err);
    lobby3d = null;
  }
  // K3.C5: the 2D lobby tiles spawn ONLY when the 3D lobby backdrop is dead —
  // they used to run stacked on top of it (23 blurred images + a canvas rAF).
  $('inpName').value = localStorage.getItem('domino_name') || '';
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('inpCode').value = params.get('room').toUpperCase();
  } else {
    const savedCode = localStorage.getItem('domino_last_code');
    if (savedCode) $('inpCode').value = savedCode;
  }

  const handleEnter = () => {
    const code = $('inpCode').value.trim();
    if (code.length === 4) $('btnJoin').click();
    else $('btnCreate').click();
  };
  $('inpName').addEventListener('keydown', e => { if (e.key === 'Enter') handleEnter(); });
  $('inpCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });

  $('btnCreate').onclick = () => {
    const name = getName(); if (!name) return;
    emit('room:create', { name }).then(res => {
      if (!res.ok) return homeError(res.error);
      afterJoin(res, name);
      showScreen('lobby');
    });
  };
  document.querySelectorAll('#diffRow .diff-chip').forEach(ch => {
    ch.onclick = () => {
      botLevel = ch.dataset.level;
      document.querySelectorAll('#diffRow .diff-chip').forEach(c => c.classList.toggle('active', c === ch));
      sfx.click();
    };
  });
  // F4.2: bot personality (same evaluator, different weights)
  const syncProfileChips = () => document.querySelectorAll('#profileRow .diff-chip')
    .forEach(c => c.classList.toggle('active', c.dataset.profile === botProfile));
  document.querySelectorAll('#profileRow .diff-chip').forEach(ch => {
    ch.onclick = () => {
      botProfile = ch.dataset.profile;
      try { localStorage.setItem('domino_bot_profile', botProfile); } catch { /* no storage */ }
      syncProfileChips();
      sfx.click();
    };
  });
  syncProfileChips();
  // F4.3: tile theme picker
  document.querySelectorAll('#themeRow .diff-chip').forEach(ch => {
    ch.onclick = () => { applyTheme(ch.dataset.theme); sfx.click(); };
  });
  applyTheme(tileTheme);   // reflect the persisted choice on first paint
  // B2: graphics quality picker (auto / high / low) — persisted by quality.js
  const syncQualityChips = () => document.querySelectorAll('#qualityRow .diff-chip')
    .forEach(c => c.classList.toggle('active', c.dataset.quality === getQuality().mode));
  document.querySelectorAll('#qualityRow .diff-chip').forEach(ch => {
    ch.onclick = () => { setQuality(ch.dataset.quality); syncQualityChips(); sfx.click(); };
  });
  syncQualityChips();
  $('btnBots').onclick = () => {
    const name = getName(); if (!name) return;
    emit('room:create', { name, vsBots: true, botLevel, botProfile }).then(res => {
      if (!res.ok) return homeError(res.error);
      afterJoin(res, name);
      showScreen('game');
    });
  };
  $('btnJoin').onclick = () => {
    const name = getName(); if (!name) return;
    const code = $('inpCode').value.trim().toUpperCase();
    if (code.length !== 4) return homeError('أدخل كود الغرفة المكون من 4 أحرف.');
    const token = sessionStorage.getItem('domino_token_' + code) || localStorage.getItem('domino_token_' + code) || null;
    emit('room:join', { code, name, token })
      .then(res => {
        if (!res.ok) return homeError(res.error);
        afterJoin(res, name);
        if (res.spectating) {
          spectating = true;
          showScreen(res.state === 'playing' ? 'game' : 'lobby');
          if (res.state !== 'playing') lobbyError('الغرفة ممتلئة — دخلت متفرج. لما يفضى مكان اضغط "اقعد والعب".');
        } else {
          showScreen(res.state === 'playing' ? 'game' : 'lobby');
        }
      });
  };

  // collapsible play-settings (difficulty / personality / theme / quality)
  const settingsPanel = $('homeSettings');
  $('btnSettings').onclick = () => {
    const open = settingsPanel.classList.toggle('hidden');
    $('btnSettings').classList.toggle('open', !open);
    $('btnSettings').setAttribute('aria-expanded', String(!open));
    sfx.click();
  };

  // how-to-play modal — examples are painted with the real tile art (no images)
  const howModal = $('modalHow');
  const paintHowTiles = () => {
    howModal.querySelectorAll('.how-tiles').forEach(box => {
      if (box.children.length) return;
      for (const id of box.dataset.tiles.split(',')) {
        const [a, b] = id.split('-').map(Number);
        const img = document.createElement('img');
        img.src = tileImage(a, b);
        img.alt = `${a}-${b}`;
        box.appendChild(img);
      }
    });
  };
  $('btnHow').onclick = () => {
    paintHowTiles();
    howModal.classList.remove('hidden');
    sfx.click();
  };
  $('howClose').onclick = () => howModal.classList.add('hidden');
  howModal.addEventListener('click', e => {
    if (e.target === howModal) howModal.classList.add('hidden');
  });

  // subtle 3D tilt following the pointer — flattened under reduced motion.
  // cardIn runs with fill-mode both, which would keep overriding the inline
  // transform forever, so the first interaction retires the entry animation.
  const homeCard = document.querySelector('.home-card');
  if (homeCard && !prefersReducedMotion()) {
    homeCard.addEventListener('pointermove', e => {
      if (homeCard.style.animation !== 'none') homeCard.style.animation = 'none';
      const r = homeCard.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -3.5;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * 3.5;
      homeCard.style.transform = `perspective(1100px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
    homeCard.addEventListener('pointerleave', () => { homeCard.style.transform = ''; });
  }
}

function getName() {
  const name = $('inpName').value.trim();
  if (!name) { homeError('من فضلك اكتب اسمك أولاً!'); return null; }
  localStorage.setItem('domino_name', name);
  return name;
}
function homeError(msg) { $('homeError').textContent = msg || ''; }

function afterJoin(res, name) {
  // Spectator joins carry no playerId, but the server stamps their chat with
  // "spectator:<id>" — mirror that so their own bubbles/typing are recognised.
  myId = res.playerId || (res.spectatorId ? 'spectator:' + res.spectatorId : null);
  myToken = res.token || null; myName = name; roomCode = res.code;
  myReady = false;
  // `res.spectating` is the authority on every attach path (create/join/auto-
  // rejoin); the caller mirrors it too, but voice visibility must not depend on
  // call-site ordering.
  if (typeof res.spectating === 'boolean') spectating = res.spectating;
  document.body.classList.add('in-room');
  // Spectator joins carry no token — never persist "undefined" as a token or
  // the next auto-rejoin sends a garbage token string. Storage can also throw
  // (blocked cookies/private mode) — it must never stop the lobby painting.
  try {
    if (myToken) {
      sessionStorage.setItem('domino_token_' + roomCode, myToken);
      localStorage.setItem('domino_token_' + roomCode, myToken);
    }
    localStorage.setItem('domino_last_code', roomCode);
  } catch { /* the room still works for this tab */ }
  try { history.replaceState(null, '', '?room=' + roomCode); } catch { /* sandboxed */ }
  paintLobbyCode();
  const chip = $('chatRoomChip');
  if (chip) chip.textContent = 'غرفة ' + roomCode;
  // Fresh attachment (create / join / reconnect): rebuild the transcript from
  // scratch — the server unicasts chat:history right after this ack.
  resetChatTranscript();
  if (res.lobby) {
    renderLobby(res.lobby);
  } else if (lastLobbyState) {
    renderLobby(lastLobbyState);
  }
  // Fresh seat (join / create / reconnect): tell the voice engine who we are.
  // A reconnect re-runs this, which is what re-binds voice to the new socket
  // identity without ever opening the mic on its own.
  syncVoiceForRoom();
}

// ══════════ lobby ══════════
// The room code is the one thing that must never paint empty — without it the
// lobby is useless (nobody can share/join). Every paint path funnels through
// here with a fallback chain, and showScreen('lobby') re-heals it, so a missed
// or stale echo can never leave the box blank.
function paintLobbyCode(st) {
  const el = $('lobbyCode');
  if (!el) return;
  el.textContent = (st && st.code) || roomCode || (lastLobbyState && lastLobbyState.code) || '----';
}
function renderLobby(st) {
  if (!st) return;
  lastLobbyState = st;
  isHost = st.hostId === myId;
  paintLobbyCode(st);
  const countEl = $('playerCount');
  if (countEl) countEl.textContent = `${(st.players || []).length}/${st.config?.maxPlayers ?? 4}`;
  // K2.S11/K3.C12: make spectators visible in the lobby.
  const specEl = $('specCount');
  if (specEl) {
    const n = (st.spectators || []).length;
    specEl.textContent = n ? `👁 ${n} متفرج` : '';
    specEl.classList.toggle('hidden', !n);
  }
  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of (st.players || [])) {
    const li = document.createElement('li');
    if (p.id === myId) li.className = 'me';
    // pid mapping for the voice speaking ring (voicePeerRows never touches DOM
    // nodes we do not own — it only toggles a class here).
    li.dataset.pid = p.id;
    if (voiceSpeaking.has(String(p.id))) li.classList.add('voice-speaking');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    // F4.2: label a seated bot with its difficulty + personality.
    const botTag = p.isBot ? ` 🤖 ${BOT_LEVEL_LABEL[p.botLevel] || ''}${p.botProfile && p.botProfile !== 'balanced' ? ' · ' + (BOT_PROFILE_LABEL[p.botProfile] || '') : ''}` : '';
    nameSpan.textContent = p.name + botTag + (p.id === st.hostId ? ' 👑' : '');
    const tag = document.createElement('span');
    tag.className = 'status' + (p.ready ? ' ready' : '');
    tag.textContent = p.id === st.hostId ? 'المضيف' : (p.ready ? 'جاهز' : 'في الانتظار');
    li.appendChild(nameSpan);
    li.appendChild(tag);
    if (p.isBot && isHost) {
      const rm = document.createElement('button');
      rm.className = 'bot-remove';
      rm.textContent = '✕';
      rm.title = 'حذف البوت';
      rm.onclick = () => { socket.emit('lobby:removeBot', { playerId: p.id }); sfx.click(); };
      li.appendChild(rm);
    }
    // host-only chat mute for human players (not himself)
    if (isHost && !p.isBot && p.id !== myId) {
      const cm = document.createElement('button');
      cm.className = 'bot-remove chat-mute' + (p.chatMuted ? ' muted' : '');
      cm.textContent = p.chatMuted ? '💬✕' : '💬';
      cm.title = p.chatMuted ? 'فك كتم الشات عنه' : 'كتم شاته (للجميع)';
      cm.setAttribute('aria-label', cm.title);
      cm.onclick = async () => {
        cm.disabled = true;
        try {
          const res = await emit('lobby:chatMute', { pid: p.id, muted: !p.chatMuted });
          if (res && !res.ok) lobbyError(res.error);
          else sfx.click();
        } finally { cm.disabled = false; }
      };
      li.appendChild(cm);
      const kick = document.createElement('button');
      kick.className = 'bot-remove kick';
      kick.textContent = '⛔';
      kick.title = 'طرد اللاعب من الغرفة';
      kick.setAttribute('aria-label', kick.title);
      kick.onclick = async () => {
        if (!confirm(`تطرد ${p.name} من الغرفة؟ مينفعش يرجع تاني.`)) return;
        kick.disabled = true;
        try {
          const res = await emit('lobby:kick', { pid: p.id });
          if (res && !res.ok) lobbyError(res.error);
          else sfx.score();
        } finally { kick.disabled = false; }
      };
      li.appendChild(kick);
    }
    list.appendChild(li);
  }

  const btnAddBot = $('btnAddBot');
  if (btnAddBot) {
    const full = (st.players || []).length >= (st.config?.maxPlayers ?? 4);
    btnAddBot.classList.toggle('hidden', !isHost || st.state !== 'lobby');
    btnAddBot.disabled = full;
  }

  $('hostConfig').classList.toggle('hidden', !isHost || spectating);
  $('btnStart').classList.toggle('hidden', !isHost || spectating);
  const btnReady = $('btnReady');
  btnReady.classList.toggle('hidden', isHost || (spectating && st.state !== 'lobby'));
  if (spectating) {
    // ride-along: the ready button becomes "take a free seat"
    btnReady.textContent = 'اقعد والعب 🪑';
    btnReady.disabled = (st.players || []).length >= (st.config?.maxPlayers ?? 4);
    btnReady.onclick = takeSeat;
  } else {
    btnReady.disabled = false;
    const me = (st.players || []).find(p => p.id === myId);
    myReady = !!me?.ready;
    paintReadyBtn();
    // Re-assign every render: a past spectator render overwrote this handler
    // with takeSeat, and nothing restored it after taking a seat.
    btnReady.onclick = toggleReady;
  }

  // host can only start if >=2 players and non-hosts are ready
  const others = (st.players || []).filter(p => p.id !== st.hostId);
  const allReady = others.length > 0 && others.every(p => p.ready);
  $('btnStart').disabled = !(st.players && st.players.length >= 2 && allReady);

  // F2.1: mirror the server's config back into the controls so non-hosts SEE the
  // house rules the host picked, and a late-joining host sees the current state.
  if (st.config) {
    if (st.config.variant) $('selVariant').value = st.config.variant;
    // K2.S2: null = "auto" (engine default per variant/player-count).
    $('selTarget').value = st.config.targetScore == null ? '' : String(st.config.targetScore);
    if (st.config.maxPlayers) $('selMax').value = st.config.maxPlayers;
    // turnMs 0 is a real choice ("no timer") — must not be swallowed by a truthy check.
    $('selTurnMs').value = String(st.config.turnMs ?? 30000);
    const hs = $('selHandSize');
    if (hs) hs.value = st.config.handSize == null ? '' : String(st.config.handSize);
    const ap = $('chkAllowPass');
    if (ap) ap.checked = st.config.allowPass !== false;
    const k2 = $('chkKeepLastTwo');
    if (k2) k2.checked = !!st.config.keepLastTwo;
    $('variantDesc').textContent = VARIANT_DESC[st.config.variant] || '';
    renderRulesSummary(st.config);
  }
  // Voice roster / strip / entry points follow the same lobby paint.
  renderVoiceUI();
}

// A compact human-readable echo of the active house rules — visible to everyone
// in the lobby, so nobody is surprised by a rule they didn't notice.
function renderRulesSummary(cfg) {
  const el = $('rulesSummary');
  if (!el) return;
  const bits = [];
  if (cfg.handSize) bits.push(`${cfg.handSize} كروت`);
  if (cfg.turnMs === 0) bits.push('بدون مؤقّت');
  else if (cfg.turnMs) bits.push(`${Math.round(cfg.turnMs / 1000)} ثانية/دور`);
  if (cfg.allowPass === false) bits.push('بدون باص');
  if (cfg.keepLastTwo) bits.push('آخر كرتين محجوبين');
  el.textContent = bits.length ? '⚙ ' + bits.join(' · ') : '';
  el.classList.toggle('hidden', bits.length === 0);
}

function initLobby() {
  const btnAddBot = $('btnAddBot');
  if (btnAddBot) {
    btnAddBot.onclick = () => { socket.emit('lobby:addBot', { level: botLevel, profile: botProfile }); sfx.click(); };
  }
  if (!lobby3d) spawnFallingTiles('lobbyHeroTiles');   // K3.C5: fallback only
  $('btnCopyCode').onclick = () => copyText(roomCode, 'تم نسخ الكود!');
  // The code itself is a big tap target — copies on tap (same as نسخ الكود).
  $('lobbyCode').onclick = () => {
    const c = roomCode || $('lobbyCode').textContent;
    if (c && c !== '----') copyText(c, 'تم نسخ الكود!');
  };
  // K3.C4: native share sheet first on phones, clipboard as fallback.
  $('btnCopyLink').onclick = () => {
    const url = location.origin + '?room=' + roomCode;
    if (navigator.share) {
      navigator.share({ title: 'دومينو أرينا', text: `ادخل غرفتي بالكود ${roomCode}`, url })
        .then(() => toast('✅ اتبعتت الدعوة لأصحابك'))
        // A user-cancelled share sheet is NOT a failure — swallow it silently.
        // Anything else (no share support, denied) falls back to the clipboard.
        .catch((err) => { if (err?.name !== 'AbortError') copyText(url, 'تم نسخ رابط الدعوة!'); });
    } else {
      copyText(url, 'تم نسخ رابط الدعوة!');
    }
  };
  const btnRules = $('btnRules');
  if (btnRules) btnRules.onclick = () => { $('modalRules')?.classList.remove('hidden'); sfx.click(); };
  $('btnReady').onclick = toggleReady;
  $('btnStart').onclick = () => {
    askNotifyPermission();
    emit('game:start').then(res => {
      if (res && !res.ok) lobbyError(res.error);
    });
  };
  const chkAuto = $('chkAutoplay');
  if (chkAuto) {
    chkAuto.checked = localStorage.getItem('domino_autoplay') === '1';
    chkAuto.onchange = () => {
      localStorage.setItem('domino_autoplay', chkAuto.checked ? '1' : '0');
      sfx.click();
    };
  }
  $('btnQr').onclick = () => {
    const pop = $('qrPop');
    if (!pop) return;
    if (!pop.classList.contains('hidden')) {
      pop.classList.add('hidden');
      sfx.click();
      return;
    }
    renderQr(location.origin + '?room=' + (roomCode || ''), $('qrCanvas'));
    pop.classList.remove('hidden');
    sfx.click();
  };
  $('btnLeave').onclick = leaveRoom;
  // F2.1: push the whole rule set on every change. The server's allowlist
  // (sanitizeConfig) is the authority — we just send what the host picked.
  // K2.S2: an empty target select means "auto" (engine default) → null.
  const pushConfig = () => emit('lobby:config', {
    variant: $('selVariant').value,
    targetScore: $('selTarget').value === '' ? null : +$('selTarget').value,
    maxPlayers: +$('selMax').value,
    turnMs: +$('selTurnMs').value,
    handSize: $('selHandSize').value === '' ? null : +$('selHandSize').value,
    allowPass: $('chkAllowPass').checked,
    keepLastTwo: $('chkKeepLastTwo').checked,
  });
  for (const id of ['selVariant', 'selTarget', 'selMax', 'selTurnMs', 'selHandSize', 'chkAllowPass', 'chkKeepLastTwo']) {
    const el = $(id);
    if (el) el.onchange = pushConfig;
  }
}
function lobbyError(msg) { $('lobbyError').textContent = msg || ''; }

// ── ready toggle (authoritative, not text-sniffed) ──
// The ack carries the server's stored ready value, so even if the throttled
// lobby:state echo is delayed, the button shows the truth immediately.
function paintReadyBtn() {
  const b = $('btnReady');
  if (b) b.textContent = myReady ? 'لست جاهزاً' : 'أنا جاهز';
}
function toggleReady() {
  askNotifyPermission();
  myReady = !myReady;
  paintReadyBtn();
  sfx.click();
  socket.emit('lobby:ready', { ready: myReady }, (res) => {
    if (res && typeof res.ready === 'boolean') {
      myReady = res.ready;
      paintReadyBtn();
    }
    if (res && !res.ok) lobbyError(res.error);
  });
}
// spectator "take a free seat" — leaves the ride-along seat, then joins as a player
function takeSeat() {
  const name = myName || 'لاعب';
  const code = roomCode;
  emit('room:leave').catch(() => {});
  emit('room:join', { code, name }).then(res => {
    if (!res.ok) return lobbyError(res.error || 'مفيش مكان فاضي.');
    spectating = false;
    afterJoin(res, name);
    showScreen(res.state === 'playing' ? 'game' : 'lobby');
    sfx.click();
  });
}

// ── leaving the room (lobby button or in-game exit) ──
// Reset every piece of per-room client state and go home. `leaveRoom` also tells
// the server; `resetToHome` is the same teardown WITHOUT the emit, for the cases
// where the server already detached us (kicked, superseded, failed auto-rejoin)
// and a stray room:leave would race the new state.
function teardownRoom() {
  // Stop the mic before the seat is gone, then dispose the engine with the
  // room: the next room lazily builds a fresh one from the same socket.
  stopVoiceForLeave();
  if (roomCode) {
    sessionStorage.removeItem('domino_token_' + roomCode);
    localStorage.removeItem('domino_token_' + roomCode);
  }
  localStorage.removeItem('domino_last_code');
  myId = myToken = roomCode = null;
  myReady = false;
  isHost = false;
  lastLobbyState = null;
  view = null;
  selectedTile = null;
  spectating = false;
  clearTimeout(autoPlayTimer);
  clearBannerHold();
  bannerOverride = null;
  stopTurnAlert();
  board?.clearMarkers();
  endChatSession();
  disposeVoice();
  sfx.ambient(false);
  closeLeaveConfirm();
  $('modalSettings')?.classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}
function leaveRoom() {
  // Leave the voice channel while the seat still exists on the server, then
  // stop auto-rejoin BEFORE telling the server, so a fast reconnect can't pull
  // us back in.
  stopVoiceForLeave();
  emit('room:leave').catch(() => {});
  teardownRoom();
  sfx.click();
}
function resetToHome(message) {
  teardownRoom();
  homeError(message || '');
  showScreen('home');
}
function openLeaveConfirm() { $('modalLeave').classList.remove('hidden'); }
function closeLeaveConfirm() { $('modalLeave').classList.add('hidden'); }

// 1.9: connection state as a first-class visual, not just a coloured dot.
function setConn(ok) {
  const pill = $('connPill');
  if (pill) pill.className = ok ? 'ok' : 'bad';
  document.body.classList.toggle('offline', !ok);
  const card = $('connBanner');
  if (card) {
    card.textContent = ok ? '' : 'محاولة إعادة الاتصال…';
    card.classList.toggle('hidden', ok);
  }
}

// 0.2: map the engine/server's English rule errors to Egyptian Arabic.
const SERVER_ERR_AR = {
  'not your turn': 'مش دورك — استنى لحد ما ييجي دورك',
  'cannot draw now': 'مفيش سحب دلوقتي',
  'cannot pass now': 'مفيش باص مسموح في اللعبة دي',
  'tile not in hand': 'الكارت ده مش في إيدك',
  'end not open': 'الطرف ده مقفول',
  'hand is over': 'الجولة خلصت',
};
function translateServerError(msg) {
  if (!msg) return 'حصل خطأ — حاول تاني';
  const key = String(msg).toLowerCase();
  if (SERVER_ERR_AR[key]) return SERVER_ERR_AR[key];
  const illegal = key.match(/^illegal play .+ on (.+)$/);
  if (illegal) return 'مش هينفع تلعب الكارت ده على الطرف ده';
  // Server-authored messages are already Arabic (room/lobby rules) — pass them
  // through untouched instead of mangling a perfectly good sentence.
  if (/[؀-ۿ]/.test(msg)) return msg;
  return 'حصل خطأ — حاول تاني';
}

// ══════════ game rendering ══════════
function renderGame() {
  if (!view) return;
  const t0 = perfOn ? performance.now() : 0;
  $('screen-game').classList.toggle('spectating', spectating);
  board?.sync(view);
  const myTurn = !spectating && view.turn === myId && view.status === 'playing';
  board?.setCanDraw(myTurn && view.canDraw);
  board?.setMyTurn?.(myTurn);
  renderOpponents();
  if (spectating) {
    $('hand').innerHTML = '';
    $('hand').classList.remove('my-turn');
  } else {
    renderHand();
  }
  renderActions();
  renderTurnBanner();
  updateTurnTimer();
  renderScoreCard();
  renderModals();
  playActionSounds();
  if (!spectating) maybeAutoPlay();
  prevHand = [...(view.hand || [])];
  if (perfOn) { perfLastSyncMs = performance.now() - t0; perfSyncCount++; }
}

function renderOpponents() {
  const wrap = $('opponents');
  if (!wrap || !view) return;
  wrap.innerHTML = '';
  for (const pid of view.players) {
    if (pid === myId) continue;
    const name = view.names[pid] || 'لاعب';
    const isTurn = view.turn === pid && view.status === 'playing';
    const connected = view.connected?.[pid] !== false;
    const card = document.createElement('div');
    card.className = 'opp-card' + (isTurn ? ' turn' : '') + (!connected ? ' off' : '');
    // The card is rebuilt on every game:state, so the speaking ring is painted
    // from the live set instead of relying on a previous class edit.
    card.dataset.pid = pid;
    if (voiceSpeaking.has(String(pid))) card.classList.add('voice-speaking');
    const avCol = document.createElement('div');
    avCol.className = 'opp-avatar-col';
    const av = document.createElement('div');
    av.className = 'opp-avatar' + (isTurn ? ' active' : '');
    if (view.isBot?.[pid]) {
      av.classList.add('is-bot');
      av.innerHTML = SVG_BOT;
    } else {
      av.textContent = avatarGlyph(name);
    }
    avCol.appendChild(av);
    if (isTurn) {
      const ring = document.createElement('div');
      ring.className = 'opp-avatar-ring';
      avCol.appendChild(ring);
    }
    const info = document.createElement('div');
    info.className = 'opp-info-col';
    const nm = document.createElement('span');
    nm.className = 'opp-name';
    nm.textContent = name;
    nm.title = name;
    info.appendChild(nm);
    const st = document.createElement('span');
    st.className = 'opp-status';
    if (!connected) {
      const off = document.createElement('span');
      off.className = 'opp-badge offline';
      off.textContent = 'مقطوع';
      st.appendChild(off);
    } else if (isTurn) {
      const th = document.createElement('span');
      th.className = 'opp-badge thinking';
      const dot = document.createElement('span');
      dot.className = 'pulse-dot';
      th.appendChild(dot);
      th.appendChild(document.createTextNode('دوره'));
      st.appendChild(th);
    } else {
      const tiles = document.createElement('span');
      tiles.className = 'opp-badge tiles';
      tiles.innerHTML = SVG_TILE;
      const mini = document.createElement('i');
      mini.className = 'mini-tile';
      mini.textContent = '×' + (view.handCounts?.[pid] ?? 0);
      tiles.appendChild(mini);
      st.appendChild(tiles);
    }
    info.appendChild(st);
    card.appendChild(avCol);
    card.appendChild(info);
    wrap.appendChild(card);
  }
}

// ── hand sorting: 7 tiles in draw order cost 5-10s of scanning per turn, which
// eats the 30s clock. Four modes, persisted per device. ──
// 'deal' is the smart default: playable-first while it IS my turn (so the
// card I can actually drop is the first one I see), stable deal order otherwise
// so the hand never reshuffles itself every 20s during opponents' turns (1.3).
const SORT_MODES = ['deal', 'pips', 'playable', 'doubles'];
const SORT_TITLES = {
  deal: 'كما وصلني',
  pips: 'الأتقل أولًا',
  playable: 'المتاح أولًا',
  doubles: 'الدبل أولًا',
};
let sortMode = (() => {
  try {
    const v = localStorage.getItem('domino_sort');
    return SORT_MODES.includes(v) ? v : 'deal';
  } catch { return 'deal'; }
})();

function paintSortBtn() {
  const btn = $('btnSort');
  if (!btn) return;
  const label = $('sortLabel');
  if (label) label.textContent = 'ترتيب';
  btn.title = 'ترتيب اليد: ' + SORT_TITLES[sortMode];
  btn.setAttribute('aria-label', btn.title);
}

function sortedHand() {
  const h = [...(view.hand || [])];
  const myTurn = !spectating && view.turn === myId && view.status === 'playing';
  const playable = new Set(myTurn ? (view.legalMoves || []).map(m => m.tileId) : []);
  // stable partition: playable first, deal order preserved inside each group
  const playableFirst = arr => [
    ...arr.filter(t => playable.has(t.id)),
    ...arr.filter(t => !playable.has(t.id)),
  ];
  if (sortMode === 'deal') return (myTurn && playable.size) ? playableFirst(h) : h;
  const pipsOf = t => t.a + t.b;
  // One shared tie-break for every pip-based mode: heaviest first, then the
  // largest tile (same total) first. Keeps 'pips' and 'playable' visually
  // consistent and makes the order fully deterministic.
  const byPips = (x, y) => pipsOf(y) - pipsOf(x) || (y.b - x.b) || (y.a - x.a);
  if (sortMode === 'pips') return h.sort(byPips);
  if (sortMode === 'doubles') {
    return h.sort((x, y) => ((y.a === y.b) - (x.a === x.b)) || byPips(x, y));
  }
  // 'playable' — a legal move first. Only meaningful on my turn; other players
  // get legalMoves = [] so this degrades to pips order, which is fine.
  return h.sort((x, y) => (playable.has(y.id) - playable.has(x.id)) || byPips(x, y));
}

function cycleSort() {
  const i = SORT_MODES.indexOf(sortMode);
  sortMode = SORT_MODES[(i + 1) % SORT_MODES.length];
  try { localStorage.setItem('domino_sort', sortMode); } catch { /* no storage */ }
  paintSortBtn();
  sfx.click();
  renderHand();
}

function renderHand() {
  if (!view) return; // boot/themes can repaint before any game:state arrives
  // A state broadcast can rebuild the hand mid-drag. Without this, the DOM
  // drag ghost and its pointer capture survived with no element left to end
  // the gesture, leaving a tile glued over the board/hand.
  if (tileDrag) cancelTileDrag();
  const hand = $('hand');
  const myTurn = !spectating && view.turn === myId && view.status === 'playing';
  hand.classList.toggle('my-turn', myTurn);
  hand.innerHTML = '';
  const playableIds = new Set(myTurn ? (view.legalMoves || []).map(m => m.tileId) : []);
  const handList = sortedHand();
  for (const t of handList) {
    const el = document.createElement('div');
    el.className = 'tile-h';
    if (newlyDrawnTileId && t.id === newlyDrawnTileId) {
      el.classList.add('newly-drawn');
    }
    el.style.backgroundImage = `url(${tileImage(t.a, t.b)})`;
    if (myTurn) {
      if (playableIds.has(t.id)) el.classList.add('playable');
      else el.classList.add('dim');
      if (view.leadForcedTile === t.id) el.classList.add('forced');
      // Draw rules: the tile just drawn must be played — reuse the forced-look
      if (view.forcedDrawTile === t.id) el.classList.add('forced', 'just-drawn');
    }
    if (selectedTile === t.id) el.classList.add('selected');
    if (myTurn && playableIds.has(t.id)) {
      el.classList.add('draggable');
      el.addEventListener('pointerdown', (e) => startTileDrag(e, t, el));
      el.addEventListener('pointermove', moveTileDrag);
      el.addEventListener('pointerup', endTileDrag);
      el.addEventListener('pointercancel', endTileDrag);
    } else {
      el.onclick = () => onTileClick(t, el);
    }
    hand.appendChild(el);
  }
  // 1.2: "what can I play" as a number, not an inference. Only meaningful on my
  // turn — during opponents' turns every tile would read as "dead".
  const cnt = $('handCount');
  if (cnt) {
    const playableN = playableIds.size;
    const deadN = myTurn ? handList.length - playableN : 0;
    cnt.textContent = myTurn ? `${playableN} متاح · ${deadN} ميت` : '';
    cnt.classList.toggle('hidden', !myTurn || !handList.length);
  }
}

function renderActions() {
  const myTurn = !spectating && view.turn === myId && view.status === 'playing';
  $('btnDraw').classList.toggle('hidden', spectating || !(myTurn && view.canDraw));
  // 0.13: the boneyard count is a standing HUD chip now — for ~75% of a match the
  // draw button is hidden, and the pile size is real information the whole time.
  const chip = $('boneChip');
  if (chip) {
    const n = view.boneyardCount ?? 0;
    chip.classList.toggle('hidden', view.status !== 'playing' || n <= 0);
    $('boneChipN').textContent = String(n);
  }
  $('btnPass').classList.toggle('hidden', spectating || !(myTurn && view.canPass));
  // Hint only makes sense when it's my turn AND there is something to suggest.
  $('btnHint').classList.toggle('hidden', !myTurn || (view.legalMoves || []).length === 0);
  const pill = $('endsPill');
  if (view.variant === 'allfives' && view.moves.length) {
    pill.classList.remove('hidden');
    pill.title = 'مجموع أرقام أطراف السلسلة — لو قابل القسمة على 5 بتكسب نقاط فورًا';
    $('endsTotal').textContent = view.endsTotal;
    pill.classList.toggle('hot', view.endsTotal > 0 && view.endsTotal % 5 === 0);
  } else pill.classList.add('hidden');
}

// F4.4: previous score per player, so renderScoreCard can roll the number up
// instead of snapping. Only ever holds at most 4 (a table's worth of) entries.
const _scorePrev = new Map();
function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
/** Animate `el`'s text from `from` to `to` over ~420ms (or snap, if reduced-motion). */
function rollNumber(el, from, to) {
  if (!el) return;
  if (from === to || prefersReducedMotion()) { el.textContent = String(to); return; }
  const t0 = performance.now();
  const dur = 420;
  const step = (now) => {
    const k = Math.min((now - t0) / dur, 1);
    const e = 1 - (1 - k) ** 3;                  // cubic ease-out
    el.textContent = String(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = String(to);
  };
  requestAnimationFrame(step);
}

function renderScoreCard() {
  const card = $('scoreCard');
  if (!card || !view) return;
  const ranked = [...view.players].sort((a, b) => (view.scores[b] || 0) - (view.scores[a] || 0));
  card.innerHTML = '';
  ranked.forEach((pid, i) => {
    const row = document.createElement('div');
    row.className = 'sc-row' + (pid === myId ? ' me' : '');
    const safeName = esc(view.names[pid] || 'لاعب');
    row.innerHTML = `
      <span class="sc-rank">${i + 1}</span>
      <span class="sc-name" title="${safeName}">${view.isBot?.[pid] ? SVG_BOT : ''}<span class="sc-who">${safeName}</span></span>
      <span class="sc-pts">${view.scores[pid] || 0}</span>
    `;
    card.appendChild(row);
  });
  // F4.4: roll each score up from its previous value. Runs AFTER the rows are in
  // the DOM so the rAF writes land on the live elements — and (1.7) after a short
  // delay so the number starts moving when the tile LANDS, not when the state
  // broadcast arrived ~500ms earlier. The `from` values are snapshotted NOW,
  // before _scorePrev advances below.
  if (!prefersReducedMotion()) {
    const prevSnapshot = ranked.map(pid => _scorePrev.get(pid));
    setTimeout(() => {
      if (!view) return;
      card.querySelectorAll('.sc-row').forEach((row, i) => {
        const pid = ranked[i];
        const to = (view.scores?.[pid]) || 0;
        const from = prevSnapshot[i];
        if (from !== undefined && from !== to) rollNumber(row.querySelector('.sc-pts'), from, to);
      });
    }, 500);
  }
  for (const pid of ranked) _scorePrev.set(pid, view.scores[pid] || 0);
  // Drop stale keys so the map cannot grow across many rooms.
  for (const pid of [..._scorePrev.keys()]) if (!ranked.includes(pid)) _scorePrev.delete(pid);
  // Room code under the scores — the only code display on the game screen,
  // so players can share/copy it mid-match. Tap copies it.
  if (roomCode) {
    const codeRow = document.createElement('div');
    codeRow.className = 'sc-code';
    codeRow.title = 'انسخ كود الغرفة';
    codeRow.innerHTML = `<span class="sc-code-label">غرفة</span><b>${esc(roomCode)}</b>${SVG_COPY}`;
    codeRow.onclick = () => { copyText(roomCode, 'تم نسخ الكود!'); sfx.click(); };
    card.appendChild(codeRow);
  }
}

// The coaching banner (turn instructions) has exactly one writer: renderTurnBanner.
// Anything that needs to say something ELSE — "pick the green dot", "the server
// played for you", "you reconnected" — sets an OVERRIDE with a hold, and the
// canonical line comes back on its own when the hold expires (bug 0.17).
let bannerOverride = null;
let bannerHoldTimer = null;
function setBanner(text, cls) {
  const el = $('turnBanner');
  if (!el) return;
  $('turnBannerText').textContent = text;
  el.className = cls || '';
}
/** Say something for `ms`, then restore the normal turn instruction. */
function setBannerHold(text, cls, ms = 2600) {
  bannerOverride = { text, cls };
  setBanner(text, cls);
  clearTimeout(bannerHoldTimer);
  bannerHoldTimer = setTimeout(() => {
    bannerHoldTimer = null;
    bannerOverride = null;
    renderTurnBanner();
  }, ms);
}
function clearBannerHold() {
  if (!bannerOverride) return;
  bannerOverride = null;
  clearTimeout(bannerHoldTimer);
  bannerHoldTimer = null;
  renderTurnBanner();
}

// ══════════ F3.3 performance overlay ══════════
function togglePerf(force) {
  perfOn = force === undefined ? !perfOn : !!force;
  const box = $('perfOverlay');
  if (!box) return;
  box.classList.toggle('hidden', !perfOn);
  if (perfOn) {
    if (!localStorage.getItem('domino_perf_seen')) {
      localStorage.setItem('domino_perf_seen', '1');
      floatText('📊 لوحة الأداء — اضغط P تاني للقفل');
    }
    perfFrames = 0; perfFrameStart = performance.now(); perfMsgs = 0;
    perfSyncCount = 0; perfPeakGeos = 0; perfPeakTexs = 0;
    perfMinFps = Infinity; perfMaxSyncMs = 0;
    perfTickLoop();
    clearInterval(perfTimer);
    perfTimer = setInterval(updatePerfText, 500);
  } else {
    cancelAnimationFrame(perfRaf);
    clearInterval(perfTimer);
    perfRaf = 0; perfTimer = null;
  }
}

// Count frames via rAF so the FPS figure is what the display is actually doing.
function perfTickLoop() {
  const loop = () => {
    if (!perfOn) return;
    perfFrames++;
    const now = performance.now();
    if (now - perfFrameStart >= 1000) {
      const fps = Math.round((perfFrames * 1000) / (now - perfFrameStart));
      if (fps < perfMinFps) perfMinFps = fps;
      perfLastFps = fps;
      perfFrames = 0; perfFrameStart = now;
    }
    perfRaf = requestAnimationFrame(loop);
  };
  perfRaf = requestAnimationFrame(loop);
}
let perfLastFps = 0;

function updatePerfText() {
  if (!perfOn) return;
  const box = $('perfOverlay');
  if (!box) return;
  const s = board?.stats?.() || {};
  if (s.geos > perfPeakGeos) perfPeakGeos = s.geos;
  if (s.texs > perfPeakTexs) perfPeakTexs = s.texs;
  if (perfLastSyncMs > perfMaxSyncMs) perfMaxSyncMs = perfLastSyncMs;
  const mem = performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB'
    : '—';
  const rows = [
    ['FPS', `${perfLastFps} <span class="perf-dim">min ${perfMinFps === Infinity ? '—' : perfMinFps}</span>`],
    ['draw calls', String(s.calls ?? 0)],
    ['triangles', (s.tris ?? 0).toLocaleString('en-US')],
    ['geometries', `${s.geos ?? 0} <span class="perf-dim">peak ${perfPeakGeos}</span>`],
    ['textures', `${s.texs ?? 0} <span class="perf-dim">peak ${perfPeakTexs}</span>`],
    ['programs', String(s.programs ?? 0)],
    ['chain tiles', String(s.chainMeshes ?? 0)],
    ['anims', String(s.anims ?? 0)],
    ['mat pool', String(s.matPool ?? 0)],
    ['sync ms', `${perfLastSyncMs.toFixed(1)} <span class="perf-dim">max ${perfMaxSyncMs.toFixed(1)}</span>`],
    ['syncs/s', String(perfSyncCount)],
    ['msgs/s', String(perfMsgs)],
    ['moves', String(view?.moves?.length ?? 0)],
    ['quality', `${s.quality ?? '—'} <span class="perf-dim">bloom ${s.composer ? 'on' : 'off'}</span>`],
    ['heap', mem],
  ];
  box.innerHTML = '<div class="perf-title">📊 أداء</div>'
    + rows.map(([k, v]) => `<div class="perf-row"><span>${k}</span><b>${v}</b></div>`).join('');
  perfSyncCount = 0;
  perfMsgs = 0;
}

// ── "your turn" attention: flashing tab title + vibration + optional notification ──
const BASE_TITLE = document.title;
let turnAlertOn = false;
let turnAlertTimer = null;
function vibrationOn() {
  try { return localStorage.getItem('domino_vibrate') !== '0'; } catch { return true; }
}
function startTurnAlert() {
  if (turnAlertOn) return;
  turnAlertOn = true;
  document.title = '🔔 دورك — دومينو أرينا';
  // K3.C8: actually blink the title while the tab is hidden (it used to be set
  // once and never flashed), until the player returns or acts.
  clearInterval(turnAlertTimer);
  turnAlertTimer = setInterval(() => {
    document.title = document.title.startsWith('🔔🔔')
      ? '🔔 دورك — دومينو أرينا'
      : '🔔🔔 دورك! — دومينو أرينا';
  }, 1200);
  // K3.C6: vibration respects the settings toggle.
  if (vibrationOn()) {
    try { navigator.vibrate?.([180, 80, 180]); } catch (e) { /* unsupported */ }
  }
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('🔔 دورك!', { body: `دورك في غرفة ${roomCode || ''} — افتح اللعبة واتحرك` });
    } catch (e) { /* some platforms throw without a service worker */ }
  }
}
function stopTurnAlert() {
  if (!turnAlertOn) return;
  turnAlertOn = false;
  clearInterval(turnAlertTimer);
  turnAlertTimer = null;
  document.title = BASE_TITLE;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTurnAlert(); });
// The permission prompt needs a user gesture — we piggyback on lobby button
// clicks instead of surprising people with a popup mid-game.
function askNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch (e) { /* unsupported */ }
}

// ── optional autoplay: when my hand has exactly one legal move, play it after a beat ──
function maybeAutoPlay() {
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
  try { if (localStorage.getItem('domino_autoplay') !== '1') return; } catch (e) { return; }
  if (!view || view.status !== 'playing' || view.turn !== myId) return;
  if (view.leadForcedTile || view.forcedDrawTile || view.moves.length === 0) return;   // opening / forced-draw stays manual
  if ((view.legalMoves || []).length !== 1) return;
  const m = view.legalMoves[0];
  const captured = view.turn;
  autoPlayTimer = setTimeout(() => {
    if (!view || view.status !== 'playing' || view.turn !== captured) return;
    const cur = (view.legalMoves || [])[0];
    if (!cur || cur.tileId !== m.tileId || cur.end !== m.end) return;
    socket.emit('game:play', { tileId: m.tileId, end: m.end });
    floatText('⚡ لعبناها لك');
  }, 400);
}

// ── All Fives preview: replay the public move history client-side and compute
// the ends total if tileId were played on end. Mirrors engine rules (lead double
// counts once, doubles score full pips, spinner U/D arms attach at spinner value). ──
function previewEndsTotal(tileId, end) {
  if (!view || view.variant !== 'allfives') return null;
  const byId = new Map();
  for (const t of (view.hand || [])) byId.set(t.id, t);
  for (const m of (view.moves || [])) byId.set(m.t.id, m.t);
  const tileOf = (id) => {
    if (byId.has(id)) return byId.get(id);
    const [x, y] = id.split('-').map(Number);
    return { id, a: Math.min(x, y), b: Math.max(x, y) };
  };
  const ends = {};
  let spinnerId = null;
  const applyPlay = (id, e) => {
    const tile = tileOf(id);
    const dbl = tile.a === tile.b;
    const pips = tile.a + tile.b;
    if (!Object.keys(ends).length) {
      ends.L = { match: tile.a, score: dbl ? pips : tile.a, tileId: id, dbl };
      ends.R = { match: tile.b, score: dbl ? pips : tile.b, tileId: id, dbl };
      if (dbl) spinnerId = id;
      return;
    }
    const cur = ends[e];
    const match = cur ? cur.match : (spinnerId ? tileOf(spinnerId).a : null);
    if (match == null) return;
    const outer = tile.a === match ? tile.b : tile.a;
    ends[e] = { match: outer, score: dbl ? pips : outer, tileId: id, dbl };
    if (dbl && !spinnerId) spinnerId = id;
  };
  for (const m of (view.moves || [])) applyPlay(m.t.id, m.e);
  if (tileId && end) applyPlay(tileId, end);
  const seen = new Set();
  let total = 0;
  for (const k of ['L', 'R', 'U', 'D']) {
    const e2 = ends[k];
    if (!e2) continue;
    if (e2.dbl) { if (seen.has(e2.tileId)) continue; seen.add(e2.tileId); }
    total += e2.score;
  }
  return total;
}

function renderTurnBanner() {
  if (bannerOverride) return;   // a coaching/notice line is holding the banner
  if (spectating) {
    const pid = view.turn;
    const nm = view.names?.[pid] || '';
    const n = view.handCounts?.[pid];
    setBanner(view.status === 'playing'
      ? `👁 بتتفرج — دور ${nm}${n != null ? ` · معاه ${n} ورق` : ''}`
      : '👁 بتتفرج', 'spect');
    return;
  }
  if (view.status !== 'playing') { setBanner('', ''); return; }
  if (view.turn === myId) {
    if (view.forcedDrawTile) {
      setBanner('دورك — لازم تلعب الكارت اللي سحبته', 'mine');
    } else if (view.leadForcedTile) {
      setBanner('دورك — العب الكارت المحدد للبداية', 'mine');
    } else if (view.moves.length === 0) {
      setBanner('دورك — اختر أي كارت لبدء اللعبة', 'mine');
    } else if (view.canDraw) {
      setBanner('دورك — اسحب كارت من الطاولة بالنقر عليه', 'mine');
    } else if (view.canPass) {
      setBanner('دورك — لا يوجد لعب متاح، اضغط تمرير (باص)', 'mine');
    } else {
      setBanner('دورك الآن', 'mine');
    }
  } else {
    const pid = view.turn;
    const nm = view.names[pid] || 'اللاعب';
    const n = view.handCounts?.[pid];
    setBanner(n != null ? `دور ${nm} — معاه ${n} ورق` : `دور ${nm}`, '');
  }
}

// ── turn countdown (ticks independently of game-state renders) ──
// >10s left: small isolated number. Last 10s: big red number mid-screen.
// Last 5s: alarm pulse + beeps (sound only on my turn).
function updateTurnTimer() {
  const wrap = $('turnTimer');
  if (!wrap) return;
  // F2.1: turnMs 0 = the host chose "no turn timer" → the countdown never shows.
  if (!view || view.status !== 'playing' || !view.turnEndsAt || view.turnMs === 0) {
    wrap.classList.add('hidden');
    lastTimerKey = null;
    return;
  }
  if (view.turnEndsAt !== lastTimerKey) { lastTimerKey = view.turnEndsAt; lastTickSec = null; }
  // clockOffset was captured when this state arrived, so Date.now() keeps ticking
  const remainMs = view.turnEndsAt - (Date.now() + clockOffset);
  if (remainMs <= 0) { wrap.classList.add('hidden'); return; } // server will advance the turn shortly
  const secs = Math.ceil(remainMs / 1000);
  wrap.classList.remove('hidden');
  // 0.16: the alarm escalation is only for YOUR clock. A 130px red number over
  // the board while you have no legal move is anxiety with no action available.
  const mine = view.turn === myId && !spectating;
  wrap.classList.toggle('warn', mine && remainMs <= 10000);
  wrap.classList.toggle('danger', mine && remainMs <= 5000);
  // C: conic-gradient ring progress (0–100) read by the CSS
  wrap.style.setProperty('--p', Math.max(0, Math.min(100, (remainMs / view.turnMs) * 100)).toFixed(1));
  $('turnTimerSecs').textContent = secs;
  if (view.turn === myId && secs !== lastTickSec) {
    lastTickSec = secs;
    if (secs <= 5) sfx.alarm();
    else if (secs <= 10) sfx.tick();
  }
}

// ── local career stats (no accounts — lives in localStorage on this device) ──
// F4.1: matches / wins / streak / bestStreak / avgScore / bestScore / recent form.
// The shape is versioned implicitly: unknown/older fields simply default, so a
// profile written by an earlier build keeps working without a migration step.
let recordedMatchKey = null;
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem('domino_stats'));
    if (s && typeof s === 'object') {
      return {
        matches: s.matches || 0,
        wins: s.wins || 0,
        bestScore: s.bestScore || 0,
        botWins: s.botWins || 0,
        streak: s.streak || 0,          // current consecutive wins
        bestStreak: s.bestStreak || 0,  // longest run of wins ever
        avgScore: s.avgScore || 0,      // running mean of my end-of-match score
        history: Array.isArray(s.history) ? s.history.slice(0, 12) : [],  // newest first
      };
    }
  } catch { /* corrupt or absent */ }
  return {
    matches: 0, wins: 0, bestScore: 0, botWins: 0,
    streak: 0, bestStreak: 0, avgScore: 0, history: [],
  };
}
function recordMatchResult(v) {
  const key = v.matchWinnerId + ':' + Object.entries(v.scores).sort().join(',');
  if (recordedMatchKey === key) return; // renderModals re-runs — record once
  recordedMatchKey = key;
  const s = loadStats();
  const iWon = v.matchWinnerId === myId;
  s.matches += 1;
  if (iWon) {
    s.wins += 1;
    if (Object.values(v.isBot || {}).some(Boolean)) s.botWins += 1;
  }
  // streak bookkeeping
  s.streak = iWon ? s.streak + 1 : 0;
  if (s.streak > s.bestStreak) s.bestStreak = s.streak;
  // running average of my own score at match end
  const myScore = v.scores[myId] || 0;
  s.avgScore = Math.round(((s.avgScore * (s.matches - 1)) + myScore) / s.matches);
  if (myScore > s.bestScore) s.bestScore = myScore;
  // recent form — newest first, capped
  s.history.unshift({ won: iWon, score: myScore, bots: Object.values(v.isBot || {}).some(Boolean) ? 1 : 0 });
  if (s.history.length > 12) s.history.length = 12;
  try { localStorage.setItem('domino_stats', JSON.stringify(s)); } catch { /* no storage */ }
  renderHomeStats();
  announceStreak(s);
}

// A one-line celebratory chat note when a win streak reaches a milestone. Purely
// cosmetic, sent once per match, only while actually connected to a room.
function announceStreak(s) {
  if (!socket?.connected || !roomCode) return;
  if (s.streak >= 3 && s.streak % 3 === 0) {
    socket.emit('chat:send', { text: `🔥 ${s.streak} انتصارات على التوالي!` });
  }
}

function streakLabel(streak) {
  if (streak >= 5) return `🔥🔥 ${streak}`;
  if (streak >= 3) return `🔥 ${streak}`;
  if (streak >= 1) return `↗ ${streak}`;
  return '—';
}

// compact W/L sparkline of the most recent matches (newest on the left)
function formStrip(history) {
  return history.slice(0, 10).map(h => h.won ? '🟩' : '🟥').join('');
}

function renderHomeStats() {
  const el = $('homeStats');
  if (!el) return;
  const s = loadStats();
  if (!s.matches) {
    el.innerHTML = '';
    el.classList.add('hidden');
  } else {
    const winPct = Math.round((s.wins / s.matches) * 100);
    el.classList.remove('hidden');
    el.innerHTML =
      `<div class="stat-card"><b>${s.matches}</b><span>مباراة</span></div>` +
      `<div class="stat-card gold"><b>${winPct}%</b><span>🏆 ${s.wins} فوز</span></div>` +
      `<div class="stat-card mint"><b>${streakLabel(s.streak)}</b><span>السلسلة · أطول ${s.bestStreak}</span></div>` +
      `<div class="stat-card"><b>${s.bestScore}</b><span>أعلى نتيجة · متوسط ${s.avgScore}</span></div>` +
      (s.history.length
        ? `<div class="stat-form" title="آخر ${s.history.length} مباريات (الأحدث أولاً)">${formStrip(s.history)}</div>`
        : '');
  }
  const reset = $('btnResetStats');
  if (reset) reset.classList.toggle('hidden', !s.matches);
}

function renderModals() {
  // hand end
  const handModal = $('modalHand');
  if (view.status === 'handEnd' && view.handResult) {
    const hr = view.handResult;
    $('handTitle').textContent = hr.winnerId
      ? `${hr.winnerId === myId ? 'أنت' : (view.names[hr.winnerId] || 'اللاعب')} فاز بالجولة!`
      : 'لعبة مقفولة (حجز) — تعادل!';
    const bd = $('handBreakdown');
    bd.innerHTML = '';
    for (const pid of view.players) {
      const row = document.createElement('div');
      row.className = 'bd-row' + (pid === hr.winnerId ? ' winner' : '');
      row.innerHTML = `<span>${esc(view.names[pid] || 'لاعب')}</span>
        <span>${hr.pips[pid]} نقطة${pid === hr.winnerId ? ` ← +${hr.points}` : ''}</span>`;
      bd.appendChild(row);
    }
    const nhVotes = view.nextHandVotes;
    const nhBtn = $('btnNextHand');
    nhBtn.classList.toggle('hidden', !isHost);
    // 1.4: the host ACTS (▶), a guest VOTES (✋) — two different verbs that used
    // to look like the same button.
    if (isHost && nhVotes?.count) nhBtn.textContent = `▶ الجولة التالية (${nhVotes.count}/${nhVotes.humans} يطلبوا)`;
    else nhBtn.textContent = '▶ الجولة التالية';
    const nhVoteBtn = $('btnNextHandVote');
    nhVoteBtn.classList.toggle('hidden', isHost);
    if (!isHost) {
      const already = nhVotes?.count ? ' ✓ تم الإرسال' : '';
      nhVoteBtn.textContent = `✋ أطلب الجولة التالية${nhVotes?.count ? ` (${nhVotes.count}/${nhVotes.humans})` : ''}${already}`;
      nhVoteBtn.disabled = !!nhVotes?.count;
    }
    $('handWait').classList.toggle('hidden', isHost);
    handModal.classList.remove('hidden');
  } else handModal.classList.add('hidden');

  // match end
  const matchModal = $('modalMatch');
  if (view.status === 'matchEnd') {
    const stalled = !!(view.handResult && view.handResult.stallEnd);
    $('matchWinner').textContent = stalled
      ? `${view.matchWinnerId === myId ? 'أنت' : (view.names[view.matchWinnerId] || 'الفائز')} (أعلى سكور)`
      : (view.matchWinnerId === myId ? 'أنت' : (view.names[view.matchWinnerId] || 'الفائز'));
    // Safety-net ending: no one reached the target, the leader takes it.
    const stallNote = $('matchStallNote');
    if (stallNote) {
      stallNote.textContent = stalled
        ? 'انتهت المباراة تلقائيًا بعد عدة جولات بلا تسجيل — الفوز لأعلى مجموع نقاط.'
        : '';
      stallNote.classList.toggle('hidden', !stalled);
    }
    const st = $('matchStandings');
    st.innerHTML = '';
    [...view.players].sort((a, b) => view.scores[b] - view.scores[a]).forEach((pid, i) => {
      const row = document.createElement('div');
      row.className = 'bd-row' + (i === 0 ? ' winner' : '');
      row.innerHTML = `<span>${i + 1}. ${esc(view.names[pid] || 'لاعب')}</span><span>${view.scores[pid]} نقطة</span>`;
      st.appendChild(row);
    });
    // F2.2: the vote is per-player and tracked by name, not just a counter, and
    // a NON-host can now start the match outright if every other human voted.
    const rmVotes = view.rematchVotes || [];              // names, from rookm.rematchVotes
    const humans = view.humanCount || 1;
    const iVoted = (view.rematchVoters || []).includes(myId);
    const rmBtn = $('btnRematch');
    rmBtn.classList.toggle('hidden', !isHost);
    rmBtn.textContent = rmVotes.length
      ? `▶ مباراة جديدة (${rmVotes.length}/${humans} وافقوا)`
      : '▶ مباراة جديدة';
    const rmVoteBtn = $('btnRematchVote');
    rmVoteBtn.classList.toggle('hidden', isHost);
    if (!isHost) {
      rmVoteBtn.textContent = iVoted ? '✓ طلبت مباراة جديدة' : '✋ أطلب مباراة جديدة';
      rmVoteBtn.disabled = iVoted;
    }
    // Show WHICH players are in, so the table can see who is holding things up.
    const voteNote = $('matchVoteNote');
    if (voteNote) {
      voteNote.textContent = rmVotes.length
        ? `منتظرين: ${rmVotes.join('، ')} (${rmVotes.length}/${humans})`
        : '';
      voteNote.classList.toggle('hidden', rmVotes.length === 0);
    }
    $('matchWait').classList.toggle('hidden', isHost);
    matchModal.classList.remove('hidden');
    startConfetti();
    recordMatchResult(view);
  } else { matchModal.classList.add('hidden'); stopConfetti(); }
}

function playActionSounds() {
  const la = view.lastAction;
  if (!la) return;
  const key = JSON.stringify(la) + view.moves.length + view.status + (view.boneyardCount ?? '');
  if (key === lastActionKey) return;
  const wasMyTurn = prevTurnKey === myId;
  lastActionKey = key;
  if (la.type === 'place') { sfx.place(); if (la.scored) { sfx.score(); floatText(`+${la.scored}`); } }
  else if (la.type === 'draw') {
    sfx.draw();
    const isMe = la.pid === myId;
    let drawnTile = null;
    if (isMe) {
      const prevIds = new Set(prevHand.map(t => t.id));
      drawnTile = (view.hand || []).find(t => !prevIds.has(t.id)) || view.hand?.[view.hand.length - 1];
      if (drawnTile) {
        newlyDrawnTileId = drawnTile.id;
        // Paint the hand immediately so the warm "just drawn" pop is visible
        // while the 3D tile is still flying, then let the highlight breathe.
        renderHand();
        setTimeout(() => {
          if (newlyDrawnTileId === drawnTile.id) {
            newlyDrawnTileId = null;
            renderHand();
          }
        }, 2000);
      }
    } else {
      floatText(`${view.names[la.pid] || 'لاعب'}: سحب كارت`);
    }
    board?.animateDraw(drawnTile, isMe);
  }
  else if (la.type === 'pass') { sfx.pass(); if (la.pid !== myId) floatText(`${view.names[la.pid] || 'لاعب'}: باص`); }
  else if (la.type === 'skip') {
    sfx.pass();
    floatText(la.pid === myId ? '⏰ انتهى وقتك!' : `⏰ ${view.names[la.pid] || 'لاعب'}: انتهى وقته`);
    // 1.6: name the situation in the banner too — the float alone scrolls away.
    setBannerHold(la.pid === myId ? '⏰ اتقضى وقتك — اتخطّينا دورك' : `⏰ اتقضى وقت ${view.names[la.pid] || 'اللاعب'}`, '', 3600);
  }
  else if (la.type === 'handEnd') sfx.handWin();
  else if (la.type === 'matchEnd') sfx.matchWin();
  if (view.status === 'playing' && view.turn === myId) {
    if (!wasMyTurn) { sfx.yourTurn(); startTurnAlert(); }
  } else {
    stopTurnAlert();
  }
  prevTurnKey = view.turn;
}
let prevTurnKey = null;

// ══════════ interaction ══════════
// Server-side hint (AD-2): the bot brain needs real engine methods (cloneGame),
// so we ask the server and it replies with ONLY { type, tileId, end } — never
// any opponent hand data. See game:hint in server.js.
let hintPending = false;
async function requestHint() {
  if (hintPending || !view || view.status !== 'playing' || view.turn !== myId) return;
  hintPending = true;
  const btn = $('btnHint');
  btn.disabled = true;
  sfx.click();
  try {
    const res = await emit('game:hint');
    if (!res?.ok || res.type !== 'play') {
      floatText(res?.type === 'draw' ? '💡 مفيش حركة — اسحب كارت'
        : res?.type === 'pass' ? '💡 مفيش حركة — مرّر' : 'مفيش تلميح متاح دلوقتي');
      return;
    }
    selectedTile = res.tileId;
    if (board) {
      const moves = (view.legalMoves || []).filter(m => m.tileId === res.tileId);
      const ends = moves.map(m => m.end).filter(e => e != null);
      if (ends.length) board?.showMarkers(ends);
    }
    renderHand();
    sfx.select();
  } finally {
    hintPending = false;
    btn.disabled = false;
  }
}

function onBoneyardDraw(targetMesh) {
  if (!view || view.status !== 'playing' || view.turn !== myId || !view.canDraw) return;
  socket.emit('game:draw');
  sfx.click();
}
function onTileClick(tile, el) {
  if (!view || view.status !== 'playing' || view.turn !== myId) {
    el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 300);
    return;
  }
  const moves = view.legalMoves.filter(m => m.tileId === tile.id);
  if (!moves.length) {
    el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 300);
    return;
  }
  const uniqueEnds = [...new Set(moves.map(m => m.end))];
  // 1.1: one legal end is not a choice — play it. The old tap-tile → tap-marker
  // dance cost a tap on the most common move in the game and made a lone marker
  // look like a button you were missing.
  if (uniqueEnds.length === 1) {
    sfx.select();
    socket.emit('game:play', { tileId: tile.id, end: uniqueEnds[0] });
    selectedTile = null;
    board?.clearMarkers();
    renderHand();
    return;
  }
  if (selectedTile === tile.id) {
    selectedTile = null; board?.clearMarkers(); renderHand();
    clearBannerHold();
    return;
  }
  sfx.select();
  selectedTile = tile.id;
  const previews = {};
  if (view.variant === 'allfives') {
    for (const e of uniqueEnds) previews[e] = endsDeltaLabel(previewEndsTotal(tile.id, e));
  }
  board?.showMarkers(uniqueEnds, view.variant === 'allfives' ? previews : null);
  renderHand();
  setBannerHold('اختر الطرف اللي عايز تلعب عليه — النقطة الخضراء', 'mine');
}

// 1.5: an All-Fives marker badge used to print the raw projected total as "+22",
// which reads like a bonus. Show the actual change instead, and stay silent when
// the play is worth nothing.
function endsDeltaLabel(after) {
  if (after == null) return null;
  const before = view?.endsTotal ?? 0;
  if (after === before) return null;         // "+0" told the player nothing
  return after > before ? `+${after - before}` : `${before} → ${after}`;
}

function onMarkerClick(end) {
  if (!selectedTile) return;
  socket.emit('game:play', { tileId: selectedTile, end });
  selectedTile = null;
  board?.clearMarkers();
  clearBannerHold();
  renderHand();
}

// ── drag & drop: hold a playable tile, then drop it on a board end ──
// 0.14: the hand scrolls horizontally (every tile is `pan-x`), so a touch drag
// has to be disambiguated from a swipe. Mouse/pen drags start immediately; a
// touch needs a short HOLD — which is also exactly what the scroller needs us to
// prove before we steal the gesture.
const TOUCH_HOLD_MS = 180;
let tileDrag = null;
function startTileDrag(e, tile, el) {
  if (e.button !== undefined && e.button !== 0) return;
  if (!view || view.status !== 'playing' || view.turn !== myId) return;
  const moves = (view.legalMoves || []).filter(m => m.tileId === tile.id);
  if (!moves.length) return;
  const touch = e.pointerType === 'touch';
  // The lead move has no drop target, but the drag must still be tracked: a
  // plain tap reaches endTileDrag → onTileClick, which plays the lead at once.
  // Bailing out here left the first tile of a hand unplayable (tap AND drag dead).
  tileDrag = {
    tile, el, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, over: null,
    noDrop: moves[0].end === null, armed: !touch, cancelled: false,
    holdTimer: null, safety: null,
  };
  // A pointerup that never reaches the original tile (the hand re-rendered,
  // the finger left the element, an OS gesture took over) must still end the
  // drag. Capture it at window level and hard-cap the gesture lifetime.
  const finish = (ev) => {
    if (tileDrag && tileDrag.el === el) endTileDrag(ev);
  };
  window.addEventListener('pointerup', finish, { once: true, passive: true });
  window.addEventListener('pointercancel', finish, { once: true, passive: true });
  tileDrag.safety = setTimeout(() => {
    if (tileDrag && tileDrag.el === el) cancelTileDrag();
  }, 15000);
  if (touch) {
    tileDrag.holdTimer = setTimeout(() => {
      if (!tileDrag || tileDrag.cancelled) return;
      armTileDrag();
    }, TOUCH_HOLD_MS);
  } else {
    armTileDrag();
  }
  function armTileDrag() {
    if (!tileDrag) return;
    tileDrag.armed = true;
    try { tileDrag.el.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    if (navigator.vibrate && vibrationOn()) { try { navigator.vibrate(8); } catch { /* unsupported */ } }
  }
}
function moveTileDrag(e) {
  if (!tileDrag) return;
  if (Math.hypot(e.clientX - tileDrag.startX, e.clientY - tileDrag.startY) > 8) {
    // Not held yet on touch → the user is swiping the hand, let the scroller win.
    if (!tileDrag.armed) { cancelTileDrag(); return; }
    tileDrag.moved = true;
  }
  if (!tileDrag.armed || tileDrag.noDrop || !tileDrag.moved) return;
  if (!tileDrag.ghost) {
    tileDrag.ghost = document.createElement('div');
    tileDrag.ghost.className = 'drag-ghost';
    tileDrag.ghost.style.backgroundImage = `url(${tileImage(tileDrag.tile.a, tileDrag.tile.b)})`;
    document.body.appendChild(tileDrag.ghost);
    if (board?.controls) board.controls.enabled = false; // camera stays put while dragging
    // reveal drop targets for this tile (same preview as selection)
    if (selectedTile !== tileDrag.tile.id) {
      const moves = view.legalMoves.filter(m => m.tileId === tileDrag.tile.id);
      const uniqueEnds = [...new Set(moves.map(m => m.end))];
      const previews = {};
      if (view.variant === 'allfives') {
        for (const en of uniqueEnds) previews[en] = endsDeltaLabel(previewEndsTotal(tileDrag.tile.id, en));
      }
      board?.showMarkers(uniqueEnds, view.variant === 'allfives' ? previews : null);
    }
  }
  // 0.15 is handled in CSS (`.drag-ghost { translate: -50% -110% }` lifts the
  // ghost above the fingertip); this only feeds it the raw pointer position.
  tileDrag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  const over = board?.endFromPoint?.(e.clientX, e.clientY) ?? null;
  if (over !== tileDrag.over) {
    tileDrag.over = over;
    board?.highlightEnd?.(over);
  }
}
// The browser took the gesture for a scroll — drop everything, play nothing.
function cancelTileDrag() {
  const d = tileDrag;
  tileDrag = null;
  if (!d) return;
  clearTimeout(d.holdTimer);
  clearTimeout(d.safety);
  d.ghost?.remove();
  if (board?.controls) board.controls.enabled = true;
  board?.highlightEnd?.(null);
}
function endTileDrag(e) {
  if (!tileDrag) return;
  const d = tileDrag;
  tileDrag = null;
  clearTimeout(d.holdTimer);
  clearTimeout(d.safety);
  try { d.el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  d.ghost?.remove();
  if (board?.controls) board.controls.enabled = true;
  board?.highlightEnd?.(null);
  if (e.type === 'pointercancel' || d.cancelled) return;   // scrolled away — no tap
  if (d.moved && d.over) {
    socket.emit('game:play', { tileId: d.tile.id, end: d.over });
    selectedTile = null;
    board?.clearMarkers();
    clearBannerHold();
    renderHand();
  } else if (d.moved) {
    // dropped nowhere — clean up the markers we revealed (unless tap-selected)
    if (selectedTile !== d.tile.id) { board?.clearMarkers(); }
  } else {
    onTileClick(d.tile, d.el); // no movement — treat as a plain tap
  }
}

function onBoardMiss() {
  // Do not deselect on accidental miss so touch users aren't frustrated
}

// ── K3.C3: mis-tap protection ──
// With "confirm moves" on, draw/pass need a second tap within 1.5s (the button
// shows "متأكد؟"). Placement stays instant — selecting an end is already a
// deliberate two-step gesture.
function confirmEnabled() {
  try { return localStorage.getItem('domino_confirm') === '1'; } catch { return false; }
}
const confirmTimers = new Map();
function withConfirm(btn, fn) {
  if (!confirmEnabled()) { fn(); return; }
  if (btn.dataset.armed === '1') {
    clearTimeout(confirmTimers.get(btn.id));
    confirmTimers.delete(btn.id);
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    fn();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  confirmTimers.set(btn.id, setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
  }, 1500));
}

function initGameUI() {
  $('btnDraw').onclick = (e) => { withConfirm(e.currentTarget, () => { socket.emit('game:draw'); sfx.click(); }); };
  $('btnPass').onclick = (e) => { withConfirm(e.currentTarget, () => { socket.emit('game:pass'); sfx.click(); }); };
  $('btnHint').onclick = requestHint;
  $('btnSort').onclick = cycleSort;
  paintSortBtn();
  // The in-game gear owns the settings modal. It MUST NOT reuse the home screen's
  // `#btnSettings` — both screens are up at once and the last bind used to win,
  // which silently killed the home play-settings toggle (bug 0.1).
  const btnGameSettings = $('btnGameSettings');
  if (btnGameSettings) btnGameSettings.onclick = () => { openSettings(); sfx.click(); };
  $('btnNextHand').onclick = () => socket.emit('game:nextHand');
  $('btnRematch').onclick = () => socket.emit('game:rematch');
  $('btnNextHandVote').onclick = () => { socket.emit('game:nextHandVote'); sfx.click(); };
  $('btnRematchVote').onclick = () => { socket.emit('game:rematchVote'); sfx.click(); };
  bindEl('btnChat', 'click', (e) => {
    e.stopPropagation();
    chatOpen ? closeChat() : openChat();
  });
  bindEl('chatClose', 'click', (e) => {
    e.stopPropagation();
    closeChat();
  });
  bindEl('chatScrollPill', 'click', (e) => {
    e.stopPropagation();
    scrollChatToBottom();
    unread = 0;
    updateBadge();
  });
  bindEl('chatMsgs', 'scroll', onChatScroll, { passive: true });
  document.addEventListener('click', (e) => {
    const drawer = $('chatDrawer');
    const fab = $('btnChat');
    const toasts = $('chatToasts');
    const onChatUi = (drawer && drawer.contains(e.target))
      || (fab && fab.contains(e.target))
      || (toasts && toasts.contains(e.target));
    if (chatOpen && !onChatUi) {
      closeChat();
    } else if (emojiPopOpen) {
      const pop = $('emojiPop');
      const emojiBtn = $('btnEmoji');
      if (pop && !pop.contains(e.target) && !(emojiBtn && emojiBtn.contains(e.target))) closeEmojiPop();
    }
  });
  document.addEventListener('keydown', (e) => {
    // F3.3: `P` toggles the performance overlay. Ignored while typing in a field
    // (chat name/input) so it can never eat a real keystroke.
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!typing && (e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      togglePerf();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('modalSettings')?.classList.contains('hidden')) {
        sfx.click();
        $('modalSettings').classList.add('hidden');
      } else if (!$('modalLeave').classList.contains('hidden')) {
        sfx.click();
        closeLeaveConfirm();
      } else if (emojiPopOpen) {
        closeEmojiPop();
      } else if (chatOpen) {
        closeChat();
      } else if (voicePanelOpen) {
        closeVoicePanel();
      }
    }
  });
  bindEl('btnEmoji', 'click', (e) => {
    e.stopPropagation();
    emojiPopOpen ? closeEmojiPop() : openEmojiPop();
  });
  bindEl('chatSend', 'click', sendChat);
  bindEl('chatInput', 'keydown', e => { if (e.key === 'Enter') sendChat(); });
  bindEl('chatInput', 'input', () => {
    updateChatCount();
    maybeSendChatTyping();
  });
  buildChatWidgets();
  updateChatCount();
  const btnFs = $('btnFullscreen');
  if (btnFs) {
    btnFs.onclick = toggleFullscreen;
  }
  const btnSound = $('btnSound');
  if (btnSound) {
    const syncSoundBtn = () => {
      btnSound.classList.toggle('is-muted', sfx.isMuted());
      btnSound.title = sfx.isMuted() ? 'تشغيل الصوت' : 'كتم الصوت';
      btnSound.setAttribute('aria-label', btnSound.title);
    };
    btnSound.onclick = () => {
      sfx.setMuted(!sfx.isMuted());
      syncSoundBtn();
      if (!sfx.isMuted()) sfx.click();
    };
    syncSoundBtn();
  }
  renderHomeStats();
  const resetStats = $('btnResetStats');
  if (resetStats) {
    resetStats.onclick = () => {
      if (!confirm('تمسح إحصائياتك المحلية؟')) return;
      localStorage.removeItem('domino_stats');
      renderHomeStats();
      sfx.click();
    };
  }
  // PWA: register the offline app-shell worker on secure contexts only
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is best-effort */ });
  }
  $('btnExit').onclick = () => { sfx.click(); openLeaveConfirm(); };
  $('btnLeaveCancel').onclick = () => { sfx.click(); closeLeaveConfirm(); };
  $('btnLeaveConfirm').onclick = leaveRoom;
  $('modalLeave').addEventListener('click', (e) => {
    if (e.target === $('modalLeave')) { sfx.click(); closeLeaveConfirm(); }
  });
  // K3.C7: rules modal (home + lobby) — close on ✕ or backdrop tap.
  for (const id of ['btnRulesHome', 'btnRulesClose']) {
    const b = $(id);
    if (b) b.onclick = () => { $('modalRules')?.classList.add('hidden'); sfx.click(); };
  }
  $('modalRules')?.addEventListener('click', (e) => {
    if (e.target === $('modalRules')) { sfx.click(); $('modalRules').classList.add('hidden'); }
  });
  initSettingsModal();
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(ev => {
    document.addEventListener(ev, updateFullscreenState);
  });
}

// ── K3.C6: settings modal — master volume, confirm-moves, vibration ──
function openSettings() {
  const modal = $('modalSettings');
  if (!modal) return;
  const rng = $('rngVolume');
  const vol = Math.round((sfx.getVolume?.() ?? 1) * 100);
  if (rng) rng.value = String(vol);
  const vv = $('volVal');
  if (vv) vv.textContent = vol + '%';
  const cf = $('chkConfirm');
  if (cf) cf.checked = confirmEnabled();
  const vb = $('chkVibrate');
  if (vb) vb.checked = vibrationOn();
  modal.classList.remove('hidden');
}
function initSettingsModal() {
  const modal = $('modalSettings');
  if (!modal) return;
  $('btnSettingsClose').onclick = () => { modal.classList.add('hidden'); sfx.click(); };
  modal.addEventListener('click', (e) => {
    if (e.target === modal) { sfx.click(); modal.classList.add('hidden'); }
  });
  const rng = $('rngVolume');
  if (rng) {
    rng.oninput = () => {
      sfx.setVolume?.(Number(rng.value) / 100);
      const vv = $('volVal');
      if (vv) vv.textContent = rng.value + '%';
    };
    rng.onchange = () => sfx.click();
  }
  const cf = $('chkConfirm');
  if (cf) {
    cf.onchange = () => {
      try { localStorage.setItem('domino_confirm', cf.checked ? '1' : '0'); } catch { /* no storage */ }
      sfx.click();
    };
  }
  const vb = $('chkVibrate');
  if (vb) {
    vb.onchange = () => {
      try { localStorage.setItem('domino_vibrate', vb.checked ? '1' : '0'); } catch { /* no storage */ }
      if (vb.checked) { try { navigator.vibrate?.(60); } catch { /* unsupported */ } }
      sfx.click();
    };
  }
}

function toggleFullscreen() {
  const doc = document;
  const isFull = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement);
  if (!isFull) {
    const el = doc.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      req.call(el).catch(() => {});
    }
  } else {
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
    if (exit) {
      exit.call(doc).catch(() => {});
    }
  }
}

function updateFullscreenState() {
  const doc = document;
  const isFull = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement);
  const btn = $('btnFullscreen');
  if (btn) {
    btn.classList.toggle('is-fullscreen', isFull);
    btn.title = isFull ? 'الخروج من ملء الشاشة' : 'ملء الشاشة';
  }
  setTimeout(() => board?.resize(), 100);
}

function sendChat() {
  const inp = $('chatInput');
  if (!inp || !socket || !roomCode) return;
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text });
  inp.value = '';
  updateChatCount();
  inp.focus();
}

function updateChatCount() {
  const inp = $('chatInput');
  if (!inp) return;
  const send = $('chatSend');
  if (send) send.disabled = inp.value.trim().length === 0;
  const cnt = $('chatCount');
  if (cnt) {
    cnt.textContent = String(200 - inp.value.length);
    cnt.classList.toggle('hidden', inp.value.length <= 150);
  }
}

function sendEmoji(em) {
  if (!socket || !roomCode) return;
  socket.emit('chat:send', { emoji: em });
  sfx.select();
}

// Client-side half of the typing throttle; the server throttles again at
// 1200 ms per socket and excludes the sender from its relay.
function maybeSendChatTyping() {
  if (!socket || !roomCode || !chatOpen) return;
  const now = Date.now();
  if (now - chatTypingSentAt < CHAT_TYPING_THROTTLE_MS) return;
  chatTypingSentAt = now;
  try { socket.emit('chat:typing'); } catch { /* disconnected */ }
}

// ── typing indicator ──
function onChatTyping(t) {
  if (!t || typeof t !== 'object' || !roomCode) return;
  const pid = t.pid ? String(t.pid) : '';
  if (!pid || pid === myId) return;
  const name = (typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : 'لاعب';
  const prev = chatTypers.get(pid);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    chatTypers.delete(pid);
    renderChatTyping();
  }, CHAT_TYPING_TTL_MS);
  chatTypers.set(pid, { name, timer });
  renderChatTyping();
}

function clearChatTyping(pid) {
  const entry = chatTypers.get(pid);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  chatTypers.delete(pid);
  renderChatTyping();
}

function clearChatTypers() {
  for (const entry of chatTypers.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  chatTypers.clear();
  renderChatTyping();
}

function renderChatTyping() {
  const el = $('chatTyping');
  if (!el) return;
  const names = [...chatTypers.values()].map(v => v.name);
  let text = '';
  if (names.length === 1) text = `${names[0]} بيكتب…`;
  else if (names.length > 1) text = `${names[0]} وآخر بيكتبوا…`;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

// ── rate-limit hint (inline, auto-hides, never a modal) ──
function clearChatHint() {
  clearTimeout(chatHintTimer);
  chatHintTimer = null;
  const hint = $('chatHint');
  if (hint) {
    hint.textContent = '';
    hint.classList.add('hidden');
  }
}

function onChatLimited(payload) {
  if (!roomCode) return;
  const hint = $('chatHint');
  if (!hint) return;
  const msg = (payload && typeof payload.message === 'string' && payload.message.trim())
    ? payload.message.trim()
    : 'استنى شوية — بتبعت رسايل كتير أوي.';
  hint.textContent = msg;
  hint.classList.remove('hidden');
  clearTimeout(chatHintTimer);
  chatHintTimer = setTimeout(() => hint.classList.add('hidden'), 3000);
}

// ── transcript helpers ──
function chatBox() { return $('chatMsgs'); }

// `msg.at` drives every time comparison. Local wall-clock time is only used to
// LABEL a timestamp for display.
function chatDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function chatDayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return 'النهارده';
  if (diffDays === 1) return 'امبارح';
  try {
    return d.toLocaleDateString('ar-EG', {
      day: 'numeric',
      month: 'long',
      ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });
  } catch { return d.toLocaleDateString(); }
}

function chatTimeLabel(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function isSystemMsg(msg) {
  return !!msg && !msg.pid && msg.from === 'النظام';
}

function isChatPinned() {
  const box = chatBox();
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
}

function scrollChatToBottom() {
  const box = chatBox();
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  chatScrolledUp = false;
}

function onChatScroll() {
  const box = chatBox();
  if (!box) return;
  const pinned = isChatPinned();
  chatScrolledUp = !pinned;
  if (pinned && unread) {
    unread = 0;
    updateBadge();
  }
}

// Bounded dedupe set: ids are shared by history and live events, so the window
// only has to outlive the server's 80-message log.
function markChatSeen(mid) {
  if (!mid) return false;
  if (chatSeen.has(mid)) return true;
  chatSeen.add(mid);
  chatSeenOrder.push(mid);
  if (chatSeenOrder.length > CHAT_SEEN_MAX) {
    const old = chatSeenOrder.shift();
    chatSeen.delete(old);
  }
  return false;
}

function clearChatUnreadDivider() {
  const box = chatBox();
  if (box) box.querySelectorAll('.chat-unread').forEach(el => el.remove());
  chatUnreadDividerShown = false;
}

function resetChatTranscript() {
  const box = chatBox();
  if (box) box.innerHTML = '';
  chatSeen.clear();
  chatSeenOrder = [];
  chatLastAt = 0;
  chatLastWho = '';
  chatLastDay = '';
  chatLastWasUser = false;
  chatUnreadDividerShown = false;
  chatScrolledUp = false;
  unread = 0;
  clearChatTypers();
  clearChatHint();
  // Only paint the empty placeholder while a room is attached; teardown must
  // leave the (hidden) transcript genuinely empty.
  if (roomCode) renderChatEmpty();
  updateBadge();
}

// Full per-room chat cleanup: drawer closed, transcript/typing/unread gone,
// body gate off so nothing floats over the home screen.
function endChatSession() {
  closeChat();
  resetChatTranscript();
  // A half-typed line must not leak into the next room.
  const inp = $('chatInput');
  if (inp) {
    inp.value = '';
    updateChatCount();
  }
  document.body.classList.remove('in-room');
  const chip = $('chatRoomChip');
  if (chip) chip.textContent = 'غرفة ----';
}

function buildChatWidgets() {
  const quick = $('chatQuick');
  if (quick) {
    quick.innerHTML = '';
    for (const em of CHAT_QUICK_EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = em;
      b.title = 'إرسال ' + em;
      b.setAttribute('aria-label', 'إرسال إيموجي ' + em);
      b.onclick = () => sendEmoji(em);
      quick.appendChild(b);
    }
  }
  const pop = $('emojiPop');
  if (pop) {
    pop.innerHTML = '';
    const phrases = document.createElement('div');
    phrases.className = 'pop-phrases';
    for (const phrase of CHAT_PHRASES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-chip';
      chip.textContent = phrase;
      chip.onclick = () => {
        if (!socket || !roomCode) return;
        socket.emit('chat:send', { text: phrase });
        sfx.select();
      };
      phrases.appendChild(chip);
    }
    pop.appendChild(phrases);
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    for (const [cat, list] of CHAT_EMOJI_GROUPS) {
      const h = document.createElement('div');
      h.className = 'emoji-cat';
      h.textContent = cat;
      grid.appendChild(h);
      for (const em of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = em;
        b.title = 'إرسال ' + em;
        b.onclick = () => sendEmoji(em);
        grid.appendChild(b);
      }
    }
    pop.appendChild(grid);
  }
}
// a text message made only of emoji (typed on a keyboard) still shows big & bubble-less
const EMOJI_ONLY_RE = (() => {
  try { return new RegExp('^[\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u200D\\uFE0F\\u20E3\\s]+$', 'u'); }
  catch { return null; }
})();
function isEmojiOnly(s) {
  return !!s && !!EMOJI_ONLY_RE && EMOJI_ONLY_RE.test(s);
}

// First whole character for an avatar chip. `charAt(0)` split astral emoji
// (the server prefixes spectator names with "👁 ") into a lone high surrogate,
// which painted as U+FFFD — take the full code point instead.
function avatarGlyph(name) {
  const s = String(name || '؟').trim();
  return (Array.from(s)[0] || '؟').toUpperCase();
}

function isMineMsg(msg) {
  return msg.pid ? msg.pid === myId : msg.from === myName;
}

function chatColor(pid) {
  const idx = view?.players ? view.players.indexOf(pid) : -1;
  if (idx >= 0) return CHAT_COLORS[idx % CHAT_COLORS.length];
  let h = 0;
  const s = String(pid ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}

function openChat() {
  // Chat only exists for a room attachment; the FAB is hidden outside one.
  if (!roomCode) return;
  chatOpen = true;
  closeVoicePanel();      // one floating panel at a time, same corner
  $('chatDrawer')?.classList.remove('hidden');
  closeEmojiPop();
  renderChatEmpty();
  unread = 0;
  updateBadge();
  scrollChatToBottom();
  setTimeout(() => $('chatInput')?.focus(), 80);
}

function closeChat() {
  chatOpen = false;
  $('chatDrawer')?.classList.add('hidden');
  closeEmojiPop();
  // A new closed period gets a fresh "رسائل جديدة" divider; the old one has
  // served its purpose once the user has seen it.
  clearChatUnreadDivider();
  chatScrolledUp = false;
  updateBadge();
}

function openEmojiPop() {
  emojiPopOpen = true;
  $('emojiPop')?.classList.remove('hidden');
  $('btnEmoji')?.setAttribute('aria-expanded', 'true');
}

function closeEmojiPop() {
  emojiPopOpen = false;
  $('emojiPop')?.classList.add('hidden');
  $('btnEmoji')?.setAttribute('aria-expanded', 'false');
}

function renderChatEmpty() {
  const box = $('chatMsgs');
  if (!box || box.children.length) return;
  const el = document.createElement('div');
  el.className = 'chat-empty';
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = '👋';
  el.appendChild(big);
  el.appendChild(document.createTextNode('قول سلام للاعبين الطاولة وابدأ الكلام…'));
  box.appendChild(el);
}

// Draw one message. `opts.historical` renders a chat:history entry without any
// live side effects (no unread bump, no divider, no auto-scroll).
function appendChatMsg(msg, opts = {}) {
  const box = chatBox();
  if (!box || !msg || typeof msg !== 'object') return;
  const historical = opts.historical === true;
  const mine = isMineMsg(msg);
  const sys = isSystemMsg(msg);
  const atNum = Number(msg.at);
  const at = Number.isFinite(atNum) ? atNum : Date.now();
  const day = chatDayKey(at);
  const who = msg.pid || ('name:' + (msg.from || ''));

  // Read the pinned state BEFORE the DOM grows.
  const pinned = isChatPinned();
  box.querySelector('.chat-empty')?.remove();

  // ── day separator: only when the calendar day (derived from msg.at) changes ──
  if (chatLastDay && day !== chatLastDay) {
    const sep = document.createElement('div');
    sep.className = 'chat-day';
    sep.textContent = chatDayLabel(at);
    box.appendChild(sep);
    chatLastWasUser = false;
    chatLastWho = '';
  }
  chatLastDay = day;

  if (sys) {
    const el = document.createElement('div');
    el.className = 'chat-sys';
    el.textContent = msg.text || '';
    box.appendChild(el);
    chatLastWasUser = false;
    chatLastWho = '';
    chatLastAt = at;
  } else {
    // 3-minute grouping compares server timestamps — never Date.now().
    const delta = at - chatLastAt;
    let grouped = chatLastWasUser && chatLastWho === who && delta >= 0 && delta < CHAT_GROUP_MS;

    // "New messages" divider goes before the first message that arrived while
    // the drawer was closed (day separator, when present, stays above it). It
    // also restarts grouping so that first unread message shows its sender.
    if (!historical && !mine && !chatOpen && !chatUnreadDividerShown) {
      const div = document.createElement('div');
      div.className = 'chat-unread';
      div.textContent = 'رسائل جديدة';
      box.appendChild(div);
      chatUnreadDividerShown = true;
      grouped = false;
    }

    const row = document.createElement('div');
    row.className = 'chat-row ' + (mine ? 'mine' : 'other') + (grouped ? ' grouped' : '');
    row.dataset.pid = msg.pid || '';
    row.dataset.who = who;
    row.dataset.at = String(at);
    if (msg.pid && voiceSpeaking.has(String(msg.pid))) row.classList.add('voice-speaking');

    const col = document.createElement('div');
    col.className = 'chat-col';

    if (!grouped) {
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      const timeStr = chatTimeLabel(at);
      if (mine) {
        meta.textContent = timeStr;
      } else {
        const rgb = chatColor(msg.pid);
        const nm = document.createElement('b');
        nm.textContent = msg.from || 'لاعب';
        nm.style.color = 'rgb(' + rgb + ')';
        meta.appendChild(nm);
        meta.appendChild(document.createTextNode(' · ' + timeStr));
      }
      col.appendChild(meta);
    }

    const bubble = document.createElement('div');
    const emojiBody = (msg.emoji && !msg.text) || isEmojiOnly(msg.text || '');
    if (emojiBody) {
      bubble.className = 'chat-bubble emoji-only';
      bubble.textContent = msg.emoji || (msg.text || '').trim();
    } else {
      bubble.className = 'chat-bubble';
      bubble.textContent = msg.text || '';
    }
    col.appendChild(bubble);

    if (!mine) {
      const rgb = chatColor(msg.pid);
      const av = document.createElement('span');
      av.className = 'chat-av';
      av.textContent = avatarGlyph(msg.from);
      av.style.setProperty('--av-bg', 'rgba(' + rgb + ',.18)');
      av.style.setProperty('--av-fg', 'rgb(' + rgb + ')');
      row.appendChild(av);
    }
    row.appendChild(col);
    box.appendChild(row);

    chatLastWasUser = true;
    chatLastWho = who;
    chatLastAt = at;
  }

  if (historical) return;

  // ── scroll + unread ──
  if (chatOpen) {
    if (pinned || (mine && !sys)) {
      scrollChatToBottom();
      if (unread) { unread = 0; updateBadge(); }
    } else {
      chatScrolledUp = true;
      unread++;
      updateBadge();
    }
  } else {
    unread++;
    updateBadge();
  }
}

function showChatToast(msg) {
  const container = $('chatToasts');
  if (!container) return;

  // Maximum 3 floating bubbles so the table never gets covered
  while (container.children.length >= 3) {
    container.firstChild.remove();
  }

  const sys = !msg.pid || msg.from === 'النظام';
  const mine = isMineMsg(msg);
  const rgb = sys ? '139,150,184' : (mine ? CHAT_COLORS[1] : chatColor(msg.pid));

  // emoji-only messages float as a single glass circle — no name, no rectangle
  if ((msg.emoji && !msg.text) || isEmojiOnly(msg.text || '')) {
    const round = document.createElement('button');
    round.type = 'button';
    round.className = 'chat-toast emoji-toast' + (mine ? ' mine' : '');
    round.dataset.pid = msg.pid || '';
    if (msg.pid && voiceSpeaking.has(String(msg.pid))) round.classList.add('voice-speaking');
    round.title = (mine ? 'أنت' : (msg.from || '')) + ' · ' + (msg.emoji || (msg.text || '').trim());
    round.addEventListener('click', openChat);
    const em = document.createElement('span');
    em.className = 'toast-emoji';
    em.textContent = msg.emoji || (msg.text || '').trim();
    round.appendChild(em);
    container.appendChild(round);
    setTimeout(() => {
      round.classList.add('toast-fade');
      setTimeout(() => round.remove(), 400);
    }, 5000);
    return;
  }

  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'chat-toast' + (mine ? ' mine' : '');
  toast.dataset.pid = msg.pid || '';
  if (msg.pid && voiceSpeaking.has(String(msg.pid))) toast.classList.add('voice-speaking');
  toast.addEventListener('click', openChat);

  const av = document.createElement('span');
  av.className = 'chat-av';
  av.style.setProperty('--av-bg', 'rgba(' + rgb + ',.18)');
  av.style.setProperty('--av-fg', 'rgb(' + rgb + ')');
  av.textContent = avatarGlyph(msg.from);
  toast.appendChild(av);

  const body = document.createElement('span');
  body.className = 'toast-body';
  const nm = document.createElement('span');
  nm.className = 'toast-name';
  nm.textContent = mine ? 'أنت' : (msg.from || 'النظام');
  if (!sys && !mine) nm.style.color = 'rgb(' + rgb + ')';
  body.appendChild(nm);

  const content = document.createElement('span');
  if ((msg.emoji && !msg.text) || isEmojiOnly(msg.text || '')) {
    content.className = 'toast-emoji';
    content.textContent = msg.emoji || (msg.text || '').trim();
  } else {
    content.className = 'toast-text';
    content.textContent = msg.text || '';
  }
  body.appendChild(content);
  toast.appendChild(body);

  container.appendChild(toast);

  // Stays floating for 5 seconds as requested!
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

// chat:history — unicast right after room:create / room:join. Rebuild the whole
// transcript in server order; ids already rendered are skipped so a live
// chat:msg that raced ahead of the replay is never drawn twice.
function onChatHistory(payload) {
  if (!payload || typeof payload !== 'object' || !roomCode) return;
  if (payload.code && payload.code !== roomCode) return;
  const list = Array.isArray(payload.messages) ? payload.messages : [];
  resetChatTranscript();
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (markChatSeen(m.mid)) continue;
    appendChatMsg(m, { historical: true });
  }
  renderChatEmpty();
  if (chatOpen) scrollChatToBottom();
  updateBadge();
}

function onChatMsg(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (!roomCode) return;                 // late event after teardown
  if (markChatSeen(msg.mid)) return;     // already painted from history
  showChatToast(msg);
  appendChatMsg(msg);
  // Their message landed — stop showing their typing pulse.
  if (msg.pid) clearChatTyping(msg.pid);
  // 1.6: timeout force-skip / auto-draw / auto-pass arrive as a system chat line
  // plus a raw state change. These are the exact moments a player most needs an
  // explanation, so they also get a held banner instead of a silent jump.
  if (isSystemMsg(msg) && /^⏰/.test(msg.text || '')) {
    const mine = msg.text.includes(myName || '\u0000');
    setBannerHold(mine ? `⏰ ${msg.text} — اتقضى وقتك` : msg.text, '', 4200);
  }
  if (msg.pid && msg.pid !== myId) sfx.chatPop();
}

function updateBadge() {
  // FAB badge = unread while the drawer is closed. While it is open the
  // in-transcript scroll pill carries the same count instead.
  const badge = $('chatBadge');
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', !unread || chatOpen);
  }
  const pill = $('chatScrollPill');
  if (pill) {
    const show = chatOpen && unread > 0 && chatScrolledUp;
    pill.classList.toggle('hidden', !show);
    const count = $('chatScrollPillCount');
    if (count) count.textContent = unread > 9 ? '9+' : String(unread);
  }
}

// ══════════ effects ══════════
// A transient, screen-centred notice (connection state, share confirmation).
// Distinct from floatText (score pops on the board) and from chat toasts.
let toastTimer = null;
function toast(txt, ms = 2200) {
  const layer = $('toastLayer');
  if (!layer) return;
  layer.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = txt;
  layer.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

function floatText(txt, isEmoji = false) {
  const layer = $('floatLayer');
  const el = document.createElement('div');
  el.className = 'float' + (isEmoji ? '' : ' score');
  el.textContent = txt;
  el.style.left = 42 + Math.random() * 16 + '%';
  el.style.top = 38 + Math.random() * 10 + '%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

let confettiRAF = null;
function startConfetti() {
  if (prefersReducedMotion()) return;   // F4.4/K3.C10: no confetti under reduced motion
  const c = $('confetti');
  const ctx = c.getContext('2d');
  c.width = c.clientWidth || 400;
  c.height = c.clientHeight || 300;
  const parts = Array.from({ length: 90 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height,
    vy: 1.5 + Math.random() * 2.5, vx: (Math.random() - .5) * 1.4,
    s: 4 + Math.random() * 5, r: Math.random() * Math.PI,
    c: `hsl(${Math.random() * 360},85%,60%)`,
  }));
  cancelAnimationFrame(confettiRAF);
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.y += p.vy; p.x += p.vx; p.r += 0.06;
      if (p.y > c.height + 20) { p.y = -20; p.x = Math.random() * c.width; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6);
      ctx.restore();
    }
    confettiRAF = requestAnimationFrame(tick);
  })();
}
function stopConfetti() { cancelAnimationFrame(confettiRAF); }

// ══════════ helpers ══════════
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// render an invite-link QR onto a canvas (global qrcode lib, vendored)
function renderQr(text, canvas) {
  if (!canvas || typeof qrcode !== 'function' || !text) return;
  try {
    const qr = qrcode(0, 'M');   // typeNumber 0 = auto size
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(canvas.width / (n + 4)));
    const side = (n + 4) * cell;
    canvas.width = canvas.height = side;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, side, side);
    g.fillStyle = '#0b1120';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) g.fillRect((c + 2) * cell, (r + 2) * cell, cell, cell);
      }
    }
  } catch (e) { /* oversized payload etc. — leave the canvas empty */ }
}
function copyText(text, toast) {
  const showToast = () => {
    const el = document.createElement('div');
    el.textContent = '📋 ' + toast;
    el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent-2);color:var(--text);padding:10px 22px;border-radius:999px;z-index:999;font-size:14px;backdrop-filter:blur(10px)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showToast).catch(() => fallbackCopy(text, showToast));
  } else {
    fallbackCopy(text, showToast);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); cb(); } catch (e) {}
  document.body.removeChild(ta);
}
function emit(event, payload) {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

// ══════════ voice UI ══════════
// Thin, defensive presentation layer over js/voice.js. The engine owns capture,
// signaling and the Arabic failure strings. Everything here is idempotent
// rendering; no hook, click or teardown path may throw into a socket callback
// or abort boot, and nothing calls getUserMedia until the user taps the mic.
const VOICE_AR = Object.freeze({
  noEngine: 'الصوت مش متاح دلوقتي.',
  unsupported: 'الصوت مش مدعوم في المتصفح ده.',
  insecure: 'الصوت محتاج اتصال آمن (HTTPS).',
  noRoom: 'ادخل غرفة الأول عشان تشغّل الصوت.',
  requesting: 'بنطلب إذن الميكروفون…',
  connecting: 'بنتوصل باللاعبين…',
  live: 'صوتك شغال — الكل بيسمعك.',
  muted: 'أنت مكتوم — المايك مقفول.',
  hostMuted: 'المضيف كتم صوتك.',
  pttIdle: 'اضغط مطولاً على المايك أو على V عشان تتكلم.',
  pttLive: 'بتتكلم دلوقتي — سيب الزرار عشان تقفل.',
  idle: 'الصوت مقفول — اضغط المايك عشان تدخل.',
  failed: 'الصوت اتوقف — جرّب تاني.',
  autoplay: 'المتصفح قافل صوت اللاعبين — دوس ▶ عشان تسمعهم.',
  spectator: 'المتفرجين ميعرفوش يشاركوا في الصوت.',
  pttLocked: 'اقفل وضع PTT الأول عشان تستخدم الكتم.',
});

const VOICE_SPEAKER_SVG = '<svg class="voice-spk-on" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>'
  + '<svg class="voice-spk-off" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';

function voiceGuard(fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    console.warn('[voice] ui hook failed:', err?.message || err);
  }
}

function ensureVoice() {
  if (voiceEngine) return voiceEngine;
  if (voiceInitFailed || !socket) return null;
  try {
    voiceEngine = new VoiceChat(socket, {
      onSelf: (snapshot) => voiceGuard(() => onVoiceSelf(snapshot)),
      onPeers: (list) => voiceGuard(() => onVoicePeers(list)),
      onSpeaking: (pid, on) => voiceGuard(() => onVoiceSpeaking(pid, on)),
      onError: (message) => voiceGuard(() => onVoiceError(message)),
      onInfo: (message) => voiceGuard(() => onVoiceInfo(message)),
    });
    try { voiceEngine.setPushToTalk(voicePttPref); } catch { /* local pref only */ }
    return voiceEngine;
  } catch (err) {
    voiceInitFailed = true;
    console.warn('[voice] engine unavailable:', err?.message || err);
    return null;
  }
}

function voiceBlockedReason() {
  if (!voiceEngine || voiceInitFailed) return VOICE_AR.noEngine;
  try {
    if (!voiceEngine.supported) return VOICE_AR.unsupported;
    if (!voiceEngine.secure) return VOICE_AR.insecure;
  } catch {
    return VOICE_AR.noEngine;
  }
  return '';
}

function voiceStatusInfo() {
  if (spectating) return { text: VOICE_AR.spectator, tone: 'danger' };
  if (!roomCode) return { text: VOICE_AR.noRoom, tone: '' };
  const blocked = voiceBlockedReason();
  if (blocked) return { text: blocked, tone: 'danger' };
  if (voiceSelf.status === 'requesting') return { text: VOICE_AR.requesting, tone: 'busy' };
  if (voiceSelf.status === 'connecting') return { text: VOICE_AR.connecting, tone: 'busy' };
  if (voiceSelf.status === 'failed') return { text: voiceSelf.error || VOICE_AR.failed, tone: 'danger' };
  if (voiceSelf.hostMuted) return { text: VOICE_AR.hostMuted, tone: 'danger' };
  if (voiceSelf.joined) {
    if (voicePeerList.some(p => p.playBlocked)) return { text: VOICE_AR.autoplay, tone: 'warn' };
    if (voicePttPref) {
      if (voiceSelf.speaking) return { text: VOICE_AR.pttLive, tone: 'live' };
      if (voicePttDown) return { text: 'المايك مفتوح — اتكلم.', tone: 'live' };
      return { text: VOICE_AR.pttIdle, tone: '' };
    }
    if (voiceSelf.muted) return { text: VOICE_AR.muted, tone: 'warn' };
    return { text: VOICE_AR.live, tone: 'live' };
  }
  return { text: VOICE_AR.idle, tone: '' };
}

function voiceSetText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function voiceBadge(text, tone) {
  const el = document.createElement('span');
  el.className = 'voice-badge' + (tone ? ' ' + tone : '');
  el.textContent = text;
  return el;
}

function renderVoiceBadges(container, items) {
  if (!container) return;
  container.innerHTML = '';
  for (const [text, tone] of items) container.appendChild(voiceBadge(text, tone));
}

function voiceNameFallback(pid) {
  const peer = voicePeerList.find(p => String(p.id) === String(pid));
  if (peer && peer.name) return peer.name;
  const fromView = view?.names?.[pid];
  if (fromView) return fromView;
  const fromLobby = lastLobbyState?.players?.find(p => String(p.id) === String(pid));
  if (fromLobby && fromLobby.name) return fromLobby.name;
  return 'لاعب';
}

function voiceSelfKey() {
  return myId === null || myId === undefined ? '' : String(myId);
}

function onVoiceSelf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const wasLive = voiceLiveSeen;
  voiceSelf = {
    joined: snapshot.joined === true,
    muted: snapshot.muted === true,
    hostMuted: snapshot.hostMuted === true,
    speaking: snapshot.speaking === true,
    status: typeof snapshot.status === 'string' ? snapshot.status : 'idle',
    error: typeof snapshot.error === 'string' ? snapshot.error : null,
  };
  voiceLiveSeen = voiceSelf.joined && voiceSelf.status === 'live';
  if (voiceLiveSeen && !wasLive) refreshVoiceDevices();
  const selfKey = voiceSelfKey();
  if (selfKey && voiceSelf.speaking) voiceSpeaking.add(selfKey);
  else if (selfKey) voiceSpeaking.delete(selfKey);
  renderVoiceUI();
}

function onVoicePeers(list) {
  voicePeerList = Array.isArray(list)
    ? list.filter(p => p && typeof p === 'object' && p.id !== null && p.id !== undefined)
    : [];
  const ids = new Set(voicePeerList.map(p => String(p.id)));
  for (const peer of voicePeerList) {
    const pid = String(peer.id);
    if (peer.speaking) voiceSpeaking.add(pid);
    else voiceSpeaking.delete(pid);
  }
  const selfKey = voiceSelfKey();
  for (const pid of Array.from(voiceSpeaking)) {
    if (pid === selfKey) continue;
    if (!ids.has(pid)) voiceSpeaking.delete(pid);
  }
  applyVoiceSpeakingToDom();
  renderVoiceUI();
}

function onVoiceSpeaking(pid, on) {
  const id = pid === null || pid === undefined ? '' : String(pid);
  if (!id) return;
  if (on) voiceSpeaking.add(id);
  else voiceSpeaking.delete(id);
  applyVoiceSpeakingToDom();
  renderVoiceUI();
}

function onVoiceError(message) {
  if (typeof message !== 'string' || !message.trim()) return;
  toast('🎙 ' + message.trim());
  renderVoiceUI();
}

function onVoiceInfo(message) {
  if (typeof message !== 'string' || !message.trim()) return;
  toast('🎙 ' + message.trim());
  renderVoiceUI();
}

// Paint (or clear) the speaking ring on opponent cards, lobby rows, chat rows,
// avatars and toasts. Elements are matched by dataset.pid, so a missing row is
// simply skipped — chat that has scrolled out of the DOM cannot break this.
function applyVoiceSpeakingToDom() {
  try {
    document.querySelectorAll('.voice-speaking').forEach(el => el.classList.remove('voice-speaking'));
    const mark = (selector) => {
      document.querySelectorAll(selector).forEach(el => {
        const pid = el.dataset ? el.dataset.pid : '';
        if (pid && voiceSpeaking.has(String(pid))) el.classList.add('voice-speaking');
      });
    };
    mark('#opponents .opp-card');
    mark('#chatMsgs .chat-row');
    mark('#chatToasts .chat-toast');
    mark('#lobbyPlayers li');
    mark('#voicePeers .voice-peer-row');
    const selfKey = voiceSelfKey();
    if (selfKey && voiceSpeaking.has(selfKey)) $('voiceSelf')?.classList.add('voice-speaking');
    if (voiceSelf.speaking) $('voiceSelf')?.classList.add('voice-speaking');
  } catch (err) {
    console.warn('[voice] speaking paint failed:', err?.message || err);
  }
}

function createVoicePeerRow(pid) {
  const row = document.createElement('div');
  row.className = 'voice-peer-row';
  row.dataset.pid = pid;

  const avatar = document.createElement('span');
  avatar.className = 'voice-avatar';
  avatar.setAttribute('aria-hidden', 'true');

  const who = document.createElement('div');
  who.className = 'voice-who';
  const nameLine = document.createElement('span');
  nameLine.className = 'voice-name-line';
  const conn = document.createElement('span');
  conn.className = 'voice-conn';
  conn.dataset.conn = 'new';
  const name = document.createElement('span');
  name.className = 'voice-name';
  nameLine.appendChild(conn);
  nameLine.appendChild(name);
  const badges = document.createElement('span');
  badges.className = 'voice-badges';
  who.appendChild(nameLine);
  who.appendChild(badges);

  const volWrap = document.createElement('label');
  volWrap.className = 'voice-vol';
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = '0';
  vol.max = '100';
  vol.step = '5';
  vol.value = '100';
  vol.className = 'voice-vol-range';
  vol.dir = 'ltr';
  vol.setAttribute('aria-label', 'مستوى صوت اللاعب');
  volWrap.appendChild(vol);

  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'voice-peer-mute';
  mute.setAttribute('aria-pressed', 'false');
  mute.innerHTML = VOICE_SPEAKER_SVG;

  row.appendChild(avatar);
  row.appendChild(who);
  row.appendChild(volWrap);
  row.appendChild(mute);

  vol.addEventListener('input', () => {
    try {
      const engine = ensureVoice();
      if (engine) engine.setPeerVolume(pid, Number(vol.value) / 100);
    } catch (err) {
      console.warn('[voice] peer volume failed:', err?.message || err);
    }
  });
  mute.addEventListener('click', () => {
    try {
      const engine = ensureVoice();
      if (!engine) return;
      engine.setPeerMuted(pid, !mute.classList.contains('on'));
      sfx.click();
    } catch (err) {
      console.warn('[voice] peer mute failed:', err?.message || err);
    }
  });

  return { row, avatar, conn, name, badges, vol, mute };
}

function renderVoicePeers() {
  const wrap = $('voicePeers');
  if (!wrap) return;
  const ids = new Set();
  for (const peer of voicePeerList) {
    const pid = String(peer.id);
    ids.add(pid);
    let entry = voicePeerRows.get(pid);
    if (!entry) {
      entry = createVoicePeerRow(pid);
      voicePeerRows.set(pid, entry);
      wrap.appendChild(entry.row);
    }
    const name = typeof peer.name === 'string' && peer.name.trim()
      ? peer.name.trim()
      : voiceNameFallback(pid);
    entry.name.textContent = name;
    entry.avatar.textContent = name.trim().charAt(0).toUpperCase() || '؟';

    const items = [];
    if (peer.hostMuted) items.push(['المضيف كتمه', 'danger']);
    else if (peer.muted) items.push(['مكتوم', 'muted']);
    if (peer.localMuted) items.push(['مكتوم عندك', 'local']);
    renderVoiceBadges(entry.badges, items);

    const conn = peer.connection === 'connected' || peer.connection === 'connecting' || peer.connection === 'failed'
      ? peer.connection
      : 'new';
    entry.conn.dataset.conn = conn;
    entry.conn.title = conn === 'connected' ? 'متصل'
      : conn === 'connecting' ? 'بيتصل…'
        : conn === 'failed' ? 'تعذر الاتصال'
          : 'لسه بيبدأ';

    const localMuted = peer.localMuted === true;
    entry.mute.classList.toggle('on', localMuted);
    entry.mute.setAttribute('aria-pressed', String(localMuted));
    entry.mute.title = localMuted ? `تشغيل صوت ${name}` : `كتم صوت ${name} عندك`;
    entry.mute.setAttribute('aria-label', entry.mute.title);

    const volume = Number.isFinite(Number(peer.volume)) ? Math.min(1, Math.max(0, Number(peer.volume))) : 1;
    const pct = Math.round(volume * 100);
    if (document.activeElement !== entry.vol) entry.vol.value = String(pct);
    entry.vol.title = `مستوى صوت ${name}: ${pct}%`;
    entry.vol.setAttribute('aria-label', `مستوى صوت ${name}`);
  }
  for (const [pid, entry] of Array.from(voicePeerRows)) {
    if (!ids.has(pid)) {
      entry.row.remove();
      voicePeerRows.delete(pid);
    }
  }
  const orderKey = voicePeerList.map(p => String(p.id)).join('|');
  if (orderKey !== voicePeerOrderKey) {
    voicePeerOrderKey = orderKey;
    for (const peer of voicePeerList) {
      const entry = voicePeerRows.get(String(peer.id));
      if (entry) wrap.appendChild(entry.row);
    }
  }
}

function renderVoiceDevices() {
  const row = $('voiceDeviceRow');
  const select = $('voiceDevice');
  if (!row || !select) return;
  const show = voiceSelf.joined && voiceDevices.length > 0;
  row.classList.toggle('hidden', !show);
  if (!show) return;
  const key = voiceDevices.map(d => d.deviceId).join('|');
  if (key !== voiceDeviceKey) {
    voiceDeviceKey = key;
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = 'default';
    def.textContent = 'الميكروفون الافتراضي';
    select.appendChild(def);
    for (const device of voiceDevices) {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || 'ميكروفون';
      select.appendChild(opt);
    }
  }
  if (document.activeElement !== select) {
    const has = Array.from(select.options).some(o => o.value === voiceSelectedDevice);
    select.value = has ? voiceSelectedDevice : 'default';
  }
}

async function refreshVoiceDevices() {
  if (voiceDeviceBusy) return;
  const engine = ensureVoice();
  if (!engine) return;
  voiceDeviceBusy = true;
  try {
    const list = await engine.listInputDevices();
    voiceDevices = Array.isArray(list) ? list : [];
    renderVoiceDevices();
  } catch (err) {
    console.warn('[voice] device list failed:', err?.message || err);
  } finally {
    voiceDeviceBusy = false;
  }
}

function renderVoiceStrip() {
  const strip = $('voiceStrip');
  if (!strip) return;
  const show = !!roomCode && !spectating;
  strip.classList.toggle('hidden', !show);
  if (!show) return;
  const busy = voiceSelf.status === 'requesting' || voiceSelf.status === 'connecting';
  let text;
  if (busy) {
    text = voiceSelf.status === 'requesting' ? VOICE_AR.requesting : VOICE_AR.connecting;
  } else if (voiceSelf.status === 'failed' && !voiceSelf.joined) {
    text = voiceSelf.error || VOICE_AR.failed;
  } else {
    const names = [];
    if (voiceSelf.joined) names.push('أنت');
    for (const peer of voicePeerList) names.push(peer.name || voiceNameFallback(peer.id));
    if (names.length > 1) text = '🎙 في الصوت: ' + names.join('، ');
    else if (names.length === 1) text = '🎙 أنت في الصوت لوحدك — استنى حد يدخل';
    else text = 'اتكلم مع اللاعبين بالصوت';
  }
  const reason = voiceBlockedReason();
  if (reason) text = reason;   // unsupported / insecure is visible, not just a tooltip
  voiceSetText('voiceStripText', text);

  const btn = $('voiceStripBtn');
  if (!btn) return;
  btn.disabled = !!(reason || busy);
  btn.classList.toggle('on', voiceSelf.joined && !voiceSelf.muted && !voiceSelf.hostMuted && !voicePttPref);
  if (voiceSelf.hostMuted) btn.textContent = 'المضيف كتمك';
  else if (voiceSelf.joined && voicePttPref) btn.textContent = 'إعدادات الصوت';
  else if (voiceSelf.joined) btn.textContent = voiceSelf.muted ? 'شغّل المايك' : 'اكتم';
  else btn.textContent = 'ادخل الصوت';
  btn.title = reason || (voiceSelf.joined
    ? (voicePttPref ? 'افتح لوحة الصوت' : 'كتم/تشغيل المايك')
    : 'ادخل قناة الصوت');
}

// Rendering is called from lobby/game paint paths, so a stray DOM assumption
// must never escape into the main UI. The wrapper is the only entry point.
function renderVoiceUI() {
  try {
    renderVoiceUIInner();
  } catch (err) {
    console.warn('[voice] render failed:', err?.message || err);
  }
}

function renderVoiceUIInner() {
  const blocked = !roomCode || spectating;
  const reason = voiceBlockedReason();
  const busy = voiceSelf.status === 'requesting' || voiceSelf.status === 'connecting';
  const available = !reason;
  const micOpen = voiceSelf.joined && !voiceSelf.hostMuted
    && (voicePttPref ? (voicePttDown || voiceSelf.speaking) : !voiceSelf.muted);
  const peerCount = voicePeerList.length;

  const fab = $('voiceFab');
  if (fab) {
    fab.classList.toggle('hidden', blocked);
    fab.classList.toggle('is-live', voiceSelf.joined);
    fab.classList.toggle('is-muted', voiceSelf.joined && !micOpen);
    fab.classList.toggle('is-speaking', voiceSelf.joined && voiceSelf.speaking);
    fab.classList.toggle('is-busy', busy);
    fab.classList.toggle('is-failed', voiceSelf.status === 'failed');
    fab.dataset.state = voiceSelf.status;
    fab.disabled = blocked || busy || !available;
    fab.setAttribute('aria-pressed', String(micOpen));
    let title = 'ادخل الصوت';
    if (!available) title = reason;
    else if (busy) title = voiceSelf.status === 'requesting' ? VOICE_AR.requesting : VOICE_AR.connecting;
    else if (voiceSelf.joined) {
      title = voiceSelf.hostMuted ? VOICE_AR.hostMuted
        : voicePttPref ? 'اضغط مطولاً على المايك أو على V عشان تتكلم'
          : voiceSelf.muted ? 'شغّل المايك' : 'اكتم المايك';
    }
    fab.title = title;
    fab.setAttribute('aria-label', title);
  }
  const fabBadge = $('voiceFabBadge');
  if (fabBadge) {
    fabBadge.textContent = peerCount > 9 ? '9+' : String(peerCount);
    fabBadge.classList.toggle('hidden', !voiceSelf.joined || peerCount === 0);
  }

  const panelBtn = $('voicePanelBtn');
  if (panelBtn) {
    panelBtn.classList.toggle('hidden', blocked);
    panelBtn.setAttribute('aria-expanded', String(voicePanelOpen));
    panelBtn.classList.toggle('open', voicePanelOpen);
  }
  const panel = $('voicePanel');
  if (panel) {
    if (blocked) {
      panel.classList.add('hidden');
      voicePanelOpen = false;
    }
    panel.setAttribute('aria-hidden', String(!voicePanelOpen));
  }

  const info = voiceStatusInfo();
  const statusEl = $('voiceStatus');
  if (statusEl) {
    statusEl.textContent = info.text;
    statusEl.className = 'voice-status' + (info.tone ? ' ' + info.tone : '');
  }
  const inVoiceCount = (voiceSelf.joined ? 1 : 0) + peerCount;
  voiceSetText('voiceCount', inVoiceCount ? `${inVoiceCount} في الصوت` : 'مفيش حد في الصوت');

  const autoplayBtn = $('voiceAutoplay');
  if (autoplayBtn) {
    const blockedPlayback = voiceSelf.joined && voicePeerList.some(p => p.playBlocked);
    autoplayBtn.classList.toggle('hidden', !blockedPlayback);
  }

  const selfRow = $('voiceSelf');
  if (selfRow) {
    selfRow.classList.toggle('is-idle', !voiceSelf.joined);
    selfRow.classList.toggle('is-host-muted', voiceSelf.hostMuted);
    voiceSetText('voiceSelfName', myName ? `أنت (${myName})` : 'أنت');
    const selfAvatar = $('voiceSelfAvatar');
    if (selfAvatar) selfAvatar.textContent = (myName || 'أ').trim().charAt(0).toUpperCase() || 'أ';
    const selfBadges = [];
    if (!voiceSelf.joined) {
      selfBadges.push([voiceSelf.status === 'failed' ? 'اتوقف' : 'برّه الصوت', voiceSelf.status === 'failed' ? 'danger' : '']);
    } else if (voiceSelf.hostMuted) {
      selfBadges.push(['المضيف كتمك', 'danger']);
    } else if (voicePttPref) {
      const open = voiceSelf.speaking || voicePttDown;
      selfBadges.push([open ? 'بتتكلم' : 'PTT', open ? 'live' : '']);
    } else if (voiceSelf.muted) {
      selfBadges.push(['مكتوم', 'muted']);
    } else {
      selfBadges.push(['مايك مفتوح', 'live']);
    }
    renderVoiceBadges($('voiceSelfBadges'), selfBadges);
  }

  const joinBtn = $('voicePanelJoin');
  if (joinBtn) {
    const canJoin = !blocked && !voiceSelf.joined && !busy;
    joinBtn.classList.toggle('hidden', !canJoin);
    joinBtn.disabled = !available;
  }

  const muteBtn = $('voiceMuteSelf');
  if (muteBtn) {
    muteBtn.disabled = !voiceSelf.joined || voiceSelf.hostMuted || voicePttPref;
    muteBtn.title = voicePttPref && voiceSelf.joined ? VOICE_AR.pttLocked : '';
    muteBtn.textContent = voiceSelf.hostMuted ? 'مكتوم بواسطة المضيف'
      : voiceSelf.muted ? 'شغّل المايك' : 'كتم نفسي';
  }

  const leaveBtn = $('voiceLeave');
  if (leaveBtn) leaveBtn.disabled = !(voiceSelf.joined || busy);

  const pttBtn = $('voicePtt');
  if (pttBtn) {
    pttBtn.classList.toggle('on', voicePttPref);
    pttBtn.setAttribute('aria-checked', String(voicePttPref));
    pttBtn.disabled = !voiceEngine;
  }

  const modAll = $('voiceModAll');
  if (modAll) {
    const visible = isHost && voiceSelf.joined && !!roomCode && !spectating;
    modAll.classList.toggle('hidden', !visible);
    const allMuted = peerCount > 0 && voicePeerList.every(p => p.hostMuted);
    modAll.textContent = allMuted ? 'فك كتم الكل' : 'كتم الكل';
    modAll.disabled = peerCount === 0;
  }

  const empty = $('voiceEmpty');
  if (empty) {
    empty.classList.toggle('hidden', !voiceSelf.joined || peerCount > 0);
    empty.textContent = voiceSelf.joined ? 'مفيش حد تاني في الصوت لسه.' : 'ادخل الصوت عشان تشوف اللاعبين.';
  }

  renderVoicePeers();
  renderVoiceDevices();
  renderVoiceStrip();
  applyVoiceSpeakingToDom();
}

function syncVoiceForRoom() {
  const engine = ensureVoice();
  if (engine) {
    const unseated = spectating || !myId || String(myId).startsWith('spectator:');
    try {
      if (unseated || !roomCode) {
        engine.setSelf(null, '');
        engine.leave();
      } else {
        engine.setSelf(myId, myName || '');
      }
    } catch (err) {
      console.warn('[voice] self sync failed:', err?.message || err);
    }
  }
  renderVoiceUI();
}

function syncVoiceVisibility() {
  renderVoiceUI();
}

// Room leave/teardown: stop capture + signaling and clear the presentation.
function stopVoiceForLeave() {
  try {
    if (voiceEngine) voiceEngine.leave();
  } catch (err) {
    console.warn('[voice] leave failed:', err?.message || err);
  }
  voiceSelf = { ...VOICE_IDLE };
  voicePeerList = [];
  voiceSpeaking.clear();
  voicePeerRows.clear();
  voicePeerOrderKey = '';
  voiceLiveSeen = false;
  voiceFabHeld = false;
  voicePttDown = false;
  const wrap = $('voicePeers');
  if (wrap) wrap.innerHTML = '';
  renderVoiceUI();
}

// The room is gone: release the engine itself. A later join builds a fresh one.
function disposeVoice() {
  try {
    if (voiceEngine) voiceEngine.dispose();
  } catch (err) {
    console.warn('[voice] dispose failed:', err?.message || err);
  }
  voiceEngine = null;
  voiceInitFailed = false;
  voiceSelf = { ...VOICE_IDLE };
  voicePeerList = [];
  voiceSpeaking.clear();
  voicePeerRows.clear();
  voicePeerOrderKey = '';
  voiceDevices = [];
  voiceDeviceKey = '';
  voiceLiveSeen = false;
  voicePanelOpen = false;
  voiceFabHeld = false;
  voicePttDown = false;
  const wrap = $('voicePeers');
  if (wrap) wrap.innerHTML = '';
  $('voicePanel')?.classList.add('hidden');
  renderVoiceUI();
}

function voiceJoin() {
  if (spectating || !roomCode) return;
  const engine = ensureVoice();
  if (!engine) {
    toast('🎙 ' + VOICE_AR.noEngine);
    renderVoiceUI();
    return;
  }
  const reason = voiceBlockedReason();
  if (reason) {
    toast('🎙 ' + reason);
    renderVoiceUI();
    return;
  }
  if (engine.joined || voiceSelf.status === 'requesting' || voiceSelf.status === 'connecting') return;
  sfx.click();
  try {
    Promise.resolve(engine.join()).catch(() => {});
  } catch (err) {
    console.warn('[voice] join failed:', err?.message || err);
    toast('🎙 ' + VOICE_AR.failed);
  }
}

function voiceToggle() {
  if (spectating || !roomCode) return;
  const engine = ensureVoice();
  if (!engine) {
    toast('🎙 ' + VOICE_AR.noEngine);
    renderVoiceUI();
    return;
  }
  const reason = voiceBlockedReason();
  if (reason) {
    toast('🎙 ' + reason);
    renderVoiceUI();
    return;
  }
  if (voiceSelf.status === 'requesting' || voiceSelf.status === 'connecting') return;
  if (engine.joined) {
    // Under PTT the press-and-hold (FAB / V) is the mic control; the strip and
    // any programmatic toggle route here to the panel instead of a mute that
    // the engine would correctly ignore.
    if (voicePttPref) {
      openVoicePanel();
      return;
    }
    try { engine.toggleMute(); } catch (err) { console.warn('[voice] mute failed:', err?.message || err); }
    sfx.click();
    return;
  }
  voiceJoin();
}

function voiceToggleSelfMute() {
  const engine = ensureVoice();
  if (!engine || !engine.joined) return;
  if (voicePttPref) {
    toast('🎙 ' + VOICE_AR.pttLocked);
    return;
  }
  try { engine.setMuted(!voiceSelf.muted); } catch (err) { console.warn('[voice] mute failed:', err?.message || err); }
  sfx.click();
}

function voiceSetTalking(on) {
  voicePttDown = on === true;
  const engine = voiceEngine;
  if (!engine || !engine.joined || !voicePttPref) return;
  try { engine.setTalking(on === true); } catch (err) { console.warn('[voice] talk failed:', err?.message || err); }
  renderVoiceUI();
}

function voiceLeaveNow() {
  stopVoiceForLeave();
  closeVoicePanel();
  sfx.click();
}

function voiceTogglePtt() {
  voicePttPref = !voicePttPref;
  voicePttDown = false;
  try { localStorage.setItem('domino_voice_ptt', voicePttPref ? '1' : '0'); } catch { /* no storage */ }
  try { voiceEngine?.setPushToTalk(voicePttPref); } catch (err) { console.warn('[voice] ptt failed:', err?.message || err); }
  if (!voicePttPref) {
    try { voiceEngine?.setTalking(false); } catch { /* engine guards */ }
  }
  sfx.click();
  renderVoiceUI();
}

async function voiceHostMuteAll() {
  const engine = ensureVoice();
  if (!engine || !engine.joined || !isHost) return;
  // Any unmuted participant means the action mutes everyone; otherwise unmute.
  const muted = voicePeerList.some(p => !p.hostMuted);
  try {
    const ok = await engine.hostMute({ all: true, muted });
    if (ok) sfx.click();
  } catch (err) {
    console.warn('[voice] host mute failed:', err?.message || err);
  }
  renderVoiceUI();
}

function voiceResumePlayback() {
  try { voiceEngine?.resumeAudio(); } catch (err) { console.warn('[voice] resume failed:', err?.message || err); }
  sfx.click();
  setTimeout(() => voiceGuard(() => renderVoiceUI()), 350);
}

function voiceDeviceChanged() {
  const select = $('voiceDevice');
  if (!select) return;
  voiceSelectedDevice = select.value || 'default';
  const engine = ensureVoice();
  if (!engine) return;
  const target = voiceSelectedDevice === 'default' ? null : voiceSelectedDevice;
  try {
    Promise.resolve(engine.setInputDevice(target)).catch(() => {});
  } catch (err) {
    console.warn('[voice] input device failed:', err?.message || err);
  }
  sfx.click();
}

function openVoicePanel() {
  if (!roomCode || spectating) return;
  voicePanelOpen = true;
  closeChat();
  closeEmojiPop();
  $('voicePanel')?.classList.remove('hidden');
  $('voicePanelBtn')?.classList.add('open');
  $('voicePanelBtn')?.setAttribute('aria-expanded', 'true');
  refreshVoiceDevices();
  renderVoiceUI();
  sfx.click();
}

function closeVoicePanel() {
  voicePanelOpen = false;
  $('voicePanel')?.classList.add('hidden');
  $('voicePanelBtn')?.classList.remove('open');
  $('voicePanelBtn')?.setAttribute('aria-expanded', 'false');
}

function startVoiceFabHold(e) {
  if (e.button !== undefined && e.button !== 0) return;
  if (!voicePttPref || !voiceEngine || !voiceEngine.joined) return;
  voiceFabHeld = true;
  voiceHeldAt = Date.now();
  try { $('voiceFab')?.setPointerCapture?.(e.pointerId); } catch { /* older engines */ }
  voiceSetTalking(true);
}

function stopVoiceFabHold() {
  if (!voiceFabHeld) return;
  voiceFabHeld = false;
  voiceHeldAt = Date.now();
  voiceSetTalking(false);
}

function voicePttKeyDown(e) {
  if (e.key !== 'v' && e.key !== 'V') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable)) return;
  if (!voicePttPref || !voiceEngine || !voiceEngine.joined) return;
  if (e.repeat) return;
  try { e.preventDefault(); } catch { /* passive listener */ }
  voiceSetTalking(true);
}

function voicePttKeyUp(e) {
  if (e.key !== 'v' && e.key !== 'V') return;
  voiceSetTalking(false);
}

function initVoiceUI() {
  const fab = $('voiceFab');
  if (fab) {
    fab.addEventListener('pointerdown', startVoiceFabHold);
    fab.addEventListener('pointerup', stopVoiceFabHold);
    fab.addEventListener('pointercancel', stopVoiceFabHold);
    fab.addEventListener('click', () => {
      // Under PTT the press itself is the action; a click must not toggle mute.
      if (voicePttPref && voiceEngine?.joined) return;
      if (Date.now() - voiceHeldAt < 400) return;
      voiceToggle();
    });
  }
  bindEl('voicePanelBtn', 'click', () => {
    if (voicePanelOpen) {
      closeVoicePanel();
      sfx.click();
    } else {
      openVoicePanel();
    }
  });
  bindEl('voicePanelClose', 'click', () => { closeVoicePanel(); sfx.click(); });
  bindEl('voicePanelJoin', 'click', voiceJoin);
  bindEl('voiceMuteSelf', 'click', voiceToggleSelfMute);
  bindEl('voiceLeave', 'click', voiceLeaveNow);
  bindEl('voicePtt', 'click', voiceTogglePtt);
  bindEl('voiceModAll', 'click', () => { voiceGuard(() => voiceHostMuteAll()); });
  bindEl('voiceAutoplay', 'click', voiceResumePlayback);
  bindEl('voiceStripBtn', 'click', voiceToggle);
  bindEl('voiceDevice', 'change', voiceDeviceChanged);

  // A release outside the FAB must close the PTT gate.
  window.addEventListener('pointerup', stopVoiceFabHold);
  window.addEventListener('pointercancel', stopVoiceFabHold);

  document.addEventListener('click', (e) => {
    if (!voicePanelOpen) return;
    const panel = $('voicePanel');
    const btn = $('voicePanelBtn');
    const fabEl = $('voiceFab');
    const strip = $('voiceStrip');
    // The lobby strip both joins and (under PTT) opens this panel; its click
    // must not immediately close the panel it just opened.
    const inside = (panel && panel.contains(e.target))
      || (btn && btn.contains(e.target))
      || (fabEl && fabEl.contains(e.target))
      || (strip && strip.contains(e.target));
    if (!inside) closeVoicePanel();
  });
  document.addEventListener('keydown', voicePttKeyDown);
  document.addEventListener('keyup', voicePttKeyUp);

  // Losing focus mid-hold must close the PTT gate locally too (the engine
  // already silences the track; this keeps the UI badge honest).
  const releasePtt = () => {
    voiceFabHeld = false;
    voicePttDown = false;
    if (voicePttPref && voiceEngine?.joined) {
      try { voiceEngine.setTalking(false); } catch { /* engine guards */ }
    }
    renderVoiceUI();
  };
  window.addEventListener('blur', releasePtt);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releasePtt(); });

  try {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (voiceSelf.joined) refreshVoiceDevices();
    });
  } catch { /* devicechange is optional */ }

  renderVoiceUI();
}

// ══════════ boot ══════════
// Same-origin connection (browser / Render / Cloudflare Tunnel).

function startSocket(base) {
  socket = io(base || undefined, { transports: ['websocket', 'polling'] });
  // The engine binds its own socket listeners; create it once the socket
  // exists but keep everything non-fatal so a voice failure can never abort
  // boot. It does no media work until the user taps the mic.
  ensureVoice();

  let everConnected = false;
  socket.on('connect', () => {
    setConn(true);
    // 1.9: a reconnect deserves a visible "we're back" beat — but only after a
    // real drop, never on the very first connect.
    if (everConnected) toast('✅ رجعنا — الاتصال رجع تاني');
    everConnected = true;
    // auto-rejoin after a dropped connection or page refresh
    const urlCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
    const targetCode = roomCode || urlCode || localStorage.getItem('domino_last_code');
    const token = targetCode ? (sessionStorage.getItem('domino_token_' + targetCode) || localStorage.getItem('domino_token_' + targetCode)) : null;
    const name = localStorage.getItem('domino_name');
    if (targetCode && token && name) {
      emit('room:join', { code: targetCode, name, token }).then(res => {
        if (res?.ok) {
          afterJoin(res, name);
          showScreen(res.state === 'playing' ? 'game' : 'lobby');
          // F1.4: we may be returning from a locked screen / slept device. We
          // cannot trust the incremental render cursor after rAF stalls, so force
          // a full table rebuild and tell the player where things stand.
          if (res.state === 'playing' && board) {
            board.invalidate();
            // Prefer the freshly assigned local view; fall back to the ack payload.
            const g = (view && view.playerId === res.playerId) ? view : null;
            const myTurnNow = g ? (g.turn === myId) : !!res.youAreUp;
            setBannerHold(myTurnNow ? 'اتصلت من جديد — دورك الآن' : 'اتصلت من جديد — مستني الدور',
              myTurnNow ? 'mine' : '', 3200);
            if (myTurnNow) startTurnAlert();
          }
        } else {
          // 0.10: a swallowed failure here is a dead game screen with no reason.
          resetToHome(res?.error || 'مش قادرين نرجّعك للغرفة — اتصل تاني أو ادخل بالكود.');
        }
      });
    }
  });
  // 1.9: a dropped socket in a 30-second-turn game is the #1 killer of the
  // session. Say it out loud, dim the table, and say it again when it's back.
  socket.on('disconnect', () => {
    setConn(false);
    toast('⚠️ الاتصال اتقطع — بحاول أرجع');
    if (view) setBannerHold('⚠️ الاتصال اتقطع — بحاول أرجع', '', 6000);
  });
  socket.io.on('reconnect_attempt', () => {
    setConn(false);
    if (view) setBannerHold('⚠️ الاتصال اتقطع — بحاول أرجع', '', 6000);
  });
  socket.on('lobby:state', renderLobby);
  socket.on('game:started', () => {
    // Fresh match: clear per-game transient UI state so a rematch starts clean.
    selectedTile = null;
    newlyDrawnTileId = null;
    lastActionKey = '';
    prevTurnKey = null;
    showScreen('game');
    sfx.start();
    sfx.ambient(true);
  });
  socket.on('game:state', (st) => {
    perfMsgs++;                                     // F3.3: messages/sec counter
    clockOffset = st.serverNow ? st.serverNow - Date.now() : 0;
    view = st; isHost = st.hostId === myId; renderGame();
  });
  socket.on('chat:msg', onChatMsg);
  socket.on('chat:history', onChatHistory);
  socket.on('chat:typing', onChatTyping);
  socket.on('chat:limited', onChatLimited);
  socket.on('lobby:closed', () => {
    // the server swept this idle lobby — back home with a note
    leaveRoom();
    homeError('اتقفلت الغرفة بسبب الخمول الطويل.');
  });
  socket.on('lobby:reopened', () => {
    // K2.S10: the host pulled the table back to a lobby after a match —
    // follow along so seats/ready/config are editable again.
    view = null;
    selectedTile = null;
    newlyDrawnTileId = null;
    lastActionKey = '';
    prevTurnKey = null;
    stopTurnAlert();
    board?.clearMarkers();
    closeChat();
    sfx.ambient(false);
    showScreen('lobby');
  });
  socket.on('room:kicked', () => {
    // the host removed us; clear stored tokens so auto-rejoin can't pull us back
    if (roomCode) {
      sessionStorage.removeItem('domino_token_' + roomCode);
      localStorage.removeItem('domino_token_' + roomCode);
    }
    leaveRoom();
    homeError('تم طردك من الغرفة.');
  });
  // 0.7: the server emits this when the SAME seat is re-joined from another tab.
  // Without a listener the old tab sat there forever, playing a dead board.
  socket.on('room:superseded', () => {
    resetToHome('اللعبة اتفتحت في نافذة تانية — النافذة دي اتقفلت. تابع من النافذة الجديدة.');
  });
  socket.on('error', (e) => {
    // 0.2: the engine speaks English; the banner must not. Anything unrecognised
    // falls back to a generic Arabic line rather than leaking `not your turn`.
    setBanner('⚠ ' + translateServerError(e?.message), 'error');
  });
}

function boot() {
  // Retired preference from the removed 2D-table mode — clean it up once.
  try { localStorage.removeItem('domino_force2d'); } catch { /* storage blocked */ }
  startSocket('');
  initHome(); initLobby(); initGameUI();
  try { initVoiceUI(); } catch (err) {
    // Voice is an enhancement: a broken panel must never stop the game booting.
    console.warn('[voice] init failed:', err?.message || err);
  }
  // F1.3: skip the countdown tick entirely while the tab is hidden — it is pure
  // DOM work nobody can see, and it keeps SFX (alarm/tick) from firing in a
  // background tab. The state render on return catches the clock up instantly.
  setInterval(() => { if (!document.hidden) updateTurnTimer(); }, 200);
}

boot();
