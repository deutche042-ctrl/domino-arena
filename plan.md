# 🁢 DOMINO ARENA — Online Multiplayer Domino Game

**Goal:** A polished, real-time domino game you host locally, expose via a Cloudflare Tunnel, and play with friends — everyone opens the same URL in their browser, no installs, no accounts.

---

## 1. Product Vision

- One URL shared with friends → instant lobby → play dominoes together (2–4 players).
- Server-authoritative: the host's machine runs the "game brain", all players are thin clients. No cheating by inspecting the browser.
- "So cool" UI: dark casino-felt table, 3D-styled tiles, smooth deal/place animations, turn glow, live score, sounds, chat, emoji reactions.
- Zero build step, zero database, zero accounts. Runs with `node server.js` + `cloudflared tunnel --url http://localhost:3000`.

---

## 2. Game Rules Deep-Dive (verified against pagat.com)

We implement a **double-six set (28 tiles)** with 3 selectable variants:

### 2.1 Block Dominoes (classic, simplest — default)

- 2 players: 7 tiles each; 3–4 players: 5 tiles each. Rest = boneyard (not drawn from in Block).
- First hand: player with the **highest double** leads it (fallback: highest pip tile). Later hands: winner of previous hand leads.
- On turn: place a tile matching an open end. **Cannot play → pass.**
- Hand ends when a player **dominoes** (empties hand) or all players are blocked.
- Scoring: winner of the hand scores **total pips left in opponents' hands**.
- Match target: **100 points** (configurable 50/100/150/250).

### 2.2 Draw Dominoes

- Same as Block, except: cannot play → **must draw from boneyard until you get a playable tile**; if boneyard is empty → pass.
- Optional house rule toggle: last 2 boneyard tiles can never be drawn.

### 2.3 All Fives (Muggins / Five-Up — the "gamer's" variant)

- Hand size: 2P→7 (or 9), 3P→7, 4P→5 tiles (configurable).
- After every placement, **sum all open ends**; if the sum is a multiple of 5 (5,10,15…35), the player **immediately scores** that many points.
- **Doubles are played crosswise** and count full pip total while on an open end.
- **Spinner:** the *first double played* becomes the spinner — after its two sides are filled, its two ends also open, giving **3 then 4 scoring arms**.
- Must-play rule: if you hold a playable tile you must play (no drawing for a better tile).
- Cannot play → draw until playable (drawn playable tile goes down immediately, turn ends).
- Hand end: winner scores opponents' remaining pips **rounded to nearest 5**. Blocked tie → no one scores.
- Match target: **250** (2 players) / **200** (3–4 players); game ends the instant the target is hit.

> Rule engine must be **variant-pluggable**: a shared core (deck, placement validation, turn flow, end-of-hand) + per-variant scoring/behaviour hooks.

---

## 3. Architecture

```
┌──────────────┐   wss (Socket.IO)   ┌─────────────────────────────┐
│  Friend A    │◄──────────────────► │                             │
│  (browser)   │                     │   cloudflared quick tunnel  │
└──────────────┘                     │   https://xyz.trycloudflare │
┌──────────────┐                     │            .com             │
│  Friend B    │◄──────────────────► └──────────────┬──────────────┘
└──────────────┘                                    │ http://localhost:3000
┌──────────────┐                     ┌──────────────▼──────────────┐
│  You (host)  │◄──────────────────► │  Node.js server (your PC)   │
└──────────────┘                     │  ├ Express → static client  │
                                     │  ├ Socket.IO → realtime    │
                                     │  ├ RoomManager (in-memory) │
                                     │  └ GameEngine (pure logic) │
                                     └─────────────────────────────┘
```

**Key decisions**

