# AGENTS.md

## Project overview

**Domino Arena** — real-time online dominoes (2–4 players, variants: Block / Draw / All Fives). Node.js + Express + Socket.IO server hosting a vanilla-JS + Three.js browser client. No build step, no framework, no accounts — rooms with 4-letter codes shared via Cloudflare Tunnel.

Node >= 18, ESM throughout (`"type": "module"`).

## Commands

```bash
npm start                    # game server on http://localhost:3000
npm test                     # node --test engine + bot unit tests (25 tests, ~0.5s)
npm run e2e 3100             # socket protocol e2e — needs a server already running on :3100
npm run e2e:voice 3100       # voice signaling + host-mute protocol e2e — same requirement
```

For e2e: start the server first, e.g. `PORT=3100 npm start` in one shell, then `npm run e2e 3100`.
Both e2e scripts take the port as `argv[2]` and default to 3100; they are black-box (socket.io-client)
and each ends with a watchdog that exits non-zero on a hang.

`play.bat` (Windows): starts the server + a cloudflared tunnel for public play. The tunnel is not just
for convenience — WebRTC voice only works in a secure context, so remote players need the `https://` URL.

Env knobs: `PORT` (server, default 3000), `TURN_TIME_MS` (per-turn limit, default 30000, min 1000).

There is no linter or formatter configured; do not introduce one or add build tooling.

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
- Chat: `chat:send` is rate-limited per socket to 5 messages / 3s; text is trimmed and capped at 200 chars.

### Voice chat (WebRTC mesh)

Signaling rides the game socket; audio is peer-to-peer (no SFU). The server only relays SDP/ICE
(`voice:signal`, and only between two players who are both in voice) and owns the roster broadcast
as `voice:state`. Voice state lives on the player object and is room-scoped, so it survives lobby→game:

- `voice:join` (ack) sets `p.voice`; `voice:leave` clears voice **and both mutes**.
- `p.voiceMuted` is self mute (`voice:mute`); `p.hostMuted` is host-enforced (`voice:hostMute`, ack, `{ pid }` or `{ all: true }`, host only, never a bot).
- The two mutes are deliberately asymmetric: host mute cannot be lifted by the target's own `voice:mute`, and `voice:join` does not clear an existing `hostMuted` (a host-muted player who re-opens the mic stays muted). `voice:leave`/disconnect do clear it — that's a full cleanup, so a rejoining player starts clean.
- The roster reports the *effective* mute (`voiceMuted || hostMuted`) plus a `hostMuted` flag. Bots never join voice and never appear in a roster.

### `public/` — client, plain ES modules loaded from index.html (no bundler)

Three.js and socket.io-client come from CDN via the `<script type="importmap">` in `index.html` — no npm
client deps. Screens are the three `<section class="screen">` elements: home → lobby → game.

- `js/app.js` — UI orchestration + socket client: screen switching, scoreboard, hand rendering, modals, chat, voice panel, confetti. Talks to server only via the socket events above.
- `js/board3d.js` — Three.js board: snake layout with L/R ends plus U/D spinner arms, auto-fit camera, click targets for ends (`onMarkerClick`).
- `js/home3d.js` — animated Three.js home-screen backdrop.
- `js/voice.js` — `VoiceChat` (WebRTC mesh client). The file's header comment is the authoritative design note — read it before touching signaling. Key points: signaling over the game socket, Google STUN + public OpenRelay TURN (TURN is what makes it work behind carrier-grade NAT), "perfect negotiation" with politeness by player-id order, one ICE restart then one rebuild (never a rebuild loop), rosters arriving before `setSelf()` are buffered. Exposes `onSelf`/`onPeers`/`onSpeaking`/`onError`/`onInfo` hooks consumed by `app.js`.
- `js/tiles.js` — canvas-painted tile faces/backs/felt textures (data-URL cached).
- `js/sfx.js` — WebAudio-synthesized sounds (no audio files).
- `css/style.css` — all styling, single file.

**Cache-busting convention:** every client asset is imported with a `?v=N` query
(`js/app.js?v=32`, `./board3d.js?v=16`, `./voice.js?v=2`, `css/style.css?v=30`). When you edit a client
module, bump its tag in `index.html` and in every importer's `import` line — otherwise browsers keep
running the stale module and your change appears to do nothing.

### Tests

- `tests/engine.test.js` — `node:test` unit tests: rules per variant (incl. spinner arm ordering and immediate All-Fives scoring) + a 300-game fuzz per variant.
- `tests/bot.test.js` — bot legality across variant × level, seed determinism, no-mutation of the inspected game, and the anti-cheat boundary.
- `scripts/e2e.js` — black-box protocol test over `socket.io-client` (rooms, lobby, gameplay, chat, voice signaling) against a running server.
- `scripts/e2e-voice.js` — focused voice-protocol test (roster, mute semantics, relay, disconnect cleanup). Its header documents the host-mute survival contract — read it before changing mute rules.
- Both e2e suites duplicate the game protocol in JS; change a socket event's shape and they must be updated with the server.

### Ignored / throwaway paths

- `scratch/` and `scratch_diff.txt` — throwaway working files, gitignored. Safe to ignore, never ship.
- `gui-test-screenshots/`, `.zcode/` — gitignored workspace-local output (screenshots, plan files).
- `plan.md` — the original full design/rules document (rules verified against pagat.com). Read it for rules intent; it predates bots/voice, so the code wins on current behaviour.

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
  touching the handler in `server.js`, the emit/listener in `app.js` (or `voice.js`), and the e2e scripts.
  Handlers whose failure the UI must show take a trailing `cb` and answer `{ ok, error }` with an Arabic
  message (`room:*`, `lobby:config`, `lobby:addBot`/`removeBot`, `game:start`, `voice:join`,
  `voice:hostMute`). The gameplay/chat/voice-signal events are fire-and-forget: `doAction` catches
  `IllegalMove` and reports it on the `error` event (`{ code: 'illegal', message }`) instead.
- **Guard conditions in gameplay handlers `return` silently, not loudly.** `game:play` with a non-string
  tile, `game:nextHand` when the status isn't `handEnd`, a non-host `game:rematch` — all just return.
  A bug that looks like "nothing happens" is usually one of these guards, not a broken broadcast.
- **New socket handlers should resolve their room/player through `currentCtx(socket)`** (backed by the
  `sessions` map) rather than trusting client-sent room codes. If you add a join path, register it in
  `sessions` too or `currentCtx` returns `{}` and the handler silently no-ops.
- **Voice requires a secure context** — getUserMedia only works on `https://` or `localhost`. `VoiceChat`
  exposes `supported`/`secure` getters; check them before assuming a mic failure is a bug.
- Three.js is pinned to `0.160.0` through the importmap (`three` and the `three/addons/` prefix). Addons
  must be imported through that prefix, not a relative CDN path.
- Timers are the recurring source of races here. Both the turn timer and the bot scheduler re-validate
  room identity, game object, and turn on fire — preserve that when editing `armTurnTimer`/`scheduleBotTurn`.
- Bots are seated without a socket and are always "connected"; any new "is this player real?" check should
  test `p.isBot`, not `p.socketId` or `p.connected`.
