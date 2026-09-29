# 🁢 Domino Arena

Real-time online dominoes for 2–4 players. Play in the browser — hosted free on Render, or on your PC, or offline on phones. No installs, no accounts.

## Play free 24/7 on Render (the easy way)

1. Push this repo to GitHub → [Render](https://render.com) → **New +** → **Blueprint** → pick the repo (it reads `render.yaml`)
2. Render builds and starts the server, printing `https://<app>.onrender.com`
3. Send that URL to your friends — https included, so voice chat works everywhere
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
- Centre-pulse turn hint, arced tile placement, animated score roll-up — all respecting `prefers-reduced-motion`
- Home stats (`localStorage`): matches, wins, win streak, average/best score, recent form
- Graceful 2D DOM fallback table when WebGL is unavailable — the game stays fully playable on weak devices

## Play on phones, offline (Android APK)

The game ships as an Android app (`mobile/`). On a hotspot or LAN with **no internet**:

1. Install the APK on every phone (allow "install from unknown apps" the first time).
2. Open the app on all phones — every phone runs its own game server and connects to itself
   (it shows "أنت مضيف الشبكة"). Rooms belong to the phone that created them.
3. Other players appear automatically under **الأجهزة القريبة** (nearby devices) on the home
   screen — tap a phone to join its room's server. No typing needed on the same subnet.
   You can also type an address manually (e.g. `192.168.43.5:3000`).
4. One player creates a room and shares the 4-letter code; the rest join that server and
   enter the code. Chat works; mic works only on https/localhost (voice → use the Render URL).
5. If Android shows "no internet on this Wi-Fi" on the hotspot, tap **keep connection** —
   the game needs the hotspot only as a network, not the internet.

Notes:
- There is **no elected host**: every phone hosts itself. If a player's app is killed, only
  their room ends — everyone else keeps playing.
- Discovery beeps over UDP broadcast; if a ROM blocks it, phones fall back to a TCP sweep of
  the subnet automatically.
- The hotspot itself caps how many phones can join (typically 10–30 depending on the phone).
- Solo vs bots works fully offline (airplane mode).
- A PC running `npm start` on the same LAN won't broadcast, so it won't appear in the phone
  list — join it via the manual address field instead.

Build the APK yourself (Windows, one-time): JDK 21 + Android SDK (NDK + CMake), then
`cd mobile && npm install && npm run apk:release` (signing: `DOMINO_STORE`, `DOMINO_STORE_PASS`,
`DOMINO_KEY_PASS` env vars + `mobile/keystore/domino-release.jks`).

## Dev

```bash
npm install
npm test            # engine unit tests (25)
npm run e2e 3100    # full protocol test against a running server on :3100
npm run e2e:voice 3100
```

Stack: Node.js + Express + Socket.IO · vanilla JS + Three.js (vendored, offline) · no build step
for the web client; the Android app bundles the same server via esbuild (see `mobile/`).
