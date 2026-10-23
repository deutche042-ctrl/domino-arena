// worker/src/index.js
// Cloudflare Worker entry: WebSocket traffic and the three JSON endpoints go to
// the game Durable Object; everything else is a static file from public/.

import { DominoGame } from './do.js';

export { DominoGame };

const API_PATHS = new Set(['/healthz', '/host-info', '/voice-config']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wantsSocket = url.pathname.startsWith('/socket.io');
    const wantsApi = API_PATHS.has(url.pathname);

    if (wantsSocket || wantsApi) {
      const id = env.GAME.idFromName('global');
      return env.GAME.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
