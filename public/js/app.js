// js/app.js — Domino Arena client: screens, net, hand UI, chat, modals
import { Board3D } from './board3d.js?v=25';
import { DomBoard, webglAvailable } from './domboard.js?v=3';
import { Home3D } from './home3d.js?v=2';
import { tileImage, setTheme as setTileTheme, getTheme, THEME_NAMES } from './tiles.js?v=13';
import { sfx } from './sfx.js?v=16';

const $ = id => document.getElementById(id);
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

// F4.5: build the game table, degrading to a 2D DOM board when WebGL is
// unavailable (old GPUs, blocklisted drivers, VMs, GPU process crashes) — or
// when the user forced 2D in settings (K3.C6). The 3D renderer can throw from
// its constructor, so both the probe and the construct are guarded — a failed
// table must never take the whole game down with it.
function force2d() {
  try { return localStorage.getItem('domino_force2d') === '1'; } catch { return false; }
}
function createBoard(canvas, cbs) {
  try {
    if (!force2d() && webglAvailable()) return new Board3D(canvas, cbs);
  } catch (err) {
    console.warn('[domino] 3D board unavailable, falling back to 2D:', err?.message || err);
  }
  try {
    return new DomBoard(canvas, cbs);
  } catch (err) {
    console.error('[domino] 2D fallback board also failed:', err);
    return null;
  }
}

// ══════════ screens ══════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
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
  // K3.C6: force-2D also skips the 3D backdrops (battery/weak-GPU setting).
  const want3d = !force2d();
  if (want3d) {
    try {
      home3d = new Home3D($('home3d'));
      home3d.setActive(true);
    } catch (err) {
      console.warn('home3d unavailable — using 2D falling tiles', err);
      home3d = null;
    }
  }
  if (!home3d) spawnFallingTiles('heroTiles');
  if (want3d) {
    try {
      lobby3d = new Home3D($('lobby3d'));
    } catch (err) {
      console.warn('lobby3d unavailable — using 2D falling tiles', err);
      lobby3d = null;
    }
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
}

function getName() {
  const name = $('inpName').value.trim();
  if (!name) { homeError('من فضلك اكتب اسمك أولاً!'); return null; }
  localStorage.setItem('domino_name', name);
  return name;
}
function homeError(msg) { $('homeError').textContent = msg || ''; }

