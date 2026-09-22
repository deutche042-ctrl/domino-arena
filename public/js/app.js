// js/app.js — Domino Arena client: screens, net, hand UI, chat, modals
import { Board3D } from './board3d.js?v=15';
import { Home3D } from './home3d.js?v=2';
import { tileImage } from './tiles.js?v=11';
import { sfx } from './sfx.js?v=14';
import { VoiceChat } from './voice.js?v=2';

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
    const cur = $('btnReady').textContent === 'لست جاهزاً';
    socket.emit('lobby:ready', { ready: !cur });
    sfx.click();
  };
  $('btnStart').onclick = () => emit('game:start').then(res => {
    if (res && !res.ok) lobbyError(res.error);
  });
  $('btnLeave').onclick = leaveRoom;
  $('btnLobbyMic').onclick = () => toggleMic();
  for (const id of ['selVariant', 'selTarget', 'selMax']) {
    $(id).onchange = () => emit('lobby:config', {
      variant: $('selVariant').value,
      targetScore: +$('selTarget').value,
      maxPlayers: +$('selMax').value,
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
  prevHand = [...(view.hand || [])];
}

function renderOpponents() {
  const wrap = $('opponents');
  if (wrap) wrap.innerHTML = '';
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
    el.onclick = () => onTileClick(t, el);
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
    $('btnNextHand').classList.toggle('hidden', !isHost);
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
    $('btnRematch').classList.toggle('hidden', !isHost);
    $('matchWait').classList.toggle('hidden', isHost);
    matchModal.classList.remove('hidden');
    startConfetti();
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
  if (view.status === 'playing' && view.turn === myId && !wasMyTurn) sfx.yourTurn();
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
  board.showMarkers(uniqueEnds);
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

function onBoardMiss() {
  // Do not deselect on accidental miss so touch users aren't frustrated
}

function initGameUI() {
  $('btnDraw').onclick = () => { socket.emit('game:draw'); sfx.click(); };
  $('btnPass').onclick = () => { socket.emit('game:pass'); sfx.click(); };
  $('btnNextHand').onclick = () => socket.emit('game:nextHand');
  $('btnRematch').onclick = () => socket.emit('game:rematch');
  $('btnChat').onclick = (e) => {
    e.stopPropagation();
    chatOpen ? closeChat() : openChat();
  };
  $('btnMic').onclick = (e) => {
    e.stopPropagation();
    toggleMic();
  };
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
  } else {
    voice.toggleMute();
    voiceSelf.muted ? sfx.micOff() : sfx.micOn();
  }
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
  if (!list) return;
  list.innerHTML = '';

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
      <span class="vp-state">${hostMuted ? 'مكتوم من المضيف' : muted ? 'مكتوم' : 'بتتكلم'}</span>`;
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
function boot() {
  socket = io({ transports: ['websocket', 'polling'] });
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
  socket.on('error', (e) => {
    setBanner('⚠ ' + (e.message || 'خطأ'), '');
  });

  initHome(); initLobby(); initGameUI();
  setInterval(updateTurnTimer, 200);
}

boot();
