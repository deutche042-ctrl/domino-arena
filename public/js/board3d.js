// js/board3d.js — Three.js 3D domino table: tiles, snake layout, ghost markers
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { tileFaceCanvas, tileBackCanvas, feltCanvas, setTheme as setTileTheme, getTheme, THEME_NAMES } from './tiles.js?v=15';
import { getQuality, onQualityChange, startProbe, feedFrame } from './quality.js?v=2';

const TILE_W = 1, TILE_L = 2, TILE_H = 0.42, GAP = 0.07;
const MAX_X = 9.5;              // table boundary along X before turning
const MAX_Z = 6.0;              // table boundary along Z before turning
const adv = isDbl => (isDbl ? TILE_W : TILE_L) + GAP;
// B3: face gloss per theme — glossy piano/neon, matte wood
const FACE_ROUGHNESS = { classic: 0.3, neon: 0.22, wood: 0.45, piano: 0.18 };

// Bounded pools. The table can only ever show four open ends (L/R/U/D), so the
// marker pool is fixed; the contact-shadow instance buffer covers a full deck
// (28 chain tiles + 28 boneyard tiles) with headroom. Everything here is
// allocated once and only released in dispose().
const MAX_MARKERS = 4;
const CONTACT_SHADOW_MAX = 64;
// The felt cylinder is centred at -0.3 - TILE_H/2 with height 0.6, so its top
// surface — where a tile actually rests — is at -TILE_H/2.
const TABLE_TOP_Y = -TILE_H / 2;
const SHADOW_Y = TABLE_TOP_Y + 0.012;
// Low tier paints half-resolution faces (128×256) — a quarter of the pixels.
const FACE_PX_HIGH = 256, FACE_PX_LOW = 128;

// Theme-tinted table/side/bloom look. Kept small and explicit so every value the
// material swap touches lives in one place.
const THEME_LOOK = {
  classic: { side: 0xefe8d4, sideRough: 0.35, rim: 0x4a2f1d, rimMetal: 0.45, rimRough: 0.32, exposure: 1.05, bloom: 0.32, bloomRadius: 0.40, bloomThreshold: 0.82, env: 0.35 },
  neon:    { side: 0x16202e, sideRough: 0.28, rim: 0x102a38, rimMetal: 0.60, rimRough: 0.22, exposure: 1.10, bloom: 0.48, bloomRadius: 0.52, bloomThreshold: 0.68, env: 0.50 },
  wood:    { side: 0xc98a4b, sideRough: 0.50, rim: 0x3a2410, rimMetal: 0.25, rimRough: 0.55, exposure: 1.02, bloom: 0.22, bloomRadius: 0.35, bloomThreshold: 0.90, env: 0.25 },
  piano:   { side: 0x14161c, sideRough: 0.14, rim: 0x0b0c10, rimMetal: 0.70, rimRough: 0.18, exposure: 1.08, bloom: 0.36, bloomRadius: 0.45, bloomThreshold: 0.78, env: 0.60 },
};
const themeLook = name => THEME_LOOK[name] || THEME_LOOK.classic;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Truncate a display name without slicing a grapheme (or an emoji) in half. */
function truncateName(name, max = 14) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let out = '', n = 0;
      for (const { segment } of seg.segment(s)) {
        if (n >= max) return out + '…';
        out += segment; n++;
      }
      return out;
    }
  } catch { /* fall through to the codepoint cut */ }
  return [...s].slice(0, max).join('') + '…';
}

export class Board3D {
  constructor(canvas, { onMarkerClick, onBoardMiss, onBoneyardClick } = {}) {
    this.onMarkerClick = onMarkerClick;
    this.onBoardMiss = onBoardMiss;
    this.onBoneyardClick = onBoneyardClick;
    this.canDraw = false;

    this._disposed = false;
    // The board renders only while it is the on-screen table. `_active` is the
    // public screen flag (setActive), `_visible` is the canvas intersection
    // state (display:none when the game screen is left), and document.hidden
    // covers the tab. All three feed the single rAF starter below.
    this._active = true;
    this._visible = true;
    this._listeners = [];
    this._theme = getTheme();
    this._quality = getQuality();
    this._texPx = this._quality.tier === 'high' ? FACE_PX_HIGH : FACE_PX_LOW;
    this._shadowDirty = true;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadows only need a new pass when geometry moved — not on every frame and
    // not when only the camera orbited. _step() raises needsUpdate on changes.
    this.renderer.shadowMap.autoUpdate = false;
    // stats() must see the whole frame (scene + every composer pass), so the
    // reset happens once at the top of _step instead of inside render().
    this.renderer.info.autoReset = false;
    // B3: filmic output — ACES tone mapping over the new env-lit scene
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this._maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a14);

