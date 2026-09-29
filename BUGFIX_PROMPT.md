# Domino Arena — Full Bug Audit & Fix Prompt (2026-09-29)

Produced by a 5-slice audit (engine · server · client core · 3D board · voice+mobile).
**Baseline: all suites currently green** — `npm test` 46/46, `npm run e2e` 70/70, `npm run e2e:voice` 45/45.
Every finding below therefore lives in the gaps the suites don't cover. The engine slice
additionally re-verified the rules core with a 275,239-position differential fuzz (zero divergence),
and the top engine findings were confirmed with live repros. Server S1 was confirmed with a live
socket exploit against a running server.

---

## MASTER FIX PROMPT (copy-paste this whole file's findings into the fixing agent)

You are fixing audited bugs in **Domino Arena** (`/home/mahmoud/Downloads/domino`). Non-negotiable
constraints (full details in AGENTS.md):

- Strict layering `server → engine`; engine stays pure (no IO/timers/DOM) and must pass `npm test`
  (includes a 300-game fuzz per variant). Never break purity to fix a server bug.
- Client has no build step; every edited client module needs its `?v=N` tag bumped **in `index.html`
  AND in every importer's import line** (app.js?v=48, board3d.js?v=22, home3d.js?v=2, domboard.js?v=1,
  tiles.js?v=13, voice.js?v=5, style.css?v=44). A fix without a bump does not exist for returning browsers.
- User-facing strings are Arabic (Egyptian dialect); code/identifiers English. No new frameworks,
  no linters, no transpile.
- The F3.1 pooling contract in `board3d.js` is sacred: `_geo`, `_hitBoxGeo`, `_hitMatC`, `_sideMatC`,
  `_matCache`, `_backMatC`, `_texCache` are shared; only `dispose()` may release them.
- Voice mute asymmetry is intentional: `hostMuted` survives the target's own `voice:mute`/`voice:join`;
  `voice:leave`/disconnect clear it. `scripts/e2e-voice.js` documents the contract.
- Handlers whose failure the UI must show take a trailing `cb` and answer `{ ok, error }` in Arabic.
  Gameplay guards `return` silently by convention — but a guard that is *wrong* is a bug.
- After any server/client edit consumed by the APK: `cd mobile && npm run sync`.
- Verify per area: engine → `npm test`; server → `PORT=3100 npm start` + `npm run e2e 3100` +
  `npm run e2e:voice 3100`; client → manual check + `node --check`. Commit after each verified fix
  (one line, imperative, area-named, no attribution).

**Suggested fix order:** S1 → E1 → E2 → C1 → the S2–S6 session-lifecycle cluster (one shared
"detach current room" helper fixes S2+S3 together) → C2–C5 → B1 → P3 batch → cache-bump + `mobile sync` last.

---

## P0 — one packet kills the server

### S1 · Malformed socket payload crashes the whole process (remote DoS)
- **Where:** `server/rooms.js:57` (`(code || '').toUpperCase`), `rooms.js:276` (`(name || "Player").slice`),
  `rooms.js:190` (`sanitizeConfig(null)` → `cfg.variant` TypeError); destructuring handlers at
  `server/server.js:282, 316, 437, 645, 703, 720, 745`.
- **Trigger:** any connected client emits one crafted packet: `socket.emit('room:join', null)`,
  `room:create {name: 123}`, `lobby:config` with `null`, or `null` to any destructuring handler
  (`chat:send`, `lobby:ready`, `game:play`, `voice:*`, `lobby:kick`…). `({x} = {})`-style handlers throw
  on `null`; socket.io v4 dispatches listeners inside `process.nextTick` with **no try/catch**, so it
  becomes an `uncaughtException` and the process dies. Verified live.
- **Fix:** (a) null-safe handlers — start each with `if (!p || typeof p !== 'object') return cb?.({ ok:false, error:'…' });`
  or destructure with `(payload = {})` **plus** a null check (defaults don't catch `null`); add
  `typeof code/name === 'string'` guards where strings are required. (b) Belt-and-braces: a socket
  middleware (`io.use(([event], next) => next())` pattern) or a narrow `process.on('uncaughtException')`
  that logs and continues — prefer (a); (b) is a safety net, not the fix.

---

## P1 — wrong behavior in common flows

### E1 · Opponent's drawn tile id leaks to every player
- **Where:** `engine/game.js:296` records `lastAction = { type:'draw', pid, count:1, tileId: tile.id }`;
  `viewFor` exposes `lastAction` verbatim (via `server/rooms.js:240`).
- **Trigger:** any draw in Draw/All Fives — every client receives exactly which tile the drawer picked
  (boneyard order is otherwise never exposed). Confirmed by repro: `g.draw('a')` → `g.viewFor('b').lastAction.tileId`.
  The client doesn't need it (it diffs the drawer's own hand; others only show "سحب كارت").
