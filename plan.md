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












