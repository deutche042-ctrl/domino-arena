# AGENTS.md

## Project overview

**Domino Arena** — real-time online dominoes (2–4 players, variants: Block / Draw / All Fives). Node.js + Express + Socket.IO server hosting a vanilla-JS + Three.js browser client. No build step, no framework, no accounts — rooms with 4-letter codes shared via the live Render URL or Cloudflare Tunnel.

Node >= 18, ESM throughout (`"type": "module"`).

## Commands

```bash
npm start                    # game server on http://localhost:3000
npm test                     # node --test engine + bot unit tests (~0.5s)
npm run e2e 3100             # socket protocol e2e — needs a server already running on :3100
npm run e2e:voice 3100       # voice signaling + chat protocol e2e — same running-server requirement
```

For e2e: start the server first, e.g. `PORT=3100 npm start` in one shell, then `npm run e2e 3100`
and/or `npm run e2e:voice 3100`. Both scripts take the port as `argv[2]` and default to 3100; they
are black-box (socket.io-client) and end with a watchdog that exits non-zero on a hang.

`play.bat` (Windows): starts the server + a cloudflared tunnel for public play.

Env knobs: `PORT` (server, default 3000), `TURN_TIME_MS` (per-turn limit, default 30000, min 1000),
`MAX_ROOMS` (room-create cap, default 50 — server memory guard), and the optional voice TURN relay
`TURN_URLS` (comma-separated `turn:`/`turns:` URLs) plus `TURN_USER`/`TURN_PASS`; `TURN_SECRET`
(and optional `TURN_TTL`) mints short-lived coturn credentials instead. With no TURN configured,
`/voice-config` returns an empty list and clients keep their built-in STUN defaults.

There is no linter or formatter configured; do not introduce one or add build tooling.

Hosting: `render.yaml` blueprint (free plan, `healthCheckPath: /healthz`); free-tier sleep is
defeated by a cron-job.org ping on `/healthz` every 5 min. `server.js` also sets
`trust proxy 1` for correct client IPs behind the Render/Cloudflare proxy.

## Architecture

Strict layering — dependencies point one way only: `server → engine`. Never the reverse, and never IO in the engine.

### `engine/` — pure game logic (no IO, no timers, all state serializable)

- `deck.js` — deck build, seeded shuffle (`mulberry32`), tile helpers. Tile ids are `"a-b"` normalized with `a <= b`.
- `game.js` — `DominoGame` class. Owns all rules: variants (`block`/`draw`/`allfives`), turn order, boneyard, spinner (first double in All Fives opens 4 arms: L/R/U/D), scoring (All Fives scores multiples of 5 instantly; hand-end pip scoring; blocked-hand tiebreak; anti-stall guard after 3 scoreless hands).
- `bot.js` — pure bot brain: `chooseAction(game, pid, { level, rng })` → play/draw/pass. Anti-cheat by contract: decides only from public info (own hand + `viewFor`-equivalent data), never opponent hands or boneyard order; simulates candidates on a JSON clone of the game (`cloneGame`, also exported). Levels: `easy`/`medium`/`hard`. Single plug-point for a future trained policy.
- `viewFor(pid)` is the ONLY way state reaches clients — per-player projection that hides opponent hands. `legalMoves`/`canDraw`/`canPass` are only populated for the player whose turn it is.
- Deterministic test hook: `new DominoGame({ deal: { hands, boneyard } })` bypasses shuffle (ids forgivingly normalized).

### `server/` — Express + Socket.IO