- **Fix:** in `viewFor`, omit `tileId` from draw-type `lastAction` unless `pid === viewer`.

### E2 · 'expert' bot violates the anti-cheat contract (reads opponent hands)
- **Where:** `engine/bot.js:125-128` evaluates the opponent's *actual* reply via `sim.legalMoves(nextPid)`
  → reads `sim.hands[nextPid]` (`bot.js:157`, `myFlexibility` at `bot.js:222-227`). Header contract
  (`bot.js:3-8`) forbids this; the inline rationalization is wrong — `viewFor` populates `legalMoves`
  only for the viewer, so another player's legal moves are private info. `expert` is shippable
  (`server/rooms.js:16`).
- **Trigger (confirmed):** two positions identical in all public + unseen info, hidden pair merely
  swapped between opponent's hand and boneyard → `expert` picks differently; `hard` picks identically.
- **Fix:** score the best reply from `unseenTiles` (the way `dangerForNextPlayer` already does) instead
  of the opponent's real hand/legal moves.

### C1 · Spectator "claim seat" button permanently breaks the ready button
- **Where:** `public/js/app.js:349-371` (`renderLobby`): the `spectating` branch sets
  `btnReady.onclick = claim-seat`, but the `else` branch only updates text/disabled — it never restores
  the ready-toggle handler installed by `initLobby` (`app.js:420-425`).
- **Trigger:** join a full room (spectator) → tap "اقعد والعب 🪑" → seat claimed. Now every tap of the
  ready button re-runs the claim path: `room:leave` + `room:join` — the player leaves and re-joins
  (new playerId, ready=false) instead of toggling ready. Also: for spectators in a *playing* room the
  button is visible (`isHost || spectating && st.state !== 'lobby'` precedence) and causes seat churn.
- **Fix:** in the `else` branch restore the ready handler (extract `assignReadyHandler()` used by both
  `initLobby` and `renderLobby`), and hide the claim button when `st.state !== 'lobby'`.

---

## P2 — edge-case wrong behavior / leaks / hangs

### E3 · `_deal` never invalidates the derived-ends cache
- **Where:** `engine/game.js:72-120` (`_deal` replaces state without `_invalidateEnds()`); cache check
  at `game.js:137-139`.
- **Trigger:** the normal server flow cache-hits the *previous hand's* ends on the first
  `attachableEnds()` after `nextHand()` (repro: returns `[{end:'L',match:1},{end:'R',match:5}]` instead
  of the lead pseudo-end). Masked today only because in-engine callers guard on `moves.length`.
- **Fix:** call `this._invalidateEnds()` at the end of `_deal`.

### S2 · Spectator claiming a seat leaks a phantom spectator entry
- **Where:** `server/server.js:316-369` — `room:join` overwrites the session (:356) but never calls
  `removeSpectator`; cleanup paths (:380/:767) only run while the session still says `spectating`.
- **Trigger:** the server's own supported flow (e2e `scripts/e2e.js:296-303`): join as spectator, then
  re-join to claim a seat. The stale `room.spectators` entry keeps the socketId → every `broadcastGame`
  also sends that socket the hand-less `__spectator__` view; 8 leaks exhaust the spectator cap
  (`rooms.js:115`) and lock spectators out forever.
- **Fix:** at the top of `room:join`/`room:create`, if `sessions.get(socket.id)?.spectating`, call
  `manager.removeSpectator(...)` before overwriting the session.

### S3 · Joining/creating while seated elsewhere leaks a phantom player — can immortalize rooms
- **Where:** `server/server.js:282-314` (create), `:316-369` (join); cleanup only on disconnect
  (:797-804); idle sweeper skips playing rooms (:268-270).
- **Trigger:** socket in room A sends `room:join`/`room:create` for room B without `room:leave`.
  Seat A keeps `connected:true` + old socketId; the socket also stays in A's socket.io channel (dual
  broadcasts). No disconnect ever fires for A; a playing room whose only human is this phantom persists
  forever (and with bots, `handleTurnTimeout` keeps force-skipping through hand ends).