function afterJoin(res, name) {
  myId = res.playerId || null; myToken = res.token || null; myName = name; roomCode = res.code;
  myReady = false;
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
  if (res.lobby) {
    renderLobby(res.lobby);
  } else if (lastLobbyState) {
    renderLobby(lastLobbyState);
  }
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
      navigator.share({ title: 'دومينو أرينا', text: `ادخل غرفتي بالكود ${roomCode}`, url }).catch(() => {});
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
function leaveRoom() {
  // Stop auto-rejoin BEFORE telling the server, so a fast reconnect can't pull us back in.
  if (roomCode) {
    sessionStorage.removeItem('domino_token_' + roomCode);
    localStorage.removeItem('domino_token_' + roomCode);
  }
  localStorage.removeItem('domino_last_code');
  emit('room:leave').catch(() => {});
  myId = myToken = roomCode = null;
  myReady = false;
  isHost = false;
  lastLobbyState = null;
  view = null;
  selectedTile = null;
  spectating = false;
  clearTimeout(autoPlayTimer);
  stopTurnAlert();
  board?.clearMarkers();
  closeChat();
  unread = 0;
  updateBadge();
  const msgs = $('chatMsgs');
  if (msgs) msgs.innerHTML = '';
  sfx.ambient(false);
  closeLeaveConfirm();
  history.replaceState(null, '', location.pathname);
  homeError('');
  showScreen('home');
  sfx.click();
}
function openLeaveConfirm() { $('modalLeave').classList.remove('hidden'); }
function closeLeaveConfirm() { $('modalLeave').classList.add('hidden'); }

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
    const avCol = document.createElement('div');
    avCol.className = 'opp-avatar-col';
    const av = document.createElement('div');
    av.className = 'opp-avatar' + (isTurn ? ' active' : '');
    av.textContent = view.isBot?.[pid] ? '🤖' : name.trim().charAt(0).toUpperCase();
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
      tiles.textContent = '🁢 ';
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
const SORT_MODES = ['deal', 'pips', 'playable', 'doubles'];
const SORT_LABELS = { deal: '🂠 ترتيب السحب', pips: '⚖ ثقيل أولاً', playable: '✅ المتاح أولاً', doubles: '🎲 الدبل أولاً' };
let sortMode = (() => {
  try {
    const v = localStorage.getItem('domino_sort');
    return SORT_MODES.includes(v) ? v : 'deal';
  } catch { return 'deal'; }
})();

function sortedHand() {
  const h = [...(view.hand || [])];
  if (sortMode === 'deal') return h;
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
  const playable = new Set((view.legalMoves || []).map(m => m.tileId));
  return h.sort((x, y) => (playable.has(y.id) - playable.has(x.id)) || byPips(x, y));
}

function cycleSort() {
  const i = SORT_MODES.indexOf(sortMode);
  sortMode = SORT_MODES[(i + 1) % SORT_MODES.length];
  try { localStorage.setItem('domino_sort', sortMode); } catch { /* no storage */ }
  const btn = $('btnSort');
  if (btn) { btn.textContent = SORT_LABELS[sortMode]; btn.title = 'ترتيب اليد: ' + SORT_LABELS[sortMode]; }
  sfx.click();
  renderHand();
}

function renderHand() {
  if (!view) return; // boot/themes can repaint before any game:state arrives
  const hand = $('hand');
  const myTurn = !spectating && view.turn === myId && view.status === 'playing';
  hand.classList.toggle('my-turn', myTurn);
  hand.innerHTML = '';
  const playableIds = new Set(myTurn ? (view.legalMoves || []).map(m => m.tileId) : []);
  for (const t of sortedHand()) {
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
}

function renderActions() {
  const myTurn = !spectating && view.turn === myId && view.status === 'playing';
  $('btnDraw').classList.toggle('hidden', spectating || !(myTurn && view.canDraw));
  $('boneyardCount').textContent = `(${view.boneyardCount})`;
  $('btnPass').classList.toggle('hidden', spectating || !(myTurn && view.canPass));
  // Hint only makes sense when it's my turn AND there is something to suggest.
  $('btnHint').classList.toggle('hidden', !myTurn || (view.legalMoves || []).length === 0);
  const pill = $('endsPill');
  if (view.variant === 'allfives' && view.moves.length) {
    pill.classList.remove('hidden');
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
    row.innerHTML = `
      <span class="sc-rank">${['🥇', '🥈', '🥉', '4.'][i] || (i + 1) + '.'}</span>
      <span class="sc-name" title="${esc(view.names[pid] || 'لاعب')}">${view.isBot?.[pid] ? '🤖 ' : ''}${esc(view.names[pid] || 'لاعب')}</span>
      <span class="sc-pts">${view.scores[pid] || 0}</span>
    `;
    card.appendChild(row);
  });
  // F4.4: roll each score up from its previous value. Runs AFTER the rows are in
  // the DOM so the rAF writes land on the live elements.
  if (!prefersReducedMotion()) {
    card.querySelectorAll('.sc-row').forEach((row, i) => {
      const pid = ranked[i];
      const to = view.scores[pid] || 0;
      const from = _scorePrev.get(pid);
      if (from !== undefined && from !== to) rollNumber(row.querySelector('.sc-pts'), from, to);
    });
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
    codeRow.innerHTML = `🚪 غرفة <b>${esc(roomCode)}</b> 📋`;
    codeRow.onclick = () => { copyText(roomCode, 'تم نسخ الكود!'); sfx.click(); };
    card.appendChild(codeRow);
  }
}

function setBanner(text, cls) {
  $('turnBannerText').textContent = text;
  $('turnBanner').className = cls || '';
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
  if (spectating) {
    const nm = view.names?.[view.turn] || '';
    setBanner(view.status === 'playing' ? `👁 بتتفرج — دور ${nm}` : '👁 بتتفرج', 'spect');
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
    setBanner(`دور ${view.names[view.turn] || 'اللاعب'}`, '');
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
  wrap.classList.toggle('warn', remainMs <= 10000);
  wrap.classList.toggle('danger', remainMs <= 5000);
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
    el.textContent = '';
    el.classList.add('hidden');
  } else {
    const winPct = Math.round((s.wins / s.matches) * 100);
    el.classList.remove('hidden');
    el.innerHTML =
      `<span class="hs-row"><b>🏆 ${s.wins}</b> فوز من <b>${s.matches}</b> · ${winPct}%</span>` +
      `<span class="hs-row">سلسلة <b>${streakLabel(s.streak)}</b> · أطول <b>${s.bestStreak}</b></span>` +
      `<span class="hs-row">متوسط <b>${s.avgScore}</b> · أعلى <b>${s.bestScore}</b>${s.botWins ? ` · ${s.botWins} ضد البوت` : ''}</span>` +
      (s.history.length ? `<span class="hs-form" title="آخر ${s.history.length} مباريات (الأحدث أولاً)">${formStrip(s.history)}</span>` : '');
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
    if (isHost && nhVotes?.count) nhBtn.textContent = `الجولة التالية (${nhVotes.count}/${nhVotes.humans} يطلبوا)`;
    else nhBtn.textContent = 'الجولة التالية';
    const nhVoteBtn = $('btnNextHandVote');
    nhVoteBtn.classList.toggle('hidden', isHost);
    if (!isHost) {
      const already = nhVotes?.count ? ' ✓ تم الإرسال' : '';
      nhVoteBtn.textContent = `أطلب الجولة التالية${nhVotes?.count ? ` (${nhVotes.count}/${nhVotes.humans})` : ''}${already}`;
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
      row.innerHTML = `<span>${['🥇', '🥈', '🥉', '4.'][i]} ${esc(view.names[pid] || 'لاعب')}</span><span>${view.scores[pid]} نقطة</span>`;
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
      ? `مباراة جديدة (${rmVotes.length}/${humans} وافقوا)`
      : 'مباراة جديدة';
    const rmVoteBtn = $('btnRematchVote');
    rmVoteBtn.classList.toggle('hidden', isHost);
    if (!isHost) {
      rmVoteBtn.textContent = iVoted ? '✓ طلبت مباراة جديدة' : 'أطلب مباراة جديدة';
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
        setTimeout(() => {
          if (newlyDrawnTileId === drawnTile.id) {
            newlyDrawnTileId = null;
            renderHand();
          }
        }, 1200);
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
      if (ends.length) board.showMarkers(ends);
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
  sfx.select();
  if (moves[0].end === null) {                    // lead move — play immediately
    socket.emit('game:play', { tileId: tile.id, end: null });
    selectedTile = null;
    return;
  }
  if (selectedTile === tile.id) {
    // If tile has only 1 legal end, tapping again plays it
    if (moves.length === 1) {
      socket.emit('game:play', { tileId: tile.id, end: moves[0].end });
      selectedTile = null;
      board.clearMarkers();
      return;
    }
    selectedTile = null; board.clearMarkers(); renderHand();
    return;
  }
  selectedTile = tile.id;
  const uniqueEnds = [...new Set(moves.map(m => m.end))];
  const previews = {};
  if (view.variant === 'allfives') {
    for (const e of uniqueEnds) previews[e] = previewEndsTotal(tile.id, e);
  }
  board.showMarkers(uniqueEnds, view.variant === 'allfives' ? previews : null);
  renderHand();
  if (uniqueEnds.length > 1) {
    setBanner('اختر النقطة الخضراء للطرف الذي تريد اللعب عليه!', 'mine');
  }
}

function onMarkerClick(end) {
  if (!selectedTile) return;
  socket.emit('game:play', { tileId: selectedTile, end });
  selectedTile = null;
  board.clearMarkers();
  renderHand();
}

// ── drag & drop: pull a playable tile from the hand and drop it on a board end ──
let tileDrag = null;
function startTileDrag(e, tile, el) {
  if (e.button !== undefined && e.button !== 0) return;
  if (!view || view.status !== 'playing' || view.turn !== myId) return;
  const moves = (view.legalMoves || []).filter(m => m.tileId === tile.id);
  if (!moves.length) return;
  // The lead move has no drop target, but the drag must still be tracked: a
  // plain tap reaches endTileDrag → onTileClick, which plays the lead at once.
  // Bailing out here left the first tile of a hand unplayable (tap AND drag dead).
  tileDrag = { tile, el, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, over: null, noDrop: moves[0].end === null };
  try { el.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
}
function moveTileDrag(e) {
  if (!tileDrag || tileDrag.noDrop) return;
  if (!tileDrag.moved && Math.hypot(e.clientX - tileDrag.startX, e.clientY - tileDrag.startY) < 8) return;
  if (!tileDrag.moved) {
    tileDrag.moved = true;
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
        for (const en of uniqueEnds) previews[en] = previewEndsTotal(tileDrag.tile.id, en);
      }
      board.showMarkers(uniqueEnds, view.variant === 'allfives' ? previews : null);
    }
  }
  tileDrag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  const over = board?.endFromPoint?.(e.clientX, e.clientY) ?? null;
  if (over !== tileDrag.over) {
    tileDrag.over = over;
    board?.highlightEnd?.(over);
  }
}
function endTileDrag(e) {
  if (!tileDrag) return;
  const d = tileDrag;
  tileDrag = null;
  try { d.el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  d.ghost?.remove();
  if (board?.controls) board.controls.enabled = true;
  board?.highlightEnd?.(null);
  if (d.moved && d.over) {
    socket.emit('game:play', { tileId: d.tile.id, end: d.over });
    selectedTile = null;
    board.clearMarkers();
    renderHand();
  } else if (d.moved) {
    // dropped nowhere — clean up the markers we revealed (unless tap-selected)
    if (selectedTile !== d.tile.id) { board.clearMarkers(); }
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
  $('btnSort').textContent = SORT_LABELS[sortMode];
  $('btnSort').title = 'ترتيب اليد: ' + SORT_LABELS[sortMode];
  // btnSettings markup is not shipped yet — guard so a missing
  // element can never abort initGameUI and orphan every handler after it.
  const btnSettings = $('btnSettings');
  if (btnSettings) btnSettings.onclick = () => { openSettings(); sfx.click(); };
  $('btnNextHand').onclick = () => socket.emit('game:nextHand');
  $('btnRematch').onclick = () => socket.emit('game:rematch');
  $('btnNextHandVote').onclick = () => { socket.emit('game:nextHandVote'); sfx.click(); };
  $('btnRematchVote').onclick = () => { socket.emit('game:rematchVote'); sfx.click(); };
  $('btnChat').onclick = (e) => {
    e.stopPropagation();
    chatOpen ? closeChat() : openChat();
  };
  $('chatClose').onclick = (e) => {
    e.stopPropagation();
    closeChat();
  };
  document.addEventListener('click', (e) => {
    if (chatOpen && !$('chatDrawer').contains(e.target) && !$('btnChat').contains(e.target)) {
      closeChat();
    } else if (emojiPopOpen && !$('emojiPop').contains(e.target) && !$('btnEmoji').contains(e.target)) {
      closeEmojiPop();
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
      if (!$('modalLeave').classList.contains('hidden')) {
        sfx.click();
        closeLeaveConfirm();
      } else if (emojiPopOpen) {
        closeEmojiPop();
      } else if (chatOpen) {
        closeChat();
      }
    }
  });
  $('btnEmoji').onclick = (e) => {
    e.stopPropagation();
    emojiPopOpen ? closeEmojiPop() : openEmojiPop();
  };
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  $('chatInput').addEventListener('input', updateChatCount);
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

// ── K3.C6: settings modal — master volume, force-2D, confirm-moves, vibration ──
function openSettings() {
  const modal = $('modalSettings');
  if (!modal) return;
  const rng = $('rngVolume');
  if (rng) rng.value = String(Math.round((sfx.getVolume?.() ?? 1) * 100));
  const f2 = $('chkForce2d');
  if (f2) f2.checked = force2d();
  const cf = $('chkConfirm');
  if (cf) cf.checked = confirmEnabled();
  const vb = $('chkVibrate');
  if (vb) vb.checked = (() => { try { return localStorage.getItem('domino_vibrate') !== '0'; } catch { return true; } })();
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
    rng.oninput = () => { sfx.setVolume?.(Number(rng.value) / 100); };
    rng.onchange = () => sfx.click();
  }
  const f2 = $('chkForce2d');
  if (f2) {
    f2.onchange = () => {
      try { localStorage.setItem('domino_force2d', f2.checked ? '1' : '0'); } catch { /* no storage */ }
      location.reload();   // boards/backdrops are built at boot — rebuild fresh
    };
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
  socket.emit('chat:send', { emoji: em });
  sfx.select();
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
      chip.onclick = () => { socket.emit('chat:send', { text: phrase }); sfx.select(); };
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
  chatOpen = true;
  $('chatDrawer')?.classList.remove('hidden');
  closeEmojiPop();
  renderChatEmpty();
  unread = 0;
  updateBadge();
  const box = $('chatMsgs');
  if (box) box.scrollTop = box.scrollHeight;
  setTimeout(() => $('chatInput')?.focus(), 80);
}

function closeChat() {
  chatOpen = false;
  $('chatDrawer')?.classList.add('hidden');
  closeEmojiPop();
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

function appendChatMsg(msg) {
  const box = $('chatMsgs');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  box.querySelector('.chat-empty')?.remove();

  const mine = isMineMsg(msg);
  const sys = !msg.pid && msg.from === 'النظام';

  if (sys) {
    const el = document.createElement('div');
    el.className = 'chat-sys';
    el.textContent = msg.text || '';
    box.appendChild(el);
  } else {
    const prev = box.lastElementChild;
    const grouped = !!prev && prev.classList.contains(mine ? 'mine' : 'other')
      && prev.dataset.pid === (msg.pid || '')
      && Date.now() - (Number(prev.dataset.at) || 0) < 3 * 60 * 1000;

    const row = document.createElement('div');
    row.className = 'chat-row ' + (mine ? 'mine' : 'other') + (grouped ? ' grouped' : '');
    row.dataset.pid = msg.pid || '';
    row.dataset.at = String(msg.at || Date.now());

    const col = document.createElement('div');
    col.className = 'chat-col';

    if (!grouped) {
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      const timeStr = new Date(msg.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      av.textContent = (msg.from || '؟').trim().charAt(0).toUpperCase();
      av.style.setProperty('--av-bg', 'rgba(' + rgb + ',.18)');
      av.style.setProperty('--av-fg', 'rgb(' + rgb + ')');
      row.appendChild(av);
    }
    row.appendChild(col);
    box.appendChild(row);
  }

  if (atBottom || (mine && !sys)) box.scrollTop = box.scrollHeight;
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
  toast.addEventListener('click', openChat);

  const av = document.createElement('span');
  av.className = 'chat-av';
  av.style.setProperty('--av-bg', 'rgba(' + rgb + ',.18)');
  av.style.setProperty('--av-fg', 'rgb(' + rgb + ')');
  av.textContent = (msg.from || '؟').trim().charAt(0).toUpperCase();
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

function onChatMsg(msg) {
  showChatToast(msg);
  appendChatMsg(msg);
  if (msg.pid && msg.pid !== myId) sfx.chatPop();
  if (!chatOpen) {
    unread++;
    updateBadge();
  }
}

function updateBadge() {
  const badge = $('chatBadge');
  if (!badge) return;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', !unread);
}

// ══════════ effects ══════════
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

// ══════════ boot ══════════
// Web mode: same-origin (browser / Cloudflare Tunnel) — today's behaviour, untouched.
// APK mode: every phone runs its own game server; the launcher discovers nearby
// phones and the app shows them as a tap-to-join list (startAppNet below).
const IN_APP = typeof window.Capacitor !== 'undefined';
const STATUS_URL = 'http://127.0.0.1:3001';

function startSocket(base) {
  socket = io(base || undefined, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    $('connPill').className = 'ok';
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
            setBanner(myTurnNow ? 'اتصلت من جديد — دورك الآن' : 'اتصلت من جديد', myTurnNow ? 'mine' : '');
            if (myTurnNow) startTurnAlert();
          }
        }
      });
    }
  });
  socket.on('disconnect', () => { $('connPill').className = 'bad'; });
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
  socket.on('error', (e) => {
    setBanner('⚠ ' + (e.message || 'خطأ'), '');
  });
}

// ── APK network glue: every phone runs its own game server, so we connect to
// ourselves by default and keep a tap-to-join list of nearby phones (from the
// launcher's discovery). Status contract (mobile launcher): GET 127.0.0.1:3001/status →
// { status: 'ready', serverUrl, ips, peers: [{ ip, port }] }
function netPill(html, cls = '') {
  const el = $('netStatus');
  if (!el) return;
  el.className = 'net-status' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
}

const LOCAL_BASE = 'http://127.0.0.1:3000';
let activeBase = null;

function connectToBase(base, label) {
  if (activeBase === base) return;
  activeBase = base;
  if (socket) { socket.disconnect(); socket = null; }
  startSocket(base);
  netPill(label, 'ok');
}

function startAppNet() {
  const manual = (localStorage.getItem('domino_manual_server') || '').trim();
  if (manual) {
    const base = /^https?:\/\//.test(manual) ? manual : 'http://' + manual;
    connectToBase(base, '🔌 خادم مخصص: ' + manual);
  } else {
    connectToBase(LOCAL_BASE, '📡 أنت مضيف الشبكة — اعمل غرفة وشارك الكود');
  }
  tickLan();
}

// discovery loop: refresh the nearby-phones panel + your own LAN IP line
async function tickLan() {
  if (!activeBase) return;
  let s = null;
  try { s = await (await fetch(STATUS_URL + '/status')).json(); } catch { /* launcher not up yet */ }
  const ul = $('lanPeers');
  if (s && ul) {
    // own LAN IP(s): what remote players must type to join YOUR room
    const self = $('lanSelf');
    if (self) {
      self.textContent = s.ips && s.ips[0]
        ? 'شارك عنوانك: ' + s.ips[0] + ':3000 — أو اعمل غرفة وشارك الكود'
        : 'اعمل غرفة وشارك الكود';
    }
    // nearby phones: other players found on this subnet
    const peers = (s.peers || []).filter((p) => 'ip' in p);
    ul.innerHTML = '';
    // "back to my phone" entry whenever we're connected somewhere else
    if (activeBase !== LOCAL_BASE) {
      const li = document.createElement('li');
      li.className = 'lan-peer self';
      li.textContent = '🏠 جهازك (مضيفك أنت)';
      li.onclick = () => { sfx.click(); connectToBase(LOCAL_BASE, '📡 رجعت لجهازك — أنت المضيف'); };
      ul.appendChild(li);
    }
    for (const p of p_list(peers)) {
      const li = document.createElement('li');
      li.className = 'lan-peer' + (activeBase === `http://${p.ip}:${p.port}` ? ' active' : '');
      li.textContent = '📱 ' + p.label;
      li.onclick = () => {
        sfx.click();
        connectToBase(`http://${p.ip}:${p.port}`, '🔌 اتصلت بـ ' + p.label);
      };
      ul.appendChild(li);
    }
    if (!peers.length && activeBase === LOCAL_BASE) {
      const li = document.createElement('li');
      li.className = 'lan-peer none';
      li.textContent = '🔍 مفيش أجهزة ظاهرة — اتأكد إن اللاعبين على نفس الواي فاي/هوت سبوت';
      ul.appendChild(li);
    }
  }
  setTimeout(tickLan, 2000);
}

// fetch each peer's live room/player counts once (launcher proxies to avoid CORS)
const peerLabels = new Map();   // ip -> { label, at }
function p_list(peers) {
  return peers.map((p) => {
    const cached = peerLabels.get(p.ip);
    if (cached && Date.now() - cached.at < 30000) return { ...p, label: cached.label };
    fetch(STATUS_URL + '/peer/' + encodeURIComponent(p.ip))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const rooms = j && typeof j.rooms === 'number' ? j.rooms : 0;
        const players = j && typeof j.players === 'number' ? j.players : 0;
        const label = `${p.ip} — ${players} لاعبين، ${rooms} غرف`;
        peerLabels.set(p.ip, { label, at: Date.now() });
      })
      .catch(() => { peerLabels.set(p.ip, { label: p.ip, at: Date.now() }); });
    return { ...p, label: cached ? cached.label : p.ip };
  });
}

// ── advanced settings (APK only): manual server address
function initAppNetUI() {
  const toggle = $('advToggle');
  if (!toggle || !IN_APP) return;
  toggle.classList.remove('hidden');
  toggle.onclick = () => {
    sfx.click();
    $('advPanel').classList.toggle('hidden');
  };
  const inp = $('inpManualServer');
  inp.value = localStorage.getItem('domino_manual_server') || '';
  $('btnSaveServer').onclick = () => {
    sfx.click();
    const v = inp.value.trim().replace(/^https?:\/\//, '');
    if (v) localStorage.setItem('domino_manual_server', v);
    else localStorage.removeItem('domino_manual_server');
    location.reload();
  };
  $('btnClearServer').onclick = () => {
    sfx.click();
    localStorage.removeItem('domino_manual_server');
    location.reload();
  };
}

function boot() {
  if (IN_APP) startAppNet(); else startSocket('');
  initHome(); initLobby(); initGameUI(); initAppNetUI();
  // F1.3: skip the countdown tick entirely while the tab is hidden — it is pure
  // DOM work nobody can see, and it keeps SFX (alarm/tick) from firing in a
  // background tab. The state render on return catches the clock up instantly.
  setInterval(() => { if (!document.hidden) updateTurnTimer(); }, 200);
}

boot();