- `rooms.js` — `RoomManager`: room lifecycle (create/join/leave), lobby state, `gameView(room, pid)` (engine view + names/connection/roomCode merged in). Player = `{ id, token, name, ready, connected, socketId }`; token enables reconnect. Bots: `addBot`/`removeBot`, `isBot` flag, `token: null`, always ready — bots never host and can't keep a room alive alone (`hasHumans` checks in removePlayer/leave/disconnect).
- `server.js` — all socket handlers, namespaced `room:*`, `lobby:*`, `game:*`, `chat:*`, `voice:*` (which take a `cb` ack is spelled out under Gotchas). `sessions` maps `socket.id → { roomCode, playerId }`, and handlers resolve their context with `currentCtx(socket)`. After ANY game mutation call `broadcastGame(room)` — it sends each connected player their own `game:state` view individually (and re-arms the turn timer + bot scheduler). `room:create` with `vsBots: true` + `botLevel` deals an instant human-vs-3-bots match; `lobby:addBot`/`lobby:removeBot` (host-only) seat bots in normal rooms. Bots also send occasional chat emoji via `botChatter`.
- Bot driving: `scheduleBotTurn(room)` arms a short timer (600–1400ms; `room.botDelayMs` override) whenever a broadcast leaves the turn on a bot; `botAct` executes the engine action and re-broadcasts (chaining draws/turns). Timers re-validate room/game/turn on fire — keep that hygiene.
- Disconnect/reconnect: lobby removal after 5s grace, room deletion after 15s all-disconnected, host migration on leave/disconnect (never to a bot). `server.js` calls engine internals (`_endMatch`, `_advanceTurn`) for walkover/turn-skip on disconnect — keep that in sync if engine internals change. Walkover fires only in bot-free rooms; with bots seated the match continues.
- Turn timer: one timer per room, armed on every broadcast for the current player. It deliberately does NOT restart while the same player's turn is live (disconnects/redraws can't refresh the clock). On expiry the engine is forced: `forceSkip` if they had moves, else auto-draw, else auto-pass — each is announced as a system chat message.
- Chat: `chat:send` is rate-limited per socket to 5 messages / 3s; text is trimmed and capped at 200 chars. Every emitted message goes through `pushChat`, gets a room-scoped `mid` (`<room>:cN`) and `at`, and is appended to the bounded room `chatLog` (80 entries). `chat:history` replays that log after create/join/reconnect; `chat:typing` is a 1200 ms-throttled relay (server-derived identity, sender excluded, muted players dropped); `chat:limited` is sent at most once per 3 s window with `retryAfterMs`, and muted sends are dropped before the rate counter.
- Voice: signaling and moderation only — `voice:join`, `voice:leave`, `voice:mute`, `voice:moderate`, `voice:signal`, with `voice:roster` broadcasts. Media is a browser-to-browser WebRTC mesh and never reaches the server. Only seated, connected, non-bot, voice-joined humans may signal (spectators and outsiders are rejected); `voice:signal` derives `from` server-side and caps payloads at 16 KB and 200 signals / 10 s. Host mute is UI-level best-effort moderation, not a security boundary.
- `GET /voice-config` returns `{ iceServers }` built from `TURN_URLS` + `TURN_USER`/`TURN_PASS` (or ephemeral `TURN_SECRET` credentials), rate-limited to 20 requests/min/IP. It exposes no other env values and no credentials in logs.
- Join guard + spectators: `room:join` counts failed joins per socket (5 per 10s) and per IP (`joinFailsByIp`, 20 per 60s backstop vs socket-rotation code scanning); a successful join resets both. Joining a full or mid-match room rides along as a **spectator** — registered in `sessions` and the socket.io room, but with no seat in `room.players`, so gameplay handlers no-op for that id.

### `public/` — client, plain ES modules loaded from index.html (no bundler)

Three.js (0.160.0), socket.io-client (4.8.1) and the Cairo/Reem Kufi fonts are **vendored** under
`public/vendor/` (served through the importmap + one script tag) — the game runs fully offline; do not
reintroduce CDN URLs. No npm client deps. Screens are the three `<section class="screen">` elements:
home → lobby → game.

