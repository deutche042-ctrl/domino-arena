// worker/src/shims/socketio.js
// A Socket.IO-compatible server shim that runs on a raw WebSocket.
//
// Why: the game server (server/server.js) is written against the socket.io
// server API, and the client (public/js/) is the real socket.io-client. Keeping
// the wire protocol compatible means neither side changes: the same client
// talks to the Node server at home and to this Worker on Cloudflare.
//
// Implemented protocol subsets:
//   Engine.IO v4  — handshake ('0'), ping ('2') / pong ('3'), message ('4'), close ('1')
//   Socket.IO v5  — CONNECT ('40'), DISCONNECT ('41'), EVENT ('42'), ACK ('43')
// Only the websocket transport is served (the client lists websocket first).

const PING_INTERVAL_MS = 25000;
const PING_TIMEOUT_MS = 20000;

const SIO_CONNECT = '0';
const SIO_DISCONNECT = '1';
const SIO_EVENT = '2';
const SIO_ACK = '3';

function newSocketId() {
  return 'ws-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/** Broadcast handle returned by io.to(...) / socket.to(...). */
class BroadcastOperator {
  constructor(io, rooms, except) {
    this.io = io;
    this.rooms = rooms;
    this.except = except;
  }
  emit(event, ...args) {
    const targets = [...this.io._resolve(this.rooms)];
    for (const socket of targets) {
      if (socket !== this.except && socket.connected) socket.emit(event, ...args);
    }
  }
}

class Socket {
  constructor(io, send, remoteAddress) {
    this.io = io;
    this.id = newSocketId();
    this.connected = false;
    this.disconnected = false;
    this.rooms = new Set([this.id]);
    this.data = {};
    this.handshake = { address: remoteAddress, headers: {}, query: {} };
    this._send = send;
    this._listeners = new Map();
    this._middlewares = [];
    this._pendingAcks = new Map();
    this._ackSeq = 0;
    this._disconnectHandlers = [];
  }

  on(event, handler) {
    const list = this._listeners.get(event);
    if (list) list.push(handler);
    else this._listeners.set(event, [handler]);
    return this;
  }

  off(event, handler) {
    const list = this._listeners.get(event);
    if (list && handler) this._listeners.set(event, list.filter((h) => h !== handler));
    return this;
  }

  use(middleware) {
    this._middlewares.push(middleware);
    return this;
  }

  /** socket.io's ack dictation: the reply id is the last element of the packet. */
  _ackFor(ackId) {
    if (ackId === null) return undefined;
    return (...replyArgs) => this._send('43' + ackId + JSON.stringify(replyArgs));
  }

  emit(event, ...args) {
    if (this.disconnected) return this;
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    // An event sent with no arguments must reach the client with no arguments:
    // ["ev"] and not ["ev", null] — socket.io clients tell the two apart.
    const packet = args.length === 0 ? [event] : args.length === 1 ? [event, args[0]] : [event, ...args];
    if (ack) {
      const ackId = ++this._ackSeq;
      this._pendingAcks.set(ackId, ack);
      // Socket.IO v5 keeps the ack id in the packet header: 42<id>[...args]
      this._send('42' + ackId + JSON.stringify(packet));
    } else {
      this._send('42' + JSON.stringify(packet));
    }
    return this;
  }

  join(room) {
    this.io._join(this, room);
    return this;
  }

  leave(room) {
    this.io._leave(this, room);
    return this;
  }

  to(room) {
    return new BroadcastOperator(this.io, [room], this);
  }

  disconnect() {
    this.io._close(this, 'server namespace disconnect');
    return this;
  }

  _dispatch(event, args, ackId) {
    const ack = this._ackFor(ackId);
    const packet = [event, ...args];
    let index = -1;
    const runNext = () => {
      index += 1;
      const middleware = this._middlewares[index];
      if (!middleware) return this._deliver(event, args, ack);
      try {
        middleware(packet, (err) => {
          if (err) return ack ? ack({ ok: false, error: 'invalid payload' }) : undefined;
          return runNext();
        });
      } catch (err) {
        this.io._log('middleware error', err && err.message);
      }
      return undefined;
    };
    runNext();
  }

  _deliver(event, args, ack) {
    const list = this._listeners.get(event) || [];
    if (list.length === 0) {
      this.io._log(`no handler for "${event}" (connected=${this.connected})`);
      if (ack) ack({ ok: false, error: 'unknown event' });
      return;
    }
    for (const handler of list) {
      try {
        if (ack) handler(...args, ack);
        else handler(...args);
      } catch (err) {
        this.io._log(`handler ${event} threw: ${err && err.stack ? err.stack : err}`);
      }
    }
  }
}

class Server {
  constructor(httpServer, options) {
    this.options = options || {};
    this._sockets = new Map();
    this._rooms = new Map();
    this._connectionHandlers = [];
    this._log = (...args) => console.log('[socket.io shim]', ...args);
    this._pingTimer = null;
    this.sockets = { sockets: this._sockets };
    this._httpServer = httpServer || null;
    if (this._httpServer) this._httpServer.__io = this;
    recordServer(this);
  }

  on(event, handler) {
    if (event === 'connection') this._connectionHandlers.push(handler);
    return this;
  }

  to(room) {
    return new BroadcastOperator(this, [room], null);
  }

  in(room) {
    return this.to(room);
  }

  _resolve(rooms) {
    const out = new Set();
    for (const room of rooms) {
      if (this._sockets.has(room)) out.add(this._sockets.get(room));
      const members = this._rooms.get(room);
      if (members) for (const socket of members) out.add(socket);
    }
    return out;
  }

  _join(socket, room) {
    let members = this._rooms.get(room);
    if (!members) {
      members = new Set();
      this._rooms.set(room, members);
    }
    members.add(socket);
    socket.rooms.add(room);
  }

  _leave(socket, room) {
    const members = this._rooms.get(room);
    if (members) {
      members.delete(socket);
      if (members.size === 0) this._rooms.delete(room);
    }
    socket.rooms.delete(room);
  }

  /** Register a freshly upgraded socket and hand it the Engine.IO open packet. */
  _attach(send, remoteAddress) {
    const socket = new Socket(this, send, remoteAddress);
    this._sockets.set(socket.id, socket);
    this._send(socket, `0${JSON.stringify({
      sid: socket.id,
      upgrades: [],
      pingInterval: PING_INTERVAL_MS,
      pingTimeout: PING_TIMEOUT_MS,
      maxPayload: 1000000,
    })}`);
    return socket;
  }

  /** The client's Socket.IO CONNECT packet opens the namespace and fires 'connection'. */
  _open(socket) {
    if (socket.connected || socket.disconnected) return;
    socket.connected = true;
    this._send(socket, `40{"sid":${JSON.stringify(socket.id)}}`);
    for (const handler of this._connectionHandlers) {
      try {
        handler(socket);
      } catch (err) {
        this._log('connection handler threw:', err && err.message);
      }
    }
  }

  _send(socket, frame) {
    try {
      socket._send(frame);
    } catch (err) {
      this._log('send failed:', err && err.message);
    }
  }

  /** One inbound Engine.IO frame from the client. */
  message(socket, raw) {
    const type = raw[0];
    if (type === '2') {
      this._send(socket, '3' + raw.slice(1));
      return;
    }
    if (type === '3' || type === '6') return;
    if (type === '1') {
      this._close(socket, 'client close');
      return;
    }
    if (type !== '4') return;
    const sub = raw[1];
    if (sub === SIO_CONNECT) {
      this._open(socket);
      return;
    }
    if (sub === SIO_DISCONNECT) {
      this._close(socket, 'client namespace disconnect');
      return;
    }
    if (sub === SIO_EVENT) {
      // 42[...args] when the sender wants no reply, 42<id>[...args] when it does:
      // the ack id lives in the packet header, not inside the payload array.
      const rest = raw.slice(2);
      const header = /^(\d*)([\s\S]*)$/.exec(rest);
      if (!header) return;
      const ackId = header[1] === '' ? null : Number(header[1]);
      let data;
      try {
        data = JSON.parse(header[2]);
      } catch (err) {
        this._log('unparsable event frame:', raw.slice(0, 120));
        return;
      }
      if (!Array.isArray(data) || typeof data[0] !== 'string') {
        this._log('unexpected event payload:', raw.slice(0, 120));
        return;
      }
      return socket._dispatch(data[0], data.slice(1), ackId);
    }
    if (sub === SIO_ACK) {
      const match = /^(\d+)([\s\S]*)$/.exec(raw.slice(2));
      if (!match) return;
      const ackId = Number(match[1]);
      const pending = socket._pendingAcks.get(ackId);
      if (!pending) return;
      socket._pendingAcks.delete(ackId);
      let args = [];
      try {
        args = JSON.parse(match[2] || '[]');
      } catch (err) {
        args = [];
      }
      try {
        pending(...args);
      } catch (err) {
        this._log('ack handler threw:', err && err.message);
      }
    }
  }

  _close(socket, reason) {
    if (socket.disconnected) return;
    socket.disconnected = true;
    socket.connected = false;
    this._sockets.delete(socket.id);
    for (const room of socket.rooms) this._leave(socket, room);
    const list = socket._listeners.get('disconnect') || [];
    for (const handler of list) {
      try {
        handler(reason);
      } catch (err) {
        this._log('disconnect handler threw:', err && err.message);
      }
    }
  }

  /** Engine.IO server ping, so the client's pingTimeout keeps being fed. */
  startPinging() {
    if (this._pingTimer) return;
    this._pingTimer = setInterval(() => {
      for (const socket of this._sockets.values()) this._send(socket, '2');
    }, PING_INTERVAL_MS);
  }

  stopPinging() {
    if (!this._pingTimer) return;
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  get connectionCount() {
    return this._sockets.size;
  }
}

// The game server never imports this module by name — esbuild aliases
// 'socket.io' to it — so it has to expose the created instance for the Worker.
let lastServer = null;
function recordServer(server) {
  lastServer = server;
}
function getLastServer() {
  return lastServer;
}

export { Server, Socket, recordServer, getLastServer };
export default { Server, recordServer, getLastServer };
