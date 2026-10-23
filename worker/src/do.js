// worker/src/do.js
// The Durable Object that runs the real game server.
//
// server/server.js is imported unchanged: express and socket.io are aliased to
// the shims in src/shims/, a fake node:http server satisfies its listen() call,
// and the shims hand back the express app + socket.io instance built during
// that import. Everything the server keeps in memory (rooms, players, chat,
// timers) lives here, in one named instance, exactly like the single Node
// process it replaces.
//
// One Durable Object for every room keeps the existing cross-room logic
// (room cap, lobby sweeping, socket lookups) working with no changes.

import { getLastServer } from './shims/node-http.js';

// ── guards that must exist before the game server is evaluated ────────────────
// server.js registers process-level error handlers; Workers provide a partial
// process object, so make the call a no-op instead of an import-time crash.
function installProcessGuards() {
  try {
    if (typeof process !== 'undefined' && typeof process.on !== 'function') {
      process.on = () => process;
    }
  } catch {
    /* frozen process object — nothing to patch */
  }
}

// The game server starts a lobby-sweeping interval at import time. Workers
// forbid timers in global scope, so intervals created during the import are
// parked here and started for real once the first socket arrives, then stopped
// when the last one leaves — which is also what lets this object be evicted
// while nobody is playing.
const deferredIntervals = [];
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);
let intervalsRunning = false;

globalThis.setInterval = (fn, ms, ...rest) => {
  const entry = { fn, ms: Math.max(Number(ms) || 1000, 1000), handle: null };
  if (intervalsRunning) entry.handle = realSetInterval(entry.fn, entry.ms, ...rest);
  deferredIntervals.push(entry);
  // Node's unref/ref are called on interval handles; a parked interval is
  // already "unref'd" by definition, so both are no-ops.
  return {
    __deferredInterval: entry,
    unref() {
      return this;
    },
    ref() {
      return this;
    },
  };
};

globalThis.clearInterval = (handle) => {
  if (handle && handle.__deferredInterval) {
    handle.__deferredInterval.cancelled = true;
    if (handle.__deferredInterval.handle) realClearInterval(handle.__deferredInterval.handle);
    handle.__deferredInterval.handle = null;
    return;
  }
  realClearInterval(handle);
};

function startDeferredIntervals() {
  if (intervalsRunning) return;
  intervalsRunning = true;
  for (const entry of deferredIntervals) {
    if (entry.cancelled || entry.handle) continue;
    entry.handle = realSetInterval(entry.fn, entry.ms);
  }
}

function stopDeferredIntervals() {
  if (!intervalsRunning) return;
  intervalsRunning = false;
  for (const entry of deferredIntervals) {
    if (entry.handle) realClearInterval(entry.handle);
    entry.handle = null;
  }
}

installProcessGuards();

// Importing this evaluates server/server.js: it builds the express app, creates
// the socket.io shim Server, registers every handler and calls listen().
const gameServerModule = await import('./game-server.js');
const gameServer = gameServerModule.getGameServer();

const API_PATHS = new Set(['/healthz', '/host-info', '/voice-config']);

export class DominoGame {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.io = gameServer.io;
    this.app = gameServer.app;
  }

  /** Routes both the Socket.IO upgrade and the three JSON endpoints. */
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/socket.io')) return this.handleUpgrade(request);
    if (API_PATHS.has(url.pathname)) {
      try {
        return await this.app.__dispatch(request);
      } catch (err) {
        return new Response(JSON.stringify({ error: 'internal' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('Not Found', { status: 404 });
  }

  handleUpgrade(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const address =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '0.0.0.0';
    const socket = this.io._attach((frame) => {
      try {
        server.send(frame);
      } catch {
        /* closing socket — the close event cleans up */
      }
    }, address);

    server.addEventListener('message', (event) => {
      const raw = String(event.data);
      try {
        this.io.message(socket, raw);
      } catch (err) {
        console.error('[domino] message failed:', err && err.stack ? err.stack : err);
      }
    });
    server.addEventListener('close', () => {
      this.io._close(socket, 'transport close');
      if (this.io.connectionCount === 0) stopDeferredIntervals();
    });
    server.addEventListener('error', () => {
      this.io._close(socket, 'transport error');
      if (this.io.connectionCount === 0) stopDeferredIntervals();
    });

    this.io.startPinging();
    startDeferredIntervals();
    return new Response(null, { status: 101, webSocket: client });
  }
}