- `js/app.js` — UI orchestration + socket client: screen switching, scoreboard, hand rendering, modals, chat, confetti. Talks to server only via the socket events above. Also owns the home stats (`loadStats`/`recordMatchResult`), the bot level/personality pickers, the tile-theme picker, the perf overlay (`P` key), the score roll-up (`rollNumber` + `_scorePrev`), and `createBoard()`.
- `js/board3d.js` — Three.js board: snake layout with L/R ends plus U/D spinner arms, auto-fit camera, click targets for ends (`onMarkerClick`). Resources are pooled (see F3.1 below); `setTheme(name)` repaints in a new skin; `setCanDraw(b)` drives the boneyard spotlight; `setMyTurn(b)` is vestigial (the centre turn ring was removed) and only feeds `stats()`, which feeds the perf overlay.
- `js/domboard.js` — **removed.** There is no 2D table mode or DOM fallback; the 3D table is the only table. If `new Board3D` throws (WebGL unavailable), `createBoard()` returns `null` and the hand/HUD/action bar remain fully playable, with an Arabic notice.
- `js/home3d.js` — animated Three.js home-screen backdrop.
- `js/quality.js` — adaptive quality tier (`auto`/`high`/`low`, persisted in `localStorage('domino_quality')`); auto mode runs a ~2s frame-time probe that can downgrade once per session. `board3d.js`/`home3d.js` wire composer/shadow budgets/pixel-ratio to it; the home-screen quality chip row calls `setQuality`.
- `js/tiles.js` — canvas-painted tile faces/backs/felt textures (data-URL cached). F4.3: a `THEMES` registry paints four skins (`classic`/`neon`/`wood`/`piano`); `setTheme(name)` clears the data-URL cache so the next paint uses the new skin. The board keys its texture cache by theme, so the pool stays bounded across switches.
- `js/sfx.js` — WebAudio-synthesized sounds (no audio files). Game sound effects only; voice is a separate system, not part of the SFX module.
- `js/voice.js` — fresh WebRTC mesh voice engine for seated players. No imports and no browser work at module-evaluation time. Voice is opt-in: nothing calls `getUserMedia` until the user taps the mic / join button, and the module requires a secure context (`https:` or localhost) — on plain HTTP it reports the Arabic "needs a secure connection" error instead of prompting. It owns the peer connections, push-to-talk, self/host mute handling, device switching, speaking detection, and the `/voice-config` fetch. The server relays signaling only; audio stays peer-to-peer.
- `css/style.css` — all styling, single file. The 3D board is the only table; the old `.board2d` fallback styles were removed.

**Resource-pooling rules (F3.1) — read before touching the board.** The tile geometry (`_geo`), hit-area geometry/material (`_hitBoxGeo`/`_hitMatC`), side material, and the pooled face/back materials (`_matCache`/`_backMatC`) are **shared**. `_disposeTileMesh` deliberately skips them — disposing one would blank every tile using it. `dispose()` is the only place that may release them, and it is idempotent. The `engine/` `attachableEnds()` cache (F3.2) is a `WeakMap`-keyed revision counter so the engine stays pure and serializable.

**Reduced motion (F4.4).** `board3d.js` reads `prefers-reduced-motion: reduce` once at construction and flattens the arc/drop flourishes; `app.js`'s `prefersReducedMotion()` makes score roll-ups snap. Keep new animation behind that gate.

**Cache-busting convention:** every client asset is imported with a `?v=N` query
(`js/app.js?v=68`, `./board3d.js?v=30`, `./home3d.js?v=6`, `./tiles.js?v=15`, `./quality.js?v=2`, `./sfx.js?v=17`, `./voice.js?v=2`, `css/style.css?v=70`). When you edit a client
module, bump its tag in `index.html` and in every importer's `import` line — otherwise browsers keep
running the stale module and your change appears to do nothing.

### Tests

- `tests/engine.test.js` — `node:test` unit tests: rules per variant (incl. spinner arm ordering and immediate All-Fives scoring) + a 300-game fuzz per variant.
- `tests/bot.test.js` — bot legality across variant × level, seed determinism, no-mutation of the inspected game, and the anti-cheat boundary.
- `scripts/e2e.js` — black-box protocol test over `socket.io-client` (rooms, lobby, gameplay, chat, reconnect) against a running server.
- `scripts/e2e-voice.js` — black-box protocol test for the fresh voice system (join/roster, self and host mute/moderation, signal relay, oversized-signal drop, spectator rejection, disconnect cleanup) plus the chat upgrades (history, `mid`/`at`, typing, rate limiting, reconnect persistence). Needs a running server; run `npm run e2e:voice <port>`.
- The e2e suites duplicate the game protocol in JS; change a socket event's shape and they must be updated with the server.

### Ignored / throwaway paths

