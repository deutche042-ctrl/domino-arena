# 🁢 DOMINO ARENA — Online Multiplayer Domino Game

> **Historical notice.** The Android/APK plan and the old voice implementation below are historical
> and have been removed from the shipped code. This document is kept for game-rules intent; for the
> current architecture (including the fresh WebRTC voice system in `public/js/voice.js` and the
> `voice:*` signaling in `server/server.js`), `AGENTS.md` is authoritative.

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

*FINAL v2 — 2026-09-23, after adversarial agent debate + packaging research. Supersedes the v1 Android
plan entirely; the web/tunnel flow above stays exactly as is.*

## A. Goal

One installable **APK** of Domino Arena that Android phones can install directly (no Play Store).
On a hotspot or LAN with **zero internet**, play works with **zero configuration**: open the app on any
phone and it either *becomes* the game server (first device on the network) or *auto-connects* to the
already-running one — no IP typing, no host/join choice. Same 2–4 player rooms, same bots, same chat,
**same WebRTC voice**. The user's "100 players auto-connect" target is fine on the server side (one
socket.io process handles 100 websockets across ~25 rooms easily); in practice the **hotspot is the
ceiling** — Android SoftAP typically caps at 10–30 stations (OEM-dependent). README sets that expectation.

**Non-goals:** iOS build (Capacitor makes it a later freebie), Play Store publication, rewriting the
engine or the socket protocol, accounts/leaderboards, any framework or build step for the game client
itself, room-state migration (room-owner death = that room dies, see D).

## B. The architecture decision (everything else follows from it)

**One APK = Capacitor WebView shell + embedded Node.js runtime. Each phone serves the client to
*itself* from the Capacitor local server, and EVERY device starts its own full game server on
0.0.0.0:3000 at app launch. Nearby servers announce themselves over UDP and the app shows them as a
tap-to-join list. A room belongs to the phone that created it — if that phone leaves, only their room
dies; nobody else is affected. There is no single host, no leader contention, no re-election.**

```
HOTSPOT / LAN (no internet)
┌──────────────────────── every phone runs this ─────────────────────┐
│  WebView → bundled client (origin http://localhost, secure ctx)    │
│            └─ io(serverUrl)  ← from /status + tap-to-join list     │
│  embedded node: launcher.cjs — game server :3000 (TCP, always on)  │
│                  + discovery beacon :3000 (UDP QUERY / OFFER)      │
│                  + status endpoint 127.0.0.1:3001 (/status,        │
│                    /peer/<ip> proxy for the discovery list)        │
└───────────────▲───────────────────────────────────────────────────┘
                │ socket.io (ws) + WebRTC voice (P2P on LAN)
                └─ rooms live on the phone that created them;
                   guests connect to that phone's 192.168.* address
```

Why each piece is forced:

1. **The server must run somewhere, and it must be the real Node server.** Rewriting
   rooms/timers/voice-signaling as native Kotlin throws away the protocol guarantees — rejected.
   Embedding Node reuses **100% of server + engine + bots unchanged**.
2. **Every device loads the client from its own local copy, never from the host's IP.** `getUserMedia`
   (voice) only works in a **secure context**; a WebView pointed at `http://192.168.x.x` would have a
   dead mic. Served from the Capacitor local server the origin is `http://localhost` — trustworthy, so
   voice works on plain-LAN HTTP in that historical build. **Consequence: pin
   `androidScheme: 'http'`** — do not let Capacitor 8's https default create an https WebView origin,
   which would make the `ws://…:3000` socket blocked mixed content.
3. **Every device runs the full server anyway — so there is no election to lose.** The express/socket.io
   footprint is identical on all phones (one bundle); discovery decides only *where each player plays*,
   not *who hosts*. Host death can never cascade: only that phone's rooms die. (Supersedes the v1
   election design — split-brain, YIELD and re-election are not needed when nobody is elected.)
4. **Discovery, not binding, is the network protocol.** (v1 flaw caught in debate: TCP binds are
   per-device, so EADDRINUSE can never coordinate across devices — with the every-device-hosts model
   this stops mattering entirely; UDP presence + a TCP /24 sweep fallback find the servers.) Spec in
   section D.
