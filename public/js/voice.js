// New voice mesh engine. This module has no imports and does no browser work at
// module evaluation time, so importing it is safe in Node and in unsupported browsers.

const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({
    urls: Object.freeze(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
  }),
]);

const JOIN_ACK_TIMEOUT_MS = 8000;
const CONFIG_TIMEOUT_MS = 5000;
const CANDIDATE_BUFFER_MAX = 100;
const CANDIDATE_MAX_CHARS = 4096;
const SDP_MAX_CHARS = 15000;
const SIGNAL_MAX_BYTES = 16000;
const MAX_MESH_PEERS = 16;
const SPEAKING_POLL_MS = 200;
const SPEAKING_ON_RMS = 0.055;
const SPEAKING_OFF_RMS = 0.028;
const CONNECT_TIMEOUT_MS = 20000;
const RECOVERY_TIMEOUT_MS = 15000;
const DISCONNECT_GRACE_MS = 5000;
const MAX_SIGNAL_BUFFER = 200;

const AR = Object.freeze({
  unsupported: 'الصوت مش مدعوم في المتصفح ده.',
  insecure: 'الصوت محتاج اتصال آمن (HTTPS).',
  notSeated: 'لازم تكون لاعب في الغرفة عشان تشغّل الصوت.',
  offline: 'الاتصال بالخادم مش متاح.',
  micDenied: 'تم رفض إذن الميكروفون.',
  noMic: 'مفيش ميكروفون متاح.',
  micBusy: 'الميكروفون مستخدم في تطبيق تاني.',
  micFailed: 'تعذر تشغيل الميكروفون.',
  joinTimeout: 'انتهت مهلة الانضمام للصوت.',
  joinFailed: 'تعذر الانضمام للصوت.',
  hostMuted: 'أنت مكتوم بواسطة المضيف.',
  hostMutedInfo: 'المضيف كتم صوتك.',
  hostUnmutedInfo: 'المضيف شغّل صوتك.',
  choosePlayer: 'اختار لاعب الأول.',
  noReply: 'مفيش رد من الخادم.',
  moderateFailed: 'تعذر تغيير كتم الصوت.',
  clickToHear: 'اضغط عشان تسمع صوت اللاعبين.',
  peerFailed: 'تعذر توصيل الصوت مع {name}.',
  micEnded: 'الميكروفون اتقطع. تم إيقاف الصوت.',
  deviceFailed: 'تعذر تغيير الميكروفون.',
  deviceChanged: 'تم تغيير الميكروفون.',
  removedFromVoice: 'تم إخراجك من قناة الصوت.',
  socketLost: 'الاتصال بالخادم اتقطع. الصوت اتوقف.',
});

/** Feature detection only; never throws and is safe under Node. */
export function isVoiceSupported() {
  try {
    const nav = globalThis.navigator;
    return (
      typeof globalThis.RTCPeerConnection === 'function' &&
      !!nav &&
      !!nav.mediaDevices &&
      typeof nav.mediaDevices.getUserMedia === 'function'
    );
  } catch {
    return false;
  }
}

function normalizeId(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 60) : '';
}

// Both peers run this exact comparison. Only the higher id opens the first offer.
function shouldInitiate(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) > String(b);
}

function cloneDefaultIceServers() {
  return DEFAULT_ICE_SERVERS.map((entry) => ({ urls: entry.urls.slice() }));
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const rawUrls = Array.isArray(item.urls) ? item.urls : [item.urls];
    const urls = rawUrls
      .filter((url) => typeof url === 'string')
      .map((url) => url.trim())
      .filter((url) => url.length > 0 && url.length <= 256)
      .filter((url) => /^(turns?|stuns?):/i.test(url));
    if (urls.length === 0) continue;
    const entry = { urls };
    if (typeof item.username === 'string' && item.username.length <= 512) {
      entry.username = item.username;
    }
    if (typeof item.credential === 'string' && item.credential.length <= 512) {
      entry.credential = item.credential;
    }
    if (typeof item.credentialType === 'string' && item.credentialType.length <= 32) {
      entry.credentialType = item.credentialType;
    }
    out.push(entry);
  }
  return out;
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.candidate !== 'string') return null;
  if (value.candidate.length === 0 || value.candidate.length > CANDIDATE_MAX_CHARS) return null;
  const out = { candidate: value.candidate };
  if (typeof value.sdpMid === 'string' && value.sdpMid.length <= 128) out.sdpMid = value.sdpMid;
  if (Number.isInteger(value.sdpMLineIndex)) out.sdpMLineIndex = value.sdpMLineIndex;
  if (typeof value.usernameFragment === 'string' && value.usernameFragment.length <= 256) {
    out.usernameFragment = value.usernameFragment;
  }
  return out;
}

function streamFromTrackEvent(event) {
  try {
    if (event.streams && event.streams[0]) return event.streams[0];
    if (event.track && typeof globalThis.MediaStream === 'function') {
      return new globalThis.MediaStream([event.track]);
    }
  } catch {
    // A missing MediaStream constructor just means we cannot route this track.
  }
  return null;
}

function micErrorMessage(error) {
  const name = error && typeof error.name === 'string' ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return AR.micDenied;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return AR.noMic;
  if (name === 'NotReadableError' || name === 'TrackStartError') return AR.micBusy;
  return AR.micFailed;
}

export class VoiceChat {
  constructor(socket, hooks = {}) {
    this._socket = socket && typeof socket === 'object' ? socket : null;
    this._hooks = hooks && typeof hooks === 'object' ? hooks : {};

    this._selfId = null;
    this._selfName = '';
    this._joined = false;
    this._muted = false;
    this._hostMuted = false;
    this._pushToTalk = false;
    this._talking = false;
    this._localSpeaking = false;
    this._status = 'idle';
    this._disposed = false;

    this._peers = new Map();
    this._audioEls = new Map();
    this._rosterOrder = [];
    this._lastRoster = null;
    this._sink = null;

    this._localStream = null;
    this._preferredDeviceId = null;
    this._recaptureAttempted = false;
    this._deviceChangeBusy = false;
    this._localTrackBindings = [];
    this._localAnalyser = null;

    this._audioCtx = null;
    this._speakTimer = null;
    this._playBlockedNotified = false;

    this._iceServers = cloneDefaultIceServers();
    this._configAbort = null;
    this._joinPromise = null;
    this._joinGeneration = 0;
    this._pendingSignals = [];
    this._signalTail = Promise.resolve();
    this._ackCancels = new Set();

    this._socketBindings = [];
    this._windowBlurHandler = null;
    this._visibilityHandler = null;

    this._bindSocketEvents();
  }

  get supported() {
    return isVoiceSupported();
  }

  get secure() {
    try {
      if (typeof globalThis.isSecureContext === 'boolean') return globalThis.isSecureContext;
      const loc = globalThis.location;
      if (!loc) return false;
      return (
        loc.protocol === 'https:' ||
        loc.hostname === 'localhost' ||
        loc.hostname === '127.0.0.1' ||
        loc.hostname === '[::1]'
      );
    } catch {
      return false;
    }
  }

  get joined() {
    return this._joined;
  }

  get muted() {
    return this._muted;
  }

  get hostMuted() {
    return this._hostMuted;
  }

  get pushToTalk() {
    return this._pushToTalk;
  }