- `scratch/` and `scratch_diff.txt` — throwaway working files, gitignored. Safe to ignore, never ship.
- `gui-test-screenshots/`, `.zcode/` — gitignored workspace-local output (screenshots, plan files).
- `docs/RULES.md` — the original full design/rules document (rules verified against pagat.com). Read it for rules intent; it predates bots, so the code wins on current behaviour.
- `plan.md` — the current approved plan: full web visual overhaul + Android removal.

## Git policy (mandatory for every AI agent)

- **Commit after every verified change.** As soon as your change passes its verification (tests/audit/visual check), `git add` only the files you touched and `git commit` immediately — do not batch unrelated work into one commit, and never leave a finished change uncommitted.
- Commit message format: one line, English, imperative, naming the area — e.g. `board3d: fix U-arm pip mirroring`, `server: reconnect grace 5s`. No AI attribution lines.
- Never amend/rebase/reset someone else's commits. Never delete or overwrite files you did not create. If an edit collides with another session, re-read and re-apply surgically.
- Throwaway files belong in `scratch/` (gitignored). Never commit scratch artifacts, screenshots, or temp harnesses — the temp harness pattern is: put it in `public/`, verify, delete it in the same task.
- Verify before committing: `npm test` must pass if engine/ or tests changed; `node --check` on edited JS files is the minimum bar.

## Conventions

- **Server-authoritative**: opponent hands never leave the server; clients only render `game:state` views and send intents (`game:play/draw/pass`). Illegal moves throw `IllegalMove` → socket `error` event.
- **User-facing strings are Arabic (Egyptian dialect)** — server error messages and client UI text. Code comments/identifiers are English. Match this when adding strings.
- Engine must stay pure and pass `npm test` (including the fuzz test) — no DOM, no socket, no clock access inside `engine/`.
- Only the host can mutate room config / start game / advance hand / rematch (enforced server-side).
- CSS/JS: no framework, no transpile — keep everything loadable directly by the browser.

## Gotchas

- **There are no unit tests for `server/` or `public/`.** A change to `server.js` is only covered by the
  e2e scripts — run `npm test` for engine changes and the relevant `e2e` script(s) for server changes.
- **The socket protocol is by convention, with no shared types.** Adding or renaming an event means
  touching the handler in `server.js`, the emit/listener in `app.js`, and the e2e script.
  Handlers whose failure the UI must show take a trailing `cb` and answer `{ ok, error }` with an Arabic
  message (`room:*`, `lobby:config`, `lobby:addBot`/`removeBot`, `game:start`).
  The gameplay/chat events are fire-and-forget: `doAction` catches
  `IllegalMove` and reports it on the `error` event (`{ code: 'illegal', message }`) instead.
- **Guard conditions in gameplay handlers `return` silently, not loudly.** `game:play` with a non-string
  tile, `game:nextHand` when the status isn't `handEnd`, a non-host `game:rematch` — all just return.
  A bug that looks like "nothing happens" is usually one of these guards, not a broken broadcast.
- **New socket handlers should resolve their room/player through `currentCtx(socket)`** (backed by the
  `sessions` map) rather than trusting client-sent room codes. If you add a join path, register it in
  `sessions` too or `currentCtx` returns `{}` and the handler silently no-ops.
- Three.js is pinned to `0.160.0` through the importmap (`three` and the `three/addons/` prefix). Addons
  must be imported through that prefix, not a relative CDN path.
- Timers are the recurring source of races here. Both the turn timer and the bot scheduler re-validate
  room identity, game object, and turn on fire — preserve that when editing `armTurnTimer`/`scheduleBotTurn`.
- Bots are seated without a socket and are always "connected"; any new "is this player real?" check should
  test `p.isBot`, not `p.socketId` or `p.connected`.
- **Rapid join attempts trip the tiered join lockout** (5 failed `room:join`s per socket per 10s, 20 per IP
  per 60s — see the server section). E2e tests and manual probing that fail joins in quick succession get the
  Arabic "too many attempts" error and look like a broken handler; space failed joins out or join successfully
  to reset the counters. A connected-but-seatless client may also just be a spectator of a full/mid-match room.
