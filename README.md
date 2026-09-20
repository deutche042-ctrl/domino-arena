# 🁢 Domino Arena

Real-time online dominoes for 2–4 players. Host on your PC, share one URL via Cloudflare Tunnel, play in the browser — no installs, no accounts.

## Play with friends (the easy way)

1. Double-click **`play.bat`**
2. It starts the game server and opens a Cloudflare Tunnel
3. Copy the `https://....trycloudflare.com` URL it prints and send it to your friends
4. Everyone opens the URL → enter a name → **Create Room** (you) → friends **Join** with the 4-letter code (or use the "Copy invite link" button in the lobby)
5. Everyone hits **Ready** → host starts the game

## Manual start

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

## Dev

```bash
npm install
npm test          # engine unit tests (17)
npm run e2e 3100  # full protocol test against a running server on :3100
```

Stack: Node.js + Express + Socket.IO · vanilla JS + Three.js (CDN) · no build step.