| Decision    | Choice                                 | Why                                                                                                         |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Realtime    | **Socket.IO**                          | Auto-reconnect, rooms built-in, WebSocket+long-poll fallback (works through Cloudflare free tunnel)         |
| Authority   | **Server holds full state**            | Clients send *intents* only; server validates and broadcasts per-player views (hands of others stay hidden) |
| Frontend    | **Vanilla JS + modern CSS** (no build) | Trivial deploy; CDN libs allowed (GSAP for animation, Howler for sound)                                     |
| Persistence | **None** (in-memory)                   | Games are ephemeral; reconnect via `playerToken` in `localStorage`                                          |
| Sharing     | **cloudflared quick tunnel**           | Free, no account, one command, gives public HTTPS URL; WSS works out of the box                             |

**Anti-cheat model:** every client receives only: public table state + own hand + counts of others' hands. Server never sends hidden tiles.

---

## 4. Project Structure

```
domino/
├─ plan.md
├─ package.json                 # express, socket.io
├─ server/
│  ├─ server.js                 # http + socket.io bootstrap
│  ├─ rooms.js                  # create/join/leave, lobby, reconnect
│  └─ protocol.js               # event names + payload validation
├─ engine/                      # PURE JS, no IO → unit-testable
│  ├─ deck.js                   # build 28 tiles, shuffle (seeded RNG)
│  ├─ game.js                   # state machine: deal/turn/place/draw/pass/end
│  ├─ rules-block.js
│  ├─ rules-draw.js
│  └─ rules-allfives.js         # spinner + multiple-of-5 scoring
├─ public/
│  ├─ index.html                # single-page app (screens toggled)
│  ├─ css/style.css             # theme, table, tiles, animations
│  ├─ js/net.js                 # socket client wrapper
│  ├─ js/ui-lobby.js            # home + lobby screens
│  ├─ js/ui-table.js            # board render + layout algorithm
│  ├─ js/tiles.js               # tile SVG/DOM renderer
│  ├─ js/anim.js                # deal/place/score animations (GSAP)
│  ├─ js/sound.js               # click/place/win sounds (Howler)
│  └─ assets/                   # sounds, felt texture, favicon
├─ tests/
│  └─ engine.test.js            # deck, legality, scoring incl. All Fives edge cases
└─ scripts/
   └─ start-tunnel.md           # cloudflared instructions
```

---

## 5. Network Protocol (Socket.IO events)

**Client → Server**

| Event          | Payload                                        | Notes                             |
| -------------- | ---------------------------------------------- | --------------------------------- |
| `room:create`  | `{name}`                                       | → returns room code, you are host |
| `room:join`    | `{code, name, token?}`                         | token = reconnect                 |
| `room:leave`   | —                                              |                                   |
| `lobby:config` | `{variant, targetScore, handSize, maxPlayers}` | host only                         |
| `lobby:ready`  | `{ready:bool}`                                 |                                   |
| `game:start`   | —                                              | host only, all ready              |
| `game:play`    | `{tileId, end}`                                | end = left/right/arm for spinner  |
| `game:draw`    | —                                              | Draw/All Fives only               |
| `game:pass`    | —                                              | only when legal                   |
| `chat:send`    | `{text}` / `{emoji}`                           |                                   |
| `game:rematch` | —                                              |                                   |

**Server → Client**

