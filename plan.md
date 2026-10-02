# Domino Arena — Full Web Visual Overhaul + Android Removal

## Objective
Complete visual upgrade of the web game (3D graphics + full UI redesign for home / lobby / game screens), with an adaptive quality system so low-end devices stay smooth, while fully removing the Android (`mobile/`) app and its glue code. Arabic (Egyptian) strings and RTL layout are preserved; no CDNs, no build step; e2e protocol untouched so `npm run e2e` keeps passing.

---

## Part A — Remove Android version fully

**Delete:** the whole `mobile/` directory.

**`public/js/app.js`** — strip APK-only glue:
- Remove `IN_APP`, `STATUS_URL`, `LOCAL_BASE`, `activeBase`, `connectToBase`, `netPill`, `startAppNet`, `tickLan`, `p_list`, `peerLabels`, `initAppNetUI` (lines ~2042–2250).
- Simplify `boot()` to always `startSocket('')`.

**`public/index.html`** — remove APK-only home elements: `#netStatus`, `#advToggle`, `#advPanel` (`#lanPeers`, `#inpManualServer`, `#lanSelf`).

**`server/server.js`** — remove the `/host-info` endpoint (lines ~32, only existed for phone discovery); clean the "host phone" comment near `MAX_ROOMS`.

**`public/sw.js`** — drop the `/status` + `/peer/` network-only exceptions; bump `SW_VER`.

