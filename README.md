# 🁢 Domino Arena

Real-time online dominoes for 2–4 players. Play in the browser — hosted free on Render, or on your PC. No installs, no accounts.

> 📘 **دليل التشغيل والنشر الكامل (GitHub + Cloudflare):** [USAGE_AND_DEPLOYMENT.md](USAGE_AND_DEPLOYMENT.md)

## Play free 24/7 on Render (the easy way)

1. Push this repo to GitHub → [Render](https://render.com) → **New +** → **Blueprint** → pick the repo (it reads `render.yaml`)
2. Render builds and starts the server, printing `https://<app>.onrender.com`
3. Send that URL to your friends — https included
4. Free-tier instances sleep after 15 min idle, so ping it free: create a cron-job.org monitor hitting `https://<app>.onrender.com/healthz` every 5 minutes — it stays awake 24/7 at zero cost

## Play with friends from your PC

1. Double-click **`play.bat`**
2. It starts the game server and opens a Cloudflare Tunnel
3. Copy the `https://....trycloudflare.com` URL it prints and send it to your friends
4. Everyone opens the URL → enter a name → **Create Room** (you) → friends **Join** with the 4-letter code (or use the "Copy invite link" button in the lobby)
5. Everyone hits **Ready** → host starts the game

Manual start:

```bash
node server/server.js                                  # game on http://localhost:3000
cloudflared tunnel --url http://localhost:3000         # public URL
```

## Games

| Variant | Rules |
|---|---|
| **Block** | Classic. No drawing — stuck? Pass. Hand winner scores all pips left in opponents' hands. First to 100. |
| **Draw** | Stuck? Draw from the boneyard until you can play. First to 100. |
| **All Fives** | Open ends summing to a multiple of 5 score **instantly**. First double is the **spinner** — grows 4 arms! First to 250. |

## Features

- 3D table (Three.js): textured tiles, shadows, snake layout, camera auto-fit, drag to rotate / scroll to zoom
- Tap a tile → legal ends glow green → tap the glowing spot to place
- Rooms with 4-letter codes, invite links, ready states, host settings
- Server-authoritative (opponent hands never leave the server), reconnect with token
- Live scoreboard, turn glow, score toasts, synthesized sound effects
- Chat + floating emoji reactions, confetti podium, rematch
- 4 tile skins (classic / neon / wood / piano) and 3 bot personalities (balanced / aggressive / defensive) across 4 skill levels, including an "expert" with a one-ply lookahead
- Arced tile placement, animated score roll-up — all respecting `prefers-reduced-motion`
- Home stats (`localStorage`): matches, wins, win streak, average/best score, recent form
- Graceful 2D DOM fallback table when WebGL is unavailable — the game stays fully playable on weak devices

## Dev

```bash
npm install
npm test            # engine unit tests (25)
npm run e2e 3100    # full protocol test against a running server on :3100
```

Stack: Node.js + Express + Socket.IO · vanilla JS + Three.js (vendored, offline) · no build step, no client dependencies.

## Deploy 24/7 free on Cloudflare (Workers + Durable Object)

The whole game server runs on Cloudflare's free plan — no card, no sleep. It needs no
rewrite: `worker/` bundles the same `server/server.js` and `engine/`, with small shims
(`worker/src/shims/`) standing in for express, socket.io, `node:http` and `node:os`. The same
client, the same engine and the same handlers therefore run both at home (`npm start`) and in
the cloud.

```bash
cd worker
npm install
npm run build          # bundles dist/worker.js
npx wrangler login     # or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npm run deploy         # https://domino-arena.<your-subdomain>.workers.dev
```

Notes:

- `public/` is served by the Worker's assets binding; `/socket.io` is handled by the
  `DominoGame` Durable Object, which keeps every room in memory exactly like the single Node
  process does.
- Free-plan Durable Objects require the SQLite backend (`new_sqlite_classes`).
- A code deploy disconnects live sockets; clients reconnect on their own.
- Verify a deployment end to end from the repo root:

```bash
DOMINO_URL=https://domino-arena.<your-subdomain>.workers.dev node scripts/e2e.js
```