5. **Capacitor 8 + `@capawesome/capacitor-nodejs@0.1.1`** (researched 2026-09: the only maintained,
   16KB-page-aligned embedded-Node path; Node 18.20.4 runtime; auto-starts the node project at app
   launch on a background thread, stdout → logcat). Alternatives rejected: janeasystems upstream
   (unmaintained, Node 12), hampoelz plugin (deprecated by its own author, 4KB-aligned libnode),
   Cordova plugin route (2021 runtime), hand-rolled AAR plugin (no reason given capawesome exists).
   Build PC needs **JDK 21** (Capacitor 8 fails on 17: `invalid source release: 21`) + **NDK + CMake**
   (the plugin compiles a JNI shim against libnode).

Two modes, one codebase:

| Mode | WebView origin | socket.io target | How decided |
|---|---|---|---|
| **Local (APK default)** | Capacitor local server | `http://127.0.0.1:3000` | every device hosts; play solo or with anyone who taps this phone's entry |
| **Guest via discovery (APK)** | Capacitor local server | `http://<peer-ip>:3000` | user tapped that phone in the nearby-list (rooms live on the creating phone) |
| **Web (unchanged)** | the real server | same-origin (current default) | no `window.Capacitor` → today's behaviour, untouched |

## C. Facts the plan relies on (deep dive + packaging research, 2026-09)

- **Single connection point.** `public/js/app.js:1339` — `socket = io({ transports: [...] })`, default
  same-origin. The voice client receives that same socket, so voice signaling needs no protocol change.
- **Server already binds all interfaces.** `server/server.js:546` — LAN-reachable as-is. ESM
  (`"type": "module"`); `randomUUID` → Node ≥ 14.17 floor (embedded runtime is Node 18.20.4 ✓).
  Deps (express 4, socket.io 4) are pure JS → one-file **esbuild CJS bundle** (avoids
  ESM-in-embedded-node fragility entirely).
- **No CORS configured** (same-origin by design). APK guests (origin `http://localhost`) →
  `http://<host-ip>:3000` is cross-origin → server needs `cors: { origin: true }` on Socket.IO
  (additive; e2e unaffected). Status endpoint likewise sends `Access-Control-Allow-Origin: *`
  (WebView origin `localhost` ≠ `127.0.0.1`).
- **Offline blockers in `public/index.html`:** jsdelivr importmap (`three@0.160.0` + `OrbitControls` +
  `RoundedBoxGeometry` — checked `board3d.js:2-4`, `home3d.js:4-5`), jsdelivr `socket.io-client@4.8.1`,
  Google Fonts (Cairo, Reem Kufi). All vendorable (~1 MB total).
- **Voice ICE historically hardcoded to internet relays**: Google STUN + OpenRelay TURN. LAN mode
  ships empty `iceServers` (host candidates only — faster, no dead-server timeouts); web mode unchanged.
  Device test must confirm local candidates are real IPs, not mDNS `.local` obfuscations (WebView
  obfuscates candidates when mic permission is not granted; voice join always follows a grant).
- **Mobile-ready already:** viewport meta (`index.html:5`), 7 media queries, Arabic RTL UI throughout.
- **Packaging stack (exact):** Capacitor 8 (minSdk 24, targetSdk 36, Gradle wrapper 8.14.3,
  AGP 8.13.0) + `@capawesome/capacitor-nodejs@0.1.1`; plugin config `plugins.Nodejs`
  `{ nodeDir: 'nodejs', startMode: 'auto' }` (nodeDir relative to webDir).
- **Android platform requirements:** `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` in the manifest and
  Capacitor's `BridgeWebChromeClient` maps WebView `getUserMedia` to the Android runtime permission
  automatically (no extra plugin). Foreground service type **`specialUse`** (Android 15 caps `dataSync`
  at 6 h/24 h; `specialUse` is unlimited and its review only matters on Play). `POST_NOTIFICATIONS` is
  a runtime permission on 13+ (FGS runs even if denied). `android:usesCleartextTraffic="true"` for
  plain-LAN HTTP. `abiFilters arm64-v8a` for release size.