    // B3: one-time PMREM room environment — subtle realistic reflections on the
    // tiles/felt/rim (pooled materials tune their own envMapIntensity).
    // The render target is kept so dispose() can release the environment map;
    // the source RoomEnvironment scene is released right after generation.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this._envRT = pmrem.fromScene(room, 0.04);
    this.scene.environment = this._envRT.texture;
    room.dispose?.();
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 20, 13);
    this._camVel = { x: 0, y: 0, z: 0 };   // B3: critically-damped fit velocity
    this._camUntil = 0;                    // spring active until (ms); user drag cancels
    this._camStartAt = 0;
    this._camGoal = null;
    this._camTargetGoal = null;
    this._camTargetVec = new THREE.Vector3();
    this._lastFitSpots = [];
    // Once the player orbits by hand, auto-fit stops moving the camera until the
    // next hand / reconnect (invalidate) — otherwise every move fights the drag.
    this._userOrbited = false;
    this._orbiting = false;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 46;
    this.controls.maxPolarAngle = Math.PI * 0.42;
    this.controls.minPolarAngle = Math.PI * 0.18;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    // one finger rotate / pinch zoom on touch
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    // lights — B3: warmer key, cooler fill (env map adds the ambient bounce)
    this.scene.add(new THREE.AmbientLight(0x9fb8ff, 0.5));
    const key = new THREE.DirectionalLight(0xffe8cf, 1.8);
    key.position.set(6, 18, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    // Tight frustum around the playable table (radius 17) — a wider box only
    // spends shadow texels on the void. Bounds are applied before the first
    // render; any later change must call updateProjectionMatrix().
    key.shadow.camera.left = -15; key.shadow.camera.right = 15;
    key.shadow.camera.top = 15; key.shadow.camera.bottom = -15;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.03;
    this.scene.add(key);
    this._key = key;
    const rim = new THREE.PointLight(0x4d7dff, 10, 40);
    rim.position.set(-8, 6, -6);
    this.scene.add(rim);

    // Warm invite spotlight on boneyard when drawing is possible
    this.boneLight = new THREE.PointLight(0xf4c055, 0, 14);
    this.boneLight.position.set(9.5, 4.0, 9.8);
    this.boneLight.visible = false;
    this.scene.add(this.boneLight);

    // F4.4: respect the OS reduced-motion preference — flattens the arc/drop
    // flourishes to instant placement (accessibility, and kinder on weak GPUs).
    this._reducedMotion = typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    this._myTurn = false;

    this._buildTable();

    // K3.C1: player-name label parked above the most recently placed tile.
    this._lastLabel = null;

    // groups
    this.chainGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.boneGroup = new THREE.Group();
    this.scene.add(this.chainGroup, this.markerGroup, this.boneGroup);

    this._texCache = new Map();
    this._matCache = new Map();    // F3.1: pooled face materials, keyed `f:a-b`
    this._scoreMats = new Map();   // "+N" All-Fives preview badge sprites
    this._labelMats = new Map();   // K3.C1: last-move "who played" label sprites
    // SHARED geometry for every tile mesh in the scene. NEVER dispose it
    // per-mesh — disposing it once would blank out every tile that uses it.
    // If the renderer is ever torn down, dispose this exactly once there.
    this._geo = new RoundedBoxGeometry(TILE_W, TILE_H, TILE_L, 4, 0.09);
    // F3.1 (extended): hit-area geometry + material. Boneyard/marker hit boxes used
    // to allocate a fresh BoxGeometry AND a fresh transparent MeshBasicMaterial on
    // every sync (markers re-render each turn), which churned hundreds of GL objects
    // per game. All hit boxes are unit-ish and only ever scaled via `.scale`, and the
    // transparent material is identical for all of them — so both are shared, exactly
    // like _geo. They are allocated with the marker pool (4 slots) and the boneyard.
    this._hitBoxGeo = null;        // shared BoxGeometry(TILE_W*3.6, 3, TILE_L*3.2) — scaled per use
    this._hitMatC = null;          // shared transparent MeshBasicMaterial for every hit box
    this._anims = [];
    this._movesRendered = 0;
    // Append-only rendering state: the layout fold cursor, the meshes currently
    // in chainGroup (parallel to _layoutState.spots), the last move list we
    // rendered (for prefix checks), and its variant.
    this._layoutState = null;
    this._layoutIsAllFives = false;
    this._chainViews = [];
    this._lastMoves = null;
    this._downX = 0;
    this._downY = 0;
    this._downTime = 0;
    this._pointer = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();

    this._buildMarkerPool();
    this._buildContactShadows();

    // ── canvas + window listeners (stored so dispose() can remove them) ──
    const onDown = (e) => {
      this._downX = e.clientX;
      this._downY = e.clientY;
      this._downTime = performance.now();
      this._camUntil = 0;   // user takes the camera — stop the auto-fit spring
      this._camStartAt = Infinity;
    };
    const onUp = (e) => {
      const dist = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
      const dur = performance.now() - this._downTime;
      const maxDist = e.pointerType === 'touch' ? 32 : 10;
      if (dist < maxDist && dur < 700) {
        this._pick(e);
      }
    };
    const onMove = (e) => {
      if (!this.canDraw || !this.boneGroup || this.boneGroup.children.length === 0) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      this._pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this._raycaster.setFromCamera(this._pointer, this.camera);
      const boneTargets = this.boneGroup.children.filter(o => o.userData && o.userData.isBoneyard);
      const hits = this._raycaster.intersectObjects(boneTargets, false);
      if (hits.length > 0) {
        this.renderer.domElement.style.cursor = 'pointer';
      } else if (this.renderer.domElement.style.cursor === 'pointer') {
        this.renderer.domElement.style.cursor = 'default';
      }
    };
    const onVisibility = () => this._updateLoop();
    const onResize = () => this.resize();
    // OrbitControls owns pointer/wheel handlers of its own — its 'start' event is
    // the reliable signal that the player took the camera (wheel/touch included).
    // It also fires for a plain tap, so `_userOrbited` is only latched when the
    // camera actually moved by the time 'end' fires.
    const onOrbitStart = () => {
      this._orbiting = true;
      this._orbitFrom = this.camera.position.clone();
      this._orbitTargetFrom = this.controls.target.clone();
      this._camUntil = 0;
      this._camStartAt = Infinity;
    };
    const onOrbitEnd = () => {
      this._orbiting = false;
      this._camVel.x = this._camVel.y = this._camVel.z = 0;
      const moved = this._orbitFrom ? this._orbitFrom.distanceToSquared(this.camera.position) > 1e-4 : false;
      const targetMoved = this._orbitTargetFrom
        ? this._orbitTargetFrom.distanceToSquared(this.controls.target) > 1e-4 : false;
      if (moved || targetMoved) this._userOrbited = true;
    };

    this._addListener(canvas, 'pointerdown', onDown);
    this._addListener(canvas, 'pointerup', onUp);
    this._addListener(canvas, 'pointermove', onMove);
    this._addListener(window, 'resize', onResize);
    this._addListener(document, 'visibilitychange', onVisibility);
    this._addListener(this.controls, 'start', onOrbitStart);
    this._addListener(this.controls, 'end', onOrbitEnd);
    // The game screen is a display:none `.screen` when inactive; IntersectionObserver
    // turns that into a pause even before the UI phase wires setActive().
    if (typeof IntersectionObserver === 'function') {
      this._io = new IntersectionObserver((entries) => {
        const lastEntry = entries[entries.length - 1];
        const vis = !!lastEntry?.isIntersecting;
        if (vis === this._visible) return;
        this._visible = vis;
        if (vis) this.resize();
        this._updateLoop();
      });
      this._io.observe(canvas);
    }

    // B2/B3: adaptive quality — resolve the tier, then wire composer/shadows/pixel
    // ratio to it. The live frame-time probe (quality.js) may downgrade later.
    this._unsubQuality = onQualityChange(q => this._applyQuality(q));
    startProbe('board');
    this.resize();
    this._applyQuality(this._quality);
    this._updateLoop();
  }

  /** Store a listener pair so dispose() can remove every one of them. */
  _addListener(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  // ── B3: adaptive quality wiring ──
  _applyQuality(q = getQuality()) {
    if (this._disposed) return;
    const prevTier = this._quality?.tier;
    this._quality = q;
    const high = q.tier === 'high';
    const downgraded = prevTier === 'high' && !high;
    const dpr = Math.min(devicePixelRatio || 1, high ? 2 : 1.5);
    this.renderer.setPixelRatio(dpr);
    // A composer that survives the resize must adopt the new pixel ratio too.
    this._composer?.setPixelRatio(dpr);
    // shadow budget: 2048 high / 1024 low. A live probe downgrade kills shadows
    // entirely — the device already proved it can't hold the frame rate.
    if (this._key) {
      this._key.castShadow = !downgraded;
      const size = high ? 2048 : 1024;
      if (this._key.shadow.mapSize.x !== size) {
        this._key.shadow.mapSize.set(size, size);
        if (this._key.shadow.map) { this._key.shadow.map.dispose(); this._key.shadow.map = null; }
      }
      this._key.shadow.camera.updateProjectionMatrix();
    }
    this.renderer.shadowMap.needsUpdate = true;
    const px = high ? FACE_PX_HIGH : FACE_PX_LOW;
    if (px !== this._texPx) {
      this._texPx = px;
      this._reskin();          // rebuild face/back textures at the new budget
    }
    if (high) this._ensureComposer();
    else this._teardownComposer();
    this._applyThemeFx();
  }

  /** High tier only: RenderPass → subtle bloom → OutputPass, MSAA + HDR target. */
  _ensureComposer() {
    if (this._composer || this._disposed) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    const dpr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(size.x * dpr)), Math.max(1, Math.floor(size.y * dpr)),
      { samples: 4, type: THREE.HalfFloatType },
    );
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // low strength + high threshold: only the hottest highlights bloom
    // (marker pads, halo lights, boneyard glow)
    const bloom = new UnrealBloomPass(size.clone(), 0.32, 0.4, 0.82);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    this._composer = composer;
    this._bloom = bloom;
    this._applyThemeFx();
  }

  _teardownComposer() {
    const composer = this._composer;
    this._composer = null;
    this._bloom = null;
    if (!composer) return;
    // EffectComposer.dispose() only frees its two render targets and the copy
    // pass. UnrealBloomPass/OutputPass own render targets, materials and a
    // FullScreenQuad — without this every quality toggle leaked them.
    for (const pass of composer.passes || []) {
      try { pass.dispose?.(); } catch { /* a pass without disposal is harmless */ }
    }
    composer.dispose?.();
  }

  /** Theme/tier-aware grade: exposure + bloom stay inside sane, readable bounds. */
  _applyThemeFx() {
    if (this._disposed) return;
    const look = themeLook(this._theme);
    this.renderer.toneMappingExposure = clamp(look.exposure, 1.0, 1.15);
    if (this._bloom) {
      this._bloom.strength = clamp(look.bloom, 0.18, 0.5);
      this._bloom.radius = clamp(look.bloomRadius, 0.2, 0.6);
      this._bloom.threshold = clamp(look.bloomThreshold, 0.6, 0.95);
    }
  }

  // ── table ──
  _buildTable() {
    this._feltMat = new THREE.MeshStandardMaterial({ roughness: 0.95, envMapIntensity: 0.22 });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 0.6, 64), this._feltMat);
    top.position.y = -0.3 - TILE_H / 2;
    top.receiveShadow = true;
    this.scene.add(top);
    this._tableTop = top;
    this._rimMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1d, roughness: 0.32, metalness: 0.45, envMapIntensity: 0.9 });
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(18.4, 18.4, 0.7, 64), this._rimMat);
    rim.position.y = -0.42 - TILE_H / 2;
    this.scene.add(rim);
    this._tableRim = rim;
    this._floorMat = new THREE.MeshStandardMaterial({ color: 0x0a0e1c, roughness: 1 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 32), this._floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.2;
    this.scene.add(floor);
    this._tableFloor = floor;
    this._applyTableTheme();
  }

  _makeFeltTexture() {
    const felt = new THREE.CanvasTexture(feltCanvas(this._theme));
    // Canvas art is authored in sRGB; without this the ACES/output-sRGB pipeline
    // samples it as linear data and the felt/faces wash out.
    felt.colorSpace = THREE.SRGBColorSpace;
    felt.anisotropy = this._maxAniso || 8;
    return felt;
  }

  /** Repaint the felt + rim for the active theme (old felt texture owned by _reskin). */
  _applyTableTheme() {
    if (!this._feltMat) return;
    const look = themeLook(this._theme);
    const felt = this._makeFeltTexture();
    this._feltTex = felt;
    this._feltMat.map = felt;
    this._feltMat.needsUpdate = true;
    this._rimMat.color.setHex(look.rim);
    this._rimMat.metalness = look.rimMetal;
    this._rimMat.roughness = look.rimRough;
    this._rimMat.needsUpdate = true;
    this._shadowDirty = true;
  }

  // ── turn state ──
  setMyTurn(on) {
    this._myTurn = !!on;
  }

  // ── tile textures + materials ──
  // F4.3: the texture cache is keyed by the ACTIVE theme, so switching themes
  // simply repaints into fresh keys. The tier is baked into the key as well, so
  // a low-tier board never picks up a full-size canvas.
  _faceTex(a, b) {
    const k = `${this._theme}:${this._texPx}:${a}-${b}`;
    if (!this._texCache.has(k)) {
      const t = new THREE.CanvasTexture(tileFaceCanvas(a, b, this._texPx));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this._maxAniso || 8;
      this._texCache.set(k, t);
    }
    return this._texCache.get(k);
  }

  _backTex() {
    const k = `${this._theme}:${this._texPx}:back`;
    if (!this._texCache.has(k)) {
      const t = new THREE.CanvasTexture(tileBackCanvas(this._texPx));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this._maxAniso || 8;
      this._texCache.set(k, t);
    }
    return this._texCache.get(k);
  }

  /**
   * Repaint every tile in a new theme.
   *
   * The old implementation called setTileTheme() and returned false whenever the
   * shared registry reported "unchanged" — but app.js has already switched the
   * registry by the time it calls us, so a real switch never rebuilt anything.
   * We now validate the name ourselves and gate only on our own active skin.
   *
   * Live meshes are re-pointed at the new pooled materials (never left holding
   * disposed ones), and the previous generation is released only after that.
   */
  setTheme(name) {
    if (this._disposed) return false;
    if (typeof name !== 'string' || !THEME_NAMES.includes(name)) return false;
    if (name === this._theme) return false;
    // Idempotent: app.js calls this first; calling it again is a no-op there but
    // keeps the board correct when used standalone.
    setTileTheme(name);
    this._theme = name;
    this._reskin();
    this._applyThemeFx();
    return true;
  }

  /** Swap every theme/tier-bound resource while live meshes keep rendering. */
  _reskin() {
    const old = {
      tex: this._texCache, mats: this._matCache,
      back: this._backMatC, side: this._sideMatC,
      felt: this._feltTex,
    };
    this._texCache = new Map();
    this._matCache = new Map();
    this._backMatC = null;
    this._sideMatC = null;
    this._applyTableTheme();   // installs a new felt texture, returns the old via `old.felt`
    this._repaintTiles();      // every live mesh now points at the new materials
    // Nothing references the previous generation any more — safe to release.
    for (const mat of old.mats.values()) mat.dispose?.();
    for (const tex of old.tex.values()) tex.dispose?.();
    old.back?.dispose?.();
    old.side?.dispose?.();
    old.felt?.dispose?.();
    this._shadowDirty = true;
  }

  /** Re-bind every live tile mesh (chain, boneyard, in-flight draw) to current caches. */
  _repaintTiles() {
    this.scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.isTile) return;
      const { a, b, faceUp } = o.userData;
      o.material = this._tileMats(a ?? 0, b ?? 0, faceUp !== false);
    });
  }

  _sideMat() {
    if (!this._sideMatC) {
      const look = themeLook(this._theme);
      const base = { color: look.side, roughness: look.sideRough, envMapIntensity: look.env };
      // Clearcoat is a heavier shader — reserve it for the glossy piano skin on
      // the high tier, where the extra cost buys a visible lacquer highlight.
      if (this._theme === 'piano' && this._quality?.tier === 'high') {
        this._sideMatC = new THREE.MeshPhysicalMaterial({
          ...base, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08,
        });
      } else {
        this._sideMatC = new THREE.MeshStandardMaterial({ ...base, metalness: 0.05 });
      }
    }
    return this._sideMatC;
  }

  // ── F3.1 material pool ──
  // Every tile used to allocate 2 fresh MeshStandardMaterials (face + back), so a
  // long game churned through hundreds of them and forced a WebGL program/texture
  // rebind per mesh. Materials are immutable per (face, back) pair, so we cache
  // them for the lifetime of the board exactly like _texCache does for textures.
  // A 28-tile deck can only ever produce 28 faces + 1 back → a hard upper bound.
  _faceMat(a, b) {
    const k = `f:${this._theme}:${this._texPx}:${a}-${b}`;
    if (!this._matCache.has(k)) {
      const tex = this._faceTex(a, b);
      const look = themeLook(this._theme);
      const opts = {
        map: tex,
        roughness: FACE_ROUGHNESS[this._theme] ?? 0.3,
        envMapIntensity: look.env,
      };
      // Neon pips glow: the face map doubles as an emissive map. White emissive
      // keeps each pip's own cyan/magenta hue; the near-black face contributes
      // almost nothing, so the emission stays on the pips.
      if (this._theme === 'neon') {
        opts.emissive = new THREE.Color(0xffffff);
        opts.emissiveMap = tex;
        opts.emissiveIntensity = 0.45;
      }
      this._matCache.set(k, new THREE.MeshStandardMaterial(opts));
    }
    return this._matCache.get(k);
  }

  _backMat() {
    if (!this._backMatC) {
      this._backMatC = new THREE.MeshStandardMaterial({
        map: this._backTex(), roughness: 0.5, envMapIntensity: 0.3,
      });
    }
    return this._backMatC;
  }

  /** Face/back/side material array for one tile (order = RoundedBox groups). */
  _tileMats(a, b, faceUp = true) {
    const face = this._faceMat(a, b);
    const back = this._backMat();
    const side = this._sideMat();
    return [side, side, faceUp ? face : back, faceUp ? back : face, side, side];
  }

  _tileMesh(a, b, faceUp = true) {
    // Pooled: never disposed per-mesh (see _disposeTileMesh) — disposing a shared
    // material would blank out every tile using it, exactly like _geo.
    const m = new THREE.Mesh(this._geo, this._tileMats(a, b, faceUp));
    // Skin identity travels with the mesh so a theme switch can repaint it in
    // place (chain, boneyard and in-flight draw meshes all carry this).
    m.userData = { isTile: true, a, b, faceUp };
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // ── F3.1 (extended): pooled hit areas ──
  // A shared, invisible click target: one unit-ish BoxGeometry scaled per use, one
  // shared fully-transparent material. Only ever add()ed to a group and cleared via
  // _disposeTileMesh, which leaves both shared resources alone.
  _hitGeometry() {
    if (!this._hitBoxGeo) {
      this._hitBoxGeo = new THREE.BoxGeometry(TILE_W * 3.6, 3.0, TILE_L * 3.2);
    }
    return this._hitBoxGeo;
  }

  _hitMaterial() {
    if (!this._hitMatC) {
      this._hitMatC = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    }
    return this._hitMatC;
  }

  /** A pooled hit-area mesh. `sx/sy/sz` scale the shared geometry (default = full). */
  _hitMesh(sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Mesh(this._hitGeometry(), this._hitMaterial());
    if (sx !== 1 || sy !== 1 || sz !== 1) m.scale.set(sx, sy, sz);
    // Raycasting ignores `visible`, so a hit box can be hidden and still clickable.
    m.visible = false;
    m.userData = { isHitArea: true, active: false };
    return m;
  }

  // Release the resources owned by a single mesh (tile, marker, hit area).
  // IMPORTANT: everything shared must be left alone —
  //   • the tile geometry (_geo),
  //   • the shared hit-area geometry/material (_hitBoxGeo / _hitMatC),
  //   • the side material (_sideMatC),
  //   • the pooled face/back materials (_matCache / _backMatC),
  //   • the cached textures (_texCache).
  // Disposing any of them would break every OTHER tile in the scene, which is
  // exactly the F0.2 bug this helper was written to fix. Only per-mesh geometry
  // that is NOT one of the shared resources is genuinely ours to release.
  _disposeTileMesh(mesh) {
    if (!mesh) return;
    const geo = mesh.geometry;
    if (geo && geo !== this._geo && geo !== this._hitBoxGeo) geo.dispose?.();
    mesh.material = null;
    mesh.geometry = null;
  }

  // ── layout: moves → positions ──
  _calcNextSpot(cur, dbl, isAllFives = false) {
    const advLen = (dbl ? TILE_W : TILE_L) + GAP;
    const nextX = cur.pos.x + cur.dir.dx * advLen;
    const nextZ = cur.pos.z + cur.dir.dz * advLen;

    let mustBend = false;
    let newDir = null;

    if (cur.dir.dx !== 0) {
      if (Math.abs(nextX) > MAX_X) {
        mustBend = true;
        const bendZ = (cur.pos.z >= MAX_Z) ? -1 : (cur.pos.z <= -MAX_Z) ? 1 : (cur.side === 'R' ? 1 : -1);
        newDir = { dx: 0, dz: bendZ };
      } else if (isAllFives && cur.bendCount > 0) {
        if ((cur.dir.dx < 0 && nextX < 2.2) || (cur.dir.dx > 0 && nextX > -2.2)) {
          mustBend = true;
          const bendZ = (cur.pos.z >= MAX_Z) ? -1 : (cur.pos.z <= -MAX_Z) ? 1 : (cur.side === 'R' ? 1 : -1);
          newDir = { dx: 0, dz: bendZ };
        }
      }
    } else if (cur.dir.dz !== 0) {
      if (!cur.isArm) {
        // If the corner was a double, let 1 tile advance in the column before bending into return row
        if (!cur.lastDbl) {
          mustBend = true;
          newDir = { dx: -(cur.prevDx || (cur.side === 'R' ? 1 : -1)), dz: 0 };
        }
      } else {
        if (Math.abs(nextZ) > MAX_Z) {
          mustBend = true;
          newDir = { dx: cur.side === 'U' ? 1 : -1, dz: 0 };
        }
      }
    }

    if (mustBend) {
      const oldDir = cur.dir;
      let center, rotY, nextPos;

      if (cur.lastDbl && cur.lastCenter) {
        // Double preceding the turn: its long axis is already aligned with newDir!
        // The chain extends straight out of the double's short end facing newDir:
        center = {
          x: cur.lastCenter.x + newDir.dx * (TILE_L / 2 + GAP + (dbl ? TILE_W / 2 : TILE_L / 2)),
          z: cur.lastCenter.z + newDir.dz * (TILE_L / 2 + GAP + (dbl ? TILE_W / 2 : TILE_L / 2)),
        };
        rotY = dbl
          ? (newDir.dx !== 0 ? 0 : Math.PI / 2)
          : Math.atan2(newDir.dx, newDir.dz);
        nextPos = {
          x: center.x + newDir.dx * (dbl ? TILE_W / 2 : TILE_L / 2),
          z: center.z + newDir.dz * (dbl ? TILE_W / 2 : TILE_L / 2),
        };
      } else if (!dbl) {
        // Normal elbow corner between two non-doubles
        center = {
          x: cur.pos.x + oldDir.dx * (GAP + TILE_W / 2) + newDir.dx * (TILE_W / 2),
          z: cur.pos.z + oldDir.dz * (GAP + TILE_W / 2) + newDir.dz * (TILE_W / 2),
        };
        rotY = Math.atan2(newDir.dx, newDir.dz);
        nextPos = {
          x: center.x + newDir.dx * (TILE_L / 2),
          z: center.z + newDir.dz * (TILE_L / 2),
        };
      } else {
        // Double placed AT the corner:
        // Crosswise to oldDir so its short end points in newDir
        center = {
          x: cur.pos.x + oldDir.dx * (GAP + TILE_W / 2),
          z: cur.pos.z + oldDir.dz * (GAP + TILE_W / 2),
        };
        rotY = oldDir.dx !== 0 ? 0 : Math.PI / 2;
        nextPos = {
          x: center.x + newDir.dx * (TILE_L / 2),
          z: center.z + newDir.dz * (TILE_L / 2),
        };
      }

      const nextCur = {
        pos: nextPos,
        dir: newDir,
        prevDx: cur.dir.dx !== 0 ? cur.dir.dx : cur.prevDx,
        bendCount: (cur.bendCount || 0) + 1,
        isArm: false,
        side: cur.side,
        lastCenter: center,
        lastDbl: dbl,
      };

      return { spot: { x: center.x, z: center.z, rotY, dbl }, nextCur };
    }

    // Normal straight placement
    let center, rotY;
    if (cur.lastDbl && cur.lastCenter && cur.dir.dz !== 0) {
      // Continuing straight in a column off the end of a double
      center = {
        x: cur.lastCenter.x + cur.dir.dx * (TILE_L / 2 + GAP + (dbl ? TILE_W / 2 : TILE_L / 2)),
        z: cur.lastCenter.z + cur.dir.dz * (TILE_L / 2 + GAP + (dbl ? TILE_W / 2 : TILE_L / 2)),
      };
      rotY = dbl
        ? (cur.dir.dx !== 0 ? 0 : Math.PI / 2)
        : Math.atan2(cur.dir.dx, cur.dir.dz);
      const nextPos = {
        x: center.x + cur.dir.dx * (dbl ? TILE_W / 2 : TILE_L / 2),
        z: center.z + cur.dir.dz * (dbl ? TILE_W / 2 : TILE_L / 2),
      };
      return {
        spot: { x: center.x, z: center.z, rotY, dbl },
        nextCur: { ...cur, pos: nextPos, lastCenter: center, lastDbl: dbl },
      };
    }

    if (dbl) {
      // Crosswise: perpendicular to line of travel
      rotY = cur.dir.dx !== 0 ? 0 : Math.PI / 2;
      center = {
        x: cur.pos.x + cur.dir.dx * (GAP + TILE_W / 2),
        z: cur.pos.z + cur.dir.dz * (GAP + TILE_W / 2),
      };
      const nextPos = {
        x: center.x + cur.dir.dx * (TILE_W / 2),
        z: center.z + cur.dir.dz * (TILE_W / 2),
      };
      return {
        spot: { x: center.x, z: center.z, rotY, dbl },
        nextCur: { ...cur, pos: nextPos, lastCenter: center, lastDbl: true },
      };
    } else {
      // Long axis along travel direction
      rotY = Math.atan2(cur.dir.dx, cur.dir.dz);
      center = {
        x: cur.pos.x + cur.dir.dx * (GAP + TILE_L / 2),
        z: cur.pos.z + cur.dir.dz * (GAP + TILE_L / 2),
      };
      const nextPos = {
        x: center.x + cur.dir.dx * (TILE_L / 2),
        z: center.z + cur.dir.dz * (TILE_L / 2),
      };
      return {
        spot: { x: center.x, z: center.z, rotY, dbl },
        nextCur: { ...cur, pos: nextPos, lastCenter: center, lastDbl: false },
      };
    }
  }

  // Fresh fold cursor. _layout advances a cursor across moves, so resetting it
  // and replaying from move 0 must reproduce the exact same spots (prefix
  // stability), which is what lets sync() append tiles instead of rebuilding.
  _newLayoutState(isAllFives = false) {
    return { spots: [], curL: null, curR: null, curU: null, curD: null, spinner: null, isAllFives };
  }

  // Fold ONE move into the cursor and return its spot (or null if it can't attach).
  _layoutStep(st, mv) {
    const { isAllFives } = st;
    const dbl = mv.t.a === mv.t.b;
    if (mv.e === null) {
      let spot;
      if (dbl) {
        spot = { x: 0, z: 0, rotY: 0, dbl };
        st.curL = { pos: { x: -TILE_W / 2, z: 0 }, dir: { dx: -1, dz: 0 }, side: 'L', prevDx: -1, lastCenter: { x: 0, z: 0 }, lastDbl: true };
        st.curR = { pos: { x: TILE_W / 2, z: 0 }, dir: { dx: 1, dz: 0 }, side: 'R', prevDx: 1, lastCenter: { x: 0, z: 0 }, lastDbl: true };
        if (isAllFives) {
          st.spinner = { x: 0, z: 0, extZ: TILE_L / 2 };
          st.curU = { pos: { x: 0, z: -TILE_L / 2 }, dir: { dx: 0, dz: -1 }, side: 'U', isArm: true, prevDx: -1, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          st.curD = { pos: { x: 0, z: TILE_L / 2 }, dir: { dx: 0, dz: 1 }, side: 'D', isArm: true, prevDx: 1, lastCenter: { x: 0, z: 0 }, lastDbl: true };
        }
      } else {
        const rotY = Math.PI / 2 + (mv.f ? Math.PI : 0);
        spot = { x: 0, z: 0, rotY, dbl };
        st.curL = { pos: { x: -TILE_L / 2, z: 0 }, dir: { dx: -1, dz: 0 }, side: 'L', prevDx: -1, lastCenter: { x: 0, z: 0 }, lastDbl: false };
        st.curR = { pos: { x: TILE_L / 2, z: 0 }, dir: { dx: 1, dz: 0 }, side: 'R', prevDx: 1, lastCenter: { x: 0, z: 0 }, lastDbl: false };
      }
      return spot;
    }

    const cur = mv.e === 'L' ? st.curL : mv.e === 'R' ? st.curR : mv.e === 'U' ? st.curU : st.curD;
    if (!cur) return null;
    const { spot, nextCur } = this._calcNextSpot(cur, dbl, isAllFives);
    Object.assign(cur, nextCur);
    spot.rotY += mv.f ? Math.PI : 0;

    if (dbl && !st.spinner && isAllFives) {
      const extZ = Math.abs(Math.sin(spot.rotY)) > 0.5 ? TILE_W / 2 : TILE_L / 2;
      st.spinner = { x: spot.x, z: spot.z, extZ };
      st.curU = { pos: { x: spot.x, z: spot.z - extZ }, dir: { dx: 0, dz: -1 }, side: 'U', isArm: true, prevDx: -1, lastCenter: { x: spot.x, z: spot.z }, lastDbl: true };
      st.curD = { pos: { x: spot.x, z: spot.z + extZ }, dir: { dx: 0, dz: 1 }, side: 'D', isArm: true, prevDx: 1, lastCenter: { x: spot.x, z: spot.z }, lastDbl: true };
    }
    return spot;
  }

  _endSpotsFor(st) {
    const { movesLen, curL, curR, curU, curD, isAllFives } = st;
    const endSpots = {};
    if (!movesLen) {
      endSpots.C = { x: 0, z: 0, rotY: Math.PI / 2 };
      return endSpots;
    }
    if (curL) endSpots.L = this._peek(curL, isAllFives);
    if (curR) endSpots.R = this._peek(curR, isAllFives);
    if (isAllFives) {
      if (curU) endSpots.U = this._peek(curU, isAllFives);
      if (curD) endSpots.D = this._peek(curD, isAllFives);
    }
    return endSpots;
  }

  _layout(moves, isAllFives = false) {
    const st = this._newLayoutState(isAllFives);
    for (const mv of moves) {
      const spot = this._layoutStep(st, mv);
      // Skip-push semantics match the original loop exactly (a move that cannot
      // attach to any open end contributes no spot).
      if (spot) st.spots.push(spot);
    }
    st.movesLen = moves.length;
    return { spots: st.spots, endSpots: this._endSpotsFor(st) };
  }

  _peek(cur, isAllFives = false) {
    if (!cur) return null;
    const { spot } = this._calcNextSpot(cur, false, isAllFives);
    return spot;
  }

  /**
   * F3.3: live render statistics for the developer overlay (see the `P` key in
   * app.js). Everything here comes from three.js's own bookkeeping, so the numbers
   * are the real ones the GPU sees — not an estimate.
   *   calls/tris  — draw calls + triangles in the last frame (the two numbers that
   *                 actually predict frame time)
   *   geos/texs   — allocations that must NOT grow over a long game; a rising
   *                 geometries count is the classic leak signature
   *   chainMeshes — tiles currently on the table (our own count)
   *   matPool/texPool — size of the F3.1/F0.2 shared caches (bounded by design)
   */
  stats() {
    const info = this.renderer?.info;
    return {
      calls: info?.render.calls ?? 0,
      tris: info?.render.triangles ?? 0,
      geos: info?.memory.geometries ?? 0,
      texs: info?.memory.textures ?? 0,
      programs: info?.programs?.length ?? 0,
      chainMeshes: this.chainGroup?.children.length ?? 0,
      boneMeshes: this.boneGroup?.children.length ?? 0,
      matPool: this._matCache?.size ?? 0,
      texPool: this._texCache?.size ?? 0,
      anims: this._anims?.length ?? 0,
      myTurn: !!this._myTurn,
      reducedMotion: !!this._reducedMotion,
      quality: this._quality?.tier ?? null,
      composer: !!this._composer,
    };
  }

  // ── public sync ──
  /**
   * Reconcile the 3D chain with an engine view.
   *
   * Append-only fast path: the layout is a pure forward fold, so when the
   * incoming move list simply extends the one we already rendered, the existing
   * meshes keep their exact positions and we only build the new tiles. That
   * turns a per-move O(n) rebuild (O(n²) per game, with full texture/material
   * churn) into O(1) per move.
   *
   * The rebuild path remains for the rare cases where the list shrinks or
   * changes (new hand, reconnect, variant switch) — those still cost O(n).
   */
  sync(view) {
    const moves = view.moves || [];
    const isAllFives = view.variant === 'allfives';

    // Nothing changed: only the boneyard may have moved.
    if (moves.length === this._movesRendered) {
      this._syncBoneyard(view.boneyardCount);
      return;
    }

    // Can we append? Requires: same variant, same count as before, a live
    // layout cursor, and the prev moves still being a prefix of the new list.
    const sameVariant = isAllFives === this._layoutIsAllFives;
    const canAppend =
      this._movesRendered > 0 &&
      moves.length > this._movesRendered &&
      sameVariant &&
      !!this._layoutState &&
      this._prefixMatches(moves, this._movesRendered);

    this.clearMarkers();

    if (canAppend) {
      this._appendMoves(moves, isAllFives, view);
      return;
    }

    this._rebuildMoves(moves, isAllFives, view);
  }

  /**
   * Force a full rebuild on the next sync() — used after the tab was hidden /
   * the device slept, where we cannot trust the incremental cursor anymore
   * (requestAnimationFrame stalls, geometry may be stale in the GL context).
   * Cheap: the next sync() simply takes the O(n) rebuild path once.
   */
  invalidate() {
    this._movesRendered = -1;   // -1 (not 0) so a legitimately-empty table still rebuilds
    this._lastMoves = null;
    this._layoutState = null;
    // A new hand / reconnect is the one moment auto-fit may take the camera back
    // from a player who had orbited it.
    this._userOrbited = false;
  }

  /** True when the first `n` moves are identical to what we rendered last time. */
  _prefixMatches(moves, n) {
    const prev = this._lastMoves;
    if (!prev || prev.length < n) return false;
    for (let i = 0; i < n; i++) {
      const a = prev[i], b = moves[i];
      if (a.t.id !== b.t.id || a.e !== b.e || a.f !== b.f) return false;
    }
    return true;
  }

  /** Fold only the newly-added moves onto the existing cursor + chain. */
  _appendMoves(moves, isAllFives, view) {
    const st = this._layoutState;
    const startIdx = this._movesRendered;
    const addedSpots = [];

    for (let i = startIdx; i < moves.length; i++) {
      const mv = moves[i];
      const s = this._layoutStep(st, mv);
      if (!s) continue;
      addedSpots.push(s);
      st.spots.push(s);          // keep st.spots in step with the chain (see _rebuildMoves)
      const mesh = this._tileMesh(mv.t.a, mv.t.b);
      mesh.position.set(s.x, 0, s.z);
      mesh.rotation.y = s.rotY;
      this.chainGroup.add(mesh);
      this._chainViews.push(mesh);
      // Only the very last tile gets the drop-in flourish.
      if (i === moves.length - 1) {
        // F4.4: arc the tile in from above-and-behind rather than dropping it
        // straight down — a short parabola reads as "placed" instead of "fell".
        const arc = this._reducedMotion ? null : {
          fromX: s.x + (mv.end === 'R' ? 2.2 : -2.2),
          fromZ: s.z + 3.0,
        };
        mesh.position.y = this._reducedMotion ? 0 : 7;
        mesh.rotation.x = this._reducedMotion ? 0 : 0.6;
        if (arc) { mesh.position.x = arc.fromX; mesh.position.z = arc.fromZ; }
        this._anims.push({
          mesh, t: 0, dur: this._reducedMotion ? 0.01 : 0.5, kind: 'drop',
          baseRotY: s.rotY, toX: s.x, toZ: s.z, arc,
        });
      }
    }

    st.movesLen = moves.length;
    this._movesRendered = moves.length;
    this._lastMoves = moves;
    this._layoutIsAllFives = isAllFives;
    this._endSpots = this._endSpotsFor(st);

    this._shadowDirty = true;
    this._syncBoneyard(view.boneyardCount);
    const allSpots = st.spots;   // full spot list, prefix + appended
    this._syncContactShadows(allSpots);
    this._showLastMoveHint(moves, allSpots, view);
    this._fitCamera(allSpots.length ? allSpots : addedSpots);
  }

  /** K3.C1: park the name label on the most recently placed tile. */
  _showLastMoveHint(moves, spots, view) {
    const last = moves[moves.length - 1];
    const spot = spots[spots.length - 1];
    if (!last || !spot) {
      if (this._lastLabel) this._lastLabel.visible = false;
      return;
    }
    const name = view?.names?.[last.p];
    if (!name) {
      if (this._lastLabel) this._lastLabel.visible = false;
      return;
    }
    if (!this._lastLabel) {
      this._lastLabel = new THREE.Sprite(this._ghostSpriteMat);
      this._lastLabel.scale.set(2.6, 0.72, 1);
      this.scene.add(this._lastLabel);
    }
    this._lastLabel.material = this._nameLabelMat(name);
    this._lastLabel.position.set(spot.x, 1.55, spot.z);
    this._lastLabel.visible = true;
  }

  /** Cached canvas label sprite material per player name (bounded by table size). */
  _nameLabelMat(name) {
    if (this._labelMats.has(name)) return this._labelMats.get(name);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 72;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(8,12,24,0.88)';
    g.beginPath();
    if (g.roundRect) g.roundRect(6, 6, 244, 60, 20); else g.rect(6, 6, 244, 60);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(46,230,168,0.9)';
    g.stroke();
    g.fillStyle = '#e8fff5';
    // 2.7: the same name was set in two typefaces on one screen — the HUD uses
    // the brand face, the 3D label used system-ui. Match the HUD.
    g.font = '700 32px Arial, "Segoe UI", sans-serif';
    g.direction = 'rtl';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // 2.7: slice(0,14) chopped Arabic mid-character. Truncate on grapheme
    // boundaries via Intl.Segmenter when available, else fall back to a codepoint
    // cut (Array.from keeps surrogate pairs intact).
    g.fillText(truncateName(name), 128, 38);
    const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
    mat.map.colorSpace = THREE.SRGBColorSpace;
    this._labelMats.set(name, mat);
    return mat;
  }

  /** Full rebuild — used when the chain is not a pure extension of the last one. */
  _rebuildMoves(moves, isAllFives, view) {
    // Any in-flight 'drop' or 'settle' animation targets a chain mesh that is
    // about to be recycled; drop those anims first so the loop cannot write to a
    // detached, already-disposed mesh. 'draw' anims own their own scene meshes,
    // so they are left to finish normally.
    this._anims = this._anims.filter(a => a.kind !== 'drop' && a.kind !== 'settle');

    // Release each tile's own materials before dropping the meshes, otherwise
    // every rebuild leaks two MeshStandardMaterials. The shared geometry (_geo)
    // and cached textures are deliberately preserved by _disposeTileMesh.
    for (const child of this.chainGroup.children) this._disposeTileMesh(child);
    this.chainGroup.clear();
    this._chainViews = [];

    const st = this._newLayoutState(isAllFives);
    const dropLast = moves.length === this._movesRendered + 1 && this._movesRendered > 0;

    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const s = this._layoutStep(st, mv);
      if (!s) continue;
      st.spots.push(s);
      const mesh = this._tileMesh(mv.t.a, mv.t.b);
      mesh.position.set(s.x, 0, s.z);
      mesh.rotation.y = s.rotY;
      this.chainGroup.add(mesh);
      this._chainViews.push(mesh);
      if (dropLast && i === moves.length - 1) {
        mesh.position.y = 7;
        mesh.rotation.x = 0.6;
        this._anims.push({ mesh, t: 0, dur: this._reducedMotion ? 0.01 : 0.5, kind: 'drop', baseRotY: s.rotY });
      }
    }

    st.movesLen = moves.length;
    this._layoutState = st;
    this._movesRendered = moves.length;
    this._lastMoves = moves;
    this._layoutIsAllFives = isAllFives;
    this._endSpots = this._endSpotsFor(st);

    this._shadowDirty = true;
    this._syncBoneyard(view.boneyardCount);
    this._syncContactShadows(st.spots);
    this._showLastMoveHint(moves, st.spots, view);
    this._fitCamera(st.spots);
  }

  setCanDraw(canDraw) {
    const was = this.canDraw;
    this.canDraw = !!canDraw;
    if (this.boneLight) {
      this.boneLight.visible = this.canDraw;
      this.boneLight.intensity = this.canDraw ? (this._reducedMotion ? 4 : 3.5) : 0;
    }
    if (!this.canDraw && this.renderer?.domElement?.style?.cursor === 'pointer') {
      this.renderer.domElement.style.cursor = 'default';
    }
    // app.js calls sync() BEFORE setCanDraw(), so the fit for a drawing turn was
    // computed without the boneyard. Refit once when drawing becomes available so
    // the pile the player must tap is actually on screen.
    if (this.canDraw && !was && this._layoutState?.spots?.length) {
      this._fitCamera(this._layoutState.spots);
    }
  }

  _syncBoneyard(count = 0) {
    if (count === this._boneCount && this.boneGroup.children.length > 0) return;
    this._boneCount = count;
    // Boneyard tiles and their hit-area boxes each own materials (and the hit
    // boxes own a BoxGeometry), so release them before clearing the group.
    for (const child of this.boneGroup.children) this._disposeTileMesh(child);
    this.boneGroup.clear();
    const cols = 7;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = 6.6 + col * 0.98;
      const z = 9.0 + row * 2.15;
      const jitterRot = (Math.sin(i * 137.5) * 0.05);

      const m = this._tileMesh(0, 0, false);
      m.position.set(x, 0, z);
      m.rotation.y = jitterRot;
      // Keep the skin identity `_tileMesh` stored: the theme switch repaints via it.
      m.userData = { ...m.userData, isBoneyard: true, index: i };
      m.castShadow = true;
      m.receiveShadow = true;
      this.boneGroup.add(m);

      // Hit area mesh for forgiving touch/mouse clicks (pooled geo + material).
      // Tagged isHitArea so animateDraw() never mistakes a hit box for a bone.
      const hit = this._hitMesh(TILE_W * 1.3 / (TILE_W * 3.6), 1.8 / 3.0, TILE_L * 1.3 / (TILE_L * 3.2));
      hit.position.set(x, 0.6, z);
      hit.rotation.y = jitterRot;
      hit.userData = { isBoneyard: true, isHitArea: true, active: true, index: i, targetMesh: m };
      this.boneGroup.add(hit);
    }
    this._shadowDirty = true;
    this._syncContactShadows(this._layoutState?.spots || []);
  }

  animateDraw(drawnTile, isMe, sourceMesh = null) {
    // 1. Determine starting position from sourceMesh or the last visible boneyard tile
    let startPos = new THREE.Vector3(9.5, 0.21, 9.8);
    let startRotY = 0;
    if (sourceMesh && sourceMesh.isMesh) {
      startPos.copy(sourceMesh.position);
      startRotY = sourceMesh.rotation.y;
      this.boneGroup.remove(sourceMesh);
    } else {
      const visibleBones = this.boneGroup.children.filter(c => c.isMesh && !c.userData.isHitArea);
      if (visibleBones.length > 0) {
        const last = visibleBones[visibleBones.length - 1];
        startPos.copy(last.position);
        startRotY = last.rotation.y;
        this.boneGroup.remove(last);
      }
    }
    this._syncContactShadows(this._layoutState?.spots || []);
    this._shadowDirty = true;

    // F4.4: with reduced motion there is no flight — the tile is simply gone from
    // the boneyard and appears in the hand (renderHand already handles that).
    if (this._reducedMotion) return;

    // 2. Create the tile mesh:
    // When isMe: Bottom face (-Y) has tileFaceCanvas(a, b), top face (+Y) has tileBackCanvas().
    // Rotating 180° around Z flips the tile so the face with pips turns upward!
    const mesh = isMe && drawnTile
      ? this._tileMesh(drawnTile.a, drawnTile.b, false)
      : this._tileMesh(0, 0, false);

    mesh.position.copy(startPos);
    mesh.rotation.set(0, startRotY, 0);
    this.scene.add(mesh);

    const anim = {
      mesh,
      isMe,
      drawnTile,
      startPos,
      startRotY,
      midPos: new THREE.Vector3(0, 5.2, 4.8),
      endPos: isMe ? new THREE.Vector3(0, -1.0, 11.5) : new THREE.Vector3(0, 3.5, -8.0),
      // 1.8: give the player time to actually watch their own draw. The lift,
      // the brief face-up hover and the glide into the hand now total ~1.05s
      // (opponents stay a little quicker at ~0.65s so the table keeps moving).
      dur1: isMe ? 0.46 : 0.34,  // Phase 1: Lift & Flip
      dur2: isMe ? 0.30 : 0.10,  // Phase 2: hold the face up so the pips read
      dur3: isMe ? 0.30 : 0.20,  // Phase 3: Glide into the hand (or opponent's side)
      t: 0,
      kind: 'draw',
    };
    anim.totalDur = anim.dur1 + anim.dur2 + anim.dur3;
    this._anims.push(anim);
  }

  /**
   * Frame the chain (plus the boneyard when it is actionable) for the CURRENT
   * aspect ratio. The goal is only ever applied by the spring, and never while
   * the player has taken the camera with a drag/wheel/pinch.
   */
  _fitCamera(spots) {
    this._lastFitSpots = spots || [];
    // 1.7: the camera used to start easing ~340ms BEFORE the tile touched down,
    // so the board was already gliding while the tile was still in the air and
    // the whole move felt loose. Hold the spring until touchdown instead.
    const delay = this._reducedMotion ? 0 : 500;
    this._camStartAt = performance.now() + delay;
    // Generous window: on a slow device dt is clamped, so the spring needs more
    // wall-clock time to converge. It stops early once it actually arrives.
    this._camUntil = this._camStartAt + 2000;
    if (!spots.length) {
      this._camTargetGoal = { x: 0, y: 0, z: 0 };
      this._camGoal = { x: 0, y: 16, z: 11 };
      this._applyCameraGoal();
      return;
    }
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const add = (x, z) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    };
    for (const s of spots) add(s.x, s.z);
    // The boneyard is decoration most of the time; when the player can actually
    // draw, it becomes a control and must be inside the frame.
    if (this.canDraw) {
      for (const o of this.boneGroup.children) {
        if (o.userData && o.userData.isTile) add(o.position.x, o.position.z);
      }
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const spanX = Math.max(maxX - minX + TILE_W + 1.5, 6);
    const spanZ = Math.max(maxZ - minZ + TILE_L + 1.5, 6);
    // Distance that fits both the horizontal span (narrowed by the aspect) and
    // the depth span (foreshortened by the ~51° camera elevation).
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const aspect = Math.max(0.35, this.camera.aspect || 1);
    const distH = (spanX / (2 * tan * aspect)) * 1.25;
    const distV = ((spanZ * 0.85) / (2 * tan)) * 1.25;
    // Portrait phones need a larger ceiling or the chain falls off-screen.
    const maxDist = aspect < 0.85 ? 72 : 48;
    const dist = clamp(Math.max(distH, distV, 13), 13, maxDist);
    this.controls.maxDistance = Math.max(46, Math.min(90, dist * 1.3));
    this._camGoal = { x: cx, y: dist * 0.78, z: cz + dist * 0.62 };
    this._camTargetGoal = { x: cx, y: 0, z: cz };
    this._applyCameraGoal();
  }

  /** Reduced motion (and the first fit) skip the spring; a user orbit wins. */
  _applyCameraGoal() {
    if (!this._camGoal || !this._camTargetGoal || this._userOrbited || this._orbiting) return;
    if (!this._reducedMotion) return;
    this.camera.position.set(this._camGoal.x, this._camGoal.y, this._camGoal.z);
    this.controls.target.set(this._camTargetGoal.x, this._camTargetGoal.y, this._camTargetGoal.z);
    this._camVel.x = this._camVel.y = this._camVel.z = 0;
    this._camUntil = 0;
    this.controls.update?.();
  }

  // ── markers (pooled) ──
  // Four fixed slots — the table can never have more open ends than L/R/U/D.
  // Each slot owns one pad material, one halo light and one score sprite that are
  // created once and only hidden on clearMarkers(). The old code allocated a
  // fresh MeshBasicMaterial + PointLight per marker on every turn, and the pad
  // materials were never released (they are not in any pool).
  _buildMarkerPool() {
    this._markerPool = [];
    this._markerCount = 0;
    this._ghostSpriteMat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false });
    for (let i = 0; i < MAX_MARKERS; i++) {
      const padMat = new THREE.MeshBasicMaterial({
        // HDR tint (>1 linear) so the bloom pass picks the pads up on high tier
        color: new THREE.Color(0x2ee6a8).multiplyScalar(1.8),
        transparent: true, opacity: 0.3, depthWrite: false,
      });
      const pad = new THREE.Mesh(this._geo, padMat);
      pad.position.y = 0.06;
      pad.visible = false;
      pad.renderOrder = 1;
      pad.userData = { active: false };

      const hit = this._hitMesh(1, 1, 1);
      hit.position.y = 0.5;

      // Keep the light in the render list with intensity 0 when idle: toggling
      // `visible` on a light changes the light count and forces a shader recompile.
      const light = new THREE.PointLight(0x2ee6a8, 0, 4);
      light.position.y = 1.2;

      const sprite = new THREE.Sprite(this._ghostSpriteMat);
      sprite.scale.set(1.7, 0.85, 1);
      sprite.visible = false;

      this.markerGroup.add(pad, hit, light, sprite);
      this._markerPool.push({ pad, padMat, hit, light, sprite, active: false, end: null, dim: 1 });
    }
  }

  /** One pulse/dim step for a slot — called by the loop and by highlightEnd. */
  _applyMarkerVisual(slot, t) {
    if (!slot) return;
    const pulse = this._reducedMotion ? 0.3 : 0.26 + Math.sin(t * 4) * 0.12;
    const glow = this._reducedMotion ? 3.4 : 3 + Math.sin(t * 4) * 1.5;
    slot.pad.material.opacity = pulse * slot.dim;
    slot.light.intensity = glow * slot.dim;
  }

  // scoreBy: optional map end → preformatted label (e.g. "+5" / "12 → 7") for the
  // All-Fives preview. A `null` value means "this play scores nothing" and is
  // skipped entirely (1.5: no more "+0" badges).
  showMarkers(ends, scoreBy = null) {
    this.clearMarkers();
    if (!this._endSpots || !this._markerPool) return;
    const t = performance.now() / 1000;
    let i = 0;
    for (const e of ends) {
      if (i >= MAX_MARKERS) break;
      const s = this._endSpots[e];
      if (!s) continue;
      const slot = this._markerPool[i++];
      slot.active = true;
      slot.end = e;
      slot.dim = 1;

      slot.pad.position.set(s.x, 0.06, s.z);
      slot.pad.rotation.y = s.rotY;
      slot.pad.visible = true;
      slot.pad.userData = { active: true, end: e };

      slot.hit.position.set(s.x, 0.5, s.z);
      slot.hit.rotation.y = s.rotY;
      slot.hit.visible = false;   // raycasting works on hidden meshes
      slot.hit.userData = { isHitArea: true, active: true, end: e };

      slot.light.position.set(s.x, 1.2, s.z);

      const sc = scoreBy && scoreBy[e];
      if (sc != null) {
        slot.sprite.material = this._scoreBadgeMat(sc);
        slot.sprite.position.set(s.x, 2.0, s.z);
        slot.sprite.visible = true;
      } else {
        slot.sprite.visible = false;
      }
      this._applyMarkerVisual(slot, t);
    }
    this._markerCount = i;
  }

  // canvas-painted score pill (e.g. "+5") shared by SpriteMaterial, cached per label
  _scoreBadgeMat(text) {
    const key = 'score' + text;
    if (this._scoreMats.has(key)) return this._scoreMats.get(key);
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(8,12,24,0.92)';
    g.beginPath();
    if (g.roundRect) g.roundRect(4, 4, 120, 56, 18); else g.rect(4, 4, 120, 56);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = '#2ee6a8';
    g.stroke();
    g.fillStyle = '#2ee6a8';
    g.font = '900 34px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(text), 64, 35);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    this._scoreMats.set(key, mat);
    return mat;
  }

  clearMarkers() {
    for (const slot of this._markerPool || []) {
      slot.active = false;
      slot.end = null;
      slot.dim = 1;
      // Deactivate the picking state explicitly: raycasting ignores `visible`,
      // so a hidden hit box with `end` still set would keep accepting taps.
      slot.pad.visible = false;
      slot.pad.userData = { active: false };
      slot.hit.visible = false;
      slot.hit.userData = { isHitArea: true, active: false };
      slot.light.intensity = 0;
      slot.sprite.visible = false;
    }
    this._markerCount = 0;
  }

  /** Which playable end (if any) sits under this client point — used by drag & drop. */
  endFromPoint(clientX, clientY) {
    if (!this.renderer || !this._markerCount) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    this._pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hitTargets = this._markerPool.filter(s => s.active && s.end != null).map(s => s.hit);
    const hits = this._raycaster.intersectObjects(hitTargets, false);
    if (hits.length) {
      const hit = hits.find(h => h.object?.userData?.end !== undefined);
      if (hit) return hit.object.userData.end;
    }
    // 2D screen-distance fallback (same tolerance as click picking)
    const v = new THREE.Vector3();
    let bestEnd = null, minDist = Infinity;
    for (const t of hitTargets) {
      t.getWorldPosition(v);
      v.project(this.camera);
      if (v.z > 1) continue;
      const sx = ((v.x + 1) / 2) * r.width + r.left;
      const sy = ((-v.y + 1) / 2) * r.height + r.top;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < minDist) { minDist = d; bestEnd = t.userData.end; }
    }
    return minDist < 75 && bestEnd !== null ? bestEnd : null;
  }

  /**
   * Dim non-target markers during a drag; null restores all.
   * The factor is stored on the slot so the pulse loop keeps honouring it —
   * writing material.opacity directly lasted exactly one frame.
   */
  highlightEnd(end) {
    if (!this._markerPool) return;
    const t = performance.now() / 1000;
    for (const slot of this._markerPool) {
      if (!slot.active) continue;
      slot.dim = (end == null || slot.end === end) ? 1 : 0.32;
      this._applyMarkerVisual(slot, t);
    }
  }

  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);

    // 1. Check ghost markers if move is active. Only ACTIVE hit areas are tested:
    //    raycasting ignores `visible`, so stale pooled slots would otherwise keep
    //    accepting taps on ends the engine no longer offers.
    if (this._markerCount) {
      const hitTargets = this._markerPool.filter(s => s.active && s.end != null).map(s => s.hit);
      const hits = this._raycaster.intersectObjects(hitTargets, false);
      if (hits.length) {
        const hit = hits.find(h => h.object && h.object.userData && h.object.userData.end !== undefined);
        if (hit) {
          this.onMarkerClick?.(hit.object.userData.end);
          return;
        }
      }

      // 2D screen distance fallback for markers
      const v = new THREE.Vector3();
      let bestEnd = null, minDist = Infinity;
      for (const t of hitTargets) {
        t.getWorldPosition(v);
        v.project(this.camera);
        if (v.z > 1) continue;
        const screenX = ((v.x + 1) / 2) * r.width + r.left;
        const screenY = ((-v.y + 1) / 2) * r.height + r.top;
        const screenDist = Math.hypot(e.clientX - screenX, e.clientY - screenY);
        if (screenDist < minDist) {
          minDist = screenDist;
          bestEnd = t.userData.end;
        }
      }
      if (minDist < 75 && bestEnd !== null) {
        this.onMarkerClick?.(bestEnd);
        return;
      }
    }

    // 2. Check boneyard click if player must draw
    if (this.canDraw && this.boneGroup && this.boneGroup.children.length > 0) {
      const boneTargets = this.boneGroup.children.filter(o => o.userData && o.userData.isBoneyard);
      const hits = this._raycaster.intersectObjects(boneTargets, false);
      if (hits.length > 0) {
        const hit = hits[0].object;
        const targetMesh = hit.userData.targetMesh || hit;
        this.onBoneyardClick?.(targetMesh);
        return;
      }

      // 2D screen distance fallback for boneyard
      const v = new THREE.Vector3();
      let bestBone = null, minBoneDist = Infinity;
      for (const t of boneTargets) {
        t.getWorldPosition(v);
        v.project(this.camera);
        if (v.z > 1) continue;
        const screenX = ((v.x + 1) / 2) * r.width + r.left;
        const screenY = ((-v.y + 1) / 2) * r.height + r.top;
        const screenDist = Math.hypot(e.clientX - screenX, e.clientY - screenY);
        if (screenDist < minBoneDist) {
          minBoneDist = screenDist;
          bestBone = t.userData.targetMesh || t;
        }
      }
      if (minBoneDist < 65 && bestBone) {
        this.onBoneyardClick?.(bestBone);
        return;
      }
    }

    this.onBoardMiss?.();
  }

  // ── contact shadows ──
  // One InstancedMesh of soft quads under every tile: a single draw call for the
  // whole table. It lives directly on the scene (never inside chainGroup /
  // boneGroup / markerGroup, which get cleared and re-created on every sync) and
  // is released only in dispose().
  _buildContactShadows() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.60)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.32)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this._contactTex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);          // lie flat in the XZ plane
    this._contactGeo = geo;
    this._contactMat = new THREE.MeshBasicMaterial({
      map: this._contactTex,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const inst = new THREE.InstancedMesh(geo, this._contactMat, CONTACT_SHADOW_MAX);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.count = 0;
    inst.renderOrder = -2;
    inst.frustumCulled = false;         // bounds change every sync
    inst.castShadow = false;
    inst.receiveShadow = false;
    this._contact = inst;
    this._contactDummy = new THREE.Object3D();
    this.scene.add(inst);
  }

  /** Rebuild the instance buffer from the current chain spots + boneyard bones. */
  _syncContactShadows(spots) {
    const inst = this._contact;
    if (!inst) return;
    const d = this._contactDummy;
    let n = 0;
    const push = (x, z, rotY, sx, sz) => {
      if (n >= CONTACT_SHADOW_MAX) return;
      d.position.set(x, SHADOW_Y, z);
      d.rotation.set(0, rotY || 0, 0);
      d.scale.set(sx, 1, sz);
      d.updateMatrix();
      inst.setMatrixAt(n++, d.matrix);
    };
    for (const s of spots || []) push(s.x, s.z, s.rotY, TILE_W * 1.5, TILE_L * 1.15);
    for (const o of this.boneGroup?.children || []) {
      if (o.userData && o.userData.isTile) push(o.position.x, o.position.z, o.rotation.y, TILE_W * 1.3, TILE_L * 1.05);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
  }

  // ── loop ──
  // A single rAF starter: setActive / visibility / intersection all funnel into
  // _updateLoop, which starts or stops the one loop. Nothing else may schedule a
  // frame — a second loop would double-render and corrupt the quality probe dt.
  pauseLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  resumeLoop() {
    this.clock = performance.now();
    this._startLoop();
  }

  _shouldRun() {
    if (this._disposed || !this._active || !this._visible) return false;
    return !(typeof document !== 'undefined' && document.hidden);
  }

  _startLoop() {
    if (this._raf || !this._shouldRun()) return;
    this.clock = performance.now();
    this._raf = requestAnimationFrame(this._onFrame);
  }

  _updateLoop() {
    if (this._shouldRun()) this._startLoop();
    else this.pauseLoop();
  }

  /** P0.3: the UI phase calls this from showScreen(); the board pauses off-screen. */
  setActive(active) {
    const next = !!active;
    if (next === this._active) {
      if (next) this._updateLoop();
      return;
    }
    this._active = next;
    if (next) {
      this.resize();
      this._updateLoop();
    } else {
      this.pauseLoop();
    }
  }

  _onFrame = (now) => {
    this._raf = 0;
    if (!this._shouldRun()) return;
    this._raf = requestAnimationFrame(this._onFrame);
    this._step(now);
  };

  _step(now) {
    const dt = Math.min(this.clock ? (now - this.clock) / 1000 : 0.016, 0.05);
    this.clock = now;
    const t = now / 1000;

    // pulse active ghost markers only (inactive pooled slots sit at opacity 0)
    for (const slot of this._markerPool) {
      if (slot.active) this._applyMarkerVisual(slot, t);
    }

    // pulse warm boneyard light when canDraw is true
    if (this.canDraw && this.boneLight) {
      this.boneLight.intensity = this._reducedMotion ? 4 : 3.5 + Math.sin(t * 6) * 1.8;
    }

    // process active animations
    this._anims = this._anims.filter(a => {
      a.t += dt;

      if (a.kind === 'drop') {
        const k = Math.min(a.t / a.dur, 1);
        const e2 = 1 - (1 - k) ** 3;
        // F4.4: parabola — height eases out while the tile also travels in X/Z
        // from its arc origin to the resting spot (settles at k = 1).
        if (a.arc) {
          a.mesh.position.x = a.arc.fromX + (a.toX - a.arc.fromX) * e2;
          a.mesh.position.z = a.arc.fromZ + (a.toZ - a.arc.fromZ) * e2;
        }
        a.mesh.position.y = 7 * (1 - e2);
        a.mesh.rotation.x = 0.6 * (1 - e2);
        if (k >= 1) {
          a.mesh.position.y = 0; a.mesh.rotation.x = 0;
          if (a.arc) { a.mesh.position.x = a.toX; a.mesh.position.z = a.toZ; }
          // B3: 2-stage settle — a short squash-and-recover after touchdown
          if (!this._reducedMotion) this._anims.push({ mesh: a.mesh, t: 0, dur: 0.2, kind: 'settle' });
          return false;
        }
        return true;
      }

      if (a.kind === 'settle') {
        // squash on Y with a slight bulge on X/Z, easing back to rest
        const k2 = Math.min(a.t / a.dur, 1);
        const s = Math.sin(k2 * Math.PI);
        a.mesh.scale.set(1 + s * 0.07, 1 - s * 0.14, 1 + s * 0.07);
        if (k2 >= 1) { a.mesh.scale.set(1, 1, 1); return false; }
        return true;
      }

      if (a.kind === 'draw') {
        const { isMe, mesh, startPos, midPos, endPos, startRotY, dur1, dur2, dur3, totalDur } = a;
        if (a.t >= totalDur) {
          this.scene.remove(mesh);
          // Release this tile's own materials; the shared _geo is left intact.
          this._disposeTileMesh(mesh);
          return false;
        }

        if (a.t < dur1) {
          // Phase 1: Lift from boneyard into air, flipping 180° around Z to reveal face
          const k = a.t / dur1;
          const ease = 1 - (1 - k) ** 3; // cubic ease out
          mesh.position.lerpVectors(startPos, midPos, ease);
          if (isMe) {
            mesh.rotation.z = ease * Math.PI;               // 180° flip (showing face)
            mesh.rotation.x = ease * 0.45;                  // tilt up toward camera
            mesh.rotation.y = (1 - ease) * startRotY;
            const s = 1.0 + ease * 0.35;                    // enlarge slightly for clarity
            mesh.scale.set(s, s, s);
          } else {
            mesh.rotation.y = (1 - ease) * startRotY;
            mesh.position.y = startPos.y + ease * 3.0;
          }
        } else if (a.t < dur1 + dur2) {
          // Phase 2: Pause hovering in air to admire the drawn domino pips
          const k = (a.t - dur1) / dur2;
          const bob = Math.sin(k * Math.PI) * 0.12;
          mesh.position.set(midPos.x, midPos.y + bob, midPos.z);
          if (isMe) {
            mesh.rotation.z = Math.PI;
            mesh.rotation.x = 0.45;
            mesh.rotation.y = 0;
            mesh.scale.set(1.35, 1.35, 1.35);
          }
        } else {
          // Phase 3: Glide into the hand dock at the bottom
          const k = (a.t - dur1 - dur2) / dur3;
          // 1.7: phase 3 used `k*k` ease-IN, which made the tile accelerate into
          // the player's hand and read as a slam. Ease-out lands it softly.
          const ease = 1 - (1 - k) ** 2; // quadratic ease out
          mesh.position.lerpVectors(midPos, endPos, ease);
          if (isMe) {
            mesh.rotation.z = Math.PI;
            mesh.rotation.x = 0.45 + ease * -0.25;
            const s = 1.35 * (1 - ease * 0.65);
            mesh.scale.set(s, s, s);
          } else {
            const s = Math.max(0.01, 1 - ease);
            mesh.scale.set(s, s, s);
          }
        }
        return true;
      }

      return false;
    });

    // camera easing toward fit — B3: critically damped spring, active for a
    // short window after each auto-fit. A user orbit wins: _userOrbited stays
    // set until the next hand/reconnect, so the spring never fights the player.
    if (!this._userOrbited && !this._orbiting && this._camGoal && !this._reducedMotion &&
        now >= (this._camStartAt || 0) && now < (this._camUntil || 0)) {
      const w = 4.5, w2 = w * w;
      const p = this.camera.position, v = this._camVel, g = this._camGoal;
      v.x += (w2 * (g.x - p.x) - 2 * w * v.x) * dt;
      v.y += (w2 * (g.y - p.y) - 2 * w * v.y) * dt;
      v.z += (w2 * (g.z - p.z) - 2 * w * v.z) * dt;
      p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
      const tg = this._camTargetGoal;
      if (tg) {
        this._camTargetVec.set(tg.x, tg.y, tg.z);
        this.controls.target.lerp(this._camTargetVec, 1 - Math.exp(-5 * dt));
      }
      // Arrived: stop the spring instead of nudging the camera for the rest of the
      // window (visible as drift on slow devices where the deadline is generous).
      const dx = g.x - p.x, dy = g.y - p.y, dz = g.z - p.z;
      if (dx * dx + dy * dy + dz * dz < 0.01 &&
          Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) < 0.05) {
        this._camUntil = 0;
      }
    }

    this.controls.update();

    // Shadow maps are on-demand: refresh while tiles move or after a sync that
    // changed geometry. Camera-only motion never needs a new shadow pass.
    if (this._anims.length > 0 || this._shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this._shadowDirty = false;
    }

    // P1.12: reset once per frame, then let scene + every composer pass add up.
    this.renderer.info.reset();
    if (this._composer) this._composer.render();
    else this.renderer.render(this.scene, this.camera);
    // Only the running loop feeds the probe (owner token), so a background board
    // can never poison the frame-time window.
    feedFrame(now, 'board');
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || innerWidth;
    const h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._composer?.setSize(w, h);
    // The fit distance depends on the aspect — recompute it on a real resize.
    if (w > 0 && h > 0 && this._lastFitSpots?.length && !this._userOrbited) {
      this._fitCamera(this._lastFitSpots);
    }
  }

  /**
   * Tear the whole board down. This is the ONLY place that may dispose the shared
   * resources (F3.1 pooled materials, F3.2 shared geometry, cached textures) —
   * doing it anywhere else blanks the tiles that still use them.
   * Idempotent: the second call is a no-op.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.pauseLoop();

    if (this._io) { try { this._io.disconnect(); } catch { /* already gone */ } this._io = null; }
    for (const [target, type, fn, opts] of this._listeners) {
      try { target.removeEventListener(type, fn, opts); } catch { /* detached node */ }
    }
    this._listeners.length = 0;

    this._unsubQuality?.();
    this._unsubQuality = null;
    this._teardownComposer();

    // In-flight draw meshes live directly on the scene, not in a group.
    for (const a of this._anims) {
      if (a.mesh) { this.scene.remove(a.mesh); this._disposeTileMesh(a.mesh); }
    }
    this._anims = [];

    for (const child of this.chainGroup.children) this._disposeTileMesh(child);
    for (const child of this.boneGroup.children) this._disposeTileMesh(child);
    this.chainGroup.clear();
    this.boneGroup.clear();

    // Marker pool: one material per slot, plus the shared placeholder sprite mat.
    for (const slot of this._markerPool || []) {
      this.scene.remove(slot.pad, slot.hit, slot.light, slot.sprite);
      slot.padMat?.dispose?.();
    }
    this.markerGroup.clear();
    this._markerPool = [];
    this._markerCount = 0;
    this._ghostSpriteMat?.dispose?.();
    this._ghostSpriteMat = null;

    // Contact-shadow instancing.
    if (this._contact) {
      this.scene.remove(this._contact);
      this._contactGeo?.dispose?.();
      this._contactMat?.dispose?.();
      this._contactTex?.dispose?.();
      this._contact = null;
    }

    // Table meshes/materials/textures.
    for (const mesh of [this._tableTop, this._tableRim, this._tableFloor]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry?.dispose?.();
    }
    this._tableTop = this._tableRim = this._tableFloor = null;
    this._feltMat?.dispose?.();
    this._rimMat?.dispose?.();
    this._floorMat?.dispose?.();
    this._feltTex?.dispose?.();
    this._feltMat = this._rimMat = this._floorMat = this._feltTex = null;

    // Shared skin caches.
    for (const mat of this._matCache.values()) mat.dispose?.();
    this._matCache.clear();
    for (const tex of this._texCache.values()) tex.dispose?.();
    this._texCache.clear();
    this._backMatC?.dispose?.();
    this._backMatC = null;
    this._sideMatC?.dispose?.();
    this._sideMatC = null;

    for (const mat of this._scoreMats.values()) { mat.map?.dispose?.(); mat.dispose?.(); }
    this._scoreMats.clear();

    this._geo?.dispose?.();
    this._geo = null;
    this._hitBoxGeo?.dispose?.();
    this._hitBoxGeo = null;
    this._hitMatC?.dispose?.();
    this._hitMatC = null;

    if (this._lastLabel) { this.scene.remove(this._lastLabel); this._lastLabel = null; }
    for (const mat of this._labelMats.values()) { mat.map?.dispose?.(); mat.dispose?.(); }
    this._labelMats.clear();

    // Environment map (a PMREM render target) and its binding.
    if (this._envRT) {
      if (this.scene.environment === this._envRT.texture) this.scene.environment = null;
      this._envRT.dispose?.();
      this._envRT = null;
    }

    this.controls?.dispose?.();
    this.controls = null;

    // renderer.dispose() (r160) does not release the key light's shadow render
    // target — it is allocated lazily by WebGLShadowMap and owned by the light.
    if (this._key?.shadow?.map) {
      this._key.shadow.map.dispose?.();
      this._key.shadow.map = null;
    }
    this._key = null;

    // NOTE: renderer.dispose() releases three's GL objects but deliberately does
    // NOT call forceContextLoss() — that permanently kills the context, so a board
    // re-created on the same canvas (2D→3D toggle, rematch after a teardown) could
    // never get a new one. The browser frees the context with the canvas.
    this.renderer?.dispose?.();
  }
}
