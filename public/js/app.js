// js/app.js — Domino Arena client: screens, net, hand UI, chat, modals
import { Board3D } from './board3d.js?v=18';
import { Home3D } from './home3d.js?v=2';
import { tileImage } from './tiles.js?v=11';
import { sfx } from './sfx.js?v=15';
import { VoiceChat, setIceConfig } from './voice.js?v=4';

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
let voice = null;                                  // VoiceChat, created in boot()
let voiceSelf = { joined: false, muted: false, speaking: false };
let voicePeers = [];                               // roster for the voice panel
let voicePanelOpen = false;
let voiceUnsupported = false;                      // mic unavailable (unsupported/insecure) — buttons disabled in boot()
const speakingSet = new Set();                     // pids currently lit as speaking

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

// ══════════ screens ══════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
  if (name === 'game' && !board) {
    board = new Board3D($('table3d'), { onMarkerClick, onBoardMiss, onBoneyardClick: onBoneyardDraw });
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
  try {
    home3d = new Home3D($('home3d'));
    home3d.setActive(true);
  } catch (err) {
    console.warn('home3d unavailable — using 2D falling tiles', err);
    home3d = null;
    spawnFallingTiles('heroTiles');
  }
  try {
    lobby3d = new Home3D($('lobby3d'));
  } catch (err) {
    console.warn('lobby3d unavailable — using 2D falling tiles', err);
    lobby3d = null;
    spawnFallingTiles('lobbyHeroTiles');
  }
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
  let botLevel = 'medium';
  document.querySelectorAll('#diffRow .diff-chip').forEach(ch => {
    ch.onclick = () => {
      botLevel = ch.dataset.level;
      document.querySelectorAll('#diffRow .diff-chip').forEach(c => c.classList.toggle('active', c === ch));
      sfx.click();
    };
  });
  $('btnBots').onclick = () => {
    const name = getName(); if (!name) return;
    emit('room:create', { name, vsBots: true, botLevel }).then(res => {
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
        showScreen(res.state === 'playing' ? 'game' : 'lobby');
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
  myId = res.playerId; myToken = res.token; myName = name; roomCode = res.code;
  voice?.setSelf(myId);
  sessionStorage.setItem('domino_token_' + roomCode, myToken);
  localStorage.setItem('domino_token_' + roomCode, myToken);
  localStorage.setItem('domino_last_code', roomCode);
  history.replaceState(null, '', '?room=' + roomCode);
  $('lobbyCode').textContent = roomCode;
  const chip = $('chatRoomChip');
  if (chip) chip.textContent = 'غرفة ' + roomCode;
  if (res.lobby) {
    renderLobby(res.lobby);
  } else if (lastLobbyState) {
    renderLobby(lastLobbyState);
  }
}

// ══════════ lobby ══════════
function renderLobby(st) {
  if (!st) return;
  lastLobbyState = st;
  isHost = st.hostId === myId;
  $('lobbyCode').textContent = st.code;
  const countEl = $('playerCount');
  if (countEl) countEl.textContent = `${(st.players || []).length}/${st.config?.maxPlayers ?? 4}`;
  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of (st.players || [])) {
    const li = document.createElement('li');
    if (p.id === myId) li.className = 'me';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = p.name + (p.isBot ? ' 🤖' : '') + (p.id === st.hostId ? ' 👑' : '');
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

  $('hostConfig').classList.toggle('hidden', !isHost);
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnReady').classList.toggle('hidden', isHost);

  const me = (st.players || []).find(p => p.id === myId);
  $('btnReady').textContent = me?.ready ? 'لست جاهزاً' : 'أنا جاهز';

  // host can only start if >=2 players and non-hosts are ready
  const others = (st.players || []).filter(p => p.id !== st.hostId);
  const allReady = others.length > 0 && others.every(p => p.ready);
  $('btnStart').disabled = !(st.players && st.players.length >= 2 && allReady);

  if (st.config) {
    if (st.config.variant) $('selVariant').value = st.config.variant;
    if (st.config.targetScore) $('selTarget').value = st.config.targetScore;
    if (st.config.maxPlayers) $('selMax').value = st.config.maxPlayers;
    if (st.config.turnMs) $('selTurnMs').value = String(st.config.turnMs);
    $('variantDesc').textContent = VARIANT_DESC[st.config.variant] || '';
  }
}

function initLobby() {
  const btnAddBot = $('btnAddBot');
  if (btnAddBot) {
    btnAddBot.onclick = () => { socket.emit('lobby:addBot', {}); sfx.click(); };
  }
  spawnFallingTiles('lobbyHeroTiles');
  $('btnCopyCode').onclick = () => copyText(roomCode, 'تم نسخ الكود!');
  $('btnCopyLink').onclick = () => copyText(location.origin + '?room=' + roomCode, 'تم نسخ رابط الدعوة!');
  $('btnReady').onclick = () => {
    askNotifyPermission();
    const cur = $('btnReady').textContent === 'لست جاهزاً';
    socket.emit('lobby:ready', { ready: !cur });
    sfx.click();
  };
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
  $('btnLobbyMic').onclick = () => toggleMic();
  bindPttHold($('btnLobbyMic'));
  for (const id of ['selVariant', 'selTarget', 'selMax', 'selTurnMs']) {
    $(id).onchange = () => emit('lobby:config', {
      variant: $('selVariant').value,
      targetScore: +$('selTarget').value,
      maxPlayers: +$('selMax').value,
      turnMs: +$('selTurnMs').value,
    });
  }
}
function lobbyError(msg) { $('lobbyError').textContent = msg || ''; }

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
  voice?.setSelf(null);
  isHost = false;
  lastLobbyState = null;
  view = null;
  selectedTile = null;
  clearTimeout(autoPlayTimer);
  stopTurnAlert();
  board?.clearMarkers();
  closeChat();
  voice?.leave();
  closeVoicePanel();
  speakingSet.clear();
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
  board?.sync(view);
  board?.setCanDraw(view.turn === myId && view.status === 'playing' && view.canDraw);
  renderOpponents();
  renderHand();
  renderActions();
  renderTurnBanner();
  updateTurnTimer();
  renderScoreCard();
  renderModals();
  playActionSounds();
  maybeAutoPlay();
  prevHand = [...(view.hand || [])];
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

function renderHand() {
  const hand = $('hand');
  const myTurn = view.turn === myId && view.status === 'playing';
  hand.classList.toggle('my-turn', myTurn);
  hand.innerHTML = '';
  const playableIds = new Set(myTurn ? view.legalMoves.map(m => m.tileId) : []);
  for (const t of view.hand) {
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
  const myTurn = view.turn === myId && view.status === 'playing';
  $('btnDraw').classList.toggle('hidden', !(myTurn && view.canDraw));
  $('boneyardCount').textContent = `(${view.boneyardCount})`;
  $('btnPass').classList.toggle('hidden', !(myTurn && view.canPass));
  const pill = $('endsPill');
  if (view.variant === 'allfives' && view.moves.length) {
    pill.classList.remove('hidden');
    $('endsTotal').textContent = view.endsTotal;
    pill.classList.toggle('hot', view.endsTotal > 0 && view.endsTotal % 5 === 0);
  } else pill.classList.add('hidden');
}

function renderScoreCard() {
  const card = $('scoreCard');
  if (!card || !view) return;
  const ranked = [...view.players].sort((a, b) => (view.scores[b] || 0) - (view.scores[a] || 0));
  card.innerHTML = '';
  ranked.forEach((pid, i) => {
    const row = document.createElement('div');
    row.className = 'sc-row' + (pid === myId ? ' me' : '') + (speakingSet.has(pid) ? ' speaking' : '');
    row.innerHTML = `
      <span class="sc-rank">${['🥇', '🥈', '🥉', '4.'][i] || (i + 1) + '.'}</span>
      <span class="sc-name" title="${esc(view.names[pid] || 'لاعب')}">${view.isBot?.[pid] ? '🤖 ' : ''}${esc(view.names[pid] || 'لاعب')}</span>
      <span class="sc-pts">${view.scores[pid] || 0}</span>
    `;
    card.appendChild(row);
  });
}

function setBanner(text, cls) {
  $('turnBannerText').textContent = text;
  $('turnBanner').className = cls || '';
}

// ── "your turn" attention: flashing tab title + vibration + optional notification ──
const BASE_TITLE = document.title;
let turnAlertOn = false;
function startTurnAlert() {
  if (turnAlertOn) return;
  turnAlertOn = true;
  document.title = '🔔 دورك — دومينو أرينا';
  try { navigator.vibrate?.([180, 80, 180]); } catch (e) { /* unsupported */ }
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('🔔 دورك!', { body: `دورك في غرفة ${roomCode || ''} — افتح اللعبة واتحرك` });
    } catch (e) { /* some platforms throw without a service worker */ }
  }
}
function stopTurnAlert() {
  if (!turnAlertOn) return;
  turnAlertOn = false;
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
  if (view.leadForcedTile || view.moves.length === 0) return;   // opening stays manual
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
  if (view.status !== 'playing') { setBanner('', ''); return; }
  if (view.turn === myId) {
    if (view.leadForcedTile) {
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
  if (!view || view.status !== 'playing' || !view.turnEndsAt) {
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
let recordedMatchKey = null;
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem('domino_stats'));
    if (s && typeof s === 'object') return { matches: s.matches || 0, wins: s.wins || 0, bestScore: s.bestScore || 0, botWins: s.botWins || 0 };
  } catch { /* corrupt or absent */ }
  return { matches: 0, wins: 0, bestScore: 0, botWins: 0 };
}
function recordMatchResult(v) {
  const key = v.matchWinnerId + ':' + Object.entries(v.scores).sort().join(',');
  if (recordedMatchKey === key) return; // renderModals re-runs — record once
  recordedMatchKey = key;
  const s = loadStats();
  s.matches += 1;
  if (v.matchWinnerId === myId) {
    s.wins += 1;
    if (Object.values(v.isBot || {}).some(Boolean)) s.botWins += 1;
  }
  const myScore = v.scores[myId] || 0;
  if (myScore > s.bestScore) s.bestScore = myScore;
  try { localStorage.setItem('domino_stats', JSON.stringify(s)); } catch { /* no storage */ }
  renderHomeStats();
}
function renderHomeStats() {
  const el = $('homeStats');
  if (!el) return;
  const s = loadStats();
  el.textContent = s.matches
    ? `🏆 ${s.wins} فوز من ${s.matches} مباراة · أعلى سكور ${s.bestScore}${s.botWins ? ` · ${s.botWins} ضد البوت` : ''}`
    : '';
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
    $('matchWinner').textContent = view.matchWinnerId === myId ? 'أنت' : (view.names[view.matchWinnerId] || 'الفائز');
    const st = $('matchStandings');
    st.innerHTML = '';
    [...view.players].sort((a, b) => view.scores[b] - view.scores[a]).forEach((pid, i) => {
      const row = document.createElement('div');
      row.className = 'bd-row' + (i === 0 ? ' winner' : '');
      row.innerHTML = `<span>${['🥇', '🥈', '🥉', '4.'][i]} ${esc(view.names[pid] || 'لاعب')}</span><span>${view.scores[pid]} نقطة</span>`;
      st.appendChild(row);
    });
    const rmVotes = view.rematchVotes;
    const rmBtn = $('btnRematch');
    rmBtn.classList.toggle('hidden', !isHost);
    if (isHost && rmVotes?.count) rmBtn.textContent = `مباراة جديدة (${rmVotes.count}/${rmVotes.humans} يطلبوا)`;
    else rmBtn.textContent = 'مباراة جديدة';
    const rmVoteBtn = $('btnRematchVote');
    rmVoteBtn.classList.toggle('hidden', isHost);
    if (!isHost) {
      const already = rmVotes?.count ? ' ✓ تم الإرسال' : '';
      rmVoteBtn.textContent = `أطلب مباراة جديدة${rmVotes?.count ? ` (${rmVotes.count}/${rmVotes.humans})` : ''}${already}`;
      rmVoteBtn.disabled = !!rmVotes?.count;
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
  if (!moves.length || moves[0].end === null) return; // lead move has no drop target
  tileDrag = { tile, el, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, over: null };
  try { el.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
}
function moveTileDrag(e) {
  if (!tileDrag) return;
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

function initGameUI() {
  $('btnDraw').onclick = () => { socket.emit('game:draw'); sfx.click(); };
  $('btnPass').onclick = () => { socket.emit('game:pass'); sfx.click(); };
  $('btnNextHand').onclick = () => socket.emit('game:nextHand');
  $('btnRematch').onclick = () => socket.emit('game:rematch');
  $('btnNextHandVote').onclick = () => { socket.emit('game:nextHandVote'); sfx.click(); };
  $('btnRematchVote').onclick = () => { socket.emit('game:rematchVote'); sfx.click(); };
  $('btnChat').onclick = (e) => {
    e.stopPropagation();
    chatOpen ? closeChat() : openChat();
  };
  $('btnMic').onclick = (e) => {
    e.stopPropagation();
    toggleMic();
  };
  bindPttHold($('btnMic'));
  $('chatClose').onclick = (e) => {
    e.stopPropagation();
    closeChat();
  };
  $('btnVoice').onclick = (e) => {
    e.stopPropagation();
    voicePanelOpen ? closeVoicePanel() : openVoicePanel();
  };
  $('voiceClose').onclick = (e) => {
    e.stopPropagation();
    closeVoicePanel();
  };
  $('btnVoiceSelfMute').onclick = () => toggleMic();
  $('btnVoiceLeave').onclick = () => {
    voice?.leave();
    closeVoicePanel();
    sfx.micOff();
  };
  // host-only: mute (or unmute) everyone except the host, server-enforced
  $('btnVoiceMuteAll').onclick = async () => {
    const btn = $('btnVoiceMuteAll');
    if (!voice) return;
    const anyHostMuted = voicePeers.some(p => p.hostMuted);
    btn.disabled = true;
    sfx.click();
    try {
      const res = await voice.hostMute({ all: true, muted: !anyHostMuted });
      if (res && !res.ok) showVoiceError(res.error);
    } finally { btn.disabled = false; }
  };
  document.addEventListener('click', (e) => {
    if (chatOpen && !$('chatDrawer').contains(e.target) && !$('btnChat').contains(e.target)) {
      closeChat();
    } else if (emojiPopOpen && !$('emojiPop').contains(e.target) && !$('btnEmoji').contains(e.target)) {
      closeEmojiPop();
    } else if (voicePanelOpen && !$('voicePanel').contains(e.target) && !$('btnVoice').contains(e.target)) {
      closeVoicePanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('modalLeave').classList.contains('hidden')) {
        sfx.click();
        closeLeaveConfirm();
      } else if (emojiPopOpen) {
        closeEmojiPop();
      } else if (voicePanelOpen) {
        closeVoicePanel();
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
  $('btnExit').onclick = () => { sfx.click(); openLeaveConfirm(); };
  $('btnLeaveCancel').onclick = () => { sfx.click(); closeLeaveConfirm(); };
  $('btnLeaveConfirm').onclick = leaveRoom;
  $('modalLeave').addEventListener('click', (e) => {
    if (e.target === $('modalLeave')) { sfx.click(); closeLeaveConfirm(); }
  });
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(ev => {
    document.addEventListener(ev, updateFullscreenState);
  });
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

// ══════════ voice chat ══════════
// Mic FAB cycles off → on → muted → on. The headset FAB opens a panel with
// per-player controls: anyone can locally mute or set the volume of anyone
// else, without affecting the rest of the room.

// shared voice error routing: game → turn banner, lobby → lobbyError, else home
function showVoiceError(msg) {
  if (!msg) return;
  if ($('screen-game').classList.contains('active')) setBanner('⚠ ' + msg, '');
  else if ($('screen-lobby').classList.contains('active')) lobbyError(msg);
  else homeError(msg);
}

// neutral transient hint (voice info, e.g. "reconnecting voice") — small toast
// beside the mic FAB stack so it never clobbers the turn banner
let voiceInfoTimer = null;
function showVoiceInfo(msg) {
  if (!msg) return;
  document.querySelectorAll('.vp-info').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'vp-info';
  el.textContent = '🎙 ' + msg;
  document.body.appendChild(el);
  clearTimeout(voiceInfoTimer);
  voiceInfoTimer = setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 350);
  }, 3000);
}

function initVoice() {
  voice = new VoiceChat(socket, {
    onSelf: (s) => { voiceSelf = s; updateMicUI(); renderVoicePanel(); },
    onPeers: (list) => {
      voicePeers = list;
      for (const p of list) {
        if (p.speaking) speakingSet.add(p.id); else speakingSet.delete(p.id);
      }
      updateMicUI();
      renderVoicePanel();
      markSpeakingRows();
    },
    onSpeaking: (pid, on) => {
      if (!pid) return;
      if (on) speakingSet.add(pid); else speakingSet.delete(pid);
      markSpeakingRows();
      updateMicUI();
    },
    onError: (msg) => showVoiceError(msg),
    onInfo: (msg) => showVoiceInfo(msg),
  });
  if (myId) voice.setSelf(myId);
  try { voice.setPtt(localStorage.getItem('domino_ptt') === '1'); } catch { /* no storage */ }
}

async function toggleMic() {
  if (!voice || !voice.supported) return;
  if (!voiceSelf.joined) {
    sfx.click();
    const res = await voice.join();
    if (res?.ok) sfx.micOn();
    else {
      // join failed — force the buttons back to .off even if voice.js
      // didn't broadcast an idle onSelf after the error
      voiceSelf = { ...voiceSelf, joined: false, status: 'idle' };
      updateMicUI();
    }
  } else if (!voice.ptt) {
    // in push-to-talk mode the mic button is a hold key — no toggle on tap
    voice.toggleMute();
    voiceSelf.muted ? sfx.micOff() : sfx.micOn();
  }
}

// hold-to-talk wiring: while PTT is on, holding a mic button opens the mic
function bindPttHold(el) {
  if (!el) return;
  const down = (e) => {
    if (!voice?.ptt || !voiceSelf.joined) return; // tap path joins/toggles normally
    e.preventDefault();
    voice.setTalking(true);
    updateMicUI();
  };
  const up = () => {
    if (!voice?.ptt) return;
    voice.setTalking(false);
    updateMicUI();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}

function updateMicUI() {
  const waiting = voiceSelf.status === 'requesting' || voiceSelf.status === 'connecting';
  const hostMuted = !!voiceSelf.hostMuted;
  const muted = !!voiceSelf.muted || hostMuted;
  const waitTitle = voiceSelf.status === 'connecting' ? 'بنوصل بالصوت…' : 'بنطلب إذن المايك…';
  const btn = $('btnMic');
  if (btn && !voiceUnsupported) {
    btn.classList.toggle('waiting', waiting);
    btn.classList.toggle('off', !voiceSelf.joined && !waiting);
    btn.classList.toggle('on', voiceSelf.joined && !muted);
    btn.classList.toggle('muted', voiceSelf.joined && muted);
    btn.classList.toggle('talking', voiceSelf.joined && !muted && voiceSelf.speaking);
    btn.title = waiting ? waitTitle
      : voiceSelf.joined && hostMuted ? 'المضيف كتّمك'
      : !voiceSelf.joined ? 'فتح المايك'
      : voice.ptt ? 'اضغط واستمر بالضغط للكلام'
      : muted ? 'فك كتم المايك' : 'كتم المايك';
    btn.setAttribute('aria-label', btn.title);
  }
  const lb = $('btnLobbyMic');
  if (lb && !voiceUnsupported) {
    lb.classList.toggle('waiting', waiting);
    lb.classList.toggle('active', voiceSelf.joined && !muted);
    lb.classList.toggle('muted', voiceSelf.joined && muted);
    lb.textContent = waiting ? (voiceSelf.status === 'connecting' ? '🎤 بنوصل بالصوت…' : '🎤 بنطلب إذن المايك…')
      : !voiceSelf.joined ? '🎤 فتح المايك'
      : hostMuted ? '🔇 المضيف كتّمك'
      : voice.ptt ? '🖐 اضغط واستمر للكلام'
      : muted ? '🔇 المايك مكتوم — اضغط للكلام' : '🎙 المايك شغال — اضغط للكتم';
    const lbTitle = waiting ? waitTitle : (voiceSelf.joined && hostMuted ? 'المضيف كتّمك' : '');
    if (lbTitle) lb.title = lbTitle;
    else lb.removeAttribute('title');
  }
  const badge = $('voiceBadge');
  if (badge) {
    const n = voicePeers.length + (voiceSelf.joined ? 1 : 0);
    badge.textContent = String(n);
    badge.classList.toggle('hidden', !n);
  }
}

function openVoicePanel() {
  voicePanelOpen = true;
  $('voicePanel')?.classList.remove('hidden');
  renderVoicePanel();
  sfx.click();
}

function closeVoicePanel() {
  voicePanelOpen = false;
  $('voicePanel')?.classList.add('hidden');
}

function renderVoicePanel() {
  const list = $('voiceList');
  if (!list || !voice) return;
  list.innerHTML = '';

  // push-to-talk mode toggle (persisted in localStorage)
  const pttRow = document.createElement('div');
  pttRow.className = 'vp-ptt-row';
  const pttBtn = document.createElement('button');
  pttBtn.className = 'vp-ptt' + (voice.ptt ? ' on' : '');
  pttBtn.title = voice.ptt ? 'اضغط على زرار المايك واستمر ضاغط عشان تتكلم' : 'شغّل الوضع ده عشان المايك يفتح وأنت ضاغط بس';
  pttBtn.textContent = voice.ptt ? '🖐 اضغط وكلم: مفعّل' : '🖐 اضغط وكلم: مقفول';
  pttBtn.setAttribute('aria-pressed', String(!!voice.ptt));
  pttBtn.onclick = () => {
    const on = !voice.ptt;
    voice.setPtt(on);
    try { localStorage.setItem('domino_ptt', on ? '1' : '0'); } catch {}
    updateMicUI();
    renderVoicePanel();
    sfx.click();
  };
  pttRow.appendChild(pttBtn);
  list.appendChild(pttRow);

  if (!voiceSelf.joined && !voicePeers.length) {
    const empty = document.createElement('div');
    empty.className = 'vp-empty';
    empty.textContent = 'لسه محدش فاتح المايك. دوس زرار المايك وابدأ الكلام 🎙';
    list.appendChild(empty);
  }

  if (voiceSelf.joined) {
    const hostMuted = !!voiceSelf.hostMuted;
    const muted = !!voiceSelf.muted || hostMuted;
    const row = document.createElement('div');
    row.className = 'vp-row me' + (voiceSelf.speaking && !muted ? ' speaking' : '');
    row.innerHTML = `
      <span class="vp-dot" aria-hidden="true"></span>
      <span class="vp-name">${esc(myName || 'أنت')} <span class="vp-you">(أنت)</span></span>
      <span class="vp-state">${hostMuted ? 'مكتوم من المضيف' : muted ? 'مكتوم' : voiceSelf.speaking ? 'بتتكلم' : ''}</span>`;
    list.appendChild(row);
  }

  for (const p of voicePeers) {
    const row = document.createElement('div');
    row.className = 'vp-row' + (p.speaking ? ' speaking' : '');
    row.dataset.pid = p.id;

    const dot = document.createElement('span');
    dot.className = 'vp-dot' + (p.conn === 'connected' ? ' connected'
      : p.conn === 'connecting' ? ' connecting'
      : p.conn === 'failed' ? ' failed' : '');
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'vp-name';
    name.textContent = p.name;
    row.appendChild(name);

    // hostMuted takes precedence over self-mute; empty while live & unmuted
    const st = document.createElement('span');
    st.className = 'vp-state';
    st.textContent = p.hostMuted ? 'مكتوم من المضيف'
      : p.muted ? 'مكتوم نفسه'
      : p.speaking ? 'بتتكلم' : '';
    row.appendChild(st);

    const muteBtn = document.createElement('button');
    muteBtn.className = 'vp-mute' + (p.mutedLocal ? ' muted' : '');
    muteBtn.title = p.mutedLocal ? 'فك الكتم عنه' : 'اكتموا عندي بس';
    muteBtn.setAttribute('aria-label', muteBtn.title);
    muteBtn.innerHTML = p.mutedLocal
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
    muteBtn.onclick = () => { voice.setPeerMuted(p.id, !p.mutedLocal); sfx.click(); };
    row.appendChild(muteBtn);

    // host-only: mute this player for EVERYONE (server-enforced)
    if (isHost) {
      const hm = document.createElement('button');
      hm.className = 'vp-hostmute' + (p.hostMuted ? ' muted' : '');
      hm.title = p.hostMuted ? 'فك الكتم عنه (للجميع)' : 'كتمه عن الجميع';
      hm.setAttribute('aria-label', hm.title);
      hm.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
      hm.onclick = async () => {
        hm.disabled = true;
        try {
          const res = await voice.hostMute({ pid: p.id, muted: !p.hostMuted });
          if (res && !res.ok) showVoiceError(res.error);
        } finally { hm.disabled = false; }
      };
      row.appendChild(hm);
    }

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'vp-vol';
    vol.min = '0'; vol.max = '100';
    vol.value = String(Math.round((p.volume ?? 1) * 100));
    vol.title = 'صوت ' + p.name;
    vol.setAttribute('aria-label', vol.title);
    vol.oninput = () => voice.setPeerVolume(p.id, Number(vol.value) / 100);
    row.appendChild(vol);

    list.appendChild(row);
  }

  const selfMuteBtn = $('btnVoiceSelfMute');
  if (selfMuteBtn) {
    selfMuteBtn.disabled = !voiceSelf.joined || !!voiceSelf.hostMuted;
    selfMuteBtn.textContent = voiceSelf.hostMuted ? 'المضيف كتّمك'
      : voiceSelf.muted ? 'فك كتم نفسي' : 'كتم نفسي';
  }
  // host-only mute-all toggle in the panel header
  const muteAll = $('btnVoiceMuteAll');
  if (muteAll) {
    muteAll.classList.toggle('hidden', !(isHost && voiceSelf.joined));
    const anyHostMuted = voicePeers.some(p => p.hostMuted);
    muteAll.textContent = anyHostMuted ? 'فك الكل' : 'كتم الكل';
    muteAll.title = anyHostMuted ? 'فك الكتم عن الجميع (ما عداك)' : 'كتم الجميع (ما عداك)';
  }
  const sub = $('voiceSub');
  if (sub) {
    const n = voicePeers.length + (voiceSelf.joined ? 1 : 0);
    sub.textContent = n ? `${n} في المكالمة` : 'المكالمة داخل الغرفة دي بس';
  }
}

// light up speaking players on the scoreboard + voice panel
function markSpeakingRows() {
  const card = $('scoreCard');
  if (card && view) {
    card.querySelectorAll('.sc-row').forEach((row, i) => {
      const ranked = [...view.players].sort((a, b) => (view.scores[b] || 0) - (view.scores[a] || 0));
      row.classList.toggle('speaking', speakingSet.has(ranked[i]));
    });
  }
  $('voiceList')?.querySelectorAll('.vp-row[data-pid]').forEach(row => {
    const pid = row.dataset.pid;
    row.classList.toggle('speaking', speakingSet.has(pid));
    // keep the row's state text in sync between roster re-renders
    const p = voicePeers.find(x => x.id === pid);
    const st = row.querySelector('.vp-state');
    if (p && st) {
      st.textContent = p.hostMuted ? 'مكتوم من المضيف'
        : p.muted ? 'مكتوم نفسه'
        : speakingSet.has(pid) ? 'بتتكلم' : '';
    }
  });
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

// mic unavailable (unsupported browser / insecure context): disable the mic
// buttons with an explanation but never block the rest of the UI
function applyVoiceSupport() {
  voiceUnsupported = !!(voice && (!voice.supported || !voice.secure));
  if (!voiceUnsupported) return;
  const msg = 'المايك مش متاح هنا — افتح اللعبة في كروم أو إيدج بدل المتصفح جوه التطبيقات.';
  for (const id of ['btnMic', 'btnLobbyMic']) {
    const b = $(id);
    if (!b) continue;
    b.disabled = true;
    b.classList.add('off');
    b.title = msg;
    b.setAttribute('aria-label', msg);
  }
  const lb = $('btnLobbyMic');
  if (lb) lb.textContent = '🎤 المايك مش متاح';
}

// ══════════ boot ══════════
// Web mode: same-origin (browser / Cloudflare Tunnel) — today's behaviour, untouched.
// APK mode: every phone runs its own game server; the launcher discovers nearby
// phones and the app shows them as a tap-to-join list (startAppNet below).
const IN_APP = typeof window.Capacitor !== 'undefined';
const STATUS_URL = 'http://127.0.0.1:3001';

function isLanUrl(u) {
  try { return /^(192\.168\.|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(u).hostname); }
  catch { return false; }
}

function startSocket(base) {
  socket = io(base || undefined, { transports: ['websocket', 'polling'] });
  if (base && isLanUrl(base)) {
    // Offline LAN: peers share a subnet, so plain host candidates connect — the
    // internet STUN/TURN relays are unreachable and would only add timeouts.
    setIceConfig({ iceServers: [] });
  }
  initVoice();
  applyVoiceSupport();

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
          // was in voice before the drop? announce again — the mesh rebuilds
          if (voiceSelf.joined) voice.rejoin();
          showScreen(res.state === 'playing' ? 'game' : 'lobby');
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
    clockOffset = st.serverNow ? st.serverNow - Date.now() : 0;
    view = st; isHost = st.hostId === myId; renderGame();
  });
  socket.on('chat:msg', onChatMsg);
  socket.on('lobby:closed', () => {
    // the server swept this idle lobby — back home with a note
    leaveRoom();
    homeError('اتقفلت الغرفة بسبب الخمول الطويل.');
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
  setInterval(updateTurnTimer, 200);
}

boot();
