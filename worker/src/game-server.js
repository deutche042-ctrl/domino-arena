// worker/src/game-server.js
// Runs the real game server inside the Worker's module graph.
//
// The import below is the untouched server/server.js. esbuild rewrites its
// 'express', 'socket.io', 'node:http' and 'node:os' imports to the shims in
// src/shims/, so evaluating it builds the express app, creates the socket.io
// shim Server, registers every handler and "listens" on a fake server. The
// shims record what they built; this module hands those instances back.

import { getLastServer } from './shims/node-http.js';
import '../../server/server.js';

let cached = null;

function getGameServer() {
  if (cached) return cached;
  const http = getLastServer();
  if (!http || !http.__io) {
    throw new Error('game server did not initialise: no socket.io instance was created');
  }
  cached = { http, app: http.__handler, io: http.__io };
  return cached;
}

export { getGameServer };
