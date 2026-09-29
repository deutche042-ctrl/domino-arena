// js/board3d.js — Three.js 3D domino table: tiles, snake layout, ghost markers
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { tileFaceCanvas, tileBackCanvas, feltCanvas } from './tiles.js?v=11';

const TILE_W = 1, TILE_L = 2, TILE_H = 0.42, GAP = 0.07;
const MAX_X = 9.5;              // table boundary along X before turning
const MAX_Z = 6.0;              // table boundary along Z before turning
const adv = isDbl => (isDbl ? TILE_W : TILE_L) + GAP;

export class Board3D {
  constructor(canvas, { onMarkerClick, onBoardMiss, onBoneyardClick } = {}) {
    this.onMarkerClick = onMarkerClick;
    this.onBoardMiss = onBoardMiss;
    this.onBoneyardClick = onBoneyardClick;
    this.canDraw = false;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a14);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 20, 13);

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

    // lights
    this.scene.add(new THREE.AmbientLight(0xbfd0ff, 0.55));
    const key = new THREE.DirectionalLight(0xfff2dd, 1.6);
    key.position.set(6, 18, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -16; key.shadow.camera.right = 16;
    key.shadow.camera.top = 16; key.shadow.camera.bottom = -16;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.PointLight(0x4d7dff, 12, 40);
    rim.position.set(-8, 6, -6);
    this.scene.add(rim);

    // Warm invite spotlight on boneyard when drawing is possible
    this.boneLight = new THREE.PointLight(0xf4c055, 0, 14);
    this.boneLight.position.set(9.5, 4.0, 9.8);
    this.boneLight.visible = false;
    this.scene.add(this.boneLight);

    this._buildTable();

    // groups
    this.chainGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.boneGroup = new THREE.Group();
    this.scene.add(this.chainGroup, this.markerGroup, this.boneGroup);

    this._texCache = new Map();
    this._matCache = new Map();    // F3.1: pooled face materials, keyed `f:a-b`
    this._scoreMats = new Map();   // "+N" All-Fives preview badge sprites
    // SHARED geometry for every tile mesh in the scene. NEVER dispose it
    // per-mesh — disposing it once would blank out every tile that uses it.
    // If the renderer is ever torn down, dispose this exactly once there.
    this._geo = new RoundedBoxGeometry(TILE_W, TILE_H, TILE_L, 4, 0.09);
    // F3.1 (extended): hit-area geometry + material. Boneyard/marker hit boxes used
    // to allocate a fresh BoxGeometry AND a fresh transparent MeshBasicMaterial on
    // every sync (markers re-render each turn), which churned hundreds of GL objects
    // per game. All hit boxes are unit-ish and only ever scaled via `.scale`, and the
    // transparent material is identical for all of them — so both are shared, exactly
    // like _geo. Created lazily (a board with no hits never pays for them).
    this._hitBoxGeo = null;        // shared BoxGeometry(TILE_W*3.6, 3, TILE_L*3.2) — scaled per use
    this._hitMatC = null;          // shared transparent MeshBasicMaterial for every hit box
    this._disposed = false;
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

    canvas.addEventListener('pointerdown', (e) => {
      this._downX = e.clientX;
      this._downY = e.clientY;
      this._downTime = performance.now();
    });
    canvas.addEventListener('pointerup', (e) => {
      const dist = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
      const dur = performance.now() - this._downTime;
      const maxDist = e.pointerType === 'touch' ? 32 : 10;
      if (dist < maxDist && dur < 700) {
        this._pick(e);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
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
    });
    window.addEventListener('resize', () => this.resize());
    // battery saver: stop rendering while the tab is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseLoop();
      else this.resumeLoop();
    });
    this.resize();
    this._loop();
  }

  // ── table ──
  _buildTable() {
    const felt = new THREE.CanvasTexture(feltCanvas());
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(17, 17, 0.6, 64),
      new THREE.MeshStandardMaterial({ map: felt, roughness: 0.95 })
    );
    top.position.y = -0.3 - TILE_H / 2;
    top.receiveShadow = true;
    this.scene.add(top);
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(18.4, 18.4, 0.7, 64),
      new THREE.MeshStandardMaterial({ color: 0x4a2f1d, roughness: 0.55, metalness: 0.1 })
    );
    rim.position.y = -0.42 - TILE_H / 2;
    this.scene.add(rim);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(60, 32),
      new THREE.MeshStandardMaterial({ color: 0x0a0e1c, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.2;
    this.scene.add(floor);
  }

  // ── tile meshes ──
  _faceTex(a, b) {
    const k = `${a}-${b}`;
    if (!this._texCache.has(k)) {
      const t = new THREE.CanvasTexture(tileFaceCanvas(a, b));
      t.anisotropy = 8;
      this._texCache.set(k, t);
    }
    return this._texCache.get(k);
  }

  _backTex() {
    if (!this._texCache.has('back')) {
      const t = new THREE.CanvasTexture(tileBackCanvas());
      t.anisotropy = 8;
      this._texCache.set('back', t);
    }
    return this._texCache.get('back');
  }

  _sideMat() {
    if (!this._sideMatC) {
      this._sideMatC = new THREE.MeshStandardMaterial({ color: 0xefe8d4, roughness: 0.35 });
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
    const k = `f:${a}-${b}`;
    if (!this._matCache.has(k)) {
      this._matCache.set(k, new THREE.MeshStandardMaterial({ map: this._faceTex(a, b), roughness: 0.3 }));
    }
    return this._matCache.get(k);
  }

  _backMat() {
    if (!this._backMatC) {
      this._backMatC = new THREE.MeshStandardMaterial({ map: this._backTex(), roughness: 0.5 });
    }
    return this._backMatC;
  }

  _tileMesh(a, b, faceUp = true) {
    // Pooled: never disposed per-mesh (see _disposeTileMesh) — disposing a shared
    // material would blank out every tile using it, exactly like _geo.
    const face = this._faceMat(a, b);
    const back = this._backMat();
    const side = this._sideMat();
    const mats = [side, side, faceUp ? face : back, faceUp ? back : face, side, side];
    const m = new THREE.Mesh(this._geo, mats);
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
      const mesh = this._tileMesh(mv.t.a, mv.t.b);
      mesh.position.set(s.x, 0, s.z);
      mesh.rotation.y = s.rotY;
      this.chainGroup.add(mesh);
      this._chainViews.push(mesh);
      // Only the very last tile gets the drop-in flourish.
      if (i === moves.length - 1) {
        mesh.position.y = 7;
        mesh.rotation.x = 0.6;
        this._anims.push({ mesh, t: 0, dur: 0.45, kind: 'drop', baseRotY: s.rotY });
      }
    }

    st.movesLen = moves.length;
    this._movesRendered = moves.length;
    this._lastMoves = moves;
    this._layoutIsAllFives = isAllFives;
    this._endSpots = this._endSpotsFor(st);

    this._syncBoneyard(view.boneyardCount);
    const allSpots = st.spots;   // full spot list, prefix + appended
    this._fitCamera(allSpots.length ? allSpots : addedSpots);
  }

  /** Full rebuild — used when the chain is not a pure extension of the last one. */
  _rebuildMoves(moves, isAllFives, view) {
    // Any in-flight 'drop' animation targets a chain mesh that is about to be
    // recycled; drop those anims first so the loop cannot write to a detached,
    // already-disposed mesh. 'draw' anims own their own scene meshes, so they
    // are left to finish normally.
    this._anims = this._anims.filter(a => a.kind !== 'drop');

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
        this._anims.push({ mesh, t: 0, dur: 0.45, kind: 'drop', baseRotY: s.rotY });
      }
    }

    st.movesLen = moves.length;
    this._layoutState = st;
    this._movesRendered = moves.length;
    this._lastMoves = moves;
    this._layoutIsAllFives = isAllFives;
    this._endSpots = this._endSpotsFor(st);

    this._syncBoneyard(view.boneyardCount);
    this._fitCamera(st.spots);
  }

  setCanDraw(canDraw) {
    this.canDraw = !!canDraw;
    if (this.boneLight) {
      this.boneLight.visible = this.canDraw;
      if (!this.canDraw) this.boneLight.intensity = 0;
    }
    if (!this.canDraw && this.renderer?.domElement?.style?.cursor === 'pointer') {
      this.renderer.domElement.style.cursor = 'default';
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
      m.userData = { isBoneyard: true, index: i };
      m.castShadow = true;
      m.receiveShadow = true;
      this.boneGroup.add(m);

      // Hit area mesh for forgiving touch/mouse clicks (pooled geo + material)
      const hit = this._hitMesh(TILE_W * 1.3 / (TILE_W * 3.6), 1.8 / 3.0, TILE_L * 1.3 / (TILE_L * 3.2));
      hit.position.set(x, 0.6, z);
      hit.rotation.y = jitterRot;
      hit.userData = { isBoneyard: true, index: i, targetMesh: m };
      this.boneGroup.add(hit);
    }
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
      dur1: isMe ? 0.45 : 0.38,  // Phase 1: Lift & Flip
      dur2: isMe ? 0.40 : 0.0,   // Phase 2: Pause in air to admire the pips
      dur3: isMe ? 0.35 : 0.25,  // Phase 3: Glide into 2D hand (or opponent's side)
      t: 0,
      kind: 'draw',
    };
    anim.totalDur = anim.dur1 + anim.dur2 + anim.dur3;
    this._anims.push(anim);
  }

  _fitCamera(spots) {
    if (!spots.length) {
      this.controls.target.set(0, 0, 0);
      this._camGoal = { x: 0, y: 16, z: 11 };
      return;
    }
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const s of spots) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX + 5, (maxZ - minZ) * 1.9 + 7, 13);
    this.controls.target.set(cx, 0, cz);
    const dist = Math.min(Math.max(span, 13), 42);
    this._camGoal = { x: cx, y: dist * 0.78, z: cz + dist * 0.62 };
  }

  // ── markers ──
  // scoreBy: optional map end → predicted ends total (All Fives preview);
  // when present a "+N" badge floats above each marker.
  showMarkers(ends, scoreBy = null) {
    this.clearMarkers();
    if (!this._endSpots) return;
    for (const e of ends) {
      const s = this._endSpots[e];
      if (!s) continue;
      const g = new THREE.Mesh(
        this._geo,
        new THREE.MeshBasicMaterial({ color: 0x2ee6a8, transparent: true, opacity: 0.35, depthWrite: false })
      );
      g.position.set(s.x, 0.06, s.z);
      g.rotation.y = s.rotY;
      g.userData.end = e;
      this.markerGroup.add(g);

      // Hit area mesh (generous hit box for forgiving touch/mouse clicks; pooled)
      const hitArea = this._hitMesh(1, 1, 1);
      hitArea.position.set(s.x, 0.5, s.z);
      hitArea.rotation.y = s.rotY;
      hitArea.userData.end = e;
      hitArea.userData.isHitArea = true;
      this.markerGroup.add(hitArea);

      const halo = new THREE.PointLight(0x2ee6a8, 4, 4);
      halo.position.set(s.x, 1.2, s.z);
      halo.userData.end = e;
      this.markerGroup.add(halo);

      const sc = scoreBy && scoreBy[e];
      if (sc != null) {
        const spr = new THREE.Sprite(this._scoreBadgeMat(sc));
        spr.position.set(s.x, 2.0, s.z);
        spr.scale.set(1.7, 0.85, 1);
        this.markerGroup.add(spr);
      }
    }
  }

  // canvas-painted "+N" pill shared by SpriteMaterial, cached per value
  _scoreBadgeMat(n) {
    const key = 'score' + n;
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
    g.font = '900 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('+' + n, 64, 35);
    const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
    this._scoreMats.set(key, mat);
    return mat;
  }

  clearMarkers() {
    // Marker meshes own their own materials; release them before clearing.
    for (const child of this.markerGroup.children) this._disposeTileMesh(child);
    this.markerGroup.clear();
  }

  /** Which playable end (if any) sits under this client point — used by drag & drop. */
  endFromPoint(clientX, clientY) {
    if (!this.renderer || !this.markerGroup || this.markerGroup.children.length === 0) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    this._pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hitTargets = this.markerGroup.children.filter(o => o.userData && o.userData.end !== undefined);
    const hits = this._raycaster.intersectObjects(hitTargets, false);
    if (hits.length) {
      const hit = hits.find(h => h.object?.userData?.end !== undefined);
      if (hit) return hit.object.userData.end;
    }
    // 2D screen-distance fallback (same tolerance as click picking)
    const v = new THREE.Vector3();
    let bestEnd = null, minDist = Infinity;
    for (const t of hitTargets) {
      if (!t.userData.isHitArea) continue;
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

  /** Dim non-target markers during a drag; null restores all. */
  highlightEnd(end) {
    if (!this.markerGroup) return;
    for (const o of this.markerGroup.children) {
      if (o.userData?.end === undefined || !o.material || o.userData.isHitArea) continue;
      o.material.opacity = (end == null || o.userData.end === end) ? 0.35 : 0.1;
    }
  }

  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);

    // 1. Check ghost markers if move is active
    if (this.markerGroup && this.markerGroup.children.length > 0) {
      const hitTargets = this.markerGroup.children.filter(o => o.userData && o.userData.end !== undefined);
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
        if (!t.userData.isHitArea) continue;
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

  // ── loop ──
  pauseLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  resumeLoop() {
    if (this._raf) return;
    this.clock = performance.now();
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._loop(); });
  }

  _loop() {
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._loop(); });
    const dt = Math.min(this.clock ? (performance.now() - this.clock) / 1000 : 0.016, 0.05);
    this.clock = performance.now();

    const t = performance.now() / 1000;

    // pulse ghost markers
    for (const o of this.markerGroup.children) {
      if (o.isMesh && !o.userData.isHitArea) o.material.opacity = 0.26 + Math.sin(t * 4) * 0.12;
      else if (o.isPointLight) o.intensity = 3 + Math.sin(t * 4) * 1.5;
    }

    // pulse warm boneyard light when canDraw is true
    if (this.canDraw && this.boneLight) {
      this.boneLight.intensity = 3.5 + Math.sin(t * 6) * 1.8;
    }

    // process active animations
    this._anims = this._anims.filter(a => {
      a.t += dt;

      if (a.kind === 'drop') {
        const k = Math.min(a.t / a.dur, 1);
        const e2 = 1 - (1 - k) ** 3;
        a.mesh.position.y = 7 * (1 - e2);
        a.mesh.rotation.x = 0.6 * (1 - e2);
        if (k >= 1) { a.mesh.position.y = 0; a.mesh.rotation.x = 0; return false; }
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
          // Phase 3: Glide smoothly into the hand dock at the bottom
          const k = (a.t - dur1 - dur2) / dur3;
          const ease = k * k; // quadratic ease in
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

    // camera easing toward fit
    if (this._camGoal) {
      const p = this.camera.position, g = this._camGoal;
      p.x += (g.x - p.x) * 0.04;
      p.y += (g.y - p.y) * 0.04;
      p.z += (g.z - p.z) * 0.04;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || innerWidth;
    const h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Tear the whole board down. This is the ONLY place that may dispose the shared
   * resources (F3.1 pooled materials, F3.2 shared geometry, cached textures) —
   * doing it anywhere else blanks the tiles that still use them.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.clearMarkers();
    for (const child of this.chainGroup.children) this._disposeTileMesh(child);
    for (const child of this.boneGroup.children) this._disposeTileMesh(child);
    this.chainGroup.clear();
    this.boneGroup.clear();
    for (const mat of this._matCache.values()) mat.dispose?.();
    this._matCache.clear();
    this._backMatC?.dispose?.();
    this._backMatC = null;
    this._sideMatC?.dispose?.();
    this._sideMatC = null;
    for (const mat of this._scoreMats.values()) mat.dispose?.();
    this._scoreMats.clear();
    for (const tex of this._texCache.values()) tex.dispose?.();
    this._texCache.clear();
    this._geo?.dispose?.();
    this._hitBoxGeo?.dispose?.();
    this._hitBoxGeo = null;
    this._hitMatC?.dispose?.();
    this._hitMatC = null;
    this.renderer?.dispose?.();
  }
}