- **Fix:** extract a shared `detachCurrentRoom(socket)` helper (leave seat, `socket.leave(oldCode)`,
  remove spectator if any, broadcast both rooms) and call it at the top of `room:create`/`room:join`.
  This one helper closes S2+S3.

### S4 · Four handlers never answer their ack — client hangs silently
- **Where:** `server/server.js:429, 431, 447, 457, 483` — `lobby:config`, `lobby:addBot`,
  `lobby:removeBot`, `game:start` early-return without `cb?.({ok:false,…})` when the room is gone or
  the game already started. Inconsistent with `lobby:chatMute`/`lobby:kick` which answer on the same paths.
- **Trigger:** host's room swept/deleted while UI pending → client `emit()` promise (no timeout, see C5)
  never resolves; the start button flow hangs forever.
- **Fix:** answer `cb?.({ ok:false, error:'الغرفة قفلت أو المباراة بدأت.' })` on every early return.

### S5 · Missing room-state guards enable a mid-match re-deal
- **Where:** `server/server.js:437-443` (`lobby:ready` has no `room.state` check, unlike `lobby:config`
  at :431); `:481-493` (`game:start` doesn't reject `room.state === 'playing'`).
- **Trigger:** crafted clients: non-hosts send `lobby:ready` mid-match, host sends `game:start` →
  `startGame` re-deals and wipes scores mid-match. Low practical reach, but a one-line guard each.
- **Fix:** `if (room.state !== 'lobby') return;` in `lobby:ready`; reject `game:start` when playing
  (with an Arabic ack error).

### S6 · 5s lobby-grace timer lacks room-identity check — can delete a recycled room
- **Where:** `server/server.js:783-790` vs the 15s timer's correct check at :799; `rooms.js:213-216`
  deletes rooms **by code**.
- **Trigger:** lobby player disconnects (timer captures `room`/`p`) → room deleted → code reused by a
  new room → timer fires `removePlayer` on the stale object and `rooms.delete(room.code)` kills the
  *unrelated new room*.
- **Fix:** `if (manager.getRoom(room.code) !== room) return;` at the top of the 5s callback.

### C2 · Local stats: a rematch with the same score line is never recorded
- **Where:** `public/js/app.js:993-995` — `recordMatchResult` dedups on
  `matchWinnerId + ':' + sortedScores`, and `recordedMatchKey` is only ever reset by that check;
  `socket.on('game:started')` (:2369-2378) resets other transient state but not this key.
- **Trigger:** 2-player rematch where the loser finished 0 again (or any identical final score line) →
  `recordMatchResult` silently no-ops → matches/wins/streak drift from reality.
- **Fix:** reset `recordedMatchKey = null` in the `game:started` handler.

### C3 · APK: switching LAN servers recreates VoiceChat without leaving — old mic stays captured
- **Where:** `public/js/app.js:2418-2424` (`connectToBase` → `startSocket` → `initVoice` at :2326) —
  the old `VoiceChat` is never `leave()`d; its `getUserMedia` stream survives (mic indicator stays on),
  its `<audio>` elements and analyser graph linger.
- **Trigger:** in-app, tap another phone in the LAN list (or back-to-self) while the mic is open.
- **Fix:** in `connectToBase`, before `socket.disconnect()`: `voice?.leave(); voice = null; voiceSelf = {...}; speakingSet.clear(); updateMicUI();`

### C4 · Cache-busting miss + leftover debug harness in index.html
- **Where:** `public/index.html:403` ships a `window.__errs` error-collector script (an uncommitted
  GUI-test temp harness — AGENTS.md says temp harnesses get deleted in the same task). `public/js/home3d.js`
  content changed in the worktree (tiles.js?v=11 → v13 import) but is still imported as
  `./home3d.js?v=2` (`app.js:4`) — cached browsers keep the old home3d importing tiles v11 (duplicate
  module instance / stale skin).
- **Fix:** delete the `__errs` collector block; bump `home3d.js?v=2` → `v=3` in app.js (and anywhere
  else it's imported). Re-check all `?v=` tags whenever this batch ships. Then `cd mobile && npm run sync`.

### C5 · Client `emit()` promise has no timeout (client half of S4)
- **Where:** `public/js/app.js:2278-2280` — `new Promise(resolve => socket.emit(event, payload, resolve))`.
- **Trigger:** any un-acked handler (S4) or dead socket → button flows hang with no feedback.
- **Fix:** resolve with `{ ok:false, error:'السيرفر مش بيرد' }` after ~8s (mirror `voice.js` `_joinAck`).

### B1 · Board3D render loop never pauses off the game screen
- **Where:** `public/js/board3d.js:138-145` — the rAF `_loop` only pauses on `visibilitychange`;
  `showScreen` (`app.js:109-118`) gates `home3d`/`lobby3d` via `setActive` but nothing pauses the board.
- **Trigger:** finish a match → home screen → the full 3D table (shadows, turn-ring pulse, camera
  easing) keeps rendering at 60fps behind the home UI until the tab is hidden. Real battery/GPU drain
  on phones.
- **Fix:** call `board?.pauseLoop?.()` when leaving `game` and `board?.resumeLoop?.()` when entering
  `game` in `showScreen` (DomBoard has no such methods — optional chaining covers the fallback).

---

## P3 — robustness / polish

### E4 · Deal test hook fabricates ghost tiles, accepts duplicates, crashes on non-strings
- `engine/game.js:84-91`: unknown id → `{...undefined}` → `{}` hand tile (poisons `handPips`/tiebreak
  with NaN); `['6-6','6-6']` accepted; non-string id → raw TypeError. Fix: throw loudly on unknown ids,
  duplicates across hands/boneyard, and non-string ids.

### E5 · Stall-guard loophole: a 0-point *won* hand resets the scoreless counter
- `engine/game.js:384-385`: the `else` resets `_scorelessHands` even when a won hand awards 0 points
  (All Fives: opponents hold ≤2 pips → 0). A pathological match can dodge the 8-hand guard forever.
- Fix: advance the counter on any hand awarding 0 points, not only winnerless ties.

### E6 · `handSize` override can silently over-deal the 28-tile deck
- `engine/game.js:56, 96-100`: no capacity check (repro: 3P × 12 → hands 12/12/4, boneyard 0, no error).
- Fix: throw in the constructor when `playerIds.length * handSize > 28`.

### E7 · `allowPass=false` + `turnMs=0` soft-locks a stuck player/bot
- `engine/game.js:201-205` (`canPass` false), `engine/bot.js:62-63` (`chooseAction` returns `null`),
  `server/server.js:108-112` (`turnMs===0` clears the only force-skip driver) → hand deadlock.
- Fix: engine surfaces a forced-skip action when stuck with `allowPass:false`, or the server refuses
  the `allowPass:false` + `turnMs:0` combination in `sanitizeConfig`.

### S7 · Kick doesn't detach the kicked socket or its voice state
- `server/server.js:523-537` vs the proper detach at :349-351: kicked socket keeps its `sessions`
  entry, channel membership, and voice flags → keeps receiving room broadcasts; roster shows them in
  voice until an unrelated voice event. Fix: delete the kicked socket's session, `socket.leave`, clear
  voice flags, `broadcastVoice`.

### S8 · Token re-claim from a second live socket leaves stale `p.voice`, orphans the first socket
- `server/server.js:347-356`: no voice reset and no notice to the old socket → roster shows "in voice",
  SDP relayed to a dead socket, old tab no-ops silently. Fix: clear voice flags on re-claim, emit a
  "superseded" notice to the old socketId.

### S9 · Per-socket rate limits reset on reconnect
- `server/server.js:277-278` (joinFails), `:643-650` (chat): disconnect/reconnect or N sockets = fresh
  budget → the 4-letter room-code space (~923k) is scannable; chat spam too. Fix: key join-failures by
  IP (`socket.handshake.address`; `trust proxy 1` already set) in a small Map.

### S10 · `botDelayMs` uncapped; `voice:hostMute {pid}` can target bots
- `server/server.js:293-295` (min 25, no max → 24h bot timers brick a room), `:733-736` (pid branch
  lacks the `isBot` skip the `all` branch has). Fix: clamp to 25–5000; reject bot pids with an Arabic ack.

### C6 · `connect_error` unhandled; connPill starts as "ok"
- `public/index.html:209` (`class="ok"`), `app.js:2367` (only `disconnect` handled): with the server
  down at boot the pill shows OK forever. Fix: start as "bad", handle `connect_error` → bad.

### C7 · Stale selection + board markers survive the turn changing
- `app.js` never clears `selectedTile` on `game:state`; `Board3D.sync` clears markers only when moves
  changed (`board3d.js:605` early-return path). After a force-skip with markers up, clicking the stale
  marker emits an illegal `game:play` → spurious error banner. Fix: clear `selectedTile`/markers when
  `view.turn !== myId` in `renderGame`.

### B2 · Drop-arc animation reads `mv.end` instead of `mv.e`
- `board3d.js:675` — move records are `{t, e, f, p}` (`engine/game.js:246,265`), so `mv.end` is always
  undefined and the arc always comes from the left. One-token fix: `mv.e`.

### B3 · Boneyard hit boxes lack the `isHitArea` flag
- `board3d.js:783` sets `{ isBoneyard, index, targetMesh }` but no `isHitArea`, while
  `animateDraw` (:797) filters `!c.userData.isHitArea` → it "removes" the invisible hit box instead of
  the visible tile (self-heals on the next `_syncBoneyard` rebuild, but the last tile briefly keeps its
  tile mesh and loses its generous hit area). Fix: add `isHitArea: true` to boneyard hit userData.

### B4 · Exported `chainEnds` helper ignores the flip flag (latent, currently unused)
- `domboard.js:44-57` reports the end value as `t.a` of the last tile at that end, ignoring `mv.f`
  (flipped tiles' outer pip is `t.b`); also folds `U` into 'L' and `D` into 'R'. No internal callers
  today; fix before anyone builds on it: respect `f`, and either expose all four ends or document the
  2-end simplification.

### B5 · `Board3D.dispose()` doesn't stop the loop or remove listeners (latent)
- `board3d.js:1179-1207` disposes GL resources but leaves the rAF `_loop` running (renders into a
  disposed renderer) and the window/document/canvas listeners attached. Nothing calls `dispose()` today;
  fix it before it ever gets called: `pauseLoop()` + named listener refs + `removeEventListener`.

### V1 · UDP offer `port` field is unvalidated (launcher)
- `mobile/launcher.cjs:83-84`: `markPeer(rinfo.address, m.port || GAME_PORT)` accepts any JSON value
  (string/object) from any LAN peer; it flows into `/status` and the WebView's join URL. Fix: accept
  only integers 1–65535.

### V2 · `tcpSweep`'s open-socket counter never decrements on "open but not domino"
- `mobile/launcher.cjs:150-160`: on `connect` where `dominoAlive()` is false, and on `timeout`, neither
  `open` is decremented nor `finish()` called → whenever any non-domino TCP service answers on :3000 in
  the subnet, the sweep always rides out the full 1800ms timeout. Bounded, just sloppy. Fix: decrement
  in a single `close`/`finish` path.

### V3 · Ops note: default TURN relay (OpenRelay) is a free public service with known reliability issues
- `voice.js:34-43`. The code already surfaces ICE-candidate errors (`:658-665`), and `/voice-config`
  (`server/server.js:50-54`) can inject a self-hosted coturn via `TURN_URLS`/`TURN_USER`/`TURN_PASS`.
  Not a code bug — a deployment recommendation for cross-network play.

---

## Verified-solid (don't "fix" these)

- Engine rules core (turn order, lead rules, draw/pass legality, blocked detection, spinner arms,
  multiple-of-5 scoring, tiebreak) — 275k-position differential fuzz, zero divergence; `cloneGame`
  deep-copies completely; `attachableEnds` cache correct under normal mutation.
- Server timer hygiene (`armTurnTimer` refuses re-arm for the live turn; bot scheduler + 15s deletion
  re-validate room identity/game/turn), `voice:signal` validation (both endpoints in voice, 16KB cap,
  spectators/bots excluded), every gameplay mutation reaches `broadcastGame`.
- Voice v3 recovery budget (one restart → one rebuild, reset only on 'connected') cannot loop;
  mic re-capture is once-per-episode; `/peer/<ip>` SSRF-guarded to `192.168.*.*`; launcher never
  `process.exit`s and never writes to its own dir; `sync.mjs` copy covers all client assets incl. `sw.js`.

## Final verification checklist (run after the fix batch)

```bash
npm test                                   # engine + bot (46) — must stay green
PORT=3100 npm start &                      # then:
npm run e2e 3100                           # protocol (70)
npm run e2e:voice 3100                     # voice protocol (45)
node --check server/server.js && node --check server/rooms.js
node --check public/js/app.js && node --check public/js/board3d.js && node --check public/js/voice.js
# manual: spectate→claim→ready (C1), theme switch, LAN peer switch with mic open (C3),
#         home screen GPU idle (B1), null-packet smoke test (S1)
cd mobile && npm run sync                  # only after client/server edits ship
```