  get peers() {
    const list = [];
    for (const peer of this._peers.values()) {
      list.push({
        id: peer.id,
        name: peer.name,
        muted: peer.muted,
        hostMuted: peer.hostMuted,
        speaking: peer.speaking,
        connection: peer.connection,
        playBlocked: peer.playBlocked,
        localMuted: peer.localMuted,
        volume: peer.volume,
      });
    }
    if (this._rosterOrder.length > 0) {
      const order = new Map(this._rosterOrder.map((id, index) => [id, index]));
      list.sort((a, b) => {
        const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    }
    return list;
  }

  setSelf(pid, name = '') {
    try {
      const next = pid === null || pid === undefined || pid === '' ? null : normalizeId(pid);
      const nextName = normalizeName(name);
      if (next !== this._selfId) {
        if (this._joined || this._status === 'requesting' || this._status === 'connecting') {
          this.leave();
        }
        this._selfId = next;
        this._selfName = nextName;
        this._hostMuted = false;
        this._muted = false;
        this._status = 'idle';
        this._lastRoster = null;
        this._rosterOrder = [];
      } else if (nextName) {
        this._selfName = nextName;
      }
      this._fireSelf();
    } catch {
      // setSelf is a UI convenience; it must never break room setup.
    }
  }

  async join() {
    try {
      if (this._disposed) return false;
      if (this._joined) return true;
      if (this._joinPromise) return await this._joinPromise;
      if (!this._selfId) {
        this._reportError(AR.notSeated, 'failed');
        return false;
      }
      if (!this.supported) {
        this._reportError(AR.unsupported, 'failed');
        return false;
      }
      if (!this.secure) {
        this._reportError(AR.insecure, 'failed');
        return false;
      }
      if (!this._socketConnected()) {
        this._reportError(AR.offline, 'failed');
        return false;
      }

      // The AudioContext is created synchronously in the user gesture, before
      // any network or permission await can consume the browser activation.
      this._ensureAudioContext();
      this._joinGeneration += 1;
      const generation = this._joinGeneration;
      this._pendingSignals = [];
      this._status = 'requesting';
      this._fireSelf();

      const task = this._runJoin(generation);
      const promise = task
        .catch(() => {
          if (this._joinGeneration === generation && !this._disposed) {
            this._reportError(AR.joinFailed, 'failed');
          }
          return false;
        })
        .finally(() => {
          if (this._joinPromise === promise) this._joinPromise = null;
        });
      this._joinPromise = promise;
      return await promise;
    } catch {
      this._reportError(AR.joinFailed, 'failed');
      return false;
    }
  }

  leave() {
    try {
      if (this._disposed) return;
      const active =
        this._joined ||
        this._status === 'requesting' ||
        this._status === 'connecting' ||
        this._status === 'live';
      this._joinGeneration += 1;
      this._joinPromise = null;
      if (active && this._socketConnected()) this._safeEmit('voice:leave');
      this._teardownSession('idle', true);
    } catch {
      // Leaving must always leave the client in a quiet local state.
    }
  }

  toggleMute() {
    try {
      if (!this._joined) return false;
      if (this._hostMuted) {
        this._notifyError(AR.hostMuted);
        return false;
      }
      const next = !this._muted;
      this._muted = next;
      this._applyLocalMute();
      this._emitMute();
      this._fireSelf();
      return true;
    } catch {
      return false;
    }
  }

  setMuted(muted) {
    try {
      if (typeof muted !== 'boolean' || !this._joined) return false;
      if (!muted && this._hostMuted) {
        this._notifyError(AR.hostMuted);
        return false;
      }
      if (this._muted === muted) {
        this._applyLocalMute();
        return true;
      }
      this._muted = muted;
      this._applyLocalMute();
      this._emitMute();
      this._fireSelf();
      return true;
    } catch {
      return false;
    }
  }

  setPushToTalk(on) {
    try {
      if (this._disposed) return;
      this._pushToTalk = on === true;
      if (!this._pushToTalk) this._talking = false;
      this._applyLocalMute();
      this._fireSelf();
    } catch {
      // Local preference only.
    }
  }

  setTalking(on) {
    try {
      if (!this._joined || !this._pushToTalk) {
        this._talking = false;
        this._applyLocalMute();
        return;
      }
      this._talking = on === true;
      this._applyLocalMute();
      this._fireSelf();
    } catch {
      // A lost keyup must not leave the engine in an unstable state.
    }
  }

  async hostMute({ pid, all, muted } = {}) {
    try {
      if (this._disposed) return false;
      if (!this._socketConnected()) {
        this._notifyError(AR.offline);
        return false;
      }
      if (typeof muted !== 'boolean') {
        this._notifyError(AR.moderateFailed);
        return false;
      }
      const payload = { muted };
      if (all === true) {
        payload.all = true;
      } else {
        const target = normalizeId(pid);
        if (!target) {
          this._notifyError(AR.choosePlayer);
          return false;
        }
        payload.pid = target;
      }

      const response = await this._emitWithAck('voice:moderate', payload, JOIN_ACK_TIMEOUT_MS);
      if (!response) {
        this._notifyError(AR.noReply);
        return false;
      }
      if (response.ok !== true) {
        this._notifyError(
          typeof response.error === 'string' && response.error ? response.error : AR.moderateFailed
        );
        return false;
      }
      if (Array.isArray(response.roster)) {
        this._lastRoster = response.roster;
        if (this._joined) this._syncRoster(response.roster, true);
      }
      this._info(muted ? 'تم كتم الصوت.' : 'تم تشغيل الصوت.');
      return true;
    } catch {
      this._notifyError(AR.moderateFailed);
      return false;
    }
  }

  setPeerMuted(pid, muted) {
    try {
      const id = normalizeId(pid);
      const peer = id ? this._peers.get(id) : null;
      if (!peer || typeof muted !== 'boolean') return false;
      peer.localMuted = muted;
      this._applyPeerAudio(peer);
      this._firePeers();
      return true;
    } catch {
      return false;
    }
  }

  setPeerVolume(pid, volume) {
    try {
      const id = normalizeId(pid);
      const peer = id ? this._peers.get(id) : null;
      const value = Number(volume);
      if (!peer || !Number.isFinite(value)) return false;
      peer.volume = Math.min(1, Math.max(0, value));
      const el = this._audioEls.get(id);
      if (el) el.volume = peer.volume;
      this._firePeers();
      return true;
    } catch {
      return false;
    }
  }

  resumeAudio() {
    try {
      if (this._disposed || !this._joined) return;
      this._ensureAudioContext();
      this._resumeAudioContext();
      for (const peer of this._peers.values()) this._tryPlay(peer);
    } catch {
      // Playback retries are best-effort and gesture-driven.
    }
  }

  async listInputDevices() {
    try {
      const media = globalThis.navigator && globalThis.navigator.mediaDevices;
      if (!media || typeof media.enumerateDevices !== 'function') return [];
      const devices = await media.enumerateDevices();
      if (!Array.isArray(devices)) return [];
      const out = [];
      let index = 0;
      for (const device of devices) {
        if (!device || device.kind !== 'audioinput') continue;
        const rawId = typeof device.deviceId === 'string' ? device.deviceId : '';
        const deviceId = rawId ? normalizeId(rawId) : 'default';
        if (!deviceId) continue;
        index += 1;
        out.push({
          deviceId,
          label: normalizeName(device.label) || `ميكروفون ${index}`,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async setInputDevice(deviceId) {
    try {
      if (this._disposed) return false;
      if (typeof deviceId !== 'string' && deviceId !== null && deviceId !== undefined) {
        return false;
      }
      this._preferredDeviceId =
        typeof deviceId === 'string' && deviceId.length > 0 && deviceId !== 'default'
          ? deviceId
          : null;
      if (!this._joined || !this._localStream) return true;
      if (this._deviceChangeBusy) return false;

      this._deviceChangeBusy = true;
      const generation = this._joinGeneration;
      let next = null;
      try {
        next = await this._captureStream(this._preferredDeviceId);
      } catch (error) {
        if (this._isCurrentGeneration(generation)) this._notifyError(micErrorMessage(error));
        return false;
      }

      if (!this._isCurrentGeneration(generation) || !this._joined) {
        this._stopStream(next);
        return false;
      }

      const applied = await this._applyNewCapture(next, generation);
      if (!applied) {
        if (this._isCurrentGeneration(generation)) this._notifyError(AR.deviceFailed);
        return false;
      }
      this._recaptureAttempted = false;
      this._info(AR.deviceChanged);
      return true;
    } catch {
      this._notifyError(AR.deviceFailed);
      return false;
    } finally {
      this._deviceChangeBusy = false;
    }
  }

  dispose() {
    if (this._disposed) return;
    try {
      const active =
        this._joined ||
        this._status === 'requesting' ||
        this._status === 'connecting' ||
        this._status === 'live';
      this._joinGeneration += 1;
      this._joinPromise = null;
      if (active && this._socketConnected()) this._safeEmit('voice:leave');
      this._disposed = true;
      this._unbindSocketEvents();
      this._teardownSession('idle', false);
      this._closeAudioContext();
    } catch {
      this._disposed = true;
    }
  }

  // -------------------------------------------------------------------------
  // Socket plumbing

  _bindSocketEvents() {
    this._installSocket('voice:roster', (data) => {
      this._handleRosterEvent(data);
    });
    this._installSocket('voice:signal', (data) => {
      try {
        if (!data || typeof data !== 'object') return;
        const from = normalizeId(data.from);
        if (!from || from === this._selfId) return;
        const payload = data.payload;
        if (!payload || typeof payload !== 'object') return;
        if (typeof payload.kind !== 'string') return;

        if (!this._joined && (this._status === 'requesting' || this._status === 'connecting')) {
          if (this._pendingSignals.length >= MAX_SIGNAL_BUFFER) return;
          this._pendingSignals.push({ from, payload, generation: this._joinGeneration });
          return;
        }
        if (!this._joined) return;
        this._enqueueSignal(from, payload, this._joinGeneration);
      } catch {
        // Unknown signal shapes are ignored, never thrown.
      }
    });
    this._installSocket('disconnect', () => {
      this._handleSocketDisconnect();
    });
  }

  _installSocket(event, handler) {
    try {
      if (!this._socket || typeof this._socket.on !== 'function') return;
      const guarded = (...args) => {
        try {
          const result = handler(...args);
          if (result && typeof result.then === 'function') result.catch(() => {});
        } catch {
          // A malformed server event must not escape a socket callback.
        }
      };
      this._socket.on(event, guarded);
      this._socketBindings.push([event, guarded]);
    } catch {
      // Unsupported socket-like objects simply get no listeners.
    }
  }

  _unbindSocketEvents() {
    try {
      if (this._socket && typeof this._socket.off === 'function') {
        for (const [event, handler] of this._socketBindings) this._socket.off(event, handler);
      }
    } catch {
      // Ignore teardown failures.
    }
    this._socketBindings = [];
  }

  _socketConnected() {
    try {
      return !!this._socket && this._socket.connected !== false && typeof this._socket.emit === 'function';
    } catch {
      return false;
    }
  }

  _safeEmit(event, ...args) {
    try {
      if (!this._socketConnected()) return false;
      this._socket.emit(event, ...args);
      return true;
    } catch {
      return false;
    }
  }

  _emitWithAck(event, data, timeoutMs) {
    return new Promise((resolve) => {
      try {
        if (!this._socketConnected()) {
          resolve(null);
          return;
        }
      } catch {
        resolve(null);
        return;
      }

      let settled = false;
      let timer = null;
      let cancel = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (cancel) this._ackCancels.delete(cancel);
        resolve(value);
      };
      cancel = () => finish(null);
      this._ackCancels.add(cancel);
      timer = setTimeout(() => finish(null), timeoutMs);

      const onAck = (...args) => {
        if (settled) return;
        let response = args[0];
        if (args.length >= 2) {
          if (args[0] instanceof Error) {
            finish(null);
            return;
          }
          response = args[1];
        } else if (response instanceof Error) {
          finish(null);
          return;
        }
        if (!response || typeof response !== 'object') {
          finish({ ok: false });
          return;
        }
        finish(response);
      };

      try {
        if (typeof this._socket.timeout === 'function') {
          const timed = this._socket.timeout(timeoutMs);
          if (typeof data === 'undefined') timed.emit(event, onAck);
          else timed.emit(event, data, onAck);
        } else if (typeof data === 'undefined') {
          this._socket.emit(event, onAck);
        } else {
          this._socket.emit(event, data, onAck);
        }
      } catch {
        finish(null);
      }
    });
  }

  _handleSocketDisconnect() {
    try {
      if (this._disposed) return;
      const wasActive = this._joined || this._status === 'requesting' || this._status === 'connecting';
      this._joinGeneration += 1;
      this._joinPromise = null;
      if (!wasActive) {
        this._teardownSession('idle', false);
        return;
      }
      this._teardownSession('failed', true);
      this._reportError(AR.socketLost, 'failed');
    } catch {
      // The socket disconnecting must still silence local capture.
    }
  }

  // -------------------------------------------------------------------------
  // Join / capture lifecycle

  _isCurrentGeneration(generation) {
    return !this._disposed && generation === this._joinGeneration;
  }

  async _runJoin(generation) {
    let stream = null;
    try {
      this._iceServers = cloneDefaultIceServers();
      await this._loadIceConfig(generation);
      if (!this._isCurrentGeneration(generation)) return false;

      try {
        stream = await this._captureStream(this._preferredDeviceId);
      } catch (error) {
        if (this._isCurrentGeneration(generation)) {
          this._reportError(micErrorMessage(error), 'failed');
        }
        return false;
      }

      if (!this._isCurrentGeneration(generation)) {
        this._stopStream(stream);
        return false;
      }

      for (const track of stream.getAudioTracks()) track.enabled = !this._effectiveMuted();
      this._status = 'connecting';
      this._fireSelf();

      const response = await this._emitWithAck('voice:join', undefined, JOIN_ACK_TIMEOUT_MS);
      if (!this._isCurrentGeneration(generation)) {
        this._stopStream(stream);
        // A stale ack must not emit leave: a newer join generation may already
        // be live on the same socket, and the earlier leave/disconnect handled
        // the old server state.
        return false;
      }

      if (!response || response.ok !== true) {
        this._stopStream(stream);
        this._pendingSignals = [];
        // A timed-out join may still have reached the server; leave cleans it.
        this._safeEmit('voice:leave');
        const message =
          !response
            ? AR.joinTimeout
            : typeof response.error === 'string' && response.error
              ? response.error
              : AR.joinFailed;
        this._reportError(message, 'failed');
        return false;
      }

      this._setLocalStream(stream);
      stream = null;
      this._joined = true;
      this._muted = false;
      this._status = 'live';
      this._createSink();

      const roster = Array.isArray(response.roster) ? response.roster : this._lastRoster;
      this._syncRoster(roster, true);
      if (!this._joined || !this._isCurrentGeneration(generation)) return false;
      this._startSpeakingPoll();
      this._installActivityGuards();
      this._fireSelf();
      if (!this._joined || !this._isCurrentGeneration(generation)) return false;
      this._flushPendingSignals(generation);
      return this._joined;
    } catch {
      if (stream) this._stopStream(stream);
      if (this._isCurrentGeneration(generation)) {
        if (this._joined) {
          this._joinGeneration += 1;
          this._safeEmit('voice:leave');
        }
        this._teardownSession('failed', true);
        this._reportError(AR.joinFailed, 'failed');
      }
      return false;
    }
  }

  async _loadIceConfig(generation) {
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') return;
    let controller = null;
    let timer = null;
    try {
      if (typeof globalThis.AbortController === 'function') {
        controller = new globalThis.AbortController();
        this._configAbort = controller;
        timer = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // Ignore abort failures.
          }
        }, CONFIG_TIMEOUT_MS);
      }
      const response = await fetchFn('/voice-config', {
        method: 'GET',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (!response || !response.ok) return;
      const data = await response.json();
      if (!this._isCurrentGeneration(generation)) return;
      const configured = sanitizeIceServers(data && data.iceServers);
      if (configured.length > 0) {
        this._iceServers = cloneDefaultIceServers().concat(configured);
      }
    } catch {
      // TURN is optional; STUN-only is the documented fallback.
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (this._configAbort === controller) this._configAbort = null;
    }
  }

  async _captureStream(deviceId) {
    const media = globalThis.navigator && globalThis.navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function') throw new Error(AR.unsupported);
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (typeof deviceId === 'string' && deviceId.length > 0) {
      audio.deviceId = { exact: deviceId };
    }
    const stream = await media.getUserMedia({ audio, video: false });
    if (!stream || typeof stream.getAudioTracks !== 'function') {
      throw new Error(AR.micFailed);
    }
    if (stream.getAudioTracks().length === 0) {
      this._stopStream(stream);
      throw new Error(AR.micFailed);
    }
    return stream;
  }

  _setLocalStream(stream) {
    const old = this._localStream;
    if (old === stream) {
      this._applyLocalMute();
      return;
    }
    this._clearLocalTrackBindings();
    if (old) this._destroyAnalyser(this._localAnalyser);
    this._localAnalyser = null;

    this._localStream = stream;
    const handler = () => this._onLocalTrackEnded(stream);
    try {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !this._effectiveMuted();
        track.addEventListener('ended', handler);
        this._localTrackBindings.push([track, handler]);
      }
    } catch {
      // A stream without bindable tracks still fails later at peer setup.
    }
    this._setupLocalAnalyser();
    if (old && old !== stream) this._stopStream(old);
  }

  _clearLocalTrackBindings() {
    for (const [track, handler] of this._localTrackBindings) {
      try {
        track.removeEventListener('ended', handler);
      } catch {
        // Ignore already-dead tracks.
      }
    }
    this._localTrackBindings = [];
  }

  _stopStream(stream) {
    try {
      if (!stream || typeof stream.getTracks !== 'function') return;
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore per-track teardown errors.
        }
      }
    } catch {
      // Ignore malformed streams.
    }
  }

  _onLocalTrackEnded(stream) {
    try {
      if (this._disposed || !this._joined || this._deviceChangeBusy) return;
      if (stream !== this._localStream) return;
      if (this._recaptureAttempted) {
        this._endVoiceForMicFailure();
        return;
      }
      this._recaptureAttempted = true;
      const generation = this._joinGeneration;
      this._run(this._recaptureAfterEnd(generation));
    } catch {
      // Nothing else to do if the ended handler itself fails.
    }
  }

  async _recaptureAfterEnd(generation) {
    let next = null;
    try {
      next = await this._captureStream(null);
      if (!this._isCurrentGeneration(generation) || !this._joined) {
        this._stopStream(next);
        return;
      }
      const applied = await this._applyNewCapture(next, generation);
      if (!applied) this._endVoiceForMicFailure();
    } catch {
      this._stopStream(next);
      if (this._isCurrentGeneration(generation) && this._joined) this._endVoiceForMicFailure();
    }
  }

  async _applyNewCapture(next, generation) {
    if (!next || typeof next.getAudioTracks !== 'function') return false;
    const track = next.getAudioTracks()[0];
    if (!track) {
      this._stopStream(next);
      return false;
    }
    track.enabled = !this._effectiveMuted();

    const replaced = [];
    const added = [];
    const renegotiate = [];
    try {
      for (const peer of this._peers.values()) {
        const pc = peer.pc;
        if (!pc || pc.signalingState === 'closed') continue;
        const senders = pc.getSenders().filter((sender) => sender.track && sender.track.kind === 'audio');
        if (senders.length === 0) {
          const sender = pc.addTrack(track, next);
          added.push({ pc, sender });
          renegotiate.push(peer);
          continue;
        }
        for (const sender of senders) {
          if (typeof sender.replaceTrack !== 'function') throw new Error('replaceTrack unavailable');
          const oldTrack = sender.track;
          await sender.replaceTrack(track);
          replaced.push({ sender, oldTrack });
        }
      }
      if (!this._isCurrentGeneration(generation) || !this._joined) {
        await this._undoCaptureSwaps(replaced, added);
        this._stopStream(next);
        return false;
      }
      this._setLocalStream(next);
      for (const peer of renegotiate) {
        if (this._joined && peer.pc) this._run(this._startOffer(peer, { recovery: true }));
      }
      return true;
    } catch {
      await this._undoCaptureSwaps(replaced, added);
      this._stopStream(next);
      return false;
    }
  }

  async _undoCaptureSwaps(replaced, added) {
    for (let index = replaced.length - 1; index >= 0; index -= 1) {
      const item = replaced[index];
      try {
        await item.sender.replaceTrack(item.oldTrack || null);
      } catch {
        // A closed peer cannot roll back; the local stream remains authoritative.
      }
    }
    for (const item of added) {
      try {
        item.pc.removeTrack(item.sender);
      } catch {
        // The peer may already be closed.
      }
    }
  }

  _endVoiceForMicFailure() {
    try {
      if (this._disposed) return;
      this._joinGeneration += 1;
      if (this._joined && this._socketConnected()) this._safeEmit('voice:leave');
      this._teardownSession('failed', true);
      this._reportError(AR.micEnded, 'failed');
    } catch {
      // The local session is already being torn down.
    }
  }

  _effectiveMuted() {
    if (this._hostMuted) return true;
    return this._pushToTalk ? !this._talking : this._muted;
  }

  _applyLocalMute() {
    try {
      const muted = this._effectiveMuted();
      if (this._localStream && typeof this._localStream.getAudioTracks === 'function') {
        for (const track of this._localStream.getAudioTracks()) track.enabled = !muted;
      }
      if (muted) this._setLocalSpeaking(false);
    } catch {
      // Track toggling is best-effort; peer track state remains authoritative.
    }
  }

  _emitMute() {
    try {
      if (!this._joined) return;
      this._safeEmit('voice:mute', { muted: this._muted === true });
    } catch {
      // Fire-and-forget by protocol.
    }
  }

  // -------------------------------------------------------------------------
  // Roster and peers

  _handleRosterEvent(data) {
    try {
      if (!Array.isArray(data)) return;
      this._lastRoster = data;
      if (!this._joined) return;
      this._syncRoster(data, false);
    } catch {
      // Malformed rosters are ignored.
    }
  }

  _syncRoster(list, initial) {
    try {
      if (!Array.isArray(list)) return;
      this._lastRoster = list;
      if (!this._joined) return;

      const entries = [];
      const seen = new Set();
      let selfEntry = null;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const id = normalizeId(raw.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const entry = {
          id,
          name: normalizeName(raw.name),
          muted: raw.muted === true,
          hostMuted: raw.hostMuted === true,
        };
        if (id === this._selfId) {
          selfEntry = entry;
          continue;
        }
        if (entries.length >= MAX_MESH_PEERS) continue;
        entries.push(entry);
      }

      if (!selfEntry && !initial) {
        this._joinGeneration += 1;
        this._teardownSession('idle', true);
        this._info(AR.removedFromVoice);
        return;
      }

      if (selfEntry) {
        const wasHostMuted = this._hostMuted;
        this._hostMuted = selfEntry.hostMuted === true;
        if (this._hostMuted !== wasHostMuted) {
          this._applyLocalMute();
          if (this._hostMuted) this._info(AR.hostMutedInfo);
          else this._info(AR.hostUnmutedInfo);
          this._fireSelf();
        }
      }

      const ids = new Set();
      for (const entry of entries) {
        ids.add(entry.id);
        let peer = this._peers.get(entry.id);
        if (!peer) {
          peer = this._ensurePeer(entry.id, entry.name);
          if (!peer) continue;
        }
        peer.name = entry.name || peer.name;
        peer.muted = entry.muted;
        const wasHostMuted = peer.hostMuted;
        peer.hostMuted = entry.hostMuted;
        if (peer.hostMuted && !wasHostMuted) {
          this._setPeerSpeaking(peer, false);
          peer.ignoreOffer = false;
        }
        this._applyPeerAudio(peer);
      }

      for (const id of Array.from(this._peers.keys())) {
        if (!ids.has(id)) this._removePeer(id);
      }

      this._rosterOrder = entries.map((entry) => entry.id);
      this._firePeers();
    } catch {
      // Roster application is isolated from socket callbacks.
    }
  }

  _ensurePeer(id, name) {
    try {
      if (!this._joined || !id || id === this._selfId) return null;
      const existing = this._peers.get(id);
      if (existing) return existing;
      if (this._peers.size >= MAX_MESH_PEERS) return null;

      const initiator = shouldInitiate(this._selfId, id);
      const peer = {
        id,
        name: normalizeName(name),
        muted: false,
        hostMuted: false,
        speaking: false,
        connection: 'new',
        playBlocked: false,
        localMuted: false,
        volume: 1,
        pc: null,
        remoteStream: null,
        queuedCandidates: [],
        makingOffer: false,
        localOfferToken: 0,
        ignoreOffer: false,
        initiator,
        polite: !initiator,
        iceRestarts: 0,
        rebuilds: 0,
        recovering: false,
        failureReported: false,
        timers: { connect: null, disconnect: null, recovery: null },
        analyser: null,
      };
      this._peers.set(id, peer);
      this._ensureAudioElement(peer);
      this._buildPeerConnection(peer);
      if (peer.pc) {
        this._armConnectTimer(peer);
        if (peer.initiator) this._run(this._startOffer(peer, {}));
      }
      this._firePeers();
      return peer;
    } catch {
      return null;
    }
  }

  _buildPeerConnection(peer) {
    let pc = null;
    try {
      if (typeof globalThis.RTCPeerConnection !== 'function') throw new Error('no WebRTC');
      if (!this._localStream || this._localStream.getAudioTracks().length === 0) {
        throw new Error('no local track');
      }
      pc = new globalThis.RTCPeerConnection({ iceServers: this._iceServers });
      peer.pc = pc;
      peer.connection = 'new';
      peer.makingOffer = false;
      peer.ignoreOffer = false;
      peer.queuedCandidates = [];
      peer.failureReported = false;

      for (const track of this._localStream.getAudioTracks()) pc.addTrack(track, this._localStream);

      pc.onicecandidate = (event) => {
        try {
          if (!event || !event.candidate || !this._joined) return;
          const candidate = normalizeCandidate(
            typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate
          );
          if (candidate) this._sendSignal(peer.id, { kind: 'candidate', candidate });
        } catch {
          // Candidate serialization failures are per-candidate and ignorable.
        }
      };
      pc.ontrack = (event) => {
        try {
          if (!this._joined || peer.pc !== pc) return;
          const stream = streamFromTrackEvent(event);
          if (stream) this._attachRemoteStream(peer, stream);
        } catch {
          // A remote track that cannot be routed is ignored.
        }
      };
      pc.onconnectionstatechange = () => {
        try {
          if (peer.pc === pc) this._handlePeerState(peer);
        } catch {
          // State callbacks must never escape.
        }
      };
      pc.oniceconnectionstatechange = () => {
        try {
          if (peer.pc === pc) this._handlePeerState(peer);
        } catch {
          // ICE callbacks must never escape.
        }
      };
      return true;
    } catch {
      this._failPeer(peer, this._peerErrorMessage(peer));
      return false;
    }
  }

  _attachRemoteStream(peer, stream) {
    try {
      if (!peer || !this._joined) return;
      peer.remoteStream = stream;
      this._ensureAudioElement(peer);
      const el = this._audioEls.get(peer.id);
      if (el) {
        try {
          el.srcObject = stream;
        } catch {
          // Some older engines reject srcObject; the audio element stays empty.
        }
      }
      this._destroyAnalyser(peer.analyser);
      peer.analyser = this._setupAnalyser(stream);
      this._applyPeerAudio(peer);
      this._tryPlay(peer);
      this._firePeers();
    } catch {
      // Remote audio setup is best-effort.
    }
  }

  _removePeer(id) {
    try {
      const peer = this._peers.get(id);
      if (!peer) return;
      this._destroyPeerConnection(peer, true);
      this._destroyAnalyser(peer.analyser);
      peer.analyser = null;
      this._removeAudioElement(id);
      this._peers.delete(id);
      this._firePeers();
    } catch {
      this._peers.delete(id);
    }
  }

  _peerErrorMessage(peer) {
    const name = peer && peer.name ? peer.name : 'اللاعب';
    return AR.peerFailed.replace('{name}', name);
  }

  _failPeer(peer, message) {
    try {
      if (!peer) return;
      this._destroyPeerConnection(peer, true);
      this._destroyAnalyser(peer.analyser);
      peer.analyser = null;
      this._removeAudioElement(peer.id);
      peer.connection = 'failed';
      peer.recovering = false;
      this._setPeerSpeaking(peer, false);
      if (!peer.failureReported) {
        peer.failureReported = true;
        this._notifyError(message || this._peerErrorMessage(peer));
      }
      this._firePeers();
    } catch {
      // Failing a peer is already a recovery path.
    }
  }

  _destroyPeerConnection(peer, removeMedia) {
    if (!peer) return;
    this._clearPeerTimers(peer);
    const pc = peer.pc;
    peer.pc = null;
    peer.makingOffer = false;
    peer.queuedCandidates = [];
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
      } catch {
        // Already-closed connections are fine.
      }
    }
    if (removeMedia) {
      peer.remoteStream = null;
      const el = this._audioEls.get(peer.id);
      if (el) {
        try {
          el.pause();
          el.srcObject = null;
        } catch {
          // Ignore media element teardown errors.
        }
      }
      peer.playBlocked = false;
    }
  }