| Event           | Payload                                                                                                  |         |        |        |                  |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------- | ------ | ------ | ---------------- |
| `lobby:state`   | players, ready flags, config, host                                                                       |         |        |        |                  |
| `game:state`    | **per-player view**: board chain, open ends, own hand, hand counts, current turn, scores, boneyard count |         |        |        |                  |
| `game:action`   | animation hints (\`{type:'deal'                                                                          | 'place' | 'draw' | 'pass' | 'score', ...}\`) |
| `game:handEnd`  | winner, points breakdown                                                                                 |         |        |        |                  |
| `game:matchEnd` | final standings                                                                                          |         |        |        |                  |
| `chat:msg`      | `{from, text}`                                                                                           |         |        |        |                  |
| `error`         | `{code, message}`                                                                                        |         |        |        |                  |

---

## 6. UI / UX Design (the "so cool" part)

**Screens (single-page, hash-less):**

1. **Home** — logo, name input, `[Create Room]` / `[Join with Code]`, animated falling-dominoes hero.
2. **Lobby** — room code (click-to-copy + invite link `?room=CODE`), player slots with ready checkmarks, variant picker with rule summaries, start button (host).
3. **Table** — the star:
   - Dark green/navy felt with vignette, wood frame.
   - Your hand fan at bottom (tiles tilt on hover, lift on select).
   - Board center: **snake layout algorithm** — chain flows left→right and wraps with 90° corners to fit; auto-zoom/pan when long. All Fives renders the 4-arm cross from the spinner.
   - Tap a tile → legal ends **glow**; tap a glowing end → tile flies there and snaps with a clack.
   - Turn indicator: glowing ring + name pulse; pass = grey "PASS" chip floats up.
   - Score toasts: `+15` floats from board on All Fives hits; live scoreboard (collapsible) with match progress bar.
   - Boneyard pile visual with count; draw animation slides tile to your hand.
4. **Hand-end modal** — points breakdown animation ("opp. left: 34 pips → +35").
5. **Match-end modal** — podium + confetti + rematch button.
6. **Chat drawer** + 6 quick emoji reactions that float over the table.

**Polish kit:** GSAP deal animation (tiles fly from deck one-by-one), Howler sounds (shuffle, clack, draw, win fanfare), subtle table ambient, confetti, connection-status pill, auto-reconnect banner, fully responsive (mobile portrait = vertical table).

---

## 7. Implementation Phases

- **Phase 0 — Scaffold & tunnel POC (0.5 day):** `npm init`, install `express socket.io`; hello-world served + socket echo; install cloudflared, run quick tunnel, confirm a friend can open the URL and see realtime echo. *De-risks everything early.*
- **Phase 1 — Engine core (1–2 days):** deck/shuffle (seeded), Block rules state machine, legality, end-of-hand scoring. **Unit tests first** (TDD): 20+ cases.
- **Phase 2 — Draw + All Fives rules (1 day):** draw logic, spinner arms, multiple-of-5 scoring incl. double-counting-doubles and spinner close-off edge cases. Tests: known pagat.com example sequence.
- **Phase 3 — Server rooms + protocol (1 day):** RoomManager, lobby lifecycle, per-player state projection, reconnect by token, input validation, rate-limit chat.
- **Phase 4 — Client: home + lobby (0.5 day):** full flow working with raw/simple UI; play a full Block game with 2 browsers.
- **Phase 5 — Table UI + layout algorithm (2 days):** tile renderer (DOM+CSS pips), snake path layout, spinner cross, tap-to-place with legal-end glow, hand fan.
- **Phase 6 — Juice (1 day):** GSAP animations, sounds, score toasts, confetti, chat + emojis, responsive/mobile pass.
- **Phase 7 — Hardening & ship (0.5–1 day):** edge cases (double-disconnect, host leaves → host migration or room close), engine fuzz test (random games ×1000 no crash), README + `start-tunnel` script, final playtest over tunnel with friends.

**Total estimate: ~6–8 focused days.**

---

## 8. Running & Sharing (Cloudflare Tunnel)

```bash
# 1. one-time: install cloudflared (Windows)
winget install --id Cloudflare.cloudflared

# 2. every session:
node server.js                                  # serves http://localhost:3000
cloudflared tunnel --url http://localhost:3000  # prints https://<random>.trycloudflare.com

# 3. share the URL with friends → they open it, enter name + room code, play.
```

- Quick tunnels are **free, no account**, HTTPS + WSS supported. URL changes each restart.
- Optional later: named tunnel on your own domain for a permanent `domino.yourname.com`.
- Keep both terminals open; when you stop `node`, the game is offline.

---

## 9. Testing Plan

- **Unit (engine, Node test runner):** deck integrity (28 unique tiles), shuffle distribution, Block/Draw legality, pass rules, blocked-hand resolution, pip counting, All Fives: multiples-of-5 detection, doubles scoring crosswise, spinner 3rd/4th arm open/close scoring, rounding to nearest 5, target-reached instant win.
- **Fuzz:** 1000 random AI-less games per variant → assert no exceptions, no duplicate tile, score invariants.
- **Protocol:** two socket clients scripted end-to-end (create→join→start→play hand).
- **Manual:** 3 browsers through the tunnel; kill a tab mid-turn → reconnect restores hand.

---

## 10. Stretch Goals (post-v1)

- Spectator mode · in-game voice note bubbles · tile skins/themes · match history (localStorage) · Mexican Train & Chicken Foot variants · AI bot for practice · named tunnel + permanent domain · PWA "add to home screen".

---

## 11. Risk Register

| Risk                              | Mitigation                                                   |
| --------------------------------- | ------------------------------------------------------------ |
| Quick-tunnel URL changes each run | Accept for v1; named tunnel later                            |
| Host PC sleeps → game dies        | README: disable sleep; show connection pill to all           |
| Socket.IO through tunnel blocked  | Phase 0 POC validates this first; long-poll fallback enabled |
| All Fives spinner scoring bugs    | TDD against the official pagat.com worked example            |
| Friends on mobile                 | Responsive layout is Phase 6 acceptance criteria             |

---

# 📱 Android (APK) Conversion Plan — LAN Hotspot Multiplayer

*Added 2026-09-23. Supersedes nothing — the web/tunnel flow above stays exactly as is.*

## A. Goal

One installable **APK** of Domino Arena that Android phones can install directly (no Play Store).
On a hotspot with **zero internet**, one phone hosts the game server and the others join it and play —
same 2–4 player matches, same bots, same chat, **same WebRTC voice**, no PC and no Cloudflare Tunnel.

**Non-goals:** iOS build (Capacitor makes it a later freebie), Play Store publication, rewriting the
engine or the socket protocol, accounts/leaderboards, any framework or build step for the game client itself.

## B. The architecture decision (everything else follows from it)

**One APK = Capacitor WebView shell + embedded Node.js runtime (nodejs-mobile). Each phone serves the
client to *itself*; the host phone additionally runs the real Node server.**

```
HOTSPOT (no internet)
┌─────────────────────────── host phone ────────────────────────────┐
│  APK: [ Capacitor WebView → bundled client (http://localhost) ]   │
│        └─ io("http://127.0.0.1:3000")                             │
│  APK: [ embedded Node.js  →  server/server.js on 0.0.0.0:3000 ]   │
│        shows its LAN IP (e.g. 192.168.43.1:3000) + room code      │
└───────────────▲───────────────────────────────────────────────────┘
                │  socket.io (ws) + WebRTC voice (P2P on LAN)
┌───────────────┴──────────── guest phone ──────────────────────────┐
│  APK: [ Capacitor WebView → bundled client (http://localhost) ]   │
│        └─ io("http://192.168.43.1:3000")  ← typed or remembered   │
└───────────────────────────────────────────────────────────────────┘
```

Why each piece is forced:

1. **The server must run somewhere.** Rewriting rooms/timers/voice-signaling as native Kotlin (or a
   QuickJS engine host) throws away `rooms.js`/`server.js` and every protocol guarantee — rejected.
   Embedding Node (nodejs-mobile) reuses **100% of the server + engine + bots unchanged**.
2. **Every device loads the client from its own local copy, never from the host's IP.** This is the
   subtle load-bearing choice: `getUserMedia` (voice) only works in a **secure context**. If a guest's
   WebView opened `http://192.168.x.x:3000`, the mic would be silently dead — insecure origin. When the
   client is served by Capacitor's own local server the page origin is `http://localhost`, which *is*
   secure, so voice works on plain-LAN HTTP. (Note `app.js:1321 applyVoiceSupport()` already disables
   mic buttons when `voice.secure` is false — with this design it simply never trips.)
3. **Capacitor over Cordova/React Native/WebView-Activity:** Capacitor exists precisely to wrap a
   vanilla-JS app, gives local HTTP serving, permission bridging, splash/icon tooling, and a clean
   plugin API for starting/stopping the embedded Node. No framework touches the game code.

Three runtime modes, one codebase:

| Mode | WebView origin | socket.io target | Used when |
|---|---|---|---|
| **Host (APK)** | Capacitor local server | `http://127.0.0.1:3000` (embedded node) | "استضافة على هذا الجهاز" |
| **Join (APK)** | Capacitor local server | `http://<host-ip>:3000` (typed/persisted) | friends on the hotspot |
| **Web (unchanged)** | the real server | same-origin (current default) | browser / Cloudflare Tunnel — today's flow, untouched |

## C. What the deep dive established (facts this plan relies on)

- **Single connection point.** `public/js/app.js:1339` — `socket = io({ transports: [...] })`, default
  same-origin. One line to make pluggable. The voice client receives that same socket (`voice.js`), so
  signaling needs no changes at all.
- **Server already binds all interfaces.** `server/server.js:546` `http.listen(PORT)` → reachable on the
  hotspot LAN as-is. Static serving at `server/server.js:19`.
- **Offline is currently impossible — three CDN dependencies in `public/index.html`:**
  jsdelivr importmap (`three@0.160.0` + addons), jsdelivr `socket.io-client@4.8.1`, Google Fonts
  (Cairo, Reem Kufi). Actual usage is tiny: `three.module.js` + `OrbitControls.js` +
  `RoundedBoxGeometry.js` (checked `home3d.js:4-5`, `board3d.js:2-4`), one client bundle, two font
  families. All vendorable as static files (~1 MB total).
- **Voice ICE is hardcoded to internet relays.** `public/js/voice.js:27-41` — Google STUN + OpenRelay
  TURN. Unreachable offline; on the same hotspot plain host-candidates connect, so LAN mode should ship
  with **empty `iceServers`** (faster connect, no dead-server timeouts), keeping STUN/TURN only for web mode.
- **Node feature floor:** server/engine ESM + `node:path`, `node:http`, `node:url`, `node:crypto`
  (`randomUUID` in `rooms.js:2` → Node ≥ 14.17). Both deps (express 4, socket.io 4) are pure JS →
  **esbuild-bundleable to a single CJS file**, which sidesteps the fragile ESM support of embedded Node
  runtimes entirely.
- **No CORS is configured** (same-origin by design). APK guests (origin `http://localhost`) talking to
  `http://<host-ip>:3000` is cross-origin → server needs `cors: { origin: true }` on Socket.IO (fine for
  a game; additive change, e2e unaffected).
- **Viewport/RTL/mobile meta are already right** (`index.html:5`, 7 media queries, Arabic UI throughout).
  Remaining mobile work is touch ergonomics and keyboard/resizing behaviour, not a layout rewrite.
- **Repo state:** no `android/`/`mobile/` dirs yet; cache-busting `?v=` convention is live
  (`index.html:319` etc.) and must be bumped for every touched client file per AGENTS.md.

## D. Phase plan (each phase = verified change = its own commit)

### Phase 0 — Vendor all client dependencies (offline-proof the web client)
- Download into `public/vendor/`: `three/0.160.0/build/three.module.js`,
  `three/0.160.0/examples/jsm/controls/OrbitControls.js`,
  `three/0.160.0/examples/jsm/geometries/RoundedBoxGeometry.js`, `socket.io.min.js` (4.8.1),
  Cairo + Reem Kufi woff2 subsets + a small `@font-face` block appended to `style.css`.
- Repoint the importmap to `./vendor/...`, replace the CDN `<script>` with the local one
  (keep exact versions pinned), bump `?v=` on every touched import line.
- **Verify:** block CDN hosts in devtools/hosts file → full game still works (3D board, fonts, sockets);
  `npm test` + `npm run e2e` green. Files: `index.html`, `css/style.css`, `board3d.js`, `home3d.js`, `app.js` (v-bumps).

### Phase 1 — Pluggable server URL + host-info endpoint
- `app.js`: resolve `SERVER_URL = localStorage['domino_server_url'] || ''` → `io(SERVER_URL || { transports })`
  (empty string preserves today's same-origin behaviour; localStorage set by APK glue or a hidden
  "خادم مخصص" field on the home screen for power users).
- `server/server.js`: `cors: { origin: true }` on the Socket.IO constructor; new tiny
  `GET /host-info` → `{ port, ips: [LAN IPv4s from os.networkInterfaces()] }` (HTTP only — no protocol
  change, e2e untouched).
- **Verify:** `npm run e2e 3100` + manual: laptop browser joins a room by IP over LAN.

### Phase 2 — Capacitor shell (guest-only APK, internet server still required)
- Tooling on the PC: JDK 17 + Android SDK (Android Studio) — one-time.
- New self-contained `mobile/` tree: Capacitor app, `package.json` for cap deps only,
  `mobile/sync.mjs` (plain `node:fs` copy of `public/` → `mobile/www/`), npm scripts at root:
  `mobile:sync`, `mobile:apk:debug`. Source of truth stays the repo root — `mobile/` only ever holds copies.
- Debug APK on a real phone: verify home3d/board3d rendering + touch, 60fps feel, fullscreen button,
  back-button behaviour, WebView version note.
- **Verify:** phone (guest) plays a full match against a PC-hosted server over hotspot. This phase alone
  de-risks all WebView/cleartext/permission issues before the hard part.

### Phase 3 — Embedded Node host (the core milestone, ~50% of total risk)
- Bundle: `mobile/build-server.mjs` → esbuild `server/server.js` (+engine) to one CJS file
  `mobile/node/server-bundle.cjs` with prod deps inlined; output committed to `mobile/node/`.
- Runtime: **nodejs-mobile** — time-boxed spike first: try the community Capacitor plugin for
  nodejs-mobile; if stale, hand-roll a ~100-line Kotlin Capacitor plugin over the nodejs-mobile AAR
  (start/stop `server-bundle.cjs`, stdout → logcat). Spike acceptance: `node -e`-style script runs,
  HTTP listens, both `arm64-v8a` and `armeabi-v7a` ship in the AAR.
- Host mode UX (Arabic): home screen button **"استضافة على هذا الجهاز"** → start node → poll
  `127.0.0.1:3000/host-info` until up → set `domino_server_url=127.0.0.1:3000` → normal flow; host
  screen shows "شارك كود الغرفة + IP: 192.168.x.x". Join mode: **"انضمام"** with an IP field next to the
  code field (persisted; defaults to last host). Full offline airplane-mode play vs bots also works here
  (engine is pure) — free bonus.
- Android lifecycle (the part that actually bites): **foreground service** + ongoing notification
  ("اللعبة تعمل") so the server survives host screen-lock/app-switch; `FLAG_KEEP_SCREEN_ON` while hosting
  (toggleable); request battery-optimization exemption on first host run.
- Manifest: `INTERNET`, `RECORD_AUDIO`, `ACCESS_NETWORK_STATE`, `usesCleartextTraffic=true`
  (cleartext LAN HTTP is the whole point; acceptable for this app).
- **Verify:** two real phones, hotspot, full multi-hand match; host locks screen mid-game → game continues;
  guest leaves → host migration fires (existing logic, never to a bot — unchanged).

### Phase 4 — Voice on LAN
- Mic runtime permission via Capacitor's WebView permission bridge (`RECORD_AUDIO` already in manifest).
- `voice.js`: accept an optional ICE config (set once by `app.js`): LAN mode → `iceServers: []`
  (host candidates connect peers on the same subnet); web mode → existing STUN/TURN untouched.
  Update `voice.js` header note + bump `?v=`.
- **Verify:** 3-phone voice call on hotspot; check host↔guest and **guest↔guest** P2P (see AP-isolation risk below).

### Phase 5 — Mobile UI pass
- Small-screen audit of all three screens: hand-tile tap targets, hand scrolling, chat drawer vs the
  Android soft keyboard (window resize), lobby/game safe-areas (notch), double-tap zoom prevention,
  room-code input keyboard (`inputmode`/`enterkeyhint` — chat already has `enterkeyhint`).
- Decide & lock orientation (portrait-first, board auto-fits already).
- **Verify:** on the smallest and largest physical phones available.

### Phase 6 — Release build & distribution
- Identity: `com.mahmoud.dominoarena`, name **"دومينو أرينا"**, adaptive icon from the existing tile SVG
  emblem (`index.html:38-56`), splash, `versionCode` 1.
- Signing: generate `mobile/keystore/domino.jks` (gitignored, password stored offline) + release signing
  config → `assembleRelease`. Ship **arm64-v8a release APK** (~35–45 MB with libnode) + optional universal
  debug APK. Friends: share APK file → "install unknown apps" → done.
- Docs: README section "اللعب على الهاتف بدون إنترنت" (host/join steps, hotspot notes, WebView update
  note) + AGENTS.md commands/architecture sync. Commit policy per AGENTS.md throughout.

## E. Test matrix (Phase 3/4 acceptance)

| Scenario | Expected |
|---|---|
| Airplane mode, host phone, Play vs 3 bots | fully playable (engine + bots are offline-capable) |
| Hotspot, 1 host + 3 guest APKs, Draw variant | full match, scores, hand-end flow |
| Voice: host↔guest and guest↔guest on hotspot | audio both directions, speaking rings |
| Host phone screen lock / app switch mid-game | turn timers keep firing (foreground service) |
| Guest airplane→wifi toggle / socket drop | token reconnect rejoins room (existing mechanism) |
| Host leaves app entirely | game dies with the host — **inherent to LAN hosting; document it** |
| Same APK, web mode via tunnel URL in WebView/browser | unchanged today-behaviour |
| Desktop regression | `npm test`, `npm run e2e`, `npm run e2e:voice` all green |

## F. Risks & mitigations

| Risk | Mitigation |
|---|---|
| nodejs-mobile maintenance/state in 2026 unknown | Phase 3 spike is time-boxed and first; esbuild-CJS bundle maximizes runtime compatibility; fallbacks below |
| **Plan B** if embedded Node fails | Native Kotlin WebSocket server + QuickJS running only `engine/` (rewrite of rooms/timers/protocol) — ~3× cost of Phase 3, avoided unless forced |
| **Plan C** (no APK blocker) | PWA + Termux on host phone — rejected as primary (no APK, mic broken on guest origins) |
| Hotspot AP-isolation blocks guest↔guest P2P | Game traffic always goes through the host so play is safe; voice (mesh P2P) is the only casualty — document + future option: relay audio over the socket through the host |
| Android "no internet on this Wi-Fi" prompt confuses guests | one line in the Arabic install instructions: tap "keep connection" |
| Hotspot IP changes between sessions | `/host-info` prints current IP on the host screen; guests' last-host remembered |
| Old/stale Android System WebView lacks importmap | minSdk 24 (Android 7) + troubleshooting note; WebView auto-updates via Play |
| libnode bloats APK | arm64-only release; universal kept as debug variant |
| Timers/`sessions` regressions during server edits | server changes are CORS + one read-only endpoint only — engine, protocol, and timer hygiene untouched |

## G. Open questions (defaults chosen — change before Phase 6 if wanted)

1. Package name `com.mahmoud.dominoarena` and app name "دومينو أرينا" — ok?
2. minSdk 24 (Android 7, ~97% devices) — ok, or lower?
3. Ship arm64-only release APK (recommended) or universal?
4. APK also keeps internet/tunnel play (recommended, free) — yes?

## H. Draft phone instructions (final wording goes in README, Arabic)

1. المضيف: افتح التطبيق ← "استضافة على هذا الجهاز" ← شارك الكود والـ IP الظاهر.
2. الأصدقاء: اتصلوا بالـ hotspot ← افتحوا التطبيق ← اكتبوا الـ IP + كود الغرفة ← انضمام.
3. أول تثبيت: اسمحوا "التثبيت من مصادر غير معروفة". لو ظهر "لا يوجد إنترنت" على الـ hotspot اضغطوا "الاحتفاظ بالاتصال".












