// js/app.js — Domino Arena client: screens, net, hand UI, chat, modals
import { Board3D } from './board3d.js?v=11';
import { tileImage } from './tiles.js?v=11';
import { sfx } from './sfx.js?v=11';

const $ = id => document.getElementById(id);
const VARIANT_DESC = {
  block: 'عادي (Block): بدون سحب — لا تملك حركة متطابقة؟ تمرير (باص). الفائز بالجولة يكسب مجموع نقاط كروت الخصوم المتبقية.',
  draw: 'سحب (Draw): عند عدم امتلاك كارت متطابق، تسحب من السحابة حتى تجد كارت يمكن لعبه. نفس قواعد احتساب النقاط.',
  allfives: 'مضاعفات الخمسة (خمسات): إذا كان مجموع أطراف السلسلة يقبل القسمة على 5 تكسب نقاط فورية. أول دبل يصبح سنتر يفتح 4 اتجاهات!',
};

// ── state ──
let socket, myId, myToken, roomCode, isHost = false, lastLobbyState = null;
let view = null;
let prevHand = [];
let newlyDrawnTileId = null;
let selectedTile = null;
let board = null;
let lastActionKey = '';
let chatOpen = false, unread = 0;

// ══════════ screens ══════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
  if (name === 'game' && !board) {
    board = new Board3D($('table3d'), { onMarkerClick, onBoardMiss, onBoneyardClick: onBoneyardDraw });
  }
  if (name === 'game') setTimeout(() => board?.resize(), 50);
}

// ══════════ home & lobby effects ══════════
function spawnFallingTiles(containerId) {
  const hero = $(containerId);
  if (!hero) return;
  hero.innerHTML = '';
  for (let i = 0; i < 22; i++) {
    const img = document.createElement('img');
    img.src = tileImage(Math.floor(Math.random() * 7), Math.floor(Math.random() * 7));
    img.className = 'fall';
    img.style.left = Math.random() * 96 + 'vw';
    img.style.width = 42 + Math.random() * 32 + 'px';
    img.style.animationDuration = 7 + Math.random() * 8 + 's';
    img.style.animationDelay = -Math.random() * 15 + 's';
    hero.appendChild(img);
  }
}

function initHome() {
  spawnFallingTiles('heroTiles');
  spawnFallingTiles('lobbyHeroTiles');
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
  myId = res.playerId; myToken = res.token; roomCode = res.code;
  sessionStorage.setItem('domino_token_' + roomCode, myToken);
  localStorage.setItem('domino_token_' + roomCode, myToken);
  localStorage.setItem('domino_last_code', roomCode);
  history.replaceState(null, '', '?room=' + roomCode);
  $('lobbyCode').textContent = roomCode;
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
  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of (st.players || [])) {
    const li = document.createElement('li');
    if (p.id === myId) li.className = 'me';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = p.name + (p.id === st.hostId ? ' 👑' : '');
    const tag = document.createElement('span');
    tag.className = 'status' + (p.ready ? ' ready' : '');
    tag.textContent = p.id === st.hostId ? 'المضيف' : (p.ready ? 'جاهز' : 'في الانتظار');
    li.appendChild(nameSpan);
    li.appendChild(tag);
    list.appendChild(li);
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
  for (const id of ['selVariant', 'selTarget', 'selMax']) {
    $(id).onchange = () => emit('lobby:config', {
      variant: $('selVariant').value,
      targetScore: +$('selTarget').value,
      maxPlayers: +$('selMax').value,
    });
  }
}
function lobbyError(msg) { $('lobbyError').textContent = msg || ''; }

// ══════════ game rendering ══════════
function renderGame() {
  if (!view) return;
  board?.sync(view);
  board?.setCanDraw(view.turn === myId && view.status === 'playing' && view.canDraw);
  renderScoreboard();
  renderOpponents();
  renderHand();
  renderActions();
  renderTurnBanner();
  renderModals();
  playActionSounds();
  prevHand = [...(view.hand || [])];
}