**Docs:** `README.md` (remove Android section), `AGENTS.md` (remove the mobile section + sync instructions). `play.bat`, `render.yaml`, `manifest.webmanifest` untouched (PWA stays — it's web).

**Verification:** `node --check` on edited files; `npm test`; boot server + `npm run e2e 3100`; manual browser check that home loads with no console errors.

---

## Part B — 3D graphics upgrade (`board3d.js`, `home3d.js`, `tiles.js`, new `quality.js`)

### B1. Vendor post-processing addons (offline rule preserved)
Fetch from the three.js **0.160.0** release (same pinned version) and vendor under `public/vendor/three/160.0/examples/jsm/`:
- `postprocessing/`: `EffectComposer.js`, `Pass.js`, `RenderPass.js`, `ShaderPass.js`, `MaskPass.js`, `UnrealBloomPass.js`, `OutputPass.js`
- `shaders/`: `CopyShader.js`, `LuminosityHighPassShader.js`, `OutputShader.js`
- `environments/RoomEnvironment.js` (for PMREM env-map reflections)

All load through the existing `three/addons/` importmap prefix — no runtime CDN.

### B2. New module `public/js/quality.js`
- Detects a tier: `high` / `low` (heuristic: `devicePixelRatio`, `hardwareConcurrency`, `deviceMemory`, touch, plus a ~2s live frame-time probe that can auto-downgrade).
- Manual override persisted in `localStorage('domino_quality')`: `auto` / `high` / `low`.
- Exposes `getQuality()`, `setQuality(mode)`, `onQualityChange(cb)`.

### B3. `board3d.js` upgrades
- **Tone mapping:** `ACESFilmicToneMapping` + `outputColorSpace = SRGBColorSpace` (free, big realism gain).
- **Environment:** one-time `PMREMGenerator` + `RoomEnvironment` → `scene.environment`; tiles/table get subtle realistic reflections via `envMapIntensity` (pooled materials stay pooled — intensity set at creation).
- **Lighting:** retune key/fill/rim (warmer key, cooler fill, softer shadow radius); shadow map size 2048 on high / 1024 on low; shadows disabled entirely on low if the probe keeps failing.
- **Post (high tier only):** `EffectComposer` with `RenderPass` → subtle `UnrealBloomPass` (low strength, high threshold so only markers/glows bloom) → `OutputPass`. Composer render replaces direct render in `_loop`; `resize()` resizes composer too. Low tier keeps the plain renderer path.
- **Vignette:** pure-CSS radial overlay div on the game screen — zero GPU cost, works on both tiers.
- **Materials/textures:** bump felt contrast + add a fine woven pattern in `tiles.js` `feltCanvas()`; table rim gets clearcoat-style look via higher metalness + envmap; tile faces get `roughness` tuned per theme.
- **Animations:** drop-in gets a small 2-stage settle (overshoot → rest) + slight squash feel via scale pulse; camera fit easing gets critically-damped smoothing instead of fixed 0.04 lerp; last-move glow pad gets a gentle breathing pulse. All still gated by `prefers-reduced-motion`.
- **Perf overlay:** add quality tier + composer on/off to `stats()`.

### B4. `home3d.js` upgrades
- Same tone mapping + `RoomEnvironment` env-map on tiles; retuned fog/lights to match the new palette; high tier adds the same subtle bloom composer; low tier unchanged path.

### B5. `domboard.js` (2D fallback)
- No API changes; restyle via CSS only (Part C) so it matches the new UI.

**Verification:** `node --check`; `npm test`; visual check in browser at both tiers (force via localStorage) — tiles legible, markers clickable, draw animation works; perf overlay shows stable `geos`/`texs` over a simulated game (no pool leaks); e2e still green.

---

## Part C — Full UI/CSS overhaul (`style.css`, minor `index.html` touches)

Complete rewrite of `public/css/style.css` (~1700 lines) around a refined design system — same DOM structure and same Arabic strings, so `app.js` logic is untouched:

- **Tokens:** richer dark-casino palette (deep indigo + gold + mint accents kept as brand), elevation/shadow scale, glass panels (`backdrop-filter` with solid fallback via `@supports`), consistent spacing/radius/typography scale, focus-visible rings.
- **Home screen:** redesigned glass hero card — bigger logo treatment, polished input with icon, grouped chip rows (difficulty / personality / theme / **new quality chip row**: تلقائي · عالي · منخفض) with animated selection, gradient primary CTA with glow, refined join row; the twilight sky/moon/stars layers kept but re-tuned to the new palette.
- **Lobby:** two-zone card — invite block (code with copy/QR buttons, styled QR popover) + players list with avatar dots, host crown, ready states, bot badges; host config as a clean grid of labelled selects; sticky action bar (ready/start/leave).
- **Game HUD:** slimmer top bar with pill-style turn banner + ends pill + connection dot; circular turn-timer with conic-gradient progress ring; restyled opponents bar (seat cards with name, tile count, turn highlight); redesigned scoreboard card with animated roll-ups; action bar buttons as floating pills; hand tray with glass dock, hover lift, selected-tile raise, playable-tile glow (all transform/opacity only).
- **Chat drawer / toasts / modals:** matching glass style, smooth slide-in, redesigned quick-emoji row and emoji popover, message bubbles with player-color accents; modals get backdrop blur + scale-in animation; confetti canvas untouched.
- **2D fallback table:** `.board2d` styles rewritten to match the new felt/theme palette.
- **Accessibility/perf:** `prefers-reduced-motion` collapses all decorative animation; `prefers-contrast` bump; no layout-shifting webfont flashes; animations strictly transform/opacity; `backdrop-filter` gated behind `@supports` with opaque fallback for weak devices.
- **index.html:** only additive class hooks where needed (e.g. vignette div, quality chip row); all existing IDs stay so `app.js` and e2e selectors are unaffected.

**Verification:** visual pass on home/lobby/game at desktop + narrow viewport; RTL intact; reduced-motion check; `npm test` + e2e green.

---

## Part D — Cache-busting, SW, and rollout

- Bump every edited module's `?v=N` in `index.html` and in importers (`app.js`, `board3d.js`, `home3d.js`, `tiles.js`, `style.css`); bump `SW_VER`.
- Commit per verified unit (imperative one-liners): e.g. `mobile: remove android app and apk glue`, `board3d: tone mapping, env map and adaptive quality`, `css: full UI redesign`, `home: quality chip row`.

---

## Traceability (step → targets → verification)

| Step | Targets | Verification |
|---|---|---|
| A. Remove Android | `mobile/`, `app.js`, `index.html`, `server.js`, `sw.js`, docs | `node --check`, server boots, e2e green, home loads clean |
| B1. Vendor addons | `public/vendor/three/.../postprocessing`, `shaders`, `environments` | Importmap resolves, no console 404 |
| B2. Quality module | `public/js/quality.js` | Tier switches via localStorage, auto-downgrade probe works |
| B3. Board3D graphics | `board3d.js`, `tiles.js` | Visual check both tiers; pools stable in perf overlay; e2e green |
| B4. Home3D graphics | `home3d.js` | Backdrop renders both tiers, no console errors |
| C. CSS overhaul | `style.css`, `index.html` | Visual pass all screens, RTL, reduced-motion, 2D fallback |
| D. Version bumps + commits | `index.html`, importers, `sw.js` | Fresh load uses new assets; `npm test` + e2e green |

## Explicitly out of scope
- Engine / server game logic, socket protocol, bot behavior (e2e contract untouched).
- New features beyond the quality selector (no new screens, no accounts).
- Build tooling, linters, npm client deps.