  // -------------------------------------------------------------------------
  // Negotiation
  //
  // Signal payloads are intentionally small and typed:
  //   { kind: 'offer'|'answer', sdp: string }
  //   { kind: 'candidate', candidate: RTCIceCandidateInit }

  _sendSignal(to, payload) {
    try {
      if (!this._joined || !this._socketConnected()) return false;
      const target = normalizeId(to);
      if (!target) return false;
      const json = JSON.stringify(payload);
      const bytes =
        typeof globalThis.TextEncoder === 'function'
          ? new globalThis.TextEncoder().encode(json).length
          : json.length;
      if (bytes > SIGNAL_MAX_BYTES) return false;
      return this._safeEmit('voice:signal', { to: target, payload });
    } catch {
      return false;
    }
  }

  _enqueueSignal(from, payload, generation) {
    const task = this._signalTail
      .then(() => this._processSignal(from, payload, generation))
      .catch(() => {});
    this._signalTail = task;
  }

  _flushPendingSignals(generation) {
    const pending = this._pendingSignals;
    this._pendingSignals = [];
    for (const item of pending) {
      if (item.generation !== generation) continue;
      this._enqueueSignal(item.from, item.payload, generation);
    }
  }

  async _processSignal(from, payload, generation) {
    try {
      if (!this._joined || generation !== this._joinGeneration || this._disposed) return;
      if (!payload || typeof payload !== 'object') return;
      const peer = this._peers.get(from) || this._ensurePeer(from, '');
      if (!peer || !peer.pc) return;
      switch (payload.kind) {
        case 'offer':
          await this._handleOffer(peer, payload, generation);
          break;
        case 'answer':
          await this._handleAnswer(peer, payload, generation);
          break;
        case 'candidate':
          await this._handleCandidate(peer, payload, generation);
          break;
        default:
          break;
      }
    } catch {
      // A single bad signal is dropped; the peer recovery timers continue.
    }
  }