function renderScoreboard() {
  const sb = $('scoreboard');
  sb.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'sb-header';
  header.innerHTML = `
    <span class="sb-title"><i class="sb-ico">🏆</i> النتائج</span>
    <span class="sb-target">الهدف: <b>${view.targetScore}</b></span>
  `;
  sb.appendChild(header);

  const list = document.createElement('div');
  list.className = 'sb-list';

  for (const pid of view.players) {
    const isMe = pid === myId;
    const isTurn = pid === view.turn && view.status === 'playing';
    const score = view.scores[pid] || 0;
    const pct = Math.min(100, (score / view.targetScore) * 100);
    const name = view.names[pid] || 'لاعب';
    const initial = (name.trim()[0] || '؟').toUpperCase();
    const count = view.handCounts?.[pid] ?? 0;

    const row = document.createElement('div');
    row.className = 'sb-row' + (isMe ? ' me' : '') + (isTurn ? ' turn' : '');
    row.innerHTML = `
      <div class="sb-left">
        <div class="sb-avatar ${isTurn ? 'active' : ''}">${initial}</div>
        <div class="sb-user-meta">
          <div class="sb-name-line">
            <span class="sb-name" title="${esc(name)}">${esc(name)}</span>
            ${isMe ? '<span class="sb-you-pill">أنت</span>' : `<span class="sb-tile-badge" title="${count} كروت">🁢 ${count}</span>`}
            ${isTurn ? '<span class="sb-turn-badge">دوره</span>' : ''}
          </div>
          <div class="sb-progress-bar">
            <div class="sb-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      </div>
      <div class="sb-right">
        <span class="sb-pts">${score}</span>
        <span class="sb-pts-sub">نقطة</span>
      </div>
    `;
    list.appendChild(row);
  }
  sb.appendChild(list);
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

function renderTurnBanner() {
  const b = $('turnBanner');
  if (view.status !== 'playing') { b.textContent = ''; b.className = ''; return; }
  if (view.turn === myId) {
    if (view.leadForcedTile) {
      b.textContent = 'دورك — العب الكارت المحدد للبداية';
    } else if (view.moves.length === 0) {
      b.textContent = 'دورك — اختر أي كارت لبدء اللعبة';
    } else if (view.canDraw) {
      b.textContent = 'دورك — اسحب كارت من الطاولة بالنقر عليه';
    } else if (view.canPass) {
      b.textContent = 'دورك — لا يوجد لعب متاح، اضغط تمرير (باص)';
    } else {
      b.textContent = 'دورك الآن';
    }
    b.className = 'mine';
  } else {
    b.textContent = `دور ${view.names[view.turn] || 'اللاعب'}`;
    b.className = '';
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
  if (uniqueEnds.length === 1) {
    $('turnBanner').textContent = 'اضغط على النقطة الخضراء أو على الكارت مجدداً لتأكيد اللعب!';
    $('turnBanner').className = 'mine';
  } else {
    $('turnBanner').textContent = 'اختر النقطة الخضراء للطرف الذي تريد اللعب عليه!';
    $('turnBanner').className = 'mine';
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
    chatOpen = !chatOpen;
    $('chatDrawer').classList.toggle('hidden', !chatOpen);
    if (chatOpen) {
      unread = 0;
      updateBadge();
      setTimeout(() => $('chatInput')?.focus(), 100);
    }
  };
  $('chatClose').onclick = () => {
    chatOpen = false;
    $('chatDrawer').classList.add('hidden');
  };
  document.addEventListener('click', (e) => {
    if (chatOpen && !$('chatDrawer').contains(e.target) && !$('btnChat').contains(e.target)) {
      chatOpen = false;
      $('chatDrawer').classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chatOpen) {
      chatOpen = false;
      $('chatDrawer').classList.add('hidden');
    }
  });
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  const btnFs = $('btnFullscreen');
  if (btnFs) {
    btnFs.onclick = toggleFullscreen;
  }
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(ev => {
    document.addEventListener(ev, updateFullscreenState);
  });
  document.querySelectorAll('#emojiBar button').forEach(b => {
    b.onclick = () => {
      socket.emit('chat:send', { emoji: b.textContent.trim() });
      sfx.click();
    };
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
}

function showChatToast(msg) {
  const container = $('chatToasts');
  if (!container) return;

  // Maximum 3 visible toasts to prevent spam from covering the screen
  while (container.children.length >= 3) {
    container.firstChild.remove();
  }

  const isMine = (msg.pid && msg.pid === myId) || msg.from === myName;
  const initial = (msg.from ? msg.from.trim()[0] : '؟').toUpperCase();
  const toast = document.createElement('div');
  toast.className = 'chat-toast' + (isMine ? ' mine' : ' other');

  if (msg.emoji) {
    toast.innerHTML = `
      <div class="toast-avatar">${initial}</div>
      <div class="toast-body">
        <div class="toast-sender">${isMine ? 'أنت' : esc(msg.from)}</div>
        <div class="toast-emoji-content">${esc(msg.emoji)}</div>
      </div>
    `;
  } else {
    toast.innerHTML = `
      <div class="toast-avatar">${initial}</div>
      <div class="toast-body">
        <div class="toast-sender">${isMine ? 'أنت' : esc(msg.from)}</div>
        <div class="toast-text-content">${esc(msg.text)}</div>
      </div>
    `;
  }

  container.appendChild(toast);

  // Stays floating for 5 seconds as requested!
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

function onChatMsg(msg) {
  // 1. Show floating speech toast for 5 seconds on table
  showChatToast(msg);

  // 2. Append to chat drawer history
  const box = $('chatMsgs');
  if (box) {
    const isMine = (msg.pid && msg.pid === myId) || msg.from === myName;
    const timeStr = new Date(msg.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-bubble-wrap' + (isMine ? ' mine' : ' other');

    if (msg.emoji) {
      msgEl.innerHTML = `
        <div class="bubble-meta">${isMine ? 'أنت' : esc(msg.from)} · ${timeStr}</div>
        <div class="bubble-content emoji-only">${esc(msg.emoji)}</div>
      `;
    } else {
      msgEl.innerHTML = `
        <div class="bubble-meta">${isMine ? 'أنت' : esc(msg.from)} · ${timeStr}</div>
        <div class="bubble-content">${esc(msg.text)}</div>
      `;
    }
    box.appendChild(msgEl);
    box.scrollTop = box.scrollHeight;
  }

  // 3. Update unread badge on fab if drawer is closed
  if (!chatOpen) {
    unread++;
    updateBadge();
  }
}

function updateBadge() {
  const fab = $('btnChat');
  if (!fab) return;
  fab.innerHTML = '<span class="fab-icon">💬</span>' + (unread ? `<span class="badge">${unread > 9 ? '9+' : unread}</span>` : '');
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

// ══════════ boot ══════════
function boot() {
  socket = io({ transports: ['websocket', 'polling'] });

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
        }
      });
    }
  });
  socket.on('disconnect', () => { $('connPill').className = 'bad'; });
  socket.on('lobby:state', renderLobby);
  socket.on('game:started', () => { showScreen('game'); sfx.start(); });
  socket.on('game:state', (st) => { view = st; isHost = st.hostId === myId; renderGame(); });
  socket.on('chat:msg', onChatMsg);
  socket.on('error', (e) => {
    const b = $('turnBanner');
    b.textContent = '⚠ ' + (e.message || 'خطأ');
    b.className = '';
  });

  initHome(); initLobby(); initGameUI();
}

boot();
