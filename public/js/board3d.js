// js/board3d.js — Three.js 3D domino table: tiles, snake layout, ghost markers
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { tileFaceCanvas, tileBackCanvas, feltCanvas } from './tiles.js';

const TILE_W = 1, TILE_L = 2, TILE_H = 0.42, GAP = 0.07;
const MAX_X = 11.5;             // table boundary along X before turning
const MAX_Z = 6.5;              // table boundary along Z before turning
const adv = isDbl => (isDbl ? TILE_W : TILE_L) + GAP;

export class Board3D {
  constructor(canvas, { onMarkerClick, onBoardMiss } = {}) {
    this.onMarkerClick = onMarkerClick;
    this.onBoardMiss = onBoardMiss;

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

    const step = (cur, dbl) => {
      const advLen = dbl ? (GAP + TILE_W) : (GAP + TILE_L);
      const nextX = cur.pos.x + cur.dir.dx * advLen;

      // Turn corner when approaching boundary along X:
      if (cur.dir.dx !== 0 && Math.abs(nextX) > MAX_X) {
        const dZ = cur.side === 'R' ? 1 : -1;
        let center;
        if (cur.lastDbl) {
          center = {
            x: cur.lastCenter.x,
            z: cur.rowZ + dZ * (2.0 + GAP),
          };
        } else {
          center = {
            x: cur.lastCenter.x + cur.dir.dx * 0.5,
            z: cur.rowZ + dZ * (1.5 + GAP),
          };
        }
        const rotY = dZ === 1 ? 0 : Math.PI; // vertical corner piece: matching pip faces previous tile

        cur.rowZ = cur.rowZ + dZ * (2.0 + GAP);
        cur.dir = { dx: -cur.dir.dx, dz: 0 };
        cur.pos = {
          x: center.x + cur.dir.dx * 0.5,
          z: cur.rowZ,
        };
        cur.lastCenter = center;
        cur.lastDbl = dbl;
        return { x: center.x, z: center.z, rotY, dbl };
      }

      // Normal placement along current row:
      let center, rotY;
      if (dbl) {
        rotY = 0; // vertical crosswise
        center = {
          x: cur.pos.x + cur.dir.dx * (GAP + TILE_W / 2),
          z: cur.rowZ,
        };
        cur.pos = {
          x: center.x + cur.dir.dx * (TILE_W / 2),
          z: cur.rowZ,
        };
      } else {
        rotY = Math.atan2(cur.dir.dx, 0); // horizontal
        center = {
          x: cur.pos.x + cur.dir.dx * (GAP + TILE_L / 2),
          z: cur.rowZ,
        };
        cur.pos = {
          x: center.x + cur.dir.dx * (TILE_L / 2),
          z: cur.rowZ,
        };
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
          curL = { pos: { x: -TILE_W / 2, z: 0 }, dir: { dx: -1, dz: 0 }, side: 'L', rowZ: 0, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          curR = { pos: { x: TILE_W / 2, z: 0 }, dir: { dx: 1, dz: 0 }, side: 'R', rowZ: 0, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          if (isAllFives) {
            spinner = { x: 0, z: 0, extZ: TILE_L / 2 };
            curU = { pos: { x: 0, z: -TILE_L / 2 }, dir: { dx: 0, dz: -1 }, side: 'U', rowZ: -TILE_L / 2, lastCenter: { x: 0, z: 0 }, lastDbl: true };
            curD = { pos: { x: 0, z: TILE_L / 2 }, dir: { dx: 0, dz: 1 }, side: 'D', rowZ: TILE_L / 2, lastCenter: { x: 0, z: 0 }, lastDbl: true };
          }
        } else {
          const rotY = Math.PI / 2 + (mv.f ? Math.PI : 0);
          spot = { x: 0, z: 0, rotY, dbl };
          curL = { pos: { x: -TILE_L / 2, z: 0 }, dir: { dx: -1, dz: 0 }, side: 'L', rowZ: 0, lastCenter: { x: 0, z: 0 }, lastDbl: false };
          curR = { pos: { x: TILE_L / 2, z: 0 }, dir: { dx: 1, dz: 0 }, side: 'R', rowZ: 0, lastCenter: { x: 0, z: 0 }, lastDbl: false };
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
        curU = { pos: { x: spot.x, z: spot.z - extZ }, dir: { dx: 0, dz: -1 }, side: 'U', rowZ: spot.z - extZ, lastCenter: spot, lastDbl: true };
        curD = { pos: { x: spot.x, z: spot.z + extZ }, dir: { dx: 0, dz: 1 }, side: 'D', rowZ: spot.z + extZ, lastCenter: spot, lastDbl: true };
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

    if (cur.dir.dx !== 0 && Math.abs(nextX) > MAX_X) {
      const dZ = cur.side === 'R' ? 1 : -1;
      let x, z;
      if (cur.lastDbl) {
        x = cur.lastCenter.x;
        z = cur.rowZ + dZ * (2.0 + GAP);
      } else {
        x = cur.lastCenter.x + cur.dir.dx * 0.5;
        z = cur.rowZ + dZ * (1.5 + GAP);
      }
      return { x, z, rotY: dZ === 1 ? 0 : Math.PI };
    }

    const x = cur.pos.x + cur.dir.dx * (GAP + TILE_L / 2);
    const z = cur.rowZ;
    const rotY = Math.atan2(cur.dir.dx, 0);
    return { x, z, rotY };
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

  _syncBoneyard(count = 0) {
    if (count === this._boneCount) return;
    this._boneCount = count;
    this.boneGroup.clear();
    const shown = Math.min(count, 7);
    for (let i = 0; i < shown; i++) {
      const m = this._tileMesh(0, 0, false);
      m.position.set(11.5 + (i % 3) * 1.3, (i % 2) * 0.1, 6.5 + Math.floor(i / 3) * 2.4);
      m.rotation.y = Math.PI / 2 + (Math.random() - .5) * 0.25;
      this.boneGroup.add(m);
    }
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
    if (!this.markerGroup || this.markerGroup.children.length === 0) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hitTargets = this.markerGroup.children.filter(o => o.userData && o.userData.end !== undefined);
    const hits = this._raycaster.intersectObjects(hitTargets, false);
    if (hits.length) {
      const hit = hits.find(h => h.object && h.object.userData && h.object.userData.end !== undefined);
      if (hit) {
        this.onMarkerClick?.(hit.object.userData.end);
        return;
      }
    }

    // 2D screen distance fallback for touchscreens:
    // If finger lands within 75px of the marker on screen, register as hit
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

  // ── loop ──
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock ? (performance.now() - this.clock) / 1000 : 0.016, 0.05);
    this.clock = performance.now();

    // pulse markers
    const t = performance.now() / 1000;
    for (const o of this.markerGroup.children) {
      if (o.isMesh && !o.userData.isHitArea) o.material.opacity = 0.26 + Math.sin(t * 4) * 0.12;
      else if (o.isPointLight) o.intensity = 3 + Math.sin(t * 4) * 1.5;
    }

    // drop animations
    this._anims = this._anims.filter(a => {
      a.t += dt;
      const k = Math.min(a.t / a.dur, 1);
      const e2 = 1 - (1 - k) ** 3;
      a.mesh.position.y = 7 * (1 - e2);
      a.mesh.rotation.x = 0.6 * (1 - e2);
      if (k >= 1) { a.mesh.position.y = 0; a.mesh.rotation.x = 0; return false; }
      return true;
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
