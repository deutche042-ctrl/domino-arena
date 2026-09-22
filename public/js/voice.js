// js/voice.js — WebRTC mesh voice chat, v2.
//
// Architecture:
// - Signaling rides the game's Socket.IO connection (`voice:signal` is relayed
//   by the server); the audio itself is a full peer-to-peer mesh — at 2-4
//   players everyone connects directly to everyone, no SFU needed.
// - NAT traversal: Google STUN plus the OpenRelay public TURN relay (all three
//   url variants: udp:80, udp:443, tcp:443). TURN is the part that actually
//   makes cross-network calls work behind carrier-grade NAT (common on
//   Egyptian mobile networks), where STUN alone fails silently.
// - Negotiation uses the "perfect negotiation" pattern (polite/impolite
//   decided by player-id order) so both sides can create offers independently
//   without glare — nobody needs to know who joined first. When a peer's
//   connection fails we attempt ONE automatic ICE restart, then ONE rebuild
//   after a grace period — never an endless rebuild loop.
// - The server owns the roster (`voice:state`): who is in voice, who is
//   muted, who is host-muted. We mirror it. Host mute is enforced locally too:
//   while host-muted the local tracks stay disabled and un-muting is blocked.
// - Rosters that arrive before `setSelf()` are buffered and replayed once the
//   own player id is known — we never create a peer to ourselves.
// - Remote streams land in hidden <audio autoplay> elements; per-player local
//   mute/volume is element state kept in `prefs` so it survives re-joins.
// - Speaking detection: one shared AudioContext, an AnalyserNode per stream
//   (remote + own mic), polled for RMS with hysteresis → onSpeaking callbacks.
//   Suppressed while effectively muted (self mute or host mute).

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    {
      // Public TURN relay — the single most important piece for CGNAT traversal.
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

const SPEAK_ON = 0.035;          // RMS threshold to light up
const SPEAK_OFF = 0.02;          // lower threshold to go dark (hysteresis)
const POLL_MS = 180;             // speaking-detection poll interval
const JOIN_ACK_TIMEOUT = 5000;   // how long to wait for the voice:join ack
const RECOVERY_DELAY = 4000;     // grace period before rebuilding a failed peer

const sameId = (a, b) => String(a) === String(b);

export class VoiceChat {
  /**
   * @param socket  the game socket.io client.
   *   In:  `voice:state` (roster), `voice:signal` ({ from, data }).
   *   Out: `voice:join` (ack), `voice:leave`, `voice:mute` { muted },
   *        `voice:hostMute` (ack), `voice:signal` { to, data }.
   * @param hooks   optional callbacks (all invoked with ?.)
   *   onSelf(state)  -> { joined, muted, hostMuted, speaking, status }
   *                     status: 'idle' | 'requesting' | 'connecting' | 'live'
   *   onPeers(list)  -> [{ id, name, muted, hostMuted, speaking, mutedLocal,
   *                       volume, conn, me:false }]
   *                     conn: 'connecting' | 'connected' | 'failed' | 'closed'
   *   onSpeaking(pid, on)
   *   onError(msg)   -> Arabic, fatal-ish (mic denied, unsupported, join failed)
   *   onInfo(msg)    -> Arabic, transient hint (reconnecting, ICE retry, host mute)
   */
  constructor(socket, hooks = {}) {
    this.socket = socket;
    this.hooks = hooks;

    this.myId = null;
    this.pendingRoster = null;   // voice:state seen before setSelf() — replayed later

    this.joined = false;
    this._joinPromise = null;    // guards concurrent join()/rejoin()
    this._abortJoin = false;     // set by leave() while a join is in flight
    this.status = 'idle';        // 'idle' | 'requesting' | 'connecting' | 'live'

    this._muted = false;         // self mute
    this._hostMuted = false;     // server-enforced host mute
    this.stream = null;          // local mic MediaStream

    this.peers = new Map();      // pid -> peer record (see _createPeer)
    this.prefs = new Map();      // pid -> { volume, mutedLocal } — survives re-joins
    this.names = new Map();      // pid -> display name (from roster)
    this._rebuildTried = new Map(); // pid -> true; one rebuild per healthy connection
    this._lastRoster = [];       // latest roster — used for the solo-call check

    this.audioBox = null;        // hidden container for remote <audio> elements
    this.ac = null;              // shared AudioContext for speaking detection
    this.selfAnalyser = null;    // { analyser, buf } for the own mic
    this.selfSpeaking = false;
    this._pollTimer = null;

    socket.on('voice:state', (roster) => this._applyRoster(roster || []));
    socket.on('voice:signal', (msg) => { this._onSignal(msg); });
  }

  // ── public getters ──────────────────────────────────────────────────────

  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
  }

  get secure() {
    return !!window.isSecureContext;
  }

  get muted() { return this._muted; }

  get hostMuted() { return this._hostMuted; }

  // ── identity ────────────────────────────────────────────────────────────

  setSelf(pid) {
    this.myId = pid;
    // A roster may have arrived before we knew our own id — replay it now.
    if (this.pendingRoster) {
      const roster = this.pendingRoster;
      this.pendingRoster = null;
      this._applyRoster(roster);
    }
  }

  // ── join / leave ────────────────────────────────────────────────────────

  async join() {
    if (this.joined) return { ok: true };
    if (this._joinPromise) return this._joinPromise; // concurrent call shares the result
    this._joinPromise = this._doJoin(false);
    try {
      return await this._joinPromise;
    } finally {
      this._joinPromise = null;
    }
  }

  leave() {
    if (!this.joined && !this._joinPromise) return;
    const tellServer = this.joined || !!this._joinPromise; // ack may still be in flight
    if (this._joinPromise) this._abortJoin = true;         // cancel the in-flight join
    this.joined = false;
    if (tellServer) { try { this.socket.emit('voice:leave'); } catch {} }
    this._teardownPeers();
    this._stopStream();
    this._stopPoll();
    this._muted = false;
    this._hostMuted = false;
    this.selfSpeaking = false;
    this.status = 'idle';
    this._emitSelf();
    this.hooks.onPeers?.([]);
  }

  /** Re-announce after a socket reconnect (same player id, dead transports). */
  async rejoin() {
    if (this._joinPromise) { await this._joinPromise; return; } // join/rejoin already running
    if (!this.joined) return;
    this._joinPromise = this._doJoin(true);
    try {
      await this._joinPromise;
    } finally {
      this._joinPromise = null;
    }
  }

  /**
   * Shared body of join() (isRejoin=false) and rejoin() (isRejoin=true).
   * Never throws — always resolves to { ok, error? } with Arabic error strings.
   */
  async _doJoin(isRejoin) {
    if (!isRejoin) {
      if (!this.secure) {
        // getUserMedia is unavailable/blocked on insecure origins and in
        // embedded webviews — say so in a way a player can act on.
        const msg = 'افتح اللعبة في كروم العادي — مايك المتصفحات جوه التطبيقات بيبقى مقفول.';
        this.hooks.onError?.(msg);
        return { ok: false, error: msg };
      }
      if (!this.supported) {
        const msg = 'المتصفح ده مش بيدعم المايك — جرّب كروم أو إيدج.';
        this.hooks.onError?.(msg);
        return { ok: false, error: msg };
      }
      // Emit immediately so the UI can show a spinner while we ask for the mic.
      this.status = 'requesting';
      this._emitSelf();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        this.stream = null;
        this.status = 'idle';
        this._emitSelf();
        const msg = this._gumError(e);
        this.hooks.onError?.(msg);
        return { ok: false, error: msg };
      }
    } else {
      // Old PCs point at the dead transport — rebuild the mesh from the next roster.
      this._teardownPeers();
      this.hooks.onPeers?.([]);
      this.status = 'connecting';
      this._emitSelf();
      this.hooks.onInfo?.('الاتصال اتقطع — بنرجّع الصوت…');
    }

    if (this._abortJoin) { // user backed out while we were grabbing the mic
      this._abortJoin = false;
      if (!isRejoin) this._stopStream();
      this.status = 'idle';
      this._emitSelf();
      return { ok: false, error: 'تم إلغاء تشغيل المايك.' };
    }

    const res = await this._joinAck();

    if (this._abortJoin) { // user backed out while waiting for the ack
      this._abortJoin = false;
      if (res && res.ok) { try { this.socket.emit('voice:leave'); } catch {} } // might be joined server-side
      if (!isRejoin) this._stopStream();
      this.status = 'idle';
      this._emitSelf();
      return { ok: false, error: 'تم إلغاء تشغيل المايك.' };
    }

    if (!res || !res.ok) {
      // Server refused (or timed out) — drop everything voice-related.
      const msg = (res && res.error) ||
        (isRejoin ? 'الصوت اتقطع — شغّل المايك تاني.' : 'معلش — السيرفر رفض فتح المايك. جرّب تاني.');
      this.joined = false;
      this._teardownPeers();
      this._stopStream();
      this._stopPoll();
      this._hostMuted = false;
      this.selfSpeaking = false;
      this.status = 'idle';
      this._emitSelf();
      this.hooks.onPeers?.([]);
      this.hooks.onError?.(msg);
      return { ok: false, error: msg };
    }

    this.joined = true;
    if (!isRejoin) this._muted = false; // a fresh call starts unmuted
    this.status = 'connecting';
    this._applyTracks();       // re-assert track state (host mute wins over the flag)
    this._watchSelf();         // start/refresh own-mic speaking detection
    try { this.socket.emit('voice:mute', { muted: this._muted }); } catch {}
    this._maybeLive();         // solo call → live immediately
    this._emitSelf();
    return { ok: true };
  }

  /** Emit voice:join and wait for the ack, with a hard timeout. */
  _joinAck() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve(res);
      };
      const to = setTimeout(
        () => finish({ ok: false, error: 'السيرفر مش بيرد — جرّب تاني.' }),
        JOIN_ACK_TIMEOUT,
      );
      try {
        this.socket.emit('voice:join', {}, (res) => {
          if (res && res.ok === false && !res.error) {
            res.error = 'معلش — السيرفر رفض فتح المايك. جرّب تاني.';
          }
          finish(res || { ok: false, error: 'معلش — السيرفر رفض فتح المايك. جرّب تاني.' });
        });
      } catch (e) {
        finish({ ok: false, error: 'الاتصال بالسيرفر مقطوع — جرّب تاني.' });
      }
    });
  }

  /** Map a getUserMedia failure to a specific, actionable Egyptian-Arabic message. */
  _gumError(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return 'اتمنع إذن المايك — دوس على أيقونة القفل جنب عنوان الموقع واسمح بالمايك، وبعدين جرّب تاني.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'مفيش مايك متوصل — اتأكد إن المايك مربوط وشغال وجرّب تاني.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'المايك مشغول ببرنامج تاني (زي زووم أو ديسكورد) — اقفله وجرّب تاني.';
    }
    if (name === 'AbortError') {
      return 'حصل مشكلة وفتح المايك اتلغى — جرّب تاني.';
    }
    return 'حصل خطأ في المايك — جرّب تاني.';
  }

  // ── mute controls ───────────────────────────────────────────────────────

  toggleMute() {
    if (!this.joined) return;
    this.setMuted(!this._muted);
  }

  setMuted(m) {
    if (!this.joined) return;
    if (this._hostMuted) {
      // Host mute is server-enforced — flapping the local flag can't undo it.
      this.hooks.onError?.('المضيف كتّم المايك بتاعك — مش هينفع تفكه بنفسك.');
      return;
    }
    m = !!m;
    if (this._muted === m) return;
    this._muted = m;
    this._applyTracks();
    // Still announce it so the OTHER clients see us muted in their roster view.
    try { this.socket.emit('voice:mute', { muted: m }); } catch {}
    this._emitSelf();
  }

  // ── per-player listener controls (local only — never leaves this device) ──

  setPeerMuted(pid, m) {
    const pref = this._pref(pid);
    pref.mutedLocal = !!m;
    this.prefs.set(pid, pref);
    const key = this._peerKey(pid);
    const peer = key !== null ? this.peers.get(key) : null;
    if (peer && peer.audio) peer.audio.muted = pref.mutedLocal;
    this._emitPeers();
  }

  setPeerVolume(pid, v) {
    const pref = this._pref(pid);
    pref.volume = Math.max(0, Math.min(1, Number(v) || 0));
    this.prefs.set(pid, pref);
    const key = this._peerKey(pid);
    const peer = key !== null ? this.peers.get(key) : null;
    if (peer && peer.audio) peer.audio.volume = pref.volume;
    this._emitPeers();
  }

  /**
   * Host-only server-enforced mute. opts: { pid?, all?, muted } — `muted`
   * defaults to true (a mute action). Resolves with the server ack:
   * { ok } | { ok:false, error }.
   */
  hostMute(opts = {}) {
    const payload = { muted: opts.muted !== false };
    if (opts.all) payload.all = true;
    else if (opts.pid !== undefined && opts.pid !== null) payload.pid = opts.pid;
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve(res && typeof res === 'object' ? res : { ok: false, error: 'السيرفر رفض الطلب.' });
      };
      const to = setTimeout(
        () => finish({ ok: false, error: 'السيرفر مش بيرد — جرّب تاني.' }),
        JOIN_ACK_TIMEOUT,
      );
      try {
        this.socket.emit('voice:hostMute', payload, (res) => finish(res));
      } catch (e) {
        finish({ ok: false, error: 'الاتصال بالسيرفر مقطوع.' });
      }
    });
  }

  // ── roster (server truth: who's in voice, who's muted, who's host-muted) ──

  _applyRoster(roster) {
    this._lastRoster = roster;
    if (!this.myId) { // setSelf() not called yet — buffer and wait
      this.pendingRoster = roster;
      return;
    }

    for (const p of roster) {
      if (p && p.name) this.names.set(p.id, p.name);
    }

    // Our own entry: adopt the server-enforced host mute (it never affects the mesh).
    const own = roster.find((p) => sameId(p.id, this.myId));
    if (own) this._adoptHostMuted(!!own.hostMuted);

    if (!this.joined) {
      // Not in voice ourselves — no connections; just surface who's in voice.
      this._teardownPeers();
      this._emitPeers(roster);
      return;
    }

    // Mesh maintenance: exactly one peer per OTHER voice participant.
    const want = new Set();
    for (const p of roster) {
      if (!sameId(p.id, this.myId)) want.add(p.id);
    }
    for (const pid of [...this.peers.keys()]) {
      if (!want.has(pid)) {
        this._rebuildTried.delete(pid);
        this._closePeer(pid, this.peers.get(pid));
      }
    }
    for (const p of roster) {
      if (sameId(p.id, this.myId)) continue;
      let peer = this.peers.get(p.id);
      if (peer && (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed')) {
        // Dead connection — a fresh roster is a fresh chance (and a fresh budget).
        this._rebuildTried.delete(p.id);
        this._closePeer(p.id, peer);
        peer = null;
      }
      if (!peer) {
        peer = this._createPeer(p.id);
        if (!peer) continue; // paranoia: never a peer to ourselves
      }
      peer.name = p.name || this.names.get(p.id) || 'لاعب';
      peer.muted = !!p.muted;
      peer.hostMuted = !!p.hostMuted;
      if (peer.muted && peer.speaking) { // roster says muted — stop showing them talking
        peer.speaking = false;
        this.hooks.onSpeaking?.(p.id, false);
      }
    }
    this._emitPeers(roster);
    this._maybeLive();
  }

  /** Adopt the server's host-mute flag for OUR entry; enforce it on local tracks. */
  _adoptHostMuted(hm) {
    if (hm === this._hostMuted) return;
    this._hostMuted = hm;
    if (hm && this.selfSpeaking) { // host muted us mid-sentence — indicator off
      this.selfSpeaking = false;
      this.hooks.onSpeaking?.(this.myId, false);
    }
    this._applyTracks(); // host-muted: force disabled; when lifted, re-enable only if not self-muted
    this._emitSelf();
    if (hm) this.hooks.onInfo?.('المضيف كتّم المايك بتاعك.');
  }

  /** Solo call (no other voice participants) is live immediately. */
  _maybeLive() {
    if (!this.joined || this.status !== 'connecting') return;
    if (this.peers.size > 0) return; // wait for a real 'connected'
    const others = (this._lastRoster || []).filter((p) => !sameId(p.id, this.myId));
    if (others.length > 0) return;   // peers still negotiating
    this.status = 'live';
    this._emitSelf();
  }

  /** Don't leave the UI spinning forever when every peer stopped trying. */
  _settleStatus() {
    if (!this.joined || this.status !== 'connecting') return;
    if (this.peers.size === 0) { this._maybeLive(); return; }
    const pending = [...this.peers.values()].some((p) => p.conn === 'connecting');
    if (!pending) {
      this.status = 'live'; // nobody left connecting — per-peer conns show the truth
      this._emitSelf();
    }
  }

  // ── peer connections ────────────────────────────────────────────────────

  _createPeer(pid) {
    if (sameId(pid, this.myId)) return null; // never a peer to ourselves
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = {
      pid,
      pc,
      name: this.names.get(pid) || 'لاعب',
      muted: false,
      hostMuted: false,
      speaking: false,
      conn: 'connecting',   // 'connecting' | 'connected' | 'failed' | 'closed'
      audio: null,
      analyser: null,
      buf: null,
      ignoreOffer: false,
      makingOffer: false,
      polite: String(this.myId) < String(pid), // deterministic tie-break — no glare
      pendingCandidates: [],  // ICE candidates that raced ahead of the remote description
      restartTried: false,    // one ICE restart per failed episode
      recoveryTimer: null,    // pending "still failed → rebuild once" timer
    };
    this.peers.set(pid, peer);

    // Offer our mic right away (this is what fires negotiationneeded below).
    if (this.stream) {
      for (const t of this.stream.getTracks()) pc.addTrack(t, this.stream);
    }

    pc.onnegotiationneeded = () => { this._negotiate(peer); };

    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(pid, { candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => this._attachRemote(peer, e.streams[0]);

    pc.onconnectionstatechange = () => { this._onConnState(peer); };

    return peer;
  }

  /** Perfect-negotiation offer/answer; also used to carry an ICE restart. */
  async _negotiate(peer) {
    const pc = peer.pc;
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription(); // implicit offer/answer per signaling state
      if (pc.localDescription && pc.signalingState !== 'closed') {
        this._signal(peer.pid, { description: pc.localDescription.toJSON() });
      }
    } catch { /* pc is closing or died — roster/recovery will rebuild it */ }
    finally { peer.makingOffer = false; }
  }

  _onConnState(peer) {
    const st = peer.pc.connectionState;
    const mapped = st === 'connected' ? 'connected'
      : st === 'failed' ? 'failed'
        : st === 'closed' ? 'closed'
          : 'connecting'; // 'new' | 'connecting' | 'disconnected' (transient)
    if (mapped !== peer.conn) {
      peer.conn = mapped;
      this._emitPeers();
    }
    if (st === 'connected') {
      // Healthy again — restore the recovery budget.
      this._rebuildTried.delete(peer.pid);
      this._clearRecoveryTimer(peer);
      peer.restartTried = false;
      if (this.status === 'connecting') {
        this.status = 'live';
        this._emitSelf();
      }
    } else if (st === 'failed') {
      this._recoverFailedPeer(peer);
    } else if (this.status === 'connecting') {
      this._settleStatus();
    }
  }

  /**
   * Failed connection: ONE automatic ICE restart right away, then — if it is
   * still dead after a grace period — ONE close+rebuild. The rebuild budget
   * (per pid) only resets when the peer reaches 'connected', so this can never
   * loop forever; the next real roster change grants a fresh budget.
   */
  _recoverFailedPeer(peer) {
    if (!this.joined) return;
    const pid = peer.pid;

    // 1) One automatic ICE restart, right away.
    if (!peer.restartTried) {
      peer.restartTried = true;
      this.hooks.onInfo?.('الصوت قطع — بنحاول نعيد التوصيل…');
      try { peer.pc.restartIce(); } catch {}
      this._negotiate(peer); // restartIce alone may not fire negotiationneeded
    }

    // 2) Still dead after the grace period → rebuild the peer exactly once.
    if (!peer.recoveryTimer) {
      peer.recoveryTimer = setTimeout(() => {
        peer.recoveryTimer = null;
        const cur = this.peers.get(pid);
        if (cur !== peer || !this.joined) return;
        const st = peer.pc.connectionState;
        if (st !== 'failed' && st !== 'closed') return; // restart worked (or still changing)
        if (!this._rebuildTried.has(pid)) {
          this._rebuildTried.set(pid, true);
          this._closePeer(pid, peer);
          this._createPeer(pid);
          this._emitPeers();
        }
        // Already rebuilt once and it failed again — surface 'failed' and stop.
      }, RECOVERY_DELAY);
    }
  }

  _clearRecoveryTimer(peer) {
    if (peer.recoveryTimer) {
      clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
    }
  }

  /** Incoming relayed signal: { from: playerId, data: { description | candidate } }. */
  async _onSignal(msg) {
    const { from, data } = msg || {};
    if (!from || !data || !this.joined) return;
    if (sameId(from, this.myId)) return; // never negotiate with ourselves

    let peer = this.peers.get(from);
    if (!peer) {
      for (const k of this.peers.keys()) { // tolerate id type drift
        if (sameId(k, from)) { peer = this.peers.get(k); break; }
      }
    }
    if (!peer) {
      // Signal raced ahead of the roster — open a provisional peer (the next
      // roster closes it if the sender isn't actually a participant).
      peer = this._createPeer(from);
      if (!peer) return;
    }

    const pc = peer.pc;
    try {
      if (data.description) {
        const desc = data.description;
        const offerCollision = desc.type === 'offer' &&
          (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return; // impolite side sticks to its own offer
        // Polite side: setRemoteDescription performs the implicit rollback here.
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this._signal(from, { description: pc.localDescription.toJSON() });
        }
        this._flushCandidates(peer);
      } else if (data.candidate) {
        if (!pc.remoteDescription) {
          // Candidate raced ahead of the remote description — hold it briefly.
          peer.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch { /* stale signal for a dead connection — roster/recovery heals it */ }
  }

  /** Apply candidates that arrived before the remote description did. */
  _flushCandidates(peer) {
    if (!peer.pendingCandidates || !peer.pendingCandidates.length) return;
    const pending = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of pending) {
      try {
        peer.pc.addIceCandidate(c).catch(() => {}); // stale candidate — drop it
      } catch { /* pc already closed — drop it */ }
    }
  }

  _signal(to, data) {
    try { this.socket.emit('voice:signal', { to, data }); } catch { /* socket down */ }
  }

  /** Attach a remote stream to a hidden <audio autoplay> element. */
  _attachRemote(peer, stream) {
    if (!stream) return;
    if (!this.audioBox) {
      this.audioBox = document.createElement('div');
      this.audioBox.id = 'voiceAudio';
      this.audioBox.style.display = 'none';
      document.body.appendChild(this.audioBox);
    }
    let audio = peer.audio;
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.pid = String(peer.pid);
      this.audioBox.appendChild(audio);
      peer.audio = audio;
    }
    audio.srcObject = stream;
    const pref = this._pref(peer.pid);
    audio.muted = !!pref.mutedLocal; // local listening mute only
    audio.volume = pref.volume;
    audio.play().catch(() => {});    // join happened after a gesture; ignore stragglers
    this._watchPeer(peer, stream);   // speaking detection for this stream
  }

  _closePeer(pid, peer) {
    this._clearRecoveryTimer(peer);
    try { peer.pc.close(); } catch {}
    if (peer.audio) {
      try { peer.audio.srcObject = null; } catch {}
      peer.audio.remove();
    }
    this.peers.delete(pid);
    this.hooks.onSpeaking?.(pid, false);
  }

  _teardownPeers() {
    for (const [pid, peer] of [...this.peers]) this._closePeer(pid, peer);
    this._rebuildTried.clear();
    // Keep the poll alive when our own mic analyser survives (rejoin keeps the mic).
    if (!this.selfAnalyser) this._stopPoll();
    if (this.selfSpeaking) {
      this.selfSpeaking = false;
      this.hooks.onSpeaking?.(this.myId, false);
      this._emitSelf();
    }
  }

  _stopStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.selfAnalyser = null;
  }

  // ── speaking detection ──────────────────────────────────────────────────

  _audioCtx() {
    if (!this.ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ac = new Ctx();
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {}); // join/gesture resume
    return this.ac;
  }

  _makeAnalyser(stream) {
    const ac = this._audioCtx();
    if (!ac) throw new Error('no AudioContext');
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an); // analysis only — never routed to the destination
    return { analyser: an, buf: new Float32Array(an.fftSize) };
  }

  _watchSelf() {
    if (!this.stream) return;
    if (!this.selfAnalyser) {
      try {
        this.selfAnalyser = this._makeAnalyser(this.stream);
      } catch { return; }
    }
    this._startPoll();
  }

  _watchPeer(peer, stream) {
    try {
      const { analyser, buf } = this._makeAnalyser(stream);
      peer.analyser = analyser;
      peer.buf = buf;
    } catch { return; }
    this._startPoll();
  }

  _rms(an, buf) {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      try { this._pollOnce(); } catch { /* never let one bad tick kill the poll */ }
    }, POLL_MS);
  }

  _pollOnce() {
    // Own mic — suppressed while effectively muted (self mute OR host mute).
    if (this.selfAnalyser) {
      const rms = this._rms(this.selfAnalyser.analyser, this.selfAnalyser.buf);
      const on = this.selfSpeaking ? rms > SPEAK_OFF : rms > SPEAK_ON;
      const active = on && !this._muted && !this._hostMuted;
      if (active !== this.selfSpeaking) {
        this.selfSpeaking = active;
        this._emitSelf();
        this.hooks.onSpeaking?.(this.myId, active);
      }
    }
    // Remote peers — suppressed when the roster says they're muted.
    for (const [pid, peer] of this.peers) {
      if (!peer.analyser) continue;
      const rms = this._rms(peer.analyser, peer.buf);
      const on = peer.speaking ? rms > SPEAK_OFF : rms > SPEAK_ON;
      const active = on && !peer.muted;
      if (active !== peer.speaking) {
        peer.speaking = active;
        this.hooks.onSpeaking?.(pid, active);
        this._emitPeers();
      }
    }
  }

  _stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── local prefs / outward state ─────────────────────────────────────────

  _pref(pid) {
    let pref = this.prefs.get(pid);
    if (!pref) {
      for (const [k, v] of this.prefs) { // tolerate id type drift
        if (sameId(k, pid)) { pref = v; break; }
      }
    }
    return pref || { volume: 1, mutedLocal: false };
  }

  _peerKey(pid) {
    if (this.peers.has(pid)) return pid;
    for (const k of this.peers.keys()) {
      if (sameId(k, pid)) return k;
    }
    return null;
  }

  /** Track enabled = NOT (self-muted OR host-muted). */
  _applyTracks() {
    if (!this.stream) return;
    const enabled = !(this._muted || this._hostMuted);
    for (const t of this.stream.getAudioTracks()) t.enabled = enabled;
  }

  _emitSelf() {
    this.hooks.onSelf?.({
      joined: this.joined,
      muted: this._muted,
      hostMuted: this._hostMuted,
      speaking: this.selfSpeaking,
      status: this.status,
    });
  }

  _emitPeers(roster = null) {
    const list = [];
    for (const [pid, peer] of this.peers) {
      const pref = this._pref(pid);
      list.push({
        id: pid,
        name: peer.name,
        muted: peer.muted,
        hostMuted: peer.hostMuted,
        speaking: peer.speaking,
        mutedLocal: !!pref.mutedLocal,
        volume: pref.volume,
        conn: peer.conn,
        me: false,
      });
    }
    if (!this.joined && roster) {
      // Spectator view: show who's in voice without any connections.
      for (const p of roster) {
        if (sameId(p.id, this.myId)) continue;
        if (list.some((x) => sameId(x.id, p.id))) continue;
        const pref = this._pref(p.id);
        list.push({
          id: p.id,
          name: p.name || this.names.get(p.id) || 'لاعب',
          muted: !!p.muted,
          hostMuted: !!p.hostMuted,
          speaking: false,
          mutedLocal: !!pref.mutedLocal,
          volume: pref.volume,
          conn: 'closed',
          me: false,
        });
      }
    }
    this.hooks.onPeers?.(list);
  }
}
