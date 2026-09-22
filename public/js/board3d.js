// js/board3d.js — Three.js 3D domino table: tiles, snake layout, ghost markers
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { tileFaceCanvas, tileBackCanvas, feltCanvas } from './tiles.js?v=11';

const TILE_W = 1, TILE_L = 2, TILE_H = 0.42, GAP = 0.07;
const MAX_X = 11.5;             // table boundary along X before turning
const MAX_Z = 6.5;              // table boundary along Z before turning
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
    this.boneLight = new THREE.PointLight(0xf4c055, 0, 12);
    this.boneLight.position.set(10.5, 3.5, 7.0);
    this.boneLight.visible = false;
    this.scene.add(this.boneLight);

    this._buildTable();

    // groups
    this.chainGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.boneGroup = new THREE.Group();
    this.scene.add(this.chainGroup, this.markerGroup, this.boneGroup);

    this._texCache = new Map();
    this._geo = new RoundedBoxGeometry(TILE_W, TILE_H, TILE_L, 4, 0.09);
    this._anims = [];
    this._movesRendered = 0;
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

  _tileMesh(a, b, faceUp = true) {
    const face = new THREE.MeshStandardMaterial({ map: this._faceTex(a, b), roughness: 0.3 });
    const back = new THREE.MeshStandardMaterial({ map: this._backTex(), roughness: 0.5 });
    const side = this._sideMat();
    const mats = [side, side, faceUp ? face : back, faceUp ? back : face, side, side];
    const m = new THREE.Mesh(this._geo, mats);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // ── layout: moves → positions ──
  _layout(moves, isAllFives = false) {
    const spots = [];   // {x, z, rotY, dbl}
    let curL = null, curR = null, curU = null, curD = null, spinner = null;

    // One cursor per open end. pos = exact far-end point of the last placed tile (the
    // face the next tile continues from); dir = unit travel direction, exactly one
    // component nonzero; prevDx = X-direction of the horizontal segment before the
    // current vertical one (a column bends back into an anti-parallel row: two clean
    // L-bends forming an S-curve). armCol marks a fresh spinner-arm column: arms bend
    // at MAX_Z, while columns born from a bend run one tile deeper (MAX_Z + TILE_L +
    // GAP) so their return row skirts OUTSIDE the spinner arms' zone instead of
    // cutting through it.
    const step = (cur, dbl) => {
      const advLen = (dbl ? TILE_W : TILE_L) + GAP;
      const nextX = cur.pos.x + cur.dir.dx * advLen;
      const nextZ = cur.pos.z + cur.dir.dz * advLen;
      const zLim = cur.armCol ? MAX_Z : MAX_Z + TILE_L + GAP;

      // Boundary → this tile is a BEND: the classic corner-to-corner L-joint that
      // starts the new segment. Identical code path for both axes.
      if ((cur.dir.dx !== 0 && Math.abs(nextX) > MAX_X) || (cur.dir.dz !== 0 && Math.abs(nextZ) > zLim)) {
        let newDir;
        if (cur.dir.dx !== 0) {
          // horizontal row → vertical column, turning away from the centre
          newDir = { dx: 0, dz: cur.side === 'R' ? 1 : -1 };
          cur.prevDx = cur.dir.dx;
        } else {
          // vertical column → horizontal row, anti-parallel to the row before it
          // (spinner arms default clockwise: U row heads +X, D row heads −X)
          newDir = { dx: -(cur.prevDx || (cur.side === 'U' ? -1 : 1)), dz: 0 };
        }
        cur.armCol = false;
        let center, rotY;
        if (!dbl) {
          // Elbow: end-to-end from the cursor and corner-to-corner against the old
          // line (GAP clearance on both axes); long axis along the NEW direction.
          center = {
            x: cur.pos.x + cur.dir.dx * (GAP + TILE_W / 2) + newDir.dx * (TILE_W / 2 + GAP + TILE_L / 2),
            z: cur.pos.z + cur.dir.dz * (GAP + TILE_W / 2) + newDir.dz * (TILE_W / 2 + GAP + TILE_L / 2),
          };
          rotY = Math.atan2(newDir.dx, newDir.dz);
          cur.pos = { x: center.x + newDir.dx * (TILE_L / 2), z: center.z + newDir.dz * (TILE_L / 2) };
        } else {
          // Double at the corner: crosswise to the NEW direction (long axis along the
          // old one), near end butted flush to the cursor; the column continues off
          // its long side, like any double in a line. Doubles ignore f.
          center = {
            x: cur.pos.x + cur.dir.dx * (GAP + TILE_L / 2) + newDir.dx * (TILE_W / 2 + GAP),
            z: cur.pos.z + cur.dir.dz * (GAP + TILE_L / 2) + newDir.dz * (TILE_W / 2 + GAP),
          };
          rotY = cur.dir.dx !== 0 ? Math.PI / 2 : 0;
          cur.pos = { x: center.x + newDir.dx * (TILE_W / 2), z: center.z + newDir.dz * (TILE_W / 2) };
        }
        cur.dir = newDir;
        cur.lastCenter = center;
        cur.lastDbl = dbl;
        return { x: center.x, z: center.z, rotY, dbl };
      }

      // Normal placement, identical formulas for both axes.
      let center, rotY;
      if (dbl) {
        rotY = cur.dir.dx !== 0 ? 0 : Math.PI / 2; // crosswise: long axis ⟂ travel
        center = {
          x: cur.pos.x + cur.dir.dx * (GAP + TILE_W / 2),
          z: cur.pos.z + cur.dir.dz * (GAP + TILE_W / 2),
        };
        cur.pos = { x: center.x + cur.dir.dx * (TILE_W / 2), z: center.z + cur.dir.dz * (TILE_W / 2) };
      } else {
        rotY = Math.atan2(cur.dir.dx, cur.dir.dz); // long axis along travel; a-half (local -Z) faces the connection
        center = {
          x: cur.pos.x + cur.dir.dx * (GAP + TILE_L / 2),
          z: cur.pos.z + cur.dir.dz * (GAP + TILE_L / 2),
        };
        cur.pos = { x: center.x + cur.dir.dx * (TILE_L / 2), z: center.z + cur.dir.dz * (TILE_L / 2) };
      }
      cur.lastCenter = center;
      cur.lastDbl = dbl;
      return { x: center.x, z: center.z, rotY, dbl };
    };

    for (const mv of moves) {
      const dbl = mv.t.a === mv.t.b;
      if (mv.e === null) {
        let spot;
        if (dbl) {
          spot = { x: 0, z: 0, rotY: 0, dbl };
          curL = { pos: { x: -TILE_W / 2, z: 0 }, dir: { dx: -1, dz: 0 }, side: 'L', prevDx: -1, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          curR = { pos: { x: TILE_W / 2, z: 0 }, dir: { dx: 1, dz: 0 }, side: 'R', prevDx: 1, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          if (isAllFives) {
            spinner = { x: 0, z: 0, extZ: TILE_L / 2 };
            curU = { pos: { x: 0, z: -TILE_L / 2 }, dir: { dx: 0, dz: -1 }, side: 'U', prevDx: -1, armCol: true, lastCenter: { x: 0, z: 0 }, lastDbl: true };
            curD = { pos: { x: 0, z: TILE_L / 2 }, dir: { dx: 0, dz: 1 }, side: 'D', prevDx: 1, armCol: true, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          }
        } else {
          const rotY = Math.PI / 2 + (mv.f ? Math.PI : 0);
          spot = { x: 0, z: 0, rotY, dbl };
          curL = { pos: { x: -TILE_L / 2, z: 0 }, dir: { dx: -1, dz: 0 }, side: 'L', prevDx: -1, lastCenter: { x: 0, z: 0 }, lastDbl: false };
          curR = { pos: { x: TILE_L / 2, z: 0 }, dir: { dx: 1, dz: 0 }, side: 'R', prevDx: 1, lastCenter: { x: 0, z: 0 }, lastDbl: false };
        }
        spots.push(spot);
        continue;
      }

      const cur = mv.e === 'L' ? curL : mv.e === 'R' ? curR : mv.e === 'U' ? curU : curD;
      if (!cur) continue;
      const spot = step(cur, dbl);
      spot.rotY += mv.f ? Math.PI : 0;
      spots.push(spot);

      if (dbl && !spinner && isAllFives) {
        const extZ = Math.abs(Math.sin(spot.rotY)) > 0.5 ? TILE_W / 2 : TILE_L / 2;
        spinner = { x: spot.x, z: spot.z, extZ };
        curU = { pos: { x: spot.x, z: spot.z - extZ }, dir: { dx: 0, dz: -1 }, side: 'U', prevDx: -1, armCol: true, lastCenter: { x: spot.x, z: spot.z }, lastDbl: true };
        curD = { pos: { x: spot.x, z: spot.z + extZ }, dir: { dx: 0, dz: 1 }, side: 'D', prevDx: 1, armCol: true, lastCenter: { x: spot.x, z: spot.z }, lastDbl: true };
      }
    }

    // next-placement spots for markers (assume non-double orientation)
    const endSpots = {};
    if (moves.length === 0) {
      endSpots.C = { x: 0, z: 0, rotY: Math.PI / 2 };
    } else {
      if (curL) endSpots.L = this._peek(curL);
      if (curR) endSpots.R = this._peek(curR);
      if (isAllFives) {
        if (curU) endSpots.U = this._peek(curU);
        if (curD) endSpots.D = this._peek(curD);
      }
    }
    return { spots, endSpots };
  }

  _peek(cur) {
    if (!cur) return null;
    const advLen = GAP + TILE_L;
    const nextX = cur.pos.x + cur.dir.dx * advLen;
    const nextZ = cur.pos.z + cur.dir.dz * advLen;

    // Mirror step() exactly one tile ahead (non-double orientation assumption): a
    // boundary crossing returns the corner-to-corner elbow spot, anything else the
    // straight continuation.
    const zLim = cur.armCol ? MAX_Z : MAX_Z + TILE_L + GAP;
    if ((cur.dir.dx !== 0 && Math.abs(nextX) > MAX_X) || (cur.dir.dz !== 0 && Math.abs(nextZ) > zLim)) {
      const newDir = cur.dir.dx !== 0
        ? { dx: 0, dz: cur.side === 'R' ? 1 : -1 }
        : { dx: -(cur.prevDx || (cur.side === 'U' ? -1 : 1)), dz: 0 };
      return {
        x: cur.pos.x + cur.dir.dx * (GAP + TILE_W / 2) + newDir.dx * (TILE_W / 2 + GAP + TILE_L / 2),
        z: cur.pos.z + cur.dir.dz * (GAP + TILE_W / 2) + newDir.dz * (TILE_W / 2 + GAP + TILE_L / 2),
        rotY: Math.atan2(newDir.dx, newDir.dz),
      };
    }

    return {
      x: cur.pos.x + cur.dir.dx * (GAP + TILE_L / 2),
      z: cur.pos.z + cur.dir.dz * (GAP + TILE_L / 2),
      rotY: Math.atan2(cur.dir.dx, cur.dir.dz),
    };
  }

  // ── public sync ──
  sync(view) {
    const moves = view.moves || [];
    if (moves.length === this._movesRendered) {
      this._syncBoneyard(view.boneyardCount);
      return;
    }
    const isNew = moves.length === this._movesRendered + 1 && this._movesRendered > 0;
    this._movesRendered = moves.length;
    this.clearMarkers();
    this.chainGroup.clear();

    const isAllFives = view.variant === 'allfives';
    const { spots, endSpots } = this._layout(moves, isAllFives);
    this._endSpots = endSpots;

    moves.forEach((mv, i) => {
      const s = spots[i];
      const mesh = this._tileMesh(mv.t.a, mv.t.b);
      mesh.position.set(s.x, 0, s.z);
      mesh.rotation.y = s.rotY;
      this.chainGroup.add(mesh);
      if (isNew && i === moves.length - 1) {
        mesh.position.y = 7;
        mesh.rotation.x = 0.6;
        this._anims.push({ mesh, t: 0, dur: 0.45, kind: 'drop', baseRotY: s.rotY });
      }
    });

    this._syncBoneyard(view.boneyardCount);
    this._fitCamera(spots);
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
    this.boneGroup.clear();
    const cols = 7;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = 7.5 + col * 0.98;
      const z = 6.0 + row * 2.15;
      const jitterRot = (Math.sin(i * 137.5) * 0.05);

      const m = this._tileMesh(0, 0, false);
      m.position.set(x, 0, z);
      m.rotation.y = jitterRot;
      m.userData = { isBoneyard: true, index: i };
      m.castShadow = true;
      m.receiveShadow = true;
      this.boneGroup.add(m);

      // Hit area mesh for forgiving touch/mouse clicks
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(TILE_W * 1.3, 1.8, TILE_L * 1.3),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.position.set(x, 0.6, z);
      hit.rotation.y = jitterRot;
      hit.userData = { isBoneyard: true, index: i, targetMesh: m };
      this.boneGroup.add(hit);
    }
  }

  animateDraw(drawnTile, isMe, sourceMesh = null) {
    // 1. Determine starting position from sourceMesh or the last visible boneyard tile
    let startPos = new THREE.Vector3(10.5, 0.21, 7.0);
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
      this._camGoal = { x: 0, y: 20, z: 13 };
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
  showMarkers(ends) {
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

      // Hit area mesh (generous hit box for forgiving touch/mouse clicks)
      const hitArea = new THREE.Mesh(
        new THREE.BoxGeometry(TILE_W * 3.6, 3.0, TILE_L * 3.2),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hitArea.position.set(s.x, 0.5, s.z);
      hitArea.rotation.y = s.rotY;
      hitArea.userData.end = e;
      hitArea.userData.isHitArea = true;
      this.markerGroup.add(hitArea);

      const halo = new THREE.PointLight(0x2ee6a8, 4, 4);
      halo.position.set(s.x, 1.2, s.z);
      halo.userData.end = e;
      this.markerGroup.add(halo);
    }
  }

  clearMarkers() { this.markerGroup.clear(); }

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
  _loop() {
    requestAnimationFrame(() => this._loop());
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
          mesh.geometry?.dispose?.();
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
}
