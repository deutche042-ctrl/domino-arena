# AGENTS.md

## Project overview

**Domino Arena** — real-time online dominoes (2–4 players, variants: Block / Draw / All Fives). Node.js + Express + Socket.IO server hosting a vanilla-JS + Three.js browser client. No build step, no framework, no accounts — rooms with 4-letter codes shared via Cloudflare Tunnel.

Node >= 18, ESM throughout (`"type": "module"`).

## Commands

```bash
npm start                    # game server on http://localhost:3000
npm test                     # engine unit tests (node --test, 17 tests incl. fuzz)
npm run e2e 3100             # socket protocol e2e — needs a server already running on :3100
```

For e2e: start the server first, e.g. `PORT=3100 npm start` in one shell, then `npm run e2e 3100`.

`play.bat` (Windows): starts the server + a cloudflared tunnel for public play.

There is no linter or formatter configured; do not introduce one or add build tooling.

## Architecture

Strict layering — dependencies point one way only: `server → engine`. Never the reverse, and never IO in the engine.

### `engine/` — pure game logic (no IO, no timers, all state serializable)

- `deck.js` — deck build, seeded shuffle (`mulberry32`), tile helpers. Tile ids are `"a-b"` normalized with `a <= b`.
- `game.js` — `DominoGame` class. Owns all rules: variants (`block`/`draw`/`allfives`), turn order, boneyard, spinner (first double in All Fives opens 4 arms: L/R/U/D), scoring (All Fives scores multiples of 5 instantly; hand-end pip scoring; blocked-hand tiebreak; anti-stall guard after 3 scoreless hands).
- `bot.js` — pure bot brain: `chooseAction(game, pid, { level, rng })` → play/draw/pass. Anti-cheat by contract: decides only from public info (own hand + `viewFor`-equivalent data), never opponent hands or boneyard order; simulates candidates on a JSON clone of the game. Levels: `easy`/`medium`/`hard`. Single plug-point for a future trained policy.
- `viewFor(pid)` is the ONLY way state reaches clients — per-player projection that hides opponent hands. `legalMoves`/`canDraw`/`canPass` are only populated for the player whose turn it is.
- Deterministic test hook: `new DominoGame({ deal: { hands, boneyard } })` bypasses shuffle (ids forgivingly normalized).

### `server/` — Express + Socket.IO

- `rooms.js` — `RoomManager`: room lifecycle (create/join/leave), lobby state, `gameView(room, pid)` (engine view + names/connection/roomCode merged in). Player = `{ id, token, name, ready, connected, socketId }`; token enables reconnect. Bots: `addBot`/`removeBot`, `isBot` flag, `token: null`, always ready — bots never host and can't keep a room alive alone (`hasHumans` checks in removePlayer/leave/disconnect).
- `server.js` — all socket handlers, namespaced `room:*`, `lobby:*`, `game:*`, `chat:*` (ack-style with `cb`). `sessions` maps `socket.id → { roomCode, playerId }`. After ANY game mutation call `broadcastGame(room)` — it sends each connected player their own `game:state` view individually (and re-arms the turn timer + bot scheduler). `room:create` with `vsBots: true` + `botLevel` deals an instant human-vs-3-bots match; `lobby:addBot`/`lobby:removeBot` (host-only) seat bots in normal rooms.
- Bot driving: `scheduleBotTurn(room)` arms a short timer (600–1400ms; `room.botDelayMs` override) whenever a broadcast leaves the turn on a bot; `botAct` executes the engine action and re-broadcasts (chaining draws/turns). Timers re-validate room/game/turn on fire — keep that hygiene.
- Disconnect/reconnect: lobby removal after 5s grace, room deletion after 15s all-disconnected, host migration on leave/disconnect (never to a bot). `server.js` calls engine internals (`_endMatch`, `_advanceTurn`) for walkover/turn-skip on disconnect — keep that in sync if engine internals change. Walkover fires only in bot-free rooms; with bots seated the match continues.

### `public/` — client, plain ES modules loaded from index.html (no bundler)

- `js/app.js` — UI orchestration + socket client: home → lobby → game screens, scoreboard, hand rendering, modals, chat, confetti. Talks to server only via the socket events above.
- `js/board3d.js` — Three.js board: snake layout with L/R ends plus U/D spinner arms, auto-fit camera, click targets for ends (`onMarkerClick`).
- `js/tiles.js` — canvas-painted tile faces/backs/felt textures (data-URL cached).
- `js/sfx.js` — WebAudio-synthesized sounds (no audio files).
- `css/style.css` — all styling, single file.

### Tests

- `tests/engine.test.js` — `node:test` unit tests (rules per variant + 300-game fuzz per variant).
- `scripts/e2e.js` — black-box protocol test over `socket.io-client` against a running server.
- `scratch/` and `scratch_diff.txt` are throwaway working files — safe to ignore, never ship.

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