  async _startOffer(peer, { iceRestart = false, recovery = false } = {}) {
    if (!this._joined || !peer || !peer.pc) return false;
    const pc = peer.pc;
    if (peer.makingOffer) return false;
    peer.makingOffer = true;
    peer.localOfferToken += 1;
    const token = peer.localOfferToken;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (!this._joined || peer.pc !== pc || token !== peer.localOfferToken) return false;
      await pc.setLocalDescription(offer);
      if (
        !this._joined ||
        peer.pc !== pc ||
        token !== peer.localOfferToken ||
        !pc.localDescription ||
        pc.localDescription.type !== 'offer'
      ) {
        return false;
      }
      const sent = this._sendSignal(peer.id, { kind: 'offer', sdp: pc.localDescription.sdp });
      if (!sent && this._joined && peer.pc === pc) {
        this._failPeer(peer, this._peerErrorMessage(peer));
        return false;
      }
      return true;
    } catch {
      // Rollback from a polite glare makes the local offer stale by design.
      if (this._joined && peer.pc === pc && token === peer.localOfferToken) {
        if (recovery) this._recoverPeer(peer);
        else this._failPeer(peer, this._peerErrorMessage(peer));
      }
      return false;
    } finally {
      if (peer.pc === pc) peer.makingOffer = false;
    }
  }

  async _handleOffer(peer, payload, generation) {
    if (typeof payload.sdp !== 'string' || payload.sdp.length === 0 || payload.sdp.length > SDP_MAX_CHARS) {
      return;
    }
    const pc = peer.pc;
    if (!pc) return;

    const collision = peer.makingOffer || pc.signalingState !== 'stable';
    if (collision) {
      if (!peer.polite) {
        peer.ignoreOffer = true;
        peer.queuedCandidates = [];
        return;
      }
      // Perfect negotiation: the lower id (polite side) rolls back its glare.
      peer.localOfferToken += 1;
      if (pc.signalingState === 'have-local-offer') {
        try {
          await pc.setLocalDescription({ type: 'rollback' });
        } catch {
          // A failed rollback is harmless if the offer was never applied.
        }
      }
    }
    peer.ignoreOffer = false;

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      if (!this._joined || generation !== this._joinGeneration || peer.pc !== pc) return;
      await this._flushCandidates(peer);
      if (!this._joined || generation !== this._joinGeneration || peer.pc !== pc) return;
      const answer = await pc.createAnswer();
      if (!this._joined || generation !== this._joinGeneration || peer.pc !== pc) return;
      await pc.setLocalDescription(answer);
      if (
        !this._joined ||
        generation !== this._joinGeneration ||
        peer.pc !== pc ||
        !pc.localDescription ||
        pc.localDescription.type !== 'answer'
      ) {
        return;
      }
      this._sendSignal(peer.id, { kind: 'answer', sdp: pc.localDescription.sdp });
    } catch {
      if (this._joined && peer.pc === pc) this._recoverPeer(peer);
    }
  }

  async _handleAnswer(peer, payload, generation) {
    if (typeof payload.sdp !== 'string' || payload.sdp.length === 0 || payload.sdp.length > SDP_MAX_CHARS) {
      return;
    }
    const pc = peer.pc;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      if (!this._joined || generation !== this._joinGeneration || peer.pc !== pc) return;
      peer.ignoreOffer = false;
      await this._flushCandidates(peer);
    } catch {
      if (this._joined && peer.pc === pc) this._recoverPeer(peer);
    }
  }

  async _handleCandidate(peer, payload, generation) {
    const candidate = normalizeCandidate(payload.candidate);
    if (!candidate) return;
    const pc = peer.pc;
    if (!pc) return;
    if (peer.ignoreOffer) return;

    if (!pc.remoteDescription) {
      if (peer.queuedCandidates.length >= CANDIDATE_BUFFER_MAX) {
        peer.queuedCandidates = [];
        this._recoverPeer(peer);
        return;
      }
      peer.queuedCandidates.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch {
      if (peer.ignoreOffer) return;
    }
    if (!this._isCurrentGeneration(generation) || peer.pc !== pc) return;
  }

  async _flushCandidates(peer) {
    const pc = peer.pc;
    if (!pc || !pc.remoteDescription) return;
    const queued = peer.queuedCandidates;
    peer.queuedCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Stale candidates from before a rollback/restart are expected.
      }
      if (peer.pc !== pc) return;
    }
  }

  _armConnectTimer(peer) {
    this._clearPeerTimer(peer, 'connect');
    peer.timers.connect = setTimeout(() => {
      peer.timers.connect = null;
      if (!this._joined || !peer.pc) return;
      if (peer.connection === 'connected' || peer.pc.connectionState === 'connected') return;
      this._recoverPeer(peer);
    }, CONNECT_TIMEOUT_MS);
  }

  _clearPeerTimer(peer, name) {
    try {
      const timer = peer.timers[name];
      if (timer !== null) clearTimeout(timer);
      peer.timers[name] = null;
    } catch {
      // Ignore timer cleanup failures.
    }
  }

  _clearPeerTimers(peer) {
    if (!peer || !peer.timers) return;
    this._clearPeerTimer(peer, 'connect');
    this._clearPeerTimer(peer, 'disconnect');
    this._clearPeerTimer(peer, 'recovery');
  }

  _handlePeerState(peer) {
    if (!this._joined || !peer || !peer.pc) return;
    const pc = peer.pc;
    const connection = pc.connectionState;
    const ice = pc.iceConnectionState;

    if (connection === 'connected' || ice === 'connected' || ice === 'completed') {
      this._clearPeerTimers(peer);
      peer.recovering = false;
      peer.failureReported = false;
      peer.ignoreOffer = false;
      if (peer.connection !== 'connected') {
        peer.connection = 'connected';
        this._firePeers();
      }
      return;
    }

    if (connection === 'failed' || ice === 'failed') {
      this._recoverPeer(peer);
      return;
    }

    if (connection === 'disconnected' || ice === 'disconnected') {
      if (peer.connection !== 'connecting') {
        peer.connection = 'connecting';
        this._firePeers();
      }
      this._armDisconnectGrace(peer);
      return;
    }

    if (connection === 'closed') {
      this._recoverPeer(peer);
      return;
    }

    if (peer.connection !== 'connecting') {
      peer.connection = 'connecting';
      this._firePeers();
    }
  }

  _armDisconnectGrace(peer) {
    if (!peer || peer.timers.disconnect !== null) return;
    peer.timers.disconnect = setTimeout(() => {
      peer.timers.disconnect = null;
      if (!this._joined || !peer.pc) return;
      if (peer.pc.connectionState === 'connected') return;
      if (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected') {
        this._recoverPeer(peer);
      }
    }, DISCONNECT_GRACE_MS);
  }

  _recoverPeer(peer) {
    try {
      if (!this._joined || !peer || !peer.pc || peer.recovering) return;
      peer.recovering = true;
      this._clearPeerTimers(peer);
      if (peer.connection !== 'connecting') {
        peer.connection = 'connecting';
        this._firePeers();
      }

      if (peer.iceRestarts < 1) {
        peer.iceRestarts += 1;
        this._run(this._startOffer(peer, { iceRestart: true, recovery: true }));
        this._armRecoveryTimer(peer);
        return;
      }

      if (peer.rebuilds < 1) {
        peer.rebuilds += 1;
        // Rebuild closes the old connection before making the replacement, so
        // there is never more than one live RTCPeerConnection for a peer.
        this._rebuildPeer(peer);
        if (peer.pc) this._armRecoveryTimer(peer);
        return;
      }

      peer.recovering = false;
      this._failPeer(peer, this._peerErrorMessage(peer));
    } catch {
      this._failPeer(peer, this._peerErrorMessage(peer));
    }
  }

  _armRecoveryTimer(peer) {
    this._clearPeerTimer(peer, 'recovery');
    peer.timers.recovery = setTimeout(() => {
      peer.timers.recovery = null;
      if (!this._joined || !peer.pc) return;
      if (peer.pc.connectionState === 'connected') return;
      peer.recovering = false;
      this._recoverPeer(peer);
    }, RECOVERY_TIMEOUT_MS);
  }

  _rebuildPeer(peer) {
    try {
      if (!this._joined || !peer) return;
      this._destroyPeerConnection(peer, false);
      this._destroyAnalyser(peer.analyser);
      peer.analyser = null;
      peer.remoteStream = null;
      const el = this._audioEls.get(peer.id);
      if (el) {
        try {
          el.pause();
          el.srcObject = null;
        } catch {
          // Ignore media element reset errors.
        }
      }
      peer.playBlocked = false;
      peer.makingOffer = false;
      peer.ignoreOffer = false;
      peer.recovering = true;
      this._buildPeerConnection(peer);
      if (peer.pc) this._run(this._startOffer(peer, { recovery: true }));
    } catch {
      this._failPeer(peer, this._peerErrorMessage(peer));
    }
  }

  // -------------------------------------------------------------------------
  // Audio elements and speaking detection

  _createSink() {
    try {
      if (this._sink) return;
      const doc = globalThis.document;
      if (!doc || !doc.body) return;
      const sink = doc.createElement('div');
      sink.setAttribute('data-voice-sink', '');
      sink.setAttribute('aria-hidden', 'true');
      sink.style.position = 'fixed';
      sink.style.width = '1px';
      sink.style.height = '1px';
      sink.style.overflow = 'hidden';
      sink.style.opacity = '0';
      sink.style.pointerEvents = 'none';
      sink.style.left = '-9999px';
      doc.body.appendChild(sink);
      this._sink = sink;
    } catch {
      this._sink = null;
    }
  }

  _removeSink() {
    try {
      if (this._sink && this._sink.parentNode) this._sink.parentNode.removeChild(this._sink);
    } catch {
      // Ignore detached sink errors.
    }
    this._sink = null;
  }

  _ensureAudioElement(peer) {
    try {
      if (!peer) return null;
      const existing = this._audioEls.get(peer.id);
      if (existing) return existing;
      if (!this._joined) return null;
      this._createSink();
      if (!this._sink) return null;
      const doc = globalThis.document;
      if (!doc) return null;
      const el = doc.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('autoplay', '');
      el.setAttribute('playsinline', '');
      el.setAttribute('aria-hidden', 'true');
      el.hidden = true;
      el.volume = peer.volume;
      el.muted = !!(peer.hostMuted || peer.localMuted);
      this._sink.appendChild(el);
      this._audioEls.set(peer.id, el);
      if (peer.remoteStream) {
        try {
          el.srcObject = peer.remoteStream;
        } catch {
          // Older engines may not support srcObject.
        }
      }
      return el;
    } catch {
      return null;
    }
  }

  _removeAudioElement(id) {
    try {
      const el = this._audioEls.get(id);
      if (!el) return;
      try {
        el.pause();
        el.srcObject = null;
      } catch {
        // Ignore element teardown errors.
      }
      if (el.parentNode) el.parentNode.removeChild(el);
    } catch {
      // Ignore detached element errors.
    }
    this._audioEls.delete(id);
  }

  _applyPeerAudio(peer) {
    try {
      if (!peer) return;
      const el = this._audioEls.get(peer.id);
      if (!el) return;
      // Host mute is local, UI-level moderation: the server cannot stop P2P
      // media, so each receiver silences a hostMuted peer at the element.
      el.muted = !!(peer.hostMuted || peer.localMuted);
      el.volume = peer.volume;
      if (!peer.hostMuted && !peer.localMuted) this._tryPlay(peer);
    } catch {
      // Element state updates are best effort.
    }
  }

  _tryPlay(peer) {
    try {
      const el = this._audioEls.get(peer.id);
      if (!el || !el.srcObject) return;
      const promise = el.play();
      if (promise && typeof promise.then === 'function') {
        promise
          .then(() => {
            if (peer.playBlocked) {
              peer.playBlocked = false;
              this._firePeers();
            }
          })
          .catch(() => {
            if (!peer.playBlocked) {
              peer.playBlocked = true;
              this._firePeers();
              if (!this._playBlockedNotified) {
                this._playBlockedNotified = true;
                this._info(AR.clickToHear);
              }
            }
          });
      }
    } catch {
      if (!peer.playBlocked) {
        peer.playBlocked = true;
        this._firePeers();
      }
    }
  }

  _ensureAudioContext() {
    try {
      if (this._audioCtx) {
        this._resumeAudioContext();
        return this._audioCtx;
      }
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof Ctor !== 'function') return null;
      this._audioCtx = new Ctor();
      this._resumeAudioContext();
      return this._audioCtx;
    } catch {
      this._audioCtx = null;
      return null;
    }
  }

  _resumeAudioContext() {
    try {
      if (!this._audioCtx || this._audioCtx.state !== 'suspended') return;
      const result = this._audioCtx.resume();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Playback will retry on the next gesture.
    }
  }

  _setupAnalyser(stream) {
    try {
      if (!this._audioCtx || !stream || typeof this._audioCtx.createMediaStreamSource !== 'function') {
        return null;
      }
      if (this._audioCtx.state === 'closed') return null;
      const source = this._audioCtx.createMediaStreamSource(stream);
      const analyser = this._audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      // Pull the analyser through a silent zero-gain sink so it keeps
      // processing in engines that only run graphs connected to destination.
      let silentSink = null;
      if (
        typeof this._audioCtx.createGain === 'function' &&
        this._audioCtx.destination &&
        typeof analyser.connect === 'function'
      ) {
        silentSink = this._audioCtx.createGain();
        silentSink.gain.value = 0;
        analyser.connect(silentSink);
        silentSink.connect(this._audioCtx.destination);
      }
      return {
        source,
        analyser,
        silentSink,
        data: new Uint8Array(analyser.fftSize),
      };
    } catch {
      return null;
    }
  }

  _setupLocalAnalyser() {
    try {
      this._destroyAnalyser(this._localAnalyser);
      this._localAnalyser = this._setupAnalyser(this._localStream);
    } catch {
      this._localAnalyser = null;
    }
  }

  _destroyAnalyser(bundle) {
    if (!bundle) return;
    try {
      if (bundle.source) bundle.source.disconnect();
    } catch {
      // Ignore already-disconnected nodes.
    }
    try {
      if (bundle.analyser) bundle.analyser.disconnect();
    } catch {
      // Ignore already-disconnected nodes.
    }
    try {
      if (bundle.silentSink) bundle.silentSink.disconnect();
    } catch {
      // Ignore already-disconnected nodes.
    }
  }

  _startSpeakingPoll() {
    if (!this._joined || this._speakTimer !== null) return;
    const doc = globalThis.document;
    if (doc && doc.hidden) return;
    this._speakTimer = setInterval(() => this._pollSpeaking(), SPEAKING_POLL_MS);
  }

  _stopSpeakingPoll() {
    if (this._speakTimer !== null) {
      clearInterval(this._speakTimer);
      this._speakTimer = null;
    }
  }

  _pollSpeaking() {
    try {
      if (this._disposed || !this._joined) return;
      const doc = globalThis.document;
      if (doc && doc.hidden) return;

      if (this._effectiveMuted()) {
        this._setLocalSpeaking(false);
      } else {
        const speaking = this._readSpeaking(this._localAnalyser, this._localSpeaking, false);
        this._setLocalSpeaking(speaking);
      }

      for (const peer of this._peers.values()) {
        if (peer.hostMuted || peer.localMuted) {
          this._setPeerSpeaking(peer, false);
          continue;
        }
        const speaking = this._readSpeaking(peer.analyser, peer.speaking, false);
        this._setPeerSpeaking(peer, speaking);
      }
    } catch {
      // Polling failures are non-fatal; the timer continues.
    }
  }

  _readSpeaking(bundle, wasSpeaking, forceOff) {
    if (forceOff || !bundle || !bundle.analyser || !bundle.data) return false;
    try {
      bundle.analyser.getByteTimeDomainData(bundle.data);
      let sum = 0;
      for (let index = 0; index < bundle.data.length; index += 1) {
        const sample = (bundle.data[index] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / bundle.data.length);
      return wasSpeaking ? rms >= SPEAKING_OFF_RMS : rms >= SPEAKING_ON_RMS;
    } catch {
      return false;
    }
  }

  _setLocalSpeaking(on) {
    const next = on === true;
    if (this._localSpeaking === next) return;
    this._localSpeaking = next;
    this._fireSelf();
    this._fireHook('onSpeaking', this._selfId, next);
  }

  _setPeerSpeaking(peer, on) {
    if (!peer) return;
    const next = on === true;
    if (peer.speaking === next) return;
    peer.speaking = next;
    this._fireHook('onSpeaking', peer.id, next);
  }

  // -------------------------------------------------------------------------
  // Gesture and visibility guards

  _installActivityGuards() {
    try {
      if (!this._joined) return;
      this._removeActivityGuards();
      const win = globalThis.window;
      if (win && typeof win.addEventListener === 'function') {
        this._windowBlurHandler = () => this.setTalking(false);
        win.addEventListener('blur', this._windowBlurHandler);
      }
      const doc = globalThis.document;
      if (doc && typeof doc.addEventListener === 'function') {
        this._visibilityHandler = () => {
          if (doc.hidden) {
            this.setTalking(false);
            this._stopSpeakingPoll();
          } else if (this._joined) {
            this._startSpeakingPoll();
          }
        };
        doc.addEventListener('visibilitychange', this._visibilityHandler);
      }
    } catch {
      // Gesture guards are optional; setTalking still works.
    }
  }

  _removeActivityGuards() {
    try {
      const win = globalThis.window;
      if (win && this._windowBlurHandler && typeof win.removeEventListener === 'function') {
        win.removeEventListener('blur', this._windowBlurHandler);
      }
    } catch {
      // Ignore listener cleanup failures.
    }
    try {
      const doc = globalThis.document;
      if (doc && this._visibilityHandler && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', this._visibilityHandler);
      }
    } catch {
      // Ignore listener cleanup failures.
    }
    this._windowBlurHandler = null;
    this._visibilityHandler = null;
  }

  // -------------------------------------------------------------------------
  // Teardown and hooks

  _cancelPendingAcks() {
    for (const cancel of Array.from(this._ackCancels)) {
      try {
        cancel();
      } catch {
        // Each cancellation resolves its own promise.
      }
    }
    this._ackCancels.clear();
  }

  _teardownSession(status, notify) {
    try {
      this._cancelPendingAcks();
      if (this._configAbort) {
        try {
          this._configAbort.abort();
        } catch {
          // Ignore an already-completed fetch.
        }
        this._configAbort = null;
      }
      this._joined = false;
      this._muted = false;
      this._hostMuted = false;
      this._talking = false;
      this._localSpeaking = false;
      this._status = status;
      this._pendingSignals = [];
      this._rosterOrder = [];
      this._lastRoster = null;
      this._recaptureAttempted = false;
      this._playBlockedNotified = false;
      this._stopSpeakingPoll();
      this._removeActivityGuards();
      this._clearLocalTrackBindings();
      if (this._localStream) {
        this._stopStream(this._localStream);
        this._localStream = null;
      }
      this._destroyAnalyser(this._localAnalyser);
      this._localAnalyser = null;

      for (const peer of this._peers.values()) {
        this._destroyPeerConnection(peer, true);
        this._destroyAnalyser(peer.analyser);
        peer.analyser = null;
      }
      this._peers.clear();
      for (const id of Array.from(this._audioEls.keys())) this._removeAudioElement(id);
      this._audioEls.clear();
      this._removeSink();

      if (notify) {
        this._fireSelf();
        this._firePeers();
      }
    } catch {
      // Teardown is idempotent; force the quiet state below.
      this._joined = false;
      this._localStream = null;
      this._peers.clear();
      this._audioEls.clear();
      this._sink = null;
      this._status = status;
    }
  }

  _closeAudioContext() {
    try {
      if (this._audioCtx && typeof this._audioCtx.close === 'function') {
        const result = this._audioCtx.close();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch {
      // Ignore close failures.
    }
    this._audioCtx = null;
  }

  _info(message) {
    if (!message) return;
    this._fireHook('onInfo', message);
  }

  _notifyError(message) {
    if (!message) return;
    this._fireHook('onError', message);
  }

  _reportError(message, status) {
    if (!message) return;
    if (status) this._status = status;
    this._fireHook('onError', message);
    this._fireSelf(message);
  }

  _fireSelf(error = null) {
    this._fireHook('onSelf', {
      joined: this._joined,
      muted: this._muted,
      hostMuted: this._hostMuted,
      speaking: this._localSpeaking,
      status: this._status,
      error: typeof error === 'string' ? error : null,
    });
  }

  _firePeers() {
    try {
      const list = this.peers;
      this._fireHook('onPeers', list);
    } catch {
      // Hook callbacks are isolated.
    }
  }

  _fireHook(name, ...args) {
    try {
      const hook = this._hooks ? this._hooks[name] : null;
      if (typeof hook !== 'function') return;
      const result = hook(...args);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      // User hooks can never break the engine.
    }
  }

  _run(promise) {
    try {
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch {
      // A thenable that throws in catch is simply ignored.
    }
  }
}