## D. Zero-config discovery — `launcher.cjs` spec (as implemented)

One hand-written CJS file is the node project entry (`package.json.main`). It never writes to its own
dir (the plugin re-copies assets on app update) and never calls `process.exit` (embedded-node rule) —
idle loops only. One node process, three listeners: UDP :3000 (discovery), TCP :3000 (game server,
**always started immediately on 0.0.0.0**), HTTP :3001 **bound to 127.0.0.1 explicitly** (`GET /status`,
`GET /peer/<ip>`, CORS `*`).

**Packet** (UDP, < 200 B): 4-byte magic `DMA1` + JSON. QUERY `{t:'q',v:1}`, OFFER
`{t:'o',v:1,id,port}`. Replies unicast to the source addr:port. Packets from non-192.168.* sources are
ignored for presence (cellular-interface garbage / CGNAT 10.x never auto-connects anyone); queries are
answered from any source (loopback sim + debugging). A device never reacts to its own datagrams
(all local 192.168.* addresses are filtered, not just the first interface — VirtualBox/second adapters
would otherwise self-list).

**Flow (no state machine — it's just presence):**
```
BOOT   start the game server on 0.0.0.0:3000 right away; bind UDP; status server on 3001.
BEACON broadcast OFFER every 2 s on each 192.168.* iface + 255.255.255.255 (late joiners).
QUERY  an OFFER is unicast back instantly (newcomers appear without waiting a beacon cycle).
PEERS  ip → { ip, port, lastSeen }; dropped after 6 s of silence.
SWEEP  fallback for ROMs that block UDP broadcast: TCP connect-sweep of our /24 on :3000,
       validated against /host-info before trusting anything it finds; runs at startup and
       every 20 s while no peers are known (also discovers a PC running `npm start`).
```

**Status contract** — `GET http://127.0.0.1:3001/status` → JSON, CORS `*`:
`{ status: 'ready', serverUrl: 'http://127.0.0.1:3000', ips: [192.168.* IPv4s], peers: [...] }`.
`GET /peer/<ip>` proxies a remote host's `/host-info` (validated against a strict 192.168.* regex) so
the discovery list can label each server with live room/player counts — the WebView itself can't fetch
remote hosts cross-origin, so everything rides this loopback server.

The WebView (only when `window.Capacitor` exists) polls `/status` every 300 ms, connects to the local
server by default, and renders `peers` as a tap-to-join list ("اللعبات القريبة"); tapping a peer
switches `io(serverUrl)` to that phone (with a reconnect if it ever changes). "إعدادات متقدمة" keeps
the escape hatch (manual IP / custom tunnel URL). Web mode never polls — zero regression surface.

**Timings:** node boot 0.3–1 s → the local server answers ≤ 2 s after app open; a peer appears on the
list ≤ 2 s after its app opens (beacon) or instantly via QUERY. Failure paths: airplane mode / no wifi →
local server + solo-vs-bots offline play with zero special-casing; broadcast blocked by ROM → TCP sweep;
duplicate launcher → :3001 already owned → status server stays with the older instance (harmless);
a phone leaves → only its rooms die, every other phone keeps playing untouched.

## E. Phase plan (each phase = verified change = its own commit)

### Phase 0 — Vendor all client dependencies (offline-proof the web client)
- `public/vendor/`: `three/0.160.0/build/three.module.js`, `examples/jsm/controls/OrbitControls.js`,
  `examples/jsm/geometries/RoundedBoxGeometry.js`, `socket.io.min.js` (4.8.1), Cairo + Reem Kufi
  woff2 subsets + `@font-face` block. Repoint importmap/`<script>` to `./vendor/…`, bump `?v=`.
- **Verify:** grep proves zero external URLs left in `index.html`/`css/style.css`; `npm test`;
  `npm run e2e`; full game in a browser with CDN hosts blocked.

### Phase 1 — Auto-connection client glue + server additions
- `app.js`: APK mode polls `/status` → `io(serverUrl)` (contract D); web mode untouched. Home-screen
  status pill + role toast; "إعدادات متقدمة" (manual IP, custom server URL, بحث مجدداً).
- `voice.js`: injectable ICE config — LAN mode `iceServers: []`; web mode keeps STUN/TURN. `?v=` bump.
- `server.js`: `cors: { origin: true }`; `GET /host-info` (LAN IPv4s, debug aid); global active-room
  cap (≈50) with Arabic rejection (`room:create` is currently unbounded — memory-DoS guard).
- **Verify:** `npm test`, `npm run e2e`, `npm run e2e:voice`; manual web regression.

### Phase 2 — Capacitor 8 shell (no embedded node yet)
- `mobile/` tree: `package.json` (cap deps + esbuild), `capacitor.config.json`
  (`com.mahmoud.dominoarena`, "دومينو أرينا", webDir `www`, `androidScheme: 'http'`, cleartext),
  `mobile/sync.mjs` (fs copy `public/` → `mobile/www/`), npm scripts `mobile:sync`, `mobile:apk`.
- Toolchain: JDK 21 (Temurin), `sdkmanager platforms;android-36 build-tools;36.0.0 ndk;27.2.12479018
  cmake;3.22.1` + licenses accepted, `local.properties` → SDK at `%LOCALAPPDATA%\Android\Sdk`.
- **Verify:** debug APK installs; WebView renders the game against a PC-hosted server (guest role,
  manual IP) — de-risks WebView/cleartext/permissions before the embedded node lands.

### Phase 3 — Embedded node + election (the core milestone)
- `mobile/build-server.mjs`: esbuild `server/server.js` → `mobile/www/nodejs/server-bundle.cjs`
  (`--platform=node --format=cjs --target=node18`, prod deps inlined); client copy at
  `mobile/www/nodejs/public/` so `http://<host-ip>:3000` also works in a laptop browser for debugging.
- `launcher.cjs` per D; `package.json.main = 'launcher.cjs'`; `require('bridge')` in try/catch at top
  (plugin readiness contract).
- `npm i @capawesome/capacitor-nodejs && npx cap sync android`; config `plugins.Nodejs`.
- Android glue: manifest permissions (`INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`,
  `POST_NOTIFICATIONS`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `usesCleartextTraffic`),
  `NodeServerService` (FGS `specialUse`, started from `MainActivity.onCreate`, `startForeground`
  immediately, keeps node alive with screen off), `FLAG_KEEP_SCREEN_ON`, `POST_NOTIFICATIONS` runtime
  request, `abiFilters arm64-v8a`.
- **Verify (desktop first):** two launcher instances on the PC → one becomes host, the other discovers
  it (ports env-overridable for the sim); the bundled server passes `npm run e2e 3100` black-box.
  On device: logcat shows node boot; laptop `curl http://<phone-ip>:3000` confirms 0.0.0.0 binding.

### Phase 4 — Voice on LAN + device UX pass
- Mic runtime permission via Capacitor's WebView permission bridge; 3-phone voice on hotspot;
  host↔guest and **guest↔guest** P2P; confirm no mDNS `.local` candidates.
- Small-screen audit: hand-tile tap targets, soft-keyboard vs chat drawer, notch safe-areas, room-code
  `inputmode`. Keep-screen-on while hosting; battery-optimization exemption hint; hotspot Settings
  deep-link on the host screen (apps cannot toggle the hotspot themselves).

### Phase 5 — Release build & distribution
- Keystore (`keytool`, gitignored) + release signing config; `assembleRelease`, arm64-v8a only
  (~35–45 MB with libnode); versionCode 1; adaptive icon from the existing tile emblem; splash.
- Deliverable copied to `dist/DominoArena-v1.0.0-arm64.apk` (gitignored).
- Docs: README "اللعب على الهاتف بدون إنترنت" + AGENTS.md commands/architecture sync.

## F. Test matrix (acceptance)

| Scenario | Expected |
|---|---|
| Airplane mode, one phone | local server; solo vs 3 bots fully playable |
| Hotspot, first phone opens → second opens 30 s later | second sees the first in the nearby-list, taps, joins — zero typing |
| 3+ phones open simultaneously | each runs its own server; the nearby-list shows all; no election anywhere |
| Hotspot, 1 room + 3 guests, Draw variant | full match, scores, hand-end flow, rematch |
| Voice: host↔guest and guest↔guest on hotspot | audio both directions, speaking rings, no `.local` candidates |
| Room owner screen lock / app switch mid-game | FGS holds node; turn timers keep firing; laptop curl still answers |
| Room-owner app killed | only that room dies; every other phone keeps playing untouched |
| Same APK, custom tunnel URL via advanced settings | unchanged web behaviour |
| Desktop regression | `npm test`, `npm run e2e`, `npm run e2e:voice` green; bundled server passes e2e black-box |

## G. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hotspot station cap (10–30, OEM) not 100 | README expectation-setting; the server itself handles 100 ws easily |
| UDP broadcast blocked by a ROM | TCP /24 sweep fallback (both also find PC hosts) |
| Broadcast garbage from cellular interface | 192.168.* source filter + per-iface 192.168.* broadcast targets only |
| 16KB-page devices crash on old libnode builds | capawesome runtime is 16KB-aligned — the reason it was chosen |
| JDK 17 present but Capacitor 8 needs 21 | install Temurin 21; JAVA_HOME set per-build command only |
| NDK/CMake build friction | scripted sdkmanager install; build errors name the exact missing version |
| ESM in embedded node | avoided by design — single CJS esbuild bundle, target node18 |
| `process.exit` in embedded node | launcher never exits; idle loops only |
| Asset writes lost on app update | launcher/server write nothing to their project dir |
| Host death loses rooms | accepted + announced (fresh server, home screen); no state migration, ever |
| Voice guest↔guest blocked by AP isolation | game traffic always host-relayed (safe); voice-only casualty, documented |
| Stale Android System WebView lacks importmap | minSdk 24 + troubleshooting note; WebView auto-updates via Play |
| Timers/`sessions` regressions during server edits | server changes are CORS + one read-only endpoint + room cap only — engine/protocol/timer hygiene untouched |

## H. Decisions taken autonomously (defaults locked; change before Phase 5 if wanted)

1. Package `com.mahmoud.dominoarena`, app name "دومينو أرينا".
2. minSdk 24 (Android 7) — forced by Capacitor 8.
3. Release APK arm64-v8a only; debug universal for emulator/testing.
4. APK keeps web/tunnel play via "إعدادات متقدمة" (custom server URL) — free.
5. Room-owner death = that room dies; every other phone keeps playing (no room migration, ever).
6. Global room cap 50 per server.

## I. Draft phone instructions (final wording in README, Arabic)

1. نزّل الـ APK ← اسمح "التثبيت من مصادر غير معروفة" ← ثبّت.
2. شغّل الـ hotspot على موبايل واحد (أو راوتر)، وافتح التطبيق عند الكل — كل جهاز بيظهر في قائمة
   "اللعبات القريبة" عند الباقيين أوتوماتيك. مفيش كتابة IP.
3. واحد يعمل غرفة ويقول الكود (4 حروف)، والباقي يضغط على اسم الجهاز في القائمة وينضم.
   المايك والشات شغالين.
4. لو ظهر "لا يوجد إنترنت" على الـ hotspot اضغطوا "الاحتفاظ بالاتصال". كل غرفة بتشتغل على الموبايل
   اللي عملها؛ لو اتقفل بتتمسح غرفته هو بس — الباقي بيكمل لعب عادي.

---

## K. Improvement plan (Sept 2026 audit) — opponents, server, client

Three parallel audit passes (bot opponents, gameplay/server, client UX) produced the findings below.
Everything in K.1–K.3 is implemented and verified in this section; K.4 lists the deliberately
deferred bets. User-facing strings stay Egyptian Arabic; engine stays pure.

### K.1 Opponents (`engine/bot.js`) — the main focus

| # | Severity | Finding | Fix implemented |
|---|----------|---------|-----------------|
| B1 | critical | **expert cheated**: `pickExpert` evaluated the opponent's reply with `evaluateMove`, which reads that player's private hand (shed-pips + `myFlexibility`) and counts unseen tiles from the *opponent's* perspective — a direct anti-cheat violation | `evaluateMove` gained an `observer` mode (public-only): hand-reading terms skipped, unseen-tile terms computed from the observing bot's knowledge. Reply candidates are now enumerated from the observer's *unseen tiles* (injected into a scratch clone), never from the opponent's true `legalMoves` |
| B2 | high | No test pinned "decisions don't change when hidden info changes" | New invariance test: permuting opponent hands + boneyard order must not change any level × profile action for the same rng |
| B3 | high | `easy` played a fully random legal tile — could miss its own winning move | easy always spots a move that ends the hand with the win (or scores out the match); All-Fives score-notice probability raised 0.35 → 0.5 |
| B4 | high | `medium` could pass up dominoing to shed a heavier tile | medium probes for the hand-winning/match-winning move first, then runs the greedy heuristic |
| B5 | medium | `dangerForNextPlayer` pip math was wrong (`pips % 5` filter) — counted tiles that can't actually score and missed ones that can | danger now simulates the real attachment: `endsTotalWith` mirrors the engine's dedup rules and tests the true post-attach `endsTotal % 5 === 0` |
| B6 | medium | Blocking term counted boneyard tiles as opponent threats (inflated early in draw/allfives) | playable-unseen is probability-weighted by `opponentHandTiles / unseenTotal` (both public via viewFor) |
| B7 | medium | Bots never used pass information; engine threw it away | engine records `passLog` (pid + open-end match values, kind pass/draw) per hand — public info, exposed in `viewFor`; bots gain a "trap" term that rewards leaving ends whose values opponents are demonstrably out of |
| B8 | medium | Static weights regardless of match position | score-adaptive weights: leading boosts defense/denial, trailing boosts aggression |
| B9 | low | All bots felt identical (same delay, chat before the move was visible) | per-level think delays (easy 400–700ms → expert 1100–2000ms), consecutive bot draws compressed to ~250ms, chat emitted 400–1000ms *after* the broadcast |
| B10 | low | `game:hint` always answered at medium quality | hint runs at the strongest seated bot level (hard when no bots) |

Deferred (K.4): spinner-arm-control term, 3-ply expectimax, blocked-hand pip-parity play.

### K.2 Engine + server

| # | Severity | Finding | Fix implemented |
|---|----------|---------|-----------------|
| S1 | critical | handSize 9 × 4 players = 37 tiles from a 28-tile deck (reachable from the shipped lobby UI) | `rooms.startGame` clamps handSize to `⌊28/players⌋`; the engine also validates in the constructor as a backstop |
| S2 | high | All-Fives engine defaults (250/200) were dead code — `config.targetScore` defaulted to 100, so `opt.targetScore \|\| default` never fell through | `createRoom` config `targetScore: null` → engine default per variant/player-count; lobby gains a "تلقائي" option |
| S3 | high | AFK player in Draw stalled the table ~7 min (one auto-draw per 30s timeout) | `handleTurnTimeout` now loop-draws until a playable tile arrives or the boneyard is dry, then auto-passes, in a single tick |
| S4 | high | Turn timer didn't re-validate the pid it was armed for (docs claimed it did) | `handleTurnTimeout` captures `turnTimerPid` and aborts if the turn moved on |
| S5 | high | AFK host froze the table at handEnd (nextHand host-only, votes advisory) | `game:nextHandVote` is now binding, unanimous-minus-host (mirrors rematch); host voting executes immediately |
| S6 | medium | Kicked socket stayed in the Socket.IO room (kept receiving lobby/chat/voice events) | kick now `sessions.delete`s and `socket.leave`s the kicked socket |
| S7 | medium | No process error handlers — one listener throw kills the process and every room | `uncaughtException`/`unhandledRejection` logged, process stays up (matches the embedded-launcher no-exit design) |
| S8 | medium | One client could squat all 50 `MAX_ROOMS` | per-socket room-create cap (3) |
| S9 | low | `lobby:ready`/vote handlers re-broadcast unthrottled; duplicate votes rebroadcast | per-socket 400ms broadcast throttle + duplicate-vote dedupe |
| S10 | low | Late joiners were permanently spectators — `state` never returned to `'lobby'` | new host-only `game:backToLobby` after matchEnd resets the room to a lobby (`lobby:reopened` to clients) so seats reopen |
| S11 | low | Spectators invisible in lobby state | `lobbyState` carries the spectator list |
| S12 | low | Reconnect "prefer fresh view" path was dead (`view.playerId` never set) | `gameView` sets `playerId` |
| S13 | low | `_endMatch` no-op self-assignment branch | removed |

### K.3 Client

| # | Finding | Fix implemented |
|---|---------|-----------------|
| C1 | No persistent trace of the opponent's last move | 3D board keeps an emissive highlight on the last-placed tile plus a name tag; 2D fallback gets the same via a CSS class |
| C2 | Camera fought the player (auto-fit lerp erased manual orbit/zoom every frame) | `controls 'start'` cancels the goal; a recenter HUD button restores auto-fit; new hands re-fit |
| C3 | Mis-taps on pass/draw were instant and irreversible | "confirm moves" setting (off by default): pass/draw require a second tap within 1.5s |
| C4 | Invite sharing was clipboard-only | native share sheet first (`navigator.share`), clipboard fallback |
| C5 | Lobby ran two stacked animated backdrops | 2D falling tiles only spawn when the 3D lobby backdrop failed (matches home behaviour) |
| C6 | Settings scattered; no volume, no force-2D | settings modal: master volume (sfx `setVolume`), force-2D, confirm-moves, vibration — persisted |
| C7 | No rules/onboarding screen | rules modal with the three variants (Arabic) from home + lobby |
| C8 | Turn alert set the tab title once; no blink | interval blink while the turn alert is active |
| C9 | `#turnTimer` not safe-area lifted (sat under notches) | safe-area inset applied |
| C10 | Confetti / countdown pulse / hero tiles ignored `prefers-reduced-motion` | gated |
| C11 | `sw.js` cache grew forever (`SW_VER` never bumped) | `SW_VER` bumped + non-current `?v=` entries pruned on activate |
| C12 | Lobby showed no spectator presence | "N متفرج" chip from `lobbyState.spectators` |

Cache tags bumped per convention (`app.js?v=49`, `board3d.js?v=23`, `domboard.js?v=2`, `sfx.js?v=16`, `style.css?v=45`, `sw.js` v2) in index.html and every importer; APK assets regenerated with `mobile/sync`.

### K.4 Deliberately deferred (bigger bets, not fixes)

- **2v2 team play** (partners across, partner tile visibility, team scoring) — largest missing
  feature; needs an engine seating/partner model first (L).
- **i18n / language toggle** — all strings are hardcoded Egyptian Arabic; needs a string table (L).
- **Server-side stats / match history / leaderboard** — stats are per-device localStorage by design;
  needs persistence decisions (M/L).
- **Password-protected rooms** — join brute-force guard is per-socket only (M).
- **Spinner-arm-control bot term, 3-ply expectimax over unseen tiles, blocked-hand pip-parity play**
  — evaluator extensions that need dedicated tuning time (M/L each).
- **plan.md v1 drift** (protocol.js validation layer, rules-*.js split, separate handEnd/matchEnd
  events, 1000-game fuzz) — documented as superseded by the shipped design; not "fixed".

### K.5 Verification

1. `node --check` on every edited JS file.
2. `npm test` — engine + bot suites including the new anti-cheat invariance test.
3. `npm run e2e 3100` + `npm run e2e:voice 3100` against a live server.
4. `cd mobile && npm run sync` to regenerate APK assets.
5. Cache-tag consistency checked across index.html + importers.












