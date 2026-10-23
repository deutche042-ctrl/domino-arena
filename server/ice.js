// server/ice.js — ICE servers for the WebRTC voice mesh.
//
// STUN only discovers addresses; it cannot relay media. Two players behind
// different NATs (mobile CGNAT, symmetric NAT) stay silent unless a TURN relay
// is offered — which is exactly why voice worked on the LAN and failed across
// networks. Credentials are minted per request and expire on their own, so no
// long-lived secret ever reaches the browser.
//
// Runs unchanged in Node (>=18, globalThis.crypto + fetch) and in the
// Cloudflare Worker (WebCrypto), so both hosts serve the same list.

// Cloudflare Realtime TURN. A TURN key is created in the dashboard
// (Realtime -> TURN) and yields a key id + an API token that stays server-side.
const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

const TURN_URL_RE = /^turns?:[^\s,]+$/i;

// Cloudflare mints a fresh batch per call; keep it for most of its lifetime so
// every voice join does not pay for an extra API round trip.
let cfCache = { keyId: '', servers: null, expires: 0 };

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function ttlSeconds(value) {
  const n = Number(value);
  const ttl = Number.isFinite(n) && n > 0 ? n : 3600;
  return Math.min(86400, Math.max(60, Math.round(ttl)));
}

function splitTurnUrls(raw) {
  return String(raw || '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => TURN_URL_RE.test(u));
}

/** base64(HMAC-SHA1(secret, message)) — the coturn ephemeral-credential format. */
async function hmacSha1Base64(secret, message) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable');
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, encoder.encode(message));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Cloudflare Realtime TURN credentials. `CF_TURN_KEY_TOKEN` is the API token
 * shown next to the key; the older HMAC-style keys exported a `secret`, so
 * `CF_TURN_KEY_SECRET` is still accepted and handled locally.
 */
async function cloudflareServers(env, ttl) {
  const keyId = text(env.CF_TURN_KEY_ID) || text(env.TURN_KEY_ID);
  const apiToken = text(env.CF_TURN_KEY_TOKEN);
  const secret = text(env.CF_TURN_KEY_SECRET) || text(env.TURN_KEY_SECRET);
  if (!keyId) return [];

  if (apiToken) {
    const now = Date.now();
    if (cfCache.keyId === keyId && cfCache.servers && cfCache.expires > now) return cfCache.servers;
    const res = await fetch(`${CF_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    });
    if (!res.ok) throw new Error(`cloudflare turn ${res.status}`);
    const data = await res.json();
    const servers = Array.isArray(data?.iceServers) ? data.iceServers : [];
    cfCache = { keyId, servers, expires: now + Math.max(60, ttl - 120) * 1000 };
    return servers;
  }

  if (secret) {
    // Legacy key: username = <expiry>:<key id>, credential = base64 HMAC-SHA1.
    const username = `${nowSeconds() + ttl}:${keyId}`;
    return [{
      urls: [
        'stun:stun.cloudflare.com:3478',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username,
      credential: await hmacSha1Base64(secret, username),
    }];
  }

  return [];
}

/**
 * ICE server list for RTCPeerConnection. Empty when nothing is configured —
 * the client then keeps its built-in STUN defaults.
 */
export async function iceServers(env = {}) {
  const ttl = ttlSeconds(env.TURN_TTL);
  const out = [];

  try {
    out.push(...await cloudflareServers(env, ttl));
  } catch (err) {
    console.warn('[ice] cloudflare turn unavailable:', err?.message || err);
  }

  // Any coturn-style relay (own VPS or a hosted TURN service).
  const urls = splitTurnUrls(env.TURN_URLS);
  if (urls.length) {
    const secret = text(env.TURN_SECRET);
    if (secret) {
      const username = `${nowSeconds() + ttl}:domino`;
      out.push({ urls, username, credential: await hmacSha1Base64(secret, username) });
    } else {
      const username = text(env.TURN_USER);
      const credential = text(env.TURN_PASS);
      if (username && credential) out.push({ urls, username, credential });
    }
  }

  return out;
}
