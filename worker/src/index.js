// worker/src/index.js
// Cloudflare Worker entry: WebSocket traffic and the JSON endpoints go to the
// game Durable Object; everything else is a static file from public/.
//
// `/voice-config` is answered right here instead of inside the Durable Object:
// TURN credentials come from the Worker's own secrets/vars, which are not
// visible to the shimmed server's process.env.

import { DominoGame } from './do.js';
import { iceServers } from '../../server/ice.js';

export { DominoGame };

// `/voice-config` is handled below, so it never reaches the Durable Object.
const API_PATHS = new Set(['/healthz', '/host-info']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wantsSocket = url.pathname.startsWith('/socket.io');
    const wantsApi = API_PATHS.has(url.pathname);

    if (url.pathname === '/voice-config') {
      let servers = [];
      try {
        servers = await iceServers(env);
      } catch (err) {
        console.warn('voice-config failed:', err?.message || err);
      }
      return new Response(JSON.stringify({ iceServers: servers }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache, no-store, must-revalidate',
        },
      });
    }

    if (wantsSocket || wantsApi) {
      const id = env.GAME.idFromName('global');
      return env.GAME.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
